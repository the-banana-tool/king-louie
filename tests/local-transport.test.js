'use strict';

// The pinned transport (spec 2026-10-13-local-inference-design.md §5.2 rules
// 4 to 8, §5.4, §9.3). Every server here is on 127.0.0.1; nothing leaves the
// machine.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createLocalTransport, LocalTransportError } = require('../src/models/local-transport');
const { createCa, issueCert, selfSigned, fingerprint } = require('./helpers/test-certs');
const GroqProvider = require('../src/providers/groq-provider');
const { fixtureCatalog } = require('./helpers/models-fixture');

const cleanups = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (cleanups.length) await cleanups.pop()();
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startServer(handler, tlsOptions = null) {
  const requests = [];
  const sockets = new Set();
  const onRequest = (req, res) => {
    const chunks = [];
    const record = { method: req.method, url: req.url, headers: req.headers, body: null, closed: false };
    requests.push(record);
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      record.body = Buffer.concat(chunks).toString('utf8');
      handler(req, res, record);
    });
    res.on('close', () => { record.closed = true; });
  };
  const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listen(server);
  cleanups.push(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  }));
  return { port, requests, server, connections: () => sockets.size };
}

function transportFor(options) {
  const transport = createLocalTransport(options);
  cleanups.push(async () => transport.close());
  return transport;
}

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function rejection(promise) {
  let value;
  try {
    value = await promise;
  } catch (err) {
    return err;
  }
  assert.fail(`expected a rejection, got ${value && value.status}`);
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('local-transport', () => {
  it('a POST with a JSON body gets the server\'s JSON', async () => {
    const srv = await startServer((req, res, record) => json(res, { echo: JSON.parse(record.body), auth: req.headers.authorization }));
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const res = await transport.fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ model: 'qwen3:8b', n: 1 }),
    });
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { echo: { model: 'qwen3:8b', n: 1 }, auth: 'Bearer test-key' });
    assert.equal(srv.requests[0].method, 'POST');
    assert.equal(srv.requests[0].url, '/v1/chat/completions');
    assert.equal(srv.requests[0].headers['content-length'], String(Buffer.byteLength(JSON.stringify({ model: 'qwen3:8b', n: 1 }))));
  });

  it('a Buffer body, a Headers object and a URL object are accepted; an error status is a Response', async () => {
    const srv = await startServer((req, res, record) => json(res, { got: record.body, x: req.headers['x-test'] }, 500));
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const res = await transport.fetch(new URL(`${baseUrl}/v1/x`), { method: 'POST', headers: new Headers({ 'x-test': 'yes' }), body: Buffer.from('abc') });
    assert.equal(res.status, 500);
    assert.equal(res.ok, false);
    assert.deepEqual(await res.json(), { got: 'abc', x: 'yes' });
  });

  it('a streamed reply is read chunk by chunk from response.body', async () => {
    let step;
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'];
      let i = 0;
      step = () => {
        if (i < parts.length) res.write(parts[i++]);
        else res.end();
      };
      step();
    });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const res = await transport.fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const seen = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Each chunk arrives before the server has written the next one.
      seen.push(decoder.decode(value));
      step();
    }
    assert.deepEqual(seen, ['data: one\n\n', 'data: two\n\n', 'data: three\n\n']);
  });

  it('R-LI-5: only a pinned address is dialled', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://gpu-box.example.com:${srv.port}`;
    // The name is never resolved: any lookup would fail the call.
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const res = await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET', headers: { Host: 'evil.example.com' } });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(srv.requests[0].headers.host, `gpu-box.example.com:${srv.port}`);
  });

  it('R-LI-5: the pinned address is dialled even when the URL\'s host is another IP literal', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://192.168.1.50:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const res = await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(srv.requests[0].headers.host, `192.168.1.50:${srv.port}`);
  });

  it('R-LI-5: a socket on another address is destroyed', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://gpu-box.example.com:${srv.port}`;
    const dialled = [];
    const transport = transportFor({
      baseUrl,
      addresses: ['127.0.0.2'],
      // Test hook: stands in for whatever got between the request and the
      // pin. The transport asked for 127.0.0.2; the socket lands on .1.
      _connect: (options) => { dialled.push(options.host); return net.connect({ host: '127.0.0.1', port: options.port }); },
    });
    const err = await rejection(transport.fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{"prompt":"private text"}' }));
    assert.ok(err instanceof LocalTransportError);
    assert.equal(err.code, 'LOCAL_ADDRESS_MISMATCH');
    assert.deepEqual(dialled, ['127.0.0.2']);
    await tick(50);
    assert.equal(srv.requests.length, 0, 'the server received no request');
    assert.equal(srv.connections(), 0, 'the socket was destroyed');
  });

  it('R-LI-5: a 3xx is refused', async () => {
    const second = await startServer((_req, res) => json(res, { stolen: true }));
    const first = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${second.port}/v1/chat/completions` });
      res.end('moved');
    });
    const baseUrl = `http://127.0.0.1:${first.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    for (const status of [302]) {
      const err = await rejection(transport.fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{"a":1}' }));
      assert.equal(err.code, 'LOCAL_REDIRECT', String(status));
      assert.equal(err.status, 302);
      assert.ok(!err.message.includes('moved') && !err.message.includes(String(second.port)), 'no response text in the message');
    }
    await tick(50);
    assert.equal(second.requests.length, 0, 'the second server got nothing');
  });

  it('R-LI-5: every status from 300 to 399 is refused, with or without a Location', async () => {
    let status = 300;
    const srv = await startServer((_req, res) => { res.writeHead(status); res.end(); });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    for (status of [300, 301, 303, 304, 307, 308, 399]) {
      const err = await rejection(transport.fetch(`${baseUrl}/x`, { method: 'GET' }));
      assert.equal(err.code, 'LOCAL_REDIRECT', String(status));
    }
  });

  it('R-LI-5: a proxy in the environment is not used', async () => {
    const target = await startServer((_req, res) => json(res, { ok: true }));
    // A proxy that answers 502 to whatever reaches it, and counts.
    const proxied = [];
    const proxy = http.createServer((req, res) => { proxied.push(req.url); res.writeHead(502); res.end(); });
    proxy.on('connect', (req, socket) => { proxied.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    const proxyPort = await listen(proxy);
    cleanups.push(() => new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(no_proxy|http_proxy|https_proxy|all_proxy)$/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NODE_USE_ENV_PROXY: '1',
    });
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'local-transport-proxy.js'), String(target.port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout.trim().split('\n').pop());

    assert.equal(out.transport, 200, 'the transport reached the local server');
    // The same URL through node:http's global agent, in the same process: on
    // a Node that honours NODE_USE_ENV_PROXY it goes to the proxy (502). That
    // is what makes the 200 above mean something.
    const honoursEnvProxy = out.control === 502;
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 24) assert.equal(honoursEnvProxy, true, `control was ${out.control}; this Node should route its global agent through the proxy`);
    assert.equal(proxied.length, honoursEnvProxy ? 1 : 0, 'the proxy saw the control call and nothing from the transport');
    assert.equal(target.requests.length, honoursEnvProxy ? 1 : 2);
  });

  it('a URL on another origin, or with credentials, is refused before anything is dialled', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const other = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    for (const url of [
      `http://127.0.0.1:${other.port}/v1/models`,
      `https://127.0.0.1:${srv.port}/v1/models`,
      `http://localhost:${srv.port}/v1/models`,
      `http://gpu-box.example.com:${srv.port}/v1/models`,
      `http://user:pw@127.0.0.1:${srv.port}/v1/models`,
      `http://127.0.0.1:${srv.port}@gpu-box.example.com/v1/models`,
      '/v1/models',
      'not a url',
      '',
      null,
    ]) {
      const err = await rejection(transport.fetch(url, { method: 'GET' }));
      assert.equal(err.code, 'LOCAL_URL_OUTSIDE', String(url));
    }
    assert.equal(srv.requests.length, 0);
    assert.equal(other.requests.length, 0);
  });

  it('a body that is not a string or bytes is refused', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const err = await rejection(transport.fetch(`${baseUrl}/x`, { method: 'POST', body: { a: 1 } }));
    assert.equal(err.code, 'LOCAL_BODY_UNSUPPORTED');
    assert.equal(srv.requests.length, 0);
  });

  describe('https', () => {
    it('with the right fingerprint succeeds; with a wrong one LOCAL_TLS_MISMATCH and nothing is sent', async () => {
      const cert = selfSigned({ commonName: 'gpu-box.example.com' });
      const srv = await startServer((_req, res) => json(res, { ok: true }), { cert: cert.cert, key: cert.key });
      const baseUrl = `https://gpu-box.example.com:${srv.port}`;
      const good = transportFor({ baseUrl, addresses: ['127.0.0.1'], tlsFingerprint: fingerprint(cert.cert) });
      const res = await good.fetch(`${baseUrl}/v1/models`, { method: 'GET' });
      assert.deepEqual(await res.json(), { ok: true });
      const upper = transportFor({ baseUrl, addresses: ['127.0.0.1'], tlsFingerprint: fingerprint(cert.cert).toUpperCase() });
      assert.equal((await upper.fetch(`${baseUrl}/v1/models`, { method: 'GET' })).status, 200);
      assert.equal(srv.requests.length, 2);

      const bad = transportFor({ baseUrl, addresses: ['127.0.0.1'], tlsFingerprint: 'ab'.repeat(32) });
      const err = await rejection(bad.fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{"prompt":"private text"}' }));
      assert.ok(err instanceof LocalTransportError);
      assert.equal(err.code, 'LOCAL_TLS_MISMATCH');
      await tick(50);
      assert.equal(srv.requests.length, 2, 'the server received no request from the mismatched call');
    });

    it('with no fingerprint, a self-signed server is a TLS error that is not LOCAL_UNREACHABLE', async () => {
      const cert = selfSigned({ commonName: 'gpu-box.example.com' });
      const srv = await startServer((_req, res) => json(res, { ok: true }), { cert: cert.cert, key: cert.key });
      const baseUrl = `https://gpu-box.example.com:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
      const err = await rejection(transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' }));
      assert.notEqual(err.code, 'LOCAL_UNREACHABLE');
      assert.notEqual(err.code, 'LOCAL_TLS_MISMATCH');
      assert.match(String(err.code), /CERT|SIGNED|UNABLE/);
      assert.equal(srv.requests.length, 0);
    });

    it('with no fingerprint, the chain and the name the owner typed are verified, and SNI is that name', async () => {
      const ca = createCa();
      const leaf = issueCert(ca, { dnsNames: ['gpu-box.example.com'] });
      let sni = null;
      const srv = await startServer((req, res) => { sni = req.socket.servername; json(res, { ok: true }); }, { cert: leaf.cert, key: leaf.key });
      const baseUrl = `https://gpu-box.example.com:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'], _ca: ca.cert });
      const res = await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' });
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(sni, 'gpu-box.example.com');
      assert.equal(srv.requests[0].headers.host, `gpu-box.example.com:${srv.port}`);

      // The same certificate does not vouch for another name on the same address.
      const otherUrl = `https://workstation.example.com:${srv.port}`;
      const other = transportFor({ baseUrl: otherUrl, addresses: ['127.0.0.1'], _ca: ca.cert });
      const err = await rejection(other.fetch(`${otherUrl}/v1/models`, { method: 'GET' }));
      assert.equal(err.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
      assert.equal(srv.requests.length, 1);
    });
  });

  it('a connection is kept and used again, and a kept one the server closed is replaced once', async () => {
    let opened = 0;
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    srv.server.on('connection', () => { opened += 1; });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    for (let i = 0; i < 3; i += 1) {
      await (await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' })).text();
      await tick(10);
    }
    assert.equal(opened, 1);
    // The server drops the idle connection; the next call still succeeds.
    srv.server.closeAllConnections();
    const res = await transport.fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{"n":1}' });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(opened, 2);
    assert.equal(srv.requests.length, 4);
  });

  it('a closed port is LOCAL_UNREACHABLE, with the cause kept', async () => {
    const port = await closedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
    const err = await rejection(transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' }));
    assert.ok(err instanceof LocalTransportError);
    assert.equal(err.code, 'LOCAL_UNREACHABLE');
    assert.equal(err.cause.code, 'ECONNREFUSED');
  });

  it('a connect that does not finish in connectTimeoutMs is LOCAL_UNREACHABLE', async () => {
    const hung = [];
    const transport = transportFor({
      baseUrl: 'http://127.0.0.1:9',
      addresses: ['127.0.0.1'],
      connectTimeoutMs: 40,
      _connect: () => { const s = new net.Socket(); hung.push(s); return s; },
    });
    const err = await rejection(transport.fetch('http://127.0.0.1:9/v1/models', { method: 'GET' }));
    assert.equal(err.code, 'LOCAL_UNREACHABLE');
    assert.equal(err.cause.code, 'ETIMEDOUT');
    assert.equal(hung[0].destroyed, true);
  });

  it('when one pinned address does not answer, the next one is tried', async () => {
    const srv = await startServer((_req, res) => json(res, { ok: true }));
    const baseUrl = `http://workstation.example.com:${srv.port}`;
    const dialled = [];
    const transport = transportFor({
      baseUrl,
      addresses: ['10.0.0.9', '127.0.0.1'],
      _connect: (options) => {
        dialled.push(options.host);
        if (options.host === '10.0.0.9') {
          const s = new net.Socket();
          setImmediate(() => s.destroy(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })));
          return s;
        }
        return net.connect(options);
      },
    });
    assert.equal((await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' })).status, 200);
    assert.deepEqual(dialled, ['10.0.0.9', '127.0.0.1']);
  });

  describe('maxConcurrent', () => {
    it('the second call starts only after the first ends', async () => {
      const pending = [];
      const srv = await startServer((_req, res) => { pending.push(res); });
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'], maxConcurrent: 1 });
      const first = transport.fetch(`${baseUrl}/a`, { method: 'GET' });
      const second = transport.fetch(`${baseUrl}/b`, { method: 'GET' });
      await tick(80);
      assert.deepEqual(srv.requests.map((r) => r.url), ['/a']);
      pending[0].writeHead(200, { 'content-type': 'application/json' });
      pending[0].write('{"n":');
      const res1 = await first;
      // The reply has started but not ended: the slot is still held.
      await tick(80);
      assert.deepEqual(srv.requests.map((r) => r.url), ['/a']);
      pending[0].end('1}');
      assert.deepEqual(await res1.json(), { n: 1 });
      await tick(80);
      assert.deepEqual(srv.requests.map((r) => r.url), ['/a', '/b']);
      json(pending[1], { n: 2 });
      assert.deepEqual(await (await second).json(), { n: 2 });
    });

    it('aborting the queued call rejects it with the signal\'s reason and the server never sees it', async () => {
      const pending = [];
      const srv = await startServer((_req, res) => { pending.push(res); });
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'], maxConcurrent: 1 });
      const first = transport.fetch(`${baseUrl}/a`, { method: 'GET' });
      const controller = new AbortController();
      const second = transport.fetch(`${baseUrl}/b`, { method: 'GET', signal: controller.signal });
      const third = transport.fetch(`${baseUrl}/c`, { method: 'GET' });
      await tick(50);
      controller.abort('stopped by owner');
      assert.equal(await rejection(second), 'stopped by owner');
      json(pending[0], { n: 1 });
      await (await first).text();
      await tick(80);
      assert.deepEqual(srv.requests.map((r) => r.url), ['/a', '/c']);
      json(pending[1], { n: 3 });
      await (await third).text();
    });

    it('a signal that is already aborted never dials', async () => {
      const srv = await startServer((_req, res) => json(res, { ok: true }));
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
      const controller = new AbortController();
      controller.abort();
      const err = await rejection(transport.fetch(`${baseUrl}/a`, { method: 'GET', signal: controller.signal }));
      assert.equal(err, controller.signal.reason);
      assert.equal(err.name, 'AbortError');
      await tick(30);
      assert.equal(srv.requests.length, 0);
    });

    it('aborting before the reply rejects with the reason and ends the server\'s socket', async () => {
      const srv = await startServer(() => {});
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
      const controller = new AbortController();
      const call = transport.fetch(`${baseUrl}/a`, { method: 'POST', body: '{}', signal: controller.signal });
      await tick(60);
      assert.equal(srv.requests.length, 1);
      controller.abort();
      const err = await rejection(call);
      assert.equal(err.name, 'AbortError');
      await tick(60);
      assert.equal(srv.requests[0].closed, true);
      assert.equal(srv.connections(), 0);
    });

    it('aborting mid-stream ends the server\'s socket, fails the read and frees the slot', async () => {
      const srv = await startServer((req, res) => {
        if (req.url === '/next') return json(res, { ok: true });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        return undefined;
      });
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const transport = transportFor({ baseUrl, addresses: ['127.0.0.1'], maxConcurrent: 1 });
      const controller = new AbortController();
      const res = await transport.fetch(`${baseUrl}/stream`, { method: 'POST', body: '{}', signal: controller.signal });
      const reader = res.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), 'data: one\n\n');
      controller.abort();
      await assert.rejects(reader.read());
      await tick(60);
      assert.equal(srv.requests[0].closed, true);
      assert.equal(srv.connections(), 0);
      assert.equal((await transport.fetch(`${baseUrl}/next`, { method: 'GET' })).status, 200);
    });
  });

  it('close() refuses new calls and rejects the ones that wait', async () => {
    const pending = [];
    const srv = await startServer((_req, res) => { pending.push(res); });
    const baseUrl = `http://127.0.0.1:${srv.port}`;
    const transport = createLocalTransport({ baseUrl, addresses: ['127.0.0.1'], maxConcurrent: 1 });
    const first = transport.fetch(`${baseUrl}/a`, { method: 'GET' });
    const second = transport.fetch(`${baseUrl}/b`, { method: 'GET' });
    await tick(50);
    transport.close();
    assert.equal((await rejection(second)).code, 'LOCAL_TRANSPORT_CLOSED');
    assert.ok(await rejection(first));
    assert.equal((await rejection(transport.fetch(`${baseUrl}/c`, { method: 'GET' }))).code, 'LOCAL_TRANSPORT_CLOSED');
    await tick(30);
    assert.deepEqual(srv.requests.map((r) => r.url), ['/a']);
  });

  describe('what it will not be built for', () => {
    it('an address that is not loopback, LAN or 100.64.0.0/10', () => {
      for (const addresses of [
        ['203.0.113.9'], ['127.0.0.1', '198.51.100.7'], ['169.254.169.254'], ['0.0.0.0'], ['::'], ['fe80::1'],
        ['2001:db8::1'], ['::ffff:203.0.113.9'], ['64:ff9b::7f00:1'], ['workstation'], ['127.1'], [], [null], null, undefined, '127.0.0.1',
      ]) {
        assert.throws(() => createLocalTransport({ baseUrl: 'http://127.0.0.1:11434', addresses }), (err) => {
          assert.ok(err instanceof LocalTransportError, JSON.stringify(addresses));
          assert.equal(err.code, 'LOCAL_TRANSPORT_INVALID', JSON.stringify(addresses));
          return true;
        });
      }
    });

    it('a bad base URL, fingerprint or limit', () => {
      const ok = { baseUrl: 'http://127.0.0.1:11434', addresses: ['127.0.0.1'] };
      for (const patch of [
        { baseUrl: 'ftp://127.0.0.1' }, { baseUrl: 'http://user:pw@127.0.0.1' }, { baseUrl: 'http://127.0.0.1/?a=1' }, { baseUrl: null },
        { tlsFingerprint: 'abcd' }, { tlsFingerprint: 'AB:CD' }, { tlsFingerprint: true }, { tlsFingerprint: '' },
        { maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { maxConcurrent: '2' }, { connectTimeoutMs: 0 }, { connectTimeoutMs: -1 },
      ]) {
        assert.throws(() => createLocalTransport({ ...ok, ...patch }), (err) => err instanceof LocalTransportError && err.code === 'LOCAL_TRANSPORT_INVALID', JSON.stringify(patch));
      }
      assert.throws(() => createLocalTransport(), (err) => err.code === 'LOCAL_TRANSPORT_INVALID');
    });
  });

  describe('R-LI-30: what the transport says about itself', () => {
    const FP = 'cd'.repeat(32);
    const describeOf = (options) => {
      const t = createLocalTransport(options);
      t.close();
      return t;
    };

    it('grade is the transport\'s own reading of its address, protocol and certificate pin', () => {
      assert.equal(describeOf({ baseUrl: 'http://127.0.0.1:11434', addresses: ['127.0.0.1'] }).grade, 'guarantee');
      assert.equal(describeOf({ baseUrl: 'http://[::1]:11434', addresses: ['::1'] }).grade, 'guarantee');
      assert.equal(describeOf({ baseUrl: 'http://gpu-box.example.com:8000', addresses: ['192.168.1.50'] }).grade, 'cost-only');
      assert.equal(describeOf({ baseUrl: 'https://gpu-box.example.com:8000', addresses: ['192.168.1.50'] }).grade, 'cost-only');
      assert.equal(describeOf({ baseUrl: 'https://gpu-box.example.com:8000', addresses: ['192.168.1.50'], tlsFingerprint: FP }).grade, 'guarantee');
      assert.equal(describeOf({ baseUrl: 'http://gpu-box.example.com:8000', addresses: ['192.168.1.50'], tlsFingerprint: FP }).grade, 'cost-only');
      assert.equal(describeOf({ baseUrl: 'http://workstation.example.com:8000', addresses: ['127.0.0.1', '192.168.1.50'] }).grade, 'cost-only');
      assert.equal(describeOf({ baseUrl: 'https://gpu-box.example.com:8000', addresses: ['100.64.0.5'], tlsFingerprint: FP }).grade, 'guarantee');
      assert.equal(describeOf({ baseUrl: 'http://100.64.0.5:8000', addresses: ['100.64.0.5'] }).grade, 'cost-only');
    });

    it('the description is fixed when the transport is built', () => {
      const t = describeOf({ baseUrl: 'https://gpu-box.example.com:8000/', addresses: ['::ffff:192.168.1.50'], tlsFingerprint: FP.toUpperCase() });
      assert.equal(t.baseUrl, 'https://gpu-box.example.com:8000');
      assert.equal(t.protocol, 'https:');
      assert.deepEqual([...t.addresses], ['192.168.1.50']);
      assert.equal(t.addressClass, 'lan');
      assert.equal(t.tlsPinned, true);
      assert.ok(Object.isFrozen(t));
      assert.ok(Object.isFrozen(t.addresses));
      assert.throws(() => { 'use strict'; t.grade = 'guarantee'; }, TypeError);
      const plain = describeOf({ baseUrl: 'http://gpu-box.example.com:8000', addresses: ['192.168.1.50'], tlsFingerprint: FP });
      assert.equal(plain.tlsPinned, false, 'a fingerprint over http pins nothing');
    });
  });

  describe('BaseLLMProvider#request', () => {
    it('an instance with a transport calls it and not globalThis.fetch', async () => {
      const calls = { transport: [], global: [] };
      globalThis.fetch = async (url, init) => { calls.global.push({ url, init }); return new Response('{"from":"global"}'); };
      const p = new GroqProvider('test-key-123456');
      p.transport = { fetch: async (url, init) => { calls.transport.push({ url, init }); return new Response('{"from":"transport"}'); } };
      const controller = new AbortController();
      const res = await p.request('http://127.0.0.1:9/x', { method: 'POST', body: '{}' }, { abortSignal: controller.signal });
      assert.deepEqual(await res.json(), { from: 'transport' });
      assert.equal(calls.global.length, 0);
      assert.equal(calls.transport.length, 1);
      assert.equal(calls.transport[0].url, 'http://127.0.0.1:9/x');
      assert.equal(calls.transport[0].init.signal, controller.signal);
      assert.equal(calls.transport[0].init.method, 'POST');
    });

    it('an instance without one calls globalThis.fetch', async () => {
      const seen = [];
      globalThis.fetch = async (url) => { seen.push(url); return new Response('{}'); };
      const p = new GroqProvider('test-key-123456');
      await p.request('http://127.0.0.1:9/x', { method: 'GET' }, {});
      p.transport = {};
      await p.request('http://127.0.0.1:9/y', { method: 'GET' }, {});
      p.transport = null;
      await p.request('http://127.0.0.1:9/z', { method: 'GET' }, {});
      assert.deepEqual(seen, ['http://127.0.0.1:9/x', 'http://127.0.0.1:9/y', 'http://127.0.0.1:9/z']);
    });

    it('an aborted signal still yields an AbortError with partialLlmMetrics', async () => {
      globalThis.fetch = async () => { throw new Error('globalThis.fetch must not be called'); };
      const p = new GroqProvider('test-key-123456', { catalog: fixtureCatalog() });
      p.transport = { fetch: async (_url, init) => { throw init.signal.reason; } };
      const controller = new AbortController();
      controller.abort('stopped by owner');
      await assert.rejects(p.request('http://127.0.0.1:9/x', {}, { abortSignal: controller.signal, model: 'llama-3.3-70b' }), (err) => {
        assert.equal(err.name, 'AbortError');
        assert.match(err.message, /stopped by owner/);
        assert.equal(err.partialLlmMetrics.usagePartial, true);
        assert.equal(err.partialLlmMetrics.model, 'llama-3.3-70b');
        return true;
      });
    });

    it('a real transport under a provider: the abort reaches the local server', async () => {
      const srv = await startServer(() => {});
      const baseUrl = `http://127.0.0.1:${srv.port}`;
      const p = new GroqProvider('test-key-123456', { catalog: fixtureCatalog() });
      p.transport = transportFor({ baseUrl, addresses: ['127.0.0.1'] });
      const controller = new AbortController();
      const call = p.request(`${baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' }, { abortSignal: controller.signal, model: 'llama-3.3-70b' });
      await tick(60);
      controller.abort();
      const err = await rejection(call);
      assert.equal(err.name, 'AbortError');
      assert.equal(err.partialLlmMetrics.usagePartial, true);
      await tick(60);
      assert.equal(srv.connections(), 0);
    });
  });
});
