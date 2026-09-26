const { EventEmitter } = require('events');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');
const { MeshIdentity } = require('./mesh-identity');
const { deriveNodeId } = require('./node-identity');
const { createLogger } = require('../logging');
const log = createLogger('mesh');

const DEFAULT_PORT = 18791;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;
const RECONNECT_DELAYS = [5000, 10000, 20000, 60000];
const AUTH_TIMEOUT_MS = 10000;
// Fleet stage 4 §3.10. A frame is at most 1 MiB (list RPCs are byte-paged
// with max_bytes); an unauthenticated one at most 16 KiB, checked before
// anything parses it (ruling 8).
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PRE_AUTH_MAX_BYTES = 16 * 1024;
const PRE_AUTH_STRING_MAX = 4096;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const INBOUND_RATE_PER_S = 200;
const INBOUND_BURST = 400;
const MAX_UNAUTH_SOCKETS = 64;
const MAX_UNAUTH_PER_IP = 8;
// Ruling T6-cap: an unauthenticated socket must send its first frame within
// this, apart from the 10 s for the whole handshake.
const FIRST_FRAME_MS = 2000;
const ENVELOPE_WINDOW_MS = 5 * 60 * 1000;
const FRONT_DOOR_ENVELOPE_WINDOW_MS = 60000;
const STALE_GRACE_MS = 5000;
const CLOSE_CODES = Object.freeze({ tooBig: 1009, unauthenticated: 4001, keyRemoved: 4003, alreadyConnected: 4009, replayDetected: 4010, rateLimited: 4029 });
// One connection per key (fleet stage 4 §3.6, with duplicatePingMs): what an
// authenticated candidate sends while the old link is pinged is held, up to
// these bounds (anything more closes it 4029), and replayed on takeover.
const DUPLICATE_HOLD_MAX_FRAMES = 64;
const DUPLICATE_HOLD_MAX_BYTES = 1024 * 1024;
// A takeover never waits on this: a stale link must never keep a valid node
// out (F7). Repeated takeovers of one key (two machines holding it, or a
// stolen copy) are logged at error and reported as flapping instead.
const TAKEOVER_WINDOW_MS = 10 * 60 * 1000;
const TAKEOVER_ALERT_COUNT = 3;

// An auth challenge is exactly 32 random bytes and a signature exactly one
// Ed25519 signature. Fixing the challenge length matters beyond tidiness:
// the listener signs whatever challenge a stranger sends, with the same key
// that signs envelopes, and the shortest envelope body is longer than 32
// bytes, so this handshake can never be used to get an envelope signed.
const HEX_CHALLENGE_RE = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE_RE = /^[0-9a-f]{128}$/;

// The two frames a listener accepts before it knows who is talking, with
// exactly these keys.
const PRE_AUTH_SHAPES = Object.freeze({
  'auth:challenge': Object.freeze(['authId', 'challenge', 'identity', 'type']),
  'pair:request': Object.freeze(['identity', 'nonce', 'pairingId', 'proof', 'type'])
});
// The rest of the handshake, exactly these keys too: what a dialer accepts
// from the listener, and what a listener accepts after its auth:response.
const DIALER_SHAPES = Object.freeze({
  'auth:response': Object.freeze(['authId', 'challenge', 'identity', 'signature', 'type']),
  'auth:reject': Object.freeze(['reason', 'type'])
});
const COMPLETE_SHAPES = Object.freeze({
  'auth:complete': Object.freeze(['authId', 'signature', 'type'])
});
const IDENTITY_KEYS = new Set(['peerId', 'publicKey', 'displayName', 'capabilities', 'tlsFingerprint', 'nodeId', 'nodeName']);

function frameBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

const shortString = (v) => typeof v === 'string' && v.length <= PRE_AUTH_STRING_MAX;

function preAuthIdentityOk(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  for (const [k, v] of Object.entries(identity)) {
    if (!IDENTITY_KEYS.has(k)) return false;
    if (k === 'capabilities') {
      if (!Array.isArray(v) || v.length > 64 || !v.every(shortString)) return false;
    } else if (!(v === null || shortString(v))) {
      return false;
    }
  }
  return typeof identity.peerId === 'string' && typeof identity.publicKey === 'string';
}

function handshakeValueOk(key, value) {
  if (key === 'identity') return preAuthIdentityOk(value);
  if (key === 'challenge') return typeof value === 'string' && HEX_CHALLENGE_RE.test(value);
  if (key === 'signature') return typeof value === 'string' && HEX_SIGNATURE_RE.test(value);
  return shortString(value);
}

// → { msg } or { close: code }. Size first, then one parse, then the exact shape.
function parseHandshakeFrame(data, shapes) {
  const buf = frameBytes(data);
  if (buf.length > PRE_AUTH_MAX_BYTES) return { close: CLOSE_CODES.tooBig };
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return { close: CLOSE_CODES.unauthenticated };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !Object.hasOwn(shapes, msg.type)) return { close: CLOSE_CODES.unauthenticated };
  const keys = Object.keys(msg).sort();
  const want = shapes[msg.type];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { close: CLOSE_CODES.unauthenticated };
  for (const [k, v] of Object.entries(msg)) {
    if (!handshakeValueOk(k, v)) return { close: CLOSE_CODES.unauthenticated };
  }
  return { msg };
}

// The first frame on an inbound socket: exactly auth:challenge or pair:request.
function parsePreAuthFrame(data) {
  return parseHandshakeFrame(data, PRE_AUTH_SHAPES);
}

// §3.10 item 4: auth signatures cover challenge ‖ TLS exporter, so a signed
// auth message is worthless on any other TLS session. Plain ws:// (desktop
// LAN tests only) has no exporter and binds to nothing.
const EXPORTER_LABEL = 'EXPORTER-king-louie-mesh-v1';

function channelBinding(ws) {
  const socket = ws && ws._socket;
  if (!socket || typeof socket.exportKeyingMaterial !== 'function') return Buffer.alloc(0);
  try {
    return socket.exportKeyingMaterial(32, EXPORTER_LABEL);
  } catch {
    return Buffer.alloc(0);
  }
}

function boundChallenge(challenge, binding) {
  return Buffer.concat([Buffer.from(challenge), Buffer.from(binding)]);
}

function peerCertFingerprint(socket) {
  try {
    const cert = socket && typeof socket.getPeerX509Certificate === 'function' ? socket.getPeerX509Certificate() : null;
    return cert ? crypto.createHash('sha256').update(cert.raw).digest('hex') : null;
  } catch {
    return null;
  }
}

// Both sides must be SHA-256 fingerprints (64 lowercase hex); anything else
// is unequal, so an empty or truncated value can never match.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !SHA256_HEX_RE.test(a) || !SHA256_HEX_RE.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// The binding a TLS transport must have: 32 exporter bytes. A TLS link never
// continues unbound (an exporter that is missing or throws fails the
// handshake); plain ws:// has none and binds to nothing.
const CHANNEL_BINDING_BYTES = 32;

// `ws` enforces maxPayload while it reads a frame header, before it buffers
// the payload. Until a socket authenticates its limit is PRE_AUTH_MAX_BYTES,
// so an unauthenticated peer cannot make us hold even 1 MiB; promotion raises
// it. `ws` exposes no public setter, so this reaches the receiver's field
// (pinned by tests/mesh-hardening.test.js, which fails if it disappears).
function setFrameLimit(ws, bytes) {
  const receiver = ws && ws._receiver;
  if (!receiver || typeof receiver._maxPayload !== 'number') return false;
  receiver._maxPayload = bytes;
  return true;
}

function closeQuietly(ws, code, reason) {
  try { ws.close(code, reason); } catch { try { ws.terminate(); } catch { /* gone */ } }
}

class MeshTransport extends EventEmitter {
  constructor(config = {}) {
    super();
    this.identity = config.identity;
    // port 0 means "bind an ephemeral port" and is a legitimate value, so test
    // for undefined/null rather than falling back on falsy 0 — that is how
    // `KL_TEST_MODE` asks initializeMesh for an ephemeral port.
    this.port = config.port != null ? config.port : DEFAULT_PORT;
    this.host = config.host || '0.0.0.0';
    this.trustedPeers = config.trustedPeers || new Map();
    this.useTls = config.useTls !== false; // TLS on by default
    // listen: false — a fleet node only ever dials out (principle 4): start()
    // binds nothing, and the transport is used for connectToPeer alone.
    this.listen = config.listen !== false;

    this.httpsServer = null;
    this.server = null;
    this.peers = new Map();
    this.pendingAuth = new Map();
    this.reconnectTimers = new Map();
    this.heartbeatInterval = null;
    // Unauthenticated inbound sockets → remote IP (at most 64, 8 per IP).
    this.unauth = new Map();
    // Fleet stage 4 §3.10 item 3 (Task 7 adds the TLS side): with it on,
    // `pair:request` is refused and only pinned client certificates connect.
    this.requireClientCert = config.requireClientCert === true;
    if (this.requireClientCert && !this.useTls) {
      throw new Error('requireClientCert needs TLS: plain ws:// is only allowed with requireClientCert: false');
    }
    // (fingerprintHex) → boolean: is this client certificate pinned? Without
    // one, the trusted peers' pinned tlsFingerprints decide.
    this.isPinned = typeof config.isPinned === 'function' ? config.isPinned : null;
    this.attached = [];
    // Fleet stage 4 §3.6: with a value, a second authenticated connection
    // for a connected peer pings the old one first (see _promoteToPeer).
    this.duplicatePingMs = Number.isInteger(config.duplicatePingMs) ? config.duplicatePingMs : null;
    // peerId → the one candidate waiting on that ping.
    this.duplicates = new Map();
    // peerId → times of recent takeovers (within TAKEOVER_WINDOW_MS).
    this.takeovers = new Map();
    this.running = false;
    this.onPairingRequest = null; // set by MeshPairing to handle pair:request messages
  }

  async start() {
    if (this.server) return;
    if (!this.listen) {
      if (this.running) return;
      this.running = true;
      this._startHeartbeat();
      log.info('transport started without a listener (dial-out only)');
      return;
    }

    if (this.useTls && this.identity.tlsCert && this.identity.tlsKey) {
      // TLS mode: HTTPS server → WSS
      this.httpsServer = https.createServer({
        cert: this.identity.tlsCert,
        key: this.identity.tlsKey,
        requestCert: this.requireClientCert,
        rejectUnauthorized: false
      });

      this.server = new WebSocket.Server({
        server: this.httpsServer,
        maxPayload: MAX_PAYLOAD_BYTES,
        ...(this.requireClientCert ? { verifyClient: ({ req }) => this._pinnedSocket(req.socket) } : {})
      });

      this.server.on('connection', (ws, req) => {
        this._handleInboundConnection(ws, req);
      });
      this.server.on('error', (err) => log.error(`transport server error: ${err.message}`));
      this.httpsServer.on('error', (err) => log.error(`transport https error: ${err.message}`));

      await new Promise((resolve, reject) => {
        this.httpsServer.listen(this.port, this.host, resolve);
        this.httpsServer.once('error', reject);
      });

      if (this.httpsServer.address()) this.port = this.httpsServer.address().port;
      log.info(`transport listening on wss://${this.host}:${this.port} (TLS)`);
    } else {
      // Fallback: plain WS (for tests or when TLS certs not available)
      this.server = new WebSocket.Server({
        host: this.host,
        port: this.port,
        maxPayload: MAX_PAYLOAD_BYTES
      });

      this.server.on('connection', (ws, req) => {
        this._handleInboundConnection(ws, req);
      });
      this.server.on('error', (err) => log.error(`transport server error: ${err.message}`));

      await new Promise((resolve, reject) => {
        this.server.once('listening', resolve);
        this.server.once('error', reject);
      });

      if (this.server.address()) this.port = this.server.address().port;
      log.info(`transport listening on ws://${this.host}:${this.port} (no TLS)`);
    }

    this.running = true;
    this._startHeartbeat();
  }

  async stop() {
    this.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const peer of this.peers.values()) {
      try { peer.ws.close(); } catch { /* ignore */ }
    }
    // Not peers.clear(): same reasoning as removeTrustedPeer/disconnectPeer
    // — the close listener is the one place that deletes from `peers` and
    // emits 'peerDisconnected'; clearing it here first would hit the
    // stale-socket guard and drop every one of those events during
    // shutdown, the same regression removeTrustedPeer had. `running` is
    // already false, so _scheduleReconnect (which each disconnect still
    // reaches) is a no-op.

    for (const pending of this.pendingAuth.values()) {
      try { pending.ws.close(); } catch { /* ignore */ }
      if (pending.timeout) clearTimeout(pending.timeout);
      // A dial still in its handshake settles now; with the entry gone, its
      // socket's close handler could no longer reject it.
      if (typeof pending.reject === 'function') pending.reject(new Error('transport stopped'));
    }
    this.pendingAuth.clear();
    for (const ws of this.unauth.keys()) {
      try { ws.terminate(); } catch { /* gone */ }
    }
    this.unauth.clear();
    for (const held of this.duplicates.values()) {
      try { held.ws.terminate(); } catch { /* gone */ }
    }
    this.duplicates.clear();

    for (const wss of this.attached) await new Promise((resolve) => wss.close(() => resolve()));
    this.attached = [];

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    if (this.httpsServer) {
      await new Promise((resolve) => this.httpsServer.close(resolve));
      this.httpsServer = null;
    }

    log.info('transport stopped');
  }

  // --- Peer Management ---

  addTrustedPeer(peerId, publicKey, metadata = {}) {
    this.trustedPeers.set(peerId, {
      peerId,
      publicKey: typeof publicKey === 'string' ? publicKey : publicKey.toString('hex'),
      displayName: metadata.displayName || '',
      capabilities: metadata.capabilities || [],
      tlsFingerprint: metadata.tlsFingerprint || null,
      address: metadata.address || null,
      port: metadata.port || null,
      addedAt: Date.now()
    });
  }

  removeTrustedPeer(peerId) {
    this.trustedPeers.delete(peerId);
    // disconnectPeer (below) closes the socket without touching `peers`
    // itself, so the one close listener (_handlePeerDisconnect) does the
    // single cleanup and emits 'peerDisconnected' — deleting it here first
    // used to make that handler's stale-socket guard (added for the
    // superseded-reconnect case) treat this as a late echo and swallow the
    // event entirely, so removing a peer never told the UI or the gateway,
    // and a link-rpc call to it just waited out its timeout instead of
    // rejecting on disconnect.
    this.disconnectPeer(peerId);
  }

  // Force-closes a connected peer's socket without untrusting it, so a
  // caller that has decided a link is unusable (e.g. RelayClient after a
  // failed or mismatched hello) can drop it and let the normal
  // 'peerDisconnected' path (below) do the one canonical cleanup — no
  // separate bookkeeping here, so there is exactly one place that deletes
  // `peers` and emits the event. Returns false if the peer wasn't connected.
  disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    try { peer.ws.terminate(); } catch { try { peer.ws.close(); } catch { /* already gone */ } }
    return true;
  }

  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  getConnectedPeers() {
    return Array.from(this.peers.values()).map((p) => ({
      peerId: p.peerId,
      displayName: p.displayName,
      capabilities: p.capabilities,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      tlsVerified: p.tlsVerified || false
    }));
  }

  // --- Connect to a peer ---

  async connectToPeer(address, port) {
    const protocol = this.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${address}:${port}`;
    log.info(`connecting to ${url}`);

    return new Promise((resolve, reject) => {
      // `ws` clients default to 100 MiB frames; a mesh frame is at most 1 MiB
      // (and 16 KiB until the link authenticates, see _initiateAuth).
      const wsOptions = { maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false };

      if (this.useTls) {
        // Accept self-signed certs — we verify via fingerprint pinning, not CA
        wsOptions.rejectUnauthorized = false;
      }

      const ws = new WebSocket(url, wsOptions);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timeout to ${url}`));
      }, AUTH_TIMEOUT_MS);

      ws.on('open', () => {
        // If TLS, capture the server's certificate fingerprint for pinning
        let serverCertFingerprint = null;
        if (this.useTls && ws._socket) {
          const peerCert = ws._socket.getPeerCertificate(true);
          if (peerCert && peerCert.raw) {
            const crypto = require('crypto');
            serverCertFingerprint = crypto.createHash('sha256').update(peerCert.raw).digest('hex');
          }
        }

        this._initiateAuth(ws, address, port, timeout, resolve, reject, serverCertFingerprint);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _pinnedSocket(socket, isPinned = this.isPinned) {
    const fp = peerCertFingerprint(socket);
    if (!fp) return false;
    if (isPinned) return isPinned(fp) === true;
    for (const p of this.trustedPeers.values()) if (p.tlsFingerprint && timingSafeHexEqual(p.tlsFingerprint, fp)) return true;
    return false;
  }

  // §3.10 item 8: serve the mesh on a listener someone else owns (the front
  // door's SNI router hands its `mesh.` sockets to `httpServer`). With
  // requireClientCert, an unpinned or missing client certificate never gets
  // as far as the WebSocket handshake.
  attachServer(httpServer, { requireClientCert = this.requireClientCert, isPinned = this.isPinned, path: wsPath = '/mesh/v1' } = {}) {
    // The handshake (pair:request refusal, the two-pin tie) follows the
    // transport's own flag, so an attached listener cannot ask for more.
    if (requireClientCert && !this.requireClientCert) {
      throw new Error('attachServer: requireClientCert needs a transport constructed with requireClientCert: true');
    }
    const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = null;
      try { pathname = new URL(req.url, 'http://mesh.invalid').pathname; } catch { pathname = null; }
      if (pathname !== wsPath) {
        socket.destroy();
        return;
      }
      if (requireClientCert && (!socket.encrypted || !this._pinnedSocket(socket, isPinned))) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this._handleInboundConnection(ws, req));
    });
    this.attached.push(wss);
    return wss;
  }

  // §3.9: dial the front door with this node's certificate; the served
  // certificate must be the pin before one application byte is written.
  // lookup (optional) only chooses the address dialled; the pin below is
  // still checked against whatever certificate that address serves.
  async connectPinned({ url, pinnedFingerprint, frontdoorId, servername = null, timeoutMs = AUTH_TIMEOUT_MS, lookup = null } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'wss:') throw new Error('connectPinned needs a wss:// URL');
    if (!/^[0-9a-f]{64}$/.test(String(pinnedFingerprint))) throw new Error('connectPinned needs a hex SHA-256 certificate pin');
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || 443;
    const sni = servername || (net.isIP(host) ? undefined : host);
    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect({
        host,
        port,
        ...(sni ? { servername: sni } : {}),
        cert: this.identity.tlsCert,
        key: this.identity.tlsKey,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        ALPNProtocols: ['http/1.1'],
        ...(lookup ? { lookup } : {})
      });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`connection timeout to ${url}`)); }, timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        const served = peerCertFingerprint(s);
        if (!served || !timingSafeHexEqual(served, pinnedFingerprint)) {
          s.destroy();
          reject(Object.assign(new Error(`frontdoor_key_mismatch: ${url} served ${served || 'no certificate'}, pinned ${pinnedFingerprint}`), { code: 'frontdoor_key_mismatch', served }));
          return;
        }
        resolve(s);
      });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { createConnection: () => socket, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch { /* gone */ }
        reject(new Error(`authentication timeout to ${url}`));
      }, timeoutMs);
      ws.on('open', () => this._initiateAuth(ws, null, null, timeout, resolve, reject, pinnedFingerprint, { expectNodeId: frontdoorId, frontDoorLink: true }));
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  _initiateAuth(ws, address, port, timeout, resolve, reject, serverCertFingerprint, extra = {}) {
    const challenge = this.identity.generateChallenge();
    // Unguessable: a stranger's auth:challenge must not be able to reuse it.
    const authId = `auth-${require('crypto').randomBytes(12).toString('hex')}`;

    this.pendingAuth.set(authId, {
      ws,
      challenge,
      address,
      port,
      timeout,
      resolve,
      reject,
      direction: 'outbound',
      serverCertFingerprint,
      expectNodeId: extra.expectNodeId || null,
      frontDoorLink: extra.frontDoorLink === true
    });

    ws.send(JSON.stringify({
      type: 'auth:challenge',
      authId,
      challenge: challenge.toString('hex'),
      identity: this.identity.getPublicIdentity()
    }));

    // The listener is not authenticated yet either: its frames get the same
    // pre-auth size cap (enforced by `ws` before buffering) and exact shapes.
    if (!setFrameLimit(ws, PRE_AUTH_MAX_BYTES)) {
      log.error('ws has no receiver frame limit to set; failing the dial');
      this.pendingAuth.delete(authId);
      clearTimeout(timeout);
      closeQuietly(ws, 1011, 'internal');
      reject(new Error('cannot set the pre-auth frame limit on this ws version; refusing to authenticate'));
      return;
    }
    // Closed or broken before it authenticated (a refusal, a 4029, a frame
    // over the limit, a dead socket): the dial fails now instead of waiting
    // out AUTH_TIMEOUT_MS, and nothing of it stays in pendingAuth.
    const abandon = (why) => {
      const pending = this.pendingAuth.get(authId);
      if (!pending || pending.ws !== ws) return;
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      try { ws.terminate(); } catch { /* gone */ }
      pending.reject(new Error(`the peer connection ended before authenticating (${why})`));
    };
    ws.once('close', (code) => abandon(code));
    ws.once('error', (err) => abandon(err.message));
    ws.on('message', (data) => {
      const parsed = parseHandshakeFrame(data, DIALER_SHAPES);
      if (parsed.close) {
        log.warn(`malformed handshake frame from ${address || 'the peer'}:${port || ''}; closing`);
        this._failOutbound(authId, parsed.close, parsed.close === CLOSE_CODES.tooBig ? 'frame_too_big' : 'unauthenticated');
        return;
      }
      const { msg } = parsed;
      try {
        if (msg.type === 'auth:response') this._handleAuthResponse(authId, msg);
        else this._handleAuthReject(authId, msg);
      } catch (err) {
        log.error(`auth handshake error: ${err.message}`);
        this._failOutbound(authId, CLOSE_CODES.unauthenticated, 'unauthenticated');
      }
    });
  }

  // Ends an outbound handshake that went wrong: close, and reject the dial.
  _failOutbound(authId, code, reason) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'outbound') return;
    this.pendingAuth.delete(authId);
    clearTimeout(pending.timeout);
    closeQuietly(pending.ws, code, reason);
    pending.reject(new Error(`authentication with the peer failed: ${reason}`));
  }

  // --- Inbound connection handling ---

  _handleInboundConnection(ws, req = null) {
    const ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    // Ruling T6-cap (the F7 rule: failures are throttled, a valid signature
    // is never locked out): at the per-IP or global cap the OLDEST
    // unauthenticated socket (from that IP, or overall) is evicted with 4029,
    // never the newcomer, so sockets held open cannot keep a peer out.
    // `unauth` is in arrival order, so the first match is the oldest.
    const evictOldest = (fromIp) => {
      for (const [other, otherIp] of this.unauth) {
        if (fromIp !== null && otherIp !== fromIp) continue;
        this.unauth.delete(other);
        log.warn(`evicting the oldest unauthenticated mesh connection${fromIp !== null ? ` from ${fromIp}` : ''}: too many are open`);
        closeQuietly(other, CLOSE_CODES.rateLimited, 'too_many_unauthenticated');
        return;
      }
    };
    let fromThisIp = 0;
    for (const other of this.unauth.values()) if (other === ip) fromThisIp += 1;
    if (fromThisIp >= MAX_UNAUTH_PER_IP) evictOldest(ip);
    if (this.unauth.size >= MAX_UNAUTH_SOCKETS) evictOldest(null);
    this.unauth.set(ws, ip);
    ws.once('close', () => this.unauth.delete(ws));
    // The client certificate this socket presented (front door: pinned in
    // TLS already); _respondToChallenge checks it against the peer's pin.
    ws.klClientFingerprint = req && req.socket ? peerCertFingerprint(req.socket) : null;
    // Enforced by `ws` while it reads each frame header, before it buffers
    // the payload; _promoteToPeer raises it to MAX_PAYLOAD_BYTES.
    if (!setFrameLimit(ws, PRE_AUTH_MAX_BYTES)) {
      log.error('ws has no receiver frame limit to set; refusing the connection');
      closeQuietly(ws, 1011, 'internal');
      return;
    }

    // One deadline for the whole unauthenticated life of the socket (either
    // path: auth or pairing); promotion takes it out of `unauth` first.
    const authTimeout = setTimeout(() => {
      if (this.unauth.has(ws)) closeQuietly(ws, CLOSE_CODES.unauthenticated, 'auth_timeout');
    }, AUTH_TIMEOUT_MS);
    const firstFrameTimeout = setTimeout(() => {
      if (this.unauth.has(ws)) closeQuietly(ws, CLOSE_CODES.unauthenticated, 'first_frame_timeout');
    }, FIRST_FRAME_MS);
    ws.once('close', () => { clearTimeout(authTimeout); clearTimeout(firstFrameTimeout); });

    // A malformed or oversized frame makes `ws` emit 'error' on this socket
    // (it has already started a close with 1009/1002). This listener is
    // attached before authentication, because without one an unhandled
    // 'error' event takes the whole process down — and this listener faces
    // the LAN. The authenticated path adds its own listener later; both may run.
    ws.on('error', (err) => {
      log.warn(`inbound mesh connection error: ${err.message}`);
      if (!this.unauth.has(ws)) return;
      if (ws.readyState === WebSocket.CLOSING) {
        // Let the close frame (with its code) go out, then drop the socket.
        setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000).unref();
        return;
      }
      try { ws.terminate(); } catch { /* already gone */ }
    });

    // Ruling 8: the first frame is size-checked, then parsed once, then
    // accepted only as exactly auth:challenge or (LAN only) pair:request.
    const onMessage = (data) => {
      clearTimeout(firstFrameTimeout);
      ws.removeListener('message', onMessage);
      const parsed = parsePreAuthFrame(data);
      if (parsed.close) {
        closeQuietly(ws, parsed.close, parsed.close === CLOSE_CODES.tooBig ? 'frame_too_big' : 'unauthenticated');
        return;
      }
      const { msg } = parsed;
      try {
        if (msg.type === 'pair:request') {
          if (this.requireClientCert || !this.onPairingRequest) {
            closeQuietly(ws, CLOSE_CODES.unauthenticated, 'pairing_off');
            return;
          }
          // Pairing answers and closes; nothing after this frame is read.
          ws.on('message', () => closeQuietly(ws, CLOSE_CODES.unauthenticated, 'unauthenticated'));
          this.onPairingRequest(ws, msg);
          return;
        }
        if (this.pendingAuth.has(msg.authId)) {
          // Another handshake owns this authId; never let one overwrite it.
          closeQuietly(ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
          return;
        }
        this._respondToChallenge(ws, msg);
      } catch (err) {
        log.error(`inbound handshake error: ${err.message}`);
        closeQuietly(ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
      }
    };
    ws.on('message', onMessage);
  }

  _respondToChallenge(ws, msg) {
    const { authId, challenge, identity: remoteIdentity } = msg;
    const reject = (reason) => {
      try { ws.send(JSON.stringify({ type: 'auth:reject', reason })); } catch { /* gone */ }
      try { ws.close(CLOSE_CODES.unauthenticated, reason); } catch { /* gone */ }
    };

    const trusted = this.trustedPeers.get(remoteIdentity.peerId);
    if (!trusted) return reject('not_trusted');

    if (this.requireClientCert) {
      // The certificate actually presented must be the one pinned for this
      // Ed25519 key (both pins tie together here, §4.17).
      if (!trusted.tlsFingerprint || !timingSafeHexEqual(trusted.tlsFingerprint, ws.klClientFingerprint)) {
        log.warn(`client certificate for ${remoteIdentity.peerId} is not the pinned one`);
        return reject('tls_fingerprint_mismatch');
      }
    } else if (this.useTls && trusted.tlsFingerprint && remoteIdentity.tlsFingerprint && trusted.tlsFingerprint !== remoteIdentity.tlsFingerprint) {
      log.warn(`TLS fingerprint mismatch for ${remoteIdentity.peerId} - possible impersonation`);
      return reject('tls_fingerprint_mismatch');
    }

    const binding = channelBinding(ws);
    if (this.useTls && binding.length !== CHANNEL_BINDING_BYTES) {
      log.error(`no TLS channel binding on the connection from ${remoteIdentity.peerId}; refusing to authenticate`);
      return reject('channel_binding_unavailable');
    }
    const signature = this.identity.signChallenge(boundChallenge(Buffer.from(challenge, 'hex'), binding));
    const myChallenge = this.identity.generateChallenge();

    this.pendingAuth.set(authId, {
      ws,
      challenge: myChallenge,
      binding,
      remoteIdentity,
      direction: 'inbound',
      timeout: setTimeout(() => {
        this.pendingAuth.delete(authId);
        try { ws.close(CLOSE_CODES.unauthenticated, 'auth_timeout'); } catch { /* gone */ }
      }, AUTH_TIMEOUT_MS)
    });

    ws.send(JSON.stringify({
      type: 'auth:response',
      authId,
      signature: signature.toString('hex'),
      challenge: myChallenge.toString('hex'),
      identity: this.identity.getPublicIdentity()
    }));

    ws.removeAllListeners('message');
    // Still unauthenticated until auth:complete verifies: the same size cap
    // and an exact shape. Exactly one auth:complete is read; anything before
    // it closes the socket, and nothing after it is parsed here (promotion
    // replaces this listener).
    let completeSeen = false;
    ws.on('message', (data) => {
      if (completeSeen) return;
      const parsed = parseHandshakeFrame(data, COMPLETE_SHAPES);
      if (parsed.close) {
        const pending = this.pendingAuth.get(authId);
        if (pending && pending.ws === ws) {
          this.pendingAuth.delete(authId);
          clearTimeout(pending.timeout);
        }
        closeQuietly(ws, parsed.close, parsed.close === CLOSE_CODES.tooBig ? 'frame_too_big' : 'unauthenticated');
        return;
      }
      completeSeen = true;
      try {
        this._handleAuthComplete(authId, parsed.msg);
      } catch (err) {
        log.error(`auth handshake error: ${err.message}`);
        this.pendingAuth.delete(authId);
        closeQuietly(ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
      }
    });
  }

  _handleAuthReject(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'outbound') return;
    this.pendingAuth.delete(authId);
    clearTimeout(pending.timeout);
    try { pending.ws.close(); } catch { /* gone */ }
    const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 100).replace(/_/g, ' ') : 'no reason';
    pending.reject(new Error(`the peer refused authentication: ${reason}`));
  }

  _handleAuthResponse(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'outbound') return;

    const { signature, challenge: theirChallenge, identity: remoteIdentity } = msg;

    const trusted = this.trustedPeers.get(remoteIdentity.peerId);
    if (!trusted) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Peer ${remoteIdentity.peerId} is not trusted`));
      return;
    }

    // Verify pinned TLS cert fingerprint against the actual server cert
    if (this.useTls && trusted.tlsFingerprint && pending.serverCertFingerprint) {
      if (trusted.tlsFingerprint !== pending.serverCertFingerprint) {
        pending.ws.close();
        this.pendingAuth.delete(authId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`TLS certificate fingerprint mismatch for ${remoteIdentity.peerId} - connection rejected`));
        return;
      }
    }

    // connectPinned: the authenticated key must be the front door's own.
    if (pending.expectNodeId) {
      let derived = null;
      try { derived = deriveNodeId(trusted.publicKey); } catch { derived = null; }
      if (derived !== pending.expectNodeId) {
        pending.ws.close();
        this.pendingAuth.delete(authId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`the peer key does not derive the pinned front door id ${pending.expectNodeId}`));
        return;
      }
    }

    const binding = channelBinding(pending.ws);
    if (this.useTls && binding.length !== CHANNEL_BINDING_BYTES) {
      log.error(`no TLS channel binding on the link to ${remoteIdentity.peerId}; refusing to authenticate`);
      this._failOutbound(authId, CLOSE_CODES.unauthenticated, 'channel_binding_unavailable');
      return;
    }
    const valid = MeshIdentity.verifyChallenge(boundChallenge(pending.challenge, binding), signature, trusted.publicKey);

    if (!valid) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Challenge verification failed'));
      return;
    }

    // Pinned only once the peer has proved its key: a failed handshake never
    // pins anything.
    // If we don't have a pinned fingerprint yet, pin it now (trust on first use)
    if (this.useTls && !trusted.tlsFingerprint && pending.serverCertFingerprint) {
      trusted.tlsFingerprint = pending.serverCertFingerprint;
    }

    // Also store the peer's declared TLS fingerprint for future inbound verification
    if (remoteIdentity.tlsFingerprint && !trusted.tlsFingerprint) {
      trusted.tlsFingerprint = remoteIdentity.tlsFingerprint;
    }

    const mySignature = this.identity.signChallenge(boundChallenge(Buffer.from(theirChallenge, 'hex'), binding));

    pending.ws.send(JSON.stringify({
      type: 'auth:complete',
      authId,
      signature: mySignature.toString('hex')
    }));

    this._promoteToPeer(authId, pending.ws, remoteIdentity, pending);
  }

  _handleAuthComplete(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'inbound') return;

    const { signature } = msg;
    const trusted = this.trustedPeers.get(pending.remoteIdentity.peerId);
    if (!trusted) {
      closeQuietly(pending.ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      return;
    }

    const valid = MeshIdentity.verifyChallenge(
      boundChallenge(pending.challenge, pending.binding || Buffer.alloc(0)),
      signature,
      trusted.publicKey
    );

    if (!valid) {
      closeQuietly(pending.ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      return;
    }

    this._promoteToPeer(authId, pending.ws, pending.remoteIdentity, pending);
  }

  _promoteToPeer(authId, ws, remoteIdentity, pending) {
    clearTimeout(pending.timeout);
    this.pendingAuth.delete(authId);
    this.unauth.delete(ws);

    const current = this.peers.get(remoteIdentity.peerId);
    if (current && this.duplicatePingMs !== null && pending.direction === 'inbound' && !pending.duplicateSettled) {
      this._holdDuplicate(authId, ws, remoteIdentity, pending, current);
      return;
    }

    const existingPeer = this.peers.get(remoteIdentity.peerId);
    if (existingPeer) {
      try { existingPeer.ws.close(); } catch { /* ignore */ }
    }

    // Authenticated: frames may now be up to MAX_PAYLOAD_BYTES.
    setFrameLimit(ws, MAX_PAYLOAD_BYTES);

    const tlsVerified = this.useTls && (
      (pending.serverCertFingerprint != null) || // outbound: we saw their cert
      (remoteIdentity.tlsFingerprint != null)     // inbound: they declared fingerprint
    );

    const now = Date.now();
    const peerInfo = {
      peerId: remoteIdentity.peerId,
      displayName: remoteIdentity.displayName || '',
      capabilities: remoteIdentity.capabilities || [],
      publicKey: remoteIdentity.publicKey,
      tlsFingerprint: remoteIdentity.tlsFingerprint || pending.serverCertFingerprint || null,
      tlsVerified,
      ws,
      connectedAt: now,
      lastSeen: now,
      address: pending.address || null,
      port: pending.port || null,
      // §3.10 item 4: frames carry a per-direction sequence number, and an
      // envelope signed before this connection authenticated is stale.
      authAt: now,
      sendSeq: 0,
      recvSeq: 0,
      // §3.10 item 2: replay nonces are kept per peer, and inbound frames are
      // metered with a token bucket.
      // nonce → the time its envelope leaves the envelope window
      seenNonces: new Map(),
      tokens: INBOUND_BURST,
      tokensAt: now,
      envelopeWindowMs: pending.frontDoorLink || this.requireClientCert ? FRONT_DOOR_ENVELOPE_WINDOW_MS : ENVELOPE_WINDOW_MS
    };

    this.peers.set(remoteIdentity.peerId, peerInfo);

    ws.removeAllListeners('message');
    ws.on('message', (data) => {
      const peerId = remoteIdentity.peerId;
      if (this.peers.get(peerId) !== peerInfo || ws.readyState !== WebSocket.OPEN) return;
      // Metered before anything else, so garbage costs a token like any frame.
      if (!this._takeToken(peerInfo)) {
        log.warn(`peer ${peerId} sent more than ${INBOUND_RATE_PER_S} messages a second; closing`);
        this.closePeer(peerId, CLOSE_CODES.rateLimited, 'rate_limited');
        return;
      }
      let msg = null;
      try {
        msg = JSON.parse(frameBytes(data).toString('utf8'));
      } catch {
        msg = null;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        // Not a sequenced frame at all.
        log.warn(`unparseable frame from ${peerId}; closing`);
        this.closePeer(peerId, CLOSE_CODES.replayDetected, 'malformed_frame');
        return;
      }
      // A throw here (a malformed envelope, or a peerMessage listener) must
      // never escape into `ws` and take the process down.
      try {
        this._handlePeerMessage(remoteIdentity.peerId, msg, peerInfo);
      } catch (err) {
        log.warn(`peer message from ${remoteIdentity.peerId} failed: ${err.message}`);
      }
    });

    ws.on('close', (code) => {
      this._handlePeerDisconnect(remoteIdentity.peerId, peerInfo, code);
    });

    ws.on('error', (err) => {
      this.emit('peerError', { peerId: remoteIdentity.peerId, error: err });
    });

    const tlsLabel = tlsVerified ? ', TLS verified' : (this.useTls ? ', TLS' : '');
    log.info(`peer authenticated: ${remoteIdentity.peerId} (${remoteIdentity.displayName || 'unnamed'}${tlsLabel})`);
    this.emit('peerConnected', peerInfo);

    if (pending.resolve) {
      pending.resolve(peerInfo);
    }
  }

  // --- Messaging ---

  send(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Peer not connected: ${peerId}`);
    }
    // A peer that stops reading must not grow our memory without bound.
    if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.closePeer(peerId, CLOSE_CODES.rateLimited, 'send_buffer_full');
      throw new Error(`Peer ${peerId} is not reading (send buffer full); the link was closed`);
    }
    const envelope = MeshIdentity.createEnvelope(this.identity, peerId, payload);
    const frame = JSON.stringify({ type: 'mesh:message', seq: peer.sendSeq + 1, envelope });
    // The far side closes 1009 on anything bigger; fail here, link intact.
    if (Buffer.byteLength(frame, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`message to ${peerId} is larger than ${MAX_PAYLOAD_BYTES} bytes`);
    }
    peer.sendSeq += 1;
    peer.ws.send(frame);
    return envelope;
  }

  // Closes a connected peer with a close code the far side can act on
  // (4003 key removed, 4009 already connected, …); the socket's own 'close'
  // handler does the one cleanup and emits peerDisconnected with the code.
  closePeer(peerId, code, reason = '') {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    peer.disconnectReason = reason || String(code);
    try {
      peer.ws.close(code, reason);
    } catch {
      try { peer.ws.terminate(); } catch { /* gone */ }
    }
    return true;
  }

  // A second authenticated inbound connection for a connected peer. A pong
  // from the old link within duplicatePingMs: it is alive, and the new one is
  // refused (4009). No pong: the old one is dead (a node that crashed inside
  // the heartbeat window) and the new one takes over, with whatever it sent
  // meanwhile. The 4009 is only ever sent here, after the candidate's
  // auth:complete verified, so the dialer has already authenticated when it
  // sees it. One candidate per key waits at a time; a newer one supersedes it.
  _holdDuplicate(authId, ws, remoteIdentity, pending, current) {
    const peerId = remoteIdentity.peerId;
    const earlier = this.duplicates.get(peerId);
    if (earlier) {
      this.duplicates.delete(peerId);
      closeQuietly(earlier.ws, CLOSE_CODES.alreadyConnected, 'already_connected');
    }
    const held = { ws, frames: [], bytes: 0 };
    this.duplicates.set(peerId, held);
    const drop = () => { if (this.duplicates.get(peerId) === held) this.duplicates.delete(peerId); };
    // Authenticated: it may send full-size frames, held within bounds.
    setFrameLimit(ws, MAX_PAYLOAD_BYTES);
    ws.removeAllListeners('message');
    ws.on('message', (data, isBinary) => {
      if (this.duplicates.get(peerId) !== held) return;
      const size = frameBytes(data).length;
      if (held.frames.length >= DUPLICATE_HOLD_MAX_FRAMES || held.bytes + size > DUPLICATE_HOLD_MAX_BYTES) {
        drop();
        log.warn(`second connection for ${peerId} sent too much while the old one was checked; closing it`);
        closeQuietly(ws, CLOSE_CODES.rateLimited, 'rate_limited');
        return;
      }
      held.frames.push([data, isBinary]);
      held.bytes += size;
    });
    ws.once('close', drop);

    this._settleDuplicate(current).then((oldAlive) => {
      if (this.duplicates.get(peerId) !== held) return; // superseded, closed or stopped
      this.duplicates.delete(peerId);
      if (!this.running || ws.readyState !== WebSocket.OPEN) {
        closeQuietly(ws, CLOSE_CODES.unauthenticated, 'unauthenticated');
        return;
      }
      if (!this.trustedPeers.has(peerId)) {
        closeQuietly(ws, CLOSE_CODES.keyRemoved, 'key_removed');
        return;
      }
      const live = this.peers.get(peerId);
      if (live && (live !== current || oldAlive)) {
        // The old link answered, or another link took the slot meanwhile.
        log.info(`refusing a second connection for ${peerId}: the current one is alive`);
        closeQuietly(ws, CLOSE_CODES.alreadyConnected, 'already_connected');
        return;
      }
      if (live) {
        live.disconnectReason = 'replaced';
        try { live.ws.terminate(); } catch { /* gone */ }
        this._noteTakeover(peerId);
      }
      this._promoteToPeer(authId, ws, remoteIdentity, { ...pending, duplicateSettled: true });
      for (const [data, isBinary] of held.frames) ws.emit('message', data, isBinary);
    });
  }

  // Resolves true on a pong from the existing link within duplicatePingMs,
  // false on none, or when that link closes first.
  _settleDuplicate(existing) {
    return new Promise((resolve) => {
      const ws = existing.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      let timer = null;
      const done = (alive) => {
        clearTimeout(timer);
        ws.removeListener('pong', onPong);
        ws.removeListener('close', onClose);
        resolve(alive);
      };
      const onPong = () => done(true);
      const onClose = () => done(false);
      timer = setTimeout(() => done(false), this.duplicatePingMs);
      ws.once('pong', onPong);
      ws.once('close', onClose);
      try {
        ws.ping();
      } catch {
        done(false);
      }
    });
  }

  _noteTakeover(peerId) {
    const now = Date.now();
    const recent = (this.takeovers.get(peerId) || []).filter((t) => now - t < TAKEOVER_WINDOW_MS);
    recent.push(now);
    this.takeovers.set(peerId, recent);
    const flapping = recent.length >= TAKEOVER_ALERT_COUNT;
    const message = `a new connection for ${peerId} replaced one that did not answer a ping (${recent.length} in ${TAKEOVER_WINDOW_MS / 60000} min)`;
    if (flapping) log.error(`${message}: two machines may hold this node's key`);
    else log.warn(message);
    this.emit('peerTakeover', { peerId, count: recent.length, windowMs: TAKEOVER_WINDOW_MS, flapping });
  }

  // A nonce is kept until its envelope is older than the envelope window:
  // after that verifyEnvelope refuses it anyway, so forgetting it opens no
  // replay. Entries are in arrival order, nearly sorted by expiry; the scan
  // stops at the first live one, and the cap bounds any stragglers.
  _pruneNonces(peer) {
    const now = Date.now();
    for (const [nonce, expiresAt] of peer.seenNonces) {
      if (expiresAt >= now) break;
      peer.seenNonces.delete(nonce);
    }
  }

  _takeToken(peer) {
    const now = Date.now();
    peer.tokens = Math.min(INBOUND_BURST, peer.tokens + ((now - peer.tokensAt) / 1000) * INBOUND_RATE_PER_S);
    peer.tokensAt = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  broadcast(payload) {
    const results = [];
    for (const [peerId] of this.peers) {
      try {
        results.push({ peerId, envelope: this.send(peerId, payload) });
      } catch (err) {
        results.push({ peerId, error: err.message });
      }
    }
    return results;
  }

  // `expected` is the record of the socket the frame arrived on: a late frame
  // from a superseded socket must not touch the live peer's counters.
  _handlePeerMessage(peerId, msg, expected = null) {
    const peer = this.peers.get(peerId);
    if (!peer || (expected && peer !== expected)) return;
    // Closing (rate limit, replay, removal): nothing more is processed.
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    // (The frame's rate token was taken by the socket listener, before parsing.)
    // Strictly increasing per direction and connection: a replayed,
    // reordered or unsequenced frame ends the link.
    if (!Number.isSafeInteger(msg.seq) || msg.seq <= peer.recvSeq) {
      log.warn(`replayed or unsequenced frame from ${peerId}; closing`);
      this.closePeer(peerId, CLOSE_CODES.replayDetected, 'replay_detected');
      return;
    }
    peer.recvSeq = msg.seq;
    peer.lastSeen = Date.now();

    if (msg.type !== 'mesh:message') return; // heartbeats and anything unknown end here
    const { envelope } = msg;
    if (!envelope || typeof envelope !== 'object' || typeof envelope.nonce !== 'string' || typeof envelope.signature !== 'string') return;
    if (envelope.to !== this.identity.peerId) {
      log.warn(`envelope from ${peerId} is addressed to someone else`);
      return;
    }
    this._pruneNonces(peer);
    if (peer.seenNonces.has(envelope.nonce)) return; // replay

    const trusted = this.trustedPeers.get(peerId);
    if (!trusted) return;
    if (!(Number(envelope.timestamp) >= peer.authAt - STALE_GRACE_MS)) {
      log.warn(`stale envelope from ${peerId}: signed before this connection authenticated`);
      return;
    }
    let verification;
    try {
      verification = MeshIdentity.verifyEnvelope(envelope, trusted.publicKey, peer.envelopeWindowMs);
    } catch (err) {
      verification = { valid: false, reason: err.message };
    }
    if (!verification.valid) {
      log.warn(`invalid envelope from ${peerId}: ${verification.reason}`);
      return;
    }

    peer.seenNonces.set(envelope.nonce, Number(envelope.timestamp) + peer.envelopeWindowMs);
    // Backstop: a peer within the rate limit never sends more than this many
    // envelopes inside one window.
    const cap = Math.ceil((peer.envelopeWindowMs / 1000) * INBOUND_RATE_PER_S) + INBOUND_BURST;
    while (peer.seenNonces.size > cap) peer.seenNonces.delete(peer.seenNonces.keys().next().value);

    this.emit('peerMessage', {
      from: peerId,
      payload: envelope.payload,
      envelope
    });
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => this._checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
  }

  // Extracted from the interval callback so a test can drive the real
  // timeout-detection code directly (with a manipulated peer.lastSeen)
  // instead of waiting out HEARTBEAT_INTERVAL_MS/HEARTBEAT_TIMEOUT_MS in
  // real time, or reaching into _handlePeerDisconnect directly.
  _checkHeartbeats() {
    const now = Date.now();

    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        log.info(`peer timed out: ${peerId}`);
        // Tag the reason and let the socket's own 'close' handler
        // (_handlePeerDisconnect, below) do the one canonical cleanup —
        // deleting here too, and emitting a second 'peerDisconnected' when
        // that handler also runs, is the double-emit this used to cause.
        // terminate() (not close()) forces the close event even on a
        // socket that is no longer responsive.
        peer.disconnectReason = 'timeout';
        try { peer.ws.terminate(); } catch { /* ignore */ }
        continue;
      }

      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.sendSeq += 1;
        peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: peer.sendSeq }));
      }
    }
  }

  // --- Reconnection ---

  _handlePeerDisconnect(peerId, peerInfo, code = null) {
    // A 'close' listener is bound once per socket, in _promoteToPeer, over
    // that socket's own peerInfo closure. If a newer connection for the same
    // peerId has already replaced it in `peers` (a reconnect that beat the
    // old socket's close event to the punch), this is a late echo of an
    // already-superseded disconnect — it must not evict the live peer or
    // schedule a redundant reconnect for it.
    if (this.peers.get(peerId) !== peerInfo) return;
    const reason = peerInfo.disconnectReason || 'closed';
    this.peers.delete(peerId);
    log.info(`peer disconnected: ${peerId} (${reason}${code ? `, ${code}` : ''})`);
    this.emit('peerDisconnected', { peerId, reason, code: Number.isInteger(code) ? code : null });

    // Reconnect a peer we dialed ourselves (peerInfo carries the
    // address/port connectToPeer recorded). A heartbeat timeout is the one
    // exception: before this path was consolidated onto
    // _handlePeerDisconnect, it called _scheduleReconnect unconditionally,
    // which falls back to the trusted peer's own stored address — so an
    // inbound (listen: true) peer that stopped answering heartbeats is
    // still worth redialing if trustedPeers has an address for it, even
    // though this particular connection didn't originate from us.
    if ((peerInfo.address && peerInfo.port) || reason === 'timeout') {
      this._scheduleReconnect(peerId);
    }
  }

  _scheduleReconnect(peerId, attempt = 0) {
    if (!this.running) return;

    const trusted = this.trustedPeers.get(peerId);
    if (!trusted || !trusted.address || !trusted.port) return;

    if (this.peers.has(peerId)) return;

    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    log.info(`reconnecting to ${peerId} in ${delay / 1000}s (attempt ${attempt + 1})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(peerId);
      if (!this.running || this.peers.has(peerId)) return;

      try {
        await this.connectToPeer(trusted.address, trusted.port);
      } catch {
        this._scheduleReconnect(peerId, attempt + 1);
      }
    }, delay);

    this.reconnectTimers.set(peerId, timer);
  }

  // --- RPC Helpers ---

  async sendRpc(peerId, method, params = {}) {
    const id = `rpc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('peerMessage', handler);
        reject(new Error(`RPC timeout: ${method} to ${peerId}`));
      }, 30000);

      const handler = (msg) => {
        if (msg.from !== peerId) return;
        if (msg.payload?.id !== id) return;

        clearTimeout(timeout);
        this.removeListener('peerMessage', handler);

        if (msg.payload.error) {
          reject(new Error(msg.payload.error));
        } else {
          resolve(msg.payload.result);
        }
      };

      this.on('peerMessage', handler);

      try {
        this.send(peerId, { method, params, id });
      } catch (err) {
        clearTimeout(timeout);
        this.removeListener('peerMessage', handler);
        reject(err);
      }
    });
  }

  sendRpcResponse(peerId, id, result, error = null) {
    const payload = error
      ? { id, error: typeof error === 'string' ? error : error.message }
      : { id, result };
    this.send(peerId, payload);
  }
}

module.exports = {
  MeshTransport,
  DEFAULT_PORT,
  MAX_PAYLOAD_BYTES,
  PRE_AUTH_MAX_BYTES,
  CLOSE_CODES,
  TAKEOVER_ALERT_COUNT,
  EXPORTER_LABEL,
  parsePreAuthFrame,
  channelBinding,
  boundChallenge,
  peerCertFingerprint
};
