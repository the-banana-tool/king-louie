const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
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

function open(port, token = 't') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('error', () => {});
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`handshake ${res.statusCode}`)));
  });
}

// A hand-written handshake: the `ws` client (and Node's http client) will not
// emit a header with an empty value, and that is exactly the case under test.
function rawHandshake(port, extraHeaders = []) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET / HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
        + extraHeaders.map((h) => `${h}\r\n`).join('')
        + '\r\n'
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/^HTTP\/1\.1 (\d{3})/);
      if (match) { socket.destroy(); resolve(Number(match[1])); }
    });
    socket.on('error', () => resolve('error'));
    socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout'); });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GatewayServer auth', () => {
  it('refuses to start without a token or on a non-loopback host', async () => {
    await assert.rejects(new GatewayServer({ port: 0 }).start(), /requires an authToken/);
    await assert.rejects(new GatewayServer({ port: 0, host: '0.0.0.0', authToken: 't' }).start(), /only binds to loopback/);
  });

  it("accepts only literal loopback addresses, not 'localhost' (resolver-dependent)", async () => {
    await assert.rejects(new GatewayServer({ port: 0, host: 'localhost', authToken: 't' }).start(), /only binds to loopback/);
    server = new GatewayServer({ port: 0, host: '127.0.0.1', authToken: 't' });
    await server.start();
    assert.ok(server.port > 0);
  });

  it('rejects start() on a taken port and forgets the dead listener', async () => {
    server = new GatewayServer({ port: 0, authToken: 't' });
    await server.start();
    const second = new GatewayServer({ port: server.port, authToken: 't' });
    await assert.rejects(second.start(), /EADDRINUSE/);
    assert.strictEqual(second.wss, null);
    await second.stop();
  });

  it('accepts the right bearer token and rejects everything else', async () => {
    server = new GatewayServer({ port: 0, authToken: 'secret-token' });
    await server.start();
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token' }), 'open');
    assert.strictEqual(await connect(server.port, {}), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer wrong' }), 401);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer secret-token', Origin: 'https://evil.example' }), 403);
  });

  it('rejects an empty Origin header instead of letting it fall through the check', async () => {
    server = new GatewayServer({ port: 0, authToken: 't' });
    await server.start();
    assert.strictEqual(await rawHandshake(server.port, ['Origin:', 'Authorization: Bearer t']), 403);
    assert.strictEqual(await rawHandshake(server.port, ['Origin:    ', 'Authorization: Bearer t']), 403);
    assert.strictEqual(await rawHandshake(server.port, ['Authorization: Bearer t']), 101);
  });

  it('caps the number of concurrent connections', async () => {
    server = new GatewayServer({ port: 0, authToken: 't', maxConnections: 2 });
    await server.start();
    const a = await open(server.port);
    const b = await open(server.port);
    assert.strictEqual(server.connections.size, 2);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer t' }), 503);
    // An unauthenticated peer is turned away by the token check, so it cannot
    // probe the cap or flood the log with refusals.
    assert.strictEqual(await connect(server.port, {}), 401);
    a.close();
    b.close();
  });
});

describe('GatewayServer resilience', () => {
  it('survives a malformed frame from an authenticated client', async () => {
    server = new GatewayServer({ port: 0, authToken: 't' });
    await server.start();

    const ws = await open(server.port);
    // FIN=0 with the reserved bits set: `ws` raises an 'error' on the server
    // socket, which with no listener takes the whole process down.
    ws._socket.write(Buffer.from([0x70, 0x00]));
    await sleep(250);

    assert.strictEqual(server.connections.size, 0, 'the broken connection should be dropped');
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer t' }), 'open');
  });

  it('survives a frame header that declares an oversized payload', async () => {
    server = new GatewayServer({ port: 0, authToken: 't' });
    await server.start();

    const ws = await open(server.port);
    // Masked binary frame claiming a 2^32-byte payload; no data follows.
    const header = Buffer.from([0x82, 0xff, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4]);
    ws._socket.write(header);
    await sleep(250);

    assert.strictEqual(server.connections.size, 0);
    assert.strictEqual(await connect(server.port, { Authorization: 'Bearer t' }), 'open');
  });

  it('writes the token file only once the listener is bound, and removes it on stop', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gwfile-'));
    const tokenFile = path.join(dataDir, 'gateway-token');

    // A port that is already taken: start() must leave no bearer token behind.
    const holder = new GatewayServer({ port: 0, authToken: 't' });
    await holder.start();
    const dead = new GatewayServer({ port: holder.port, authToken: 'secret', tokenFileDir: dataDir });
    await assert.rejects(dead.start(), /EADDRINUSE/);
    assert.strictEqual(fs.existsSync(tokenFile), false, 'a failed bind must not leave a valid token on disk');
    await holder.stop();

    server = new GatewayServer({ port: 0, authToken: 'secret', tokenFileDir: dataDir });
    await server.start();
    assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'secret');

    await server.stop();
    server = null;
    assert.strictEqual(fs.existsSync(tokenFile), false, 'the token should not outlive the listener');
  });

  it('bounds the frame size a single client may claim', async () => {
    server = new GatewayServer({ port: 0, authToken: 't' });
    await server.start();
    assert.ok(server.wss.options.maxPayload <= 4 * 1024 * 1024, `maxPayload is ${server.wss.options.maxPayload}`);
  });
});
