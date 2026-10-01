'use strict';
// full-history (benchmark spec §7, §8.1): every message before askAtSeq,
// newest first, cut at the window (128K estimated tokens by default, the
// frontier tier's cap), oldest first out. The long-context baseline. It runs
// only in the frontier tier (frontierOnly) and only on the
// --long-context-sample questions (longContext). A record's contextTruncated
// says the cap cut its prefix, a limitation the report states. Spec §7 says
// "all messages under askAtSeq that fit the model's window": the answer stage
// lowers the window to what the answer model holds (capWindow, run.js
// contextCapTokens), so an overflow never becomes a 400 recorded as an error.
const { createSlidingWindowAdapter } = require('./sliding-window');

const FULL_HISTORY_TOKENS = 128000;

function createFullHistoryAdapter({ windowTokens = FULL_HISTORY_TOKENS } = {}) {
  const base = createSlidingWindowAdapter({ windowTokens, name: 'full-history' });
  return {
    ...base, frontierOnly: true, longContext: true,
    capWindow: (tokens) => createFullHistoryAdapter({ windowTokens: Math.min(windowTokens, tokens) })
  };
}

module.exports = { FULL_HISTORY_TOKENS, createFullHistoryAdapter };
