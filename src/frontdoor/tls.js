// The pin phones keep for the relay: SHA-256 over the leaf certificate's
// SubjectPublicKeyInfo DER, as `sha256/<base64url>`. Renewing the certificate
// with the same key keeps the pin.
const crypto = require('crypto');

function relaySpkiPin(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
  return `sha256/${crypto.createHash('sha256').update(spki).digest('base64url')}`;
}

module.exports = { relaySpkiPin };
