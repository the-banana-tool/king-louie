// `<dataDir>/relay/push-status.json` (push spec §8, C-14): the time, sender
// and HTTP status of the last push the relay sent and of the last that
// failed, for `doctor`'s push row. Never a token, a device id or an error's
// text. `status` is null when the send threw (no HTTP answer).
//
// { v: 1,
//   last_send:    { at: <RFC 3339>, sender: 'fcm' | 'apns', status: <int> | null } | null,
//   last_failure: { at, sender, status } | null }
//
// Written by the relay's pusher at most once a minute (the first result at
// once, later ones when the minute is up, on an unref'd timer) and on
// stop(); written to a temporary file and renamed, so a reader never sees
// half of it.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');

const log = createLogger('frontdoor/push');

const WRITE_EVERY_MS = 60 * 1000;

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function createPushStatus({ file, now = Date.now, timers }) {
  const state = { v: 1, last_send: null, last_failure: null };
  let dirty = false;
  let lastWrite = null;
  let timer = null;
  let warned = false;

  function flush() {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    lastWrite = now();
    try {
      writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      if (!warned) log.warn(`cannot write the push status file: ${err.code || 'error'}`);
      warned = true;
    }
  }

  return {
    // result: { ok, status } from a sender, or null when it threw.
    record(sender, result) {
      const entry = { at: new Date(now()).toISOString(), sender, status: result && Number.isInteger(result.status) ? result.status : null };
      state.last_send = entry;
      if (!result || result.ok === false) state.last_failure = entry;
      dirty = true;
      const due = lastWrite === null ? 0 : lastWrite + WRITE_EVERY_MS - now();
      if (due <= 0) {
        flush();
      } else if (!timer) {
        timer = timers.setTimeout(() => { timer = null; flush(); }, due);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    },
    flush
  };
}

module.exports = { createPushStatus, WRITE_EVERY_MS };
