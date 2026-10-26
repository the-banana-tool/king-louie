// tests/service-cli-import-case.test.js — import --from <desktop> --case <id>
// (personal node spec §9, "Moving one case"): one case and its chats only,
// refusals before anything is written, and a verify after the copy.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runImportCommand } = require('../src/service/commands/import');
const { spawnWriter } = require('../src/service/commands/import-channel');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const dirs = [];
after(() => {
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => closeOpenHistoryStores());
const tmp = (p = 'kl-icase-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const TEST_KEY = require('crypto').randomBytes(32);
function keyedDataDir() {
  const dir = tmp();
  require('../src/platform/master-key').verifyKeyCheck({ dataDir: dir, key: TEST_KEY, source: 'test' });
  return dir;
}

const CASE_ID = 'mlk0001-0a1b2c3d';
const OTHER_ID = 'mlk0002-4e5f6a7b';
const gitIn = (cwd, args) => execFileSync('git', ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A desktop profile: the Lakeside lot case (a real repository with one
// commit), a second case, two chats of the first case, one of the second
// and one with no case, plus settings, secrets, memory and cron that a case
// import must leave alone.
function userData({ repo = true } = {}) {
  const root = tmp('kl-icase-userdata-');
  const write = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  const msg = (sender, text) => ({ sender, text, timestamp: '2026-09-20T10:00:00Z' });
  write('chat-data.json', {
    chats: [
      { id: 'c1', title: 'Lakeside lot', caseId: CASE_ID, createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [msg('user', 'list the lot'), msg('assistant', 'listed')] },
      { id: 'c2', title: 'Lakeside offers', caseId: CASE_ID, createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-21T10:00:00Z', messages: [msg('user', 'any offers')] },
      { id: 'c3', title: 'Blue folder', caseId: OTHER_ID, createdAt: '2026-09-03T10:00:00Z', updatedAt: '2026-09-22T10:00:00Z', messages: [msg('user', 'other case')] },
      { id: 'c4', title: 'Groceries', createdAt: '2026-09-04T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', messages: [msg('user', 'no case')] }
    ],
    settings: { inference: { activeTier: 'smart' }, hooks: { enabled: true } },
    apiTokens: { anthropic: 'ENC-anthropic' },
    toolApprovals: { alwaysApproveTools: { Read: true }, permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow' }] },
    userProfile: { name: 'Example Owner' }
  });
  write('config.json', { __vault_github: 'ENC-github' });
  write(path.join('memory', 'memory-store.json'), { entries: [{ id: 'm-1', type: 'preference', content: 'likes tea', created: '2026-01-01T00:00:00.000Z' }] });
  write(path.join('cron', 'jobs.json'), { cron_1: { id: 'cron_1', name: 'daily', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' } } });
  const caseDir = path.join(root, 'cases', 'lakeside-lot');
  write(path.join('cases', 'lakeside-lot', 'case.yaml'), `id: ${CASE_ID}\nslug: lakeside-lot\ntitle: Lakeside lot\ntype: general\nstatus: open\n`);
  write(path.join('cases', 'lakeside-lot', 'brief.md'), '# Brief\n');
  write(path.join('cases', 'lakeside-lot', '.gitattributes'), 'playbooks/** -text\n');
  write(path.join('cases', 'lakeside-lot', 'journal', 'a.md'), '# A\n');
  write(path.join('cases', 'blue-folder', 'case.yaml'), `id: ${OTHER_ID}\ntitle: Blue folder\nstatus: open\n`);
  let head = null;
  if (repo) {
    gitIn(caseDir, ['init', '-q']);
    gitIn(caseDir, ['add', '-A']);
    gitIn(caseDir, ['commit', '-q', '-m', 'case created']);
    head = gitIn(caseDir, ['rev-parse', 'HEAD']);
  }
  return { root, head };
}

const io = () => {
  const out = { stdout: '', stderr: '' };
  return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } } };
};

// The real writer child, with every reply to `plan` kept for the test.
function recordingWriter() {
  const plans = [];
  const applied = [];
  const openWriter = (opts) => {
    const w = spawnWriter({ ...opts, spawn: require('child_process').spawn });
    return {
      close: () => w.close(),
      request: async (method, params) => {
        const r = await w.request(method, params);
        if (method === 'plan') plans.push(r);
        if (method === 'apply') applied.push(params.batch);
        return r;
      }
    };
  };
  return { plans, applied, openWriter };
}

const personal = { loadNodeConfig: () => ({ hosting: 'personal' }) };
const baseDeps = (extra = {}) => ({
  runningServicePid: () => null,
  isAdmin: () => { throw new Error('the elevation check must not run under hosting: personal'); },
  resolveMasterKey: () => ({ key: TEST_KEY, source: 'test' }),
  isTTY: () => false,
  ...personal,
  ...extra
});

async function withCasesRoot(fn) {
  const saved = process.env.KL_CASES_ROOT;
  delete process.env.KL_CASES_ROOT;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = saved;
  }
}

function nodeChats(dataDir) {
  const { HistoryStore } = require('../src/history');
  const store = HistoryStore.open(path.join(dataDir, 'history.sqlite'), { readonly: true });
  try { return store.listChats(); } finally { store.close(); }
}

const snapshot = (dir) => {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = path.join(rel, name);
      const st = fs.statSync(path.join(dir, r));
      out.push(`${r}:${st.isDirectory() ? 'd' : st.size}`);
      if (st.isDirectory()) walk(r);
    }
  };
  walk('');
  return out.sort();
};

describe('import --from --case', () => {
  it('copies one case and its chats only; other chats and settings are not planned', async () => {
    await withCasesRoot(async () => {
      const { root, head } = userData();
      const dataDir = keyedDataDir();
      const w = recordingWriter();
      const o = io();
      const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', yes: true }, dataDir, io: o.io, deps: baseDeps({ openWriter: w.openWriter }) });
      assert.strictEqual(code, 0, o.out.stderr + o.out.stdout);
      assert.strictEqual(w.plans.length, 1);
      const items = w.plans[0].items;
      const byCategory = (c) => items.filter((i) => i.category === c);
      assert.deepStrictEqual(byCategory('case').map((i) => [i.key, i.action]), [['lakeside-lot', 'new']]);
      assert.deepStrictEqual(byCategory('chat').map((i) => [i.key, i.action]).sort(), [['c1', 'new'], ['c2', 'new']]);
      assert.deepStrictEqual([...new Set(items.map((i) => i.category))].sort(), ['case', 'chat']);
      for (const c of ['settings', 'memory', 'cron', 'vault', 'providerToken', 'userProfile', 'permissionRule', 'alwaysApprove']) {
        assert.strictEqual(byCategory(c).length, 0, `${c} must not be planned`);
      }
      // Nothing but the case's files and its two chats went down the channel.
      const sent = w.applied.flat();
      assert.deepStrictEqual([...new Set(sent.map((e) => `${e.category}:${e.key}`))].sort(), ['case:lakeside-lot', 'chat:c1', 'chat:c2']);
      assert.ok(!JSON.stringify(sent).includes('ENC-'), 'no secret value sent');

      // On disk: the case with its history, the two chats, no other case.
      const target = path.join(dataDir, 'cases', 'lakeside-lot');
      assert.strictEqual(fs.readFileSync(path.join(target, 'journal', 'a.md'), 'utf8'), '# A\n');
      assert.strictEqual(gitIn(target, ['rev-parse', 'HEAD']), head);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'cases', 'blue-folder')), false);
      const chats = nodeChats(dataDir);
      assert.deepStrictEqual(chats.map((c) => c.id).sort(), ['c1', 'c2']);
      assert.ok(chats.every((c) => c.caseId === CASE_ID));
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'memory', 'memory-store.json')) && JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'memory-store.json'), 'utf8')).entries?.some((e) => e.id === 'm-1'), false);
      const cronFile = path.join(dataDir, 'cron', 'jobs.json');
      assert.ok(!fs.existsSync(cronFile) || !JSON.parse(fs.readFileSync(cronFile, 'utf8')).cron_1, 'no cron job imported');
      assert.ok(!o.out.stdout.includes('ENC-'));
    });
  });

  it('accepts the case id as well as the directory name', async () => {
    await withCasesRoot(async () => {
      const { root } = userData();
      const dataDir = keyedDataDir();
      const w = recordingWriter();
      const o = io();
      const code = await runImportCommand({ flags: { from: root, case: CASE_ID, dryRun: true }, dataDir, io: o.io, deps: baseDeps({ openWriter: w.openWriter }) });
      assert.strictEqual(code, 0, o.out.stderr);
      assert.deepStrictEqual(w.plans[0].items.filter((i) => i.category === 'case').map((i) => i.key), ['lakeside-lot']);
      const missing = io();
      assert.strictEqual(await runImportCommand({ flags: { from: root, case: 'no-such-case', dryRun: true }, dataDir, io: missing.io, deps: baseDeps() }), 2);
      assert.match(missing.out.stderr, /CASE_NOT_FOUND/);
    });
  });

  it('Review Focus 4: CASE_EXISTS when the node has the directory; CASE_NOT_A_REPO when the source has no .git/HEAD; nothing written either way', async () => {
    await withCasesRoot(async () => {
      // CASE_EXISTS
      const { root } = userData();
      const dataDir = keyedDataDir();
      fs.mkdirSync(path.join(dataDir, 'cases', 'lakeside-lot'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'cases', 'lakeside-lot', 'case.yaml'), 'id: x\n');
      const before = snapshot(dataDir);
      let opened = 0;
      const o = io();
      const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', yes: true }, dataDir, io: o.io, deps: baseDeps({ openWriter: () => { opened += 1; throw new Error('no writer'); } }) });
      assert.strictEqual(code, 2);
      assert.match(o.out.stderr, /CASE_EXISTS/);
      assert.strictEqual(opened, 0, 'no writer opened');
      assert.deepStrictEqual(snapshot(dataDir), before);

      // CASE_NOT_A_REPO
      const plain = userData({ repo: false });
      const dataDir2 = keyedDataDir();
      const before2 = snapshot(dataDir2);
      const o2 = io();
      const code2 = await runImportCommand({ flags: { from: plain.root, case: 'lakeside-lot', yes: true }, dataDir: dataDir2, io: o2.io, deps: baseDeps({ openWriter: () => { opened += 1; throw new Error('no writer'); } }) });
      assert.strictEqual(code2, 2);
      assert.match(o2.out.stderr, /CASE_NOT_A_REPO/);
      assert.strictEqual(opened, 0, 'no writer opened');
      assert.deepStrictEqual(snapshot(dataDir2), before2);
    });
  });

  it('verifies head and counts after the copy and prints the desktop step', async () => {
    await withCasesRoot(async () => {
      const { root, head } = userData();
      const dataDir = keyedDataDir();
      const o = io();
      let asked = null;
      const code = await runImportCommand({
        flags: { from: root, case: 'lakeside-lot' },
        dataDir,
        io: o.io,
        deps: baseDeps({ isTTY: () => true, confirm: async (q) => { asked = q; return true; } })
      });
      assert.strictEqual(code, 0, o.out.stderr + o.out.stdout);
      assert.match(asked, /\[y\/N\]/);
      assert.ok(o.out.stdout.includes(`Will copy case Lakeside lot (${CASE_ID}, open): 2 chats, 3 messages, head ${head}`), o.out.stdout);
      assert.ok(o.out.stdout.includes(`node: head ${head}, clean, 2 chats / 3 messages`), o.out.stdout);
      assert.ok(o.out.stdout.includes('In the desktop app, open the case and choose "Moved elsewhere" so it is worked in one place.'));
      const target = path.join(dataDir, 'cases', 'lakeside-lot');
      assert.strictEqual(gitIn(target, ['status', '--porcelain']), '');
    });
  });

  it('a declined question writes nothing; off a TTY without --yes it refuses', async () => {
    await withCasesRoot(async () => {
      const { root } = userData();
      const dataDir = keyedDataDir();
      const o = io();
      assert.strictEqual(await runImportCommand({ flags: { from: root, case: 'lakeside-lot' }, dataDir, io: o.io, deps: baseDeps({ isTTY: () => true, confirm: async () => false }) }), 1);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot')), false);
      const o2 = io();
      assert.strictEqual(await runImportCommand({ flags: { from: root, case: 'lakeside-lot' }, dataDir, io: o2.io, deps: baseDeps() }), 2);
      assert.match(o2.out.stderr, /--yes/);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot')), false);
    });
  });

  it('VERIFY_MISMATCH when the node does not match after the copy; the copy stays', async () => {
    await withCasesRoot(async () => {
      const { root } = userData();
      const dataDir = keyedDataDir();
      const o = io();
      const code = await runImportCommand({
        flags: { from: root, case: 'lakeside-lot', yes: true },
        dataDir,
        io: o.io,
        deps: baseDeps({ afterCopy: (target) => fs.writeFileSync(path.join(target, 'brief.md'), '# Changed\n') })
      });
      assert.strictEqual(code, 1);
      assert.match(o.out.stderr, /VERIFY_MISMATCH/);
      assert.match(o.out.stderr, /not clean/);
      assert.ok(o.out.stderr.includes(`remove the node's case directory ${path.join(dataDir, 'cases', 'lakeside-lot')} and the node's 2 chat(s) with caseId ${CASE_ID}`), o.out.stderr);
      assert.ok(!o.out.stdout.includes('Moved elsewhere'));
      assert.ok(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot', 'case.yaml')), 'the copy stays');
    });
  });

  it('dry run prints the summary and writes nothing', async () => {
    await withCasesRoot(async () => {
      const { root, head } = userData();
      const dataDir = keyedDataDir();
      const before = snapshot(dataDir);
      const o = io();
      const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', dryRun: true }, dataDir, io: o.io, deps: baseDeps({ confirm: async () => { throw new Error('a dry run asks nothing'); } }) });
      assert.strictEqual(code, 0, o.out.stderr);
      assert.ok(o.out.stdout.includes(`Will copy case Lakeside lot (${CASE_ID}, open): 2 chats, 3 messages, head ${head}`), o.out.stdout);
      assert.match(o.out.stdout, /Dry run: nothing was written\./);
      assert.deepStrictEqual(snapshot(dataDir), before);
    });
  });

  it('CASE_DIRTY when the desktop case has uncommitted changes; no writer opened, nothing written', async () => {
    const caseDirOf = (root) => path.join(root, 'cases', 'lakeside-lot');
    for (const [label, dirty] of [
      ['an untracked file', (dir) => fs.writeFileSync(path.join(dir, 'journal', 'b.md'), '# B\n')],
      ['a changed tracked file', (dir) => fs.writeFileSync(path.join(dir, 'brief.md'), '# Brief, edited\n')],
      ['a staged change', (dir) => { fs.writeFileSync(path.join(dir, 'brief.md'), '# Staged\n'); gitIn(dir, ['add', 'brief.md']); }]
    ]) {
      const { root } = userData();
      dirty(caseDirOf(root));
      const dataDir = keyedDataDir();
      const before = snapshot(dataDir);
      let opened = 0;
      const o = io();
      const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', yes: true }, dataDir, io: o.io, deps: baseDeps({ openWriter: () => { opened += 1; throw new Error('no writer'); } }) });
      assert.strictEqual(code, 2, label);
      assert.match(o.out.stderr, /CASE_DIRTY/, label);
      assert.match(o.out.stderr, /nothing was written/, label);
      assert.strictEqual(opened, 0, `${label}: no writer opened`);
      assert.deepStrictEqual(snapshot(dataDir), before, label);
    }
  });

  it('a file touched but unchanged is not dirty, and the desktop index is not rewritten', async () => {
    const { root, head } = userData();
    const dir = path.join(root, 'cases', 'lakeside-lot');
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(dir, 'brief.md'), later, later);
    // diff-index (no refresh) reports the touched file, so the hash check is what clears it.
    assert.match(gitIn(dir, ['diff-index', 'HEAD', '--']), /brief\.md/);
    const indexBefore = fs.readFileSync(path.join(dir, '.git', 'index'));
    const o = io();
    const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', dryRun: true }, dataDir: keyedDataDir(), io: o.io, deps: baseDeps() });
    assert.strictEqual(code, 0, o.out.stderr);
    assert.ok(o.out.stdout.includes(`head ${head}`));
    assert.ok(fs.readFileSync(path.join(dir, '.git', 'index')).equals(indexBefore), "the desktop's .git/index is unchanged");
  });

  it('CASE_AMBIGUOUS when two directories share the id; CASE_UNREADABLE when the named directory has no case.yaml', async () => {
    const { root } = userData();
    fs.writeFileSync(path.join(root, 'cases', 'blue-folder', 'case.yaml'), `id: ${CASE_ID}\ntitle: Blue folder\n`);
    const o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: root, case: CASE_ID, dryRun: true }, dataDir: keyedDataDir(), io: o.io, deps: baseDeps() }), 2);
    assert.match(o.out.stderr, /CASE_AMBIGUOUS/);
    fs.rmSync(path.join(root, 'cases', 'blue-folder', 'case.yaml'));
    fs.writeFileSync(path.join(root, 'cases', 'blue-folder', 'notes.md'), 'x\n');
    const o2 = io();
    assert.strictEqual(await runImportCommand({ flags: { from: root, case: 'blue-folder', dryRun: true }, dataDir: keyedDataDir(), io: o2.io, deps: baseDeps() }), 2);
    assert.match(o2.out.stderr, /CASE_UNREADABLE/);
  });

  it('refuses as root against a data dir another account owns, before anything is written', async () => {
    const { root } = userData();
    const dataDir = keyedDataDir();
    const before = snapshot(dataDir);
    const o = io();
    const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', yes: true }, dataDir, io: o.io, deps: baseDeps({ writerIdentity: () => ({ uid: 1001, gid: 1001 }), openWriter: () => { throw new Error('no writer'); } }) });
    assert.strictEqual(code, 2);
    assert.match(o.out.stderr, /not as root/);
    assert.deepStrictEqual(snapshot(dataDir), before);
  });

  it('--yes without --case is refused', async () => {
    const o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData().root, yes: true }, dataDir: keyedDataDir(), io: o.io, deps: baseDeps({ isAdmin: () => true }) }), 2);
    assert.match(o.out.stderr, /"--yes" is only valid for "import" with "--case"/);
  });

  it('under hosting service the elevation check still applies', async () => {
    const { root } = userData();
    const dataDir = keyedDataDir();
    const o = io();
    const code = await runImportCommand({ flags: { from: root, case: 'lakeside-lot', dryRun: true }, dataDir, io: o.io, deps: baseDeps({ loadNodeConfig: () => ({ hosting: 'service' }), isAdmin: () => false }) });
    assert.strictEqual(code, 1);
    assert.match(o.out.stderr, /run it as root\/an administrator/);
  });
});

describe('the CLI --case flag', () => {
  it('is refused on every command but import', async () => {
    const { main } = require('../src/service/cli');
    const o = io();
    const code = await main(['status', '--case', 'lakeside-lot'], o.io);
    assert.strictEqual(code, 2);
    assert.match(o.out.stderr, /"--case" is only valid for "import"/);
  });
});
