// tests/lease-vectors.test.js
//
// Every lease-v1 vector through the production checks, the committed files
// equal to what generate.js builds, and the other vector sets untouched.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { NonceCache } = require('../src/approvals/verify-device');
const L = require('../src/gui/lease-protocol');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/lease-v1/generate');

setLogLevel('fatal');
const DIR = path.join(__dirname, 'vectors', 'lease-v1');
const EXPECTED = [
  'grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'grant-phone-clock-behind', 'bad-signature', 'revoked-device',
  'unknown-device', 'demo-device', 'test-key', 'wrong-node', 'replay', 'unknown-request', 'lease-hash-mismatch',
  'lease-changed-app-path', 'apps-not-requested', 'minutes-over-requested', 'minutes-over-60', 'expired', 'revoke-valid',
  'revoke-phone-clock-off', 'revoke-unknown-lease', 'revoke-replayed', 'watch-valid', 'watch-no-token', 'watch-bad-token',
  'status-valid', 'status-no-contact', 'status-pending', 'status-granted-unnamed', 'view-node-sig-valid', 'view-tampered-frame',
  'listing-none', 'listing-live', 'listing-nonce-mismatch', 'listing-status-withheld', 'listing-status-stale', 'listing-other-device', 'listing-bad-signature',
  // Fourth security review: another pinned node's listing, an extra status beside one, and the shape (each lease once, at most eight, exact keys, a real time).
  'listing-other-node', 'listing-wrong-node', 'listing-extra-status', 'listing-duplicate-lease', 'listing-too-many', 'listing-extra-key', 'listing-bad-at',
  // Revised 2026-10-24: the take lease (demo takes spec §6).
  'take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take'
];
const PHONE = ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid', 'watch-no-token',
  'status-valid', 'status-no-contact', 'status-pending', 'status-granted-unnamed', 'view-node-sig-valid', 'view-tampered-frame',
  'listing-none', 'listing-live', 'listing-nonce-mismatch', 'listing-status-withheld', 'listing-status-stale', 'listing-other-device', 'listing-bad-signature',
  'listing-other-node', 'listing-wrong-node', 'listing-extra-status', 'listing-duplicate-lease', 'listing-too-many', 'listing-extra-key', 'listing-bad-at',
  'take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function run(v) {
  const g = v.given;
  const now = Date.parse(g.now);
  if (v.name.startsWith('view-')) return L.verifyLeaseView(v.input, { nodeId: g.node.id, nodePublicKeyHex: g.node.key });
  if (v.name.startsWith('status-')) return verifyStatus(v.input, g.node);
  // A node-signed request checked for its shape (VALIDATORS['kl.lease.request']).
  if (v.check === 'request') return verifyRequest(v.input, g.node);
  // R-F5-20: what a phone checks on a listing, with its own nonce and device id.
  if (v.name.startsWith('listing-')) return L.verifyLeaseListing(v.input, { nodeId: g.node.id, nodePublicKeyHex: g.node.key, nonce: g.nonce, deviceId: g.device_id, statuses: g.statuses });
  const store = await approverStoreWith(g.approvers, { allowTestKeys: g.allow_test_keys, now: () => now });
  stores.push(store);
  const nonces = new NonceCache({ now: () => now });
  for (const u of g.used) nonces.add(u.nonce, u.sha256);
  if (v.name.startsWith('revoke-')) return L.verifyLeaseRevoke(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  if (v.name.startsWith('watch-')) return L.verifyLeaseWatch(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  const pending = new Map(g.pending.map((p) => [p.request_id, p]));
  return L.verifyLeaseGrant(v.input, {
    approverStore: store, nodeId: g.node.id, nonces, pending, guiApps: g.gui_apps,
    jobOpen: (jobId) => g.jobs_open.includes(jobId), guiMaxMinutes: g.gui_max_minutes, guiTakeMaxMinutes: g.gui_take_max_minutes
  }, now);
}

// What a phone checks on a status: the pinned node's signature over the
// received bytes, the node id, and the shape.
function verifyStatus(envelope, node) {
  const { open, verifyEd25519 } = require('../src/approvals/envelope');
  const { validateMessage } = require('../src/approvals/messages');
  if (envelope.alg !== 'Ed25519' || envelope.kid !== node.id) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, node.key)) return { accepted: false, reason: 'bad_signature' };
  const { message } = open(envelope);
  if (validateMessage('kl.lease.status', message)) return { accepted: false, reason: 'malformed' };
  if (message.node_id !== node.id) return { accepted: false, reason: 'wrong_node' };
  return { accepted: true, reason: null, message };
}

// What a phone checks on a request: the pinned node's signature, the shape, the lease hash.
function verifyRequest(envelope, node) {
  const { open, verifyEd25519 } = require('../src/approvals/envelope');
  if (envelope.alg !== 'Ed25519' || envelope.kid !== node.id) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, node.key)) return { accepted: false, reason: 'bad_signature' };
  const { message } = open(envelope);
  if (!L.VALIDATORS['kl.lease.request'](message)) return { accepted: false, reason: 'malformed' };
  if (message.lease_hash !== L.leaseHash(message.lease)) return { accepted: false, reason: 'lease_hash_mismatch' };
  return { accepted: true, reason: null, message };
}

describe('lease-v1 vectors', () => {
  // Fourth security review: the listing vectors that are refused for their
  // shape or their signer are what they say they are (so a phone core that
  // refuses them refuses them for that, and not for a broken signature).
  it('the new listing vectors: validly signed, and wrong in exactly the way their names say', () => {
    const { open } = require('../src/approvals/envelope');
    const { verifyEd25519 } = require('../src/approvals/envelope');
    const read = (name) => { const v = byName.get(name); return { v, m: open(v.input).message }; };
    // Another pinned node's own listing: its signature is good under its own key, and it is not this node's.
    const other = read('listing-other-node');
    assert.notEqual(other.v.input.kid, other.v.given.node.id);
    assert.equal(other.m.node_id, other.v.input.kid);
    assert.equal(verifyEd25519(other.v.input, other.v.given.node.key), false);
    // This node's key over a listing that names another node.
    const wrong = read('listing-wrong-node');
    assert.equal(wrong.v.input.kid, wrong.v.given.node.id);
    assert.equal(verifyEd25519(wrong.v.input, wrong.v.given.node.key), true);
    assert.notEqual(wrong.m.node_id, wrong.v.given.node.id);
    // Signed by this node, for this phone and this nonce; only the shape is off.
    for (const name of ['listing-duplicate-lease', 'listing-too-many', 'listing-extra-key', 'listing-bad-at']) {
      const { v, m } = read(name);
      assert.equal(verifyEd25519(v.input, v.given.node.key), true, name);
      assert.deepEqual([m.node_id, m.nonce, m.to_device], [v.given.node.id, v.given.nonce, v.given.device_id], name);
      assert.deepEqual([v.expect.accepted, v.expect.reason], [false, 'malformed'], name);
    }
    const dup = read('listing-duplicate-lease').m.leases;
    assert.equal(dup.length, 2);
    assert.equal(dup[0].lease_id, dup[1].lease_id);
    assert.notEqual(dup[0].seq, dup[1].seq);
    // Both statuses it names are beside it: only the repeat is wrong.
    assert.equal(byName.get('listing-duplicate-lease').given.statuses.length, 2);
    const many = read('listing-too-many').m.leases;
    assert.equal(many.length, L.LISTING_MAX + 1);
    assert.equal(new Set(many.map((l) => l.lease_id)).size, many.length);
    assert.ok(Object.hasOwn(read('listing-extra-key').m, 'note'));
    assert.equal(read('listing-bad-at').m.at, '2026-02-30T18:04:11.201Z', 'the right form, and no such day');
    // An extra status beside the listing is not taken: the phone knows of exactly what the listing names.
    const extra = byName.get('listing-extra-status');
    assert.equal(extra.given.statuses.length, 2);
    assert.equal(extra.expect.leases.length, 1);
  });

  it('has exactly the expected set, and phones consume exactly theirs', () => {
    assert.equal(EXPECTED.length, 51);
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    for (const phone of ['ios', 'android']) {
      assert.deepEqual(vectors.filter((v) => v.consumers.includes(phone)).map((v) => v.name).sort(), [...PHONE].sort());
    }
    assert.ok(vectors.every((v) => v.consumers.includes('node')));
  });

  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(serialize(byName.get(v.name)), serialize(v), v.name);
  });

  it('approval-v1 and client-grant-v1 are untouched', () => {
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'approval-v1')).filter((f) => f.endsWith('.json') && f !== 'keys.json' && f !== 'jcs.json').length > 0, true);
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'client-grant-v1')).filter((f) => f.endsWith('.json')).length, 37);
  });

  for (const name of EXPECTED) {
    it(name, async () => {
      const v = byName.get(name);
      const r = await run(v);
      assert.equal(r.accepted, v.expect.accepted, `${name}: ${r.reason}`);
      assert.equal(r.reason, v.expect.reason);
      if (v.check !== null && v.check !== 'request' && !name.startsWith('view-') && !name.startsWith('listing-')) assert.equal(r.check, v.check);
      // The fields a phone reads from a status or a view, the contact token among them.
      if (v.expect.status) for (const [key, value] of Object.entries(v.expect.status)) assert.deepEqual(r.message[key], value, `${name}: ${key}`);
      if (v.expect.contact_token) assert.equal(r.message.contact_token, v.expect.contact_token);
      // What a phone knows of a node after a listing it accepted: every lease the node listed, in its order.
      if (v.expect.leases) assert.deepEqual(r.statuses.map((s) => ({ lease_id: s.lease_id, seq: s.seq, state: s.state })), v.expect.leases);
      if (name.startsWith('listing-') && !v.expect.accepted) assert.equal(r.statuses, undefined, 'a refused listing gives nothing to show');
    });
  }

  it('resume-capped: a resume never extends past the original expiry', () => {
    const v = byName.get('resume-capped');
    const eff = L.effectiveExpiry({ verifiedAt: Date.parse(v.given.now), minutes: 4, resumeOf: Date.parse(v.given.resume_of) });
    assert.equal(new Date(eff).toISOString(), v.expect.effective_expires_at);
  });

  it('the phone-built messages are exactly the signed payloads', () => {
    for (const name of ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'take-grant', 'revoke-valid', 'watch-valid', 'watch-no-token']) {
      const v = byName.get(name);
      const payload = JSON.parse(Buffer.from(v.input.payload, 'base64url').toString('utf8'));
      assert.deepEqual(payload, v.expect.message, name);
    }
  });
});

describe('lease-v1 message shapes', () => {
  it('the node-signed request validates and hashes its lease', () => {
    const v = byName.get('grant-valid');
    const { open } = require('../src/approvals/envelope');
    const { validateMessage } = require('../src/approvals/messages');
    const { message } = open(v.given.request);
    assert.equal(validateMessage('kl.lease.request', message), null);
    assert.equal(message.lease_hash, L.leaseHash(message.lease));
    assert.ok(Date.parse(message.expires_at) - Date.parse(message.created_at) <= L.REQUEST_TTL_MS);
  });

  it('refuses unknown keys and out-of-range fields', () => {
    const { validateMessage } = require('../src/approvals/messages');
    const v = byName.get('revoke-valid');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, extra: 1 }), 'malformed');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, reason: 'because' }), 'malformed');
    assert.equal(validateMessage('kl.lease.watch', { ...byName.get('watch-valid').expect.message, lease_id: 'x' }), 'malformed');
  });
});
