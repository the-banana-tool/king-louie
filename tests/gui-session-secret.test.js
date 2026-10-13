// tests/gui-session-secret.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/gui/session-secret');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { windowsIcaclsExe } = require('../src/platform/windows-paths');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const cipher = createAesGcmCipher(crypto.randomBytes(32));

function tempConfig() {
  // Native realpath: assertSafeComponents requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-session-secret-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  return { base, config };
}

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('mint and the canonical copy', () => {
  it('mints 32 random bytes and a 16-byte endpoint id, fresh every time', () => {
    const a = S.mintSessionSecret();
    const b = S.mintSessionSecret();
    assert.equal(a.secret.length, 32);
    assert.match(a.endpointId, /^[0-9a-f]{32}$/);
    assert.notEqual(a.endpointId, b.endpointId);
    assert.ok(!a.secret.equals(b.secret));
  });

  it('writes the secret as klc1: ciphertext and reads it back', () => {
    const { config } = tempConfig();
    const { secret, endpointId } = S.mintSessionSecret();
    S.writeCanonical({ configDir: config, cipher, secret, endpointId, nodeId: 'kl-hnef32472qzibi5r', sessionUser: 'alice', svcGid: POSIX ? GID : null });
    const raw = JSON.parse(fs.readFileSync(S.canonicalPath(config), 'utf8'));
    assert.match(raw.secret, /^klc1:/);
    assert.deepEqual(Object.keys(raw).sort(), ['endpoint_id', 'node_id', 'rotated_at', 'secret', 'session_sid', 'session_uid', 'session_user', 'v']);
    if (POSIX) assert.equal(fs.statSync(S.canonicalPath(config)).mode & 0o777, 0o640);
    const read = S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID });
    assert.ok(read.secret.equals(secret));
    assert.equal(read.endpointId, endpointId);
    assert.equal(read.sessionUser, 'alice');
    assert.ok(read.mtimeMs > 0);
    assert.equal(S.canonicalMtime(config), read.mtimeMs);
  });

  it('a missing canonical file is session_not_installed', () => {
    const { config } = tempConfig();
    assert.equal(code(() => S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID })), 'session_not_installed');
    assert.equal(S.canonicalMtime(config), null);
  });
});

describe('per-user copies', () => {
  const content = { v: 1, node_id: 'kl-hnef32472qzibi5r', endpoint: '/tmp/x.sock', secret: 'ab'.repeat(32), rotated_at: '2026-09-23T18:00:00.000Z' };

  it('the path lives in the admin-owned config dir', () => {
    assert.equal(S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: 'alice' }), '/etc/king-louie/session/users/alice.json');
    assert.equal(S.userCopyPath({ platform: 'win32', configDir: 'C:\\ProgramData\\KingLouie\\config', sid: 'S-1-5-21-1-2-3-1001' }),
      'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json');
    assert.equal(code(() => S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: '../root' })), 'invalid_params');
    assert.equal(code(() => S.userCopyPath({ platform: 'win32', configDir: 'C:\\x', sid: 'S-1-5-21-1..\\x' })), 'invalid_params');
  });

  it('POSIX: 0600, owned by the user, in a root-owned 0755 dir; readable back', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, UID);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(config, 'session')).mode & 0o777, 0o755, 'Deviation 10');
    const read = S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID });
    assert.equal(read.nodeId, content.node_id);
    assert.equal(read.secret.toString('hex'), content.secret);
    // A second write replaces the file (unlink + O_EXCL), never opens it for write.
    S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content: { ...content, endpoint: '/tmp/y.sock' } });
    assert.equal(S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID }).endpoint, '/tmp/y.sock');
  });

  it('POSIX: session_file_insecure for a loose mode, another owner or a non-root dir', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    fs.chmodSync(file, 0o644);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_file_insecure');
    fs.chmodSync(file, 0o600);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID + 1, rootUid: UID })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID + 1 })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: path.join(config, 'nope.json'), platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_not_installed');
  });

  it('a hostile symlink at the file or at a parent refuses unsafe_path and leaves the target untouched', { skip: !POSIX }, () => {
    const { base, config } = tempConfig();
    const target = path.join(base, 'target.txt');
    fs.writeFileSync(target, 'original');
    fs.mkdirSync(path.join(config, 'session', 'users'), { recursive: true, mode: 0o755 });
    fs.symlinkSync(target, path.join(config, 'session', 'users', 'alice.json'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const { base: base2, config: config2 } = tempConfig();
    const elsewhere = path.join(base2, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config2, 'session'), { mode: 0o755 });
    fs.symlinkSync(elsewhere, path.join(config2, 'session', 'users'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config2, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('a junction at a parent component refuses unsafe_path on Windows', { skip: POSIX }, () => {
    const { base, config } = tempConfig();
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config, 'session'));
    fs.symlinkSync(elsewhere, path.join(config, 'session', 'users'), 'junction');
    assert.equal(code(() => S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: () => {} })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('Linux: a config dir reached through a link that differs only by case is refused', { skip: process.platform !== 'linux' }, () => {
    const { base, config } = tempConfig();
    const alias = path.join(base, 'Config');
    fs.symlinkSync(config, alias);
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: alias, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.equal(fs.existsSync(path.join(config, 'session')), false, 'nothing was written through the link');
  });

  it('Windows: the ACL command line uses the absolute icacls.exe and the SID', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    assert.equal(windowsIcaclsExe(env), 'C:\\Windows\\System32\\icacls.exe');
    assert.deepEqual(S.windowsUserAclArgs('C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json', 'S-1-5-21-1-2-3-1001', env), [
      'C:\\Windows\\System32\\icacls.exe', 'C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json',
      '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(R)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
    ]);
  });

  it('Windows: writing a copy runs icacls once on that file', { skip: POSIX }, () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const calls = [];
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: (argv) => calls.push(argv), env });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], file);
  });
});

describe('endpoint', () => {
  it('names the pipe or the socket; socket paths fit in 104 bytes', () => {
    const id = 'a'.repeat(32);
    assert.equal(S.endpointPath({ platform: 'win32', endpointId: id }), `\\\\.\\pipe\\king-louie-session-${id}`);
    for (const platform of ['linux', 'darwin']) {
      const p = S.endpointPath({ platform, endpointId: id });
      assert.ok(p.startsWith(S.sessionIpcDir(platform)));
      assert.ok(Buffer.byteLength(p) <= 104, p);
    }
    assert.equal(code(() => S.endpointPath({ platform: 'linux', endpointId: '../x' })), 'invalid_params');
  });
});

describe('resolveSessionUser', () => {
  it('POSIX: id and getent, the name never in a shell', () => {
    const calls = [];
    const execFile = (file, argv) => {
      calls.push([file, ...argv]);
      if (file === '/usr/bin/id') return argv[0] === '-u' ? '1001\n' : '1001\n';
      if (file === '/usr/bin/getent') return 'alice:x:1001:1001:Alice:/home/alice:/bin/bash\n';
      throw new Error('unexpected');
    };
    const exists = (p) => p === '/home/alice';
    assert.deepEqual(S.resolveSessionUser('alice', { platform: 'linux', execFile, exists }), { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice', sid: null });
    assert.deepEqual(calls[0], ['/usr/bin/id', '-u', 'alice']);
  });

  it('macOS reads the home with dscl', () => {
    const execFile = (file) => (file === '/usr/bin/dscl' ? 'NFSHomeDirectory: /Users/alice\n' : '501\n');
    assert.equal(S.resolveSessionUser('alice', { platform: 'darwin', execFile, exists: () => true }).home, '/Users/alice');
  });

  it('Windows: the SID through PowerShell with the name in an environment variable', () => {
    let seen;
    const execFile = (file, argv, options) => { seen = { file, argv, env: options.env }; return 'S-1-5-21-1-2-3-1001\r\n'; };
    const r = S.resolveSessionUser('alice', { platform: 'win32', execFile, env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(r.sid, 'S-1-5-21-1-2-3-1001');
    assert.ok(seen.file.endsWith('powershell.exe'));
    assert.ok(!seen.argv.join(' ').includes('alice'), 'the name is never interpolated');
    assert.equal(seen.env.KL_SESSION_USER, 'alice');
  });

  it('unknown user, missing home and a hostile name', () => {
    const fail = () => { throw Object.assign(new Error('no such user'), { status: 1 }); };
    assert.equal(code(() => S.resolveSessionUser('ghost', { platform: 'linux', execFile: fail })), 'user_not_found');
    const noHome = (file) => (file === '/usr/bin/getent' ? 'alice:x:1001:1001::/nonexistent-kl:/bin/sh\n' : '1001\n');
    assert.equal(code(() => S.resolveSessionUser('alice', { platform: 'linux', execFile: noHome, exists: () => false })), 'home_missing');
    assert.equal(code(() => S.resolveSessionUser('-rf', { platform: 'linux', execFile: fail })), 'invalid_params');
  });
});
