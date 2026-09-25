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
