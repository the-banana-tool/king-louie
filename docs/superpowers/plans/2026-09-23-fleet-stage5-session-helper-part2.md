# Fleet Stage 5: Session helper — Implementation Plan (Part 2 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The header — Goal, Architecture, the owner's questions and rulings (2026-10-12), what was checked against main `532efcf`, **Global Constraints**, **Review Focus**, Interfaces from other stages, **Deviations** (1–44) and the task table with review weights — is in Part 1 (`2026-09-23-fleet-stage5-session-helper-part1.md`) and applies to every task here. Part 2 builds on Part 1's commits (Tasks 1–6) on `feat/fleet-stage5`.

**This part:** the service runtime. Task 7 the `kl-session-v1` channel (service side) and the helper's connection (helper side); Task 8 the status file and the GUI broker; Task 9 the lease manager; Task 10 the live view; Task 11 the relay routes.

---

### Task 7: The helper channel (service) and the helper connection (helper)

**Review:** trust (who may speak to the service as the helper, and what each side accepts). **On Windows:** the suite runs over named pipes; the Unix-socket branch of `HelperChannel.start` (`lstat` refusal of a symlink, `chmod 0666`) runs only on POSIX.

**Files:**
- Create: `src/gui/helper-channel.js`
- Create: `src/session/connection.js`
- Test: `tests/gui-helper-protocol.test.js`

**Interfaces:**
- Consumes: `helper-protocol.js` (Task 4); `GuiError`, `fromWire` (Task 1); `assertPathsUnchanged` (Task 2); `LEASE_LIMITS` (Task 6).
- Produces:
  - `src/gui/helper-channel.js`: `class HelperChannel extends EventEmitter` — `new HelperChannel({ endpoint, readSecret, readMtime = () => null, platform = process.platform, audit = null, clock = Date.now, log, handshakeMs = 5000, pingMs = 10000, silenceMs = 30000, duplicatePingMs = 5000, maxUnauthenticated = 4 })`; `start() → Promise`, `stop() → Promise`; getters `connected`, `info` (`{ user, platform, pid, capabilities, probes, displays, limits, locked, since } | null`); `request(op, params = {}, { jobId = null, leaseId = null, timeoutMs } = {}) → Promise<result>` (rejects `GuiError`: `helper_disconnected`, `op_timeout`, or the helper's code via `fromWire`). Events: `'ready'(info)` on the helper's first `probe_report`; `'closed'(reason)`; `'event'(kind, data)` for `locked`, `unlocked`, `displays_changed`, `probe_changed`. `readSecret() → { secret, nodeId, sessionUser, mtimeMs }` (Task 5's `readCanonical` in production). `OP_TIMEOUTS`, `GUI_CAPABILITIES = ['gui.launch', 'gui.screenshot', 'gui.input']`.
  - `src/session/connection.js`: `connectToService({ endpoint, secret, nodeId, user, platform, pid, helperVersion, probeReport, handleOp, net, handshakeMs = 5000, log }) → Promise<HelperSession>` (rejects `GuiError('auth_failed', 'service')` when the service's proof fails, `GuiError('helper_already_connected')`, `GuiError('frame_rejected')`); `HelperSession extends EventEmitter` with `sendEvent(kind, data)`, `close()`, event `'closed'(reason)`; `createOpHandler(backend, { platform }) → (op, params, ctx) → Promise<result>` (throws `unknown_op`, `capability_unavailable` when `backend` is null, `path_changed` before a launch).

- [ ] **Step 1: Write the failing test**

Create `tests/gui-helper-protocol.test.js`:

```js
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
    const replacement = await helper(e2);
    await raw.closed;
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-helper-protocol.test.js`
Expected: FAIL with `Cannot find module '../src/gui/helper-channel'`.

- [ ] **Step 3: Write `src/gui/helper-channel.js`**

```js
// src/gui/helper-channel.js
// The service side of kl-session-v1 (fleet stage 5 spec §3.2): a pipe or
// socket any local account can open, where only a peer holding the session
// secret gets past the handshake, and every frame after it is sealed.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { createLogger } = require('../logging');
const P = require('./helper-protocol');
const { GuiError, fromWire } = require('./errors');
const { LEASE_LIMITS } = require('./lease-protocol');

const OP_TIMEOUTS = Object.freeze({ screenshot: 20000, launch: 30000 });
const DEFAULT_OP_TIMEOUT = 10000;
const GUI_CAPABILITIES = Object.freeze(['gui.launch', 'gui.screenshot', 'gui.input']);
const EVENT_KINDS = Object.freeze(['locked', 'unlocked', 'displays_changed', 'probe_changed']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

// What the helper reports is the user's process speaking: keep only known
// capabilities and limits, and bound every list.
function sanitizeProbe(msg) {
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    capabilities: list(msg.capabilities, 8).filter((c) => GUI_CAPABILITIES.includes(c)),
    probes: list(msg.probes, 32).filter(isPlainObject).map((p) => ({
      check: String(p.check || '').slice(0, 64), ok: p.ok === true, ...(p.hint ? { hint: String(p.hint).slice(0, 300) } : {})
    })),
    displays: list(msg.displays, 16).filter(isPlainObject),
    limits: list(msg.limits, 4).filter((l) => LEASE_LIMITS.includes(l)),
    locked: msg.locked === true
  };
}

class HelperChannel extends EventEmitter {
  constructor({ endpoint, readSecret, readMtime = () => null, platform = process.platform, audit = null, clock = Date.now,
    log = createLogger('gui/channel'), handshakeMs = 5000, pingMs = 10000, silenceMs = 30000, duplicatePingMs = 5000, maxUnauthenticated = 4 } = {}) {
    super();
    Object.assign(this, { endpoint, readSecret, readMtime, platform, audit, clock, log, handshakeMs, pingMs, silenceMs, duplicatePingMs, maxUnauthenticated });
    this.server = null;
    this.unauth = new Set();
    this.all = new Set();
    this.current = null;
  }

  get connected() {
    return Boolean(this.current && this.current.probe);
  }

  get info() {
    const c = this.current;
    if (!c || !c.probe) return null;
    return { user: c.hello.user, platform: c.hello.platform, pid: c.hello.pid, ...c.probe, since: c.since };
  }

  async start() {
    if (this.platform !== 'win32') {
      try {
        const st = fs.lstatSync(this.endpoint);
        if (st.isSymbolicLink()) throw new GuiError('unsafe_path', this.endpoint);
        fs.unlinkSync(this.endpoint);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    this.server = net.createServer((socket) => this._onSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      const options = this.platform === 'win32' ? { path: this.endpoint, readableAll: true, writableAll: true } : { path: this.endpoint };
      this.server.listen(options, () => { this.server.off('error', reject); resolve(); });
    });
    // The helper is another account: the protocol, not the mode, is the boundary.
    if (this.platform !== 'win32') fs.chmodSync(this.endpoint, 0o666);
  }

  async stop() {
    for (const conn of this.all) this._destroy(conn, 'service_stopped');
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    if (this.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch { /* already gone */ }
    }
  }

  request(op, params = {}, { jobId = null, leaseId = null, timeoutMs } = {}) {
    const conn = this.current;
    if (!conn || !conn.probe) return Promise.reject(new GuiError('helper_disconnected'));
    const id = conn.nextId;
    conn.nextId += 1;
    return new Promise((resolve, reject) => {
      const ms = timeoutMs || OP_TIMEOUTS[op] || DEFAULT_OP_TIMEOUT;
      const timer = unref(setTimeout(() => {
        conn.pending.delete(id);
        reject(new GuiError('op_timeout', `${op} took over ${ms} ms`));
      }, ms));
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.socket.write(conn.sealer.seal({ t: 'req', id, op, job_id: jobId, lease_id: leaseId, params }));
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(err);
      }
    });
  }

  _audit(kind, data) {
    if (!this.audit) return;
    Promise.resolve().then(() => this.audit.append({ kind, data })).catch((err) => this.log.warn(`audit ${kind} failed: ${err.message}`));
  }

  _onSocket(socket) {
    socket.on('error', () => {});
    if (this.unauth.size >= this.maxUnauthenticated) {
      socket.destroy();
      return;
    }
    const conn = { socket, state: 'hello', decoder: new P.FrameDecoder({ maxBytes: P.PLAIN_MAX }), dead: false, probe: null };
    this.unauth.add(conn);
    this.all.add(conn);
    conn.timer = unref(setTimeout(() => this._destroy(conn, 'handshake_timeout'), this.handshakeMs));
    socket.on('data', (chunk) => this._onData(conn, chunk));
    socket.on('close', () => this._onClose(conn));
  }

  _onData(conn, chunk) {
    if (conn.dead) return;
    try {
      conn.decoder.push(chunk);
      let body;
      while (!conn.dead && (body = conn.decoder.next())) this._onFrame(conn, body);
    } catch (err) {
      const reason = err.code === 'frame_rejected' ? `frame_rejected: ${err.detail}` : err.message;
      if (conn.state !== 'ready') this._audit('gui.helper.auth_failed', { side: 'helper', reason });
      this._destroy(conn, reason);
    }
  }

  _onFrame(conn, body) {
    if (conn.state === 'ready') {
      this._onSealed(conn, conn.opener.open(body));
      return;
    }
    const msg = P.parsePlain(body);
    if (conn.state === 'hello') {
      if (msg.t !== 'hello' || msg.v !== 1 || !P.NONCE_RE.test(String(msg.nonce_h))) throw new GuiError('frame_rejected', 'expected hello');
      let canonical;
      try {
        canonical = this.readSecret();
      } catch (err) {
        this.log.error(`the session secret cannot be read: ${err.message}`);
        this._destroy(conn, 'no_secret');
        return;
      }
      // Windows account names are case-insensitive; `session install` stores the bare name.
      const sameUser = this.platform === 'win32'
        ? String(msg.user).toLowerCase() === String(canonical.sessionUser).toLowerCase()
        : msg.user === canonical.sessionUser;
      if (msg.node_id !== canonical.nodeId || !sameUser) {
        this._authFailed(conn, msg.node_id !== canonical.nodeId ? 'node_id differs from the canonical file' : 'user is not the session user');
        return;
      }
      Object.assign(conn, { hello: msg, secret: canonical.secret, nodeId: canonical.nodeId, mtimeMs: canonical.mtimeMs, nonceH: msg.nonce_h, nonceS: P.randomNonce(), state: 'auth' });
      conn.socket.write(P.encodeFrame({ t: 'challenge', v: 1, nonce_s: conn.nonceS, proof_s: P.serviceProof(conn.secret, conn.nodeId, conn.nonceH, conn.nonceS) }));
      return;
    }
    if (conn.state === 'auth' && msg.t === 'auth') {
      if (!P.proofEquals(msg.proof_h, P.helperProof(conn.secret, conn.nodeId, conn.nonceS, conn.nonceH))) {
        this._authFailed(conn, 'bad helper proof');
        return;
      }
      conn.state = 'deciding';
      this._admit(conn).catch((err) => this._destroy(conn, err.message));
      return;
    }
    throw new GuiError('frame_rejected', `unexpected ${String(msg.t).slice(0, 32)} frame`);
  }

  _authFailed(conn, reason) {
    this.log.warn(`session helper refused: ${reason}`);
    this._audit('gui.helper.auth_failed', { side: 'helper', reason });
    this._destroy(conn, 'auth_failed');
  }

  async _admit(conn) {
    const old = this.current;
    if (old && !old.dead) {
      if (await this._pingOnce(old, this.duplicatePingMs)) {
        if (!conn.dead) conn.socket.end(P.encodeFrame({ t: 'error', code: 'helper_already_connected' }));
        this._destroy(conn, 'helper_already_connected', { end: true });
        return;
      }
      this._audit('gui.helper.replaced', { old_pid: old.hello.pid, new_pid: conn.hello.pid });
      this._destroy(old, 'replaced');
    }
    if (conn.dead) return;
    clearTimeout(conn.timer);
    this.unauth.delete(conn);
    const { kSh, kHs } = P.deriveSessionKeys(conn.secret, conn.nodeId, conn.nonceH, conn.nonceS);
    Object.assign(conn, {
      sealer: P.createSealer(kSh, P.DIR_SH), opener: P.createOpener(kHs, P.DIR_HS),
      pending: new Map(), nextId: 1, lastHeard: this.clock(), pongWaiters: []
    });
    conn.socket.write(P.encodeFrame({ t: 'ready', session_id: crypto.randomUUID() }));
    conn.decoder.setMax(P.SEALED_MAX);
    conn.state = 'ready';
    this.current = conn;
    conn.pingTimer = unref(setInterval(() => this._tick(conn), this.pingMs));
    this._onData(conn, Buffer.alloc(0));
  }

  _pingOnce(conn, ms) {
    return new Promise((resolve) => {
      if (conn.dead || conn.state !== 'ready') { resolve(false); return; }
      const timer = unref(setTimeout(() => { conn.pongWaiters = conn.pongWaiters.filter((w) => w !== done); resolve(false); }, ms));
      const done = () => { clearTimeout(timer); resolve(true); };
      conn.pongWaiters.push(done);
      try {
        conn.socket.write(conn.sealer.seal({ t: 'ping' }));
      } catch {
        resolve(false);
      }
    });
  }

  _tick(conn) {
    if (conn.dead) return;
    if (this.clock() - conn.lastHeard > this.silenceMs) { this._destroy(conn, 'silent'); return; }
    const mtime = this.readMtime();
    if (mtime !== null && conn.mtimeMs !== undefined && mtime !== conn.mtimeMs) { this._destroy(conn, 'rotated'); return; }
    try {
      conn.socket.write(conn.sealer.seal({ t: 'ping' }));
    } catch (err) {
      this._destroy(conn, err.message);
    }
  }

  _onSealed(conn, msg) {
    conn.lastHeard = this.clock();
    switch (msg.t) {
      case 'probe_report': {
        const first = conn.probe === null;
        conn.probe = sanitizeProbe(msg);
        if (first) {
          conn.since = new Date(this.clock()).toISOString();
          const info = this.info;
          this._audit('gui.helper.connected', { user: info.user, platform: info.platform, pid: info.pid, capabilities: info.capabilities });
          this.emit('ready', info);
        } else {
          this.emit('event', 'probe_changed', this.info);
        }
        return;
      }
      case 'res': {
        const p = conn.pending.get(msg.id);
        if (!p) return;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result);
        else p.reject(fromWire(msg.error));
        return;
      }
      case 'event': {
        if (!EVENT_KINDS.includes(msg.kind)) return;
        const data = isPlainObject(msg.data) ? msg.data : {};
        if (!conn.probe) return;
        if (msg.kind === 'locked' || msg.kind === 'unlocked') conn.probe.locked = msg.kind === 'locked';
        if (msg.kind === 'probe_changed') {
          conn.probe = sanitizeProbe({ ...data, locked: conn.probe.locked });
          this.emit('event', 'probe_changed', this.info);
          return;
        }
        this.emit('event', msg.kind, data);
        return;
      }
      case 'ping':
        conn.socket.write(conn.sealer.seal({ t: 'pong' }));
        return;
      case 'pong': {
        const waiters = conn.pongWaiters;
        conn.pongWaiters = [];
        for (const w of waiters) w();
        return;
      }
      default:
        throw new GuiError('frame_rejected', 'unknown sealed frame');
    }
  }

  _destroy(conn, reason, { end = false } = {}) {
    if (conn.dead) return;
    conn.dead = true;
    conn.closeReason = reason;
    clearTimeout(conn.timer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (!end) conn.socket.destroy();
    this.unauth.delete(conn);
    this._onClose(conn);
  }

  _onClose(conn) {
    if (!conn.dead) {
      conn.dead = true;
      conn.closeReason = conn.closeReason || 'closed';
      clearTimeout(conn.timer);
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      this.unauth.delete(conn);
    }
    if (conn.finished) return;
    conn.finished = true;
    this.all.delete(conn);
    if (this.current !== conn) return;
    this.current = null;
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GuiError('helper_disconnected'));
    }
    conn.pending.clear();
    if (conn.probe) {
      this._audit('gui.helper.disconnected', { reason: conn.closeReason });
      this.emit('closed', conn.closeReason);
    }
  }
}

module.exports = { HelperChannel, OP_TIMEOUTS, GUI_CAPABILITIES, sanitizeProbe };
```

- [ ] **Step 4: Write `src/session/connection.js`**

```js
// src/session/connection.js
// The helper side of kl-session-v1 (fleet stage 5 spec §3.2, §3.3). The
// helper authenticates the service before it sends anything but `hello`,
// and runs only what the service asks, through its OS backend.
const { EventEmitter } = require('events');
const netModule = require('net');
const { createLogger } = require('../logging');
const P = require('../gui/helper-protocol');
const { GuiError, isGuiError } = require('../gui/errors');
const { assertPathsUnchanged } = require('../gui/apps');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createOpHandler(backend, { platform = process.platform } = {}) {
  const ops = {
    launch: (p) => {
      // Re-resolved here, as the user, just before spawning (§3.4).
      assertPathsUnchanged({ exe: p.exe, files: p.files || [] }, { platform });
      return backend.launch({ exe: p.exe, argv: p.argv || [], files: p.files || [] });
    },
    processes: (p) => backend.processes({ match: p.match || [] }),
    windows: (p) => backend.windows({ pids: p.pids || [] }),
    foreground: () => backend.foreground(),
    focus: (p) => backend.focus({ handle: p.handle }),
    close: (p) => backend.close({ pids: p.pids || [], force: p.force === true }),
    screenshot: (p) => backend.screenshot({ handle: p.handle, maxWidth: p.max_width, quality: p.quality }),
    input: (p) => backend.input({ expect: p.expect, action: p.action, yieldMs: p.yield_ms }),
    release_all: () => backend.releaseAll(),
    probe: () => backend.probe()
  };
  return async (op, params = {}) => {
    if (!Object.hasOwn(ops, op)) throw new GuiError('unknown_op', String(op).slice(0, 32));
    if (!backend) throw new GuiError('capability_unavailable', 'gui');
    return ops[op](isPlainObject(params) ? params : {});
  };
}

class HelperSession extends EventEmitter {
  constructor(socket, sealer, opener, decoder, handleOp, log) {
    super();
    Object.assign(this, { socket, sealer, opener, decoder, handleOp, log, closed: false });
  }

  _send(obj) {
    if (!this.closed) this.socket.write(this.sealer.seal(obj));
  }

  sendEvent(kind, data = {}) {
    this._send({ t: 'event', kind, data });
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('closed', reason);
  }

  _onFrame(body) {
    const msg = this.opener.open(body);
    if (msg.t === 'ping') { this._send({ t: 'pong' }); return; }
    if (msg.t === 'pong') return;
    if (msg.t !== 'req' || !Number.isInteger(msg.id)) throw new GuiError('frame_rejected', 'unexpected frame');
    Promise.resolve()
      .then(() => this.handleOp(msg.op, msg.params, { jobId: msg.job_id || null, leaseId: msg.lease_id || null }))
      .then((result) => this._send({ t: 'res', id: msg.id, ok: true, result: result === undefined ? null : result }))
      .catch((err) => {
        const code = isGuiError(err) ? err.code : 'backend_failed';
        if (!isGuiError(err)) this.log.warn(`${msg.op} failed: ${err.message}`);
        this._send({ t: 'res', id: msg.id, ok: false, error: { code, message: String(err.message || code).slice(0, 300), detail: isGuiError(err) ? err.info || {} : {} } });
      });
  }
}

function connectToService({ endpoint, secret, nodeId, user, platform = process.platform, pid = process.pid, helperVersion = 'unknown',
  probeReport, handleOp, net = netModule, handshakeMs = 5000, log = createLogger('session-helper/connection') }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const decoder = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    const nonceH = P.randomNonce();
    let state = 'challenge';
    let session = null;
    let nonceS = null;
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      if (session) session.close(err.message);
      else reject(err);
    };
    const timer = setTimeout(() => fail(new GuiError('op_timeout', 'handshake')), handshakeMs);
    socket.on('error', (err) => fail(new GuiError('helper_disconnected', err.code || err.message)));
    socket.on('close', () => {
      clearTimeout(timer);
      if (session) session.close('disconnected');
      else reject(new GuiError('helper_disconnected', 'the service closed the connection'));
    });
    socket.on('connect', () => {
      socket.write(P.encodeFrame({ t: 'hello', v: 1, node_id: nodeId, nonce_h: nonceH, pid, user, platform, helper_version: helperVersion }));
    });
    socket.on('data', (chunk) => {
      try {
        decoder.push(chunk);
        let body;
        while ((body = decoder.next())) {
          if (state === 'ready') { session._onFrame(body); continue; }
          const msg = P.parsePlain(body);
          if (state === 'challenge') {
            if (msg.t !== 'challenge' || !P.NONCE_RE.test(String(msg.nonce_s))) throw new GuiError('frame_rejected', 'expected challenge');
            // The service proves itself first; a wrong proof sends nothing more.
            if (!P.proofEquals(msg.proof_s, P.serviceProof(secret, nodeId, nonceH, msg.nonce_s))) throw new GuiError('auth_failed', 'service');
            nonceS = msg.nonce_s;
            socket.write(P.encodeFrame({ t: 'auth', proof_h: P.helperProof(secret, nodeId, nonceS, nonceH) }));
            state = 'ready_wait';
            continue;
          }
          if (state === 'ready_wait') {
            if (msg.t === 'error') throw new GuiError(msg.code === 'helper_already_connected' ? 'helper_already_connected' : 'auth_failed', msg.code === 'helper_already_connected' ? null : 'service');
            if (msg.t !== 'ready') throw new GuiError('frame_rejected', 'expected ready');
            const { kSh, kHs } = P.deriveSessionKeys(secret, nodeId, nonceH, nonceS);
            decoder.setMax(P.SEALED_MAX);
            session = new HelperSession(socket, P.createSealer(kHs, P.DIR_HS), P.createOpener(kSh, P.DIR_SH), decoder, handleOp, log);
            state = 'ready';
            clearTimeout(timer);
            session._send({ t: 'probe_report', ...probeReport });
            resolve(session);
          }
        }
      } catch (err) {
        fail(isGuiError(err) ? err : new GuiError('frame_rejected', err.message));
      }
    });
  });
}

module.exports = { connectToService, createOpHandler, HelperSession };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/gui-helper-protocol.test.js`
Expected: PASS, `# fail 0`. On Windows the endpoints are named pipes; elsewhere Unix sockets under a short temp dir.

- [ ] **Step 6: Commit**

```bash
git add src/gui/helper-channel.js src/session/connection.js tests/gui-helper-protocol.test.js
git commit -m "feat(gui): kl-session-v1 channel and the helper connection

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The status file and the GUI broker

**Review:** trust (screenshot scope, coordinate mapping, what `list_machines` shows). **On Windows:** all of it can be checked.

R-F5-7 in this task (Deviation 43): the broker keeps per-job state (launched pids, screenshots) only for a run that has a job id.

**Files:**
- Create: `src/gui/status.js`
- Create: `src/gui/broker.js`
- Test: `tests/gui-broker.test.js`

**Interfaces:**
- Consumes: `HelperChannel` events and `request` (Task 7); `GuiError` (Task 1); `imageMatches`, `matchSetFor` (Task 2); `readPidfile`, `isRunning` (`src/service/pidfile.js`).
- Produces:
  - `src/gui/status.js`: `statusPath(dataDir)`; `writeGuiStatus(dataDir, record)` (atomic, `0600`); `readGuiStatusRecord({ dataDir, now, readPid, isRunning }) → record | null` (null unless `pid` is the live pidfile process and `updated_at` < 30 s old); `readGuiStatus({ dataDir, now, readPid, isRunning }) → { available, capabilities, apps: [{ id, name }], limits, lease: { active } | null }` (the MCP-safe block, Deviation 7); `STALE_MS = 30000`.
  - `src/gui/broker.js`: `class GuiBroker extends EventEmitter` — `new GuiBroker({ channel, guiConfig, getPolicy = () => ({}), audit = null, dataDir = null, platform = process.platform, clock = Date.now, log, heartbeatMs = 10000, realpath })`; `setLeases(leases)`; `start()`, `stop()`; `capability() → { available, capabilities, user, platform, since, apps: [{ id, name }], limits, locked, lease: { active, appIds, expiresAt } | null }`; `require(sub)`; getter `locked`; `listApps(ctx)`; `launch(resolution, ctx, { approvedBy }) → { app_id, pid, tier, launched_at }`; `close(appId, force, ctx) → { closed }`; `screenshot({ app, maxWidth }, ctx) → { screenshotId, appId, width, height, mime, data, transform, capturedAt, sha256, bytes }`; `captureFrame({ appIds, maxWidth, quality }) → { appId, width, height, data, bytes, sha256 } | { appId: null }`; `mapPoint(jobId, screenshotId, x, y, appIds) → { handle, rel: [x, y], appId }`; `expectFor(appIds) → Promise<{ match, pids }>`; `input(action, { jobId, leaseId, appIds, yieldMs }) → { foregroundBefore, foregroundAfter, afterMatches, afterAppId }`; `releaseAll()`; `focusApp(appIds)`; `foregroundApp(appIds) → Promise<{ appId, image } | null>`. `ctx = { jobId, leaseId }`. Event `'capability'(snapshot)`.
  - `SUSPENDING_CODES = ['foreground_mismatch', 'app_not_running', 'helper_disconnected']`, `suspendsLease(code) → boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-broker.test.js`:

```js
// tests/gui-broker.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuiBroker, suspendsLease } = require('../src/gui/broker');
const { readGuiStatus, readGuiStatusRecord, statusPath } = require('../src/gui/status');
const { parseGuiConfig } = require('../src/gui/config');
const { GuiError } = require('../src/gui/errors');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

const APPS = {
  calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
  notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' }
};
const guiConfig = parseGuiConfig({ apps: APPS }, { platform: 'win32' });
const INFO = { user: 'alice', platform: 'win32', pid: 7, capabilities: ['gui.launch', 'gui.screenshot', 'gui.input'], probes: [], displays: [], limits: [], locked: false, since: '2026-09-23T18:00:00.000Z' };

class FakeChannel extends EventEmitter {
  constructor(handlers = {}) { super(); this.connected = false; this.info = null; this.handlers = handlers; this.requests = []; }
  connect(info = INFO) { this.connected = true; this.info = { ...info }; this.emit('ready', this.info); }
  drop(reason = 'gone') { this.connected = false; this.info = null; this.emit('closed', reason); }
  async request(op, params, opts) {
    this.requests.push({ op, params, opts });
    if (!this.handlers[op]) throw new GuiError('unknown_op', op);
    return this.handlers[op](params, opts);
  }
}

function tempData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-broker-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'service.pid'), String(process.pid));
  return d;
}

const CALC = { pid: 100, image: 'C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe' };
function handlers(overrides = {}) {
  return {
    processes: async ({ match }) => (match.some((m) => /CalculatorApp/i.test(m)) ? [CALC] : []),
    windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'Calculator', bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1.5, minimized: false }],
    foreground: async () => ({ handle: 'w1', pid: 100, image: CALC.image, bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, scale: 1.5 }),
    screenshot: async () => ({ mime: 'image/jpeg', width: 1280, height: 720, data: Buffer.from('jpeg-bytes').toString('base64'), transform: { sx: 1.5, sy: 1.5, unit: 'px' } }),
    input: async () => ({ foregroundBefore: CALC, foregroundAfter: CALC }),
    launch: async () => ({ pid: 555 }),
    close: async ({ pids }) => ({ closed: pids }),
    release_all: async () => null,
    focus: async () => ({ focused: true }),
    ...overrides
  };
}

function broker(opts = {}) {
  const channel = new FakeChannel(handlers(opts.handlers));
  const audits = [];
  let t = Date.parse('2026-09-23T18:00:00.000Z');
  const b = new GuiBroker({
    channel, guiConfig, getPolicy: () => ({ allowed_roots: [] }), audit: { append: async (e) => { audits.push(e); } },
    dataDir: opts.dataDir || null, platform: 'win32', clock: () => t, heartbeatMs: 60000, realpath: (p) => p
  });
  b.start();
  cleanups.push(() => b.stop());
  return { b, channel, audits, advance: (ms) => { t += ms; }, now: () => t };
}

const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
const ctx = { jobId: 'job-1', leaseId: null };

describe('capability lifecycle', () => {
  it('available only between ready and closed, advertising only probed sub-capabilities', () => {
    const { b, channel } = broker();
    assert.equal(b.capability().available, false);
    assert.throws(() => b.require('gui.launch'), (e) => e.code === 'capability_unavailable' && e.detail === 'gui');
    channel.connect({ ...INFO, capabilities: ['gui.launch'] });
    assert.equal(b.capability().available, true);
    assert.deepEqual(b.capability().apps, [{ id: 'calculator', name: 'Calculator' }, { id: 'notepad', name: 'Notepad' }]);
    b.require('gui.launch');
    assert.throws(() => b.require('gui.input'), (e) => e.code === 'capability_unavailable' && e.detail === 'gui.input');
    channel.info = { ...channel.info, capabilities: [] };
    channel.emit('event', 'probe_changed', channel.info);
    assert.throws(() => b.require('gui.launch'), (e) => e.detail === 'gui.launch');
    channel.drop();
    assert.equal(b.capability().available, false);
  });

  it('a disabled gui is never available', () => {
    const channel = new FakeChannel(handlers());
    const b = new GuiBroker({ channel, guiConfig: { ...guiConfig, enabled: false }, platform: 'win32' });
    b.start();
    channel.connect();
    assert.equal(b.capability().available, false);
    b.stop();
  });
});

describe('status.json', () => {
  it('is written on each change and read only when fresh and from the live service', () => {
    const dataDir = tempData();
    const { b, channel, now } = broker({ dataDir });
    channel.connect();
    const raw = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
    assert.equal(raw.available, true);
    assert.equal(raw.pid, process.pid);
    const at = Date.parse(raw.updated_at);
    assert.deepEqual(readGuiStatus({ dataDir, now: at + 1000 }), {
      available: true, capabilities: INFO.capabilities, apps: [{ id: 'calculator', name: 'Calculator' }, { id: 'notepad', name: 'Notepad' }], limits: [], lease: null
    });
    assert.equal(readGuiStatus({ dataDir, now: at + 31000 }).available, false, 'stale after 30 s');
    assert.equal(readGuiStatus({ dataDir, now: at + 1000, readPid: () => process.pid + 1 }).available, false, 'another pid');
    assert.equal(readGuiStatus({ dataDir, now: at + 1000, isRunning: () => false }).available, false, 'not running');
    assert.ok(readGuiStatusRecord({ dataDir, now: at + 1000 }).probes);
    channel.drop();
    assert.equal(JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8')).available, false);
    assert.ok(now());
    assert.ok(b);
  });

  it('a missing or corrupt file is simply unavailable', () => {
    const dataDir = tempData();
    assert.equal(readGuiStatus({ dataDir }).available, false);
    fs.mkdirSync(path.join(dataDir, 'session'), { recursive: true });
    fs.writeFileSync(statusPath(dataDir), '{nope');
    assert.equal(readGuiStatus({ dataDir }).available, false);
  });
});

describe('screenshots and coordinates', () => {
  it('Windows: physical pixels with DPI 1.5 and a downscaled screenshot', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.match(shot.screenshotId, /^ss-\d+$/);
    assert.equal(shot.width, 1280);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 640, 360, ['calculator']), { handle: 'w1', rel: [960, 540], appId: 'calculator' });
    assert.ok(channel.requests.find((r) => r.op === 'screenshot').params.handle === 'w1');
  });

  it('macOS: points, with a Retina 2x capture downscaled', async () => {
    const { b, channel } = broker({ handlers: { screenshot: async () => ({ mime: 'image/jpeg', width: 1280, height: 960, data: 'AA==', transform: { sx: 0.625, sy: 0.625, unit: 'pt' } }) } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 640, 480, ['calculator']).rel, [400, 300]);
  });

  it('multi-monitor transform: window-relative, so a window at x=-1920 or moved later still maps; outside is refused', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 0, 0, ['calculator']).rel, [0, 0]);
    assert.deepEqual(b.mapPoint('job-1', shot.screenshotId, 1279, 719, ['calculator']).rel, [1919, 1079]);
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1280, 10, ['calculator']), (e) => e.code === 'outside_window');
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, -1, 10, ['calculator']), (e) => e.code === 'outside_window');
  });

  it('a screenshot id from another job, an unleased app, or older than 10 minutes is stale', async () => {
    const { b, channel, advance } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    assert.throws(() => b.mapPoint('job-2', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['notepad']), (e) => e.code === 'stale_screenshot');
    assert.throws(() => b.mapPoint('job-1', 'ss-999', 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    advance(10 * 60000 + 1);
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
  });

  it('keeps the last 16 screenshots per job', async () => {
    const { b, channel } = broker();
    channel.connect();
    const ids = [];
    for (let i = 0; i < 17; i += 1) ids.push((await b.screenshot({ app: 'calculator' }, ctx)).screenshotId);
    assert.throws(() => b.mapPoint('job-1', ids[0], 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    assert.ok(b.mapPoint('job-1', ids[16], 1, 1, ['calculator']));
  });

  it('Review Focus 1: displays_changed invalidates every kept screenshot', async () => {
    const { b, channel } = broker();
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    channel.emit('event', 'displays_changed', {});
    assert.throws(() => b.mapPoint('job-1', shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
  });

  it('Review Focus 5: a screenshot whose window is gone is stale, and that does not suspend a lease', async () => {
    const { b, channel } = broker({ handlers: { input: async () => { throw new GuiError('stale_screenshot', 'the window is gone'); } } });
    channel.connect();
    const shot = await b.screenshot({ app: 'calculator' }, ctx);
    const target = b.mapPoint('job-1', shot.screenshotId, 10, 10, ['calculator']);
    assert.equal(await code(b.input({ kind: 'click', handle: target.handle, rel: target.rel, button: 'left', count: 1, mods: [] }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 0 })), 'stale_screenshot');
    assert.equal(suspendsLease('stale_screenshot'), false);
    assert.equal(suspendsLease('point_obscured'), false);
    assert.equal(suspendsLease('user_active'), false);
    assert.equal(suspendsLease('screen_locked'), false);
    assert.equal(suspendsLease('foreground_mismatch'), true);
    assert.equal(suspendsLease('app_not_running'), true);
  });

  it('refuses while locked, a non-allowlisted app, no app and no lease, a minimized window and no process', async () => {
    const minimized = broker({ handlers: { windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, minimized: true }] } });
    minimized.channel.connect();
    assert.equal(await code(minimized.b.screenshot({ app: 'calculator' }, ctx)), 'window_minimized');
    const { b, channel } = broker();
    channel.connect();
    assert.equal(await code(b.screenshot({ app: 'terminal' }, ctx)), 'app_not_allowlisted');
    assert.equal(await code(b.screenshot({}, ctx)), 'app_required');
    assert.equal(await code(b.screenshot({ app: 'notepad' }, ctx)), 'app_not_running');
    channel.emit('event', 'locked', {});
    assert.equal(await code(b.screenshot({ app: 'calculator' }, ctx)), 'screen_locked');
    channel.emit('event', 'unlocked', {});
    assert.ok(await b.screenshot({ app: 'calculator' }, ctx));
  });

  it('input carries the leased apps as the expected set and reports where the focus went', async () => {
    const { b, channel } = broker({ handlers: { input: async () => ({ foregroundBefore: CALC, foregroundAfter: { pid: 4, image: 'C:\\Windows\\explorer.exe' } }) } });
    channel.connect();
    const out = await b.input({ kind: 'key', mods: [], key: 'a', repeat: 1 }, { jobId: 'job-1', leaseId: 'l1', appIds: ['calculator'], yieldMs: 2000 });
    const sent = channel.requests.find((r) => r.op === 'input');
    assert.deepEqual(sent.params.expect, { match: ['C:\\Windows\\System32\\calc.exe', 'CalculatorApp.exe'], pids: [100] });
    assert.equal(sent.params.yield_ms, 2000);
    assert.equal(out.afterMatches, false);
  });
});

describe('launch, close and list', () => {
  it('records launched pids per job; force-kills only those', async () => {
    const { b, channel, audits } = broker({ handlers: { processes: async () => [{ pid: 555, image: CALC.image }, { pid: 100, image: CALC.image }] } });
    channel.connect();
    const launched = await b.launch({ tier: 'routine', reason: 'allowlisted', appId: 'calculator', exe: 'C:\\Windows\\System32\\calc.exe', argv: [], files: [], match: [] }, ctx, { approvedBy: 'allowlist' });
    assert.equal(launched.pid, 555);
    assert.ok(audits.some((a) => a.kind === 'gui.launch' && a.data.approved_by === 'allowlist' && a.data.app_id === 'calculator'));
    const closed = await b.close('calculator', true, ctx);
    const closes = channel.requests.filter((r) => r.op === 'close').map((r) => r.params);
    assert.deepEqual(closes, [{ pids: [555], force: true }, { pids: [100], force: false }]);
    assert.deepEqual(closed.closed.sort(), [100, 555]);
    assert.equal(await code(b.close('terminal', false, ctx)), 'app_not_allowlisted');
  });

  it('R-F5-7: a run with no job id keeps no launched pids and no screenshots', async () => {
    const { b, channel } = broker({ handlers: { processes: async () => [{ pid: 555, image: CALC.image }] } });
    channel.connect();
    const none = { jobId: null, leaseId: null };
    await b.launch({ tier: 'routine', reason: 'allowlisted', appId: 'calculator', exe: 'C:\\Windows\\System32\\calc.exe', argv: [], files: [], match: [] }, none, { approvedBy: 'allowlist' });
    await b.close('calculator', true, none);
    assert.deepEqual(channel.requests.filter((r) => r.op === 'close').map((r) => r.params), [{ pids: [555], force: false }], 'never a kill');
    const shot = await b.screenshot({ app: 'calculator' }, none);
    assert.match(shot.screenshotId, /^ss-\d+$/);
    for (const jobId of [null, undefined]) {
      assert.throws(() => b.mapPoint(jobId, shot.screenshotId, 1, 1, ['calculator']), (e) => e.code === 'stale_screenshot');
    }
  });

  it('lists only allowlisted apps, with titles cut to 120 characters', async () => {
    const { b, channel } = broker({ handlers: { windows: async () => [{ handle: 'w1', pid: 100, image: CALC.image, title: 'x'.repeat(200), bounds: {}, scale: 1, minimized: false }] } });
    channel.connect();
    const apps = await b.listApps(ctx);
    assert.deepEqual(apps.map((a) => [a.id, a.running]), [['calculator', true], ['notepad', false]]);
    assert.equal(apps[0].windows[0].title.length, 120);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-broker.test.js`
Expected: FAIL with `Cannot find module '../src/gui/broker'`.

- [ ] **Step 3: Write `src/gui/status.js`**

```js
// src/gui/status.js
// <dataDir>/session/status.json (fleet stage 5 spec §4.5): what the service
// last knew about the helper, for `session status`, the stdio `mcp` process
// and F7. Output only; it grants nothing. Dependency-light: F4's
// src/fleet/start.js loads readGuiStatus on every profile.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STALE_MS = 30000;
const statusPath = (dataDir) => path.join(dataDir, 'session', 'status.json');
const UNAVAILABLE = Object.freeze({ available: false, capabilities: [], apps: [], limits: [], lease: null });

function writeGuiStatus(dataDir, record) {
  const dir = path.dirname(statusPath(dataDir));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = statusPath(dataDir);
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function defaultReadPid(dataDir) {
  return require('../service/pidfile').readPidfile(dataDir);
}

function defaultIsRunning(pid) {
  return require('../service/pidfile').isRunning(pid);
}

function readGuiStatusRecord({ dataDir, now = Date.now(), readPid = defaultReadPid, isRunning = defaultIsRunning } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1 || !Number.isInteger(raw.pid)) return null;
  if (raw.pid !== readPid(dataDir) || !isRunning(raw.pid)) return null;
  const updated = Date.parse(raw.updated_at);
  if (!Number.isFinite(updated) || now - updated >= STALE_MS) return null;
  return raw;
}

// The block list_machines/describe_machine carry: never paths or arg globs.
function readGuiStatus(options = {}) {
  const raw = readGuiStatusRecord(options);
  if (!raw || raw.available !== true) return { ...UNAVAILABLE };
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return {
    available: true,
    capabilities: strings(raw.capabilities),
    apps: (Array.isArray(raw.apps) ? raw.apps : []).filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, name: String(a.name || a.id) })),
    limits: strings(raw.limits),
    lease: raw.lease ? { active: raw.lease.active === true } : null
  };
}

module.exports = { statusPath, writeGuiStatus, readGuiStatus, readGuiStatusRecord, STALE_MS };
```

- [ ] **Step 4: Write `src/gui/broker.js`**

```js
// src/gui/broker.js
// The service's view of the desktop (fleet stage 5 spec §3.5): whether the
// gui capability is up, what the helper may do, the screenshots a job may
// click on, and the one path every GUI op takes to the helper. All policy
// stays here; the helper only checks what each op carries.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { GuiError } = require('./errors');
const { imageMatches, matchSetFor } = require('./apps');
const { realResolve } = require('../platform/path-roots');
const { writeGuiStatus } = require('./status');

const SCREENSHOTS_PER_JOB = 16;
const SCREENSHOT_TTL_MS = 10 * 60 * 1000;
const TITLE_MAX = 120;
const SUSPENDING_CODES = Object.freeze(['foreground_mismatch', 'app_not_running', 'helper_disconnected']);
const suspendsLease = (code) => SUSPENDING_CODES.includes(code);

class GuiBroker extends EventEmitter {
  constructor({ channel, guiConfig, getPolicy = () => ({}), audit = null, dataDir = null, platform = process.platform, clock = Date.now,
    log = createLogger('gui/broker'), heartbeatMs = 10000, realpath = realResolve } = {}) {
    super();
    Object.assign(this, { channel, guiConfig, getPolicy, audit, dataDir, platform, clock, log, heartbeatMs, realpath });
    this.leases = null;
    // Both maps are per job and only for runs that have one (R-F5-7): a run
    // with no job id gets no entry, so such runs never share a bucket.
    this.shots = new Map(); // jobId → [{ screenshotId, appId, handle, transform, width, height, at, gen }]
    this.launched = new Map(); // jobId → Map(appId → Set(pid))
    this.nextShot = 1;
    this.displaysGen = 0;
    this.lockedFlag = false;
    this.listeners = [];
  }

  setLeases(leases) {
    this.leases = leases;
  }

  start() {
    const on = (event, fn) => { this.channel.on(event, fn); this.listeners.push([event, fn]); };
    on('ready', (info) => { this.lockedFlag = Boolean(info && info.locked); this._changed(); });
    on('closed', () => { this.lockedFlag = false; if (this.leases) this.leases.onHelperDisconnected(); this._changed(); });
    on('event', (kind) => {
      if (kind === 'locked' || kind === 'unlocked') {
        this.lockedFlag = kind === 'locked';
        if (this.leases) this.leases.setLocked(this.lockedFlag);
      }
      if (kind === 'displays_changed') this.displaysGen += 1;
      this._changed();
    });
    this.heartbeat = setInterval(() => this._writeStatus(), this.heartbeatMs);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    this._writeStatus();
  }

  stop() {
    for (const [event, fn] of this.listeners) this.channel.off(event, fn);
    this.listeners = [];
    clearInterval(this.heartbeat);
    this._writeStatus({ stopping: true });
  }

  get locked() {
    return this.lockedFlag;
  }

  appList() {
    return Object.values(this.guiConfig.apps).map((a) => ({ id: a.id, name: a.name }));
  }

  capability() {
    const info = this.channel.connected ? this.channel.info : null;
    const available = Boolean(this.guiConfig.enabled && info);
    const lease = this.leases ? this.leases.statusSummary() : null;
    return {
      available,
      capabilities: available ? [...info.capabilities] : [],
      user: info ? info.user : null,
      platform: info ? info.platform : null,
      since: info ? info.since : null,
      apps: this.appList(),
      limits: info ? [...info.limits] : [],
      locked: this.lockedFlag,
      lease
    };
  }

  require(sub) {
    const cap = this.capability();
    if (!cap.available) throw new GuiError('capability_unavailable', 'gui');
    if (!cap.capabilities.includes(sub)) throw new GuiError('capability_unavailable', sub);
  }

  _changed() {
    this._writeStatus();
    this.emit('capability', this.capability());
  }

  leaseChanged() {
    this._changed();
  }

  _writeStatus({ stopping = false } = {}) {
    if (!this.dataDir) return;
    const cap = this.capability();
    const info = this.channel.connected ? this.channel.info : null;
    try {
      writeGuiStatus(this.dataDir, {
        v: 1, pid: process.pid, available: stopping ? false : cap.available, user: cap.user, platform: cap.platform,
        capabilities: cap.capabilities, probes: info ? info.probes : [], limits: cap.limits, apps: cap.apps, since: cap.since,
        updated_at: new Date(this.clock()).toISOString(),
        lease: cap.lease ? { active: cap.lease.active, app_ids: cap.lease.appIds, expires_at: cap.lease.expiresAt } : null
      });
    } catch (err) {
      this.log.warn(`status.json not written: ${err.message}`);
    }
  }

  _audit(kind, data) {
    if (!this.audit) return;
    Promise.resolve().then(() => this.audit.append({ kind, data })).catch((err) => this.log.warn(`audit ${kind} failed: ${err.message}`));
  }

  _app(appId) {
    const app = appId && Object.hasOwn(this.guiConfig.apps, appId) ? this.guiConfig.apps[appId] : null;
    if (!app) throw new GuiError('app_not_allowlisted', String(appId));
    return app;
  }

  _match(appIds) {
    return matchSetFor(this.guiConfig, appIds, { realpath: this.realpath });
  }

  async _pids(appIds, ctx = {}) {
    const found = await this.channel.request('processes', { match: this._match(appIds) }, { jobId: ctx.jobId || null });
    return (Array.isArray(found) ? found : []).filter((p) => Number.isInteger(p.pid));
  }

  async listApps(ctx) {
    this.require('gui.launch');
    const out = [];
    for (const app of Object.values(this.guiConfig.apps)) {
      const procs = await this._pids([app.id], ctx);
      const windows = procs.length ? await this.channel.request('windows', { pids: procs.map((p) => p.pid) }, { jobId: ctx.jobId }) : [];
      out.push({
        id: app.id, name: app.name, running: procs.length > 0,
        windows: (windows || []).map((w) => ({ title: String(w.title || '').slice(0, TITLE_MAX), minimized: w.minimized === true }))
      });
    }
    return out;
  }

  async launch(resolution, ctx, { approvedBy }) {
    this.require('gui.launch');
    const result = await this.channel.request('launch', { exe: resolution.exe, argv: resolution.argv, files: resolution.files }, { jobId: ctx.jobId, timeoutMs: 30000 });
    const pid = result && Number.isInteger(result.pid) ? result.pid : null;
    if (resolution.appId && pid !== null && ctx.jobId) {
      if (!this.launched.has(ctx.jobId)) this.launched.set(ctx.jobId, new Map());
      const byApp = this.launched.get(ctx.jobId);
      if (!byApp.has(resolution.appId)) byApp.set(resolution.appId, new Set());
      byApp.get(resolution.appId).add(pid);
    }
    this._audit('gui.launch', { job_id: ctx.jobId, app_id: resolution.appId, exe: resolution.exe, argv: [...resolution.argv, ...resolution.files], tier: resolution.tier, approved_by: approvedBy, pid });
    return { app_id: resolution.appId, pid, tier: resolution.tier, launched_at: new Date(this.clock()).toISOString() };
  }

  async close(appId, force, ctx) {
    this.require('gui.launch');
    this._app(appId);
    const pids = (await this._pids([appId], ctx)).map((p) => p.pid);
    const mine = (ctx.jobId && this.launched.get(ctx.jobId) && this.launched.get(ctx.jobId).get(appId)) || new Set();
    const forced = force ? pids.filter((p) => mine.has(p)) : [];
    const graceful = pids.filter((p) => !forced.includes(p));
    const closed = [];
    if (forced.length) closed.push(...((await this.channel.request('close', { pids: forced, force: true }, { jobId: ctx.jobId })).closed || []));
    if (graceful.length) closed.push(...((await this.channel.request('close', { pids: graceful, force: false }, { jobId: ctx.jobId })).closed || []));
    this._audit('gui.close', { job_id: ctx.jobId, app_id: appId, pids: closed });
    return { closed };
  }

  // The window to capture: the foreground one if it is the app's, else its
  // largest window that is not minimized.
  async _window(appId, ctx) {
    const procs = await this._pids([appId], ctx);
    if (procs.length === 0) throw new GuiError('app_not_running', appId);
    const pids = procs.map((p) => p.pid);
    const fg = await this.channel.request('foreground', {}, { jobId: ctx.jobId });
    const windows = (await this.channel.request('windows', { pids }, { jobId: ctx.jobId })) || [];
    if (fg && pids.includes(fg.pid)) {
      const w = windows.find((x) => x.handle === fg.handle);
      if (w && !w.minimized) return w;
    }
    const open = windows.filter((w) => !w.minimized);
    if (open.length === 0) throw new GuiError(windows.length ? 'window_minimized' : 'app_not_running', appId);
    const area = (w) => (w.bounds ? (w.bounds.w || 0) * (w.bounds.h || 0) : 0);
    return open.sort((a, b) => area(b) - area(a))[0];
  }

  async foregroundApp(appIds) {
    const fg = await this.channel.request('foreground', {}, {});
    if (!fg) return null;
    for (const id of appIds) if (imageMatches(fg.image, this._match([id]), this.platform)) return { appId: id, image: fg.image, handle: fg.handle };
    return { appId: null, image: fg.image, handle: fg.handle };
  }

  async screenshot({ app = null, maxWidth = null } = {}, ctx) {
    this.require('gui.screenshot');
    if (this.lockedFlag) throw new GuiError('screen_locked');
    let appId = app;
    if (!appId) {
      const lease = this.leases ? this.leases.active(ctx.jobId) : null;
      const fg = lease ? await this.foregroundApp(lease.apps) : null;
      appId = fg && fg.appId;
      if (!appId) throw new GuiError('app_required', 'name an allowlisted app');
    }
    this._app(appId);
    const win = await this._window(appId, ctx);
    const shot = await this.channel.request('screenshot', {
      handle: win.handle, max_width: maxWidth || this.guiConfig.screenshot.maxWidth, quality: this.guiConfig.screenshot.quality
    }, { jobId: ctx.jobId, timeoutMs: 20000 });
    const bytes = Buffer.from(shot.data || '', 'base64');
    const entry = {
      screenshotId: `ss-${this.nextShot}`, appId, handle: win.handle, transform: shot.transform,
      width: shot.width, height: shot.height, at: this.clock(), gen: this.displaysGen
    };
    this.nextShot += 1;
    // A run without a job can hold no lease, so its screenshot is never clicked on.
    if (ctx.jobId) {
      const list = this.shots.get(ctx.jobId) || [];
      list.push(entry);
      while (list.length > SCREENSHOTS_PER_JOB) list.shift();
      this.shots.set(ctx.jobId, list);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('base64url');
    this._audit('gui.screenshot', { job_id: ctx.jobId, app_id: appId, screenshot_id: entry.screenshotId, sha256, bytes: bytes.length });
    return {
      screenshotId: entry.screenshotId, appId, width: shot.width, height: shot.height, mime: 'image/jpeg', data: shot.data,
      transform: shot.transform, capturedAt: new Date(entry.at).toISOString(), sha256, bytes: bytes.length
    };
  }

  // Live-view frames (§3.7): the foreground leased app's window, never stored.
  async captureFrame({ appIds, maxWidth, quality }) {
    const fg = await this.foregroundApp(appIds);
    if (!fg || !fg.appId) return { appId: null };
    const shot = await this.channel.request('screenshot', { handle: fg.handle, max_width: maxWidth, quality }, { timeoutMs: 20000 });
    const bytes = Buffer.from(shot.data || '', 'base64');
    return { appId: fg.appId, width: shot.width, height: shot.height, data: shot.data, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('base64url') };
  }

  mapPoint(jobId, screenshotId, x, y, appIds) {
    const entry = (this.shots.get(jobId) || []).find((s) => s.screenshotId === screenshotId);
    if (!entry || entry.gen !== this.displaysGen || this.clock() - entry.at > SCREENSHOT_TTL_MS) {
      throw new GuiError('stale_screenshot', 'take a new screenshot');
    }
    if (!appIds.includes(entry.appId)) throw new GuiError('stale_screenshot', 'that screenshot is not of a leased app');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= entry.width || y >= entry.height) {
      throw new GuiError('outside_window', `the point is outside the ${entry.width}x${entry.height} screenshot`);
    }
    const { sx, sy } = entry.transform || { sx: 1, sy: 1 };
    return { handle: entry.handle, rel: [Math.round(x * sx), Math.round(y * sy)], appId: entry.appId };
  }

  async expectFor(appIds) {
    const pids = (await this._pids(appIds)).map((p) => p.pid);
    if (pids.length === 0) throw new GuiError('app_not_running', appIds.join(', '));
    return { match: this._match(appIds), pids };
  }

  async input(action, { jobId, leaseId, appIds, yieldMs }) {
    this.require('gui.input');
    const expect = await this.expectFor(appIds);
    const res = await this.channel.request('input', { expect, yield_ms: yieldMs, action }, { jobId, leaseId });
    const after = res && res.foregroundAfter;
    const afterAppId = after ? (appIds.find((id) => imageMatches(after.image, this._match([id]), this.platform)) || null) : null;
    return {
      foregroundBefore: res && res.foregroundBefore ? res.foregroundBefore : null,
      foregroundAfter: after || null,
      afterMatches: Boolean(after && expect.pids.includes(after.pid) && imageMatches(after.image, expect.match, this.platform)),
      afterAppId
    };
  }

  async releaseAll() {
    if (!this.channel.connected) return;
    try {
      await this.channel.request('release_all', {}, {});
    } catch (err) {
      this.log.warn(`release_all failed: ${err.message}`);
    }
  }

  async focusApp(appIds) {
    try {
      const procs = await this._pids(appIds);
      if (!procs.length) return;
      const windows = (await this.channel.request('windows', { pids: procs.map((p) => p.pid) }, {})) || [];
      const top = windows.find((w) => !w.minimized);
      if (top) await this.channel.request('focus', { handle: top.handle }, {});
    } catch (err) {
      this.log.debug(`focus after resume failed: ${err.message}`);
    }
  }
}

module.exports = { GuiBroker, SUSPENDING_CODES, suspendsLease, SCREENSHOTS_PER_JOB, SCREENSHOT_TTL_MS };
```

`this.leases.statusSummary()`, `onHelperDisconnected()` and `setLocked()` are Task 9's; until then `leases` is null and the broker skips them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/gui-broker.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/gui/status.js src/gui/broker.js tests/gui-broker.test.js
git commit -m "feat(gui): status file and the GUI broker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The lease manager

**Review:** trust (it is the lease: who holds it, for which job, until when). **On Windows:** all of it can be checked.

R-F5-7 in this task (Deviations 6, 34, 35, 37): `request` refuses a run without a job (`job_required`) and a job that is not open (`job_closed`) before anything is sent; `jobOpen` defaults to closed; a grant for a closed job ends the pending lease; `assertUsable` ends a lease whose job is gone; a dead job's lease never answers another job with `lease_busy`. `_audit` hands each entry to the ledger at once, in call order, so the tests below can read it without waiting.

**Files:**
- Create: `src/gui/leases.js`
- Modify: `tests/helpers/fake-phone.js` (lease-v1 signers)
- Test: `tests/gui-leases.test.js`

**Interfaces:**
- Consumes: `buildLeaseRequest`, `buildLeaseStatus`, `verifyLeaseGrant`, `verifyLeaseRevoke`, `verifyLeaseWatch`, `effectiveExpiry` (Task 6); `NonceCache`, `bytesSha256` (F3); `TypedBuffer` (Task 3); `suspendsLease` (Task 8); `GuiError` (Task 1).
- Produces (`src/gui/leases.js`): `class LeaseManager extends EventEmitter` — `new LeaseManager({ approvals, guiConfig, broker = null, audit = null, nodeName, clock = Date.now, timers = { setTimeout, clearTimeout }, jobOpen = () => false, log })` where `approvals = { identity, approverStore, relayClient, phoneApprover }`. `jobOpen(jobId) → boolean` fails closed: with none given, no job is open (R-F5-7); a `jobOpen` that throws counts as closed.
  - `setBroker(b)`, `setJobOpen(fn)`, `start()`, `stop()`.
  - `available() → boolean` (a relay link and `phoneApprover.isAvailable()`).
  - `current() → Lease | null` (the one not ended); `active(jobId) → Lease | null`; `find(leaseId)`.
  - `request({ jobId, origin, appIds, minutes, reason, signal }) → Promise<Lease>`; rejects `job_required` (no job id), `approval_unavailable`, `invalid_params`, `job_closed` (the job is not open, now or when the grant arrives), `lease_busy`, `lease_pending`, `lease_denied`, `lease_request_expired`, `cancelled`. The first four are checked in that order and before anything is sent.
  - `assertUsable(jobId) → Lease` (throws `lease_required`, `lease_pending`, `lease_suspended`, `lease_expired`, `lease_revoked`, `job_closed`, `screen_locked`).
  - `chargeInput(lease)` (throws `rate_limited` with `retryAfter`).
  - `noteInputOutcome(lease, { code = null, afterMatches = true }) → boolean` (true when it suspended the lease).
  - `onGrant(envelope) → { state, reason? }` (`{ state: 'ended', reason: 'job_closed' }` when check 12 finds the job closed), `onRevoke(envelope) → { state, reason? }`; `verifyWatch(envelope) → { accepted, reason, lease, deviceId }`.
  - `suspend(leaseId, reason)`, `setLocked(locked)`, `onHelperDisconnected()`, `endForJob(jobId, reason = 'job_closed')`, `stopAll(reason = 'service_stopped')`.
  - `statusSummary() → { active, appIds, expiresAt } | null`; `nextSeq(lease) → int`; `remainingMs(lease)`.
  - `Lease = { leaseId, jobId, origin, reason, requestedApps, maxMinutes, apps, state, locked, endReason, suspendReason, expiresAt, deviceId, seq, typed: TypedBuffer, inputTimes }`. Events: `'state'(lease)`.
  - `tests/helpers/fake-phone.js`: `phone.leaseGrant(requestEnvelope, { decision, apps, minutes, signedAt, overrides })`, `phone.leaseRevoke(nodeId, leaseId, { reason, nonce, signedAt })`, `phone.leaseWatch(nodeId, leaseId, { nonce, signedAt })`.

- [ ] **Step 1: Add the lease signers to the fake phone**

In `tests/helpers/fake-phone.js`, inside the `phone` object after `revoke(...)`, add:

```js
    // lease-v1 (fleet stage 5 §4.1): answers a node-signed kl.lease.request
    // the way the apps do (the request's nonce and expires_at are copied).
    leaseGrant(requestEnvelope, { decision = 'grant', apps = null, minutes = 10, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const { message: req } = open(requestEnvelope);
      return seal({
        v: 1, type: 'kl.lease.grant', request_id: req.request_id, lease_id: req.lease_id, node_id: req.node_id,
        lease_hash: req.lease_hash, nonce: req.nonce, decision,
        grant: decision === 'grant' ? { apps: apps || req.lease.apps.map((a) => a.id), minutes } : null,
        expires_at: req.expires_at, device_id: deviceId, signed_at: signedAt, ...overrides
      }, signer);
    },

    leaseRevoke(nodeId, leaseId, { reason = 'kill_switch', nonce = null, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.lease.revoke', node_id: nodeId, lease_id: leaseId, reason, device_id: deviceId, nonce: nonce || randomNonce(), signed_at: signedAt }, signer);
    },

    leaseWatch(nodeId, leaseId, { nonce = null, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.lease.watch', node_id: nodeId, lease_id: leaseId, device_id: deviceId, nonce: nonce || randomNonce(), signed_at: signedAt }, signer);
    },
```

- [ ] **Step 2: Write the failing test**

Create `tests/gui-leases.test.js`:

```js
// tests/gui-leases.test.js
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { open } = require('../src/approvals/envelope');
const { LeaseManager } = require('../src/gui/leases');
const { parseGuiConfig } = require('../src/gui/config');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
require('../src/gui/lease-protocol');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const guiConfig = parseGuiConfig({
  apps: {
    calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
    notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' }
  },
  lease: { max_inputs_per_minute: 10 }
}, { platform: 'win32' });
const ORIGIN = { client: 'claude.ai', session: 's-1', job_id: 'job-1' };

function fakeTimers(clock) {
  let list = [];
  return {
    setTimeout(fn, ms) { const t = { fn, at: clock.now() + ms }; list.push(t); return t; },
    clearTimeout(t) { list = list.filter((x) => x !== t); },
    advance(ms) {
      clock.t += ms;
      for (;;) {
        const due = list.filter((x) => x.at <= clock.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        list = list.filter((x) => x !== due);
        due.fn();
      }
    },
    // Moves the clock without running any timer (a sleeping laptop).
    jump(ms) { clock.t += ms; }
  };
}

class FakeRelay extends EventEmitter {
  constructor() { super(); this.connected = true; this.sent = []; this.methods = new Map(); }
  isConnected() { return this.connected; }
  async send(envelope, opts = {}) {
    if (!this.connected) throw Object.assign(new Error('relay_offline'), { code: 'relay_offline' });
    this.sent.push({ envelope, opts, message: open(envelope).message });
    return { ok: true };
  }
  registerMethod(name, fn) { this.methods.set(name, fn); }
  down() { this.connected = false; this.emit('disconnected'); }
  up() { this.connected = true; this.emit('connected'); }
  last(type) { return [...this.sent].reverse().find((s) => s.message.type === type); }
  all(type) { return this.sent.filter((s) => s.message.type === type); }
}

let phone;
let other;
let identity;
let relay;
let clock;
let timers;
let broker;
let audits;
let leases;
let openJobs;

beforeEach(async () => {
  openJobs = new Set(['job-1', 'job-2', 'job-3']);
  phone = createFakePhone({ name: 'Owner phone' });
  other = createFakePhone({ name: 'Second phone' });
  identity = testNodeIdentity({ key: 'gpu-box' });
  clock = { t: Date.parse('2026-09-23T18:00:00.000Z'), now() { return this.t; } };
  timers = fakeTimers(clock);
  const store = await approverStoreWith([phone.approverRecord(), other.approverRecord()], { now: () => clock.now() });
  stores.push(store);
  relay = new FakeRelay();
  broker = { calls: [], releaseAll: async () => { broker.calls.push('releaseAll'); }, focusApp: async (ids) => { broker.calls.push(['focus', ids]); }, capability: () => ({ limits: ['no_human_yield'] }), leaseChanged: () => {} };
  audits = [];
  leases = new LeaseManager({
    approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } },
    guiConfig, broker, audit: { append: async (e) => { audits.push(e); } }, nodeName: 'gpu-box', clock: () => clock.now(), timers,
    jobOpen: (jobId) => openJobs.has(jobId)
  });
  leases.start();
});

async function granted({ appIds = ['calculator'], minutes = 10, jobId = 'job-1' } = {}) {
  const p = leases.request({ jobId, origin: { ...ORIGIN, job_id: jobId }, appIds, minutes: 15, reason: 'Enter the totals' });
  const req = relay.last('kl.lease.request');
  assert.deepEqual(leases.onGrant(phone.leaseGrant(req.envelope, { minutes })), { state: 'active' });
  return p;
}

const kinds = () => audits.map((a) => a.kind);

describe('request and grant', () => {
  it('grant → the lease is usable for its job only; the request carries the probe limits and a push', async () => {
    const lease = await granted();
    const req = relay.all('kl.lease.request')[0];
    assert.deepEqual(req.opts.push, { kind: 'lease', id: req.message.request_id, expires_at: req.message.expires_at });
    assert.deepEqual(req.message.lease.limits, ['no_human_yield']);
    assert.equal(req.message.lease.apps[0].path, 'C:\\Windows\\System32\\calc.exe');
    assert.equal(leases.assertUsable('job-1'), lease);
    assert.throws(() => leases.assertUsable('job-2'), (e) => e.code === 'lease_required');
    assert.equal(lease.expiresAt, clock.now() + 10 * 60000);
    assert.ok(kinds().includes('lease.requested') && kinds().includes('lease.granted'));
    assert.equal(relay.last('kl.lease.status').message.state, 'active');
  });

  it('a narrowed grant leases only the apps the phone kept', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator', 'notepad'], minutes: 15, reason: 'x' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { apps: ['notepad'], minutes: 5 }));
    assert.deepEqual((await p).apps, ['notepad']);
  });

  it('deny → lease_denied; a request left unanswered for 5 minutes → lease_request_expired', async () => {
    const denied = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { decision: 'deny' }));
    await assert.rejects(denied, (e) => e.code === 'lease_denied');
    const waiting = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    timers.advance(5 * 60000 + 1);
    await assert.rejects(waiting, (e) => e.code === 'lease_request_expired');
    assert.ok(kinds().includes('lease.denied'));
  });

  it('a grant that fails a check is audited and leaves the request pending', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const env = relay.last('kl.lease.request').envelope;
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env, { minutes: 16 })), { state: 'rejected', reason: 'minutes_out_of_range' });
    assert.ok(audits.some((a) => a.kind === 'lease.rejected' && a.data.check === 12));
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env, { minutes: 3 })), { state: 'active' });
    await p;
  });

  it('lease_busy for another job; the same job gets its lease back or lease_pending', async () => {
    const pending = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'lease_pending');
    await assert.rejects(leases.request({ jobId: 'job-2', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'lease_busy');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    const lease = await pending;
    assert.equal(await leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), lease);
  });

  it('no phone to sign: approval_unavailable before any request goes out', async () => {
    const store = await approverStoreWith([]);
    stores.push(store);
    const none = new LeaseManager({ approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => false } }, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers });
    await assert.rejects(none.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'approval_unavailable');
    assert.equal(relay.all('kl.lease.request').length, 0);
  });

  it('refuses apps not in gui.apps and minutes out of range', async () => {
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['terminal'], minutes: 15, reason: 'x' }), (e) => e.code === 'invalid_params');
    await assert.rejects(leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 61, reason: 'x' }), (e) => e.code === 'invalid_params');
  });
});

describe('R-F5-7: a lease needs a known, open job', () => {
  it('R-F5-7: no job id is job_required, a job that is not open is job_closed, and nothing goes out', async () => {
    for (const jobId of [null, undefined, '', 42]) {
      await assert.rejects(leases.request({ jobId, origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_required', String(jobId));
    }
    await assert.rejects(leases.request({ jobId: 'job-unknown', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    assert.equal(relay.all('kl.lease.request').length, 0);
    assert.equal(leases.current(), null);
    assert.ok(!kinds().includes('lease.requested'));
  });

  it('R-F5-7: with no jobOpen given, no job is open; one that throws counts as closed', async () => {
    const base = { approvals: leases.approvals, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.now(), timers };
    await assert.rejects(new LeaseManager(base).request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    const throwing = new LeaseManager({ ...base, jobOpen: () => { throw new Error('store unavailable'); } });
    await assert.rejects(throwing.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' }), (e) => e.code === 'job_closed');
    assert.equal(relay.all('kl.lease.request').length, 0);
  });

  it('R-F5-7: a grant for a job that closed is rejected at check 12 and ends the lease', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const env = relay.last('kl.lease.request').envelope;
    openJobs.delete('job-1');
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env)), { state: 'ended', reason: 'job_closed' });
    await assert.rejects(p, (e) => e.code === 'job_closed');
    assert.ok(audits.some((a) => a.kind === 'lease.rejected' && a.data.check === 12 && a.data.reason === 'job_closed'));
    assert.equal(leases.current(), null);
    assert.equal(relay.last('kl.lease.status').message.reason, 'job_closed');
    // Nothing is left pending for that request.
    assert.deepEqual(leases.onGrant(phone.leaseGrant(env)), { state: 'rejected', reason: 'unknown_request' });
  });

  it('R-F5-7: a lease whose job is gone ends at the next input and does not block another job', async () => {
    const lease = await granted();
    openJobs.delete('job-1');
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'job_closed');
    assert.equal(lease.state, 'ended');
    assert.equal(lease.endReason, 'job_closed');
    assert.ok(broker.calls.includes('releaseAll'));

    const second = await granted({ jobId: 'job-2' });
    openJobs.delete('job-2');
    // job-3 asks while job-2's lease is still on the books: no lease_busy.
    const third = leases.request({ jobId: 'job-3', origin: { ...ORIGIN, job_id: 'job-3' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
    assert.equal(second.endReason, 'job_closed');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    assert.equal((await third).jobId, 'job-3');
  });
});

describe('suspension and resume', () => {
  it('a foreground refusal suspends, releases input, and asks to resume without extending', async () => {
    const lease = await granted({ minutes: 10 });
    const originalExpiry = lease.expiresAt;
    timers.advance(3 * 60000);
    assert.equal(leases.noteInputOutcome(lease, { code: 'foreground_mismatch' }), true);
    assert.equal(lease.state, 'suspended');
    assert.ok(broker.calls.includes('releaseAll'));
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_suspended');
    const resume = relay.last('kl.lease.request');
    assert.equal(resume.message.lease.resumes, lease.leaseId);
    assert.equal(resume.message.lease.max_minutes, 7);
    assert.ok(kinds().includes('lease.suspended'));
    leases.onGrant(phone.leaseGrant(resume.envelope, { minutes: 7 }));
    assert.equal(lease.state, 'active');
    assert.equal(lease.expiresAt, originalExpiry, 'a resume never extends');
    assert.ok(kinds().includes('lease.resumed'));
    assert.deepEqual(broker.calls.find((c) => Array.isArray(c) && c[0] === 'focus'), ['focus', ['calculator']]);
  });

  it('app_not_running suspends; point_obscured, user_active, stale_screenshot and screen_locked do not', async () => {
    const lease = await granted();
    for (const c of ['point_obscured', 'user_active', 'stale_screenshot', 'screen_locked', 'outside_window']) {
      assert.equal(leases.noteInputOutcome(lease, { code: c }), false, c);
      assert.equal(lease.state, 'active');
    }
    assert.equal(leases.noteInputOutcome(lease, { code: 'app_not_running' }), true);
    assert.equal(lease.state, 'suspended');
  });

  it('a foreground outside the leased set after an input suspends', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { afterMatches: false }), true);
    assert.equal(lease.suspendReason, 'foreground_changed');
  });

  it('crash, relaunch, resume: the app dying suspends, and a resume grant continues the lease', async () => {
    const lease = await granted();
    leases.noteInputOutcome(lease, { code: 'app_not_running' });
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 1 }));
    assert.equal(leases.assertUsable('job-1'), lease);
  });

  it('helper restart: the gui drops, the lease suspends; after a grant input works again', async () => {
    const lease = await granted();
    leases.onHelperDisconnected();
    assert.equal(lease.suspendReason, 'helper_disconnected');
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 1 }));
    assert.equal(leases.assertUsable('job-1'), lease);
  });

  it('relay disconnect suspends at once; the resume is asked when the link returns', async () => {
    const lease = await granted();
    const before = relay.all('kl.lease.request').length;
    relay.down();
    assert.equal(lease.state, 'suspended');
    assert.equal(lease.suspendReason, 'relay_unreachable');
    assert.equal(relay.all('kl.lease.request').length, before, 'nothing sent while down');
    relay.up();
    const resume = relay.last('kl.lease.request');
    assert.equal(resume.message.lease.resumes, lease.leaseId);
    leases.onGrant(phone.leaseGrant(resume.envelope, { minutes: 1 }));
    assert.equal(lease.state, 'active');
  });

  it('a request made while the relay is down is delivered when it returns', async () => {
    relay.down();
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    await new Promise((r) => setImmediate(r));
    assert.equal(relay.all('kl.lease.request').length, 0);
    relay.up();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope));
    await p;
  });

  it('human yield: user_active does not suspend; the owner switching apps does', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { code: 'user_active' }), false);
    assert.equal(leases.noteInputOutcome(lease, { code: 'foreground_mismatch' }), true);
  });
});

describe('lock, expiry and revoke', () => {
  it('lock pauses inputs, the clock runs, unlock continues without re-signing', async () => {
    const lease = await granted({ minutes: 10 });
    leases.setLocked(true);
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'screen_locked');
    assert.equal(relay.last('kl.lease.status').message.locked, true);
    timers.advance(60000);
    leases.setLocked(false);
    assert.equal(leases.assertUsable('job-1'), lease);
    assert.equal(lease.expiresAt, Date.parse('2026-09-23T18:10:00.000Z'));
  });

  it('Review Focus 3: screen_locked from the helper refuses without suspending', async () => {
    const lease = await granted();
    assert.equal(leases.noteInputOutcome(lease, { code: 'screen_locked' }), false);
    assert.equal(lease.state, 'active');
    assert.equal(relay.all('kl.lease.request').length, 1, 'no resume request');
  });

  it('expiry is on the node clock, whatever the phone clock said', async () => {
    const p = leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['calculator'], minutes: 15, reason: 'x' });
    const signedAt = new Date(clock.now() - 3600000).toISOString();
    leases.onGrant(phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes: 2, signedAt }));
    const lease = await p;
    timers.advance(2 * 60000);
    assert.equal(lease.state, 'ended');
    assert.equal(lease.endReason, 'expired');
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_expired');
    assert.ok(broker.calls.includes('releaseAll'));
    assert.ok(kinds().includes('lease.expired'));
  });

  it('Review Focus 2: an input after expires_at is refused even when the expiry timer has not fired', async () => {
    await granted({ minutes: 2 });
    timers.jump(2 * 60000 + 1);
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_expired');
  });

  it('revoke (mid-Drag) ends the lease and releases held buttons; the next input is lease_revoked', async () => {
    const lease = await granted();
    broker.calls.length = 0;
    const out = leases.onRevoke(other.leaseRevoke(identity.nodeId, lease.leaseId));
    assert.deepEqual(out, { state: 'ended' });
    assert.ok(broker.calls.includes('releaseAll'));
    assert.throws(() => leases.assertUsable('job-1'), (e) => e.code === 'lease_revoked');
    assert.equal(relay.last('kl.lease.status').message.reason, 'revoked');
    assert.ok(kinds().includes('lease.revoked'));
  });

  it('a replayed revoke changes nothing and re-sends the status; an unknown lease is refused', async () => {
    const lease = await granted();
    const revoke = phone.leaseRevoke(identity.nodeId, lease.leaseId);
    leases.onRevoke(revoke);
    const statuses = relay.all('kl.lease.status').length;
    assert.equal(leases.onRevoke(revoke).state, 'ended');
    assert.equal(relay.all('kl.lease.status').length, statuses + 1);
    assert.deepEqual(leases.onRevoke(phone.leaseRevoke(identity.nodeId, '00000000-0000-4000-8000-000000000000')), { state: 'rejected', reason: 'unknown_lease' });
  });

  it('endForJob ends the job\'s lease; stopAll ends everything as service_stopped', async () => {
    const lease = await granted();
    leases.endForJob('job-2');
    assert.equal(lease.state, 'active');
    leases.endForJob('job-1');
    assert.equal(lease.endReason, 'job_closed');
    const second = await granted({ jobId: 'job-3' });
    leases.stopAll();
    assert.equal(second.endReason, 'service_stopped');
  });

  it('rate limit: max_inputs_per_minute, with retry_after', async () => {
    const lease = await granted();
    for (let i = 0; i < 10; i += 1) leases.chargeInput(lease);
    assert.throws(() => leases.chargeInput(lease), (e) => e.code === 'rate_limited' && e.retryAfter === 60);
    timers.advance(60001);
    leases.chargeInput(lease);
  });

  it('a watch from an enrolled device for a known lease is accepted once', async () => {
    const lease = await granted();
    const watch = other.leaseWatch(identity.nodeId, lease.leaseId);
    const ok = leases.verifyWatch(watch);
    assert.equal(ok.accepted, true);
    assert.equal(ok.deviceId, other.deviceId);
    assert.equal(leases.verifyWatch(watch).reason, 'replay');
  });

  it('statusSummary for status.json', async () => {
    assert.equal(leases.statusSummary(), null);
    const lease = await granted();
    assert.deepEqual(leases.statusSummary(), { active: true, appIds: ['calculator'], expiresAt: new Date(lease.expiresAt).toISOString() });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/gui-leases.test.js`
Expected: FAIL with `Cannot find module '../src/gui/leases'`.

- [ ] **Step 4: Write `src/gui/leases.js`**

```js
// src/gui/leases.js
// Computer-use leases (fleet stage 5 spec §3.6): at most one pending, active
// or suspended lease per node, granted by a phone signature, limited to a job,
// a subset of the allowlisted apps and at most 60 minutes on the node clock.
// Memory only: a restart ends them all (fail-closed).
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { open } = require('../approvals/envelope');
const { NonceCache, bytesSha256 } = require('../approvals/verify-device');
const { createLogger } = require('../logging');
const { GuiError } = require('./errors');
const { TypedBuffer } = require('./text-guard');
const { suspendsLease } = require('./broker');
const L = require('./lease-protocol');

const NONCE_TTL_MS = 10 * 60 * 1000;
const HISTORY_MAX = 32;
const END_ERROR = { denied: 'lease_denied', request_expired: 'lease_request_expired', revoked: 'lease_revoked', expired: 'lease_expired', job_closed: 'job_closed' };

class LeaseManager extends EventEmitter {
  // jobOpen fails closed (R-F5-7): with none given, no job is open.
  constructor({ approvals, guiConfig, broker = null, audit = null, nodeName = null, clock = Date.now,
    timers = { setTimeout, clearTimeout }, jobOpen = () => false, log = createLogger('gui/leases') } = {}) {
    super();
    Object.assign(this, { approvals, guiConfig, broker, audit, clock, timers, jobOpen, log });
    this.nodeName = nodeName || (approvals.identity && approvals.identity.nodeName) || 'unnamed-node';
    this.leases = [];
    this.pending = new Map(); // request_id → { request_id, lease_id, nonce, lease_hash, expires_at, lease, resume, ref, envelope, delivered, timer }
    this.grantNonces = new NonceCache({ ttlMs: NONCE_TTL_MS, now: clock });
    this.controlNonces = new NonceCache({ ttlMs: NONCE_TTL_MS, now: clock });
    this._onDown = () => this._relayDown();
    this._onUp = () => this._relayUp();
  }

  setBroker(broker) { this.broker = broker; }

  setJobOpen(fn) { this.jobOpen = fn; }

  // Only `true` is open; a check that throws (a store that cannot be read) is closed.
  _jobIsOpen(jobId) {
    try {
      return this.jobOpen(jobId) === true;
    } catch (err) {
      this.log.warn(`job check for ${jobId} failed, treating the job as closed: ${err.message}`);
      return false;
    }
  }

  start() {
    const relay = this.approvals.relayClient;
    if (relay && typeof relay.on === 'function') {
      relay.on('disconnected', this._onDown);
      relay.on('connected', this._onUp);
    }
  }

  stop() {
    const relay = this.approvals.relayClient;
    if (relay && typeof relay.off === 'function') {
      relay.off('disconnected', this._onDown);
      relay.off('connected', this._onUp);
    }
    this.stopAll('service_stopped');
  }

  available() {
    const { relayClient, phoneApprover } = this.approvals;
    return Boolean(relayClient && phoneApprover && phoneApprover.isAvailable());
  }

  current() { return this.leases.find((l) => l.state !== 'ended') || null; }

  find(leaseId) { return this.leases.find((l) => l.leaseId === leaseId) || null; }

  active(jobId) {
    const l = this.current();
    return l && l.jobId === jobId && l.state === 'active' ? l : null;
  }

  remainingMs(lease) { return lease.expiresAt === null ? 0 : Math.max(0, lease.expiresAt - this.clock()); }

  nextSeq(lease) { lease.seq += 1; return lease.seq; }

  statusSummary() {
    const l = this.current();
    if (!l) return null;
    return { active: l.state === 'active', appIds: [...l.apps], expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt).toISOString() };
  }

  // The entry is handed to the ledger at once, so entries keep the order of
  // the calls; only its settling is left to a promise.
  _audit(kind, lease, extra = {}) {
    if (!this.audit) return;
    const data = { job_id: lease ? lease.jobId : null, lease_id: lease ? lease.leaseId : null, ...extra };
    const failed = (err) => this.log.warn(`audit ${kind} failed: ${err.message}`);
    try {
      Promise.resolve(this.audit.append({ kind, data })).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  _timer(fn, ms) {
    const t = this.timers.setTimeout(fn, Math.max(0, ms));
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  async request({ jobId, origin, appIds, minutes, reason, signal = null }) {
    // R-F5-7: a lease is bound to a job. A run with neither a job id nor a
    // chat id has none, and is refused before anything else is looked at.
    if (typeof jobId !== 'string' || !jobId) throw new GuiError('job_required', 'this run has no job or chat to bind a lease to');
    if (!this.available()) throw new GuiError('approval_unavailable');
    const cfg = this.guiConfig;
    if (!Array.isArray(appIds) || appIds.length < 1 || appIds.length > 8 || new Set(appIds).size !== appIds.length
      || appIds.some((id) => !Object.hasOwn(cfg.apps, id))) {
      throw new GuiError('invalid_params', '"apps" must be 1–8 distinct allowlisted app ids');
    }
    const max = Math.min(cfg.lease.maxMinutes, 60);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > max) throw new GuiError('invalid_params', `"minutes" must be 1–${max}`);
    // R-F5-7: a job that is not known to be open gets no lease; nothing is sent.
    if (!this._jobIsOpen(jobId)) throw new GuiError('job_closed', 'that job is not open on this node');
    let cur = this.current();
    // A lease whose own job is gone must not hold the node's one lease.
    if (cur && cur.jobId !== jobId && !this._jobIsOpen(cur.jobId)) {
      this._end(cur, 'job_closed');
      cur = null;
    }
    if (cur && cur.jobId !== jobId) throw new GuiError('lease_busy', 'another job holds this node\'s lease');
    if (cur && cur.state === 'active') return cur;
    if (cur && (cur.state === 'pending' || [...this.pending.values()].some((p) => p.ref === cur))) throw new GuiError('lease_pending', 'waiting for the phone');
    let lease = cur;
    if (!lease) {
      lease = {
        leaseId: crypto.randomUUID(), jobId, origin, reason: String(reason), requestedApps: [...appIds], maxMinutes: minutes,
        apps: [], state: 'pending', locked: false, endReason: null, suspendReason: null, expiresAt: null, deviceId: null,
        seq: 0, typed: new TypedBuffer(), inputTimes: [], waiters: [], expiryTimer: null
      };
      this.leases.push(lease);
      this._sendRequest(lease, { resume: false });
    } else {
      // A suspended lease whose resume request lapsed: ask again.
      this._sendRequest(lease, { resume: true });
    }
    return this._wait(lease, signal);
  }

  _wait(lease, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      lease.waiters.push(waiter);
      if (signal) {
        const onAbort = () => {
          lease.waiters = lease.waiters.filter((w) => w !== waiter);
          reject(new GuiError('cancelled', 'the request stays with the phone'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  _settle(lease, err = null) {
    const waiters = lease.waiters;
    lease.waiters = [];
    for (const w of waiters) (err ? w.reject(err) : w.resolve(lease));
  }

  _sendRequest(lease, { resume }) {
    const now = this.clock();
    const cfg = this.guiConfig;
    const ids = resume ? lease.apps : lease.requestedApps;
    const maxMinutes = resume ? Math.max(1, Math.ceil(this.remainingMs(lease) / 60000)) : lease.maxMinutes;
    const limits = this.broker && typeof this.broker.capability === 'function' ? this.broker.capability().limits || [] : [];
    const { message, envelope } = L.buildLeaseRequest({
      identity: this.approvals.identity, nodeName: this.nodeName, jobId: lease.jobId,
      apps: ids.map((id) => ({ id, name: cfg.apps[id].name, path: cfg.apps[id].path, processes: cfg.apps[id].processes })),
      maxMinutes, reason: lease.reason, resumes: resume, limits, origin: lease.origin, now, leaseId: lease.leaseId
    });
    const entry = {
      request_id: message.request_id, lease_id: message.lease_id, nonce: message.nonce, lease_hash: message.lease_hash,
      expires_at: message.expires_at, lease: message.lease, resume, ref: lease, envelope, delivered: false
    };
    entry.timer = this._timer(() => this._requestExpired(entry), L.REQUEST_TTL_MS);
    this.pending.set(entry.request_id, entry);
    this._audit('lease.requested', lease, { request_id: entry.request_id, apps: ids, minutes: maxMinutes, resumes: resume ? lease.leaseId : null });
    this._deliver(entry);
    this._status(lease);
  }

  _deliver(entry) {
    const relay = this.approvals.relayClient;
    if (!relay || !relay.isConnected()) return;
    relay.send(entry.envelope, { push: { kind: 'lease', id: entry.request_id, expires_at: entry.expires_at } })
      .then(() => { entry.delivered = true; })
      .catch((err) => this.log.info(`lease request held until the relay link returns: ${err.message}`));
  }

  _requestExpired(entry) {
    if (!this.pending.has(entry.request_id)) return;
    this.pending.delete(entry.request_id);
    const lease = entry.ref;
    this._audit('lease.expired', lease, { request_id: entry.request_id, reason: 'request_expired' });
    if (lease.state === 'pending') this._end(lease, 'request_expired');
    else this._settle(lease, new GuiError('lease_request_expired'));
  }

  onGrant(envelope) {
    const now = this.clock();
    const r = L.verifyLeaseGrant(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this.grantNonces,
      pending: this.pending, guiApps: this.guiConfig.apps, jobOpen: (jobId) => this._jobIsOpen(jobId), guiMaxMinutes: this.guiConfig.lease.maxMinutes
    }, now);
    if (!r.accepted) {
      let claimed = null;
      try { claimed = open(envelope).message; } catch { claimed = null; }
      this._audit('lease.rejected', claimed ? this.find(claimed.lease_id) : null, { check: r.check, reason: r.reason });
      // R-F5-7: a closed job cannot come back, so its pending lease ends here
      // instead of waiting out the request. job_closed is part of check 12,
      // which runs only after the device signature, the nonce and the
      // request binding (checks 1–11) held, so only an enrolled device's
      // answer to this very request gets this far.
      if (r.reason === 'job_closed') {
        const entry = claimed ? this.pending.get(claimed.request_id) : null;
        if (entry) {
          this._end(entry.ref, 'job_closed');
          return { state: 'ended', reason: 'job_closed' };
        }
      }
      return { state: 'rejected', reason: r.reason };
    }
    const m = r.message;
    this.grantNonces.add(m.nonce, bytesSha256(r.bytes));
    const entry = this.pending.get(m.request_id);
    this.pending.delete(m.request_id);
    this.timers.clearTimeout(entry.timer);
    const lease = entry.ref;
    lease.deviceId = r.deviceId;
    if (m.decision === 'deny') {
      this._audit('lease.denied', lease, { request_id: m.request_id, device_id: r.deviceId });
      this._end(lease, 'denied');
      return { state: 'ended' };
    }
    if (entry.resume && lease.expiresAt !== null && now >= lease.expiresAt) {
      this._end(lease, 'expired');
      return { state: 'ended' };
    }
    lease.apps = [...m.grant.apps];
    lease.expiresAt = L.effectiveExpiry({ verifiedAt: now, minutes: m.grant.minutes, resumeOf: entry.resume ? lease.expiresAt : null });
    lease.state = 'active';
    lease.suspendReason = null;
    lease.typed.reset();
    this._audit(entry.resume ? 'lease.resumed' : 'lease.granted', lease, {
      request_id: m.request_id, apps: lease.apps, minutes: m.grant.minutes, device_id: r.deviceId
    });
    if (entry.resume && this.broker) this.broker.focusApp(lease.apps).catch(() => {});
    this._armExpiry(lease);
    this._settle(lease);
    this._status(lease);
    return { state: 'active' };
  }

  _armExpiry(lease) {
    if (lease.expiryTimer) this.timers.clearTimeout(lease.expiryTimer);
    lease.expiryTimer = this._timer(() => {
      if (lease.state !== 'ended') {
        this._audit('lease.expired', lease, { reason: 'expired' });
        this._end(lease, 'expired');
      }
    }, lease.expiresAt - this.clock());
  }

  onRevoke(envelope) {
    let claimed = null;
    try { claimed = open(envelope).message; } catch { claimed = null; }
    const r = L.verifyLeaseRevoke(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this.controlNonces,
      knownLease: (id) => Boolean(this.find(id))
    });
    if (!r.accepted) {
      const lease = claimed ? this.find(claimed.lease_id) : null;
      if (r.reason === 'replay' && lease) {
        this._status(lease);
        return { state: lease.state };
      }
      this._audit('lease.rejected', lease, { check: r.check, reason: r.reason });
      return { state: 'rejected', reason: r.reason };
    }
    this.controlNonces.add(r.message.nonce, bytesSha256(r.bytes));
    const lease = this.find(r.message.lease_id);
    if (lease.state === 'ended') {
      this._status(lease);
      return { state: 'ended' };
    }
    this._audit('lease.revoked', lease, { device_id: r.deviceId, reason: r.message.reason });
    this._end(lease, 'revoked');
    return { state: 'ended' };
  }

  verifyWatch(envelope) {
    const r = L.verifyLeaseWatch(envelope, {
      approverStore: this.approvals.approverStore, nodeId: this.approvals.identity.nodeId, nonces: this.controlNonces,
      knownLease: (id) => Boolean(this.find(id))
    });
    if (!r.accepted) return { accepted: false, reason: r.reason };
    this.controlNonces.add(r.message.nonce, bytesSha256(r.bytes));
    const lease = this.find(r.message.lease_id);
    this._audit('lease.watch', lease, { device_id: r.deviceId });
    return { accepted: true, reason: null, lease, deviceId: r.deviceId };
  }

  assertUsable(jobId) {
    const now = this.clock();
    const cur = this.current();
    // Review Focus 2: never trust that the expiry timer already ran.
    if (cur && cur.expiresAt !== null && now >= cur.expiresAt && cur.state !== 'pending') {
      this._audit('lease.expired', cur, { reason: 'expired' });
      this._end(cur, 'expired');
    }
    // R-F5-7: a lease does not outlive its job.
    const held = this.current();
    if (held && !this._jobIsOpen(held.jobId)) this._end(held, 'job_closed');
    const lease = this.current();
    if (!lease || lease.jobId !== jobId) {
      const last = [...this.leases].reverse().find((l) => l.jobId === jobId && l.state === 'ended');
      if (last && last.endReason === 'revoked') throw new GuiError('lease_revoked', 'call RequestLease for a new lease');
      if (last && last.endReason === 'expired') throw new GuiError('lease_expired', 'call RequestLease for a new lease');
      if (last && last.endReason === 'job_closed') throw new GuiError('job_closed', 'the job this lease belonged to is not open');
      throw new GuiError('lease_required', 'call RequestLease first');
    }
    if (lease.state === 'pending') throw new GuiError('lease_pending', 'waiting for the phone');
    if (lease.state === 'suspended') throw new GuiError('lease_suspended', lease.suspendReason);
    if (lease.locked) throw new GuiError('screen_locked');
    return lease;
  }

  chargeInput(lease) {
    const now = this.clock();
    lease.inputTimes = lease.inputTimes.filter((t) => now - t < 60000);
    if (lease.inputTimes.length >= this.guiConfig.lease.maxInputsPerMinute) {
      throw new GuiError('rate_limited', null, { retryAfter: Math.max(1, Math.ceil((lease.inputTimes[0] + 60000 - now) / 1000)) });
    }
    lease.inputTimes.push(now);
  }

  noteInputOutcome(lease, { code = null, afterMatches = true } = {}) {
    if (lease.state !== 'active') return false;
    if (code && suspendsLease(code)) { this.suspend(lease.leaseId, code); return true; }
    if (!code && !afterMatches) { this.suspend(lease.leaseId, 'foreground_changed'); return true; }
    return false;
  }

  suspend(leaseId, reason) {
    const lease = this.find(leaseId);
    if (!lease || lease.state !== 'active') return;
    lease.state = 'suspended';
    lease.suspendReason = reason;
    lease.typed.reset();
    if (this.broker) this.broker.releaseAll().catch(() => {});
    this._audit('lease.suspended', lease, { reason });
    this._status(lease);
    if (this.remainingMs(lease) <= 0) { this._end(lease, 'expired'); return; }
    const relay = this.approvals.relayClient;
    if (reason !== 'relay_unreachable' && relay && relay.isConnected()) this._sendRequest(lease, { resume: true });
  }

  onHelperDisconnected() {
    const lease = this.current();
    if (lease && lease.state === 'active') this.suspend(lease.leaseId, 'helper_disconnected');
  }

  setLocked(locked) {
    const lease = this.current();
    if (!lease || lease.locked === locked) return;
    lease.locked = locked;
    this._status(lease);
  }

  _relayDown() {
    const lease = this.current();
    if (lease && lease.state === 'active') this.suspend(lease.leaseId, 'relay_unreachable');
  }

  _relayUp() {
    const now = this.clock();
    for (const entry of this.pending.values()) {
      if (!entry.delivered && now <= Date.parse(entry.expires_at)) this._deliver(entry);
    }
    const lease = this.current();
    if (lease && lease.state === 'suspended' && ![...this.pending.values()].some((p) => p.ref === lease)) this._sendRequest(lease, { resume: true });
  }

  endForJob(jobId, reason = 'job_closed') {
    for (const lease of this.leases) if (lease.jobId === jobId && lease.state !== 'ended') this._end(lease, reason);
  }

  stopAll(reason = 'service_stopped') {
    for (const lease of this.leases) if (lease.state !== 'ended') this._end(lease, reason);
  }

  _end(lease, reason) {
    if (lease.state === 'ended') return;
    lease.state = 'ended';
    lease.endReason = reason;
    if (lease.expiryTimer) this.timers.clearTimeout(lease.expiryTimer);
    for (const [id, entry] of this.pending) {
      if (entry.ref === lease) {
        this.timers.clearTimeout(entry.timer);
        this.pending.delete(id);
      }
    }
    if (this.broker) this.broker.releaseAll().catch(() => {});
    if (!['revoked', 'expired', 'denied'].includes(reason)) this._audit('lease.ended', lease, { reason });
    this._settle(lease, new GuiError(END_ERROR[reason] || 'lease_required', END_ERROR[reason] ? null : reason));
    this._status(lease);
    const ended = this.leases.filter((l) => l.state === 'ended');
    if (ended.length > HISTORY_MAX) this.leases = this.leases.filter((l) => l !== ended[0]);
  }

  _status(lease) {
    const relay = this.approvals.relayClient;
    this.emit('state', lease);
    if (this.broker && typeof this.broker.leaseChanged === 'function') this.broker.leaseChanged();
    if (!relay || !relay.isConnected()) return;
    const envelope = L.buildLeaseStatus({
      identity: this.approvals.identity, leaseId: lease.leaseId, seq: this.nextSeq(lease), state: lease.state, locked: lease.locked,
      reason: lease.endReason || lease.suspendReason || null, expiresAt: lease.expiresAt, now: this.clock()
    });
    relay.send(envelope).catch((err) => this.log.debug(`lease status not sent: ${err.message}`));
  }
}

module.exports = { LeaseManager };
```

Notes for the implementer:
- `leases.js` requires `broker.js` only for `suspendsLease`; `broker.js` never requires `leases.js` (it receives the instance through `setLeases`), so there is no cycle.
- The resume request's `max_minutes` is `ceil(remaining)`; the grant may carry at most that, and `effectiveExpiry` still clamps to the original expiry.
- `request`'s checks run in a fixed order: `job_required`, `approval_unavailable`, the parameters (`invalid_params`), then `job_closed`. A manager built with no `jobOpen` therefore still answers `approval_unavailable` when no phone can sign (the "no phone to sign" test), and never sends a request.
- `job_closed` is the one grant rejection that ends the lease (Deviation 6). Every other failed check still leaves the request pending, as §3.6 says.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/gui-leases.test.js tests/lease-vectors.test.js tests/approvals-fake-phone.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/gui/leases.js tests/gui-leases.test.js tests/helpers/fake-phone.js
git commit -m "feat(gui): computer-use lease manager

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The live view

**Review:** trust (window frames leave the machine here, to a device whose watch verified). **On Windows:** all of it can be checked.

**Files:**
- Create: `src/gui/live-view.js`
- Test: `tests/gui-live-view.test.js`

**Interfaces:**
- Consumes: `LeaseManager` (`verifyWatch`, `current`, `remainingMs`, `nextSeq`, event `'state'`) (Task 9); `GuiBroker.captureFrame` (Task 8); `buildLeaseView`, `VIEW_MAX_BYTES` (Task 6).
- Produces (`src/gui/live-view.js`): `class LiveView` — `new LiveView({ leases, broker, identity, relayClient, guiConfig, clock = Date.now, log, watchMs = 60000, tickMs = 250 })`; `start()`, `stop()`; `onWatch(envelope) → { state, reason? }`; `recordAction(lease, { tool, summary, result }) → action`; `tick() → Promise<void>` (tests call it directly); `ACTIONS_KEPT = 200`, `ACTIONS_PER_VIEW = 50`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-live-view.test.js`:

```js
// tests/gui-live-view.test.js
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { open } = require('../src/approvals/envelope');
const { LeaseManager } = require('../src/gui/leases');
const { LiveView } = require('../src/gui/live-view');
const { parseGuiConfig } = require('../src/gui/config');
const { verifyLeaseView, VIEW_MAX_BYTES } = require('../src/gui/lease-protocol');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const guiConfig = parseGuiConfig({ apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] } } }, { platform: 'win32' });

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; }
  isConnected() { return true; }
  async send(envelope, opts = {}) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  views() { return this.sent.filter((s) => s.message.type === 'kl.lease.view'); }
}

let clock;
let relay;
let leases;
let view;
let phone;
let identity;
let captures;
let frameBytes;

function jpeg(n) { return crypto.randomBytes(n).toString('base64'); }

beforeEach(async () => {
  phone = createFakePhone();
  identity = testNodeIdentity({ key: 'gpu-box' });
  clock = { t: Date.parse('2026-09-23T18:00:00.000Z') };
  relay = new FakeRelay();
  const store = await approverStoreWith([phone.approverRecord()], { now: () => clock.t });
  stores.push(store);
  captures = [];
  frameBytes = [20000];
  const broker = {
    releaseAll: async () => {}, focusApp: async () => {}, capability: () => ({ limits: [] }), leaseChanged: () => {},
    captureFrame: async ({ quality }) => {
      captures.push(quality);
      const n = frameBytes.length > 1 ? frameBytes.shift() : frameBytes[0];
      const data = jpeg(n);
      const bytes = Buffer.from(data, 'base64');
      return { appId: 'calculator', width: 960, height: 640, data, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('base64url') };
    }
  };
  leases = new LeaseManager({ approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true } }, guiConfig, broker, nodeName: 'gpu-box', clock: () => clock.t, timers: { setTimeout: () => ({}), clearTimeout: () => {} }, jobOpen: () => true });
  view = new LiveView({ leases, broker, identity, relayClient: relay, guiConfig, clock: () => clock.t });
});

async function activeLease() {
  const p = leases.request({ jobId: 'job-1', origin: { client: 'claude.ai', session: null, job_id: 'job-1' }, appIds: ['calculator'], minutes: 15, reason: 'x' });
  const req = relay.sent.filter((s) => s.message.type === 'kl.lease.request').pop();
  leases.onGrant(phone.leaseGrant(req.envelope, { minutes: 10 }));
  return p;
}

const at = async (ms) => { clock.t += ms; await view.tick(); };

describe('live view', () => {
  it('no frames without a watcher', async () => {
    await activeLease();
    await at(5000);
    assert.equal(relay.views().length, 0);
  });

  it('a watch subscribes the device for 60 s; frames every interval_s; signed views', async () => {
    const lease = await activeLease();
    assert.deepEqual(view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId)), { state: 'active' });
    await at(0);
    assert.equal(relay.views().length, 1);
    await at(1000);
    assert.equal(relay.views().length, 1, 'not before interval_s (3 s)');
    await at(2000);
    assert.equal(relay.views().length, 2);
    const v = relay.views()[1];
    assert.equal(v.opts.to_device, phone.deviceId);
    assert.equal(verifyLeaseView(v.envelope, { nodeId: identity.nodeId, nodePublicKeyHex: identity.publicKey.toString('hex') }).accepted, true);
    for (let i = 0; i < 20; i += 1) await at(3000);
    const count = relay.views().length;
    await at(3000);
    assert.equal(relay.views().length, count, 'the watch lapsed after 60 s');
  });

  it('at most 1 frame per second overall, even with inputs in between', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    await at(0);
    const start = captures.length;
    for (let i = 0; i < 10; i += 1) {
      view.recordAction(lease, { tool: 'Key', summary: 'Key a', result: 'ok' });
      await at(200);
    }
    assert.ok(captures.length - start <= 2, `${captures.length - start} captures in 2 s`);
  });

  it('an input triggers a frame sooner than the interval; actions ride along, oldest first', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    await at(0);
    view.recordAction(lease, { tool: 'Type', summary: 'Type "12+30=" (6 chars)', result: 'ok' });
    await at(1000);
    const last = relay.views().pop().message;
    assert.equal(last.actions.length, 1);
    assert.equal(last.actions[0].tool, 'Type');
  });

  it('re-encodes once at quality − 20 over max_frame_bytes, then drops the frame', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    frameBytes = [200000, 150000, 20000];
    await at(0);
    assert.deepEqual(captures.slice(-2), [60, 40]);
    assert.ok(relay.views().pop().message.frame);
    frameBytes = [200000, 190000, 20000];
    await at(3000);
    const dropped = relay.views().pop().message;
    assert.equal(dropped.frame, null);
    assert.equal(dropped.frame_dropped, true);
  });

  it('the biggest allowed frame keeps the view under 256 KiB', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    for (let i = 0; i < 60; i += 1) view.recordAction(lease, { tool: 'Type', summary: 'x'.repeat(120), result: 'refused:text_looks_secret' });
    frameBytes = [184320];
    await at(0);
    const v = relay.views().pop();
    assert.ok(Buffer.from(v.envelope.payload, 'base64url').length <= VIEW_MAX_BYTES);
    assert.ok(v.message.frame);
    assert.equal(v.message.actions.length, 50);
  });

  it('no frames while suspended or locked; a watch for an unknown lease is refused', async () => {
    const lease = await activeLease();
    view.onWatch(phone.leaseWatch(identity.nodeId, lease.leaseId));
    leases.setLocked(true);
    await at(5000);
    assert.equal(relay.views().length, 0);
    leases.setLocked(false);
    leases.suspend(lease.leaseId, 'foreground_mismatch');
    await at(5000);
    assert.equal(relay.views().length, 0);
    assert.equal(view.onWatch(phone.leaseWatch(identity.nodeId, '00000000-0000-4000-8000-000000000000')).reason, 'unknown_lease');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-live-view.test.js`
Expected: FAIL with `Cannot find module '../src/gui/live-view'`.

- [ ] **Step 3: Write `src/gui/live-view.js`**

```js
// src/gui/live-view.js
// The phone's live lease view (fleet stage 5 spec §3.7): frames only while a
// phone watches and the lease is active and unlocked, at most one capture per
// second in total, each view ≤ 256 KiB. Frames are never stored or audited;
// each view carries the frame's sha256.
const { createLogger } = require('../logging');
const L = require('./lease-protocol');

const ACTIONS_KEPT = 200;
const ACTIONS_PER_VIEW = 50;
const MIN_FRAME_GAP_MS = 1000;

class LiveView {
  constructor({ leases, broker, identity, relayClient, guiConfig, clock = Date.now, log = createLogger('gui/live-view'), watchMs = 60000, tickMs = 250 } = {}) {
    Object.assign(this, { leases, broker, identity, relayClient, guiConfig, clock, log, watchMs, tickMs });
    this.watchers = new Map(); // deviceId → { leaseId, until, cursor, lastFrameAt }
    this.actions = new Map(); // leaseId → [action]
    this.nextAction = 1;
    this.lastCaptureAt = -Infinity;
    this.inputPending = new Set();
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => { this.tick().catch((err) => this.log.warn(`live view tick failed: ${err.message}`)); }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.watchers.clear();
  }

  onWatch(envelope) {
    const r = this.leases.verifyWatch(envelope);
    if (!r.accepted) return { state: 'rejected', reason: r.reason };
    const list = this.actions.get(r.lease.leaseId) || [];
    const lastSeq = list.length ? list[list.length - 1].seq : 0;
    const existing = this.watchers.get(r.deviceId);
    this.watchers.set(r.deviceId, {
      leaseId: r.lease.leaseId, until: this.clock() + this.watchMs,
      cursor: existing && existing.leaseId === r.lease.leaseId ? existing.cursor : Math.max(0, lastSeq - ACTIONS_KEPT),
      lastFrameAt: existing && existing.leaseId === r.lease.leaseId ? existing.lastFrameAt : -Infinity
    });
    return { state: r.lease.state };
  }

  recordAction(lease, { tool, summary, result }) {
    const action = { seq: this.nextAction, at: new Date(this.clock()).toISOString(), tool: String(tool).slice(0, 32), summary: String(summary).slice(0, 120), result: String(result).slice(0, 80) };
    this.nextAction += 1;
    const list = this.actions.get(lease.leaseId) || [];
    list.push(action);
    while (list.length > ACTIONS_KEPT) list.shift();
    this.actions.set(lease.leaseId, list);
    this.inputPending.add(lease.leaseId);
    return action;
  }

  async _capture() {
    const cfg = this.guiConfig.liveView;
    const lease = this.leases.current();
    let shot = await this.broker.captureFrame({ appIds: lease.apps, maxWidth: cfg.maxWidth, quality: cfg.quality });
    if (!shot || !shot.appId) return { appId: null, frame: null, dropped: false };
    if (shot.bytes > cfg.maxFrameBytes) {
      shot = await this.broker.captureFrame({ appIds: lease.apps, maxWidth: cfg.maxWidth, quality: Math.max(10, cfg.quality - 20) });
      if (!shot || !shot.appId) return { appId: null, frame: null, dropped: false };
      if (shot.bytes > cfg.maxFrameBytes) return { appId: shot.appId, frame: null, dropped: true };
    }
    return { appId: shot.appId, frame: { mime: 'image/jpeg', width: shot.width, height: shot.height, sha256: shot.sha256, data: shot.data }, dropped: false };
  }

  _build(lease, deviceId, w, captured) {
    const list = (this.actions.get(lease.leaseId) || []).filter((a) => a.seq > w.cursor).slice(0, ACTIONS_PER_VIEW);
    const make = (frame, dropped) => L.buildLeaseView({
      identity: this.identity, leaseId: lease.leaseId, seq: this.leases.nextSeq(lease), toDevice: deviceId, state: lease.state,
      locked: lease.locked, remainingS: Math.floor(this.leases.remainingMs(lease) / 1000),
      foreground: { app_id: captured.appId, matches: captured.appId !== null }, frame, frameDropped: dropped, actions: list, now: this.clock()
    });
    let envelope = make(captured.frame, captured.dropped);
    // The payload is the JCS bytes, so its length is the view's size.
    if (Buffer.from(envelope.payload, 'base64url').length > L.VIEW_MAX_BYTES) envelope = make(null, true);
    return { envelope, lastSeq: list.length ? list[list.length - 1].seq : w.cursor };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      for (const [id, w] of this.watchers) if (w.until <= now) this.watchers.delete(id);
      const lease = this.leases.current();
      if (!lease || lease.state !== 'active' || lease.locked) return;
      if (now - this.lastCaptureAt < MIN_FRAME_GAP_MS) return;
      const intervalMs = this.guiConfig.liveView.intervalS * 1000;
      const afterInput = this.inputPending.has(lease.leaseId);
      const due = [...this.watchers].filter(([, w]) => w.leaseId === lease.leaseId && (afterInput || now - w.lastFrameAt >= intervalMs));
      if (due.length === 0) return;
      this.lastCaptureAt = now;
      this.inputPending.delete(lease.leaseId);
      let captured;
      try {
        captured = await this._capture();
      } catch (err) {
        this.log.debug(`live frame not captured: ${err.message}`);
        captured = { appId: null, frame: null, dropped: false };
      }
      for (const [deviceId, w] of due) {
        const { envelope, lastSeq } = this._build(lease, deviceId, w, captured);
        w.lastFrameAt = now;
        w.cursor = lastSeq;
        this.relayClient.send(envelope, { to_device: deviceId }).catch((err) => this.log.debug(`view not sent: ${err.message}`));
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { LiveView, ACTIONS_KEPT, ACTIONS_PER_VIEW };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/gui-live-view.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/gui/live-view.js tests/gui-live-view.test.js
git commit -m "feat(gui): live lease view with frame budget and action log

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: The relay routes for leases

**Review:** trust (which device may fetch or post what; nothing here verifies a lease, the node does). **On Windows:** all of it can be checked.

R-F5-6 in this task (Deviation 41): the `202` for `POST …/watch` also carries `after_seq`, the mailbox position read before the node hears the watch. The per-route rate limits are Deviation 32.

**Files:**
- Create: `src/gui/relay-extension.js`
- Modify: `src/frontdoor/extensions.js` (one line)
- Test: `tests/gui-relay-extension.test.js`

**Interfaces:**
- Consumes: F3's extension view `{ phoneApi, nodeHub, mailbox, devices, log }`; `open` (`src/approvals/envelope.js`); `lease-protocol.js` (for the message types it routes).
- Produces (`src/gui/relay-extension.js`): `registerLeaseRoutes(relay) → void` — mailbox prefix `kl.lease.` (`ttlMs: 300000`, `maxBytes: 262144`); routes `GET /v1/leases`, `POST /v1/leases/{lease_id}/grant|revoke|watch`, `GET /v1/leases/{lease_id}/views` (all `auth: 'device'`); node RPC methods `lease.grant`, `lease.revoke`, `lease.watch` with `{ envelope }` and `timeoutMs: 10000`. The `202` body is the node's `{ state, reason? }`; for `watch` it also has `after_seq` (an integer, the mailbox's `seq` before the RPC). `LEASE_TTL_MS = 300000`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-relay-extension.test.js`:

```js
// tests/gui-relay-extension.test.js
//
// The relay side of leases (spec §4.7) against F3's real Mailbox and route
// shapes, with the node hub and the device registry faked the way
// tests/contact-mobile.test.js does for questions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/approvals/envelope');
const { Mailbox } = require('../src/frontdoor/mailbox');
const { registerLeaseRoutes, LEASE_TTL_MS } = require('../src/gui/relay-extension');
const L = require('../src/gui/lease-protocol');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const extensions = require('../src/frontdoor/extensions');

const node = testNodeIdentity({ key: 'gpu-box' });
const NODE = node.nodeId;

function relay({ offline = false, nodesForDevice = null } = {}) {
  const routes = new Map();
  const rpcs = [];
  const phoneApi = { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) };
  const nodeHub = {
    rpc: async (nodeId, method, params, opts) => {
      rpcs.push({ nodeId, method, params, opts });
      if (offline) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      return { state: 'active' };
    }
  };
  let now = Date.parse('2026-09-23T18:00:00.000Z');
  const mailbox = new Mailbox({ now: () => now });
  const devices = { nodesForDevice: nodesForDevice || (() => [{ node_id: NODE, state: 'active' }]) };
  registerLeaseRoutes({ phoneApi, nodeHub, mailbox, devices, log: { warn() {}, debug() {}, info() {} } });
  return { routes, rpcs, mailbox, advance: (ms) => { now += ms; } };
}

function request() {
  return L.buildLeaseRequest({
    identity: node, nodeName: 'gpu-box', jobId: 'job-1', apps: [{ id: 'calculator', name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: [] }],
    maxMinutes: 15, reason: 'Enter the totals', origin: { client: 'claude.ai', session: null, job_id: 'job-1' }, now: Date.parse('2026-09-23T18:00:00.000Z')
  });
}

const call = (r, key, phone, { params = {}, query = {}, body = null } = {}) => r.routes.get(key).handler({}, { deviceId: phone.deviceId, params, query, body });

describe('lease routes', () => {
  it('is mounted in F3\'s extension list and registers the routes with the kl.lease. prefix', () => {
    assert.ok(extensions.includes(registerLeaseRoutes));
    const r = relay();
    assert.deepEqual([...r.routes.keys()], [
      'GET /v1/leases', 'POST /v1/leases/{lease_id}/grant', 'POST /v1/leases/{lease_id}/revoke', 'POST /v1/leases/{lease_id}/watch', 'GET /v1/leases/{lease_id}/views'
    ]);
    for (const spec of r.routes.values()) assert.equal(spec.auth, 'device');
    assert.deepEqual(r.mailbox.types.get('kl.lease.'), { ttlMs: LEASE_TTL_MS, maxBytes: 262144 });
  });

  it('lists pending requests for the device\'s nodes with each lease\'s latest status', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message, envelope } = request();
    r.mailbox.put(NODE, envelope);
    let listed = await call(r, 'GET /v1/leases', phone);
    assert.deepEqual(listed.body, [{ node_id: NODE, envelope, status: null }]);
    const status1 = L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 1, state: 'pending' });
    const status2 = L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 2, state: 'active', expiresAt: Date.now() });
    r.mailbox.put(NODE, status1);
    r.mailbox.put(NODE, status2);
    listed = await call(r, 'GET /v1/leases', phone);
    assert.deepEqual(listed.body[0].status, status2);
    const stranger = await r.routes.get('GET /v1/leases').handler({}, { deviceId: 'd-otherotherother', params: {}, query: {} });
    assert.equal(stranger.body.length, 1, 'the fake registry lists the node for every device');
    const none = relay({ nodesForDevice: () => [{ node_id: NODE, state: 'revoked' }] });
    none.mailbox.put(NODE, envelope);
    assert.deepEqual((await call(none, 'GET /v1/leases', phone)).body, []);
  });

  it('long-polls with wait', async () => {
    const r = relay();
    const phone = createFakePhone();
    const polling = call(r, 'GET /v1/leases', phone, { query: { wait: '5' } });
    setTimeout(() => r.mailbox.put(NODE, request().envelope), 50);
    assert.equal((await polling).body.length, 1);
  });

  for (const action of ['grant', 'revoke', 'watch']) {
    it(`POST ${action} forwards the phone envelope unchanged to lease.${action}`, async () => {
      const r = relay();
      const phone = createFakePhone();
      const { message, envelope } = request();
      const body = action === 'grant' ? phone.leaseGrant(envelope) : action === 'revoke' ? phone.leaseRevoke(NODE, message.lease_id) : phone.leaseWatch(NODE, message.lease_id);
      const sent = JSON.parse(JSON.stringify(body));
      const out = await call(r, `POST /v1/leases/{lease_id}/${action}`, phone, { params: { lease_id: message.lease_id }, body });
      // Only the watch reply carries the mailbox position (R-F5-6); the mailbox is empty here.
      assert.deepEqual(out, { status: 202, body: action === 'watch' ? { state: 'active', after_seq: 0 } : { state: 'active' } });
      assert.deepEqual(r.rpcs, [{ nodeId: NODE, method: `lease.${action}`, params: { envelope: sent }, opts: { timeoutMs: 10000 } }]);
    });
  }

  it('R-F5-6: the watch reply carries the mailbox position, and a views fetch from it waits for the frame', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message } = request();
    // What a granted lease has already left in the mailbox: its statuses.
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 1, state: 'pending' }));
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 2, state: 'active' }));
    const route = 'GET /v1/leases/{lease_id}/views';
    // From 0, `wait` returns at once with the old statuses and no frame.
    const early = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: '0', wait: '5' } });
    assert.equal(early.body.length, 2);
    assert.ok(early.body.every((e) => open(e.envelope).message.type === 'kl.lease.status'));

    const watched = await call(r, 'POST /v1/leases/{lease_id}/watch', phone, { params: { lease_id: message.lease_id }, body: phone.leaseWatch(NODE, message.lease_id) });
    assert.deepEqual(watched, { status: 202, body: { state: 'active', after_seq: 2 } });

    const polling = call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(watched.body.after_seq), wait: '5' } });
    const frame = { mime: 'image/jpeg', width: 2, height: 2, sha256: 'A'.repeat(43), data: 'AA==' };
    const view = L.buildLeaseView({
      identity: node, leaseId: message.lease_id, seq: 3, toDevice: phone.deviceId, state: 'active', locked: false, remainingS: 60,
      foreground: { app_id: 'calculator', matches: true }, frame, frameDropped: false, actions: []
    });
    setTimeout(() => r.mailbox.put(NODE, view, { to_device: phone.deviceId }), 50);
    const got = await polling;
    assert.equal(got.body.length, 1);
    assert.equal(open(got.body[0].envelope).message.type, 'kl.lease.view');
  });

  it('a node cannot set after_seq itself', async () => {
    const routes = new Map();
    const mailbox = new Mailbox();
    registerLeaseRoutes({
      phoneApi: { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) },
      nodeHub: { rpc: async () => ({ state: 'active', after_seq: 999999 }) },
      mailbox, devices: { nodesForDevice: () => [{ node_id: NODE, state: 'active' }] }, log: { warn() {}, debug() {}, info() {} }
    });
    const phone = createFakePhone();
    const { message } = request();
    const out = await routes.get('POST /v1/leases/{lease_id}/watch').handler({}, { deviceId: phone.deviceId, params: { lease_id: message.lease_id }, query: {}, body: phone.leaseWatch(NODE, message.lease_id) });
    assert.equal(out.body.after_seq, 0);
  });

  it('refuses a body signed for another device, another lease, the wrong type, or a node it cannot reach', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message, envelope } = request();
    const grant = phone.leaseGrant(envelope);
    const route = 'POST /v1/leases/{lease_id}/grant';
    await assert.rejects(r.routes.get(route).handler({}, { deviceId: 'd-otherotherother', params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 403);
    await assert.rejects(call(r, route, phone, { params: { lease_id: '00000000-0000-4000-8000-000000000000' }, body: grant }), (e) => e.status === 400);
    await assert.rejects(call(r, route, phone, { params: { lease_id: message.lease_id }, body: phone.leaseWatch(NODE, message.lease_id) }), (e) => e.status === 400);
    await assert.rejects(call(r, route, phone, { params: { lease_id: message.lease_id }, body: { not: 'an envelope' } }), (e) => e.status === 400);
    const elsewhere = relay({ nodesForDevice: () => [] });
    await assert.rejects(call(elsewhere, route, phone, { params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 404);
    assert.equal(r.rpcs.length, 0);
    const offline = relay({ offline: true });
    await assert.rejects(call(offline, route, phone, { params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 503 && e.code === 'node_offline');
  });

  it('views: only those for the caller, with statuses, after after_seq, long-polled', async () => {
    const r = relay();
    const phone = createFakePhone();
    const otherPhone = createFakePhone();
    const { message } = request();
    const mkView = (to, seq) => L.buildLeaseView({
      identity: node, leaseId: message.lease_id, seq, toDevice: to, state: 'active', locked: false, remainingS: 60,
      foreground: { app_id: 'calculator', matches: true }, frame: null, frameDropped: false, actions: []
    });
    r.mailbox.put(NODE, mkView(phone.deviceId, 1), { to_device: phone.deviceId });
    r.mailbox.put(NODE, mkView(otherPhone.deviceId, 2), { to_device: otherPhone.deviceId });
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 3, state: 'active' }));
    const route = 'GET /v1/leases/{lease_id}/views';
    const got = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: '0' } });
    assert.equal(got.body.length, 2);
    assert.ok(got.body.every((e) => Number.isInteger(e.seq)));
    const after = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(got.body[1].seq) } });
    assert.deepEqual(after.body, []);
    const polling = call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(got.body[1].seq), wait: '5' } });
    setTimeout(() => r.mailbox.put(NODE, mkView(phone.deviceId, 4), { to_device: phone.deviceId }), 50);
    assert.equal((await polling).body.length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-relay-extension.test.js`
Expected: FAIL with `Cannot find module '../src/gui/relay-extension'`.

- [ ] **Step 3: Write `src/gui/relay-extension.js`**

```js
// src/gui/relay-extension.js
// The relay side of computer-use leases (fleet stage 5 spec §4.7), mounted
// through src/frontdoor/extensions.js. The relay stores and forwards; the
// node verifies every phone envelope (lease-protocol.js checks 1–12). The
// checks here only keep obvious junk off the link. Loads no agent code.
const { open } = require('../approvals/envelope');

const LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 262144;
const MAX_WAIT_S = 25;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIONS = { grant: 'kl.lease.grant', revoke: 'kl.lease.revoke', watch: 'kl.lease.watch' };

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function messageOf(envelope) {
  try {
    return open(envelope).message;
  } catch {
    return null;
  }
}

const waitMs = (query) => Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt((query && query.wait) || '0', 10) || 0)) * 1000;

// (relay) => void, receiving { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }.
function registerLeaseRoutes({ phoneApi, nodeHub, mailbox, devices, log }) {
  mailbox.registerType('kl.lease.', { ttlMs: LEASE_TTL_MS, maxBytes: MAX_BYTES });
  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);

  // Pending requests with the latest status of each lease.
  function leaseList(deviceId) {
    const items = mailbox.list({ nodeIds: activeNodes(deviceId), typePrefix: 'kl.lease.', toDevice: deviceId });
    const latest = new Map();
    const requests = [];
    for (const item of items) {
      const m = messageOf(item.envelope);
      if (!m) continue;
      if (m.type === 'kl.lease.status') latest.set(`${item.node_id}|${m.lease_id}`, item.envelope);
      if (m.type === 'kl.lease.request') requests.push({ item, leaseId: m.lease_id });
    }
    return requests.map(({ item, leaseId }) => ({ node_id: item.node_id, envelope: item.envelope, status: latest.get(`${item.node_id}|${leaseId}`) || null }));
  }

  phoneApi.registerRoute('GET', '/v1/leases', {
    auth: 'device',
    handler: async (req, ctx) => {
      const ms = waitMs(ctx.query);
      if (ms > 0 && leaseList(ctx.deviceId).length === 0) {
        await mailbox.wait({ nodeIds: activeNodes(ctx.deviceId), typePrefix: 'kl.lease.request', toDevice: ctx.deviceId }, { timeoutMs: ms });
      }
      return { body: leaseList(ctx.deviceId) };
    }
  });

  for (const [action, type] of Object.entries(ACTIONS)) {
    phoneApi.registerRoute('POST', `/v1/leases/{lease_id}/${action}`, {
      auth: 'device',
      rate: action === 'watch' ? { perMin: 12 } : { perMin: 30 },
      handler: async (req, ctx) => {
        const leaseId = String(ctx.params.lease_id);
        if (!UUID_V4_RE.test(leaseId)) throw httpError(400, 'bad_lease', 'not a lease id');
        const m = messageOf(ctx.body);
        if (!m) throw httpError(400, 'malformed', 'the body is not an envelope');
        if (m.type !== type) throw httpError(400, 'malformed', `not a ${type}`);
        if (m.device_id !== ctx.deviceId) throw httpError(403, 'forbidden', 'the envelope is signed for another device');
        if (m.lease_id !== leaseId) throw httpError(400, 'bad_lease', 'the lease id does not match the path');
        if (!activeNodes(ctx.deviceId).includes(m.node_id)) throw httpError(404, 'not_found', 'no such node for this device');
        // R-F5-6: read before the node hears the watch, so the view this
        // watch causes is after it. A phone that fetches on tap asks for
        // views from here with `wait` and gets that frame, not the statuses
        // the lease left earlier.
        const position = action === 'watch' && Number.isInteger(mailbox.seq) ? mailbox.seq : null;
        let result;
        try {
          result = await nodeHub.rpc(m.node_id, `lease.${action}`, { envelope: ctx.body }, { timeoutMs: 10000 });
        } catch (err) {
          log.warn(`lease.${action} to ${m.node_id} failed: ${err.message}`);
          throw httpError(503, 'node_offline', 'the node did not answer; try again');
        }
        // The relay's field goes last, so a node's reply cannot set it.
        if (position !== null && result !== null && typeof result === 'object' && !Array.isArray(result)) {
          return { status: 202, body: { ...result, after_seq: position } };
        }
        return { status: 202, body: result };
      }
    });
  }

  function views(deviceId, leaseId, afterSeq) {
    return mailbox.list({ nodeIds: activeNodes(deviceId), typePrefix: 'kl.lease.', toDevice: deviceId, afterSeq })
      .filter((item) => {
        const m = messageOf(item.envelope);
        return m && m.lease_id === leaseId && (m.type === 'kl.lease.view' || m.type === 'kl.lease.status');
      })
      .map((item) => ({ seq: item.seq, envelope: item.envelope }));
  }

  phoneApi.registerRoute('GET', '/v1/leases/{lease_id}/views', {
    auth: 'device',
    handler: async (req, ctx) => {
      const leaseId = String(ctx.params.lease_id);
      if (!UUID_V4_RE.test(leaseId)) throw httpError(400, 'bad_lease', 'not a lease id');
      const afterSeq = Math.max(0, Number.parseInt((ctx.query && ctx.query.after_seq) || '0', 10) || 0);
      const deadline = Date.now() + waitMs(ctx.query);
      const filter = (seq) => ({ nodeIds: activeNodes(ctx.deviceId), typePrefix: 'kl.lease.', toDevice: ctx.deviceId, afterSeq: seq });
      let out = views(ctx.deviceId, leaseId, afterSeq);
      // Wait past messages for other leases (the mailbox wait returns at
      // once while anything newer than the cursor is listed).
      let cursor = afterSeq;
      while (out.length === 0 && Date.now() < deadline) {
        const seen = mailbox.list(filter(cursor));
        if (seen.length) cursor = seen[seen.length - 1].seq;
        const woke = await mailbox.wait(filter(cursor), { timeoutMs: deadline - Date.now() });
        if (woke.length === 0) break;
        cursor = woke[woke.length - 1].seq;
        out = views(ctx.deviceId, leaseId, afterSeq);
      }
      return { body: out };
    }
  });
}

module.exports = { registerLeaseRoutes, LEASE_TTL_MS };
```

- [ ] **Step 4: Mount it**

In `src/frontdoor/extensions.js`, append:

```js
// Fleet stage 5 §4.7: computer-use leases (requests, grants, the kill switch and the live view).
module.exports.push(require('../gui/relay-extension').registerLeaseRoutes);
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/gui-relay-extension.test.js tests/frontdoor-relay.test.js tests/contact-mobile.test.js tests/service-profile-graph.test.js`
Expected: PASS, `# fail 0` (the relay and front-door graphs now load `src/gui/relay-extension.js` and `src/gui/lease-protocol.js`, both allowed since Task 1).

- [ ] **Step 6: Commit**

```bash
git add src/gui/relay-extension.js src/frontdoor/extensions.js tests/gui-relay-extension.test.js
git commit -m "feat(gui): relay routes for lease requests, grants, revokes and views

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 2

Every test file Tasks 7–11 name shows `# fail 0` (the full suite runs once, in Task 21). Part 3 (`2026-09-23-fleet-stage5-session-helper-part3.md`) starts at Task 12 on these commits.
