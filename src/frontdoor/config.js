// node.yaml `frontdoor:` (fleet stage 4 §6). Only key names, types and ranges
// are checked here; the domain and TLS-source refusals are startup checks
// #2 and #3 (§3.1), run in order by startFrontDoor, so they are left as
// written. Loaded by node-config.js on every profile, so it requires nothing
// heavier than the config helpers.
const { unknownKeyError } = require('../service/config');
const { parseDuration } = require('../platform/duration');
const { isDnsName, SCOPE_RE } = require('./protocol/messages');

const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const FLEET_SCOPES = Object.freeze(['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
const FRONTDOOR_KEYS = Object.freeze({
  top: Object.freeze(['domain', 'listen', 'acme', 'tls', 'oauth', 'mcp', 'audit']),
  listen: Object.freeze(['host', 'port']),
  acme: Object.freeze(['email', 'directory', 'terms_agreed']),
  tls: Object.freeze(['cert_file', 'key_file']),
  oauth: Object.freeze(['access_token_ttl', 'refresh_token_idle_ttl', 'scopes_enabled', 'client_defaults']),
  clientDefault: Object.freeze(['match', 'scopes']),
  match: Object.freeze(['host']),
  mcp: Object.freeze(['progress_hold_s']),
  audit: Object.freeze(['retention_days'])
});
const MIN = 60000;
const DAY = 86400000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseFrontDoorConfig(raw, file) {
  const invalid = (what) => new Error(`Invalid ${file}: ${what}`);
  const known = (obj, keys, where) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) throw unknownKeyError(file, `${where}.${k}`, keys);
  };
  const block = (value, where, keys) => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) throw invalid(`${where} must be a mapping`);
    known(value, keys, where);
    return value;
  };
  const top = block(raw, 'frontdoor', FRONTDOOR_KEYS.top);

  const listen = block(top.listen, 'frontdoor.listen', FRONTDOOR_KEYS.listen);
  const host = listen.host === undefined ? '0.0.0.0' : listen.host;
  const port = listen.port === undefined ? 443 : listen.port;
  if (typeof host !== 'string' || !host.trim()) throw invalid('frontdoor.listen.host must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('frontdoor.listen.port must be an integer from 1 to 65535');

  let acme = null;
  if (top.acme !== undefined) {
    const a = block(top.acme, 'frontdoor.acme', FRONTDOOR_KEYS.acme);
    const directory = a.directory === undefined ? LETS_ENCRYPT_PRODUCTION : a.directory;
    let https = false;
    try { https = new URL(directory).protocol === 'https:'; } catch { https = false; }
    if (!https) throw invalid('frontdoor.acme.directory must be an https:// URL');
    if (a.email !== undefined && a.email !== null && (typeof a.email !== 'string' || !a.email.includes('@'))) throw invalid('frontdoor.acme.email must be an email address');
    if (a.terms_agreed !== undefined && typeof a.terms_agreed !== 'boolean') throw invalid('frontdoor.acme.terms_agreed must be true or false');
    acme = { email: a.email || null, directory, termsAgreed: a.terms_agreed === true };
  }

  let tls = null;
  if (top.tls !== undefined) {
    const t = block(top.tls, 'frontdoor.tls', FRONTDOOR_KEYS.tls);
    for (const k of ['cert_file', 'key_file']) {
      if (typeof t[k] !== 'string' || !t[k].trim()) throw invalid(`frontdoor.tls.${k} is required`);
    }
    tls = { certFile: t.cert_file.trim(), keyFile: t.key_file.trim() };
  }

  const o = block(top.oauth, 'frontdoor.oauth', FRONTDOOR_KEYS.oauth);
  const duration = (value, fallback, min, max, what) => {
    const ms = parseDuration(value === undefined ? fallback : value);
    if (ms === null || ms < min || ms > max) throw invalid(what);
    return ms;
  };
  const accessTokenTtlMs = duration(o.access_token_ttl, '1h', 5 * MIN, DAY, 'frontdoor.oauth.access_token_ttl must be a duration from 5m to 24h');
  const refreshIdleTtlMs = duration(o.refresh_token_idle_ttl, '30d', DAY, 365 * DAY, 'frontdoor.oauth.refresh_token_idle_ttl must be a duration from 1d to 365d');
  const scopesEnabled = o.scopes_enabled === undefined ? [...FLEET_SCOPES] : o.scopes_enabled;
  if (!Array.isArray(scopesEnabled) || !scopesEnabled.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
    throw invalid('frontdoor.oauth.scopes_enabled must be a list of scope names');
  }
  const rawDefaults = o.client_defaults === undefined ? [] : o.client_defaults;
  if (!Array.isArray(rawDefaults)) throw invalid('frontdoor.oauth.client_defaults must be a list');
  const clientDefaults = rawDefaults.map((d, i) => {
    const where = `frontdoor.oauth.client_defaults[${i}]`;
    const entry = block(d, where, FRONTDOOR_KEYS.clientDefault);
    const match = block(entry.match, `${where}.match`, FRONTDOOR_KEYS.match);
    if (!isDnsName(match.host)) throw invalid(`${where}.match.host must be a DNS name`);
    if (!Array.isArray(entry.scopes) || !entry.scopes.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
      throw invalid(`${where}.scopes must be a list of scope names`);
    }
    return { host: match.host, scopes: [...new Set(entry.scopes)].sort() };
  });

  const mcp = block(top.mcp, 'frontdoor.mcp', FRONTDOOR_KEYS.mcp);
  const progressHoldS = mcp.progress_hold_s === undefined ? 20 : mcp.progress_hold_s;
  if (!Number.isInteger(progressHoldS) || progressHoldS < 0 || progressHoldS > 55) throw invalid('frontdoor.mcp.progress_hold_s must be an integer from 0 to 55');

  const audit = block(top.audit, 'frontdoor.audit', FRONTDOOR_KEYS.audit);
  const retentionDays = audit.retention_days === undefined ? null : audit.retention_days;
  if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 30)) {
    throw invalid('frontdoor.audit.retention_days must be null or an integer of at least 30');
  }

  return {
    domain: top.domain,
    listen: { host: host.trim(), port },
    acme,
    tls,
    oauth: { accessTokenTtlMs, refreshIdleTtlMs, scopesEnabled: [...scopesEnabled], clientDefaults },
    mcp: { progressHoldS },
    audit: { retentionDays }
  };
}

function frontDoorHosts(domain) {
  return { mcp: `mcp.${domain}`, mesh: `mesh.${domain}` };
}

module.exports = { parseFrontDoorConfig, frontDoorHosts, FRONTDOOR_KEYS, FLEET_SCOPES, LETS_ENCRYPT_PRODUCTION };
