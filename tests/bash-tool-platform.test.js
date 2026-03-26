const { describe, it } = require('node:test');
const assert = require('node:assert');

// Import internals we need to test
const BashTool = require('../src/tools/builtin/bash-tool');
const { sanitizeCommandName } = require('../src/execution/runtime-environment');

// Extract the functions from the module for direct testing
// We need to import validateCommandAvailability and extractCommandNames
// Since they're not exported, we test them through the tool's behavior

describe('Bash tool – platform-aware command validation', () => {
  describe('Windows builtins', () => {
    const winEnv = { platform: 'win32', shell: 'cmd.exe', availableCommands: {} };

    it('allows Windows builtins on win32', async () => {
      const result = await BashTool.execute(
        { command: 'dir' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      // dir should not fail with "not available" – it's a Windows builtin
      // It might fail for other reasons (not actually on Windows) but NOT with exitCode 127
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'dir should not be flagged as unavailable on win32');
      }
    });

    it('allows echo on Windows', async () => {
      const result = await BashTool.execute(
        { command: 'echo hello' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'echo should not be flagged as unavailable on win32');
      }
    });

    it('allows cd on Windows', async () => {
      const result = await BashTool.execute(
        { command: 'cd' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'cd should not be flagged as unavailable on win32');
      }
    });

    it('flags unavailable commands on Windows', async () => {
      const envWithUnavailable = {
        platform: 'win32',
        shell: 'cmd.exe',
        availableCommands: { nonexistentcmd: false }
      };
      const result = await BashTool.execute(
        { command: 'nonexistentcmd' },
        { runtimeEnvironment: envWithUnavailable, useSandbox: false }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 127);
      assert.ok(result.stderr.includes('not available'));
      assert.ok(result.stderr.includes('win32'));
    });
  });

  describe('POSIX builtins', () => {
    const posixEnv = { platform: 'linux', shell: '/bin/bash', availableCommands: {} };

    it('allows POSIX builtins on linux', async () => {
      const result = await BashTool.execute(
        { command: 'echo hello' },
        { runtimeEnvironment: posixEnv, useSandbox: false }
      );
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'echo should not be flagged as unavailable on linux');
      }
    });

    it('allows pwd on linux', async () => {
      const result = await BashTool.execute(
        { command: 'pwd' },
        { runtimeEnvironment: posixEnv, useSandbox: false }
      );
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'pwd should not be flagged as unavailable on linux');
      }
    });

    it('flags unavailable commands on linux', async () => {
      const envWithUnavailable = {
        platform: 'linux',
        shell: '/bin/sh',
        availableCommands: { zypper: false }
      };
      const result = await BashTool.execute(
        { command: 'zypper install something' },
        { runtimeEnvironment: envWithUnavailable, useSandbox: false }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 127);
      assert.ok(result.stderr.includes('not available'));
    });
  });

  describe('sandbox mode overrides platform to linux', () => {
    it('validates using POSIX builtins when sandbox is enabled', async () => {
      // Even if host is win32, sandbox should validate as linux
      const winEnv = { platform: 'win32', shell: 'cmd.exe', availableCommands: {} };

      // Mock Docker as available
      const originalIsDockerAvailable = BashTool.sandboxExecutor.isDockerAvailable;
      BashTool.sandboxExecutor.isDockerAvailable = async () => true;

      try {
        // 'pwd' is a POSIX builtin, not a Windows builtin
        // In sandbox mode, this should pass validation
        const result = await BashTool.execute(
          { command: 'pwd' },
          { runtimeEnvironment: winEnv, useSandbox: true }
        );
        // Should not get 127 (command not found) since pwd is a POSIX builtin
        if (!result.success) {
          assert.notStrictEqual(result.exitCode, 127, 'pwd should be valid in sandbox (POSIX) mode');
        }
      } finally {
        BashTool.sandboxExecutor.isDockerAvailable = originalIsDockerAvailable;
      }
    });

    it('uses Windows builtins when sandbox is disabled on win32', async () => {
      const winEnv = { platform: 'win32', shell: 'cmd.exe', availableCommands: {} };

      // Mock Docker as unavailable
      const originalIsDockerAvailable = BashTool.sandboxExecutor.isDockerAvailable;
      BashTool.sandboxExecutor.isDockerAvailable = async () => false;

      try {
        // 'dir' is a Windows builtin, should pass on win32 without sandbox
        const result = await BashTool.execute(
          { command: 'dir' },
          { runtimeEnvironment: winEnv, useSandbox: false }
        );
        if (!result.success) {
          assert.notStrictEqual(result.exitCode, 127, 'dir should be valid on win32 without sandbox');
        }
      } finally {
        BashTool.sandboxExecutor.isDockerAvailable = originalIsDockerAvailable;
      }
    });
  });

  describe('compound commands', () => {
    it('validates each command in a chain', async () => {
      const env = {
        platform: 'linux',
        shell: '/bin/sh',
        availableCommands: { git: true, badcmd: false }
      };
      const result = await BashTool.execute(
        { command: 'git status && badcmd' },
        { runtimeEnvironment: env, useSandbox: false }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 127);
      assert.ok(result.stderr.includes('badcmd'));
    });

    it('allows chained builtins', async () => {
      const env = { platform: 'linux', shell: '/bin/sh', availableCommands: {} };
      const result = await BashTool.execute(
        { command: 'echo hello && pwd' },
        { runtimeEnvironment: env, useSandbox: false }
      );
      if (!result.success) {
        assert.notStrictEqual(result.exitCode, 127, 'Chained builtins should not be flagged');
      }
    });

    it('validates commands separated by semicolons', async () => {
      const env = {
        platform: 'linux',
        shell: '/bin/sh',
        availableCommands: { missingpkg: false }
      };
      const result = await BashTool.execute(
        { command: 'echo hello; missingpkg install' },
        { runtimeEnvironment: env, useSandbox: false }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 127);
    });

    it('validates commands separated by pipes (||)', async () => {
      const env = {
        platform: 'linux',
        shell: '/bin/sh',
        availableCommands: { nosuchbin: false }
      };
      const result = await BashTool.execute(
        { command: 'echo ok || nosuchbin' },
        { runtimeEnvironment: env, useSandbox: false }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 127);
    });
  });
});

describe('Bash tool – dangerous pattern detection', () => {
  it('detects rm -rf /', () => {
    assert.ok(BashTool.isDangerous({ command: 'rm -rf /' }));
  });

  it('detects mkfs', () => {
    assert.ok(BashTool.isDangerous({ command: 'mkfs.ext4 /dev/sda1' }));
  });

  it('detects dd if=', () => {
    assert.ok(BashTool.isDangerous({ command: 'dd if=/dev/zero of=/dev/sda' }));
  });

  it('detects Windows del /s /q', () => {
    assert.ok(BashTool.isDangerous({ command: 'del /s /q C:\\' }));
  });

  it('detects Windows rmdir /s /q', () => {
    assert.ok(BashTool.isDangerous({ command: 'rmdir /s /q C:\\Windows' }));
  });

  it('detects format drive', () => {
    assert.ok(BashTool.isDangerous({ command: 'format C:' }));
  });

  it('does not flag safe commands', () => {
    assert.ok(!BashTool.isDangerous({ command: 'ls -la' }));
    assert.ok(!BashTool.isDangerous({ command: 'echo hello' }));
    assert.ok(!BashTool.isDangerous({ command: 'git status' }));
    assert.ok(!BashTool.isDangerous({ command: 'npm install' }));
  });
});
