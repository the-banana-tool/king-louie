// A window's bridge to a node through a front door (remote window plan R-RW-18, R-RW-34,
// docs/protocol/window-v1.md). Electron-free. It has DesktopBridgeClient's surface over a
// sealed socket: the front door splices bytes it cannot read, so what this file believes
// comes only from the seal, and only from a key the owner has confirmed.
//
// Two rules hold the rest up:
//  - A socket's close code is unauthenticated. It may hold a tab, never clear a pin or an
//    enrollment; `state.authenticated` is true only for a close record from a pinned key.
//  - With no pin the key a handshake proved is only held. It earns the two enroll methods
//    however the node answers, `ready` and `approved` included. Only the phone's code,
//    typed by the owner and computed over that key with `n`, which crosses no socket,
//    calls onNodeKey and leaves `enrolling`.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { PROTOCOL, LIMITS, CLOSE, BridgeError, NODE_ID_RE } = require('./protocol');
const { deriveDeviceId } = require('./keys');
const { channelTimeoutMs } = require('./allowlist');
const { remoteClassOf, remotePayloadClass } = require('./remote-classes');
const {
  WindowSeal, RECORD_MAX, PRE_READY_BYTES, ENROLL_FRAME_MAX, SOCKET_OPTIONS, createFrameSender, startHeartbeat
} = require('./window-seal');
const { wsTransport } = require('./sealed-socket');
const { qrFor, enrollCode } = require('../approvals/window-messages');
const { TTL_MAX_MS } = require('../approvals/messages');

const log = createLogger('remote-window-client');

const WINDOW_PATH = '/window/v1';
const SUBPROTOCOL = 'kl-window-v1';
const SESSION_HEADER = 'x-kl-window-session';
// All of a window's tabs share one grant, and a grant has 10 attaches a minute. Up to 8
// tabs can drop at once, so each tab's first retry is spread over FIRST_RETRY_SPREAD_MS
// and after that a tab tries once a minute: 8 tabs make 8 attaches.
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 60000]);
const FIRST_RETRY_SPREAD_MS = 20000;
const RATE_LIMIT_WAIT_MS = 60000;
const ATTACHES_PER_MINUTE = 3;
const MINUTE_MS = 60000;
// R-RW-33: a card waits on the phone for up to TTL_MAX_MS, so a call that may show one
// outlasts it.
const PHONE_BOUND_MS = TTL_MAX_MS + 60000;
const MAX_CODE_ATTEMPTS = 5;
const QR_NONCE_BYTES = 16;
const TOKEN_MS = 60000;
const CLOSE_GRACE_MS = 1500;
const REFUSAL_WAIT_MS = 5000;
// What a key nobody has confirmed may make this side parse. A node's `ready` is well under.
const UNPROVEN_FRAME_MAX = RECORD_MAX;
const CODE_RE = /^\d{6}$/;
const KEY_BYTES = 32;

const WORDS = Object.freeze({
  SERVICE_UNREACHABLE: 'The connection to this node dropped. If a request was running, its reply was lost.',
  FRONT_DOOR_UNREACHABLE: 'The front door is not reachable.',
  HANDSHAKE_FAILED: 'This window and the node could not start a sealed session.',
  SEAL_FAILED: 'The sealed session broke, so it was closed.',
  SILENCE: 'Nothing came from the node for a minute, so this window is reconnecting.',
  NODE_OFFLINE: 'This node is not connected to the front door.',
  NODE_TIMEOUT: 'This node did not answer the front door in time.',
  NODE_NOT_SEALING: 'This node cannot take a remote window yet: it has no phone it can seal to.',
  RECORD_UNREADABLE: 'This node could not read its list of windows. It may work again in a moment.',
  FRONT_DOOR_BUSY: 'The front door is busy: too many attaches on this sign-in. Trying again in a minute.',
  WINDOW_BUSY: 'This node is busy with other windows connecting. Trying again shortly.',
  TOO_MANY_WINDOWS: 'This node is busy: it holds its eight windows. Close one, then try again.',
  TOKEN_INVALID: 'The front door did not take this window\'s sign-in, so it is being refreshed.',
  TOKEN_REFUSED: 'The front door refused this window\'s sign-in again. Sign in again, or check that remote windows are on.',
  TOKEN_UNAVAILABLE: 'This window\'s sign-in could not be refreshed. Trying again.',
  GRANT_REVOKED: 'The front door says this window\'s approval was revoked. Sign in again and approve it on your phone.',
  INSUFFICIENT_SCOPE: 'This sign-in does not allow attaching a window. Sign in again and approve it on your phone.',
  UNKNOWN_MACHINE: 'This sign-in does not cover this node, or the front door does not know it.',
  REMOTE_WINDOW_OFF: 'Remote windows are turned off for this node.',
  NODE_REFUSED: 'This node refused the window.',
  SERVICE_KEY_CHANGED: 'This node\'s key is not the one this window trusts. If the node was reinstalled, add it again; otherwise something is in the way.',
  DEVICE_UNPAIRED: 'This node does not know this window. Add it again and approve it on your phone.',
  NOT_ENROLLED: 'This window was not enrolled: the request was denied or ran out of time. Start again.',
  PROTOCOL_MISMATCH: 'This window and the node speak different versions of the bridge. Upgrade the older one.',
  REPLACED: 'Another window with this key attached to the node, so this one stopped.',
  PIN_NOT_SAVED: 'This window could not save the node\'s key, so it stopped.',
  ENROLL_CODE_FAILED: 'Five wrong codes. Scan the new code with your phone.',
  ENROLL_RECORDED: 'This node already has this window on its list, and this window never confirmed the node\'s key. Remove the window on your phone and add it again.',
  ENROLL_MALFORMED: 'The node gave an answer this window cannot read.',
  ENROLL_LABEL_TOO_LONG: 'That name is too long.',
  NOT_ENROLLING: 'This window is not enrolling.',
  CANCELLED: 'Closed while connecting.',
  BRIDGE_TIMEOUT: 'The node did not answer in time.',
  PAYLOAD_TOO_LARGE: 'That request is too large to send (64 MiB limit).'
});

const words = (code) => WORDS[code] || 'This window could not reach the node.';
const failure = (code) => new BridgeError(code, words(code));
const RETRY = (code, extra = {}) => ({ code, ...extra });
const HOLD = (code, extra = {}) => ({ code, hold: true, ...extra });

// A close frame on the socket: anyone between here and the node can write one. Reasons
// are matched and never shown.
function socketOutcome(code, reason) {
  switch (code) {
    case 4401:
      return reason === 'invalid_token' ? RETRY('TOKEN_INVALID', { refresh: true }) : RETRY('HANDSHAKE_FAILED');
    case 4403:
      switch (reason) {
        case 'grant_revoked': return HOLD('GRANT_REVOKED');
        case 'insufficient_scope': return HOLD('INSUFFICIENT_SCOPE');
        case 'unknown_machine': return HOLD('UNKNOWN_MACHINE');
        case 'remote_window_off': return HOLD('REMOTE_WINDOW_OFF');
        case 'too_many_windows': return RETRY('WINDOW_BUSY');
        case 'node_not_sealing': return RETRY('NODE_NOT_SEALING');
        case 'invalid_session': return RETRY('HANDSHAKE_FAILED');
        case 'not_enrolled': return HOLD('NOT_ENROLLED');
        case 'unpaired': case 'not_remote': case 'unknown device': return HOLD('DEVICE_UNPAIRED');
        default: return HOLD('NODE_REFUSED');
      }
    case 4404: return RETRY('NODE_OFFLINE');
    case 4408: return RETRY('NODE_TIMEOUT');
    case 4409: return RETRY('WINDOW_BUSY');
    case 4429: return RETRY('FRONT_DOOR_BUSY', { rateLimited: true });
    case 4503: return RETRY('NODE_NOT_SEALING');
    case 4504: return RETRY('RECORD_UNREADABLE');
    default: return RETRY('SERVICE_UNREACHABLE');
  }
}

// A close record: the peer of this session said so, under the seal.
function sealedOutcome(code, { enrolling }) {
  switch (code) {
    case CLOSE.NOT_ENROLLED: return HOLD(enrolling ? 'NOT_ENROLLED' : 'DEVICE_UNPAIRED');
    case CLOSE.TOO_MANY_WINDOWS: return HOLD('TOO_MANY_WINDOWS');
    case CLOSE.NOT_SEALING: return RETRY('NODE_NOT_SEALING');
    case CLOSE.RECORD_UNREADABLE: return RETRY('RECORD_UNREADABLE');
    case CLOSE.NORMAL: return HOLD('REPLACED');
    case CLOSE.TRY_AGAIN: return RETRY('WINDOW_BUSY');
    default: return RETRY('SERVICE_UNREACHABLE');
  }
}

// One of this seal's own failures, by the reason it keeps.
function sealOutcome({ code, reason }) {
  if (reason === 'node_key_changed') return HOLD('SERVICE_KEY_CHANGED');
  if (reason === 'silence') return RETRY('SILENCE');
  if (reason === 'write') return RETRY('SERVICE_UNREACHABLE');
  if (code === CLOSE.BAD_SIGNATURE || code === 4408) return RETRY('HANDSHAKE_FAILED');
  return RETRY('SEAL_FAILED');
}

function rawKeyOf(value, what) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`RemoteWindowClient: ${what} is 32 raw bytes`);
  const bytes = Buffer.from(value);
  if (bytes.length !== KEY_BYTES) throw new Error(`RemoteWindowClient: ${what} is 32 raw bytes`);
  return bytes;
}

function sameCode(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii'));
}

class RemoteWindowClient extends EventEmitter {
  constructor({
    origin, nodeId, deviceId, publicKey, sign, pin = null, getToken, onNodeKey = null,
    backoffMs = DEFAULT_BACKOFF_MS, firstRetrySpreadMs = FIRST_RETRY_SPREAD_MS, attachesPerMinute = ATTACHES_PER_MINUTE,
    jitter = 0.2, random = Math.random, defaultTimeoutMs = 120000, ws = WebSocket, timers = {}
  } = {}) {
    super();
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('RemoteWindowClient needs an https origin');
    }
    if (url.protocol !== 'https:' || url.origin !== String(origin)) throw new Error('RemoteWindowClient needs an https origin');
    if (!NODE_ID_RE.test(String(nodeId))) throw new Error('RemoteWindowClient needs a node id');
    if (typeof sign !== 'function' || typeof getToken !== 'function') throw new Error('RemoteWindowClient needs sign and getToken');
    this.origin = origin;
    this.nodeId = nodeId;
    this.deviceId = deviceId;
    this.publicKey = rawKeyOf(publicKey, 'a device key');
    this.sign = sign;
    this.pin = pin === null ? null : rawKeyOf(pin, 'a pin');
    if (this.pin && deriveDeviceId(this.pin, 'kl-') !== nodeId) throw new Error(`RemoteWindowClient pin is not node ${nodeId}'s key`);
    if (!this.pin && typeof onNodeKey !== 'function') throw new Error('RemoteWindowClient with no pin needs onNodeKey');
    this.getToken = getToken;
    this.onNodeKey = onNodeKey;
    this.backoffMs = backoffMs;
    this.firstRetrySpreadMs = firstRetrySpreadMs;
    this.attachesPerMinute = attachesPerMinute;
    this.jitter = jitter;
    this.random = random;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.WS = ws;
    this.timers = timers;
    this.now = timers.now || Date.now;
    this.setTimer = timers.setTimer || setTimeout;
    this.clearTimer = timers.clearTimer || clearTimeout;

    this.session = null;
    this.service = null;
    this.status = 'idle';
    this.lastError = null;
    this.authenticated = false;
    this.nextRetryAt = null;
    this.nextId = 1;
    this.pending = new Map();
    this.attempt = 0;
    this.retryTimer = null;
    this.stopped = false;
    this.held = false;
    this.connecting = null;
    this.forceToken = false;
    this.tokenRefusals = 0;
    this.attaches = [];
    this.notBefore = 0;
    // { nonce, key, left }: what the owner's code is checked against. Never persisted.
    this.enrollment = null;
    this.requestId = null;
    this.awaitingRecord = false;
  }

  get connected() {
    return this.status === 'connected' && Boolean(this.session);
  }

  get state() {
    return {
      status: this.status,
      code: this.lastError ? this.lastError.code : null,
      error: this.lastError ? this.lastError.message : null,
      service: this.service,
      nextRetryAt: this.nextRetryAt,
      authenticated: this.authenticated,
      awaitingRecord: this.awaitingRecord,
      recorded: Boolean(this.session && this.session.readyService)
    };
  }

  connect() {
    if (this.connecting) return this.connecting;
    const live = this.session;
    if (live && live.opened && !live.ended) return Promise.resolve(this.status === 'connected' ? this.service : null);
    this.stopped = false;
    // A minute after 4429 means a minute, whoever asks.
    if (this.now() < this.notBefore) {
      if (!this.retryTimer) this._armRetry(this.notBefore - this.now());
      return Promise.reject(this.lastError || failure('FRONT_DOOR_BUSY'));
    }
    this.connecting = this._attempt().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  retryNow() {
    this.held = false;
    this.attempt = 0;
    this.tokenRefusals = 0;
    if (this.now() >= this.notBefore) this._clearRetry();
    return this.connect();
  }

  close() {
    this.stopped = true;
    this._clearRetry();
    if (this.session) this._end(this.session, { code: 'CANCELLED', local: true }, { goodbye: true });
    this._rejectPending();
    this._setState('stopped');
  }

  invoke(channel, args = [], { timeoutMs } = {}) {
    const list = Array.isArray(args) ? args : [args];
    const byChannel = channelTimeoutMs(channel, this.defaultTimeoutMs);
    let limit = byChannel === 0 ? 0 : (timeoutMs ?? byChannel);
    // Its class by what it asks; what only the node can judge reads as phone here.
    if (limit !== 0 && remotePayloadClass(channel, list) === 'phone') limit = Math.max(limit, PHONE_BOUND_MS);
    return this._request({ t: 'invoke', channel, args: list }, limit);
  }

  call(method, params = {}, { timeoutMs } = {}) {
    let limit = timeoutMs ?? this.defaultTimeoutMs;
    if (remoteClassOf(method) === 'phone') limit = Math.max(limit, PHONE_BOUND_MS);
    return this._request({ t: 'call', method, params }, limit);
  }

  send(channel, args = []) {
    if (!this.connected) return false;
    this._sendFrame(this.session, JSON.stringify({ t: 'send', channel, args: Array.isArray(args) ? args : [args] }));
    return true;
  }

  // Only while enrolling. The QR is built here: the node never sees `n`.
  async enroll(label) {
    const session = this.session;
    if (this.status !== 'enrolling' || !session) throw failure('NOT_ENROLLING');
    if (session.readyService && !this.enrollment) throw failure('ENROLL_RECORDED');
    const value = await this._enrollCall(session, 'window.enroll', { label });
    if (!value || typeof value.request_id !== 'string' || typeof value.expires_at !== 'string') throw failure('ENROLL_MALFORMED');
    if (!this.enrollment) this.enrollment = { nonce: crypto.randomBytes(QR_NONCE_BYTES), key: session.provedKey, left: MAX_CODE_ATTEMPTS };
    this.requestId = value.request_id;
    return {
      request_id: value.request_id,
      expires_at: value.expires_at,
      qr: qrFor({ devicePublicKey: this.publicKey, nodePublicKey: this.enrollment.key, nonce: this.enrollment.nonce })
    };
  }

  // What the node says of the request. It proves nothing and changes nothing here.
  async enrollStatus() {
    const session = this.session;
    if (!session || !session.opened || (this.status !== 'enrolling' && !this.awaitingRecord)) throw failure('NOT_ENROLLING');
    if (!this.requestId) return { state: 'unknown' };
    const value = await this._enrollCall(session, 'window.enrollStatus', { request_id: this.requestId });
    if (!value || typeof value.state !== 'string') throw failure('ENROLL_MALFORMED');
    return { state: value.state };
  }

  // The owner's code, over the key the handshake proved. A key is trusted from here.
  confirmCode(code) {
    const attempt = this.enrollment;
    if (!attempt) return { ok: false, attemptsLeft: MAX_CODE_ATTEMPTS, code: 'NOT_ENROLLING' };
    const typed = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
    if (!CODE_RE.test(typed)) return { ok: false, attemptsLeft: attempt.left, code: 'CODE_MALFORMED' };
    const expected = enrollCode({ nonce: attempt.nonce, devicePublicKey: this.publicKey, nodePublicKey: attempt.key });
    if (!sameCode(typed, expected)) {
      attempt.left -= 1;
      if (attempt.left > 0) return { ok: false, attemptsLeft: attempt.left };
      this._restartEnrollment();
      return { ok: false, attemptsLeft: 0 };
    }
    if (!this._savePin(attempt.key)) return { ok: false, attemptsLeft: attempt.left, code: 'PIN_NOT_SAVED' };
    attempt.nonce.fill(0);
    this.enrollment = null;
    const session = this.session;
    if (session && session.readyService) {
      this._promote(session, session.readyService);
    } else {
      this.awaitingRecord = true;
      if (session && session.opened) this._setState('connecting');
    }
    return { ok: true, attemptsLeft: MAX_CODE_ATTEMPTS };
  }

  // A throw changes nothing. A promise that fails later fails the tab: the key is not
  // stored, and a session that believed it must not go on.
  _savePin(key) {
    if (this.pin) return true;
    let saved;
    try {
      saved = this.onNodeKey(Buffer.from(key));
    } catch (err) {
      log.warn(`saving a node key failed: ${err.message}`);
      return false;
    }
    this.pin = key;
    if (saved && typeof saved.then === 'function') {
      saved.then(null, (err) => {
        log.warn(`saving a node key failed: ${err && err.message}`);
        this.pin = null;
        this.awaitingRecord = false;
        if (this.session) this._end(this.session, HOLD('PIN_NOT_SAVED'));
        else this._applyOutcome(HOLD('PIN_NOT_SAVED'));
      });
    }
    return true;
  }

  // Five wrong codes: a new key exchange, then a new n and a new QR.
  _restartEnrollment() {
    this.enrollment.nonce.fill(0);
    this.enrollment = null;
    this.requestId = null;
    const outcome = RETRY('ENROLL_CODE_FAILED', { prompt: true });
    if (this.session) this._end(this.session, outcome, { goodbye: true });
    else this._applyOutcome(outcome);
  }

  _enrollCall(session, method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const text = JSON.stringify({ t: 'call', id, method, params });
    if (Buffer.byteLength(text) > ENROLL_FRAME_MAX) return Promise.reject(failure('ENROLL_LABEL_TOO_LONG'));
    return this._track(session, id, text, this.defaultTimeoutMs);
  }

  _request(frame, limit) {
    if (!this.connected) return Promise.reject(failure('SERVICE_UNREACHABLE'));
    const id = this.nextId;
    this.nextId += 1;
    let text;
    try {
      // `t` then `id` first: the node reads the id of an oversized frame from its prefix.
      text = JSON.stringify({ t: frame.t, id, ...frame });
    } catch (err) {
      return Promise.reject(new BridgeError('MALFORMED', err.message));
    }
    return this._track(this.session, id, text, limit);
  }

  _track(session, id, text, limit) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (limit > 0) {
        entry.timer = this.setTimer(() => {
          this.pending.delete(id);
          reject(failure('BRIDGE_TIMEOUT'));
        }, limit);
      }
      this.pending.set(id, entry);
      this._sendFrame(session, text, (err) => {
        if (!this.pending.delete(id)) return;
        if (entry.timer !== null) this.clearTimer(entry.timer);
        reject(err);
      });
    });
  }

  // Every frame goes by the sender. Only a frame too large is the caller's alone.
  _sendFrame(session, text, onRefused = null) {
    session.sender.send(Buffer.from(text, 'utf8')).catch((err) => {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        if (onRefused) onRefused(failure('PAYLOAD_TOO_LARGE'));
      } else if (err.code === 'SEND_QUEUE_FULL') {
        this._end(session, RETRY('WINDOW_BUSY'), { socketCode: CLOSE.TRY_AGAIN });
      } else if (err.code !== 'SEND_STOPPED') {
        this._end(session, RETRY('SERVICE_UNREACHABLE'));
      }
    });
  }

  async _attempt() {
    this._clearRetry();
    this._setState('connecting');
    try {
      const token = await this._token();
      if (this.stopped) throw Object.assign(failure('CANCELLED'), { outcome: { code: 'CANCELLED', local: true } });
      return await this._open(token);
    } catch (err) {
      const outcome = err.outcome || RETRY('SERVICE_UNREACHABLE');
      this._applyOutcome(outcome);
      throw outcome.local ? err : this.lastError;
    }
  }

  // Forced once after the front door's 4401. A getToken that says retrying is no use
  // holds the tab; any other failure is retried.
  async _token() {
    const force = this.forceToken;
    this.forceToken = false;
    let timer = null;
    try {
      const token = await Promise.race([
        Promise.resolve().then(() => this.getToken({ force })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('getToken timed out')), TOKEN_MS); })
      ]);
      if (typeof token !== 'string' || !token) throw new Error('getToken gave no token');
      return token;
    } catch (err) {
      const hold = Boolean(err && (err.hold === true || err.tokensDead === true));
      const code = hold && typeof err.code === 'string' ? err.code : 'TOKEN_UNAVAILABLE';
      throw Object.assign(failure(code), { outcome: { code, hold, message: hold ? err.message : null } });
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves at the node's first record, with its service, or null for enrolling.
  _open(token) {
    return new Promise((resolve, reject) => {
      const session = {
        ws: null, seal: null, transport: null, sender: null, heartbeat: null, sessionId: null,
        sealReady: false, opened: false, ended: false, sawEnrolling: false, rawBytes: 0, firstTimer: null, refusalTimer: null,
        provedKey: null, readyService: null, resolve, reject
      };
      this.attaches.push(this.now());
      const url = `${this.origin.replace(/^https:/, 'wss:')}${WINDOW_PATH}?node=${this.nodeId}`;
      let ws;
      try {
        ws = new this.WS(url, [SUBPROTOCOL], {
          ...SOCKET_OPTIONS,
          handshakeTimeout: LIMITS.handshakeMs,
          rejectUnauthorized: true,
          headers: { authorization: `Bearer ${token}` }
        });
      } catch (err) {
        log.warn(`a window socket could not start: ${err.message}`);
        reject(Object.assign(failure('FRONT_DOOR_UNREACHABLE'), { outcome: RETRY('FRONT_DOOR_UNREACHABLE') }));
        return;
      }
      session.ws = ws;
      this.session = session;
      ws.on('upgrade', (res) => { session.sessionId = res.headers[SESSION_HEADER] || null; });
      ws.on('open', () => this._onOpen(session));
      ws.on('close', (code, reason) => this._onSocketClose(session, code, reason ? reason.toString('utf8') : ''));
      ws.on('error', (err) => {
        log.debug(`a window socket failed: ${err.message}`);
        if (!session.transport) this._end(session, RETRY('FRONT_DOOR_UNREACHABLE'));
      });
      ws.on('unexpected-response', () => this._end(session, RETRY('FRONT_DOOR_UNREACHABLE')));
    });
  }

  // Wrapped only now: before `open` ws has no TCP stream to count.
  _onOpen(session) {
    if (session.ended) return;
    session.transport = wsTransport(session.ws);
    session.transport.on('raw', (chunk) => this._countRaw(session, chunk.length));
    session.transport.on('data', (message, isBinary) => this._onMessage(session, message, isBinary));
    // A refusal is a 101 and then a close frame, with no session id.
    if (!session.sessionId) {
      session.refusalTimer = setTimeout(() => this._end(session, RETRY('HANDSHAKE_FAILED')), REFUSAL_WAIT_MS);
      session.refusalTimer.unref?.();
      return;
    }
    try {
      session.seal = WindowSeal.window({
        sessionId: session.sessionId,
        deviceId: this.deviceId,
        publicKey: this.publicKey,
        sign: this.sign,
        pin: this.pin,
        write: (bytes) => {
          session.heartbeat?.sent();
          return session.transport.send(bytes);
        },
        onClose: (close) => this._onSealClose(session, close)
      });
    } catch (err) {
      log.warn(`a seal could not start: ${err.code || err.message}`);
      this._end(session, RETRY('HANDSHAKE_FAILED'));
      return;
    }
    this._step(session, null);
  }

  _countRaw(session, bytes) {
    if (session.sealReady || session.ended) return;
    session.rawBytes += bytes;
    if (session.rawBytes > PRE_READY_BYTES) this._end(session, RETRY('HANDSHAKE_FAILED'), { terminate: true });
  }

  _onMessage(session, message, isBinary) {
    if (session.ended || !session.seal) return;
    if (isBinary === false) {
      const after = session.sealReady;
      this._end(session, RETRY(after ? 'SEAL_FAILED' : 'HANDSHAKE_FAILED'), { socketCode: after ? CLOSE.MALFORMED : CLOSE.BAD_SIGNATURE });
      return;
    }
    this._step(session, message);
  }

  _step(session, message) {
    session.seal.next(message)
      .then((result) => this._onSealResult(session, result))
      .catch((err) => {
        log.warn(`a sealed message failed: ${err.message}`);
        this._end(session, RETRY('SEAL_FAILED'));
      });
  }

  _onSealResult(session, { frames, close, ready, peer }) {
    if (session.ended) return;
    if (close) {
      this._onSealClose(session, close);
      return;
    }
    if (ready && !session.sealReady && !this._onSealReady(session, peer)) return;
    if (!session.sealReady) return;
    session.heartbeat.received();
    for (const frame of frames) {
      if (session.ended) return;
      this._onFrame(session, frame);
    }
  }

  // auth_w is out. A node id is its key's, so the entry's id names one key. A front door
  // that lists a fake node's id passes this; the code is what stops that.
  _onSealReady(session, peer) {
    if (peer.nodeId !== this.nodeId) {
      this._end(session, HOLD('SERVICE_KEY_CHANGED'));
      return false;
    }
    session.sealReady = true;
    session.provedKey = peer.publicKey;
    session.sender = createFrameSender({ seal: this._countingSeal(session) });
    session.heartbeat = startHeartbeat({
      ...(this.timers.now ? { now: this.timers.now } : {}),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      ping: () => session.seal.ping(),
      onSilence: (close) => this._onSealClose(session, close)
    });
    session.firstTimer = setTimeout(() => this._end(session, RETRY('HANDSHAKE_FAILED')), LIMITS.handshakeMs);
    return true;
  }

  // The sender asks for a frame's records one at a time; a large one says how far the
  // socket has taken it.
  _countingSeal(session) {
    const { seal } = session;
    const emit = (progress) => this._emit('progress', progress);
    return {
      records(frame) {
        const steps = seal.records(frame);
        if (frame.length <= RECORD_MAX) return steps;
        return (function* counted() {
          let sent = 0;
          const total = frame.length;
          for (const step of steps) {
            sent += Math.min(RECORD_MAX, total - sent);
            const upTo = sent;
            step.written.then(() => emit({ sent: upTo, total }), () => {});
            yield step;
          }
        }());
      }
    };
  }

  _onFrame(session, bytes) {
    const trusted = this.pin !== null && session.provedKey.equals(this.pin);
    if (!trusted && bytes.length > UNPROVEN_FRAME_MAX) {
      this._end(session, RETRY('SEAL_FAILED'));
      return;
    }
    let frame = null;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      frame = null;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
      if (session.opened) log.warn('the node sent a malformed frame');
      else this._end(session, RETRY('HANDSHAKE_FAILED'));
      return;
    }
    if (frame.t === 'ready') this._onReadyFrame(session, frame, trusted);
    else if (frame.t === 'enrolling') this._onEnrollingFrame(session);
    else if (!session.opened) this._end(session, RETRY('HANDSHAKE_FAILED'));
    else if (frame.t === 'result') this._onResult(frame);
    else if (frame.t === 'enrollState') this._emit('enrollState', typeof frame.state === 'string' ? frame.state : 'unknown');
    else if (frame.t === 'event' && this.status === 'connected') this._emit('event', frame.channel, frame.payload);
    else if (frame.t === 'bye') log.info('the node is stopping');
  }

  // From a key not yet confirmed, `ready` only sets something aside for the code.
  _onReadyFrame(session, frame, trusted) {
    if (!frame.service || typeof frame.service !== 'object') {
      this._end(session, RETRY('HANDSHAKE_FAILED'));
      return;
    }
    if (trusted) {
      if (frame.service.protocol !== undefined && frame.service.protocol !== PROTOCOL) this._end(session, HOLD('PROTOCOL_MISMATCH', { authenticated: true }));
      else this._promote(session, frame.service);
      return;
    }
    session.readyService = frame.service;
    if (session.opened) this._setState(this.status);
    else this._enterEnrolling(session);
  }

  _onEnrollingFrame(session) {
    session.sawEnrolling = true;
    if (!session.opened) this._enterEnrolling(session);
  }

  _firstRecord(session) {
    session.opened = true;
    clearTimeout(session.firstTimer);
    this.attempt = 0;
    this.tokenRefusals = 0;
    this.lastError = null;
    this.authenticated = false;
  }

  _enterEnrolling(session) {
    this._firstRecord(session);
    this._setState(this.awaitingRecord ? 'connecting' : 'enrolling');
    session.resolve(null);
  }

  _promote(session, service) {
    this._firstRecord(session);
    this.awaitingRecord = false;
    this.service = service;
    this._setState('connected');
    session.resolve(service);
  }

  _onResult(frame) {
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    if (entry.timer !== null) this.clearTimer(entry.timer);
    if (frame.error !== undefined) entry.reject(new BridgeError(typeof frame.code === 'string' ? frame.code : 'SERVICE_ERROR', String(frame.error)));
    else entry.resolve(frame.value);
  }

  _onSealClose(session, close) {
    if (session.ended) return;
    if (close.reason !== 'peer') {
      this._end(session, sealOutcome(close), { socketCode: close.code });
      return;
    }
    // A key nobody has confirmed proves nothing by sealing, so it only holds the tab.
    const trusted = this.pin !== null && Boolean(session.provedKey) && session.provedKey.equals(this.pin);
    let outcome = sealedOutcome(close.code, { enrolling: session.sawEnrolling || !this.pin });
    // The enroll connection's deadline with the code already typed: the record is still
    // on its way (`device apply`), so go on asking.
    if (this.awaitingRecord && outcome.code === 'NOT_ENROLLED') outcome = RETRY('NOT_ENROLLED');
    this._end(session, { ...outcome, authenticated: trusted }, { socketCode: close.code });
  }

  _onSocketClose(session, code, reason) {
    if (session.ended) return;
    const outcome = !session.transport ? RETRY('FRONT_DOOR_UNREACHABLE') : socketOutcome(code, reason);
    this._end(session, outcome, { socketGone: true });
  }

  // Every way a session ends, once. Nothing here rests on the peer answering.
  _end(session, outcome, { goodbye = false, socketCode = null, socketGone = false, terminate = false } = {}) {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.firstTimer);
    clearTimeout(session.refusalTimer);
    session.heartbeat?.stop();
    session.sender?.stop();
    if (goodbye && session.sealReady) {
      try {
        session.seal.closeRecord(CLOSE.NORMAL);
      } catch (err) {
        log.debug(`no close record went: ${err.code || err.message}`);
      }
    }
    try {
      session.seal?.destroy();
    } catch { /* gone */ }
    this._closeSocket(session, { socketCode, socketGone, terminate });
    if (this.session === session) this.session = null;
    if (session.opened) {
      this._applyOutcome(outcome);
      return;
    }
    session.reject(Object.assign(failure(outcome.code), { outcome }));
  }

  _closeSocket(session, { socketCode, socketGone, terminate }) {
    const { ws } = session;
    if (!ws || socketGone) return;
    try {
      if (terminate || !session.transport) {
        ws.terminate();
        return;
      }
      ws.close(socketCode && socketCode >= 3000 ? socketCode : CLOSE.NORMAL);
    } catch {
      try { ws.terminate(); } catch { /* gone */ }
      return;
    }
    const kill = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, CLOSE_GRACE_MS);
    kill.unref?.();
    ws.once('close', () => clearTimeout(kill));
  }

  _applyOutcome(outcome) {
    this._rejectPending();
    if (outcome.local) {
      if (this.stopped) this._setState('stopped');
      return;
    }
    let effective = outcome;
    if (outcome.refresh) {
      this.tokenRefusals += 1;
      if (this.tokenRefusals >= 2) effective = HOLD('TOKEN_REFUSED');
      else this.forceToken = true;
    }
    this.lastError = new BridgeError(effective.code, effective.message || words(effective.code));
    this.authenticated = effective.authenticated === true;
    if (effective.hold) this.held = true;
    this._scheduleRetry(effective);
    if (this.stopped) this._setState('stopped');
    else this._setState(this.held ? 'failed' : 'disconnected');
  }

  _scheduleRetry(outcome) {
    if (this.stopped || this.held || this.retryTimer) return;
    const roll = this.random();
    let wait;
    if (outcome.rateLimited) {
      this.notBefore = this.now() + RATE_LIMIT_WAIT_MS;
      wait = RATE_LIMIT_WAIT_MS + roll * this.firstRetrySpreadMs;
    } else if (outcome.prompt) {
      [wait] = this.backoffMs;
    } else if (this.attempt === 0) {
      wait = this.backoffMs[0] + roll * this.firstRetrySpreadMs;
    } else {
      const base = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
      wait = base * (1 + this.jitter * roll);
    }
    this.attempt += 1;
    this._armRetry(Math.max(wait, this._slotWait()));
  }

  // However a session keeps dropping, or the schedule starts over, one client stays
  // under its share of the grant's attaches.
  _slotWait() {
    const t = this.now();
    while (this.attaches.length && this.attaches[0] <= t - MINUTE_MS) this.attaches.shift();
    if (this.attaches.length < this.attachesPerMinute) return 0;
    return this.attaches[this.attaches.length - this.attachesPerMinute] + MINUTE_MS - t;
  }

  _armRetry(wait) {
    const ms = Math.max(0, Math.round(wait));
    this.nextRetryAt = this.now() + ms;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect().catch(() => {});
    }, ms);
    this.retryTimer?.unref?.();
  }

  _clearRetry() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  _rejectPending() {
    for (const [id, entry] of this.pending) {
      if (entry.timer !== null) this.clearTimer(entry.timer);
      entry.reject(failure('SERVICE_UNREACHABLE'));
      this.pending.delete(id);
    }
  }

  // A listener's throw would land in a promise chain or a timer, and nothing handles that.
  _emit(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (err) {
      log.warn(`a ${name} listener threw: ${err.message}`);
    }
  }

  _setState(status) {
    this.status = status;
    this._emit('state', this.state);
  }
}

module.exports = {
  RemoteWindowClient,
  DEFAULT_BACKOFF_MS,
  FIRST_RETRY_SPREAD_MS,
  RATE_LIMIT_WAIT_MS,
  ATTACHES_PER_MINUTE,
  PHONE_BOUND_MS,
  MAX_CODE_ATTEMPTS
};
