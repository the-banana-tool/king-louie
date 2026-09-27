// MCP Streamable HTTP on https://mcp.<domain>/mcp (fleet stage 4 §3.5),
// written by hand: the repo has no MCP SDK. Every request is authenticated
// by its bearer token (opaque, looked up each time through
// TokenStore#authenticate, which also asks the grant store, so revocation is
// immediate); sessions are bound to the grant; tools are filtered by scope.
// Revoking a grant ends its sessions and any long-poll they hold
// (endSessionsForGrant, the grant store's onGrantRevoked target).
const crypto = require('crypto');
const { createLogger } = require('../../logging');
const { parseScope } = require('../../fleet/scope-rules');
const { readBody, sendJson, requestHost, printable } = require('../http-util');

const log = createLogger('frontdoor/mcp');
const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const BODY_LIMIT = 256 * 1024;
const HOLD_MAX_S = 55;
const STATUS_MAX = 64;
// Headers read once each: a second copy could be read one way here and
// another way by whatever sent it, so more than one is refused.
const SINGLE_HEADERS = ['authorization', 'origin', 'mcp-session-id', 'mcp-protocol-version', 'content-type'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRpcId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function headerCount(req, name) {
  let n = 0;
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === name) n += 1;
  return n;
}

// The scope names a token's scope strings grant; a string that does not
// parse grants nothing.
function names(scopes) {
  const out = new Set();
  for (const s of Array.isArray(scopes) ? scopes : []) {
    try {
      out.add(parseScope(s).scope);
    } catch {
      // grants nothing
    }
  }
  return out;
}

function requireFn(obj, fn, what) {
  if (!obj || typeof obj[fn] !== 'function') throw new TypeError(`McpHttpEndpoint needs ${what}.${fn}()`);
}

class McpHttpEndpoint {
  constructor({ mcpHost, resourceUrl, tokens, grants, scopeRegistry, router, progressHoldS = 20, maxSessionsPerGrant = 20, now = Date.now, serverVersion = null } = {}) {
    // Fail closed: without any of these nothing could be authenticated,
    // scoped or answered.
    if (typeof mcpHost !== 'string' || !mcpHost) throw new TypeError('McpHttpEndpoint needs mcpHost');
    if (typeof resourceUrl !== 'string' || !resourceUrl) throw new TypeError('McpHttpEndpoint needs resourceUrl');
    requireFn(tokens, 'authenticate', 'tokens');
    requireFn(grants, 'live', 'grants');
    requireFn(grants, 'touch', 'grants');
    requireFn(scopeRegistry, 'requiredScopeFor', 'scopeRegistry');
    requireFn(scopeRegistry, 'toolsFor', 'scopeRegistry');
    for (const fn of ['toolDefinitions', 'callTool', 'watchJob', 'isTerminal']) requireFn(router, fn, 'router');
    if (typeof progressHoldS !== 'number' || !(progressHoldS >= 0 && progressHoldS <= HOLD_MAX_S)) {
      throw new RangeError(`progressHoldS must be 0–${HOLD_MAX_S}`);
    }
    if (!Number.isInteger(maxSessionsPerGrant) || maxSessionsPerGrant < 1) throw new RangeError('maxSessionsPerGrant must be a positive integer');
    this.mcpHost = mcpHost.toLowerCase();
    this.origin = `https://${this.mcpHost}`;
    this.resourceUrl = resourceUrl;
    this.metadataUrl = `${this.origin}/.well-known/oauth-protected-resource/mcp`;
    this.tokens = tokens;
    this.grants = grants;
    this.scopeRegistry = scopeRegistry;
    this.router = router;
    this.holdMs = progressHoldS * 1000;
    this.maxSessionsPerGrant = maxSessionsPerGrant;
    this.now = now;
    this.serverVersion = serverVersion || require('../../../package.json').version;
    // id → { id, grantId, version, createdAt, lastUsed, streams: Set<end()> }
    this.sessions = new Map();
    this.seq = 0; // creation order, for evicting the oldest session
  }

  sessionCount(grantId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.grantId === grantId) n += 1;
    return n;
  }

  // The grant store's onGrantRevoked target: ends every session of the grant
  // and every long-poll they hold. Never throws into the revoke helper.
  endSessionsForGrant(grantId) {
    try {
      for (const s of [...this.sessions.values()]) {
        if (s.grantId === grantId) this._endSession(s);
      }
    } catch (err) {
      log.error(`ending the MCP sessions of grant ${grantId} failed: ${err && err.message}`);
    }
  }

  _endSession(session) {
    this.sessions.delete(session.id);
    for (const end of [...session.streams]) {
      try {
        end();
      } catch (err) {
        log.error(`closing a long-poll of MCP session ${session.id} failed: ${err && err.message}`);
      }
    }
    session.streams.clear();
  }

  _live(session) {
    return this.sessions.get(session.id) === session && Boolean(this.grants.live(session.grantId));
  }

  // Whether a request may still act for its grant: the token authenticates
  // again (not revoked, not expired, grant live) for the same grant, and the
  // session, when there is one, is still this endpoint's. Checked after the
  // body arrives and again right before anything reaches the router, since a
  // revocation may land while the request is in flight.
  // → null when it may; 'token' or 'session' naming what is gone.
  _recheck(req, grantId, session) {
    const auth = this._auth(req);
    if (!auth || auth.grant.grant_id !== grantId) return 'token';
    if (session && !this._live(session)) return 'session';
    return null;
  }

  _refuse(res, why, id) {
    if (why === 'token') this._unauthorized(res);
    else sendJson(res, 404, { jsonrpc: '2.0', id, error: { code: -32001, message: 'the session ended' } });
  }

  _unauthorized(res) {
    sendJson(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${this.metadataUrl}"` });
  }

  // TokenStore#authenticate checks the hash, expiry, audience and that the
  // grant is live; the grant record is then read for the router.
  _auth(req) {
    // The scheme name is case-insensitive (RFC 9110 §11.1).
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const token = this.tokens.authenticate(m[1], { aud: this.resourceUrl });
    if (!token) return null;
    const grant = this.grants.live(token.grant_id);
    if (!grant) return null;
    return { token, grant };
  }

  async handle(req, res) {
    if (requestHost(req) !== this.mcpHost) {
      sendJson(res, 421, { error: 'misdirected_request' });
      return;
    }
    for (const h of SINGLE_HEADERS) {
      if (headerCount(req, h) > 1) {
        sendJson(res, 400, { error: 'invalid_request', error_description: `more than one ${h} header` });
        return;
      }
    }
    // DNS rebinding: a browser page elsewhere must not drive this endpoint.
    if (req.headers.origin !== undefined && req.headers.origin !== this.origin) {
      sendJson(res, 403, { error: 'forbidden', error_description: 'foreign Origin' });
      return;
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST, DELETE' });
      return;
    }
    const auth = this._auth(req);
    if (!auth) {
      this._unauthorized(res);
      return;
    }
    const grantId = auth.grant.grant_id;
    try {
      this.grants.touch(grantId);
    } catch (err) {
      // last_used_at is bookkeeping; a failed save never refuses a request.
      log.warn(`recording use of grant ${grantId} failed: ${err && err.message}`);
    }
    const sessionHeader = req.headers['mcp-session-id'];
    const lookup = () => {
      const found = typeof sessionHeader === 'string' ? this.sessions.get(sessionHeader) : undefined;
      return found && found.grantId === grantId ? found : null;
    };
    if (req.method === 'DELETE') {
      const session = lookup();
      if (!session) {
        sendJson(res, 404, { error: 'unknown_session' });
        return;
      }
      this._endSession(session);
      res.writeHead(204);
      res.end();
      return;
    }
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
      sendJson(res, 415, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the body must be application/json' } });
      return;
    }
    let message;
    try {
      message = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8'));
    } catch (err) {
      if (err && err.status === 413) sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: err.message } }, { connection: 'close' });
      else sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // The body may have taken a while: whatever was revoked, deleted or
    // evicted meanwhile counts. The token is authenticated again and the
    // session looked up again by its id.
    const fresh = this._auth(req);
    if (!fresh || fresh.grant.grant_id !== grantId) {
      this._unauthorized(res);
      return;
    }
    const session = lookup();
    const kind = this._kind(message);
    if (!kind) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per request' } });
      return;
    }
    const id = kind === 'request' ? message.id : null;
    if (kind === 'request' && message.method === 'initialize') {
      this._initialize(res, message, grantId);
      return;
    }
    // Everything after initialize needs this grant's session and the
    // protocol version it negotiated, notifications and responses included.
    if (!session) {
      sendJson(res, 404, { jsonrpc: '2.0', id, error: { code: -32001, message: 'unknown session; initialize again' } });
      return;
    }
    if (req.headers['mcp-protocol-version'] !== session.version) {
      sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: `MCP-Protocol-Version must be ${session.version}, the version this session negotiated` } });
      return;
    }
    session.lastUsed = this.now();
    // Notifications and responses the client posts are acknowledged only.
    if (kind !== 'request') {
      res.writeHead(202);
      res.end();
      return;
    }
    const scopes = fresh.token.scopes;
    if (message.method === 'ping') return this._reply(res, id, {});
    if (message.method === 'tools/list') return this._reply(res, id, { tools: this._tools(scopes) });
    if (message.method === 'tools/call') return this._call(req, res, message, session, { grant: fresh.grant, scopes, session: session.id });
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return undefined;
  }

  // 'request' | 'notification' | 'response' | null (not one JSON-RPC 2.0
  // message: a batch, a null or non-string/number id, no method and no
  // result/error).
  _kind(m) {
    if (!isPlainObject(m) || m.jsonrpc !== '2.0') return null;
    if (hasOwn(m, 'method')) {
      if (typeof m.method !== 'string') return null;
      if (!hasOwn(m, 'id')) return 'notification';
      return isRpcId(m.id) ? 'request' : null;
    }
    if (hasOwn(m, 'id') && (hasOwn(m, 'result') || hasOwn(m, 'error'))) return 'response';
    return null;
  }

  _reply(res, id, result) {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  }

  _initialize(res, message, grantId) {
    const asked = isPlainObject(message.params) ? message.params.protocolVersion : undefined;
    const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const mine = [...this.sessions.values()].filter((s) => s.grantId === grantId).sort((a, b) => a.seq - b.seq);
    while (mine.length >= this.maxSessionsPerGrant) this._endSession(mine.shift());
    const id = crypto.randomBytes(16).toString('hex');
    this.seq += 1;
    this.sessions.set(id, { id, grantId, version, seq: this.seq, createdAt: this.now(), lastUsed: this.now(), streams: new Set() });
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'king-louie-frontdoor', version: this.serverVersion } }
    }, { 'mcp-session-id': id });
  }

  _tools(scopes) {
    const allowed = this.scopeRegistry.toolsFor([...names(scopes)]);
    return this.router.toolDefinitions().filter((t) => allowed.has(t.name));
  }

  _toolResult(result) {
    const refused = isPlainObject(result) && result.ok === false && isPlainObject(result.error);
    let body = result === undefined ? null : result;
    if (refused) {
      const { code, message, ...extra } = result.error;
      body = { error: code, message, ...extra };
    }
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], ...(refused ? { isError: true } : {}) };
  }

  // A router that throws is a bug or an outage; the client gets a coded
  // error, never the exception's text.
  async _route(name, args, ctx) {
    try {
      return await this.router.callTool(name, args, ctx);
    } catch (err) {
      log.warn(`tools/call ${name} failed: ${err && err.message}`);
      return { ok: false, error: { code: 'internal', message: 'internal: the tool call failed' } };
    }
  }

  async _call(req, res, message, session, ctx) {
    const params = message.params;
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'tools/call needs params.name' } });
    }
    const { name } = params;
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(args)) {
      return sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'params.arguments must be an object' } });
    }
    const required = this.scopeRegistry.requiredScopeFor(name);
    if (!required) {
      return sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } });
    }
    if (!names(ctx.scopes).has(required)) {
      return this._reply(res, message.id, this._toolResult({ ok: false, error: { code: 'insufficient_scope', message: `insufficient_scope: this client was not granted ${required}`, required } }));
    }
    const meta = isPlainObject(params._meta) ? params._meta : {};
    const progressToken = meta.progressToken;
    const wantsStream = /(^|,)\s*text\/event-stream\s*(;|,|$)/i.test(String(req.headers.accept || ''));
    const before = this._recheck(req, session.grantId, session);
    if (before) return this._refuse(res, before, message.id);
    const first = await this._route(name, args, ctx);
    // The grant, token or session may have gone while the call ran.
    const after = this._recheck(req, session.grantId, session);
    if (after) return this._refuse(res, after, message.id);
    const streamable = name === 'get_job' && isRpcId(progressToken) && wantsStream && isPlainObject(first) && first.ok !== false
      && typeof args.job_id === 'string' && !this.router.isTerminal(first.status);
    if (!streamable) return this._reply(res, message.id, this._toolResult(first));
    return this._stream(req, res, message, session, ctx, args, progressToken, first.status);
  }

  // Long-poll get_job (§3.5): progress notifications over SSE, then the
  // result at the first status change, the node going offline, or the hold.
  // Ending the session (DELETE, revocation, eviction) ends the stream with an
  // error and without asking the router again.
  _stream(req, res, message, session, ctx, args, progressToken, initialStatus) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
    };
    let state = 'open'; // → 'finishing' (asking the router) → 'closed'
    let timer = null;
    let unsubscribe = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      session.streams.delete(end);
      try {
        unsubscribe();
      } catch (err) {
        log.warn(`unsubscribing from ${args.job_id} failed: ${err && err.message}`);
      }
    };
    const close = (obj) => {
      state = 'closed';
      cleanup();
      send(obj);
      if (!res.writableEnded) res.end();
    };
    function end() {
      if (state === 'closed') return;
      close({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'the session ended' } });
    }
    const finish = async () => {
      if (state !== 'open') return;
      state = 'finishing';
      clearTimeout(timer);
      if (this._recheck(req, session.grantId, session)) {
        end();
        return;
      }
      const result = await this._route('get_job', args, ctx);
      if (state === 'closed') return;
      if (this._recheck(req, session.grantId, session)) {
        end();
        return;
      }
      close({ jsonrpc: '2.0', id: message.id, result: this._toolResult(result) });
    };
    session.streams.add(end);
    res.on('close', () => {
      if (state !== 'closed') {
        state = 'closed';
        cleanup();
      }
    });
    timer = setTimeout(finish, this.holdMs);
    try {
      const unsub = this.router.watchJob(args.job_id, (u) => {
        if (state !== 'open') return;
        const update = isPlainObject(u) ? u : {};
        const status = typeof update.status === 'string' ? printable(update.status).slice(0, STATUS_MAX) : '';
        const lines = Number.isFinite(update.log_lines) && update.log_lines >= 0 ? update.log_lines : 0;
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: lines, message: status } });
        // An update without a status (log lines only) is not a status change.
        if (update.offline === true || (typeof update.status === 'string' && update.status !== initialStatus)) finish();
      }, ctx); // the router checks the grant's machines and the job's owner
      if (typeof unsub === 'function') unsubscribe = unsub;
    } catch (err) {
      log.warn(`watching ${args.job_id} failed: ${err && err.message}`);
      finish();
      return;
    }
    // An update delivered synchronously may already have finished the
    // stream, before its unsubscribe was known.
    if (state !== 'open') {
      try {
        unsubscribe();
      } catch {
        // already logged by cleanup's path
      }
    }
  }
}

module.exports = { McpHttpEndpoint, PROTOCOL_VERSIONS };
