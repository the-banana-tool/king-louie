// tests/frontdoor-e2e.test.js — fleet stage 4 end to end over TLS: a front
// door on operator certificates, a node that pairs with a phone's approval
// and links with its pin, and an MCP client that connects through OAuth.
// The wiring carries of Task 32 are pinned here too: each `carry N` test
// fails when that piece of wiring is removed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { startFrontDoor, makePinCheck, mirrorFetcher, stopInOrder, DUPLICATE_PING_MS } = require('../src/frontdoor/profile');
const { NodeRegistry } = require('../src/frontdoor/router/node-registry');
const { rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { verifyRepin } = require('../src/frontdoor/protocol/checks');
const { parseFrontDoorConfig } = require('../src/frontdoor/config');
const { StartupError } = require('../src/frontdoor/startup-checks');
const { clientIp, ACCEPT_ADDRESS } = require('../src/frontdoor/http-util');
const { buildNodePair } = require('../src/frontdoor/protocol/messages');
const { verifyPairAccept } = require('../src/frontdoor/protocol/checks');
const { writePin } = require('../src/fleet/front-door-pin');
const { RelayClient } = require('../src/approvals/relay-client');
const { NodeFleetService } = require('../src/fleet/node-fleet-service');
const { AuditLedger } = require('../src/audit/audit-ledger');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { timingSafeHexEqual } = require('../src/mesh/mesh-transport');
const { open } = require('../src/approvals/envelope');
const { fakeHandler, DEFAULT_RUNBOOKS } = require('./helpers/fake-node');
const { createFakePhone } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { createCa, issueCert } = require('./helpers/test-certs');
const { request, pkce, parseConsent, cookieOf } = require('./helpers/oauth-test-client');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const release = holdEventLoop();
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const A = createFakePhone({ seed: 'A', name: 'Owner phone' });
const B = createFakePhone({ seed: 'B', name: 'Not an approver' });
const C = createFakePhone({ seed: 'C', name: 'Second approver' });
const OFF = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const lookup = (host, options, cb) => {
  const done = typeof options === 'function' ? options : cb;
  const opts = typeof options === 'function' ? {} : options || {};
  if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A raw TLS client: writes `text` (never finishing it) and resolves with what
// came back and how long until the server closed, or null after `ms`.
function trickle({ port, servername, text, ca = null, cert = null, key = null, ms = 4000 }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = tls.connect({ host: '127.0.0.1', port, servername, ...(ca ? { ca } : { rejectUnauthorized: false }), ...(cert ? { cert, key } : {}) }, () => s.write(text));
    let reply = '';
    let closedAt = null;
    s.on('data', (d) => { reply += d.toString('utf8'); });
    s.on('close', () => { closedAt = Date.now() - t0; resolve({ reply, closedAt }); });
    s.on('error', () => {});
    setTimeout(() => { if (closedAt === null) { resolve({ reply, closedAt: null }); s.destroy(); } }, ms).unref();
    s.once('error', (e) => { if (closedAt === null && !reply) reject(e); });
  });
}
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
// The steps startFrontDoor stops, in the order it stops them.
const ALL_STEPS = ['SIGHUP handler', 'probe', 'listener', 'http servers', 'client purge', 'router', 'device states', 'courier', 'registry transport watch', 'relay', 'tls', 'audit prune']
  .filter((s) => POSIX || s !== 'SIGHUP handler');

async function layout({ fdRaw = {} } = {}) {
  const store = await approverStoreWith([A.approverRecord()], { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ca = createCa();
  const leaf = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
  const tlsDir = path.join(store.baseDir, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true });
  const certFile = path.join(tlsDir, 'mcp.pem');
  const keyFile = path.join(tlsDir, 'mcp.key');
  fs.writeFileSync(certFile, leaf.cert);
  fs.writeFileSync(keyFile, leaf.key, { mode: 0o600 });
  const nodeConfig = {
    name: 'frontdoor',
    profile: 'frontdoor',
    frontdoor: parseFrontDoorConfig(JSON.parse(JSON.stringify({ domain: 'kl.example.com', tls: { cert_file: certFile, key_file: keyFile }, ...fdRaw })), 'node.yaml')
  };
  const serviceConfig = { profile: 'frontdoor', features: OFF, ports: {}, relayRaw: null, audit: { retentionDays: 365 } };
  const pushes = [];
  const deps = {
    listen: { host: '127.0.0.1', port: 0 }, lookup, probeCa: ca.cert, allowTestKeys: true,
    approverStoreOptions: { geteuid: () => UID, adminUid: UID, platform: 'linux' },
    senders: [{ id: 'recording', platforms: ['apns'], notify: async (device, payload) => { pushes.push({ device: device.device_id, ...payload }); return { ok: true }; } }]
  };
  return { store, configDir, dataDir, ca, certFile, keyFile, nodeConfig, serviceConfig, deps, pushes };
}

const start = (l, over = {}) => startFrontDoor({ dataDir: l.dataDir, configDir: l.configDir, adminUid: UID, geteuid: () => UID, nodeConfig: l.nodeConfig, serviceConfig: l.serviceConfig, deps: l.deps, ...over });

describe('console removals the front door did not see (Task 33 fix round)', () => {
  it('a console record removed while the front door was stopped is audited at the next start; SIGHUP audits one removed by hand', async () => {
    const l = await layout();
    const record = (id, name) => ({
      node_id: id.nodeId, node_name: name, profile: 'runbook', public_key: rawEd25519(id.publicKey),
      tls_fingerprint: id.tlsFingerprint, source: 'console', accepted_at: new Date().toISOString()
    });
    const web = new NodeIdentity({ nodeName: 'web-02' });
    const gpu = new NodeIdentity({ nodeName: 'gpu-box' });
    NodeRegistry.writeConsoleRecord(l.configDir, record(web, 'web-02'));
    NodeRegistry.writeConsoleRecord(l.configDir, record(gpu, 'gpu-box'));
    let fd = await start(l);
    let running = fd;
    cleanups.push(() => running.stop());
    const removals = (nodeId) => new AuditLedger({ dir: path.join(l.dataDir, 'audit'), nodeId }).tail(50)
      .filter((e) => e.kind === 'frontdoor.node.removed').map((e) => e.data);
    assert.deepEqual(removals(fd.identity.nodeId), [], 'the first start only records the set');
    await fd.stop();

    assert.equal(NodeRegistry.removeConsoleRecord(l.configDir, 'web-02'), true); // while stopped
    fd = await start(l);
    running = fd;
    assert.deepEqual(removals(fd.identity.nodeId), [{ node_name: 'web-02', node_id: web.nodeId, by: 'console', noticed: 'start' }]);

    fs.rmSync(path.join(NodeRegistry.consoleDir(l.configDir), `${gpu.nodeId}.json`)); // by hand, then SIGHUP
    await fd.reloadTls();
    assert.deepEqual(removals(fd.identity.nodeId).slice(1), [{ node_name: 'gpu-box', node_id: gpu.nodeId, by: 'console', noticed: 'reload' }]);
    await fd.stop();
  });
});

describe('startFrontDoor refusals', () => {
  it('refuses before binding when a §3.1 check fails', async () => {
    const l = await layout();
    await assert.rejects(start(l, { nodeConfig: { ...l.nodeConfig, profile: 'agent' } }),
      (err) => err instanceof StartupError && err.message === 'profile mismatch: service.json says "frontdoor", node.yaml says "agent"');
  });

  it('carry 1: a frontdoor node.yaml with no frontdoor block is refused by check 2', async () => {
    const l = await layout();
    const nodeConfig = { ...l.nodeConfig, frontdoor: parseFrontDoorConfig(undefined, 'node.yaml') };
    await assert.rejects(start(l, { nodeConfig }), (err) => err instanceof StartupError && err.check === 2 && err.message === 'frontdoor.domain must be a DNS name');
  });

  it('check 5: an occupied port is `cannot bind`, and everything started before it is stopped (carry 12)', async () => {
    const l = await layout();
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => blocker.close(r)));
    const { port } = blocker.address();
    const stopped = [];
    const hups = process.listenerCount('SIGHUP');
    await assert.rejects(start(l, { deps: { ...l.deps, listen: { host: '127.0.0.1', port }, onStop: (n) => stopped.push(n) } }),
      new RegExp(`^Error: cannot bind 127\\.0\\.0\\.1:${port}: `));
    assert.deepEqual(stopped, ALL_STEPS.filter((s) => !['SIGHUP handler', 'probe'].includes(s)));
    assert.equal(process.listenerCount('SIGHUP'), hups);
  });

  it('an enabled scope nothing registers refuses start, and what already ran is stopped (carry 12)', async () => {
    const l = await layout();
    l.nodeConfig.frontdoor.oauth.scopesEnabled = ['fleet:read', 'cases:read'];
    const stopped = [];
    await assert.rejects(start(l, { toolExtensions: [], deps: { ...l.deps, onStop: (n) => stopped.push(n) } }),
      /frontdoor\.oauth\.scopes_enabled lists "cases:read", which nothing registers/);
    assert.deepEqual(stopped, ['router', 'device states', 'courier', 'registry transport watch', 'relay', 'tls', 'audit prune']);
  });

  it('carry 11: without the test-only switch the self-probe refuses a name that resolves to loopback; relay.push in service.json reaches the relay', async () => {
    const l = await layout();
    // fix 8: service.json relay.push → the relay's pusher (no test senders here).
    const apnsKey = path.join(l.store.baseDir, 'apns.p8');
    fs.writeFileSync(apnsKey, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const { senders, ...deps } = l.deps;
    assert.ok(senders);
    const serviceConfig = { ...l.serviceConfig, relayRaw: { push: { apns: { team_id: 'TEAM123456', key_id: 'KEY1234567', key_file: apnsKey, topic: 'com.example.kl', environment: 'sandbox' } } } };
    const fd = await start(l, { deps, serviceConfig });
    cleanups.push(() => fd.stop());
    assert.deepEqual(fd.relay.pusher.senders, ['apns', 'none']);
    const r = await fd.probe.runOnce();
    assert.equal(r.ok, false);
    assert.match(r.mcp.detail, /loopback/);
    assert.match(r.mesh.detail, /loopback/);
  });
});

describe('front-door wiring helpers', () => {
  const PIN = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);

  it('carry 2: the pin check compares against every pin in constant time, and fails closed', () => {
    const calls = [];
    const counting = (a, b) => { calls.push([a, b]); return timingSafeHexEqual(a, b); };
    assert.equal(makePinCheck(() => [PIN, OTHER], counting)(PIN), true);
    assert.equal(calls.length, 2, 'no early exit on the first match');
    assert.equal(makePinCheck(() => [PIN])(OTHER), false);
    // timingSafeHexEqual takes only lowercase hex; a Set lookup would match this.
    assert.equal(makePinCheck(() => [PIN.toUpperCase()])(PIN.toUpperCase()), false);
    assert.equal(makePinCheck(() => { throw new Error('store gone'); })(PIN), false);
    assert.equal(makePinCheck(() => [PIN], () => 'yes')(PIN), false, 'only === true pins');
  });

  it('carry 8: the mirror fetch has its own deadline, so a link RPC that never settles cannot hold the node queue', async () => {
    const seen = [];
    const hub = { rpc: (nodeId, method, params, opts) => { seen.push({ nodeId, method, opts }); return new Promise(() => {}); } };
    await assert.rejects(mirrorFetcher(hub, 'kl-node', 50)({ limit: 1 }), (err) => err.code === 'timeout');
    assert.deepEqual(seen, [{ nodeId: 'kl-node', method: 'audit.slice', opts: { timeoutMs: 50 } }]);
    const ok = { rpc: async () => ({ envelope: { payload: 'x' } }) };
    assert.deepEqual(await mirrorFetcher(ok, 'kl-node', 50)({}), { payload: 'x' });
  });

  it('carry 12: shutdown runs every step in order, past one that throws and one that hangs', async () => {
    const ran = [];
    const t0 = Date.now();
    await stopInOrder([
      { name: 'a', fn: () => { ran.push('a'); throw new Error('boom'); } },
      { name: 'b', fn: () => { ran.push('b'); return new Promise(() => {}); } },
      { name: 'c', fn: async () => { ran.push('c'); } }
    ], { timeoutMs: 100 });
    assert.deepEqual(ran, ['a', 'b', 'c']);
    assert.ok(Date.now() - t0 < 2000);
  });

  it('fix 7: the whole shutdown has a deadline: past it the remaining steps are started, not awaited', async () => {
    const ran = [];
    const t0 = Date.now();
    await stopInOrder([
      { name: 'a', fn: () => { ran.push('a'); return new Promise(() => {}); } },
      { name: 'b', fn: () => { ran.push('b'); return new Promise(() => {}); } },
      { name: 'c', fn: () => { ran.push('c'); return new Promise(() => {}); } },
      { name: 'd', fn: () => { ran.push('d'); } }
    ], { timeoutMs: 1000, totalMs: 300 });
    const took = Date.now() - t0;
    await sleep(10);
    assert.deepEqual(ran, ['a', 'b', 'c', 'd'], 'every step is still started');
    assert.ok(took < 700, `returned by the overall deadline (${took} ms), not after 3 × 1000 ms`);
  });

  it('carry 5: clientIp falls back to the accept-time address, and never reads X-Forwarded-For', () => {
    const gone = { [ACCEPT_ADDRESS]: '203.0.113.9' };
    assert.equal(clientIp({ socket: gone, headers: { 'x-forwarded-for': '198.51.100.1' } }), '203.0.113.9');
    assert.equal(clientIp({ socket: { remoteAddress: '192.0.2.4', [ACCEPT_ADDRESS]: '203.0.113.9' }, headers: {} }), '192.0.2.4');
    assert.equal(clientIp({ socket: {}, headers: { 'x-forwarded-for': '198.51.100.1' } }), 'unknown');
  });
});

describe('a running front door', () => {
  let t;
  before(async () => {
    // progress_hold_s 2 and a 1 s request timeout: a hold longer than the
    // timeout (ruling T26-hold, carry 7) on the real mcp. server.
    const l = await layout({ fdRaw: { mcp: { progress_hold_s: 2 } } });
    // idle > headers: a pipelined request's headers deadline (from the
    // previous response) must fire before the idle limit would.
    l.deps.mcpServerLimits = { requestTimeoutMs: 1000, headersTimeoutMs: 800, idleTimeoutMs: 2500 };
    l.deps.meshServerLimits = { requestTimeoutMs: 1000, headersTimeoutMs: 800, idleTimeoutMs: 1000 };
    l.deps.probeAllowLoopbackForTests = true;
    const fd = await start(l);
    cleanups.push(() => fd.stop());
    const port = fd.address().port;
    const base = `https://mcp.kl.example.com:${port}`;
    const tlsOpts = { ca: l.ca.cert, lookup };
    fd.relay.devices.register({ device_id: A.deviceId, jwk: A.jwk, name: A.name, platform: 'android' });
    fd.relay.devices.setPush(A.deviceId, { platform: 'apns', token: 'owner-push-token' });
    const phoneCall = async (phone, method, p, body = null) => {
      const text = body === null ? '' : JSON.stringify(body);
      const res = await request(base, { method, path: p, tls: tlsOpts, headers: { ...phone.signApi(method, p, text), ...(body === null ? {} : { 'content-type': 'application/json' }) }, ...(body === null ? {} : { raw: text }) });
      return { status: res.status, body: res.json };
    };
    t = { ...l, fd, port, base, tls: tlsOpts, phoneCall };
  });

  it('serves OAuth metadata on mcp. over the operator certificate', async () => {
    const res = await request(t.base, { path: '/.well-known/oauth-authorization-server', tls: t.tls });
    assert.equal(res.status, 200);
    assert.equal(res.json.issuer, 'https://mcp.kl.example.com');
  });

  it('pairs a node the phone approves; the node links with its pin; the mirror catches up; an MCP client runs a runbook', async () => {
    const { fd } = t;
    // 1. The phone asks for a pairing code; the node proves it over /pair/v1.
    const issued = await t.phoneCall(A, 'POST', '/v1/pairing-codes', { node_name: 'gpu-box' });
    assert.equal(issued.status, 200);
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const pairEnv = buildNodePair({ identity: node, frontdoorHost: 'mcp.kl.example.com', code: issued.body.code, profile: 'agent', capabilities: [], tlsCertPem: node.tlsCert });
    const posted = await request(t.base, { method: 'POST', path: '/pair/v1', json: pairEnv, tls: t.tls });
    assert.equal(posted.status, 200);
    const accept = verifyPairAccept(posted.json, { nodeId: node.nodeId, nonce: open(pairEnv).message.nonce });
    assert.equal(accept.ok, true, accept.reason);
    assert.equal(accept.message.mesh_cert_fingerprint, fd.identity.tlsFingerprint);
    assert.equal(accept.message.mesh_url, `wss://mesh.kl.example.com:${t.port}/mesh/v1`);

    // 2. The phone is pushed the pairing (carry 9), approves; the node writes its pin.
    const pending = (await t.phoneCall(A, 'GET', '/v1/pairings/pending')).body;
    assert.equal(pending[0].node_name, 'gpu-box');
    await until(() => t.pushes.some((p) => p.kind === 'pairing' && p.id === pending[0].pairing_id && p.device === A.deviceId), 'the pairing push');
    assert.deepEqual((await t.phoneCall(A, 'POST', `/v1/pairings/${pending[0].pairing_id}/decision`, A.enrollNode({ frontdoorId: fd.identity.nodeId, pairing: pending[0] }))).body, { state: 'enrolled' });
    assert.deepEqual((await request(t.base, { path: `/pair/v1/${pending[0].pairing_id}`, tls: t.tls })).json, { state: 'enrolled' });
    const nodeConfigDir = path.join(t.store.baseDir, 'node-config');
    fs.mkdirSync(nodeConfigDir, { recursive: true, mode: 0o755 });
    const pin = { v: 1, frontdoor_id: accept.frontdoorId, frontdoor_public_key: accept.message.frontdoor_public_key, domain: 'kl.example.com', mesh_url: accept.message.mesh_url, mesh_cert_fingerprint: accept.message.mesh_cert_fingerprint, paired_at: new Date().toISOString() };
    writePin(nodeConfigDir, pin);

    // 3. The node links with that pin and says hello; its audit chain is mirrored.
    const nodeData = path.join(t.store.baseDir, 'node-data');
    fs.mkdirSync(nodeData, { recursive: true });
    const ledger = new AuditLedger({ dir: path.join(nodeData, 'audit'), identity: node, nodeId: node.nodeId });
    await ledger.append({ kind: 'test.event', data: { i: 1 } });
    await ledger.append({ kind: 'test.event', data: { i: 2 } });
    const relayClient = new RelayClient({ identity: node, nodeName: 'gpu-box', frontDoorPin: pin, dataDir: nodeData, dnsLookup: lookup });
    relayClient.onMessage(async (method, params) => (method === 'audit.slice' ? { envelope: ledger.slice(params) } : null));
    // Production order (run.js; final review F-1/M-9): the link is up, its
    // 'connected' already gone by, before the fleet node starts. The node
    // must still say hello.
    cleanups.push(async () => { await relayClient.stop(); });
    await relayClient.start();
    await until(() => relayClient.isConnected() === true, 'the link to come up');
    assert.notEqual((fd.registry.presence(node.nodeId) || {}).online, true, 'linked but not yet said hello');
    const handler = fakeHandler({ name: 'gpu-box', profile: 'agent', runbooks: DEFAULT_RUNBOOKS });
    const service = new NodeFleetService({ handler, relayClient, nodeConfig: { name: 'gpu-box', profile: 'agent', capabilities: [], nodeId: node.nodeId }, version: '0.0.0-test' }).start();
    cleanups.push(async () => { service.stop(); });
    await until(() => (fd.registry.presence(node.nodeId) || {}).online === true, 'the node to say hello');
    await until(() => (fd.mirror.cursor(node.nodeId) || {}).seq === 2, 'the audit mirror');
    await fd.router.whenIdle();

    // 4. An MCP client connects: DCR, typed-code consent approved on the phone, PKCE token.
    const reg = await request(t.base, { method: 'POST', path: '/oauth/register', tls: t.tls, json: { client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
    assert.equal(reg.status, 201);
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'fleet:read fleet:run' });
    const consent = await request(t.base, { path: `/oauth/authorize?${params}`, tls: t.tls });
    const { userCode, grantId } = parseConsent(consent.text);
    // carry 5: through the SNI listener, the per-IP limits see the real peer.
    assert.equal(fd.oauth.pending.get(grantId).ip, '127.0.0.1');
    const view = (await t.phoneCall(A, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    // carry 3: a machine limit resolves against the node registry (nodes: registry).
    const signed = A.grant({ frontdoorId: fd.identity.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: ['gpu-box'] }, { scope: 'fleet:run', machines: null }] });
    assert.deepEqual((await t.phoneCall(A, 'POST', `/v1/grants/${grantId}/decision`, signed)).body, { state: 'approved' });
    const wait = await request(t.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) }, tls: t.tls });
    const code = new URL(wait.headers.location).searchParams.get('code');
    const token = await request(t.base, { method: 'POST', path: '/oauth/token', tls: t.tls, form: { grant_type: 'authorization_code', code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: verifier } });
    assert.equal(token.status, 200);

    // 5. MCP over Streamable HTTP reaches the node through the router.
    const auth = { authorization: `Bearer ${token.json.access_token}`, accept: 'application/json, text/event-stream' };
    const init = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: auth, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } } });
    const session = init.headers['mcp-session-id'];
    const mcpHeaders = { ...auth, 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' };
    const rpc = async (id, name, args) => {
      const res = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: mcpHeaders, json: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
      return JSON.parse(res.json.result.content[0].text);
    };
    const machines = await rpc(2, 'list_machines', {});
    assert.deepEqual(machines.map((m) => [m.name, m.online]), [['gpu-box', true]]);
    const started = await rpc(3, 'run_runbook', { machine: 'gpu-box', runbook: 'site.status' });
    assert.deepEqual(started, { job_id: 'gpu-box:job-1', status: 'queued' });
    const job = await rpc(4, 'get_job', { job_id: 'gpu-box:job-1' });
    assert.equal(job.output.untrusted_output, true);
    assert.equal((await rpc(5, 'run_runbook', { machine: 'gpu-box', runbook: 'site.restart' })).error, 'insufficient_scope');
    Object.assign(t, { node, grantId, mcpHeaders, rpc, handler, relayClient });
  });

  it('carry 7: a get_job long-poll held longer than the request timeout still answers; a slow request body is still cut', async () => {
    const t0 = Date.now();
    const res = await request(t.base, {
      method: 'POST', path: '/mcp', tls: t.tls, headers: t.mcpHeaders,
      json: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'gpu-box:job-1' }, _meta: { progressToken: 'p-10' } } }
    });
    const held = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const last = JSON.parse(res.text.trim().split('\n').filter((line) => line.startsWith('data: ')).pop().slice(6));
    assert.equal(last.id, 10);
    assert.equal(JSON.parse(last.result.content[0].text).status, 'queued');
    assert.ok(held >= 1900, `held for the whole 2 s hold (${held} ms), past the 1 s request timeout`);

    // The same server still enforces its request timeout on a body that
    // trickles (/pair/v1 reads its body before anything else).
    const reply = await new Promise((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: t.port, servername: 'mcp.kl.example.com', ca: t.ca.cert }, () => {
        s.write('POST /pair/v1 HTTP/1.1\r\nHost: mcp.kl.example.com\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{');
      });
      let text = '';
      s.on('data', (d) => { text += d.toString('utf8'); });
      s.on('close', () => resolve(text));
      s.on('error', reject);
      setTimeout(() => s.destroy(), 5000).unref();
    });
    assert.match(reply, /^HTTP\/1\.1 408/);
  });

  it('fix 2: a client that trickles its headers is cut on mcp. and on mesh.; an idle keep-alive connection is closed', async () => {
    const mcpSlow = await trickle({ port: t.port, servername: 'mcp.kl.example.com', ca: t.ca.cert, text: 'GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: mcp.kl.example.com\r\n' });
    assert.match(mcpSlow.reply, /^HTTP\/1\.1 408/);
    assert.ok(mcpSlow.closedAt !== null && mcpSlow.closedAt < 3500, `closed after ${mcpSlow.closedAt} ms`);
    const meshSlow = await trickle({ port: t.port, servername: 'mesh.kl.example.com', cert: t.node.tlsCert, key: t.node.tlsKey, text: 'GET /mesh/v1 HTTP/1.1\r\nHost: mesh.kl.example.com\r\n' });
    assert.match(meshSlow.reply, /^HTTP\/1\.1 408/);
    assert.ok(meshSlow.closedAt !== null && meshSlow.closedAt < 3500, `closed after ${meshSlow.closedAt} ms`);
    // A whole request is answered; then the connection, idle, is closed well
    // before Node's own 5 s keep-alive would.
    const idle = await trickle({ port: t.port, servername: 'mcp.kl.example.com', ca: t.ca.cert, text: 'GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: mcp.kl.example.com\r\n\r\n' });
    assert.match(idle.reply, /^HTTP\/1\.1 200/);
    assert.ok(idle.closedAt !== null && idle.closedAt < 3500, `closed after ${idle.closedAt} ms`);
    assert.ok(!/408/.test(idle.reply), 'closed as idle, not cut as a slow request');
  });

  it('round 2: an Upgrade request on mcp. is closed at once, never exempt from the deadlines', async () => {
    const r = await trickle({
      port: t.port, servername: 'mcp.kl.example.com', ca: t.ca.cert,
      text: 'GET /mcp HTTP/1.1\r\nHost: mcp.kl.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
    });
    assert.ok(r.closedAt !== null && r.closedAt < 500, `closed after ${r.closedAt} ms`);
    assert.equal(r.reply, '');
  });

  it('round 2: a pipelined request\'s headers deadline starts when the previous response finishes', async () => {
    const first = 'GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: mcp.kl.example.com\r\n\r\n';
    const second = 'GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: mcp.kl.example.com\r\n'; // never finished
    const r = await new Promise((resolve) => {
      let answeredAt = null;
      let reply = '';
      const s = tls.connect({ host: '127.0.0.1', port: t.port, servername: 'mcp.kl.example.com', ca: t.ca.cert }, () => s.write(first + second));
      s.on('data', (d) => { reply += d.toString('utf8'); if (answeredAt === null) answeredAt = Date.now(); });
      s.on('error', () => {});
      s.on('close', () => resolve({ reply, afterAnswer: answeredAt === null ? null : Date.now() - answeredAt }));
      setTimeout(() => s.destroy(), 6000).unref();
    });
    assert.match(r.reply, /^HTTP\/1\.1 200/);
    assert.ok(r.afterAnswer !== null && r.afterAnswer < 1800, `closed ${r.afterAnswer} ms after the first answer (headers 0.8 s, idle 2.5 s)`);
  });

  it('fix 2: the node\'s upgraded mesh link outlives the mesh server\'s timers', async () => {
    const transport = t.fd.relay.nodeHub.transport;
    const before = transport.getPeer(t.node.peerId);
    assert.ok(before && before.ws, 'the node is linked');
    await sleep(2500); // past the mesh headers (0.8 s), request (1 s) and idle (1 s) limits
    const after = transport.getPeer(t.node.peerId);
    assert.equal(after && after.ws, before.ws, 'the same WebSocket, never cut and re-dialled');
    assert.equal(before.ws.readyState, 1);
  });

  it('fix 8: an unpinned certificate on mesh. raises unknown_node_key; the self-probe\'s certificate does not', async () => {
    const stranger = new NodeIdentity({ nodeName: 'stranger' });
    const count = () => {
      const a = t.fd.alerts.unacked('unknown_node_key')[0];
      return a ? a.detail.count : 0;
    };
    const dial = (cert, key) => trickle({ port: t.port, servername: 'mesh.kl.example.com', cert, key, text: '', ms: 3000 });
    await dial(stranger.tlsCert, stranger.tlsKey);
    assert.equal(count(), 1);
    assert.equal(t.fd.alerts.unacked('unknown_node_key')[0].detail.top[0].fingerprint, stranger.tlsFingerprint);
    const probed = await dial(t.fd.probe.probeCert.cert, t.fd.probe.probeCert.key);
    assert.ok(probed.closedAt !== null, 'the probe connection is ended after the handshake');
    assert.equal(count(), 1, 'the probe is not an unknown node');
  });

  it('carry 10: POST /v1/pairing-codes is the front door\'s route: a phone active on a node but not a front-door approver gets 403', async () => {
    t.fd.relay.devices.register({ device_id: B.deviceId, jwk: B.jwk, name: B.name, platform: 'android' });
    t.fd.relay.devices.setNodeState(B.deviceId, t.node.nodeId, 'active');
    const r = await t.phoneCall(B, 'POST', '/v1/pairing-codes', { node_name: 'web-01' });
    assert.equal(r.status, 403);
    assert.deepEqual([r.body.error, r.body.message], ['forbidden', 'this phone is not an approver on this front door']);
  });

  it('carry 9: an alert is pushed to the front door\'s approvers', async () => {
    const alert = t.fd.alerts.raise('dns_probe_failed', { subject: 'e2e' });
    await until(() => t.pushes.some((p) => p.kind === 'alert' && p.id === alert.id && p.device === A.deviceId), 'the alert push');
    assert.ok(!t.pushes.some((p) => p.device === B.deviceId), 'a phone that is not an approver is never pushed');
  });

  it('carry 4: mesh. never resumes a TLS session: every node connection is a full handshake with its certificate', async () => {
    const connect = (session) => new Promise((resolve, reject) => {
      let got = null;
      const s = tls.connect({ host: '127.0.0.1', port: t.port, servername: 'mesh.kl.example.com', cert: t.node.tlsCert, key: t.node.tlsKey, rejectUnauthorized: false, ...(session ? { session } : {}) });
      s.on('session', (x) => { got = x; });
      s.once('secureConnect', () => setTimeout(() => { const reused = s.isSessionReused(); s.destroy(); resolve({ session: got, reused }); }, 100));
      s.once('error', reject);
    });
    const first = await connect(null);
    assert.ok(first.session, 'the client was offered something to resume with');
    const second = await connect(first.session);
    assert.equal(second.reused, false);
  });

  it('carry 3: the mesh transport runs, pings a duplicate link for 5 s, and a flapping link raises node_link_flapping', () => {
    const transport = t.fd.relay.nodeHub.transport;
    assert.equal(transport.duplicatePingMs, DUPLICATE_PING_MS);
    assert.equal(DUPLICATE_PING_MS, 5000);
    assert.equal(transport.running, true);
    assert.equal(transport.requireClientCert, true);
    transport.emit('peerTakeover', { peerId: t.node.peerId, count: 3, windowMs: 600000, flapping: true });
    assert.deepEqual(t.fd.alerts.unacked('node_link_flapping').map((a) => a.subject), [`node:${t.node.nodeId}`]);
  });

  it('carry 11: the self-probe reaches both names and pins the certificate mcp. serves now, also after a reload', async () => {
    const r = await t.fd.probe.runOnce();
    assert.equal(r.ok, true, JSON.stringify(r));
    // The operator replaces the certificate and key; SIGHUP reloads them.
    const before = t.fd.relay.phoneSpki;
    const leaf = issueCert(t.ca, { dnsNames: ['mcp.kl.example.com'] });
    fs.writeFileSync(t.certFile, leaf.cert);
    fs.writeFileSync(t.keyFile, leaf.key, { mode: 0o600 });
    await t.fd.reloadTls();
    assert.notEqual(t.fd.relay.phoneSpki, before, 'the relay pin follows the new key');
    const link = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'approvals', 'link.json'), 'utf8'));
    assert.equal(link.relay_spki, t.fd.relay.phoneSpki);
    // Read at every run: a fingerprint captured at start no longer matches.
    const again = await t.fd.probe.runOnce();
    assert.equal(again.ok, true, JSON.stringify(again));
  });

  it('answers the admin CLI\'s courier RPCs', async () => {
    const status = await t.fd.adminRpc('frontdoor.status');
    assert.deepEqual([status.frontdoor_id, status.domain, status.phones], [t.fd.identity.nodeId, 'kl.example.com', 1]);
    assert.deepEqual((await t.fd.adminRpc('frontdoor.nodes')).map((n) => [n.node_name, n.online]), [['gpu-box', true]]);
    await assert.rejects(t.fd.adminRpc('frontdoor.bogus'), (err) => err.code === 'unknown_method');
  });

  it('fix 4: refresh-token reuse revokes the grant and ends an in-flight MCP long-poll at once', async () => {
    const reg = await request(t.base, { method: 'POST', path: '/oauth/register', tls: t.tls, json: { client_name: 'Second Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
    const clientId = reg.json.client_id;
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's2', scope: 'fleet:read' });
    const consent = await request(t.base, { path: `/oauth/authorize?${params}`, tls: t.tls });
    const { userCode, grantId } = parseConsent(consent.text);
    const view = (await t.phoneCall(A, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    const signed = A.grant({ frontdoorId: t.fd.identity.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal((await t.phoneCall(A, 'POST', `/v1/grants/${grantId}/decision`, signed)).status, 200);
    const wait = await request(t.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) }, tls: t.tls });
    const code = new URL(wait.headers.location).searchParams.get('code');
    const token = (await request(t.base, { method: 'POST', path: '/oauth/token', tls: t.tls, form: { grant_type: 'authorization_code', code, redirect_uri: 'https://client.example.com/cb', client_id: clientId, code_verifier: verifier } })).json;
    const auth = { authorization: `Bearer ${token.access_token}`, accept: 'application/json, text/event-stream' };
    const init = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: auth, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-2', version: '1' } } } });
    const headers = { ...auth, 'mcp-session-id': init.headers['mcp-session-id'], 'mcp-protocol-version': '2025-11-25' };
    // A long-poll on a job still queued (held for up to the 2 s hold).
    const t0 = Date.now();
    const poll = request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers, json: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'gpu-box:job-1' }, _meta: { progressToken: 'p-30' } } } })
      .then((res) => ({ res, at: Date.now() - t0 }));
    await sleep(300);
    const refresh = (rt) => request(t.base, { method: 'POST', path: '/oauth/token', tls: t.tls, form: { grant_type: 'refresh_token', refresh_token: rt, client_id: clientId } });
    assert.equal((await refresh(token.refresh_token)).status, 200); // rotation
    assert.equal((await refresh(token.refresh_token)).status, 200); // the one grace
    const reused = await refresh(token.refresh_token); // reuse: theft
    assert.equal(reused.status, 400);
    const { res, at } = await poll;
    const last = JSON.parse(res.text.trim().split('\n').filter((line) => line.startsWith('data: ')).pop().slice(6));
    assert.equal(last.error && last.error.code, -32001, 'the long-poll ends with the session');
    assert.ok(at < 1500, `ended by the revocation (${at} ms), not by the 2 s hold`);
    assert.equal(t.fd.mcp.sessionCount(grantId), 0);
  });

  it('fix 3: SIGHUP re-reads console node records and approvers', async () => {
    const { fd } = t;
    // A console record is picked up by the reload, and its pin with it.
    const web = new NodeIdentity({ nodeName: 'web-02' });
    NodeRegistry.writeConsoleRecord(t.configDir, {
      node_id: web.nodeId, node_name: 'web-02', profile: 'runbook', public_key: rawEd25519(web.publicKey),
      tls_fingerprint: web.tlsFingerprint, source: 'console', accepted_at: new Date().toISOString()
    }, { frontdoorId: fd.identity.nodeId });
    await fd.reloadTls();
    assert.ok(fd.registry.pinnedCertSet().has(web.tlsFingerprint));
    // ... and a removal at the console drops it: the pin set shrinks.
    const pinsBefore = fd.registry.pinnedCertSet().size;
    assert.equal(NodeRegistry.removeConsoleRecord(t.configDir, 'web-02'), true);
    await fd.reloadTls();
    assert.equal(fd.registry.pinnedCertSet().size, pinsBefore - 1);
    assert.ok(!fd.registry.pinnedCertSet().has(web.tlsFingerprint));

    // An approver added, then revoked, at the console.
    const file = path.join(t.store.dir, `${C.deviceId}.json`);
    fs.writeFileSync(file, JSON.stringify(C.approverRecord()), { mode: 0o644 });
    await fd.reloadTls();
    fd.relay.devices.register({ device_id: C.deviceId, jwk: C.jwk, name: C.name, platform: 'android' });
    assert.equal((await t.phoneCall(C, 'POST', '/v1/pairing-codes', { node_name: 'web-03' })).status, 200);
    // Revoked, and re-read at once (inside the store's one-second cache).
    fs.writeFileSync(file, JSON.stringify(C.approverRecord({ revokedAt: new Date().toISOString(), revokedBy: 'console' })), { mode: 0o644 });
    await fd.reloadTls();
    const refused = await t.phoneCall(C, 'POST', '/v1/pairing-codes', { node_name: 'web-03' });
    assert.equal(refused.status, 403);
  });

  it('fix 8: frontdoor.reload with a removed node name audits frontdoor.node.removed (and only a valid name)', async () => {
    const ledger = new AuditLedger({ dir: path.join(t.dataDir, 'audit'), nodeId: t.fd.identity.nodeId });
    const removals = () => ledger.tail(50).filter((e) => e.kind === 'frontdoor.node.removed').map((e) => e.data);
    const before = removals().length;
    await t.fd.adminRpc('frontdoor.reload', { removed: 'web-01' });
    await t.fd.adminRpc('frontdoor.reload', { removed: '../not a name' });
    assert.deepEqual(removals().slice(before), [{ node_name: 'web-01', by: 'console' }]);
  });

  it('carry 6: revoking the client from the phone ends its MCP session and its tokens', async () => {
    const { challenge } = (await t.phoneCall(A, 'POST', '/v1/challenges', { purpose: 'revoke' })).body;
    const r = await t.phoneCall(A, 'POST', `/v1/clients/${t.grantId}/revoke`, A.revokeClient({ frontdoorId: t.fd.identity.nodeId, grantId: t.grantId, challenge }));
    assert.equal(r.status, 204);
    assert.equal(t.fd.mcp.sessionCount(t.grantId), 0);
    const res = await request(t.base, { method: 'POST', path: '/mcp', tls: t.tls, headers: t.mcpHeaders, json: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'list_machines', arguments: {} } } });
    assert.equal(res.status, 401);
  });

  it('writes link.json for the front door itself, so F3 enroll-device can run against it', () => {
    const link = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'approvals', 'link.json'), 'utf8'));
    assert.deepEqual([link.connected, link.relay_id, link.relay_public_url], [true, t.fd.identity.nodeId, 'https://mcp.kl.example.com']);
    assert.match(link.relay_spki, /^sha256\//);
  });

  it('stop() stops everything and unhooks the registry from the transport; a second stop() is a no-op', async () => {
    const transport = t.fd.relay.nodeHub.transport;
    await t.fd.stop();
    assert.equal(transport.running, false);
    assert.equal(transport.listenerCount('peerTakeover'), 0);
    await t.fd.stop();
  });
});

describe('an ACME front door re-pins across a failed save and a restart (fix 6)', () => {
  it('a rotation whose repin.json save fails is published again at the next start and served at /v1/repin', async () => {
    const DAY = 86400000;
    const l = await layout({ fdRaw: { tls: undefined, acme: { terms_agreed: true, directory: 'https://acme.example.com/directory' } } });
    l.deps.acmeAdapterFactory = () => ({
      async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
        onChallenge(commonName, { key: keyPem, cert: issueCert(l.ca, { dnsNames: [commonName], keyPem }).cert });
        onChallengeDone(commonName);
        const now = Date.now();
        return issueCert(l.ca, { dnsNames: [commonName], keyPem, notBefore: now - 60000, notAfter: now + 90 * DAY }).cert + l.ca.cert;
      }
    });
    const repinFile = path.join(l.dataDir, 'frontdoor', 'repin.json');
    const nextKey = path.join(l.dataDir, 'frontdoor', 'acme', 'cert-key.next.json');
    const first = await start(l);
    cleanups.push(() => first.stop());
    const oldSpki = first.tls.leafSpki();
    assert.match(oldSpki, /^sha256\//);
    fs.mkdirSync(repinFile, { recursive: true }); // saving repin.json now fails
    const event = await first.adminRpc('frontdoor.rotate_tls_key');
    assert.equal(event.oldSpki, oldSpki);
    assert.ok(fs.existsSync(nextKey), 'kept until the re-pin is saved');
    await first.stop();

    fs.rmSync(repinFile, { recursive: true, force: true });
    const second = await start(l);
    cleanups.push(() => second.stop());
    assert.equal(second.tls.leafSpki(), event.newSpki);
    const res = await request(`https://mcp.kl.example.com:${second.address().port}`, { path: '/v1/repin', tls: { ca: l.ca.cert, lookup } });
    assert.equal(res.status, 200);
    const v = verifyRepin(res.json, { frontdoorId: second.identity.nodeId, frontdoorPublicKey: rawEd25519(second.identity.publicKey), receivedSpki: event.newSpki, currentPin: oldSpki });
    assert.equal(v.ok, true, v.reason);
    assert.ok(!fs.existsSync(nextKey), 'removed once the re-pin is saved');
    assert.ok(fs.statSync(repinFile).isFile());
  });
});
