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
  'take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take',
  // Revised 2026-10-28: the read key (android-slim spec §8.8). A watch may be
  // signed by either key of its device; a grant or a revoke only by the device key.
  'watch-read-key', 'watch-read-key-not-applied', 'grant-read-key', 'revoke-read-key',
  // Revised 2026-11-03: the task lease (tasks stage 1 spec §4.6).
  'task-request', 'task-grant', 'task-status', 'task-status-no-name', 'task-request-allows-unsorted', 'task-request-allows-repeated',
  'task-request-allows-unknown', 'task-request-resumes', 'task-request-read-only', 'task-request-sites-over-32', 'task-request-bad-site', 'task-request-usd-under',
  'task-request-usd-over', 'task-request-usd-fraction', 'task-request-attended', 'task-request-minutes-over-240', 'task-request-with-apps',
  'task-request-name-hidden', 'task-request-name-too-long', 'task-grant-with-apps', 'task-grant-minutes-over-requested', 'task-grant-minutes-over-240',
  'task-grant-ignores-take-cap', 'computer-use-grant-no-apps', 'take-grant-no-apps',
  // Revised 2026-11-04: sealed. The phones read all but the changed lease.
  'request-sealed', 'grant-to-sealed', 'grant-sealed-lease-changed', 'status-sealed', 'view-sealed', 'listing-with-sealed-status'
];
// What the phones consume (android-slim spec §5): iOS consumes PHONE, Android
// PHONE and the read-key vectors a phone signs (iOS has no read key).
const ANDROID_READ_KEY = ['watch-read-key'];
const PHONE = ['request-sealed', 'grant-to-sealed', 'status-sealed', 'view-sealed', 'listing-with-sealed-status',
  'grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid', 'watch-no-token',
  'status-valid', 'status-no-contact', 'status-pending', 'status-granted-unnamed', 'view-node-sig-valid', 'view-tampered-frame',
  'listing-none', 'listing-live', 'listing-nonce-mismatch', 'listing-status-withheld', 'listing-status-stale', 'listing-other-device', 'listing-bad-signature',
  'listing-other-node', 'listing-wrong-node', 'listing-extra-status', 'listing-duplicate-lease', 'listing-too-many', 'listing-extra-key', 'listing-bad-at',
  'take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take',
  // Revised 2026-11-03: the task lease, every vector of it (lease-v1's last section).
  'task-request', 'task-grant', 'task-status', 'task-status-no-name', 'task-request-allows-unsorted', 'task-request-allows-repeated',
  'task-request-allows-unknown', 'task-request-resumes', 'task-request-read-only', 'task-request-sites-over-32', 'task-request-bad-site', 'task-request-usd-under',
  'task-request-usd-over', 'task-request-usd-fraction', 'task-request-attended', 'task-request-minutes-over-240', 'task-request-with-apps',
  'task-request-name-hidden', 'task-request-name-too-long', 'task-grant-with-apps', 'task-grant-minutes-over-requested', 'task-grant-minutes-over-240',
  'task-grant-ignores-take-cap', 'computer-use-grant-no-apps', 'take-grant-no-apps'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function run(v) {
  const g = v.given;
  const now = Date.parse(g.now);
  const opener = openerFor(g);
  if (v.name.startsWith('view-')) return L.verifyLeaseView(v.input, { nodeId: g.node.id, nodePublicKeyHex: g.node.key, open: opener });
  if (v.name.startsWith('status-') || v.name.startsWith('task-status')) return verifyStatus(v.input, g.node, opener);
  // A node-signed request checked for its shape (VALIDATORS['kl.lease.request']).
  if (v.check === 'request') return verifyRequest(v.input, g.node, opener);
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

// What opens a sealed vector: the phone's box key from given.box.
function openerFor(g) {
  if (!g.box) return null;
  const { open } = require('../src/approvals/envelope');
  const { openSealed } = require('../src/approvals/seal');
  const { createBox } = require('../src/approvals/node-box-key');
  const KEYS = require('./vectors/approval-v1/keys.json');
  const { agree } = createBox(KEYS.devices.A_box.jwk, g.box.d);
  return (envelope, type) => openSealed({ type, message: open(envelope).message, recipientId: g.box.device_id, agree });
}

// What a phone checks on a status: the pinned node's signature over the
// received bytes, the node id, and the shape.
function verifyStatus(envelope, node, opener = null) {
  const { open, verifyEd25519 } = require('../src/approvals/envelope');
  const { validateMessage } = require('../src/approvals/messages');
  if (envelope.alg !== 'Ed25519' || envelope.kid !== node.id) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, node.key)) return { accepted: false, reason: 'bad_signature' };
  const { message } = open(envelope);
  if (validateMessage('kl.lease.status', message)) return { accepted: false, reason: 'malformed' };
  if (message.node_id !== node.id) return { accepted: false, reason: 'wrong_node' };
  if (opener) return { accepted: true, reason: null, message: L.openNodeStatus(envelope, { nodeId: node.id, nodePublicKeyHex: node.key, open: opener }) };
  return { accepted: true, reason: null, message };
}

// What a phone checks on a request: the pinned node's signature, the shape, the lease hash.
function verifyRequest(envelope, node, opener = null) {
  const { open, verifyEd25519 } = require('../src/approvals/envelope');
  if (envelope.alg !== 'Ed25519' || envelope.kid !== node.id) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, node.key)) return { accepted: false, reason: 'bad_signature' };
  const { message } = open(envelope);
  if (!L.VALIDATORS['kl.lease.request'](message)) return { accepted: false, reason: 'malformed' };
  if (message.sealed) {
    const full = opener(envelope, 'kl.lease.request').message;
    const reason = L.validateOpenedLeaseRequest(full);
    return reason ? { accepted: false, reason } : { accepted: true, reason: null, message: full };
  }
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
    assert.equal(EXPECTED.length, 86);
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    const consumedBy = (phone) => vectors.filter((v) => v.consumers.includes(phone)).map((v) => v.name).sort();
    assert.deepEqual(consumedBy('ios'), [...PHONE].sort());
    assert.deepEqual(consumedBy('android'), [...PHONE, ...ANDROID_READ_KEY].sort());
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
      // Which of the device's keys verified a watch (android-slim §8.6).
      if (v.expect.key) assert.equal(r.key, v.expect.key);
      // What a phone knows of a node after a listing it accepted: every lease the node listed, in its order.
      if (v.expect.leases) assert.deepEqual(r.statuses.map((s) => ({ lease_id: s.lease_id, seq: s.seq, state: s.state })), v.expect.leases);
      if (name.startsWith('listing-') && !v.expect.accepted) assert.equal(r.statuses, undefined, 'a refused listing gives nothing to show');
    });
  }

  it('the read-key vectors: signed by the read key of A, which every record but the not-applied one holds, and only a watch may use', () => {
    const { verifyEs256 } = require('../src/approvals/envelope');
    const KEYS = require('./vectors/approval-v1/keys.json');
    const recordA = (v) => v.given.approvers.find((r) => r.device_id === KEYS.devices.A.id);
    for (const name of ['watch-read-key', 'watch-read-key-not-applied', 'grant-read-key', 'revoke-read-key']) {
      const v = byName.get(name);
      assert.equal(v.input.kid, KEYS.devices.A.id, name);
      assert.equal(verifyEs256(v.input, KEYS.devices.A_read.jwk), true, name);
      assert.equal(verifyEs256(v.input, KEYS.devices.A.jwk), false, name);
      if (name === 'watch-read-key-not-applied') assert.equal(Object.hasOwn(recordA(v), 'read_key'), false, name);
      else assert.deepEqual(recordA(v).read_key, KEYS.devices.A_read.jwk, name);
    }
    // The phone builds the same message as for watch-valid; only the key differs.
    const valid = byName.get('watch-valid').expect.message;
    const read = byName.get('watch-read-key').expect.message;
    assert.deepEqual(Object.keys(read).sort(), Object.keys(valid).sort());
    assert.equal(read.device_id, valid.device_id);
  });

  it('the sealed vectors hold in clear only what R-SP-4 says', () => {
    const { open } = require('../src/approvals/envelope');
    const { validateMessage } = require('../src/approvals/messages');
    for (const [name, type, hidden] of [
      ['request-sealed', 'kl.lease.request', ['lease', 'origin', 'salt']],
      ['status-sealed', 'kl.lease.status', ['name']],
      ['view-sealed', 'kl.lease.view', ['foreground', 'frame', 'frame_dropped', 'actions']]
    ]) {
      const { message } = open(byName.get(name).input);
      assert.equal(validateMessage(type, message), null, name);
      assert.ok(message.sealed, name);
      assert.equal((Buffer.from(message.sealed.ct, 'base64url').length - 16) % 256, 0, `${name} is padded to a whole block`);
      for (const key of hidden) assert.ok(!(key in message), `${name} holds ${key} in clear`);
    }
    // A reader with no way to open a status still takes it, as a listing does.
    const v = byName.get('status-sealed');
    const unopened = L.openNodeStatus(v.input, { nodeId: v.given.node.id, nodePublicKeyHex: v.given.node.key });
    assert.deepEqual([unopened.state, unopened.name], ['active', undefined]);
    // A grant over the request's clear hash is the salted one, not the rule of a clear request.
    const grant = byName.get('grant-to-sealed');
    const pending = grant.given.pending[0];
    assert.equal(grant.expect.message.lease_hash, L.leaseHash(pending.lease, pending.salt));
    assert.notEqual(grant.expect.message.lease_hash, L.leaseHash(pending.lease));
  });

  it('resume-capped: a resume never extends past the original expiry', () => {
    const v = byName.get('resume-capped');
    const eff = L.effectiveExpiry({ verifiedAt: Date.parse(v.given.now), minutes: 4, resumeOf: Date.parse(v.given.resume_of) });
    assert.equal(new Date(eff).toISOString(), v.expect.effective_expires_at);
  });

  it('the phone-built messages are exactly the signed payloads', () => {
    for (const name of ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'take-grant', 'task-grant', 'revoke-valid', 'watch-valid', 'watch-no-token', 'watch-read-key']) {
      const v = byName.get(name);
      const payload = JSON.parse(Buffer.from(v.input.payload, 'base64url').toString('utf8'));
      assert.deepEqual(payload, v.expect.message, name);
    }
  });
});

describe('lease-v1 message shapes', () => {
  describe('the take lease (2026-10-24)', () => {
    const { open } = require('../src/approvals/envelope');
    const take = open(byName.get('take-grant').given.request).message.lease;

    it('checkLease accepts the take-grant lease, and 240 minutes', () => {
      assert.equal(take.kind, 'take');
      assert.equal(L.checkLease(take), true);
      assert.equal(L.checkLease({ ...take, max_minutes: 240 }), true);
    });

    const mutations = {
      'a site with capitals': { sites: ['ChatGPT.com'] },
      'a site with no dot': { sites: ['chatgpt'] },
      'an empty browser list': { browser: [] },
      'a name of 61 characters': { name: 'x'.repeat(61) },
      'a name with a zero-width character': { name: 'BSEOA\u200Bin ChatGPT' },
      'credentials that is not a boolean': { credentials: 'no' },
      'unattended that is not a boolean': { unattended: 'yes' },
      'max_minutes over 240': { max_minutes: 241 },
      'a kind that is neither known kind': { kind: 'screen_share' }
    };
    for (const [label, change] of Object.entries(mutations)) {
      it(`checkLease refuses ${label}`, () => assert.equal(L.checkLease({ ...take, ...change }), false));
    }

    it('a computer_use status must say unattended: false', () => {
      const status = open(byName.get('status-valid').input).message;
      assert.equal(L.VALIDATORS['kl.lease.status'](status), true);
      assert.equal(L.VALIDATORS['kl.lease.status']({ ...status, unattended: true }), false);
    });
  });

  describe('the task lease (2026-11-03)', () => {
    const crypto = require('crypto');
    const { open } = require('../src/approvals/envelope');
    const { validateMessage } = require('../src/approvals/messages');
    const { deriveNodeId } = require('../src/mesh/node-identity');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const identity = { nodeId: deriveNodeId(publicKey.export({ type: 'spki', format: 'der' })), nodeName: 'test-node', sign: (b) => crypto.sign(null, b, privateKey) };
    const TASK = { name: 'Find a dentist', sites: ['*.example.com'], allows: ['browser-act'], usd: 2 };
    const taskRequest = () => L.buildLeaseRequest({
      identity, jobId: 'chat:c-1', apps: [], maxMinutes: 20, reason: 'Find a dentist', kind: 'task', task: TASK,
      origin: { client: 'claude.ai', session: 's-1', job_id: null }
    }).message;
    // The request with its lease altered and hashed again, so only the shape can be wrong.
    const withLease = (change) => {
      const message = taskRequest();
      const lease = { ...message.lease, ...change };
      return { ...message, lease, lease_hash: L.leaseHash(lease) };
    };

    it('exports the kind, what a task may be allowed and its spend cap', () => {
      assert.ok(L.LEASE_KINDS.includes('task'));
      assert.deepEqual(L.TASK_ALLOWS, ['browser-act', 'files-write', 'logins', 'shell']);
      assert.equal(L.TASK_USD_MAX, 500);
    });

    it('buildLeaseRequest gives a lease with exactly its keys, unattended and with no apps', () => {
      const message = taskRequest();
      assert.deepEqual(Object.keys(message.lease).sort(), ['allows', 'job_id', 'kind', 'limits', 'max_minutes', 'name', 'reason', 'resumes', 'sites', 'unattended', 'usd']);
      assert.equal(message.lease.kind, 'task');
      assert.equal(message.lease.unattended, true);
      assert.equal(message.lease.usd, 2);
      assert.equal(validateMessage('kl.lease.request', message), null);
    });

    it('takes no sites (a shell-only grant), 32 sites, every allowance, and the ends of the spend and time ranges', () => {
      for (const change of [
        { sites: [], allows: ['shell'] },
        { allows: [] },
        { sites: Array.from({ length: 32 }, (_, i) => `s${i}.example.com`) },
        { allows: [...L.TASK_ALLOWS] },
        { usd: 500 },
        { max_minutes: 240 },
        { name: 'x'.repeat(60) },
        { name: '\u{1F600}'.repeat(60) }
      ]) assert.equal(validateMessage('kl.lease.request', withLease(change)), null, JSON.stringify(change));
    });

    const refused = {
      'allows unsorted': { allows: ['shell', 'browser-act'] },
      'allows repeated': { allows: ['shell', 'shell'] },
      'allows outside TASK_ALLOWS': { allows: ['desktop-input'] },
      'allows that is not a list': { allows: 'shell' },
      'sites over 32': { sites: Array.from({ length: 33 }, (_, i) => `s${i}.example.com`) },
      'a site with capitals': { sites: ['Example.com'] },
      'a site with no dot': { sites: ['example'] },
      'a site with a path': { sites: ['example.com/a'] },
      'usd 1': { usd: 1 },
      'usd 501': { usd: 501 },
      'usd that is not an integer': { usd: 2.5 },
      'usd that is a string': { usd: '2' },
      'unattended: false': { unattended: false },
      'max_minutes 241': { max_minutes: 241 },
      'max_minutes 0': { max_minutes: 0 },
      'a name with a zero-width character': { name: 'Find\u200Ba dentist' },
      'a name of two lines': { name: 'Find\na dentist' },
      'a name of 61 code points': { name: 'x'.repeat(61) },
      'an empty name': { name: '' },
      'apps': { apps: [] },
      'a key of another kind': { browser: true }
    };
    for (const [label, change] of Object.entries(refused)) {
      it(`the validator refuses ${label}`, () => assert.equal(validateMessage('kl.lease.request', withLease(change)), 'malformed'));
    }

    it('a raise is a fresh request: a task lease never resumes', () => {
      const message = taskRequest();
      const lease = { ...message.lease, resumes: message.lease_id };
      assert.equal(validateMessage('kl.lease.request', { ...message, lease, lease_hash: L.leaseHash(lease) }), 'malformed');
      assert.equal(L.checkLease(lease), false);
    });

    it('a lease without any one of its keys is refused', () => {
      for (const key of Object.keys(taskRequest().lease)) {
        const { lease } = taskRequest();
        delete lease[key];
        assert.equal(L.checkLease(lease), false, key);
      }
    });

    it('a grant may name no apps, and the shape still bounds them', () => {
      const grant = (g) => ({ ...byName.get('grant-valid').expect.message, grant: g });
      assert.equal(validateMessage('kl.lease.grant', grant({ apps: [], minutes: 20 })), null);
      assert.equal(validateMessage('kl.lease.grant', grant({ apps: ['Not An Id'], minutes: 20 })), 'malformed');
      assert.equal(validateMessage('kl.lease.grant', grant({ minutes: 20 })), 'malformed');
    });

    describe('kl.lease.status', () => {
      const status = (fields) => open(L.buildLeaseStatus({ identity, leaseId: crypto.randomUUID(), seq: 1, state: 'active', ...fields })).message;

      it('a task needs a name, and may be unattended', () => {
        assert.equal(validateMessage('kl.lease.status', status({ kind: 'task', unattended: true, name: 'Find a dentist' })), null);
        assert.equal(validateMessage('kl.lease.status', status({ kind: 'task', unattended: true })), 'malformed');
        assert.equal(validateMessage('kl.lease.status', status({ kind: 'task', unattended: true, name: 'Find\u200Ba dentist' })), 'malformed');
        assert.equal(validateMessage('kl.lease.status', status({ kind: 'task', unattended: true, name: 'x'.repeat(61) })), 'malformed');
      });

      it('buildLeaseStatus keeps the name for every kind but computer_use', () => {
        assert.equal(status({ kind: 'task', unattended: true, name: 'Find a dentist' }).name, 'Find a dentist');
        assert.equal(status({ kind: 'take', unattended: true, name: 'A take' }).name, 'A take');
        assert.equal(status({ kind: 'computer_use', name: 'ignored' }).name, null);
      });

      it('computer_use keeps unattended: false and name: null; a kind nobody knows is refused', () => {
        const computerUse = status({});
        assert.equal(validateMessage('kl.lease.status', computerUse), null);
        assert.equal(validateMessage('kl.lease.status', { ...computerUse, unattended: true }), 'malformed');
        assert.equal(validateMessage('kl.lease.status', { ...computerUse, name: 'A name' }), 'malformed');
        assert.equal(validateMessage('kl.lease.status', { ...computerUse, kind: 'screen_share', name: 'A name' }), 'malformed');
      });
    });
  });

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
