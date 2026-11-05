// OAuth for the remote window (R-RW-10): the window:attach scope, the second
// protected resource, loopback redirects on any port and GET /window/v1/nodes.
// A token is only ever as good as its audience: an MCP token opens no window
// socket and a window token calls no MCP.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startFrontDoorHttp, FLEET } = require('./helpers/frontdoor-harness');
const { request, pkce, parseConsent, cookieOf } = require('./helpers/oauth-test-client');
const { ClientRegistry, validRedirectUri } = require('../src/frontdoor/oauth/clients');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { McpHttpEndpoint } = require('../src/frontdoor/mcp/http-endpoint');
const { createWindowSplice } = require('../src/frontdoor/window/splice');
const { createWindowRoutes } = require('../src/frontdoor/window/routes');
const { registerWindowScope, WINDOW_SCOPE, WINDOW_SCOPE_TEXT } = require('../src/frontdoor/window/scope');
const TOOL_EXTENSIONS = require('../src/frontdoor/tool-extensions');

const ORIGIN = 'https://mcp.kl.example.com';
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const WINDOW_RESOURCE = `${ORIGIN}/window/v1`;
const CALLBACK = 'http://127.0.0.1/kl/window/callback';
const WITH_WINDOW = [...FLEET, 'window:attach'];
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

const running = [];
afterEach(async () => {
  while (running.length) await running.pop()();
});

const fakeRouter = () => ({ toolDefinitions: () => [], callTool: async () => ({}), watchJob: () => () => {}, isTerminal: () => false });

async function start(options = {}) {
  const h = await startFrontDoorHttp({
    scopesEnabled: WITH_WINDOW,
    pendingPerIp: 20,
    mcp: ({ tokens, grants, scopeRegistry, oauth }) => new McpHttpEndpoint({ mcpHost: 'mcp.kl.example.com', resourceUrl: oauth.resourceUrl, tokens, grants, scopeRegistry, router: fakeRouter() }),
    ...options
  });
  running.push(() => h.stop());
  return h;
}

const windowGrant = (machines = null) => [{ scope: 'window:attach', machines }];
const connectWindow = (h, { machines = null, ...rest } = {}) => h.connect({ redirectUri: 'http://127.0.0.1:51234/kl/window/callback', resource: WINDOW_RESOURCE, scope: 'window:attach', scopes: windowGrant(machines), ...rest });
const registerLoopback = async (h, uri = CALLBACK) => (await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'King Louie window', redirect_uris: [uri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' } })).json.client_id;
const nodes = (h, token) => request(h.base, { path: '/window/v1/nodes', headers: token ? { authorization: `Bearer ${token}` } : {} });
const mcpCall = (h, token) => request(h.base, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, json: { jsonrpc: '2.0', id: 1, method: 'ping' } });

// The routes alone, over stand-ins, for what the harness cannot set up.
async function withRoutes(deps, fn) {
  const routes = createWindowRoutes({ oauth: { windowResourceUrl: WINDOW_RESOURCE, issuer: ORIGIN, windowEnabled: () => true }, ...deps });
  const server = http.createServer((req, res) => routes.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A window at the real splice: the refusal order is the splice's. A token it does
// not take closes 4401, a machine the grant does not cover 4403, and one it covers
// reaches the node check, 4404 here since nothing is online.
async function dial(h, token, node) {
  const splice = createWindowSplice({
    tokens: h.tokens, grants: h.grants, registry: h.registry, nodeHub: { rpc: async () => ({ ok: true }) },
    windowResourceUrl: () => h.oauth.windowResourceUrl, windowEnabled: () => h.oauth.windowEnabled(),
    config: { maxSessionsPerGrant: 4, maxSessionsPerDeviceNode: 2, maxBytesPerHour: 1073741824, idleS: 600 }
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => splice.onMcpUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(async () => {
    await splice.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/window/v1?node=${encodeURIComponent(node.node_id)}`, 'kl-window-v1', { headers: { host: 'mcp.kl.example.com', authorization: `Bearer ${token}` } });
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}

function authorizePath(clientId, redirectUri, extra = {}) {
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: 'S256', ...extra };
  return `/oauth/authorize?${new URLSearchParams(params)}`;
}

// What the phone is shown for an authorize request.
async function phoneView(h, extra) {
  const clientId = await registerLoopback(h);
  const consent = await request(h.base, { path: authorizePath(clientId, CALLBACK, extra) });
  assert.equal(consent.status, 200, consent.text);
  const { userCode } = parseConsent(consent.text);
  return (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
}

describe('redirectAllowed: loopback on any port (RFC 8252 §7.3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-oauth-window-'));
  const registry = new ClientRegistry({ file: path.join(dir, 'clients.json') });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = (...uris) => ({ redirect_uris: uris });

  it('a registered loopback http URI allows the same host, path and query on any port', () => {
    const c = client(CALLBACK, 'http://[::1]/cb?a=1', 'http://localhost:9000/cb');
    for (const ok of ['http://127.0.0.1/kl/window/callback', 'http://127.0.0.1:51234/kl/window/callback', 'http://127.0.0.1:1/kl/window/callback',
      'http://[::1]:7/cb?a=1', 'http://localhost/cb', 'http://localhost:9001/cb']) {
      assert.equal(registry.redirectAllowed(c, ok), true, ok);
    }
  });

  it('a different host, path or query is not the same redirect', () => {
    const c = client(CALLBACK, 'http://[::1]/cb?a=1');
    for (const bad of ['http://localhost:51234/kl/window/callback', 'http://[::1]:51234/kl/window/callback', 'http://127.0.0.1:51234/kl/window/other',
      'http://127.0.0.1:51234/kl/window/callback/', 'http://127.0.0.1:51234/kl/window/callback?x=1', 'http://[::1]:7/cb', 'http://[::1]:7/cb?a=2',
      'https://127.0.0.1:51234/kl/window/callback', 'http://127.0.0.1:51234/kl/window/callback#f', 'http://u@127.0.0.1:51234/kl/window/callback']) {
      assert.equal(registry.redirectAllowed(c, bad), false, bad);
    }
  });

  it('https stays exact, port included, and never matches a loopback registration', () => {
    const c = client('https://client.example.com/cb', 'https://127.0.0.1/cb');
    assert.equal(registry.redirectAllowed(c, 'https://client.example.com/cb'), true);
    for (const bad of ['https://client.example.com:8443/cb', 'https://127.0.0.1:8443/cb', 'http://127.0.0.1:8443/cb', 'http://client.example.com/cb']) {
      assert.equal(registry.redirectAllowed(c, bad), false, bad);
    }
  });

  it('a stored entry that cannot be parsed matches nothing, and no client allows nothing', () => {
    assert.equal(registry.redirectAllowed(client('not a url', null), 'http://127.0.0.1:5/cb'), false);
    assert.equal(registry.redirectAllowed(null, 'http://127.0.0.1:5/cb'), false);
  });

  it('everything but the port must match: a stored entry with userinfo is not this redirect', () => {
    assert.equal(registry.redirectAllowed(client('http://u@127.0.0.1/cb'), 'http://127.0.0.1:5/cb'), false);
  });

  it('port 0 is no port: refused on a redirect, even an exact one, and at registration', () => {
    assert.equal(validRedirectUri('http://127.0.0.1:0/cb'), false);
    assert.equal(validRedirectUri('https://client.example.com:0/cb'), false);
    assert.equal(registry.redirectAllowed(client(CALLBACK), 'http://127.0.0.1:0/kl/window/callback'), false);
    assert.equal(registry.redirectAllowed(client('http://127.0.0.1:0/cb'), 'http://127.0.0.1:0/cb'), false);
  });
});

describe('the window as an OAuth client', () => {
  it('a client registered without a port redeems its code on the port it listens on', async () => {
    const h = await start();
    const clientId = await registerLoopback(h);
    const r = await connectWindow(h, { clientId });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.location.origin, 'http://127.0.0.1:51234');
    assert.equal(r.location.pathname, '/kl/window/callback');
    assert.ok(r.tokens.access_token.startsWith('kla_'));
  });

  it('a code issued for one port redeems only on that port', async () => {
    const h = await start();
    const clientId = await registerLoopback(h);
    const redirectUri = 'http://127.0.0.1:51234/kl/window/callback';
    const { verifier, challenge } = pkce();
    const consent = await request(h.base, { path: authorizePath(clientId, redirectUri, { code_challenge: challenge, resource: WINDOW_RESOURCE, scope: 'window:attach' }) });
    const { userCode, grantId } = parseConsent(consent.text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    const signed = h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: windowGrant() });
    assert.equal((await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, signed)).status, 200);
    const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) } });
    const code = new URL(wait.headers.location).searchParams.get('code');
    const redeem = (uri) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code, redirect_uri: uri, client_id: clientId, code_verifier: verifier } });
    const other = await redeem('http://127.0.0.1:51235/kl/window/callback');
    assert.equal(other.status, 400);
    assert.equal(other.json.error, 'invalid_grant');
    assert.equal((await redeem(redirectUri)).status, 200);
  });

  it('window:attach;machines=web-01 is granted, and the token is for the window alone', async () => {
    const h = await start();
    const r = await connectWindow(h, { machines: ['web-01'] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.tokens.scope, 'window:attach;machines=web-01');
    const rec = h.tokens.authenticate(r.tokens.access_token, { aud: WINDOW_RESOURCE });
    assert.ok(rec);
    assert.deepEqual(rec.scopes, ['window:attach;machines=web-01']);
    assert.equal(h.tokens.authenticate(r.tokens.access_token, { aud: MCP_RESOURCE }), null);
    assert.equal(h.grants.live(r.grantId).resource, WINDOW_RESOURCE);
  });

  it('a refresh keeps the audience', async () => {
    const h = await start();
    const r = await connectWindow(h);
    const next = await request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: r.tokens.refresh_token, client_id: r.clientId } });
    assert.equal(next.status, 200);
    assert.ok(h.tokens.authenticate(next.json.access_token, { aud: WINDOW_RESOURCE }));
    assert.equal(h.tokens.authenticate(next.json.access_token, { aud: MCP_RESOURCE }), null);
  });

  it('a window token is refused by /mcp, and an MCP token by /window/v1/nodes', async () => {
    const h = await start();
    const win = await connectWindow(h);
    const mcp = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal((await mcpCall(h, mcp.tokens.access_token)).status !== 401, true, 'the MCP token is good for /mcp');
    assert.equal((await nodes(h, win.tokens.access_token)).status, 200, 'the window token is good for the list');

    const refusedMcp = await mcpCall(h, win.tokens.access_token);
    assert.equal(refusedMcp.status, 401);
    assert.equal(refusedMcp.json.error, 'invalid_token');
    const refusedList = await nodes(h, mcp.tokens.access_token);
    assert.equal(refusedList.status, 401);
    assert.equal(refusedList.json.error, 'invalid_token');
    assert.equal(refusedList.headers['www-authenticate'], `Bearer error="invalid_token", resource_metadata="${ORIGIN}${WELL_KNOWN}/window/v1"`);
  });

  it('authorize refuses a resource that is neither', async () => {
    const h = await start();
    const clientId = await registerLoopback(h);
    for (const resource of [`${ORIGIN}/window`, `${ORIGIN}/window/v1/`, `${ORIGIN}/window/v1/nodes`, `${ORIGIN}/mcp/`, 'https://evil.example.com/window/v1', '']) {
      const r = await request(h.base, { path: authorizePath(clientId, CALLBACK, { resource }) });
      assert.equal(r.status, 400, resource);
      assert.match(r.text, /resource must be/, resource);
    }
    assert.equal((await request(h.base, { path: authorizePath(clientId, CALLBACK, { resource: WINDOW_RESOURCE }) })).status, 200);
    assert.equal((await request(h.base, { path: authorizePath(clientId, CALLBACK, { resource: MCP_RESOURCE }) })).status, 200);
  });
});

describe('what each resource may ask for', () => {
  it('with no scope asked, the window resource asks for window:attach, preselected', async () => {
    const h = await start();
    const view = await phoneView(h, { resource: WINDOW_RESOURCE });
    assert.equal(view.resource, WINDOW_RESOURCE);
    assert.deepEqual(view.requested_scopes, ['window:attach']);
    // Android's one-tap Allow signs exactly these, and an approve of nothing is refused.
    assert.deepEqual(view.preselected, ['window:attach']);
    assert.equal(view.notice, WINDOW_SCOPE_TEXT);
  });

  it('the consent page and the phone both say what the grant is worth', async () => {
    assert.equal(WINDOW_SCOPE_TEXT, 'A King Louie window may attach to every node this grant covers, and each node still needs its own phone approval.');
    const h = await start();
    const clientId = await registerLoopback(h);
    const consent = await request(h.base, { path: authorizePath(clientId, CALLBACK, { resource: WINDOW_RESOURCE }) });
    assert.ok(consent.text.includes(WINDOW_SCOPE_TEXT));
  });

  it('with no scope asked, the MCP resource never asks for window:attach', async () => {
    const h = await start();
    const view = await phoneView(h, {});
    assert.equal(view.resource, MCP_RESOURCE);
    assert.deepEqual(view.requested_scopes, [...FLEET].sort());
    assert.deepEqual(view.preselected, ['fleet:read']);
    // Today's phones take exact keys: an MCP request's view does not change.
    assert.ok(!('notice' in view));
  });

  it('a scope the resource cannot use is dropped from what the phone is asked', async () => {
    const h = await start();
    const onWindow = await phoneView(h, { resource: WINDOW_RESOURCE, scope: 'fleet:run window:attach' });
    assert.deepEqual(onWindow.requested_scopes, ['window:attach']);
    const onMcp = await phoneView(h, { scope: 'fleet:read window:attach' });
    assert.deepEqual(onMcp.requested_scopes, ['fleet:read']);
  });

  it('asking only for what the resource cannot use is refused', async () => {
    const h = await start();
    const clientId = await registerLoopback(h);
    for (const extra of [{ resource: WINDOW_RESOURCE, scope: 'fleet:read' }, { resource: MCP_RESOURCE, scope: 'window:attach' }, { scope: 'window:attach' }]) {
      const r = await request(h.base, { path: authorizePath(clientId, CALLBACK, extra) });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(r.text, /Invalid scope/);
    }
  });

  it('a remote web client cannot get the window resource, whatever it calls itself', async () => {
    const h = await start();
    const uri = 'https://evil.example.com/cb';
    const clientId = (await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'King Louie window', redirect_uris: [uri], token_endpoint_auth_method: 'none' } })).json.client_id;
    assert.ok(clientId);
    const before = h.pending.size();
    const r = await request(h.base, { path: authorizePath(clientId, uri, { resource: WINDOW_RESOURCE, scope: 'window:attach' }) });
    assert.equal(r.status, 400);
    assert.match(r.text, /loopback/);
    assert.equal(parseConsent(r.text).userCode, null);
    assert.equal(h.pending.size(), before, 'no pending request was made');
    assert.equal((await request(h.base, { path: authorizePath(clientId, uri, { scope: 'fleet:read' }) })).status, 200, 'the MCP resource still takes it');
  });

  it('a resource with no scope to ask for gets no consent page', async () => {
    const h = await start({ scopesEnabled: ['window:attach'] });
    const clientId = await registerLoopback(h);
    const r = await request(h.base, { path: authorizePath(clientId, CALLBACK) });
    assert.equal(r.status, 400);
    assert.match(r.text, /Invalid scope/);
    assert.equal(h.pending.size(), 0);
  });

  it('the phone cannot sign fleet scopes into a window grant', async () => {
    const h = await start();
    const r = await connectWindow(h, { scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.decision.status, 400);
    assert.equal(r.decision.body.error, 'invalid_scope');
  });
});

describe('the metadata', () => {
  it('describes both resources, each with its own scopes', async () => {
    const h = await start();
    const mcpDoc = { resource: MCP_RESOURCE, authorization_servers: [ORIGIN], scopes_supported: [...FLEET].sort(), bearer_methods_supported: ['header'] };
    assert.deepEqual((await request(h.base, { path: WELL_KNOWN })).json, mcpDoc);
    assert.deepEqual((await request(h.base, { path: `${WELL_KNOWN}/mcp` })).json, mcpDoc);
    assert.deepEqual((await request(h.base, { path: `${WELL_KNOWN}/window/v1` })).json,
      { resource: WINDOW_RESOURCE, authorization_servers: [ORIGIN], scopes_supported: ['window:attach'], bearer_methods_supported: ['header'] });
    const as = (await request(h.base, { path: '/.well-known/oauth-authorization-server' })).json;
    assert.deepEqual(as.scopes_supported, [...WITH_WINDOW].sort());
  });

  it('windowResourceUrl follows the origin', async () => {
    const h = await start();
    assert.equal(h.oauth.windowResourceUrl, WINDOW_RESOURCE);
    h.oauth.setOrigin('https://mcp.kl.example.com:8443');
    assert.equal(h.oauth.windowResourceUrl, 'https://mcp.kl.example.com:8443/window/v1');
    assert.equal(h.oauth.resourceUrl, 'https://mcp.kl.example.com:8443/mcp');
  });

  it('scopes_enabled without window:attach advertises nothing of it', async () => {
    const h = await start({ scopesEnabled: FLEET });
    const as = await request(h.base, { path: '/.well-known/oauth-authorization-server' });
    assert.doesNotMatch(as.text, /window/);
    for (const p of [WELL_KNOWN, `${WELL_KNOWN}/mcp`]) assert.doesNotMatch((await request(h.base, { path: p })).text, /window/, p);
    assert.equal((await request(h.base, { path: `${WELL_KNOWN}/window/v1` })).status, 404);

    const clientId = await registerLoopback(h);
    const asked = await request(h.base, { path: authorizePath(clientId, CALLBACK, { resource: WINDOW_RESOURCE }) });
    assert.equal(asked.status, 400);
    assert.doesNotMatch(asked.text, /window\/v1/, 'the refusal names only the resource that exists');
    assert.match((await request(h.base, { path: authorizePath(clientId, CALLBACK, { scope: 'window:attach' }) })).text, /does not grant window:attach/);
    const view = await phoneView(h, {});
    assert.ok(!view.requested_scopes.includes('window:attach'));
  });
});

describe('off is off for a grant that already exists', () => {
  // scopes_enabled is read at start; this stands in for a restart without the scope.
  const turnOff = (h) => { h.oauth.scopesEnabled = FLEET; };

  it('the list answers 404, to the grant\'s token and to anyone else', async () => {
    const h = await start();
    const win = await connectWindow(h);
    assert.equal((await nodes(h, win.tokens.access_token)).status, 200);
    turnOff(h);
    assert.equal((await nodes(h, win.tokens.access_token)).status, 404);
    assert.equal((await nodes(h, null)).status, 404);
    assert.equal((await request(h.base, { method: 'POST', path: '/window/v1/nodes' })).status, 404);
  });

  it('a window refresh is refused, spends nothing and revokes nothing; an MCP refresh goes on', async () => {
    const h = await start();
    const win = await connectWindow(h);
    const mcp = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    turnOff(h);
    const form = { grant_type: 'refresh_token', refresh_token: win.tokens.refresh_token, client_id: win.clientId };
    const refused = await request(h.base, { method: 'POST', path: '/oauth/token', form });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'invalid_grant');
    assert.equal((await request(h.base, { method: 'POST', path: '/oauth/token', form })).status, 400, 'a second try is not reuse');
    assert.ok(h.grants.live(win.grantId), 'the grant stands');
    assert.deepEqual(h.revokedGrants, []);
    assert.equal((await request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: mcp.tokens.refresh_token, client_id: mcp.clientId } })).status, 200);

    h.oauth.scopesEnabled = WITH_WINDOW;
    assert.equal((await request(h.base, { method: 'POST', path: '/oauth/token', form })).status, 200, 'the same token works once it is on again');
  });

  it('the splice refuses the token as it refuses a stranger', async () => {
    const h = await start();
    const win = await connectWindow(h, { machines: ['web-01'] });
    const web = h.registry.byName('web-01');
    assert.equal((await dial(h, win.tokens.access_token, web)).code, 4404);
    turnOff(h);
    assert.deepEqual(await dial(h, win.tokens.access_token, web), { code: 4401, reason: 'invalid_token' });
  });
});

describe('GET /window/v1/nodes', () => {
  it('lists the nodes the grant covers, with what a window needs', async () => {
    const h = await start();
    const all = await connectWindow(h);
    const web = h.registry.byName('web-01');
    const gpu = h.registry.byName('gpu-box');
    h.registry.markOnline(web.node_id, {});
    const r = await nodes(h, all.tokens.access_token);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const byName = Object.fromEntries(r.json.nodes.map((n) => [n.node_name, n]));
    assert.deepEqual(Object.keys(r.json), ['nodes']);
    assert.deepEqual(byName['web-01'], { node_id: web.node_id, node_name: 'web-01', online: true, public_key: web.public_key });
    assert.deepEqual(byName['gpu-box'], { node_id: gpu.node_id, node_name: 'gpu-box', online: false, public_key: gpu.public_key });
  });

  it('lists only agent nodes: a window can never attach to the others', () => {
    const grant = { scopes: [{ scope: 'window:attach', machines: null }], machine_ids: {} };
    return withRoutes({
      tokens: { authenticate: () => ({ grant_id: 'g', scopes: ['window:attach'] }) },
      grants: { live: () => grant, touch: () => {}, machineMatches: () => true },
      registry: {
        list: () => [{ node_id: 'a', node_name: 'agent-1', profile: 'agent', public_key: 'k' }, { node_id: 'b', node_name: 'books', profile: 'runbook', public_key: 'k' }, { node_id: 'c', node_name: 'none', public_key: 'k' }],
        presence: () => null
      }
    }, async (base) => {
      const r = await request(base, { path: '/window/v1/nodes', headers: { authorization: 'Bearer kla_x' } });
      assert.deepEqual(r.json.nodes.map((n) => n.node_name), ['agent-1']);
    });
  });

  it('a machine limit narrows the list', async () => {
    const h = await start();
    const r = await connectWindow(h, { machines: ['web-01'] });
    assert.deepEqual((await nodes(h, r.tokens.access_token)).json.nodes.map((n) => n.node_name), ['web-01']);
  });

  it('a name the grant holds, on a node with another id now, is not listed', async () => {
    const token = { grant_id: 'g', scopes: ['window:attach;machines=web-01'] };
    const grant = { scopes: [{ scope: 'window:attach', machines: ['web-01'] }], machine_ids: { 'web-01': 'old-id' } };
    await withRoutes({
      tokens: { authenticate: () => token },
      grants: { live: () => grant, touch: () => {}, machineMatches: (g, s, name, id) => g.machine_ids[name] === id },
      registry: { list: () => [{ node_id: 'new-id', node_name: 'web-01', profile: 'agent', public_key: 'k' }], presence: () => null }
    }, async (base) => {
      const r = await request(base, { path: '/window/v1/nodes', headers: { authorization: 'Bearer kla_x' } });
      assert.deepEqual(r.json, { nodes: [] });
    });
  });

  it('no token, a malformed one, an unknown one, a second header and another method are refused', async () => {
    const h = await start();
    const win = await connectWindow(h);
    const noToken = await nodes(h, null);
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers['www-authenticate'], /resource_metadata=".*\/window\/v1"/);
    assert.equal((await nodes(h, 'kla_nope')).status, 401);
    assert.equal((await request(h.base, { path: '/window/v1/nodes', headers: { authorization: 'Basic abc' } })).status, 401);
    const twice = await request(h.base, { path: '/window/v1/nodes', headers: { authorization: [`Bearer ${win.tokens.access_token}`, 'Bearer kla_other'] } });
    assert.equal(twice.status, 400);
    const posted = await request(h.base, { method: 'POST', path: '/window/v1/nodes', headers: { authorization: `Bearer ${win.tokens.access_token}` } });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.allow, 'GET');
  });

  it('a window-resource token without the scope gets 403, and a revoked grant 401', async () => {
    const stored = { grant_id: 'g', scopes: ['fleet:read'] };
    await withRoutes({
      tokens: { authenticate: () => stored },
      grants: { live: () => ({ scopes: [] }), touch: () => {}, machineMatches: () => true },
      registry: { list: () => [], presence: () => null }
    }, async (base) => {
      const r = await request(base, { path: '/window/v1/nodes', headers: { authorization: 'Bearer kla_x' } });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, 'insufficient_scope');
      assert.match(r.headers['www-authenticate'], /error="insufficient_scope", scope="window:attach"/);
    });

    const h = await start();
    const win = await connectWindow(h);
    await request(h.base, { method: 'POST', path: '/oauth/revoke', form: { token: win.tokens.refresh_token, client_id: win.clientId } });
    assert.equal((await nodes(h, win.tokens.access_token)).status, 401);
  });

  it('a use of the list counts as a use of the grant', async () => {
    let t = Date.now();
    const h = await start({ now: () => t });
    const win = await connectWindow(h);
    t += 60000;
    await nodes(h, win.tokens.access_token);
    assert.equal(h.grants.live(win.grantId).last_used_at, new Date(t).toISOString());
  });
});

describe('the scope', () => {
  it('registers once with the words the phone shows, and is one of the front door\'s extensions', () => {
    const scopes = createFleetScopeRegistry();
    registerWindowScope(scopes);
    assert.equal(WINDOW_SCOPE, 'window:attach');
    assert.deepEqual({ ...scopes.get(WINDOW_SCOPE) }, { name: 'window:attach', tools: ['attach_window'], description: WINDOW_SCOPE_TEXT, requires: null });
    assert.equal(scopes.requiredScopeFor('attach_window'), 'window:attach');

    const extended = createFleetScopeRegistry();
    const router = { registerTool: () => {} };
    for (const extension of TOOL_EXTENSIONS) extension({ scopeRegistry: extended, router });
    assert.ok(extended.has('window:attach'));
    assert.deepEqual(extended.supported(FLEET), [...FLEET].sort(), 'registered is not advertised');
  });
});

describe('a real token at the splice (Task 7 and Task 8 agree)', () => {
  it('takes a window token, on the machines it covers, and no MCP token', async () => {
    const h = await start();
    const win = await connectWindow(h, { machines: ['web-01'] });
    const mcp = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const web = h.registry.byName('web-01');
    const gpu = h.registry.byName('gpu-box');
    assert.deepEqual(await dial(h, win.tokens.access_token, web), { code: 4404, reason: 'node_offline' });
    assert.deepEqual(await dial(h, win.tokens.access_token, gpu), { code: 4403, reason: 'unknown_machine' });
    assert.deepEqual(await dial(h, mcp.tokens.access_token, web), { code: 4401, reason: 'invalid_token' });
  });
});
