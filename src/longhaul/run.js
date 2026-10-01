'use strict';
// `longhaul run` for stage B0 (benchmark spec §8 steps 1, 2 and 5; §11):
// each adapter's context at each question's askAtSeq, scored by evidence
// recall. No answer or judge model. Records hold ids, seqs and numbers only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadSession, listSessions, sessionDir } = require('./session-format');
const { readQuestions, questionsFile, validateQuestionSet, isVerified, bucketFor, computeDistance } = require('./questions');
const { createAdapter } = require('./adapters');
const { evidenceRecall, chunkEvidenceRecall, answerContainment, summarize, renderSummaryMarkdown } = require('./scoring');
const { writeFileAtomic, sha256File } = require('./files');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/run');
// kl-recall's temp store prefix (adapters/kl-recall.js TMP_PREFIX), kept
// here so a run without kl-recall does not load node:sqlite. `embed`'s temp
// dir (commands/embed.js, kl-embed-<pid>) shares it, so this covers both.
const KL_TMP_PREFIX = 'kl-';

// Temp stores an interrupted run or embed (Ctrl-C, crash) left behind.
// prefix narrows it (embed removes only kl-embed-* dirs).
function removeStaleTmp(tmpDir, prefix = KL_TMP_PREFIX) {
  if (!tmpDir || !fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    fs.rmSync(path.join(tmpDir, e.name), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) log.info('removed temp stores left by an interrupted run', { removed });
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
    return {
      ...base,
      evidenceSeqsShown: shown,
      evidenceSeqsPartial: partial,
      evidenceRecall: evidenceRecall(q.evidenceSeqs, shown),
      evidencePartial: q.evidenceSeqs.filter((s) => partialSet.has(s)).length,
      answerContained: contained ? contained.strict : null,
      answerTokensContained: contained ? contained.tokens : null,
      chunkEvidenceRecall: chunkEvidenceRecall(q.evidenceSeqs, r.chunks),
      estTokens: r.estTokens, latencyMs: r.latencyMs, cpuMs: r.cpuMs, cost: r.cost ?? 0,
      contextTruncated: typeof r.truncated === 'boolean' ? r.truncated : null,
      leaked: [...shown, ...partial].filter((s) => s >= q.askAtSeq).length,
      error: null
    };
  } catch (err) {
    return {
      ...base, evidenceSeqsShown: [], evidenceSeqsPartial: [], evidenceRecall: null, evidencePartial: 0, chunkEvidenceRecall: null,
      answerContained: null, answerTokensContained: null,
      estTokens: null, latencyMs: null, cpuMs: null, cost: 0, contextTruncated: null, leaked: 0, error: err.message
    };
  }
}

async function runBenchmark({
  home, dataRoot = home.root, sessionIds = null, adapterNames = [], adapterConfig = {}, adapters: injected = null,
  budgetTokens = 6000, seed = 1, includeUnverified = false, now = () => new Date(), commit = gitCommit()
}) {
  const staleTmpRemoved = removeStaleTmp(home.tmp);
  const adapters = injected || adapterNames.map((name) => createAdapter(name, { budgetTokens, tmpRoot: home.tmp, ...(adapterConfig[name] || {}) }));
  if (!adapters.length) throw new UsageError('Name at least one adapter with --adapters.');
  const { sets, skipped } = await loadRunSet({ dataRoot, sessionIds, includeUnverified });

  const runId = newRunId(now());
  const dir = path.join(home.runs, runId);
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    runId,
    createdAt: now().toISOString(),
    benchmark: 'LongHaul',
    stage: 'B0',
    metric: 'evidence recall',
    secondaryMetrics: ['answer containment'],
    commit,
    node: process.version,
    budgetTokens,
    seed,
    includeUnverified,
    dataRoot: path.resolve(dataRoot) === path.resolve(home.root) ? '$LONGHAUL_HOME' : path.basename(dataRoot),
    adapters: adapters.map((a) => a.describe()),
    sessions: sets.map(({ session, questions, verified, questionsSha256 }) => ({
      sessionId: session.manifest.sessionId, source: session.manifest.source, private: session.manifest.private,
      license: session.manifest.license, questions: questions.length, verifiedQuestions: verified, questionsSha256
    })),
    skippedSessions: skipped
  };
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, '');
  const records = [];
  for (const { session, questions } of sets) {
    if (!questions.length) continue;
    const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
    for (const adapter of adapters) {
      const handle = await adapter.prepare(session, { upToSeq });
      try {
        for (const q of questions) {
          const record = await scoreOne({ runId, adapter, handle, session, q, budgetTokens });
          records.push(record);
          fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  }

  const summary = summarize(records);
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), renderSummaryMarkdown(config, summary));
  const leaks = Object.values(summary).reduce((n, s) => n + s.leaks, 0);
  return { runId, dir, config, summary, records, leaks, staleTmpRemoved };
}

module.exports = { runBenchmark, gitCommit, removeStaleTmp, KL_TMP_PREFIX };
