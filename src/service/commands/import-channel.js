// The stdio channel between `import --from`'s parent and its writer child
// (fleet stage 7 Task 9, fix round 1, C1). One JSON object per line.
//
//   parent -> child  { id, method, params }     method: open | plan | apply | finish | close
//   child  -> parent { id, result } | { id, error: { message, code } }
//
// plan/apply/finish carry exactly the DesktopImporter's own shapes. Batches
// (the only place a secret value could ever appear; the CLI itself always
// reports secrets needs-desktop) travel only down this pipe and are never
// logged by either side.
//
// On POSIX the child runs as the data dir's owner, which is the service
// account: that account can ptrace it, so the parent treats every line it
// gets back as untrusted. A line longer than MAX_LINE_BYTES ends the
// channel, responses are matched by id, and anything the parent prints from
// a response is stripped of control characters first.
const path = require('path');
const { StringDecoder } = require('string_decoder');

const WRITER_SCRIPT = path.join(__dirname, 'import-writer.js');
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// What a child running as the service account inherits from an
// administrator's environment. HOME and TMPDIR are left out on purpose: git
// and os.homedir() then fall back to the service account's own.
const DROPPED_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'KL_CASES_ROOT', 'KING_LOUIE_LOG_LEVEL', 'LOG_LEVEL', 'ELECTRON_RUN_AS_NODE', 'SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP'];

function droppedEnv(env) {
  const out = {};
  for (const k of DROPPED_ENV_KEYS) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

// Calls onLine(text) for each complete line; onOverflow() once if a line
// grows past maxLineBytes (nothing else is delivered after that).
function createLineReader(onLine, { maxLineBytes = MAX_LINE_BYTES, onOverflow = () => {} } = {}) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let dead = false;
  return {
    push(chunk) {
      if (dead) return;
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
        if (dead) return;
      }
      if (Buffer.byteLength(buf) > maxLineBytes) {
        dead = true;
        buf = '';
        onOverflow();
      }
    },
    kill() { dead = true; buf = ''; }
  };
}

// Strips control characters (terminal escapes included) from text that came
// back from the child before it reaches the administrator's terminal.
const printable = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');

// Spawns the writer and returns { request(method, params) -> Promise, close() }.
// `identity` ({ uid, gid } or null) comes from writerIdentity(); with one, the
// child drops to that account and gets a trimmed environment.
function spawnWriter({ dataDir, identity = null, spawn = require('child_process').spawn, env = process.env, onStderr = () => {} }) {
  const opts = {
    cwd: dataDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: identity ? droppedEnv(env) : { ...env }
  };
  if (identity) {
    opts.uid = identity.uid;
    opts.gid = identity.gid;
  }
  const child = spawn(process.execPath, [WRITER_SCRIPT], opts);
  const pending = new Map();
  let nextId = 1;
  let failure = null;

  const fail = (err) => {
    if (!failure) failure = err;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };

  const reader = createLineReader((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      onStderr(`${printable(line)}\n`);
      return;
    }
    const waiter = msg && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) {
      const err = new Error(printable(msg.error.message || 'the import writer failed'));
      if (typeof msg.error.code === 'string') err.code = printable(msg.error.code);
      waiter.reject(err);
    } else {
      waiter.resolve(msg.result);
    }
  }, {
    onOverflow: () => {
      fail(new Error('the import writer sent a response larger than the channel allows'));
      child.kill();
    }
  });

  child.stdout.on('data', (chunk) => reader.push(chunk));
  const errLines = createLineReader((line) => onStderr(`${printable(line)}\n`), { maxLineBytes: 64 * 1024, onOverflow: () => {} });
  child.stderr.on('data', (chunk) => errLines.push(chunk));
  child.stdin.on('error', () => { /* reported through exit/error below */ });
  const exited = new Promise((resolve) => {
    child.on('error', (err) => {
      fail(new Error(`could not start the import writer: ${err.message}`));
      resolve();
    });
    child.on('close', (code, signal) => {
      fail(new Error(`the import writer exited (${signal || `code ${code}`})`));
      resolve();
    });
  });

  function request(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async function close() {
    if (!failure) {
      try { await request('close'); } catch { /* exiting anyway */ }
    }
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => child.kill(), 10000);
    await exited;
    clearTimeout(timer);
  }

  return { request, close, child };
}

// The child side: reads requests from `input`, answers each in order on
// `output`. `handlers[method](params)` may be async; a 'close' request ends
// the loop after its answer is written.
function serveWriter({ input, output, handlers, onClosed = () => {} }) {
  let chain = Promise.resolve();
  let closed = false;
  const send = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const finish = () => { if (!closed) { closed = true; onClosed(); } };
  const reader = createLineReader((line) => {
    chain = chain.then(async () => {
      if (closed) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const { id, method, params } = msg || {};
      const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
      try {
        if (!handler) throw Object.assign(new Error(`unknown method ${method}`), { code: 'BAD_REQUEST' });
        send({ id, result: (await handler(params || {})) ?? null });
      } catch (err) {
        send({ id, error: { message: err && err.message ? err.message : String(err), code: err && typeof err.code === 'string' ? err.code : undefined } });
      }
      if (method === 'close') finish();
    });
  }, { onOverflow: () => finish() });
  input.on('data', (chunk) => reader.push(chunk));
  input.on('end', () => { chain = chain.then(finish); });
}

module.exports = { spawnWriter, serveWriter, createLineReader, printable, droppedEnv, WRITER_SCRIPT, MAX_LINE_BYTES };
