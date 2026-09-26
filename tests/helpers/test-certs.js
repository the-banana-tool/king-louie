// tests/helpers/test-certs.js
//
// X.509 certificates built at runtime in pure Node (no openssl): a test CA,
// leaves with a DNS subjectAltName signed by it (for WebPKI checks with an
// injected `ca`), and self-signed P-256 certificates. Test use only.
const crypto = require('crypto');

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tag = (t, body) => Buffer.concat([Buffer.from([t]), len(body.length), body]);
const seq = (...items) => tag(0x30, Buffer.concat(items));
const set = (...items) => tag(0x31, Buffer.concat(items));
const oid = (hex) => Buffer.from(hex, 'hex');
const int = (buf) => tag(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = (s) => tag(0x0c, Buffer.from(s, 'utf8'));
const octet = (buf) => tag(0x04, buf);
const bits = (buf) => tag(0x03, Buffer.concat([Buffer.from([0]), buf]));
const explicit = (n, body) => tag(0xa0 + n, body);

const OID = {
  ecdsaSha256: oid('06082a8648ce3d040302'),
  commonName: oid('0603550403'),
  subjectAltName: oid('0603551d11'),
  basicConstraints: oid('0603551d13'),
  keyUsage: oid('0603551d0f')
};

function utcTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return tag(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}

const name = (cn) => seq(set(seq(OID.commonName, utf8(cn))));
const extension = (id, critical, value) => seq(id, ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), octet(value));

function pem(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function build({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const sigAlg = seq(OID.ecdsaSha256);
  const serial = crypto.randomBytes(16);
  // Positive and minimal DER (M12): a leading 0x00 followed by a byte below
  // 0x80 is non-minimal, and OpenSSL refuses it ("illegal padding").
  serial[0] = (serial[0] & 0x7f) || 0x01;
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serial),
    sigAlg,
    name(issuer),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions))
  );
  const sig = crypto.sign('sha256', tbs, signingKey);
  return pem(seq(tbs, sigAlg, bits(sig)), 'CERTIFICATE');
}

function newKey(keyPem = null) {
  const privateKey = keyPem ? crypto.createPrivateKey(keyPem) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  return { privateKey, publicKey: crypto.createPublicKey(privateKey), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function createCa({ commonName = 'King Louie Test CA' } = {}) {
  const k = newKey();
  const now = Date.now();
  const cert = build({
    subject: commonName, issuer: commonName, publicKey: k.publicKey, signingKey: k.privateKey,
    notBefore: now - 86400000, notAfter: now + 3650 * 86400000,
    extensions: [
      extension(OID.basicConstraints, true, seq(Buffer.from([0x01, 0x01, 0xff]))),
      extension(OID.keyUsage, true, tag(0x03, Buffer.from([0x01, 0x06])))
    ]
  });
  return { cert, key: k.pem, commonName, privateKey: k.privateKey };
}

function issueCert(ca, { dnsNames, commonName = dnsNames[0], keyPem = null, notBefore = Date.now() - 86400000, notAfter = Date.now() + 90 * 86400000 }) {
  const k = newKey(keyPem);
  const san = seq(...dnsNames.map((n) => tag(0x82, Buffer.from(n, 'ascii'))));
  const cert = build({
    subject: commonName, issuer: ca.commonName, publicKey: k.publicKey, signingKey: ca.privateKey || crypto.createPrivateKey(ca.key),
    notBefore, notAfter,
    extensions: [extension(OID.subjectAltName, false, san), extension(OID.keyUsage, true, tag(0x03, Buffer.from([0x07, 0x80])))]
  });
  return { cert, key: k.pem };
}

function selfSigned({ commonName = 'kl-test', days = 30 } = {}) {
  const k = newKey();
  const now = Date.now();
  const cert = build({ subject: commonName, issuer: commonName, publicKey: k.publicKey, signingKey: k.privateKey, notBefore: now - 86400000, notAfter: now + days * 86400000, extensions: [] });
  return { cert, key: k.pem };
}

function fingerprint(certPem) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
}

module.exports = { createCa, issueCert, selfSigned, fingerprint };
