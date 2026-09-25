// tests/desktop-import-source.test.js — the user-controlled source tree (R51) and the CLI.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSafeReader, readDesktopSource, planBatches } = require('../src/migration/desktop-source');
const { runImportCommand } = require('../src/service/commands/import');
const { isAdmin } = require('../src/service/commands/admin-check');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'kl-src-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const MARKER = 'PLANTED-TARGET-CONTENT-0451';

// A real import needs the service's master key, which the admin parent
// resolves read-only and hands to the writer over the channel (Task 9 fix
// round 2, N1). Tests stub that resolution and prepare a data dir whose
// key-check was written with the same key, as a first service start would.
const TEST_KEY = require('crypto').randomBytes(32);
const withKey = { resolveMasterKey: () => ({ key: TEST_KEY, source: 'test' }) };
function keyedDataDir(key = TEST_KEY) {
  const dir = tmp();
  require('../src/platform/master-key').verifyKeyCheck({ dataDir: dir, key, source: 'test' });
  return dir;
}

function userData() {
  const root = tmp('kl-userdata-');
  const write = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  write('chat-data.json', {
    chats: [{ id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [] }],
    settings: { inference: { activeTier: 'smart' }, allowedDirectories: [root], webSearch: { brave: { apiKey: 'ENC-brave' } }, hooks: { enabled: true } },
    apiTokens: { anthropic: 'ENC-anthropic', __telegram_bot_token: 'ENC-bot', __elevenlabs_api_key: 'ENC-eleven' },
    toolApprovals: { alwaysApproveTools: { Read: true, Bash: false }, permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'user' }] },
    userProfile: { name: 'Example Owner' },
    mesh: { identity: { publicKey: 'aa' } }
  });
  write('config.json', { __vault_github: 'ENC-github' });
  write(path.join('memory', 'memory-store.json'), { entries: [{ id: 'm-1', type: 'preference', content: 'likes tea', created: '2026-01-01T00:00:00.000Z' }] });
  write(path.join('cron', 'jobs.json'), {
    cron_1: { id: 'cron_1', name: 'daily', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' } },
    // C2's protected system job: every core creates its own, so it is never imported.
    'cases:wakeups': { id: 'cases:wakeups', name: 'Case wake-ups', system: true, enabled: true, schedule: { kind: 'every', everyMs: 60000 }, payload: { system: 'cases:wakeups' } }
  });
  write(path.join('cases', 'lakeside-lot', 'case.yaml'), 'title: Lakeside lot\n');
  write(path.join('cases', 'lakeside-lot', 'notes', 'a.md'), '# A\n');
  return root;
}

const trySymlink = (t, target, link, type) => {
  try { fs.symlinkSync(target, link, type); return true; } catch (err) { t.skip(`cannot create a symlink here (${err.code})`); return false; }
};

describe('readDesktopSource', () => {
  it('builds the inventory from ids and keys only', () => {
    const root = userData();
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    const inv = source.inventory;
    assert.match(source.installId, /^[0-9a-f]{16}$/);
    assert.deepStrictEqual(inv.chats, [{ id: 'c1', updatedAt: '2026-09-20T10:00:00Z', title: 'Lakeside lot' }]);
    assert.deepStrictEqual(inv.settingsKeys.sort(), ['hooks', 'inference']);
    assert.deepStrictEqual(inv.providerTokens.sort(), ['__elevenlabs_api_key', 'anthropic']);
    assert.deepStrictEqual(inv.searchKeys, ['brave']);
    assert.deepStrictEqual(inv.vault, ['github']);
    assert.deepStrictEqual(inv.alwaysApprove, ['Read']);
    assert.deepStrictEqual(inv.permissionRules, [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]);
    assert.deepStrictEqual(inv.memory, ['m-1']);
    assert.deepStrictEqual(inv.cron, [{ id: 'cron_1', name: 'daily' }]);
    assert.deepStrictEqual(inv.cases, [{ dir: 'lakeside-lot', files: 2, bytes: 24 }]);
    assert.strictEqual(inv.secrets, 'needs-desktop');
    assert.ok(inv.excluded.includes('mesh.identity'));
    assert.ok(!JSON.stringify(inv).includes('ENC-'), 'no secret values in the inventory');
    assert.throws(() => source.getValue('vault', 'github'), /only the desktop app/);
    assert.strictEqual(source.getValue('chat', 'c1').title, 'Lakeside lot');
  });

  it('uses the installId the desktop recorded', () => {
    const root = userData();
    fs.writeFileSync(path.join(root, 'desktop-bridge.json'), JSON.stringify({ mode: 'standalone', installId: '7c0e1111-2222-4333-8444-555566667777' }));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.strictEqual(source.installId, '7c0e1111-2222-4333-8444-555566667777');
  });

  it('decrypts secrets only through the injected decrypt', () => {
    const root = userData();
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), decrypt: (enc) => enc.replace('ENC-', 'plain-'), secrets: 'included' });
    assert.strictEqual(source.getValue('vault', 'github'), 'plain-github');
    assert.strictEqual(source.getValue('providerToken', 'anthropic'), 'plain-anthropic');
    assert.strictEqual(source.getValue('searchKey', 'brave'), 'plain-brave');
  });
});

describe('the R51 walker', () => {
  it('refuses a symlinked store file and never reads what it points at', (t) => {
    const root = userData();
    const planted = path.join(tmp(), 'secret.json');
    fs.writeFileSync(planted, JSON.stringify({ chats: [{ id: MARKER, title: MARKER, messages: [] }] }));
    fs.rmSync(path.join(root, 'chat-data.json'));
    if (!trySymlink(t, planted, path.join(root, 'chat-data.json'), 'file')) return;
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(source.attention.some((a) => a.key === 'chat-data.json' && /link/.test(a.note)));
    assert.ok(!JSON.stringify(source.inventory).includes(MARKER));
  });

  it('refuses a symlinked case directory', (t) => {
    const root = userData();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'x.md'), MARKER);
    if (!trySymlink(t, outside, path.join(root, 'cases', 'linked'), 'dir')) return;
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(!source.inventory.cases.some((c) => c.dir === 'linked'));
    assert.ok(source.attention.some((a) => /linked/.test(a.key) && /link/.test(a.note)));
  });

  // Ruling (safe reader): on Windows a junction is a reparse point, not an
  // ordinary symlink, but Node reports it through the same isSymbolicLink()
  // a plain symlink gets (verified: fs.symlinkSync(target, p, 'junction')
  // produces a Stats whose mode is S_IFLNK) — the same check that refuses a
  // symlinked case directory above already refuses a junction. This needs
  // no privilege on Windows, unlike a 'file'/'dir' symlink. On platforms
  // without a distinct junction concept, Node just makes an ordinary
  // symlink, so the test still exercises the same refusal there.
  it('refuses a junction the same way it refuses a symlink', (t) => {
    const root = userData();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'x.md'), MARKER);
    if (!trySymlink(t, outside, path.join(root, 'cases', 'linked'), 'junction')) return;
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(!source.inventory.cases.some((c) => c.dir === 'linked'));
    assert.ok(source.attention.some((a) => /linked/.test(a.key) && /link/.test(a.note)));
  });

  it('refuses a hardlinked file (nlink 2)', () => {
    const root = userData();
    const outside = path.join(tmp(), 'shadow');
    fs.writeFileSync(outside, MARKER);
    fs.linkSync(outside, path.join(root, 'cases', 'lakeside-lot', 'hard.md'));
    const reader = createSafeReader({ root });
    const out = reader.readFile(path.join('cases', 'lakeside-lot', 'hard.md'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /2 hard links/);
    const listed = reader.listFiles(path.join('cases', 'lakeside-lot'));
    assert.ok(!listed.files.some((f) => f.relPath === 'hard.md'));
    assert.ok(listed.refused.some((f) => f.relPath === 'hard.md'));
  });

  it('refuses a file owned by another user', { skip: process.platform === 'win32' || process.getuid?.() !== 0 ? 'needs root on POSIX' : false }, () => {
    const root = userData();
    const file = path.join(root, 'cases', 'lakeside-lot', 'foreign.md');
    fs.writeFileSync(file, MARKER);
    fs.chownSync(file, 65534, 65534);
    fs.chownSync(root, 1000, 1000);
    const out = createSafeReader({ root }).readFile(path.join('cases', 'lakeside-lot', 'foreign.md'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /owned by uid/);
  });

  it('refuses .. in a relative path', () => {
    const root = userData();
    assert.strictEqual(createSafeReader({ root }).readFile('../etc/passwd').ok, false);
  });

  // Ruling (Task 8 carry): a case with a nested repo below its top makes
  // the receiving importer refuse the WHOLE case (isSkippedCaseFile throws
  // for any '.git' segment not at position 0). The walker must catch that
  // up front and report needs-attention instead of sending a case that
  // will only bounce.
  it('reports a case with a nested repo as needs-attention, without sending it', () => {
    const root = userData();
    fs.mkdirSync(path.join(root, 'cases', 'lakeside-lot', 'sub', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cases', 'lakeside-lot', 'sub', '.git', 'config'), '[core]\n');
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(!source.inventory.cases.some((c) => c.dir === 'lakeside-lot'));
    assert.ok(source.attention.some((a) => a.category === 'case' && a.key === 'lakeside-lot' && /nested repo/.test(a.note)));
  });
});

describe('planBatches', () => {
  it('keeps batches under the limit and chunks large case files', () => {
    const root = userData();
    fs.writeFileSync(path.join(root, 'cases', 'lakeside-lot', 'big.bin'), Buffer.alloc(2500 * 1024, 1));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), decrypt: (e) => e, secrets: 'included' });
    const items = [
      { category: 'chat', key: 'c1', action: 'new' },
      { category: 'case', key: 'lakeside-lot', action: 'new' },
      { category: 'vault', key: 'github', action: 'new' },
      { category: 'memory', key: 'missing', action: 'new' },
      { category: 'settings', key: 'hooks', action: 'skip-excluded' }
    ];
    const skipped = [];
    const batches = [...planBatches(items, source, { skipped })];
    for (const b of batches) assert.ok(Buffer.byteLength(JSON.stringify(b)) <= 1900000 + 1024);
    const flat = batches.flat();
    const chunks = flat.filter((e) => e.category === 'case' && e.value.relPath === 'big.bin');
    assert.deepStrictEqual(chunks.map((c) => c.value.offset), [0, 1048576, 2097152]);
    assert.ok(flat.some((e) => e.category === 'vault' && e.value === 'ENC-github'));
    assert.ok(!flat.some((e) => e.category === 'settings'));
    assert.deepStrictEqual(skipped, [{ category: 'memory', key: 'missing', error: 'not found in the desktop profile' }]);
  });
});

// Ruling: isAdmin's Windows path goes through PowerShell via an injected
// execFile in tests (never the real shell), and never builds a command
// string from a path — the script is a fixed literal with nothing
// interpolated into it, and the path only ever appears as a plain execFile
// argument, never concatenated into command text.
describe('isAdmin', () => {
  it('trusts PowerShell on win32, through the injected execFile', () => {
    let calledExe = null;
    let calledArgs = null;
    const execFile = (exe, args) => { calledExe = exe; calledArgs = args; return 'True\r\n'; };
    assert.strictEqual(isAdmin({ platform: 'win32', execFile, env: {} }), true);
    assert.ok(typeof calledExe === 'string' && calledExe.length > 0);
    assert.ok(Array.isArray(calledArgs) && calledArgs.every((a) => typeof a === 'string'));
    assert.ok(calledArgs.some((a) => a.includes('WindowsBuiltInRole')), 'the fixed script is passed as a literal argument');
  });

  it('is false when PowerShell reports False or throws', () => {
    assert.strictEqual(isAdmin({ platform: 'win32', execFile: () => 'False\r\n', env: {} }), false);
    assert.strictEqual(isAdmin({ platform: 'win32', execFile: () => { throw new Error('boom'); }, env: {} }), false);
  });

  it('checks geteuid on POSIX', () => {
    assert.strictEqual(isAdmin({ platform: 'linux', geteuid: () => 0 }), true);
    assert.strictEqual(isAdmin({ platform: 'linux', geteuid: () => 1000 }), false);
  });
});

describe('king-louie-service import --from', () => {
  const io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } }, ownership: { getuid: () => 1000 } } };
  };

  it('needs --from, an administrator and a stopped service', async () => {
    const dataDir = tmp();
    let o = io();
    assert.strictEqual(await runImportCommand({ flags: {}, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } }), 2);
    o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => false, runningServicePid: () => null } }), 1);
    assert.match(o.out.stderr, /run it as root\/an administrator/);
    o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => 4242 } }), 1);
    assert.strictEqual(o.out.stderr, `Stop the service before importing into ${dataDir}.\n`);
  });

  it('dry run prints the plan and writes nothing', async () => {
    const dataDir = tmp();
    const o = io();
    const code = await runImportCommand({ flags: { from: userData(), dryRun: true }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } });
    assert.strictEqual(code, 0);
    assert.match(o.out.stdout, /new\s+chat c1/);
    assert.match(o.out.stdout, /needs-desktop\s+vault github/);
    assert.match(o.out.stdout, /Dry run: nothing was written\./);
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'imports')), false);
    // Ruling: secret values are included only in planBatches' apply
    // batches, never printed in the dry-run plan.
    assert.ok(!o.out.stdout.includes('ENC-'), 'no secret value in the dry-run plan output');
  });

  // Ruling (pre-flight): a dry run must create or write nothing under
  // --data-dir. A fresh dir is left completely untouched — no data, logs
  // or cache subdirectory, no master-key file, no stores.
  it('dry run leaves a fresh data dir completely untouched', async () => {
    const dataDir = tmp();
    const o = io();
    const code = await runImportCommand({ flags: { from: userData(), dryRun: true }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } });
    assert.strictEqual(code, 0, o.out.stderr);
    assert.deepStrictEqual(fs.readdirSync(dataDir), []);
    for (const name of ['logs', 'cache', 'master.key', 'key-check', 'chat-data.json', 'config.json', 'memory', 'cron', 'imports']) {
      assert.strictEqual(fs.existsSync(path.join(dataDir, name)), false, `${name} must not be created by a dry run`);
    }
  });

  it('imports everything but secrets, which it lists as needs-desktop', async () => {
    const dataDir = keyedDataDir();
    const savedRoot = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    try {
      const o = io();
      const code = await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null, ...withKey } });
      assert.strictEqual(code, 0, o.out.stderr);
      const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
      assert.ok(store.chats.some((c) => c.id === 'c1'));
      const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'cron', 'jobs.json'), 'utf8'));
      assert.strictEqual(jobs.cron_1.enabled, false);
      assert.ok(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot', 'notes', 'a.md')));
      assert.match(o.out.stdout, /needs-desktop/);
      assert.match(o.out.stdout, /imported disabled/);
      assert.ok(!fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8').includes('ENC-anthropic'));
      // Ruling: secret values never appear in the printed report either.
      assert.ok(!o.out.stdout.includes('ENC-'), 'no secret value in the import report output');
    } finally {
      if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
    }
  });
});

// Task 9 fix round 1: the reader and walker rulings (I3, I4, I6 and the
// minors).
describe('the R51 walker (fix round 1)', () => {
  it('refuses every read once the profile root has been swapped for another directory (I3)', () => {
    const root = userData();
    const reader = createSafeReader({ root });
    const moved = `${root}-moved`;
    fs.renameSync(root, moved);
    dirs.push(moved);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [{ id: MARKER }] }));
    const out = reader.readFile('chat-data.json');
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /replaced/);
    assert.deepStrictEqual(reader.listFiles('cases').files, []);
  });

  it('opens with O_NONBLOCK and O_NOCTTY where the platform defines them (I4)', () => {
    const root = userData();
    let flags = null;
    const fsImpl = {
      ...fs,
      constants: { ...fs.constants, O_NONBLOCK: 0x4000000, O_NOCTTY: 0x8000000 },
      openSync: (p, f) => { flags = f; return fs.openSync(p, 'r'); }
    };
    const out = createSafeReader({ root, fsImpl }).readFile('chat-data.json');
    assert.strictEqual(out.ok, true);
    assert.ok(flags & 0x4000000, 'O_NONBLOCK');
    assert.ok(flags & 0x8000000, 'O_NOCTTY');
  });

  it('refuses a file larger than the reader cap', () => {
    const root = userData();
    const out = createSafeReader({ root, maxFileBytes: 10 }).readFile('chat-data.json');
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /larger than 10 bytes/);
  });

  it('names a top-level .git file as such, not as a nested repository', () => {
    const root = userData();
    fs.writeFileSync(path.join(root, 'cases', 'lakeside-lot', '.git'), 'gitdir: inner/.git\n');
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    const note = source.attention.find((a) => a.key === 'lakeside-lot');
    assert.ok(note, 'the case is held back');
    assert.match(note.note, /a \.git file/);
    assert.doesNotMatch(note.note, /nested repository/);
  });

  it('reports a case directory whose name the service would refuse', () => {
    const root = userData();
    fs.mkdirSync(path.join(root, 'cases', 'bad name'));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(source.attention.some((a) => a.key === 'bad name' && /not a valid case directory name/.test(a.note)));
  });

  it('holds back a case with a file name the service would refuse (reserved name, trailing dot or space)', () => {
    const root = userData();
    const real = createSafeReader({ root });
    for (const bad of ['aux.md', 'notes.', 'draft ']) {
      const reader = { ...real, listFiles: (rel) => { const r = real.listFiles(rel); if (/lakeside-lot$/.test(rel)) r.files.push({ relPath: `sub/${bad}`, mode: 0o644, size: 1 }); return r; } };
      const source = readDesktopSource({ userDataDir: root, reader, secrets: 'needs-desktop' });
      assert.ok(!source.inventory.cases.some((c) => c.dir === 'lakeside-lot'), bad);
      assert.ok(source.attention.some((a) => a.key === 'lakeside-lot' && /reserved device name|trailing dot or space/.test(a.note)), bad);
    }
  });
});

describe('planBatches (fix round 1)', () => {
  it('skips, with the reason, a single entry larger than a batch (I6)', () => {
    const root = userData();
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'chat-data.json'), 'utf8'));
    doc.chats.push({ id: 'big', title: 'Big', updatedAt: '2026-09-20T10:00:00Z', messages: [{ id: 'm', text: 'x'.repeat(2500 * 1024) }] });
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify(doc));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    const skipped = [];
    const batches = [...planBatches([{ category: 'chat', key: 'big', action: 'new' }, { category: 'chat', key: 'c1', action: 'new' }], source, { skipped })];
    assert.deepStrictEqual(batches.flat().map((e) => e.key), ['c1']);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].key, 'big');
    assert.match(skipped[0].error, /larger than/);
  });
});

// Task 9 fix round 1, C1: the root parent reads the desktop profile; a child
// running as the data dir's owner builds the core and does every write. On
// this host the child is spawned without uid/gid: the injection point that
// supplies them is stubbed, and the spawn wrapper records what it was given.
describe('import --from: reader and writer split (fix round 1)', () => {
  const { writerIdentity } = require('../src/service/commands/import');

  const childProcess = require('child_process');
  const io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } } };
  };
  const withEnv = async (vars, fn) => {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return await fn(); } finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
  const base = { isAdmin: () => true, runningServicePid: () => null, ...withKey };

  // A dropped child reports the uid it runs as; on this host it can't
  // actually drop, so the shim rewrites the uid in its answer to `open`, as
  // a child spawned with that uid would report it. The undropped child
  // reports null on Windows and its real uid (0 as root) on POSIX.
  const reportingUid = (child, uid) => {
    const { Transform } = require('stream');
    const stdout = new Transform({
      transform(chunk, _enc, cb) { cb(null, chunk.toString().replace(/"uid":(?:null|\d+)/, `"uid":${uid}`)); }
    });
    child.stdout.pipe(stdout);
    return { stdin: child.stdin, stdout, stderr: child.stderr, on: child.on.bind(child), kill: child.kill.bind(child) };
  };

  it('the parent never builds a core and writes nothing; the child, given the owner uid/gid, writes it all', async (t) => {
    const dataDir = keyedDataDir();
    const keyCheckBefore = fs.readFileSync(path.join(dataDir, 'key-check'), 'utf8');
    const from = userData();
    const core = require('../src/core');
    let coresBuilt = 0;
    t.mock.method(core, 'createCore', () => { coresBuilt += 1; throw new Error('the parent must not build a core'); });
    const parentWrites = [];
    const under = (p) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase());
    for (const m of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'copyFileSync']) {
      const orig = fs[m];
      t.mock.method(fs, m, function (...args) { if (under(args[0]) || under(args[1])) parentWrites.push(`${m} ${args[0]}`); return orig.apply(this, args); });
    }
    const origOpen = fs.openSync;
    t.mock.method(fs, 'openSync', function (p, flags, ...rest) { if (under(p) && flags !== 'r' && flags !== undefined && flags !== fs.constants.O_RDONLY) parentWrites.push(`openSync ${p}`); return origOpen.call(this, p, flags, ...rest); });
    const spawned = [];
    const spawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, uid: opts.uid, gid: opts.gid, cwd: opts.cwd, env: opts.env });
      const { uid, gid, ...rest } = opts;
      return reportingUid(childProcess.spawn(cmd, args, { ...rest, env: { ...process.env, ...rest.env } }), uid);
    };
    const o = io();
    const code = await withEnv({ KL_CASES_ROOT: undefined }, () => runImportCommand({ flags: { from }, dataDir, io: o.io, deps: { ...base, writerIdentity: () => ({ uid: 4321, gid: 8765 }), spawn } }));
    assert.strictEqual(code, 0, o.out.stderr);
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].uid, 4321);
    assert.strictEqual(spawned[0].gid, 8765);
    assert.strictEqual(spawned[0].cwd, dataDir);
    assert.strictEqual(spawned[0].env.HOME, undefined, 'a dropped child does not inherit the administrator HOME');
    assert.strictEqual(coresBuilt, 0);
    assert.deepStrictEqual(parentWrites, []);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8')).chats.some((c) => c.id === 'c1'));
    assert.ok(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot', 'notes', 'a.md')));
    assert.ok(fs.existsSync(path.join(dataDir, 'cron', 'jobs.json')));
    // N1: the key never lands in the data dir, key-check is untouched, and
    // the key reached the child only over the channel.
    for (const name of ['master.key', 'master.key.dpapi']) assert.strictEqual(fs.existsSync(path.join(dataDir, name)), false, name);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'key-check'), 'utf8'), keyCheckBefore);
    const hex = TEST_KEY.toString('hex');
    assert.ok(!JSON.stringify(spawned[0].args).includes(hex) && !JSON.stringify(spawned[0].env).includes(hex), 'not in argv or env');
    assert.ok(!o.out.stdout.includes(hex) && !o.out.stderr.includes(hex), 'not in any output');
  });

  // N2: the gid is the owner's primary group, not the data dir's group (the
  // macOS installer leaves the directory's group as admin/wheel).
  it('asks for the owner uid and its primary group only when root on POSIX and the owner is not root', () => {
    const st = (uid, gid) => ({ uid, gid, isDirectory: () => true, isSymbolicLink: () => false });
    const primaryGid = (uid) => { assert.strictEqual(uid, 990); return 20; };
    assert.deepStrictEqual(writerIdentity('/srv/kl', { platform: 'darwin', getuid: () => 0, lstat: () => st(990, 80), primaryGid }), { uid: 990, gid: 20 });
    assert.strictEqual(writerIdentity('/srv/kl', { platform: 'linux', getuid: () => 0, lstat: () => st(0, 0), primaryGid }), null);
    assert.strictEqual(writerIdentity('/srv/kl', { platform: 'linux', getuid: () => 1000, lstat: () => st(990, 991), primaryGid }), null);
    assert.strictEqual(writerIdentity('C:\\kl', { platform: 'win32', getuid: () => 0, lstat: () => st(0, 0), primaryGid }), null);
    assert.throws(() => writerIdentity('/srv/kl', { platform: 'linux', getuid: () => 0, lstat: () => st(990, 991), primaryGid: () => { throw new Error('no such user'); } }), /no such user/);
  });

  it('resolves a primary group with id -g, falling back to /bin/id, and refuses when neither answers', () => {
    const { primaryGroupOf } = require('../src/service/commands/import');
    const calls = [];
    const spawnSync = (answers) => (cmd, args) => { calls.push([cmd, args]); return answers[cmd] || { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }; };
    assert.strictEqual(primaryGroupOf(990, { spawnSync: spawnSync({ '/usr/bin/id': { status: 0, stdout: '20\n' } }) }), 20);
    assert.deepStrictEqual(calls[0], ['/usr/bin/id', ['-g', '--', '990']]);
    calls.length = 0;
    assert.strictEqual(primaryGroupOf(990, { spawnSync: spawnSync({ '/bin/id': { status: 0, stdout: '991\n' } }) }), 991);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['/usr/bin/id', '/bin/id']);
    assert.throws(() => primaryGroupOf(990, { spawnSync: spawnSync({ '/usr/bin/id': { status: 1, stdout: '', stderr: 'no such user' } }) }), /primary group/);
    assert.throws(() => primaryGroupOf(990, { spawnSync: spawnSync({ '/usr/bin/id': { status: 0, stdout: 'wheel\n' } }) }), /primary group/);
  });

  it('refuses to import when the owner primary group cannot be resolved', async () => {
    const o = io();
    const code = await runImportCommand({ flags: { from: userData() }, dataDir: tmp(), io: o.io, deps: { ...base, writerIdentity: () => { throw new Error('cannot resolve the primary group of uid 990'); }, openWriter: () => { throw new Error('must not spawn'); } } });
    assert.strictEqual(code, 1);
    assert.match(o.out.stderr, /primary group of uid 990/);
  });

  // A writer that is not what it should be (the service account can ptrace a
  // child running as itself) gets nothing from the parent but what the
  // inventory already offered.
  const fakeWriter = (overrides = {}) => {
    const calls = [];
    return {
      calls,
      request: async (method, params) => {
        calls.push({ method, params });
        if (overrides[method]) return overrides[method](params);
        if (method === 'open') return { uid: null, casesRoot: 'x', casesRootInDataDir: true, casesRootWritable: true };
        if (method === 'plan') return { planId: 'p1', items: [], counts: {} };
        if (method === 'apply') return { results: [] };
        if (method === 'finish') return { counts: {}, failures: [], attention: [], notes: [] };
        return {};
      },
      close: async () => {}
    };
  };

  it('never reads a case the inventory did not list, whatever the writer plans', async () => {
    const dataDir = tmp();
    const from = userData();
    fs.mkdirSync(path.join(from, 'Cookies-dir'));
    fs.writeFileSync(path.join(from, 'Cookies-dir', 'c.txt'), MARKER);
    const writer = fakeWriter({ plan: () => ({ planId: 'p1', items: [{ category: 'case', key: '../Cookies-dir', action: 'new' }, { category: 'case', key: 'not-listed', action: 'new' }, { category: 'case', key: 'lakeside-lot', action: 'new' }], counts: {} }) });
    const o = io();
    await runImportCommand({ flags: { from }, dataDir, io: o.io, deps: { ...base, openWriter: () => writer } });
    const sent = writer.calls.filter((c) => c.method === 'apply').flatMap((c) => c.params.batch);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((e) => e.key === 'lakeside-lot'));
    assert.ok(!JSON.stringify(sent).includes(Buffer.from(MARKER).toString('base64')));
  });

  it('aborts when the writer does not report exactly the uid it was spawned with', async () => {
    for (const reported of [0, null, '990', 990.5, undefined]) {
      const writer = fakeWriter({ open: () => ({ uid: reported, casesRoot: 'x', casesRootInDataDir: true, casesRootWritable: true }) });
      const o = io();
      const code = await runImportCommand({ flags: { from: userData() }, dataDir: tmp(), io: o.io, deps: { ...base, writerIdentity: () => ({ uid: 990, gid: 991 }), openWriter: () => writer } });
      assert.strictEqual(code, 1, String(reported));
      assert.match(o.out.stderr, /not 990/);
      assert.ok(!writer.calls.some((c) => c.method === 'plan'));
    }
    const ok = fakeWriter({ open: () => ({ uid: 990, casesRoot: 'x', casesRootInDataDir: true, casesRootWritable: true }) });
    const o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData() }, dataDir: tmp(), io: o.io, deps: { ...base, writerIdentity: () => ({ uid: 990, gid: 991 }), openWriter: () => ok } }), 0, o.out.stderr);
  });

  it('reports a failed apply or finish and exits 1 (I6)', async () => {
    for (const failing of ['apply', 'finish']) {
      const writer = fakeWriter({
        plan: () => ({ planId: 'p1', items: [{ category: 'chat', key: 'c1', action: 'new' }], counts: {} }),
        [failing]: () => { throw new Error(`${failing} went wrong`); }
      });
      const o = io();
      const code = await runImportCommand({ flags: { from: userData() }, dataDir: tmp(), io: o.io, deps: { ...base, openWriter: () => writer } });
      assert.strictEqual(code, 1, failing);
      assert.match(o.out.stderr, new RegExp(`${failing} went wrong`));
    }
  });

  it('a chat larger than a batch is reported, not sent, and the import exits 1 (I6)', async () => {
    const dataDir = keyedDataDir();
    const from = userData();
    const doc = JSON.parse(fs.readFileSync(path.join(from, 'chat-data.json'), 'utf8'));
    doc.chats.push({ id: 'big', title: 'Big', updatedAt: '2026-09-20T10:00:00Z', messages: [{ id: 'm', text: 'x'.repeat(2500 * 1024) }] });
    fs.writeFileSync(path.join(from, 'chat-data.json'), JSON.stringify(doc));
    const o = io();
    const code = await withEnv({ KL_CASES_ROOT: undefined }, () => runImportCommand({ flags: { from }, dataDir, io: o.io, deps: base }));
    assert.strictEqual(code, 1);
    assert.match(o.out.stdout, /not read chat big: larger than the/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8')).chats.some((c) => c.id === 'c1'));
  });

  // N1: the parent resolves the key read-only and never creates one.
  it('refuses a real import when there is no master key yet, and creates nothing', async () => {
    const dataDir = tmp();
    const o = io();
    let spawned = false;
    const code = await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { ...base, resolveMasterKey: () => null, openWriter: () => { spawned = true; throw new Error('must not spawn'); } } });
    assert.strictEqual(code, 1);
    assert.match(o.out.stderr, /start the service once first/);
    assert.strictEqual(spawned, false);
    assert.deepStrictEqual(fs.readdirSync(dataDir), []);
  });

  it('the writer refuses, writing nothing, when key-check is missing or was made with another key', async () => {
    const fresh = tmp();
    let o = io();
    assert.strictEqual(await withEnv({ KL_CASES_ROOT: undefined }, () => runImportCommand({ flags: { from: userData() }, dataDir: fresh, io: o.io, deps: base })), 1);
    assert.match(o.out.stderr, /start the service once first/);
    assert.deepStrictEqual(fs.readdirSync(fresh), []);
    const other = keyedDataDir(require('crypto').randomBytes(32));
    o = io();
    assert.strictEqual(await withEnv({ KL_CASES_ROOT: undefined }, () => runImportCommand({ flags: { from: userData() }, dataDir: other, io: o.io, deps: base })), 1);
    assert.match(o.out.stderr, /different master key/);
    assert.deepStrictEqual(fs.readdirSync(other), ['key-check']);
  });

  it('resolves the key read-only: nothing is created when there is none', () => {
    const { resolveMasterKeyReadOnly } = require('../src/platform/master-key');
    const dataDir = tmp();
    const credDir = tmp('kl-cred-');
    const credentialPath = path.join(credDir, 'kl-master-key');
    assert.strictEqual(resolveMasterKeyReadOnly({ platform: 'linux', dataDir, env: {}, getuid: () => 1000, credentialPath }), null);
    assert.deepStrictEqual(fs.readdirSync(dataDir), []);
    assert.deepStrictEqual(fs.readdirSync(credDir), []);
    fs.writeFileSync(credentialPath, TEST_KEY.toString('hex'), { mode: 0o600 });
    const found = resolveMasterKeyReadOnly({ platform: 'linux', dataDir, env: {}, getuid: () => 1000, credentialPath, checkMode: false });
    assert.ok(found.key.equals(TEST_KEY));
    assert.strictEqual(resolveMasterKeyReadOnly({ platform: 'win32', dataDir, env: {}, dpapi: { unprotect: () => { throw new Error('no'); } } }), null);
  });

  it('will not read a data-dir master.key that is a link', (t) => {
    const { resolveMasterKeyReadOnly } = require('../src/platform/master-key');
    const dataDir = tmp();
    const planted = path.join(tmp(), 'someone-elses-key');
    fs.writeFileSync(planted, TEST_KEY.toString('hex'));
    if (!trySymlink(t, planted, path.join(dataDir, 'master.key'), 'file')) return;
    assert.throws(() => resolveMasterKeyReadOnly({ platform: 'linux', dataDir, env: {}, getuid: () => 1000, credentialPath: path.join(tmp(), 'none'), checkMode: false }), /link/);
  });

  it('requires runningServicePid (I7)', async () => {
    await assert.rejects(runImportCommand({ flags: { from: userData() }, dataDir: tmp(), io: io().io, deps: { isAdmin: () => true } }), /runningServicePid/);
  });

  it('a dry run leaves an orphaned staging directory alone (I1)', async () => {
    const dataDir = tmp();
    fs.mkdirSync(path.join(dataDir, 'cases', '.import-x'), { recursive: true });
    const o = io();
    const code = await withEnv({ KL_CASES_ROOT: undefined }, () => runImportCommand({ flags: { from: userData(), dryRun: true }, dataDir, io: o.io, deps: base }));
    assert.strictEqual(code, 0, o.out.stderr);
    assert.ok(fs.existsSync(path.join(dataDir, 'cases', '.import-x')));
  });

  it('refuses a data dir that does not exist, and creates nothing (I1)', async () => {
    for (const dryRun of [true, false]) {
      const dataDir = path.join(tmp(), 'missing');
      const o = io();
      const code = await runImportCommand({ flags: { from: userData(), dryRun }, dataDir, io: o.io, deps: base });
      assert.strictEqual(code, 1);
      assert.match(o.out.stderr, /does not exist/);
      assert.strictEqual(fs.existsSync(dataDir), false);
    }
  });

  it('a dry run marks allowed directories unverified and never probes them (I5)', async () => {
    const from = userData();
    const { statOnlyCheckPath } = require('../src/service/commands/import-writer');
    const probed = [];
    const out = await statOnlyCheckPath(from, { fsp: { stat: fs.promises.stat, open: async (p) => { probed.push(p); throw new Error('no'); }, opendir: async (p) => { probed.push(p); throw new Error('no'); } } });
    assert.deepStrictEqual(probed, []);
    assert.strictEqual(out.unverified, true);
    assert.strictEqual(out.isDirectory, true);
    const o = io();
    const code = await runImportCommand({ flags: { from, dryRun: true }, dataDir: tmp(), io: o.io, deps: base });
    assert.strictEqual(code, 0, o.out.stderr);
    assert.match(o.out.stdout, /new\s+allowedDirectory .*not verified/);
    assert.deepStrictEqual(fs.readdirSync(from).filter((n) => n.startsWith('.kl-write-probe')), []);
  });

  it('says so when the cases root is outside the data dir', async () => {
    const casesRoot = tmp('kl-cases-');
    const o = io();
    const code = await withEnv({ KL_CASES_ROOT: casesRoot }, () => runImportCommand({ flags: { from: userData(), dryRun: true }, dataDir: tmp(), io: o.io, deps: base }));
    assert.strictEqual(code, 0, o.out.stderr);
    assert.match(o.out.stdout, /needs-attention\s+case .*outside the data dir/);
  });
});
