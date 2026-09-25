// The set of phones allowed to approve unsafe actions on this node.
//
// The service only READS it: whoever can add a key approves anything, so the
// files live in the admin-owned <configDir>/approvers/ and only the admin CLI
// (approver-admin.js) writes them. A relayed enrollment or revocation is
// staged in the service-writable data dir and applied by an admin
// (`device apply`, R15); a verified revocation takes effect at once through
// an in-memory overlay that can only remove trust.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const { open, verifyEs256, isDeviceJwk, deviceIdFromJwk } = require('./envelope');
const { validateMessage, NONCE_RE, DEVICE_ID_RE, TIMESTAMP_RE, PLATFORMS } = require('./messages');
const { isTestDeviceKey } = require('./test-keys');

const log = createLogger('approvals/approver-store');

const APPROVER_CONTROLS = {
  decides: 'which phones may approve unsafe actions on this node',
  selfGrant: 'add its own approver'
};
const CACHE_MS = 1000;
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

const nullOrTimestamp = (v) => v === null || (typeof v === 'string' && TIMESTAMP_RE.test(v));
const byWhom = (v) => v === 'console' || (typeof v === 'string' && DEVICE_ID_RE.test(v));

// null when `record` is a well-formed approver file named `fileName`, else why not.
function checkApproverRecord(record, fileName = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.v !== 1) return 'v must be 1';
  if (typeof record.device_id !== 'string' || !DEVICE_ID_RE.test(record.device_id)) return 'bad device_id';
  if (fileName !== null && fileName !== `${record.device_id}.json`) return 'file name does not match device_id';
  if (!isDeviceJwk(record.public_key)) return 'public_key must be a P-256 JWK with exactly kty, crv, x, y';
  if (deviceIdFromJwk(record.public_key) !== record.device_id) return 'device_id does not derive from public_key';
  if (typeof record.name !== 'string' || !record.name) return 'bad name';
  if (!PLATFORMS.includes(record.platform)) return 'bad platform';
  if (!(typeof record.enrolled_at === 'string' && TIMESTAMP_RE.test(record.enrolled_at))) return 'bad enrolled_at';
  if (!byWhom(record.enrolled_by)) return 'bad enrolled_by';
  if (!nullOrTimestamp(record.revoked_at)) return 'bad revoked_at';
  if (!(record.revoked_by === null || byWhom(record.revoked_by))) return 'bad revoked_by';
  if (!(record.enrollment === null || (typeof record.enrollment === 'object' && !Array.isArray(record.enrollment)))) return 'bad enrollment';
  return null;
}

// null when the approver dir may be trusted, else the problem. A missing dir
// is an empty set, not a problem. Sync so `doctor` can use it too.
function checkApproverDir({ dir, platform = process.platform, geteuid = defaultGeteuid, adminUid = 0, fsImpl = fs }) {
  if (!fsImpl.existsSync(dir)) return null;
  if (platform === 'win32') {
    const probe = path.join(dir, `.probe-${crypto.randomBytes(6).toString('hex')}`);
    let fd = null;
    let openErr = null;
    try {
      fd = fsImpl.openSync(probe, 'wx');
    } catch (err) {
      openErr = err;
    }
    if (fd === null) {
      // Only "denied" proves the ACL is right. Any other failure (the dir
      // vanished, a device error, …) means the probe proved nothing, so it
      // must not be read as "trusted" — that would be trusting silence.
      if (openErr && (openErr.code === 'EACCES' || openErr.code === 'EPERM')) return null;
      const why = openErr ? (openErr.code || openErr.message) : 'unknown error';
      return `${dir}: could not verify the approver directory is protected (${why}); no approver is trusted until this is fixed`;
    }
    try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    try { fsImpl.unlinkSync(probe); } catch { /* ignore */ }
    return `${dir} is writable by the account running the service; no approver is trusted until an administrator fixes its ACL`;
  }
  try {
    assertAdminOwned(dir, geteuid, adminUid, APPROVER_CONTROLS);
    return null;
  } catch (err) {
    return err.message;
  }
}

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd); // the rename must not land before the bytes it points at do
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore: never had a fd, or already gone */ }
    throw err;
  }
}

class ApproverStore {
  constructor({ dir, stagedDir, geteuid = defaultGeteuid, adminUid = 0, platform = process.platform, now = Date.now,
    allowTestKeys = false, fsImpl = fs } = {}) {
    if (!dir) throw new TypeError('ApproverStore needs a dir');
    this.dir = dir;
    this.stagedDir = stagedDir || null;
    this.geteuid = geteuid;
    this.adminUid = adminUid;
    this.platform = platform;
    this.now = now;
    this.allowTestKeys = allowTestKeys === true;
    this.fs = fsImpl;
    this.problem = null;
    // Untrusted until ready() runs the probe: a store nobody has checked yet
    // must fail closed, the same as one that failed the check.
    this.untrusted = true;
    this.overlay = new Set();
    this._files = new Map();
    this._scannedAt = -Infinity;
    this._logged = new Set();
  }

  // Startup probe. POSIX: the dir must be admin-owned and not writable by
  // anyone else. Windows (assertAdminOwned is a no-op there, R51): if this
  // process can create a file in the dir, the ACL is wrong, and the set is
  // treated as empty until an administrator fixes it.
  async ready() {
    this.problem = checkApproverDir({ dir: this.dir, platform: this.platform, geteuid: this.geteuid, adminUid: this.adminUid, fsImpl: this.fs });
    this.untrusted = this.problem !== null;
    if (this.problem) log.error(`approver set treated as empty: ${this.problem}`);
    this._scannedAt = -Infinity;
    this._rebuildOverlay();
    return this.problem ? { ok: false, problem: this.problem } : { ok: true };
  }

  _logOnce(key, message) {
    if (this._logged.has(key)) return;
    this._logged.add(key);
    log.error(message);
  }

  // Re-stats the dir at most once a second and re-reads files that changed.
  _scan() {
    const nowMs = Date.now();
    if (nowMs - this._scannedAt < CACHE_MS) return;
    this._scannedAt = nowMs;
    if (this.untrusted) {
      this._files.clear();
      return;
    }
    let names;
    try {
      if (!this.fs.existsSync(this.dir)) {
        this._files.clear();
        return;
      }
      names = this.fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch (err) {
      // A gate refusal is a result, never a throw: a directory that becomes
      // unreadable mid-run (removed, a permission flip, a flaky mount) must
      // fail closed to an empty set, not crash whatever called isActive/get.
      this._logOnce(`readdir:${this.dir}`, `treating the approver set as empty: cannot read ${this.dir}: ${err.message}`);
      this._files.clear();
      return;
    }
    const seen = new Set(names);
    for (const name of [...this._files.keys()]) if (!seen.has(name)) this._files.delete(name);
    for (const name of names) {
      const file = path.join(this.dir, name);
      let st;
      try {
        st = this.fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this._files.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      let record = null;
      try {
        if (this.platform !== 'win32') assertAdminOwned(file, this.geteuid, this.adminUid, APPROVER_CONTROLS);
        const parsed = JSON.parse(this.fs.readFileSync(file, 'utf8'));
        const fault = checkApproverRecord(parsed, name);
        if (fault) throw new Error(fault);
        record = parsed;
      } catch (err) {
        this._logOnce(`${name}:${st.mtimeMs}`, `ignoring approver file ${file}: ${err.message}`);
      }
      this._files.set(name, { mtimeMs: st.mtimeMs, size: st.size, record });
    }
  }

  // Forget the one-second cache, so the next read sees files written just now.
  refresh() {
    this._scannedAt = -Infinity;
  }

  isTestKey(deviceId) {
    const record = this.get(deviceId);
    return Boolean(record) && isTestDeviceKey(record.public_key);
  }

  // Well-formed approver records, test keys left out unless allowTestKeys.
  list() {
    this._scan();
    const out = [];
    for (const [name, entry] of this._files) {
      if (!entry.record) continue;
      if (!this.allowTestKeys && isTestDeviceKey(entry.record.public_key)) {
        this._logOnce(`test:${name}`, `ignoring approver file ${name}: its key is a published test key`);
        continue;
      }
      out.push(entry.record);
    }
    return out;
  }

  // Any well-formed record, test key or demo included, so verification can
  // say why it refuses (demo_device, test_key) instead of unknown_device.
  get(deviceId) {
    this._scan();
    const entry = this._files.get(`${deviceId}.json`);
    return entry && entry.record ? entry.record : null;
  }

  isActive(deviceId, { overlay = true } = {}) {
    const record = this.get(deviceId);
    if (!record || record.platform === 'demo' || record.revoked_at !== null) return false;
    if (!this.allowTestKeys && isTestDeviceKey(record.public_key)) return false;
    return !(overlay && this.overlay.has(deviceId));
  }

  isAdminApplied(deviceId) {
    return this.isActive(deviceId, { overlay: false });
  }

  activeCount() {
    return this.list().filter((r) => this.isActive(r.device_id)).length;
  }

  addToOverlay(deviceId) {
    this.overlay.add(deviceId);
  }

  _stagedFile(nonce) {
    return path.join(this.stagedDir, `${nonce}.json`);
  }

  _isKnownNonce(nonce) {
    return this.fs.existsSync(this._stagedFile(nonce)) || this.fs.existsSync(path.join(this.stagedDir, 'done', `${nonce}.json`));
  }

  // Checks a relayed revoke against the admin-applied set (the overlay is
  // ignored, so a thief's revoke of the owner cannot stop the owner's
  // counter-revoke). Returns null or the reason.
  _checkRevoke(envelope, message) {
    if (envelope.alg !== 'ES256' || envelope.kid !== message.revoked_by) return 'malformed';
    if (message.revoked_by === message.device_id) return 'self_revoke';
    if (!this.isAdminApplied(message.revoked_by)) return 'signer_not_active';
    if (!verifyEs256(envelope, this.get(message.revoked_by).public_key)) return 'bad_signature';
    return null;
  }

  _rebuildOverlay() {
    this.overlay.clear();
    if (!this.stagedDir) return;
    let names;
    try {
      if (!this.fs.existsSync(this.stagedDir)) return;
      names = this.fs.readdirSync(this.stagedDir).filter((n) => n.endsWith('.json'));
    } catch (err) {
      // Same fail-closed rule as _scan(): an unreadable staged dir yields no
      // overlay entries rather than an uncaught throw out of ready().
      log.error(`treating the revoke overlay as empty: cannot read ${this.stagedDir}: ${err.message}`);
      return;
    }
    for (const name of names) {
      try {
        const { envelope } = JSON.parse(this.fs.readFileSync(path.join(this.stagedDir, name), 'utf8'));
        const { message } = open(envelope);
        if (message.type !== 'kl.device.revoke' || validateMessage('kl.device.revoke', message)) continue;
        if (this._checkRevoke(envelope, message) === null) this.overlay.add(message.device_id);
      } catch (err) {
        log.warn(`ignoring staged file ${name}: ${err.message}`);
      }
    }
  }

  stage(envelope) {
    const rejected = (reason) => ({ state: 'rejected', reason });
    if (!this.stagedDir) return rejected('no_staging_dir');
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      return rejected('malformed');
    }
    const type = message.type;
    if (type !== 'kl.device.enroll' && type !== 'kl.device.revoke') return rejected('malformed');
    // Validated before it is used as a file name.
    if (typeof message.nonce !== 'string' || !NONCE_RE.test(message.nonce)) return rejected('malformed');
    if (this._isKnownNonce(message.nonce)) return { state: 'duplicate' };
    const shape = validateMessage(type, message);
    if (shape) return rejected(shape);
    if (this.now() > Date.parse(message.expires_at)) return rejected('expired');

    if (type === 'kl.device.enroll') {
      if (message.enrolled_by === null) return rejected('console_enrollment_is_not_relayed');
      if (envelope.alg !== 'ES256' || envelope.kid !== message.enrolled_by) return rejected('malformed');
      // Enrolls are checked against the admin set AND the overlay.
      if (!this.isActive(message.enrolled_by)) return rejected('signer_not_active');
      if (!verifyEs256(envelope, this.get(message.enrolled_by).public_key)) return rejected('bad_signature');
      // The device being enrolled, not the signer: a demo or published test
      // key must never become a real approver unless the store was built to
      // allow it (tests only).
      if (!this.allowTestKeys) {
        if (message.device.platform === 'demo') return rejected('demo_device');
        if (isTestDeviceKey(message.device.public_key)) return rejected('test_key');
      }
      const existing = this.get(message.device.device_id);
      if (existing && existing.revoked_at !== null) return rejected('revoked_device');
      if (existing && this.isAdminApplied(existing.device_id)) return { state: 'duplicate' };
      this._writeStaged(message.nonce, envelope);
      return { state: 'staged' };
    }

    const fault = this._checkRevoke(envelope, message);
    if (fault) return rejected(fault);
    this._writeStaged(message.nonce, envelope);
    this.overlay.add(message.device_id);
    return { state: 'revoked-pending-apply' };
  }

  _writeStaged(nonce, envelope) {
    this.fs.mkdirSync(this.stagedDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this._stagedFile(nonce), `${JSON.stringify({ received_at: new Date(this.now()).toISOString(), envelope })}\n`);
  }
}

module.exports = { ApproverStore, checkApproverRecord, checkApproverDir, writeFileAtomic, APPROVER_CONTROLS };
