// The IPC channels registerHandlers actually registers (not the constants
// file, which is incomplete). Recorded once against an inert context, the way
// tests/ipc-contract.test.js does it; registration only reads the context.
const { registerHandlers } = require('./register');

let cached = null;

function listIpcChannels() {
  if (cached) return cached;
  const handle = new Set();
  const on = new Set();
  const recorder = { handle: (ch) => handle.add(ch), on: (ch) => on.add(ch), removeHandler() {} };
  const inert = new Proxy({}, { get: () => () => {} });
  registerHandlers(recorder, inert);
  cached = Object.freeze({ handle: Object.freeze([...handle].sort()), on: Object.freeze([...on].sort()) });
  return cached;
}

module.exports = { listIpcChannels };
