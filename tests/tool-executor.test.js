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

    it('modifies parameters when pre-hook returns action=modify', async () => {
      const executor = new ToolExecutor({
        requireApproval: false,
        hookExecutor: {
          run: async (event) => {
            if (event === 'PreToolUse') {
              return { action: 'modify', context: { parameters: { input: 'modified' } } };
            }
            return { action: 'allow' };
          }
        }
      });
      const result = await executor.execute('TestTool', { input: 'original' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.output, 'processed: modified');
    });

    it('does NOT pass hook-decorated params to tool when action is allow (backfill pattern)', async () => {
      const executor = new ToolExecutor({
        requireApproval: false,
        hookExecutor: {
          run: async (event) => {
            if (event === 'PreToolUse') {
              return { action: 'allow', context: { parameters: { input: 'decorated' } } };
            }
            return { action: 'allow' };
          }
        }
      });
      const result = await executor.execute('TestTool', { input: 'original' });
      assert.strictEqual(result.output, 'processed: original');
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

  describe('pattern-based permission rules', () => {
    // Register a tool whose key field is `command` so the rules engine
    // can pattern-match against it.
    toolRegistry.register(new Tool({
      name: 'Bash',
      description: 'shell',
      requiresApproval: true,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async (params) => ({ ok: true, ran: params.command })
    }));

    it('allow rule short-circuits the approval prompt', async () => {
      let approvalCalled = false;
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => { approvalCalled = true; return false; },
        permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'session' }]
      });
      const result = await executor.execute('Bash', { command: 'git status' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(approvalCalled, false);
    });

    it('deny rule blocks execution and never asks the user', async () => {
      let executed = false;
      toolRegistry.register(new Tool({
        name: 'BashDeny',
        description: 'shell',
        requiresApproval: true,
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: async () => { executed = true; return { ok: true }; }
      }));
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => true,
        permissionRules: [{ tool: 'BashDeny', pattern: 'rm *', action: 'deny', source: 'safety' }]
      });
      const result = await executor.execute('BashDeny', { command: 'rm -rf /' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.deniedBy, 'rule');
      assert.match(result.error, /Blocked by rule/);
      assert.strictEqual(executed, false);
    });

    it('non-matching rule falls through to per-tool flag', async () => {
      let askedFor;
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async (toolName) => { askedFor = toolName; return true; },
        permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]
      });
      const result = await executor.execute('Bash', { command: 'npm install' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(askedFor, 'Bash', 'should fall through to approval');
    });

    it('first matching rule wins (deny before allow)', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => true,
        permissionRules: [
          { tool: 'Bash', pattern: 'rm *', action: 'deny' },
          { tool: 'Bash', pattern: '*', action: 'allow' }
        ]
      });
      const denied = await executor.execute('Bash', { command: 'rm secrets.txt' });
      assert.strictEqual(denied.deniedBy, 'rule');
      const allowed = await executor.execute('Bash', { command: 'ls' });
      assert.strictEqual(allowed.ok, true);
    });

    it('addPermissionRule appends a runtime rule', async () => {
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => false
      });
      executor.addPermissionRule({ tool: 'Bash', pattern: 'echo *', action: 'allow' });
      const result = await executor.execute('Bash', { command: 'echo hi' });
      assert.strictEqual(result.ok, true);
    });
  });

  describe('getPermissionRules callback', () => {
    it('picks up rules added mid-session via a callback', async () => {
      const rules = [];
      let approvalAsked = false;
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => { approvalAsked = true; return false; },
        getPermissionRules: () => rules
      });

      // First call — no rule, approval gets asked (and we deny).
      let result = await executor.execute('Bash', { command: 'git status' });
      assert.strictEqual(approvalAsked, true);
      assert.strictEqual(result.success, false);

      // Add a rule and re-run — rule should match, no approval prompt.
      rules.push({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'test' });
      approvalAsked = false;
      result = await executor.execute('Bash', { command: 'git status' });
      assert.strictEqual(approvalAsked, false);
      assert.strictEqual(result.ok, true);
    });
  });

  describe('denial tracker integration', () => {
    const DenialTracker = require('../src/tools/denial-tracker');

    it('auto-denies after the threshold without prompting', async () => {
      let prompts = 0;
      const tracker = new DenialTracker({ threshold: 2 });
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => { prompts++; return false; },
        denialTracker: tracker
      });

      // Two denials, both prompt the user.
      await executor.execute('Bash', { command: 'rm file' });
      await executor.execute('Bash', { command: 'rm file' });
      assert.strictEqual(prompts, 2);

      // Third call: threshold tripped, no prompt, auto-deny.
      const third = await executor.execute('Bash', { command: 'rm file' });
      assert.strictEqual(prompts, 2, 'no new prompt on auto-deny');
      assert.strictEqual(third.success, false);
      assert.strictEqual(third.deniedBy, 'denial-tracker');
      assert.strictEqual(third.denialCount, 2);
    });

    it('grant clears the counter for that key', async () => {
      let promptResult = false;
      const tracker = new DenialTracker({ threshold: 2 });
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async () => promptResult,
        denialTracker: tracker
      });

      // One denial.
      await executor.execute('Bash', { command: 'ls' });
      // Grant on the second try.
      promptResult = true;
      await executor.execute('Bash', { command: 'ls' });
      // Third call: counter was cleared on the grant, so the tracker
      // does not auto-deny on a fresh denial.
      promptResult = false;
      const third = await executor.execute('Bash', { command: 'ls' });
      assert.strictEqual(third.deniedBy, 'user');
    });

    it('tracker is per-key — denying "rm" does not block "ls"', async () => {
      const tracker = new DenialTracker({ threshold: 2 });
      const executor = new ToolExecutor({
        requireApproval: true,
        approvalRequester: async (_name, params) => params.command === 'ls',
        denialTracker: tracker
      });
      await executor.execute('Bash', { command: 'rm file' });
      await executor.execute('Bash', { command: 'rm file' });
      // rm is at threshold. ls should still be askable (and we approve).
      const ls = await executor.execute('Bash', { command: 'ls' });
      assert.strictEqual(ls.ok, true);
      // rm is still auto-denied.
      const rm = await executor.execute('Bash', { command: 'rm file' });
      assert.strictEqual(rm.deniedBy, 'denial-tracker');
    });
  });

  describe('onProgress callback', () => {
    it('emits toolProgress events during tool execution', async () => {
      const progressEvents = [];
      toolRegistry.register(new Tool({
        name: 'ProgressTool',
        description: 'tool that emits progress',
        requiresApproval: false,
        parameters: { type: 'object', properties: {} },
        execute: async (_params, ctx) => {
          if (typeof ctx.onProgress === 'function') {
            ctx.onProgress({ type: 'step', message: 'step 1' });
            ctx.onProgress({ type: 'step', message: 'step 2' });
          }
          return { ok: true };
        }
      }));
      const executor = new ToolExecutor({ requireApproval: false });
      executor.on('toolProgress', (event) => progressEvents.push(event));
      await executor.execute('ProgressTool', {});
      assert.strictEqual(progressEvents.length, 2);
      assert.strictEqual(progressEvents[0].progress.message, 'step 1');
      assert.strictEqual(progressEvents[1].progress.message, 'step 2');
      assert.strictEqual(progressEvents[0].toolName, 'ProgressTool');
    });
  });

  describe('AbortSignal propagation', () => {
    it('refuses to run when signal is already aborted', async () => {
      const executor = new ToolExecutor({ requireApproval: false });
      const controller = new AbortController();
      controller.abort();
      const result = await executor.execute('TestTool', { input: 'x' }, { signal: controller.signal });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.cancelled, true);
    });

    it('forwards the signal into the tool execution context', async () => {
      let receivedSignal;
      toolRegistry.register(new Tool({
        name: 'SignalEcho',
        description: 'records context.signal',
        requiresApproval: false,
        parameters: { type: 'object', properties: {} },
        execute: async (_params, context) => {
          receivedSignal = context.signal;
          return { ok: true };
        }
      }));
      const executor = new ToolExecutor({ requireApproval: false });
      const controller = new AbortController();
      await executor.execute('SignalEcho', {}, { signal: controller.signal });
      assert.ok(receivedSignal, 'tool should have received an AbortSignal in context');
      assert.strictEqual(receivedSignal.aborted, false);
    });
  });
});
