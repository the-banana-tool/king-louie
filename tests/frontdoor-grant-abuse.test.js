// tests/frontdoor-grant-abuse.test.js — fleet stage 4 §3.4, R23 (grant phishing).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { GrantStore } = require('../src/frontdoor/oauth/grants');
const { TokenStore } = require('../src/frontdoor/oauth/tokens');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request, pkce, parseConsent, cookieOf } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });
const start = async (opts) => { const h = await startFrontDoorHttp(opts); running.push(h); return h; };

const REDIRECT = 'https://client.example.com/cb';
const AUD = 'https://mcp.kl.example.com/mcp';

async function authorize(h, clientId, redirectUri = 'https://client.example.com/cb') {
  return request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}` });
}

const register = async (h, host = 'client.example.com') => (await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: host, redirect_uris: [`https://${host}/cb`] } })).json.client_id;

// A consent flow approved on phone A up to the code on the wait page; the
// token exchange is left to the test.
async function approvedCode(h, { scopes = [{ scope: 'fleet:read', machines: null }], clientId = null } = {}) {
  const id = clientId || await register(h);
  const { verifier, challenge } = pkce();
  const consent = await request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}` });
  const { userCode, grantId } = parseConsent(consent.text);
  const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
  const decision = await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes }));
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) } });
  return { code: new URL(wait.headers.location).searchParams.get('code'), verifier, grantId, clientId: id };
}

const redeem = (h, c, extra = {}) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier, ...extra } });
const refresh = (h, clientId, token, extra = {}) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, ...extra } });
const wrongVerifier = () => crypto.randomBytes(32).toString('base64url');

describe('grant abuse', () => {
  it('three new requests per IP per 10 minutes', async () => {
    const h = await start();
    const ids = [];
    for (const host of ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']) {
      const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: host, redirect_uris: [`https://${host}/cb`] } });
      ids.push([reg.json.client_id, `https://${host}/cb`]);
    }
    for (let i = 0; i < 3; i += 1) assert.equal((await authorize(h, ids[i][0], ids[i][1])).status, 200);
    assert.equal((await authorize(h, ids[3][0], ids[3][1])).status, 429);
  });

  it('one per client host: a newer request replaces an older unclaimed one', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const first = parseConsent((await authorize(h, reg.json.client_id)).text);
    const second = parseConsent((await authorize(h, reg.json.client_id)).text);
    assert.equal(h.pending.get(first.grantId), null);
    assert.ok(h.pending.get(second.grantId));
  });

  it('a claimed request survives a flood of 60; a wrong typed code is 404; no push is ever sent for grants', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const mine = parseConsent((await authorize(h, reg.json.client_id)).text);
    assert.equal((await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${mine.userCode}`)).status, 200);
    const client = h.clients.get(reg.json.client_id);
    for (let i = 0; i < 60; i += 1) {
      h.pending.create({ client, redirectUri: 'https://client.example.com/cb', codeChallenge: pkce().challenge, resource: 'https://mcp.kl.example.com/mcp', requestedScopes: ['fleet:read'], preselected: ['fleet:read'], ip: `198.51.100.${i}`, clientHost: `flood${i}.example.com` });
    }
    assert.ok(h.pending.get(mine.grantId), 'claimed requests are never evicted');
    const miss = await h.phoneCall(h.phone, 'GET', '/v1/grants/pending?user_code=000-000');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error, 'no_such_request');
    assert.deepEqual(h.pushes, []);
  });

  it('a second phone can neither claim nor decide a claimed request (Review Focus 4)', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const { userCode, grantId } = parseConsent((await authorize(h, reg.json.client_id)).text);
    const owner = await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`);
    assert.equal(owner.status, 200);
    assert.equal((await h.phoneCall(h.second, 'GET', `/v1/grants/pending?user_code=${userCode}`)).status, 404);
    const signed = h.second.grant({ frontdoorId: h.fd.nodeId, pending: { ...owner.body, user_code: userCode.replace('-', '') } });
    const decided = await h.phoneCall(h.second, 'POST', `/v1/grants/${grantId}/decision`, signed);
    assert.equal(decided.status, 400);
    assert.equal(decided.body.error, 'not_claimant');
    assert.equal(h.grants.get(grantId), null);
    assert.equal(h.pending.get(grantId).status, 'pending');
  });
});

describe('grant abuse: codes', () => {
  it('a reused code revokes the grant and kills the tokens it issued', async () => {
    const h = await start();
    const c = await approvedCode(h);
    const first = await redeem(h, c);
    assert.equal(first.status, 200);
    const again = await redeem(h, c);
    assert.equal(again.status, 400);
    assert.equal(again.json.error, 'invalid_grant');
    assert.equal(h.grants.live(c.grantId), null);
    assert.equal(h.grants.get(c.grantId).revoked_reason, 'code_reuse');
    assert.equal(h.tokens.find(first.json.access_token), null);
    assert.equal(h.tokens.find(first.json.refresh_token), null);
    assert.ok(h.audit.some((e) => e.kind === 'frontdoor.grant.revoked' && e.data.grant_id === c.grantId && e.data.reason === 'code_reuse'));
  });

  // Carry (Task 24): the token helper drops the tokens even if grants.revoke
  // throws; the 'revoked' event never fires then, so nothing else would.
  it('a reused code kills the tokens and ends the sessions even when saving the revoked grant fails', async () => {
    const ended = [];
    const h = await start({ mcp: { handle: async () => {}, endSessionsForGrant: (id) => ended.push(id) } });
    const c = await approvedCode(h);
    const first = await redeem(h, c);
    assert.equal(first.status, 200);
    h.grants._save = () => { throw new Error('disk full'); };
    const again = await redeem(h, c);
    assert.notEqual(again.status, 200);
    assert.equal(h.tokens.find(first.json.access_token), null, 'the access token is gone');
    assert.equal(h.tokens.find(first.json.refresh_token), null, 'the refresh token is gone');
    assert.deepEqual(h.revokedGrants, [c.grantId], 'onGrantRevoked ran (ruling T25-revokefail)');
    assert.deepEqual(ended, [c.grantId], 'the grant\'s MCP sessions were ended');
    assert.ok(h.audit.some((e) => e.kind === 'frontdoor.grant.revoked' && e.data.grant_id === c.grantId && e.data.reason === 'code_reuse'), 'and audited');
    // The revocation reaches the file on the next attempt.
    delete h.grants._save;
    assert.equal(h.grants.revoke(c.grantId, 'code_reuse'), true, 'the retry saves and reports success');
    assert.equal(h.grants.revoke(c.grantId, 'code_reuse'), false, 'once saved, it is simply revoked');
    const onDisk = JSON.parse(fs.readFileSync(h.grants.file, 'utf8')).grants[c.grantId];
    assert.equal(typeof onDisk.revoked_at, 'string');
  });

  it('a reused code kills the tokens and ends the sessions even when the tokens save fails too', async () => {
    const ended = [];
    const h = await start({ mcp: { handle: async () => {}, endSessionsForGrant: (id) => ended.push(id) } });
    const c = await approvedCode(h);
    const first = await redeem(h, c);
    assert.equal(first.status, 200);
    h.grants._save = () => { throw new Error('disk full'); };
    h.tokens._save = () => { throw new Error('disk full'); };
    assert.notEqual((await redeem(h, c)).status, 200);
    assert.deepEqual(ended, [c.grantId], 'a failing tokens save does not skip onGrantRevoked');
    // The tokens are gone from memory but not yet from the file; the retry
    // writes that, though it finds nothing more to remove.
    const onDisk = () => JSON.parse(fs.readFileSync(h.tokens.file, 'utf8'));
    assert.ok(Object.values(onDisk().access).some((r) => r.grant_id === c.grantId), 'the failed save left the file as it was');
    delete h.grants._save;
    delete h.tokens._save;
    h.tokens.revokeGrant(c.grantId);
    assert.ok(!Object.values(onDisk().access).some((r) => r.grant_id === c.grantId));
    assert.ok(!Object.values(onDisk().refresh).some((r) => r.grant_id === c.grantId));
    const restarted = new TokenStore({ file: h.tokens.file, grants: h.grants });
    assert.equal(restarted.find(first.json.access_token), null, 'a restart does not bring them back');
  });

  it('a stolen code with the wrong verifier is neither consumed nor revoked; three failures burn it', async () => {
    const h = await start({ pendingPerIp: 10 });
    const c = await approvedCode(h);
    const stolen = await redeem(h, c, { code_verifier: wrongVerifier() });
    assert.equal(stolen.json.error, 'invalid_grant');
    assert.ok(h.grants.live(c.grantId), 'not revoked');
    const real = await redeem(h, c);
    assert.equal(real.status, 200, 'not consumed: the real client still redeems it');

    const d = await approvedCode(h);
    for (let i = 0; i < 3; i += 1) assert.equal((await redeem(h, d, { code_verifier: wrongVerifier() })).json.error, 'invalid_grant');
    const late = await redeem(h, d);
    assert.equal(late.status, 400);
    assert.equal(late.json.error, 'invalid_grant', 'burned after three failures');
    assert.ok(h.grants.live(d.grantId), 'burning is not revocation');
    assert.deepEqual(h.revokedGrants, []);
    assert.ok(!h.audit.some((e) => e.kind === 'frontdoor.grant.revoked'));
  });

  it('redirect_uri and resource must match the authorization exactly; a mismatch consumes nothing', async () => {
    const h = await start({ pendingPerIp: 10 });
    const variants = [
      [{ redirect_uri: 'https://client.example.com/cb/' }, { resource: 'https://other.example.com/mcp' }],
      [{ redirect_uri: 'https://client.example.com/other' }, { resource: `${AUD}/` }]
    ];
    for (const pair of variants) {
      const c = await approvedCode(h);
      // Two mismatches (a third would burn the code), then the exact match.
      for (const extra of pair) {
        const r = await redeem(h, c, extra);
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.equal(r.json.error, 'invalid_grant', JSON.stringify(extra));
      }
      assert.ok(h.grants.live(c.grantId), 'a mismatch revokes nothing');
      const ok = await redeem(h, c, { resource: AUD });
      assert.equal(ok.status, 200, ok.text);
    }
    assert.deepEqual(h.revokedGrants, []);
  });
});

describe('grant abuse: the phone decision', () => {
  it('an approver the admin revoked can neither decide nor lend its signature', async () => {
    const h = await start();
    const clientId = await register(h);
    const { userCode, grantId } = parseConsent((await authorize(h, clientId)).text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    const signed = h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] });
    h.revokeApprover(h.phone);
    const own = await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, signed);
    assert.equal(own.status, 403);
    assert.equal(own.body.error, 'forbidden');
    // An active phone posting the revoked phone's signed approval.
    const relayed = await h.phoneCall(h.second, 'POST', `/v1/grants/${grantId}/decision`, signed);
    assert.equal(relayed.status, 400);
    assert.equal(relayed.body.error, 'revoked_device');
    assert.equal(h.grants.get(grantId), null);
    assert.equal(h.pending.get(grantId).status, 'pending');
  });

  it('a decision envelope replayed on another request, or again on its own, is refused', async () => {
    const h = await start();
    const one = parseConsent((await authorize(h, await register(h, 'one.example.com'), 'https://one.example.com/cb')).text);
    const two = parseConsent((await authorize(h, await register(h, 'two.example.com'), 'https://two.example.com/cb')).text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${one.userCode}`)).body;
    assert.equal((await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${two.userCode}`)).status, 200);
    const signed = h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: one.userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] });
    const across = await h.phoneCall(h.phone, 'POST', `/v1/grants/${two.grantId}/decision`, signed);
    assert.equal(across.status, 410);
    assert.equal(across.body.error, 'unknown_request');
    assert.equal(h.pending.get(two.grantId).status, 'pending');
    assert.equal(h.grants.get(two.grantId), null);
    assert.equal((await h.phoneCall(h.phone, 'POST', `/v1/grants/${one.grantId}/decision`, signed)).status, 200);
    for (const id of [one.grantId, two.grantId]) {
      const replay = await h.phoneCall(h.phone, 'POST', `/v1/grants/${id}/decision`, signed);
      assert.equal(replay.status, 410, id);
      assert.equal(replay.body.error, 'unknown_request', id);
    }
    assert.deepEqual(h.grants.list().map((g) => g.grant_id), [one.grantId], 'one approval, one grant');
    assert.equal(h.pending.get(two.grantId).status, 'pending');
  });
});

describe('grant abuse: refresh tokens', () => {
  it('a rotated refresh token presented after the 30 s grace revokes the grant', async () => {
    let t = Date.now();
    const h = await start({ now: () => t, pendingPerIp: 10 });
    // Inside the grace: the lost-answer retry works once.
    const g = await approvedCode(h);
    const gp = (await redeem(h, g)).json;
    assert.equal((await refresh(h, g.clientId, gp.refresh_token)).status, 200);
    t += 29000;
    assert.equal((await refresh(h, g.clientId, gp.refresh_token)).status, 200, 'within the grace');
    assert.ok(h.grants.live(g.grantId));
    // Outside it: reuse.
    const c = await approvedCode(h);
    const pair = (await redeem(h, c)).json;
    const next = await refresh(h, c.clientId, pair.refresh_token);
    assert.equal(next.status, 200);
    t += 30001;
    const reuse = await refresh(h, c.clientId, pair.refresh_token);
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error, 'invalid_grant');
    assert.equal(h.grants.live(c.grantId), null);
    assert.equal(h.grants.get(c.grantId).revoked_reason, 'refresh_reuse');
    assert.equal(h.tokens.find(next.json.refresh_token), null, 'the successor dies with the grant');
    assert.equal(h.tokens.authenticate(next.json.access_token, { aud: AUD }), null);
    assert.ok(h.alerts.unacked('refresh_reuse').some((a) => a.subject === `grant:${c.grantId}`));
    assert.ok(h.grants.live(g.grantId), 'only the reused grant is revoked');
  });

  it('refresh reuse is alerted and audited even when revoking the grant throws', async () => {
    let t = Date.now();
    const h = await start({ now: () => t });
    const c = await approvedCode(h);
    const pair = (await redeem(h, c)).json;
    const next = await refresh(h, c.clientId, pair.refresh_token);
    assert.equal(next.status, 200);
    t += 30001;
    h.grants._save = () => { throw new Error('disk full'); };
    const reuse = await refresh(h, c.clientId, pair.refresh_token);
    assert.notEqual(reuse.status, 200);
    assert.ok(h.alerts.unacked('refresh_reuse').some((a) => a.subject === `grant:${c.grantId}`), 'the theft is alerted');
    assert.ok(h.audit.some((e) => e.kind === 'frontdoor.refresh_reuse' && e.data.grant_id === c.grantId), 'and audited');
    assert.equal(h.tokens.find(next.json.refresh_token), null, 'and the tokens still die');
  });

  it('refresh reuse: the grant is already revoked when the refresh_reuse audit append starts', async () => {
    let t = Date.now();
    let h = null;
    const liveAtAudit = [];
    h = await start({
      now: () => t,
      onAudit: (e) => { if (e.kind === 'frontdoor.refresh_reuse') liveAtAudit.push(h.grants.live(e.data.grant_id) !== null); }
    });
    const c = await approvedCode(h);
    const pair = (await redeem(h, c)).json;
    const next = await refresh(h, c.clientId, pair.refresh_token);
    assert.equal(next.status, 200);
    t += 30001;
    const reuse = await refresh(h, c.clientId, pair.refresh_token);
    assert.equal(reuse.status, 400);
    assert.deepEqual(liveAtAudit, [false], 'no await sits between detecting the theft and revoking the grant');
    assert.ok(h.alerts.unacked('refresh_reuse').some((a) => a.subject === `grant:${c.grantId}`));
  });

  it('refresh may not narrow to a machine the grant did not pin', async () => {
    const h = await start({ pendingPerIp: 10 });
    const gpu = h.registry.byName('gpu-box');
    const web = h.registry.byName('web-01');
    assert.ok(gpu && web, 'both machines are enrolled');
    // Limited to gpu-box: web-01 is enrolled but not in the grant.
    const c = await approvedCode(h, { scopes: [{ scope: 'fleet:read', machines: ['gpu-box'] }] });
    const pair = (await redeem(h, c)).json;
    assert.equal(pair.scope, 'fleet:read;machines=gpu-box');
    const grant = h.grants.live(c.grantId);
    assert.equal(h.grants.machineMatches(grant, 'fleet:read', 'gpu-box', gpu.node_id), true);
    assert.equal(h.grants.machineMatches(grant, 'fleet:read', 'gpu-box', web.node_id), false, 'the name alone does not match');
    assert.equal(h.grants.machineMatches(grant, 'fleet:read', 'web-01', web.node_id), false);
    const widened = await refresh(h, c.clientId, pair.refresh_token, { scope: 'fleet:read;machines=web-01' });
    assert.equal(widened.status, 400);
    assert.equal(widened.json.error, 'invalid_scope');
    // Unlimited grant: nothing is pinned, so no machine limit can be asked for.
    const u = await approvedCode(h);
    const upair = (await redeem(h, u)).json;
    const pinned = await refresh(h, u.clientId, upair.refresh_token, { scope: 'fleet:read;machines=gpu-box' });
    assert.equal(pinned.status, 400);
    assert.equal(pinned.json.error, 'invalid_scope');
    // A refused narrowing spends nothing: the same tokens still refresh, and
    // narrowing within the pins works.
    const same = await refresh(h, c.clientId, pair.refresh_token, { scope: 'fleet:read;machines=gpu-box' });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.json.scope, 'fleet:read;machines=gpu-box');
    assert.equal((await refresh(h, u.clientId, upair.refresh_token)).status, 200);
    assert.ok(h.grants.live(c.grantId) && h.grants.live(u.grantId));
  });
});

describe('grant abuse: revocation when saving fails', () => {
  it('the phone revoke drops the tokens and ends the sessions; a retry saves the revocation, which survives a restart', async () => {
    const ended = [];
    const h = await start({ mcp: { handle: async () => {}, endSessionsForGrant: (id) => ended.push(id) } });
    const c = await approvedCode(h);
    const pair = (await redeem(h, c)).json;
    const revoke = async () => {
      const { body: { challenge } } = await h.phoneCall(h.phone, 'POST', '/v1/challenges', { purpose: 'revoke' });
      return h.phoneCall(h.phone, 'POST', `/v1/clients/${c.grantId}/revoke`, h.phone.revokeClient({ frontdoorId: h.fd.nodeId, grantId: c.grantId, challenge }));
    };
    h.grants._save = () => { throw new Error('disk full'); };
    const failed = await revoke();
    assert.equal(failed.status, 500);
    assert.equal(h.grants.live(c.grantId), null);
    assert.equal(h.tokens.find(pair.access_token), null);
    assert.equal(h.tokens.find(pair.refresh_token), null);
    assert.deepEqual(h.revokedGrants, [c.grantId]);
    assert.deepEqual(ended, [c.grantId]);
    const audited = () => h.audit.filter((e) => e.kind === 'frontdoor.grant.revoked' && e.data.grant_id === c.grantId && e.data.reason === 'phone').length;
    assert.equal(audited(), 1, 'the failed attempt is on the record');
    delete h.grants._save;
    const retry = await revoke();
    assert.equal(retry.status, 204, 'the retry succeeds rather than answering 404');
    assert.equal(typeof JSON.parse(fs.readFileSync(h.grants.file, 'utf8')).grants[c.grantId].revoked_at, 'string');
    const restarted = new GrantStore({ file: h.grants.file, approverStore: h.store, frontdoorId: h.fd.nodeId });
    restarted.load();
    assert.ok(restarted.get(c.grantId));
    assert.equal(restarted.live(c.grantId), null, 'still revoked after a restart');
    assert.equal(audited(), 2, 'the attempt that saved it is on the record too');
  });
});
