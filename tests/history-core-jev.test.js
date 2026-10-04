// tests/history-core-jev.test.js
// The core with the hosted reranker (recall spec §6.3 step 6, §14): the key
// is stored encrypted with the provider tokens and the Vault tool cannot
// read it; under KL_TEST_MODE nothing is sent; after startHistoryEmbedding a
// turn with kind jev is reranked by Jev and provenance names it; saving a
// key lifts a refusal; shutdown stops it. Loopback fake server, fake runner.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { mergeHistorySettings } = require('../src/history/settings');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const vaultTool = require('../src/tools/builtin/vault-tool');

const KEY = 'test-key-not-real-0001';
const tempDirs = [];
let server;
let savedTestMode;

before(async () => {
  server = await startFakeJevServer();
  savedTestMode = process.env.KL_TEST_MODE;
  delete process.env.KL_TEST_MODE;
});
after(async () => {
  await server.close();
  if (savedTestMode === undefined) delete process.env.KL_TEST_MODE;
  else process.env.KL_TEST_MODE = savedTestMode;
});
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-jev-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  return {
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    history: { createEmbedRunner: () => new FakeEmbedRunner(), createJevProvider: (key) => new TypesafeProvider(key, { baseUrl: server.url }) }
  };
}

const jevHistory = () => mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank: { kind: 'jev', enabled: true } } });
function seed(ctx) {
  ctx.createChat({ id: 'c1', title: 'Lakeside lot', messages: [] });
  for (const text of ['The linen bandage goes in the canopic jar.', 'The side gate code is 4417.', 'Lunch is at noon on Fridays.', 'The canopic jar sits on the top shelf.']) {
    ctx.appendMessageToChat('c1', 'user', text);
  }
}
const ask = (ctx) => ctx.getContextBuilder().build({ chatId: 'c1', message: 'Where is the canopic jar?', upToSeq: 5 });

describe('createCore with the hosted reranker', () => {
  it('stores the key encrypted with the provider tokens; the Vault tool cannot read it', async () => {
    const deps = makeDeps();
    const core = createCore(deps);
    await core.start();
    const ctx = core.context;
    try {
      assert.strictEqual(ctx.hasTypesafeKey(), false);
      ctx.saveTypesafeKey(`  ${KEY}  `);
      assert.strictEqual(ctx.hasTypesafeKey(), true);
      const stored = deps.store.get('apiTokens', {}).__typesafe_api_key;
      assert.strictEqual(typeof stored, 'string');
      assert.notStrictEqual(stored, KEY, 'encrypted at rest');
      assert.strictEqual(deps.cipher.decryptString(stored), KEY);
      assert.ok(!JSON.stringify(ctx.getSettings()).includes(KEY), 'never in settings');
      const got = await vaultTool.execute({ action: 'retrieve', key: '__typesafe_api_key' }, { vault: ctx.vault });
      assert.strictEqual(got.ok, false);
      const listed = await vaultTool.execute({ action: 'list' }, { vault: ctx.vault });
      assert.ok(!listed.keys.includes('__typesafe_api_key'));
      ctx.clearTypesafeKey();
      assert.strictEqual(ctx.hasTypesafeKey(), false);
    } finally {
      await core.shutdown();
    }
  });

  it('under KL_TEST_MODE a turn with kind jev and a key saved sends nothing (Review Focus 5)', async () => {
    process.env.KL_TEST_MODE = '1';
    const core = createCore(makeDeps());
    try {
      await core.start();
      const ctx = core.context;
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      const n0 = server.requests.length;
      assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: true });
      const built = await ask(ctx);
      assert.strictEqual(built.stats.reranker, null);
      assert.match(built.stats.rerankSkipped, /KL_TEST_MODE|not started/);
      assert.strictEqual(server.requests.length, n0, 'nothing reached typesafe.ai');
      assert.strictEqual(ctx.getJevReranker().status().state, 'not-started');
    } finally {
      delete process.env.KL_TEST_MODE;
      await core.shutdown();
    }
  });

  it('after startHistoryEmbedding, kind jev reranks the turn and SearchHistory; provenance names it; shutdown stops it', async () => {
    const core = createCore(makeDeps());
    await core.start();
    const ctx = core.context;
    try {
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      ctx.startHistoryEmbedding();
      const n0 = server.requests.length;
      const built = await ask(ctx);
      assert.strictEqual(built.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(built.stats.rerankSkipped, null);
      assert.ok(server.requests.length > n0);
      assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
      const st = ctx.getJevReranker().status();
      assert.strictEqual(st.state, 'ready');
      assert.ok(st.tokens > 0);
      const info = {};
      await ctx.getHistoryReranker()('jar', [{ text: 'the canopic jar' }], { maxMs: 2000, info });
      assert.strictEqual(info.name, 'jev:jev-1.13.0', 'SearchHistory gets the same dispatcher');
    } finally {
      await core.shutdown();
    }
    assert.strictEqual(ctx.getJevReranker().status().state, 'not-started');
  });

  it('a case chat goes through the Jev dispatch like any other chat (case chats included)', async () => {
    const core = createCore(makeDeps());
    await core.start();
    const ctx = core.context;
    try {
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      ctx.createChat({ id: 'c1', title: 'Lakeside lot', caseId: 'case-lakeside-lot', messages: [] });
      for (const text of ['The linen bandage goes in the canopic jar.', 'The side gate code is 4417.', 'Lunch is at noon on Fridays.', 'The canopic jar sits on the top shelf.']) {
        ctx.appendMessageToChat('c1', 'user', text);
      }
      assert.strictEqual(ctx.getChat('c1', { messages: false }).caseId, 'case-lakeside-lot');
      ctx.startHistoryEmbedding();
      const n0 = server.requests.length;
      const built = await ask(ctx);
      assert.strictEqual(built.stats.reranker, 'jev:jev-1.13.0');
      assert.ok(server.requests.length > n0, 'the case chat\'s excerpts went to typesafe.ai');
    } finally {
      await core.shutdown();
    }
  });

  it('a refused key pauses Jev; saving a key lifts it (Review Focus 3)', async () => {
    const core = createCore(makeDeps());
    await core.start();
    const ctx = core.context;
    try {
      ctx.saveTypesafeKey(KEY);
      ctx.setSettings({ ...ctx.getSettings(), history: jevHistory() });
      seed(ctx);
      ctx.startHistoryEmbedding();
      server.setFailure({ count: 1, status: 401 });
      const refused = await ask(ctx);
      assert.match(refused.stats.rerankSkipped, /refused the key \(401\)/);
      assert.strictEqual(ctx.getJevReranker().status().state, 'refused');
      ctx.saveTypesafeKey('test-key-not-real-0002');
      assert.strictEqual(ctx.getJevReranker().status().state, 'ready');
      const again = await ask(ctx);
      assert.strictEqual(again.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(server.requests.at(-1).auth, 'Bearer test-key-not-real-0002');
    } finally {
      await core.shutdown();
    }
  });
});
