const { test } = require('node:test');
const assert = require('node:assert');
const ToolSearchTool = require('../src/tools/builtin/tool-search-tool');

function makeAssembler(deferredTools = []) {
  return {
    getAllDeferredTools: () => deferredTools,
    getToolsByName: (names) => deferredTools.filter((t) => names.includes(t.name))
  };
}

test('ToolSearch keyword mode excludes mcp__<disabled>__* tools', async () => {
  const assembler = makeAssembler([
    { name: 'mcp__github__create_issue', description: 'create github issue' },
    { name: 'mcp__sqlite__create_table', description: 'create sqlite table' },
    { name: 'Bash', description: 'run a shell command' }
  ]);

  const result = await ToolSearchTool.execute(
    { query: 'create' },
    { contextAssembler: assembler, disabledMcpServers: ['github'] }
  );

  assert.strictEqual(result.ok, true);
  const names = result.tools || [];
  assert.ok(!names.includes('mcp__github__create_issue'), 'disabled github tool should be hidden');
  assert.ok(names.includes('mcp__sqlite__create_table'), 'enabled sqlite tool should be visible');
});

test('ToolSearch select: mode excludes disabled mcp tools', async () => {
  const assembler = makeAssembler([
    { name: 'mcp__github__create_issue', description: '' },
    { name: 'mcp__sqlite__query', description: '' }
  ]);

  const result = await ToolSearchTool.execute(
    { query: 'select:mcp__github__create_issue,mcp__sqlite__query' },
    { contextAssembler: assembler, disabledMcpServers: ['github'] }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.tools, ['mcp__sqlite__query']);
});

test('ToolSearch with no disabled list returns all tools', async () => {
  const assembler = makeAssembler([
    { name: 'mcp__github__create_issue', description: 'create issue' }
  ]);

  const result = await ToolSearchTool.execute(
    { query: 'create' },
    { contextAssembler: assembler }
  );

  assert.strictEqual(result.ok, true);
  assert.ok((result.tools || []).includes('mcp__github__create_issue'));
});

test('ToolSearch leaves non-MCP tools untouched even when MCP servers disabled', async () => {
  const assembler = makeAssembler([
    { name: 'Bash', description: 'shell' },
    { name: 'mcp__github__x', description: 'github' }
  ]);

  const result = await ToolSearchTool.execute(
    { query: 'select:Bash' },
    { contextAssembler: assembler, disabledMcpServers: ['github'] }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.tools, ['Bash']);
});

test('ToolSearch handles tools with double-underscores in their names correctly', async () => {
  // A tool like mcp__my_server__tool_name shouldn't match server 'my' — must split on __
  const assembler = makeAssembler([
    { name: 'mcp__my_server__tool_name', description: '' }
  ]);

  // Disabling 'my' should NOT match — the server is 'my_server'
  const result = await ToolSearchTool.execute(
    { query: 'select:mcp__my_server__tool_name' },
    { contextAssembler: assembler, disabledMcpServers: ['my'] }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.tools, ['mcp__my_server__tool_name']);

  // But disabling 'my_server' SHOULD match
  const result2 = await ToolSearchTool.execute(
    { query: 'select:mcp__my_server__tool_name' },
    { contextAssembler: assembler, disabledMcpServers: ['my_server'] }
  );

  assert.strictEqual(result2.ok, false);
});
