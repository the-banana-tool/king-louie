const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebhookRegistry extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.webhooks = new Map();
    this.load();
  }

  load() {
    const stored = this.store.get('webhooks', {});
    for (const [id, webhook] of Object.entries(stored)) {
      this.webhooks.set(id, webhook);
    }
  }

  save() {
    const webhooksObj = {};
    for (const [id, webhook] of this.webhooks.entries()) {
      webhooksObj[id] = webhook;
    }
    this.store.set('webhooks', webhooksObj);
  }

  register(config) {
    const webhook = {
      id: this.generateId(),
      secret: config.secret || this.generateSecret(),
      name: config.name || 'Unnamed Webhook',
      enabled: config.enabled !== false,
      route: config.route || { sessionTarget: 'main' },
      rateLimit: config.rateLimit || { maxPerMinute: 60 },
      messageTemplate: config.messageTemplate || 'Webhook received: {{body}}',
      signatureHeader: config.signatureHeader || 'x-hub-signature-256',
      signatureFormat: config.signatureFormat || 'sha256',
      createdAt: new Date().toISOString(),
      ...config
    };

    this.webhooks.set(webhook.id, webhook);
    this.save();
    this.emit('webhook:registered', webhook);
    
    return webhook;
  }

  unregister(id) {
    const webhook = this.webhooks.get(id);
    if (webhook) {
      this.webhooks.delete(id);
      this.save();
      this.emit('webhook:unregistered', webhook);
      return true;
    }
    return false;
  }

  update(id, updates) {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    const updatedWebhook = { ...webhook, ...updates };
    this.webhooks.set(id, updatedWebhook);
    this.save();
    this.emit('webhook:updated', updatedWebhook);
    
    return updatedWebhook;
  }

  get(id) {
    return this.webhooks.get(id);
  }

  list() {
    return Array.from(this.webhooks.values());
  }

  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateSecret() {
    return crypto.randomBytes(32).toString('hex');
  }
}

module.exports = WebhookRegistry;