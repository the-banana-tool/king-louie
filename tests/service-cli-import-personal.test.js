// tests/service-cli-import-personal.test.js — import --from <desktop> (the
// whole profile) under hosting: personal (desktop-attached-to-personal-node
// spec §9.1, C-2, C-14): it runs as the owner, unelevated; an elevated run is
// refused with and without --case; a fleet node.yaml still needs an
// administrator; a second import from the same install skips what the first
// one wrote.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runImportCommand } = require('../src/service/commands/import');
const { spawnWriter } = require('../src/service/commands/import-channel');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const dirs = [];
after(() => {
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => closeOpenHistoryStores());
const tmp = (p = 'kl-ipers-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const TEST_KEY = require('crypto').randomBytes(32);
function keyedDataDir() {
  const dir = tmp();
  require('../src/platform/master-key').verifyKeyCheck({ dataDir: dir, key: TEST_KEY, source: 'test' });
  return dir;
}

// A desktop profile with chats, settings, a permission rule, memory and a
// secret that must stay on the desktop.
function userData() {
  const root = tmp('kl-ipers-userdata-');
  const write = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  const msg = (sender, text) => ({ sender, text, timestamp: '2026-09-20T10:00:00Z' });
  write('chat-data.json', {
    chats: [
      { id: 'c1', title: 'Groceries', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [msg('user', 'milk'), msg('assistant', 'noted')] },
      { id: 'c2', title: 'Garden', createdAt: '2026-09-02T10:00:00Z', updatedAt: '2026-09-21T10:00:00Z', messages: [msg('user', 'water the beans')] }
    ],
    settings: { hooks: { enabled: true } },
    apiTokens: { anthropic: 'ENC-anthropic' },
    toolApprovals: { alwaysApproveTools: { Read: true }, permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow' }] },
    userProfile: { name: 'Example Owner' }
  });
  write(path.join('memory', 'memory-store.json'), { entries: [{ id: 'm-1', type: 'preference', content: 'likes tea', created: '2026-01-01T00:00:00.000Z' }] });
  return root;
}

const io = () => {
  const out = { stdout: '', stderr: '' };
  return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } } };
};

// The real writer child, with every reply to `plan` kept for the test.
function recordingWriter() {
  const plans = [];
  let opened = 0;
  const openWriter = (opts) => {
    opened += 1;
    const w = spawnWriter({ ...opts, spawn: require('child_process').spawn });
    return {
      close: () => w.close(),
      request: async (method, params) => {
        const r = await w.request(method, params);
        if (method === 'plan') plans.push(r);
        return r;
      }
    };
  };
  return { plans, openWriter, opened: () => opened };
}

const PERSONAL = { hosting: 'personal' };
const deps = (extra = {}) => ({
  runningServicePid: () => null,
  isAdmin: () => false,
  resolveMasterKey: () => ({ key: TEST_KEY, source: 'test' }),
  isTTY: () => false,
  loadNodeConfig: () => PERSONAL,
  ...extra
});

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

const ELEVATED_REFUSAL = /import on a personal node runs as you, not elevated: open a normal prompt/;

describe('import --from under hosting: personal', () => {
  it('a whole import runs unelevated and reads node.yaml without --case', async () => {
    const root = userData();
    const dataDir = keyedDataDir();
    const w = recordingWriter();
    const seen = [];
    const o = io();
    const code = await runImportCommand({
      flags: { from: root },
      dataDir,
      io: o.io,
      deps: deps({ openWriter: w.openWriter, loadNodeConfig: (dir) => { seen.push(dir); return PERSONAL; } })
    });
    assert.strictEqual(code, 0, o.out.stderr + o.out.stdout);
    assert.deepStrictEqual(seen, [dataDir]);
    assert.strictEqual(w.plans.length, 1);
    const chats = w.plans[0].items.filter((i) => i.category === 'chat').map((i) => [i.key, i.action]).sort();
    assert.deepStrictEqual(chats, [['c1', 'new'], ['c2', 'new']]);
    assert.ok(!o.out.stdout.includes('ENC-'), 'no secret value printed');
    assert.doesNotMatch(o.out.stderr, /administrator/);
  });

  it('an elevated run is refused without --case, before any writer opens; nothing written', async () => {
    const root = userData();
    const dataDir = keyedDataDir();
    const before = snapshot(dataDir);
    const w = recordingWriter();
    const o = io();
    const code = await runImportCommand({ flags: { from: root }, dataDir, io: o.io, deps: deps({ isAdmin: () => true, openWriter: w.openWriter }) });
    assert.strictEqual(code, 1);
    assert.match(o.out.stderr, ELEVATED_REFUSAL);
    assert.strictEqual(w.opened(), 0);
    assert.deepStrictEqual(snapshot(dataDir), before);
  });

  it('an elevated run is refused with --case too (and with --dry-run)', async () => {
    const root = userData();
    const dataDir = keyedDataDir();
    const before = snapshot(dataDir);
    const w = recordingWriter();
    for (const flags of [{ from: root, case: 'lakeside-lot', yes: true }, { from: root, dryRun: true }]) {
      const o = io();
      const code = await runImportCommand({ flags, dataDir, io: o.io, deps: deps({ isAdmin: () => true, openWriter: w.openWriter }) });
      assert.strictEqual(code, 1, JSON.stringify(flags));
      assert.match(o.out.stderr, ELEVATED_REFUSAL);
    }
    assert.strictEqual(w.opened(), 0);
    assert.deepStrictEqual(snapshot(dataDir), before);
  });

  it('a fleet node.yaml still needs an administrator', async () => {
    const root = userData();
    const dataDir = keyedDataDir();
    for (const cfg of [{ hosting: 'service' }, null]) {
      const w = recordingWriter();
      const o = io();
      const code = await runImportCommand({ flags: { from: root, dryRun: true }, dataDir, io: o.io, deps: deps({ loadNodeConfig: () => cfg, openWriter: w.openWriter }) });
      assert.strictEqual(code, 1);
      assert.match(o.out.stderr, /run it as root\/an administrator/);
      assert.strictEqual(w.opened(), 0);
    }
    // And as an administrator it runs.
    const w = recordingWriter();
    const o = io();
    const code = await runImportCommand({ flags: { from: root, dryRun: true }, dataDir, io: o.io, deps: deps({ loadNodeConfig: () => ({ hosting: 'service' }), isAdmin: () => true, openWriter: w.openWriter }) });
    assert.strictEqual(code, 0, o.out.stderr);
  });

  it('a node.yaml that cannot be read stops the import', async () => {
    const o = io();
    const code = await runImportCommand({ flags: { from: userData() }, dataDir: keyedDataDir(), io: o.io, deps: deps({ loadNodeConfig: () => { throw new Error('Invalid node.yaml: bad key'); } }) });
    assert.strictEqual(code, 1);
    assert.match(o.out.stderr, /Cannot read the node's configuration: Invalid node.yaml: bad key/);
  });

  it('the plan of a second import from the same install marks the first one\'s items skip-present', async () => {
    const root = userData();
    const dataDir = keyedDataDir();
    const first = recordingWriter();
    const o1 = io();
    assert.strictEqual(await runImportCommand({ flags: { from: root }, dataDir, io: o1.io, deps: deps({ openWriter: first.openWriter }) }), 0, o1.out.stderr);
    const written = first.plans[0].items.filter((i) => i.action === 'new').map((i) => `${i.category}:${i.key}`).sort();
    assert.ok(written.includes('chat:c1') && written.includes('chat:c2') && written.includes('memory:m-1'), written.join(','));

    const second = recordingWriter();
    const o2 = io();
    assert.strictEqual(await runImportCommand({ flags: { from: root, dryRun: true }, dataDir, io: o2.io, deps: deps({ openWriter: second.openWriter }) }), 0, o2.out.stderr);
    const again = new Map(second.plans[0].items.map((i) => [`${i.category}:${i.key}`, i.action]));
    for (const key of written) assert.strictEqual(again.get(key), 'skip-present', key);
  });
});
