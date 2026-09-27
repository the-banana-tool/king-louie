// src/cases/entities/fold.js
// The alphanumeric stream the entity index matches ids, phone numbers and
// emails against (cases stage 7 spec §3.6; fix-T7-r1 I2, m2). Every code
// point of the text is one of:
// - skipped: hidden characters (src/cases/hidden-chars.js) and combining
//   marks (\p{Mn}, \p{Me}) are transparent, so `00` + U+0303 + `42` reads
//   `0042`;
// - a symbol: an ASCII letter or digit (letters upper-cased), after
//   - compatibility decomposition with marks dropped (fullwidth, math
//     bold/italic/monospace, superscript, subscript and circled forms, and
//     accented Latin letters, so `①` reads `1` and `⑩` reads `10`),
//   - any decimal digit (\p{Nd}) by its numeric value (Devanagari, Arabic-
//     Indic, Bengali, Thai, ...),
//   - the Cyrillic and Greek capitals and small letters that look like Latin
//     ones (CONFUSABLE_LATIN below; e.g. Cyrillic А В Е К М Н О Р С Т У Х,
//     Greek Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ); any other letter or digit is a
//     symbol that matches no key;
// - a separator: any punctuation, symbol or space (\p{P}, \p{S}, \p{Z},
//   \s), counted towards the gap between two units;
// - a break: anything else (e.g. an unpaired surrogate or a control not in
//   the hidden set).
// Units are maximal runs of symbols of one class (digits, Latin letters,
// other), so a letter/digit transition is a unit boundary: `Loan0042` holds
// the unit `0042`. Units chain when at most MAX_GAP separators and no break
// lie between them (adjacent units always chain). The index matches a key
// against the concatenation of a chain of units, starting and ending on a
// unit boundary.
//
// HTML entities (`&#48;`) and %-escapes are not decoded: no outbound channel
// on main renders HTML, and the executor query gate decodes %-escapes itself
// before it asks the index (fix-T7-r1 m7).
const { HIDDEN_CLASS } = require('../hidden-chars');

const MAX_GAP = 3;
const SKIP = 0;
const SYM = 1;
const SEP = 2;
const BREAK = 3;
const OTHER = 1; // symbol code of a letter or digit with no ASCII reading
const CLASS_DIGIT = 0;
const CLASS_LATIN = 1;
const CLASS_OTHER = 2;

const HIDDEN_ONE = new RegExp(`^[${HIDDEN_CLASS}]$`, 'u');
const MARK_ONE = /^[\p{Mn}\p{Me}]$/u;
const MARKS = /[\p{Mn}\p{Me}]/gu;
const ND_ONE = /^\p{Nd}$/u;
const ALNUM_ONE = /^[\p{L}\p{N}]$/u;
const SEP_ONE = /^[\p{P}\p{S}\p{Z}\s]$/u;
const ASCII_ALNUM = /^[A-Za-z0-9]+$/;

// Separators an email may carry between its units (whitespace too), and the
// at signs one of which it must carry.
const EMAIL_SEPS = new Set([
  0x2e, 0x40, 0x2d, 0x5f, 0x2b, 0x25, // . @ - _ + %
  0xff20, 0xfe6b, 0xff0e, 0xff0d, 0xff3f, 0x2024 // fullwidth @, small @, fullwidth . - _, one dot leader
]);
const AT_SIGNS = new Set([0x40, 0xff20, 0xfe6b]);

// Code point → Latin letter it is read as.
const CONFUSABLE_LATIN = new Map([
  // Cyrillic capitals
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041a, 'K'], [0x041c, 'M'], [0x041d, 'H'], [0x041e, 'O'],
  [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'], [0x0423, 'Y'], [0x0425, 'X'], [0x0406, 'I'], [0x0408, 'J'],
  [0x0405, 'S'], [0x04ae, 'Y'], [0x04c0, 'I'],
  // Cyrillic small letters
  [0x0430, 'A'], [0x0432, 'B'], [0x0435, 'E'], [0x043a, 'K'], [0x043c, 'M'], [0x043d, 'H'], [0x043e, 'O'],
  [0x0440, 'P'], [0x0441, 'C'], [0x0442, 'T'], [0x0443, 'Y'], [0x0445, 'X'], [0x0456, 'I'], [0x0458, 'J'],
  [0x0455, 'S'], [0x0501, 'D'], [0x051b, 'Q'], [0x051d, 'W'],
  // Greek capitals
  [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'], [0x0399, 'I'], [0x039a, 'K'],
  [0x039c, 'M'], [0x039d, 'N'], [0x039f, 'O'], [0x03a1, 'P'], [0x03a4, 'T'], [0x03a5, 'Y'], [0x03a7, 'X'],
  // Greek small letters
  [0x03b1, 'A'], [0x03b9, 'I'], [0x03ba, 'K'], [0x03bd, 'V'], [0x03bf, 'O'], [0x03c1, 'P'], [0x03c4, 'T'],
  [0x03c5, 'Y'], [0x03c7, 'X']
]);

// The value of a decimal digit: Unicode assigns \p{Nd} in contiguous runs
// of ten, zero first, so it is the distance from the start of its run.
function ndValue(cp) {
  let k = 0;
  while (k < 100 && ND_ONE.test(String.fromCodePoint(cp - k - 1))) k += 1;
  return k % 10;
}

const cache = new Map();
function classifySlow(cp) {
  const ch = String.fromCodePoint(cp);
  if (HIDDEN_ONE.test(ch) || MARK_ONE.test(ch)) return { kind: SKIP };
  const decomposed = ch.normalize('NFKD').replace(MARKS, '');
  if (ASCII_ALNUM.test(decomposed)) return { kind: SYM, out: decomposed.toUpperCase() };
  if (ND_ONE.test(ch)) return { kind: SYM, out: String(ndValue(cp)) };
  if (CONFUSABLE_LATIN.has(cp)) return { kind: SYM, out: CONFUSABLE_LATIN.get(cp) };
  if (ALNUM_ONE.test(ch)) return { kind: SYM, out: String.fromCharCode(OTHER) };
  if (SEP_ONE.test(ch)) return { kind: SEP, email: EMAIL_SEPS.has(cp) || /^\s$/u.test(ch), at: AT_SIGNS.has(cp) };
  return { kind: BREAK };
}

function classify(cp) {
  let c = cache.get(cp);
  if (!c) {
    c = Object.freeze(classifySlow(cp));
    if (cache.size < 65536) cache.set(cp, c);
  }
  return c;
}

const charClass = (code) => (code >= 0x30 && code <= 0x39 ? CLASS_DIGIT : code >= 0x41 && code <= 0x5a ? CLASS_LATIN : CLASS_OTHER);

// → { sym, oStart, oEnd, uStart, uEnd, uLinked, uGapBad, uGapAt }: the
// symbol codes, each symbol's code-unit span in `s`, and per unit its first
// and past-last symbol, whether it chains to the unit before, whether the
// gap before it holds a separator an email cannot carry, and whether it
// holds an at sign.
function streamView(s) {
  const sym = [];
  const oStart = [];
  const oEnd = [];
  const uStart = [];
  const uEnd = [];
  const uLinked = [];
  const uGapBad = [];
  const uGapAt = [];
  let inUnit = false;
  let cur = -1;
  let gap = 0;
  let broken = true;
  let gapBad = false;
  let gapAt = false;
  const close = () => {
    uEnd.push(sym.length);
    inUnit = false;
  };
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;
    const c = classify(cp);
    if (c.kind === SYM) {
      for (let k = 0; k < c.out.length; k++) {
        const code = c.out.charCodeAt(k);
        const cls = charClass(code);
        if (!inUnit || cls !== cur) {
          const adjacent = inUnit;
          if (inUnit) close();
          uStart.push(sym.length);
          uLinked.push(adjacent || (!broken && gap <= MAX_GAP));
          uGapBad.push(!adjacent && gapBad);
          uGapAt.push(!adjacent && gapAt);
          inUnit = true;
          cur = cls;
          gap = 0;
          broken = false;
          gapBad = false;
          gapAt = false;
        }
        sym.push(code);
        oStart.push(i);
        oEnd.push(i + w);
      }
    } else if (c.kind === SEP) {
      if (inUnit) close();
      gap += 1;
      if (!c.email) gapBad = true;
      if (c.at) gapAt = true;
    } else if (c.kind === BREAK) {
      if (inUnit) close();
      broken = true;
    }
    i += w;
  }
  if (inUnit) close();
  return { sym, oStart, oEnd, uStart, uEnd, uLinked, uGapBad, uGapAt };
}

// A key's value as the stream spells it (separators and skipped characters
// dropped), or null when it holds a character no stream symbol can equal.
function canonStream(value) {
  let out = '';
  for (const ch of String(value)) {
    const c = classify(ch.codePointAt(0));
    if (c.kind === BREAK) return null;
    if (c.kind !== SYM) continue;
    if (c.out.includes(String.fromCharCode(OTHER))) return null;
    out += c.out;
  }
  return out;
}

module.exports = { streamView, canonStream, MAX_GAP, CONFUSABLE_LATIN };
