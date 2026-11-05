// tests/window-enrollment.test.js
//
// Remote window plan, task 9 (R-RW-14, R-RW-15, R-RW-34, R-RW-36): how a new window gets
// the owner's phone to approve it on a node, through a front door treated as hostile.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { generateBoxKey } = require('../src/approvals/node-box-key');
const { open, seal, verifyEd25519 } = require('../src/approvals/envelope');
const { saltedHash, isSealedShape } = require('../src/approvals/seal');
const { createSealPolicy } = require('../src/approvals/seal-policy');
const { decodeQr, validateMessage } = require('../src/approvals/messages');
const {
  qrFor, enrollCode, enrollHashBytes, isSmallOrderKey, refusedWindowKey, rawNodeKey, spkiHex, buildWindowEnroll
} = require('../src/approvals/window-messages');
const { TEST_WINDOW_KEYS } = require('../src/approvals/test-keys');
const { createWindowEnrollment } = require('../src/desktop-bridge/window-enrollment');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { WindowSeal } = require('../src/desktop-bridge/window-seal');
const { createWindowHandlers } = require('../src/desktop-bridge/window-dialer');
const { REMOTE_CLASSES } = require('../src/desktop-bridge/remote-classes');
const { CLOSE } = require('../src/desktop-bridge/protocol');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { createRelayDispatcher } = require('../src/approvals/service-wiring');
const { createDesktopBridgeHost } = require('../src/desktop-bridge/service-wiring');
const { createCore } = require('../src/core/create-core');
const { registerPhoneRoutes } = require('../src/frontdoor/routes');
const { Mailbox } = require('../src/frontdoor/mailbox');
const { runDevice } = require('../src/service/commands/devices');
const { buildServicePorts } = require('../src/service/ports');
const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { createFakePhone } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { sessionIdOf, createTransportPair } = require('./helpers/window-seal-fixture');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
const WINDOW_KEYS = require('./vectors/window-v1/keys.json');

after(holdEventLoop());
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitFor = async (fn, what = 'a condition', ms = 6000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const selfOwner = { geteuid: () => UID, adminUid: UID };

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newNode(name = 'web-01') {
  const { jwk, d } = generateBoxKey();
  return new NodeIdentity({ nodeName: name, boxKeyJwk: jwk, boxKeyD: d });
}

function newWindow(label = 'Laptop on the road') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), raw, privateKey, label };
}

function fakeLink() {
  const link = {
    sent: [],
    connected: true,
    listeners: new Map(),
    isConnected: () => link.connected,
    async send(envelope, options) {
      if (!link.connected) throw Object.assign(new Error('offline'), { code: 'relay_offline' });
      link.sent.push({ envelope, ...options });
      return { ok: true };
    },
    on(event, fn) { link.listeners.set(event, fn); },
    off(event) { link.listeners.delete(event); }
  };
  return link;
}

function fakeAudit() {
  const entries = [];
  return { entries, append: async (entry) => { entries.push(entry); } };
}

// A node with one enrolled phone (or the ones given), a real approver store and seal
// policy, and a fake link.
async function fixture({ hosting = 'personal', phones = null, clock = null, attached = () => [], enrollmentLimits = {}, identity = newNode() } = {}) {
  const phone = createFakePhone({ boxKey: true });
  const all = phones || [phone];
  const store = await approverStoreWith(all.map((p) => p.approverRecord({ boxKey: true })));
  cleanups.push(() => store.cleanup());
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configDir = tempDir('kl-window-config-');
  const sealPolicy = createSealPolicy({ approverStore: store, identity, dataDir });
  const link = fakeLink();
  const audit = fakeAudit();
  const now = clock || Date.now;
  const enrollment = createWindowEnrollment({
    identity, configDir, dataDir, hosting, sealPolicy, now, attached, limits: enrollmentLimits, ...selfOwner,
    approvals: { approverStore: store, auditLedger: audit, relayClient: link }
  });
  cleanups.push(() => enrollment.close());
  return { phone: all[0], phones: all, store, dataDir, configDir, sealPolicy, link, audit, enrollment, identity };
}

const devicesIn = (configDir) => {
  const file = path.join(configDir, pairing.DEVICES_FILE);
  return fs.existsSync(file) ? pairing.parseDevices(fs.readFileSync(file, 'utf8')).devices : [];
};

function asks(enrollment, window = newWindow()) {
  return enrollment.request({ deviceId: window.deviceId, publicKey: window.publicKey, label: window.label });
}

describe('the messages (R-RW-14, R-RW-34)', () => {
  const dev = Buffer.alloc(32, 1);
  const nodeKey = Buffer.alloc(32, 2);
  const n = Buffer.alloc(16, 3);

  it('the QR holds h and n, and h is the two raw keys', () => {
    const qr = qrFor({ devicePublicKey: dev, nodePublicKey: nodeKey, nonce: n });
    const parsed = decodeQr(qr);
    assert.deepEqual(Object.keys(parsed).sort(), ['h', 'n', 't']);
    assert.equal(parsed.t, 'kl.window');
    assert.equal(parsed.n, n.toString('base64url'));
    const want = crypto.createHash('sha256').update(Buffer.concat([dev, nodeKey])).digest();
    assert.deepEqual(enrollHashBytes(dev, nodeKey), want);
    assert.equal(parsed.h, want.toString('base64url'));
  });

  it('a QR refuses a nonce that is not 16 bytes, or a key that is not 32', () => {
    assert.throws(() => qrFor({ devicePublicKey: dev, nodePublicKey: nodeKey, nonce: Buffer.alloc(15) }));
    assert.throws(() => qrFor({ devicePublicKey: Buffer.alloc(31), nodePublicKey: nodeKey, nonce: n }));
  });

  it('the code is six digits, the decimal reduction of the first 8 bytes', () => {
    const digest = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('kl-window-confirm-v1\n'), n, dev, nodeKey])).digest();
    const want = String(digest.readBigUInt64BE(0) % 1000000n).padStart(6, '0');
    assert.equal(enrollCode({ nonce: n, devicePublicKey: dev, nodePublicKey: nodeKey }), want);
    assert.match(want, /^\d{6}$/);
    assert.notEqual(enrollCode({ nonce: n, devicePublicKey: dev, nodePublicKey: Buffer.alloc(32, 9) }), want);
  });

  it('every small-order encoding is known, with the sign bit either way', () => {
    const small = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
    ];
    for (const hex of small) {
      const raw = Buffer.from(hex, 'hex');
      assert.equal(isSmallOrderKey(raw), true, hex);
      const flipped = Buffer.from(raw);
      flipped[31] |= 0x80;
      assert.equal(isSmallOrderKey(flipped), true, `${hex} with the sign bit`);
    }
    assert.equal(isSmallOrderKey(newWindow().raw), false);
  });

  it('the identity point really does verify a crafted signature over any message, which is why it is refused', () => {
    const identityKey = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex');
    // S = 1, R = the base point: S·B = R + h·A holds for any h when A is the identity.
    const base = Buffer.from('5866666666666666666666666666666666666666666666666666666666666666', 'hex');
    const sig = Buffer.concat([base, Buffer.from('01'.padEnd(64, '0'), 'hex')]);
    assert.equal(keys.verifyWithRawKey(identityKey, Buffer.from('anything at all'), sig), true);
    assert.equal(keys.verifyWithRawKey(identityKey, Buffer.from('something else'), sig), true);
    assert.equal(refusedWindowKey(identityKey), 'small_order_key');
  });

  it('the published window-v1 keys are refused, all of them', () => {
    const published = [...Object.values(WINDOW_KEYS.nodes), ...Object.values(WINDOW_KEYS.windows)].map((k) => k.public_key).sort();
    assert.deepEqual([...TEST_WINDOW_KEYS].sort(), published);
    for (const hex of published) assert.equal(refusedWindowKey(Buffer.from(hex, 'hex')), 'test_key');
    assert.equal(refusedWindowKey(newWindow().raw), null);
  });

  it('a request is sealed: no label, key or node key in the clear', async () => {
    const f = await fixture();
    const w = newWindow('The very secret laptop');
    const nodeKeyHex = spkiHex(f.identity);
    const { message, envelope, salt, hash } = buildWindowEnroll({
      identity: f.identity,
      window: { device_id: w.deviceId, public_key: w.publicKey, label: w.label, platform: 'windows' },
      nodeKey: nodeKeyHex,
      sealPolicy: f.sealPolicy
    });
    assert.equal(isSealedShape('kl.window.enroll', message), true);
    assert.equal(validateMessage('kl.window.enroll', message), null);
    const clear = Buffer.from(envelope.payload, 'base64url').toString('utf8');
    assert.ok(!clear.includes('secret laptop'));
    assert.ok(!clear.includes(w.publicKey));
    assert.ok(!clear.includes(nodeKeyHex));
    assert.equal(message.enroll_hash, hash);
    const { content } = f.phone.open(envelope, 'kl.window.enroll');
    assert.equal(content.salt, salt);
    assert.equal(saltedHash(salt, { window: content.window, node_key: content.node_key }), hash);
  });

  it('a node that does not seal builds no request', async () => {
    const f = await fixture();
    const w = newWindow();
    const window = { device_id: w.deviceId, public_key: w.publicKey, label: w.label, platform: 'windows' };
    assert.throws(() => buildWindowEnroll({ identity: f.identity, window, nodeKey: spkiHex(f.identity), sealPolicy: null }), /no_sealed_recipient/);
    assert.throws(() => buildWindowEnroll({ identity: f.identity, window, nodeKey: spkiHex(f.identity), sealPolicy: { sealing: () => false, canSeal: () => false, recipients: () => ({}) } }), /no_sealed_recipient/);
  });
});

describe('a request and its answer (personal)', () => {
  it('goes to the mailbox with a push, sealed to the recipients, and answers no QR', async () => {
    const f = await fixture();
    const answer = await asks(f.enrollment);
    assert.deepEqual(Object.keys(answer).sort(), ['expires_at', 'request_id']);
    assert.equal(f.link.sent.length, 1);
    const { envelope, push, to_device: toDevice } = f.link.sent[0];
    assert.deepEqual(push, { kind: 'window', id: answer.request_id, expires_at: answer.expires_at });
    assert.equal(toDevice, null);
    assert.equal(verifyEd25519(envelope, f.identity.publicKey), true);
    assert.ok(open(envelope).message.sealed.keys[f.phone.deviceId]);
    assert.ok(open(envelope).message.sealed.keys[f.identity.nodeId]);
  });

  it('the phone opens it, its hash from its own pin matches, and its approve writes the record with remote: true', async () => {
    const f = await fixture();
    const w = newWindow();
    await asks(f.enrollment, w);
    const { envelope } = f.link.sent[0];
    const { content } = f.phone.open(envelope, 'kl.window.enroll');
    assert.deepEqual(content.window, { device_id: w.deviceId, public_key: w.publicKey, label: w.label, platform: 'windows' });
    const pin = rawNodeKey(f.identity.publicKey);
    const qr = decodeQr(qrFor({ devicePublicKey: w.raw, nodePublicKey: pin, nonce: crypto.randomBytes(16) }));
    assert.equal(enrollHashBytes(keys.fromB64url(content.window.public_key), pin).toString('base64url'), qr.h);

    assert.equal(f.enrollment.isEnrolled(w.deviceId), false);
    assert.deepEqual(f.enrollment.onResponse(f.phone.windowRespond(envelope, 'approve')), { state: 'approved' });
    const [record] = devicesIn(f.configDir);
    assert.equal(record.deviceId, w.deviceId);
    assert.equal(record.publicKey, w.publicKey);
    assert.equal(record.label, w.label);
    assert.equal(record.remote, true);
    assert.equal(f.enrollment.isEnrolled(w.deviceId), true);
    assert.deepEqual(f.audit.entries.map((e) => e.kind), ['window.enrolled']);
    assert.deepEqual(f.audit.entries[0].data, { device_id: w.deviceId, by: f.phone.deviceId, envelope: null });
  });

  it('a read-key signature is refused bad_signature, and nothing is written', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    const answer = f.phone.windowRespond(f.link.sent[0].envelope, 'approve', { signWith: 'read' });
    assert.deepEqual(f.enrollment.onResponse(answer), { state: 'rejected', reason: 'bad_signature' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('an enroll_hash computed over another node key is refused', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    const { envelope } = f.link.sent[0];
    const { content } = f.phone.open(envelope, 'kl.window.enroll');
    const other = saltedHash(content.salt, { window: content.window, node_key: spkiHex(newNode()) });
    const answer = f.phone.windowRespond(envelope, 'approve', { overrides: { enroll_hash: other } });
    assert.deepEqual(f.enrollment.onResponse(answer), { state: 'rejected', reason: 'enroll_hash_mismatch' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('a stranger, a revoked phone and another node are refused', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    const { envelope } = f.link.sent[0];
    assert.deepEqual(f.enrollment.onResponse(createFakePhone({ boxKey: true }).windowRespond(envelope, 'approve')), { state: 'rejected', reason: 'unknown_device' });
    f.store.addToOverlay(f.phone.deviceId);
    assert.deepEqual(f.enrollment.onResponse(f.phone.windowRespond(envelope, 'approve')), { state: 'rejected', reason: 'signer_not_active' });
    assert.deepEqual(f.enrollment.onResponse({ alg: 'ES256', kid: 'x', payload: 'not json', sig: 'x' }), { state: 'rejected', reason: 'malformed' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('the first answer stands: a later phone is told already_answered, and the same one hears its own answer again', async () => {
    const second = createFakePhone({ boxKey: true });
    const first = createFakePhone({ boxKey: true });
    const f = await fixture({ phones: [first, second] });
    await asks(f.enrollment);
    const { envelope } = f.link.sent[0];
    assert.deepEqual(f.enrollment.onResponse(first.windowRespond(envelope, 'deny')), { state: 'denied' });
    assert.deepEqual(f.enrollment.onResponse(second.windowRespond(envelope, 'approve')), { state: 'rejected', reason: 'already_answered' });
    assert.deepEqual(f.enrollment.onResponse(first.windowRespond(envelope, 'deny')), { state: 'denied' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('an unknown or expired request is refused, and the status says so', async () => {
    let t = Date.parse('2026-11-04T12:00:00.000Z');
    const f = await fixture({ clock: () => t });
    const w = newWindow();
    const { request_id: id } = await asks(f.enrollment, w);
    assert.deepEqual(f.enrollment.status(id, w.deviceId), { state: 'pending' });
    assert.deepEqual(f.enrollment.status(id, newWindow().deviceId), { state: 'unknown' });
    assert.deepEqual(f.enrollment.status('not one', w.deviceId), { state: 'unknown' });
    const { envelope } = f.link.sent[0];
    t += 10 * 60 * 1000 + 1;
    assert.deepEqual(f.enrollment.status(id, w.deviceId), { state: 'expired' });
    assert.deepEqual(f.enrollment.onResponse(f.phone.windowRespond(envelope, 'approve', { signedAt: new Date(t).toISOString() })), { state: 'rejected', reason: 'expired' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('refuses a small-order key, a published key and a bad label, before anything goes out', async () => {
    const f = await fixture();
    const small = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex');
    const fixed = Buffer.from(WINDOW_KEYS.windows.A.public_key, 'hex');
    const refusal = (raw, label = 'A label') => f.enrollment.request({ deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label });
    await assert.rejects(refusal(small), { code: 'small_order_key' });
    await assert.rejects(refusal(fixed), { code: 'test_key' });
    await assert.rejects(refusal(newWindow().raw, 'two\nlines'), { code: 'bad_label' });
    await assert.rejects(refusal(newWindow().raw, '  double  spaced  '), { code: 'bad_label' });
    await assert.rejects(refusal(newWindow().raw, 'x'.repeat(65)), { code: 'bad_label' });
    const w = newWindow();
    await assert.rejects(f.enrollment.request({ deviceId: newWindow().deviceId, publicKey: w.publicKey, label: 'mismatch' }), { code: 'bad_key' });
    assert.equal(f.link.sent.length, 0);
  });

  it('refuses node_not_sealing when the node cannot seal (R-RW-30)', async () => {
    const f = await fixture();
    const enrollment = createWindowEnrollment({
      identity: f.identity, configDir: f.configDir, dataDir: f.dataDir, hosting: 'personal', ...selfOwner,
      sealPolicy: { canSeal: () => false, sealing: () => true, recipients: () => ({}), whyNot: () => 'no phone' },
      approvals: { approverStore: f.store, auditLedger: f.audit, relayClient: f.link }
    });
    cleanups.push(() => enrollment.close());
    await assert.rejects(asks(enrollment), { code: 'node_not_sealing' });
    assert.equal(f.link.sent.length, 0);
  });

  it('one pending request per device: asking again is the same request, and no new card', async () => {
    const f = await fixture();
    const w = newWindow();
    const one = await asks(f.enrollment, w);
    const two = await asks(f.enrollment, w);
    assert.deepEqual(two, one);
    assert.equal(f.link.sent.length, 1);
  });

  it('a request while the link is down is refused and leaves nothing pending', async () => {
    const f = await fixture();
    f.link.connected = false;
    const w = newWindow();
    await assert.rejects(asks(f.enrollment, w), { code: 'phone_unreachable' });
    f.link.connected = true;
    await asks(f.enrollment, w);
    assert.equal(f.link.sent.length, 1);
  });

  it('a pending request goes out again when the link comes back', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    f.link.listeners.get('connected')();
    await waitFor(() => f.link.sent.length === 2, 'the card again');
    assert.deepEqual(f.link.sent[1].envelope, f.link.sent[0].envelope);
  });

  it('the node has a rate limit per hour, and its cap holds across devices', async () => {
    let t = Date.parse('2026-11-04T12:00:00.000Z');
    const f = await fixture({ clock: () => t, enrollmentLimits: { requestsPerHour: 2 } });
    await asks(f.enrollment);
    await asks(f.enrollment);
    await assert.rejects(asks(f.enrollment), { code: 'rate_limited' });
    t += 60 * 60 * 1000 + 1;
    await asks(f.enrollment);
  });

  it('an old request is forgotten, so a flood of them holds no memory', async () => {
    let t = Date.parse('2026-11-04T12:00:00.000Z');
    const f = await fixture({ clock: () => t, enrollmentLimits: { requestsPerHour: 1000 } });
    for (let i = 0; i < 10; i += 1) await asks(f.enrollment);
    assert.equal(f.enrollment.held(), 10);
    t += 11 * 60 * 1000 + 10 * 60 * 1000;
    await asks(f.enrollment);
    assert.equal(f.enrollment.held(), 1);
  });

  it('close() stops listening to the link and refuses what comes after', async () => {
    const f = await fixture();
    f.enrollment.close();
    assert.equal(f.link.listeners.size, 0);
    await assert.rejects(asks(f.enrollment), { code: 'remote_window_off' });
  });
});

describe('revoke', () => {
  async function enrolled(hosting = 'personal') {
    const f = await fixture({ hosting });
    const w = newWindow();
    await asks(f.enrollment, w);
    return { ...f, w, request: f.link.sent[0].envelope };
  }

  it('on a personal node removes the record at once and is audited', async () => {
    const f = await enrolled();
    f.enrollment.onResponse(f.phone.windowRespond(f.request, 'approve'));
    let told = 0;
    f.enrollment.onChange(() => { told += 1; });
    const out = f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, f.w.deviceId));
    assert.deepEqual(out, { state: 'revoked' });
    assert.deepEqual(devicesIn(f.configDir), []);
    assert.equal(f.enrollment.isEnrolled(f.w.deviceId), false);
    assert.equal(told, 1);
    assert.deepEqual(f.audit.entries.map((e) => e.kind), ['window.enrolled', 'window.revoked']);
  });

  it('is refused with the read key, from a stranger, and for another node', async () => {
    const f = await enrolled();
    f.enrollment.onResponse(f.phone.windowRespond(f.request, 'approve'));
    const revoke = (phone, nodeId, options) => phone.windowRevoke(nodeId, f.identity.box.jwk, f.w.deviceId, options);
    assert.deepEqual(f.enrollment.onRevoke(revoke(f.phone, f.identity.nodeId, { signWith: 'read' })), { state: 'rejected', reason: 'bad_signature' });
    assert.deepEqual(f.enrollment.onRevoke(revoke(createFakePhone(), f.identity.nodeId)), { state: 'rejected', reason: 'unknown_device' });
    assert.deepEqual(f.enrollment.onRevoke(revoke(f.phone, newNode().nodeId)), { state: 'rejected', reason: 'wrong_node' });
    assert.equal(f.enrollment.isEnrolled(f.w.deviceId), true);
  });

  it('never removes a local pairing', async () => {
    const f = await enrolled();
    const local = newWindow('Desk');
    let doc = pairing.emptyDevices();
    doc = pairing.upsertDevice(doc, { deviceId: local.deviceId, publicKey: local.publicKey, label: local.label, pairedAt: '2026-11-04T10:00:00.000Z' });
    pairing.writeFileAtomic(path.join(f.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
    const out = f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, local.deviceId));
    assert.deepEqual(out, { state: 'rejected', reason: 'not_remote' });
    assert.equal(devicesIn(f.configDir).length, 1);
  });

  it('a window a phone revoked mid-request has no request left to approve', async () => {
    const f = await enrolled();
    assert.deepEqual(f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, f.w.deviceId)), { state: 'revoked' });
    assert.deepEqual(f.enrollment.onResponse(f.phone.windowRespond(f.request, 'approve')), { state: 'rejected', reason: 'already_answered' });
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('a revoke replayed after the window enrolled again does nothing', async () => {
    const f = await enrolled();
    f.enrollment.onResponse(f.phone.windowRespond(f.request, 'approve'));
    const old = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, f.w.deviceId, { now: Date.now() - 30 * 60 * 1000 });
    assert.deepEqual(f.enrollment.onRevoke(old), { state: 'stale' });
    assert.equal(f.enrollment.isEnrolled(f.w.deviceId), true);
  });
});

describe('the list', () => {
  it('is sealed to the one phone and names the enrolled windows, with attached', async () => {
    const attachedIds = [];
    const other = createFakePhone({ boxKey: true });
    const first = createFakePhone({ boxKey: true });
    const f = await fixture({ phones: [first, other], attached: () => attachedIds });
    const a = newWindow('Road laptop');
    const b = newWindow('Kitchen');
    await asks(f.enrollment, a);
    await asks(f.enrollment, b);
    f.enrollment.onResponse(first.windowRespond(f.link.sent[0].envelope, 'approve'));
    f.enrollment.onResponse(first.windowRespond(f.link.sent[1].envelope, 'approve'));
    attachedIds.push(b.deviceId);
    const envelope = f.enrollment.list(first.deviceId);
    assert.equal(verifyEd25519(envelope, f.identity.publicKey), true);
    const { message } = open(envelope);
    assert.equal(validateMessage('kl.window.list', message), null);
    assert.equal(message.to_device, first.deviceId);
    assert.deepEqual(Object.keys(message.sealed.keys), [first.deviceId]);
    const clear = Buffer.from(envelope.payload, 'base64url').toString('utf8');
    assert.ok(!clear.includes('Road laptop'));
    const { content } = first.open(envelope, 'kl.window.list');
    const rows = Object.fromEntries(content.windows.map((row) => [row.device_id, row]));
    assert.equal(rows[a.deviceId].label, 'Road laptop');
    assert.equal(rows[a.deviceId].attached, false);
    assert.equal(rows[b.deviceId].attached, true);
    assert.equal(rows[b.deviceId].platform, 'windows');
    assert.ok(rows[b.deviceId].enrolled_at);
    assert.throws(() => other.open(envelope, 'kl.window.list'), { reason: 'not_recipient' });
  });

  it('leaves out a local pairing, and refuses a phone that is not an approver or has no box', async () => {
    const f = await fixture();
    const local = newWindow('Desk');
    let doc = pairing.emptyDevices();
    doc = pairing.upsertDevice(doc, { deviceId: local.deviceId, publicKey: local.publicKey, label: local.label, pairedAt: '2026-11-04T10:00:00.000Z' });
    pairing.writeFileAtomic(path.join(f.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
    assert.deepEqual(f.phone.open(f.enrollment.list(f.phone.deviceId), 'kl.window.list').content.windows, []);
    assert.throws(() => f.enrollment.list(createFakePhone().deviceId), { code: 'unknown_device' });
  });
});

describe('the link methods (Task 6 answered remote_window_off)', () => {
  it('window.enroll_response, window.revoke and window.list reach the enrollment', async () => {
    const f = await fixture();
    const w = newWindow();
    await asks(f.enrollment, w);
    const server = { _sealRefusal: () => null };
    const handlers = createWindowHandlers({ server, dialer: { open: async () => ({ ok: true }) }, enrollment: f.enrollment });
    const dispatch = createRelayDispatcher({ phoneApprover: {}, approverStore: f.store, auditLedger: f.audit, windowHandlers: () => handlers });
    assert.deepEqual(await dispatch('window.enroll_response', { envelope: f.phone.windowRespond(f.link.sent[0].envelope, 'approve') }), { state: 'approved' });
    assert.deepEqual(await dispatch('window.enroll_response', {}), { state: 'rejected', reason: 'malformed' });
    const listed = await dispatch('window.list', { to_device: f.phone.deviceId });
    assert.equal(f.phone.open(listed.envelope, 'kl.window.list').content.windows.length, 1);
    assert.deepEqual(await dispatch('window.list', { to_device: 'nobody' }), { ok: false, code: 'unknown_device' });
    assert.deepEqual(await dispatch('window.revoke', { envelope: f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, w.deviceId) }), { state: 'revoked' });
  });

  it('with no enrollment they still answer remote_window_off', async () => {
    const handlers = createWindowHandlers({ server: { _sealRefusal: () => null }, dialer: { open: async () => ({ ok: true }) } });
    const dispatch = createRelayDispatcher({ phoneApprover: {}, approverStore: {}, auditLedger: {}, windowHandlers: () => handlers });
    for (const method of ['window.enroll_response', 'window.revoke', 'window.list']) {
      assert.deepEqual(await dispatch(method, {}), { ok: false, code: 'remote_window_off' });
    }
  });

  // Ruling from Task 6's review: a phone can cut a window off whatever the feature's state.
  async function hostOff(features) {
    const f = await fixture();
    const w = newWindow('Road laptop');
    let doc = pairing.emptyDevices();
    doc = pairing.upsertDevice(doc, { deviceId: w.deviceId, publicKey: w.publicKey, label: w.label, pairedAt: '2026-11-04T10:00:00.000Z', remote: true });
    pairing.writeFileAtomic(path.join(f.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
    fs.writeFileSync(path.join(f.configDir, 'node.yaml'), 'name: web-01\nprofile: agent\nhosting: personal\n', { mode: 0o644 });
    let handlers = null;
    const approvals = {
      identity: f.identity, approverStore: f.store, auditLedger: f.audit, relayClient: f.link, sealPolicy: f.sealPolicy,
      setWindowHandlers: (h) => { handlers = h; }
    };
    const host = createDesktopBridgeHost({ dataDir: f.dataDir, configDir: f.configDir, features, ports: { desktopBridge: 0 }, ...selfOwner });
    cleanups.push(() => host.stop());
    const dispatch = createRelayDispatcher({ phoneApprover: {}, approverStore: f.store, auditLedger: f.audit, windowHandlers: () => handlers });
    return { ...f, w, host, approvals, dispatch, handlersNow: () => handlers };
  }

  it('with the feature off a phone lists and revokes through the relay dispatcher; open and enroll_response stay off', async () => {
    const f = await hostOff({ remoteWindow: false });
    await f.host.start({ approvals: f.approvals });
    const listed = await f.dispatch('window.list', { to_device: f.phone.deviceId });
    assert.deepEqual(f.phone.open(listed.envelope, 'kl.window.list').content.windows.map((row) => row.device_id), [f.w.deviceId]);
    assert.deepEqual(await f.dispatch('window.open', { session_id: 'x' }), { ok: false, code: 'remote_window_off' });
    assert.deepEqual(await f.dispatch('window.enroll_response', { envelope: {} }), { ok: false, code: 'remote_window_off' });
    const revoke = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, f.w.deviceId);
    assert.deepEqual(await f.dispatch('window.revoke', { envelope: revoke }), { state: 'revoked' });
    assert.deepEqual(devicesIn(f.configDir), []);
    await f.host.stop();
    assert.equal(f.handlersNow(), null);
    assert.deepEqual(await f.dispatch('window.revoke', { envelope: revoke }), { ok: false, code: 'remote_window_off' });
  });

  it('with no approvals the off host is as inert as it was', async () => {
    const host = createDesktopBridgeHost({ dataDir: tempDir('kl-off-'), configDir: tempDir('kl-off-'), features: {}, ports: {}, ...selfOwner });
    assert.equal(await host.start({}), null);
    await host.stop();
  });

  // The whole host, on: each row through the relay dispatcher, as a front door reaches it.
  it('with the feature on and a front door, every method has a real row through the host', async () => {
    const f = await hostOff({ remoteWindow: true });
    const dataDir = f.dataDir;
    const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
    const core = createCore({
      ...servicePorts, ...f.host.coreDeps,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny', workingDirectory: dataDir, builtinSkillsDir: path.join(__dirname, '..', 'skills')
    });
    await core.start();
    cleanups.push(() => core.shutdown());
    f.link.frontDoorPin = { mesh_url: 'wss://mesh.kl.example.com/mesh/v1', mesh_cert_fingerprint: 'a'.repeat(64) };
    const server = await f.host.start({ core, ports: servicePorts, approvals: f.approvals });
    assert.ok(server.windowEnrollment, 'the seal takes an unknown device only now');
    assert.deepEqual(Object.keys(f.handlersNow()).sort(), ['window.enroll_response', 'window.list', 'window.open', 'window.revoke']);
    assert.deepEqual(await f.dispatch('window.enroll_response', {}), { state: 'rejected', reason: 'malformed' });
    const listed = await f.dispatch('window.list', { to_device: f.phone.deviceId });
    assert.equal(f.phone.open(listed.envelope, 'kl.window.list').content.windows.length, 1);
    const revoke = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, f.w.deviceId);
    assert.deepEqual(await f.dispatch('window.revoke', { envelope: revoke }), { state: 'revoked' });
    await f.host.stop();
  });

  it('with the feature on and no front door, the records still answer and open does not', async () => {
    const f = await hostOff({ remoteWindow: true });
    const dataDir = f.dataDir;
    const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
    const core = createCore({
      ...servicePorts, ...f.host.coreDeps,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny', workingDirectory: dataDir, builtinSkillsDir: path.join(__dirname, '..', 'skills')
    });
    await core.start();
    cleanups.push(() => core.shutdown());
    const server = await f.host.start({ core, ports: servicePorts, approvals: f.approvals });
    assert.equal(server.windowEnrollment, null);
    assert.deepEqual(Object.keys(f.handlersNow()).sort(), ['window.list', 'window.revoke']);
    await f.host.stop();
  });

  it('a window type never gets staged through a device.* method', async () => {
    const f = await fixture({ hosting: 'service' });
    await asks(f.enrollment);
    const dispatch = createRelayDispatcher({ phoneApprover: {}, approverStore: f.store, auditLedger: f.audit });
    const revoke = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, newWindow().deviceId);
    assert.deepEqual(await dispatch('device.revoke', { envelope: revoke }), { state: 'rejected', reason: 'malformed' });
    const answer = f.phone.windowRespond(f.link.sent[0].envelope, 'approve');
    assert.deepEqual(await dispatch('device.enroll', { envelope: answer }), { state: 'rejected', reason: 'malformed' });
  });
});

describe('the phone routes (R-RW-14)', () => {
  function routes(rpc, mailbox = new Mailbox()) {
    mailbox.registerType('kl.window.', { ttlMs: 600000 });
    const table = new Map();
    const active = new Map();
    const relay = {
      mailbox,
      phoneApi: { registerRoute: (method, pattern, options) => table.set(`${method} ${pattern}`, options) },
      nodeHub: { rpc, nodes: () => [], nodeById: () => null },
      approvals: {},
      invites: {},
      devices: { nodesForDevice: (id) => (active.get(id) || []).map((nodeId) => ({ node_id: nodeId, state: 'active' })) }
    };
    registerPhoneRoutes(relay);
    return { call: (key, ctx) => table.get(key).handler({}, ctx), table, active, mailbox };
  }
  const ctxOf = (phone, body) => ({ deviceId: phone.deviceId, device: { jwk: phone.jwk }, key: 'device', body, query: {}, params: {} });

  it('have their auth', () => {
    const { table } = routes(async () => ({}));
    assert.equal(table.get('POST /v1/windows/enroll').auth, 'device');
    assert.equal(table.get('POST /v1/windows/revoke').auth, 'device');
    assert.equal(table.get('GET /v1/windows').auth, 'read');
  });

  it('forward an answer to the node it names, unchanged, and pass back what the node said', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    const calls = [];
    const r = routes(async (nodeId, method, params) => {
      calls.push({ nodeId, method, params });
      return f.enrollment.onResponse(params.envelope);
    });
    r.active.set(f.phone.deviceId, [f.identity.nodeId]);
    const answer = f.phone.windowRespond(f.link.sent[0].envelope, 'approve');
    const out = await r.call('POST /v1/windows/enroll', ctxOf(f.phone, answer));
    assert.deepEqual(out, { status: 202, body: { state: 'approved', reason: null, pending_apply: false } });
    assert.equal(calls[0].method, 'window.enroll_response');
    assert.equal(calls[0].nodeId, f.identity.nodeId);
    assert.deepEqual(calls[0].params.envelope, answer);
  });

  it('forward a revoke, and refuse what is not this device\'s, or a node it does not approve on', async () => {
    const f = await fixture();
    const other = createFakePhone();
    const calls = [];
    const r = routes(async (nodeId, method) => { calls.push(method); return { state: 'revoked' }; });
    r.active.set(f.phone.deviceId, [f.identity.nodeId]);
    r.active.set(other.deviceId, [f.identity.nodeId]);
    const revoke = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, newWindow().deviceId);
    assert.equal((await r.call('POST /v1/windows/revoke', ctxOf(f.phone, revoke))).body.state, 'revoked');
    assert.deepEqual(calls, ['window.revoke']);
    await assert.rejects(r.call('POST /v1/windows/revoke', ctxOf(other, revoke)), { code: 'bad_window_revoke' });
    const elsewhere = f.phone.windowRevoke(newNode().nodeId, f.identity.box.jwk, newWindow().deviceId);
    await assert.rejects(r.call('POST /v1/windows/revoke', ctxOf(f.phone, elsewhere)), { code: 'forbidden' });
    await assert.rejects(r.call('POST /v1/windows/enroll', ctxOf(f.phone, revoke)), { code: 'malformed' });
    const readSigned = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, newWindow().deviceId, { signWith: 'read' });
    await assert.rejects(r.call('POST /v1/windows/revoke', ctxOf(f.phone, readSigned)), { code: 'bad_window_revoke' });
    assert.equal(calls.length, 1);
  });

  it('an unreachable node is 503 node_offline', async () => {
    const f = await fixture();
    const r = routes(async () => { throw Object.assign(new Error('gone'), { code: 'offline' }); });
    r.active.set(f.phone.deviceId, [f.identity.nodeId]);
    const revoke = f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, newWindow().deviceId);
    await assert.rejects(r.call('POST /v1/windows/revoke', ctxOf(f.phone, revoke)), { status: 503, code: 'node_offline' });
  });

  it('GET /v1/windows fans out: a list per node, null for one that cannot say, and what is still asking', async () => {
    const f = await fixture();
    await asks(f.enrollment);
    const dead = newNode().nodeId;
    const r = routes(async (nodeId, method, params) => {
      assert.equal(method, 'window.list');
      if (nodeId === dead) throw new Error('offline');
      return { envelope: f.enrollment.list(params.to_device) };
    });
    r.active.set(f.phone.deviceId, [f.identity.nodeId, dead]);
    r.mailbox.put(f.identity.nodeId, f.link.sent[0].envelope);
    const { body } = await r.call('GET /v1/windows', ctxOf(f.phone));
    const types = body.filter((row) => row.envelope).map((row) => open(row.envelope).message.type).sort();
    assert.deepEqual(types, ['kl.window.enroll', 'kl.window.list']);
    assert.deepEqual(body.filter((row) => row.envelope === null), [{ node_id: dead, envelope: null }]);
  });
});

// A window at the far end of a transport pair.
function openWindow(server, device, { pin = null, withSeal = true } = {}) {
  const [nodeEnd, windowEnd] = createTransportPair();
  const sessionId = sessionIdOf(`enroll ${crypto.randomUUID()}`);
  const window = { received: [], sealClose: null, wireClose: null, windowEnd };
  const seal = WindowSeal.window({
    sessionId, deviceId: device.deviceId, publicKey: device.raw, pin,
    sign: (bytes) => crypto.sign(null, bytes, device.privateKey),
    write: (bytes) => windowEnd.send(bytes),
    onClose: (close) => { window.sealClose = close; }
  });
  window.seal = seal;
  windowEnd.on('data', async (bytes) => {
    const result = await seal.next(bytes);
    for (const frame of result.frames) window.received.push(JSON.parse(frame.toString('utf8')));
    if (result.close) window.sealClose = result.close;
  });
  windowEnd.on('close', (code, reason) => { window.wireClose = { code, reason }; });
  window.sendBytes = (bytes) => { for (const step of seal.records(bytes)) assert.ok(step); };
  window.send = (obj) => window.sendBytes(Buffer.from(JSON.stringify(obj)));
  window.call = async (id, method, params) => {
    window.send({ t: 'call', id, method, params });
    return waitFor(() => window.received.find((f) => f.t === 'result' && f.id === id), `the answer to ${method}`);
  };
  window.attached = server.attachSealed({ sessionId, transport: nodeEnd });
  window.outcome = window.attached.then((value) => ({ value }), (error) => ({ error }));
  if (withSeal) seal.next(null);
  return window;
}

async function bridge({ hosting = 'personal', devices = [], limits = {}, phones = null, canSeal = null, clock = null, withEnrollment = true } = {}) {
  const identity = newNode();
  const dispatcherFrames = [];
  const f = await fixture({ hosting, phones, identity, clock });
  const server = new DesktopBridgeServer({
    identity,
    configDir: f.configDir,
    port: 0,
    version: '26.11.0',
    adminUid: UID,
    geteuid: () => UID,
    account: 'tester',
    limits: { deviceRecheckMs: 20, ...limits },
    approvals: { sealPolicy: canSeal ? { canSeal } : f.sealPolicy },
    createDispatcher: () => ({
      served: { handle: ['chat:load'], on: [] },
      providersConfigured: () => true,
      async handleFrame(conn, frame) { dispatcherFrames.push({ conn, frame }); },
      async onDisconnect() {},
      onRevoke() {},
      forwardAmbient() {}
    })
  });
  if (devices.length) {
    let doc = pairing.emptyDevices();
    for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-11-04T10:00:00.000Z', remote: d.remote });
    pairing.writeFileAtomic(path.join(f.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
  }
  if (withEnrollment) server.setWindowEnrollment(f.enrollment);
  cleanups.push(() => server.stop());
  return { ...f, server, dispatcherFrames };
}

const enrollingFrame = (window) => waitFor(() => window.received.find((f) => f.t === 'enrolling'), 'the enrolling frame');

describe('the enroll-only session (R-RW-36)', () => {
  it('an unknown device with a good signature enrolls; without the option it is the one 4401', async () => {
    const off = await bridge({ withEnrollment: false });
    const refused = openWindow(off.server, newWindow());
    const { error } = await refused.outcome;
    assert.equal(error.closeCode, CLOSE.BAD_SIGNATURE);

    const on = await bridge();
    const window = openWindow(on.server, newWindow());
    const { value } = await window.outcome;
    assert.equal(value.enrolling, true);
    await enrollingFrame(window);
    assert.equal(on.server.connections.size, 0);
    assert.deepEqual(on.server.connected, []);
  });

  it('a window with a bad signature gets the same 4401 with the option on', async () => {
    const on = await bridge();
    const device = newWindow();
    const [nodeEnd, windowEnd] = createTransportPair();
    const sessionId = sessionIdOf(`bad ${crypto.randomUUID()}`);
    const seal = WindowSeal.window({
      sessionId, deviceId: device.deviceId, publicKey: device.raw,
      sign: () => crypto.randomBytes(64),
      write: (bytes) => windowEnd.send(bytes),
      onClose: () => {}
    });
    windowEnd.on('data', (bytes) => seal.next(bytes));
    const attaching = on.server.attachSealed({ sessionId, transport: nodeEnd });
    seal.next(null);
    await assert.rejects(attaching, (err) => err.closeCode === CLOSE.BAD_SIGNATURE && err.code === 'handshake');
  });

  it('serves window.enroll and window.enrollStatus, with the device from the handshake, never the params', async () => {
    const b = await bridge();
    const device = newWindow();
    const window = openWindow(b.server, device);
    await enrollingFrame(window);
    const answer = await window.call(1, 'window.enroll', { label: 'Road laptop', deviceId: newWindow().deviceId });
    assert.deepEqual(Object.keys(answer.value).sort(), ['expires_at', 'request_id']);
    const { content } = b.phone.open(b.link.sent[0].envelope, 'kl.window.enroll');
    assert.equal(content.window.device_id, device.deviceId);
    assert.equal(content.window.public_key, device.publicKey);
    assert.equal(content.window.label, 'Road laptop');
    const status = await window.call(2, 'window.enrollStatus', { request_id: answer.value.request_id });
    assert.deepEqual(status.value, { state: 'pending' });
    assert.equal(b.dispatcherFrames.length, 0);
  });

  it('a refusal is a sealed result with a code, and the connection stays', async () => {
    const b = await bridge();
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    const answer = await window.call(1, 'window.enroll', { label: 'two\nlines' });
    assert.equal(answer.code, 'bad_label');
    assert.equal(window.sealClose, null);
  });

  it('a small-order key completes the handshake and cannot make a request', async () => {
    const b = await bridge();
    const raw = Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex');
    const baseEncoding = Buffer.from('5866666666666666666666666666666666666666666666666666666666666666', 'hex');
    const sig = Buffer.concat([baseEncoding, Buffer.from('01'.padEnd(64, '0'), 'hex')]);
    const device = { deviceId: keys.deriveDeviceId(raw, 'kld-'), raw };
    const [nodeEnd, windowEnd] = createTransportPair();
    const sessionId = sessionIdOf(`small ${crypto.randomUUID()}`);
    const received = [];
    const seal = WindowSeal.window({ sessionId, deviceId: device.deviceId, publicKey: raw, sign: () => sig, write: (bytes) => windowEnd.send(bytes), onClose: () => {} });
    windowEnd.on('data', async (bytes) => {
      const result = await seal.next(bytes);
      for (const frame of result.frames) received.push(JSON.parse(frame.toString('utf8')));
    });
    b.server.attachSealed({ sessionId, transport: nodeEnd }).catch(() => {});
    seal.next(null);
    await waitFor(() => received.find((f) => f.t === 'enrolling'), 'the enrolling frame');
    for (const step of seal.records(Buffer.from(JSON.stringify({ t: 'call', id: 1, method: 'window.enroll', params: { label: 'Nothing' } })))) assert.ok(step);
    const answer = await waitFor(() => received.find((f) => f.t === 'result'), 'the refusal');
    assert.equal(answer.code, 'small_order_key');
    assert.equal(b.link.sent.length, 0);
  });

  it('every proxied channel and every other method closes the connection, and no frame reaches the dispatcher', async () => {
    const b = await bridge({ limits: { maxEnrollWindows: 1000 } });
    const names = Object.keys(REMOTE_CLASSES);
    assert.ok(names.length > 100, 'the class table is here');
    const shapes = [];
    for (const name of names) shapes.push({ t: 'invoke', id: 1, channel: name, args: [] });
    for (const name of names) shapes.push({ t: 'call', id: 1, method: name, params: {} });
    shapes.push({ t: 'send', channel: 'chat:load', args: [] }, { t: 'ready' }, { t: 'call', id: 'x', method: 'window.enroll', params: {} }, { t: 'call', method: 'window.enroll' });
    for (const shape of shapes) {
      const window = openWindow(b.server, newWindow());
      await enrollingFrame(window);
      window.send(shape);
      await waitFor(() => window.sealClose, `the close on ${shape.channel || shape.method || shape.t}`);
      assert.equal(window.sealClose.code, CLOSE.MALFORMED);
      assert.equal(window.sealClose.reason, 'peer');
      assert.equal(window.received.some((f) => f.t === 'result'), false);
    }
    assert.equal(b.dispatcherFrames.length, 0);
    assert.equal(b.server.enrolling.size, 0);
  });

  it('a frame that does not parse closes it', async () => {
    const b = await bridge();
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    window.sendBytes(Buffer.from('not json'));
    await waitFor(() => window.sealClose, 'the close');
    assert.equal(window.sealClose.code, CLOSE.MALFORMED);
  });

  it('holds the seal to 4096 bytes and no fragments until it is promoted', async () => {
    const b = await bridge();
    const big = openWindow(b.server, newWindow());
    await enrollingFrame(big);
    big.sendBytes(Buffer.alloc(4097, 0x20));
    await waitFor(() => big.wireClose, 'the close');
    assert.equal(big.wireClose.code, CLOSE.MALFORMED);

    const fragments = openWindow(b.server, newWindow());
    await enrollingFrame(fragments);
    fragments.sendBytes(Buffer.alloc(2 * 1024 * 1024, 0x20));
    await waitFor(() => fragments.wireClose, 'the close');
    assert.equal(fragments.wireClose.code, CLOSE.MALFORMED);
  });

  it('is promoted on an approve, with no new handshake, and only then has the dispatcher and full limits', async () => {
    const b = await bridge();
    const device = newWindow();
    const window = openWindow(b.server, device);
    await enrollingFrame(window);
    await window.call(1, 'window.enroll', { label: 'Road laptop' });
    const connected = new Promise((resolve) => { b.server.once('connected', resolve); });
    assert.deepEqual(b.enrollment.onResponse(b.phone.windowRespond(b.link.sent[0].envelope, 'approve')), { state: 'approved' });
    const event = await connected;
    assert.deepEqual(event, { deviceId: device.deviceId, label: 'Road laptop', remote: true });
    const ready = await waitFor(() => window.received.find((f) => f.t === 'ready'), 'ready');
    assert.equal(ready.service.nodeId, b.identity.nodeId);
    assert.equal(b.server.enrolling.size, 0);
    assert.equal(b.server.connections.size, 1);
    window.send({ t: 'invoke', id: 7, channel: 'chat:load', args: [{ pad: 'x'.repeat(8000) }] });
    await waitFor(() => b.dispatcherFrames.length === 1, 'the dispatcher');
    assert.equal(b.dispatcherFrames[0].conn.remote, true);
    assert.equal(window.sealClose, null);
  });

  it('an enrollStatus poll sees approved, and then ready', async () => {
    const b = await bridge({ limits: { deviceRecheckMs: 100000 } });
    const device = newWindow();
    const window = openWindow(b.server, device);
    await enrollingFrame(window);
    const asked = await window.call(1, 'window.enroll', { label: 'Road laptop' });
    // A record written with no word to the server, as if by another process.
    let doc = pairing.emptyDevices();
    doc = pairing.upsertDevice(doc, { deviceId: device.deviceId, publicKey: device.publicKey, label: 'Road laptop', pairedAt: '2026-11-04T10:00:00.000Z', remote: true });
    pairing.writeFileAtomic(path.join(b.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
    const status = await window.call(2, 'window.enrollStatus', { request_id: asked.value.request_id });
    assert.deepEqual(status.value, { state: 'approved' });
    await waitFor(() => window.received.find((f) => f.t === 'ready'), 'ready');
  });

  it('a denied request closes it under the seal: the state in a sealed frame and 4403 in a close record', async () => {
    const b = await bridge();
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    await window.call(1, 'window.enroll', { label: 'Road laptop' });
    assert.deepEqual(b.enrollment.onResponse(b.phone.windowRespond(b.link.sent[0].envelope, 'deny')), { state: 'denied' });
    await waitFor(() => window.sealClose, 'the close record');
    assert.deepEqual(window.received.find((f) => f.t === 'enrollState'), { t: 'enrollState', state: 'denied' });
    assert.deepEqual(window.sealClose, { code: 4403, reason: 'peer' });
    assert.deepEqual(devicesIn(b.configDir), []);
  });

  it('an enrollStatus that finds it denied answers under the seal before the close record', async () => {
    const b = await bridge({ limits: { deviceRecheckMs: 100000 } });
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    const asked = await window.call(1, 'window.enroll', { label: 'Road laptop' });
    b.server.windowEnrollment = { ...b.enrollment, status: () => ({ state: 'denied' }) };
    const answer = await window.call(2, 'window.enrollStatus', { request_id: asked.value.request_id });
    assert.deepEqual(answer.value, { state: 'denied' });
    await waitFor(() => window.sealClose, 'the close record');
    assert.equal(window.sealClose.code, 4403);
  });

  it('an expired request closes it the same way', async () => {
    let t = Date.parse('2026-11-04T12:00:00.000Z');
    const b = await bridge({ clock: () => t });
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    await window.call(1, 'window.enroll', { label: 'Road laptop' });
    t += 10 * 60 * 1000 + 1;
    await waitFor(() => window.sealClose, 'the close record');
    assert.deepEqual(window.received.find((f) => f.t === 'enrollState'), { t: 'enrollState', state: 'expired' });
    assert.equal(window.sealClose.code, 4403);
  });

  it('an old denial does not end a new connection that has asked nothing', async () => {
    const b = await bridge();
    const device = newWindow();
    const first = openWindow(b.server, device);
    await enrollingFrame(first);
    await first.call(1, 'window.enroll', { label: 'Road laptop' });
    b.enrollment.onResponse(b.phone.windowRespond(b.link.sent[0].envelope, 'deny'));
    await waitFor(() => first.sealClose, 'the first close');
    const second = openWindow(b.server, device);
    await enrollingFrame(second);
    await delay(80);
    assert.equal(second.sealClose, null);
    const asked = await second.call(1, 'window.enroll', { label: 'Road laptop' });
    assert.ok(asked.value.request_id);
    assert.equal(b.link.sent.length, 2);
  });

  it('has a deadline, closed under the seal', async () => {
    const b = await bridge({ limits: { enrollDeadlineMs: 30 } });
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    await waitFor(() => window.sealClose, 'the deadline');
    assert.equal(window.sealClose.code, 4403);
    assert.equal(b.server.enrolling.size, 0);
  });

  it('has its own cap, does not count against maxDevices, and one connection per device', async () => {
    const b = await bridge({ limits: { maxEnrollWindows: 2, maxDevices: 1 } });
    const device = newWindow();
    const one = openWindow(b.server, device);
    await enrollingFrame(one);
    const two = openWindow(b.server, newWindow());
    await enrollingFrame(two);
    assert.equal(b.server.enrolling.size, 2);
    const three = openWindow(b.server, newWindow());
    await waitFor(() => three.sealClose, 'the third refused');
    assert.equal(three.sealClose.code, CLOSE.TRY_AGAIN);
    const again = openWindow(b.server, device);
    await enrollingFrame(again);
    await waitFor(() => one.sealClose, 'the first replaced');
    assert.equal(one.sealClose.code, CLOSE.NORMAL);
    assert.equal(b.server.enrolling.size, 2);
  });

  it('bounds the answers a window that reads nothing can hold', async () => {
    const b = await bridge({ limits: { enrollCallsMax: 3 } });
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    for (let i = 1; i <= 4; i += 1) window.send({ t: 'call', id: i, method: 'window.enrollStatus', params: { request_id: 'x' } });
    await waitFor(() => window.sealClose, 'the close');
    assert.equal(window.sealClose.code, CLOSE.TRY_AGAIN);
  });

  // Task 5's re-review: unreadable is not unknown.
  it('a devices file that cannot be read puts nobody in the enroll state: 4504, for a stranger and an enrolled device alike', async () => {
    const remote = { ...newWindow('Road'), remote: true };
    const b = await bridge({ devices: [remote] });
    fs.writeFileSync(path.join(b.configDir, pairing.DEVICES_FILE), '{ not json');
    for (const device of [newWindow(), remote]) {
      const window = openWindow(b.server, device);
      const { error } = await window.outcome;
      assert.equal(error.closeCode, CLOSE.RECORD_UNREADABLE, device.label);
      assert.equal(window.received.some((f) => f.t === 'enrolling'), false);
    }
    assert.equal(b.server.enrolling.size, 0);
  });

  it('one corrupt read at the lookup, and a good file straight after, is still 4504: never the enroll state', async () => {
    const remote = { ...newWindow('Road'), remote: true };
    const b = await bridge({ devices: [remote] });
    const real = b.server._readDevices.bind(b.server);
    let corrupt = 1;
    b.server._readDevices = () => {
      if (corrupt > 0) {
        corrupt -= 1;
        return { doc: null };
      }
      return real();
    };
    const window = openWindow(b.server, remote);
    const { error } = await window.outcome;
    assert.equal(corrupt, 0);
    assert.equal(error.closeCode, CLOSE.RECORD_UNREADABLE);
    assert.equal(window.received.some((f) => f.t === 'enrolling'), false);
    assert.equal(b.link.sent.length, 0);
    // And it attaches on the next try, as the device it is.
    const again = openWindow(b.server, remote);
    const { value } = await again.outcome;
    assert.equal(value.deviceId, remote.deviceId);
  });

  it('a local pairing stays 4403 not_remote, and a known remote key attaches as before', async () => {
    const local = { ...newWindow('Desk'), remote: false };
    const remote = { ...newWindow('Road'), remote: true };
    const b = await bridge({ devices: [local, remote] });
    const refused = openWindow(b.server, local);
    await waitFor(() => refused.sealClose, 'the close record');
    assert.deepEqual(refused.sealClose, { code: CLOSE.NOT_REMOTE, reason: 'peer' });
    const fine = openWindow(b.server, remote);
    const { value } = await fine.outcome;
    assert.equal(value.deviceId, remote.deviceId);
    assert.equal(fine.received.some((f) => f.t === 'enrolling'), false);
  });

  it('a record that turns out local closes an enrolling window not_remote', async () => {
    const b = await bridge();
    const device = newWindow();
    const window = openWindow(b.server, device);
    await enrollingFrame(window);
    let doc = pairing.emptyDevices();
    doc = pairing.upsertDevice(doc, { deviceId: device.deviceId, publicKey: device.publicKey, label: 'Desk', pairedAt: '2026-11-04T10:00:00.000Z' });
    pairing.writeFileAtomic(path.join(b.configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
    await waitFor(() => window.sealClose, 'the close record');
    assert.equal(window.sealClose.code, CLOSE.NOT_REMOTE);
    assert.equal(b.server.connections.size, 0);
  });

  it('refuses node_not_sealing, under the seal, on a node that stops sealing while it waits', async () => {
    let sealing = true;
    const b = await bridge({ canSeal: () => sealing });
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    sealing = false;
    await waitFor(() => window.sealClose, 'the close record');
    assert.equal(window.sealClose.code, CLOSE.NOT_SEALING);
  });

  it('a stopping server ends an enrolling window', async () => {
    const b = await bridge();
    const window = openWindow(b.server, newWindow());
    await enrollingFrame(window);
    await b.server.stop();
    assert.equal(b.server.enrolling.size, 0);
  });
});

describe('a revoke reaches a live session', () => {
  it('personal: closes it at once, under the seal', async () => {
    const b = await bridge({ limits: { deviceRecheckMs: 100000 } });
    const device = newWindow();
    const window = openWindow(b.server, device);
    await enrollingFrame(window);
    await window.call(1, 'window.enroll', { label: 'Road laptop' });
    b.enrollment.onResponse(b.phone.windowRespond(b.link.sent[0].envelope, 'approve'));
    await waitFor(() => window.received.find((f) => f.t === 'ready'), 'ready');
    const conn = b.server.connections.get(device.deviceId);
    b.enrollment.onRevoke(b.phone.windowRevoke(b.identity.nodeId, b.identity.box.jwk, device.deviceId));
    await waitFor(() => window.sealClose, 'the close record');
    assert.deepEqual(window.sealClose, { code: CLOSE.UNKNOWN_DEVICE, reason: 'peer' });
    assert.equal(conn.revoked, true);
  });

  it('fleet: the staged overlay closes it, the record still in the file', async () => {
    const device = { ...newWindow(), remote: true };
    const b = await bridge({ hosting: 'service', devices: [device], limits: { deviceRecheckMs: 100000 } });
    const window = openWindow(b.server, device);
    const { value: conn } = await window.outcome;
    const out = b.enrollment.onRevoke(b.phone.windowRevoke(b.identity.nodeId, b.identity.box.jwk, device.deviceId));
    assert.deepEqual(out, { state: 'revoked-pending-apply' });
    await waitFor(() => window.sealClose, 'the close record');
    assert.deepEqual(window.sealClose, { code: CLOSE.UNKNOWN_DEVICE, reason: 'peer' });
    assert.equal(conn.revoked, true);
    assert.equal(devicesIn(b.configDir).length, 1);
    assert.equal(b.enrollment.isEnrolled(device.deviceId), false);

    // And it may not come back while the revoke waits.
    const back = openWindow(b.server, device);
    await waitFor(() => back.sealClose, 'refused again');
    assert.equal(back.sealClose.code, CLOSE.UNKNOWN_DEVICE);
  });

  it('fleet: the overlay survives a restart of the service', async () => {
    const device = { ...newWindow(), remote: true };
    const b = await bridge({ hosting: 'service', devices: [device] });
    b.enrollment.onRevoke(b.phone.windowRevoke(b.identity.nodeId, b.identity.box.jwk, device.deviceId));
    await b.store.ready();
    assert.equal(b.enrollment.isEnrolled(device.deviceId), false);
  });
});

describe('a fleet node stages, and device apply writes (R-RW-15)', () => {
  // A real data dir and config dir, as `device apply` reads them.
  async function fleet() {
    const base = tempDir('kl-window-fleet-');
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
    fs.mkdirSync(dataDir, { recursive: true });
    if (POSIX) for (const d of [base, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: web-01\n', { mode: 0o644 });
    const ports = buildServicePorts({ dataDir });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'web-01', { fillBox: true });
    const phone = createFakePhone({ boxKey: true });
    fs.writeFileSync(path.join(configDir, 'approvers', `${phone.deviceId}.json`), JSON.stringify(phone.approverRecord({ boxKey: true })), { mode: 0o644 });
    const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
    const { ApproverStore } = require('../src/approvals/approver-store');
    const store = new ApproverStore({ dir: path.join(configDir, 'approvers'), stagedDir: path.join(dataDir, 'approvals', 'staged'), ...storeOptions });
    await store.ready();
    const sealPolicy = createSealPolicy({ approverStore: store, identity, dataDir });
    const link = fakeLink();
    const audit = fakeAudit();
    const enrollment = createWindowEnrollment({
      identity, configDir, dataDir, hosting: 'service', sealPolicy, ...selfOwner,
      approvals: { approverStore: store, auditLedger: audit, relayClient: link }
    });
    cleanups.push(() => enrollment.close());
    const apply = async (input = null) => {
      const text = { out: '', err: '' };
      const io = {
        stdin: new PassThrough(),
        stdout: { write: (s) => { text.out += String(s); return true; } },
        stderr: { write: (s) => { text.err += String(s); return true; } }
      };
      if (input) io.stdin.end(input);
      const code = await runDevice({ sub: 'apply', flags: input ? {} : { yes: true }, dataDir, configDir, io, deps: { storeOptions } });
      return { code, ...text };
    };
    const ledgerKinds = () => {
      const dir = path.join(dataDir, 'audit');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l).kind);
    };
    return { dataDir, configDir, identity, phone, store, link, audit, enrollment, apply, ledgerKinds, stagedDir: path.join(dataDir, 'approvals', 'staged') };
  }

  it('an approve is staged, counts for nothing until applied, and device apply writes it with remote: true', async () => {
    const f = await fleet();
    const w = newWindow('Road laptop');
    const { request_id: id } = await asks(f.enrollment, w);
    const out = f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    assert.deepEqual(out, { state: 'approved', pending_apply: true });
    assert.deepEqual(f.enrollment.status(id, w.deviceId), { state: 'staged' });
    assert.deepEqual(devicesIn(f.configDir), []);
    assert.equal(f.enrollment.isEnrolled(w.deviceId), false);
    assert.equal(fs.readdirSync(f.stagedDir).filter((n) => n.endsWith('.json')).length, 1);

    const run = await f.apply();
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, new RegExp(`window Road laptop \\(${w.deviceId}\\) enrolled`));
    const [record] = devicesIn(f.configDir);
    assert.equal(record.remote, true);
    assert.equal(record.publicKey, w.publicKey);
    assert.equal(f.enrollment.isEnrolled(w.deviceId), true);
    assert.ok(f.ledgerKinds().includes('window.enrolled'));
    assert.deepEqual(fs.readdirSync(f.stagedDir).filter((n) => n.endsWith('.json')), []);
  });

  it('the prompt names the window and its fingerprint, and a no writes nothing', async () => {
    const f = await fleet();
    const w = newWindow('Road laptop');
    await asks(f.enrollment, w);
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    const run = await f.apply('n\n');
    assert.match(run.out, /window Road laptop/);
    assert.ok(run.out.includes(w.deviceId));
    assert.ok(run.out.includes(f.phone.deviceId));
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('a deny stages nothing', async () => {
    const f = await fleet();
    await asks(f.enrollment);
    assert.deepEqual(f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'deny')), { state: 'denied' });
    assert.equal(fs.existsSync(f.stagedDir) ? fs.readdirSync(f.stagedDir).filter((n) => n.endsWith('.json')).length : 0, 0);
  });

  // The staged file is the service account's to write.
  const stagedFile = (f) => path.join(f.stagedDir, fs.readdirSync(f.stagedDir).find((n) => n.endsWith('.json')));
  async function refusedAfter(tamper, match) {
    const f = await fleet();
    const w = newWindow('Road laptop');
    await asks(f.enrollment, w);
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    const file = stagedFile(f);
    const staged = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(tamper(staged, f, w)));
    const run = await f.apply();
    assert.match(run.out, match);
    assert.deepEqual(devicesIn(f.configDir), []);
  }

  it('a planted request not signed by this node is refused', async () => {
    const other = newNode();
    await refusedAfter((staged, f) => {
      const { message } = open(staged.request);
      return { ...staged, request: seal(message, { alg: 'Ed25519', kid: f.identity.nodeId, sign: (b) => other.sign(b) }) };
    }, /rejected: request not signed by this node/);
  });

  it('a missing request is refused', async () => {
    await refusedAfter((staged) => ({ received_at: staged.received_at, envelope: staged.envelope }), /rejected: no request/);
  });

  it('a planted response signed by nobody active is refused', async () => {
    await refusedAfter((staged) => {
      const stranger = createFakePhone();
      return { ...staged, envelope: stranger.sign(open(staged.envelope).message) };
    }, /rejected/);
  });

  it('a revoke in the same batch wins, and removes the window from the file on apply', async () => {
    const f = await fleet();
    const w = newWindow('Road laptop');
    await asks(f.enrollment, w);
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    // Stage the revoke as the store would, with no pending request to clear.
    assert.deepEqual(f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, w.deviceId)), { state: 'revoked-pending-apply' });
    const run = await f.apply();
    assert.match(run.out, /window revoked/);
    assert.match(run.out, /rejected: window was revoked/);
    assert.deepEqual(devicesIn(f.configDir), []);
  });

  it('a revoke of an enrolled window is applied by device apply, and audited', async () => {
    const f = await fleet();
    const w = newWindow('Road laptop');
    await asks(f.enrollment, w);
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    await f.apply();
    assert.equal(devicesIn(f.configDir).length, 1);
    f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, w.deviceId));
    assert.equal(f.enrollment.isEnrolled(w.deviceId), false);
    const run = await f.apply();
    assert.match(run.out, /window revoked/);
    assert.deepEqual(devicesIn(f.configDir), []);
    assert.ok(f.ledgerKinds().includes('window.revoked'));
  });

  it('enrolling again after an applied revoke stands, the old overlay entry not covering the new record', async () => {
    const f = await fleet();
    const w = newWindow('Road laptop');
    await asks(f.enrollment, w);
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    await f.apply();
    f.enrollment.onRevoke(f.phone.windowRevoke(f.identity.nodeId, f.identity.box.jwk, w.deviceId));
    await f.apply();
    await asks(f.enrollment, w);
    const next = f.link.sent[f.link.sent.length - 1].envelope;
    f.enrollment.onResponse(f.phone.windowRespond(next, 'approve'));
    await f.apply();
    // Inside the skew the revoke still covers it: that fails closed.
    assert.equal(f.enrollment.isEnrolled(w.deviceId), false);
    const file = path.join(f.configDir, pairing.DEVICES_FILE);
    const doc = pairing.parseDevices(fs.readFileSync(file, 'utf8'));
    doc.devices[0].pairedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.equal(f.enrollment.isEnrolled(w.deviceId), true);
  });

  it('a staged approve applied promotes the enrolling window; before that it stays enrolling', async () => {
    const f = await fleet();
    const server = new DesktopBridgeServer({
      identity: f.identity, configDir: f.configDir, port: 0, adminUid: UID, geteuid: () => UID, account: 'x', limits: { deviceRecheckMs: 20 },
      approvals: { sealPolicy: { canSeal: () => true } },
      createDispatcher: () => ({ served: { handle: [], on: [] }, providersConfigured: () => true, async handleFrame() {}, async onDisconnect() {}, onRevoke() {}, forwardAmbient() {} })
    });
    cleanups.push(() => server.stop());
    server.setWindowEnrollment(f.enrollment);
    const device = newWindow();
    const window = openWindow(server, device);
    await enrollingFrame(window);
    const asked = await window.call(1, 'window.enroll', { label: 'Road laptop' });
    f.enrollment.onResponse(f.phone.windowRespond(f.link.sent[0].envelope, 'approve'));
    const status = await window.call(2, 'window.enrollStatus', { request_id: asked.value.request_id });
    assert.deepEqual(status.value, { state: 'staged' });
    await delay(60);
    assert.equal(window.received.some((r) => r.t === 'ready'), false);
    assert.equal(server.connections.size, 0);
    await f.apply();
    await waitFor(() => window.received.find((r) => r.t === 'ready'), 'ready after the apply');
    assert.equal(server.connections.size, 1);
  });
});
