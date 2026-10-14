'use strict';

/**
 * Address classes for local servers, and resolve-and-pin
 * (spec 2026-10-13-local-inference-design.md §5.2, §5.3; R-LI-5, R-LI-29,
 * R-LI-30).
 *
 * A server counts as local only at a loopback or private LAN address (and at
 * 100.64.0.0/10 only with the entry's own opt-in). The address is resolved
 * once and stored; `local-transport.js` dials only what is stored here.
 * Everything in this file fails closed: what cannot be parsed or decided is
 * not local.
 */

const net = require('node:net');
const dns = require('node:dns');

const ADDRESS_CLASSES = Object.freeze(['loopback', 'lan', 'cgnat', 'link-local', 'unspecified', 'public']);

/** Classes an entry may be pinned at, narrowest first (the "widest" order). */
const ALLOWED_ORDER = Object.freeze(['loopback', 'lan', 'cgnat']);

class LocalAddressError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'LocalAddressError';
    this.code = code;
    if (details.addresses) this.addresses = details.addresses;
    if (details.refused) this.refused = details.refused;
  }
}

function blockList(v4, v6) {
  const list = new net.BlockList();
  for (const [address, prefix] of v4) list.addSubnet(address, prefix, 'ipv4');
  for (const [address, prefix] of v6) list.addSubnet(address, prefix, 'ipv6');
  return list;
}

// First match wins, in this order. Anything none of them holds is public:
// NAT64 (64:ff9b::/96), 6to4 (2002::/16), IPv4-compatible (::a.b.c.d), the
// documentation ranges, multicast and broadcast included.
const RANGES = Object.freeze([
  ['unspecified', blockList([['0.0.0.0', 32]], [['::', 128]])],
  ['loopback', blockList([['127.0.0.0', 8]], [['::1', 128]])],
  ['lan', blockList([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]], [['fc00::', 7]])],
  ['cgnat', blockList([['100.64.0.0', 10]], [])],
  ['link-local', blockList([['169.254.0.0', 16]], [['fe80::', 10]])],
]);

/** The 16 bytes of an IPv6 literal `net.isIP` accepted (no zone id). */
function ipv6Bytes(text) {
  const halves = text.split('::');
  const groups = (part) => {
    if (part === '') return [];
    const out = [];
    const pieces = part.split(':');
    pieces.forEach((piece, i) => {
      if (piece.includes('.')) {
        if (i !== pieces.length - 1) throw new TypeError('not an IP address');
        const o = piece.split('.').map(Number);
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else {
        out.push(parseInt(piece, 16));
      }
    });
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length > 1 ? groups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length > 2 || fill < 0 || (halves.length === 1 && fill !== 0)) throw new TypeError('not an IP address');
  const words = [...head, ...new Array(fill).fill(0), ...tail];
  const bytes = [];
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) throw new TypeError('not an IP address');
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

function ipv6Text(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  // RFC 5952: the longest run of two or more zero words becomes "::".
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && words[j] === 0) j += 1;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best.length < 2) return hex.join(':');
  return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.length).join(':')}`;
}

/**
 * Parse one IP literal into bytes. The classifier works from these, never
 * from the string, so every spelling of an address gets the same answer.
 * @returns {{ family: 4|6, bytes: number[], zone: string|null, text: string }}
 */
function parseAddress(ip) {
  if (typeof ip !== 'string') throw new TypeError('not an IP address');
  const family = net.isIP(ip);
  if (family === 4) {
    return { family: 4, bytes: ip.split('.').map(Number), zone: null, text: ip };
  }
  if (family !== 6) throw new TypeError('not an IP address');
  const at = ip.indexOf('%');
  const zone = at === -1 ? null : ip.slice(at + 1);
  if (zone === '') throw new TypeError('not an IP address');
  const bytes = ipv6Bytes(at === -1 ? ip : ip.slice(0, at));
  // IPv4-mapped (::ffff:a.b.c.d): the address is the IPv4 one (§5.2 rule 1).
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped && zone === null) {
    const v4 = bytes.slice(12);
    return { family: 4, bytes: v4, zone: null, text: v4.join('.') };
  }
  return { family: 6, bytes, zone, text: ipv6Text(bytes) };
}

/**
 * One spelling per address: an IPv4-mapped address as its IPv4 address,
 * IPv6 lower case and compressed. A zone id is kept (such an address is
 * never allowed, so it is only ever shown).
 */
function canonicalAddress(ip) {
  const parsed = parseAddress(ip);
  return parsed.zone === null ? parsed.text : `${parsed.text}%${parsed.zone}`;
}

/**
 * @param {string} ip - one IP literal (`net.isIP` must accept it)
 * @returns {'loopback'|'lan'|'cgnat'|'link-local'|'unspecified'|'public'}
 * @throws {TypeError} for anything else
 */
function classifyAddress(ip) {
  const parsed = parseAddress(ip);
  const family = parsed.family === 4 ? 'ipv4' : 'ipv6';
  let found = 'public';
  for (const [name, list] of RANGES) {
    if (list.check(parsed.text, family)) { found = name; break; }
  }
  // A zone id belongs to a link-local address only. On anything else it is
  // a spelling this file cannot vouch for, so it is not local.
  if (parsed.zone !== null && found !== 'link-local') return 'public';
  return found;
}

function invalidUrl(message) {
  return new LocalAddressError('LOCAL_URL_INVALID', message);
}

/**
 * Read a local server's base URL (§5.2 rule 9).
 * @returns {{ href: string, protocol: 'http:'|'https:', hostname: string, port: number, isIpLiteral: boolean }}
 * @throws {LocalAddressError} LOCAL_URL_INVALID
 */
function parseBaseUrl(raw) {
  if (typeof raw !== 'string' || raw === '') throw invalidUrl('A local server address must be an http or https URL.');
  // The URL parser drops tabs and newlines, turns "\" into "/", decodes "%"
  // in a host and folds dot segments. None has a use here, and each makes
  // the URL that is read differ from the one that was written.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\%]/.test(raw)) throw invalidUrl('A local server address cannot contain spaces, control characters, "\\" or "%".');
  if (raw.includes('?') || raw.includes('#')) throw invalidUrl('A local server address cannot have a query or a fragment.');
  if (/\/\.{1,2}(\/|$)/.test(raw)) throw invalidUrl('A local server address cannot contain "." or ".." path segments.');
  if (!/^https?:\/\/[^/]/i.test(raw)) throw invalidUrl('A local server address must start with http:// or https://.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidUrl('A local server address must be an http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidUrl('A local server address must be an http or https URL.');
  if (url.username !== '' || url.password !== '' || raw.includes('@')) throw invalidUrl('A local server address cannot carry a user name or a password.');
  if (url.search !== '' || url.hash !== '') throw invalidUrl('A local server address cannot have a query or a fragment.');
  let hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (hostname === '') throw invalidUrl('A local server address needs a host.');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidUrl('A local server port must be from 1 to 65535.');
  const href = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return { href, protocol: url.protocol, hostname, port, isIpLiteral: net.isIP(hostname) !== 0 };
}

function allowedClass(cls, allowCgnat) {
  return cls === 'loopback' || cls === 'lan' || (cls === 'cgnat' && allowCgnat === true);
}

/**
 * Classify a list of addresses for pinning.
 * @returns {{ addresses: string[], refused: { address: string, class: string }[], class: string|null }}
 */
function classifyAll(list, allowCgnat) {
  const addresses = [];
  const refused = [];
  let widest = -1;
  for (const entry of list) {
    let address;
    let cls;
    try {
      address = canonicalAddress(entry);
      cls = classifyAddress(entry);
    } catch {
      // Not an address at all: shown as it came, never allowed.
      address = typeof entry === 'string' ? entry : String(entry);
      cls = 'invalid';
    }
    if (addresses.includes(address)) continue;
    addresses.push(address);
    if (allowedClass(cls, allowCgnat)) widest = Math.max(widest, ALLOWED_ORDER.indexOf(cls));
    else refused.push({ address, class: cls });
  }
  return { addresses, refused, class: widest === -1 ? null : ALLOWED_ORDER[widest] };
}

function refusedError(addresses, refused) {
  const named = refused.map((r) => `${r.address} (${r.class})`).join(', ');
  return new LocalAddressError(
    'LOCAL_ADDRESS_PUBLIC',
    `A local server must be on this machine or your own network; not allowed: ${named}.`,
    { addresses, refused }
  );
}

/**
 * Resolve a base URL once and return the addresses to pin (§5.2 rule 3).
 * An IP literal is its own answer. Every address a name answers with must be
 * allowed, or the whole entry is refused.
 *
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {Function} [options.lookup] - `dns.promises.lookup`
 * @param {boolean} [options.allowCgnat] - only `true` allows 100.64.0.0/10 (R-LI-29)
 * @param {Function} [options.now]
 * @returns {Promise<{ addresses: string[], class: 'loopback'|'lan'|'cgnat', at: string }>}
 * @throws {LocalAddressError} LOCAL_URL_INVALID, LOCAL_ADDRESS_PUBLIC, LOCAL_ADDRESS_UNRESOLVED
 */
async function resolveAndPin(baseUrl, { lookup = dns.promises.lookup, allowCgnat = false, now = () => new Date() } = {}) {
  const parsed = parseBaseUrl(baseUrl);
  let answers;
  if (parsed.isIpLiteral) {
    answers = [parsed.hostname];
  } else {
    let found;
    try {
      found = await lookup(parsed.hostname, { all: true });
    } catch (cause) {
      throw new LocalAddressError('LOCAL_ADDRESS_UNRESOLVED', `${parsed.hostname} did not resolve to an address.`, { cause });
    }
    if (found && !Array.isArray(found) && typeof found === 'object' && typeof found.address === 'string') found = [found];
    if (!Array.isArray(found) || found.length === 0) {
      throw new LocalAddressError('LOCAL_ADDRESS_UNRESOLVED', `${parsed.hostname} did not resolve to an address.`);
    }
    answers = found.map((entry) => (entry && typeof entry === 'object' ? entry.address : entry));
  }
  const result = classifyAll(answers, allowCgnat);
  if (result.refused.length > 0 || result.class === null) throw refusedError(result.addresses, result.refused);
  return { addresses: result.addresses, class: result.class, at: now().toISOString() };
}

/**
 * Re-classify a stored pin (at start-up). The stored `class` must be the one
 * the stored addresses give: a pin that says `loopback` over a LAN address
 * is not trusted.
 * @returns {true|LocalAddressError} never throws
 */
function checkPinned(pinned, { allowCgnat = false } = {}) {
  if (!pinned || typeof pinned !== 'object' || !Array.isArray(pinned.addresses) || pinned.addresses.length === 0) {
    return new LocalAddressError('LOCAL_PIN_INVALID', 'This local server has no checked address. Check it again.');
  }
  const result = classifyAll(pinned.addresses, allowCgnat);
  if (result.refused.length > 0 || result.class === null) return refusedError(result.addresses, result.refused);
  if (pinned.class !== result.class) {
    return new LocalAddressError('LOCAL_PIN_INVALID', 'This local server\'s stored address class does not match its addresses. Check it again.', { addresses: result.addresses });
  }
  return true;
}

/**
 * Whether a private chat or a local-only role may use a server (§5.3,
 * R-LI-30). Loopback always; anything else only over https with a pinned
 * certificate. The class is recomputed from `pinned.addresses`; a pin that
 * does not check out is `cost-only`.
 * @returns {'guarantee'|'cost-only'}
 */
function gradeOf({ pinned, protocol, tlsFingerprint } = {}) {
  if (protocol !== 'http:' && protocol !== 'https:') return 'cost-only';
  if (checkPinned(pinned, { allowCgnat: true }) !== true) return 'cost-only';
  if (pinned.class === 'loopback') return 'guarantee';
  if (protocol === 'https:' && isTlsFingerprint(tlsFingerprint)) return 'guarantee';
  return 'cost-only';
}

/** A SHA-256 certificate fingerprint: 64 hex characters, no colons. */
function isTlsFingerprint(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

module.exports = {
  ADDRESS_CLASSES,
  LocalAddressError,
  classifyAddress,
  canonicalAddress,
  parseBaseUrl,
  resolveAndPin,
  checkPinned,
  gradeOf,
  isTlsFingerprint,
};
