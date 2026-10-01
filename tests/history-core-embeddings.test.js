// tests/history-core-embeddings.test.js
// The core with embeddings (recall spec §3, §5.2, §7): nothing loads until
// startHistoryEmbedding, KL_TEST_MODE never starts it, chunks get vectors in
// the background, a turn records the embedder, SearchHistory gets the
// reranker, shutdown stops the worker. An in-process fake runner; no model.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const KEY = 'local:Xenova/bge-small-en-v1.5';
const tempDirs = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps(runner) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-embed-'));
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
    history: { createEmbedRunner: () => runner }
  };
}

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function seed(ctx) {
  ctx.createChat({ id: 'c1', title: 'Lakeside lot', messages: [] });
  ctx.appendMessageToChat('c1', 'user', 'The linen bandage goes in the canopic jar.');
  ctx.appendMessageToChat('c1', 'assistant', 'Noted, the linen goes in the jar.');
  ctx.appendMessageToChat('c1', 'user', 'Where does the linen go?');
}

describe('createCore with embeddings', () => {
  it('embeds after startHistoryEmbedding, records the embedder on a turn, and stops the worker on shutdown', async () => {
    const runner = new FakeEmbedRunner();
    const core = createCore(makeDeps(runner));
    await core.start();
    const ctx = core.context;
    seed(ctx);
    const before = await ctx.getContextBuilder().build({ chatId: 'c1', message: 'linen', upToSeq: 3 });
    assert.strictEqual(before.stats.embedder, 'none');
    assert.strictEqual(before.stats.vectorsSkipped, null, 'not started is not a degradation');
    assert.strictEqual(runner.calls.length, 0, 'nothing loads before startHistoryEmbedding');

    ctx.startHistoryEmbedding();
    await waitFor(() => ctx.getEmbedderHost().status().state === 'ready');
    const store = ctx.getHistoryStore();
    const rerankLoads = () => runner.calls.filter((c) => c.op === 'load' && c.role === 'reranker').length;
    for (let i = 0; i < 5 && store.countPending(KEY) > 0; i += 1) {
      assert.strictEqual(rerankLoads(), 0, 'no reranker load while chunks are pending');
      await ctx.getEmbedIndexer().tick();
    }
    assert.strictEqual(store.countPending(KEY), 0);
    for (let i = 0; i < 5 && !ctx.getEmbedIndexer().idle(); i += 1) await ctx.getEmbedIndexer().tick();
    await waitFor(() => rerankLoads() === 1);
    assert.ok(store.countEmbedded(KEY) >= 3);

    const after = await ctx.getContextBuilder().build({ chatId: 'c1', message: 'linen', upToSeq: 3 });
    assert.strictEqual(after.stats.embedder, KEY);
    assert.strictEqual(after.stats.vectorsSkipped, null);
    assert.ok(runner.calls.some((c) => c.op === 'embed' && c.priority === 'query'), 'the query went at query priority');

    const scores = await ctx.getHistoryReranker()('linen', [{ text: 'the tomb' }, { text: 'a linen bandage' }], { maxMs: 1000 });
    assert.ok(scores[1] > scores[0]);

    await core.shutdown();
    assert.strictEqual(runner.stopped, true);
  });

  it('KL_TEST_MODE: startBackgroundChecks never starts the embedder', async () => {
    const runner = new FakeEmbedRunner();
    const core = createCore(makeDeps(runner));
    const saved = process.env.KL_TEST_MODE;
    process.env.KL_TEST_MODE = '1';
    try {
      await core.start();
      await core.models.startBackgroundChecks();
      assert.strictEqual(core.context.getEmbedderHost().status().state, 'off');
      assert.strictEqual(runner.calls.length, 0);
    } finally {
      if (saved === undefined) delete process.env.KL_TEST_MODE;
      else process.env.KL_TEST_MODE = saved;
      await core.shutdown();
    }
  });

  it('a changed vectorCacheMb clears the vector cache, so a chat skipped at the old cap is tried again', async () => {
    const core = createCore(makeDeps(new FakeEmbedRunner()));
    try {
      await core.start();
      const ctx = core.context;
      const index = ctx.getVectorIndex();
      index.tooLarge.add('c1');
      const s = ctx.getSettings();
      ctx.setSettings({ ...s, history: { ...s.history, recall: { ...s.history.recall, tailTokens: 5000 } } });
      assert.strictEqual(index.tooLarge.size, 1, 'another recall change keeps the cache');
      ctx.setSettings({ ...s, history: { ...s.history, recall: { ...s.history.recall, vectorCacheMb: 512 } } });
      assert.strictEqual(index.tooLarge.size, 0);
    } finally {
      await core.shutdown();
    }
  });

  it('the send path copies vectorsSkipped into provenance', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'chat-handlers.js'), 'utf8');
    assert.match(src, /vectorsSkipped: built\.stats\.vectorsSkipped \?\? null/);
  });
});
