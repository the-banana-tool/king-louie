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

  // Security review finding 3: the secret is never in a file whose ACL is
  // still the inherited one.
  it('Windows: the copy is created empty, narrowed and given to Administrators, and only then written', { skip: POSIX }, () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const calls = [];
    const { config } = tempConfig();
    const file = S.writeUserCopy({
      platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, env,
      runIcacls: (argv) => calls.push({ argv, bytes: fs.existsSync(argv[1]) && fs.statSync(argv[1]).isFile() ? fs.readFileSync(argv[1]).length : null })
    });
    // Second-review finding 1: the directory first (the user's right to
    // read its owner and attributes, and its owner), then the file.
    assert.equal(calls.length, 4);
    const dir = path.dirname(file);
    assert.deepEqual(calls[0].argv, S.windowsUsersDirAclArgs(dir, 'S-1-5-21-1-2-3-1001', env));
    assert.deepEqual(calls[1].argv, ['C:\\Windows\\System32\\icacls.exe', dir, '/setowner', '*S-1-5-32-544']);
    assert.deepEqual(calls[2].argv, S.windowsUserAclArgs(file, 'S-1-5-21-1-2-3-1001', env));
    assert.deepEqual(calls[3].argv, ['C:\\Windows\\System32\\icacls.exe', file, '/setowner', '*S-1-5-32-544']);
    assert.deepEqual(calls.map((c) => c.bytes), [null, null, 0, 0], 'the file was not there, then held nothing, while the ACLs were being set');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), content);
  });

  // Second-review finding 1: the helper runs as the session user, and the
  // users directory inherits the config dir's protected ACL (SYSTEM,
  // Administrators, LOCAL SERVICE), so that user could not read who owns it.
  it('Windows: the users directory gives the session user read-control, read-attributes and synchronize on itself, and nothing else', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const sid = 'S-1-5-21-1-2-3-1001';
    // No (OI) or (CI): the entry is for the directory alone and no child
    // inherits it. RC, RA and S (which every open asks for) only: the user
    // can neither list nor write it.
    assert.deepEqual(S.windowsUsersDirAclArgs('C:\\cfg\\session\\users', sid, env),
      ['C:\\Windows\\System32\\icacls.exe', 'C:\\cfg\\session\\users', '/grant:r', `*${sid}:(RC,S,RA)`]);
    assert.deepEqual(S.windowsUsersDirRevokeArgs('C:\\cfg\\session\\users', sid, env),
      ['C:\\Windows\\System32\\icacls.exe', 'C:\\cfg\\session\\users', '/remove:g', `*${sid}`]);
    assert.throws(() => S.windowsUsersDirAclArgs('C:\\cfg\\session\\users', 'Everyone', env), (e) => e.code === 'invalid_params');
    assert.throws(() => S.windowsUsersDirRevokeArgs('C:\\cfg\\session\\users', '*S-1-1-0', env), (e) => e.code === 'invalid_params');
  });

  it('Windows: removing the copy takes the user\'s entry off the users directory; a missing directory asks for nothing', { skip: POSIX }, () => {
    const { config } = tempConfig();
    const sid = 'S-1-5-21-1-2-3-1001';
    const file = S.writeUserCopy({ platform: 'win32', configDir: config, sid, content, runIcacls: () => {} });
    const calls = [];
    assert.equal(S.removeUserCopy({ platform: 'win32', configDir: config, sid, runIcacls: (argv) => calls.push(argv) }), true);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(calls, [S.windowsUsersDirRevokeArgs(path.dirname(file), sid)]);
    // Again: no file, the entry is still asked off (a run that failed half way is finished by the next).
    assert.equal(S.removeUserCopy({ platform: 'win32', configDir: config, sid, runIcacls: (argv) => calls.push(argv) }), false);
    assert.equal(calls.length, 2);
    const { config: empty } = tempConfig();
    assert.equal(S.removeUserCopy({ platform: 'win32', configDir: empty, sid, runIcacls: () => { throw new Error('must not run'); } }), false);
  });

  it('Windows: the copy is gone even when the entry cannot be taken off, and the failure is reported', { skip: POSIX }, () => {
    const { config } = tempConfig();
    const sid = 'S-1-5-21-1-2-3-1001';
    const file = S.writeUserCopy({ platform: 'win32', configDir: config, sid, content, runIcacls: () => {} });
    assert.throws(() => S.removeUserCopy({ platform: 'win32', configDir: config, sid, runIcacls: () => { throw new Error('icacls failed'); } }),
      (e) => e.aclNotRemoved === true && e.message.includes('/remove:g'));
    assert.equal(fs.existsSync(file), false);
  });

  it('Windows: if icacls fails the copy is removed and nothing of the secret was written', { skip: POSIX }, () => {
    const { config } = tempConfig();
    const sid = 'S-1-5-21-1-2-3-1001';
    const file = S.userCopyPath({ platform: 'win32', configDir: config, sid });
    // Calls 1 and 2 are the directory's (before the file exists), 3 and 4 the file's.
    for (const failAt of [1, 2, 3, 4]) {
      let n = 0;
      let seen = null;
      assert.throws(() => S.writeUserCopy({
        platform: 'win32', configDir: config, sid, content,
        runIcacls: () => { n += 1; if (n === failAt) { seen = fs.existsSync(file) ? fs.readFileSync(file).length : null; throw new Error('icacls failed'); } }
      }), /icacls failed/);
      assert.equal(seen, failAt <= 2 ? null : 0);
      assert.equal(fs.existsSync(file), false, `no copy after icacls call ${failAt} failed`);
    }
    // An older copy is gone too: it is never left in place under a failed rotation.
    S.writeUserCopy({ platform: 'win32', configDir: config, sid, content, runIcacls: () => {} });
    assert.throws(() => S.writeUserCopy({ platform: 'win32', configDir: config, sid, content, runIcacls: () => { throw new Error('icacls failed'); } }));
    assert.equal(fs.existsSync(file), false);
  });

  describe('checkUserCopyTrust (Windows owners, through an injected inspector)', () => {
    const FILE = 'C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json';
    const DIR = 'C:\\cfg\\session\\users';
    const ADMINS = 'S-1-5-32-544';
    const SYSTEM = 'S-1-5-18';
    const ME = 'S-1-5-21-1-2-3-1001';
    const inspector = (entries, seen = []) => async (paths) => { seen.push(paths); return { me: ME, entries }; };
    const trust = (entries, extra = {}) => S.checkUserCopyTrust({ path: FILE, platform: 'win32', inspectOwners: inspector(entries), ...extra });
    const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

    it('asks for the directory and the file, and accepts Administrators or SYSTEM as owner of both', async () => {
      const seen = [];
      await S.checkUserCopyTrust({ path: FILE, platform: 'win32', inspectOwners: inspector([{ owner: ADMINS, link: false }, { owner: SYSTEM, link: false }], seen) });
      assert.deepEqual(seen, [[DIR, FILE]]);
    });

    it('refuses a file or a directory owned by anyone else, a link, and a file that is not there', async () => {
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: false }, { owner: ME, link: false }])), 'session_file_insecure', 'the user owns the file');
      assert.equal(await codeOf(trust([{ owner: 'S-1-5-21-9-9-9-2001', link: false }, { owner: ADMINS, link: false }])), 'session_file_insecure', 'someone owns the directory');
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: true }, { owner: ADMINS, link: false }])), 'session_file_insecure');
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: false }, { owner: ADMINS, link: true }])), 'session_file_insecure');
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: false }, null])), 'session_not_installed');
      assert.equal(await codeOf(trust([null, null])), 'session_not_installed');
    });

    it('no evidence is not trust: an inspector that fails or answers short is refused', async () => {
      assert.equal(await codeOf(S.checkUserCopyTrust({ path: FILE, platform: 'win32', inspectOwners: async () => { throw new Error('powershell failed'); } })), 'session_file_insecure');
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: false }])), 'session_file_insecure');
      assert.equal(await codeOf(S.checkUserCopyTrust({ path: FILE, platform: 'win32', inspectOwners: async () => null })), 'session_file_insecure');
      assert.equal(await codeOf(trust([{ owner: ADMINS, link: false }, { link: false }])), 'session_file_insecure');
    });

    it('the current user as owner is accepted only when a test says so', async () => {
      const mine = [{ owner: ME, link: false }, { owner: ME, link: false }];
      assert.equal(await codeOf(trust(mine)), 'session_file_insecure');
      assert.equal(await codeOf(trust(mine, { alsoTrustCurrentUser: true })), null);
      assert.equal(await codeOf(trust([{ owner: 'S-1-5-21-9-9-9-2001', link: false }, { owner: ME, link: false }], { alsoTrustCurrentUser: true })), 'session_file_insecure');
    });

    it('off Windows nothing is inspected: readUserCopy checks uid and modes itself', async () => {
      let called = 0;
      await S.checkUserCopyTrust({ path: '/etc/kl/session/users/alice.json', platform: 'linux', inspectOwners: async () => { called += 1; return null; } });
      assert.equal(called, 0);
    });
  });

  // Second-review finding 1, with nothing injected: the real inspector (a
  // Windows PowerShell child) against a temp directory whose ACL is the one
  // a real install leaves, as far as an unelevated test can build it. The
  // users directory admits SYSTEM and Administrators only, as it does when
  // it inherits the config dir's protected ACL. This process owns the temp
  // directory, and an owner may always read an object's security
  // descriptor, so an OWNER RIGHTS entry takes that away: write-DAC only,
  // which is also what lets the test undo it. icacls cannot read such a
  // directory either, so the lock is lifted with one blind DACL write.
  describe('checkUserCopyTrust for real (Windows: icacls on a temp dir, nothing injected)', { skip: POSIX }, () => {
    const { execFileSync } = require('child_process');
    const { windowsPowerShellExe } = require('../src/platform/windows-paths');
    const { windowsPowerShellEnv } = require('./helpers/windows-powershell-env');
    const icacls = (argv) => execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
    const LIFT = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class KlTestAcl {',
      '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
      '  public static extern bool SetFileSecurityW(string name, uint info, byte[] sd);',
      '}',
      "'@",
      '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      '$sd = New-Object System.Security.AccessControl.RawSecurityDescriptor("D:P(A;;FA;;;OW)")',
      '$bytes = New-Object byte[] $sd.BinaryLength',
      '$sd.GetBinaryForm($bytes, 0)',
      // DACL_SECURITY_INFORMATION; needs write-DAC only.
      'if (-not [KlTestAcl]::SetFileSecurityW($env:KL_TEST_ACL_DIR, 4, $bytes)) { throw "SetFileSecurityW failed" }',
      '[Console]::Out.WriteLine($me)'
    ].join('\n');
    // Gives the owner (this user) full control again, through OWNER RIGHTS so
    // that no entry names this user's own SID; answers with that SID.
    const lift = (dir) => execFileSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', LIFT], {
      env: windowsPowerShellEnv({ KL_TEST_ACL_DIR: dir }), encoding: 'utf8', windowsHide: true
    }).trim();
    // What the users directory looks like to a session user on a real
    // install: no inherited entry, SYSTEM and Administrators only. /grant:r
    // replaces only the entries of the SIDs it names, so an entry the
    // product gave this user stays.
    const lock = (dir) => icacls([windowsIcaclsExe(), dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)', '*S-1-3-4:(WDAC)']);
    const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

    function build() {
      const { config } = tempConfig();
      const dir = path.join(config, 'session', 'users');
      fs.mkdirSync(dir, { recursive: true });
      const me = lift(dir);
      assert.match(me, /^S-1-5-/);
      // Registered before anything locks it, and runs before tempConfig's own removal.
      cleanups.unshift(() => { try { lift(dir); } catch { /* removed already */ } });
      const file = path.join(dir, `${me}.json`);
      fs.writeFileSync(file, `${JSON.stringify(content)}\n`);
      // The file's own ACL, as install sets it: this user reads it.
      icacls(S.windowsUserAclArgs(file, me));
      return { dir, file, me };
    }

    it('proves the finding: without the entry the session user cannot read who owns the directory, and the helper would exit', async () => {
      const { dir, file } = build();
      lock(dir);
      try {
        assert.equal(await codeOf(S.checkUserCopyTrust({ path: file, alsoTrustCurrentUser: true })), 'session_file_insecure');
      } finally {
        lift(dir);
      }
    });

    it('with the entry install adds, the same check passes, and the user can still neither list nor write the directory', async () => {
      const { dir, file, me } = build();
      icacls(S.windowsUsersDirAclArgs(dir, me));
      lock(dir);
      try {
        // This user owns the temp directory (an unelevated test cannot give
        // it to Administrators), so the owner rule is relaxed; the read
        // itself, which is what failed, is the real one.
        assert.equal(await codeOf(S.checkUserCopyTrust({ path: file, alsoTrustCurrentUser: true })), null);
        assert.equal(await codeOf(S.checkUserCopyTrust({ path: file })), 'session_file_insecure', 'still refused when the owner is not SYSTEM or Administrators');
        assert.equal(S.readUserCopy({ path: file, platform: 'win32' }).nodeId, content.node_id);
        assert.throws(() => fs.readdirSync(dir), /EPERM|EACCES/);
        assert.throws(() => fs.writeFileSync(path.join(dir, 'planted.json'), '{}'), /EPERM|EACCES/);
        // Uninstall's command takes the entry off again: the read is refused as before.
        lift(dir);
        icacls(S.windowsUsersDirAclArgs(dir, me));
        icacls(S.windowsUsersDirRevokeArgs(dir, me));
        lock(dir);
        assert.equal(await codeOf(S.checkUserCopyTrust({ path: file, alsoTrustCurrentUser: true })), 'session_file_insecure');
      } finally {
        lift(dir);
      }
    });
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
    const execFile = (file, argv, options) => { seen = { file, argv, env: options.env }; return 'S-1-5-21-1-2-3-1001\r\n1\r\n'; };
    const r = S.resolveSessionUser('alice', { platform: 'win32', execFile, env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(r.sid, 'S-1-5-21-1-2-3-1001');
    assert.ok(seen.file.endsWith('powershell.exe'));
    assert.ok(!seen.argv.join(' ').includes('alice'), 'the name is never interpolated');
    assert.equal(seen.env.KL_SESSION_USER, 'alice');
  });

  // Third security review, finding 4: "session install --user Everyone"
  // would have made the helper's file readable by everyone.
  describe('third review finding 4: only one user account', () => {
    it('classifyWindowsSid: account SIDs, and everything that is a group or a built-in identity', () => {
      for (const sid of ['S-1-5-21-1-2-3-1001', 'S-1-5-21-3623811015-3361044348-30300820-500', 'S-1-12-1-1-2-3-4']) {
        assert.deepEqual(S.classifyWindowsSid(sid), { account: true }, sid);
      }
      const refused = {
        'S-1-1-0': /Everyone/, 'S-1-5-11': /Authenticated Users/, 'S-1-5-18': /SYSTEM/, 'S-1-5-19': /LOCAL SERVICE/, 'S-1-5-20': /NETWORK SERVICE/,
        'S-1-5-4': /Interactive/, 'S-1-5-32-544': /built-in group/, 'S-1-5-32-545': /built-in group/, 'S-1-5-32-555': /built-in group/,
        'S-1-2-0': /well-known/, 'S-1-2-1': /well-known/, 'S-1-3-0': /well-known/, 'S-1-3-4': /well-known/,
        'S-1-5-21-1-2-3-513': /domain group/, 'S-1-5-21-1-2-3-512': /domain group/, 'S-1-5-21-1-2-3-519': /domain group/,
        'S-1-5-21-1-2-3': /not the SID of a user account/, 'S-1-5-21-1-2-3-4-5': /not the SID of a user account/,
        'S-1-5-80-1-2-3-4-5': /not the SID of a user account/, 'S-1-15-2-1': /not the SID of a user account/, 'S-1-16-12288': /not the SID of a user account/,
        'S-1-5-6': /not the SID of a user account/, 'S-1-5-2': /not the SID of a user account/, 'S-1-0-0': /not the SID of a user account/,
        'not-a-sid': /not a SID/
      };
      for (const [sid, what] of Object.entries(refused)) {
        const c = S.classifyWindowsSid(sid);
        assert.equal(c.account, false, sid);
        assert.match(c.what, what, sid);
      }
      assert.deepEqual(S.classifyWindowsSid(null), { account: false, what: 'not a SID' });
    });

    it('Windows: a name that resolves to a group, an alias or a well-known SID is refused by the lookup\'s own type and by the SID', () => {
      const lookup = (sid, use) => () => `${sid}\r\n${use === undefined ? '' : use}\r\n`;
      const resolve = (sid, use, extra = {}) => S.resolveSessionUser('someone', { platform: 'win32', execFile: lookup(sid, use), env: { SystemRoot: 'C:\\Windows' }, ...extra });
      assert.equal(resolve('S-1-5-21-1-2-3-1001', 1).sid, 'S-1-5-21-1-2-3-1001');
      for (const [sid, use] of [['S-1-1-0', 5], ['S-1-5-11', 5], ['S-1-5-18', 5], ['S-1-5-32-544', 4], ['S-1-5-4', 5], ['S-1-5-21-1-2-3-513', 2]]) {
        assert.throws(() => resolve(sid, use), (e) => e.code === 'invalid_params' && /must name one user account/.test(e.message), sid);
      }
      // An account-shaped SID that the lookup calls a group, an alias, a computer, or nothing at all.
      for (const use of [2, 4, 5, 6, 9, undefined]) {
        assert.throws(() => resolve('S-1-5-21-1-2-3-1105', use), (e) => e.code === 'invalid_params' && /must name one user account/.test(e.message), String(use));
      }
      assert.throws(() => resolve('S-1-5-21-1-2-3-1105', 2), /is a group/);
      // A well-known SID that a lookup calls a user is refused by its form.
      assert.throws(() => resolve('S-1-5-18', 1), /SYSTEM/);
      // Uninstall resolves what an older install was made for.
      assert.equal(resolve('S-1-1-0', 5, { singleUser: false }).sid, 'S-1-1-0');
    });

    it('Windows: the lookup is one encoded script, framework types only, and no Security cmdlet', () => {
      let seen;
      S.resolveSessionUser('alice', { platform: 'win32', execFile: (file, argv) => { seen = argv; return 'S-1-5-21-1-2-3-1001\n1\n'; }, env: { SystemRoot: 'C:\\Windows' } });
      assert.equal(seen[seen.length - 2], '-EncodedCommand');
      const script = Buffer.from(seen[seen.length - 1], 'base64').toString('utf16le');
      assert.match(script, /LookupAccountName/);
      assert.ok(!/Get-Acl|Set-Acl|Get-LocalUser|Get-LocalGroup|ConvertFrom-SecureString/i.test(script));
      assert.ok(!script.includes('alice'));
    });

    it('POSIX: root is refused, and a name that is only a group does not resolve', () => {
      const root = (file, argv) => (file === '/usr/bin/id' ? '0\n' : 'root:x:0:0:root:/root:/bin/sh\n');
      assert.throws(() => S.resolveSessionUser('root', { platform: 'linux', execFile: root, exists: () => true }), (e) => e.code === 'invalid_params' && /not root/.test(e.message));
      assert.equal(S.resolveSessionUser('root', { platform: 'linux', execFile: root, exists: () => true, singleUser: false }).uid, 0, 'uninstall still resolves it');
      // id -u fails for a group's name: "no such user".
      const groupOnly = (file, argv) => { if (file === '/usr/bin/id') throw Object.assign(new Error('id: wheel: no such user'), { status: 1 }); return 'wheel:x:10:\n'; };
      assert.equal(code(() => S.resolveSessionUser('wheel', { platform: 'linux', execFile: groupOnly, exists: () => true })), 'user_not_found');
      assert.throws(() => S.assertSingleUserAccount({ uid: 0 }, 'darwin'), /not root/);
      S.assertSingleUserAccount({ uid: 501 }, 'darwin');
    });
  });

  it('unknown user, missing home and a hostile name', () => {
    const fail = () => { throw Object.assign(new Error('no such user'), { status: 1 }); };
    assert.equal(code(() => S.resolveSessionUser('ghost', { platform: 'linux', execFile: fail })), 'user_not_found');
    const noHome = (file) => (file === '/usr/bin/getent' ? 'alice:x:1001:1001::/nonexistent-kl:/bin/sh\n' : '1001\n');
    assert.equal(code(() => S.resolveSessionUser('alice', { platform: 'linux', execFile: noHome, exists: () => false })), 'home_missing');
    assert.equal(code(() => S.resolveSessionUser('-rf', { platform: 'linux', execFile: fail })), 'invalid_params');
  });
});
