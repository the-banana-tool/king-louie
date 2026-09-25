// One authenticated desktop connection, shared by the server (which owns the
// socket) and the dispatcher (which tracks what was issued to it).
let nextId = 0;

function createConnection({ deviceId, label, send, close = () => {} }) {
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });
  const conn = {
    id: ++nextId,
    deviceId,
    label,
    live: true,
    cleaned: false,
    send,
    close,
    // chatIds whose chat:sendMessage started on this connection
    runs: new Set(),
    // ids of prompts and canvas requests forwarded to this connection only
    prompts: { approvals: new Set(), askUser: new Set(), directory: new Set(), canvas: new Set() },
    gone,
    markGone() {
      if (!conn.live) return;
      conn.live = false;
      resolveGone();
    }
  };
  return conn;
}

module.exports = { createConnection };
