// tests/client-grant-v1-vectors.test.js
//
// Every client-grant-v1 vector through the production checks, the committed
// files equal to what generate.js builds, and approval-v1 left alone.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { open } = require('../src/approvals/envelope');
const { canonicalize } = require('../src/platform/jcs');
const P = require('../src/frontdoor/protocol/messages');
const C = require('../src/frontdoor/protocol/checks');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/client-grant-v1/generate');

setLogLevel('fatal');
const DIR = path.join(__dirname, 'vectors', 'client-grant-v1');
const APPROVAL_DIR = path.join(__dirname, 'vectors', 'approval-v1');
const EXPECTED = [
  'grant-approve', 'grant-deny',
  ...['user-code-mismatch', 'wrong-frontdoor', 'expired', 'code-challenge-changed', 'redirect-uri-changed', 'client-name-changed', 'scope-widened',
    'machines-unsorted', 'unsafe-only', 'unknown-device', 'demo-device', 'unknown-request', 'revoked-device', 'nonce-replay', 'noncanonical', 'not-claimant'].map((n) => `grant-reject-${n}`),
  'grant-accept-phone-clock-ahead',
  'client-revoke-valid', 'client-revoke-reject-challenge-reused', 'client-revoke-reject-challenge-expired', 'client-revoke-reject-challenge-unknown',
  'client-revoke-reject-challenge-wrong-purpose',
  'enroll-valid', 'enroll-reject-node-id-mismatch', 'enroll-reject-unknown-pairing', 'remove-valid',
  'pair-valid', 'pair-reject-bad-signature', 'pair-reject-test-key', 'pair-accept-valid',
  'repin-valid', 'repin-reject-bad-signature', 'repin-reject-spki-mismatch', 'repin-reject-old-pin-mismatch', 'fingerprint-grouping'
];
const PHONE = ['grant-approve', 'grant-deny', 'client-revoke-valid', 'enroll-valid', 'remove-valid', 'repin-valid', 'repin-reject-bad-signature', 'repin-reject-spki-mismatch',
  'repin-reject-old-pin-mismatch', 'fingerprint-grouping'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function storeFor(v) {
  const s = await approverStoreWith(v.given.approvers, { allowTestKeys: v.given.allow_test_keys, now: () => Date.parse(v.given.now) });
  stores.push(s);
  return s;
}

const challengesFor = (v) => new Challenges({
  now: () => Date.parse(v.given.now),
  entries: v.given.challenges.map((c) => ({ challenge: c.challenge, device_id: c.device_id, purpose: c.purpose, expires_at_ms: Date.parse(c.expires_at), used: c.used }))
});

async function run(v) {
  const g = v.given;
  if (v.name.startsWith('grant-')) {
    const p = g.pending;
    const pending = { ...p, expires_at_ms: Date.parse(p.expires_at), nonces: new Set(p.used_nonces) };
    return C.checkGrantDecision(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, pending, scopes: g.scopes, now: Date.parse(g.now) });
  }
  if (v.name.startsWith('client-revoke-')) return C.checkClientRevoke(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, challenges: challengesFor(v) });
  if (v.name.startsWith('remove-')) return C.checkNodeRemove(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, challenges: challengesFor(v) });
  if (v.name.startsWith('enroll-')) {
    const pairing = { ...g.pairing, expires_at_ms: Date.parse(g.pairing.expires_at), nonces: new Set(g.pairing.used_nonces) };
    return C.checkNodeEnroll(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, pairing, now: Date.parse(g.now) });
  }
  if (v.name.startsWith('pair-accept-')) return C.verifyPairAccept(v.input, { nodeId: g.node_id, nonce: g.nonce });
  if (v.name.startsWith('pair-')) return C.checkNodePair(v.input, { frontdoorHost: g.frontdoor_host, allowTestKeys: g.allow_test_keys });
  if (v.name.startsWith('repin-')) {
    return C.verifyRepin(v.input, { frontdoorId: g.frontdoor.id, frontdoorPublicKey: g.frontdoor.key, receivedSpki: g.received_spki, currentPin: g.current_pin });
  }
  throw new Error(`no runner for ${v.name}`);
}

describe('client-grant-v1 vectors', () => {
  it('has exactly the expected set, and phones consume exactly theirs', () => {
    assert.equal(EXPECTED.length, 37);
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    assert.deepEqual(vectors.filter((v) => v.consumers.includes('ios')).map((v) => v.name).sort(), [...PHONE].sort());
    assert.deepEqual(vectors.filter((v) => v.consumers.includes('android')).map((v) => v.name).sort(), [...PHONE].sort());
  });

  for (const name of EXPECTED.filter((n) => n !== 'fingerprint-grouping')) {
    it(name, async () => {
      const v = byName.get(name);
      const r = await run(v);
      assert.deepEqual({ accepted: r.ok, reason: r.reason }, { accepted: v.expect.accepted, reason: v.expect.reason });
      if (name === 'pair-valid') {
        assert.equal(r.message.node_id, v.expect.node_id);
        assert.equal(r.tlsFingerprint, v.expect.tls_fingerprint);
        assert.equal(r.message.code_hash, v.expect.code_hash);
      }
      if (name === 'pair-accept-valid') assert.equal(r.frontdoorId, v.expect.frontdoor_id);
      if (v.expect.message) {
        // What a phone builds from these fields is exactly the signed bytes.
        assert.equal(canonicalize(v.expect.message), open(v.input).bytes.toString('utf8'));
      }
    });
  }

  it('the published node keys are refused only where test keys are not allowed', async () => {
    // pair-reject-test-key is pair-valid's envelope with allow_test_keys false.
    assert.deepEqual(byName.get('pair-reject-test-key').input, byName.get('pair-valid').input);
    for (const v of vectors.filter((x) => x.name !== 'pair-reject-test-key' && 'allow_test_keys' in x.given)) {
      assert.equal(v.given.allow_test_keys, true, v.name);
    }
  });

  it('fingerprint-grouping', () => {
    const v = byName.get('fingerprint-grouping');
    assert.deepEqual(v.input.node_ids.map((n) => P.nodeFingerprint(n)), v.expect.node_fingerprints);
    const codes = v.input.typed_codes.map((t) => P.normalizeUserCode(t));
    assert.deepEqual(codes, v.expect.user_codes);
    assert.deepEqual(codes.map((c) => (c ? P.formatUserCode(c) : null)), v.expect.displayed);
  });

  it('the committed files are exactly what generate.js produces', () => {
    const built = buildVectors();
    assert.deepEqual(built.map((v) => v.name).sort(), [...EXPECTED].sort());
    for (const v of built) {
      assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), `${v.name}.json is stale: run node tests/vectors/client-grant-v1/generate.js`);
    }
  });

  it('leaves approval-v1 untouched: 41 vectors, no shared names', () => {
    const approval = fs.readdirSync(APPROVAL_DIR).filter((f) => f.endsWith('.json') && f !== 'keys.json');
    assert.equal(approval.length, 41);
    const names = new Set(approval.map((f) => f.replace(/\.json$/, '')));
    for (const n of EXPECTED) assert.ok(!names.has(n), `${n} collides with an approval-v1 vector`);
    assert.ok(!fs.existsSync(path.join(DIR, 'keys.json')), 'client-grant-v1 reads ../approval-v1/keys.json, never a copy');
  });
});
