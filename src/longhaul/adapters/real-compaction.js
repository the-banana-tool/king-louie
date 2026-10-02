'use strict';
// real-compaction (benchmark spec §7): what Claude Code actually had in
// front of it at a question. Only for sessions with recorded compactions
// (manifest.compactions, from the importer's isCompactSummary records); a
// session without any is skipped and listed in config.json. The context is
// the latest compaction summary before askAtSeq, then every message after it
// and before askAtSeq; a question asked before the first compaction gets the
// whole prefix. A window (128K estimated tokens by default, like
// full-history) cuts the oldest messages after the summary, and the summary
// always stays. The summary is not evidence: evidence it condensed counts as
// not shown, which is the loss this adapter measures, and answer accuracy
// says whether the summary kept the fact anyway (the compaction-loss study,
// spec §9, stage B4, builds on these records).
const { estimateTokens, renderMessage } = require('../session-format');
const { measured, newestFirst, capWindowWith } = require('./common');
const { FULL_HISTORY_TOKENS } = require('./full-history');

function createRealCompactionAdapter({ windowTokens = FULL_HISTORY_TOKENS } = {}) {
  return {
    name: 'real-compaction',
    longContext: true,
    skipReason: 'no recorded compactions',
    describe() { return { name: 'real-compaction', windowTokens }; },
    // The answer stage lowers the window to what the answer model holds (run.js contextCapTokens).
    capWindow: capWindowWith(createRealCompactionAdapter, windowTokens),
    appliesTo(session) {
      return Array.isArray(session.manifest.compactions) && session.manifest.compactions.length > 0;
    },
    async prepare(session) {
      const summaries = (session.manifest.compactions || []).map((c) => c.summarySeq).sort((a, b) => a - b);
      return { session, summaries };
    },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const summarySeq = handle.summaries.filter((s) => s < askAtSeq).at(-1) ?? null;
        const summary = summarySeq === null ? null : renderMessage(index.get(summarySeq));
        const limit = Math.max(0, windowTokens - (summary ? estimateTokens(`${summary}\n\n`) : 0));
        const w = newestFirst(index, { fromSeq: summarySeq === null ? 1 : summarySeq + 1, beforeSeq: askAtSeq, limit });
        const text = [summary, w.text].filter(Boolean).join('\n\n');
        return {
          text, evidenceSeqsShown: w.seqs, evidenceSeqsPartial: w.partial,
          estTokens: estimateTokens(text), cost: 0, truncated: w.truncated, compactionSeq: summarySeq
        };
      });
    },
    async release() {}
  };
}

module.exports = { createRealCompactionAdapter };
