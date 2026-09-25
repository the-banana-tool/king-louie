#!/usr/bin/env node
// tests/vectors/approval-v1/generate.js
//
// Rebuilds every approval-v1 vector from keys.json.
//   node tests/vectors/approval-v1/generate.js          write the files
//   node tests/vectors/approval-v1/generate.js --check  exit 1 if any differ
//
// Everything is deterministic except ECDSA: P-256 signatures are randomized,
// so a signature already committed for the same payload (and valid for it) is
// reused. That keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalize } = require('../../../src/platform/jcs');
const { seal, fromB64url, verifyEs256, nodeSigner, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { enrollMac, phoneAuthString } = require('../../../src/approvals/messages');
const { deriveNodeId, base32Encode } = require('../../../src/mesh/node-identity');
const { AuditLedger, entryHash } = require('../../../src/audit/audit-ledger');
const { phoneView } = require('./phone-reference');

const DIR = __dirname;
const KEYS = require('./keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const nonceOf = (label) => sha(`nonce ${label}`).toString('base64url');
const codeIdOf = (label) => sha(`code-id ${label}`).subarray(0, 16).toString('base64url');
function uuidOf(label) {
  const b = sha(`uuid ${label}`).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, publicKey: spki, key: spki.toString('hex'), sign: (b) => crypto.sign(null, b, key) };
}

// kid + payload → sig for every ES256 envelope in the committed files, plus
// 'api:' + signing string → signature for the phone API vector.
function loadSigCache() {
  const cache = new Map();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.alg === 'ES256' && typeof v.payload === 'string' && typeof v.sig === 'string') cache.set(`${v.kid}:${v.payload}`, v.sig);
    if (typeof v.signing_string === 'string' && typeof v.signature === 'string') cache.set(`api:${v.signing_string}`, v.signature);
    for (const child of Object.values(v)) walk(child);
  };
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && n !== 'keys.json')) {
    walk(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  }
  return cache;
}

function deviceSigner(name, cache) {
  const d = KEYS.devices[name];
  const key = crypto.createPrivateKey({ key: { ...d.jwk, d: d.d }, format: 'jwk' });
  const id = deviceIdFromJwk(d.jwk);
  const signBytes = (bytes) => crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
  return {
    id,
    jwk: d.jwk,
    alg: 'ES256',
    kid: id,
    sign(bytes) {
      const payload = Buffer.from(bytes).toString('base64url');
      const cached = cache.get(`${id}:${payload}`);
      if (cached && verifyEs256({ alg: 'ES256', kid: id, payload, sig: cached }, d.jwk)) return fromB64url(cached);
      const sig = signBytes(bytes);
      cache.set(`${id}:${payload}`, sig.toString('base64url'));
      return sig;
    },
    signText(text) {
      const cached = cache.get(`api:${text}`);
      const env = { alg: 'ES256', kid: id, payload: Buffer.from(text).toString('base64url'), sig: cached || '' };
      if (cached && verifyEs256(env, d.jwk)) return cached;
      const sig = signBytes(Buffer.from(text)).toString('base64url');
      cache.set(`api:${text}`, sig);
      return sig;
    }
  };
}

function approver(dev, extra = {}) {
  return {
    v: 1, device_id: dev.id, name: `Test phone ${dev.id.slice(2, 6)}`, platform: 'android', public_key: dev.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: null, revoked_by: null, enrollment: null, ...extra
  };
}

function buildVectors({ sigCache = loadSigCache() } = {}) {
  const web = nodeIdentity('web-01');
  const gpu = nodeIdentity('gpu-box');
  const A = deviceSigner('A', sigCache);
  const B = deviceSigner('B', sigCache);
  const C = deviceSigner('C', sigCache);
  const nodeRef = { id: web.nodeId, name: web.nodeName, key: web.key };
  const vectors = [];
  const add = (v) => vectors.push(v);

  // ── Canonical form and identifiers ────────────────────────────────────────
  const jcsCases = [
    { device: { platform: 'ios', name: 'Owner phone', device_id: A.id }, v: 1, type: 'kl.test' },
    { quote: '"', backslash: String.fromCodePoint(0x5c), newline: '\n', tab: '\t', nul: String.fromCodePoint(0), del: String.fromCodePoint(0x7f) },
    { euro: String.fromCodePoint(0x20ac), emoji: String.fromCodePoint(0x1f600), ls: String.fromCodePoint(0x2028), rtl: String.fromCodePoint(0x202e) },
    { [String.fromCodePoint(0x20ac)]: 1, '\r': 2, [String.fromCodePoint(0xfb33)]: 3, 1: 4, [String.fromCodePoint(0x1f600)]: 5, [String.fromCodePoint(0x80)]: 6, [String.fromCodePoint(0xf6)]: 7 },
    { a: { c: { e: 0, d: -1 }, b: [] }, z: 42 }
  ].map((value) => ({ value, canonical: canonicalize(value) }));
  add({ name: 'jcs', consumers: ['node', 'ios', 'android'], given: {}, input: { cases: jcsCases.map((c) => c.value) }, expect: { canonical: jcsCases.map((c) => c.canonical) } });

  add({
    name: 'device-id-p256',
    consumers: ['node', 'ios', 'android'],
    given: {},
    input: { jwks: [A.jwk, B.jwk, C.jwk] },
    expect: { device_ids: [A.id, B.id, C.id], grouped: [A.id, B.id, C.id].map((id) => id.slice(2).match(/.{4}/g).join(' ')) }
  });
  const rawWeb = web.publicKey.subarray(12);
  const kld = `kld-${base32Encode(crypto.createHash('sha256').update(rawWeb).digest()).slice(0, 16)}`;
  add({ name: 'device-id-ed25519', consumers: ['node', 'ios', 'android'], given: {}, input: { raw: rawWeb.toString('base64url'), prefix: 'kld-' }, expect: { device_id: kld } });

  // ── Requests (phone side) ─────────────────────────────────────────────────
  const toolActionLit = { kind: 'tool', name: 'Bash', params: { command: 'git push origin main' }, cwd: '/srv/site', summary: 'Bash(git push origin main)' };
  const request = (identity, label, action, { origin = { client: 'gateway', session: 'chat-1', job_id: null }, created = NOW_MS } = {}) => {
    const actionHash = crypto.createHash('sha256').update(canonicalize(action)).digest('base64url');
    return seal({
      v: 1, type: 'kl.approval.request', request_id: uuidOf(label), node_id: identity.nodeId, node_name: identity.nodeName,
      action, action_hash: actionHash, origin, created_at: iso(created), expires_at: iso(created + 300000), nonce: nonceOf(label)
    }, nodeSigner(identity));
  };
  const pinnedWeb = [{ id: web.nodeId, key: web.key }];
  const phoneVector = (name, env, pinned) => add({ name, consumers: ['ios', 'android'], given: { now: NOW, pinned_nodes: pinned }, input: env, expect: phoneView(env, pinned) });

  const req = request(web, 'main', toolActionLit);
  phoneVector('request-valid', req, pinnedWeb);
  const forged = { ...req, sig: request(web, 'other', toolActionLit).sig };
  phoneVector('request-bad-node-signature', forged, pinnedWeb);
  phoneVector('request-unpinned-node', request(gpu, 'gpu', toolActionLit), pinnedWeb);

  const rtl = String.fromCodePoint(0x202e);
  const zw = String.fromCodePoint(0x200b);
  const longCommand = `echo start && ${'x'.repeat(2400)} && echo end`;
  // `cwd` is required on every tool/runbook action (checked in messages.js's
  // checkAction and hashed into action_hash by runbookAction); this mirrors
  // what a real node would pass for a runbook whose steps already target
  // /srv/site.
  const runbookAction = {
    kind: 'runbook',
    name: 'site.pull_and_restart',
    params: { ref: `main${rtl}gnp.exe`, retries: 5, ratio: 0.5, dry_run: false, note: `line1\nline2${zw}`, script: longCommand },
    steps: [['git', '-C', '/srv/site', 'fetch', '--prune', 'origin'], { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }],
    cwd: '/srv/site',
    summary: 'Run runbook site.pull_and_restart on web-01'
  };
  phoneVector('request-display', request(web, 'display', runbookAction, { origin: { client: 'stdio-mcp', session: null, job_id: 'job-1' } }), pinnedWeb);

  // ── Responses (node side) ─────────────────────────────────────────────────
  const reqMsg = JSON.parse(fromB64url(req.payload));
  const respond = (dev, overrides = {}) => seal({
    v: 1, type: 'kl.approval.response', request_id: reqMsg.request_id, node_id: reqMsg.node_id, action_hash: reqMsg.action_hash,
    nonce: reqMsg.nonce, decision: 'approve', expires_at: reqMsg.expires_at, device_id: dev.id, signed_at: iso(NOW_MS + 20000), ...overrides
  }, dev);
  const baseGiven = { now: iso(NOW_MS + 30000), node: nodeRef, approvers: [approver(A), approver(B)], overlay: [], allow_test_keys: true, pending: [req], used: [], current_action: toolActionLit };
  const nodeVector = (name, check, input, expect, given = {}) => add({ name, consumers: ['node'], check, given: { ...baseGiven, ...given }, input, expect });
  const bytesSha = (env) => crypto.createHash('sha256').update(fromB64url(env.payload)).digest('base64url');

  nodeVector('response-approve', null, respond(A), { accepted: true, reason: null });
  nodeVector('response-deny', null, respond(A, { decision: 'deny' }), { accepted: true, reason: null });
  const good = respond(A);
  const spaced = Buffer.from(fromB64url(good.payload).toString('utf8').replace('{', '{ '));
  nodeVector('response-reject-malformed-noncanonical', 1, { alg: 'ES256', kid: A.id, payload: spaced.toString('base64url'), sig: A.sign(spaced).toString('base64url') }, { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-unsupported-version', 1, respond(A, { v: 2 }), { accepted: false, reason: 'unsupported_version' });
  nodeVector('response-reject-wrong-alg', 2, { ...good, alg: 'Ed25519' }, { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-kid-mismatch', 2, seal(JSON.parse(fromB64url(good.payload)), B), { accepted: false, reason: 'malformed' });
  nodeVector('response-reject-unknown-device', 3, respond(C), { accepted: false, reason: 'unknown_device' });
  nodeVector('response-reject-demo-device', 4, respond(C), { accepted: false, reason: 'demo_device' }, { approvers: [approver(A), approver(C, { platform: 'demo' })] });
  nodeVector('response-reject-test-key', 4, respond(A), { accepted: false, reason: 'test_key' }, { allow_test_keys: false });
  nodeVector('response-reject-revoked-device', 5, respond(A), { accepted: false, reason: 'revoked_device' }, { approvers: [approver(A, { revoked_at: '2026-09-20T00:00:00.000Z', revoked_by: 'console' })] });
  nodeVector('response-reject-revoked-via-overlay', 5, respond(A), { accepted: false, reason: 'revoked_device' }, { overlay: [A.id] });
  nodeVector('response-reject-bad-signature', 6, { ...good, sig: respond(A, { decision: 'deny' }).sig }, { accepted: false, reason: 'bad_signature' });
  nodeVector('response-reject-wrong-node', 7, respond(A, { node_id: gpu.nodeId }), { accepted: false, reason: 'wrong_node' });
  nodeVector('response-reject-replay', 8, good, { accepted: false, reason: 'replay' }, { used: [{ nonce: reqMsg.nonce, sha256: bytesSha(good) }] });
  nodeVector('response-reject-already-decided', 8, good, { accepted: false, reason: 'already_decided' }, { used: [{ nonce: reqMsg.nonce, sha256: bytesSha(respond(B, { decision: 'deny' })) }] });
  nodeVector('response-reject-unknown-request', 9, good, { accepted: false, reason: 'unknown_request' }, { pending: [] });
  nodeVector('response-reject-nonce-mismatch', 10, respond(A, { nonce: nonceOf('someone else') }), { accepted: false, reason: 'nonce_mismatch' });
  nodeVector('response-reject-action-hash-mismatch', 10, respond(A, { action_hash: crypto.createHash('sha256').update('{}').digest('base64url') }), { accepted: false, reason: 'action_hash_mismatch' });
  nodeVector('response-reject-expires-mismatch', 10, respond(A, { expires_at: iso(NOW_MS + 600000) }), { accepted: false, reason: 'expires_mismatch' });
  nodeVector('response-reject-expired', 11, good, { accepted: false, reason: 'expired' }, { now: iso(NOW_MS + 301000) });
  nodeVector('response-reject-changed-parameter', 12, good, { accepted: false, reason: 'action_changed' }, { current_action: { ...toolActionLit, params: { command: 'git push --force origin main' }, summary: 'Bash(git push --force origin main)' } });
  nodeVector('response-accept-phone-clock-ahead', null, respond(A, { signed_at: iso(NOW_MS + 10 * 60 * 1000) }), { accepted: true, reason: null });

  // ── Enrollment and revocation ─────────────────────────────────────────────
  const code = sha('console code').toString('base64url');
  const codeId = codeIdOf('console');
  const deviceOf = (dev, platform = 'android') => ({ device_id: dev.id, name: `Phone ${dev.id.slice(2, 6)}`, platform, public_key: dev.jwk });
  const consoleEnroll = (dev, macCode) => {
    const base = { v: 1, type: 'kl.device.enroll', device: deviceOf(dev), enrolled_by: null, created_at: NOW, expires_at: iso(NOW_MS + 600000), nonce: nonceOf(`enroll ${dev.id}`), code_id: codeId };
    return seal({ ...base, code_mac: enrollMac(macCode, base) }, dev);
  };
  const consoleGiven = { now: iso(NOW_MS + 60000), code_id: codeId, code, allow_test_keys: true };
  add({ name: 'enroll-console', consumers: ['node', 'ios', 'android'], given: consoleGiven, input: consoleEnroll(C, code), expect: { accepted: true, reason: null, device_id: C.id } });
  add({ name: 'enroll-console-bad-mac', consumers: ['node'], given: consoleGiven, input: consoleEnroll(C, sha('wrong code').toString('base64url')), expect: { accepted: false, reason: 'bad_mac', device_id: null } });

  const signedEnroll = (by, dev) => seal({ v: 1, type: 'kl.device.enroll', device: deviceOf(dev, 'ios'), enrolled_by: by.id, created_at: NOW, expires_at: iso(NOW_MS + 600000), nonce: nonceOf(`signed ${by.id} ${dev.id}`) }, by);
  const revoke = (by, target) => seal({ v: 1, type: 'kl.device.revoke', device_id: target.id, revoked_by: by.id, reason: 'lost phone', created_at: NOW, expires_at: iso(NOW_MS + 3600000), nonce: nonceOf(`revoke ${by.id} ${target.id}`) }, by);
  const stageGiven = { now: iso(NOW_MS + 60000), approvers: [approver(A), approver(B)], overlay: [], allow_test_keys: true };
  const stageVector = (name, inputs, results, active, given = {}) => add({ name, consumers: ['node'], given: { ...stageGiven, ...given }, input: inputs, expect: { results, active } });
  stageVector('enroll-signed', [signedEnroll(A, C)], [{ state: 'staged' }], [A.id, B.id]);
  stageVector('enroll-signed-by-overlay-revoked', [signedEnroll(A, C)], [{ state: 'rejected', reason: 'signer_not_active' }], [B.id], { overlay: [A.id] });
  stageVector('revoke-valid', [revoke(A, B)], [{ state: 'revoked-pending-apply' }], [A.id]);
  stageVector('revoke-self-rejected', [revoke(A, A)], [{ state: 'rejected', reason: 'self_revoke' }], [A.id, B.id]);
  stageVector('revoke-mutual', [revoke(B, A), revoke(A, B)], [{ state: 'revoked-pending-apply' }, { state: 'revoked-pending-apply' }], []);

  // ── History slice ─────────────────────────────────────────────────────────
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vector-audit-'));
  try {
    const ledger = new AuditLedger({ dir: auditDir, identity: web, nodeId: web.nodeId, now: () => NOW_MS });
    const lines = [
      { kind: 'approval.request', data: { job_id: null, envelope: req } },
      { kind: 'approval.response', data: { request_id: reqMsg.request_id, device_id: A.id, decision: 'approve', envelope: good, job_id: null } },
      { kind: 'approval.outcome', data: { request_id: reqMsg.request_id, state: 'approved', reason: null, job_id: null } }
    ];
    // Written directly (append() is async for its lock) with the same hashing.
    const entries = [];
    let prev = null;
    for (const [i, line] of lines.entries()) {
      const entry = { v: 1, seq: i + 1, at: NOW, node_id: web.nodeId, writer: 'service', kind: line.kind, data: line.data, prev };
      entry.hash = entryHash(entry);
      entries.push(entry);
      prev = entry.hash;
    }
    fs.writeFileSync(path.join(auditDir, 'ledger-2026-09.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
    add({ name: 'audit-slice', consumers: ['node', 'ios', 'android'], given: { node: { id: web.nodeId, key: web.key } }, input: ledger.slice({ limit: 200 }), expect: { accepted: true, reason: null, entries: 3 } });
  } finally {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }

  // ── Phone API authentication ──────────────────────────────────────────────
  const apiPath = `/v1/approvals/${reqMsg.request_id}/response`;
  const body = JSON.stringify(good);
  const timestamp = iso(NOW_MS + 21000);
  const signing = phoneAuthString('POST', apiPath, timestamp, body);
  add({
    name: 'phone-api-auth',
    consumers: ['node', 'ios', 'android'],
    given: { device: { device_id: A.id, jwk: A.jwk }, method: 'POST', path: apiPath, timestamp, body },
    input: { signing_string: signing, signature: A.signText(signing) },
    expect: { signing_string: signing, body_sha256: crypto.createHash('sha256').update(body).digest('base64url'), accepted: true }
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
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, loadSigCache, NOW };
