// src/cases/executors/normalize.js
// Recipient normalization (cases stage 3 spec §3.8) and the value forms the
// outbound gate's rule 1 searches for. The same functions produce both, so a
// recipient and a fact value compare equal whenever they are the same.
const { DAY_PATTERN } = require('./util');

const PHONE_CHANNELS = new Set(['call', 'sms', 'voicemail', 'phone']);
const URL_CHANNELS = new Set(['url', 'web-form', 'web-browse']);
const PHONE_SEPARATORS = /[\s\-.()]/g;
const PHONE_LIKE = /^\+?[\d\s\-.()]+$/;
const NUMERIC_TEXT = /^\$?\s?-?\d[\d,]*(\.\d+)?$/;
const MONEY_UNITS = /^(usd|\$|dollars?)$/i;
const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
// Folded text values this short or this common match too much to mean anything.
const STOP_WORDS = new Set(['none', 'null', 'true', 'false', 'unknown', 'with', 'from', 'that', 'this', 'have', 'will', 'your', 'owner', 'case', 'item', 'items', 'other', 'about', 'there', 'their']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(address, defaultCountryCode) {
  const raw = String(address ?? '').trim();
  let s = raw.replace(PHONE_SEPARATORS, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^\+\d{8,15}$/.test(s)) return { ok: true, value: s };
  const cc = String(defaultCountryCode || '').replace(/^\+/, '');
  if (/^\d+$/.test(s) && /^\d{1,3}$/.test(cc)) {
    // Bare digits that already start with the default country code are
    // ambiguous (is the leading digit the code, or part of the number?);
    // refuse rather than guess by prepending it again.
    if (s.startsWith(cc)) {
      return { ok: false, error: `ambiguous "${raw}": write it in +E.164 form, e.g. "+${s}"` };
    }
    const full = `+${cc}${s}`;
    if (/^\+\d{8,15}$/.test(full)) return { ok: true, value: full };
  }
  return { ok: false, error: `cannot normalize "${raw}" to E.164; give the country code` };
}

function normalizeEmail(address) {
  const raw = String(address ?? '').trim();
  const at = raw.lastIndexOf('@');
  const domain = at > 0 ? raw.slice(at + 1) : '';
  if (at < 1 || !domain || /\s/.test(raw) || !domain.includes('.')) {
    return { ok: false, error: `"${raw}" is not an email address` };
  }
  return { ok: true, value: `${raw.slice(0, at)}@${domain.toLowerCase()}` };
}

function normalizeUrl(address) {
  const raw = String(address ?? '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not an http(s) URL` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `"${raw}" is not an http(s) URL` };
  // A trailing DNS root label ("example.com.") is the same host to any
  // resolver but a different string to a naive allow-list; fold it away.
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
  // URL lowercases the host and drops a default port.
  return { ok: true, value: u.origin };
}

function normalizeRecipient(address, { channel = 'call', defaultCountryCode = '' } = {}) {
  if (PHONE_CHANNELS.has(channel)) return normalizePhone(address, defaultCountryCode);
  if (channel === 'email') return normalizeEmail(address);
  if (URL_CHANNELS.has(channel)) return normalizeUrl(address);
  const text = foldText(address);
  return text ? { ok: true, value: text } : { ok: false, error: 'a recipient address is required' };
}

function recipientChannel(capabilities = []) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (caps.includes('call') || caps.includes('sms') || caps.includes('voicemail')) return 'call';
  if (caps.includes('email')) return 'email';
  if (caps.includes('web-form') || caps.includes('web-browse')) return 'url';
  return 'text';
}

// ---- Rule 1 value forms ----

function digitMatcher(digits) {
  const body = digits.split('').join('[\\s\\-.()]*');
  return { kind: 'phone', form: digits, re: new RegExp(`(?<!\\d)\\+?${body}(?!\\d)`, 'g') };
}

// With and without a country code of one to three digits.
function phoneMatchers(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return [];
  const forms = new Set([digits]);
  for (let cc = 1; cc <= 3; cc += 1) if (digits.length - cc >= 7) forms.add(digits.slice(cc));
  return [...forms].map(digitMatcher);
}

// Thousands-grouping styles other than the en-US comma: plain space, the two
// "no-break" spaces some locales and typesetting use, a dot, and an
// apostrophe (Swiss style).
const GROUP_SEPARATORS = [' ', ' ', ' ', ' ', '.', "'"];

function groupDigits(digits, sep) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function numberMatchers(n, unit) {
  if (!Number.isFinite(n)) return [];
  if (!unit && Number.isInteger(n) && Math.abs(n) < 100) return [];
  const forms = new Set([String(n), n.toLocaleString('en-US', { maximumFractionDigits: 20 })]);
  const hasFraction = !Number.isInteger(n);
  if (MONEY_UNITS.test(String(unit || '')) || hasFraction) {
    forms.add(n.toFixed(2));
    forms.add(n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  // Grouping only reads as grouping past three integer digits; below that,
  // every separator would just repeat the bare digits already in `forms`.
  const neg = n < 0 ? '-' : '';
  const intPart = String(Math.trunc(Math.abs(n)));
  if (intPart.length > 3) {
    const fracDigits = hasFraction ? Math.abs(n).toFixed(2).split('.')[1] : null;
    for (const sep of GROUP_SEPARATORS) {
      const grouped = neg + groupDigits(intPart, sep);
      forms.add(grouped);
      if (fracDigits) forms.add(`${grouped},${fracDigits}`);
    }
  }
  return [...forms].map((form) => ({
    kind: 'number',
    form,
    re: new RegExp(`(?<![\\d.,])${escapeRe(form)}(?![\\d]|[.,]\\d)`, 'g')
  }));
}

function wordMatcher(kind, form) {
  // \s* (not \s+): the scanned text has already had invisible format
  // characters deleted (foldForScan), so two words a sender split apart
  // with a zero-width character now sit with nothing between them.
  const pattern = escapeRe(form).replace(/ /g, '\\s*');
  return { kind, form, re: new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu') };
}

function dateMatchers(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTH_NAMES[m - 1];
  if (!month) return [];
  return [
    { kind: 'date', form: iso, re: new RegExp(`(?<![\\d-])${escapeRe(iso)}(?![\\d])`, 'g') },
    wordMatcher('date', `${month} ${d}, ${y}`),
    wordMatcher('date', `${month} ${d} ${y}`),
    wordMatcher('date', `${month} ${d}`)
  ];
}

function emailMatchers(value) {
  const lower = value.trim().toLowerCase();
  return [{ kind: 'email', form: lower, re: new RegExp(`(?<![\\w.+-])${escapeRe(lower)}(?![\\w-])`, 'gi') }];
}

function textMatchers(value) {
  const folded = foldText(value);
  if (folded.length < 4 || STOP_WORDS.has(folded)) return [];
  return [wordMatcher('text', folded)];
}

function valueMatchers(value, unit = null) {
  if (value === null || value === undefined || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((v) => valueMatchers(v, unit));
  if (typeof value === 'number') return numberMatchers(value, unit);
  if (typeof value === 'object') return [];
  const s = String(value).trim();
  if (!s) return [];
  if (DAY_PATTERN.test(s)) return dateMatchers(s);
  if (s.includes('@') && !/\s/.test(s)) return emailMatchers(s);
  if (PHONE_LIKE.test(s) && /\d/.test(s)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && (s.startsWith('+') || /[\s\-.()]/.test(s))) return phoneMatchers(s);
  }
  if (NUMERIC_TEXT.test(s)) {
    const n = Number(s.replace(/[$,\s]/g, ''));
    return numberMatchers(n, unit || (s.startsWith('$') ? 'usd' : null));
  }
  return textMatchers(s);
}

// Unicode format characters: zero-width space/joiner, the BOM, and the
// like. Invisible on screen, but they defeat a literal-text search by
// splitting a flagged phrase or number apart, so the scan drops them.
const FORMAT_CHAR = /\p{Cf}/gu;

// Folds `text` for scanning (NFKC per source character, then format
// characters dropped) while keeping a map from each folded UTF-16 unit back to the
// [start, end) span of the original character that produced it. NFKC runs
// per character, not over the whole string, so composition never merges
// what were two distinct source characters into one mapped position.
function foldForScan(text) {
  const s = String(text ?? '');
  let folded = '';
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(i));
    const origStart = i;
    i += ch.length;
    const piece = ch.normalize('NFKC').replace(FORMAT_CHAR, '');
    for (let k = 0; k < piece.length; k += 1) {
      folded += piece[k];
      starts.push(origStart);
      ends.push(i);
    }
  }
  return { folded, starts, ends };
}

// Every match of every matcher, scanned against the folded text but
// reported as the original span and substring; where one span contains
// another only the outer one is kept.
function matchSpans(text, matchers) {
  const orig = String(text ?? '');
  const { folded: s, starts, ends } = foldForScan(orig);
  const found = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    let hit;
    while ((hit = m.re.exec(s)) !== null) {
      if (hit[0].length === 0) {
        m.re.lastIndex += 1;
        continue;
      }
      const start = starts[hit.index];
      const end = ends[hit.index + hit[0].length - 1];
      found.push({ start, end, text: orig.slice(start, end) });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const sp of found) {
    if (out.some((o) => o.start <= sp.start && o.end >= sp.end)) continue;
    out.push(sp);
  }
  return out;
}

// True when `text` names one of this send's recipients, in any format.
function isRecipient(text, recipients = []) {
  const t = foldText(text);
  const d = String(text ?? '').replace(/\D/g, '');
  return (recipients || []).some((r) => {
    if (foldText(r) === t) return true;
    const rd = String(r ?? '').replace(/\D/g, '');
    return d.length >= 7 && rd.length >= 7 && (rd === d || rd.endsWith(d));
  });
}

function valueKey(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueKey).sort().join('|');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value).trim();
  if (NUMERIC_TEXT.test(s)) {
    const n = Number(s.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) return String(n);
  }
  return foldText(s);
}

module.exports = {
  MONTH_NAMES,
  escapeRe,
  foldText,
  normalizeRecipient,
  recipientChannel,
  valueMatchers,
  matchSpans,
  isRecipient,
  valueKey
};
