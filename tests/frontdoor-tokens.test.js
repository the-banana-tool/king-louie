// tests/frontdoor-tokens.test.js — fleet stage 4 §3.4 (tokens).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { TokenStore } = require('../src/frontdoor/oauth/tokens');
const { AuthCodes } = require('../src/frontdoor/oauth/grants');
const { OAuthServer } = require('../src/frontdoor/oauth/server');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { ClientRegistry } = require('../src/frontdoor/oauth/clients');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { request, pkce } = require('./helpers/oauth-test-client');

const temps = [];
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tokens-')); temps.push(d); return d; };
const AUD = 'https://mcp.kl.example.com/mcp';

function store(now, file = path.join(tmp(), 'tokens.json')) {
  return new TokenStore({ file, now: () => now.t });
}

describe('TokenStore', () => {
  it('issues opaque kla_/klr_ tokens, stores only hashes, and checks exp and aud', () => {
    const now = { t: 0 };
    const s = store(now);
    const pair = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    assert.match(pair.access_token, /^kla_[A-Za-z0-9_-]{43}$/);
    assert.match(pair.refresh_token, /^klr_[A-Za-z0-9_-]{43}$/);
    assert.equal(pair.expires_in, 3600);
    const text = fs.readFileSync(s.file, 'utf8');
    assert.ok(!text.includes(pair.access_token.slice(4)) && !text.includes(pair.refresh_token.slice(4)), 'never the token itself');
    assert.equal(s.authenticate(pair.access_token, { aud: AUD }).grant_id, 'gr_1');
    assert.equal(s.authenticate(pair.access_token, { aud: 'https://other.example.com/mcp' }), null);
    now.t += 3600001;
    assert.equal(s.authenticate(pair.access_token, { aud: AUD }), null);
  });

  it('rotates on every use; a rotated token presented again after the grace window is reuse', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read', 'fleet:run;machines=web-01'], aud: AUD });
    const { pair: second } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    assert.notEqual(second.refresh_token, first.refresh_token);
    now.t += 31000;
    assert.deepEqual(s.refresh({ token: first.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' });
  });

  it('grace once: within 30 s the old token yields a new pair and the unused successor is superseded; a second time is reuse', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const { pair: successor } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    now.t += 5000;
    const { pair: retry } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    assert.ok(retry.access_token);
    assert.equal(s.authenticate(successor.access_token, { aud: AUD }), null, "the superseded successor's access token is dead");
    assert.deepEqual(s.refresh({ token: successor.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' }, 'presenting the superseded successor is reuse');
  });

  it('no grace once the successor has been used', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const { pair: successor } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    s.refresh({ token: successor.refresh_token, clientId: 'dcr_1' });
    assert.deepEqual(s.refresh({ token: first.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' });
  });

  it('another client, an idle-expired token, and scope widening are refused; narrowing works', () => {
    const now = { t: 0 };
    const s = store(now);
    const a = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read', 'fleet:run;machines=web-01'], aud: AUD });
    assert.throws(() => s.refresh({ token: a.refresh_token, clientId: 'dcr_2' }), (err) => err.error === 'invalid_grant');
    assert.throws(() => s.refresh({ token: a.refresh_token, clientId: 'dcr_1', scope: 'fleet:delegate' }), (err) => err.error === 'invalid_scope');
    const { pair } = s.refresh({ token: a.refresh_token, clientId: 'dcr_1', scope: 'fleet:run' });
    assert.equal(pair.scope, 'fleet:run;machines=web-01');
    now.t += 30 * 86400000 + 1;
    assert.throws(() => s.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }), (err) => err.error === 'invalid_grant');
  });

  it('tokens survive a restart (Review Focus 3)', () => {
    const now = { t: 0 };
    const file = path.join(tmp(), 'tokens.json');
    const a = store(now, file);
    const pair = a.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const b = store(now, file);
    assert.equal(b.authenticate(pair.access_token, { aud: AUD }).grant_id, 'gr_1');
    assert.ok(b.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }).pair);
  });
});

describe('the token and revoke endpoints', () => {
  async function server() {
    const dir = tmp();
    const now = { t: Date.now() };
    const codes = new AuthCodes({ now: () => now.t });
    const tokens = new TokenStore({ file: path.join(dir, 'tokens.json'), now: () => now.t });
    const live = new Map([['gr_1', { grant_id: 'gr_1', client_id: 'dcr_1', resource: AUD, scopes: [{ scope: 'fleet:read', machines: null }] }]]);
    const revoked = [];
    const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
    const grants = {
      live: (id) => live.get(id) || null,
      revoke: (id, reason) => { revoked.push([id, reason]); return live.delete(id); },
      scopeStrings: (g) => g.scopes.map((s) => s.scope),
      touch: () => {}
    };
    const oauth = new OAuthServer({
      domain: 'kl.example.com', clients: new ClientRegistry({ file: path.join(dir, 'clients.json') }), pending: new PendingAuthorizations(),
      scopeRegistry: createFleetScopeRegistry(), scopesEnabled: ['fleet:read'], tokens, codes, grants, alerts
    });
    const s = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    const { verifier, challenge } = pkce();
    const code = codes.issue({ grantId: 'gr_1', clientId: 'dcr_1', redirectUri: 'https://client.example.com/cb', codeChallenge: challenge, resource: AUD });
    return { base: `http://127.0.0.1:${s.address().port}`, code, verifier, tokens, revoked, alerts, now };
  }

  const exchange = (t, extra = {}) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: t.code, redirect_uri: 'https://client.example.com/cb', client_id: 'dcr_1', code_verifier: t.verifier, ...extra } });

  it('exchanges a code with the right verifier, with no-store', async () => {
    const t = await server();
    const res = await exchange(t);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.token_type, 'Bearer');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(t.tokens.authenticate(res.json.access_token, { aud: AUD }).grant_id, 'gr_1');
  });

  it('refresh reuse through the endpoint revokes the grant and raises refresh_reuse', async () => {
    const t = await server();
    const first = (await exchange(t)).json;
    const refresh = (token) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: token, client_id: 'dcr_1' } });
    assert.equal((await refresh(first.refresh_token)).status, 200);
    t.now.t += 31000;
    const reused = await refresh(first.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.json.error, 'invalid_grant');
    assert.deepEqual(t.revoked, [['gr_1', 'refresh_reuse']]);
    assert.equal(t.alerts.raised[0][0], 'refresh_reuse');
  });

  it('revoking a refresh token revokes its grant; revoke always answers 200', async () => {
    const t = await server();
    const first = (await exchange(t)).json;
    const r = await request(t.base, { method: 'POST', path: '/oauth/revoke', form: { token: first.refresh_token } });
    assert.equal(r.status, 200);
    assert.deepEqual(t.revoked, [['gr_1', 'client_revoked']]);
    assert.equal(t.tokens.authenticate(first.access_token, { aud: AUD }), null);
    assert.equal((await request(t.base, { method: 'POST', path: '/oauth/revoke', form: { token: 'kla_nothing' } })).status, 200);
  });

  it('refuses an unknown grant_type', async () => {
    const t = await server();
    const r = await request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'client_credentials' } });
    assert.equal(r.json.error, 'unsupported_grant_type');
  });
});

// Binding carries (T22, T23): redemption order, parseForm, revocation paths,
// the tokens file, and the machine limits scopes carry.
const { EventEmitter } = require('events');
const { parseForm } = require('../src/frontdoor/http-util');

describe('carries: code redemption, forms, revocation, the tokens file', () => {
  const REDIRECT = 'https://client.example.com/cb';

  async function carryServer({ scopes = [{ scope: 'fleet:read', machines: null }] } = {}) {
    const dir = tmp();
    const now = { t: Date.now() };
    const codes = new AuthCodes({ now: () => now.t });
    const tokens = new TokenStore({ file: path.join(dir, 'tokens.json'), now: () => now.t });
    const live = new Map([['gr_1', { grant_id: 'gr_1', client_id: 'dcr_1', resource: AUD, scopes }]]);
    const revoked = [];
    const audit = [];
    const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
    const grants = Object.assign(new EventEmitter(), {
      live: (id) => live.get(id) || null,
      revoke(id, reason) {
        revoked.push([id, reason]);
        const had = live.delete(id);
        if (had) this.emit('revoked', id);
        return had;
      },
      scopeStrings: (g) => g.scopes.map((s) => (s.machines ? `${s.scope};machines=${s.machines.join(',')}` : s.scope)),
      touch: () => {}
    });
    const oauth = new OAuthServer({
      domain: 'kl.example.com', clients: new ClientRegistry({ file: path.join(dir, 'clients.json') }), pending: new PendingAuthorizations(),
      scopeRegistry: createFleetScopeRegistry(), scopesEnabled: ['fleet:read'], tokens, codes, grants, alerts,
      auditLedger: { append: async (e) => { audit.push(e); return e; } }
    });
    const s = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    const { verifier, challenge } = pkce();
    const code = codes.issue({ grantId: 'gr_1', clientId: 'dcr_1', redirectUri: REDIRECT, codeChallenge: challenge, resource: AUD });
    return { base: `http://127.0.0.1:${s.address().port}`, code, verifier, tokens, grants, live, revoked, audit, alerts, now };
  }

  const redeem = (t, extra = {}) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: t.code, redirect_uri: REDIRECT, client_id: 'dcr_1', code_verifier: t.verifier, ...extra } });
  const wrongVerifier = () => crypto.randomBytes(32).toString('base64url');
  const formRequest = (t, pathname, raw) => request(t.base, { method: 'POST', path: pathname, raw, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  it('a wrong verifier or a mismatched redirect neither consumes the code nor revokes the grant', async () => {
    const t = await carryServer();
    const bad = await redeem(t, { code_verifier: wrongVerifier() });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_grant');
    assert.equal((await redeem(t, { redirect_uri: `${REDIRECT}/other` })).json.error, 'invalid_grant');
    // Two failures so far; the third would burn the code.
    const ok = await redeem(t);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(t.revoked, []);
  });

  it('client_id and resource are bound exactly', async () => {
    const t = await carryServer();
    assert.equal((await redeem(t, { client_id: 'dcr_2' })).json.error, 'invalid_grant');
    assert.equal((await redeem(t, { resource: `${AUD}/` })).json.error, 'invalid_grant');
    const ok = await redeem(t, { resource: AUD });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(t.revoked, []);
  });

  it('three failed attempts burn the code without revoking the grant', async () => {
    const t = await carryServer();
    for (let i = 0; i < 3; i += 1) assert.equal((await redeem(t, { code_verifier: wrongVerifier() })).json.error, 'invalid_grant');
    const late = await redeem(t);
    assert.equal(late.status, 400);
    assert.equal(late.json.error, 'invalid_grant');
    assert.deepEqual(t.revoked, []);
    assert.ok(t.live.has('gr_1'));
  });

  it('only a second redemption that passes every check is reuse and revokes the grant', async () => {
    const t = await carryServer();
    const first = await redeem(t);
    assert.equal(first.status, 200);
    const stranger = await redeem(t, { code_verifier: wrongVerifier() });
    assert.equal(stranger.json.error, 'invalid_grant');
    assert.deepEqual(t.revoked, [], 'a redemption without the verifier cannot revoke the grant');
    const again = await redeem(t);
    assert.equal(again.json.error, 'invalid_grant');
    assert.deepEqual(t.revoked, [['gr_1', 'code_reuse']]);
    assert.equal(t.tokens.authenticate(first.json.access_token, { aud: AUD }), null, 'the tokens the code issued are dead');
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.grant.revoked' && e.data.reason === 'code_reuse'));
  });

  it('a parameter given twice is invalid_request and touches nothing', async () => {
    const t = await carryServer();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: t.code, redirect_uri: REDIRECT, client_id: 'dcr_1', code_verifier: t.verifier });
    body.append('code_verifier', wrongVerifier());
    const r = await formRequest(t, '/oauth/token', body.toString());
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_request');
    assert.equal((await redeem(t)).status, 200, 'the code was not consumed');
  });

  it('parseForm returns a null-prototype object and refuses duplicate keys', () => {
    const f = parseForm(Buffer.from('__proto__=x&constructor=y&a=1'));
    assert.equal(Object.getPrototypeOf(f), null);
    assert.equal(Object.getOwnPropertyDescriptor(f, '__proto__').value, 'x');
    assert.equal(f.constructor, 'y');
    assert.equal(parseForm(Buffer.from('')).grant_type, undefined);
    assert.throws(() => parseForm(Buffer.from('a=1&b=2&a=3')), (err) => err.error === 'invalid_request' && err.status === 400);
  });

  it('refresh reuse audits frontdoor.refresh_reuse', async () => {
    const t = await carryServer();
    const first = (await redeem(t)).json;
    const refresh = (token) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: token, client_id: 'dcr_1' } });
    assert.equal((await refresh(first.refresh_token)).status, 200);
    t.now.t += 31000;
    assert.equal((await refresh(first.refresh_token)).json.error, 'invalid_grant');
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.refresh_reuse' && e.data.grant_id === 'gr_1'));
    assert.equal(t.alerts.raised[0][0], 'refresh_reuse');
  });

  it('a grant revoked by any path kills its tokens (the revoked event)', async () => {
    const t = await carryServer();
    const pair = (await redeem(t)).json;
    t.grants.revoke('gr_1', 'phone_revoked');
    assert.equal(t.tokens.find(pair.access_token), null);
    assert.equal(t.tokens.find(pair.refresh_token), null);
  });

  it('authenticate and refresh check the grant is live even if no event came', async () => {
    const t = await carryServer();
    const pair = (await redeem(t)).json;
    t.live.delete('gr_1'); // revoked behind the store's back: no event
    assert.equal(t.tokens.authenticate(pair.access_token, { aud: AUD }), null);
    assert.throws(() => t.tokens.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }), (err) => err.error === 'invalid_grant');
  });

  it('revoke answers 200 {} alike for an unknown, a repeated, an empty and an access token', async () => {
    const t = await carryServer();
    const pair = (await redeem(t)).json;
    const revoke = (form) => request(t.base, { method: 'POST', path: '/oauth/revoke', form });
    const answers = [
      await revoke({ token: 'klr_nothing' }),
      await formRequest(t, '/oauth/revoke', `token=${pair.refresh_token}&token=x`),
      await revoke({}),
      await request(t.base, { method: 'POST', path: '/oauth/revoke', raw: 'token=x', headers: { 'content-type': 'text/plain' } })
    ];
    for (const a of answers) {
      assert.equal(a.status, 200);
      assert.equal(a.text, '{}');
    }
    assert.deepEqual(t.revoked, [], 'an ambiguous request revokes nothing');
    const access = await revoke({ token: pair.access_token });
    assert.equal(access.status, 200);
    assert.equal(access.text, '{}');
    assert.equal(t.tokens.authenticate(pair.access_token, { aud: AUD }), null);
    assert.deepEqual(t.revoked, [], 'revoking an access token leaves the grant');
    assert.ok(t.tokens.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }).pair);
  });

  it('narrowing keeps machine limits bound and never widens them', () => {
    const now = { t: 0 };
    const s = store(now);
    const a = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read', 'fleet:run;machines=gpu-box,web-01'], aud: AUD });
    const refused = (token, scope) => assert.throws(() => s.refresh({ token, clientId: 'dcr_1', scope }), (err) => err.error === 'invalid_scope', scope);
    refused(a.refresh_token, 'fleet:run;machines=db-01');
    refused(a.refresh_token, 'fleet:read fleet:read');
    refused(a.refresh_token, 'fleet:run;machines=web-01,gpu-box');
    refused(a.refresh_token, 'fleet:run;machines=');
    const { pair } = s.refresh({ token: a.refresh_token, clientId: 'dcr_1', scope: 'fleet:run;machines=web-01' });
    assert.equal(pair.scope, 'fleet:run;machines=web-01');
    const { pair: again } = s.refresh({ token: pair.refresh_token, clientId: 'dcr_1' });
    assert.equal(again.scope, 'fleet:run;machines=web-01', 'a narrowed token stays narrowed');
    refused(again.refresh_token, 'fleet:run;machines=gpu-box');
    const unlimited = s.issuePair({ grantId: 'gr_2', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    assert.equal(s.refresh({ token: unlimited.refresh_token, clientId: 'dcr_1', scope: 'fleet:read;machines=web-01' }).pair.scope, 'fleet:read;machines=web-01');
  });

  it('the grace is spent once per rotation: a third presentation inside 30 s is reuse', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    now.t += 1000;
    const { pair: retry } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    now.t += 1000;
    assert.deepEqual(s.refresh({ token: first.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' });
    assert.equal(s.authenticate(retry.access_token, { aud: AUD }).grant_id, 'gr_1', 'the store itself revokes nothing; the handler does');
  });

  it('a corrupt tokens file is moved aside, never overwritten', () => {
    const dir = tmp();
    const file = path.join(dir, 'tokens.json');
    fs.writeFileSync(file, '{ not json');
    const s = new TokenStore({ file, now: () => 1234 });
    assert.equal(fs.readFileSync(path.join(dir, 'tokens.json.corrupt-1234'), 'utf8'), '{ not json');
    assert.ok(!fs.existsSync(file));
    s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1);
    fs.writeFileSync(file, JSON.stringify({ v: 1, access: [], refresh: 'x' }));
    assert.ok(new TokenStore({ file, now: () => 5678 }));
    assert.ok(fs.existsSync(path.join(dir, 'tokens.json.corrupt-5678')), 'a wrong shape is corrupt too');
  });
});
