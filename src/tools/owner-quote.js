'use strict';

// The owner-quote check (browser acting actions, src/tools/browser-acting.js;
// the management tools' answer_question, src/mcp/case-tools.js): words must
// appear in a text on word boundaries, ignoring case, spacing and curly
// quotes. No requires: the case tool handler loads it on every surface.

function fold(text) {
  return String(text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when `words` (folded, non-empty) appear in `text` (folded) on word
// boundaries.
function wordsInText(words, text) {
  if (typeof words !== 'string' || typeof text !== 'string') return false;
  const w = fold(words);
  if (!w) return false;
  return new RegExp(`(^|\\W)${escapeRegExp(w)}(?=\\W|$)`).test(fold(text));
}

// The quote must appear in the owner's message on word boundaries, ignoring
// case, spacing and curly quotes. It proves only that the owner wrote those
// words this turn; that they are about this action is the model's claim.
function ownerQuoteInTurn(quote, ownerTurnText) {
  return wordsInText(quote, ownerTurnText);
}

module.exports = { fold, escapeRegExp, wordsInText, ownerQuoteInTurn };
