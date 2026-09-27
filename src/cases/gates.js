// src/cases/gates.js
// Pure gate functions (spec §7). No I/O: callers pass materialized facts.
const { norm } = require('./jsonl');
const { valueMatchers, matchSpans, isRecipient, foldText, escapeRe } = require('./executors/normalize');
const { detect, sentenceRanges, sentenceOf } = require('./outbound');
const { EXECUTOR_SETTINGS_DEFAULTS } = require('./executors/defaults');
const { valueText, DAY_PATTERN } = require('./executors/util');
const { neutralize, oneLine: frameOneLine } = require('./playbooks/frame');

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

// ---- Outbound gate (cases stage 3 spec §3.7, program §4.9, R38) ----

const GATE_REASONS = Object.freeze([
  'bad-reference', 'superseded', 'inferred', 'unknown', 'non-disclosable', 'not-in-envelope',
  'category-keyword', 'unsourced-constraint', 'non-disclosable-entity'
]);
const REF_RE = /\{\{\s*(f-\d{4,})\s*\}\}/g;
// Anything brace-wrapped: scanned on the folded text, so a look-alike
// ("{{F-0005}}", "{{f-005}}", full-width braces) is reported, not sent.
const LOOSE_REF_RE = /\{\{[^}]*\}\}/g;
const RENDERABLE = new Set(['user', 'sourced', 'external-agent']);
// external-agent facts never back a constraint (parent §7.2, R40).
const BACKING = new Set(['user', 'sourced']);
const SENSITIVE = ['personal', 'financial', 'legal', 'health'];
// An envelope's intent and rules count as approved wording only once the
// owner approved them.
const APPROVED_STATUSES = new Set(['active', 'expired', 'exhausted']);

const isFact = (f) => Boolean(f) && typeof f === 'object';

function refProblem(fact, envelope) {
  if (!fact) return { reason: 'bad-reference', detail: 'no such fact' };
  if (fact.status === 'superseded') return { reason: 'superseded', detail: `superseded by ${fact.supersededBy}` };
  if (fact.status !== 'active') return { reason: 'bad-reference', detail: `the fact is ${fact.status}` };
  if (fact.provenance === 'inferred') return { reason: 'inferred', detail: 'inferred facts never leave' };
  if (fact.provenance === 'unknown') return { reason: 'unknown', detail: 'an open unknown has no value to send' };
  if (!RENDERABLE.has(fact.provenance)) return { reason: 'bad-reference', detail: `provenance ${fact.provenance}` };
  if (!fact.disclosable) return { reason: 'non-disclosable', detail: 'the owner has not made it disclosable' };
  if (envelope && !(envelope.facts || []).includes(fact.id)) return { reason: 'not-in-envelope', detail: 'not in the approved envelope' };
  return null;
}

// Each ref records its span in the input (start, end) and in `rendered`
// (renderedStart, renderedEnd), so the gate can scan what actually leaves.
function renderFactRefs(text, facts, { envelope = null } = {}) {
  const s = String(text ?? '');
  const map = facts instanceof Map ? facts : new Map();
  const blocked = [];
  const refs = [];
  let rendered = '';
  let last = 0;
  const re = new RegExp(REF_RE.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const [whole, id] = m;
    const start = m.index;
    const end = start + whole.length;
    const raw = map.get(id);
    const fact = isFact(raw) ? raw : null;
    const problem = refProblem(fact, envelope);
    let out = whole;
    if (problem) {
      blocked.push({ span: { start, end, text: whole }, reason: problem.reason, factId: id, detail: problem.detail });
    } else {
      const v = valueText(fact.value);
      out = fact.unit ? `${v} ${fact.unit}` : v;
    }
    rendered += s.slice(last, start);
    const renderedStart = rendered.length;
    rendered += out;
    refs.push({ start, end, renderedStart, renderedEnd: rendered.length, id, fact, ok: !problem });
    last = end;
  }
  rendered += s.slice(last);
  for (const sp of matchSpans(s, [{ re: new RegExp(LOOSE_REF_RE.source, 'g') }])) {
    if (refs.some((r) => r.start === sp.start && r.end === sp.end)) continue;
    blocked.push({ span: sp, reason: 'bad-reference', detail: 'not a fact reference; write {{f-NNNN}}' });
  }
  blocked.sort((a, b) => a.span.start - b.span.start);
  return { rendered, blocked, refs };
}

// Maps a [start, end) span of `rendered` back to the input text. A bound
// inside a ref's output widens to the whole ref.
function renderedToInput(refs, start, end) {
  const map = (p, isEnd) => {
    let delta = 0;
    for (const r of refs) {
      const inside = isEnd ? r.renderedStart < p && p <= r.renderedEnd : r.renderedStart <= p && p < r.renderedEnd;
      if (inside) return isEnd ? r.end : r.start;
      if (r.renderedEnd <= p) delta += (r.end - r.start) - (r.renderedEnd - r.renderedStart);
    }
    return p + delta;
  };
  return { start: map(start, false), end: map(end, true) };
}

function spanMatchesValue(sp, value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((v) => {
    if (v === null || v === undefined || typeof v === 'boolean') return false;
    if (sp.kind === 'price') {
      const str = String(v).replace(/[$,\s]/g, '');
      const n = typeof v === 'number' ? v : (str === '' ? NaN : Number(str));
      return Number.isFinite(n) && n === sp.value;
    }
    if (sp.kind === 'date') {
      const s = String(v);
      if (!DAY_PATTERN.test(s)) return false;
      return sp.value.startsWith('--') ? s.slice(5) === sp.value.slice(2) : s === sp.value;
    }
    return false;
  });
}

// matchSpans scans the folded text, so full-width letters or zero-width
// characters cannot hide a keyword, and reports original spans. Words join
// on any run of space, hyphen or underscore (or nothing: a zero-width
// character the fold removed may be all that split them); the last word
// may be plural ("salaries", "mortgages").
function keywordSpans(text, keyword) {
  const words = String(keyword).split(' ').filter(Boolean);
  if (!words.length) return [];
  const parts = words.map((w, i) => {
    if (i < words.length - 1) return escapeRe(w);
    if (/[^aeiou]y$/.test(w)) return `${escapeRe(w.slice(0, -1))}(?:y|ies)`;
    return `${escapeRe(w)}(?:e?s)?`;
  });
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s\\-_]*')}(?![\\p{L}\\p{N}])`, 'giu');
  return matchSpans(text, [{ re }]);
}

// Whole-word, exact-phrase occurrences (approved wording).
function phraseSpans(text, phrase) {
  const p = String(phrase).trim();
  if (!p) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  return matchSpans(text, [{ re }]);
}

function validEntitySpan(sp, text) {
  return Boolean(sp) && Number.isInteger(sp.start) && Number.isInteger(sp.end)
    && sp.start >= 0 && sp.end > sp.start && sp.end <= text.length;
}

function outboundGate({
  payloadText, recipients = [], envelope = null, facts = new Map(), mode = 'message', entitySpans = [], categoryKeywords = null
} = {}) {
  const text = String(payloadText ?? '');
  const factMap = facts instanceof Map ? facts : new Map();
  const all = [...factMap.values()].filter(isFact);
  const refs = renderFactRefs(text, factMap, { envelope });
  const rendered = refs.rendered;
  const blocked = [...refs.blocked];
  const add = (span, reason, detail, factId = null) => blocked.push({
    span: { start: span.start, end: span.end, text: span.text }, reason, ...(factId ? { factId } : {}), detail
  });

  // Rules 1–4 read the text with reference spans blanked (offsets unchanged).
  let masked = text;
  for (const r of refs.refs) masked = masked.slice(0, r.start) + ' '.repeat(r.end - r.start) + masked.slice(r.end);
  const approved = envelope && APPROVED_STATUSES.has(envelope.status)
    ? foldText([envelope.intent, ...(envelope.rules || [])].join('\n'))
    : '';
  const isApproved = (spanText) => Boolean(approved) && phraseSpans(approved, foldText(spanText)).length > 0;

  // Rule 1: fact values, both modes. Scanned twice: the masked input, and
  // the rendered text that actually leaves, so a value spliced together
  // around a reference ("1,{{f-0021}},000") is caught. A rendered hit that
  // lies entirely inside one reference's own output is that reference.
  const valueFacts = all.filter((f) => f.provenance !== 'unknown' && f.status !== 'retracted');
  const hits = new Map();
  const addHit = (span, scanned, f) => {
    const key = `${span.start}:${span.end}`;
    if (!hits.has(key)) hits.set(key, { span, scanned, facts: new Set() });
    hits.get(key).facts.add(f);
  };
  const scanValues = (scanText, toInput) => {
    const record = (sp, f) => {
      const at = toInput(sp);
      if (at) addHit({ ...at, text: text.slice(at.start, at.end) }, scanText.slice(sp.start, sp.end), f);
    };
    for (const f of valueFacts) {
      for (const sp of matchSpans(scanText, valueMatchers(f.value, f.unit))) record(sp, f);
    }
    // Other written forms of a date or price ("Nov 14, 2026", "$1.25M").
    for (const sp of detect(scanText)) {
      if (sp.kind !== 'date' && sp.kind !== 'price') continue;
      for (const f of valueFacts) if (spanMatchesValue(sp, f.value)) record(sp, f);
    }
  };
  scanValues(masked, (sp) => ({ start: sp.start, end: sp.end }));
  if (refs.refs.length) {
    scanValues(rendered, (sp) => {
      const own = refs.refs.some((r) => r.renderedEnd > r.renderedStart && r.renderedStart <= sp.start && sp.end <= r.renderedEnd);
      return own ? null : renderedToInput(refs.refs, sp.start, sp.end);
    });
  }
  // One report per value: drop a fact from a hit that sits inside another
  // hit for the same fact ("1,250,000" inside "$1,250,000").
  const hitList = [...hits.values()];
  for (const h of hitList) {
    for (const f of [...h.facts]) {
      if (hitList.some((o) => o !== h && o.facts.has(f) && o.span.start <= h.span.start && h.span.end <= o.span.end)) h.facts.delete(f);
    }
  }
  for (const { span, scanned, facts: set } of hitList) {
    if (!set.size) continue;
    if (isRecipient(scanned, recipients)) continue;
    const matched = [...set];
    const live = matched.filter((f) => f.status === 'active');
    const open = live.filter((f) => RENDERABLE.has(f.provenance) && f.disclosable);
    if (open.length) {
      if (envelope && !open.some((f) => (envelope.facts || []).includes(f.id))) {
        add(span, 'not-in-envelope', `the value of ${open[0].id} is not in the approved envelope`, open[0].id);
      }
      continue;
    }
    const priv = live.find((f) => !f.disclosable && f.provenance !== 'inferred');
    if (priv) {
      add(span, 'non-disclosable', `the value of ${priv.id}, which is not disclosable`, priv.id);
      continue;
    }
    const inf = live.find((f) => f.provenance === 'inferred');
    if (inf) {
      add(span, 'inferred', `the value of ${inf.id}, which is inferred`, inf.id);
      continue;
    }
    const old = matched.find((f) => f.status === 'superseded');
    if (old) add(span, 'superseded', `the value of ${old.id}, superseded by ${old.supersededBy}`, old.id);
  }

  if (mode === 'message') {
    // Rule 2: category keywords while the case holds a private fact of that category.
    const keywords = categoryKeywords || EXECUTOR_SETTINGS_DEFAULTS.outbound.categoryKeywords;
    const categories = new Set(all
      .filter((f) => f.status === 'active' && !f.disclosable && SENSITIVE.includes(f.category))
      .map((f) => f.category));
    for (const cat of categories) {
      for (const kw of keywords[cat] || []) {
        const k = foldText(kw);
        if (!k || (approved && keywordSpans(approved, k).length)) continue;
        for (const sp of keywordSpans(masked, k)) add(sp, 'category-keyword', `${cat} keyword "${kw}"`);
      }
    }

    // Rule 3: dates and prices need a backing fact or approved wording;
    // deadlines and commitments need a backed value in their own sentence.
    const backing = all.filter((f) => f.status === 'active' && f.disclosable && BACKING.has(f.provenance));
    const sentences = sentenceRanges(masked);
    const backedSentences = new Set();
    for (const r of refs.refs) {
      if (r.ok && BACKING.has(r.fact.provenance)) backedSentences.add(sentenceOf(sentences, r.start));
    }
    const spans = detect(masked);
    // A bare scaled number ("40m", "3 million") is not a price constraint.
    for (const sp of spans.filter((s) => s.kind === 'date' || (s.kind === 'price' && !s.bare))) {
      if (backing.some((f) => spanMatchesValue(sp, f.value)) || isApproved(sp.text)) {
        backedSentences.add(sp.sentence);
        continue;
      }
      add(sp, 'unsourced-constraint', `${sp.kind} "${sp.text}" is not backed by a user or sourced fact`);
    }
    for (const sp of spans.filter((s) => s.kind === 'deadline' || s.kind === 'commitment')) {
      if (backedSentences.has(sp.sentence) || isApproved(sp.text)) continue;
      add(sp, 'unsourced-constraint', `${sp.kind} "${sp.text}" has no backed value in its sentence`);
    }
  }

  // Rule 4: entity spans (C7), exempt when they name this send's recipient.
  // The span's text is read from the payload, never taken from the index.
  // A malformed list or span blocks the whole text: fail closed.
  const whole = { start: 0, end: text.length, text };
  if (!Array.isArray(entitySpans)) {
    add(whole, 'non-disclosable-entity', 'the entity spans are not a list');
  } else {
    for (const e of entitySpans) {
      const sp = e && e.span;
      if (!validEntitySpan(sp, text)) {
        add(whole, 'non-disclosable-entity', 'a malformed entity span');
        continue;
      }
      const at = { start: sp.start, end: sp.end, text: text.slice(sp.start, sp.end) };
      if (isRecipient(at.text, recipients)) continue;
      add(at, 'non-disclosable-entity', `${e.entity || 'entity'}: ${e.reason || 'not disclosable'}`);
    }
  }

  blocked.sort((a, b) => a.span.start - b.span.start);
  return { ok: blocked.length === 0, blocked, rendered };
}

// Every string leaf of a payload through outboundGate; number leaves and
// object keys through rule 1 only (ruling T3-keys). Senders send
// `rendered`, never the input.
function gateLeaves(payload, {
  recipients = [], envelope = null, facts = new Map(), mode = 'message', caseId = null, entityIndex = null, categoryKeywords = null
} = {}) {
  const blocked = [];
  const valuesOnly = (text, at) => {
    const r = outboundGate({ payloadText: text, recipients, envelope, facts, mode: 'query' });
    for (const b of r.blocked) blocked.push({ path: at, ...b });
  };
  const ancestors = new Set();
  const walk = (value, at) => {
    if (typeof value === 'string') {
      let entitySpans = [];
      if (entityIndex && typeof entityIndex.nonDisclosableSpans === 'function') {
        let problem = null;
        try {
          const out = entityIndex.nonDisclosableSpans(value, { caseId });
          if (Array.isArray(out)) entitySpans = out;
          else problem = 'the entity index did not return a list';
        } catch (err) {
          problem = `the entity index failed: ${err.message}`;
        }
        if (problem) blocked.push({ path: at, span: { start: 0, end: value.length, text: value }, reason: 'non-disclosable-entity', detail: problem });
      }
      const r = outboundGate({ payloadText: value, recipients, envelope, facts, mode, entitySpans, categoryKeywords });
      for (const b of r.blocked) blocked.push({ path: at, ...b });
      return r.rendered;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) valuesOnly(String(value), at);
      return value;
    }
    if (value && typeof value === 'object') {
      if (ancestors.has(value)) {
        blocked.push({ path: at, span: { start: 0, end: 0, text: '' }, reason: 'bad-reference', detail: 'the payload contains a cycle' });
        return null;
      }
      ancestors.add(value);
      let out;
      if (Array.isArray(value)) {
        out = value.map((v, i) => walk(v, `${at}[${i}]`));
      } else {
        out = {};
        for (const [k, v] of Object.entries(value)) {
          const path = at ? `${at}.${k}` : k;
          valuesOnly(k, path);
          out[k] = walk(v, path);
        }
      }
      ancestors.delete(value);
      return out;
    }
    return value;
  };
  const rendered = walk(payload, '');
  return { ok: blocked.length === 0, blocked, rendered };
}

module.exports = { recommendationGate, findDuplicates, outboundGate, gateLeaves, renderFactRefs, GATE_REASONS };

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

// A playbook gating record's text is third-party wording (ruling
// T12-similar): Ask's result names it by its key only.
function similarText(q) {
  if (q.payload?.type !== 'gating') return q.text;
  const key = typeof q.payload.gating?.key === 'string' ? q.payload.gating.key : '';
  return `${frameOneLine(neutralize(key), 80) || '(no key)'} (playbook question)`;
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
      .map((q) => ({ questionId: q.id, text: similarText(q) }));
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
