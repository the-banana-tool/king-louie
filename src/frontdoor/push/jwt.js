// Minimal JWT signing for the push providers: ES256 (APNs, raw r||s) and
// RS256 (Google OAuth service-account assertion). Node's crypto only.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// ES256 must produce a raw P1363 signature (64 bytes: r||s); Node's default
// ECDSA signing is DER, which APNs (and every other ES256 verifier) rejects.
function signJwt(header, claims, privateKeyPem) {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = header.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}

// A small HTTP(S) request helper: → { status, text }.
function requestText(url, { method = 'POST', headers = {}, body = '' } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(target, { method, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('push request timed out')));
    req.end(body);
  });
}

module.exports = { signJwt, requestText };
