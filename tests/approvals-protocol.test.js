// tests/approvals-protocol.test.js
//
// Runs every approval-v1 vector whose consumers include `node` through the
// production code, checks the phone vectors against the reference rules, and
// checks the committed files are exactly what generate.js produces.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { canonicalize } = require('../src/platform/jcs');
const { open, deviceIdFromJwk, deriveDeviceId, fingerprintGroups, fromB64url, verifyEs256, verifyEd25519 } = require('../src/approvals/envelope');
const { phoneAuthString, validateMessage } = require('../src/approvals/messages');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { openSealed, saltedHash, isSealedShape, SealError } = require('../src/approvals/seal');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { verifyAuditSlice } = require('../src/audit/audit-ledger');
require('../src/channels/mobile-app-channel'); // registers the kl.question.* validators
const { setLogLevel } = require('../src/logging');
const { testNodeIdentity, createFakePhone, KEYS } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/approval-v1/generate');
const { phoneView, phoneReadAuthString } = require('./vectors/approval-v1/phone-reference');

// These vectors deliberately construct known-bad approver files (test-key,
// demo-device) and a store that refuses to trust its own directory; the
// resulting `log.error('ignoring approver file ...')` lines are expected
// noise, not a signal, so this file's own run is silenced.
setLogLevel('fatal');

const DIR = path.join(__dirname, 'vectors', 'approval-v1');
// The read-key vectors (android-slim spec §8.8): `node`, and `android` where
// the phone builds or signs something; never `ios`.
const READ_KEY = [
  'phone-api-auth-read', 'enroll-console-read-key', 'enroll-console-read-key-equal', 'enroll-signed-read-key',
  'read-key-valid', 'read-key-wrong-signer', 'read-key-from-the-future', 'response-reject-read-key'
];
const READ_KEY_ANDROID = ['phone-api-auth-read', 'enroll-console-read-key', 'read-key-valid'];
// The seal (sealed phones, R-SP-1, R-SP-2): the node's and both phones'.
const SEAL = ['seal-open', 'seal-not-recipient', 'seal-tampered-ct', 'seal-tampered-clear', 'seal-hash-mismatch', 'seal-content-not-jcs', 'seal-content-clear-key', 'seal-pad-not-spaces'];
// The box key (sealed phones, R-SP-10): the node's, and both phones' where a phone builds it.
const BOX_KEY = ['enroll-console-box-key', 'enroll-console-box-key-equal', 'enroll-signed-box-key', 'box-key-valid', 'box-key-wrong-signer', 'box-key-stale'];
// Sealed tool approvals (R-SP-2, R-SP-5): the node's, and both phones' where a phone reads the request.
const SEALED_APPROVAL = ['request-sealed-display', 'response-approve-sealed', 'response-reject-sealed-changed-parameter', 'response-reject-sealed-hash-unsalted'];
// Sealed questions (R-SP-4): the node's and both phones'.
const SEALED_QUESTION = ['question-ask-sealed', 'question-answer-sealed'];
const SEALED_PHONES = [...SEAL, ...SEALED_QUESTION, 'request-sealed-display', 'enroll-console-box-key', 'box-key-valid'];
const EXPECTED = [
  'jcs', 'device-id-p256', 'device-id-ed25519', 'request-valid', 'request-bad-node-signature', 'request-unpinned-node', 'request-display',
  'request-malformed', 'request-display-edge', 'request-malformed-equivalent-keys',
  'response-approve', 'response-deny',
  ...['malformed-noncanonical', 'unsupported-version', 'wrong-alg', 'kid-mismatch', 'unknown-device', 'demo-device', 'test-key', 'revoked-device',
    'revoked-via-overlay', 'bad-signature', 'wrong-node', 'replay', 'already-decided', 'unknown-request', 'nonce-mismatch', 'action-hash-mismatch',
    'expires-mismatch', 'expired', 'changed-parameter'].map((n) => `response-reject-${n}`),
  'response-accept-phone-clock-ahead', 'enroll-console', 'enroll-console-bad-mac', 'enroll-signed', 'enroll-signed-by-overlay-revoked',
  'revoke-valid', 'revoke-self-rejected', 'revoke-mutual', 'audit-slice', 'phone-api-auth',
  // Revised 2026-10-28: the read key (android-slim spec §8.8).
  ...READ_KEY,
  ...SEAL,
  ...BOX_KEY,
  ...SEALED_APPROVAL,
  ...SEALED_QUESTION
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
  // An entry is an envelope, or for a sealed request { envelope, salt }: what the
  // node kept, since its salt is nowhere in clear.
  const pendingOf = (entry) => (entry.envelope ? entry : { envelope: entry, salt: null });
  const queue = v.given.pending.map(pendingOf);
  const approver = new PhoneApprover({
    identity: testNodeIdentity({ key: nodeKeyName(v.given.node.id) }),
    approverStore: store,
    link: quietLink(),
    auditLedger: quietLedger(),
    now,
    setTimer: () => null,
    clearTimer: () => {},
    buildRequest: () => {
      const { envelope, salt } = queue.shift();
      const { message, bytes } = open(envelope);
      return { message, envelope, bytes, salt };
    }
  });
  for (const entry of v.given.pending) {
    const { message } = open(pendingOf(entry).envelope);
    approver.requestAction(message.action, { origin: message.origin, currentAction: () => v.given.current_action });
  }
  for (let i = 0; i < 50 && approver.pending().length < v.given.pending.length; i += 1) await new Promise((r) => setImmediate(r));
  for (const used of v.given.used) approver.nonces.add(used.nonce, used.sha256);
  const result = await approver.handleResponse(v.input);
  approver.stop();
  return result;
}

// What a phone does with a sealed request: open it, then hold the clear hash to
// the opened content before anything is shown.
function runSealVector(v) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(v.given.box.d));
  const agree = (jwk) => ecdh.computeSecret(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  let opened;
  try {
    opened = openSealed({ type: v.given.type, message: v.input, recipientId: v.given.box.device_id, agree });
  } catch (err) {
    if (!(err instanceof SealError)) throw err;
    return { reason: err.reason, message: null };
  }
  if (saltedHash(opened.content.salt, opened.content.action) !== opened.message.action_hash) return { reason: 'action_hash_mismatch', message: null };
  return { reason: null, message: opened.message };
}

describe('approval-v1 vectors', () => {
  it('every vector the spec names is committed, and nothing else', () => {
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
  });

  it('69 vectors; the read-key ones name node and android only, android where the phone builds or signs; the sealed ones both phones where a phone builds or opens', () => {
    assert.equal(EXPECTED.length, 69);
    for (const name of [...SEAL, ...BOX_KEY, ...SEALED_APPROVAL, ...SEALED_QUESTION]) {
      assert.deepEqual(byName.get(name).consumers, SEALED_PHONES.includes(name) ? ['node', 'ios', 'android'] : ['node'], name);
    }
    for (const name of READ_KEY) {
      const want = READ_KEY_ANDROID.includes(name) ? ['node', 'android'] : ['node'];
      assert.deepEqual(byName.get(name).consumers, want, name);
    }
    // iOS consumes exactly what it did before the read key.
    assert.deepEqual(vectors.filter((v) => v.consumers.includes('ios')).map((v) => v.name).filter((n) => READ_KEY.includes(n)), []);
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

  for (const v of vectors.filter((x) => /^(enroll-signed|revoke-|read-key-|box-key-)/.test(x.name))) {
    it(v.name, async () => {
      const store = await approverStoreWith(v.given.approvers, { overlay: v.given.overlay, allowTestKeys: v.given.allow_test_keys, now: () => Date.parse(v.given.now) });
      stores.push(store);
      const results = v.input.map((env) => store.stage(env));
      assert.deepEqual(results, v.expect.results);
      const active = v.given.approvers.map((r) => r.device_id).filter((id) => store.isActive(id));
      assert.deepEqual(active.sort(), [...v.expect.active].sort());
      // What was staged carries the read key it was signed with (`device apply` writes it).
      if (v.expect.staged_read_keys) {
        const staged = v.input.filter((_, i) => results[i].state !== 'rejected').map((env) => {
          const { message } = open(JSON.parse(fs.readFileSync(path.join(store.stagedDir, `${open(env).message.nonce}.json`), 'utf8')).envelope);
          return message.type === 'kl.device.enroll' ? message.device.read_key : message.read_key;
        });
        assert.deepEqual(staged, v.expect.staged_read_keys);
      }
      // And the box key, the same way.
      if (v.expect.staged_box_keys) {
        const staged = v.input.filter((_, i) => results[i].state !== 'rejected').map((env) => {
          const { message } = open(JSON.parse(fs.readFileSync(path.join(store.stagedDir, `${open(env).message.nonce}.json`), 'utf8')).envelope);
          return message.type === 'kl.device.enroll' ? message.device.box_key : message.box_key;
        });
        assert.deepEqual(staged, v.expect.staged_box_keys);
      }
    });
  }

  for (const v of vectors.filter((x) => x.name.startsWith('enroll-console'))) {
    it(v.name, () => {
      const r = verifyConsoleEnrollment(v.input, { codeId: v.given.code_id, code: v.given.code, now: Date.parse(v.given.now), allowTestKeys: v.given.allow_test_keys });
      const got = { accepted: r.ok, reason: r.ok ? null : r.reason, device_id: r.ok ? r.deviceId : null };
      // A console enrollment that carries a read key: the record `enroll-device` writes holds it.
      if (Object.hasOwn(v.expect, 'read_key')) got.read_key = r.ok ? r.message.device.read_key : null;
      if (Object.hasOwn(v.expect, 'box_key')) got.box_key = r.ok ? r.message.device.box_key : null;
      assert.deepEqual(got, v.expect);
    });
  }

  for (const name of SEAL) {
    it(`${name} (openSealed with the vector's d)`, () => {
      const v = byName.get(name);
      assert.deepEqual(runSealVector(v), v.expect);
    });
  }

  it('every message a sealer built holds a whole number of 256-byte blocks; only the hand-sealed ones may not', () => {
    const HAND_SEALED = ['seal-content-not-jcs', 'seal-content-clear-key', 'seal-pad-not-spaces'];
    let checked = 0;
    for (const v of byName.values()) {
      if (HAND_SEALED.includes(v.name)) continue;
      const walk = (node) => {
        if (node === null || typeof node !== 'object') return;
        if (typeof node.payload === 'string') {
          let inner = null;
          try { inner = open(node).message; } catch { inner = null; }
          if (inner) walk(inner);
        }
        if (node.sealed && typeof node.sealed.ct === 'string') {
          assert.equal((fromB64url(node.sealed.ct).length - 16) % 256, 0, v.name);
          checked += 1;
        }
        for (const value of Object.values(node)) walk(value);
      };
      walk(v.input);
      walk(v.given);
    }
    assert.ok(checked >= 10, `${checked} sealed messages found`);
  });

  it('seal-pad-not-spaces: the opened bytes are JCS and hold a pad that is not only spaces', () => {
    const v = byName.get('seal-pad-not-spaces');
    assert.deepEqual(v.expect, { reason: 'content_malformed', message: null });
    assert.equal(isSealedShape(v.given.type, v.input), true);
  });

  it('phone-api-auth-read: the KL-PHONE-READ-V1 string, signed by the read key and not by the device key', () => {
    const v = byName.get('phone-api-auth-read');
    const g = v.given;
    assert.equal(g.key, 'read');
    const s = phoneAuthString(g.method, g.path, g.timestamp, g.body, { key: 'read' });
    assert.equal(s, v.expect.signing_string);
    assert.equal(phoneReadAuthString(g.method, g.path, g.timestamp, g.body), s, 'the phone reference builds the same string');
    assert.ok(s.startsWith('KL-PHONE-READ-V1\n'));
    assert.equal(s.split('\n')[4], v.expect.body_sha256);
    assert.notEqual(s, phoneAuthString(g.method, g.path, g.timestamp, g.body), 'never the device string over the same request');
    const env = { alg: 'ES256', kid: g.device.device_id, payload: Buffer.from(s).toString('base64url'), sig: v.input.signature };
    assert.equal(verifyEs256(env, g.device.read_jwk), v.expect.accepted);
    assert.equal(verifyEs256(env, g.device.jwk), v.expect.accepted_by_device_key);
  });

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

  it('keys equal under NFC/NFD are valid on the node but malformed on the phone (approval-v1 §5)', () => {
    const v = byName.get('request-malformed-equivalent-keys');
    assert.ok(v, 'the vector exists');
    assert.deepEqual(v.consumers, ['ios', 'android']);
    const { message } = open(v.input);
    const keys = Object.keys(message.action.params);
    const composed = String.fromCodePoint(0xe9);
    const decomposed = `e${String.fromCodePoint(0x301)}`;
    assert.ok(keys.includes(composed) && keys.includes(decomposed), 'the params carry both forms of the key');
    assert.equal(validateMessage('kl.approval.request', message), null, 'the node keeps both keys and accepts the shape');
    assert.deepEqual(phoneView(v.input, { pinned: v.given.pinned_nodes }), { shown: false, reason: 'malformed', display: null });
  });

  const agreeWith = (d) => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64url(d));
    return (jwk) => ecdh.computeSecret(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  };

  it('question-ask-sealed: signed by the node, its clear part has no content, and the box opens it to the clear ask', () => {
    const v = byName.get('question-ask-sealed');
    assert.equal(verifyEd25519(v.input, v.given.node_public_key), true);
    const { message } = open(v.input);
    assert.equal(validateMessage(v.given.type, message), null);
    for (const key of ['case_id', 'question_id', 'case_title', 'text', 'options']) assert.ok(!Object.hasOwn(message, key), key);
    const opened = openSealed({ type: v.given.type, message, recipientId: v.given.box.device_id, agree: agreeWith(v.given.box.d) });
    assert.deepEqual(opened.message, v.expect.message);
    assert.equal(validateMessage(v.given.type, opened.message), null);
  });

  it('question-answer-sealed: signed by the device, opened by the node, the whole answer of given.ask and given.answer', () => {
    const v = byName.get('question-answer-sealed');
    assert.equal(verifyEs256(v.input, v.given.device.jwk), true);
    const { message } = open(v.input);
    assert.equal(validateMessage(v.given.type, message), null);
    for (const key of ['case_id', 'question_id', 'answer']) assert.ok(!Object.hasOwn(message, key), key);
    assert.deepEqual(Object.keys(message.sealed.keys), [v.given.box.node_id]);
    const opened = openSealed({ type: v.given.type, message, recipientId: v.given.box.node_id, agree: agreeWith(v.given.box.d) });
    assert.deepEqual(opened.message, v.expect.message);
    assert.equal(validateMessage(v.given.type, opened.message), null);
    assert.equal(opened.message.case_id, v.given.ask.case_id);
    assert.equal(opened.message.question_id, v.given.ask.question_id);
    assert.equal(opened.message.token, v.given.ask.token);
    assert.deepEqual(opened.message.answer, v.given.answer);
  });

  it('request-sealed-display: a sealed request shows what the clear one shows, and only to a box that opens it', () => {
    const v = byName.get('request-sealed-display');
    const view = phoneView(v.input, { pinned: v.given.pinned_nodes, box: v.given.box });
    assert.deepEqual(view, v.expect);
    assert.equal(view.shown, true);
    assert.deepEqual(view.display, byName.get('request-display').expect.display);
    const { message } = open(v.input);
    assert.equal(validateMessage('kl.approval.request', message), null);
    assert.equal(Object.hasOwn(message, 'action'), false);
    assert.deepEqual(phoneView(v.input, { pinned: v.given.pinned_nodes }), { shown: false, reason: 'not_recipient', display: null });
    assert.deepEqual(phoneView(v.input, { pinned: [], box: v.given.box }), { shown: false, reason: 'unpinned_node', display: null });
    // Not a recipient at all: the box key of a device with no wrap here.
    assert.deepEqual(phoneView(v.input, { pinned: v.given.pinned_nodes, box: { device_id: 'd-aaaaaaaaaaaaaaaa', d: v.given.box.d } }), { shown: false, reason: 'not_recipient', display: null });
    // A wrap that does not open: another phone's box under this one's id.
    assert.deepEqual(phoneView(v.input, { pinned: v.given.pinned_nodes, box: { device_id: v.given.box.device_id, d: KEYS.devices.B_box.d } }), { shown: false, reason: 'open_failed', display: null });
  });

  for (const v of vectors.filter((x) => x.consumers.includes('ios') && x.name.startsWith('request-'))) {
    it(`${v.name} (phone reference)`, () => {
      assert.deepEqual(phoneView(v.input, { pinned: v.given.pinned_nodes, box: v.given.box }), v.expect);
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
