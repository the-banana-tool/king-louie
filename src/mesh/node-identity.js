const crypto = require('crypto');
const { MeshIdentity, saveIdentity, loadIdentity } = require('./mesh-identity');
const { createLogger } = require('../logging');

const log = createLogger('node-identity');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// The DER SubjectPublicKeyInfo header in front of every Ed25519 public key:
// SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (33 bytes, 0 unused bits) }.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_KEY_LENGTH = 32;

// The node ID is kl-<base32(sha256(pubkey))[0..16]> (§5.1), where pubkey is
// the raw 32-byte Ed25519 key — deliberately not the 44-byte DER encoding the
// identity stores, so the ID depends only on the key and can be recomputed
// by anything that holds it. `publicKey` is that DER (SPKI) encoding, as a
// Buffer or hex string; anything that is not an Ed25519 SPKI key is refused
// rather than hashed into an ID that no other implementation would match.
// The mesh peer id (MeshIdentity._derivePeerId) is a different, older
// derivation and is left alone so existing mesh pairings keep working.
function deriveNodeId(publicKey) {
  const der = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, 'hex');
  if (der.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH
    || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('deriveNodeId: expected a DER (SPKI) encoded Ed25519 public key');
  }
  const raw = der.subarray(ED25519_SPKI_PREFIX.length);
  const hash = crypto.createHash('sha256').update(raw).digest();
  return `kl-${base32Encode(hash).slice(0, 16)}`;
}

// A mesh identity plus the fleet's node ID and name. peerId is inherited
// unchanged: it is what existing mesh pairings were made against.
class NodeIdentity extends MeshIdentity {
  constructor(config = {}) {
    super(config);
    this.nodeName = config.nodeName || config.displayName || 'unnamed-node';
    this.nodeId = deriveNodeId(this.publicKey);
  }

  getPublicIdentity() {
    return {
      ...super.getPublicIdentity(),
      nodeId: this.nodeId,
      nodeName: this.nodeName
    };
  }
}

function getOrGenerateNodeIdentity(store, cipher, nodeName = 'unnamed-node') {
  let identity = loadIdentity(store, cipher);
  if (!identity) {
    identity = new NodeIdentity({ nodeName });
    saveIdentity(store, identity, cipher);
    log.info(`Generated new Node Identity ${identity.nodeId} for node "${nodeName}"`);
  } else if (!(identity instanceof NodeIdentity)) {
    // Wrap loaded identity into NodeIdentity
    identity = new NodeIdentity({
      nodeName,
      displayName: identity.displayName,
      capabilities: identity.capabilities,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      tlsCert: identity.tlsCert,
      tlsKey: identity.tlsKey
    });
  }
  return identity;
}

module.exports = {
  NodeIdentity,
  base32Encode,
  deriveNodeId,
  getOrGenerateNodeIdentity
};
