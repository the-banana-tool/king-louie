'use strict';
// `longhaul run`: evidence recall per adapter (stage B0) and, with an answer
// and a judge model, answer accuracy (stage B3). Output is ASCII.
const path = require('path');
const { runBenchmark } = require('../run');
const { UsageError } = require('../errors');
const { validateSessionId } = require('../session-format');
const { createModelClient } = require('../model');
const { createFakeModels } = require('../fake-models');
const { ModelCache } = require('../model-cache');
const { loadPrompt } = require('../prompts');
const { formatEstimate, DEFAULT_MAX_USD } = require('../cost');
const { FULL_HISTORY_TOKENS } = require('../adapters/full-history');
const { spendEstimatedNote } = require('../scoring');
const { fixed, usd } = require('../format');

const USAGE = [
  'Usage: longhaul run --adapters kl-recall,sliding-window,oracle [--sessions <data root>] [--session <id>]...',
  '  [--budget-tokens 6000] [--window-tokens N] [--recall key=value]... [--chunk-target-chars N] [--seed N] [--include-unverified]',
  '  [--embed-model text-embedding-3-small] [--embed-provider openai|local] [--send-private]',
  '  --embed-provider: the embedder for kl-recall-vec: openai (default) or local (H3)',
  '  [--jev-mode batched|pointwise] [--jev-model jev-1.13.0] [--jev-max-tokens 20000000] [--jev-base-url <url>]',
  '  --jev-*: kl-recall-jev-rerank and kl-recall-vec-jev-rerank (key TYPESAFE_AI_KEY; unpriced, input tokens reported)',
  'Answer stage: --answer-provider <p> --answer-model <m> [--answer-base-url <url>] --judge-provider <p> --judge-model <m> [--judge-base-url <url>]',
  '  [--summarizer-provider <p> --summarizer-model <m> [--summarizer-base-url <url>]] [--tier grid|frontier] [--sample 150]',
  '  [--long-context-sample N] [--max-usd 50] [--allow-unpriced] [--dry-run] [--concurrency 4] [--answer-max-tokens 400]',
  '  [--judge-max-tokens 200] [--full-history-tokens 128000] [--compact-every-tokens 10000] [--fake-models]'
].join('\n');

// Options that mean nothing without the answer stage.
const ANSWER_ONLY = Object.freeze([
  'tier', 'sample', 'long-context-sample', 'max-usd', 'allow-unpriced', 'dry-run', 'concurrency',
  'answer-max-tokens', 'judge-max-tokens', 'compact-every-tokens', 'summarizer-provider', 'summarizer-model', 'summarizer-base-url'
]);

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive whole number, got ${JSON.stringify(value)}`);
  return n;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number, got ${JSON.stringify(value)}`);
  return n;
}

// --recall key=value; the value is parsed as JSON when it can be (numbers,
// booleans, objects), else kept as a string.
function parseRecallPairs(pairs = []) {
  const out = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--recall takes key=value, got ${JSON.stringify(pair)}`);
    const raw = pair.slice(eq + 1);
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    out[pair.slice(0, eq)] = value;
  }
  return out;
}

// The model client for one role (answer, judge, summarizer), or null when
// the role's model is not named. The key comes from the environment.
function clientFor(ctx, values, role, deps) {
  const provider = values[`${role}-provider`];
  const model = values[`${role}-model`];
  if (!provider && !model) return null;
  if (!provider || !model) throw new UsageError(`--${role}-provider and --${role}-model go together.`);
  const baseUrl = values[`${role}-base-url`];
  const client = createModelClient({
    provider, model, env: ctx.env, options: baseUrl ? { baseUrl } : {}, providerInstance: deps.providerInstances?.[role] || null
  });
  // The cache keys include baseUrl (answer-stage.js, summarize-compact.js),
  // so a self-hosted endpoint serving a model under the provider's own name
  // never reuses the provider's cached replies, or the other way round.
  return baseUrl ? { ...client, baseUrl } : client;
}

const num = (x) => (x === null || x === undefined ? '-' : String(Math.round(x)));
const ac = (x) => fixed(x, 3, '-');

function exitCodeFor(result, stderr) {
  if (result.leaks > 0) {
    stderr.write(`LEAK: ${result.leaks} shown messages were at or after askAtSeq; see the "leaked" field in ${path.join(result.dir, 'records.jsonl')}\n`);
    return 1;
  }
  if (result.spend?.overBudget) {
    stderr.write(`STOPPED AT THE CAP ($${result.config.answer.maxUsd}): the remaining questions are recorded as over-budget errors. `
      + 'Run again to finish; cached calls cost nothing.\n');
    return 1;
  }
  return 0;
}

module.exports = {
  options: {
    sessions: { type: 'string' },
    session: { type: 'string', multiple: true },
    adapters: { type: 'string' },
    'budget-tokens': { type: 'string' },
    'window-tokens': { type: 'string' },
    'chunk-target-chars': { type: 'string' },
    recall: { type: 'string', multiple: true },
    seed: { type: 'string' },
    'include-unverified': { type: 'boolean', default: false },
    'embed-model': { type: 'string' },
    'embed-provider': { type: 'string' },
    'send-private': { type: 'boolean', default: false },
    'jev-mode': { type: 'string' },
    'jev-model': { type: 'string' },
    'jev-max-tokens': { type: 'string' },
    'jev-base-url': { type: 'string' },
    'answer-provider': { type: 'string' },
    'answer-model': { type: 'string' },
    'answer-base-url': { type: 'string' },
    'judge-provider': { type: 'string' },
    'judge-model': { type: 'string' },
    'judge-base-url': { type: 'string' },
    'summarizer-provider': { type: 'string' },
    'summarizer-model': { type: 'string' },
    'summarizer-base-url': { type: 'string' },
    tier: { type: 'string' },
    sample: { type: 'string' },
    'long-context-sample': { type: 'string' },
    'max-usd': { type: 'string' },
    'allow-unpriced': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    concurrency: { type: 'string' },
    'answer-max-tokens': { type: 'string' },
    'judge-max-tokens': { type: 'string' },
    'full-history-tokens': { type: 'string' },
    'compact-every-tokens': { type: 'string' },
    'fake-models': { type: 'boolean' }
  },
  exitCodeFor,
  positiveInt,
  // deps (tests only): providerInstances { answer, judge, summarizer }, catalog, retry.
  async run(ctx, values, _positionals, deps = {}) {
    if (!values.adapters) throw new UsageError(USAGE);
    for (const id of values.session || []) validateSessionId(id);
    const adapterNames = values.adapters.split(',').map((s) => s.trim()).filter(Boolean);
    const recall = parseRecallPairs(values.recall);
    // kl-recall's store chunk size (history.chunk.targetChars).
    const chunk = values['chunk-target-chars'] ? { targetChars: positiveInt(values['chunk-target-chars'], 'chunk-target-chars') } : null;

    const named = ['answer', 'judge', 'summarizer'].some((r) => values[`${r}-provider`] || values[`${r}-model`]);
    if (values['fake-models'] && named) throw new UsageError('--fake-models replaces the answer, judge and summarizer models; name no model with it.');
    const models = values['fake-models'] ? createFakeModels() : {
      answer: clientFor(ctx, values, 'answer', deps),
      judge: clientFor(ctx, values, 'judge', deps),
      summarizer: clientFor(ctx, values, 'summarizer', deps)
    };
    const answering = Boolean(models.answer || models.judge);
    if (!answering) {
      const stray = ANSWER_ONLY.find((k) => values[k] !== undefined && values[k] !== false);
      if (stray) throw new UsageError(`--${stray} applies only to the answer stage: name --answer-model and --judge-model, or pass --fake-models.`);
    } else if (!models.answer || !models.judge) {
      throw new UsageError('The answer stage needs both an answer model (--answer-provider, --answer-model) and a judge model (--judge-provider, --judge-model).');
    }

    const cache = ModelCache.forHome(ctx.home);
    const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
    const summarizer = models.summarizer || models.answer;
    const windowTokens = values['full-history-tokens'] ? positiveInt(values['full-history-tokens'], 'full-history-tokens') : FULL_HISTORY_TOKENS;
    // kl-recall-vec(-only): vectors from `longhaul embed`'s cache; a question
    // with no cached vector is embedded now only with --send-private.
    // --embed-provider picks the embedder (openai by default; local is the
    // app's own, H3). kl-recall-vec already takes `provider`.
    const vec = {
      recall, privateRoot: ctx.home.private, env: ctx.env, sendPrivate: values['send-private'],
      provider: values['embed-provider'] || 'openai',
      ...(values['embed-model'] ? { model: values['embed-model'] } : {})
    };
    // kl-recall(-vec)-jev-rerank: typesafe.ai's Jev as the reranker, the key
    // TYPESAFE_AI_KEY from the environment, a private session only with
    // --send-private. In the answer stage (and its dry run) it is
    // cache-only: a score not cached refuses the run (JEV_SCORES_MISSING)
    // instead of calling Jev outside the priced plan.
    const jev = {
      sendPrivate: values['send-private'] === true, env: ctx.env, cachedOnly: answering,
      ...(values['jev-mode'] ? { jevMode: values['jev-mode'] } : {}),
      ...(values['jev-model'] ? { jevModel: values['jev-model'] } : {}),
      ...(values['jev-max-tokens'] ? { maxTokens: positiveInt(values['jev-max-tokens'], 'jev-max-tokens') } : {}),
      ...(values['jev-base-url'] ? { jevBaseUrl: values['jev-base-url'] } : {})
    };
    const adapterConfig = {
      'kl-recall': { recall, ...(chunk ? { chunk } : {}) },
      'kl-recall-whole': { recall, ...(chunk ? { chunk } : {}) },
      'kl-recall-vec': vec,
      'kl-recall-vec-only': vec,
      // kl-recall-rerank: cross-encoder scores cached under LONGHAUL_HOME/private/rerank.
      'kl-recall-rerank': { recall, privateRoot: ctx.home.private },
      'kl-recall-vec-rerank': vec,
      'kl-recall-jev-rerank': { recall, privateRoot: ctx.home.private, ...jev },
      'kl-recall-vec-jev-rerank': { ...vec, ...jev },
      'sliding-window': values['window-tokens'] ? { windowTokens: positiveInt(values['window-tokens'], 'window-tokens') } : {},
      'full-history': { windowTokens },
      'real-compaction': { windowTokens },
      'summarize-compact': {
        ...(values['compact-every-tokens'] ? { compactEveryTokens: positiveInt(values['compact-every-tokens'], 'compact-every-tokens') } : {}),
        summarizer: summarizer ? { client: summarizer, cache, prompt: prompts.summarize, retry: deps.retry || {} } : null
      }
    };

    const answer = answering ? {
      answerClient: models.answer,
      judgeClient: models.judge,
      prompts,
      cache,
      catalog: deps.catalog || null,
      answerMaxTokens: values['answer-max-tokens'] ? positiveInt(values['answer-max-tokens'], 'answer-max-tokens') : 400,
      judgeMaxTokens: values['judge-max-tokens'] ? positiveInt(values['judge-max-tokens'], 'judge-max-tokens') : 200,
      tier: values.tier || 'grid',
      sampleSize: values.sample ? positiveInt(values.sample, 'sample') : 150,
      longContextSample: values['long-context-sample'] ? positiveInt(values['long-context-sample'], 'long-context-sample') : null,
      maxUsd: values['max-usd'] !== undefined ? positiveNumber(values['max-usd'], 'max-usd') : DEFAULT_MAX_USD,
      allowUnpriced: values['allow-unpriced'] === true,
      sendPrivate: values['send-private'] === true,
      dryRun: values['dry-run'] === true,
      concurrency: values.concurrency ? positiveInt(values.concurrency, 'concurrency') : 4,
      retry: deps.retry || {},
      onPlan: ({ estimate, counts, maxUsd }) => ctx.stdout.write(formatEstimate(estimate, { counts, maxUsd })),
      onSendPrivate: ({ sessions, to }) => ctx.stderr.write(`note: context, questions and reference answers of private session(s) ${sessions.join(', ')} `
        + `are sent to ${to.join(', ')} (--send-private).\n`)
    } : null;

    const result = await runBenchmark({
      home: ctx.home,
      dataRoot: values.sessions ? path.resolve(ctx.cwd, values.sessions) : ctx.home.root,
      sessionIds: values.session || null,
      adapterNames,
      adapterConfig,
      budgetTokens: values['budget-tokens'] ? positiveInt(values['budget-tokens'], 'budget-tokens') : 6000,
      seed: values.seed ? positiveInt(values.seed, 'seed') : 1,
      includeUnverified: values['include-unverified'],
      now: ctx.now,
      answer
    });
    if (result.staleTmpRemoved) ctx.stdout.write(`removed ${result.staleTmpRemoved} temp dirs left in ${ctx.home.tmp} by an interrupted run\n`);
    if (result.dryRun) {
      ctx.stdout.write('dry run: no model was called and no run was written.\n');
      return 0;
    }
    ctx.stdout.write(`run ${result.runId} -> ${result.dir}\n`);
    if (result.config.includeUnverified) ctx.stdout.write('UNVERIFIED QUESTIONS INCLUDED: a smoke run, not a result.\n');
    // The name column fits the longest adapter name (summarize-compact, kl-recall-vec-rerank).
    const nameWidth = Math.max(16, ...Object.keys(result.summary).map((n) => n.length));
    for (const [name, s] of Object.entries(result.summary)) {
      const er = s.evidenceRecall === null ? '-' : s.evidenceRecall.toFixed(3);
      ctx.stdout.write(`${name.padEnd(nameWidth)} evidence recall ${er} (n=${s.scored})  answer contained ${ac(s.answerContainment)} (tokens ${ac(s.answerTokenContainment)})  partial ${s.partial}  median ${num(s.estTokens.median)} tokens  p90 ${num(s.estTokens.p90)}  errors ${s.errors}  leaks ${s.leaks}\n`);
      if (s.answer) {
        ctx.stdout.write(`${''.padEnd(nameWidth)} answer accuracy ${ac(s.answer.accuracy)} (n=${s.answer.n})  partial ${ac(s.answer.partialRate)}  declined ${ac(s.answer.declinedRate)}  `
          + `abstain accuracy ${ac(s.answer.abstain.accuracy)} (n=${s.answer.abstain.n})  answer errors ${s.answer.errors}\n`);
      }
    }
    // The Jev adapters' own counts (adapter-stats.json): tokens, unpriced.
    for (const [name, st] of Object.entries(result.adapterStats || {})) {
      const j = st.jev;
      const s = Number.isFinite(st.uncachedMsMedian) ? (st.uncachedMsMedian / 1000).toFixed(2) : '-';
      ctx.stdout.write(`${name.padEnd(nameWidth)} ${st.mode} topM ${st.topM}  pairs ${st.rerank?.pairs ?? 0} (cached ${st.rerank?.hits ?? 0})  `
        + `uncached s/question median ${s}  score errors ${st.scoreErrors}`
        + (j ? `  requests ${j.requests} retries ${j.retries} input tokens ${j.inputTokens} (price unknown) status ${JSON.stringify(j.status)}` : '  no request sent')
        + '\n');
    }
    for (const c of result.comparisons || []) {
      if (!c.result.judged) continue;
      ctx.stdout.write(`${c.id}: ${c.a} ${ac(c.result.accuracy.a)} vs ${c.b} ${ac(c.result.accuracy.b)} over ${c.result.judged} questions `
        + `(right in one only: ${c.result.onlyA} vs ${c.result.onlyB}); one question is ${(1 / c.result.judged).toFixed(3)}, `
        + `a difference under ${(2 / c.result.judged).toFixed(3)} is noise\n`);
    }
    if (result.spend) {
      const est = usd(result.spend.estimateUsd, 'unknown');
      ctx.stdout.write(`spent ${usd(result.spend.spentUsd)} on ${result.spend.calls} calls (${result.spend.unpricedCalls} unpriced${spendEstimatedNote(result.spend)}); estimate ${est}\n`);
    }
    if (result.spotChecks?.n) {
      ctx.stdout.write(`spot-check sample: ${result.spotChecks.n} judgments; review them with longhaul spot-check --run ${result.runId} --reviewer <initials>\n`);
    }
    ctx.stdout.write(`summary: ${path.join(result.dir, 'summary.md')}\n`);
    return exitCodeFor(result, ctx.stderr);
  }
};
