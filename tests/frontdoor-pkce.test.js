// tests/frontdoor-pkce.test.js — fleet stage 4 §3.4 (PKCE and the code).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request, pkce } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });

const tokenReq = (h, form) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', ...form } });

describe('PKCE and authorization codes', () => {
  it('refuses a wrong verifier, a redirect or resource mismatch; a reused code revokes the grant', async () => {
    const h = await startFrontDoorHttp({ pendingPerIp: 10 });
    running.push(h);
    // Stop before the token exchange: drive the flow by hand.
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const flow = async () => {
      const { verifier, challenge } = pkce();
      const consent = await request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
      const { userCode, grantId } = require('./helpers/oauth-test-client').parseConsent(consent.text);
      const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
      await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] }));
      const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: require('./helpers/oauth-test-client').cookieOf(consent) } });
      return { code: new URL(wait.headers.location).searchParams.get('code'), verifier, grantId };
    };
    const a = await flow();
    assert.equal((await tokenReq(h, { code: a.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: pkce().verifier })).json.error, 'invalid_grant');
    const b = await flow();
    assert.equal((await tokenReq(h, { code: b.code, redirect_uri: 'https://client.example.com/other', client_id: reg.json.client_id, code_verifier: b.verifier })).json.error, 'invalid_grant');
    const c = await flow();
    assert.equal((await tokenReq(h, { code: c.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: c.verifier, resource: 'https://other.example.com/mcp' })).json.error, 'invalid_grant');
    const d = await flow();
    const ok = await tokenReq(h, { code: d.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: d.verifier });
    assert.equal(ok.status, 200);
    const again = await tokenReq(h, { code: d.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: d.verifier });
    assert.equal(again.json.error, 'invalid_grant');
    assert.equal(h.grants.live(d.grantId), null, 'a second use of the code revokes the grant');
    assert.equal(h.tokens.authenticate(ok.json.access_token, { aud: 'https://mcp.kl.example.com/mcp' }), null);
  });

  it('a code older than 60 s is refused', async () => {
    let now = Date.now();
    const h = await startFrontDoorHttp({ now: () => now });
    running.push(h);
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const { verifier, challenge } = pkce();
    const consent = await request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
    const helpers = require('./helpers/oauth-test-client');
    const { userCode, grantId } = helpers.parseConsent(consent.text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] }));
    const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: helpers.cookieOf(consent) } });
    now += 60001;
    const late = await tokenReq(h, { code: new URL(wait.headers.location).searchParams.get('code'), redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: verifier });
    assert.equal(late.json.error, 'invalid_grant');
  });

  it('state may be omitted, and then is not echoed', async () => {
    const h = await startFrontDoorHttp();
    running.push(h);
    const r = await h.connect({ state: null, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.location.searchParams.has('state'), false);
  });
});
