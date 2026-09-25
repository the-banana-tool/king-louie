// Writes the approver set. Only the admin-run CLI (`enroll-device`, `device
// revoke|apply`) loads this module; the service never does, because whoever
// can write <configDir>/approvers/ approves anything.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApproverStore, checkApproverRecord, writeFileAtomic } = require('./approver-store');
const { open, verifyEs256 } = require('./envelope');
const { validateMessage, iso, DEVICE_ID_RE } = require('./messages');
const { isTestDeviceKey } = require('./test-keys');

const MAX_STAGED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Not every platform defines O_NOFOLLOW (Windows does not); fall back to 0
// (no-op flag) there and rely on the lstat check instead.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

class ApproverAdminError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApproverAdminError';
  }
}

// staged/ and staged/done/ are service-writable: whoever runs the service
// could plant a symlink there and have root's admin CLI follow it into
// reading or writing somewhere else entirely. A missing directory is fine
// (it is created on demand); an existing symlink in its place is not.
function assertDirNotSymlink(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    throw new ApproverAdminError(`Refusing to use ${dir}: it is a symlink, and this directory is writable by the service account.`);
  }
}

// Reads a file that has already been lstat'd as a regular, non-symlink file.
// O_NOFOLLOW closes the race between that lstat and this open on platforms
// that support it (not Windows).
function readRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

class ApproverAdmin {
  constructor({ dir, stagedDir, now = Date.now, allowTestKeys = false, geteuid, adminUid = 0, platform = process.platform } = {}) {
    this.dir = dir;
    this.stagedDir = stagedDir;
    this.now = now;
    this.allowTestKeys = allowTestKeys === true;
    this.storeOptions = { dir, stagedDir, allowTestKeys, adminUid, platform, now, ...(geteuid ? { geteuid } : {}) };
  }

  // Creating a file is the only reliable test on every platform: on Windows
  // the ACL decides, and access(W_OK) does not consult it.
  assertWritable() {
    const fail = () => new ApproverAdminError(`Run this as root/Administrator: ${this.dir} is not writable.`);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    } catch {
      throw fail();
    }
    const probe = path.join(this.dir, `.probe-${crypto.randomBytes(6).toString('hex')}`);
    try {
      fs.closeSync(fs.openSync(probe, 'wx', 0o644));
      fs.unlinkSync(probe);
    } catch {
      throw fail();
    }
  }

  _file(deviceId) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      throw new ApproverAdminError(`Refusing to use "${deviceId}" as an approver file name: not a valid device id.`);
    }
    return path.join(this.dir, `${deviceId}.json`);
  }

  read(deviceId) {
    try {
      return JSON.parse(fs.readFileSync(this._file(deviceId), 'utf8'));
    } catch {
      return null;
    }
  }

  writeApprover(record) {
    this.assertWritable();
    const fault = checkApproverRecord(record);
    if (fault) throw new ApproverAdminError(`Refusing to write approver ${record && record.device_id}: ${fault}`);
    const existing = this.read(record.device_id);
    if (existing && existing.revoked_at !== null && record.revoked_at === null) {
      throw new ApproverAdminError(`${record.device_id} was revoked and is never re-activated. Enroll the phone again with a new key.`);
    }
    writeFileAtomic(this._file(record.device_id), `${JSON.stringify(record, null, 2)}\n`, 0o644);
    return record;
  }

  markRevoked(deviceId, by) {
    this.assertWritable();
    const record = this.read(deviceId);
    if (!record) throw new ApproverAdminError(`No approver ${deviceId} on this node.`);
    if (record.revoked_at !== null) return record;
    const revoked = { ...record, revoked_at: iso(this.now()), revoked_by: by };
    writeFileAtomic(this._file(deviceId), `${JSON.stringify(revoked, null, 2)}\n`, 0o644);
    return revoked;
  }

  // Lists every staged item, including ones this admin cannot safely act on
  // (`type: 'unsafe'`: a symlink or non-regular file — I2). Throws if
  // staged/ or staged/done/ is itself a symlink.
  listStaged() {
    if (!this.stagedDir) return [];
    assertDirNotSymlink(this.stagedDir);
    if (!fs.existsSync(this.stagedDir)) return [];
    assertDirNotSymlink(path.join(this.stagedDir, 'done'));

    const items = [];
    for (const name of fs.readdirSync(this.stagedDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.stagedDir, name);
      let lst;
      try {
        lst = fs.lstatSync(file);
      } catch {
        continue; // vanished between readdir and lstat
      }
      if (lst.isSymbolicLink() || !lst.isFile()) {
        items.push({ file, type: 'unsafe', deviceId: null, signer: null, receivedAt: null, envelope: null, message: null });
        continue;
      }
      try {
        const { received_at: receivedAt, envelope } = JSON.parse(readRegularFile(file));
        const { message } = open(envelope);
        const revoke = message.type === 'kl.device.revoke';
        items.push({
          file,
          type: message.type,
          deviceId: revoke ? message.device_id : message.device && message.device.device_id,
          signer: revoke ? message.revoked_by : message.enrolled_by,
          receivedAt, // display only — never read for a policy decision (I1)
          envelope,
          message
        });
      } catch (err) {
        items.push({ file, type: 'unreadable', deviceId: null, signer: null, receivedAt: null, envelope: null, message: null, error: err.message });
      }
    }
    return items;
  }

  _done(file) {
    const doneDir = path.join(this.stagedDir, 'done');
    assertDirNotSymlink(doneDir);
    fs.mkdirSync(doneDir, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(doneDir, path.basename(file)));
  }

  // Age is judged on the message's own signed `created_at`, never the
  // service-written `received_at` (I1) — the data dir does not get to set
  // policy by forging when a file "arrived".
  _tooOld(message, now) {
    return now - Date.parse(message.created_at) > MAX_STAGED_AGE_MS;
  }

  // `confirm(items) → Promise<boolean>` sees the batch before anything is
  // written. Every item is judged against the admin set as it stood before
  // the batch. Revokes are collected first and always win (C1): an
  // enrollment of a device a valid revoke targets is refused whether that
  // revoke lands in this batch or an earlier one, and a revoke of a device
  // with no record yet is left staged — `deferred: unknown device` — so the
  // block holds until either an admin-applied record exists to revoke or
  // the revoke's own signed window ages out.
  async applyStaged({ now = this.now(), confirm }) {
    const items = this.listStaged();
    if (items.length === 0) return [];
    if (!(await confirm(items))) return [];
    this.assertWritable();

    // A store starts untrusted until ready() runs (M1), so this snapshot
    // must be readied like any other before its list() means anything.
    const before = new ApproverStore(this.storeOptions);
    await before.ready();
    const applied = new Map(before.list().filter((r) => before.isAdminApplied(r.device_id)).map((r) => [r.device_id, r]));
    const revokedTargets = new Set();
    const results = [];

    const revokes = items.filter((i) => i.type === 'kl.device.revoke');
    const rest = items.filter((i) => i.type !== 'kl.device.revoke' && i.type !== 'unsafe');
    const unsafe = items.filter((i) => i.type === 'unsafe');

    for (const item of revokes) {
      let result;
      let done = true;
      if (this._tooOld(item.message, now)) {
        result = 'rejected: older than 7 days';
      } else if (validateMessage('kl.device.revoke', item.message)) {
        result = 'rejected: malformed';
      } else if (item.signer === item.deviceId) {
        result = 'rejected: a device cannot revoke itself';
      } else {
        const signer = applied.get(item.signer);
        const signedOk = signer && item.envelope.kid === item.signer && verifyEs256(item.envelope, signer.public_key);
        if (!signedOk) {
          result = 'rejected: signer is not an active approver';
        } else {
          revokedTargets.add(item.deviceId);
          const existing = this.read(item.deviceId);
          if (existing) {
            this.markRevoked(item.deviceId, item.signer);
            result = 'revoked';
          } else {
            // Not moved to done/: it must keep blocking any enroll of this
            // device_id, in this batch or a later one, until it expires.
            result = 'deferred: unknown device';
            done = false;
          }
        }
      }
      if (done) this._done(item.file);
      results.push({ file: item.file, type: item.type, deviceId: item.deviceId, signer: item.signer, result });
    }

    for (const item of rest) {
      let result;
      if (!item.message) {
        result = `rejected: unreadable (${item.error})`;
      } else if (this._tooOld(item.message, now)) {
        result = 'rejected: older than 7 days';
      } else if (validateMessage(item.type, item.message)) {
        result = 'rejected: malformed';
      } else if (revokedTargets.has(item.deviceId)) {
        result = 'rejected: device was revoked';
      } else {
        const signer = applied.get(item.signer);
        const signedOk = signer && item.envelope.kid === item.signer && verifyEs256(item.envelope, signer.public_key);
        if (!signedOk || revokedTargets.has(item.signer)) {
          result = 'rejected: signer is not an active approver';
        } else {
          const { device } = item.message;
          if (!this.allowTestKeys && device.platform === 'demo') {
            result = 'rejected: demo device';
          } else if (!this.allowTestKeys && isTestDeviceKey(device.public_key)) {
            result = 'rejected: test key';
          } else {
            const existing = this.read(item.deviceId);
            if (existing && existing.revoked_at !== null) result = 'rejected: device was revoked';
            else if (existing) result = 'rejected: already enrolled';
            else {
              this.writeApprover({
                v: 1,
                device_id: device.device_id,
                name: device.name,
                platform: device.platform,
                public_key: device.public_key,
                enrolled_at: iso(now),
                enrolled_by: item.signer,
                revoked_at: null,
                revoked_by: null,
                enrollment: item.envelope
              });
              result = 'enrolled';
            }
          }
        }
      }
      this._done(item.file);
      results.push({ file: item.file, type: item.type, deviceId: item.deviceId, signer: item.signer, result });
    }

    for (const item of unsafe) {
      results.push({ file: item.file, type: item.type, deviceId: item.deviceId, signer: item.signer, result: 'rejected: not a regular file' });
    }

    return results;
  }
}

module.exports = { ApproverAdmin, ApproverAdminError, MAX_STAGED_AGE_MS };
