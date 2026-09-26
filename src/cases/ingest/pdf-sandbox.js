// src/cases/ingest/pdf-sandbox.js
// openPdf, out of process (ruling Q1, ruling T3b-frames). A hostile PDF must
// not hang, exhaust memory in, or crash the process that ingests it (the
// desktop main process, the headless service). Every document gets its own
// worker (pdf-worker.js):
// - spawned from process.execPath with ELECTRON_RUN_AS_NODE=1 (under Electron
//   execPath is the Electron binary; under Node the variable is inert), a
//   V8 heap ceiling, and an env of only ELECTRON_RUN_AS_NODE and SYSTEMROOT;
// - with no IPC channel: requests go on stdin and replies come back on fd 3
//   as length-prefixed frames (pdf-frames.js). Node's IPC reader buffers
//   whatever length the child declares, so it is not used. Each reply's
//   declared length is checked against the cap for the call in flight before
//   its body is kept; every reply is validated; the child is untrusted;
// - with wall-clock timeouts (open, each call) that end in SIGKILL, after
//   which the document fails every call without respawning;
// - killed after an idle period (a later call starts a fresh worker from the
//   bytes kept here), at close(), and by shutdownPdfSandbox();
// - at most MAX_CHILDREN at once; up to MAX_WAITING further starts queue
//   (holding the caller's bytes, copied only once a slot is free), and
//   starts beyond that are refused;
// - each request carries the worker's own deadline (the timeout plus a
//   margin): the worker parses on a separate thread and ends itself on that
//   deadline, on stdin closing, or when this process is gone (T3b-orphan).
// stderr is captured (capped) for the log only; callers get a code and a
// sentence, never worker output. This module never loads pdf-lib or unpdf.
const childProcess = require('node:child_process');
const path = require('node:path');
const { IngestError } = require('./errors');
const { encodeFrame, FrameReader, FrameError, HEADER_MAX_BYTES, LIMITS } = require('./pdf-frames');
const { createLogger } = require('../../logging');

const log = createLogger('cases/ingest/pdf-sandbox');

const MB = 1024 * 1024;
const WORKER_PATH = path.join(__dirname, 'pdf-worker.js');
const MAX_CHILDREN = 2;
// Starts waiting for a slot beyond this are refused, not queued.
const MAX_WAITING = 8;
// The worker's own per-call deadline is the parent's timeout plus this, so
// it ends itself if the parent could not kill it (ruling T3b-orphan).
const DEADLINE_MARGIN_MS = 2000;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_TIMEOUTS = Object.freeze({ open: 30000, call: 20000, idle: 60000 });
// The largest document sent to a worker; callers may only lower it.
const MAX_INPUT_BYTES = 256 * MB;
const STDERR_MAX_BYTES = 8 * 1024;
const MESSAGE_MAX_CHARS = 300;
// Past this, a declared length is not an over-cap page but a broken or
// forging worker.
const FRAME_CEILING = 4 + HEADER_MAX_BYTES + Math.max(LIMITS.pageTextBytes, LIMITS.pagePdfBytes, LIMITS.pageImageBytes);
const PAYLOAD_CAP = Object.freeze({
  open: LIMITS.pages,
  text: LIMITS.pageTextBytes,
  page: LIMITS.pagePdfBytes,
  image: LIMITS.pageImageBytes,
  hook: LIMITS.pageTextBytes
});
// PAGE_TOO_LARGE is the worker's own refusal of a page over its reply cap.
const ERROR_CODES = new Set(['ENCRYPTED', 'UNREADABLE_PDF', 'BAD_PAGE', 'PAGE_TOO_LARGE']);

const workerFailed = (name) => new IngestError('PDF_WORKER_FAILED', `Cannot read ${name}: the PDF reader stopped unexpectedly.`);
const timedOut = (name) => new IngestError('PDF_TIMEOUT', `Cannot read ${name}: the PDF took too long to read.`);
const unreadable = (name) => new IngestError('UNREADABLE_PDF', `Cannot read ${name}: it is not a readable PDF.`);
// A reply over its cap sent anyway: the worker broke the protocol, so the
// document fails (unmarked).
const overCap = (name) => new IngestError('UNREADABLE_PDF', `Cannot read ${name}: a page is too large to read.`);
// The worker's own PAGE_TOO_LARGE refusal: only this page is too large, and
// `tooLarge` lets pageAttachment (vision.js) say so instead of failing the read.
const pageTooLarge = (name) => Object.assign(new IngestError('UNREADABLE_PDF', `Cannot read ${name}: a page is too large to read.`), { tooLarge: true });

// ---- the pool: at most MAX_CHILDREN workers at once ----

let slotsUsed = 0;
const waiting = [];
// Bumped by shutdownPdfSandbox: a document from an earlier epoch never
// starts a worker again.
let epoch = 0;
// Documents with a worker, and every worker not yet exited (a killed worker
// stays here until its 'exit').
const documents = new Set();
const children = new Set();

function acquireSlot(name) {
  if (slotsUsed < MAX_CHILDREN) {
    slotsUsed += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) {
    return Promise.reject(new IngestError('PDF_WORKER_FAILED', `Cannot read ${name}: too many PDFs are waiting to be read; try again shortly.`));
  }
  return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next.resolve();
  else slotsUsed -= 1;
}

const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

function childEnv(testHooks) {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (testHooks === true) env.KL_PDF_WORKER_TEST_HOOKS = '1';
  return env;
}

// A message from the worker is shown to the owner only when it is a short
// single line; otherwise the code's own sentence is used.
function safeMessage(message, fallback) {
  if (typeof message !== 'string' || !message || message.length > MESSAGE_MAX_CHARS) return fallback;
  for (const ch of message) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029) return fallback;
  }
  return message;
}

const onlyKeys = (h, keys) => Object.keys(h).every((k) => keys.includes(k));

class IsolatedPdf {
  constructor(bytes, opts) {
    // The caller's bytes until a slot is acquired; then this document's copy.
    this.source = bytes;
    this.bytes = null;
    this.epoch = epoch;
    this.name = opts.name;
    this.opts = opts;
    this.state = 'idle'; // idle (no worker) | live | failed | closed
    this.child = null;
    this.exiting = Promise.resolve();
    this.inflight = null;
    this.nextId = 1;
    this.tail = Promise.resolve();
    this.idleTimer = null;
    this.pageCount = null;
    this.rotations = null;
  }

  // Calls run one at a time, in order.
  run(op, fields = {}) {
    const p = this.tail.then(() => this.call(op, fields));
    this.tail = p.catch(() => {});
    return p;
  }

  async call(op, fields) {
    if (this.epoch !== epoch) this.fail(workerFailed(this.name), 'the sandbox was shut down');
    if (this.state === 'failed' || this.state === 'closed') throw workerFailed(this.name);
    this.clearIdle();
    try {
      if (!this.child) await this.start();
      if (op === null) return undefined;
      return await this.request(op, fields, op, null, this.opts.timeouts.call);
    } finally {
      if (this.state === 'live') this.armIdle();
    }
  }

  async start() {
    await acquireSlot(this.name);
    if (this.state !== 'idle' || this.epoch !== epoch) {
      releaseSlot();
      throw workerFailed(this.name);
    }
    if (!this.bytes) {
      this.bytes = Buffer.from(this.source);
      this.source = null;
    }
    this.spawn();
    const { opts } = this;
    const reply = await this.request('open', {
      name: this.name,
      maxStreamBytes: opts.maxStreamBytes,
      maxDocumentBytes: opts.maxDocumentBytes,
      ...(opts.testHooks === true && opts.testOpenHook ? { hook: opts.testOpenHook } : {})
    }, 'open', this.bytes, opts.timeouts.open);
    if (this.rotations && (reply.pageCount !== this.pageCount || reply.rotations.some((r, i) => r !== this.rotations[i]))) {
      this.fail(workerFailed(this.name), 'reopened document differs');
      throw workerFailed(this.name);
    }
    this.pageCount = reply.pageCount;
    this.rotations = reply.rotations;
  }

  // Holds a slot on entry; releases it on every failure path (a throwing
  // spawn here, or the child's 'exit' / pid-less 'error' later).
  spawn() {
    const { opts } = this;
    let child;
    try {
      child = opts.spawn(process.execPath, [`--max-old-space-size=${opts.memoryMb}`, WORKER_PATH], {
        env: childEnv(opts.testHooks),
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      releaseSlot();
      this.fail(workerFailed(this.name), `spawn threw: ${err.message}`);
      throw workerFailed(this.name);
    }
    this.child = child;
    this.state = 'live';
    documents.add(this);
    children.add(child);
    child.klStderr = '';
    child.klExpected = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
    child.klExited = new Promise((resolve) => {
      const gone = () => {
        children.delete(child);
        release();
        resolve();
      };
      child.once('exit', (code, signal) => {
        gone();
        this.onExit(child, code, signal);
      });
      // Every 'error' is handled: an unhandled one would crash this process.
      child.on('error', (err) => {
        // No pid: it never started, and no 'exit' follows.
        if (child.pid === undefined) gone();
        if (child === this.child) this.fail(workerFailed(this.name), `worker error: ${err.message}`);
        else log.warn('PDF worker error', { error: err.message });
      });
    });
    this.exiting = child.klExited;
    // EMFILE/ENFILE: the child object comes back without its pipes.
    if (!child.stdin || !child.stderr || !child.stdio?.[3]) {
      this.fail(workerFailed(this.name), 'the worker has no pipes');
      throw workerFailed(this.name);
    }
    child.stderr.on('data', (chunk) => {
      if (child.klStderr.length < STDERR_MAX_BYTES) child.klStderr += chunk.toString('utf8').slice(0, STDERR_MAX_BYTES - child.klStderr.length);
    });
    for (const s of [child.stdin, child.stderr, child.stdio[3]]) s.on('error', () => {});
    const reader = new FrameReader({
      limit: (length) => this.checkLength(child, length),
      onFrame: (header, payload) => { if (child === this.child) this.onReply(header, payload); },
      onError: (reason) => {
        if (child !== this.child) return;
        if (reason instanceof IngestError) this.fail(reason, 'reply over cap');
        else this.fail(workerFailed(this.name), reason instanceof FrameError ? reason.message : String(reason));
      }
    });
    child.stdio[3].on('data', (chunk) => reader.push(chunk));
    child.stdio[3].on('end', () => reader.end());
  }

  // Checked before any byte of a reply body is kept.
  checkLength(child, length) {
    if (child !== this.child || !this.inflight) return new FrameError('a reply nobody asked for');
    if (length > FRAME_CEILING) return new FrameError(`declared length ${length} past the ceiling`);
    if (length > 4 + HEADER_MAX_BYTES + PAYLOAD_CAP[this.inflight.kind]) return overCap(this.name);
    return null;
  }

  request(op, fields, kind, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => this.fail(timedOut(this.name), `${op} timed out after ${timeoutMs} ms`), timeoutMs);
      this.inflight = { id, kind, n: fields.n, resolve, reject, timer };
      try {
        const header = { id, op, ...fields, deadlineMs: timeoutMs + DEADLINE_MARGIN_MS };
        for (const part of encodeFrame(header, payload)) this.child.stdin.write(part);
      } catch (err) {
        this.fail(workerFailed(this.name), `write failed: ${err.message}`);
      }
    });
  }

  settle(fn) {
    const f = this.inflight;
    this.inflight = null;
    clearTimeout(f.timer);
    fn(f);
  }

  onReply(h, payload) {
    const f = this.inflight;
    if (!f || h.id !== f.id) return this.fail(workerFailed(this.name), 'reply id does not match');
    if (h.ok === false) {
      if (!onlyKeys(h, ['id', 'ok', 'code', 'message']) || !ERROR_CODES.has(h.code) || payload.length) {
        return this.fail(workerFailed(this.name), 'malformed error reply');
      }
      const fallback = h.code === 'ENCRYPTED'
        ? `Cannot read ${this.name}: the PDF is password-protected.`
        : h.code === 'BAD_PAGE' ? `${this.name} has no page ${f.n}.` : unreadable(this.name).message;
      if (h.code === 'PAGE_TOO_LARGE') return this.settle((x) => x.reject(pageTooLarge(this.name)));
      return this.settle((x) => x.reject(new IngestError(h.code, safeMessage(h.message, fallback))));
    }
    if (h.ok !== true) return this.fail(workerFailed(this.name), 'malformed reply');
    if (payload.length > PAYLOAD_CAP[f.kind]) return this.fail(overCap(this.name), 'payload over cap');
    let value;
    if (f.kind === 'open') {
      const count = h.pageCount;
      if (!onlyKeys(h, ['id', 'ok', 'pageCount']) || !Number.isSafeInteger(count) || count < 0 || payload.length !== count || payload.some((q) => q > 3)) {
        return this.fail(workerFailed(this.name), 'malformed open reply');
      }
      value = { pageCount: count, rotations: Array.from(payload, (q) => q * 90) };
    } else if (f.kind === 'text' || f.kind === 'hook') {
      if (!onlyKeys(h, ['id', 'ok'])) return this.fail(workerFailed(this.name), 'malformed text reply');
      value = payload.toString('utf8');
    } else if (f.kind === 'page') {
      if (!onlyKeys(h, ['id', 'ok']) || !payload.length) return this.fail(workerFailed(this.name), 'malformed page reply');
      value = new Uint8Array(payload.buffer, payload.byteOffset, payload.length);
    } else if (f.kind === 'image') {
      if (!onlyKeys(h, ['id', 'ok', 'image'])) return this.fail(workerFailed(this.name), 'malformed image reply');
      if (h.image === null && !payload.length) value = null;
      else if (h.image === 'image/jpeg' && payload.length) value = { mime: 'image/jpeg', bytes: payload };
      else return this.fail(workerFailed(this.name), 'malformed image reply');
    }
    return this.settle((x) => x.resolve(value));
  }

  // Ends the document: the call in flight gets `err`, every later call
  // PDF_WORKER_FAILED, and the worker is killed.
  fail(err, why) {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.state = 'failed';
    log.warn('PDF worker failed', { code: err.code, why: String(why).slice(0, 200), pid: this.child?.pid });
    if (this.inflight) this.settle((f) => f.reject(err));
    this.bytes = null;
    this.source = null;
    this.clearIdle();
    this.kill(this.child);
  }

  onExit(child, code, signal) {
    if (child.klStderr && (!child.klExpected || this.state === 'failed')) {
      log.warn('PDF worker stderr', { pid: child.pid, code, signal, stderr: child.klStderr });
    }
    if (child === this.child) this.fail(workerFailed(this.name), `worker exited (code ${code}, signal ${signal})`);
  }

  // Detaches the worker at once (nothing it sends afterwards is read) and
  // SIGKILLs it. The worker spawns no processes of its own.
  kill(child) {
    if (!child) return;
    if (child === this.child) {
      this.child = null;
      documents.delete(this);
    }
    child.klExpected = true;
    child.stdio?.[3]?.destroy();
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('PDF worker kill failed', { pid: child.pid, error: err.message });
    }
  }

  armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state !== 'live' || this.inflight) return;
      this.state = 'idle';
      this.kill(this.child);
    }, this.opts.timeouts.idle);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close() {
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.clearIdle();
      if (this.inflight) this.settle((f) => f.reject(workerFailed(this.name)));
      this.bytes = null;
      this.source = null;
      this.kill(this.child);
    }
    await this.exiting;
  }

  api() {
    const check = (n) => {
      if (!Number.isInteger(n) || n < 1 || n > this.pageCount) throw new IngestError('BAD_PAGE', `${this.name} has no page ${n}.`);
    };
    const paged = (op) => async (n) => {
      check(n);
      return this.run(op, { n });
    };
    const out = {
      pageCount: this.pageCount,
      pageText: paged('text'),
      pageRotation: (n) => {
        check(n);
        return this.rotations[n - 1];
      },
      singlePagePdf: paged('page'),
      pageImage: paged('image'),
      close: () => this.close()
    };
    if (this.opts.testHooks === true) out._testHook = (hook) => this.run('hook', { hook });
    return Object.freeze(out);
  }
}

// → { pageCount, pageText(n), pageRotation(n), singlePagePdf(n), pageImage(n), close() }
// pageRotation is synchronous (resolved at open); the others return promises.
async function openPdfIsolated(bytes, {
  name = 'document.pdf', maxBytes, maxStreamBytes, maxDocumentBytes, timeouts = {}, memoryMb,
  spawn = childProcess.spawn, testHooks = false, testOpenHook = null
} = {}) {
  if (!(bytes instanceof Uint8Array)) throw unreadable(name);
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_INPUT_BYTES) : MAX_INPUT_BYTES;
  if (bytes.length > limit) throw new IngestError('UNREADABLE_PDF', `Cannot read ${name}: the file is too large.`);
  const pdf = new IsolatedPdf(bytes, {
    name,
    maxStreamBytes,
    maxDocumentBytes,
    memoryMb: Number.isSafeInteger(memoryMb) && memoryMb >= 16 ? memoryMb : DEFAULT_MEMORY_MB,
    timeouts: {
      open: positive(timeouts.open, DEFAULT_TIMEOUTS.open),
      call: positive(timeouts.call, DEFAULT_TIMEOUTS.call),
      idle: positive(timeouts.idle, DEFAULT_TIMEOUTS.idle)
    },
    spawn,
    testHooks: testHooks === true,
    testOpenHook
  });
  try {
    await pdf.run(null);
  } catch (err) {
    await pdf.close();
    throw err;
  }
  return pdf.api();
}

// Kills every worker and fails every queued start. Awaited by create-core's
// shutdown (Tasks 8/11). Documents opened before it fail every later call,
// idle ones included (they never start a worker again); later opens work.
async function shutdownPdfSandbox() {
  epoch += 1;
  for (const w of waiting.splice(0)) w.reject(new IngestError('PDF_WORKER_FAILED', 'The PDF reader is shutting down.'));
  await Promise.all([...documents].map((d) => d.close()));
  for (const child of children) {
    child.klExpected = true;
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  await Promise.all([...children].map((child) => child.klExited));
}

module.exports = {
  openPdfIsolated,
  shutdownPdfSandbox,
  LIMITS,
  MAX_CHILDREN,
  MAX_WAITING,
  DEFAULT_MEMORY_MB,
  DEFAULT_TIMEOUTS,
  MAX_INPUT_BYTES
};
