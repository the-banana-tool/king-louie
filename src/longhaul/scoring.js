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
const { isRight } = require('./judge');

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

function summarize(records, { setupCosts = [] } = {}) {
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
      bySession: groupRecall(scored, 'sessionId'),
      answer: answerStats(rs),
      setup: setupOf(setupCosts, adapter),
      estTokens: { median: percentile(ok.map((r) => r.estTokens), 0.5), p90: percentile(ok.map((r) => r.estTokens), 0.9), max: percentile(ok.map((r) => r.estTokens), 1) },
      latencyMs: { median: percentile(ok.map((r) => r.latencyMs), 0.5), p90: percentile(ok.map((r) => r.latencyMs), 0.9) },
      cpuMs: { median: percentile(ok.map((r) => r.cpuMs), 0.5), p90: percentile(ok.map((r) => r.cpuMs), 0.9) },
      leaks: ok.reduce((n, r) => n + (r.leaked || 0), 0)
    };
  }
  return out;
}

const round8 = (n) => Number(n.toFixed(8));

// The named comparisons a run and a report print when both adapters ran.
// whole-messages is the experiment B0 left open (measured facts; recall spec
// §6.7): whole small messages and tool pairing raised evidence recall but not
// containment, so only answer accuracy can decide it.
const COMPARISONS = Object.freeze([Object.freeze({
  id: 'whole-messages',
  a: 'kl-recall',
  b: 'kl-recall-whole',
  title: 'Whole small messages and tool pairing (completeMessageTokens 800, pairToolMessages true) against the shipped kl-recall defaults'
})]);

// { n, accuracy, abstainN, abstainAccuracy } per group of judged records:
// accuracy over the answerable ones (correct), abstain accuracy over the
// abstain ones (declined).
function groupAnswers(judged, key) {
  const groups = {};
  for (const r of judged) (groups[r[key]] ||= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => {
    const answerable = rs.filter((r) => r.kind !== 'abstain');
    const abstain = rs.filter((r) => r.kind === 'abstain');
    return [k, {
      n: answerable.length,
      accuracy: answerable.length ? answerable.filter(isRight).length / answerable.length : null,
      abstainN: abstain.length,
      abstainAccuracy: abstain.length ? abstain.filter(isRight).length / abstain.length : null
    }];
  }));
}

// What the calls behind the records cost to make (usd), what this run paid
// (spentUsd: the calls that were not cache hits), and how many had no known
// price (never counted as $0).
function costOf(staged, costField, cachedField) {
  let usd = 0;
  let spentUsd = 0;
  let unknown = 0;
  for (const r of staged) {
    if (r[cachedField] === null || r[cachedField] === undefined) continue; // no call was made
    if (typeof r[costField] === 'number') {
      usd += r[costField];
      if (r[cachedField] === false) spentUsd += r[costField];
    } else {
      unknown += 1;
    }
  }
  return { usd: round8(usd), spentUsd: round8(spentUsd), unknown };
}

function answerStats(rs) {
  const staged = rs.filter((r) => !r.error && r.verdict !== undefined);
  if (!staged.length) return null;
  const judged = staged.filter((r) => typeof r.verdict === 'string');
  const answerable = judged.filter((r) => r.kind !== 'abstain');
  const abstain = judged.filter((r) => r.kind === 'abstain');
  const share = (list, v) => (list.length ? list.filter((r) => r.verdict === v).length / list.length : null);
  const abstainAccuracy = share(abstain, 'abstained');
  const errorsByCode = {};
  for (const r of staged) if (r.answerError) errorsByCode[r.answerError] = (errorsByCode[r.answerError] || 0) + 1;
  const tokens = staged.map((r) => r.answerInputTokens);
  const latency = staged.map((r) => r.answerLatencyMs);
  return {
    n: answerable.length,
    accuracy: share(answerable, 'correct'),
    partialRate: share(answerable, 'partial'),
    incorrectRate: share(answerable, 'incorrect'),
    declinedRate: share(answerable, 'abstained'),
    abstain: { n: abstain.length, accuracy: abstainAccuracy, falseAnswerRate: abstainAccuracy === null ? null : 1 - abstainAccuracy },
    errors: staged.filter((r) => r.answerError).length,
    errorsByCode,
    answerInputTokens: { median: percentile(tokens, 0.5), p90: percentile(tokens, 0.9) },
    answerLatencyMs: { median: percentile(latency, 0.5), p90: percentile(latency, 0.9) },
    cost: { answer: costOf(staged, 'answerCostUsd', 'answerCached'), judge: costOf(staged, 'judgeCostUsd', 'judgeCached') },
    byKind: groupAnswers(judged, 'kind'),
    byBucket: groupAnswers(judged, 'bucket'),
    bySession: groupAnswers(judged, 'sessionId')
  };
}

function setupOf(setupCosts, adapter) {
  const mine = setupCosts.filter((c) => c.adapter === adapter);
  if (!mine.length) return null;
  const sum = (f) => mine.reduce((n, c) => n + (c[f] || 0), 0);
  return { costUsd: round8(sum('costUsd')), calls: sum('calls'), cachedCalls: sum('cachedCalls'), unpricedCalls: sum('unpricedCalls') };
}

// An adapter's model cost: answers, judgments and its setup (summaries).
function adapterCost(s) {
  const a = s.answer;
  const usd = (a ? a.cost.answer.usd + a.cost.judge.usd : 0) + (s.setup ? s.setup.costUsd : 0);
  const unknown = (a ? a.cost.answer.unknown + a.cost.judge.unknown : 0) + (s.setup ? s.setup.unpricedCalls : 0);
  return { usd: round8(usd), unknown };
}

function pairMeans(pairs, value) {
  const a = mean(pairs.map(([x]) => value(x)));
  const b = mean(pairs.map(([, y]) => value(y)));
  return { a, b, delta: a === null || b === null ? null : round8(b - a) };
}

function compareAdapters(records, a, b) {
  const key = (r) => `${r.sessionId}\u0000${r.questionId}`;
  const left = new Map(records.filter((r) => r.adapter === a && !r.error).map((r) => [key(r), r]));
  const pairs = records.filter((r) => r.adapter === b && !r.error && left.has(key(r))).map((r) => [left.get(key(r)), r]);
  if (!pairs.length) return null;
  const judged = pairs.filter(([x, y]) => typeof x.verdict === 'string' && typeof y.verdict === 'string');
  const accA = judged.length ? judged.filter(([x]) => isRight(x)).length / judged.length : null;
  const accB = judged.length ? judged.filter(([, y]) => isRight(y)).length / judged.length : null;
  const scored = pairs.filter(([x]) => x.kind !== 'abstain');
  const contained = (r) => (typeof r.answerContained === 'boolean' ? Number(r.answerContained) : null);
  return {
    a, b, n: pairs.length, judged: judged.length,
    accuracy: { a: accA, b: accB, delta: accA === null ? null : round8(accB - accA) },
    onlyA: judged.filter(([x, y]) => isRight(x) && !isRight(y)).length,
    onlyB: judged.filter(([x, y]) => !isRight(x) && isRight(y)).length,
    evidenceRecall: pairMeans(scored, (r) => r.evidenceRecall),
    answerContainment: pairMeans(scored, contained),
    medianTokens: { a: percentile(pairs.map(([x]) => x.estTokens), 0.5), b: percentile(pairs.map(([, y]) => y.estTokens), 0.5) }
  };
}

const fmt = (x, digits = 3) => (x === null || x === undefined ? '—' : x.toFixed(digits));
const cell = (g) => (g ? `${fmt(g.evidenceRecall)} / ${fmt(g.answerContainment)} (n=${g.n})` : '—');

const usdCell = ({ usd, unknown }) => (unknown ? `${usd.toFixed(4)} + ${unknown} unpriced` : usd.toFixed(4));
const answerCell = (g) => (g ? `${fmt(g.accuracy)} (n=${g.n})` : '—');
const kindCell = (kind, g) => (!g ? '—' : kind === 'abstain' ? `${fmt(g.abstainAccuracy)} (n=${g.abstainN})` : answerCell(g));

function renderSummaryMarkdown(config, summary, { spend = null, comparisons = [] } = {}) {
  const lines = [`# LongHaul run ${config.runId}`, ''];
  if (config.includeUnverified) lines.push('**UNVERIFIED QUESTIONS INCLUDED. This is a smoke run, not a result.**', '');
  if (config.answer) {
    const a = config.answer;
    const sample = a.sample?.requested ? `, a stratified sample of ${a.sample.questions} questions` : '';
    lines.push(`Metric: answer accuracy, judged by ${a.judgeModel.provider}/${a.judgeModel.model}; evidence recall and answer containment alongside. `
      + `Answer model ${a.answerModel.provider}/${a.answerModel.model}, tier ${a.tier}${sample}. `
      + `Prompts: answer ${a.prompts.answer.sha256.slice(0, 12)}, judge ${a.prompts.judge.sha256.slice(0, 12)}.`, '');
  } else {
    lines.push('Metric: evidence recall, at message level (and at chunk level for adapters that report chunks). No answer or judge model (stage B0).', '');
  }
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

  const answered = Object.entries(summary).filter(([, s]) => s.answer);
  if (answered.length) {
    lines.push('', '## Answer accuracy', '');
    lines.push('Accuracy: answerable questions judged correct (partial is not correct). Declined: answerable questions the model said it could not answer. '
      + 'Abstain accuracy: abstain questions the model declined; false answers: abstain questions it answered anyway. '
      + 'Errors (a failed call, an unparsable verdict, the cap) are left out of the rates. Answer tokens come from provider usage; context tokens are estimated. '
      + 'One question is about 0.01; differences under 0.02 are noise.', '');
    lines.push('| Adapter | Judged | Accuracy | Partial | Declined | Abstain accuracy | False answers | Errors | Median answer tokens | p90 answer tokens | Cost USD |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [name, s] of answered) {
      const a = s.answer;
      lines.push(`| ${name} | ${a.n + a.abstain.n} | ${fmt(a.accuracy)} | ${fmt(a.partialRate)} | ${fmt(a.declinedRate)} | ${fmt(a.abstain.accuracy)} | ${fmt(a.abstain.falseAnswerRate)} | ${a.errors} | ${a.answerInputTokens.median ?? '—'} | ${a.answerInputTokens.p90 ?? '—'} | ${usdCell(adapterCost(s))} |`);
    }
    lines.push('', '## Answer accuracy by kind', '', `| Adapter | ${KINDS.join(' | ')} |`, `|---|${KINDS.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${KINDS.map((k) => kindCell(k, s.answer.byKind[k])).join(' | ')} |`);
    const allBuckets = [...buckets, 'none'];
    lines.push('', '## Answer accuracy by distance (abstain questions: none)', '', `| Adapter | ${allBuckets.join(' | ')} |`, `|---|${allBuckets.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${allBuckets.map((b) => (b === 'none' ? kindCell('abstain', s.answer.byBucket[b]) : answerCell(s.answer.byBucket[b]))).join(' | ')} |`);
    const sessions = [...new Set(answered.flatMap(([, s]) => Object.keys(s.answer.bySession)))].sort();
    lines.push('', '## Answer accuracy by session', '', `| Adapter | ${sessions.join(' | ')} |`, `|---|${sessions.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${sessions.map((id) => answerCell(s.answer.bySession[id])).join(' | ')} |`);
  }
  const shown = comparisons.filter((c) => c.result);
  if (shown.length) {
    lines.push('', '## Named comparisons', '');
    for (const { id, title, a, b, result: r } of shown) {
      lines.push(`- ${id}: ${a} ${fmt(r.accuracy.a)} vs ${b} ${fmt(r.accuracy.b)} answer accuracy over ${r.judged} paired questions `
        + `(delta ${fmt(r.accuracy.delta)}; right in ${a} only ${r.onlyA}, in ${b} only ${r.onlyB}); evidence recall ${fmt(r.evidenceRecall.a)} vs ${fmt(r.evidenceRecall.b)}, `
        + `contained ${fmt(r.answerContainment.a)} vs ${fmt(r.answerContainment.b)}, median tokens ${r.medianTokens.a ?? '—'} vs ${r.medianTokens.b ?? '—'}. ${title}.`);
    }
  }
  if (spend) {
    lines.push('', '## Spend', '', `Spent $${spend.spentUsd.toFixed(4)} on ${spend.calls} calls (${spend.unpricedCalls} unpriced); `
      + `estimate ${spend.estimateUsd === null || spend.estimateUsd === undefined ? 'unknown' : `$${spend.estimateUsd.toFixed(4)}`}.`
      + `${spend.overBudget ? ' STOPPED AT THE CAP: the remaining questions are over-budget errors; run again to finish (cached calls are free).' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  evidenceRecall, chunkEvidenceRecall, answerContainment, normalizeText, normalizeAnswer, splitMessages,
  percentile, mean, summarize, renderSummaryMarkdown, compareAdapters, COMPARISONS, adapterCost
};
