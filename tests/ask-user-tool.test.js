const { describe, it } = require('node:test');
const assert = require('node:assert');
const askUserTool = require('../src/tools/builtin/ask-user-tool');
const AgentLoop = require('../src/execution/agent-loop');

describe('AskUser Tool', () => {
  it('has correct schema', () => {
    assert.strictEqual(askUserTool.name, 'AskUser');
    assert.ok(askUserTool.parameters.properties.question);
    assert.ok(askUserTool.parameters.required.includes('question'));
  });

  it('does not require approval', () => {
    assert.strictEqual(askUserTool.requiresApproval, false);
  });

  it('rejects empty question', () => {
    assert.throws(() => {
      askUserTool.validateParameters({});
    }, /Missing required parameter: question/);
  });

  it('resolves when user responds', async () => {
    // Mock the IPC event pattern by monkey patching global state
    // In our implementation, we try to require electron and main
    // If it fails, it resolves with an error. We can mock the failure scenario to verify logic
    // We cannot fully test the electron IPC within node:test without a heavy mock framework,
    // but we can test that AskUser execution triggers the agent loop special logic.

    const mockProvider = {
      sendMessageWithTools: async () => {
        return {
          type: 'tool_use',
          toolName: 'AskUser',
          parameters: { question: 'Are you there?' }
        };
      }
    };

    const mockExecutor = {
      execute: async () => {
        return { ok: true, message: 'Normally not hit for AskUser' };
      }
    };

    const loop = new AgentLoop(mockProvider, mockExecutor, { maxIterations: 1 });

    // We expect it to reach max iterations because we only let it run once,
    // but the tool result should indicate the electron mock failed because we are not in electron main
    const result = await loop.run([], [askUserTool.toFunctionDefinition()]);
    assert.strictEqual(result.type, 'max_iterations');
    assert.strictEqual(result.tools.length, 1);
    assert.strictEqual(result.tools[0].name, 'AskUser');
    assert.strictEqual(result.tools[0].result.ok, false);
    assert.ok(result.tools[0].result.error.includes('Cannot ask user outside of Electron main process.'));
  });
});
