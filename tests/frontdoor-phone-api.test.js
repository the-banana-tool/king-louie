// tests/frontdoor-phone-api.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createPhoneApi } = require('../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { Invites } = require('../src/frontdoor/invites');
const { createFakePhone } = require('./helpers/fake-phone');
const { addSink } = require('../src/logging');

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

async function start({ rateLimits, clockOffsetMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-phone-api-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const devices = new DeviceRegistry({ file: path.join(dir, 'devices.json') });
  const relay = { invites: new Invites() };
  const api = createPhoneApi({ devices, rateLimits, relay, now: () => Date.now() + clockOffsetMs });
  api.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { server_time: new Date().toISOString() } }) });
  api.registerRoute('POST', '/v1/echo/{thing}', { auth: 'device', handler: async (req, ctx) => ({ status: 202, body: { device: ctx.deviceId, thing: ctx.params.thing, query: ctx.query, body: ctx.body } }) });
  api.registerRoute('GET', '/v1/enroll/{code_id}', { auth: 'code', handler: async (req, ctx) => ({ body: { code: ctx.params.code_id } }) });
  api.registerRoute('POST', '/v1/devices/invites/{id}/claim', { auth: 'invite', handler: async () => ({ status: 202, body: {} }) });
  const server = http.createServer(api.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const phone = createFakePhone();
  devices.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'Pixel 9', platform: 'android' });
  const call = async (method, p, { body = '', headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers, body: method === 'GET' ? undefined : body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const signed = (method, p, body = '', options = {}) => call(method, p, { body, headers: phone.signApi(method, p, body, options) });
  return { api, relay, phone, call, signed, devices };
}

describe('phone API device auth', () => {
  it('accepts a signed request and hands the handler the device, params, query and body', async () => {
    const { signed, phone } = await start();
    const body = JSON.stringify({ hello: 'world' });
    const res = await signed('POST', '/v1/echo/abc?x=1', body);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { device: phone.deviceId, thing: 'abc', query: { x: '1' }, body: { hello: 'world' } });
  });

  it('refuses a missing, forged or unregistered signature', async () => {
    const { call, signed, phone } = await start();
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    const headers = phone.signApi('POST', '/v1/echo/a', '{"a":1}');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{"a":2}', headers })).body.error, 'bad_signature');
    const other = createFakePhone();
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers: other.signApi('POST', '/v1/echo/a', '{}') })).body.error, 'unknown_device');
    assert.equal((await signed('POST', '/v1/echo/a?b=1', '{}')).status, 202, 'the query is part of what is signed');
  });

  it('401 clock_skew then offset retry succeeds', async () => {
    const { signed } = await start({ clockOffsetMs: 10 * 60 * 1000 });
    const first = await signed('POST', '/v1/echo/a', '{}');
    assert.equal(first.status, 401);
    assert.equal(first.body.error, 'clock_skew');
    const offset = Date.parse(first.body.server_time) - Date.now();
    const retry = await signed('POST', '/v1/echo/a', '{}', { timestamp: new Date(Date.now() + offset).toISOString() });
    assert.equal(retry.status, 202);
  });

  it('keys replay on the signed string: a re-encoded (malleated) signature is still a replay', async () => {
    const { call, phone } = await start();
    const headers = phone.signApi('POST', '/v1/echo/a', '{}');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers })).status, 202);
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers })).body.error, 'replay');
    const sig = Buffer.from(headers['X-KL-Signature'], 'base64url');
    const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
    const malleated = Buffer.concat([sig.subarray(0, 32), Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex')]);
    const res = await call('POST', '/v1/echo/a', { body: '{}', headers: { ...headers, 'X-KL-Signature': malleated.toString('base64url') } });
    assert.equal(res.body.error, 'replay');
  });
});

describe('phone API code and invite routes', () => {
  it('a code route needs an open code_id; an invite route an unclaimed invite', async () => {
    const { call, relay, phone } = await start();
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.equal((await call('GET', `/v1/enroll/${codeId}`)).body.error, 'unknown_code');
    relay.invites.openCode(codeId, 'kl-aaaaaaaaaaaaaaaa', Date.now() + 600000);
    assert.deepEqual((await call('GET', `/v1/enroll/${codeId}`)).body, { code: codeId });
    const { invite_id: inviteId } = relay.invites.createInvite(phone.deviceId);
    assert.equal((await call('POST', `/v1/devices/invites/${inviteId}/claim`, { body: '{}' })).status, 202);
    const claimant = createFakePhone();
    relay.invites.claim(inviteId, { device: { device_id: claimant.deviceId }, mac: 'x' });
    assert.equal((await call('POST', `/v1/devices/invites/${inviteId}/claim`, { body: '{}' })).body.error, 'unknown_invite');
  });
});

describe('phone API limits and routing', () => {
  it('rate-limits unauthenticated calls per IP, with retry_after', async () => {
    // /v1/time never authenticates, so every call always counts against the
    // shared IP bucket, unaffected by N1 (which only changes device routes).
    const { call } = await start({ rateLimits: { unauthPerMin: 3 } });
    for (let i = 0; i < 3; i += 1) assert.equal((await call('GET', '/v1/time')).status, 200);
    const limited = await call('GET', '/v1/time');
    assert.equal(limited.status, 429);
    assert.ok(limited.body.retry_after >= 1);
  });

  it('rate-limits validly signed device calls per device, with retry_after', async () => {
    // Run in isolation from any /v1/time traffic: since neither route sets
    // its own `rate`, they'd otherwise share one IP bucket (per the
    // per-route-key ruling), which is exactly what the next test exercises.
    const { signed } = await start({ rateLimits: { devicePerMin: 2 } });
    assert.equal((await signed('POST', '/v1/echo/1', '{}')).status, 202);
    assert.equal((await signed('POST', '/v1/echo/2', '{}')).status, 202);
    const limited = await signed('POST', '/v1/echo/3', '{}');
    assert.equal(limited.status, 429);
    assert.ok(limited.body.retry_after >= 1);
  });

  it('valid device traffic is limited only by devicePerMin, never by unauthPerMin (N1)', async () => {
    const { call, signed } = await start({ rateLimits: { unauthPerMin: 3, devicePerMin: 20 } });
    // More than unauthPerMin validly signed requests from the same IP all
    // succeed: a verified signature is never charged against the IP bucket.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await signed('POST', `/v1/echo/${i}`, '{}')).status, 202);
    }
    // Failing-auth traffic from that same IP is still bounded by unauthPerMin.
    assert.equal((await call('POST', '/v1/echo/x', { body: '{}' })).body.error, 'unauthorized');
    assert.equal((await call('POST', '/v1/echo/x', { body: '{}' })).body.error, 'unauthorized');
    assert.equal((await call('POST', '/v1/echo/x', { body: '{}' })).body.error, 'unauthorized');
    const limited = await call('POST', '/v1/echo/x', { body: '{}' });
    assert.equal(limited.status, 429);
  });

  it('caps bodies at 256 KiB and refuses bad JSON', async () => {
    const { signed } = await start();
    const big = JSON.stringify({ x: 'y'.repeat(262144) });
    assert.equal((await signed('POST', '/v1/echo/a', big)).status, 413);
    assert.equal((await signed('POST', '/v1/echo/a', '{nope')).body.error, 'bad_json');
  });

  it('404 for unknown paths, 405 for a wrong method, and a later registration replaces an earlier one (E8)', async () => {
    const { call, api } = await start();
    assert.equal((await call('GET', '/v1/nothing')).status, 404);
    assert.equal((await call('POST', '/v1/time', { body: '{}' })).status, 405);
    api.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { replaced: true } }) });
    assert.deepEqual((await call('GET', '/v1/time')).body, { replaced: true });
    assert.equal(api.routes().filter((r) => r.pattern === '/v1/time').length, 1);
    assert.throws(() => api.registerRoute('GET', '/v2/x', { auth: 'none', handler: () => ({}) }));
    assert.throws(() => api.registerRoute('GET', '/v1/x', { auth: 'oauth', handler: () => ({}) }));
  });

  it('refuses a timestamp that is not RFC 3339 UTC, including a syntactically valid but nonexistent date', async () => {
    const { call, phone } = await start();
    const notATimestamp = phone.signApi('POST', '/v1/echo/a', '{}', { timestamp: 'not-a-timestamp' });
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers: notATimestamp })).body.error, 'bad_timestamp');
    // Date.parse would silently roll this forward to March; isTimestamp must not.
    const feb30 = phone.signApi('POST', '/v1/echo/a', '{}', { timestamp: '2026-02-30T00:00:00Z' });
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}', headers: feb30 })).body.error, 'bad_timestamp');
  });

  it("a handler error carrying status and code is answered with them, and an ordinary throw answers 500 internal", async () => {
    const { call, api } = await start();
    api.registerRoute('GET', '/v1/boom', { auth: 'none', handler: async () => {
      const e = new Error('the teapot refuses');
      e.status = 418;
      e.code = 'teapot';
      throw e;
    } });
    api.registerRoute('GET', '/v1/crash', { auth: 'none', handler: async () => { throw new Error('unexpected'); } });
    const boom = await call('GET', '/v1/boom');
    assert.equal(boom.status, 418);
    assert.equal(boom.body.error, 'teapot');

    // The crash logs an error, as it should; capture it via addSink (N2) and
    // silence the underlying console.error so the expected log line doesn't
    // clutter the test output.
    const errors = [];
    const removeSink = addSink((r) => { if (r.level === 'error') errors.push(r); });
    const originalConsoleError = console.error;
    console.error = () => {};
    let crash;
    try {
      crash = await call('GET', '/v1/crash');
    } finally {
      console.error = originalConsoleError;
      removeSink();
    }
    assert.equal(crash.status, 500);
    assert.equal(crash.body.error, 'internal');
    assert.equal(errors.length, 1);
  });

  it('an unauthenticated failure on a device route is rate-limited by IP too (I1)', async () => {
    const { call } = await start({ rateLimits: { unauthPerMin: 2 } });
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    const limited = await call('POST', '/v1/echo/a', { body: '{}' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
  });

  it('repeated body overflows on a device route still reach 429 (N3)', async () => {
    // Regression: round 1 only charged the IP bucket when the signature
    // itself failed to verify, so an exit before verification ever
    // happened — a 413 from an oversized body, in particular — never
    // charged it, and unlimited 413s never became a 429.
    const { signed } = await start({ rateLimits: { unauthPerMin: 2 } });
    const big = JSON.stringify({ x: 'y'.repeat(262144) });
    assert.equal((await signed('POST', '/v1/echo/a', big)).status, 413);
    assert.equal((await signed('POST', '/v1/echo/a', big)).status, 413);
    const limited = await signed('POST', '/v1/echo/a', big);
    assert.equal(limited.status, 429);
  });

  it("a device route's own rate governs only its device bucket, never the pre-auth IP check (minor)", async () => {
    const { api, call } = await start({ rateLimits: { unauthPerMin: 2 } });
    // A generous device-bucket allowance must not become a generous
    // attacker allowance on the same route's pre-auth IP check.
    api.registerRoute('POST', '/v1/echo/{thing}', { auth: 'device', rate: { perMin: 50 }, handler: async (req, ctx) => ({ status: 202, body: { thing: ctx.params.thing } }) });
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    assert.equal((await call('POST', '/v1/echo/a', { body: '{}' })).body.error, 'unauthorized');
    const limited = await call('POST', '/v1/echo/a', { body: '{}' });
    assert.equal(limited.status, 429);
  });

  it('a malformed percent-escape in a path segment answers 404 with no error log (I3)', async () => {
    const { call } = await start();
    const errors = [];
    const remove = addSink((r) => { if (r.level === 'error') errors.push(r); });
    try {
      const res = await call('GET', '/v1/enroll/%zz');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not_found');
    } finally {
      remove();
    }
    assert.deepEqual(errors, []);
  });

  it("a 429 does not use up the replay entry: the exact same signed request still succeeds once the device's window clears", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-phone-api-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const devices = new DeviceRegistry({ file: path.join(dir, 'devices.json') });
    let clock = Date.now();
    const api = createPhoneApi({ devices, rateLimits: { devicePerMin: 1 }, now: () => clock });
    api.registerRoute('POST', '/v1/echo/{thing}', { auth: 'device', handler: async (req, ctx) => ({ status: 202, body: { thing: ctx.params.thing } }) });
    const server = http.createServer(api.handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const phone = createFakePhone();
    devices.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'Pixel 9', platform: 'android' });
    const call = async (p, headers, body) => {
      const res = await fetch(base + p, { method: 'POST', headers, body });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const headersA = phone.signApi('POST', '/v1/echo/a', '{}', { timestamp: new Date(clock).toISOString() });
    assert.equal((await call('/v1/echo/a', headersA, '{}')).status, 202);

    const headersB = phone.signApi('POST', '/v1/echo/b', '{}', { timestamp: new Date(clock).toISOString() });
    const limited = await call('/v1/echo/b', headersB, '{}');
    assert.equal(limited.body.error, 'rate_limited');

    clock += 61000; // the device's 60 s window clears
    const retry = await call('/v1/echo/b', headersB, '{}');
    assert.equal(retry.status, 202, 'the request blocked by the 429 was never marked as used');
  });
});
