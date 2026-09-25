// src/cases/gates.js
// Pure gate functions (spec §7). No I/O: callers pass materialized facts.
const { norm } = require('./jsonl');
const { valueMatchers, matchSpans, isRecipient, foldText, escapeRe } = require('./executors/normalize');
const { detect, sentenceRanges, sentenceOf } = require('./outbound');
const { EXECUTOR_SETTINGS_DEFAULTS } = require('./executors/defaults');
const { valueText, DAY_PATTERN } = require('./executors/util');

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

function findDuplicates({ subject, attr, text = '', facts, otherCases = [] }) {
  const wanted = `${norm(subject)}|${norm(attr)}`;
  const words = tokens(text);
  const exact = [];
  for (const f of facts.values()) {
    if (f.status === 'active' && key(f) === wanted && f.provenance !== 'inferred') {
      exact.push({ caseId: null, caseTitle: null, id: f.id, stmt: f.stmt, provenance: f.provenance });
    }
  }
  const similar = [];
  for (const other of otherCases) {
    for (const f of other.facts.values()) {
      if (f.status !== 'active') continue;
      if (key(f) === wanted || jaccard(words, tokens(f.stmt)) >= 0.5) {
        similar.push({ caseId: other.caseId, caseTitle: other.title, id: f.id, stmt: f.stmt, provenance: f.provenance });
      }
    }
  }
  return { exact, similar };
}

// ---- Outbound gate (cases stage 3 spec §3.7, program §4.9, R38) ----

const GATE_REASONS = Object.freeze([
  'bad-reference', 'superseded', 'inferred', 'unknown', 'non-disclosable', 'not-in-envelope',
  'category-keyword', 'unsourced-constraint', 'non-disclosable-entity'
]);
const REF_RE = /\{\{\s*(f-\d{4,})\s*\}\}/g;
const RENDERABLE = new Set(['user', 'sourced', 'external-agent']);
// external-agent facts never back a constraint (parent §7.2, R40).
const BACKING = new Set(['user', 'sourced']);
const SENSITIVE = ['personal', 'financial', 'legal', 'health'];
// An envelope's intent and rules count as approved wording only once the
// owner approved them.
const APPROVED_STATUSES = new Set(['active', 'expired', 'exhausted']);

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

function renderFactRefs(text, facts, { envelope = null } = {}) {
  const s = String(text ?? '');
  const map = facts instanceof Map ? facts : new Map();
  const blocked = [];
  const refs = [];
  const rendered = s.replace(REF_RE, (whole, id, offset) => {
    const fact = map.get(id) || null;
    const problem = refProblem(fact, envelope);
    refs.push({ start: offset, end: offset + whole.length, id, fact, ok: !problem });
    if (problem) {
      blocked.push({ span: { start: offset, end: offset + whole.length, text: whole }, reason: problem.reason, factId: id, detail: problem.detail });
      return whole;
    }
    const v = valueText(fact.value);
    return fact.unit ? `${v} ${fact.unit}` : v;
  });
  return { rendered, blocked, refs };
}

function spanMatchesValue(sp, value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((v) => {
    if (sp.kind === 'price') {
      const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, ''));
      return Number.isFinite(n) && n === sp.value;
    }
    if (sp.kind === 'date') {
      const s = String(v ?? '');
      if (!DAY_PATTERN.test(s)) return false;
      return sp.value.startsWith('--') ? s.slice(5) === sp.value.slice(2) : s === sp.value;
    }
    return false;
  });
}

// matchSpans scans the folded text, so full-width letters or zero-width
// characters cannot hide a keyword, and reports original spans. \s* between
// words: a zero-width character the fold removed may be all that split them.
function keywordSpans(text, keyword) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(keyword).replace(/ /g, '\\s*')}(?![\\p{L}\\p{N}])`, 'giu');
  return matchSpans(text, [{ re }]);
}

function outboundGate({
  payloadText, recipients = [], envelope = null, facts = new Map(), mode = 'message', entitySpans = [], categoryKeywords = null
} = {}) {
  const text = String(payloadText ?? '');
  const factMap = facts instanceof Map ? facts : new Map();
  const all = [...factMap.values()];
  const refs = renderFactRefs(text, factMap, { envelope });
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
  const isApproved = (spanText) => Boolean(approved) && approved.includes(foldText(spanText));

  // Rule 1: fact values, both modes.
  const hits = new Map();
  for (const f of all) {
    if (f.provenance === 'unknown' || f.status === 'retracted') continue;
    for (const sp of matchSpans(masked, valueMatchers(f.value, f.unit))) {
      const key = `${sp.start}:${sp.end}`;
      if (!hits.has(key)) hits.set(key, { span: sp, facts: [] });
      hits.get(key).facts.push(f);
    }
  }
  for (const { span, facts: matched } of hits.values()) {
    if (isRecipient(span.text, recipients)) continue;
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
        if (!k || isApproved(k)) continue;
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
    for (const sp of spans.filter((s) => s.kind === 'date' || s.kind === 'price')) {
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
  for (const e of entitySpans || []) {
    const sp = e && e.span;
    if (!sp || !Number.isInteger(sp.start) || !Number.isInteger(sp.end)) continue;
    if (isRecipient(sp.text, recipients)) continue;
    add(sp, 'non-disclosable-entity', `${e.entity || 'entity'}: ${e.reason || 'not disclosable'}`);
  }

  blocked.sort((a, b) => a.span.start - b.span.start);
  return { ok: blocked.length === 0, blocked, rendered: refs.rendered };
}

// Every string leaf (never a key) of a payload through outboundGate.
// Senders send `rendered`, never the input.
function gateLeaves(payload, {
  recipients = [], envelope = null, facts = new Map(), mode = 'message', caseId = null, entityIndex = null, categoryKeywords = null
} = {}) {
  const blocked = [];
  const walk = (value, at) => {
    if (typeof value === 'string') {
      let entitySpans = [];
      if (entityIndex && typeof entityIndex.nonDisclosableSpans === 'function') {
        try {
          entitySpans = entityIndex.nonDisclosableSpans(value, { caseId }) || [];
        } catch (err) {
          blocked.push({
            path: at, span: { start: 0, end: value.length, text: value }, reason: 'non-disclosable-entity', detail: `the entity index failed: ${err.message}`
          });
        }
      }
      const r = outboundGate({ payloadText: value, recipients, envelope, facts, mode, entitySpans, categoryKeywords });
      for (const b of r.blocked) blocked.push({ path: at, ...b });
      return r.rendered;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${at}[${i}]`));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, at ? `${at}.${k}` : k);
      return out;
    }
    return value;
  };
  const rendered = walk(payload, '');
  return { ok: blocked.length === 0, blocked, rendered };
}

module.exports = { recommendationGate, findDuplicates, outboundGate, gateLeaves, renderFactRefs, GATE_REASONS };
