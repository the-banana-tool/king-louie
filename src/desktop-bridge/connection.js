// One authenticated desktop connection, shared by the server (which owns the
// socket) and the dispatcher (which tracks what was issued to it).
let nextId = 0;

function createConnection({ deviceId, label, send, close = () => {}, remote = false }) {
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });
  const revocation = new AbortController();
  const conn = {
    id: ++nextId,
    deviceId,
    label,
    remote: remote === true,
    live: true,
    cleaned: false,
    // A drop leaves what was approved to run; a revoke does not (R-RW-31). `revoked`
    // and `revokeSignal` are how the dispatcher tells them apart. Nothing is sent
    // after a revoke, whatever was already under way.
    revoked: false,
    revokeSignal: revocation.signal,
    send: (...args) => (conn.revoked ? false : send(...args)),
    close,
    // The event of each chat:sendMessage this connection made that has not returned,
    // to its chatId. Keyed by run, since a chat can hold another window's newer run.
    runs: new Map(),
    // ids of prompts and canvas requests forwarded to this connection only
    prompts: { approvals: new Set(), askUser: new Set(), directory: new Set(), canvas: new Set() },
    gone,
    markGone() {
      if (!conn.live) return;
      conn.live = false;
      resolveGone();
    },
    revoke() {
      if (conn.revoked) return;
      conn.revoked = true;
      revocation.abort();
    }
  };
  return conn;
}

module.exports = { createConnection };
