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
const { seal, verifyEs256, deviceIdFromJwk } = require('../../../src/approvals/envelope');
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

function requestFor(label, { appIds = ['calculator', 'notepad'], maxMinutes = 15, resumes = null, leaseLabel = label } = {}) {
  return L.buildLeaseRequest({
    identity: GPU, nodeName: 'gpu-box', jobId: JOB, apps: appsFor(appIds), maxMinutes, reason: 'Enter the totals', resumes: resumes ? uuidOf(`lease ${leaseLabel}`) : null,
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
function statusEnvelope(label, { seq = 3, state = 'active', reason = null, grantedBy = { deviceId: DEVICES.A.id, name: 'Owner phone' }, expiresAt = NOW_MS + 10 * 60000 } = {}) {
  return L.buildLeaseStatus({
    identity: GPU, leaseId: uuidOf(`lease ${label}`), seq, state, locked: false, reason, expiresAt,
    contactToken: tokenOf(`status ${label}`), grantedBy, now: NOW_MS
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
