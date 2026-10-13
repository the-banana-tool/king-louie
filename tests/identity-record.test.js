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

    it('the service-side probe: a directory this process can create a file in is not the administrator\'s', () => {
      const s = recorded();
      const dir = path.dirname(R.recordPath(s.configDir));
      // The temp dir is this user's, so the real probe succeeds in writing.
      const writable = win(s, { serviceProbe: true });
      assert.equal(writable.state, 'invalid');
      assert.match(writable.reason, /is writable by the account running the service/);
      assert.deepEqual(fs.readdirSync(dir), ['node.json'], 'the probe file is removed');
      // Denied: the ACL is right.
      const denied = { ...fs, openSync: (p, flags) => { if (flags === 'wx') throw Object.assign(new Error('denied'), { code: 'EPERM' }); return fs.openSync(p, flags); } };
      assert.equal(win(s, { serviceProbe: true, fsImpl: denied }).state, 'recorded');
      // Any other failure proves nothing.
      const broken = { ...fs, openSync: (p, flags) => { if (flags === 'wx') throw Object.assign(new Error('device'), { code: 'EIO' }); return fs.openSync(p, flags); } };
      const unknown = win(s, { serviceProbe: true, fsImpl: broken });
      assert.equal(unknown.state, 'invalid');
      assert.match(unknown.reason, /could not be verified/);
    });

    it('writing gives the directory and the file to Administrators', () => {
      const s = setup();
      const k = keys();
      const ran = [];
      R.writeIdentityRecord({ configDir: s.configDir, nodeId: k.nodeId, publicKey: k.publicKey, platform: 'win32', ...opts({ runIcacls: (argv) => ran.push(argv) }), env: { SystemRoot: 'C:\\Windows' } });
      const file = R.recordPath(s.configDir);
      assert.deepEqual(ran.map((a) => a.slice(1)), [[path.dirname(file), '/setowner', '*S-1-5-32-544'], [file, '/setowner', '*S-1-5-32-544']]);
      assert.ok(ran.every((a) => /System32[\\/]icacls\.exe$/i.test(a[0])), 'icacls by its absolute path');
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
