'use strict';
// kl-recall-rerank: an H3 probe, not a candidate system. kl-recall (BM25
// candidates) or kl-recall-vec (candidates: 'fused', BM25 fused with cosine)
// plus recall spec §6.3 step 6: a local cross-encoder rescores the top
// rerank.topM candidates (default 20; rerank.enabled is forced on). Scores
// are cached per question and chunk under LONGHAUL_HOME/private/rerank/
// (src/longhaul/rerank.js), so a second run over the same settings is near
// free. Latency includes the reranker call: on a cache miss that is the real
// CPU cost; on a hit it is not, and the report must say which it measured.
const { createKlRecallAdapter } = require('./kl-recall');
const { createKlRecallVecAdapter } = require('./kl-recall-vec');
const {
  DEFAULT_RERANK_MODEL, rerankCacheDir, RerankCache, loadCrossEncoder, createCachedReranker, newRerankStats
} = require('../rerank');

const PROBE_RERANK_MAX_MS = 10 * 60 * 1000;

function createKlRecallRerankAdapter({
  recall = {}, privateRoot, candidates = 'bm25', rerankModel = DEFAULT_RERANK_MODEL, scorer = null, ...rest
} = {}) {
  if (typeof privateRoot !== 'string' || !privateRoot) throw new Error('kl-recall-rerank needs a privateRoot (LONGHAUL_HOME/private)');
  if (candidates !== 'bm25' && candidates !== 'fused') throw new Error(`kl-recall-rerank candidates must be bm25 or fused, got ${JSON.stringify(candidates)}`);
  // maxMs: the probe measures what the rerank selects, so a cold cache
  // (a real cross-encoder call, about 2 s at topM 100) must not time out.
  const withRerank = { ...recall, rerank: { enabled: true, topM: 20, maxMs: PROBE_RERANK_MAX_MS, ...(recall.rerank || {}) } };
  const cacheDirFor = (sessionId) => rerankCacheDir(privateRoot, sessionId, rerankModel);
  // The cross-encoder loads on the first cache miss, once per adapter.
  let loading = null;
  const getScorer = () => {
    if (scorer) return scorer;
    if (!loading) loading = loadCrossEncoder({ model: rerankModel });
    return loading;
  };
  const stats = newRerankStats();
  const caches = new Map();
  const rerankerFor = (handle, question) => {
    const sessionId = handle.session.manifest.sessionId;
    if (!caches.has(sessionId)) caches.set(sessionId, RerankCache.open(cacheDirFor(sessionId)));
    return createCachedReranker({ cache: caches.get(sessionId), questionId: question.id, scorer: getScorer, stats });
  };
  const base = candidates === 'fused'
    ? createKlRecallVecAdapter({ ...rest, recall: withRerank, privateRoot, rerankerFor })
    : createKlRecallAdapter({ ...rest, recall: withRerank, rerankerFor });
  const name = candidates === 'fused' ? 'kl-recall-vec-rerank' : 'kl-recall-rerank';
  return {
    name,
    stats,
    describe() {
      return { ...base.describe(), name, reranker: rerankModel, candidates, latency: 'includes the reranker; cached scores cost no model time' };
    },
    ...(base.missingQuestionVectors ? { missingQuestionVectors: (session, questions) => base.missingQuestionVectors(session, questions) } : {}),
    prepare: (session, options) => base.prepare(session, options),
    context: (handle, args) => base.context(handle, args),
    release: (handle) => base.release(handle)
  };
}

module.exports = { createKlRecallRerankAdapter };
