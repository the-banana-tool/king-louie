// tests/helpers/frontdoor-harness.js
//
// The front door's HTTP front half on plain http (the SNI listener and TLS
// are Task 16's): OAuth, the phone API with F4's grant routes, and an
// optional MCP endpoint. Phone A is the owner; C is a second enrolled phone.
// The node registry holds `machines` (console-confirmed, fresh keys), so a
// grant may be limited to them.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPhoneApi } = require('../../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../../src/frontdoor/device-registry');
const { ClientRegistry } = require('../../src/frontdoor/oauth/clients');
const { PendingAuthorizations } = require('../../src/frontdoor/oauth/pending');
const { OAuthServer } = require('../../src/frontdoor/oauth/server');
const { GrantStore, AuthCodes } = require('../../src/frontdoor/oauth/grants');
const { registerGrantRoutes } = require('../../src/frontdoor/oauth/grant-routes');
const { TokenStore } = require('../../src/frontdoor/oauth/tokens');
const { createFleetScopeRegistry } = require('../../src/frontdoor/oauth/scopes');
const { Challenges } = require('../../src/frontdoor/protocol/challenges');
const { rawEd25519 } = require('../../src/frontdoor/protocol/messages');
const { NodeRegistry } = require('../../src/frontdoor/router/node-registry');
const { AlertCenter } = require('../../src/frontdoor/alerts');
const { createFrontDoorHandler } = require('../../src/frontdoor/http');
const { createFakePhone, testNodeIdentity } = require('./fake-phone');
const { approverStoreWith } = require('./approver-set');
const { request, pkce, parseConsent, cookieOf } = require('./oauth-test-client');

const FLEET = ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate'];
const MACHINES = ['gpu-box', 'web-01'];
const UID = process.platform !== 'win32' ? process.getuid() : 0;

// onAudit(entry): called with each audit entry as its append starts, before
// it is recorded (tests that check what was already true at that moment).
async function startFrontDoorHttp({ mcp = null, fetchMetadata = null, clientDefaults = [], scopesEnabled = FLEET, now = Date.now, pendingPerIp = null, machines = MACHINES, onAudit = null } = {}) {
  const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
  const phone = createFakePhone({ seed: 'A', name: 'Owner phone' });
  const second = createFakePhone({ seed: 'C', name: 'Second phone' });
  const store = await approverStoreWith([phone.approverRecord(), second.approverRecord()], { allowTestKeys: true, now });
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  const dir = path.join(dataDir, 'frontdoor', 'oauth');
  fs.mkdirSync(dir, { recursive: true });
  const devices = new DeviceRegistry({ file: path.join(dataDir, 'relay', 'devices.json') });
  for (const p of [phone, second]) devices.register({ device_id: p.deviceId, jwk: p.jwk, name: p.name, platform: 'android' });
  const phoneApi = createPhoneApi({ devices });
  const alerts = new AlertCenter({ file: path.join(dataDir, 'frontdoor', 'alerts.json'), now });
  const audit = [];
  const auditLedger = { append: async (e) => { if (onAudit) onAudit(e); audit.push(e); return e; } };
  const pushes = [];
  // The node registry (Task 19), holding `machines` as console records.
  for (const name of machines) {
    const id = testNodeIdentity({ nodeName: name });
    NodeRegistry.writeConsoleRecord(configDir, {
      node_id: id.nodeId, node_name: name, profile: 'agent', public_key: rawEd25519(id.publicKey),
      tls_fingerprint: crypto.randomBytes(32).toString('hex'), source: 'console', accepted_at: '2026-09-20T00:00:00.000Z'
    }, { frontdoorId: fd.nodeId });
  }
  const registry = new NodeRegistry({ configDir, dataDir, approverStore: store, frontdoorId: fd.nodeId, alerts, adminUid: UID, geteuid: () => UID, now });
  registry.load();
  const scopeRegistry = createFleetScopeRegistry();
  const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), now, ...(fetchMetadata ? { fetchMetadata } : {}) });
  // pendingPerIp: tests that run several flows from 127.0.0.1 raise R23's 3-per-IP cap.
  const pending = new PendingAuthorizations({ now, ...(pendingPerIp ? { perIp: pendingPerIp } : {}) });
  const grants = new GrantStore({ file: path.join(dir, 'grants.json'), approverStore: store, frontdoorId: fd.nodeId, alerts, now });
  grants.load();
  const codes = new AuthCodes({ now });
  // Bound to the grant store: its 'revoked' event drops the grant's tokens,
  // and authenticate()/refresh() ask grants.live() on every call.
  const tokens = new TokenStore({ file: path.join(dir, 'tokens.json'), now, grants });
  const challenges = new Challenges({ now });
  const revokedGrants = [];
  let mcpEndpoint = null;
  // The tokens are dropped by the shared revoke helper on both paths (the
  // token endpoint and the phone route), before this runs.
  const onGrantRevoked = (grantId) => {
    revokedGrants.push(grantId);
    if (mcpEndpoint && typeof mcpEndpoint.endSessionsForGrant === 'function') mcpEndpoint.endSessionsForGrant(grantId);
  };
  const oauth = new OAuthServer({
    domain: 'kl.example.com', clients, pending, scopeRegistry, scopesEnabled, clientDefaults, now,
    tokens, codes, grants, alerts, auditLedger, onGrantRevoked
  });
  registerGrantRoutes(phoneApi, {
    pending, grants, codes, clients, challenges, approverStore: store, frontdoorId: fd.nodeId,
    scopeRules: () => scopeRegistry.rules(scopesEnabled), auditLedger, onGrantRevoked, tokens, nodes: registry, now
  });
  mcpEndpoint = typeof mcp === 'function' ? mcp({ tokens, grants, registry, scopeRegistry, scopesEnabled, oauth }) : mcp;
  const handler = createFrontDoorHandler({ mcpHost: 'mcp.kl.example.com', oauth, mcp: mcpEndpoint, phoneApiHandler: phoneApi.handler });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const phoneCall = async (p, method, pathWithQuery, body = null) => {
    const text = body === null ? '' : JSON.stringify(body);
    const res = await request(base, { method, path: pathWithQuery, headers: { ...p.signApi(method, pathWithQuery, text), ...(body === null ? {} : { 'content-type': 'application/json' }) }, ...(body === null ? {} : { raw: text }) });
    return { status: res.status, body: res.json };
  };

  // The administrator revokes `p`'s approver record in the admin-owned dir.
  const revokeApprover = (p) => {
    const file = path.join(store.dir, `${p.deviceId}.json`);
    fs.writeFileSync(file, JSON.stringify(p.approverRecord({ revokedAt: new Date(now()).toISOString(), revokedBy: 'console' })), { mode: 0o644 });
    store.refresh();
  };

  async function connect({ scopes = null, redirectUri = 'https://client.example.com/cb', clientName = 'Example Client', state = 'xyz', clientId = null, scope = undefined } = {}) {
    let id = clientId;
    if (!id) {
      const reg = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
      id = reg.json.client_id;
    }
    const { verifier, challenge } = pkce();
    const params = { response_type: 'code', client_id: id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', ...(state === null ? {} : { state }), ...(scope === undefined ? {} : { scope }) };
    const consent = await request(base, { path: `/oauth/authorize?${new URLSearchParams(params)}` });
    const { userCode, grantId } = parseConsent(consent.text);
    const lookup = await phoneCall(phone, 'GET', `/v1/grants/pending?user_code=${userCode}`);
    const view = lookup.body;
    const pendingView = { ...view, user_code: userCode.replace('-', '') };
    const signed = phone.grant({ frontdoorId: fd.nodeId, pending: pendingView, scopes: scopes || [...view.preselected].sort().map((s) => ({ scope: s, machines: null })) });
    const decision = await phoneCall(phone, 'POST', `/v1/grants/${grantId}/decision`, signed);
    if (decision.status !== 200) return { decision, grantId, clientId: id, verifier };
    const wait = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) } });
    const location = new URL(wait.headers.location);
    const token = await request(base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirectUri, client_id: id, code_verifier: verifier } });
    return { tokens: token.json, tokenStatus: token.status, clientId: id, grantId, verifier, location, code: location.searchParams.get('code') };
  }

  return {
    base, fd, phone, second, oauth, pending, grants, tokens, codes, clients, alerts, audit, pushes, store, dataDir, registry, revokedGrants, phoneCall, connect, revokeApprover,
    mcp: mcpEndpoint,
    async stop() {
      await new Promise((r) => server.close(r));
      store.cleanup();
    }
  };
}

module.exports = { startFrontDoorHttp, FLEET, MACHINES };
