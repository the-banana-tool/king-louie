'use strict';
// `longhaul report` over compaction-loss runs (benchmark spec §9, §11):
// compaction-loss.csv, compaction-loss.tex and report.md, one row per run and
// session plus the run's `all`, from each run's summary.json. Counts, rates,
// ids, models and prompt hashes only; facts, quotes and reasons stay under
// private/. Nothing reads the clock, so the same runs give the same bytes.
const fs = require('fs');
const path = require('path');
const { csv, texEscape, shortCommit } = require('../report');
const { spotCheckFile } = require('../answer-stage');
const { readSpotChecks, compactionAgreement } = require('../spot-check');
const { byCodeUnit } = require('../files');
const { fixed } = require('../format');
const { UsageError } = require('../errors');

const fmt = (x, d = 3) => fixed(x, d, '');
const md = (x, d = 3) => fixed(x, d, '-');

function loadSummary(home, runId) {
  const file = path.join(home.runs, runId, 'summary.json');
  if (!fs.existsSync(file)) throw new UsageError(`Run ${runId} has no summary.json: it did not finish. Run compaction-loss again; its calls come from the cache.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rowsOf(runs) {
  const rows = [];
  for (const run of runs) {
    for (const id of Object.keys(run.summary.sessions).sort(byCodeUnit)) rows.push({ runId: run.runId, session: id, s: run.summary.sessions[id] });
    rows.push({ runId: run.runId, session: 'all', s: run.summary.all });
  }
  return rows;
}

function renderCsv(rows) {
  const out = [['run', 'session', 'windows', 'facts', 'judged', 'rejected', 'errors', 'preserved_rate', 'partial_rate', 'lost_rate', 'needed_rate',
    'lost_and_needed_rate', 'median_ratio']];
  for (const { runId, session, s } of rows) {
    out.push([runId, session, s.windows, s.facts, s.judged, s.rejected, s.errors, fmt(s.preservedRate), fmt(s.partialRate), fmt(s.lostRate),
      fmt(s.neededRate), fmt(s.lostAndNeededRate), fmt(s.ratio?.median, 1)]);
  }
  return csv(out);
}

function renderTex(rows, multiRun) {
  const lines = ['\\begin{tabular}{lrrrrrrrr}', '\\hline',
    'Session & Windows & Facts & Preserved & Partial & Lost & Needed & Lost and needed & Median ratio \\\\', '\\hline'];
  for (const { runId, session, s } of rows) {
    const name = multiRun ? `${runId} ${session}` : session;
    lines.push(`${texEscape(name)} & ${s.windows} & ${s.facts} & ${md(s.preservedRate)} & ${md(s.partialRate)} & ${md(s.lostRate)} & `
      + `${md(s.neededRate)} & ${md(s.lostAndNeededRate)} & ${md(s.ratio?.median, 1)} \\\\`);
  }
  lines.push('\\hline', '\\end{tabular}');
  return `${lines.join('\n')}\n`;
}

function spotCell(spot) {
  if (!spot) return '-';
  if (!spot.reviewed) return `not reviewed (${spot.sampled} sampled)`;
  return `${spot.agreed}/${spot.reviewed} agreed with both (${spot.sampled} sampled; summary ${spot.preservedAgreed}/${spot.reviewed}, `
    + `needed ${spot.neededAgreed}/${spot.reviewed})`;
}

function renderMarkdown(reportId, runs, rows) {
  const L = [`# LongHaul compaction-loss report ${reportId}`, '',
    'Aggregate numbers only: no fact, quote, summary or reason text (B-D8). Rates are over judged facts.', '',
    '## Runs', '', '| Run | Stage | Author model | Judge model | Prompts (fact / preserved / needed) | Facts a window | Candidates | Seed | Matching | Private sessions | Commit | Spot-check |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const { runId, config: c, spot } of runs) {
    const p = (name) => String(c.prompts?.[name] ?? '').slice(0, 12);
    const priv = (c.sessions || []).filter((s) => s.private).length;
    L.push(`| ${runId} | ${c.stage} | ${c.author.provider}/${c.author.model} | ${c.judge.provider}/${c.judge.model} | `
      + `${p('compactionFact')} / ${p('compactionPreserved')} / ${p('compactionNeeded')} | ${c.factsPerWindow} | ${c.candidates} | ${c.seed} | `
      + `${c.embed ? `lexical and semantic (${c.embed.provider}/${c.embed.model})` : 'lexical'} | ${priv} | ${shortCommit(c.commit)} | ${spotCell(spot)} |`);
  }
  L.push('', '## What compactions kept and lost', '',
    '| Run | Session | Windows | Facts | Judged | Rejected | Errors | Preserved | Partial | Lost | Needed | Lost and needed | Median ratio |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { runId, session, s } of rows) {
    L.push(`| ${runId} | ${session} | ${s.windows} | ${s.facts} | ${s.judged} | ${s.rejected} | ${s.errors} | ${md(s.preservedRate)} | ${md(s.partialRate)} | `
      + `${md(s.lostRate)} | ${md(s.neededRate)} | ${md(s.lostAndNeededRate)} | ${md(s.ratio?.median, 1)} |`);
  }
  const skipped = runs.flatMap((r) => (r.config.skipped || []).map((x) => ({ runId: r.runId, ...x })));
  if (skipped.length) {
    L.push('', '## Skipped', '', '| Run | Session | Summary seq | Reason |', '|---|---|---|---|');
    for (const x of skipped) L.push(`| ${x.runId} | ${x.sessionId} | ${x.summarySeq ?? '-'} | ${x.reason} |`);
  }
  L.push('', '## Notes', '',
    '- A fact is checked mechanically before it is judged: its evidence lies inside the condensed window and its quote is in that message; a fact that fails is rejected, never judged.',
    '- The summary judge sees the fact and the summary only, never the window. The median ratio is the window\'s estimated tokens over the summary\'s.',
    '- "Needed" sees only the later messages that match the fact (lexically, and semantically when the run says so), so lost-and-needed is a lower bound.',
    '- The spot-check is a seeded tenth of the judged facts, reviewed by a person against both judgments.');
  return `${L.join('\n')}\n`;
}

function renderCompactionReport(home, reportId, loaded) {
  const runs = [...loaded].sort((x, y) => byCodeUnit(x.runId, y.runId)).map((run) => {
    const file = spotCheckFile(home, run.runId);
    return { ...run, summary: loadSummary(home, run.runId), spot: fs.existsSync(file) ? compactionAgreement(readSpotChecks(file)) : null };
  });
  const rows = rowsOf(runs);
  return {
    'compaction-loss.csv': renderCsv(rows),
    'compaction-loss.tex': renderTex(rows, runs.length > 1),
    'report.md': renderMarkdown(reportId, runs, rows)
  };
}

module.exports = { renderCompactionReport };
