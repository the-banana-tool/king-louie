// src/history/embed-runner.js
// Hosts the embed worker (recall spec §3.2 EmbedRunner, §5.2, §15) the way
// pdf-sandbox.js hosts the PDF worker: a child process spawned from
// process.execPath with ELECTRON_RUN_AS_NODE=1 (the app binary in a packaged
// build; plain node in the service and LongHaul), an env of only what it
// needs, no IPC channel, requests on stdin and replies on fd 3
// (embed-protocol.js). The worker loads native onnxruntime; a crash there
// kills the child, never this process.
//
// - One worker, one request at a time. Jobs run by priority: loads, then a
//   turn's query, then rerank slices, then document slices, so a query waits
//   at most one document slice (DOC_SLICE texts).
// - The runner remembers the model it keeps loaded per role (load()). A job
//   for another model fails with MODEL_CHANGED before it is sent, so a slice
//   queued for a model the owner switched away from is never embedded by the
//   new one. A fresh worker gets its models reloaded before its first job.
// - Every job has a timeout; one that runs out kills the worker (it is hung)
//   and counts as a crash. A query's timeout also bounds its time in the
//   queue, so a turn never waits longer than timeouts.query.
// - A worker that exits with a job in flight fails that job
//   (EMBED_WORKER_CRASHED); the queue waits backoffMs[n] (1 s, 5 s, 30 s)
//   and starts a new worker. maxCrashes (3) within crashWindowMs (10 min)
//   disable the runner for the session: every job fails with EMBED_DISABLED
//   until reset().
// - idleUnref (LongHaul's CLI): while nothing is queued or in flight the
//   worker does not keep this process alive.
// - stop() fails every job with EMBED_STOPPED and kills the worker.
const childProcess = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LineReader, encodeMessage, base64ToVec } = require('./embed-protocol');
const { EmbedError } = require('./embed-errors');
const { createLogger } = require('../logging');

const log = createLogger('history/embed-runner');

const WORKER_PATH = path.join(__dirname, 'embed-worker.js');
const DOC_SLICE = 8;
const RERANK_SLICE = 16;
const PRIORITY = Object.freeze({ load: 0, query: 1, rerank: 2, document: 3 });
const DEFAULT_TIMEOUTS = Object.freeze({ load: 10 * 60000, query: 30000, rerank: 30000, document: 60000 });
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 5000, 30000]);
const DEFAULT_MEMORY_MB = 1024;
const QUICK_EXIT_MS = 5000;
const QUICK_EXIT_HINT = 'the embed worker ended at once, before any reply; likely cause in a packaged app: Electron\'s RunAsNode fuse is off, or onnxruntime-node is not unpacked from the asar';
const STDERR_MAX_CHARS = 8 * 1024;
const PASS_ENV = ['SYSTEMROOT', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

function decodeVectors(msg, count) {
  const list = Array.isArray(msg.vectors) ? msg.vectors : null;
  if (!list || list.length !== count) throw new EmbedError('EMBED_FAILED', `the embed worker returned ${list ? list.length : 'no'} vectors for ${count} texts`);
  return list.map(base64ToVec);
}

function decodeScores(msg, count) {
  const list = Array.isArray(msg.scores) ? msg.scores : null;
  if (!list || list.length !== count || !list.every(Number.isFinite)) throw new EmbedError('EMBED_FAILED', 'the embed worker returned no usable rerank scores');
  return list;
}

class EmbedRunner extends EventEmitter {
  constructor({
    spawn = childProcess.spawn, execPath = process.execPath, workerPath = WORKER_PATH, testBackend = null,
    timeouts = {}, backoffMs = DEFAULT_BACKOFF_MS, crashWindowMs = 10 * 60000, maxCrashes = 3,
    memoryMb = DEFAULT_MEMORY_MB, idleUnref = false, now = Date.now
  } = {}) {
    super();
    this.spawnFn = spawn;
    this.execPath = execPath;
    this.workerPath = workerPath;
    this.testBackend = testBackend;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.backoffMs = backoffMs;
    this.crashWindowMs = crashWindowMs;
    this.maxCrashes = maxCrashes;
    this.memoryMb = memoryMb;
    this.idleUnref = idleUnref;
    this.now = now;
    this.child = null;
    this.queue = [];
    this.inflight = null;
    this.nextId = 1;
    this.seq = 0;
    this.crashes = [];
    this._disabled = false;
    this.stopped = false;
    this.restartTimer = null;
    // What the runner keeps loaded per role, and what the current worker holds.
    this.desired = { embedder: null, reranker: null };
    this.workerModels = { embedder: null, reranker: null };
  }

  get disabled() { return this._disabled; }

  get state() {
    if (this.stopped) return 'stopped';
    if (this._disabled) return 'disabled';
    return this.child ? 'running' : 'idle';
  }

  // priority 'document' queues a background preload behind the slices
  // already waiting and behind every query; the default runs it first.
  load(role, model, { modelsDir, allowDownload = true, priority = 'load' } = {}) {
    const r = role === 'reranker' ? 'reranker' : 'embedder';
    this.desired[r] = { model, modelsDir, allowDownload };
    const job = this._loadJob(r, this.desired[r]);
    if (priority === 'document') job.priority = PRIORITY.document;
    return this._enqueue(job);
  }

  embed(model, texts, { priority = 'document' } = {}) {
    if (!Array.isArray(texts) || !texts.length) return Promise.resolve([]);
    const kind = priority === 'query' ? 'query' : 'document';
    const size = kind === 'query' ? texts.length : DOC_SLICE;
    const parts = [];
    for (let i = 0; i < texts.length; i += size) {
      const slice = texts.slice(i, i + size);
      parts.push(this._enqueue({
        op: 'embed', role: 'embedder', model, fields: { model, texts: slice },
        priority: PRIORITY[kind], timeoutMs: this.timeouts[kind], decode: (msg) => decodeVectors(msg, slice.length)
      }));
    }
    return Promise.all(parts).then((groups) => groups.flat());
  }

  async rerank(model, query, texts, { deadlineMs = Infinity } = {}) {
    if (!Array.isArray(texts) || !texts.length) return [];
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const out = new Array(texts.length);
    for (let b = 0; b < order.length; b += RERANK_SLICE) {
      if (this.now() > deadlineMs) throw new EmbedError('RERANK_TIMEOUT', 'the rerank ran past its deadline');
      const idx = order.slice(b, b + RERANK_SLICE);
      const slice = idx.map((i) => texts[i]);
      const scores = await this._enqueue({
        op: 'rerank', role: 'reranker', model, fields: { model, query, texts: slice },
        priority: PRIORITY.rerank, timeoutMs: this.timeouts.rerank, decode: (msg) => decodeScores(msg, slice.length)
      });
      idx.forEach((i, k) => { out[i] = scores[k]; });
    }
    return out;
  }

  reset() {
    this._disabled = false;
    this.crashes = [];
    this._pump();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this._failAll('EMBED_STOPPED', 'the embed worker was stopped');
    const child = this.child;
    if (!child) return;
    this._kill(child, { expected: true });
    await Promise.race([child.klExited, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  }

  // ── queue ───────────────────────────────────────────────────────────────

  _loadJob(role, want) {
    return {
      op: 'load', role, model: want.model,
      fields: { role, model: want.model, modelsDir: want.modelsDir, allowDownload: want.allowDownload !== false },
      priority: PRIORITY.load, timeoutMs: this.timeouts.load, decode: (msg) => ({ dim: Number.isInteger(msg.dim) ? msg.dim : null })
    };
  }

  _enqueue(job) {
    if (this.stopped) return Promise.reject(new EmbedError('EMBED_STOPPED', 'the embed worker was stopped'));
    if (this._disabled) return Promise.reject(new EmbedError('EMBED_DISABLED', 'local embedding is off for this session: the worker kept crashing'));
    return new Promise((resolve, reject) => {
      const queued = { ...job, seq: this.seq++ };
      let waitTimer = null;
      queued.resolve = (v) => { clearTimeout(waitTimer); resolve(v); };
      queued.reject = (e) => { clearTimeout(waitTimer); reject(e); };
      if (job.priority === PRIORITY.query) {
        // A turn waits no longer than the query timeout in all, queue time
        // included (a slice ahead of it, a restart, a reload). The worker is
        // not killed for that: past the deadline the query is dropped from
        // the queue, or its reply is ignored; hang detection stays the
        // in-flight timer's job.
        waitTimer = setTimeout(() => {
          const at = this.queue.indexOf(queued);
          if (at >= 0) this.queue.splice(at, 1);
          queued.reject(new EmbedError('EMBED_WORKER_TIMEOUT', `the query got no answer within ${job.timeoutMs} ms`));
        }, job.timeoutMs);
      }
      this.queue.push(queued);
      this._pump();
    });
  }

  _next() {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const j = this.queue[i];
      if (best < 0 || j.priority < this.queue[best].priority || (j.priority === this.queue[best].priority && j.seq < this.queue[best].seq)) best = i;
    }
    return best < 0 ? null : this.queue.splice(best, 1)[0];
  }

  _pump() {
    if (this.inflight || this.stopped || this._disabled || this.restartTimer) return;
    const job = this._next();
    if (!job) {
      this._idle();
      return;
    }
    if (job.op !== 'load') {
      const want = this.desired[job.role];
      if (!want || want.model !== job.model) {
        job.reject(new EmbedError('MODEL_CHANGED', `${job.model} is not the ${job.role} model any more`));
        this._pump();
        return;
      }
      if (this.workerModels[job.role] !== job.model) {
        // A fresh worker: load the model first, then this job.
        this.queue.push(job);
        this._send({ ...this._loadJob(job.role, want), seq: -1, internal: true, resolve: () => {}, reject: () => {} });
        return;
      }
    }
    this._send(job);
  }

  _send(job) {
    if (!this.child) {
      try {
        this._spawn();
      } catch (err) {
        job.reject(new EmbedError('EMBED_WORKER_CRASHED', `the embed worker did not start: ${err.message}`));
        this._crashed({ code: null, signal: null, stderr: '', quick: true });
        return;
      }
    }
    job.id = this.nextId++;
    this.inflight = job;
    this._ref();
    job.timer = setTimeout(() => this._hung(job), job.timeoutMs);
    try {
      this.child.stdin.write(encodeMessage({ id: job.id, op: job.op, ...job.fields }));
    } catch (err) {
      log.warn('writing to the embed worker failed', { error: err.message });
      this._kill(this.child, { expected: false });
    }
  }

  _onMessage(child, msg) {
    const job = this.inflight;
    if (msg.event === 'progress') {
      if (job && msg.id === job.id && job.op === 'load') {
        this.emit('progress', { role: job.role, model: job.model, file: msg.file, loaded: msg.loaded, total: msg.total });
      }
      return;
    }
    if (!job || msg.id !== job.id) {
      this._kill(child, { expected: false, why: 'a reply nobody asked for' });
      return;
    }
    child.klReplied = true;
    clearTimeout(job.timer);
    this.inflight = null;
    if (msg.ok !== true) {
      const err = new EmbedError(String(msg.code || 'EMBED_FAILED'), String(msg.message || 'the embed worker failed'));
      if (job.op === 'load') this._failLoad(job, err);
      else job.reject(err);
    } else {
      let value;
      try {
        value = job.decode(msg);
      } catch (err) {
        job.reject(err);
        this._pump();
        return;
      }
      if (job.op === 'load') this.workerModels[job.role] = job.model;
      job.resolve(value);
    }
    this._pump();
  }

  // A failed load fails every queued job that needed that model.
  _failLoad(job, err) {
    job.reject(err);
    const want = this.desired[job.role];
    if (want && want.model === job.model) this.desired[job.role] = null;
    this._rejectWaiting(job, err);
  }

  // Fails every queued job for the same role and model as `job`.
  _rejectWaiting(job, err) {
    this.queue = this.queue.filter((j) => {
      if (j.role === job.role && j.model === job.model) {
        j.reject(err);
        return false;
      }
      return true;
    });
  }

  _failAll(code, message) {
    const err = new EmbedError(code, message);
    const job = this.inflight;
    this.inflight = null;
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    for (const j of this.queue.splice(0)) j.reject(err);
  }

  // ── the child ───────────────────────────────────────────────────────────

  _spawn() {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key];
    if (this.testBackend) env.KL_EMBED_WORKER_BACKEND = this.testBackend;
    const child = this.spawnFn(this.execPath, [`--max-old-space-size=${this.memoryMb}`, this.workerPath], {
      env, stdio: ['pipe', 'ignore', 'pipe', 'pipe'], windowsHide: true
    });
    child.klStarted = this.now();
    child.klReplied = false;
    child.klExpected = false;
    child.klStderr = '';
    this.child = child;
    this.workerModels = { embedder: null, reranker: null };
    child.klExited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve();
        this._onExit(child, code, signal);
      });
      child.on('error', (err) => {
        log.warn('embed worker error', { error: err.message });
        if (child.pid === undefined) {
          resolve();
          this._onExit(child, null, null);
        }
      });
    });
    if (!child.stdin || !child.stdio || !child.stdio[3]) {
      this._kill(child, { expected: false });
      throw new Error('the worker has no pipes');
    }
    child.stderr?.on('data', (c) => {
      if (child.klStderr.length < STDERR_MAX_CHARS) child.klStderr += c.toString('utf8').slice(0, STDERR_MAX_CHARS - child.klStderr.length);
    });
    for (const s of [child.stdin, child.stderr, child.stdio[3]]) s?.on('error', () => {});
    const reader = new LineReader({
      onMessage: (m) => { if (child === this.child) this._onMessage(child, m); },
      onError: (err) => { if (child === this.child) this._kill(child, { expected: false, why: `bad reply: ${err.message}` }); }
    });
    child.stdio[3].on('data', (c) => reader.push(c));
  }

  _kill(child, { expected, why = null }) {
    if (!child) return;
    child.klExpected = child.klExpected || expected;
    if (why) log.warn('stopping the embed worker', { why, pid: child.pid });
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('embed worker kill failed', { pid: child.pid, error: err.message });
    }
  }

  _hung(job) {
    if (this.inflight !== job) return;
    job.hung = true;
    log.warn('embed worker request timed out', { op: job.op, timeoutMs: job.timeoutMs });
    this._kill(this.child, { expected: false });
  }

  _onExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.workerModels = { embedder: null, reranker: null };
    if (child.klExpected) return;
    const quick = !child.klReplied && this.now() - child.klStarted < QUICK_EXIT_MS;
    const job = this.inflight;
    this.inflight = null;
    if (job) {
      clearTimeout(job.timer);
      const err = job.hung
        ? new EmbedError('EMBED_WORKER_TIMEOUT', `the embed worker stopped answering (${job.op} after ${job.timeoutMs} ms)`)
        : new EmbedError('EMBED_WORKER_CRASHED', `the embed worker exited (code ${code}, signal ${signal})${quick ? `; ${QUICK_EXIT_HINT}` : ''}`);
      if (job.internal) {
        // A reload for a fresh worker died: fail what waited on it.
        this._rejectWaiting(job, err);
      } else {
        job.reject(err);
      }
    }
    this._crashed({ code, signal, stderr: child.klStderr, quick });
  }

  _crashed({ code, signal, stderr, quick }) {
    const t = this.now();
    this.crashes = this.crashes.filter((x) => t - x < this.crashWindowMs);
    this.crashes.push(t);
    log.warn('embed worker crashed', { code, signal, crashes: this.crashes.length, stderr: String(stderr || '').slice(0, 500) });
    this.emit('crashed', { code, signal, crashes: this.crashes.length, quick });
    if (this.crashes.length >= this.maxCrashes) {
      this._disabled = true;
      this._failAll('EMBED_DISABLED', `the embed worker crashed ${this.crashes.length} times in ten minutes; local embedding is off for this session`);
      this.emit('disabled', { crashes: this.crashes.length });
      return;
    }
    const delay = this.backoffMs[Math.min(this.crashes.length - 1, this.backoffMs.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._pump();
    }, delay);
  }

  _ref() {
    if (!this.idleUnref || !this.child) return;
    this.child.ref?.();
    for (const s of [this.child.stdin, this.child.stderr, this.child.stdio?.[3]]) s?.ref?.();
  }

  _idle() {
    if (!this.idleUnref || !this.child || this.inflight) return;
    this.child.unref?.();
    for (const s of [this.child.stdin, this.child.stderr, this.child.stdio?.[3]]) s?.unref?.();
  }
}

module.exports = { EmbedRunner, DOC_SLICE, RERANK_SLICE, DEFAULT_TIMEOUTS, QUICK_EXIT_HINT };
