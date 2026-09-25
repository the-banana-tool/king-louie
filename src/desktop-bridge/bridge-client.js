// The desktop's side of the bridge (fleet stage 7 §3.7). Electron-free: the
// attached host hands it a `sign` function that unseals the device key only
// for the moment of signing. It dials the literal 127.0.0.1 with no agent, so
// proxy environment variables never apply.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { deriveNodeId } = require('../mesh/node-identity');
const { PROTOCOL, LIMITS, newNonce, buildAuthS, buildAuthC, BridgeError, MESSAGES } = require('./protocol');
const { fromB64url, verifyWithSpkiHex } = require('./keys');
const { isTimeoutExempt } = require('./allowlist');

const log = createLogger('desktop-bridge-client');
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
// No retry until retryNow(): the credentials or the pin are wrong, or another
// device holds the connection, and hammering the service will not change
// that. LOCKED_OUT (4429) is deliberately NOT here — see errorForClose.
const FATAL = new Set(['DEVICE_UNPAIRED', 'PROTOCOL_MISMATCH', 'ANOTHER_DEVICE', 'SERVICE_KEY_CHANGED']);

function safeNodeId(publicKeyHex) {
  try {
    return deriveNodeId(publicKeyHex);
  } catch {
    return null;
  }
}

// Every server close code the client can receive, mapped to the client's
// own status/error vocabulary:
//  - 4401 BAD_SIGNATURE only reaches a client that signed wrong (a bug, not
//    a credential problem) — not fatal, so a fixed build recovers on its own.
//  - 4403 DEVICE_UNPAIRED and 4409 ANOTHER_DEVICE and 4426 PROTOCOL_MISMATCH
//    are fatal (see FATAL): nothing changes by itself, so retryNow() (the
//    owner re-pairing, detaching the other device, or upgrading) is required.
//  - 4429 LOCKED_OUT is deliberately NOT fatal. The server only reaches this
//    branch for a signature that failed to verify (task 4's hardening never
//    checks lockout for a *valid* signature), so this client — which always
//    signs correctly — will succeed on its very next attempt regardless of
//    how the lockout clock is running; the normal backoff schedule already
//    spaces retries out, so nothing extra is needed to avoid hammering it.
//  - 4400 MALFORMED means this client sent something the server's pre-auth
//    parser rejected; not fatal, since a nonce/port race could look the
//    same as a real bug and the backoff still spaces attempts out.
//  - anything else (1000, 1001, 1006, 1013, ...) is an ordinary disconnect —
//    SERVICE_UNREACHABLE, retried on the normal schedule.
function errorForClose(code, reason, port) {
  switch (code) {
    case 4401: return new BridgeError('BAD_SIGNATURE', MESSAGES.BAD_SIGNATURE);
    case 4403: return new BridgeError('DEVICE_UNPAIRED', MESSAGES.DEVICE_UNPAIRED);
    case 4409: return new BridgeError('ANOTHER_DEVICE', MESSAGES.ANOTHER_DEVICE(reason || 'unknown'));
    case 4426: return new BridgeError('PROTOCOL_MISMATCH', MESSAGES.PROTOCOL_MISMATCH(reason || 'another version'));
    case 4429: return new BridgeError('LOCKED_OUT', MESSAGES.LOCKED_OUT);
    case 4400: return new BridgeError('MALFORMED', MESSAGES.MALFORMED);
    default: return new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port));
  }
}

class DesktopBridgeClient extends EventEmitter {
  constructor({
    host = '127.0.0.1', port, getPort = null, pin, deviceId, sign,
    backoffMs = DEFAULT_BACKOFF_MS, jitter = 0.2, random = Math.random,
    defaultTimeoutMs = 120000, handshakeTimeoutMs = LIMITS.handshakeMs
  } = {}) {
    super();
    if (host !== '127.0.0.1') throw new Error('DesktopBridgeClient connects only to 127.0.0.1');
    if (!pin || !pin.nodeId || !pin.publicKey) throw new Error('DesktopBridgeClient needs the pinned service key');
    // Checked once, here, rather than on every challenge: a pin whose
    // publicKey doesn't actually derive its own nodeId is a caller/config
    // bug, not a runtime "the service's identity changed" condition — left
    // unchecked, the challenge-stage comparison could report
    // SERVICE_KEY_CHANGED(X, X) (old and new both X) when the *pin* was
    // self-inconsistent rather than the service's key having changed.
    if (safeNodeId(pin.publicKey) !== pin.nodeId) {
      throw new Error(`DesktopBridgeClient pin is internally inconsistent: publicKey does not derive nodeId ${pin.nodeId}`);
    }
    if (typeof sign !== 'function') throw new Error('DesktopBridgeClient needs a sign function');
    this.port = port;
    this.getPort = getPort;
    this.pin = pin;
    this.deviceId = deviceId;
    this.sign = sign;
    this.backoffMs = backoffMs;
    this.jitter = jitter;
    this.random = random;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.ws = null;
    this.service = null;
    this.status = 'idle';
    this.lastError = null;
    this.nextRetryAt = null;
    this.nextId = 1;
    this.pending = new Map();
    this.attempt = 0;
    this.retryTimer = null;
    this.stopped = false;
    this.held = false;
    this.connecting = null;
  }

  get connected() {
    return this.status === 'connected' && Boolean(this.ws);
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = this._attempt().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  retryNow() {
    this.held = false;
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    return this.connect();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        // Once fully connected there's a real session to say goodbye to;
        // mid-handshake (this.ws is set as soon as the socket is created,
        // not just once 'ready' arrives — see _handshake) there is nothing
        // to negotiate a graceful close with, and _attempt/_handshake's own
        // `stopped` checks are what stop that in-flight attempt from ever
        // reviving into 'connected' — this just makes sure the socket
        // itself doesn't linger open underneath it.
        if (this.status === 'connected') ws.close(1000, 'closed by the desktop');
        else ws.terminate();
      } catch { /* gone */ }
    }
    this._rejectPending(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    this._setState('stopped');
  }

  invoke(channel, args = [], { timeoutMs } = {}) {
    const limit = isTimeoutExempt(channel) ? 0 : (timeoutMs ?? this.defaultTimeoutMs);
    return this._request({ t: 'invoke', channel, args: Array.isArray(args) ? args : [args] }, limit);
  }

  call(method, params = {}, { timeoutMs } = {}) {
    return this._request({ t: 'call', method, params }, timeoutMs ?? this.defaultTimeoutMs);
  }

  send(channel, args = []) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({ t: 'send', channel, args: Array.isArray(args) ? args : [args] }));
    return true;
  }

  _request(frame, limit) {
    if (!this.connected) return Promise.reject(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BridgeError('BRIDGE_TIMEOUT', MESSAGES.BRIDGE_TIMEOUT));
        }, limit);
      }
      this.pending.set(id, entry);
      // `t` then `id` first: the server reads the id of an oversized frame from its prefix.
      this.ws.send(JSON.stringify({ t: frame.t, id, ...frame }));
    });
  }

  async _attempt() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    this._setState('connecting');
    try {
      if (this.getPort) this.port = await this.getPort();
      // close() may have run while getPort() was pending, before any socket
      // existed for it to terminate. Check here, before _handshake ever
      // opens one, rather than let a cancelled attempt open a socket that
      // then has to be cleaned up after the fact.
      if (this.stopped) throw new BridgeError('CANCELLED', 'closed while connecting');
      const service = await this._handshake(this.port);
      this.attempt = 0;
      this.service = service;
      this.lastError = null;
      this._setState('connected');
      return service;
    } catch (err) {
      const error = err instanceof BridgeError ? err : new BridgeError(err.code || 'SERVICE_UNREACHABLE', err.message);
      this.lastError = error;
      if (FATAL.has(error.code)) this.held = true;
      this._scheduleRetry();
      this._setState(this.stopped ? 'stopped' : (this.held ? 'failed' : 'disconnected'));
      throw error;
    }
  }

  _scheduleRetry() {
    if (this.stopped || this.held || this.retryTimer) return;
    const base = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    const wait = Math.max(0, Math.round(base * (1 + this.jitter * (2 * this.random() - 1))));
    this.nextRetryAt = Date.now() + wait;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => {});
    }, wait);
    this.retryTimer.unref?.();
  }

  _handshake(port) {
    return new Promise((resolve, reject) => {
      // Belt-and-suspenders alongside _attempt's own check: this is the
      // function that actually opens the socket, so it refuses to open one
      // for an attempt that's already been cancelled, however it got here.
      if (this.stopped) { reject(new BridgeError('CANCELLED', 'closed while connecting')); return; }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
        perMessageDeflate: false,
        maxPayload: LIMITS.wsMaxPayload,
        handshakeTimeout: this.handshakeTimeoutMs
      });
      // Stored immediately, not just once 'ready' arrives: close() needs a
      // handle on the socket for the whole lifetime of the attempt (not
      // just once it's authenticated) so a close() mid-handshake has
      // something to terminate instead of finding this.ws still null.
      this.ws = ws;
      let stage = 'challenge';
      let settled = false;
      let fields = null;
      const timer = setTimeout(() => fail(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port))), this.handshakeTimeoutMs);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.terminate(); } catch { /* gone */ }
        if (this.ws === ws) this.ws = null;
        reject(err);
      };
      const malformed = () => fail(new BridgeError('MALFORMED', MESSAGES.MALFORMED));
      ws.on('message', async (data) => {
        if (stage === 'ready') { this._onFrame(ws, data); return; }
        let frame;
        try { frame = JSON.parse(data.toString('utf8')); } catch { malformed(); return; }
        try {
          if (stage === 'challenge') {
            if (frame.t !== 'challenge') { malformed(); return; }
            if (frame.protocol !== PROTOCOL) { fail(new BridgeError('PROTOCOL_MISMATCH', MESSAGES.PROTOCOL_MISMATCH(frame.protocol))); return; }
            // The server proves itself first: verify its claimed nodeId
            // against the pinned key before this desktop's own signature
            // (over AUTH_C, computed next stage) ever leaves. A mismatch
            // here means the service's identity changed — fatal. (The pin
            // itself is already known self-consistent — checked once in
            // the constructor — so old and new here are never the same.)
            if (frame.nodeId !== this.pin.nodeId) {
              fail(new BridgeError('SERVICE_KEY_CHANGED', MESSAGES.SERVICE_KEY_CHANGED(this.pin.nodeId, frame.nodeId)));
              return;
            }
            fields = { nodeId: this.pin.nodeId, deviceId: this.deviceId, port, serverNonce: frame.serverNonce, clientNonce: newNonce() };
            buildAuthS(fields); // validates the server nonce
            stage = 'hello';
            ws.send(JSON.stringify({ t: 'clientHello', protocol: PROTOCOL, deviceId: this.deviceId, clientNonce: fields.clientNonce }));
          } else if (stage === 'hello') {
            if (frame.t !== 'hello' || typeof frame.sig !== 'string') { malformed(); return; }
            let sig;
            try { sig = fromB64url(frame.sig); } catch { sig = Buffer.alloc(0); }
            // Verify the server's proof over AUTH_S against the pinned key
            // BEFORE this desktop's own auth signature is built or sent —
            // a service that cannot prove its pinned identity never learns
            // anything more from this desktop.
            if (!verifyWithSpkiHex(this.pin.publicKey, Buffer.from(buildAuthS(fields), 'utf8'), sig)) {
              fail(new BridgeError('SERVICE_KEY_CHANGED', MESSAGES.SERVICE_KEY_CHANGED(this.pin.nodeId, 'a key this desktop did not pin')));
              return;
            }
            stage = 'auth';
            const mine = await this.sign(Buffer.from(buildAuthC(fields), 'utf8'));
            if (settled) return;
            ws.send(JSON.stringify({ t: 'auth', sig: Buffer.from(mine).toString('base64url') }));
          } else if (stage === 'auth') {
            if (frame.t !== 'ready' || !frame.service) { malformed(); return; }
            // Checked again here, not just before the socket was opened:
            // close() may have run after this handshake was already under
            // way (this.ws already terminated by close() itself in the
            // ordinary case), but if a 'ready' frame still arrives before
            // that takes effect, resolving anyway would revive a client
            // that close() already declared 'stopped' into 'connected'
            // with a live socket nothing else will ever close.
            if (this.stopped) {
              settled = true;
              clearTimeout(timer);
              try { ws.terminate(); } catch { /* gone */ }
              if (this.ws === ws) this.ws = null;
              reject(new BridgeError('CANCELLED', 'closed while connecting'));
              return;
            }
            stage = 'ready';
            settled = true;
            clearTimeout(timer);
            this.ws = ws;
            resolve(frame.service);
          }
        } catch (err) {
          fail(err instanceof BridgeError ? err : new BridgeError('MALFORMED', err.message));
        }
      });
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
        if (stage !== 'ready') { fail(errorForClose(code, reason, port)); return; }
        this._onDisconnected(ws, code, reason);
      });
      ws.on('unexpected-response', (_req, res) => fail(new BridgeError('SERVICE_UNREACHABLE', `The local service refused the connection (HTTP ${res.statusCode}).`)));
      ws.on('error', (err) => {
        if (!settled) fail(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port)));
        else log.debug(`desktop bridge socket error: ${err.message}`);
      });
    });
  }

  _onFrame(ws, data) {
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch { log.warn('the service sent a malformed frame'); return; }
    if (frame.t === 'result') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error !== undefined) entry.reject(new BridgeError(frame.code || 'SERVICE_ERROR', frame.error));
      else entry.resolve(frame.value);
    } else if (frame.t === 'event') {
      this.emit('event', frame.channel, frame.payload);
    } else if (frame.t === 'bye') {
      log.info(`the local service is stopping (${frame.code})`);
    }
  }

  _onDisconnected(ws, code, reason) {
    if (this.ws !== ws) return;
    this.ws = null;
    this._rejectPending(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    if (this.stopped) return;
    if (code === 4403 || code === 4409) {
      this.lastError = errorForClose(code, reason, this.port);
      this.held = true;
    } else {
      this.lastError = new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port));
    }
    this._scheduleRetry();
    this._setState(this.held ? 'failed' : 'disconnected');
  }

  _rejectPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  _setState(status) {
    this.status = status;
    this.emit('state', {
      status,
      code: this.lastError ? this.lastError.code : null,
      error: this.lastError ? this.lastError.message : null,
      service: this.service,
      nextRetryAt: this.nextRetryAt
    });
  }
}

module.exports = { DesktopBridgeClient, DEFAULT_BACKOFF_MS };
