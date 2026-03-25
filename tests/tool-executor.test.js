const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// We need to set up the tool registry before importing ToolExecutor
// because ToolExecutor imports toolRegistry at module level.
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');

// Register minimal test tools
toolRegistry.register(new Tool({
  name: 'TestTool',
  description: 'A tool for testing',
  requiresApproval: false,
  parameters: { type: 'object', properties: { input: { type: 'string' } } },
  execute: async (params) => ({ ok: true, output: `processed: ${params.input}` })
}));

toolRegistry.register(new Tool({
  name: 'DangerousTool',
  description: 'A dangerous tool',
  requiresApproval: true,
  parameters: { type: 'object', properties: { force: { type: 'boolean' } } },
  dangerousPatterns: [/"force":true/],
  execute: async () => ({ ok: true, output: 'dangerous done' })
}));

toolRegistry.register(new Tool({
  name: 'FailingTool',
  description: 'A tool that throws',
  requiresApproval: false,
  parameters: { type: 'object', properties: {} },
  execute: async () => { throw new Error('tool internal failure'); }
}));

toolRegistry.register(new Tool({
  name: 'SlowTool',
  description: 'A slow tool',
  requiresApproval: false,
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { ok: true, output: 'eventually done' };
  }
}));

toolRegistry.register(new Tool({
  name: 'RequiredParamTool',
  description: 'A tool with required parameters',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      path: { type: 'string' }
    },
    required: ['content', 'path']
  },
  execute: async (params) => ({ ok: true, output: `wrote: ${params.content} to ${params.path}` })
}));

toolRegistry.register(new Tool({
  name: 'TypeCheckTool',
  description: 'A tool with typed parameters',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      label: { type: 'string' }
    },
    required: ['count']
  },
  execute: async (params) => ({ ok: true, count: params.count })
}));

const ToolExecutor = require('../src/execution/tool-executor');

describe('ToolExecutor', () => {
  describe('basic execution', () => {
    it('executes a registered tool and returns the result', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('TestTool', { input: 'hello' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.output, 'processed: hello');
    });

    it('throws for unknown tool names', async () => {
      const executor = new ToolExecutor({ requireApproval: false });

      await assert.rejects(
        () => executor.execute('NonExistentTool', {}),
        /Tool not found: NonExistentTool/
      );
    });
  });

  describe('error handling', () => {
    it('wraps tool execution errors into error result instead of throwing', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('FailingTool', {});

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'tool internal failure');
    });

    it('emits toolError event when tool throws', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const errors = [];
      executor.on('toolError', (evt) => errors.push(evt));

      await executor.execute('FailingTool', {});

      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].toolName, 'FailingTool');
      assert.ok(errors[0].error instanceof Error);
      assert.strictEqual(errors[0].error.message, 'tool internal failure');
    });

    it('emits postExecute even when tool throws', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const events = [];
      executor.on('postExecute', (evt) => events.push(evt));

      await executor.execute('FailingTool', {});

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].toolName, 'FailingTool');
      assert.strictEqual(events[0].result.success, false);
    });
  });

  describe('events', () => {
    it('emits preExecute before running and postExecute after', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const timeline = [];

      executor.on('preExecute', ({ toolName }) => timeline.push(`pre:${toolName}`));
      executor.on('postExecute', ({ toolName }) => timeline.push(`post:${toolName}`));

      await executor.execute('TestTool', { input: 'test' });

      assert.deepStrictEqual(timeline, ['pre:TestTool', 'post:TestTool']);
    });

    it('postExecute includes the tool result', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      let capturedResult = null;
      executor.on('postExecute', ({ result }) => { capturedResult = result; });

      await executor.execute('TestTool', { input: 'check' });

      assert.deepStrictEqual(capturedResult, { ok: true, output: 'processed: check' });
    });
  });

  describe('approval flow', () => {
    it('denies execution when approval is required but no approver is set', async () => {
      const executor = new ToolExecutor({ requireApproval: true });
      const result = await executor.execute('DangerousTool', {});

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('denied'));
    });

    it('allows execution when approvalRequester returns true', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => true
      });
      const result = await executor.execute('DangerousTool', {});

      assert.strictEqual(result.ok, true);
    });

    it('denies execution when approvalRequester returns false', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => false
      });
      const result = await executor.execute('DangerousTool', {});

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('denied'));
    });

    it('auto-approves when shouldAutoApprove returns true', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        shouldAutoApprove: async () => true
      });
      const events = [];
      executor.on('approvalAutoGranted', (evt) => events.push(evt));

      const result = await executor.execute('DangerousTool', {});

      assert.strictEqual(result.ok, true);
      assert.strictEqual(events.length, 1);
    });

    it('auto-approves tools listed in autoApproveTools option', async () => {
      const executor = new ToolExecutor({ requireApproval: true });
      const result = await executor.execute('DangerousTool', {}, {
        autoApproveTools: ['DangerousTool']
      });

      assert.strictEqual(result.ok, true);
    });

    it('skips approval for tools that do not require it', async () => {
      const approvalCalled = [];
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async (name) => { approvalCalled.push(name); return true; }
      });

      await executor.execute('TestTool', { input: 'no approval needed' });

      assert.strictEqual(approvalCalled.length, 0);
    });
  });

  describe('dangerous tool protection', () => {
    it('throws for dangerous parameters when bypassSafety is not set', async () => {
      const executor = new ToolExecutor({ requireApproval: false });

      await assert.rejects(
        () => executor.execute('DangerousTool', { force: true }),
        /Dangerous operation detected/
      );
    });

    it('allows dangerous parameters with bypassSafety flag', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => true
      });
      const result = await executor.execute('DangerousTool', { force: true }, { bypassSafety: true });

      assert.strictEqual(result.ok, true);
    });
  });

  describe('parameter validation (graceful failure)', () => {
    it('returns error result instead of throwing when required param is missing', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('RequiredParamTool', { content: 'hello' }); // missing 'path'

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Missing required parameter: path'));
    });

    it('returns error result when all required params are missing', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('RequiredParamTool', {});

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Missing required parameter'));
    });

    it('returns error result when parameter has wrong type', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('TypeCheckTool', { count: 'not-a-number' });

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Invalid type'));
    });

    it('emits postExecute with error result on validation failure', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const events = [];
      executor.on('postExecute', (evt) => events.push(evt));

      await executor.execute('RequiredParamTool', { content: 'hello' }); // missing 'path'

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].toolName, 'RequiredParamTool');
      assert.strictEqual(events[0].result.success, false);
      assert.ok(events[0].result.error.includes('Missing required parameter'));
    });

    it('emits preExecute before validation failure', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const timeline = [];
      executor.on('preExecute', ({ toolName }) => timeline.push(`pre:${toolName}`));
      executor.on('postExecute', ({ toolName }) => timeline.push(`post:${toolName}`));

      await executor.execute('RequiredParamTool', {}); // will fail validation

      assert.deepStrictEqual(timeline, ['pre:RequiredParamTool', 'post:RequiredParamTool']);
    });

    it('does not call tool.execute when validation fails', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      // If execute were called with missing params it would still work since
      // our test tool doesn't care, but we can verify via the result shape
      const result = await executor.execute('RequiredParamTool', { path: '/tmp/x' }); // missing 'content'

      assert.strictEqual(result.success, false);
      assert.ok(!result.ok, 'should not have ok:true from the tool execute');
    });

    it('succeeds when all required params are provided', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const result = await executor.execute('RequiredParamTool', { content: 'hello', path: '/tmp/x' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.output, 'wrote: hello to /tmp/x');
    });
  });

  describe('hook integration', () => {
    it('blocks execution when pre-hook returns deny', async () => {
      const executor = new ToolExecutor({
        requireApproval: false,
        hookExecutor: {
          run: async (event) => {
            if (event === 'PreToolUse') {
              return { action: 'deny', message: 'Policy violation' };
            }
            return { action: 'allow' };
          }
        }
      });
      const result = await executor.execute('TestTool', { input: 'blocked' });

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Policy violation'));
      assert.strictEqual(result.blockedByHook, true);
    });

    it('modifies parameters when pre-hook provides new parameters', async () => {
      const executor = new ToolExecutor({
        requireApproval: false,
        hookExecutor: {
          run: async (event) => {
            if (event === 'PreToolUse') {
              return { action: 'allow', context: { parameters: { input: 'modified' } } };
            }
            return { action: 'allow' };
          }
        }
      });
      const result = await executor.execute('TestTool', { input: 'original' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.output, 'processed: modified');
    });

    it('allows post-hook to override the result', async () => {
      const executor = new ToolExecutor({
        requireApproval: false,
        hookExecutor: {
          run: async (event) => {
            if (event === 'PostToolUse') {
              return { context: { result: { ok: true, output: 'hook-overridden' } } };
            }
            return { action: 'allow' };
          }
        }
      });
      const result = await executor.execute('TestTool', { input: 'test' });

      assert.strictEqual(result.output, 'hook-overridden');
    });
  });
});
