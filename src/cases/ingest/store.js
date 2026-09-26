// src/cases/ingest/store.js
// Documents under a case's sources/ (cases stage 7 spec §3.1, §4.1): type
// sniffing, sha256 dedupe, the sidecar, and adopting a file a tool wrote.
// Names, bytes and ingest records are untrusted: a name only ever becomes a
// slug, the bytes must match their type, and a record's `ref` or a `docId`
// is checked before any file is touched (rulings M7, M8, M10).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { slugify } = require('../slug');
const { realpathNearest, stripLongPathPrefix, segmentsWithin } = require('../safe-path');
const { IngestError } = require('./errors');

const MIME_EXTS = Object.freeze({
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'text/plain': ['txt', 'text'],
  'text/markdown': ['md', 'markdown'],
  'text/csv': ['csv']
});
const ACCEPTED_MIME = Object.freeze(Object.keys(MIME_EXTS));
const EXT_MIME = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(MIME_EXTS).flatMap(([mime, exts]) => exts.map((ext) => [ext, mime]))
)));
const isAccepted = (mime) => Object.prototype.hasOwnProperty.call(MIME_EXTS, mime);

const DOC_ID = /^doc-[0-9a-f]{12}$/;
const MAX_NAME = 120;
const MAX_REF = 512;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const docIdFor = (hash) => `doc-${String(hash).slice(0, 12)}`;

// ---- names (M10) ----

// C0/C1 controls, bidi overrides and isolates, zero-width characters.
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
function oneLine(value, max) {
  const flat = String(value ?? '').replace(LINE_BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join('').trimEnd();
}

// A file name as it may be stored and shown: one line, at most 120
// characters, the extension kept when the stem is cut.
function cleanName(name) {
  const flat = oneLine(name, Infinity);
  const chars = Array.from(flat);
  if (!flat) return 'document';
  if (chars.length <= MAX_NAME) return flat;
  const ext = path.extname(flat);
  const extLen = Array.from(ext).length;
  if (ext && extLen <= 16) return `${chars.slice(0, MAX_NAME - extLen).join('').trimEnd()}${ext}`;
  return chars.slice(0, MAX_NAME).join('').trimEnd();
}

// ---- types ----

const startsWith = (bytes, sig, at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const MAGIC = Object.freeze({
  'application/pdf': (b) => startsWith(b, ascii('%PDF-')),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  'image/gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))
});

function isText(bytes) {
  if (bytes.includes(0)) return false;
  if (Object.values(MAGIC).some((matches) => matches(bytes))) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const contentMatches = (mime, bytes) => (MAGIC[mime] ? MAGIC[mime](bytes) : isText(bytes));

// The type a file is stored as: its extension decides, a declared mime type
// covers names without one, and the bytes must agree with either.
function sniffType({ name, mime, bytes }) {
  const label = cleanName(name);
  const ext = path.extname(label).slice(1).toLowerCase();
  const declared = String(mime || '').split(';')[0].trim().toLowerCase();
  const shownType = oneLine(declared, 80);
  let type;
  if (ext) {
    type = EXT_MIME[ext];
    if (!type) throw new IngestError('UNSUPPORTED_TYPE', `Cannot ingest ${label}: ${shownType || `.${ext}`} is not supported.`);
  } else {
    type = isAccepted(declared) ? declared : null;
    if (!type) throw new IngestError('UNSUPPORTED_TYPE', `Cannot ingest ${label}: ${shownType || 'a file without a type'} is not supported.`);
  }
  if (!contentMatches(type, bytes)) {
    throw new IngestError('TYPE_MISMATCH', `Cannot ingest ${label}: its contents are not ${ext || MIME_EXTS[type][0]}.`);
  }
  return { mime: type, ext: ext || MIME_EXTS[type][0] };
}

// A limit that is not a number refuses (fail closed).
function checkSize(label, size, maxBytes) {
  if (!(size <= maxBytes)) {
    const mb = (n) => (n / 1048576).toFixed(1);
    throw new IngestError('TOO_LARGE', `Cannot ingest ${cleanName(label)}: it is ${mb(size)} MB; the limit is ${mb(maxBytes)} MB.`);
  }
}

function yearMonth(now, timeZone) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IngestError('BAD_DATE', 'The time a document is stored at must be a valid date.');
  }
  const make = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit' });
  let fmt;
  try {
    fmt = make(timeZone);
  } catch {
    fmt = make('');
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

// ---- paths (M7, M8) ----

// The ingest record of a docId; anything but `doc-` + 12 hex is refused.
function recordPath(caseDir, docId) {
  if (typeof docId !== 'string' || !DOC_ID.test(docId)) {
    throw new IngestError('BAD_DOC_ID', 'A document id looks like doc-3fa1c2d4e5f6.');
  }
  return path.join(caseDir, '.kl', 'ingest', `${docId}.json`);
}

const SIDECAR = /\.meta\.json$/i;
// Non-global copies: `.test` on a /g regex is stateful.
const UNSAFE_REF = new RegExp(`${LINE_BREAKS.source}|${INVISIBLE.source}`);
const underSources = (caseDir, abs) => {
  const segs = segmentsWithin(caseDir, abs);
  return Boolean(segs) && segs.length >= 2 && segs[0] === 'sources' && !SIDECAR.test(segs[segs.length - 1]);
};

// The absolute path of a document ref (`sources/…`, from a record, a sidecar
// or a caller). Refused unless it is a plain relative `/`-path whose first
// segment is `sources`, with no `.`/`..`/empty segment, no `:` (drive
// letters, streams), no backslash (UNC, Windows separators), no control
// character, not a sidecar, and still under sources/ once links and
// junctions on the way are resolved.
function refPath(caseDir, ref) {
  const refuse = () => new IngestError('BAD_PATH', `${oneLine(ref, 200) || 'An empty path'} is not a document under sources/.`);
  if (typeof ref !== 'string' || !ref || ref.length > MAX_REF) throw refuse();
  if (/[\\:\u0000-\u001f\u007f]/.test(ref) || ref.startsWith('/')) throw refuse();
  if (UNSAFE_REF.test(ref)) throw refuse();
  const segs = ref.split('/');
  if (segs[0] !== 'sources' || segs.length < 2) throw refuse();
  if (segs.some((seg) => seg === '' || /^[. ]+$/.test(seg) || /[. ]$/.test(seg))) throw refuse();
  if (SIDECAR.test(segs[segs.length - 1])) throw refuse();
  const abs = path.join(caseDir, ...segs);
  if (!underSources(caseDir, abs)) throw refuse();
  return abs;
}

const toPosix = (p) => p.split(path.sep).join('/');

// The ref of a document this case already holds, from its ingest record:
// only when the record names the same sha256 and the file at its ref still
// holds exactly these bytes (same size, same hash of what is on disk: the
// record's claim alone is not trusted). Otherwise null (the document is
// stored again); a record whose ref is not a confined ref → BAD_PATH.
// `size` bounds the read: the upload is already within maxBytes, and a file
// of any other size cannot hold the same bytes.
function existingRef(caseDir, docId, hash, size) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(recordPath(caseDir, docId), 'utf8'));
  } catch (err) {
    if (err instanceof IngestError) throw err;
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  const file = refPath(caseDir, rec.ref);
  if (rec.sha256 !== hash) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size !== size) return null;
    return sha256(fs.readFileSync(file)) === hash ? rec.ref : null;
  } catch {
    return null;
  }
}

// `wx`: never overwrite, never follow a link planted where the sidecar goes.
function writeSidecar(file, sidecar) {
  fs.writeFileSync(`${file}.meta.json`, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: 'wx' });
}

// Windows device names stay reserved with an extension in older releases,
// and a case repo may be cloned there.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

function storeDocument(caseDir, { name, mime, bytes, origin, now = new Date(), timeZone = '', maxBytes = Infinity, pages = null }) {
  const buf = Buffer.from(bytes);
  const label = cleanName(name);
  checkSize(label, buf.length, maxBytes);
  const type = sniffType({ name: label, mime, bytes: buf });
  const hash = sha256(buf);
  const docId = docIdFor(hash);
  const known = existingRef(caseDir, docId, hash, buf.length);
  if (known) return { docId, ref: known, sha256: hash, duplicate: true, mime: type.mime };
  const folder = `sources/${yearMonth(now, timeZone)}`;
  const stem = path.basename(label, path.extname(label));
  let base = stem.trim() ? slugify(stem) : 'document';
  if (RESERVED.test(base)) base = `doc-${base}`;
  const candidate = (n) => `${folder}/${n === 1 ? base : `${base}-${n}`}.${type.ext}`;
  // Checked before mkdir: a sources/ linked out of the case gets nothing.
  refPath(caseDir, candidate(1));
  try {
    fs.mkdirSync(path.join(caseDir, ...folder.split('/')), { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') throw new IngestError('BAD_PATH', `Cannot ingest ${label}: ${folder} is not a folder.`);
    throw err;
  }
  let ref;
  let file;
  for (let n = 1; ; n += 1) {
    ref = candidate(n);
    file = refPath(caseDir, ref);
    if (fs.existsSync(`${file}.meta.json`)) continue;
    try {
      fs.writeFileSync(file, buf, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  try {
    writeSidecar(file, {
      docId,
      sha256: hash,
      name: label,
      mime: type.mime,
      bytes: buf.length,
      pages,
      origin,
      ingest: `.kl/ingest/${docId}.json`
    });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  return { docId, ref, sha256: hash, duplicate: false, mime: type.mime };
}

// A file already in the case (an executor result, a download): its real
// path relative to the real case directory must be a ref refPath accepts
// (under sources/, not a sidecar, not reached through a link that leaves the
// case), and a regular file. → { real, ref, name, bytes, mime, sha256, docId }; writes nothing.
function resolveAdoptable(caseDir, relPath, { maxBytes = Infinity } = {}) {
  const raw = typeof relPath === 'string' ? stripLongPathPrefix(relPath.trim()) : '';
  const shown = oneLine(relPath, MAX_NAME) || 'that path';
  const refuse = (why) => new IngestError('BAD_PATH', `Cannot ingest ${shown}: ${why}`);
  if (!raw) throw refuse('give a path relative to the case, under sources/.');
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) throw refuse('the path must be relative to the case, under sources/.');
  if (raw.split(/[\\/]/).some((seg) => seg.includes(':'))) throw refuse('alternate data streams are not files.');
  const realCase = realpathNearest(path.resolve(caseDir));
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(realCase, raw));
  } catch {
    throw new IngestError('NOT_FOUND', `Cannot ingest ${shown}: there is no file at that path.`);
  }
  const ref = toPosix(path.relative(realCase, real));
  try {
    refPath(realCase, ref);
  } catch {
    throw refuse('only files under sources/ (not sidecars) can be ingested.');
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw refuse('it is not a regular file.');
  const name = cleanName(path.basename(real));
  checkSize(name, st.size, maxBytes);
  const bytes = fs.readFileSync(real);
  checkSize(name, bytes.length, maxBytes); // the file may have grown since the stat
  const type = sniffType({ name, bytes });
  const hash = sha256(bytes);
  return { real, ref, name, bytes, mime: type.mime, sha256: hash, docId: docIdFor(hash) };
}

function adoptDocument(caseDir, relPath, { origin, now = new Date(), maxBytes = Infinity, pages = null } = {}) {
  const found = resolveAdoptable(caseDir, relPath, { maxBytes });
  const known = existingRef(caseDir, found.docId, found.sha256, found.bytes.length);
  if (known) return { docId: found.docId, ref: known, sha256: found.sha256, duplicate: true, mime: found.mime };
  try {
    writeSidecar(found.real, {
      docId: found.docId,
      sha256: found.sha256,
      name: found.name,
      mime: found.mime,
      bytes: found.bytes.length,
      pages,
      origin: { ...origin, at: origin?.at || now.toISOString() },
      ingest: `.kl/ingest/${found.docId}.json`
    });
  } catch (err) {
    // An existing sidecar is kept as it is.
    if (err.code !== 'EEXIST') throw err;
  }
  return { docId: found.docId, ref: found.ref, sha256: found.sha256, duplicate: false, mime: found.mime };
}

// The sidecar of a document ref; null when there is none. A ref that is not
// confined to sources/, or a sidecar linked out of it, is refused.
function readSidecar(caseDir, ref) {
  const file = `${refPath(caseDir, ref)}.meta.json`;
  const segs = segmentsWithin(caseDir, file);
  if (!segs || segs[0] !== 'sources') throw new IngestError('BAD_PATH', `${oneLine(ref, 200)} is not a document under sources/.`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  ACCEPTED_MIME,
  DOC_ID,
  cleanName,
  sniffType,
  checkSize,
  sha256,
  docIdFor,
  yearMonth,
  recordPath,
  refPath,
  storeDocument,
  resolveAdoptable,
  adoptDocument,
  readSidecar
};
