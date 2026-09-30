'use strict';
// kl-recall-jev-rerank / kl-recall-vec-jev-rerank: an experiment (branch
// exp/jev-rerank), not a candidate system. kl-recall-rerank with typesafe.ai's
// Jev in place of the local cross-encoder (src/longhaul/jev.js): pointwise
// (one call per pair) or batched (one call per group of chunks). Scores are
// cached like the cross-encoder's, under
// LONGHAUL_HOME/private/rerank/<session>/jev-1.13.0-<mode>/, so a sweep over
// topM or settings pays only for chunks it has not scored.
//
// The chunks of the session go to typesafe.ai, so a private session is
// refused at prepare() unless sendPrivate (--send-private), as `embed`
// refuses before any network call. prepare() also estimates the cost of the
// session's questions (questions x topM x mean chunk tokens, cache ignored,
// so it errs high) and refuses when the run's estimate would pass maxUsd;
// the client refuses further requests once the real spend reaches it.
const { createKlRecallRerankAdapter } = require('./kl-recall-rerank');
const {
  JEV_CACHE_MODEL, createJevClient, createPointwiseScorer, createBatchedScorer, newCalibration, calibrationSummary,
  usageSummary, estTokens, priceUsd
} = require('../jev');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/jev-rerank');

const MODES = ['pointwise', 'batched'];
// Tokens a call adds besides the chunk: the query, the instructions and
// criteria, the JSON (pointwise, per pair).
const PAIR_OVERHEAD_TOKENS = 250;

function median(xs, p = 0.5) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function createKlRecallJevRerankAdapter({
  jevMode = 'pointwise', sendPrivate = false, env = process.env, jevBaseUrl = null, maxUsd = 5, fetchImpl = null,
  jevClient = null, jevOptions = {}, candidates = 'bm25', ...rest
} = {}) {
  if (!MODES.includes(jevMode)) throw new UsageError(`--jev-mode must be ${MODES.join(' or ')}, got ${JSON.stringify(jevMode)}`);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new UsageError(`--jev-max-usd must be a positive number, got ${JSON.stringify(maxUsd)}`);
  const model = `${JEV_CACHE_MODEL}-${jevMode}`;
  const calibration = newCalibration();
  const perQuestion = { ms: [], pairs: [], errors: 0, errorCodes: {} };
  let client = jevClient;
  let inner = null;
  const getClient = () => {
    if (!client) {
      client = createJevClient({
        apiKey: env.TYPESAFE_AI_KEY, maxUsd, ...(jevBaseUrl ? { baseUrl: jevBaseUrl } : {}),
        ...(fetchImpl ? { fetchImpl } : {}), ...jevOptions
      });
    }
    return client;
  };
  let jevScorer = null;
  // Loaded on the first cache miss, so a fully cached run needs no key.
  const scorer = {
    async score(query, texts) {
      if (!jevScorer) {
        const c = getClient();
        jevScorer = jevMode === 'batched' ? createBatchedScorer({ client: c, calibration }) : createPointwiseScorer({ client: c, calibration });
      }
      const t0 = Date.now();
      try {
        const out = await jevScorer.score(query, texts);
        perQuestion.ms.push(Date.now() - t0);
        perQuestion.pairs.push(texts.length);
        return out;
      } catch (err) {
        // The Retriever keeps the fused order for this question; count it.
        perQuestion.errors += 1;
        perQuestion.errorCodes[err.code || 'unknown'] = (perQuestion.errorCodes[err.code || 'unknown'] || 0) + 1;
        log.warn('Jev scoring failed; this question keeps the fused order', { code: err.code, status: err.status ?? null, pairs: texts.length });
        throw err;
      }
    }
  };
  inner = createKlRecallRerankAdapter({ ...rest, sendPrivate, candidates, rerankModel: model, scorer });
  const topM = inner.describe().recall.rerank.topM;
  const name = candidates === 'fused' ? 'kl-recall-vec-jev-rerank' : 'kl-recall-jev-rerank';
  let estimateUsd = 0;

  return {
    name,
    stats: inner.stats,
    describe() {
      return { ...inner.describe(), name, reranker: `typesafe.ai ${model}`, jevMode, maxUsd };
    },

    async prepare(session, options = {}) {
      const sessionId = session.manifest.sessionId;
      if (session.manifest.private && sendPrivate !== true) {
        throw new UsageError(
          `Session ${sessionId} is private: ${name} sends its chunks and questions to typesafe.ai (Jev). Pass --send-private to allow that.`,
          'PRIVATE_SESSION'
        );
      }
      const handle = await inner.prepare(session, options);
      try {
        const chunks = handle.store.chunksOfChat(handle.chatId);
        const meanChunk = chunks.length ? chunks.reduce((n, c) => n + estTokens(c.text), 0) / chunks.length : 0;
        const questions = Number.isInteger(options.questionCount) ? options.questionCount : 0;
        const pairs = questions * Math.min(topM, chunks.length);
        const est = priceUsd(pairs * (meanChunk + PAIR_OVERHEAD_TOKENS));
        estimateUsd += est;
        log.info('Jev cost estimate (cache ignored)', { sessionId, questions, topM, meanChunkTokens: Math.round(meanChunk), usd: Number(est.toFixed(4)), runUsd: Number(estimateUsd.toFixed(4)) });
        if (estimateUsd > maxUsd) {
          throw new UsageError(`${name}: the estimated Jev cost of this run, $${estimateUsd.toFixed(2)} (cache ignored), is over the $${maxUsd} cap; nothing more is sent.`, 'JEV_OVER_BUDGET');
        }
        if (session.manifest.private) log.info('chunks of a private session go to typesafe.ai (--send-private)', { sessionId });
        return handle;
      } catch (err) {
        await inner.release(handle);
        throw err;
      }
    },
    context: (handle, args) => inner.context(handle, args),
    release: (handle) => inner.release(handle),

    // Numbers only, for adapter-stats.json.
    runStats() {
      return {
        mode: jevMode,
        cacheModel: model,
        topM,
        estimateUsd: Number(estimateUsd.toFixed(4)),
        rerank: { ...inner.stats },
        uncachedQuestions: perQuestion.ms.length,
        uncachedMsMedian: median(perQuestion.ms),
        uncachedMsP90: median(perQuestion.ms, 0.9),
        uncachedPairsMedian: median(perQuestion.pairs),
        scoreErrors: perQuestion.errors,
        scoreErrorCodes: perQuestion.errorCodes,
        jev: client ? usageSummary(client.usage) : null,
        calibration: calibrationSummary(calibration)
      };
    }
  };
}

module.exports = { createKlRecallJevRerankAdapter, MODES };
