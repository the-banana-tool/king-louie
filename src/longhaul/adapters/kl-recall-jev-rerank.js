'use strict';
// kl-recall-jev-rerank / kl-recall-vec-jev-rerank: kl-recall-rerank with
// typesafe.ai's Jev in place of the local cross-encoder (recall spec §6.3
// step 6, rerank.kind 'jev'): batched by default, or pointwise
// (src/longhaul/jev.js, on the app's TypesafeProvider and jevScores).
// Scores are cached like the cross-encoder's, under
// LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/, so a sweep over
// settings pays only for chunks not yet scored; a fully cached run needs no
// key. Refused before any request: a private session without sendPrivate
// (--send-private: its chunks and questions go to typesafe.ai), and a run
// whose estimate (cache ignored) is over maxTokens (--jev-max-tokens).
// cachedOnly (the answer stage and its dry run): a score not in the cache
// stops the run (JEV_SCORES_MISSING) rather than call Jev outside the
// priced plan; run the evidence-only run with the same settings first.
// The Retriever keeps the fused order on any reranker failure, so a failure
// every later question would share (a refused key: AUTH; an exhausted
// account: QUOTA; the token cap; a model mismatch; no key) is remembered and
// thrown from context(), and run.js lets it stop the run.
const { createKlRecallRerankAdapter } = require('./kl-recall-rerank');
const {
  JEV_DEFAULT_MODEL, DEFAULT_MODE, DEFAULT_MAX_TOKENS, createJevClient, createJevScorer, newCalibration, calibrationSummary,
  usageSummary, estimateJevTokens
} = require('../jev');
const { MODES, estTokens } = require('../../history/jev-rerank');
const { stopErrorFor } = require('../retry');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/jev-rerank');

function median(xs, p = 0.5) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function createKlRecallJevRerankAdapter({
  jevMode = DEFAULT_MODE, jevModel = JEV_DEFAULT_MODEL, sendPrivate = false, env = process.env, jevBaseUrl = null,
  maxTokens = DEFAULT_MAX_TOKENS, cachedOnly = false, jevClient = null, jevOptions = {}, candidates = 'bm25', recall = {}, ...rest
} = {}) {
  if (!MODES.includes(jevMode)) throw new UsageError(`--jev-mode must be ${MODES.join(' or ')}, got ${JSON.stringify(jevMode)}`);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new UsageError(`--jev-max-tokens must be a positive number, got ${JSON.stringify(maxTokens)}`);
  const name = candidates === 'fused' ? 'kl-recall-vec-jev-rerank' : 'kl-recall-jev-rerank';
  const cacheModel = `${jevModel}-${jevMode}`;
  const calibration = newCalibration();
  const perQuestion = { ms: [], pairs: [], errors: 0, errorCodes: {} };
  let client = jevClient;
  let jevScorer = null;
  let fatal = null;
  const getClient = () => {
    if (!client) {
      client = createJevClient({ apiKey: env.TYPESAFE_AI_KEY, model: jevModel, maxTokens, ...(jevBaseUrl ? { baseUrl: jevBaseUrl } : {}), ...jevOptions });
    }
    return client;
  };
  // Called only on a cache miss (createCachedReranker).
  const scorer = {
    async score(query, texts) {
      if (fatal) throw fatal;
      if (cachedOnly) {
        fatal = new UsageError(`${name}: Jev scores for ${texts.length} candidates are not cached for these settings, and the answer stage `
          + 'sends nothing outside its priced plan; nothing was sent. Run the same adapters and settings without the answer stage '
          + '(an evidence-only run) first.', 'JEV_SCORES_MISSING');
        throw fatal;
      }
      const t0 = Date.now();
      try {
        if (!jevScorer) jevScorer = createJevScorer({ client: getClient(), mode: jevMode, calibration });
        const out = await jevScorer.score(query, texts);
        perQuestion.ms.push(Date.now() - t0);
        perQuestion.pairs.push(texts.length);
        return out;
      } catch (err) {
        perQuestion.errors += 1;
        const code = (err && err.code) || (err && Number.isInteger(err.status) ? `HTTP_${err.status}` : 'unknown');
        perQuestion.errorCodes[code] = (perQuestion.errorCodes[code] || 0) + 1;
        const stop = err instanceof UsageError ? err : stopErrorFor(err, 'typesafe.ai', 'the Jev reranker');
        if (stop && !fatal) fatal = stop;
        log.warn('Jev scoring failed; this question keeps the fused order', { code, status: err?.status ?? null, pairs: texts.length, stops: Boolean(stop) });
        throw err;
      }
    }
  };
  const inner = createKlRecallRerankAdapter({
    ...rest, env, sendPrivate, candidates, rerankModel: cacheModel, scorer,
    recall: { ...recall, rerank: { ...(recall.rerank || {}), kind: 'jev' } }
  });
  const topM = inner.describe().recall.rerank.topM;
  let estimateTokens = 0;

  return {
    name,
    stats: inner.stats,
    describe() {
      return { ...inner.describe(), name, reranker: `typesafe.ai ${cacheModel}`, jevMode, jevModel };
    },
    ...(inner.missingQuestionVectors ? { missingQuestionVectors: (session, questions) => inner.missingQuestionVectors(session, questions) } : {}),

    async prepare(session, options = {}) {
      const sessionId = session.manifest.sessionId;
      if (session.manifest.private && sendPrivate !== true) {
        throw new UsageError(`Session ${sessionId} is private: ${name} sends its chunks and questions to typesafe.ai (Jev). `
          + 'Pass --send-private to allow that.', 'PRIVATE_SESSION');
      }
      const handle = await inner.prepare(session, options);
      try {
        if (!cachedOnly) {
          const chunks = handle.store.chunksOfChat(handle.chatId);
          const meanChunkTokens = chunks.length ? chunks.reduce((n, c) => n + estTokens(c.text), 0) / chunks.length : 0;
          const questions = Number.isInteger(options.questionCount) ? options.questionCount : 0;
          const est = estimateJevTokens({ questions, topM, chunkCount: chunks.length, meanChunkTokens, mode: jevMode });
          estimateTokens += est;
          log.info('Jev estimate (cache ignored)', {
            sessionId, questions, topM, meanChunkTokens: Math.round(meanChunkTokens), tokens: Math.round(est), runTokens: Math.round(estimateTokens)
          });
          if (estimateTokens > maxTokens) {
            throw new UsageError(`${name}: the run's Jev estimate, ${Math.round(estimateTokens)} input tokens (cache ignored), is over `
              + `--jev-max-tokens ${maxTokens}; nothing was sent.`, 'JEV_OVER_TOKENS');
          }
          if (session.manifest.private) log.info('chunks of a private session go to typesafe.ai (--send-private)', { sessionId });
        }
        return handle;
      } catch (err) {
        await inner.release(handle);
        throw err;
      }
    },

    async context(handle, args) {
      const out = await inner.context(handle, args);
      if (fatal) throw fatal;
      return out;
    },
    release: (handle) => inner.release(handle),
    close: () => inner.close(),

    // Numbers only, for adapter-stats.json.
    runStats() {
      return {
        mode: jevMode, cacheModel, topM, cachedOnly, estimateTokens: Math.round(estimateTokens),
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

module.exports = { createKlRecallJevRerankAdapter };
