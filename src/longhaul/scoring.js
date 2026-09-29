'use strict';
// Evidence recall (benchmark spec §8 step 2, CONTEXT.md): the fraction of a
// question's evidence messages a candidate system put in front of the model.
// Message level for every adapter; chunk level for adapters that report
// chunks. No model call. Abstain questions have no evidence and no score.
const { KINDS, BUCKETS } = require('./questions');

function evidenceRecall(evidenceSeqs, shownSeqs) {
  if (!evidenceSeqs.length) return null;
  const shown = new Set(shownSeqs);
  return evidenceSeqs.filter((s) => shown.has(s)).length / evidenceSeqs.length;
}

function chunkEvidenceRecall(evidenceSeqs, chunks) {
  if (!chunks || !evidenceSeqs.length) return null;
  const tail = new Set(chunks.tailSeqs || []);
  let sum = 0;
  for (const s of evidenceSeqs) {
    if (tail.has(s)) { sum += 1; continue; }
    const total = chunks.totalBySeq?.[s] || 0;
    const shown = chunks.shownBySeq?.[s] || 0;
    sum += total > 0 ? Math.min(1, shown / total) : 0;
  }
  return sum / evidenceSeqs.length;
}

function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil(p * v.length) - 1)];
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function groupRecall(records, key) {
  const groups = {};
  for (const r of records) (groups[r[key]] ||= []).push(r.evidenceRecall);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { n: v.length, evidenceRecall: mean(v) }]));
}

function summarize(records) {
  const byAdapter = {};
  for (const r of records) (byAdapter[r.adapter] ||= []).push(r);
  const out = {};
  for (const [adapter, rs] of Object.entries(byAdapter)) {
    const ok = rs.filter((r) => !r.error);
    const scored = ok.filter((r) => r.evidenceRecall !== null);
    out[adapter] = {
      questions: rs.length,
      errors: rs.length - ok.length,
      scored: scored.length,
      abstain: ok.length - scored.length,
      evidenceRecall: mean(scored.map((r) => r.evidenceRecall)),
      chunkEvidenceRecall: mean(scored.map((r) => r.chunkEvidenceRecall)),
      byKind: groupRecall(scored, 'kind'),
      byBucket: groupRecall(scored, 'bucket'),
      estTokens: { median: percentile(ok.map((r) => r.estTokens), 0.5), p90: percentile(ok.map((r) => r.estTokens), 0.9), max: percentile(ok.map((r) => r.estTokens), 1) },
      latencyMs: { median: percentile(ok.map((r) => r.latencyMs), 0.5), p90: percentile(ok.map((r) => r.latencyMs), 0.9) },
      cpuMs: { median: percentile(ok.map((r) => r.cpuMs), 0.5), p90: percentile(ok.map((r) => r.cpuMs), 0.9) },
      leaks: ok.reduce((n, r) => n + (r.leaked || 0), 0)
    };
  }
  return out;
}

const fmt = (x, digits = 3) => (x === null || x === undefined ? '—' : x.toFixed(digits));
const cell = (g) => (g ? `${fmt(g.evidenceRecall)} (n=${g.n})` : '—');

function renderSummaryMarkdown(config, summary) {
  const lines = [`# LongHaul run ${config.runId}`, ''];
  if (config.includeUnverified) lines.push('**UNVERIFIED QUESTIONS INCLUDED. This is a smoke run, not a result.**', '');
  lines.push('Metric: evidence recall, at message level (and at chunk level for adapters that report chunks). No answer or judge model (stage B0).', '');
  lines.push(`Budget ${config.budgetTokens} recalled tokens; seed ${config.seed}; commit ${config.commit}.`, '');
  lines.push(`Sessions: ${config.sessions.map((s) => `${s.sessionId} (${s.private ? 'private' : s.license}, ${s.questions} questions)`).join(', ')}`, '');
  lines.push('| Adapter | Questions | Scored | Errors | Evidence recall | Chunk evidence recall | Median tokens | p90 tokens | Median ms | p90 ms | Leaks |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(summary)) {
    lines.push(`| ${name} | ${s.questions} | ${s.scored} | ${s.errors} | ${fmt(s.evidenceRecall)} | ${fmt(s.chunkEvidenceRecall)} | ${s.estTokens.median ?? '—'} | ${s.estTokens.p90 ?? '—'} | ${fmt(s.latencyMs.median, 1)} | ${fmt(s.latencyMs.p90, 1)} | ${s.leaks} |`);
  }
  const kinds = KINDS.filter((k) => k !== 'abstain');
  lines.push('', '## Evidence recall by kind', '', `| Adapter | ${kinds.join(' | ')} |`, `|---|${kinds.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${kinds.map((k) => cell(s.byKind[k])).join(' | ')} |`);
  const buckets = BUCKETS.map((b) => b.id);
  lines.push('', '## Evidence recall by distance (estimated tokens)', '', `| Adapter | ${buckets.join(' | ')} |`, `|---|${buckets.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${buckets.map((b) => cell(s.byBucket[b])).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = { evidenceRecall, chunkEvidenceRecall, percentile, mean, summarize, renderSummaryMarkdown };
