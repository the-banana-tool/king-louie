const { createLogger } = require('../logging');
const log = createLogger('channel');

// Cases stage 4 (docs/superpowers/specs/2026-09-23-cases-stage4-channels.md §3.1).
// A contact send fails with exactly one of these codes, never a partial result.
const CONTACT_ERROR_CODES = Object.freeze(['not-configured', 'rejected', 'unreachable', 'too-large', 'rate-limited']);

class ContactDeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ContactDeliveryError';
    this.code = CONTACT_ERROR_CODES.includes(code) ? code : 'unreachable';
  }
}

class ContactUnsupportedError extends ContactDeliveryError {
  constructor(channelId) {
    super('not-configured', `${channelId || 'this channel'} is not a contact channel`);
    this.name = 'ContactUnsupportedError';
  }
}

// Set in a plain send()'s options only by src/cases/contact.js after the
// outbound gate passed (sendExternal). The contact adapters refuse a
// non-owner target without it.
const GATE_PASSED = Symbol('kl.contact.gatePassed');

class ChannelPlugin {
  constructor(config = {}) {
    this.id = config.id;
    this.label = config.label || config.id || 'Channel';
    this.capabilities = Array.isArray(config.capabilities)
      ? config.capabilities
      : ['send', 'receive'];
  }

  async initialize(_gateway) {
    throw new Error('initialize must be implemented by channel plugin');
  }

  async shutdown() {
    throw new Error('shutdown must be implemented by channel plugin');
  }

  normalizeTarget(rawTarget) {
    throw new Error('normalizeTarget must be implemented by channel plugin');
  }

  async send(_target, _message, _options = {}) {
    throw new Error('send must be implemented by channel plugin');
  }

  async onMessage(_handler) {}

  async listTargets() {
    return [];
  }

  getStatus() {
    return { connected: false };
  }

  supportsGroups() {
    return false;
  }

  async listGroups() {
    return [];
  }

  getMentionPattern() {
    return null;
  }

  // ---- Contact extension (stage 4 §3.1). The defaults make a plugin inert. ----

  // null: not a contact channel. Otherwise { buttons, richText, attachments,
  // voice, expectsReplies, authenticatedReplies, interrupts, maxOptions,
  // maxChars } plus the optional idempotentSend, requiresToken, deliveryOnly.
  contactCapabilities() {
    return null;
  }

  async sendContact(_message, _meta) {
    throw new ContactUnsupportedError(this.id);
  }

  // handler(correlationId, answer, meta) → Promise<{ ok, outcome, ackText }>
  onContactReply(_handler) {}

  // Delivery status learned later (an email DSN): handler({ externalRef, status, error }).
  onContactStatus(_handler) {}

  presence() {
    return null;
  }

  // The private chat, DM or address of the owner; null when not configured.
  ownerTarget() {
    return null;
  }

  // Whether the ladder may use this channel right now.
  contactConfigured() {
    const caps = this.contactCapabilities();
    if (!caps) return false;
    return caps.deliveryOnly === true || Boolean(this.ownerTarget());
  }
}

class ChannelRegistry {
  constructor() {
    this.channels = new Map();
  }

  register(channelPlugin) {
    if (!channelPlugin || !channelPlugin.id) {
      throw new Error('channelPlugin with a valid id is required');
    }
    this.channels.set(channelPlugin.id, channelPlugin);
  }

  get(id) {
    return this.channels.get(id);
  }

  unregister(id) {
    return this.channels.delete(id);
  }

  list() {
    return Array.from(this.channels.values());
  }

  async initializeAll(gateway) {
    for (const channel of this.channels.values()) {
      try {
        await channel.initialize(gateway);
      } catch (err) {
        log.child(channel.id).error(`init failed: ${err.message}`);
      }
    }
  }

  async shutdownAll() {
    for (const channel of this.channels.values()) {
      try {
        await channel.shutdown();
      } catch (err) {
        log.child(channel.id).error(`shutdown failed: ${err.message}`);
      }
    }
  }
}

const IN_APP_CAPABILITIES = Object.freeze({
  buttons: true,
  richText: false,
  attachments: false,
  voice: false,
  expectsReplies: true,
  authenticatedReplies: true,
  interrupts: false,
  maxOptions: 6,
  maxChars: 20000
});

// Also the in-app contact channel (contact id `in-app`). Stage 2 already shows
// a new question in the window; sendContact only re-surfaces items after the
// owner comes back to the desktop (§3.1). Answers arrive through
// case:answerQuestion, never through this plugin.
class DesktopChannelPlugin extends ChannelPlugin {
  constructor({ sendToUi, uiToast = null, isFocused = null } = {}) {
    super({
      id: 'desktop',
      label: 'Desktop App',
      capabilities: ['send', 'receive']
    });
    this.sendToUi = typeof sendToUi === 'function' ? sendToUi : null;
    this.uiToast = uiToast && typeof uiToast.send === 'function' ? uiToast : null;
    this.isFocused = typeof isFocused === 'function' ? isFocused : () => false;
  }

  async initialize() {}

  async shutdown() {}

  normalizeTarget(rawTarget = '') {
    return String(rawTarget || '').trim();
  }

  async send(target, message, options = {}) {
    if (this.sendToUi) {
      this.sendToUi('channel:message', {
        channel: 'desktop',
        target,
        message,
        media: options.media,
        buttons: options.buttons
      });
    }

    return { status: 'sent' };
  }

  contactCapabilities() {
    return this.sendToUi ? { ...IN_APP_CAPABILITIES } : null;
  }

  ownerTarget() {
    return this.sendToUi ? 'window' : null;
  }

  async sendContact(message, meta = {}) {
    if (!this.sendToUi) throw new ContactDeliveryError('not-configured', 'no interactive window');
    for (const item of message.items || []) {
      this.sendToUi('case:changed', { caseId: item.caseId, what: 'questions', questionId: item.questionId, attention: 'banner' });
    }
    if (this.uiToast && !this.isFocused()) {
      try {
        await this.uiToast.send({ title: message.subject, body: 'Open King Louie to answer' });
      } catch (err) {
        log.child('desktop').warn(`contact toast failed: ${err.message}`);
      }
    }
    return { deliveryId: meta.deliveryId || null, externalRef: null };
  }
}

module.exports = {
  ChannelPlugin,
  ChannelRegistry,
  DesktopChannelPlugin,
  ContactDeliveryError,
  ContactUnsupportedError,
  CONTACT_ERROR_CODES,
  GATE_PASSED
};
