// tests/desktop-bridge-sealed-attach.test.js
// Remote window plan, task 5 (R-RW-15, R-RW-30, R-RW-31, Review Focus 5): the bridge
// server takes a sealed connection, in-process, beside the loopback listener and
// with no new socket.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { WindowSeal, RECORD_WIRE_MAX, PING_MS, SILENCE_MS, HANDSHAKE_TIMEOUT, SOCKET_OPTIONS } = require('../src/desktop-bridge/window-seal');
const { wsTransport } = require('../src/desktop-bridge/sealed-socket');
const { currentConnection } = require('../src/desktop-bridge/run-context');
const { buildAuthC, newNonce, PROTOCOL, LIMITS, CLOSE, MESSAGES } = require('../src/desktop-bridge/protocol');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { isLocalDesktopEvent, isRemoteWindowEvent, remoteWindowDeviceId, remoteWindowApproved } = require('../src/core/origin');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { open } = require('../src/approvals/envelope');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { sessionIdOf, createTransportPair } = require('./helpers/window-seal-fixture');

const MIB = 1024 * 1024;
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const identity = new NodeIdentity({ nodeName: 'web-01' });
const nodeRaw = Buffer.from(identity.publicKey, 'hex').subarray(-32);
const CAN_SEAL = Object.freeze({ canSeal: () => true });
const dirs = [];
const servers = [];
let nextSession = 0;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const waitFor = async (fn, what = 'a condition', ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(2);
  }
  throw new Error(`timed out waiting for ${what}`);
};

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeDevice(label, { remote = true } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), raw, label, privateKey, remote };
}

function writeDevices(configDir, devices) {
  let doc = pairing.emptyDevices();
  for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-11-04T10:00:00Z', remote: d.remote });
  pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
}

function fakeDispatcher() {
  return {
    served: { handle: ['chat:load'], on: [] },
    disconnects: [],
    frames: [],
    revoked: [],
    hold: null,
    providersConfigured: () => true,
    async handleFrame(conn, frame) {
      this.frames.push({ conn, frame });
      if (this.hold) await this.hold(conn, frame);
    },
    async onDisconnect(conn) {
      if (conn.cleaned) return;
      conn.cleaned = true;
      this.disconnects.push(conn.deviceId);
    },
    onRevoke(conn) { this.revoked.push(conn.deviceId); },
    forwardAmbient() {}
  };
}

// No start(): a node with only features.remoteWindow has no listener at all (Task 6).
function makeServer({ devices = [], approvals = { sealPolicy: CAN_SEAL }, limits = {}, createDispatcher = null, ...rest } = {}) {
  const configDir = tempDir('kl-sealed-');
  writeDevices(configDir, devices);
  const dispatcher = createDispatcher ? null : fakeDispatcher();
  const server = new DesktopBridgeServer({
    identity, configDir, port: 0, version: '26.11.0', adminUid: selfUid, account: 'LOCAL SERVICE', approvals, limits,
    createDispatcher: createDispatcher || (() => dispatcher),
    ...rest
  });
  servers.push(server);
  return { server, dispatcher, configDir };
}

// A window at the far end of a transport pair: every frame it opened, how it closed.
function openWindow(server, device, { transportPair = createTransportPair(), sessionId = sessionIdOf(`attach ${++nextSession}`) } = {}) {
  const [nodeEnd, windowEnd] = transportPair;
  let held = null;
  const received = [];
  const window = { received, windowEnd, nodeEnd, sealClose: null, wireClose: null };
  const seal = WindowSeal.window({
    sessionId,
    deviceId: device.deviceId,
    publicKey: device.raw,
    sign: (bytes) => crypto.sign(null, bytes, device.privateKey),
    pin: nodeRaw,
    write: (bytes) => {
      if (!held) return windowEnd.send(bytes);
      held.push(bytes);
      return Promise.resolve();
    },
    onClose: (close) => { window.sealClose = close; }
  });
  window.seal = seal;
  windowEnd.on('data', async (bytes) => {
    const result = await seal.next(bytes);
    for (const frame of result.frames) received.push(JSON.parse(frame.toString('utf8')));
    if (result.close) window.sealClose = result.close;
  });
  windowEnd.on('close', (code, reason) => { window.wireClose = { code, reason }; });
  window.sendBytes = (text) => { for (const step of seal.records(Buffer.from(text))) assert.ok(step); };
  window.send = (obj) => window.sendBytes(JSON.stringify(obj));
  // A frame's records as the seal made them, kept back from the wire.
  window.sealOnly = (text) => {
    held = [];
    window.sendBytes(text);
    const records = held;
    held = null;
    return records;
  };
  window.attached = server.attachSealed({ sessionId, transport: nodeEnd });
  window.outcome = window.attached.then((conn) => ({ conn }), (error) => ({ error }));
  seal.next(null);
  return window;
}

async function attached(server, device, options) {
  const window = openWindow(server, device, options);
  const { conn, error } = await window.outcome;
  if (error) throw error;
  await waitFor(() => window.received.some((f) => f.t === 'ready'), 'the ready frame');
  return { window, conn };
}

// A socket that takes bytes and never says it has written them, until told.
function slowTransport() {
  const end = new EventEmitter();
  end.sent = [];
  end.pending = [];
  end.closed = null;
  end.send = (bytes) => new Promise((resolve, reject) => {
    end.sent.push(bytes);
    end.pending.push((err) => (err ? reject(err) : resolve()));
  });
  end.close = (code, reason) => { end.closed = { code, reason }; };
  end.bytes = () => end.sent.reduce((n, b) => n + b.length, 0);
  end.flushAll = () => { for (const settle of end.pending.splice(0)) settle(); };
  return end;
}

// Runs the handshake by hand against a transport that does not deliver.
async function handshakeOn(server, transport, device) {
  const sessionId = sessionIdOf(`slow ${++nextSession}`);
  const seal = WindowSeal.window({
    sessionId,
    deviceId: device.deviceId,
    publicKey: device.raw,
    sign: (bytes) => crypto.sign(null, bytes, device.privateKey),
    pin: nodeRaw,
    write: async (bytes) => { transport.emit('data', bytes, true); },
    onClose: () => {}
  });
  const attaching = server.attachSealed({ sessionId, transport });
  await seal.next(null);
  await waitFor(() => transport.sent.length === 1, 'hello_n');
  await seal.next(transport.sent[0]);
  const conn = await attaching;
  return { seal, conn };
}

// The loopback handshake, as a local window speaks it.
async function loopbackAttach(port, device) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received = [];
  ws.on('message', (data, isBinary) => received.push({ isBinary, frame: JSON.parse(data.toString('utf8')) }));
  ws.on('error', () => {});
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
  const send = (obj) => ws.send(JSON.stringify(obj));
  const first = (t) => received.find((r) => r.frame.t === t);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const challenge = (await waitFor(() => first('challenge'), 'the challenge')).frame;
  const clientNonce = newNonce();
  send({ t: 'clientHello', protocol: PROTOCOL, deviceId: device.deviceId, clientNonce });
  const hello = await Promise.race([closed.then((close) => ({ close })), waitFor(() => first('hello'), 'the hello').then(() => ({}))]);
  if (hello.close) return { ws, close: hello.close, received, closed };
  const fields = { nodeId: identity.nodeId, deviceId: device.deviceId, port, serverNonce: challenge.serverNonce, clientNonce };
  send({ t: 'auth', sig: keys.toB64url(crypto.sign(null, Buffer.from(buildAuthC(fields)), device.privateKey)) });
  const outcome = await Promise.race([closed.then((close) => ({ close })), waitFor(() => first('ready'), 'ready').then((ready) => ({ ready }))]);
  return { ws, received, closed, ...outcome };
}

// The real dispatcher over stub handlers: what a remote frame's event is, and what
// the phone gate does when the device is revoked.
function realDispatcher({ overrides = {}, phone, listChannels, patchContext = null, extra = {}, contextExtra = {} } = {}) {
  const dataDir = tempDir('kl-sealed-data-');
  const context = { getSettings: () => ({}), setSettings() {}, getActiveChatId: () => null, setActiveChatId() {}, appendMessageToChat: (...args) => { context.rows.push(args); }, getApiTokens: () => ({}), rows: [], ...contextExtra };
  const seen = {};
  const createDispatcher = (opts) => {
    seen.dispatcher = createBridgeDispatcher({
      ...opts,
      core: { context },
      dataDir,
      getConnection: () => currentConnection(),
      ...extra,
      listChannels: listChannels || (() => ({ handle: Object.keys(overrides), on: [] })),
      registerHandlers: (ipc, ctx) => {
        for (const [channel, fn] of Object.entries(overrides)) ipc.handle(channel, fn);
        if (patchContext) patchContext(ctx);
      }
    });
    return seen.dispatcher;
  };
  return { createDispatcher, context, seen, approvals: { sealPolicy: CAN_SEAL, phoneApprover: phone } };
}

function fakePhone(decide) {
  const calls = [];
  return {
    ttlMs: 300000,
    calls,
    isAvailable: () => true,
    requestApproval: async (toolName, parameters, metadata) => {
      calls.push({ toolName, parameters, metadata });
      const answer = await decide(toolName, parameters, metadata);
      if (answer === true) metadata.request_id = `req-${calls.length}`;
      return answer;
    }
  };
}

after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('the device record says which path it may use (R-RW-15)', () => {
  it('parseDevices takes an optional boolean remote, and refuses anything else', () => {
    const device = makeDevice('Field laptop');
    const record = { deviceId: device.deviceId, publicKey: device.publicKey, label: device.label, pairedAt: '2026-11-04T10:00:00Z' };
    const parse = (extra) => pairing.parseDevices(JSON.stringify({ v: 1, devices: [{ ...record, ...extra }] }));
    assert.strictEqual(parse({ remote: true }).devices[0].remote, true);
    assert.strictEqual(parse({ remote: false }).devices[0].remote, false);
    assert.strictEqual(parse({}).devices[0].remote, undefined);
    for (const bad of ['true', 1, null, {}]) {
      assert.throws(() => parse({ remote: bad }), (err) => err.code === 'DEVICES_FILE_INVALID');
    }
  });

  it('upsertDevice writes remote only for a remote record, so a local record\'s bytes are as they were; findDevice returns it', () => {
    const local = makeDevice('Desk', { remote: false });
    const remote = makeDevice('Field laptop');
    const pairedAt = '2026-11-04T10:00:00Z';
    let doc = pairing.upsertDevice(pairing.emptyDevices(), { deviceId: local.deviceId, publicKey: local.publicKey, label: local.label, pairedAt });
    assert.deepStrictEqual(Object.keys(doc.devices[0]), ['deviceId', 'publicKey', 'label', 'pairedAt']);
    doc = pairing.upsertDevice(doc, { deviceId: remote.deviceId, publicKey: remote.publicKey, label: remote.label, pairedAt, remote: true });
    assert.strictEqual(pairing.findDevice(doc, remote.deviceId).remote, true);
    assert.strictEqual('remote' in pairing.findDevice(doc, local.deviceId), false);
    assert.strictEqual(CLOSE.NOT_REMOTE, 4403);
    assert.strictEqual(CLOSE.NOT_SEALING, 4503);
    assert.strictEqual(CLOSE.RECORD_UNREADABLE, 4504);
  });

  it('a remote record on the loopback listener is 4403, by hello and by the re-read at auth', async () => {
    const remote = makeDevice('Field laptop');
    const local = makeDevice('Desk', { remote: false });
    const { server, configDir } = makeServer({ devices: [remote, local] });
    const { port } = await server.start();
    const refused = await loopbackAttach(port, remote);
    assert.deepStrictEqual(refused.close, { code: 4403, reason: 'unknown device' });
    assert.strictEqual(server.connected.length, 0);

    const lookups = server._lookupDevice.bind(server);
    let calls = 0;
    server._lookupDevice = (id) => {
      calls += 1;
      if (calls === 2) writeDevices(configDir, [{ ...local, remote: true }, remote]);
      return lookups(id);
    };
    const flipped = await loopbackAttach(port, local);
    assert.deepStrictEqual(flipped.close, { code: 4403, reason: 'unknown device' });
  });

  it('a local pairing\'s key on the sealed path is 4403 not_remote: told under the seal, after it proved the key', async () => {
    const local = makeDevice('Desk', { remote: false });
    const { server, dispatcher } = makeServer({ devices: [local] });
    const window = openWindow(server, local);
    const { error } = await window.outcome;
    assert.strictEqual(error.code, 'not_remote');
    assert.strictEqual(error.closeCode, 4403);
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4403, reason: 'not_remote' });
    assert.deepStrictEqual(window.sealClose, { code: 4403, reason: 'peer' });
    assert.deepStrictEqual(window.received, []);
    assert.strictEqual(server.connected.length, 0);
    assert.deepStrictEqual(dispatcher.frames, []);
  });

  it('an unknown device gets the seal\'s one code', async () => {
    const stranger = makeDevice('Stranger');
    const { server } = makeServer({ devices: [] });
    const window = openWindow(server, stranger);
    const { error } = await window.outcome;
    assert.strictEqual(error.closeCode, 4401);
    await waitFor(() => window.wireClose, 'the close');
    assert.strictEqual(window.wireClose.code, 4401);
    assert.strictEqual(window.wireClose.reason, 'handshake');
    assert.deepStrictEqual(window.received, []);
  });

  it('a record that lost remote while its session is live closes the session, and one that gained it closes the local one', async () => {
    const remote = makeDevice('Field laptop');
    const local = makeDevice('Desk', { remote: false });
    const { server, configDir, dispatcher } = makeServer({ devices: [remote, local] });
    const { port } = await server.start();
    const { window, conn } = await attached(server, remote);
    const loop = await loopbackAttach(port, local);
    assert.ok(loop.ready);

    writeDevices(configDir, [{ ...remote, remote: false }, { ...local, remote: true }]);
    server._recheckLive();
    await waitFor(() => window.wireClose, 'the sealed close');
    assert.deepStrictEqual(window.wireClose, { code: 4403, reason: 'unpaired' });
    assert.strictEqual(conn.revoked, true);
    assert.deepStrictEqual(await loop.closed, { code: 4403, reason: 'unpaired' });
    assert.deepStrictEqual(dispatcher.revoked, [remote.deviceId], 'only a remote connection is revoked');
  });
});

describe('a sealed connection', () => {
  it('attaches, says ready with the service, and hands its frames to the dispatcher', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device] });
    const connected = [];
    server.on('connected', (c) => connected.push(c));
    const { window, conn } = await attached(server, device);
    assert.strictEqual(conn.remote, true);
    assert.strictEqual(conn.deviceId, device.deviceId);
    assert.strictEqual(conn.label, 'Field laptop');
    assert.deepStrictEqual(connected, [{ deviceId: device.deviceId, label: 'Field laptop', remote: true }]);
    assert.deepStrictEqual(server.connected, [{ deviceId: device.deviceId, label: 'Field laptop', remote: true }]);
    const ready = window.received.find((f) => f.t === 'ready');
    assert.strictEqual(ready.service.nodeId, identity.nodeId);

    window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');
    assert.strictEqual(dispatcher.frames[0].conn, conn);
    assert.deepStrictEqual(dispatcher.frames[0].frame, { t: 'invoke', id: 1, channel: 'chat:load', args: [] });

    conn.send({ t: 'event', channel: 'chat:updated', payload: { chatId: 'c-1' } });
    await waitFor(() => window.received.some((f) => f.t === 'event'), 'the event');
  });

  it('records go out in the order they were sealed, big frames in pieces', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const { window, conn } = await attached(server, device);
    const big = 'x'.repeat(3 * MIB);
    conn.send({ t: 'event', channel: 'a', payload: big });
    conn.send({ t: 'event', channel: 'b', payload: 'small' });
    await waitFor(() => window.received.filter((f) => f.t === 'event').length === 2, 'both frames');
    assert.deepStrictEqual(window.received.filter((f) => f.t === 'event').map((f) => f.channel), ['a', 'b']);
    assert.strictEqual(window.sealClose, null);
  });

  it('takes the same parseFrame and size checks as the loopback path', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device], limits: { frameBytes: 2000 } });
    const { window } = await attached(server, device);
    window.send({ t: 'invoke', id: 7, channel: 'chat:load', args: ['y'.repeat(3000)] });
    await waitFor(() => window.received.some((f) => f.id === 7), 'the too-large answer');
    assert.deepStrictEqual(window.received.find((f) => f.id === 7), { t: 'result', id: 7, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    window.sendBytes('{"t":"invoke","id":8,');
    await waitFor(() => window.received.some((f) => f.id === 8), 'the malformed answer');
    assert.strictEqual(window.received.find((f) => f.id === 8).code, 'MALFORMED_REQUEST');
    assert.deepStrictEqual(dispatcher.frames, []);
  });

  it('an outgoing frame over the limit is dropped, and a result is answered with the refusal', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device], limits: { frameBytes: 2000 } });
    const { window, conn } = await attached(server, device);
    assert.strictEqual(conn.send({ t: 'event', channel: 'a', payload: 'z'.repeat(3000) }), false);
    conn.send({ t: 'result', id: 3, value: 'z'.repeat(3000) });
    await waitFor(() => window.received.some((f) => f.id === 3), 'the refusal');
    assert.strictEqual(window.received.find((f) => f.id === 3).code, 'PAYLOAD_TOO_LARGE');
    assert.deepStrictEqual(window.received.filter((f) => f.t === 'event'), []);
  });

  it('a tampered record closes 4400 and the connection is cleaned up as a remote drop', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device] });
    const disconnected = [];
    server.on('disconnected', (c) => disconnected.push(c));
    const { window, conn } = await attached(server, device);
    const [record] = window.sealOnly('{"t":"send","channel":"x"}');
    record[record.length - 1] ^= 1;
    window.windowEnd.send(record);
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4400, reason: 'record' });
    assert.strictEqual(conn.live, false);
    assert.strictEqual(conn.revoked, false, 'a drop is not a revoke');
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    assert.deepStrictEqual(dispatcher.revoked, []);
    assert.deepStrictEqual(dispatcher.frames, []);
    assert.deepStrictEqual(disconnected, [{ deviceId: device.deviceId, label: 'Field laptop', remote: true }]);
    assert.strictEqual(server.connected.length, 0);
    assert.strictEqual(conn.send({ t: 'event', channel: 'a' }), false);
  });

  it('the socket closing is a drop, whatever code it names: a socket code proves nothing', async () => {
    const device = makeDevice('Field laptop');
    for (const [code, reason] of [[1006, 'gone'], [4403, 'unpaired'], [4401, 'handshake']]) {
      const { server, dispatcher } = makeServer({ devices: [device] });
      const { window, conn } = await attached(server, device);
      window.windowEnd.close(code, reason);
      await waitFor(() => dispatcher.disconnects.length === 1, 'the cleanup');
      assert.strictEqual(conn.live, false);
      assert.strictEqual(conn.revoked, false);
      assert.deepStrictEqual(dispatcher.revoked, []);
      assert.strictEqual(server.connected.length, 0);
    }
  });

  it('a text frame is refused: 4401 before ready, 4400 after', async () => {
    const device = makeDevice('Field laptop');
    const early = makeServer({ devices: [device] });
    const end = slowTransport();
    const sessionId = sessionIdOf('text early');
    const attaching = early.server.attachSealed({ sessionId, transport: end });
    let helloW = null;
    const hello = WindowSeal.window({
      sessionId, deviceId: device.deviceId, publicKey: device.raw, sign: (bytes) => crypto.sign(null, bytes, device.privateKey), pin: nodeRaw,
      write: async (bytes) => { helloW = bytes; }, onClose: () => {}
    });
    await hello.next(null);
    hello.destroy();
    end.emit('data', helloW, false);
    await assert.rejects(attaching, (err) => err.closeCode === 4401);
    assert.deepStrictEqual(end.closed, { code: 4401, reason: 'handshake' });
    assert.deepStrictEqual(end.sent, []);

    const late = makeServer({ devices: [device] });
    const { window, conn } = await attached(late.server, device);
    const [record] = window.sealOnly('{"t":"invoke","id":1,"channel":"chat:load","args":[]}');
    window.nodeEnd.emit('data', record, false);
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4400, reason: 'record' });
    assert.strictEqual(conn.live, false);
    await delay(5);
    assert.deepStrictEqual(late.dispatcher.frames, [], 'a good record in a text frame is not read');
  });

  it('bytes before ready are cut at the limit, as they arrive', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const end = slowTransport();
    let terminated = 0;
    end.terminate = () => { terminated += 1; };
    const attaching = server.attachSealed({ sessionId: sessionIdOf('flood'), transport: end });
    end.emit('raw', Buffer.alloc(LIMITS.preAuthSocketBytes));
    assert.strictEqual(end.closed, null);
    end.emit('raw', Buffer.alloc(1));
    await assert.rejects(attaching, (err) => err.closeCode === 4401);
    assert.deepStrictEqual(end.closed, { code: 4401, reason: 'handshake' });
    assert.strictEqual(terminated, 1);
    assert.deepStrictEqual(end.sent, []);
  });

  it('bytes before ready are counted once: raw when the transport has it, messages when not', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const end = slowTransport();
    const attaching = server.attachSealed({ sessionId: sessionIdOf('counted once'), transport: end });
    const [state] = [...server.sealedSessions];
    end.emit('raw', Buffer.alloc(100));
    assert.strictEqual(state.preReadyBytes, 100);
    end.emit('data', Buffer.alloc(100), true);
    assert.strictEqual(state.preReadyBytes, 100, 'the same bytes are not counted again');
    await attaching.catch(() => {});

    const bare = makeServer({ devices: [device] });
    const plain = slowTransport();
    const second = bare.server.attachSealed({ sessionId: sessionIdOf('messages only'), transport: plain });
    const [counted] = [...bare.server.sealedSessions];
    plain.emit('data', Buffer.alloc(100), true);
    assert.strictEqual(counted.preReadyBytes, 100);
    await second.catch(() => {});
  });

  it('a peer that never answers the close is cut off after the grace', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device], limits: { closeGraceMs: 10 } });
    const end = slowTransport();
    let terminated = 0;
    end.terminate = () => { terminated += 1; };
    const { conn } = await handshakeOn(server, end, device);
    conn.close(CLOSE.GOING_AWAY, 'going');
    assert.strictEqual(terminated, 0);
    await waitFor(() => terminated === 1, 'the terminate');
  });

  it('a stop and a refusal look like any small frame on the wire: the real frames, from the real dispatcher', async () => {
    const device = makeDevice('Field laptop');
    const answers = [false, 'unavailable'];
    const { createDispatcher, approvals } = realDispatcher({
      phone: fakePhone(() => answers.shift()),
      listChannels: () => ({ handle: ['chat:delete', 'chat:stopResponse', 'chat:load', 'chat:someNewChannel'], on: [] }),
      overrides: {
        'chat:delete': async () => ({ ok: true }),
        'chat:stopResponse': async () => ({ ok: true }),
        'chat:load': async () => ({ ok: true }),
        'chat:someNewChannel': async () => ({ ok: true })
      }
    });
    const { server } = makeServer({ devices: [device], approvals, createDispatcher });
    const { window } = await attached(server, device);
    const WIRE = 281;
    // As preload.js sends a stop.
    const stop = window.sealOnly(JSON.stringify({ t: 'invoke', id: 1, channel: 'chat:stopResponse', args: [{ chatId: 'c-20261104-0001' }] }));
    const load = window.sealOnly(JSON.stringify({ t: 'invoke', id: 2, channel: 'chat:load', args: ['c-20261104-0001'] }));
    assert.deepStrictEqual([stop.length, stop[0].length, load.length, load[0].length], [1, WIRE, 1, WIRE]);
    const nodeRecords = async (id, send) => {
      const before = window.nodeEnd.sent.length;
      send();
      const frame = await waitFor(() => window.received.find((f) => f.id === id), `the answer to ${id}`);
      assert.strictEqual(window.nodeEnd.sent.length, before + 1, 'one record');
      assert.strictEqual(window.nodeEnd.sent.at(-1).length, WIRE, JSON.stringify(frame.value));
      return frame.value;
    };
    const through = (records) => () => window.windowEnd.send(records[0]);
    assert.deepStrictEqual(await nodeRecords(1, through(stop)), { ok: true });
    await nodeRecords(2, through(load));
    const asked = (id, channel, args) => () => window.send({ t: 'invoke', id, channel, args });
    assert.strictEqual((await nodeRecords(3, asked(3, 'chat:delete', ['c-1']))).code, 'PHONE_DENIED');
    assert.strictEqual((await nodeRecords(4, asked(4, 'chat:delete', ['c-1']))).code, 'NO_PHONE');
    assert.strictEqual((await nodeRecords(5, asked(5, 'chat:someNewChannel', []))).code, 'REMOTE_LOCAL_ONLY');
  });

  it('a handshake that never finishes is closed, and pending handshakes are bounded', async () => {
    const device = makeDevice('Field laptop');
    const deadlines = [];
    const { server } = makeServer({
      devices: [device],
      sealedDeps: { setTimer: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.at(-1); }, clearTimer: () => {} }
    });
    const quiet = slowTransport();
    const attaching = server.attachSealed({ sessionId: sessionIdOf('quiet'), transport: quiet });
    assert.strictEqual(deadlines[0].ms, LIMITS.handshakeMs);
    deadlines[0].fn();
    await assert.rejects(attaching, (err) => err.closeCode === HANDSHAKE_TIMEOUT && err.code === 'handshake');
    assert.deepStrictEqual(quiet.closed, { code: HANDSHAKE_TIMEOUT, reason: 'handshake' });

    const crowded = makeServer({ devices: [device], limits: { maxPreAuthSockets: 2 } });
    const ends = [slowTransport(), slowTransport(), slowTransport()];
    const outcomes = ends.map((transport, i) => crowded.server.attachSealed({ sessionId: sessionIdOf(`crowd ${i}`), transport }).catch((err) => err));
    assert.strictEqual((await outcomes[0]).closeCode, CLOSE.TRY_AGAIN);
    assert.strictEqual(ends[0].closed.code, CLOSE.TRY_AGAIN);
    assert.strictEqual(ends[1].closed, null);
    assert.strictEqual(ends[2].closed, null);
    await crowded.server.stop();
    assert.strictEqual((await outcomes[1]).closeCode, CLOSE.GOING_AWAY);
  });

  it('a session id that is not one is refused before a byte goes', async () => {
    const { server } = makeServer({ devices: [] });
    const end = slowTransport();
    await assert.rejects(server.attachSealed({ sessionId: 'not-a-session', transport: end }), (err) => err.closeCode === 4401);
    assert.deepStrictEqual(end.sent, []);
    assert.strictEqual(end.closed.code, 4401);
  });

  it('keeps the heartbeat: pings when it has sent nothing, and closes 1001 on silence', async () => {
    const device = makeDevice('Field laptop');
    let at = 1000000;
    const timers = new Set();
    const sealedDeps = {
      now: () => at,
      setTimer: (fn, ms) => { const t = { fn, due: at + ms }; timers.add(t); return t; },
      clearTimer: (t) => timers.delete(t)
    };
    const advance = (ms) => {
      at += ms;
      for (const t of [...timers]) {
        if (t.due <= at) { timers.delete(t); t.fn(); }
      }
    };
    const { server, dispatcher } = makeServer({ devices: [device], sealedDeps });
    const end = slowTransport();
    const { seal, conn } = await handshakeOn(server, end, device);
    const before = end.sent.length;
    advance(PING_MS);
    assert.strictEqual(end.sent.length, before + 1, 'one ping');
    const opened = await seal.next(end.sent[1]);
    assert.strictEqual(opened.frames.length, 1, 'the ready frame opens first, in counter order');
    await seal.next(end.sent.at(-1));
    assert.strictEqual(seal.ready, true, 'the ping opened as a record');

    // A record received moves the silence out.
    for (const step of seal.records(Buffer.from('{"t":"send","channel":"x"}'))) assert.ok(step);
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');
    advance(SILENCE_MS - PING_MS);
    assert.strictEqual(end.closed, null);
    advance(SILENCE_MS);
    assert.deepStrictEqual(end.closed, { code: 1001, reason: 'silence' });
    assert.strictEqual(conn.live, false);
    assert.strictEqual(timers.size, 0, 'the timer stops with the session');
  });

  it('answers a ping with a pong', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const { window } = await attached(server, device);
    const sent = window.nodeEnd.sent.length;
    window.seal.ping();
    await waitFor(() => window.nodeEnd.sent.length === sent + 1, 'the pong');
    assert.strictEqual(window.sealClose, null);
  });

  it('stop() closes it with a bye, on a server that never listened, and takes no more', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device] });
    const { window } = await attached(server, device);
    assert.strictEqual(server.wss, null);
    await server.stop();
    await waitFor(() => window.wireClose, 'the close');
    assert.strictEqual(window.wireClose.code, CLOSE.GOING_AWAY);
    await waitFor(() => window.received.some((f) => f.t === 'bye'), 'the bye');
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    assert.strictEqual(server.recheckTimer, null);
    const late = slowTransport();
    await assert.rejects(server.attachSealed({ sessionId: sessionIdOf('late'), transport: late }), (err) => err.closeCode === CLOSE.GOING_AWAY);
    assert.deepStrictEqual(late.sent, []);
  });
});

describe('no new socket, and the loopback path as it was', () => {
  it('server.start opens one listener and attachSealed none', async (t) => {
    const listen = t.mock.method(net.Server.prototype, 'listen');
    const remote = makeDevice('Field laptop');
    const local = makeDevice('Desk', { remote: false });
    const { server } = makeServer({ devices: [remote, local] });
    const unstarted = await attached(server, remote);
    assert.strictEqual(listen.mock.callCount(), 0, 'a sealed connection needs no listener');
    assert.strictEqual(server.wss, null);
    assert.strictEqual(unstarted.conn.live, true);

    const { port } = await server.start();
    assert.strictEqual(listen.mock.callCount(), 1);
    const second = makeDevice('Second');
    writeDevices(server.configDir, [remote, local, second]);
    await attached(server, second);
    assert.strictEqual(listen.mock.callCount(), 1);
    assert.strictEqual(server.sockets.size, 0, 'a sealed session is not a loopback socket');

    const loop = await loopbackAttach(port, local);
    assert.ok(loop.ready);
    assert.strictEqual(loop.received.every((r) => r.isBinary === false), true, 'a local window still speaks JSON text');
    const conn = server.connections.get(local.deviceId);
    assert.strictEqual(conn.remote, false);
    assert.strictEqual(conn.revoked, false);
    assert.deepStrictEqual(Object.keys(loop.ready.frame), ['t', 'service']);
    loop.ws.close();
    await loop.closed;
  });

  it('a local connection the re-read finds gone closes as it did, and is not revoked', async () => {
    const local = makeDevice('Desk', { remote: false });
    const { server, configDir, dispatcher } = makeServer({ devices: [local] });
    const { port } = await server.start();
    const loop = await loopbackAttach(port, local);
    const conn = server.connections.get(local.deviceId);
    writeDevices(configDir, []);
    server._recheckLive();
    assert.deepStrictEqual(await loop.closed, { code: 4403, reason: 'unpaired' });
    assert.strictEqual(conn.revoked, false);
    assert.deepStrictEqual(dispatcher.revoked, []);
    assert.deepStrictEqual(dispatcher.disconnects, [local.deviceId]);
  });
});

describe('a slow reader (backpressure)', () => {
  it('holds back what the socket has not taken: what is out stays at the high water, whatever is sent', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const end = slowTransport();
    const { conn } = await handshakeOn(server, end, device);
    const frame = 'x'.repeat(MIB);
    const highWater = 4 * RECORD_WIRE_MAX;
    for (let i = 0; i < 40; i += 1) conn.send({ t: 'event', channel: 'a', payload: frame });
    await delay(10);
    const out = end.bytes();
    assert.ok(out <= highWater + 2 * RECORD_WIRE_MAX, `${out} bytes went to a socket that took none`);
    assert.ok(out >= highWater - RECORD_WIRE_MAX, 'it filled the high water');
    assert.strictEqual(end.closed, null);

    const seen = end.sent.length;
    end.flushAll();
    await waitFor(() => end.sent.length > seen, 'more once the socket took them');
    assert.strictEqual(end.closed, null);
  });

  it('closes the session past the queue limit rather than hold more, as a drop', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device], limits: { sealedQueueBytes: 8 * MIB } });
    const end = slowTransport();
    const { conn } = await handshakeOn(server, end, device);
    const frame = 'x'.repeat(MIB);
    for (let i = 0; i < 40 && conn.live; i += 1) {
      conn.send({ t: 'event', channel: 'a', payload: frame });
      await delay(0);
    }
    await waitFor(() => end.closed, 'the close');
    assert.deepStrictEqual(end.closed, { code: CLOSE.TRY_AGAIN, reason: 'slow reader' });
    assert.strictEqual(conn.revoked, false);
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    const out = end.bytes();
    assert.ok(out <= 4 * RECORD_WIRE_MAX + 2 * RECORD_WIRE_MAX, `${out} bytes out`);
    assert.strictEqual(conn.send({ t: 'event', channel: 'a' }), false);
  });

  it('a window that pings and never reads costs one pong: they do not pile up', async () => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const end = slowTransport();
    const { seal } = await handshakeOn(server, end, device);
    const before = end.sent.length;
    for (let i = 0; i < 200; i += 1) {
      seal.ping();
      await delay(0);
    }
    assert.strictEqual(end.sent.length, before + 1);
  });

  it('a socket that fails a write ends the session, and leaves no rejection unobserved', async (t) => {
    const unhandled = [];
    const note = (err) => unhandled.push(err);
    process.on('unhandledRejection', note);
    t.after(() => process.removeListener('unhandledRejection', note));
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device] });
    const end = slowTransport();
    const { conn } = await handshakeOn(server, end, device);
    conn.send({ t: 'event', channel: 'a', payload: 'x' });
    conn.send({ t: 'event', channel: 'b', payload: 'y' });
    for (const settle of end.pending.splice(0)) settle(new Error('socket gone'));
    await waitFor(() => end.closed, 'the close');
    assert.strictEqual(conn.live, false);
    assert.strictEqual(conn.revoked, false);
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepStrictEqual(unhandled, []);
  });

  it('a transport that throws, or that gives no promise, ends it too', async () => {
    const device = makeDevice('Field laptop');
    for (const bad of [() => { throw new Error('refused'); }, () => undefined]) {
      const { server } = makeServer({ devices: [device] });
      const end = slowTransport();
      const { conn } = await handshakeOn(server, end, device);
      end.send = bad;
      conn.send({ t: 'event', channel: 'a', payload: 'x' });
      await waitFor(() => end.closed, 'the close');
      assert.strictEqual(conn.live, false);
    }
  });
});

describe('over a real WebSocket (wsTransport)', () => {
  it('takes only an open socket: before that there is no TCP stream to count', async (t) => {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => { wss.once('listening', resolve); });
    t.after(() => wss.close());
    const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}/`);
    assert.throws(() => wsTransport(ws), /open socket/);
    await new Promise((resolve) => { ws.once('open', resolve); });
    const transport = wsTransport(ws);
    const raw = [];
    transport.on('raw', (chunk) => raw.push(chunk.length));
    const peer = [...wss.clients][0];
    peer.send(Buffer.alloc(100), { binary: true });
    await waitFor(() => raw.length > 0, 'a raw chunk');
    ws.terminate();
  });

  // A loopback server as the front door's far end: it is the window.
  async function pair(server, device) {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0, ...SOCKET_OPTIONS });
    await new Promise((resolve) => { wss.once('listening', resolve); });
    const sessionId = sessionIdOf(`ws ${++nextSession}`);
    const dialed = new WebSocket(`ws://127.0.0.1:${wss.address().port}/`, SOCKET_OPTIONS);
    const peer = await new Promise((resolve) => { wss.once('connection', resolve); });
    await new Promise((resolve) => { if (dialed.readyState === WebSocket.OPEN) resolve(); else dialed.once('open', resolve); });
    const received = [];
    const seal = WindowSeal.window({
      sessionId,
      deviceId: device.deviceId,
      publicKey: device.raw,
      sign: (bytes) => crypto.sign(null, bytes, device.privateKey),
      pin: nodeRaw,
      write: (bytes) => new Promise((resolve) => { peer.send(bytes, { binary: true }, () => resolve()); }),
      onClose: () => {}
    });
    peer.on('message', async (data) => {
      const result = await seal.next(data);
      for (const frame of result.frames) received.push(JSON.parse(frame.toString('utf8')));
    });
    const closed = new Promise((resolve) => { peer.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })); });
    peer.on('error', () => {});
    const attaching = server.attachSealed({ sessionId, transport: wsTransport(dialed) });
    const cleanup = () => { dialed.terminate(); peer.terminate(); wss.close(); };
    return { wss, dialed, peer, seal, received, closed, attaching, cleanup };
  }

  it('attaches, answers and closes with a close record first', async (t) => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher, configDir } = makeServer({ devices: [device] });
    const p = await pair(server, device);
    t.after(p.cleanup);
    await p.seal.next(null);
    const conn = await p.attaching;
    await waitFor(() => p.received.some((f) => f.t === 'ready'), 'ready');
    for (const step of p.seal.records(Buffer.from('{"t":"invoke","id":1,"channel":"chat:load","args":[]}'))) assert.ok(step);
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');
    writeDevices(configDir, []);
    server._recheckLive();
    assert.deepStrictEqual(await p.closed, { code: 4403, reason: 'unpaired' });
    assert.strictEqual(conn.revoked, true);
    await waitFor(() => !p.seal.ready, 'the close record');
  });

  it('a text frame, and a message past the limit, end it', async (t) => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const text = await pair(server, device);
    t.after(text.cleanup);
    await text.seal.next(null);
    const conn = await text.attaching;
    text.peer.send('{"t":"send"}');
    assert.deepStrictEqual(await text.closed, { code: 4400, reason: 'record' });
    assert.strictEqual(conn.live, false);

    const big = await pair(server, device);
    t.after(big.cleanup);
    await big.seal.next(null);
    const second = await big.attaching;
    big.peer.send(Buffer.alloc(RECORD_WIRE_MAX + 1), { binary: true });
    await waitFor(() => !second.live, 'the drop');
    assert.strictEqual(second.revoked, false);
  });

  it('before ready, a large message is cut as it arrives, with nothing said', async (t) => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const p = await pair(server, device);
    t.after(p.cleanup);
    p.peer.send(Buffer.alloc(LIMITS.preAuthSocketBytes + 1000), { binary: true });
    await assert.rejects(p.attaching, (err) => err.closeCode === 4401);
    assert.strictEqual(p.dialed.readyState === WebSocket.CLOSED || p.dialed.readyState === WebSocket.CLOSING, true);
    assert.deepStrictEqual(p.received, []);
  });

  it('a reader that has stopped: what the node holds stays at the high water', async (t) => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device] });
    const p = await pair(server, device);
    t.after(p.cleanup);
    await p.seal.next(null);
    const conn = await p.attaching;
    await waitFor(() => p.received.some((f) => f.t === 'ready'), 'ready');
    p.peer._socket.pause();
    const frame = 'x'.repeat(MIB);
    let peak = 0;
    for (let i = 0; i < 40 && conn.live; i += 1) {
      conn.send({ t: 'event', channel: 'a', payload: frame });
      await delay(1);
      peak = Math.max(peak, p.dialed.bufferedAmount);
    }
    await delay(50);
    peak = Math.max(peak, p.dialed.bufferedAmount);
    assert.strictEqual(conn.live, true);
    assert.ok(peak <= 4 * RECORD_WIRE_MAX + RECORD_WIRE_MAX, `${peak} bytes held in the socket`);
  });
});

describe('a node that cannot seal has no session (R-RW-30)', () => {
  const refused = async (approvals) => {
    const device = makeDevice('Field laptop');
    const { server } = makeServer({ devices: [device], approvals });
    const end = slowTransport();
    await assert.rejects(server.attachSealed({ sessionId: sessionIdOf('no seal'), transport: end }), (err) => err.code === 'node_not_sealing' && err.closeCode === CLOSE.NOT_SEALING);
    assert.deepStrictEqual(end.closed, { code: 4503, reason: 'node_not_sealing' });
    assert.deepStrictEqual(end.sent, [], 'not a byte of the handshake');
    assert.strictEqual(end.listenerCount('data'), 0);
    assert.strictEqual(server.connected.length, 0);
  };

  it('canSeal() false', () => refused({ sealPolicy: { canSeal: () => false } }));
  it('no policy at all', () => refused({ phoneApprover: {} }));
  it('no approvals at all', () => refused(null));
  it('a policy that throws', () => refused({ sealPolicy: { canSeal: () => { throw new Error('cannot read'); } } }));
  it('a policy that answers anything but true', () => refused({ sealPolicy: { canSeal: () => 'yes' } }));

  it('checked again when the handshake ends, and no connection is made', async () => {
    const device = makeDevice('Field laptop');
    let can = true;
    const { server, dispatcher } = makeServer({ devices: [device], approvals: { sealPolicy: { canSeal: () => can } } });
    const window = openWindow(server, device);
    await waitFor(() => window.nodeEnd.sent.length === 1, 'hello_n');
    can = false;
    const { error } = await window.outcome;
    assert.strictEqual(error.code, 'node_not_sealing');
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4503, reason: 'node_not_sealing' });
    assert.deepStrictEqual(window.received, []);
    assert.deepStrictEqual(dispatcher.disconnects, []);
  });

  it('a live session closes at the next re-read, as a drop', async () => {
    const device = makeDevice('Field laptop');
    let can = true;
    const { server, dispatcher } = makeServer({ devices: [device], approvals: { sealPolicy: { canSeal: () => can } } });
    const { window, conn } = await attached(server, device);
    server._recheckLive();
    assert.strictEqual(conn.live, true);
    can = false;
    server._recheckLive();
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4503, reason: 'node_not_sealing' });
    assert.strictEqual(conn.revoked, false);
    assert.deepStrictEqual(dispatcher.revoked, []);
  });
});

describe('every way a session ends', () => {
  const closers = {
    'the socket closing': ({ end }) => end.emit('close', 1006),
    'silence': ({ advance }) => advance(SILENCE_MS * 2),
    'a tampered record': ({ end }) => end.emit('data', Buffer.alloc(281), true),
    'a text frame': ({ end }) => end.emit('data', Buffer.alloc(281), false),
    'the peer\'s close record': ({ seal }) => seal.closeRecord(1000),
    'a revoke': ({ server, configDir }) => { writeDevices(configDir, []); server._recheckLive(); },
    'a read of the file that fails': ({ server, configDir }) => { fs.writeFileSync(path.join(configDir, pairing.DEVICES_FILE), '{"v":1,"dev'); server._recheckLive(); },
    'a node that cannot seal': ({ server, setCan }) => { setCan(false); server._recheckLive(); },
    'stop': ({ server }) => { server.stop(); },
    'a full queue': ({ conn, big }) => { for (let i = 0; i < 12; i += 1) conn.send(big); },
    'a failed write': ({ conn, end }) => { conn.send({ t: 'event', channel: 'a' }); for (const settle of end.pending.splice(0)) settle(new Error('gone')); }
  };
  for (const [name, close] of Object.entries(closers)) {
    it(`${name}: the seal is closed, no timer stays, nothing is kept`, async () => {
      const device = makeDevice('Field laptop');
      let at = 1000000;
      let can = true;
      const timers = new Set();
      const sealedDeps = {
        now: () => at,
        setTimer: (fn, ms) => { const t = { fn, due: at + ms }; timers.add(t); return t; },
        clearTimer: (t) => timers.delete(t)
      };
      const advance = (ms) => {
        at += ms;
        for (const t of [...timers]) {
          if (t.due <= at) { timers.delete(t); t.fn(); }
        }
      };
      const { server, configDir, dispatcher } = makeServer({
        devices: [device], sealedDeps, limits: { sealedQueueBytes: 4 * MIB }, approvals: { sealPolicy: { canSeal: () => can } }
      });
      const end = slowTransport();
      const { seal, conn } = await handshakeOn(server, end, device);
      const [state] = [...server.sealedSessions];
      const nodeSeal = state.seal;
      assert.strictEqual(nodeSeal.ready, true);
      assert.strictEqual(timers.size, 1, 'the heartbeat');
      close({ server, configDir, end, seal, conn, advance, setCan: (v) => { can = v; }, big: { t: 'event', channel: 'a', payload: 'x'.repeat(MIB) } });
      await waitFor(() => !conn.live, 'the end');
      assert.strictEqual(nodeSeal.ready, false);
      assert.strictEqual(timers.size, 0, 'the heartbeat stopped');
      assert.strictEqual(server.sealedSessions.size, 0);
      assert.strictEqual(state.seal, null);
      assert.strictEqual(state.transport, null);
      assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    });
  }

  it('before ready too: the deadline is cleared, on a refusal and on a socket gone', async () => {
    const device = makeDevice('Field laptop');
    const timers = new Set();
    const sealedDeps = { setTimer: (fn) => { const t = { fn }; timers.add(t); return t; }, clearTimer: (t) => timers.delete(t) };
    const { server } = makeServer({ devices: [device], sealedDeps });
    const end = slowTransport();
    const attaching = server.attachSealed({ sessionId: sessionIdOf('deadline'), transport: end });
    assert.strictEqual(timers.size, 1);
    end.emit('close', 1006);
    await assert.rejects(attaching);
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(server.sealedSessions.size, 0);
  });
});

describe('a devices file that cannot be read says nothing about a device', () => {
  const corrupt = (configDir) => fs.writeFileSync(path.join(configDir, pairing.DEVICES_FILE), '{"v":1,"devices":[{"deviceId"');

  it('one bad read: closed with a true reason, withdrawn, and it attaches again once the file reads', async () => {
    const device = makeDevice('Field laptop');
    const { server, configDir, dispatcher } = makeServer({ devices: [device] });
    const first = await attached(server, device);
    corrupt(configDir);
    server._recheckLive();
    await waitFor(() => first.window.wireClose, 'the close');
    assert.deepStrictEqual(first.window.wireClose, { code: CLOSE.RECORD_UNREADABLE, reason: 'record_unreadable' });
    assert.deepStrictEqual(first.window.sealClose, { code: CLOSE.RECORD_UNREADABLE, reason: 'peer' });
    assert.strictEqual(first.conn.revokeSignal.aborted, true, 'approvals are withdrawn');
    assert.strictEqual(first.conn.revokeReason, 'unconfirmed');
    assert.deepStrictEqual(dispatcher.revoked, [device.deviceId]);

    const during = openWindow(server, device);
    assert.strictEqual((await during.outcome).error.closeCode, 4401, 'nobody attaches while it cannot be read');

    writeDevices(configDir, [device]);
    const again = await attached(server, device);
    assert.strictEqual(again.conn.live, true);
    assert.strictEqual(again.conn.revoked, false);
    server._recheckLive();
    assert.strictEqual(again.conn.live, true);
  });

  it('the file going bad between the seal\'s lookup and ready refuses with the same reason', async () => {
    const device = makeDevice('Field laptop');
    const { server, configDir } = makeServer({ devices: [device] });
    const lookups = server._readDevices.bind(server);
    let calls = 0;
    server._readDevices = () => {
      calls += 1;
      if (calls === 2) corrupt(configDir);
      return lookups();
    };
    const window = openWindow(server, device);
    const { error } = await window.outcome;
    assert.strictEqual(error.closeCode, CLOSE.RECORD_UNREADABLE);
    assert.strictEqual(error.code, 'record_unreadable');
  });

  it('a local window is closed as it was', async () => {
    const local = makeDevice('Desk', { remote: false });
    const { server, configDir } = makeServer({ devices: [local] });
    const { port } = await server.start();
    const loop = await loopbackAttach(port, local);
    assert.ok(loop.ready);
    corrupt(configDir);
    server._recheckLive();
    assert.deepStrictEqual(await loop.closed, { code: 4403, reason: 'unpaired' });
  });

  it('the row says it could not be confirmed, and a truly revoked run says revoked', async () => {
    for (const [breakIt, row] of [
      [corrupt, MESSAGES.WINDOW_UNCONFIRMED_RUN],
      [(dir) => writeDevices(dir, []), MESSAGES.WINDOW_REVOKED_RUN]
    ]) {
      const device = makeDevice('Field laptop');
      const holds = new Map();
      const { createDispatcher, approvals, context } = realDispatcher({
        phone: fakePhone(() => true),
        listChannels: () => ({ handle: ['chat:sendMessage'], on: [] }),
        patchContext: (ctx) => { ctx.stopRunForEvent = () => true; },
        overrides: { 'chat:sendMessage': (event, { chatId }) => new Promise((resolve) => { holds.set(chatId, resolve); }) }
      });
      const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'chat:sendMessage', args: [{ chatId: 'c-run', message: 'go' }] });
      await waitFor(() => holds.get('c-run'), 'the run');
      breakIt(configDir);
      server._recheckLive();
      assert.deepStrictEqual(context.rows.map((r) => [r[0], r[2]]), [['c-run', row]]);
      holds.get('c-run')({ ok: true });
    }
  });

  it('one bad read reaches a gone connection still at work, and reads the file once per pass', async () => {
    const devices = [makeDevice('One'), makeDevice('Two'), makeDevice('Three')];
    const { server, configDir, dispatcher } = makeServer({ devices });
    const held = [];
    dispatcher.hold = () => new Promise((resolve) => { held.push(resolve); });
    const sessions = [];
    for (const device of devices) sessions.push(await attached(server, device));
    for (const { window } of sessions.slice(0, 2)) window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    await waitFor(() => dispatcher.frames.length === 2, 'the frames');
    sessions[0].window.windowEnd.close(1006, 'gone');
    await waitFor(() => !sessions[0].conn.live, 'the drop');
    assert.strictEqual(server.heldConns.has(sessions[0].conn), true);

    const reads = server._readDevices.bind(server);
    let count = 0;
    server._readDevices = () => { count += 1; return reads(); };
    server._recheckLive();
    assert.strictEqual(count, 1);
    assert.strictEqual(sessions[0].conn.revoked, false);

    corrupt(configDir);
    server._recheckLive();
    assert.strictEqual(sessions[0].conn.revokeReason, 'unconfirmed');
    assert.strictEqual(sessions[1].conn.revokeReason, 'unconfirmed');
    for (const resolve of held) resolve();
    await waitFor(() => server.heldConns.size === 0, 'all let go');
  });

  it('gone windows at work are capped: past it a new session is refused, and none is forgotten', async () => {
    const devices = [makeDevice('One'), makeDevice('Two')];
    const { server, dispatcher } = makeServer({ devices, limits: { maxHeldWindows: 1 } });
    const held = [];
    dispatcher.hold = () => new Promise((resolve) => { held.push(resolve); });
    const first = await attached(server, devices[0]);
    first.window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');
    first.window.windowEnd.close(1006, 'gone');
    await waitFor(() => !first.conn.live, 'the drop');
    const refused = openWindow(server, devices[1]);
    const { error } = await refused.outcome;
    assert.strictEqual(error.closeCode, CLOSE.TRY_AGAIN);
    assert.strictEqual(error.code, 'too many held windows');
    assert.strictEqual(server.heldConns.has(first.conn), true);
    held[0]();
    await waitFor(() => server.heldConns.size === 0, 'let go');
    assert.ok(await attached(server, devices[1]));
    assert.strictEqual(LIMITS.maxHeldWindows, 64);
  });
});

describe('a revoked device is not a dropped one (R-RW-31, Review Focus 5)', () => {
  it('revoked with the socket still up and a call running: nothing is answered', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher } = makeServer({ devices: [device] });
    const { window, conn } = await attached(server, device);
    const held = deferred();
    dispatcher.hold = async (c, frame) => {
      await held.promise;
      c.send({ t: 'result', id: frame.id, value: 'too late' });
    };
    window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');
    const before = window.nodeEnd.sent.length;
    conn.revoke();
    assert.strictEqual(conn.live, true, 'the socket is still up');
    held.resolve();
    await delay(5);
    assert.strictEqual(conn.send({ t: 'event', channel: 'a' }), false);
    assert.strictEqual(window.nodeEnd.sent.length, before);
  });

  it('the re-read runs every 5 s and closes a revoked record 4403 unpaired; a frame in flight is answered with nothing', async () => {
    assert.strictEqual(LIMITS.deviceRecheckMs, 5000);
    const device = makeDevice('Field laptop');
    const { server, dispatcher, configDir } = makeServer({ devices: [device], limits: { deviceRecheckMs: 25 } });
    const { window, conn } = await attached(server, device);
    const held = deferred();
    dispatcher.hold = async (c, frame) => {
      await held.promise;
      c.send({ t: 'result', id: frame.id, value: 'too late' });
    };
    window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    await waitFor(() => dispatcher.frames.length === 1, 'the frame');

    const before = window.nodeEnd.sent.length;
    writeDevices(configDir, []);
    await waitFor(() => window.wireClose, 'the close');
    assert.deepStrictEqual(window.wireClose, { code: 4403, reason: 'unpaired' });
    assert.deepStrictEqual(window.sealClose, { code: 4403, reason: 'peer' });
    assert.strictEqual(conn.revoked, true);
    assert.strictEqual(conn.revokeSignal.aborted, true);
    assert.deepStrictEqual(dispatcher.revoked, [device.deviceId]);
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);

    const closing = window.nodeEnd.sent.length;
    assert.strictEqual(closing, before + 1, 'only the close record went');
    held.resolve();
    await delay(5);
    assert.strictEqual(window.nodeEnd.sent.length, closing, 'the answer went nowhere');
    assert.deepStrictEqual(window.received.filter((f) => f.t === 'result'), []);
    assert.strictEqual(server.heldConns.size, 0, 'nothing is held once the frame ended');
    assert.strictEqual(server.sealedSessions.size, 0);
  });

  it('a frame that arrives after the close is not read', async () => {
    const device = makeDevice('Field laptop');
    const { server, dispatcher, configDir } = makeServer({ devices: [device] });
    const { window } = await attached(server, device);
    const [record] = window.sealOnly('{"t":"invoke","id":1,"channel":"chat:load","args":[]}');
    writeDevices(configDir, []);
    server._recheckLive();
    window.nodeEnd.emit('data', record, true);
    await delay(5);
    assert.deepStrictEqual(dispatcher.frames, []);
  });

  describe('the real dispatcher', () => {
    const CARD = 'chat:delete';
    const channels = { handle: [CARD, 'chat:sendMessage', 'chat:load'], on: [] };

    function rig({ decide, handler = null, patchContext = null, phone = null }) {
      const device = makeDevice('Field laptop');
      const ran = [];
      const gate = phone || fakePhone(decide);
      const { createDispatcher, approvals, seen, context } = realDispatcher({
        phone: gate,
        patchContext,
        listChannels: () => channels,
        overrides: {
          [CARD]: handler || (async (event, chatId) => { ran.push({ chatId, approved: remoteWindowApproved(event), event }); return { ok: true }; }),
          'chat:load': async (event) => { ran.push({ read: true, event }); return { ok: true }; }
        }
      });
      const made = makeServer({ devices: [device], approvals, createDispatcher });
      return { ...made, device, ran, gate, seen, context };
    }
    const asked = (gate) => waitFor(() => gate.calls.length === 1, 'the phone asked');

    it('a remote frame\'s event is remote-marked, never local, for a read and for a phone call', async () => {
      const { server, device, ran } = rig({ decide: () => true });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
      window.send({ t: 'invoke', id: 2, channel: CARD, args: ['c-1'] });
      await waitFor(() => window.received.filter((f) => f.t === 'result').length === 2, 'both answers');
      const events = ran.map((r) => r.event);
      assert.strictEqual(events.length, 2);
      for (const event of events) {
        assert.strictEqual(isRemoteWindowEvent(event), true);
        assert.strictEqual(isLocalDesktopEvent(event), false);
        assert.strictEqual(remoteWindowDeviceId(event), device.deviceId);
      }
      assert.strictEqual(remoteWindowApproved(ran.find((r) => r.chatId).event), 'req-1');
    });

    it('a pending approval hears the revoke through its signal, and nothing runs or answers', async () => {
      const answer = deferred();
      const { server, device, configDir, ran, gate } = rig({
        decide: (_tool, _params, metadata) => new Promise((resolve) => {
          metadata.signal.addEventListener('abort', () => resolve(false), { once: true });
          answer.promise.then(resolve);
        })
      });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await asked(gate);
      assert.strictEqual(gate.calls[0].metadata.signal.aborted, false);
      writeDevices(configDir, []);
      server._recheckLive();
      assert.strictEqual(gate.calls[0].metadata.signal.aborted, true);
      await delay(5);
      assert.deepStrictEqual(ran, []);
      assert.deepStrictEqual(window.received.filter((f) => f.t === 'result'), []);
    });

    it('an approval that lands after the revoke does not run its call', async () => {
      const answer = deferred();
      const { server, device, configDir, ran, gate } = rig({ decide: () => answer.promise });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await asked(gate);
      writeDevices(configDir, []);
      server._recheckLive();
      answer.resolve(true);
      await delay(5);
      assert.deepStrictEqual(ran, [], 'approved, and revoked first: it does not run');
      assert.deepStrictEqual(window.received.filter((f) => f.t === 'result'), []);
    });

    it('a mere drop still runs what was approved', async () => {
      const answer = deferred();
      const { server, device, ran, gate } = rig({ decide: () => answer.promise });
      const { window, conn } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await asked(gate);
      window.windowEnd.close(1006, 'gone');
      await waitFor(() => !conn.live, 'the drop');
      assert.strictEqual(gate.calls[0].metadata.signal.aborted, false, 'a drop withdraws nothing');
      answer.resolve(true);
      await waitFor(() => ran.length === 1, 'the call');
      assert.strictEqual(ran[0].chatId, 'c-1');
      assert.strictEqual(remoteWindowApproved(ran[0].event), 'req-1');
    });

    it('dropped first and revoked after: the re-read still finds it, and the approval is withdrawn', async () => {
      const answer = deferred();
      const { server, device, configDir, ran, gate } = rig({ decide: () => answer.promise });
      const { window, conn } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await asked(gate);
      window.windowEnd.close(1006, 'gone');
      await waitFor(() => !conn.live, 'the drop');
      server._recheckLive();
      assert.strictEqual(conn.revoked, false, 'its record is still there');
      writeDevices(configDir, []);
      server._recheckLive();
      assert.strictEqual(conn.revoked, true);
      assert.strictEqual(gate.calls[0].metadata.signal.aborted, true);
      answer.resolve(true);
      await delay(5);
      assert.deepStrictEqual(ran, []);
      await waitFor(() => server.heldConns.size === 0, 'the conn let go');
    });

    it('replaced by its own new connection and then revoked: the old one\'s approval is withdrawn too', async () => {
      const answer = deferred();
      const { server, device, configDir, ran, gate } = rig({ decide: () => answer.promise });
      const first = await attached(server, device);
      first.window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await asked(gate);
      const second = await attached(server, device);
      assert.strictEqual(first.conn.live, false);
      writeDevices(configDir, []);
      server._recheckLive();
      assert.strictEqual(first.conn.revoked, true);
      assert.strictEqual(second.conn.revoked, true);
      answer.resolve(true);
      await delay(5);
      assert.deepStrictEqual(ran, []);
    });

    it('with the real PhoneApprover: withdrawn, the phone told, its late approve refused', async (t) => {
      const phoneDevice = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([phoneDevice.approverRecord()]);
      t.after(() => store.cleanup());
      const submitted = [];
      const statuses = [];
      const link = {
        on() {}, off() {}, isConnected: () => true, canDeliver: () => ({ ok: true }),
        submit: async (envelope) => { submitted.push(envelope); },
        status: async (envelope) => { statuses.push(envelope); }
      };
      const entries = [];
      const audit = { append: async (e) => { entries.push(e); return e; } };
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: audit, ttlMs: 60000 });
      t.after(() => approver.stop());
      const { server, device, configDir, ran } = rig({ phone: approver });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await waitFor(() => submitted.length === 1, 'the card');
      writeDevices(configDir, []);
      server._recheckLive();
      await waitFor(() => statuses.length === 1, 'the withdrawal');
      assert.strictEqual(open(statuses[0]).message.state, 'withdrawn');
      await waitFor(() => entries.some((e) => e.kind === 'approval.outcome' && e.data.state === 'withdrawn'), 'the audit');
      const late = await approver.handleResponse(phoneDevice.respond(submitted[0], 'approve'));
      assert.strictEqual(late.accepted, false);
      await delay(5);
      assert.deepStrictEqual(ran, []);
      assert.deepStrictEqual(window.received.filter((f) => f.t === 'result'), []);
    });

    it('a folder the phone is being asked about is withdrawn too', async () => {
      const folder = deferred();
      const results = [];
      let prompter = null;
      const { server, device, configDir, gate } = rig({
        decide: (tool) => (tool === 'AllowDirectory' ? folder.promise : true),
        patchContext: (ctx) => { prompter = ctx.prompter; },
        handler: async () => {
          results.push(await prompter.requestDirectoryAccess({ directory: 'D:\\example', toolName: 'Read' }));
          return { ok: true };
        }
      });
      const { window } = await attached(server, device);
      // chat:delete is phone class: its own approval comes first.
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await waitFor(() => gate.calls.length === 2, 'the folder asked');
      assert.strictEqual(gate.calls[1].toolName, 'AllowDirectory');
      assert.strictEqual(gate.calls[1].metadata.signal.aborted, false);
      writeDevices(configDir, []);
      server._recheckLive();
      assert.strictEqual(gate.calls[1].metadata.signal.aborted, true);
      folder.resolve(true);
      await waitFor(() => results.length === 1, 'the answer');
      assert.deepStrictEqual(results, [false], 'approved, and revoked first: no folder');
    });

    it('a revoke stops the device\'s runs, whose tool cards go with them, and says so in the chat; a drop stops none', async () => {
      const stopped = [];
      const holds = new Map();
      const device = makeDevice('Field laptop');
      const { createDispatcher, approvals, context } = realDispatcher({
        phone: fakePhone(() => true),
        listChannels: () => channels,
        patchContext: (ctx) => { ctx.stopRunForEvent = (event) => { stopped.push(event); return true; }; },
        overrides: {
          'chat:sendMessage': (event, { chatId }) => new Promise((resolve) => { holds.set(chatId, { event, resolve }); }),
          [CARD]: async () => ({ ok: true }),
          'chat:load': async () => ({ ok: true })
        }
      });
      const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window, conn } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'chat:sendMessage', args: [{ chatId: 'c-run', message: 'go' }] });
      await waitFor(() => holds.get('c-run'), 'the run');

      window.windowEnd.close(1006, 'gone');
      await waitFor(() => !conn.live, 'the drop');
      assert.deepStrictEqual(stopped, [], 'a drop stops nothing');

      writeDevices(configDir, []);
      server._recheckLive();
      assert.deepStrictEqual(stopped, [holds.get('c-run').event]);
      assert.deepStrictEqual(context.rows.map((r) => [r[0], r[2]]), [['c-run', MESSAGES.WINDOW_REVOKED_RUN]]);
      server._recheckLive();
      assert.strictEqual(stopped.length, 1, 'once');
      holds.get('c-run').resolve({ ok: true });
    });

    it('a grant that lands after the revoke does not run its call', async () => {
      const grant = deferred();
      const ran = [];
      const device = makeDevice('Field laptop');
      const asks = [];
      const { createDispatcher, approvals } = realDispatcher({
        phone: fakePhone(() => true),
        listChannels: () => ({ handle: [CARD], on: [] }),
        extra: { approvalGate: () => { asks.push(1); return grant.promise; } },
        overrides: { [CARD]: async () => { ran.push(1); return { ok: true }; } }
      });
      const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: CARD, args: ['c-1'] });
      await waitFor(() => asks.length === 1, 'the gate');
      writeDevices(configDir, []);
      server._recheckLive();
      grant.resolve({ allow: true, grant_id: 'g-1' });
      await delay(5);
      assert.deepStrictEqual(ran, []);
    });

    it('an approved folder call revoked while its path is looked at does not act', async () => {
      for (const [method, params] of [
        ['bridge.setWorkingDirectory', { chatId: 'c-1', path: 'D:\\example' }],
        ['bridge.addAllowedDirectory', { path: 'D:\\example' }]
      ]) {
        const looked = deferred();
        const ran = [];
        const device = makeDevice('Field laptop');
        const asks = [];
        const { createDispatcher, approvals, seen } = realDispatcher({
          phone: fakePhone(() => true),
          listChannels: () => ({ handle: ['chat:setWorkingDirectory'], on: [] }),
          extra: { checkPath: () => { asks.push(1); return looked.promise; } },
          overrides: { 'chat:setWorkingDirectory': async () => { ran.push(1); return { ok: true }; } }
        });
        const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
        const { window } = await attached(server, device);
        window.send({ t: 'call', id: 1, method, params });
        await waitFor(() => asks.length === 1, 'the path');
        writeDevices(configDir, []);
        server._recheckLive();
        looked.resolve({ readable: true, isDirectory: true });
        await delay(5);
        assert.deepStrictEqual(ran, []);
        assert.deepStrictEqual(seen.dispatcher.scope.getSettings().allowedDirectories || [], []);
      }
    });

    it('a workflow it started is cancelled, also when its frame has long ended and the window has gone; a drop cancels none', async () => {
      const workflows = new Map();
      const engine = {
        run: async () => {},
        cancel: (id) => { workflows.get(id).status = 'cancelled'; },
        get: (id) => workflows.get(id) || null
      };
      const device = makeDevice('Field laptop');
      const { createDispatcher, approvals } = realDispatcher({
        phone: fakePhone(() => true),
        contextExtra: { getWorkflowEngine: () => engine },
        extra: { hosting: 'personal' },
        listChannels: () => ({ handle: ['workflow:run', 'workflow:planAndExecute'], on: [] }),
        overrides: {
          'workflow:run': async (_event, { id }) => { workflows.set(id, { status: 'running' }); return { ok: true, id }; },
          'workflow:planAndExecute': async () => { workflows.set('w-planned', { status: 'running' }); return { ok: true, workflow: { id: 'w-planned' } }; }
        }
      });
      const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window, conn } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'workflow:run', args: [{ id: 'w-run' }] });
      window.send({ t: 'invoke', id: 2, channel: 'workflow:planAndExecute', args: [{ goal: 'go' }] });
      await waitFor(() => window.received.filter((f) => f.t === 'result').length === 2, 'both answers');
      window.windowEnd.close(1006, 'gone');
      await waitFor(() => !conn.live, 'the drop');
      assert.strictEqual(workflows.get('w-run').status, 'running', 'a drop stops nothing');
      assert.strictEqual(server.heldConns.has(conn), true, 'kept for its workflows');

      writeDevices(configDir, []);
      server._recheckLive();
      assert.strictEqual(workflows.get('w-run').status, 'cancelled');
      assert.strictEqual(workflows.get('w-planned').status, 'cancelled');
      assert.strictEqual(server.heldConns.size, 0);
    });

    it('a window gone whose workflow ended is let go at the next re-read', async () => {
      const workflows = new Map();
      const engine = { run: async () => {}, cancel() {}, get: (id) => workflows.get(id) || null };
      const device = makeDevice('Field laptop');
      const { createDispatcher, approvals } = realDispatcher({
        phone: fakePhone(() => true),
        contextExtra: { getWorkflowEngine: () => engine },
        extra: { hosting: 'personal' },
        listChannels: () => ({ handle: ['workflow:run'], on: [] }),
        overrides: { 'workflow:run': async (_event, { id }) => { workflows.set(id, { status: 'running' }); return { ok: true, id }; } }
      });
      const { server } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window, conn } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'workflow:run', args: [{ id: 'w-1' }] });
      await waitFor(() => window.received.some((f) => f.t === 'result'), 'the answer');
      window.windowEnd.close(1006, 'gone');
      await waitFor(() => !conn.live, 'the drop');
      server._recheckLive();
      assert.strictEqual(server.heldConns.size, 1);
      workflows.get('w-1').status = 'completed';
      server._recheckLive();
      assert.strictEqual(server.heldConns.size, 0);
    });

    it('with the real PhoneApprover: a card asked inside any of its frames goes with the revoke, and a new one is refused', async (t) => {
      const phoneDevice = createFakePhone({ name: 'Phone 1' });
      const store = await approverStoreWith([phoneDevice.approverRecord()]);
      t.after(() => store.cleanup());
      const submitted = [];
      const link = {
        on() {}, off() {}, isConnected: () => true, canDeliver: () => ({ ok: true }),
        submit: async (envelope) => { submitted.push(envelope); },
        status: async () => {}
      };
      const audit = { append: async (e) => e };
      const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link, auditLedger: audit, ttlMs: 60000 });
      t.after(() => approver.stop());
      const answers = [];
      const again = deferred();
      const device = makeDevice('Field laptop');
      const { createDispatcher, approvals } = realDispatcher({
        phone: approver,
        listChannels: () => ({ handle: ['chat:load'], on: [] }),
        overrides: {
          // A read: it has no gate, so what it asks is an inner card, as a skill's or a
          // cron run's or tool:execute's tool is, with no signal of its own.
          'chat:load': async () => {
            answers.push(await approver.requestApproval('Bash', { command: 'echo one' }, {}));
            await again.promise;
            answers.push(await approver.requestApproval('Bash', { command: 'echo two' }, {}));
            return { ok: true };
          }
        }
      });
      const { server, configDir } = makeServer({ devices: [device], approvals, createDispatcher });
      const { window } = await attached(server, device);
      window.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
      await waitFor(() => submitted.length === 1, 'the inner card');
      writeDevices(configDir, []);
      server._recheckLive();
      await waitFor(() => answers.length === 1, 'the withdrawal');
      assert.deepStrictEqual(answers, [false]);
      assert.strictEqual(approver.pending().length, 0);
      again.resolve();
      await waitFor(() => answers.length === 2, 'the second ask');
      assert.deepStrictEqual(answers, [false, false]);
      assert.strictEqual(submitted.length, 1, 'no second card');
    });

    it('a frame handed to the dispatcher after the revoke runs nothing and answers nothing', async () => {
      const { server, device, seen, ran } = rig({ decide: () => true });
      const { conn } = await attached(server, device);
      conn.revoke();
      const before = [...server.sealedSessions][0].transport.sent.length;
      await seen.dispatcher.handleFrame(conn, { t: 'invoke', id: 9, channel: 'chat:load', args: [] });
      assert.deepStrictEqual(ran, []);
      assert.strictEqual([...server.sealedSessions][0].transport.sent.length, before);
    });
  });
});
