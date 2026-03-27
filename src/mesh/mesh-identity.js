const crypto = require('crypto');
const { X509Certificate } = require('crypto');

const PEER_ID_PREFIX = 'kl-';
const PEER_ID_LENGTH = 12; // hex chars after prefix
const TLS_CERT_DAYS = 3650; // 10 years - long-lived, trust is via pinning not CA

class MeshIdentity {
  constructor(config = {}) {
    this.displayName = config.displayName || '';
    this.capabilities = Array.isArray(config.capabilities) ? config.capabilities : [];

    if (config.publicKey && config.privateKey) {
      this.publicKey = Buffer.isBuffer(config.publicKey)
        ? config.publicKey
        : Buffer.from(config.publicKey, 'hex');
      this.privateKey = Buffer.isBuffer(config.privateKey)
        ? config.privateKey
        : Buffer.from(config.privateKey, 'hex');
    } else {
      const keypair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      });
      this.publicKey = keypair.publicKey;
      this.privateKey = keypair.privateKey;
    }

    this.peerId = this._derivePeerId();

    // TLS certificate for encrypted transport (self-signed, trust via pinning)
    if (config.tlsCert && config.tlsKey) {
      this.tlsCert = config.tlsCert;
      this.tlsKey = config.tlsKey;
    } else {
      const tls = MeshIdentity.generateTlsCertificate(this.peerId);
      this.tlsCert = tls.cert;
      this.tlsKey = tls.key;
    }
    this.tlsFingerprint = MeshIdentity.getCertFingerprint(this.tlsCert);
  }

  _derivePeerId() {
    const hash = crypto.createHash('sha256').update(this.publicKey).digest('hex');
    return PEER_ID_PREFIX + hash.slice(0, PEER_ID_LENGTH);
  }

  sign(data) {
    const keyObject = crypto.createPrivateKey({
      key: this.privateKey,
      format: 'der',
      type: 'pkcs8'
    });
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    return crypto.sign(null, buffer, keyObject);
  }

  static verify(data, signature, publicKey) {
    const keyObject = crypto.createPublicKey({
      key: Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, 'hex'),
      format: 'der',
      type: 'spki'
    });
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'hex');
    return crypto.verify(null, buffer, keyObject, sig);
  }

  generateChallenge() {
    return crypto.randomBytes(32);
  }

  signChallenge(challenge) {
    return this.sign(challenge);
  }

  static verifyChallenge(challenge, signature, publicKey) {
    return MeshIdentity.verify(challenge, signature, publicKey);
  }

  serialize() {
    return {
      peerId: this.peerId,
      displayName: this.displayName,
      capabilities: this.capabilities,
      publicKey: this.publicKey.toString('hex'),
      privateKey: this.privateKey.toString('hex'),
      tlsCert: this.tlsCert,
      tlsKey: this.tlsKey,
      tlsFingerprint: this.tlsFingerprint
    };
  }

  static deserialize(data) {
    return new MeshIdentity({
      displayName: data.displayName,
      capabilities: data.capabilities,
      publicKey: data.publicKey,
      privateKey: data.privateKey,
      tlsCert: data.tlsCert,
      tlsKey: data.tlsKey
    });
  }

  getPublicIdentity() {
    return {
      peerId: this.peerId,
      displayName: this.displayName,
      capabilities: this.capabilities,
      publicKey: this.publicKey.toString('hex'),
      tlsFingerprint: this.tlsFingerprint
    };
  }

  static generateTlsCertificate(peerId) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const cn = peerId || 'king-louie-mesh';
    const days = TLS_CERT_DAYS;

    try {
      // Use temp files (works on all platforms including Windows)
      const tmpDir = os.tmpdir();
      const keyFile = path.join(tmpDir, `kl-mesh-key-${Date.now()}.pem`);
      const certFile = path.join(tmpDir, `kl-mesh-cert-${Date.now()}.pem`);

      try {
        execSync(
          `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
          `-keyout "${keyFile}" -out "${certFile}" -days ${days} -nodes ` +
          `-subj "/CN=${cn}"`,
          { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const cert = fs.readFileSync(certFile, 'utf8');
        const key = fs.readFileSync(keyFile, 'utf8');

        // Cleanup temp files
        try { fs.unlinkSync(keyFile); } catch { /* ignore */ }
        try { fs.unlinkSync(certFile); } catch { /* ignore */ }

        if (cert.includes('BEGIN CERTIFICATE') && key.includes('BEGIN PRIVATE KEY')) {
          return { cert, key };
        }
      } catch {
        // Cleanup on failure
        try { fs.unlinkSync(keyFile); } catch { /* ignore */ }
        try { fs.unlinkSync(certFile); } catch { /* ignore */ }
      }
    } catch {
      // openssl not available
    }

    // Fallback: generate RSA keypair with self-signed cert via Node crypto
    // RSA is used here because Node can generate certs with it natively
    return MeshIdentity._generateFallbackTlsCert(cn, days);
  }

  static _generateFallbackTlsCert(cn, days) {
    // Pure Node.js fallback using generateKeyPairSync
    // Generates a minimal self-signed cert using DER encoding
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1'
    });

    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });

    // Build X.509 cert DER structure
    const serialNumber = crypto.randomBytes(16);
    serialNumber[0] &= 0x7f;

    const now = new Date();
    const notBefore = _formatAsn1Time(now);
    const notAfter = _formatAsn1Time(new Date(now.getTime() + days * 86400000));

    // OID for commonName: 2.5.4.3
    const cnOid = Buffer.from('0603550403', 'hex');
    const cnValue = _derUtf8(cn);
    const attrSeq = _derSeq([cnOid, cnValue]);
    const attrSet = _derTag(0x31, attrSeq);
    const name = _derSeq([attrSet]);

    const validity = _derSeq([_derTag(0x17, Buffer.from(notBefore)), _derTag(0x17, Buffer.from(notAfter))]);

    // ecdsaWithSHA256 OID: 1.2.840.10045.4.3.2
    const sigAlg = _derSeq([Buffer.from('06082a8648ce3d040302', 'hex')]);

    const tbs = _derSeq([
      _derTag(0xa0, _derInt(Buffer.from([2]))),  // version v3
      _derInt(serialNumber),
      sigAlg,
      name,     // issuer
      validity,
      name,     // subject
      pubDer    // subjectPublicKeyInfo (already DER)
    ]);

    const sig = crypto.sign('sha256', tbs, privateKey);
    const sigBits = Buffer.concat([Buffer.from([0x00]), sig]); // 0 unused bits

    const cert = _derSeq([tbs, sigAlg, _derTag(0x03, Buffer.concat([_derLen(sigBits.length), sigBits]))]);

    const b64 = cert.toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
    const certPem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;

    return { cert: certPem, key: keyPem };
  }

  static getCertFingerprint(certPem) {
    // Extract DER from PEM and SHA-256 hash it
    const b64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    const der = Buffer.from(b64, 'base64');
    return crypto.createHash('sha256').update(der).digest('hex');
  }

  static verifyCertFingerprint(certPem, expectedFingerprint) {
    const actual = MeshIdentity.getCertFingerprint(certPem);
    // Timing-safe comparison
    if (actual.length !== expectedFingerprint.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(expectedFingerprint, 'hex')
    );
  }

  static generateNonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  static createEnvelope(identity, to, payload) {
    const nonce = MeshIdentity.generateNonce();
    const timestamp = Date.now();

    const body = JSON.stringify({ nonce, timestamp, to, payload });
    const signature = identity.sign(body).toString('hex');

    return {
      from: identity.peerId,
      to,
      nonce,
      timestamp,
      signature,
      payload
    };
  }

  static verifyEnvelope(envelope, publicKey, maxAgeMs = 5 * 60 * 1000) {
    const age = Date.now() - envelope.timestamp;
    if (age > maxAgeMs) {
      return { valid: false, reason: 'message_expired' };
    }

    if (age < -30000) {
      return { valid: false, reason: 'message_from_future' };
    }

    const body = JSON.stringify({
      nonce: envelope.nonce,
      timestamp: envelope.timestamp,
      to: envelope.to,
      payload: envelope.payload
    });

    const valid = MeshIdentity.verify(body, envelope.signature, publicKey);
    return valid
      ? { valid: true }
      : { valid: false, reason: 'invalid_signature' };
  }
}

// --- ASN.1 DER encoding helpers (fallback cert generation) ---

function _derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function _derTag(tag, content) {
  const len = _derLen(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function _derSeq(items) {
  const body = Buffer.concat(items);
  return _derTag(0x30, body);
}

function _derInt(value) {
  let buf = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return _derTag(0x02, buf);
}

function _derUtf8(str) {
  return _derTag(0x0c, Buffer.from(str, 'utf8'));
}

function _formatAsn1Time(date) {
  const y = date.getUTCFullYear() % 100;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(y)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

module.exports = { MeshIdentity };
