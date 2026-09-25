// src/cases/index.js
const { CaseRuntime, CaseBusyError, CaseNotFoundError, SimilarCaseError, resolveCasesRoot } = require('./case-runtime');
const { CrossCaseIndex } = require('./index-store');
const { CaseStore } = require('./case-store');
const { FactLedger, LedgerError } = require('./ledger');
const { Brief, BriefError } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation } = require('./orientation');
const {
  recommendationGate, findDuplicates, findDuplicateQuestion, findDuplicateJob, findSimilarCases, jobSignature
} = require('./gates');
const {
  getCaseType, knownCaseTypes, assertKnownType, gatingQuestionsFor, registerGatingSource
} = require('./case-types');

module.exports = {
  CaseRuntime,
  CaseBusyError,
  CaseNotFoundError,
  SimilarCaseError,
  CrossCaseIndex,
  resolveCasesRoot,
  CaseStore,
  FactLedger,
  LedgerError,
  Brief,
  BriefError,
  CaseRecords,
  buildOrientation,
  recommendationGate,
  findDuplicates,
  findDuplicateQuestion,
  findDuplicateJob,
  findSimilarCases,
  jobSignature,
  getCaseType,
  knownCaseTypes,
  assertKnownType,
  gatingQuestionsFor,
  registerGatingSource
};
