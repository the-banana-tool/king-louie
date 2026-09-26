// Single-use challenges for phone-signed removals (§4.6): 32 random bytes,
// two minutes on the front door's clock, at most 20 live per device. A used
// challenge is remembered until it would have expired twice over, so a
// replay says `reused` rather than `unknown`.
//
// Each challenge is bound to the purpose it was issued for (ruling
// T2-purpose): a live challenge for a client revoke cannot be spent on a
// node removal, or the other way round.
const crypto = require('crypto');
const { err } = require('../errors');

// The purposes the acceptance checks spend: 'revoke' (kl.client.revoke),
// 'remove' (kl.node.remove).
const CHALLENGE_PURPOSES = Object.freeze(['revoke', 'remove']);

class Challenges {
  constructor({ now = Date.now, ttlMs = 120000, perDevice = 20, entries = [] } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.perDevice = perDevice;
    this.items = new Map();
    for (const e of entries) {
      this.items.set(e.challenge, { deviceId: e.device_id, purpose: e.purpose, expiresAt: e.expires_at_ms, used: e.used === true });
    }
  }

  sweep() {
    const t = this.now();
    for (const [c, e] of this.items) if (t > e.expiresAt + this.ttlMs) this.items.delete(c);
  }

  issue(deviceId, purpose) {
    if (!CHALLENGE_PURPOSES.includes(purpose)) throw err('bad_purpose', `a challenge purpose is one of ${CHALLENGE_PURPOSES.join(', ')}`);
    this.sweep();
    const t = this.now();
    let live = 0;
    for (const e of this.items.values()) if (e.deviceId === deviceId && !e.used && t <= e.expiresAt) live += 1;
    if (live >= this.perDevice) throw err('too_many_challenges', `at most ${this.perDevice} live challenges per device`);
    const challenge = crypto.randomBytes(32).toString('base64url');
    this.items.set(challenge, { deviceId, purpose, expiresAt: t + this.ttlMs, used: false });
    return { challenge, expires_in_ms: this.ttlMs };
  }

  // 'ok' marks it used; everything else leaves it as it was. A seeded entry
  // with no known purpose matches none, so it is never spendable.
  take(deviceId, challenge, purpose) {
    const e = this.items.get(challenge);
    if (!e || e.deviceId !== deviceId) return 'unknown';
    if (!CHALLENGE_PURPOSES.includes(e.purpose) || e.purpose !== purpose) return 'wrong_purpose';
    if (e.used) return 'reused';
    if (!(this.now() <= e.expiresAt)) return 'expired';
    e.used = true;
    return 'ok';
  }
}

module.exports = { Challenges, CHALLENGE_PURPOSES };
