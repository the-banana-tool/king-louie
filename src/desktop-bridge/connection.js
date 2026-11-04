// One authenticated desktop connection, shared by the server (which owns the
// socket) and the dispatcher (which tracks what was issued to it).
let nextId = 0;

function createConnection({ deviceId, label, send, close = () => {}, remote = false }) {
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });
  const conn = {
    id: ++nextId,
    deviceId,
    label,
    remote: remote === true,
    live: true,
    cleaned: false,
    send,
    close,
    // chatId -> how many of its chat:sendMessage calls started on this connection
    // and have not returned (a stopped turn can still be ending when the next begins)
    runs: new Map(),
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
