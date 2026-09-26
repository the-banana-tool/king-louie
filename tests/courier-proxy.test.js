// tests/courier-proxy.test.js — ruling T13-enroll: the root-run CLI's courier
// runs in a forked helper that drops to the data dir's owner; the parent
// validates everything the helper sends and fails cleanly when it dies.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CourierProxy, validLink } = require('../src/service/courier-proxy');
const { CourierPump } = require('../src/approvals/courier');
const { isRoot, dropToDataDirOwner } = require('../src/service/drop-privileges');
const { testNodeIdentity } = require('./helpers/fake-phone');
const { holdEventLoop } = require('./helpers/hold-event-loop');

after(holdEventLoop());
const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

const LINK = { connected: true, since: null, relay_id: 'kl-x', relay_public_url: 'https://kl.example.com:8443', relay_spki: 'sha256/test' };

function dataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-courier-proxy-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'service.pid'), String(process.pid));
  fs.mkdirSync(path.join(d, 'approvals'), { recursive: true });
  fs.writeFileSync(path.join(d, 'approvals', 'link.json'), JSON.stringify(LINK));
  // As POSIX root the helper drops to the data dir's owner and refuses a
  // root-owned one: give it a service account.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    for (const p of [d, path.join(d, 'approvals'), path.join(d, 'approvals', 'link.json')]) fs.chownSync(p, 1000, 1000);
  }
  return d;
}

const waitFor = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// A stand-in for the forked child: whatever the test emits as 'message' is
// what the parent receives from the helper.
function fakeFork() {
  const child = new EventEmitter();
  child.sent = [];
  child.exitCode = null;
  child.connected = true;
  child.send = (m) => { child.sent.push(m); };
  child.kill = () => { child.exitCode = 137; child.emit('exit', null, 'SIGKILL'); };
  child.disconnect = () => { child.connected = false; };
  return { child, forkImpl: () => child };
}

describe('drop-privileges', () => {
  it('isRoot reads getuid/geteuid and is false without them (Windows)', () => {
    assert.equal(isRoot({ getuid: () => 0, geteuid: () => 0 }), true);
    assert.equal(isRoot({ getuid: () => 1000, geteuid: () => 0 }), true);
    assert.equal(isRoot({ getuid: () => 1000, geteuid: () => 1000 }), false);
    assert.equal(isRoot({}), false);
  });

  it('names the command in its refusal', () => {
    const proc = { getuid: () => 0, geteuid: () => 0 };
    const fsImpl = { lstatSync: () => ({ uid: 0, gid: 0, isDirectory: () => true, isSymbolicLink: () => false }) };
    assert.throws(() => dropToDataDirOwner('/d', { proc, fsImpl, who: 'enroll-device' }), /refusing to run enroll-device as root: \/d is owned by root/);
  });
});

describe('CourierProxy with the real helper process', () => {
  // As POSIX root the pump below would run as root and write replies the
  // helper (dropped to uid 1000) cannot read — no installed service does
  // that; tests/approvals-e2e.test.js covers the root path with a real
  // service running as uid 1000.
  const ROOT_SKIP = typeof process.getuid === 'function' && process.getuid() === 0 && 'root: covered by approvals-e2e with a uid-1000 service';
  it('starts, reports the link, relays a call and an inbox message, and stops', { skip: ROOT_SKIP }, async () => {
    const dir = dataDir();
    const pump = new CourierPump({ dataDir: dir, relayClient: { call: async () => ({ ok: true }) }, identity: testNodeIdentity(), pollMs: 10,
      rpcHandler: async (method, params) => ({ handled: method, params }) }).start();
    cleanups.push(() => pump.stop());
    const proxy = new CourierProxy({ dataDir: dir, pollMs: 10 });
    try {
      const { link } = await proxy.start();
      assert.deepEqual(link, LINK);
      assert.deepEqual(await proxy.call('jobs.get', { job_id: 'j-1' }), { handled: 'jobs.get', params: { job_id: 'j-1' } });
      const got = [];
      proxy.onMessage(async (method, params) => { got.push([method, params]); });
      const inbox = await waitFor(() => fs.readdirSync(path.join(dir, 'approvals', 'inbox')).find((n) => n.startsWith(`p-${proxy.child.pid}-`)), 'the helper inbox');
      assert.equal(pump.deliver(inbox, 'enroll.claim', { code_id: 'c-1', envelope: { x: 1 } }), true);
      await waitFor(() => got.length === 1, 'the relayed message');
      assert.deepEqual(got, [['enroll.claim', { code_id: 'c-1', envelope: { x: 1 } }]]);
    } finally {
      proxy.stop();
    }
    await waitFor(() => proxy.child.exitCode !== null || proxy.child.signalCode !== null, 'the helper to exit');
  });

  it('a helper killed mid-call fails the call and resolves `died`', async () => {
    const dir = dataDir(); // no pump: the call waits
    const proxy = new CourierProxy({ dataDir: dir, pollMs: 10 });
    await proxy.start();
    const pending = proxy.call('jobs.get', {}, { timeoutMs: 30000 });
    proxy.child.kill('SIGKILL');
    await assert.rejects(pending, (err) => err.code === 'closed' && /exited/.test(err.message));
    const reason = await proxy.died;
    assert.match(reason.message, /exited/);
    await assert.rejects(proxy.call('jobs.get', {}), (err) => err.code === 'closed');
  });
});

describe('CourierProxy refuses anything but the allowlisted shapes', () => {
  async function started() {
    const f = fakeFork();
    const proxy = new CourierProxy({ dataDir: '/nowhere', forkImpl: f.forkImpl });
    const ready = proxy.start();
    f.child.emit('message', { type: 'ready', link: LINK });
    await ready;
    return { proxy, child: f.child };
  }

  const bad = [
    ['an unknown type', { type: 'exec', cmd: 'x' }],
    ['a non-object', 'hello'],
    ['a reply to no call', { type: 'reply', id: 99, ok: true, result: 1 }],
    ['a message with a method outside the allowlist', { type: 'message', method: 'approval.submit', params: {} }],
    ['a message with extra keys', { type: 'message', method: 'enroll.claim', params: {}, extra: 1 }],
    ['a message whose params are not an object', { type: 'message', method: 'enroll.claim', params: [] }],
    ['a second ready', { type: 'ready', link: null }]
  ];
  for (const [what, msg] of bad) {
    it(`${what}: the helper is stopped and pending calls fail`, async () => {
      const { proxy, child } = await started();
      const pending = proxy.call('enroll.open', {});
      child.emit('message', msg);
      await assert.rejects(pending, (err) => err.code === 'closed' && /malformed/.test(err.message));
      assert.ok(proxy.dead);
      assert.equal(child.exitCode, 137, 'killed');
    });
  }

  it('a reply error with a bad code or extra keys is malformed; a good one rejects with its code', async () => {
    let { proxy, child } = await started();
    let pending = proxy.call('enroll.open', {});
    child.emit('message', { type: 'reply', id: 1, ok: false, error: { code: 'rejected', message: 'unknown code_id' } });
    await assert.rejects(pending, (err) => err.code === 'rejected' && err.message === 'unknown code_id');
    assert.equal(proxy.dead, null);
    pending = proxy.call('enroll.open', {});
    child.emit('message', { type: 'reply', id: 2, ok: false, error: { code: 'Bad Code!', message: 'x' } });
    await assert.rejects(pending, (err) => /malformed/.test(err.message));
    ({ proxy, child } = await started());
    pending = proxy.call('enroll.open', {});
    child.emit('message', { type: 'reply', id: 1, ok: true, result: {}, smuggled: true });
    await assert.rejects(pending, (err) => /malformed/.test(err.message));
  });

  it('ready must carry a well-typed link; unknown link fields are dropped', async () => {
    assert.deepEqual(validLink({ ...LINK, extra: 'x' }).link, LINK);
    assert.equal(validLink({ ...LINK, relay_spki: 42 }).ok, false);
    assert.equal(validLink({ ...LINK, connected: 'yes' }).ok, false);
    assert.equal(validLink([]).ok, false);
    const f = fakeFork();
    const proxy = new CourierProxy({ dataDir: '/nowhere', forkImpl: f.forkImpl });
    const ready = proxy.start();
    f.child.emit('message', { type: 'ready', link: { ...LINK, relay_public_url: { href: 'x' } } });
    await assert.rejects(ready, (err) => /malformed/.test(err.message));
  });

  it('a fatal from the helper (e.g. a refused drop) fails start with its reason', async () => {
    const f = fakeFork();
    const proxy = new CourierProxy({ dataDir: '/nowhere', forkImpl: f.forkImpl });
    const ready = proxy.start();
    f.child.emit('message', { type: 'fatal', message: 'refusing to run enroll-device as root: /d is owned by root' });
    await assert.rejects(ready, (err) => err.code === 'unavailable' && /owned by root/.test(err.message));
  });
});
