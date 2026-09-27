#!/usr/bin/env node
// tests/vectors/client-grant-v1/generate.js
//
// Rebuilds every client-grant-v1 vector from ../approval-v1/keys.json.
//   node tests/vectors/client-grant-v1/generate.js          write the files
//   node tests/vectors/client-grant-v1/generate.js --check  exit 1 if any differ
//
// Keys are the fixed test keys (or seeded from fixed labels), times are fixed
// and the node certificate is built from a seeded Ed25519 key, so everything
// is deterministic except ECDSA: P-256 signatures are randomized, so a
// signature already committed for the same payload (and valid for it) is
// reused. That keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seal, verifyEs256, fromB64url, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { deriveNodeId } = require('../../../src/mesh/node-identity');
const P = require('../../../src/frontdoor/protocol/messages');
const { FLEET_SCOPE_RULES } = require('../../../src/frontdoor/protocol/checks');

const DIR = __dirname;
const KEYS = require('../approval-v1/keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const b64 = (label, n = 32) => sha(label).subarray(0, n).toString('base64url');
const nonceOf = (label) => b64(`cg nonce ${label}`);
const idOf = (prefix, label) => `${prefix}${b64(`cg id ${label}`, 16)}`;
const RULES = { supported: [...FLEET_SCOPE_RULES.supported], requires: { 'fleet:unsafe': [...FLEET_SCOPE_RULES.requires['fleet:unsafe']] } };

const ed25519Key = (seed) => crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });

function nodeIdentity(name) {
  const key = ed25519Key(Buffer.from(KEYS.nodes[name].seed, 'hex'));
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, publicKey: spki, sign: (b) => crypto.sign(null, b, key) };
}

// ── A deterministic self-signed node TLS certificate ────────────────────────
// Ed25519 signatures are deterministic, so a seeded key, a fixed serial and a
// fixed validity give the same DER on every run.
function der(tag, body) {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...parts) => der(0x30, Buffer.concat(parts));

function nodeCertPem(cn) {
  const key = ed25519Key(sha(`client-grant-v1 ${cn} tls key`));
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const ed25519 = seq(Buffer.from('06032b6570', 'hex'));
  const name = seq(der(0x31, seq(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from(cn, 'utf8')))));
  const validity = seq(der(0x17, Buffer.from('260901000000Z')), der(0x17, Buffer.from('360901000000Z')));
  const serial = der(0x02, Buffer.from('01', 'hex'));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), serial, ed25519, name, validity, name, spki);
  const cert = seq(tbs, ed25519, der(0x03, Buffer.concat([Buffer.from([0]), crypto.sign(null, tbs, key)])));
  const lines = cert.toString('base64').match(/.{1,64}/g);
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function p256(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, key: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

const DEVICE_D = {
  A: KEYS.devices.A.d,
  B: KEYS.devices.B.d,
  C: KEYS.devices.C.d,
  // Not in keys.json: an approver whose record says platform 'demo'.
  D: sha('client-grant-v1 demo device').toString('base64url'),
  // Not in keys.json and never an approver: the "unknown device" signer.
  U: sha('client-grant-v1 unknown device').toString('base64url')
};

function committedDocs() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')));
}

function loadSigCache(docs) {
  const cache = new Map();
  const jwks = new Map(Object.values(DEVICE_D).map((d) => { const { jwk } = p256(d); return [deviceIdFromJwk(jwk), jwk]; }));
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.alg === 'ES256' && typeof v.kid === 'string' && typeof v.payload === 'string' && typeof v.sig === 'string') {
      const jwk = jwks.get(v.kid);
      if (jwk && verifyEs256(v, jwk)) cache.set(`${v.kid}:${v.payload}`, v.sig);
    }
    for (const child of Object.values(v)) walk(child);
  };
  for (const doc of docs) walk(doc);
  return cache;
}

function device(name, cache) {
  const { jwk, key } = p256(DEVICE_D[name]);
  const id = deviceIdFromJwk(jwk);
  return {
    id,
    jwk,
    signer: {
      alg: 'ES256',
      kid: id,
      sign(bytes) {
        const payload = Buffer.from(bytes).toString('base64url');
        const cached = cache.get(`${id}:${payload}`);
        if (cached && verifyEs256({ alg: 'ES256', kid: id, payload, sig: cached }, jwk)) return fromB64url(cached);
        const sig = crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
        cache.set(`${id}:${payload}`, sig.toString('base64url'));
        return sig;
      }
    }
  };
}

function approver(dev, extra = {}) {
  return {
    v: 1, device_id: dev.id, name: `Test phone ${dev.id.slice(2, 6)}`, platform: 'android', public_key: dev.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: null, revoked_by: null, enrollment: null, ...extra
  };
}

// Same payload bytes signed, but the payload is not JCS: `open` refuses it.
function nonCanonical(message, signer) {
  const bytes = Buffer.from(JSON.stringify(message, null, 1), 'utf8');
  return { alg: signer.alg, kid: signer.kid, payload: bytes.toString('base64url'), sig: signer.sign(bytes).toString('base64url') };
}

function flipSig(env) {
  const sig = fromB64url(env.sig);
  sig[0] ^= 1;
  return { ...env, sig: sig.toString('base64url') };
}

function buildVectors({ docs = committedDocs() } = {}) {
  const cache = loadSigCache(docs);
  const A = device('A', cache);
  const B = device('B', cache);
  const C = device('C', cache);
  const U = device('U', cache);
  const D = device('D', cache);
  const fd = nodeIdentity('relay');
  const gpu = nodeIdentity('gpu-box');
  const web = nodeIdentity('web-01');
  const frontdoor = { id: fd.nodeId, key: P.rawEd25519(fd.publicKey) };
  const approvers = [approver(A), approver(C), approver(B, { revoked_at: '2026-09-20T00:00:00.000Z', revoked_by: 'console' }), approver(D, { platform: 'demo' })];
  const vectors = [];
  const add = (v) => vectors.push(v);

  // ── Grants ────────────────────────────────────────────────────────────
  const pending = {
    grant_id: idOf('gr_', 'grant'), client_id: idOf('dcr_', 'client'), client_name: 'Example Client', client_host: 'client.example.com',
    redirect_uri: 'https://client.example.com/cb', resource: 'https://mcp.kl.example.com/mcp', code_challenge: b64('code challenge'),
    user_code: 'Q7KM2X', requested_scopes: ['fleet:read', 'fleet:run'], expires_at: iso(NOW_MS + 300000), claimed_by: A.id, used_nonces: []
  };
  const grantMessage = (dev, p, { decision = 'approve', scopes = null, nonce = nonceOf('grant'), signedAt = iso(NOW_MS + 2000), frontdoorId = fd.nodeId } = {}) => ({
    v: 1, type: 'kl.client.grant', frontdoor_id: frontdoorId, grant_id: p.grant_id, client_id: p.client_id, client_name: p.client_name,
    redirect_uri: p.redirect_uri, resource: p.resource, code_challenge: p.code_challenge, user_code: p.user_code,
    scopes: decision === 'deny' ? [] : (scopes || p.requested_scopes.map((scope) => ({ scope, machines: null }))),
    decision, nonce, device_id: dev.id, signed_at: signedAt
  });
  const grant = (name, env, { p = pending, now = NOW, accepted, reason = null, consumers = ['node'], message = null }) => add({
    name, consumers, given: { now, frontdoor, approvers, allow_test_keys: true, pending: p, scopes: RULES },
    input: env, expect: message ? { accepted, reason, message } : { accepted, reason }
  });

  const approveMsg = grantMessage(A, pending, { scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }] });
  grant('grant-approve', seal(approveMsg, A.signer), { accepted: true, consumers: ['node', 'ios', 'android'], message: approveMsg });
  const denyMsg = grantMessage(A, pending, { decision: 'deny', nonce: nonceOf('deny') });
  grant('grant-deny', seal(denyMsg, A.signer), { accepted: true, consumers: ['node', 'ios', 'android'], message: denyMsg });
  grant('grant-reject-user-code-mismatch', seal(grantMessage(A, { ...pending, user_code: 'Q7KM2Y' }), A.signer), { accepted: false, reason: 'user_code_mismatch' });
  grant('grant-reject-wrong-frontdoor', seal(grantMessage(A, pending, { frontdoorId: web.nodeId }), A.signer), { accepted: false, reason: 'wrong_frontdoor' });
  grant('grant-reject-expired', seal(grantMessage(A, pending), A.signer), { now: iso(NOW_MS + 300001), accepted: false, reason: 'expired' });
  grant('grant-reject-code-challenge-changed', seal(grantMessage(A, { ...pending, code_challenge: b64('other challenge') }), A.signer), { accepted: false, reason: 'binding_mismatch' });
  grant('grant-reject-redirect-uri-changed', seal(grantMessage(A, { ...pending, redirect_uri: 'https://client.example.com/other' }), A.signer), { accepted: false, reason: 'binding_mismatch' });
  grant('grant-reject-client-name-changed', seal(grantMessage(A, { ...pending, client_name: 'Other Client' }), A.signer), { accepted: false, reason: 'binding_mismatch' });
  grant('grant-reject-scope-widened', seal(grantMessage(A, pending, { scopes: [{ scope: 'fleet:delegate', machines: null }, { scope: 'fleet:read', machines: null }] }), A.signer), { accepted: false, reason: 'invalid_scope' });
  grant('grant-reject-machines-unsorted', seal(grantMessage(A, pending, { scopes: [{ scope: 'fleet:run', machines: ['web-01', 'gpu-box'] }] }), A.signer), { accepted: false, reason: 'malformed' });
  const unsafePending = { ...pending, requested_scopes: ['fleet:read', 'fleet:unsafe'] };
  grant('grant-reject-unsafe-only', seal(grantMessage(A, unsafePending), A.signer), { p: unsafePending, accepted: false, reason: 'invalid_scope' });
  const unclaimed = { ...pending, claimed_by: null };
  grant('grant-reject-unknown-device', seal(grantMessage(U, unclaimed), U.signer), { p: unclaimed, accepted: false, reason: 'unknown_device' });
  grant('grant-reject-demo-device', seal(grantMessage(D, unclaimed), D.signer), { p: unclaimed, accepted: false, reason: 'demo_device' });
  grant('grant-reject-unknown-request', seal(grantMessage(A, { ...pending, grant_id: idOf('gr_', 'other grant') }), A.signer), { accepted: false, reason: 'unknown_request' });
  grant('grant-reject-revoked-device', seal(grantMessage(B, unclaimed), B.signer), { p: unclaimed, accepted: false, reason: 'revoked_device' });
  grant('grant-reject-nonce-replay', seal(grantMessage(A, pending, { nonce: nonceOf('used') }), A.signer), { p: { ...pending, used_nonces: [nonceOf('used')] }, accepted: false, reason: 'replay' });
  grant('grant-reject-noncanonical', nonCanonical(grantMessage(A, pending), A.signer), { accepted: false, reason: 'malformed' });
  grant('grant-reject-not-claimant', seal(grantMessage(C, pending), C.signer), { accepted: false, reason: 'not_claimant' });
  grant('grant-accept-phone-clock-ahead', seal(grantMessage(A, pending, { signedAt: iso(NOW_MS + 86400000) }), A.signer), { accepted: true });

  // ── Client revocation (approval-v1 already has a `revoke-valid`) ──────
  const challenge = nonceOf('challenge');
  const revokeMsg = { v: 1, type: 'kl.client.revoke', frontdoor_id: fd.nodeId, grant_id: pending.grant_id, challenge, device_id: A.id, signed_at: iso(NOW_MS + 1000) };
  const revoke = (name, { issued = challenge, purpose = 'revoke', used = false, expiresAt = iso(NOW_MS + 60000), accepted, reason = null, consumers = ['node'], message = null }) => add({
    name, consumers,
    given: { now: NOW, frontdoor, approvers, allow_test_keys: true, challenges: [{ challenge: issued, device_id: A.id, purpose, expires_at: expiresAt, used }] },
    input: seal(revokeMsg, A.signer), expect: message ? { accepted, reason, message } : { accepted, reason }
  });
  revoke('client-revoke-valid', { accepted: true, consumers: ['node', 'ios', 'android'], message: revokeMsg });
  revoke('client-revoke-reject-challenge-reused', { used: true, accepted: false, reason: 'challenge_reused' });
  revoke('client-revoke-reject-challenge-expired', { expiresAt: iso(NOW_MS - 1000), accepted: false, reason: 'challenge_expired' });
  // The store holds a live challenge for A, but not the one A signed.
  revoke('client-revoke-reject-challenge-unknown', { issued: nonceOf('other challenge'), accepted: false, reason: 'unknown_challenge' });
  revoke('client-revoke-reject-challenge-wrong-purpose', { purpose: 'remove', accepted: false, reason: 'challenge_wrong_purpose' });

  // ── Node enrollment and removal ───────────────────────────────────────
  const tlsCert = nodeCertPem('gpu-box');
  const tlsFingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(tlsCert).raw).digest('hex');
  const pairing = {
    pairing_id: idOf('pr_', 'pairing'), node_id: gpu.nodeId, node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(gpu.publicKey),
    tls_fingerprint: tlsFingerprint, replaces: null, expires_at: iso(NOW_MS + 600000), used_nonces: []
  };
  const enrollMessage = (over = {}) => ({
    v: 1, type: 'kl.node.enroll', frontdoor_id: fd.nodeId, pairing_id: pairing.pairing_id, node_id: pairing.node_id, node_name: pairing.node_name,
    profile: pairing.profile, public_key: pairing.public_key, tls_fingerprint: pairing.tls_fingerprint, replaces: null,
    decision: 'approve', nonce: nonceOf('enroll'), device_id: A.id, signed_at: iso(NOW_MS + 3000), ...over
  });
  const enroll = (name, message, { accepted, reason = null, consumers = ['node'], withMessage = false }) => add({
    name, consumers, given: { now: NOW, frontdoor, approvers, allow_test_keys: true, pairing },
    input: seal(message, A.signer), expect: withMessage ? { accepted, reason, message } : { accepted, reason }
  });
  enroll('enroll-valid', enrollMessage(), { accepted: true, consumers: ['node', 'ios', 'android'], withMessage: true });
  enroll('enroll-reject-node-id-mismatch', enrollMessage({ node_id: web.nodeId }), { accepted: false, reason: 'node_id_mismatch' });
  enroll('enroll-reject-unknown-pairing', enrollMessage({ pairing_id: idOf('pr_', 'other pairing') }), { accepted: false, reason: 'unknown_pairing' });

  const removeChallenge = nonceOf('remove challenge');
  const removeMsg = { v: 1, type: 'kl.node.remove', frontdoor_id: fd.nodeId, node_id: gpu.nodeId, challenge: removeChallenge, device_id: A.id, signed_at: iso(NOW_MS + 1000) };
  add({
    name: 'remove-valid', consumers: ['node', 'ios', 'android'],
    given: { now: NOW, frontdoor, approvers, allow_test_keys: true, challenges: [{ challenge: removeChallenge, device_id: A.id, purpose: 'remove', expires_at: iso(NOW_MS + 60000), used: false }] },
    input: seal(removeMsg, A.signer), expect: { accepted: true, reason: null, message: removeMsg }
  });

  // ── Pairing (node ↔ front door) ───────────────────────────────────────
  const code = 'abandon ability able about above absent';
  const pairEnv = P.buildNodePair({ identity: gpu, frontdoorHost: 'mcp.kl.example.com', code, profile: 'agent', capabilities: ['gpu', 'cuda', 'large-disk'], tlsCertPem: tlsCert, nonce: nonceOf('pair'), now: NOW_MS });
  const pairGiven = { frontdoor_host: 'mcp.kl.example.com', allow_test_keys: true };
  add({ name: 'pair-valid', consumers: ['node'], given: pairGiven, input: pairEnv, expect: { accepted: true, reason: null, node_id: gpu.nodeId, tls_fingerprint: tlsFingerprint, code_hash: P.pairingCodeHash(code) } });
  add({ name: 'pair-reject-bad-signature', consumers: ['node'], given: pairGiven, input: flipSig(pairEnv), expect: { accepted: false, reason: 'bad_signature' } });
  // gpu-box's key is published in keys.json: a front door built without allowTestKeys refuses it.
  add({ name: 'pair-reject-test-key', consumers: ['node'], given: { ...pairGiven, allow_test_keys: false }, input: pairEnv, expect: { accepted: false, reason: 'test_key' } });
  const acceptEnv = P.buildNodePairAccept({ identity: fd, pairingId: pairing.pairing_id, nodeId: gpu.nodeId, nonce: nonceOf('pair'), meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: sha('front door mesh cert').toString('hex') });
  add({ name: 'pair-accept-valid', consumers: ['node'], given: { node_id: gpu.nodeId, nonce: nonceOf('pair') }, input: acceptEnv, expect: { accepted: true, reason: null, frontdoor_id: fd.nodeId } });

  // ── Re-pin ─────────────────────────────────────────────────────────────
  const oldSpki = `sha256/${b64('old spki')}`;
  const newSpki = `sha256/${b64('new spki')}`;
  const repinEnv = P.buildRelayRepin({ identity: fd, relay: 'https://mcp.kl.example.com', oldSpki, newSpki, now: NOW_MS });
  const repinGiven = { frontdoor, received_spki: newSpki, current_pin: oldSpki };
  add({ name: 'repin-valid', consumers: ['node', 'ios', 'android'], given: repinGiven, input: repinEnv, expect: { accepted: true, reason: null } });
  add({ name: 'repin-reject-bad-signature', consumers: ['node', 'ios', 'android'], given: repinGiven, input: flipSig(repinEnv), expect: { accepted: false, reason: 'bad_signature' } });
  add({ name: 'repin-reject-spki-mismatch', consumers: ['node', 'ios', 'android'], given: { ...repinGiven, received_spki: `sha256/${b64('other spki')}` }, input: repinEnv, expect: { accepted: false, reason: 'spki_mismatch' } });
  add({ name: 'repin-reject-old-pin-mismatch', consumers: ['node', 'ios', 'android'], given: { ...repinGiven, current_pin: `sha256/${b64('other pin')}` }, input: repinEnv, expect: { accepted: false, reason: 'old_pin_mismatch' } });

  // ── Display ─────────────────────────────────────────────────────────────
  const typed = ['q7k-m2x', 'Q7KM2X', 'o1l abc', 'Q7KM2', 'Q7KM2U'];
  const normalized = typed.map((t) => P.normalizeUserCode(t));
  add({
    name: 'fingerprint-grouping', consumers: ['node', 'ios', 'android'], given: {},
    input: { node_ids: [gpu.nodeId, web.nodeId, fd.nodeId], typed_codes: typed },
    expect: {
      node_fingerprints: [gpu.nodeId, web.nodeId, fd.nodeId].map((n) => P.nodeFingerprint(n)),
      user_codes: normalized,
      displayed: normalized.map((c) => (c ? P.formatUserCode(c) : null))
    }
  });
  return vectors;
}

function serialize(v) {
  return `${JSON.stringify(v, null, 2)}\n`;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  let differ = 0;
  const names = new Set(vectors.map((v) => `${v.name}.json`));
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== text) {
        differ += 1;
        process.stderr.write(`differs: ${v.name}.json\n`);
      }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  // A committed vector the generator no longer builds is stale too.
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && !names.has(n))) {
    if (check) {
      differ += 1;
      process.stderr.write(`not generated: ${f}\n`);
    } else {
      fs.unlinkSync(path.join(DIR, f));
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, NOW };
