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

// approval-v1 §5 (docs/protocol/approval-v1.md): the EXACT code point ranges
// the phones escape in every displayed string: Cc, Zl/Zp, Bidi_Control and
// Default_Ignorable_Code_Point as of Unicode 15.1. The phone apps carry the
// same table, so this one changes only with the protocol. The node uses it
// for what it signs for the phone (mobile-app-channel.js) and, below, for
// what it puts on an approval card.
const APPROVAL_HIDDEN_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], // Cc
  [0x2028, 0x2029], // Zl, Zp
  [0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], // Bidi_Control
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff] // Default_Ignorable_Code_Point
];
const inRanges = (ranges, cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
const isApprovalHidden = (cp) => inRanges(APPROVAL_HIDDEN_RANGES, cp);

// ---- One plain line ----
// What model- or ledger-written text must be before it is put on an owner
// approval card or a phone summary (executors/envelope.js). The card is
// shown with white-space: pre-wrap in a narrow column, so besides a real
// line break, anything that renders as a wide or invisible gap can start a
// visual line of its own and imitate a line the host wrote. Refused:
// - every code point of HIDDEN_RANGES and APPROVAL_HIDDEN_RANGES (controls,
//   tab and every line break included; U+E0000-U+E0FFF covers the
//   variation selector supplement U+E0100-U+E01EF), and the interlinear
//   annotation and object replacement characters U+FFF9-U+FFFC;
// - every space or blank that is not U+0020;
// - two or more U+0020 in a row;
// - more than PLAIN_LINE_MAX_COMBINING combining marks in a row.
const PLAIN_LINE_EXTRA_RANGES = [[0xfff9, 0xfffc]];
const BLANK_RANGES = [
  [0x00a0, 0x00a0], // no-break space
  [0x1680, 0x1680], // ogham space mark
  [0x2000, 0x200a], // en quad to hair space
  [0x202f, 0x202f], // narrow no-break space
  [0x205f, 0x205f], // medium mathematical space
  [0x2800, 0x2800], // braille pattern blank
  [0x3000, 0x3000] // ideographic space
];
const PLAIN_LINE_MAX_COMBINING = 3;
const COMBINING = /\p{M}/u;
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

// → null when `text` is one plain line, else why it is not.
function plainLineProblem(text) {
  if (typeof text !== 'string') return 'it is not text';
  let spaces = 0;
  let marks = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (inRanges(HIDDEN_RANGES, cp) || isApprovalHidden(cp) || inRanges(PLAIN_LINE_EXTRA_RANGES, cp)) {
      return `it has a line break or a hidden or control character (${hex(cp)})`;
    }
    if (inRanges(BLANK_RANGES, cp)) return `it has a space that is not a plain space (${hex(cp)})`;
    spaces = cp === 0x20 ? spaces + 1 : 0;
    if (spaces > 1) return 'it has two or more spaces in a row';
    marks = COMBINING.test(ch) ? marks + 1 : 0;
    if (marks > PLAIN_LINE_MAX_COMBINING) return `it has more than ${PLAIN_LINE_MAX_COMBINING} combining marks in a row`;
  }
  return null;
}

const isPlainLine = (text) => plainLineProblem(text) === null;

module.exports = {
  HIDDEN_RANGES, HIDDEN_CLASS, APPROVAL_HIDDEN_RANGES, isApprovalHidden, plainLineProblem, isPlainLine, PLAIN_LINE_MAX_COMBINING
};
