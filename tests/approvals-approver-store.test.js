// tests/approvals-approver-store.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApproverStore } = require('../src/approvals/approver-store');
const { ApproverAdmin, ApproverAdminError } = require('../src/approvals/approver-admin');
const { seal } = require('../src/approvals/envelope');
const { iso, randomNonce } = require('../src/approvals/messages');
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
// Windows owner reads are injected too (the real reader runs PowerShell):
// by default both dirs are owned by Administrators, which trusts the set.
const ADMIN_OWNED = () => ({ approvers: 'S-1-5-32-544', config: 'S-1-5-32-544' });
function store(l, extra = {}) {
  return new ApproverStore({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, readOwners: ADMIN_OWNED, ...extra });
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
    const allowed = store(l, { allowTestKeys: true });
    await allowed.ready();
    assert.equal(allowed.isActive(a.deviceId), true);
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

// Task 23 review, Ruling A: on Windows the ACL is the only guard, so the
// write probe runs on every scan, not once at startup.
describe('ApproverStore: the Windows probe runs on every scan', () => {
  const denied = () => Object.assign(new Error('denied'), { code: 'EPERM' });
  // The probe's openSync answers from `state`; everything else is real fs.
  function probed(state) {
    return {
      ...fs,
      openSync: (file, ...rest) => {
        if (path.basename(file).startsWith('.probe-')) {
          if (!state.writable) throw denied();
          return 42;
        }
        return fs.openSync(file, ...rest);
      },
      closeSync: (fd) => { if (fd !== 42) fs.closeSync(fd); },
      unlinkSync: (file) => { if (!path.basename(file).startsWith('.probe-')) fs.unlinkSync(file); }
    };
  }

  it('a dir missing at startup that appears writable is never trusted; locked later, it is', async () => {
    const l = layout();
    fs.rmSync(l.dir, { recursive: true });
    const state = { writable: true };
    const s = store(l, { platform: 'win32', fsImpl: probed(state) });
    assert.deepEqual(await s.ready(), { ok: true });
    assert.equal(s.activeCount(), 0, 'a missing dir is no approvers');
    // The service account creates approvers/ and plants a record.
    fs.mkdirSync(l.dir);
    const planted = createFakePhone();
    write(l.dir, planted.approverRecord());
    s.refresh();
    assert.equal(s.isActive(planted.deviceId), false);
    assert.equal(s.activeCount(), 0);
    assert.equal(s.untrusted, true);
    assert.match(s.problem, /writable by the account running the service/);
    // An administrator fixes the ACL: the next scan trusts the dir.
    state.writable = false;
    s.refresh();
    assert.equal(s.isActive(planted.deviceId), true);
    assert.equal(s.untrusted, false);
    assert.equal(s.problem, null);
  });

  it('a trusted dir that becomes writable while running stops counting at once', async () => {
    const l = layout();
    const phone = createFakePhone();
    write(l.dir, phone.approverRecord());
    const state = { writable: false };
    const s = store(l, { platform: 'win32', fsImpl: probed(state) });
    assert.deepEqual(await s.ready(), { ok: true });
    assert.equal(s.isActive(phone.deviceId), true);
    state.writable = true;
    s.refresh();
    assert.equal(s.isActive(phone.deviceId), false);
    assert.equal(s.get(phone.deviceId), null);
    assert.match(s.problem, /writable by the account running the service/);
  });

  it('before ready() the store stays untrusted, whatever the probe would say', () => {
    const l = layout();
    const phone = createFakePhone();
    write(l.dir, phone.approverRecord());
    const s = store(l, { platform: 'win32', fsImpl: probed({ writable: false }) });
    assert.equal(s.isActive(phone.deviceId), false);
    assert.equal(s.untrusted, true);
  });

  it('the admin snapshot (serviceProbe: false) and POSIX never run the probe', async () => {
    const l = layout();
    const phone = createFakePhone();
    write(l.dir, phone.approverRecord());
    let probes = 0;
    const counting = { ...fs, openSync: (file, ...rest) => { if (path.basename(file).startsWith('.probe-')) probes += 1; return fs.openSync(file, ...rest); } };
    const adminView = store(l, { platform: 'win32', serviceProbe: false, fsImpl: counting });
    await adminView.ready();
    adminView.refresh();
    assert.equal(adminView.isActive(phone.deviceId), true);
    const posix = store(l, { fsImpl: counting });
    if (POSIX) {
      await posix.ready();
      posix.refresh();
      assert.equal(posix.isActive(phone.deviceId), true);
    }
    assert.equal(probes, 0);
  });
});

// Task 23 re-review, Ruling A2: the owner of a Windows dir keeps WRITE_DAC,
// so an unwritable approvers dir is still untrusted unless Administrators,
// SYSTEM or the config dir's owner owns it.
describe('ApproverStore: Windows owners', () => {
  const USER = 'S-1-5-21-1000-2000-3000-1001';
  const OTHER = 'S-1-5-21-1000-2000-3000-1002';
  const locked = { ...fs, openSync: (file, ...rest) => {
    if (path.basename(file).startsWith('.probe-')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return fs.openSync(file, ...rest);
  } };
  async function withOwners(owners, extra = {}) {
    const l = layout();
    const phone = createFakePhone();
    write(l.dir, phone.approverRecord());
    const calls = [];
    const readOwners = (args) => {
      calls.push(args);
      if (typeof owners === 'function') return owners(args);
      return owners;
    };
    const s = store(l, { platform: 'win32', fsImpl: locked, readOwners, ...extra });
    const result = await s.ready();
    return { l, s, phone, result, calls };
  }

  it("an unwritable approvers dir owned by someone other than the config dir's owner is untrusted", async () => {
    const { s, phone, result, calls } = await withOwners({ approvers: OTHER, config: USER });
    assert.equal(result.ok, false);
    assert.match(result.problem, /is owned by S-1-5-21-1000-2000-3000-1002, which is neither Administrators, SYSTEM nor the owner of/);
    assert.equal(s.isActive(phone.deviceId), false);
    assert.deepEqual(calls[0], { dir: s.dir, configDir: path.dirname(s.dir) });
  });

  it("trusts approvers owned by the config dir's owner, by Administrators or by SYSTEM", async () => {
    for (const owners of [
      { approvers: USER, config: USER },
      { approvers: 'S-1-5-32-544', config: USER },
      { approvers: 'S-1-5-18', config: 'S-1-5-32-544' }
    ]) {
      const { s, phone, result } = await withOwners(owners);
      assert.deepEqual(result, { ok: true }, JSON.stringify(owners));
      assert.equal(s.isActive(phone.deviceId), true, JSON.stringify(owners));
    }
  });

  it('a config dir owned by LOCAL SERVICE trusts nothing, whoever owns approvers', async () => {
    const { s, phone, result } = await withOwners({ approvers: 'S-1-5-19', config: 'S-1-5-19' });
    assert.match(result.problem, /is owned by the service account \(S-1-5-19\)/);
    assert.equal(s.isActive(phone.deviceId), false);
    const admin = await withOwners({ approvers: 'S-1-5-32-544', config: 'S-1-5-19' });
    assert.equal(admin.result.ok, false);
  });

  it('owners that cannot be read, or are not SIDs, are untrusted', async () => {
    const threw = await withOwners(() => { throw new Error('powershell failed'); });
    assert.match(threw.result.problem, /could not read the owners .*powershell failed/);
    for (const owners of [null, {}, { approvers: 'nobody', config: USER }, { approvers: USER, config: '' }]) {
      const { result } = await withOwners(owners);
      assert.match(result.problem, /could not read the owners/, JSON.stringify(owners));
    }
  });

  it('re-reads owners only when the dir first appears or its ino/ChangeTime moves', async () => {
    const l = layout();
    fs.rmSync(l.dir, { recursive: true });
    let bump = 0n;
    const fsImpl = {
      ...locked,
      lstatSync: (p, opts) => {
        const st = fs.lstatSync(p, opts);
        if (p === l.dir && opts && opts.bigint) st.ctimeNs += bump;
        return st;
      }
    };
    let reads = 0;
    const s = store(l, { platform: 'win32', fsImpl, readOwners: () => { reads += 1; return ADMIN_OWNED(); } });
    assert.deepEqual(await s.ready(), { ok: true });
    assert.equal(reads, 0, 'a missing dir needs no owner');
    fs.mkdirSync(l.dir);
    const phone = createFakePhone();
    write(l.dir, phone.approverRecord());
    s.refresh();
    assert.equal(s.isActive(phone.deviceId), true);
    assert.equal(reads, 1, 'read when the dir appears');
    for (let i = 0; i < 3; i += 1) { s.refresh(); s.list(); }
    assert.equal(reads, 1, 'not on every scan');
    bump = 1n;
    s.refresh();
    s.list();
    assert.equal(reads, 2, 'again once ChangeTime moves');
  });

  it('a junction standing in for approvers is refused', async () => {
    const l = layout();
    const elsewhere = path.join(path.dirname(path.dirname(l.dir)), 'elsewhere');
    fs.mkdirSync(elsewhere);
    write(elsewhere, createFakePhone().approverRecord());
    fs.rmSync(l.dir, { recursive: true });
    fs.symlinkSync(elsewhere, l.dir, process.platform === 'win32' ? 'junction' : 'dir');
    const s = store(l, { platform: 'win32', fsImpl: locked });
    const result = await s.ready();
    assert.match(result.problem, /junction, symlink or not a directory/);
    assert.equal(s.activeCount(), 0);
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

describe('ApproverStore starts untrusted (M1)', () => {
  it('treats itself as empty until ready() runs', async () => {
    const l = layout();
    write(l.dir, createFakePhone().approverRecord());
    const s = store(l);
    assert.equal(s.list().length, 0);
    assert.equal(s.activeCount(), 0);
    await s.ready();
    assert.equal(s.activeCount(), 1);
  });
});

describe('ApproverStore.stage refuses demo and test-key enrollments unless allowed (M7)', () => {
  it('rejects staging an enrollment of a demo device', async () => {
    const { s, a } = await fleet();
    const demo = createFakePhone({ platform: 'demo' });
    assert.deepEqual(s.stage(a.enroll({ device: demo.device(), now: NOW })), { state: 'rejected', reason: 'demo_device' });
  });

  it('rejects staging an enrollment of a published test key unless allowTestKeys', async () => {
    const { s, a, l } = await fleet();
    const testPhone = createFakePhone({ seed: 'A' });
    assert.deepEqual(s.stage(a.enroll({ device: testPhone.device(), now: NOW })), { state: 'rejected', reason: 'test_key' });
    const allowed = store(l, { allowTestKeys: true });
    await allowed.ready();
    assert.deepEqual(allowed.stage(a.enroll({ device: testPhone.device(), now: NOW })), { state: 'staged' });
  });
});

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

describe('ApproverStore.stage additional reasons (M8)', () => {
  it('rejects staging an enrollment of a previously revoked device_id', async () => {
    const { s, a, l } = await fleet();
    const c = createFakePhone();
    const ad = admin(l);
    ad.writeApprover(c.approverRecord());
    ad.markRevoked(c.deviceId, 'console');
    s.refresh();
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'rejected', reason: 'revoked_device' });
  });

  it('refuses to relay a console-style enrollment (enrolled_by: null)', async () => {
    const { s } = await fleet();
    const c = createFakePhone();
    const codeEnv = c.enroll({ codeId: 'A'.repeat(22), code: crypto.randomBytes(32).toString('base64url'), now: NOW });
    assert.deepEqual(s.stage(codeEnv), { state: 'rejected', reason: 'console_enrollment_is_not_relayed' });
  });

  it('rejects staging when this store has no staging dir configured', async () => {
    const l = layout();
    const a = createFakePhone();
    write(l.dir, a.approverRecord());
    const noStage = new ApproverStore({ dir: l.dir, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW });
    await noStage.ready();
    const c = createFakePhone();
    assert.deepEqual(noStage.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'rejected', reason: 'no_staging_dir' });
  });

  it('rejects a message with an unsupported version', async () => {
    const { s, a } = await fleet();
    const c = createFakePhone();
    const bad = seal({
      v: 2,
      type: 'kl.device.enroll',
      device: c.device(),
      enrolled_by: a.deviceId,
      created_at: iso(NOW),
      expires_at: iso(NOW + 10 * 60 * 1000),
      nonce: randomNonce()
    }, a.signer);
    assert.deepEqual(s.stage(bad), { state: 'rejected', reason: 'unsupported_version' });
  });
});

describe('ApproverAdmin.applyStaged additional results (M8)', () => {
  it('rejects a self-revoke reaching applyStaged directly (defense in depth)', async () => {
    const l = layout();
    const a = createFakePhone();
    write(l.dir, a.approverRecord());
    // ApproverStore.stage() already refuses a self-revoke, so this envelope
    // is written directly to bypass it and exercise applyStaged's own check.
    const nonce = randomNonce();
    const env = seal({
      v: 1, type: 'kl.device.revoke', device_id: a.deviceId, revoked_by: a.deviceId, reason: 'x',
      created_at: iso(NOW), expires_at: iso(NOW + 60 * 60 * 1000), nonce
    }, a.signer);
    fs.mkdirSync(l.stagedDir, { recursive: true });
    fs.writeFileSync(path.join(l.stagedDir, `${nonce}.json`), JSON.stringify({ received_at: iso(NOW), envelope: env }));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: a device cannot revoke itself']);
  });

  it('rejects re-enrolling a device that is already an approver (defense in depth)', async () => {
    const { a, b, l } = await fleet();
    // ApproverStore.stage() already turns this into { state: 'duplicate' }
    // without writing a file, so this envelope is written directly to
    // exercise applyStaged's own "already enrolled" check.
    const nonce = randomNonce();
    const env = a.enroll({ device: b.device(), now: NOW, nonce });
    fs.mkdirSync(l.stagedDir, { recursive: true });
    fs.writeFileSync(path.join(l.stagedDir, `${nonce}.json`), JSON.stringify({ received_at: iso(NOW), envelope: env }));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: already enrolled']);
  });

  it('rejects applying an enrollment of a demo or test-key device when the admin does not allow test keys (M7)', async () => {
    const l = layout();
    const a = createFakePhone();
    write(l.dir, a.approverRecord());
    // A permissive store stages what a stricter admin must still refuse.
    const permissive = store(l, { allowTestKeys: true });
    await permissive.ready();
    const testPhone = createFakePhone({ seed: 'B' });
    assert.deepEqual(permissive.stage(a.enroll({ device: testPhone.device(), now: NOW })), { state: 'staged' });
    const ad = admin(l); // allowTestKeys defaults to false
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: test key']);
    assert.equal(ad.read(testPhone.deviceId), null);
  });
});

describe('C1: a revoke always wins', () => {
  it('defers a revoke of a not-yet-enrolled device instead of moving it to done/, and refuses the matching enroll', async () => {
    // Exact repro: A enrolls C (staged); the owner revokes C (staged). At
    // apply, the revoke must not be discarded as "unknown device" — it must
    // keep blocking C, in this batch and after a restart.
    const l = layout();
    const a = createFakePhone({ name: 'Owner' });
    write(l.dir, a.approverRecord());
    const s = store(l);
    await s.ready();
    const c = createFakePhone({ name: 'New phone' });
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'staged' });
    assert.deepEqual(s.stage(a.revoke(c.deviceId, { now: NOW })), { state: 'revoked-pending-apply' });

    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => [r.type, r.result]), [
      ['kl.device.revoke', 'deferred: unknown device'],
      ['kl.device.enroll', 'rejected: device was revoked']
    ]);
    assert.equal(ad.read(c.deviceId), null);

    // The deferred revoke stays in staged/, not moved to done/.
    assert.equal(fs.readdirSync(l.stagedDir).filter((n) => n.endsWith('.json')).length, 1);
    const doneDir = path.join(l.stagedDir, 'done');
    assert.equal(fs.existsSync(doneDir) ? fs.readdirSync(doneDir).length : 0, 1, 'only the enroll moved to done/');

    // After a restart, the overlay (rebuilt from staged/) still blocks C.
    const restarted = store(l);
    await restarted.ready();
    assert.equal(restarted.isActive(c.deviceId), false);
    assert.equal(ad.read(c.deviceId), null, 'C never became an approver');
  });
});

describe('I1: staged-item age is judged on the signed created_at, never received_at', () => {
  it('refuses an enrollment whose signed created_at is over 7 days old even when received_at is forged fresh', async () => {
    const l = layout();
    const a = createFakePhone();
    const c = createFakePhone({ name: 'New phone' });
    write(l.dir, a.approverRecord());
    const past = NOW - 8 * 24 * 60 * 60 * 1000;
    const pastStore = store(l, { now: () => past });
    await pastStore.ready();
    const env = a.enroll({ device: c.device(), now: past });
    assert.deepEqual(pastStore.stage(env), { state: 'staged' });

    // Forge received_at to look freshly received just now.
    const [stagedName] = fs.readdirSync(l.stagedDir).filter((n) => n.endsWith('.json'));
    const stagedFile = path.join(l.stagedDir, stagedName);
    const staged = JSON.parse(fs.readFileSync(stagedFile, 'utf8'));
    fs.writeFileSync(stagedFile, JSON.stringify({ ...staged, received_at: iso(NOW) }));

    const ad = admin(l); // now = NOW
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: older than 7 days']);
  });
});

describe('I2: the admin never follows a symlink in the service-writable staged dir', () => {
  function trySymlink(t, target, linkPath, type) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('creating a symlink needs elevated privileges (or Developer Mode) on this host');
        return false;
      }
      throw err;
    }
  }

  it('refuses a symlinked staged entry without touching it', async (t) => {
    const l = layout();
    fs.mkdirSync(l.stagedDir, { recursive: true });
    const real = path.join(l.stagedDir, 'real-target.json');
    fs.writeFileSync(real, JSON.stringify({ received_at: iso(NOW), envelope: {} }));
    const linkPath = path.join(l.stagedDir, `${'a'.repeat(43)}.json`);
    if (!trySymlink(t, real, linkPath, 'file')) return;
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: not a regular file']);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, 'left untouched, not moved to done/');
  });

  it('refuses a non-regular staged entry (a directory in staged/)', async () => {
    const l = layout();
    fs.mkdirSync(l.stagedDir, { recursive: true });
    fs.mkdirSync(path.join(l.stagedDir, `${'b'.repeat(43)}.json`));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: not a regular file']);
  });

  it('aborts apply with ApproverAdminError when staged/ itself is a symlink', async () => {
    const l = layout();
    fs.mkdirSync(path.dirname(l.stagedDir), { recursive: true });
    // A directory symlink (or, on Windows, a junction — which needs no
    // elevated privilege) so this runs unprivileged on every host.
    fs.symlinkSync(path.dirname(l.stagedDir), l.stagedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const ad = admin(l);
    assert.throws(() => ad.listStaged(), ApproverAdminError);
  });

  it('aborts apply with ApproverAdminError when staged/done is a symlink', async () => {
    const l = layout();
    fs.mkdirSync(l.stagedDir, { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-elsewhere-'));
    tmp.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(l.stagedDir, 'done'), process.platform === 'win32' ? 'junction' : 'dir');
    const ad = admin(l);
    assert.throws(() => ad.listStaged(), ApproverAdminError);
  });

  it('refuses a staged entry named and shaped like an approver record, and leaves it in place', async () => {
    // The re-review's race: the service swaps staged/ or staged/done/ for a
    // junction into <configDir>/approvers/ between listing and the rename.
    // A filename check that runs before any read or move means the swap can
    // only ever expose nonce-shaped names, and an approver record's name
    // (d-….json) never has that shape — so this is refused before the race
    // even has anything to exploit.
    const l = layout();
    fs.mkdirSync(l.stagedDir, { recursive: true });
    const evil = createFakePhone({ name: 'Evil' });
    const planted = path.join(l.stagedDir, `${evil.deviceId}.json`);
    fs.writeFileSync(planted, JSON.stringify(evil.approverRecord()));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: misnamed']);
    assert.equal(fs.existsSync(planted), true, 'left untouched');
    assert.equal(fs.existsSync(path.join(l.stagedDir, 'done')), false, 'nothing was ever moved');
  });

  it('refuses a staged entry whose filename does not match its own signed nonce', async () => {
    const { s, a, l } = await fleet();
    const c = createFakePhone();
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'staged' });
    const [name] = fs.readdirSync(l.stagedDir).filter((n) => n.endsWith('.json'));
    const renamed = `${randomNonce()}.json`;
    fs.renameSync(path.join(l.stagedDir, name), path.join(l.stagedDir, renamed));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: misnamed']);
    assert.equal(fs.existsSync(path.join(l.stagedDir, renamed)), true, 'left untouched');
  });

  it('refuses a staged entry that is hard-linked elsewhere (nlink > 1) without touching it', async () => {
    const l = layout();
    fs.mkdirSync(l.stagedDir, { recursive: true });
    const nonce = randomNonce();
    const file = path.join(l.stagedDir, `${nonce}.json`);
    fs.writeFileSync(file, JSON.stringify({ received_at: iso(NOW), envelope: {} }));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hardlink-'));
    tmp.push(elsewhere);
    fs.linkSync(file, path.join(elsewhere, 'other.json'));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: not a regular file']);
    assert.equal(fs.existsSync(file), true, 'left untouched');
  });
});

describe('M1 round 2 (critical): the admin snapshot must not use the Windows service probe', () => {
  it('does not reject every staged item on win32 just because the admin process can write the approvers dir', async () => {
    const l = layout();
    const a = createFakePhone({ name: 'A' });
    write(l.dir, a.approverRecord());
    // platform 'linux' here only to legitimately produce a staged file; the
    // bug under test is entirely in the admin's own snapshot below.
    const s = store(l);
    await s.ready();
    const c = createFakePhone({ name: 'C' });
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'staged' });

    const ad = admin(l, { platform: 'win32' });
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['enrolled']);
    assert.equal(ad.read(c.deviceId).enrolled_by, a.deviceId);
  });
});

describe('C1 round 2: created_at may not be far in the future', () => {
  it('refuses to stage a message dated more than 5 minutes in the future', async () => {
    const { s, a } = await fleet();
    const c = createFakePhone();
    const future = NOW + 6 * 60 * 1000;
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: future })), { state: 'rejected', reason: 'from_the_future' });
    assert.deepEqual(s.stage(a.revoke(c.deviceId, { now: future })), { state: 'rejected', reason: 'from_the_future' });
  });

  it('applyStaged refuses a staged item dated in the future and moves it to done/ instead of deferring it forever', async () => {
    const l = layout();
    const a = createFakePhone();
    write(l.dir, a.approverRecord());
    const c = createFakePhone();
    // ApproverStore.stage() already refuses this, so it is written directly
    // to exercise applyStaged's own defense-in-depth check.
    const nonce = randomNonce();
    const future = NOW + 3650 * 24 * 60 * 60 * 1000;
    const env = a.revoke(c.deviceId, { now: future, nonce });
    fs.mkdirSync(l.stagedDir, { recursive: true });
    fs.writeFileSync(path.join(l.stagedDir, `${nonce}.json`), JSON.stringify({ received_at: iso(NOW), envelope: env }));
    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['rejected: created in the future']);
    assert.equal(fs.existsSync(path.join(l.stagedDir, 'done', `${nonce}.json`)), true, 'moved to done/, not left deferred forever');
  });

  it('does not honour a deferral whose own signer is revoked in the same batch', async () => {
    const l = layout();
    const a = createFakePhone({ name: 'Owner' });
    const b = createFakePhone({ name: 'Compromised' });
    write(l.dir, a.approverRecord());
    write(l.dir, b.approverRecord());
    const s = store(l);
    await s.ready();
    const c = createFakePhone({ name: 'New phone' });
    assert.deepEqual(s.stage(a.revoke(b.deviceId, { now: NOW })), { state: 'revoked-pending-apply' });
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'staged' });
    assert.deepEqual(s.stage(b.revoke(c.deviceId, { now: NOW })), { state: 'revoked-pending-apply' });

    const ad = admin(l);
    const results = await ad.applyStaged({ confirm: async () => true });
    const byType = (t) => results.filter((r) => r.type === t).map((r) => [r.signer === a.deviceId ? 'A' : 'B', r.result]).sort();
    assert.deepEqual(byType('kl.device.revoke'), [
      ['A', 'revoked'],
      ['B', 'rejected: signer is not an active approver']
    ].sort());
    assert.deepEqual(byType('kl.device.enroll'), [['A', 'enrolled']]);
    assert.equal(ad.read(c.deviceId).enrolled_by, a.deviceId);
  });
});

describe('M3 round 2: a failed staging write is a result, not a throw', () => {
  it('returns staging_write_failed instead of throwing, and a revoke still blocks immediately through the overlay', async () => {
    const l = layout();
    const a = createFakePhone();
    write(l.dir, a.approverRecord());
    // stagedDir is a plain file, so mkdirSync inside _writeStaged throws EEXIST.
    fs.mkdirSync(path.dirname(l.stagedDir), { recursive: true });
    fs.writeFileSync(l.stagedDir, 'not a directory');
    const s = store(l);
    await s.ready();
    const c = createFakePhone();
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW })), { state: 'rejected', reason: 'staging_write_failed' });
    const b = createFakePhone({ name: 'B' });
    write(l.dir, b.approverRecord());
    s.refresh();
    assert.deepEqual(s.stage(a.revoke(b.deviceId, { now: NOW })), { state: 'rejected', reason: 'staging_write_failed' });
    // The overlay is set before the durable write is attempted, so the
    // block still takes effect immediately even though the write failed.
    assert.equal(s.isActive(b.deviceId), false);
  });
});
