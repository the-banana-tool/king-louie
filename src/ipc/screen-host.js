// src/ipc/screen-host.js
// King Louie is the screen host (boot-node-tray spec §5.2, plan D-2, Task 7).
// A personal node started at boot runs outside the owner's desktop session, so
// the desktop app, attached to it, runs the session helper's loop against the
// node's <dataDir>\session\personal-helper.json and serves its screenshots,
// input, browser launches and recordings from the owner's session. The file is
// re-read before every connect (a node restart writes a new pipe and key), and
// a missing file is waited for, never an exit: the app can start before the
// node. Needs no electron; main.js reaches it through attached-host.js.
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');

// record_start / record_stop as the service sends them (kl-session-v1). A
// recording counts from a record_start answered ok until its record_stop,
// matched by pid, or by take id for a record_start whose answer was lost.
function createRecordingTracker(onChange) {
  const live = new Map(); // pid -> take id | null
  const set = (fn) => {
    const before = live.size > 0;
    fn();
    if ((live.size > 0) !== before) onChange();
  };
  const dropMatching = (params) => set(() => {
    if (params && params.pid !== undefined) { live.delete(params.pid); return; }
    const takeId = params && params.take_id;
    for (const [pid, t] of live) if (t !== null && t === takeId) live.delete(pid);
  });
  return {
    recording: () => live.size > 0,
    clear: () => set(() => live.clear()),
    wrap(handleOp) {
      return async (op, params, ctx) => {
        if (op === 'record_stop') {
          try {
            return await handleOp(op, params, ctx);
          } finally {
            // Stopped, or not known to the backend: either way it is not recording.
            dropMatching(params);
          }
        }
        const result = await handleOp(op, params, ctx);
        if (op === 'record_start' && result && result.pid !== undefined) {
          set(() => live.set(result.pid, (params && typeof params.take_id === 'string') ? params.take_id : null));
        }
        return result;
      };
    }
  };
}

function startScreenHost({ dataDir, platform = process.platform, log = createLogger('screen-host'), deps = {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('startScreenHost needs the node\'s dataDir');
  const emitter = new EventEmitter();
  const ac = new AbortController();
  let connected = false;
  const changed = () => emitter.emit('change', { connected, recording: tracker.recording() });
  const tracker = createRecordingTracker(changed);

  const runHelper = deps.runSessionHelper || require('../session/helper').runSessionHelper;
  const readFile = deps.readPersonalHelperFile || require('../gui/personal-screen-host').readPersonalHelperFile;
  const profileRoot = path.win32.join(dataDir, 'browser-profiles');

  let backend = deps.backend;
  if (backend === undefined) {
    // The Windows backend, with the node's own profiles (Task 6).
    backend = platform === 'win32'
      ? require('../session/backends').loadBackend('windows', { env: deps.env || process.env, log, profileRoot })
      : null;
  }
  // The helper stops every recording itself (the node gone 30 s, the loop
  // ending): none is live after that, whatever record_stop never came.
  if (backend && typeof backend.stopRecordings === 'function') {
    const inner = backend;
    backend = Object.create(inner);
    backend.stopRecordings = async (...args) => {
      try {
        return await inner.stopRecordings(...args);
      } finally {
        tracker.clear();
      }
    };
  }

  const done = Promise.resolve().then(() => runHelper({
    platform,
    signal: ac.signal,
    ...(deps.env ? { env: deps.env } : {}),
    deps: {
      ...(deps.helperDeps || {}),
      log,
      backend,
      profileRoot,
      // The app's own log is the record; never the fleet helper's log file.
      attachLog: false,
      readCopy: async () => {
        const f = readFile({ dataDir });
        return { endpoint: f.endpoint, secret: f.secret, nodeId: f.nodeId };
      },
      wrapOp: (handleOp) => tracker.wrap(handleOp),
      onState: ({ connected: now }) => {
        if (now === connected) return;
        connected = now;
        changed();
      }
    }
  })).catch((err) => {
    log.error(`the screen host stopped: ${err && err.message}`);
    return 1;
  });

  return {
    recording: () => tracker.recording(),
    connected: () => connected,
    on(event, fn) { emitter.on(event, fn); return this; },
    off(event, fn) { emitter.off(event, fn); return this; },
    // Aborts the loop; the helper closes its session and stops every live
    // recording and the backend before `done` settles.
    async stop() {
      ac.abort();
      await done;
      if (connected) { connected = false; changed(); }
      tracker.clear();
    }
  };
}

module.exports = { startScreenHost, createRecordingTracker };
