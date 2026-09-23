const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { mergeSettings } = require('../src/core/settings');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
const savedEnv = process.env.KL_CASES_ROOT;
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
});

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-core-'));
  tempDirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  };
}

describe('cases settings', () => {
  it('defaults cases.root to empty and merges an override', () => {
    assert.deepStrictEqual(mergeSettings({}).cases, { root: '' });
    assert.strictEqual(mergeSettings({ cases: { root: '/elsewhere' } }).cases.root, '/elsewhere');
  });
});

describe('createCore cases wiring', () => {
  it('exposes a case runtime rooted in the data dir without creating anything', () => {
    delete process.env.KL_CASES_ROOT;
    const deps = makeDeps();
    const core = createCore(deps);
    const runtime = core.context.getCaseRuntime();
    assert.strictEqual(runtime.root, path.join(deps.paths.dataDir, 'cases'));
    assert.strictEqual(fs.existsSync(runtime.root), false);
  });

  it('honours KL_CASES_ROOT', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-env-'));
    tempDirs.push(elsewhere);
    process.env.KL_CASES_ROOT = elsewhere;
    const core = createCore(makeDeps());
    assert.strictEqual(core.context.getCaseRuntime().root, elsewhere);
  });

  it('threads caseContext through the tool executor to the case tools and the write guard', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(makeDeps());
    await core.start();
    try {
      const runtime = core.context.getCaseRuntime();
      const info = await runtime.createCase({ title: 'Lakeside lot' });
      const executor = await core.context.createToolExecutorWithApprovals(null, { platform: process.platform }, null, {
        workingDirectory: info.dir,
        allowedDirectories: [info.dir],
        useSandbox: false,
        caseContext: { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir }
      });
      const q = await executor.execute('Ledger', { action: 'query' });
      assert.strictEqual(q.ok, true);
      assert.deepStrictEqual(q.facts, []);
      const w = await executor.execute('Write', { file_path: path.join(info.dir, 'facts.jsonl'), content: 'x' });
      assert.strictEqual(w.success, false);
    } finally {
      await core.shutdown();
    }
  });
});
