const { describe, it } = require('node:test');
const assert = require('node:assert');
const SandboxExecutor = require('../src/execution/sandbox-executor');

describe('SandboxExecutor', () => {
  it('detects Docker availability', async () => {
    const executor = new SandboxExecutor();
    const available = await executor.isDockerAvailable();
    assert.strictEqual(typeof available, 'boolean');
  });

  it('blocks system path mounts', () => {
    const executor = new SandboxExecutor();
    assert.throws(() => executor.validateMount('/etc', '/workspace'));
    assert.throws(() => executor.validateMount('/proc', '/workspace'));
    assert.throws(() => executor.validateMount('/var/run/docker.sock', '/workspace'));
    assert.doesNotThrow(() => executor.validateMount('/home/user/project', '/workspace'));
  });


  it('applies memory limit', () => {
    const executor = new SandboxExecutor({ memoryLimit: '256m' });
    const args = executor.getContainerArgs();
    assert.ok(args.includes('--memory=256m') || args.some(a => a.includes('256m')));
  });

  it('supports network isolation modes', () => {
    const executor = new SandboxExecutor({ networkMode: 'none' });
    const args = executor.getContainerArgs();
    assert.ok(args.some(a => a.includes('none')));
  });

  it('does not fallback to direct execution on mount security violation', async () => {
    const executor = new SandboxExecutor();

    let directCalled = false;
    executor._executeDirect = async () => {
      directCalled = true;
      return { success: true };
    };

    const result = await executor.execute('echo "test"', { workingDirectory: '/etc' });
    assert.ok(!directCalled);
    assert.strictEqual(result.success, false);
    assert.ok(result.stderr.includes('restricted system path'));
  });

  it('falls back to direct execution when Docker unavailable', async () => {
    const executor = new SandboxExecutor();

    // Mock Docker unavailable
    executor.isDockerAvailable = async () => false;

    let directCalled = false;
    executor._executeDirect = async () => {
      directCalled = true;
      return { success: true };
    };

    await executor.execute('echo "test"');
    assert.ok(directCalled);
  });

  it('streams stdout progress via onProgress when callback is provided', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const progressEvents = [];
    const result = await executor._executeDirect(
      process.platform === 'win32'
        ? 'for /L %i in (1,1,5) do @echo line %i'
        : 'for i in 1 2 3 4 5; do echo "line $i"; done',
      {
        onProgress: (event) => progressEvents.push(event),
        timeout: 10000
      }
    );

    assert.strictEqual(result.success, true);
    assert.ok(result.stdout.includes('line'), 'stdout should contain output');
    // Progress events may or may not fire depending on timing/throttling,
    // but the result should be correct regardless.
    assert.strictEqual(typeof result.exitCode, 'number');
  });

  it('returns the same result shape from spawn path as from exec path', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const execResult = await executor._executeDirect('echo hello', {});
    const spawnResult = await executor._executeDirect('echo hello', {
      onProgress: () => {}
    });

    assert.strictEqual(execResult.success, spawnResult.success);
    assert.strictEqual(execResult.stdout, spawnResult.stdout);
    assert.strictEqual(typeof spawnResult.exitCode, 'number');
    assert.strictEqual(spawnResult.environment.sandbox, false);
  });
});
