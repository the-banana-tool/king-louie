const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Import the classes we're testing
const WebhookRegistry = require('../src/webhooks/webhook-registry');
const WebhookHandler = require('../src/webhooks/webhook-handler');

describe('WebhookRegistry', () => {
  let mockStore, registry;

  beforeEach(() => {
    mockStore = {
      data: {},
      get(key, defaultValue) {
        return this.data[key] !== undefined ? this.data[key] : defaultValue;
      },
      set(key, value) {
        this.data[key] = value;
      }
    };
    registry = new WebhookRegistry(mockStore);
  });

  it('registers and retrieves webhooks', () => {
    const webhook = registry.register({ name: 'GitHub Push', route: { sessionTarget: 'main' } });
    assert.ok(webhook.id);
    assert.ok(webhook.secret);
    assert.strictEqual(registry.get(webhook.id).name, 'GitHub Push');
  });

  it('auto-generates secret on registration', () => {
    const webhook = registry.register({ name: 'Test' });
    assert.ok(webhook.secret.length >= 32);
  });

  it('unregisters webhooks', () => {
    const webhook = registry.register({ name: 'Test' });
    registry.unregister(webhook.id);
    assert.strictEqual(registry.get(webhook.id), undefined);
  });

  it('updates webhook configuration', () => {
    const webhook = registry.register({ name: 'Test', enabled: true });
    const updated = registry.update(webhook.id, { enabled: false, name: 'Updated Test' });
    assert.strictEqual(updated.enabled, false);
    assert.strictEqual(updated.name, 'Updated Test');
  });

  it('lists all webhooks', () => {
    registry.register({ name: 'Webhook 1' });
    registry.register({ name: 'Webhook 2' });
    const list = registry.list();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some(w => w.name === 'Webhook 1'));
    assert.ok(list.some(w => w.name === 'Webhook 2'));
  });

  it('persists webhooks to store', () => {
    const webhook = registry.register({ name: 'Persistent Test' });
    
    // Create a new registry with the same store
    const registry2 = new WebhookRegistry(mockStore);
    const retrieved = registry2.get(webhook.id);
    
    assert.ok(retrieved);
    assert.strictEqual(retrieved.name, 'Persistent Test');
  });

  it('generates unique IDs', () => {
    const webhook1 = registry.register({ name: 'Test 1' });
    const webhook2 = registry.register({ name: 'Test 2' });
    assert.notStrictEqual(webhook1.id, webhook2.id);
  });

  it('generates unique secrets', () => {
    const secret1 = registry.generateSecret();
    const secret2 = registry.generateSecret();
    assert.notStrictEqual(secret1, secret2);
    assert.ok(secret1.length >= 32);
    assert.ok(secret2.length >= 32);
  });
});

describe('WebhookHandler', () => {
  let mockRegistry, mockSessionManager, mockAgentExecutor, handler;

  beforeEach(() => {
    mockRegistry = {
      webhooks: new Map(),
      get(id) { return this.webhooks.get(id); },
      register(config) {
        const webhook = { id: 'test-id', secret: 'test-secret', ...config };
        this.webhooks.set(webhook.id, webhook);
        return webhook;
      }
    };

    mockSessionManager = {
      sessions: new Map(),
      get(key) { return this.sessions.get(key); },
      create(key, config) {
        const session = { 
          key, 
          ...config, 
          messages: [],
          addMessage(msg) { this.messages.push(msg); }
        };
        this.sessions.set(key, session);
        return session;
      }
    };

    mockAgentExecutor = {
      executions: [],
      async execute(agentId, sessionKey, options) {
        this.executions.push({ agentId, sessionKey, options });
        return { ok: true };
      }
    };

    handler = new WebhookHandler(mockRegistry, mockSessionManager, mockAgentExecutor);
  });

  it('validates HMAC signature (GitHub format)', () => {
    const body = '{"test": true}';
    const secret = 'mysecret';
    const crypto = require('crypto');
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    
    assert.ok(handler.verifySignature(body, signature, secret));
  });

  it('rejects invalid signature', () => {
    assert.ok(!handler.verifySignature('body', 'sha256=invalid', 'secret'));
  });

  it('handles different signature formats', () => {
    const body = '{"test": true}';
    const secret = 'mysecret';
    const crypto = require('crypto');

    // GitHub SHA256 format
    const sha256Sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.ok(handler.verifySignature(body, sha256Sig, secret, 'sha256'));

    // GitHub SHA1 format  
    const sha1Sig = 'sha1=' + crypto.createHmac('sha1', secret).update(body).digest('hex');
    assert.ok(handler.verifySignature(body, sha1Sig, secret, 'sha1'));

    // Raw format (just hex)
    const rawSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.ok(handler.verifySignature(body, rawSig, secret, 'raw'));
  });

  it('enforces rate limits', async () => {
    const webhook = { id: 'test', rateLimit: { maxPerMinute: 2 } };
    
    assert.ok(handler.checkRateLimit(webhook));
    assert.ok(handler.checkRateLimit(webhook));
    assert.ok(!handler.checkRateLimit(webhook));  // 3rd call within minute rejected
  });

  it('rejects oversized bodies', async () => {
    mockRegistry.register({ 
      id: 'test', 
      name: 'Test', 
      enabled: true,
      secret: 'secret'
    });

    const bigBody = 'x'.repeat(2 * 1024 * 1024);  // 2MB
    const request = { body: bigBody, headers: {} };

    await assert.rejects(
      () => handler.handle('test', request), 
      /too large/i
    );
  });

  it('templates message from payload', () => {
    const template = 'Push to {{repository.name}} by {{pusher.name}}';
    const payload = { repository: { name: 'king-louie' }, pusher: { name: 'dev' } };
    const msg = handler.templateMessage(template, payload);
    assert.strictEqual(msg, 'Push to king-louie by dev');
  });

  it('handles nested template paths', () => {
    const template = 'Issue #{{issue.number}}: {{issue.title}} ({{issue.user.login}})';
    const payload = { 
      issue: { 
        number: 42, 
        title: 'Bug fix',
        user: { login: 'developer' }
      }
    };
    const msg = handler.templateMessage(template, payload);
    assert.strictEqual(msg, 'Issue #42: Bug fix (developer)');
  });

  it('handles missing template values gracefully', () => {
    const template = 'Push to {{repository.name}} by {{nonexistent.field}}';
    const payload = { repository: { name: 'king-louie' } };
    const msg = handler.templateMessage(template, payload);
    assert.strictEqual(msg, 'Push to king-louie by {{nonexistent.field}}');
  });

  it('processes valid webhook request successfully', async () => {
    const webhook = mockRegistry.register({
      id: 'test',
      name: 'Test Webhook',
      enabled: true,
      secret: 'test-secret',
      messageTemplate: 'Received: {{action}}',
      route: { sessionTarget: 'main', agentId: 'main-assistant' }
    });

    const body = '{"action": "push", "repository": {"name": "test-repo"}}';
    const crypto = require('crypto');
    const signature = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');

    const request = {
      body,
      headers: { 'x-hub-signature-256': signature },
      method: 'POST'
    };

    const result = await handler.handle('test', request);
    
    assert.ok(result.ok);
    assert.strictEqual(result.message, 'Webhook processed successfully');
    
    // Verify session was created and message added
    const session = mockSessionManager.get('agent:main:webhook');
    assert.ok(session);
    assert.strictEqual(session.messages.length, 1);
    assert.strictEqual(session.messages[0].content, 'Received: push');
    
    // Verify agent was executed
    assert.strictEqual(mockAgentExecutor.executions.length, 1);
    assert.strictEqual(mockAgentExecutor.executions[0].agentId, 'main-assistant');
  });

  it('rejects disabled webhooks', async () => {
    mockRegistry.register({
      id: 'disabled',
      name: 'Disabled Webhook',
      enabled: false
    });

    const request = { body: '{}', headers: {} };
    
    await assert.rejects(
      () => handler.handle('disabled', request),
      /disabled/i
    );
  });

  it('rejects requests to non-existent webhooks', async () => {
    const request = { body: '{}', headers: {} };
    
    await assert.rejects(
      () => handler.handle('nonexistent', request),
      /not found/i
    );
  });

  it('handles invalid JSON gracefully', async () => {
    mockRegistry.register({
      id: 'test',
      name: 'Test',
      enabled: true,
      secret: null
    });

    const request = { body: 'invalid json{', headers: {} };
    
    await assert.rejects(
      () => handler.handle('test', request),
      /Invalid JSON/i
    );
  });

  it('routes to different session targets', async () => {
    const webhook = mockRegistry.register({
      id: 'dedicated',
      name: 'Dedicated Webhook',
      enabled: true,
      secret: null,
      route: { sessionTarget: 'dedicated' }
    });

    const request = { body: '{"test": true}', headers: {} };
    await handler.handle('dedicated', request);

    // Should create a dedicated session
    const session = mockSessionManager.get('agent:webhook:dedicated');
    assert.ok(session);
  });

  it('skips agent execution when autoExecute is false', async () => {
    mockRegistry.register({
      id: 'no-exec',
      name: 'No Execute',
      enabled: true,
      secret: null,
      route: { sessionTarget: 'main', autoExecute: false }
    });

    const request = { body: '{"test": true}', headers: {} };
    await handler.handle('no-exec', request);

    // Agent should not have been executed
    assert.strictEqual(mockAgentExecutor.executions.length, 0);
  });
});