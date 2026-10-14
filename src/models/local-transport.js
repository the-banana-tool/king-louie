'use strict';

/**
 * The transport for a local server: it dials only the server's pinned
 * addresses (spec 2026-10-13-local-inference-design.md §5.2 rules 4 to 8,
 * §5.4, §9.3; R-LI-5, R-LI-30).
 *
 * This is the one module in `src/` that opens a socket to a local server.
 * What makes it hold:
 *
 *  - Nothing is resolved. The socket is opened to a pinned IP literal; the
 *    name the owner typed is used only for the `Host` header, the TLS server
 *    name and the certificate check. A name that resolves somewhere else
 *    later changes nothing.
 *  - The socket is checked before it carries anything: its remote address
 *    must be a pinned one and, over https, the certificate must verify (or
 *    match the pinned fingerprint). Only then is the request handed the
 *    socket, so a refused connection has received no byte of the request.
 *  - It has its own agent and makes its own connections, so the process's
 *    global agent and dispatcher, and with them HTTP_PROXY, HTTPS_PROXY,
 *    ALL_PROXY and NODE_USE_ENV_PROXY, never route it.
 *  - A 3xx is an error. No redirect is followed.
 *
 * Error messages carry codes and addresses, never request or response text.
 */

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { Readable } = require('node:stream');

const { parseBaseUrl, classifyAddress, canonicalAddress, gradeOf, isTlsFingerprint } = require('./local-address');

class LocalTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'LocalTransportError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
  }
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);
const ALLOWED_ORDER = ['loopback', 'lan', 'cgnat'];
// The transport sets these itself; a caller's value is dropped.
const OWN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding', 'proxy-authorization', 'proxy-connection']);
const NULL_BODY_STATUS = new Set([204, 205, 304]);

function invalid(message, cause) {
  return new LocalTransportError('LOCAL_TRANSPORT_INVALID', message, { cause });
}

/** The pinned addresses, canonical, and the widest class among them. */
function readAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw invalid('A local transport needs at least one pinned address.');
  const out = [];
  let widest = 0;
  for (const entry of addresses) {
    let cls;
    let address;
    try {
      cls = classifyAddress(entry);
      address = canonicalAddress(entry);
    } catch (cause) {
      throw invalid('A pinned address must be an IP address.', cause);
    }
    const rank = ALLOWED_ORDER.indexOf(cls);
    if (rank === -1) throw invalid(`A local transport cannot dial ${address} (${cls}).`);
    widest = Math.max(widest, rank);
    if (!out.includes(address)) out.push(address);
  }
  return { addresses: out, addressClass: ALLOWED_ORDER[widest] };
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function' && !Array.isArray(headers)) return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

function abortFailure(reason) {
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl - the server's base URL, as `parseBaseUrl` accepts it
 * @param {string[]} options.addresses - the pinned addresses (`resolveAndPin`)
 * @param {string|null} [options.tlsFingerprint] - SHA-256 of the certificate, 64 hex characters
 * @param {number} [options.maxConcurrent]
 * @param {number} [options.connectTimeoutMs]
 * @returns {Readonly<{ fetch: Function, close: Function, baseUrl: string, protocol: string,
 *   addresses: readonly string[], addressClass: string, tlsPinned: boolean,
 *   grade: 'guarantee'|'cost-only' }>}
 *   `grade` (R-LI-30) is this transport's own reading of what it dials and
 *   how, fixed when it is built: read it, never a caller's word, to decide
 *   whether a private chat or a local-only role may use the server.
 */
function createLocalTransport({ baseUrl, addresses, tlsFingerprint = null, maxConcurrent = 2, connectTimeoutMs = 10000, _connect = null, _ca = null } = {}) {
  let base;
  try {
    base = parseBaseUrl(baseUrl);
  } catch (cause) {
    throw invalid('A local transport needs a valid http or https base URL.', cause);
  }
  const pinned = readAddresses(addresses);
  if (tlsFingerprint !== null && tlsFingerprint !== undefined && !isTlsFingerprint(tlsFingerprint)) {
    throw invalid('A certificate fingerprint is 64 hex characters (SHA-256).');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw invalid('maxConcurrent must be a whole number, 1 or more.');
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) throw invalid('connectTimeoutMs must be more than 0.');

  const isHttps = base.protocol === 'https:';
  const fingerprint = isHttps && tlsFingerprint ? tlsFingerprint.toLowerCase() : null;
  const origin = new URL(base.href).origin;
  const connect = typeof _connect === 'function' ? _connect : net.connect;
  let nextAddress = 0;
  let closed = false;

  /** One checked connection to one pinned address. Nothing is written on it here. */
  function dialOne(address) {
    return new Promise((resolve, reject) => {
      let done = false;
      let tcp = null;
      let secure = null;
      let timer = null;
      const finish = (err, socket) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          if (secure) secure.destroy();
          if (tcp) tcp.destroy();
          reject(err);
          return;
        }
        if (tcp) tcp.removeListener('error', finish);
        socket.removeListener('error', finish);
        // Under TLS the request listens on the TLS socket only: an error on
        // the TCP socket below it must reach it, not go unhandled.
        if (secure && tcp) tcp.on('error', (cause) => secure.destroy(cause));
        resolve(socket);
      };
      timer = setTimeout(() => {
        finish(Object.assign(new Error(`connect ETIMEDOUT ${address}:${base.port}`), { code: 'ETIMEDOUT' }));
      }, connectTimeoutMs);
      try {
        tcp = connect({
          host: address,
          port: base.port,
          family: net.isIP(address),
          // An IP literal is never looked up. If something ever asks, it fails.
          lookup: (_host, _options, cb) => cb(Object.assign(new Error('a local transport resolves nothing'), { code: 'ENOTFOUND' })),
        });
      } catch (err) {
        finish(err);
        return;
      }
      tcp.once('error', finish);
      tcp.once('connect', () => {
        // §5.2 rule 5: the socket must be on a pinned address.
        let remote = null;
        try {
          remote = canonicalAddress(tcp.remoteAddress);
        } catch { /* no address: not a pinned one */ }
        if (remote === null || !pinned.addresses.includes(remote)) {
          finish(new LocalTransportError('LOCAL_ADDRESS_MISMATCH', `The connection for ${address}:${base.port} ended on ${remote || 'an unknown address'}, which is not a pinned address.`));
          return;
        }
        if (!isHttps) {
          finish(null, tcp);
          return;
        }
        try {
          secure = tls.connect({
            socket: tcp,
            // The name the owner typed: SNI (never an IP literal) and the
            // name the certificate must be for.
            servername: base.isIpLiteral ? undefined : base.hostname,
            host: base.hostname,
            rejectUnauthorized: fingerprint === null,
            ALPNProtocols: ['http/1.1'],
            ...(_ca ? { ca: _ca } : {}),
          });
        } catch (err) {
          finish(err);
          return;
        }
        secure.once('error', finish);
        secure.once('secureConnect', () => {
          if (fingerprint !== null) {
            const cert = secure.getPeerCertificate();
            const seen = cert && typeof cert.fingerprint256 === 'string' ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
            if (seen !== fingerprint) {
              finish(new LocalTransportError('LOCAL_TLS_MISMATCH', `The certificate ${base.hostname} presented is not the pinned one.`));
              return;
            }
          }
          finish(null, secure);
        });
      });
    });
  }

  /** A checked connection to the first pinned address that answers. */
  async function dial() {
    if (closed) throw new LocalTransportError('LOCAL_TRANSPORT_CLOSED', 'This local transport is closed.');
    const count = pinned.addresses.length;
    let last = null;
    for (let i = 0; i < count; i += 1) {
      const index = (nextAddress + i) % count;
      try {
        const socket = await dialOne(pinned.addresses[index]);
        nextAddress = index;
        return socket;
      } catch (err) {
        if (!err || !UNREACHABLE_CODES.has(err.code)) throw err;
        last = err;
      }
    }
    throw new LocalTransportError('LOCAL_UNREACHABLE', `${base.hostname}:${base.port} did not answer (${last.code}).`, { cause: last });
  }

  class PinnedAgent extends http.Agent {
    createConnection(_options, callback) {
      dial().then((socket) => callback(null, socket), (err) => callback(err));
    }
  }
  // Its own agent: never the global one, and no proxy settings.
  const agent = new PinnedAgent({ keepAlive: true });

  // --- at most maxConcurrent open requests; the rest wait in order ---
  let active = 0;
  const waiting = [];

  function release() {
    active -= 1;
    while (active < maxConcurrent && waiting.length > 0) {
      const next = waiting.shift();
      next.stopListening();
      active += 1;
      next.resolve();
    }
  }

  function acquire(signal) {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, stopListening: () => {} };
      if (signal) {
        const onAbort = () => {
          const at = waiting.indexOf(entry);
          if (at !== -1) waiting.splice(at, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.stopListening = () => signal.removeEventListener('abort', onAbort);
      }
      waiting.push(entry);
    });
  }

  function send(target, method, headers, body, signal) {
    return new Promise((resolve, reject) => {
      let released = false;
      let aborted = false;
      let current = null;
      let response = null;
      let onAbort = null;
      const free = () => {
        if (released) return;
        released = true;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        release();
      };

      const attempt = (retried) => {
        let req;
        let gotResponse = false;
        try {
          req = http.request({
            agent,
            host: base.hostname,
            port: base.port,
            method,
            path: `${target.pathname}${target.search}`,
            headers,
            setHost: false,
          });
        } catch (err) {
          reject(err);
          free();
          return;
        }
        current = req;
        req.once('response', (res) => {
          gotResponse = true;
          if (res.statusCode >= 300 && res.statusCode <= 399) {
            // §5.2 rule 6. The body is not read and the socket is not reused.
            res.destroy();
            req.destroy();
            reject(new LocalTransportError('LOCAL_REDIRECT', `${base.hostname}:${base.port} answered with a redirect (${res.statusCode}). A local server is never followed elsewhere.`, { status: res.statusCode }));
            return;
          }
          response = res;
          try {
            const out = new Headers();
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
              try { out.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* a header fetch cannot carry */ }
            }
            const empty = method === 'HEAD' || NULL_BODY_STATUS.has(res.statusCode);
            if (empty) res.resume();
            resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: out }));
          } catch (err) {
            res.destroy();
            req.destroy();
            reject(err);
          }
        });
        req.once('error', (err) => {
          if (aborted) return;
          // A kept-alive socket the server had already closed: send once more
          // on a fresh one. Nothing was answered, and the body can be resent.
          if (!gotResponse && !retried && req.reusedSocket && err && err.code === 'ECONNRESET') {
            req.removeAllListeners('close');
            attempt(true);
            return;
          }
          reject(err);
        });
        req.once('close', free);
        if (body !== null) req.end(body);
        else req.end();
      };

      if (signal) {
        onAbort = () => {
          aborted = true;
          const reason = signal.reason;
          reject(reason);
          const failure = abortFailure(reason);
          if (response) response.destroy(failure);
          if (current) {
            // Swallow the error the destroy raises; the call already failed.
            current.on('error', () => {});
            current.destroy(failure);
          }
        };
        if (signal.aborted) {
          reject(signal.reason);
          free();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      attempt(false);
    });
  }

  /**
   * @param {string|URL} input - a URL on this transport's origin
   * @param {{ method?: string, headers?: object, body?: string|Buffer|Uint8Array, signal?: AbortSignal }} [init]
   * @returns {Promise<Response>}
   */
  async function fetch(input, init = {}) {
    if (closed) throw new LocalTransportError('LOCAL_TRANSPORT_CLOSED', 'This local transport is closed.');
    let target = null;
    try {
      if (typeof input === 'string' && input !== '') target = new URL(input);
      else if (input instanceof URL) target = input;
    } catch { /* refused below */ }
    if (!target || target.origin !== origin || target.username !== '' || target.password !== '') {
      throw new LocalTransportError('LOCAL_URL_OUTSIDE', `A request through this transport must be to ${origin}.`);
    }

    const opts = init || {};
    const method = String(opts.method || 'GET').toUpperCase();
    let body = null;
    if (typeof opts.body === 'string') body = Buffer.from(opts.body, 'utf8');
    else if (Buffer.isBuffer(opts.body)) body = opts.body;
    else if (opts.body instanceof Uint8Array) body = Buffer.from(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength);
    else if (opts.body !== undefined && opts.body !== null) {
      throw new LocalTransportError('LOCAL_BODY_UNSUPPORTED', 'A request body through this transport must be a string or bytes.');
    }

    const headers = {};
    for (const [name, value] of headerEntries(opts.headers)) {
      const key = String(name).toLowerCase();
      if (!OWN_HEADERS.has(key) && value !== undefined && value !== null) headers[key] = String(value);
    }
    headers.host = target.host;
    headers['accept-encoding'] = 'identity';
    if (body !== null) headers['content-length'] = String(body.length);

    const signal = opts.signal || null;
    if (signal && signal.aborted) throw signal.reason;
    await acquire(signal);
    return send(target, method, headers, body, signal);
  }

  function close() {
    if (closed) return;
    closed = true;
    const failure = new LocalTransportError('LOCAL_TRANSPORT_CLOSED', 'This local transport is closed.');
    for (const entry of waiting.splice(0)) {
      entry.stopListening();
      entry.reject(failure);
    }
    agent.destroy();
  }

  const frozenAddresses = Object.freeze([...pinned.addresses]);
  return Object.freeze({
    fetch,
    close,
    baseUrl: base.href,
    protocol: base.protocol,
    addresses: frozenAddresses,
    addressClass: pinned.addressClass,
    tlsPinned: fingerprint !== null,
    grade: gradeOf({
      pinned: { addresses: frozenAddresses, class: pinned.addressClass },
      protocol: base.protocol,
      tlsFingerprint: fingerprint,
    }),
  });
}

module.exports = { createLocalTransport, LocalTransportError };
