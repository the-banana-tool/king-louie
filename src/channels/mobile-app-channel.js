// src/channels/mobile-app-channel.js
// The phone app as a contact channel (cases stage 4 spec §3.9, R44). Wave 3:
// needs fleet stage 3 (F3). Questions go out as node-signed `kl.question.ask`
// envelopes through the relay Mailbox (preflight M6: the relay registers the
// dotted prefix `kl.question.`), one per active enrolled device, with a push
// that carries only the token. An answer counts only as a device-signed
// `kl.question.answer` envelope verified here, on the node, against the
// admin-owned approver set; a relay-forwarded answer is never proof by itself.
// This is the one remote channel that may answer approvals and app-only
// questions (owner decision M22), so every answer is device-signed. Foreground
// presence is not (ruling T17-presence: the device key needs a biometric
// prompt on every use, so a phone cannot sign a ping every 60 s). An unsigned
// ping is accepted only over the approvals relay link, for a paired,
// unrevoked device, and it only changes which ladder rung is tried first: it
// never answers, approves, opens or closes anything.
//
// The relay link lives on `this.link`, never `this.relay`: the router's
// relayOf() treats `relay.name` as "served by that contact relay", and relay
// events must never be routed here.
//
// Sealed (sealed phones, R-SP-4, R-SP-5): once the seal policy says so, an ask's
// case, question, title, text and options go inside the seal, and so do an
// answer's case, question and answer. Latched with nobody to seal to, this
// channel reports itself not configured and sendContact refuses, so the ladder
// goes on to its other rungs; a question never goes out clear. A sealed answer's
// signature is checked before it is opened: a box key is public, so an open
// proves nothing about who wrote it.
const { ChannelPlugin, ContactDeliveryError } = require('./channel-plugin');
const { seal, nodeSigner, isDeviceJwk } = require('../approvals/envelope');
const { sealContent, openSealed, splitMessage, isSealedShape, SealError } = require('../approvals/seal');
const { verifyDeviceEnvelope, NonceCache, bytesSha256 } = require('../approvals/verify-device');
const messages = require('../approvals/messages');
const { TOKEN_RE } = require('../cases/contact-format');
const { TOKEN_IN_TEXT } = require('../cases/contact');
const { createLogger } = require('../logging');
const { isApprovalHidden } = require('../cases/hidden-chars');

const SIGNED_AT_SKEW_MS = 300 * 1000;
const QUESTION_ID = /^q-\d{4,}$/;
const CASE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const OPTION_ID = /^[a-z0-9-]{1,16}$/;
const ANSWER_KEYS = ['answer', 'case_id', 'device_id', 'node_id', 'nonce', 'question_id', 'signed_at', 'token', 'type', 'v'];
const ASK_KEYS = ['case_id', 'case_title', 'expires_at', 'kind', 'node_id', 'options', 'question_id', 'text', 'token', 'type', 'urgency', 'v'];
// Presence pings (ruling T17-presence): older than this are ignored; one
// repeat of the same state per device per PRESENCE_MIN_GAP_MS (a change of
// state always applies); a ping older than the last applied one is ignored.
const PRESENCE_MAX_AGE_MS = 2 * 60 * 1000;
const PRESENCE_MIN_GAP_MS = 5 * 1000;
// Bounds on the node-signed question (code points).
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_LABEL = 200;
const MAX_OPTIONS = 6;

// approval-v1 §5's hidden code points (Cc, Zl/Zp, Bidi_Control,
// Default_Ignorable_Code_Point as of Unicode 15.1), the list F3's
// Display.escape uses on both phones; the one table is in
// src/cases/hidden-chars.js. The node applies the same escape to what it
// signs, so the payload is clean before the phone escapes it again.
const isHidden = isApprovalHidden;

// Escaped (‹U+XXXX›) and at most `max` code points after escaping. `newlines`: keep '\n' (the
// question text may have several lines; titles and labels may not).
function clean(value, max, { newlines = false } = {}) {
  const text = newlines ? String(value ?? '').replace(/\r\n?/g, '\n') : String(value ?? '');
  const pieces = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    pieces.push(isHidden(cp) && !(newlines && ch === '\n') ? `‹U+${cp.toString(16).toUpperCase().padStart(4, '0')}›` : ch);
  }
  const size = (p) => Array.from(p).length;
  if (pieces.reduce((n, p) => n + size(p), 0) <= max) return pieces.join('');
  // Cut to max - 1 code points plus '…', never through an escape.
  let out = '';
  let used = 0;
  for (const p of pieces) {
    if (used + size(p) > max - 1) break;
    out += p;
    used += size(p);
  }
  return `${out}…`;
}

function validAnswer(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== 1) return false;
  if (keys[0] === 'option_id') return typeof a.option_id === 'string' && OPTION_ID.test(a.option_id);
  if (keys[0] === 'text') return typeof a.text === 'string' && a.text.trim().length > 0 && a.text.length <= 2000;
  return false;
}

const exactKeys = (m, keys) => JSON.stringify(Object.keys(m).sort()) === JSON.stringify(keys);

const isText = (v) => typeof v === 'string';
const isId = (re, v) => isText(v) && re.test(v);

// What an answer holds in clear, whichever form it has.
const answerClearFields = (m) => isId(messages.NODE_ID_RE, m.node_id) && isId(TOKEN_RE, m.token) && isId(messages.NONCE_RE, m.nonce)
  && messages.isTimestamp(m.signed_at) && isId(messages.DEVICE_ID_RE, m.device_id);

// The whole kl.question.answer (§3.9): a clear one as sent, a sealed one once opened.
function isWholeAnswer(m) {
  return exactKeys(m, ANSWER_KEYS) && answerClearFields(m)
    && isId(CASE_ID, m.case_id) && isId(QUESTION_ID, m.question_id) && validAnswer(m.answer);
}

// The form verifyDeviceEnvelope checks. A sealed one's content is not read here:
// handleAnswer holds it to isWholeAnswer after the signature, once it is open.
function validateAnswerMessage(m) {
  if (isSealedShape('kl.question.answer', m)) return answerClearFields(m);
  return isWholeAnswer(m);
}

const askClearFields = (m) => isId(messages.NODE_ID_RE, m.node_id) && isId(TOKEN_RE, m.token) && isText(m.kind) && isText(m.urgency)
  && (m.expires_at === null || messages.isTimestamp(m.expires_at));

// kl.question.ask, clear or sealed. The node builds these; a phone checks its own.
function validateAskMessage(m) {
  if (isSealedShape('kl.question.ask', m)) return askClearFields(m) && isDeviceJwk(m.node_box);
  return exactKeys(m, m.node_box === undefined ? ASK_KEYS : [...ASK_KEYS, 'node_box'].sort()) && askClearFields(m) && isId(CASE_ID, m.case_id) && isId(QUESTION_ID, m.question_id)
    && isText(m.case_title) && isText(m.text) && Array.isArray(m.options) && (m.node_box === undefined || isDeviceJwk(m.node_box));
}

for (const [type, validator] of [['kl.question.answer', validateAnswerMessage], ['kl.question.ask', validateAskMessage]]) {
  try {
    messages.registerMessageValidator(type, validator);
  } catch (err) {
    if (!/already has a validator/.test(err.message)) throw err;
  }
}

function linkError(err) {
  const code = err && err.code;
  if (code === 'too_large') return new ContactDeliveryError('too-large', err.message);
  if (code === 'type_not_routed') return new ContactDeliveryError('rejected', err.message);
  return new ContactDeliveryError('unreachable', err && err.message ? err.message : String(err));
}

class MobileAppChannel extends ChannelPlugin {
  // link: F3's RelayClient; approverStore: the admin <configDir>/approvers/ set;
  // identity: this node's identity; getRouter(): the ContactRouter.
  constructor({
    link, approverStore, identity, sealPolicy = null, nonces = new NonceCache({}), getRouter = () => null, presence = null,
    isEnabled = () => true, clock = () => new Date(), log = createLogger('contact/mobile')
  } = {}) {
    super({ id: 'mobile', label: 'King Louie app', capabilities: ['send'] });
    this.link = link;
    this.approverStore = approverStore;
    this.identity = identity;
    this.sealPolicy = sealPolicy;
    this.nonces = nonces;
    this.getRouter = getRouter;
    this.presenceTracker = presence;
    this.isEnabled = isEnabled;
    this.clock = clock;
    this.log = log;
    this.replyHandler = null;
    // deviceId → { foreground, at (ordering key), changedAt (node clock) }.
    this.lastPresence = new Map();
    this.sealBlockedLogged = false;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  devices() {
    return (this.approverStore.list() || [])
      .filter((r) => r && r.platform !== 'demo' && this.approverStore.isActive(r.device_id))
      .map((r) => r.device_id);
  }

  contactCapabilities() {
    if (!this.link || !this.isEnabled() || !this.devices().length) return null;
    return {
      buttons: true, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: true,
      interrupts: true, maxOptions: MAX_OPTIONS, maxChars: MAX_TEXT
    };
  }

  ownerTarget() {
    return this.contactCapabilities() ? 'enrolled-devices' : null;
  }

  // R-SP-5. The capabilities stay as they are: a phone can still answer what it
  // already holds. Only sending stops, and the ladder goes to its next rung.
  contactConfigured() {
    if (!super.contactConfigured()) return false;
    const blocked = this._sealBlocked();
    if (blocked && !this.sealBlockedLogged) this.log.debug('sealing is on and no phone can read it: this rung is skipped');
    this.sealBlockedLogged = blocked;
    return !blocked;
  }

  _sealBlocked() {
    try {
      messages.sealTargets(this.sealPolicy);
      return false;
    } catch {
      return true;
    }
  }

  // The router writes this on the delivery before it sends, so whether an ask
  // went sealed outlives a restart or a crash mid-send. A latch only goes one way,
  // and a policy that cannot answer counts as sealing.
  sealsQuestions() {
    if (!this.sealPolicy) return false;
    try {
      return this.sealPolicy.sealing() === true;
    } catch {
      return true;
    }
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  registerMethods() {
    this.link.registerMethod('question.answer', (params) => this.handleAnswer(params));
    this.link.registerMethod('presence.foreground', (params, ctx) => this.handleForeground(params, ctx));
  }

  // question.submit: one node-signed kl.question.ask per item and active device.
  async sendContact(message, meta = {}) {
    const devices = this.devices();
    if (!this.link || !devices.length) throw new ContactDeliveryError('not-configured', 'no active enrolled phone');
    const can = typeof this.link.canDeliver === 'function' ? this.link.canDeliver() : { ok: true };
    if (can && can.ok === false) throw new ContactDeliveryError('unreachable', can.reason || 'the relay link is down');
    const signer = nodeSigner(this.identity);
    for (const item of message.items || []) {
      const options = item.answerable === false ? [] : (item.options || []).slice(0, MAX_OPTIONS);
      // Read for each message built (R-SP-5), and before anything of it exists.
      const targets = this._askTargets();
      const ask = {
        v: 1,
        type: 'kl.question.ask',
        node_id: this.identity.nodeId,
        case_id: item.caseId,
        question_id: item.questionId,
        token: item.token,
        kind: item.kind,
        urgency: item.urgency,
        case_title: clean(item.caseTitle, MAX_TITLE),
        text: clean(item.text, MAX_TEXT, { newlines: true }),
        options: options.map((o) => ({ id: String(o.id), label: clean(o.label, MAX_LABEL) })),
        expires_at: item.expiresAt || null
      };
      const envelope = seal(targets ? this._sealAsk(ask, targets) : ask, signer);
      for (const device of devices) {
        try {
          await this.link.send(envelope, { push: { kind: 'question', id: item.token }, to_device: device });
        } catch (err) {
          throw linkError(err);
        }
      }
    }
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }

  _askTargets() {
    try {
      return messages.sealTargets(this.sealPolicy);
    } catch {
      this.log.debug('a question was not sent to the phones: sealing is on and no phone can read it');
      throw new ContactDeliveryError('not-configured', 'sealing is on and no phone can read it');
    }
  }

  // Never falls back to the clear ask.
  _sealAsk(ask, targets) {
    try {
      const { clear, content } = splitMessage('kl.question.ask', { ...ask, node_box: targets.nodeBox });
      return sealContent({ type: 'kl.question.ask', senderId: targets.senderId, clear, content, recipients: targets.recipients });
    } catch (err) {
      if (err instanceof SealError) throw new ContactDeliveryError('rejected', 'the question could not be sealed');
      throw err;
    }
  }

  // Call only on a message whose signature verified. → { message } or { reason }.
  _openAnswer(message) {
    if (!this.identity.box) return { reason: 'open_failed' };
    let opened;
    try {
      opened = openSealed({ type: 'kl.question.answer', message, recipientId: this.identity.nodeId, agree: this.identity.box.agree });
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      return { reason: err.reason === 'content_malformed' ? 'malformed' : 'open_failed' };
    }
    return isWholeAnswer(opened.message) ? { message: opened.message } : { reason: 'malformed' };
  }

  // Verified, fresh, single use: { ok, message, deviceId, bytes } or a refusal.
  // The nonce is recorded by the caller once the message is accepted.
  _verify(params, type) {
    const envelope = params && typeof params === 'object' ? params.envelope : undefined;
    const v = verifyDeviceEnvelope(envelope, {
      approverStore: this.approverStore, type, nodeId: this.identity.nodeId, nonces: this.nonces
    });
    if (!v.ok) return v;
    if (!(Math.abs(this.clock().getTime() - Date.parse(v.message.signed_at)) <= SIGNED_AT_SKEW_MS)) return { ok: false, reason: 'stale' };
    return v;
  }

  _refuse(what, reason) {
    this.log.warn(`phone ${what} refused: ${reason}`);
    return { ok: false, error: reason };
  }

  // The link method presence.foreground: { deviceId, foreground, at },
  // unsigned (ruling T17-presence). Registered only on the approvals relay
  // link, whose RelayClient answers only its pinned relay peer; `ctx.peer`
  // is that peer. A ping more than two minutes old, or older than the last
  // applied one, is ignored. This touches only Presence (which rung the
  // ladder tries first), never a question.
  async handleForeground(params, ctx) {
    const refuse = (reason) => {
      this.log.debug(`phone presence refused: ${reason}`);
      return { ok: false, error: reason };
    };
    if (!ctx || !ctx.peer) return refuse('not-linked');
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
    if (!p || typeof p.deviceId !== 'string' || !messages.DEVICE_ID_RE.test(p.deviceId) || typeof p.foreground !== 'boolean') return refuse('malformed');
    const atMs = typeof p.at === 'number' ? p.at : (typeof p.at === 'string' ? Date.parse(p.at) : NaN);
    if (!Number.isFinite(atMs)) return refuse('malformed');
    if (!this.approverStore.get(p.deviceId) || !this.approverStore.isActive(p.deviceId)) return refuse('unknown-device');
    if (!this.presenceTracker) return refuse('not_ready');
    const nowMs = this.clock().getTime();
    // No clamp on `at`: Presence stamps the ping with the node clock, so the
    // phone's time never reaches it.
    if (nowMs - atMs > PRESENCE_MAX_AGE_MS) return { ok: true };
    const last = this.lastPresence.get(p.deviceId);
    // The ordering key is capped at now, so one far-future `at` cannot make
    // every later ping look older and freeze this device's presence.
    const orderAt = Math.min(atMs, nowMs);
    if (last && orderAt < last.at) return { ok: true };
    if (last && last.foreground === p.foreground && nowMs - last.changedAt < PRESENCE_MIN_GAP_MS) return { ok: true };
    const r = this.presenceTracker.mobileForeground({ deviceId: p.deviceId, foreground: p.foreground });
    if (r && r.ok === false) return refuse('not_ready');
    this.lastPresence.set(p.deviceId, { foreground: p.foreground, at: orderAt, changedAt: nowMs });
    return { ok: true };
  }

  // The link method question.answer: { envelope } forwarded by the relay.
  // Only an answer that passes every check here is ownerProven.
  async handleAnswer(params = {}) {
    const v = this._verify(params, 'kl.question.answer');
    if (!v.ok) return this._refuse('answer', v.reason);
    // Signer and device are bound by now. What steers the answer below comes from
    // inside the seal and is held to what the live token names.
    const sealedAnswer = Object.hasOwn(v.message, 'sealed');
    let m = v.message;
    if (sealedAnswer) {
      const opened = this._openAnswer(v.message);
      if (opened.reason) return this._refuse('answer', opened.reason);
      m = opened.message;
    }
    const router = this.getRouter();
    const found = router ? router.state.resolve(m.token, { channel: 'mobile' }) : null;
    if (!found || !found.item || found.delivery.channel !== 'mobile'
      || found.item.caseId !== m.case_id || found.item.questionId !== m.question_id) {
      return this._refuse('answer', 'unknown_question');
    }
    // A clear answer goes only with a clear ask: a phone that read a sealed ask
    // seals its reply, so this is a downgrade or a fault, and its words should
    // not count as if nothing had happened.
    if (!sealedAnswer && found.delivery.sealed === true) return this._refuse('answer', 'sealed_required');
    // Ruling T17-bound, second layer: free text may name no question but its
    // own (the router also treats a bound reply's text as the body only).
    if (m.answer.text !== undefined) {
      for (const hit of m.answer.text.matchAll(new RegExp(TOKEN_IN_TEXT.source, 'g'))) {
        if (hit[1].toUpperCase() !== m.token) return this._refuse('answer', 'malformed');
      }
    }
    if (!this.replyHandler) return this._refuse('answer', 'not_ready');
    this.nonces.add(m.nonce, bytesSha256(v.bytes));
    const answer = m.answer.option_id ? { optionId: m.answer.option_id } : { text: m.answer.text };
    const now = this.clock();
    const at = Math.min(Date.parse(m.signed_at), now.getTime());
    const result = await this.replyHandler(found.item.token, answer, {
      channel: 'mobile', senderId: v.deviceId, chatId: null, at: new Date(at).toISOString(), ownerProven: true, bound: true
    });
    return { ok: Boolean(result && result.ok), outcome: result ? result.outcome : 'unknown', ack: result ? result.ackText : null };
  }
}

module.exports = { MobileAppChannel, validateAnswerMessage, SIGNED_AT_SKEW_MS, PRESENCE_MAX_AGE_MS, PRESENCE_MIN_GAP_MS };
