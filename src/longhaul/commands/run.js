'use strict';
// `longhaul run`: evidence recall per adapter (stage B0). Output is ASCII.
const path = require('path');
const { runBenchmark } = require('../run');
const { UsageError } = require('../errors');
const { validateSessionId } = require('../session-format');

const USAGE = 'Usage: longhaul run --adapters kl-recall,sliding-window,oracle [--sessions <data root>] [--session <id>]... '
  + '[--budget-tokens 6000] [--window-tokens N] [--recall key=value]... [--chunk-target-chars N] [--seed N] [--include-unverified] '
  + '[--embed-model text-embedding-3-small] [--send-private]';

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive whole number, got ${JSON.stringify(value)}`);
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

const num = (x) => (x === null || x === undefined ? '-' : String(Math.round(x)));

function exitCodeFor(result, stderr) {
  if (result.leaks > 0) {
    stderr.write(`LEAK: ${result.leaks} shown messages were at or after askAtSeq; see the "leaked" field in ${path.join(result.dir, 'records.jsonl')}\n`);
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
    'send-private': { type: 'boolean', default: false }
  },
  exitCodeFor,
  positiveInt,
  async run(ctx, values) {
    if (!values.adapters) throw new UsageError(USAGE);
    for (const id of values.session || []) validateSessionId(id);
    const adapterNames = values.adapters.split(',').map((s) => s.trim()).filter(Boolean);
    const recall = parseRecallPairs(values.recall);
    // kl-recall's store chunk size (history.chunk.targetChars).
    const chunk = values['chunk-target-chars'] ? { targetChars: positiveInt(values['chunk-target-chars'], 'chunk-target-chars') } : null;
    // kl-recall-vec(-only): vectors from `longhaul embed`'s cache; a question
    // with no cached vector is embedded now only with --send-private.
    const vec = {
      recall, privateRoot: ctx.home.private, env: ctx.env, sendPrivate: values['send-private'],
      ...(values['embed-model'] ? { model: values['embed-model'] } : {})
    };
    const adapterConfig = {
      'kl-recall': { recall, ...(chunk ? { chunk } : {}) },
      'kl-recall-vec': vec,
      'kl-recall-vec-only': vec,
      'sliding-window': values['window-tokens'] ? { windowTokens: positiveInt(values['window-tokens'], 'window-tokens') } : {}
    };
    const result = await runBenchmark({
      home: ctx.home,
      dataRoot: values.sessions ? path.resolve(ctx.cwd, values.sessions) : ctx.home.root,
      sessionIds: values.session || null,
      adapterNames,
      adapterConfig,
      budgetTokens: values['budget-tokens'] ? positiveInt(values['budget-tokens'], 'budget-tokens') : 6000,
      seed: values.seed ? positiveInt(values.seed, 'seed') : 1,
      includeUnverified: values['include-unverified'],
      now: ctx.now
    });
    if (result.staleTmpRemoved) ctx.stdout.write(`removed ${result.staleTmpRemoved} temp stores left in ${ctx.home.tmp} by an interrupted run\n`);
    ctx.stdout.write(`run ${result.runId} -> ${result.dir}\n`);
    if (result.config.includeUnverified) ctx.stdout.write('UNVERIFIED QUESTIONS INCLUDED: a smoke run, not a result.\n');
    for (const [name, s] of Object.entries(result.summary)) {
      const er = s.evidenceRecall === null ? '-' : s.evidenceRecall.toFixed(3);
      const ac = (x) => (x === null || x === undefined ? '-' : x.toFixed(3));
      ctx.stdout.write(`${name.padEnd(16)} evidence recall ${er} (n=${s.scored})  answer contained ${ac(s.answerContainment)} (tokens ${ac(s.answerTokenContainment)})  partial ${s.partial}  median ${num(s.estTokens.median)} tokens  p90 ${num(s.estTokens.p90)}  errors ${s.errors}  leaks ${s.leaks}\n`);
    }
    ctx.stdout.write(`summary: ${path.join(result.dir, 'summary.md')}\n`);
    return exitCodeFor(result, ctx.stderr);
  }
};
