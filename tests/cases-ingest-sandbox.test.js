// tests/cases-ingest-sandbox.test.js
// PDF parsing out of process (ruling Q1, ruling T3b-frames): openPdf runs
// pdf-lib and pdf.js in a spawned child with a heap ceiling, wall-clock
// timeouts, at most two children, an idle timeout, and length-prefixed
// frames on stdin / fd 3 whose declared length is checked before the body is
// read. The misbehaving-child cases use worker test hooks, which exist only
// when the caller passes testHooks: true.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { openPdf } = require('../src/cases/ingest/pdf');
const sandbox = require('../src/cases/ingest/pdf-sandbox');
const { makePdf, tinyJpeg } = require('./helpers/ingest-fixtures');
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const zlib = require('node:zlib');

const { openPdfIsolated, shutdownPdfSandbox, LIMITS } = sandbox;
const KB = 1024;
const MB = 1024 * KB;

after(() => shutdownPdfSandbox());

// Records every child the sandbox spawns.
function recorder() {
  const children = [];
  const spawn = (...args) => {
    const child = childProcess.spawn(...args);
    children.push({ child, args });
    return child;
  };
  return { spawn, children };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const failed = (err) => err.code === 'PDF_WORKER_FAILED' && err.name === 'IngestError';

describe('openPdf (isolated)', () => {
  it('is the sandboxed version and gives the in-process results for normal files', async () => {
    assert.strictEqual(openPdf, openPdfIsolated);
    const rec = recorder();
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'first page words' }, { text: 'second page words' }], rotateRoot: 90 }), { spawn: rec.spawn });
    try {
      assert.strictEqual(rec.children.length, 1);
      assert.strictEqual(pdf.pageCount, 2);
      assert.strictEqual((await pdf.pageText(2)).trim(), 'second page words');
      assert.strictEqual((await pdf.pageText(1)).trim(), 'first page words');
      assert.strictEqual(pdf.pageRotation(1), 90);
      const one = await PDFDocument.load(await pdf.singlePagePdf(2));
      assert.strictEqual(one.getPageCount(), 1);
      assert.strictEqual(one.getPage(0).getRotation().angle, 90);
      assert.strictEqual(await pdf.pageImage(1), null);
    } finally {
      await pdf.close();
    }
    assert.strictEqual(alive(rec.children[0].child.pid), false);
  });

  it('returns the JPEG a scanned page draws', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ scan: true }, { text: 'typed page' }] }));
    try {
      const img = await pdf.pageImage(1);
      assert.strictEqual(img.mime, 'image/jpeg');
      assert.ok(Buffer.from(img.bytes).equals(Buffer.from(tinyJpeg())));
      assert.strictEqual(await pdf.pageImage(2), null);
    } finally {
      await pdf.close();
    }
  });

  it('carries ENCRYPTED, UNREADABLE_PDF and BAD_PAGE across the boundary', async () => {
    await assert.rejects(openPdf(await makePdf({ encrypt: true }), { name: 'locked.pdf' }), (err) => (
      err.code === 'ENCRYPTED' && err.message === 'Cannot read locked.pdf: the PDF is password-protected.'
    ));
    await assert.rejects(openPdf(Buffer.from('not a pdf at all'), { name: 'junk.pdf' }), (err) => err.code === 'UNREADABLE_PDF');
    // A small bomb under an injected cap.
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const bomb = zlib.deflateSync(Buffer.alloc(4 * MB));
    page.node.set(PDFName.of('Contents'), doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), bomb)));
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    await assert.rejects(openPdf(bytes, { name: 'bomb.pdf', maxStreamBytes: 64 * KB }), (err) => (
      err.code === 'UNREADABLE_PDF' && /too large when decompressed/.test(err.message)
    ));
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'a' }, { text: 'b' }] }), { name: 'two.pdf' });
    try {
      const badPage = (err) => err.code === 'BAD_PAGE' && err.message === 'two.pdf has no page 3.';
      await assert.rejects(pdf.pageText(3), badPage);
      await assert.rejects(pdf.singlePagePdf(3), badPage);
      await assert.rejects(pdf.pageImage(3), badPage);
      assert.throws(() => pdf.pageRotation(3), badPage);
      for (const n of [0, -1, 1.5, '1', NaN]) await assert.rejects(pdf.pageText(n), (err) => err.code === 'BAD_PAGE', String(n));
      assert.strictEqual((await pdf.pageText(1)).trim(), 'a');
    } finally {
      await pdf.close();
    }
  });

  it('refuses input over the caller limit before spawning anything', async () => {
    const rec = recorder();
    await assert.rejects(openPdf(Buffer.alloc(2 * KB), { name: 'big.pdf', maxBytes: KB, spawn: rec.spawn }), (err) => err.code === 'UNREADABLE_PDF');
    await assert.rejects(openPdf('not bytes', { spawn: rec.spawn }), (err) => err.code === 'UNREADABLE_PDF');
    assert.strictEqual(rec.children.length, 0);
  });

  it('spawns the worker with a heap ceiling, no IPC channel and an allowlisted env', async () => {
    process.env.KL_SANDBOX_TEST_SECRET = 'must-not-leak';
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, memoryMb: 96, testHooks: true });
    try {
      const [file, args, opts] = rec.children[0].args;
      assert.strictEqual(file, process.execPath);
      assert.ok(args.includes('--max-old-space-size=96'), args.join(' '));
      assert.ok(!opts.stdio.includes('ipc'));
      assert.strictEqual(opts.env.ELECTRON_RUN_AS_NODE, '1');
      const keys = JSON.parse(await pdf._testHook('env'));
      const allowed = new Set(['ELECTRON_RUN_AS_NODE', 'SYSTEMROOT', 'KL_PDF_WORKER_TEST_HOOKS']);
      // libuv copies these into every child's env on Windows when they are
      // missing (its required_vars); none of them is a credential.
      if (process.platform === 'win32') {
        for (const k of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) allowed.add(k);
      }
      assert.deepStrictEqual(Object.keys(opts.env).sort(), ['ELECTRON_RUN_AS_NODE', 'KL_PDF_WORKER_TEST_HOOKS', ...(process.env.SYSTEMROOT ? ['SYSTEMROOT'] : [])]);
      assert.ok(!keys.includes('KL_SANDBOX_TEST_SECRET'));
      assert.deepStrictEqual(keys.filter((k) => !allowed.has(k.toUpperCase())), []);
      assert.ok(keys.includes('ELECTRON_RUN_AS_NODE'));
    } finally {
      delete process.env.KL_SANDBOX_TEST_SECRET;
      await pdf.close();
    }
  });

  it('never installs the pdf-lib wrap or loads unpdf in the parent', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'wrap check page' }] }));
    try {
      assert.match(await pdf.pageText(1), /wrap check page/);
    } finally {
      await pdf.close();
    }
    const ByteStream = require('pdf-lib/cjs/core/parser/ByteStream').default;
    assert.strictEqual(ByteStream.fromPDFRawStream[Symbol.for('king-louie.ingest.pdf-lib-decode-guard')], undefined);
    assert.deepStrictEqual(Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/]unpdf[\\/]/.test(k)), []);
  });

  it('keeps openPdfInProcess to the worker', () => {
    const dir = path.join(__dirname, '..', 'src');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []
    ));
    const users = walk(dir)
      .filter((f) => /openPdfInProcess/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(dir, f).split(path.sep).join('/'))
      .sort();
    assert.deepStrictEqual(users, ['cases/ingest/pdf-parse-thread.js', 'cases/ingest/pdf.js']);
  });
});

describe('the worker process on its own (ruling T3b-orphan)', () => {
  const { encodeFrame } = require('../src/cases/ingest/pdf-frames');
  const { runWorker } = require('../src/cases/ingest/pdf-worker');
  const WORKER = path.join(__dirname, '..', 'src', 'cases', 'ingest', 'pdf-worker.js');

  // A worker with hooks on, the document open, and a spinning parser.
  async function spinningWorker(t, deadlineMs) {
    const child = childProcess.spawn(process.execPath, [WORKER], {
      env: { ELECTRON_RUN_AS_NODE: '1', SYSTEMROOT: process.env.SYSTEMROOT || '', KL_PDF_WORKER_TEST_HOOKS: '1' },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe']
    });
    t.after(() => child.kill('SIGKILL'));
    const exited = new Promise((r) => child.once('exit', () => r(Date.now())));
    let got = 0;
    child.stdio[3].on('data', () => { got += 1; });
    for (const part of encodeFrame({ id: 1, op: 'open', name: 'x.pdf', deadlineMs: 30000 }, await makePdf())) child.stdin.write(part);
    assert.ok(await waitFor(() => got > 0), 'open answered');
    for (const part of encodeFrame({ id: 2, op: 'hook', hook: 'spin', deadlineMs })) child.stdin.write(part);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(child.pid), 'still running while the parser spins');
    return { child, exited };
  }

  it('exits when stdin closes, even while the parser spins', async (t) => {
    const { child, exited } = await spinningWorker(t, 60000);
    const t0 = Date.now();
    child.stdin.end();
    const at = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(at && at - t0 < 5000, 'exited after stdin closed');
  });

  it('exits on its own deadline when nobody kills it', async (t) => {
    const { exited } = await spinningWorker(t, 600);
    const at = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(at, 'exited on its deadline');
  });

  it('exits when the parent pid changes or the parent is gone', async () => {
    const { PassThrough } = require('node:stream');
    for (const [getPpid, isAlive] of [
      [(() => { let n = 0; return () => (n++ === 0 ? 4242 : 1); })(), () => true],
      [() => 4242, () => false]
    ]) {
      const codes = [];
      const input = new PassThrough();
      const w = runWorker({ input, write: () => {}, exit: (c) => codes.push(c), getPpid, isAlive, pollMs: 10, createThread: () => { throw new Error('no thread expected'); } });
      assert.ok(await waitFor(() => codes.length === 1), 'exited');
      w.stop(0);
      assert.deepStrictEqual(codes, [0]);
    }
  });
});

describe('openPdf sandbox limits', () => {
  it('kills a spinning child with PDF_TIMEOUT and fails every later call without respawning', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, timeouts: { call: 300 } });
    const { pid } = rec.children[0].child;
    const t0 = Date.now();
    await assert.rejects(pdf._testHook('spin'), (err) => err.code === 'PDF_TIMEOUT');
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(await waitFor(() => !alive(pid)), 'the child is gone');
    await assert.rejects(pdf.pageText(1), failed);
    await assert.rejects(pdf.singlePagePdf(1), failed);
    assert.strictEqual(rec.children.length, 1);
    await pdf.close();
  });

  it('kills a child that spins while opening with PDF_TIMEOUT', async () => {
    const rec = recorder();
    await assert.rejects(
      openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, testOpenHook: 'spin', timeouts: { open: 300 } }),
      (err) => err.code === 'PDF_TIMEOUT'
    );
    assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)));
  });

  it('turns a heap blow-up into PDF_WORKER_FAILED and keeps running', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, memoryMb: 64, timeouts: { call: 20000 } });
    await assert.rejects(pdf._testHook('alloc'), failed);
    assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)));
    await assert.rejects(pdf.pageText(1), failed);
    await pdf.close();
    const again = await openPdf(await makePdf({ pages: [{ text: 'still here' }] }));
    try {
      assert.match(await again.pageText(1), /still here/);
    } finally {
      await again.close();
    }
  });

  it('fails a child that exits mid-call with PDF_WORKER_FAILED', async () => {
    const pdf = await openPdf(await makePdf(), { testHooks: true });
    await assert.rejects(pdf._testHook('exit'), failed);
    await pdf.close();
  });

  it('turns an over-cap reply into UNREADABLE_PDF and kills the child', async () => {
    for (const hook of ['oversize', 'oversize-payload']) {
      const rec = recorder();
      const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, timeouts: { call: 10000 } });
      // A protocol break fails the document; it is never a soft "page too large".
      await assert.rejects(pdf._testHook(hook), (err) => err.code === 'UNREADABLE_PDF' && err.tooLarge !== true, hook);
      assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)), hook);
      await assert.rejects(pdf.pageText(1), failed, hook);
      await pdf.close();
    }
  });

  it('turns a malformed reply into PDF_WORKER_FAILED', async () => {
    for (const hook of ['bad-json', 'bad-shape', 'bad-id', 'bad-code', 'bad-header-length']) {
      const rec = recorder();
      const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, timeouts: { call: 5000 } });
      await assert.rejects(pdf._testHook(hook), failed, hook);
      assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)), hook);
      await pdf.close();
    }
  });

  it('fails the document when the child sends a frame nobody asked for', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true });
    assert.strictEqual(await pdf._testHook('unasked'), 'first');
    assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)));
    await assert.rejects(pdf.pageText(1), failed);
    await pdf.close();
  });

  it('fails a partial frame at end of stream with PDF_WORKER_FAILED, without waiting for the timeout', async () => {
    const pdf = await openPdf(await makePdf(), { testHooks: true, timeouts: { call: 15000 } });
    const t0 = Date.now();
    await assert.rejects(pdf._testHook('partial'), failed);
    assert.ok(Date.now() - t0 < 10000);
    await pdf.close();
  });

  it('never allocates a forged huge reply: the child is killed and the call fails', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, testHooks: true, timeouts: { call: 15000 } });
    global.gc?.();
    const before = process.memoryUsage();
    await assert.rejects(pdf._testHook('forge'), failed);
    const after = process.memoryUsage();
    assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)));
    // The forging child declares ~4 GB and streams 512 MB after the header.
    assert.ok(after.rss - before.rss < 128 * MB, `rss grew ${(after.rss - before.rss) / MB} MB`);
    assert.ok(after.arrayBuffers - before.arrayBuffers < 64 * MB, `arrayBuffers grew ${(after.arrayBuffers - before.arrayBuffers) / MB} MB`);
    await pdf.close();
  });

  // About 262k one-byte writes: ~5.5 s alone, but over 60 s under a loaded
  // full suite on Windows (final review I2). The drip stays one byte per
  // write, since the per-chunk memory bug it catches scales with the number
  // of writes; the test gets its own, longer budget instead.
  it('keeps a reply dripped one byte per write to about its own size in memory', { timeout: 240000 }, async () => {
    const pdf = await openPdf(await makePdf(), { testHooks: true, timeouts: { call: 200000 } });
    try {
      global.gc?.();
      const base = process.memoryUsage();
      let peakRss = 0;
      let peakAb = 0;
      const sampler = setInterval(() => {
        const m = process.memoryUsage();
        peakRss = Math.max(peakRss, m.rss - base.rss);
        peakAb = Math.max(peakAb, m.arrayBuffers - base.arrayBuffers);
      }, 5);
      const t0 = Date.now();
      const text = await pdf._testHook('drip').finally(() => clearInterval(sampler));
      assert.strictEqual(text.length, 256 * KB);
      // The frame is 256 KB (small, so the one-byte writes take seconds, not
      // most of the call timeout). Keeping every chunk instead of one
      // preallocated body peaked at ~165 MB rss here; the fix stays ~18 MB.
      assert.ok(peakAb < 2 * MB, `arrayBuffers peaked ${(peakAb / MB).toFixed(1)} MB over ${Date.now() - t0} ms`);
      assert.ok(peakRss < 48 * MB, `rss peaked ${(peakRss / MB).toFixed(1)} MB`);
    } finally {
      await pdf.close();
    }
  });

  it('refuses test hooks unless the caller asked for them', async () => {
    const pdf = await openPdf(await makePdf());
    try {
      assert.strictEqual(pdf._testHook, undefined);
    } finally {
      await pdf.close();
    }
  });

  it('the worker itself refuses hook requests unless its env enables them', async (t) => {
    const { encodeFrame, FrameReader } = require('../src/cases/ingest/pdf-frames');
    const worker = path.join(__dirname, '..', 'src', 'cases', 'ingest', 'pdf-worker.js');
    const child = childProcess.spawn(process.execPath, [worker], {
      env: { ELECTRON_RUN_AS_NODE: '1', SYSTEMROOT: process.env.SYSTEMROOT || '' },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe']
    });
    t.after(() => child.kill('SIGKILL'));
    const replies = [];
    const reader = new FrameReader({ limit: () => null, onFrame: (h, p) => replies.push({ h, p }), onError: () => {} });
    child.stdio[3].on('data', (c) => reader.push(c));
    const bytes = await makePdf();
    for (const part of encodeFrame({ id: 1, op: 'open', name: 'x.pdf' }, bytes)) child.stdin.write(part);
    for (const part of encodeFrame({ id: 2, op: 'hook', hook: 'env' })) child.stdin.write(part);
    assert.ok(await waitFor(() => replies.length === 2));
    assert.strictEqual(replies[0].h.ok, true);
    assert.strictEqual(replies[1].h.ok, false);
    assert.strictEqual(replies[1].h.code, 'UNREADABLE_PDF');
  });

  it('refuses starts beyond the waiting bound, and copies bytes only once a slot is free', async () => {
    const a = await openPdf(await makePdf());
    const b = await openPdf(await makePdf());
    const queued = [];
    for (let i = 0; i < sandbox.MAX_WAITING; i += 1) {
      queued.push(openPdf(await makePdf(), {}).then((d) => d.close(), (err) => err));
    }
    const lateBytes = await makePdf();
    const late = openPdf(lateBytes).then(() => null, (err) => err);
    const refused = await Promise.race([late, new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
    assert.ok(refused instanceof Error && failed(refused), String(refused));
    // A queued start reads the caller's bytes when its slot comes, not before.
    await Promise.all([a.close(), b.close()]);
    const results = await Promise.all(queued);
    assert.ok(results.every((r) => r === undefined), results.map(String).join());
    const c = await openPdf(await makePdf());
    const d = await openPdf(await makePdf());
    const bytes = await makePdf({ pages: [{ text: 'queued document' }] });
    const q = openPdf(bytes).then((x) => x, (err) => err);
    await new Promise((r) => setTimeout(r, 100));
    bytes.fill(0);
    await c.close();
    const qResult = await q;
    assert.strictEqual(qResult.code, 'UNREADABLE_PDF');
    await d.close();
  });

  it('turns a throwing spawn or a child without pipes into PDF_WORKER_FAILED and frees the slot', async () => {
    const EventEmitter = require('node:events');
    const throwing = () => { throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }); };
    const pipeless = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: undefined, stdin: null, stderr: null, stdio: [null, null, null, null], kill: () => false });
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENFILE'), { code: 'ENFILE' })));
      return child;
    };
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(openPdf(await makePdf(), { spawn: throwing }), failed);
      await assert.rejects(openPdf(await makePdf(), { spawn: pipeless }), failed);
    }
    const a = await openPdf(await makePdf());
    const b = await openPdf(await makePdf());
    await Promise.all([a.close(), b.close()]);
  });

  it('never restarts a document that was idle when the sandbox shut down', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf(), { spawn: rec.spawn, timeouts: { idle: 100 } });
    assert.ok(await waitFor(() => !alive(rec.children[0].child.pid)));
    await shutdownPdfSandbox();
    await assert.rejects(pdf.pageText(1), failed);
    assert.strictEqual(rec.children.length, 1);
  });

  it('runs at most two children at once; further opens queue', async () => {
    const rec = recorder();
    const a = await openPdf(await makePdf(), { spawn: rec.spawn });
    const b = await openPdf(await makePdf(), { spawn: rec.spawn });
    let cDone = false;
    const cP = openPdf(await makePdf({ pages: [{ text: 'third document' }] }), { spawn: rec.spawn }).then((c) => {
      cDone = true;
      return c;
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(cDone, false);
    assert.strictEqual(rec.children.length, 2);
    await a.close();
    const c = await cP;
    assert.strictEqual(rec.children.length, 3);
    assert.match(await c.pageText(1), /third document/);
    await Promise.all([b.close(), c.close()]);
  });

  it('kills an idle child, and a later call starts a fresh one', async () => {
    const rec = recorder();
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'idle page' }], rotateRoot: 180 }), { spawn: rec.spawn, timeouts: { idle: 200 } });
    const { pid } = rec.children[0].child;
    assert.ok(await waitFor(() => !alive(pid)), 'the idle child is gone');
    assert.strictEqual(pdf.pageRotation(1), 180);
    assert.match(await pdf.pageText(1), /idle page/);
    assert.strictEqual(rec.children.length, 2);
    await pdf.close();
    assert.strictEqual(alive(rec.children[1].child.pid), false);
  });

  it('shutdownPdfSandbox kills every child and fails queued opens', async () => {
    const rec = recorder();
    const a = await openPdf(await makePdf(), { spawn: rec.spawn });
    const b = await openPdf(await makePdf(), { spawn: rec.spawn });
    const queued = openPdf(await makePdf(), { spawn: rec.spawn }).then(() => null, (err) => err);
    await new Promise((r) => setTimeout(r, 100));
    await shutdownPdfSandbox();
    assert.ok(failed(await queued));
    for (const { child } of rec.children) assert.strictEqual(alive(child.pid), false);
    await assert.rejects(a.pageText(1), failed);
    await assert.rejects(b.pageText(1), failed);
    const later = await openPdf(await makePdf({ pages: [{ text: 'after shutdown' }] }));
    try {
      assert.match(await later.pageText(1), /after shutdown/);
    } finally {
      await later.close();
    }
  });

  it('exports its reply caps at the Task 5 vision limits', () => {
    assert.strictEqual(LIMITS.pageTextBytes, 2 * MB);
    assert.strictEqual(LIMITS.pagePdfBytes, 10 * MB);
    assert.strictEqual(LIMITS.pageImageBytes, 5 * MB);
  });
});
