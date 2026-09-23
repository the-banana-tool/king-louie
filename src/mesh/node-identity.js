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

function deriveNodeId(publicKeyBuffer) {
  const buf = Buffer.isBuffer(publicKeyBuffer) ? publicKeyBuffer : Buffer.from(publicKeyBuffer, 'hex');
  const hash = crypto.createHash('sha256').update(buf).digest();
  return `kl-${base32Encode(hash).slice(0, 16)}`;
}

class NodeIdentity extends MeshIdentity {
  constructor(config = {}) {
    super(config);
    this.nodeName = config.nodeName || config.displayName || 'unnamed-node';
    this.nodeId = deriveNodeId(this.publicKey);
    // Keep peerId in sync
    this.peerId = this.nodeId;
  }

  _derivePeerId() {
    return deriveNodeId(this.publicKey);
  }

  getPublicIdentity() {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      peerId: this.nodeId,
      displayName: this.nodeName,
      capabilities: this.capabilities,
      publicKey: this.publicKey.toString('hex'),
      tlsFingerprint: this.tlsFingerprint
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
