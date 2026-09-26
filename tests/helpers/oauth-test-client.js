// tests/helpers/oauth-test-client.js
//
// A small OAuth client for the front-door tests: HTTP (or HTTPS, with a
// test CA and a lookup that resolves the front door's names to 127.0.0.1)
// with an explicit Host header (fetch cannot set one), PKCE, and the
// consent page's code.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function request(base, { method = 'GET', path, host = 'mcp.kl.example.com', headers = {}, json = undefined, form = undefined, raw = undefined, tls = null } = {}) {
  let body = null;
  const h = { host, ...headers };
  if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
  if (form !== undefined) { body = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (raw !== undefined) body = Buffer.from(raw);
  if (body) h['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const secure = base.startsWith('https:');
    const req = (secure ? https : http).request(`${base}${path}`, { method, headers: h, ...(secure ? { agent: false, ...(tls || {}) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function parseConsent(html) {
  const code = /id="user-code">([0-9A-Z]{3}-[0-9A-Z]{3})</.exec(html);
  const grant = /authorize\/wait\?id=(gr_[A-Za-z0-9_-]{22})/.exec(html);
  return { userCode: code ? code[1] : null, grantId: grant ? grant[1] : null };
}

function cookieOf(res) {
  const set = [].concat(res.headers['set-cookie'] || []);
  const c = set.find((s) => s.startsWith('kl_authz='));
  return c ? c.split(';')[0] : null;
}

module.exports = { request, pkce, parseConsent, cookieOf };
