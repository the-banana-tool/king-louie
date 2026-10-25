#!/usr/bin/env node
// tests/vectors/lease-v1/generate.js
//
// Rebuilds every lease-v1 vector (fleet stage 5 spec §4.1) from
// ../approval-v1/keys.json.
//   node tests/vectors/lease-v1/generate.js          write the files
//   node tests/vectors/lease-v1/generate.js --check  exit 1 if any differ
// Node signatures (Ed25519) are deterministic. Phone signatures (P-256) are
// randomized, so a committed signature that still verifies over the same
// payload is reused, which keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seal, open, nodeSigner, verifyEs256, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { deriveNodeId } = require('../../../src/mesh/node-identity');
const L = require('../../../src/gui/lease-protocol');

const DIR = __dirname;
const KEYS = require('../approval-v1/keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const nonceOf = (label) => sha(`lease nonce ${label}`).toString('base64url');
// A contact token (16 bytes), fixed per label so the files are stable.
const tokenOf = (label) => sha(`lease contact token ${label}`).subarray(0, 16).toString('base64url');
const uuidOf = (label) => {
  const b = sha(`lease uuid ${label}`).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, spkiHex: spki.toString('hex'), sign: (b) => crypto.sign(null, b, key) };
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
  D: sha('lease-v1 demo device').toString('base64url'),
  U: sha('lease-v1 unknown device').toString('base64url')
};
const DEVICES = Object.fromEntries(Object.entries(DEVICE_D).map(([k, d]) => {
  const { jwk, key } = p256(d);
  return [k, { id: deviceIdFromJwk(jwk), jwk, key }];
}));

function record(label, { platform = 'android', revokedAt = null } = {}) {
  const d = DEVICES[label];
  return {
    v: 1, device_id: d.id, name: `Test phone ${d.id.slice(2, 6)}`, platform, public_key: d.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: revokedAt, revoked_by: revokedAt ? 'console' : null, enrollment: null
  };
}
const APPROVERS = [record('A'), record('B'), record('C', { revokedAt: '2026-09-20T00:00:00.000Z' }), record('D', { platform: 'demo' })];

// Committed phone signatures, reused while they still verify.
function sigCache() {
  const cache = new Map();
  if (!fs.existsSync(DIR)) return cache;
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    const v = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (v.input && v.input.alg === 'ES256') cache.set(`${v.input.kid}|${v.input.payload}`, v.input.sig);
  }
  return cache;
}
const CACHE = sigCache();

function phoneSeal(label, message) {
  const d = DEVICES[label];
  const signer = { alg: 'ES256', kid: d.id, sign: (bytes) => crypto.sign('sha256', bytes, { key: d.key, dsaEncoding: 'ieee-p1363' }) };
  const fresh = seal(message, signer);
  const cached = CACHE.get(`${fresh.kid}|${fresh.payload}`);
  if (cached && verifyEs256({ ...fresh, sig: cached }, d.jwk)) return { ...fresh, sig: cached };
  return fresh;
}

const GPU = nodeIdentity('gpu-box');
const WEB = nodeIdentity('web-01');
const GUI_APPS = {
  calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
  notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processes: [] }
};
const appsFor = (ids, apps = GUI_APPS) => ids.map((id) => ({ id, name: apps[id].name, path: apps[id].path, processes: [...apps[id].processes] }));
const JOB = 'job-1758650651201-a1b2c3';

// kind, take (2026-10-24): a take lease (demo takes spec §6) carries
// take = { name, sites, browser, credentials, unattended }.
function requestFor(label, { appIds = ['calculator', 'notepad'], maxMinutes = 15, resumes = null, leaseLabel = label, kind = 'computer_use', take = null } = {}) {
  return L.buildLeaseRequest({
    identity: GPU, nodeName: 'gpu-box', jobId: JOB, apps: appsFor(appIds), maxMinutes, reason: 'Enter the totals', resumes: resumes ? uuidOf(`lease ${leaseLabel}`) : null,
    kind, take,
    limits: [], origin: { client: 'claude.ai', session: 'mcp-session-1', job_id: JOB }, now: NOW_MS,
    requestId: uuidOf(`request ${label}`), leaseId: uuidOf(`lease ${leaseLabel}`), nonce: nonceOf(`request ${label}`)
  });
}

function pendingOf(message) {
  const { request_id, lease_id, nonce, lease_hash, expires_at, lease } = message;
  return { request_id, lease_id, nonce, lease_hash, expires_at, lease };
}

function grantMessage(request, { decision = 'grant', apps = null, minutes = 10, signedAt = iso(NOW_MS + 5000), device = 'A', overrides = {} } = {}) {
  return {
    v: 1, type: 'kl.lease.grant', request_id: request.request_id, lease_id: request.lease_id, node_id: request.node_id,
    lease_hash: request.lease_hash, nonce: request.nonce, decision,
    grant: decision === 'grant' ? { apps: apps || request.lease.apps.map((a) => a.id), minutes } : null,
    expires_at: request.expires_at, device_id: DEVICES[device].id, signed_at: signedAt, ...overrides
  };
}

function base(now = iso(NOW_MS + 6000)) {
  return { now, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex }, approvers: APPROVERS, allow_test_keys: true, used: [], gui_apps: GUI_APPS, jobs_open: [JOB], gui_max_minutes: 60 };
}

const PHONES = ['node', 'ios', 'android'];

function grantVector(name, { requestOptions = {}, grantOptions = {}, given = {}, pendingOverride = null, device = 'A', expect, check = null, consumers = ['node'], tamper = null, withRequest = false }) {
  const req = requestFor(name, requestOptions);
  const message = grantMessage(req.message, { device, ...grantOptions });
  let input = phoneSeal(device, message);
  if (tamper) input = tamper(input);
  const v = {
    name, consumers, check,
    given: { ...base(), pending: pendingOverride === null ? [pendingOf(req.message)] : pendingOverride, ...given },
    input, expect
  };
  if (withRequest) { v.given.request = req.envelope; v.expect = { ...expect, message }; }
  return v;
}

function revokeMessage(label, { leaseLabel = label, signedAt = iso(NOW_MS + 5000), device = 'A' } = {}) {
  return { v: 1, type: 'kl.lease.revoke', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${leaseLabel}`), reason: 'kill_switch', device_id: DEVICES[device].id, nonce: nonceOf(`revoke ${label}`), signed_at: signedAt };
}

// contactToken: the newest token the phone has applied from a status or a
// view of this lease, or null when it holds none.
function watchMessage(label, { contactToken = tokenOf(`watch ${label}`) } = {}) {
  return {
    v: 1, type: 'kl.lease.watch', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${label}`), device_id: DEVICES.A.id,
    contact_token: contactToken, nonce: nonceOf(`watch ${label}`), signed_at: iso(NOW_MS + 5000)
  };
}

// grantedBy: the device whose grant made the lease (null: nobody yet).
// kind, unattended, name (2026-10-24): every status says which kind of lease it is.
function statusEnvelope(label, { seq = 3, state = 'active', reason = null, grantedBy = { deviceId: DEVICES.A.id, name: 'Owner phone' }, expiresAt = NOW_MS + 10 * 60000, kind = 'computer_use', unattended = false, name = null } = {}) {
  return L.buildLeaseStatus({
    identity: GPU, leaseId: uuidOf(`lease ${label}`), seq, state, locked: false, reason, expiresAt,
    contactToken: tokenOf(`status ${label}`), grantedBy, kind, unattended, name, now: NOW_MS
  });
}

function viewEnvelope({ tamperHash = false } = {}) {
  const data = sha('lease-v1 frame bytes').toString('base64');
  const hash = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64url');
  return L.buildLeaseView({
    identity: GPU, leaseId: uuidOf('lease view'), seq: 8, toDevice: DEVICES.A.id, state: 'active', locked: false, remainingS: 512,
    foreground: { app_id: 'calculator', matches: true },
    frame: { mime: 'image/jpeg', width: 960, height: 640, sha256: tamperHash ? sha('other').toString('base64url') : hash, data },
    frameDropped: false,
    actions: [{ seq: 41, at: iso(NOW_MS), tool: 'Type', summary: 'Typed 6 characters', result: 'ok' }],
    contactToken: tokenOf('view'), now: NOW_MS
  });
}

function buildVectors() {
  const out = [];
  const accepted = { accepted: true, reason: null };
  const reject = (reason) => ({ accepted: false, reason });

  out.push(grantVector('grant-valid', { grantOptions: { minutes: 15 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('grant-narrowed', { grantOptions: { apps: ['calculator'], minutes: 10 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('deny-valid', { grantOptions: { decision: 'deny' }, expect: accepted, consumers: PHONES, withRequest: true }));
  {
    // A resume: max_minutes = the whole minutes left; the grant may not
    // extend past the original expiry (given.resume_of).
    const v = grantVector('resume-capped', {
      requestOptions: { appIds: ['calculator'], maxMinutes: 4, resumes: true }, grantOptions: { minutes: 4 },
      expect: accepted, consumers: PHONES, withRequest: true
    });
    v.given.resume_of = iso(Date.parse(v.given.now) + 3 * 60000);
    v.expect.effective_expires_at = v.given.resume_of;
    out.push(v);
  }
  out.push(grantVector('grant-phone-clock-behind', { grantOptions: { signedAt: iso(NOW_MS - 3600000) }, expect: accepted }));
  // A fixed 64-byte non-signature, so the file is the same on every run.
  out.push(grantVector('bad-signature', {
    expect: reject('bad_signature'), check: 6,
    tamper: (e) => ({ ...e, sig: Buffer.concat([sha('bad sig r'), sha('bad sig s')]).toString('base64url') })
  }));
  out.push(grantVector('revoked-device', { device: 'C', expect: reject('revoked_device'), check: 5 }));
  out.push(grantVector('unknown-device', { device: 'U', expect: reject('unknown_device'), check: 3 }));
  out.push(grantVector('demo-device', { device: 'D', expect: reject('demo_device'), check: 4 }));
  out.push(grantVector('test-key', { given: { allow_test_keys: false }, expect: reject('test_key'), check: 4 }));
  out.push(grantVector('wrong-node', { grantOptions: { overrides: { node_id: WEB.nodeId } }, expect: reject('wrong_node'), check: 7 }));
  {
    const v = grantVector('replay', { expect: reject('replay'), check: 8 });
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    v.given.used = [{ nonce: v.given.pending[0].nonce, sha256: bytesSha256(Buffer.from(v.input.payload, 'base64url')) }];
    out.push(v);
  }
  out.push(grantVector('unknown-request', { pendingOverride: [], expect: reject('unknown_request'), check: 9 }));
  out.push(grantVector('lease-hash-mismatch', { grantOptions: { overrides: { lease_hash: sha('other lease').toString('base64url') } }, expect: reject('lease_hash_mismatch'), check: 10 }));
  out.push(grantVector('lease-changed-app-path', {
    given: { gui_apps: { ...GUI_APPS, calculator: { ...GUI_APPS.calculator, path: 'C:\\Tools\\calc.exe' } } },
    expect: reject('lease_changed'), check: 12
  }));
  out.push(grantVector('apps-not-requested', { grantOptions: { apps: ['calculator', 'terminal'] }, expect: reject('apps_not_requested'), check: 12 }));
  out.push(grantVector('minutes-over-requested', { grantOptions: { minutes: 20 }, expect: reject('minutes_out_of_range'), check: 12 }));
  out.push(grantVector('minutes-over-60', { requestOptions: { maxMinutes: 60 }, grantOptions: { minutes: 61 }, expect: reject('minutes_out_of_range'), check: 12 }));
  {
    const v = grantVector('expired', { expect: reject('expired'), check: 11 });
    v.given.now = iso(NOW_MS + 300001);
    out.push(v);
  }

  const leaseGiven = (known) => ({ ...base(), known_leases: known });
  out.push({ name: 'revoke-valid', consumers: PHONES, check: null, given: { ...leaseGiven([uuidOf('lease revoke-valid')]) }, input: phoneSeal('A', revokeMessage('revoke-valid')), expect: { ...accepted, message: revokeMessage('revoke-valid') } });
  out.push({ name: 'revoke-phone-clock-off', consumers: ['node'], check: null, given: leaseGiven([uuidOf('lease revoke-phone-clock-off')]), input: phoneSeal('A', revokeMessage('revoke-phone-clock-off', { signedAt: iso(NOW_MS + 86400000) })), expect: accepted });
  out.push({ name: 'revoke-unknown-lease', consumers: ['node'], check: 9, given: leaseGiven([]), input: phoneSeal('A', revokeMessage('revoke-unknown-lease')), expect: reject('unknown_lease') });
  {
    const input = phoneSeal('A', revokeMessage('revoke-replayed'));
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    const given = { ...leaseGiven([uuidOf('lease revoke-replayed')]), used: [{ nonce: nonceOf('revoke revoke-replayed'), sha256: bytesSha256(Buffer.from(input.payload, 'base64url')) }] };
    out.push({ name: 'revoke-replayed', consumers: ['node'], check: 8, given, input, expect: reject('replay') });
  }
  out.push({ name: 'watch-valid', consumers: PHONES, check: null, given: leaseGiven([uuidOf('lease watch-valid')]), input: phoneSeal('A', watchMessage('watch-valid')), expect: { ...accepted, message: watchMessage('watch-valid') } });
  // A phone that holds no token yet (it has applied no status or view of the
  // lease) sends null. The node accepts it as a watch; it is never contact.
  {
    const message = watchMessage('watch-no-token', { contactToken: null });
    out.push({ name: 'watch-no-token', consumers: PHONES, check: null, given: leaseGiven([uuidOf('lease watch-no-token')]), input: phoneSeal('A', message), expect: { ...accepted, message } });
  }
  {
    // A token is 16 bytes of base64url; anything else is not a watch.
    const message = watchMessage('watch-bad-token', { contactToken: 'not-a-token' });
    out.push({ name: 'watch-bad-token', consumers: ['node'], check: 1, given: leaseGiven([uuidOf('lease watch-bad-token')]), input: phoneSeal('A', message), expect: reject('malformed') });
  }

  const viewGiven = { now: NOW, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex } };
  // What a phone reads from a status and a view: among it the contact token
  // its next watch echoes (R-F5-15).
  // granted_by (R-F5-18): who granted the lease, so a phone that did not can say so beside its Stop.
  const grantedByA = { device_id: DEVICES.A.id, name: 'Owner phone' };
  out.push({
    name: 'status-valid', consumers: PHONES, check: null, given: viewGiven, input: statusEnvelope('status-valid'),
    expect: { ...accepted, status: { lease_id: uuidOf('lease status-valid'), seq: 3, state: 'active', reason: null, contact_token: tokenOf('status status-valid'), granted_by: grantedByA } }
  });
  out.push({
    name: 'status-no-contact', consumers: PHONES, check: null, given: viewGiven, input: statusEnvelope('status-no-contact', { seq: 9, state: 'suspended', reason: 'no_contact' }),
    expect: { ...accepted, status: { lease_id: uuidOf('lease status-no-contact'), seq: 9, state: 'suspended', reason: 'no_contact', contact_token: tokenOf('status status-no-contact'), granted_by: grantedByA } }
  });
  // Nobody has granted it yet; and a granting phone whose name the node left out (it shows the device id).
  out.push({
    name: 'status-pending', consumers: PHONES, check: null, given: viewGiven, input: statusEnvelope('status-pending', { seq: 1, state: 'pending', grantedBy: null, expiresAt: null }),
    expect: { ...accepted, status: { lease_id: uuidOf('lease status-pending'), seq: 1, state: 'pending', reason: null, contact_token: tokenOf('status status-pending'), granted_by: null } }
  });
  out.push({
    name: 'status-granted-unnamed', consumers: PHONES, check: null, given: viewGiven, input: statusEnvelope('status-granted-unnamed', { seq: 4, grantedBy: { deviceId: DEVICES.B.id, name: null } }),
    expect: { ...accepted, status: { lease_id: uuidOf('lease status-granted-unnamed'), seq: 4, state: 'active', reason: null, contact_token: tokenOf('status status-granted-unnamed'), granted_by: { device_id: DEVICES.B.id, name: null } } }
  });
  out.push({ name: 'view-node-sig-valid', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope(), expect: { ...accepted, contact_token: tokenOf('view') } });
  out.push({ name: 'view-tampered-frame', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope({ tamperHash: true }), expect: reject('frame_hash_mismatch') });

  // R-F5-20: the node's whole answer to one phone's "what is running". A
  // phone takes it only with the nonce it chose for that request, made for
  // itself, and with a signed status for every lease it names (by id and
  // seq). given.nonce and given.device_id are the phone's own; given.statuses
  // are the status envelopes that came beside the listing. expect.leases is
  // what the phone then knows of that node, in the listing's order.
  // identity: the node that builds and signs the listing. change: the
  // message altered and then signed again by that node (a listing the node's
  // own builder would never make, signed all the same).
  const listingVector = (name, { states = [], nonce = nonceOf(`listing ${name}`), signedNonce = nonce, toDevice = 'A', beside = null, tamper = null, identity = GPU, change = null, expect }) => {
    const statuses = states.map(([state, seq, reason], i) => statusEnvelope(`${name} ${i}`, { seq, state, reason: reason || null, expiresAt: state === 'ended' ? null : NOW_MS + 10 * 60000 }));
    let input = L.buildLeaseListing({ identity, toDevice: DEVICES[toDevice].id, nonce: signedNonce, statuses, now: NOW_MS });
    if (change) input = seal(change(open(input).message), nodeSigner(identity));
    if (tamper) input = tamper(input);
    const leases = states.map(([state, seq], i) => ({ lease_id: uuidOf(`lease ${name} ${i}`), seq, state }));
    return {
      name, consumers: PHONES, check: null,
      given: { ...viewGiven, nonce, device_id: DEVICES.A.id, statuses: beside ? beside(statuses) : statuses },
      input, expect: expect.accepted ? { ...expect, leases } : expect
    };
  };
  // Nothing is running, and the node says so over this request's nonce.
  out.push(listingVector('listing-none', { expect: accepted }));
  out.push(listingVector('listing-live', { states: [['active', 7], ['ended', 12, 'revoked']], expect: accepted }));
  // An answer the node signed for an earlier request, replayed.
  out.push(listingVector('listing-nonce-mismatch', { signedNonce: nonceOf('an earlier listing request'), expect: reject('nonce_mismatch') }));
  // The relay left the live lease's status out.
  out.push(listingVector('listing-status-withheld', { states: [['active', 7], ['ended', 12, 'revoked']], beside: (s) => [s[1]], expect: reject('status_missing') }));
  // The relay put an older signed status of the same lease in its place.
  out.push(listingVector('listing-status-stale', {
    states: [['suspended', 9, 'no_contact']], expect: reject('status_missing'),
    beside: () => [statusEnvelope('listing-status-stale 0', { seq: 4, state: 'active' })]
  }));
  out.push(listingVector('listing-other-device', { toDevice: 'B', expect: reject('wrong_device') }));
  out.push(listingVector('listing-bad-signature', {
    expect: reject('bad_signature'),
    tamper: (e) => ({ ...e, sig: Buffer.concat([sha('bad listing sig a'), sha('bad listing sig b')]).toString('base64url') })
  }));

  // Fourth security review (2026-10-13): what the first seven left out.
  // Another node this phone has pinned signs its own listing over this
  // request's nonce, for this phone, and the relay passes it off as this
  // node's. Its signature is good under its own key; it is not this node's.
  out.push(listingVector('listing-other-node', { identity: WEB, expect: reject('malformed') }));
  // This node's key over a listing that names another node.
  out.push(listingVector('listing-wrong-node', { change: (m) => ({ ...m, node_id: WEB.nodeId }), expect: reject('wrong_node') }));
  // A signed status of another lease beside the listing, which the listing
  // does not name: the listing is taken, and that status is not part of it.
  out.push(listingVector('listing-extra-status', {
    states: [['active', 7]], expect: accepted,
    beside: (s) => [statusEnvelope('listing-extra-status unlisted', { seq: 3, state: 'ended', reason: 'revoked', expiresAt: null }), ...s]
  }));
  // The shape (VALIDATORS['kl.lease.listing']); each is signed by the node.
  // The same lease twice, each time with a status that is there beside it.
  out.push(listingVector('listing-duplicate-lease', {
    states: [['active', 7]], expect: reject('malformed'),
    change: (m) => ({ ...m, leases: [m.leases[0], { lease_id: m.leases[0].lease_id, seq: 8 }] }),
    beside: (s) => [...s, statusEnvelope('listing-duplicate-lease 0', { seq: 8, state: 'active' })]
  }));
  // One lease more than a listing may name.
  out.push(listingVector('listing-too-many', {
    expect: reject('malformed'),
    change: (m) => ({ ...m, leases: Array.from({ length: L.LISTING_MAX + 1 }, (_, i) => ({ lease_id: uuidOf(`lease listing-too-many ${i}`), seq: 1 })) })
  }));
  // A key the message does not have.
  out.push(listingVector('listing-extra-key', { expect: reject('malformed'), change: (m) => ({ ...m, note: 'nothing is running' }) }));
  // `at` in the right form for a day that does not exist.
  out.push(listingVector('listing-bad-at', { expect: reject('malformed'), change: (m) => ({ ...m, at: '2026-02-30T18:04:11.201Z' }) }));

  // Revised 2026-10-24 (agent-driven demo takes, spec §6): a take lease, its
  // grant, its cap (gui.take.max_minutes, 240 at most), its status, and two
  // requests whose lease has the wrong keys for its kind.
  const TAKE = { name: 'BSEOA in ChatGPT', sites: ['chatgpt.com', '*.chatgpt.com'], browser: true, credentials: false, unattended: true };
  const takeRequest = { kind: 'take', take: TAKE, appIds: ['notepad'], maxMinutes: 180 };
  out.push(grantVector('take-grant', {
    requestOptions: takeRequest, grantOptions: { minutes: 180 }, given: { gui_take_max_minutes: 240 },
    expect: accepted, consumers: PHONES, withRequest: true
  }));
  out.push(grantVector('take-grant-minutes-over-cap', {
    requestOptions: takeRequest, grantOptions: { minutes: 241 }, given: { gui_take_max_minutes: 240 },
    expect: reject('minutes_out_of_range'), check: 12, consumers: PHONES, withRequest: true
  }));
  // A request the node signed with its lease altered and hashed again, so
  // that only the shape (VALIDATORS['kl.lease.request']) is wrong.
  const requestVector = (name, { requestOptions, change }) => {
    const { message } = requestFor(name, requestOptions);
    const lease = change({ ...message.lease });
    const input = seal({ ...message, lease, lease_hash: L.leaseHash(lease) }, nodeSigner(GPU));
    return { name, consumers: PHONES, check: 'request', given: viewGiven, input, expect: reject('malformed') };
  };
  out.push(requestVector('take-request-missing-name', { requestOptions: takeRequest, change: (l) => { delete l.name; return l; } }));
  out.push(requestVector('computer-use-with-unattended', { requestOptions: {}, change: (l) => ({ ...l, unattended: true }) }));
  out.push({
    name: 'status-take', consumers: PHONES, check: null, given: viewGiven,
    input: statusEnvelope('status-take', { seq: 5, kind: 'take', unattended: true, name: TAKE.name, expiresAt: NOW_MS + 180 * 60000 }),
    expect: { ...accepted, status: { lease_id: uuidOf('lease status-take'), seq: 5, state: 'active', reason: null, contact_token: tokenOf('status status-take'), granted_by: grantedByA, kind: 'take', unattended: true, name: TAKE.name } }
  });
  return out;
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  const names = new Set(vectors.map((v) => `${v.name}.json`));
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && !names.has(n))) {
    if (check) { differ += 1; process.stderr.write(`not generated: ${f}\n`); } else fs.unlinkSync(path.join(DIR, f));
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, NOW, DEVICES, GUI_APPS, JOB };
