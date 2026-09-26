// src/cases/ingest/pdf.js
// PDF access for ingest (cases stage 7 spec §3.2): the text layer through
// unpdf (pdf.js, no canvas), page count, inherited /Rotate, one-page copies
// and single-JPEG page images through pdf-lib. Both are pure JS.
//
// PDFs come from outside and are hostile (ruling M9). openPdf therefore:
// - codes every pdf-lib and pdf.js failure as UNREADABLE_PDF (the parser's
//   own message goes only to the log);
// - bounds every decompression before pdf.js sees a byte: each stream's
//   filter chain is decoded with zlib's maxOutputLength (64 MB per stream,
//   256 MB per document), including the object and xref streams pdf-lib
//   decodes while loading; LZWDecode and filters that cannot be bounded are
//   refused;
// - walks the page tree itself, iteratively, refusing cycles, shared nodes
//   and absurd depth, and points every /Parent back up the walked tree (a
//   lying /Count is ignored: pdf-lib counts leaves, pdf.js recounts, and the
//   two must agree);
// - hands pdf.js the bytes pdf-lib re-serialised from the scanned objects
//   (never the original file, never a URL), with scripting, font loading,
//   fetching and file reads off.
//
// Only the PDF worker parses (ruling Q1, ruling T3b-frames): `openPdf` is
// the sandboxed version from pdf-sandbox.js, and `openPdfInProcess` is the
// parser itself, for the worker's parsing thread (pdf-parse-thread.js) and
// for tests. pdf-lib, unpdf and the process-wide pdf-lib decode guard
// (ruling T3-patch) are loaded on the first openPdfInProcess call, never
// when this module is required, so a process that only requires it (the
// desktop main process, the service) never loads a parser or carries the
// guard.
const zlib = require('node:zlib');
const { AsyncLocalStorage } = require('node:async_hooks');
const { IngestError } = require('./errors');
const { openPdfIsolated } = require('./pdf-sandbox');
const { createLogger } = require('../../logging');

const log = createLogger('cases/ingest/pdf');

const MB = 1024 * 1024;
const MAX_STREAM_BYTES = 64 * MB;
const MAX_DOCUMENT_BYTES = 256 * MB;
const MAX_TREE_DEPTH = 100;
const MAX_FILTERS = 8;

// Every URL-typed option is null, so pdf.js has nowhere to fetch from or read
// a file at (unpdf's own Node defaults resolve pdfjs-dist, which is absent,
// and these override them anyway). `data` is added per call; `url` and
// `range` never are.
const PDFJS_OPTIONS = Object.freeze({
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  enableXfa: false,
  verbosity: 0,
  cMapUrl: null,
  standardFontDataUrl: null,
  wasmUrl: null,
  iccUrl: null,
  useWasm: false,
  docBaseUrl: null
});

// Always 0, 90, 180 or 270, however large the angle.
const normalizeRotation = (angle) => {
  const quarters = Math.round(Number(angle) / 90);
  if (!Number.isFinite(quarters)) return 0;
  return (((quarters % 4) + 4) % 4) * 90;
};

const unreadable = (name) => new IngestError('UNREADABLE_PDF', `Cannot read ${name}: it is not a readable PDF.`);
const tooLarge = (name) => new IngestError('UNREADABLE_PDF', `Cannot read ${name}: the PDF is too large when decompressed.`);
// The filter name comes from the file, so only names this module knows are echoed.
const unsafeFilter = (name, filter) => new IngestError(
  'UNREADABLE_PDF',
  `Cannot read ${name}: the PDF uses a compression (${filter}) that cannot be read safely.`
);

function coded(err, name, stage) {
  if (err instanceof IngestError) return err;
  log.warn('PDF parser failed', { stage, error: String(err?.message || err).slice(0, 500) });
  return unreadable(name);
}

// Injected caps may only lower the defaults.
function capOf(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

class DecodeBudget {
  constructor(name, perStream, perDocument) {
    this.name = name;
    this.perStream = perStream;
    this.remaining = perDocument;
    this.refusal = null;
  }

  cap() {
    return Math.min(this.perStream, this.remaining);
  }

  charge(bytes) {
    if (bytes > this.perStream || bytes > this.remaining) throw tooLarge(this.name);
    this.remaining -= bytes;
  }
}

const FLATE = new Set(['FlateDecode', 'Fl']);
const LZW = new Set(['LZWDecode', 'LZW']);
const BROTLI = new Set(['BrotliDecode']);
const HEX = new Set(['ASCIIHexDecode', 'AHx']);
const A85 = new Set(['ASCII85Decode', 'A85']);
const RUN_LENGTH = new Set(['RunLengthDecode', 'RL']);
// Image codecs: never decoded by the text path (pdf.js getTextContent skips
// images) nor here; allowed only as the last filter of a chain.
const IMAGE = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JPX', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);
const FULL_NAME = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode' };

// pdf.js reads a stream's filters as get('F', 'Filter') and its parameters
// as get('DP', 'DecodeParms'): the short key wins when present. Read them the
// same way so this scan cannot drift from what pdf.js decodes.
function shortFirst(dict, short, long) {
  return dict.has(PDFName.of(short)) ? dict.lookup(PDFName.of(short)) : dict.lookup(PDFName.of(long));
}

function filterChain(dict, name) {
  const filter = shortFirst(dict, 'F', 'Filter');
  const parms = shortFirst(dict, 'DP', 'DecodeParms');
  if (filter === undefined) return [];
  if (filter instanceof PDFName) return [{ filter: filter.decodeText(), parms: parms instanceof PDFDict ? parms : null }];
  if (!(filter instanceof PDFArray) || filter.size() > MAX_FILTERS) throw unsafeFilter(name, 'an unsupported filter');
  const chain = [];
  for (let i = 0; i < filter.size(); i += 1) {
    const one = filter.lookup(i);
    if (!(one instanceof PDFName)) throw unsafeFilter(name, 'an unsupported filter');
    const p = parms instanceof PDFArray && i < parms.size() ? parms.lookup(i) : null;
    chain.push({ filter: one.decodeText(), parms: p instanceof PDFDict ? p : null });
  }
  return chain;
}

// zlib data with the header pdf.js checks; a bad header decodes to nothing in
// pdf.js (it swaps in an empty stream), so it does here. Raw inflate after the
// header ignores the Adler-32 trailer, as pdf.js does; Z_SYNC_FLUSH keeps a
// truncated stream's output. Corrupt deflate data is refused.
function inflateBounded(data, budget) {
  if (data.length < 2) return Buffer.alloc(0);
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) + flg) % 31 !== 0 || (flg & 0x20)) return Buffer.alloc(0);
  return zlibBounded(() => zlib.inflateRawSync(data.subarray(2), {
    maxOutputLength: Math.max(1, budget.cap()),
    finishFlush: zlib.constants.Z_SYNC_FLUSH
  }), budget);
}

function zlibBounded(run, budget) {
  let out;
  try {
    out = run();
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(budget.name);
    throw err;
  }
  budget.charge(out.length);
  return out;
}

// pdf.js allocates one predictor row up front from DecodeParms alone, so an
// absurd /Columns is a memory bomb of its own.
function checkPredictor(parms, budget) {
  if (!parms) return;
  const num = (key, fallback) => {
    const v = parms.lookup(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : fallback;
  };
  if (num('Predictor', 1) <= 1) return;
  const colors = num('Colors', 1);
  const bits = num('BitsPerComponent', 8);
  const columns = num('Columns', 1);
  if (![colors, bits, columns].every((v) => Number.isSafeInteger(v) && v > 0)) throw tooLarge(budget.name);
  budget.charge(Math.ceil((colors * bits * columns) / 8));
}

function runLengthSize(data) {
  let size = 0;
  for (let i = 0; i < data.length;) {
    const b = data[i];
    if (b === 128) break;
    if (b < 128) {
      size += b + 1;
      i += b + 2;
    } else {
      size += 257 - b;
      i += 2;
    }
  }
  return size;
}

// Decodes (bounded) every stage of a stream's filter chain whose output feeds
// another stage or that can expand; throws UNREADABLE_PDF when a stage would
// exceed the caps or cannot be bounded.
function checkStream(dict, contents, budget, context) {
  const chain = filterChain(dict, budget.name);
  let data = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
  chain.forEach(({ filter, parms }, i) => {
    const last = i === chain.length - 1;
    if (FLATE.has(filter)) {
      data = inflateBounded(data, budget);
      checkPredictor(parms, budget);
    } else if (BROTLI.has(filter)) {
      data = zlibBounded(() => zlib.brotliDecompressSync(data, { maxOutputLength: Math.max(1, budget.cap()) }), budget);
    } else if (HEX.has(filter) || A85.has(filter) || RUN_LENGTH.has(filter)) {
      let bound;
      if (HEX.has(filter)) bound = Math.ceil(data.length / 2);
      else if (A85.has(filter)) bound = data.length * 4;
      else bound = runLengthSize(data);
      budget.charge(bound);
      if (!last) {
        const single = context.obj({ Filter: FULL_NAME[filter] || filter });
        data = Buffer.from(decodePDFRawStream({ dict: single, contents: data }).decode());
      }
    } else if (IMAGE.has(filter) && last) {
      // Not decoded anywhere on the text path.
    } else if (LZW.has(filter)) {
      throw unsafeFilter(budget.name, 'LZWDecode');
    } else {
      throw unsafeFilter(budget.name, 'an unsupported filter');
    }
  });
}

// pdf-lib decodes object and xref streams itself while loading, uncapped and
// before any caller can look. Every such decode goes through checkStream
// first, against the budget of the openPdf call that is loading. pdf-lib
// swallows parse errors and keeps going, so the refusal is also recorded on
// the budget and rethrown after load.
const loadScope = new AsyncLocalStorage();
const GUARDED = Symbol.for('king-louie.ingest.pdf-lib-decode-guard');
function installDecodeGuard(ByteStream) {
  if (typeof ByteStream?.fromPDFRawStream !== 'function') throw new Error('pdf-lib ByteStream.fromPDFRawStream not found: the decode guard cannot be installed');
  if (ByteStream.fromPDFRawStream[GUARDED]) return;
  const original = ByteStream.fromPDFRawStream;
  const guarded = (rawStream) => {
    const budget = loadScope.getStore() || new DecodeBudget('document.pdf', MAX_STREAM_BYTES, MAX_DOCUMENT_BYTES);
    try {
      checkStream(rawStream.dict, rawStream.contents, budget, rawStream.dict.context);
    } catch (err) {
      if (!budget.refusal) budget.refusal = err;
      throw err;
    }
    return original(rawStream);
  };
  guarded[GUARDED] = true;
  ByteStream.fromPDFRawStream = guarded;
}

// pdf-lib's names, bound on the first openPdfInProcess call. PDFDocument is
// bound last, after the guard is in place: if installing it throws, every
// later call tries again and throws again (fail closed). pdf-lib is loaded
// with require(): its ESM build is a separate module graph the guard would
// not cover.
let PDFDocument = null;
let PDFName; let PDFDict; let PDFArray; let PDFNumber; let PDFRef; let PDFRawStream;
let PDFInvalidObject; let PDFPageTree; let PDFPageLeaf; let decodePDFRawStream;
let SHORT_KEYS;
function loadParser() {
  if (PDFDocument) return;
  const lib = require('pdf-lib');
  ({
    PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFRawStream,
    PDFInvalidObject, PDFPageTree, PDFPageLeaf, decodePDFRawStream
  } = lib);
  SHORT_KEYS = [PDFName.of('F'), PDFName.of('DP')];
  installDecodeGuard(require('pdf-lib/cjs/core/parser/ByteStream').default);
  PDFDocument = lib.PDFDocument;
}

// Iterative walk of the page tree in document order. Refuses cycles, a node
// reached twice, kids that are neither /Pages nor /Page, and depth beyond
// MAX_TREE_DEPTH; points each kid's /Parent at the node it was reached from,
// so pdf-lib's inherited-attribute lookups climb the walked tree and end.
// Returns each leaf's inherited /Rotate, in page order.
function walkPageTree(doc, name) {
  const { context, catalog } = doc;
  if (!(catalog instanceof PDFDict)) throw unreadable(name);
  const rootRef = catalog.get(PDFName.of('Pages'));
  const root = rootRef instanceof PDFRef ? context.lookup(rootRef) : null;
  if (!(root instanceof PDFPageTree)) throw unreadable(name);
  root.delete(PDFName.of('Parent'));
  const rotateOf = (node, inherited) => {
    const v = node.lookup(PDFName.of('Rotate'));
    return v instanceof PDFNumber ? normalizeRotation(v.asNumber()) : inherited;
  };
  const kidsOf = (node) => {
    const kids = node.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) throw unreadable(name);
    return kids;
  };
  const seen = new Set([root]);
  const rotations = [];
  const stack = [{ ref: rootRef, kids: kidsOf(root), i: 0, rotate: rotateOf(root, 0) }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.kids.size()) {
      stack.pop();
      continue;
    }
    const kidRef = frame.kids.get(frame.i);
    frame.i += 1;
    const kid = kidRef instanceof PDFRef ? context.lookup(kidRef) : null;
    if (!kid || seen.has(kid)) throw unreadable(name);
    seen.add(kid);
    if (kid.get(PDFName.of('Parent')) !== frame.ref) kid.set(PDFName.of('Parent'), frame.ref);
    if (kid instanceof PDFPageLeaf) {
      rotations.push(rotateOf(kid, frame.rotate));
    } else if (kid instanceof PDFPageTree) {
      if (stack.length >= MAX_TREE_DEPTH) throw unreadable(name);
      stack.push({ ref: kidRef, kids: kidsOf(kid), i: 0, rotate: rotateOf(kid, frame.rotate) });
    } else {
      throw unreadable(name);
    }
  }
  return rotations;
}

// Objects pdf-lib could not parse would be written back verbatim and parsed
// by pdf.js unscanned, so they are dropped; every stream left is checked.
// A stream dict with /F or /DP is refused outright (ruling T3-shortkeys):
// the short filter keys belong to inline images, and /F on a stream can also
// be a file specification, which must never be followed.
function scanObjects(context, budget) {
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFInvalidObject) {
      context.delete(ref);
    } else if (obj instanceof PDFRawStream) {
      if (SHORT_KEYS.some((key) => obj.dict.has(key))) throw unsafeFilter(budget.name, 'an unsupported filter');
      checkStream(obj.dict, obj.contents, budget, context);
    }
  }
}

async function readTextLayer(doc, pageCount) {
  const { getDocumentProxy } = require('unpdf');
  const clean = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  // pdf.js may transfer the buffer it is given, so it gets its own copy.
  const proxy = await getDocumentProxy(new Uint8Array(clean), { ...PDFJS_OPTIONS });
  try {
    if (proxy.numPages !== pageCount) throw new Error(`pdf.js counts ${proxy.numPages} pages, the page tree ${pageCount}`);
    const texts = [];
    for (let n = 1; n <= pageCount; n += 1) {
      const page = await proxy.getPage(n);
      const content = await page.getTextContent();
      texts.push(content.items.filter((item) => item.str != null).map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''));
      page.cleanup();
    }
    return texts;
  } finally {
    await proxy.loadingTask.destroy();
  }
}

// The one image a scanned page draws, when it draws exactly one JPEG.
function singleJpeg(doc, page) {
  const resources = page.node.Resources();
  const xobjects = resources ? resources.lookupMaybe(PDFName.of('XObject'), PDFDict) : null;
  if (!xobjects) return null;
  const images = [];
  for (const [, ref] of xobjects.entries()) {
    const obj = doc.context.lookup(ref);
    if (!(obj instanceof PDFRawStream)) continue;
    if (String(obj.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
    images.push(obj);
  }
  if (images.length !== 1) return null;
  const filter = images[0].dict.get(PDFName.of('Filter'));
  if (String(filter) !== '/DCTDecode') return null;
  return { mime: 'image/jpeg', bytes: Buffer.from(images[0].contents) };
}

// In-process parsing: for pdf-parse-thread.js and tests only. Everything else calls
// openPdf, which runs this in the worker.
async function openPdfInProcess(bytes, { name = 'document.pdf', maxStreamBytes, maxDocumentBytes } = {}) {
  if (!(bytes instanceof Uint8Array)) throw unreadable(name);
  loadParser();
  const budget = new DecodeBudget(name, capOf(maxStreamBytes, MAX_STREAM_BYTES), capOf(maxDocumentBytes, MAX_DOCUMENT_BYTES));
  let doc;
  try {
    doc = await loadScope.run(budget, () => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
  } catch (err) {
    throw coded(budget.refusal || err, name, 'load');
  }
  if (doc.isEncrypted) throw new IngestError('ENCRYPTED', `Cannot read ${name}: the PDF is password-protected.`);
  if (budget.refusal) throw coded(budget.refusal, name, 'load');
  let rotations;
  try {
    rotations = walkPageTree(doc, name);
    scanObjects(doc.context, budget);
    if (doc.getPageCount() !== rotations.length) throw new Error('pdf-lib page count disagrees with the walked tree');
  } catch (err) {
    throw coded(err, name, 'scan');
  }
  const pageCount = rotations.length;
  let texts = null;
  const check = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > pageCount) throw new IngestError('BAD_PAGE', `${name} has no page ${n}.`);
  };
  return {
    pageCount,
    async pageText(n) {
      check(n);
      if (!texts) texts = readTextLayer(doc, pageCount).catch((err) => { throw coded(err, name, 'text'); });
      const all = await texts;
      return all[n - 1] || '';
    },
    pageRotation(n) {
      check(n);
      return rotations[n - 1];
    },
    async singlePagePdf(n) {
      check(n);
      try {
        const one = await PDFDocument.create();
        const [copied] = await one.copyPages(doc, [n - 1]);
        one.addPage(copied);
        return await one.save();
      } catch (err) {
        throw coded(err, name, 'copy');
      }
    },
    pageImage(n) {
      check(n);
      try {
        return singleJpeg(doc, doc.getPage(n - 1));
      } catch (err) {
        throw coded(err, name, 'image');
      }
    }
  };
}

module.exports = { openPdf: openPdfIsolated, openPdfInProcess, normalizeRotation, PDFJS_OPTIONS, MAX_STREAM_BYTES, MAX_DOCUMENT_BYTES, MAX_TREE_DEPTH };
