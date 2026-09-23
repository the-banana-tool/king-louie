// src/cases/gates.js
// Pure gate functions (spec §7). No I/O: callers pass materialized facts.
const norm = (v) => String(v ?? '').trim().toLowerCase();
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

module.exports = { recommendationGate, findDuplicates };
