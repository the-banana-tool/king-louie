// src/cases/verify/evidence.js
// Cases stage 8 (spec §6.3): what may stand behind a `met` criterion. An
// evidence id is accepted only through the resolver for its prefix (`f-`
// the ledger; a later task adds `chk-` for check runs); an id with no
// resolver holds nothing. Evidence sources (what a turn wrote, for the
// verify pass) are registered here too.
const { norm } = require('../jsonl');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify-evidence');

// A fact of any of these alone may hold a criterion (R-C8-5); never
// `inferred`, never `unknown`.
const ELIGIBLE_PROVENANCE = Object.freeze(['user', 'sourced', 'external-agent']);
const PREFIX_RE = /^[A-Za-z]+-$/;
const MISSING = Object.freeze({ exists: false, holds: false, reason: 'evidence-missing' });
const missing = () => ({ ...MISSING });

const resolvers = new Map();
const sources = new Map();

// `fn(id, ctx) → { exists, holds, reason, provenance?, label? }`; `ctx` is
// whatever the caller of resolveEvidence passes. → a function that puts
// back what was registered before (tests).
function registerEvidenceResolver(prefix, fn) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) throw new Error('An evidence prefix is letters and one dash, like "f-".');
  if (typeof fn !== 'function') throw new Error('An evidence resolver is a function.');
  const before = resolvers.get(prefix);
  resolvers.set(prefix, fn);
  return () => {
    if (resolvers.get(prefix) !== fn) return;
    if (before) resolvers.set(prefix, before);
    else resolvers.delete(prefix);
  };
}

// Picks the resolver by the id's prefix, up to and including the first `-`.
// Never throws: a resolver that does holds nothing.
function resolveEvidence(id, ctx) {
  if (typeof id !== 'string') return missing();
  const dash = id.indexOf('-');
  const fn = dash > 0 ? resolvers.get(id.slice(0, dash + 1)) : null;
  if (!fn) return missing();
  try {
    const result = fn(id, ctx);
    if (!result || typeof result !== 'object') return missing();
    return result;
  } catch (err) {
    log.warn(`Evidence ${id} could not be resolved: ${err.message}`);
    return missing();
  }
}

// `fn(runtime, turn, evidence) → rows`, read by collectTurnEvidence.
function registerEvidenceSource(name, fn) {
  if (typeof name !== 'string' || !name) throw new Error('An evidence source has a name.');
  if (typeof fn !== 'function') throw new Error('An evidence source is a function.');
  const before = sources.get(name);
  sources.set(name, fn);
  return () => {
    if (sources.get(name) !== fn) return;
    if (before) sources.set(name, before);
    else sources.delete(name);
  };
}

const evidenceSources = () => [...sources.entries()].map(([name, fn]) => ({ name, fn }));

const factKey = (f) => `${norm(f.subject)}|${norm(f.attr)}`;

// `ctx.facts` is the ledger view's Map. Labels are ids and fixed words
// only: they are shown in notes and fix lines, where no case text belongs.
function resolveFact(id, ctx) {
  const facts = ctx && ctx.facts instanceof Map ? ctx.facts : null;
  const fact = facts ? facts.get(id) : null;
  if (!fact) return { exists: false, holds: false, reason: 'evidence-missing', label: `${id} is not in the ledger` };
  const base = { exists: true, provenance: fact.provenance ?? null, source: fact.source ?? null, sourceKind: fact.source?.kind ?? null };
  if (fact.status !== 'active') {
    const label = fact.status === 'superseded'
      ? `${id} was superseded${typeof fact.supersededBy === 'string' && fact.supersededBy ? ` by ${fact.supersededBy}` : ''}`
      : fact.status === 'retracted' ? `${id} was retracted` : `${id} is no longer active`;
    return { ...base, holds: false, reason: 'evidence-inactive', label };
  }
  if (!ELIGIBLE_PROVENANCE.includes(fact.provenance)) {
    const what = fact.provenance === 'unknown' ? 'an open unknown' : fact.provenance === 'inferred' ? 'inferred' : 'not a sourced fact';
    return { ...base, holds: false, reason: 'evidence-provenance', label: `${id} is ${what}` };
  }
  // The recommendation gate's `blockers` rule (gates.js): an active
  // load-bearing unknown on the same subject.attr.
  const key = factKey(fact);
  for (const other of facts.values()) {
    if (other.provenance === 'unknown' && other.status === 'active' && other.loadBearing && factKey(other) === key) {
      return { ...base, holds: false, reason: 'evidence-blocked', label: `${id} is under the open load-bearing unknown ${other.id}` };
    }
  }
  return { ...base, holds: true, reason: null, label: null };
}

registerEvidenceResolver('f-', resolveFact);

module.exports = {
  ELIGIBLE_PROVENANCE,
  registerEvidenceResolver,
  resolveEvidence,
  registerEvidenceSource,
  evidenceSources
};
