// Refuses anything that would leave the machine, and keeps what it refused. For a test
// that builds a core with a fake provider token: KL_TEST_MODE alone does not stop every
// call a core can make. Also loadable with node's --require, for a test's child processes.
const net = require('net');

const blocked = [];
const isLoopback = (host) => !host || host === 'localhost' || host === '::1' || String(host).startsWith('127.');
const note = (what) => {
  blocked.push(what);
  process.stderr.write(`NETBLOCK ${what}\n`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const text = String((url && url.url) || url);
  let host;
  try {
    host = new URL(text).hostname;
  } catch {
    host = null;
  }
  if (isLoopback(host)) return realFetch(url, options);
  note(text);
  throw new TypeError('this test has no network');
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : {};
  if (!options.path && options.host !== undefined && !isLoopback(options.host)) {
    note(`socket ${options.host}`);
    this.destroy(new Error('this test has no network'));
    return this;
  }
  return realConnect.apply(this, args);
};

module.exports = { blocked };
