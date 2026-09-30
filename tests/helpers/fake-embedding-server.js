// tests/helpers/fake-embedding-server.js
// A local stand-in for OpenAI's POST /v1/embeddings: hashed bag-of-words
// vectors (texts sharing words get a high cosine), usage = word count. It can
// answer the first `failFirst` requests with 429. Never the network.
const http = require('http');

const DIM = 64;

function fakeVector(text, dim = DIM) {
  const v = new Array(dim).fill(0);
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const wordCount = (text) => (String(text).match(/\S+/g) || []).length;

// An in-process embedder with OpenAIProvider#embed's shape.
function fakeEmbedder() {
  const calls = [];
  return {
    calls,
    async embed(inputs, { model } = {}) {
      calls.push({ n: inputs.length, model });
      return { vectors: inputs.map((t) => fakeVector(t)), usage: { input: inputs.reduce((n, t) => n + wordCount(t), 0) }, model };
    }
  };
}

async function startFakeEmbeddingServer({ failFirst = 0 } = {}) {
  const state = { requests: [], failures: failFirst };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ path: req.url, inputs: Array.isArray(body?.input) ? body.input.length : 0, model: body?.model });
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || !req.url.endsWith('/embeddings')) return send(404, { error: { message: 'no route' } });
      if (state.failures > 0) {
        state.failures -= 1;
        return send(429, { error: { message: 'rate limited' } });
      }
      const inputs = body.input.map(String);
      return send(200, {
        object: 'list',
        model: body.model,
        data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: fakeVector(t) })),
        usage: { prompt_tokens: inputs.reduce((n, t) => n + wordCount(t), 0), total_tokens: 0 }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests: state.requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { DIM, fakeVector, fakeEmbedder, startFakeEmbeddingServer };
