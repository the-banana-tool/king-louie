// tests/frontdoor-grants.test.js — fleet stage 4 §3.4 (the phone's decision, grants, codes, revocation).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPhoneApi } = require('../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { GrantStore, AuthCodes } = require('../src/frontdoor/oauth/grants');
const { registerGrantRoutes } = require('../src/frontdoor/oauth/grant-routes');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { FLEET_SCOPE_RULES } = require('../src/frontdoor/protocol/checks');
const { formatUserCode } = require('../src/frontdoor/protocol/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const FD = testNodeIdentity({ key: 'relay' });
const A = createFakePhone({ seed: 'A' });
const C = createFakePhone({ seed: 'C' });
const stranger = createFakePhone();
// An approver whose record the admin revoked.
const R = createFakePhone({ name: 'Revoked phone' });

const GPU_ID = 'kl-aaaaaaaaaaaaaaaa';
const WEB_ID = 'kl-bbbbbbbbbbbbbbbb';
const OTHER_GPU_ID = 'kl-cccccccccccccccc';

// A stand-in for the node registry (Task 19): exact names only; `ids` can be
// changed to remove or re-enroll a node.
function fakeNodes(ids) {
  return { ids, byName: (n) => (Object.prototype.hasOwnProperty.call(ids, n) ? { node_name: n, node_id: ids[n] } : null) };
}

async function setup({ nodes = fakeNodes({ 'gpu-box': GPU_ID, 'web-01': WEB_ID }), clientName = 'Example Client', allowTestKeys = true, onGrantRevoked = null } = {}) {
  const records = [A.approverRecord(), C.approverRecord(), R.approverRecord({ revokedAt: '2026-09-01T00:00:00.000Z', revokedBy: C.deviceId })];
  const store = await approverStoreWith(records, { allowTestKeys });
  cleanups.push(() => store.cleanup());
  const dataDir = path.join(store.baseDir, 'data');
  const devices = new DeviceRegistry({ file: path.join(dataDir, 'relay', 'devices.json') });
  for (const p of [A, C, stranger, R]) devices.register({ device_id: p.deviceId, jwk: p.jwk, name: p.name, platform: 'android' });
  const phoneApi = createPhoneApi({ devices });
  const pending = new PendingAuthorizations();
  const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
  const grants = new GrantStore({ file: path.join(dataDir, 'frontdoor', 'oauth', 'grants.json'), approverStore: store, frontdoorId: FD.nodeId, alerts });
  const codes = new AuthCodes();
  const challenges = new Challenges();
  const granted = [];
  const revoked = [];
  const audit = [];
  registerGrantRoutes(phoneApi, {
    pending, grants, codes, clients: { markGranted: (id) => granted.push(id) }, challenges, approverStore: store, frontdoorId: FD.nodeId,
    scopeRules: () => FLEET_SCOPE_RULES, auditLedger: { append: async (e) => { audit.push(e); return e; } }, onGrantRevoked: onGrantRevoked || ((id) => revoked.push(id)), nodes
  });
  const server = http.createServer(phoneApi.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (phone, method, p, body = null) => {
    const text = body === null ? '' : JSON.stringify(body);
    const res = await fetch(`${base}${p}`, { method, body: body === null ? undefined : text, headers: { 'content-type': 'application/json', ...phone.signApi(method, p, text) } });
    const raw = await res.text();
    return { status: res.status, body: raw ? JSON.parse(raw) : null };
  };
  let host = 0;
  const newPending = () => pending.create({
    client: { client_id: 'dcr_AAAAAAAAAAAAAAAAAAAAAA', client_name: clientName, kind: 'dcr' }, redirectUri: 'https://client.example.com/cb',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', resource: 'https://mcp.kl.example.com/mcp',
    requestedScopes: ['fleet:read', 'fleet:run'], preselected: ['fleet:read'], state: null, ip: `203.0.113.${(host += 1)}`, clientHost: `client${host}.example.com`
  }).pending;
  // Claims `p` for `phone` and signs an approval of it.
  const approve = async (phone, p, scopes = [{ scope: 'fleet:read', machines: null }]) => {
    await call(phone, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    return call(phone, 'POST', `/v1/grants/${p.grant_id}/decision`, phone.grant({ frontdoorId: FD.nodeId, pending: p, scopes }));
  };
  const challenge = async (phone, purpose = 'revoke') => (await call(phone, 'POST', '/v1/challenges', { purpose })).body.challenge;
  return { store, nodes, pending, grants, codes, challenges, call, newPending, approve, challenge, granted, revoked, audit, alerts, dataDir };
}

describe('the phone claims by the typed code, then decides', () => {
  it('approve: a grant, a code for the wait page, and the audit entry', async () => {
    const t = await setup();
    const p = t.newPending();
    const lookup = await t.call(A, 'GET', `/v1/grants/pending?user_code=${encodeURIComponent(formatUserCode(p.user_code).toLowerCase())}`);
    assert.equal(lookup.status, 200);
    assert.deepEqual(Object.keys(lookup.body).sort(), ['client_host', 'client_id', 'client_name', 'code_challenge', 'expires_in_ms', 'grant_id', 'preselected', 'redirect_uri', 'requested_scopes', 'resource']);
    assert.equal(p.claimed_by, A.deviceId);
    const decision = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:read', machines: null }] }));
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    assert.deepEqual(decision.body, { state: 'approved' });
    assert.equal(p.status, 'approved');
    assert.match(p.code, /^[A-Za-z0-9_-]{43}$/);
    const grant = t.grants.live(p.grant_id);
    assert.deepEqual(t.grants.scopeStrings(grant), ['fleet:read']);
    assert.deepEqual(t.granted, ['dcr_AAAAAAAAAAAAAAAAAAAAAA']);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.grant.approved' && e.data.grant_id === p.grant_id));
    const taken = t.codes.take(p.code);
    assert.equal(taken.ok, true);
    assert.equal(taken.record.grantId, p.grant_id);
    assert.deepEqual(t.codes.take(p.code), { ok: false, reused: p.grant_id });
  });

  it('a second phone can neither claim nor decide a claimed request (Review Focus 4)', async () => {
    const t = await setup();
    const p = t.newPending();
    assert.equal((await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`)).status, 200);
    const second = await t.call(C, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    assert.equal(second.status, 404);
    assert.equal(second.body.error, 'no_such_request');
    const decide = await t.call(C, 'POST', `/v1/grants/${p.grant_id}/decision`, C.grant({ frontdoorId: FD.nodeId, pending: p }));
    assert.equal(decide.status, 400);
    assert.equal(decide.body.error, 'not_claimant');
  });

  it('deny, a wrong code, a non-approver, and the per-device lookup rate', async () => {
    const t = await setup();
    const p = t.newPending();
    assert.equal((await t.call(A, 'GET', '/v1/grants/pending?user_code=ZZZ-ZZZ')).status, 404);
    assert.equal((await t.call(stranger, 'GET', `/v1/grants/pending?user_code=${p.user_code}`)).status, 403);
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    const deny = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, decision: 'deny' }));
    assert.deepEqual(deny.body, { state: 'denied' });
    assert.equal(p.status, 'denied');
    assert.equal(t.grants.get(p.grant_id), null);
    let last;
    for (let i = 0; i < 9; i += 1) last = await t.call(A, 'GET', '/v1/grants/pending?user_code=ZZZZZZ');
    assert.equal(last.status, 429, 'the 11th lookup in a minute from one device is refused');
  });

  it('a device that is not an active approver is refused on every route (Deviation 13)', async () => {
    const t = await setup();
    const p = t.newPending();
    // stranger: no approver record at all; R: an approver record the admin revoked.
    for (const phone of [stranger, R]) {
      const cases = [
        ['GET', `/v1/grants/pending?user_code=${p.user_code}`, null],
        ['POST', `/v1/grants/${p.grant_id}/decision`, phone.grant({ frontdoorId: FD.nodeId, pending: p })],
        ['GET', '/v1/clients', null],
        ['POST', '/v1/challenges', { purpose: 'revoke' }],
        ['POST', `/v1/clients/${p.grant_id}/revoke`, phone.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge: 'x'.repeat(43) })]
      ];
      for (const [method, route, body] of cases) {
        const r = await t.call(phone, method, route, body);
        assert.equal(r.status, 403, `${phone.name}: ${method} ${route}`);
        assert.equal(r.body.error, 'forbidden');
      }
    }
    assert.equal(p.claimed_by, null);
    assert.equal(p.status, 'pending');
  });

  it('a published test key is not an approver where the admin store refuses test keys', async () => {
    const t = await setup({ allowTestKeys: false });
    const p = t.newPending();
    const r = await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'forbidden');
    assert.equal(p.claimed_by, null, 'the request stays unclaimed');
  });

  it('client_name reaches the phone printable, and that is what it signs and what the grant keeps', async () => {
    const t = await setup({ clientName: 'Evil‮gnp.exe​ Client' });
    const p = t.newPending();
    const lookup = await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    assert.equal(lookup.body.client_name, 'Evilgnp.exe Client');
    const view = { ...p, client_name: lookup.body.client_name };
    const decision = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: view, scopes: [{ scope: 'fleet:read', machines: null }] }));
    assert.deepEqual(decision.body, { state: 'approved' });
    assert.equal(t.grants.live(p.grant_id).client_name, 'Evilgnp.exe Client');
    assert.equal((await t.call(A, 'GET', '/v1/clients')).body[0].client_name, 'Evilgnp.exe Client');
  });

  it('a decision must name the request it is posted to, and a decided request cannot be decided again', async () => {
    const t = await setup();
    const p1 = t.newPending();
    const p2 = t.newPending();
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p1.user_code}`);
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p2.user_code}`);
    const crossed = await t.call(A, 'POST', `/v1/grants/${p2.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p1 }));
    assert.equal(crossed.status, 410);
    assert.equal(crossed.body.error, 'unknown_request');
    assert.equal(p1.status, 'pending');
    assert.equal(p2.status, 'pending');
    const ok = await t.call(A, 'POST', `/v1/grants/${p1.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p1, scopes: [{ scope: 'fleet:read', machines: null }] }));
    assert.deepEqual(ok.body, { state: 'approved' });
    assert.equal(p1.nonces.size, 1);
    const firstCode = p1.code;
    const again = await t.call(A, 'POST', `/v1/grants/${p1.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p1 }));
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'unknown_request');
    assert.equal(p1.code, firstCode, 'no second code');
    assert.deepEqual(t.grants.scopeStrings(t.grants.live(p1.grant_id)), ['fleet:read'], 'the grant is unchanged');
  });

  it('a decision signed by another approver than the caller is refused', async () => {
    const t = await setup();
    const p = t.newPending();
    const signedByC = C.grant({ frontdoorId: FD.nodeId, pending: p });
    const r = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, signedByC);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_decision');
    assert.equal(p.status, 'pending');
    assert.equal(p.nonces.size, 0);
  });

  it('machines: a known name is kept; an unknown name is refused, never stored', async () => {
    const t = await setup();
    const known = t.newPending();
    const ok = await t.approve(A, known, [{ scope: 'fleet:read', machines: ['gpu-box'] }]);
    assert.deepEqual(ok.body, { state: 'approved' });
    assert.deepEqual(t.grants.scopeStrings(t.grants.live(known.grant_id)), ['fleet:read;machines=gpu-box']);
    assert.deepEqual(t.grants.live(known.grant_id).machine_ids, { 'gpu-box': GPU_ID });
    const unknown = t.newPending();
    const refused = await t.approve(A, unknown, [{ scope: 'fleet:read', machines: ['gpu-box', 'nas-9'] }]);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'unknown_machine');
    assert.equal(unknown.status, 'pending');
    assert.equal(t.grants.get(unknown.grant_id), null);
  });

  it('machines: a grant is pinned to the node id; a different key re-enrolled under the name matches nothing (ruling T23-nodeid)', async () => {
    const t = await setup();
    const limited = t.newPending();
    await t.approve(A, limited, [{ scope: 'fleet:read', machines: ['gpu-box'] }, { scope: 'fleet:run', machines: null }]);
    const g = t.grants.live(limited.grant_id);
    assert.equal(t.grants.machineMatches(g, 'fleet:read', 'gpu-box', GPU_ID), true);
    assert.equal(t.grants.machineMatches(g, 'fleet:read', 'web-01', WEB_ID), false, 'not a listed name');
    assert.equal(t.grants.machineMatches(g, 'fleet:run', 'web-01', WEB_ID), true, 'an unlimited entry covers every node');
    assert.equal(t.grants.machineMatches(g, 'fleet:delegate', 'gpu-box', GPU_ID), false, 'a scope the grant lacks');
    // gpu-box is removed, and a different key enrolls under the same name.
    delete t.nodes.ids['gpu-box'];
    t.nodes.ids['gpu-box'] = OTHER_GPU_ID;
    assert.equal(t.grants.machineMatches(g, 'fleet:read', 'gpu-box', OTHER_GPU_ID), false);
    const fresh = new GrantStore({ file: t.grants.file, approverStore: t.store, frontdoorId: FD.nodeId, alerts: t.alerts });
    fresh.load();
    assert.equal(fresh.machineMatches(fresh.live(limited.grant_id), 'fleet:read', 'gpu-box', OTHER_GPU_ID), false, 'still after a restart');
    assert.equal(fresh.machineMatches(fresh.live(limited.grant_id), 'fleet:read', 'gpu-box', GPU_ID), true);
    // A new approval now pins the new key.
    const again = t.newPending();
    await t.approve(A, again, [{ scope: 'fleet:read', machines: ['gpu-box'] }]);
    assert.equal(t.grants.machineMatches(t.grants.live(again.grant_id), 'fleet:read', 'gpu-box', OTHER_GPU_ID), true);
  });

  it('machines: with no node registry, any machine limit is refused', async () => {
    const t = await setup({ nodes: null });
    const p = t.newPending();
    const refused = await t.approve(A, p, [{ scope: 'fleet:read', machines: ['gpu-box'] }]);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'unknown_machine');
    assert.deepEqual((await t.approve(A, p)).body, { state: 'approved' });
  });
});

describe('connected clients and revocation', () => {
  it('lists live grants; a challenge-bound revoke ends one at once', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p }));
    const list = await t.call(A, 'GET', '/v1/clients');
    assert.deepEqual(list.body.map((g) => [g.grant_id, g.client_name, g.scopes]), [[p.grant_id, 'Example Client', ['fleet:read', 'fleet:run']]]);
    // Ruling T2-purpose: POST /v1/challenges takes { purpose }.
    const { body: { challenge } } = await t.call(A, 'POST', '/v1/challenges', { purpose: 'revoke' });
    const revoke = A.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge });
    assert.equal((await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke)).status, 204);
    assert.equal(t.grants.live(p.grant_id), null);
    assert.deepEqual(t.revoked, [p.grant_id]);
    const again = await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke);
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'challenge_reused');
    assert.deepEqual((await t.call(A, 'GET', '/v1/clients')).body, []);
  });

  it('revoking records when, why, the audit entry and the revoked event', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.approve(A, p);
    const events = [];
    t.grants.on('revoked', (id) => events.push(id));
    const revoke = A.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge: await t.challenge(A) });
    assert.equal((await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke)).status, 204);
    const g = t.grants.get(p.grant_id);
    assert.ok(Date.parse(g.revoked_at) > 0);
    assert.equal(g.revoked_reason, 'phone');
    assert.deepEqual(events, [p.grant_id]);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.grant.revoked' && e.data.grant_id === p.grant_id && e.data.device_id === A.deviceId));
    assert.deepEqual(t.grants.list(), []);
    assert.equal(t.grants.list({ liveOnly: false }).length, 1);
    assert.equal(t.grants.revoke(p.grant_id, 'again'), false, 'a revoked grant stays revoked');
  });

  it('an onGrantRevoked that throws still leaves the grant revoked and audited', async () => {
    const t = await setup({ onGrantRevoked: () => { throw new Error('boom'); } });
    const p = t.newPending();
    await t.approve(A, p);
    const revoke = A.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge: await t.challenge(A) });
    assert.equal((await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke)).status, 204);
    assert.equal(t.grants.live(p.grant_id), null);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.grant.revoked' && e.data.grant_id === p.grant_id));
  });

  it('a challenge is good only for its own purpose (ruling T2-purpose)', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.approve(A, p);
    for (const purpose of [undefined, 'pair', 'grant']) {
      const r = await t.call(A, 'POST', '/v1/challenges', purpose === undefined ? {} : { purpose });
      assert.equal(r.status, 400, String(purpose));
      assert.equal(r.body.error, 'bad_purpose');
    }
    const removal = await t.challenge(A, 'remove');
    const wrong = await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, A.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge: removal }));
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'challenge_wrong_purpose');
    assert.ok(t.grants.live(p.grant_id));
    assert.equal(t.challenges.take(A.deviceId, removal, 'remove'), 'ok', 'the removal challenge was not spent');
  });

  it('a revoke must name the grant in its path and be signed by the caller; a refusal there spends nothing', async () => {
    const t = await setup();
    const p1 = t.newPending();
    const p2 = t.newPending();
    await t.approve(A, p1);
    await t.approve(A, p2);
    const challenge = await t.challenge(A);
    const crossed = await t.call(A, 'POST', `/v1/clients/${p2.grant_id}/revoke`, A.revokeClient({ frontdoorId: FD.nodeId, grantId: p1.grant_id, challenge }));
    assert.equal(crossed.status, 400);
    assert.equal(crossed.body.error, 'bad_revoke');
    const byOther = await t.call(A, 'POST', `/v1/clients/${p1.grant_id}/revoke`, C.revokeClient({ frontdoorId: FD.nodeId, grantId: p1.grant_id, challenge }));
    assert.equal(byOther.status, 400);
    assert.equal(byOther.body.error, 'bad_revoke');
    assert.ok(t.grants.live(p1.grant_id) && t.grants.live(p2.grant_id));
    const unknown = await t.call(A, 'POST', '/v1/clients/gr_BBBBBBBBBBBBBBBBBBBBBB/revoke', A.revokeClient({ frontdoorId: FD.nodeId, grantId: 'gr_BBBBBBBBBBBBBBBBBBBBBB', challenge }));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'not_found');
    const ok = await t.call(A, 'POST', `/v1/clients/${p1.grant_id}/revoke`, A.revokeClient({ frontdoorId: FD.nodeId, grantId: p1.grant_id, challenge }));
    assert.equal(ok.status, 204, 'the same challenge still works for the right grant');
    assert.deepEqual(t.revoked, [p1.grant_id]);
  });
});

describe('GrantStore on load', () => {
  it('drops a grant whose record no longer matches its signature', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:read', machines: null }] }));
    const file = path.join(t.dataDir, 'frontdoor', 'oauth', 'grants.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.grants[p.grant_id].scopes = [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }];
    fs.writeFileSync(file, JSON.stringify(stored));
    const fresh = new GrantStore({ file, approverStore: t.store, frontdoorId: FD.nodeId, alerts: t.alerts });
    fresh.load();
    assert.equal(fresh.get(p.grant_id), null);
    assert.deepEqual(t.alerts.raised.at(-1), ['node_record_invalid', { subject: `grant:${p.grant_id}`, detail: { reason: 'record_mismatch' } }]);
  });

  it('keeps an intact grant across a restart, revocation state included', async () => {
    const t = await setup();
    const p1 = t.newPending();
    const p2 = t.newPending();
    await t.approve(A, p1);
    await t.approve(A, p2);
    t.grants.revoke(p2.grant_id, 'test');
    const fresh = new GrantStore({ file: t.grants.file, approverStore: t.store, frontdoorId: FD.nodeId, alerts: t.alerts });
    fresh.load();
    assert.deepEqual(fresh.scopeStrings(fresh.live(p1.grant_id)), ['fleet:read']);
    assert.equal(fresh.live(p2.grant_id), null);
    assert.equal(fresh.get(p2.grant_id).revoked_reason, 'test');
    assert.deepEqual(t.alerts.raised, []);
  });

  it('drops edits to any bound field, and a grant signed by a device the admin store does not hold', async () => {
    const t = await setup();
    const edits = {
      redirect_uri: 'https://client.example.com/cb2',
      resource: 'https://mcp.kl.example.com/other',
      client_id: 'dcr_CCCCCCCCCCCCCCCCCCCCCC',
      client_name: 'Someone Else',
      device_id: C.deviceId
    };
    const ids = {};
    for (const k of Object.keys(edits)) {
      const p = t.newPending();
      await t.approve(A, p);
      ids[k] = p.grant_id;
    }
    const file = t.grants.file;
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(edits)) stored.grants[ids[k]][k] = v;
    fs.writeFileSync(file, JSON.stringify(stored));
    const fresh = new GrantStore({ file, approverStore: t.store, frontdoorId: FD.nodeId, alerts: t.alerts });
    fresh.load();
    assert.deepEqual(fresh.list({ liveOnly: false }), []);
    assert.deepEqual(t.alerts.raised.map(([, o]) => o.detail.reason), Object.keys(edits).map(() => 'record_mismatch'));
    const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(reread.grants, {}, 'the dropped grants are gone from the file');

    const other = await approverStoreWith([C.approverRecord()], { allowTestKeys: true });
    cleanups.push(() => other.cleanup());
    const t2 = await setup();
    const p = t2.newPending();
    await t2.approve(A, p);
    const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
    const elsewhere = new GrantStore({ file: t2.grants.file, approverStore: other, frontdoorId: FD.nodeId, alerts });
    elsewhere.load();
    assert.equal(elsewhere.get(p.grant_id), null);
    assert.deepEqual(alerts.raised, [['node_record_invalid', { subject: `grant:${p.grant_id}`, detail: { reason: 'unknown_device' } }]]);
  });

  it('R25: a grant accepted before its device was revoked stays; one accepted after is dropped', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.approve(A, p);
    const acceptedAt = Date.parse(t.grants.get(p.grant_id).accepted_at);
    const load = async (revokedAt) => {
      const store = await approverStoreWith([A.approverRecord({ revokedAt, revokedBy: C.deviceId }), C.approverRecord()], { allowTestKeys: true });
      cleanups.push(() => store.cleanup());
      const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
      const copy = path.join(store.baseDir, 'grants.json');
      fs.copyFileSync(t.grants.file, copy);
      const g = new GrantStore({ file: copy, approverStore: store, frontdoorId: FD.nodeId, alerts });
      g.load();
      return { g, alerts };
    };
    const later = await load(new Date(acceptedAt + 60000).toISOString());
    assert.ok(later.g.live(p.grant_id));
    const earlier = await load(new Date(acceptedAt - 60000).toISOString());
    assert.equal(earlier.g.get(p.grant_id), null);
    assert.deepEqual(earlier.alerts.raised, [['node_record_invalid', { subject: `grant:${p.grant_id}`, detail: { reason: 'revoked_device' } }]]);
  });

  it('drops a record built on a signed deny, a moved map key, a bad revoked_at, and bad machine ids', async () => {
    const t = await setup();
    const ps = {};
    for (const k of ['deny', 'key', 'revokedAt', 'missingId', 'extraId', 'badId']) {
      ps[k] = t.newPending();
      await t.approve(A, ps[k], ['deny', 'key', 'revokedAt'].includes(k) ? undefined : [{ scope: 'fleet:read', machines: ['gpu-box'] }]);
    }
    const stored = JSON.parse(fs.readFileSync(t.grants.file, 'utf8'));
    const rec = (k) => stored.grants[ps[k].grant_id];
    rec('deny').signed_grant = A.grant({ frontdoorId: FD.nodeId, pending: ps.deny, decision: 'deny' });
    rec('revokedAt').revoked_at = 5;
    rec('missingId').machine_ids = {};
    rec('extraId').machine_ids = { 'gpu-box': GPU_ID, 'web-01': WEB_ID };
    rec('badId').machine_ids = { 'gpu-box': 'gpu-box' };
    const moved = rec('key');
    delete stored.grants[ps.key.grant_id];
    stored.grants.gr_CCCCCCCCCCCCCCCCCCCCCC = moved;
    fs.writeFileSync(t.grants.file, JSON.stringify(stored));
    t.grants.load();
    assert.deepEqual(t.grants.list({ liveOnly: false }), []);
    const reasons = Object.fromEntries(t.alerts.raised.map(([, o]) => [o.subject, o.detail.reason]));
    assert.deepEqual(reasons, {
      [`grant:${ps.deny.grant_id}`]: 'not_approved',
      [`grant:${ps.key.grant_id}`]: 'record_mismatch',
      [`grant:${ps.revokedAt.grant_id}`]: 'malformed',
      [`grant:${ps.missingId.grant_id}`]: 'record_mismatch',
      [`grant:${ps.extraId.grant_id}`]: 'record_mismatch',
      [`grant:${ps.badId.grant_id}`]: 'malformed'
    });
  });

  it('client_host is recomputed from the signed client and redirect, not read from the file', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.approve(A, p);
    const stored = JSON.parse(fs.readFileSync(t.grants.file, 'utf8'));
    stored.grants[p.grant_id].client_host = 'trusted.example.com';
    fs.writeFileSync(t.grants.file, JSON.stringify(stored));
    t.grants.load();
    assert.equal(t.grants.live(p.grant_id).client_host, 'client.example.com');
  });

  it('a missing file loads empty; a malformed entry is dropped with an alert', async () => {
    const t = await setup();
    assert.deepEqual(t.grants.load(), []);
    fs.mkdirSync(path.dirname(t.grants.file), { recursive: true });
    fs.writeFileSync(t.grants.file, JSON.stringify({ v: 1, grants: { gr_x: { grant_id: 'gr_x' } } }));
    t.grants.load();
    assert.equal(t.grants.get('gr_x'), null);
    assert.deepEqual(t.alerts.raised, [['node_record_invalid', { subject: 'grant:gr_x', detail: { reason: 'malformed' } }]]);
  });
});

describe('AuthCodes', () => {
  it('60 s, single use', () => {
    let now = 0;
    const codes = new AuthCodes({ now: () => now });
    const code = codes.issue({ grantId: 'gr_x', clientId: 'dcr_y', redirectUri: 'https://client.example.com/cb', codeChallenge: 'c', resource: 'r' });
    now += 60001;
    assert.deepEqual(codes.take(code), { ok: false, expired: true });
    assert.deepEqual(codes.take('nope'), { ok: false });
  });

  it('binds client, redirect, challenge and resource exactly; keeps only the hash', () => {
    const codes = new AuthCodes();
    const bound = { grantId: 'gr_x', clientId: 'dcr_y', redirectUri: 'https://client.example.com/cb?x=1', codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', resource: 'https://mcp.kl.example.com/mcp' };
    const code = codes.issue(bound);
    assert.ok(![...codes.codes.keys()].includes(code));
    assert.ok(!JSON.stringify([...codes.codes.values()]).includes(code));
    const taken = codes.take(code);
    assert.equal(taken.ok, true);
    for (const [k, v] of Object.entries(bound)) assert.equal(taken.record[k], v, k);
  });

  it('an expired code stays expired; only a code that was spent reports reuse', () => {
    let now = 0;
    const codes = new AuthCodes({ now: () => now });
    const code = codes.issue({ grantId: 'gr_x', clientId: 'dcr_y', redirectUri: 'u', codeChallenge: 'c', resource: 'r' });
    now += 60001;
    assert.deepEqual(codes.take(code), { ok: false, expired: true });
    assert.deepEqual(codes.take(code), { ok: false, expired: true }, 'no grant is revoked over a code nobody redeemed');
  });

  it('take(code, verify): a failed check spends nothing; three failures burn the code; reuse needs a passing check', () => {
    const codes = new AuthCodes();
    const bound = { grantId: 'gr_x', clientId: 'dcr_y', redirectUri: 'u', codeChallenge: 'c', resource: 'r' };
    const code = codes.issue(bound);
    const seen = [];
    assert.deepEqual(codes.take(code, (rec) => { seen.push(rec); return false; }), { ok: false, mismatch: true });
    assert.deepEqual(seen, [bound], 'verify sees the bound record');
    assert.equal(codes.take(code, () => true).ok, true, 'one failure does not spend the code');
    for (let i = 0; i < 3; i += 1) assert.deepEqual(codes.take(code, () => false), { ok: false, mismatch: true }, 'a failing second redemption is not reuse');
    // Failures after the redemption burn nothing: whoever redeemed first
    // could otherwise switch off reuse detection for the real client.
    assert.deepEqual(codes.take(code, () => true), { ok: false, reused: 'gr_x' });

    const other = codes.issue(bound);
    for (let i = 0; i < 3; i += 1) assert.deepEqual(codes.take(other, () => false), { ok: false, mismatch: true });
    assert.deepEqual(codes.take(other, () => true), { ok: false }, 'burned: never redeemed, never reuse');
  });
});
