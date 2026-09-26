const { describe, it } = require('node:test');
const assert = require('node:assert');

// Import internals we need to test
const BashTool = require('../src/tools/builtin/bash-tool');
const { sanitizeCommandName } = require('../src/execution/runtime-environment');

// Extract the functions from the module for direct testing
// We need to import validateCommandAvailability and extractCommandNames
// Since they're not exported, we test them through the tool's behavior

// Exit code 127 has two possible sources here, and only one of them is what
// these tests are about:
//   1. the tool's own availability check refusing a command it believes is
//      unavailable on the (simulated) platform — the behaviour under test;
//   2. the *host* shell failing to find a real binary, because the command
//      is only executed for real after validation lets it through.
// They must not be conflated: `dir` is a cmd.exe builtin on Windows and a
// coreutils binary on Linux, but does not exist at all on macOS, where the
// host shell legitimately answers 127 for a command that passed validation.
// Only the availability check produces this message, so assert on that.
const NOT_AVAILABLE_RE = /is not available on this system/;

function assertNotFlaggedUnavailable(result, message) {
  assert.ok(!NOT_AVAILABLE_RE.test(result.stderr || ''), `${message} (stderr: ${result.stderr})`);
}

describe('Bash tool – platform-aware command validation', () => {
  describe('Windows builtins', () => {
    const winEnv = { platform: 'win32', shell: 'cmd.exe', availableCommands: {} };

    it('allows Windows builtins on win32', async () => {
      const result = await BashTool.execute(
        { command: 'dir' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      // dir should not fail with "not available" – it's a Windows builtin.
      // It may well fail for other reasons (the host isn't Windows).
      assertNotFlaggedUnavailable(result, 'dir should not be flagged as unavailable on win32');
    });

    it('allows echo on Windows', async () => {
      const result = await BashTool.execute(
        { command: 'echo hello' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      assertNotFlaggedUnavailable(result, 'echo should not be flagged as unavailable on win32');
    });

    it('allows cd on Windows', async () => {
      const result = await BashTool.execute(
        { command: 'cd' },
        { runtimeEnvironment: winEnv, useSandbox: false }
      );
      assertNotFlaggedUnavailable(result, 'cd should not be flagged as unavailable on win32');
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
      assertNotFlaggedUnavailable(result, 'echo should not be flagged as unavailable on linux');
    });

    it('allows pwd on linux', async () => {
      const result = await BashTool.execute(
        { command: 'pwd' },
        { runtimeEnvironment: posixEnv, useSandbox: false }
      );
      assertNotFlaggedUnavailable(result, 'pwd should not be flagged as unavailable on linux');
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
        // pwd is a POSIX builtin, so the availability check must let it through
        assertNotFlaggedUnavailable(result, 'pwd should be valid in sandbox (POSIX) mode');
      } finally {
        BashTool.sandboxExecutor.isDockerAvailable = originalIsDockerAvailable;
        // Mocking isDockerAvailable still lets the rest of execute() talk to
        // the real Docker daemon, so this test actually starts a real
        // `debian:bookworm-slim` container (`tail -f /dev/null`, `--rm` on
        // stop but never stopped). Without this, every run of this file left
        // one more container behind forever, on pass, failure, or timeout.
        await BashTool.sandboxExecutor.cleanup();
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
        assertNotFlaggedUnavailable(result, 'dir should be valid on win32 without sandbox');
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
      assertNotFlaggedUnavailable(result, 'Chained builtins should not be flagged');
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
