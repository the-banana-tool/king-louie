// The courier helper process for root-run CLI commands (ruling T13-enroll).
// Forked by CourierProxy (src/service/courier-proxy.js). It drops to the data
// dir's owner before it touches approvals/ (src/service/drop-privileges.js),
// then runs a FileCourier there and relays over IPC: `call` replies, inbox
// messages, and the relay link state it read. The root parent never reads,
// writes, chowns or unlinks inside approvals/ itself.
//
// Parent → child: { type: 'start', dataDir, who, pollMs }
//                 { type: 'call', id, method, params, timeoutMs, service? }
//                 { type: 'stop' }
// Child → parent: { type: 'ready', link }
//                 { type: 'reply', id, ok: true, result } | { type: 'reply', id, ok: false, error: { code, message } }
//                 { type: 'message', method, params }
//                 { type: 'fatal', message }
const fs = require('fs');
const path = require('path');
const { dropToDataDirOwner } = require('./drop-privileges');

let courier = null;

function send(msg, cb) {
  if (process.connected) process.send(msg, cb);
  else if (cb) cb();
}

function stop(code = 0) {
  try {
    if (courier) courier.stop();
  } finally {
    process.exit(code);
  }
}

function readLink(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
  } catch {
    return null;
  }
}

function start(msg) {
  const dataDir = msg.dataDir;
  dropToDataDirOwner(dataDir, { who: typeof msg.who === 'string' ? msg.who : 'this command' });
  // eslint-disable-next-line global-require -- after the drop, on purpose
  const { FileCourier } = require('../approvals/courier');
  courier = new FileCourier({ dataDir, ...(Number.isInteger(msg.pollMs) && msg.pollMs > 0 ? { pollMs: msg.pollMs } : {}) }).start();
  courier.onMessage(async (method, params) => send({ type: 'message', method, params }));
  send({ type: 'ready', link: readLink(dataDir) });
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start' && !courier) {
    try {
      start(msg);
    } catch (err) {
      send({ type: 'fatal', message: String(err && err.message) }, () => stop(1));
    }
    return;
  }
  if (msg.type === 'call' && courier) {
    // service: the running service's own handler (no relay link needed).
    const request = msg.service === true ? courier.callService.bind(courier) : courier.call.bind(courier);
    request(msg.method, msg.params || {}, { timeoutMs: msg.timeoutMs })
      .then((result) => send({ type: 'reply', id: msg.id, ok: true, result: result === undefined ? null : result }))
      .catch((err) => send({ type: 'reply', id: msg.id, ok: false, error: { code: String((err && err.code) || 'error'), message: String(err && err.message) } }));
    return;
  }
  if (msg.type === 'stop') stop(0);
});

// The parent went away: nothing left to relay to.
process.on('disconnect', () => stop(0));
