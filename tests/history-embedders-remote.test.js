// tests/history-embedders-remote.test.js
// Per-model prefixes, and the OpenAI and Ollama embedders through their
// providers (recall spec §5.2). Loopback servers only; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { profileFor, prefixTexts } = require('../src/history/embedders/profiles');
const { createRemoteEmbedder } = require('../src/history/embedders/remote');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeEmbeddingServer } = require('./helpers/fake-embedding-server');

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

function ollamaServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(body)));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r))
  })));
}

describe('embedder profiles', () => {
  it('bge queries get the instruction and documents nothing; nomic gets both prefixes; others none', () => {
    assert.deepStrictEqual(prefixTexts('Xenova/bge-small-en-v1.5', ['gate code'], 'query'), ['Represent this sentence for searching relevant passages: gate code']);
    assert.deepStrictEqual(prefixTexts('Xenova/bge-small-en-v1.5', ['gate code'], 'document'), ['gate code']);
    assert.deepStrictEqual(prefixTexts('nomic-embed-text:latest', ['x'], 'query'), ['search_query: x']);
    assert.deepStrictEqual(prefixTexts('nomic-embed-text', ['x'], 'document'), ['search_document: x']);
    assert.deepStrictEqual(prefixTexts('text-embedding-3-small', ['x'], 'query'), ['x']);
    assert.deepStrictEqual(prefixTexts('Xenova/all-MiniLM-L6-v2', ['x']), ['x']);
    assert.strictEqual(profileFor('Xenova/bge-small-en-v1.5').pooling, 'cls');
    assert.strictEqual(profileFor('Xenova/all-MiniLM-L6-v2').pooling, 'mean');
    assert.strictEqual(profileFor('someone/unknown-model').pooling, 'mean');
  });
});

describe('OpenAI embedder', () => {
  let server;
  before(async () => { server = await startFakeEmbeddingServer(); });
  after(() => server.close());

  it('embeds through OpenAIProvider#embed: unit vectors, the key name, tokens counted', async () => {
    const provider = ProviderFactory.createProvider('openai', 'test-key-123456', { baseUrl: `${server.url}/v1` });
    const e = createRemoteEmbedder({ kind: 'openai', model: 'text-embedding-3-small', provider });
    assert.strictEqual(e.name, 'openai:text-embedding-3-small');
    assert.strictEqual(e.dim, null);
    const vecs = await e.embed(['the side gate code', 'the north fence'], { kind: 'document' });
    assert.strictEqual(vecs.length, 2);
    assert.ok(vecs[0] instanceof Float32Array);
    assert.ok(Math.abs(norm(vecs[0]) - 1) < 1e-5);
    assert.strictEqual(e.dim, 64);
    assert.ok(e.tokens > 0);
    assert.strictEqual(server.requests.at(-1).model, 'text-embedding-3-small');
    assert.deepStrictEqual(await e.embed([]), []);
  });

  it('a provider without an embeddings call is refused', () => {
    assert.throws(() => createRemoteEmbedder({ kind: 'openai', model: 'm', provider: {} }), (err) => err.code === 'EMBEDDER_UNAVAILABLE');
  });
});

describe('Ollama embedder', () => {
  it('POSTs /api/embed on the server address, through the provider, with the nomic prefix', async () => {
    const s = await ollamaServer((body) => ({ model: body.model, embeddings: body.input.map((_, i) => [i + 1, 1, 0]), prompt_eval_count: 7 }));
    try {
      const provider = ProviderFactory.createProvider('ollama', null, { serverUrl: s.url });
      const e = createRemoteEmbedder({ kind: 'ollama', model: 'nomic-embed-text', provider });
      const vecs = await e.embed(['gate'], { kind: 'query' });
      assert.strictEqual(s.seen[0].url, '/api/embed');
      assert.deepStrictEqual(s.seen[0].body, { model: 'nomic-embed-text', input: ['search_query: gate'] });
      assert.ok(Math.abs(vecs[0][0] - Math.SQRT1_2) < 1e-6);
      assert.strictEqual(e.tokens, 7);
      assert.strictEqual(e.name, 'ollama:nomic-embed-text');
    } finally {
      await s.close();
    }
  });

  it('a reply with the wrong number of vectors fails with EMBED_FAILED', async () => {
    const s = await ollamaServer(() => ({ embeddings: [] }));
    try {
      const provider = ProviderFactory.createProvider('ollama', null, { serverUrl: s.url });
      const e = createRemoteEmbedder({ kind: 'ollama', model: 'nomic-embed-text', provider });
      await assert.rejects(e.embed(['gate']), (err) => err.code === 'EMBED_FAILED' || /vectors/.test(err.message));
    } finally {
      await s.close();
    }
  });
});
