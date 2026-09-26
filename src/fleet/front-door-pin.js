// <configDir>/front-door.json (fleet stage 4 §4.8): which front door this
// node links to and the two pins that identify it. Written only by an
// administrator's `pair https://…`; read by the service with the same
// ownership check as node.yaml. It holds no secret, and the service account
// must read it, so it is 0644 in the admin-owned directory (Deviation 24).
const fs = require('fs');
const path = require('path');
const { assertAdminOwned } = require('../service/config');
const { writeFileAtomic } = require('../approvals/approver-store');
const { NODE_ID_RE, isTimestamp } = require('../approvals/messages');
const { deriveNodeId } = require('../mesh/node-identity');
const { derivePeerId } = require('../mesh/mesh-identity');
const { spkiHexFromRaw, isDnsName, HEX_SHA256_RE, RAW_ED25519_RE } = require('../frontdoor/protocol/messages');

const PIN_FILE = 'front-door.json';
const PIN_KEYS = ['domain', 'frontdoor_id', 'frontdoor_public_key', 'mesh_cert_fingerprint', 'mesh_url', 'paired_at', 'v'];
const PIN_CONTROLS = {
  decides: 'which front door this node links to',
  selfGrant: 'point the node at a front door of its choosing'
};
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

function validatePin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('front-door.json must be a JSON object');
  const keys = Object.keys(pin).sort();
  if (keys.length !== PIN_KEYS.length || keys.some((k, i) => k !== PIN_KEYS[i])) throw new Error(`front-door.json must have exactly the keys ${PIN_KEYS.join(', ')}`);
  if (pin.v !== 1) throw new Error('front-door.json: unsupported version');
  if (typeof pin.frontdoor_public_key !== 'string' || !RAW_ED25519_RE.test(pin.frontdoor_public_key)) throw new Error('front-door.json: frontdoor_public_key is not a raw Ed25519 key');
  if (!NODE_ID_RE.test(pin.frontdoor_id) || deriveNodeId(spkiHexFromRaw(pin.frontdoor_public_key)) !== pin.frontdoor_id) {
    throw new Error('front-door.json: frontdoor_public_key does not derive frontdoor_id');
  }
  if (!isDnsName(pin.domain)) throw new Error('front-door.json: domain is not a DNS name');
  let url;
  try {
    url = new URL(pin.mesh_url);
  } catch {
    throw new Error('front-door.json: mesh_url is not a URL');
  }
  if (url.protocol !== 'wss:' || url.hostname !== `mesh.${pin.domain}` || url.pathname !== '/mesh/v1' || url.search || url.hash || url.username || url.password) {
    throw new Error(`front-door.json: mesh_url must be wss://mesh.${pin.domain}/mesh/v1`);
  }
  if (typeof pin.mesh_cert_fingerprint !== 'string' || !HEX_SHA256_RE.test(pin.mesh_cert_fingerprint)) throw new Error('front-door.json: mesh_cert_fingerprint is not a hex SHA-256');
  if (!isTimestamp(pin.paired_at)) throw new Error('front-door.json: paired_at is not an RFC 3339 UTC time');
  return pin;
}

function readPin(configDir, { geteuid = defaultGeteuid, adminUid = 0 } = {}) {
  if (!configDir) return null;
  const file = path.join(configDir, PIN_FILE);
  // lstat, not existsSync: a dangling link is refused below, never read as
  // "no front door".
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  assertAdminOwned(file, geteuid, adminUid, PIN_CONTROLS);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  return validatePin(parsed);
}

function writePin(configDir, pin) {
  validatePin(pin);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  writeFileAtomic(path.join(configDir, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`, 0o644);
}

// The RelayClient pin for a front door: the same fields F3's `pair wss://`
// stores, derived from the front door's key (§4.17).
function relayPinFromFrontDoor(pin) {
  const publicKey = spkiHexFromRaw(pin.frontdoor_public_key);
  return { relay_id: pin.frontdoor_id, peerId: derivePeerId(publicKey), publicKey, tlsFingerprint: pin.mesh_cert_fingerprint, frontDoor: true };
}

module.exports = { PIN_FILE, validatePin, readPin, writePin, relayPinFromFrontDoor };
