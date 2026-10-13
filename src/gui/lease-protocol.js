// src/gui/lease-protocol.js
// lease-v1 (fleet stage 5 spec §3.6, §4.1; docs/protocol/lease-v1.md): pure
// builders and checks for computer-use leases. Node-signed: request, status,
// view. Phone-signed: grant, revoke, watch, each through F3's
// verifyDeviceEnvelope (checks 1–8) and then the lease checks (9–12).
// Loaded by the relay (relay-extension.js) too, so it requires no agent code.
const crypto = require('crypto');
const { seal, open, nodeSigner, verifyEd25519, EnvelopeError } = require('../approvals/envelope');
const messages = require('../approvals/messages');
const { verifyDeviceEnvelope } = require('../approvals/verify-device');
const { canonicalize, sha256b64url } = require('../platform/jcs');

const { isTimestamp, NONCE_RE, DEVICE_ID_RE, NODE_ID_RE, normalizeOrigin, iso, randomNonce } = messages;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// A contact token (R-F5-15, second security review finding 3): 16 random
// bytes the node puts in every status and view it signs. A watch echoes the
// newest one its phone has applied, which shows the watch was signed after
// the node issued that token.
const CONTACT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const CONTACT_TOKEN_BYTES = 16;
const newContactToken = () => crypto.randomBytes(CONTACT_TOKEN_BYTES).toString('base64url');
const LEASE_LIMITS = Object.freeze(['no_lock_detect', 'no_human_yield']);
const STATES = Object.freeze(['pending', 'active', 'suspended', 'ended']);
const REVOKE_REASONS = Object.freeze(['kill_switch', 'owner']);
const REQUEST_TTL_MS = 5 * 60 * 1000;
const VIEW_MAX_BYTES = 262144;
const MAX_MINUTES = 60;
// Reason → the approval-v1 check number it belongs to (program §4.12).
const CHECK_OF = Object.freeze({
  malformed: 1, unsupported_version: 1, unknown_device: 3, demo_device: 4, test_key: 4, revoked_device: 5,
  bad_signature: 6, wrong_node: 7, replay: 8, already_decided: 8, unknown_request: 9, unknown_lease: 9,
  nonce_mismatch: 10, lease_hash_mismatch: 10, expires_mismatch: 10, expired: 11,
  lease_changed: 12, job_closed: 12, apps_not_requested: 12, minutes_out_of_range: 12
});

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const within = (v, max) => isString(v) && Array.from(v).length <= max;
const nullOr = (test) => (v) => v === null || test(v);
function exactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}
const isStringList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every((s) => isString(s) && each(s));
const uniqueSorted = (list) => list.every((x, i) => i === 0 || list[i - 1] < x);

function checkApp(a) {
  return isPlainObject(a) && exactKeys(a, ['id', 'name', 'path', 'processes'])
    && APP_ID_RE.test(a.id) && within(a.name, 64) && within(a.path, 1024) && isStringList(a.processes, 16, (s) => within(s, 1024));
}

function checkLease(l) {
  return isPlainObject(l) && exactKeys(l, ['kind', 'job_id', 'apps', 'max_minutes', 'reason', 'resumes', 'limits'])
    && l.kind === 'computer_use' && within(l.job_id, 200) && l.job_id.length > 0
    && Array.isArray(l.apps) && l.apps.length >= 1 && l.apps.length <= 8 && l.apps.every(checkApp)
    && new Set(l.apps.map((a) => a.id)).size === l.apps.length
    && Number.isInteger(l.max_minutes) && l.max_minutes >= 1 && l.max_minutes <= MAX_MINUTES
    && within(l.reason, 280) && l.reason.length > 0
    && nullOr((v) => UUID_V4_RE.test(v))(l.resumes)
    && isStringList(l.limits, LEASE_LIMITS.length, (s) => LEASE_LIMITS.includes(s)) && uniqueSorted(l.limits);
}

function checkOrigin(o) {
  return isPlainObject(o) && exactKeys(o, ['client', 'session', 'job_id']) && isString(o.client)
    && Object.values(o).every((v) => v === null || within(v, 200));
}

function checkFrame(f) {
  return f === null || (isPlainObject(f) && exactKeys(f, ['mime', 'width', 'height', 'sha256', 'data'])
    && f.mime === 'image/jpeg' && Number.isInteger(f.width) && Number.isInteger(f.height) && f.width > 0 && f.height > 0
    && HASH_RE.test(f.sha256) && isString(f.data) && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data));
}

function checkAction(a) {
  return isPlainObject(a) && exactKeys(a, ['seq', 'at', 'tool', 'summary', 'result'])
    && Number.isInteger(a.seq) && isTimestamp(a.at) && within(a.tool, 32) && within(a.summary, 120) && within(a.result, 80);
}

const VALIDATORS = {
  'kl.lease.request': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'node_name', 'lease', 'lease_hash', 'origin', 'created_at', 'expires_at', 'nonce'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && within(m.node_name, 64)
    && checkLease(m.lease) && HASH_RE.test(m.lease_hash) && checkOrigin(m.origin) && isTimestamp(m.created_at) && isTimestamp(m.expires_at)
    && Date.parse(m.expires_at) > Date.parse(m.created_at) && Date.parse(m.expires_at) - Date.parse(m.created_at) <= REQUEST_TTL_MS
    && NONCE_RE.test(m.nonce) && (m.lease.resumes === null || m.lease.resumes === m.lease_id),
  'kl.lease.grant': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'lease_hash', 'nonce', 'decision', 'grant', 'expires_at', 'device_id', 'signed_at'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && HASH_RE.test(m.lease_hash)
    && NONCE_RE.test(m.nonce) && isTimestamp(m.expires_at) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at)
    && ((m.decision === 'deny' && m.grant === null)
      || (m.decision === 'grant' && isPlainObject(m.grant) && exactKeys(m.grant, ['apps', 'minutes'])
        && isStringList(m.grant.apps, 8, (s) => APP_ID_RE.test(s)) && m.grant.apps.length >= 1
        && Number.isInteger(m.grant.minutes) && m.grant.minutes >= 1 && m.grant.minutes <= 1440)),
  'kl.lease.revoke': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'reason', 'device_id', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && REVOKE_REASONS.includes(m.reason)
    && DEVICE_ID_RE.test(m.device_id) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.watch': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'device_id', 'contact_token', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && DEVICE_ID_RE.test(m.device_id)
    && nullOr((v) => isString(v) && CONTACT_TOKEN_RE.test(v))(m.contact_token) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.status': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'state', 'locked', 'reason', 'expires_at', 'contact_token', 'granted_by'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && STATES.includes(m.state) && typeof m.locked === 'boolean' && nullOr((v) => within(v, 64))(m.reason) && nullOr(isTimestamp)(m.expires_at)
    && isString(m.contact_token) && CONTACT_TOKEN_RE.test(m.contact_token)
    && nullOr((g) => isPlainObject(g) && exactKeys(g, ['device_id', 'name']) && DEVICE_ID_RE.test(g.device_id) && nullOr((n) => within(n, 64) && n.length > 0)(g.name))(m.granted_by),
  'kl.lease.view': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'to_device', 'state', 'locked', 'remaining_s', 'foreground', 'frame', 'frame_dropped', 'actions', 'contact_token'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && isString(m.contact_token) && CONTACT_TOKEN_RE.test(m.contact_token)
    && DEVICE_ID_RE.test(m.to_device) && STATES.includes(m.state) && typeof m.locked === 'boolean'
    && Number.isInteger(m.remaining_s) && m.remaining_s >= 0
    && isPlainObject(m.foreground) && exactKeys(m.foreground, ['app_id', 'matches']) && nullOr((v) => APP_ID_RE.test(v))(m.foreground.app_id) && typeof m.foreground.matches === 'boolean'
    && checkFrame(m.frame) && typeof m.frame_dropped === 'boolean'
    && Array.isArray(m.actions) && m.actions.length <= 50 && m.actions.every(checkAction)
};

for (const [type, validator] of Object.entries(VALIDATORS)) {
  try {
    messages.registerMessageValidator(type, validator);
  } catch (err) {
    if (!/already has a validator/.test(err.message)) throw err;
  }
}

const leaseHash = (lease) => sha256b64url(canonicalize(lease));

function buildLeaseRequest({ identity, nodeName, jobId, apps, maxMinutes, reason, resumes = null, limits = [], origin, now = Date.now(), requestId = null, leaseId = null, nonce = null }) {
  const lid = leaseId || crypto.randomUUID();
  const lease = {
    kind: 'computer_use',
    job_id: String(jobId),
    apps: apps.map((a) => ({ id: a.id, name: a.name, path: a.path, processes: [...a.processes] })),
    max_minutes: maxMinutes,
    reason: String(reason),
    resumes: resumes ? lid : null,
    limits: [...new Set(limits)].filter((l) => LEASE_LIMITS.includes(l)).sort()
  };
  const message = {
    v: 1,
    type: 'kl.lease.request',
    request_id: requestId || crypto.randomUUID(),
    lease_id: lid,
    node_id: identity.nodeId,
    node_name: String(nodeName || identity.nodeName || 'unnamed-node'),
    lease,
    lease_hash: leaseHash(lease),
    origin: (({ client, session, job_id: j }) => ({ client, session, job_id: j }))(normalizeOrigin(origin)),
    created_at: iso(now),
    expires_at: iso(now + REQUEST_TTL_MS),
    nonce: nonce || randomNonce()
  };
  return { message, envelope: seal(message, nodeSigner(identity)) };
}

// contactToken: the caller's (the lease manager remembers when it issued
// each one); a status or view built without one gets a token nobody knows,
// which no watch can make contact with.
// grantedBy (R-F5-18): { deviceId, name } of the phone whose grant made the
// lease, or null while nobody has granted it. A phone that did not grant a
// lease shows this beside its Stop.
function buildLeaseStatus({ identity, leaseId, seq, state, locked = false, reason = null, expiresAt = null, contactToken = null, grantedBy = null, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.status', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), state, locked,
    reason: reason === null || reason === undefined ? null : String(reason).slice(0, 64),
    expires_at: expiresAt === null || expiresAt === undefined ? null : iso(expiresAt),
    contact_token: contactToken || newContactToken(),
    granted_by: grantedBy && grantedBy.deviceId ? { device_id: grantedBy.deviceId, name: typeof grantedBy.name === 'string' && grantedBy.name ? grantedBy.name : null } : null
  }, nodeSigner(identity));
}

function buildLeaseView({ identity, leaseId, seq, toDevice, state, locked, remainingS, foreground, frame, frameDropped, actions, contactToken = null, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.view', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), to_device: toDevice, state, locked,
    remaining_s: Math.max(0, Math.floor(remainingS)), foreground, frame, frame_dropped: frameDropped === true, actions,
    contact_token: contactToken || newContactToken()
  }, nodeSigner(identity));
}

const reject = (reason) => ({ accepted: false, check: CHECK_OF[reason] || null, reason });
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// jobOpen fails closed (R-F5-7): a caller that passes none gets job_closed.
function verifyLeaseGrant(envelope, { approverStore, nodeId, nonces, pending, guiApps, jobOpen = () => false, guiMaxMinutes = MAX_MINUTES }, now = Date.now()) {
  const device = verifyDeviceEnvelope(envelope, { approverStore, type: 'kl.lease.grant', nodeId, nonces });
  if (!device.ok) return reject(device.reason);
  const m = device.message;
  const request = pending.get(m.request_id);
  if (!request || request.lease_id !== m.lease_id) return reject('unknown_request');
  if (m.nonce !== request.nonce) return reject('nonce_mismatch');
  if (m.lease_hash !== request.lease_hash) return reject('lease_hash_mismatch');
  if (m.expires_at !== request.expires_at) return reject('expires_mismatch');
  if (!(now <= Date.parse(request.expires_at))) return reject('expired');
  if (leaseHash(request.lease) !== m.lease_hash) return reject('lease_changed');
  for (const app of request.lease.apps) {
    const live = guiApps && Object.hasOwn(guiApps, app.id) ? guiApps[app.id] : null;
    if (!live || live.path !== app.path || !sameList(live.processes, app.processes)) return reject('lease_changed');
  }
  if (!jobOpen(request.lease.job_id)) return reject('job_closed');
  if (m.decision === 'grant') {
    const requested = request.lease.apps.map((a) => a.id);
    const apps = m.grant.apps;
    if (new Set(apps).size !== apps.length || !apps.every((id) => requested.includes(id))) return reject('apps_not_requested');
    const cap = Math.min(request.lease.max_minutes, guiMaxMinutes, MAX_MINUTES);
    if (m.grant.minutes < 1 || m.grant.minutes > cap) return reject('minutes_out_of_range');
  }
  return { accepted: true, check: null, reason: null, message: m, bytes: device.bytes, deviceId: device.deviceId, request };
}

function verifyLeaseControl(type) {
  return (envelope, { approverStore, nodeId, nonces, knownLease }) => {
    const device = verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces });
    if (!device.ok) return reject(device.reason);
    if (!knownLease(device.message.lease_id)) return reject('unknown_lease');
    return { accepted: true, check: null, reason: null, message: device.message, bytes: device.bytes, deviceId: device.deviceId };
  };
}

const verifyLeaseRevoke = verifyLeaseControl('kl.lease.revoke');
const verifyLeaseWatch = verifyLeaseControl('kl.lease.watch');

// What a phone checks on a view (spec §3.10, §4.1): the node's signature
// over the received bytes, the shape, the size, and that the frame is the
// one the node hashed.
function verifyLeaseView(envelope, { nodeId, nodePublicKeyHex, maxBytes = VIEW_MAX_BYTES }) {
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return { accepted: false, reason: 'malformed' };
    throw err;
  }
  if (opened.bytes.length > maxBytes) return { accepted: false, reason: 'too_large' };
  if (envelope.alg !== 'Ed25519' || envelope.kid !== nodeId) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, nodePublicKeyHex)) return { accepted: false, reason: 'bad_signature' };
  if (messages.validateMessage('kl.lease.view', opened.message)) return { accepted: false, reason: 'malformed' };
  if (opened.message.node_id !== nodeId) return { accepted: false, reason: 'wrong_node' };
  const frame = opened.message.frame;
  if (frame) {
    const hash = crypto.createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('base64url');
    if (hash !== frame.sha256) return { accepted: false, reason: 'frame_hash_mismatch' };
  }
  return { accepted: true, reason: null, message: opened.message };
}

function effectiveExpiry({ verifiedAt, minutes, resumeOf = null }) {
  const fresh = verifiedAt + minutes * 60000;
  return resumeOf === null ? fresh : Math.min(fresh, resumeOf);
}

module.exports = {
  LEASE_LIMITS, STATES, REQUEST_TTL_MS, VIEW_MAX_BYTES, CHECK_OF, CONTACT_TOKEN_RE, newContactToken,
  leaseHash, buildLeaseRequest, buildLeaseStatus, buildLeaseView,
  verifyLeaseGrant, verifyLeaseRevoke, verifyLeaseWatch, verifyLeaseView, effectiveExpiry
};
