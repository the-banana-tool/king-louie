'use strict';
// Jev (typesafe.ai's hosted "System One" API) as a reranker for the H3 probe
// (kl-recall-jev-rerank; recall spec §6.3 step 6). An experiment on
// exp/jev-rerank, not a candidate dependency of the app.
//
// POST <baseUrl>/v1/systemone with { model, state, questions }; each `noul`
// question comes back as answers[id].noul, a probability in [0, 1] that the
// answer is yes. Two scorers with the `score(query, texts) => number[]` shape
// createCachedReranker takes:
//   pointwise  one call per (query, chunk), the cookbook's shape
//   batched    one call per group of chunks, one noul per chunk, the group
//              sized so the state stays under maxStateTokens
// The session's chunks go to typesafe.ai, so the adapter refuses a private
// session without --send-private. Nothing here logs or throws request or
// response text: errors carry the HTTP status only (a 422 body could echo
// the state).
const { performance } = require('node:perf_hooks');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/jev');

const JEV_BASE_URL = 'https://api.typesafe.ai';
const JEV_MODEL = 'jev-latest';
// The cache key's model part; jev-latest was jev-1.13.0 when this probe ran
// (the client records the model each response names in usage.models).
const JEV_CACHE_MODEL = 'jev-1.13.0';
// USD per million input tokens (output is free), from docs.typesafe.ai
// models.md for jev-1.13.0. A constant of this probe: the model catalog does
// not know Jev.
const JEV_USD_PER_M_INPUT = 0.042;
// Rough tokens for estimates and batch sizing: 3 characters a token errs high.
const EST_CHARS_PER_TOKEN = 3;
const estTokens = (text) => Math.ceil(String(text || '').length / EST_CHARS_PER_TOKEN);
const priceUsd = (inputTokens) => (inputTokens / 1e6) * JEV_USD_PER_M_INPUT;

const RETRY_STATUS = new Set([429, 529, 500, 502, 503, 504]);

class JevError extends Error {
  constructor(message, { status = null, code = 'JEV_ERROR' } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A counting semaphore: at most `limit` calls of fn run at once.
function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const newJevUsage = () => ({
  requests: 0, ok: 0, inputTokens: 0, outputTokens: 0, retries: 0, status: {}, timeouts: 0, networkErrors: 0,
  failed: 0, requestMs: [], models: {}
});

// The client: ask({ state, questions }) => { answers, usage, model }.
// Retries 429, 529, 5xx, timeouts and network errors with exponential
// backoff (base * 2^attempt, jittered, or Retry-After when given), up to
// maxRetries; 401 and 422 fail at once. maxUsd (optional) refuses a request
// once the tokens already spent cost that much.
function createJevClient({
  apiKey, baseUrl = JEV_BASE_URL, model = JEV_MODEL, fetchImpl = globalThis.fetch, concurrency = 24,
  timeoutMs = 60000, maxRetries = 6, backoffMs = 500, maxBackoffMs = 20000, wait = sleep, maxUsd = null, random = Math.random
} = {}) {
  if (!apiKey) throw new UsageError('Jev needs an API key: set TYPESAFE_AI_KEY in the environment.');
  if (typeof fetchImpl !== 'function') throw new Error('Jev needs fetch');
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/systemone`;
  const usage = newJevUsage();
  const limit = limiter(concurrency);

  async function once(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      usage.requests += 1;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: ctrl.signal
        });
      } catch (err) {
        if (ctrl.signal.aborted) { usage.timeouts += 1; throw new JevError(`Jev request timed out after ${timeoutMs} ms`, { code: 'JEV_TIMEOUT' }); }
        usage.networkErrors += 1;
        throw new JevError(`Jev network error (${err.code || err.name || 'unknown'})`, { code: 'JEV_NETWORK' });
      }
      usage.status[res.status] = (usage.status[res.status] || 0) + 1;
      if (!res.ok) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        try { await res.arrayBuffer(); } catch { /* drain only */ }
        const err = new JevError(`Jev answered HTTP ${res.status}`, { status: res.status, code: `JEV_HTTP_${res.status}` });
        if (Number.isFinite(retryAfter) && retryAfter >= 0) err.retryAfterMs = retryAfter * 1000;
        throw err;
      }
      let json;
      try { json = await res.json(); } catch { throw new JevError('Jev answered with a body that is not JSON', { status: res.status, code: 'JEV_BAD_BODY' }); }
      usage.ok += 1;
      usage.requestMs.push(performance.now() - t0);
      usage.inputTokens += Number(json?.usage?.input_tokens) || 0;
      usage.outputTokens += Number(json?.usage?.output_tokens) || 0;
      if (json?.model) usage.models[json.model] = (usage.models[json.model] || 0) + 1;
      return { answers: json?.answers || {}, usage: json?.usage || null, model: json?.model || null };
    } finally {
      clearTimeout(timer);
    }
  }

  const retryable = (err) => err.code === 'JEV_TIMEOUT' || err.code === 'JEV_NETWORK' || RETRY_STATUS.has(err.status);

  async function ask({ state, questions }) {
    if (maxUsd !== null && priceUsd(usage.inputTokens) >= maxUsd) {
      throw new JevError(`Jev spend cap reached: $${priceUsd(usage.inputTokens).toFixed(4)} of $${maxUsd}`, { code: 'JEV_SPEND_CAP' });
    }
    const body = JSON.stringify({ model, state, questions });
    return limit(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(body);
        } catch (err) {
          if (!(err instanceof JevError) || !retryable(err) || attempt >= maxRetries) {
            usage.failed += 1;
            throw err;
          }
          usage.retries += 1;
          const backoff = Math.min(maxBackoffMs, backoffMs * 2 ** attempt) * (0.5 + random());
          const ms = Number.isFinite(err.retryAfterMs) ? Math.max(err.retryAfterMs, backoff) : backoff;
          log.debug('Jev retry', { status: err.status, code: err.code, attempt: attempt + 1, waitMs: Math.round(ms) });
          await wait(ms);
        }
      }
    });
  }

  return { ask, usage, url, model };
}

// The question each chunk is asked (the cookbook's "does the candidate
// establish what the query asks", worded for a chat history).
const QUERY_FRAME = 'The query is a new message in a long chat between an owner and an assistant. '
  + 'Candidates are excerpts from earlier in the same chat.';
const CRITERIA = {
  true: 'The candidate states or establishes the specific fact, value, decision, event or result the query asks about, so it would help answer the query.',
  false: 'The candidate is merely on a similar topic, mentions the same words, or does not contain what the query asks about.'
};

function pointwiseQuestion() {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does candidate_passage establish what query_excerpt asks about?`,
    criteria: CRITERIA
  };
}

function batchedQuestion(id) {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does the candidate with id "${id}" establish what the query asks about? Judge only that candidate.`,
    criteria: CRITERIA
  };
}

function noulOf(answers, id) {
  const n = Number(answers?.[id]?.noul);
  if (!Number.isFinite(n)) throw new JevError(`Jev returned no noul for ${id}`, { code: 'JEV_NO_ANSWER' });
  return n;
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

function createPointwiseScorer({ client, calibration = null }) {
  return {
    model: `${JEV_CACHE_MODEL}-pointwise`,
    async score(query, texts) {
      const out = await Promise.all(texts.map((text) => client.ask({
        state: { query_excerpt: query, candidate_passage: text },
        questions: { establishes: pointwiseQuestion() }
      }).then((r) => noulOf(r.answers, 'establishes'))));
      recordScores(calibration, out);
      return out;
    }
  };
}

// Groups of indexes whose state (query + candidates + the questions) stays
// under maxStateTokens and holds at most maxPerCall candidates. A chunk too
// big for any group on its own gets a group of its own.
function planBatches(query, texts, { maxStateTokens = 28000, maxPerCall = 60, perCandidateOverhead = 80 } = {}) {
  const base = estTokens(query) + 200;
  const groups = [];
  let cur = [];
  let used = base;
  texts.forEach((text, i) => {
    const t = estTokens(text) + perCandidateOverhead;
    if (cur.length && (used + t > maxStateTokens || cur.length >= maxPerCall)) {
      groups.push(cur);
      cur = [];
      used = base;
    }
    cur.push(i);
    used += t;
  });
  if (cur.length) groups.push(cur);
  return groups;
}

function createBatchedScorer({ client, calibration = null, maxStateTokens = 28000, maxPerCall = 60 }) {
  return {
    model: `${JEV_CACHE_MODEL}-batched`,
    async score(query, texts) {
      const out = new Array(texts.length);
      const groups = planBatches(query, texts, { maxStateTokens, maxPerCall });
      await Promise.all(groups.map(async (group) => {
        const ids = group.map((_, k) => `c${k + 1}`);
        const questions = {};
        for (const id of ids) questions[id] = batchedQuestion(id);
        const r = await client.ask({
          state: { query, candidates: group.map((i, k) => ({ id: ids[k], text: texts[i] })) },
          questions
        });
        group.forEach((i, k) => { out[i] = noulOf(r.answers, ids[k]); });
      }));
      recordScores(calibration, out);
      return out;
    }
  };
}

function calibrationSummary(cal) {
  if (!cal || !cal.n) return null;
  const mean = cal.sum / cal.n;
  const sd = Math.sqrt(Math.max(0, cal.sumSq / cal.n - mean * mean));
  const sorted = [...cal.spreads].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  return { scores: cal.n, mean, sd, bins: cal.bins, spreadMedian: q(0.5), spreadP10: q(0.1), calls: sorted.length };
}

function usageSummary(usage) {
  const ms = [...usage.requestMs].sort((a, b) => a - b);
  const pick = (p) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]) : null);
  return {
    requests: usage.requests, ok: usage.ok, failed: usage.failed, retries: usage.retries, status: usage.status,
    timeouts: usage.timeouts, networkErrors: usage.networkErrors, inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens, usd: Number(priceUsd(usage.inputTokens).toFixed(4)),
    requestMsMedian: pick(0.5), requestMsP90: pick(0.9), models: usage.models
  };
}

module.exports = {
  JEV_BASE_URL, JEV_MODEL, JEV_CACHE_MODEL, JEV_USD_PER_M_INPUT, EST_CHARS_PER_TOKEN, JevError,
  estTokens, priceUsd, createJevClient, createPointwiseScorer, createBatchedScorer, planBatches,
  pointwiseQuestion, batchedQuestion, newCalibration, calibrationSummary, usageSummary
};
