// tests/contact-host.test.js — cases stage 4 §7 (wiring) and the relay push route.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { createContactHost } = require('../src/cases/contact-host');
const { ChannelRegistry } = require('../src/channels/channel-plugin');
const { mergeSettings } = require('../src/core/settings');
const WebhookServer = require('../src/webhooks/webhook-server');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const CONTACT = {
  telegram: { ownerUserId: '123456789' },
  sms: { owner: '+15550100', from: '+15550199', relay: 'main' },
  voice: { owner: '+15550100', from: '+15550199', relay: 'main' },
  email: { owner: 'owner@example.com', from: 'kl@example.com', relay: 'main' },
  ntfy: { baseUrl: 'https://ntfy.example.com', topic: 'kl-topic' },
  relays: { main: { baseUrl: 'https://relay.example.com', pollSec: 30 } }
};

class FakeBridge extends LoopbackChannel {
  setContactHost(host) {
    this.host = host;
  }

  contactCapabilities() {
    return this.ownerTarget() ? { ...this.caps } : null;
  }

  ownerTarget() {
    return this.host && this.host.isEnabled() ? this.host.getOwnerUserId() || null : null;
  }
}

function makeHost({ interactive = true, isService = false, contactConfig = null, settings = {}, features = { channels: true }, webhook = null, extraAdapters = {} } = {}) {
  let stored = mergeSettings(settings);
  const events = [];
  const runtime = new CaseRuntime({ root: path.join(tmp('kl-host-cases-'), 'cases'), host: { interactive: () => (typeof interactive === 'function' ? interactive() : interactive), notify: (e, p) => events.push([e, p]) } });
  const registry = new ChannelRegistry();
  const telegram = new FakeBridge({ id: 'telegram' });
  const vault = new Map([['contact.relay.main.token', 'relay-token'], ['contact.relay.main.webhookSecret', 'push-secret']]);
  const hostOpts = {
    getSettings: () => stored,
    setSettings: (s) => { stored = mergeSettings(s); },
    contactConfig,
    isService,
    caseRuntime: runtime,
    channelRegistry: registry,
    vault: { get: (k) => vault.get(k) || null },
    dataDir: tmp('kl-host-data-'),
    features,
    getBridges: () => ({ telegram, discord: null }),
    getWebhookServer: () => webhook,
    tickMs: 60000,
    fetchImpl: async () => { throw new Error('offline in tests'); },
    extraAdapters
  };
  if (!isService) delete hostOpts.contactConfig;
  const host = createContactHost(hostOpts);
  return { host, runtime, registry, telegram, events, settings: () => stored };
}

const desktopSettings = {
  contact: { ...CONTACT, telegram: undefined },
  channels: {
    telegram: { contactEnabled: true, contactOwnerUserId: '111' },
    sms: { enabled: true }, voice: { enabled: true }, email: { enabled: true, transport: 'relay' }, ntfy: { enabled: true }
  }
};

describe('createContactHost', () => {
  it('builds the enabled adapters, registers them, attaches the bridges and serves getContact()', async () => {
    const t = makeHost({ settings: desktopSettings });
    try {
      await t.host.start();
      assert.deepStrictEqual(t.registry.list().map((c) => c.id).sort(), ['email', 'ntfy', 'sms', 'voice']);
      assert.strictEqual(t.host.adapters.get('telegram'), t.telegram);
      assert.strictEqual(t.telegram.ownerTarget(), '111', 'desktop: the owner id comes from channels.telegram.contactOwnerUserId');
      assert.ok(t.host.adapters.get('in-app'), 'in-app exists with an interactive host');
      const ctx = t.host.context();
      assert.ok(ctx.ladder && ctx.presence && ctx.router);
      const statuses = ctx.getPolicy().channels;
      assert.deepStrictEqual(statuses.telegram, { enabled: true, configured: true });
      assert.deepStrictEqual(statuses.sms, { enabled: true, configured: true });
      assert.deepStrictEqual(statuses.discord, { enabled: false, configured: false, reason: 'not enabled in this host' });
      assert.strictEqual(statuses.slack, undefined);
      assert.deepStrictEqual(ctx.heartbeat({ focused: true, lastInputAt: new Date().toISOString() }), { ok: true });
      assert.strictEqual(ctx.presenceStatus().presentChannel, 'in-app');
      assert.deepStrictEqual(ctx.presenceStatus().ladder, { runsHere: false, message: 'no cases yet' });
      assert.deepStrictEqual(ctx.ladderState(), {});
    } finally {
      await t.host.stop();
    }
  });

  it('setPolicy validates and saves settings.contactPolicy', async () => {
    const t = makeHost({ settings: desktopSettings });
    const ctx = t.host.context();
    assert.deepStrictEqual(ctx.setPolicy({ ladders: { normal: [{ channel: 'slack' }] } }), { ok: false, error: 'slack is not a contact channel: it has no sender allowlist' });
    const r = ctx.setPolicy({ batchDelaySec: 30 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(t.settings().contactPolicy.batchDelaySec, 30);
    assert.strictEqual(ctx.getPolicy().policy.batchDelaySec, 30);
  });

  it('service mode: the owner comes from the admin contactConfig only; no in-app without an interactive host', async () => {
    const t = makeHost({
      isService: true,
      interactive: false,
      contactConfig: { telegram: { ownerUserId: '123456789' } },
      settings: { contact: { telegram: { ownerUserId: '999' } }, channels: { telegram: { contactEnabled: true, contactOwnerUserId: '999' } } }
    });
    try {
      await t.host.start();
      assert.strictEqual(t.telegram.ownerTarget(), '123456789');
      assert.strictEqual(t.host.adapters.get('in-app'), null);
      assert.deepStrictEqual(t.registry.list(), [], 'nothing else is configured');
    } finally {
      await t.host.stop();
    }
  });

  it('with features.channels off no channel adapter is built', async () => {
    const t = makeHost({ settings: desktopSettings, features: { channels: false } });
    try {
      await t.host.start();
      assert.deepStrictEqual(t.registry.list(), []);
    } finally {
      await t.host.stop();
    }
  });

  it('mounts POST /contact/relay/<name> on the loopback webhook server, HMAC-checked', async () => {
    const webhook = new WebhookServer({ port: 0 }, { handle: async () => ({}) }, { port: 0 });
    await webhook.start();
    const t = makeHost({ settings: desktopSettings, webhook });
    try {
      await t.host.start();
      const body = JSON.stringify({ id: 'ev-1', type: 'status', messageId: 'msg-404', status: 'delivered' });
      const ts = new Date().toISOString();
      const sig = `sha256=${crypto.createHmac('sha256', 'push-secret').update(`${ts}.${body}`).digest('hex')}`;
      const post = (headers) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: webhook.port, path: '/contact/relay/main', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.deepStrictEqual(await post({ 'x-kl-timestamp': ts, 'x-kl-signature': sig }), { status: 200, body: { ok: true, applied: 0, skipped: 1 } });
      assert.strictEqual((await post({ 'x-kl-timestamp': ts, 'x-kl-signature': 'sha256=' + '0'.repeat(64) })).status, 401);
    } finally {
      await t.host.stop();
      await webhook.stop();
    }
  });

  it('takes the cases-root lease once a case exists and releases it on stop', async () => {
    const t = makeHost({ settings: desktopSettings });
    await t.runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    await t.host.start();
    const lock = path.join(t.runtime.root, '.contact.lock');
    assert.strictEqual(fs.existsSync(lock), true);
    assert.deepStrictEqual(t.host.presenceStatus().ladder, { runsHere: true });
    await t.host.stop();
    assert.strictEqual(fs.existsSync(lock), false);
  });
});

function signedPost(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/contact/relay/main', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sign(body, ts = new Date().toISOString()) {
  return { 'x-kl-timestamp': ts, 'x-kl-signature': `sha256=${crypto.createHmac('sha256', 'push-secret').update(`${ts}.${body}`).digest('hex')}` };
}

describe('createContactHost: preflight rulings', () => {
  it('M9: the in-app adapter appears once a desktop attaches after start, and goes when it detaches', async () => {
    let attached = false;
    const t = makeHost({ isService: true, interactive: () => attached, contactConfig: {} });
    try {
      await t.host.start();
      assert.strictEqual(t.host.adapters.get('in-app'), null, 'no desktop attached yet');
      attached = true;
      const inApp = t.host.adapters.get('in-app');
      assert.ok(inApp, 'built lazily for a desktop that attached after start');
      assert.strictEqual(t.host.adapters.get('in-app'), inApp, 'the same adapter every time');
      await inApp.send('window', 'hello');
      assert.deepStrictEqual(t.events.map(([e]) => e), ['channel:message'], 'in-app sends through host.notify (the bridge forwards it)');
      attached = false;
      assert.strictEqual(t.host.adapters.get('in-app'), null);
    } finally {
      await t.host.stop();
    }
  });

  it('M10: stop() is idempotent, shuts each adapter once and takes it out of the channel registry', async () => {
    const extra = new LoopbackChannel({ id: 'loop-extra' });
    let shutdowns = 0;
    extra.shutdown = async () => { shutdowns += 1; };
    const t = makeHost({ settings: desktopSettings, extraAdapters: { 'loop-extra': extra } });
    await t.host.start();
    assert.ok(t.registry.list().includes(extra));
    await Promise.all([t.host.stop(), t.host.stop()]);
    await t.host.stop();
    assert.strictEqual(shutdowns, 1);
    assert.deepStrictEqual(t.registry.list(), [], 'the registry no longer holds contact adapters');
    await t.registry.shutdownAll();
    assert.strictEqual(shutdowns, 1, "the core's channel shutdown does not shut it again");
  });

  it('M10: a stop held up by an in-flight ladder tick has already taken its adapters out of the registry', async () => {
    const extra = new LoopbackChannel({ id: 'loop-extra' });
    let shutdowns = 0;
    extra.shutdown = async () => { shutdowns += 1; };
    const t = makeHost({ settings: desktopSettings, extraAdapters: { 'loop-extra': extra } });
    await t.host.start();
    let releaseTick;
    t.host.ladder.inflight = new Promise((resolve) => { releaseTick = resolve; });
    const stopping = t.host.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(t.registry.list(), [], 'out of the registry before the tick drains');
    await t.registry.shutdownAll();
    assert.strictEqual(shutdowns, 0, 'the core timed out on contact and shut the registry: not this adapter');
    releaseTick();
    await stopping;
    assert.strictEqual(shutdowns, 1);
  });

  it('relay push: an oversize body is refused 413 before anything is applied; after stop the route is gone', async () => {
    const webhook = new WebhookServer({ port: 0 }, { handle: async () => ({}) }, { port: 0 });
    await webhook.start();
    const t = makeHost({ settings: desktopSettings, webhook });
    let applied = 0;
    const ingest = t.host.router.ingestRelayEvents.bind(t.host.router);
    t.host.router.ingestRelayEvents = async (...args) => { applied += 1; return ingest(...args); };
    try {
      await t.host.start();
      const big = JSON.stringify({ id: 'ev-big', type: 'status', messageId: 'msg-1', status: 'delivered', pad: 'x'.repeat(1024 * 1024) });
      assert.strictEqual((await signedPost(webhook.port, big, sign(big))).status, 413);
      const unsigned = JSON.stringify({ id: 'ev-2', type: 'status', messageId: 'msg-2', status: 'delivered' });
      assert.strictEqual((await signedPost(webhook.port, unsigned, {})).status, 401);
      assert.strictEqual(applied, 0, 'nothing reached the router');
      const body = JSON.stringify({ id: 'ev-3', type: 'status', messageId: 'msg-3', status: 'delivered' });
      const headers = sign(body);
      assert.strictEqual((await signedPost(webhook.port, body, headers)).status, 200);
      assert.deepStrictEqual((await signedPost(webhook.port, body, headers)).body, { ok: true, replay: true, applied: 0, skipped: 1 });
      assert.strictEqual(applied, 1, 'a replay is not applied again');
      await t.host.stop();
      assert.strictEqual((await signedPost(webhook.port, body, sign(body))).status, 404, 'a stopped host takes no pushes');
    } finally {
      await t.host.stop();
      await webhook.stop();
    }
  });
});

describe('WebhookServer#readRequestBody', () => {
  it('decodes UTF-8 once, so a character split across chunks survives (the push HMAC is over this text)', async () => {
    const { PassThrough } = require('stream');
    const server = new WebhookServer({ port: 0 }, { handle: async () => ({}) }, { port: 0 });
    const req = new PassThrough();
    const bytes = Buffer.from('{"t":"é"}', 'utf8');
    const split = bytes.indexOf(0xc3) + 1;
    const read = server.readRequestBody(req);
    req.write(bytes.subarray(0, split));
    req.end(bytes.subarray(split));
    assert.strictEqual(await read, '{"t":"é"}');
  });
});
