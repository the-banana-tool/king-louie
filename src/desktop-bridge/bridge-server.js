// The desktop bridge listener (fleet stage 7 §3.3, §3.4): loopback only,
// separate from the gateway, mutual Ed25519 authentication against a device
// an administrator paired. The server proves itself first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const {
  PROTOCOL, DEFAULT_DESKTOP_BRIDGE_PORT, LIMITS, CLOSE, DEVICE_ID_RE, NONCE_RE,
  newNonce, buildAuthS, buildAuthC, parseFrame, peekFrameId
} = require('./protocol');
const { DEVICES_FILE, DEVICES_CONTROLS, parseDevices, findDevice } = require('./pairing');
const { fromB64url, verifyWithRawKey } = require('./keys');
const { createConnection } = require('./connection');

const log = createLogger('desktop-bridge');
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);
const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

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
    geteuid = defaultGeteuid, adminUid = 0, approvals = null, profile = 'agent',
    account = currentAccount(), createDispatcher = null, limits = {}, now = Date.now
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
    this.account = account;
    this.now = now;
    this.limits = { ...LIMITS, ...limits };
    this.wss = null;
    this.live = null;
    this.preAuth = [];
    this.sockets = new Set();
    this.failures = new Map();
    this.lockouts = new Map();
    this.recheckTimer = null;
    const factory = createDispatcher || ((opts) => require('./bridge-dispatcher').createBridgeDispatcher(opts));
    this.dispatcher = factory({
      core, cipher, dataDir, approvals, account,
      getServiceInfo: () => this.serviceInfo(),
      getConnection: () => this.live
    });
  }

  get connected() {
    return this.live ? { deviceId: this.live.deviceId, label: this.live.label } : null;
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
      providersConfigured: Boolean(this.dispatcher.providersConfigured()),
      channels: [...served.handle, ...served.on]
    };
  }

  async start() {
    if (this.wss) return { port: this.port };
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
    this.recheckTimer = setInterval(() => this._recheckLive(), this.limits.deviceRecheckMs);
    this.recheckTimer.unref?.();
    log.info(`desktop bridge listening on 127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  forwardAmbient(channel, payload) {
    this.dispatcher.forwardAmbient(channel, payload);
  }

  async stop() {
    if (!this.wss) return;
    clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    const conn = this.live;
    if (conn) {
      conn.send({ t: 'bye', code: 'SERVICE_STOPPING' });
      conn.close(CLOSE.GOING_AWAY, 'service stopping');
    }
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
    const wss = this.wss;
    this.wss = null;
    await new Promise((resolve) => wss.close(() => resolve()));
    if (conn) await Promise.resolve(this.dispatcher.onDisconnect(conn)).catch(() => {});
    this.live = null;
  }

  _onConnection(ws) {
    const state = { ws, stage: 'hello', serverNonce: newNonce(), clientNonce: null, deviceId: null, device: null, conn: null, timers: [] };
    this.sockets.add(ws);
    this.preAuth.push(state);
    while (this.preAuth.length > this.limits.maxPreAuthSockets) {
      this._close(this.preAuth[0], CLOSE.TRY_AGAIN, 'too many pending handshakes');
    }
    state.firstFrame = setTimeout(() => this._close(state, CLOSE.MALFORMED, 'no first frame'), this.limits.firstFrameMs);
    state.timers.push(state.firstFrame, setTimeout(() => this._close(state, CLOSE.MALFORMED, 'handshake timed out'), this.limits.handshakeMs));
    ws.on('message', (data, isBinary) => {
      Promise.resolve(this._onMessage(state, data, isBinary)).catch((err) => log.warn(`desktop bridge frame failed: ${err.message}`));
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

  _onClientHello(state, frame) {
    if (frame.t !== 'clientHello') return this._close(state, CLOSE.MALFORMED, 'expected clientHello');
    if (frame.protocol !== PROTOCOL) return this._close(state, CLOSE.PROTOCOL_MISMATCH, String(PROTOCOL));
    if (!DEVICE_ID_RE.test(String(frame.deviceId)) || !NONCE_RE.test(String(frame.clientNonce))) {
      return this._close(state, CLOSE.MALFORMED, 'malformed clientHello');
    }
    if (this._lockedOut(frame.deviceId)) return this._close(state, CLOSE.LOCKED_OUT, 'too many failed handshakes');
    const device = this._lookupDevice(frame.deviceId);
    if (!device) {
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
    if (!verifyWithRawKey(raw, Buffer.from(buildAuthC(this._fields(state)), 'utf8'), sig)) {
      this._recordFailure(state.deviceId);
      return this._close(state, CLOSE.BAD_SIGNATURE, 'signature invalid');
    }
    // Re-read: an unpair between clientHello and auth wins.
    const device = this._lookupDevice(state.deviceId);
    if (!device) return this._close(state, CLOSE.UNKNOWN_DEVICE, 'unknown device');
    if (this.live && this.live.deviceId !== state.deviceId) return this._close(state, CLOSE.OTHER_DEVICE, this.live.label);
    this._removePreAuth(state);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    if (this.live) {
      const old = this.live;
      this.live = null;
      old.close(CLOSE.NORMAL, 'replaced by a new connection');
    }
    state.stage = 'ready';
    const conn = createConnection({
      deviceId: device.deviceId,
      label: device.label,
      send: (obj) => this._send(state.ws, obj),
      close: (code, reason) => { try { state.ws.close(code, reason); } catch { /* gone */ } }
    });
    state.conn = conn;
    this.live = conn;
    this.failures.delete(state.deviceId);
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
    const conn = state.conn;
    if (!conn) return;
    state.conn = null;
    if (this.live === conn) this.live = null;
    conn.markGone();
    Promise.resolve(this.dispatcher.onDisconnect(conn)).catch((err) => log.warn(`desktop disconnect cleanup failed: ${err.message}`));
    log.info(`desktop "${conn.label}" disconnected`);
    this.emit('disconnected', { deviceId: conn.deviceId, label: conn.label });
  }

  _fields(state) {
    return { nodeId: this.identity.nodeId, deviceId: state.deviceId, port: this.port, serverNonce: state.serverNonce, clientNonce: state.clientNonce };
  }

  _send(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    let text = JSON.stringify(obj);
    if (Buffer.byteLength(text) > this.limits.frameBytes) {
      if (obj.t !== 'result') {
        log.warn(`dropped an oversized ${obj.t} frame${obj.channel ? ` on ${obj.channel}` : ''}`);
        return false;
      }
      text = JSON.stringify({ t: 'result', id: obj.id, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    }
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
    try { state.ws.close(code, String(reason).slice(0, 120)); } catch { /* gone */ }
    const kill = setTimeout(() => { try { state.ws.terminate(); } catch { /* gone */ } }, 1000);
    kill.unref?.();
    return undefined;
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

  _recheckLive() {
    const conn = this.live;
    if (conn && !this._lookupDevice(conn.deviceId)) {
      log.info(`desktop ${conn.deviceId} is no longer paired; closing it`);
      conn.close(CLOSE.UNKNOWN_DEVICE, 'unpaired');
    }
  }

  _recordFailure(deviceId) {
    const now = this.now();
    const recent = (this.failures.get(deviceId) || []).filter((t) => now - t < this.limits.failureWindowMs);
    recent.push(now);
    this.failures.delete(deviceId);
    if (recent.length >= this.limits.failuresPerDevice) {
      this.lockouts.set(deviceId, now + this.limits.lockoutMs);
      log.warn(`desktop ${deviceId} failed ${recent.length} handshakes; refusing it for ${Math.round(this.limits.lockoutMs / 1000)} s`);
      return;
    }
    this.failures.set(deviceId, recent);
    // Bounded: arbitrary device ids from a flood must not grow memory.
    while (this.failures.size > this.limits.maxTrackedFailures) this.failures.delete(this.failures.keys().next().value);
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
