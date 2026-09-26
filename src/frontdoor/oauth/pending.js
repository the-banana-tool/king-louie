// Pending authorizations (fleet stage 4 §3.4, R23): memory only, 10 minutes
// on the front door's clock, capped per IP, per client host and overall. A
// request the owner's phone has claimed (looked it up by its typed code) is
// never evicted or replaced; only that device can decide it.
const crypto = require('crypto');
const { randomUserCode } = require('../protocol/messages');
const { OAuthError } = require('./errors');
const { rateKey } = require('./clients');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();

// Equal-length buffers compared without an early exit.
function sameBytes(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class PendingAuthorizations {
  constructor({ now = Date.now, ttlMs = 600000, perIp = 3, perIpWindowMs = 600000, max = 50 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.perIp = perIp;
    this.perIpWindowMs = perIpWindowMs;
    this.max = max;
    this.items = new Map();
    this.ipHits = new Map(); // rate key (IPv4, or an IPv6 /64) → [times]
  }

  sweep() {
    const t = this.now();
    for (const [id, p] of this.items) if (t > p.expires_at_ms) this.items.delete(id);
    for (const [key, hits] of this.ipHits) {
      const fresh = hits.filter((at) => t - at < this.perIpWindowMs);
      if (fresh.length) this.ipHits.set(key, fresh);
      else this.ipHits.delete(key);
    }
  }

  size() {
    this.sweep();
    return this.items.size;
  }

  // The per-IP limit on its own, so the server can spend it on work that
  // happens before a request exists (fetching a client metadata document).
  assertIpAllowed(ip) {
    this.sweep();
    if ((this.ipHits.get(rateKey(ip)) || []).length >= this.perIp) {
      throw new OAuthError('temporarily_unavailable', 'too many connection requests from this address; try again in a few minutes', 429);
    }
  }

  countIp(ip) {
    this.assertIpAllowed(ip);
    const key = rateKey(ip);
    const hits = this.ipHits.get(key) || [];
    hits.push(this.now());
    this.ipHits.set(key, hits);
  }

  // ipCounted: the caller already spent this address's hit (countIp) on
  // the same attempt.
  create({ client, redirectUri, codeChallenge, resource, requestedScopes, preselected, state = null, ip = 'unknown', clientHost, ipCounted = false }) {
    this.sweep();
    if (!ipCounted) this.assertIpAllowed(ip);
    const t = this.now();
    for (const [id, p] of this.items) {
      if (p.client_host === clientHost && !p.claimed_by) this.items.delete(id);
    }
    if (this.items.size >= this.max) {
      const oldest = [...this.items.values()].filter((p) => !p.claimed_by).sort((a, b) => a.created_at_ms - b.created_at_ms)[0];
      if (!oldest) throw new OAuthError('temporarily_unavailable', 'the front door is busy; try again in a few minutes', 429);
      this.items.delete(oldest.grant_id);
    }
    let userCode;
    do {
      userCode = randomUserCode();
    } while ([...this.items.values()].some((p) => p.user_code === userCode));
    const cookie = crypto.randomBytes(32).toString('base64url');
    const pending = {
      grant_id: `gr_${crypto.randomBytes(16).toString('base64url')}`,
      client_id: client.client_id,
      client_name: client.client_name,
      client_kind: client.kind,
      client_host: clientHost,
      redirect_uri: redirectUri,
      resource,
      code_challenge: codeChallenge,
      user_code: userCode,
      requested_scopes: [...requestedScopes],
      preselected: [...preselected],
      state,
      created_at_ms: t,
      expires_at_ms: t + this.ttlMs,
      claimed_by: null,
      cookie_hash: sha(cookie),
      nonces: new Set(),
      status: 'pending',
      code: null,
      ip
    };
    if (!ipCounted) this.countIp(ip);
    this.items.set(pending.grant_id, pending);
    return { pending, cookie };
  }

  get(grantId) {
    const p = this.items.get(grantId);
    if (!p || this.now() > p.expires_at_ms) return null;
    return p;
  }

  // Every live request is compared, each in constant time, so the time taken
  // says nothing about how close a guess was. Guessing is bounded where the
  // code is typed: the phone route allows 10 lookups a minute per device.
  byUserCode(code) {
    const want = Buffer.from(String(code));
    const t = this.now();
    let found = null;
    for (const p of this.items.values()) {
      const match = sameBytes(Buffer.from(p.user_code), want);
      if (match && t <= p.expires_at_ms && p.status === 'pending') found = p;
    }
    return found;
  }

  // The first device to claim a request owns it; any other gets null.
  claim(grantId, deviceId) {
    const p = this.get(grantId);
    if (!p || p.status !== 'pending' || typeof deviceId !== 'string' || !deviceId) return null;
    if (p.claimed_by && p.claimed_by !== deviceId) return null;
    p.claimed_by = deviceId;
    return p;
  }

  // The cookie is stored only as its SHA-256; both sides are hashed, so the
  // comparison is of equal-length digests.
  checkCookie(grantId, cookie) {
    const p = this.items.get(grantId);
    if (!p || typeof cookie !== 'string' || !cookie) return false;
    return sameBytes(p.cookie_hash, sha(cookie));
  }

  settle(grantId, { status, code = null }) {
    if (status !== 'approved' && status !== 'denied') throw new Error(`a pending authorization settles as approved or denied, not ${status}`);
    const p = this.items.get(grantId);
    if (!p) return null;
    p.status = status;
    p.code = code;
    return p;
  }

  remove(grantId) {
    this.items.delete(grantId);
  }
}

module.exports = { PendingAuthorizations };
