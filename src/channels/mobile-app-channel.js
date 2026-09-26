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
const { ChannelPlugin, ContactDeliveryError } = require('./channel-plugin');
const { seal, nodeSigner } = require('../approvals/envelope');
const { verifyDeviceEnvelope, NonceCache, bytesSha256 } = require('../approvals/verify-device');
const messages = require('../approvals/messages');
const { TOKEN_RE } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const SIGNED_AT_SKEW_MS = 300 * 1000;
const QUESTION_ID = /^q-\d{4,}$/;
const CASE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const OPTION_ID = /^[a-z0-9-]{1,16}$/;
const ANSWER_KEYS = ['answer', 'case_id', 'device_id', 'node_id', 'nonce', 'question_id', 'signed_at', 'token', 'type', 'v'];
// Presence pings (ruling T17-presence): older than this are ignored; one
// state change per device per PRESENCE_MIN_GAP_MS, extra pings dropped.
const PRESENCE_MAX_AGE_MS = 2 * 60 * 1000;
const PRESENCE_MIN_GAP_MS = 5 * 1000;
// Bounds on the node-signed question (code points).
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_LABEL = 200;
const MAX_OPTIONS = 6;

// approval-v1 §5's hidden code points (Cc, Zl/Zp, Bidi_Control,
// Default_Ignorable_Code_Point as of Unicode 15.1), the list F3's
// Display.escape uses on both phones. The node applies the same escape to
// what it signs, so the payload is clean before the phone escapes it again.
function isHidden(cp) {
  return cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
    || cp === 0x2028 || cp === 0x2029
    || cp === 0x061c || (cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
    || cp === 0x00ad || cp === 0x034f || (cp >= 0x115f && cp <= 0x1160) || (cp >= 0x17b4 && cp <= 0x17b5)
    || (cp >= 0x180b && cp <= 0x180f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x206f)
    || cp === 0x3164 || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || cp === 0xffa0
    || (cp >= 0xfff0 && cp <= 0xfff8) || (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a)
    || (cp >= 0xe0000 && cp <= 0xe0fff);
}

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

// The kl.question.answer shape (§3.9), checked by verifyDeviceEnvelope.
function validateAnswerMessage(m) {
  return exactKeys(m, ANSWER_KEYS)
    && messages.NODE_ID_RE.test(m.node_id) && CASE_ID.test(String(m.case_id)) && QUESTION_ID.test(String(m.question_id))
    && TOKEN_RE.test(String(m.token)) && validAnswer(m.answer) && messages.NONCE_RE.test(m.nonce)
    && messages.isTimestamp(m.signed_at) && messages.DEVICE_ID_RE.test(m.device_id);
}

try {
  messages.registerMessageValidator('kl.question.answer', validateAnswerMessage);
} catch (err) {
  if (!/already has a validator/.test(err.message)) throw err;
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
    link, approverStore, identity, nonces = new NonceCache({}), getRouter = () => null, presence = null,
    isEnabled = () => true, clock = () => new Date(), log = createLogger('contact/mobile')
  } = {}) {
    super({ id: 'mobile', label: 'King Louie app', capabilities: ['send'] });
    this.link = link;
    this.approverStore = approverStore;
    this.identity = identity;
    this.nonces = nonces;
    this.getRouter = getRouter;
    this.presenceTracker = presence;
    this.isEnabled = isEnabled;
    this.clock = clock;
    this.log = log;
    this.replyHandler = null;
    this.lastPresenceChange = new Map();
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
      const envelope = seal({
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
      }, signer);
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
  // is that peer. A future `at` is clamped to now; one more than two minutes
  // old is ignored. Presence itself is stamped with the node clock. This
  // touches only Presence (which rung the ladder tries first), never a
  // question.
  async handleForeground(params, ctx) {
    const refuse = (reason) => {
      this.log.debug(`phone presence refused: ${reason}`);
      return { ok: false, error: reason };
    };
    if (!ctx || !ctx.peer) return refuse('not-linked');
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
    if (!p || typeof p.deviceId !== 'string' || !messages.DEVICE_ID_RE.test(p.deviceId)) return refuse('malformed');
    const atMs = typeof p.at === 'number' ? p.at : (typeof p.at === 'string' ? Date.parse(p.at) : NaN);
    if (!Number.isFinite(atMs)) return refuse('malformed');
    if (!this.approverStore.get(p.deviceId) || !this.approverStore.isActive(p.deviceId)) return refuse('unknown-device');
    if (!this.presenceTracker) return refuse('not_ready');
    const nowMs = this.clock().getTime();
    const at = Math.min(atMs, nowMs);
    if (nowMs - at > PRESENCE_MAX_AGE_MS) return { ok: true };
    const last = this.lastPresenceChange.get(p.deviceId);
    if (last !== undefined && nowMs - last < PRESENCE_MIN_GAP_MS) return { ok: true };
    const r = this.presenceTracker.mobileForeground({ deviceId: p.deviceId, foreground: p.foreground === true });
    if (r && r.ok === false) return refuse('not_ready');
    this.lastPresenceChange.set(p.deviceId, nowMs);
    return { ok: true };
  }

  // The link method question.answer: { envelope } forwarded by the relay.
  // Only an answer that passes every check here is ownerProven.
  async handleAnswer(params = {}) {
    const v = this._verify(params, 'kl.question.answer');
    if (!v.ok) return this._refuse('answer', v.reason);
    const m = v.message;
    const router = this.getRouter();
    const found = router ? router.state.resolve(m.token, { channel: 'mobile' }) : null;
    if (!found || !found.item || found.delivery.channel !== 'mobile'
      || found.item.caseId !== m.case_id || found.item.questionId !== m.question_id) {
      return this._refuse('answer', 'unknown_question');
    }
    if (!this.replyHandler) return this._refuse('answer', 'not_ready');
    this.nonces.add(m.nonce, bytesSha256(v.bytes));
    const answer = m.answer.option_id ? { optionId: m.answer.option_id } : { text: m.answer.text };
    const now = this.clock();
    const at = Math.min(Date.parse(m.signed_at), now.getTime());
    const result = await this.replyHandler(found.item.token, answer, {
      channel: 'mobile', senderId: v.deviceId, chatId: null, at: new Date(at).toISOString(), ownerProven: true
    });
    return { ok: Boolean(result && result.ok), outcome: result ? result.outcome : 'unknown', ack: result ? result.ackText : null };
  }
}

module.exports = { MobileAppChannel, validateAnswerMessage, SIGNED_AT_SKEW_MS, PRESENCE_MAX_AGE_MS, PRESENCE_MIN_GAP_MS };
