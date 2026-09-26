// Client ID metadata documents (fleet stage 4 §3.4): the client_id is an
// https URL whose JSON describes the client. The front door fetches it the
// narrowest way it can — https on 443, no redirects, 5 s, 64 KiB, JSON, and
// only to a public address it resolved itself and then connects to — so a
// client_id cannot make it reach into a private network (SSRF).
//
// The name is resolved exactly once; every address it resolves to must be
// public; the TLS socket is opened to the first of them by IP (its own
// lookup refuses to run), with the name as SNI and Host, and handed to the
// request through createConnection, so no agent, pool or proxy setting
// (HTTP(S)_PROXY, NODE_USE_ENV_PROXY) is ever in the path.
const dns = require('dns');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { createLogger } = require('../../logging');
const { isClientId } = require('../protocol/messages');
const { OAuthError } = require('./errors');

const log = createLogger('frontdoor/oauth/cimd');

const DEFAULTS = Object.freeze({ timeoutMs: 5000, maxBytes: 65536 });
const CLIENT_NAME_MAX = 200; // code points, as client-grant-v1 carries it
const MAX_REDIRECT_URIS = 10; // the same bound dynamic registration has
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Addresses ───────────────────────────────────────────────────────────────

function v4Parts(ip) {
  return ip.split('.').map(Number);
}

// Public unless in an IANA special-purpose block that is not globally
// reachable. The documentation ranges (192.0.2/24, 198.51.100/24,
// 203.0.113/24) stay "public": they are never routed, and the tests use them.
function isPublicV4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local (and cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments 192.0.0/24
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast (deprecated)
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  return a < 224; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
}

// Eight 16-bit groups, or null. The input has already passed net.isIP() === 6.
function v6Groups(ip) {
  if (ip.includes('%')) return null; // a zone id only means something on a link
  let head = ip.toLowerCase();
  const tail = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(head);
  if (dotted) {
    const [a, b, c, d] = v4Parts(dotted[1]);
    tail.push((a << 8) | b, (c << 8) | d);
    head = head.slice(0, -dotted[1].length);
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - tail.length - left.length - right.length;
  if (halves.length > 2 || zeros < 0 || (halves.length === 1 && zeros !== 0)) return null;
  return [...left, ...Array(zeros).fill('0'), ...right].map((h) => parseInt(h, 16)).concat(tail);
}

const embeddedV4 = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function isPublicV6(g) {
  const zeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  // ::/96 IPv4-compatible (and :: and ::1), ::ffff:0:0/96 IPv4-mapped,
  // ::ffff:0:0:0/96 IPv4-translated: judged by the IPv4 they carry.
  if (zeroUpTo(6)) return isPublicV4(embeddedV4(g[6], g[7]));
  if (zeroUpTo(5) && g[5] === 0xffff) return isPublicV4(embeddedV4(g[6], g[7]));
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return isPublicV4(embeddedV4(g[6], g[7]));
  // 64:ff9b::/96 well-known NAT64 prefix: the gateway connects to the IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(embeddedV4(g[6], g[7]));
  // 2002::/16 6to4: the IPv4 is in groups 1–2.
  if (g[0] === 0x2002) return isPublicV4(embeddedV4(g[1], g[2]));
  // 2001::/23 IETF protocol assignments, which holds Teredo 2001::/32 (its
  // client IPv4 is obfuscated and its relay path uncontrolled): refused whole.
  if (g[0] === 0x2001 && g[1] < 0x200) return false;
  // Only 2000::/3 is global unicast. Everything else — ULA fc00::/7,
  // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8,
  // discard 100::/64, local-use NAT64 64:ff9b:1::/48 — is not public.
  return (g[0] & 0xe000) === 0x2000;
}

function isPublicAddress(ip) {
  if (typeof ip !== 'string') return false;
  const kind = net.isIP(ip);
  if (kind === 4) return isPublicV4(v4Parts(ip));
  if (kind !== 6) return false;
  const groups = v6Groups(ip);
  return groups !== null && isPublicV6(groups);
}

// ── Fetch ───────────────────────────────────────────────────────────────────

function refuse(message) {
  return new OAuthError('invalid_client', `client metadata: ${message}`);
}

const kib = (bytes) => (bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`);

// The name a consent page and the phone show: control characters removed,
// trimmed, at most 200 code points. Escaping for display is the page's job.
function sanitizeClientName(name) {
  if (typeof name !== 'string') return '';
  return Array.from(name.replace(/\p{Cc}/gu, '').trim()).slice(0, CLIENT_NAME_MAX).join('').trim();
}

// The client_id must already be in the form the URL parser would print, so
// the string the front door compares, shows and fetches is one string: no
// case folding, default port, dot segments, backslashes or escapes that one
// parser reads one way and another reads another.
function checkUrl(url) {
  if (typeof url !== 'string' || !isClientId(url) || url.startsWith('dcr_')) throw refuse('client_id is not an https URL');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw refuse('client_id is not a URL');
  }
  if (u.protocol !== 'https:') throw refuse('client_id must be an https URL');
  if (u.port && u.port !== '443') throw refuse('client_id must use port 443');
  if (u.username || u.password) throw refuse('client_id must not carry credentials');
  if (u.hash || url.includes('#')) throw refuse('client_id must not have a fragment');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw refuse('client_id must name a host, not an address');
  if (u.hostname.endsWith('.')) throw refuse('client_id must not end its host with a dot');
  if (u.href !== url) throw refuse('client_id must be a URL in canonical form');
  return u;
}

function resolvePublic(hostname, lookup) {
  return new Promise((resolve, reject) => {
    const done = (err, addresses) => {
      if (err) return reject(refuse(`cannot resolve ${hostname}: ${err.code || 'lookup failed'}`));
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map((a) => a && a.address);
      if (list.length === 0) return reject(refuse(`${hostname} has no address`));
      const bad = list.findIndex((a) => !isPublicAddress(a));
      if (bad !== -1) {
        log.debug('client metadata host resolves to a non-public address', { hostname, address: String(list[bad]) });
        return reject(refuse(`${hostname} resolves to an address that is not public`));
      }
      return resolve(list[0]);
    };
    try {
      lookup(hostname, { all: true }, done);
    } catch (err) {
      done(err);
    }
  });
}

function parseDocument(text) {
  try {
    return JSON.parse(text, (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) throw refuse(`the metadata has a forbidden key (${key})`);
      return value;
    });
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    throw refuse('the metadata is not JSON');
  }
}

const noSecondLookup = () => {
  throw new Error('no second lookup: the metadata host was resolved once already');
};

function fetchClientMetadata(url, { lookup = dns.lookup, timeoutMs = DEFAULTS.timeoutMs, maxBytes = DEFAULTS.maxBytes, ca = null, connectPort = 443, connectTo = null } = {}) {
  let u;
  try {
    u = checkUrl(url);
  } catch (err) {
    return Promise.reject(err);
  }
  // `connectPort`, `connectTo` and `ca` exist for tests only: the front door
  // never passes them, so it always dials the resolved address on 443 and
  // verifies against the system roots.
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let req = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (req) req.destroy();
      if (socket) socket.destroy();
      if (err) reject(err instanceof OAuthError ? err : refuse(err.code || err.message));
      else resolve(value);
    };
    // One deadline for the lookup, the TCP connect, the TLS handshake and
    // every byte of the body: a server cannot keep it alive by trickling.
    const deadline = setTimeout(() => finish(refuse(`fetching the metadata timed out after ${timeoutMs} ms`)), timeoutMs);

    resolvePublic(u.hostname, lookup).then((address) => {
      if (settled) return;
      socket = tls.connect({
        host: connectTo || address,
        port: connectPort,
        servername: u.hostname,
        ALPNProtocols: ['http/1.1'],
        lookup: noSecondLookup,
        ...(ca ? { ca } : {})
      });
      socket.on('error', finish);
      req = https.request({
        createConnection: () => socket,
        method: 'GET',
        path: `${u.pathname}${u.search}`,
        headers: { host: u.hostname, accept: 'application/json', 'accept-encoding': 'identity' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) return finish(refuse('the metadata URL answered with a redirect; redirects are not followed'));
        if (res.statusCode !== 200) return finish(refuse(`the metadata URL answered ${res.statusCode}`));
        if (!/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(String(res.headers['content-type'] || ''))) return finish(refuse('the metadata is not JSON'));
        const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
        if (encoding !== 'identity') return finish(refuse('the metadata is encoded; only identity is accepted'));
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) return finish(refuse(`the metadata is over ${kib(maxBytes)}`));
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return finish(refuse(`the metadata is over ${kib(maxBytes)}`));
          return chunks.push(chunk);
        });
        res.on('error', finish);
        res.on('aborted', () => finish(refuse('the metadata connection closed early')));
        res.on('end', () => {
          if (settled) return;
          if (!res.complete) return finish(refuse('the metadata connection closed early'));
          let text;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          } catch {
            return finish(refuse('the metadata is not UTF-8'));
          }
          try {
            return finish(null, parseDocument(text));
          } catch (err) {
            return finish(err);
          }
        });
        return undefined;
      });
      req.on('error', finish);
      req.end();
    }).catch(finish); // a lookup refusal, or anything thrown while connecting
  }).then((doc) => checkDocument(doc, url, u));
}

function checkDocument(doc, url, u) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse('the metadata is not a JSON object');
  if (doc.client_id !== url) throw refuse('its client_id is not the URL it was fetched from');
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length > MAX_REDIRECT_URIS || !uris.every((r) => typeof r === 'string')) {
    throw refuse(`redirect_uris must be a list of at most ${MAX_REDIRECT_URIS} URLs`);
  }
  const name = sanitizeClientName(doc.client_name) || u.hostname;
  return { client_id: doc.client_id, client_name: name, redirect_uris: [...uris] };
}

module.exports = { fetchClientMetadata, isPublicAddress, sanitizeClientName, ipv6Groups: v6Groups, DEFAULTS, CLIENT_NAME_MAX, MAX_REDIRECT_URIS };
