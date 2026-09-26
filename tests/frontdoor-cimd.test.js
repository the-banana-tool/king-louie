// tests/frontdoor-cimd.test.js — fleet stage 4 §3.4 (client ID metadata documents).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { fetchClientMetadata, isPublicAddress } = require('../src/frontdoor/oauth/cimd');
const { OAuthError } = require('../src/frontdoor/oauth/errors');
const { createCa, issueCert } = require('./helpers/test-certs');

const ca = createCa();
const leaf = issueCert(ca, { dnsNames: ['client.example.com'] });
const servers = [];
after(() => { for (const s of servers) s.close(); });

async function docServer(handler) {
  const server = https.createServer({ cert: leaf.cert, key: leaf.key }, handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return server.address().port;
}

// Resolves client.example.com to a public documentation address, but the test
// connects to 127.0.0.1 through connectPort + a lookup that reports public.
const publicLookup = (address) => (host, opts, cb) => cb(null, [{ address, family: 4 }]);
const URL_ = 'https://client.example.com/client.json';

describe('isPublicAddress', () => {
  it('refuses every non-public range', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['203.0.113.10', '198.51.100.7', '2001:db8::1', '::ffff:203.0.113.10']) assert.equal(isPublicAddress(ip), true, ip);
  });
});

describe('fetchClientMetadata', () => {
  const options = (port, extra = {}) => ({ lookup: publicLookup('203.0.113.10'), connectTo: '127.0.0.1', connectPort: port, ca: ca.cert, ...extra });

  it('fetches, checks client_id equals the URL, and returns the document', async () => {
    const port = await docServer((req, res) => {
      assert.equal(req.headers.host, 'client.example.com');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ client_id: URL_, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] }));
    });
    const doc = await fetchClientMetadata(URL_, options(port));
    assert.deepEqual(doc, { client_id: URL_, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] });
  });

  it('refuses a name that resolves to a private address', async () => {
    await assert.rejects(fetchClientMetadata(URL_, { lookup: publicLookup('10.0.0.5') }), (err) => err instanceof OAuthError && /not public/.test(err.message));
  });

  it('refuses a redirect, an oversize body, a client_id mismatch, non-JSON, and a slow server', async () => {
    const redirect = await docServer((req, res) => { res.writeHead(302, { location: 'https://evil.example.com/x.json' }); res.end(); });
    await assert.rejects(fetchClientMetadata(URL_, options(redirect)), /redirect/);
    const big = await docServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ client_id: URL_, pad: 'x'.repeat(70000) })); });
    await assert.rejects(fetchClientMetadata(URL_, options(big)), /64 KiB/);
    const other = await docServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ client_id: 'https://other.example.com/c.json', redirect_uris: [] })); });
    await assert.rejects(fetchClientMetadata(URL_, options(other)), /client_id/);
    const html = await docServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); });
    await assert.rejects(fetchClientMetadata(URL_, options(html)), /JSON/);
    const slow = await docServer(() => {});
    await assert.rejects(fetchClientMetadata(URL_, options(slow, { timeoutMs: 100 })), /timed out/);
  });

  it('refuses http:, another port, userinfo and fragments before any network use', async () => {
    for (const bad of ['http://client.example.com/c.json', 'https://client.example.com:8443/c.json', 'https://u:p@client.example.com/c.json', 'https://client.example.com/c.json#x']) {
      await assert.rejects(fetchClientMetadata(bad, { lookup: () => { throw new Error('no lookup'); } }), OAuthError, bad);
    }
  });
});

// ── Beyond the brief: the SSRF surface held to the dispatch's rules ─────────
const net = require('net');
const tls = require('tls');

describe('isPublicAddress (special-purpose ranges)', () => {
  it('refuses every IPv4 special-purpose range', () => {
    for (const ip of ['0.1.2.3', '100.127.255.254', '127.255.255.254', '169.254.169.254', '172.31.255.255', '192.0.0.8', '192.88.99.1', '198.18.0.1', '198.19.255.255',
      '239.255.255.250', '240.0.0.1', '250.1.2.3']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });

  it('judges IPv4-mapped (dotted and hex), IPv4-translated and IPv4-compatible addresses by their IPv4', () => {
    for (const ip of ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0:10.0.0.1', '::ffff:0:a00:1', '::127.0.0.1', '::10.0.0.1', '::7f00:1', '::a9fe:a9fe', '::ffff:100.64.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['::ffff:cb00:710a', '::ffff:0:203.0.113.10', '::203.0.113.10']) assert.equal(isPublicAddress(ip), true, ip);
  });

  it('judges NAT64 64:ff9b::/96 and 6to4 2002::/16 by the embedded IPv4', () => {
    for (const ip of ['64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '64:ff9b::c0a8:101', '2002:7f00:1::1', '2002:a00:1::', '2002:c0a8:101:1::1', '2002:a9fe:a9fe::1', '2002::1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['64:ff9b::203.0.113.10', '64:ff9b::cb00:710a', '2002:cb00:710a::1']) assert.equal(isPublicAddress(ip), true, ip);
  });

  it('refuses Teredo, local-use NAT64, the IETF block, site-local, discard-only and anything outside 2000::/3', () => {
    for (const ip of ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1', '2001:1ff::1', '64:ff9b:1::a00:1', 'fec0::1', '100::1', '::2', '1::', 'fe80::1%eth0', 'fe80::1%1', 'ff0e::1', 'fdff:ffff::1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001::1', '2001:200::1', '3fff:ffff::1']) assert.equal(isPublicAddress(ip), true, ip);
  });

  it('refuses what is not an address', () => {
    for (const ip of ['', 'client.example.com', '1.2.3', '256.1.1.1', '010.0.0.1', null, undefined, 12, {}]) assert.equal(isPublicAddress(ip), false, String(ip));
  });
});

describe('fetchClientMetadata (hardening)', () => {
  const json = (res, body, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const good = { client_id: URL_, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] };
  const opts = (port, extra = {}) => ({ lookup: publicLookup('203.0.113.10'), connectTo: '127.0.0.1', connectPort: port, ca: ca.cert, ...extra });

  it('refuses a URL that is not in canonical form, names an address, or is not a string, before any lookup', async () => {
    let lookups = 0;
    const lookup = () => { lookups += 1; throw new Error('no lookup'); };
    for (const bad of ['https://CLIENT.example.com/client.json', 'https://client.example.com:443/client.json', 'https://client.example.com/a/../client.json',
      'https://client.example.com\\client.json', 'https://client.example.com/c lient.json', 'https://client.example.com', 'https://client.example.com/c.json#',
      'https://127.0.0.1/c.json', 'https://[::1]/c.json', 'https://0x7f.1/c.json', 'https://2130706433/c.json', 'ftp://client.example.com/c.json',
      ' https://client.example.com/c.json', 'https://client.example.com/c.json\n', `https://client.example.com/${'a'.repeat(600)}`, '', null, 42]) {
      await assert.rejects(fetchClientMetadata(bad, { lookup }), (err) => err instanceof OAuthError && err.error === 'invalid_client', String(bad));
      assert.equal(lookups, 0, String(bad));
    }
  });

  it('a connect that throws is refused at once, not left to the timeout', async () => {
    const original = tls.connect;
    tls.connect = () => { throw new TypeError('bad socket options'); };
    const t = Date.now();
    try {
      await assert.rejects(fetchClientMetadata(URL_, { lookup: publicLookup('203.0.113.10') }), (err) => err instanceof OAuthError && !/timed out/.test(err.message));
    } finally {
      tls.connect = original;
    }
    assert.ok(Date.now() - t < 1000);
  });

  it('refuses when any resolved address is private, when resolution fails or is empty, and never names the address', async () => {
    const mixed = (host, o, cb) => cb(null, [{ address: '203.0.113.10', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    await assert.rejects(fetchClientMetadata(URL_, { lookup: mixed }), (err) => err instanceof OAuthError && /not public/.test(err.message) && !/10\.0\.0\.5/.test(err.message));
    const mapped = (host, o, cb) => cb(null, [{ address: '::ffff:169.254.169.254', family: 6 }]);
    await assert.rejects(fetchClientMetadata(URL_, { lookup: mapped }), /not public/);
    const failing = (host, o, cb) => cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await assert.rejects(fetchClientMetadata(URL_, { lookup: failing }), (err) => err instanceof OAuthError && /cannot resolve/.test(err.message));
    const empty = (host, o, cb) => cb(null, []);
    await assert.rejects(fetchClientMetadata(URL_, { lookup: empty }), (err) => err instanceof OAuthError && /no address/.test(err.message));
    const throwing = () => { throw new Error('boom'); };
    await assert.rejects(fetchClientMetadata(URL_, { lookup: throwing }), OAuthError);
  });

  it('resolves once and connects to the resolved address with the name as SNI and Host (no second lookup, no rebinding)', async () => {
    const port = await docServer((req, res) => { assert.equal(req.headers.host, 'client.example.com'); json(res, good); });
    let lookups = 0;
    const rebinding = (host, o, cb) => { lookups += 1; cb(null, [{ address: lookups === 1 ? '203.0.113.10' : '127.0.0.1', family: 4 }]); };
    const seen = [];
    const original = tls.connect;
    tls.connect = (options) => {
      seen.push({ host: options.host, servername: options.servername });
      assert.throws(() => options.lookup('client.example.com', {}, () => {}), /no second lookup/);
      return original({ ...options, host: '127.0.0.1' });
    };
    try {
      const doc = await fetchClientMetadata(URL_, { lookup: rebinding, connectPort: port, ca: ca.cert });
      assert.equal(doc.client_id, URL_);
    } finally {
      tls.connect = original;
    }
    assert.equal(lookups, 1);
    assert.deepEqual(seen, [{ host: '203.0.113.10', servername: 'client.example.com' }]);
  });

  it('ignores HTTP(S)_PROXY', async () => {
    let proxied = 0;
    const proxy = net.createServer((s) => { proxied += 1; s.destroy(); });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    servers.push(proxy);
    const port = await docServer((req, res) => json(res, good));
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    Object.assign(process.env, { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: '' });
    try {
      assert.equal((await fetchClientMetadata(URL_, opts(port))).client_id, URL_);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    assert.equal(proxied, 0);
  });

  it('verifies the certificate against the name', async () => {
    const other = issueCert(ca, { dnsNames: ['other.example.com'] });
    const server = https.createServer({ cert: other.cert, key: other.key }, (req, res) => json(res, good));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    await assert.rejects(fetchClientMetadata(URL_, opts(server.address().port)), OAuthError);
  });

  it('the timeout covers the lookup, the TLS handshake and a trickled body', async () => {
    const hanging = () => {};
    let t = Date.now();
    await assert.rejects(fetchClientMetadata(URL_, { lookup: hanging, timeoutMs: 100 }), /timed out/);
    assert.ok(Date.now() - t < 2000);

    const sockets = [];
    const silent = net.createServer((s) => sockets.push(s)); // accepts TCP, never speaks TLS
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    servers.push(silent);
    t = Date.now();
    await assert.rejects(fetchClientMetadata(URL_, opts(silent.address().port, { timeoutMs: 150 })), /timed out/);
    assert.ok(Date.now() - t < 2000);
    for (const s of sockets) s.destroy();

    const timers = [];
    const trickle = await docServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"client_id":');
      const timer = setInterval(() => res.write(' '), 20);
      timers.push(timer);
      res.on('close', () => clearInterval(timer));
    });
    t = Date.now();
    await assert.rejects(fetchClientMetadata(URL_, opts(trickle, { timeoutMs: 250 })), /timed out/);
    assert.ok(Date.now() - t < 2000);
    for (const timer of timers) clearInterval(timer);
  });

  it('caps the body while streaming (chunked, no length) and refuses a declared length over the cap', async () => {
    const chunked = await docServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 20; i += 1) res.write('x'.repeat(1024));
      res.end();
    });
    await assert.rejects(fetchClientMetadata(URL_, opts(chunked, { maxBytes: 8192 })), /over 8 KiB/);
    const declared = await docServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '70000' }); res.write('{'); });
    await assert.rejects(fetchClientMetadata(URL_, opts(declared)), /64 KiB/);
  });

  it('refuses an encoded body, a JSON array, prototype keys, and bad redirect_uris', async () => {
    const gz = await docServer((req, res) => json(res, good, { 'content-encoding': 'gzip' }));
    await assert.rejects(fetchClientMetadata(URL_, opts(gz)), /encoded/);
    const arr = await docServer((req, res) => json(res, [good]));
    await assert.rejects(fetchClientMetadata(URL_, opts(arr)), OAuthError);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const proto = await docServer((req, res) => json(res, `{"client_id":${JSON.stringify(URL_)},"redirect_uris":[],"x":{"${key}":{"polluted":true}}}`));
      await assert.rejects(fetchClientMetadata(URL_, opts(proto)), (err) => err instanceof OAuthError && /forbidden key/.test(err.message), key);
    }
    assert.equal({}.polluted, undefined);
    const many = await docServer((req, res) => json(res, { ...good, redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example.com/cb${i}`) }));
    await assert.rejects(fetchClientMetadata(URL_, opts(many)), /redirect_uris/);
    const nonString = await docServer((req, res) => json(res, { ...good, redirect_uris: [{}] }));
    await assert.rejects(fetchClientMetadata(URL_, opts(nonString)), /redirect_uris/);
  });

  it('compares client_id as an exact string', async () => {
    for (const id of [`${URL_}/`, URL_.replace('client.', 'CLIENT.'), URL_.replace('.com/', '.com:443/'), ` ${URL_}`, URL_.replace('/client.json', '/%63lient.json')]) {
      const port = await docServer((req, res) => json(res, { ...good, client_id: id }));
      await assert.rejects(fetchClientMetadata(URL_, opts(port)), /client_id/, id);
    }
  });

  it('strips control characters from client_name and caps it at 200 code points; falls back to the host', async () => {
    const dirty = await docServer((req, res) => json(res, { ...good, client_name: ' Evil\u0000\u001b[31mClient\u007f\u0085 ' }));
    assert.equal((await fetchClientMetadata(URL_, opts(dirty))).client_name, 'Evil[31mClient');
    const long = await docServer((req, res) => json(res, { ...good, client_name: '\u{1F600}'.repeat(250) }));
    assert.equal(Array.from((await fetchClientMetadata(URL_, opts(long))).client_name).length, 200);
    const blank = await docServer((req, res) => json(res, { ...good, client_name: '\u0000\u0007' }));
    assert.equal((await fetchClientMetadata(URL_, opts(blank))).client_name, 'client.example.com');
  });
});
