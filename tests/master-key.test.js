const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMasterKey, MASTER_KEY_CREDENTIAL, KEY_CHECK_FILE } = require('../src/platform/master-key');
const { windowsPowerShellExe } = require('../src/platform/windows-paths');

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
  function credFile(hex) {
    const file = path.join(tmp(), MASTER_KEY_CREDENTIAL);
    fs.writeFileSync(file, hex);
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

  it('is ignored for a non-root user, on other platforms, and when the file is absent', { skip: process.platform === 'win32' }, () => {
    const credentialPath = credFile('ef'.repeat(32));
    assert.strictEqual(resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: {}, getuid: () => 1000, credentialPath }).source, 'key-file');
    assert.strictEqual(resolveMasterKey({ platform: 'darwin', dataDir: tmp(), env: {}, getuid: () => 0, credentialPath }).source, 'key-file');
    assert.strictEqual(resolveMasterKey({ platform: 'linux', dataDir: tmp(), env: {}, getuid: () => 0, credentialPath: path.join(tmp(), 'absent') }).source, 'key-file');
  });

  it('is ignored for a non-root user (platform-independent check)', () => {
    const credentialPath = credFile('ef'.repeat(32));
    const r = resolveMasterKey({ platform: 'win32', dataDir: tmp(), env: {}, getuid: () => 0, credentialPath, dpapi: { protect: (b) => b, unprotect: (b) => b } });
    assert.strictEqual(r.source, 'dpapi');
  });
});
