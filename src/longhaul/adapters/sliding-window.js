'use strict';
// sliding-window (benchmark spec §7): the last N estimated tokens before
// askAtSeq, any sender. The naive baseline. By default N is the most
// kl-recall can show at the same budget: recalled budget plus tail budget.
// full-history is this adapter with a 128K window (full-history.js).
const { estimateTokens } = require('../session-format');
const { TAIL_DEFAULTS, measured, newestFirst } = require('./common');

function createSlidingWindowAdapter({ budgetTokens = 6000, windowTokens = null, name = 'sliding-window' } = {}) {
  const limit = windowTokens ?? budgetTokens + TAIL_DEFAULTS.tailTokens;
  return {
    name,
    describe() { return { name, windowTokens: limit }; },
    async prepare(session) { return { session }; },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const w = newestFirst(handle.session.index, { beforeSeq: askAtSeq, limit });
        return {
          text: w.text, evidenceSeqsShown: w.seqs, evidenceSeqsPartial: w.partial,
          estTokens: estimateTokens(w.text), cost: 0, truncated: w.truncated
        };
      });
    },
    async release() {}
  };
}

module.exports = { createSlidingWindowAdapter };
