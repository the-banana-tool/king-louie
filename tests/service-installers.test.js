const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml, planInstall, planUninstall, executeSteps
} = require('../src/service/installers');

const base = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', dataDir: '/var/lib/king-louie', user: 'king-louie' };

function io() {
  const out = [];
  return { out, stdout: { write: (s) => out.push(String(s)) } };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-installers-'));

describe('systemd unit', () => {
  it('runs as the service user with hardening and the master-key credential', () => {
    const unit = renderSystemdUnit({ ...base, profile: 'runbook' });
    assert.match(unit, /^User=king-louie$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/king-louie\/bin\/king-louie-service\.js run --data-dir \/var\/lib\/king-louie --profile runbook$/m);
    assert.match(unit, /^LoadCredential=kl-master-key:\/etc\/king-louie\/credentials\/kl-master-key$/m);
    for (const d of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'PrivateTmp=yes', 'ReadWritePaths=/var/lib/king-louie', 'ProtectHome=yes']) {
      assert.ok(unit.includes(d), `missing ${d}`);
    }
  });
  it('lets the agent profile read home directories', () => {
    assert.match(renderSystemdUnit({ ...base, profile: 'agent' }), /^ProtectHome=read-only$/m);
  });
});

describe('launchd plist', () => {
  it('is a daemon running as the given user', () => {
    const plist = renderLaunchdPlist({ ...base, dataDir: '/Library/Application Support/KingLouie', logsDir: '/Library/Application Support/KingLouie/logs', user: '_kinglouie' });
    assert.match(plist, /<key>Label<\/key>\s*<string>com.kinglouie.service<\/string>/);
    assert.match(plist, /<key>UserName<\/key>\s*<string>_kinglouie<\/string>/);
    assert.match(plist, /<string>\/Library\/Application Support\/KingLouie<\/string>/);
  });
  it('escapes XML in paths', () => {
    assert.match(renderLaunchdPlist({ ...base, dataDir: '/a&b', logsDir: '/a&b/logs' }), /\/a&amp;b/);
  });
  it('propagates --profile into ProgramArguments', () => {
    const plist = renderLaunchdPlist({ ...base, dataDir: '/Library/Application Support/KingLouie', logsDir: '/Library/Application Support/KingLouie/logs', user: '_kinglouie', profile: 'runbook' });
    assert.match(plist, /<string>--profile<\/string>\s*<string>runbook<\/string>/);
  });
});

describe('Windows task', () => {
  it('starts at boot as LOCAL SERVICE with restart on failure, and passes --profile', () => {
    const xml = renderWindowsTaskXml({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.match(xml, /<BootTrigger>/);
    assert.match(xml, /<UserId>S-1-5-19<\/UserId>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<RestartOnFailure>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<Arguments>"C:\\kl\\bin\\king-louie-service\.js" run --data-dir "C:\\ProgramData\\KingLouie" --profile agent<\/Arguments>/);
  });
  it('propagates a non-default --profile', () => {
    const xml = renderWindowsTaskXml({ nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie', profile: 'runbook' });
    assert.match(xml, /--profile runbook<\/Arguments>/);
  });
  it('resolves a trailing backslash off the data dir', () => {
    const xml = renderWindowsTaskXml({ nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie\\' });
    assert.match(xml, /--data-dir "C:\\ProgramData\\KingLouie"/);
  });
  it('rejects a data dir containing a double quote', () => {
    assert.throws(() => renderWindowsTaskXml({ nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\Evil"Dir' }), /double quote/);
  });
});

describe('install plans', () => {
  it('linux: creates the user, the credential and the unit, then enables it', () => {
    const steps = planInstall({ platform: 'linux', ...base, profile: 'runbook' });
    const text = steps.map((s) => s.description).join('\n');
    assert.match(text, /service user/);
    assert.match(text, /master key credential/);
    const unit = steps.find((s) => s.writeFile?.path === '/etc/systemd/system/king-louie.service');
    assert.ok(unit);
    assert.ok(steps.some((s) => s.run && s.run.join(' ') === 'systemctl enable --now king-louie.service'));
    const cred = steps.find((s) => s.writeFile?.path === '/etc/king-louie/credentials/kl-master-key');
    assert.strictEqual(cred.writeFile.mode, 0o600);
    assert.match(cred.writeFile.content, /^[0-9a-f]{64}$/);
  });
  it('windows: locks down the data dir ACL and registers the task', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.strictEqual(steps[0].mkdir, 'C:\\ProgramData\\KingLouie');
    assert.ok(steps.some((s) => s.run?.[0] === 'icacls' && s.run.includes('/inheritance:r')));
    assert.ok(steps.some((s) => s.run?.[0] === 'schtasks' && s.run.includes('/Create')));
  });
  it('darwin: requires --user', () => {
    assert.throws(() => planInstall({ platform: 'darwin', ...base, user: undefined }), /--user is required on macOS/);
  });
  it('uninstall plans exist for every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32']) assert.ok(planUninstall({ platform }).length > 0);
  });
});

describe('executeSteps', () => {
  it('dry-run prints and performs nothing', async () => {
    const out = [];
    await executeSteps([{ description: 'do a thing', run: ['definitely-not-a-command'] }], { dryRun: true, io: { stdout: { write: (s) => out.push(s) } } });
    assert.match(out.join(''), /\[dry-run\] do a thing: definitely-not-a-command/);
  });
});

// --- Fix round 1: reviewer-found defects -----------------------------------

describe('profile validation', () => {
  it('planInstall rejects an unknown profile on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.throws(() => planInstall({ platform, ...base, profile: 'bogus' }), /Unknown profile/);
    }
  });
});

describe('systemd unit hostile inputs', () => {
  const hostile = { newline: 'a\nb', 'carriage return': 'a\rb', space: 'a b', percent: 'a%b', dollar: 'a$b', backslash: 'a\\b', quote: 'a"b' };
  for (const [label, value] of Object.entries(hostile)) {
    it(`rejects a dataDir containing a ${label}`, () => {
      assert.throws(() => renderSystemdUnit({ ...base, dataDir: `/var/lib/${value}` }), /dataDir/);
    });
    it(`rejects a nodePath containing a ${label}`, () => {
      assert.throws(() => renderSystemdUnit({ ...base, nodePath: `/usr/bin/${value}` }), /nodePath/);
    });
    it(`rejects an entryPath containing a ${label}`, () => {
      assert.throws(() => renderSystemdUnit({ ...base, entryPath: `/opt/${value}` }), /entryPath/);
    });
  }
  it('requires an absolute POSIX dataDir', () => {
    assert.throws(() => renderSystemdUnit({ ...base, dataDir: 'relative/dir' }), /absolute/);
  });
  it('planInstall(linux) rejects a dataDir with a control character', () => {
    assert.throws(() => planInstall({ platform: 'linux', ...base, dataDir: '/var/lib/king-louie\n' }), /dataDir/);
  });
  it('planInstall(linux) resolves a relative dataDir to an absolute one instead of rejecting it', () => {
    const steps = planInstall({ platform: 'linux', ...base, dataDir: 'relative-data-dir' });
    const unit = steps.find((s) => s.writeFile?.path === '/etc/systemd/system/king-louie.service');
    assert.match(unit.writeFile.content, /^ReadWritePaths=\//m);
  });
});

describe('--user validation', () => {
  it('rejects a user name with disallowed characters', () => {
    assert.throws(() => planInstall({ platform: 'linux', ...base, user: 'Bad User!' }), /Invalid --user/);
  });
  it('rejects a user name starting with a digit', () => {
    assert.throws(() => planInstall({ platform: 'linux', ...base, user: '1king' }), /Invalid --user/);
  });
  it('rejects "root"', () => {
    assert.throws(() => planInstall({ platform: 'darwin', ...base, user: 'root' }), /must not be "root"/);
  });
  it('accepts a valid user with underscore, digits and a hyphen', () => {
    const steps = planInstall({ platform: 'linux', ...base, user: 'kl_svc-01' });
    assert.ok(steps.length > 0);
  });
});

describe('darwin: verifies the account before writing anything', () => {
  it('plans an "id -u" check as the very first step', () => {
    const steps = planInstall({ platform: 'darwin', ...base, user: '_kinglouie' });
    assert.deepStrictEqual(steps[0], { description: 'verify the service account exists', run: ['id', '-u', '_kinglouie'] });
  });
});

describe('linux reinstall safety', () => {
  it('models user creation as runUnless so a second install does not re-run useradd', () => {
    const steps = planInstall({ platform: 'linux', ...base });
    const create = steps.find((s) => s.description === 'create the service user');
    assert.deepStrictEqual(create.runUnless, {
      check: ['id', '-u', 'king-louie'],
      run: ['useradd', '--system', '--home-dir', base.dataDir, '--shell', '/usr/sbin/nologin', 'king-louie']
    });
  });
  it('never overwrites an existing master key credential', () => {
    const steps = planInstall({ platform: 'linux', ...base });
    const cred = steps.find((s) => s.writeFile?.path === '/etc/king-louie/credentials/kl-master-key');
    assert.strictEqual(cred.writeFile.overwrite, false);
  });
});

describe('Windows install plan fixes', () => {
  const win = { nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' };

  it('writes the task definition as UTF-16LE with a BOM', () => {
    const steps = planInstall({ platform: 'win32', ...win });
    const write = steps.find((s) => s.description === 'write the task definition');
    assert.strictEqual(write.writeFile.encoding, 'utf16le');
    assert.ok(write.writeFile.content.startsWith('\ufeff'));
  });

  it('writes the task XML to a random temp path (not the data dir) and cleans it up after registering', () => {
    const steps = planInstall({ platform: 'win32', ...win });
    const write = steps.find((s) => s.description === 'write the task definition');
    const tmpDir = path.win32.resolve(os.tmpdir());
    assert.ok(write.writeFile.path.toLowerCase().startsWith(tmpDir.toLowerCase()));
    assert.ok(!write.writeFile.path.toLowerCase().startsWith('c:\\programdata\\kinglouie'));
    const register = steps.find((s) => s.run?.[0] === 'schtasks' && s.run.includes('/Create'));
    assert.strictEqual(register.run[register.run.indexOf('/XML') + 1], write.writeFile.path);
    const del = steps.find((s) => s.unlink === write.writeFile.path);
    assert.ok(del, 'expected a step that deletes the temp task XML');
    assert.ok(steps.indexOf(del) > steps.indexOf(register), 'delete must come after register');
    assert.strictEqual(del.always, true, 'cleanup must still run after an earlier failure');
    assert.strictEqual(del.ignoreFailure, true, 'a failed cleanup must not itself abort the install');
  });

  it('grants recursively, and reclaims ownership before resetting and re-granting the ACL', () => {
    const steps = planInstall({ platform: 'win32', ...win });
    const grant = steps.find((s) => s.run?.[0] === 'icacls' && s.run.includes('/grant:r'));
    assert.ok(grant.run.includes('/T'), 'grant step must recurse with /T');
    const setowner = steps.find((s) => s.run?.[0] === 'icacls' && s.run.includes('/setowner'));
    assert.ok(setowner, 'expected an icacls /setowner step');
    assert.ok(setowner.run.includes('*S-1-5-32-544'));
    assert.ok(setowner.run.includes('/T'));
    assert.ok(steps.indexOf(setowner) < steps.indexOf(grant), 'ownership must be reclaimed before the ACL grant, not after');
  });

  it('runs the ACL fix as exactly setowner, then reset, then inheritance:r/grant:r, in that order', () => {
    const steps = planInstall({ platform: 'win32', ...win });
    const mkdirIdx = steps.findIndex((s) => s.mkdir === win.dataDir);
    const icaclsSteps = steps.filter((s) => s.run?.[0] === 'icacls');
    assert.strictEqual(icaclsSteps.length, 3, 'expected exactly 3 icacls steps');
    assert.deepStrictEqual(icaclsSteps[0].run, ['icacls', win.dataDir, '/setowner', '*S-1-5-32-544', '/T']);
    assert.deepStrictEqual(icaclsSteps[1].run, ['icacls', win.dataDir, '/reset', '/T']);
    assert.deepStrictEqual(icaclsSteps[2].run, [
      'icacls', win.dataDir, '/inheritance:r', '/grant:r',
      '*S-1-5-19:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/T'
    ]);
    // And all three come after mkdir, in plan order.
    assert.ok(mkdirIdx < steps.indexOf(icaclsSteps[0]));
    assert.ok(steps.indexOf(icaclsSteps[0]) < steps.indexOf(icaclsSteps[1]));
    assert.ok(steps.indexOf(icaclsSteps[1]) < steps.indexOf(icaclsSteps[2]));
  });

  it('resolves a trailing backslash and rejects a quote in the plan\'s dataDir too', () => {
    const steps = planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\KingLouie\\' });
    assert.strictEqual(steps[0].mkdir, 'C:\\ProgramData\\KingLouie');
    assert.throws(() => planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\Evil"Dir' }), /double quote/);
  });
});

describe('root guard: dataDir must have at least 2 path components below root', () => {
  const win = { nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js' };
  const posix = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', user: 'king-louie' };

  it('rejects Windows roots: C:\\ and C:\\Windows', () => {
    assert.throws(() => planInstall({ platform: 'win32', ...win, dataDir: 'C:\\' }), /too close to the filesystem root/);
    assert.throws(() => planInstall({ platform: 'win32', ...win, dataDir: 'C:\\Windows' }), /too close to the filesystem root/);
  });
  it('rejects a bare UNC share root: \\\\srv\\share\\', () => {
    assert.throws(() => planInstall({ platform: 'win32', ...win, dataDir: '\\\\srv\\share\\' }), /too close to the filesystem root/);
  });
  it('accepts the Windows default: C:\\ProgramData\\KingLouie', () => {
    const steps = planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.ok(steps.length > 0);
  });

  it('rejects POSIX roots: / and /etc', () => {
    assert.throws(() => planInstall({ platform: 'linux', ...posix, dataDir: '/' }), /too close to the filesystem root/);
    assert.throws(() => planInstall({ platform: 'linux', ...posix, dataDir: '/etc' }), /too close to the filesystem root/);
    assert.throws(() => planInstall({ platform: 'darwin', ...posix, dataDir: '/' }), /too close to the filesystem root/);
  });
  it('accepts the Linux and macOS defaults', () => {
    assert.ok(planInstall({ platform: 'linux', ...posix, dataDir: '/var/lib/king-louie' }).length > 0);
    assert.ok(planInstall({ platform: 'darwin', ...posix, dataDir: '/Library/Application Support/KingLouie' }).length > 0);
  });
  it('accepts the built-in per-platform default when --data-dir is omitted', () => {
    assert.ok(planInstall({ platform: 'linux', ...posix }).length > 0);
    assert.ok(planInstall({ platform: 'darwin', ...posix }).length > 0);
    assert.ok(planInstall({ platform: 'win32', ...win }).length > 0);
  });
});

describe('Windows mkdir refuses an existing symlink/junction', () => {
  it('dry-run notes that the check will happen, without doing it', async () => {
    const t = io();
    await executeSteps([{ description: 'create the data dir', mkdir: 'C:\\ProgramData\\KingLouie' }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /symlink\/junction/);
  });

  it('real mode creates a plain directory normally', async () => {
    const dir = path.join(tmp(), 'plain-dir');
    await executeSteps([{ description: 'mk', mkdir: dir }], { dryRun: false, io: io() });
    assert.ok(fs.statSync(dir).isDirectory());
  });

  it('real mode refuses when the path already exists and is a symlink/junction', async () => {
    const base2 = tmp();
    const target = path.join(base2, 'real-target');
    fs.mkdirSync(target);
    const link = path.join(base2, 'link-as-datadir');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const t = io();
    await assert.rejects(
      () => executeSteps([{ description: 'create the data dir', mkdir: link }], { dryRun: false, io: t }),
      /symlink or junction/
    );
  });
});

describe('executeSteps: always steps', () => {
  it('an always step still runs after an earlier step fails, and the original error is rethrown', async () => {
    const dir = tmp();
    const markerFile = path.join(dir, 'cleanup-ran.txt');
    const skippedFile = path.join(dir, 'should-be-skipped.txt');
    const steps = [
      { description: 'this fails', run: [process.execPath, '-e', 'process.exit(1)'] },
      { description: 'this must be skipped (not always, comes after the failure)', writeFile: { path: skippedFile, content: 'x', mode: 0o644 } },
      { description: 'cleanup marker (always)', always: true, writeFile: { path: markerFile, content: 'ran', mode: 0o644 } }
    ];
    await assert.rejects(() => executeSteps(steps, { dryRun: false, io: io() }));
    assert.ok(fs.existsSync(markerFile), 'the always step should have run despite the earlier failure');
    assert.ok(!fs.existsSync(skippedFile), 'a non-always step after the failure should have been skipped');
  });

  it('a failing temp-XML unlink (always + ignoreFailure) does not block the step after it', async () => {
    const t = io();
    const calls = [];
    const execFile = (cmd, args) => calls.push([cmd, ...args].join(' '));
    const steps = [
      { description: 'register the boot task', run: ['schtasks', '/Create'] },
      // Points at a file that was never created, so the real fs.unlinkSync
      // call below genuinely fails (ENOENT) — a harmless, temp-only failure.
      { description: 'delete the temporary task definition', unlink: path.join(tmp(), 'does-not-exist.xml'), always: true, ignoreFailure: true },
      { description: 'start it now', run: ['schtasks', '/Run'] }
    ];
    await executeSteps(steps, { dryRun: false, io: t, execFile });
    assert.deepStrictEqual(calls, ['schtasks /Create', 'schtasks /Run']);
    assert.match(t.out.join(''), /ignoring failure/);
  });

  it('dry-run never triggers the always/pendingError machinery (every step just prints)', async () => {
    const t = io();
    const steps = [
      { description: 'this would fail for real', run: ['definitely-not-a-command'] },
      { description: 'this is not always', run: ['also-not-a-command'] },
      { description: 'cleanup marker (always)', always: true, run: ['still-not-a-command'] }
    ];
    await executeSteps(steps, { dryRun: true, io: t });
    const out = t.out.join('');
    assert.match(out, /this would fail for real/);
    assert.match(out, /this is not always/);
    assert.match(out, /cleanup marker \(always\)/);
  });
});

describe('uninstall: Windows tolerates a task that is not running', () => {
  it('marks "schtasks /End" as ignoreFailure', () => {
    const steps = planUninstall({ platform: 'win32' });
    const stop = steps.find((s) => s.run?.join(' ') === 'schtasks /End /TN KingLouie');
    assert.strictEqual(stop.ignoreFailure, true);
  });
});

describe('home-directory install warning', () => {
  it('warns (but does not block) when entryPath is under /home', () => {
    const steps = planInstall({ platform: 'linux', nodePath: '/usr/bin/node', entryPath: '/home/dev/king-louie-service.js', dataDir: '/var/lib/king-louie', user: 'king-louie' });
    assert.strictEqual(steps[0].warn, true);
    assert.match(steps[0].description, /WARNING/);
  });
  it('warns when nodePath is under C:\\Users\\', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\Users\\dev\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.strictEqual(steps[0].warn, true);
  });
  it('does not warn for system paths', () => {
    const steps = planInstall({ platform: 'linux', ...base });
    assert.notStrictEqual(steps[0].warn, true);
  });
});

describe('executeSteps: warn steps', () => {
  it('prints the warning and never executes, in dry-run mode', async () => {
    const t = io();
    const execFile = () => { throw new Error('should not be called'); };
    await executeSteps([{ description: 'WARNING: test warning', warn: true }], { dryRun: true, io: t, execFile });
    assert.match(t.out.join(''), /WARNING: test warning/);
  });
  it('prints the warning and never executes, in real mode', async () => {
    const t = io();
    const execFile = () => { throw new Error('should not be called'); };
    await executeSteps([{ description: 'WARNING: test warning', warn: true }], { dryRun: false, io: t, execFile });
    assert.match(t.out.join(''), /WARNING: test warning/);
  });
});

describe('executeSteps: runUnless', () => {
  it('dry-run prints both the check and the run command', async () => {
    const t = io();
    await executeSteps([{ description: 'create the service user', runUnless: { check: ['id', '-u', 'king-louie'], run: ['useradd', 'king-louie'] } }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\] create the service user: check id -u king-louie; if that fails, run useradd king-louie/);
  });
  it('skips the run command when the check (fake) succeeds', async () => {
    const t = io();
    const calls = [];
    const execFile = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd !== 'id') throw new Error('run should not have been called');
    };
    await executeSteps([{ description: 'create the service user', runUnless: { check: ['id', '-u', 'king-louie'], run: ['useradd', 'king-louie'] } }], { dryRun: false, io: t, execFile });
    assert.deepStrictEqual(calls, ['id -u king-louie']);
    assert.match(t.out.join(''), /already present, skipping/);
  });
  it('runs the run command when the check (fake) fails', async () => {
    const t = io();
    const calls = [];
    const execFile = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'id') throw new Error('no such user');
    };
    await executeSteps([{ description: 'create the service user', runUnless: { check: ['id', '-u', 'king-louie'], run: ['useradd', 'king-louie'] } }], { dryRun: false, io: t, execFile });
    assert.deepStrictEqual(calls, ['id -u king-louie', 'useradd king-louie']);
  });
  it('real mode against real (harmless) child processes: a failing check runs the run command', async () => {
    const t = io();
    await executeSteps([{
      description: 'demo runUnless',
      runUnless: { check: [process.execPath, '-e', 'process.exit(1)'], run: [process.execPath, '-e', 'process.exit(0)'] }
    }], { dryRun: false, io: t });
    assert.match(t.out.join(''), /demo runUnless/);
  });
  it('real mode against real (harmless) child processes: a succeeding check skips the run command', async () => {
    const t = io();
    await executeSteps([{
      description: 'demo runUnless',
      runUnless: { check: [process.execPath, '-e', 'process.exit(0)'], run: [process.execPath, '-e', 'process.exit(1)'] }
    }], { dryRun: false, io: t });
    // If the (failing) run command had actually executed, executeSteps would reject.
    assert.match(t.out.join(''), /already present, skipping/);
  });
});

describe('executeSteps: ignoreFailure', () => {
  it('propagates a run failure by default', async () => {
    const t = io();
    const execFile = () => { throw new Error('boom'); };
    await assert.rejects(() => executeSteps([{ description: 'do a thing', run: ['x'] }], { dryRun: false, io: t, execFile }));
  });
  it('swallows a (fake) run failure when ignoreFailure is set', async () => {
    const t = io();
    const execFile = () => { throw new Error('boom'); };
    await executeSteps([{ description: 'stop the task', run: ['schtasks', '/End'], ignoreFailure: true }], { dryRun: false, io: t, execFile });
    assert.match(t.out.join(''), /ignoring failure: boom/);
  });
  it('swallows a real (harmless) failing command when ignoreFailure is set', async () => {
    const t = io();
    await executeSteps([{ description: 'stop the task', run: [process.execPath, '-e', 'process.exit(1)'], ignoreFailure: true }], { dryRun: false, io: t });
    assert.match(t.out.join(''), /ignoring failure/);
  });
  it('dry-run notes that a failure would be ignored', async () => {
    const t = io();
    await executeSteps([{ description: 'stop the task', run: ['schtasks', '/End'], ignoreFailure: true }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\(failure ignored\)/);
  });
});

describe('executeSteps: writeFile overwrite and encoding', () => {
  it('does not overwrite an existing file when overwrite is false', async () => {
    const dir = tmp();
    const file = path.join(dir, 'kl-master-key');
    fs.writeFileSync(file, 'original-secret');
    const t = io();
    await executeSteps([{ description: 'write the master key credential', writeFile: { path: file, content: 'new-secret', mode: 0o600, overwrite: false } }], { dryRun: false, io: t });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original-secret');
    assert.match(t.out.join(''), /already exists, leaving in place/);
  });

  it('overwrites when overwrite is left at its default (true)', async () => {
    const dir = tmp();
    const file = path.join(dir, 'unit');
    fs.writeFileSync(file, 'old');
    await executeSteps([{ description: 'write the unit', writeFile: { path: file, content: 'new', mode: 0o644 } }], { dryRun: false, io: io() });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  });

  it('writes UTF-16LE content with a BOM to disk', async () => {
    const dir = tmp();
    const file = path.join(dir, 'task.xml');
    const xmlContent = '\ufeff<Task/>';
    await executeSteps([{ description: 'write the task definition', writeFile: { path: file, content: xmlContent, mode: 0o644, encoding: 'utf16le' } }], { dryRun: false, io: io() });
    const bytes = fs.readFileSync(file);
    assert.strictEqual(bytes[0], 0xff);
    assert.strictEqual(bytes[1], 0xfe);
    assert.strictEqual(fs.readFileSync(file, 'utf16le'), xmlContent);
  });

  if (process.platform !== 'win32') {
    it('chmods a freshly written file to the exact requested mode', async () => {
      const dir = tmp();
      const file = path.join(dir, 'cred');
      await executeSteps([{ description: 'write cred', writeFile: { path: file, content: 'x', mode: 0o600 } }], { dryRun: false, io: io() });
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    });
  }
});

describe('executeSteps: mkdir and unlink', () => {
  it('dry-run prints mkdir steps', async () => {
    const t = io();
    await executeSteps([{ description: 'create the data dir', mkdir: 'C:\\ProgramData\\KingLouie' }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\] create the data dir: mkdir C:\\ProgramData\\KingLouie/);
  });
  it('dry-run prints unlink steps', async () => {
    const t = io();
    await executeSteps([{ description: 'delete the temporary task definition', unlink: 'C:\\Temp\\x.xml' }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\] delete the temporary task definition: unlink C:\\Temp\\x\.xml/);
  });
  it('real mode creates and removes files/dirs, against a temp dir only', async () => {
    const dir = path.join(tmp(), 'nested', 'dir');
    const base2 = tmp();
    const file = path.join(base2, 'to-delete.txt');
    fs.writeFileSync(file, 'x');
    await executeSteps([{ description: 'mk', mkdir: dir }, { description: 'rm', unlink: file }], { dryRun: false, io: io() });
    assert.ok(fs.statSync(dir).isDirectory());
    assert.ok(!fs.existsSync(file));
  });
});
