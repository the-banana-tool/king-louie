const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');

// Register a test tool that captures the options it receives
let capturedOptions = null;
const toolName = 'SandboxCaptureTool';

if (!toolRegistry.get(toolName)) {
  toolRegistry.register(new Tool({
    name: toolName,
    description: 'Captures options for testing',
    requiresApproval: false,
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    execute: async (params, options) => {
      capturedOptions = options;
      return { ok: true, useSandbox: options.useSandbox };
    }
  }));
}

const ToolExecutor = require('../src/execution/tool-executor');

describe('ToolExecutor – useSandbox propagation', () => {
  beforeEach(() => {
    capturedOptions = null;
  });

  it('passes useSandbox=true to tools by default', async () => {
    const executor = new ToolExecutor({ requireApproval: false });
    await executor.execute(toolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, true);
  });

  it('passes useSandbox=true when explicitly set', async () => {
    const executor = new ToolExecutor({ requireApproval: false, useSandbox: true });
    await executor.execute(toolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, true);
  });

  it('passes useSandbox=false when set to false', async () => {
    const executor = new ToolExecutor({ requireApproval: false, useSandbox: false });
    await executor.execute(toolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, false);
  });

  it('stores useSandbox on the executor instance', () => {
    const executorOn = new ToolExecutor({ useSandbox: true });
    assert.strictEqual(executorOn.useSandbox, true);

    const executorOff = new ToolExecutor({ useSandbox: false });
    assert.strictEqual(executorOff.useSandbox, false);

    const executorDefault = new ToolExecutor({});
    assert.strictEqual(executorDefault.useSandbox, true);
  });

  it('includes runtimeEnvironment alongside useSandbox in tool options', async () => {
    const fakeRuntime = { platform: 'win32', shell: 'cmd.exe', availableCommands: {} };
    const executor = new ToolExecutor({
      requireApproval: false,
      useSandbox: false,
      runtimeEnvironment: fakeRuntime
    });

    await executor.execute(toolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, false);
    assert.strictEqual(capturedOptions.runtimeEnvironment.platform, 'win32');
    assert.strictEqual(capturedOptions.runtimeEnvironment.shell, 'cmd.exe');
  });

  it('passes workingDirectory alongside useSandbox', async () => {
    const executor = new ToolExecutor({
      requireApproval: false,
      useSandbox: true,
      workingDirectory: '/home/user/project'
    });

    await executor.execute(toolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, true);
    assert.strictEqual(capturedOptions.workingDirectory, '/home/user/project');
  });
});

describe('ToolExecutor – sandbox with approval flow', () => {
  it('preserves useSandbox through auto-approval flow', async () => {
    capturedOptions = null;

    // Register a tool that requires approval
    const approvalToolName = 'SandboxApprovalTool';
    if (!toolRegistry.get(approvalToolName)) {
      toolRegistry.register(new Tool({
        name: approvalToolName,
        description: 'Requires approval',
        requiresApproval: true,
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
        execute: async (params, options) => {
          capturedOptions = options;
          return { ok: true };
        }
      }));
    }

    const executor = new ToolExecutor({
      requireApproval: true,
      shouldAutoApprove: async () => true,
      useSandbox: false
    });

    await executor.execute(approvalToolName, { input: 'test' });

    assert.ok(capturedOptions, 'Tool should have been called');
    assert.strictEqual(capturedOptions.useSandbox, false);
  });
});
