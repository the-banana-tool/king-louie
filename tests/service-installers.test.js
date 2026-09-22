const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml, planInstall, planUninstall, executeSteps
} = require('../src/service/installers');

const base = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', dataDir: '/var/lib/king-louie', user: 'king-louie' };

function io() {
  const out = [];
  return { out, stdout: { write: (s) => out.push(String(s)) } };
}
// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-installers-'));
  createdTempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The absolute executables the Windows plans must use (see installers.js).
const SYSTEM_ROOT = process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows';
const POWERSHELL_EXE = path.win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCHTASKS_EXE = path.win32.join(SYSTEM_ROOT, 'System32', 'schtasks.exe');

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
  it('windows: creates/verifies the data dir ACL via PowerShell and registers the task', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.strictEqual(steps[0].run[0], POWERSHELL_EXE);
    assert.strictEqual(steps[0].env.KL_DATA_DIR, 'C:\\ProgramData\\KingLouie');
    assert.ok(steps.some((s) => s.run?.[0] === SCHTASKS_EXE && s.run.includes('/Create')));
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
    const register = steps.find((s) => s.run?.[0] === SCHTASKS_EXE && s.run.includes('/Create'));
    assert.strictEqual(register.run[register.run.indexOf('/XML') + 1], write.writeFile.path);
    const del = steps.find((s) => s.unlink === write.writeFile.path);
    assert.ok(del, 'expected a step that deletes the temp task XML');
    assert.ok(steps.indexOf(del) > steps.indexOf(register), 'delete must come after register');
    assert.strictEqual(del.always, true, 'cleanup must still run after an earlier failure');
    assert.strictEqual(del.ignoreFailure, true, 'a failed cleanup must not itself abort the install');
  });

  it('resolves a trailing backslash and rejects a quote in the plan\'s dataDir too', () => {
    const steps = planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\KingLouie\\' });
    assert.strictEqual(steps[0].env.KL_DATA_DIR, 'C:\\ProgramData\\KingLouie');
    assert.throws(() => planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\Evil"Dir' }), /double quote/);
  });
});

// --- Fix round 3: single-PowerShell-step ACL redesign ----------------------
//
// Round 2's mkdir-then-icacls*3 approach was structurally unsafe: each
// separate icacls process after a symlink check left a TOCTOU window, and
// `icacls /reset` on an existing dir briefly re-enabled inherited ACEs. It's
// replaced by one elevated PowerShell step that either creates the dir with
// its final ACL already attached, or — if it exists — only ever verifies
// that ACL, never modifies it.

describe('Windows: single PowerShell step creates/verifies the data dir ACL', () => {
  const win = { nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' };

  function aclStep(dataDir = win.dataDir) {
    const steps = planInstall({ platform: 'win32', ...win, dataDir });
    return steps.find((s) => s.description === 'create or verify the data dir with a locked-down ACL');
  }

  it('is the very first step (before mkdir/icacls — there is no separate mkdir step anymore)', () => {
    const steps = planInstall({ platform: 'win32', ...win });
    assert.strictEqual(steps[0].description, 'create or verify the data dir with a locked-down ACL');
    assert.strictEqual(steps.filter((s) => s.run?.[0] === 'icacls').length, 0, 'icacls must not appear anywhere in the plan');
  });

  it('runs <SystemRoot>\\System32\\...\\powershell.exe -NoProfile -NonInteractive -Command <script>, with no other run steps for the ACL', () => {
    const step = aclStep();
    assert.deepStrictEqual(step.run.slice(0, 4), [POWERSHELL_EXE, '-NoProfile', '-NonInteractive', '-Command']);
    assert.strictEqual(step.run.length, 5, 'expected exactly one script argument after -Command');
    assert.strictEqual(typeof step.run[4], 'string');
  });

  it('passes the data dir through env.KL_DATA_DIR, never interpolated into the script text', () => {
    const dataDir = 'C:\\ProgramData\\KingLouie';
    const step = aclStep(dataDir);
    assert.strictEqual(step.env.KL_DATA_DIR, dataDir);
    assert.ok(!step.run[4].includes(dataDir), 'the script text must not contain the literal data dir');
    assert.ok(!step.run[4].includes('ProgramData'), 'the script text must not contain any part of the literal data dir');
  });

  it('the script reads the path from $env:KL_DATA_DIR', () => {
    assert.match(aclStep().run[4], /\$env:KL_DATA_DIR/);
  });

  it('the script\'s SDDL is exactly the ruling\'s string', () => {
    assert.ok(aclStep().run[4].includes('O:BAD:P(A;OICI;FA;;;LS)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'));
  });

  it('the script checks the data dir for a reparse point (symlink/junction) before verifying its ACL', () => {
    const script = aclStep().run[4];
    const verifyIdx = script.indexOf('# VERIFY');
    const reparseIdx = script.indexOf('it is a symlink or junction', verifyIdx);
    const daclIdx = script.indexOf('.DiscretionaryAcl', verifyIdx);
    assert.ok(verifyIdx > 0 && reparseIdx > verifyIdx && daclIdx > reparseIdx, 'the reparse-point check must come before the DACL is judged');
  });

  // --- Fix round 4: TOCTOU on the create branch, raw DACL, ancestors ------

  it('the script has exactly one "exit 0", and it comes after the create call and every verification check', () => {
    const script = aclStep().run[4];
    const exits = [...script.matchAll(/exit 0/g)].map((m) => m.index);
    assert.strictEqual(exits.length, 1, 'no early exit 0 may short-circuit verification');
    const createIdx = script.indexOf('[System.IO.Directory]::CreateDirectory($path, $ds)');
    const verifyIdx = script.indexOf('# VERIFY');
    assert.ok(createIdx > 0 && verifyIdx > createIdx, 'verification must follow the create call');
    for (const marker of ['it is a symlink or junction', 'foreach ($ace in $dacl)', 'DiscretionaryAclProtected', '$dirOwners -notcontains $ownerSid', 'Assert-SafeAncestors $path $true']) {
      const idx = script.indexOf(marker, verifyIdx);
      assert.ok(idx > verifyIdx, `missing verification step after the create: ${marker}`);
      assert.ok(idx < exits[0], `verification step must run before exit 0: ${marker}`);
    }
    // The create branch closes before # VERIFY, so both branches fall through to it.
    const createBranch = script.slice(createIdx, verifyIdx);
    assert.ok(!/\bexit\b|\breturn\b/.test(createBranch), 'the create branch must not exit/return before verification');
  });

  it('the script judges the raw DACL (RawSecurityDescriptor), not Get-Acl\'s .Access view, and only allows plain allow ACEs', () => {
    const script = aclStep().run[4];
    assert.match(script, /RawSecurityDescriptor/);
    assert.ok(!/Get-Acl/.test(script), 'Get-Acl follows junctions and hides ACE types');
    assert.ok(!/\.Access\b/.test(script));
    assert.match(script, /\$ace -is \[System\.Security\.AccessControl\.CommonAce\]/);
    assert.match(script, /\$ace\.AceType -ne \[System\.Security\.AccessControl\.AceType\]::AccessAllowed/);
    assert.ok(script.includes("$aceSids = @('S-1-5-19','S-1-5-18','S-1-5-32-544')"));
  });

  it('the script checks ancestors (owner BA/SY/TrustedInstaller, no reparse points) before creating and again when verifying', () => {
    const script = aclStep().run[4];
    assert.ok(script.includes("$ancestorOwners = @('S-1-5-32-544','S-1-5-18','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')"));
    const pre = script.indexOf('Assert-SafeAncestors $path $false');
    const create = script.indexOf('[System.IO.Directory]::CreateDirectory($path, $ds)');
    const post = script.indexOf('Assert-SafeAncestors $path $true');
    assert.ok(pre > 0 && pre < create && create < post);
  });

  it('the script reads attributes and the security descriptor through one no-follow handle', () => {
    const script = aclStep().run[4];
    assert.match(script, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(script, /GetSecurityInfo\(h,/);
    assert.ok(!/Get-Item|Test-Path/.test(script), 'no path-based (link-following) existence/attribute checks');
  });

  it('the script never calls Set-Acl / icacls / anything that would modify an existing dir\'s ACL', () => {
    const script = aclStep().run[4];
    assert.ok(!/Set-Acl/i.test(script));
    assert.ok(!/icacls/i.test(script));
  });

  it('dry-run prints KL_DATA_DIR in the env before the argv', async () => {
    const t = io();
    const step = aclStep('C:\\ProgramData\\KingLouie');
    await executeSteps([step], { dryRun: true, io: t });
    assert.ok(t.out.join('').includes(`KL_DATA_DIR=C:\\ProgramData\\KingLouie ${POWERSHELL_EXE} -NoProfile`));
  });
});

describe('Windows: every executable in the plans is an absolute System32 path', () => {
  const win = { nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie' };
  const runSteps = () => [...planInstall({ platform: 'win32', ...win }), ...planUninstall({ platform: 'win32' })].filter((s) => s.run);

  it('uses %SystemRoot%\\System32\\...\\powershell.exe and %SystemRoot%\\System32\\schtasks.exe, never a bare name', () => {
    const argv0 = runSteps().map((s) => s.run[0]);
    assert.ok(argv0.length >= 5);
    for (const exe of argv0) {
      assert.ok(path.win32.isAbsolute(exe), `not absolute: ${exe}`);
      assert.ok([POWERSHELL_EXE, SCHTASKS_EXE].includes(exe), `unexpected executable: ${exe}`);
    }
  });

  for (const [label, value] of [['unset', undefined], ['relative', 'Windows']]) {
    it(`falls back to C:\\Windows when SystemRoot is ${label}`, () => {
      const saved = process.env.SystemRoot;
      try {
        if (value === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = value;
        const argv0 = runSteps().map((s) => s.run[0]);
        assert.ok(argv0.includes('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
        assert.ok(argv0.includes('C:\\Windows\\System32\\schtasks.exe'));
      } finally {
        if (saved === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = saved;
      }
    });
  }

  it('follows a non-default absolute SystemRoot', () => {
    const saved = process.env.SystemRoot;
    try {
      process.env.SystemRoot = 'D:\\WinNT';
      const argv0 = runSteps().map((s) => s.run[0]);
      assert.ok(argv0.includes('D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
      assert.ok(argv0.includes('D:\\WinNT\\System32\\schtasks.exe'));
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
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
  it('accepts the Windows default (C:\\ProgramData\\KingLouie\\data) and the parent-level C:\\ProgramData\\KingLouie', () => {
    assert.ok(planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\KingLouie\\data' }).length > 0);
    const steps = planInstall({ platform: 'win32', ...win, dataDir: 'C:\\ProgramData\\KingLouie' });
    assert.ok(steps.length > 0);
  });

  it('rejects POSIX roots: / and /etc', () => {
    assert.throws(() => planInstall({ platform: 'linux', ...posix, dataDir: '/' }), /too close to the filesystem root/);
    assert.throws(() => planInstall({ platform: 'linux', ...posix, dataDir: '/etc' }), /too close to the filesystem root/);
    assert.throws(() => planInstall({ platform: 'darwin', ...posix, dataDir: '/' }), /too close to the filesystem root/);
  });
  it('rejects dot-segment paths that normalize to a root: /etc/.., /tmp/../etc, /./etc, /etc/. (linux and darwin)', () => {
    // Regression: the root guard used to only resolve *relative* dataDir
    // values, so an already-absolute path with ".." or "." segments (e.g.
    // "/etc/..", which normalizes to "/") slipped past it unresolved —
    // "/etc/.." would have chowned "/". Always normalizing with
    // path.posix.resolve() before validating closes this.
    for (const bad of ['/etc/..', '/tmp/../etc', '/./etc', '/etc/.']) {
      assert.throws(() => planInstall({ platform: 'linux', ...posix, dataDir: bad }), /too close to the filesystem root/, `linux: ${bad}`);
      assert.throws(() => planInstall({ platform: 'darwin', ...posix, dataDir: bad }), /too close to the filesystem root/, `darwin: ${bad}`);
    }
  });
  it('accepts the Linux and macOS defaults', () => {
    assert.ok(planInstall({ platform: 'linux', ...posix, dataDir: '/var/lib/king-louie' }).length > 0);
    assert.ok(planInstall({ platform: 'darwin', ...posix, dataDir: '/Library/Application Support/KingLouie/data' }).length > 0);
  });
  it('accepts the built-in per-platform default when --data-dir is omitted', () => {
    assert.ok(planInstall({ platform: 'linux', ...posix }).length > 0);
    assert.ok(planInstall({ platform: 'darwin', ...posix }).length > 0);
    assert.ok(planInstall({ platform: 'win32', ...win }).length > 0);
  });
});

describe('darwin: the new absolute/char validation', () => {
  const posixArgs = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', user: 'king-louie' };

  it('still accepts its default, which contains a space, after normalization', () => {
    const steps = planInstall({ platform: 'darwin', ...posixArgs, dataDir: '/Library/Application Support/KingLouie/data' });
    assert.ok(steps.length > 0);
  });
  it('rejects a dataDir with a control character', () => {
    assert.throws(
      () => planInstall({ platform: 'darwin', ...posixArgs, dataDir: '/Library/Application Support/KingLouie\n' }),
      /dataDir/
    );
  });
  it('rejects a non-absolute dataDir (after normalization still requires a leading /)', () => {
    // path.posix.resolve() always yields an absolute path from any input, so
    // this specifically exercises assertAbsolutePosixPath's error message
    // rather than expecting a relative path to reach it.
    assert.throws(() => planInstall({ platform: 'darwin', ...posixArgs, dataDir: '/' }), /too close to the filesystem root/);
  });
});

// --- Real-mode tests for the Windows ACL PowerShell script -----------------
//
// Only meaningful on win32 (the script is powershell.exe-specific), so every
// test in this block is skipped outright on other platforms. The "a fresh
// create passes" tests additionally require an elevated (Administrator)
// process — creating a directory with an O:BA owner fails otherwise ("This
// security ID may not be assigned as the owner of this object") — and are
// skipped with a clear reason when the test process isn't elevated.
//
// Every refusal test works without elevation. They run against dirs under
// os.tmpdir(), whose ancestors (…\AppData\Local\Temp and up) are owned by the
// current user, so a fresh create there correctly fails the ancestor check.
// That is also why the elevated create tests use %SystemRoot%\Temp instead,
// whose ancestor chain is owned by SYSTEM/Administrators/TrustedInstaller.

function isElevatedWindowsProcess() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)'
    ], { encoding: 'utf8' });
    return out.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}
const IS_WIN32 = process.platform === 'win32';
const IS_ELEVATED = isElevatedWindowsProcess();
const notWin32Skip = IS_WIN32 ? false : 'Windows-only (the ACL step runs powershell.exe)';
const notElevatedSkip = !IS_WIN32 ? notWin32Skip : (IS_ELEVATED ? false : 'requires an elevated (Administrator) process to create a dir with an O:BA owner');

function aclScriptStepFor(dataDir) {
  const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir });
  return steps.find((s) => s.description === 'create or verify the data dir with a locked-down ACL');
}

// Runs the real script (real mode, only ever against a path under a temp dir
// this file creates) and captures its exit code/stderr directly, bypassing
// executeSteps' stdio:'inherit' so the script's own error message can be
// asserted on.
function runAclScript(dataDir) {
  const step = aclScriptStepFor(dataDir);
  const env = { ...process.env, ...step.env };
  try {
    execFileSync(step.run[0], step.run.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 1, stderr: String(err.stderr || err.message || '') };
  }
}

// Replaces the DACL (only the DACL — owner stays the current user) of a dir
// this file created. An SDDL of 'D:AI' re-enables inheritance from the temp
// parent, which is how the tests hand access back before deleting.
function setTestDirDacl(dir, sddl) {
  execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', [
    '$ErrorActionPreference = "Stop"',
    '$ds = New-Object System.Security.AccessControl.DirectorySecurity',
    '$ds.SetSecurityDescriptorSddlForm($env:KL_TEST_SDDL, [System.Security.AccessControl.AccessControlSections]::Access)',
    '[System.IO.Directory]::SetAccessControl($env:KL_TEST_DIR, $ds)'
  ].join('; ')], { env: { ...process.env, KL_TEST_DIR: dir, KL_TEST_SDDL: sddl }, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Sets only the owner of a dir this file created to the current user's own
// SID (always permitted: it is in the token). A no-op when not elevated.
function setTestDirOwnerToCurrentUser(dir) {
  execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', [
    '$ErrorActionPreference = "Stop"',
    '$ds = New-Object System.Security.AccessControl.DirectorySecurity',
    '$ds.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)',
    '[System.IO.Directory]::SetAccessControl($env:KL_TEST_DIR, $ds)'
  ].join('; ')], { env: { ...process.env, KL_TEST_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
}

function removeTempTree(base) {
  fs.rmSync(base, { recursive: true, force: true });
  assert.ok(!fs.existsSync(base), `failed to clean up ${base}`);
}

describe('Windows ACL script (real mode, temp dirs only)', () => {
  it('a pre-existing dir with a default ACL is refused (the lost-race outcome: CreateDirectory is a silent no-op, then verification fails)', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      const dir = path.join(base2, 'plain-existing-dir');
      fs.mkdirSync(dir); // inherited, current-user-owned ACL — what an attacker's pre-created dir looks like
      const result = runAclScript(dir);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /ACL is not safe/);
      assert.match(result.stderr, /unexpected ACE for S-1-5-|owner S-1-5-/);
    } finally { removeTempTree(base2); }
  });

  it('a junction is refused', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      const target = path.join(base2, 'junction-target');
      fs.mkdirSync(target);
      const link = path.join(base2, 'junction-as-datadir');
      fs.symlinkSync(target, link, 'junction');
      const result = runAclScript(link);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /symlink or junction/);
    } finally { removeTempTree(base2); }
  });

  it('a dangling junction is refused (inspected as itself, not followed)', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      const link = path.join(base2, 'dangling-junction');
      fs.symlinkSync(path.join(base2, 'does-not-exist'), link, 'junction');
      const result = runAclScript(link);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /symlink or junction/);
      assert.ok(!fs.existsSync(path.join(base2, 'does-not-exist')), 'nothing may be created through the link');
    } finally { removeTempTree(base2); }
  });

  it('a new data dir under a temp parent owned by the current user fails the ancestor check, before anything is created', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      // Elevated, mkdtemp's dir would be owned by Administrators; pin it to
      // the current user so the ancestor check has something to refuse.
      setTestDirOwnerToCurrentUser(base2);
      const dir = path.join(base2, 'fresh-data-dir');
      const result = runAclScript(dir);
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /ancestor directory .+ is not safe: owner S-1-5-\S+ is not Administrators, SYSTEM or TrustedInstaller/);
      assert.ok(!fs.existsSync(dir), 'the ancestor pre-check must run before CreateDirectory');
    } finally { removeTempTree(base2); }
  });

  it('a missing parent (…\\KingLouie\\data with no KingLouie) under a user-owned temp dir is refused before the parent is created', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      setTestDirOwnerToCurrentUser(base2);
      const parent = path.join(base2, 'KingLouie');
      const result = runAclScript(path.join(parent, 'data'));
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /ancestor directory .+ is not safe: owner S-1-5-\S+ is not Administrators, SYSTEM or TrustedInstaller/);
      assert.ok(!fs.existsSync(parent), 'the parent must not be created through an unsafe ancestor');
    } finally { removeTempTree(base2); }
  });

  it('an existing parent owned by the current user is refused (a pre-created KingLouie dir)', { skip: notWin32Skip }, () => {
    const base2 = tmp();
    try {
      const parent = path.join(base2, 'KingLouie');
      fs.mkdirSync(parent);
      setTestDirOwnerToCurrentUser(parent);
      const result = runAclScript(path.join(parent, 'data'));
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /ancestor directory .+ is not safe: owner S-1-5-/);
      assert.ok(!fs.existsSync(path.join(parent, 'data')));
    } finally { removeTempTree(base2); }
  });

  // Raw-DACL unit tests. These run without elevation: the test owns the dir,
  // so it can set any protected DACL on it. The script's no-follow handle
  // needs SYNCHRONIZE | FILE_READ_ATTRIBUTES | READ_CONTROL, which a
  // non-elevated test process only gets from an ACE naming it, so each DACL
  // under test carries a trailing OWNER RIGHTS allow ACE (0x160080, which also
  // keeps WRITE_DAC so cleanup can hand access back). ACE *types* are all
  // checked before any ACE's SID, so the ACE under test is always the one
  // reported, wherever it ends up in the DACL.
  describe('raw DACL checks (no elevation needed)', () => {
    const GOOD = '(A;OICI;FA;;;LS)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
    const OPENABLE = '(A;;0x160080;;;OW)';

    function withDacl(sddl, fn) {
      const base2 = tmp();
      const dir = path.join(base2, 'custom-dacl-dir');
      fs.mkdirSync(dir);
      try {
        setTestDirDacl(dir, sddl);
        fn(runAclScript(dir));
      } finally {
        try { setTestDirDacl(dir, 'D:AI'); } catch { /* best effort; rm below still asserts */ }
        removeTempTree(base2);
      }
    }

    it('rejects a conditional (callback) allow ACE for Everyone, which Get-Acl\'s .Access would list as a plain allow rule', { skip: notWin32Skip }, () => {
      withDacl(`D:P${GOOD}(XA;OICI;FA;;;WD;(Member_of {SID(BA)}))${OPENABLE}`, (result) => {
        assert.notStrictEqual(result.code, 0);
        assert.match(result.stderr, /unexpected ACE of type AccessAllowedCallback/);
      });
    });

    it('rejects a deny ACE', { skip: notWin32Skip }, () => {
      withDacl(`D:P(D;OICI;FA;;;BG)${GOOD}${OPENABLE}`, (result) => {
        assert.notStrictEqual(result.code, 0);
        assert.match(result.stderr, /unexpected ACE of type AccessDenied/);
      });
    });

    it('rejects a plain allow ACE for any SID other than LS/SY/BA', { skip: notWin32Skip }, () => {
      withDacl(`D:P${GOOD}(A;OICI;FA;;;BU)`, (result) => {
        assert.notStrictEqual(result.code, 0);
        assert.match(result.stderr, /unexpected ACE for S-1-5-32-545/);
      });
    });

    it('rejects an unprotected DACL (inherited ACEs flow in from the parent)', { skip: notWin32Skip }, () => {
      withDacl(`D:AI${GOOD}`, (result) => {
        assert.notStrictEqual(result.code, 0);
        assert.match(result.stderr, /unexpected ACE for|inherited access rules are still enabled/);
      });
    });

    // Elevated, the BA ACE does grant this process access (BA is enabled in a
    // full token), so the open succeeds and this scenario can't be staged.
    it('fails closed when the DACL does not let the installer open the dir at all', { skip: IS_ELEVATED ? 'elevated: the BA ACE grants this process access, so the open succeeds' : notWin32Skip }, () => {
      // Non-elevated, LS/SY/BA-only grants nothing this process can use (BA is
      // deny-only in a filtered token), so the no-follow open is refused.
      withDacl(`D:P${GOOD}`, (result) => {
        assert.notStrictEqual(result.code, 0);
        assert.match(result.stderr, /cannot open .+: Access is denied/);
      });
    });
  });

  describe('elevated: a fresh create passes verification', () => {
    // %SystemRoot%\Temp: its ancestors are admin/SYSTEM/TrustedInstaller-owned,
    // unlike os.tmpdir() (see the block comment above).
    const sysTmp = () => fs.mkdtempSync(path.join(SYSTEM_ROOT, 'Temp', 'kl-installers-'));

    it('a fresh create yields a protected DACL with exactly LS/SY/BA and owner BA', { skip: notElevatedSkip }, () => {
      const base2 = sysTmp();
      try {
        const dir = path.join(base2, 'fresh-data-dir');
        const created = runAclScript(dir);
        assert.strictEqual(created.code, 0, `expected a clean create, got: ${created.stderr}`);
        assert.ok(fs.existsSync(dir));

        const inspect = [
          '$acl = Get-Acl -LiteralPath $env:KL_INSPECT_DIR',
          '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
          '$protected = $acl.AreAccessRulesProtected',
          '$rules = ($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) -join ","',
          '[PSCustomObject]@{ Owner = $owner; Protected = $protected; Rules = $rules } | ConvertTo-Json -Compress'
        ].join('; ');
        const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', inspect], {
          env: { ...process.env, KL_INSPECT_DIR: dir },
          encoding: 'utf8'
        });
        const result = JSON.parse(out);
        assert.strictEqual(result.Owner, 'S-1-5-32-544');
        assert.strictEqual(result.Protected, true);
        assert.deepStrictEqual(result.Rules.split(',').sort(), ['S-1-5-18', 'S-1-5-19', 'S-1-5-32-544'].sort());
      } finally { removeTempTree(base2); }
    });

    it('creates a missing parent (the default layout …\\KingLouie\\data) owned by BA with a protected SY/BA/LS(read) DACL', { skip: notElevatedSkip }, () => {
      const base2 = sysTmp();
      try {
        const parent = path.join(base2, 'KingLouie');
        const dir = path.join(parent, 'data');
        const created = runAclScript(dir);
        assert.strictEqual(created.code, 0, `expected a clean create, got: ${created.stderr}`);
        const inspect = [
          '$acl = Get-Acl -LiteralPath $env:KL_INSPECT_DIR',
          '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
          '$rules = ($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) -join ","',
          '[PSCustomObject]@{ Owner = $owner; Protected = $acl.AreAccessRulesProtected; Rules = $rules } | ConvertTo-Json -Compress'
        ].join('; ');
        const result = JSON.parse(execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', inspect], {
          env: { ...process.env, KL_INSPECT_DIR: parent },
          encoding: 'utf8'
        }));
        assert.strictEqual(result.Owner, 'S-1-5-32-544');
        assert.strictEqual(result.Protected, true);
        assert.deepStrictEqual(result.Rules.split(',').sort(), ['S-1-5-18', 'S-1-5-19', 'S-1-5-32-544'].sort());
        assert.strictEqual(runAclScript(dir).code, 0, 'a second run only verifies');
      } finally { removeTempTree(base2); }
    });

    it('running it twice succeeds: the second run verifies the first run\'s ACL and is happy with it', { skip: notElevatedSkip }, () => {
      const base2 = sysTmp();
      try {
        const dir = path.join(base2, 'idempotent-data-dir');
        const first = runAclScript(dir);
        assert.strictEqual(first.code, 0, `expected a clean create, got: ${first.stderr}`);
        const second = runAclScript(dir);
        assert.strictEqual(second.code, 0, `expected the verify-only run to succeed, got: ${second.stderr}`);
      } finally { removeTempTree(base2); }
    });
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
    const stop = steps.find((s) => s.run?.join(' ') === `${SCHTASKS_EXE} /End /TN KingLouie`);
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

describe('executeSteps: unlink', () => {
  it('dry-run prints unlink steps', async () => {
    const t = io();
    await executeSteps([{ description: 'delete the temporary task definition', unlink: 'C:\\Temp\\x.xml' }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\] delete the temporary task definition: unlink C:\\Temp\\x\.xml/);
  });
  it('real mode removes a file, against a temp dir only', async () => {
    const base2 = tmp();
    const file = path.join(base2, 'to-delete.txt');
    fs.writeFileSync(file, 'x');
    await executeSteps([{ description: 'rm', unlink: file }], { dryRun: false, io: io() });
    assert.ok(!fs.existsSync(file));
  });
});

describe('executeSteps: env on run steps', () => {
  it('dry-run prints the env var(s) before the argv', async () => {
    const t = io();
    await executeSteps([{
      description: 'do a thing',
      run: ['powershell.exe', '-Command', 'X'],
      env: { KL_DATA_DIR: 'C:\\ProgramData\\KingLouie' }
    }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\] do a thing: KL_DATA_DIR=C:\\ProgramData\\KingLouie powershell\.exe -Command X/);
  });

  it('real mode (fake execFile) merges env over process.env instead of replacing it', async () => {
    const t = io();
    let seenEnv;
    const execFile = (cmd, args, opts) => { seenEnv = opts.env; };
    await executeSteps([{ description: 'do a thing', run: ['whatever'], env: { KL_DATA_DIR: 'C:\\x' } }], { dryRun: false, io: t, execFile });
    assert.strictEqual(seenEnv.KL_DATA_DIR, 'C:\\x');
    // process.env is still present underneath — merged, not replaced.
    const [someExistingKey] = Object.keys(process.env);
    assert.strictEqual(seenEnv[someExistingKey], process.env[someExistingKey]);
  });

  it('a real (harmless) child process actually receives the merged env var', async () => {
    const t = io();
    await executeSteps([{
      description: 'check env',
      run: [process.execPath, '-e', 'process.exit(process.env.KL_ROUND3_MARKER === "yes" ? 0 : 1)'],
      env: { KL_ROUND3_MARKER: 'yes' }
    }], { dryRun: false, io: t });
    // No throw => the spawned node process saw KL_ROUND3_MARKER and exited 0.
  });

  it('a run step with no env is unaffected (no env key forced onto the call)', async () => {
    const t = io();
    let sawOptions;
    const execFile = (cmd, args, opts) => { sawOptions = opts; };
    await executeSteps([{ description: 'plain run', run: ['whatever'] }], { dryRun: false, io: t, execFile });
    assert.strictEqual(sawOptions.env, undefined);
  });
});

// --- Final-review fix wave -------------------------------------------------

describe('default data dirs leave room for a read-only config dir (I1)', () => {
  it('windows: the default is <ProgramData>\\KingLouie\\data', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js' });
    const expected = path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'KingLouie', 'data');
    assert.strictEqual(steps.find((s) => s.env?.KL_DATA_DIR).env.KL_DATA_DIR, expected);
  });
  it('darwin: the default is /Library/Application Support/KingLouie/data', () => {
    const steps = planInstall({ platform: 'darwin', nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', user: '_kinglouie' });
    assert.ok(steps.some((s) => s.run?.join(' ') === 'install -d -m 0700 -o _kinglouie /Library/Application Support/KingLouie/data'));
  });
  it('linux: the default stays /var/lib/king-louie', () => {
    const steps = planInstall({ platform: 'linux', nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js' });
    assert.ok(steps.some((s) => s.run?.join(' ') === 'install -d -m 0700 -o king-louie -g king-louie /var/lib/king-louie'));
  });
  it('windows: the script creates a missing parent admin-owned with its own protected DACL, before the data dir, inside the create branch', () => {
    const steps = planInstall({ platform: 'win32', nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js' });
    const script = steps.find((s) => s.env?.KL_DATA_DIR).run[4];
    const branch = script.indexOf('if ($null -eq (Read-Entry $path)) {');
    const parentCheck = script.indexOf('Assert-SafeAncestors $parent $false');
    const parentSddl = script.indexOf("SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;LS)')");
    const parentCreate = script.indexOf('[System.IO.Directory]::CreateDirectory($parent, $pds)');
    const dataCreate = script.indexOf('[System.IO.Directory]::CreateDirectory($path, $ds)');
    assert.ok(branch > 0 && branch < parentCheck && parentCheck < parentSddl && parentSddl < parentCreate && parentCreate < dataCreate);
  });
});

describe('linux /etc/king-louie layout (I1)', () => {
  it('creates /etc/king-louie 0755 root-owned and only credentials/ 0700 (re-pinned), before writing the credential', () => {
    const s = planInstall({ platform: 'linux', ...base });
    const cfg = s.findIndex((x) => x.run?.join(' ') === 'install -d -m 0755 -o root -g root /etc/king-louie');
    const cred = s.findIndex((x) => x.run?.join(' ') === 'install -d -m 0700 -o root -g root /etc/king-louie/credentials');
    const pin = s.findIndex((x) => x.run?.join(' ') === 'chmod 0700 /etc/king-louie/credentials');
    const write = s.findIndex((x) => x.writeFile?.path === '/etc/king-louie/credentials/kl-master-key');
    assert.ok(cfg >= 0 && cfg < cred && cred < pin && pin < write, `order: ${[cfg, cred, pin, write]}`);
  });
});

describe('services run in the data dir (M5)', () => {
  it('systemd: WorkingDirectory= is the data dir', () => {
    assert.match(renderSystemdUnit(base), /^WorkingDirectory=\/var\/lib\/king-louie$/m);
  });
  it('launchd: WorkingDirectory is the data dir', () => {
    const plist = renderLaunchdPlist({ ...base, dataDir: '/Library/Application Support/KingLouie/data', logsDir: '/Library/Application Support/KingLouie/data/logs', user: '_kinglouie' });
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Library\/Application Support\/KingLouie\/data<\/string>/);
  });
  it('task XML: <WorkingDirectory> is the data dir, after <Arguments> (schema order)', () => {
    const xml = renderWindowsTaskXml({ nodePath: 'C:\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\ProgramData\\KingLouie\\data\\' });
    assert.match(xml, /<\/Arguments>\s*<WorkingDirectory>C:\\ProgramData\\KingLouie\\data<\/WorkingDirectory>\s*<\/Exec>/);
  });
});

describe('reinstall idempotency (I8)', () => {
  it('darwin: boots out any previous LaunchDaemon (failure ignored) right before bootstrap', () => {
    const steps = planInstall({ platform: 'darwin', ...base, user: '_kinglouie' });
    const bootout = steps.findIndex((s) => s.run?.join(' ') === 'launchctl bootout system /Library/LaunchDaemons/com.kinglouie.service.plist');
    const bootstrap = steps.findIndex((s) => s.run?.join(' ') === 'launchctl bootstrap system /Library/LaunchDaemons/com.kinglouie.service.plist');
    assert.ok(bootout >= 0 && bootstrap === bootout + 1);
    assert.strictEqual(steps[bootout].ignoreFailure, true);
  });
  it('linux: restarts the service after enable --now, so a reinstall runs the new unit', () => {
    const steps = planInstall({ platform: 'linux', ...base });
    const enable = steps.findIndex((s) => s.run?.join(' ') === 'systemctl enable --now king-louie.service');
    const restart = steps.findIndex((s) => s.run?.join(' ') === 'systemctl restart king-louie.service');
    assert.ok(enable >= 0 && restart === enable + 1);
    assert.notStrictEqual(steps[restart].ignoreFailure, true);
  });
});

// --- Fix wave 3: the POSIX installer must not create or chown anything
// inside a directory the service account owns, and must refuse a data dir
// whose parent that account could replace with a symlink.

describe('POSIX installer: nothing is created or chowned inside the data dir', () => {
  const posix = { nodePath: '/usr/bin/node', entryPath: '/opt/king-louie/bin/king-louie-service.js', user: '_kinglouie' };
  const DARWIN_DATA = '/Library/Application Support/KingLouie/data';

  it('darwin: has no step that creates <dataDir>/logs (the service creates it under its own uid)', () => {
    const steps = planInstall({ platform: 'darwin', ...posix, dataDir: DARWIN_DATA });
    const inside = steps.filter((s) => s.run && s.run.some((a) => typeof a === 'string' && a.startsWith(`${DARWIN_DATA}/`)));
    assert.deepStrictEqual(inside, [], `no install step may touch a path inside the data dir: ${JSON.stringify(inside)}`);
  });

  it('darwin: launchd stdout/stderr go to a root-owned dir, not <dataDir>/logs', () => {
    const steps = planInstall({ platform: 'darwin', ...posix, dataDir: DARWIN_DATA });
    const plist = steps.find((s) => s.writeFile?.path === '/Library/LaunchDaemons/com.kinglouie.service.plist').writeFile.content;
    assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/var\/log\/king-louie\/service\.out\.log<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/var\/log\/king-louie\/service\.err\.log<\/string>/);
    assert.ok(!plist.includes(`${DARWIN_DATA}/logs`), 'the plist must not name a log path inside the data dir');
    const mk = steps.find((s) => s.run?.join(' ') === 'install -d -m 0755 -o root -g wheel /var/log/king-louie');
    assert.ok(mk, 'the installer must create the root-owned launchd log dir');
    assert.ok(steps.indexOf(mk) < steps.indexOf(steps.find((s) => s.writeFile?.path === '/Library/LaunchDaemons/com.kinglouie.service.plist')));
  });

  for (const [platform, dataDir] of [['linux', '/var/lib/king-louie'], ['darwin', DARWIN_DATA]]) {
    it(`${platform}: checks the data dir's ancestors before the data dir is created`, () => {
      const steps = planInstall({ platform, ...posix, dataDir });
      const check = steps.findIndex((s) => s.ensureSafeParent === dataDir);
      const create = steps.findIndex((s) => s.run?.[0] === 'install' && s.run[s.run.length - 1] === dataDir);
      assert.ok(check >= 0, 'expected an ensureSafeParent step');
      assert.ok(create > check, 'the ancestor check must come before the data dir is created');
    });
  }

  it('dry-run prints the ancestor check without touching the filesystem', async () => {
    const t = io();
    await executeSteps([{ description: 'verify the data dir\'s ancestors are root-owned', ensureSafeParent: '/var/lib/king-louie' }], { dryRun: true, io: t });
    assert.match(t.out.join(''), /\[dry-run\].*every ancestor of \/var\/lib\/king-louie is a root-owned directory/);
  });
});

// Real-filesystem tests for the ancestor check. They need to run as root:
// the check's whole point is "owned by uid 0", which a non-root process
// cannot stage. In CI/dev that means a Linux container; on Windows the POSIX
// `install -d` path does not exist at all.
const notRootPosixSkip = process.platform === 'win32'
  ? 'POSIX-only (the Windows installer has its own ancestor check in PowerShell)'
  : (typeof process.getuid === 'function' && process.getuid() === 0 ? false : 'requires root (the check asserts uid 0 ownership)');

describe('ensureSafeDataDirParent (real filesystem, root only)', () => {
  const { ensureSafeDataDirParent } = require('../src/service/installers');

  it('accepts a root-owned, 0755 parent', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    fs.chmodSync(base, 0o755);
    ensureSafeDataDirParent(path.posix.join(base, 'data'));
  });

  it('refuses a world-writable parent (the /tmp/kl case)', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    fs.chmodSync(base, 0o1777);
    assert.throws(() => ensureSafeDataDirParent(path.posix.join(base, 'data')), /group- or world-writable/);
  });

  it('refuses a group-writable parent', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    fs.chmodSync(base, 0o775);
    assert.throws(() => ensureSafeDataDirParent(path.posix.join(base, 'data')), /group- or world-writable/);
  });

  it('refuses a parent owned by the service account', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    const parent = path.posix.join(base, 'svc-owned');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chownSync(parent, 12345, 12345);
    assert.throws(() => ensureSafeDataDirParent(path.posix.join(parent, 'data')), /not owned by root/);
  });

  it('refuses a parent that is a symlink, and creates nothing through it', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    fs.chmodSync(base, 0o755);
    const target = path.posix.join(base, 'target');
    fs.mkdirSync(target, { mode: 0o755 });
    const link = path.posix.join(base, 'link');
    fs.symlinkSync(target, link);
    assert.throws(() => ensureSafeDataDirParent(path.posix.join(link, 'data')), /is a symlink/);
    assert.ok(!fs.existsSync(path.posix.join(target, 'data')), 'nothing may be created through the link');
  });

  it('refuses a data dir that is itself a symlink, before `install -d` can chown its target', { skip: notRootPosixSkip }, () => {
    // Confirmed end to end as root in a node:22-alpine container: without
    // this refusal, `install -d -m 0700 -o <svcuser> <dataDir>` followed the
    // link and left /etc owned by the service account, mode 0700.
    const base = tmp();
    fs.chmodSync(base, 0o755);
    const target = path.posix.join(base, 'etc');
    fs.mkdirSync(target, { mode: 0o755 });
    const dataDir = path.posix.join(base, 'king-louie');
    fs.symlinkSync(target, dataDir);
    assert.throws(() => ensureSafeDataDirParent(dataDir), /the data dir .* is a symlink/);
    const st = fs.lstatSync(target);
    assert.strictEqual(st.uid, 0);
    assert.strictEqual(st.mode & 0o7777, 0o755);
  });

  it('creates a missing parent root-owned 0755 (the default macOS …/KingLouie layout)', { skip: notRootPosixSkip }, () => {
    const base = tmp();
    fs.chmodSync(base, 0o755);
    const parent = path.posix.join(base, 'KingLouie');
    ensureSafeDataDirParent(path.posix.join(parent, 'data'));
    const st = fs.lstatSync(parent);
    assert.ok(st.isDirectory());
    assert.strictEqual(st.uid, 0);
    assert.strictEqual(st.mode & 0o7777, 0o755);
    assert.ok(!fs.existsSync(path.posix.join(parent, 'data')), 'only the parent is created, never the data dir');
  });
});
