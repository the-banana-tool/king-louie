const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { defaultServiceDataDir, ensureServicePaths, ensurePrivateDir } = require('../src/platform/paths');

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

  // Copilot review comment C5 (PR #28): only the final component was checked.
  // `mkdirSync(..., { recursive: true })` follows a symlinked *ancestor*
  // without complaint, so `--data-dir /tmp/kl/data` with a planted
  // `/tmp/kl -> …` had a root-run `token set` create the data dir — and the
  // master key, key-check, gateway token and stores inside it — under a
  // directory of someone else's choosing, then chmod 0700 through it.
  // Only root can hand a symlink to a third uid, so this one runs in a
  // privileged container (or a root CI job) and reports itself skipped
  // anywhere else.
  const canPlantForeignLink = (() => {
    if (process.platform === 'win32') return 'POSIX-only';
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
      return 'needs root to create a symlink owned by a third uid';
    }
    return false;
  })();

  it('refuses a data dir reached through a symlinked ancestor someone else owns', { skip: canPlantForeignLink }, () => {
    const base = tmp();
    const attacker = path.join(base, 'attacker');
    fs.mkdirSync(attacker, { mode: 0o755 });
    const planted = path.join(base, 'kl');
    fs.symlinkSync(attacker, planted);
    fs.lchownSync(planted, 65533, 65533);

    assert.throws(() => ensureServicePaths(path.join(planted, 'data')), /symlink owned by uid/i);
    assert.ok(!fs.existsSync(path.join(attacker, 'data')), 'nothing may be created behind the link');
  });

  it('allows a symlinked ancestor this process itself owns (macOS /var, /tmp)', { skip: posixOnly }, () => {
    const base = tmp();
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { mode: 0o755 });
    const link = path.join(base, 'via');
    fs.symlinkSync(real, link);
    const p = ensureServicePaths(path.join(link, 'data'));
    assert.ok(fs.statSync(p.dataDir).isDirectory());
    assert.strictEqual(fs.lstatSync(path.join(real, 'data')).mode & 0o777, 0o700);
  });

  it('refuses a data dir whose ancestor is a file', () => {
    const base = tmp();
    const notADir = path.join(base, 'kl');
    fs.writeFileSync(notADir, 'x');
    assert.throws(() => ensureServicePaths(path.join(notADir, 'data')), /not a directory/i);
  });

  // Windows junctions are reparse points that lstat reports as symbolic links
  // and that mkdirSync follows just as happily; the old code returned from
  // ensurePrivateDir before any check at all on win32.
  it('refuses a data dir reached through a Windows junction', { skip: process.platform === 'win32' ? false : 'Windows-only' }, () => {
    const base = tmp();
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const junction = path.join(base, 'kl');
    cp.execFileSync('cmd', ['/c', 'mklink', '/J', junction, target], { windowsHide: true });
    assert.throws(() => ensurePrivateDir(path.join(junction, 'data')), /junction or symlink/i);
    assert.ok(!fs.existsSync(path.join(target, 'data')), 'nothing may be created behind the junction');
  });

  it('refuses a data dir that is itself a Windows junction', { skip: process.platform === 'win32' ? false : 'Windows-only' }, () => {
    const base = tmp();
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const junction = path.join(base, 'data');
    cp.execFileSync('cmd', ['/c', 'mklink', '/J', junction, target], { windowsHide: true });
    assert.throws(() => ensurePrivateDir(junction), /symlink|junction/i);
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
