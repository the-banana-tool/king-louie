// The window's side of the remote path (R-RW-18, R-RW-34): RemoteWindowClient over the
// real splice in the fake front door, and createWindowOAuth against the OAuth harness.
// A node here is the real DesktopBridgeServer, or a fake with its own key, since a key
// the front door hands a window must earn nothing however it answers.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { RemoteWindowClient, PHONE_BOUND_MS, FIRST_RETRY_SPREAD_MS, RATE_LIMIT_WAIT_MS, MAX_CODE_ATTEMPTS } = require('../src/desktop-bridge/remote-client');
const { createWindowOAuth, OAuthClientError } = require('../src/desktop-bridge/oauth-client');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { WindowSeal, createFrameSender, SOCKET_OPTIONS } = require('../src/desktop-bridge/window-seal');
const { wsTransport } = require('../src/desktop-bridge/sealed-socket');
const { enrollCode } = require('../src/approvals/window-messages');
const { TTL_MAX_MS, decodeQr } = require('../src/approvals/messages');
const { CLOSE } = require('../src/desktop-bridge/protocol');
const { NodeIdentity } = require('../src/mesh/node-identity');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { startFakeWindowFrontDoor } = require('./helpers/fake-window-frontdoor');
const { startFrontDoorHttp, FLEET } = require('./helpers/frontdoor-harness');
const { request, parseConsent, cookieOf } = require('./helpers/oauth-test-client');
const { holdEventLoop } = require('./helpers/hold-event-loop');

after(holdEventLoop());

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const TOKEN = 'token-one';
const TOKENS = { [TOKEN]: { grant_id: 'grant-1', client_id: 'client-1', scopes: ['window:attach'] } };
const MIB = 1024 * 1024;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch { /* already gone */ }
  }
});

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitFor = async (fn, what = 'a condition', ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(3);
  }
  throw new Error(`timed out waiting for ${what}`);
};

function newWindow(label = 'Laptop') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), raw, privateKey, label };
}

const rawOf = (identity) => Buffer.from(identity.publicKey, 'hex').subarray(-32);

// The front door's certificate is self-signed here; production dials with the system roots.
function dialer(counter = { dials: 0 }) {
  class TestSocket extends WebSocket {
    constructor(url, protocols, options) {
      counter.dials += 1;
      counter.options = options;
      counter.url = url;
      super(url, protocols, { ...options, rejectUnauthorized: false });
    }
  }
  TestSocket.counter = counter;
  return TestSocket;
}

// Only what a test moves: the retry, heartbeat and request timers.
function fakeClock(start = 1000000) {
  let t = start;
  const timers = new Map();
  let next = 1;
  const clock = {
    delays: [],
    now: () => t,
    setTimer(fn, ms) {
      const id = next;
      next += 1;
      clock.delays.push(ms);
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    // One timer at a time, each at its own moment, so what it arms joins in.
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    }
  };
  return clock;
}

function clientFor(frontDoor, nodeId, device, extra = {}) {
  const client = new RemoteWindowClient({
    origin: frontDoor.origin,
    nodeId,
    deviceId: device.deviceId,
    publicKey: device.raw,
    sign: (bytes) => crypto.sign(null, bytes, device.privateKey),
    pin: null,
    getToken: async () => TOKEN,
    onNodeKey: () => {},
    backoffMs: [5],
    firstRetrySpreadMs: 0,
    attachesPerMinute: 1000,
    ws: dialer(),
    ...extra
  });
  client.on('state', () => {});
  cleanups.push(() => client.close());
  return client;
}

async function door(nodes, options = {}) {
  const frontDoor = await startFakeWindowFrontDoor({ nodes, tokens: TOKENS, ...options });
  cleanups.push(() => frontDoor.stop());
  return frontDoor;
}

// The real node, with a stand-in for what Task 9 tests itself: the answers its
// enrollment gives, and a record written when the phone approves.
function realNode({ devices = [], onFrame = null, sealedDeps = undefined, limits = {} } = {}) {
  const identity = new NodeIdentity({ nodeName: 'web-01' });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-client-'));
  cleanups.push(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const write = (list) => {
    let doc = pairing.emptyDevices();
    for (const d of list) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-11-04T10:00:00.000Z', remote: true });
    pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
  };
  const frames = [];
  const connections = [];
  const server = new DesktopBridgeServer({
    identity,
    configDir,
    port: 0,
    version: '26.11.0',
    adminUid: UID,
    geteuid: () => UID,
    account: 'tester',
    limits: { deviceRecheckMs: 20, ...limits },
    approvals: { sealPolicy: { canSeal: () => true, whyNot: () => '' } },
    ...(sealedDeps ? { sealedDeps } : {}),
    createDispatcher: () => ({
      served: { handle: ['chat:load'], on: ['chat:ping'] },
      providersConfigured: () => true,
      async handleFrame(conn, frame) {
        frames.push(frame);
        if (!connections.includes(conn)) connections.push(conn);
        if (onFrame) {
          onFrame(conn, frame);
        } else if (frame.id !== undefined) {
          conn.send({ t: 'result', id: frame.id, value: { echo: frame.channel || frame.method } });
        }
      },
      async onDisconnect() {},
      onRevoke() {},
      forwardAmbient() {}
    })
  });
  cleanups.push(() => server.stop());
  write(devices);
  let changed = () => {};
  const enrollment = {
    states: 'pending',
    request: async () => ({ request_id: 'req-1', expires_at: '2026-11-04T10:10:00.000Z' }),
    status: () => ({ state: enrollment.states }),
    onChange(fn) { changed = fn; },
    revokedRecord: () => false,
    close() {}
  };
  server.setWindowEnrollment(enrollment);
  return {
    identity, server, frames, connections, enrollment, writeDevices: write,
    approve(device) {
      write([device]);
      changed();
    }
  };
}

// A node with its own key that says whatever a test tells it to. Everything it is sent
// is kept, to show what the window would send.
function fakeNode({ identity = new NodeIdentity({ nodeName: 'not-the-node' }), known = () => null, onReady = null, onFrame = null } = {}) {
  const node = {
    identity,
    received: [],
    sessions: [],
    send: null,
    onSocket(ws, params) {
      ws.on('error', () => {});
      ws.once('open', () => {
        const transport = wsTransport(ws);
        const session = { ws, sender: null, frames: [] };
        node.sessions.push(session);
        const seal = WindowSeal.node({
          sessionId: params.session_id,
          identity: { nodeId: identity.nodeId, publicKey: rawOf(identity), sign: (b) => identity.sign(b) },
          enrollUnknown: true,
          lookupDevice: known,
          write: (bytes) => transport.send(bytes),
          onClose: () => {}
        });
        session.seal = seal;
        session.send = (obj) => session.sender.send(Buffer.from(JSON.stringify(obj))).catch(() => {});
        transport.on('data', async (message) => {
          const result = await seal.next(message);
          if (result.ready && !session.sender) {
            session.sender = createFrameSender({ seal });
            if (onReady) onReady(session, result.peer);
          }
          for (const frame of result.frames) {
            const parsed = JSON.parse(frame.toString('utf8'));
            node.received.push(parsed);
            if (onFrame) onFrame(session, parsed);
          }
        });
      });
    }
  };
  return node;
}

describe('RemoteWindowClient, attached', () => {
  it('invoke, call, send and events go round through the seal', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity) });
    const service = await client.connect();
    assert.equal(service.nodeId, node.identity.nodeId);
    assert.equal(client.connected, true);
    assert.equal(client.status, 'connected');
    assert.equal(client.state.status, 'connected');
    assert.equal(client.service.nodeId, node.identity.nodeId);
    assert.deepEqual(await client.invoke('chat:load', ['a']), { echo: 'chat:load' });
    assert.deepEqual(await client.call('bridge.status'), { echo: 'bridge.status' });
    assert.equal(client.send('chat:ping', ['x']), true);
    await waitFor(() => node.frames.find((f) => f.t === 'send' && f.channel === 'chat:ping'), 'the send');
    const event = new Promise((resolve) => { client.once('event', (channel, payload) => resolve({ channel, payload })); });
    node.connections[0].send({ t: 'event', channel: 'chat:messageChunk', payload: { text: 'hi' } });
    assert.deepEqual(await event, { channel: 'chat:messageChunk', payload: { text: 'hi' } });
  });

  it('dials wss with the seal options, the bearer and system roots', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket });
    await client.connect();
    const { options, url } = socket.counter;
    assert.equal(url, `${frontDoor.origin.replace('https:', 'wss:')}/window/v1?node=${node.identity.nodeId}`);
    assert.equal(options.maxPayload, SOCKET_OPTIONS.maxPayload);
    assert.equal(options.perMessageDeflate, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
  });

  it('refuses a plain http origin and a pin that is not the node id\'s key', () => {
    const device = newWindow();
    const identity = new NodeIdentity({ nodeName: 'web-01' });
    const base = { nodeId: identity.nodeId, deviceId: device.deviceId, publicKey: device.raw, sign: () => Buffer.alloc(64), getToken: async () => TOKEN, onNodeKey: () => {} };
    assert.throws(() => new RemoteWindowClient({ ...base, origin: 'http://mcp.kl.example.com', pin: null }), /https/);
    assert.throws(() => new RemoteWindowClient({ ...base, origin: 'https://mcp.kl.example.com', pin: Buffer.alloc(32, 7) }), /pin/);
  });

  it('a changed node key is SERVICE_KEY_CHANGED, held, and the pin stays', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const imposter = fakeNode();
    // The front door names the real node and hands the socket to another key.
    const frontDoor = await door([{ identity: node.identity, onSocket: imposter.onSocket }]);
    const socket = dialer();
    const called = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket, onNodeKey: (k) => called.push(k) });
    await assert.rejects(client.connect(), { code: 'SERVICE_KEY_CHANGED' });
    assert.equal(client.status, 'failed');
    assert.equal(client.state.code, 'SERVICE_KEY_CHANGED');
    assert.deepEqual(client.pin, rawOf(node.identity));
    assert.deepEqual(called, []);
    await delay(40);
    assert.equal(socket.counter.dials, 1, 'held: no retry until retryNow');
  });

  it('holds its frames until the node\'s first record', async () => {
    const device = newWindow();
    const node = fakeNode({ known: () => device.raw, onReady: (session) => { node.first = session; } });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity) });
    const connecting = client.connect();
    await waitFor(() => node.first, 'the node ready');
    assert.equal(client.connected, false);
    assert.equal(client.send('chat:ping'), false);
    await assert.rejects(client.invoke('chat:load'), { code: 'SERVICE_UNREACHABLE' });
    await delay(30);
    assert.deepEqual(node.received, []);
    node.first.send({ t: 'ready', service: { nodeId: node.identity.nodeId, channels: [] } });
    await connecting;
    assert.equal(client.connected, true);
  });

  it('a 2 MiB invoke says how far it has got, record by record', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }], { config: { maxBytesPerHour: 64 * MIB } });
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity) });
    await client.connect();
    const progress = [];
    client.on('progress', (p) => progress.push(p));
    await client.invoke('chat:load', ['x'.repeat(2 * MIB)]);
    assert.ok(progress.length >= 3, `three records at least, got ${progress.length}`);
    const { total } = progress[0];
    assert.ok(total > 2 * MIB);
    assert.equal(progress.at(-1).sent, total);
    assert.deepEqual(progress.map((p) => p.sent), [...progress.map((p) => p.sent)].sort((a, b) => a - b));
    progress.length = 0;
    await client.invoke('chat:load', ['small']);
    assert.deepEqual(progress, [], 'a small frame says nothing');
  });

  it('every phone-class call has a bound above the phone\'s own', async () => {
    assert.ok(PHONE_BOUND_MS > TTL_MAX_MS);
    const device = newWindow();
    const node = realNode({ devices: [device], onFrame: (conn, frame) => { if (frame.id !== undefined && frame.channel !== 'skills:set') conn.send({ t: 'result', id: frame.id, value: 1 }); } });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const clock = fakeClock();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), timers: clock, defaultTimeoutMs: 1000 });
    await client.connect();
    clock.delays.length = 0;
    const { PHONE_CHANNEL, READ_CHANNEL, PHONE_METHOD } = classSamples();
    await client.invoke(READ_CHANNEL);
    assert.ok(clock.delays.includes(1000), 'a read keeps the default');
    clock.delays.length = 0;
    await client.invoke(PHONE_CHANNEL);
    assert.ok(clock.delays.includes(PHONE_BOUND_MS), 'a phone channel');
    clock.delays.length = 0;
    await client.invoke(PHONE_CHANNEL, [], { timeoutMs: 5 });
    assert.ok(clock.delays.includes(PHONE_BOUND_MS), 'a caller\'s shorter bound does not win');
    clock.delays.length = 0;
    await client.call(PHONE_METHOD);
    assert.ok(clock.delays.includes(PHONE_BOUND_MS), 'a phone method');
    clock.delays.length = 0;
    // Raised by what it asks, and the client cannot read the context: phone.
    await client.invoke('models:setChatProfile', [{ chatId: 'c', profileId: 'p' }]);
    assert.ok(clock.delays.includes(PHONE_BOUND_MS), 'a channel its arguments raise');
  });
});

function classSamples() {
  const { REMOTE_CLASSES, CALL_METHODS } = require('../src/desktop-bridge/remote-classes');
  const { channelTimeoutMs, LONG_CHANNEL_TIMEOUT_MS } = require('../src/desktop-bridge/allowlist');
  const entries = Object.entries(REMOTE_CLASSES);
  const ordinaryTimeout = (name) => channelTimeoutMs(name, 1) === 1;
  const PHONE_CHANNEL = entries.find(([name, cls]) => cls === 'phone' && name.includes(':') && ordinaryTimeout(name))[0];
  const READ_CHANNEL = entries.find(([name, cls]) => cls === 'read' && name.includes(':') && ordinaryTimeout(name))[0];
  const PHONE_METHOD = CALL_METHODS.find((name) => REMOTE_CLASSES[name] === 'phone');
  assert.ok(PHONE_CHANNEL && READ_CHANNEL && PHONE_METHOD && LONG_CHANNEL_TIMEOUT_MS);
  return { PHONE_CHANNEL, READ_CHANNEL, PHONE_METHOD };
}

describe('RemoteWindowClient, enrolling (R-RW-34)', () => {
  const qrOf = (answer) => decodeQr(answer.qr);
  const codeFor = (answer, device, identity) => enrollCode({ nonce: Buffer.from(qrOf(answer).n, 'base64url'), devicePublicKey: device.raw, nodePublicKey: rawOf(identity) });
  const wrongCode = (code) => (code === '000000' ? '000001' : '000000');

  it('exposes only enroll and enrollStatus, makes the QR itself, and promotes after the code and the record', async () => {
    const device = newWindow();
    const node = realNode();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const pinned = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device, { onNodeKey: (k) => pinned.push(Buffer.from(k)) });
    assert.equal(await client.connect(), null);
    assert.equal(client.status, 'enrolling');
    assert.equal(client.connected, false);
    assert.equal(client.send('chat:ping'), false);
    await assert.rejects(client.invoke('chat:load'), { code: 'SERVICE_UNREACHABLE' });
    await assert.rejects(client.call('bridge.status'), { code: 'SERVICE_UNREACHABLE' });
    assert.equal(client.status, 'enrolling', 'asking for more does not end the session');

    const answer = await client.enroll('Laptop');
    assert.equal(answer.request_id, 'req-1');
    assert.equal(answer.expires_at, '2026-11-04T10:10:00.000Z');
    const qr = qrOf(answer);
    assert.equal(qr.t, 'kl.window');
    assert.equal(Buffer.from(qr.n, 'base64url').length, 16);
    assert.deepEqual(Buffer.from(qr.h, 'base64url'), crypto.createHash('sha256').update(device.raw).update(rawOf(node.identity)).digest());
    assert.deepEqual(await client.enrollStatus(), { state: 'pending' });

    const code = codeFor(answer, device, node.identity);
    node.approve(device);
    await waitFor(() => client.state.recorded === true, 'the record');
    assert.equal(client.status, 'enrolling', 'a record is not the code');
    assert.deepEqual(pinned, []);
    await assert.rejects(client.invoke('chat:load'), { code: 'SERVICE_UNREACHABLE' });

    assert.deepEqual(client.confirmCode(code), { ok: true, attemptsLeft: MAX_CODE_ATTEMPTS });
    assert.deepEqual(pinned, [rawOf(node.identity)]);
    assert.equal(client.status, 'connected');
    assert.deepEqual(await client.invoke('chat:load'), { echo: 'chat:load' });
  });

  it('the code first, then the record: it waits, then connects on the same session', async () => {
    const device = newWindow();
    const node = realNode();
    const socket = dialer();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { ws: socket });
    await client.connect();
    const answer = await client.enroll('Laptop');
    assert.equal(client.confirmCode(codeFor(answer, device, node.identity)).ok, true);
    assert.equal(client.status, 'connecting');
    assert.equal(client.state.awaitingRecord, true);
    node.approve(device);
    await waitFor(() => client.status === 'connected', 'connected');
    assert.equal(socket.counter.dials, 1);
  });

  it('a fake node with its own key answers approved and ready: the client stays enrolling and pins nothing', async () => {
    const device = newWindow();
    const node = fakeNode({
      onReady: (session) => session.send({ t: 'enrolling', protocol: 1 }),
      onFrame: (session, frame) => {
        if (frame.method === 'window.enroll') session.send({ t: 'result', id: frame.id, value: { request_id: 'r', expires_at: '2026-11-04T10:10:00.000Z' } });
        if (frame.method === 'window.enrollStatus') {
          session.send({ t: 'result', id: frame.id, value: { state: 'approved' } });
          session.send({ t: 'ready', service: { nodeId: node.identity.nodeId, channels: ['chat:load'] } });
        }
      }
    });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const pinned = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device, { onNodeKey: (k) => pinned.push(k) });
    await client.connect();
    const answer = await client.enroll('Laptop');
    assert.deepEqual(await client.enrollStatus(), { state: 'approved' });
    assert.deepEqual(await client.enrollStatus(), { state: 'approved' });
    await delay(30);
    assert.equal(client.status, 'enrolling');
    assert.equal(client.connected, false);
    assert.equal(client.pin, null);
    assert.deepEqual(pinned, []);
    await assert.rejects(client.invoke('chat:load'), { code: 'SERVICE_UNREACHABLE' });
    assert.deepEqual([...new Set(node.received.map((f) => `${f.t}:${f.method}`))].sort(), ['call:window.enroll', 'call:window.enrollStatus']);
    // n never crossed the socket.
    assert.equal(JSON.stringify(node.received).includes(qrOf(answer).n), false);
  });

  it('a socket drop while enrolling pins nothing, and another key under the node id of the entry is refused', async () => {
    const device = newWindow();
    const first = fakeNode({ onReady: (session) => session.send({ t: 'enrolling', protocol: 1 }), onFrame: (session, frame) => session.send({ t: 'result', id: frame.id, value: { request_id: 'r', expires_at: 'x' } }) });
    const second = fakeNode({ onReady: (session) => session.send({ t: 'enrolling', protocol: 1 }) });
    let current = first;
    const frontDoor = await door([{ identity: first.identity, onSocket: (ws, p) => current.onSocket(ws, p) }]);
    const pinned = [];
    const client = clientFor(frontDoor, first.identity.nodeId, device, { onNodeKey: (k) => pinned.push(k) });
    await client.connect();
    const answer = await client.enroll('Laptop');
    const code = codeFor(answer, device, first.identity);
    current = second;
    first.sessions[0].ws.terminate();
    // A node id is its key's, so a second key cannot pass under the entry's id.
    await waitFor(() => client.status === 'failed', 'held');
    assert.equal(client.state.code, 'SERVICE_KEY_CHANGED');
    assert.deepEqual(pinned, []);
    assert.equal(client.pin, null);
    // The code still speaks for the key its own session proved.
    assert.equal(client.confirmCode(code).ok, true);
    assert.deepEqual(client.pin, rawOf(first.identity));
  });

  it('five wrong codes end the attempt: a new key exchange, a new n, a new QR', async () => {
    const device = newWindow();
    const node = realNode();
    const socket = dialer();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const pinned = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device, { ws: socket, onNodeKey: (k) => pinned.push(k) });
    await client.connect();
    const answer = await client.enroll('Laptop');
    const right = codeFor(answer, device, node.identity);
    const wrong = wrongCode(right);
    for (let left = MAX_CODE_ATTEMPTS - 1; left >= 1; left -= 1) {
      assert.deepEqual(client.confirmCode(wrong), { ok: false, attemptsLeft: left });
      assert.equal(socket.counter.dials, 1);
    }
    assert.deepEqual(client.confirmCode(wrong), { ok: false, attemptsLeft: 0 });
    assert.deepEqual(pinned, []);
    await waitFor(() => socket.counter.dials === 2 && client.status === 'enrolling', 'the new key exchange');
    // The old code is no key now, whatever it was.
    assert.equal(client.confirmCode(right).ok, false);
    assert.deepEqual(pinned, []);
    const again = await client.enroll('Laptop');
    assert.notEqual(qrOf(again).n, qrOf(answer).n);
    assert.notEqual(again.qr, answer.qr);
    assert.equal(client.confirmCode(codeFor(again, device, node.identity)).ok, true);
    assert.deepEqual(pinned, [rawOf(node.identity)]);
  });

  it('a mistyped code that is not six digits costs no attempt, and spaces are the owner\'s', async () => {
    const device = newWindow();
    const node = realNode();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device);
    await client.connect();
    const answer = await client.enroll('Laptop');
    assert.equal(client.confirmCode('12').attemptsLeft, MAX_CODE_ATTEMPTS);
    assert.equal(client.confirmCode(null).attemptsLeft, MAX_CODE_ATTEMPTS);
    const code = codeFor(answer, device, node.identity);
    assert.equal(client.confirmCode(` ${code.slice(0, 3)} ${code.slice(3)} `).ok, true);
  });

  it('a pin that cannot be saved stays enrolling; a sync throw says so and an async one fails the tab', async () => {
    const device = newWindow();
    const node = realNode();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    let mode = 'throw';
    const client = clientFor(frontDoor, node.identity.nodeId, device, {
      onNodeKey: () => {
        if (mode === 'throw') throw new Error('disk');
        return Promise.reject(new Error('disk'));
      }
    });
    await client.connect();
    const answer = await client.enroll('Laptop');
    const code = codeFor(answer, device, node.identity);
    const refused = client.confirmCode(code);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'PIN_NOT_SAVED');
    assert.equal(client.status, 'enrolling');
    assert.equal(client.pin, null);
    mode = 'reject';
    assert.equal(client.confirmCode(code).ok, true);
    await waitFor(() => client.status === 'failed', 'failed');
    assert.equal(client.state.code, 'PIN_NOT_SAVED');
  });

  it('a device the node already records, with no pin and no attempt, cannot enroll again and says why', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device);
    assert.equal(await client.connect(), null);
    assert.equal(client.status, 'enrolling');
    assert.equal(client.state.recorded, true);
    await assert.rejects(client.enroll('Laptop'), { code: 'ENROLL_RECORDED' });
    assert.equal(node.frames.length, 0, 'nothing went to the dispatcher');
  });

  it('a sealed denial is NOT_ENROLLED and held; from an unconfirmed key it is not authenticated', async () => {
    const device = newWindow();
    const node = realNode();
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const states = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device);
    client.on('enrollState', (state) => states.push(state));
    await client.connect();
    await client.enroll('Laptop');
    node.enrollment.states = 'denied';
    node.server._recheckLive();
    await waitFor(() => client.status === 'failed', 'held');
    assert.equal(client.state.code, 'NOT_ENROLLED');
    assert.equal(client.state.authenticated, false);
    assert.deepEqual(states, ['denied']);
  });

  it('a refused enroll call rejects with the node\'s code, and a malformed answer is refused', async () => {
    const device = newWindow();
    const node = fakeNode({
      onReady: (session) => session.send({ t: 'enrolling', protocol: 1 }),
      onFrame: (session, frame) => {
        if (node.mode === 'error') session.send({ t: 'result', id: frame.id, error: 'no', code: 'enroll_rate_limited' });
        else session.send({ t: 'result', id: frame.id, value: { request_id: 7 } });
      }
    });
    node.mode = 'error';
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device);
    await client.connect();
    await assert.rejects(client.enroll('Laptop'), { code: 'enroll_rate_limited' });
    node.mode = 'malformed';
    await assert.rejects(client.enroll('Laptop'), { code: 'ENROLL_MALFORMED' });
    await assert.rejects(client.enroll('x'.repeat(5000)), { code: 'ENROLL_LABEL_TOO_LONG' });
    assert.equal(client.status, 'enrolling');
  });
});

describe('RemoteWindowClient, what a close means', () => {
  it('4403 grant_revoked is GRANT_REVOKED, held until retryNow, and clears no pin', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const socket = dialer();
    const pin = rawOf(node.identity);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin, ws: socket });
    await client.connect();
    frontDoor.revokeGrant('grant-1');
    await waitFor(() => client.status === 'failed', 'held');
    assert.equal(client.state.code, 'GRANT_REVOKED');
    assert.equal(client.state.authenticated, false, 'a socket code proves nothing');
    assert.deepEqual(client.pin, pin);
    await delay(30);
    assert.equal(socket.counter.dials, 1);
    await assert.rejects(client.retryNow(), { code: 'GRANT_REVOKED' });
    assert.equal(socket.counter.dials, 2);
  });

  it('4404 retries with backoff until the node is back', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server, online: false }]);
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket, backoffMs: [10] });
    await assert.rejects(client.connect(), { code: 'NODE_OFFLINE' });
    assert.equal(client.status, 'disconnected');
    assert.ok(client.state.nextRetryAt);
    frontDoor.setOnline(node.identity.nodeId, true);
    await waitFor(() => client.status === 'connected', 'back');
    assert.ok(socket.counter.dials >= 2);
  });

  it('4401 invalid_token refreshes the token, once; a second refusal holds', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const asked = [];
    const client = clientFor(frontDoor, node.identity.nodeId, device, {
      pin: rawOf(node.identity),
      getToken: async (options) => {
        asked.push(options);
        return options && options.force ? TOKEN : 'stale';
      }
    });
    await assert.rejects(client.connect(), { code: 'TOKEN_INVALID' });
    await waitFor(() => client.status === 'connected', 'connected with the new token');
    assert.equal(asked[0].force, false);
    assert.equal(asked[1].force, true);
    client.close();

    const socket = dialer();
    const refused = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket, getToken: async () => 'stale' });
    await assert.rejects(refused.connect(), { code: 'TOKEN_INVALID' });
    await waitFor(() => refused.status === 'failed', 'held');
    assert.equal(refused.state.code, 'TOKEN_REFUSED');
    assert.equal(socket.counter.dials, 2);
  });

  it('a getToken that fails retries, unless it says the tokens are dead', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    let calls = 0;
    const client = clientFor(frontDoor, node.identity.nodeId, device, {
      pin: rawOf(node.identity),
      getToken: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return TOKEN;
      }
    });
    await assert.rejects(client.connect(), { code: 'TOKEN_UNAVAILABLE' });
    await waitFor(() => client.status === 'connected', 'connected');
    client.close();

    const dead = clientFor(frontDoor, node.identity.nodeId, device, {
      pin: rawOf(node.identity),
      getToken: async () => { throw new OAuthClientError('SIGN_IN_AGAIN', { tokensDead: true }); }
    });
    await assert.rejects(dead.connect(), { code: 'SIGN_IN_AGAIN' });
    assert.equal(dead.status, 'failed');
  });

  it('a node\'s too_many_windows on the socket retries and says busy', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    let refuse = true;
    const entry = {
      identity: node.identity,
      open(params, { dial }) {
        if (refuse) return { ok: false, code: 'too_many_windows' };
        const ws = dial();
        ws.on('error', () => {});
        ws.once('open', () => node.server.attachSealed({ sessionId: params.session_id, transport: wsTransport(ws) }).catch(() => {}));
        return { ok: true };
      }
    };
    const frontDoor = await door([entry]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), backoffMs: [20] });
    await assert.rejects(client.connect(), { code: 'WINDOW_BUSY' });
    assert.equal(client.status, 'disconnected');
    assert.match(client.state.error, /busy/i);
    refuse = false;
    await waitFor(() => client.status === 'connected', 'connected');
  });

  // Each close record from a key the window has pinned.
  const sealedClose = async (code) => {
    const device = newWindow();
    const node = fakeNode({ known: () => device.raw, onReady: (session) => { session.send({ t: 'ready', service: { channels: [] } }); node.session = session; } });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket, backoffMs: [100000] });
    await client.connect();
    const pending = client.invoke('chat:load').catch((err) => err);
    await waitFor(() => node.received.length === 1, 'the invoke');
    node.session.seal.closeRecord(code);
    node.session.ws.close(code);
    await waitFor(() => client.status !== 'connected', 'the close');
    const rejected = await pending;
    assert.equal(rejected.code, 'SERVICE_UNREACHABLE');
    return client;
  };

  it('a sealed 4403 is DEVICE_UNPAIRED, authenticated and held', async () => {
    const client = await sealedClose(CLOSE.UNKNOWN_DEVICE);
    assert.equal(client.status, 'failed');
    assert.equal(client.state.code, 'DEVICE_UNPAIRED');
    assert.equal(client.state.authenticated, true);
  });

  it('a sealed 4409 is TOO_MANY_WINDOWS, its words say busy, and it is held', async () => {
    const client = await sealedClose(CLOSE.TOO_MANY_WINDOWS);
    assert.equal(client.status, 'failed');
    assert.equal(client.state.code, 'TOO_MANY_WINDOWS');
    assert.match(client.state.error, /busy/i);
  });

  it('a sealed 4503 and 4504 retry', async () => {
    for (const [code, name] of [[CLOSE.NOT_SEALING, 'NODE_NOT_SEALING'], [CLOSE.RECORD_UNREADABLE, 'RECORD_UNREADABLE']]) {
      const client = await sealedClose(code);
      assert.equal(client.status, 'disconnected');
      assert.equal(client.state.code, name);
      assert.ok(client.state.nextRetryAt);
      client.close();
    }
  });

  it('a sealed 1000, replaced by a new connection, holds, so two windows do not take turns', async () => {
    const client = await sealedClose(1000);
    assert.equal(client.status, 'failed');
    assert.equal(client.state.code, 'REPLACED');
  });

  it('a node on another bridge protocol holds PROTOCOL_MISMATCH', async () => {
    const device = newWindow();
    const node = fakeNode({ known: () => device.raw, onReady: (session) => session.send({ t: 'ready', service: { protocol: 99, channels: [] } }) });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity) });
    await assert.rejects(client.connect(), { code: 'PROTOCOL_MISMATCH' });
    assert.equal(client.status, 'failed');
  });

  it('a socket 4403 unpaired with no record holds and proves nothing', async () => {
    const device = newWindow();
    const node = fakeNode({ known: () => device.raw, onReady: (session) => { session.send({ t: 'ready', service: { channels: [] } }); node.session = session; } });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }]);
    const pin = rawOf(node.identity);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin });
    await client.connect();
    node.session.ws.close(4403, 'unpaired');
    await waitFor(() => client.status === 'failed', 'held');
    assert.equal(client.state.code, 'DEVICE_UNPAIRED');
    assert.equal(client.state.authenticated, false);
    assert.deepEqual(client.pin, pin);
  });

  it('cuts a peer that sends too much before the seal is ready', async () => {
    const device = newWindow();
    const entry = {
      identity: new NodeIdentity({ nodeName: 'flood' }),
      onSocket(ws) {
        ws.on('error', () => {});
        ws.once('open', () => ws.send(Buffer.alloc(9000)));
      }
    };
    const frontDoor = await door([entry]);
    const client = clientFor(frontDoor, entry.identity.nodeId, device, { backoffMs: [100000] });
    await assert.rejects(client.connect(), { code: 'HANDSHAKE_FAILED' });
  });

  it('refuses a text frame on the socket', async () => {
    // The splice would cut one itself, so this socket is a stand-in with no splice.
    const device = newWindow();
    const identity = new NodeIdentity({ nodeName: 'web-01' });
    class TextSocket extends EventEmitter {
      constructor() {
        super();
        this.OPEN = 1;
        this.readyState = 1;
        this._socket = null;
        setImmediate(() => {
          this.emit('upgrade', { headers: { 'x-kl-window-session': crypto.randomBytes(32).toString('base64url') } });
          this.emit('open');
          setImmediate(() => this.emit('message', Buffer.from('text'), false));
        });
      }

      send(bytes, options, done) { done(); }

      close() { this.emit('close', 1006, Buffer.alloc(0)); }

      terminate() { this.emit('close', 1006, Buffer.alloc(0)); }
    }
    const client = clientFor({ origin: 'https://mcp.kl.example.com' }, identity.nodeId, device, { ws: TextSocket, backoffMs: [100000] });
    await assert.rejects(client.connect(), { code: 'HANDSHAKE_FAILED' });
  });

  it('close says goodbye under the seal, stops retrying, and rejects what waits', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device], onFrame: () => {} });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket });
    await client.connect();
    const pending = client.invoke('chat:load');
    client.close();
    await assert.rejects(pending, { code: 'SERVICE_UNREACHABLE' });
    assert.equal(client.status, 'stopped');
    await delay(30);
    assert.equal(socket.counter.dials, 1);
    assert.equal(client.connected, false);
  });

  it('a throwing listener does not end a session', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity) });
    client.on('event', () => { throw new Error('a listener'); });
    client.on('state', () => { throw new Error('a listener'); });
    await client.connect();
    await client.invoke('chat:load');
    node.connections[0].send({ t: 'event', channel: 'x', payload: 1 });
    await delay(20);
    assert.equal(client.connected, true);
  });
});

describe('RemoteWindowClient, the heartbeat', () => {
  // Only the window's heartbeat is on the fake clock; the node answers pings itself.
  it('a quiet session stays up on pongs', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server }]);
    const clock = fakeClock();
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), timers: clock, ws: socket });
    await client.connect();
    // Nothing is sent but pings, and each round waits for the pong to be read.
    let records = 0;
    client.session.ws.on('message', () => { records += 1; });
    for (let i = 0; i < 12; i += 1) {
      const before = records;
      clock.advance(20000);
      await waitFor(() => records > before, 'the pong');
      await delay(1);
    }
    assert.equal(client.status, 'connected');
    assert.equal(socket.counter.dials, 1);
    assert.deepEqual(await client.invoke('chat:load'), { echo: 'chat:load' });
  });

  it('60 s of silence reconnects', async () => {
    const device = newWindow();
    const silent = fakeNode({ known: () => device.raw, onReady: (session) => session.send({ t: 'ready', service: { channels: [] } }) });
    const frontDoor = await door([{ identity: silent.identity, onSocket: silent.onSocket }]);
    const clock = fakeClock();
    const socket = dialer();
    const client = clientFor(frontDoor, silent.identity.nodeId, device, { pin: rawOf(silent.identity), timers: clock, ws: socket });
    await client.connect();
    // Stop reading at the node's socket: no pong can come back.
    silent.sessions[0].ws.pause();
    clock.advance(59000);
    await delay(10);
    assert.equal(client.status, 'connected');
    clock.advance(1000);
    await waitFor(() => client.status === 'disconnected', 'the silence');
    assert.equal(client.state.code, 'SILENCE');
    clock.advance(10);
    await waitFor(() => socket.counter.dials === 2, 'the redial');
  });
});

describe('RemoteWindowClient, staying under the grant\'s attaches', () => {
  // A refused dial, on the fake clock, so a wait can be read to the millisecond.
  const offline = async (random, extra = {}) => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server, online: false }]);
    const clock = fakeClock();
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, {
      pin: rawOf(node.identity), timers: clock, ws: socket, random, backoffMs: [1000, 60000], firstRetrySpreadMs: FIRST_RETRY_SPREAD_MS, attachesPerMinute: 1000, ...extra
    });
    return { client, clock, socket, frontDoor, node };
  };

  it('spreads the tabs\' first retry by random', async () => {
    const a = await offline(() => 0.1);
    const b = await offline(() => 0.9);
    await assert.rejects(a.client.connect(), { code: 'NODE_OFFLINE' });
    await assert.rejects(b.client.connect(), { code: 'NODE_OFFLINE' });
    const waitOf = (t) => t.client.state.nextRetryAt - t.clock.now();
    assert.equal(waitOf(a), 1000 + 0.1 * FIRST_RETRY_SPREAD_MS);
    assert.equal(waitOf(b), 1000 + 0.9 * FIRST_RETRY_SPREAD_MS);
    assert.ok(FIRST_RETRY_SPREAD_MS >= 15000);

    a.clock.advance(waitOf(a) - 1);
    await delay(10);
    assert.equal(a.socket.counter.dials, 1, 'not a moment early');
    a.clock.advance(1);
    await waitFor(() => a.socket.counter.dials === 2, 'the first retry');
  });

  it('after the first retry a client tries about once a minute', async () => {
    const t = await offline(() => 0);
    await assert.rejects(t.client.connect(), { code: 'NODE_OFFLINE' });
    t.clock.advance(1000);
    await waitFor(() => t.socket.counter.dials === 2 && t.client.status === 'disconnected', 'the first retry');
    assert.equal(t.client.state.nextRetryAt - t.clock.now(), 60000);
  });

  it('after 4429 rate_limited it waits out a full minute, retryNow and connect included', async () => {
    const device = newWindow();
    const node = realNode({ devices: [device] });
    const frontDoor = await door([{ identity: node.identity, server: node.server, online: false }]);
    // Spend the grant's attempts from another tab.
    const spent = dialer();
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => {
        const ws = new spent(`${frontDoor.origin.replace('https:', 'wss:')}/window/v1?node=${node.identity.nodeId}`, ['kl-window-v1'], { headers: { authorization: `Bearer ${TOKEN}` } });
        ws.on('close', resolve);
        ws.on('error', () => {});
      });
    }
    const clock = fakeClock();
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, {
      pin: rawOf(node.identity), timers: clock, ws: socket, random: () => 0.5, backoffMs: [1000, 60000], firstRetrySpreadMs: 20000
    });
    await assert.rejects(client.connect(), { code: 'FRONT_DOOR_BUSY' });
    assert.equal(client.status, 'disconnected');
    assert.match(client.state.error, /busy/i);
    assert.equal(client.state.nextRetryAt - clock.now(), RATE_LIMIT_WAIT_MS + 10000);
    assert.ok(RATE_LIMIT_WAIT_MS >= 60000);

    await assert.rejects(client.retryNow(), { code: 'FRONT_DOOR_BUSY' });
    await assert.rejects(client.connect(), { code: 'FRONT_DOOR_BUSY' });
    assert.equal(socket.counter.dials, 1, 'pressing retry does not spend an attempt');
    clock.advance(RATE_LIMIT_WAIT_MS + 9999);
    await delay(20);
    assert.equal(socket.counter.dials, 1);
    clock.advance(1);
    await waitFor(() => socket.counter.dials === 2, 'the retry after the minute');
  });

  it('a session that keeps dropping stays under the per-client bound', async () => {
    const device = newWindow();
    const node = fakeNode({ known: () => device.raw, onReady: (session) => { session.send({ t: 'ready', service: { channels: [] } }); setTimeout(() => session.ws.terminate(), 2); } });
    const frontDoor = await door([{ identity: node.identity, onSocket: node.onSocket }], { config: { maxSessionsPerGrant: 100 } });
    const socket = dialer();
    const client = clientFor(frontDoor, node.identity.nodeId, device, { pin: rawOf(node.identity), ws: socket, backoffMs: [1], attachesPerMinute: 3 });
    await client.connect().catch(() => {});
    await delay(300);
    assert.ok(socket.counter.dials <= 3, `${socket.counter.dials} dials`);
    assert.ok(client.state.nextRetryAt - Date.now() > 50000, 'the next is near a minute off');
  });

  it('a single client\'s defaults: first retry well under a minute, and no more than 3 a minute', () => {
    const device = newWindow();
    const identity = new NodeIdentity({ nodeName: 'web-01' });
    const client = new RemoteWindowClient({ origin: 'https://mcp.kl.example.com', nodeId: identity.nodeId, deviceId: device.deviceId, publicKey: device.raw, sign: () => Buffer.alloc(64), pin: rawOf(identity), getToken: async () => TOKEN, onNodeKey: () => {} });
    assert.equal(client.attachesPerMinute <= 3, true);
    assert.equal(client.backoffMs[0] + client.firstRetrySpreadMs < 60000, true);
    // 8 tabs at one a minute each stay under the grant's 10.
    assert.ok(client.backoffMs.at(-1) >= 60000);
  });
});

describe('createWindowOAuth (R-RW-10)', () => {
  const ORIGIN = 'https://mcp.kl.example.com';
  const WITH_WINDOW = [...FLEET, 'window:attach'];

  const running = [];
  afterEach(async () => {
    while (running.length) await running.pop()();
  });

  async function harness(options = {}) {
    const h = await startFrontDoorHttp({ scopesEnabled: WITH_WINDOW, pendingPerIp: 20, ...options });
    running.push(() => h.stop());
    // fetch with the Host the harness answers to, over its plain http.
    const fetch = async (url, init = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, ORIGIN);
      assert.equal(init.redirect, 'error', 'a token request follows no redirect');
      const res = await request(h.base, { method: init.method || 'GET', path: `${parsed.pathname}${parsed.search}`, headers: init.headers || {}, raw: init.body });
      return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => res.text };
    };
    return { h, fetch };
  }

  // The browser: it loads the consent page, the phone grants, it follows the redirect
  // to the loopback address.
  const approvingBrowser = (h, { alter = (u) => u, urls = [] } = {}) => async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const consent = await request(h.base, { path: `${parsed.pathname}${parsed.search}` });
    assert.equal(consent.status, 200, consent.text);
    const { userCode, grantId } = parseConsent(consent.text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    const signed = h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [...view.preselected].sort().map((s) => ({ scope: s, machines: null })) });
    const decision = await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, signed);
    assert.equal(decision.status, 200);
    const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) } });
    const location = alter(wait.headers.location);
    await new Promise((resolve, reject) => {
      http.get(location, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  };

  it('registers, authorizes with the phone\'s grant, refreshes and revokes', async () => {
    const { h, fetch } = await harness();
    const urls = [];
    let now = 5000000;
    const oauth = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: approvingBrowser(h, { urls }), now: () => now });
    const clientId = await oauth.register();
    assert.match(clientId, /^dcr_/);
    const client = h.clients.list().find((c) => c.client_id === clientId);
    assert.equal(client.client_name, 'King Louie window');
    assert.deepEqual(client.redirect_uris, ['http://127.0.0.1/kl/window/callback']);

    const tokens = await oauth.authorize({ clientId, scope: 'window:attach' });
    assert.equal(typeof tokens.access, 'string');
    assert.equal(typeof tokens.refresh, 'string');
    assert.equal(tokens.expiresAt, now + 3600 * 1000);
    const asked = new URL(urls[0]).searchParams;
    assert.equal(asked.get('code_challenge_method'), 'S256');
    assert.equal(asked.get('resource'), `${ORIGIN}/window/v1`);
    assert.match(asked.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/kl\/window\/callback$/);
    assert.ok(asked.get('state').length >= 32);
    assert.ok(h.tokens.authenticate(tokens.access, { aud: `${ORIGIN}/window/v1` }));

    now += 1000;
    const next = await oauth.refresh({ clientId, refresh: tokens.refresh });
    assert.notEqual(next.access, tokens.access);
    assert.notEqual(next.refresh, tokens.refresh);
    assert.equal(next.expiresAt, now + 3600 * 1000);

    await oauth.revoke({ clientId, token: next.refresh });
    await assert.rejects(oauth.refresh({ clientId, refresh: next.refresh }), (err) => err.code === 'SIGN_IN_AGAIN' && err.tokensDead === true);
  });

  it('a wrong state is refused, and no token is asked for', async () => {
    const { h, fetch } = await harness();
    const posts = [];
    const counting = (url, init) => {
      if (url.endsWith('/oauth/token')) posts.push(url);
      return fetch(url, init);
    };
    const oauth = createWindowOAuth({
      origin: ORIGIN, fetch: counting,
      openBrowser: approvingBrowser(h, { alter: (location) => location.replace(/state=[^&]+/, 'state=wrong') })
    });
    const clientId = await oauth.register();
    await assert.rejects(oauth.authorize({ clientId, scope: 'window:attach' }), { code: 'STATE_MISMATCH' });
    assert.deepEqual(posts, []);
  });

  it('takes one request, then closes; a denial and a wrong issuer are refused', async () => {
    const { fetch } = await harness();
    const hit = (url, change) => {
      const asked = new URL(url).searchParams;
      return new Promise((resolve) => {
        http.get(`${asked.get('redirect_uri')}?${change(asked.get('state'))}`, (res) => { res.resume(); res.on('end', resolve); });
      });
    };
    for (const [query, code] of [
      [(s) => `error=access_denied&state=${s}`, 'ACCESS_DENIED'],
      [(s) => `code=abc&state=${s}&iss=https%3A%2F%2Fother.example.com`, 'ISSUER_MISMATCH'],
      [(s) => `code=abc&code=def&state=${s}`, 'CALLBACK_INVALID']
    ]) {
      let redirect = null;
      const oauth = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: async (url) => { redirect = new URL(url).searchParams.get('redirect_uri'); await hit(url, query); } });
      await assert.rejects(oauth.authorize({ clientId: 'dcr_x', scope: 'window:attach' }), { code });
      await assert.rejects(new Promise((resolve, reject) => { http.get(redirect, resolve).on('error', reject); }), { code: 'ECONNREFUSED' });
    }
  });

  it('says what a 429 in the browser means, and does not open a fourth at all', async () => {
    const { h, fetch } = await harness({ pendingPerIp: 3 });
    const notices = [];
    let opened = 0;
    const browser = approvingBrowser(h);
    const oauth = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: async (url) => { opened += 1; await browser(url); } });
    const clientId = await oauth.register();
    for (let i = 0; i < 3; i += 1) await oauth.authorize({ clientId, scope: 'window:attach', onNotice: (text) => notices.push(text) });
    assert.equal(notices.length, 3);
    assert.match(notices[0], /Try again later/);
    await assert.rejects(oauth.authorize({ clientId, scope: 'window:attach' }), (err) => {
      assert.equal(err.code, 'AUTHORIZE_BUSY');
      assert.match(err.message, /minute/);
      assert.ok(err.retryAfterMs > 0);
      return true;
    });
    assert.equal(opened, 3);
  });

  it('a browser that will not open, a cancel and the flow\'s deadline each close the listener', async () => {
    const { fetch } = await harness();
    const failing = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: async () => { throw new Error('no browser'); } });
    await assert.rejects(failing.authorize({ clientId: 'dcr_x', scope: 'window:attach' }), { code: 'BROWSER_FAILED' });

    const controller = new AbortController();
    const waiting = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: async () => { setImmediate(() => controller.abort()); } });
    await assert.rejects(waiting.authorize({ clientId: 'dcr_x', scope: 'window:attach', signal: controller.signal }), { code: 'CANCELLED' });

    const clock = fakeClock();
    const lapsing = createWindowOAuth({ origin: ORIGIN, fetch, timers: clock, openBrowser: async () => {} });
    const lapse = lapsing.authorize({ clientId: 'dcr_x', scope: 'window:attach' });
    await waitFor(() => clock.delays.includes(10 * 60 * 1000), 'the deadline');
    clock.advance(10 * 60 * 1000);
    await assert.rejects(lapse, { code: 'AUTHORIZE_TIMEOUT' });
  });

  it('invalid_grant while the scope is delisted leaves the tokens alive', async () => {
    const { h, fetch } = await harness();
    const oauth = createWindowOAuth({ origin: ORIGIN, fetch, openBrowser: approvingBrowser(h) });
    const clientId = await oauth.register();
    const tokens = await oauth.authorize({ clientId, scope: 'window:attach' });
    h.oauth.scopesEnabled = FLEET;
    await assert.rejects(oauth.refresh({ clientId, refresh: tokens.refresh }), (err) => {
      assert.equal(err.code, 'WINDOW_RESOURCE_OFF');
      assert.equal(err.tokensDead, false);
      assert.equal(err.hold, true);
      return true;
    });
    // Listed again, the same refresh token still works: no new phone approval.
    h.oauth.scopesEnabled = WITH_WINDOW;
    const next = await oauth.refresh({ clientId, refresh: tokens.refresh });
    assert.ok(next.access);
  });

  it('a network failure and a 500 on refresh say nothing of the tokens', async () => {
    const down = createWindowOAuth({ origin: ORIGIN, fetch: async () => { throw new Error('offline'); }, openBrowser: async () => {} });
    await assert.rejects(down.refresh({ clientId: 'c', refresh: 'r' }), (err) => err.code === 'TOKEN_ENDPOINT_UNREACHABLE' && err.tokensDead === false);
    const broken = createWindowOAuth({ origin: ORIGIN, fetch: async () => ({ status: 500, ok: false, text: async () => '{}' }), openBrowser: async () => {} });
    await assert.rejects(broken.refresh({ clientId: 'c', refresh: 'r' }), (err) => err.code === 'TOKEN_ENDPOINT_UNREACHABLE' && err.tokensDead === false);
    const garbled = createWindowOAuth({ origin: ORIGIN, fetch: async () => ({ status: 200, ok: true, text: async () => '{"access_token":1}' }), openBrowser: async () => {} });
    await assert.rejects(garbled.refresh({ clientId: 'c', refresh: 'r' }), { code: 'TOKEN_MALFORMED' });
  });

  it('refuses an origin that is not https', () => {
    assert.throws(() => createWindowOAuth({ origin: 'http://mcp.kl.example.com', fetch: async () => {}, openBrowser: async () => {} }), /https/);
  });
});
