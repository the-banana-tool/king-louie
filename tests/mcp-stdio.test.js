const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const StdioMcpServer = require('../src/mcp/stdio-server');
const { RunbookEngine } = require('../src/runbooks/runbook-engine');

describe('Local Stdio MCP Server', () => {
  it('handles JSON-RPC initialize and tools/list requests', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const server = new StdioMcpServer({
      nodeConfig: { name: 'gpu-box', profile: 'agent', capabilities: ['gpu'] },
      stdin,
      stdout
    });

    server.start();

    const responses = [];
    stdout.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    // Send initialize
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, 'king-louie');

    // Send tools/list
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses[1].id, 2);
    const tools = responses[1].result.tools;
    assert.ok(tools.some((t) => t.name === 'list_machines'));
    assert.ok(tools.some((t) => t.name === 'run_runbook'));
    assert.ok(tools.some((t) => t.name === 'describe_machine'));
  });

  it('executes list_machines, describe_machine and get_state tool calls', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const server = new StdioMcpServer({
      nodeConfig: { name: 'gpu-box', profile: 'agent', capabilities: ['gpu'], policy: { allowed_roots: ['/srv'] } },
      stdin,
      stdout
    });

    server.start();

    const responses = [];
    stdout.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    // Call list_machines
    stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'list_machines', arguments: {} }
    }) + '\n');

    // Call describe_machine
    stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'describe_machine', arguments: { machine: 'gpu-box' } }
    }) + '\n');

    await new Promise((r) => setTimeout(r, 40));

    const res1 = JSON.parse(responses[0].result.content[0].text);
    assert.equal(res1[0].name, 'gpu-box');

    const res2 = JSON.parse(responses[1].result.content[0].text);
    assert.equal(res2.name, 'gpu-box');
    assert.deepEqual(res2.capabilities, ['gpu']);
  });

  it('handles run_runbook tool call and enforces tier approval for unsafe runbooks', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const engine = new RunbookEngine();
    engine.runbooks.set('safe.echo', { name: 'safe.echo', tier: 'routine', params: {} });
    engine.runbooks.set('server.reboot', { name: 'server.reboot', tier: 'unsafe', params: {} });

    const server = new StdioMcpServer({
      nodeConfig: { name: 'web-01', profile: 'runbook', capabilities: [] },
      runbookEngine: engine,
      stdin,
      stdout
    });

    server.start();

    const responses = [];
    stdout.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    // Call unsafe runbook
    stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'server.reboot' } }
    }) + '\n');

    await new Promise((r) => setTimeout(r, 40));

    const resUnsafe = JSON.parse(responses[0].result.content[0].text);
    assert.equal(resUnsafe.status, 'awaiting_approval');
    assert.ok(resUnsafe.job_id);
  });
});
