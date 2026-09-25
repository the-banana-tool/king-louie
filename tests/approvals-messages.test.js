// tests/approvals-messages.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { open, verifyEd25519, seal, deviceIdFromJwk } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');

function testIdentity(nodeName = 'web-01') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName, publicKey: spki, sign: (b) => crypto.sign(null, b, privateKey) };
}

function testDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, crv, x, y };
  const id = deviceIdFromJwk(jwk);
  return { jwk, id, signer: { alg: 'ES256', kid: id, sign: (b) => crypto.sign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }) } };
}

const NOW = Date.parse('2026-09-23T18:04:11.201Z');

describe('actions', () => {
  it('toolAction clones params through JCS and summarises with formatToolPattern', () => {
    const params = { command: 'git push origin main' };
    const action = m.toolAction('Bash', params, '/srv/site');
    assert.deepEqual(action, { kind: 'tool', name: 'Bash', params: { command: 'git push origin main' }, cwd: '/srv/site', summary: 'Bash(git push origin main)' });
    assert.notEqual(action.params, params);
    assert.equal(m.toolAction('Read', { file_path: 'a' }, undefined).cwd, null);
  });

  it('cuts the summary to 300 characters with an ellipsis', () => {
    const summary = m.toolAction('Bash', { command: 'x'.repeat(1000) }, null).summary;
    assert.equal(Array.from(summary).length, 300);
    assert.ok(summary.endsWith('…'));
  });

  it('refuses parameters that are not JSON', () => {
    for (const params of [{ a: undefined }, { n: NaN }, { d: new Date(0) }]) {
      assert.throws(() => m.toolAction('Bash', params, null), (err) => err.reason === 'non_canonical');
    }
  });

  it('runbookAction substitutes every run argv and keeps checks', () => {
    const runbook = {
      name: 'site.pull_and_restart',
      steps: [{ run: ['git', '-C', '{{dir}}', 'fetch', '--prune', 'origin'] }, { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }]
    };
    const action = m.runbookAction(runbook, { dir: '/srv/site' }, 'web-01');
    assert.deepEqual(action, {
      kind: 'runbook',
      name: 'site.pull_and_restart',
      params: { dir: '/srv/site' },
      steps: [['git', '-C', '/srv/site', 'fetch', '--prune', 'origin'], { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }],
      summary: 'Run runbook site.pull_and_restart on web-01'
    });
  });

  it('envelopeAction has the C3 shape', () => {
    assert.deepEqual(m.envelopeAction({ executorId: 'mail.send', caseId: 'lakeside-lot', envelopeHash: 'h', summary: 'Send one email' }), {
      kind: 'envelope', name: 'mail.send', params: { case_id: 'lakeside-lot', envelope_hash: 'h' }, summary: 'Send one email'
    });
  });

  it('actionHash is order-independent and changes with any value', () => {
    const a = m.actionHash({ kind: 'tool', params: { a: 1, b: 2 } });
    assert.equal(a, m.actionHash({ params: { b: 2, a: 1 }, kind: 'tool' }));
    assert.notEqual(a, m.actionHash({ kind: 'tool', params: { a: 1, b: 3 } }));
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('buildRequest', () => {
  it('signs a well-formed request with the node key', () => {
    const identity = testIdentity();
    const action = m.toolAction('Bash', { command: 'ls' }, '/tmp');
    const { message, envelope } = m.buildRequest({ identity, action, origin: { client: 'stdio-mcp', job_id: 'job-1' }, ttlMs: 300000, now: NOW });
    assert.equal(envelope.alg, 'Ed25519');
    assert.equal(envelope.kid, identity.nodeId);
    assert.equal(verifyEd25519(envelope, identity.publicKey.toString('hex')), true);
    assert.equal(m.validateMessage('kl.approval.request', open(envelope).message), null);
    assert.equal(message.expires_at, '2026-09-23T18:09:11.201Z');
    assert.deepEqual(message.origin, { client: 'stdio-mcp', session: null, job_id: 'job-1' });
    assert.equal(message.action_hash, m.actionHash(action));
  });

  it('clamps the TTL to 30–300 s', () => {
    const identity = testIdentity();
    const action = m.toolAction('Bash', { command: 'ls' }, null);
    const exp = (ttlMs) => Date.parse(m.buildRequest({ identity, action, ttlMs, now: NOW }).message.expires_at) - NOW;
    assert.equal(exp(5000), 30000);
    assert.equal(exp(900000), 300000);
    assert.equal(exp(120000), 120000);
  });

  it('refuses an action over 256 KiB', () => {
    const identity = testIdentity();
    const action = { kind: 'tool', name: 'Write', params: { content: 'x'.repeat(262144) }, cwd: null, summary: 'Write' };
    assert.throws(() => m.buildRequest({ identity, action, now: NOW }), (err) => err.reason === 'action_too_large');
  });

  it('adds deviceId to a desktop origin only', () => {
    assert.deepEqual(m.normalizeOrigin({ client: 'desktop', deviceId: 'kld-x', session: 's' }), { client: 'desktop', session: 's', job_id: null, deviceId: 'kld-x' });
    assert.deepEqual(m.normalizeOrigin(null), { client: 'king-louie', session: null, job_id: null });
  });
});

describe('validators', () => {
  const identity = testIdentity();
  const phone = testDevice();
  const response = () => ({
    v: 1, type: 'kl.approval.response', request_id: crypto.randomUUID(), node_id: identity.nodeId,
    action_hash: m.actionHash({ a: 1 }), nonce: m.randomNonce(), decision: 'approve',
    expires_at: '2026-09-23T18:09:11.201Z', device_id: phone.id, signed_at: '2026-09-23T18:05:00.000Z'
  });

  it('accepts a good response and names the fault otherwise', () => {
    assert.equal(m.validateMessage('kl.approval.response', response()), null);
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), v: 2 }), 'unsupported_version');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), v: '1' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), decision: 'maybe' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), extra: 1 }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), signed_at: '2026-09-23 18:05' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.status', response()), 'malformed');
  });

  it('parseResponse opens and validates', () => {
    const env = seal(response(), phone.signer);
    assert.equal(m.parseResponse(env).message.device_id, phone.id);
    assert.throws(() => m.parseResponse(seal({ ...response(), v: 2 }, phone.signer)), (err) => err.reason === 'unsupported_version');
  });

  it('checks enrollments: derived device id, 10-minute window, console fields', () => {
    const device = { device_id: phone.id, name: 'Pixel 9', platform: 'android', public_key: phone.jwk };
    const signed = { v: 1, type: 'kl.device.enroll', device, enrolled_by: testDevice().id, created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-23T18:10:00.000Z', nonce: m.randomNonce() };
    assert.equal(m.validateMessage('kl.device.enroll', signed), null);
    assert.equal(m.validateMessage('kl.device.enroll', { ...signed, expires_at: '2026-09-23T18:10:00.001Z' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', { ...signed, device: { ...device, device_id: testDevice().id } }), 'malformed');
    const consoleEnroll = { ...signed, enrolled_by: null, code_id: crypto.randomBytes(16).toString('base64url') };
    assert.equal(m.validateMessage('kl.device.enroll', consoleEnroll), 'malformed');
    const code = crypto.randomBytes(32).toString('base64url');
    const withMac = { ...consoleEnroll, code_mac: m.enrollMac(code, consoleEnroll) };
    assert.equal(m.validateMessage('kl.device.enroll', withMac), null);
  });

  it('checks revocations within 7 days', () => {
    const revoke = { v: 1, type: 'kl.device.revoke', device_id: phone.id, revoked_by: testDevice().id, reason: 'lost', created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-30T18:00:00.000Z', nonce: m.randomNonce() };
    assert.equal(m.validateMessage('kl.device.revoke', revoke), null);
    assert.equal(m.validateMessage('kl.device.revoke', { ...revoke, expires_at: '2026-09-30T18:00:00.001Z' }), 'malformed');
  });

  it('lets another stage register a type, once', () => {
    const type = `kl.test.${crypto.randomBytes(4).toString('hex')}`;
    m.registerMessageValidator(type, (msg) => msg.ok === true);
    assert.equal(m.validateMessage(type, { v: 1, type, ok: true }), null);
    assert.equal(m.validateMessage(type, { v: 1, type, ok: false }), 'malformed');
    assert.throws(() => m.registerMessageValidator(type, () => true));
  });
});

describe('control messages and QR codes', () => {
  it('builds node-signed status, enroll.open and enroll.done', () => {
    const identity = testIdentity();
    const status = open(m.buildStatus({ identity, requestId: crypto.randomUUID(), state: 'approved', deviceId: testDevice().id, now: NOW })).message;
    assert.equal(m.validateMessage('kl.approval.status', status), null);
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.equal(m.validateMessage('kl.enroll.open', open(m.buildEnrollOpen({ identity, codeId, expiresAt: NOW + 600000 })).message), null);
    assert.equal(m.validateMessage('kl.enroll.done', open(m.buildEnrollDone({ identity, codeId, refused: true })).message), null);
  });

  it('builds the phone API signing string', () => {
    const s = m.phoneAuthString('post', '/v1/approvals/x/response?a=1', '2026-09-23T18:05:00Z', '{"k":1}');
    const bodyHash = crypto.createHash('sha256').update('{"k":1}').digest('base64url');
    assert.equal(s, ['KL-PHONE-V1', 'POST', '/v1/approvals/x/response?a=1', '2026-09-23T18:05:00Z', bodyHash].join('\n'));
    assert.equal(m.phoneAuthString('GET', '/v1/time', 't', null).split('\n')[4], crypto.createHash('sha256').update('').digest('base64url'));
  });

  it('round-trips kl1: QR payloads', () => {
    const payload = { t: 'kl.relay', relay: 'https://kl.example.com:8443', relay_spki: 'sha256/abc' };
    const text = m.encodeQr(payload);
    assert.match(text, /^kl1:[A-Za-z0-9_-]+$/);
    assert.deepEqual(m.decodeQr(text), payload);
    assert.throws(() => m.decodeQr('kl2:xx'), (err) => err.reason === 'malformed');
  });
});
