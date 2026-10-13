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
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  _start() {
    const child = this.spawnImpl(this.file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: this.env });
    this.child = child;
    onLines(child.stdout, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log.debug(`${this.name}: unparseable line`);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result);
      else p.reject(fromWire(msg.error));
    });
    if (child.stderr) onLines(child.stderr, (line) => this.log.debug(`${this.name}: ${line}`));
    child.on('error', (err) => this._fail(`${this.name} could not start: ${err.message}`));
    child.on('exit', (code) => this._fail(`${this.name} exited (${code})`));
    if (child.stdin) child.stdin.on('error', () => {});
  }

  _fail(why) {
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GuiError('backend_failed', why));
    }
    this.pending.clear();
  }

  call(op, params = {}, { timeoutMs = 25000 } = {}) {
    if (!this.child) this._start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GuiError('op_timeout', `${this.name} ${op}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch { /* gone */ }
      try { child.kill(); } catch { /* gone */ }
    }
  }
}

module.exports = { LineWorker };
