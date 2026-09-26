// tests/helpers/frame-check.js
// Asserts that every occurrence of a phrase sits inside a
// <playbook source="…"> … </playbook> frame (cases stage 6 spec §3.8).
//
// Independent of src/cases/playbooks/frame.js on purpose, so a gap in the
// frame's neutraliser cannot also blind the check. The text is read the way
// a model might read it: NFKD-folded (full-width and small "<" become "<",
// a "<" with a combining stroke becomes "<" plus a mark), combining marks,
// zero-width and other default-ignorable characters dropped, a small set of
// "<" look-alikes of its own, tags matched case-insensitively with
// whitespace (and the Braille blank) and attributes allowed. Any close-like
// tag ends a frame; only the canonical `<playbook source="` opener at the
// top level starts one.
const assert = require('node:assert');

const DROPPED_RE = /[\p{Default_Ignorable_Code_Point}\p{M}]/gu;
// "<", single guillemet, CJK and mathematical angle brackets, heavy angle
// quotation mark, modifier-letter "<". Kept apart from the neutraliser's
// own list on purpose.
const TAG_RE = /[<\u{2039}\u{3008}\u{2329}\u{27E8}\u{276E}\u{02C2}][\s\u{2800}]*(\/?)[\s\u{2800}]*playbook\b/giu;
const OPENER = '<playbook source="';

const fold = (text) => String(text).normalize('NFKD').replace(DROPPED_RE, '');

// Frames as [start, end) spans of the folded text, plus the problems a
// forged tag leaves: an open inside a frame, a close outside one, an open
// that never closes.
function scan(folded) {
  const spans = [];
  const problems = [];
  let start = -1;
  for (const m of folded.matchAll(TAG_RE)) {
    const closing = m[1] === '/';
    if (!closing) {
      if (start !== -1) problems.push(`a frame opens inside a frame at ${m.index}`);
      else if (folded.startsWith(OPENER, m.index)) start = m.index;
      else problems.push(`a non-canonical playbook tag at ${m.index}`);
    } else if (start === -1) {
      problems.push(`a close with no open frame at ${m.index}`);
    } else {
      spans.push([start, m.index]);
      start = -1;
    }
  }
  if (start !== -1) problems.push(`a frame opened at ${start} never closes`);
  return { spans, problems };
}

// Indexes (in the folded text) of every occurrence of needle outside a
// complete frame.
function outsideFrames(text, needle) {
  const s = fold(text);
  const { spans } = scan(s);
  const bad = [];
  let at = s.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    if (!spans.some(([a, b]) => a < at && end <= b)) bad.push(at);
    at = s.indexOf(needle, at + needle.length);
  }
  return bad;
}

function frameProblems(text) {
  return scan(fold(text)).problems;
}

function assertOnlyInsideFrames(text, needle, label = 'text') {
  const s = String(text);
  assert.ok(s.includes(needle), `${label} contains "${needle}"`);
  assert.deepStrictEqual(frameProblems(s), [], `${label}: a forged or unbalanced playbook tag`);
  assert.deepStrictEqual(outsideFrames(s, needle), [], `${label}: "${needle}" appears outside a playbook frame`);
}

module.exports = { outsideFrames, frameProblems, assertOnlyInsideFrames };
