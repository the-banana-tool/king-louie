// Which window's call a run belongs to (remote window plan R-RW-6). The
// dispatcher enters this around every frame a connection sends, and the awaited
// chat:sendMessage keeps it for the whole turn, across awaits and timers, so a
// prompt the turn raises reaches the window that started it.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const runFor = (conn, fn) => storage.run(conn, fn);
const currentConnection = () => storage.getStore() || null;

module.exports = { runFor, currentConnection };
