// The relay's phone API (spec §4.5): a route registry (E2) with device
// signatures, code/invite path credentials, rate limits and a body cap. F3's
// own routes register through it (routes.js), as do F4, F5 and C4; a later
// registration of the same method and path replaces the earlier one (E8).
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { verifyEs256 } = require('../approvals/envelope');
const { phoneAuthString, isTimestamp } = require('../approvals/messages');

const log = createLogger('frontdoor/phone-api');

const BODY_LIMIT = 262144;
const SKEW_MS = 120000;
const REPLAY_MS = 5 * 60 * 1000;
const MAX_BUCKETS = 5000;
const AUTH_KINDS = ['device', 'none', 'code', 'invite'];

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function compile(pathPattern) {
  if (typeof pathPattern !== 'string' || !pathPattern.startsWith('/v1/')) throw new TypeError(`route paths live under /v1/: ${pathPattern}`);
  const names = [];
  const source = pathPattern.split('/').map((segment) => {
    const m = /^\{([a-z_]+)\}$/.exec(segment);
    if (m) {
      names.push(m[1]);
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

// Evicts the oldest (insertion-order) entries once a Map passes `max` — the
// same bounding style invites.js uses for its code/invite maps.
function boundMap(map, max) {
  if (map.size <= max) return;
  let excess = map.size - max;
  for (const id of map.keys()) {
    if (excess-- <= 0) break;
    map.delete(id);
  }
}

function createPhoneApi({ devices, rateLimits = {}, now = Date.now, relay = null, bodyLimit = BODY_LIMIT } = {}) {
  const limits = { unauthPerMin: 10, devicePerMin: 120, ...rateLimits };
  const routes = [];
  const replay = new Map();
  const buckets = new Map();

  function registerRoute(method, pathPattern, { auth = 'device', rate = null, handler } = {}) {
    if (!AUTH_KINDS.includes(auth)) throw new TypeError(`auth must be one of ${AUTH_KINDS.join(', ')}`);
    if (typeof handler !== 'function') throw new TypeError('registerRoute needs a handler');
    const route = { method: String(method).toUpperCase(), pattern: pathPattern, ...compile(pathPattern), auth, rate, handler };
    const i = routes.findIndex((r) => r.method === route.method && r.pattern === pathPattern);
    if (i >= 0) routes[i] = route;
    else routes.push(route);
  }

  // Sweeps every bucket of hits older than the 60 s window before ever
  // growing one (so an IP or device that calls once and never again doesn't
  // linger), then bounds the map's overall size so an unbounded set of
  // IPs/devices can't grow it forever.
  function rateLimit(key, perMin) {
    const t = now();
    for (const [k, hits] of buckets) {
      const fresh = hits.filter((at) => t - at < 60000);
      if (fresh.length === 0) buckets.delete(k);
      else if (fresh.length !== hits.length) buckets.set(k, fresh);
    }
    const hits = buckets.get(key) || [];
    if (hits.length >= perMin) {
      const retryAfter = Math.max(1, Math.ceil((hits[0] + 60000 - t) / 1000));
      throw new ApiError(429, 'rate_limited', 'too many requests', { retry_after: retryAfter });
    }
    hits.push(t);
    buckets.set(key, hits);
    boundMap(buckets, MAX_BUCKETS);
  }

  // Verifies the device signature and returns { device, replayKey } without
  // marking the replay entry used. The caller applies the per-device rate
  // limit before committing the replay entry, so a 429 never burns the
  // one-time signed string — the same request can still succeed once the
  // device's window clears.
  function verifyDeviceSignature(req, pathWithQuery, body) {
    const deviceId = req.headers['x-kl-device'];
    const timestamp = req.headers['x-kl-timestamp'];
    const signature = req.headers['x-kl-signature'];
    if (!deviceId || !timestamp || !signature) throw new ApiError(401, 'unauthorized', 'device signature headers are missing');
    // Date.parse would silently normalize a syntactically valid but
    // nonexistent date (e.g. 2026-02-30) forward; isTimestamp rejects it.
    if (!isTimestamp(timestamp)) throw new ApiError(401, 'bad_timestamp', 'X-KL-Timestamp must be RFC 3339 UTC');
    if (Math.abs(Date.parse(timestamp) - now()) > SKEW_MS) {
      throw new ApiError(401, 'clock_skew', "the phone's clock is more than 120 s off", { server_time: new Date(now()).toISOString() });
    }
    const device = devices.get(deviceId);
    if (!device) throw new ApiError(401, 'unknown_device', 'this device is not registered with the relay');
    const s = phoneAuthString(req.method, pathWithQuery, timestamp, body);
    const envelope = { alg: 'ES256', kid: deviceId, payload: Buffer.from(s, 'utf8').toString('base64url'), sig: String(signature) };
    if (!verifyEs256(envelope, device.jwk)) throw new ApiError(401, 'bad_signature', 'the request signature does not verify');
    // Keyed on the signed string, not the (malleable) signature value.
    const replayKey = `${crypto.createHash('sha256').update(s).digest('base64url')}|${deviceId}`;
    const t = now();
    for (const [k, until] of replay) if (until <= t) replay.delete(k);
    if (replay.has(replayKey)) throw new ApiError(401, 'replay', 'this signed request was already used');
    return { device, replayKey };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > bodyLimit) {
          failed = true;
          reject(new ApiError(413, 'body_too_large', `bodies are limited to ${bodyLimit} bytes`));
          // Stop pulling further chunks — no draining a payload this far
          // past the limit — without destroying the socket outright: the
          // 413 response still has to go out over it. The handler answers
          // with `Connection: close` for this error, so Node drops the
          // connection itself once that response is flushed.
          req.pause();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      req.on('error', (err) => { if (!failed) { failed = true; reject(err); } });
    });
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  async function handler(req, res) {
    const pathWithQuery = req.url;
    const url = new URL(req.url, 'http://relay.invalid');
    let route = null;
    try {
      const matching = routes.filter((r) => r.regex.test(url.pathname));
      if (matching.length === 0) throw new ApiError(404, 'not_found', 'no such route');
      route = matching.find((r) => r.method === req.method);
      if (!route) throw new ApiError(405, 'method_not_allowed', `${req.method} is not allowed here`);

      let values;
      try {
        values = route.regex.exec(url.pathname).slice(1).map((v) => decodeURIComponent(v));
      } catch {
        // A malformed percent-escape in a path segment: as far as the caller
        // can tell there's no such route, and it's client noise, never worth
        // logging.
        throw new ApiError(404, 'not_found', 'no such route');
      }
      const params = Object.fromEntries(route.names.map((n, i) => [n, values[i]]));
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';

      // The per-IP limit runs for every route, before the body is even read,
      // so that traffic that never authenticates (a device route with a
      // missing or bad signature) is still bounded. The per-device limit
      // below runs later, only once a device route's signature has actually
      // verified.
      rateLimit(`ip:${ip}|${route.pattern}`, route.auth === 'device' ? limits.unauthPerMin : (route.rate && route.rate.perMin) || limits.unauthPerMin);

      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
        // Refused before a byte of the body is read.
        throw new ApiError(413, 'body_too_large', `bodies are limited to ${bodyLimit} bytes`);
      }
      const body = await readBody(req);

      let device = null;
      if (route.auth === 'device') {
        const verified = verifyDeviceSignature(req, pathWithQuery, body);
        rateLimit(`device:${verified.device.device_id}|${route.pattern}`, (route.rate && route.rate.perMin) || limits.devicePerMin);
        replay.set(verified.replayKey, now() + REPLAY_MS);
        device = verified.device;
      } else if (route.auth === 'code' && !(relay && relay.invites && relay.invites.getCode(params.code_id))) {
        throw new ApiError(404, 'unknown_code', 'no enrollment code with that id');
      } else if (route.auth === 'invite') {
        const invite = relay && relay.invites && relay.invites.getInvite(params.id);
        if (!invite || invite.claim) throw new ApiError(404, 'unknown_invite', 'no open invite with that id');
      }

      let parsed = null;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new ApiError(400, 'bad_json', 'the body is not JSON');
        }
      }
      const ctx = { deviceId: device ? device.device_id : null, device, params, query: Object.fromEntries(url.searchParams), body: parsed, relay };
      const result = (await route.handler(req, ctx)) || {};
      send(res, result.status || 200, result.body, result.headers);
    } catch (err) {
      if (err instanceof ApiError) {
        // A too-large body: tell Node to drop the connection once this
        // response is flushed, instead of keeping it open to drain (or, worse,
        // destroying the socket outright before the response reaches the
        // caller — killing it mid-flight resets the connection instead of
        // delivering the 413).
        const headers = err.code === 'body_too_large' ? { connection: 'close' } : {};
        send(res, err.status, { error: err.code, message: err.message, ...err.extra }, headers);
        return;
      }
      if (err && Number.isInteger(err.status) && err.code) {
        send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      // Never the concrete path: invite and enrollment code ids inside it are
      // bearer credentials. route.pattern is the generic template.
      log.error(`phone API ${req.method} ${route ? route.pattern : '(unmatched route)'} failed: ${err && err.message}`);
      send(res, 500, { error: 'internal', message: 'the relay could not handle this request' });
    }
  }

  return { registerRoute, handler, relay, routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.auth })) };
}

module.exports = { createPhoneApi, ApiError, BODY_LIMIT, SKEW_MS };
