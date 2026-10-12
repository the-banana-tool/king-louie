'use strict';
// no-context (benchmark spec §7, addendum 2026-10-12): nothing from the
// session, no tail and no recall; the answer model gets the question alone.
// The floor: evidence recall is 0 by construction, and an answerable
// question the judge still marks correct here is flagged
// answerableWithoutEvidence (scoring.js floorFrom), since it does not
// measure memory. It needs no model for its context, so it runs in
// evidence-only runs too, and its answer and judge calls are priced by the
// plan like any adapter's.
//
// It is the one adapter with an answer prompt of its own (answerPrompt,
// answer-stage.js answerPromptFor): answer-v1.md tells the model to decline
// when the context lacks the answer, which would make the floor measure
// disobedience. answer-no-context-v1.md says there is no context and asks
// for the model's best answer from general knowledge. describe() carries the
// prompt's hash, so the series (cfg:) and the answer cache key change with
// the prompt, and no other adapter's identity does.
const { measured } = require('./common');
const { loadPrompt } = require('../prompts');

const NO_CONTEXT = 'no-context';

function createNoContextAdapter({ answerPrompt = loadPrompt('answerNoContext') } = {}) {
  const describe = () => ({ name: NO_CONTEXT, answerPrompt: answerPrompt.file, answerPromptSha256: answerPrompt.sha256 });
  return {
    name: NO_CONTEXT,
    answerPrompt,
    describe,
    async prepare(session) { return { session }; },
    async context() {
      return measured(async () => ({ text: '', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 0, cost: 0 }));
    },
    async release() {}
  };
}

module.exports = { NO_CONTEXT, createNoContextAdapter };
