// src/cases/index.js
const { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot } = require('./case-runtime');
const { CaseStore } = require('./case-store');
const { FactLedger, LedgerError } = require('./ledger');
const { Brief, BriefError } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation } = require('./orientation');
const { recommendationGate, findDuplicates } = require('./gates');

module.exports = {
  CaseRuntime,
  CaseBusyError,
  CaseNotFoundError,
  resolveCasesRoot,
  CaseStore,
  FactLedger,
  LedgerError,
  Brief,
  BriefError,
  CaseRecords,
  buildOrientation,
  recommendationGate,
  findDuplicates
};
