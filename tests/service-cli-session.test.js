// tests/service-cli-session.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessionCommand, readNodeIdentity } = require('../src/service/commands/session');
const { main, parseArgs } = require('../src/service/cli');
const S = require('../src/gui/session-secret');
const { writeGuiStatus } = require('../src/gui/status');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { deriveNodeId } = require('../src/mesh/node-identity');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const KEY = crypto.randomBytes(32);
// A node identity as the service stores it (src/mesh/mesh-identity.js): the
// public key in the clear, the private key under the master key, at the
// store's dot path mesh.identity.
function nodeKeys() {
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { publicKey: pair.publicKey, privateHex: pair.privateKey.toString('hex'), nodeId: deriveNodeId(pair.publicKey) };
}
const identity = nodeKeys();
function storedIdentity(keys = identity, { key = KEY, plaintext = false } = {}) {
  if (plaintext) return { publicKey: keys.publicKey.toString('hex'), privateKey: keys.privateHex };
  return { publicKey: keys.publicKey.toString('hex'), privateKey: null, keyEncryption: 'cipher-v1', encryptedPrivateKey: createAesGcmCipher(key).encryptString(keys.privateHex) };
}
const writeIdentity = (dataDir, record) => fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: record } }));

function setup({ withIdentity = true } = {}) {
  // Native realpath: session-secret.js requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-session-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  const ipcDir = path.join(base, 'ipc');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  if (withIdentity) writeIdentity(dataDir, storedIdentity());
  return { base, dataDir, configDir, ipcDir };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: (t) => err.push(String(t)) }, stdin: null } };
}

const account = (name) => ({ user: name, uid: UID, gid: GID, home: os.homedir(), sid: POSIX ? null : 'S-1-5-21-1-2-3-1001' });
// Another person: a different SID (uid off Windows), whatever the name. On
// POSIX nothing is ever written for this uid (a test process cannot chown to
// it): every use of it is an install that must be refused.
const otherAccount = (name) => ({ user: name, uid: UID + 1, gid: GID, home: os.homedir(), sid: POSIX ? null : 'S-1-5-21-9-9-9-2001' });
const who = (a) => (POSIX ? `uid ${a.uid}` : `SID ${a.sid}`);
// A second real install in one test: another SID on Windows; elsewhere this
// process's own uid, the only one a test can write a file for.
const otherAccountForInstall = (name) => (POSIX ? account(name) : otherAccount(name));

function deps(s, extra = {}) {
  const executed = [];
  return {
    executed,
    platform: process.platform,
    isAdmin: () => true,
    // R-F5-9: a terminal whose owner answers yes, unless a test says otherwise.
    isTTY: () => true,
    confirm: async () => true,
    resolveSessionUser: (name) => account(name),
    resolveKey: () => ({ key: KEY, source: 'test' }),
    verifyKey: () => {},
    dataDirOwnerUid: UID,
    configDir: s.configDir,
    ipcDir: s.ipcDir,
    runIcacls: () => {},
    // The real check runs PowerShell against the config dir's ACL; a temp
    // dir would fail it, and it is the installers' to test.
    verifyConfigDir: () => {},
    execute: async (steps) => { executed.push(steps); },
    entryPath: '/opt/kl/bin/king-louie-service.js',
    nodePath: '/usr/bin/node',
    adminUid: UID,
    ...extra
  };
}

const canonical = (configDir) => JSON.parse(fs.readFileSync(S.canonicalPath(configDir), 'utf8'));

// Every file under a dir with its bytes, so "nothing was written" is checked
// on Windows too (where the fake account has one SID for every name).
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath || entry.path, entry.name);
    out[path.relative(dir, file)] = entry.isFile() ? fs.readFileSync(file, 'hex') : null;
  }
  return out;
}

describe('session install', () => {
  it('needs an administrator', async () => {
    const s = setup();
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { isAdmin: () => false }) }), 1);
    assert.match(t.err.join(''), /root|Administrator/);
  });

  it('writes the canonical secret, the per-user copy and the login start; a second run rotates', async () => {
    const s = setup();
    const t = io();
    const d = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    const first = canonical(s.configDir);
    assert.equal(first.node_id, identity.nodeId);
    assert.equal(first.session_user, 'alice');
    assert.match(first.secret, /^klc1:/);
    const copyFile = S.userCopyPath({ platform: process.platform, configDir: s.configDir, user: 'alice', sid: account('alice').sid });
    const copy = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
    const cipher = createAesGcmCipher(KEY);
    assert.equal(copy.secret, cipher.decryptString(first.secret));
    assert.equal(copy.endpoint, S.endpointPath({ platform: process.platform, endpointId: first.endpoint_id, ipcDir: s.ipcDir }));
    assert.equal(d.executed.length, 1);
    assert.match(t.out.join(''), /installed for alice/);
    if (POSIX) assert.equal(fs.statSync(s.ipcDir).mode & 0o777, 0o711);

    // A second run rotates the secret and keeps the endpoint (security review
    // finding 6): the running service listens on the endpoint it started
    // with, so a new one would leave the helper nowhere to reconnect to.
    const t2 = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t2.io, deps: d }), 0);
    const second = canonical(s.configDir);
    assert.equal(second.endpoint_id, first.endpoint_id);
    assert.notEqual(cipher.decryptString(second.secret), cipher.decryptString(first.secret));
    const copy2 = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
    assert.equal(copy2.endpoint, copy.endpoint);
    assert.equal(copy2.secret, cipher.decryptString(second.secret));
    assert.match(t2.out.join(''), /The secret was rotated and the endpoint kept/);
    assert.match(t2.out.join(''), /no restart is needed/);
    assert.doesNotMatch(t.out.join(''), /rotated/, 'a first install says to restart the service instead');
    assert.match(t.out.join(''), /Restart the King Louie service/);
  });

  it('R-F5-2 (owner question 2): refuses a second session user until the first is uninstalled', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const t = io();
    const before = tree(s.base);
    assert.ok(Object.keys(before).some((k) => k.endsWith(`${account('alice').sid || 'alice'}.json`)), 'the snapshot holds the first install');
    const bob = deps(s, { resolveSessionUser: (name) => (name === 'bob' ? otherAccount(name) : account(name)) });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'bob' }, dataDir: s.dataDir, io: t.io, deps: bob }), 1);
    assert.match(t.err.join(''), /session_user_mismatch: installed for "alice" \((SID|uid) [^)]+\), not bob \((SID|uid) [^)]+\); run "session uninstall --user alice" first/);
    assert.deepEqual(tree(s.base), before, 'the refused install wrote, changed and removed nothing');
    assert.equal(bob.executed.length, 0, 'no login-start step ran for bob');
    // Nothing of bob's was written, and alice's install is untouched.
    assert.equal(canonical(s.configDir).session_user, 'alice');
    // (On Windows the copy is named by SID, and this test's fake account has one SID for every name.)
    if (POSIX) assert.equal(fs.existsSync(S.userCopyPath({ platform: process.platform, configDir: s.configDir, user: 'bob' })), false);
    // After alice is uninstalled, bob installs.
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'bob' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    assert.equal(canonical(s.configDir).session_user, 'bob');
  });

  it('refuses before writing when the service never ran (no identity) or there is no master key', async () => {
    const s = setup({ withIdentity: false });
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 1);
    assert.match(t.err.join(''), /start the service once first/);
    assert.equal(fs.existsSync(path.join(s.configDir, 'session')), false);
    const s2 = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s2.dataDir, io: io().io, deps: deps(s2, { resolveKey: () => null }) }), 1);
    assert.equal(fs.existsSync(S.canonicalPath(s2.configDir)), false);
  });

  it('--dry-run writes nothing and prints the plan', async () => {
    const s = setup();
    const t = io();
    const d = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.match(t.out.join(''), /\[dry-run\]/);
  });

  it('needs --user', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: {}, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 2);
  });
});

// R-F5-9 (owner ruling, 2026-10-12): install and uninstall say what they are
// about to do and ask first, like "desktop pair" and "enroll-device".
describe('R-F5-9: session install and uninstall ask for consent', () => {
  const identityText = POSIX ? `uid ${UID}` : 'SID S-1-5-21-1-2-3-1001';

  it('install off a terminal without --yes refuses (exit 2) before it resolves, reads or writes anything', async () => {
    const s = setup();
    const before = tree(s.base);
    const t = io();
    const touched = [];
    const d = deps(s, {
      isTTY: () => false,
      confirm: async () => { throw new Error('must not ask off a terminal'); },
      resolveSessionUser: (name) => { touched.push('user'); return account(name); },
      resolveKey: () => { touched.push('key'); return { key: KEY, source: 'test' }; }
    });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 2);
    assert.match(t.err.join(''), /Refusing to install the session helper without confirmation on a non-interactive terminal; pass --yes\./);
    assert.deepEqual(touched, []);
    assert.equal(d.executed.length, 0);
    assert.deepEqual(tree(s.base), before);
  });

  it('install prints the user by name and SID/uid, the node, what the helper can do and where it starts, then asks; a no writes nothing', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.configDir, 'node.yaml'), 'name: gpu-box\n', { mode: 0o644 });
    const before = tree(s.base);
    const t = io();
    let asked = null;
    const d = deps(s, {
      confirm: async (question) => {
        asked = { question, printed: t.out.join(''), tree: tree(s.base), executed: d.executed.length };
        return false;
      }
    });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    assert.ok(asked, 'the owner was asked');
    assert.match(asked.question, /^Install the session helper for alice\? \[y\/N\] $/);
    assert.ok(asked.printed.includes(`alice (${identityText})`), asked.printed);
    assert.ok(asked.printed.includes(`node "gpu-box" (${identity.nodeId})`), asked.printed);
    assert.match(asked.printed, /launch the apps in gui\.apps, capture their windows and, under a lease signed on the owner's phone, click and type in them/);
    assert.match(asked.printed, /starts at every login of alice: /);
    assert.ok(asked.printed.includes(S.canonicalPath(s.configDir)), 'names the file it would write');
    assert.deepEqual(asked.tree, before, 'nothing existed yet when the question was asked');
    assert.equal(asked.executed, 0);
    assert.match(t.err.join(''), /Not installing without confirmation\. Nothing was written\./);
    assert.deepEqual(tree(s.base), before, 'a no wrote nothing: no secret, no copy, no directory');
    assert.equal(d.executed.length, 0, 'and no login start');
  });

  it('install proceeds on a yes at the terminal, and with --yes off a terminal without asking', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s, { confirm: async () => true }) }), 0);
    assert.equal(canonical(s.configDir).session_user, 'alice');
    const s2 = setup();
    const d2 = deps(s2, { isTTY: () => false, confirm: async () => { throw new Error('must not ask with --yes'); } });
    const t2 = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', yes: true }, dataDir: s2.dataDir, io: t2.io, deps: d2 }), 0);
    assert.equal(canonical(s2.configDir).session_user, 'alice');
    assert.ok(t2.out.join('').includes(`alice (${identityText})`), '--yes still prints what is granted');
  });

  it('uninstall off a terminal without --yes refuses (exit 2) and removes nothing', async () => {
    const s = setup();
    const d = deps(s);
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d });
    const before = tree(s.base);
    const t = io();
    const touched = [];
    const d2 = deps(s, { isTTY: () => false, confirm: async () => { throw new Error('must not ask'); }, resolveSessionUser: (name) => { touched.push('user'); return account(name); } });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d2 }), 2);
    assert.match(t.err.join(''), /Refusing to remove the session helper without confirmation on a non-interactive terminal; pass --yes\./);
    assert.deepEqual(touched, []);
    assert.equal(d2.executed.length, 0);
    assert.deepEqual(tree(s.base), before);
  });

  it('uninstall says what it removes, then asks; a no removes nothing, a yes or --yes removes it', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const before = tree(s.base);
    const t = io();
    let asked = null;
    const d = deps(s, { confirm: async (question) => { asked = { question, printed: t.out.join('') }; return false; } });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    assert.match(asked.question, /^Remove the session helper for alice\? \[y\/N\] $/);
    assert.ok(asked.printed.includes(`alice (${identityText})`), asked.printed);
    assert.ok(asked.printed.includes(S.canonicalPath(s.configDir)), 'names the service file it removes');
    assert.ok(asked.printed.includes(S.userCopyPath({ platform: process.platform, configDir: s.configDir, user: 'alice', sid: account('alice').sid })), 'names the per-user copy');
    assert.match(asked.printed, /login start/);
    assert.match(t.err.join(''), /Not removing without confirmation\. Nothing was removed\./);
    assert.deepEqual(tree(s.base), before);
    assert.equal(d.executed.length, 0);

    const d2 = deps(s, { isTTY: () => false, confirm: async () => { throw new Error('must not ask with --yes'); } });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice', yes: true }, dataDir: s.dataDir, io: io().io, deps: d2 }), 0);
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.equal(d2.executed.length, 1);
  });

  it('--dry-run asks nothing and writes nothing, on a terminal or off one', async () => {
    const s = setup();
    const before = tree(s.base);
    const d = deps(s, { isTTY: () => false, confirm: async () => { throw new Error('a dry run asks nothing'); } });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.deepEqual(tree(s.base), before);
  });
});

// R-F5-10 (owner ruling, 2026-10-12): who is installed is the recorded SID
// (uid off Windows), never the name; a file that cannot answer refuses.
describe('R-F5-10: the second-user check compares identities and fails closed', () => {
  // The same bare name for two different people: a local account and a
  // domain account on Windows, a deleted and re-created user elsewhere.
  const sameNameOtherPerson = POSIX ? 'alice' : 'CORP\\alice';

  it('the same name with another SID (uid) is another user: refused, nothing written', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    const before = tree(s.base);
    const t = io();
    const d = deps(s, { resolveSessionUser: (name) => otherAccount(name) });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: sameNameOtherPerson }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    const err = t.err.join('');
    assert.match(err, /^session_user_mismatch: installed for "alice"/);
    assert.ok(err.includes(who(account('alice'))) && err.includes(who(otherAccount('alice'))), err);
    assert.match(err, /run "session uninstall --user alice" first/);
    assert.deepEqual(tree(s.base), before);
    assert.equal(d.executed.length, 0);
  });

  it('the same SID (uid) under another spelling of the name is the same user: the install rotates', async () => {
    const s = setup();
    const d = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    const first = canonical(s.configDir);
    assert.equal(POSIX ? first.session_uid : first.session_sid, POSIX ? UID : account('alice').sid, 'the identity is recorded');
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: POSIX ? 'alice' : 'CORP\\alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(canonical(s.configDir).endpoint_id, first.endpoint_id, 'a rotation keeps the endpoint (finding 6)');
    assert.notEqual(canonical(s.configDir).secret, first.secret);
  });

  // Each damages an installed helper file in a way that leaves "who is
  // installed" unanswerable.
  const damages = {
    'is not JSON': (file) => fs.writeFileSync(file, '{ not json'),
    'records no identity': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.session_sid;
      delete raw.session_uid;
      fs.writeFileSync(file, JSON.stringify(raw));
    },
    'records a malformed identity': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, session_sid: 'alice', session_uid: 'alice' }));
    },
    'does not decrypt (another master key)': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, secret: createAesGcmCipher(crypto.randomBytes(32)).encryptString('ab'.repeat(32)) }));
    },
    'holds no valid secret': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, secret: createAesGcmCipher(KEY).encryptString('nope') }));
    },
    'cannot be read as a file (a directory)': (file) => { fs.unlinkSync(file); fs.mkdirSync(file); }
  };

  for (const [name, damage] of Object.entries(damages)) {
    it(`an existing helper file that ${name} refuses a new install and writes nothing; uninstall clears it`, async () => {
      const s = setup();
      assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
      const file = S.canonicalPath(s.configDir);
      damage(file);
      if (POSIX && fs.statSync(file).isFile()) fs.chmodSync(file, 0o640);
      const before = tree(s.base);
      // Refused for the same user and for another one alike.
      for (const d of [deps(s), deps(s, { resolveSessionUser: (n) => otherAccount(n) })]) {
        const t = io();
        const code = await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d });
        assert.notEqual(code, 0);
        assert.match(t.err.join(''), /^session_file_invalid: /);
        assert.match(t.err.join(''), /run "session uninstall --user NAME" to clear it, or fix the file/);
        assert.doesNotMatch(t.err.join(''), /klc1:/, 'no ciphertext in the message');
        assert.equal(d.executed.length, 0);
        assert.deepEqual(tree(s.base), before, 'the refused install wrote nothing');
      }
      // The owner is never stuck: uninstall says it clears the damaged file, and does.
      const t = io();
      assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 0);
      if (/JSON|identity|directory/.test(name)) assert.match(t.out.join(''), /cannot tell who it was installed for/);
      assert.equal(fs.existsSync(file), false);
      assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
      assert.equal(canonical(s.configDir).session_user, 'alice');
    });
  }

  it('uninstalling another user leaves the installed user\'s helper file alone', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    const before = canonical(s.configDir);
    const t = io();
    const d = deps(s, { resolveSessionUser: (name) => otherAccount(name) });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: sameNameOtherPerson }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    assert.deepEqual(canonical(s.configDir), before, 'alice (by SID/uid) is still installed');
    assert.match(t.out.join(''), /stays: it is installed for "alice"/);
  });
});

describe('security review finding 6: a rotation keeps the endpoint only for the same, verified install', () => {
  it('after an uninstall the next install gets a new endpoint', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const first = canonical(s.configDir);
    await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    assert.notEqual(canonical(s.configDir).endpoint_id, first.endpoint_id);
  });

  it('--dry-run and a declined rotation leave the secret and the endpoint as they were', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const before = tree(s.base);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { confirm: async () => false }) }), 1);
    assert.match(t.out.join(''), /replaces the secret installed for alice; the endpoint stays/);
    assert.deepEqual(tree(s.base), before);
  });
});

// Security review finding 13e: an account that no longer exists must not
// leave the node unable to install anyone else.
describe('finding 13e: session uninstall for an account that no longer resolves', () => {
  const { GuiError } = require('../src/gui/errors');
  const gone = (name) => { throw new GuiError('user_not_found', name); };

  it('works from the identity the helper file records, says so, and frees the node for another user', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const copyFile = S.userCopyPath({ platform: process.platform, configDir: s.configDir, user: 'alice', sid: account('alice').sid });
    assert.equal(fs.existsSync(copyFile), true);
    const t = io();
    const d = deps(s, { resolveSessionUser: gone });
    let asked = null;
    d.confirm = async () => { asked = t.out.join(''); return true; };
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    assert.match(asked, /no longer exists on this machine/);
    assert.ok(asked.includes(who(account('alice'))), 'the recorded SID/uid is shown');
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.equal(fs.existsSync(copyFile), false);
    // Windows: the logon task is deleted by name. Elsewhere the login start
    // is a file in a home that cannot be reached as a user who is gone.
    assert.equal(d.executed.length, POSIX ? 0 : 1);
    if (POSIX) assert.match(t.out.join(''), /login start .* could not be removed/);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'bob' }, dataDir: s.dataDir, io: io().io, deps: deps(s, { resolveSessionUser: (n) => otherAccountForInstall(n) }) }), 0);
    assert.equal(canonical(s.configDir).session_user, 'bob');
  });

  it('a name the helper file does not record is still user_not_found, and removes nothing', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const before = tree(s.base);
    const t = io();
    const d = deps(s, { resolveSessionUser: gone });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'mallory' }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    assert.match(t.err.join(''), /^user_not_found/);
    assert.deepEqual(tree(s.base), before);
    assert.equal(d.executed.length, 0);
    // And with nothing installed at all.
    const s2 = setup();
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s2.dataDir, io: io().io, deps: deps(s2, { resolveSessionUser: gone }) }), 1);
  });

  it('off a terminal it still needs --yes, and a no removes nothing', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const before = tree(s.base);
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s, { resolveSessionUser: gone, isTTY: () => false }) }), 2);
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s, { resolveSessionUser: gone, confirm: async () => false }) }), 1);
    assert.deepEqual(tree(s.base), before);
  });
});

// Security review finding 3: on Windows the config dir's owner and ACL are
// verified before the secret goes into it.
describe('finding 3: session install verifies the Windows config dir', () => {
  it('runs the check after consent and before anything is written; a failure refuses the install', { skip: POSIX }, async () => {
    const s = setup();
    const before = tree(s.base);
    const order = [];
    const t = io();
    const d = deps(s, {
      confirm: async () => { order.push('consent'); return true; },
      verifyConfigDir: (configDir) => { order.push('verify'); assert.equal(configDir, s.configDir); assert.deepEqual(tree(s.base), before); throw new Error(`the ACL of ${configDir} is not safe`); }
    });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    assert.deepEqual(order, ['consent', 'verify']);
    assert.match(t.err.join(''), /is not safe/);
    assert.match(t.err.join(''), /Nothing was written/);
    assert.deepEqual(tree(s.base), before);
    assert.equal(d.executed.length, 0);
    // A config dir that passes installs.
    const ok = deps(s, { verifyConfigDir: () => { order.push('verify-ok'); } });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: ok }), 0);
    assert.equal(order.at(-1), 'verify-ok');
  });

  it('the real check (the installers\' script, in PowerShell) refuses a config dir that is not the administrators\'', { skip: POSIX }, async () => {
    // A temp dir this user owns, with the ACL it inherited: exactly what
    // must be refused. The script only reads it.
    const s = setup();
    const before = tree(s.base);
    const t = io();
    const d = deps(s, { verifyConfigDir: undefined });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 1);
    assert.match(t.err.join(''), /is not safe|not Administrators or SYSTEM|unexpected ACE/);
    assert.match(t.err.join(''), /Nothing was written/);
    assert.deepEqual(tree(s.base), before);
    assert.equal(d.executed.length, 0);
  });

  it('a dry run verifies nothing (the check can create the directory), and off Windows there is no such check', async () => {
    const s = setup();
    let called = 0;
    const d = deps(s, { verifyConfigDir: () => { called += 1; } });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(called, 0);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(called, POSIX ? 0 : 1);
  });
});

describe('session uninstall, status, probe', () => {
  it('uninstall removes the copy, the canonical secret and the login start', async () => {
    const s = setup();
    const d = deps(s);
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.equal(d.executed.length, 2);
  });

  it('status shows the running helper and its probes, or says none reports', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dataDir, 'service.pid'), String(process.pid));
    let t = io();
    assert.equal(await runSessionCommand({ sub: 'status', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 0);
    assert.match(t.out.join(''), /no running service reports a session helper/);
    writeGuiStatus(s.dataDir, {
      v: 1, pid: process.pid, available: true, user: 'alice', platform: 'darwin', capabilities: ['gui.launch'],
      probes: [{ check: 'accessibility', ok: false, hint: 'grant Accessibility to /usr/local/bin/node' }], limits: [], apps: [], since: 'x',
      updated_at: new Date().toISOString(), lease: null
    });
    t = io();
    await runSessionCommand({ sub: 'status', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) });
    assert.match(t.out.join(''), /helper: connected \(alice, darwin\)/);
    assert.match(t.out.join(''), /accessibility: missing — grant Accessibility/);
  });

  it('probe prints the running helper\'s report, or a clearly labelled local probe', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dataDir, 'service.pid'), String(process.pid));
    let t = io();
    await runSessionCommand({ sub: 'probe', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s, { localProbe: async () => ({ capabilities: ['gui.launch'], probes: [{ check: 'display', ok: true }], limits: [] }) }) });
    assert.match(t.out.join(''), /local probe from this shell, not the running helper/);
    writeGuiStatus(s.dataDir, { v: 1, pid: process.pid, available: true, user: 'alice', platform: 'win32', capabilities: ['gui.input'], probes: [{ check: 'send_input', ok: true }], limits: [], apps: [], since: 'x', updated_at: new Date().toISOString(), lease: null });
    t = io();
    await runSessionCommand({ sub: 'probe', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) });
    assert.match(t.out.join(''), /from the running helper/);
    assert.match(t.out.join(''), /send_input: ok/);
  });
});

describe('the CLI', () => {
  it('knows the session command and its flag', async () => {
    assert.equal(parseArgs(['session', '--session-file', '/x.json']).flags.sessionFile, '/x.json');
    const t = io();
    assert.equal(await main(['session', 'bogus'], t.io), 2);
    const t2 = io();
    assert.equal(await main(['status', '--session-file', '/x.json'], t2.io), 2);
    assert.match(t2.err.join(''), /only valid for "session"/);
    // R-F5-9: --yes belongs to install and uninstall. (Without --user both
    // stop at their usage text, so this never reaches a real install.)
    for (const sub of ['install', 'uninstall']) {
      const t3 = io();
      assert.equal(await main(['session', sub, '--yes'], t3.io), 2);
      assert.doesNotMatch(t3.err.join(''), /"--yes" is only valid/);
      assert.match(t3.err.join(''), new RegExp(`session ${sub} --user NAME \\[--data-dir DIR\\] \\[--dry-run\\] \\[--yes\\]`));
    }
    // Every other session command still refuses it.
    for (const argv of [['session', '--yes'], ['session', 'status', '--yes'], ['session', 'probe', '--yes'], ['session', '_write-autostart', '/x', '--yes'], ['session', '_remove-autostart', '/x', '--yes']]) {
      const t4 = io();
      assert.equal(await main(argv, t4.io), 2, argv.join(' '));
      assert.match(t4.err.join(''), /"--yes" is only valid for "desktop pair", "device apply", "session install" and "session uninstall"/);
    }
    const help = io();
    await main(['help'], help.io);
    assert.match(help.out.join(''), /king-louie-service session install --user NAME \[--data-dir DIR\] \[--dry-run\] \[--yes\]/);
    assert.match(help.out.join(''), /king-louie-service session uninstall --user NAME \[--data-dir DIR\] \[--dry-run\] \[--yes\]/);
  });

  it('session runs the helper and returns its exit code', async () => {
    const s = setup();
    const t = io();
    let seen = null;
    const code = await runSessionCommand({ sub: undefined, flags: { sessionFile: '/x.json' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { runHelper: async (opts) => { seen = opts; return 1; } }) });
    assert.equal(code, 1);
    assert.equal(seen.sessionFile, '/x.json');
  });

  it('readNodeIdentity reads the identity where the store keeps it (mesh.identity as a dot path), or null', () => {
    const s = setup();
    const cipher = createAesGcmCipher(KEY);
    assert.equal(readNodeIdentity(s.dataDir, cipher).nodeId, identity.nodeId);
    assert.equal(readNodeIdentity(setup({ withIdentity: false }).dataDir, cipher), null);
    // A real store's file, written by the service's own code.
    const { JsonFileStore } = require('../src/platform/json-file-store');
    const s2 = setup({ withIdentity: false });
    new JsonFileStore({ dir: s2.dataDir, name: 'chat-data' }).set('mesh.identity', storedIdentity());
    assert.equal(readNodeIdentity(s2.dataDir, cipher).nodeId, identity.nodeId);
    // A flat "mesh.identity" key is not where the store writes it.
    const s3 = setup({ withIdentity: false });
    fs.writeFileSync(path.join(s3.dataDir, 'chat-data.json'), JSON.stringify({ 'mesh.identity': storedIdentity() }));
    assert.equal(readNodeIdentity(s3.dataDir, cipher), null);
  });
});

// R-F5-12 (owner ruling, 2026-10-12): the master key file's owner is checked,
// and the node id is the verified identity's before it is sealed into anything.
describe('R-F5-12: session install checks the key file\'s owner and verifies the node id', () => {
  const refusedInstall = async (s, extra = {}) => {
    const before = tree(s.base);
    const t = io();
    const d = deps(s, extra);
    const code = await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d });
    assert.equal(code, 1);
    assert.deepEqual(tree(s.base), before, 'nothing was written');
    assert.equal(d.executed.length, 0);
    return t.err.join('');
  };

  it('asks for the master key as the data dir\'s owner (so a key file owned by anyone else is refused)', async () => {
    const s = setup();
    const seen = [];
    const d = deps(s, { dataDirOwnerUid: undefined, resolveKey: (ownerUid) => { seen.push(ownerUid); return { key: KEY, source: 'test' }; } });
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.deepEqual(seen, [POSIX ? fs.statSync(s.dataDir).uid : null]);
  });

  it('the real resolver refuses a master key file that the data dir\'s owner does not own', { skip: !POSIX }, async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dataDir, 'master.key'), `${KEY.toString('hex')}\n`, { mode: 0o600 });
    // The data dir's owner is somebody else; this process's uid owns the key file.
    const err = await refusedInstall(s, { resolveKey: undefined, dataDirOwnerUid: UID + 1 });
    assert.match(err, new RegExp(`master\\.key is owned by uid ${UID}, not ${UID + 1}`));
  });

  it('refuses a data dir that is missing or is not a directory', async () => {
    const s = setup();
    const file = path.join(s.base, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: file, io: t.io, deps: deps(s) }), 1);
    assert.match(t.err.join(''), /is not a directory/);
    const t2 = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: path.join(s.base, 'absent'), io: t2.io, deps: deps(s) }), 1);
    assert.match(t2.err.join(''), /does not exist/);
    assert.equal(fs.existsSync(path.join(s.configDir, 'session')), false);
  });

  it('seals the node id of an identity whose private key matches its public key', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 0);
    assert.equal(canonical(s.configDir).node_id, identity.nodeId);
    // An identity an older build stored in the clear is the same identity.
    const s2 = setup({ withIdentity: false });
    writeIdentity(s2.dataDir, storedIdentity(identity, { plaintext: true }));
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s2.dataDir, io: io().io, deps: deps(s2) }), 0);
    assert.equal(canonical(s2.configDir).node_id, identity.nodeId);
  });

  it('refuses a stored public key that is not the node\'s own (another node\'s id would be sealed)', async () => {
    const other = nodeKeys();
    const s = setup({ withIdentity: false });
    writeIdentity(s.dataDir, { ...storedIdentity(), publicKey: other.publicKey.toString('hex') });
    const err = await refusedInstall(s);
    assert.match(err, /the node identity in .* names a public key that is not its private key's/);
    assert.ok(!err.includes(other.nodeId) && !err.includes(identity.privateHex));
  });

  it('refuses an identity with no private key, one that does not decrypt under this master key, and one that is not a key', async () => {
    const s = setup({ withIdentity: false });
    writeIdentity(s.dataDir, { publicKey: identity.publicKey.toString('hex') });
    assert.match(await refusedInstall(s), /the node identity in .* has no private key/);
    const s2 = setup({ withIdentity: false });
    writeIdentity(s2.dataDir, storedIdentity(identity, { key: crypto.randomBytes(32) }));
    assert.match(await refusedInstall(s2), /the node identity in .* does not decrypt under this data dir's master key/);
    const s3 = setup({ withIdentity: false });
    writeIdentity(s3.dataDir, { publicKey: 'abcd', privateKey: 'abcd' });
    assert.match(await refusedInstall(s3), /the node identity in .* holds no Ed25519 public key/);
    const s4 = setup({ withIdentity: false });
    writeIdentity(s4.dataDir, { publicKey: identity.publicKey.toString('hex'), privateKey: 'abcd' });
    assert.match(await refusedInstall(s4), /the node identity in .* holds an unreadable private key/);
  });
});
