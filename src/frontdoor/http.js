// The mcp.<domain> HTTP surface (fleet stage 4 §3.2, §3.4, §3.5): one
// handler behind the SNI listener. F3's phone API keeps /v1 (F4's routes are
// registered on it), OAuth and MCP are the front door's own, /pair/v1 is the
// node side of pairing, and /.well-known/kl-probe/ answers the self-probe.
const http = require('http');
const { createLogger } = require('../logging');
const { sendJson, requestHost } = require('./http-util');

const log = createLogger('frontdoor/http');

// Server limits for the mcp. listener (§3.2). Node's defaults (5 min per
// request, 2000 headers) are far more than an OAuth or MCP client needs.
const REQUEST_TIMEOUT_MS = 30000;
const HEADERS_TIMEOUT_MS = 15000;
const KEEP_ALIVE_TIMEOUT_MS = 5000;
const MAX_HEADERS_COUNT = 100;
const MAX_HEADER_SIZE = 16384;

function hostHeaderCount(req) {
  let n = 0;
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') n += 1;
  return n;
}

// `mcpHost` is the name the SNI listener routed this connection by
// (mcp.<domain>), never the TLS socket's servername: a request whose Host
// names anything else is misdirected (421), whatever its TLS name was.
function createFrontDoorHandler({ mcpHost, oauth, mcp = null, phoneApiHandler, pairHandler = null, probeHandler = null } = {}) {
  if (typeof mcpHost !== 'string' || !mcpHost) throw new TypeError('createFrontDoorHandler needs mcpHost');
  const host = mcpHost.toLowerCase();
  const route = async (req, res) => {
    // Node keeps the first of several Host headers; a proxy or the client may
    // have meant another, so more than one is refused outright.
    if (hostHeaderCount(req) > 1) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'more than one Host header' });
      return;
    }
    if (requestHost(req) !== host) {
      sendJson(res, 421, { error: 'misdirected_request', error_description: `this front door answers only as ${host}` });
      return;
    }
    // A request target in absolute form (RFC 9112 §3.2.2) names its own
    // authority, which must be this host too; anything else that is not
    // origin form ("/…") is refused. An accepted absolute form is rewritten
    // to origin form, so every handler behind this one sees a path.
    if (!String(req.url).startsWith('/')) {
      let target = null;
      try {
        target = new URL(req.url);
      } catch {
        target = null;
      }
      if (!target || !/^https?:$/.test(target.protocol) || target.username || target.password || target.hostname.toLowerCase() !== host) {
        sendJson(res, 400, { error: 'invalid_request', error_description: `the request target must be a path, or an absolute URL on ${host}` });
        return;
      }
      req.url = `${target.pathname}${target.search}`;
    }
    let pathname;
    try {
      pathname = new URL(req.url, `https://${host}`).pathname;
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (pathname.startsWith('/v1/')) {
      await phoneApiHandler(req, res);
      return;
    }
    if ((pathname === '/pair/v1' || pathname.startsWith('/pair/v1/')) && pairHandler) {
      await pairHandler(req, res);
      return;
    }
    if (pathname.startsWith('/.well-known/kl-probe/') && probeHandler) {
      await probeHandler(req, res);
      return;
    }
    if (await oauth.handle(req, res)) return;
    if (pathname === '/mcp' && mcp) {
      await mcp.handle(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  };
  return async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log.error(`${req.method} ${String(req.url).split('?')[0]} failed: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
      else res.destroy();
    }
  };
}

// Server-side deadlines for a server that is only ever handed sockets (the
// SNI listener emits 'connection' with each TLS socket). Node enforces its
// own requestTimeout/headersTimeout only on servers that listen, so these
// servers keep their own per-connection timers (ruling T32-timers):
// - headers: from the socket's handoff (and again once a keep-alive
//   connection starts its next request) until the request's headers are in;
// - request: from the headers until the request body has ENDED. Nothing is
//   timed after that, so a response held open (the MCP get_job long-poll, up
//   to frontdoor.mcp.progress_hold_s ≤ 55 s) outlives the 30 s limit;
// - idle: after a response, a keep-alive connection that sends nothing is
//   closed.
// A request cut before it has an answer gets 408 and the connection closes.
// An upgraded connection (a mesh WebSocket) leaves every timer behind.
const END_GRACE_MS = 1000;

function guardConnections(server, { headersTimeoutMs, requestTimeoutMs, idleTimeoutMs }) {
  const state = new WeakMap(); // socket → { timer, phase }
  const clear = (socket) => {
    const st = state.get(socket);
    if (st) {
      clearTimeout(st.timer);
      st.timer = null;
      st.phase = null;
    }
  };
  const arm = (socket, phase, ms, onExpire) => {
    const st = state.get(socket);
    if (!st) return;
    clearTimeout(st.timer);
    st.phase = phase;
    st.timer = setTimeout(() => {
      if (st.phase === phase) onExpire();
    }, ms);
    if (typeof st.timer.unref === 'function') st.timer.unref();
  };
  const cut = (socket, res) => {
    clear(socket);
    state.delete(socket);
    try {
      if (res && !res.headersSent) {
        res.writeHead(408, { connection: 'close', 'content-length': '0' });
        res.end();
      } else if (!res) {
        socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    } catch {
      // the socket is going anyway
    }
    const drop = setTimeout(() => socket.destroy(), END_GRACE_MS);
    if (typeof drop.unref === 'function') drop.unref();
  };
  const awaitHeaders = (socket) => arm(socket, { kind: 'headers' }, headersTimeoutMs, () => cut(socket, null));

  server.on('connection', (socket) => {
    state.set(socket, { timer: null, phase: null });
    awaitHeaders(socket);
    socket.once('close', () => {
      clear(socket);
      state.delete(socket);
    });
  });
  server.on('request', (req, res) => {
    const socket = req.socket;
    if (!state.has(socket)) return;
    // Until the body has ended; a request already complete by then is not cut.
    const phase = { kind: 'request', req };
    arm(socket, phase, requestTimeoutMs, () => {
      if (!req.complete) cut(socket, res);
    });
    req.once('end', () => {
      const st = state.get(socket);
      if (st && st.phase === phase) clear(socket);
    });
    res.once('finish', () => {
      if (!state.has(socket)) return;
      const readAt = socket.bytesRead;
      arm(socket, { kind: 'idle' }, idleTimeoutMs, () => {
        if (socket.bytesRead === readAt) socket.destroy();
        else awaitHeaders(socket); // the next request has begun
      });
    });
  });
  server.on('upgrade', (req, socket) => {
    clear(socket);
    state.delete(socket);
  });
  return server;
}

const MCP_LIMITS = Object.freeze({ requestTimeoutMs: REQUEST_TIMEOUT_MS, headersTimeoutMs: HEADERS_TIMEOUT_MS, idleTimeoutMs: KEEP_ALIVE_TIMEOUT_MS });

// The mcp. server. Never listens. `limits` exists for tests, which scale
// the timings down.
function createMcpHttpServer(handler, limits = {}) {
  const l = { ...MCP_LIMITS, ...limits };
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, handler);
  // Node's own request timers never run on a server that does not listen;
  // guardConnections is what enforces l (server.frontDoorLimits).
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.frontDoorLimits = Object.freeze(l);
  return guardConnections(server, l);
}

// The mesh. server: only pinned nodes reach it, and all it serves is the
// WebSocket upgrade on /mesh/v1 (MeshTransport#attachServer); anything else
// is 404. The same deadlines, until the upgrade.
function createMeshHttpServer(limits = {}) {
  const l = { ...MCP_LIMITS, ...limits };
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
    res.writeHead(404, { 'content-length': '0' });
    res.end();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.frontDoorLimits = Object.freeze(l);
  return guardConnections(server, l);
}

module.exports = { createFrontDoorHandler, createMcpHttpServer, createMeshHttpServer, guardConnections, MCP_LIMITS, REQUEST_TIMEOUT_MS };
