// tests/contact-relay.test.js — cases stage 4 §4.5 (relay client, poller, signed push).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ContactRelayClient, RelayPoller, assertRelayBaseUrl, errorForStatus, verifyRelayPush, createRelayPushHandler
} = require('../src/channels/relay-client');
const { ContactState } = require('../src/cases/contact-state');
const { startFakeRelay } = require('./helpers/fake-contact-relay');
const { holdEventLoop } = require('./helpers/hold-event-loop');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-')); dirs.push(d); return path.join(d, 'contact'); };
const sign = (secret, ts, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

describe('relay baseUrl', () => {
  it('allows https and loopback http only', () => {
    assert.strictEqual(assertRelayBaseUrl('https://relay.example.com/'), 'https://relay.example.com');
    assert.strictEqual(assertRelayBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.throws(() => assertRelayBaseUrl('http://relay.example.com'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('http://10.0.0.5'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('file:///etc/passwd'), /https:, or http: to loopback/);
  });
});

describe('ContactRelayClient', () => {
  it('sends with the Idempotency-Key and gets the original message back for the same key', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const a = await client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-1' });
      const b = await client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-1' });
      assert.strictEqual(a.id, b.id);
      assert.strictEqual(relay.sent()[0].headers['idempotency-key'], 'd-1');
      assert.strictEqual(relay.sent()[0].headers.authorization, `Bearer ${relay.token}`);
      assert.strictEqual((await client.lookup('d-1')).id, a.id);
      assert.strictEqual((await client.status(a.id)).status, 'queued');
    } finally {
      await relay.close();
    }
  });

  it('maps HTTP status to ContactDeliveryError codes', async () => {
    const expect = { 400: 'rejected', 422: 'rejected', 401: 'not-configured', 403: 'not-configured', 413: 'too-large', 429: 'rate-limited', 500: 'unreachable', 503: 'unreachable' };
    for (const [status, code] of Object.entries(expect)) assert.strictEqual(errorForStatus(Number(status)).code, code);
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      relay.failNext(429);
      await assert.rejects(client.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'rate-limited');
      const noToken = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => null });
      await assert.rejects(noToken.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'not-configured');
      const down = new ContactRelayClient({ name: 'main', baseUrl: 'http://127.0.0.1:9', getToken: () => 't' });
      await assert.rejects(down.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'unreachable');
    } finally {
      await relay.close();
    }
  });
});

describe('RelayPoller', () => {
  it('persists the cursor and backs off 30 s → 10 min on failure', async () => {
    const relay = await startFakeRelay();
    try {
      const state = new ContactState({ dir: tmp() });
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const seen = [];
      const poller = new RelayPoller({ client, state, onEvents: async (evs) => { seen.push(...evs.map((e) => e.id)); } });
      relay.pushEvent({ id: 'ev-1', type: 'status', messageId: 'msg-1', status: 'delivered' });
      relay.pushEvent({ id: 'ev-2', type: 'status', messageId: 'msg-1', status: 'delivered' });
      assert.deepStrictEqual(await poller.pollOnce(), { ok: true, count: 2 });
      assert.strictEqual(state.readCursor('main'), '2');
      relay.pushEvent({ id: 'ev-3', type: 'status', messageId: 'msg-2', status: 'failed' });
      const again = new RelayPoller({ client, state: new ContactState({ dir: state.dir }), onEvents: async (evs) => { seen.push(...evs.map((e) => e.id)); } });
      await again.pollOnce();
      assert.deepStrictEqual(seen, ['ev-1', 'ev-2', 'ev-3'], 'a new poller resumes after the saved cursor');
      assert.strictEqual(relay.requests.filter((r) => r.path === '/v1/events').pop().query.after, '2');

      assert.strictEqual(again.nextDelay(), 30000);
      relay.failNext(503);
      assert.strictEqual((await again.pollOnce()).ok, false);
      assert.strictEqual(again.nextDelay(), 30000);
      again.failures = 5;
      assert.strictEqual(again.nextDelay(), 480000);
      again.failures = 9;
      assert.strictEqual(again.nextDelay(), 600000);
    } finally {
      await relay.close();
    }
  });
});

describe('signed relay push', () => {
  const secret = 'push-secret';
  const now = Date.parse('2026-09-25T14:00:00Z');
  const ts = '2026-09-25T14:00:00Z';
  const body = JSON.stringify({ id: 'ev-9', type: 'status', messageId: 'msg-1', status: 'delivered' });

  it('accepts a good HMAC and refuses a bad one or a stale timestamp', () => {
    assert.deepStrictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now }), { ok: true });
    assert.strictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign('other', ts, body), rawBody: body, now }).reason, 'bad signature');
    assert.strictEqual(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: `${body} `, now }).reason, 'bad signature');
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now: now + 301000 }).reason, /stale/);
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: 'md5=abc', rawBody: body, now }).reason, /malformed/);
    assert.match(verifyRelayPush({ secret: null, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now }).reason, /no webhook secret/);
  });

  it('the push handler hands verified events to the router and drops duplicate ids there', async () => {
    const got = [];
    const handler = createRelayPushHandler({
      getSecret: () => secret,
      hasRelay: (name) => name === 'main',
      onEvents: async (name, events) => { got.push([name, events.map((e) => e.id)]); return { applied: events.length, skipped: 0 }; },
      clock: () => new Date(now)
    });
    const headers = { 'x-kl-timestamp': ts, 'x-kl-signature': sign(secret, ts, body) };
    assert.deepStrictEqual(await handler('main', body, headers), { status: 200, body: { ok: true, applied: 1, skipped: 0 } });
    assert.strictEqual((await handler('main', body, { ...headers, 'x-kl-signature': sign('x', ts, body) })).status, 401);
    assert.strictEqual((await handler('other', body, headers)).status, 404);
    assert.deepStrictEqual(got, [['main', ['ev-9']]]);

    const { ContactRouter } = require('../src/cases/contact');
    const state = new ContactState({ dir: tmp() });
    // Task 5 (I3): a status only reaches deliveries on channels this relay serves.
    const router = new ContactRouter({ state, runtime: null, adapters: new Map([['sms', { relayName: 'main' }]]) });
    state.recordDelivery('d-1', { channel: 'sms', at: new Date(now).toISOString(), relayId: 'msg-1', batchToken: 'K7QD4M', status: 'sent', items: [] });
    const ev = { id: 'ev-9', type: 'status', messageId: 'msg-1', status: 'delivered' };
    assert.deepStrictEqual(await router.ingestRelayEvents('main', [ev, ev]), { applied: 1, skipped: 1 });
    assert.strictEqual(state.deliveries()['d-1'].status, 'delivered');
  });
});

describe('relay client: timeout and secrets (carries M18, tokens)', () => {
  after(holdEventLoop());

  it('a hung relay times out as unreachable instead of stalling', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token, timeoutMs: 200 });
      relay.hangNext();
      const t0 = Date.now();
      await assert.rejects(client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-h' }),
        (err) => err.code === 'unreachable' && /timed out after 200 ms/.test(err.message));
      assert.ok(Date.now() - t0 < 5000);
      assert.strictEqual((await client.send({ channel: 'sms', to: '+15550100', text: 'hi' }, { idempotencyKey: 'd-h' })).id, 'msg-1', 'the next request goes through');
    } finally {
      await relay.close();
    }
  });

  it('never puts the token in an error message or a log line', async () => {
    const token = 'tok-SECRET-9f2c';
    const lines = [];
    const log = { warn: (m) => lines.push(m), info: (m) => lines.push(m), error: (m) => lines.push(m), debug: (m) => lines.push(m) };
    const echo = new ContactRelayClient({
      name: 'main', baseUrl: 'https://relay.example.com', getToken: () => token, log,
      fetchImpl: async (url, init) => ({ status: 500, text: async () => `bad auth header ${init.headers.authorization}` })
    });
    await assert.rejects(echo.send({}, { idempotencyKey: 'x' }), (err) => err.code === 'unreachable' && !err.message.includes(token) && /\[redacted\]/.test(err.message));
    const thrower = new ContactRelayClient({
      name: 'main', baseUrl: 'https://relay.example.com', getToken: () => token, log,
      fetchImpl: async () => { throw new Error(`connect failed with Bearer ${token}`); }
    });
    await assert.rejects(thrower.events(null), (err) => err.code === 'unreachable' && !err.message.includes(token));
    const poller = new RelayPoller({ client: echo, state: new ContactState({ dir: tmp() }), onEvents: async () => {}, log });
    assert.strictEqual((await poller.pollOnce()).ok, false);
    assert.ok(lines.length > 0);
    for (const l of lines) assert.ok(!String(l).includes(token), l);
  });
});

describe('signed relay push: missing, future and replayed (carry)', () => {
  const secret = 'push-secret';
  const now = Date.parse('2026-09-25T14:00:00Z');
  const ts = '2026-09-25T14:00:00Z';
  const body = JSON.stringify({ id: 'ev-9', type: 'status', messageId: 'msg-1', status: 'delivered' });

  it('refuses a missing signature or timestamp and a timestamp too far ahead', () => {
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: undefined, rawBody: body, now }).reason, /missing or malformed/);
    assert.match(verifyRelayPush({ secret, timestamp: undefined, signature: sign(secret, ts, body), rawBody: body, now }).reason, /stale or missing/);
    assert.match(verifyRelayPush({ secret, timestamp: ts, signature: sign(secret, ts, body), rawBody: body, now: now - 301000 }).reason, /stale/);
    const upper = `sha256=${sign(secret, ts, body).slice('sha256='.length).toUpperCase()}`;
    assert.strictEqual(verifyRelayPush({ secret, timestamp: ts, signature: upper, rawBody: body, now }).ok, true);
  });

  it('refuses a replayed signature and never hands its events on twice', async () => {
    let calls = 0;
    const handler = createRelayPushHandler({
      getSecret: () => secret,
      onEvents: async (name, events) => { calls += 1; return { applied: events.length, skipped: 0 }; },
      clock: () => new Date(now)
    });
    const headers = { 'x-kl-timestamp': ts, 'x-kl-signature': sign(secret, ts, body) };
    assert.strictEqual((await handler('main', body, headers)).status, 200);
    const again = await handler('main', body, headers);
    assert.strictEqual(again.status, 409);
    assert.match(again.body.error, /replayed/);
    assert.strictEqual(calls, 1);
    // A forged push with a bad signature is not remembered, so it can't block the real one.
    const ts2 = '2026-09-25T14:00:01Z';
    const body2 = JSON.stringify({ id: 'ev-10', type: 'status', messageId: 'msg-1', status: 'delivered' });
    const good2 = sign(secret, ts2, body2);
    assert.strictEqual((await handler('main', `${body2} `, { 'x-kl-timestamp': ts2, 'x-kl-signature': good2 })).status, 401);
    assert.strictEqual((await handler('main', body2, { 'x-kl-timestamp': ts2, 'x-kl-signature': good2 })).status, 200);
    assert.strictEqual(calls, 2);
  });

  it('an error body from push handling never carries the secret', async () => {
    const handler = createRelayPushHandler({ getSecret: () => secret, onEvents: async () => ({ applied: 0, skipped: 0 }), clock: () => new Date(now) });
    const out = await handler('main', body, { 'x-kl-timestamp': ts, 'x-kl-signature': sign('x', ts, body) });
    assert.ok(!JSON.stringify(out).includes(secret));
  });
});
