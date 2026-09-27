// src/cases/hidden-chars.js
// The one set of hidden characters, shared by every module that either
// strips them (so a hidden character never survives into a key or a
// display string) or matches against them: C0/C1 controls other than line
// breaks and tabs, soft hyphen, combining grapheme joiner, Hangul fillers,
// Arabic letter mark, Mongolian vowel separator, zero-width characters,
// bidi embeddings, overrides and isolates, variation selectors, BOM and
// tag characters (cases stage 7 ruling M10; fix-T6-r1 M2).
//
// Built from code points (not typed as \u escapes) for two reasons: the
// ranges are auditable at a glance, and no invisible/control character
// ends up sitting in this source file. Originally defined in
// src/cases/ingest/store.js (Task 5); moved here so src/cases/entities/
// (Task 6) does not have to reach into src/cases/ingest/ for it, and
// store.js now re-exports it unchanged for its existing callers.
const HIDDEN_RANGES = [
  [0x0000, 0x0008], [0x000e, 0x001f], [0x007f, 0x009f],
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x115f], [0x1160, 0x1160], // Hangul fillers
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2069], // bidi isolates, word joiner
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // BOM
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f] // tag characters
];

// A regex class body (no enclosing []); use it with the u flag, since the
// tag-character range needs a code point above U+FFFF.
const HIDDEN_CLASS = HIDDEN_RANGES
  .map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`))
  .join('');

module.exports = { HIDDEN_RANGES, HIDDEN_CLASS };
