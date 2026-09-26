// src/cases/ingest/extract-text.js
// Page text for a stored document (cases stage 7 spec §3.2). Text files are
// one page; images and PDF pages without a usable text layer go to the
// injected readPage, which owns vision, caps, caching and charging.
const { IngestError } = require('./errors');

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MIN_TEXT_CHARS = 20;
const PAGES_GRAMMAR = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

// Private Use Area, U+FFFD and C0 controls other than tab, newlines and form
// feed are what a broken CMap produces.
const INVALID = /[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000B\u000E-\u001F]/u;
const VALID = /[\p{L}\p{N}\s.,;:!?'"()[\]{}\-\u2010-\u2015/\\@#$%&*+=<>_~^`|\u20AC\u00A3\u00A5\u00A7\u00B0\u00B7\u2026\u2018\u2019\u201C\u201D]/u;

function isWordish(token) {
  const t = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (t.length < 1 || t.length > 24) return false;
  const digits = (t.match(/\d/g) || []).length;
  if (digits / t.length >= 0.5) return true;
  return /[aeiouy]/i.test(t) || /[^\x00-\x7F]/u.test(t.replace(/[^\p{L}]/gu, ''));
}

// validRatio × wordRatio, in [0, 1].
function textQuality(text) {
  const chars = [...String(text || '')];
  if (!chars.length) return 0;
  let valid = 0;
  for (const ch of chars) if (!INVALID.test(ch) && VALID.test(ch)) valid += 1;
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const words = tokens.filter(isWordish).length;
  return Math.round((valid / chars.length) * (words / tokens.length) * 1000) / 1000;
}

// "1-3,7" → [1, 2, 3, 7]: 1-based, ascending, no repeats.
function parsePages(spec, pageCount = Infinity) {
  if (Array.isArray(spec)) spec = spec.join(',');
  const s = String(spec ?? '').replace(/\s+/g, '');
  if (!PAGES_GRAMMAR.test(s)) throw new IngestError('BAD_PAGES', `pages must look like "1-3,7" (1-based, ascending); got "${spec}".`);
  const out = [];
  for (const part of s.split(',')) {
    const [a, b = a] = part.split('-').map(Number);
    if (a < 1 || b < a) throw new IngestError('BAD_PAGES', `pages "${spec}" must be 1-based and ascending.`);
    for (let n = a; n <= b; n += 1) {
      if (out.length && n <= out[out.length - 1]) throw new IngestError('BAD_PAGES', `pages "${spec}" must be ascending without repeats.`);
      if (n > pageCount) throw new IngestError('BAD_PAGES', `The document has ${pageCount} page(s); page ${n} does not exist.`);
      out.push(n);
    }
  }
  return out;
}

function pageFromRead(n, rotation, read, extra = {}) {
  const base = { n, rotation, ...extra };
  if (!read || read.method === 'unreadable') return { ...base, method: 'unreadable', text: '', error: read?.error || 'unreadable' };
  if (read.method === 'pending-ocr') return { ...base, method: 'pending-ocr', text: '', error: read.error || null };
  return {
    ...base,
    method: 'ocr',
    text: String(read.text || ''),
    usd: read.usd ?? 0,
    usdEstimated: Boolean(read.usdEstimated),
    model: read.model || null
  };
}

// → { pageCount, pages: [{ n, method, text, quality, rotation, usd?, model?, error? }] }
// Only the pages in `pages` (1-based) are read when it is given.
async function extractPages({ bytes, mime, name }, { pdf = null, readPage, limits = {}, pages = null }) {
  const threshold = Number.isFinite(limits.textQualityThreshold) ? limits.textQualityThreshold : 0.6;
  if (String(mime).startsWith('text/')) {
    const text = Buffer.from(bytes).toString('utf8');
    return { pageCount: 1, pages: [{ n: 1, method: 'text', text, quality: textQuality(text), rotation: 0 }] };
  }
  if (String(mime).startsWith('image/')) {
    if (pages && !pages.includes(1)) return { pageCount: 1, pages: [] };
    if (Buffer.byteLength(bytes) > IMAGE_MAX_BYTES) {
      return { pageCount: 1, pages: [{ n: 1, method: 'unreadable', text: '', rotation: 0, error: 'page too large for vision' }] };
    }
    const read = await readPage(1, { rotation: 0, reason: 'image' });
    return { pageCount: 1, pages: [pageFromRead(1, 0, read)] };
  }
  if (mime !== 'application/pdf' || !pdf) throw new IngestError('UNSUPPORTED_TYPE', `Cannot ingest ${name}: ${mime} is not supported.`);
  const pageCount = pdf.pageCount;
  if (Number.isFinite(limits.maxPages) && pageCount > limits.maxPages) {
    throw new IngestError('TOO_MANY_PAGES', `Cannot ingest ${name}: it has ${pageCount} pages; the limit is ${limits.maxPages}.`);
  }
  const wanted = pages ? new Set(pages) : null;
  const out = [];
  for (let n = 1; n <= pageCount; n += 1) {
    if (wanted && !wanted.has(n)) continue;
    const text = await pdf.pageText(n);
    const rotation = pdf.pageRotation(n);
    const quality = textQuality(text);
    const nonSpace = text.replace(/\s/g, '').length;
    if (nonSpace >= MIN_TEXT_CHARS && quality >= threshold) {
      out.push({ n, method: 'text', text, quality, rotation });
      continue;
    }
    const reason = nonSpace < MIN_TEXT_CHARS ? 'no-text' : 'garbage';
    const read = await readPage(n, { rotation, reason });
    out.push(pageFromRead(n, rotation, read, { quality }));
  }
  return { pageCount, pages: out };
}

module.exports = { textQuality, parsePages, extractPages, IMAGE_MAX_BYTES, MIN_TEXT_CHARS, PAGES_GRAMMAR };
