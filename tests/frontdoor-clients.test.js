// tests/frontdoor-clients.test.js — fleet stage 4 §3.4 (clients).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClientRegistry, validRedirectUri, clientHost } = require('../src/frontdoor/oauth/clients');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-clients-')); temps.push(d); return path.join(d, 'clients.json'); };
const good = (extra = {}) => ({ client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra });

describe('redirect URIs', () => {
  it('https or loopback http, never a fragment', () => {
    for (const ok of ['https://client.example.com/cb', 'http://127.0.0.1:33418/cb', 'http://[::1]:9/cb', 'http://localhost/cb']) assert.equal(validRedirectUri(ok), true, ok);
    for (const bad of ['http://client.example.com/cb', 'https://client.example.com/cb#frag', 'javascript:alert(1)', 'custom://cb', '']) assert.equal(validRedirectUri(bad), false, bad);
  });
});

describe('ClientRegistry', () => {
  it('registers a public client with a dcr_ id and persists it', () => {
    const f = file();
    const r = new ClientRegistry({ file: f, now: () => 0 });
    const c = r.register(good(), { ip: '203.0.113.9' });
    assert.match(c.client_id, /^dcr_[A-Za-z0-9_-]{22}$/);
    assert.equal(c.token_endpoint_auth_method, 'none');
    assert.equal(new ClientRegistry({ file: f }).get(c.client_id).client_name, 'Example Client');
  });

  it('refuses metadata outside what §3.4 accepts', () => {
    const r = new ClientRegistry({ file: file() });
    for (const bad of [
      good({ token_endpoint_auth_method: 'client_secret_basic' }), good({ grant_types: ['client_credentials'] }), good({ response_types: ['token'] }),
      good({ redirect_uris: [] }), good({ redirect_uris: ['http://client.example.com/cb'] }), good({ client_name: '' })
    ]) {
      assert.throws(() => r.register(bad, { ip: '203.0.113.9' }), (err) => err.error === 'invalid_client_metadata', JSON.stringify(bad));
    }
  });

  it('10 registrations per IP per hour; 100 clients without a grant; purged after 24 h', () => {
    let now = 0;
    const r = new ClientRegistry({ file: file(), now: () => now });
    for (let i = 0; i < 10; i += 1) r.register(good(), { ip: '203.0.113.9' });
    assert.throws(() => r.register(good(), { ip: '203.0.113.9' }), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
    now += 3600001;
    for (let i = 0; i < 90; i += 1) r.register(good(), { ip: `198.51.100.${i % 200}` });
    assert.throws(() => r.register(good(), { ip: '198.51.100.250' }), (err) => err.error === 'temporarily_unavailable');
    const kept = r.list()[0].client_id;
    r.markGranted(kept);
    now += 24 * 3600000 + 1;
    r.purge();
    assert.deepEqual(r.list().map((c) => c.client_id), [kept]);
  });

  // Final review F-2: nothing called purge(), so 100 unapproved registrations
  // locked POST /oauth/register at 429 for good, restarts included.
  it('100 stale unapproved registrations expire on their own, across a restart', () => {
    let now = 0;
    const f = file();
    const r = new ClientRegistry({ file: f, now: () => now });
    for (let i = 0; i < 100; i += 1) {
      if (i > 0 && i % 10 === 0) now += 3600001;
      r.register(good(), { ip: `198.51.100.${i}` });
    }
    assert.throws(() => r.register(good(), { ip: '203.0.113.200' }), (err) => err.status === 429 && /waiting for approval/.test(err.error_description || err.message));
    now += 24 * 3600000 + 1;
    const restarted = new ClientRegistry({ file: f, now: () => now });
    assert.equal(restarted.list().length, 100, 'clients.json kept them');
    const c = restarted.register(good(), { ip: '203.0.113.201' });
    assert.match(c.client_id, /^dcr_/);
    assert.equal(restarted.list().filter((x) => x.created_at === new Date(0).toISOString()).length, 0, 'the oldest are gone');
    assert.equal(new ClientRegistry({ file: f, now: () => now }).list().length, 1, 'the purge was saved');
  });

  it('a purge timer runs purge() hourly and stops', () => {
    let now = 0;
    const r = new ClientRegistry({ file: file(), now: () => now });
    r.register(good(), { ip: '198.51.100.1' });
    const ticks = [];
    const stop = r.startPurgeTimer({ everyMs: 5, setInterval: (fn, ms) => { ticks.push(ms); return { fn, unref() { this.unrefd = true; } }; }, clearInterval: (h) => { h.cleared = true; } });
    assert.equal(ticks[0], 5);
    now += 24 * 3600000 + 1;
    stop.handle.fn();
    assert.equal(r.list().length, 0);
    assert.equal(stop.handle.unrefd, true);
    stop();
    assert.equal(stop.handle.cleared, true);
  });

  it('resolves a CIMD client_id by fetching, and caches it for 24 h', async () => {
    let now = 0;
    let fetches = 0;
    const url = 'https://client.example.com/client.json';
    const r = new ClientRegistry({ file: file(), now: () => now, fetchMetadata: async (u) => { fetches += 1; return { client_id: u, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] }; } });
    const c = await r.resolve(url);
    assert.equal(c.kind, 'cimd');
    assert.equal(r.redirectAllowed(c, 'https://client.example.com/cb'), true);
    assert.equal(r.redirectAllowed(c, 'https://client.example.com/cb/'), false, 'exact string match');
    await r.resolve(url);
    assert.equal(fetches, 1);
    now += 24 * 3600000 + 1;
    await r.resolve(url);
    assert.equal(fetches, 2);
    assert.equal(await r.resolve('dcr_unknownunknownunknow'), null);
    assert.equal(clientHost(c, 'https://client.example.com/cb'), 'client.example.com');
  });
});

// ── Beyond the brief ─────────────────────────────────────────────────────────
describe('redirect URIs (hardening)', () => {
  it('refuses control characters, look-alike loopback hosts, empty fragments and oversize URIs', () => {
    for (const bad of ['https://client.example.com/c\nb', 'https://client.example.com/c\tb', ' https://client.example.com/cb', 'http://127.0.0.1.example.com/cb',
      'http://localhost.example.com/cb', 'http://127.0.0.2/cb', 'http://[::1]/cb#', 'https://client.example.com@evil.example.com/cb', 'https://u:p@client.example.com/cb', 'HTTPS://client.example.com/cb',
      'https:/client.example.com/cb', 'https://client.example.com', 'http://0x7f.1/cb', 'http://LOCALHOST/cb', `https://client.example.com/${'a'.repeat(2048)}`, null, 42, ['https://client.example.com/cb']]) {
      assert.equal(validRedirectUri(bad), false, String(bad));
    }
  });
});

describe('ClientRegistry (hardening)', () => {
  it('strips control characters from client_name when storing and caps it at 200 code points', () => {
    const r = new ClientRegistry({ file: file() });
    assert.equal(r.register(good({ client_name: ' Evil\u0000\u001b[31mClient\u0085 ' }), { ip: '203.0.113.9' }).client_name, 'Evil[31mClient');
    assert.equal(r.register(good({ client_name: '\u{1F600}'.repeat(200) }), { ip: '203.0.113.9' }).client_name.length, 400);
    for (const name of ['\u{1F600}'.repeat(201), '\u0000\u0007', 42]) {
      assert.throws(() => r.register(good({ client_name: name }), { ip: '203.0.113.9' }), (err) => err.error === 'invalid_client_metadata');
    }
  });

  it('bounds a record: at most 10 redirect URIs, and unknown metadata is not stored', () => {
    const r = new ClientRegistry({ file: file() });
    const eleven = Array.from({ length: 11 }, (_, i) => `https://client.example.com/cb${i}`);
    assert.throws(() => r.register(good({ redirect_uris: eleven }), { ip: '203.0.113.9' }), (err) => err.error === 'invalid_client_metadata');
    const c = r.register(good({ logo_uri: 'https://client.example.com/logo.png', pad: 'x'.repeat(10000) }), { ip: '203.0.113.9' });
    assert.deepEqual(Object.keys(c).sort(), ['client_id', 'client_id_issued_at', 'client_name', 'created_at', 'grant_types', 'has_grant', 'kind', 'redirect_uris', 'response_types', 'token_endpoint_auth_method']);
  });

  it('refuses a body that is not an object', () => {
    const r = new ClientRegistry({ file: file() });
    for (const bad of [null, [], 'x', 42]) assert.throws(() => r.register(bad, { ip: '203.0.113.9' }), (err) => err.error === 'invalid_client_metadata');
  });

  it('counts an IPv6 address by its /64 and a v4-mapped address by its IPv4', () => {
    const r = new ClientRegistry({ file: file() });
    for (let i = 1; i <= 10; i += 1) r.register(good(), { ip: `2001:db8:1:2::${i.toString(16)}` });
    assert.throws(() => r.register(good(), { ip: '2001:db8:1:2:ffff:ffff:ffff:ffff' }), (err) => err.status === 429);
    r.register(good(), { ip: '2001:db8:1:3::1' });
    for (let i = 0; i < 10; i += 1) r.register(good(), { ip: '203.0.113.20' });
    assert.throws(() => r.register(good(), { ip: '::ffff:203.0.113.20' }), (err) => err.status === 429);
  });

  it('caps the total number of clients, granted ones included', () => {
    const f = file();
    const { LIMITS } = require('../src/frontdoor/oauth/clients');
    const clients = Array.from({ length: LIMITS.maxClients }, (_, i) => ({ client_id: `dcr_${String(i).padStart(22, 'A')}`, client_name: 'Granted', redirect_uris: ['https://client.example.com/cb'], kind: 'dcr', created_at: new Date(0).toISOString(), has_grant: true }));
    fs.writeFileSync(f, JSON.stringify({ v: 1, clients }));
    const r = new ClientRegistry({ file: f });
    assert.equal(r.list().length, LIMITS.maxClients);
    assert.throws(() => r.register(good(), { ip: '203.0.113.9' }), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
  });

  it('writes atomically: valid JSON, no temp files left, has_grant survives a reload', () => {
    const f = file();
    const r = new ClientRegistry({ file: f });
    const c = r.register(good(), { ip: '203.0.113.9' });
    r.markGranted(c.client_id);
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['clients.json']);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).clients[0].client_id, c.client_id);
    assert.equal(new ClientRegistry({ file: f }).get(c.client_id).has_grant, true);
  });

  it('ignores records in the file that are not DCR clients', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ v: 1, clients: [{ client_id: 'https://client.example.com/c.json' }, null, { client_id: 'dcr_short' }] }));
    assert.deepEqual(new ClientRegistry({ file: f }).list(), []);
  });

  it('CIMD: one fetch for concurrent resolves, failures are not cached, invalid redirects dropped, cache bounded', async () => {
    let fetches = 0;
    let fail = false;
    const fetchMetadata = async (u) => {
      fetches += 1;
      await new Promise((r) => setImmediate(r));
      if (fail) throw Object.assign(new Error('nope'), { error: 'invalid_client' });
      return { client_id: u, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb', 'http://client.example.com/cb'] };
    };
    const r = new ClientRegistry({ file: file(), fetchMetadata });
    const url = 'https://client.example.com/client.json';
    const [a, b] = await Promise.all([r.resolve(url), r.resolve(url)]);
    assert.equal(a, b);
    assert.equal(fetches, 1);
    assert.deepEqual(a.redirect_uris, ['https://client.example.com/cb']);
    fail = true;
    await assert.rejects(r.resolve('https://client.example.com/other.json'), /nope/);
    assert.equal(r.get('https://client.example.com/other.json'), null);
    fail = false;
    assert.equal(await r.resolve('http://client.example.com/client.json'), null);
    assert.equal(await r.resolve('not a client id'), null);
    const { LIMITS } = require('../src/frontdoor/oauth/clients');
    for (let i = 0; i < LIMITS.cimdCacheMax; i += 1) await r.resolve(`https://client.example.com/c${i}.json`);
    assert.equal(r.cimd.size, LIMITS.cimdCacheMax);
    assert.equal(r.get(url), null, 'the oldest entry was evicted');
  });
});

describe('ClientRegistry (fix round 1)', () => {
  const corrupt = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('clients.json.corrupt-'));

  for (const [label, content] of [['invalid JSON', '{"v":1,"clients":[{"client_id":'], ['clients not an array', '{"v":1,"clients":{"dcr_x":{}}}'], ['no clients key', '{"v":1}'], ['JSON null', 'null']]) {
    it(`a file with ${label} is moved aside, kept, and never overwritten`, () => {
      const f = file();
      fs.writeFileSync(f, content);
      const r = new ClientRegistry({ file: f, now: () => 1234 });
      assert.deepEqual(r.list(), []);
      assert.deepEqual(corrupt(f), ['clients.json.corrupt-1234']);
      r.register(good(), { ip: '203.0.113.9' });
      assert.equal(fs.readFileSync(path.join(path.dirname(f), 'clients.json.corrupt-1234'), 'utf8'), content);
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).clients.length, 1);
    });
  }

  it('a read error other than ENOENT moves the path aside too', () => {
    const f = file();
    fs.mkdirSync(f); // reading a directory fails with EISDIR (EPERM on some platforms)
    const r = new ClientRegistry({ file: f, now: () => 7 });
    assert.deepEqual(corrupt(f), ['clients.json.corrupt-7']);
    r.register(good(), { ip: '203.0.113.9' });
    assert.ok(fs.statSync(path.join(path.dirname(f), 'clients.json.corrupt-7')).isDirectory());
  });

  it('refuses to start when an unloadable file cannot be moved aside', () => {
    const f = file();
    fs.writeFileSync(f, 'not json');
    const original = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    try {
      assert.throws(() => new ClientRegistry({ file: f }), /cannot be moved aside \(EACCES\)/);
    } finally {
      fs.renameSync = original;
    }
    assert.equal(fs.readFileSync(f, 'utf8'), 'not json');
  });

  it('get() honours the 24 h CIMD cache age', async () => {
    let now = 0;
    const url = 'https://client.example.com/client.json';
    const r = new ClientRegistry({ file: file(), now: () => now, fetchMetadata: async (u) => ({ client_id: u, client_name: 'Example Client', redirect_uris: [] }) });
    await r.resolve(url);
    assert.equal(r.get(url).client_id, url);
    now += 24 * 3600000;
    assert.equal(r.get(url), null);
  });

  it('at most 16 CIMD fetches in flight; past that, temporarily_unavailable (429)', async () => {
    const { LIMITS } = require('../src/frontdoor/oauth/clients');
    assert.equal(LIMITS.cimdInflightMax, 16);
    const release = [];
    const r = new ClientRegistry({ file: file(), fetchMetadata: (u) => new Promise((resolve) => release.push(() => resolve({ client_id: u, client_name: 'C', redirect_uris: [] }))) });
    const pending = Array.from({ length: 16 }, (_, i) => r.resolve(`https://client.example.com/c${i}.json`));
    await assert.rejects(r.resolve('https://client.example.com/c16.json'), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
    const same = r.resolve('https://client.example.com/c0.json'); // joins an existing fetch
    for (const go of release) go();
    await Promise.all([...pending, same]);
    assert.equal(release.length, 16);
    const last = r.resolve('https://client.example.com/c16.json'); // room again once the fetches finished
    release[16]();
    assert.equal((await last).client_id, 'https://client.example.com/c16.json');
  });
});

describe('ClientRegistry (Task 22)', () => {
  it('a failed CIMD fetch is answered from memory for 60 s, then fetched again; needsFetch says when a fetch would happen', async () => {
    let now = 0;
    let fetches = 0;
    let fail = true;
    const r = new ClientRegistry({ file: file(), now: () => now, fetchMetadata: async (u) => {
      fetches += 1;
      if (fail) throw Object.assign(new Error('client metadata: unreachable'), { error: 'invalid_client' });
      return { client_id: u, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] };
    } });
    const url = 'https://client.example.com/client.json';
    assert.equal(r.needsFetch(url), true);
    assert.equal(r.needsFetch('dcr_AAAAAAAAAAAAAAAAAAAAAA'), false);
    assert.equal(r.needsFetch('not a client id'), false);
    await assert.rejects(r.resolve(url), /unreachable/);
    assert.equal(r.needsFetch(url), false);
    now += 59999;
    await assert.rejects(r.resolve(url), /unreachable/);
    assert.equal(fetches, 1);
    now += 1;
    fail = false;
    assert.equal(r.needsFetch(url), true);
    assert.equal((await r.resolve(url)).client_id, url);
    assert.equal(fetches, 2);
    assert.equal(r.needsFetch(url), false, 'cached');
  });

  it('a refused redirect URI names the canonical form', () => {
    const r = new ClientRegistry({ file: file() });
    assert.throws(() => r.register(good({ redirect_uris: ['https://user@client.example.com/cb'] })), /canonical URL form .*no userinfo or fragment/);
  });
});
