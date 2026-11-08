// The window's side of OAuth (remote window plan R-RW-10): a public PKCE client of one
// front door, registered once, whose code comes back to a loopback listener open for
// that flow alone. Electron-free: the host hands it `openBrowser`. No error here repeats
// a front door's words, so nothing a server says reaches the owner as if we said it.
const crypto = require('crypto');
const http = require('http');
const { createLogger } = require('../logging');

const log = createLogger('window-oauth');

const CLIENT_NAME = 'King Louie window';
const CALLBACK_PATH = '/kl/window/callback';
const REGISTERED_REDIRECT = `http://127.0.0.1${CALLBACK_PATH}`;
const RESOURCE_PATH = '/window/v1';
const FLOW_MS = 10 * 60 * 1000;
const REQUEST_MS = 30000;
const BODY_MAX = 1024 * 1024;
// The front door's PendingAuthorizations: three authorize requests from one address in
// ten minutes. A fourth gets a 429 page in the browser, which this process cannot see.
const AUTHORIZES_PER_WINDOW = 3;
const AUTHORIZE_WINDOW_MS = 10 * 60 * 1000;
// The one refusal of a refresh that leaves the tokens alive (tokens.js, audienceOff).
const RESOURCE_OFF_TEXT = 'this resource is not enabled on this front door';

const BROWSER_NOTICE = 'If your browser says "Try again later", the front door has had too many sign-ins from this address. Wait a few minutes and try again.';
const WORDS = Object.freeze({
  SIGN_IN_AGAIN: 'The front door no longer accepts this window\'s sign-in. Sign in again and approve it on your phone.',
  WINDOW_RESOURCE_OFF: 'This front door has remote windows turned off. Your sign-in is still good, and works again when they are back on.',
  TOKEN_ENDPOINT_UNREACHABLE: 'The front door could not be reached.',
  TOKEN_MALFORMED: 'The front door gave an answer this window cannot read.',
  REGISTER_FAILED: 'The front door would not register this window. Try again in a while.',
  AUTHORIZE_BUSY: 'The front door takes three sign-ins from one address in ten minutes.',
  AUTHORIZE_TIMEOUT: 'The sign-in was not finished in ten minutes.',
  BROWSER_FAILED: 'The browser could not be opened.',
  CANCELLED: 'The sign-in was cancelled.',
  ACCESS_DENIED: 'The sign-in was refused on the phone.',
  STATE_MISMATCH: 'The sign-in came back with an answer that was not for this request. Nothing was accepted.',
  ISSUER_MISMATCH: 'The sign-in came back from another front door. Nothing was accepted.',
  CALLBACK_INVALID: 'The sign-in came back malformed. Nothing was accepted.',
  LISTEN_FAILED: 'This computer would not open the address the sign-in comes back to.'
});

class OAuthClientError extends Error {
  // `tokensDead`: a new phone approval is the only way on. `hold`: retrying alone will
  // not help, whatever is true of the tokens.
  constructor(code, { tokensDead = false, hold = tokensDead, retryAfterMs = null, message = null } = {}) {
    super(message || WORDS[code] || 'The sign-in failed.');
    this.name = 'OAuthClientError';
    this.code = code;
    this.tokensDead = tokensDead;
    this.hold = hold;
    this.retryAfterMs = retryAfterMs;
  }
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

function sameText(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function oneParam(params, name) {
  const all = params.getAll(name);
  if (all.length > 1) throw new OAuthClientError('CALLBACK_INVALID');
  return all.length === 1 ? all[0] : null;
}

// What the loopback listener got: the code, or why not. The state comes first, so
// nothing else in a forged request is looked at.
function readCallback(req, { state, origin }) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    throw new OAuthClientError('CALLBACK_INVALID');
  }
  if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) throw new OAuthClientError('CALLBACK_INVALID');
  const given = oneParam(url.searchParams, 'state');
  if (given === null || !sameText(given, state)) throw new OAuthClientError('STATE_MISMATCH');
  const issuer = oneParam(url.searchParams, 'iss');
  if (issuer !== null && issuer !== origin) throw new OAuthClientError('ISSUER_MISMATCH');
  const error = oneParam(url.searchParams, 'error');
  const code = oneParam(url.searchParams, 'code');
  if (error !== null) throw new OAuthClientError(error === 'access_denied' ? 'ACCESS_DENIED' : 'CALLBACK_INVALID');
  if (!code) throw new OAuthClientError('CALLBACK_INVALID');
  return code;
}

function answerBrowser(res, ok) {
  const text = ok ? 'King Louie has your sign-in. You can close this tab.' : 'This sign-in did not finish. Go back to King Louie and try again.';
  res.writeHead(ok ? 200 : 400, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'referrer-policy': 'no-referrer',
    connection: 'close'
  });
  res.end(text);
}

function createWindowOAuth({ origin, fetch = globalThis.fetch, openBrowser, listen = http.createServer, random = crypto.randomBytes, now = Date.now, timers = {} } = {}) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('createWindowOAuth needs an https origin');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== String(origin)) throw new Error('createWindowOAuth needs an https origin');
  if (typeof fetch !== 'function' || typeof openBrowser !== 'function') throw new Error('createWindowOAuth needs fetch and openBrowser');
  const setTimer = timers.setTimer || setTimeout;
  const clearTimer = timers.clearTimer || clearTimeout;
  const clock = timers.now || now;
  const resource = `${origin}${RESOURCE_PATH}`;
  const opened = [];

  // A redirect is never followed: a token request goes to this origin or nowhere.
  async function post(path, { headers, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    try {
      const res = await fetch(`${origin}${path}`, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal });
      const text = await res.text();
      let json = null;
      if (typeof text === 'string' && text.length <= BODY_MAX) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, ok: res.ok, json };
    } catch (err) {
      log.debug(`a request to the front door failed: ${err.message}`);
      throw new OAuthClientError('TOKEN_ENDPOINT_UNREACHABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  const postForm = (path, form) => post(path, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });

  function tokensFrom({ json }) {
    const fine = json && typeof json.access_token === 'string' && json.access_token
      && typeof json.refresh_token === 'string' && json.refresh_token
      && Number.isFinite(json.expires_in) && json.expires_in > 0;
    if (!fine) throw new OAuthClientError('TOKEN_MALFORMED');
    return { access: json.access_token, refresh: json.refresh_token, expiresAt: clock() + json.expires_in * 1000 };
  }

  // Only the front door's own refusal of the grant kills tokens. A server error, a 429
  // and a network failure say nothing of them.
  function refusal({ status, json }) {
    if (status === 400 && json && json.error === 'invalid_grant') {
      if (json.error_description === RESOURCE_OFF_TEXT) return new OAuthClientError('WINDOW_RESOURCE_OFF', { hold: true });
      return new OAuthClientError('SIGN_IN_AGAIN', { tokensDead: true });
    }
    return new OAuthClientError('TOKEN_ENDPOINT_UNREACHABLE');
  }

  async function register() {
    const res = await post('/oauth/register', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [REGISTERED_REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    });
    if (!res.ok) throw new OAuthClientError('REGISTER_FAILED');
    if (!res.json || typeof res.json.client_id !== 'string' || !res.json.client_id) throw new OAuthClientError('TOKEN_MALFORMED');
    return res.json.client_id;
  }

  function takeAuthorizeSlot() {
    const t = clock();
    while (opened.length && opened[0] <= t - AUTHORIZE_WINDOW_MS) opened.shift();
    if (opened.length >= AUTHORIZES_PER_WINDOW) {
      const retryAfterMs = opened[0] + AUTHORIZE_WINDOW_MS - t;
      const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
      throw new OAuthClientError('AUTHORIZE_BUSY', {
        hold: true,
        retryAfterMs,
        message: `${WORDS.AUTHORIZE_BUSY} Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      });
    }
    opened.push(t);
  }

  // Opens on 127.0.0.1 for this flow only, takes one request, and closes. → the code.
  function awaitCode({ state, signal, onListening }) {
    return new Promise((resolve, reject) => {
      let done = false;
      let deadline = null;
      let server = null;
      const onAbort = () => finish(new OAuthClientError('CANCELLED'));
      function finish(err, code) {
        if (done) return;
        done = true;
        if (deadline !== null) clearTimer(deadline);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          server.close(() => {});
          server.closeAllConnections?.();
        } catch { /* it never opened */ }
        if (err) reject(err);
        else resolve(code);
      }
      if (signal && signal.aborted) {
        reject(new OAuthClientError('CANCELLED'));
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort);
      let answered = false;
      server = listen((req, res) => {
        if (answered) {
          res.destroy();
          return;
        }
        answered = true;
        let code = null;
        let failure = null;
        try {
          code = readCallback(req, { state, origin });
        } catch (err) {
          failure = err;
        }
        res.once('finish', () => finish(failure, code));
        res.once('close', () => finish(failure, code));
        answerBrowser(res, failure === null);
      });
      server.on('error', (err) => {
        log.warn(`the sign-in listener failed: ${err.code || err.message}`);
        finish(new OAuthClientError('LISTEN_FAILED'));
      });
      server.listen(0, '127.0.0.1', () => {
        if (done) return;
        deadline = setTimer(() => finish(new OAuthClientError('AUTHORIZE_TIMEOUT')), FLOW_MS);
        deadline?.unref?.();
        Promise.resolve()
          .then(() => onListening(server.address().port))
          .catch((err) => finish(err instanceof OAuthClientError ? err : new OAuthClientError('BROWSER_FAILED')));
      });
    });
  }

  async function authorize({ clientId, scope, onNotice = null, signal = null } = {}) {
    if (typeof clientId !== 'string' || !clientId) throw new Error('authorize needs a clientId');
    takeAuthorizeSlot();
    const verifier = b64url(random(32));
    const state = b64url(random(32));
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let redirectUri = null;
    const code = await awaitCode({
      state,
      signal,
      onListening: async (port) => {
        redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const params = new URLSearchParams({
          response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource, state
        });
        if (scope) params.set('scope', scope);
        // A 429 page is the browser's alone: this is the only way the owner hears of it.
        if (onNotice) {
          try {
            onNotice(BROWSER_NOTICE);
          } catch (err) {
            log.warn(`a sign-in notice failed: ${err.message}`);
          }
        }
        try {
          await openBrowser(`${origin}/oauth/authorize?${params}`);
        } catch (err) {
          log.warn(`the browser did not open: ${err.message}`);
          throw new OAuthClientError('BROWSER_FAILED');
        }
      }
    });
    const res = await postForm('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
    if (!res.ok) throw refusal(res);
    return tokensFrom(res);
  }

  async function refresh({ clientId, refresh: refreshToken } = {}) {
    const res = await postForm('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    if (!res.ok) throw refusal(res);
    return tokensFrom(res);
  }

  // RFC 7009: the answer says nothing either way. A refresh token takes the grant with it.
  async function revoke({ clientId, token } = {}) {
    await postForm('/oauth/revoke', { token, client_id: clientId });
  }

  return { register, authorize, refresh, revoke, resource };
}

module.exports = { createWindowOAuth, OAuthClientError, BROWSER_NOTICE, REGISTERED_REDIRECT };
