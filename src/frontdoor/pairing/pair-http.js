// The node side of pairing (fleet stage 4 §3.11, §4.9): POST /pair/v1 with
// a signed kl.node.pair, then GET /pair/v1/{pairing_id} until the owner
// decides. Outside /v1 (no device auth); 10 requests a minute per IP.
const { createLogger } = require('../../logging');
const { readBody, sendJson, clientIp } = require('../http-util');
const { rateKey } = require('../oauth/clients');

const log = createLogger('frontdoor/pair-http');

const BODY_LIMIT = 65536;
const WINDOW_MS = 60000;
// The limiter's memory is bounded: at most this many addresses are tracked
// (the one idle longest is forgotten first), and idle ones are swept once a
// window.
const MAX_IPS = 5000;
const STATUS_RE = /^\/pair\/v1\/(pr_[A-Za-z0-9_-]{22})$/;

function createPairHandler({ pairing, perMin = 10, now = Date.now, maxIps = MAX_IPS } = {}) {
  if (!pairing || typeof pairing.submit !== 'function' || typeof pairing.status !== 'function') throw new TypeError('createPairHandler needs the pairing service');
  const hits = new Map(); // rate key (IPv4, or an IPv6 /64) → times in the window, oldest first
  let lastSweep = -Infinity;

  const sweep = (t) => {
    for (const [key, times] of hits) if (t - times[times.length - 1] >= WINDOW_MS) hits.delete(key);
    lastSweep = t;
  };

  // 0 when the request may go ahead (and it is counted), else seconds to wait.
  const retryAfter = (ip) => {
    const t = now();
    if (t - lastSweep >= WINDOW_MS) sweep(t);
    const key = rateKey(ip);
    const recent = (hits.get(key) || []).filter((at) => t - at < WINDOW_MS);
    hits.delete(key); // re-inserted below, so the map stays in last-seen order
    if (recent.length >= perMin) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - t) / 1000));
    }
    recent.push(t);
    hits.set(key, recent);
    while (hits.size > maxIps) hits.delete(hits.keys().next().value);
    return 0;
  };

  async function handlePair(req, res) {
    try {
      const url = new URL(req.url, 'http://frontdoor.invalid');
      // The real peer address (clientIp never reads X-Forwarded-For).
      const wait = retryAfter(clientIp(req));
      if (wait) {
        sendJson(res, 429, { error: 'rate_limited', retry_after: wait }, { 'retry-after': String(wait) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/pair/v1') {
        let envelope;
        try {
          envelope = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8'));
        } catch (e) {
          if (e && e.status === 413) sendJson(res, 413, { error: 'body_too_large' }, { connection: 'close' });
          else sendJson(res, 400, { error: 'bad_json' });
          return;
        }
        const r = pairing.submit(envelope);
        if (r.ok) sendJson(res, 200, r.envelope);
        else sendJson(res, r.status, { error: r.reason });
        return;
      }
      const m = STATUS_RE.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const s = pairing.status(m[1]);
        if (s) sendJson(res, 200, s);
        else sendJson(res, 404, { error: 'unknown_pairing' });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error(`/pair/v1 failed: ${e.message}`);
      sendJson(res, 500, { error: 'internal' });
    }
  }

  handlePair.trackedIps = () => hits.size;
  return handlePair;
}

module.exports = { createPairHandler };
