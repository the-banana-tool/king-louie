// src/channels/ntfy-contact.js
// ntfy as a delivery-only contact channel (cases stage 4 spec §3.1). It wraps
// NtfyChannel, keeping its private-network guard. A topic is readable by
// anyone who knows its name, so the question text goes out only when
// channels.ntfy.includeText is true, and ntfy is never an owner target.
const NtfyChannel = require('../notifications/channels/ntfy-channel');
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');

const NO_TEXT = 'Open King Louie to answer.';

class NtfyContact extends ChannelPlugin {
  // getConfig() → { baseUrl, topic, includeText }
  constructor({ getConfig = () => ({}), publisher = null } = {}) {
    super({ id: 'ntfy', label: 'ntfy', capabilities: ['send'] });
    this.getConfig = getConfig;
    this.publisher = publisher;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(raw = '') {
    return String(raw || '').trim();
  }

  _publisher() {
    if (this.publisher) return this.publisher;
    const c = this.getConfig() || {};
    return new NtfyChannel(c.baseUrl ? { baseUrl: c.baseUrl } : {});
  }

  _topic() {
    return String((this.getConfig() || {}).topic || '').trim();
  }

  contactCapabilities() {
    if (!this._topic()) return null;
    return {
      buttons: false, richText: false, attachments: false, voice: false, expectsReplies: false, authenticatedReplies: false,
      interrupts: true, maxOptions: 0, maxChars: 4000, deliveryOnly: true
    };
  }

  ownerTarget() {
    return null;
  }

  async sendContact(message, meta = {}) {
    const topic = this._topic();
    if (!topic) throw new ContactDeliveryError('not-configured', 'contact.ntfy.topic is not set');
    const includeText = (this.getConfig() || {}).includeText === true;
    let out;
    try {
      out = await this._publisher().send({ topic, title: message.subject, body: includeText ? message.text : NO_TEXT });
    } catch (err) {
      throw new ContactDeliveryError('unreachable', err.message);
    }
    if (!out || out.ok !== true) throw new ContactDeliveryError('not-configured', out?.reason || 'ntfy did not publish');
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }

  // ntfy has no owner target: a plain send needs the outbound gate.
  async send(target, text, options = {}) {
    if (options[GATE_PASSED] !== true) throw new Error('ntfy: refusing to publish without the outbound gate');
    const topic = String(target || '').trim() || this._topic();
    return this._publisher().send({ topic, title: 'King Louie', body: String(text) });
  }
}

module.exports = { NtfyContact, NO_TEXT };
