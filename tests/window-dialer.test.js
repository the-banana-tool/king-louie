// tests/window-dialer.test.js
// Remote window plan, task 6 (R-RW-3, R-RW-20, R-RW-30, R-RW-35, R-RW-36): the node
// dials back to its front door and hands the socket to the bridge server. The far
// end here is this file's own loopback TLS server, never the front door's code.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const WebSocket = require('ws');
const { selfSigned, fingerprint } = require('./helpers/test-certs');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { WindowSeal, RECORD_WIRE_MAX, PRE_READY_BYTES } = require('../src/desktop-bridge/window-seal');
const { createWindowDialer, createWindowHandlers, PENDING_SEALS_MAX } = require('../src/desktop-bridge/window-dialer');
const { createRelayDispatcher } = require('../src/approvals/service-wiring');
const { isReservedMethod, NODE_INBOUND, F3_METHODS } = require('../src/approvals/relay-client');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const WINDOW_METHODS = ['window.open', 'window.enroll_response', 'window.revoke', 'window.list'];
const MESH_HOST = 'mesh.kl.example.com';
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
const nodeRaw = Buffer.from(nodeIdentity.publicKey, 'hex').subarray(-32);
const clientCert = selfSigned({ commonName: 'node' });
const identity = { tlsCert: clientCert.cert, tlsKey: clientCert.key };
const servedCert = selfSigned({ commonName: MESH_HOST });
const cleanups = [];
let nextSession = 0;

after(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitFor = async (fn, what = 'a condition', ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const newSessionId = () => crypto.createHash('sha256').update(`dial ${++nextSession}`).digest('base64url');
const lookup = (hostname, options, callback) => {
  assert.strictEqual(hostname, MESH_HOST);
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};
const pinFor = (port, certPem = servedCert.cert) => ({
  mesh_url: `wss://${MESH_HOST}:${port}/mesh/v1`,
  mesh_cert_fingerprint: fingerprint(certPem)
});

// Every socket it took goes at the end: an upgraded or paused one would hold close().
function closingServer(server) {
  const raw = new Set();
  server.on('connection', (socket) => {
    raw.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => raw.delete(socket));
  });
  cleanups.push(() => new Promise((resolve) => {
    for (const socket of raw) socket.destroy();
    server.close(() => resolve());
  }));
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

// The front door's mesh leg as far as a dial can see: every upgrade and its socket.
async function fakeMesh({ onSocket = null } = {}) {
  const upgrades = [];
  const server = https.createServer({ cert: servedCert.cert, key: servedCert.key, requestCert: true, rejectUnauthorized: false });
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: true });
  server.on('upgrade', (req, socket, head) => {
    const entry = { url: req.url, servername: socket.servername, clientFingerprint: crypto.createHash('sha256').update(socket.getPeerX509Certificate().raw).digest('hex') };
    wss.handleUpgrade(req, socket, head, (peer) => {
      entry.peer = peer;
      upgrades.push(entry);
      if (onSocket) onSocket(peer, entry);
    });
  });
  const port = await closingServer(server);
  cleanups.push(() => { for (const c of wss.clients) c.terminate(); });
  return { port, upgrades };
}

function fakeServer() {
  const attached = [];
  return {
    attached,
    attachSealed({ sessionId, transport }) {
      return new Promise((resolve, reject) => {
        attached.push({ sessionId, transport, resolve, reject });
      });
    }
  };
}

function tempConfig(devices) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dialer-'));
  cleanups.push(() => fs.rmSync(configDir, { recursive: true, force: true }));
  let doc = pairing.emptyDevices();
  for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-11-04T10:00:00Z', remote: true });
  pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
  return configDir;
}

function makeDevice(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), raw, label, privateKey };
}

function realServer({ devices = [], canSeal = () => true, sealedDeps = {} } = {}) {
  const server = new DesktopBridgeServer({
    identity: nodeIdentity,
    configDir: tempConfig(devices),
    port: 0,
    version: '26.11.0',
    adminUid: selfUid,
    account: 'LOCAL SERVICE',
    approvals: { sealPolicy: { canSeal, whyNot: () => 'no active phone holds a box key' } },
    sealedDeps,
    createDispatcher: () => ({
      served: { handle: ['chat:load'], on: [] },
      providersConfigured: () => true,
      async handleFrame() {},
      async onDisconnect() {},
      forwardAmbient() {}
    })
  });
  cleanups.push(() => server.stop());
  return server;
}

function dialerFor(port, server, extra = {}) {
  const dialer = createWindowDialer({ identity, frontDoorPin: pinFor(port), server, lookup, ...extra });
  cleanups.push(() => dialer.stop());
  return dialer;
}

describe('createWindowDialer: the dial', () => {
  it('refuses a served certificate that is not the pin before writing a byte', async () => {
    // Decrypted bytes, on a TLS 1.2 link so the server's side is up before the
    // client's check: under 1.3 the client destroys before the server has a session.
    let bytes = 0;
    let sessions = 0;
    let socketClosed = false;
    const wrong = selfSigned({ commonName: 'not-the-front-door' });
    const server = tls.createServer({ cert: wrong.cert, key: wrong.key, maxVersion: 'TLSv1.2' });
    server.on('secureConnection', (socket) => {
      sessions += 1;
      socket.on('data', (chunk) => { bytes += chunk.length; });
      socket.on('close', () => { socketClosed = true; });
      socket.on('error', () => {});
    });
    const port = await closingServer(server);
    const bridge = fakeServer();
    const dialer = dialerFor(port, bridge);
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId(), expires_at: '2026-11-04T10:00:30Z' }), { ok: true });
    await waitFor(() => socketClosed, 'the dial to give up');
    assert.strictEqual(sessions, 1);
    assert.strictEqual(bytes, 0);
    assert.strictEqual(bridge.attached.length, 0);
    await waitFor(() => dialer.pending() === 0, 'the place to come back');
  });

  it('dials the path with the session id, on its certificate, and hands the socket to attachSealed', async () => {
    const mesh = await fakeMesh();
    const bridge = fakeServer();
    const dialer = dialerFor(mesh.port, bridge);
    const sessionId = newSessionId();
    const answer = await dialer.open({ session_id: sessionId, expires_at: '2026-11-04T10:00:30Z' });
    assert.deepStrictEqual(answer, { ok: true });
    assert.strictEqual(bridge.attached.length, 0, 'answered while the dial is under way');
    await waitFor(() => bridge.attached.length === 1, 'attachSealed');
    assert.strictEqual(bridge.attached[0].sessionId, sessionId);
    await waitFor(() => mesh.upgrades.length === 1, 'the upgrade');
    const [up] = mesh.upgrades;
    assert.strictEqual(up.url, `/window/v1/${sessionId}`);
    assert.strictEqual(up.servername, MESH_HOST);
    assert.strictEqual(up.clientFingerprint, fingerprint(clientCert.cert));

    // The transport is the socket, both ways.
    const heard = [];
    bridge.attached[0].transport.on('data', (data, isBinary) => heard.push({ text: data.toString(), isBinary }));
    const back = new Promise((resolve) => { up.peer.once('message', (data, isBinary) => resolve({ text: data.toString(), isBinary })); });
    await bridge.attached[0].transport.send(Buffer.from('out'));
    assert.deepStrictEqual(await back, { text: 'out', isBinary: true });
    up.peer.send(Buffer.from('in'));
    up.peer.send('words');
    await waitFor(() => heard.length === 2, 'both messages');
    assert.deepStrictEqual(heard, [{ text: 'in', isBinary: true }, { text: 'words', isBinary: false }]);
    bridge.attached[0].resolve({});
  });

  it('builds the socket with SOCKET_OPTIONS: no compression, and maxPayload is the longest record', async () => {
    const mesh = await fakeMesh();
    const bridge = fakeServer();
    const dialer = dialerFor(mesh.port, bridge);
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => bridge.attached.length === 1 && mesh.upgrades.length === 1, 'the dial');
    const { peer } = mesh.upgrades[0];
    assert.strictEqual(peer.extensions, '', 'no permessage-deflate was offered');
    const closed = new Promise((resolve) => { peer.once('close', (code) => resolve(code)); });
    let delivered = 0;
    bridge.attached[0].transport.on('data', () => { delivered += 1; });
    peer.send(Buffer.alloc(RECORD_WIRE_MAX));
    await waitFor(() => delivered === 1, 'the longest record');
    peer.send(Buffer.alloc(RECORD_WIRE_MAX + 1));
    assert.strictEqual(await closed, 1009);
    assert.strictEqual(delivered, 1);
    bridge.attached[0].resolve({});
  });

  it('wraps the socket in the tick it opens: a message that came with the 101 is not lost', async () => {
    const server = https.createServer({ cert: servedCert.cert, key: servedCert.key });
    server.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const frame = Buffer.from([0x82, 0x03, 0x61, 0x62, 0x63]);
      socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), frame]));
    });
    const port = await closingServer(server);
    const heard = [];
    let readyState = null;
    const bridge = {
      attachSealed({ transport }) {
        transport.on('data', (data) => heard.push(data.toString()));
        return new Promise(() => {});
      }
    };
    const realOpen = WebSocket.prototype.emit;
    WebSocket.prototype.emit = function emit(name, ...rest) {
      if (name === 'open') readyState = this.readyState;
      return realOpen.call(this, name, ...rest);
    };
    cleanups.push(() => { WebSocket.prototype.emit = realOpen; });
    const dialer = dialerFor(port, bridge);
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => heard.length === 1, 'the message that came with the 101');
    WebSocket.prototype.emit = realOpen;
    assert.deepStrictEqual(heard, ['abc']);
    assert.strictEqual(readyState, WebSocket.OPEN);
  });

  it('a rejected or throwing attachSealed is caught: nothing goes unhandled, and the place comes back', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const mesh = await fakeMesh();
      const rejecting = dialerFor(mesh.port, {
        attachSealed: () => Promise.reject(Object.assign(new Error('handshake'), { code: 'handshake', closeCode: 4401 }))
      });
      await rejecting.open({ session_id: newSessionId() });
      await waitFor(() => rejecting.pending() === 0, 'the rejection');
      const throwing = dialerFor(mesh.port, { attachSealed: () => { throw new Error('no'); } });
      await throwing.open({ session_id: newSessionId() });
      await waitFor(() => throwing.pending() === 0, 'the throw');
      // And the real one, on a hostile peer's handshake.
      const hostile = await fakeMesh({ onSocket: (peer) => peer.send(Buffer.alloc(3)) });
      const real = dialerFor(hostile.port, realServer());
      await real.open({ session_id: newSessionId() });
      await waitFor(() => real.pending() === 0, 'the failed handshake');
      await delay(20);
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a session id that is not the canonical form, with no dial', async () => {
    let dialed = 0;
    const server = net.createServer((socket) => { dialed += 1; socket.destroy(); });
    const port = await closingServer(server);
    const dialer = dialerFor(port, fakeServer());
    const good = newSessionId();
    // 'B' as the 43rd character leaves trailing bits set: not canonical.
    for (const bad of [undefined, 42, '', '../../mcp', 'a'.repeat(44), `${good.slice(0, 42)}/`, `${good.slice(0, 42)}B`]) {
      const answer = await dialer.open({ session_id: bad });
      assert.deepStrictEqual(answer, { ok: false, code: 'invalid_session' }, String(bad));
    }
    await delay(30);
    assert.strictEqual(dialed, 0);
    assert.strictEqual(dialer.pending(), 0);
  });

  it('a dial nobody answers gives up at timeoutMs and frees its place', async () => {
    let farEndClosed = false;
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('close', () => { farEndClosed = true; });
      socket.resume();
    });
    const port = await closingServer(server);
    const dialer = dialerFor(port, fakeServer(), { timeoutMs: 80 });
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: true });
    assert.strictEqual(dialer.pending(), 1);
    await waitFor(() => dialer.pending() === 0, 'the timeout');
    await waitFor(() => farEndClosed, 'the far end to see it go');
  });

  it('an upgrade the front door refuses frees its place and never reaches attachSealed', async () => {
    const server = https.createServer({ cert: servedCert.cert, key: servedCert.key }, (req, res) => { res.statusCode = 404; res.end(); });
    server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    const port = await closingServer(server);
    const bridge = fakeServer();
    const dialer = dialerFor(port, bridge);
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => dialer.pending() === 0, 'the refusal');
    assert.strictEqual(bridge.attached.length, 0);
  });
});

describe('createWindowDialer: the seals not yet ready (R-RW-36)', () => {
  it('holds at most PENDING_SEALS_MAX from window.open until ready, and answers too_many_windows past it', async () => {
    assert.ok(PENDING_SEALS_MAX > 0 && PENDING_SEALS_MAX <= 8, 'a small cap');
    const mesh = await fakeMesh();
    const bridge = fakeServer();
    const dialer = dialerFor(mesh.port, bridge);
    // Counted from the call: none of these has dialled yet when the next one asks.
    const answers = await Promise.all(Array.from({ length: PENDING_SEALS_MAX }, () => dialer.open({ session_id: newSessionId() })));
    assert.ok(answers.every((a) => a.ok === true));
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: false, code: 'too_many_windows' });
    await waitFor(() => bridge.attached.length === PENDING_SEALS_MAX, 'every dial');
    assert.strictEqual(mesh.upgrades.length, PENDING_SEALS_MAX, 'the refused one made no connection');
    // Still counted while the seal has not been ready.
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: false, code: 'too_many_windows' });

    bridge.attached[0].resolve({});
    await waitFor(() => dialer.pending() === PENDING_SEALS_MAX - 1, 'ready to free a place');
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: true });
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: false, code: 'too_many_windows' });

    bridge.attached[1].reject(Object.assign(new Error('handshake'), { code: 'handshake', closeCode: 4408 }));
    await waitFor(() => dialer.pending() === PENDING_SEALS_MAX - 1, 'a failed seal to free a place');
    await waitFor(() => bridge.attached.length === PENDING_SEALS_MAX + 1, 'the last dial');
    for (const a of bridge.attached) a.resolve({});
  });

  it('a seal past its deadline frees its place: the real server, the seal\'s own timer', async () => {
    const mesh = await fakeMesh();
    let fire = null;
    const server = realServer({ sealedDeps: { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} } });
    const dialer = dialerFor(mesh.port, server);
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => fire, 'the seal to be built');
    assert.strictEqual(dialer.pending(), 1);
    fire();
    await waitFor(() => dialer.pending() === 0, 'the deadline to free the place');
  });

  it('stop() aborts a dial under way, and a later open is remote_window_off', async () => {
    const sockets = [];
    const server = net.createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); });
    const port = await closingServer(server);
    const dialer = dialerFor(port, fakeServer());
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => sockets.length === 1, 'the connection');
    dialer.stop();
    assert.strictEqual(dialer.pending(), 0);
    assert.deepStrictEqual(await dialer.open({ session_id: newSessionId() }), { ok: false, code: 'remote_window_off' });
  });
});

describe('the dial with the real bridge server', () => {
  function windowOn(peer, sessionId, device) {
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
    seal.next(null);
    return { received, seal };
  }

  it('a known remote device reaches ready through the dial', async () => {
    const device = makeDevice('laptop');
    const sessionId = newSessionId();
    let window = null;
    const mesh = await fakeMesh({ onSocket: (peer) => { window = windowOn(peer, sessionId, device); } });
    const server = realServer({ devices: [device] });
    const dialer = dialerFor(mesh.port, server);
    await dialer.open({ session_id: sessionId });
    await waitFor(() => window && window.received.some((f) => f.t === 'ready'), 'the ready frame');
    assert.deepStrictEqual(server.connected.map((c) => [c.deviceId, c.remote]), [[device.deviceId, true]]);
    await waitFor(() => dialer.pending() === 0, 'a ready seal to hold no place');
    assert.strictEqual(server.wss, null, 'and nothing listens');
  });

  it('a text frame before ready closes the socket', async () => {
    const closes = [];
    const mesh = await fakeMesh({ onSocket: (peer) => { peer.on('close', (code) => closes.push(code)); peer.send('hello'); } });
    const dialer = dialerFor(mesh.port, realServer());
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => closes.length === 1, 'the close');
    assert.strictEqual(closes[0], 4401);
    await waitFor(() => dialer.pending() === 0, 'the place');
  });

  it('cuts the socket once PRE_READY_BYTES have arrived before ready', async () => {
    const closes = [];
    const mesh = await fakeMesh({ onSocket: (peer) => {
      peer.on('close', (code) => closes.push(code));
      peer.on('error', () => {});
      peer.send(Buffer.alloc(PRE_READY_BYTES + 1));
    } });
    const dialer = dialerFor(mesh.port, realServer());
    await dialer.open({ session_id: newSessionId() });
    await waitFor(() => closes.length === 1, 'the cut');
    await waitFor(() => dialer.pending() === 0, 'the place');
  });
});

describe('createWindowHandlers: window.open', () => {
  it('refuses node_not_sealing unless canSeal() holds, with a plain line and no dial (R-RW-30)', async () => {
    for (const canSeal of [() => false, () => 'yes', () => { throw new Error('unreadable'); }]) {
      let opened = 0;
      const handlers = createWindowHandlers({ server: realServer({ canSeal }), dialer: { open: async () => { opened += 1; return { ok: true }; } } });
      const answer = await handlers['window.open']({ session_id: newSessionId() });
      assert.strictEqual(answer.ok, false);
      assert.strictEqual(answer.code, 'node_not_sealing');
      assert.match(answer.message, /box key/);
      assert.doesNotMatch(answer.message, /\n/);
      assert.strictEqual(opened, 0);
    }
  });

  it('passes to the dialer when the node can seal', async () => {
    const params = { session_id: newSessionId(), expires_at: '2026-11-04T10:00:30Z' };
    const seen = [];
    const handlers = createWindowHandlers({ server: realServer(), dialer: { open: async (p) => { seen.push(p); return { ok: true }; } } });
    assert.deepStrictEqual(await handlers['window.open'](params), { ok: true });
    assert.deepStrictEqual(seen, [params]);
  });
});

describe('the window.* link methods', () => {
  const dispatcherWith = (windowHandlers) => createRelayDispatcher({ phoneApprover: {}, approverStore: {}, auditLedger: {}, windowHandlers });

  it('are the relay client\'s own', () => {
    for (const method of WINDOW_METHODS) {
      assert.ok(F3_METHODS.has(method), method);
      assert.ok(NODE_INBOUND.includes(method), method);
      assert.ok(isReservedMethod(method), method);
    }
  });

  it('answer remote_window_off with the feature off', async () => {
    for (const windowHandlers of [undefined, () => null]) {
      const dispatch = dispatcherWith(windowHandlers);
      for (const method of WINDOW_METHODS) {
        assert.deepStrictEqual(await dispatch(method, { session_id: 'x' }), { ok: false, code: 'remote_window_off' }, method);
      }
    }
  });

  it('go to the handlers when the server exists; a method with none is off', async () => {
    const seen = [];
    let handlers = { 'window.open': async (params) => { seen.push(params); return { ok: true }; } };
    const dispatch = dispatcherWith(() => handlers);
    assert.deepStrictEqual(await dispatch('window.open', { session_id: 'x' }), { ok: true });
    assert.deepStrictEqual(seen, [{ session_id: 'x' }]);
    assert.deepStrictEqual(await dispatch('window.list', {}), { ok: false, code: 'remote_window_off' });
    handlers = null;
    assert.deepStrictEqual(await dispatch('window.open', {}), { ok: false, code: 'remote_window_off' });
  });
});
