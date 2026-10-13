// src/session/autostart.js
// Login start for the session helper (fleet stage 5 spec §7). Windows: a
// logon task in the user's interactive session. macOS: a LaunchAgent loaded
// into gui/<uid>. Linux: an XDG autostart entry. Files in a user's home are
// written by a child running as that user (O_EXCL, no link followed), so a
// planted symlink or a user-owned directory can never redirect an elevated
// write.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync: defaultSpawnSync, execFileSync } = require('child_process');
const { sanitizeWindowsPath, assertAbsolutePosixPath, xmlEscape, executeSteps } = require('../service/installers');
const { windowsSchtasksExe, windowsPowerShellExe } = require('../platform/windows-paths');
const { GuiError } = require('../gui/errors');

const SID_RE = /^S-1-\d+(-\d+){1,14}$/;
const TASK_USER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const LAUNCH_AGENT = 'com.kinglouie.session';

function windowsTaskName(user) {
  if (typeof user !== 'string' || !TASK_USER_RE.test(user)) throw new GuiError('invalid_params', `not a task-safe user name: ${JSON.stringify(user)}`);
  return `KingLouie Session ${user}`;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function renderLogonTaskXml({ sid, nodePath, entryPath, sessionFile, env = process.env }) {
  if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'the task needs the user\'s SID');
  const node = sanitizeWindowsPath('nodePath', nodePath);
  const entry = sanitizeWindowsPath('entryPath', entryPath);
  const file = sanitizeWindowsPath('sessionFile', sessionFile);
  const args = `-WindowStyle Hidden -NoProfile -NonInteractive -Command & ${psQuote(node)} ${psQuote(entry)} session --session-file ${psQuote(file)}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>King Louie session helper</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(windowsPowerShellExe(env))}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function renderLaunchAgentPlist({ nodePath, entryPath, sessionFile }) {
  for (const [name, value] of [['nodePath', nodePath], ['entryPath', entryPath], ['sessionFile', sessionFile]]) assertAbsolutePosixPath(name, value);
  const args = [nodePath, entryPath, 'session', '--session-file', sessionFile].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
}

// Desktop Entry Exec quoting: quote an argument with reserved characters,
// backslash-escape " ` $ \ inside, and write % as %%.
function desktopQuote(arg) {
  const text = String(arg).replace(/%/g, '%%');
  if (!/[\s"'\\><~|&;$*?#()`]/.test(text)) return text;
  return `"${text.replace(/(["`$\\])/g, '\\$1')}"`;
}

function renderDesktopEntry({ nodePath, entryPath, sessionFile }) {
  for (const [name, value] of [['nodePath', nodePath], ['entryPath', entryPath], ['sessionFile', sessionFile]]) assertAbsolutePosixPath(name, value);
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=King Louie session helper',
    `Exec=${[nodePath, entryPath, 'session', '--session-file', sessionFile].map(desktopQuote).join(' ')}`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    ''
  ].join('\n');
}

function autostartPath({ platform, home }) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`);
  if (platform === 'linux') return path.posix.join(home, '.config', 'autostart', 'king-louie-session.desktop');
  return null;
}

function planAutostartInstall({ platform = process.platform, account, nodePath = process.execPath, entryPath, sessionFile, tmpDir = os.tmpdir(), env = process.env }) {
  if (platform === 'win32') {
    const name = windowsTaskName(account.user);
    const xmlPath = path.win32.join(tmpDir, `king-louie-session-${crypto.randomBytes(6).toString('hex')}.xml`);
    return [
      { description: 'write the logon task definition', writeFile: { path: xmlPath, content: `\ufeff${renderLogonTaskXml({ sid: account.sid, nodePath, entryPath, sessionFile, env })}`, mode: 0o600, encoding: 'utf16le' } },
      { description: `register the logon task "${name}"`, run: [windowsSchtasksExe(env), '/Create', '/TN', name, '/XML', xmlPath, '/F'] },
      { description: 'delete the temporary task definition', unlink: xmlPath, always: true, ignoreFailure: true }
    ];
  }
  const file = autostartPath({ platform, home: account.home });
  if (platform === 'darwin') {
    return [
      { description: `write the LaunchAgent as ${account.user}`, asUser: { uid: account.uid, gid: account.gid, home: account.home, file, content: renderLaunchAgentPlist({ nodePath, entryPath, sessionFile }) } },
      { description: 'stop a helper loaded earlier', run: ['/bin/launchctl', 'bootout', `gui/${account.uid}/${LAUNCH_AGENT}`], ignoreFailure: true },
      // Fails when the user is not logged in now; the agent loads at their next login.
      { description: `load it into ${account.user}'s session`, run: ['/bin/launchctl', 'bootstrap', `gui/${account.uid}`, file], ignoreFailure: true }
    ];
  }
  return [
    { description: `write the autostart entry as ${account.user}`, asUser: { uid: account.uid, gid: account.gid, home: account.home, file, content: renderDesktopEntry({ nodePath, entryPath, sessionFile }) } }
  ];
}

function planAutostartUninstall({ platform = process.platform, account, env = process.env }) {
  if (platform === 'win32') {
    return [{ description: `delete the logon task "${windowsTaskName(account.user)}"`, run: [windowsSchtasksExe(env), '/Delete', '/TN', windowsTaskName(account.user), '/F'], ignoreFailure: true }];
  }
  const file = autostartPath({ platform, home: account.home });
  const steps = [];
  if (platform === 'darwin') steps.push({ description: 'stop the helper', run: ['/bin/launchctl', 'bootout', `gui/${account.uid}/${LAUNCH_AGENT}`], ignoreFailure: true });
  steps.push({ description: `remove the login start as ${account.user}`, removeAsUser: { uid: account.uid, gid: account.gid, home: account.home, file } });
  return steps;
}

async function executeAutostartSteps(steps, { dryRun = false, io, entryPath, nodePath = process.execPath, spawnSync = defaultSpawnSync, execFile = execFileSync } = {}) {
  let pending = null;
  for (const step of steps) {
    if (pending && !step.always) continue;
    try {
      const user = step.asUser || step.removeAsUser;
      if (!user) {
        await executeSteps([step], { dryRun, io, execFile });
        continue;
      }
      const sub = step.asUser ? '_write-autostart' : '_remove-autostart';
      if (dryRun) {
        io.stdout.write(`[dry-run] ${step.description}: ${nodePath} ${entryPath} session ${sub} ${user.file} (as uid ${user.uid})\n`);
        continue;
      }
      io.stdout.write(`${step.description}…\n`);
      const r = spawnSync(nodePath, [entryPath, 'session', sub, user.file], {
        uid: user.uid, gid: user.gid, input: step.asUser ? step.asUser.content : '',
        env: { HOME: user.home, PATH: '/usr/bin:/bin', KING_LOUIE_LOG_LEVEL: 'warn' }, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
      });
      if (r.status !== 0) throw new Error(`${step.description} failed (exit ${r.status})`);
    } catch (err) {
      if (!pending) pending = err;
    }
  }
  if (pending) throw pending;
}

// ── the child side, running as the user ─────────────────────────────────
function checkUnderHome(file, home) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new GuiError('unsafe_path', String(file));
  const rel = path.relative(home, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new GuiError('unsafe_path', `${file} is not in ${home}`);
  return rel.split(path.sep);
}

function walkDirs(home, parts, { create }) {
  let current = home;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT' || !create) throw err.code === 'ENOENT' ? new GuiError('unsafe_path', current) : err;
      fs.mkdirSync(current, { mode: 0o700 });
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GuiError('unsafe_path', current);
  }
}

function writeAutostartFile({ file, content, userInfo = os.userInfo() }) {
  const home = fs.realpathSync(userInfo.homedir);
  const parts = checkUnderHome(path.resolve(file), home);
  walkDirs(home, parts, { create: true });
  const target = path.join(home, ...parts);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new GuiError('unsafe_path', target);
    fs.unlinkSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o644);
  try {
    fs.writeSync(fd, String(content));
  } finally {
    fs.closeSync(fd);
  }
}

function removeAutostartFile({ file, userInfo = os.userInfo() }) {
  const home = fs.realpathSync(userInfo.homedir);
  const parts = checkUnderHome(path.resolve(file), home);
  try {
    walkDirs(home, parts, { create: false });
  } catch (err) {
    if (err.code === 'unsafe_path' && !fs.existsSync(path.join(home, ...parts.slice(0, -1)))) return false;
    throw err;
  }
  try {
    fs.unlinkSync(path.join(home, ...parts));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  windowsTaskName, renderLogonTaskXml, renderLaunchAgentPlist, renderDesktopEntry, autostartPath,
  planAutostartInstall, planAutostartUninstall, executeAutostartSteps, writeAutostartFile, removeAutostartFile, LAUNCH_AGENT
};
