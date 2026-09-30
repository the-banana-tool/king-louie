'use strict';
// Evidence recall (benchmark spec §8 step 2, CONTEXT.md): the fraction of a
// question's evidence messages a candidate system put in front of the model.
// Message level for every adapter; chunk level for adapters that report
// chunks. No model call. Abstain questions have no evidence and no score.
//
// Answer containment (secondary, judge-free): whether the context text holds
// the question's answer. Strict: `answer` or one of `acceptableAnswers`,
// normalized, is a substring of the normalized context. Tokens: strict, or
// every whitespace token of the shortest answer appears inside one message
// of the context. Blind spot: a paraphrased answer is never found.
const { KINDS, BUCKETS } = require('./questions');

// Typographic quotes and dashes NFKC leaves alone.
const TYPOGRAPHIC = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-']
];
const EDGE_PUNCT = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

// NFKC, typographic punctuation to ASCII, case-folded, whitespace collapsed.
function normalizeText(text) {
  let t = String(text ?? '').normalize('NFKC');
  for (const [re, to] of TYPOGRAPHIC) t = t.replace(re, to);
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

// An answer normalized and stripped of surrounding punctuation.
function normalizeAnswer(text) {
  return normalizeText(text).replace(EDGE_PUNCT, '');
}

// A message header line in an adapter's context: the LongHaul render
// ("[#12 user]") or a recalled excerpt header ("[#12 · user · ...]",
// optionally after 'chat "..." · '). A body line of the same shape splits a
// message in two, which only makes the token variant stricter.
const MESSAGE_HEADER = /^\[(?:chat "[^\n]*" · )?#\d+[ ·][^\n]*\]$/gm;

function splitMessages(text) {
  return String(text ?? '').split(MESSAGE_HEADER).map(normalizeText).filter(Boolean);
}

function answerCandidates(question) {
  const all = [question?.answer, ...(Array.isArray(question?.acceptableAnswers) ? question.acceptableAnswers : [])];
  return [...new Set(all.filter((a) => typeof a === 'string').map(normalizeAnswer).filter(Boolean))];
}

// { strict, tokens } booleans, or null for a question with no answer to find
// (abstain, or no answer left after normalization). tokens is true whenever
// strict is, so the token rate is never below the strict one.
function answerContainment(contextText, question) {
  if (!question || question.kind === 'abstain') return null;
  const candidates = answerCandidates(question);
  if (!candidates.length) return null;
  const context = normalizeText(contextText);
  if (candidates.some((a) => context.includes(a))) return { strict: true, tokens: true };
  const shortest = candidates.reduce((a, b) => (b.length < a.length ? b : a));
  const words = [...new Set(shortest.split(' ').map((w) => w.replace(EDGE_PUNCT, '')).filter(Boolean))];
  const tokens = words.length > 0 && splitMessages(contextText).some((m) => words.every((w) => m.includes(w)));
  return { strict: false, tokens };
}

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

// The share of records with the flag true, over records where it is a boolean.
function rate(records, field) {
  const v = records.map((r) => r[field]).filter((x) => typeof x === 'boolean');
  return v.length ? v.filter(Boolean).length / v.length : null;
}

function groupRecall(records, key) {
  const groups = {};
  for (const r of records) (groups[r[key]] ||= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, {
    n: rs.length,
    evidenceRecall: mean(rs.map((r) => r.evidenceRecall)),
    answerContainment: rate(rs, 'answerContained'),
    answerTokenContainment: rate(rs, 'answerTokensContained')
  }]));
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
      // Secondary, judge-free: the answer text is in the context.
      answerContainment: rate(scored, 'answerContained'),
      answerTokenContainment: rate(scored, 'answerTokensContained'),
      // Evidence messages shown only in part (not counted in evidence recall).
      partial: scored.reduce((n, r) => n + (r.evidencePartial || 0), 0),
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
const cell = (g) => (g ? `${fmt(g.evidenceRecall)} / ${fmt(g.answerContainment)} (n=${g.n})` : '—');

function renderSummaryMarkdown(config, summary) {
  const lines = [`# LongHaul run ${config.runId}`, ''];
  if (config.includeUnverified) lines.push('**UNVERIFIED QUESTIONS INCLUDED. This is a smoke run, not a result.**', '');
  lines.push('Metric: evidence recall, at message level (and at chunk level for adapters that report chunks). No answer or judge model (stage B0).', '');
  lines.push(`Budget ${config.budgetTokens} recalled tokens; seed ${config.seed}; commit ${config.commit}.`, '');
  lines.push(`Sessions: ${config.sessions.map((s) => `${s.sessionId} (${s.private ? 'private' : s.license}, ${s.questions} questions)`).join(', ')}`, '');
  lines.push('Evidence recall counts an evidence message only when it was shown whole. Partial: evidence messages shown only in part (a cut or shortened message, some of its chunks, a folded tool call), not counted.', '');
  lines.push('Answer contained (secondary, no model): the answer or an acceptable answer, normalized (NFKC, case, whitespace, surrounding punctuation), is a substring of the context. Tokens: every word of the shortest answer is inside one message of the context. A paraphrased answer is never found.', '');
  lines.push('| Adapter | Questions | Scored | Errors | Evidence recall | Answer contained | Answer tokens contained | Partial | Chunk evidence recall | Median tokens | p90 tokens | Median ms | p90 ms | Leaks |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(summary)) {
    lines.push(`| ${name} | ${s.questions} | ${s.scored} | ${s.errors} | ${fmt(s.evidenceRecall)} | ${fmt(s.answerContainment)} | ${fmt(s.answerTokenContainment)} | ${s.partial} | ${fmt(s.chunkEvidenceRecall)} | ${s.estTokens.median ?? '—'} | ${s.estTokens.p90 ?? '—'} | ${fmt(s.latencyMs.median, 1)} | ${fmt(s.latencyMs.p90, 1)} | ${s.leaks} |`);
  }
  const kinds = KINDS.filter((k) => k !== 'abstain');
  lines.push('', '## Evidence recall / answer contained by kind', '', `| Adapter | ${kinds.join(' | ')} |`, `|---|${kinds.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${kinds.map((k) => cell(s.byKind[k])).join(' | ')} |`);
  const buckets = BUCKETS.map((b) => b.id);
  lines.push('', '## Evidence recall / answer contained by distance (estimated tokens)', '', `| Adapter | ${buckets.join(' | ')} |`, `|---|${buckets.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${buckets.map((b) => cell(s.byBucket[b])).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  evidenceRecall, chunkEvidenceRecall, answerContainment, normalizeText, normalizeAnswer, splitMessages,
  percentile, mean, summarize, renderSummaryMarkdown
};
