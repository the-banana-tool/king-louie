// src/cases/case-types/index.js
// The case-type registry (cases stage 5 spec §3.7, program §4.11). Types are
// code, required statically; `gatingQuestionsFor` is the one place gating
// questions are composed (the type's, then every registered source's).
const general = require('./general');
const outreach = require('./outreach');
const softwareRepo = require('./software-repo');
const { createLogger } = require('../../logging');

const log = createLogger('cases/case-types');

const TYPES = new Map([general, outreach, softwareRepo].map((t) => [t.type, t]));
const KNOWN = Object.freeze([...TYPES.keys()]);
const gatingSources = [];

class CaseTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseTypeError';
    this.code = 'UNKNOWN_CASE_TYPE';
  }
}

function knownCaseTypes() {
  return [...KNOWN];
}

function getCaseType(type) {
  return TYPES.get(type) || null;
}

// An unknown type on disk still opens, as general.
function resolveCaseType(type) {
  return TYPES.get(type) || general;
}

function assertKnownType(type) {
  if (!TYPES.has(type)) throw new CaseTypeError(`Unknown case type "${type}". Known types: ${KNOWN.join(', ')}.`);
  return type;
}

function briefFieldsFor(type) {
  const t = resolveCaseType(type);
  return typeof t.briefFields === 'function' ? t.briefFields() : [];
}

// The type that declares a brief field, or null.
function caseTypeForField(name) {
  for (const t of TYPES.values()) {
    if (typeof t.briefFields === 'function' && t.briefFields().some((f) => f.name === name)) return t.type;
  }
  return null;
}

// fn(runtime, id) → GatingQuestion[] (C6 playbooks). Returns an unregister function.
function registerGatingSource(fn, { origin } = {}) {
  if (typeof fn !== 'function') throw new Error('registerGatingSource needs a function.');
  const entry = { fn, origin: origin || fn.origin || fn.name || `source-${gatingSources.length + 1}` };
  gatingSources.push(entry);
  return () => {
    const i = gatingSources.indexOf(entry);
    if (i !== -1) gatingSources.splice(i, 1);
  };
}

// The type's questions, then each source's in registration order, each
// tagged with its origin. No merging: C6's syncGating merges by fact key.
function gatingQuestionsFor(runtime, id) {
  const meta = runtime.getCase(id);
  const t = resolveCaseType(meta.type);
  const out = t.gatingQuestions().map((q) => ({ ...q, origin: `case-type:${t.type}` }));
  for (const source of gatingSources) {
    try {
      for (const q of source.fn(runtime, meta.id) || []) out.push({ ...q, origin: q.origin || source.origin });
    } catch (err) {
      log.warn(`Gating source ${source.origin} failed on case ${meta.slug}: ${err.message}`);
    }
  }
  return out;
}

module.exports = {
  CaseTypeError,
  knownCaseTypes,
  getCaseType,
  resolveCaseType,
  assertKnownType,
  briefFieldsFor,
  caseTypeForField,
  registerGatingSource,
  gatingQuestionsFor
};
