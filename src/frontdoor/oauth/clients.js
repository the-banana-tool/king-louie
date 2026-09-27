// Registered OAuth clients (fleet stage 4 §3.4). Every client is public (no
// secret; PKCE binds the code). Dynamic registration (RFC 7591) is rate
// limited and pruned; client ID metadata documents are fetched and cached.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { DCR_CLIENT_ID_RE, isClientId } = require('../protocol/messages');
const { OAuthError } = require('./errors');
const { fetchClientMetadata, sanitizeClientName, ipv6Groups, CLIENT_NAME_MAX, MAX_REDIRECT_URIS } = require('./cimd');

const log = createLogger('frontdoor/oauth/clients');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const LIMITS = Object.freeze({
  perIpPerHour: 10,
  withoutGrant: 100,
  purgeAfterMs: DAY,
  cimdCacheMs: DAY,
  // Not in the spec; bounds on what an unauthenticated caller can make the
  // front door hold: every stored client (granted ones too), and the CIMD cache.
  maxClients: 1000,
  cimdCacheMax: 500,
  cimdInflightMax: 16,
  // A failed fetch is answered from memory for a minute, so retrying one
  // URL does not become a fetch storm against it.
  cimdFailureMs: 60000
});
const REDIRECT_URI_MAX = 2048;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function validRedirectUri(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > REDIRECT_URI_MAX || uri.includes('#')) return false;
  // The URL parser drops tabs and newlines and trims spaces; the stored,
  // exact-matched string must not carry what the parser silently removed.
  if (/[\p{Cc}\s]/u.test(uri)) return false;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // Canonical form only, so the stored string is the one every parser reads
  // the same way; no userinfo, which would hide the real host.
  if (u.hash || u.username || u.password || u.href !== uri) return false;
  if (u.protocol === 'https:') return Boolean(u.hostname);
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname); // RFC 8252 §7.3
}

// What the consent page and the phone call "client host": the CIMD URL's
// host, or the redirect's host for a dynamically registered client.
function clientHost(client, redirectUri) {
  try {
    return client.kind === 'cimd' ? new URL(client.client_id).host : new URL(redirectUri).host;
  } catch {
    return '';
  }
}

// The per-IP bucket: an IPv6 caller usually holds a whole /64, so it counts
// as one; a v4-mapped address counts as its IPv4.
function rateKey(ip) {
  const s = String(ip);
  if (net.isIP(s) !== 6) return s;
  const g = ipv6Groups(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

const invalid = (why) => new OAuthError('invalid_client_metadata', why);
const busy = (why) => new OAuthError('temporarily_unavailable', why, 429);

class ClientRegistry {
  constructor({ file, now = Date.now, fetchMetadata = fetchClientMetadata, fetchOptions = {} } = {}) {
    this.file = file;
    this.now = now;
    this.fetchMetadata = fetchMetadata;
    this.fetchOptions = fetchOptions;
    this.clients = new Map();
    this.cimd = new Map(); // client_id → { client, at }, oldest first
    this.inflight = new Map(); // client_id → Promise<client>
    this.cimdFailed = new Map(); // client_id → { err, at }, oldest first
    this.byIp = new Map(); // rate key → [registration times]
    this._load();
  }

  // A file that cannot be loaded is moved aside, never overwritten: the next
  // save would otherwise erase every granted client in it.
  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this._quarantine(`cannot be read (${err.code || err.message})`);
      return;
    }
    let clients;
    try {
      clients = JSON.parse(raw).clients;
    } catch {
      clients = undefined;
    }
    if (!Array.isArray(clients)) {
      this._quarantine('is not a valid client list');
      return;
    }
    for (const c of clients) {
      if (c && typeof c === 'object' && DCR_CLIENT_ID_RE.test(c.client_id)) this.clients.set(c.client_id, c);
    }
  }

  _quarantine(why) {
    const aside = `${this.file}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.file, aside);
    } catch (err) {
      throw new Error(`${this.file} ${why} and cannot be moved aside (${err.code || err.message}); refusing to start with no registered clients`);
    }
    log.error(`${this.file} ${why}; moved it to ${aside} and starting with no registered clients`);
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, clients: [...this.clients.values()] }, null, 2)}\n`);
  }

  list() {
    return [...this.clients.values()];
  }

  get(clientId) {
    if (this.clients.has(clientId)) return this.clients.get(clientId);
    const cached = this.cimd.get(clientId);
    return cached && this.now() - cached.at < LIMITS.cimdCacheMs ? cached.client : null;
  }

  _recentHits(key, t) {
    for (const [k, times] of this.byIp) {
      if (times.every((at) => t - at >= HOUR)) this.byIp.delete(k);
    }
    return (this.byIp.get(key) || []).filter((at) => t - at < HOUR);
  }

  register(body, { ip = 'unknown' } = {}) {
    const t = this.now();
    const key = rateKey(ip);
    const hits = this._recentHits(key, t);
    if (hits.length >= LIMITS.perIpPerHour) throw busy('too many registrations from this address; try again later');
    // Unapproved clients older than 24 h go before the cap is judged, so a
    // burst of registrations never locks registration out for good.
    this.purge();
    if (this.list().filter((c) => !c.has_grant).length >= LIMITS.withoutGrant) throw busy('too many clients are waiting for approval; try again later');
    if (this.clients.size >= LIMITS.maxClients) throw busy('too many registered clients; try again later');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('the registration must be a JSON object');
    // Control characters are dropped before storing; escaping is the consent page's job.
    const name = typeof body.client_name === 'string' ? Array.from(body.client_name.replace(/\p{Cc}/gu, '').trim()) : [];
    if (name.length === 0 || name.length > CLIENT_NAME_MAX) throw invalid(`client_name must be 1–${CLIENT_NAME_MAX} characters`);
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
      throw invalid(`redirect_uris must list 1–${MAX_REDIRECT_URIS} https (or loopback http) URLs, each in canonical URL form (percent-encoded as the URL parser prints it, with no userinfo or fragment)`);
    }
    const grantTypes = body.grant_types === undefined ? ['authorization_code'] : body.grant_types;
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
      throw invalid('grant_types must be authorization_code and optionally refresh_token');
    }
    const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') throw invalid('response_types must be [code]');
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      throw invalid('token_endpoint_auth_method must be none: every client here is public');
    }
    // Only the accepted fields are stored, so a record is bounded by them.
    const client = {
      client_id: `dcr_${crypto.randomBytes(16).toString('base64url')}`,
      client_name: name.join(''),
      redirect_uris: [...uris],
      grant_types: [...new Set(grantTypes)],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(t / 1000),
      kind: 'dcr',
      created_at: new Date(t).toISOString(),
      has_grant: false
    };
    hits.push(t);
    this.byIp.set(key, hits);
    this.clients.set(client.client_id, client);
    this._save();
    log.info(`registered client ${client.client_id}`);
    return client;
  }

  async resolve(clientId) {
    if (!isClientId(clientId)) return null;
    if (DCR_CLIENT_ID_RE.test(clientId)) return this.clients.get(clientId) || null;
    const cached = this.cimd.get(clientId);
    if (cached && this.now() - cached.at < LIMITS.cimdCacheMs) return cached.client;
    // Concurrent resolves of one URL share a single fetch.
    if (this.inflight.has(clientId)) return this.inflight.get(clientId);
    const failed = this._recentFailure(clientId);
    if (failed) throw failed;
    if (this.inflight.size >= LIMITS.cimdInflightMax) throw busy('too many client metadata documents are being fetched; try again later');
    const pending = this._fetchCimd(clientId).catch((err) => {
      this.cimdFailed.delete(clientId);
      this.cimdFailed.set(clientId, { err, at: this.now() });
      while (this.cimdFailed.size > LIMITS.cimdCacheMax) this.cimdFailed.delete(this.cimdFailed.keys().next().value);
      throw err;
    }).finally(() => this.inflight.delete(clientId));
    this.inflight.set(clientId, pending);
    return pending;
  }

  _recentFailure(clientId) {
    const f = this.cimdFailed.get(clientId);
    if (!f) return null;
    if (this.now() - f.at < LIMITS.cimdFailureMs) return f.err;
    this.cimdFailed.delete(clientId);
    return null;
  }

  // Whether resolve(clientId) would fetch a metadata document now (a CIMD
  // URL that is neither cached, nor being fetched, nor a recent failure), so
  // the caller can charge the fetch to the asking address first.
  needsFetch(clientId) {
    if (!isClientId(clientId) || DCR_CLIENT_ID_RE.test(clientId)) return false;
    const cached = this.cimd.get(clientId);
    if (cached && this.now() - cached.at < LIMITS.cimdCacheMs) return false;
    return !this.inflight.has(clientId) && !this._recentFailure(clientId);
  }

  async _fetchCimd(clientId) {
    const doc = await this.fetchMetadata(clientId, this.fetchOptions);
    const at = this.now();
    const client = {
      client_id: doc.client_id,
      client_name: sanitizeClientName(doc.client_name) || new URL(clientId).hostname,
      redirect_uris: doc.redirect_uris.filter(validRedirectUri).slice(0, MAX_REDIRECT_URIS),
      kind: 'cimd',
      created_at: new Date(at).toISOString(),
      has_grant: false
    };
    this.cimd.delete(clientId);
    this.cimd.set(clientId, { client, at });
    while (this.cimd.size > LIMITS.cimdCacheMax) this.cimd.delete(this.cimd.keys().next().value);
    return client;
  }

  redirectAllowed(client, uri) {
    return Boolean(client) && validRedirectUri(uri) && client.redirect_uris.includes(uri);
  }

  markGranted(clientId) {
    const c = this.clients.get(clientId);
    if (c && !c.has_grant) {
      c.has_grant = true;
      this._save();
    }
  }

  purge() {
    const t = this.now();
    let removed = 0;
    for (const [id, c] of this.clients) {
      if (!c.has_grant && t - Date.parse(c.created_at) > LIMITS.purgeAfterMs) {
        this.clients.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  // Hourly purge (the front door's profile starts it and stops it). Returns
  // the stop function, with the timer handle on it for tests.
  startPurgeTimer({ everyMs = HOUR, setInterval: every = setInterval, clearInterval: clear = clearInterval } = {}) {
    const handle = every(() => {
      try {
        const removed = this.purge();
        if (removed) log.info(`purged ${removed} unapproved clients`);
      } catch (err) {
        log.warn(`client purge failed: ${err.message}`);
      }
    }, everyMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    const stop = () => clear(handle);
    stop.handle = handle;
    return stop;
  }
}

module.exports = { ClientRegistry, validRedirectUri, clientHost, rateKey, LIMITS };
