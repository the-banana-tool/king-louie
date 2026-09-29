const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const MCPClient = require('../src/mcp/mcp-client');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'mcp');

function fixtureClient(env = {}) {
  return new MCPClient({
    name: 'line-stdio',
    command: 'node',
    args: ['line-stdio-server.js'],
    cwd: FIXTURE_DIR,
    env,
    timeoutMs: 5000
  });
}

describe('MCPClient stdio framing', () => {
  let client;

  afterEach(async () => {
    await client?.disconnect();
    client = null;
  });

  it('connects to a server that reads one JSON message per line', async () => {
    client = fixtureClient();
    await client.connect();

    assert.strictEqual(client.connected, true);
    assert.deepStrictEqual(client.tools.map((t) => t.name), ['dropped_lines']);
  });

  it('sends no Content-Length headers or other non-JSON lines', async () => {
    client = fixtureClient();
    await client.connect();

    const result = await client.callTool('dropped_lines');
    assert.deepStrictEqual(result, { ok: true, result: '0' });
  });

  it('still reads replies framed with Content-Length headers', async () => {
    client = fixtureClient({ REPLY_FRAMING: 'content-length' });
    await client.connect();

    const result = await client.callTool('dropped_lines');
    assert.deepStrictEqual(result, { ok: true, result: '0' });
  });
});
