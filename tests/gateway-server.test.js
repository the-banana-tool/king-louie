const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const GatewayServer = require('../src/gateway/gateway-server');

let server;
afterEach(async () => { if (server) await server.stop(); server = null; });

function connect(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => resolve('error'));
  });
}

describe('GatewayServer auth', () => {
  it('refuses to start without a token or on a non-loopback host', async () => {
    await assert.rejects(new GatewayServer({ port: 0 }).start(), /requires an authToken/);
    await assert.rejects(new GatewayServer({ port: 0, host: '0.0.0.0', authToken: 't' }).start(), /only binds to loopback/);
  });

  it('accepts the right bearer token and rejects everything else', async () => {
    server = new GatewayServer({ port: 0, authToken: 'secret-token' });
    await server.start();
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token' }), 'open');
    assert.strictEqual(await connect(server.port, {}), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer wrong' }), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token', Origin: 'https://evil.example' }), 403);
  });
});
