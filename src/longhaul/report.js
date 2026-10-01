'use strict';
// `longhaul report` (benchmark spec §8, §11, B-D8): the records of one or
// more runs aggregated into the paper's tables under
// LONGHAUL_HOME/reports/<id>/: report.md, CSV files (the tables and the
// figures' data: accuracy by distance, accuracy against context tokens) and
// adapters.tex. Aggregate numbers only (no question, reference, reply or
// session text, no question ids), so a report built from private sessions
// may be published (B-D8). --public, for a release bundle, refuses any run
// with a private session (spec §10.1) before any file is written. The same
// runs give byte-identical files: nothing reads the clock, every list is
// sorted. A series is one adapter with one configuration (its describe(),
// hashed), at one tier, answer model and judge model, from one commit and
// with one setup (max tokens and the answer and judge prompt hashes), so
// runs that differ in any of these never share a row. When several runs
// answer the same question for one series (a crashed run and its rerun), the
// latest counts, unless it failed where an earlier one succeeded.
const fs = require('fs');
const path = require('path');
const { summarize, compareAdapters, COMPARISONS, adapterCost, noiseNote } = require('./scoring');
const { stableStringify } = require('./model-cache');
const { KINDS, BUCKETS } = require('./questions');
const { RUN_ID_RE } = require('./run');
const { spotCheckFile } = require('./answer-stage');
const { readSpotChecks, agreement } = require('./spot-check');
const { writeFileAtomic, sha256Text, childPath, readJsonl, byCodeUnit } = require('./files');
const { fixed } = require('./format');
const { UsageError } = require('./errors');

const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fmt = (x, d = 3) => fixed(x, d, ''); // CSV: a missing value is an empty cell
const md = (x, d = 3) => fixed(x, d, '-');
const texEscape = (s) => String(s).replace(/[\\&%$#_{}]/g, (c) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`));

function csv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

function loadRun(home, runId) {
  if (!RUN_ID_RE.test(runId)) throw new UsageError(`${JSON.stringify(runId)} is not a run id (like 20260930T101500Z-1a2b).`);
  const dir = path.join(home.runs, runId);
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) throw new UsageError(`No run ${runId} under ${home.runs}.`);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const recordsFile = path.join(dir, 'records.jsonl');
  const records = readJsonl(recordsFile);
  const spendFile = path.join(dir, 'spend.json');
  const spend = fs.existsSync(spendFile) ? JSON.parse(fs.readFileSync(spendFile, 'utf8')) : null;
  const sample = spotCheckFile(home, runId);
  const spot = fs.existsSync(sample) ? agreement(readSpotChecks(sample)) : null;
  return { runId, config, records, spend, spot };
}

// The commit as shown: 12 hex, keeping a "-dirty" mark (an uncommitted
// prompt edit is another setup).
function shortCommit(commit) {
  const full = String(commit ?? 'unknown');
  return `${full.slice(0, 12)}${full.endsWith('-dirty') && full.length > 18 ? '-dirty' : ''}`;
}

// The adapter's configuration as the run recorded it (config.adapters holds
// each adapter's describe(), with the recall settings, windows and models),
// hashed: two kl-recall runs with different --recall settings, or before and
// after a default changed, are two series.
function configHash(config, adapter) {
  const d = (config.adapters || []).find((x) => x && x.name === adapter);
  return d ? sha256Text(stableStringify(d)).slice(0, 8) : 'unknown';
}

// What else changes an answer, hashed into setup: (8 hex): the full commit
// (two commits that share 12 hex, or a "-dirty" tree, stay apart), the
// answer and judge max tokens, and the answer and judge prompts' hashes (the
// judge's with its rules). The summarize prompt is not here: only
// summarize-compact uses it, and its describe() carries the hash (so cfg:
// splits that series alone), so a run with a summarizer and one without
// still share a cohort for the other adapters.
function setupHash(config) {
  const a = config.answer;
  const prompt = (p) => (p ? p.sha256 ?? null : null);
  const parts = { commit: String(config.commit ?? 'unknown') };
  if (a) {
    Object.assign(parts, {
      answerMaxTokens: a.answerModel?.maxTokens ?? null,
      judgeMaxTokens: a.judgeModel?.maxTokens ?? null,
      prompts: { answer: prompt(a.prompts?.answer), judge: prompt(a.prompts?.judge), judgeRules: a.prompts?.judge?.rulesSha256 ?? null }
    });
  }
  return sha256Text(stableStringify(parts)).slice(0, 8);
}

// Everything a series holds equal except the adapter and its configuration;
// a named comparison pairs two adapters within one cohort.
function cohortOf(config) {
  const tail = `commit:${shortCommit(config.commit)} setup:${setupHash(config)}`;
  if (!config.answer) return `evidence-only ${tail}`;
  const { tier, answerModel: m, judgeModel: j } = config.answer;
  return `${tier} ${m.provider}/${m.model} judge:${j.provider}/${j.model} ${tail}`;
}

function seriesOf(config, adapter) {
  return `${adapter} cfg:${configHash(config, adapter)} @ ${cohortOf(config)}`;
}

// A record that produced a result: no context error and no answer error.
const succeeded = (r) => !r.error && !r.answerError;

function buildReport(runs) {
  const ordered = [...runs].sort((x, y) => byCodeUnit(x.runId, y.runId));
  const byKey = new Map();
  const setup = new Map();
  const meta = new Map();
  for (const run of ordered) {
    for (const r of run.records) {
      const adapter = seriesOf(run.config, r.adapter);
      meta.set(adapter, { adapter: r.adapter, cohort: cohortOf(run.config) });
      const key = `${adapter}\u0000${r.sessionId}\u0000${r.questionId}`;
      const prev = byKey.get(key);
      // The latest run wins, but a failure never replaces a success.
      if (!prev || succeeded(r) || !succeeded(prev)) byKey.set(key, { ...r, adapter });
    }
    for (const c of run.spend?.setupCosts || []) {
      const adapter = seriesOf(run.config, c.adapter);
      setup.set(`${adapter}\u0000${c.sessionId}`, { ...c, adapter });
    }
  }
  const records = [...byKey.values()].sort((x, y) => byCodeUnit(x.adapter, y.adapter)
    || byCodeUnit(x.sessionId, y.sessionId) || byCodeUnit(x.questionId, y.questionId));
  const summary = summarize(records, { setupCosts: [...setup.values()].sort((x, y) => byCodeUnit(x.adapter, y.adapter) || byCodeUnit(x.sessionId, y.sessionId)) });
  const series = Object.keys(summary).sort();
  const cut = Object.fromEntries(series.map((s) => [s, records.filter((r) => r.adapter === s && r.contextTruncated === true).length]));
  const comparisons = [];
  for (const c of COMPARISONS) {
    for (const a of series) {
      if (meta.get(a)?.adapter !== c.a) continue;
      for (const b of series) {
        if (meta.get(b)?.adapter !== c.b || meta.get(b).cohort !== meta.get(a).cohort) continue;
        const result = compareAdapters(records, a, b);
        if (result) comparisons.push({ id: c.id, title: c.title, a, b, result });
      }
    }
  }
  return { summary, series, comparisons, cut };
}

function costPerPoint(s) {
  const cost = adapterCost(s);
  const acc = s.answer?.accuracy;
  return s.answer && cost.unknown === 0 && acc ? cost.usd / (acc * 100) : null;
}

function renderCsvs({ summary, series, comparisons, cut }) {
  const files = {};
  const adapters = [['series', 'questions', 'evidence_recall', 'answer_contained', 'answer_n', 'answer_accuracy', 'partial_rate', 'declined_rate',
    'abstain_n', 'abstain_accuracy', 'false_answer_rate', 'answer_errors', 'contexts_cut', 'median_context_tokens', 'p90_context_tokens',
    'median_answer_input_tokens', 'cost_usd', 'cost_unknown_calls', 'cost_per_accuracy_point_usd',
    'median_context_ms', 'p90_context_ms', 'median_answer_ms', 'p90_answer_ms']];
  for (const name of series) {
    const s = summary[name];
    const a = s.answer;
    const cost = adapterCost(s);
    adapters.push([name, s.questions, fmt(s.evidenceRecall), fmt(s.answerContainment), a ? a.n : '', fmt(a?.accuracy), fmt(a?.partialRate),
      fmt(a?.declinedRate), a ? a.abstain.n : '', fmt(a?.abstain.accuracy), fmt(a?.abstain.falseAnswerRate), a ? a.errors : '', cut[name],
      s.estTokens.median ?? '', s.estTokens.p90 ?? '', a?.answerInputTokens.median ?? '', a ? fmt(cost.usd, 4) : '', a ? cost.unknown : '', fmt(costPerPoint(s), 5),
      fmt(s.latencyMs.median, 1), fmt(s.latencyMs.p90, 1), fmt(a?.answerLatencyMs.median, 1), fmt(a?.answerLatencyMs.p90, 1)]);
  }
  files['adapters.csv'] = csv(adapters);

  // One row per series and group: evidence side (scored_n) and answer side
  // (judged_n); for abstain, answer_accuracy is abstain accuracy.
  const grouped = (key, groups) => {
    const rows = [['series', key, 'scored_n', 'evidence_recall', 'answer_contained', 'judged_n', 'answer_accuracy']];
    for (const name of series) {
      const s = summary[name];
      const ev = key === 'kind' ? s.byKind : key === 'bucket' ? s.byBucket : s.bySession;
      const an = s.answer ? (key === 'kind' ? s.answer.byKind : key === 'bucket' ? s.answer.byBucket : s.answer.bySession) : {};
      for (const g of groups(s)) {
        const e = ev[g];
        const x = an[g];
        if (!e && !x) continue;
        const abstainOnly = x && x.n === 0 && x.abstainN > 0;
        rows.push([name, g, e ? e.n : 0, fmt(e?.evidenceRecall), fmt(e?.answerContainment),
          x ? (abstainOnly ? x.abstainN : x.n) : '', fmt(abstainOnly ? x.abstainAccuracy : x?.accuracy)]);
      }
    }
    return csv(rows);
  };
  files['by-kind.csv'] = grouped('kind', () => KINDS);
  files['by-distance.csv'] = grouped('bucket', () => [...BUCKETS.map((b) => b.id), 'none']);
  files['by-session.csv'] = grouped('session', (s) => [...new Set([...Object.keys(s.bySession), ...Object.keys(s.answer?.bySession || {})])].sort());

  const tokens = [['series', 'median_context_tokens', 'p90_context_tokens', 'answer_accuracy']];
  for (const name of series) tokens.push([name, summary[name].estTokens.median ?? '', summary[name].estTokens.p90 ?? '', fmt(summary[name].answer?.accuracy)]);
  files['accuracy-vs-tokens.csv'] = csv(tokens);

  const comp = [['id', 'a', 'b', 'n', 'judged', 'a_accuracy', 'b_accuracy', 'delta', 'only_a', 'only_b', 'a_evidence_recall', 'b_evidence_recall', 'a_contained', 'b_contained']];
  for (const { id, a, b, result: r } of comparisons) {
    comp.push([id, a, b, r.n, r.judged, fmt(r.accuracy.a), fmt(r.accuracy.b), fmt(r.accuracy.delta), r.onlyA, r.onlyB,
      fmt(r.evidenceRecall.a), fmt(r.evidenceRecall.b), fmt(r.answerContainment.a), fmt(r.answerContainment.b)]);
  }
  files['comparisons.csv'] = csv(comp);
  return files;
}

function renderTex({ summary, series }) {
  const lines = ['\\begin{tabular}{lrrrrrr}', '\\hline',
    'System & Evidence recall & Contained & Accuracy & Abstain acc. & Median tokens & USD \\\\', '\\hline'];
  for (const name of series) {
    const s = summary[name];
    const cost = adapterCost(s);
    lines.push(`${texEscape(name)} & ${md(s.evidenceRecall)} & ${md(s.answerContainment)} & ${md(s.answer?.accuracy)} & ${md(s.answer?.abstain.accuracy)} & `
      + `${s.estTokens.median ?? '-'} & ${s.answer && cost.unknown === 0 ? cost.usd.toFixed(2) : '-'} \\\\`);
  }
  lines.push('\\hline', '\\end{tabular}');
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(reportId, runs, { summary, series, comparisons, cut }) {
  const L = [`# LongHaul report ${reportId}`, ''];
  L.push('Aggregate numbers only: no question, answer or session text (B-D8). A series is one adapter with one configuration '
    + '(cfg: the first 8 hex of its recorded describe() hash) at one tier, answer model and judge model, from one commit, with one setup '
    + '(setup: 8 hex over the full commit, the answer and judge max tokens and the answer and judge prompt hashes; the summarize prompt hash is in the cfg: of summarize-compact alone); '
    + 'when several runs answer the same question for one series, the latest run counts, but a failed record never replaces a successful one.', '');
  L.push('## Runs', '', '| Run | Stage | Tier | Answer model | Judge model | Prompts (answer / judge) | Questions | Private sessions | Commit | Judge spot-check |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const run of [...runs].sort((x, y) => byCodeUnit(x.runId, y.runId))) {
    const c = run.config;
    const a = c.answer;
    const questions = (c.sessions || []).reduce((n, s) => n + (s.questions || 0), 0);
    const priv = (c.sessions || []).filter((s) => s.private).length;
    const spot = !run.spot ? '-' : run.spot.reviewed ? `${run.spot.agreed}/${run.spot.reviewed} agreed (${run.spot.sampled} sampled)` : `not reviewed (${run.spot.sampled} sampled)`;
    L.push(`| ${run.runId} | ${c.stage} | ${a ? a.tier : '-'} | ${a ? `${a.answerModel.provider}/${a.answerModel.model}` : '-'} | `
      + `${a ? `${a.judgeModel.provider}/${a.judgeModel.model}` : '-'} | ${a ? `${a.prompts.answer.sha256.slice(0, 12)} / ${a.prompts.judge.sha256.slice(0, 12)}` : '-'} | `
      + `${questions} | ${priv} | ${shortCommit(c.commit)} | ${spot} |`);
  }
  L.push('', '## Per adapter', '', '| Series | Questions | Evidence recall | Contained | Accuracy (n) | Partial | Declined | Abstain accuracy (n) | False answers | Contexts cut | Median tokens | p90 tokens | Cost USD | USD per accuracy point |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const name of series) {
    const s = summary[name];
    const a = s.answer;
    const cost = adapterCost(s);
    L.push(`| ${name} | ${s.questions} | ${md(s.evidenceRecall)} | ${md(s.answerContainment)} | ${a ? `${md(a.accuracy)} (${a.n})` : '-'} | ${md(a?.partialRate)} | `
      + `${md(a?.declinedRate)} | ${a ? `${md(a.abstain.accuracy)} (${a.abstain.n})` : '-'} | ${md(a?.abstain.falseAnswerRate)} | ${cut[name]} | `
      + `${s.estTokens.median ?? '-'} | ${s.estTokens.p90 ?? '-'} | ${a ? `${cost.usd.toFixed(4)}${cost.unknown ? ` + ${cost.unknown} unknown` : ''}` : '-'} | ${md(costPerPoint(s), 5)} |`);
  }
  const table = (title, groups, pick) => {
    L.push('', `## ${title}`, '', `| Series | ${groups.join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`);
    for (const name of series) L.push(`| ${name} | ${groups.map((g) => pick(summary[name], g)).join(' | ')} |`);
  };
  const answerCell = (x) => (!x ? '-' : x.n === 0 && x.abstainN > 0 ? `${md(x.abstainAccuracy)} (${x.abstainN})` : `${md(x.accuracy)} (${x.n})`);
  table('Answer accuracy by kind (abstain: abstain accuracy)', [...KINDS], (s, k) => answerCell(s.answer?.byKind[k]));
  table('Answer accuracy by distance (estimated tokens; none: abstain)', [...BUCKETS.map((b) => b.id), 'none'], (s, b) => answerCell(s.answer?.byBucket[b]));
  table('Evidence recall by distance', BUCKETS.map((b) => b.id), (s, b) => (s.byBucket[b] ? `${md(s.byBucket[b].evidenceRecall)} (${s.byBucket[b].n})` : '-'));
  const sessions = [...new Set(series.flatMap((n) => Object.keys(summary[n].answer?.bySession || {})))].sort();
  if (sessions.length) table('Answer accuracy by session', sessions, (s, id) => answerCell(s.answer?.bySession[id]));
  if (comparisons.length) {
    L.push('', '## Named comparisons', '');
    for (const { id, title, a, b, result: r } of comparisons) {
      L.push(`- ${id}: ${a} ${md(r.accuracy.a)} vs ${b} ${md(r.accuracy.b)} over ${r.judged} paired questions (delta ${md(r.accuracy.delta)}; `
        + `right in one only: ${r.onlyA} vs ${r.onlyB}); evidence recall ${md(r.evidenceRecall.a)} vs ${md(r.evidenceRecall.b)}. ${title}.`);
    }
  }
  L.push('', '## Notes', '',
    '- Context tokens are estimated (characters / 4, recall spec §6.6); answer and judge tokens come from provider usage (spec §11).',
    '- Accuracy counts answerable questions judged correct; partial is not correct. Abstain accuracy counts abstain questions the model declined.',
    '- The judge sees the question, the reference answers and the reply, never the context. See the runs table for its spot-check agreement.',
    '- full-history and real-compaction are cut at their window; "Contexts cut" counts the questions where that happened (spec §8.1).',
    `- ${noiseNote(Math.max(0, ...series.map((n) => summary[n].answer?.n ?? 0))) || 'No answerable question was judged.'} `
      + 'Its n is the largest series\' answerable questions.',
    '- Cost is what the calls behind these records cost to make, from catalog prices at the time; cached calls are counted at their original cost. '
      + '"+ N unknown" counts calls with no known cost (an unpriced model, or a reply that reported no usage), never $0.');
  const estimated = [...runs].sort((x, y) => byCodeUnit(x.runId, y.runId)).filter((r) => r.spend?.estimatedCalls > 0);
  if (estimated.length) {
    L.push('- Calls settled at their estimate (a reply from a priced model that came back unpriced, with no usage or no cost: its record\'s cost is unknown, and spend.json charged it '
      + `at its reservation): ${estimated.map((r) => `${r.runId} ${r.spend.estimatedCalls}`).join(', ')}.`);
  }
  return `${L.join('\n')}\n`;
}

function writeReport(home, runIds, { id = null, publicOnly = false } = {}) {
  const ids = [...new Set(runIds)].sort();
  if (!ids.length) throw new UsageError('Name the runs with --runs <runId>[,<runId>...].');
  const runs = ids.map((r) => loadRun(home, r));
  if (publicOnly) {
    const withPrivate = runs.filter((r) => (r.config.sessions || []).some((s) => s.private)).map((r) => r.runId);
    if (withPrivate.length) {
      throw new UsageError(`--public refuses runs with a private session (benchmark spec section 10.1): ${withPrivate.join(', ')}. `
        + 'Without --public the report is aggregate numbers only, which B-D8 allows publishing.', 'PRIVATE_IN_PUBLIC');
    }
  }
  const reportId = id ?? `r-${sha256Text(ids.join('\n')).slice(0, 12)}`;
  if (!REPORT_ID_RE.test(reportId)) throw new UsageError(`--id must be letters, digits, . _ - (at most 64), got ${JSON.stringify(reportId)}`);
  const dir = childPath(home.reports, reportId, () => new UsageError(`Report id ${JSON.stringify(reportId)} leaves ${home.reports}.`));
  const built = buildReport(runs);
  const files = { ...renderCsvs(built), 'adapters.tex': renderTex(built), 'report.md': renderMarkdown(reportId, runs, built) };
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(dir, name), content);
  return { id: reportId, dir, files: Object.keys(files).sort() };
}

module.exports = { loadRun, cohortOf, seriesOf, buildReport, writeReport };
