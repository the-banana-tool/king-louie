// FCM HTTP v1 with a service account: a data-only, high-priority message
// carrying { rid, n, k }. The OAuth token is cached until a minute before it
// expires.
const { signJwt, requestText } = require('./jwt');
const { sanitizeNodeName } = require('./text');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function createFcmSender({ serviceAccount, tokenUrl = 'https://oauth2.googleapis.com/token', fcmOrigin = 'https://fcm.googleapis.com', now = Date.now }) {
  let access = null;
  let accessUntil = 0;
  // A 401/403 from FCM means the cached access token was rejected (revoked,
  // expired early, wrong project) — clear it so the next call re-exchanges.
  const clearAccess = () => { access = null; accessUntil = 0; };

  async function accessToken() {
    if (access && now() < accessUntil) return access;
    const iat = Math.floor(now() / 1000);
    const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: serviceAccount.client_email, scope: SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, serviceAccount.private_key);
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    const res = await requestText(tokenUrl, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    if (res.status !== 200) throw new Error(`FCM token exchange failed with ${res.status}`);
    const parsed = JSON.parse(res.text);
    access = parsed.access_token;
    accessUntil = now() + Math.max(0, (Number(parsed.expires_in) || 3600) - 60) * 1000;
    return access;
  }

  return {
    id: 'fcm',
    platforms: ['fcm'],
    async notify(device, payload) {
      const token = await accessToken();
      const secondsLeft = payload.expires_at ? Math.max(0, Math.ceil((Date.parse(payload.expires_at) - now()) / 1000)) : 300;
      const body = JSON.stringify({
        message: {
          token: device.push.token,
          data: { rid: String(payload.id), n: sanitizeNodeName(payload.node_name) || '', k: payload.kind },
          android: { priority: 'HIGH', ttl: `${secondsLeft}s` }
        }
      });
      const res = await requestText(`${fcmOrigin}/v1/projects/${serviceAccount.project_id}/messages:send`, {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body
      });
      if (res.status === 401 || res.status === 403) clearAccess();
      const unregistered = res.status === 404 && /UNREGISTERED/.test(res.text);
      return { ok: res.status === 200, dropToken: unregistered, status: res.status };
    }
  };
}

module.exports = { createFcmSender };
