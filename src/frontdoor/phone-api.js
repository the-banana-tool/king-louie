// The relay's phone API (spec §4.5): a route registry (E2) with device
// signatures, code/invite path credentials, rate limits and a body cap. F3's
// own routes register through it (routes.js), as do F4, F5 and C4; a later
// registration of the same method and path replaces the earlier one (E8).
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { verifyEs256 } = require('../approvals/envelope');
const { phoneAuthString, TIMESTAMP_RE } = require('../approvals/messages');

const log = createLogger('frontdoor/phone-api');

const BODY_LIMIT = 262144;
const SKEW_MS = 120000;
const REPLAY_MS = 5 * 60 * 1000;
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

  function rateLimit(key, perMin) {
    const t = now();
    const hits = (buckets.get(key) || []).filter((at) => t - at < 60000);
    if (hits.length >= perMin) {
      const retryAfter = Math.max(1, Math.ceil((hits[0] + 60000 - t) / 1000));
      buckets.set(key, hits);
      throw new ApiError(429, 'rate_limited', 'too many requests', { retry_after: retryAfter });
    }
    hits.push(t);
    buckets.set(key, hits);
  }

  function authenticateDevice(req, pathWithQuery, body) {
    const deviceId = req.headers['x-kl-device'];
    const timestamp = req.headers['x-kl-timestamp'];
    const signature = req.headers['x-kl-signature'];
    if (!deviceId || !timestamp || !signature) throw new ApiError(401, 'unauthorized', 'device signature headers are missing');
    if (!TIMESTAMP_RE.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new ApiError(401, 'bad_timestamp', 'X-KL-Timestamp must be RFC 3339 UTC');
    if (Math.abs(Date.parse(timestamp) - now()) > SKEW_MS) {
      throw new ApiError(401, 'clock_skew', "the phone's clock is more than 120 s off", { server_time: new Date(now()).toISOString() });
    }
    const device = devices.get(deviceId);
    if (!device) throw new ApiError(401, 'unknown_device', 'this device is not registered with the relay');
    const s = phoneAuthString(req.method, pathWithQuery, timestamp, body);
    const envelope = { alg: 'ES256', kid: deviceId, payload: Buffer.from(s, 'utf8').toString('base64url'), sig: String(signature) };
    if (!verifyEs256(envelope, device.jwk)) throw new ApiError(401, 'bad_signature', 'the request signature does not verify');
    // Keyed on the signed string, not the (malleable) signature value.
    const key = `${crypto.createHash('sha256').update(s).digest('base64url')}|${deviceId}`;
    const t = now();
    for (const [k, until] of replay) if (until <= t) replay.delete(k);
    if (replay.has(key)) throw new ApiError(401, 'replay', 'this signed request was already used');
    replay.set(key, t + REPLAY_MS);
    return device;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > bodyLimit) {
          if (!failed) reject(new ApiError(413, 'body_too_large', `bodies are limited to ${bodyLimit} bytes`));
          failed = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
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
    try {
      const matching = routes.filter((r) => r.regex.test(url.pathname));
      if (matching.length === 0) throw new ApiError(404, 'not_found', 'no such route');
      const route = matching.find((r) => r.method === req.method);
      if (!route) throw new ApiError(405, 'method_not_allowed', `${req.method} is not allowed here`);
      const values = route.regex.exec(url.pathname).slice(1).map((v) => decodeURIComponent(v));
      const params = Object.fromEntries(route.names.map((n, i) => [n, values[i]]));
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';

      const body = await readBody(req);
      let device = null;
      if (route.auth === 'device') {
        device = authenticateDevice(req, pathWithQuery, body);
        rateLimit(`device:${device.device_id}`, (route.rate && route.rate.perMin) || limits.devicePerMin);
      } else {
        rateLimit(`ip:${ip}`, (route.rate && route.rate.perMin) || limits.unauthPerMin);
        if (route.auth === 'code' && !(relay && relay.invites && relay.invites.getCode(params.code_id))) {
          throw new ApiError(404, 'unknown_code', 'no enrollment code with that id');
        }
        if (route.auth === 'invite') {
          const invite = relay && relay.invites && relay.invites.getInvite(params.id);
          if (!invite || invite.claim) throw new ApiError(404, 'unknown_invite', 'no open invite with that id');
        }
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
        send(res, err.status, { error: err.code, message: err.message, ...err.extra });
        return;
      }
      if (err && Number.isInteger(err.status) && err.code) {
        send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      log.error(`phone API ${req.method} ${url.pathname} failed: ${err && err.message}`);
      send(res, 500, { error: 'internal', message: 'the relay could not handle this request' });
    }
  }

  return { registerRoute, handler, relay, routes: () => routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.auth })) };
}

module.exports = { createPhoneApi, ApiError, BODY_LIMIT, SKEW_MS };
