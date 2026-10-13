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
});
