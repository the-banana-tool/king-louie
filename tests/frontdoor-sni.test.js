// tests/frontdoor-sni.test.js — fleet stage 4 §3.2.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const http = require('http');
const { X509Certificate } = require('crypto');
const { SniListener, ipKey } = require('../src/frontdoor/tls/sni-listener');
const { createCa, issueCert, selfSigned, fingerprint } = require('./helpers/test-certs');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const DOMAIN = 'kl.example.com';
const ca = createCa();
const mcp = issueCert(ca, { dnsNames: [`mcp.${DOMAIN}`] });
const meshId = selfSigned({ commonName: 'frontdoor' });
const pinnedNode = selfSigned({ commonName: 'gpu-box' });
const strangerNode = selfSigned({ commonName: 'stranger' });
const probe = selfSigned({ commonName: 'probe' });

const listeners = [];
afterEach(async () => { while (listeners.length) await listeners.pop().stop(); });

async function start(overrides = {}) {
  const seen = { mcp: [], mesh: [], unknown: [], acme: [] };
  const l = new SniListener({
    host: '127.0.0.1', port: 0, domain: DOMAIN,
    mcpContext: () => tls.createSecureContext({ cert: mcp.cert, key: mcp.key }),
    meshContext: tls.createSecureContext({ cert: meshId.cert, key: meshId.key }),
    isPinnedNodeCert: (fp) => fp === fingerprint(pinnedNode.cert),
    isProbeCert: (fp) => fp === fingerprint(probe.cert),
    acmeChallenge: () => null,
    onMcpSocket: (s) => { seen.mcp.push(s); s.end('HTTP/1.1 204 No Content\r\n\r\n'); },
    onMeshSocket: (s) => { seen.mesh.push(s); s.end(); },
    onUnknownNodeKey: (e) => seen.unknown.push(e),
    ...overrides
  });
  await l.start();
  listeners.push(l);
  return { l, seen, port: l.address().port };
}

function connect(port, options) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options });
    const out = { socket: s, secure: false, closed: false, alpn: null, peer: null };
    s.once('secureConnect', () => { out.secure = true; out.alpn = s.alpnProtocol; out.peer = s.getPeerX509Certificate(); });
    s.on('data', () => {});
    s.on('error', () => {});
    s.once('close', () => { out.closed = true; resolve(out); });
  });
}

const waitFor = async (cond, ms = 2000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Resolves when `s` closes; fails the test instead of hanging past `ms`.
function closeWithin(s, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket still open after ${ms} ms`)), ms);
    s.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

// A raw TCP client that stays silent (never sends a ClientHello).
function quietClient(port) {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {});
  s.gone = new Promise((r) => s.once('close', () => r(true)));
  return s;
}

// The server-side raw sockets in accept order (the listener's own
// 'connection' handler runs first).
function rawSockets(l) {
  const raws = [];
  l.server.on('connection', (s) => raws.push(s));
  return raws;
}

describe('test certificates', () => {
  it('every issued certificate parses: the DER serial is positive and minimal (M12)', () => {
    for (let i = 0; i < 2000; i++) {
      const { cert } = issueCert(ca, { dnsNames: [`n${i}.${DOMAIN}`] });
      assert.doesNotThrow(() => new X509Certificate(cert), `certificate ${i}`);
    }
  });
});

describe('SniListener', () => {
  it('mcp. gets the web certificate, never asks for a client certificate, and reaches onMcpSocket', async () => {
    const { seen, port } = await start();
    const r = await connect(port, { servername: `mcp.${DOMAIN}`, ca: ca.cert, rejectUnauthorized: true, cert: pinnedNode.cert, key: pinnedNode.key });
    assert.equal(r.secure, true);
    assert.equal(seen.mcp.length, 1);
    assert.equal(seen.mcp[0].getPeerCertificate() && seen.mcp[0].getPeerCertificate().raw, undefined, 'mcp. never requested a client certificate');
  });

  it('mesh. hands a pinned node to onMeshSocket; unpinned or missing certificates are destroyed and counted', async () => {
    const { seen, port } = await start();
    await connect(port, { servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key });
    assert.equal(seen.mesh.length, 1);
    await connect(port, { servername: `mesh.${DOMAIN}`, cert: strangerNode.cert, key: strangerNode.key });
    await connect(port, { servername: `mesh.${DOMAIN}` });
    assert.equal(seen.mesh.length, 1);
    assert.equal(seen.unknown.length, 2);
    assert.equal(seen.unknown[0].fingerprint, fingerprint(strangerNode.cert));
    assert.equal(seen.unknown[1].fingerprint, null);
  });

  it('the probe certificate is closed right after the handshake and never reaches the mesh', async () => {
    const { seen, port } = await start();
    const r = await connect(port, { servername: `mesh.${DOMAIN}`, cert: probe.cert, key: probe.key });
    assert.equal(r.secure, true);
    assert.equal(fingerprint(`-----BEGIN CERTIFICATE-----\n${r.peer.raw.toString('base64')}\n-----END CERTIFICATE-----\n`), fingerprint(meshId.cert));
    assert.equal(seen.mesh.length, 0);
    assert.equal(seen.unknown.length, 0);
  });

  it('acme-tls/1 on mcp. is answered with the challenge certificate', async () => {
    const challenge = selfSigned({ commonName: `mcp.${DOMAIN}` });
    const { seen, port } = await start({ acmeChallenge: (name) => (name === `mcp.${DOMAIN}` ? tls.createSecureContext({ cert: challenge.cert, key: challenge.key }) : null) });
    const r = await connect(port, { servername: `mcp.${DOMAIN}`, ALPNProtocols: ['acme-tls/1'] });
    assert.equal(r.alpn, 'acme-tls/1');
    assert.equal(r.peer.fingerprint256.replace(/:/g, '').toLowerCase(), fingerprint(challenge.cert));
    assert.equal(seen.mcp.length, 0);
  });

  it('first boot (no certificate yet) and unknown names are destroyed', async () => {
    const { seen, port } = await start({ mcpContext: () => null });
    assert.equal((await connect(port, { servername: `mcp.${DOMAIN}` })).secure, false);
    assert.equal((await connect(port, { servername: `www.${DOMAIN}` })).secure, false);
    assert.equal((await connect(port, {})).secure, false);
    assert.equal(seen.mcp.length, 0);
  });

  it('closes a socket that sends no ClientHello in time, and caps sockets per IP', async () => {
    const { port } = await start({ limits: { helloTimeoutMs: 100, perIp: 2 } });
    const quiet = net.connect(port, '127.0.0.1');
    const closed = new Promise((r) => quiet.once('close', r));
    quiet.on('error', () => {});
    const extra = [net.connect(port, '127.0.0.1'), net.connect(port, '127.0.0.1')];
    for (const s of extra) s.on('error', () => {});
    const third = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); s.once('close', () => r(true)); });
    assert.equal(third, true);
    await closed;
    for (const s of extra) s.destroy();
  });

  it('refuses to start on a busy port with the exact message', async () => {
    const { port } = await start();
    const second = new SniListener({ host: '127.0.0.1', port, domain: DOMAIN, mcpContext: () => null, meshContext: null, isPinnedNodeCert: () => false, isProbeCert: () => false, acmeChallenge: () => null, onMcpSocket() {}, onMeshSocket() {} });
    await assert.rejects(second.start(), new RegExp(`^Error: cannot bind 127\\.0\\.0\\.1:${port}: `));
  });

  it('routes by the exact name only: no suffix, prefix or look-alike reaches mcp. or mesh.', async () => {
    const { seen, port } = await start();
    for (const servername of [`x.mcp.${DOMAIN}`, `mcp.${DOMAIN}.evil.example.com`, `mcp.${DOMAIN}x`, `mcpx.${DOMAIN}`, `mesh.x.${DOMAIN}`, `mcp.example.com`, DOMAIN]) {
      assert.equal((await connect(port, { servername })).secure, false, servername);
    }
    assert.equal((await connect(port, { servername: `MCP.KL.Example.COM` })).secure, true, 'the name compares lower-cased');
    assert.equal(seen.mcp.length, 1);
    assert.equal(seen.mesh.length, 0);
  });

  it('asks acmeChallenge with the SNI name, and falls back to the web certificate when it has no challenge', async () => {
    const asked = [];
    const { seen, port } = await start({ acmeChallenge: (name) => { asked.push(name); return null; } });
    const r = await connect(port, { servername: `mcp.${DOMAIN}`, ALPNProtocols: ['acme-tls/1', 'http/1.1'] });
    assert.deepEqual(asked, [`mcp.${DOMAIN}`]);
    assert.equal(r.alpn, 'http/1.1');
    assert.equal(seen.mcp.length, 1);
  });

  it('a pinned check answers only === true: truthy values and throws close the connection', async () => {
    for (const verdict of ['yes', 1, {}, () => { throw new Error('store down'); }]) {
      const check = typeof verdict === 'function' ? verdict : () => verdict;
      const { seen, port } = await start({ isPinnedNodeCert: check, isProbeCert: check });
      await connect(port, { servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key });
      assert.equal(seen.mesh.length, 0);
      assert.equal(seen.unknown.length, 1);
    }
  });

  it('an unknown node key still closes when onUnknownNodeKey throws', async () => {
    const { l, seen, port } = await start({ onUnknownNodeKey: () => { throw new Error('alert store down'); } });
    const r = await connect(port, { servername: `mesh.${DOMAIN}`, cert: strangerNode.cert, key: strangerNode.key });
    assert.equal(r.closed, true);
    assert.equal(seen.mesh.length, 0);
    await waitFor(() => l.sockets.size === 0);
  });

  it('a throwing mcpContext or acmeChallenge closes the connection without crashing', async () => {
    const { l, port } = await start({ mcpContext: () => { throw new Error('boom'); }, acmeChallenge: () => { throw new Error('boom'); } });
    assert.equal((await connect(port, { servername: `mcp.${DOMAIN}` })).secure, false);
    assert.equal((await connect(port, { servername: `mcp.${DOMAIN}`, ALPNProtocols: ['acme-tls/1'] })).secure, false);
    await waitFor(() => l.sockets.size === 0);
  });

  it('a raw socket always has an error listener: while peeking, handshaking, after hand-over and after close', async () => {
    let handed = null;
    const { l, port } = await start({ onMcpSocket: (s) => { handed = s; }, limits: { handshakeMs: 2000 } });
    const raws = rawSockets(l);
    const hasListener = (s) => { assert.ok(s.listenerCount('error') > 0); assert.doesNotThrow(() => s.emit('error', new Error('injected'))); };

    const peeking = quietClient(port);
    await waitFor(() => raws.length === 1);
    hasListener(raws[0]);
    await peeking.gone;
    hasListener(raws[0]);

    // A ClientHello with no handshake after it: the raw socket stays wrapped.
    const half = net.connect(port, '127.0.0.1');
    half.on('error', () => {});
    const helloBytes = await new Promise((resolve) => {
      const capture = net.createServer((s) => s.once('data', (d) => { resolve(d); s.destroy(); capture.close(); }));
      capture.listen(0, '127.0.0.1', () => {
        const c = tls.connect({ host: '127.0.0.1', port: capture.address().port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
        c.on('error', () => {});
      });
    });
    half.write(helloBytes);
    await waitFor(() => raws.length === 2 && [...l.sockets.values()].some((e) => e.stage === 'handshake'));
    hasListener(raws[1]);
    half.destroy();

    const r = connect(port, { servername: `mcp.${DOMAIN}` });
    await waitFor(() => handed !== null);
    hasListener(raws[2]);
    handed.destroy();
    await r;
    hasListener(raws[2]);
  });

  it('a peek that fails (garbage, not TLS) destroys the raw socket promptly', async () => {
    const { l, port } = await start();
    const s = net.connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('error', () => {});
    const t0 = Date.now();
    await closeWithin(s);
    assert.ok(Date.now() - t0 < 1000, 'closed well before the 5 s hello timeout');
    await waitFor(() => l.sockets.size === 0 && l.perIp.size === 0);
  });

  it('at the per-IP cap the oldest socket before its handshake is evicted, not the newcomer', async () => {
    const { l, port } = await start({ limits: { perIp: 2 } });
    const first = quietClient(port);
    await waitFor(() => l.sockets.size === 1);
    const second = quietClient(port);
    await waitFor(() => l.sockets.size === 2);
    const r = await connect(port, { servername: `mcp.${DOMAIN}` });
    assert.equal(r.secure, true, 'the newcomer got through');
    assert.equal(await first.gone, true, 'the oldest was evicted');
    assert.equal(second.destroyed, false, 'the younger one was kept');
    second.destroy();
    await waitFor(() => l.sockets.size === 0 && l.perIp.size === 0);
  });

  it('at the overall cap the oldest socket before its handshake is evicted', async () => {
    const { l, port } = await start({ limits: { maxSockets: 2 } });
    const first = quietClient(port);
    await waitFor(() => l.sockets.size === 1);
    const second = quietClient(port);
    await waitFor(() => l.sockets.size === 2);
    const third = quietClient(port);
    assert.equal(await first.gone, true);
    await waitFor(() => l.sockets.size === 2);
    assert.equal(second.destroyed, false);
    second.destroy();
    third.destroy();
    await waitFor(() => l.sockets.size === 0);
  });

  it('open (handed-over) connections are never evicted: with every slot open the newcomer is refused', async () => {
    const held = [];
    const { l, seen, port } = await start({ limits: { perIp: 1 }, onMcpSocket: (s) => { seen.mcp.push(s); held.push(s); } });
    const client = tls.connect({ host: '127.0.0.1', port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
    client.on('error', () => {});
    await waitFor(() => held.length === 1);
    const late = quietClient(port);
    assert.equal(await late.gone, true);
    assert.equal(held[0].destroyed, false, 'the open connection stays');
    client.destroy();
    await waitFor(() => l.sockets.size === 0 && l.perIp.size === 0);
  });

  it('closes a TLS handshake that stalls past handshakeMs', async () => {
    const { l, port } = await start({ limits: { handshakeMs: 100 } });
    const helloBytes = await new Promise((resolve) => {
      const capture = net.createServer((s) => s.once('data', (d) => { resolve(d); s.destroy(); capture.close(); }));
      capture.listen(0, '127.0.0.1', () => {
        const c = tls.connect({ host: '127.0.0.1', port: capture.address().port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
        c.on('error', () => {});
      });
    });
    const s = net.connect(port, '127.0.0.1', () => s.write(helloBytes));
    s.on('error', () => {});
    s.on('data', () => {});
    const t0 = Date.now();
    await closeWithin(s);
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(() => l.sockets.size === 0);
  });

  it('closes a handed-over connection that sends nothing within firstRequestMs', async () => {
    let handed = null;
    const { l, port } = await start({ limits: { firstRequestMs: 100 }, onMcpSocket: (s) => { handed = s; } });
    const r = await connect(port, { servername: `mcp.${DOMAIN}` });
    assert.equal(r.secure, true);
    assert.equal(handed.destroyed, true);
    await waitFor(() => l.sockets.size === 0);
  });

  it('keeps a connection an http.Server is serving past firstRequestMs', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    const { l, port } = await start({ limits: { firstRequestMs: 150 }, onMcpSocket: (s) => server.emit('connection', s) });
    const c = tls.connect({ host: '127.0.0.1', port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
    c.on('error', () => {});
    let body = '';
    c.on('data', (d) => { body += d; });
    await new Promise((r) => c.once('secureConnect', r));
    c.write(`GET / HTTP/1.1\r\nHost: mcp.${DOMAIN}\r\n\r\n`);
    await waitFor(() => body.includes('ok'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.destroyed, false, 'a served connection outlives firstRequestMs');
    c.destroy();
    await waitFor(() => l.sockets.size === 0);
  });

  it('counters and sockets return to zero after every kind of exit', async () => {
    const { l, port } = await start({ limits: { helloTimeoutMs: 100 } });
    await Promise.all([
      connect(port, { servername: `mcp.${DOMAIN}` }),
      connect(port, { servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key }),
      connect(port, { servername: `mesh.${DOMAIN}`, cert: strangerNode.cert, key: strangerNode.key }),
      connect(port, { servername: `mesh.${DOMAIN}`, cert: probe.cert, key: probe.key }),
      connect(port, { servername: `www.${DOMAIN}` }),
      quietClient(port).gone
    ]);
    await waitFor(() => l.sockets.size === 0 && l.perIp.size === 0);
  });

  it('stop() closes open connections and the listener', async () => {
    const held = [];
    const { l, port } = await start({ onMcpSocket: (s) => held.push(s) });
    const r = connect(port, { servername: `mcp.${DOMAIN}` });
    await waitFor(() => held.length === 1);
    const q = quietClient(port);
    await waitFor(() => l.sockets.size === 2);
    listeners.pop();
    await l.stop();
    assert.equal((await r).closed, true);
    assert.equal(await q.gone, true);
    assert.equal(l.address(), null);
    assert.equal(l.sockets.size, 0);
  });

  it('with maxSockets full of held mcp. connections a pinned node still connects (T16-cap)', async () => {
    const held = [];
    const mesh = [];
    const { l, port } = await start({
      limits: { maxSockets: 6, handshakeReserve: 2 },
      onMcpSocket: (s) => held.push(s),
      onMeshSocket: (s) => mesh.push(s)
    });
    const clients = [];
    for (let i = 0; i < 6; i++) {
      const c = tls.connect({ host: '127.0.0.1', port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
      c.on('error', () => {});
      clients.push(c);
      await new Promise((r) => { c.once('secureConnect', r); c.once('close', r); });
      await waitFor(() => held.length === Math.min(i + 1, 4) && l.sockets.size === Math.min(i + 1, 4));
    }
    assert.equal(held.length, 4, 'established mcp. sockets stop at maxSockets - handshakeReserve');
    const quiet = [quietClient(port), quietClient(port)];
    await waitFor(() => l.counted === 6);
    const node = tls.connect({ host: '127.0.0.1', port, servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key, rejectUnauthorized: false });
    node.on('error', () => {});
    await waitFor(() => mesh.length === 1);
    assert.equal(await quiet[0].gone, true, 'the oldest socket before its handshake made room');
    assert.ok(held.every((s) => !s.destroyed), 'no established mcp. socket was evicted');
    assert.equal(l.counted, l.sockets.size - 1, 'the pinned node no longer counts against maxSockets');
    for (const c of [...clients, ...quiet, node]) c.destroy();
    await waitFor(() => l.sockets.size === 0 && l.perIp.size === 0 && l.counted === 0 && l.openMcp === 0);
  });

  it('pinned mesh. sockets do not count against maxSockets but stay tracked, and stop() closes them', async () => {
    const mesh = [];
    const held = [];
    const { l, port } = await start({ limits: { maxSockets: 3, handshakeReserve: 1 }, onMeshSocket: (s) => mesh.push(s), onMcpSocket: (s) => held.push(s) });
    const clients = [];
    for (let i = 0; i < 4; i++) {
      const c = tls.connect({ host: '127.0.0.1', port, servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key, rejectUnauthorized: false });
      c.on('error', () => {});
      clients.push(c);
      await waitFor(() => mesh.length === i + 1);
    }
    for (let i = 0; i < 2; i++) {
      const c = tls.connect({ host: '127.0.0.1', port, servername: `mcp.${DOMAIN}`, rejectUnauthorized: false });
      c.on('error', () => {});
      clients.push(c);
      await waitFor(() => held.length === i + 1);
    }
    assert.equal(l.sockets.size, 6);
    assert.equal(l.perIp.get('127.0.0.1'), 6);
    assert.equal(l.counted, 2);
    listeners.pop();
    await l.stop();
    assert.ok(mesh.every((s) => s.destroyed));
    assert.equal(l.sockets.size, 0);
    assert.equal(l.counted, 0);
    for (const c of clients) c.destroy();
  });

  it('ipKey counts an IPv6 address by its /64 and a v4-mapped address as IPv4', () => {
    assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:0DB8:0001:0002:ffff::1'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipKey('2001:db8:1:3::1'), '2001:db8:1:3::/64', 'the next /64 is another key');
    assert.equal(ipKey('::1'), '0:0:0:0::/64');
    assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(ipKey('64:ff9b::192.0.2.7'), '64:ff9b:0:0::/64');
    assert.equal(ipKey('::ffff:192.0.2.7'), '192.0.2.7');
    assert.equal(ipKey('::FFFF:192.0.2.7'), '192.0.2.7');
    assert.equal(ipKey('192.0.2.7'), '192.0.2.7');
    assert.equal(ipKey(''), 'unknown');
    assert.equal(ipKey(undefined), 'unknown');
  });

  it('a v4-mapped peer on a dual-stack listener is counted as its IPv4 address', async (t) => {
    let started;
    try {
      started = await start({ host: '::' });
    } catch (err) {
      t.skip(`no dual-stack listener here: ${err.message}`);
      return;
    }
    const { l, port } = started;
    const q = quietClient(port);
    await waitFor(() => l.sockets.size === 1);
    const [entry] = l.sockets.values();
    if (!/^::ffff:/i.test(entry.address)) {
      q.destroy();
      t.skip(`the peer address is ${entry.address}, not v4-mapped`);
      return;
    }
    assert.deepEqual([...l.perIp.keys()], ['127.0.0.1']);
    q.destroy();
  });

  it('acme-tls/1 on mesh. or any other name never asks acmeChallenge', async () => {
    const asked = [];
    const { port } = await start({ acmeChallenge: (name) => { asked.push(name); return null; } });
    await connect(port, { servername: `mesh.${DOMAIN}`, ALPNProtocols: ['acme-tls/1'], cert: pinnedNode.cert, key: pinnedNode.key });
    await connect(port, { servername: `www.${DOMAIN}`, ALPNProtocols: ['acme-tls/1'] });
    await connect(port, { ALPNProtocols: ['acme-tls/1'] });
    assert.deepEqual(asked, []);
  });

  it('mesh. without a mesh context is closed before any handshake', async () => {
    const { l, seen, port } = await start({ meshContext: null });
    const r = await connect(port, { servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key });
    assert.equal(r.secure, false);
    assert.equal(seen.mesh.length, 0);
    assert.equal(seen.unknown.length, 0);
    await waitFor(() => l.sockets.size === 0);
  });

  it('a probe that keeps its side open after end() is dropped within about a second', async () => {
    const { l, port } = await start();
    const s = tls.connect({ host: '127.0.0.1', port, servername: `mesh.${DOMAIN}`, cert: probe.cert, key: probe.key, rejectUnauthorized: false, allowHalfOpen: true });
    s.on('error', () => {});
    s.on('data', () => {});
    s.on('end', () => {}); // half-open: never ends its own side
    await new Promise((r) => s.once('secureConnect', r));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(l.sockets.size, 1, 'still held open by the half-closed peer');
    await waitFor(() => l.sockets.size === 0, 2500);
    s.destroy();
  });

  it('every TLS wrap disables renegotiation', async (t) => {
    const calls = [];
    const original = tls.TLSSocket.prototype.disableRenegotiation;
    t.after(() => { tls.TLSSocket.prototype.disableRenegotiation = original; });
    tls.TLSSocket.prototype.disableRenegotiation = function () { calls.push(this); return original.call(this); };
    const held = [];
    const { port } = await start({ onMcpSocket: (s) => held.push(s) });
    const r = connect(port, { servername: `mcp.${DOMAIN}` });
    await waitFor(() => held.length === 1);
    assert.ok(calls.includes(held[0]), 'the handed-over socket had renegotiation disabled');
    held[0].destroy();
    await r;
  });

  it('start() twice is refused, and stop() during start() still closes the listener', async () => {
    const l = new SniListener({ host: '127.0.0.1', port: 0, domain: DOMAIN, mcpContext: () => null, meshContext: null, isPinnedNodeCert: () => false, isProbeCert: () => false, acmeChallenge: () => null, onMcpSocket() {}, onMeshSocket() {} });
    const starting = l.start();
    await assert.rejects(l.start(), /already started/);
    const stopping = l.stop();
    await starting;
    await stopping;
    assert.equal(l.address(), null);
    await l.start();
    await assert.rejects(l.start(), /already started/);
    await l.stop();
  });
});
