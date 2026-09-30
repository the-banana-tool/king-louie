// src/history/embedders/local.js
// The local Embedder (recall spec §5.2): texts cut and prefixed for the
// model here, embedded in the embed worker through the EmbedRunner, vectors
// made unit length. ready() loads the model (downloading it the first time).
const { embedInput, unit } = require('./vectors');
const { prefixTexts } = require('./profiles');

function createLocalEmbedder({ runner, model, modelsDir, allowDownload = true }) {
  const embedder = {
    name: `local:${model}`,
    kind: 'local',
    model,
    dim: null,
    tokens: 0,
    // The load reply's dim is not used: a transformers.js model knows its
    // size only after the first embed, so dim comes from the first vector.
    async ready() {
      await runner.load('embedder', model, { modelsDir, allowDownload });
    },
    async embed(texts, { kind = 'document' } = {}) {
      if (!Array.isArray(texts) || !texts.length) return [];
      const inputs = prefixTexts(model, texts.map(embedInput), kind);
      const vecs = await runner.embed(model, inputs, { priority: kind === 'query' ? 'query' : 'document' });
      const out = vecs.map(unit);
      if (embedder.dim === null && out.length) embedder.dim = out[0].length;
      return out;
    }
  };
  return embedder;
}

module.exports = { createLocalEmbedder };
