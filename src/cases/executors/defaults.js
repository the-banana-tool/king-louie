// src/cases/executors/defaults.js
// settings.executors (cases stage 3 spec §6), merged key by key.

const EXECUTOR_SETTINGS_DEFAULTS = Object.freeze({
  // Desktop only; in service mode entries come from the admin service.json (R42).
  entries: {},
  // '' means a number without a country code is refused.
  defaultCountryCode: '',
  pollEveryMs: 900000,
  submitTimeoutMs: 30000,
  requestTimeoutMs: 20000,
  refreshBudgetMs: 5000,
  maxPollErrors: 5,
  auditScanEntries: 5000,
  // Attempts per contact assumed by plan estimates when no payload says.
  attemptsDefault: 2,
  opsMemory: { maxEntries: 20 },
  outbound: {
    categoryKeywords: {
      personal: ['divorce', 'social security', 'ssn', 'date of birth', 'home address', 'maiden name', 'passport number'],
      financial: ['bank account', 'routing number', 'credit card', 'salary', 'income', 'debt', 'mortgage', 'payoff', 'floor price', 'lowest price', 'minimum price', 'reserve price', 'net worth'],
      legal: ['lawsuit', 'litigation', 'attorney', 'lawyer', 'court', 'lien', 'bankruptcy', 'settlement', 'probate'],
      health: ['diagnosis', 'illness', 'medical', 'hospital', 'medication', 'disability', 'pregnant', 'therapy']
    }
  }
});

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// `additiveKeywords`: category keywords from `source` only add to the base
// lists, never replace or empty them. Service mode sets it, because there
// the settings come from the service-writable data dir, which must never
// weaken the outbound gate.
function mergeExecutorSettings(base, source, { additiveKeywords = false } = {}) {
  const b = isObject(base) ? base : EXECUTOR_SETTINGS_DEFAULTS;
  const s = isObject(source) ? source : {};
  const keywords = {};
  for (const [k, v] of Object.entries(b.outbound?.categoryKeywords || {})) keywords[k] = [...v];
  const sourceKeywords = s.outbound?.categoryKeywords;
  if (isObject(sourceKeywords)) {
    for (const [k, v] of Object.entries(sourceKeywords)) {
      if (!Array.isArray(v)) continue;
      const added = v.map(String);
      keywords[k] = additiveKeywords ? [...new Set([...(keywords[k] || []), ...added])] : added;
    }
  }
  return {
    ...b,
    ...s,
    entries: isObject(s.entries) ? { ...s.entries } : { ...(b.entries || {}) },
    opsMemory: { ...(b.opsMemory || {}), ...(isObject(s.opsMemory) ? s.opsMemory : {}) },
    outbound: { ...(b.outbound || {}), ...(isObject(s.outbound) ? s.outbound : {}), categoryKeywords: keywords }
  };
}

function resolveExecutorSettings(raw, options = {}) {
  return mergeExecutorSettings(EXECUTOR_SETTINGS_DEFAULTS, raw, options);
}

module.exports = { EXECUTOR_SETTINGS_DEFAULTS, mergeExecutorSettings, resolveExecutorSettings };
