// Renders OS service definitions and turns them into explicit, printable
// install steps. `--dry-run` prints the steps without touching the system.
//
// Step shape: { description, run?, mkdir?, unlink?, writeFile?, runUnless?, warn?, ignoreFailure? }
//   - run: string[]                          — argv to execute
//   - mkdir: string                          — directory to create (recursive)
//   - unlink: string                         — file to remove
//   - writeFile: { path, content, mode, encoding?, overwrite? } — encoding defaults
//       to 'utf8'; overwrite defaults to true (false uses an exclusive create and
//       silently leaves an existing file in place, e.g. so reinstalling never
//       clobbers a live master key)
//   - runUnless: { check: string[], run: string[] } — runs `run` only if `check`
//       exits non-zero (e.g. "does this user already exist")
//   - warn: true                             — printed in both dry-run and real
//       mode, never executed; used for advisory-only steps
//   - ignoreFailure: true                    — on a `run` step, a non-zero exit
//       is logged and swallowed instead of aborting the install/uninstall
// Exactly one of run, mkdir, unlink, writeFile and runUnless is set (warn and
// ignoreFailure are modifiers, not step kinds).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultServiceDataDir } = require('../platform/paths');
const { PROFILES } = require('./config');

const UNIT_PATH = '/etc/systemd/system/king-louie.service';
const CRED_PATH = '/etc/king-louie/credentials/kl-master-key';
const PLIST_PATH = '/Library/LaunchDaemons/com.kinglouie.service.plist';
const TASK_NAME = 'KingLouie';

// Escapes text for use inside XML element content (not attribute values, so
// quotes are left as-is — they're only special inside an attribute).
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// systemd unit files interpolate `%` specifiers and are parsed line-by-line
// ("Key=Value"), so control characters, whitespace and % $ \ " in a value
// could inject a new directive or a systemd specifier. None of these
// characters are legitimate in a data dir, node binary path or entry path.
const FORBIDDEN_UNIT_CHARS_RE = /[\x00-\x1F\s%$\\"]/;

function assertSafeUnitValue(name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (FORBIDDEN_UNIT_CHARS_RE.test(value)) {
    throw new Error(`${name} contains a disallowed character (control character, whitespace, or one of % $ \\ "): ${JSON.stringify(value)}`);
  }
}

function assertAbsolutePosixDataDir(dataDir) {
  assertSafeUnitValue('dataDir', dataDir);
  if (!dataDir.startsWith('/')) {
    throw new Error(`dataDir must be an absolute POSIX path: ${JSON.stringify(dataDir)}`);
  }
}

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function assertValidUser(user) {
  if (typeof user !== 'string' || !USER_RE.test(user)) {
    throw new Error(`Invalid --user ${JSON.stringify(user)}: must match ${USER_RE}`);
  }
  if (user === 'root') {
    throw new Error('--user must not be "root"');
  }
}

function assertValidProfile(profile) {
  if (!PROFILES.has(profile)) {
    throw new Error(`Unknown profile ${JSON.stringify(profile)}. Expected one of: ${[...PROFILES].join(', ')}`);
  }
}

// A double quote would break out of the quoted argument inside <Arguments>,
// and a trailing backslash right before that closing quote would escape it
// (Windows command-line quoting rules) — path.win32.resolve() strips a
// trailing separator, and the explicit check rejects the quote outright.
function sanitizeWindowsDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new Error(`dataDir must be a non-empty string, got ${JSON.stringify(dataDir)}`);
  }
  if (dataDir.includes('"')) {
    throw new Error(`dataDir must not contain a double quote: ${JSON.stringify(dataDir)}`);
  }
  return path.win32.resolve(dataDir);
}

// True when a path sits under a user's home directory rather than a system
// path — installing there means the service account (or anyone with access
// to that account) can rewrite the binary/entry point it runs.
function isUnderHome(p) {
  if (typeof p !== 'string') return false;
  return /^\/(home|root|Users)(\/|$)/.test(p) || /^[A-Za-z]:\\Users(\\|$)/i.test(p);
}

function renderSystemdUnit({ nodePath, entryPath, dataDir, user, profile = 'agent' }) {
  assertAbsolutePosixDataDir(dataDir);
  assertSafeUnitValue('nodePath', nodePath);
  assertSafeUnitValue('entryPath', entryPath);
  return [
    '[Unit]',
    'Description=King Louie service',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `Group=${user}`,
    `ExecStart=${nodePath} ${entryPath} run --data-dir ${dataDir} --profile ${profile}`,
    'Restart=on-failure',
    'RestartSec=5',
    `LoadCredential=kl-master-key:${CRED_PATH}`,
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    `ProtectHome=${profile === 'runbook' ? 'yes' : 'read-only'}`,
    'PrivateTmp=yes',
    `ReadWritePaths=${dataDir}`,
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
}

function renderLaunchdPlist({ nodePath, entryPath, dataDir, user, logsDir, profile = 'agent' }) {
  const args = [nodePath, entryPath, 'run', '--data-dir', dataDir, '--profile', profile].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kinglouie.service</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>UserName</key>
  <string>${xmlEscape(user)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.posix.join(logsDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.posix.join(logsDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

function renderWindowsTaskXml({ nodePath, entryPath, dataDir, profile = 'agent' }) {
  dataDir = sanitizeWindowsDataDir(dataDir);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>King Louie service</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-19</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(`"${entryPath}" run --data-dir "${dataDir}" --profile ${profile}`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function planInstall({ platform = process.platform, nodePath = process.execPath, entryPath, dataDir, user, profile = 'agent' }) {
  assertValidProfile(profile);
  dataDir = dataDir || defaultServiceDataDir({ platform });

  let steps;
  if (platform === 'linux') {
    const svcUser = user || 'king-louie';
    assertValidUser(svcUser);
    if (!path.posix.isAbsolute(dataDir)) dataDir = path.posix.resolve(dataDir);
    assertAbsolutePosixDataDir(dataDir);
    assertSafeUnitValue('nodePath', nodePath);
    assertSafeUnitValue('entryPath', entryPath);
    steps = [
      {
        description: 'create the service user',
        runUnless: { check: ['id', '-u', svcUser], run: ['useradd', '--system', '--home-dir', dataDir, '--shell', '/usr/sbin/nologin', svcUser] }
      },
      { description: 'create the data dir', run: ['install', '-d', '-m', '0700', '-o', svcUser, '-g', svcUser, dataDir] },
      { description: 'write the master key credential (root-only)', writeFile: { path: CRED_PATH, content: crypto.randomBytes(32).toString('hex'), mode: 0o600, overwrite: false } },
      { description: 'write the systemd unit', writeFile: { path: UNIT_PATH, content: renderSystemdUnit({ nodePath, entryPath, dataDir, user: svcUser, profile }), mode: 0o644 } },
      { description: 'reload systemd', run: ['systemctl', 'daemon-reload'] },
      { description: 'enable and start', run: ['systemctl', 'enable', '--now', 'king-louie.service'] }
    ];
  } else if (platform === 'darwin') {
    if (!user) throw new Error('--user is required on macOS (create a dedicated account first; see README)');
    assertValidUser(user);
    if (!path.posix.isAbsolute(dataDir)) dataDir = path.posix.resolve(dataDir);
    const logsDir = path.posix.join(dataDir, 'logs');
    steps = [
      // Fails fast, before anything is written, if the account doesn't exist.
      { description: 'verify the service account exists', run: ['id', '-u', user] },
      { description: 'create the data dir', run: ['install', '-d', '-m', '0700', '-o', user, dataDir] },
      { description: 'create the logs dir', run: ['install', '-d', '-m', '0700', '-o', user, logsDir] },
      { description: 'write the LaunchDaemon', writeFile: { path: PLIST_PATH, content: renderLaunchdPlist({ nodePath, entryPath, dataDir, user, logsDir, profile }), mode: 0o644 } },
      { description: 'load the LaunchDaemon', run: ['launchctl', 'bootstrap', 'system', PLIST_PATH] }
    ];
  } else if (platform === 'win32') {
    dataDir = sanitizeWindowsDataDir(dataDir);
    // Written to the admin's own temp dir (a random name, not the data dir a
    // standard user could have pre-created and still own) and deleted again
    // once schtasks has imported it — the data dir is never briefly
    // service-writable before its ACL is locked down.
    const xmlPath = path.win32.join(os.tmpdir(), `king-louie-task-${crypto.randomBytes(8).toString('hex')}.xml`);
    steps = [
      { description: 'create the data dir', mkdir: dataDir },
      {
        description: 'restrict the data dir to LOCAL SERVICE, SYSTEM and Administrators',
        run: ['icacls', dataDir, '/inheritance:r', '/grant:r', '*S-1-5-19:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/T']
      },
      // A standard user who pre-created the data dir keeps owning it after
      // the ACL grant above, so reclaim ownership for Administrators too.
      { description: 'take ownership of the data dir for Administrators', run: ['icacls', dataDir, '/setowner', '*S-1-5-32-544', '/T'] },
      {
        description: 'write the task definition',
        writeFile: { path: xmlPath, content: `\ufeff${renderWindowsTaskXml({ nodePath, entryPath, dataDir, profile })}`, mode: 0o644, encoding: 'utf16le' }
      },
      { description: 'register the boot task', run: ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'] },
      { description: 'delete the temporary task definition', unlink: xmlPath },
      { description: 'start it now', run: ['schtasks', '/Run', '/TN', TASK_NAME] }
    ];
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  if (isUnderHome(nodePath) || isUnderHome(entryPath)) {
    steps.unshift({
      description: 'WARNING: king-louie will run as a service account from a user-writable/home location '
        + '(nodePath or entryPath is under /home, /root, /Users, or C:\\Users\\); move the install to a system path (see README)',
      warn: true
    });
  }
  return steps;
}

function planUninstall({ platform = process.platform }) {
  if (platform === 'linux') {
    return [
      { description: 'stop and disable', run: ['systemctl', 'disable', '--now', 'king-louie.service'] },
      { description: 'remove the unit', run: ['rm', '-f', UNIT_PATH] },
      { description: 'reload systemd', run: ['systemctl', 'daemon-reload'] }
    ];
  }
  if (platform === 'darwin') {
    return [
      { description: 'unload the LaunchDaemon', run: ['launchctl', 'bootout', 'system', PLIST_PATH] },
      { description: 'remove the plist', run: ['rm', '-f', PLIST_PATH] }
    ];
  }
  if (platform === 'win32') {
    return [
      // The task may already be stopped (or never started); that isn't a
      // reason to abort the uninstall.
      { description: 'stop the task', run: ['schtasks', '/End', '/TN', TASK_NAME], ignoreFailure: true },
      { description: 'delete the task', run: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'] }
    ];
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

async function executeSteps(steps, { dryRun = false, io = { stdout: process.stdout }, execFile = execFileSync } = {}) {
  for (const step of steps) {
    if (step.warn) {
      // Advisory only: printed in both modes, never executed.
      io.stdout.write(`${step.description}\n`);
      continue;
    }

    if (step.runUnless) {
      const { check, run } = step.runUnless;
      if (dryRun) {
        io.stdout.write(`[dry-run] ${step.description}: check ${check.join(' ')}; if that fails, run ${run.join(' ')}\n`);
        continue;
      }
      io.stdout.write(`${step.description}…\n`);
      let exists = true;
      try {
        execFile(check[0], check.slice(1), { stdio: 'ignore', windowsHide: true });
      } catch {
        exists = false;
      }
      if (exists) {
        io.stdout.write('  already present, skipping\n');
      } else {
        execFile(run[0], run.slice(1), { stdio: 'inherit', windowsHide: true });
      }
      continue;
    }

    const what = step.run
      ? step.run.join(' ') + (step.ignoreFailure ? ' (failure ignored)' : '')
      : step.mkdir
        ? `mkdir ${step.mkdir}`
        : step.unlink
          ? `unlink ${step.unlink}`
          : `write ${step.writeFile.path}`
            + (step.writeFile.encoding ? ` (${step.writeFile.encoding})` : '')
            + (step.writeFile.overwrite === false ? ' (skip if exists)' : '');

    if (dryRun) {
      io.stdout.write(`[dry-run] ${step.description}: ${what}\n`);
      continue;
    }

    io.stdout.write(`${step.description}…\n`);
    if (step.run) {
      try {
        execFile(step.run[0], step.run.slice(1), { stdio: 'inherit', windowsHide: true });
      } catch (err) {
        if (!step.ignoreFailure) throw err;
        io.stdout.write(`  ignoring failure: ${err.message}\n`);
      }
    } else if (step.mkdir) {
      fs.mkdirSync(step.mkdir, { recursive: true });
    } else if (step.unlink) {
      fs.unlinkSync(step.unlink);
    } else {
      const { path: filePath, content, mode, encoding = 'utf8', overwrite = true } = step.writeFile;
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(filePath, content, { mode, encoding, flag: overwrite ? 'w' : 'wx' });
        // writeFileSync's mode is subject to umask; chmod pins the exact bits.
        if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(filePath, mode);
      } catch (err) {
        if (!overwrite && err.code === 'EEXIST') {
          io.stdout.write('  already exists, leaving in place\n');
        } else {
          throw err;
        }
      }
    }
  }
}

async function runInstallCommand(command, flags, io) {
  const entryPath = path.resolve(__dirname, '..', '..', 'bin', 'king-louie-service.js');
  const steps = command === 'install'
    ? planInstall({ entryPath, dataDir: flags.dataDir, user: flags.user, profile: flags.profile })
    : planUninstall({});
  await executeSteps(steps, { dryRun: Boolean(flags.dryRun), io });
  return 0;
}

module.exports = {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml,
  planInstall, planUninstall, executeSteps, runInstallCommand
};
