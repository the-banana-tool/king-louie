const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const SandboxExecutor = require('../src/execution/sandbox-executor');

describe('SandboxExecutor – useSandbox toggle', () => {
  let executor;

  beforeEach(() => {
    executor = new SandboxExecutor();
    // Ensure Docker is "available" for these tests
    executor.isDockerAvailable = async () => true;
  });

  it('uses sandbox when useSandbox is true and Docker is available', async () => {
    let containerExecCalled = false;
    executor.getOrCreateContainer = async () => {
      containerExecCalled = true;
      return 'fake-container-id';
    };
    // Mock the docker exec path to avoid real execution
    const originalExecute = executor.execute.bind(executor);
    // We just verify the container path is attempted
    try {
      await executor.execute('echo hello', { useSandbox: true, workingDirectory: '/home/user/project' });
    } catch { /* ignore exec errors in test */ }
    assert.ok(containerExecCalled, 'Should attempt container execution when useSandbox=true');
  });

  it('skips sandbox and uses direct execution when useSandbox is false', async () => {
    let directCalled = false;
    executor._executeDirect = async () => {
      directCalled = true;
      return { success: true, stdout: '', stderr: '', exitCode: 0, environment: { platform: process.platform, shell: null, sandbox: false } };
    };

    const result = await executor.execute('echo hello', { useSandbox: false });
    assert.ok(directCalled, 'Should call _executeDirect when useSandbox=false');
    assert.strictEqual(result.environment.sandbox, false);
  });

  it('skips sandbox when Docker is unavailable even if useSandbox is true', async () => {
    executor.isDockerAvailable = async () => false;
    let directCalled = false;
    executor._executeDirect = async () => {
      directCalled = true;
      return { success: true, stdout: '', stderr: '', exitCode: 0, environment: { platform: process.platform, shell: null, sandbox: false } };
    };

    await executor.execute('echo hello', { useSandbox: true });
    assert.ok(directCalled, 'Should fallback to direct when Docker unavailable');
  });

  it('defaults useSandbox to true when option is not provided', async () => {
    let containerExecCalled = false;
    executor.getOrCreateContainer = async () => {
      containerExecCalled = true;
      return 'fake-container-id';
    };

    try {
      await executor.execute('echo hello', { workingDirectory: '/home/user/project' });
    } catch { /* ignore exec errors */ }
    assert.ok(containerExecCalled, 'Should default to sandbox when useSandbox not specified');
  });

  it('defaults useSandbox to true when option is explicitly undefined', async () => {
    let containerExecCalled = false;
    executor.getOrCreateContainer = async () => {
      containerExecCalled = true;
      return 'fake-container-id';
    };

    try {
      await executor.execute('echo hello', { useSandbox: undefined, workingDirectory: '/home/user/project' });
    } catch { /* ignore exec errors */ }
    assert.ok(containerExecCalled, 'Should default to sandbox when useSandbox=undefined');
  });
});

describe('SandboxExecutor – platform awareness in direct mode', () => {
  it('reports host platform in direct execution environment', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const result = await executor.execute('echo hello', { useSandbox: false });
    assert.strictEqual(result.environment.platform, process.platform);
    assert.strictEqual(result.environment.sandbox, false);
  });

  it('reports host shell in direct execution environment on Windows', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const result = await executor.execute('echo hello', { useSandbox: false });
    assert.strictEqual(result.environment.sandbox, false);
    // Shell should be non-null when running direct
    assert.ok(result.environment.shell !== null, 'Shell should not be null in direct mode');
    assert.strictEqual(typeof result.environment.shell, 'string');
    assert.ok(result.environment.shell.length > 0, 'Shell should be a non-empty string');
  });

  it('reports linux platform in sandbox execution environment', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => true;

    // Mock container creation
    executor.getOrCreateContainer = async () => 'fake-container';

    // The execute will fail at docker exec but the security violation path returns linux
    const result = await executor.execute('echo hello', {
      useSandbox: true,
      workingDirectory: '/etc'  // This triggers security violation which returns sandbox env
    });

    assert.strictEqual(result.environment.platform, 'linux');
    assert.strictEqual(result.environment.shell, 'sh');
    assert.strictEqual(result.environment.sandbox, true);
  });

  it('direct mode error results also include platform info', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const result = await executor.execute('nonexistent_command_xyzzy_42', { useSandbox: false });
    assert.strictEqual(result.environment.platform, process.platform);
    assert.strictEqual(result.environment.sandbox, false);
    assert.strictEqual(typeof result.environment.shell, 'string');
  });
});

describe('SandboxExecutor – container environment metadata', () => {
  it('sandbox success returns linux/sh/sandbox:true', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => true;
    executor.getOrCreateContainer = async () => 'fake-container';

    // We can't actually run docker exec in tests, but we can test the
    // security violation path which also returns sandbox environment
    const result = await executor.execute('echo test', { workingDirectory: '/proc' });
    assert.strictEqual(result.environment.platform, 'linux');
    assert.strictEqual(result.environment.shell, 'sh');
    assert.strictEqual(result.environment.sandbox, true);
  });
});
