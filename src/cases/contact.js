// src/cases/contact.js
// The contact router (cases stage 4 spec §3.5): batching one message per
// channel, correlating replies through deliveries.json, owner proof, the
// answer path into CaseRuntime.answerQuestion, conflicting answers, the
// inbox behind a busy case, relay events, and sendExternal, the one
// gate-enforced path for any channel-targeted send by case code (R38, R39).
const { QuestionStore } = require('./questions');
const {
  renderBatch, parseReply, optionOrText, normalizeAddress, formatShort, CONTACT_CHANNELS, appOnly, needsApp
} = require('./contact-format');
const { ContactDeliveryError, GATE_PASSED } = require('../channels/channel-plugin');
const { createLogger } = require('../logging');

// Ruling T5-m22 (owner: "only the app or my paired phone"): the only
// channels that may answer an approval or an app-only question. An
// allowlist, so a channel added later is refused until it is named here.
// `mobile` is F3's device-signed phone channel.
const APP_ANSWER_CHANNELS = Object.freeze(['in-app', 'mobile']);
// The channel named in "Answer in King Louie or <channel>" (the phone).
const AUTHENTICATED_ORDER = ['mobile'];
const TOKEN_IN_TEXT = /#([0-9A-Za-z]{6})\b/;
const ENVELOPE_TYPES = new Set(['envelope', 'envelope-delta']);
// A queued answer that keeps failing for a reason other than a busy case is
// dropped (and logged) after this many drains.
const MAX_INBOX_ATTEMPTS = 5;
const ERROR_ACK = "Couldn't record that. Answer it in King Louie.";
// Ruling T5-inbox: an approval or app-only answer is never written to
// inbox.jsonl (the data dir is writable by the model's Bash, so a file there
// must never carry approval authority). On a busy case it is refused.
const BUSY_ACK = 'The case is busy; answer again in a minute.';
// Relay input bounds: a poll returns at most 100 events (§4.5); anything
// past these limits is skipped, not processed.
const MAX_RELAY_EVENTS = 1000;
const MAX_GATHERED_SCAN = 1000;
const RELAY_EVENT_TYPES = new Set(['status', 'inbound', 'gathered']);
const RELAY_EVENT_ID = /^[\x21-\x7e]{1,128}$/;
const RELAY_STATUS = /^[a-z-]{1,32}$/;

// The relay an adapter is served by: `relayName`, else its relay client's
// `name` (TelephonyChannel/relay email take `relay`). null: no relay.
function relayOf(adapter) {
  const name = adapter?.relayName ?? adapter?.relay?.name ?? null;
  return typeof name === 'string' && name ? name : null;
}
const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function answerLabel(record, answer) {
  if (!answer) return '';
  if (answer.optionId) {
    const o = (record.options || []).find((x) => x.id === answer.optionId);
    return o ? o.label : answer.optionId;
  }
  return answer.text || '';
}

function sameAnswer(record, answer) {
  const a = record.answer;
  if (!a) return false;
  if (answer.optionId) return a.optionId === answer.optionId;
  const text = String(answer.text || '').trim();
  if (a.optionId) return optionOrText(record.options, text).optionId === a.optionId;
  return String(a.text || '').trim().toLowerCase() === text.toLowerCase();
}

// A timestamp the adapter reported, never later than now (Task 3's
// Presence.noteInbound does not clamp a future `at`).
function clampedAt(at, now) {
  const t = at ? Date.parse(at instanceof Date ? at.toISOString() : String(at)) : NaN;
  return Number.isFinite(t) && t < now.getTime() ? new Date(t) : now;
}

// `conflict` follow-ups (§3.5 step 6): keep → the first answer stands (the
// fact only records the choice); change → the second answer becomes a
// `user` fact on the original `about`, superseding the first; an envelope
// approval changed to reject is revoked (C3).
function conflictFact(record, answer) {
  const p = record.payload || {};
  if (answer.optionId === 'change') {
    const about = p.about && typeof p.about === 'object' ? p.about : {};
    return {
      stmt: `Owner changed the answer to ${p.conflictOf} to "${p.second}" (was "${p.first}").`,
      subject: typeof about.subject === 'string' && about.subject ? about.subject : 'question',
      attr: typeof about.attr === 'string' && about.attr ? about.attr : p.conflictOf,
      value: p.second,
      ...(p.firstFactId ? { supersedes: p.firstFactId } : {})
    };
  }
  return {
    stmt: `Owner kept the first answer to ${p.conflictOf}: "${p.first}".${answer.text ? ` (${answer.text})` : ''}`,
    subject: 'question',
    attr: record.id,
    value: 'keep'
  };
}

async function conflictAnswered(record, fact, { runtime, caseId }) {
  const p = record.payload || {};
  if (record.answer?.optionId !== 'change') {
    runtime.records(caseId).writeJournal('question', `${record.id}: the first answer to ${p.conflictOf} stands ("${p.first}").`, runtime.now());
    return { applied: 'keep' };
  }
  runtime.records(caseId).writeJournal('question', `${record.id}: the answer to ${p.conflictOf} is now "${p.second}" (was "${p.first}").`, runtime.now());
  let revoked = null;
  if (ENVELOPE_TYPES.has(p.originalType) && p.secondAnswer?.optionId === 'reject' && p.envelopeId) {
    const registry = typeof runtime.host?.getExecutorRegistry === 'function' ? runtime.host.getExecutorRegistry() : null;
    if (registry && typeof registry.revokeEnvelope === 'function') {
      revoked = await registry.revokeEnvelope(caseId, p.envelopeId, 'owner changed the answer');
    }
  }
  const effect = fact ? runtime.applyOwnerFact(caseId, fact) : null;
  return { applied: 'change', revoked, effect };
}

QuestionStore.registerAnswerHandler('conflict', { toFact: conflictFact, onAnswered: conflictAnswered });

class ContactRouter {
  constructor({
    dir = null, state, runtime, adapters, presence = null, getGate = () => null, clock = () => new Date(),
    getTimeZone = () => '', log = createLogger('contact/router')
  } = {}) {
    if (!state) throw new Error('ContactRouter needs a ContactState');
    this.dir = dir || state.dir;
    this.state = state;
    this.runtime = runtime;
    this.adapters = adapters;
    this.presence = presence;
    this.getGate = getGate;
    this.clock = clock;
    this.getTimeZone = getTimeZone;
    this.log = log;
  }

  adapter(channelId) {
    try {
      return this.adapters?.get(channelId) || null;
    } catch {
      return null;
    }
  }

  // Whether a token, delivery id or channel message reference belongs to a
  // contact delivery (the bridges use it to intercept replies).
  knows(channelId, correlationId) {
    return Boolean(correlationId && this.state.resolve(correlationId, { channel: channelId }));
  }

  channelStatus(channelId) {
    const a = this.adapter(channelId);
    if (!a) return { enabled: false, configured: false, reason: 'not enabled in this host' };
    if (!a.contactConfigured()) return { enabled: true, configured: false, reason: 'no owner target is configured' };
    return { enabled: true, configured: true };
  }

  // Ruling T5-m22: whether a reply on this channel may answer an approval or
  // an app-only question. The id must be allowlisted AND the adapter must
  // report authenticated replies (fail closed on a misconfigured adapter).
  answersInApp(channelId) {
    if (!APP_ANSWER_CHANNELS.includes(channelId)) return false;
    return this.adapter(channelId)?.contactCapabilities()?.authenticatedReplies === true;
  }

  firstAuthenticated() {
    for (const id of AUTHENTICATED_ORDER) {
      const a = this.adapter(id);
      if (a && a.contactConfigured() && this.answersInApp(id)) return id;
    }
    return 'the King Louie app';
  }

  // entries: [{ caseId, caseTitle, token, record }], all due on this channel.
  async deliver(channelId, entries, { deliveryId = null, batchToken = null } = {}) {
    const adapter = this.adapter(channelId);
    if (!adapter || !adapter.contactConfigured()) throw new ContactDeliveryError('not-configured', `${channelId} is not configured`);
    const caps = adapter.contactCapabilities();
    const id = deliveryId || this.state.newDeliveryId();
    const token = batchToken || this.state.newToken();
    const message = renderBatch(entries, {
      batchToken: token,
      maxChars: caps.maxChars || 4000,
      maxOptions: caps.maxOptions ?? 6,
      authenticated: this.answersInApp(channelId),
      timeZone: this.getTimeZone()
    });
    if (message.tooLarge) throw new ContactDeliveryError('too-large', `the batch is over ${caps.maxChars} characters even with items cut`);
    const expiries = message.items.map((i) => i.expiresAt).filter(Boolean).sort();
    const meta = {
      // A batch of app-only notices invites no reply (no gather, no buttons).
      expectsReply: caps.expectsReplies === true && message.items.some((i) => i.answerable),
      options: message.items.length === 1 ? message.items[0].options : null,
      deliveryId: id,
      batchToken: token,
      expiresAt: expiries[0] || null,
      urgency: message.items.some((i) => i.urgency === 'high') ? 'high' : (message.items.some((i) => i.urgency === 'normal') ? 'normal' : 'low')
    };
    const sent = await adapter.sendContact({ subject: message.subject, text: message.text, items: message.items }, meta);
    this.state.recordDelivery(id, {
      channel: channelId,
      at: this.clock().toISOString(),
      externalRef: sent?.externalRef ?? null,
      relayId: sent?.relayId ?? null,
      batchToken: token,
      idempotencyKey: id,
      status: 'sent',
      items: message.items.map((i) => ({ n: i.n, caseId: i.caseId, questionId: i.questionId, token: i.token, kind: i.kind, answerable: i.answerable }))
    });
    return { deliveryId: id, externalRef: sent?.externalRef ?? null, batchToken: token };
  }

  // { meta, record }; both null when the case is gone, record null when the
  // question is. Any other failure (I/O) throws, so a queued answer is
  // retried instead of dropped.
  _record(caseId, questionId) {
    let meta;
    try {
      meta = this.runtime.getCase(caseId);
    } catch (err) {
      if (err && err.code === 'CASE_NOT_FOUND') return { meta: null, record: null };
      throw err;
    }
    return { meta, record: this.runtime.questions(meta.id).get(questionId) };
  }

  // A delivery as parseReply's batch. deliveries.json items store neither
  // options nor the case title; parseReply needs both (the title for the
  // quoted-header skip).
  _batchItem(it) {
    const { meta, record } = this._record(it.caseId, it.questionId);
    return { ...it, caseTitle: meta?.title || '', options: record?.options || [] };
  }

  _batch(resolved) {
    return { batchToken: resolved.delivery.batchToken, items: (resolved.delivery.items || []).map((it) => this._batchItem(it)) };
  }

  _hint(channelId) {
    const latest = Object.values(this.state.deliveries()).filter((d) => d.channel === channelId).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    return `Add the code from the message, e.g. "#${latest ? latest.batchToken : 'K7QD4M'} 1 a".`;
  }

  // §3.5. correlationId: a question token, batch token, delivery id or the
  // channel's message reference. answer: { optionId } | { optionIndex } | { text }.
  // Never throws: bad input and unexpected errors come back as an outcome.
  async handleReply(channelId, correlationId, answer = {}, meta = {}) {
    try {
      return await this._handleReply(channelId, correlationId, answer, meta);
    } catch (err) {
      this.log.error(`contact reply on ${channelId} failed: ${err?.message || err}`);
      return { ok: false, outcome: 'error', ackText: ERROR_ACK };
    }
  }

  async _handleReply(channelId, rawCorrelationId, rawAnswer, rawMeta) {
    const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
    const answer = rawAnswer && typeof rawAnswer === 'object' ? rawAnswer : {};
    const correlationId = typeof rawCorrelationId === 'string' || typeof rawCorrelationId === 'number' ? String(rawCorrelationId) : null;
    if (meta.ownerProven !== true) {
      this.log.warn(`contact reply refused: not-owner (channel ${channelId}, sender ${meta.senderId ?? 'unknown'})`);
      return { ok: false, outcome: 'refused: not-owner', ackText: null };
    }
    const adapter = this.adapter(channelId);
    if (!adapter) {
      this.log.warn(`contact reply refused: ${channelId} is not a contact channel in this host`);
      return { ok: false, outcome: 'refused: unknown-channel', ackText: null };
    }
    const caps = adapter.contactCapabilities() || {};
    const text = typeof answer.text === 'string' && answer.text.trim() ? answer.text : null;
    const textToken = text ? TOKEN_IN_TEXT.exec(text) : null;
    if (caps.requiresToken && !textToken && !(correlationId && answer.optionIndex !== undefined)) {
      return { ok: false, outcome: 'refused: no-token', ackText: this._hint(channelId) };
    }
    let resolved = correlationId ? this.state.resolve(correlationId, { channel: channelId }) : null;
    if (!resolved && textToken) resolved = this.state.resolve(textToken[1], { channel: channelId });
    if (!resolved) return { ok: false, outcome: 'unknown', ackText: "I couldn't match that reply to a question. Answer it in King Louie." };

    let pairs;
    if (resolved.item && (answer.optionId || answer.optionIndex !== undefined)) {
      pairs = [{ item: resolved.item, answer }];
    } else if (resolved.item && text && !textToken) {
      // A reply tied to one question is one answer: parseReply's single-item
      // thread path strips quoted history and a signature (ruling T2-join)
      // before it matches an option.
      const item = this._batchItem(resolved.item);
      const parsed = parseReply({ batchToken: resolved.delivery.batchToken, items: [item] }, text, { threaded: true });
      if (!parsed.answers.length) return { ok: false, outcome: 'unparsed', ackText: parsed.ack };
      pairs = [{ item: resolved.item, answer: parsed.answers[0].answer }];
    } else if (text) {
      const parsed = parseReply(this._batch(resolved), text, { threaded: !caps.requiresToken });
      if (!parsed.answers.length) return { ok: false, outcome: 'unparsed', ackText: parsed.ack };
      pairs = parsed.answers;
    } else {
      return { ok: false, outcome: 'unparsed', ackText: `Which question? Reply "#${resolved.delivery.batchToken} <n> <answer>".` };
    }

    if (this.presence) this.presence.noteInbound(channelId, clampedAt(meta.at, this.clock()));
    const results = [];
    for (const p of pairs) {
      try {
        results.push(await this._apply(channelId, caps, p.item, p.answer, meta));
      } catch (err) {
        this.log.error(`contact answer to ${p.item?.questionId} on ${channelId} failed: ${err?.message || err}`);
        results.push({ ok: false, outcome: 'error', ack: ERROR_ACK });
      }
    }
    const acks = results.map((r) => r.ack).filter(Boolean);
    return {
      ok: results.every((r) => r.ok),
      outcome: results.map((r) => r.outcome).join(', '),
      ackText: acks.length ? acks.join('\n') : null
    };
  }

  async _apply(channelId, caps, item, answer, meta, { fromInbox = false } = {}) {
    const { meta: caseMeta, record: found } = this._record(item.caseId, item.questionId);
    if (!caseMeta || !found) return { ok: false, outcome: 'unknown', ack: `${item.questionId} no longer exists.` };
    let record = found;
    // Ruling T5-inbox, defence in depth: whatever a line in inbox.jsonl
    // says (channel 'in-app' included), it never answers these.
    if (fromInbox && needsApp(record)) {
      this.log.warn(`contact inbox: refused a queued answer to ${record.kind} ${caseMeta.id}/${record.id} (never queued by the router)`);
      return { ok: false, outcome: 'refused: inbox-authority', ack: null };
    }
    // §3.5 step 2 and owner decision M22, all before answerQuestion.
    const inApp = APP_ANSWER_CHANNELS.includes(channelId) && caps.authenticatedReplies === true;
    if ((record.kind === 'approval' || appOnly(record)) && !inApp) {
      return {
        ok: false,
        outcome: record.kind === 'approval' ? 'refused: approval' : 'refused: app-only',
        ack: `Answer this in the app: ${record.id} in ${caseMeta.title} can't be answered by ${channelId}.`
      };
    }
    if (item.answerable === false) {
      return { ok: false, outcome: 'refused: not-answerable', ack: `${record.id} can't be answered by ${channelId}. Answer this in the app.` };
    }
    let clean = answer;
    if (answer.optionIndex !== undefined) {
      const index = Number(answer.optionIndex);
      const option = Number.isInteger(index) && index >= 0 ? (record.options || [])[index] : null;
      if (!option) return { ok: false, outcome: 'invalid', ack: `${record.id} has no option ${Number.isInteger(index) ? index + 1 : String(answer.optionIndex)}.` };
      clean = { optionId: option.id };
    }
    if (record.kind === 'approval' && !clean.optionId) {
      const ids = (record.options || []).map((o) => o.id).join(' / ');
      return { ok: false, outcome: 'refused: approval-text', ack: `${record.id} is an approval: reply with one of its options (${ids}).` };
    }
    if (record.kind === 'briefing') {
      if (!record.answer && !record.closed) {
        try {
          await this.runtime.acknowledgeBriefing(caseMeta.id, record.id, { channel: channelId });
        } catch (err) {
          // Ruling T5-brief: a busy case queues the acknowledgement like an answer.
          if (err && err.code === 'CASE_BUSY') {
            if (!fromInbox) {
              this.state.appendInbox({ at: this.clock().toISOString(), channel: channelId, caseId: caseMeta.id, questionId: record.id, acknowledge: true, meta: { senderId: meta.senderId ?? null, ownerProven: true } });
            }
            return { ok: true, outcome: 'queued', ack: 'Received — recording it after the current step' };
          }
          if (!err || err.code !== 'ALREADY_ANSWERED') throw err;
        }
      }
      return { ok: true, outcome: 'acknowledged', ack: 'Noted.' };
    }
    if (record.answer === null && !record.closed) {
      try {
        await this.runtime.answerQuestion(caseMeta.id, record.id, { channel: channelId, text: clean.text ?? null, optionId: clean.optionId ?? null });
        return { ok: true, outcome: 'recorded', ack: `Recorded for ${caseMeta.title}.` };
      } catch (err) {
        if (err && err.code === 'CASE_BUSY') return this._busy(channelId, caseMeta, record, clean, meta, fromInbox);
        if (err && err.code === 'ALREADY_ANSWERED' && err.record) {
          record = err.record;
        } else if (err && err.name === 'QuestionError') {
          return { ok: false, outcome: 'invalid', ack: `Couldn't record that: ${err.message}` };
        } else {
          throw err;
        }
      }
    }
    if (!record.answer) return { ok: false, outcome: 'closed', ack: `${record.id} is already closed.` };
    if (sameAnswer(record, clean)) return { ok: true, outcome: 'already', ack: 'Already recorded.' };
    try {
      await this._conflict(channelId, caseMeta, record, clean);
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return this._busy(channelId, caseMeta, record, clean, meta, fromInbox);
      throw err;
    }
    return { ok: true, outcome: 'conflict', ack: 'That differs from your earlier answer, so I sent a follow-up: which one stands?' };
  }

  // A busy case: queue the answer for drainInbox, except an approval or
  // app-only answer, which is refused (ruling T5-inbox).
  _busy(channelId, caseMeta, record, clean, meta, fromInbox) {
    if (needsApp(record)) return { ok: false, outcome: 'refused: busy', ack: BUSY_ACK };
    if (!fromInbox) {
      this.state.appendInbox({ at: this.clock().toISOString(), channel: channelId, caseId: caseMeta.id, questionId: record.id, text: clean.text ?? null, optionId: clean.optionId ?? null, meta: { senderId: meta.senderId ?? null, ownerProven: true } });
    }
    return { ok: true, outcome: 'queued', ack: 'Received — recording it after the current step' };
  }

  // §3.5 step 6: never overwrite; ask which answer stands, on this channel only.
  async _conflict(channelId, caseMeta, record, answer) {
    const first = cut(answerLabel(record, record.answer), 80);
    const second = cut(answerLabel(record, answer), 80);
    const when = formatShort(record.answer.at, this.getTimeZone());
    const text = record.answer.channel === 'default'
      ? `${record.id} was settled by its default "${first}" at ${when}; you now answered "${second}". Which stands?`
      : `You answered ${record.id} "${first}" on ${record.answer.channel} at ${when}, and now "${second}". Which stands?`;
    const created = await this.runtime.systemAction(caseMeta.id, `contact: conflict ${record.id}`, () => this.runtime.questions(caseMeta.id).create({
      kind: record.kind,
      urgency: record.urgency,
      text,
      options: [{ id: 'keep', label: `Keep "${first}"` }, { id: 'change', label: `Change to "${second}"` }],
      defaultOnSilence: 'hold',
      payload: {
        type: 'conflict',
        conflictOf: record.id,
        originalType: record.payload?.type || 'ask',
        about: record.payload?.about || null,
        first,
        second,
        channel: channelId,
        secondAnswer: { optionId: answer.optionId ?? null, text: answer.text ?? null },
        firstFactId: record.answer.factId || null,
        envelopeId: record.payload?.envelopeId || null,
        mcpAnswerable: false,
        appOnly: appOnly(record),
        key: `conflict:${record.id}`
      }
    }));
    this.state.pin(`${caseMeta.id}/${created.id}`, channelId);
    return created;
  }

  // Answers queued behind a busy case, retried every tick.
  // Never throws. A malformed line is dropped; a line that fails for another
  // reason than a busy case is retried up to MAX_INBOX_ATTEMPTS drains. The
  // channel's current capabilities decide again (a channel that is gone
  // counts as unauthenticated, so an approval then stays in the app).
  // One drain at a time: a caller while one runs joins it. Returns
  // { applied, kept, refused, dropped }: refused = not applied (refused,
  // unknown, invalid); dropped = malformed or given up after retries.
  drainInbox() {
    if (!this._draining) {
      this._draining = this._drainInbox().finally(() => { this._draining = null; });
    }
    return this._draining;
  }

  async _drainInbox() {
    const counts = { applied: 0, kept: 0, refused: 0, dropped: 0 };
    let snapshot;
    try {
      snapshot = this.state.inboxSnapshot();
    } catch (err) {
      this.log.error(`contact inbox unreadable: ${err.message}`);
      return counts;
    }
    const lines = snapshot.lines;
    if (!lines.length) return counts;
    const keep = [];
    let changed = false;
    for (const line of lines) {
      const valid = line && typeof line === 'object' && typeof line.channel === 'string'
        && typeof line.caseId === 'string' && typeof line.questionId === 'string'
        && (typeof line.optionId === 'string' || typeof line.text === 'string' || line.acknowledge === true);
      if (!valid) {
        this.log.warn('contact inbox: dropped a malformed line');
        counts.dropped += 1;
        changed = true;
        continue;
      }
      let r;
      try {
        const caps = this.adapter(line.channel)?.contactCapabilities() || {};
        const answer = line.optionId ? { optionId: line.optionId } : { text: line.text };
        r = await this._apply(line.channel, caps, { caseId: line.caseId, questionId: line.questionId }, answer, line.meta || {}, { fromInbox: true });
      } catch (err) {
        const attempts = (Number.isInteger(line.attempts) ? line.attempts : 0) + 1;
        changed = true;
        if (attempts >= MAX_INBOX_ATTEMPTS) {
          this.log.error(`contact inbox: gave up on the answer to ${line.caseId}/${line.questionId} after ${attempts} tries: ${err?.message || err}`);
          await this._journalDropped(line, attempts, err);
          counts.dropped += 1;
        } else {
          this.log.warn(`contact inbox: answer to ${line.caseId}/${line.questionId} failed (try ${attempts}): ${err?.message || err}`);
          keep.push({ ...line, attempts });
        }
        continue;
      }
      if (r.outcome === 'queued') keep.push(line);
      else {
        if (r.ok) counts.applied += 1;
        else {
          this.log.warn(`contact inbox: answer to ${line.caseId}/${line.questionId} not applied (${r.outcome})`);
          counts.refused += 1;
        }
        changed = true;
      }
    }
    if (changed) {
      try {
        this.state.rewriteInbox(keep, snapshot.size);
      } catch (err) {
        this.log.error(`contact inbox: could not rewrite inbox.jsonl: ${err.message}`);
      }
    }
    counts.kept = keep.length;
    return counts;
  }

  // A queued answer given up on is written to the case journal too, so the
  // loss is visible in the case and not only in the log.
  async _journalDropped(line, attempts, err) {
    const what = line.acknowledge ? 'acknowledgement of' : 'answer to';
    const text = `The owner's ${what} ${line.questionId} via ${line.channel} could not be recorded after ${attempts} tries and was dropped (${err?.message || err}). Ask again if it still matters.`;
    try {
      await this.runtime.systemAction(line.caseId, `contact: dropped ${line.questionId}`, () => {
        this.runtime.records(line.caseId).writeJournal('question', text, this.runtime.now());
      });
    } catch (e) {
      this.log.error(`contact inbox: could not journal the dropped ${what} ${line.caseId}/${line.questionId}: ${e?.message || e}`);
    }
  }

  recordStatus(channelId, { externalRef = null, relayId = null, status, error = null } = {}) {
    return this.state.setDeliveryStatus(relayId || externalRef, status, error, { channels: [channelId] });
  }

  // The contact channels whose adapter the named relay serves.
  _relayChannels(relayName) {
    return CONTACT_CHANNELS.filter((id) => relayOf(this.adapter(id)) === relayName);
  }

  // Relay events from polling or a signed push (§4.5); deduplicated by id.
  // A relay only reaches what it serves: an inbound event goes only to an
  // adapter that relay serves, a status only changes a delivery on one of
  // those channels, and gathered digits only answer a voice delivery whose
  // relayId is the event's messageId. Never throws.
  async ingestRelayEvents(relayName, events = []) {
    let applied = 0;
    let skipped = 0;
    if (!Array.isArray(events)) return { applied, skipped };
    let list = events;
    if (list.length > MAX_RELAY_EVENTS) {
      this.log.warn(`relay ${relayName}: ${list.length} events in one batch; skipping all past the first ${MAX_RELAY_EVENTS}`);
      skipped += list.length - MAX_RELAY_EVENTS;
      list = list.slice(0, MAX_RELAY_EVENTS);
    }
    const channels = this._relayChannels(relayName);
    for (const ev of list) {
      let ok = false;
      try {
        ok = await this._relayEvent(relayName, channels, ev);
      } catch (err) {
        this.log.error(`relay ${relayName}: event failed: ${err?.message || err}`);
      }
      if (ok) applied += 1;
      else skipped += 1;
    }
    return { applied, skipped };
  }

  async _relayEvent(relayName, channels, ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !RELAY_EVENT_ID.test(ev.id) || !RELAY_EVENT_TYPES.has(ev.type)) return false;
    if (!this.state.markEventSeen(`${relayName}:${ev.id}`)) return false;
    if (ev.type === 'status') {
      if (typeof ev.messageId !== 'string' || !ev.messageId || typeof ev.status !== 'string' || !RELAY_STATUS.test(ev.status)) return false;
      const error = ev.error ? cut(ev.error, 500) : null;
      return Boolean(this.state.setDeliveryStatus(ev.messageId, ev.status, error, { channels }));
    }
    if (ev.type === 'inbound') {
      if (!channels.includes(ev.channel)) {
        this.log.warn(`relay ${relayName}: skipped an inbound event for ${String(ev.channel).slice(0, 32)}, which it does not serve`);
        return false;
      }
      const adapter = this.adapter(ev.channel);
      if (typeof adapter?.ingestRelayEvent !== 'function') return false;
      await adapter.ingestRelayEvent(ev);
      return true;
    }
    // gathered: DTMF digits from a call to the owner number.
    if (!channels.includes('voice')) {
      this.log.warn(`relay ${relayName}: skipped gathered digits; it does not serve voice`);
      return false;
    }
    if (typeof ev.messageId !== 'string' || !ev.messageId) return false;
    const found = Object.values(this.state.deliveries()).find((d) => d.channel === 'voice' && d.relayId && d.relayId === ev.messageId);
    if (!found) {
      this.log.warn(`relay ${relayName}: gathered digits for an unknown voice call`);
      return false;
    }
    const items = found.items || [];
    const picks = [];
    const seen = new Set();
    const results = Array.isArray(ev.results) ? ev.results : [];
    for (let i = 0; i < results.length && i < MAX_GATHERED_SCAN && picks.length < items.length; i += 1) {
      const r = results[i];
      const n = Number(r?.n);
      if (seen.has(n)) continue;
      const item = items.find((it) => it.n === n);
      const digit = Number.parseInt(String(r?.digits ?? ''), 10);
      if (!item || !Number.isInteger(digit) || digit < 1) continue;
      seen.add(n);
      picks.push({ item, digit });
    }
    for (const { item, digit } of picks) {
      await this.handleReply('voice', item.token, { optionIndex: digit - 1 }, { channel: 'voice', senderId: 'call', at: ev.at || null, ownerProven: true });
    }
    return true;
  }

  // The owner exemption: the adapter's configured private owner target, never ntfy.
  isOwnerTarget(channelId, target) {
    if (channelId === 'ntfy') return false;
    const owner = this.adapter(channelId)?.ownerTarget?.();
    if (!owner) return false;
    const a = normalizeAddress(channelId, owner);
    const b = normalizeAddress(channelId, target);
    return Boolean(a && b && a === b);
  }

  // R38/R39: the one gate-enforced channel send for case code. Never throws.
  async sendExternal(args = {}) {
    try {
      return await this._sendExternal(args && typeof args === 'object' ? args : {});
    } catch (err) {
      this.log.error(`sendExternal failed: ${err?.message || err}`);
      return { ok: false, error: `send failed: ${err?.message || err}` };
    }
  }

  async _sendExternal({ caseId, channelId, target, text, envelope = null }) {
    const adapter = this.adapter(channelId);
    if (!adapter) return { ok: false, error: `${channelId} is not configured` };
    const to = normalizeAddress(channelId, target);
    if (!to) return { ok: false, error: `"${target}" is not a valid ${channelId} target` };
    const deliveryId = this.state.newDeliveryId();
    let body = String(text ?? '');
    if (!this.isOwnerTarget(channelId, to)) {
      const gate = this.getGate();
      if (!gate || typeof gate.gateLeaves !== 'function') {
        return { ok: false, error: 'the outbound gate is not available (cases stage 3), so only the owner can be messaged' };
      }
      const facts = this.runtime.ledger(caseId).view().facts;
      const entityIndex = typeof this.runtime.entityIndex === 'function' ? this.runtime.entityIndex() : null;
      const r = await gate.gateLeaves({ text: body }, { recipients: [to], envelope, facts, mode: 'message', caseId, entityIndex });
      if (!r || r.ok !== true) return { ok: false, error: 'outbound gate blocked the message', blocked: Array.isArray(r?.blocked) ? r.blocked : [] };
      if (typeof r.rendered?.text !== 'string') return { ok: false, error: 'the outbound gate returned no rendered text' };
      body = r.rendered.text;
    }
    try {
      await adapter.send(to, body, { [GATE_PASSED]: true, deliveryId });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, deliveryId };
  }
}

module.exports = { ContactRouter, conflictFact, conflictAnswered, sameAnswer, answerLabel, appOnly };
