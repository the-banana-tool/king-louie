// tests/frontdoor-protocol-checks.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setLogLevel } = require('../src/logging');
const P = require('../src/frontdoor/protocol/messages');
const C = require('../src/frontdoor/protocol/checks');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { seal } = require('../src/approvals/envelope');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const FD = testNodeIdentity({ key: 'relay' });
const NOW = Date.parse('2026-09-23T18:04:11.201Z');
const id22 = (label) => crypto.createHash('sha256').update(label).digest().subarray(0, 16).toString('base64url');
const A = createFakePhone({ seed: 'A' });
const B = createFakePhone({ seed: 'B' });
const C3 = createFakePhone({ seed: 'C' });

async function store({ revoked = [] } = {}) {
  const records = [A, B, C3].map((p) => p.approverRecord(revoked.includes(p) ? { revokedAt: '2026-09-20T00:00:00.000Z', revokedBy: 'console' } : {}));
  const s = await approverStoreWith(records, { allowTestKeys: true, now: () => NOW });
  stores.push(s);
  return s;
}

function pending(overrides = {}) {
  return {
    grant_id: `gr_${id22('g')}`, client_id: `dcr_${id22('c')}`, client_name: 'Example Client', redirect_uri: 'https://client.example.com/cb',
    resource: 'https://mcp.kl.example.com/mcp', code_challenge: crypto.createHash('sha256').update('v').digest('base64url'), user_code: 'Q7KM2X',
    requested_scopes: ['fleet:read', 'fleet:run'], expires_at_ms: NOW + 300000, claimed_by: A.deviceId, nonces: new Set(), ...overrides
  };
}

describe('checkGrantDecision', () => {
  it('accepts the claimant phone signing exactly the pending authorization', async () => {
    const s = await store();
    const p = pending();
    const r = C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.deviceId, A.deviceId);
  });

  it('refuses, in order: wrong front door, not the claimant, expired, changed binding, other code, nonce reuse, scopes', async () => {
    const s = await store();
    const p = pending();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: 'kl-c2ubd6jjqumalzt5', pending: p }), opts).reason, 'wrong_frontdoor');
    assert.equal(C.checkGrantDecision(C3.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'not_claimant');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { ...opts, now: NOW + 300001 }).reason, 'expired');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, redirect_uri: 'https://evil.example.com/cb' } }), opts).reason, 'binding_mismatch');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, user_code: 'ABCDEF' } }), opts).reason, 'user_code_mismatch');
    const n = crypto.randomBytes(32).toString('base64url');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p, nonce: n }), { ...opts, pending: { ...p, nonces: new Set([n]) } }).reason, 'replay');
    const widened = A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:delegate', machines: null }] });
    assert.equal(C.checkGrantDecision(widened, opts).reason, 'invalid_scope');
    const q = pending({ requested_scopes: ['fleet:read', 'fleet:unsafe'] });
    const unsafeOnly = A.grant({ frontdoorId: FD.nodeId, pending: q, scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }] });
    assert.equal(C.checkGrantDecision(unsafeOnly, { ...opts, pending: q }).reason, 'invalid_scope');
  });

  it('refuses revoked and unknown devices, and never judges signed_at', async () => {
    const s = await store({ revoked: [B] });
    const p = pending({ claimed_by: null });
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    assert.equal(C.checkGrantDecision(B.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'revoked_device');
    const stranger = createFakePhone();
    assert.equal(C.checkGrantDecision(stranger.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'unknown_device');
    const ahead = A.grant({ frontdoorId: FD.nodeId, pending: p, signedAt: new Date(NOW + 86400000).toISOString() });
    assert.equal(C.checkGrantDecision(ahead, opts).ok, true);
  });

  it('a deny needs no scopes and is accepted as a decision', async () => {
    const s = await store();
    const p = pending();
    const r = C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p, decision: 'deny' }), { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.message.decision, 'deny');
  });
});

describe('verifyPhoneEnvelope at load (R25)', () => {
  it('keeps an envelope accepted before the device was revoked, drops one accepted after', async () => {
    const s = await store({ revoked: [B] });
    const env = B.revokeClient({ frontdoorId: FD.nodeId, grantId: `gr_${id22('x')}`, challenge: crypto.randomBytes(32).toString('base64url') });
    const opts = { approverStore: s, type: 'kl.client.revoke', frontdoorId: FD.nodeId };
    assert.equal(C.verifyPhoneEnvelope(env, opts).reason, 'revoked_device');
    assert.equal(C.verifyPhoneEnvelope(env, { ...opts, acceptedAt: '2026-09-19T00:00:00.000Z' }).ok, true);
    assert.equal(C.verifyPhoneEnvelope(env, { ...opts, acceptedAt: '2026-09-21T00:00:00.000Z' }).reason, 'revoked_device');
  });
});

describe('Challenges and revocations', () => {
  it('a challenge works once, for its device, within 2 minutes', () => {
    let now = NOW;
    const ch = new Challenges({ now: () => now });
    const { challenge, expires_in_ms: ttl } = ch.issue(A.deviceId);
    assert.equal(ttl, 120000);
    assert.equal(ch.take(B.deviceId, challenge), 'unknown');
    assert.equal(ch.take(A.deviceId, challenge), 'ok');
    assert.equal(ch.take(A.deviceId, challenge), 'reused');
    const late = ch.issue(A.deviceId).challenge;
    now += 120001;
    assert.equal(ch.take(A.deviceId, late), 'expired');
  });

  it('at most 20 live challenges per device', () => {
    const ch = new Challenges({ now: () => NOW });
    for (let i = 0; i < 20; i += 1) ch.issue(A.deviceId);
    assert.throws(() => ch.issue(A.deviceId), (err) => err.code === 'too_many_challenges');
    ch.issue(B.deviceId);
  });

  it('checkClientRevoke and checkNodeRemove consume the challenge', async () => {
    const s = await store();
    const ch = new Challenges({ now: () => NOW });
    const { challenge } = ch.issue(A.deviceId);
    const env = A.revokeClient({ frontdoorId: FD.nodeId, grantId: `gr_${id22('g')}`, challenge });
    assert.equal(C.checkClientRevoke(env, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).ok, true);
    assert.equal(C.checkClientRevoke(env, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).reason, 'challenge_reused');
    const second = ch.issue(A.deviceId).challenge;
    const rm = A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge: second });
    assert.equal(C.checkNodeRemove(rm, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).ok, true);
  });
});

describe('node enrollment and pairing', () => {
  const gpu = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
  const pairing = () => ({
    pairing_id: `pr_${id22('p')}`, node_id: gpu.nodeId, node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(gpu.publicKey),
    tls_fingerprint: 'c'.repeat(64), replaces: null, expires_at_ms: NOW + 600000, nonces: new Set()
  });

  it('checkNodeEnroll: derived id, the pending pairing, its expiry and binding', async () => {
    const s = await store();
    const pr = pairing();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pairing: pr, now: NOW };
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr }), opts).ok, true);
    const wrongId = A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, node_id: 'kl-c2ubd6jjqumalzt5' } });
    assert.equal(C.checkNodeEnroll(wrongId, opts).reason, 'node_id_mismatch');
    const otherPairing = A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, pairing_id: `pr_${id22('other')}` } });
    assert.equal(C.checkNodeEnroll(otherPairing, opts).reason, 'unknown_pairing');
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr }), { ...opts, now: NOW + 600001 }).reason, 'expired');
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, profile: 'runbook' } }), opts).reason, 'binding_mismatch');
  });

  it('checkNodePair checks the node signature, derived id and host; verifyPairAccept checks the front door', () => {
    const cert = require('../src/mesh/mesh-identity').MeshIdentity._generateFallbackTlsCert('gpu-box', 1).cert;
    const env = P.buildNodePair({ identity: gpu, frontdoorHost: 'mcp.kl.example.com', code: 'a b c d e f', profile: 'agent', tlsCertPem: cert });
    const ok = C.checkNodePair(env, { frontdoorHost: 'mcp.kl.example.com' });
    assert.equal(ok.ok, true, ok.reason);
    assert.match(ok.tlsFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(C.checkNodePair(env, { frontdoorHost: 'mcp.other.example.com' }).reason, 'wrong_host');
    const tampered = { ...env, sig: Buffer.from(env.sig, 'base64url').map((b, i) => (i === 0 ? b ^ 1 : b)).toString('base64url') };
    assert.equal(C.checkNodePair(tampered, { frontdoorHost: 'mcp.kl.example.com' }).reason, 'bad_signature');

    const nonce = crypto.randomBytes(32).toString('base64url');
    const accept = P.buildNodePairAccept({ identity: FD, pairingId: `pr_${id22('p')}`, nodeId: gpu.nodeId, nonce, meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: 'd'.repeat(64) });
    const v = C.verifyPairAccept(accept, { nodeId: gpu.nodeId, nonce });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.frontdoorId, FD.nodeId);
    assert.equal(C.verifyPairAccept(accept, { nodeId: gpu.nodeId, nonce: crypto.randomBytes(32).toString('base64url') }).reason, 'nonce_mismatch');
    assert.equal(C.verifyPairAccept(accept, { nodeId: 'kl-c2ubd6jjqumalzt5', nonce }).reason, 'wrong_node');
  });

  it('verifyRepin: key, new SPKI equals what was received, old SPKI equals the current pin', () => {
    const oldSpki = `sha256/${crypto.randomBytes(32).toString('base64url')}`;
    const newSpki = `sha256/${crypto.randomBytes(32).toString('base64url')}`;
    const env = P.buildRelayRepin({ identity: FD, relay: 'https://mcp.kl.example.com', oldSpki, newSpki });
    const key = P.rawEd25519(FD.publicKey);
    const base = { frontdoorId: FD.nodeId, frontdoorPublicKey: key, receivedSpki: newSpki, currentPin: oldSpki };
    assert.equal(C.verifyRepin(env, base).ok, true);
    assert.equal(C.verifyRepin(env, { ...base, receivedSpki: oldSpki }).reason, 'spki_mismatch');
    assert.equal(C.verifyRepin(env, { ...base, currentPin: newSpki }).reason, 'old_pin_mismatch');
    const other = testNodeIdentity();
    assert.equal(C.verifyRepin(env, { ...base, frontdoorPublicKey: P.rawEd25519(other.publicKey) }).reason, 'bad_signature');
    const forged = seal({ ...require('../src/approvals/envelope').open(env).message }, other.signer);
    assert.equal(C.verifyRepin(forged, base).reason, 'wrong_frontdoor');
  });
});

describe('security properties', () => {
  const { ApproverStore } = require('../src/approvals/approver-store');
  // Re-seals `message` under `kid` with someone else's (or no) signing key.
  const resign = (message, kid, sign) => seal(message, { alg: 'ES256', kid, sign });
  const zeroSig = () => Buffer.alloc(64);
  const opened = (env) => require('../src/approvals/envelope').open(env).message;

  it('checks the signature before any signed field decides the outcome', async () => {
    const s = await store();
    const p = pending();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    const good = A.grant({ frontdoorId: FD.nodeId, pending: p });
    // A's real signature over different bytes.
    const swapped = { ...good, payload: resign({ ...opened(good), redirect_uri: 'https://evil.example.com/cb' }, A.deviceId, zeroSig).payload };
    assert.equal(C.checkGrantDecision(swapped, opts).reason, 'bad_signature');
    // C's key claiming to be A (kid and device_id both say A).
    assert.equal(C.checkGrantDecision(resign(opened(good), A.deviceId, C3.signer.sign), opts).reason, 'bad_signature');
    // Wrong front door and a bad signature: the signature decides.
    const elsewhere = resign({ ...opened(good), frontdoor_id: 'kl-c2ubd6jjqumalzt5' }, A.deviceId, zeroSig);
    assert.equal(C.checkGrantDecision(elsewhere, opts).reason, 'bad_signature');
    // kid must be device_id, and a phone message must be ES256.
    assert.equal(C.checkGrantDecision(resign({ ...opened(good), device_id: C3.deviceId }, A.deviceId, A.signer.sign), opts).reason, 'malformed');
    assert.equal(C.checkGrantDecision({ ...good, alg: 'Ed25519' }, opts).reason, 'malformed');
  });

  it('refuses test keys unless the store allows them; the store only allows them for a literal true', async () => {
    const s = await approverStoreWith([A.approverRecord()], { allowTestKeys: false, now: () => NOW });
    stores.push(s);
    const p = pending();
    const r = C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW });
    assert.equal(r.reason, 'test_key');
    const rm = A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge: crypto.randomBytes(32).toString('base64url') });
    const atLoad = { approverStore: s, type: 'kl.node.remove', frontdoorId: FD.nodeId, acceptedAt: '2026-09-19T00:00:00.000Z' };
    assert.equal(C.verifyPhoneEnvelope(rm, atLoad).reason, 'test_key');
    assert.equal(new ApproverStore({ dir: s.baseDir }).allowTestKeys, false);
    assert.equal(new ApproverStore({ dir: s.baseDir, allowTestKeys: 'true' }).allowTestKeys, false);
  });

  it('refuses a demo device and a device staged for removal (overlay)', async () => {
    const demo = createFakePhone({ platform: 'demo' });
    const s = await approverStoreWith([A.approverRecord(), demo.approverRecord()], { overlay: [A.deviceId], allowTestKeys: true, now: () => NOW });
    stores.push(s);
    const p = pending({ claimed_by: null });
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    assert.equal(C.checkGrantDecision(demo.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'demo_device');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'revoked_device');
  });

  it('binds a grant to every pending field and to an unused nonce', async () => {
    const s = await store();
    const p = pending();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    const changes = [
      ['client_id', `dcr_${id22('other')}`], ['redirect_uri', 'https://client.example.com/cb2'],
      ['resource', 'https://mcp.kl.example.com/other'], ['code_challenge', crypto.createHash('sha256').update('w').digest('base64url')]
    ];
    for (const [k, v] of changes) {
      assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, [k]: v } }), opts).reason, 'binding_mismatch', k);
    }
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, grant_id: `gr_${id22('other')}` } }), opts).reason, 'unknown_request');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { ...opts, pending: null }).reason, 'unknown_request');
    // The claimant is checked before anything else about the request.
    const late = C3.grant({ frontdoorId: FD.nodeId, pending: { ...p, redirect_uri: 'https://evil.example.com/cb' } });
    assert.equal(C.checkGrantDecision(late, { ...opts, now: NOW + 300001 }).reason, 'not_claimant');
    // A deny is bound and replay-checked the same way.
    const n = crypto.randomBytes(32).toString('base64url');
    const deny = A.grant({ frontdoorId: FD.nodeId, pending: p, decision: 'deny', nonce: n });
    assert.equal(C.checkGrantDecision(deny, { ...opts, pending: { ...p, nonces: new Set([n]) } }).reason, 'replay');
  });

  it('binds an enrollment to every pairing field and to an unused nonce', async () => {
    const s = await store();
    const gpu = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
    const other = testNodeIdentity();
    const pr = {
      pairing_id: `pr_${id22('p')}`, node_id: gpu.nodeId, node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(gpu.publicKey),
      tls_fingerprint: 'c'.repeat(64), replaces: null, expires_at_ms: NOW + 600000, nonces: new Set()
    };
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pairing: pr, now: NOW };
    const changes = { node_name: 'web-01', tls_fingerprint: 'd'.repeat(64), replaces: 'kl-c2ubd6jjqumalzt5' };
    for (const [k, v] of Object.entries(changes)) {
      assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, [k]: v } }), opts).reason, 'binding_mismatch', k);
    }
    const swappedKey = { ...pr, node_id: other.nodeId, public_key: P.rawEd25519(other.publicKey) };
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: swappedKey }), opts).reason, 'binding_mismatch');
    const n = crypto.randomBytes(32).toString('base64url');
    const replayed = A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr, nonce: n });
    assert.equal(C.checkNodeEnroll(replayed, { ...opts, pairing: { ...pr, nonces: new Set([n]) } }).reason, 'replay');
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr }), { ...opts, pairing: null }).reason, 'unknown_pairing');
  });

  it('challenges are 32 CSPRNG bytes, per device, and only a verified message consumes one', async () => {
    const s = await store();
    let now = NOW;
    const ch = new Challenges({ now: () => now });
    const seen = new Set();
    for (let i = 0; i < 20; i += 1) {
      const { challenge } = ch.issue(A.deviceId);
      assert.equal(Buffer.from(challenge, 'base64url').length, 32);
      seen.add(challenge);
    }
    assert.equal(seen.size, 20);
    const fresh = new Challenges({ now: () => now });
    const opts = { approverStore: s, frontdoorId: FD.nodeId, challenges: fresh };
    const { challenge } = fresh.issue(A.deviceId);
    const grantId = `gr_${id22('g')}`;
    // Another phone cannot use A's challenge, and trying does not burn it.
    assert.equal(C.checkClientRevoke(B.revokeClient({ frontdoorId: FD.nodeId, grantId, challenge }), opts).reason, 'unknown_challenge');
    // Neither does a forged or misdirected message.
    const good = A.revokeClient({ frontdoorId: FD.nodeId, grantId, challenge });
    assert.equal(C.checkClientRevoke({ ...good, sig: Buffer.alloc(64).toString('base64url') }, opts).reason, 'bad_signature');
    assert.equal(C.checkClientRevoke(A.revokeClient({ frontdoorId: 'kl-c2ubd6jjqumalzt5', grantId, challenge }), opts).reason, 'wrong_frontdoor');
    const unissued = A.revokeClient({ frontdoorId: FD.nodeId, grantId, challenge: crypto.randomBytes(32).toString('base64url') });
    assert.equal(C.checkClientRevoke(unissued, opts).reason, 'unknown_challenge');
    assert.equal(C.checkClientRevoke(good, opts).ok, true);
    // Used once, it is used for every message type.
    assert.equal(C.checkNodeRemove(A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge }), opts).reason, 'challenge_reused');
    const late = fresh.issue(A.deviceId).challenge;
    now += 120001;
    assert.equal(C.checkNodeRemove(A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge: late }), opts).reason, 'challenge_expired');
  });

  it('every check returns a refusal, never throws, on garbage', async () => {
    const s = await store();
    const ch = new Challenges({ now: () => NOW });
    const good = A.grant({ frontdoorId: FD.nodeId, pending: pending() });
    const junk = [null, undefined, 'x', 42, [], {}, { ...good, payload: '!!' }, { ...good, payload: Buffer.from('{').toString('base64url') },
      { ...good, extra: 1 }, { ...good, sig: 7 },
      A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge: crypto.randomBytes(32).toString('base64url') })];
    const calls = [
      (e) => C.checkGrantDecision(e, { approverStore: s, frontdoorId: FD.nodeId, pending: pending(), now: NOW }),
      (e) => C.checkClientRevoke(e, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }),
      (e) => C.checkNodeRemove(e, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }),
      (e) => C.checkNodeEnroll(e, { approverStore: s, frontdoorId: FD.nodeId, pairing: null, now: NOW }),
      (e) => C.checkNodePair(e, { frontdoorHost: 'mcp.kl.example.com' }),
      (e) => C.verifyPairAccept(e, { nodeId: 'kl-c2ubd6jjqumalzt5', nonce: 'x' }),
      (e) => C.verifyRepin(e, { frontdoorId: FD.nodeId, frontdoorPublicKey: P.rawEd25519(FD.publicKey), receivedSpki: 'x', currentPin: 'y' }),
      (e) => C.verifyRepin(e, { frontdoorId: FD.nodeId, frontdoorPublicKey: 'not a key', receivedSpki: 'x', currentPin: 'y' })
    ];
    for (const [i, call] of calls.entries()) {
      for (const e of junk) {
        const r = call(e);
        assert.equal(r.ok, false, `call ${i}`);
        assert.equal(typeof r.reason, 'string', `call ${i}`);
      }
    }
  });
});
