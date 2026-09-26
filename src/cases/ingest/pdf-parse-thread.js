// src/cases/ingest/pdf-parse-thread.js
// The parsing thread of the PDF worker (ruling T3b-orphan). pdf-worker.js runs
// this in a worker_threads Worker with resourceLimits, so a pdf.js loop or a
// heap blow-up here never blocks the worker's main thread, which keeps
// watching stdin, the parent pid and its own per-call deadline. This thread
// alone loads pdf-lib and unpdf (openPdfInProcess), so the pdf-lib decode
// guard of ruling T3-patch lives only here.
//
// Messages in: { header, payload }. Messages out: { header, payload }, which
// the main thread writes to the parent as one frame. Replies are checked
// against the parent's caps, so an honest over-cap page is UNREADABLE_PDF.
const { parentPort } = require('node:worker_threads');
const { openPdfInProcess } = require('./pdf');
const { LIMITS } = require('./pdf-frames');
const { IngestError } = require('./errors');

// Set by pdf-worker.js from its env, which the parent sets only for an
// explicit testHooks: true.
const HOOKS = require('node:worker_threads').workerData?.hooks === true;

let pdf = null;
let name = 'document.pdf';

const reply = (header, payload = null) => parentPort.postMessage({ header, payload });

function capped(bytes, max) {
  if (bytes.length > max) throw new IngestError('UNREADABLE_PDF', `Cannot read ${name}: a page is too large to read.`);
  return bytes;
}

// Hooks that must run on the parsing thread: they block it or exhaust its heap.
function threadHook(hook) {
  if (hook === 'spin') for (;;) { /* never answers */ }
  if (hook === 'alloc') {
    const hog = [];
    for (;;) hog.push(new Array(1e5).fill(hog.length));
  }
  throw new IngestError('UNREADABLE_PDF', 'unknown hook');
}

async function handle(h, payload) {
  const { id } = h;
  try {
    if (h.op === 'open') {
      if (pdf) throw new IngestError('UNREADABLE_PDF', 'already open');
      if (typeof h.name === 'string') name = h.name;
      if (HOOKS && h.hook) threadHook(h.hook);
      pdf = await openPdfInProcess(payload, { name, maxStreamBytes: h.maxStreamBytes, maxDocumentBytes: h.maxDocumentBytes });
      if (pdf.pageCount > LIMITS.pages) throw new IngestError('UNREADABLE_PDF', `Cannot read ${name}: it has too many pages.`);
      const rotations = new Uint8Array(pdf.pageCount);
      for (let n = 1; n <= pdf.pageCount; n += 1) rotations[n - 1] = pdf.pageRotation(n) / 90;
      return reply({ id, ok: true, pageCount: pdf.pageCount }, rotations);
    }
    if (h.op === 'hook' && HOOKS) return threadHook(h.hook);
    if (!pdf) throw new IngestError('UNREADABLE_PDF', 'not open');
    if (h.op === 'text') return reply({ id, ok: true }, capped(Buffer.from(await pdf.pageText(h.n), 'utf8'), LIMITS.pageTextBytes));
    if (h.op === 'page') return reply({ id, ok: true }, capped(await pdf.singlePagePdf(h.n), LIMITS.pagePdfBytes));
    if (h.op === 'image') {
      const img = pdf.pageImage(h.n);
      if (!img) return reply({ id, ok: true, image: null });
      return reply({ id, ok: true, image: img.mime }, capped(img.bytes, LIMITS.pageImageBytes));
    }
    throw new IngestError('UNREADABLE_PDF', 'unknown request');
  } catch (err) {
    const known = err instanceof IngestError;
    return reply({
      id,
      ok: false,
      code: known ? err.code : 'UNREADABLE_PDF',
      message: known ? err.message : `Cannot read ${name}: it is not a readable PDF.`
    });
  }
}

let tail = Promise.resolve();
parentPort.on('message', ({ header, payload }) => {
  tail = tail.then(() => handle(header, payload));
});
