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

function fakeDispatcher() {
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
    onDisconnect(conn) { this.disconnects.push(conn.deviceId); },
    forwardAmbient() {}
  };
}

async function startServer({ devices = [], limits = {} } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-'));
  dirs.push(configDir);
  writeDevices(configDir, devices);
  const dispatcher = fakeDispatcher();
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
    assert.strictEqual((await handshake(port, a)).close.code, 4429);
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
