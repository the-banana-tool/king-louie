'use strict';
// kl-recall-vec: an H3 probe, not a candidate system. kl-recall plus a
// vector signal (recall spec §6.3 step 2): the question embedded once
// (cached), cosine against every cached chunk vector with seq < askAtSeq,
// the top vectorTopK fused with BM25 by the retriever's reciprocal rank
// fusion. vectorOnly leaves BM25 out, to see cosine alone. The chunk vectors
// come only from `longhaul embed`'s cache (LONGHAUL_HOME/private/embeddings);
// a missing or incomplete cache is refused. Latency excludes the question's
// embedding call (made before the measured part, and cached).
const { createKlRecallAdapter, resultFromBuild, ESTIMATOR_MODEL } = require('./kl-recall');
const { measured } = require('./common');
const {
  EmbeddingCache, cacheDir, vectorIndexFor, topByCosine, createEmbedClient, embedderFromEnv, embedText
} = require('../embeddings');
const { UsageError } = require('../errors');

const DEFAULT_MODEL = 'text-embedding-3-small';

function createKlRecallVecAdapter({
  budgetTokens = 6000, recall = {}, tmpRoot, privateRoot, provider = 'openai', model = DEFAULT_MODEL,
  vectorOnly = false, sendPrivate = false, env = process.env, baseUrl = null, providerInstance = null, rerankerFor = null
} = {}) {
  if (typeof privateRoot !== 'string' || !privateRoot) throw new Error('kl-recall-vec needs a privateRoot (LONGHAUL_HOME/private)');
  const base = createKlRecallAdapter({ budgetTokens, recall, tmpRoot });
  const name = vectorOnly ? 'kl-recall-vec-only' : 'kl-recall-vec';
  let client = null;
  const embedClient = () => {
    if (!client) client = createEmbedClient({ embedder: embedderFromEnv({ provider, env, baseUrl, providerInstance }), model });
    return client;
  };

  async function questionVector(handle, question) {
    const { cache, sessionId, isPrivate } = handle.vec;
    const cached = cache.question(question.id, question.question);
    if (cached) return cached;
    if (isPrivate && !sendPrivate) {
      throw new UsageError(`kl-recall-vec: question ${question.id} of private session ${sessionId} has no cached vector; `
        + `run longhaul embed --session ${sessionId} --send-private first, or pass --send-private to embed it now.`);
    }
    const res = await embedClient().embed([embedText(question.question).text]);
    cache.addQuestion(question.id, question.question, res.vectors[0], { tokens: res.usage?.input || 0 });
    return Float32Array.from(res.vectors[0]);
  }

  return {
    name,
    describe() {
      return { ...base.describe(), name, embedder: `${provider}/${model}`, vectorOnly: Boolean(vectorOnly) };
    },

    async prepare(session, options = {}) {
      const handle = await base.prepare(session, options);
      try {
        const sessionId = session.manifest.sessionId;
        const cache = EmbeddingCache.open(cacheDir(privateRoot, sessionId, model));
        if (cache.exists && JSON.stringify(cache.meta.chunk) !== JSON.stringify(handle.settings.history.chunk)) {
          throw new UsageError(`kl-recall-vec: the embedding cache for ${sessionId} was chunked with other settings; run longhaul embed again into a fresh cache.`);
        }
        const index = vectorIndexFor(cache, handle.store.chunksOfChat(handle.chatId), { sessionId, model });
        handle.vec = { cache, index, sessionId, isPrivate: Boolean(session.manifest.private) };
        return handle;
      } catch (err) {
        await base.release(handle);
        throw err;
      }
    },

    async context(handle, { question, askAtSeq }) {
      const q = await questionVector(handle, question);
      return measured(async () => {
        const k = handle.settings.history.recall.vectorTopK;
        const vectorHits = topByCosine(handle.vec.index, q, { upToSeq: askAtSeq, k });
        const reranker = rerankerFor ? rerankerFor(handle, question) : null;
        const out = await handle.builder.build({
          chatId: handle.chatId, message: question.question, model: ESTIMATOR_MODEL, upToSeq: askAtSeq,
          vectorHits, lexical: !vectorOnly, reranker
        });
        return resultFromBuild(handle, out);
      });
    },

    release(handle) {
      return base.release(handle);
    }
  };
}

module.exports = { createKlRecallVecAdapter, DEFAULT_MODEL };
