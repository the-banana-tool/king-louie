// src/gui/text-guard.js
// What the Type tool (and printable Key presses) may send (fleet stage 5
// spec §3.8). Checks run over `buffer + text`, where the buffer is what the
// lease typed where the caret now is, so a value spelled one call at a time
// is caught; the text alone is checked too, so a buffer cannot mask it.
//
// The buffer models what the keys did (security review finding 9, revised
// 2026-10-12; the spec's "reset on enter" is gone):
//   - a printable key or typed text is appended; enter is a line break;
//   - backspace removes the last character;
//   - after anything that moves the caret or edits in a way the guard cannot
//     follow (arrows, home, end, page keys, tab, delete, insert, escape,
//     function keys, every ctrl/alt/meta chord, a click, a drag) the text so
//     far is kept as a piece whose place in the field is unknown, and a new
//     piece starts. Text typed after that is checked as if it could land at
//     either end of, or inside, any earlier piece: a vault value that at
//     most JOIN_PIECES runs of the typed pieces can spell, one of them from
//     the new text, is refused, and so is an always_confirm command or a
//     secret pattern that the new piece completes at either end of an
//     earlier one.
// Residuals, known and not closed: a value assembled from more than
// JOIN_PIECES pieces; text the app itself adds, moves or completes
// (autocomplete, find and replace, macros, an input method, drag and drop of
// a selection); text that was in the field before the lease; patterns and
// always_confirm commands split into three or more pieces, or completed by a
// piece dropped into the middle of another. The pieces are kept through a
// suspension and its resume (second security review, finding 7: a pause
// does not empty the field); a new lease starts with none.
const { patternMatch, SHELL_SEPARATORS } = require('../execution/tool-patterns');

const MAX_TEXT = 2000;
const BUFFER_MAX = 2000;
// How many runs of typed pieces may spell a vault value before the guard
// stops following (see the residuals above).
const JOIN_PIECES = 4;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/
]);
// Control characters other than \n and \t (C0, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function isInvalidText(text) {
  if (typeof text !== 'string') return true;
  const length = Array.from(text).length;
  return length === 0 || length > MAX_TEXT || CONTROL.test(text);
}

function entropy(run) {
  const chars = Array.from(run);
  const counts = new Map();
  for (const c of chars) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(run) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[!-/:-@[-`{-~]/].filter((re) => re.test(run)).length;
}

function isPlainWebUrl(run) {
  try {
    const u = new URL(run);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

function looksSecret(text, vaultValues = []) {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  // Runs of printable ASCII (Deviation 26): secrets are ASCII, and prose in
  // scripts without spaces must not form one long run.
  for (const run of text.match(/[!-~]{24,}/g) || []) {
    if (isPlainWebUrl(run)) continue;
    if (entropy(run) >= 4.0 && charClasses(run) >= 3) return true;
  }
  return vaultValues.some((v) => typeof v === 'string' && v.length >= 8 && text.includes(v));
}

// `Name(detail)` patterns only; bare names are ignored (§3.8).
function details(patterns) {
  const out = [];
  for (const p of patterns || []) {
    const m = /^[A-Za-z_][\w-]*\(([\s\S]*)\)$/.exec(String(p));
    if (m && m[1] !== '') out.push(m[1]);
  }
  return out;
}

function candidates(text) {
  const out = new Set([text]);
  for (const line of text.split('\n')) {
    out.add(line);
    for (const segment of line.split(SHELL_SEPARATORS)) if (segment.trim()) out.add(segment.trim());
  }
  return out;
}

function matchesAlwaysConfirm(texts, patterns) {
  const ds = details(patterns).filter((d) => d !== '*');
  if (ds.length === 0) return false;
  for (const text of texts) {
    for (const c of candidates(text)) if (ds.some((d) => patternMatch(d, c))) return true;
  }
  return false;
}

// The longest run of `value` from `pos` that some text holds. Holding a run
// means holding every shorter one from the same place, so a binary search.
function longestRun(value, pos, texts) {
  let lo = 0;
  let hi = value.length - pos;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const piece = value.slice(pos, pos + mid);
    if (texts.some((t) => t.includes(piece))) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Can at most JOIN_PIECES runs of the typed pieces spell `value`, with one
// run that includes some of the new text? `combined` is the piece being
// typed, whose characters from `newFrom` on are new. A run may be any part
// of any piece (text dropped into a piece splits it), so this answers yes
// for every arrangement the keys could have made, and for some they could
// not: it never counts a character twice against the piece that holds it.
function canJoin(value, pieces, combined, newFrom) {
  const n = value.length;
  const texts = [...pieces, combined];
  const reach = Array.from({ length: n }, (_, p) => longestRun(value, p, texts));
  // from: positions reached; the result: positions one more run reaches.
  const step = (from) => {
    const diff = new Int32Array(n + 2);
    let any = false;
    for (let p = 0; p < n; p += 1) {
      if (from[p] && reach[p] > 0) { diff[p + 1] += 1; diff[p + reach[p] + 1] -= 1; any = true; }
    }
    const to = new Uint8Array(n + 1);
    if (!any) return to;
    let open = 0;
    for (let e = 1; e <= n; e += 1) { open += diff[e]; if (open > 0) to[e] = 1; }
    return to;
  };
  // The same, but the run must include new text: it sits in `combined` and
  // ends after `newFrom`.
  const stepNew = (from) => {
    const to = new Uint8Array(n + 1);
    for (let p = 0; p < n; p += 1) {
      if (!from[p]) continue;
      for (let s = Math.max(0, newFrom - (n - p) + 1); s < combined.length; s += 1) {
        if (combined[s] !== value[p]) continue;
        let m = 1;
        while (p + m < n && s + m < combined.length && combined[s + m] === value[p + m]) m += 1;
        for (let len = Math.max(1, newFrom - s + 1); len <= m; len += 1) to[p + len] = 1;
      }
    }
    return to;
  };
  let plain = new Uint8Array(n + 1);
  plain[0] = 1;
  let withNew = new Uint8Array(n + 1);
  for (let used = 1; used <= JOIN_PIECES; used += 1) {
    const a = step(withNew);
    const b = stepNew(plain);
    withNew = a.map((v, i) => (v || b[i] ? 1 : 0));
    if (withNew[n]) return true;
    plain = step(plain);
  }
  return false;
}

// `buffer`: what was typed where the caret is. `segments`: earlier pieces,
// whose place in the field is unknown (TypedBuffer).
function checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '', segments = [] } = {}) {
  if (isInvalidText(text)) return { ok: false, code: 'invalid_text' };
  const combined = `${buffer}${text}`;
  if (matchesAlwaysConfirm([text, combined], alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (looksSecret(text, vaultValues) || looksSecret(combined, vaultValues)) return { ok: false, code: 'text_looks_secret' };
  const pieces = segments.filter((s) => typeof s === 'string' && s !== '');
  if (pieces.length === 0) return { ok: true };
  // The new piece at either end of an earlier one.
  const joined = pieces.flatMap((s) => [`${s}${combined}`, `${combined}${s}`]);
  if (matchesAlwaysConfirm(joined, alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (joined.some((j) => looksSecret(j, []))) return { ok: false, code: 'text_looks_secret' };
  for (const value of vaultValues) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 2 * BUFFER_MAX) continue;
    if (canJoin(value, pieces, combined, buffer.length)) return { ok: false, code: 'text_looks_secret' };
  }
  return { ok: true };
}

// What a lease has typed: the text at the caret (`value`), and the earlier
// pieces (`segments`) left behind when the caret went somewhere the guard
// cannot follow. 2000 code points in all; the oldest go first.
class TypedBuffer {
  constructor(max = BUFFER_MAX) {
    this.max = max;
    this.chars = [];
    this.parts = [];
    this.navigated = false;
  }

  get value() {
    return this.chars.join('');
  }

  get segments() {
    return this.parts.map((p) => p.join(''));
  }

  _trim() {
    let over = this.parts.reduce((n, p) => n + p.length, this.chars.length) - this.max;
    while (over > 0 && this.parts.length) {
      const first = this.parts[0];
      if (first.length <= over) { over -= first.length; this.parts.shift(); } else { this.parts[0] = first.slice(over); over = 0; }
    }
    if (over > 0) this.chars = this.chars.slice(over);
  }

  append(text) {
    this.chars.push(...Array.from(String(text)));
    this._trim();
  }

  // Backspace, `count` times. Past the start of what was typed here it
  // removes text the buffer never saw: from then on the place is unknown.
  backspace(count = 1) {
    const n = Math.max(0, Math.floor(count));
    if (n > this.chars.length) this.navigated = true;
    this.chars = this.chars.slice(0, Math.max(0, this.chars.length - n));
  }

  // The caret moved, or something edited the field in a way the guard cannot
  // follow: what was typed stays, as a piece of unknown place.
  navigate() {
    if (this.chars.length) this.parts.push(this.chars);
    this.chars = [];
    this.navigated = true;
  }

  reset() {
    this.chars = [];
    this.parts = [];
    this.navigated = false;
  }
}

module.exports = { checkTypeText, TypedBuffer, looksSecret, isInvalidText, MAX_TEXT, JOIN_PIECES };
