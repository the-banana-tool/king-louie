const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMasterKey, MASTER_KEY_CREDENTIAL, KEY_CHECK_FILE } = require('../src/platform/master-key');
const { windowsPowerShellExe } = require('../src/platform/windows-paths');
const { addSink } = require('../src/logging');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mk-')); createdTempDirs.push(d); return d; };

describe('resolveMasterKey', () => {
  it('prefers a systemd credential', () => {
    const credDir = tmp();
    const hex = 'ab'.repeat(32);
    fs.writeFileSync(path.join(credDir, MASTER_KEY_CREDENTIAL), hex);
    const r = resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: { CREDENTIALS_DIRECTORY: credDir } });
    assert.strictEqual(r.source, 'systemd-credential');
    assert.strictEqual(r.key.toString('hex'), hex);
  });

  it('creates then reuses a private key file on posix', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    const a = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    const b = resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    assert.strictEqual(a.source, 'key-file');
    assert.ok(a.key.equals(b.key));
    assert.strictEqual(fs.statSync(path.join(dataDir, 'master.key')).mode & 0o077, 0);
  });

  it('refuses a key file readable by others', { skip: process.platform === 'win32' }, () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'master.key'), 'cd'.repeat(32), { mode: 0o644 });
    fs.chmodSync(path.join(dataDir, 'master.key'), 0o644);
    assert.throws(() => resolveMasterKey({ platform: process.platform, dataDir, env: {} }), /permissions/);
  });

  it('wraps the key with DPAPI on Windows (fake DPAPI)', () => {
    const dataDir = tmp();
    const dpapi = { protect: (b) => Buffer.concat([Buffer.from('P:'), b]), unprotect: (b) => b.subarray(2) };
    const a = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    const b = resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi });
    assert.strictEqual(a.source, 'dpapi');
    assert.ok(a.key.equals(b.key));
    assert.ok(fs.readFileSync(path.join(dataDir, 'master.key.dpapi')).subarray(0, 2).equals(Buffer.from('P:')));
  });

  it('round-trips real DPAPI', { skip: process.platform !== 'win32' }, () => {
    const { createPowerShellDpapi } = require('../src/platform/master-key');
    const dpapi = createPowerShellDpapi();
    const secret = Buffer.from('0123456789abcdef');
    assert.ok(dpapi.unprotect(dpapi.protect(secret)).equals(secret));
  });

  it('protects in the LocalMachine scope, so an elevated admin and LOCAL SERVICE resolve the same key', { skip: process.platform !== 'win32' }, () => {
    const { createPowerShellDpapi } = require('../src/platform/master-key');
    const blob = createPowerShellDpapi().protect(Buffer.from('0123456789abcdef'));
    // DPAPI blob: version(4) provider(16) mkVersion(4) mkGuid(16) flags(4);
    // CRYPTPROTECT_LOCAL_MACHINE = 0x4.
    assert.strictEqual(blob.readUInt32LE(40) & 0x4, 0x4);
  });

  it('runs PowerShell by the path it is given (an absolute System32 path by default)', () => {
    const { createPowerShellDpapi } = require('../src/platform/master-key');
    const missing = path.join(tmp(), 'no-such-powershell.exe');
    assert.throws(() => createPowerShellDpapi({ powershellExe: missing }).protect(Buffer.from('x')), /ENOENT/);
    assert.strictEqual(windowsPowerShellExe({ SystemRoot: 'D:\\WinNT' }), 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.strictEqual(windowsPowerShellExe({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.strictEqual(windowsPowerShellExe({ SystemRoot: 'Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('master key check', () => {
  const fakeDpapi = { protect: (b) => Buffer.concat([Buffer.from('P:'), b]), unprotect: (b) => b.subarray(2) };

  it('writes key-check on the first resolution and accepts the same key afterwards', () => {
    const dataDir = tmp();
    const credDir = tmp();
    fs.writeFileSync(path.join(credDir, MASTER_KEY_CREDENTIAL), 'ab'.repeat(32));
    const env = { CREDENTIALS_DIRECTORY: credDir };
    resolveMasterKey({ platform: 'linux', dataDir, env });
    const check = fs.readFileSync(path.join(dataDir, KEY_CHECK_FILE), 'utf8');
    assert.match(check, /^klc1:/);
    assert.ok(!check.includes('king-louie-key-check'), 'key-check holds ciphertext, not the constant');
    resolveMasterKey({ platform: 'linux', dataDir, env });
    assert.strictEqual(fs.readFileSync(path.join(dataDir, KEY_CHECK_FILE), 'utf8'), check, 'not rewritten');
  });

  it('refuses, naming the key source, when the resolved key differs from the data dir key', () => {
    const dataDir = tmp();
    const credA = tmp();
    const credB = tmp();
    fs.writeFileSync(path.join(credA, MASTER_KEY_CREDENTIAL), 'ab'.repeat(32));
    fs.writeFileSync(path.join(credB, MASTER_KEY_CREDENTIAL), 'cd'.repeat(32));
    resolveMasterKey({ platform: 'linux', dataDir, env: { CREDENTIALS_DIRECTORY: credA } });
    assert.throws(
      () => resolveMasterKey({ platform: 'linux', dataDir, env: { CREDENTIALS_DIRECTORY: credB } }),
      /encrypted with a different master key.*source systemd-credential.*service account.*README/
    );
  });

  it('refuses a data dir whose DPAPI-wrapped key was replaced (e.g. minted under another identity)', () => {
    const dataDir = tmp();
    resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi: fakeDpapi });
    fs.writeFileSync(path.join(dataDir, 'master.key.dpapi'), fakeDpapi.protect(Buffer.alloc(32, 7)));
    assert.throws(() => resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi: fakeDpapi }), /different master key.*source dpapi/);
  });

  it('refuses a corrupt key-check file', () => {
    const dataDir = tmp();
    resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi: fakeDpapi });
    fs.writeFileSync(path.join(dataDir, KEY_CHECK_FILE), 'garbage');
    assert.throws(() => resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi: fakeDpapi }), /different master key/);
  });
});

describe('root reading the systemd credential file on Linux', () => {
  function credFile(hex, mode) {
    const file = path.join(tmp(), MASTER_KEY_CREDENTIAL);
    fs.writeFileSync(file, hex);
    if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(file, mode);
    return file;
  }

  it('uses the root-only credential file when root runs without CREDENTIALS_DIRECTORY', () => {
    const dataDir = tmp();
    const credentialPath = credFile('ef'.repeat(32));
    const r = resolveMasterKey({ platform: 'linux', dataDir, env: {}, getuid: () => 0, credentialPath });
    assert.strictEqual(r.source, 'credential-file');
    assert.strictEqual(r.key.toString('hex'), 'ef'.repeat(32));
    assert.ok(!fs.existsSync(path.join(dataDir, 'master.key')), 'no second key is minted');
  });

  it('matches the key the unit hands the service, so the key check passes for both', () => {
    const dataDir = tmp();
    const hex = '12'.repeat(32);
    const credDir = tmp();
    fs.writeFileSync(path.join(credDir, MASTER_KEY_CREDENTIAL), hex);
    resolveMasterKey({ platform: 'linux', dataDir, env: { CREDENTIALS_DIRECTORY: credDir }, getuid: () => 990 });
    const r = resolveMasterKey({ platform: 'linux', dataDir, env: {}, getuid: () => 0, credentialPath: credFile(hex) });
    assert.strictEqual(r.source, 'credential-file');
  });

  it('falls back to a key file when there is no credential and no place to put one', { skip: process.platform === 'win32' }, () => {
    assert.strictEqual(
      resolveMasterKey({
        platform: 'linux',
        dataDir: tmp(),
        env: {},
        getuid: () => 0,
        credentialPath: path.join(tmp(), 'no-such-dir', MASTER_KEY_CREDENTIAL)
      }).source,
      'key-file'
    );
  });

  // The credential is no longer root-and-Linux-only: it is where every POSIX
  // host without a systemd credential keeps its key, so a non-root service
  // account reads it too (the installer chowns it to that account inside a
  // root-owned directory). What is still refused is a key anyone can read.
  it('is read on darwin and by a non-root account, and refused when it is group- or world-readable', { skip: process.platform === 'win32' }, () => {
    const credentialPath = credFile('ef'.repeat(32), 0o600);
    assert.strictEqual(resolveMasterKey({ platform: 'darwin', dataDir: tmp(), env: {}, getuid: () => 501, credentialPath }).source, 'credential-file');
    assert.strictEqual(resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: {}, getuid: () => 1000, credentialPath }).source, 'credential-file');
    assert.throws(
      () => resolveMasterKey({ platform: 'darwin', dataDir: tmp(), env: {}, getuid: () => 501, credentialPath: credFile('ef'.repeat(32), 0o644) }),
      /permissions 644/
    );
  });

  it('is ignored for a non-root user (platform-independent check)', () => {
    const credentialPath = credFile('ef'.repeat(32));
    const r = resolveMasterKey({ platform: 'win32', dataDir: tmp(), env: {}, getuid: () => 0, credentialPath, dpapi: { protect: (b) => b, unprotect: (b) => b } });
    assert.strictEqual(r.source, 'dpapi');
  });
});

// At-rest encryption buys nothing when the key sits inside the directory it
// protects: a Time Machine backup, a snapshot or a `tar` of the data dir
// carries both halves. macOS (and Linux without systemd credentials) did
// exactly that. The key belongs in the admin-owned config dir the installers
// create, which the service account can read but not replace.
describe('the master key lives outside the directory it protects', () => {
  const posixOnly = process.platform === 'win32' ? 'POSIX-only (needs 0600 mode bits)' : false;
  const credIn = (dir) => {
    const credDir = path.join(dir, 'config', 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    return path.join(credDir, MASTER_KEY_CREDENTIAL);
  };

  it('mints the key in the admin credentials dir when one exists', { skip: posixOnly }, () => {
    const base = tmp();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir);
    const credentialPath = credIn(base);

    const r = resolveMasterKey({ platform: 'darwin', dataDir, env: {}, getuid: () => 0, credentialPath });

    assert.strictEqual(r.source, 'credential-file');
    assert.ok(fs.existsSync(credentialPath), 'the key must be written outside the data dir');
    assert.strictEqual(fs.statSync(credentialPath).mode & 0o077, 0);
    assert.ok(!fs.existsSync(path.join(dataDir, 'master.key')), 'nothing may put a key back in the data dir');
    // ...and the same key comes back next time.
    const again = resolveMasterKey({ platform: 'darwin', dataDir, env: {}, getuid: () => 0, credentialPath });
    assert.ok(r.key.equals(again.key));
  });

  it('falls back to the data dir, loudly, when there is no admin credentials dir', { skip: posixOnly }, () => {
    const base = tmp();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir);
    const credentialPath = path.join(base, 'config', 'credentials', MASTER_KEY_CREDENTIAL);

    const r = resolveMasterKey({ platform: 'darwin', dataDir, env: {}, getuid: () => 0, credentialPath });

    assert.strictEqual(r.source, 'key-file');
    assert.ok(fs.existsSync(path.join(dataDir, 'master.key')));
  });

  it('keeps using a key already in the data dir, and says how to move it', { skip: posixOnly }, () => {
    const base = tmp();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir);
    const legacy = path.join(dataDir, 'master.key');
    fs.writeFileSync(legacy, 'ab'.repeat(32), { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    const credentialPath = credIn(base);

    const warnings = [];
    const remove = addSink((rec) => { if (rec.level === 'warn') warnings.push(rec.message); });
    let r;
    try {
      r = resolveMasterKey({ platform: 'darwin', dataDir, env: {}, getuid: () => 0, credentialPath });
    } finally {
      remove();
    }

    assert.strictEqual(r.key.toString('hex'), 'ab'.repeat(32), 'an existing data dir must keep working');
    assert.ok(!fs.existsSync(credentialPath), 'it must not silently mint a second key');
    assert.ok(
      warnings.some((m) => m.includes(credentialPath) && m.includes(legacy)),
      `expected a warning naming both locations, got ${JSON.stringify(warnings)}`
    );
  });
});

// The 'wx' creates below are already the right primitive — they refuse to
// follow a symlink and refuse an existing file. What was still wrong is the
// *path-based* chmod right after each one: as root, inside a data dir the
// service account owns, that re-opens the name and can be raced (unlink +
// symlink between the write and the chmod) into chmodding another file.
describe('master key files: mode is pinned on the descriptor, never by path', () => {
  const fakeDpapi = { protect: (b) => Buffer.concat([Buffer.from('P:'), b]), unprotect: (b) => b.subarray(2) };

  it('never calls a path-based chmod when minting the key file and key-check', { skip: process.platform === 'win32' ? 'POSIX-only (Windows has no mode bits to pin)' : false }, (t) => {
    const dataDir = tmp();
    t.mock.method(fs, 'chmodSync');
    t.mock.method(fs, 'fchmodSync');
    resolveMasterKey({ platform: process.platform, dataDir, env: {} });
    assert.deepStrictEqual(
      fs.chmodSync.mock.calls.map((c) => c.arguments[0]),
      [],
      'no path-based chmod may run inside a service-account-owned data dir'
    );
    assert.ok(fs.fchmodSync.mock.calls.length >= 2, 'master.key and key-check must each be pinned via their descriptor');
    assert.strictEqual(fs.statSync(path.join(dataDir, 'master.key')).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(dataDir, KEY_CHECK_FILE)).mode & 0o777, 0o600);
  });

  it('never calls a path-based chmod when minting key-check on Windows', { skip: process.platform === 'win32' ? false : 'Windows-only' }, (t) => {
    const dataDir = tmp();
    t.mock.method(fs, 'chmodSync');
    resolveMasterKey({ platform: 'win32', dataDir, env: {}, dpapi: fakeDpapi });
    assert.deepStrictEqual(fs.chmodSync.mock.calls.map((c) => c.arguments[0]), []);
  });
});
