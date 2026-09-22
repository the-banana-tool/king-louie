const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebhookServer = require('../src/webhooks/webhook-server');

function request(port, { method = 'GET', path = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('WebhookServer hardening', () => {
  const server = new WebhookServer({ port: 0 }, { handle: async () => ({ ok: true }) });
  before(() => server.start());
  after(() => server.stop());

  it('serves health without CORS headers', async () => {
    const r = await request(server.port);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  });
  it('rejects browser-originated requests', async () => {
    assert.strictEqual((await request(server.port, { headers: { Origin: 'https://evil.example' } })).status, 403);
  });
  it('rejects an empty Origin header too, rather than letting it fall through', async () => {
    // Node's http client drops a header with an empty value, so this one is
    // written by hand.
    const status = await new Promise((resolve, reject) => {
      const socket = require('net').connect(server.port, '127.0.0.1', () => {
        socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin:\r\nConnection: close\r\n\r\n`);
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/^HTTP\/1\.1 (\d{3})/);
        if (match) { socket.destroy(); resolve(Number(match[1])); }
      });
      socket.on('error', reject);
    });
    assert.strictEqual(status, 403);
  });
  it('rejects preflight', async () => {
    assert.strictEqual((await request(server.port, { method: 'OPTIONS' })).status, 405);
  });

  // A browser `fetch(url, { mode: 'no-cors' })` GET sends no Origin, so the
  // Origin check never sees it, yet the page learns from the resolved promise
  // that something is listening on that port. Every browser that can make the
  // request also sends Sec-Fetch-Site and Sec-Fetch-Dest, and no non-browser
  // client does.
  it('rejects a no-cors GET, so /health is not a port-existence oracle', async () => {
    const r = await request(server.port, {
      headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty' }
    });
    assert.strictEqual(r.status, 403);
  });

  it('rejects a cross-site browser subresource load with no Origin', async () => {
    const r = await request(server.port, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
    });
    assert.strictEqual(r.status, 403);
  });

  it('rejects a browser navigation to /health, however it was started', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const r = await request(server.port, {
        headers: { 'Sec-FETCH-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' }
      });
      assert.strictEqual(r.status, 403, `Sec-Fetch-Site: ${site} must be refused`);
    }
  });

  it('rejects a cross-site browser POST to a webhook endpoint', async () => {
    const r = await request(server.port, {
      method: 'POST',
      path: '/webhooks/abc123',
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }
    });
    assert.strictEqual(r.status, 403);
  });

  it('still answers an ordinary client that sends no fetch metadata', async () => {
    assert.strictEqual((await request(server.port)).status, 200);
  });

  // undici — Node's global fetch, and the same engine in Deno and Bun — always
  // sends `sec-fetch-mode: cors` and never sends Sec-Fetch-Site or
  // Sec-Fetch-Dest. Keying the refusal on "any Sec-Fetch-* header" therefore
  // 403'd the most obvious modern client, for /health and for real webhook
  // deliveries alike.
  it('answers /health for Node\'s own fetch', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).status, 'ok');
  });

  it('accepts a real webhook POST from Node\'s own fetch', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/webhooks/abc123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true });
  });

  it('refuses Node\'s fetch once it is given a browser Origin', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { Origin: 'https://example.invalid' }
    });
    assert.strictEqual(r.status, 403);
  });
});

describe('WebhookServer port', () => {
  it('defaults to the gateway port + 1', () => {
    assert.strictEqual(new WebhookServer({ port: 18789 }, {}).port, 18790);
  });
  it('uses an explicit port when given', () => {
    assert.strictEqual(new WebhookServer({ port: 18791 }, {}, { port: 18792 }).port, 18792);
  });
  it('rejects start() (instead of throwing an uncaught error) when the port is taken', async () => {
    const holder = http.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const busy = holder.address().port;
      const server = new WebhookServer({ port: 18789 }, {}, { port: busy });
      await assert.rejects(server.start(), /EADDRINUSE/);
      assert.strictEqual(server.httpServer, null);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
