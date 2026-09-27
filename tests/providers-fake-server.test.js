// tests/providers-fake-server.test.js
// All 14 providers stream text and make one tool call against a local fake
// server (spec 2026-09-27 §16, "providers") — what lets the send path drop
// its three-provider restriction — and every provider's stream stops at the
// provider when aborted, reporting the usage it had so far (§9).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { checkStreaming, checkToolCall, LOOKUP_TOOL } = require('../scripts/lib/provider-checks');
const { selectTargets } = require('../scripts/smoke-providers');

const BASES = {
  openai: '/openai/v1',
  anthropic: '/anthropic/v1',
  gemini: '/gemini/v1beta',
  groq: '/groq/openai/v1',
  mistral: '/mistral/v1',
  ollama: '/ollama/v1',
  openrouter: '/openrouter/api/v1',
  xai: '/xai/v1',
  deepseek: '/deepseek/v1',
  qwen: '/qwen/compatible-mode/v1',
  together: '/together/v1',
  fireworks: '/fireworks/inference/v1',
  cohere: '/cohere/v2',
  copilot: '/copilot'
};

describe('providers against a local fake server', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  const make = (key) => ProviderFactory.create(key, 'test-key-123456', {
    catalog,
    baseUrl: `${server.url}${BASES[key]}`,
    ...(key === 'copilot' ? { tokenExchangeUrl: `${server.url}/copilot/copilot_internal/v2/token` } : {})
  });
  const lastPost = (key) => [...server.requests].reverse().find((r) => r.provider === key && r.method === 'POST');
  const abortOnFirstChunk = async (provider, model) => {
    const controller = new AbortController();
    return provider
      .streamMessage([{ role: 'user', content: 'hi' }], { model, abortSignal: controller.signal }, () => controller.abort())
      .then(() => null, (err) => err);
  };

  it('covers every registered provider', () => {
    assert.deepStrictEqual(Object.keys(BASES).sort(), ProviderFactory.listRegistered().sort());
  });

  for (const key of Object.keys(BASES)) {
    describe(key, () => {
      it('streams a reply', async () => {
        server.setHold(false);
        const r = await checkStreaming(make(key), { model: 'test-model' });
        assert.strictEqual(r.text, 'Hello there');
        assert.strictEqual(r.llmMetrics.provider, key);
        const req = lastPost(key);
        assert.ok(req.body.model === 'test-model' || req.path.includes('test-model'), `${key} asked for the model`);
      });

      it('makes one tool call', async () => {
        server.setHold(false);
        const r = await checkToolCall(make(key), { model: 'test-model' });
        assert.strictEqual(r.type, 'tool_use');
        assert.strictEqual(r.toolName, LOOKUP_TOOL.name);
        assert.deepStrictEqual(r.parameters, { q: 'weather' });
        assert.strictEqual(r.llmMetrics.provider, key);
      });

      it('lists the account\'s models', async () => {
        assert.ok((await make(key).listModels()).includes('test-model'));
      });

      it('stops the request at the provider when aborted mid-stream, with partial usage', async () => {
        server.setHold(true);
        try {
          const before = server.closedCount();
          const err = await abortOnFirstChunk(make(key), 'test-model');
          assert.ok(err, 'the stream rejects');
          assert.strictEqual(err.name, 'AbortError');
          assert.strictEqual(err.partialLlmMetrics.usagePartial, true);
          assert.strictEqual(err.partialLlmMetrics.provider, key);
          await server.waitForClosedStream(before + 1);
        } finally {
          server.setHold(false);
        }
      });
    });
  }

  it('Anthropic keeps the input tokens message_start reported, priced, when aborted', async () => {
    server.setHold(true);
    try {
      const err = await abortOnFirstChunk(make('anthropic'), 'claude-haiku-4-5');
      assert.strictEqual(err.partialLlmMetrics.inputTokens, 1200);
      assert.strictEqual(err.partialLlmMetrics.costUsd, 0.001205);
    } finally {
      server.setHold(false);
    }
  });

  it('a stream that reported no usage before the abort has no cost, not $0', async () => {
    server.setHold(true);
    try {
      const err = await abortOnFirstChunk(make('openai'), 'gpt-5.5');
      assert.strictEqual(err.partialLlmMetrics.inputTokens, 0);
      assert.strictEqual(err.partialLlmMetrics.costUsd, null);
    } finally {
      server.setHold(false);
    }
  });

  it('Anthropic streams a tool call through streamMessageWithTools', async () => {
    server.setHold(false);
    const r = await make('anthropic').streamMessageWithTools([{ role: 'user', content: 'weather?' }], [LOOKUP_TOOL], { model: 'claude-haiku-4-5' }, () => {});
    assert.strictEqual(r.type, 'tool_use');
    assert.deepStrictEqual(r.parameters, { q: 'weather' });
    assert.strictEqual(r.llmMetrics.inputTokens, 1200);
  });

  it('an abort before the request is sent rejects at once with an empty partial record', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await make('groq')
      .streamMessage([{ role: 'user', content: 'hi' }], { model: 'test-model', abortSignal: controller.signal }, () => {})
      .then(() => null, (e) => e);
    assert.strictEqual(err.name, 'AbortError');
    assert.strictEqual(err.partialLlmMetrics.costUsd, null);
  });
});

describe('smoke:providers target selection', () => {
  it('checks providers whose key is in the environment, with an optional model', () => {
    assert.deepStrictEqual(selectTargets({ OPENAI_API_KEY: 'sk-x', KL_SMOKE_MODEL_OPENAI: 'gpt-5.5', CO_API_KEY: 'co-x' }), [
      { provider: 'openai', key: 'sk-x', model: 'gpt-5.5', options: {} },
      { provider: 'cohere', key: 'co-x', model: null, options: {} }
    ]);
  });

  it('checks Ollama only with an address and a model', () => {
    assert.deepStrictEqual(selectTargets({ KL_SMOKE_OLLAMA_URL: 'http://127.0.0.1:11434' }), []);
    assert.deepStrictEqual(selectTargets({ KL_SMOKE_OLLAMA_URL: 'http://127.0.0.1:11434', KL_SMOKE_MODEL_OLLAMA: 'qwen3:8b' }), [
      { provider: 'ollama', key: '', model: 'qwen3:8b', options: { serverUrl: 'http://127.0.0.1:11434' } }
    ]);
  });
});
