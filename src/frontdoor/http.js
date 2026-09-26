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

// `mcpHost` is the name the SNI listener routed this connection by
// (mcp.<domain>), never the TLS socket's servername: a request whose Host
// names anything else is misdirected (421), whatever its TLS name was.
function createFrontDoorHandler({ mcpHost, oauth, mcp = null, phoneApiHandler, pairHandler = null, probeHandler = null } = {}) {
  if (typeof mcpHost !== 'string' || !mcpHost) throw new TypeError('createFrontDoorHandler needs mcpHost');
  const host = mcpHost.toLowerCase();
  const route = async (req, res) => {
    if (requestHost(req) !== host) {
      sendJson(res, 421, { error: 'misdirected_request', error_description: `this front door answers only as ${host}` });
      return;
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

// Never listens: the SNI listener emits 'connection' with each mcp. TLS
// socket it hands over.
function createMcpHttpServer(handler) {
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, handler);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  return server;
}

module.exports = { createFrontDoorHandler, createMcpHttpServer };
