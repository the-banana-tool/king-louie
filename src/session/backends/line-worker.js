// src/session/backends/line-worker.js
// A persistent OS worker spoken to in JSON lines (fleet stage 5 spec §3.3):
// op data travels on stdin, never in argv or script text.
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { createLogger } = require('../../logging');
const { GuiError, fromWire } = require('../../gui/errors');

// A reply is at most one sealed frame's worth (8 MiB); twice that with no
// newline is a worker gone wrong, and its output is dropped.
const MAX_LINE = 16 * 1024 * 1024;

// One callback per '\n'-terminated line. Not node:readline: that also ends a
// line at U+2028 and U+2029, which a worker's JSON may hold raw inside a
// string (a window title), and a reply cut there would be dropped.
function onLines(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line) onLine(line);
      end = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE) buffer = '';
  });
}

class LineWorker {
  constructor({ file, args = [], spawnImpl = spawn, env = process.env, log = createLogger('session-helper/worker'), name = 'worker' } = {}) {
    Object.assign(this, { file, args, spawnImpl, env, log, name });
    // The worker in use: { child, pending }. Each child has its own pending
    // calls, and its handlers close over its own record, so an old child's
    // late exit, error or reply touches nothing of the child that replaced it.
    this.current = null;
    this.nextId = 1;
  }

  // The child process in use, or null.
  get child() {
    return this.current ? this.current.child : null;
  }

  _start() {
    const child = this.spawnImpl(this.file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: this.env });
    const worker = { child, pending: new Map() };
    this.current = worker;
    onLines(child.stdout, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log.debug(`${this.name}: unparseable line`);
        return;
      }
      const p = worker.pending.get(msg.id);
      if (!p) return;
      worker.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result);
      else p.reject(fromWire(msg.error));
    });
    if (child.stderr) onLines(child.stderr, (line) => this.log.debug(`${this.name}: ${line}`));
    child.on('error', (err) => this._fail(worker, `${this.name} could not start: ${err.message}`));
    child.on('exit', (code) => this._fail(worker, `${this.name} exited (${code})`));
    if (child.stdin) child.stdin.on('error', () => {});
    return worker;
  }

  // Fails what this worker had in flight; it stops being the worker in use
  // only if it still is.
  _fail(worker, why) {
    if (this.current === worker) this.current = null;
    for (const p of worker.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GuiError('backend_failed', why));
    }
    worker.pending.clear();
  }

  // Lets go of a worker: nothing more is expected of it.
  _retire(worker, why) {
    this._fail(worker, why);
    try { worker.child.stdin.end(); } catch { /* gone */ }
    try { worker.child.kill(); } catch { /* gone */ }
  }

  call(op, params = {}, { timeoutMs = 25000 } = {}) {
    const worker = this.current || this._start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        reject(new GuiError('op_timeout', `${this.name} ${op}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      worker.pending.set(id, { resolve, reject, timer });
      worker.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async stop() {
    if (this.current) this._retire(this.current, `${this.name} stopped`);
  }
}

module.exports = { LineWorker };
