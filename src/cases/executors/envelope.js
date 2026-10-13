// src/cases/executors/envelope.js
// Envelopes (cases stage 3 spec §3.6): the owner approves one envelope
// (intent, recipients, facts, caps, window) instead of every message.
// Pure functions plus the file store; the flows live in envelope-ops.js.
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../../platform/jcs');
const {
  sha256hex, writeJsonAtomic, readJsonSafe, localDate, countDays, pickTimeZone, DAY_PATTERN, valueText, roundUsd, money, cut
} = require('./util');
const { normalizeRecipient, recipientChannel } = require('./normalize');
const { gateLeaves } = require('../gates');
const { plainLineProblem, isPlainLine } = require('../hidden-chars');
const { SEND_CHANNELS } = require('../contact-format');

// The owner approves an envelope from a card of lines. Model- or
// ledger-written text (intent, rules, recipients, fact statements, the case
// title) must never be able to start a line of its own, real or wrapped, or
// hide part of one. "One plain line" is defined once, in hidden-chars.js
// (plainLineProblem). A request with text that is not one is refused; text
// already stored that is not one is never flattened into the card: it is
// replaced by HIDDEN_TEXT, so the owner sees that something is there.
const HIDDEN_TEXT = '(text hidden: not one plain line)';
const shown = (text) => (isPlainLine(text) ? text : HIDDEN_TEXT);
// A host-validated field (an id, a date, a zone, a count): shown as it is
// when plain, hidden like any other text when a file edit made it not so.
const field = (value) => shown(String(value ?? ''));
// What the owner is shown of an approval question. A question longer than
// this is refused when it is asked, never cut (envelope-ops.js).
const QUESTION_MAX_CHARS = 2000;

const ENVELOPE_STATUSES = Object.freeze(['requested', 'active', 'rejected', 'expired', 'exhausted', 'revoked', 'tampered']);
// Statuses a payload can be fitted against; expired and exhausted take a delta.
const FITTABLE_STATUSES = Object.freeze(['active', 'expired', 'exhausted']);
// Gate reasons that refuse an envelope request outright (spec §3.6).
const REQUEST_REFUSALS = new Set(['inferred', 'unknown', 'non-disclosable', 'non-disclosable-entity', 'superseded', 'bad-reference']);
const ID_RE = /^env-(\d{2,})$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

class EnvelopeStore {
  constructor(caseDir) {
    this.dir = path.join(caseDir, '.kl', 'envelopes');
  }

  _file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  ids() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => ID_RE.test(id))
      .sort((a, b) => Number(ID_RE.exec(a)[1]) - Number(ID_RE.exec(b)[1]));
  }

  list() {
    return this.ids().map((id) => this.get(id)).filter(Boolean);
  }

  get(id) {
    if (!ID_RE.test(String(id))) return null;
    return readJsonSafe(this._file(id), null);
  }

  nextId() {
    const max = this.ids().reduce((m, id) => Math.max(m, Number(ID_RE.exec(id)[1])), 0);
    return `env-${String(max + 1).padStart(2, '0')}`;
  }

  write(env) {
    writeJsonAtomic(this._file(env.id), env);
    return env;
  }
}

class EnvelopeCoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvelopeCoreError';
  }
}

// A cap must be a real number: a missing, null or non-finite cap is never
// read as 0 (or as "no limit"), it makes the envelope malformed.
function capOf(caps, key, { integer }) {
  const v = caps ? caps[key] : undefined;
  const ok = typeof v === 'number' && Number.isFinite(v) && v >= 0 && (!integer || Number.isInteger(v));
  if (!ok) throw new EnvelopeCoreError(`caps.${key} must be a finite ${integer ? 'integer' : 'number'} ≥ 0`);
  return v;
}

// The authority an envelope was requested under is part of what the owner
// approved and the hash covers, so a file edit cannot lower it. An envelope
// with none recorded is malformed (read as tampered), never a default.
const ENVELOPE_AUTHORITIES = Object.freeze(['envelope', 'signed']);

function authorityOf(env) {
  const a = env ? env.authority : undefined;
  if (!ENVELOPE_AUTHORITIES.includes(a)) throw new EnvelopeCoreError(`authority must be one of ${ENVELOPE_AUTHORITIES.join(', ')}`);
  return a;
}

// Channels (owner decision 2026-10-12): the contact channels a channel send
// (ContactRouter.sendExternal) to this envelope's recipients may use. The
// owner sees the list in the approval question and it is inside the hash.
// An envelope with no `channels` key allows no channel send, and its core
// (so its hash, and the action a phone signs) has no such key: it is what it
// was before the field existed. A key that is present must be a clean list
// of channels that address a third party (contact-format.js SEND_CHANNELS;
// 'call' is stored as 'voice'), each at most once, so never more of them
// than there are such channels; anything else, the owner's own surfaces
// (in-app, mobile) and ntfy included, is malformed (read as tampered),
// never "no list". The bound is what lets the phone summary always show
// the whole list (renderSignedSummary).
const MAX_CHANNELS = SEND_CHANNELS.length;
const isChannelId = (v) => typeof v === 'string' && SEND_CHANNELS.includes(v);

// → the stored form of a channel id ('call' → 'voice'), or null.
function normalizeChannelId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  const stored = id === 'call' ? 'voice' : id;
  return isChannelId(stored) ? stored : null;
}

function channelsOf(env) {
  const list = env.channels;
  if (!Array.isArray(list) || list.length > MAX_CHANNELS || !list.every(isChannelId) || new Set(list).size !== list.length) {
    throw new EnvelopeCoreError(`channels must be a list of distinct channels out of ${SEND_CHANNELS.join(', ')}`);
  }
  return [...list];
}

// Throws EnvelopeCoreError for malformed caps, authority or channels;
// callers that must not throw use envelopeIntact.
function envelopeCore(env) {
  return {
    ...(env.channels !== undefined ? { channels: channelsOf(env) } : {}),
    authority: authorityOf(env),
    intent: String(env.intent || ''),
    executor: String(env.executor || ''),
    recipients: { allow: [...(env.recipients?.allow || [])].map(String) },
    facts: [...(env.facts || [])].map(String),
    rules: [...(env.rules || [])].map(String),
    caps: {
      usd: capOf(env.caps, 'usd', { integer: false }),
      contacts: capOf(env.caps, 'contacts', { integer: true }),
      attemptsPerContact: capOf(env.caps, 'attemptsPerContact', { integer: true })
    },
    window: { start: String(env.window?.start || ''), end: String(env.window?.end || ''), tz: String(env.window?.tz || '') }
  };
}

function envelopeHash(core) {
  return `sha256:${sha256hex(canonicalize(core))}`;
}

// True when the envelope is well formed and its core still hashes to
// env.hash. Never throws.
function envelopeIntact(env) {
  try {
    return Boolean(env) && envelopeHash(envelopeCore(env)) === env.hash;
  } catch {
    return false;
  }
}

function validateEnvelopeRequest(body, {
  entry, facts = new Map(), deadline = null, casesTimeZone = '', defaultCountryCode = '', categoryKeywords = null, entityIndex = null, caseId = null
} = {}) {
  if (!entry) return { ok: false, error: 'Envelope refused: unknown executor.' };
  if (entry.authority === 'none') {
    return { ok: false, error: `Envelope refused: ${entry.id} does not take envelopes (authority none); submit its jobs directly.` };
  }
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const intent = typeof b.intent === 'string' ? b.intent.trim() : '';
  if (!intent || intent.length > 500) errors.push('"intent" must be 1 to 500 characters');
  if (intent && !isPlainLine(intent)) errors.push(`"intent" must be one plain line: ${plainLineProblem(intent)}`);
  if (b.executor !== undefined && b.executor !== entry.id) errors.push(`"executor" must be ${entry.id}`);
  const allow = Array.isArray(b.recipients?.allow) ? b.recipients.allow : null;
  if (!allow || !allow.length) errors.push('"recipients.allow" must list at least one address');
  const factIds = b.facts === undefined ? [] : (Array.isArray(b.facts) ? b.facts.map(String) : null);
  if (!factIds) errors.push('"facts" must be a list of fact ids');
  const rules = b.rules === undefined ? [] : (Array.isArray(b.rules) ? b.rules.map((r) => String(r).trim()).filter(Boolean) : null);
  if (!rules) errors.push('"rules" must be a list of strings');
  else if (!rules.every(isPlainLine)) errors.push(`"rules" must each be one plain line: ${plainLineProblem(rules.find((r) => !isPlainLine(r)))}`);
  const caps = b.caps && typeof b.caps === 'object' ? b.caps : {};
  const usd = Number(caps.usd);
  const contacts = Number(caps.contacts);
  const attempts = Number(caps.attemptsPerContact);
  if (!Number.isFinite(usd) || usd < 0) errors.push('"caps.usd" must be a number ≥ 0');
  if (!Number.isInteger(contacts) || contacts < 1) errors.push('"caps.contacts" must be an integer ≥ 1');
  if (!Number.isInteger(attempts) || attempts < 1) errors.push('"caps.attemptsPerContact" must be an integer ≥ 1');
  const w = b.window && typeof b.window === 'object' ? b.window : {};
  if (!DAY_PATTERN.test(String(w.start)) || !DAY_PATTERN.test(String(w.end)) || String(w.end) < String(w.start)) {
    errors.push('"window" needs start and end dates (YYYY-MM-DD) with start ≤ end');
  }
  // Channel sends are asked for explicitly; an envelope asked without them
  // carries no list and allows none.
  let channels = null;
  if (b.channels !== undefined) {
    const ids = Array.isArray(b.channels) ? b.channels.map(normalizeChannelId) : null;
    if (!ids || !ids.length || ids.includes(null)) {
      errors.push(`"channels" must be a list of ${SEND_CHANNELS.join(', ')} (leave it out when no channel send is needed)`);
    } else {
      channels = [...new Set(ids)];
    }
  }
  if (errors.length) return { ok: false, error: `Envelope refused: ${errors.join('; ')}.` };

  const channel = recipientChannel(entry.capabilities);
  const normalized = [];
  for (const address of allow) {
    const n = normalizeRecipient(address, { channel, defaultCountryCode });
    if (!n.ok) errors.push(n.error);
    else if (!isPlainLine(n.value)) errors.push(`recipient ${normalized.length + 1} is not one plain line: ${plainLineProblem(n.value)}`);
    else if (!normalized.includes(n.value)) normalized.push(n.value);
  }
  for (const id of factIds) {
    const f = facts.get(id);
    if (!f) errors.push(`${id} does not exist`);
    else if (f.status !== 'active') errors.push(`${id} is ${f.status}`);
    else if (f.provenance === 'inferred') errors.push(`${id} is inferred`);
    else if (f.provenance === 'unknown') errors.push(`${id} is an open unknown`);
    else if (!f.disclosable) errors.push(`${id} is not disclosable`);
  }
  const callingWindow = entry.constraints?.callingWindow || null;
  const tz = pickTimeZone(w.tz, callingWindow?.tz, casesTimeZone);
  const perDay = entry.constraints?.contactsPerDay;
  if (Number.isInteger(perDay)) {
    const days = countDays(w.start, w.end, Array.isArray(callingWindow?.weekdays) ? callingWindow.weekdays : ALL_WEEKDAYS);
    if (contacts > perDay * days) errors.push(`caps.contacts ${contacts} is more than ${perDay}/day × ${days} window days`);
  }
  if (deadline && String(w.end) > String(deadline)) errors.push(`window ends ${w.end}, after the deadline ${deadline}`);
  if (errors.length) return { ok: false, error: `Envelope refused: ${errors.join('; ')}.` };

  const core = {
    authority: entry.authority,
    intent,
    executor: entry.id,
    recipients: { allow: normalized },
    facts: factIds,
    rules,
    caps: { usd, contacts, attemptsPerContact: attempts },
    window: { start: w.start, end: w.end, tz },
    ...(channels ? { channels } : {})
  };
  const gate = gateLeaves({ intent, rules }, {
    recipients: normalized, envelope: null, facts, mode: 'message', caseId, entityIndex, categoryKeywords
  });
  const refusals = gate.blocked.filter((x) => REQUEST_REFUSALS.has(x.reason));
  if (refusals.length) {
    return {
      ok: false,
      error: `Envelope refused by the outbound gate: ${refusals.map((x) => `${x.path} "${x.span.text}" (${x.reason}${x.factId ? ` ${x.factId}` : ''})`).join('; ')}.`,
      blocked: refusals
    };
  }
  // Model-written constraint wording becomes approved wording once the owner
  // approves, so the owner sees each span.
  const notBacked = gate.blocked
    .filter((x) => x.reason === 'unsourced-constraint' || x.reason === 'category-keyword')
    .map((x) => ({ path: x.path, text: x.span.text, reason: x.reason, detail: x.detail }));
  return { ok: true, core, notBacked };
}

// The approval card, whole. Three parts, in this order:
// 1. The lines the host builds from validated fields: the header, caps,
//    window, channels, recipients and the ids of the facts.
// 2. Under a host line that says so, the wording the model wrote or the
//    ledger holds, one labelled line each: Intent, Rule N, Fact <id>, Not
//    backed by a fact. The real `Intent:` is the first of them.
// 3. The case title, last (the card head shows it too): it can be
//    model-written, so it precedes no host line.
// Every piece of part 2 and 3 is one plain line or is replaced by
// HIDDEN_TEXT; a fact whose text is hidden is still listed by its id.
function envelopeQuestionText(env, { facts = new Map(), caseTitle = '', notBacked = [] } = {}) {
  const recipients = (env.recipients?.allow || []).map(shown);
  const factIds = (env.facts || []).map(field);
  const lines = [
    `Approve envelope ${field(env.id)} for ${field(env.executor)}?`,
    `Caps: ${money(env.caps.usd)} total, ${env.caps.contacts} contacts, ${env.caps.attemptsPerContact} attempts per contact`,
    `Window: ${field(env.window.start)} to ${field(env.window.end)} (${field(env.window.tz)})`,
    ...(Array.isArray(env.channels) ? [`Channel sends allowed: ${env.channels.map(field).join(', ') || 'none'}`] : []),
    `Recipients (${recipients.length}): ${recipients.join(', ')}`,
    `Facts it may disclose (${factIds.length}): ${factIds.join(', ') || 'none'}`,
    'The wording below was written by the assistant or comes from the case ledger:',
    `Intent: ${shown(env.intent)}`
  ];
  (env.rules || []).forEach((r, i) => lines.push(`Rule ${i + 1}: ${shown(r)}`));
  (env.facts || []).forEach((id, i) => {
    const f = facts.get(id);
    if (!f) {
      lines.push(`Fact ${factIds[i]}: (missing)`);
      return;
    }
    const value = f.value !== null && f.value !== undefined ? ` = ${valueText(f.value)}${f.unit ? ` ${f.unit}` : ''}` : '';
    lines.push(`Fact ${factIds[i]}: ${shown(`${f.stmt}${value}`)}`);
  });
  for (const n of notBacked) {
    lines.push(`Not backed by a fact: ${isPlainLine(n.text) && isPlainLine(n.detail) ? `"${n.text}" (${n.detail})` : HIDDEN_TEXT}`);
  }
  if (caseTitle) lines.push(`Case: ${shown(caseTitle)}`);
  return lines.join('\n');
}

// For display. A new request whose card would be cut is refused before it
// is asked (envelope-ops.js); the cut is only for an envelope stored before
// that rule.
function renderEnvelopeQuestion(env, options = {}) {
  return cut(envelopeQuestionText(env, options), QUESTION_MAX_CHARS);
}

// The phone shows this; F3 cuts it to SUMMARY_MAX characters
// (src/approvals/messages.js). The summary is part of the hashed action, so
// the envelope id in front binds an approval to one envelope: two envelopes
// with the same core are different actions.
//
// Two layouts, chosen by the core alone:
// - A core with `channels`: every host-written part (id, executor, the
//   whole channel list, recipient count, usd cap, window) comes first and
//   the intent, on one line, last, so the cut can only shorten the intent.
//   If the host-written part alone would not fit, this throws: no signed
//   request is built whose summary could lose a channel.
// - A core without `channels` keeps the layout it has always had, intent
//   first, because the summary is hashed: changing it would unsign every
//   envelope the phone already approved. There a long intent can push the
//   recipient count, cap and window past the cut (a known limit that
//   predates channels); the in-app card shows them whole.
const SUMMARY_MAX = 300;
function renderSignedSummary(core, envelopeId) {
  if (!Array.isArray(core.channels)) {
    return `${envelopeId} · ${core.executor}: ${core.intent} (${core.recipients.allow.length} recipients, ${money(core.caps.usd)}, ${core.window.start} to ${core.window.end})`;
  }
  const head = [
    `${field(envelopeId)} · ${field(core.executor)}`,
    `channel sends: ${core.channels.map(field).join(', ') || 'none'}`,
    `${core.recipients.allow.length} recipients`,
    money(core.caps.usd),
    `${field(core.window.start)} to ${field(core.window.end)}`
  ].join(' · ');
  // Room for ': ' and at least the cut mark after the host-written part.
  if (Array.from(head).length > SUMMARY_MAX - 3) {
    throw new EnvelopeCoreError('the phone summary cannot show the channels, recipients, cap and window whole');
  }
  // The summary is hashed and signed: an intent that is not one plain line
  // is never signed in any form, flattened or hidden.
  if (!isPlainLine(core.intent)) throw new EnvelopeCoreError(`the phone summary cannot carry the intent: ${plainLineProblem(core.intent)}`);
  return `${head}: ${core.intent}`;
}

// The owner-facing line for one delta, built from its kind and value against
// the envelope as it is now (before → after), never from the caller's text.
// The "after" of a cap is what applyDeltas will set: the higher of the two.
function deltaText(env, d, { facts = null } = {}) {
  const caps = env?.caps || {};
  const num = (v) => Number(v) || 0;
  switch (d?.kind) {
    case 'recipient':
      return `adds recipient ${field(d.value)}`;
    case 'channel':
      return `allows channel sends on ${field(d.value)}`;
    case 'fact': {
      const f = facts && typeof facts.get === 'function' ? facts.get(String(d.value)) : null;
      if (!f) return `discloses ${field(d.value)}`;
      return isPlainLine(f.stmt) ? `discloses ${field(d.value)} "${f.stmt}"` : `discloses ${field(d.value)} ${HIDDEN_TEXT}`;
    }
    case 'usd':
      return `raises usd cap from ${money(caps.usd)} to ${money(Math.max(num(caps.usd), num(d.value)))}`;
    case 'contacts':
      return `raises contacts cap from ${num(caps.contacts)} to ${Math.max(num(caps.contacts), num(d.value))}`;
    case 'attempts':
      return `raises attempts per contact from ${num(caps.attemptsPerContact)} to ${Math.max(num(caps.attemptsPerContact), num(d.value))}`;
    case 'window': {
      const end = String(env?.window?.end || '');
      return `extends window end from ${field(end)} to ${field(String(d.value) > end ? d.value : end)}`;
    }
    default:
      return `unrecognised change "${field(d?.kind)}" (it will not be applied)`;
  }
}

function envelopeFit(env, payload = {}, {
  facts = new Map(), recipients = [], now = new Date(), estimateUsd = 0, gateBlocked = [], executorId = null, channel = null
} = {}) {
  const refusals = [];
  const deltas = [];
  let core = null;
  // Texts are rendered against the approved core once it is known.
  const addDelta = (d) => {
    if (!deltas.some((x) => x.kind === d.kind && x.value === d.value)) deltas.push({ ...d, text: deltaText(core, d, { facts }) });
  };
  const refuse = (text) => ({ fits: false, refusals: [text], deltas: [] });
  if (!env) return refuse('no envelope');
  if (typeof executorId !== 'string' || !executorId) return refuse('no executor named for the fit');
  if (!Array.isArray(recipients) || !recipients.length) return refuse('the job names no recipients');
  const per = payload.attemptsPerContact === undefined ? 1 : payload.attemptsPerContact;
  if (!Number.isInteger(per) || per < 1) return refuse('attemptsPerContact must be a positive integer');
  if (typeof estimateUsd !== 'number' || !Number.isFinite(estimateUsd) || estimateUsd < 0) return refuse('estimateUsd must be a finite number ≥ 0');
  // `channel`: the fit is for a channel send on that channel (stored form).
  // null is an executor job, which no channel list affects.
  if (channel !== null && !isChannelId(channel)) return refuse('the channel named for the send is not a channel id');
  // Every limit below is read from the core, the part the owner approved and
  // the hash covers, never from the raw file fields.
  try {
    core = envelopeCore(env);
  } catch (err) {
    return refuse(`envelope ${env.id} is malformed: ${err.message}`);
  }
  if (!envelopeIntact(env)) return refuse(`envelope ${env.id} changed since approval; request it again`);
  if (!FITTABLE_STATUSES.includes(env.status)) refusals.push(`envelope ${env.id} is ${env.status}`);
  if (core.executor !== executorId) refusals.push(`envelope ${env.id} is for ${core.executor}, not ${executorId}`);
  if (refusals.length) return { fits: false, refusals, deltas };

  const usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  // No list, or a list without this channel: the owner has not approved it.
  if (channel !== null && !(core.channels || []).includes(channel)) addDelta({ kind: 'channel', value: channel });
  for (const r of recipients) {
    if (!core.recipients.allow.includes(r)) addDelta({ kind: 'recipient', value: r });
  }
  const declared = [
    ...(Array.isArray(payload.facts) ? payload.facts.map(String) : []),
    ...gateBlocked.filter((x) => x.reason === 'not-in-envelope' && x.factId).map((x) => x.factId)
  ];
  // A fact already in the envelope is checked too: it may have been
  // retracted or made private since the owner approved it.
  for (const id of [...new Set(declared)]) {
    const f = facts.get(id);
    let why = null;
    if (!f) why = 'missing';
    else if (f.status !== 'active') why = f.status;
    else if (f.provenance === 'inferred') why = 'inferred';
    else if (f.provenance === 'unknown') why = 'unknown';
    else if (!f.disclosable) why = 'not disclosable';
    if (why) {
      refusals.push(`${id} cannot be disclosed (${why})`);
      continue;
    }
    if (!core.facts.includes(id)) addDelta({ kind: 'fact', value: id });
  }
  const caps = core.caps;
  const needUsd = roundUsd((Number(usage.usd) || 0) + estimateUsd);
  if (needUsd > caps.usd) addDelta({ kind: 'usd', value: needUsd });
  const distinct = new Set([...(usage.contacts || []), ...recipients]);
  if (distinct.size > caps.contacts) addDelta({ kind: 'contacts', value: distinct.size });
  const attempts = recipients.map((r) => (Number(usage.attempts?.[r]) || 0) + per);
  const maxAttempts = attempts.length ? Math.max(...attempts) : 0;
  if (maxAttempts > caps.attemptsPerContact) addDelta({ kind: 'attempts', value: maxAttempts });
  const today = localDate(now, core.window.tz);
  if (today < core.window.start) refusals.push(`envelope ${env.id} opens ${core.window.start}`);
  else if (today > core.window.end) addDelta({ kind: 'window', value: today });
  if (env.status === 'exhausted' && !deltas.some((d) => d.kind === 'usd' || d.kind === 'contacts' || d.kind === 'attempts')) {
    if ((usage.contacts || []).length >= caps.contacts) {
      addDelta({ kind: 'contacts', value: caps.contacts + Math.max(1, recipients.length) });
    } else {
      addDelta({ kind: 'usd', value: roundUsd(Math.max(needUsd, caps.usd) + 1) });
    }
  }
  return { fits: refusals.length === 0 && deltas.length === 0, refusals, deltas };
}

// Throws for an envelope outside FITTABLE_STATUSES: a revoked, rejected,
// tampered or never-approved envelope is never revived by a delta.
function applyDeltas(env, deltas, { questionId = null, factId = null, at = new Date().toISOString() } = {}) {
  if (!env || !FITTABLE_STATUSES.includes(env.status)) {
    throw new Error(`applyDeltas: envelope ${env?.id} is ${env?.status}; only ${FITTABLE_STATUSES.join(', ')} envelopes take a delta`);
  }
  const next = JSON.parse(JSON.stringify(env));
  for (const d of deltas) {
    if (d.kind === 'recipient' && !next.recipients.allow.includes(d.value)) next.recipients.allow.push(d.value);
    else if (d.kind === 'fact' && !next.facts.includes(d.value)) next.facts.push(d.value);
    else if (d.kind === 'channel' && !(next.channels || []).includes(d.value)) next.channels = [...(next.channels || []), d.value];
    else if (d.kind === 'usd') next.caps.usd = Math.max(Number(next.caps.usd) || 0, Number(d.value) || 0);
    else if (d.kind === 'contacts') next.caps.contacts = Math.max(Number(next.caps.contacts) || 0, Number(d.value) || 0);
    else if (d.kind === 'attempts') next.caps.attemptsPerContact = Math.max(Number(next.caps.attemptsPerContact) || 0, Number(d.value) || 0);
    else if (d.kind === 'window' && String(d.value) > next.window.end) next.window.end = String(d.value);
  }
  next.version = (Number(next.version) || 1) + 1;
  next.hash = envelopeHash(envelopeCore(next));
  next.status = 'active';
  next.deltas = [...(next.deltas || []), { questionId, deltas, at, factId }];
  return next;
}

// The delta card, whole: the host-built change lines first, the intent last.
function deltaQuestionText(env, deltas, { facts = null } = {}) {
  return [
    `Envelope ${field(env.id)} (${field(env.executor)}) needs your approval for:`,
    ...deltas.map((d) => `- ${deltaText(env, d, { facts })}`),
    `Intent: ${shown(env.intent)}`
  ].join('\n');
}

function renderDeltaQuestion(env, deltas, options = {}) {
  return cut(deltaQuestionText(env, deltas, options), QUESTION_MAX_CHARS);
}

function deltasEqual(a, b) {
  return canonicalize(a || []) === canonicalize(b || []);
}

module.exports = {
  ENVELOPE_STATUSES,
  ENVELOPE_AUTHORITIES,
  FITTABLE_STATUSES,
  EnvelopeStore,
  EnvelopeCoreError,
  envelopeCore,
  normalizeChannelId,
  envelopeHash,
  envelopeIntact,
  validateEnvelopeRequest,
  renderEnvelopeQuestion,
  envelopeQuestionText,
  deltaQuestionText,
  HIDDEN_TEXT,
  QUESTION_MAX_CHARS,
  renderSignedSummary,
  envelopeFit,
  applyDeltas,
  renderDeltaQuestion,
  deltaText,
  deltasEqual
};
