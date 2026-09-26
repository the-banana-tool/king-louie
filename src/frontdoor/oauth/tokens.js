// Opaque tokens (fleet stage 4 §3.4): the resource server is this process,
// so every request looks the token up and revocation is immediate. Only
// SHA-256 hashes are stored. Refresh tokens rotate on every use; a rotated
// token presented again is reuse and revokes the grant, except once, within
// 30 s, while the successor is still unused (a client retrying a refresh
// whose answer it lost).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { parseScope, formatScope } = require('../../fleet/scope-rules');
const { OAuthError } = require('./errors');
const { readBody, parseForm, sendJson } = require('../http-util');
const { recordFrontDoorEvent } = require('../audit/own-ledger');

const log = createLogger('frontdoor/oauth/tokens');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const BODY_LIMIT = 65536;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class TokenStore {
  constructor({ file, now = Date.now, accessTtlMs = 3600000, refreshIdleTtlMs = 30 * 86400000, graceMs = 30000, grants = null } = {}) {
    this.file = file;
    this.now = now;
    this.accessTtlMs = accessTtlMs;
    this.refreshIdleTtlMs = refreshIdleTtlMs;
    this.graceMs = graceMs;
    this.access = new Map();
    this.refreshTokens = new Map();
    this.grants = null;
    this._load();
    if (grants) this.attachGrants(grants);
  }

  // A file that cannot be loaded is moved aside, never overwritten (as for
  // clients.json): clients whose tokens were in it authorize again.
  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this._quarantine(`cannot be read (${err.code || err.message})`);
      return;
    }
    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    if (!isPlainObject(stored) || !isPlainObject(stored.access) || !isPlainObject(stored.refresh)) {
      this._quarantine('is not a valid token list');
      return;
    }
    for (const [h, r] of Object.entries(stored.access)) if (isPlainObject(r)) this.access.set(h, r);
    for (const [h, r] of Object.entries(stored.refresh)) if (isPlainObject(r)) this.refreshTokens.set(h, r);
  }

  _quarantine(why) {
    const aside = `${this.file}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.file, aside);
    } catch (err) {
      throw new Error(`${this.file} ${why} and cannot be moved aside (${err.code || err.message}); refusing to start with no tokens`);
    }
    log.error(`${this.file} ${why}; moved it to ${aside} and starting with no tokens`);
  }

  // Every revocation path (the phone, /oauth/revoke, reuse) reaches the
  // tokens through the grant store's 'revoked' event; authenticate() and
  // refresh() also ask the store on every call, so a missed event still
  // fails closed.
  attachGrants(grants) {
    if (this.grants === grants) return;
    if (this.grants) throw new Error('this token store is already bound to a grant store');
    this.grants = grants;
    if (typeof grants.on === 'function') {
      grants.on('revoked', (grantId) => {
        try {
          this.revokeGrant(grantId);
        } catch (err) {
          log.error(`dropping the tokens of revoked grant ${grantId} failed to save: ${err.message}`);
        }
      });
    }
  }

  // Fails closed: a store bound to no grant store authenticates nothing and
  // refreshes nothing.
  _liveGrant(grantId) {
    return this.grants ? this.grants.live(grantId) || null : null;
  }

  // Saves, or puts the in-memory change back and rethrows, so a failed save
  // leaves the client's token as it was and its retry is not reuse.
  _commit(undo) {
    try {
      this._save();
    } catch (err) {
      undo();
      throw err;
    }
  }

  _unmint(minted) {
    const r = this.refreshTokens.get(minted.refreshHash);
    if (r) this.access.delete(r.access_hash);
    this.refreshTokens.delete(minted.refreshHash);
  }

  _save() {
    const t = this.now();
    for (const [h, r] of this.access) if (r.exp <= t) this.access.delete(h);
    for (const [h, r] of this.refreshTokens) if (t - r.last_used > this.refreshIdleTtlMs) this.refreshTokens.delete(h);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, access: Object.fromEntries(this.access), refresh: Object.fromEntries(this.refreshTokens) })}\n`);
  }

  _mint({ grantId, clientId, scopes, aud, generation }) {
    const t = this.now();
    const accessToken = `kla_${crypto.randomBytes(32).toString('base64url')}`;
    const refreshToken = `klr_${crypto.randomBytes(32).toString('base64url')}`;
    const accessHash = sha(accessToken);
    const refreshHash = sha(refreshToken);
    this.access.set(accessHash, { grant_id: grantId, client_id: clientId, scopes: [...scopes], aud, exp: t + this.accessTtlMs });
    this.refreshTokens.set(refreshHash, {
      grant_id: grantId, client_id: clientId, scopes: [...scopes], aud, generation, state: 'live', successor: null, graced: false,
      rotated_at: null, used: false, last_used: t, access_hash: accessHash
    });
    return {
      pair: { access_token: accessToken, token_type: 'Bearer', expires_in: Math.round(this.accessTtlMs / 1000), refresh_token: refreshToken, scope: scopes.join(' ') },
      refreshHash
    };
  }

  issuePair({ grantId, clientId, scopes, aud }) {
    const { pair } = this._mint({ grantId, clientId, scopes, aud, generation: 1 });
    this._save();
    return pair;
  }

  authenticate(token, { aud } = {}) {
    if (typeof token !== 'string' || !token.startsWith('kla_') || typeof aud !== 'string') return null;
    const rec = this.access.get(sha(token));
    if (!rec || !(this.now() < rec.exp) || rec.aud !== aud) return null;
    if (!this._liveGrant(rec.grant_id)) {
      if (this.grants) this.revokeGrant(rec.grant_id);
      return null;
    }
    return { ...rec, scopes: [...rec.scopes] };
  }

  // `scope` may only narrow what the token carries: each requested scope must
  // be one the token has, and every machine a requested limit names must be
  // one the grant pinned to a node id (grant.machine_ids, ruling T23-nodeid)
  // and, for a limited entry, one of its machines (ruling T24-narrow). The
  // result keeps every limit.
  _narrow(scopes, scope, grant) {
    if (scope === undefined || scope === null || String(scope).trim() === '') return scopes;
    const held = new Map(scopes.map((s) => {
      const e = parseScope(s);
      return [e.scope, e];
    }));
    const out = [];
    const seen = new Set();
    for (const w of String(scope).trim().split(/\s+/)) {
      let want;
      try {
        want = parseScope(w);
      } catch {
        throw new OAuthError('invalid_scope', 'each scope is <scope>[;machines=a,b], machines sorted and unique');
      }
      if (seen.has(want.scope)) throw new OAuthError('invalid_scope', `${want.scope} was requested twice`);
      seen.add(want.scope);
      const have = held.get(want.scope);
      if (!have) throw new OAuthError('invalid_scope', `the grant does not include ${want.scope}`);
      let machines = have.machines;
      if (want.machines) {
        const pinned = grant && grant.machine_ids !== null && typeof grant.machine_ids === 'object' ? grant.machine_ids : {};
        const allowed = (m) => Object.prototype.hasOwnProperty.call(pinned, m) && (have.machines === null || have.machines.includes(m));
        if (!want.machines.every(allowed)) {
          throw new OAuthError('invalid_scope', `${want.scope} names a machine the grant does not include`);
        }
        machines = want.machines;
      }
      out.push(formatScope({ scope: want.scope, machines }));
    }
    return out;
  }

  refresh({ token, clientId, scope = undefined }) {
    const hash = typeof token === 'string' && token.startsWith('klr_') ? sha(token) : null;
    const rec = hash ? this.refreshTokens.get(hash) : null;
    if (!rec) throw new OAuthError('invalid_grant', 'unknown refresh token');
    if (rec.client_id !== clientId) throw new OAuthError('invalid_grant', 'this refresh token was issued to another client');
    const grant = this._liveGrant(rec.grant_id);
    if (!grant) {
      if (this.grants) this.revokeGrant(rec.grant_id);
      throw new OAuthError('invalid_grant', 'the grant is gone');
    }
    const t = this.now();
    if (rec.state === 'live') {
      if (t - rec.last_used > this.refreshIdleTtlMs) {
        this.refreshTokens.delete(hash);
        this._save();
        throw new OAuthError('invalid_grant', 'the refresh token expired');
      }
      const scopes = this._narrow(rec.scopes, scope, grant);
      const minted = this._mint({ grantId: rec.grant_id, clientId, scopes, aud: rec.aud, generation: rec.generation + 1 });
      const before = { state: rec.state, rotated_at: rec.rotated_at, used: rec.used, successor: rec.successor };
      rec.state = 'rotated';
      rec.rotated_at = t;
      rec.used = true;
      rec.successor = minted.refreshHash;
      this._commit(() => {
        Object.assign(rec, before);
        this._unmint(minted);
      });
      return { pair: minted.pair, grantId: rec.grant_id };
    }
    // The grace (§3.4): once per rotation, within graceMs of it, while the
    // successor is live and unused. The successor and its access token are
    // superseded and a new pair is issued. Anything else is reuse.
    if (rec.state === 'rotated' && !rec.graced && t - rec.rotated_at <= this.graceMs) {
      const successor = this.refreshTokens.get(rec.successor);
      if (successor && successor.state === 'live' && !successor.used) {
        const scopes = this._narrow(rec.scopes, scope, grant);
        const before = { graced: rec.graced, successor: rec.successor };
        const successorAccess = this.access.get(successor.access_hash);
        rec.graced = true;
        successor.state = 'superseded';
        this.access.delete(successor.access_hash);
        const minted = this._mint({ grantId: rec.grant_id, clientId, scopes, aud: rec.aud, generation: rec.generation + 1 });
        rec.successor = minted.refreshHash;
        this._commit(() => {
          this._unmint(minted);
          Object.assign(rec, before);
          successor.state = 'live';
          if (successorAccess) this.access.set(successor.access_hash, successorAccess);
        });
        return { pair: minted.pair, grantId: rec.grant_id };
      }
    }
    return { reuse: rec.grant_id };
  }

  revokeGrant(grantId) {
    let changed = false;
    for (const [h, r] of this.access) if (r.grant_id === grantId) { this.access.delete(h); changed = true; }
    for (const [h, r] of this.refreshTokens) if (r.grant_id === grantId) { this.refreshTokens.delete(h); changed = true; }
    if (changed) this._save();
  }

  find(token) {
    if (typeof token !== 'string') return null;
    const h = sha(token);
    if (this.access.has(h)) return { kind: 'access', record: this.access.get(h) };
    if (this.refreshTokens.has(h)) return { kind: 'refresh', record: this.refreshTokens.get(h) };
    return null;
  }

  revokeAccess(token) {
    if (typeof token === 'string' && this.access.delete(sha(token))) this._save();
  }
}

// BASE64URL(SHA256(verifier)) == code_challenge, compared in constant time.
function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createTokenHandlers({ tokens, codes, grants, alerts = null, auditLedger = null, onGrantRevoked = () => {} } = {}) {
  tokens.attachGrants(grants);

  // The tokens go whatever the grant store does: if saving the revoked grant
  // throws, its 'revoked' event never fires, so nothing else would drop them.
  const revokeGrant = async (grantId, reason) => {
    let changed = false;
    try {
      changed = grants.revoke(grantId, reason);
    } finally {
      tokens.revokeGrant(grantId);
    }
    try {
      onGrantRevoked(grantId);
    } catch (err) {
      log.error(`onGrantRevoked(${grantId}) failed: ${err && err.message}`);
    }
    if (changed) await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.revoked', { grant_id: grantId, reason });
  };

  async function readForm(req) {
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new OAuthError('invalid_request', 'this endpoint takes application/x-www-form-urlencoded');
    }
    const body = await readBody(req, BODY_LIMIT);
    try {
      return parseForm(body);
    } catch (err) {
      throw new OAuthError('invalid_request', err.message);
    }
  }

  async function token(req, res) {
    const f = await readForm(req);
    let pair;
    let grantId;
    if (f.grant_type === 'authorization_code') {
      for (const k of ['code', 'redirect_uri', 'client_id', 'code_verifier']) if (!f[k]) throw new OAuthError('invalid_request', `${k} is required`);
      // Every binding and PKCE are checked before the code is spent: a
      // failing redemption neither consumes the code nor revokes the grant,
      // and only a second redemption that passes all of them is reuse.
      const verify = (rec) => rec.clientId === f.client_id && rec.redirectUri === f.redirect_uri
        && (f.resource === undefined || f.resource === rec.resource) && pkceMatches(f.code_verifier, rec.codeChallenge);
      const taken = codes.take(f.code, verify);
      if (taken.reused) {
        log.warn(`authorization code reuse on ${taken.reused}; revoking the grant`);
        await revokeGrant(taken.reused, 'code_reuse');
        throw new OAuthError('invalid_grant', 'this authorization code was already used; the grant is revoked');
      }
      if (taken.mismatch) throw new OAuthError('invalid_grant', 'client_id, redirect_uri, resource or code_verifier do not match the authorization');
      if (!taken.ok) throw new OAuthError('invalid_grant', taken.expired ? 'the authorization code expired' : 'unknown authorization code');
      const grant = grants.live(taken.record.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'the grant is gone');
      grantId = grant.grant_id;
      pair = tokens.issuePair({ grantId, clientId: grant.client_id, scopes: grants.scopeStrings(grant), aud: grant.resource });
    } else if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token || !f.client_id) throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
      const r = tokens.refresh({ token: f.refresh_token, clientId: f.client_id, scope: f.scope });
      if (r.reuse) {
        log.warn(`refresh token reuse on ${r.reuse}; revoking the grant`);
        await revokeGrant(r.reuse, 'refresh_reuse');
        if (alerts) alerts.raise('refresh_reuse', { subject: `grant:${r.reuse}`, detail: { client_id: f.client_id } });
        await recordFrontDoorEvent(auditLedger, 'frontdoor.refresh_reuse', { grant_id: r.reuse });
        throw new OAuthError('invalid_grant', 'this refresh token was already used; the grant is revoked');
      }
      const grant = grants.live(r.grantId);
      if (!grant) {
        tokens.revokeGrant(r.grantId);
        throw new OAuthError('invalid_grant', 'the grant is gone');
      }
      grantId = grant.grant_id;
      pair = r.pair;
    } else {
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
    grants.touch(grantId);
    await recordFrontDoorEvent(auditLedger, 'frontdoor.token.issued', { grant_id: grantId, kind: f.grant_type });
    sendJson(res, 200, pair, { pragma: 'no-cache' });
  }

  // RFC 7009: the answer is always 200 {}, so it never tells whether a token
  // existed. A request that cannot be read unambiguously (wrong type, a
  // parameter given twice) revokes nothing and answers the same.
  async function revoke(req, res) {
    let f = null;
    try {
      f = await readForm(req);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
    }
    const found = f ? tokens.find(f.token) : null;
    try {
      if (found && found.kind === 'refresh') await revokeGrant(found.record.grant_id, 'client_revoked');
      else if (found) tokens.revokeAccess(f.token);
    } catch (err) {
      // The answer still says nothing about the token.
      log.error(`revoking a token failed: ${err && err.message}`);
    }
    sendJson(res, 200, {});
  }

  return { token, revoke };
}

module.exports = { TokenStore, createTokenHandlers, pkceMatches };
