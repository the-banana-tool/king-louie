// tests/approvals-courier.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileCourier, CourierPump } = require('../src/approvals/courier');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

// A data dir whose service.pid names this (live) test process, so the
// courier believes the service runs; `running: false` leaves it absent.
function dataDir({ running = true, linked = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-courier-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  if (running) fs.writeFileSync(path.join(d, 'service.pid'), String(process.pid));
  if (linked) {
    fs.mkdirSync(path.join(d, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(d, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: null, relay_id: 'kl-x', relay_public_url: null, relay_spki: null }));
  }
  return d;
}

function fakeRelayClient() {
  const calls = [];
  return { calls, call: async (method, params) => { calls.push([method, params]); return { ok: true }; } };
}

function pair({ dir = dataDir(), identity = testNodeIdentity(), rpcHandler = null } = {}) {
  const relayClient = fakeRelayClient();
  const pump = new CourierPump({ dataDir: dir, relayClient, identity, rpcHandler, pollMs: 10 }).start();
  const courier = new FileCourier({ dataDir: dir, identity, pollMs: 10 }).start();
  cleanups.push(() => { courier.stop(); pump.stop(); });
  return { dir, identity, relayClient, pump, courier };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('FileCourier and CourierPump', () => {
  it('forwards a node-signed request and brings the reply back', async () => {
    const { courier, relayClient, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    assert.deepEqual(await courier.submit(envelope), { ok: true });
    assert.deepEqual(relayClient.calls, [['approval.submit', { envelope }]]);
  });

  it('routes a phone response back to the producer that submitted the request', async () => {
    const { courier, pump, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    await courier.submit(envelope);
    const got = [];
    courier.onMessage(async (method, params) => { got.push([method, params]); });
    const response = createFakePhone().respond(envelope, 'approve');
    const inbox = pump.routeFor('approval.response', { envelope: response });
    assert.equal(inbox, courier.inboxName);
    assert.equal(pump.deliver(inbox, 'approval.response', { envelope: response }), true);
    for (let i = 0; i < 50 && got.length === 0; i += 1) await tick(10);
    assert.deepEqual(got, [['approval.response', { envelope: response }]]);
  });

  it('non-relay methods go to the rpcHandler (R24)', async () => {
    const { courier } = pair({ rpcHandler: async (method, params) => ({ handled: method, params }) });
    assert.deepEqual(await courier.call('jobs.get', { job_id: 'job-1' }), { handled: 'jobs.get', params: { job_id: 'job-1' } });
  });

  it('is unavailable at once when the service is not running', async () => {
    const courier = new FileCourier({ dataDir: dataDir({ running: false }) });
    assert.deepEqual(courier.canDeliver(), { ok: false, reason: 'the King Louie service is not running on this node' });
    await assert.rejects(courier.call('approval.submit', {}), (err) => err.code === 'unavailable');
    assert.deepEqual(new FileCourier({ dataDir: dataDir({ linked: false }) }).canDeliver(), { ok: false, reason: 'no relay is paired with this node' });
  });

  it('drops an outbox entry not signed by this node', async () => {
    const { courier, relayClient } = pair();
    const stranger = testNodeIdentity();
    const { envelope } = m.buildRequest({ identity: stranger, action: m.toolAction('Bash', { command: 'ls' }, null) });
    await assert.rejects(courier.submit(envelope), (err) => err.code === 'rejected');
    assert.deepEqual(relayClient.calls, []);
  });

  it('drops enroll.done for a code_id it never saw opened, forwards it after enroll.open', async () => {
    const { courier, relayClient, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    const done = m.buildEnrollDone({ identity, codeId, refused: true });
    await assert.rejects(courier.call('enroll.done', { envelope: done }), (err) => err.code === 'rejected');
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() + 600000 }) });
    await courier.call('enroll.done', { envelope: done });
    assert.deepEqual(relayClient.calls.map((c) => c[0]), ['enroll.open', 'enroll.done']);
  });

  it('ignores forged inbox files: an unknown reply and a method a producer never accepts', async () => {
    const { courier } = pair();
    const got = [];
    courier.onMessage(async (method) => { got.push(method); });
    fs.writeFileSync(path.join(courier.inbox, `${'a'.repeat(16)}.json`), JSON.stringify({ result: { ok: true } }));
    fs.writeFileSync(path.join(courier.inbox, 'm-1-deadbeef.json'), JSON.stringify({ method: 'device.enroll', params: {} }));
    await tick(80);
    assert.deepEqual(got, []);
    assert.deepEqual(fs.readdirSync(courier.inbox), []);
  });

  it('emits connected when link.json turns connected, and removes dead producers’ inboxes', async () => {
    const dir = dataDir();
    const linkFile = path.join(dir, 'approvals', 'link.json');
    fs.writeFileSync(linkFile, JSON.stringify({ connected: false }));
    const { courier, pump } = pair({ dir });
    const connected = new Promise((resolve) => courier.once('connected', resolve));
    fs.writeFileSync(linkFile, JSON.stringify({ connected: true }));
    await connected;
    const dead = path.join(dir, 'approvals', 'inbox', 'p-999999999-deadbeef');
    fs.mkdirSync(dead);
    await pump.pollOnce();
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(courier.inbox), true);
  });
});

// Fix round 1 (opus review): a malformed or hostile outbox/inbox entry must
// never be dispatched, never throw out of pollOnce (which would skip the
// rest of the batch and the sweep behind it), and must never reach
// path.join with something other than a string.
describe('FileCourier and CourierPump (fix round 1)', () => {
  it('_handle drops a null/non-object entry without throwing or dispatching', async () => {
    const rpcCalls = [];
    const { pump, relayClient } = pair({ rpcHandler: async (method, params) => { rpcCalls.push([method, params]); return {}; } });
    for (const entry of [null, 'just a string', 42, ['array']]) {
      await pump._handle(entry);
    }
    assert.deepEqual(relayClient.calls, []);
    assert.deepEqual(rpcCalls, []);
  });

  it('_handle drops params: null (the exact shape that used to throw out of pollOnce) without throwing', async () => {
    const { pump, relayClient } = pair();
    await pump._handle({ method: 'approval.submit', params: null, reply_to: null });
    assert.deepEqual(relayClient.calls, []);
  });

  it('_handle drops a non-string method without dispatching to rpcHandler', async () => {
    const rpcCalls = [];
    const { pump } = pair({ rpcHandler: async (method, params) => { rpcCalls.push([method, params]); return {}; } });
    await pump._handle({ method: 123, params: {}, reply_to: null });
    await pump._handle({ method: undefined, params: {}, reply_to: null });
    assert.deepEqual(rpcCalls, []);
  });

  it('_handle drops reply_to given as an array instead of throwing in path.join', async () => {
    const { pump, relayClient } = pair();
    await pump._handle({ method: 'approval.submit', params: {}, reply_to: ['p-1-deadbeef', 'aaaaaaaaaaaaaaaa'] });
    assert.deepEqual(relayClient.calls, []);
  });

  it('_handle drops a reply_to with extra keys or non-string fields', async () => {
    const rpcCalls = [];
    const { pump } = pair({ rpcHandler: async (method, params) => { rpcCalls.push([method, params]); return {}; } });
    await pump._handle({ method: 'jobs.get', params: {}, reply_to: { inbox: 'p-1-deadbeef', key: 'aaaaaaaaaaaaaaaa', extra: 1 } });
    await pump._handle({ method: 'jobs.get', params: {}, reply_to: { inbox: 123, key: 'aaaaaaaaaaaaaaaa' } });
    assert.deepEqual(rpcCalls, []);
  });

  it('a malformed outbox file never stalls the pump: the rest of the batch and the sweep still run', async () => {
    const { pump, courier } = pair({ rpcHandler: async (method, params) => ({ handled: method, params }) });
    fs.writeFileSync(path.join(pump.outbox, '0-deadbeef.json'), JSON.stringify({ method: 'approval.submit', params: null, reply_to: null }));
    assert.deepEqual(await courier.call('jobs.get', { job_id: 'job-1' }), { handled: 'jobs.get', params: { job_id: 'job-1' } });
  });

  it('drops an oversized outbox file without reading or forwarding it', async () => {
    const { pump, relayClient } = pair();
    const big = JSON.stringify({ method: 'approval.submit', params: { pad: 'x'.repeat(2 * 1024 * 1024) }, reply_to: null });
    const file = path.join(pump.outbox, '0-deadbeef.json');
    fs.writeFileSync(file, big);
    await pump.pollOnce();
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(relayClient.calls, []);
  });

  it('drops a non-JSON outbox file without crashing the pump', async () => {
    const { pump, courier } = pair({ rpcHandler: async (method) => ({ handled: method }) });
    const file = path.join(pump.outbox, '0-deadbeef.json');
    fs.writeFileSync(file, 'not json at all {{{');
    await pump.pollOnce();
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await courier.call('jobs.get', {}), { handled: 'jobs.get' });
  });

  it('leaves outbox and inbox files with names that do not match the pattern untouched', async () => {
    const { pump, courier } = pair();
    const outboxStray = path.join(pump.outbox, 'not-a-real-name.json');
    const inboxStray = path.join(courier.inbox, 'not-a-real-name.json');
    fs.writeFileSync(outboxStray, '{}');
    fs.writeFileSync(inboxStray, '{}');
    await tick(80);
    assert.equal(fs.existsSync(outboxStray), true);
    assert.equal(fs.existsSync(inboxStray), true);
  });

  it('a same-inbox retry is re-forwarded after a failed relay call; a different inbox claiming the same id is refused', async () => {
    // PhoneApprover resubmits every pending request, with the same
    // envelope, when the link comes back — that resubmit must reach the
    // relay again, not be refused as "already bound" (fix round 1's first
    // ruling on M1 broke exactly this). Only a genuinely different inbox
    // trying to claim someone else's request_id is refused.
    const dir = dataDir();
    const identity = testNodeIdentity();
    const relayClient = fakeRelayClient();
    const pump = new CourierPump({ dataDir: dir, relayClient, identity, pollMs: 10 }).start();
    const courierA = new FileCourier({ dataDir: dir, identity, pollMs: 10 }).start();
    const courierB = new FileCourier({ dataDir: dir, identity, pollMs: 10 }).start();
    cleanups.push(() => { courierA.stop(); courierB.stop(); pump.stop(); });

    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });

    // The relay is down for the first attempt: the call fails, and the
    // binding must be released, not left claimed by a request that never
    // actually reached the relay.
    relayClient.call = async () => { throw new Error('relay down'); };
    await assert.rejects(courierA.submit(envelope), (err) => err.code === 'error');

    // The retry, same envelope, same inbox, once the relay is back: this
    // must succeed.
    relayClient.call = async (method, params) => { relayClient.calls.push([method, params]); return { ok: true }; };
    assert.deepEqual(await courierA.submit(envelope), { ok: true });

    // A different inbox trying to claim the same request_id is refused,
    // and never reaches the relay.
    await assert.rejects(courierB.submit(envelope), (err) => err.code === 'rejected');
    assert.deepEqual(relayClient.calls, [['approval.submit', { envelope }]]);
  });

  it('rebuilds the forwarded params instead of passing the outbox entry through verbatim', async () => {
    const { courier, relayClient, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    // A hostile-shaped params blob with an injected key alongside the envelope.
    fs.writeFileSync(path.join(courier.outbox, `${Date.now()}-deadbeef.json`), JSON.stringify({
      method: 'approval.submit',
      params: { envelope, injected: 'evil' },
      reply_to: null
    }));
    await tick(80);
    assert.deepEqual(relayClient.calls, [['approval.submit', { envelope }]]);
  });

  it('refuses a symlinked outbox file', { skip: process.platform === 'win32' ? 'symlinks need elevated privileges on Windows' : false }, async () => {
    // A node-signed approval.submit: were the symlink refusal not in place,
    // this envelope would otherwise be forwarded to the relay, so the
    // relayClient.calls assertion below actually proves the security
    // boundary held (a jobs.get would never reach the relay anyway).
    const { pump, relayClient, identity } = pair();
    const { envelope } = m.buildRequest({ identity, action: m.toolAction('Bash', { command: 'ls' }, null) });
    const target = path.join(pump.outbox, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ method: 'approval.submit', params: { envelope }, reply_to: null }));
    const link = path.join(pump.outbox, '0-deadbeef.json');
    fs.symlinkSync(target, link, 'file');
    await pump.pollOnce();
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(target), true); // the symlink is removed, never its target
    assert.deepEqual(relayClient.calls, []);
  });

  it('refuses a symlinked inbox reply file', { skip: process.platform === 'win32' ? 'symlinks need elevated privileges on Windows' : false }, async () => {
    const { courier } = pair();
    const target = path.join(courier.inbox, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ result: { ok: true } }));
    const key = 'b'.repeat(16);
    const link = path.join(courier.inbox, `${key}.json`);
    fs.symlinkSync(target, link, 'file');
    await tick(80);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(target), true);
  });
});

// Task 20 review round 1 (opus, ruling I1): any code path that acts on an
// enrolment code must check the code is still open (Task 19 carry). A claim
// arriving after the code's own expiry, or after enroll.done has forwarded
// (closing it), must not be routed anywhere — routeFor('enroll.claim', …)
// itself refuses, so createRelayDispatcher's enroll.claim branch falls
// through to { delivered: false } rather than delivering a stale claim.
describe('CourierPump.routeFor(enroll.claim) and code state (fix round 1)', () => {
  it('refuses once the code has expired, even though it was never closed', async () => {
    const { pump, courier, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() - 1000 }) });
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), null);
  });

  it('refuses once enroll.done has closed the code, even though it has not expired yet', async () => {
    const { pump, courier, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() + 600000 }) });
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), courier.inboxName);
    await courier.call('enroll.done', { envelope: m.buildEnrollDone({ identity, codeId, refused: true }) });
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), null);
  });

  it('routes to the inbox while the code is open', async () => {
    const { pump, courier, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), null); // unknown code
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() + 600000 }) });
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), courier.inboxName);
  });
});

// Task 20 review round 1 re-review (opus, ruling N1): closed = true was set
// before the relayClient.call for enroll.done, so a relay failure left the
// code closed even though enroll.done never actually reached the relay —
// the same class of bug as the Task 15 M1 same-inbox-retry correction for
// approval.submit/enroll.open. A retry after a transient relay failure must
// still be forwarded.
describe('CourierPump: enroll.done reopens the code on a failed relay call (fix round 2)', () => {
  it('reopens the code when the enroll.done forward fails, so a retry is forwarded', async () => {
    const { pump, courier, relayClient, identity } = pair();
    const codeId = crypto.randomBytes(16).toString('base64url');
    await courier.call('enroll.open', { envelope: m.buildEnrollOpen({ identity, codeId, expiresAt: Date.now() + 600000 }) });
    const done = m.buildEnrollDone({ identity, codeId, refused: true });

    relayClient.call = async () => { throw new Error('relay down'); };
    await assert.rejects(courier.call('enroll.done', { envelope: done }), (err) => err.code === 'error');
    // The failed attempt must not leave the code closed: a claim (and a
    // retry of enroll.done itself) must still find it open.
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), courier.inboxName);

    relayClient.call = async (method, params) => { relayClient.calls.push([method, params]); return { ok: true }; };
    await courier.call('enroll.done', { envelope: done });
    assert.deepEqual(relayClient.calls.map((c) => c[0]), ['enroll.open', 'enroll.done']);
    // Once it genuinely reaches the relay, the code is closed again.
    assert.equal(pump.routeFor('enroll.claim', { code_id: codeId }), null);
  });
});
