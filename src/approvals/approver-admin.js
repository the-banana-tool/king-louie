// Writes the approver set. Only the admin-run CLI (`enroll-device`, `device
// revoke|apply`) loads this module; the service never does, because whoever
// can write <configDir>/approvers/ approves anything.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApproverStore, checkApproverRecord, writeFileAtomic } = require('./approver-store');
const { open, verifyEs256 } = require('./envelope');
const { validateMessage, iso } = require('./messages');

const MAX_STAGED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

class ApproverAdminError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApproverAdminError';
  }
}

class ApproverAdmin {
  constructor({ dir, stagedDir, now = Date.now, allowTestKeys = false, geteuid, adminUid = 0, platform = process.platform } = {}) {
    this.dir = dir;
    this.stagedDir = stagedDir;
    this.now = now;
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

  listStaged() {
    if (!this.stagedDir || !fs.existsSync(this.stagedDir)) return [];
    const items = [];
    for (const name of fs.readdirSync(this.stagedDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.stagedDir, name);
      try {
        const { received_at: receivedAt, envelope } = JSON.parse(fs.readFileSync(file, 'utf8'));
        const { message } = open(envelope);
        const revoke = message.type === 'kl.device.revoke';
        items.push({
          file,
          type: message.type,
          deviceId: revoke ? message.device_id : message.device && message.device.device_id,
          signer: revoke ? message.revoked_by : message.enrolled_by,
          receivedAt,
          ageMs: this.now() - Date.parse(receivedAt),
          envelope,
          message
        });
      } catch (err) {
        items.push({ file, type: 'unreadable', deviceId: null, signer: null, receivedAt: null, ageMs: Infinity, envelope: null, message: null, error: err.message });
      }
    }
    return items;
  }

  _done(file) {
    const doneDir = path.join(this.stagedDir, 'done');
    fs.mkdirSync(doneDir, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(doneDir, path.basename(file)));
  }

  // `confirm(items) → Promise<boolean>` sees the batch before anything is
  // written. Every item is judged against the admin set as it stood before
  // the batch; revokes go first, and an enrollment signed by a device this
  // batch revokes is refused.
  async applyStaged({ now = this.now(), confirm }) {
    const items = this.listStaged();
    if (items.length === 0) return [];
    if (!(await confirm(items))) return [];
    this.assertWritable();

    const before = new ApproverStore(this.storeOptions);
    const applied = new Map(before.list().filter((r) => before.isAdminApplied(r.device_id)).map((r) => [r.device_id, r]));
    const revokedInBatch = new Set();
    const order = [...items.filter((i) => i.type === 'kl.device.revoke'), ...items.filter((i) => i.type !== 'kl.device.revoke')];
    const results = [];

    for (const item of order) {
      let result;
      if (!item.message) {
        result = `rejected: unreadable (${item.error})`;
      } else if (now - Date.parse(item.receivedAt) > MAX_STAGED_AGE_MS) {
        result = 'rejected: older than 7 days';
      } else if (validateMessage(item.type, item.message)) {
        result = 'rejected: malformed';
      } else {
        const signer = applied.get(item.signer);
        const signedOk = signer && item.envelope.kid === item.signer && verifyEs256(item.envelope, signer.public_key);
        if (item.type === 'kl.device.revoke') {
          if (item.signer === item.deviceId) result = 'rejected: a device cannot revoke itself';
          else if (!signedOk) result = 'rejected: signer is not an active approver';
          else if (!this.read(item.deviceId)) result = 'rejected: unknown device';
          else {
            this.markRevoked(item.deviceId, item.signer);
            revokedInBatch.add(item.deviceId);
            result = 'revoked';
          }
        } else if (!signedOk || revokedInBatch.has(item.signer)) {
          result = 'rejected: signer is not an active approver';
        } else {
          const existing = this.read(item.deviceId);
          if (existing && existing.revoked_at !== null) result = 'rejected: device was revoked';
          else if (existing) result = 'rejected: already enrolled';
          else {
            const { device } = item.message;
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
      this._done(item.file);
      results.push({ file: item.file, type: item.type, deviceId: item.deviceId, signer: item.signer, result });
    }
    return results;
  }
}

module.exports = { ApproverAdmin, ApproverAdminError, MAX_STAGED_AGE_MS };
