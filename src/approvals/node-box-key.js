// The node's box key (sealed phones, R-SP-3): one P-256 key-agreement key per
// node. The identity key is Ed25519, which cannot do ECDH, and the phones'
// enclaves speak only P-256. The private scalar is stored under the host
// cipher beside the Ed25519 key (src/mesh/mesh-identity.js); here it only ever
// sits behind `agree`. node:crypto only: the mesh loads this.
const crypto = require('crypto');

const COORD_BYTES = 32;

function generateBoxKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y, d } = privateKey.export({ format: 'jwk' });
  return { jwk: { kty, crv, x, y }, d };
}

function ecPoint(jwk) {
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

// { jwk, agree(epkJwk) → the 32-byte x-coordinate of the shared point }.
// Refuses a private half that is not this public key's; no error here quotes
// either, or the node would seal under one key and open under another.
function createBox(jwk, d) {
  const refuse = () => new Error('the stored box key does not hold together: its private half is not its public key\'s');
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof d !== 'string') throw refuse();
  const ecdh = crypto.createECDH('prime256v1');
  let derived;
  try {
    ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
    derived = ecdh.getPublicKey();
  } catch {
    throw refuse();
  }
  if (!derived.equals(ecPoint(jwk))) throw refuse();
  const publicJwk = Object.freeze({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  return Object.freeze({
    jwk: publicJwk,
    agree(epkJwk) {
      const secret = ecdh.computeSecret(ecPoint(epkJwk));
      if (secret.length !== COORD_BYTES) throw new Error('the key agreement gave the wrong size');
      return secret;
    }
  });
}

module.exports = { generateBoxKey, createBox };
