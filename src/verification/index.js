const {
  EvidenceLedger,
  LEDGER_VERSION,
  DEFAULT_MAX_AGE_DAYS,
  normalizeRoot
} = require('./evidence-ledger');
const {
  classifyCommand,
  classifySegment,
  scopeForArgs,
  VERIFY_PATTERNS
} = require('./command-classifier');
const {
  evaluate,
  isNonCodePath,
  filterVerifiablePaths,
  NON_CODE_EXTENSIONS,
  MAX_CHANGED_PATHS_IN_NUDGE
} = require('./verify-on-stop');

module.exports = {
  EvidenceLedger,
  LEDGER_VERSION,
  DEFAULT_MAX_AGE_DAYS,
  normalizeRoot,

  classifyCommand,
  classifySegment,
  scopeForArgs,
  VERIFY_PATTERNS,

  evaluateVerifyOnStop: evaluate,
  isNonCodePath,
  filterVerifiablePaths,
  NON_CODE_EXTENSIONS,
  MAX_CHANGED_PATHS_IN_NUDGE
};
