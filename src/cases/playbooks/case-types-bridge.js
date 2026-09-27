// src/cases/playbooks/case-types-bridge.js
// C5's case-type registry (src/cases/case-types, program §4.11) when this
// build has it, else a stand-in with the same gating exports: registered
// sources only, no types. Only this static path is ever required; nothing
// derived from case data is.
const { createLogger } = require('../../logging');

const log = createLogger('cases/playbooks');

function loadRegistry() {
  try {
    return require('../case-types');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/case-types['"]/.test(String(err.message))) return null;
    throw err;
  }
}

function createStandIn() {
  const sources = [];
  return {
    present: false,
    knownCaseTypes: () => null,
    getCaseType: () => null,
    registerGatingSource(fn, { origin } = {}) {
      if (typeof fn !== 'function') throw new Error('registerGatingSource needs a function.');
      const entry = { fn, origin: origin || fn.name || `source-${sources.length + 1}` };
      sources.push(entry);
      return () => {
        const i = sources.indexOf(entry);
        if (i !== -1) sources.splice(i, 1);
      };
    },
    gatingQuestionsFor(runtime, id) {
      const meta = runtime.getCase(id);
      const out = [];
      for (const source of sources) {
        try {
          for (const q of source.fn(runtime, meta.id) || []) out.push({ ...q, origin: q.origin || source.origin });
        } catch (err) {
          log.warn(`Gating source ${source.origin} failed on case ${meta.slug}: ${err.message}`);
        }
      }
      return out;
    }
  };
}

let cached = null;

// { present, knownCaseTypes() → string[] | null, getCaseType(type),
//   registerGatingSource(fn, { origin }) → unregister, gatingQuestionsFor(runtime, id) }
function caseTypes() {
  if (cached) return cached;
  const real = loadRegistry();
  cached = real
    ? {
      present: true,
      knownCaseTypes: () => real.knownCaseTypes(),
      getCaseType: (type) => real.getCaseType(type),
      registerGatingSource: (fn, opts) => real.registerGatingSource(fn, opts),
      gatingQuestionsFor: (runtime, id) => real.gatingQuestionsFor(runtime, id)
    }
    : createStandIn();
  return cached;
}

module.exports = { caseTypes, createStandIn };
