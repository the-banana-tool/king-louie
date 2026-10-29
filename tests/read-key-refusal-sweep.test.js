// tests/read-key-refusal-sweep.test.js
//
// Anti-goal §4 of the android-slim spec: the read key must never be able to
// say yes. Every phone-signed message the node and the front door accept is
// signed here once with the device key (accepted, or refused for a reason
// after the signature) and once, unchanged, with the device's read key, which
// its record holds: each verifier refuses that one as bad_signature. Only the
// lease watch accepts it (§8.5, §8.6).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { seal, open } = require('../src/approvals/envelope');
const messages = require('../src/approvals/messages');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const L = require('../src/gui/lease-protocol');
const { MobileAppChannel } = require('../src/channels/mobile-app-channel');
const { verifySignedGrant, signedAction, approvalHelpers } = require('../src/cases/executors/signed');
const { envelopeCore, envelopeHash } = require('../src/cases/executors/envelope');
const C = require('../src/frontdoor/protocol/checks');
const P = require('../src/frontdoor/protocol/messages');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { isConsoleEnrollment } = require('../src/frontdoor/node-methods');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');

// The same message, signed by the phone's read key instead of its device key.
const asRead = (phone, envelope) => seal(open(envelope).message, phone.readSigner);
const freshJwk = () => {
  const { kty, crv, x, y } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  return { kty, crv, x, y };
};

const node = testNodeIdentity({ key: 'gpu-box' });
const FD = testNodeIdentity({ key: 'relay' });
const phone = createFakePhone({ name: 'Owner phone' });
const second = createFakePhone({ name: 'Second phone' });
const newcomer = createFakePhone({ name: 'New phone' });

let store;
const stores = [];
const fresh = async () => {
  const s = await approverStoreWith([phone.approverRecord({ readKey: true }), second.approverRecord({ readKey: true })]);
  stores.push(s);
  return s;
};
before(async () => { store = await fresh(); });
after(() => { for (const s of stores) s.cleanup(); });

describe('read-key refusal sweep: nodes', () => {
  it('kl.approval.response (PhoneApprover)', async () => {
    const ledger = { entries: [], append: async (e) => { ledger.entries.push(e); return e; } };
    const approver = new PhoneApprover({ identity: node, approverStore: store, link: { isConnected: () => true, on() {}, off() {} }, auditLedger: ledger, setTimer: () => null, clearTimer: () => {} });
    const req = messages.buildRequest({ identity: node, action: { kind: 'tool', name: 'Bash', params: { command: 'ls' }, summary: 'ls' }, origin: { client: 'king-louie', session: 's-1', job_id: null } });
    const response = phone.respond(req.envelope, 'approve');
    assert.deepEqual(await approver.handleResponse(asRead(phone, response)), { accepted: false, reason: 'bad_signature' });
    // The device key's response passes the signature and stops at the request (none pending here).
    assert.deepEqual(await approver.handleResponse(response), { accepted: false, reason: 'unknown_request' });
  });

  it('kl.approval.response (a signed executor approval read from the audit ledger)', () => {
    const env = {
      id: 'env-01', version: 1, status: 'active', authority: 'signed', executor: 'phone-agent',
      intent: 'Ask three brokers for a listing quote on the lot', recipients: { allow: ['+15550100'], addRequiresApproval: true },
      facts: [], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
      window: { start: '2026-10-26', end: '2026-10-30', tz: 'America/Chicago' },
      usage: { usd: 0, contacts: [], attempts: {} }, payloads: [], deltas: [], grantedBy: null
    };
    const requestId = crypto.randomUUID();
    env.grantedBy = { channel: 'phone', at: '2026-10-26T17:00:00Z', questionId: 'q-0002', evidence: { request_id: requestId } };
    env.hash = envelopeHash(envelopeCore(env));
    const req = messages.buildRequest({ identity: node, action: signedAction(env, 'case-1', approvalHelpers()), origin: { client: 'king-louie', session: 'case-1', job_id: null }, requestId });
    const audit = (response) => [
      { kind: 'approval.request', data: { job_id: null, envelope: req.envelope } },
      { kind: 'approval.response', data: { request_id: requestId, device_id: phone.deviceId, decision: 'approve', envelope: response, job_id: null } },
      { kind: 'approval.outcome', data: { request_id: requestId, state: 'approved', reason: null, job_id: null } }
    ];
    const check = (response) => verifySignedGrant(env, {
      caseId: 'case-1', auditLedger: { verify: () => ({ ok: true }), tail: () => audit(response) },
      approverStore: store, nodeId: node.nodeId, nodePublicKey: node.publicKey
    });
    const response = phone.respond(req.envelope, 'approve');
    assert.equal(check(asRead(phone, response)).ok, false);
    assert.deepEqual(check(response), { ok: true, via: 'audit' });
  });

  // A resume grant is a kl.lease.grant too; gui-leases.test.js sends one
  // through a LeaseManager.
  it('kl.lease.grant, grant and deny', () => {
    const opts = { approverStore: store, nodeId: node.nodeId, nonces: null, pending: new Map(), guiApps: {} };
    for (const decision of ['grant', 'deny']) {
      const grant = phone.sign({
        v: 1, type: 'kl.lease.grant', request_id: crypto.randomUUID(), lease_id: crypto.randomUUID(), node_id: node.nodeId,
        lease_hash: crypto.randomBytes(32).toString('base64url'), nonce: messages.randomNonce(), decision,
        grant: decision === 'grant' ? { apps: ['calculator'], minutes: 5 } : null, expires_at: new Date(Date.now() + 60000).toISOString(),
        device_id: phone.deviceId, signed_at: new Date().toISOString()
      });
      assert.equal(L.verifyLeaseGrant(asRead(phone, grant), opts).reason, 'bad_signature', decision);
      // The device key gets past the signature to the pending request (none here).
      assert.equal(L.verifyLeaseGrant(grant, opts).reason, 'unknown_request', decision);
    }
  });

  it('kl.lease.revoke', () => {
    const opts = { approverStore: store, nodeId: node.nodeId, nonces: null, knownLease: () => true };
    const revoke = phone.leaseRevoke(node.nodeId, crypto.randomUUID());
    assert.equal(L.verifyLeaseRevoke(asRead(phone, revoke), opts).reason, 'bad_signature');
    assert.equal(L.verifyLeaseRevoke(revoke, opts).accepted, true);
  });

  it('kl.lease.watch is the one message the read key signs', () => {
    const opts = { approverStore: store, nodeId: node.nodeId, nonces: null, knownLease: () => true };
    const watch = phone.leaseWatch(node.nodeId, crypto.randomUUID());
    const r = L.verifyLeaseWatch(asRead(phone, watch), opts);
    assert.equal(r.accepted, true);
    assert.equal(r.key, 'read');
    assert.equal(L.verifyLeaseWatch(watch, opts).key, 'device');
  });

  it('kl.question.answer (mobile-app-channel)', async () => {
    const methods = {};
    const channel = new MobileAppChannel({ link: { registerMethod: (n, fn) => { methods[n] = fn; } }, approverStore: store, identity: node });
    channel.registerMethods();
    const answer = phone.sign({
      v: 1, type: 'kl.question.answer', node_id: node.nodeId, case_id: 'case-1', question_id: 'q-0001', token: 'ABCDEF',
      answer: { option_id: 'a' }, nonce: messages.randomNonce(), signed_at: new Date().toISOString(), device_id: phone.deviceId
    });
    assert.deepEqual(await methods['question.answer']({ envelope: asRead(phone, answer) }), { ok: false, error: 'bad_signature' });
    // The device key's answer gets past the signature to the question lookup (no router here).
    assert.deepEqual(await methods['question.answer']({ envelope: answer }), { ok: false, error: 'unknown_question' });
  });

  it('kl.device.enroll, staged from the relay', async () => {
    const s = await fresh();
    const enroll = phone.enroll({ device: newcomer.device() });
    assert.deepEqual(s.stage(asRead(phone, enroll)), { state: 'rejected', reason: 'bad_signature' });
    assert.deepEqual(s.stage(enroll), { state: 'staged' });
  });

  it('kl.device.enroll at the console', () => {
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    const enroll = newcomer.enroll({ codeId, code, device: { ...newcomer.device(), read_key: newcomer.readJwk } });
    assert.deepEqual(verifyConsoleEnrollment(asRead(newcomer, enroll), { codeId, code }), { ok: false, reason: 'bad_signature' });
    assert.equal(verifyConsoleEnrollment(enroll, { codeId, code }).ok, true);
    // The relay's own check of a console enrollment it forwards.
    assert.equal(isConsoleEnrollment(asRead(newcomer, enroll), codeId), null);
    assert.ok(isConsoleEnrollment(enroll, codeId));
  });

  it('kl.device.revoke, staged from the relay', async () => {
    const s = await fresh();
    const revoke = phone.revoke(second.deviceId);
    assert.deepEqual(s.stage(asRead(phone, revoke)), { state: 'rejected', reason: 'bad_signature' });
    assert.equal(s.isActive(second.deviceId), true, 'a refused revoke blocks nothing');
    assert.deepEqual(s.stage(revoke), { state: 'revoked-pending-apply' });
  });

  it('kl.device.read_key, signed by the read key it replaces', async () => {
    const s = await fresh();
    const now = Date.now();
    const statement = phone.sign({
      v: 1, type: 'kl.device.read_key', device_id: phone.deviceId, read_key: freshJwk(),
      created_at: messages.iso(now), expires_at: messages.iso(now + 86400000), nonce: messages.randomNonce()
    });
    assert.deepEqual(s.stage(asRead(phone, statement)), { state: 'rejected', reason: 'bad_signature' });
    assert.deepEqual(s.stage(statement), { state: 'read-key-pending-apply' });
  });
});

describe('read-key refusal sweep: the front door (client-grant-v1)', () => {
  const NOW = Date.now();
  const id22 = (label) => crypto.createHash('sha256').update(label).digest().subarray(0, 16).toString('base64url');

  it('kl.client.grant, approve and deny', () => {
    const pending = {
      grant_id: `gr_${id22('g')}`, client_id: `dcr_${id22('c')}`, client_name: 'Example Client', redirect_uri: 'https://client.example.com/cb',
      resource: 'https://mcp.kl.example.com/mcp', code_challenge: crypto.createHash('sha256').update('v').digest('base64url'), user_code: 'Q7KM2X',
      requested_scopes: ['fleet:read'], expires_at_ms: NOW + 300000, claimed_by: phone.deviceId, nonces: new Set()
    };
    const opts = { approverStore: store, frontdoorId: FD.nodeId, pending, now: NOW };
    for (const decision of ['approve', 'deny']) {
      const grant = phone.grant({ frontdoorId: FD.nodeId, pending, decision });
      assert.equal(C.checkGrantDecision(asRead(phone, grant), opts).reason, 'bad_signature', decision);
      assert.equal(C.checkGrantDecision(grant, opts).ok, true, decision);
    }
  });

  it('kl.client.revoke and kl.node.remove; a refused signature consumes no challenge', () => {
    const ch = new Challenges({ now: () => NOW });
    const opts = { approverStore: store, frontdoorId: FD.nodeId, challenges: ch };
    const revoke = phone.revokeClient({ frontdoorId: FD.nodeId, grantId: `gr_${id22('g')}`, challenge: ch.issue(phone.deviceId, 'revoke').challenge });
    assert.equal(C.checkClientRevoke(asRead(phone, revoke), opts).reason, 'bad_signature');
    assert.equal(C.checkClientRevoke(revoke, opts).ok, true);
    const remove = phone.removeNode({ frontdoorId: FD.nodeId, nodeId: node.nodeId, challenge: ch.issue(phone.deviceId, 'remove').challenge });
    assert.equal(C.checkNodeRemove(asRead(phone, remove), opts).reason, 'bad_signature');
    assert.equal(C.checkNodeRemove(remove, opts).ok, true);
  });

  it('kl.node.enroll, approve and deny', () => {
    const joining = testNodeIdentity();
    const pairing = {
      pairing_id: `pr_${id22('p')}`, node_id: joining.nodeId, node_name: 'web-01', profile: 'agent', public_key: P.rawEd25519(joining.publicKey),
      tls_fingerprint: 'c'.repeat(64), replaces: null, expires_at_ms: NOW + 600000, nonces: new Set()
    };
    const opts = { approverStore: store, frontdoorId: FD.nodeId, pairing, now: NOW };
    for (const decision of ['approve', 'deny']) {
      const enroll = phone.enrollNode({ frontdoorId: FD.nodeId, pairing, decision });
      assert.equal(C.checkNodeEnroll(asRead(phone, enroll), opts).reason, 'bad_signature', decision);
      assert.equal(C.checkNodeEnroll(enroll, opts).ok, true, decision);
    }
  });
});

describe('read-key refusal sweep: only the watch opts in', () => {
  // A new verifier that passes allowReadKey must come with its own case in
  // this sweep and a reason in the spec (§8.5).
  it('allowReadKey is named in src/ only by verifyDeviceEnvelope and the watch', () => {
    const root = path.join(__dirname, '..', 'src');
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/allowReadKey/.test(line) && !/^\s*\/\//.test(line)) found.push(`${path.relative(root, p).replace(/\\/g, '/')}:${line.trim()}`);
          });
        }
      }
    };
    walk(root);
    const files = [...new Set(found.map((f) => f.split(':')[0]))].sort();
    assert.deepEqual(files, ['approvals/verify-device.js', 'gui/lease-protocol.js']);
    const lease = found.filter((f) => f.startsWith('gui/lease-protocol.js:') && /allowReadKey: true/.test(f));
    assert.deepEqual(lease, ["gui/lease-protocol.js:const verifyLeaseWatch = verifyLeaseControl('kl.lease.watch', { allowReadKey: true });"]);
  });
});
