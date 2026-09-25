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
  write(path.join('cron', 'jobs.json'), { cron_1: { id: 'cron_1', name: 'daily', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' } } });
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
    const dataDir = tmp();
    const savedRoot = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    try {
      const o = io();
      const code = await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } });
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
