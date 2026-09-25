// Desktop bridge wire protocol, version 1 (fleet stage 7 §3.3).
const crypto = require('crypto');

const PROTOCOL = 1;
// 18796, not 18795: F3's relay mesh listener defaults to 18795.
const DEFAULT_DESKTOP_BRIDGE_PORT = 18796;
const MIB = 1024 * 1024;

const LIMITS = Object.freeze({
  preAuthFrameBytes: 4096,
  // Raw socket bytes a pre-auth connection may send before we cut it off,
  // checked against the underlying TCP stream as it arrives (not the
  // reassembled WS message) so an oversized frame is never fully buffered
  // just to be told "too large". Comfortably above preAuthFrameBytes to
  // allow for WS framing overhead and a couple of small handshake frames.
  preAuthSocketBytes: 8192,
  firstFrameMs: 2000,
  handshakeMs: 10000,
  maxPreAuthSockets: 16,
  wsMaxPayload: 80 * MIB,
  frameBytes: 64 * MIB,
  failuresPerDevice: 5,
  failureWindowMs: 60000,
  lockoutMs: 60000,
  deviceRecheckMs: 5000,
  headersTimeoutMs: 10000,
  maxTrackedFailures: 1024
});

const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TRY_AGAIN: 1013,
  MALFORMED: 4400,
  BAD_SIGNATURE: 4401,
  UNKNOWN_DEVICE: 4403,
  OTHER_DEVICE: 4409,
  PROTOCOL_MISMATCH: 4426,
  LOCKED_OUT: 4429
});

const NODE_ID_RE = /^kl-[a-z2-7]{16}$/;
const DEVICE_ID_RE = /^kld-[a-z2-7]{16}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function newNonce() {
  return crypto.randomBytes(32).toString('base64url');
}

// Every field is base32, base64url or decimal, so the newline-joined ASCII
// string cannot be ambiguous and no canonicalization is needed.
function authString(tag, { nodeId, deviceId, port, serverNonce, clientNonce } = {}) {
  if (!NODE_ID_RE.test(String(nodeId)) || !DEVICE_ID_RE.test(String(deviceId))
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !NONCE_RE.test(String(serverNonce)) || !NONCE_RE.test(String(clientNonce))) {
    throw new Error(`${tag}: malformed authentication fields`);
  }
  return [tag, nodeId, deviceId, String(port), serverNonce, clientNonce].join('\n');
}

const buildAuthS = (fields) => authString('kl.desktop.hello.v1', fields);
const buildAuthC = (fields) => authString('kl.desktop.auth.v1', fields);

// The size is checked before JSON.parse ever sees the bytes. Only a string
// or a Buffer is accepted — anything else (an ArrayBuffer, a plain object,
// undefined) fails closed rather than risking a wrong size or a throw from
// `Buffer.from` on something it can't coerce. A non-integer `maxBytes` (a
// caller bug) fails closed the same way rather than comparing against NaN
// or undefined, which would let an oversized frame through.
function parseFrame(data, maxBytes) {
  if (!Number.isInteger(maxBytes)) return { error: 'malformed' };
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) return { error: 'malformed' };
  const size = Buffer.byteLength(data);
  if (size > maxBytes) return { error: 'too-large' };
  let frame;
  try {
    frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return { error: 'malformed' };
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.t !== 'string') return { error: 'malformed' };
  return { frame };
}

// The id of an oversized invoke/call, read from its first bytes without
// parsing the rest (the client always serializes `t` then `id` first). A
// Buffer is sliced to its first 256 bytes BEFORE being turned into a string,
// so an oversized (up to 64 MiB) frame is never fully UTF-8 decoded just to
// throw away everything past the prefix.
function peekFrameId(text) {
  const head = Buffer.isBuffer(text) ? text.subarray(0, 256).toString('utf8') : String(text).slice(0, 256);
  const m = /^\{\s*"t"\s*:\s*"(?:invoke|call)"\s*,\s*"id"\s*:\s*(\d{1,15})/.exec(head);
  return m ? Number(m[1]) : null;
}

// Truncates `text` to at most `maxBytes` UTF-8 bytes, always on a code-point
// boundary. Used for close reasons: the WebSocket protocol caps a close
// frame's reason at 123 bytes and `ws` throws (RangeError) if handed more —
// slicing by JS string length instead of UTF-8 byte length can still exceed
// that budget for non-ASCII text and would silently swallow the close
// reason wherever the throw is caught.
function truncateUtf8(text, maxBytes) {
  const str = String(text);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = '';
  for (const ch of str) {
    const candidate = out + ch;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    out = candidate;
  }
  return out;
}

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

// What the owner sees (spec §9). One place, so the pane, the attached host
// and the tests agree on every word.
const MESSAGES = Object.freeze({
  SERVICE_UNREACHABLE: (port) => `The local King Louie service is not reachable (127.0.0.1:${port}).`,
  BRIDGE_TIMEOUT: 'The local service did not answer in time.',
  ATTACHED_UNAVAILABLE: 'Not available while attached to the local service. Detach in Settings > Local service to use it.',
  CHANNEL_NOT_PROXIED: (channel) => `${channel} is not served over the desktop bridge.`,
  PAYLOAD_TOO_LARGE: 'That request is too large for the local service (64 MiB limit).',
  DEVICE_UNPAIRED: 'The service does not know this desktop. Pair again in Settings > Local service.',
  SERVICE_KEY_CHANGED: (oldId, newId) => `The service's identity changed from ${oldId} to ${newId}. If you reinstalled the service, pair again.`,
  PAIR_NOT_FOUND: 'No local service was found yet. Wait for its fingerprint to appear, then confirm.',
  PAIR_SERVICE_CHANGED: 'The local service changed since its fingerprint was shown. Cancel and start pairing again.',
  PAIR_CONFIRM_STALE: 'This confirm did not say which service it was for. Reopen Settings > Local service and try again.',
  ANOTHER_DEVICE: (label) => `Another desktop (${label}) is attached to this service.`,
  PROTOCOL_MISMATCH: (theirs) => `This app speaks desktop-bridge protocol ${PROTOCOL}; the service speaks ${theirs}. Upgrade the older one.`,
  SERVICE_TOO_OLD: (version, channel) => `The local service (version ${version}) does not support ${channel}. Upgrade the service.`,
  SERVICE_RESTARTED: 'The local service restarted; the reply was lost.',
  DESKTOP_DISCONNECTED_RUN: 'The desktop disconnected; the run was stopped.',
  NO_PROVIDER: 'The service has no provider key yet — import or add one in Providers.',
  SECURE_STORAGE_UNAVAILABLE: "This system has no secure storage; the desktop can't hold a pairing key.",
  RULE_NOT_DESKTOP: 'This rule was set on the service and can only be removed there.',
  PATH_NOT_ACCESSIBLE: (account, target) => `The service runs as ${account || 'its own account'} and cannot read ${target}. Grant that account access or pick another folder.`,
  LOCKED_OUT: 'Too many failed handshakes from this desktop; try again in a minute.',
  BAD_SIGNATURE: "The service rejected this desktop's signature.",
  MALFORMED: 'The desktop bridge handshake failed.'
});

module.exports = {
  PROTOCOL,
  DEFAULT_DESKTOP_BRIDGE_PORT,
  LIMITS,
  CLOSE,
  NODE_ID_RE,
  DEVICE_ID_RE,
  NONCE_RE,
  newNonce,
  buildAuthS,
  buildAuthC,
  parseFrame,
  peekFrameId,
  truncateUtf8,
  BridgeError,
  MESSAGES
};
