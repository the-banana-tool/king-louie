// src/cases/ingest/pdf-worker.js
// The PDF worker (ruling Q1, ruling T3b-frames). pdf-sandbox.js spawns it with
// ELECTRON_RUN_AS_NODE=1, a heap ceiling and a minimal env. It opens one
// document with openPdfInProcess (pdf-lib, pdf.js, and the pdf-lib decode
// guard of ruling T3-patch, which is therefore installed only in this
// process) and answers one request at a time. Requests arrive as frames on
// stdin, replies leave as frames on fd 3; stdout is not connected. When the
// parent goes away, stdin ends and the worker exits.
//
// Replies are checked against the same caps the parent enforces, so an
// honest worker answers an over-cap page with UNREADABLE_PDF and stays up.
//
// Test hooks (spin, allocate, forged frames) exist only when the parent set
// KL_PDF_WORKER_TEST_HOOKS=1, which it does only for an explicit
// testHooks: true. They are requests from the parent, never read from a
// document.
const net = require('node:net');
const { openPdfInProcess } = require('./pdf');
const { encodeFrame, FrameReader, LIMITS } = require('./pdf-frames');
const { IngestError } = require('./errors');

const HOOKS = process.env.KL_PDF_WORKER_TEST_HOOKS === '1';
// The document (at most 256 MB, checked by the parent) plus its header.
const REQUEST_MAX_BYTES = 256 * 1024 * 1024 + 4096;

const out = new net.Socket({ fd: 3, readable: false, writable: true });
out.on('error', () => process.exit(1));

const send = (header, payload) => {
  for (const part of encodeFrame(header, payload)) out.write(part);
};

let pdf = null;
let name = 'document.pdf';
const tooLarge = () => new IngestError('UNREADABLE_PDF', `Cannot read ${name}: a page is too large to read.`);

function capped(bytes, max) {
  if (bytes.length > max) throw tooLarge();
  return bytes;
}

function runHook(id, hook) {
  const text = (s) => send({ id, ok: true }, Buffer.from(s, 'utf8'));
  switch (hook) {
    case 'env':
      return text(JSON.stringify(Object.keys(process.env)));
    case 'spin':
      for (;;) { /* never answers */ }
    case 'alloc': {
      const hog = [];
      for (;;) hog.push(new Array(1e5).fill(hog.length));
    }
    case 'exit':
      return process.exit(7);
    case 'oversize': {
      // Declares a reply just over the cap, sends 1 KB of it, and stalls:
      // only a check of the declared length ends the call before the timeout.
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(LIMITS.pageTextBytes + 8192, 0);
      prefix.writeUInt32BE(2, 4);
      out.write(Buffer.concat([prefix, Buffer.from('{}'), Buffer.alloc(1024)]));
      return setInterval(() => {}, 1000);
    }
    case 'oversize-payload':
      return send({ id, ok: true }, Buffer.alloc(LIMITS.pageTextBytes + 1, 0x61));
    case 'bad-json': {
      const junk = Buffer.from('{not json', 'utf8');
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(4 + junk.length, 0);
      prefix.writeUInt32BE(junk.length, 4);
      return out.write(Buffer.concat([prefix, junk]));
    }
    case 'bad-shape':
      return send({ id, ok: 'yes' });
    case 'bad-id':
      return send({ id: id + 1, ok: true });
    case 'bad-code':
      return send({ id, ok: false, code: 'EVERYTHING_FINE', message: 'x' });
    case 'bad-header-length': {
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(4 + 10, 0);
      prefix.writeUInt32BE(1000, 4);
      return out.write(Buffer.concat([prefix, Buffer.alloc(10)]));
    }
    case 'unasked':
      send({ id, ok: true }, Buffer.from('first', 'utf8'));
      return send({ id, ok: true }, Buffer.from('second', 'utf8'));
    case 'partial': {
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(100, 0);
      prefix.writeUInt32BE(2, 4);
      out.end(Buffer.concat([prefix, Buffer.from('{}')]));
      return setInterval(() => {}, 1000);
    }
    case 'forge': {
      // Declares ~4 GB, then streams 512 MB of body.
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(0xfffffff0, 0);
      out.write(prefix);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < 512) {
          sent += 1;
          if (!out.write(chunk)) return out.once('drain', pump);
        }
        return undefined;
      };
      return pump();
    }
    default:
      throw new IngestError('UNREADABLE_PDF', 'unknown hook');
  }
}

async function handle(h, payload) {
  const { id } = h;
  try {
    if (h.op === 'open') {
      if (pdf) throw new IngestError('UNREADABLE_PDF', 'already open');
      if (typeof h.name === 'string') name = h.name;
      if (HOOKS && h.hook) runHook(id, h.hook);
      pdf = await openPdfInProcess(payload, { name, maxStreamBytes: h.maxStreamBytes, maxDocumentBytes: h.maxDocumentBytes });
      if (pdf.pageCount > LIMITS.pages) throw new IngestError('UNREADABLE_PDF', `Cannot read ${name}: it has too many pages.`);
      const rotations = Buffer.alloc(pdf.pageCount);
      for (let n = 1; n <= pdf.pageCount; n += 1) rotations[n - 1] = pdf.pageRotation(n) / 90;
      return send({ id, ok: true, pageCount: pdf.pageCount }, rotations);
    }
    if (h.op === 'hook' && HOOKS) return runHook(id, h.hook);
    if (!pdf) throw new IngestError('UNREADABLE_PDF', 'not open');
    if (h.op === 'text') return send({ id, ok: true }, capped(Buffer.from(await pdf.pageText(h.n), 'utf8'), LIMITS.pageTextBytes));
    if (h.op === 'page') return send({ id, ok: true }, capped(Buffer.from(await pdf.singlePagePdf(h.n)), LIMITS.pagePdfBytes));
    if (h.op === 'image') {
      const img = pdf.pageImage(h.n);
      if (!img) return send({ id, ok: true, image: null });
      return send({ id, ok: true, image: img.mime }, capped(Buffer.from(img.bytes), LIMITS.pageImageBytes));
    }
    throw new IngestError('UNREADABLE_PDF', 'unknown request');
  } catch (err) {
    const known = err instanceof IngestError;
    return send({
      id,
      ok: false,
      code: known ? err.code : 'UNREADABLE_PDF',
      message: known ? err.message : `Cannot read ${name}: it is not a readable PDF.`
    });
  }
}

// One request at a time, in order.
let tail = Promise.resolve();
const reader = new FrameReader({
  limit: (length) => (length > REQUEST_MAX_BYTES ? 'request too large' : null),
  onFrame: (h, payload) => { tail = tail.then(() => handle(h, payload)); },
  onError: () => process.exit(1),
  headerMax: 64 * 1024
});
process.stdin.on('data', (chunk) => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
