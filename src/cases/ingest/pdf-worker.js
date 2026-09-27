// src/cases/ingest/pdf-worker.js
// The PDF worker process (ruling Q1, ruling T3b-frames, ruling T3b-orphan).
// pdf-sandbox.js spawns it with ELECTRON_RUN_AS_NODE=1, a heap ceiling and a
// minimal env. Requests arrive as frames on stdin, replies leave as frames on
// fd 3; stdout is not connected.
//
// Parsing runs in a worker_threads Worker (pdf-parse-thread.js) with
// resourceLimits, so this main thread stays responsive whatever pdf.js does.
// It exits the whole process when:
// - stdin ends or closes (the parent closed it or died);
// - the parent pid changes or the parent is gone (polled; on POSIX an orphan
//   is re-parented, on Windows the old pid stops existing);
// - a call outlives its own deadline (the parent's timeout plus a margin,
//   sent with each request), in case the parent could not kill it;
// - the parsing thread dies (a heap blow-up, an uncaught error).
//
// Test hooks exist only when the parent set KL_PDF_WORKER_TEST_HOOKS=1, which
// it does only for an explicit testHooks: true. They are requests from the
// parent, never read from a document. Hooks that forge frames run here; the
// ones that block or exhaust the parser run on the parsing thread.
const net = require('node:net');
const path = require('node:path');
const { encodeFrame, FrameReader, LIMITS } = require('./pdf-frames');

const THREAD_PATH = path.join(__dirname, 'pdf-parse-thread.js');
// The document (at most 256 MB, checked by the parent) plus its header.
const REQUEST_MAX_BYTES = 256 * 1024 * 1024 + 4096;
const DEFAULT_DEADLINE_MS = 60000;
const MAX_DEADLINE_MS = 10 * 60000;
const THREAD_HOOKS = new Set(['spin', 'alloc']);

// The heap ceiling the parent gave this process; the parsing thread gets the
// same one through resourceLimits.
function heapMbFromArgv(execArgv) {
  for (const arg of execArgv) {
    const m = /^--max-old-space-size=(\d+)$/.exec(arg);
    if (m) return Number(m[1]);
  }
  return null;
}

function parentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function frameHook(id, hook, write) {
  const prefixed = (length, headerLength, rest) => {
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(length, 0);
    prefix.writeUInt32BE(headerLength, 4);
    return Buffer.concat([prefix, rest]);
  };
  const send = (header, payload) => { for (const part of encodeFrame(header, payload)) write(part); };
  switch (hook) {
    case 'env':
      return send({ id, ok: true }, Buffer.from(JSON.stringify(Object.keys(process.env)), 'utf8'));
    case 'exit':
      return process.exit(7);
    case 'oversize':
      // Declares a reply just over the cap, sends 1 KB of it, and stalls:
      // only a check of the declared length ends the call before the timeout.
      write(prefixed(LIMITS.pageTextBytes + 8192, 2, Buffer.concat([Buffer.from('{}'), Buffer.alloc(1024)])));
      return setInterval(() => {}, 1000);
    case 'oversize-payload':
      return send({ id, ok: true }, Buffer.alloc(LIMITS.pageTextBytes + 1, 0x61));
    case 'bad-json':
      return write(prefixed(4 + 9, 9, Buffer.from('{not json', 'utf8')));
    case 'bad-shape':
      return send({ id, ok: 'yes' });
    case 'bad-id':
      return send({ id: id + 1, ok: true });
    case 'bad-code':
      return send({ id, ok: false, code: 'EVERYTHING_FINE', message: 'x' });
    case 'bad-header-length':
      return write(prefixed(4 + 10, 1000, Buffer.alloc(10)));
    case 'unasked':
      send({ id, ok: true }, Buffer.from('first', 'utf8'));
      return send({ id, ok: true }, Buffer.from('second', 'utf8'));
    case 'partial':
      write(prefixed(100, 2, Buffer.from('{}')), true);
      return setInterval(() => {}, 1000);
    case 'drip': {
      // A legal 256 KB reply, written one byte per write. Each byte goes out
      // through the same stream as every other reply, once the previous one
      // has been written: fd 3 is non-blocking (on POSIX a socketpair that
      // net.Socket owns), so a synchronous write to it fails with EAGAIN as
      // soon as the parent falls behind, and waiting keeps nothing queued.
      const frame = Buffer.concat(encodeFrame({ id, ok: true }, Buffer.alloc(256 * 1024, 0x61)));
      let at = 0;
      const next = () => {
        if (at >= frame.length) return;
        at += 1;
        write(frame.subarray(at - 1, at), false, next);
      };
      return next();
    }
    case 'forge': {
      // Declares ~4 GB, then streams 512 MB of body.
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(0xfffffff0, 0);
      write(prefix);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 512; i += 1) write(chunk);
      return undefined;
    }
    default:
      return send({ id, ok: false, code: 'UNREADABLE_PDF', message: 'unknown hook' });
  }
}

// Everything is injectable so the exit paths can be tested in-process.
function runWorker({
  input,
  write,
  exit = (code) => process.exit(code),
  getPpid = () => process.ppid,
  isAlive = parentAlive,
  pollMs = 1000,
  hooks = false,
  heapMb = null,
  createThread = (opts) => new (require('node:worker_threads').Worker)(THREAD_PATH, opts)
}) {
  let done = false;
  let thread = null;
  const deadlines = new Map();
  const stop = (code) => {
    if (done) return;
    done = true;
    clearInterval(poll);
    for (const timer of deadlines.values()) clearTimeout(timer);
    exit(code);
  };

  const ppid = getPpid();
  const poll = setInterval(() => {
    if (getPpid() !== ppid || !isAlive(ppid)) stop(0);
  }, pollMs);
  poll.unref?.();
  input.on('end', () => stop(0));
  input.on('close', () => stop(0));
  input.on('error', () => stop(1));

  const startThread = () => {
    thread = createThread({
      workerData: { hooks },
      ...(heapMb ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {}),
      // The thread's stdout goes to this process's fd 1, which is ignored;
      // a piped stream nobody reads would keep pdf.js warnings in memory.
      stdout: false,
      stderr: false
    });
    thread.on('message', ({ header, payload }) => {
      clearTimeout(deadlines.get(header?.id));
      deadlines.delete(header?.id);
      for (const part of encodeFrame(header, payload)) write(part);
    });
    thread.on('error', () => stop(1));
    thread.on('exit', () => stop(1));
  };

  const reader = new FrameReader({
    limit: (length) => (length > REQUEST_MAX_BYTES ? 'request too large' : null),
    onFrame: (h, payload) => {
      if (hooks && h.op === 'hook' && !THREAD_HOOKS.has(h.hook)) return frameHook(h.id, h.hook, write);
      if (!thread) startThread();
      const ms = Number.isFinite(h.deadlineMs) && h.deadlineMs > 0 ? Math.min(h.deadlineMs, MAX_DEADLINE_MS) : DEFAULT_DEADLINE_MS;
      deadlines.set(h.id, setTimeout(() => stop(70), ms));
      return thread.postMessage({ header: { ...h }, payload });
    },
    onError: () => stop(1),
    headerMax: 64 * 1024
  });
  input.on('data', (chunk) => reader.push(chunk));
  return { stop };
}

if (require.main === module) {
  const out = new net.Socket({ fd: 3, readable: false, writable: true });
  out.on('error', () => process.exit(1));
  runWorker({
    input: process.stdin,
    write: (buf, end = false, cb) => (end ? out.end(buf, cb) : out.write(buf, cb)),
    hooks: process.env.KL_PDF_WORKER_TEST_HOOKS === '1',
    heapMb: heapMbFromArgv(process.execArgv)
  });
}

module.exports = { runWorker, heapMbFromArgv };
