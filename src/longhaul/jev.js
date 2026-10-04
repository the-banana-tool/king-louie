'use strict';
// typesafe.ai's Jev as LongHaul's hosted reranker (kl-recall-jev-rerank,
// kl-recall-vec-jev-rerank; recall spec §6.3 step 6, rerank.kind 'jev').
// One client with the app: every request is TypesafeProvider#ask
// (src/providers/typesafe-provider.js, through BaseProvider.request) and
// every request shape is jevScores (src/history/jev-rerank.js). This adds
// what a benchmark run needs: retries with backoff (429, 529, 5xx,
// timeouts, network errors; a refused key, an exhausted account or a 422
// is never retried), a concurrency limit across questions, a token cap
// (--jev-max-tokens), the served-model check (cached scores never mix model
// versions), counts for adapter-stats.json and a calibration histogram.
// Jev is not in the model catalog, so its cost is unpriced: input tokens are
// counted and reported with the price unknown, never $0. Nothing here logs
// or throws request or response text.
const { jevScores, limiter, MODES } = require('../history/jev-rerank');
const TypesafeProvider = require('../providers/typesafe-provider');
const { withRetries, retryable } = require('./retry');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/jev');

// The model asked for, and the cache directory's model part: pinned, so a
// later Jev never answers into this one's cache. The probe asked for
// jev-latest when it was jev-1.13.0; its scores are under
// rerank/<session>/jev-1.13.0-<mode>/.
const JEV_DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_MODE = 'batched';
const DEFAULT_MAX_TOKENS = 20000000;
// Input tokens a candidate costs besides its own text, for the estimate: the
// probe measured about 550 a pair pointwise at 141 estimated chunk tokens,
// and about 26K a question batched at topM 100.
const OVERHEAD_TOKENS = Object.freeze({ pointwise: 450, batched: 120 });
// The UsageError codes from here that stop a run (run.js RUN_STOP_CODES).
const JEV_STOP_CODES = Object.freeze(['JEV_SCORES_MISSING', 'JEV_OVER_TOKENS', 'JEV_MODEL_MISMATCH']);

const jevRetryable = (err) => retryable(err) || Boolean(err && err.code === 'JEV_TIMEOUT');

const newJevUsage = () => ({
  requests: 0, ok: 0, inputTokens: 0, outputTokens: 0, retries: 0, status: {}, timeouts: 0, networkErrors: 0,
  failed: 0, requestMs: [], models: {}
});

function createJevClient({
  apiKey, baseUrl = null, model = JEV_DEFAULT_MODEL, provider = null, concurrency = 24, timeoutMs = 60000,
  retries = 6, baseDelayMs = 500, wait = null, maxTokens = null, now = () => Date.now()
} = {}) {
  if (!provider && !apiKey) throw new UsageError('Jev needs an API key: set TYPESAFE_AI_KEY in the environment.');
  const p = provider || new TypesafeProvider(apiKey, baseUrl ? { baseUrl } : {});
  const usage = newJevUsage();
  const limit = limiter(concurrency);
  const pinned = !/-latest$/.test(model);

  async function once(body, abortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    const t0 = now();
    usage.requests += 1;
    let r;
    try {
      r = await p.ask(body, { abortSignal: signal });
    } catch (err) {
      const callerAborted = Boolean(abortSignal && abortSignal.aborted);
      if (err && Number.isInteger(err.status)) {
        usage.status[err.status] = (usage.status[err.status] || 0) + 1;
      } else if (timeout.aborted && !callerAborted) {
        usage.timeouts += 1;
        throw Object.assign(new Error(`Jev request timed out after ${timeoutMs} ms`), { code: 'JEV_TIMEOUT' });
      } else if (!callerAborted) {
        usage.networkErrors += 1;
      }
      throw err;
    }
    usage.status[200] = (usage.status[200] || 0) + 1;
    usage.ok += 1;
    usage.requestMs.push(now() - t0);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.models[r.model] = (usage.models[r.model] || 0) + 1;
    if (pinned && r.model !== model) {
      throw new UsageError(`typesafe.ai served ${r.model} for ${model}; the run stopped so cached scores never mix model versions. `
        + `Pass --jev-model ${r.model} to score and cache under it.`, 'JEV_MODEL_MISMATCH');
    }
    return r;
  }

  function ask(body, { abortSignal = null } = {}) {
    return limit(async () => {
      try {
        if (maxTokens !== null && usage.inputTokens >= maxTokens) {
          throw new UsageError(`Jev token cap reached: ${usage.inputTokens} input tokens of ${maxTokens} (--jev-max-tokens); nothing more is sent.`, 'JEV_OVER_TOKENS');
        }
        return await withRetries(() => once({ ...body, model }, abortSignal), {
          retries, baseDelayMs, isRetryable: jevRetryable, ...(wait ? { wait } : {}),
          onRetry: ({ err, attempt, delayMs }) => {
            usage.retries += 1;
            log.debug('Jev retry', { status: err.status ?? null, code: err.code || null, attempt, waitMs: Math.round(delayMs) });
          }
        });
      } catch (err) {
        usage.failed += 1;
        throw err;
      }
    });
  }

  return { ask, usage, model, concurrency };
}

// Scores seen, for the calibration note: a 10-bin histogram of the noul
// values plus the per-call spread (max - min of one question's scores).
const newCalibration = () => ({ n: 0, bins: new Array(10).fill(0), sum: 0, sumSq: 0, spreads: [] });

function recordScores(cal, scores) {
  if (!cal || !scores.length) return;
  for (const s of scores) {
    cal.n += 1;
    cal.sum += s;
    cal.sumSq += s * s;
    cal.bins[Math.min(9, Math.max(0, Math.floor(s * 10)))] += 1;
  }
  if (scores.length > 1) cal.spreads.push(Math.max(...scores) - Math.min(...scores));
}

function calibrationSummary(cal) {
  if (!cal || !cal.n) return null;
  const mean = cal.sum / cal.n;
  const sd = Math.sqrt(Math.max(0, cal.sumSq / cal.n - mean * mean));
  const sorted = [...cal.spreads].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  return { scores: cal.n, mean, sd, bins: cal.bins, spreadMedian: q(0.5), spreadP10: q(0.1), calls: sorted.length };
}

function createJevScorer({ client, mode = DEFAULT_MODE, calibration = null }) {
  if (!MODES.includes(mode)) throw new UsageError(`--jev-mode must be ${MODES.join(' or ')}, got ${JSON.stringify(mode)}`);
  return {
    model: `${client.model}-${mode}`,
    async score(query, texts) {
      const out = await jevScores({ ask: client.ask, model: client.model, query, texts, mode, concurrency: client.concurrency || 24 });
      recordScores(calibration, out.scores);
      return out.scores;
    }
  };
}

// Input tokens a run would send with an empty cache (an upper estimate).
function estimateJevTokens({ questions, topM, chunkCount, meanChunkTokens, mode }) {
  return questions * Math.min(topM, chunkCount) * (meanChunkTokens + OVERHEAD_TOKENS[mode]);
}

function usageSummary(usage) {
  const ms = [...usage.requestMs].sort((a, b) => a - b);
  const pick = (p) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]) : null);
  return {
    requests: usage.requests, ok: usage.ok, failed: usage.failed, retries: usage.retries, status: usage.status,
    timeouts: usage.timeouts, networkErrors: usage.networkErrors, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    // Jev is not in the model catalog: unpriced, never $0.
    usd: null, price: 'unknown',
    requestMsMedian: pick(0.5), requestMsP90: pick(0.9), models: usage.models
  };
}

module.exports = {
  JEV_DEFAULT_MODEL, DEFAULT_MODE, DEFAULT_MAX_TOKENS, OVERHEAD_TOKENS, JEV_STOP_CODES,
  createJevClient, createJevScorer, estimateJevTokens, newCalibration, calibrationSummary, usageSummary
};
