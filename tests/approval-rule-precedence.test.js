// A3 — a user-set `ask` or `deny` permission rule outranks any auto-approve
// list, including the one desktop agent mode used to hard-code.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const ToolExecutor = require('../src/execution/tool-executor');

toolRegistry.register(new Tool({
  name: 'PrecedenceTool',
  description: 'an approval-requiring tool with a pattern-matchable command',
  requiresApproval: true,
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async (params) => ({ ok: true, ran: params.command })
}));

// Records every approval prompt and answers "no", so a tool that reaches the
// gate is visibly gated rather than silently granted.
function gatedExecutor(options = {}) {
  const prompts = [];
  const autoGranted = [];
  const executor = new ToolExecutor({
    requireApproval: true,
    approvalRequester: async (toolName, params, metadata) => {
      prompts.push({ toolName, params, metadata });
      return false;
    },
    ...options
  });
  executor.on('approvalAutoGranted', (evt) => autoGranted.push(evt.source.type));
  return { executor, prompts, autoGranted };
}

describe('permission rules vs auto-approve lists (A3)', () => {
  it("an `ask` rule still prompts even when the tool is in options.autoApproveTools", async () => {
    const { executor, prompts, autoGranted } = gatedExecutor({
      permissionRules: [{ tool: 'PrecedenceTool', pattern: 'git *', action: 'ask', source: 'user' }]
    });

    const result = await executor.execute(
      'PrecedenceTool',
      { command: 'git push --force' },
      { autoApproveTools: ['PrecedenceTool'] }
    );

    assert.strictEqual(prompts.length, 1, 'the user asked to be asked');
    assert.deepStrictEqual(autoGranted, [], 'nothing may be auto-granted past an `ask` rule');
    assert.strictEqual(result.success, false);
  });

  it("an `ask` rule still prompts even when shouldAutoApprove says yes", async () => {
    let consulted = false;
    const { executor, prompts } = gatedExecutor({
      permissionRules: [{ tool: 'PrecedenceTool', pattern: '*', action: 'ask', source: 'user' }],
      shouldAutoApprove: async () => { consulted = true; return true; }
    });

    const result = await executor.execute('PrecedenceTool', { command: 'rm -rf build' });

    assert.strictEqual(consulted, false, 'the global always-approve list must not override an `ask` rule');
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(result.success, false);
  });

  it('a `deny` rule still denies when the tool is in options.autoApproveTools', async () => {
    const { executor } = gatedExecutor({
      permissionRules: [{ tool: 'PrecedenceTool', pattern: 'rm *', action: 'deny', source: 'user' }]
    });

    const result = await executor.execute(
      'PrecedenceTool',
      { command: 'rm -rf /' },
      { autoApproveTools: ['PrecedenceTool'] }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.deniedBy, 'rule');
  });

  it('auto-approve still works when the user has written no rule for the tool', async () => {
    const { executor, autoGranted } = gatedExecutor({
      permissionRules: [{ tool: 'SomeOtherTool', pattern: '*', action: 'ask', source: 'user' }]
    });

    const result = await executor.execute(
      'PrecedenceTool',
      { command: 'git status' },
      { autoApproveTools: ['PrecedenceTool'] }
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(autoGranted, ['agent-config']);
  });

  it('desktop agent mode does not hard-code an auto-approve list', () => {
    // src/ipc/chat-handlers.js used to pass
    // autoApproveTools: ['Bash','Read','Edit','Write','Glob','Grep','Git']
    // into every agent-mode turn, which made the entire `ask` tier inert for
    // the seven most dangerous tools and meant the approval dialog the README
    // advertises never appeared. Trusted-workspace behaviour belongs in an
    // explicit, persisted setting, not a hidden constant.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'chat-handlers.js'), 'utf8');
    assert.doesNotMatch(source, /autoApproveTools\s*:/, 'chat-handlers.js must not set autoApproveTools');
  });
});
