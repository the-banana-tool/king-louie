// tests/helpers/loopback-channel.js
// A contact channel that talks to nobody (cases stage 4 §10). Tests register
// it under any contact id ('telegram', 'email', …), read what was sent, make
// the next send fail or hang, and play replies back through the handler the
// host registered with onContactReply.
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('../../src/channels/channel-plugin');

const DEFAULT_CAPS = Object.freeze({
  buttons: true,
  richText: false,
  attachments: false,
  voice: false,
  expectsReplies: true,
  authenticatedReplies: true,
  interrupts: true,
  maxOptions: 6,
  maxChars: 4000
});

class LoopbackChannel extends ChannelPlugin {
  constructor({ id = 'loopback', owner = 'owner-1', caps = {}, configured = true } = {}) {
    super({ id, label: `Loopback ${id}` });
    this.owner = owner;
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this.configured = configured;
    this.sent = [];
    this.plain = [];
    this.handler = null;
    this.failures = [];
    this.gate = null;
    this.counter = 0;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  contactCapabilities() {
    return this.configured ? { ...this.caps } : null;
  }

  ownerTarget() {
    return this.configured ? this.owner : null;
  }

  onContactReply(handler) {
    this.handler = handler;
  }

  failNext(code, message = `loopback ${code}`) {
    this.failures.push(new ContactDeliveryError(code, message));
  }

  // The next sendContact waits until the returned function is called.
  holdNext() {
    let release;
    this.gate = new Promise((resolve) => { release = resolve; });
    return () => release();
  }

  async sendContact(message, meta = {}) {
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    if (this.failures.length) throw this.failures.shift();
    this.counter += 1;
    const externalRef = `${this.id}-msg-${this.counter}`;
    this.sent.push({ message, meta, externalRef });
    return { deliveryId: meta.deliveryId, externalRef };
  }

  async send(target, text, options = {}) {
    if (target !== this.owner && options[GATE_PASSED] !== true) throw new Error('refused: not the owner and not gated');
    this.plain.push({ target, text });
    return { ok: true };
  }

  // Plays a reply. Like a real adapter, it acks only its owner target and
  // only when the router returns ack text for an owner-proven reply.
  async reply(correlationId, answer, meta = {}) {
    if (!this.handler) throw new Error('no reply handler registered');
    const full = { channel: this.id, senderId: this.owner, chatId: this.owner, at: new Date().toISOString(), ownerProven: true, ...meta };
    const result = await this.handler(correlationId, answer, full);
    if (result && result.ackText && full.ownerProven) await this.send(this.owner, result.ackText);
    return result;
  }

  last() {
    return this.sent[this.sent.length - 1] || null;
  }
}

module.exports = { LoopbackChannel, DEFAULT_CAPS };
