// FCM HTTP v1 with a service account: a data-only, high-priority message
// carrying { rid, n, k } and, on a coalesced push, `c` (push spec §7.1). The
// OAuth token is cached until a minute before it expires.
const { signJwt, requestText } = require('./jwt');
const { sanitizeNodeName } = require('./text');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// android.ttl when the payload has no expires_at (push spec §6.5, C-7).
const DEFAULT_TTL_S = 300;
const SESSION_ENDED_TTL_S = 3600;
const MIN_COUNT = 2;
const MAX_COUNT = 999;

// Below 2 there is nothing to count; above 999 the phone is told 999.
const countOf = (count) => (Number.isInteger(count) && count >= MIN_COUNT ? Math.min(count, MAX_COUNT) : null);

// A token FCM says is gone (404 UNREGISTERED) or belongs to another Firebase
// project (403 SENDER_ID_MISMATCH: the app was rebuilt against a new one) is
// dropped (C-11). A 400 never is: it is as likely the relay's own message.
function rejectsToken(status, text) {
  if (status === 404) return /UNREGISTERED/.test(text);
  if (status === 403) return /SENDER_ID_MISMATCH/.test(text);
  return false;
}

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
      const fallbackTtl = payload.kind === 'session_ended' ? SESSION_ENDED_TTL_S : DEFAULT_TTL_S;
      const secondsLeft = payload.expires_at ? Math.max(0, Math.ceil((Date.parse(payload.expires_at) - now()) / 1000)) : fallbackTtl;
      const data = { rid: String(payload.id), n: sanitizeNodeName(payload.node_name) || '', k: payload.kind };
      const count = countOf(payload.count);
      if (count !== null) data.c = String(count);
      const body = JSON.stringify({
        message: {
          token: device.push.token,
          data,
          android: { priority: 'HIGH', ttl: `${secondsLeft}s` }
        }
      });
      const res = await requestText(`${fcmOrigin}/v1/projects/${serviceAccount.project_id}/messages:send`, {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body
      });
      if (res.status === 401 || res.status === 403) clearAccess();
      return { ok: res.status === 200, dropToken: rejectsToken(res.status, res.text), status: res.status };
    }
  };
}

module.exports = { createFcmSender };
