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
});
