// tests/service-cli-session.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessionCommand, readNodeId } = require('../src/service/commands/session');
const { main, parseArgs } = require('../src/service/cli');
const S = require('../src/gui/session-secret');
const { writeGuiStatus } = require('../src/gui/status');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { testNodeIdentity } = require('./helpers/fake-phone');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const identity = testNodeIdentity({ key: 'gpu-box' });
const KEY = crypto.randomBytes(32);

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
  if (withIdentity) fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ 'mesh.identity': { publicKey: identity.publicKey.toString('hex') } }));
  return { base, dataDir, configDir, ipcDir };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: (t) => err.push(String(t)) }, stdin: null } };
}

const account = (name) => ({ user: name, uid: UID, gid: GID, home: os.homedir(), sid: POSIX ? null : 'S-1-5-21-1-2-3-1001' });

function deps(s, extra = {}) {
  const executed = [];
  return {
    executed,
    platform: process.platform,
    isAdmin: () => true,
    resolveSessionUser: (name) => account(name),
    resolveKey: () => ({ key: KEY, source: 'test' }),
    verifyKey: () => {},
    configDir: s.configDir,
    ipcDir: s.ipcDir,
    runIcacls: () => {},
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

    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    const second = canonical(s.configDir);
    assert.notEqual(second.endpoint_id, first.endpoint_id);
    assert.notEqual(cipher.decryptString(second.secret), cipher.decryptString(first.secret));
  });

  it('R-F5-2 (owner question 2): refuses a second session user until the first is uninstalled', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const t = io();
    const before = tree(s.base);
    assert.ok(Object.keys(before).some((k) => k.endsWith(`${account('alice').sid || 'alice'}.json`)), 'the snapshot holds the first install');
    const bob = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'bob' }, dataDir: s.dataDir, io: t.io, deps: bob }), 1);
    assert.match(t.err.join(''), /session_user_mismatch: installed for "alice"; run "session uninstall --user alice" first/);
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
    // The session commands ask nothing, so --yes is a usage error there too.
    for (const sub of ['install', 'uninstall']) {
      const t3 = io();
      assert.equal(await main(['session', sub, '--user', 'alice', '--yes'], t3.io), 2);
      assert.match(t3.err.join(''), /"--yes" is only valid for "desktop pair"/);
    }
    const help = io();
    await main(['help'], help.io);
    assert.match(help.out.join(''), /king-louie-service session install --user NAME/);
  });

  it('session runs the helper and returns its exit code', async () => {
    const s = setup();
    const t = io();
    let seen = null;
    const code = await runSessionCommand({ sub: undefined, flags: { sessionFile: '/x.json' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { runHelper: async (opts) => { seen = opts; return 1; } }) });
    assert.equal(code, 1);
    assert.equal(seen.sessionFile, '/x.json');
  });

  it('readNodeId derives the node id from the stored identity without the master key', () => {
    const s = setup();
    assert.equal(readNodeId(s.dataDir), identity.nodeId);
    assert.equal(readNodeId(setup({ withIdentity: false }).dataDir), null);
  });
});
