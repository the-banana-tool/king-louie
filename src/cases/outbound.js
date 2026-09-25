// src/cases/outbound.js
// English detectors for the outbound gate's rule 3 (cases stage 3 spec
// §3.7): dates, prices, deadlines and commitments in text about to leave.
// Pure; the gate decides which spans a fact or approved wording backs.
//
// Every scan runs over the text folded by normalize.foldForScan (NFKC per
// character, invisible format characters dropped), so full-width digits or a
// zero-width space cannot hide a date, price or phrase; spans and sentence
// ranges are reported in the original text's offsets.
const { foldForScan } = require('./executors/normalize');

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?';
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');

// YYYY-MM-DD with a year, --MM-DD without one.
function dateValue(year, month, day) {
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  return year ? `${year}-${pad(month)}-${pad(day)}` : `--${pad(month)}-${pad(day)}`;
}

const monthOf = (name) => MONTH_INDEX[String(name).slice(0, 3).toLowerCase()];

const DATE_PATTERNS = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, value: (m) => dateValue(Number(m[1]), Number(m[2]), Number(m[3])) },
  {
    re: new RegExp(`\\b${WEEKDAY_RE}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    value: (m) => dateValue(m[3] ? Number(m[3]) : null, monthOf(m[1]), Number(m[2]))
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    value: (m) => dateValue(m[3] ? Number(m[3]) : null, monthOf(m[2]), Number(m[1]))
  },
  // US numeric dates only with a year, so "1/2 acre" is not a date.
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g,
    value: (m) => (Number(m[1]) <= 12
      ? dateValue(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]))
      : null)
  }
];

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

// Rounded to cents so "1.1 million" is 1100000, not 1100000.0000000002.
function scale(num, suffix) {
  const n = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = MULTIPLIERS[String(suffix || '').toLowerCase()] || 1;
  return Number((n * mult).toFixed(2));
}

const PRICE_PATTERNS = [
  { re: /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m|bn|thousand|million|billion)\b)?/gi, value: (m) => scale(m[1], m[2]) },
  { re: /\b(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|thousand|million|billion)?\s?(?:dollars|usd)\b/gi, value: (m) => scale(m[1], m[2]) },
  // A scaled amount without a currency ("1250k", "1.25 million") may be
  // money, so rule 1 compares it with fact values. It is `bare`: rule 3
  // does not treat it as a price constraint ("40m of frontage", "a 5k").
  { re: /\b(\d[\d,]*(?:\.\d+)?)(?:(k|m|bn)|\s?(thousand|million|billion))\b/gi, value: (m) => scale(m[1], m[2] || m[3]), bare: true }
];

const DEADLINE_RE = /\b(?:due(?:\s+(?:by|on|before))?|deadlines?|no later than|expires?(?:\s+on)?|must be (?:received|submitted|filed) by|closes? on)\b/gi;
const COMMITMENT_RE = /\b(?:(?:will|can|shall) (?:pay|accept|offer|sell|buy|close|sign|deliver|refund)|agree(?:s|d)? to|guarantee[sd]?|promise[sd]?|commit(?:s|ted)? to|firm offer)\b/gi;

// A sentence ends at . ! ? before a capital letter or the end, or at a
// newline, so "Nov. 14" and "$1,250.00" stay inside their sentence. Ranges
// are contiguous and cover the original text.
function sentenceRanges(text) {
  const orig = String(text ?? '');
  const { folded: s, ends } = foldForScan(orig);
  const out = [];
  const re = /[.!?]+(?=\s+[A-Z]|\s*$)|\n+/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const end = ends[m.index + m[0].length - 1];
    if (end > start) out.push({ start, end });
    start = end;
  }
  if (start < orig.length) out.push({ start, end: orig.length });
  return out.length ? out : [{ start: 0, end: orig.length }];
}

function sentenceOf(ranges, pos) {
  const i = ranges.findIndex((r) => pos >= r.start && pos < r.end);
  return i === -1 ? ranges.length - 1 : i;
}

// Matches over the folded scan text, reported as original spans.
function collect(scan, patterns, kind) {
  const { folded, starts, ends, orig } = scan;
  const out = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(folded)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex += 1;
        continue;
      }
      const start = starts[m.index];
      const end = ends[m.index + m[0].length - 1];
      out.push({ kind, start, end, text: orig.slice(start, end), value: p.value(m), ...(p.bare ? { bare: true } : {}) });
    }
  }
  return out;
}

// Overlapping matches of one kind: keep the earliest, longest.
function dedupe(spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const sp of sorted) {
    if (out.some((o) => sp.start < o.end && sp.end > o.start)) continue;
    out.push(sp);
  }
  return out;
}

function detect(text) {
  const orig = String(text ?? '');
  const scan = { ...foldForScan(orig), orig };
  const sentences = sentenceRanges(orig);
  const dates = dedupe(collect(scan, DATE_PATTERNS, 'date')).filter((sp) => sp.value);
  const prices = dedupe(collect(scan, PRICE_PATTERNS, 'price')).filter((sp) => sp.value !== null);
  const deadlines = dedupe(collect(scan, [{ re: DEADLINE_RE, value: () => null }], 'deadline'));
  const commitments = dedupe(collect(scan, [{ re: COMMITMENT_RE, value: () => null }], 'commitment'));
  return [...dates, ...prices, ...deadlines, ...commitments]
    .map((sp) => ({ ...sp, sentence: sentenceOf(sentences, sp.start) }))
    .sort((a, b) => a.start - b.start);
}

module.exports = { detect, sentenceRanges, sentenceOf };
