// tests/frontdoor-probe.test.js — fleet stage 4 §3.13 (SelfProbe), §10 condition 4.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const net = require('net');
const { X509Certificate } = require('crypto');
const { SelfProbe, createProbeHandler, createProbeCertificate, guardLookup, MAX_PENDING_NONCES } = require('../src/frontdoor/probe');
const { SniListener } = require('../src/frontdoor/tls/sni-listener');
const { createFrontDoorHandler, createMcpHttpServer } = require('../src/frontdoor/http');
const { createCa, issueCert, selfSigned, fingerprint } = require('./helpers/test-certs');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const DOMAIN = 'kl.example.com';
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const lookup = (host, options, cb) => {
  const done = typeof options === 'function' ? options : cb;
  const opts = typeof options === 'function' ? {} : options || {};
  if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
};

async function frontDoor({ ownFingerprint = null, probeLookup = lookup, wrapProbe = (h) => h, probeCa = undefined, impostor = false, allowLoopback = true } = {}) {
  const ca = createCa();
  const ownMcp = issueCert(ca, { dnsNames: [`mcp.${DOMAIN}`] });
  // impostor: same CA, same name, different key (a TLS-terminating forwarder).
  const mcpCert = impostor ? issueCert(ca, { dnsNames: [`mcp.${DOMAIN}`] }) : ownMcp;
  const mesh = selfSigned({ commonName: `mesh.${DOMAIN}` });
  const probeCert = createProbeCertificate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-probe-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let probe = null;
  const handler = createFrontDoorHandler({
    mcpHost: `mcp.${DOMAIN}`, oauth: { handle: async () => false },
    phoneApiHandler: (req, res) => { res.writeHead(404); res.end(); },
    probeHandler: wrapProbe(createProbeHandler({ expects: (nonce) => Boolean(probe && probe.expects(nonce)) }))
  });
  const server = createMcpHttpServer(handler);
  const tls = require('tls');
  const listener = new SniListener({
    host: '127.0.0.1', port: 0, domain: DOMAIN,
    mcpContext: () => tls.createSecureContext({ cert: mcpCert.cert, key: mcpCert.key }),
    meshContext: tls.createSecureContext({ cert: mesh.cert, key: mesh.key }),
    isPinnedNodeCert: () => false, isProbeCert: (fp) => Boolean(probe && probe.isProbeCert(fp)), acmeChallenge: () => null,
    onMcpSocket: (s) => server.emit('connection', s), onMeshSocket: (s) => s.destroy()
  });
  await listener.start();
  cleanups.push(() => listener.stop());
  const raised = [];
  probe = new SelfProbe({
    domain: DOMAIN, port: listener.address().port, file: path.join(dir, 'probe.json'),
    ownMeshFingerprint: () => ownFingerprint || fingerprint(mesh.cert), ownMcpFingerprint: () => fingerprint(ownMcp.cert), probeCert,
    allowLoopbackForTests: allowLoopback,
    alerts: { raise: (kind, o) => { raised.push([kind, o.subject]); return {}; } }, lookup: probeLookup, ca: probeCa === undefined ? ca.cert : probeCa, timeoutMs: 3000
  });
  return { probe, raised, listener, ca, dir };
}

describe('SelfProbe', () => {
  it('echoes its own nonce on mcp., sees the front door\'s own certificate on mesh., and records the result', async () => {
    const t = await frontDoor();
    const r = await t.probe.runOnce();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.mcp.ok, r.mesh.ok], [true, true]);
    assert.deepEqual(SelfProbe.readLast(path.join(t.dir, 'probe.json')), r);
    assert.deepEqual(t.raised, []);
  });

  it('the probe endpoint answers only nonces the probe is waiting for', async () => {
    const t = await frontDoor();
    const status = await new Promise((resolve, reject) => {
      https.get({ host: `mcp.${DOMAIN}`, port: t.listener.address().port, path: `/.well-known/kl-probe/${'A'.repeat(32)}`, ca: t.ca.cert, lookup, agent: false }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 404);
  });

  it('a different certificate on mesh. fails; three failures in a row raise dns_probe_failed once', async () => {
    const t = await frontDoor({ ownFingerprint: 'f'.repeat(64) });
    for (let i = 0; i < 4; i += 1) {
      const r = await t.probe.runOnce();
      assert.equal(r.mesh.ok, false);
      assert.match(r.mesh.detail, /is not this front door's/);
    }
    assert.deepEqual(t.raised, [['dns_probe_failed', DOMAIN], ['dns_probe_failed', DOMAIN]], 'raised at the 3rd and 4th failure (AlertCenter dedupes a day)');
  });

  it('a resolution failure fails both halves', async () => {
    const t = await frontDoor({ probeLookup: (host, options, cb) => (typeof options === 'function' ? options : cb)(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })) });
    const r = await t.probe.runOnce();
    assert.deepEqual([r.ok, r.mcp.ok, r.mesh.ok], [false, false, false]);
    assert.match(r.mcp.detail, /ENOTFOUND/);
  });

  it('start() runs after the first delay; stop() ends it', async () => {
    const t = await frontDoor();
    t.probe.firstDelayMs = 20;
    t.probe.start();
    for (let i = 0; i < 100 && !t.probe.last(); i += 1) await new Promise((r) => setTimeout(r, 20));
    t.probe.stop();
    assert.equal(t.probe.last().ok, true);
  });
  it('does not follow a redirect: a 3xx on mcp. is a failure and the other host is never asked for', async () => {
    const asked = [];
    const recording = (host, options, cb) => { asked.push(host); lookup(host, options, cb); };
    const t = await frontDoor({
      probeLookup: recording,
      wrapProbe: () => (req, res) => { res.writeHead(302, { location: `https://evil.example.com/.well-known/kl-probe/${req.url.split('/').pop()}` }); res.end(); }
    });
    const r = await t.probe.runOnce();
    assert.equal(r.mcp.ok, false);
    assert.match(r.mcp.detail, /answered 302/);
    assert.deepEqual([...new Set(asked)].sort(), [`mcp.${DOMAIN}`, `mesh.${DOMAIN}`]);
  });

  it('a 200 without exactly our nonce is a failure (something else answers on mcp.)', async () => {
    for (const body of ['hello', '', 'x'.repeat(5000)]) {
      const t = await frontDoor({ wrapProbe: () => (req, res) => { res.writeHead(200); res.end(body); } });
      const r = await t.probe.runOnce();
      assert.equal(r.mcp.ok, false, body.slice(0, 10));
      assert.match(r.mcp.detail, /answered 200 without our nonce/);
    }
  });

  it('the resolved address is used only to connect: the result never records it', async () => {
    const t = await frontDoor();
    const r = await t.probe.runOnce();
    assert.equal(r.ok, true);
    assert.ok(!JSON.stringify(r).includes('127.0.0.1'), JSON.stringify(r));
    assert.ok(!fs.readFileSync(path.join(t.dir, 'probe.json'), 'utf8').includes('127.0.0.1'));
  });

  it('mcp. must pass WebPKI: a certificate from an untrusted CA fails', async () => {
    const t = await frontDoor({ probeCa: null });
    const r = await t.probe.runOnce();
    assert.equal(r.mcp.ok, false);
    assert.equal(r.mesh.ok, true);
  });

  it('mesh. fails closed when the front door\'s own fingerprint is missing or unreadable', async () => {
    const t = await frontDoor();
    for (const own of [() => null, () => '', () => { throw new Error('no identity'); }]) {
      t.probe.ownMeshFingerprint = own;
      const r = await t.probe.runOnce();
      assert.equal(r.mesh.ok, false);
    }
  });

  it('isProbeCert matches only the probe certificate\'s own SHA-256 fingerprint', () => {
    const cert = createProbeCertificate();
    const p = new SelfProbe({ domain: DOMAIN, ownMeshFingerprint: () => null, probeCert: cert });
    assert.match(cert.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(p.isProbeCert(cert.fingerprint), true);
    for (const fp of [null, undefined, '', cert.fingerprint.toUpperCase(), cert.fingerprint.slice(0, 63), 'f'.repeat(64), createProbeCertificate().fingerprint]) {
      assert.equal(p.isProbeCert(fp), false, String(fp));
    }
  });

  it('pending nonces are bounded and expire', () => {
    let t0 = 1000000;
    const p = new SelfProbe({ domain: DOMAIN, ownMeshFingerprint: () => null, now: () => t0, timeoutMs: 1000 });
    const nonces = [];
    for (let i = 0; i < MAX_PENDING_NONCES + 3; i += 1) nonces.push(p._issueNonce());
    assert.equal(p.pending.size, MAX_PENDING_NONCES);
    assert.equal(p.expects(nonces[0]), false, 'the oldest were dropped');
    assert.equal(p.expects(nonces.at(-1)), true);
    t0 += 60000;
    assert.equal(p.expects(nonces.at(-1)), false, 'expired');
    assert.equal(p.pending.size, 0);
    for (const bad of [null, 42, {}, 'x'.repeat(10000)]) assert.equal(p.expects(bad), false);
  });

  it('two runOnce calls at once share the in-flight run (one nonce, one result)', async () => {
    const t = await frontDoor();
    const [a, b] = await Promise.all([t.probe.runOnce(), t.probe.runOnce()]);
    assert.equal(a, b);
    assert.equal(t.probe.pending.size, 0);
  });

  it('a peer that accepts and never answers times both halves out within timeoutMs', async () => {
    const sockets = [];
    const server = net.createServer((s) => sockets.push(s));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }));
    const p = new SelfProbe({ domain: DOMAIN, port: server.address().port, ownMeshFingerprint: () => 'a'.repeat(64), ownMcpFingerprint: () => 'a'.repeat(64), lookup, allowLoopbackForTests: true, timeoutMs: 300 });
    const started = Date.now();
    const r = await p.runOnce();
    assert.deepEqual([r.mcp.ok, r.mesh.ok], [false, false]);
    assert.match(r.mcp.detail, /timed out/);
    assert.match(r.mesh.detail, /timed out/);
    assert.ok(Date.now() - started < 2500);
  });

  it('a throwing alert sink or an unwritable file never loses the result', async () => {
    const t = await frontDoor({ ownFingerprint: 'f'.repeat(64) });
    t.probe.alerts = { raise: () => { throw new Error('sink down'); } };
    const blocker = path.join(t.dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    t.probe.file = path.join(blocker, 'probe.json');
    for (let i = 0; i < 3; i += 1) {
      const r = await t.probe.runOnce();
      assert.equal(r.ok, false);
    }
    assert.equal(t.probe.last().ok, false);
    assert.equal(t.probe.failures, 3);
  });

  it('readLast reads only a small, regular, well-formed probe.json', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-probe-read-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'probe.json');
    const good = { at: '2026-09-23T12:00:00.000Z', ok: true, mcp: { ok: true, detail: 'a' }, mesh: { ok: true, detail: 'b' } };
    fs.writeFileSync(file, JSON.stringify(good));
    assert.deepEqual(SelfProbe.readLast(file), good);
    for (const bad of [{ ...good, ok: 'yes' }, { ...good, mcp: null }, { ...good, at: 5 }, [], 'x', { ...good, mesh: { ok: true, detail: 'x'.repeat(5000) } }]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.equal(SelfProbe.readLast(file), null, JSON.stringify(bad).slice(0, 80));
    }
    fs.writeFileSync(file, JSON.stringify({ ...good, pad: 'x'.repeat(70000) }));
    assert.equal(SelfProbe.readLast(file), null, 'oversize');
    fs.rmSync(file);
    assert.equal(SelfProbe.readLast(file), null, 'missing');
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(good));
    let linked = true;
    try { fs.symlinkSync(target, file); } catch { linked = false; }
    if (linked) assert.equal(SelfProbe.readLast(file), null, 'a symlink is refused');
  });
});

describe('createProbeHandler', () => {
  const NONCE = 'N'.repeat(32);
  const call = (handler, method, url) => {
    const out = { status: null, body: '', headers: null };
    handler({ method, url }, { writeHead: (s, h) => { out.status = s; out.headers = h; }, end: (b) => { out.body = b === undefined ? '' : String(b); } });
    return out;
  };

  it('echoes only a nonce the probe is waiting for, to a GET of the exact path', () => {
    const h = createProbeHandler({ expects: (n) => n === NONCE });
    const ok = call(h, 'GET', `/.well-known/kl-probe/${NONCE}`);
    assert.deepEqual([ok.status, ok.body], [200, NONCE]);
    for (const [method, url] of [
      ['GET', `/.well-known/kl-probe/${'M'.repeat(32)}`],
      ['HEAD', `/.well-known/kl-probe/${NONCE}`],
      ['POST', `/.well-known/kl-probe/${NONCE}`],
      ['GET', `/.well-known/kl-probe/${NONCE}/x`],
      ['GET', `/.well-known/kl-probe/%3Cscript%3E${NONCE}`],
      ['GET', '/.well-known/kl-probe/'],
      ['GET', `/.well-known/kl-probe/${'N'.repeat(65)}`]
    ]) {
      const r = call(h, method, url);
      assert.deepEqual([r.status, r.body], [404, '{"error":"not_found"}'], `${method} ${url}`);
    }
  });

  it('a truthy non-true or throwing expects() is a 404', () => {
    for (const expects of [() => 'yes', () => 1, () => { throw new Error('x'); }]) {
      assert.equal(call(createProbeHandler({ expects }), 'GET', `/.well-known/kl-probe/${NONCE}`).status, 404);
    }
  });
});

describe('SelfProbe fix round 1', () => {
  it('mcp. must serve the front door\'s own certificate: a same-name, different-key certificate from the same CA fails', async () => {
    const t = await frontDoor({ impostor: true });
    const r = await t.probe.runOnce();
    assert.equal(r.mcp.ok, false, JSON.stringify(r));
    assert.match(r.mcp.detail, /not this front door's/);
    assert.equal(r.mesh.ok, true);
  });

  it('mcp. fails closed when the front door\'s own mcp. fingerprint is missing or unreadable', async () => {
    const t = await frontDoor();
    for (const own of [() => null, () => '', () => { throw new Error('no certificate yet'); }]) {
      t.probe.ownMcpFingerprint = own;
      const r = await t.probe.runOnce();
      assert.equal(r.mcp.ok, false);
    }
    t.probe.ownMcpFingerprint = undefined;
    assert.equal((await t.probe.runOnce()).mcp.ok, false);
  });

  it('loopback answers fail the probe unless the test-only option allows them', async () => {
    const t = await frontDoor({ allowLoopback: false });
    const r = await t.probe.runOnce();
    assert.deepEqual([r.ok, r.mcp.ok, r.mesh.ok], [false, false, false]);
    assert.match(r.mcp.detail, /mcp\.kl\.example\.com resolves to a loopback address/);
    assert.match(r.mesh.detail, /mesh\.kl\.example\.com resolves to a loopback address/);
    assert.ok(!JSON.stringify(r).includes('127.0.0.1'));
  });

  it('guardLookup refuses loopback, unspecified and link-local addresses, v4 and v6', async () => {
    const answer = (addresses) => (host, options, cb) => {
      const done = typeof options === 'function' ? options : cb;
      const all = typeof options === 'object' && options && options.all;
      if (all) done(null, addresses.map((a) => ({ address: a, family: net.isIP(a) })));
      else done(null, addresses[0], net.isIP(addresses[0]));
    };
    const run = (lk, all) => new Promise((resolve) => lk('mcp.kl.example.com', all ? { all: true } : {}, (err, a) => resolve(err ? err.message : a)));
    const cases = [
      ['127.0.0.1', 'loopback'], ['127.8.9.10', 'loopback'], ['::1', 'loopback'], ['::ffff:127.0.0.1', 'loopback'],
      ['0.0.0.0', 'unspecified'], ['::', 'unspecified'], ['0.1.2.3', 'unspecified'],
      ['169.254.169.254', 'link-local'], ['fe80::1', 'link-local'], ['febf::1', 'link-local'], ['::ffff:169.254.1.1', 'link-local']
    ];
    for (const [address, kind] of cases) {
      for (const all of [false, true]) {
        const out = await run(guardLookup(answer([address]), { allowLoopback: false }), all);
        assert.equal(out, `mcp.kl.example.com resolves to a ${kind} address, not the front door's public one`, `${address} all=${all}`);
      }
    }
    assert.match(await run(guardLookup(answer(['203.0.113.5', '127.0.0.1']), { allowLoopback: false }), true), /loopback/, 'one bad address in a list fails the answer');
    assert.equal(await run(guardLookup(answer(['203.0.113.5']), { allowLoopback: false }), false), '203.0.113.5');
    assert.equal(await run(guardLookup(answer(['2001:db8::1']), { allowLoopback: false }), false), '2001:db8::1');
    assert.equal(await run(guardLookup(answer(['127.0.0.1']), { allowLoopback: true }), false), '127.0.0.1');
    for (const address of ['0.0.0.0', '169.254.1.1', 'fe80::1']) {
      assert.match(String(await run(guardLookup(answer([address]), { allowLoopback: true }), false)), /resolves to/, `allowLoopback does not allow ${address}`);
    }
    assert.match(String(await run(guardLookup(answer(['not-an-ip']), { allowLoopback: false }), false)), /did not resolve to an IP address/);
  });

  it('readLast accepts only a strict ISO-8601 `at`', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-probe-at-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'probe.json');
    const half = { ok: true, detail: 'a' };
    for (const at of ['2026-09-23T12:00:00.000Z\u001b[2J', '2026-09-23', 'Wed, 23 Sep 2026 12:00:00 GMT', '2026-09-23T12:00:00.000+01:00', '2026-13-40T12:00:00.000Z']) {
      fs.writeFileSync(file, JSON.stringify({ at, ok: true, mcp: half, mesh: half }));
      assert.equal(SelfProbe.readLast(file), null, JSON.stringify(at));
    }
    fs.writeFileSync(file, JSON.stringify({ at: '2026-09-23T12:00:00.000Z', ok: true, mcp: half, mesh: half }));
    assert.equal(SelfProbe.readLast(file).at, '2026-09-23T12:00:00.000Z');
  });

  it('the probe certificate carries a random, neutral name', () => {
    const a = new X509Certificate(createProbeCertificate().cert);
    const b = new X509Certificate(createProbeCertificate().cert);
    assert.doesNotMatch(a.subject, /king|louie|probe/i);
    assert.notEqual(a.subject, b.subject);
  });
});
