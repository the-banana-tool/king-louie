// Renders OS service definitions and turns them into explicit, printable
// install steps. `--dry-run` prints the steps without touching the system.
//
// Step shape: { description, run?, env?, unlink?, writeFile?, runUnless?, warn?, ignoreFailure?, always? }
//   - run: string[]                          — argv to execute
//   - env: { [key]: string }                 — only with `run`; merged over
//       process.env for that one command (e.g. passing a data dir through an
//       env var instead of interpolating it into a script's text)
//   - unlink: string                         — file to remove
//   - writeFile: { path, content, mode, encoding?, overwrite? } — encoding defaults
//       to 'utf8'; overwrite defaults to true (false uses an exclusive create and
//       silently leaves an existing file in place, e.g. so reinstalling never
//       clobbers a live master key)
//   - runUnless: { check: string[], run: string[] } — runs `run` only if `check`
//       exits non-zero (e.g. "does this user already exist")
//   - warn: true                             — printed in both dry-run and real
//       mode, never executed; used for advisory-only steps
//   - ignoreFailure: true                    — a failure is logged and swallowed
//       instead of aborting the install/uninstall (any step kind)
//   - always: true                           — this step still runs even after an
//       earlier step has failed (e.g. cleanup); once every step has been tried,
//       the original failure is rethrown
// Exactly one of run, unlink, writeFile and runUnless is set (env, warn,
// ignoreFailure and always are modifiers, not step kinds).
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

// Owner Administrators (BA), DACL protected (no inherited ACEs), Full
// Control to LOCAL SERVICE (LS), SYSTEM (SY) and Administrators (BA) only.
const WINDOWS_DATA_DIR_SDDL = 'O:BAD:P(A;OICI;FA;;;LS)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';

// TrustedInstaller owns the volume root and C:\Windows on a stock install.
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

// Reads a path's attributes and raw security descriptor (owner + DACL)
// through ONE handle opened with FILE_FLAG_OPEN_REPARSE_POINT, so a junction
// or symlink is inspected as itself (never followed), and the reparse check
// and the ACL read are guaranteed to describe the same object — a path-based
// Get-Item then Get-Acl pair could be raced by swapping the entry in between.
// Returns $null when nothing exists at the path (not even a dangling link).
// CreateFileW always adds SYNCHRONIZE to the requested access, so a path whose
// DACL doesn't grant the (elevated) installer that right can't be opened at
// all — verification then fails closed with "cannot open …: Access is denied".
const WINDOWS_INSPECT_CSHARP = [
  'using System;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class KlFsInspect {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  struct BY_HANDLE_FILE_INFORMATION {',
  '    public uint FileAttributes;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;',
  '    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;',
  '  }',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);',
  '  [DllImport("advapi32.dll")]',
  '  static extern uint GetSecurityInfo(SafeFileHandle h, int objectType, uint securityInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);',
  '  [DllImport("advapi32.dll")]',
  '  static extern uint GetSecurityDescriptorLength(IntPtr sd);',
  '  [DllImport("kernel32.dll")]',
  '  static extern IntPtr LocalFree(IntPtr mem);',
  '  public static object[] Inspect(string path) {',
  '    // READ_CONTROL | FILE_READ_ATTRIBUTES; share read/write/delete; OPEN_EXISTING;',
  '    // FILE_FLAG_BACKUP_SEMANTICS (needed to open a directory) | FILE_FLAG_OPEN_REPARSE_POINT.',
  '    SafeFileHandle h = CreateFileW(path, 0x00020080, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);',
  '    if (h.IsInvalid) {',
  '      int err = Marshal.GetLastWin32Error();',
  '      if (err == 2 || err == 3) return null;',
  '      throw new Win32Exception(err, "cannot open " + path + ": " + new Win32Exception(err).Message);',
  '    }',
  '    using (h) {',
  '      BY_HANDLE_FILE_INFORMATION info;',
  '      if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "cannot read the attributes of " + path);',
  '      IntPtr sd;',
  '      // SE_FILE_OBJECT; OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION',
  '      uint rc = GetSecurityInfo(h, 1, 0x1 | 0x4, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);',
  '      if (rc != 0) throw new Win32Exception((int)rc, "cannot read the security descriptor of " + path);',
  '      try {',
  '        byte[] bytes = new byte[GetSecurityDescriptorLength(sd)];',
  '        Marshal.Copy(sd, bytes, 0, bytes.Length);',
  '        return new object[] { info.FileAttributes, bytes };',
  '      } finally { LocalFree(sd); }',
  '    }',
  '  }',
  '}'
].join('\n');

// Creates the data dir with a protected DACL present from the instant it
// exists, then — whether it was just created or already existed — runs the
// SAME full verification; it never modifies an existing dir's ACL.
//
// Why verification always runs after CreateDirectory: Directory.CreateDirectory
// on a path that already exists (a plain dir or a junction) returns success
// silently and applies nothing, so a standard user who creates
// C:\ProgramData\KingLouie (or a junction there) between the existence check
// and the create would otherwise win. Now that race ends in the owner check
// (their dir is owned by them) or the reparse check (a junction).
//
// Verification, on the data dir itself (read through one no-follow handle —
// see WINDOWS_INSPECT_CSHARP):
//   - not a reparse point, and a directory;
//   - a DACL is present, and EVERY ACE in the raw DACL (RawSecurityDescriptor,
//     so every ACE is judged by its real type — Get-Acl's .Access view lists
//     a conditional/callback ACE as if it were an ordinary allow rule, and
//     can omit ACE kinds it doesn't model) is a plain ACCESS_ALLOWED ACE for LOCAL SERVICE,
//     SYSTEM or Administrators — anything else, deny ACEs included, fails;
//   - the DACL is protected (no inherited ACEs);
//   - the owner is Administrators, SYSTEM or LOCAL SERVICE;
// and on every ancestor up to the volume root: not a reparse point, and owned
// by Administrators, SYSTEM or TrustedInstaller. The ancestors that already
// exist are also checked BEFORE creating, so nothing is created through an
// attacker-controlled parent.
//
// This replaced a multi-step mkdir-then-icacls*3 sequence (a TOCTOU window
// between every step, and `icacls /reset` briefly re-enabling inherited ACEs).
// dataDir is passed through the KL_DATA_DIR environment variable, never
// interpolated into this script's text.
const WINDOWS_DATA_DIR_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `try {`,
  `  $path = $env:KL_DATA_DIR`,
  `  if (-not $path) { throw 'KL_DATA_DIR is not set' }`,
  `  $path = [System.IO.Path]::GetFullPath($path)`,
  `  Add-Type -TypeDefinition @'`,
  WINDOWS_INSPECT_CSHARP,
  `'@`,
  `  $aceSids = @('S-1-5-19','S-1-5-18','S-1-5-32-544')`,
  `  $dirOwners = @('S-1-5-32-544','S-1-5-18','S-1-5-19')`,
  `  $ancestorOwners = @('S-1-5-32-544','S-1-5-18','${TRUSTED_INSTALLER_SID}')`,
  `  function Read-Entry([string]$p) {`,
  `    $r = [KlFsInspect]::Inspect($p)`,
  `    if ($null -eq $r) { return $null }`,
  `    return [PSCustomObject]@{ Attributes = [uint32]$r[0]; Sd = [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$r[1], 0) }`,
  `  }`,
  `  function Assert-SafeAncestors([string]$p, [bool]$mustExist) {`,
  `    $a = [System.IO.Path]::GetDirectoryName($p)`,
  `    while ($a) {`,
  `      $e = Read-Entry $a`,
  `      if ($null -eq $e) {`,
  `        if ($mustExist) { throw "ancestor directory ${'$'}{a} is not safe: it does not exist" }`,
  `      } else {`,
  `        if ($e.Attributes -band 0x400) { throw "ancestor directory ${'$'}{a} is not safe: it is a symlink or junction" }`,
  `        $o = if ($e.Sd.Owner) { $e.Sd.Owner.Value } else { '(none)' }`,
  `        if ($ancestorOwners -notcontains $o) { throw "ancestor directory ${'$'}{a} is not safe: owner $o is not Administrators, SYSTEM or TrustedInstaller" }`,
  `      }`,
  `      $a = [System.IO.Path]::GetDirectoryName($a)`,
  `    }`,
  `  }`,
  `  if ($null -eq (Read-Entry $path)) {`,
  `    Assert-SafeAncestors $path $false`,
  `    $ds = New-Object System.Security.AccessControl.DirectorySecurity`,
  `    $ds.SetSecurityDescriptorSddlForm('${WINDOWS_DATA_DIR_SDDL}')`,
  `    [System.IO.Directory]::CreateDirectory($path, $ds) | Out-Null`,
  `  }`,
  `  # VERIFY: always runs, for a freshly created dir and a pre-existing one alike`,
  `  $bad = "the data dir's ACL is not safe and must be fixed or removed manually"`,
  `  $e = Read-Entry $path`,
  `  if ($null -eq $e) { throw "${'$'}{path} does not exist after creating it" }`,
  `  if ($e.Attributes -band 0x400) { throw "refusing to use ${'$'}{path}: it is a symlink or junction" }`,
  `  if (-not ($e.Attributes -band 0x10)) { throw "refusing to use ${'$'}{path}: it is not a directory" }`,
  `  $dacl = $e.Sd.DiscretionaryAcl`,
  `  if ($null -eq $dacl) { throw "${'$'}{bad}: it has no DACL (everyone has full access)" }`,
  `  foreach ($ace in $dacl) {`,
  `    if (-not ($ace -is [System.Security.AccessControl.CommonAce]) -or $ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) {`,
  `      throw "${'$'}{bad}: unexpected ACE of type $($ace.AceType) (only plain allow ACEs are permitted)"`,
  `    }`,
  `  }`,
  `  foreach ($ace in $dacl) {`,
  `    $aceSid = $ace.SecurityIdentifier.Value`,
  `    if ($aceSids -notcontains $aceSid) { throw "${'$'}{bad}: unexpected ACE for $aceSid" }`,
  `  }`,
  `  if (-not ($e.Sd.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)) {`,
  `    throw "${'$'}{bad}: inherited access rules are still enabled"`,
  `  }`,
  `  $ownerSid = if ($e.Sd.Owner) { $e.Sd.Owner.Value } else { '(none)' }`,
  `  if ($dirOwners -notcontains $ownerSid) { throw "${'$'}{bad}: owner $ownerSid is not Administrators, SYSTEM or LOCAL SERVICE" }`,
  `  Assert-SafeAncestors $path $true`,
  `  exit 0`,
  `} catch {`,
  `  [Console]::Error.WriteLine($_.Exception.Message)`,
  `  exit 1`,
  `}`
].join('\n');

// Absolute paths for every Windows executable the plans run, so an elevated
// install started from an attacker-writable cwd can't pick up a planted
// powershell.exe/schtasks.exe (Windows searches the cwd before PATH).
function windowsSystemRoot() {
  const root = process.env.SystemRoot;
  return typeof root === 'string' && path.win32.isAbsolute(root) ? root : 'C:\\Windows';
}
const windowsPowerShellExe = () => path.win32.join(windowsSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsSchtasksExe = () => path.win32.join(windowsSystemRoot(), 'System32', 'schtasks.exe');

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

// Control characters (including \n and \r) are never legitimate in a
// filesystem path and could corrupt a plist/log line; unlike
// assertAbsolutePosixDataDir (which backs the systemd unit file, where
// whitespace and % $ \ " are also unsafe because ExecStart= is a
// space-delimited, %-interpolated line), this is deliberately more lenient:
// macOS paths legitimately contain spaces (the default data dir is under
// "/Library/Application Support"), and nothing on the darwin/launchd side
// interpolates dataDir into shell or unit-file syntax — it only ever goes
// into an XML-escaped <string>.
const CONTROL_CHARS_RE = /[\x00-\x1F]/;

function assertAbsolutePosixPath(name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new Error(`${name} contains a control character: ${JSON.stringify(value)}`);
  }
  if (!value.startsWith('/')) {
    throw new Error(`${name} must be an absolute POSIX path: ${JSON.stringify(value)}`);
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

// Counts path segments below the root: 0 for "/" or "C:\", 1 for "/etc" or
// "C:\Windows", 2 for "/var/lib/king-louie" or "C:\ProgramData\KingLouie".
// For a Windows UNC path (\\srv\share\...), "the root" is the server+share.
function pathComponentsBelowRoot(resolved, style) {
  if (style === 'win32') {
    const { root } = path.win32.parse(resolved);
    return resolved.slice(root.length).split('\\').filter(Boolean).length;
  }
  return resolved.split('/').filter(Boolean).length;
}

// Refuses to install into (or uninstall-adjacent operate on) a directory
// that's too close to the filesystem root — "/", "/etc", "C:\",
// "C:\Windows" or "\\srv\share\" are never a legitimate king-louie data
// dir, and treating one as such would let install/uninstall steps (chown,
// ACL reset, rm -f) touch far more of the system than intended.
function assertDataDirNotAtRoot(resolved, style) {
  if (pathComponentsBelowRoot(resolved, style) < 2) {
    throw new Error(`dataDir is too close to the filesystem root (needs at least 2 path components below root): ${JSON.stringify(resolved)}`);
  }
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
    // Always normalize (not just when the input looks relative) so a
    // dot-segment in an already-absolute path — "/etc/..", "/tmp/../etc",
    // "/./etc" — can't slip past the root guard below unresolved.
    dataDir = path.posix.resolve(dataDir);
    assertAbsolutePosixDataDir(dataDir);
    assertDataDirNotAtRoot(dataDir, 'posix');
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
    // Same normalize-before-validate as linux (see comment there); darwin
    // also runs the absolute/char validation, just the more lenient variant
    // (see assertAbsolutePosixPath) since macOS paths can legitimately
    // contain spaces and dataDir is never interpolated into shell/unit
    // syntax here — only into an XML-escaped <string>.
    dataDir = path.posix.resolve(dataDir);
    assertAbsolutePosixPath('dataDir', dataDir);
    assertDataDirNotAtRoot(dataDir, 'posix');
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
    assertDataDirNotAtRoot(dataDir, 'win32');
    // Written to the admin's own temp dir (a random name, not the data dir a
    // standard user could have pre-created and still own) and deleted again
    // once schtasks has imported it — the data dir is never briefly
    // service-writable before its ACL is locked down.
    const xmlPath = path.win32.join(os.tmpdir(), `king-louie-task-${crypto.randomBytes(8).toString('hex')}.xml`);
    steps = [
      // One elevated PowerShell call creates the dir with its final,
      // protected ACL already attached, or — if it already exists — only
      // ever verifies that ACL (never resets/re-grants it). See the comment
      // on WINDOWS_DATA_DIR_SCRIPT for why this replaced a separate
      // mkdir-then-icacls*3 sequence. dataDir travels through an env var,
      // never through the script's text.
      {
        description: 'create or verify the data dir with a locked-down ACL',
        run: [windowsPowerShellExe(), '-NoProfile', '-NonInteractive', '-Command', WINDOWS_DATA_DIR_SCRIPT],
        env: { KL_DATA_DIR: dataDir }
      },
      {
        description: 'write the task definition',
        writeFile: { path: xmlPath, content: `\ufeff${renderWindowsTaskXml({ nodePath, entryPath, dataDir, profile })}`, mode: 0o644, encoding: 'utf16le' }
      },
      { description: 'register the boot task', run: [windowsSchtasksExe(), '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'] },
      // Always attempted, even if a step above it failed, so a stray temp
      // file doesn't linger; a failure here (e.g. already gone) must not
      // stop "start it now" from running.
      { description: 'delete the temporary task definition', unlink: xmlPath, always: true, ignoreFailure: true },
      { description: 'start it now', run: [windowsSchtasksExe(), '/Run', '/TN', TASK_NAME] }
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
      { description: 'stop the task', run: [windowsSchtasksExe(), '/End', '/TN', TASK_NAME], ignoreFailure: true },
      { description: 'delete the task', run: [windowsSchtasksExe(), '/Delete', '/TN', TASK_NAME, '/F'] }
    ];
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

// Runs a single step. Throws on failure (dry-run never throws); the caller
// (executeSteps) is responsible for ignoreFailure/always bookkeeping.
async function runOneStep(step, { dryRun, io, execFile }) {
  if (step.warn) {
    // Advisory only: printed in both modes, never executed.
    io.stdout.write(`${step.description}\n`);
    return;
  }

  if (step.runUnless) {
    const { check, run } = step.runUnless;
    if (dryRun) {
      io.stdout.write(`[dry-run] ${step.description}: check ${check.join(' ')}; if that fails, run ${run.join(' ')}\n`);
      return;
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
    return;
  }

  let what;
  if (step.run) {
    const envPrefix = step.env ? `${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(' ')} ` : '';
    what = envPrefix + step.run.join(' ');
  } else if (step.unlink) what = `unlink ${step.unlink}`;
  else {
    what = `write ${step.writeFile.path}`
      + (step.writeFile.encoding ? ` (${step.writeFile.encoding})` : '')
      + (step.writeFile.overwrite === false ? ' (skip if exists)' : '');
  }
  if (step.ignoreFailure) what += ' (failure ignored)';

  if (dryRun) {
    io.stdout.write(`[dry-run] ${step.description}: ${what}\n`);
    return;
  }

  io.stdout.write(`${step.description}…\n`);
  if (step.run) {
    const execOptions = { stdio: 'inherit', windowsHide: true };
    if (step.env) execOptions.env = { ...process.env, ...step.env };
    execFile(step.run[0], step.run.slice(1), execOptions);
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
        return;
      }
      throw err;
    }
  }
}

async function executeSteps(steps, { dryRun = false, io = { stdout: process.stdout }, execFile = execFileSync } = {}) {
  // Once a step fails (and isn't ignoreFailure), remaining steps are skipped
  // *except* those marked `always` (e.g. cleaning up a temp file) — those
  // still run, and the original failure is rethrown once every step has
  // been tried.
  let pendingError = null;

  for (const step of steps) {
    if (pendingError && !step.always) continue;
    try {
      await runOneStep(step, { dryRun, io, execFile });
    } catch (err) {
      if (step.ignoreFailure) {
        io.stdout.write(`  ignoring failure: ${err.message}\n`);
        continue;
      }
      if (pendingError) {
        // A cleanup ("always") step failed on top of an earlier failure;
        // keep the original error, but note the follow-up one too.
        io.stdout.write(`  cleanup step also failed: ${err.message}\n`);
      } else {
        pendingError = err;
      }
    }
  }

  if (pendingError) throw pendingError;
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
