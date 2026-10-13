// tests/identity-record.test.js
//
// R-F5-17: the administrator's record of the node's identity
// (<configDir>/identity/node.json) and what a reader makes of it: no record,
// a record that matches, one that does not, and one that cannot be trusted.
// Temp dirs only; no PowerShell (the Windows owner read is injected).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/service/identity-record');
const { deriveNodeId } = require('../src/mesh/node-identity');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { nodeId: deriveNodeId(pair.publicKey), publicKey: pair.publicKey.toString('hex') };
}

function setup() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-identity-record-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, 'config');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(configDir, { mode: 0o755 });
  fs.mkdirSync(dataDir, { mode: 0o700 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  return { base, configDir, dataDir };
}

const ADMINS = 'S-1-5-32-544';
// What the Windows inspector reports for [configDir, identity dir, file].
const owners = (config = ADMINS, dir = ADMINS, file = ADMINS, link = [false, false, false]) => () => ({
  me: 'S-1-5-21-1-2-3-1001', entries: [{ owner: config, link: link[0] }, { owner: dir, link: link[1] }, { owner: file, link: link[2] }]
});
// What the Windows access-list inspector reports for a record as "identity
// record" leaves it, for however many paths it is asked about.
const cleanAce = (sid, mask, flags) => ({ type: 0, sid, mask, flags });
const cleanAcl = (paths) => paths.map((p, i) => ({
  dacl: true, owner: ADMINS,
  aces: [cleanAce('S-1-5-18', 0x1f01ff, i < paths.length - 1 ? 3 : 0), cleanAce(ADMINS, 0x1f01ff, i < paths.length - 1 ? 3 : 0), cleanAce('S-1-5-19', 0x1200a9, i < paths.length - 1 ? 3 : 0)]
}));
// The reader's options in a test: this uid as the administrator; on Windows
// no probe and Administrators as every owner, unless a test says otherwise.
const opts = (extra = {}) => ({ adminUid: UID, serviceProbe: false, inspectOwners: owners(), runIcacls: () => {}, ...extra });
const write = (s, k, extra = {}) => R.writeIdentityRecord({ configDir: s.configDir, nodeId: k.nodeId, publicKey: k.publicKey, ...opts(extra) });

describe('the administrator\'s record of the node identity (R-F5-17)', () => {
  it('is <configDir>/identity/node.json: v, the node id, its public key and when it was recorded', () => {
    const s = setup();
    const k = keys();
    const file = write(s, k, { now: Date.parse('2026-10-13T09:00:00.000Z') });
    assert.equal(file, path.join(s.configDir, 'identity', 'node.json'));
    assert.equal(file, R.recordPath(s.configDir));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, node_id: k.nodeId, public_key: k.publicKey, recorded_at: '2026-10-13T09:00:00.000Z' });
    if (POSIX) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'the service account reads it and cannot write it');
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['node.json'], 'no temporary file is left');
    const seen = R.readIdentityRecord({ configDir: s.configDir, ...opts() });
    assert.deepEqual(seen, { state: 'recorded', file, nodeId: k.nodeId, publicKey: k.publicKey, recordedAt: '2026-10-13T09:00:00.000Z' });
  });

  it('no record: state none, whether the directory is there or not', () => {
    const s = setup();
    assert.deepEqual(R.readIdentityRecord({ configDir: s.configDir, ...opts() }), { state: 'none', file: R.recordPath(s.configDir) });
    fs.mkdirSync(path.join(s.configDir, 'identity'));
    assert.equal(R.readIdentityRecord({ configDir: s.configDir, ...opts() }).state, 'none');
    assert.equal(R.readIdentityRecord({ configDir: path.join(s.base, 'no-such-config'), ...opts() }).state, 'none');
  });

  it('checkNodeIdentityRecord: match, none, mismatch and invalid, each with what an administrator does about it', () => {
    const s = setup();
    const k = keys();
    const other = keys();
    const check = (identity, extra = {}) => R.checkNodeIdentityRecord({ configDir: s.configDir, dataDir: s.dataDir, identity, ...opts(extra) });

    const none = check(k);
    assert.equal(none.state, 'none');
    assert.match(none.problem, /no administrator record of this node's identity/);
    assert.ok(none.problem.includes(`king-louie-service identity record --data-dir ${s.dataDir}`));

    write(s, k);
    assert.deepEqual(check(k), { state: 'match', file: R.recordPath(s.configDir), problem: null, recorded: { nodeId: k.nodeId, publicKey: k.publicKey } });
    // The identity as the service holds it: a DER buffer, and an id of its own.
    assert.equal(check({ nodeId: k.nodeId, publicKey: Buffer.from(k.publicKey, 'hex') }).state, 'match');
    assert.equal(check({ nodeId: k.nodeId, publicKey: k.publicKey.toUpperCase() }).state, 'match');

    const mismatch = check(other);
    assert.equal(mismatch.state, 'mismatch');
    assert.ok(mismatch.problem.includes(other.nodeId) && mismatch.problem.includes(k.nodeId), 'names both');
    assert.ok(mismatch.problem.includes(`king-louie-service identity record --replace --data-dir ${s.dataDir}`), 'the administrator\'s remedy');
    assert.match(mismatch.problem, /restore/);
    // The same id with another key is still not the recorded identity (the key is what is compared).
    assert.equal(check({ nodeId: k.nodeId, publicKey: other.publicKey }).state, 'mismatch');
    // Nothing to compare is never a match.
    for (const bad of [null, {}, { nodeId: k.nodeId }, { nodeId: k.nodeId, publicKey: 'zz' }]) assert.equal(check(bad).state, 'mismatch');

    fs.writeFileSync(R.recordPath(s.configDir), '{ not json');
    const invalid = check(k);
    assert.equal(invalid.state, 'invalid');
    assert.match(invalid.problem, /is not valid JSON/);
    assert.ok(invalid.problem.includes('identity record --replace'));
    assert.ok(!invalid.problem.includes('not json'), 'the file is never quoted');
  });

  it('a record that is malformed, too large, or names an id that is not its key\'s is invalid', () => {
    const s = setup();
    const k = keys();
    const other = keys();
    write(s, k);
    const file = R.recordPath(s.configDir);
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const state = (record) => {
      fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
      return R.readIdentityRecord({ configDir: s.configDir, ...opts() });
    };
    for (const bad of [
      { ...good, v: 2 }, { ...good, node_id: other.nodeId }, { ...good, public_key: 'abcd' }, { ...good, public_key: 7 },
      { ...good, recorded_at: 'yesterday' }, { ...good, extra: true }, (({ recorded_at: _, ...rest }) => rest)(good), [good], null, 'x'
    ]) {
      const seen = state(bad);
      assert.equal(seen.state, 'invalid', JSON.stringify(bad));
      assert.match(seen.reason, /is malformed|is not valid JSON/);
    }
    assert.match(state(`${JSON.stringify(good)}${' '.repeat(5000)}`).reason, /is larger than/);
    assert.equal(state(good).state, 'recorded');
    // A directory where the file should be.
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.match(R.readIdentityRecord({ configDir: s.configDir, ...opts() }).reason, /is not a regular file/);
  });

  it('POSIX: a record, its directory or the config dir that is not the administrator\'s, or that others can write, is invalid', { skip: !POSIX }, () => {
    const s = setup();
    const k = keys();
    write(s, k);
    const file = R.recordPath(s.configDir);
    const read = (extra = {}) => R.readIdentityRecord({ configDir: s.configDir, ...opts(extra) });
    assert.equal(read().state, 'recorded');
    // Owned by the account that runs the service (here: any uid that is not the administrator's).
    const asService = read({ adminUid: UID + 1, geteuid: () => UID });
    assert.equal(asService.state, 'invalid');
    assert.match(asService.reason, /is not owned by the administrator/);
    for (const [target, mode, restore] of [[file, 0o666, 0o644], [path.dirname(file), 0o777, 0o755], [s.configDir, 0o777, 0o755]]) {
      fs.chmodSync(target, mode);
      const seen = read();
      assert.equal(seen.state, 'invalid', target);
      assert.match(seen.reason, /is not owned by the administrator|can be written by others/);
      fs.chmodSync(target, restore);
    }
    assert.equal(read().state, 'recorded');
    // A link at the file, and at its directory.
    const real = path.join(s.base, 'elsewhere.json');
    fs.renameSync(file, real);
    fs.symlinkSync(real, file);
    assert.match(read().reason, /is not a regular file/);
    fs.rmSync(file);
    fs.rmSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(s.base, 'real-identity'));
    fs.renameSync(real, path.join(s.base, 'real-identity', 'node.json'));
    fs.symlinkSync(path.join(s.base, 'real-identity'), path.dirname(file));
    assert.equal(read().state, 'invalid');
  });

  describe('Windows: owners and the write probe, as for approvers', () => {
    const win = (s, extra = {}) => R.readIdentityRecord({ configDir: s.configDir, platform: 'win32', ...opts(extra) });
    const recorded = () => {
      const s = setup();
      write(s, keys());
      return s;
    };
    const SERVICE = 'S-1-5-19';
    const USER = 'S-1-5-21-1-2-3-1001';

    it('Administrators or SYSTEM, or the config dir\'s own owner; never a config dir the service account owns', () => {
      const s = recorded();
      assert.equal(win(s).state, 'recorded');
      assert.equal(win(s, { inspectOwners: owners('S-1-5-18', ADMINS, 'S-1-5-18') }).state, 'recorded');
      // A hand-made layout: one account owns the config dir and what is in it.
      assert.equal(win(s, { inspectOwners: owners(USER, USER, USER) }).state, 'recorded');
      for (const [o, why] of [
        [owners(SERVICE, ADMINS, ADMINS), /is owned by the service account/],
        [owners(ADMINS, USER, ADMINS), /is owned by S-1-5-21-1-2-3-1001/],
        [owners(ADMINS, ADMINS, USER), /is owned by S-1-5-21-1-2-3-1001/],
        [owners(ADMINS, ADMINS, SERVICE), /is owned by S-1-5-19/],
        [owners(ADMINS, ADMINS, ADMINS, [false, true, false]), /is a link/],
        [owners(ADMINS, ADMINS, ADMINS, [false, false, true]), /is a link/],
        [owners(ADMINS, ADMINS, '(none)'), /could not be read/]
      ]) {
        const seen = win(s, { inspectOwners: o });
        assert.equal(seen.state, 'invalid');
        assert.match(seen.reason, why);
      }
    });

    it('owners that cannot be read are not trusted (fail closed)', () => {
      const s = recorded();
      for (const inspectOwners of [
        () => { throw new Error('powershell failed'); }, () => null, () => ({ me: USER, entries: [] }),
        () => ({ me: USER, entries: [{ owner: ADMINS, link: false }, null, { owner: ADMINS, link: false }] })
      ]) {
        const seen = win(s, { inspectOwners });
        assert.equal(seen.state, 'invalid');
        assert.match(seen.reason, /could not be read/);
      }
    });

    // What the service's file system answers: `create` for a new file beside
    // the record, `write` for opening the record itself for writing.
    const answering = ({ create = 'EPERM', write: w = 'EPERM' } = {}) => ({
      ...fs,
      openSync: (p, flags, ...rest) => {
        const code = flags === 'wx' ? create : (flags === 'r+' ? w : null);
        if (code) throw Object.assign(new Error(code), { code });
        return fs.openSync(p, flags, ...rest);
      }
    });

    it('the service-side probe: a directory this process can create a file in is not the administrator\'s', () => {
      const s = recorded();
      const dir = path.dirname(R.recordPath(s.configDir));
      // The temp dir is this user's, so the real probe succeeds in writing.
      const writable = win(s, { serviceProbe: true });
      assert.equal(writable.state, 'invalid');
      assert.match(writable.reason, /is writable by the account running the service/);
      assert.deepEqual(fs.readdirSync(dir), ['node.json'], 'the probe file is removed');
      // Denied, both the new file and the record itself: the ACL is right.
      assert.equal(win(s, { serviceProbe: true, fsImpl: answering() }).state, 'recorded');
      // Any other failure proves nothing.
      const unknown = win(s, { serviceProbe: true, fsImpl: answering({ create: 'EIO' }) });
      assert.equal(unknown.state, 'invalid');
      assert.match(unknown.reason, /could not be verified/);
    });

    // Fourth security review, finding 1: a directory that refuses new files
    // can still hand the record a write entry (an inherit-only ACE). So the
    // record itself is opened for writing, and only "denied" is trusted.
    it('the service-side probe opens the record itself for writing: a record this process can write is not trusted', () => {
      const s = recorded();
      const before = fs.readFileSync(R.recordPath(s.configDir), 'utf8');
      // No new file can be made, yet node.json opens for writing (the real open, on a temp file).
      const seen = win(s, { serviceProbe: true, fsImpl: answering({ write: null }) });
      assert.equal(seen.state, 'invalid');
      assert.match(seen.reason, /node\.json is writable by the account running the service/);
      assert.equal(fs.readFileSync(R.recordPath(s.configDir), 'utf8'), before, 'the probe changes nothing in the record');
      for (const code of ['EIO', 'EBUSY', 'ENOENT']) {
        const unknown = win(s, { serviceProbe: true, fsImpl: answering({ write: code }) });
        assert.equal(unknown.state, 'invalid', code);
        assert.match(unknown.reason, /could not be verified: whether .*node\.json is protected is unknown/);
      }
      for (const code of ['EACCES', 'EPERM']) assert.equal(win(s, { serviceProbe: true, fsImpl: answering({ create: code, write: code }) }).state, 'recorded');
      // The admin CLI and doctor are not probed: an administrator can write it.
      assert.equal(win(s, { serviceProbe: false }).state, 'recorded');
    });

    it('probeIdentityRecord is that probe alone, for asking again while the service runs; nothing off Windows', () => {
      const s = recorded();
      const probe = (extra = {}) => R.probeIdentityRecord({ configDir: s.configDir, platform: 'win32', ...extra });
      assert.equal(probe({ fsImpl: answering() }), null);
      assert.match(probe({ fsImpl: answering({ write: null }) }), /node\.json cannot be trusted: .*node\.json is writable by the account running the service/);
      assert.match(probe({ fsImpl: answering({ create: null }) }), /identity is writable by the account running the service/);
      assert.match(probe({ fsImpl: answering({ write: 'EIO' }) }), /could not be verified/);
      assert.equal(R.probeIdentityRecord({ configDir: s.configDir, platform: 'linux', fsImpl: answering({ write: null }) }), null);
    });

    // Fifth security review, finding 2: a service run by hand as an account
    // the record's access list does not name was told to run "identity
    // record --replace", which writes the same access list again.
    describe('a record this account is not allowed to read', () => {
      const denying = (what, code) => ({
        ...fs,
        lstatSync: (p, ...rest) => {
          if (what === 'lstat' && path.basename(String(p)) === 'node.json') throw Object.assign(new Error(code), { code });
          return fs.lstatSync(p, ...rest);
        },
        readFileSync: (p, ...rest) => {
          if (what === 'read' && path.basename(String(p)) === 'node.json') throw Object.assign(new Error(code), { code });
          return fs.readFileSync(p, ...rest);
        }
      });
      const check = (s, extra) => R.checkNodeIdentityRecord({ configDir: s.configDir, dataDir: s.dataDir, identity: keys(), platform: 'win32', ...opts(extra) });

      it('the service is told who can read the record and to run as LOCAL SERVICE; it still refuses to start', () => {
        const s = recorded();
        for (const what of ['lstat', 'read']) {
          for (const code of ['EPERM', 'EACCES']) {
            const fsImpl = { ...denying(what, code), openSync: answering().openSync };
            const seen = check(s, { serviceProbe: true, fsImpl, inspectAcl: cleanAcl });
            assert.equal(seen.state, 'invalid', `${what} ${code}: never "none", never a match`);
            assert.ok(seen.problem.includes(`(${code})`));
            assert.match(seen.problem, /can be read only by SYSTEM \(S-1-5-18\), Administrators \(S-1-5-32-544\) and LOCAL SERVICE \(S-1-5-19\)/);
            assert.match(seen.problem, /run the service as LOCAL SERVICE/);
            assert.match(seen.problem, /"king-louie-service identity record --replace" writes the same access list again and changes nothing/);
            assert.doesNotMatch(seen.problem, /find out who could have changed it, then run/);
            assert.throws(() => R.assertRecordedIdentity({ configDir: s.configDir, dataDir: s.dataDir, identity: keys(), platform: 'win32', log: { warn() {}, error() {}, info() {} }, ...opts({ serviceProbe: true, fsImpl, inspectAcl: cleanAcl }) }),
              (err) => err.code === 'NODE_IDENTITY_RECORD_INVALID' && /^Refusing to start: /.test(err.message) && /run the service as LOCAL SERVICE/.test(err.message));
          }
        }
      });

      it('an administrator\'s command is told to run elevated, not to change the service\'s account', () => {
        const s = recorded();
        const seen = check(s, { serviceProbe: false, fsImpl: denying('lstat', 'EPERM') });
        assert.equal(seen.state, 'invalid');
        assert.match(seen.problem, /run this from an elevated \(Administrator\) prompt/);
        assert.doesNotMatch(seen.problem, /run the service as LOCAL SERVICE/);
        assert.doesNotMatch(seen.problem, /find out who could have changed it, then run/);
      });

      it('any other failure, and any failure off Windows, keeps the plain wording', () => {
        const s = recorded();
        const other = check(s, { serviceProbe: true, fsImpl: { ...denying('lstat', 'EIO'), openSync: answering().openSync } });
        assert.equal(other.state, 'invalid');
        assert.match(other.problem, /could not be checked \(EIO\)/);
        assert.match(other.problem, /identity record --replace/);
        const posix = R.checkNodeIdentityRecord({ configDir: s.configDir, dataDir: s.dataDir, identity: keys(), platform: 'linux', ...opts({ fsImpl: denying('lstat', 'EACCES') }) });
        assert.equal(posix.state, 'invalid');
        assert.match(posix.problem, /could not be checked \(EACCES\)/);
        assert.doesNotMatch(posix.problem, /LOCAL SERVICE/);
      });
    });

    const winWrite = (s, k, runIcacls) => R.writeIdentityRecord({
      configDir: s.configDir, nodeId: k.nodeId, publicKey: k.publicKey, platform: 'win32', ...opts({ runIcacls }), env: { SystemRoot: 'C:\\Windows' }
    });

    // Fourth security review, finding 1: only the owner was set, so a
    // directory that was there before kept whatever ACL it had.
    it('writing makes the directory anew: a protected ACL and Administrators as owner for it and for the file, before the record is in it', () => {
      const s = setup();
      const k = keys();
      const ran = [];
      const seen = [];
      const file = winWrite(s, k, (argv) => {
        ran.push(argv);
        // What exists under the record's own name while the ACLs are set: nothing.
        seen.push(fs.existsSync(path.join(s.configDir, 'identity')));
      });
      assert.equal(file, R.recordPath(s.configDir));
      assert.ok(ran.every((a) => /System32[\\/]icacls\.exe$/i.test(a[0])), 'icacls by its absolute path');
      const fresh = ran[0][1];
      assert.match(path.basename(fresh), /^\.identity\.new-[0-9a-f]{8}$/);
      assert.equal(path.dirname(fresh), s.configDir);
      assert.deepEqual(ran.map((a) => a.slice(1)), [
        [fresh, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)', '*S-1-5-19:(OI)(CI)(RX)'],
        [fresh, '/setowner', '*S-1-5-32-544'],
        [path.join(fresh, 'node.json'), '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)', '*S-1-5-19:(R)'],
        [path.join(fresh, 'node.json'), '/setowner', '*S-1-5-32-544']
      ]);
      assert.deepEqual(seen, [false, false, false, false]);
      assert.equal(win(s).nodeId, k.nodeId);
      assert.deepEqual(fs.readdirSync(s.configDir), ['identity']);
    });

    it('a directory that was there before is replaced, never kept, with whatever was in it', () => {
      const s = recorded();
      const dir = path.join(s.configDir, 'identity');
      fs.writeFileSync(path.join(dir, 'left-behind.txt'), 'x');
      const k = keys();
      const emptyWhenSet = [];
      winWrite(s, k, (argv) => { if (argv.includes('/setowner') && path.basename(argv[1]) === 'node.json') emptyWhenSet.push(fs.statSync(argv[1]).size); });
      assert.deepEqual(emptyWhenSet, [0], 'the file has its ACL and its owner before anything is written to it');
      assert.deepEqual(fs.readdirSync(dir), ['node.json']);
      assert.deepEqual(fs.readdirSync(s.configDir), ['identity'], 'neither the new directory nor the old one is left beside it');
      assert.equal(win(s).nodeId, k.nodeId);
    });

    it('if an ACL cannot be set nothing is recorded and what was there stays', () => {
      const s = setup();
      const first = keys();
      for (const failAt of [0, 1, 2, 3]) {
        let n = 0;
        assert.throws(() => winWrite(s, keys(), () => { if (n++ === failAt) throw new Error('icacls failed'); }), /icacls failed/);
        assert.deepEqual(fs.readdirSync(s.configDir), [], `call ${failAt}: nothing is left`);
      }
      winWrite(s, first, () => {});
      for (const failAt of [0, 1, 2, 3]) {
        let n = 0;
        assert.throws(() => winWrite(s, keys(), () => { if (n++ === failAt) throw new Error('icacls failed'); }), /icacls failed/);
        assert.deepEqual(fs.readdirSync(s.configDir), ['identity']);
        assert.equal(win(s).nodeId, first.nodeId, 'the earlier record is still the record');
      }
    });

    // The real thing, as far as an account that is not elevated can show it
    // (nothing injected but the owner read, which needs no elevation to be
    // wrong: this account cannot give a file to Administrators). icacls on a
    // temp dir this account owns; the lock is lifted before cleanup.
    describe('for real: icacls on a temp dir', { skip: process.platform !== 'win32' }, () => {
      const { execFileSync } = require('child_process');
      const sys = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
      const icacls = (...args) => execFileSync(sys('icacls.exe'), args, { encoding: 'utf8', windowsHide: true });
      const me = () => execFileSync(sys('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split(',').pop().replace(/"/g, '');
      const elevated = () => /S-1-16-(12288|16384)/.test(execFileSync(sys('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }));
      // The owner keeps the right to rewrite an ACL whatever it says.
      const unlock = (...targets) => { for (const t of targets) { try { icacls(t, '/reset'); } catch { /* cleanup reports what is left */ } } };

      it('the reviewer\'s case: no new file can be made in identity\\, the record inherits a write entry, and the probe refuses it', () => {
        const s = recorded();
        const dir = path.join(s.configDir, 'identity');
        const file = R.recordPath(s.configDir);
        const sid = me();
        try {
          // What a service account that once controlled the directory can leave:
          // read and list for itself, and "modify" for every file in it, inherit-only.
          icacls(dir, '/inheritance:r', '/grant:r', `*${sid}:(RX)`, `*${sid}:(OI)(IO)(M)`);
          assert.throws(() => fs.openSync(path.join(dir, '.x'), 'wx'), (err) => err.code === 'EPERM' || err.code === 'EACCES', 'the create probe alone is satisfied');
          const fd = fs.openSync(file, 'r+');
          fs.closeSync(fd);
          const seen = R.readIdentityRecord({ configDir: s.configDir, platform: 'win32', adminUid: UID, serviceProbe: true, inspectOwners: owners() });
          assert.equal(seen.state, 'invalid');
          assert.match(seen.reason, /node\.json is writable by the account running the service/);
          assert.match(R.probeIdentityRecord({ configDir: s.configDir }), /node\.json is writable by the account running the service/);
        } finally {
          unlock(dir, file);
        }
      });

      it('the ACL the command sets leaves an account that is not SYSTEM, Administrators or LOCAL SERVICE no way in, and nothing inherited', (t) => {
        if (elevated()) { t.skip('this process is elevated: Administrators are given full control, so it is not kept out'); return; }
        const s = setup();
        const dir = path.join(s.configDir, 'identity');
        const file = path.join(dir, 'node.json');
        fs.mkdirSync(dir);
        fs.writeFileSync(file, '{}\n');
        const sid = me();
        try {
          // A directory with an entry of the kind the reviewer left, to show it is gone afterwards.
          icacls(dir, '/grant', `*${sid}:(OI)(IO)(M)`);
          // The same arguments writeIdentityRecord runs, the file first (afterwards this account cannot reach it).
          const run = (argv) => execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
          const entries = (target) => {
            const listed = icacls(target).split(/\r?\n/).filter((line) => /:\(/.test(line));
            assert.equal(listed.length, 3, `${target}: SYSTEM, Administrators and LOCAL SERVICE, nothing else\n${listed.join('\n')}`);
            assert.ok(listed.every((line) => !/\(I\)/.test(line)), `${target}: nothing inherited`);
          };
          run(R.windowsRecordFileAclArgs(file));
          entries(file); // read now: once the directory is closed to this account, the file's ACL cannot be listed
          // On a directory that already has entries the command never does this (it makes a new one);
          // here /reset first stands in for "new", then the same arguments.
          icacls(dir, '/reset');
          run(R.windowsRecordDirAclArgs(dir));
          entries(dir);
          assert.equal(R.probeIdentityRecord({ configDir: s.configDir }), null, 'the real probe: no new file, and the record does not open for writing');
          assert.throws(() => fs.openSync(file, 'r+'), (err) => err.code === 'EPERM' || err.code === 'EACCES');
        } finally {
          unlock(dir, file);
        }
      });
    });
  });

  it('writing refuses an id that is not the key\'s, a config dir that is missing or reached through a link, and replaces a record whole', () => {
    const s = setup();
    const k = keys();
    const other = keys();
    assert.throws(() => R.writeIdentityRecord({ configDir: s.configDir, nodeId: other.nodeId, publicKey: k.publicKey, ...opts() }), /does not belong to that public key/);
    assert.throws(() => R.writeIdentityRecord({ configDir: path.join(s.base, 'nope'), nodeId: k.nodeId, publicKey: k.publicKey, ...opts() }), /does not exist/);
    assert.equal(fs.existsSync(path.join(s.configDir, 'identity')), false, 'a refusal writes nothing');
    write(s, k);
    write(s, other);
    assert.equal(R.readIdentityRecord({ configDir: s.configDir, ...opts() }).nodeId, other.nodeId);
    assert.deepEqual(fs.readdirSync(path.join(s.configDir, 'identity')), ['node.json']);
  });

  it('a config dir reached through a link is refused', (t) => {
    const s = setup();
    const k = keys();
    const link = path.join(s.base, 'config-link');
    try {
      fs.symlinkSync(s.configDir, link, 'junction');
    } catch {
      t.skip('this account cannot create a link');
      return;
    }
    assert.throws(() => R.writeIdentityRecord({ configDir: link, nodeId: k.nodeId, publicKey: k.publicKey, ...opts() }), /link/);
    assert.equal(fs.existsSync(path.join(s.configDir, 'identity')), false);
  });

  it('assertRecordedIdentity: silent on a match, warns once on none, throws on a mismatch or a record it cannot trust', () => {
    const s = setup();
    const k = keys();
    const warned = [];
    const log = { warn: (m) => warned.push(m), error: (m) => warned.push(m), info() {} };
    const run = (identity, extra = {}) => R.assertRecordedIdentity({ configDir: s.configDir, dataDir: s.dataDir, identity, log, ...opts(extra) });
    assert.equal(run(k).state, 'none');
    assert.equal(warned.length, 1);
    assert.match(warned[0], /no administrator record of this node's identity/);
    assert.match(warned[0], /computer use stays off/);
    write(s, k);
    assert.equal(run(k).state, 'match');
    assert.equal(warned.length, 1, 'a match says nothing');
    assert.throws(() => run(keys()), (err) => err.code === 'NODE_IDENTITY_MISMATCH' && /identity record --replace/.test(err.message));
    fs.writeFileSync(R.recordPath(s.configDir), 'x');
    assert.throws(() => run(k), (err) => err.code === 'NODE_IDENTITY_RECORD_INVALID' && /is not valid JSON/.test(err.message));
  });
});
