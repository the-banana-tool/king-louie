// tests/approvals-box-key.test.js
// The box key on the node (sealed phones, R-SP-10): `device.box_key` in an
// enrollment, approver records, the kl.device.box_key statement, staging and
// `device apply`. Nothing a relay sends may ever remove a box key.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../src/approvals/messages');
const { ApproverStore, checkApproverRecord, judgeBoxKey, judgeReadKey } = require('../src/approvals/approver-store');
const { ApproverAdmin } = require('../src/approvals/approver-admin');
const { seal, deviceIdFromJwk } = require('../src/approvals/envelope');
const { verifyConsoleEnrollment, verifyDeviceEnvelope } = require('../src/approvals/verify-device');
const { boxKeyFingerprint } = require('../src/approvals/seal');
const { isReservedMethod, NODE_INBOUND } = require('../src/approvals/relay-client');
const { TEST_DEVICE_KEYS } = require('../src/approvals/test-keys');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const POSIX = process.platform !== 'win32';
const OWN_UID = POSIX ? process.getuid() : 0;
const NOW = Date.parse('2026-09-23T18:00:00.000Z');
const { iso, randomNonce } = m;

function layout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-box-key-'));
  tmp.push(base);
  const config = path.join(base, 'config');
  const dir = path.join(config, 'approvers');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (POSIX) {
    fs.chmodSync(base, 0o755);
    fs.chmodSync(config, 0o755);
  }
  return { dir, stagedDir: path.join(base, 'data', 'approvals', 'staged') };
}

function write(dir, record) {
  fs.writeFileSync(path.join(dir, `${record.device_id}.json`), JSON.stringify(record), { mode: 0o644 });
}

function store(l, extra = {}) {
  return new ApproverStore({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

function admin(l, extra = {}) {
  return new ApproverAdmin({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

const applyAll = async (l, extra) => (await admin(l, extra).applyStaged({ confirm: async () => true })).map((r) => r.result);

function boxJwk() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { kty, crv, x, y };
}

const testJwk = (name) => {
  const k = TEST_DEVICE_KEYS.find((t) => t.name === name);
  return { kty: 'EC', crv: 'P-256', x: k.x, y: k.y };
};

function statementMessage(phone, box, { now = NOW, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  return { v: 1, type: 'kl.device.box_key', device_id: phone.deviceId, box_key: box, created_at: iso(now), expires_at: iso(now + ttlMs), nonce: randomNonce() };
}

function statement(phone, box, { signer = phone.signer, ...rest } = {}) {
  return seal(statementMessage(phone, box, rest), signer);
}

// Into staged/ by hand, as the service account could: nothing checked this.
function plant(l, envelope, nonce) {
  fs.mkdirSync(l.stagedDir, { recursive: true });
  fs.writeFileSync(path.join(l.stagedDir, `${nonce}.json`), JSON.stringify({ received_at: iso(NOW), envelope }));
}

async function fleet(records = null) {
  const l = layout();
  const a = createFakePhone({ name: 'Owner phone' });
  const b = createFakePhone({ name: 'Second phone' });
  for (const r of records ? records(a, b) : [a.approverRecord(), b.approverRecord()]) write(l.dir, r);
  const s = store(l);
  await s.ready();
  return { l, a, b, s };
}

describe('device.box_key', () => {
  it('a device with box_key enrolls and the record holds box_key and box_key_at', async () => {
    const { s, a, l } = await fleet();
    const c = createFakePhone({ name: 'New phone' });
    const box = boxJwk();
    const env = a.enroll({ device: { ...c.device(), box_key: box }, now: NOW });
    assert.deepEqual(s.stage(env), { state: 'staged' });
    assert.deepEqual(await applyAll(l), ['enrolled']);
    const record = admin(l).read(c.deviceId);
    assert.deepEqual(record.box_key, box);
    assert.equal(record.box_key_at, iso(NOW));
    assert.equal(checkApproverRecord(record), null);
    assert.equal(record.read_key, undefined, 'a phone with no read key enrolls with a box key alone');

    // Beside a read key, and in a console enrollment too.
    assert.equal(m.validateMessage('kl.device.enroll', { v: 1, type: 'kl.device.enroll', device: { ...c.device({ readKey: true }), box_key: box }, enrolled_by: a.deviceId, created_at: iso(NOW), expires_at: iso(NOW + 60000), nonce: randomNonce() }), null);
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    const claim = c.enroll({ device: { ...c.device(), box_key: box }, codeId, code, now: NOW });
    const checked = verifyConsoleEnrollment(claim, { codeId, code, now: NOW });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.message.device.box_key, box);
  });

  it('a box_key equal to public_key or read_key is malformed', async () => {
    const c = createFakePhone();
    const enroll = (device) => ({ v: 1, type: 'kl.device.enroll', device, enrolled_by: createFakePhone().deviceId, created_at: iso(NOW), expires_at: iso(NOW + 60000), nonce: randomNonce() });
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), box_key: { ...c.jwk } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device({ readKey: true }), box_key: { ...c.readJwk } })), 'malformed');
    // Not a P-256 JWK, or null, or one more key beside it.
    const box = boxJwk();
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), box_key: null })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), box_key: { ...box, d: 'x' } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), box_key: { ...box, crv: 'P-384' } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), box_key: box, other: 1 })), 'malformed');
    // The device id still derives from public_key alone.
    assert.equal(m.validateMessage('kl.device.enroll', enroll({ ...c.device(), device_id: deviceIdFromJwk(box), box_key: box })), 'malformed');

    // The record says the same.
    const record = c.approverRecord();
    assert.equal(checkApproverRecord({ ...record, box_key: box }), null);
    assert.equal(checkApproverRecord({ ...record, box_key: box, box_key_at: iso(NOW) }), null);
    assert.match(checkApproverRecord({ ...record, box_key: { ...c.jwk } }), /box_key/);
    assert.match(checkApproverRecord({ ...record, read_key: c.readJwk, box_key: { ...c.readJwk } }), /box_key/);
    assert.match(checkApproverRecord({ ...record, box_key: null }), /box_key/);
    assert.match(checkApproverRecord({ ...record, box_key: { ...box, d: 'x' } }), /box_key/);
    assert.match(checkApproverRecord({ ...record, box_key_at: iso(NOW) }), /box_key_at/);
    assert.match(checkApproverRecord({ ...record, box_key: box, box_key_at: 'yesterday' }), /box_key_at/);

    // And so does a statement: refused at staging, and at apply when planted.
    const { s, a, l } = await fleet((x, y) => [{ ...x.approverRecord(), read_key: x.readJwk }, y.approverRecord()]);
    assert.deepEqual(s.stage(statement(a, { ...a.jwk })), { state: 'rejected', reason: 'malformed' });
    assert.deepEqual(s.stage(statement(a, { ...a.readJwk })), { state: 'rejected', reason: 'malformed' });
    const planted = statementMessage(a, { ...a.readJwk });
    plant(l, seal(planted, a.signer), planted.nonce);
    assert.deepEqual(await applyAll(l), ['rejected: malformed']);
    assert.equal(admin(l).read(a.deviceId).box_key, undefined);
  });

  it('a kl.device.box_key signed by the device key stages box-key-pending-apply; by the read key bad_signature', async () => {
    const { s, a, b, l } = await fleet((x, y) => [{ ...x.approverRecord(), read_key: x.readJwk }, y.approverRecord()]);
    const box = boxJwk();
    const env = statement(a, box);
    assert.deepEqual(s.stage(env), { state: 'box-key-pending-apply' });
    assert.deepEqual(s.stage(env), { state: 'duplicate' });
    assert.equal(fs.readdirSync(l.stagedDir).length, 1);
    assert.equal(s.get(a.deviceId).box_key, undefined, 'staged is not applied');

    assert.deepEqual(s.stage(statement(a, boxJwk(), { signer: a.readSigner })), { state: 'rejected', reason: 'bad_signature' });
    // By another device, by the kid or by the bytes.
    assert.deepEqual(s.stage(statement(a, boxJwk(), { signer: b.signer })), { state: 'rejected', reason: 'malformed' });
    assert.deepEqual(s.stage(statement(a, boxJwk(), { signer: { ...b.signer, kid: a.deviceId } })), { state: 'rejected', reason: 'bad_signature' });
    // A device that is no approver, one revoked on the overlay.
    assert.deepEqual(s.stage(statement(createFakePhone(), boxJwk())), { state: 'rejected', reason: 'signer_not_active' });
    assert.equal(s.stage(a.revoke(b.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    assert.deepEqual(s.stage(statement(b, boxJwk())), { state: 'rejected', reason: 'signer_not_active' });
    // The clock and the window.
    assert.deepEqual(s.stage(statement(a, boxJwk(), { now: NOW + 6 * 60 * 1000 })), { state: 'rejected', reason: 'from_the_future' });
    assert.deepEqual(s.stage(statement(a, boxJwk(), { now: NOW - 2 * 60 * 60 * 1000, ttlMs: 60 * 60 * 1000 })), { state: 'rejected', reason: 'expired' });
    assert.deepEqual(s.stage(statement(a, boxJwk(), { ttlMs: 8 * 24 * 60 * 60 * 1000 })), { state: 'rejected', reason: 'malformed' });
    assert.equal(m.BOX_KEY_MAX_MS, 7 * 24 * 60 * 60 * 1000);

    // A box key signs nothing a node accepts, whatever the caller allows.
    const node = testNodeIdentity();
    const { message: request } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
    const boxPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = boxPair.publicKey.export({ format: 'jwk' });
    const response = seal({
      v: 1, type: 'kl.approval.response', request_id: request.request_id, node_id: node.nodeId, action_hash: request.action_hash,
      nonce: request.nonce, decision: 'approve', expires_at: request.expires_at, device_id: a.deviceId, signed_at: request.created_at
    }, { alg: 'ES256', kid: a.deviceId, sign: (bytes) => crypto.sign('sha256', bytes, { key: boxPair.privateKey, dsaEncoding: 'ieee-p1363' }) });
    const held = { get: () => ({ ...a.approverRecord(), box_key: { kty, crv, x, y } }), isActive: () => true, allowTestKeys: false };
    assert.deepEqual(verifyDeviceEnvelope(response, { approverStore: held, type: 'kl.approval.response', nodeId: node.nodeId, allowReadKey: true }), { ok: false, reason: 'bad_signature' });
  });

  it('a statement not newer than box_key_at is stale; one already held is applied', async () => {
    const current = boxJwk();
    const { s, a, l } = await fleet((x, y) => [{ ...x.approverRecord(), box_key: current, box_key_at: iso(NOW - 60 * 1000) }, y.approverRecord()]);
    assert.deepEqual(s.stage(statement(a, boxJwk(), { now: NOW - 2 * 60 * 1000 })), { state: 'rejected', reason: 'stale' });
    assert.deepEqual(s.stage(statement(a, boxJwk(), { now: NOW - 60 * 1000 })), { state: 'rejected', reason: 'stale' }, 'equal is not newer');
    assert.deepEqual(s.stage(statement(a, current)), { state: 'applied' });
    assert.equal(fs.existsSync(l.stagedDir), false, 'neither was staged');

    // The judge itself, in its order: same point, test key, applied, stale.
    const record = { ...a.approverRecord(), box_key: current, box_key_at: iso(NOW - 60 * 1000) };
    assert.equal(judgeBoxKey(record, statementMessage(a, { ...a.jwk })), 'same_point');
    assert.equal(judgeBoxKey(record, statementMessage(a, testJwk('A_box'))), 'test_key');
    assert.equal(judgeBoxKey(record, statementMessage(a, testJwk('A_box')), { allowTestKeys: true }), null);
    assert.equal(judgeBoxKey(record, statementMessage(a, current, { now: NOW - 10 * 60 * 1000 })), 'applied');
    assert.equal(judgeBoxKey(record, statementMessage(a, boxJwk(), { now: NOW - 10 * 60 * 1000 })), 'stale');
    assert.equal(judgeBoxKey(record, statementMessage(a, boxJwk())), null);

    // A record with no box_key_at dates from enrolled_at (2026-09-23T18:00:00.000Z, NOW).
    const undated = await fleet((x, y) => [{ ...x.approverRecord(), box_key: boxJwk() }, y.approverRecord()]);
    assert.deepEqual(undated.s.stage(statement(undated.a, boxJwk(), { now: NOW - 1000 })), { state: 'rejected', reason: 'stale' });
    // A record with no box key takes any date.
    const none = await fleet();
    assert.equal(none.s.stage(statement(none.a, boxJwk(), { now: NOW - 60 * 60 * 1000 })).state, 'box-key-pending-apply');
  });

  it('a re-post of a statement device apply has written answers applied; one still staged stays duplicate', async () => {
    const { s, a, l } = await fleet();
    const box = boxJwk();
    const env = statement(a, box);
    assert.deepEqual(s.stage(env), { state: 'box-key-pending-apply' });
    assert.deepEqual(s.stage(env), { state: 'duplicate' }, 'staged, not yet applied');
    assert.deepEqual(await applyAll(l), ['box key set']);
    const fresh = store(l);
    await fresh.ready();
    assert.deepEqual(fresh.stage(env), { state: 'applied' }, 'the same envelope after apply');
    assert.deepEqual(fresh.stage(statement(a, box)), { state: 'applied' }, 'a new statement of the same key');
    assert.equal(fresh.isActive(a.deviceId), true);
  });

  it('device apply writes box_key after yes, nothing after no, and keeps the rest of the record', async () => {
    const { s, a, l } = await fleet((x, y) => [{ ...x.approverRecord(), read_key: x.readJwk, read_key_at: iso(NOW - 1000) }, y.approverRecord()]);
    const box = boxJwk();
    s.stage(statement(a, box));
    const ad = admin(l);
    let shown;
    assert.deepEqual(await ad.applyStaged({ confirm: async (items) => { shown = items; return false; } }), []);
    assert.equal(shown[0].type, 'kl.device.box_key');
    assert.equal(shown[0].deviceId, a.deviceId);
    assert.equal(shown[0].signer, a.deviceId);
    assert.equal(ad.read(a.deviceId).box_key, undefined);

    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => [r.type, r.deviceId, r.result]), [['kl.device.box_key', a.deviceId, 'box key set']]);
    const record = ad.read(a.deviceId);
    assert.deepEqual(record.box_key, box);
    assert.equal(record.box_key_at, iso(NOW));
    assert.deepEqual(record.read_key, a.readJwk);
    assert.equal(record.read_key_at, iso(NOW - 1000));
    assert.equal(fs.readdirSync(path.join(l.stagedDir, 'done')).length, 1);
  });

  it('apply: box keys go after read keys, the newest of two wins, and a revoked device gets none', async () => {
    const { s, a, b, l } = await fleet();
    const older = boxJwk();
    const newer = boxJwk();
    const read = boxJwk();
    s.stage(statement(a, older, { now: NOW - 60 * 1000 }));
    s.stage(statement(a, newer, { now: NOW }));
    s.stage(a.readKeyStatement({ now: NOW, readKey: read }));
    s.stage(statement(b, boxJwk()));
    s.stage(a.revoke(b.deviceId, { now: NOW }));
    const results = await admin(l).applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.type), ['kl.device.revoke', 'kl.device.read_key', 'kl.device.box_key', 'kl.device.box_key', 'kl.device.box_key']);
    const boxResults = results.filter((r) => r.type === 'kl.device.box_key').map((r) => [r.deviceId, r.result]);
    assert.deepEqual(boxResults.sort(), [
      [a.deviceId, 'box key set'],
      [a.deviceId, 'rejected: stale'],
      [b.deviceId, 'rejected: device was revoked']
    ].sort());
    assert.deepEqual(admin(l).read(a.deviceId).box_key, newer);
    assert.deepEqual(admin(l).read(a.deviceId).read_key, read);
    assert.equal(admin(l).read(b.deviceId).box_key, undefined);
  });

  it('apply re-checks the signer against the admin set', async () => {
    const { s, a, l } = await fleet();
    s.stage(statement(a, boxJwk()));
    admin(l).markRevoked(a.deviceId, 'console');
    assert.deepEqual(await applyAll(l), ['rejected: signer is not an active approver']);
    assert.equal(admin(l).read(a.deviceId).box_key, undefined);
  });

  it('a read key equal to the box key the record holds is refused, and the batch goes on', async () => {
    const box = boxJwk();
    const other = boxJwk();
    const { s, a, b, l } = await fleet((x, y) => [{ ...x.approverRecord(), box_key: box, box_key_at: iso(NOW - 1000) }, y.approverRecord()]);
    assert.equal(judgeReadKey(admin(l).read(a.deviceId), { read_key: box, created_at: iso(NOW) }), 'same_point');
    assert.deepEqual(s.stage(a.readKeyStatement({ now: NOW, readKey: box })), { state: 'rejected', reason: 'malformed' });
    // Planted, so it reaches apply: writing it would make an invalid record.
    const planted = { v: 1, type: 'kl.device.read_key', device_id: a.deviceId, read_key: box, created_at: iso(NOW), expires_at: iso(NOW + 60000), nonce: randomNonce() };
    plant(l, seal(planted, a.signer), planted.nonce);
    assert.equal(s.stage(statement(b, other)).state, 'box-key-pending-apply');
    assert.deepEqual((await applyAll(l)).sort(), ['box key set', 'rejected: malformed']);
    assert.equal(admin(l).read(a.deviceId).read_key, undefined);
    assert.deepEqual(admin(l).read(b.deviceId).box_key, other);
    // The other way round: a box key equal to a read key set in the same batch.
    const same = await fleet();
    const shared = boxJwk();
    same.s.stage(same.a.readKeyStatement({ now: NOW, readKey: shared }));
    same.s.stage(statement(same.a, shared));
    assert.deepEqual(await applyAll(same.l), ['read key set', 'rejected: malformed']);
    assert.equal(admin(same.l).read(same.a.deviceId).box_key, undefined);
  });

  it('the relay cannot force a downgrade: no staged type and no apply result ever removes box_key, and a statement with box_key null is malformed', async () => {
    const current = boxJwk();
    const setAt = iso(NOW - 60 * 1000);
    const { s, a, b, l } = await fleet((x, y) => [{ ...x.approverRecord(), box_key: current, box_key_at: setAt }, y.approverRecord()]);
    const holds = () => {
      const record = admin(l).read(a.deviceId);
      assert.deepEqual(record.box_key, current);
      assert.equal(record.box_key_at, setAt);
    };

    // Shapes that name no key, signed by the device key itself: refused at
    // staging and, planted into staged/, at apply.
    const noKey = (box) => {
      const message = statementMessage(a, box);
      if (box === undefined) delete message.box_key;
      return message;
    };
    for (const box of [null, undefined, {}, '', 'none', false, 0]) {
      assert.deepEqual(s.stage(seal(noKey(box), a.signer)), { state: 'rejected', reason: 'malformed' }, String(box));
    }
    for (const box of [null, undefined, {}]) {
      const message = noKey(box);
      plant(l, seal(message, a.signer), message.nonce);
    }
    assert.deepEqual(await applyAll(l), ['rejected: malformed', 'rejected: malformed', 'rejected: malformed']);
    holds();

    // A relay cannot sign as the device; an old real statement is only stale.
    assert.deepEqual(s.stage(statement(a, boxJwk(), { signer: { ...b.signer, kid: a.deviceId } })), { state: 'rejected', reason: 'bad_signature' });
    const old = statementMessage(a, boxJwk(), { now: NOW - 60 * 60 * 1000 });
    assert.deepEqual(s.stage(seal(old, a.signer)), { state: 'rejected', reason: 'stale' });
    plant(l, seal(old, a.signer), old.nonce);
    assert.deepEqual(await applyAll(l), ['rejected: stale']);
    holds();

    // An enrollment of the same device with no box key: another phone's signed
    // one answers duplicate; planted, it is refused at apply.
    const reEnroll = { v: 1, type: 'kl.device.enroll', device: a.device(), enrolled_by: b.deviceId, created_at: iso(NOW), expires_at: iso(NOW + 60000), nonce: randomNonce() };
    assert.deepEqual(s.stage(seal(reEnroll, b.signer)), { state: 'duplicate' });
    plant(l, seal(reEnroll, b.signer), reEnroll.nonce);
    assert.deepEqual(await applyAll(l), ['rejected: already enrolled']);
    holds();

    // A read key statement writes the read key and leaves the box key.
    assert.equal(s.stage(a.readKeyStatement({ now: NOW })).state, 'read-key-pending-apply');
    assert.deepEqual(await applyAll(l), ['read key set']);
    holds();

    // A revoke keeps what the record held; a revoked device is still a record.
    assert.equal(s.stage(b.revoke(a.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    assert.deepEqual(await applyAll(l), ['revoked']);
    holds();
    assert.notEqual(admin(l).read(a.deviceId).revoked_at, null);
  });

  it('a published box test key is refused test_key unless allowTestKeys', async () => {
    const { s, a, l } = await fleet();
    const testBox = testJwk('A_box');
    assert.deepEqual(s.stage(statement(a, testBox)), { state: 'rejected', reason: 'test_key' });
    const permissive = store(l, { allowTestKeys: true });
    await permissive.ready();
    assert.deepEqual(permissive.stage(statement(a, testBox)), { state: 'box-key-pending-apply' });
    assert.deepEqual(await applyAll(l), ['rejected: test key']);
    assert.equal(admin(l).read(a.deviceId).box_key, undefined);
    permissive.stage(statement(a, testBox));
    assert.deepEqual(await applyAll(l, { allowTestKeys: true }), ['box key set']);

    // In an enrollment, staged and by console.
    const c = createFakePhone();
    const other = await fleet();
    assert.deepEqual(other.s.stage(other.a.enroll({ device: { ...c.device(), box_key: testJwk('B_box') }, now: NOW })), { state: 'rejected', reason: 'test_key' });
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    const claim = c.enroll({ device: { ...c.device(), box_key: testBox }, codeId, code, now: NOW });
    assert.deepEqual(verifyConsoleEnrollment(claim, { codeId, code, now: NOW }), { ok: false, reason: 'test_key' });
    assert.equal(verifyConsoleEnrollment(claim, { codeId, code, now: NOW, allowTestKeys: true }).ok, true);

    // A record that holds one is not active, as for a read key.
    const held = layout();
    const phone = createFakePhone();
    write(held.dir, { ...phone.approverRecord(), box_key: testBox });
    const strict = store(held);
    await strict.ready();
    assert.deepEqual(strict.list(), []);
    assert.equal(strict.isActive(phone.deviceId), false);
    const allowed = store(held, { allowTestKeys: true });
    await allowed.ready();
    assert.equal(allowed.isActive(phone.deviceId), true);
  });

  it('messages re-exports boxKeyFingerprint, the b- fingerprint', () => {
    assert.equal(m.boxKeyFingerprint, boxKeyFingerprint);
    assert.match(m.boxKeyFingerprint(boxJwk()), /^b-[a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4}$/);
  });

  it('device.box_key is a reserved method the relay may call on a node', () => {
    assert.equal(isReservedMethod('device.box_key'), true);
    assert.ok(NODE_INBOUND.includes('device.box_key'));
  });
});
