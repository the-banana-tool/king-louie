// src/cases/executors/channel-send.js
// Counting a channel send (ContactRouter.sendExternal to anyone but the
// owner) against the envelope it goes out under, the case's contactsPerDay
// and the executor's global daily cap, the way a job's contacts are counted
// (jobs.js recordSend, submit.js step 10). Owner decision 2026-10-12.
//
// Reserve before the send, settle after it:
//   reserveChannelSend  re-checks the envelope as it is on disk
//                       (envelope-ops.js sendEnvelope: status, channel,
//                       recipient, window, caps, phone grant), then counts
//                       the send: the envelope's usage (contacts, attempts)
//                       and a `reserved` payloads entry, the case's
//                       contactsPerDay, the global cap. A cap that would be
//                       passed refuses, and what was counted so far is undone.
//   settleChannelSend   `sent: true` marks the entry `sent` (or
//                       `unconfirmed` when the send may have left);
//                       `sent: false` (it clearly never left) removes the
//                       entry and gives back what it alone counted.
// A crash, or a settle that cannot run, leaves the entry `reserved`: it
// stays counted, never released.
//
// Case files are written inside CaseRuntime.systemAction: inline when this
// process already holds the case lock (a turn), under the lock otherwise;
// another process holding it refuses the send. systemAction runs inline for
// any holder in this process, so the lock does not serialize two sends
// here. Two things do: the check and its writes run with no await between
// them, and a whole reservation (the global cap included) runs under one
// per-case mutex, so a second send never reads a count the first is about
// to undo.
const { createLogger } = require('../../logging');
const { canonicalize } = require('../../platform/jcs');
const { EnvelopeStore } = require('./envelope');
const envelopeOps = require('./envelope-ops');
const { sha256hex, cut } = require('./util');

const log = createLogger('executors/channel-send');
const refuse = (error) => ({ ok: false, error });
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isBusy = (err) => Boolean(err) && (err.name === 'CaseBusyError' || err.code === 'CASE_BUSY');
const clip = (text) => cut(String(text ?? ''), 300);

function journal(reg, caseId, text) {
  try {
    reg.caseRuntime.records(caseId).writeJournal('envelope', text, reg.now());
  } catch (err) {
    log.warn(`Case ${caseId}: writing a journal line failed: ${err.message}`);
  }
}

function contactsDay(budget) {
  try {
    return budget.status().contactsPerDay?.day || null;
  } catch {
    return null;
  }
}

// Removes a reserved entry and what it alone counted. Synchronous; the
// caller holds the case lock. → { removed, refunded }: the contacts the
// envelope no longer lists, and how many the case budget got back.
// A contact is given back only when this send was the one charged for it,
// no other send or job holds an attempt on it, and the budget day has not
// rolled over; otherwise the count stays (too high is safe, too low is not).
function undoInCase(reg, { caseId, envelopeId, sendId }) {
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const env = store.get(envelopeId);
  const payloads = Array.isArray(env?.payloads) ? env.payloads : [];
  const entry = payloads.find((p) => p && p.sendId === sendId);
  if (!env || !entry) return { state: 'missing', removed: [], refunded: 0 };
  if (entry.state !== 'reserved') return { state: entry.state, removed: [], refunded: 0 };
  env.payloads = payloads.filter((p) => p !== entry);
  env.usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  const attempts = { ...(env.usage.attempts || {}) };
  const own = Array.isArray(entry.newContacts) ? entry.newContacts : [];
  const removed = [];
  for (const r of Array.isArray(entry.recipients) ? entry.recipients : []) {
    const left = (Number(attempts[r]) || 0) - 1;
    if (left > 0) {
      attempts[r] = left;
      continue;
    }
    delete attempts[r];
    if (own.includes(r) && env.usage.contacts.includes(r)) {
      env.usage.contacts = env.usage.contacts.filter((c) => c !== r);
      removed.push(r);
    }
  }
  env.usage.attempts = attempts;
  store.write(env);
  let refunded = 0;
  if (removed.length) {
    try {
      const budget = reg.caseRuntime.budget(caseId);
      const now = budget.status().contactsPerDay || {};
      if (entry.budgetDay && now.day === entry.budgetDay && Number(now.spent) >= removed.length) {
        budget.charge('contactsPerDay', -removed.length, { executor: env.executor, sendId });
        refunded = removed.length;
      }
    } catch (err) {
      log.warn(`Case ${caseId}: giving back the contacts of ${sendId} failed, they stay counted: ${err.message}`);
    }
  }
  return { state: 'released', removed, refunded };
}

// Synchronous: the envelope check and the writes that count the send, with
// no await between them. The caller holds the case lock.
function reserveInCase(reg, { caseId, envelopeId, executorId, channelId, recipients, sendId, text, rendered, expectedHash }) {
  const rt = reg.caseRuntime;
  // Conservative reading (no owner decision names the statuses): only an
  // active case sends. Not a draft, not one waiting for direction (where a
  // job may only be a retry), not a paused or finished one.
  const status = rt.getCase(caseId).status;
  if (status !== 'active') return refuse(`the case is ${status}; a channel send needs an active case. Nothing was sent.`);
  const checked = envelopeOps.sendEnvelope(reg, { caseId, envelopeId, executorId, recipients, channelId });
  if (!checked || checked.ok !== true || !checked.envelope) return refuse(checked?.error || 'the envelope check refused the send');
  const env = checked.envelope;
  if (expectedHash !== null && env.hash !== expectedHash) {
    return refuse(`envelope ${env.id} changed while the send was being checked; nothing was sent`);
  }
  const payloads = Array.isArray(env.payloads) ? env.payloads : [];
  if (payloads.some((p) => p && p.sendId === sendId)) return refuse(`send ${sendId} is already recorded under ${env.id}`);
  const usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  const known = new Set(Array.isArray(usage.contacts) ? usage.contacts : []);
  const fresh = recipients.filter((r) => !known.has(r));
  const budget = rt.budget(caseId);
  const left = budget.remaining('contactsPerDay');
  if (fresh.length && left !== null && left < fresh.length) {
    return refuse(`the case has ${left} contacts left today; this send needs ${fresh.length}`);
  }
  const at = reg.now().toISOString();
  const n = (Number(env.nextN) || payloads.length) + 1;
  const next = JSON.parse(JSON.stringify(env));
  const attempts = { ...(isObject(usage.attempts) ? usage.attempts : {}) };
  for (const r of recipients) attempts[r] = (Number(attempts[r]) || 0) + 1;
  next.usage = { ...usage, contacts: [...known, ...fresh], attempts };
  next.nextN = n;
  const budgetDay = fresh.length ? contactsDay(budget) : null;
  next.payloads = [...payloads, {
    n, at, sendId, channel: channelId, state: 'reserved', recipients: [...recipients], newContacts: fresh, budgetDay,
    payload: { text }, rendered: { text: rendered }, hash: sha256hex(canonicalize({ text: rendered })), estimateUsd: 0
  }];
  const store = new EnvelopeStore(reg.caseDir(caseId));
  store.write(next);
  let crossedNow = [];
  if (fresh.length) {
    try {
      const r = budget.charge('contactsPerDay', fresh.length, { executor: env.executor, sendId });
      crossedNow = Array.isArray(r?.crossedNow) ? r.crossedNow : [];
    } catch (err) {
      // Not charged: take the entry out again without a refund.
      const entry = store.get(env.id);
      const mine = (entry?.payloads || []).find((p) => p && p.sendId === sendId);
      if (mine) {
        mine.budgetDay = null;
        store.write(entry);
      }
      undoInCase(reg, { caseId, envelopeId: env.id, sendId });
      return refuse(`the case's contacts for today could not be counted, so nothing was sent: ${err.message}`);
    }
  }
  return { ok: true, envelope: env, executorId: env.executor, newContacts: fresh, crossedNow, n };
}

// → { ok: true, envelope, reservation } | { ok: false, error }. Never throws.
// `rendered` is the text the outbound gate rendered (what is sent), `text`
// the text before it; `expectedHash` the hash of the envelope the gate ran
// against. `sendId` names the send in the envelope's payloads.
async function reserveChannelSend(reg, args = {}) {
  const a = isObject(args) ? args : {};
  const { caseId, envelopeId, executorId, sendId, rendered } = a;
  const channelId = envelopeOps.sendChannel(a.channelId);
  const recipients = Array.isArray(a.recipients) ? [...new Set(a.recipients)] : [];
  if (typeof sendId !== 'string' || !sendId) return refuse('the send has no id to be counted under, so nothing was sent');
  if (!recipients.length || !recipients.every((r) => typeof r === 'string' && r)) return refuse('the send names no recipients');
  if (typeof rendered !== 'string') return refuse('the send has no rendered text to record, so nothing was sent');
  if (!channelId) return refuse('the send names no channel, so nothing was sent');
  const input = {
    caseId, envelopeId, executorId, channelId, recipients, sendId, rendered,
    text: typeof a.text === 'string' ? a.text : rendered, expectedHash: typeof a.expectedHash === 'string' ? a.expectedHash : null
  };
  try {
    return await reg.mutex.run(`channel-send:${caseId}`, () => reg.caseRuntime.systemAction(caseId, `channel send ${sendId} reserved`, async () => {
      const held = reserveInCase(reg, input);
      if (!held.ok) return held;
      const reservation = {
        caseId, envelopeId: held.envelope.id, executorId: held.executorId, sendId, channel: channelId, recipients,
        newContacts: held.newContacts, crossedNow: held.crossedNow, n: held.n, rendered, settled: null
      };
      if (held.newContacts.length) {
        let res;
        try {
          res = await reg.reserveContacts(held.executorId, held.newContacts.length, { caseId });
        } catch (err) {
          res = { ok: false, error: `the daily cap could not be read, so nothing was sent: ${err.message}` };
        }
        if (!res || res.ok !== true) {
          undoInCase(reg, reservation);
          reservation.settled = 'released';
          return refuse(res?.error || 'the daily cap refused the send');
        }
      }
      return { ok: true, envelope: held.envelope, reservation };
    }));
  } catch (err) {
    if (isBusy(err)) return refuse(`${err.message} Nothing was sent.`);
    log.warn(`Counting channel send ${sendId} in ${caseId} failed: ${err.message}`);
    return refuse(`the send could not be counted, so nothing was sent: ${err.message}`);
  }
}

// Synchronous; the caller holds the case lock.
function markInCase(reg, reservation, { unconfirmed, reason }) {
  const { caseId, envelopeId, sendId } = reservation;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const env = store.get(envelopeId);
  const entry = (Array.isArray(env?.payloads) ? env.payloads : []).find((p) => p && p.sendId === sendId);
  if (!env || !entry) return { state: 'missing' };
  if (entry.state !== 'reserved') return { state: entry.state };
  entry.state = unconfirmed ? 'unconfirmed' : 'sent';
  entry.settledAt = reg.now().toISOString();
  if (unconfirmed) entry.reason = clip(reason);
  store.write(env);
  const to = reservation.recipients.join(', ');
  journal(reg, caseId, unconfirmed
    ? `Channel send ${sendId} on ${reservation.channel} to ${to} under ${envelopeId} may have left (${clip(reason)}). It stays counted against the envelope and today's contacts.`
    : [`Channel send ${sendId} on ${reservation.channel} to ${to} under ${envelopeId}.`, '', 'Text as sent:', '', '```', reservation.rendered, '```'].join('\n'));
  if (reservation.crossedNow.length) {
    try {
      reg.caseRuntime.onCrossings(caseId, 'contactsPerDay', reservation.crossedNow);
    } catch (err) {
      log.warn(`Case ${caseId}: handling the contactsPerDay crossing failed: ${err.message}`);
    }
  }
  return { state: entry.state };
}

// After the send. `sent: true`: it went out, or (`unconfirmed`) may have.
// `sent: false`: it clearly never left; the reservation is given back.
// → { ok, state }. Never throws. When it cannot run (the case lock is held
// by another process, a write fails) the entry stays `reserved` and counted.
async function settleChannelSend(reg, reservation, { sent = true, unconfirmed = false, reason = null } = {}) {
  if (!isObject(reservation) || typeof reservation.sendId !== 'string') return refuse('no reservation to settle');
  if (reservation.settled) return { ok: true, state: reservation.settled };
  const { caseId, sendId } = reservation;
  try {
    const out = await reg.caseRuntime.systemAction(caseId, `channel send ${sendId} ${sent === false ? 'released' : 'sent'}`, () => (
      sent === false ? undoInCase(reg, reservation) : markInCase(reg, reservation, { unconfirmed: unconfirmed === true, reason })
    ));
    reservation.settled = out.state;
    if (sent === false && Array.isArray(out.removed) && out.removed.length) {
      await reg.releaseContacts(reservation.executorId, out.removed.length, { caseId });
    }
    return { ok: true, state: out.state };
  } catch (err) {
    log.warn(`Settling channel send ${sendId} in ${caseId} failed; it stays counted: ${err.message}`);
    return refuse(`the send could not be settled and stays counted: ${err.message}`);
  }
}

module.exports = { reserveChannelSend, settleChannelSend };
