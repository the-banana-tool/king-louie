// tests/gui-relay-extension.test.js
//
// The relay side of leases (spec §4.7) against F3's real Mailbox and route
// shapes, with the node hub and the device registry faked the way
// tests/contact-mobile.test.js does for questions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/approvals/envelope');
const { Mailbox } = require('../src/frontdoor/mailbox');
const { registerLeaseRoutes, LEASE_TTL_MS } = require('../src/gui/relay-extension');
const L = require('../src/gui/lease-protocol');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const extensions = require('../src/frontdoor/extensions');

const node = testNodeIdentity({ key: 'gpu-box' });
const NODE = node.nodeId;

function relay({ offline = false, nodesForDevice = null } = {}) {
  const routes = new Map();
  const rpcs = [];
  const phoneApi = { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) };
  const nodeHub = {
    rpc: async (nodeId, method, params, opts) => {
      rpcs.push({ nodeId, method, params, opts });
      if (offline) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      return { state: 'active' };
    }
  };
  let now = Date.parse('2026-09-23T18:00:00.000Z');
  const mailbox = new Mailbox({ now: () => now });
  const devices = { nodesForDevice: nodesForDevice || (() => [{ node_id: NODE, state: 'active' }]) };
  registerLeaseRoutes({ phoneApi, nodeHub, mailbox, devices, log: { warn() {}, debug() {}, info() {} } });
  return { routes, rpcs, mailbox, advance: (ms) => { now += ms; } };
}

function request() {
  return L.buildLeaseRequest({
    identity: node, nodeName: 'gpu-box', jobId: 'job-1', apps: [{ id: 'calculator', name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: [] }],
    maxMinutes: 15, reason: 'Enter the totals', origin: { client: 'claude.ai', session: null, job_id: 'job-1' }, now: Date.parse('2026-09-23T18:00:00.000Z')
  });
}

const call = (r, key, phone, { params = {}, query = {}, body = null } = {}) => r.routes.get(key).handler({}, { deviceId: phone.deviceId, params, query, body });

describe('lease routes', () => {
  it('is mounted in F3\'s extension list and registers the routes with the kl.lease. prefix', () => {
    assert.ok(extensions.includes(registerLeaseRoutes));
    const r = relay();
    assert.deepEqual([...r.routes.keys()], [
      'GET /v1/leases', 'POST /v1/leases/{lease_id}/grant', 'POST /v1/leases/{lease_id}/revoke', 'POST /v1/leases/{lease_id}/watch', 'GET /v1/leases/{lease_id}/views'
    ]);
    for (const spec of r.routes.values()) assert.equal(spec.auth, 'device');
    assert.deepEqual(r.mailbox.types.get('kl.lease.'), { ttlMs: LEASE_TTL_MS, maxBytes: 262144 });
  });

  it('lists pending requests for the device\'s nodes with each lease\'s latest status', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message, envelope } = request();
    r.mailbox.put(NODE, envelope);
    let listed = await call(r, 'GET /v1/leases', phone);
    assert.deepEqual(listed.body, [{ node_id: NODE, envelope, status: null }]);
    const status1 = L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 1, state: 'pending' });
    const status2 = L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 2, state: 'active', expiresAt: Date.now() });
    r.mailbox.put(NODE, status1);
    r.mailbox.put(NODE, status2);
    listed = await call(r, 'GET /v1/leases', phone);
    assert.deepEqual(listed.body[0].status, status2);
    const stranger = await r.routes.get('GET /v1/leases').handler({}, { deviceId: 'd-otherotherother', params: {}, query: {} });
    assert.equal(stranger.body.length, 1, 'the fake registry lists the node for every device');
    const none = relay({ nodesForDevice: () => [{ node_id: NODE, state: 'revoked' }] });
    none.mailbox.put(NODE, envelope);
    assert.deepEqual((await call(none, 'GET /v1/leases', phone)).body, []);
  });

  // R-F5-18: the one device-signed request a phone makes for pending
  // requests also lists what is running, on each node's own signature.
  describe('R-F5-18: GET /v1/leases lists the leases that are running, as each node signs them', () => {
    function relayWith(rpc, nodes = [{ node_id: NODE, state: 'active' }]) {
      const routes = new Map();
      const rpcs = [];
      const mailbox = new Mailbox();
      registerLeaseRoutes({
        phoneApi: { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) },
        nodeHub: { rpc: async (nodeId, method, params, opts) => { rpcs.push({ nodeId, method, params, opts }); return rpc(nodeId, method, params); } },
        mailbox, devices: { nodesForDevice: () => nodes }, log: { warn() {}, debug() {}, info() {} }
      });
      return { routes, rpcs, mailbox };
    }
    const status = (identity, state, seq = 5) => L.buildLeaseStatus({ identity, leaseId: request().message.lease_id, seq, state, grantedBy: { deviceId: 'd-abcdefghjkmnpqrs', name: 'Owner phone' } });

    it('asks each of the device\'s nodes with the device\'s id, and appends what they sign, with no request envelope', async () => {
      const phone = createFakePhone();
      const live = status(node, 'active');
      const ended = status(node, 'ended', 6);
      const r = relayWith(() => ({ statuses: [live, ended] }));
      const { envelope } = request();
      r.mailbox.put(NODE, envelope);
      const listed = await call(r, 'GET /v1/leases', phone);
      assert.deepEqual(listed.body, [
        { node_id: NODE, envelope, status: null },
        { node_id: NODE, envelope: null, status: live },
        { node_id: NODE, envelope: null, status: ended }
      ]);
      assert.deepEqual(r.rpcs, [{ nodeId: NODE, method: 'lease.list', params: { device_id: phone.deviceId }, opts: { timeoutMs: 5000 } }]);
      assert.equal(r.routes.get('GET /v1/leases').auth, 'device', 'one device-signed request; there is no unsigned listing');
      assert.ok(![...r.routes.keys()].some((k) => /live|running/.test(k)), 'no route of its own');
    });

    it('a node that is offline, slow, older, or answers nonsense lists nothing; the pending requests still come', async () => {
      const phone = createFakePhone();
      const { envelope } = request();
      for (const rpc of [
        () => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); },
        () => { throw Object.assign(new Error('no handler for lease.list'), { code: 'unknown_method' }); },
        () => null, () => ({ state: 'active' }), () => ({ statuses: 'x' }), () => ({ statuses: [{ not: 'an envelope' }, null, 7] })
      ]) {
        const r = relayWith(rpc);
        r.mailbox.put(NODE, envelope);
        assert.deepEqual((await call(r, 'GET /v1/leases', phone)).body, [{ node_id: NODE, envelope, status: null }]);
      }
    });

    it('only statuses, only of the node that was asked, and only from the device\'s active nodes', async () => {
      const phone = createFakePhone();
      const other = testNodeIdentity({ key: 'web-01' });
      const view = L.buildLeaseView({
        identity: node, leaseId: request().message.lease_id, seq: 9, toDevice: phone.deviceId, state: 'active', locked: false, remainingS: 60,
        foreground: { app_id: null, matches: false }, frame: null, frameDropped: false, actions: []
      });
      const r = relayWith(() => ({ statuses: [status(other, 'active'), view, request().envelope, status(node, 'suspended')] }));
      const listed = (await call(r, 'GET /v1/leases', phone)).body;
      assert.equal(listed.length, 1, 'another node\'s status, a view and a request are dropped');
      assert.equal(open(listed[0].status).message.state, 'suspended');
      // A node revoked for this device is not asked at all.
      const none = relayWith(() => ({ statuses: [status(node, 'active')] }), [{ node_id: NODE, state: 'revoked' }]);
      assert.deepEqual((await call(none, 'GET /v1/leases', phone)).body, []);
      assert.deepEqual(none.rpcs, []);
      // At most eight statuses from one node.
      const many = relayWith(() => ({ statuses: Array.from({ length: 20 }, (_, i) => status(node, 'ended', i + 1)) }));
      assert.equal((await call(many, 'GET /v1/leases', phone)).body.length, 8);
    });
  });

  it('long-polls with wait', async () => {
    const r = relay();
    const phone = createFakePhone();
    const polling = call(r, 'GET /v1/leases', phone, { query: { wait: '5' } });
    setTimeout(() => r.mailbox.put(NODE, request().envelope), 50);
    assert.equal((await polling).body.length, 1);
  });

  for (const action of ['grant', 'revoke', 'watch']) {
    it(`POST ${action} forwards the phone envelope unchanged to lease.${action}`, async () => {
      const r = relay();
      const phone = createFakePhone();
      const { message, envelope } = request();
      const body = action === 'grant' ? phone.leaseGrant(envelope) : action === 'revoke' ? phone.leaseRevoke(NODE, message.lease_id) : phone.leaseWatch(NODE, message.lease_id);
      const sent = JSON.parse(JSON.stringify(body));
      const out = await call(r, `POST /v1/leases/{lease_id}/${action}`, phone, { params: { lease_id: message.lease_id }, body });
      // Only the watch reply carries the mailbox position (R-F5-6); the mailbox is empty here.
      assert.deepEqual(out, { status: 202, body: action === 'watch' ? { state: 'active', after_seq: 0 } : { state: 'active' } });
      assert.deepEqual(r.rpcs, [{ nodeId: NODE, method: `lease.${action}`, params: { envelope: sent }, opts: { timeoutMs: 10000 } }]);
    });
  }

  it('R-F5-6: the watch reply carries the mailbox position, and a views fetch from it waits for the frame', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message } = request();
    // What a granted lease has already left in the mailbox: its statuses.
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 1, state: 'pending' }));
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 2, state: 'active' }));
    const route = 'GET /v1/leases/{lease_id}/views';
    // From 0, `wait` returns at once with the old statuses and no frame.
    const early = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: '0', wait: '5' } });
    assert.equal(early.body.length, 2);
    assert.ok(early.body.every((e) => open(e.envelope).message.type === 'kl.lease.status'));

    const watched = await call(r, 'POST /v1/leases/{lease_id}/watch', phone, { params: { lease_id: message.lease_id }, body: phone.leaseWatch(NODE, message.lease_id) });
    assert.deepEqual(watched, { status: 202, body: { state: 'active', after_seq: 2 } });

    const polling = call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(watched.body.after_seq), wait: '5' } });
    const frame = { mime: 'image/jpeg', width: 2, height: 2, sha256: 'A'.repeat(43), data: 'AA==' };
    const view = L.buildLeaseView({
      identity: node, leaseId: message.lease_id, seq: 3, toDevice: phone.deviceId, state: 'active', locked: false, remainingS: 60,
      foreground: { app_id: 'calculator', matches: true }, frame, frameDropped: false, actions: []
    });
    setTimeout(() => r.mailbox.put(NODE, view, { to_device: phone.deviceId }), 50);
    const got = await polling;
    assert.equal(got.body.length, 1);
    assert.equal(open(got.body[0].envelope).message.type, 'kl.lease.view');
  });

  it('a node cannot set after_seq itself', async () => {
    const routes = new Map();
    const mailbox = new Mailbox();
    registerLeaseRoutes({
      phoneApi: { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) },
      nodeHub: { rpc: async () => ({ state: 'active', status: L.buildLeaseStatus({ identity: node, leaseId: request().message.lease_id, seq: 4, state: 'active' }), after_seq: 999999 }) },
      mailbox, devices: { nodesForDevice: () => [{ node_id: NODE, state: 'active' }] }, log: { warn() {}, debug() {}, info() {} }
    });
    const phone = createFakePhone();
    const { message } = request();
    const out = await routes.get('POST /v1/leases/{lease_id}/watch').handler({}, { deviceId: phone.deviceId, params: { lease_id: message.lease_id }, query: {}, body: phone.leaseWatch(NODE, message.lease_id) });
    assert.equal(out.body.after_seq, 0);
    // The status the node signed for its answer reaches the phone as the node sent it (R-F5-15).
    assert.equal(out.body.state, 'active');
    assert.match(open(out.body.status).message.contact_token, /^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses a body signed for another device, another lease, the wrong type, or a node it cannot reach', async () => {
    const r = relay();
    const phone = createFakePhone();
    const { message, envelope } = request();
    const grant = phone.leaseGrant(envelope);
    const route = 'POST /v1/leases/{lease_id}/grant';
    await assert.rejects(r.routes.get(route).handler({}, { deviceId: 'd-otherotherother', params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 403);
    await assert.rejects(call(r, route, phone, { params: { lease_id: '00000000-0000-4000-8000-000000000000' }, body: grant }), (e) => e.status === 400);
    await assert.rejects(call(r, route, phone, { params: { lease_id: message.lease_id }, body: phone.leaseWatch(NODE, message.lease_id) }), (e) => e.status === 400);
    await assert.rejects(call(r, route, phone, { params: { lease_id: message.lease_id }, body: { not: 'an envelope' } }), (e) => e.status === 400);
    const elsewhere = relay({ nodesForDevice: () => [] });
    await assert.rejects(call(elsewhere, route, phone, { params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 404);
    assert.equal(r.rpcs.length, 0);
    const offline = relay({ offline: true });
    await assert.rejects(call(offline, route, phone, { params: { lease_id: message.lease_id }, body: grant }), (e) => e.status === 503 && e.code === 'node_offline');
  });

  it('views: only those for the caller, with statuses, after after_seq, long-polled', async () => {
    const r = relay();
    const phone = createFakePhone();
    const otherPhone = createFakePhone();
    const { message } = request();
    const mkView = (to, seq) => L.buildLeaseView({
      identity: node, leaseId: message.lease_id, seq, toDevice: to, state: 'active', locked: false, remainingS: 60,
      foreground: { app_id: 'calculator', matches: true }, frame: null, frameDropped: false, actions: []
    });
    r.mailbox.put(NODE, mkView(phone.deviceId, 1), { to_device: phone.deviceId });
    r.mailbox.put(NODE, mkView(otherPhone.deviceId, 2), { to_device: otherPhone.deviceId });
    r.mailbox.put(NODE, L.buildLeaseStatus({ identity: node, leaseId: message.lease_id, seq: 3, state: 'active' }));
    const route = 'GET /v1/leases/{lease_id}/views';
    const got = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: '0' } });
    assert.equal(got.body.length, 2);
    assert.ok(got.body.every((e) => Number.isInteger(e.seq)));
    const after = await call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(got.body[1].seq) } });
    assert.deepEqual(after.body, []);
    const polling = call(r, route, phone, { params: { lease_id: message.lease_id }, query: { after_seq: String(got.body[1].seq), wait: '5' } });
    setTimeout(() => r.mailbox.put(NODE, mkView(phone.deviceId, 4), { to_device: phone.deviceId }), 50);
    assert.equal((await polling).body.length, 1);
  });
});
