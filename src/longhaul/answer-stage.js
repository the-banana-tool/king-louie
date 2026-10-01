'use strict';
// The answer stage for one (adapter, question) item (benchmark spec §8
// steps 3 and 4, §15): the answer call on the adapter's context, then the
// judge call on the reply, both through the model cache. Returns the
// record's fields (verdicts, booleans, numbers, error codes) and, apart, the
// reply and the verdict's reason for the spot-check sample; a record never
// carries text. A call that fails after its retries is recorded as an error
// code and left out of the rates. A refused key (401/403) stops the run,
// since every later call would fail the same way.
const path = require('path');
const { cacheKey, cachedCall, stableStringify } = require('./model-cache');
const { buildAnswerPrompt, NOTHING_SHOWN } = require('./answer');
const { buildJudgePrompt, parseVerdict, scoreVerdict } = require('./judge');
const { isAuthFailure } = require('./retry');
const { sha256Text, writeFileAtomic } = require('./files');
const { createRng } = require('./rng');
const { UsageError } = require('./errors');
const { sampleQuestions } = require('./sampling');
const { bucketFor, computeDistance } = require('./questions');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/answer-stage');
const SPOT_CHECK_FRACTION = 0.1;

const EMPTY_ANSWER_FIELDS = Object.freeze({
  verdict: null, answerCorrect: null, abstainCorrect: null, answerError: null,
  answerCached: null, answerInputTokens: null, answerOutputTokens: null, answerCostUsd: null, answerLatencyMs: null,
  judgeCached: null, judgeInputTokens: null, judgeOutputTokens: null, judgeCostUsd: null
});

// The reference side of a question: editing it (in verify) makes new keys.
function questionSha256(q) {
  return sha256Text(stableStringify({ question: q.question, kind: q.kind, answer: q.answer, acceptableAnswers: q.acceptableAnswers || [] }));
}

// baseUrl is set only on a client built with --<role>-base-url; undefined
// drops out of the key, so another endpoint serving the same model name
// never shares an entry with the provider's own API.
function answerKey({ adapterConfigSha256, question, contextSha256, client, promptSha256, maxTokens }) {
  return cacheKey({
    stage: 'answer', adapterConfigSha256, sessionId: question.sessionId, questionId: question.id, questionSha256: questionSha256(question),
    contextSha256, emptyContext: NOTHING_SHOWN, provider: client.provider, model: client.model, baseUrl: client.baseUrl, promptSha256, maxTokens
  });
}

// The judge's key is the hash of the prompt as sent (like a summary's
// inputSha256): judge-v1.md, the kind rule, the reference and acceptable
// answers, the reply and the strings judge.js splices in are all in it, so
// editing any of them makes new keys, and an unchanged prompt is a hit.
function judgeKey({ answerCacheKey, prompt, client, maxTokens }) {
  return cacheKey({
    stage: 'judge', answerCacheKey, inputSha256: sha256Text(prompt),
    provider: client.provider, model: client.model, baseUrl: client.baseUrl, maxTokens
  });
}

function errorCode(stage, err) {
  if (err && err.code === 'OVER_BUDGET') return 'over-budget';
  return `${stage}-failed${Number.isInteger(err?.status) ? `:${err.status}` : ''}`;
}

async function answerAndJudge(item, deps) {
  const { question } = item;
  const fields = { ...EMPTY_ANSWER_FIELDS };
  const meta = { sessionId: question.sessionId, questionId: question.id, adapter: item.adapter };
  const failed = (stage, err, reply = null) => {
    if (isAuthFailure(err)) {
      const provider = stage === 'answer' ? deps.answerClient.provider : deps.judgeClient.provider;
      throw new UsageError(`${provider} refused the API key (${err.status}); the run stopped. Finished calls are cached, so running again costs only what is left.`, 'AUTH');
    }
    fields.answerError = errorCode(stage, err);
    log.warn('model call failed', { stage, questionId: question.id, adapter: item.adapter, code: fields.answerError });
    return { fields, reply, reason: null };
  };

  const aKey = answerKey({
    adapterConfigSha256: item.adapterConfigSha256, question, contextSha256: item.contextSha256,
    client: deps.answerClient, promptSha256: deps.prompts.answer.sha256, maxTokens: deps.answerMaxTokens
  });
  let answer;
  try {
    answer = await cachedCall({
      cache: deps.cache, stage: 'answer', key: aKey, client: deps.answerClient,
      prompt: buildAnswerPrompt(deps.prompts.answer.text, { context: item.context, question }),
      maxTokens: deps.answerMaxTokens, hooks: deps.hooks, retry: deps.retry, meta
    });
  } catch (err) {
    return failed('answer', err);
  }
  Object.assign(fields, {
    answerCached: answer.cached, answerInputTokens: answer.inputTokens, answerOutputTokens: answer.outputTokens,
    answerCostUsd: answer.costUsd, answerLatencyMs: answer.latencyMs
  });

  const judgePrompt = buildJudgePrompt(deps.prompts.judge.text, { question, reply: answer.text });
  let judged;
  try {
    judged = await cachedCall({
      cache: deps.cache, stage: 'judge',
      key: judgeKey({ answerCacheKey: aKey, prompt: judgePrompt, client: deps.judgeClient, maxTokens: deps.judgeMaxTokens }),
      client: deps.judgeClient, prompt: judgePrompt,
      maxTokens: deps.judgeMaxTokens, hooks: deps.hooks, retry: deps.retry, meta
    });
  } catch (err) {
    return failed('judge', err, answer.text);
  }
  Object.assign(fields, {
    judgeCached: judged.cached, judgeInputTokens: judged.inputTokens, judgeOutputTokens: judged.outputTokens, judgeCostUsd: judged.costUsd
  });

  const verdict = parseVerdict(judged.text);
  if (!verdict) {
    fields.answerError = 'judge-unparsed';
    log.warn('judge verdict unparsable', { questionId: question.id, adapter: item.adapter });
    return { fields, reply: answer.text, reason: null };
  }
  Object.assign(fields, { verdict: verdict.verdict }, scoreVerdict(question, verdict.verdict));
  return { fields, reply: answer.text, reason: verdict.reason };
}

// At most `limit` items at once. After the first error no new item starts;
// the ones in flight finish, then the error is thrown.
async function mapPool(items, limit, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure;
}

// The spot-check sample (spec §8 step 4) quotes questions and replies, so it
// lives under private/.
function spotCheckFile(home, runId) {
  return path.join(home.private, 'spot-checks', `${runId}.jsonl`);
}

function writeSpotCheckSample(file, rows, { seed = 1, fraction = SPOT_CHECK_FRACTION } = {}) {
  const key = (r) => `${r.sessionId}\u0000${r.questionId}\u0000${r.adapter}`;
  const judged = rows.filter((r) => r.verdict).sort((a, b) => key(a).localeCompare(key(b)));
  const n = judged.length ? Math.max(1, Math.ceil(judged.length * fraction)) : 0;
  const picked = createRng(seed).shuffle(judged).slice(0, n).sort((a, b) => key(a).localeCompare(key(b)));
  writeFileAtomic(file, (write) => {
    for (const r of picked) write(`${JSON.stringify({ ...r, humanVerdict: null, reviewer: null })}\n`);
  });
  return n;
}

const TIERS = Object.freeze(['grid', 'frontier']);

// Which questions each adapter answers (benchmark spec §8.1). grid: every
// question, every adapter except the frontier-only full-history. frontier:
// a stratified sample (sampling.js sampleQuestions, seeded) of sampleSize.
// In either tier the long-context adapters (full-history, real-compaction)
// get only the first longContextSample of the stratified order, since at
// 90-128K tokens a question they are the cost of a run (measured facts;
// decision D3).
function selectQuestions(sets, adapters, { tier = 'grid', sampleSize = 150, longContextSample = null, seed = 1 } = {}) {
  if (!TIERS.includes(tier)) throw new UsageError(`--tier must be grid or frontier, got ${JSON.stringify(tier)}`);
  if (tier === 'grid') {
    const frontierOnly = adapters.filter((a) => a.frontierOnly).map((a) => a.name);
    if (frontierOnly.length) throw new UsageError(`${frontierOnly.join(', ')} runs only in the frontier tier (benchmark spec section 8.1); pass --tier frontier.`);
  }
  if (longContextSample !== null && !(Number.isInteger(longContextSample) && longContextSample > 0)) {
    throw new UsageError('--long-context-sample must be a positive whole number');
  }
  const items = sets.flatMap((set) => set.questions.map((q) => ({ question: q, bucket: bucketFor(computeDistance(set.session.index, q)) })));
  const ordered = sampleQuestions(items, { size: Math.max(1, tier === 'frontier' ? sampleSize : items.length), seed });
  const keyOf = (q) => `${q.sessionId}\u0000${q.id}`;
  const chosen = new Set(ordered.map((it) => keyOf(it.question)));
  const long = new Set(ordered.slice(0, longContextSample ?? ordered.length).map((it) => keyOf(it.question)));
  return {
    perSet: sets.map((set) => ({
      set,
      questions: set.questions.filter((q) => chosen.has(keyOf(q))),
      longQuestions: set.questions.filter((q) => long.has(keyOf(q)))
    })),
    sample: {
      tier, requested: tier === 'frontier' ? sampleSize : null, questions: chosen.size, longContextQuestions: long.size, seed,
      idsSha256: sha256Text([...chosen].sort().join('\n'))
    }
  };
}

// The calls a run would make now, for the estimate: an answer per item whose
// reply is not cached, and a judgment per item whose verdict is not cached,
// its reply counted at answerMaxTokens when not written yet. Adapters that
// need a model for their context (deferred) add their summaries, and an
// answer and a judgment per question with the context at the adapter's
// estimate.
function planCalls({ items, deferred, answer: a }) {
  const calls = [];
  const counts = { answers: 0, answersCached: 0, judgments: 0, judgmentsCached: 0, summaries: 0, summariesCached: 0 };
  const model = (c) => ({ provider: c.provider, model: c.model, local: Boolean(c.local) });
  const answerChars = (contextChars, q) => a.prompts.answer.text.length + contextChars + q.question.length;
  const judgeChars = (q) => buildJudgePrompt(a.prompts.judge.text, { question: q, reply: '' }).length;
  const pushAnswer = (adapter, q, contextChars) => {
    calls.push({ role: 'answer', adapter, ...model(a.answerClient), inputChars: answerChars(contextChars, q), maxTokens: a.answerMaxTokens });
    counts.answers += 1;
  };
  const pushJudge = (adapter, q, reply) => {
    calls.push({
      role: 'judge', adapter, ...model(a.judgeClient),
      inputChars: judgeChars(q) + (reply === null ? 0 : reply.length), extraInputTokens: reply === null ? a.answerMaxTokens : 0, maxTokens: a.judgeMaxTokens
    });
    counts.judgments += 1;
  };
  for (const it of items) {
    if (it.record.error) continue;
    const aKey = answerKey({
      adapterConfigSha256: it.adapterConfigSha256, question: it.q, contextSha256: it.contextSha256,
      client: a.answerClient, promptSha256: a.prompts.answer.sha256, maxTokens: a.answerMaxTokens
    });
    const hit = a.cache.get('answer', aKey);
    if (hit) counts.answersCached += 1;
    else pushAnswer(it.adapter.name, it.q, it.contextChars);
    const judged = hit && a.cache.get('judge', judgeKey({
      answerCacheKey: aKey, prompt: buildJudgePrompt(a.prompts.judge.text, { question: it.q, reply: hit.text }), client: a.judgeClient, maxTokens: a.judgeMaxTokens
    }));
    if (judged) counts.judgmentsCached += 1;
    else pushJudge(it.adapter.name, it.q, hit ? hit.text : null);
  }
  for (const d of deferred) {
    for (const c of d.estimate.calls) calls.push({ role: 'summary', adapter: d.adapter.name, ...c });
    counts.summaries += d.estimate.calls.length;
    counts.summariesCached += d.estimate.cached;
    for (const q of d.qs) {
      pushAnswer(d.adapter.name, q, d.estimate.contextChars);
      pushJudge(d.adapter.name, q, null);
    }
  }
  return { calls, counts };
}

module.exports = {
  SPOT_CHECK_FRACTION, EMPTY_ANSWER_FIELDS, questionSha256, answerKey, judgeKey,
  answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample, TIERS, selectQuestions, planCalls
};
