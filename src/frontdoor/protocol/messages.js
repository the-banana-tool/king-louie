// client-grant-v1 message shapes (docs/protocol/client-grant-v1.md §3):
// phone-signed kl.client.grant, kl.client.revoke, kl.node.enroll,
// kl.node.remove; node-signed kl.node.pair; front-door-signed
// kl.node.pair.accept and kl.relay.repin. F3's approval-v1 shapes are not
// touched: these register through registerMessageValidator, so
// validateMessage() knows them once this module is loaded.
const crypto = require('crypto');
const net = require('net');
const { registerMessageValidator, isTimestamp, iso, randomNonce, NONCE_RE, DEVICE_ID_RE, NODE_ID_RE } = require('../../approvals/messages');
const { seal, nodeSigner, fingerprintGroups, fromB64url, ed25519RawToSpki } = require('../../approvals/envelope');

const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const GRANT_ID_RE = /^gr_[A-Za-z0-9_-]{22}$/;
const PAIRING_ID_RE = /^pr_[A-Za-z0-9_-]{22}$/;
const DCR_CLIENT_ID_RE = /^dcr_[A-Za-z0-9_-]{22}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const SPKI_PIN_RE = /^sha256\/[A-Za-z0-9_-]{43}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const RAW_ED25519_RE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;
const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CAPABILITY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// What normalizeUserCode accepts before mapping: ASCII letters and digits
// only, so toUpperCase() cannot turn a non-ASCII look-alike (dotless i, the
// ff ligature) into the alphabet.
const USER_CODE_INPUT_RE = /^[A-Za-z0-9]{6}$/;
const USER_CODE_INPUT_MAX = 64;
const NODE_PROFILES = ['agent', 'runbook'];
const MAX_SCOPES = 32;
const MAX_MACHINES = 64;
const MAX_CAPABILITIES = 32;
const CLIENT_NAME_MAX = 200;
const URI_MAX = 2048;
const CLIENT_ID_MAX = 512;
const MESH_URL_MAX = 512;
const CERT_PEM_MAX = 8192;
const ED25519_SPKI_LENGTH = 44;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
// RegExp#test coerces its argument (['kl-…'] would pass), so every pattern
// check on a message field goes through here.
const matches = (re, v) => isString(v) && re.test(v);

function hasExactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

// Code points, not UTF-16 units.
function withinLength(text, max, min = 0) {
  if (!isString(text)) return false;
  const n = Array.from(text).length;
  return n >= min && n <= max;
}

// Strictly increasing strings (so sorted and unique), each passing `test`.
function isSortedUnique(list, test, max, min = 0) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return false;
  for (let i = 0; i < list.length; i += 1) {
    if (!isString(list[i]) || !test(list[i])) return false;
    if (i > 0 && !(list[i - 1] < list[i])) return false;
  }
  return true;
}

function isScopeList(list) {
  if (!Array.isArray(list) || list.length > MAX_SCOPES) return false;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!isPlainObject(e) || !hasExactKeys(e, ['scope', 'machines']) || !matches(SCOPE_RE, e.scope)) return false;
    if (i > 0 && !(list[i - 1].scope < e.scope)) return false;
    if (e.machines !== null && !isSortedUnique(e.machines, (n) => MACHINE_NAME_RE.test(n), MAX_MACHINES, 1)) return false;
  }
  return true;
}

function isDnsName(v) {
  return matches(DNS_NAME_RE, v) && net.isIP(v) === 0;
}

function isUrlWithProtocol(v, protocol, max) {
  if (!isString(v) || v.length === 0 || v.length > max) return false;
  try {
    const url = new URL(v);
    return url.protocol === protocol && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const isHttpsUrl = (v, max) => isUrlWithProtocol(v, 'https:', max);

function isClientId(v) {
  return matches(DCR_CLIENT_ID_RE, v) || isHttpsUrl(v, CLIENT_ID_MAX);
}

const isUri = (v) => isString(v) && v.length > 0 && v.length <= URI_MAX;
const nullOr = (test) => (v) => v === null || test(v);

// ── Codes ───────────────────────────────────────────────────────────────────

// What the owner typed on the phone, as the grant carries it: upper case, no
// dash or whitespace, O→0 and I/L→1. null (never a throw) when it is not six
// Crockford characters.
function normalizeUserCode(text) {
  if (!isString(text) || text.length > USER_CODE_INPUT_MAX) return null;
  const compact = text.replace(/[\s-]/g, '');
  if (!USER_CODE_INPUT_RE.test(compact)) return null;
  const s = compact.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return USER_CODE_RE.test(s) ? s : null;
}

function formatUserCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// crypto.randomInt: CSPRNG and unbiased over the 32-character alphabet.
function randomUserCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  return out;
}

// A pairing code (6 words) as both ends hash it: trimmed, lower case, one
// space between words (§4.4).
function normalizePairingCode(text) {
  return String(text === undefined || text === null ? '' : text).trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function pairingCodeHash(code) {
  return crypto.createHash('sha256').update(normalizePairingCode(code), 'utf8').digest('base64url');
}

// ── Keys and fingerprints ───────────────────────────────────────────────────

function rawEd25519(spkiDer) {
  const der = Buffer.isBuffer(spkiDer) ? spkiDer : Buffer.from(String(spkiDer), 'hex');
  if (der.length !== ED25519_SPKI_LENGTH) throw new TypeError('rawEd25519 needs a DER SPKI Ed25519 key');
  const raw = der.subarray(ED25519_SPKI_LENGTH - 32);
  // The same length is not the same key type: the prefix must be Ed25519's.
  if (!ed25519RawToSpki(raw).equals(der)) throw new TypeError('rawEd25519 needs a DER SPKI Ed25519 key');
  return raw.toString('base64url');
}

function spkiHexFromRaw(raw) {
  return ed25519RawToSpki(fromB64url(raw)).toString('hex');
}

// 'kl-3v7q2m4k8d1x9c0a' → 'kl-3v7q 2m4k 8d1x 9c0a' (§3.11 step 1).
function nodeFingerprint(nodeId) {
  return `kl-${fingerprintGroups(nodeId)}`;
}

// ── Validators ──────────────────────────────────────────────────────────────

const VALIDATORS = {
  'kl.client.grant': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'grant_id', 'client_id', 'client_name', 'redirect_uri', 'resource',
    'code_challenge', 'user_code', 'scopes', 'decision', 'nonce', 'device_id', 'signed_at'])
    && matches(NODE_ID_RE, m.frontdoor_id) && matches(GRANT_ID_RE, m.grant_id) && isClientId(m.client_id)
    && withinLength(m.client_name, CLIENT_NAME_MAX) && isUri(m.redirect_uri) && isUri(m.resource)
    && matches(CODE_CHALLENGE_RE, m.code_challenge) && matches(USER_CODE_RE, m.user_code)
    && isScopeList(m.scopes) && ((m.decision === 'approve' && m.scopes.length > 0) || (m.decision === 'deny' && m.scopes.length === 0))
    && matches(NONCE_RE, m.nonce) && matches(DEVICE_ID_RE, m.device_id) && isTimestamp(m.signed_at),
  'kl.client.revoke': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'grant_id', 'challenge', 'device_id', 'signed_at'])
    && matches(NODE_ID_RE, m.frontdoor_id) && matches(GRANT_ID_RE, m.grant_id) && matches(NONCE_RE, m.challenge)
    && matches(DEVICE_ID_RE, m.device_id) && isTimestamp(m.signed_at),
  'kl.node.enroll': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'pairing_id', 'node_id', 'node_name', 'profile', 'public_key',
    'tls_fingerprint', 'replaces', 'decision', 'nonce', 'device_id', 'signed_at'])
    && matches(NODE_ID_RE, m.frontdoor_id) && matches(PAIRING_ID_RE, m.pairing_id) && matches(NODE_ID_RE, m.node_id)
    && matches(NODE_NAME_RE, m.node_name) && NODE_PROFILES.includes(m.profile) && matches(RAW_ED25519_RE, m.public_key)
    && matches(HEX_SHA256_RE, m.tls_fingerprint) && nullOr((v) => matches(NODE_ID_RE, v))(m.replaces)
    && (m.decision === 'approve' || m.decision === 'deny') && matches(NONCE_RE, m.nonce)
    && matches(DEVICE_ID_RE, m.device_id) && isTimestamp(m.signed_at),
  'kl.node.remove': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'node_id', 'challenge', 'device_id', 'signed_at'])
    && matches(NODE_ID_RE, m.frontdoor_id) && matches(NODE_ID_RE, m.node_id) && matches(NONCE_RE, m.challenge)
    && matches(DEVICE_ID_RE, m.device_id) && isTimestamp(m.signed_at),
  'kl.node.pair': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_host', 'code_hash', 'node_id', 'node_name', 'profile', 'capabilities',
    'public_key', 'tls_cert', 'nonce', 'created_at'])
    && isDnsName(m.frontdoor_host) && matches(NONCE_RE, m.code_hash) && matches(NODE_ID_RE, m.node_id)
    && matches(NODE_NAME_RE, m.node_name) && NODE_PROFILES.includes(m.profile)
    && isSortedUnique(m.capabilities, (c) => CAPABILITY_RE.test(c), MAX_CAPABILITIES)
    && matches(RAW_ED25519_RE, m.public_key)
    && isString(m.tls_cert) && m.tls_cert.length <= CERT_PEM_MAX && m.tls_cert.startsWith('-----BEGIN CERTIFICATE-----')
    && matches(NONCE_RE, m.nonce) && isTimestamp(m.created_at),
  'kl.node.pair.accept': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'pairing_id', 'node_id', 'nonce', 'mesh_url',
    'mesh_cert_fingerprint', 'frontdoor_public_key'])
    && matches(NODE_ID_RE, m.frontdoor_id) && matches(PAIRING_ID_RE, m.pairing_id) && matches(NODE_ID_RE, m.node_id)
    && matches(NONCE_RE, m.nonce) && isUrlWithProtocol(m.mesh_url, 'wss:', MESH_URL_MAX)
    && matches(HEX_SHA256_RE, m.mesh_cert_fingerprint) && matches(RAW_ED25519_RE, m.frontdoor_public_key),
  'kl.relay.repin': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'relay', 'old_spki', 'new_spki', 'created_at'])
    && matches(NODE_ID_RE, m.frontdoor_id) && isHttpsUrl(m.relay, URI_MAX) && matches(SPKI_PIN_RE, m.old_spki)
    && matches(SPKI_PIN_RE, m.new_spki) && isTimestamp(m.created_at)
};

for (const [type, validator] of Object.entries(VALIDATORS)) registerMessageValidator(type, validator);

// ── Builders (node and front door; the phone builds its own, §5) ───────────

function buildNodePair({ identity, frontdoorHost, code, profile, capabilities = [], tlsCertPem, nonce = null, now = Date.now() }) {
  return seal({
    v: 1,
    type: 'kl.node.pair',
    frontdoor_host: frontdoorHost,
    code_hash: pairingCodeHash(code),
    node_id: identity.nodeId,
    node_name: identity.nodeName,
    profile,
    capabilities: [...new Set((capabilities || []).map(String))].sort(),
    public_key: rawEd25519(identity.publicKey),
    tls_cert: tlsCertPem,
    nonce: nonce || randomNonce(),
    created_at: iso(now)
  }, nodeSigner(identity));
}

function buildNodePairAccept({ identity, pairingId, nodeId, nonce, meshUrl, meshCertFingerprint }) {
  return seal({
    v: 1,
    type: 'kl.node.pair.accept',
    frontdoor_id: identity.nodeId,
    pairing_id: pairingId,
    node_id: nodeId,
    nonce,
    mesh_url: meshUrl,
    mesh_cert_fingerprint: meshCertFingerprint,
    frontdoor_public_key: rawEd25519(identity.publicKey)
  }, nodeSigner(identity));
}

function buildRelayRepin({ identity, relay, oldSpki, newSpki, now = Date.now() }) {
  return seal({ v: 1, type: 'kl.relay.repin', frontdoor_id: identity.nodeId, relay, old_spki: oldSpki, new_spki: newSpki, created_at: iso(now) }, nodeSigner(identity));
}

module.exports = {
  USER_CODE_ALPHABET,
  USER_CODE_RE,
  GRANT_ID_RE,
  PAIRING_ID_RE,
  DCR_CLIENT_ID_RE,
  CODE_CHALLENGE_RE,
  SPKI_PIN_RE,
  HEX_SHA256_RE,
  RAW_ED25519_RE,
  SCOPE_RE,
  MACHINE_NAME_RE,
  NODE_NAME_RE,
  DNS_NAME_RE,
  isDnsName,
  isClientId,
  isScopeList,
  normalizeUserCode,
  formatUserCode,
  randomUserCode,
  normalizePairingCode,
  pairingCodeHash,
  rawEd25519,
  spkiHexFromRaw,
  nodeFingerprint,
  buildNodePair,
  buildNodePairAccept,
  buildRelayRepin
};
