'use strict';
// `longhaul run` (benchmark spec §8, §8.1, §11, §15). Without an answer model
// it is stage B0: each adapter's context at each question's askAtSeq, scored
// by evidence recall and answer containment, no model call. With an answer
// and a judge model (stage B3), pass 1 builds every context locally and
// keeps its text in LONGHAUL_HOME/tmp/kl-ctx-<runId>/; the plan of model
// calls is priced from the catalog and checked against the cap before any
// call; pass 2 makes the summarizer, answer and judge calls through the model
// cache (LONGHAUL_HOME/private/model-cache), so a run cut off mid-way resumes
// for nothing. Records hold ids, seqs, verdicts and numbers only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadSession, listSessions, sessionDir, CHARS_PER_TOKEN } = require('./session-format');
const { readQuestions, questionsFile, validateQuestionSet, isVerified, bucketFor, computeDistance } = require('./questions');
const { createAdapter } = require('./adapters');
const {
  evidenceRecall, chunkEvidenceRecall, answerContainment, summarize, renderSummaryMarkdown, compareAdapters, COMPARISONS
} = require('./scoring');
const { writeFileAtomic, sha256File, sha256Text } = require('./files');
const { ModelCache, stableStringify } = require('./model-cache');
const { selectQuestions, planCalls, answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample } = require('./answer-stage');
const { estimateCalls, checkBudget, SpendGuard, DEFAULT_MAX_USD, EST_CHARS_PER_TOKEN } = require('./cost');
const { JUDGE_RULES_SHA256 } = require('./judge');
const { isAuthFailure, retryable } = require('./retry');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/run');
// kl-recall's temp store prefix (adapters/kl-recall.js TMP_PREFIX), kept
// here so a run without kl-recall does not load node:sqlite. `embed`'s temp
// dir (kl-embed-<pid>) and the answer stage's context dir (kl-ctx-<runId>)
// share it, so this covers all three.
const KL_TMP_PREFIX = 'kl-';
const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
// The answer prompt's own text and the question, in tokens, on top of the
// context (answer-v1.md is about 150 words; a question is one line).
const ANSWER_PROMPT_OVERHEAD_TOKENS = 1000;

// Temp dirs an interrupted run or embed (Ctrl-C, crash) left behind.
// prefix narrows it (embed removes only kl-embed-* dirs).
function removeStaleTmp(tmpDir, prefix = KL_TMP_PREFIX) {
  if (!tmpDir || !fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    fs.rmSync(path.join(tmpDir, e.name), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) log.info('removed temp dirs left by an interrupted run', { removed });
  return removed;
}

function gitCommit(cwd = path.join(__dirname, '..', '..')) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = git(['rev-parse', 'HEAD']);
    return git(['status', '--porcelain', '--untracked-files=no']) ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

function newRunId(date) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

async function loadRunSet({ dataRoot, sessionIds, includeUnverified }) {
  const ids = sessionIds && sessionIds.length ? sessionIds : listSessions(dataRoot);
  if (!ids.length) throw new UsageError(`No sessions under ${path.join(dataRoot, 'sessions')}.`);
  const sets = [];
  const skipped = [];
  for (const id of ids) {
    const dir = sessionDir(dataRoot, id);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${id}" under ${path.join(dataRoot, 'sessions')}.`);
    const qFile = questionsFile(dataRoot, id);
    if (!fs.existsSync(qFile)) { skipped.push({ sessionId: id, reason: 'no questions file' }); continue; }
    const session = await loadSession(dir);
    const all = await readQuestions(qFile);
    const problems = validateQuestionSet(all, { index: session.index, sessionId: id });
    if (problems.length) {
      const [p] = problems;
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more questions)` : '';
      throw new UsageError(`The question set for ${id} fails validation; fix it with longhaul verify. ${p.id}: ${p.errors[0]}${more}`);
    }
    const questions = all
      .filter((q) => includeUnverified || isVerified(q))
      .sort((a, b) => a.askAtSeq - b.askAtSeq || a.id.localeCompare(b.id));
    sets.push({ session, questions, verified: all.filter(isVerified).length, questionsSha256: await sha256File(qFile) });
  }
  if (sets.reduce((n, s) => n + s.questions.length, 0) === 0) {
    throw new UsageError(includeUnverified ? 'No questions to run.' : 'No verified questions to run (a smoke run can pass --include-unverified).');
  }
  return { sets, skipped };
}

// Adapters that do not apply to a session (real-compaction on a session with
// no recorded compactions) are skipped there and listed in config.json.
function adapterSkips(adapters, sets) {
  const out = [];
  for (const { session } of sets) {
    for (const a of adapters) {
      if (typeof a.appliesTo === 'function' && !a.appliesTo(session)) {
        out.push({ adapter: a.name, sessionId: session.manifest.sessionId, reason: a.skipReason || 'does not apply' });
      }
    }
  }
  return out;
}

const isSkipped = (skips, adapter, session) => skips.some((s) => s.adapter === adapter.name && s.sessionId === session.manifest.sessionId);

// One question's context from one adapter, scored without a model: the record
// (ids and numbers) and, apart, the context text, which never enters a record.
async function scoreOne({ runId, adapter, handle, session, q, budgetTokens }) {
  const base = {
    runId, sessionId: q.sessionId, questionId: q.id, adapter: adapter.name, kind: q.kind,
    bucket: bucketFor(computeDistance(session.index, q)), askAtSeq: q.askAtSeq, evidenceSeqs: q.evidenceSeqs, verified: isVerified(q)
  };
  try {
    const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens });
    // Evidence recall counts only messages shown whole; partly shown
    // evidence is reported apart. The leak check covers both.
    const shown = r.evidenceSeqsShown || [];
    const whole = new Set(shown);
    const partial = (r.evidenceSeqsPartial || []).filter((s) => !whole.has(s));
    const partialSet = new Set(partial);
    // Secondary metric: the answer text in the context. Booleans only; the
    // record never carries the text. null for abstain.
    const contained = answerContainment(r.text, q);
    const record = {
      ...base,
      evidenceSeqsShown: shown,
      evidenceSeqsPartial: partial,
      evidenceRecall: evidenceRecall(q.evidenceSeqs, shown),
      evidencePartial: q.evidenceSeqs.filter((s) => partialSet.has(s)).length,
      answerContained: contained ? contained.strict : null,
      answerTokensContained: contained ? contained.tokens : null,
      chunkEvidenceRecall: chunkEvidenceRecall(q.evidenceSeqs, r.chunks),
      estTokens: r.estTokens, latencyMs: r.latencyMs, cpuMs: r.cpuMs, cost: r.cost ?? 0,
      // null for an adapter that never reports cutting (kl-recall, oracle):
      // "not known", not "not cut".
      contextTruncated: typeof r.truncated === 'boolean' ? r.truncated : null,
      leaked: [...shown, ...partial].filter((s) => s >= q.askAtSeq).length,
      error: null
    };
    return { record, text: String(r.text ?? '') };
  } catch (err) {
    const record = {
      ...base, evidenceSeqsShown: [], evidenceSeqsPartial: [], evidenceRecall: null, evidencePartial: 0, chunkEvidenceRecall: null,
      answerContained: null, answerTokensContained: null,
      estTokens: null, latencyMs: null, cpuMs: null, cost: 0, contextTruncated: null, leaked: 0, error: err.message
    };
    return { record, text: null };
  }
}

function baseConfig(run, runId) {
  return {
    runId,
    createdAt: run.now().toISOString(),
    benchmark: 'LongHaul',
    stage: 'B0',
    metric: 'evidence recall',
    secondaryMetrics: ['answer containment'],
    commit: run.commit,
    node: process.version,
    budgetTokens: run.budgetTokens,
    seed: run.seed,
    includeUnverified: run.includeUnverified,
    dataRoot: path.resolve(run.dataRoot) === path.resolve(run.home.root) ? '$LONGHAUL_HOME' : path.basename(run.dataRoot),
    adapters: run.adapters.map((a) => a.describe()),
    sessions: run.sets.map(({ session, questions, verified, questionsSha256 }) => ({
      sessionId: session.manifest.sessionId, source: session.manifest.source, private: session.manifest.private,
      license: session.manifest.license, questions: questions.length, verifiedQuestions: verified, questionsSha256
    })),
    skippedSessions: run.skipped,
    skippedAdapters: run.skippedAdapters
  };
}

const comparisonsOf = (records) => COMPARISONS.map((c) => ({ ...c, result: compareAdapters(records, c.a, c.b) })).filter((c) => c.result);

function finish({ run, runId, dir, config, records, spend = null, setupCosts = [] }) {
  const summary = summarize(records, { setupCosts });
  const comparisons = comparisonsOf(records);
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (spend) writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), renderSummaryMarkdown(config, summary, { spend, comparisons }));
  const leaks = Object.values(summary).reduce((n, s) => n + s.leaks, 0);
  return { runId, dir, config, summary, records, comparisons, leaks, spend, staleTmpRemoved: run.staleTmpRemoved };
}

async function runBenchmark({
  home, dataRoot = home.root, sessionIds = null, adapterNames = [], adapterConfig = {}, adapters: injected = null,
  budgetTokens = 6000, seed = 1, includeUnverified = false, now = () => new Date(), commit = gitCommit(), answer = null
}) {
  const staleTmpRemoved = removeStaleTmp(home.tmp);
  const adapters = injected || adapterNames.map((name) => createAdapter(name, { budgetTokens, tmpRoot: home.tmp, ...(adapterConfig[name] || {}) }));
  if (!adapters.length) throw new UsageError('Name at least one adapter with --adapters.');
  if (!answer) {
    const needModel = adapters.filter((a) => a.usesModel).map((a) => a.name);
    if (needModel.length) {
      throw new UsageError(`${needModel.join(', ')} calls a summarizer model, so it runs only in the answer stage (--answer-model and --judge-model, or --fake-models).`);
    }
  }
  const { sets, skipped } = await loadRunSet({ dataRoot, sessionIds, includeUnverified });
  const run = {
    home, dataRoot, adapters, sets, skipped, skippedAdapters: adapterSkips(adapters, sets),
    budgetTokens, seed, includeUnverified, now, commit, staleTmpRemoved
  };
  return answer ? runAnswerStage(run, answer) : runEvidenceOnly(run);
}

async function runEvidenceOnly(run) {
  const { home, adapters, sets, budgetTokens, now } = run;
  const runId = newRunId(now());
  const dir = path.join(home.runs, runId);
  fs.mkdirSync(dir, { recursive: true });
  const config = baseConfig(run, runId);
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, '');
  const records = [];
  for (const { session, questions } of sets) {
    if (!questions.length) continue;
    const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
    for (const adapter of adapters) {
      if (isSkipped(run.skippedAdapters, adapter, session)) continue;
      const handle = await adapter.prepare(session, { upToSeq });
      try {
        for (const q of questions) {
          const { record } = await scoreOne({ runId, adapter, handle, session, q, budgetTokens });
          records.push(record);
          fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  }
  return finish({ run, runId, dir, config, records });
}

// A model call carrying a private session's text needs --send-private: the
// answer call (context), the judge call (question and references) and the
// summarizer (its window). Checked before any client is used; a dry run
// makes no call and needs no flag. Local fakes send nothing anywhere.
function assertMaySend(run, a) {
  const privateIds = run.sets.filter((s) => s.session.manifest.private).map((s) => s.session.manifest.sessionId);
  const remote = [a.answerClient, a.judgeClient, ...run.adapters.map((x) => x.modelClient).filter(Boolean)].filter((c) => !c.local);
  if (!privateIds.length || !remote.length || a.dryRun) return;
  const to = [...new Set(remote.map((c) => `${c.provider}/${c.model}`))].sort();
  if (!a.sendPrivate) {
    const one = privateIds.length === 1;
    throw new UsageError(`Session${one ? '' : 's'} ${privateIds.join(', ')} ${one ? 'is' : 'are'} private: the answer stage sends context from `
      + `${one ? 'it' : 'them'}, the questions and their reference answers to ${to.join(', ')}. Pass --send-private to allow that.`, 'PRIVATE_SESSION');
  }
  a.onSendPrivate({ sessions: privateIds, to });
}

// kl-recall-vec* embeds a question it has no cached vector for, a paid call
// the plan does not price. In the answer stage (and its dry run) that call
// would sit outside the estimate and the spend guard, so an uncached
// question vector refuses the run before any client is used; `longhaul
// embed` caches every question of the session. Evidence-only runs still
// embed on the fly.
function assertQuestionVectors(run, selection) {
  for (const { set, questions, longQuestions } of selection.perSet) {
    const { session } = set;
    for (const adapter of run.adapters) {
      if (typeof adapter.missingQuestionVectors !== 'function' || isSkipped(run.skippedAdapters, adapter, session)) continue;
      const missing = adapter.missingQuestionVectors(session, adapter.longContext ? longQuestions : questions);
      if (!missing.length) continue;
      const sessionId = session.manifest.sessionId;
      const embedder = String(adapter.describe().embedder || '');
      const slash = embedder.indexOf('/');
      const how = slash > 0 ? ` --provider ${embedder.slice(0, slash)} --model ${embedder.slice(slash + 1)}` : '';
      throw new UsageError(`${adapter.name}: ${missing.length} question${missing.length === 1 ? '' : 's'} of session ${sessionId} `
        + `${missing.length === 1 ? 'has' : 'have'} no cached vector, and the answer stage makes no embedding call outside its estimate; nothing was sent. `
        + `Run longhaul embed --session ${sessionId}${how} first (add --send-private for a private session).`, 'EMBEDDINGS_MISSING');
    }
  }
}

// The most estimated context tokens (characters / 4) the answer model's
// window holds (benchmark spec §7: full-history is what "fits the model's
// window"): the catalog's context, less the reply (answerMaxTokens) and the
// prompt's own text, converted at 3 characters a real token so that dense
// text at the cap still fits. null when the catalog does not know the window
// (a local fake, an unknown model); the adapters then keep their own 128K.
function contextCapTokens({ answerClient, answerMaxTokens, catalog }) {
  if (answerClient.local || !catalog || typeof catalog.get !== 'function') return null;
  const window = catalog.get(answerClient.provider, answerClient.model)?.limits?.context;
  if (!Number.isFinite(window) || window <= 0) return null;
  return Math.max(0, Math.floor(((window - answerMaxTokens - ANSWER_PROMPT_OVERHEAD_TOKENS) * EST_CHARS_PER_TOKEN) / CHARS_PER_TOKEN));
}

function answerConfig(a, adapters, selection, estimate, cap) {
  const prompt = (p) => (p ? { file: p.file, sha256: p.sha256 } : null);
  return {
    tier: a.tier,
    sample: selection.sample,
    answerModel: { provider: a.answerClient.provider, model: a.answerClient.model, maxTokens: a.answerMaxTokens },
    judgeModel: { provider: a.judgeClient.provider, model: a.judgeClient.model, maxTokens: a.judgeMaxTokens },
    prompts: {
      answer: prompt(a.prompts.answer),
      // judge.js splices its kind rules and fixed texts into judge-v1.md;
      // rulesSha256 names them (the judge's cache key covers the rendered prompt).
      judge: { ...prompt(a.prompts.judge), rulesSha256: JUDGE_RULES_SHA256 },
      summarize: adapters.some((x) => x.usesModel) ? prompt(a.prompts.summarize) : null
    },
    contextCapTokens: cap,
    maxUsd: a.maxUsd,
    allowUnpriced: a.allowUnpriced,
    sendPrivate: a.sendPrivate,
    concurrency: a.concurrency,
    estimateUsd: estimate.totalUsd,
    estimateKnownUsd: estimate.knownUsd,
    tokens: 'context tokens are estimated (characters / 4); answer and judge tokens come from provider usage'
  };
}

function recordOrder(adapters) {
  const rank = new Map(adapters.map((a, i) => [a.name, i]));
  return (x, y) => x.sessionId.localeCompare(y.sessionId) || rank.get(x.adapter) - rank.get(y.adapter)
    || x.askAtSeq - y.askAtSeq || x.questionId.localeCompare(y.questionId);
}

async function runAnswerStage(run, answer) {
  const { home, now, seed } = run;
  const a = {
    answerMaxTokens: 400, judgeMaxTokens: 200, tier: 'grid', sampleSize: 150, longContextSample: null, maxUsd: DEFAULT_MAX_USD,
    allowUnpriced: false, sendPrivate: false, dryRun: false, concurrency: 4, retry: {}, onPlan: () => {}, onSendPrivate: () => {},
    ...answer
  };
  a.cache = a.cache || ModelCache.forHome(home);
  a.catalog = a.catalog || require('../models').getActiveCatalog();
  if (!a.answerClient || !a.judgeClient || !a.prompts?.answer || !a.prompts?.judge) {
    throw new UsageError('The answer stage needs an answer model and a judge model (--answer-provider/--answer-model, --judge-provider/--judge-model).');
  }
  if (a.answerClient.provider === a.judgeClient.provider && a.answerClient.model === a.judgeClient.model) {
    throw new UsageError(`The judge is never the answer model (benchmark spec section 8); ${a.answerClient.provider}/${a.answerClient.model} is both. Pick another --judge-model.`);
  }
  assertMaySend(run, a);
  // full-history and real-compaction never get more than the answer model
  // holds: an overflow would be a 400 recorded as an error, which would bias
  // long-context accuracy. describe() then shows the capped window, so
  // config.json and the answer cache keys carry it.
  const cap = contextCapTokens(a);
  run.adapters = run.adapters.map((x) => (cap !== null && typeof x.capWindow === 'function' ? x.capWindow(cap) : x));
  const { adapters } = run;
  const selection = selectQuestions(run.sets, adapters, { tier: a.tier, sampleSize: a.sampleSize, longContextSample: a.longContextSample, seed });
  assertQuestionVectors(run, selection);

  const runId = newRunId(now());
  const ctxDir = path.join(home.tmp, `${KL_TMP_PREFIX}ctx-${runId}`);
  fs.mkdirSync(ctxDir, { recursive: true });
  const describeSha = new Map(adapters.map((x) => [x, sha256Text(stableStringify(x.describe()))]));
  const items = [];
  const contextItem = async (adapter, handle, session, q) => {
    const { record, text } = await scoreOne({ runId, adapter, handle, session, q, budgetTokens: run.budgetTokens });
    record.tier = a.tier;
    const item = { adapter, q, record, adapterConfigSha256: describeSha.get(adapter) };
    if (text !== null) {
      item.contextFile = path.join(ctxDir, `${items.length}.txt`);
      fs.writeFileSync(item.contextFile, text);
      item.contextChars = text.length;
      item.contextSha256 = sha256Text(text);
    }
    items.push(item);
  };

  try {
    // Pass 1: every context that needs no model, built here, nothing sent.
    const deferred = [];
    for (const { set, questions, longQuestions } of selection.perSet) {
      const { session } = set;
      for (const adapter of adapters) {
        if (isSkipped(run.skippedAdapters, adapter, session)) continue;
        const qs = adapter.longContext ? longQuestions : questions;
        if (!qs.length) continue;
        const upToSeq = Math.max(...qs.map((q) => q.askAtSeq));
        if (adapter.usesModel) {
          deferred.push({ adapter, session, qs, upToSeq, estimate: adapter.estimate(session, { upToSeq }) });
          continue;
        }
        const handle = await adapter.prepare(session, { upToSeq });
        try {
          for (const q of qs) await contextItem(adapter, handle, session, q);
        } finally {
          await adapter.release(handle);
        }
      }
    }

    // The plan, priced before any call.
    const plan = planCalls({ items, deferred, answer: a });
    const estimate = estimateCalls(plan.calls, a.catalog);
    a.onPlan({ estimate, counts: plan.counts, maxUsd: a.maxUsd });
    if (a.dryRun) return { dryRun: true, estimate, counts: plan.counts, staleTmpRemoved: run.staleTmpRemoved };
    checkBudget(estimate, a);

    const dir = path.join(home.runs, runId);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      ...baseConfig(run, runId), stage: 'B3', metric: 'answer accuracy', secondaryMetrics: ['evidence recall', 'answer containment'],
      answer: answerConfig(a, adapters, selection, estimate, cap)
    };
    writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const recordsPath = path.join(dir, 'records.jsonl');
    fs.writeFileSync(recordsPath, '');
    const guard = new SpendGuard({ maxUsd: a.maxUsd, catalog: a.catalog });
    const hooks = guard.hooks();
    const setupCosts = [];
    let spend = null;
    // spend.json is on disk from here on and rewritten after every item, so
    // a run that stops (a refused key, a crash, Ctrl-C) still says what it
    // paid; stoppedBy names the code that stopped it.
    const writeSpend = (stoppedBy = null) => {
      spend = { estimateUsd: estimate.totalUsd, estimateKnownUsd: estimate.knownUsd, ...guard.totals(), setupCosts, stoppedBy };
      writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
    };
    writeSpend();
    // One adapter's questions in one session, recorded as context errors.
    const recordFailed = async (d, err, code) => {
      for (const q of d.qs) {
        const { record } = await scoreOne({ runId, adapter: { ...d.adapter, context: async () => { throw err; } }, handle: null, session: d.session, q, budgetTokens: run.budgetTokens });
        record.tier = a.tier;
        record.error = code;
        items.push({ adapter: d.adapter, q, record });
      }
    };
    const texts = [];

    try {
      // Pass 2a: adapters whose context needs a model (summarize-compact).
      for (const d of deferred) {
        let handle;
        try {
          handle = await d.adapter.prepare(d.session, { upToSeq: d.upToSeq, hooks });
        } catch (err) {
          // A refused key stops the run, as an answer's does. The cap, or a
          // call that failed after its retries (spec §15: three), is recorded
          // as a context error on this adapter's questions and the run goes
          // on. Anything else is a defect and is thrown.
          if (isAuthFailure(err)) {
            const c = d.adapter.modelClient;
            throw new UsageError(`${c ? c.provider : 'The provider'} refused the API key (${err.status}) for the summarizer; the run stopped. `
              + 'Finished calls are cached, so running again costs only what is left.', 'AUTH');
          }
          if (err.code !== 'OVER_BUDGET' && !Number.isInteger(err.status) && !retryable(err)) throw err;
          const code = err.code === 'OVER_BUDGET' ? 'over-budget' : `summary-failed${Number.isInteger(err.status) ? `:${err.status}` : ''}`;
          log.warn('summarizer failed; its questions are recorded as errors', { adapter: d.adapter.name, sessionId: d.session.manifest.sessionId, code });
          await recordFailed(d, err, code);
          writeSpend();
          continue;
        }
        try {
          setupCosts.push({ adapter: d.adapter.name, sessionId: d.session.manifest.sessionId, ...handle.setup });
          for (const q of d.qs) await contextItem(d.adapter, handle, d.session, q);
        } finally {
          await d.adapter.release(handle);
        }
        writeSpend();
      }

      // Pass 2b: answer and judge every context.
      const deps = {
        cache: a.cache, prompts: a.prompts, answerClient: a.answerClient, judgeClient: a.judgeClient,
        answerMaxTokens: a.answerMaxTokens, judgeMaxTokens: a.judgeMaxTokens, hooks, retry: a.retry
      };
      await mapPool(items.filter((it) => !it.record.error), a.concurrency, async (it) => {
        const out = await answerAndJudge({
          question: it.q, adapter: it.adapter.name, adapterConfigSha256: it.adapterConfigSha256,
          context: fs.readFileSync(it.contextFile, 'utf8'), contextSha256: it.contextSha256
        }, deps);
        Object.assign(it.record, out.fields);
        fs.appendFileSync(recordsPath, `${JSON.stringify(it.record)}\n`);
        writeSpend();
        if (out.fields.verdict) {
          texts.push({
            runId, sessionId: it.q.sessionId, questionId: it.q.id, adapter: it.adapter.name, kind: it.q.kind, question: it.q.question,
            reference: it.q.answer, acceptableAnswers: it.q.acceptableAnswers || [], reply: out.reply, verdict: out.fields.verdict, reason: out.reason
          });
        }
      });
    } catch (err) {
      writeSpend(err.code || 'error');
      throw err;
    }

    const records = items.map((it) => it.record).sort(recordOrder(adapters));
    writeFileAtomic(recordsPath, (write) => { for (const r of records) write(`${JSON.stringify(r)}\n`); });
    writeSpend();
    const file = spotCheckFile(home, runId);
    const n = writeSpotCheckSample(file, texts, { seed });
    const result = finish({ run, runId, dir, config, records, spend, setupCosts });
    return { ...result, spotChecks: { file, n } };
  } finally {
    fs.rmSync(ctxDir, { recursive: true, force: true });
  }
}

module.exports = { runBenchmark, gitCommit, removeStaleTmp, contextCapTokens, KL_TMP_PREFIX, RUN_ID_RE, ANSWER_PROMPT_OVERHEAD_TOKENS };
