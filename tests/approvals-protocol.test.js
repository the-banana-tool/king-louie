// tests/approvals-protocol.test.js
//
// Runs every approval-v1 vector whose consumers include `node` through the
// production code, checks the phone vectors against the reference rules, and
// checks the committed files are exactly what generate.js produces.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { canonicalize } = require('../src/platform/jcs');
const { open, deviceIdFromJwk, deriveDeviceId, fingerprintGroups, fromB64url, verifyEs256 } = require('../src/approvals/envelope');
const { phoneAuthString } = require('../src/approvals/messages');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { verifyAuditSlice } = require('../src/audit/audit-ledger');
const { setLogLevel } = require('../src/logging');
const { testNodeIdentity, createFakePhone, KEYS } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/approval-v1/generate');
const { phoneView } = require('./vectors/approval-v1/phone-reference');

// These vectors deliberately construct known-bad approver files (test-key,
// demo-device) and a store that refuses to trust its own directory; the
// resulting `log.error('ignoring approver file ...')` lines are expected
// noise, not a signal, so this file's own run is silenced.
setLogLevel('fatal');

const DIR = path.join(__dirname, 'vectors', 'approval-v1');
const EXPECTED = [
  'jcs', 'device-id-p256', 'device-id-ed25519', 'request-valid', 'request-bad-node-signature', 'request-unpinned-node', 'request-display',
  'request-malformed', 'request-display-edge',
  'response-approve', 'response-deny',
  ...['malformed-noncanonical', 'unsupported-version', 'wrong-alg', 'kid-mismatch', 'unknown-device', 'demo-device', 'test-key', 'revoked-device',
    'revoked-via-overlay', 'bad-signature', 'wrong-node', 'replay', 'already-decided', 'unknown-request', 'nonce-mismatch', 'action-hash-mismatch',
    'expires-mismatch', 'expired', 'changed-parameter'].map((n) => `response-reject-${n}`),
  'response-accept-phone-clock-ahead', 'enroll-console', 'enroll-console-bad-mac', 'enroll-signed', 'enroll-signed-by-overlay-revoked',
  'revoke-valid', 'revoke-self-rejected', 'revoke-mutual', 'audit-slice', 'phone-api-auth'
];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'keys.json')
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const nodeKeyName = (id) => Object.keys(KEYS.nodes).find((k) => KEYS.nodes[k].id === id);
const quietLink = () => Object.assign(new EventEmitter(), { isConnected: () => true, canDeliver: () => ({ ok: true }), submit: async () => {}, status: async () => {} });
const quietLedger = () => ({ append: async (e) => e });

async function runResponseVector(v) {
  const now = () => Date.parse(v.given.now);
  const store = await approverStoreWith(v.given.approvers, { overlay: v.given.overlay, allowTestKeys: v.given.allow_test_keys, now });
  stores.push(store);
  const queue = [...v.given.pending];
  const approver = new PhoneApprover({
    identity: testNodeIdentity({ key: nodeKeyName(v.given.node.id) }),
    approverStore: store,
    link: quietLink(),
    auditLedger: quietLedger(),
    now,
    setTimer: () => null,
    clearTimer: () => {},
    buildRequest: () => {
      const envelope = queue.shift();
      const { message, bytes } = open(envelope);
      return { message, envelope, bytes };
    }
  });
  for (const env of v.given.pending) {
    const { message } = open(env);
    approver.requestAction(message.action, { origin: message.origin, currentAction: () => v.given.current_action });
  }
  for (let i = 0; i < 50 && approver.pending().length < v.given.pending.length; i += 1) await new Promise((r) => setImmediate(r));
  for (const used of v.given.used) approver.nonces.add(used.nonce, used.sha256);
  const result = await approver.handleResponse(v.input);
  approver.stop();
  return result;
}

describe('approval-v1 vectors', () => {
  it('every vector the spec names is committed, and nothing else', () => {
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
  });

  it('the committed files are exactly what generate.js produces', () => {
    for (const v of buildVectors()) {
      assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), v.name);
    }
  });

  for (const v of vectors.filter((x) => x.name.startsWith('response-'))) {
    it(`${v.name} (check ${v.check})`, async () => {
      assert.deepEqual(await runResponseVector(v), v.expect);
    });
  }

  for (const v of vectors.filter((x) => /^(enroll-signed|revoke-)/.test(x.name))) {
    it(v.name, async () => {
      const store = await approverStoreWith(v.given.approvers, { overlay: v.given.overlay, allowTestKeys: v.given.allow_test_keys, now: () => Date.parse(v.given.now) });
      stores.push(store);
      const results = v.input.map((env) => store.stage(env));
      assert.deepEqual(results, v.expect.results);
      const active = v.given.approvers.map((r) => r.device_id).filter((id) => store.isActive(id));
      assert.deepEqual(active.sort(), [...v.expect.active].sort());
    });
  }

  for (const v of vectors.filter((x) => x.name.startsWith('enroll-console'))) {
    it(v.name, () => {
      const r = verifyConsoleEnrollment(v.input, { codeId: v.given.code_id, code: v.given.code, now: Date.parse(v.given.now), allowTestKeys: v.given.allow_test_keys });
      assert.deepEqual({ accepted: r.ok, reason: r.ok ? null : r.reason, device_id: r.ok ? r.deviceId : null }, v.expect);
    });
  }

  it('jcs', () => {
    const v = byName.get('jcs');
    assert.deepEqual(v.input.cases.map((c) => canonicalize(c)), v.expect.canonical);
  });

  it('device-id-p256 and device-id-ed25519', () => {
    const p = byName.get('device-id-p256');
    assert.deepEqual(p.input.jwks.map(deviceIdFromJwk), p.expect.device_ids);
    assert.deepEqual(p.expect.device_ids.map(fingerprintGroups), p.expect.grouped);
    const e = byName.get('device-id-ed25519');
    assert.equal(deriveDeviceId(fromB64url(e.input.raw), e.input.prefix), e.expect.device_id);
  });

  it('audit-slice', () => {
    const v = byName.get('audit-slice');
    const r = verifyAuditSlice(v.input, v.given.node.key);
    assert.deepEqual({ accepted: r.ok, reason: r.reason, entries: r.message.entries.length }, v.expect);
  });

  it('phone-api-auth', () => {
    const v = byName.get('phone-api-auth');
    const s = phoneAuthString(v.given.method, v.given.path, v.given.timestamp, v.given.body);
    assert.equal(s, v.expect.signing_string);
    assert.equal(s.split('\n')[4], v.expect.body_sha256);
    const env = { alg: 'ES256', kid: v.given.device.device_id, payload: Buffer.from(s).toString('base64url'), sig: v.input.signature };
    assert.equal(verifyEs256(env, v.given.device.jwk), v.expect.accepted);
  });

  for (const v of vectors.filter((x) => x.consumers.includes('ios') && x.name.startsWith('request-'))) {
    it(`${v.name} (phone reference)`, () => {
      assert.deepEqual(phoneView(v.input, v.given.pinned_nodes), v.expect);
    });
  }

  it('a device revoked while its approval is in flight is refused', async () => {
    const identity = testNodeIdentity();
    const owner = createFakePhone();
    const thief = createFakePhone();
    const store = await approverStoreWith([owner.approverRecord(), thief.approverRecord()]);
    stores.push(store);
    const link = quietLink();
    const sent = [];
    link.submit = async (env) => { sent.push(env); };
    const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: quietLedger(), setTimer: () => null, clearTimer: () => {} });
    const action = { kind: 'tool', name: 'Bash', params: { command: 'ls' }, cwd: null, summary: 'Bash(ls)' };
    const pending = approver.requestAction(action, { currentAction: () => action });
    for (let i = 0; i < 50 && sent.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(store.stage(owner.revoke(thief.deviceId)).state, 'revoked-pending-apply');
    assert.deepEqual(await approver.handleResponse(thief.respond(sent[0], 'approve')), { accepted: false, reason: 'revoked_device' });
    assert.equal((await approver.handleResponse(owner.respond(sent[0], 'deny'))).accepted, true);
    assert.equal((await pending).decision, 'deny');
  });
});
