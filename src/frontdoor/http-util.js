// Small HTTP helpers for the front door's own endpoints (OAuth, MCP, pairing).

// Everything that can make shown text read differently from what it is:
// C0 and C1 controls and DEL (\p{Cc}), every format character (\p{Cf}: the
// bidi embeddings, overrides, isolates and marks, zero-width space/joiners,
// word joiner, BOM, soft hyphen), lone surrogates, and the line/paragraph
// separators.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

const tooLarge = (maxBytes) => Object.assign(new Error(`bodies are limited to ${maxBytes} bytes`), { status: 413, error: 'body_too_large' });

// Reads a request body, holding at most maxBytes: a declared length over the
// limit is refused before reading, and a streamed (chunked) body is refused
// the moment it passes the limit. The caller answers 413 with
// `connection: close`, so the rest of the body is never read.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(tooLarge(maxBytes));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        fail(tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    // A client that goes away mid-body never sends 'end'.
    req.on('close', () => fail(Object.assign(new Error('the request closed before its body ended'), { status: 400, error: 'invalid_request' })));
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function sendHtml(res, status, html, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), ...headers });
  res.end(html);
}

// An application/x-www-form-urlencoded body → { name: value } with no
// prototype. A parameter given twice could be read one way here and another
// way by the client, so it is refused (RFC 6749 §3.2); the key is not named,
// since it is the client's text.
function parseForm(buf) {
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
    if (k in out) throw Object.assign(new Error('a parameter was given more than once'), { status: 400, error: 'invalid_request' });
    out[k] = v;
  }
  return out;
}

// Cookie header → { name: value }. The first occurrence of a name wins; a
// prototype key is never set (the object has no prototype).
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

// Self-declared text (a client name) made safe to show: no controls, bidi
// overrides or invisible characters that could make it read differently.
function printable(text) {
  return String(text === undefined || text === null ? '' : text).replace(UNPRINTABLE, '');
}

// For HTML text and double- or single-quoted attribute values.
function escapeHtml(text) {
  return printable(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The Host header, lower case, without its port ("[::1]:443" → "[::1]").
function requestHost(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d*$/, '');
}

// Set by the SNI listener on each TLS socket it hands over: the peer address
// it saw when it accepted the connection.
const ACCEPT_ADDRESS = Symbol.for('king-louie.frontdoor.acceptAddress');

// The peer address of the connection. The front door is the public listener
// itself (no proxy in front of it), so X-Forwarded-For is never read: any
// caller could set it. A TLS socket the SNI listener wrapped reports its
// peer through the raw socket underneath; once that is gone (the peer reset
// mid-request) the address recorded at accept time stands in.
function clientIp(req) {
  const socket = req.socket;
  return (socket && (socket.remoteAddress || socket[ACCEPT_ADDRESS])) || 'unknown';
}

module.exports = { readBody, sendJson, sendHtml, parseForm, parseCookies, printable, escapeHtml, requestHost, clientIp, ACCEPT_ADDRESS };
