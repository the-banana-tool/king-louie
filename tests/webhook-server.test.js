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
  it('rejects preflight', async () => {
    assert.strictEqual((await request(server.port, { method: 'OPTIONS' })).status, 405);
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
