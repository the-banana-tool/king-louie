// approval-v1 message builders and validators (docs/protocol/approval-v1.md).
// Everything signed goes through here, so the shapes live in one place.
const crypto = require('crypto');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { formatToolPattern } = require('../execution/tool-patterns');
const { seal, open, nodeSigner, deviceIdFromJwk, isDeviceJwk, fromB64url, toB64url, EnvelopeError } = require('./envelope');

class MessageError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'MessageError';
    this.reason = reason;
  }
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Same syntax as TIMESTAMP_RE, but with the date/time fields captured so
// isTimestamp can round-trip them through Date.UTC and catch a
// syntactically valid but nonexistent date (e.g. 2026-02-30), which
// JavaScript's Date silently normalizes forward instead of rejecting.
const TIMESTAMP_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^d-[a-z2-7]{16}$/;
const NODE_ID_RE = /^kl-[a-z2-7]{16}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ACTION_BYTES = 262144;
const SUMMARY_MAX = 300;
const NODE_NAME_MAX = 64;
const ORIGIN_STRING_MAX = 200;
const REASON_MAX = 300;
const TTL_MIN_MS = 30000;
const TTL_MAX_MS = 300000;
const ENROLL_MAX_MS = 10 * 60 * 1000;
const REVOKE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const PLATFORMS = ['ios', 'android', 'demo'];
const STATUS_STATES = ['approved', 'denied', 'expired', 'withdrawn', 'refused'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';

// Code-point length, not UTF-16 units, so a surrogate pair never costs two
// against the cap.
function withinLength(text, max) {
  return isString(text) && Array.from(text).length <= max;
}

function isTimestamp(v) {
  if (!isString(v)) return false;
  const match = TIMESTAMP_PARTS_RE.exec(v);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, frac] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (!Number.isFinite(utc)) return false;
  const dt = new Date(utc);
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
    && dt.getUTCHours() === hour && dt.getUTCMinutes() === minute && dt.getUTCSeconds() === second;
}

const nullOr = (test) => (v) => v === null || test(v);
const iso = (ms) => new Date(ms).toISOString();
const randomNonce = () => crypto.randomBytes(32).toString('base64url');
const clampTtl = (ms) => Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number.isFinite(ms) ? ms : TTL_MAX_MS));

function hasExactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

// Code points, not UTF-16 units, so a cut never leaves a lone surrogate.
function cutSummary(text) {
  const chars = Array.from(String(text));
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : chars.join('');
}

function cloneJson(value) {
  try {
    return JSON.parse(canonicalize(value));
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
}

function toolAction(toolName, params, cwd) {
  const cloned = cloneJson(params === undefined || params === null ? {} : params);
  return {
    kind: 'tool',
    name: String(toolName),
    params: cloned,
    cwd: cwd === undefined || cwd === null ? null : String(cwd),
    summary: cutSummary(formatToolPattern(toolName, cloned))
  };
}

// `validatedParams` are the engine's validated values (defaults applied,
// paths realpath'd); `steps` are the argv each `run` step will execute with
// them substituted, and every `check` as written (parent §8.4). `cwd` is the
// directory the engine will run those steps in (options.cwd) — it changes
// what a relative argv actually does, so it is part of the hashed action,
// not left to be assumed from context. `env` and `timeout` are deliberately
// left out.
function runbookAction(runbook, validatedParams, nodeName, cwd = null) {
  const { substituteArgv } = require('../runbooks/runbook-engine');
  const values = validatedParams || {};
  const steps = (runbook.steps || []).map((step) => (Array.isArray(step.run)
    ? substituteArgv(step.run, values)
    : { check: cloneJson(step.check) }));
  return {
    kind: 'runbook',
    name: String(runbook.name),
    params: cloneJson(values),
    steps: cloneJson(steps),
    cwd: cwd === undefined || cwd === null ? null : String(cwd),
    summary: cutSummary(`Run runbook ${runbook.name} on ${nodeName}`)
  };
}

function envelopeAction({ executorId, caseId, envelopeHash, summary }) {
  return {
    kind: 'envelope',
    name: String(executorId),
    params: { case_id: String(caseId), envelope_hash: String(envelopeHash) },
    summary: cutSummary(summary || `Run ${executorId} for case ${caseId}`)
  };
}

function actionHash(action) {
  let text;
  try {
    text = canonicalize(action);
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
  return sha256b64url(text);
}

function normalizeOrigin(origin) {
  const o = origin || {};
  const out = {
    client: String(o.client || 'king-louie'),
    session: o.session === undefined || o.session === null ? null : String(o.session),
    job_id: o.job_id === undefined || o.job_id === null ? null : String(o.job_id)
  };
  if (out.client === 'desktop') out.deviceId = o.deviceId === undefined || o.deviceId === null ? null : String(o.deviceId);
  return out;
}

function buildRequest({ identity, action, origin, ttlMs = TTL_MAX_MS, now = Date.now(), requestId = null, nonce = null }) {
  let actionText;
  try {
    actionText = canonicalize(action);
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
  if (Buffer.byteLength(actionText, 'utf8') > MAX_ACTION_BYTES) {
    throw new MessageError('action_too_large', `the action is over ${MAX_ACTION_BYTES} bytes`);
  }
  const message = {
    v: 1,
    type: 'kl.approval.request',
    request_id: requestId || crypto.randomUUID(),
    node_id: identity.nodeId,
    node_name: String(identity.nodeName || 'unnamed-node'),
    action,
    action_hash: sha256b64url(actionText),
    origin: normalizeOrigin(origin),
    created_at: iso(now),
    expires_at: iso(now + clampTtl(ttlMs)),
    nonce: nonce || randomNonce()
  };
  const envelope = seal(message, nodeSigner(identity));
  return { message, envelope, bytes: fromB64url(envelope.payload) };
}

function buildStatus({ identity, requestId, state, deviceId = null, reason = null, now = Date.now() }) {
  return seal({
    v: 1,
    type: 'kl.approval.status',
    request_id: requestId,
    node_id: identity.nodeId,
    state,
    device_id: deviceId,
    reason,
    at: iso(now)
  }, nodeSigner(identity));
}

function buildEnrollOpen({ identity, codeId, expiresAt, nonce = null }) {
  return seal({ v: 1, type: 'kl.enroll.open', node_id: identity.nodeId, code_id: codeId, expires_at: iso(expiresAt), nonce: nonce || randomNonce() }, nodeSigner(identity));
}

function buildEnrollDone({ identity, codeId, enroll = null, refused = false, nonce = null }) {
  return seal({ v: 1, type: 'kl.enroll.done', node_id: identity.nodeId, code_id: codeId, enroll, refused: refused === true, nonce: nonce || randomNonce() }, nodeSigner(identity));
}

// HMAC-SHA256 keyed with the raw bytes of a base64url secret (the console
// `code`, or an invite `secret`) over the JCS text of `value`.
function hmacB64url(secretB64url, value) {
  return crypto.createHmac('sha256', fromB64url(secretB64url)).update(canonicalize(value)).digest('base64url');
}

function enrollMac(code, messageWithoutMac) {
  return hmacB64url(code, messageWithoutMac);
}

function inviteMac(secret, device) {
  return hmacB64url(secret, device);
}

// The string a phone signs for device-authenticated phone API calls (§4.5).
// The relay keys replay protection on SHA-256 of this string.
function phoneAuthString(method, pathWithQuery, timestamp, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined || body === null ? '' : String(body), 'utf8');
  const bodyHash = crypto.createHash('sha256').update(bytes).digest('base64url');
  return ['KL-PHONE-V1', String(method).toUpperCase(), pathWithQuery, timestamp, bodyHash].join('\n');
}

function encodeQr(object) {
  return `kl1:${toB64url(Buffer.from(canonicalize(object), 'utf8'))}`;
}

function decodeQr(text) {
  if (typeof text !== 'string' || !text.startsWith('kl1:')) throw new MessageError('malformed', 'not a kl1: code');
  // The base64url decode and the JSON parse both run over attacker-controlled
  // QR text, so their raw errors (EnvelopeError, SyntaxError) must not escape
  // as-is — callers only expect a MessageError from this module.
  let parsed;
  try {
    parsed = JSON.parse(fromB64url(text.slice(4)).toString('utf8'));
  } catch (err) {
    throw new MessageError('malformed', err instanceof Error ? err.message : String(err));
  }
  if (!isPlainObject(parsed) || !isString(parsed.t)) throw new MessageError('malformed', 'QR payload has no type');
  return parsed;
}

// ── Validators ──────────────────────────────────────────────────────────────
// Each returns null when the message is well formed, else the reason.

function checkAction(action) {
  if (!isPlainObject(action) || !withinLength(action.summary, SUMMARY_MAX) || !isString(action.name)) return false;
  if (action.kind === 'tool') return hasExactKeys(action, ['kind', 'name', 'params', 'cwd', 'summary']) && isPlainObject(action.params) && (action.cwd === null || isString(action.cwd));
  if (action.kind === 'runbook') return hasExactKeys(action, ['kind', 'name', 'params', 'steps', 'cwd', 'summary']) && isPlainObject(action.params) && Array.isArray(action.steps) && (action.cwd === null || isString(action.cwd));
  if (action.kind === 'envelope') {
    return hasExactKeys(action, ['kind', 'name', 'params', 'summary']) && isPlainObject(action.params)
      && hasExactKeys(action.params, ['case_id', 'envelope_hash']) && isString(action.params.case_id) && isString(action.params.envelope_hash);
  }
  return false;
}

function checkOrigin(origin) {
  if (!isPlainObject(origin) || !isString(origin.client)) return false;
  const keys = origin.client === 'desktop' ? ['client', 'session', 'job_id', 'deviceId'] : ['client', 'session', 'job_id'];
  return hasExactKeys(origin, keys) && Object.values(origin).every((v) => v === null || withinLength(v, ORIGIN_STRING_MAX));
}

function isDevice(device) {
  if (!isPlainObject(device) || !hasExactKeys(device, ['device_id', 'name', 'platform', 'public_key'])) return false;
  if (!isString(device.name) || device.name.length < 1 || device.name.length > 64) return false;
  if (!PLATFORMS.includes(device.platform) || !isDeviceJwk(device.public_key)) return false;
  return DEVICE_ID_RE.test(device.device_id) && deviceIdFromJwk(device.public_key) === device.device_id;
}

const VALIDATORS = {
  'kl.approval.request': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'node_name', 'action', 'action_hash', 'origin', 'created_at', 'expires_at', 'nonce'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && withinLength(m.node_name, NODE_NAME_MAX) && checkAction(m.action)
    && HASH_RE.test(m.action_hash) && checkOrigin(m.origin) && isTimestamp(m.created_at) && isTimestamp(m.expires_at) && NONCE_RE.test(m.nonce),
  'kl.approval.response': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'action_hash', 'nonce', 'decision', 'expires_at', 'device_id', 'signed_at'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && HASH_RE.test(m.action_hash) && NONCE_RE.test(m.nonce)
    && (m.decision === 'approve' || m.decision === 'deny') && isTimestamp(m.expires_at) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.approval.status': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'state', 'device_id', 'reason', 'at'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && STATUS_STATES.includes(m.state)
    && nullOr((v) => DEVICE_ID_RE.test(v))(m.device_id) && nullOr((v) => withinLength(v, REASON_MAX))(m.reason) && isTimestamp(m.at),
  'kl.device.enroll': (m) => {
    const base = ['v', 'type', 'device', 'enrolled_by', 'created_at', 'expires_at', 'nonce'];
    const consoleEnroll = m.enrolled_by === null;
    if (!hasExactKeys(m, consoleEnroll ? [...base, 'code_id', 'code_mac'] : base)) return false;
    if (!consoleEnroll && !(isString(m.enrolled_by) && DEVICE_ID_RE.test(m.enrolled_by))) return false;
    if (consoleEnroll && !(CODE_ID_RE.test(m.code_id) && HASH_RE.test(m.code_mac))) return false;
    if (!isDevice(m.device) || !isTimestamp(m.created_at) || !isTimestamp(m.expires_at) || !NONCE_RE.test(m.nonce)) return false;
    const span = Date.parse(m.expires_at) - Date.parse(m.created_at);
    return span > 0 && span <= ENROLL_MAX_MS;
  },
  'kl.device.revoke': (m) => {
    if (!hasExactKeys(m, ['v', 'type', 'device_id', 'revoked_by', 'reason', 'created_at', 'expires_at', 'nonce'])) return false;
    if (!DEVICE_ID_RE.test(m.device_id) || !DEVICE_ID_RE.test(m.revoked_by) || !withinLength(m.reason, 200)) return false;
    if (!isTimestamp(m.created_at) || !isTimestamp(m.expires_at) || !NONCE_RE.test(m.nonce)) return false;
    const span = Date.parse(m.expires_at) - Date.parse(m.created_at);
    return span > 0 && span <= REVOKE_MAX_MS;
  },
  'kl.enroll.open': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'code_id', 'expires_at', 'nonce'])
    && NODE_ID_RE.test(m.node_id) && CODE_ID_RE.test(m.code_id) && isTimestamp(m.expires_at) && NONCE_RE.test(m.nonce),
  'kl.enroll.done': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'code_id', 'enroll', 'refused', 'nonce'])
    && NODE_ID_RE.test(m.node_id) && CODE_ID_RE.test(m.code_id) && (m.enroll === null || isPlainObject(m.enroll))
    && typeof m.refused === 'boolean' && NONCE_RE.test(m.nonce),
  'kl.audit.slice': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'entries', 'head', 'anchor', 'created_at'])
    && NODE_ID_RE.test(m.node_id) && Array.isArray(m.entries) && isPlainObject(m.head) && isPlainObject(m.anchor)
    && Number.isInteger(m.head.seq) && nullOr(isString)(m.head.hash) && Number.isInteger(m.anchor.seq) && nullOr(isString)(m.anchor.prev)
    && isTimestamp(m.created_at),
  'kl.audit.slice.head': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'seq', 'hash', 'at'])
    && NODE_ID_RE.test(m.node_id) && Number.isInteger(m.seq) && nullOr(isString)(m.hash) && isTimestamp(m.at)
};

// F5 (`kl.lease.*`) and C4 (`kl.question.answer`) register their own types.
// `Object.hasOwn` (not `VALIDATORS[type]`) so a type name that collides with
// an inherited Object.prototype member (`constructor`, `toString`, …) is
// judged by whether *this* map has it, never by the prototype chain.
function registerMessageValidator(type, validator) {
  if (Object.hasOwn(VALIDATORS, type)) throw new Error(`message type ${type} already has a validator`);
  VALIDATORS[type] = validator;
}

// Exported for callers that explicitly want the shared device-message
// fields (device_id, node_id, nonce) checked on their own registered type;
// validateMessage no longer falls back to it for an unregistered type.
function genericDeviceMessage(m) {
  return DEVICE_ID_RE.test(m.device_id) && NODE_ID_RE.test(m.node_id) && NONCE_RE.test(m.nonce);
}

function validateMessage(type, message) {
  try {
    if (!isPlainObject(message) || message.type !== type || !Number.isInteger(message.v)) return 'malformed';
    if (message.v !== 1) return 'unsupported_version';
    // Object.hasOwn: an unregistered type (including one that collides with
    // an inherited name like 'constructor') is simply unrecognised, never
    // silently accepted through the prototype chain.
    if (!Object.hasOwn(VALIDATORS, type)) return 'malformed';
    return VALIDATORS[type](message) === true ? null : 'malformed';
  } catch {
    return 'malformed';
  }
}

// Opens an envelope and validates it as `type`: { message, bytes } or a
// MessageError whose reason is malformed / unsupported_version.
function parseMessage(envelope, type) {
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    throw new MessageError('malformed', err instanceof EnvelopeError ? err.message : String(err));
  }
  const reason = validateMessage(type, opened.message);
  if (reason) throw new MessageError(reason, `not a valid ${type}`);
  return opened;
}

const parseResponse = (envelope) => parseMessage(envelope, 'kl.approval.response');
const parseEnroll = (envelope) => parseMessage(envelope, 'kl.device.enroll');
const parseRevoke = (envelope) => parseMessage(envelope, 'kl.device.revoke');

module.exports = {
  MessageError,
  TIMESTAMP_RE,
  NONCE_RE,
  CODE_ID_RE,
  DEVICE_ID_RE,
  NODE_ID_RE,
  MAX_ACTION_BYTES,
  TTL_MIN_MS,
  TTL_MAX_MS,
  PLATFORMS,
  iso,
  isTimestamp,
  randomNonce,
  clampTtl,
  cutSummary,
  toolAction,
  runbookAction,
  envelopeAction,
  actionHash,
  normalizeOrigin,
  buildRequest,
  buildStatus,
  buildEnrollOpen,
  buildEnrollDone,
  enrollMac,
  inviteMac,
  phoneAuthString,
  encodeQr,
  decodeQr,
  validateMessage,
  registerMessageValidator,
  genericDeviceMessage,
  parseMessage,
  parseResponse,
  parseEnroll,
  parseRevoke
};
