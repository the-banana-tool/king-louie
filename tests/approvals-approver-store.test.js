// tests/approvals-approver-store.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApproverStore } = require('../src/approvals/approver-store');
const { ApproverAdmin, ApproverAdminError } = require('../src/approvals/approver-admin');
const { seal } = require('../src/approvals/envelope');
const { createFakePhone } = require('./helpers/fake-phone');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const POSIX = process.platform !== 'win32';
const OWN_UID = POSIX ? process.getuid() : 0;
const NOW = Date.parse('2026-09-23T18:00:00.000Z');

function layout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-approvers-'));
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

function write(dir, record, name = `${record.device_id}.json`) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record), { mode: 0o644 });
}

// The test process owns everything it creates, so it plays the administrator.
// platform 'linux' selects the POSIX checks; on a Windows test machine
// assertAdminOwned is a no-op, and the Windows probe has its own test below.
function store(l, extra = {}) {
  return new ApproverStore({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

function admin(l, extra = {}) {
  return new ApproverAdmin({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

describe('ApproverStore reading', () => {
  it('lists well-formed records and ignores misnamed, malformed, underived and test-key files', async () => {
    const l = layout();
    const good = createFakePhone({ name: 'Pixel 9' });
    const other = createFakePhone();
    write(l.dir, good.approverRecord());
    write(l.dir, other.approverRecord(), 'd-aaaaaaaaaaaaaaaa.json');
    fs.writeFileSync(path.join(l.dir, 'd-bbbbbbbbbbbbbbbb.json'), '{not json');
    write(l.dir, { ...createFakePhone().approverRecord(), device_id: createFakePhone().deviceId });
    write(l.dir, { ...createFakePhone().approverRecord(), public_key: { ...other.jwk, d: 'secret' } });
    write(l.dir, createFakePhone({ seed: 'A' }).approverRecord());
    const s = store(l);
    assert.deepEqual(await s.ready(), { ok: true });
    assert.deepEqual(s.list().map((r) => r.device_id), [good.deviceId]);
    assert.equal(s.activeCount(), 1);
    assert.equal(s.get(good.deviceId).public_key.x, good.jwk.x);
    // A test key is still found (so verification can say test_key) but never active.
    const a = createFakePhone({ seed: 'A' });
    assert.equal(s.get(a.deviceId).device_id, a.deviceId);
    assert.equal(s.isActive(a.deviceId), false);
    assert.equal(store(l, { allowTestKeys: true }).isActive(a.deviceId), true);
  });

  it('never counts demo or revoked devices as active', async () => {
    const l = layout();
    const demo = createFakePhone({ platform: 'demo' });
    const revoked = createFakePhone();
    write(l.dir, demo.approverRecord());
    write(l.dir, revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' }));
    const s = store(l);
    await s.ready();
    assert.equal(s.isActive(demo.deviceId), false);
    assert.equal(s.isActive(revoked.deviceId), false);
    assert.equal(s.activeCount(), 0);
  });

  it('re-reads a file that changes (after the one-second cache)', async () => {
    const l = layout();
    const phone = createFakePhone();
    const s = store(l);
    await s.ready();
    assert.equal(s.activeCount(), 0);
    write(l.dir, phone.approverRecord());
    s.refresh();
    assert.equal(s.activeCount(), 1);
  });

  it('POSIX: refuses a group-writable approver dir and a file the service account owns', { skip: !POSIX && 'ownership checks are POSIX-only' }, async () => {
    const l = layout();
    write(l.dir, createFakePhone().approverRecord());
    fs.chmodSync(l.dir, 0o775);
    const s = store(l);
    const result = await s.ready();
    assert.equal(result.ok, false);
    assert.match(result.problem, /group- or world-writable/);
    assert.equal(s.activeCount(), 0);
    fs.chmodSync(l.dir, 0o755);
    const strict = store(l, { adminUid: OWN_UID + 1 });
    assert.equal((await strict.ready()).ok, false);
    assert.equal(strict.activeCount(), 0);
  });

  it('Windows: a dir the service can write empties the set', async () => {
    const l = layout();
    write(l.dir, createFakePhone().approverRecord());
    const writable = store(l, { platform: 'win32', fsImpl: { ...fs, openSync: () => 42, closeSync: () => {}, unlinkSync: () => {} } });
    const result = await writable.ready();
    assert.equal(result.ok, false);
    assert.match(result.problem, /writable by the account running the service/);
    assert.equal(writable.activeCount(), 0);
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const locked = store(l, { platform: 'win32', fsImpl: { ...fs, openSync: () => { throw denied; } } });
    assert.deepEqual(await locked.ready(), { ok: true });
    assert.equal(locked.activeCount(), 1);
  });
});

describe('ApproverStore.stage', () => {
  async function fleet() {
    const l = layout();
    const a = createFakePhone({ name: 'Owner phone' });
    const b = createFakePhone({ name: 'Second phone' });
    write(l.dir, a.approverRecord());
    write(l.dir, b.approverRecord());
    const s = store(l);
    await s.ready();
    return { l, a, b, s };
  }

  it('stages a signed enrollment by an active device, once', async () => {
    const { s, a, l } = await fleet();
    const c = createFakePhone();
    const env = a.enroll({ device: c.device(), now: NOW });
    assert.deepEqual(s.stage(env), { state: 'staged' });
    assert.deepEqual(s.stage(env), { state: 'duplicate' });
    assert.equal(fs.readdirSync(l.stagedDir).length, 1);
    assert.equal(s.isActive(c.deviceId), false, 'staged is not trusted until an admin applies it');
  });

  it('rejects an expired, unsigned-by-an-approver or badly signed enrollment', async () => {
    const { s, a } = await fleet();
    const c = createFakePhone();
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW - 11 * 60 * 1000 })), { state: 'rejected', reason: 'expired' });
    assert.deepEqual(s.stage(createFakePhone().enroll({ device: c.device(), now: NOW })), { state: 'rejected', reason: 'signer_not_active' });
    const forged = { ...a.enroll({ device: c.device(), now: NOW }), sig: a.enroll({ device: createFakePhone().device(), now: NOW }).sig };
    assert.deepEqual(s.stage(forged), { state: 'rejected', reason: 'bad_signature' });
  });

  it('validates the nonce before using it as a file name', async () => {
    const { s, a } = await fleet();
    const env = seal({ v: 1, type: 'kl.device.revoke', device_id: createFakePhone().deviceId, revoked_by: a.deviceId, reason: 'x',
      created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-23T19:00:00.000Z', nonce: '../../../evil' }, a.signer);
    assert.deepEqual(s.stage(env), { state: 'rejected', reason: 'malformed' });
  });

  it('a revoke acts at once through the overlay and survives a restart', async () => {
    const { s, a, b, l } = await fleet();
    assert.deepEqual(s.stage(a.revoke(b.deviceId, { now: NOW })), { state: 'revoked-pending-apply' });
    assert.equal(s.isActive(b.deviceId), false);
    assert.equal(s.isAdminApplied(b.deviceId), true);
    const restarted = store(l);
    await restarted.ready();
    assert.equal(restarted.isActive(b.deviceId), false);
  });

  it('refuses a self-revoke, and lets mutual revokes remove both keys', async () => {
    const { s, a, b } = await fleet();
    assert.deepEqual(s.stage(a.revoke(a.deviceId, { now: NOW })), { state: 'rejected', reason: 'self_revoke' });
    assert.equal(s.stage(b.revoke(a.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    // a is in the overlay, but revokers are judged on the admin-applied set.
    assert.equal(s.stage(a.revoke(b.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    assert.equal(s.isActive(a.deviceId), false);
    assert.equal(s.isActive(b.deviceId), false);
  });

  it('an enrollment signed by an overlay-revoked device is refused', async () => {
    const { s, a, b } = await fleet();
    s.stage(b.revoke(a.deviceId, { now: NOW }));
    assert.deepEqual(s.stage(a.enroll({ device: createFakePhone().device(), now: NOW })), { state: 'rejected', reason: 'signer_not_active' });
  });
});

describe('ApproverAdmin', () => {
  it('refuses to write where it cannot', () => {
    const l = layout();
    const file = path.join(l.dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const blocked = new ApproverAdmin({ dir: path.join(file, 'approvers'), stagedDir: l.stagedDir });
    assert.throws(() => blocked.assertWritable(), (err) => err instanceof ApproverAdminError && /Run this as root\/Administrator: .* is not writable\./.test(err.message));
  });

  it('writes and revokes, and never re-activates a revoked device', () => {
    const l = layout();
    const phone = createFakePhone();
    const ad = admin(l);
    ad.writeApprover(phone.approverRecord());
    const revoked = ad.markRevoked(phone.deviceId, 'console');
    assert.equal(revoked.revoked_by, 'console');
    assert.equal(revoked.revoked_at, '2026-09-23T18:00:00.000Z');
    assert.throws(() => ad.writeApprover(phone.approverRecord()), /never re-activated/);
    assert.throws(() => ad.writeApprover({ ...createFakePhone().approverRecord(), device_id: phone.deviceId }), /does not derive/);
  });

  it('applyStaged lists, asks, applies revokes first, and moves everything to done/', async () => {
    const l = layout();
    const a = createFakePhone({ name: 'A' });
    const b = createFakePhone({ name: 'B' });
    const c = createFakePhone({ name: 'C' });
    write(l.dir, a.approverRecord());
    write(l.dir, b.approverRecord());
    const s = store(l);
    await s.ready();
    s.stage(b.enroll({ device: c.device(), now: NOW }));
    s.stage(a.revoke(b.deviceId, { now: NOW }));
    const ad = admin(l);

    let shown = null;
    assert.deepEqual(await ad.applyStaged({ confirm: async (items) => { shown = items; return false; } }), []);
    assert.deepEqual(shown.map((i) => i.type).sort(), ['kl.device.enroll', 'kl.device.revoke']);
    assert.equal(fs.readdirSync(l.stagedDir).filter((n) => n.endsWith('.json')).length, 2, 'declining changes nothing');

    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => [r.type, r.result]), [
      ['kl.device.revoke', 'revoked'],
      ['kl.device.enroll', 'rejected: signer is not an active approver']
    ]);
    assert.equal(ad.read(b.deviceId).revoked_by, a.deviceId);
    assert.equal(ad.read(c.deviceId), null);
    assert.equal(fs.readdirSync(path.join(l.stagedDir, 'done')).length, 2);
    // The nonce is remembered in done/, so a replayed envelope is a duplicate.
    const again = store(l);
    await again.ready();
    assert.equal(again.stage(a.revoke(b.deviceId, { now: NOW, nonce: shown.find((i) => i.type === 'kl.device.revoke').message.nonce })).state, 'duplicate');
  });

  it('applyStaged enrolls a device signed by an active approver and refuses items older than 7 days', async () => {
    const l = layout();
    const a = createFakePhone();
    const c = createFakePhone({ name: 'New phone', platform: 'ios' });
    write(l.dir, a.approverRecord());
    const s = store(l);
    await s.ready();
    s.stage(a.enroll({ device: c.device(), now: NOW }));
    const late = admin(l, { now: () => NOW + 8 * 24 * 60 * 60 * 1000 });
    assert.deepEqual((await late.applyStaged({ confirm: async () => true })).map((r) => r.result), ['rejected: older than 7 days']);

    const l2 = layout();
    write(l2.dir, a.approverRecord());
    const s2 = store(l2);
    await s2.ready();
    s2.stage(a.enroll({ device: c.device(), now: NOW }));
    const results = await admin(l2).applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['enrolled']);
    const record = admin(l2).read(c.deviceId);
    assert.equal(record.enrolled_by, a.deviceId);
    assert.equal(record.platform, 'ios');
    const fresh = store(l2);
    await fresh.ready();
    assert.equal(fresh.isActive(c.deviceId), true);
  });
});
