const { describe, it } = require('node:test');
const assert = require('node:assert');
const SANDBOX_CONFIG = require('../src/execution/sandbox-config');
const SandboxExecutor = require('../src/execution/sandbox-executor');

describe('Sandbox config – defaults', () => {
  it('has debian bookworm as default image', () => {
    assert.strictEqual(SANDBOX_CONFIG.defaultImage, 'debian:bookworm-slim');
  });

  it('has 512m memory limit', () => {
    assert.strictEqual(SANDBOX_CONFIG.memoryLimit, '512m');
  });

  it('has 120s timeout', () => {
    assert.strictEqual(SANDBOX_CONFIG.timeoutMs, 120000);
  });

  it('has bridge network mode', () => {
    assert.strictEqual(SANDBOX_CONFIG.networkMode, 'bridge');
  });

  it('has 5 minute hot cache TTL', () => {
    assert.strictEqual(SANDBOX_CONFIG.hotCacheTtlMs, 300000);
  });

  it('has /workspace as default workdir', () => {
    assert.strictEqual(SANDBOX_CONFIG.defaultWorkdir, '/workspace');
  });

  it('has default seccomp profile', () => {
    assert.strictEqual(SANDBOX_CONFIG.seccompProfile, 'default');
  });

  it('restricts sensitive system paths', () => {
    const restricted = SANDBOX_CONFIG.restrictedMounts;
    assert.ok(Array.isArray(restricted));
    assert.ok(restricted.includes('/etc'));
    assert.ok(restricted.includes('/proc'));
    assert.ok(restricted.includes('/sys'));
    assert.ok(restricted.includes('/dev'));
    assert.ok(restricted.includes('/root'));
    assert.ok(restricted.includes('/boot'));
    assert.ok(restricted.includes('/var/run/docker.sock'));
  });
});

describe('Sandbox executor – mount validation', () => {
  let executor;

  it('blocks mounting /etc', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/etc', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting /proc', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/proc', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting /sys', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/sys', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting /dev', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/dev', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting /root', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/root', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting /boot', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/boot', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting docker socket', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/var/run/docker.sock', '/workspace'),
      /restricted system path/
    );
  });

  it('blocks mounting root /', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/', '/workspace'),
      /root directory/
    );
  });

  it('allows mounting user directories', () => {
    executor = new SandboxExecutor();
    assert.doesNotThrow(
      () => executor.validateMount('/home/user/project', '/workspace')
    );
  });

  it('allows mounting /tmp', () => {
    executor = new SandboxExecutor();
    assert.doesNotThrow(
      () => executor.validateMount('/tmp/build', '/workspace')
    );
  });

  it('blocks subdirectories of restricted paths', () => {
    executor = new SandboxExecutor();
    assert.throws(
      () => executor.validateMount('/etc/nginx', '/workspace'),
      /restricted system path/
    );
  });

  it('does not block paths that contain restricted names as substrings', () => {
    executor = new SandboxExecutor();
    // /home/user/etc-configs should NOT be blocked
    assert.doesNotThrow(
      () => executor.validateMount('/home/user/etc-configs', '/workspace')
    );
  });

  it('mount validation returns true on success', () => {
    executor = new SandboxExecutor();
    const result = executor.validateMount('/home/user/project', '/workspace');
    assert.strictEqual(result, true);
  });

  it('security violation error has correct code', () => {
    executor = new SandboxExecutor();
    try {
      executor.validateMount('/etc', '/workspace');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'SANDBOX_SECURITY_VIOLATION');
    }
  });
});

describe('Sandbox executor – container args', () => {
  it('includes memory limit', () => {
    const executor = new SandboxExecutor({ memoryLimit: '256m' });
    const args = executor.getContainerArgs();
    assert.ok(args.some(a => a.includes('256m')));
  });

  it('includes network mode', () => {
    const executor = new SandboxExecutor({ networkMode: 'none' });
    const args = executor.getContainerArgs();
    assert.ok(args.some(a => a.includes('none')));
  });

  it('does not include seccomp for default profile', () => {
    const executor = new SandboxExecutor({ seccompProfile: 'default' });
    const args = executor.getContainerArgs();
    assert.ok(!args.some(a => a.includes('seccomp=')));
  });

  it('includes custom seccomp profile', () => {
    const executor = new SandboxExecutor({ seccompProfile: '/path/to/profile.json' });
    const args = executor.getContainerArgs();
    assert.ok(args.some(a => a.includes('seccomp=/path/to/profile.json')));
  });

  it('includes -d (detached) flag', () => {
    const executor = new SandboxExecutor();
    const args = executor.getContainerArgs();
    assert.ok(args.includes('-d'));
  });

  it('includes --rm flag', () => {
    const executor = new SandboxExecutor();
    const args = executor.getContainerArgs();
    assert.ok(args.includes('--rm'));
  });
});

describe('Sandbox executor – config override', () => {
  it('allows overriding config after construction', () => {
    const executor = new SandboxExecutor({ memoryLimit: '256m' });
    assert.strictEqual(executor.config.memoryLimit, '256m');

    executor.updateConfig({ memoryLimit: '1g' });
    assert.strictEqual(executor.config.memoryLimit, '1g');
  });

  it('preserves non-overridden config values', () => {
    const executor = new SandboxExecutor();
    const originalImage = executor.config.defaultImage;

    executor.updateConfig({ memoryLimit: '1g' });
    assert.strictEqual(executor.config.defaultImage, originalImage);
  });
});

describe('Sandbox executor – Docker availability caching', () => {
  it('caches Docker availability result', async () => {
    const executor = new SandboxExecutor();
    const first = await executor.isDockerAvailable();
    const second = await executor.isDockerAvailable();
    assert.strictEqual(first, second);
    assert.strictEqual(typeof first, 'boolean');
  });

  it('returns boolean from isDockerAvailable', async () => {
    const executor = new SandboxExecutor();
    const result = await executor.isDockerAvailable();
    assert.strictEqual(typeof result, 'boolean');
  });
});
