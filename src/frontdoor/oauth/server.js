// The OAuth 2.1 authorization server on mcp.<domain> (fleet stage 4 §3.4):
// metadata (RFC 9728, RFC 8414), dynamic registration (RFC 7591), and the
// authorize → consent → wait flow in which the owner types the browser's
// code on the phone (R23). Tokens and the phone routes are added in Tasks
// 23–24 through `this.routes` and registerPhoneRoutes.
const { createLogger } = require('../../logging');
const { CODE_CHALLENGE_RE } = require('../protocol/messages');
const { OAuthError } = require('./errors');
const { clientHost } = require('./clients');
const { CONSENT_HEADERS, CONSENT_CSS, consentPage, messagePage } = require('./pages');
const { readBody, sendJson, sendHtml, parseCookies, requestHost, clientIp } = require('../http-util');

const log = createLogger('frontdoor/oauth');
const BODY_LIMIT = 65536;
const STATE_MAX = 512;

class OAuthServer {
  constructor({ domain, clients, pending, scopeRegistry, scopesEnabled, clientDefaults = [], now = Date.now } = {}) {
    // The name the SNI listener routes to this handler; a request whose Host
    // names anything else is misdirected (421), whatever its TLS name was.
    this.mcpHost = `mcp.${String(domain).toLowerCase()}`;
    this.issuer = `https://${this.mcpHost}`;
    this.resourceUrl = `${this.issuer}/mcp`;
    this.clients = clients;
    this.pending = pending;
    this.scopeRegistry = scopeRegistry;
    this.scopesEnabled = scopesEnabled;
    this.clientDefaults = clientDefaults;
    this.now = now;
    this.routes = new Map([
      ['GET /.well-known/oauth-protected-resource', (req, res) => this.protectedResource(req, res)],
      ['GET /.well-known/oauth-protected-resource/mcp', (req, res) => this.protectedResource(req, res)],
      ['GET /.well-known/oauth-authorization-server', (req, res) => this.authorizationServer(req, res)],
      ['POST /oauth/register', (req, res) => this.register(req, res)],
      ['GET /oauth/authorize', (req, res, url) => this.authorize(req, res, url)],
      ['GET /oauth/authorize/wait', (req, res, url) => this.wait(req, res, url)],
      ['GET /oauth/consent.css', (req, res) => {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(CONSENT_CSS);
      }]
    ]);
  }

  supportedScopes() {
    return this.scopeRegistry.supported(this.scopesEnabled);
  }

  isOAuthPath(pathname) {
    return pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/oauth-');
  }

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `https://${this.mcpHost}`);
    } catch {
      return false;
    }
    if (!this.isOAuthPath(url.pathname)) return false;
    if (requestHost(req) !== this.mcpHost) {
      sendJson(res, 421, { error: 'misdirected_request', error_description: `this front door answers only as ${this.mcpHost}` });
      return true;
    }
    const route = this.routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof OAuthError) sendJson(res, err.status, { error: err.error, error_description: err.message });
      else if (err && err.status === 413) sendJson(res, 413, { error: 'invalid_request', error_description: err.message }, { connection: 'close' });
      else {
        log.error(`${req.method} ${url.pathname} failed: ${err && err.message}`);
        sendJson(res, 500, { error: 'server_error' });
      }
    }
    return true;
  }

  protectedResource(req, res) {
    sendJson(res, 200, { resource: this.resourceUrl, authorization_servers: [this.issuer], scopes_supported: this.supportedScopes(), bearer_methods_supported: ['header'] });
  }

  authorizationServer(req, res) {
    sendJson(res, 200, {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: this.supportedScopes(),
      client_id_metadata_document_supported: true
    });
  }

  async register(req, res) {
    const raw = await readBody(req, BODY_LIMIT);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new OAuthError('invalid_client_metadata', 'the registration must be JSON');
    }
    const c = this.clients.register(body, { ip: clientIp(req) });
    sendJson(res, 201, {
      client_id: c.client_id, client_id_issued_at: c.client_id_issued_at, client_name: c.client_name, redirect_uris: c.redirect_uris,
      grant_types: c.grant_types, response_types: c.response_types, token_endpoint_auth_method: 'none'
    });
  }

  // Every refusal of an authorize request is a page on this origin; nothing
  // is ever sent to a redirect_uri from here.
  refuse(res, status, title, message) {
    sendHtml(res, status, messagePage({ title, message }), CONSENT_HEADERS);
  }

  preselect(host, requested) {
    const match = this.clientDefaults.find((d) => d.host === host);
    const wanted = match ? match.scopes : ['fleet:read'];
    return requested.filter((s) => wanted.includes(s));
  }

  async authorize(req, res, url) {
    // A parameter given twice could be read one way here and another way by
    // the client; RFC 6749 §3.1 forbids it.
    const keys = [...url.searchParams.keys()];
    const repeated = keys.find((k, i) => keys.indexOf(k) !== i);
    if (repeated !== undefined) return this.refuse(res, 400, 'Invalid request', `The parameter ${repeated} was given more than once.`);
    const q = Object.fromEntries(url.searchParams);
    const ip = clientIp(req);
    let client = null;
    let ipCounted = false;
    try {
      // A metadata-document fetch is charged to the asking address before it
      // happens, so one address cannot drive fetches past its limit.
      if (this.clients.needsFetch(q.client_id)) {
        this.pending.countIp(ip);
        ipCounted = true;
      }
      client = await this.clients.resolve(q.client_id);
    } catch (err) {
      if (err instanceof OAuthError && err.status === 429) return this.refuse(res, 429, 'Try again later', err.message);
      if (err instanceof OAuthError) return this.refuse(res, 400, 'Unknown client', err.message);
      log.warn(`resolving a client failed: ${err && err.message}`);
      return this.refuse(res, 400, 'Unknown client', 'This client could not be looked up.');
    }
    if (!client) return this.refuse(res, 400, 'Unknown client', 'This client is not registered with this King Louie front door.');
    // Checked before anything else can redirect: a mismatch never redirects.
    if (!this.clients.redirectAllowed(client, q.redirect_uri)) {
      return this.refuse(res, 400, 'Redirect not allowed', 'The redirect address is not one this client registered, or is not in canonical URL form '
        + '(percent-encoded as the URL parser prints it, with no userinfo or fragment). Nothing was sent back to it.');
    }
    if (q.response_type !== 'code') return this.refuse(res, 400, 'Invalid request', 'response_type must be code.');
    if (typeof q.code_challenge !== 'string' || !CODE_CHALLENGE_RE.test(q.code_challenge)) return this.refuse(res, 400, 'Invalid request', 'code_challenge is required (43–128 characters).');
    if (q.code_challenge_method !== 'S256') return this.refuse(res, 400, 'Invalid request', 'code_challenge_method must be S256; plain is refused.');
    const resource = q.resource === undefined ? this.resourceUrl : q.resource;
    if (resource !== this.resourceUrl) return this.refuse(res, 400, 'Invalid request', `resource must be ${this.resourceUrl}.`);
    if (q.state !== undefined && q.state.length > STATE_MAX) return this.refuse(res, 400, 'Invalid request', `state is too long (at most ${STATE_MAX} characters).`);
    const supported = this.supportedScopes();
    const requested = q.scope === undefined || !q.scope.trim() ? supported : [...new Set(q.scope.trim().split(/\s+/))].sort();
    const unknown = requested.filter((s) => !supported.includes(s));
    if (unknown.length) return this.refuse(res, 400, 'Invalid scope', `This front door does not grant ${unknown.join(', ')}.`);
    const host = clientHost(client, q.redirect_uri);
    let created;
    try {
      created = this.pending.create({
        client, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, resource, requestedScopes: requested,
        preselected: this.preselect(host, requested), state: q.state === undefined ? null : q.state, ip, clientHost: host, ipCounted
      });
    } catch (err) {
      if (err instanceof OAuthError) return this.refuse(res, err.status, 'Try again later', err.message);
      throw err;
    }
    const { pending, cookie } = created;
    sendHtml(res, 200, consentPage({ pending, scopeRegistry: this.scopeRegistry, waitUrl: this.waitUrl(pending) }), {
      ...CONSENT_HEADERS,
      'set-cookie': `kl_authz=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/oauth`
    });
    return undefined;
  }

  waitUrl(pending) {
    return `/oauth/authorize/wait?id=${encodeURIComponent(pending.grant_id)}`;
  }

  wait(req, res, url) {
    const id = url.searchParams.get('id') || '';
    const pending = this.pending.get(id);
    if (!pending) {
      return this.refuse(res, 410, 'This request has ended', 'It expired or was already used. Start again from your client.');
    }
    if (!this.pending.checkCookie(id, parseCookies(req.headers.cookie).kl_authz)) {
      return this.refuse(res, 403, 'Not this browser', 'Only the browser that started this request can finish it. Start again from your client.');
    }
    if (pending.status === 'pending') {
      sendHtml(res, 200, consentPage({ pending, scopeRegistry: this.scopeRegistry, waitUrl: this.waitUrl(pending) }), CONSENT_HEADERS);
      return undefined;
    }
    // The redirect_uri was matched exactly against the client's registered
    // list at authorize time. The response parameters are appended to it as
    // registered, leaving its own query exactly as it was; state goes back
    // exactly as the client sent it.
    const params = new URLSearchParams();
    if (pending.status === 'approved') params.set('code', pending.code);
    else params.set('error', 'access_denied');
    if (pending.state !== null) params.set('state', pending.state);
    params.set('iss', this.issuer);
    const location = `${pending.redirect_uri}${pending.redirect_uri.includes('?') ? '&' : '?'}${params.toString()}`;
    this.pending.remove(id);
    res.writeHead(302, { location, ...CONSENT_HEADERS });
    res.end();
    return undefined;
  }
}

module.exports = { OAuthServer, BODY_LIMIT, STATE_MAX };
