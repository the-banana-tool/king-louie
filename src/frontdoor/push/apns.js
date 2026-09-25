// APNs over HTTP/2 with a token (.p8) key. The payload carries only
// { rid, k }; the app fetches and verifies the request itself.
const http2 = require('http2');
const { signJwt } = require('./jwt');
const { alertText } = require('./text');

const TOKEN_TTL_MS = 50 * 60 * 1000;

// `origin` overrides the Apple endpoint (tests use a local HTTP/2 server).
function createApnsSender({ teamId, keyId, keyPem, topic, environment = 'production', origin = null, now = Date.now }) {
  const base = origin || (environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  let token = null;
  let tokenAt = 0;
  const bearer = () => {
    const t = now();
    if (!token || t - tokenAt >= TOKEN_TTL_MS) {
      token = signJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(t / 1000) }, keyPem);
      tokenAt = t;
    }
    return token;
  };
  // A 401/403 means APNs rejected the JWT we cached (revoked key, wrong
  // team/kid, clock skew) — clear it so the next call signs a fresh one
  // rather than repeating the same rejected token.
  const clearBearer = () => { token = null; tokenAt = 0; };

  return {
    id: 'apns',
    platforms: ['apns'],
    notify(device, payload) {
      const body = JSON.stringify({
        aps: { alert: { title: 'King Louie', body: alertText(payload) }, sound: 'default' },
        kl: { rid: payload.id, k: payload.kind }
      });
      return new Promise((resolve, reject) => {
        const client = http2.connect(base);
        client.on('error', reject);
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${device.push.token}`,
          authorization: `bearer ${bearer()}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(payload.expires_at ? Math.floor(Date.parse(payload.expires_at) / 1000) : 0),
          'apns-collapse-id': String(payload.id).slice(0, 64),
          'content-type': 'application/json'
        });
        let status = 0;
        req.on('response', (headers) => { status = headers[':status']; });
        req.on('data', () => {});
        req.on('end', () => {
          client.close();
          if (status === 401 || status === 403) clearBearer();
          resolve({ ok: status === 200, dropToken: status === 410, status });
        });
        req.on('error', (err) => { client.close(); reject(err); });
        req.end(body);
      });
    }
  };
}

module.exports = { createApnsSender };
