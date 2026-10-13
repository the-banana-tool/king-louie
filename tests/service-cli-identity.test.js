// tests/service-cli-identity.test.js
//
// `king-louie-service identity record|show` (owner ruling R-F5-17): the one
// command that writes the administrator's record of the node identity.
// Temp dirs only; nothing here is elevated, resolves a real key or runs
// PowerShell or icacls (all injected, as tests/service-cli-session.test.js does).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runIdentityCommand, IDENTITY_USAGE } = require('../src/service/commands/identity');
const { main } = require('../src/service/cli');
const R = require('../src/service/identity-record');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { fingerprintGroups } = require('../src/approvals/envelope');
const { recordIdentity, IDENTITY_RECORD_TEST_OPTIONS } = require('./helpers/identity-record');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const KEY = crypto.randomBytes(32);

function nodeKeys() {
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { publicKey: pair.publicKey.toString('hex'), privateHex: pair.privateKey.toString('hex'), nodeId: deriveNodeId(pair.publicKey) };
}
const stored = (keys) => ({ publicKey: keys.publicKey, privateKey: null, keyEncryption: 'cipher-v1', encryptedPrivateKey: createAesGcmCipher(KEY).encryptString(keys.privateHex) });
const writeIdentity = (dataDir, record) => fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: record } }));

function setup({ keys = nodeKeys(), withIdentity = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-identity-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  if (withIdentity) writeIdentity(dataDir, stored(keys));
  return { base, dataDir, configDir, keys };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, text: () => out.join(''), errors: () => err.join(''), io: { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: (t) => err.push(String(t)) }, stdin: null } };
}

function deps(s, extra = {}) {
  return {
    platform: process.platform,
    isAdmin: () => true,
    isTTY: () => true,
    confirm: async () => true,
    resolveKey: () => ({ key: KEY, source: 'test' }),
    verifyKey: () => {},
    dataDirOwnerUid: UID,
    configDir: s.configDir,
    nodeName: () => 'gpu-box',
    runIcacls: () => {},
    verifyConfigDir: () => {},
    adminUid: UID,
    identityRecord: IDENTITY_RECORD_TEST_OPTIONS,
    ...extra
  };
}

const run = (s, t, { sub = 'record', flags = {}, d = {} } = {}) => runIdentityCommand({ sub, flags, dataDir: s.dataDir, io: t.io, deps: deps(s, d) });
const seen = (s) => R.readIdentityRecord({ configDir: s.configDir, adminUid: UID, ...IDENTITY_RECORD_TEST_OPTIONS });
function tree(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath || entry.path, entry.name);
    out[path.relative(dir, file)] = entry.isFile() ? fs.readFileSync(file, 'hex') : null;
  }
  return out;
}

describe('identity record (R-F5-17)', () => {
  it('shows the node, its id and fingerprint, where it read them and what it writes; asks; then records', async () => {
    const s = setup();
    const t = io();
    const asked = [];
    let before = null;
    const code = await run(s, t, { d: { confirm: async (q) => { asked.push(q); before = { text: t.text(), exists: fs.existsSync(path.join(s.configDir, 'identity')) }; return true; } } });
    assert.equal(code, 0, t.errors());
    assert.deepEqual(asked, ['Record this identity for the node? [y/N] ']);
    // Everything is on screen, and nothing is written, before the question.
    assert.equal(before.exists, false);
    assert.ok(before.text.includes(`Node "gpu-box": ${s.keys.nodeId} (fingerprint ${fingerprintGroups(s.keys.nodeId)})`));
    assert.ok(before.text.includes(s.dataDir));
    assert.ok(before.text.includes(R.recordPath(s.configDir)));
    assert.match(before.text, /the service refuses to start/);
    assert.match(before.text, /Compare the id with the one your phones show for this node/);
    const rec = seen(s);
    assert.equal(rec.state, 'recorded');
    assert.equal(rec.nodeId, s.keys.nodeId);
    assert.equal(rec.publicKey, s.keys.publicKey);
    assert.match(t.text(), /Recorded\./);
  });

  it('needs an administrator; off a terminal it needs --yes and refuses before anything is read', async () => {
    const s = setup();
    const t = io();
    assert.equal(await run(s, t, { d: { isAdmin: () => false } }), 1);
    assert.match(t.errors(), /root|Administrator/);
    const t2 = io();
    const untouched = () => { throw new Error('must not be reached'); };
    assert.equal(await run(s, t2, { d: { isTTY: () => false, resolveKey: untouched, confirm: untouched, nodeName: untouched } }), 2);
    assert.match(t2.errors(), /without confirmation on a non-interactive terminal; pass --yes/);
    assert.equal(t2.text(), '');
    assert.equal(seen(s).state, 'none');
    // --yes off a terminal: no question, recorded.
    const t3 = io();
    assert.equal(await run(s, t3, { flags: { yes: true }, d: { isTTY: () => false, confirm: untouched } }), 0, t3.errors());
    assert.equal(seen(s).nodeId, s.keys.nodeId);
  });

  it('a no, or anything but yes, writes nothing', async () => {
    for (const answer of [false, undefined, 'yes', 1]) {
      const s = setup();
      const before = tree(s.base);
      const t = io();
      assert.equal(await run(s, t, { d: { confirm: async () => answer } }), 1);
      assert.match(t.errors(), /Not recording without confirmation\. Nothing was written\./);
      assert.deepEqual(tree(s.base), before);
    }
  });

  it('--dry-run says what it would write, asks nothing and writes nothing', async () => {
    const s = setup();
    const before = tree(s.base);
    const t = io();
    assert.equal(await run(s, t, { flags: { dryRun: true }, d: { isTTY: () => false, confirm: () => { throw new Error('must not ask'); } } }), 0);
    assert.ok(t.text().includes(`[dry-run] write ${R.recordPath(s.configDir)} (node ${s.keys.nodeId})`));
    assert.deepEqual(tree(s.base), before);
  });

  it('refuses an identity that does not hold together, and a data dir with none, before the question', async () => {
    const never = { confirm: () => { throw new Error('must not ask'); } };
    const none = setup({ withIdentity: false });
    let t = io();
    assert.equal(await run(none, t, { d: never }), 1);
    assert.match(t.errors(), /no node identity in .*: start the service once first/);
    // A key pair whose private half is in the clear (no master key needed to plant it).
    const plain = setup({ withIdentity: false });
    const k = nodeKeys();
    writeIdentity(plain.dataDir, { publicKey: k.publicKey, privateKey: k.privateHex });
    t = io();
    assert.equal(await run(plain, t, { d: never }), 1);
    assert.match(t.errors(), /in the clear.*nothing was recorded/);
    // A public key that is not the private key's.
    const swapped = setup({ withIdentity: false });
    writeIdentity(swapped.dataDir, { ...stored(k), publicKey: nodeKeys().publicKey });
    t = io();
    assert.equal(await run(swapped, t, { d: never }), 1);
    assert.match(t.errors(), /not its private key's; nothing was recorded/);
    // No master key.
    const keyless = setup();
    t = io();
    assert.equal(await run(keyless, t, { d: { ...never, resolveKey: () => null } }), 1);
    assert.match(t.errors(), /no master key/);
    for (const s of [none, plain, swapped, keyless]) assert.equal(seen(s).state, 'none');
  });

  it('the same identity again: says so, writes nothing, asks nothing', async () => {
    const s = setup();
    recordIdentity(s.configDir, s.keys);
    const before = tree(s.configDir);
    const t = io();
    assert.equal(await run(s, t, { d: { confirm: () => { throw new Error('must not ask'); } } }), 0);
    assert.match(t.text(), /already recorded/);
    assert.deepEqual(tree(s.configDir), before);
  });

  it('another identity is recorded: refused without --replace, naming both; with --replace it says what it replaces, asks, and replaces', async () => {
    const s = setup();
    const old = nodeKeys();
    recordIdentity(s.configDir, old);
    const before = tree(s.configDir);
    const t = io();
    assert.equal(await run(s, t, { d: { confirm: () => { throw new Error('must not ask'); } } }), 1);
    assert.ok(t.errors().includes(old.nodeId) && t.errors().includes(s.keys.nodeId));
    assert.match(t.errors(), /--replace/);
    assert.match(t.errors(), /Nothing was written\./);
    assert.deepEqual(tree(s.configDir), before);

    const t2 = io();
    const asked = [];
    assert.equal(await run(s, t2, { flags: { replace: true }, d: { confirm: async (q) => { asked.push(q); return false; } } }), 1);
    assert.equal(asked.length, 1);
    assert.ok(t2.text().includes(`replaces: the record of ${old.nodeId} (fingerprint ${fingerprintGroups(old.nodeId)})`));
    assert.match(t2.text(), /must be paired again/);
    assert.deepEqual(tree(s.configDir), before, 'a no keeps the old record');

    const t3 = io();
    assert.equal(await run(s, t3, { flags: { replace: true } }), 0, t3.errors());
    assert.equal(seen(s).nodeId, s.keys.nodeId);
  });

  it('a record that cannot be trusted or read: refused without --replace; --replace writes it anew', async () => {
    const s = setup();
    recordIdentity(s.configDir, s.keys);
    fs.writeFileSync(R.recordPath(s.configDir), '{ broken');
    const t = io();
    assert.equal(await run(s, t), 1);
    assert.match(t.errors(), /is not valid JSON/);
    assert.match(t.errors(), /--replace/);
    assert.ok(!t.errors().includes('broken'), 'the file is never quoted');
    const t2 = io();
    assert.equal(await run(s, t2, { flags: { replace: true } }), 0, t2.errors());
    assert.match(t2.text(), /replaces: a record that could not be used/);
    assert.equal(seen(s).nodeId, s.keys.nodeId);
  });

  it('what it wrote is read back as the service reads it; a record that does not verify is an error', async () => {
    const s = setup();
    const t = io();
    // The owner read says the new file is somebody else's.
    const foreign = { serviceProbe: false, inspectOwners: () => ({ me: 'x', entries: [{ owner: 'S-1-5-32-544', link: false }, { owner: 'S-1-5-32-544', link: false }, { owner: 'S-1-5-21-9-9-9-2001', link: false }] }) };
    const code = await run(s, t, { d: { platform: 'win32', identityRecord: foreign } });
    assert.equal(code, 1);
    assert.match(t.errors(), /was written but does not verify/);
    assert.match(t.errors(), /is owned by S-1-5-21-9-9-9-2001/);
  });

  it('Windows: the config dir is verified after consent and before anything is written; a refusal writes nothing', async () => {
    const s = setup();
    const t = io();
    const order = [];
    const code = await run(s, t, {
      d: {
        platform: 'win32', confirm: async () => { order.push('asked'); return true; },
        verifyConfigDir: (dir) => { order.push(`verify ${dir}`); throw new Error('the ACL of the config dir is not safe.'); }
      }
    });
    assert.equal(code, 1);
    assert.deepEqual(order, ['asked', `verify ${s.configDir}`]);
    assert.match(t.errors(), /the ACL of the config dir is not safe\. Nothing was written\./);
    assert.equal(fs.existsSync(path.join(s.configDir, 'identity')), false);
  });
});

describe('identity show', () => {
  it('prints the record, or that there is none, or why it cannot be used', async () => {
    const s = setup();
    let t = io();
    assert.equal(await run(s, t, { sub: 'show' }), 1);
    assert.match(t.text(), /No administrator record of this node's identity/);
    assert.match(t.text(), /identity record/);
    recordIdentity(s.configDir, s.keys);
    t = io();
    assert.equal(await run(s, t, { sub: 'show' }), 0);
    assert.ok(t.text().includes(`${s.keys.nodeId} (fingerprint ${fingerprintGroups(s.keys.nodeId)})`));
    assert.ok(t.text().includes(R.recordPath(s.configDir)));
    fs.writeFileSync(R.recordPath(s.configDir), '{ broken');
    t = io();
    assert.equal(await run(s, t, { sub: 'show' }), 1);
    assert.match(t.errors(), /is not valid JSON/);
  });
});

describe('the CLI knows identity', () => {
  it('usage, --yes and --replace are scoped to "identity record"', async () => {
    let t = io();
    assert.equal(await main(['identity'], t.io), 2);
    assert.equal(t.errors(), IDENTITY_USAGE);
    t = io();
    assert.equal(await main(['identity', 'bogus'], t.io), 2);
    for (const argv of [['identity', 'show', '--yes'], ['status', '--yes']]) {
      t = io();
      assert.equal(await main(argv, t.io), 2, argv.join(' '));
      assert.match(t.errors(), /"--yes" is only valid for "desktop pair", "device apply", "identity record", "session install" and "session uninstall"/);
    }
    for (const argv of [['identity', 'show', '--replace'], ['session', 'install', '--user', 'alice', '--replace'], ['doctor', '--replace']]) {
      t = io();
      assert.equal(await main(argv, t.io), 2, argv.join(' '));
      assert.match(t.errors(), /"--replace" is only valid for "identity record"/);
    }
    const help = io();
    await main(['help'], help.io);
    assert.match(help.text(), /identity record \[--replace\] \[--data-dir DIR\] \[--dry-run\] \[--yes\]/);
    assert.match(help.text(), /identity show \[--data-dir DIR\]/);
  });
});

describe('doctor: the node identity record', () => {
  const { runDoctor } = require('../src/service/doctor');
  const row = async (s) => (await runDoctor({ dataDir: s.dataDir, configDir: s.configDir, adminUid: UID, deps: { identityRecord: IDENTITY_RECORD_TEST_OPTIONS } })).filter((r) => r.check === 'node identity record');

  it('warns when there is none, passes a match, fails another identity and a record it cannot trust; says nothing before there is an identity', async () => {
    const empty = setup({ withIdentity: false });
    assert.deepEqual(await row(empty), []);

    const s = setup();
    let [r] = await row(s);
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.detail, /no administrator record of this node's identity/);
    assert.match(r.detail, /computer use stays off and "session install" refuses/);

    recordIdentity(s.configDir, s.keys);
    [r] = await row(s);
    assert.equal(r.ok, true);
    assert.equal(r.warn, undefined);
    assert.ok(r.detail.includes(s.keys.nodeId));
    // Fourth security review, finding 5: an "ok" says what it did not check.
    assert.match(r.detail, /public keys compared/);
    assert.match(r.detail, /Not checked here: .*this key's private half \(doctor does not resolve the master key/);

    // Something replaced the identity in the data dir.
    const planted = nodeKeys();
    writeIdentity(s.dataDir, stored(planted));
    [r] = await row(s);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes(planted.nodeId) && r.detail.includes(s.keys.nodeId));
    assert.match(r.detail, /identity record --replace/);
    assert.match(r.detail, /The service refuses to start until this is fixed/);

    fs.writeFileSync(R.recordPath(s.configDir), '{ broken');
    [r] = await row(s);
    assert.equal(r.ok, false);
    assert.match(r.detail, /is not valid JSON/);
  });

  // Fourth security review, finding 5. On Windows doctor compared public
  // keys and read owners, and said "ok" where the service would refuse: it
  // cannot run the service's write probe (an administrator can always
  // write). It now reads the access lists, fails when they let anyone but
  // SYSTEM and Administrators change the record, and says in every "ok"
  // what it did not check.
  // Fifth security review, finding 6: the directory a record replaces is
  // never deleted recursively. What is left goes to the administrator's own
  // terminal, not only to a log.
  it('Windows: --replace over a directory that holds something else leaves it aside and says where, on stderr', { skip: process.platform !== 'win32' }, async () => {
    const s = setup();
    assert.equal(await run(s, io(), { flags: { yes: true } }), 0);
    fs.writeFileSync(path.join(s.configDir, 'identity', 'left-behind.txt'), 'x');
    const next = nodeKeys();
    writeIdentity(s.dataDir, stored(next));
    const t = io();
    assert.equal(await run(s, t, { flags: { yes: true, replace: true } }), 0);
    assert.match(t.text(), /Recorded\. /);
    assert.equal(seen(s).nodeId, next.nodeId);
    const aside = fs.readdirSync(s.configDir).filter((n) => n.startsWith('.identity.old-'));
    assert.equal(aside.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(s.configDir, aside[0])).sort(), ['left-behind.txt', 'node.json']);
    assert.ok(t.errors().includes(path.join(s.configDir, aside[0])));
    assert.match(t.errors(), /^Note: the identity record was written\. The directory it replaced was moved to .* holds 1 entry besides node\.json, and was not removed/);
    assert.doesNotMatch(t.errors(), /left-behind/);
  });

  // Fifth security review, finding 2, on doctor's side: run from a prompt
  // that is not elevated, doctor itself may not read the record. That is
  // said as such, with what to do, and not as something the service does.
  it('Windows: a record doctor may not read is "nothing was checked", with the elevated prompt as the remedy', { skip: process.platform !== 'win32' }, async () => {
    const s = setup();
    recordIdentity(s.configDir, s.keys);
    const fsImpl = { ...fs, lstatSync: (p, ...rest) => {
      if (path.basename(String(p)) === 'node.json') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.lstatSync(p, ...rest);
    } };
    const row = (await runDoctor({ dataDir: s.dataDir, configDir: s.configDir, adminUid: UID, deps: { identityRecord: { ...IDENTITY_RECORD_TEST_OPTIONS, fsImpl } } }))
      .filter((x) => x.check === 'node identity record')[0];
    assert.equal(row.ok, false);
    assert.match(row.detail, /could not be read by the account this ran as \(EPERM\)/);
    assert.match(row.detail, /run this from an elevated \(Administrator\) prompt\. Nothing about the record was checked$/);
    assert.doesNotMatch(row.detail, /identity record --replace|The service refuses to start/);
  });

  describe('what the row says it did not check, and the access lists on Windows', () => {
    const { identityMatchRow } = require('../src/service/doctor');
    const seen = { state: 'match', file: 'C:/cfg/identity/node.json', recorded: { nodeId: 'kl-aaaaaaaaaaaaaaaa' } };
    const ADMINS = 'S-1-5-32-544';
    const SERVICE = 'S-1-5-19';
    const USER = 'S-1-5-21-1-2-3-1001';
    const ace = (sid, mask, flags = 0, type = 0) => ({ type, sid, mask, flags });
    const FULL = 0x1f01ff;
    const READ = 0x1200a9;
    const MODIFY = 0x1301bf;
    const acl = (...aces) => ({ dacl: true, aces });
    const clean = () => [acl(ace('S-1-5-18', FULL, 3), ace(ADMINS, FULL, 3), ace(SERVICE, READ, 3)), acl(ace('S-1-5-18', FULL), ace(ADMINS, FULL), ace(SERVICE, READ))];
    const problem = (inspectAcl) => R.recordAclProblem({ configDir: 'C:/cfg', inspectAcl });

    it('off Windows: ok, with what was compared and what was not', () => {
      const r = identityMatchRow({ seen, platform: 'linux' });
      assert.equal(r.ok, true);
      assert.match(r.detail, /^kl-aaaaaaaaaaaaaaaa, recorded by an administrator in .*node\.json \(public keys compared; owner and mode read\)\. Not checked here: that the data dir holds this key's private half/);
    });

    it('Windows: the three things doctor can come to, each said', () => {
      const ok = identityMatchRow({ seen, platform: 'win32', acl: { state: 'clean' } });
      assert.equal(ok.ok, true);
      assert.ok(!ok.warn);
      assert.match(ok.detail, /public keys compared; owners and access lists read, of the record, its directory and the config dir: all three are owned by Administrators or SYSTEM, and no entry lets anyone else change them\)/);
      assert.match(ok.detail, /Not checked here: .*private half.*; whether the account the service runs as can write the record \(an administrator always can/);
      assert.match(ok.detail, /the service probes it itself when it starts and before each lease request/);
      const bad = identityMatchRow({ seen, platform: 'win32', acl: { state: 'writable', detail: `the access list of C:/cfg/identity lets ${SERVICE} change it` } });
      assert.equal(bad.ok, false);
      assert.match(bad.detail, /names this identity, but the access list of .* lets S-1-5-19 change it/);
      assert.match(bad.detail, /identity record --replace/);
      for (const unread of [{ state: 'unread', detail: 'the access lists of X and its directory could not be read' }, null]) {
        const r = identityMatchRow({ seen, platform: 'win32', acl: unread });
        assert.equal(r.ok, true);
        assert.match(r.detail, /\(public keys compared; owners read\)\. Not checked here: who can change the record \(.*; run doctor from an elevated prompt\)/);
        assert.match(r.detail, /whether the account the service runs as can write the record/);
        assert.doesNotMatch(r.detail, /only SYSTEM and Administrators/);
      }
    });

    // Fifth security review, finding 5: "clean" claimed more than was read.
    // The config dir was not read (delete-child there lets an account put a
    // directory of its own where identity is), and an owner that is not
    // Administrators or SYSTEM can rewrite a list whatever it says.
    describe('what doctor reads: the config dir too, and the owners', () => {
      const SYSTEM = 'S-1-5-18';
      const owned = (owner, ...aces) => ({ dacl: true, owner, aces });
      const dirAces = () => [ace(SYSTEM, FULL, 3), ace(ADMINS, FULL, 3), ace(SERVICE, READ, 3)];
      const fileAces = () => [ace(SYSTEM, FULL), ace(ADMINS, FULL), ace(SERVICE, READ)];
      const three = ({ config = ADMINS, dir = ADMINS, file = ADMINS, configAces = [], dirMore = [], fileMore = [] } = {}) => () => [
        owned(config, ...dirAces(), ...configAces), owned(dir, ...dirAces(), ...dirMore), owned(file, ...fileAces(), ...fileMore)
      ];
      const whole = (inspectAcl) => R.recordAclProblem({ configDir: 'C:/cfg', whole: true, inspectAcl });

      it('asks about the config dir, the directory of the record and the record', () => {
        const asked = [];
        assert.deepEqual(whole((paths) => { asked.push(paths); return three()(); }), { state: 'clean' });
        assert.deepEqual(asked, [['C:/cfg', path.join('C:/cfg', 'identity'), path.join('C:/cfg', 'identity', 'node.json')]]);
        assert.deepEqual(whole(three({ config: SYSTEM, dir: SYSTEM, file: SYSTEM })), { state: 'clean' });
      });

      it('an entry on the config dir that lets someone else change what it holds is "writable"', () => {
        // delete child alone, add subdirectory alone, WRITE_DAC alone, WRITE_OWNER alone, delete alone.
        for (const mask of [0x40, 0x4, 0x40000, 0x80000, 0x10000]) {
          const r = whole(three({ configAces: [ace(SERVICE, READ | mask, 0)] }));
          assert.equal(r.state, 'writable', mask.toString(16));
          assert.equal(r.detail, 'the access list of C:/cfg lets S-1-5-19 change it');
          assert.equal(r.where, 'config');
        }
        // An inherit-only entry gives nothing on the config dir itself; the directory and the record are read themselves.
        assert.deepEqual(whole(three({ configAces: [ace(USER, MODIFY, 0xb)] })), { state: 'clean' });
        // Below the config dir, as before.
        assert.equal(whole(three({ fileMore: [ace(USER, 0x40000)] })).where, 'record');
        assert.match(whole(three({ dirMore: [ace(SERVICE, MODIFY, 0x9)] })).detail, /identity lets S-1-5-19 change it, through an entry that the files in it inherit/);
      });

      it('lists that name nobody else, under an owner that is not Administrators or SYSTEM, are not "clean"', () => {
        for (const [o, where] of [[{ config: USER }, /C:\/cfg is owned by S-1-5-21-1-2-3-1001/], [{ dir: SERVICE }, /identity is owned by S-1-5-19/], [{ file: USER }, /node\.json is owned by S-1-5-21-1-2-3-1001/]]) {
          const r = whole(three(o));
          assert.equal(r.state, 'owner', JSON.stringify(o));
          assert.match(r.detail, where);
          assert.match(r.detail, /which is neither Administrators nor SYSTEM: an owner can rewrite an access list whatever it says/);
        }
        // An owner the inspector did not report is not assumed.
        for (const owner of [undefined, null, '', 'nobody']) {
          const r = whole(() => [owned(ADMINS, ...dirAces()), owned(ADMINS, ...dirAces()), { dacl: true, ...(owner === undefined ? {} : { owner }), aces: fileAces() }]);
          assert.equal(r.state, 'owner', String(owner));
          assert.match(r.detail, /the owner of .*node\.json was not read/);
        }
        // Somebody who can change it is the stronger finding.
        assert.equal(whole(three({ config: USER, fileMore: [ace(USER, 0x2)] })).state, 'writable');
      });

      it('fewer answers than paths asked about is "unread", and says which three', () => {
        const r = whole(() => three()().slice(1));
        assert.equal(r.state, 'unread');
        assert.match(r.detail, /the access lists of .*node\.json, its directory and the config dir could not be read/);
      });

      it('the row: clean only on a clean answer; an owner that is not an administrator is said, with what was and was not read', () => {
        const row = (acl) => identityMatchRow({ seen, platform: 'win32', acl });
        const owner = row(whole(three({ config: USER })));
        assert.equal(owner.ok, true);
        assert.equal(owner.warn, true);
        assert.match(owner.detail, /public keys compared; owners and access lists read, of the record, its directory and the config dir: no entry lets anyone but SYSTEM and Administrators change them, but C:\/cfg is owned by S-1-5-21-1-2-3-1001, which is neither Administrators nor SYSTEM: an owner can rewrite an access list whatever it says\)/);
        assert.doesNotMatch(owner.detail, /all three are owned by Administrators or SYSTEM/);
        assert.match(owner.detail, /Not checked here: .*private half/);
        const config = row(whole(three({ configAces: [ace(SERVICE, 0x40)] })));
        assert.equal(config.ok, false);
        assert.match(config.detail, /names this identity, but the access list of C:\/cfg lets S-1-5-19 change it/);
        assert.match(config.detail, /can put a directory of its own in place of the one that holds the record/);
        assert.match(config.detail, /identity record --replace/);
        const unread = row(whole(() => { throw new Error('powershell failed'); }));
        assert.equal(unread.ok, true);
        assert.match(unread.detail, /\(public keys compared; owners read\)\. Not checked here: who can change the record \(the access lists of .*node\.json, its directory and the config dir could not be read; run doctor from an elevated prompt\)/);
      });

      it('the owner is read from the "path" line of the inspector', () => {
        assert.deepEqual(R.parseAclOutput('path dacl S-1-5-32-544\nace 0 S-1-5-18 001f01ff 3\npath nodacl S-1-5-18\npath dacl -\n'), [
          { dacl: true, owner: 'S-1-5-32-544', aces: [{ type: 0, sid: 'S-1-5-18', mask: 0x1f01ff, flags: 3 }] }, { dacl: false, owner: 'S-1-5-18', aces: [] }, { dacl: true, aces: [] }
        ]);
        for (const bad of ['path dacl Everyone', 'path dacl S-1-5-18 extra', 'path  dacl']) assert.throws(() => R.parseAclOutput(bad), bad);
      });
    });

    it('recordAclProblem: clean only when nobody but SYSTEM and Administrators may change the record or its directory', () => {
      assert.deepEqual(problem(clean), { state: 'clean' });
      // The reviewer's case: nothing new can be made in the directory, and every file in it inherits "modify".
      const inherit = problem(() => [acl(ace(ADMINS, FULL, 3), ace(SERVICE, READ, 0), ace(SERVICE, MODIFY, 0x9)), clean()[1]]);
      assert.equal(inherit.state, 'writable');
      assert.match(inherit.detail, /identity lets S-1-5-19 change it, through an entry that the files in it inherit/);
      // The record itself; any one write right is enough (WRITE_DAC alone, delete alone).
      for (const mask of [MODIFY, 0x2, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000 | 0, 0x40]) {
        const r = problem(() => [clean()[0], acl(ace(ADMINS, FULL), ace(USER, READ | mask))]);
        assert.equal(r.state, 'writable', mask.toString(16));
        assert.match(r.detail, /node\.json lets S-1-5-21-1-2-3-1001 change it$/);
      }
      // Reading is not changing; a deny entry only takes away.
      assert.deepEqual(problem(() => [clean()[0], acl(ace(ADMINS, FULL), ace(USER, READ), ace(SERVICE, MODIFY, 0, 1))]), { state: 'clean' });
      // No access list at all.
      assert.match(problem(() => [clean()[0], { dacl: false, aces: [] }]).detail, /has no access list at all, so anyone can change it/);
      // Whatever cannot be read or judged is "unread", never "clean".
      for (const inspectAcl of [
        () => { throw new Error('powershell failed'); }, () => null, () => [clean()[0]], () => [clean()[0], null],
        () => [clean()[0], acl({ other: true })], () => [clean()[0], acl(ace(USER, READ, 0, 9))], () => [clean()[0], acl(ace('nobody', READ))],
        () => [clean()[0], acl({ type: 0, sid: USER, mask: 'ffffffff', flags: 0 })]
      ]) {
        assert.equal(problem(inspectAcl).state, 'unread');
      }
    });

    it('parseAclOutput reads the inspector\'s lines, and refuses anything else', () => {
      const out = 'path dacl\r\nace 0 S-1-5-18 001f01ff 3\r\nace 0 S-1-5-19 ffffffff 11\r\nace other\r\nmissing\r\npath nodacl\r\n';
      assert.deepEqual(R.parseAclOutput(out), [
        { dacl: true, aces: [{ type: 0, sid: 'S-1-5-18', mask: 0x1f01ff, flags: 3 }, { type: 0, sid: 'S-1-5-19', mask: 0xffffffff, flags: 11 }, { other: true }] },
        null, { dacl: false, aces: [] }
      ]);
      for (const bad of ['ace 0 S-1-5-18 001f01ff 3', 'path dacl\nace 0 Everyone 001f01ff 3', 'path dacl\nsomething else']) assert.throws(() => R.parseAclOutput(bad));
    });

    it('doctor fails the row when the access lists let someone else change the record (Windows)', { skip: process.platform !== 'win32' }, async () => {
      const s = setup();
      recordIdentity(s.configDir, s.keys);
      const withAcl = async (inspectAcl) => (await runDoctor({ dataDir: s.dataDir, configDir: s.configDir, adminUid: UID, deps: { identityRecord: { ...IDENTITY_RECORD_TEST_OPTIONS, inspectAcl } } }))
        .filter((x) => x.check === 'node identity record')[0];
      // doctor asks about three paths (fifth security review, finding 5): the config dir first.
      const config = () => ({ ...clean()[0], owner: ADMINS });
      const ownedClean = () => [config(), ...clean().map((e) => ({ ...e, owner: ADMINS }))];
      const cleanRow = await withAcl(ownedClean);
      assert.equal(cleanRow.ok, true);
      assert.match(cleanRow.detail, /all three are owned by Administrators or SYSTEM, and no entry lets anyone else change them/);
      const r = await withAcl(() => [config(), { ...acl(ace(ADMINS, FULL, 3), ace(SERVICE, MODIFY, 0x9)), owner: ADMINS }, ownedClean()[2]]);
      assert.equal(r.ok, false);
      assert.match(r.detail, /lets S-1-5-19 change it, through an entry that the files in it inherit/);
      const swap = await withAcl(() => [{ ...acl(ace(ADMINS, FULL, 3), ace(SERVICE, READ | 0x40, 0)), owner: ADMINS }, ...ownedClean().slice(1)]);
      assert.equal(swap.ok, false);
      assert.match(swap.detail, /the access list of .*config lets S-1-5-19 change it/);
      // The two-path answer of before is not three: not read, and said so.
      const two = await withAcl(clean);
      assert.equal(two.ok, true);
      assert.match(two.detail, /Not checked here: who can change the record/);
      // The answer the test helper gives, as every other doctor test gets it.
      const helper = (await runDoctor({ dataDir: s.dataDir, configDir: s.configDir, adminUid: UID, deps: { identityRecord: IDENTITY_RECORD_TEST_OPTIONS } })).filter((x) => x.check === 'node identity record')[0];
      assert.match(helper.detail, /all three are owned by Administrators or SYSTEM/);
    });

    // The real inspector (PowerShell, nothing injected), on a temp dir this
    // account owns: as far as an account that is not elevated can show it.
    it('for real: the access lists of a temp dir are read, and the reviewer\'s inherit-only entry is found', { skip: process.platform !== 'win32' }, () => {
      const { execFileSync } = require('child_process');
      const sys = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
      const me = execFileSync(sys('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split(',').pop().replace(/"/g, '');
      const s = setup();
      recordIdentity(s.configDir, s.keys);
      const dir = path.dirname(R.recordPath(s.configDir));
      // As a temp dir is: this account has full control, inherited.
      const plain = R.recordAclProblem({ configDir: s.configDir });
      assert.equal(plain.state, 'writable', JSON.stringify(plain));
      // The config dir is read too when doctor asks, and every path comes with its owner.
      let read = null;
      const wholeDir = R.recordAclProblem({ configDir: s.configDir, whole: true, inspectAcl: (paths) => { read = R.inspectWindowsAcl(paths); return read; } });
      assert.equal(wholeDir.state, 'writable', JSON.stringify(wholeDir));
      assert.equal(wholeDir.where, 'config', 'a temp dir: this account has full control of the config dir itself');
      assert.equal(read.length, 3);
      for (const entry of read) assert.match(entry.owner, /^S-1-(\d+-)*\d+$/);
      try {
        // Read and list for this account, and "modify" for every file in the directory, inherit-only.
        execFileSync(sys('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${me}:(RX)`, `*${me}:(OI)(IO)(M)`], { stdio: 'ignore', windowsHide: true });
        const seen = R.recordAclProblem({ configDir: s.configDir });
        assert.equal(seen.state, 'writable', JSON.stringify(seen));
        assert.ok(seen.detail.includes(me));
        assert.match(seen.detail, /through an entry that the files in it inherit/);
      } finally {
        try { execFileSync(sys('icacls.exe'), [dir, '/reset', '/T'], { stdio: 'ignore', windowsHide: true }); } catch { /* cleanup reports what is left */ }
      }
    });
  });
});
