const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { isAdministratorsMember } = require('../src/service/commands/admin-check');
const { runElevatedSchtasks, ELEVATE_SCRIPT } = require('../src/service/elevated-schtasks');

const ENV = { SystemRoot: 'C:\\Windows' };

describe('isAdministratorsMember', () => {
  it('is true when whoami /groups lists S-1-5-32-544, even as deny-only', () => {
    const calls = [];
    const execFile = (file, args, opts) => {
      calls.push({ file, args, opts });
      return '"Group Name","Type","SID","Attributes"\r\n'
        + '"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n'
        + '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n';
    };
    assert.strictEqual(isAdministratorsMember({ execFile, env: ENV }), true);
    assert.strictEqual(calls[0].file, path.win32.join('C:\\Windows', 'System32', 'whoami.exe'));
    assert.deepStrictEqual(calls[0].args, ['/groups', '/fo', 'csv']);
    assert.strictEqual(calls[0].opts.windowsHide, true);
  });

  it('is false when S-1-5-32-544 is absent', () => {
    const execFile = () => '"Group Name","Type","SID","Attributes"\r\n"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n';
    assert.strictEqual(isAdministratorsMember({ execFile, env: ENV }), false);
  });

  it('is false when whoami throws', () => {
    const execFile = () => { throw new Error('boom'); };
    assert.strictEqual(isAdministratorsMember({ execFile, env: ENV }), false);
  });
});

describe('runElevatedSchtasks', () => {
  it('runs powershell Start-Process -Verb RunAs on the absolute schtasks path, args as one base64 JSON element', async () => {
    const calls = [];
    const execFile = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '0\r\n' }; };
    const taskArgs = ['/Create', '/XML', 'C:\\Users\\A B\\task.xml', '/TN', 'KingLouie Node $(evil)', '/F'];
    const result = await runElevatedSchtasks(taskArgs, { execFile, env: ENV });
    assert.deepStrictEqual(result, { ok: true });
    const call = calls[0];
    assert.strictEqual(call.file, path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepStrictEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.strictEqual(call.args.length, 5);
    assert.strictEqual(call.args[3], ELEVATE_SCRIPT);
    assert.match(call.args[3], /Start-Process/);
    assert.match(call.args[3], /-Verb RunAs -Wait -PassThru/);
    for (const a of taskArgs) assert.ok(!call.args[3].includes(a), `script must not contain ${a}`);
    const decoded = JSON.parse(Buffer.from(call.args[4], 'base64').toString('utf8'));
    assert.deepStrictEqual(decoded, [path.win32.join('C:\\Windows', 'System32', 'schtasks.exe'), ...taskArgs]);
    assert.strictEqual(call.opts.windowsHide, true);
    assert.strictEqual(call.opts.timeout, 300000);
  });

  it('maps a non-zero ExitCode to SCHTASKS_FAILED', async () => {
    const execFile = async () => ({ stdout: '1\r\n' });
    const r = await runElevatedSchtasks(['/Delete'], { execFile, env: ENV });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SCHTASKS_FAILED');
    assert.strictEqual(r.exitCode, 1);
    assert.ok(r.message);
  });

  it('maps "The operation was canceled by the user" to UAC_DECLINED', async () => {
    const execFile = async () => {
      const e = new Error('Command failed');
      e.stderr = 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.';
      throw e;
    };
    const r = await runElevatedSchtasks(['/Delete'], { execFile, env: ENV });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'UAC_DECLINED');
  });

  it('maps other failures and unparseable output to SCHTASKS_FAILED', async () => {
    const thrown = await runElevatedSchtasks(['/x'], { execFile: async () => { throw new Error('nope'); }, env: ENV });
    assert.strictEqual(thrown.code, 'SCHTASKS_FAILED');
    const garbage = await runElevatedSchtasks(['/x'], { execFile: async () => ({ stdout: 'hello' }), env: ENV });
    assert.strictEqual(garbage.code, 'SCHTASKS_FAILED');
  });
});
