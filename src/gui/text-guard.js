// src/gui/text-guard.js
// What the Type tool (and printable Key presses) may send (fleet stage 5
// spec §3.8). Checks run over `buffer + text`, where the buffer is what the
// lease typed where the caret now is, so a value spelled one call at a time
// is caught; the text alone is checked too, so a buffer cannot mask it.
//
// The buffer models what the keys did (security review finding 9, revised
// 2026-10-12; the spec's "reset on enter" is gone; third security review,
// finding 1, 2026-10-13: removals):
//   - a printable key or typed text is appended; enter is a line break;
//   - backspace removes the last character typed at the caret. Past the
//     start of that text (third review, finding 1):
//       - after End, with nothing since the lease began that put the caret
//         in an unknown place, it removes from the end of the piece typed
//         last, and then of the ones before it (they are one run of text,
//         and End put the caret after it). What it removed is kept as that
//         piece's "cut": the piece is checked both without it and with it,
//         since End may have gone to the end of other text;
//       - after End otherwise, the same for the last piece only, and the
//         field is marked lossy (below): the end of the line may be the end
//         of any piece;
//       - anywhere else, the field is marked lossy;
//   - after anything that moves the caret (arrows, home, end, page keys,
//     tab, escape, function keys, a click, a drag, a suspension) the text so
//     far is kept as a piece whose place in the field is unknown, and a new
//     piece starts;
//   - a key that removes or replaces text in a way the buffer cannot follow
//     marks the field lossy for the rest of the lease (keyEffect): delete,
//     insert (overtype), backspace with any modifier, every ctrl/alt/meta
//     chord that is not a caret key (ctrl+backspace, ctrl+delete, ctrl+h,
//     ctrl+w, ctrl+k, ctrl+z, ...), a backspace or delete whose outcome is
//     not known, and text or a backspace that follows a selection (shift
//     with a caret key, a click with a modifier, another button or a count
//     over one, a drag).
// Text typed after a caret move is checked two ways:
//   1. in any arrangement, a few pieces: a vault value that at most
//      JOIN_PIECES runs of the typed pieces can spell (a run is any part of
//      any piece; one run from the new text) is refused, and so is an
//      always_confirm command or a secret pattern that the new piece
//      completes at either end of an earlier one;
//   2. in the order typed, any number of pieces (second security review,
//      finding 8): a vault value is refused when earlier pieces, taken in
//      the order they were typed, spell it up to the text being typed (the
//      first may give only its end, the text being typed only its start,
//      the ones between are whole; pieces typed in between elsewhere may be
//      skipped), and so is an always_confirm command or a secret pattern
//      (the fixed prefixes, not the entropy rule) in the pieces joined in
//      that order.
// While the field is lossy, a piece may have lost characters the guard did
// not see go, so:
//   - in rule 2 a link need not be a whole piece. It may be the piece less
//     up to LOSSY_EDGE characters at each end (whatever is left, one
//     character included), or any run of LOSSY_RUN characters or more from
//     anywhere in it, and one piece may give several links, left to right;
//   - the command and pattern checks of rules 1 and 2 also run with up to
//     LOSSY_EDGE characters dropped where pieces join: in rule 1 from the
//     earlier piece's joining end, in rule 2 the same number from the end
//     of every piece and the same number from the start of every piece
//     (every pair of numbers).
// The buffer keeps the last RUNS_MAX pieces and BUFFER_MAX code points.
// Cost (third review, finding 2): a vault value over VALUE_FOLLOW_MAX
// characters is checked as a substring of the text only, never across
// pieces, and one check has STEP_BUDGET steps for its work across pieces;
// past that it refuses (text_guard_limit), it never lets the text through.
// Residuals, known and not closed:
//   - the guard checks text when it is typed, never when it is removed: a
//     value, command or pattern that a removal completes (junk typed inside
//     it and deleted afterwards) is seen only if more text is typed after;
//   - a value in more than JOIN_PIECES pieces typed out of order, or with
//     text around a middle piece that was not removed, or with its first
//     piece older than the window;
//   - in a lossy field: a value spelled in pieces of one or two characters
//     with more than LOSSY_EDGE characters removed beside each; a command
//     or a pattern whose pieces lost different numbers of characters at
//     different joins, or more than LOSSY_EDGE at one;
//   - a field that is not marked lossy although text went: what a tab,
//     escape or function key does in the app, a menu's Cut or Delete chosen
//     with a click, and End pressed where the line ends in the text of
//     another piece while nothing had moved the caret before;
//   - a vault value over VALUE_FOLLOW_MAX characters typed in pieces;
//   - text the app itself adds, moves or completes (autocomplete, find and
//     replace, macros, an input method, drag and drop of a selection), and
//     a paste chosen from a menu with a click: the clipboard chords are
//     denied, a click on "Paste" cannot be, and what it pastes is never
//     seen here;
//   - text that was in the field before the lease;
//   - the keyboard layout: a key press is taken for the character it types
//     on a US layout (SHIFTED in keys.js). On another layout a value spelled
//     with shifted digit or punctuation keys is another string to this
//     guard than on the screen. Text sent with Type is exact on any layout;
//   - a pattern or command completed by a piece dropped into the middle of
//     another.
// False positives, known: rule 2 refuses ordinary typing that happens to
// spell a vault value piece by piece, which a short or repetitive value
// invites (eight cells holding "a" spell "aaaaaaaa"), and more easily in a
// lossy field (runs of LOSSY_RUN characters in the order typed are enough);
// and after a fixed token prefix was typed (ghp_, sk-), text that follows
// it in the pieces is refused until the prefix leaves the window. The
// pieces and the lossy mark are kept through a suspension and its resume
// (second security review, finding 7: a pause does not empty the field); a
// new lease starts with none.
const { patternMatch, SHELL_SEPARATORS } = require('../execution/tool-patterns');

const MAX_TEXT = 2000;
// What a lease's typed history holds: code points, and pieces.
const BUFFER_MAX = 4096;
const RUNS_MAX = 64;
// How many runs of typed pieces may spell a vault value before the guard
// stops following (see the residuals above).
const JOIN_PIECES = 4;
// A lossy field: how many characters a piece may have lost at each end, and
// how short a run from the middle of a piece may be and still be a link.
const LOSSY_EDGE = 4;
const LOSSY_RUN = 3;
// The longest vault value followed across pieces.
const VALUE_FOLLOW_MAX = 512;
// What one check may spend on its work across pieces. A step is a
// character comparison, or about sixteen characters of a native search. A
// full history against some hundreds of ordinary vault values stays under
// it; it is some tenths of a second of work.
const STEP_BUDGET = 20_000_000;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/
]);
// Control characters other than \n and \t (C0, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// Never in typed text (CONTROL), so it never joins two pieces into a match.
const SEPARATOR = '\u0000';

class GuardBudgetError extends Error {}

// spend(n): n more steps; throws once the check has used its budget.
function makeBudget(steps) {
  let left = steps;
  return (n = 1) => {
    left -= n;
    if (left < 0) throw new GuardBudgetError('text guard step budget');
  };
}

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

// The longest run of `value` from `pos` that the haystack (the pieces,
// SEPARATOR between them) holds. Holding a run means holding every shorter
// one from the same place, so a binary search.
function longestRun(value, pos, haystack, spend) {
  let lo = 0;
  let hi = value.length - pos;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    spend(1 + (haystack.length >> 4));
    if (haystack.includes(value.slice(pos, pos + mid))) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Can at most JOIN_PIECES runs of the typed pieces spell `value`, with one
// run that includes some of the new text? `combined` is the piece being
// typed, whose characters from `newFrom` on are new. A run may be any part
// of any piece (text dropped into a piece splits it), so this answers yes
// for every arrangement the keys could have made, and for some they could
// not: it never counts a character twice against the piece that holds it.
function canJoin(value, pieces, combined, newFrom, spend) {
  const n = value.length;
  const haystack = [...pieces, combined].join(SEPARATOR);
  // Worked out only for the positions a run can start from.
  const reach = new Int32Array(n).fill(-1);
  const reachAt = (p) => {
    if (reach[p] < 0) reach[p] = longestRun(value, p, haystack, spend);
    return reach[p];
  };
  // from: positions reached; the result: positions one more run reaches.
  const step = (from) => {
    const diff = new Int32Array(n + 2);
    let any = false;
    for (let p = 0; p < n; p += 1) {
      if (!from[p]) continue;
      const r = reachAt(p);
      if (r > 0) { diff[p + 1] += 1; diff[p + r + 1] -= 1; any = true; }
    }
    spend(n);
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
      const first = Math.max(0, newFrom - (n - p) + 1);
      spend(Math.max(1, combined.length - first));
      for (let s = first; s < combined.length; s += 1) {
        if (combined[s] !== value[p]) continue;
        let m = 1;
        while (p + m < n && s + m < combined.length && combined[s + m] === value[p + m]) m += 1;
        spend(2 * m);
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
    if (used < JOIN_PIECES) plain = step(plain);
  }
  return false;
}

// KMP prefix table of `value`.
function prefixTable(value) {
  const pi = new Int32Array(value.length);
  for (let i = 1, k = 0; i < value.length; i += 1) {
    while (k > 0 && value[i] !== value[k]) k = pi[k - 1];
    if (value[i] === value[k]) k += 1;
    pi[i] = k;
  }
  return pi;
}

// Every length L ≥ 1 for which the last L characters of `piece` are the
// first L of `value`.
function suffixPrefixLengths(piece, value, pi) {
  let k = 0;
  for (let i = 0; i < piece.length; i += 1) {
    if (k === value.length) k = pi[k - 1];
    while (k > 0 && piece[i] !== value[k]) k = pi[k - 1];
    if (piece[i] === value[k]) k += 1;
  }
  const out = [];
  while (k > 0) { out.push(k); k = pi[k - 1]; }
  return out;
}

// Where a chain may end: every p for which the rest of `value` from p is
// the start of `combined` and takes in at least one new character (those
// from `newFrom` on). Without one, no chain of earlier pieces matters.
function chainEnds(value, combined, newFrom, spend) {
  const n = value.length;
  const out = [];
  for (let rest = newFrom + 1; rest <= Math.min(n - 1, combined.length); rest += 1) {
    spend();
    if (combined[rest - 1] !== value[n - 1] || combined[0] !== value[n - rest]) continue;
    spend(1 + (rest >> 4));
    if (combined.startsWith(value.slice(n - rest))) out.push(n - rest);
  }
  return out;
}

// What a piece may be in the field: without what a backspace after End took
// from its end (`text`), or with some or all of that still there (`cut`).
function pieceForms(piece) {
  const out = [piece.text];
  for (let j = 1; j <= piece.cut.length; j += 1) out.push(piece.text + piece.cut.slice(0, j));
  return out;
}

// Do the typed pieces, in the order they were typed, spell `value` up to
// the text being typed (finding 8)? A chain: the end of one earlier piece,
// then whole later pieces, then the start of the text being typed (`ends`,
// from chainEnds). Pieces between two links of the chain may be skipped; a
// link is never part of a middle piece. Any number of links.
function canChain(value, pieces, ends, spend) {
  const n = value.length;
  if (ends.length === 0 || pieces.length === 0) return false;
  const pi = prefixTable(value);
  // reached[p]: value[0, p) is spelled by a chain of the pieces seen so far.
  const reached = new Uint8Array(n + 1);
  let any = false;
  for (const piece of pieces) {
    const next = [];
    for (const form of pieceForms(piece)) {
      if (form === '') continue;
      spend(1 + ((form.length + n) >> 2));
      if (any && form.length < n) {
        for (let at = value.indexOf(form, 1); at !== -1; at = value.indexOf(form, at + 1)) {
          spend(1 + (n >> 4));
          if (reached[at] && at + form.length < n) next.push(at + form.length);
        }
      }
      for (const len of suffixPrefixLengths(form, value, pi)) if (len < n) next.push(len);
    }
    for (const p of next) { reached[p] = 1; any = true; }
  }
  return ends.some((p) => reached[p]);
}

// The same question in a lossy field, where a piece may have lost
// characters the guard did not see go. A link is then a run of a piece that
// either leaves at most LOSSY_EDGE characters of the piece at each side
// (the first link of a chain may start anywhere, as in canChain), or is
// LOSSY_RUN characters or longer; a piece may give several links, left to
// right. Every chain canChain finds is one of these.
function canChainLossy(value, pieces, ends, spend) {
  const n = value.length;
  if (ends.length === 0 || pieces.length === 0) return false;
  const reached = new Uint8Array(n + 1);
  reached[0] = 1;
  for (const piece of pieces) {
    const text = piece.text + piece.cut;
    const len = text.length;
    const slack = Math.max(LOSSY_EDGE, piece.cut.length);
    // Positions a link may start from at the place in the piece now reached.
    const open = Uint8Array.from(reached);
    const list = [];
    for (let p = 0; p < n; p += 1) if (open[p]) list.push(p);
    const later = new Array(len + 1);
    const found = [];
    for (let s = 0; s < len; s += 1) {
      for (const p of later[s] || []) if (!open[p]) { open[p] = 1; list.push(p); }
      spend(list.length);
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        if (text[s] !== value[p]) continue;
        let m = 1;
        while (p + m < n && s + m < len && text[s + m] === value[p + m]) m += 1;
        spend(2 * m);
        let shortest = LOSSY_RUN;
        if (p === 0 || s <= LOSSY_EDGE) shortest = Math.min(shortest, Math.max(1, len - s - slack));
        for (let l = shortest; l <= m && p + l < n; l += 1) {
          (later[s + l] || (later[s + l] = [])).push(p + l);
          found.push(p + l);
        }
      }
    }
    for (const q of found) reached[q] = 1;
  }
  return ends.some((p) => reached[p]);
}

// `text` less `lead` characters at its start and `trail` at its end.
function dropEnds(text, lead, trail) {
  return text.slice(lead, Math.max(lead, text.length - trail));
}

// `buffer`: what was typed where the caret is. `segments`: earlier pieces,
// whose place in the field is unknown (TypedBuffer), oldest first; `cuts`:
// for each, what a backspace after End may have taken from its end; `lossy`:
// pieces may have lost more than that (TypedBuffer#state gives all four).
function checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '', segments = [], cuts = [], lossy = false, stepBudget = STEP_BUDGET } = {}) {
  if (isInvalidText(text)) return { ok: false, code: 'invalid_text' };
  const combined = `${buffer}${text}`;
  if (matchesAlwaysConfirm([text, combined], alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (looksSecret(text, vaultValues) || looksSecret(combined, vaultValues)) return { ok: false, code: 'text_looks_secret' };
  const pieces = [];
  segments.forEach((s, i) => {
    const piece = { text: typeof s === 'string' ? s : '', cut: typeof cuts[i] === 'string' ? cuts[i] : '' };
    if (piece.text !== '' || piece.cut !== '') pieces.push({ ...piece, full: piece.text + piece.cut });
  });
  if (pieces.length === 0) return { ok: true };
  const edges = lossy ? Array.from({ length: LOSSY_EDGE }, (_, i) => i + 1) : [];
  // The new piece at either end of an earlier one.
  const joined = new Set();
  for (const piece of pieces) {
    for (const before of new Set([piece.text, piece.full, ...edges.map((k) => dropEnds(piece.full, 0, k))])) joined.add(`${before}${combined}`);
    for (const after of new Set([piece.text, piece.full, ...edges.map((k) => dropEnds(piece.full, k, 0))])) joined.add(`${combined}${after}`);
  }
  if (matchesAlwaysConfirm(joined, alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if ([...joined].some((j) => looksSecret(j, []))) return { ok: false, code: 'text_looks_secret' };
  // The pieces in the order they were typed, any number of them (finding 8).
  const inOrder = new Set([`${pieces.map((p) => p.text).join('')}${combined}`, `${pieces.map((p) => p.full).join('')}${combined}`]);
  for (const lead of [0, ...edges]) {
    for (const trail of [0, ...edges]) inOrder.add(`${pieces.map((p) => dropEnds(p.full, lead, trail)).join('')}${combined}`);
  }
  if (matchesAlwaysConfirm(inOrder, alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if ([...inOrder].some((t) => SECRET_PATTERNS.some((re) => re.test(t)))) return { ok: false, code: 'text_looks_secret' };
  const spend = makeBudget(stepBudget);
  const fulls = pieces.map((p) => p.full);
  try {
    for (const value of vaultValues) {
      if (typeof value !== 'string' || value.length < 8 || value.length > VALUE_FOLLOW_MAX || value.includes(SEPARATOR)) continue;
      const ends = chainEnds(value, combined, buffer.length, spend);
      if (canChain(value, pieces, ends, spend)) return { ok: false, code: 'text_looks_secret' };
      if (lossy && canChainLossy(value, pieces, ends, spend)) return { ok: false, code: 'text_looks_secret' };
      if (canJoin(value, fulls, combined, buffer.length, spend)) return { ok: false, code: 'text_looks_secret' };
    }
  } catch (err) {
    if (!(err instanceof GuardBudgetError)) throw err;
    // Fail closed: text the guard could not finish checking is not typed.
    return { ok: false, code: 'text_guard_limit', detail: 'checking this text against what this lease typed before took too many steps, so it was not typed; type less at once, or continue under a new lease' };
  }
  return { ok: true };
}

const CARET_KEYS = Object.freeze(['home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right']);

// What a key press that types nothing does to the typed buffer:
//   'backspace' a bare backspace, which the buffer follows;
//   'edit'      it removes or replaces text the buffer cannot follow;
//   'select'    it may leave text selected (what is typed next replaces it);
//   'end'       the caret goes to the end of the line;
//   'move'      the caret moves, and nothing stays selected;
//   'navigate'  anything else: the caret may be anywhere after it.
function keyEffect({ mods, key }) {
  const chord = mods.some((m) => m !== 'shift');
  if (key === 'backspace') return mods.length === 0 ? 'backspace' : 'edit';
  if (key === 'delete' || key === 'insert') return 'edit';
  if (CARET_KEYS.includes(key)) {
    if (mods.includes('shift')) return 'select';
    if (chord) return 'navigate';
    return key === 'end' ? 'end' : 'move';
  }
  return chord ? 'edit' : 'navigate';
}

// Applies such a press to the buffer. A press whose outcome is not known
// (`certain: false`) is never taken as a removal the buffer followed, nor
// as a caret the buffer can place.
function applyKey(buffer, combo, { repeat = 1, certain = true } = {}) {
  const effect = keyEffect(combo);
  if (effect === 'backspace' && certain) buffer.backspace(repeat);
  else if (effect === 'backspace' || effect === 'edit') buffer.edited();
  else if (effect === 'select') buffer.select();
  else if ((effect === 'end' || effect === 'move') && certain) buffer.navigate(effect);
  else buffer.navigate();
}

// What a lease has typed: the text at the caret (`value`), and the earlier
// pieces (`segments`, oldest first) left behind when the caret went
// somewhere the guard cannot follow. BUFFER_MAX code points and RUNS_MAX
// pieces in all; the oldest go first.
class TypedBuffer {
  constructor(max = BUFFER_MAX, maxRuns = RUNS_MAX) {
    this.max = max;
    this.maxRuns = maxRuns;
    this.reset();
  }

  get value() {
    return this.chars.join('');
  }

  get segments() {
    return this.parts.map((p) => p.chars.join(''));
  }

  // For each piece, what a backspace after End may have taken from its end.
  get cuts() {
    return this.parts.map((p) => p.cut.join(''));
  }

  // What checkTypeText needs of the buffer. With text selected, what is
  // typed now replaces it: the check is the lossy one already.
  get state() {
    return { buffer: this.value, segments: this.segments, cuts: this.cuts, lossy: this.lossy || this.selecting };
  }

  _trim() {
    let over = this.parts.reduce((n, p) => n + p.chars.length + p.cut.length, this.chars.length) - this.max;
    while (over > 0 && this.parts.length) {
      const first = this.parts[0];
      const size = first.chars.length + first.cut.length;
      if (size <= over) { over -= size; this.parts.shift(); continue; }
      const head = Math.min(over, first.chars.length);
      first.chars = first.chars.slice(head);
      first.cut = first.cut.slice(over - head);
      over = 0;
    }
    if (over > 0) this.chars = this.chars.slice(over);
  }

  append(text) {
    const added = Array.from(String(text));
    if (added.length === 0) return;
    // Typed over a selection: what was selected is gone, whatever it was.
    if (this.selecting) { this.selecting = false; this.lossy = true; }
    this.chars.push(...added);
    this._trim();
  }

  // Backspace, `count` times. Past the start of what was typed here it
  // removes text of an earlier piece, or text the buffer never saw (see the
  // header for which).
  backspace(count = 1) {
    let n = Math.max(0, Math.floor(count));
    if (n === 0) return;
    if (this.selecting) {
      // It removes the selection, whatever that held.
      this.selecting = false;
      this.lossy = true;
      this.atEnd = false;
      this.scattered = true;
      this.navigated = true;
      return;
    }
    const here = Math.min(n, this.chars.length);
    this.chars = this.chars.slice(0, this.chars.length - here);
    n -= here;
    if (n === 0) return;
    this.navigated = true;
    if (this.parts.length === 0) return;
    if (!this.atEnd) { this.lossy = true; return; }
    for (let i = this.parts.length - 1; i >= 0 && n > 0; i -= 1) {
      const part = this.parts[i];
      const k = Math.min(n, part.chars.length);
      part.cut = [...part.chars.slice(part.chars.length - k), ...part.cut];
      part.chars = part.chars.slice(0, part.chars.length - k);
      n -= k;
      // Earlier pieces follow on only when nothing ever moved the caret away.
      if (this.scattered) break;
    }
    if (this.scattered) this.lossy = true;
  }

  // The caret moved: what was typed stays, as a piece of unknown place.
  // `kind`: 'end' (the end of the line), 'move' (somewhere else, nothing
  // left selected), or nothing (not known, a selection included).
  navigate(kind = null) {
    if (this.chars.length) this.parts.push({ chars: this.chars, cut: [] });
    while (this.parts.length > this.maxRuns) this.parts.shift();
    this.chars = [];
    this.navigated = true;
    if (kind === 'end') {
      this.atEnd = true;
      this.selecting = false;
    } else {
      this.atEnd = false;
      this.scattered = true;
      if (kind === 'move') this.selecting = false;
    }
  }

  // Something removed or replaced text in a way the buffer cannot follow:
  // from now on any piece may hold less than what was typed into it.
  edited() {
    this.navigate();
    this.lossy = true;
  }

  // Text may now be selected: what is typed next replaces it.
  select() {
    this.navigate();
    this.selecting = true;
  }

  reset() {
    this.chars = [];
    // Each: { chars, cut }, the text of the piece and what a backspace after
    // End took from its end (kept, since End may have gone elsewhere).
    this.parts = [];
    this.navigated = false;
    // Pieces may have lost characters the buffer did not see go.
    this.lossy = false;
    // The caret is at the end of the line (End was the last move).
    this.atEnd = false;
    // Something other than End has moved the caret since the lease began.
    this.scattered = false;
    this.selecting = false;
  }
}

module.exports = {
  checkTypeText, TypedBuffer, keyEffect, applyKey, looksSecret, isInvalidText,
  MAX_TEXT, JOIN_PIECES, BUFFER_MAX, RUNS_MAX, LOSSY_EDGE, LOSSY_RUN, VALUE_FOLLOW_MAX, STEP_BUDGET
};
