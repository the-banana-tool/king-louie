// tests/desktop-bridge-protocol.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { buildAuthS, buildAuthC, newNonce, PROTOCOL } = require('../src/desktop-bridge/protocol');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
const servers = [];
const identity = new NodeIdentity({ nodeName: 'gpu-box' });

after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeDevice(label = 'web-01 desk') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label, privateKey };
}

function writeDevices(configDir, devices) {
  let doc = pairing.emptyDevices();
  for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-09-23T14:02:11Z' });
  pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
}

function fakeDispatcher({ disconnectDelayMs = 0, hangDisconnect = false } = {}) {
  return {
    served: { handle: ['chat:load', 'chat:sendMessage'], on: ['tool:approvalResponse'] },
    frames: [],
    disconnects: [],
    providersConfigured: () => true,
    async handleFrame(conn, frame) {
      this.frames.push(frame);
      if (frame.t === 'invoke') {
        if (frame.channel === 'chat:sendMessage') await new Promise((r) => setTimeout(r, 200));
        conn.send({ t: 'result', id: frame.id, value: { ok: true, data: { echo: frame.args } } });
      }
    },
    async onDisconnect(conn) {
      if (hangDisconnect) return new Promise(() => {}); // never settles
      if (disconnectDelayMs) await new Promise((r) => setTimeout(r, disconnectDelayMs));
      this.disconnects.push(conn.deviceId);
    },
    forwardAmbient() {}
  };
}

async function startServer({ devices = [], limits = {}, dispatcher: dispatcherOverride = null } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-'));
  dirs.push(configDir);
  writeDevices(configDir, devices);
  const dispatcher = dispatcherOverride || fakeDispatcher();
  const server = new DesktopBridgeServer({
    identity, configDir, port: 0, version: '26.9.0', adminUid: selfUid, account: 'LOCAL SERVICE',
    createDispatcher: () => dispatcher, limits
  });
  servers.push(server);
  const { port } = await server.start();
  return { server, port, configDir, dispatcher };
}

// A hand-driven client: records every frame it receives and the close code.
function rawClient(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options);
  const received = [];
  const waiters = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    received.push(frame);
    for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
  });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
  ws.on('error', () => {});
  const next = (match) => {
    const hit = received.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { statusCode: res.statusCode }))); });
  return { ws, received, closed, next, opened, send: (obj) => ws.send(JSON.stringify(obj)) };
}

// Runs the handshake; `tamper` changes the auth signature or the protocol.
async function handshake(port, device, { tamper = null, protocol = PROTOCOL } = {}) {
  const c = rawClient(port);
  await c.opened;
  const challenge = await c.next((f) => f.t === 'challenge');
  const clientNonce = newNonce();
  c.send({ t: 'clientHello', protocol, deviceId: device.deviceId, clientNonce });
  const outcome = await Promise.race([c.next((f) => f.t === 'hello'), c.closed.then((close) => ({ close }))]);
  if (outcome.close) return { c, challenge, close: outcome.close };
  const fields = { nodeId: identity.nodeId, deviceId: device.deviceId, port, serverNonce: challenge.serverNonce, clientNonce };
  const helloOk = keys.verifyWithSpkiHex(identity.publicKey.toString('hex'), Buffer.from(buildAuthS(fields)), keys.fromB64url(outcome.sig));
  let sig = keys.toB64url(crypto.sign(null, Buffer.from(buildAuthC(fields)), device.privateKey));
  if (tamper) sig = tamper(sig);
  c.send({ t: 'auth', sig });
  const end = await Promise.race([c.next((f) => f.t === 'ready'), c.closed.then((close) => ({ close }))]);
  return { c, challenge, helloOk, sig, ready: end.t === 'ready' ? end : null, close: end.close || null };
}

describe('auth strings', () => {
  it('join the fixed fields with newlines, port included', () => {
    const fields = { nodeId: identity.nodeId, deviceId: makeDevice().deviceId, port: 18795, serverNonce: newNonce(), clientNonce: newNonce() };
    assert.strictEqual(buildAuthS(fields), ['kl.desktop.hello.v1', fields.nodeId, fields.deviceId, '18795', fields.serverNonce, fields.clientNonce].join('\n'));
    assert.strictEqual(buildAuthC(fields), ['kl.desktop.auth.v1', fields.nodeId, fields.deviceId, '18795', fields.serverNonce, fields.clientNonce].join('\n'));
    assert.throws(() => buildAuthS({ ...fields, port: 0 }), /malformed/);
    assert.throws(() => buildAuthC({ ...fields, clientNonce: 'short' }), /malformed/);
  });
});

describe('DesktopBridgeServer handshake', () => {
  it('proves itself first, then accepts a paired device', async () => {
    const device = makeDevice();
    const { port, server } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    assert.strictEqual(out.helloOk, true, 'hello.sig verifies under the node key');
    assert.deepStrictEqual(out.c.received.map((f) => f.t), ['challenge', 'hello', 'ready']);
    assert.strictEqual(out.ready.service.protocol, 1);
    assert.strictEqual(out.ready.service.nodeId, identity.nodeId);
    assert.strictEqual(out.ready.service.account, 'LOCAL SERVICE');
    assert.deepStrictEqual(out.ready.service.channels, ['chat:load', 'chat:sendMessage', 'tool:approvalResponse']);
    assert.deepStrictEqual(server.connected, { deviceId: device.deviceId, label: device.label });
    out.c.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    const result = await out.c.next((f) => f.t === 'result' && f.id === 1);
    assert.deepStrictEqual(result.value, { ok: true, data: { echo: [] } });
    out.c.ws.close();
  });

  it('closes 4401 for a wrong device key', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const impostor = { ...device, privateKey: crypto.generateKeyPairSync('ed25519').privateKey };
    const out = await handshake(port, impostor);
    assert.strictEqual(out.close.code, 4401);
  });

  it('closes 4403 for an unknown device', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const out = await handshake(port, makeDevice());
    assert.strictEqual(out.close.code, 4403);
  });

  it('rejects a replayed auth: every challenge has a new serverNonce', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const first = await handshake(port, device);
    assert.ok(first.ready);
    first.c.ws.close();
    await first.c.closed;
    const replay = await handshake(port, device, { tamper: () => first.sig });
    assert.notStrictEqual(replay.challenge.serverNonce, first.challenge.serverNonce);
    assert.strictEqual(replay.close.code, 4401);
  });

  it('closes 4426 on a protocol mismatch, naming its own protocol', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const out = await handshake(port, device, { protocol: 2 });
    assert.deepStrictEqual(out.close, { code: 4426, reason: '1' });
  });

  it('closes 4400 for an oversized pre-auth frame and for a silent socket', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const big = rawClient(port);
    await big.opened;
    big.ws.send('x'.repeat(4097));
    assert.strictEqual((await big.closed).code, 4400);
    const silent = rawClient(port);
    await silent.opened;
    const started = Date.now();
    assert.strictEqual((await silent.closed).code, 4400);
    assert.ok(Date.now() - started >= 1900, 'no earlier than the 2 s first-frame deadline');
  });

  it('locks out only the device that failed 5 handshakes', async () => {
    const a = makeDevice('desk a');
    const b = makeDevice('desk b');
    const { port } = await startServer({ devices: [a, b] });
    for (let i = 0; i < 5; i += 1) {
      const out = await handshake(port, a, { tamper: (sig) => `${sig.slice(0, -4)}AAAA` });
      assert.strictEqual(out.close.code, 4401);
    }
    assert.strictEqual((await handshake(port, a, { tamper: (sig) => `${sig.slice(0, -4)}AAAA` })).close.code, 4429);
    const okB = await handshake(port, b);
    assert.ok(okB.ready, 'no global lockout');
    okB.c.ws.close();
  });

  it('evicts the oldest pre-auth socket when a 17th arrives', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const clients = [];
    for (let i = 0; i < 16; i += 1) { const c = rawClient(port); await c.opened; await c.next((f) => f.t === 'challenge'); clients.push(c); }
    const seventeenth = rawClient(port);
    await seventeenth.opened;
    assert.strictEqual((await clients[0].closed).code, 1013);
    assert.strictEqual(clients[1].ws.readyState, WebSocket.OPEN);
    for (const c of [...clients, seventeenth]) c.ws.terminate();
  });

  it('refuses an upgrade with an Origin header (403)', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const c = rawClient(port, { origin: 'https://example.com' });
    await assert.rejects(c.opened, (err) => err.statusCode === 403);
  });

  it('answers a 65 MiB invoke with PAYLOAD_TOO_LARGE and keeps the socket open', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    out.c.ws.send(`{"t":"invoke","id":7,"channel":"chat:load","args":["${'a'.repeat(65 * 1024 * 1024)}"]}`);
    const tooBig = await out.c.next((f) => f.t === 'result' && f.id === 7);
    assert.deepStrictEqual(tooBig, { t: 'result', id: 7, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    out.c.send({ t: 'invoke', id: 8, channel: 'chat:load', args: [] });
    assert.ok((await out.c.next((f) => f.t === 'result' && f.id === 8)).value.ok);
    out.c.ws.close();
  });

  it('second device is refused while the first is live', async () => {
    const first = makeDevice('first desk');
    const second = makeDevice('second desk');
    const { port } = await startServer({ devices: [first, second] });
    const live = await handshake(port, first);
    assert.ok(live.ready);
    const refused = await handshake(port, second);
    assert.deepStrictEqual(refused.close, { code: 4409, reason: 'first desk' });
    live.c.ws.close();
  });

  it('a reconnect from the same device replaces the old connection', async () => {
    const device = makeDevice();
    const { port, dispatcher } = await startServer({ devices: [device] });
    const one = await handshake(port, device);
    const two = await handshake(port, device);
    assert.ok(two.ready);
    assert.strictEqual((await one.c.closed).code, 1000);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    two.c.ws.close();
  });

  it('closes a live connection with 4403 once the device is unpaired', async () => {
    const device = makeDevice();
    const { port, configDir } = await startServer({ devices: [device], limits: { deviceRecheckMs: 50 } });
    const out = await handshake(port, device);
    assert.ok(out.ready);
    writeDevices(configDir, []);
    assert.strictEqual((await out.c.closed).code, 4403);
  });

  it('says bye SERVICE_STOPPING and closes 1001 on stop', async () => {
    const device = makeDevice();
    const { port, server } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    await server.stop();
    assert.deepStrictEqual(await out.c.next((f) => f.t === 'bye'), { t: 'bye', code: 'SERVICE_STOPPING' });
    assert.strictEqual((await out.c.closed).code, 1001);
  });
});

describe('DesktopBridgeServer fix round 1 (review findings)', () => {
  // C1: `String(frame.deviceId)` on an object whose `toString` isn't callable
  // throws synchronously inside the ws 'message' listener, which is
  // uncaught and kills the process. Every pre-auth field is now type-checked
  // before it reaches a regex, and _onMessage runs inside a microtask so any
  // remaining throw becomes a rejected promise instead of a synchronous one.
  it('closes 4400 for object-typed deviceId or clientNonce, and the server stays alive for later clients', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const attempts = [
      { deviceId: { toString: 1 }, clientNonce: newNonce() },
      { deviceId: device.deviceId, clientNonce: { toString: 1 } }
    ];
    for (const bad of attempts) {
      const c = rawClient(port);
      await c.opened;
      await c.next((f) => f.t === 'challenge');
      c.send({ t: 'clientHello', protocol: PROTOCOL, ...bad });
      assert.strictEqual((await c.closed).code, 4400);
    }
    const out = await handshake(port, device);
    assert.ok(out.ready, 'the server survived the malformed attempts and still accepts a real handshake');
    out.c.ws.close();
  });

  // Pins the private ws field the pre-auth byte-budget guard (I2, below)
  // depends on. If a future ws upgrade removes `_socket` from a server-side
  // WebSocket, this fails loudly instead of the budget silently going inert.
  // Built against ws 8.20.0 (see package.json).
  it('ws internals: a server-side WebSocket exposes _socket (pins ws 8.20.x)', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    const gotServerSocket = new Promise((resolve) => wss.once('connection', (ws) => resolve(ws._socket)));
    const port = wss.address().port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    client.on('error', () => {});
    const serverSocket = await gotServerSocket;
    try {
      assert.ok(
        serverSocket && typeof serverSocket.on === 'function' && typeof serverSocket.removeListener === 'function',
        'ws stopped exposing a usable _socket on the server-side WebSocket; update the pre-auth byte-budget guard in bridge-server.js (built for ws 8.20.0)'
      );
    } finally {
      client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  // I2: a pre-auth frame must not be buffered up to the (much larger)
  // post-auth maxPayload before its size is checked. The raw-socket byte
  // counter must cut the connection off while the frame is still arriving.
  it('closes 4400 for a multi-MiB pre-auth frame without waiting to buffer it all', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const c = rawClient(port);
    await c.opened;
    await c.next((f) => f.t === 'challenge');
    const started = Date.now();
    c.ws.send('x'.repeat(6 * 1024 * 1024));
    const close = await c.closed;
    // Round 2: the server terminates immediately once the byte budget trips
    // (no 1 s grace window), so the queued 4400 close frame may not reach
    // the client before the socket is torn down underneath it — an abrupt
    // 1006 is an acceptable client-side outcome. What the socket actually
    // read is pinned precisely in "stops reading immediately..." below.
    assert.ok([4400, 1006].includes(close.code), `expected 4400 or 1006, got ${close.code}`);
    assert.ok(Date.now() - started < 2000, 'closed promptly, not after buffering the whole 6 MiB frame');
  });

  // I3: stop() used to call dispatcher.onDisconnect itself for the live
  // connection, and that connection's socket then firing 'close' called it
  // again through _onClose. _onClose (guarded by conn.cleaned) is now the
  // only call site.
  it('calls onDisconnect exactly once when the connection closes via stop()', async () => {
    const device = makeDevice();
    const { port, server, dispatcher } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    assert.ok(out.ready);
    await server.stop();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
  });

  // I4: a claimed device id is public, not secret, so keying the lockout on
  // it let any local account lock the real owner out by spamming failures
  // for the owner's id. Ed25519 can't be brute-forced, so a handshake that
  // actually carries a valid signature must never be refused by lockout.
  it('a valid signature is never refused by lockout, even after 5 failed attempts for the same claimed id', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    for (let i = 0; i < 5; i += 1) {
      const out = await handshake(port, device, { tamper: (sig) => `${sig.slice(0, -4)}AAAA` });
      assert.strictEqual(out.close.code, 4401);
    }
    assert.strictEqual((await handshake(port, device, { tamper: (sig) => `${sig.slice(0, -4)}AAAA` })).close.code, 4429);
    const ok = await handshake(port, device);
    assert.ok(ok.ready, 'the real device is never refused by a lockout recorded under its own claimed id');
    ok.c.ws.close();
  });

  // M6: a post-auth frame that fails to parse but still carries a peekable
  // id must get an error result, the same as an oversized one, so the
  // caller's pending promise doesn't hang forever.
  it('answers a malformed post-auth frame with a peekable id with a result error', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    out.c.ws.send('{"t":"invoke","id":42,"channel":'); // truncated JSON
    const reply = await out.c.next((f) => f.t === 'result' && f.id === 42);
    assert.deepStrictEqual(reply, { t: 'result', id: 42, error: 'Malformed request', code: 'MALFORMED_REQUEST' });
    out.c.send({ t: 'invoke', id: 43, channel: 'chat:load', args: [] });
    assert.ok((await out.c.next((f) => f.t === 'result' && f.id === 43)).value.ok, 'the connection is still usable afterward');
    out.c.ws.close();
  });

  // M10: an invoke sent before auth completes is rejected the same as any
  // other unexpected pre-auth frame.
  it('closes 4400 for an invoke frame sent before auth', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const c = rawClient(port);
    await c.opened;
    await c.next((f) => f.t === 'challenge');
    c.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    assert.strictEqual((await c.closed).code, 4400);
  });

  // M10: the 10 s (here, shortened) handshake deadline fires even when the
  // client sent a first frame (which resets the first-frame timer) but never
  // completes the handshake.
  it('closes 4400 when the handshake does not complete within handshakeMs', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device], limits: { handshakeMs: 100, firstFrameMs: 10000 } });
    const c = rawClient(port);
    await c.opened;
    await c.next((f) => f.t === 'challenge');
    c.send({ t: 'clientHello', protocol: PROTOCOL, deviceId: device.deviceId, clientNonce: newNonce() });
    await c.next((f) => f.t === 'hello');
    // Never send `auth` — stall mid-handshake past handshakeMs.
    assert.strictEqual((await c.closed).code, 4400);
  });

  // M10: a binary frame before auth is refused like any other malformed
  // pre-auth input.
  it('closes 4400 for a binary pre-auth frame', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const c = rawClient(port);
    await c.opened;
    await c.next((f) => f.t === 'challenge');
    c.ws.send(Buffer.from([1, 2, 3]));
    assert.strictEqual((await c.closed).code, 4400);
  });

  // M10: assertAdminOwned failing (POSIX ownership) must make the device
  // lookup fail closed, the same as an unknown device. Windows has no mode
  // bits to check (assertAdminOwned no-ops there), so this only runs on
  // POSIX, matching the convention in tests/service-config.test.js.
  it('refuses handshakes when assertAdminOwned rejects the devices file (POSIX ownership)', {
    skip: process.platform === 'win32' ? 'POSIX ownership only' : false
  }, async () => {
    const device = makeDevice();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-'));
    dirs.push(configDir);
    writeDevices(configDir, [device]);
    const dispatcher = fakeDispatcher();
    const server = new DesktopBridgeServer({
      identity, configDir, port: 0, version: '26.9.0',
      // The devices file is owned by selfUid; never the "administrator" here.
      adminUid: selfUid + 1,
      createDispatcher: () => dispatcher
    });
    servers.push(server);
    const { port } = await server.start();
    const out = await handshake(port, device);
    assert.strictEqual(out.close.code, 4403, 'assertAdminOwned refused the file, so the device looks unknown');
  });
});

describe('DesktopBridgeServer fix round 2 (review findings)', () => {
  // I2 (still open after round 1): the counter tripped and queued a
  // graceful close, but the socket kept reading — ws fed the receiver up to
  // the (much larger) post-auth maxPayload until the 1 s terminate fallback.
  // The reviewer's probe (scratchpad/i2probe.js) measured 62.9 MB read for a
  // 60 MiB frame. pause()+terminate() must happen immediately, no 1 s window.
  it('stops reading immediately once the pre-auth byte budget trips (bytesRead bounded)', async () => {
    const { server, port } = await startServer({ devices: [makeDevice()] });
    let serverWs = null;
    server.wss.on('connection', (ws) => { serverWs = ws; });
    const c = rawClient(port);
    await c.opened;
    await c.next((f) => f.t === 'challenge');
    c.ws.send('x'.repeat(60 * 1024 * 1024));
    await c.closed;
    // Let any already-in-flight read settle before taking the final count.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(serverWs && serverWs._socket, 'captured the server-side socket via the connection event');
    const budget = server.limits.preAuthSocketBytes + 64 * 1024;
    assert.ok(
      serverWs._socket.bytesRead <= budget,
      `expected bytesRead <= ${budget} (budget + 64 KiB slack), got ${serverWs._socket.bytesRead}`
    );
  });

  // New: the C1 backstop closed 4400 on *every* rejection, including a
  // post-auth error from dispatcher.handleFrame or _send — killing the
  // owner's authenticated connection and aborting its in-flight runs. It
  // must only close pre-auth; post-auth it answers a result error (when the
  // frame id is peekable) and leaves the connection open.
  it('answers a result error and keeps the connection open when the dispatcher throws after auth', async () => {
    const device = makeDevice();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-'));
    dirs.push(configDir);
    writeDevices(configDir, [device]);
    const dispatcher = {
      served: { handle: ['chat:load'], on: [] },
      providersConfigured: () => true,
      async handleFrame(conn, frame) {
        if (frame.id === 99) throw new Error('boom');
        conn.send({ t: 'result', id: frame.id, value: { ok: true } });
      },
      onDisconnect() {},
      forwardAmbient() {}
    };
    const server = new DesktopBridgeServer({
      identity, configDir, port: 0, version: '26.9.0', adminUid: selfUid, createDispatcher: () => dispatcher
    });
    servers.push(server);
    const { port } = await server.start();
    const out = await handshake(port, device);
    assert.ok(out.ready);
    out.c.send({ t: 'invoke', id: 99, channel: 'chat:load', args: [] });
    const errResult = await out.c.next((f) => f.t === 'result' && f.id === 99);
    assert.deepStrictEqual(errResult, { t: 'result', id: 99, error: 'Internal error', code: 'INTERNAL_ERROR' });
    // The connection itself must still be usable afterward.
    out.c.send({ t: 'invoke', id: 100, channel: 'chat:load', args: [] });
    const ok = await out.c.next((f) => f.t === 'result' && f.id === 100);
    assert.deepStrictEqual(ok.value, { ok: true });
    out.c.ws.close();
  });
});

const { DesktopBridgeClient } = require('../src/desktop-bridge/bridge-client');

function clientFor(port, device, extra = {}) {
  return new DesktopBridgeClient({
    port,
    pin: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex') },
    deviceId: device.deviceId,
    sign: async (bytes) => crypto.sign(null, bytes, device.privateKey),
    ...extra
  });
}

// A fake service that sends a challenge for the pinned node and a garbage hello.
async function impostorServer({ nodeId = identity.nodeId } = {}) {
  const frames = [];
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'challenge', protocol: 1, nodeId, serverNonce: newNonce() }));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      frames.push(frame.t);
      if (frame.t === 'clientHello') ws.send(JSON.stringify({ t: 'hello', sig: keys.toB64url(crypto.randomBytes(64)) }));
    });
  });
  return { frames, port: wss.address().port, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

// A fake service that performs a genuine, valid mutual handshake up through
// its own proof (a real `hello.sig` over the real identity), then closes
// with an arbitrary code/reason either right after `clientHello` (for codes
// the real server sends before ever proving itself: MALFORMED,
// PROTOCOL_MISMATCH, UNKNOWN_DEVICE) or right after `auth` (for codes the
// real server only reaches once a signature has been checked: BAD_SIGNATURE,
// OTHER_DEVICE, LOCKED_OUT). This isolates the client's own close-code
// mapping (`errorForClose`) from the server's pairing/lockout state — which
// is already covered by tests/desktop-bridge-protocol.test.js's server suite
// — the same way `impostorServer` isolates the "never trust an unproven
// service" behavior above.
async function closingServer({ after = 'clientHello', code, reason = '' } = {}) {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => {
    const serverNonce = newNonce();
    ws.send(JSON.stringify({ t: 'challenge', protocol: 1, nodeId: identity.nodeId, serverNonce }));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      if (frame.t === 'clientHello') {
        if (after === 'clientHello') { ws.close(code, reason); return; }
        const fields = { nodeId: identity.nodeId, deviceId: frame.deviceId, port: wss.address().port, serverNonce, clientNonce: frame.clientNonce };
        const sig = identity.sign(Buffer.from(buildAuthS(fields), 'utf8'));
        ws.send(JSON.stringify({ t: 'hello', sig: keys.toB64url(Buffer.from(sig)) }));
      } else if (frame.t === 'auth' && after === 'auth') {
        ws.close(code, reason);
      }
    });
  });
  return { port: wss.address().port, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

// Task 7 carryover: stop() used to close the socket and return without ever
// waiting for the dispatcher's cleanup (aborting that connection's runs,
// denying its prompts) to actually finish — a caller that immediately exited
// the process after `await server.stop()`, or that reused the port, could
// race that cleanup. onDisconnect's promise now settles only once cleanup is
// done, and stop() awaits it, bounded so a wedged handler cannot hang
// shutdown forever.
describe('DesktopBridgeServer fix round 3 (task 7 carryover)', () => {
  it('stop() waits for the dispatcher\'s onDisconnect cleanup to finish before resolving', async () => {
    const device = makeDevice();
    const dispatcher = fakeDispatcher({ disconnectDelayMs: 50 });
    const { port, server } = await startServer({ devices: [device], dispatcher });
    const out = await handshake(port, device);
    assert.ok(out.ready);
    assert.deepStrictEqual(dispatcher.disconnects, [], 'cleanup has not started yet');
    await server.stop();
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId], 'cleanup finished before stop() resolved');
  });

  it('stop() does not hang forever when onDisconnect never settles, bounded by disconnectCleanupMs', async () => {
    const device = makeDevice();
    const dispatcher = fakeDispatcher({ hangDisconnect: true });
    const { port, server } = await startServer({ devices: [device], dispatcher, limits: { disconnectCleanupMs: 50 } });
    const out = await handshake(port, device);
    assert.ok(out.ready);
    const started = Date.now();
    await server.stop();
    assert.ok(Date.now() - started < 2000, 'stop() returned promptly instead of waiting on a wedged onDisconnect');
  });
});

describe('DesktopBridgeClient', () => {
  it('connects, invokes and receives events', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const client = clientFor(port, device);
    const service = await client.connect();
    assert.strictEqual(service.nodeId, identity.nodeId);
    assert.strictEqual(client.connected, true);
    assert.deepStrictEqual(await client.invoke('chat:load', []), { ok: true, data: { echo: [] } });
    client.close();
    assert.strictEqual(client.status, 'stopped');
  });

  it('never sends auth when hello.sig does not verify', async () => {
    const fake = await impostorServer();
    const client = clientFor(fake.port, makeDevice());
    await assert.rejects(client.connect(), (err) => err.code === 'SERVICE_KEY_CHANGED');
    assert.deepStrictEqual(fake.frames, ['clientHello'], 'no auth frame, so no device signature leaves');
    assert.strictEqual(client.status, 'failed');
    client.close();
    await fake.close();
  });

  it('closes before saying anything when the challenge names another node', async () => {
    const fake = await impostorServer({ nodeId: 'kl-aaaaaaaaaaaaaaaa' });
    const client = clientFor(fake.port, makeDevice());
    await assert.rejects(client.connect(), (err) => err.code === 'SERVICE_KEY_CHANGED' && /changed from kl-/.test(err.message));
    assert.deepStrictEqual(fake.frames, []);
    client.close();
    await fake.close();
  });

  it('client ignores HTTP_PROXY', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY };
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.ALL_PROXY = 'http://127.0.0.1:9';
    try {
      const client = clientFor(port, device);
      assert.strictEqual((await client.connect()).nodeId, identity.nodeId);
      client.close();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    assert.throws(() => new DesktopBridgeClient({ host: 'localhost', port, pin: { nodeId: identity.nodeId, publicKey: 'aa' }, deviceId: device.deviceId, sign: () => {} }), /127\.0\.0\.1/);
  });

  it('times out ordinary calls but not chat:sendMessage', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const client = clientFor(port, device, { defaultTimeoutMs: 50 });
    await client.connect();
    // The fake dispatcher answers chat:sendMessage after 200 ms, well past the 50 ms default.
    assert.deepStrictEqual(await client.invoke('chat:sendMessage', [{ chatId: 'c1' }]), { ok: true, data: { echo: [{ chatId: 'c1' }] } });
    const slow = await startServer({ devices: [device] });
    slow.dispatcher.handleFrame = async (conn, frame) => { await new Promise((r) => setTimeout(r, 200)); conn.send({ t: 'result', id: frame.id, value: 'late' }); };
    const client2 = clientFor(slow.port, device, { defaultTimeoutMs: 50 });
    await client2.connect();
    await assert.rejects(client2.invoke('chat:load', []), (err) => err.code === 'BRIDGE_TIMEOUT' && err.message === 'The local service did not answer in time.');
    assert.strictEqual(await client2.invoke('chat:sendMessage', [{ chatId: 'c1' }]), 'late');
    client.close();
    client2.close();
  });

  it('rejects pending calls on disconnect and reconnects to a restarted service', async () => {
    const device = makeDevice();
    const first = await startServer({ devices: [device] });
    let currentPort = first.port;
    const client = clientFor(first.port, device, { backoffMs: [20], getPort: async () => currentPort });
    await client.connect();
    const states = [];
    client.on('state', (s) => states.push(s.status));
    first.dispatcher.handleFrame = async () => {};
    const pending = client.invoke('chat:load', []);
    await first.server.stop();
    await assert.rejects(pending, (err) => err.code === 'SERVICE_UNREACHABLE');
    const second = await startServer({ devices: [device] });
    currentPort = second.port;
    await new Promise((resolve) => { const check = () => (client.connected ? resolve() : setTimeout(check, 10)); check(); });
    assert.ok(states.includes('disconnected'));
    assert.strictEqual(client.port, second.port, 'the port is re-read before every reconnect');
    client.close();
  });

  it('stops retrying once the device is unpaired (4403)', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [] });
    const client = clientFor(port, device, { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'DEVICE_UNPAIRED'
      && err.message === 'The service does not know this desktop. Pair again in Settings > Local service.');
    assert.strictEqual(client.status, 'failed');
    assert.strictEqual(client.nextRetryAt, null);
    client.close();
  });
});

describe('DesktopBridgeClient fix round 1 (review findings)', () => {
  it('rejects a pin whose publicKey does not derive its own nodeId', () => {
    const device = makeDevice();
    assert.throws(() => new DesktopBridgeClient({
      port: 1,
      pin: { nodeId: 'kl-aaaaaaaaaaaaaaaa', publicKey: identity.publicKey.toString('hex') },
      deviceId: device.deviceId,
      sign: async (bytes) => crypto.sign(null, bytes, device.privateKey)
    }), /pin is internally inconsistent/);
  });

  it('close() during a handshake cancels it instead of letting it revive into connected', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const client = clientFor(port, device);
    const states = [];
    client.on('state', (s) => states.push(s.status));
    const pending = client.connect();
    // No await between connect() and close(): the socket exists (this.ws is
    // set as soon as _handshake creates it) but the real network round trip
    // for the challenge/hello/auth/ready exchange cannot have happened yet.
    const inFlightWs = client.ws;
    assert.ok(inFlightWs, 'the socket is stored before the handshake completes');
    client.close();
    await assert.rejects(pending, () => true);
    assert.strictEqual(client.status, 'stopped');
    assert.strictEqual(client.ws, null);
    // Give the real handshake — which was never cancelled on the wire, only
    // locally — however long it needs to actually finish, so a lingering
    // bug (this.stopped not checked on 'ready') would show up as a late
    // 'connected' state event rather than the test just not having waited.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(client.status, 'stopped', 'must not have revived into connected');
    assert.ok(!states.includes('connected'), 'no connected state event ever fires');
    assert.strictEqual(inFlightWs.readyState, WebSocket.CLOSED, 'no socket stays open');
  });

  it('maps 4400 (malformed) to a non-fatal MALFORMED error', async () => {
    const fake = await closingServer({ after: 'clientHello', code: 4400, reason: 'bad frame' });
    const client = clientFor(fake.port, makeDevice(), { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'MALFORMED');
    assert.strictEqual(client.status, 'disconnected');
    assert.ok(client.nextRetryAt !== null, 'not fatal — a retry is scheduled');
    client.close();
    await fake.close();
  });

  it('maps 4401 (bad signature) to a non-fatal BAD_SIGNATURE error', async () => {
    const fake = await closingServer({ after: 'auth', code: 4401, reason: 'signature invalid' });
    const client = clientFor(fake.port, makeDevice(), { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'BAD_SIGNATURE');
    assert.strictEqual(client.status, 'disconnected');
    assert.ok(client.nextRetryAt !== null, 'not fatal — a retry is scheduled');
    client.close();
    await fake.close();
  });

  it('maps 4409 (another device) to a fatal ANOTHER_DEVICE error carrying the label', async () => {
    const fake = await closingServer({ after: 'auth', code: 4409, reason: 'gpu-box desk' });
    const client = clientFor(fake.port, makeDevice(), { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'ANOTHER_DEVICE' && /gpu-box desk/.test(err.message));
    assert.strictEqual(client.status, 'failed');
    assert.strictEqual(client.nextRetryAt, null, 'fatal — no retry until retryNow()');
    client.close();
    await fake.close();
  });

  it('maps 4426 (protocol mismatch) to a fatal PROTOCOL_MISMATCH error', async () => {
    const fake = await closingServer({ after: 'clientHello', code: 4426, reason: '2' });
    const client = clientFor(fake.port, makeDevice(), { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'PROTOCOL_MISMATCH');
    assert.strictEqual(client.status, 'failed');
    assert.strictEqual(client.nextRetryAt, null, 'fatal — no retry until retryNow()');
    client.close();
    await fake.close();
  });

  it('maps 4429 (locked out) to a non-fatal LOCKED_OUT error — retryable, not held', async () => {
    const fake = await closingServer({ after: 'auth', code: 4429, reason: 'too many failed handshakes' });
    const client = clientFor(fake.port, makeDevice(), { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'LOCKED_OUT');
    assert.strictEqual(client.status, 'disconnected', 'not fatal, unlike DEVICE_UNPAIRED/ANOTHER_DEVICE/PROTOCOL_MISMATCH/SERVICE_KEY_CHANGED');
    assert.ok(client.nextRetryAt !== null, 'a retry is scheduled on the normal backoff schedule — this client always signs correctly, so the lockout does not apply to its own retries');
    client.close();
    await fake.close();
  });

  it('send() returns false before connecting and delivers a one-way frame once connected', async () => {
    const device = makeDevice();
    const { port, dispatcher } = await startServer({ devices: [device] });
    const client = clientFor(port, device);
    assert.strictEqual(client.send('chat:updated', [{ id: 1 }]), false);
    await client.connect();
    assert.strictEqual(client.send('chat:updated', [{ id: 1 }]), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sent = dispatcher.frames.find((f) => f.t === 'send' && f.channel === 'chat:updated');
    assert.ok(sent, 'the dispatcher received the send frame');
    assert.deepStrictEqual(sent.args, [{ id: 1 }]);
    client.close();
  });

  it('call() sends a call frame and resolves with the reply value', async () => {
    const device = makeDevice();
    const { port, dispatcher } = await startServer({ devices: [device] });
    dispatcher.handleFrame = async (conn, frame) => {
      dispatcher.frames.push(frame);
      if (frame.t === 'call') conn.send({ t: 'result', id: frame.id, value: { method: frame.method, params: frame.params } });
    };
    const client = clientFor(port, device);
    await client.connect();
    const result = await client.call('ping', { a: 1 });
    assert.deepStrictEqual(result, { method: 'ping', params: { a: 1 } });
    client.close();
  });
});
