'use strict';
// no-context (benchmark spec §7, addendum 2026-10-12): nothing from the
// session, no tail and no recall; the answer model gets the question alone
// (answer.js NOTHING_SHOWN stands in for the context). The floor: evidence
// recall is 0 by construction, and an answerable question the judge still
// marks correct here is flagged answerableWithoutEvidence (scoring.js
// floorFrom), since it does not measure memory. It needs no model for its
// context, so it runs in evidence-only runs too, and its answer and judge
// calls are priced by the plan like any adapter's.
const { measured } = require('./common');

const NO_CONTEXT = 'no-context';

function createNoContextAdapter() {
  return {
    name: NO_CONTEXT,
    describe() { return { name: NO_CONTEXT }; },
    async prepare(session) { return { session }; },
    async context() {
      return measured(async () => ({ text: '', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 0, cost: 0 }));
    },
    async release() {}
  };
}

module.exports = { NO_CONTEXT, createNoContextAdapter };
