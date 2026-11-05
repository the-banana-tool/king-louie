// The desktop bridge listener (fleet stage 7 §3.3, §3.4): loopback only,
// separate from the gateway, mutual Ed25519 authentication against a device
// an administrator paired. The server proves itself first. A remote window comes
// the other way: attachSealed takes a transport a dialer opened, in-process, and
// runs window-v1 over it, with no socket of this server's. A device's record says
// which of the two it may use (R-RW-15).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const {
  PROTOCOL, DEFAULT_DESKTOP_BRIDGE_PORT, LIMITS, CLOSE, DEVICE_ID_RE, NONCE_RE,
  newNonce, buildAuthS, buildAuthC, parseFrame, peekFrameId, truncateUtf8, BridgeError, MESSAGES
} = require('./protocol');
const { DEVICES_FILE, DEVICES_CONTROLS, parseDevices, findDevice } = require('./pairing');
const { fromB64url, toB64url, verifyWithRawKey } = require('./keys');
const { WindowSeal, createFrameSender, startHeartbeat } = require('./window-seal');
const { createConnection } = require('./connection');
const { currentConnection } = require('./run-context');

const log = createLogger('desktop-bridge');
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);
const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
// A last-resort bound: stop() must not hang forever on a stuck dispatcher
// cleanup (a wedged chat:stopResponse handler, say). It resolves anyway,
// bounded, rather than leaving the process unable to exit.
const DEFAULT_DISCONNECT_CLEANUP_MS = 5000;
const NOT_SEALING = 'node_not_sealing';
const NOT_REMOTE = 'not_remote';
const TOO_MANY = 'too_many_windows';
const STOPPING = 'service_stopping';
const SLOW_READER = 'slow reader';

function currentAccount() {
  try {
    return os.userInfo().username;
  } catch {
    return 'the service account';
  }
}

class DesktopBridgeServer extends EventEmitter {
  constructor({
    core = null, identity, cipher = null, configDir, dataDir = null,
    port = DEFAULT_DESKTOP_BRIDGE_PORT, host = '127.0.0.1', version = null,
    geteuid = defaultGeteuid, adminUid = 0, approvals = null, profile = 'agent', hosting = 'service',
    account = currentAccount(), createDispatcher = null, limits = {}, now = Date.now, sealedDeps = {}
  } = {}) {
    super();
    if (host !== '127.0.0.1') throw new Error('DesktopBridgeServer binds only to 127.0.0.1');
    if (!identity || typeof identity.sign !== 'function') throw new Error('DesktopBridgeServer needs the node identity');
    if (!configDir) throw new Error('DesktopBridgeServer needs configDir');
    this.identity = identity;
    this.configDir = configDir;
    this.port = port;
    this.host = host;
    this.version = version;
    this.geteuid = geteuid;
    this.adminUid = adminUid;
    this.profile = profile;
    this.hosting = hosting;
    this.account = account;
    this.now = now;
    this.approvals = approvals;
    // Injected clocks for a sealed session's deadline and heartbeat (tests).
    this.sealedDeps = sealedDeps;
    this.limits = { ...LIMITS, ...limits };
    this.wss = null;
    // deviceId -> its one connection, oldest first (a device attaching again goes last).
    this.connections = new Map();
    this.preAuth = [];
    this.sockets = new Set();
    // Every sealed session from attachSealed until it is closed and no frame of its
    // is still running: a device dropped with an approval pending can yet be revoked.
    this.sealedSessions = new Set();
    this.stopped = false;
    this.failures = new Map();
    this.lockouts = new Map();
    this.recheckTimer = null;
    // conn -> the promise of its dispatcher.onDisconnect cleanup (aborting
    // that connection's runs, denying its prompts). Keyed on the connection
    // object rather than a flag on it: `conn.cleaned` is the dispatcher's own
    // idempotency guard (tests/desktop-bridge-dispatcher.test.js drives
    // onDisconnect directly, without going through this server, so it must
    // stay meaningful on its own). Deduping here too, on a key the dispatcher
    // never touches, means _onClose and stop() can both call _disconnectOnce
    // for the same conn without the second call re-running the dispatcher's
    // cleanup — and, unlike a flag the dispatcher sets internally, this map
    // also hands back the one promise to await regardless of which call
    // first created it. A WeakMap: once a connection is gone and nothing else
    // references it, its entry (and the conn object itself) can be collected
    // instead of sitting in this map for the life of the server.
    this.disconnectPromises = new WeakMap();
    this.disconnectCleanupMs = this.limits.disconnectCleanupMs ?? DEFAULT_DISCONNECT_CLEANUP_MS;
    const factory = createDispatcher || ((opts) => require('./bridge-dispatcher').createBridgeDispatcher(opts));
    this.dispatcher = factory({
      core, cipher, dataDir, approvals, account, hosting,
      getServiceInfo: () => this.serviceInfo(),
      getConnections: () => [...this.connections.values()],
      // A run's own window, gone or not: a gone one is asked nothing, and its
      // run never borrows another device's. Only a prompt with no run behind
      // it goes to the oldest local window.
      getConnection: () => currentConnection() || this._oldestLocal()
    });
  }

  get connected() {
    return [...this.connections.values()].filter((c) => c.live).map((c) => ({ deviceId: c.deviceId, label: c.label, remote: c.remote }));
  }

  _oldestLocal() {
    for (const conn of this.connections.values()) {
      if (conn.live && !conn.remote) return conn;
    }
    return null;
  }

  serviceInfo() {
    const served = this.dispatcher.served;
    return {
      version: this.version,
      protocol: PROTOCOL,
      nodeId: this.identity.nodeId,
      nodeName: this.identity.nodeName || null,
      account: this.account,
      profile: this.profile,
      hosting: this.hosting,
      providersConfigured: Boolean(this.dispatcher.providersConfigured()),
      channels: [...served.handle, ...served.on]
    };
  }

  async start() {
    if (this.wss) return { port: this.port };
    this.stopped = false;
    this.wss = new WebSocket.Server({
      host: this.host,
      port: this.port,
      maxPayload: this.limits.wsMaxPayload,
      perMessageDeflate: false,
      // Presence, not truthiness: any Origin header means a browser.
      verifyClient: ({ req }, done) => ('origin' in req.headers ? done(false, 403, 'Forbidden') : done(true))
    });
    this.wss.on('connection', (ws) => this._onConnection(ws));
    this.wss.on('error', (err) => log.error(`desktop bridge error: ${err.message}`));
    try {
      await new Promise((resolve, reject) => {
        this.wss.once('listening', resolve);
        this.wss.once('error', reject);
      });
    } catch (err) {
      this.wss = null;
      throw new Error(`desktop bridge could not bind 127.0.0.1:${this.port}: ${err.message}`);
    }
    this.port = this.wss.address().port;
    const httpServer = this.wss._server;
    if (httpServer) {
      httpServer.headersTimeout = this.limits.headersTimeoutMs;
      httpServer.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
    }
    this._armRecheck();
    log.info(`desktop bridge listening on 127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  forwardAmbient(channel, payload) {
    this.dispatcher.forwardAmbient(channel, payload);
  }

  _armRecheck() {
    if (this.recheckTimer) return;
    this.recheckTimer = setInterval(() => this._recheckLive(), this.limits.deviceRecheckMs);
    this.recheckTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    // A node with only features.remoteWindow never listened and still has sessions.
    if (!this.wss && this.sealedSessions.size === 0 && !this.recheckTimer) return;
    clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    const conns = [...this.connections.values()];
    // Kick off (or pick up) each connection's disconnect cleanup right away,
    // concurrently with tearing down its socket below, rather than waiting
    // for the 'close' event to get around to it.
    const disconnectDone = Promise.all(conns.map((conn) => this._disconnectOnce(conn)));
    for (const conn of conns) {
      conn.send({ t: 'bye', code: 'SERVICE_STOPPING' });
      conn.close(CLOSE.GOING_AWAY, 'service stopping');
    }
    for (const state of [...this.sealedSessions]) this._endSealed(state, CLOSE.GOING_AWAY, STOPPING);
    for (const ws of this.sockets) {
      try { ws.close(CLOSE.GOING_AWAY, 'service stopping'); } catch { /* gone */ }
    }
    const allClosed = Promise.all([...this.sockets].map((ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    })));
    await Promise.race([allClosed, delay(500)]);
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* gone */ }
    }
    // Every run a window started, and every prompt it was shown, must be
    // aborted/denied before stop() resolves — otherwise a caller that exits
    // right after stop() (or reuses the port) can race that cleanup. Bounded
    // so a wedged handler (e.g. a stuck chat:stopResponse) cannot hang
    // shutdown forever.
    await Promise.race([disconnectDone, delay(this.disconnectCleanupMs)]);
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise((resolve) => wss.close(() => resolve()));
    this.connections.clear();
    this.sealedSessions.clear();
  }

  _onConnection(ws) {
    const state = { ws, stage: 'hello', serverNonce: newNonce(), clientNonce: null, deviceId: null, device: null, conn: null, timers: [], preAuthBytes: 0 };
    this.sockets.add(ws);
    this.preAuth.push(state);
    while (this.preAuth.length > this.limits.maxPreAuthSockets) {
      this._close(this.preAuth[0], CLOSE.TRY_AGAIN, 'too many pending handshakes');
    }
    state.firstFrame = setTimeout(() => this._close(state, CLOSE.MALFORMED, 'no first frame'), this.limits.firstFrameMs);
    state.timers.push(state.firstFrame, setTimeout(() => this._close(state, CLOSE.MALFORMED, 'handshake timed out'), this.limits.handshakeMs));
    // Counts raw bytes off the TCP stream, independent of ws's own frame
    // reassembly, so an oversized pre-auth frame is cut off while it is
    // still arriving rather than after `ws` has buffered the whole thing
    // (its own maxPayload is the much larger post-auth limit at this point).
    // Built for ws 8.20.0's `_socket` (see the "ws internals" test below);
    // if that field disappears, this silently stops enforcing the budget
    // early (the post-auth-stage frameBytes check still catches it late).
    // Keeps counting even once 'closed' — pause()/terminate() below should
    // stop further reads, but if they somehow don't, this is the backstop
    // that keeps re-issuing the kill rather than trusting it happened once.
    state.onRawData = (chunk) => {
      if (state.stage === 'ready') return;
      state.preAuthBytes += chunk.length;
      if (state.preAuthBytes > this.limits.preAuthSocketBytes) this._killOversizedPreAuth(state);
    };
    if (ws._socket && typeof ws._socket.on === 'function') ws._socket.on('data', state.onRawData);
    ws.on('message', (data, isBinary) => {
      Promise.resolve()
        .then(() => this._onMessage(state, data, isBinary))
        .catch((err) => this._onFrameError(state, data, isBinary, err));
    });
    ws.on('close', () => this._onClose(state));
    ws.on('error', (err) => log.debug(`desktop bridge socket error: ${err.message}`));
    this._sendRaw(ws, { t: 'challenge', protocol: PROTOCOL, nodeId: this.identity.nodeId, serverNonce: state.serverNonce });
  }

  _onMessage(state, data, isBinary) {
    if (state.stage === 'ready') return this._onReadyFrame(state, data, isBinary);
    if (state.stage === 'closed') return undefined;
    clearTimeout(state.firstFrame);
    if (isBinary) return this._close(state, CLOSE.MALFORMED, 'binary frame');
    const parsed = parseFrame(data, this.limits.preAuthFrameBytes);
    if (parsed.error) return this._close(state, CLOSE.MALFORMED, parsed.error);
    if (state.stage === 'hello') return this._onClientHello(state, parsed.frame);
    return this._onAuth(state, parsed.frame);
  }

  // The backstop for anything _onMessage's handlers don't catch themselves
  // (see the C1 fix). Before auth, any failure is still an untrusted,
  // unauthenticated connection, so closing 4400 is correct and matches every
  // other malformed-input path. After auth, this is the owner's paired
  // desktop: a bug in the dispatcher (or in _send) must not kill its
  // connection or abort its in-flight runs. Answer the specific call when
  // its id can be recovered and leave the socket open.
  _onFrameError(state, data, isBinary, err) {
    log.warn(`desktop bridge frame failed: ${err && err.message}`);
    if (state.stage !== 'ready') {
      this._close(state, CLOSE.MALFORMED, 'internal error');
      return;
    }
    const conn = state.conn;
    if (!conn || !conn.live || isBinary) return;
    const id = peekFrameId(Buffer.isBuffer(data) ? data.subarray(0, 256).toString('utf8') : String(data).slice(0, 256));
    if (id !== null) conn.send({ t: 'result', id, error: 'Internal error', code: 'INTERNAL_ERROR' });
  }

  _onClientHello(state, frame) {
    if (frame.t !== 'clientHello') return this._close(state, CLOSE.MALFORMED, 'expected clientHello');
    if (frame.protocol !== PROTOCOL) return this._close(state, CLOSE.PROTOCOL_MISMATCH, String(PROTOCOL));
    // Every field is type-checked before it reaches a regex: `frame` is
    // attacker-controlled JSON, and `String()` on an object with a
    // non-callable `toString` throws synchronously (that throw used to
    // escape the ws 'message' listener and kill the process — see the
    // "internal error" catch in _onConnection, kept as a backstop).
    if (typeof frame.deviceId !== 'string' || typeof frame.clientNonce !== 'string'
      || !DEVICE_ID_RE.test(frame.deviceId) || !NONCE_RE.test(frame.clientNonce)) {
      return this._close(state, CLOSE.MALFORMED, 'malformed clientHello');
    }
    // Lockout is decided in _onAuth, once we know whether the signature was
    // actually valid: a claimed device id is public, not secret, so refusing
    // it here would let anyone on the machine lock out the real owner by
    // spamming failures for the owner's id. Ed25519 can't be brute-forced,
    // so nothing is gained by refusing the clientHello itself.
    // A remote record has no loopback path, and is told what a stranger is told.
    const device = this._lookupDevice(frame.deviceId);
    if (!device || device.remote === true) {
      this._recordFailure(frame.deviceId);
      return this._close(state, CLOSE.UNKNOWN_DEVICE, 'unknown device');
    }
    state.deviceId = frame.deviceId;
    state.device = device;
    state.clientNonce = frame.clientNonce;
    state.stage = 'auth';
    const sig = this.identity.sign(Buffer.from(buildAuthS(this._fields(state)), 'utf8'));
    this._sendRaw(state.ws, { t: 'hello', sig: Buffer.from(sig).toString('base64url') });
    return undefined;
  }

  _onAuth(state, frame) {
    if (frame.t !== 'auth' || typeof frame.sig !== 'string') return this._close(state, CLOSE.MALFORMED, 'expected auth');
    let sig;
    try { sig = fromB64url(frame.sig); } catch { sig = Buffer.alloc(0); }
    const raw = fromB64url(state.device.publicKey);
    const valid = verifyWithRawKey(raw, Buffer.from(buildAuthC(this._fields(state)), 'utf8'), sig);
    if (!valid) {
      // A valid signature is never refused by lockout (see _onClientHello);
      // only a failing attempt for an already-locked-out id is refused
      // (closed 4429 at once; nothing is delayed).
      if (this._lockedOut(state.deviceId)) return this._close(state, CLOSE.LOCKED_OUT, 'too many failed handshakes');
      this._recordFailure(state.deviceId);
      return this._close(state, CLOSE.BAD_SIGNATURE, 'signature invalid');
    }
    // Re-read: an unpair between clientHello and auth wins.
    const device = this._lookupDevice(state.deviceId);
    if (!device || device.remote === true) return this._close(state, CLOSE.UNKNOWN_DEVICE, 'unknown device');
    // One connection per device: attaching again takes its own place.
    const old = this.connections.get(state.deviceId);
    if (!old && this.connections.size >= this.limits.maxDevices) return this._close(state, CLOSE.TOO_MANY_WINDOWS, 'too many windows');
    this._removePreAuth(state);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this.failures.delete(state.deviceId);
    this.lockouts.delete(state.deviceId);
    if (old) {
      this.connections.delete(state.deviceId);
      old.markGone();
      old.close(CLOSE.NORMAL, 'replaced by a new connection');
    }
    state.stage = 'ready';
    const conn = createConnection({
      deviceId: device.deviceId,
      label: device.label,
      send: (obj) => this._send(state.ws, obj),
      close: (code, reason) => { try { state.ws.close(code, truncateUtf8(reason, 123)); } catch { /* gone */ } }
    });
    state.conn = conn;
    this.connections.set(conn.deviceId, conn);
    this._sendRaw(state.ws, { t: 'ready', service: this.serviceInfo() });
    log.info(`desktop "${device.label}" (${device.deviceId}) attached`);
    this.emit('connected', { deviceId: conn.deviceId, label: conn.label });
    return undefined;
  }

  async _onReadyFrame(state, data, isBinary) {
    const conn = state.conn;
    if (!conn || !conn.live || isBinary) return;
    if (data.length > this.limits.frameBytes) {
      const id = peekFrameId(data.subarray(0, 256).toString('utf8'));
      log.warn(`desktop sent a ${data.length}-byte frame; refused`);
      if (id !== null) conn.send({ t: 'result', id, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    const parsed = parseFrame(data, this.limits.frameBytes);
    if (parsed.error) {
      log.warn('dropped a malformed frame from the desktop');
      const id = peekFrameId(data.subarray(0, 256).toString('utf8'));
      if (id !== null) conn.send({ t: 'result', id, error: 'Malformed request', code: 'MALFORMED_REQUEST' });
      return;
    }
    await this.dispatcher.handleFrame(conn, parsed.frame);
  }

  _onClose(state) {
    this.sockets.delete(state.ws);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this._removePreAuth(state);
    state.stage = 'closed';
    if (state.onRawData && state.ws._socket) {
      try { state.ws._socket.removeListener('data', state.onRawData); } catch { /* gone */ }
    }
    const conn = state.conn;
    if (!conn) return;
    state.conn = null;
    if (this.connections.get(conn.deviceId) === conn) this.connections.delete(conn.deviceId);
    conn.markGone();
    this._disconnectOnce(conn);
    log.info(`desktop "${conn.label}" disconnected`);
    this.emit('disconnected', { deviceId: conn.deviceId, label: conn.label });
  }

  // stop() and _onClose both lead here for a live connection (stop()
  // closes its socket, which then emits 'close' too); disconnectPromises
  // dedupes by the conn object so dispatcher.onDisconnect still runs exactly
  // once, and both callers can await the same settled-when-cleanup-is-done
  // promise it returns.
  _disconnectOnce(conn) {
    let promise = this.disconnectPromises.get(conn);
    if (!promise) {
      promise = Promise.resolve(this.dispatcher.onDisconnect(conn)).catch((err) => log.warn(`desktop disconnect cleanup failed: ${err.message}`));
      this.disconnectPromises.set(conn, promise);
    }
    return promise;
  }

  _fields(state) {
    return { nodeId: this.identity.nodeId, deviceId: state.deviceId, port: this.port, serverNonce: state.serverNonce, clientNonce: state.clientNonce };
  }

  // What goes on the wire for this frame; null for one too large to send at all.
  _frameText(obj) {
    const text = JSON.stringify(obj);
    if (Buffer.byteLength(text) <= this.limits.frameBytes) return text;
    if (obj.t !== 'result') {
      log.warn(`dropped an oversized ${obj.t} frame${obj.channel ? ` on ${obj.channel}` : ''}`);
      return null;
    }
    return JSON.stringify({ t: 'result', id: obj.id, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  _send(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const text = this._frameText(obj);
    if (text === null) return false;
    ws.send(text);
    return true;
  }

  _sendRaw(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  _close(state, code, reason) {
    if (state.stage === 'closed') return undefined;
    state.stage = 'closed';
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this._removePreAuth(state);
    try { state.ws.close(code, truncateUtf8(reason, 123)); } catch { /* gone */ }
    const kill = setTimeout(() => { try { state.ws.terminate(); } catch { /* gone */ } }, 1000);
    kill.unref?.();
    return undefined;
  }

  // Unlike _close, no 1 s grace window: the socket is actively being fed an
  // oversized pre-auth frame, so every extra millisecond before terminate()
  // lets more of it be read off the wire. pause() stops the socket's own
  // reads (so no further 'data' chunks arrive), then terminate() tears the
  // connection down immediately; queuing the close frame first is what gives
  // a well-behaved client a chance to see the 4400 before that happens.
  // Safe to call more than once (the onRawData backstop may re-trigger it).
  _killOversizedPreAuth(state) {
    const first = state.stage !== 'closed';
    state.stage = 'closed';
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this._removePreAuth(state);
    if (first) {
      try { state.ws.close(CLOSE.MALFORMED, truncateUtf8('oversized frame', 123)); } catch { /* gone */ }
    }
    try { if (state.ws._socket) state.ws._socket.pause(); } catch { /* gone */ }
    try { state.ws.terminate(); } catch { /* gone */ }
  }

  _removePreAuth(state) {
    const i = this.preAuth.indexOf(state);
    if (i !== -1) this.preAuth.splice(i, 1);
  }

  _lookupDevice(deviceId) {
    const file = path.join(this.configDir, DEVICES_FILE);
    try {
      if (!fs.existsSync(file)) return null;
      assertAdminOwned(file, this.geteuid, this.adminUid, DEVICES_CONTROLS);
      return findDevice(parseDevices(fs.readFileSync(file, 'utf8')), deviceId);
    } catch (err) {
      log.error(`refusing desktop handshakes: ${err.message}`);
      return null;
    }
  }

  // A record a connection may still stand on: remote for a remote one, not for a
  // local one. An answer the read cannot give is no record: closed, and revoked.
  _standsOn(conn) {
    const device = this._lookupDevice(conn.deviceId);
    if (!device) return false;
    return conn.remote ? device.remote === true : device.remote !== true;
  }

  _recheckLive() {
    for (const conn of [...this.connections.values()]) {
      if (this._standsOn(conn)) continue;
      log.info(`desktop ${conn.deviceId} is no longer paired; closing it`);
      if (conn.remote) this._revoke(conn);
      conn.close(CLOSE.UNKNOWN_DEVICE, 'unpaired');
    }
    // Gone from the map and still at work: a drop runs what was approved, unless the
    // device is revoked before the approval comes (R-RW-31).
    for (const state of [...this.sealedSessions]) {
      if (state.stage === 'closed' && state.conn && !state.conn.revoked && !this._standsOn(state.conn)) this._revoke(state.conn);
    }
    if (this.sealedSessions.size === 0 || !this._sealRefusal()) return;
    for (const state of [...this.sealedSessions]) {
      if (state.stage === 'ready') this._endSealed(state, CLOSE.NOT_REMOTE, NOT_SEALING, { record: true });
    }
  }

  _revoke(conn) {
    conn.revoke();
    try {
      this.dispatcher.onRevoke?.(conn);
    } catch (err) {
      log.warn(`desktop revoke cleanup failed: ${err.message}`);
    }
  }

  // No session without a seal to phones (R-RW-30): phone-class arguments would cross
  // the relay in clear. Enforced here on the way in, at ready and on every re-read;
  // window.open asks first (Task 6). Anything but a plain yes is no, and a node
  // built with no approvals has no policy to ask.
  _sealRefusal() {
    try {
      return this.approvals?.sealPolicy?.canSeal() === true ? null : NOT_SEALING;
    } catch {
      return NOT_SEALING;
    }
  }

  // Takes a transport a dialer opened (`wsTransport`, sealed-socket.js), `{ send(bytes)
  // -> Promise, close(code, reason), terminate?(), on('data' | 'close' | 'raw') }`, and
  // runs the node's side of window-v1 over it. `data` is one message and its isBinary;
  // a text frame is refused. `send` settles when the socket has taken the bytes, as
  // ws's callback says: that is the backpressure, and a transport that never settles
  // gets no more than the sender's high water. `raw` is bytes off the wire, cut at
  // preAuthSocketBytes before ready. A socket's close code is never read: it is not
  // authenticated, so every socket close is a drop and only the re-read revokes.
  // Ends in the conn, or rejects with `code` (the close reason) and `closeCode`
  // after closing the transport.
  attachSealed({ sessionId, transport } = {}) {
    if (!transport || typeof transport.send !== 'function' || typeof transport.close !== 'function' || typeof transport.on !== 'function') {
      return Promise.reject(new TypeError('attachSealed needs a transport'));
    }
    return new Promise((resolve, reject) => {
      const state = {
        transport, stage: 'handshake', seal: null, sender: null, heartbeat: null, conn: null,
        inFlight: 0, preReadyBytes: 0, resolve, reject
      };
      const refusal = this.stopped ? [CLOSE.GOING_AWAY, STOPPING] : (this._sealRefusal() && [CLOSE.NOT_REMOTE, NOT_SEALING]);
      if (refusal) {
        this._endSealed(state, refusal[0], refusal[1]);
        return;
      }
      try {
        state.seal = WindowSeal.node({
          sessionId,
          identity: {
            nodeId: this.identity.nodeId,
            // The identity holds DER SPKI hex: the raw key is its last 32 bytes.
            publicKey: Buffer.from(this.identity.publicKey, 'hex').subarray(-32),
            sign: (bytes) => this.identity.sign(bytes)
          },
          // A local record's key too: the handshake proves the key, and the path is
          // judged at ready, so only the key's holder learns its record is local.
          lookupDevice: (deviceId) => {
            const device = this._lookupDevice(deviceId);
            return device ? fromB64url(device.publicKey) : null;
          },
          // The seal's one writer: every record reaches the socket in the tick it was
          // sealed, and it watches each write. Its own deadline and a failed write
          // come back through onClose.
          write: (bytes) => {
            state.heartbeat?.sent();
            return state.transport.send(bytes);
          },
          onClose: ({ code, reason }) => this._endSealed(state, code, reason),
          setTimer: this.sealedDeps.setTimer,
          clearTimer: this.sealedDeps.clearTimer
        });
      } catch (err) {
        log.warn(`a sealed connection could not start: ${err.code || err.message}`);
        this._endSealed(state, CLOSE.BAD_SIGNATURE, 'handshake');
        return;
      }
      this.sealedSessions.add(state);
      this._armRecheck();
      const pending = [...this.sealedSessions].filter((s) => s.stage === 'handshake');
      for (const old of pending.slice(0, Math.max(0, pending.length - this.limits.maxPreAuthSockets))) {
        this._endSealed(old, CLOSE.TRY_AGAIN, 'too many pending handshakes');
      }
      transport.on('data', (message, isBinary) => this._onSealedMessage(state, message, isBinary));
      transport.on('raw', (chunk) => this._countPreReady(state, chunk.length));
      transport.on('close', () => this._endSealed(state, CLOSE.GOING_AWAY, 'closed', { transportGone: true }));
    });
  }

  // next() takes each message once, in order; its promises settle in that order, so
  // frames reach the dispatcher in order.
  _onSealedMessage(state, message, isBinary) {
    if (state.stage === 'closed') return;
    if (isBinary === false) {
      if (state.stage === 'handshake') this._endSealed(state, CLOSE.BAD_SIGNATURE, 'handshake');
      else this._endSealed(state, CLOSE.MALFORMED, 'record');
      return;
    }
    if (Buffer.isBuffer(message)) this._countPreReady(state, message.length);
    if (state.stage === 'closed') return;
    state.seal.next(message)
      .then((result) => this._onSealResult(state, result))
      .catch((err) => {
        log.warn(`a sealed message failed: ${err.message}`);
        this._endSealed(state, CLOSE.MALFORMED, 'record');
      });
  }

  // A peer that has proved nothing is cut off as its bytes arrive, whatever they
  // would have been.
  _countPreReady(state, bytes) {
    if (state.stage !== 'handshake') return;
    state.preReadyBytes += bytes;
    if (state.preReadyBytes <= this.limits.preAuthSocketBytes) return;
    this._endSealed(state, CLOSE.BAD_SIGNATURE, 'handshake');
    try { state.transport.terminate?.(); } catch { /* gone */ }
  }

  _onSealResult(state, { frames, close, ready, peer }) {
    if (state.stage === 'closed') return;
    // The seal's own failures send nothing, and a peer's close needs no answer.
    if (close) {
      this._endSealed(state, close.code, close.reason);
      return;
    }
    if (state.stage === 'handshake' && ready) this._onSealedReady(state, peer);
    if (state.stage !== 'ready') return;
    state.heartbeat.received();
    for (const frame of frames) this._onSealedFrame(state, frame);
  }

  // Past here the peer holds the device key its record names, so it may be told why
  // under the seal.
  _onSealedReady(state, peer) {
    const refuse = (code, reason) => this._endSealed(state, code, reason, { record: true });
    const device = this._lookupDevice(peer.deviceId);
    if (!device || device.publicKey !== toB64url(peer.publicKey)) return refuse(CLOSE.UNKNOWN_DEVICE, 'unknown device');
    if (device.remote !== true) return refuse(CLOSE.NOT_REMOTE, NOT_REMOTE);
    if (this._sealRefusal()) return refuse(CLOSE.NOT_REMOTE, NOT_SEALING);
    // One connection per device: attaching again takes its own place.
    const old = this.connections.get(device.deviceId);
    if (!old && this.connections.size >= this.limits.maxDevices) return refuse(CLOSE.TOO_MANY_WINDOWS, TOO_MANY);
    if (old) {
      this.connections.delete(device.deviceId);
      old.markGone();
      old.close(CLOSE.NORMAL, 'replaced by a new connection');
    }
    const senderLimits = Number.isInteger(this.limits.sealedQueueBytes) ? { maxQueuedBytes: this.limits.sealedQueueBytes } : {};
    state.sender = createFrameSender({ seal: state.seal, ...senderLimits });
    state.heartbeat = startHeartbeat({
      ...this.sealedDeps,
      ping: () => state.seal.ping(),
      onSilence: ({ code, reason }) => this._endSealed(state, code, reason)
    });
    state.stage = 'ready';
    const conn = createConnection({
      deviceId: device.deviceId,
      label: device.label,
      remote: true,
      send: (obj) => this._sendSealed(state, obj),
      close: (code, reason) => this._endSealed(state, code, reason, { record: true })
    });
    state.conn = conn;
    this.connections.set(conn.deviceId, conn);
    this._sendSealed(state, { t: 'ready', service: this.serviceInfo() });
    log.info(`window "${device.label}" (${device.deviceId}) attached`);
    this.emit('connected', { deviceId: conn.deviceId, label: conn.label, remote: true });
    state.resolve(conn);
    return undefined;
  }

  // The same checks as a loopback frame, because it is the same path.
  _onSealedFrame(state, frame) {
    state.inFlight += 1;
    Promise.resolve()
      .then(() => this._onReadyFrame(state, frame, false))
      .catch((err) => this._onFrameError(state, frame, false, err))
      .finally(() => {
        state.inFlight -= 1;
        this._retireSealed(state);
      });
  }

  _sendSealed(state, obj) {
    if (state.stage !== 'ready') return false;
    const text = this._frameText(obj);
    if (text === null) return false;
    // A full queue, a stopped sender or a dropped socket: the session is over.
    state.sender.send(Buffer.from(text, 'utf8')).catch((err) => {
      if (err.code === 'SEND_QUEUE_FULL') this._endSealed(state, CLOSE.TRY_AGAIN, SLOW_READER);
      else this._endSealed(state, CLOSE.GOING_AWAY, 'send failed');
    });
    return true;
  }

  // Every way a sealed session ends. `record` tells an authenticated peer why, under
  // the seal and before the socket closes, since the socket's own code proves nothing;
  // otherwise nothing goes (window-v1 §5). The seal's keys are zeroed either way. A
  // dropped connection stops nothing here: that is the dispatcher's.
  _endSealed(state, code, reason, { record = false, transportGone = false } = {}) {
    if (state.stage === 'closed') return;
    const before = state.stage;
    state.stage = 'closed';
    state.heartbeat?.stop();
    state.sender?.stop();
    try {
      if (record && !transportGone) state.seal?.closeRecord(code);
    } catch (err) {
      log.debug(`no close record went: ${err.code || err.message}`);
    }
    state.seal?.destroy();
    try {
      if (!transportGone) state.transport.close(code, truncateUtf8(reason, 123));
    } catch { /* gone */ }
    const conn = state.conn;
    if (conn) {
      if (this.connections.get(conn.deviceId) === conn) this.connections.delete(conn.deviceId);
      conn.markGone();
      this._disconnectOnce(conn);
      log.info(`window "${conn.label}" disconnected (${code})`);
      this.emit('disconnected', { deviceId: conn.deviceId, label: conn.label, remote: true });
    }
    if (before === 'handshake') {
      const refused = new BridgeError(reason, MESSAGES.MALFORMED);
      refused.closeCode = code;
      state.reject(refused);
    }
    this._retireSealed(state);
  }

  _retireSealed(state) {
    if (state.stage === 'closed' && state.inFlight === 0) this.sealedSessions.delete(state);
  }

  _recordFailure(deviceId) {
    const now = this.now();
    const recent = (this.failures.get(deviceId) || []).filter((t) => now - t < this.limits.failureWindowMs);
    recent.push(now);
    this.failures.delete(deviceId);
    if (recent.length >= this.limits.failuresPerDevice) {
      this.lockouts.set(deviceId, now + this.limits.lockoutMs);
      log.warn(`desktop ${deviceId} failed ${recent.length} handshakes; refusing it for ${Math.round(this.limits.lockoutMs / 1000)} s`);
      this._pruneLockouts(now);
      return;
    }
    this.failures.set(deviceId, recent);
    // Bounded: arbitrary device ids from a flood must not grow memory.
    while (this.failures.size > this.limits.maxTrackedFailures) this.failures.delete(this.failures.keys().next().value);
  }

  // Expired entries would otherwise sit in the map forever (nothing removes
  // one except a matching _lockedOut() check for that exact id); a flood of
  // distinct claimed ids must not grow it without bound either.
  _pruneLockouts(now) {
    for (const [id, until] of this.lockouts) {
      if (now >= until) this.lockouts.delete(id);
    }
    while (this.lockouts.size > this.limits.maxTrackedFailures) this.lockouts.delete(this.lockouts.keys().next().value);
  }

  _lockedOut(deviceId) {
    const until = this.lockouts.get(deviceId);
    if (!until) return false;
    if (this.now() >= until) {
      this.lockouts.delete(deviceId);
      return false;
    }
    return true;
  }
}

module.exports = { DesktopBridgeServer };
