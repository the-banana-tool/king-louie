// src/channels/telephony-channel.js
// SMS and voice through a telephony relay (cases stage 4 spec §3.3). Two
// instances, ids `sms` and `voice`. Neither answers an approval. Every SMS
// reply must carry a token; the router enforces that (requiresToken).
const crypto = require('crypto');
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');
const { normalizeAddress } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const TOKEN_IN_TEXT = /#([0-9A-Za-z]{6})\b/;

class TelephonyChannel extends ChannelPlugin {
  // getConfig() → { owner, from, maxChars, language }
  constructor({ kind, relay, getConfig = () => ({}), log = null } = {}) {
    if (kind !== 'sms' && kind !== 'voice') throw new Error('TelephonyChannel kind must be sms or voice');
    super({ id: kind, label: kind === 'sms' ? 'SMS' : 'Voice call', capabilities: ['send'] });
    this.kind = kind;
    this.relay = relay;
    this.getConfig = getConfig;
    this.log = log || createLogger(`contact/${kind}`);
    this.replyHandler = null;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return normalizeAddress(this.kind, raw) || '';
  }

  config() {
    const c = this.getConfig() || {};
    return {
      owner: normalizeAddress(this.kind, c.owner),
      from: c.from ? normalizeAddress(this.kind, c.from) : null,
      maxChars: Number.isInteger(c.maxChars) && c.maxChars > 0 ? c.maxChars : 1200,
      language: typeof c.language === 'string' && c.language ? c.language : 'en-US'
    };
  }

  contactCapabilities() {
    if (!this.relay) return null;
    const c = this.config();
    if (this.kind === 'sms') {
      return {
        buttons: false, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: false,
        interrupts: true, maxOptions: 6, maxChars: c.maxChars, idempotentSend: true, requiresToken: true
      };
    }
    return {
      buttons: true, richText: false, attachments: false, voice: true, expectsReplies: true, authenticatedReplies: false,
      interrupts: true, maxOptions: 9, maxChars: 8000, idempotentSend: true
    };
  }

  ownerTarget() {
    return this.relay ? this.config().owner : null;
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  _prompts(items) {
    return items.map((it) => {
      if (!it.answerable) return { n: it.n, say: it.text };
      let say = `Question ${it.n} from ${it.caseTitle}. ${it.text}`;
      const options = (it.options || []).slice(0, 9);
      if (options.length) {
        say += ` ${options.map((o, i) => `Press ${i + 1} for ${o.label}`).join(', ')}.`;
        const digits = {};
        options.forEach((o, i) => { digits[String(i + 1)] = o.id; });
        return { n: it.n, say, gather: { digits } };
      }
      return { n: it.n, say: `${say} Answer this one in King Louie or by text.` };
    });
  }

  async sendContact(message, meta = {}) {
    const c = this.config();
    if (!this.relay || !c.owner) throw new ContactDeliveryError('not-configured', `${this.kind} has no owner number`);
    const correlation = { deliveryId: meta.deliveryId, tokens: (message.items || []).map((i) => i.token), batchToken: meta.batchToken };
    const body = this.kind === 'sms'
      ? { channel: 'sms', to: c.owner, from: c.from, subject: null, text: String(message.text).slice(0, c.maxChars), correlation, expiresAt: meta.expiresAt || null }
      : {
        channel: 'voice', to: c.owner, from: c.from, subject: null, text: message.subject,
        voice: { language: c.language, prompts: this._prompts(message.items || []) }, correlation, expiresAt: meta.expiresAt || null
      };
    const sent = await this.relay.send(body, { idempotencyKey: meta.deliveryId });
    return { deliveryId: meta.deliveryId, externalRef: sent.id, relayId: sent.id };
  }

  // A plain send: the owner number, or a target the outbound gate passed.
  async send(target, text, options = {}) {
    const c = this.config();
    const to = normalizeAddress(this.kind, target);
    if (!to) throw new Error(`${this.kind}: "${target}" is not an E.164 number`);
    if (to !== c.owner && options[GATE_PASSED] !== true) throw new Error(`${this.kind}: refusing to send to ${to}: not the owner and not through the outbound gate`);
    const idempotencyKey = options.deliveryId || `ack-${crypto.randomBytes(8).toString('hex')}`;
    const body = this.kind === 'sms'
      ? { channel: 'sms', to, from: c.from, subject: null, text: String(text).slice(0, c.maxChars), correlation: null }
      : { channel: 'voice', to, from: c.from, subject: null, text: String(text), voice: { language: c.language, prompts: [{ n: 1, say: String(text) }] }, correlation: null };
    const sent = await this.relay.send(body, { idempotencyKey });
    return { ok: true, id: sent.id };
  }

  // A relay `inbound` event (poll or push). Owner proof is the owner number;
  // the router also requires the token for SMS.
  async ingestRelayEvent(ev) {
    if (this.kind !== 'sms' || !this.replyHandler) return null;
    const c = this.config();
    const from = normalizeAddress('sms', ev.from);
    const ownerProven = Boolean(from && c.owner && from === c.owner);
    const text = String(ev.text || '');
    const token = TOKEN_IN_TEXT.exec(text);
    const result = await this.replyHandler(token ? token[1].toUpperCase() : null, { text }, {
      channel: 'sms', senderId: from || String(ev.from || ''), chatId: null, at: ev.at || null, ownerProven
    });
    if (result && result.ackText && ownerProven) {
      try {
        await this.send(c.owner, result.ackText);
      } catch (err) {
        this.log.warn(`sms ack failed: ${err.message}`);
      }
    }
    return result;
  }
}

module.exports = { TelephonyChannel };
