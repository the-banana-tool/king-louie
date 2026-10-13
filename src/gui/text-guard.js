// src/gui/text-guard.js
// What the Type tool (and printable Key presses) may send (fleet stage 5
// spec §3.8). Checks run over `buffer + text`, where the buffer is the
// lease's last 2000 typed characters, so a value spelled one call at a time
// is caught; the text alone is checked too, so a buffer cannot mask it.
const { patternMatch, SHELL_SEPARATORS } = require('../execution/tool-patterns');

const MAX_TEXT = 2000;
const BUFFER_MAX = 2000;
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

function checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '' } = {}) {
  if (isInvalidText(text)) return { ok: false, code: 'invalid_text' };
  const combined = `${buffer}${text}`;
  if (matchesAlwaysConfirm([text, combined], alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (looksSecret(text, vaultValues) || looksSecret(combined, vaultValues)) return { ok: false, code: 'text_looks_secret' };
  return { ok: true };
}

class TypedBuffer {
  constructor(max = BUFFER_MAX) {
    this.max = max;
    this.chars = [];
  }

  get value() {
    return this.chars.join('');
  }

  append(text) {
    this.chars.push(...Array.from(String(text)));
    if (this.chars.length > this.max) this.chars = this.chars.slice(this.chars.length - this.max);
  }

  reset() {
    this.chars = [];
  }
}

module.exports = { checkTypeText, TypedBuffer, looksSecret, isInvalidText, MAX_TEXT };
