// tests/local-server-provider.test.js
// The provider "local" (spec 2026-10-13-local-inference-design.md §5.1, §5.5,
// §9.1; R-LI-4, R-LI-13): OllamaProvider's OpenAI-compatible code over a
// local server's pinned transport, one instance per server. Its calls are
// free and marked local; nothing else is.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const LocalServerProvider = require('../src/providers/local-server-provider');
const OllamaProvider = require('../src/providers/ollama-provider');
const OpenAIProvider = require('../src/providers/openai-provider');
const ProviderFactory = require('../src/providers/provider-factory');
const { LocalServers, SERVER_KINDS } = require('../src/models/local-servers');
const { createLocalTransport } = require('../src/models/local-transport');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { egressPolicy } = require('../src/models/egress');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { checkStreaming, checkToolCall, LOOKUP_TOOL } = require('../scripts/lib/provider-checks');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'hi' }];

describe('LocalServerProvider', () => {
  let server;
  const catalog = fixtureCatalog();
  const transports = [];
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => {
    for (const t of transports) t.close();
    await server.close();
  });

  const transportAt = (prefix) => {
    const t = createLocalTransport({ baseUrl: `${server.url}/${prefix}`, addresses: ['127.0.0.1'] });
    transports.push(t);
    return t;
  };
  const make = (key = null, over = {}) => new LocalServerProvider(key, {
    baseUrl: `${server.url}/ollama/v1`,
    transport: transportAt('ollama'),
    serverId: 'workstation',
    addressClass: 'loopback',
    kind: 'ollama',
    catalog,
    ...over
  });
  const lastPost = (prefix = 'ollama') => [...server.requests].reverse().find((r) => r.provider === prefix && r.method === 'POST');

  it('is not built without a transport or a server id: it never falls back to fetch', () => {
    assert.throws(() => new LocalServerProvider(null, { baseUrl: `${server.url}/ollama/v1`, serverId: 'workstation', kind: 'ollama' }), (err) => err.code === 'LOCAL_TRANSPORT_REQUIRED');
    assert.throws(() => new LocalServerProvider(null, { baseUrl: `${server.url}/ollama/v1`, transport: {}, serverId: 'workstation' }), (err) => err.code === 'LOCAL_TRANSPORT_REQUIRED');
    assert.throws(() => make(null, { serverId: 'Work Station' }), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    assert.throws(() => make(null, { baseUrl: '' }), /base URL/);
  });

  it('is not in the provider factory: only the registry builds one', () => {
    assert.strictEqual(ProviderFactory.listRegistered().includes('local'), false);
    assert.throws(() => ProviderFactory.create('local', 'test-key-123456'), /Unknown provider/);
  });

  it('R-LI-4: an entry of each kind is spoken to at <baseUrl>/v1/chat/completions', async () => {
    const entries = SERVER_KINDS.map((kind, i) => ({
      id: `box-${i}`,
      name: `Box ${i}`,
      kind,
      baseUrl: `${server.url}/${kind}`,
      tlsFingerprint: null,
      allowCgnat: false,
      maxConcurrent: 2,
      timeoutMs: null,
      pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT },
      markedLocalAt: AT
    }));
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    try {
      for (const e of entries) {
        const text = await servers.providerFor(e.id).sendMessage(HI, { model: `${e.id}/test-model` });
        assert.strictEqual(text, 'Hello there');
        const req = lastPost(e.kind);
        assert.strictEqual(req.path, `/${e.kind}/v1/chat/completions`, e.kind);
        assert.strictEqual(req.body.model, 'test-model', e.kind);
      }
    } finally {
      servers.close();
    }
  });

  it('the request body\'s model has no prefix, and a model id with slashes keeps them', async () => {
    const provider = make();
    await provider.sendMessage(HI, { model: 'workstation/test-model' });
    assert.strictEqual(lastPost().body.model, 'test-model');
    await provider.sendMessage(HI, { model: 'workstation/hf.co/org/name:tag' });
    assert.strictEqual(lastPost().body.model, 'hf.co/org/name:tag');
  });

  it('refuses a model that does not name this server, before any request', async () => {
    const provider = make();
    const sent = server.requests.length;
    for (const model of ['test-model', 'other-box/test-model', 'workstation/', '', undefined]) {
      await assert.rejects(provider.sendMessage(HI, { model }), (err) => err.code === 'LOCAL_SERVER_UNKNOWN', String(model));
      await assert.rejects(provider.sendMessageWithTools(HI, [LOOKUP_TOOL], { model }), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
      await assert.rejects(provider.streamMessage(HI, { model }, () => {}), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    }
    assert.strictEqual(server.requests.length, sent);
  });

  it('a cloud id on an Ollama server throws LOCAL_CLOUD_MODEL before any request', async () => {
    const provider = make();
    const sent = server.requests.length;
    for (const model of ['workstation/gpt-oss:120b-cloud', 'workstation/qwen3:cloud']) {
      await assert.rejects(provider.sendMessage(HI, { model }), (err) => err.code === 'LOCAL_CLOUD_MODEL');
      await assert.rejects(provider.sendMessageWithTools(HI, [LOOKUP_TOOL], { model }), (err) => err.code === 'LOCAL_CLOUD_MODEL');
      await assert.rejects(provider.streamMessage(HI, { model }, () => {}), (err) => err.code === 'LOCAL_CLOUD_MODEL');
    }
    // With no kind given the provider cannot tell, so it refuses too.
    await assert.rejects(make(null, { kind: undefined }).sendMessage(HI, { model: 'workstation/qwen3:cloud' }), (err) => err.code === 'LOCAL_CLOUD_MODEL');
    assert.strictEqual(server.requests.length, sent);
    // On another kind of server the suffix means nothing.
    assert.strictEqual(await make(null, { kind: 'vllm' }).sendMessage(HI, { model: 'workstation/qwen3:cloud' }), 'Hello there');
  });

  it('review fix, item 7: under a policy a cloud id is refused on any kind of server, before any request', async () => {
    const policy = egressPolicy({ reason: 'private-chat', chatId: 'chat-1' });
    for (const kind of ['vllm', 'lmstudio', 'llamacpp', 'openai-compatible']) {
      const provider = make(null, { kind });
      const sent = server.requests.length;
      await assert.rejects(provider.sendMessage(HI, { model: 'workstation/qwen3:cloud', egress: policy }), (err) => err.code === 'LOCAL_CLOUD_MODEL', kind);
      await assert.rejects(provider.streamMessageWithTools(HI, [LOOKUP_TOOL], { model: 'workstation/gpt-oss:120b-cloud', egress: policy }, () => {}), (err) => err.code === 'LOCAL_CLOUD_MODEL', kind);
      assert.strictEqual(server.requests.length, sent, kind);
    }
  });

  it('streams a reply and makes a tool call', async () => {
    server.setHold(false);
    const provider = make();
    const streamed = await checkStreaming(provider, { model: 'workstation/test-model' });
    assert.strictEqual(streamed.text, 'Hello there');
    assert.strictEqual(streamed.llmMetrics.provider, 'local');
    assert.strictEqual(streamed.llmMetrics.model, 'workstation/test-model');
    assert.strictEqual(lastPost().body.model, 'test-model');
    const called = await checkToolCall(provider, { model: 'workstation/test-model' });
    assert.strictEqual(called.type, 'tool_use');
    assert.strictEqual(called.toolName, LOOKUP_TOOL.name);
    assert.deepStrictEqual(called.parameters, { q: 'weather' });
    assert.strictEqual(called.llmMetrics.model, 'workstation/test-model');
  });

  it('R-LI-13: local is set only by the local provider', async () => {
    server.setHold(false);
    const local = await checkToolCall(make(), { model: 'workstation/test-model' });
    assert.deepStrictEqual(local.llmMetrics.local, { server: 'workstation', class: 'loopback' });
    assert.strictEqual(local.llmMetrics.provider, 'local');
    assert.strictEqual(local.llmMetrics.costUsd, 0);
    assert.strictEqual('unpriced' in local.llmMetrics, false);
    assert.strictEqual(local.llmMetrics.inputTokens, 20);
    assert.strictEqual(local.llmMetrics.outputTokens, 5);

    // The built-in Ollama provider against the same server: free, not local.
    const ollama = await checkToolCall(new OllamaProvider(null, { serverUrl: `${server.url}/ollama`, catalog }), { model: 'test-model' });
    assert.strictEqual(ollama.llmMetrics.provider, 'ollama');
    assert.strictEqual(ollama.llmMetrics.costUsd, 0);
    assert.strictEqual('local' in ollama.llmMetrics, false);

    // A hosted provider with a model the catalog does not know: unpriced, never $0.
    const hosted = await checkToolCall(new OpenAIProvider('test-key-123456', { baseUrl: `${server.url}/openai/v1`, catalog }), { model: 'mystery-model-x' });
    assert.strictEqual(hosted.llmMetrics.costUsd, null);
    assert.strictEqual(hosted.llmMetrics.unpriced, true);
    assert.strictEqual('local' in hosted.llmMetrics, false);
  });

  it('the metrics name the model the target named, not what the server calls itself', async () => {
    const provider = make();
    const metrics = provider.buildLlmCallMetrics({ model: 'some-other-name', usage: { prompt_tokens: 3, completion_tokens: 1 } });
    assert.strictEqual(metrics.model, 'workstation/some-other-name');
    assert.strictEqual(provider.buildLlmCallMetrics({ model: 'workstation/test-model', usage: {} }).model, 'workstation/test-model');
    const called = await checkToolCall(provider, { model: 'workstation/hf.co/org/name:tag' });
    assert.strictEqual(called.llmMetrics.model, 'workstation/hf.co/org/name:tag');
  });

  it('a key is sent only when configured', async () => {
    await make().sendMessage(HI, { model: 'workstation/test-model' });
    assert.strictEqual(lastPost().headers.authorization, undefined);
    await make('  ').sendMessage(HI, { model: 'workstation/test-model' });
    assert.strictEqual(lastPost().headers.authorization, undefined);
    await make('key-for-workstation').sendMessage(HI, { model: 'workstation/test-model' });
    assert.strictEqual(lastPost().headers.authorization, 'Bearer key-for-workstation');
  });

  it('Stop mid-stream yields usagePartial, still local and free', async () => {
    server.setHold(true);
    try {
      const before = server.closedCount();
      const controller = new AbortController();
      const err = await make()
        .streamMessage(HI, { model: 'workstation/test-model', abortSignal: controller.signal }, () => controller.abort())
        .then(() => null, (e) => e);
      assert.ok(err, 'the stream rejects');
      assert.strictEqual(err.name, 'AbortError');
      assert.strictEqual(err.partialLlmMetrics.usagePartial, true);
      assert.strictEqual(err.partialLlmMetrics.provider, 'local');
      assert.strictEqual(err.partialLlmMetrics.model, 'workstation/test-model');
      assert.deepStrictEqual(err.partialLlmMetrics.local, { server: 'workstation', class: 'loopback' });
      assert.strictEqual(err.partialLlmMetrics.costUsd, 0);
      await server.waitForClosedStream(before + 1);
    } finally {
      server.setHold(false);
    }
  });

  it('a request outside the server is refused by the transport, whatever the provider is told', async () => {
    const provider = make(null, { baseUrl: 'http://203.0.113.9:8000/v1' });
    await assert.rejects(provider.sendMessage(HI, { model: 'workstation/test-model' }), (err) => err.code === 'LOCAL_URL_OUTSIDE');
  });
});

describe('Catalog#price for local servers (R-LI-13)', () => {
  const usage = { input: 1000, output: 500 };

  it('a model on a registered server is $0', () => {
    const catalog = fixtureCatalog();
    catalog.setLocalServerCheck((serverId) => serverId === 'workstation');
    assert.strictEqual(catalog.price('local', 'workstation/qwen3:8b', usage).usd, 0);
    assert.strictEqual(catalog.price('LOCAL', 'workstation/hf.co/org/name:tag', usage).usd, 0);
  });

  it('a server nobody registered is unpriced, never $0', () => {
    const catalog = fixtureCatalog();
    assert.strictEqual(catalog.price('local', 'workstation/qwen3:8b', usage), null);
    catalog.setLocalServerCheck((serverId) => serverId === 'workstation');
    assert.strictEqual(catalog.price('local', 'other-box/qwen3:8b', usage), null);
    assert.strictEqual(catalog.price('local', 'qwen3:8b', usage), null);
    assert.strictEqual(catalog.price('local', 'workstation/', usage), null);
    catalog.setLocalServerCheck(() => { throw new Error('registry unreadable'); });
    assert.strictEqual(catalog.price('local', 'workstation/qwen3:8b', usage), null);
    catalog.setLocalServerCheck(() => 'yes');
    assert.strictEqual(catalog.price('local', 'workstation/qwen3:8b', usage), null);
  });

  it('nothing else becomes $0: ollama and an unknown hosted model are as before', () => {
    const catalog = fixtureCatalog();
    catalog.setLocalServerCheck(() => true);
    assert.strictEqual(catalog.price('ollama', 'llama3.2', usage).usd, 0);
    assert.strictEqual(catalog.price('openai', 'mystery-model-x', usage), null);
    assert.strictEqual(catalog.price('openai', 'workstation/qwen3:8b', usage), null);
    assert.strictEqual(catalog.price('openrouter', 'workstation/qwen3:8b', usage), null);
  });

  it('the registry tells the catalog which servers exist', () => {
    const catalog = fixtureCatalog();
    const entries = [{
      id: 'workstation', name: 'Workstation', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', tlsFingerprint: null,
      allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
      pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
    }, {
      id: 'elsewhere', name: 'Elsewhere', kind: 'vllm', baseUrl: 'http://203.0.113.9:8000', tlsFingerprint: null,
      allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
      pinned: { addresses: ['203.0.113.9'], class: 'lan', at: AT }, markedLocalAt: AT
    }];
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    assert.strictEqual(catalog.price('local', 'workstation/qwen3:8b', usage).usd, 0);
    // An entry that failed its address check is not a local server.
    assert.strictEqual(catalog.price('local', 'elsewhere/qwen3:8b', usage), null);
    servers.close();
  });
});
