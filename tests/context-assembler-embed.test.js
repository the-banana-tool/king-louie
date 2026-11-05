// tests/context-assembler-embed.test.js
// What the context assembler sends to a hosted embedder. Tool descriptions and
// the system sections (working directory, git user, branch, file names, commit
// subjects, the CLI list, local apps) leave the machine only for semantic mode,
// the one reader of the vectors. The default mode, deferred, embeds nothing,
// however index() is reached: the first index, an MCP re-index, the fleet
// handler. A later switch into semantic mode indexes on its next turn.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ContextAssembler = require('../src/context/context-assembler');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

const def = (name) => ({ name, description: `${name} does a thing.`, parameters: { type: 'object', properties: {} } });
const SECTION = { name: 'git-context', content: 'Branch: example-branch' };
const isDescription = (text) => /^(tool|system section): /.test(text);

describe('ContextAssembler#index and the embedder', () => {
  let dir;
  let n = 0;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-embed-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function assembler(options = {}) {
    n += 1;
    const a = new ContextAssembler({ vectorStorePath: path.join(dir, `vectors-${n}.json`), openaiApiKey: 'sk-test-123456', ...options });
    const sent = [];
    a.embeddingProvider = { embed: async (texts) => { sent.push(...texts); return texts.map((_text, i) => [1, i % 7, 0.5]); } };
    return { a, sent };
  }

  it('the default mode embeds nothing, on the first index or on a re-index with tools alone', async () => {
    const { a, sent } = assembler();
    assert.strictEqual(a.mode, 'deferred');
    await a.index([def('Read'), def('CronCreate')], [SECTION]);
    await a.index([def('Read'), def('CronCreate'), def('mcp_tool')]);
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(a.vectorStore.vectors, {});
  });

  it('the default mode still registers tools and sections, and a turn sees them', async () => {
    const { a, sent } = assembler();
    await a.index([def('Read'), def('CronCreate')], [SECTION]);
    const turn = await a.assemble('hello');
    assert.deepStrictEqual(turn.selectedToolNames, ['Read']);
    assert.deepStrictEqual(turn.availableToolNames, ['CronCreate']);
    assert.match(turn.systemPrompt, /Branch: example-branch/);
    assert.deepStrictEqual(a.getToolsByName(['CronCreate']).map((t) => t.name), ['CronCreate']);
    assert.deepStrictEqual(sent, []);
  });

  it('the default mode still prunes a stored vector whose tool is gone, and keeps the others', async () => {
    const { a } = assembler();
    a.vectorStore.add('tool:Gone', [1, 0, 0]);
    a.vectorStore.add('tool:Read', [0, 1, 0]);
    a.vectorStore.add('memory:other', [0, 0, 1]);
    await a.index([def('Read')], []);
    assert.deepStrictEqual(Object.keys(a.vectorStore.vectors).sort(), ['memory:other', 'tool:Read']);
  });

  it('firstIndexSettled settles in the default mode', async () => {
    const { a } = assembler();
    let settled = false;
    a.trackFirstIndex(a.index([def('Read')], [SECTION]));
    await a.firstIndexSettled().then(() => { settled = true; });
    assert.strictEqual(settled, true);
    assert.deepStrictEqual(a.getToolsByName(['Read']).map((t) => t.name), ['Read']);
  });

  it('semantic mode embeds at index, and a re-index only what is new', async () => {
    const { a, sent } = assembler({ mode: 'semantic' });
    await a.index([def('Read')], [SECTION]);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent.every(isDescription));
    sent.length = 0;
    await a.index([def('Read'), def('mcp_tool')]);
    assert.deepStrictEqual(sent, ['tool: mcp_tool. mcp_tool does a thing.']);
  });

  it('a switch into semantic mode indexes on the next turn, before the query, and once', async () => {
    const { a, sent } = assembler();
    await a.index([def('Read'), def('CronCreate')], [SECTION]);
    assert.deepStrictEqual(sent, []);
    a.mode = 'semantic';
    await a.assemble('first turn');
    assert.strictEqual(sent.length, 4);
    assert.ok(sent.slice(0, 3).every(isDescription));
    assert.strictEqual(sent[3], 'first turn');
    assert.deepStrictEqual(Object.keys(a.vectorStore.vectors).sort(), ['section:git-context', 'tool:CronCreate', 'tool:Read']);
    sent.length = 0;
    await a.assemble('second turn');
    assert.deepStrictEqual(sent, ['second turn']);
  });

  it('after a switch, a turn that may not embed sends nothing and indexes nothing', async () => {
    const { a, sent } = assembler();
    await a.index([def('Read'), def('CronCreate')], [SECTION]);
    a.mode = 'semantic';
    const turn = await a.assemble('A private message.', { embed: false });
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(a.vectorStore.vectors, {});
    assert.deepStrictEqual(turn.selectedToolNames.sort(), ['CronCreate', 'Read'], 'the fallback: every tool');
  });

  it('after a switch, an embedder that fails gives the fallback, and the next turn tries again', async () => {
    const { a } = assembler();
    await a.index([def('Read'), def('CronCreate')], [SECTION]);
    a.mode = 'semantic';
    const working = a.embeddingProvider;
    a.embeddingProvider = { embed: async () => { throw new Error('refused'); } };
    const turn = await a.assemble('first turn');
    assert.deepStrictEqual(turn.selectedToolNames.sort(), ['CronCreate', 'Read']);
    assert.deepStrictEqual(a.vectorStore.vectors, {});
    a.embeddingProvider = working;
    await a.assemble('second turn');
    assert.strictEqual(Object.keys(a.vectorStore.vectors).length, 3);
  });
});

describe('a core with a saved OpenAI key', () => {
  let core;
  let dataDir;
  const originalFetch = globalThis.fetch;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  const posts = [];
  const embedded = [];

  before(async () => {
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      posts.push(String(url));
      const input = JSON.parse(init.body).input;
      embedded.push(...input);
      return new Response(JSON.stringify({ data: input.map((_text, i) => ({ embedding: [1, i % 7, 0.5] })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    delete process.env.KL_CASES_ROOT;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-core-'));
    core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    await core.start();
  });
  after(async () => {
    if (core) await core.shutdown();
    globalThis.fetch = originalFetch;
    closeOpenHistoryStores();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('makes no embeddings POST at start in the default mode, and the first index still lands', async () => {
    const assembler = core.context.getContextAssembler();
    assert.ok(assembler.embeddingProvider, 'the key gives the assembler its client');
    await assembler.firstIndexSettled();
    assert.deepStrictEqual(posts, []);
    const turn = await assembler.assemble('hello');
    assert.ok(turn.selectedToolNames.includes('Read'));
    assert.match(turn.systemPrompt, /\S/);
  });

  it('makes none when the fleet handler re-indexes', async () => {
    core.context.setFleetToolHandler({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(core.context.getContextAssembler().getToolsByName(['list_machines']).length, 'the re-index ran');
    core.context.setFleetToolHandler(null);
    assert.deepStrictEqual(posts, []);
  });

  it('in semantic mode it sends the descriptions, then the message', async () => {
    const assembler = core.context.getContextAssembler();
    assembler.mode = 'semantic';
    try {
      await assembler.assemble('Where does the fence go?');
    } finally {
      assembler.mode = 'deferred';
    }
    assert.ok(posts.length > 0 && posts.every((url) => url === 'https://api.openai.com/v1/embeddings'));
    assert.strictEqual(embedded.at(-1), 'Where does the fence go?');
    const descriptions = embedded.slice(0, -1);
    assert.ok(descriptions.length > 0 && descriptions.every(isDescription));
    assert.ok(descriptions.some((text) => text.startsWith('system section: environment.')));
  });
});
