// src/models/placeholder-key.js
// Says when a provider key looks like a placeholder (settings redesign spec
// §5.5, §7.2): a hint only, never a block; cheap, local, and it says why.
// The answer is one of three fixed strings, or null: no part of the token is
// ever returned, logged or kept.

const COUNTING_RUNS = ['012345', '123456', '234567', '345678', '456789'];
const PLACEHOLDER_WORDS = /your|example|placeholder|xxxx|changeme|test-key/i;
const REPEATED_RUN = /(.)\1{7}/s;

function placeholderKeyHint(token) {
  if (typeof token !== 'string' || token === '') return null;
  if (COUNTING_RUNS.some((run) => token.includes(run))) return 'it contains a counting run of digits';
  if (PLACEHOLDER_WORDS.test(token)) return 'it contains placeholder words';
  if (REPEATED_RUN.test(token)) return 'it is mostly one repeated character';
  return null;
}

module.exports = { placeholderKeyHint };
