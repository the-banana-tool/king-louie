'use strict';
// sliding-window (benchmark spec §7): the last N estimated tokens before
// askAtSeq, any sender. The naive baseline. By default N is the most
// kl-recall can show at the same budget: recalled budget plus tail budget.
const { estimateTokens, renderMessage } = require('../session-format');
const { TAIL_DEFAULTS, measured, uniqueSorted } = require('./common');

const CUT_MARKER_MAX = 40;

function createSlidingWindowAdapter({ budgetTokens = 6000, windowTokens = null } = {}) {
  const limit = windowTokens ?? budgetTokens + TAIL_DEFAULTS.tailTokens;
  return {
    name: 'sliding-window',
    describe() { return { name: 'sliding-window', windowTokens: limit }; },
    async prepare(session) { return { session }; },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const parts = [];
        const seqs = [];
        let used = 0;
        for (let seq = Math.min(askAtSeq - 1, index.maxSeq); seq >= 1; seq--) {
          const text = renderMessage(index.get(seq));
          const t = estimateTokens(`${text}\n\n`);
          if (used + t > limit) {
            if (parts.length === 0) {
              const keep = Math.max(0, limit * 4 - CUT_MARKER_MAX);
              parts.push(`[... earlier part of #${seq} cut]\n${text.slice(-keep)}`);
              seqs.push(seq);
            }
            break;
          }
          parts.push(text);
          seqs.push(seq);
          used += t;
        }
        const text = parts.reverse().join('\n\n');
        return { text, evidenceSeqsShown: uniqueSorted(seqs), estTokens: estimateTokens(text), cost: 0 };
      });
    },
    async release() {}
  };
}

module.exports = { createSlidingWindowAdapter };
