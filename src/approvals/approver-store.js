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
// A staged message's own signed created_at may not be this far ahead of the
// node's clock. Without this, a revoke dated far in the future would never
// age out of MAX_STAGED_AGE_MS (age = now - created_at is negative), making
// its deferral-blocking effect unbounded instead of capped at 7 days.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
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
//
// `serviceProbe` (default true) runs the Windows "can I write here?" probe,
// which asks whether the *service* account's ACL is wrong. It must be
// false for a store built by the admin CLI itself: on Windows the admin
// process runs as Administrator, so the probe would always say "yes, I can
// write" and mistake its own privilege for a broken ACL, treating every
// approver as untrusted. POSIX is unaffected either way — assertAdminOwned
// checks the actual owner/mode, not who is asking.
function checkApproverDir({ dir, platform = process.platform, geteuid = defaultGeteuid, adminUid = 0, fsImpl = fs, serviceProbe = true }) {
  if (!fsImpl.existsSync(dir)) return null;
  if (platform === 'win32') {
    if (!serviceProbe) return null;
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

// Windows owners (Task 23 re-review, Ruling A2). A directory's owner always
// keeps WRITE_DAC, so the write probe alone is not enough: an account that
// owns approvers\ can plant a file, deny itself write access, pass the probe,
// and give the access back later. So on Windows the approvers dir is trusted
// only when its owner is Administrators, SYSTEM or whoever owns the config
// dir above it, and the config dir itself is not owned by the service
// account (LOCAL SERVICE, which the installer runs the service as).
const WINDOWS_TRUSTED_OWNERS = new Set(['S-1-5-32-544', 'S-1-5-18']);
const WINDOWS_SERVICE_ACCOUNTS = new Set(['S-1-5-19']);
const SID_RE = /^S-1-(?:\d+-)*\d+$/;
const OWNER_READ_TIMEOUT_MS = 15000;
// How long a failed owner read stands before the next scan reads again.
const OWNER_RETRY_MS = 30000;

// Framework types only, no Get-Acl: the cmdlet lives in a module that fails
// to autoload where PSModulePath points elsewhere (see the installer tests).
// The paths travel in environment variables, never in the script text.
const OWNER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sections = [System.Security.AccessControl.AccessControlSections]::Owner",
  'foreach ($p in @($env:KL_APPROVERS_DIR, $env:KL_CONFIG_DIR)) {',
  '  $ds = New-Object -TypeName System.Security.AccessControl.DirectorySecurity -ArgumentList $p, $sections',
  '  [Console]::Out.WriteLine($ds.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)',
  '}'
].join('\n');

// { approvers, config } owner SIDs, read through one bounded PowerShell call.
function readWindowsOwners({ dir, configDir }) {
  const { execFileSync } = require('child_process');
  const { windowsPowerShellExe } = require('../platform/windows-paths');
  let out;
  try {
    out = execFileSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', OWNER_SCRIPT], {
      env: { ...process.env, KL_APPROVERS_DIR: dir, KL_CONFIG_DIR: configDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: OWNER_READ_TIMEOUT_MS,
      windowsHide: true
    });
  } catch (err) {
    // The first line PowerShell wrote to stderr, not the whole command line.
    const first = String(err.stderr || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    throw new Error(err.code === 'ETIMEDOUT' ? `timed out after ${OWNER_READ_TIMEOUT_MS} ms` : (first || err.code || 'powershell failed'));
  }
  const [approvers, config] = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { approvers, config };
}

// null when the owners allow trusting `dir`, else the problem. Any failure
// to read them is a problem: an owner nobody could check is not trusted.
// → { problem, readFailed }: readFailed when the owners could not be read at
// all (as opposed to a verdict on owners that were read), which the store
// must not cache.
function windowsOwnerVerdict({ dir, configDir, readOwners = readWindowsOwners }) {
  let owners;
  try {
    owners = readOwners({ dir, configDir });
  } catch (err) {
    return { readFailed: true, problem: `${dir}: could not read the owners of the approver and config directories (${err.message}); no approver is trusted until this is fixed` };
  }
  const { approvers, config } = owners || {};
  if (!SID_RE.test(String(approvers)) || !SID_RE.test(String(config))) {
    return { readFailed: true, problem: `${dir}: could not read the owners of the approver and config directories; no approver is trusted until this is fixed` };
  }
  if (WINDOWS_SERVICE_ACCOUNTS.has(config)) {
    return { readFailed: false, problem: `${configDir} is owned by the service account (${config}); no approver is trusted until an administrator takes ownership of it` };
  }
  if (!WINDOWS_TRUSTED_OWNERS.has(approvers) && approvers !== config) {
    return { readFailed: false, problem: `${dir} is owned by ${approvers}, which is neither Administrators, SYSTEM nor the owner of ${configDir} (${config}); `
      + 'a directory\'s owner can always rewrite its ACL, so no approver is trusted until an administrator takes ownership of it' };
  }
  return { readFailed: false, problem: null };
}

function checkWindowsOwners(args) {
  return windowsOwnerVerdict(args).problem;
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
    allowTestKeys = false, fsImpl = fs, serviceProbe = true, readOwners = readWindowsOwners } = {}) {
    if (!dir) throw new TypeError('ApproverStore needs a dir');
    this.dir = dir;
    this.stagedDir = stagedDir || null;
    this.geteuid = geteuid;
    this.adminUid = adminUid;
    this.platform = platform;
    this.now = now;
    this.allowTestKeys = allowTestKeys === true;
    this.fs = fsImpl;
    this.serviceProbe = serviceProbe !== false;
    this.problem = null;
    // Untrusted until ready() runs the probe: a store nobody has checked yet
    // must fail closed, the same as one that failed the check.
    this.untrusted = true;
    this.overlay = new Set();
    this._files = new Map();
    this._scannedAt = -Infinity;
    this._logged = new Set();
    this._readied = false;
    // Windows owner check (Ruling A2): run again only when the approvers or
    // config dir's identity or ChangeTime moves (an owner or ACL change moves
    // NTFS ChangeTime), never on every scan.
    this.readOwners = readOwners;
    this._ownerKey = null;
    this._ownerProblem = null;
  }

  // Startup probe. POSIX: the dir must be admin-owned and not writable by
  // anyone else. Windows (assertAdminOwned is a no-op there, R51): if this
  // process can create a file in the dir, the ACL is wrong, and the set is
  // treated as empty until an administrator fixes it.
  async ready() {
    this.problem = this._checkTrust();
    this.untrusted = this.problem !== null;
    this._readied = true;
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
    // Windows: the dir's ACL is the only guard (files carry no owner check
    // there), and it can change under a running service, or the dir can be
    // created after startup by whoever may write its parent. So the write
    // probe runs again on every scan, never just once in ready(): a dir the
    // service can write is untrusted (no approver counts) until a later
    // probe finds it locked, and a missing dir is simply no approvers.
    // Only once ready() has run: until then the store stays untrusted (and
    // its revoke overlay unbuilt), whatever a probe would say.
    if (this.platform === 'win32' && this.serviceProbe && this._readied) this._reprobe();
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

  // null when the dir may be trusted, else why not: the POSIX ownership
  // check, or on Windows the write probe and then the owner check.
  _checkTrust() {
    const problem = checkApproverDir({
      dir: this.dir, platform: this.platform, geteuid: this.geteuid, adminUid: this.adminUid, fsImpl: this.fs, serviceProbe: this.serviceProbe
    });
    if (problem || this.platform !== 'win32' || !this.serviceProbe) return problem;
    return this._checkOwners();
  }

  // The Windows owner verdict, cached on the approvers and config dirs'
  // (ino, ChangeTime). A missing approvers dir is no approvers (and forgets
  // the cache, so a dir that appears later is checked); a junction there is
  // refused outright. Only a verdict is cached: an owner read that failed
  // (a PowerShell timeout under load at boot) stands for OWNER_RETRY_MS and
  // is then read again, instead of disabling every approver until the ACL
  // changes or the service restarts.
  _checkOwners() {
    const configDir = path.dirname(this.dir);
    let key;
    try {
      const st = this.fs.lstatSync(this.dir, { bigint: true });
      if (st.isSymbolicLink() || !st.isDirectory()) return `${this.dir} is a junction, symlink or not a directory; no approver is trusted`;
      const cst = this.fs.lstatSync(configDir, { bigint: true });
      key = `${st.ino}:${st.ctimeNs}|${cst.ino}:${cst.ctimeNs}`;
    } catch (err) {
      this._ownerKey = null;
      if (err.code === 'ENOENT') return null;
      return `${this.dir}: could not check its owner (${err.code || err.message}); no approver is trusted until this is fixed`;
    }
    const t = this.now();
    const waitingToRetry = this._ownerRetryKey === key && t < this._ownerRetryAt;
    if (key !== this._ownerKey && !waitingToRetry) {
      const { problem, readFailed } = windowsOwnerVerdict({ dir: this.dir, configDir, readOwners: this.readOwners });
      this._ownerProblem = problem;
      if (readFailed) {
        this._ownerKey = null;
        this._ownerRetryKey = key;
        this._ownerRetryAt = t + OWNER_RETRY_MS;
      } else {
        this._ownerKey = key;
        this._ownerRetryKey = null;
      }
    }
    return this._ownerProblem;
  }

  // Re-runs the Windows write probe; logs only when the verdict changes.
  _reprobe() {
    const problem = this._checkTrust();
    if (problem !== this.problem) {
      if (problem) log.error(`approver set treated as empty: ${problem}`);
      else log.info(`approver directory ${this.dir} is protected again; its approvers count`);
    }
    this.problem = problem;
    this.untrusted = problem !== null;
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
    // Checked before `expired`: a message dated far in the future would
    // otherwise pass expiry (its expires_at is future too) and, for a
    // revoke, defer forever instead of aging out within 7 days.
    if (Date.parse(message.created_at) - this.now() > FUTURE_SKEW_MS) return rejected('from_the_future');
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
      if (!this._writeStagedSafe(message.nonce, envelope)) return rejected('staging_write_failed');
      return { state: 'staged' };
    }

    const fault = this._checkRevoke(envelope, message);
    if (fault) return rejected(fault);
    // Overlay before the durable write: the overlay only ever removes
    // trust, so setting it first can never grant anything by mistake, and
    // it means the block takes effect immediately even if the write below
    // then fails (a full disk, a permission flip) — the alternative order
    // would let a write failure silently drop the revoke's only effect.
    this.overlay.add(message.device_id);
    if (!this._writeStagedSafe(message.nonce, envelope)) return rejected('staging_write_failed');
    return { state: 'revoked-pending-apply' };
  }

  _writeStaged(nonce, envelope) {
    this.fs.mkdirSync(this.stagedDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this._stagedFile(nonce), `${JSON.stringify({ received_at: new Date(this.now()).toISOString(), envelope })}\n`);
  }

  // A gate refusal is a result, never a throw: if the staged dir cannot be
  // written (missing parent, a file where a dir should be, disk full, …),
  // stage() must report it, not crash whatever called it.
  _writeStagedSafe(nonce, envelope) {
    try {
      this._writeStaged(nonce, envelope);
      return true;
    } catch (err) {
      log.error(`failed to stage ${nonce}: ${err.message}`);
      return false;
    }
  }
}

module.exports = {
  ApproverStore, checkApproverRecord, checkApproverDir, checkWindowsOwners, readWindowsOwners, writeFileAtomic, APPROVER_CONTROLS, FUTURE_SKEW_MS
};
