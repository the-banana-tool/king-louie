// Grants (fleet stage 4 §3.4, §4.1): what the owner's phone signed for one
// client, kept with that signature. On every load each grant is re-verified
// against the admin-owned approvers, so a grant file the service account
// could edit decides nothing on its own. Authorization codes live in memory.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { canonicalize } = require('../../platform/jcs');
const { verifyPhoneEnvelope } = require('../protocol/checks');
const { formatScope } = require('../../fleet/scope-rules');

const log = createLogger('frontdoor/oauth/grants');
const TOUCH_EVERY_MS = 60000;
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');

// The fields a grant record binds, each compared with what the phone signed.
const BOUND_FIELDS = ['grant_id', 'client_id', 'client_name', 'redirect_uri', 'resource', 'device_id'];

class GrantStore extends EventEmitter {
  constructor({ file, approverStore, frontdoorId, alerts = null, now = Date.now } = {}) {
    super();
    this.file = file;
    this.approverStore = approverStore;
    this.frontdoorId = frontdoorId;
    this.alerts = alerts;
    this.now = now;
    this.grants = new Map();
    this.lastTouchSave = new Map();
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, grants: Object.fromEntries(this.grants) }, null, 2)}\n`);
  }

  // R25: verified against the admin approvers as of the grant's own
  // accepted_at, so revoking a phone later does not undo what it approved.
  _problem(g) {
    if (!g || typeof g !== 'object' || !g.signed_grant || typeof g.accepted_at !== 'string' || !Array.isArray(g.scopes)) return 'malformed';
    if (!(g.revoked_at === null || typeof g.revoked_at === 'string')) return 'malformed';
    const v = verifyPhoneEnvelope(g.signed_grant, { approverStore: this.approverStore, type: 'kl.client.grant', frontdoorId: this.frontdoorId, acceptedAt: g.accepted_at });
    if (!v.ok) return v.reason;
    const m = v.message;
    if (m.decision !== 'approve') return 'not_approved';
    if (BOUND_FIELDS.some((k) => m[k] !== g[k]) || canonicalize(m.scopes) !== canonicalize(g.scopes)) return 'record_mismatch';
    return null;
  }

  load() {
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')).grants || {};
    } catch (err) {
      if (err.code !== 'ENOENT') log.error(`cannot read ${this.file}: ${err.message}; starting with no grants`);
      stored = {};
    }
    this.grants = new Map();
    let dropped = 0;
    for (const [key, g] of Object.entries(stored)) {
      let reason;
      try {
        reason = this._problem(g);
      } catch {
        reason = 'malformed';
      }
      if (!reason && key !== g.grant_id) reason = 'record_mismatch';
      const id = g && typeof g.grant_id === 'string' ? g.grant_id : key;
      if (reason) {
        dropped += 1;
        log.error(`dropping grant ${id}: ${reason}`);
        if (this.alerts) this.alerts.raise('node_record_invalid', { subject: `grant:${id}`, detail: { reason } });
        continue;
      }
      this.grants.set(g.grant_id, g);
    }
    if (dropped) this._save();
    return this.list({ liveOnly: false });
  }

  // `message` is the verified kl.client.grant; the record keeps what the
  // phone signed, byte for byte, so load() can compare the two.
  create({ pending, envelope, message, acceptedAt = new Date(this.now()).toISOString() }) {
    const grant = {
      grant_id: message.grant_id,
      client_id: message.client_id,
      client_name: message.client_name,
      client_host: pending.client_host,
      redirect_uri: message.redirect_uri,
      resource: message.resource,
      scopes: message.scopes.map((s) => ({ scope: s.scope, machines: s.machines === null ? null : [...s.machines] })),
      device_id: message.device_id,
      accepted_at: acceptedAt,
      signed_grant: envelope,
      revoked_at: null,
      revoked_reason: null,
      last_used_at: null
    };
    this.grants.set(grant.grant_id, grant);
    this._save();
    return grant;
  }

  get(id) {
    return this.grants.get(id) || null;
  }

  live(id) {
    const g = this.grants.get(id);
    return g && g.revoked_at === null ? g : null;
  }

  list({ liveOnly = true } = {}) {
    return [...this.grants.values()].filter((g) => !liveOnly || g.revoked_at === null);
  }

  revoke(id, reason) {
    const g = this.grants.get(id);
    if (!g || g.revoked_at !== null) return false;
    g.revoked_at = new Date(this.now()).toISOString();
    g.revoked_reason = reason;
    this._save();
    this.emit('revoked', id);
    return true;
  }

  // last_used_at is kept in memory on every use and written at most once a
  // minute per grant.
  touch(id) {
    const g = this.grants.get(id);
    if (!g) return;
    const t = this.now();
    g.last_used_at = new Date(t).toISOString();
    if (t - (this.lastTouchSave.get(id) || 0) >= TOUCH_EVERY_MS) {
      this.lastTouchSave.set(id, t);
      this._save();
    }
  }

  scopeStrings(grant) {
    return grant.scopes.map((s) => formatScope(s));
  }
}

// Authorization codes: 32 random bytes, single use, 60 s, held only as their
// SHA-256. A code that was redeemed and is presented again reports `reused`
// with its grant, so the token endpoint can revoke what it issued (RFC 6749
// §4.1.2). A code that expired unredeemed only ever reports `expired`: no
// token came from it, so there is nothing to revoke.
class AuthCodes {
  constructor({ now = Date.now, ttlMs = 60000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.codes = new Map();
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.codes) if (t > v.expiresAt + this.ttlMs) this.codes.delete(k);
  }

  issue({ grantId, clientId, redirectUri, codeChallenge, resource }) {
    this.sweep();
    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(sha(code), { grantId, clientId, redirectUri, codeChallenge, resource, expiresAt: this.now() + this.ttlMs, used: false });
    return code;
  }

  take(code) {
    if (typeof code !== 'string' || !code) return { ok: false };
    const rec = this.codes.get(sha(code));
    if (!rec) return { ok: false };
    if (rec.used) return { ok: false, reused: rec.grantId };
    if (!(this.now() <= rec.expiresAt)) return { ok: false, expired: true };
    rec.used = true;
    const { grantId, clientId, redirectUri, codeChallenge, resource } = rec;
    return { ok: true, record: { grantId, clientId, redirectUri, codeChallenge, resource } };
  }
}

module.exports = { GrantStore, AuthCodes };
