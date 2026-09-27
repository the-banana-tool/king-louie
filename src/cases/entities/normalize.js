// src/cases/entities/normalize.js
// Entity keys (cases stage 7 spec §3.6): two spellings of the same email,
// phone number, account id, street address, person or organisation map to
// the same key, so the index can match them across cases.
//
// Hardening (document text is hostile input, spec §10):
// - Every regex used here and in extract.js bounds its own match length so
//   no unbounded quantifier can feed an unbounded key or a catastrophic
//   backtrack (see extract.js for the extraction-side bounds).
// - A key is capped to MAX_KEY_CHARS regardless of input length.
// - Hidden characters (the shared HIDDEN_CLASS from src/cases/hidden-chars.js:
//   C0/C1 controls minus tab/CR/LF, soft hyphen, combining grapheme joiner,
//   Hangul fillers, Arabic letter mark, Mongolian vowel separator,
//   ZWSP/ZWNJ/ZWJ/LRM/RLM, bidi embedding/override/isolate controls,
//   variation selectors, the BOM and tag characters) are stripped before
//   any key is built, so a key never carries a hidden or
//   direction-reversing character. They are removed (not replaced with a
//   space) so a hidden character planted inside a word reconstructs the
//   visible word instead of splitting it. This is the same set ingest/
//   store.js's oneLine strips, so what is dropped there is dropped here
//   too (fix-T6-r1 M2).
// - Lookalike digits (Arabic-Indic U+0660-0669, fullwidth U+FF10-FF19) are
//   not ASCII `\d`: every digit test and digit-extraction below is
//   ASCII-only, so they are consistently ignored everywhere (never counted
//   as digits, never folded to an ASCII digit) rather than partially
//   normalised.
const { norm } = require('../jsonl');
const { HIDDEN_CLASS } = require('../hidden-chars');

const ENTITY_TYPES = Object.freeze(['email', 'phone', 'id', 'address', 'person', 'org', 'document']);

const ID_LABELS = Object.freeze(['parcel', 'apn', 'pin', 'account', 'acct', 'loan', 'invoice', 'policy', 'order', 'case', 'reference', 'ref']);
const STREET_SUFFIXES = Object.freeze({
  street: 'street', st: 'street', road: 'road', rd: 'road', avenue: 'avenue', ave: 'avenue',
  lane: 'lane', ln: 'lane', drive: 'drive', dr: 'drive', court: 'court', ct: 'court',
  boulevard: 'boulevard', blvd: 'boulevard', way: 'way', highway: 'highway', hwy: 'highway'
});
const ORG_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'company', 'plc', 'gmbh']);

// ITU country-code lengths by leading digits: 1 and 7 are one digit, the
// listed two-digit codes are two, everything else is three.
const TWO_DIGIT_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98'
]);

function countryCodeLength(digits) {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

// Bounded output (hardening): no key this module returns — the type
// prefix included — is longer than this, whatever the input (fix-T6-r1
// M1: capping only the part after "type:" left the whole key uncapped).
const MAX_KEY_CHARS = 200;
const cap = (s) => (s.length > MAX_KEY_CHARS ? s.slice(0, MAX_KEY_CHARS) : s);

// Shared with src/cases/ingest/store.js's oneLine (fix-T6-r1 M2): stripped,
// not spaced, so a hidden character inside a word (a common obfuscation)
// reconstructs the visible word instead of splitting it.
const HIDDEN_RE = new RegExp(`[${HIDDEN_CLASS}]`, 'gu');
const stripHidden = (s) => s.replace(HIDDEN_RE, '');

// Unicode combining-diacritical-marks block (U+0300-U+036F), same reason.
const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, 'g');

const plainWords = (text) => stripHidden(String(text || ''))
  .normalize('NFKD')
  .replace(COMBINING_MARKS_RE, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const ID_LABEL_RE = new RegExp(`^\\s*(?:${ID_LABELS.join('|')})\\b\\.?\\s*(?:(?:no|number|id)\\b\\.?|#)?\\s*[:#]?\\s*`, 'i');

function idToken(text) {
  const token = stripHidden(String(text || '')).replace(ID_LABEL_RE, '').trim();
  const key = token.replace(/[\s\-./]/g, '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(key) || (key.match(/\d/g) || []).length < 3) return null;
  return key;
}

// → key[] (empty when the text is not a valid entity of that type).
function normalizeEntity(type, text) {
  const raw = stripHidden(norm(text)).trim();
  if (!raw) return [];
  switch (type) {
    case 'email': {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? [cap(`email:${raw}`)] : [];
    }
    case 'phone': {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return [];
      if (!raw.startsWith('+')) return [`phone:${digits}`];
      const national = digits.slice(countryCodeLength(digits));
      return national.length >= 7 ? [`phone:${digits}`, `phone:${national}`] : [`phone:${digits}`];
    }
    case 'id': {
      const key = idToken(raw);
      return key ? [cap(`id:${key}`)] : [];
    }
    case 'address': {
      const words = raw.replace(/[.,]+$/, '').replace(/\./g, '').split(/\s+/);
      if (words.length < 3 || !/^\d/.test(words[0])) return [];
      const last = words[words.length - 1];
      if (!STREET_SUFFIXES[last]) return [];
      words[words.length - 1] = STREET_SUFFIXES[last];
      return [cap(`address:${words.join(' ')}`)];
    }
    case 'person': {
      const p = plainWords(raw);
      return p ? [cap(`person:${p}`)] : [];
    }
    case 'org': {
      const words = plainWords(raw).split(' ').filter(Boolean);
      while (words.length > 1 && ORG_SUFFIXES.has(words[words.length - 1])) words.pop();
      return words.length ? [cap(`org:${words.join(' ')}`)] : [];
    }
    case 'document':
      return /^[0-9a-f]{64}$/.test(raw) ? [`document:${raw}`] : [];
    default:
      return [];
  }
}

const keyType = (key) => String(key).slice(0, String(key).indexOf(':'));

module.exports = {
  ENTITY_TYPES, ID_LABELS, STREET_SUFFIXES, normalizeEntity, keyType, plainWords, countryCodeLength,
  MAX_KEY_CHARS
};
