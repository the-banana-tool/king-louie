'use strict';
// oracle (benchmark spec §7): the question's evidence messages plus the tail.
// The upper bound on answerability; it ignores the budget. Evidence listed
// at or after askAtSeq is never shown.
const { estimateTokens, renderMessages } = require('../session-format');
const { TAIL_DEFAULTS, measured, tailBefore } = require('./common');

function createOracleAdapter({ tailMessages = TAIL_DEFAULTS.tailMessages, tailTokens = TAIL_DEFAULTS.tailTokens } = {}) {
  return {
    name: 'oracle',
    describe() { return { name: 'oracle', tailMessages, tailTokens }; },
    async prepare(session) { return { session }; },
    async context(handle, { question, askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const evidence = (question.evidenceSeqs || [])
          .filter((s) => s < askAtSeq)
          .map((s) => index.get(s))
          .filter(Boolean);
        const bySeq = new Map();
        for (const m of [...evidence, ...tailBefore(index, askAtSeq, { tailMessages, tailTokens })]) bySeq.set(m.seq, m);
        const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        const text = renderMessages(ordered);
        return { text, evidenceSeqsShown: ordered.map((m) => m.seq), evidenceSeqsPartial: [], estTokens: estimateTokens(text), cost: 0 };
      });
    },
    async release() {}
  };
}

module.exports = { createOracleAdapter };
