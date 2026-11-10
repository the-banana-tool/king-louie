'use strict';
// The condensed windows of a session's real compactions (benchmark spec §9),
// read from manifest.compactions.
const { estimateTokens, messageText } = require('../session-format');

function summaryText(session, window) {
  return messageText(session.index.get(window.summarySeq));
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : null;
}

function compactionWindows(session) {
  const { manifest, index } = session;
  const compactions = [...(manifest.compactions || [])].sort((a, b) => a.summarySeq - b.summarySeq);
  const windows = [];
  const skipped = [];
  for (const c of compactions) {
    if (c.windowToSeq < c.windowFromSeq) {
      skipped.push({ summarySeq: c.summarySeq, reason: 'empty-window' });
      continue;
    }
    const windowTokens = index.tokensBetween(c.windowFromSeq - 1, c.windowToSeq + 1);
    const summaryTokens = estimateTokens(messageText(index.get(c.summarySeq)));
    const boundary = index.get(c.atSeq)?.meta?.compactBoundary;
    windows.push({
      index: windows.length,
      atSeq: c.atSeq,
      summarySeq: c.summarySeq,
      windowFromSeq: c.windowFromSeq,
      windowToSeq: c.windowToSeq,
      windowTokens,
      summaryTokens,
      ratio: summaryTokens === 0 ? null : windowTokens / summaryTokens,
      preTokens: tokenCount(boundary?.preTokens),
      postTokens: tokenCount(boundary?.postTokens)
    });
  }
  return { windows, skipped };
}

module.exports = { compactionWindows, summaryText };
