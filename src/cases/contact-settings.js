// src/cases/contact-settings.js
// Settings for contact (cases stage 4 spec §6): the `contactPolicy`,
// `contact` and `channels.*` defaults and merge, the admin service.json
// `contact` block and its validation (R55), and where the owner identity
// comes from in each host.
// No src/channels import here: src/service/config.js loads this module and
// the runbook profile must not pull in channel code.
const { effectivePolicy, assertRelayBaseUrl } = require('./contact-format');
const { createLogger } = require('../logging');

const log = createLogger('contact/settings');

const CHANNEL_DEFAULTS = Object.freeze({
  telegram: { contactEnabled: false, contactOwnerUserId: '' },
  discord: { contactEnabled: false, contactOwnerUserId: '' },
  email: { enabled: false, transport: 'relay' },
  sms: { enabled: false, maxChars: 1200, language: 'en-US' },
  voice: { enabled: false, maxChars: 1200, language: 'en-US' },
  ntfy: { enabled: false, includeText: false },
  mobile: { enabled: false }
});

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Spread at the end of mergeSettings (src/core/settings.js):
// `...mergeContactSettings(source, DEFAULT_SETTINGS.channels)`.
function mergeContactSettings(source = {}, baseChannels = {}) {
  const src = obj(source);
  const channels = { ...obj(baseChannels), ...obj(src.channels) };
  for (const [id, defaults] of Object.entries(CHANNEL_DEFAULTS)) {
    channels[id] = { ...defaults, ...obj(baseChannels[id]), ...obj(obj(src.channels)[id]) };
  }
  channels.slack = { ...obj(baseChannels.slack), ...obj(obj(src.channels).slack) };
  return {
    contactPolicy: effectivePolicy(src.contactPolicy),
    contact: { ...obj(src.contact) },
    channels
  };
}

// ---- The admin service.json `contact` block ----

const SHAPE = {
  telegram: { ownerUserId: 'id' },
  discord: { ownerUserId: 'id' },
  ntfy: { baseUrl: 'url', topic: 'string' },
  email: {
    owner: 'email', from: 'email', relay: 'string',
    smtp: { host: 'string', port: 'port', secure: 'boolean', user: 'string' },
    imap: { host: 'string', port: 'port', user: 'string', trustedAuthServId: 'string', pollSec: 'seconds', secure: 'boolean' }
  },
  sms: { owner: 'phone', from: 'phone', relay: 'string' },
  voice: { owner: 'phone', from: 'phone', relay: 'string' }
};
const RELAY_SHAPE = { baseUrl: 'relayUrl', pollSec: 'seconds' };

// Credentials in the userinfo, or a query or fragment, have no place in a
// base URL: they would be logged and sent on every request.
const EXTRAS = 'must not carry a user name, password, query or fragment';
const hasExtras = (u) => Boolean(u.username || u.password || u.search || u.hash);

// `where` is the key path ("contact.sms.owner"); `file` names service.json.
function checkValue(kind, value, where, file) {
  const bad = (what) => new Error(`Invalid ${file}: ${where} ${what}`);
  switch (kind) {
    case 'id':
      if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw bad('must be a numeric user id in quotes');
      return value;
    case 'string':
      if (typeof value !== 'string') throw bad('must be text');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('must be true or false');
      return value;
    case 'port':
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw bad('must be an integer from 1 to 65535');
      return value;
    case 'seconds':
      if (!Number.isInteger(value) || value < 5 || value > 86400) throw bad('must be an integer from 5 to 86400');
      return value;
    case 'email':
      if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw bad('must be an email address');
      return value.toLowerCase();
    case 'phone': {
      const s = String(value ?? '').replace(/[\s\-.()]/g, '');
      if (!/^\+\d{8,15}$/.test(s)) throw bad('must be an E.164 number such as +15550100');
      return s;
    }
    case 'url': {
      let u;
      try {
        u = new URL(String(value));
      } catch {
        throw bad('must be a URL');
      }
      if (u.protocol !== 'https:') throw bad('must be an https: URL');
      if (hasExtras(u)) throw bad(EXTRAS);
      return String(value);
    }
    case 'relayUrl': {
      // https:, or http: only to loopback (spec §4.5; contact-format.js).
      let base;
      try {
        base = assertRelayBaseUrl(value);
      } catch (err) {
        throw bad(/is not a URL$/.test(err.message) ? 'is not a URL' : err.message.replace(/^relay baseUrl /, ''));
      }
      // assertRelayBaseUrl drops these silently; in admin config they are a mistake.
      if (hasExtras(new URL(String(value)))) throw bad(EXTRAS);
      return base;
    }
    default:
      throw bad('has an unknown type');
  }
}

function checkObject(shape, value, where, ctx, known = Object.keys(shape)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${ctx.file}: ${where} must be an object`);
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) throw ctx.unknownKeyError(ctx.file, `${where}.${key}`, known);
    out[key] = typeof shape[key] === 'object'
      ? checkObject(shape[key], v, `${where}.${key}`, ctx)
      : checkValue(shape[key], v, `${where}.${key}`, ctx.file);
  }
  return out;
}

// src/service/config.js passes its `unknownKeyError` (the one formatter for
// service.json and node.yaml, R55) in; requiring it here at load would be
// circular, so the default looks it up at call time.
const serviceUnknownKeyError = (...args) => require('../service/config').unknownKeyError(...args);

// Returns the normalized block, or null when service.json has none.
function validateContactConfig(value, file, { unknownKeyError = serviceUnknownKeyError } = {}) {
  if (value === undefined || value === null) return null;
  const ctx = { file, unknownKeyError };
  const prefix = `Invalid ${file}: contact`;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${prefix} must be an object`);
  const { relays, ...rest } = value;
  const out = checkObject(SHAPE, rest, 'contact', ctx, [...Object.keys(SHAPE), 'relays']);
  if (relays !== undefined) {
    if (!relays || typeof relays !== 'object' || Array.isArray(relays)) throw new Error(`${prefix}.relays must be an object`);
    out.relays = {};
    for (const [name, relay] of Object.entries(relays)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`${prefix}.relays.${name} is not a lowercase relay name`);
      out.relays[name] = checkObject(RELAY_SHAPE, relay, `contact.relays.${name}`, ctx);
      if (!out.relays[name].baseUrl) throw new Error(`${prefix}.relays.${name}.baseUrl is required`);
    }
  }
  for (const ch of ['email', 'sms', 'voice']) {
    const relay = out[ch]?.relay;
    if (relay && !out.relays?.[relay]) throw new Error(`${prefix}.${ch}.relay names "${relay}", which is not under contact.relays`);
  }
  return out;
}

// Who the owner is and where to reach them. Desktop: settings `contact` and
// channels.<ch>.contactOwnerUserId. Service: only the admin block; data-dir
// values are ignored with a warning (the service account can write them).
const warnedBy = new WeakMap();
function resolveContactConfig({ settings = {}, contactConfig = null, isService = false, logger = log } = {}) {
  const s = obj(settings);
  if (isService) {
    const stray = [];
    if (Object.keys(obj(s.contact)).length) stray.push('settings.contact');
    for (const ch of ['telegram', 'discord']) if (obj(obj(s.channels)[ch]).contactOwnerUserId) stray.push(`channels.${ch}.contactOwnerUserId`);
    const warned = warnedBy.get(logger) || new Set();
    warnedBy.set(logger, warned);
    for (const key of stray) {
      if (!warned.has(key)) {
        warned.add(key);
        logger.warn(`ignoring ${key} from the data dir: in service mode the owner and contact addresses come only from the admin service.json "contact" block`);
      }
    }
    return JSON.parse(JSON.stringify(obj(contactConfig)));
  }
  const out = JSON.parse(JSON.stringify(obj(s.contact)));
  for (const ch of ['telegram', 'discord']) {
    const owner = String(obj(obj(s.channels)[ch]).contactOwnerUserId || '').trim();
    if (owner) out[ch] = { ...obj(out[ch]), ownerUserId: owner };
  }
  return out;
}

// Contact channel credentials (relay tokens, webhook secrets, mailbox
// passwords) live in the vault under `contact.`. Neither the model's Vault
// tool nor an MCP `${vault:…}` reference may reach them. The desktop vault
// (electron-store) reads keys through dot-prop, which drops a backslash before
// an ordinary character and treats `[` as a path separator, so compare the
// first path segment with backslashes removed, trimmed and lowercased.
function isContactVaultKey(key) {
  const first = String(key ?? '').replace(/\\/g, '').split(/[.[]/)[0];
  return first.trim().toLowerCase() === 'contact';
}

module.exports = { CHANNEL_DEFAULTS, mergeContactSettings, validateContactConfig, resolveContactConfig, isContactVaultKey };
