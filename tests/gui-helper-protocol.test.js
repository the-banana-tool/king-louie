// tests/gui-helper-protocol.test.js
//
// The service's HelperChannel against the real helper connection (with a fake
// backend) and against raw, misbehaving clients, over a real pipe or socket.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const P = require('../src/gui/helper-protocol');
const { HelperChannel } = require('../src/gui/helper-channel');
const { connectToService, createOpHandler } = require('../src/session/connection');
const { setLogLevel } = require('../src/logging');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const SECRET = crypto.randomBytes(32);
const NODE_ID = 'kl-hnef32472qzibi5r';
const PROBE = { capabilities: ['gui.launch', 'gui.screenshot', 'gui.input'], probes: [{ check: 'accessibility', ok: true }], displays: [], limits: [], locked: false };

function tempEndpoint() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\kl-session-test-${crypto.randomBytes(8).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kls-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'h.sock');
}

function fakeBackend(overrides = {}) {
  const calls = [];
  const rec = (name, value) => async (params) => { calls.push({ name, params }); return typeof value === 'function' ? value(params) : value; };
  return {
    calls,
    probe: rec('probe', PROBE),
    launch: rec('launch', { pid: 4242 }),
    processes: rec('processes', []),
    windows: rec('windows', []),
    foreground: rec('foreground', { handle: 'h1', pid: 10, image: '/usr/bin/gedit', bounds: { x: 0, y: 0, w: 800, h: 600 }, scale: 1 }),
    focus: rec('focus', { focused: true }),
    close: rec('close', { closed: [] }),
    screenshot: rec('screenshot', { mime: 'image/jpeg', width: 1, height: 1, data: '', transform: { sx: 1, sy: 1, unit: 'px' } }),
    input: rec('input', { foregroundAfter: { image: '/usr/bin/gedit', pid: 10 } }),
    releaseAll: rec('releaseAll', null),
    locked: rec('locked', false),
    stop: async () => {},
    ...overrides
  };
}

const audits = [];
const audit = { append: async (e) => { audits.push(e); } };

async function startChannel(options = {}) {
  const endpoint = tempEndpoint();
  const state = { mtime: 1 };
  const channel = new HelperChannel({
    endpoint, audit, readSecret: () => ({ secret: SECRET, nodeId: NODE_ID, sessionUser: 'alice', mtimeMs: state.mtime }),
    readMtime: () => state.mtime, pingMs: 60000, ...options
  });
  await channel.start();
  cleanups.push(() => channel.stop());
  return { channel, endpoint, state };
}

function helper(endpoint, { backend = fakeBackend(), secret = SECRET, user = 'alice', nodeId = NODE_ID } = {}) {
  return connectToService({
    endpoint, secret, nodeId, user, platform: 'linux', pid: 7, helperVersion: 'test',
    probeReport: PROBE, handleOp: createOpHandler(backend, { platform: process.platform })
  }).then((session) => { cleanups.push(() => session.close()); return session; });
}

// A client that speaks the handshake by hand, then does what the test says.
async function rawHandshake(endpoint, { secret = SECRET, user = 'alice', nodeId = NODE_ID, probe = true } = {}) {
  const socket = net.createConnection(endpoint);
  socket.on('error', () => {});
  await once(socket, 'connect');
  cleanups.push(() => socket.destroy());
  const decoder = new P.FrameDecoder({ maxBytes: P.SEALED_MAX });
  const frames = [];
  let waiter = null;
  socket.on('data', (chunk) => {
    decoder.push(chunk);
    let body;
    while ((body = decoder.next())) { frames.push(body); if (waiter) waiter(); }
  });
  const nextFrame = () => new Promise((resolve) => {
    const take = () => { if (frames.length) { waiter = null; resolve(frames.shift()); } else waiter = take; };
    take();
  });
  const nonceH = P.randomNonce();
  socket.write(P.encodeFrame({ t: 'hello', v: 1, node_id: nodeId, nonce_h: nonceH, pid: 1, user, platform: 'linux', helper_version: 'raw' }));
  const challenge = P.parsePlain(await nextFrame());
  socket.write(P.encodeFrame({ t: 'auth', proof_h: P.helperProof(secret, nodeId, challenge.nonce_s, nonceH) }));
  const ready = P.parsePlain(await nextFrame());
  const { kSh, kHs } = P.deriveSessionKeys(secret, nodeId, nonceH, challenge.nonce_s);
  const raw = { socket, ready, sealer: P.createSealer(kHs, P.DIR_HS), opener: P.createOpener(kSh, P.DIR_SH), nextFrame, closed: once(socket, 'close') };
  if (probe && ready.t === 'ready') socket.write(raw.sealer.seal({ t: 'probe_report', ...PROBE }));
  return raw;
}

afterEach(() => { audits.length = 0; });

describe('handshake', () => {
  it('a helper with the secret connects; the channel is ready and serves ops', async () => {
    const { channel, endpoint } = await startChannel();
    const backend = fakeBackend();
    const readyEvent = once(channel, 'ready');
    await helper(endpoint, { backend });
    const [info] = await readyEvent;
    assert.deepEqual(info.capabilities, PROBE.capabilities);
    assert.equal(info.user, 'alice');
    assert.equal(channel.connected, true);
    const fg = await channel.request('foreground', {}, { jobId: 'job-1' });
    assert.equal(fg.image, '/usr/bin/gedit');
    assert.equal(backend.calls[backend.calls.length - 1].name, 'foreground');
    assert.ok(audits.some((a) => a.kind === 'gui.helper.connected'));
  });

  it('the service proof is checked first: a helper with another secret never sends auth', async () => {
    const { channel, endpoint } = await startChannel();
    let ready = false;
    channel.on('ready', () => { ready = true; });
    await assert.rejects(helper(endpoint, { secret: crypto.randomBytes(32) }), (e) => e.code === 'auth_failed' && e.detail === 'service');
    assert.equal(ready, false);
  });

  it('a helper proof that fails is audited on the service side and closed', async () => {
    const { endpoint } = await startChannel();
    const socket = net.createConnection(endpoint);
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(P.encodeFrame({ t: 'hello', v: 1, node_id: NODE_ID, nonce_h: P.randomNonce(), pid: 1, user: 'alice', platform: 'linux', helper_version: 'raw' }));
    await once(socket, 'data');
    socket.write(P.encodeFrame({ t: 'auth', proof_h: 'A'.repeat(43) }));
    await once(socket, 'close');
    assert.ok(audits.some((a) => a.kind === 'gui.helper.auth_failed' && a.data.side === 'helper'));
  });

  it('a hello from another user, or for another node, is closed before any challenge', async () => {
    const { endpoint } = await startChannel();
    for (const hello of [{ user: 'mallory', node_id: NODE_ID }, { user: 'alice', node_id: 'kl-c2ubd6jjqumalzt5' }]) {
      const socket = net.createConnection(endpoint);
      socket.on('error', () => {});
      await once(socket, 'connect');
      let got = 0;
      socket.on('data', () => { got += 1; });
      socket.write(P.encodeFrame({ t: 'hello', v: 1, nonce_h: P.randomNonce(), pid: 1, platform: 'linux', helper_version: 'raw', ...hello }));
      await once(socket, 'close');
      assert.equal(got, 0, JSON.stringify(hello));
    }
  });

  it('an oversize pre-auth frame, a non-handshake frame, or silence closes the connection', async () => {
    const { endpoint } = await startChannel({ handshakeMs: 200 });
    const big = net.createConnection(endpoint);
    big.on('error', () => {});
    await once(big, 'connect');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(P.PLAIN_MAX + 1);
    big.write(len);
    await once(big, 'close');

    const req = net.createConnection(endpoint);
    req.on('error', () => {});
    await once(req, 'connect');
    req.write(P.encodeFrame({ t: 'req', id: 1, op: 'input', params: {} }));
    await once(req, 'close');

    const quiet = net.createConnection(endpoint);
    quiet.on('error', () => {});
    await once(quiet, 'connect');
    const started = Date.now();
    await once(quiet, 'close');
    assert.ok(Date.now() - started >= 150, 'closed by the handshake timer');
  });

  it('at most 4 unauthenticated connections at once', async () => {
    const { endpoint } = await startChannel({ handshakeMs: 2000 });
    const open4 = [];
    for (let i = 0; i < 4; i += 1) {
      const s = net.createConnection(endpoint);
      s.on('error', () => {});
      await once(s, 'connect');
      open4.push(s);
      cleanups.push(() => s.destroy());
    }
    await new Promise((r) => setTimeout(r, 50));
    const fifth = net.createConnection(endpoint);
    fifth.on('error', () => {});
    const started = Date.now();
    await once(fifth, 'close');
    assert.ok(Date.now() - started < 1000, 'the fifth is dropped at once');
    assert.ok(open4.every((s) => !s.destroyed));
  });
});

describe('sealing', () => {
  it('relay MITM: a proxy that forwards the handshake and then injects a req gets the helper closed, nothing executed', async () => {
    const { channel, endpoint } = await startChannel();
    const proxyPath = tempEndpoint();
    let helperSide = null;
    const proxy = net.createServer((client) => {
      helperSide = client;
      const upstream = net.createConnection(endpoint);
      client.on('error', () => {});
      upstream.on('error', () => {});
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise((r) => proxy.listen(proxyPath, r));
    cleanups.push(() => new Promise((r) => proxy.close(() => r())));
    const backend = fakeBackend();
    const readyEvent = once(channel, 'ready');
    const session = await helper(proxyPath, { backend });
    await readyEvent;
    const probeCalls = backend.calls.length;
    const closed = once(session, 'closed');
    helperSide.write(P.encodeFrame({ t: 'req', id: 99, op: 'input', job_id: 'x', lease_id: null, params: { action: { kind: 'type', text: 'rm -rf /' } } }));
    await closed;
    assert.equal(backend.calls.length, probeCalls, 'the injected req never reached the backend');
    assert.ok(!backend.calls.some((c) => c.name === 'input'));
  });

  it('a MITM frame toward the service closes it too', async () => {
    const { channel, endpoint } = await startChannel();
    const raw = await rawHandshake(endpoint);
    await once(channel, 'ready');
    const closed = once(channel, 'closed');
    raw.socket.write(P.encodeFrame({ t: 'res', id: 1, ok: true, result: null }));
    await closed;
  });

  for (const [name, attack] of [
    ['a skipped sequence number', (raw) => { raw.sealer.seal({ t: 'pong' }); raw.socket.write(raw.sealer.seal({ t: 'pong' })); }],
    ['a replayed frame', (raw) => { const f = raw.sealer.seal({ t: 'pong' }); raw.socket.write(f); raw.socket.write(f); }],
    ['a tampered tag', (raw) => { const f = raw.sealer.seal({ t: 'pong' }); f[f.length - 1] ^= 1; raw.socket.write(f); }]
  ]) {
    it(`${name} closes the connection`, async () => {
      const { channel, endpoint } = await startChannel();
      const raw = await rawHandshake(endpoint);
      await once(channel, 'ready');
      const closed = once(channel, 'closed');
      attack(raw);
      await closed;
      assert.equal(channel.connected, false);
    });
  }
});

describe('lifetime', () => {
  it('rotating the canonical secret drops the connection', async () => {
    const { channel, endpoint, state } = await startChannel({ pingMs: 40 });
    await helper(endpoint);
    await once(channel, 'ready');
    const closed = once(channel, 'closed');
    state.mtime = 2;
    const [reason] = await closed;
    assert.equal(reason, 'rotated');
  });

  it('a second helper is refused while the first answers ping, and replaces a silent one', async () => {
    const { channel, endpoint } = await startChannel({ duplicatePingMs: 200 });
    await helper(endpoint);
    await once(channel, 'ready');
    await assert.rejects(helper(endpoint), (e) => e.code === 'helper_already_connected');
    assert.equal(channel.connected, true);

    const { channel: c2, endpoint: e2 } = await startChannel({ duplicatePingMs: 200 });
    const raw = await rawHandshake(e2);
    await once(c2, 'ready');
    // raw never answers ping.
    const readyAgain = once(c2, 'ready');
    const replacement = await helper(e2);
    await raw.closed;
    // `connected` is true only once the replacement's probe_report has arrived.
    await readyAgain;
    assert.ok(replacement);
    assert.ok(audits.some((a) => a.kind === 'gui.helper.replaced'));
    assert.equal(c2.connected, true);
  });

  it('an op past its timeout is op_timeout; a drop rejects what is in flight', async () => {
    const { channel, endpoint } = await startChannel();
    const hang = fakeBackend({ foreground: () => new Promise(() => {}) });
    const session = await helper(endpoint, { backend: hang });
    await once(channel, 'ready');
    await assert.rejects(channel.request('foreground', {}, { timeoutMs: 80 }), (e) => e.code === 'op_timeout');
    const inflight = channel.request('foreground', {});
    session.close();
    await assert.rejects(inflight, (e) => e.code === 'helper_disconnected');
    await assert.rejects(channel.request('foreground', {}), (e) => e.code === 'helper_disconnected');
    assert.ok(audits.some((a) => a.kind === 'gui.helper.disconnected'));
  });

  it('helper errors come back with their code', async () => {
    const { GuiError } = require('../src/gui/errors');
    const { channel, endpoint } = await startChannel();
    await helper(endpoint, { backend: fakeBackend({ input: async () => { throw new GuiError('foreground_mismatch', null, { info: { image: 'C:\\Windows\\explorer.exe', pid: 4 } }); } }) });
    await once(channel, 'ready');
    await assert.rejects(channel.request('input', { expect: { match: [], pids: [] }, yield_ms: 0, action: { kind: 'key', mods: [], key: 'a', repeat: 1 } }),
      (e) => e.code === 'foreground_mismatch' && e.info.image === 'C:\\Windows\\explorer.exe');
  });

  it('the helper refuses a launch whose path moved before spawning', async () => {
    const backend = fakeBackend();
    const handle = createOpHandler(backend, { platform: process.platform });
    await assert.rejects(handle('launch', { exe: path.join(os.tmpdir(), 'kl-no-such-app'), argv: [], files: [] }), (e) => e.code === 'path_changed');
    assert.equal(backend.calls.length, 0);
    await assert.rejects(handle('clipboard', {}), (e) => e.code === 'unknown_op');
    await assert.rejects(createOpHandler(null)('foreground', {}), (e) => e.code === 'capability_unavailable');
  });
});
