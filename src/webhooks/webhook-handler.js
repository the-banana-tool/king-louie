const crypto = require('crypto');

class WebhookHandler {
  constructor(registry, sessionManager, agentExecutor) {
    this.registry = registry;
    this.sessionManager = sessionManager;
    this.agentExecutor = agentExecutor;
    this.rateLimitMap = new Map(); // webhookId -> { count, windowStart }
    this.MAX_BODY_SIZE = 1024 * 1024; // 1MB
  }

  async handle(webhookId, request) {
    const webhook = this.registry.get(webhookId);
    if (!webhook) {
      throw new Error(`Webhook not found: ${webhookId}`);
    }

    if (!webhook.enabled) {
      throw new Error(`Webhook disabled: ${webhookId}`);
    }

    // Check body size
    const bodySize = Buffer.byteLength(request.body || '', 'utf8');
    if (bodySize > this.MAX_BODY_SIZE) {
      throw new Error(`Request body too large: ${(bodySize / 1024 / 1024).toFixed(1)}MB. Max: 1MB`);
    }

    // Verify HMAC signature if configured
    const sigHeader = webhook.signatureHeader || 'x-hub-signature-256';
    if (webhook.secret && request.headers) {
      const signature = request.headers[sigHeader] || request.headers[sigHeader.toLowerCase()];
      if (!this.verifySignature(request.body, signature, webhook.secret, webhook.signatureFormat)) {
        throw new Error('Invalid signature');
      }
    }

    // Check rate limit
    if (!this.checkRateLimit(webhook)) {
      throw new Error('Rate limit exceeded');
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(request.body || '{}');
    } catch (err) {
      throw new Error(`Invalid JSON payload: ${err.message}`);
    }

    // Template the message
    const message = this.templateMessage(webhook.messageTemplate, payload);

    // Route to agent session
    await this.routeToAgent(webhook, message, payload);

    return { ok: true, message: 'Webhook processed successfully' };
  }

  verifySignature(body, signature, secret, format = 'sha256') {
    if (!signature || !secret) return false;

    try {
      // Handle different signature formats
      let expectedSig;
      if (format === 'sha256' && signature.startsWith('sha256=')) {
        // GitHub format: sha256=<hex>
        expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      } else if (format === 'sha1' && signature.startsWith('sha1=')) {
        // GitHub legacy format: sha1=<hex>
        expectedSig = 'sha1=' + crypto.createHmac('sha1', secret).update(body, 'utf8').digest('hex');
      } else if (format === 'raw') {
        // Slack format: just the hex
        expectedSig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      } else {
        // Default: assume sha256 with prefix
        expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      }

      return crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(expectedSig, 'utf8')
      );
    } catch (err) {
      console.error('[webhook-handler] Signature verification error:', err.message);
      return false;
    }
  }

  checkRateLimit(webhook) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window
    const maxRequests = webhook.rateLimit?.maxPerMinute || 60;

    const key = webhook.id;
    const current = this.rateLimitMap.get(key);

    if (!current || (now - current.windowStart) > windowMs) {
      // New window
      this.rateLimitMap.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (current.count >= maxRequests) {
      return false; // Rate limit exceeded
    }

    current.count++;
    return true;
  }

  templateMessage(template, payload) {
    if (!template) return JSON.stringify(payload);

    // Simple template replacement: {{key.subkey}} -> payload.key.subkey
    return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      try {
        const value = this.getNestedValue(payload, path.trim());
        return value !== undefined ? String(value) : match;
      } catch {
        return match;
      }
    });
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  async routeToAgent(webhook, message, payload) {
    const route = webhook.route || { sessionTarget: 'main' };
    
    // Determine session key
    let sessionKey;
    if (route.sessionTarget === 'main') {
      sessionKey = 'agent:main:webhook';
    } else if (route.sessionTarget === 'dedicated') {
      sessionKey = `agent:webhook:${webhook.id}`;
    } else if (route.sessionKey) {
      sessionKey = route.sessionKey;
    } else {
      sessionKey = 'agent:main:webhook';
    }

    // Get or create session
    let session = this.sessionManager.get(sessionKey);
    if (!session) {
      session = this.sessionManager.create(sessionKey, {
        agentId: route.agentId || 'main-assistant',
        metadata: { type: 'webhook', webhookId: webhook.id }
      });
    }

    // Add the webhook message to the session
    session.addMessage({
      role: 'user',
      content: message,
      metadata: {
        source: 'webhook',
        webhookId: webhook.id,
        webhookName: webhook.name,
        payload: route.includePayload ? payload : undefined,
        timestamp: new Date().toISOString()
      }
    });

    // Execute agent if auto-execute is enabled (default true)
    if (route.autoExecute !== false) {
      try {
        await this.agentExecutor.execute(route.agentId || 'main-assistant', sessionKey, {
          background: true,
          source: 'webhook'
        });
      } catch (err) {
        console.error(`[webhook-handler] Agent execution failed for webhook ${webhook.id}:`, err.message);
        // Don't throw - webhook was received successfully even if agent failed
      }
    }
  }
}

module.exports = WebhookHandler;