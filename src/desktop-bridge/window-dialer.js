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
// window.open until the seal is ready or the dial has failed, and bounded in time by
// the dial's timeoutMs and then the seal's own deadline. window-v1 §5 names it.
const PENDING_SEALS_MAX = 4;
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

function dialError(code) {
  return Object.assign(new Error(code), { code });
}

function createWindowDialer({ identity, frontDoorPin, server, lookup = null, timeoutMs = 10000, maxPending = PENDING_SEALS_MAX }) {
  const mesh = new URL(frontDoorPin.mesh_url);
  const pinned = frontDoorPin.mesh_cert_fingerprint;
  // Each place taken and not yet given back. `abort` ends a dial still under way.
  const places = new Set();
  let stopped = false;

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

      socket = tls.connect({
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
        ws = new WebSocket(url, { ...SOCKET_OPTIONS, createConnection: () => socket });
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
    async open({ session_id: sessionId } = {}) {
      if (stopped) return OFF;
      if (!isSessionId(sessionId)) return INVALID;
      if (places.size >= maxPending) return TOO_MANY;
      const place = { abort: null };
      places.add(place);
      // attachSealed rejects on every failed handshake, which a front door can cause at
      // will: this catch is what keeps that from being an unhandled rejection.
      dial(sessionId, place)
        .catch((err) => log.warn('a window dial failed', { code: err.code || 'unknown' }))
        .finally(() => places.delete(place));
      return { ok: true };
    },
    pending: () => places.size,
    // A seal past the dial is the bridge server's to end.
    stop() {
      stopped = true;
      for (const place of [...places]) {
        if (place.abort) {
          place.abort();
          places.delete(place);
        }
      }
    }
  };
}

// The link methods this node answers while the feature is on and it has a front door
// to dial. Task 9 adds the other three; a method with no row answers remote_window_off.
function createWindowHandlers({ server, dialer }) {
  return {
    'window.open': async (params) => {
      // R-RW-30: phone-class arguments would otherwise cross the relay in clear.
      if (server._sealRefusal()) {
        log.warn(`window.open refused: ${whyNotSealing(server)}`);
        return { ok: false, code: 'node_not_sealing', message: NOT_SEALING_LINE };
      }
      return dialer.open(params);
    }
  };
}

module.exports = { createWindowDialer, createWindowHandlers, PENDING_SEALS_MAX };
