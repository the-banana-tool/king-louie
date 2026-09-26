// tests/frontdoor-oauth.test.js — fleet stage 4 §3.4, the whole flow.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request } = require('./helpers/oauth-test-client');
const { createMcpHttpServer } = require('../src/frontdoor/http');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });
const start = async (opts) => { const h = await startFrontDoorHttp(opts); running.push(h); return h; };

describe('connecting a client', () => {
  it('DCR → authorize → typed code on the phone → wait page → token', async () => {
    const h = await start();
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.location.origin + r.location.pathname, 'https://client.example.com/cb');
    assert.equal(r.location.searchParams.get('state'), 'xyz');
    assert.equal(r.location.searchParams.get('iss'), 'https://mcp.kl.example.com');
    assert.equal(r.tokens.scope, 'fleet:read');
    const auth = h.tokens.authenticate(r.tokens.access_token, { aud: 'https://mcp.kl.example.com/mcp' });
    assert.equal(auth.grant_id, r.grantId);
    assert.ok(h.audit.some((e) => e.kind === 'frontdoor.token.issued' && e.data.kind === 'authorization_code'));
  });

  it('a client ID metadata document works the same way', async () => {
    const url = 'https://client.example.com/client.json';
    const h = await start({ fetchMetadata: async (u) => ({ client_id: u, client_name: 'Metadata Client', redirect_uris: ['https://client.example.com/cb'] }) });
    const r = await h.connect({ clientId: url, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(h.grants.live(r.grantId).client_name, 'Metadata Client');
  });

  it('client defaults only preselect; the phone decides what is granted', async () => {
    const h = await start({ clientDefaults: [{ host: 'client.example.com', scopes: ['fleet:read', 'fleet:run'] }] });
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const r = await h.connect({ clientId: reg.json.client_id, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.deepEqual(h.grants.scopeStrings(h.grants.live(r.grantId)), ['fleet:read']);
    const other = await start();
    const r2 = await other.connect({ redirectUri: 'https://other.example.com/cb', scopes: null });
    assert.deepEqual(other.grants.scopeStrings(other.grants.live(r2.grantId)), ['fleet:read'], 'no default: fleet:read only');
  });

  it('fleet:unsafe alone is invalid_scope', async () => {
    const h = await start();
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }] });
    assert.equal(r.decision.status, 400);
    assert.equal(r.decision.body.error, 'invalid_scope');
  });

  it('refresh rotates; reuse revokes the grant and raises refresh_reuse; the phone can revoke through a challenge', async () => {
    let t = Date.now();
    const h = await start({ now: () => t });
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const refresh = (tok) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: tok, client_id: r.clientId } });
    const next = await refresh(r.tokens.refresh_token);
    assert.equal(next.status, 200);
    assert.notEqual(next.json.refresh_token, r.tokens.refresh_token, 'rotated');
    t += 31000;
    const reuse = await refresh(r.tokens.refresh_token);
    assert.equal(reuse.json.error, 'invalid_grant');
    assert.equal(h.grants.live(r.grantId), null, 'reuse revokes the grant');
    assert.equal(h.tokens.authenticate(next.json.access_token, { aud: 'https://mcp.kl.example.com/mcp' }), null);
    assert.ok(h.alerts.list().some((a) => a.kind === 'refresh_reuse' && a.subject === `grant:${r.grantId}`));
    const second = await start();
    const s = await second.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const { body: { challenge } } = await second.phoneCall(second.phone, 'POST', '/v1/challenges', { purpose: 'revoke' });
    const res = await second.phoneCall(second.phone, 'POST', `/v1/clients/${s.grantId}/revoke`, second.phone.revokeClient({ frontdoorId: second.fd.nodeId, grantId: s.grantId, challenge }));
    assert.equal(res.status, 204);
    assert.equal(second.tokens.authenticate(s.tokens.access_token, { aud: 'https://mcp.kl.example.com/mcp' }), null, 'revocation takes effect at once');
  });
});

describe('the mcp. dispatcher', () => {
  it('answers only as mcp.<domain>: any other Host is 421 on every path', async () => {
    const h = await start();
    for (const p of ['/v1/grants/pending?user_code=ABC-DEF', '/oauth/register', '/.well-known/oauth-authorization-server', '/mcp', '/pair/v1', '/nope']) {
      for (const host of ['mesh.kl.example.com', 'kl.example.com', 'mcp.kl.example.com.evil.example.com', '127.0.0.1', '']) {
        const r = await request(h.base, { path: p, host });
        assert.equal(r.status, 421, `${host || '(empty)'} ${p}`);
        assert.equal(r.json.error, 'misdirected_request');
      }
    }
    // Case and a port do not change the name.
    assert.equal((await request(h.base, { path: '/.well-known/oauth-authorization-server', host: 'MCP.kl.example.com:443' })).status, 200);
  });

  it('routes /v1 to the phone API, OAuth paths to OAuth, and everything else to 404', async () => {
    const h = await start();
    // The phone API's own device auth answers (no X-KL-* headers).
    const v1 = await request(h.base, { path: '/v1/grants/pending?user_code=ABC-DEF' });
    assert.equal(v1.status, 401);
    assert.equal((await request(h.base, { path: '/.well-known/oauth-authorization-server' })).json.issuer, 'https://mcp.kl.example.com');
    for (const p of ['/mcp', '/pair/v1', '/.well-known/kl-probe/x', '/', '/v1', '/mcpx']) {
      const r = await request(h.base, { path: p });
      assert.equal(r.status, 404, p);
    }
  });

  it('/mcp goes to the MCP endpoint when one is given; pairing and probe to theirs', async () => {
    const seen = [];
    const answer = (name) => (req, res) => { seen.push([name, req.url]); res.writeHead(204); res.end(); };
    const h = await start({ mcp: { handle: answer('mcp') } });
    assert.equal((await request(h.base, { method: 'POST', path: '/mcp' })).status, 204);
    assert.equal((await request(h.base, { path: '/mcp/extra' })).status, 404);
    assert.deepEqual(seen, [['mcp', '/mcp']]);
    const { createFrontDoorHandler } = require('../src/frontdoor/http');
    const handler = createFrontDoorHandler({ mcpHost: 'mcp.kl.example.com', oauth: { handle: async () => false }, phoneApiHandler: answer('v1'), pairHandler: answer('pair'), probeHandler: answer('probe') });
    const server = require('http').createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const p of ['/pair/v1', '/pair/v1/hello', '/.well-known/kl-probe/abc', '/v1/x']) assert.equal((await request(base, { path: p })).status, 204, p);
      assert.equal((await request(base, { path: '/pair/v10' })).status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.deepEqual(seen.slice(1).map((s) => s[0]), ['pair', 'pair', 'probe', 'v1']);
  });

  it('a handler that throws answers 500 and the server keeps serving', async () => {
    const h = await start({ mcp: { handle: async () => { throw new Error('boom'); } } });
    assert.equal((await request(h.base, { method: 'POST', path: '/mcp' })).status, 500);
    assert.equal((await request(h.base, { path: '/.well-known/oauth-authorization-server' })).status, 200);
  });

  it('createMcpHttpServer sets the timeouts and header limits and never listens', () => {
    const server = createMcpHttpServer(() => {});
    assert.equal(server.requestTimeout, 30000);
    assert.equal(server.headersTimeout, 15000);
    assert.equal(server.keepAliveTimeout, 5000);
    assert.equal(server.maxHeadersCount, 100);
    assert.equal(server.maxHeaderSize, 16384);
    assert.equal(server.listening, false);
  });
});
