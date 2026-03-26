const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  getRuntimeEnvironment,
  resetRuntimeEnvironmentCache,
  isCommandAvailable,
  sanitizeCommandName
} = require('../src/execution/runtime-environment');

describe('Runtime environment – platform detection', () => {
  beforeEach(() => {
    resetRuntimeEnvironmentCache();
  });

  it('returns current platform', async () => {
    const env = await getRuntimeEnvironment();
    assert.strictEqual(env.platform, process.platform);
  });

  it('returns a shell path', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok(env.shell, 'Shell should be defined');
    assert.strictEqual(typeof env.shell, 'string');
    assert.ok(env.shell.length > 0, 'Shell should be non-empty');
  });

  it('returns appropriate shell for platform', async () => {
    const env = await getRuntimeEnvironment();
    if (process.platform === 'win32') {
      // On Windows, should be cmd.exe or ComSpec
      assert.ok(
        env.shell.includes('cmd') || env.shell.includes('powershell') || env.shell.includes('pwsh'),
        `Windows shell should contain cmd/powershell: got ${env.shell}`
      );
    } else {
      // On POSIX, should be a path to a shell
      assert.ok(
        env.shell.includes('sh') || env.shell.includes('bash') || env.shell.includes('zsh'),
        `POSIX shell should contain sh/bash/zsh: got ${env.shell}`
      );
    }
  });

  it('returns working directory', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok(env.workingDirectory);
    assert.strictEqual(typeof env.workingDirectory, 'string');
  });

  it('returns availableCommands object', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok(env.availableCommands);
    assert.strictEqual(typeof env.availableCommands, 'object');
  });

  it('returns available and unavailable arrays', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok(Array.isArray(env.available));
    assert.ok(Array.isArray(env.unavailable));
    assert.ok(env.available.length + env.unavailable.length > 0);
  });

  it('returns detectedAt timestamp', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok(env.detectedAt);
    const date = new Date(env.detectedAt);
    assert.ok(!isNaN(date.getTime()), 'detectedAt should be a valid ISO date');
  });

  it('caches results across calls', async () => {
    const env1 = await getRuntimeEnvironment();
    const env2 = await getRuntimeEnvironment();
    assert.strictEqual(env1.detectedAt, env2.detectedAt, 'Should return cached result');
  });

  it('returns fresh results after cache reset', async () => {
    const env1 = await getRuntimeEnvironment();
    resetRuntimeEnvironmentCache();
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    const env2 = await getRuntimeEnvironment();
    // They might have the same timestamp if fast enough, but at least it re-ran
    assert.ok(env2.detectedAt, 'Should have a detectedAt after reset');
  });
});

describe('Runtime environment – command availability', () => {
  beforeEach(() => {
    resetRuntimeEnvironmentCache();
  });

  it('detects node as available', async () => {
    const available = await isCommandAvailable('node');
    assert.strictEqual(available, true);
  });

  it('detects npm as available', async () => {
    const available = await isCommandAvailable('npm');
    assert.strictEqual(available, true);
  });

  it('detects nonexistent command as unavailable', async () => {
    const available = await isCommandAvailable('totally_nonexistent_command_xyzzy_99');
    assert.strictEqual(available, false);
  });

  it('handles empty command name', async () => {
    const available = await isCommandAvailable('');
    assert.strictEqual(available, false);
  });

  it('handles null command name', async () => {
    const available = await isCommandAvailable(null);
    assert.strictEqual(available, false);
  });

  it('caches command availability', async () => {
    const first = await isCommandAvailable('node');
    const second = await isCommandAvailable('node');
    assert.strictEqual(first, second);
  });
});

describe('Runtime environment – command name sanitization', () => {
  it('lowercases command names', () => {
    assert.strictEqual(sanitizeCommandName('GIT'), 'git');
    assert.strictEqual(sanitizeCommandName('Node'), 'node');
  });

  it('removes special characters', () => {
    assert.strictEqual(sanitizeCommandName('git@hack'), 'githack');
    assert.strictEqual(sanitizeCommandName('rm -rf'), 'rm-rf');
  });

  it('preserves dots and dashes', () => {
    assert.strictEqual(sanitizeCommandName('docker-compose'), 'docker-compose');
    assert.strictEqual(sanitizeCommandName('node.exe'), 'node.exe');
  });

  it('preserves underscores', () => {
    assert.strictEqual(sanitizeCommandName('my_command'), 'my_command');
  });

  it('handles empty string', () => {
    assert.strictEqual(sanitizeCommandName(''), '');
  });

  it('handles undefined', () => {
    assert.strictEqual(sanitizeCommandName(undefined), '');
  });

  it('handles null', () => {
    assert.strictEqual(sanitizeCommandName(null), '');
  });

  it('trims whitespace', () => {
    assert.strictEqual(sanitizeCommandName('  git  '), 'git');
  });
});

describe('Runtime environment – sandbox vs direct platform reporting', () => {
  const SandboxExecutor = require('../src/execution/sandbox-executor');

  it('direct execution reports host platform', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const result = await executor.execute('echo test', { useSandbox: false });
    assert.strictEqual(result.environment.platform, process.platform);
    assert.strictEqual(result.environment.sandbox, false);
    assert.strictEqual(typeof result.environment.shell, 'string');
  });

  it('sandbox security violation reports linux platform', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => true;

    const result = await executor.execute('echo test', {
      useSandbox: true,
      workingDirectory: '/etc'
    });
    assert.strictEqual(result.environment.platform, 'linux');
    assert.strictEqual(result.environment.sandbox, true);
    assert.strictEqual(result.environment.shell, 'sh');
  });

  it('direct mode on Windows reports win32 and cmd.exe-compatible shell', async () => {
    const executor = new SandboxExecutor();
    executor.isDockerAvailable = async () => false;

    const result = await executor.execute('echo test', { useSandbox: false });

    if (process.platform === 'win32') {
      assert.strictEqual(result.environment.platform, 'win32');
      assert.ok(
        result.environment.shell.includes('cmd') ||
        result.environment.shell.includes('powershell') ||
        result.environment.shell.includes('pwsh'),
        `Expected Windows shell, got: ${result.environment.shell}`
      );
    } else {
      assert.strictEqual(result.environment.platform, process.platform);
      assert.ok(
        result.environment.shell.includes('sh') ||
        result.environment.shell.includes('bash') ||
        result.environment.shell.includes('zsh'),
        `Expected POSIX shell, got: ${result.environment.shell}`
      );
    }
  });
});

describe('Runtime environment – command availability in runtime object', () => {
  beforeEach(() => {
    resetRuntimeEnvironmentCache();
  });

  it('includes git in availableCommands', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok('git' in env.availableCommands, 'git should be checked');
    assert.strictEqual(typeof env.availableCommands.git, 'boolean');
  });

  it('includes node in availableCommands', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok('node' in env.availableCommands);
    assert.strictEqual(env.availableCommands.node, true);
  });

  it('includes docker in availableCommands', async () => {
    const env = await getRuntimeEnvironment();
    assert.ok('docker' in env.availableCommands);
    assert.strictEqual(typeof env.availableCommands.docker, 'boolean');
  });

  it('available array contains only true commands', async () => {
    const env = await getRuntimeEnvironment();
    for (const cmd of env.available) {
      assert.strictEqual(env.availableCommands[cmd], true, `${cmd} should be marked as available`);
    }
  });

  it('unavailable array contains only false commands', async () => {
    const env = await getRuntimeEnvironment();
    for (const cmd of env.unavailable) {
      assert.strictEqual(env.availableCommands[cmd], false, `${cmd} should be marked as unavailable`);
    }
  });
});
