// src/history/embedders/remote.js
// The hosted embedders (recall spec §5.2): OpenAI through OpenAIProvider#embed
// and Ollama through OllamaProvider#embed, so every request goes through
// BaseProvider.request. Texts are cut to MAX_EMBED_CHARS and prefixed for the
// model; vectors come back unit length. The OpenAI kind sends chat text to
// OpenAI; the settings pane says so.
const { EmbedError } = require('../embed-errors');
const { embedInput, unit } = require('./vectors');
const { prefixTexts } = require('./profiles');

// Inputs per provider request; the providers' own limits are far higher.
const REMOTE_BATCH = 100;

function createRemoteEmbedder({ kind, model, provider }) {
  if (kind !== 'openai' && kind !== 'ollama') throw new TypeError(`not a hosted embedder kind: ${kind}`);
  if (!provider || typeof provider.embed !== 'function') {
    throw new EmbedError('EMBEDDER_UNAVAILABLE', `the ${kind} provider has no embeddings call`);
  }
  const embedder = {
    name: `${kind}:${model}`,
    kind,
    model,
    dim: null,
    tokens: 0,
    async embed(texts, { kind: textKind = 'document', abortSignal } = {}) {
      if (!Array.isArray(texts) || !texts.length) return [];
      const inputs = prefixTexts(model, texts.map(embedInput), textKind);
      const out = [];
      for (let i = 0; i < inputs.length; i += REMOTE_BATCH) {
        const slice = inputs.slice(i, i + REMOTE_BATCH);
        const res = await provider.embed(slice, { model, abortSignal });
        if (!res || !Array.isArray(res.vectors) || res.vectors.length !== slice.length) {
          throw new EmbedError('EMBED_FAILED', `the ${kind} embedder returned ${res && Array.isArray(res.vectors) ? res.vectors.length : 'no'} vectors for ${slice.length} texts`);
        }
        if (Number.isFinite(res.usage?.input)) embedder.tokens += res.usage.input;
        for (const v of res.vectors) out.push(unit(v));
      }
      if (embedder.dim === null) embedder.dim = out[0].length;
      if (out.some((v) => v.length !== embedder.dim)) throw new EmbedError('EMBED_FAILED', `the ${kind} embedder changed its vector size`);
      return out;
    }
  };
  return embedder;
}

module.exports = { createRemoteEmbedder, REMOTE_BATCH };
