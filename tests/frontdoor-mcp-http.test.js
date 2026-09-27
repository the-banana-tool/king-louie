// tests/frontdoor-mcp-http.test.js — fleet stage 4 §3.5.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { McpHttpEndpoint } = require('../src/frontdoor/mcp/http-endpoint');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request } = require('./helpers/oauth-test-client');
const { MCP_TOOLS } = require('../src/fleet/tool-definitions');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });

function fakeRouter() {
  const jobs = new EventEmitter();
  const state = { status: 'running', lines: 0 };
  return {
    jobs, state, calls: [],
    toolDefinitions: () => MCP_TOOLS,
    isTerminal: (s) => ['succeeded', 'failed', 'cancelled', 'denied', 'expired'].includes(s),
    async callTool(name, args, ctx) {
      this.calls.push([name, args, ctx.scopes]);
      if (name === 'get_job') return { job_id: args.job_id, status: state.status, output: { untrusted_output: true, lines: [] } };
      if (name === 'list_machines') return [{ name: 'web-01' }];
      return { ok: false, error: { code: 'machine_offline', message: 'machine_offline: web-01 is offline' } };
    },
    watches: [],
    watchJob(jobId, onUpdate, ctx) {
      this.watches.push([jobId, ctx]);
      const fn = (u) => onUpdate(u);
      jobs.on(jobId, fn);
      return () => jobs.removeListener(jobId, fn);
    }
  };
}

async function start({ scopes = [{ scope: 'fleet:read', machines: null }], holdS = 1, now = Date.now } = {}) {
  const router = fakeRouter();
  const h = await startFrontDoorHttp({
    now,
    pendingPerIp: 10,
    mcp: ({ tokens, grants, scopeRegistry }) => new McpHttpEndpoint({ mcpHost: 'mcp.kl.example.com', resourceUrl: 'https://mcp.kl.example.com/mcp', tokens, grants, scopeRegistry, router, progressHoldS: holdS, now })
  });
  running.push(h);
  const r = await h.connect({ scopes });
  return { h, router, token: r.tokens.access_token, refresh: r.tokens.refresh_token, clientId: r.clientId, grantId: r.grantId };
}

const rpc = (t, message, { session = null, version = '2025-11-25', headers = {} } = {}) => request(t.h.base, {
  method: 'POST', path: '/mcp', json: message,
  headers: { authorization: `Bearer ${t.token}`, accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}), ...headers }
});

async function session(t, version = '2025-11-25') {
  const res = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { version: null });
  return { res, id: res.headers['mcp-session-id'] };
}

describe('the MCP endpoint', () => {
  it('initialize negotiates the version and binds a session to the grant', async () => {
    const t = await start();
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const { res, id } = await session(t, v);
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, v);
      assert.match(id, /^[0-9a-f]{32}$/);
    }
    const { res } = await session(t, '1999-01-01');
    assert.equal(res.json.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest');
  });

  it('401 with WWW-Authenticate for a missing, unknown or foreign-audience token; 403 for a foreign Origin', async () => {
    const t = await start();
    const noToken = await request(t.h.base, { method: 'POST', path: '/mcp', json: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers['www-authenticate'], 'Bearer error="invalid_token", resource_metadata="https://mcp.kl.example.com/.well-known/oauth-protected-resource/mcp"');
    const bad = await rpc({ ...t, token: 'kla_nope' }, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(bad.status, 401);
    const origin = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(origin.status, 403);
  });

  it('202 for notifications and responses; 400 for a batch; 405 for GET; sessions must be ours and need the version header', async () => {
    const t = await start();
    const { id } = await session(t);
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: id })).status, 202);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 9, result: {} }, { session: id })).status, 202);
    assert.equal((await rpc(t, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { session: id })).status, 400);
    assert.equal((await request(t.h.base, { method: 'GET', path: '/mcp', headers: { authorization: `Bearer ${t.token}` } })).status, 405);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: 'f'.repeat(32) })).status, 404);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: id, version: null })).status, 400);
    const other = await t.h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const theirs = await session({ ...t, token: other.tokens.access_token });
    assert.equal(theirs.res.status, 200);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: theirs.id })).status, 404, "another grant's session on the same front door");
    assert.equal((await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': id } })).status, 204);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: id })).status, 404);
  });

  it('tools/list follows the scopes; a call without its scope is insufficient_scope', async () => {
    const t = await start();
    const { id } = await session(t);
    const list = await rpc(t, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { session: id });
    assert.deepEqual(list.json.result.tools.map((x) => x.name).sort(), ['describe_machine', 'get_job', 'get_job_logs', 'get_state', 'list_machines']);
    const call = await rpc(t, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.status' } } }, { session: id });
    assert.equal(call.json.result.isError, true);
    assert.deepEqual(JSON.parse(call.json.result.content[0].text), { error: 'insufficient_scope', message: 'insufficient_scope: this client was not granted fleet:run', required: 'fleet:run' });
    assert.equal(t.router.calls.length, 0, 'nothing reached the router');
    const ok = await rpc(t, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_machines', arguments: {} } }, { session: id });
    assert.deepEqual(JSON.parse(ok.json.result.content[0].text), [{ name: 'web-01' }]);
  });

  it('a router refusal comes back as a tool error', async () => {
    const t = await start({ scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: null }] });
    const { id } = await session(t);
    const r = await rpc(t, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.status' } } }, { session: id });
    assert.equal(r.json.result.isError, true);
    assert.equal(JSON.parse(r.json.result.content[0].text).error, 'machine_offline');
  });

  it('long-poll get_job streams progress over SSE and returns at the first status change', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const pending = rpc(t, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-1' }, _meta: { progressToken: 'p1' } } }, { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-1', { status: 'running', log_lines: 3 });
    t.router.state.status = 'succeeded';
    t.router.jobs.emit('web-01:job-1', { status: 'succeeded', log_lines: 5 });
    const res = await pending;
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    const events = res.text.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^event: message\ndata: /, '')));
    assert.deepEqual(events[0], { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 3, message: 'running' } });
    assert.equal(events.at(-1).id, 7);
    assert.equal(JSON.parse(events.at(-1).result.content[0].text).status, 'succeeded');
    // The router gets the caller's grant and scopes, so it can refuse a job the grant may not see.
    const [[watched, ctx]] = t.router.watches;
    assert.deepEqual([watched, ctx.grant.grant_id, ctx.session], ['web-01:job-1', t.grantId, id]);
    assert.ok(Array.isArray(ctx.scopes) && ctx.scopes.length > 0);
  });

  it('long-poll ends at the hold even without a change, and when the node goes offline', async () => {
    const t = await start({ holdS: 1 });
    const { id } = await session(t);
    const started = Date.now();
    const res = await rpc(t, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-2' }, _meta: { progressToken: 'p2' } } }, { session: id });
    assert.ok(Date.now() - started >= 900);
    assert.match(res.text, /"id":8/);
    const off = rpc(t, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-3' }, _meta: { progressToken: 'p3' } } }, { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-3', { status: 'running', log_lines: 0, offline: true });
    const offRes = await off;
    assert.match(offRes.text, /"id":9/);
  });

  it('an expired token mid-job: 401, refresh, get_job on the same job id succeeds (§10 condition 3)', async () => {
    let now = Date.now();
    const t = await start({ now: () => now });
    const { id } = await session(t);
    now += 3600001;
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 10, method: 'ping' }, { session: id })).status, 401);
    const refreshed = await request(t.h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId } });
    assert.equal(refreshed.status, 200);
    const again = await rpc({ ...t, token: refreshed.json.access_token }, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-1' } } }, { session: id });
    assert.equal(JSON.parse(again.json.result.content[0].text).job_id, 'web-01:job-1');
  });

  it('revoking the grant ends its sessions at once', async () => {
    const t = await start();
    const { id } = await session(t);
    const { body: { challenge } } = await t.h.phoneCall(t.h.phone, 'POST', '/v1/challenges', { purpose: 'revoke' }); // ruling T2-purpose
    await t.h.phoneCall(t.h.phone, 'POST', `/v1/clients/${t.grantId}/revoke`, t.h.phone.revokeClient({ frontdoorId: t.h.fd.nodeId, grantId: t.grantId, challenge }));
    assert.deepEqual(t.h.revokedGrants, [t.grantId]);
    assert.equal(t.h.mcp.sessionCount(t.grantId), 0);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 12, method: 'ping' }, { session: id })).status, 401);
  });

  it('at most 20 sessions per grant: the oldest closes', async () => {
    const t = await start();
    const first = await session(t);
    for (let i = 0; i < 20; i += 1) await session(t);
    assert.equal(t.h.mcp.sessionCount(t.grantId), 20);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 13, method: 'ping' }, { session: first.id })).status, 404);
  });
});

// Raw headers (an array of name, value pairs) so one header can be sent twice.
function rawRequest(base, { method = 'POST', path = '/mcp', headers = [], body = null }) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: [...headers, ...(body ? ['content-length', String(Buffer.byteLength(body))] : [])] }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const call = (id, name, args, meta) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
const events = (text) => text.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^event: message\ndata: /, '')));
const stubDeps = () => ({
  mcpHost: 'mcp.kl.example.com',
  resourceUrl: 'https://mcp.kl.example.com/mcp',
  tokens: { authenticate: () => null },
  grants: { live: () => null, touch: () => {} },
  scopeRegistry: { requiredScopeFor: () => null, toolsFor: () => new Set() },
  router: fakeRouter(),
  serverVersion: '0'
});

describe('the MCP endpoint: hardening', () => {
  it('refuses a second Authorization, Origin or Mcp-Session-Id header', async () => {
    const t = await start();
    const { id } = await session(t);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const base = ['host', 'mcp.kl.example.com', 'content-type', 'application/json', 'mcp-protocol-version', '2025-11-25'];
    const auth = ['authorization', `Bearer ${t.token}`];
    const sid = ['mcp-session-id', id];
    const origin = ['origin', 'https://mcp.kl.example.com'];
    assert.equal((await rawRequest(t.h.base, { headers: [...base, ...auth, ...sid, ...origin], body })).status, 200, 'one of each is fine');
    assert.equal((await rawRequest(t.h.base, { headers: [...base, ...auth, ...auth, ...sid], body })).status, 400);
    assert.equal((await rawRequest(t.h.base, { headers: [...base, ...auth, ...sid, ...origin, ...origin], body })).status, 400);
    assert.equal((await rawRequest(t.h.base, { headers: [...base, ...auth, ...sid, ...sid], body })).status, 400);
  });

  it('a body that is not application/json is 415; over 256 KiB is 413; nothing reaches the router', async () => {
    const t = await start();
    const { id } = await session(t);
    const headers = { authorization: `Bearer ${t.token}`, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
    const text = JSON.stringify(call(1, 'list_machines', {}));
    const plain = await request(t.h.base, { method: 'POST', path: '/mcp', headers: { ...headers, 'content-type': 'text/plain' }, raw: text });
    assert.equal(plain.status, 415);
    const big = await request(t.h.base, { method: 'POST', path: '/mcp', headers: { ...headers, 'content-type': 'application/json' }, raw: JSON.stringify({ ...call(2, 'list_machines', {}), pad: 'x'.repeat(256 * 1024) }) });
    assert.equal(big.status, 413);
    assert.equal(big.headers.connection, 'close');
    assert.deepEqual(t.router.calls, []);
  });

  it('notifications and responses need the session too; a request id must be a string or a number', async () => {
    const t = await start();
    const { id } = await session(t);
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 404);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 9, result: {} })).status, 404);
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: id, version: null })).status, 400);
    for (const bad of [null, { a: 1 }, [1], true]) {
      assert.equal((await rpc(t, { jsonrpc: '2.0', id: bad, method: 'ping' }, { session: id })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 1, method: 7 }, { session: id })).status, 400);
    assert.equal((await rpc(t, { jsonrpc: '1.0', id: 1, method: 'ping' }, { session: id })).status, 400);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 'a', method: 'ping' }, { session: id })).status, 200);
  });

  it('tools/call: bad params and unknown tools are JSON-RPC errors that never reach the router', async () => {
    const t = await start();
    const { id } = await session(t);
    const cases = [undefined, [], { name: 7 }, { name: 'list_machines', arguments: [] }, { name: 'list_machines', arguments: 'x' }, { name: 'no_such_tool', arguments: {} }, { name: '__proto__' }, { name: 'toString' }];
    for (const params of cases) {
      const r = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', ...(params === undefined ? {} : { params }) }, { session: id });
      assert.equal(r.status, 200);
      assert.equal(r.json.error.code, -32602, JSON.stringify(params));
    }
    assert.deepEqual(t.router.calls, []);
  });

  it('a failing last-used save never refuses a request', async () => {
    const t = await start();
    const { id } = await session(t);
    t.h.grants.touch = () => { throw new Error('disk full'); };
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { session: id })).status, 200);
  });

  it('a router that throws is a coded tool error without the exception text', async () => {
    const t = await start();
    const { id } = await session(t);
    t.router.callTool = async () => { throw new Error('secret internal path'); };
    const r = await rpc(t, call(1, 'list_machines', {}), { session: id });
    assert.equal(r.json.result.isError, true);
    assert.equal(JSON.parse(r.json.result.content[0].text).error, 'internal');
    assert.doesNotMatch(r.text, /secret/);
  });

  it("DELETE of another grant's session is 404 and leaves it working", async () => {
    const t = await start();
    const other = await t.h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const theirs = await session({ ...t, token: other.tokens.access_token });
    const del = await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': theirs.id } });
    assert.equal(del.status, 404);
    assert.equal((await rpc({ ...t, token: other.tokens.access_token }, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: theirs.id })).status, 200);
  });

  it('revoking the grant ends a long-poll in flight at once, without asking the router again', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const started = Date.now();
    const pending = rpc(t, call(20, 'get_job', { job_id: 'web-01:job-9' }, { progressToken: 'p9' }), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.router.jobs.listenerCount('web-01:job-9'), 1);
    const { body: { challenge } } = await t.h.phoneCall(t.h.phone, 'POST', '/v1/challenges', { purpose: 'revoke' });
    await t.h.phoneCall(t.h.phone, 'POST', `/v1/clients/${t.grantId}/revoke`, t.h.phone.revokeClient({ frontdoorId: t.h.fd.nodeId, grantId: t.grantId, challenge }));
    const res = await pending;
    assert.ok(Date.now() - started < 3000, 'not held to the end');
    const last = events(res.text).at(-1);
    assert.equal(last.id, 20);
    assert.equal(last.result, undefined);
    assert.equal(last.error.message, 'the session ended');
    assert.equal(t.router.calls.filter((c) => c[0] === 'get_job').length, 1, 'only the first call');
    assert.equal(t.router.jobs.listenerCount('web-01:job-9'), 0, 'unsubscribed');
  });

  it('DELETE of the session ends its long-poll; progress text is printable and short', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const pending = rpc(t, call(21, 'get_job', { job_id: 'web-01:job-8' }, { progressToken: 8 }), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-8', { status: 'running', log_lines: 'lots' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': id } })).status, 204);
    const evs = events((await pending).text);
    assert.deepEqual(evs[0].params, { progressToken: 8, progress: 0, message: 'running' });
    assert.equal(evs.at(-1).error.message, 'the session ended');
    assert.equal(t.router.calls.filter((c) => c[0] === 'get_job').length, 1);

    const again = await session(t);
    const p2 = rpc(t, call(22, 'get_job', { job_id: 'web-01:job-7' }, { progressToken: 'p7' }), { session: again.id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-7', { status: `run‮ing\u0007${'x'.repeat(200)}`, log_lines: 2 });
    const ev = events((await p2).text)[0];
    assert.equal(ev.params.message, `runing${'x'.repeat(58)}`, 'controls and bidi stripped, 64 characters');
  });

  it('a long-poll re-checks the grant before asking the router for the result', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const pending = rpc(t, call(24, 'get_job', { job_id: 'web-01:job-6' }, { progressToken: 'p6' }), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    // Revoked in the store alone (no onGrantRevoked hook reached the endpoint).
    t.h.grants.revoke(t.grantId, 'test');
    t.router.jobs.emit('web-01:job-6', { status: 'succeeded', log_lines: 1 });
    const last = events((await pending).text).at(-1);
    assert.equal(last.error.message, 'the session ended');
    assert.equal(t.router.calls.filter((c) => c[0] === 'get_job').length, 1);
  });

  it('a grant revoked while its call runs gets no result', async () => {
    const t = await start();
    const { id } = await session(t);
    let release;
    t.router.callTool = async () => { await new Promise((r) => { release = r; }); return [{ name: 'web-01' }]; };
    const pending = rpc(t, call(23, 'list_machines', {}), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.h.grants.revoke(t.grantId, 'test');
    t.h.mcp.endSessionsForGrant(t.grantId);
    release();
    const res = await pending;
    assert.equal(res.status, 401, 'the token no longer authenticates');
    assert.doesNotMatch(res.text, /web-01/);
  });

  it('a session deleted while its call runs gets no result', async () => {
    const t = await start();
    const { id } = await session(t);
    let release;
    t.router.callTool = async () => { await new Promise((r) => { release = r; }); return [{ name: 'web-01' }]; };
    const pending = rpc(t, call(25, 'list_machines', {}), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': id } })).status, 204);
    release();
    const res = await pending;
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.text, /web-01/);
  });

  it('endSessionsForGrant never throws into the revoke helper, and still ends the other sessions', () => {
    const ep = new McpHttpEndpoint(stubDeps());
    ep.sessions.set('a', { id: 'a', grantId: 'gr_1', seq: 1, streams: new Set([() => { throw new Error('boom'); }]) });
    ep.sessions.set('b', { id: 'b', grantId: 'gr_1', seq: 2, streams: new Set() });
    ep.sessions.set('c', { id: 'c', grantId: 'gr_2', seq: 3, streams: new Set() });
    assert.doesNotThrow(() => ep.endSessionsForGrant('gr_1'));
    assert.equal(ep.sessionCount('gr_1'), 0);
    assert.equal(ep.sessionCount('gr_2'), 1);
    ep.sessions = null; // even a broken endpoint does not throw
    assert.doesNotThrow(() => ep.endSessionsForGrant('gr_2'));
  });

  it('the constructor fails closed without its dependencies', () => {
    assert.doesNotThrow(() => new McpHttpEndpoint(stubDeps()));
    for (const k of ['mcpHost', 'resourceUrl', 'tokens', 'grants', 'scopeRegistry', 'router']) {
      assert.throws(() => new McpHttpEndpoint({ ...stubDeps(), [k]: undefined }), TypeError, k);
    }
    assert.throws(() => new McpHttpEndpoint({ ...stubDeps(), progressHoldS: 56 }), RangeError);
    assert.throws(() => new McpHttpEndpoint({ ...stubDeps(), progressHoldS: -1 }), RangeError);
    assert.throws(() => new McpHttpEndpoint({ ...stubDeps(), maxSessionsPerGrant: 0 }), RangeError);
  });
});

// Sends the headers and the first 10 bytes of `message`, runs `during()`, then
// sends the rest: a request whose body is still arriving when something is
// revoked, deleted or evicted.
function slowRpc(t, message, { session, version = '2025-11-25' }, during) {
  const http = require('http');
  const body = Buffer.from(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    const req = http.request(`${t.h.base}/mcp`, {
      method: 'POST',
      headers: { host: 'mcp.kl.example.com', authorization: `Bearer ${t.token}`, 'content-type': 'application/json', 'content-length': String(body.length), 'mcp-session-id': session, 'mcp-protocol-version': version }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.flushHeaders();
    req.write(body.subarray(0, 10));
    setTimeout(async () => {
      try {
        await during();
        req.end(body.subarray(10));
      } catch (err) {
        req.destroy();
        reject(err);
      }
    }, 100);
  });
}

const runbook = (id) => call(id, 'run_runbook', { machine: 'web-01', runbook: 'site.status' });
const RUN = [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: null }];

describe('the MCP endpoint: requests in flight', () => {
  it('a grant revoked while the body arrives: tools/call, ping and tools/list are refused and nothing reaches the router', async () => {
    for (const message of [runbook(30), { jsonrpc: '2.0', id: 31, method: 'ping' }, { jsonrpc: '2.0', id: 32, method: 'tools/list' }]) {
      const t = await start({ scopes: RUN });
      const { id } = await session(t);
      const res = await slowRpc(t, message, { session: id }, async () => {
        const { body: { challenge } } = await t.h.phoneCall(t.h.phone, 'POST', '/v1/challenges', { purpose: 'revoke' });
        const r = await t.h.phoneCall(t.h.phone, 'POST', `/v1/clients/${t.grantId}/revoke`, t.h.phone.revokeClient({ frontdoorId: t.h.fd.nodeId, grantId: t.grantId, challenge }));
        assert.equal(r.status, 204);
      });
      assert.equal(res.status, 401, message.method);
      assert.match(res.headers['www-authenticate'], /invalid_token/);
      assert.deepEqual(t.router.calls, []);
    }
  });

  it('an access token revoked (/oauth/revoke) while the body arrives: refused, nothing reaches the router', async () => {
    const t = await start({ scopes: RUN });
    const { id } = await session(t);
    const res = await slowRpc(t, runbook(33), { session: id }, async () => {
      const r = await request(t.h.base, { method: 'POST', path: '/oauth/revoke', form: { token: t.token, client_id: t.clientId } });
      assert.equal(r.status, 200);
    });
    assert.equal(res.status, 401);
    assert.deepEqual(t.router.calls, []);
  });

  it('the session deleted while the body arrives: 404 for tools/call, ping and tools/list; nothing reaches the router', async () => {
    for (const message of [runbook(34), { jsonrpc: '2.0', id: 37, method: 'ping' }, { jsonrpc: '2.0', id: 38, method: 'tools/list' }]) {
      const t = await start({ scopes: RUN });
      const { id } = await session(t);
      const res = await slowRpc(t, message, { session: id }, async () => {
        const r = await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': id } });
        assert.equal(r.status, 204);
      });
      assert.equal(res.status, 404, message.method);
      assert.deepEqual(t.router.calls, []);
    }
  });

  it('the session evicted (a 21st initialize) while the body arrives: 404 for tools/call, ping and tools/list; nothing reaches the router', async () => {
    for (const message of [runbook(35), { jsonrpc: '2.0', id: 39, method: 'ping' }, { jsonrpc: '2.0', id: 40, method: 'tools/list' }]) {
      const t = await start({ scopes: RUN });
      const { id } = await session(t);
      const res = await slowRpc(t, message, { session: id }, async () => {
        for (let i = 0; i < 20; i += 1) await session(t);
        assert.equal(t.h.mcp.sessionCount(t.grantId), 20);
      });
      assert.equal(res.status, 404, message.method);
      assert.deepEqual(t.router.calls, []);
    }
  });

  it('MCP-Protocol-Version must be the version the session negotiated', async () => {
    const t = await start();
    const { id } = await session(t, '2025-06-18');
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { session: id, version: '2025-11-25' })).status, 400, 'supported, but not this session\'s');
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: id, version: '2025-03-26' })).status, 400);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: id, version: '2025-06-18' })).status, 200);
  });

  // Final review F-3: the header arrived in 2025-06-18; a 2025-03-26 client
  // never sends it, and the MCP transport text says a server that gets none
  // SHOULD assume 2025-03-26. A present header must still match the session.
  it('a 2025-03-26 session works without MCP-Protocol-Version; later versions still need it', async () => {
    const t = await start();
    const old = (await session(t, '2025-03-26')).id;
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: old, version: null })).status, 202);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { session: old, version: null })).status, 200);
    const list = await rpc(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session: old, version: null });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.result.tools));
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 3, method: 'ping' }, { session: old, version: '2025-06-18' })).status, 400, 'present and wrong');
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 4, method: 'ping' }, { session: old, version: '2025-03-26' })).status, 200, 'present and right');
    for (const v of ['2025-06-18', '2025-11-25']) {
      const { id } = await session(t, v);
      assert.equal((await rpc(t, { jsonrpc: '2.0', id: 5, method: 'ping' }, { session: id, version: null })).status, 400, v);
    }
  });

  it('a long-poll update without a status (log lines only) is not a status change', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const pending = rpc(t, call(36, 'get_job', { job_id: 'web-01:job-5' }, { progressToken: 'p5' }), { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-5', { log_lines: 4 });
    t.router.jobs.emit('web-01:job-5', { status: 7, log_lines: 5 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.router.calls.filter((c) => c[0] === 'get_job').length, 1, 'still holding');
    t.router.state.status = 'succeeded';
    t.router.jobs.emit('web-01:job-5', { status: 'succeeded', log_lines: 6 });
    const evs = events((await pending).text);
    assert.deepEqual(evs.slice(0, 3).map((e) => e.params.progress), [4, 5, 6]);
    assert.equal(evs[0].params.message, '');
    assert.equal(JSON.parse(evs.at(-1).result.content[0].text).status, 'succeeded');
  });
});
