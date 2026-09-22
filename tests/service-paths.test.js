const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultServiceDataDir, ensureServicePaths } = require('../src/platform/paths');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-paths-')); createdTempDirs.push(d); return d; };

const posixOnly = process.platform === 'win32' ? 'POSIX-only (needs symlinks and real mode bits)' : false;

describe('service paths', () => {
  it('uses OS-appropriate system locations', () => {
    assert.strictEqual(defaultServiceDataDir({ platform: 'linux', env: {} }), '/var/lib/king-louie');
    assert.strictEqual(defaultServiceDataDir({ platform: 'darwin', env: {} }), '/Library/Application Support/KingLouie/data');
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }), 'D:\\PD\\KingLouie\\data');
    assert.strictEqual(defaultServiceDataDir({ platform: 'win32', env: {} }), 'C:\\ProgramData\\KingLouie\\data');
  });

  it('creates private data, logs and cache dirs', () => {
    const base = path.join(tmp(), 'data');
    const p = ensureServicePaths(base);
    for (const d of [p.dataDir, p.logsDir, p.cacheDir]) assert.ok(fs.statSync(d).isDirectory());
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p.dataDir).mode & 0o077, 0);
  });
});

// ensureServicePaths runs as root from the admin CLI (`token set`/`vault set`),
// and logs/ and cache/ live inside a data dir the service account owns. A
// recursive mkdir sees a symlink-to-a-directory as "already there" and does
// not throw; a path-based chmod then follows it, so root would apply 0700 to
// whatever the service account pointed it at (`chmod 0700 /etc` locks every
// other account out of the machine).
describe('ensureServicePaths: hostile data dir', () => {
  it('refuses a data dir that is a symlink', { skip: posixOnly }, () => {
    const base = tmp();
    const target = path.join(base, 'target');
    fs.mkdirSync(target, { mode: 0o755 });
    const link = path.join(base, 'data');
    fs.symlinkSync(target, link);
    assert.throws(() => ensureServicePaths(link), /symlink/i);
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o755, 'the symlink target must not be chmodded');
  });

  it('refuses a logs dir that has been replaced by a symlink', { skip: posixOnly }, () => {
    const base = tmp();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const target = path.join(base, 'etc');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.symlinkSync(target, path.join(dataDir, 'logs'));
    assert.throws(() => ensureServicePaths(dataDir), /symlink/i);
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o755, 'the symlink target must not be chmodded');
  });

  it('still pins an existing, non-symlinked dir to 0700', { skip: posixOnly }, () => {
    const dataDir = path.join(tmp(), 'data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dataDir, 0o755);
    const p = ensureServicePaths(dataDir);
    for (const d of [p.dataDir, p.logsDir, p.cacheDir]) {
      assert.strictEqual(fs.lstatSync(d).mode & 0o777, 0o700, d);
    }
  });
});
