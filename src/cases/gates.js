// src/cases/gates.js
// Pure gate functions (spec §7). No I/O: callers pass materialized facts.
const { norm } = require('./jsonl');

const key = (f) => `${norm(f.subject)}|${norm(f.attr)}`;

function tokens(text) {
  return new Set(norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function recommendationGate({ status, claims, facts }) {
  if (status === 'draft') {
    return {
      ok: false,
      failures: [{ claim: null, reason: 'The brief gating pass is incomplete. Ask the owner what only they know, then call Brief with action "completeGating" before recommending.' }]
    };
  }
  if (!Array.isArray(claims) || claims.length === 0) {
    return { ok: false, failures: [{ claim: null, reason: 'A recommendation needs at least one claim.' }] };
  }

  const blockers = new Map();
  for (const f of facts.values()) {
    if (f.provenance === 'unknown' && f.status === 'active' && f.loadBearing) blockers.set(key(f), f);
  }

  const failures = [];
  for (const claim of claims) {
    if (claim.loadBearing === false) continue;
    const text = String(claim.text || '');
    const ids = Array.isArray(claim.factIds) ? claim.factIds : [];
    if (!ids.length) {
      failures.push({ claim: text, reason: 'cites no fact. Cite the facts it rests on, or mark it loadBearing: false if it is context only.' });
      continue;
    }
    for (const id of ids) {
      const f = facts.get(id);
      if (!f) {
        failures.push({ claim: text, reason: `cites ${id}, which does not exist.` });
      } else if (f.status !== 'active') {
        failures.push({ claim: text, reason: `cites ${id}, which is ${f.status}${f.supersededBy ? ` by ${f.supersededBy}` : ''}.` });
      } else if (f.provenance === 'inferred') {
        failures.push({ claim: text, reason: `rests on ${id}, which is inferred. Source it, or record it as an unknown and list it.` });
      } else if (f.provenance === 'unknown') {
        failures.push({ claim: text, reason: `rests on ${id}, which is an open unknown.` });
      } else if (blockers.has(key(f))) {
        const u = blockers.get(key(f));
        failures.push({ claim: text, reason: `is on ${f.subject}.${f.attr}, which has the open load-bearing unknown ${u.id} ("${u.stmt}"). Resolve it first.` });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

const privateStmt = (title) => `(private fact in "${title}" — open that case to see it)`;

// Exact: an active non-inferred fact on the same (subject, attr) in this
// case. Similar: cross-case index hits of kind `fact` with the same key or
// close wording. A redacted hit has no text, so it matches by key or by
// redactedClose (coverage and at least two matched tokens), and its row
// never carries the fact's words.
function findDuplicates({ subject, attr, text = '', facts, crossCaseHits = [] }) {
  const wanted = `${norm(subject)}|${norm(attr)}`;
  const words = tokens(text);
  const exact = [];
  for (const f of facts.values()) {
    if (f.status === 'active' && key(f) === wanted && f.provenance !== 'inferred') {
      exact.push({ caseId: null, caseTitle: null, id: f.id, stmt: f.stmt, provenance: f.provenance });
    }
  }
  const similar = [];
  for (const hit of crossCaseHits) {
    if (!hit || hit.kind !== 'fact') continue;
    const sameKey = key(hit) === wanted;
    const close = hit.redacted
      ? redactedClose(hit)
      : jaccard(words, tokens(hit.text)) >= 0.5;
    if (!sameKey && !close) continue;
    similar.push({
      caseId: hit.caseId,
      caseTitle: hit.title,
      id: hit.id,
      stmt: hit.redacted ? privateStmt(hit.title) : hit.text,
      provenance: hit.provenance
    });
  }
  return { exact, similar };
}

module.exports = { recommendationGate, findDuplicates };

// ---- Cases stage 5: duplicate gates ----
// docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §3.2

const { tokenSet } = require('./tokenize');

// A redacted cross-case hit counts as close only when it holds at least half
// of the query's distinct tokens AND at least two of them (the rule
// searchCases uses). One matched token would let a one-word probe confirm
// another case's private value (final review I2).
function redactedClose(hit) {
  return Number(hit.coverage) >= 0.5 && Number(hit.matched) >= 2;
}

// NFKC, drop format characters (zero-width, soft hyphen), lowercase, strip
// trailing ? ! and dots, turn other punctuation into a space, collapse
// whitespace. Shared by question text and case titles (identical normalization).
function normQuestion(s) {
  return String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
    .replace(/[?!.\s]+$/, '').replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Exact: an open question in this case with the same normalized text.
// Similar here: Jaccard >= 0.5, text shown. Elsewhere: open question hits
// from other cases, by title, id and case status only.
function findDuplicateQuestion({ text, openQuestions = [], crossCaseHits = [] }) {
  const wanted = normQuestion(text);
  const open = openQuestions.filter((q) => q && q.answer == null && !q.closed);
  const exact = open.find((q) => normQuestion(q.text) === wanted) || null;
  const words = tokens(text);
  const similar = exact
    ? []
    : open
      .filter((q) => jaccard(words, tokens(q.text)) >= 0.5)
      .map((q) => ({ questionId: q.id, text: q.text }));
  const elsewhere = [];
  for (const hit of crossCaseHits) {
    if (!hit || hit.kind !== 'question' || hit.attr !== 'open') continue;
    if (hit.redacted ? !redactedClose(hit) : Number(hit.coverage) < 0.5) continue;
    if (elsewhere.some((e) => e.caseId === hit.caseId && e.questionId === hit.id)) continue;
    elsewhere.push({ caseId: hit.caseId, caseTitle: hit.title, questionId: hit.id, status: hit.caseStatus });
  }
  return { exact, similar, elsewhere };
}

// Program §4.8, R36: non-terminal executor job states.
const LIVE_JOB_STATES = Object.freeze(['submitting', 'submitted', 'running', 'waiting']);

function normIntent(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// SHA-256 hex of the JSON of { e, k, r (sorted), i } in that key order.
function jobSignature(executorId, job = {}) {
  const recipients = [...(Array.isArray(job?.recipients) ? job.recipients : [])].map(String).sort();
  const body = JSON.stringify({ e: executorId, k: job?.kind || null, r: recipients, i: normIntent(job?.intent) });
  return require('crypto').createHash('sha256').update(body).digest('hex');
}

// The live row this job would duplicate, or null.
function findDuplicateJob({ executorId, job = {}, liveJobs = [] }) {
  const signature = job.signature || jobSignature(executorId, job);
  return (Array.isArray(liveJobs) ? liveJobs : []).find((r) => r
    && r.executorId === executorId
    && r.signature === signature
    && LIVE_JOB_STATES.includes(r.state)) || null;
}

const OPEN_CASE_STATUSES = Object.freeze(['draft', 'active', 'needs-direction', 'paused']);

// normTitle and normQuestion apply the same normalization; keep one function.
const normTitle = normQuestion;

// Exact: an open case with the same normalized title, or the same
// non-empty objective. Similar: Jaccard >= threshold on the titles, or on
// title + objective, whichever is higher.
function findSimilarCases({ title, objective = '', candidates = [], threshold = 0.6 }) {
  const t = normTitle(title);
  const o = normTitle(objective);
  const titleWords = tokenSet(title);
  const allWords = tokenSet(`${title || ''} ${objective || ''}`);
  const exact = [];
  const similar = [];
  for (const c of candidates) {
    if (!c || !OPEN_CASE_STATUSES.includes(c.status)) continue;
    const row = { caseId: c.caseId, title: c.title, status: c.status };
    if (normTitle(c.title) === t || (o && normTitle(c.objective) === o)) {
      exact.push({ ...row, match: 'exact' });
      continue;
    }
    const score = Math.max(
      jaccard(titleWords, tokenSet(c.title)),
      jaccard(allWords, tokenSet(`${c.title || ''} ${c.objective || ''}`))
    );
    if (score >= threshold) similar.push({ ...row, match: 'similar', score: Math.round(score * 1000) / 1000 });
  }
  similar.sort((a, b) => b.score - a.score);
  return { exact, similar };
}

Object.assign(module.exports, {
  findDuplicateQuestion,
  findDuplicateJob,
  findSimilarCases,
  jobSignature,
  normQuestion,
  normIntent,
  tokens,
  jaccard,
  LIVE_JOB_STATES,
  OPEN_CASE_STATUSES
});
