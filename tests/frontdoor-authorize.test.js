// tests/frontdoor-authorize.test.js — fleet stage 4 §3.4 (metadata, registration, authorize, consent).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { OAuthServer } = require('../src/frontdoor/oauth/server');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { ClientRegistry } = require('../src/frontdoor/oauth/clients');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { request, pkce, parseConsent, cookieOf } = require('./helpers/oauth-test-client');

const temps = [];
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

async function start({ now = Date.now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-authz-'));
  temps.push(dir);
  const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), now });
  const pending = new PendingAuthorizations({ now });
  const oauth = new OAuthServer({
    domain: 'kl.example.com', clients, pending, scopeRegistry: createFleetScopeRegistry(),
    scopesEnabled: ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate'],
    clientDefaults: [{ host: 'client.example.com', scopes: ['fleet:read', 'fleet:run'] }], now
  });
  const server = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, oauth, clients, pending };
}

async function registered(base, extra = {}) {
  const res = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra } });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const authorizePath = (params) => `/oauth/authorize?${new URLSearchParams(params).toString()}`;

describe('metadata', () => {
  it('serves RFC 9728 and RFC 8414 documents', async () => {
    const { base } = await start();
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await request(base, { path: p });
      assert.deepEqual(r.json, { resource: 'https://mcp.kl.example.com/mcp', authorization_servers: ['https://mcp.kl.example.com'], scopes_supported: ['fleet:delegate', 'fleet:read', 'fleet:run', 'fleet:unsafe'], bearer_methods_supported: ['header'] });
    }
    const as = (await request(base, { path: '/.well-known/oauth-authorization-server' })).json;
    assert.equal(as.issuer, 'https://mcp.kl.example.com');
    assert.equal(as.token_endpoint, 'https://mcp.kl.example.com/oauth/token');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.equal(as.client_id_metadata_document_supported, true);
  });

  it('answers 421 when Host is not the mcp. name', async () => {
    const { base } = await start();
    assert.equal((await request(base, { path: '/.well-known/oauth-authorization-server', host: 'mesh.kl.example.com' })).status, 421);
  });
});

describe('authorize and the consent page', () => {
  it('creates a pending authorization, sets the cookie, and shows the code with strict headers', async () => {
    const { base } = await start();
    const client = await registered(base);
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; style-src 'self'; frame-ancestors 'none'");
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const setCookie = [].concat(res.headers['set-cookie'])[0];
    assert.match(setCookie, /^kl_authz_gr_[A-Za-z0-9_-]{9}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/oauth$/);
    const { userCode, grantId } = parseConsent(res.text);
    assert.match(userCode, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    assert.ok(grantId);
    assert.ok(res.text.includes('(self-declared)'));
    assert.ok(res.text.includes('Open King Louie on your phone'));
    assert.ok(res.text.includes('<meta http-equiv="refresh" content="3;url=/oauth/authorize/wait?id='));
    assert.ok(!/<script/i.test(res.text));
  });

  it('consent page escapes a hostile client_name (Review Focus 1)', async () => {
    const { base } = await start();
    const client = await registered(base, { client_name: '<img src=x onerror=alert(1)>‮evil "quoted"' });
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<img src=x'));
    assert.ok(res.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!res.text.includes('‮'));
    assert.ok(res.text.includes('&quot;quoted&quot;'));
  });

  it('refuses a redirect mismatch with a page and never redirects; refuses plain, a missing challenge, a foreign resource', async () => {
    const { base } = await start();
    const client = await registered(base);
    const { challenge } = pkce();
    const base_ = { response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' };
    const mismatch = await request(base, { path: authorizePath({ ...base_, redirect_uri: 'https://evil.example.com/cb' }) });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.headers.location, undefined);
    assert.match(mismatch.text, /redirect/);
    for (const params of [{ ...base_, code_challenge_method: 'plain' }, { ...base_, code_challenge: undefined }, { ...base_, resource: 'https://other.example.com/mcp' }, { ...base_, scope: 'fleet:read admin:all' }]) {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
      const r = await request(base, { path: authorizePath(clean) });
      assert.equal(r.status, 400, JSON.stringify(clean));
      assert.equal(r.headers.location, undefined);
    }
    const ok = await request(base, { path: authorizePath(base_) });
    assert.equal(ok.status, 200, 'state is optional');
  });

  it('the wait page needs the cookie; an unknown or expired request says to start again, without refresh (Review Focus 3)', async () => {
    let now = 0;
    const { base } = await start({ now: () => now });
    const client = await registered(base);
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    const { grantId } = parseConsent(res.text);
    const noCookie = await request(base, { path: `/oauth/authorize/wait?id=${grantId}` });
    assert.equal(noCookie.status, 403);
    const waiting = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(waiting.status, 200);
    assert.ok(waiting.text.includes('http-equiv="refresh"'));
    now += 600001;
    const expired = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(expired.status, 410);
    assert.ok(!expired.text.includes('http-equiv="refresh"'));
    assert.match(expired.text, /start again/i);
  });
});

describe('PendingAuthorizations caps (R23)', () => {
  const client = { client_id: 'dcr_x', client_name: 'Example Client', kind: 'dcr', redirect_uris: ['https://client.example.com/cb'] };
  const make = (p, { ip = '203.0.113.1', host = 'client.example.com' } = {}) => p.create({ client, redirectUri: 'https://client.example.com/cb', codeChallenge: 'c'.repeat(43), resource: 'https://mcp.kl.example.com/mcp', requestedScopes: ['fleet:read'], preselected: ['fleet:read'], state: null, ip, clientHost: host });

  it('3 new per IP per 10 minutes', () => {
    let now = 0;
    const p = new PendingAuthorizations({ now: () => now });
    for (let i = 0; i < 3; i += 1) make(p, { host: `h${i}.example.com` });
    assert.throws(() => make(p, { host: 'h3.example.com' }), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
    now += 600001;
    make(p, { host: 'h4.example.com' });
  });

  it('1 per client host: a newer one replaces an older unclaimed one, never a claimed one', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const first = make(p).pending;
    const second = make(p, { ip: '203.0.113.2' }).pending;
    assert.equal(p.get(first.grant_id), null);
    p.claim(second.grant_id, 'd-3vmwrihhdbnit4oi');
    const third = make(p, { ip: '203.0.113.3' }).pending;
    assert.ok(p.get(second.grant_id), 'a claimed request is never replaced');
    assert.ok(p.get(third.grant_id));
  });

  it('50 overall: the oldest unclaimed goes first; claimed ones survive a flood of 60', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const claimed = make(p, { host: 'owner.example.com' }).pending;
    p.claim(claimed.grant_id, 'd-3vmwrihhdbnit4oi');
    for (let i = 0; i < 60; i += 1) make(p, { ip: `198.51.100.${i}`, host: `flood${i}.example.com` });
    assert.ok(p.get(claimed.grant_id));
    assert.equal(p.size(), 50);
  });

  it('claim belongs to the first device; user codes are unique among live requests', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const a = make(p).pending;
    assert.ok(p.claim(a.grant_id, 'd-3vmwrihhdbnit4oi'));
    assert.ok(p.claim(a.grant_id, 'd-3vmwrihhdbnit4oi'), 'the same device again is fine');
    assert.equal(p.claim(a.grant_id, 'd-6xdlbxglhnvfa3lw'), null);
    assert.equal(p.byUserCode(a.user_code).grant_id, a.grant_id);
  });
});

// \u2500\u2500 Hardening (Task 22 carries and web-security rules) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const { printable, escapeHtml, readBody, requestHost, clientIp } = require('../src/frontdoor/http-util');
const { CONSENT_HEADERS } = require('../src/frontdoor/oauth/pages');

const approvedPath = (client, challenge, extra = {}) => authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256', ...extra });

describe('http-util', () => {
  it('printable drops C0, C1, bidi, zero-width and every other format character', () => {
    const hostile = 'a\u0000b\u001fc\u007fd\u0085e\u009ff\u202eg\u2066h\u200bi\u200cj\u200dk\u2060l\ufeffm\u00adn\u061co\u200ep\u2028q\u2029r';
    assert.equal(printable(hostile), 'abcdefghijklmnopqr');
    assert.equal(printable(undefined), '');
    assert.equal(printable('Ünïcödé ✓ 日本'), 'Ünïcödé ✓ 日本');
  });

  it('escapeHtml escapes the five HTML characters after printable', () => {
    assert.equal(escapeHtml('<a href="x" title=\'y\'>&\u202e</a>'), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('requestHost lower-cases and drops the port; clientIp ignores X-Forwarded-For', () => {
    assert.equal(requestHost({ headers: { host: 'MCP.KL.Example.com:443' } }), 'mcp.kl.example.com');
    assert.equal(requestHost({ headers: {} }), '');
    assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '203.0.113.5' } }), '203.0.113.5');
  });

  it('readBody refuses a declared or streamed body over the limit (413) and resolves one within it', async () => {
    const got = [];
    const server = http.createServer(async (req, res) => {
      try {
        const body = await readBody(req, 16);
        got.push(body.toString());
        res.writeHead(200); res.end();
      } catch (err) {
        got.push(err.status);
        res.writeHead(err.status || 500, { connection: 'close' }); res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const port = server.address().port;
    const send = (chunks, headers) => new Promise((resolve) => {
      const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/', headers, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve('reset'));
      for (const c of chunks) req.write(c);
      req.end();
    });
    assert.equal(await send(['0123456789'], { 'content-length': '10' }), 200);
    assert.equal(await send(['x'.repeat(17)], { 'content-length': '17' }), 413);
    // Chunked, no content-length: the limit applies while streaming.
    const streamed = await send(['0123456789', '0123456789'], { 'transfer-encoding': 'chunked' });
    assert.ok(streamed === 413 || streamed === 'reset', String(streamed));
    assert.deepEqual(got, ['0123456789', 413, 413]);
  });
});

describe('the OAuth server (hardening)', () => {
  it('answers 421 for any Host other than the routed mcp. name, and 413 over 64 KiB', async () => {
    const { base } = await start();
    for (const host of ['kl.example.com', 'mcp.kl.example.com.evil.example.com', 'evil.example.com', 'mcp.kl.example.com.']) {
      assert.equal((await request(base, { path: '/.well-known/oauth-authorization-server', host })).status, 421, host);
    }
    assert.equal((await request(base, { path: '/.well-known/oauth-authorization-server', host: 'MCP.kl.example.com:443' })).status, 200);
    const big = await request(base, { method: 'POST', path: '/oauth/register', raw: 'x'.repeat(65537), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
  });

  it('consent pages also send X-Frame-Options DENY and nosniff; the stylesheet is nosniff', async () => {
    assert.equal(CONSENT_HEADERS['x-frame-options'], 'DENY');
    const { base } = await start();
    const client = await registered(base);
    const res = await request(base, { path: approvedPath(client, pkce().challenge) });
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    const css = await request(base, { path: '/oauth/consent.css' });
    assert.equal(css.status, 200);
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
  });

  it('a client_name with U+202E and zero-width characters shows without them; one made only of them shows the client_id', async () => {
    const { base } = await start();
    const client = await registered(base, { client_name: 'Exa\u200bmple\u200d \u202eClient\u2066\ufeff' });
    const res = await request(base, { path: approvedPath(client, pkce().challenge) });
    assert.ok(res.text.includes('Example Client <span class="muted">(self-declared)</span>'));
    for (const ch of ['\u200b', '\u200d', '\u202e', '\u2066', '\ufeff']) assert.ok(!res.text.includes(ch), `U+${ch.codePointAt(0).toString(16)}`);
    const { base: base2 } = await start();
    const blank = await registered(base2, { client_name: '\u200b\u202e\u200d' });
    const r2 = await request(base2, { path: approvedPath(blank, pkce().challenge) });
    assert.ok(r2.text.includes(`${blank.client_id} <span class="muted">(self-declared)</span>`));
  });

  it('refuses repeated parameters and an overlong state with a page, never a redirect', async () => {
    const { base } = await start();
    const client = await registered(base);
    const { challenge } = pkce();
    const twice = `${approvedPath(client, challenge)}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`;
    const r = await request(base, { path: twice });
    assert.equal(r.status, 400);
    assert.equal(r.headers.location, undefined);
    assert.match(r.text, /more than once/);
    const long = await request(base, { path: approvedPath(client, challenge, { state: 's'.repeat(513) }) });
    assert.equal(long.status, 400);
    assert.equal(long.headers.location, undefined);
    assert.equal((await request(base, { path: approvedPath(client, challenge, { state: 's'.repeat(512) }) })).status, 200);
  });

  it('a redirect refusal says the address must be in canonical URL form', async () => {
    const { base } = await start();
    const client = await registered(base);
    const r = await request(base, { path: approvedPath(client, pkce().challenge, { redirect_uri: 'https://client.example.com/cb/other' }) });
    assert.equal(r.status, 400);
    assert.match(r.text, /canonical URL form/);
    assert.match(r.text, /userinfo/);
    const reg = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://user@client.example.com/cb'] } });
    assert.equal(reg.status, 400);
    assert.match(reg.json.error_description, /canonical URL form/);
  });

  it('the wait page returns to the client with the code, the exact state and iss once approved, then forgets the request', async () => {
    const { base, pending } = await start();
    const client = await registered(base);
    const state = 'a b&c=d/é+%20"<x>';
    const res = await request(base, { path: approvedPath(client, pkce().challenge, { state }) });
    const { grantId } = parseConsent(res.text);
    pending.settle(grantId, { status: 'approved', code: 'the-code' });
    const done = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(done.status, 302);
    const loc = new URL(done.headers.location);
    assert.equal(`${loc.origin}${loc.pathname}`, 'https://client.example.com/cb');
    assert.equal(loc.searchParams.get('code'), 'the-code');
    assert.equal(loc.searchParams.get('state'), state);
    assert.equal(loc.searchParams.get('iss'), 'https://mcp.kl.example.com');
    assert.equal((await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } })).status, 410);
  });

  it('a denied request returns access_denied without a code; a wrong cookie is refused', async () => {
    const { base, pending } = await start();
    const client = await registered(base);
    const res = await request(base, { path: approvedPath(client, pkce().challenge) });
    const { grantId } = parseConsent(res.text);
    assert.equal((await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: `${cookieOf(res).split('=')[0]}=${'A'.repeat(43)}` } })).status, 403);
    pending.settle(grantId, { status: 'denied' });
    const done = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    const loc = new URL(done.headers.location);
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('code'), null);
    assert.equal(loc.searchParams.get('state'), null);
  });

  it('counts a CIMD fetch against the per-IP limit before fetching, and caches a failed fetch for 60 s', async () => {
    let now = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-authz-'));
    temps.push(dir);
    let fetches = 0;
    const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), now: () => now, fetchMetadata: async () => { fetches += 1; throw Object.assign(new Error('client metadata: unreachable'), { error: 'invalid_client' }); } });
    const pending = new PendingAuthorizations({ now: () => now });
    const oauth = new OAuthServer({ domain: 'kl.example.com', clients, pending, scopeRegistry: createFleetScopeRegistry(), scopesEnabled: ['fleet:read'], now: () => now });
    const server = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const { challenge } = pkce();
    const cimd = (i) => authorizePath({ response_type: 'code', client_id: `https://client.example.com/c${i}.json`, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal((await request(base, { path: cimd(0) })).status, 400);
    assert.equal((await request(base, { path: cimd(0) })).status, 400, 'the cached failure');
    assert.equal(fetches, 1, 'a failed fetch is not retried within 60 s');
    assert.equal((await request(base, { path: cimd(1) })).status, 400);
    assert.equal((await request(base, { path: cimd(2) })).status, 400);
    assert.equal(fetches, 3);
    const limited = await request(base, { path: cimd(3) });
    assert.equal(limited.status, 429);
    assert.equal(fetches, 3, 'no fetch once the address is at its limit');
    now += 600001;
    assert.equal((await request(base, { path: cimd(0) })).status, 400);
    assert.equal(fetches, 4, 'the failure cache and the per-IP window both expired');
  });
});

describe('PendingAuthorizations (hardening)', () => {
  const client = { client_id: 'dcr_x', client_name: 'Example Client', kind: 'dcr', redirect_uris: ['https://client.example.com/cb'] };
  const make = (p, { ip = '203.0.113.1', host = 'client.example.com' } = {}) => p.create({ client, redirectUri: 'https://client.example.com/cb', codeChallenge: 'c'.repeat(43), resource: 'https://mcp.kl.example.com/mcp', requestedScopes: ['fleet:read'], preselected: ['fleet:read'], state: null, ip, clientHost: host });

  it('counts an IPv6 caller by its /64', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    for (let i = 1; i <= 3; i += 1) make(p, { ip: `2001:db8:1:2::${i}`, host: `h${i}.example.com` });
    assert.throws(() => make(p, { ip: '2001:db8:1:2::99', host: 'h9.example.com' }), (err) => err.status === 429);
    make(p, { ip: '2001:db8:1:3::1', host: 'h10.example.com' });
  });

  it('checkCookie is bound to its request; an expired request is gone from byUserCode and claim', () => {
    let now = 0;
    const p = new PendingAuthorizations({ now: () => now });
    const a = make(p);
    const b = make(p, { host: 'other.example.com' });
    assert.equal(p.checkCookie(a.pending.grant_id, a.cookie), true);
    assert.equal(p.checkCookie(a.pending.grant_id, b.cookie), false);
    assert.equal(p.checkCookie(a.pending.grant_id, undefined), false);
    assert.equal(p.byUserCode('ZZZZZZ'), null);
    now += 600001;
    assert.equal(p.byUserCode(a.pending.user_code), null);
    assert.equal(p.claim(a.pending.grant_id, 'd-3vmwrihhdbnit4oi'), null);
  });

  it('a settled request can no longer be claimed or found by its code', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const a = make(p).pending;
    p.settle(a.grant_id, { status: 'denied' });
    assert.equal(p.byUserCode(a.user_code), null);
    assert.equal(p.claim(a.grant_id, 'd-3vmwrihhdbnit4oi'), null);
  });
});

// ── Review fix round 1 ─────────────────────────────────────────────────────
const { messagePage } = require('../src/frontdoor/oauth/pages');
const { shownClientError } = require('../src/frontdoor/oauth/server');

const assertConsentHeaders = (res, what) => {
  for (const [k, v] of Object.entries(CONSENT_HEADERS)) assert.equal(res.headers[k], v, `${what}: ${k}`);
};

describe('authorize (review fix round 1)', () => {
  it('redirect_uri is matched exactly: no prefix, path, case, port, encoding or query variant is accepted', async () => {
    const { base } = await start();
    const client = await registered(base, { redirect_uris: ['https://client.example.com/cb', 'https://client.example.com/q?x=1'] });
    const { challenge } = pkce();
    const variants = [
      'https://client.example.com/cb?next=https://evil.example.com',
      'https://client.example.com/cb/',
      'https://client.example.com/cb?',
      'https://client.example.com/%63b',
      'https://CLIENT.example.com/cb',
      'https://client.example.com:443/cb',
      'https://client.example.com/q?x=1&y=2'
    ];
    for (const redirect of variants) {
      const r = await request(base, { path: approvedPath(client, challenge, { redirect_uri: redirect }) });
      assert.equal(r.status, 400, redirect);
      assert.equal(r.headers.location, undefined, redirect);
      assertConsentHeaders(r, redirect);
    }
    assert.equal((await request(base, { path: approvedPath(client, challenge, { redirect_uri: 'https://client.example.com/q?x=1' }) })).status, 200);
  });

  it('a registered redirect_uri that is not valid (a tampered clients file) is still refused', async () => {
    const { base, clients } = await start();
    const client = await registered(base);
    clients.clients.get(client.client_id).redirect_uris.push('https://client.example.com/cb#frag', 'https://CLIENT.example.com/cb');
    for (const redirect of ['https://client.example.com/cb#frag', 'https://CLIENT.example.com/cb']) {
      const r = await request(base, { path: approvedPath(client, pkce().challenge, { redirect_uri: redirect }) });
      assert.equal(r.status, 400, redirect);
      assert.equal(r.headers.location, undefined, redirect);
    }
  });

  it('code_challenge is 43-128 base64url characters and response_type must be code', async () => {
    const { base } = await start();
    const client = await registered(base);
    const bad = [
      { code_challenge: 'a'.repeat(42) },
      { code_challenge: 'a'.repeat(129) },
      { code_challenge: `${'a'.repeat(42)}+` },
      { code_challenge: `${'a'.repeat(42)}=` },
      { response_type: 'token' }
    ];
    for (const extra of bad) {
      const r = await request(base, { path: approvedPath(client, 'a'.repeat(43), extra) });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.headers.location, undefined);
    }
    assert.equal((await request(base, { path: approvedPath(client, 'a'.repeat(128)) })).status, 200);
  });

  it('a hostile scope is never repeated on the refusal page, which carries the consent headers', async () => {
    const { base } = await start();
    const client = await registered(base);
    const r = await request(base, { path: approvedPath(client, pkce().challenge, { scope: 'fleet:read <meta http-equiv=refresh content="0;url=https://evil.example.com">' }) });
    assert.equal(r.status, 400);
    assertConsentHeaders(r, 'scope refusal');
    assert.ok(!r.text.includes('<meta http-equiv=refresh'));
    assert.ok(!r.text.includes('evil.example.com'));
    assert.match(r.text, /An unknown scope was requested/);
    const named = await request(base, { path: approvedPath(client, pkce().challenge, { scope: 'fleet:read admin:all' }) });
    assert.match(named.text, /does not grant admin:all/);
    const many = Array.from({ length: 10 }, (_, i) => `admin:scope${i}`).join(' ');
    const long = await request(base, { path: approvedPath(client, pkce().challenge, { scope: many }) });
    assert.match(long.text, /An unknown scope was requested/, 'over 64 characters of names is not repeated');
  });

  it('a repeated parameter is named only when it is a known authorize parameter', async () => {
    const { base } = await start();
    const client = await registered(base);
    const known = await request(base, { path: `${approvedPath(client, pkce().challenge)}&state=a&state=b` });
    assert.match(known.text, /The parameter state was given more than once/);
    const hostile = await request(base, { path: `${approvedPath(client, pkce().challenge)}&call-support-now=1&call-support-now=2` });
    assert.equal(hostile.status, 400);
    assert.ok(!hostile.text.includes('call-support-now'));
    assert.match(hostile.text, /A parameter was given more than once/);
  });

  it('client metadata errors carrying client-chosen text are shown generically', () => {
    assert.equal(shownClientError('client metadata: the metadata has a forbidden key (Call +1 555 0100 now)'), 'client metadata: the metadata has a forbidden key');
    assert.equal(shownClientError('client metadata: cannot resolve urgent-call-support.example.com: ENOTFOUND'), 'client metadata: its host has no public address');
    assert.equal(shownClientError('client metadata: some-host.example.com resolves to an address that is not public'), 'client metadata: its host has no public address');
    assert.equal(shownClientError('client metadata: getaddrinfo EAI_AGAIN anything'), 'client metadata: the metadata document could not be used');
    assert.equal(shownClientError('client metadata: the metadata URL answered 404'), 'client metadata: the metadata URL answered 404');
    assert.equal(shownClientError('client metadata: the metadata is over 64 KiB'), 'client metadata: the metadata is over 64 KiB');
  });

  it('a CIMD refusal with a hostile metadata key shows no client text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-authz-'));
    temps.push(dir);
    const { OAuthError } = require('../src/frontdoor/oauth/errors');
    const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), fetchMetadata: async () => { throw new OAuthError('invalid_client', 'client metadata: the metadata has a forbidden key (<b>Call 555-0100</b>)'); } });
    const oauth = new OAuthServer({ domain: 'kl.example.com', clients, pending: new PendingAuthorizations(), scopeRegistry: createFleetScopeRegistry(), scopesEnabled: ['fleet:read'] });
    const server = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const r = await request(`http://127.0.0.1:${server.address().port}`, { path: authorizePath({ response_type: 'code', client_id: 'https://client.example.com/c.json', redirect_uri: 'https://client.example.com/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' }) });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes('555-0100'));
    assert.match(r.text, /forbidden key/);
  });

  it('messagePage escapes its title and message', () => {
    const html = messagePage({ title: '<b>t</b>', message: '<meta http-equiv=refresh content="0;url=https://evil.example.com">' });
    assert.ok(html.includes('&lt;meta http-equiv=refresh content=&quot;0;url=https://evil.example.com&quot;&gt;'));
    assert.ok(html.includes('&lt;b&gt;t&lt;/b&gt;'));
    assert.ok(!html.includes('<meta http-equiv=refresh'));
  });

  it('the wait page sends the consent headers on 200 and on the 302', async () => {
    const { base, pending } = await start();
    const client = await registered(base);
    const res = await request(base, { path: approvedPath(client, pkce().challenge) });
    const { grantId } = parseConsent(res.text);
    const waiting = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(waiting.status, 200);
    assertConsentHeaders(waiting, 'wait 200');
    pending.settle(grantId, { status: 'approved', code: 'c' });
    const done = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(done.status, 302);
    assertConsentHeaders(done, 'wait 302');
  });

  it('two authorize flows in one browser each keep their own cookie (ruling T22-cookiename)', async () => {
    const { base } = await start();
    const one = await registered(base);
    const two = await registered(base, { redirect_uris: ['https://other.example.com/cb'] });
    const r1 = await request(base, { path: approvedPath(one, pkce().challenge) });
    const r2 = await request(base, { path: authorizePath({ response_type: 'code', client_id: two.client_id, redirect_uri: 'https://other.example.com/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' }) });
    const g1 = parseConsent(r1.text).grantId;
    const g2 = parseConsent(r2.text).grantId;
    assert.equal(cookieOf(r1).split('=')[0], `kl_authz_${g1.slice(0, 12)}`);
    assert.equal(cookieOf(r2).split('=')[0], `kl_authz_${g2.slice(0, 12)}`);
    const jar = `${cookieOf(r1)}; ${cookieOf(r2)}`;
    assert.equal((await request(base, { path: `/oauth/authorize/wait?id=${g1}`, headers: { cookie: jar } })).status, 200);
    assert.equal((await request(base, { path: `/oauth/authorize/wait?id=${g2}`, headers: { cookie: jar } })).status, 200);
    // One flow's cookie under the other's name does not open it.
    const swapped = `kl_authz_${g1.slice(0, 12)}=${cookieOf(r2).split('=')[1]}`;
    assert.equal((await request(base, { path: `/oauth/authorize/wait?id=${g1}`, headers: { cookie: swapped } })).status, 403);
  });
});
