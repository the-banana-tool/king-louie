// src/cases/entities/extract.js
// Deterministic entity extraction from free text (cases stage 7 spec §3.6).
// People and organisations are never guessed from text: they come only from
// accepted ingest proposals, whose entities were found verbatim on the page.
//
// Hardening (document text is hostile input, spec §10): every regex below
// bounds its own match length (no unbounded quantifier feeds the
// backtracker or an unbounded entity), so a 400,000-character adversarial
// run of digits, `@`/`.` characters or capitalised words can only ever
// produce short matches in time linear in the input (see
// tests/cases-entities.test.js "adversarial input"). Output is bounded too:
// MAX_ENTITY_CHARS caps a single entity's recorded text (the `end` offset
// shrinks with it, so `text === original.slice(start, end)` always holds)
// and MAX_ENTITIES_PER_CALL caps how many entities one call returns.
const { ID_LABELS, STREET_SUFFIXES, normalizeEntity } = require('./normalize');

const TEXT_KINDS = Object.freeze(['email', 'phone', 'id', 'address']);

const MAX_ENTITY_CHARS = 200;
const MAX_ENTITIES_PER_CALL = 500;

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;
const ID_RE = new RegExp(
  `\\b(?:${ID_LABELS.join('|')})\\b\\.?\\s{0,10}(?:(?:no|number|id)\\b\\.?|#)?\\s{0,10}[:#]?\\s{0,10}([A-Za-z0-9][A-Za-z0-9\\-./]{0,40}[A-Za-z0-9])`,
  'gi'
);
const SUFFIX_ALT = Object.keys(STREET_SUFFIXES).map((s) => s[0].toUpperCase() + s.slice(1)).join('|');
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z][A-Za-z'-]{0,30}\\s+){1,4}?(?:${SUFFIX_ALT})\\b\\.?`, 'g');
const PHONE_RE = /(?<![\w+$])\+?\d[\d\s().-]{5,25}\d(?![\w])/g;
const DATE_LIKE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;

function overlaps(taken, start, end) {
  return taken.some((t) => start < t.end && end > t.start);
}

// → [{ type, text, keys, start, end }], ordered by start; spans never
// overlap (an id or address win over a phone run that would cross it,
// since ids and addresses are added first). See header for the two output
// caps.
function extractEntities(text, { kinds = TEXT_KINDS } = {}) {
  const s = String(text || '');
  const want = new Set(kinds);
  const found = [];
  const add = (type, value, start) => {
    if (found.length >= MAX_ENTITIES_PER_CALL) return;
    const capped = value.length > MAX_ENTITY_CHARS ? value.slice(0, MAX_ENTITY_CHARS) : value;
    const keys = normalizeEntity(type, capped);
    if (!keys.length) return;
    const end = start + capped.length;
    if (overlaps(found, start, end)) return;
    found.push({ type, text: capped, keys, start, end });
  };
  if (want.has('email')) for (const m of s.matchAll(EMAIL_RE)) add('email', m[0], m.index);
  if (want.has('id')) {
    for (const m of s.matchAll(ID_RE)) {
      const token = m[1];
      add('id', token, m.index + m[0].length - token.length);
    }
  }
  if (want.has('address')) for (const m of s.matchAll(ADDRESS_RE)) add('address', m[0].replace(/\.$/, ''), m.index);
  if (want.has('phone')) {
    for (const m of s.matchAll(PHONE_RE)) {
      const value = m[0].trim();
      if (DATE_LIKE.test(value)) continue;
      add('phone', value, m.index);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

module.exports = { TEXT_KINDS, extractEntities, MAX_ENTITY_CHARS, MAX_ENTITIES_PER_CALL };
