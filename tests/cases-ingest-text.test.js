// tests/cases-ingest-text.test.js
// Text extraction (cases stage 7 spec §3.2): the PDF text layer, textQuality,
// text files, encrypted PDFs, inherited rotation, and the garbage layer.
// Hostile PDFs (ruling M9): parser errors are coded, decompression is capped
// before pdf.js sees a byte, the page tree is walked without recursion, and
// pdf.js never runs document script or fetches anything. Every hostile
// fixture is built in memory here.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fsp = require('node:fs/promises');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, PDFArray } = require('pdf-lib');
const { openPdf, PDFJS_OPTIONS, MAX_STREAM_BYTES, MAX_DOCUMENT_BYTES } = require('../src/cases/ingest/pdf');
const { textQuality, extractPages, parsePages } = require('../src/cases/ingest/extract-text');
const { makePdf, payoffLetterPdf, GARBAGE, tinyJpeg } = require('./helpers/ingest-fixtures');

const LIMITS = { textQualityThreshold: 0.6, maxPages: 500 };
const noVision = async () => { throw new Error('vision must not be called'); };
const KB = 1024;
const unreadable = (err) => err.code === 'UNREADABLE_PDF' && err.name === 'IngestError';

// One page whose content stream is `contents` under `filter`.
async function pdfWithStream(filter, contents, { decodeParms } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const dict = doc.context.obj(decodeParms ? { Filter: filter, DecodeParms: decodeParms } : { Filter: filter });
  page.node.set(PDFName.of('Contents'), doc.context.register(PDFRawStream.of(dict, contents)));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// Reload a fixture, let `edit` rewire it, save it back.
async function rewire(bytes, edit) {
  const doc = await PDFDocument.load(bytes);
  await edit(doc, doc.context);
  return Buffer.from(await doc.save({ useObjectStreams: false, addDefaultPage: false }));
}
const pagesRef = (doc) => doc.catalog.get(PDFName.of('Pages'));
const pageNode = (context, fields) => context.register(context.obj({ Type: 'Pages', ...fields }));

describe('textQuality', () => {
  it('scores ordinary text near 1 and a broken CMap layer below 0.6', () => {
    assert.ok(textQuality('Loan No. 0042-7781 Total payoff amount: $182,340.17') > 0.9);
    assert.ok(textQuality('Lakeside lot, 2.120 acres, Parcel 12-345-678') > 0.9);
    assert.ok(textQuality(GARBAGE) < 0.6);
    assert.ok(textQuality('\uE001\uE002\uE003 \uFFFD\uFFFD abc') < 0.6);
    assert.strictEqual(textQuality(''), 0);
  });
});

describe('parsePages', () => {
  it('reads 1-based ascending ranges', () => {
    assert.deepStrictEqual(parsePages('1-3,7'), [1, 2, 3, 7]);
    assert.deepStrictEqual(parsePages('5'), [5]);
  });

  it('refuses bad grammar, descending ranges, repeats and pages past the end', () => {
    for (const bad of ['0', '3-1', '2,1', '1,1', 'a', '1-', '', '1;2']) {
      assert.throws(() => parsePages(bad), (err) => err.code === 'BAD_PAGES', bad);
    }
    assert.throws(() => parsePages('4', 3), /has 3 page\(s\); page 4 does not exist/);
  });
});

describe('openPdf', () => {
  it('reads the text layer, page count and inherited /Rotate', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'first page words' }, { text: 'second page words' }], rotateRoot: 90 }));
    assert.strictEqual(pdf.pageCount, 2);
    assert.strictEqual((await pdf.pageText(2)).trim(), 'second page words');
    assert.strictEqual(pdf.pageRotation(1), 90);
  });

  it('copies one page with its rotation kept', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'a' }, { text: 'b' }], rotateRoot: 270 }));
    const one = await PDFDocument.load(await pdf.singlePagePdf(2));
    assert.strictEqual(one.getPageCount(), 1);
    assert.strictEqual(one.getPage(0).getRotation().angle, 270);
  });

  it('returns the JPEG a scanned page draws, and null for a text page', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ scan: true }, { text: 'typed page' }] }));
    const img = pdf.pageImage(1);
    assert.strictEqual(img.mime, 'image/jpeg');
    assert.ok(img.bytes.equals(Buffer.from(tinyJpeg())));
    assert.strictEqual(pdf.pageImage(2), null);
  });

  it('refuses an encrypted PDF', async () => {
    await assert.rejects(openPdf(await makePdf({ encrypt: true }), { name: 'locked.pdf' }), (err) => (
      err.code === 'ENCRYPTED' && err.message === 'Cannot read locked.pdf: the PDF is password-protected.'
    ));
  });

  it('refuses an out-of-range page with BAD_PAGE on every accessor', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'a' }, { text: 'b' }] }), { name: 'two.pdf' });
    const badPage = (err) => err.code === 'BAD_PAGE' && err.message === 'two.pdf has no page 3.';
    await assert.rejects(pdf.pageText(3), badPage);
    await assert.rejects(pdf.singlePagePdf(3), badPage);
    assert.throws(() => pdf.pageRotation(3), badPage);
    assert.throws(() => pdf.pageImage(3), badPage);
    for (const n of [0, -1, 1.5, '1', NaN]) await assert.rejects(pdf.pageText(n), (err) => err.code === 'BAD_PAGE', String(n));
  });
});

describe('openPdf on hostile input (ruling M9)', () => {
  it('codes a file pdf-lib cannot parse as UNREADABLE_PDF and keeps the parser message out of it', async () => {
    for (const bytes of [Buffer.from('not a pdf at all'), Buffer.alloc(0), (await makePdf()).subarray(0, 40)]) {
      await assert.rejects(openPdf(bytes, { name: 'x.pdf' }), (err) => unreadable(err) && err.message === 'Cannot read x.pdf: it is not a readable PDF.');
    }
    await assert.rejects(openPdf('JVBERi0xLjcK', { name: 'x.pdf' }), unreadable);
  });

  it('refuses a page tree that contains itself with a coded error, not a RangeError', async () => {
    const selfLoop = await rewire(await makePdf(), (doc) => {
      doc.catalog.Pages().lookup(PDFName.of('Kids'), PDFArray).push(pagesRef(doc));
    });
    await assert.rejects(openPdf(selfLoop, { name: 'loop.pdf' }), unreadable);
    const twoNodeLoop = await rewire(await makePdf(), (doc, context) => {
      const root = pagesRef(doc);
      const inner = pageNode(context, { Parent: root, Count: 1, Kids: [root] });
      doc.catalog.Pages().lookup(PDFName.of('Kids'), PDFArray).push(inner);
    });
    await assert.rejects(openPdf(twoNodeLoop, { name: 'loop.pdf' }), unreadable);
  });

  it('refuses an absurd page count from a shared-kid tree (2^40 leaves) quickly', async () => {
    const bytes = await rewire(await makePdf(), (doc, context) => {
      const root = doc.catalog.Pages();
      let level = root.lookup(PDFName.of('Kids'), PDFArray).get(0);
      for (let i = 1; i <= 40; i += 1) level = pageNode(context, { Kids: [level, level], Count: 2 ** i });
      root.set(PDFName.of('Kids'), context.obj([level]));
      root.set(PDFName.of('Count'), PDFNumber.of(2 ** 40));
    });
    const started = Date.now();
    await assert.rejects(openPdf(bytes, { name: 'dag.pdf' }), unreadable);
    assert.ok(Date.now() - started < 5000);
  });

  it('refuses a page tree deeper than the walk allows', async () => {
    const bytes = await rewire(await makePdf(), (doc, context) => {
      const root = doc.catalog.Pages();
      let level = root.lookup(PDFName.of('Kids'), PDFArray).get(0);
      for (let i = 0; i < 300; i += 1) level = pageNode(context, { Kids: [level], Count: 1 });
      root.set(PDFName.of('Kids'), context.obj([level]));
    });
    await assert.rejects(openPdf(bytes, { name: 'deep.pdf' }), unreadable);
  });

  it('ignores lying /Count values: page count, page text and pdf.js page lookup follow the real tree', async () => {
    const bytes = await rewire(await makePdf({ pages: [{ text: 'first page words' }, { text: 'second page words' }] }), (doc, context) => {
      const rootRef = pagesRef(doc);
      const root = doc.catalog.Pages();
      const [leaf1, leaf2] = [0, 1].map((i) => root.lookup(PDFName.of('Kids'), PDFArray).get(i));
      const t1 = pageNode(context, { Parent: rootRef, Kids: [leaf1], Count: 0 });
      const t2 = pageNode(context, { Parent: rootRef, Kids: [leaf2], Count: 5 });
      context.lookup(leaf1).set(PDFName.of('Parent'), t1);
      context.lookup(leaf2).set(PDFName.of('Parent'), t2);
      root.set(PDFName.of('Kids'), context.obj([t1, t2]));
      root.set(PDFName.of('Count'), PDFNumber.of(1e9));
    });
    const pdf = await openPdf(bytes);
    assert.strictEqual(pdf.pageCount, 2);
    assert.strictEqual((await pdf.pageText(1)).trim(), 'first page words');
    assert.strictEqual((await pdf.pageText(2)).trim(), 'second page words');
  });

  it('repairs a leaf whose /Parent points at itself instead of recursing forever', async () => {
    const bytes = await rewire(await makePdf({ pages: [{ text: 'only page words' }] }), (doc, context) => {
      const leafRef = doc.catalog.Pages().lookup(PDFName.of('Kids'), PDFArray).get(0);
      context.lookup(leafRef).set(PDFName.of('Parent'), leafRef);
    });
    const pdf = await openPdf(bytes);
    assert.strictEqual(pdf.pageRotation(1), 0);
    const one = await PDFDocument.load(await pdf.singlePagePdf(1));
    assert.strictEqual(one.getPageCount(), 1);
    assert.strictEqual((await pdf.pageText(1)).trim(), 'only page words');
  });

  it('drops objects pdf-lib could not parse so their bytes never reach pdf.js unscanned', async () => {
    const fixed = await rewire(await makePdf({ pages: [{ text: 'visible page words' }] }), (doc, context) => {
      const page = doc.getPage(0);
      const font = page.node.Resources().lookup(PDFName.of('Font')).keys()[0].decodeText();
      const hidden = PDFRawStream.of(context.obj({ Filter: 'FlateDecode', KlMark: true }), zlib.deflateSync(Buffer.from(`BT /${font} 10 Tf 20 100 Td (smuggled words) Tj ET`)));
      page.node.lookup(PDFName.of('Contents'), PDFArray).push(context.register(hidden));
    });
    // pdf.js skips a dictionary key that is not a name; pdf-lib cannot parse the object at all.
    const bytes = Buffer.from(fixed.toString('latin1').replace('/KlMark true', '1 2 /KlMark true'), 'latin1');
    const text = await (await openPdf(bytes)).pageText(1);
    assert.match(text, /visible page words/);
    assert.doesNotMatch(text, /smuggled/);
  });

  it('refuses a Flate bomb over an injected per-stream cap before pdf.js sees it', async () => {
    const bomb = await pdfWithStream('FlateDecode', zlib.deflateSync(Buffer.alloc(1024 * KB, 0x20)));
    assert.ok(bomb.length < 8 * KB);
    await assert.rejects(openPdf(bomb, { name: 'bomb.pdf', maxStreamBytes: 64 * KB }), (err) => (
      unreadable(err) && err.message === 'Cannot read bomb.pdf: the PDF is too large when decompressed.'
    ));
    const pdf = await openPdf(bomb, { name: 'bomb.pdf' });
    assert.strictEqual(pdf.pageCount, 1);
  });

  it('caps the decompressed total per document across streams', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([200, 200]);
      const stream = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zlib.deflateSync(Buffer.alloc(48 * KB, 0x20)));
      page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    }
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    await assert.rejects(openPdf(bytes, { maxStreamBytes: 64 * KB, maxDocumentBytes: 64 * KB }), unreadable);
    assert.strictEqual((await openPdf(bytes, { maxStreamBytes: 64 * KB, maxDocumentBytes: 128 * KB })).pageCount, 2);
  });

  it('follows filter chains: a hex-wrapped Flate bomb is caught, a small one opens', async () => {
    const wrap = (raw) => Buffer.from(`${zlib.deflateSync(raw).toString('hex')}>`, 'latin1');
    const bomb = await pdfWithStream(['ASCIIHexDecode', 'FlateDecode'], wrap(Buffer.alloc(1024 * KB, 0x20)));
    await assert.rejects(openPdf(bomb, { maxStreamBytes: 64 * KB }), unreadable);
    const small = await pdfWithStream(['AHx', 'Fl'], wrap(Buffer.from('BT ET')));
    assert.strictEqual((await openPdf(small, { maxStreamBytes: 64 * KB })).pageCount, 1);
  });

  it('caps streams pdf-lib decodes while loading (object streams)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.catalog.set(PDFName.of('KlPad'), doc.context.register(PDFString.of('A'.repeat(1024 * KB))));
    const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
    assert.ok(bytes.length < 16 * KB);
    await assert.rejects(openPdf(bytes, { name: 'objstm.pdf', maxStreamBytes: 64 * KB }), (err) => (
      unreadable(err) && /too large when decompressed/.test(err.message)
    ));
    assert.strictEqual((await openPdf(bytes)).pageCount, 1);
  });

  it('refuses LZWDecode, unknown filters and absurd predictor rows', async () => {
    const lzw = await pdfWithStream('LZWDecode', Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]));
    await assert.rejects(openPdf(lzw, { name: 'lzw.pdf' }), (err) => (
      unreadable(err) && err.message === 'Cannot read lzw.pdf: the PDF uses a compression (LZWDecode) that cannot be read safely.'
    ));
    await assert.rejects(openPdf(await pdfWithStream(['FlateDecode', 'LZW'], zlib.deflateSync(Buffer.from('x')))), unreadable);
    await assert.rejects(openPdf(await pdfWithStream('KlMadeUpDecode', Buffer.from('x')), { name: 'u.pdf' }), (err) => (
      unreadable(err) && err.message === 'Cannot read u.pdf: the PDF uses a compression (an unsupported filter) that cannot be read safely.'
    ));
    const rows = await pdfWithStream('FlateDecode', zlib.deflateSync(Buffer.from('x')), { decodeParms: { Predictor: 12, Columns: 2 ** 30, Colors: 4 } });
    await assert.rejects(openPdf(rows, { maxStreamBytes: 64 * KB }), unreadable);
  });

  it('never runs document JavaScript or an OpenAction, and pdf.js fetches and reads nothing', async () => {
    const bytes = await rewire(await makePdf({ pages: [{ text: 'script bearing page words' }] }), (doc, context) => {
      const js = (code) => context.obj({ S: 'JavaScript', JS: PDFString.of(code) });
      doc.catalog.set(PDFName.of('OpenAction'), js('globalThis.__klPdfScriptRan = "open";'));
      doc.catalog.set(PDFName.of('AA'), context.obj({ WC: js('globalThis.__klPdfScriptRan = "aa";') }));
      doc.catalog.set(PDFName.of('Names'), context.obj({
        JavaScript: context.obj({ Names: [PDFString.of('kl'), js('globalThis.__klPdfScriptRan = "names";')] })
      }));
      const leaf = context.lookup(doc.catalog.Pages().lookup(PDFName.of('Kids'), PDFArray).get(0));
      leaf.set(PDFName.of('AA'), context.obj({ O: js('globalThis.__klPdfScriptRan = "page";') }));
      leaf.set(PDFName.of('Annots'), context.obj([context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50],
        A: context.obj({ S: 'URI', URI: PDFString.of('https://records.example.org/track') })
      })]));
    });
    const fetched = [];
    const read = [];
    const realFetch = globalThis.fetch;
    const realReadFile = fsp.readFile;
    globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error('no fetch in tests'); };
    fsp.readFile = async (file, ...rest) => { read.push(String(file)); return realReadFile(file, ...rest); };
    try {
      const pdf = await openPdf(bytes);
      assert.strictEqual((await pdf.pageText(1)).trim(), 'script bearing page words');
      await pdf.singlePagePdf(1);
      pdf.pageImage(1);
    } finally {
      globalThis.fetch = realFetch;
      fsp.readFile = realReadFile;
    }
    assert.strictEqual(globalThis.__klPdfScriptRan, undefined);
    assert.deepStrictEqual(fetched, []);
    assert.deepStrictEqual(read, []);
  });

  it('hands pdf.js hardened options with no URL anywhere', () => {
    assert.ok(Object.isFrozen(PDFJS_OPTIONS));
    for (const [key, value] of Object.entries({
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, enableXfa: false, verbosity: 0,
      cMapUrl: null, standardFontDataUrl: null, wasmUrl: null, iccUrl: null
    })) assert.strictEqual(PDFJS_OPTIONS[key], value, key);
    for (const key of ['url', 'range', 'data']) assert.ok(!(key in PDFJS_OPTIONS), key);
    assert.strictEqual(MAX_STREAM_BYTES, 64 * 1024 * 1024);
    assert.strictEqual(MAX_DOCUMENT_BYTES, 256 * 1024 * 1024);
  });

  it('never lets an injected cap raise the limit above the default', async () => {
    const overDefault = await pdfWithStream('FlateDecode', zlib.deflateSync(Buffer.alloc(MAX_STREAM_BYTES + 1)));
    for (const maxStreamBytes of [2 ** 40, Infinity, 'lots', undefined]) {
      await assert.rejects(openPdf(overDefault, { maxStreamBytes, maxDocumentBytes: 2 ** 40 }), unreadable, String(maxStreamBytes));
    }
  });
});

describe('extractPages', () => {
  it('reads a PDF text layer without calling vision', async () => {
    const bytes = await payoffLetterPdf();
    const r = await extractPages({ bytes, mime: 'application/pdf', name: 'payoff-letter.pdf' }, { pdf: await openPdf(bytes), readPage: noVision, limits: LIMITS });
    assert.strictEqual(r.pageCount, 1);
    assert.strictEqual(r.pages[0].method, 'text');
    assert.match(r.pages[0].text, /Total payoff amount: \$182,340\.17/);
    assert.ok(r.pages[0].quality > 0.9);
  });

  it('reads text, markdown and CSV files as one text page', async () => {
    for (const [mime, body] of [['text/plain', 'Lakeside lot notes'], ['text/markdown', '# Lakeside lot\n\n- 2.120 acres'], ['text/csv', 'parcel,acres\n12-345-678,2.120']]) {
      const r = await extractPages({ bytes: Buffer.from(body), mime, name: 'x' }, { readPage: noVision, limits: LIMITS });
      assert.deepStrictEqual(r.pages, [{ n: 1, method: 'text', text: body, quality: textQuality(body), rotation: 0 }]);
    }
  });

  it('garbage layer: only page 2 goes to vision and comes back as ocr', async () => {
    const bytes = await makePdf({ pages: [{ text: 'An ordinary typed page about the Lakeside lot survey.' }, { text: GARBAGE }] });
    const asked = [];
    const readPage = async (n, opts) => {
      asked.push({ n, ...opts });
      return { method: 'ocr', text: 'Lakeside lot, 2.120 acres', usd: 0.01, model: 'anthropic:test' };
    };
    const r = await extractPages({ bytes, mime: 'application/pdf', name: 'plat.pdf' }, { pdf: await openPdf(bytes), readPage, limits: LIMITS });
    assert.deepStrictEqual(asked, [{ n: 2, rotation: 0, reason: 'garbage' }]);
    assert.strictEqual(r.pages[0].method, 'text');
    assert.strictEqual(r.pages[1].method, 'ocr');
    assert.ok(r.pages[1].quality < 0.6);
    assert.strictEqual(r.pages[1].text, 'Lakeside lot, 2.120 acres');
  });

  it('a page with no text layer goes to vision as no-text; pending and unreadable results pass through', async () => {
    const bytes = await makePdf({ pages: [{ scan: true }, { scan: true }] });
    const readPage = async (n) => (n === 1 ? { method: 'pending-ocr', error: 'cap' } : { method: 'unreadable', error: 'page too large for vision' });
    const r = await extractPages({ bytes, mime: 'application/pdf', name: 's.pdf' }, { pdf: await openPdf(bytes), readPage, limits: LIMITS });
    assert.deepStrictEqual(r.pages.map((p) => [p.n, p.method, p.error]), [[1, 'pending-ocr', 'cap'], [2, 'unreadable', 'page too large for vision']]);
  });

  it('reads only the requested pages and refuses PDFs over maxPages', async () => {
    const bytes = await makePdf({ pages: [{ text: 'page one has enough words here' }, { text: 'page two has enough words here' }, { text: 'page three has enough words' }] });
    const pdf = await openPdf(bytes);
    const r = await extractPages({ bytes, mime: 'application/pdf', name: 'x.pdf' }, { pdf, readPage: noVision, limits: LIMITS, pages: [2] });
    assert.deepStrictEqual(r.pages.map((p) => p.n), [2]);
    await assert.rejects(
      extractPages({ bytes, mime: 'application/pdf', name: 'x.pdf' }, { pdf, readPage: noVision, limits: { ...LIMITS, maxPages: 2 } }),
      (err) => err.code === 'TOO_MANY_PAGES'
    );
  });

  it('marks an image over 5 MB unreadable without calling vision', async () => {
    const bytes = Buffer.concat([Buffer.from(tinyJpeg()), Buffer.alloc(5 * 1024 * 1024)]);
    const r = await extractPages({ bytes, mime: 'image/jpeg', name: 'big.jpg' }, { readPage: noVision, limits: LIMITS });
    assert.deepStrictEqual(r.pages, [{ n: 1, method: 'unreadable', text: '', rotation: 0, error: 'page too large for vision' }]);
  });
});
