// The node's side of the splice (R-RW-3). On `window.open` it dials the front door's
// mesh name on its own certificate, checks the served certificate against the pin
// before any byte, and hands the socket to attachSealed. Nothing else signs the dial:
// the seal binds the two ends to each other and to the session id.
const tls = require('tls');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { peerCertFingerprint, timingSafeHexEqual } = require('../mesh/mesh-transport');
const { fromB64url } = require('./keys');
const { SOCKET_OPTIONS } = require('./window-seal');
const { wsTransport } = require('./sealed-socket');

const log = createLogger('desktop-bridge/window-dialer');

// R-RW-36: a front door cannot make the node do handshakes without limit. Counted from
// window.open until the seal is ready or, after a failure, its socket has closed, and
// bounded in time by the dial's timeoutMs, the seal's own deadline and CLOSE_GRACE_MS.
// window-v1 §5 names all three limits.
const PENDING_SEALS_MAX = 4;
// A failed seal's close frame gets this long to go out; a peer that never answers it
// would otherwise hold the socket for ws's 30 s.
const CLOSE_GRACE_MS = 1500;
// Places alone bound sockets, not work: each dial is a TLS handshake and a signature.
const WINDOW_OPENS_PER_MINUTE = 30;
const MINUTE_MS = 60000;
const LOG_KEYS_MAX = 32;
const SESSION_ID_BYTES = 32;

const OFF = Object.freeze({ ok: false, code: 'remote_window_off' });
const TOO_MANY = Object.freeze({ ok: false, code: 'too_many_windows' });
const INVALID = Object.freeze({ ok: false, code: 'invalid_session' });
// Crosses the link, so it names no state of this node. The log has why.
const NOT_SEALING_LINE = 'This node has no phone to seal to: enroll a phone or apply its box key (king-louie-service device apply).';

function isSessionId(value) {
  try {
    return fromB64url(value).length === SESSION_ID_BYTES;
  } catch {
    return false;
  }
}

// For this node's log. A policy that cannot be read is why canSeal() said no.
function whyNotSealing(server) {
  try {
    return server.approvals?.sealPolicy?.whyNot?.() || 'this node cannot seal to a phone';
  } catch {
    return 'the seal policy could not be read';
  }
}

// One line per key per minute, the next one saying how many it stands for: a front door
// can cause these as fast as it can ask.
function coalesced({ warn, now }) {
  const seen = new Map();
  return (key, message, meta = {}) => {
    const k = seen.has(key) || seen.size < LOG_KEYS_MAX ? key : 'other';
    const entry = seen.get(k) || { at: -Infinity, repeated: 0 };
    seen.set(k, entry);
    if (now() - entry.at < MINUTE_MS) {
      entry.repeated += 1;
      return;
    }
    warn(message, entry.repeated ? { ...meta, repeated: entry.repeated } : meta);
    entry.at = now();
    entry.repeated = 0;
  };
}

const defaultWarn = (message, meta) => log.warn(message, meta);
const defaultNow = () => performance.now();

function dialError(code) {
  return Object.assign(new Error(code), { code });
}

function createWindowDialer({ identity, frontDoorPin, server, lookup = null, timeoutMs = 10000, maxPending = PENDING_SEALS_MAX,
  opensPerMinute = WINDOW_OPENS_PER_MINUTE, closeGraceMs = CLOSE_GRACE_MS, warn = defaultWarn, now = defaultNow }) {
  const mesh = new URL(frontDoorPin.mesh_url);
  const pinned = frontDoorPin.mesh_cert_fingerprint;
  // Each place taken and not yet given back. `abort` ends a dial still under way.
  const places = new Set();
  const opens = [];
  const note = coalesced({ warn, now });
  let stopped = false;

  function admitOpen() {
    while (opens.length && now() - opens[0] >= MINUTE_MS) opens.shift();
    if (opens.length >= opensPerMinute) return false;
    opens.push(now());
    return true;
  }

  // A failure gives its place back only when its socket has closed, so the cap bounds
  // sockets too. The close frame gets the grace, then the socket is cut.
  function holdUntilClosed(place) {
    const { socket, ws } = place;
    if (!socket || socket.closed) {
      places.delete(place);
      return;
    }
    const cut = () => {
      try { if (ws) ws.terminate(); } catch { /* gone */ }
      socket.destroy();
    };
    const timer = setTimeout(cut, closeGraceMs);
    place.cut = cut;
    socket.once('close', () => {
      clearTimeout(timer);
      places.delete(place);
    });
    if (stopped) cut();
  }

  // Settles once: with attachSealed's outcome, or a code. The one timer covers TLS and
  // the upgrade; from `open` on the deadline is the seal's.
  function dial(sessionId, place) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket = null;
      let ws = null;
      const settle = (fn, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        place.abort = null;
        fn(value);
        return true;
      };
      const fail = (code) => {
        if (!settle(reject, dialError(code))) return;
        if (ws) {
          try { ws.terminate(); } catch { /* gone */ }
        }
        if (socket) socket.destroy();
      };
      const timer = setTimeout(() => fail('dial_timeout'), timeoutMs);
      place.abort = () => fail('dial_stopped');

      place.socket = tls.connect({
        host: mesh.hostname,
        port: Number(mesh.port) || 443,
        servername: mesh.hostname,
        cert: identity.tlsCert,
        key: identity.tlsKey,
        // The pin below is the check, as in MeshTransport#connectPinned.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        ALPNProtocols: ['http/1.1'],
        ...(lookup ? { lookup } : {})
      });
      socket = place.socket;
      socket.once('error', (err) => fail(err.code || 'dial_failed'));
      socket.once('close', () => fail('dial_closed'));
      socket.once('secureConnect', () => {
        if (settled) return;
        if (!timingSafeHexEqual(peerCertFingerprint(socket), pinned)) {
          fail('frontdoor_key_mismatch');
          return;
        }
        const url = new URL(mesh);
        url.pathname = `/window/v1/${sessionId}`;
        // A throw here would be uncaught, in a socket's event.
        try {
          ws = new WebSocket(url, { ...SOCKET_OPTIONS, createConnection: () => socket });
        } catch (err) {
          fail(err.code || 'dial_failed');
          return;
        }
        place.ws = ws;
        ws.on('error', (err) => fail(err.code || 'dial_refused'));
        ws.once('close', () => fail('dial_closed'));
        // In this tick, not after an await: bytes that came with the 101 are delivered
        // before a promise's continuation runs, and the first message would be lost.
        ws.once('open', () => {
          let attaching;
          try {
            attaching = server.attachSealed({ sessionId, transport: wsTransport(ws) });
          } catch (err) {
            fail(err.code || 'attach_failed');
            return;
          }
          settle(resolve, attaching);
        });
      });
    });
  }

  return {
    // Answers once the dial is under way. A failure is logged by its code (never the
    // session id) and the session is left for the front door's own close.
    async open(params) {
      const sessionId = params?.session_id;
      if (stopped) return OFF;
      if (!isSessionId(sessionId)) return INVALID;
      if (places.size >= maxPending || !admitOpen()) {
        note(TOO_MANY.code, 'window.open refused', { code: TOO_MANY.code });
        return TOO_MANY;
      }
      const place = { abort: null, cut: null, socket: null, ws: null };
      places.add(place);
      // attachSealed rejects on every failed handshake, which a front door can cause at
      // will: this catch is what keeps that from being an unhandled rejection.
      dial(sessionId, place).then(() => places.delete(place), (err) => {
        const code = err.code || 'unknown';
        note(code, 'a window dial failed', { code });
        holdUntilClosed(place);
      });
      return { ok: true };
    },
    pending: () => places.size,
    // A seal past the dial is the bridge server's to end.
    stop() {
      stopped = true;
      for (const place of [...places]) {
        if (place.abort || place.cut) {
          if (place.abort) place.abort();
          if (place.cut) place.cut();
          places.delete(place);
        }
      }
    }
  };
}

// The link methods this node answers while the feature is on and it has a front door
// to dial. Task 9 adds the other three; a method with no row answers remote_window_off.
function createWindowHandlers({ server, dialer, warn = defaultWarn, now = defaultNow }) {
  const note = coalesced({ warn, now });
  return {
    'window.open': async (params) => {
      // R-RW-30: phone-class arguments would otherwise cross the relay in clear.
      if (server._sealRefusal()) {
        note('node_not_sealing', `window.open refused: ${whyNotSealing(server)}`);
        return { ok: false, code: 'node_not_sealing', message: NOT_SEALING_LINE };
      }
      return dialer.open(params);
    }
  };
}

module.exports = { createWindowDialer, createWindowHandlers, PENDING_SEALS_MAX, WINDOW_OPENS_PER_MINUTE, CLOSE_GRACE_MS };
