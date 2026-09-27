# Fleet Stage 5: Session helper — Implementation Plan (Part 5 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The header — Goal, Architecture, Owner questions, **Global Constraints**, **Review Focus**, Interfaces from other stages and **Deviations** — is in Part 1 (`2026-09-23-fleet-stage5-session-helper-part1.md`) and applies to every task here. Part 5 builds on Parts 1–4 (Tasks 1–18) on `feat/fleet-stage5`.

**This part:** Task 19 login start (`src/session/autostart.js`, the user-home writer child); Task 20 the `session` CLI (`run | install | uninstall | status | probe`); Task 21 the e2e, `CLAUDE.md` and the full-suite check.

---

### Task 19: Login start for the helper

**Files:**
- Create: `src/session/autostart.js`
- Modify: `src/service/installers.js:962` (export `sanitizeWindowsPath`, `assertAbsolutePosixPath`, `xmlEscape`)
- Test: `tests/session-autostart.test.js`

**Interfaces:**
- Consumes: `sanitizeWindowsPath`, `assertAbsolutePosixPath`, `xmlEscape`, `executeSteps` (`src/service/installers.js`); `windowsSchtasksExe`, `windowsPowerShellExe` (`src/platform/windows-paths.js`); `GuiError` (Task 1).
- Produces (`src/session/autostart.js`):
  - `windowsTaskName(user) → 'KingLouie Session <user>'` (throws `invalid_params` for a name outside `[A-Za-z0-9._ -]{1,64}`).
  - `renderLogonTaskXml({ sid, nodePath, entryPath, sessionFile, env }) → string`; `renderLaunchAgentPlist({ nodePath, entryPath, sessionFile }) → string`; `renderDesktopEntry({ nodePath, entryPath, sessionFile }) → string`.
  - `autostartPath({ platform, home }) → string | null` (`~/Library/LaunchAgents/com.kinglouie.session.plist`, `~/.config/autostart/king-louie-session.desktop`, null on Windows).
  - `planAutostartInstall({ platform, account: { user, uid, gid, home, sid }, nodePath, entryPath, sessionFile, tmpDir, env }) → steps`; `planAutostartUninstall({ platform, account, env }) → steps`. Steps are `installers.executeSteps` steps plus `{ description, asUser: { uid, gid, home, file, content } }` and `{ description, removeAsUser: { uid, gid, home, file } }`.
  - `executeAutostartSteps(steps, { dryRun, io, entryPath, nodePath = process.execPath, spawnSync, execFile }) → Promise<void>`.
  - `writeAutostartFile({ file, content, userInfo = os.userInfo() })`, `removeAutostartFile({ file, userInfo })` — the child side (`session _write-autostart <file>` / `_remove-autostart <file>`, Task 20), running as the target user.

- [ ] **Step 1: Write the failing test**

Create `tests/session-autostart.test.js`:

```js
// tests/session-autostart.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/session/autostart');
const { windowsSchtasksExe, windowsPowerShellExe } = require('../src/platform/windows-paths');

const POSIX = process.platform !== 'win32';
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const env = { SystemRoot: 'C:\\Windows' };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

describe('Windows logon task', () => {
  const xml = A.renderLogonTaskXml({
    sid: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: "C:\\Program Files\\King Louie\\bin\\king-louie-service.js",
    sessionFile: "C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json", env
  });

  it('starts at the user\'s logon, in their session, least privilege, restarting on failure', () => {
    assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>S-1-5-21-1-2-3-1001<\/UserId><\/LogonTrigger>/);
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.ok(xml.includes(`<Command>${windowsPowerShellExe(env)}</Command>`));
    assert.match(xml, /<Arguments>-WindowStyle Hidden -NoProfile -NonInteractive -Command &amp; 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\King Louie\\bin\\king-louie-service.js' session --session-file 'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json'<\/Arguments>/);
  });

  it('doubles single quotes and refuses double quotes and bad SIDs', () => {
    const quoted = A.renderLogonTaskXml({ sid: 'S-1-5-21-1-2-3-1001', nodePath: "C:\\it's\\node.exe", entryPath: 'C:\\kl\\e.js', sessionFile: 'C:\\kl\\f.json', env });
    assert.ok(quoted.includes("'C:\\it''s\\node.exe'"));
    assert.match(code(() => A.renderLogonTaskXml({ sid: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\a"b\\node.exe', entryPath: 'C:\\e.js', sessionFile: 'C:\\f.json', env })), /double quote/);
    assert.equal(code(() => A.renderLogonTaskXml({ sid: 'S-1-5-21-1<x>', nodePath: 'C:\\n.exe', entryPath: 'C:\\e.js', sessionFile: 'C:\\f.json', env })), 'invalid_params');
    assert.equal(A.windowsTaskName('alice'), 'KingLouie Session alice');
    assert.equal(code(() => A.windowsTaskName('a;b')), 'invalid_params');
  });

  it('plans schtasks by absolute path, and cleans up the temp XML', () => {
    const steps = A.planAutostartInstall({ platform: 'win32', account: { user: 'alice', sid: 'S-1-5-21-1-2-3-1001' }, nodePath: 'C:\\n\\node.exe', entryPath: 'C:\\kl\\e.js', sessionFile: 'C:\\kl\\f.json', tmpDir: 'C:\\Temp', env });
    const write = steps.find((s) => s.writeFile);
    assert.equal(write.writeFile.encoding, 'utf16le');
    const create = steps.find((s) => s.run && s.run.includes('/Create'));
    assert.deepEqual(create.run.slice(0, 4), [windowsSchtasksExe(env), '/Create', '/TN', 'KingLouie Session alice']);
    assert.ok(steps.find((s) => s.unlink === write.writeFile.path && s.always));
    const removal = A.planAutostartUninstall({ platform: 'win32', account: { user: 'alice' }, env });
    assert.deepEqual(removal[0].run, [windowsSchtasksExe(env), '/Delete', '/TN', 'KingLouie Session alice', '/F']);
  });
});

describe('macOS LaunchAgent and Linux autostart', () => {
  it('the plist loads in the Aqua session and restarts on a crash', () => {
    const plist = A.renderLaunchAgentPlist({ nodePath: '/usr/local/bin/node', entryPath: '/opt/king louie/bin/king-louie-service.js', sessionFile: '/Library/Application Support/KingLouie/config/session/users/alice.json' });
    assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
    assert.ok(plist.includes('<string>/opt/king louie/bin/king-louie-service.js</string>'));
    assert.ok(plist.includes('<string>--session-file</string>'));
    assert.throws(() => A.renderLaunchAgentPlist({ nodePath: 'node', entryPath: '/e.js', sessionFile: '/f.json' }), /absolute/);
    assert.ok(A.renderLaunchAgentPlist({ nodePath: '/a&b/node', entryPath: '/e.js', sessionFile: '/f.json' }).includes('/a&amp;b/node'));
  });

  it('the .desktop Exec line quotes paths and escapes %', () => {
    const entry = A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/king louie/e.js', sessionFile: '/etc/king-louie/session/users/alice.json' });
    assert.match(entry, /^Exec=\/usr\/bin\/node "\/opt\/king louie\/e.js" session --session-file \/etc\/king-louie\/session\/users\/alice.json$/m);
    assert.ok(A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/100%/e.js', sessionFile: '/f.json' }).includes(' /opt/100%%/e.js '));
    assert.throws(() => A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/a\nb.js', sessionFile: '/f.json' }), /control character/);
  });

  it('plans: user-home files go through a child running as the user; launchctl bootstrap gui/<uid>', () => {
    const mac = A.planAutostartInstall({ platform: 'darwin', account: { user: 'alice', uid: 501, gid: 20, home: '/Users/alice' }, nodePath: '/usr/local/bin/node', entryPath: '/opt/kl/e.js', sessionFile: '/f.json' });
    const write = mac.find((s) => s.asUser);
    assert.deepEqual({ uid: write.asUser.uid, gid: write.asUser.gid, file: write.asUser.file }, { uid: 501, gid: 20, file: '/Users/alice/Library/LaunchAgents/com.kinglouie.session.plist' });
    assert.deepEqual(mac.find((s) => s.run && s.run[1] === 'bootstrap').run, ['/bin/launchctl', 'bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/com.kinglouie.session.plist']);
    const linux = A.planAutostartInstall({ platform: 'linux', account: { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }, nodePath: '/usr/bin/node', entryPath: '/opt/kl/e.js', sessionFile: '/f.json' });
    assert.equal(linux[0].asUser.file, '/home/alice/.config/autostart/king-louie-session.desktop');
    assert.ok(A.planAutostartUninstall({ platform: 'linux', account: { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' } })[0].removeAsUser);
  });

  it('executes a user-home write as a child with the user\'s uid and gid, content on stdin', async () => {
    const calls = [];
    const spawnSync = (file, argv, opts) => { calls.push({ file, argv, opts }); return { status: 0 }; };
    const steps = [{ description: 'write it', asUser: { uid: 1001, gid: 1001, home: '/home/alice', file: '/home/alice/.config/autostart/king-louie-session.desktop', content: 'X' } }];
    const io = { stdout: { write: () => {} } };
    await A.executeAutostartSteps(steps, { io, entryPath: '/opt/kl/e.js', nodePath: '/usr/bin/node', spawnSync });
    assert.equal(calls[0].file, '/usr/bin/node');
    assert.deepEqual(calls[0].argv, ['/opt/kl/e.js', 'session', '_write-autostart', '/home/alice/.config/autostart/king-louie-session.desktop']);
    assert.equal(calls[0].opts.uid, 1001);
    assert.equal(calls[0].opts.gid, 1001);
    assert.equal(calls[0].opts.input, 'X');
    assert.equal(calls[0].opts.env.HOME, '/home/alice');
    const dry = [];
    await A.executeAutostartSteps(steps, { dryRun: true, io: { stdout: { write: (t) => dry.push(t) } }, entryPath: '/opt/kl/e.js', nodePath: '/usr/bin/node', spawnSync });
    assert.equal(calls.length, 1, 'dry run spawns nothing');
    assert.match(dry.join(''), /\[dry-run\] write it/);
    await assert.rejects(A.executeAutostartSteps(steps, { io, entryPath: '/e.js', nodePath: '/node', spawnSync: () => ({ status: 1 }) }), /failed/);
  });
});

describe('the user-side writer', { skip: !POSIX }, () => {
  function home() {
    const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-home-')));
    cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }));
    return h;
  }

  it('creates the dirs and writes the file; a second write replaces it', () => {
    const h = home();
    const file = path.join(h, '.config', 'autostart', 'king-louie-session.desktop');
    A.writeAutostartFile({ file, content: 'one', userInfo: { homedir: h } });
    A.writeAutostartFile({ file, content: 'two', userInfo: { homedir: h } });
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    A.removeAutostartFile({ file, userInfo: { homedir: h } });
    assert.equal(fs.existsSync(file), false);
  });

  it('refuses a planted symlink at a component or the file, and anything outside the home', () => {
    const h = home();
    const elsewhere = home();
    fs.symlinkSync(elsewhere, path.join(h, '.config'));
    assert.equal(code(() => A.writeAutostartFile({ file: path.join(h, '.config', 'autostart', 'k.desktop'), content: 'x', userInfo: { homedir: h } })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    const h2 = home();
    fs.mkdirSync(path.join(h2, 'Library', 'LaunchAgents'), { recursive: true });
    const target = path.join(elsewhere, 'victim');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(h2, 'Library', 'LaunchAgents', 'com.kinglouie.session.plist'));
    assert.equal(code(() => A.writeAutostartFile({ file: path.join(h2, 'Library', 'LaunchAgents', 'com.kinglouie.session.plist'), content: 'x', userInfo: { homedir: h2 } })), 'unsafe_path');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    assert.equal(code(() => A.writeAutostartFile({ file: '/etc/passwd', content: 'x', userInfo: { homedir: h2 } })), 'unsafe_path');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-autostart.test.js`
Expected: FAIL with `Cannot find module '../src/session/autostart'`.

- [ ] **Step 3: Export the installer helpers**

In `src/service/installers.js`, extend `module.exports`:

```js
module.exports = {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml,
  planInstall, planUninstall, executeSteps, runInstallCommand,
  ensureSafeDataDirParent, DARWIN_LOG_DIR,
  // Fleet stage 7: the desktop's bridge-file owner check reuses the inspector.
  WINDOWS_INSPECT_CSHARP,
  // Fleet stage 5: the session helper's login start renders with the same checks.
  sanitizeWindowsPath, assertAbsolutePosixPath, xmlEscape
};
```

- [ ] **Step 4: Write `src/session/autostart.js`**

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/session-autostart.test.js tests/service-installers.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/session/autostart.js src/service/installers.js tests/session-autostart.test.js
git commit -m "feat(session): login start for the helper on Windows, macOS and Linux

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: The `session` command

**Files:**
- Create: `src/service/commands/session.js`
- Modify: `src/service/cli.js` (HELP, `VALUE_FLAGS` += `session-file`, flag scoping, `case 'session'`)
- Test: `tests/service-cli-session.test.js`

**Interfaces:**
- Consumes: `runSessionHelper` (Task 15); `resolveSessionUser`, `mintSessionSecret`, `writeCanonical`, `writeUserCopy`, `removeUserCopy`, `userCopyPath`, `endpointPath`, `sessionIpcDir`, `canonicalPath` (Task 5); `planAutostartInstall`, `planAutostartUninstall`, `executeAutostartSteps`, `writeAutostartFile`, `removeAutostartFile` (Task 19); `readGuiStatusRecord` (Task 8); `selectBackend`, `loadBackend` (Task 15); `isAdmin` (`src/service/commands/admin-check.js`); `resolveMasterKeyReadOnly`, `verifyKeyCheck` (`src/platform/master-key.js`); `createAesGcmCipher`; `deriveNodeId`; `adminConfigDir`.
- Produces (`src/service/commands/session.js`): `runSessionCommand({ sub, arg, flags, dataDir, io, deps }) → Promise<exitCode>`; `readNodeId(dataDir) → string | null`; `SESSION_USAGE`. `deps`: `{ platform, isAdmin, resolveSessionUser, resolveKey, configDir, ipcDir, runIcacls, execute, entryPath, nodePath, readStatus, localProbe, runHelper, stdin }`.

- [ ] **Step 1: Write the failing test**

Create `tests/service-cli-session.test.js`:

```js
// tests/service-cli-session.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessionCommand, readNodeId } = require('../src/service/commands/session');
const { main, parseArgs } = require('../src/service/cli');
const S = require('../src/gui/session-secret');
const { writeGuiStatus } = require('../src/gui/status');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { testNodeIdentity } = require('./helpers/fake-phone');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const identity = testNodeIdentity({ key: 'gpu-box' });
const KEY = crypto.randomBytes(32);

function setup({ withIdentity = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-session-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  const ipcDir = path.join(base, 'ipc');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  if (withIdentity) fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ 'mesh.identity': { publicKey: identity.publicKey.toString('hex') } }));
  return { base, dataDir, configDir, ipcDir };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: (t) => err.push(String(t)) }, stdin: null } };
}

const account = (name) => ({ user: name, uid: UID, gid: GID, home: os.homedir(), sid: POSIX ? null : 'S-1-5-21-1-2-3-1001' });

function deps(s, extra = {}) {
  const executed = [];
  return {
    executed,
    platform: process.platform,
    isAdmin: () => true,
    resolveSessionUser: (name) => account(name),
    resolveKey: () => ({ key: KEY, source: 'test' }),
    verifyKey: () => {},
    configDir: s.configDir,
    ipcDir: s.ipcDir,
    runIcacls: () => {},
    execute: async (steps) => { executed.push(steps); },
    entryPath: '/opt/kl/bin/king-louie-service.js',
    nodePath: '/usr/bin/node',
    adminUid: UID,
    ...extra
  };
}

const canonical = (configDir) => JSON.parse(fs.readFileSync(S.canonicalPath(configDir), 'utf8'));

describe('session install', () => {
  it('needs an administrator', async () => {
    const s = setup();
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { isAdmin: () => false }) }), 1);
    assert.match(t.err.join(''), /root|Administrator/);
  });

  it('writes the canonical secret, the per-user copy and the login start; a second run rotates', async () => {
    const s = setup();
    const t = io();
    const d = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    const first = canonical(s.configDir);
    assert.equal(first.node_id, identity.nodeId);
    assert.equal(first.session_user, 'alice');
    assert.match(first.secret, /^klc1:/);
    const copyFile = S.userCopyPath({ platform: process.platform, configDir: s.configDir, user: 'alice', sid: account('alice').sid });
    const copy = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
    const cipher = createAesGcmCipher(KEY);
    assert.equal(copy.secret, cipher.decryptString(first.secret));
    assert.equal(copy.endpoint, S.endpointPath({ platform: process.platform, endpointId: first.endpoint_id, ipcDir: s.ipcDir }));
    assert.equal(d.executed.length, 1);
    assert.match(t.out.join(''), /installed for alice/);
    if (POSIX) assert.equal(fs.statSync(s.ipcDir).mode & 0o777, 0o711);

    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    const second = canonical(s.configDir);
    assert.notEqual(second.endpoint_id, first.endpoint_id);
    assert.notEqual(cipher.decryptString(second.secret), cipher.decryptString(first.secret));
  });

  it('Owner question 2: refuses a second session user until the first is uninstalled', async () => {
    const s = setup();
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: deps(s) });
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'bob' }, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 1);
    assert.match(t.err.join(''), /session_user_mismatch: installed for "alice"; run "session uninstall --user alice" first/);
  });

  it('refuses before writing when the service never ran (no identity) or there is no master key', async () => {
    const s = setup({ withIdentity: false });
    const t = io();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 1);
    assert.match(t.err.join(''), /start the service once first/);
    const s2 = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s2.dataDir, io: io().io, deps: deps(s2, { resolveKey: () => null }) }), 1);
    assert.equal(fs.existsSync(S.canonicalPath(s2.configDir)), false);
  });

  it('--dry-run writes nothing and prints the plan', async () => {
    const s = setup();
    const t = io();
    const d = deps(s);
    assert.equal(await runSessionCommand({ sub: 'install', flags: { user: 'alice', dryRun: true }, dataDir: s.dataDir, io: t.io, deps: d }), 0);
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.match(t.out.join(''), /\[dry-run\]/);
  });

  it('needs --user', async () => {
    const s = setup();
    assert.equal(await runSessionCommand({ sub: 'install', flags: {}, dataDir: s.dataDir, io: io().io, deps: deps(s) }), 2);
  });
});

describe('session uninstall, status, probe', () => {
  it('uninstall removes the copy, the canonical secret and the login start', async () => {
    const s = setup();
    const d = deps(s);
    await runSessionCommand({ sub: 'install', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d });
    assert.equal(await runSessionCommand({ sub: 'uninstall', flags: { user: 'alice' }, dataDir: s.dataDir, io: io().io, deps: d }), 0);
    assert.equal(fs.existsSync(S.canonicalPath(s.configDir)), false);
    assert.equal(d.executed.length, 2);
  });

  it('status shows the running helper and its probes, or says none reports', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dataDir, 'service.pid'), String(process.pid));
    let t = io();
    assert.equal(await runSessionCommand({ sub: 'status', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) }), 0);
    assert.match(t.out.join(''), /no running service reports a session helper/);
    writeGuiStatus(s.dataDir, {
      v: 1, pid: process.pid, available: true, user: 'alice', platform: 'darwin', capabilities: ['gui.launch'],
      probes: [{ check: 'accessibility', ok: false, hint: 'grant Accessibility to /usr/local/bin/node' }], limits: [], apps: [], since: 'x',
      updated_at: new Date().toISOString(), lease: null
    });
    t = io();
    await runSessionCommand({ sub: 'status', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) });
    assert.match(t.out.join(''), /helper: connected \(alice, darwin\)/);
    assert.match(t.out.join(''), /accessibility: missing — grant Accessibility/);
  });

  it('probe prints the running helper\'s report, or a clearly labelled local probe', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dataDir, 'service.pid'), String(process.pid));
    let t = io();
    await runSessionCommand({ sub: 'probe', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s, { localProbe: async () => ({ capabilities: ['gui.launch'], probes: [{ check: 'display', ok: true }], limits: [] }) }) });
    assert.match(t.out.join(''), /local probe from this shell, not the running helper/);
    writeGuiStatus(s.dataDir, { v: 1, pid: process.pid, available: true, user: 'alice', platform: 'win32', capabilities: ['gui.input'], probes: [{ check: 'send_input', ok: true }], limits: [], apps: [], since: 'x', updated_at: new Date().toISOString(), lease: null });
    t = io();
    await runSessionCommand({ sub: 'probe', flags: {}, dataDir: s.dataDir, io: t.io, deps: deps(s) });
    assert.match(t.out.join(''), /from the running helper/);
    assert.match(t.out.join(''), /send_input: ok/);
  });
});

describe('the CLI', () => {
  it('knows the session command and its flag', async () => {
    assert.equal(parseArgs(['session', '--session-file', '/x.json']).flags.sessionFile, '/x.json');
    const t = io();
    assert.equal(await main(['session', 'bogus'], t.io), 2);
    const t2 = io();
    assert.equal(await main(['status', '--session-file', '/x.json'], t2.io), 2);
    assert.match(t2.err.join(''), /only valid for "session"/);
    const help = io();
    await main(['help'], help.io);
    assert.match(help.out.join(''), /king-louie-service session install --user NAME/);
  });

  it('session runs the helper and returns its exit code', async () => {
    const s = setup();
    const t = io();
    let seen = null;
    const code = await runSessionCommand({ sub: undefined, flags: { sessionFile: '/x.json' }, dataDir: s.dataDir, io: t.io, deps: deps(s, { runHelper: async (opts) => { seen = opts; return 1; } }) });
    assert.equal(code, 1);
    assert.equal(seen.sessionFile, '/x.json');
  });

  it('readNodeId derives the node id from the stored identity without the master key', () => {
    const s = setup();
    assert.equal(readNodeId(s.dataDir), identity.nodeId);
    assert.equal(readNodeId(setup({ withIdentity: false }).dataDir), null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/service-cli-session.test.js`
Expected: FAIL with `Cannot find module '../src/service/commands/session'`.

- [ ] **Step 3: Write `src/service/commands/session.js`**

```js
// src/service/commands/session.js
// `king-louie-service session …` (fleet stage 5 spec §7). CLI output goes to
// io.stdout/io.stderr on purpose; everything else logs via createLogger.
//   session                      run the helper (as the logged-in user)
//   session install --user NAME  (elevated) mint and write the secret, the
//                                per-user copy and the login start; rotates
//   session uninstall --user NAME
//   session status | probe
const fs = require('fs');
const path = require('path');
const { GuiError, isGuiError } = require('../../gui/errors');

const SESSION_USAGE = `Usage: king-louie-service session [--session-file PATH]
       king-louie-service session install --user NAME [--data-dir DIR] [--dry-run]
       king-louie-service session uninstall --user NAME [--data-dir DIR] [--dry-run]
       king-louie-service session status [--data-dir DIR]
       king-louie-service session probe [--data-dir DIR]
`;

function readNodeId(dataDir) {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
    const record = store && store['mesh.identity'];
    if (!record || typeof record.publicKey !== 'string') return null;
    return require('../../mesh/node-identity').deriveNodeId(Buffer.from(record.publicKey, 'hex'));
  } catch {
    return null;
  }
}

function readInstalledUser(configDir) {
  try {
    return JSON.parse(fs.readFileSync(require('../../gui/session-secret').canonicalPath(configDir), 'utf8')).session_user || null;
  } catch {
    return null;
  }
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  return Buffer.concat(chunks).toString('utf8');
}

function common(dataDir, deps) {
  const { adminConfigDir } = require('../../platform/paths');
  const platform = deps.platform || process.platform;
  return {
    platform,
    configDir: deps.configDir || adminConfigDir({ platform, dataDir }),
    entryPath: deps.entryPath || path.resolve(__dirname, '..', '..', '..', 'bin', 'king-louie-service.js'),
    nodePath: deps.nodePath || process.execPath,
    execute: deps.execute || ((steps, opts) => require('../../session/autostart').executeAutostartSteps(steps, opts)),
    isAdmin: deps.isAdmin || (() => require('./admin-check').isAdmin({ platform })),
    resolveUser: deps.resolveSessionUser || ((name) => require('../../gui/session-secret').resolveSessionUser(name, { platform }))
  };
}

// Windows account names are compared case-insensitively and stored bare.
const bareName = (name, platform) => (platform === 'win32' ? String(name).split('\\').pop() : String(name));

async function install({ flags, dataDir, io, deps }) {
  const S = require('../../gui/session-secret');
  const A = require('../../session/autostart');
  const c = common(dataDir, deps);
  if (!flags.user) { io.stderr.write(SESSION_USAGE); return 2; }
  if (!c.isAdmin()) { io.stderr.write('session install needs root (or an elevated Administrator prompt on Windows).\n'); return 1; }
  const account = c.resolveUser(flags.user);
  const sessionUser = bareName(flags.user, c.platform);
  const installed = readInstalledUser(c.configDir);
  if (installed && installed.toLowerCase() !== sessionUser.toLowerCase()) {
    throw new GuiError('session_user_mismatch', `installed for "${installed}"; run "session uninstall --user ${installed}" first`);
  }
  const nodeId = readNodeId(dataDir);
  if (!nodeId) throw new Error(`no node identity in ${dataDir}: start the service once first`);
  const resolveKey = deps.resolveKey || (() => require('../../platform/master-key').resolveMasterKeyReadOnly({ dataDir }));
  const resolved = resolveKey();
  if (!resolved) throw new Error(`no master key for ${dataDir}: start the service once first`);
  (deps.verifyKey || ((r) => require('../../platform/master-key').verifyKeyCheck({ dataDir, key: r.key, source: r.source, create: false })))(resolved);
  const cipher = require('../../platform/cipher').createAesGcmCipher(resolved.key);

  const { secret, endpointId } = S.mintSessionSecret();
  const ipcDir = deps.ipcDir || S.sessionIpcDir(c.platform);
  const endpoint = S.endpointPath({ platform: c.platform, endpointId, ipcDir });
  const sessionFile = S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  const steps = A.planAutostartInstall({ platform: c.platform, account: { ...account, user: sessionUser }, nodePath: c.nodePath, entryPath: c.entryPath, sessionFile });

  if (flags.dryRun) {
    io.stdout.write(`[dry-run] write ${S.canonicalPath(c.configDir)} (node ${nodeId}, user ${sessionUser})\n`);
    io.stdout.write(`[dry-run] write ${sessionFile}\n`);
    if (c.platform !== 'win32') io.stdout.write(`[dry-run] create ${ipcDir} (0711, owned by the service account)\n`);
    await c.execute(steps, { dryRun: true, io, entryPath: c.entryPath, nodePath: c.nodePath });
    return 0;
  }

  let svc = null;
  if (c.platform !== 'win32') {
    const st = fs.statSync(dataDir);
    svc = { uid: st.uid, gid: st.gid };
    try {
      fs.mkdirSync(ipcDir, { recursive: true, mode: 0o711 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const ist = fs.lstatSync(ipcDir);
    if (ist.isSymbolicLink() || !ist.isDirectory()) throw new GuiError('unsafe_path', ipcDir);
    fs.chownSync(ipcDir, svc.uid, svc.gid);
    fs.chmodSync(ipcDir, 0o711);
  }
  S.writeCanonical({ configDir: c.configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid: account.sid || null, svcGid: svc ? svc.gid : null, platform: c.platform });
  S.writeUserCopy({
    platform: c.platform, configDir: c.configDir, user: sessionUser, uid: account.uid, gid: account.gid, sid: account.sid,
    content: { v: 1, node_id: nodeId, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() },
    ...(deps.runIcacls ? { runIcacls: deps.runIcacls } : {})
  });
  await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  io.stdout.write(`Session helper installed for ${sessionUser} (node ${nodeId}).\n`);
  io.stdout.write(`  service secret: ${S.canonicalPath(c.configDir)}\n  user copy:      ${sessionFile}\n  endpoint:       ${endpoint}\n`);
  io.stdout.write(installed ? 'The secret was rotated; the running service drops the old connection and the helper reconnects.\n' : 'Restart the King Louie service so it starts waiting for the helper.\n');
  if (c.platform === 'darwin') {
    io.stdout.write(`At the next login macOS asks for Screen Recording and Accessibility for ${c.nodePath}. Those permissions cover every script ${sessionUser} runs with that node binary.\n`);
  }
  return 0;
}

async function uninstall({ flags, dataDir, io, deps }) {
  const S = require('../../gui/session-secret');
  const A = require('../../session/autostart');
  const c = common(dataDir, deps);
  if (!flags.user) { io.stderr.write(SESSION_USAGE); return 2; }
  if (!c.isAdmin()) { io.stderr.write('session uninstall needs root (or an elevated Administrator prompt on Windows).\n'); return 1; }
  const account = c.resolveUser(flags.user);
  const sessionUser = bareName(flags.user, c.platform);
  const steps = A.planAutostartUninstall({ platform: c.platform, account: { ...account, user: sessionUser } });
  if (flags.dryRun) {
    io.stdout.write(`[dry-run] remove ${S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid })}\n`);
    await c.execute(steps, { dryRun: true, io, entryPath: c.entryPath, nodePath: c.nodePath });
    return 0;
  }
  await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  S.removeUserCopy({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  const installed = readInstalledUser(c.configDir);
  if (installed && installed.toLowerCase() === sessionUser.toLowerCase()) fs.unlinkSync(S.canonicalPath(c.configDir));
  io.stdout.write(`Session helper removed for ${sessionUser}.\n`);
  return 0;
}

function printProbes(io, probes) {
  for (const p of probes || []) io.stdout.write(`  ${p.check}: ${p.ok ? 'ok' : `missing — ${p.hint || 'no hint'}`}\n`);
}

async function status({ dataDir, io, deps }) {
  const c = common(dataDir, deps);
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  const installed = readInstalledUser(c.configDir);
  io.stdout.write(installed ? `installed for: ${installed}\n` : 'not installed (session install --user NAME)\n');
  if (!record) {
    io.stdout.write('helper: no running service reports a session helper\n');
    return 0;
  }
  io.stdout.write(`helper: ${record.available ? `connected (${record.user}, ${record.platform})` : 'not connected'}\n`);
  if (record.available) io.stdout.write(`capabilities: ${(record.capabilities || []).join(', ') || 'none'}\n`);
  if ((record.limits || []).length) io.stdout.write(`limits: ${record.limits.join(', ')}\n`);
  printProbes(io, record.probes);
  if (record.lease) io.stdout.write(`lease: ${record.lease.active ? 'active' : 'not active'} (${(record.lease.app_ids || []).join(', ')})\n`);
  return 0;
}

async function probe({ dataDir, io, deps }) {
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  if (record && record.available) {
    io.stdout.write(`probe report from the running helper (${record.user}, ${record.platform}):\n`);
    io.stdout.write(`capabilities: ${(record.capabilities || []).join(', ') || 'none'}\n`);
    printProbes(io, record.probes);
    return 0;
  }
  const localProbe = deps.localProbe || (async () => {
    const { selectBackend, loadBackend, NO_BACKEND_REPORT } = require('../../session/backends');
    const name = selectBackend({});
    if (!name) return NO_BACKEND_REPORT('no desktop session in this shell');
    const backend = loadBackend(name, {});
    try { return await backend.probe(); } finally { await backend.stop(); }
  });
  const r = await localProbe();
  io.stdout.write('local probe from this shell, not the running helper:\n');
  io.stdout.write(`capabilities: ${(r.capabilities || []).join(', ') || 'none'}\n`);
  printProbes(io, r.probes);
  return 0;
}

async function runHelperFromCli({ flags, deps }) {
  const runHelper = deps.runHelper || ((opts) => require('../../session/helper').runSessionHelper(opts));
  const ac = new AbortController();
  const stop = () => ac.abort();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, stop);
  try {
    return await runHelper({ sessionFile: flags.sessionFile || null, signal: ac.signal });
  } finally {
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(sig, stop);
  }
}

async function runSessionCommand({ sub, arg, flags = {}, dataDir, io, deps = {} }) {
  try {
    switch (sub) {
      case undefined: return await runHelperFromCli({ flags, deps });
      case 'install': return await install({ flags, dataDir, io, deps });
      case 'uninstall': return await uninstall({ flags, dataDir, io, deps });
      case 'status': return await status({ dataDir, io, deps });
      case 'probe': return await probe({ dataDir, io, deps });
      // Internal: the user-home writer, spawned as the target user by install.
      case '_write-autostart': {
        const content = await readStdin(deps.stdin || io.stdin || process.stdin);
        require('../../session/autostart').writeAutostartFile({ file: arg, content });
        return 0;
      }
      case '_remove-autostart':
        require('../../session/autostart').removeAutostartFile({ file: arg });
        return 0;
      default:
        io.stderr.write(SESSION_USAGE);
        return 2;
    }
  } catch (err) {
    io.stderr.write(`${isGuiError(err) ? err.message : `Error: ${err.message}`}\n`);
    return 1;
  }
}

module.exports = { runSessionCommand, readNodeId, SESSION_USAGE };
```

- [ ] **Step 4: Wire it into `src/service/cli.js`**

1. HELP, after the `frontdoor` line:

```
  king-louie-service session [--session-file PATH]              (the helper, as the logged-in user)
  king-louie-service session install --user NAME [--data-dir DIR] [--dry-run]
  king-louie-service session uninstall --user NAME [--data-dir DIR] [--dry-run]
  king-louie-service session status|probe [--data-dir DIR]
```

2. `VALUE_FLAGS`: add `'session-file'`.
3. After the `--confirm` scoping check:

```js
  if (flags.sessionFile !== undefined && command !== 'session') {
    io.stderr.write('Flag "--session-file" is only valid for "session".\n');
    return 2;
  }
```

4. In the `switch`, before `default`:

```js
      case 'session': {
        const { runSessionCommand } = require('./commands/session');
        return await runSessionCommand({ sub, arg, flags, dataDir, io });
      }
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/service-cli-session.test.js tests/session-autostart.test.js tests/service-cli.test.js tests/service-cli-devices.test.js tests/service-cli-frontdoor.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/service/commands/session.js src/service/cli.js tests/service-cli-session.test.js
git commit -m "feat(service): the session command (run, install, uninstall, status, probe)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: The end-to-end run, `CLAUDE.md`, and the full suite

**Files:**
- Create: `tests/e2e/session-helper.test.js`
- Create: `tests/e2e/fixtures/session-helper-child.js`
- Modify: `CLAUDE.md` (a "Session helper" section)

**Interfaces:**
- Consumes: `createGuiSubsystem` (Task 14), `runSessionHelper` (Task 15), the fake phone's lease signers (Task 9).
- Produces: nothing new.

- [ ] **Step 1: Write the helper child fixture**

Create `tests/e2e/fixtures/session-helper-child.js`:

```js
// tests/e2e/fixtures/session-helper-child.js
// The real session helper, as its own process, for the GUI e2e. The only
// test-only input is the owner of the temp config dir (a test cannot make it
// root-owned); production has no way to set it.
const { runSessionHelper } = require('../../../src/session/helper');

const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
process.on('disconnect', () => ac.abort());
runSessionHelper({ signal: ac.signal, deps: { rootUid: Number(process.env.KL_E2E_ROOT_UID), attachLog: false } })
  .then((code) => process.exit(code), () => process.exit(1));
```

- [ ] **Step 2: Write the e2e test**

Create `tests/e2e/session-helper.test.js`:

```js
// tests/e2e/session-helper.test.js
//
// Drives real desktop apps through the real helper: Windows (Calculator,
// Notepad) or macOS (Calculator, TextEdit), in an interactive session, only
// with KL_E2E_GUI=1. No Electron, and nothing from the real profile: temp
// config and data dirs, KL_SESSION_FILE, a fake phone. Do not touch the
// mouse or keyboard while it runs (it would, correctly, yield to you).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter, once } = require('events');
const { open } = require('../../src/approvals/envelope');
const { createGuiSubsystem } = require('../../src/gui');
const { parseGuiConfig } = require('../../src/gui/config');
const S = require('../../src/gui/session-secret');
const { createAesGcmCipher } = require('../../src/platform/cipher');
const { ToolRegistry } = require('../../src/tools/tool-registry');
const { createFakePhone, testNodeIdentity } = require('../helpers/fake-phone');
const { approverStoreWith } = require('../helpers/approver-set');

const WIN = process.platform === 'win32';
const RUN = (WIN || process.platform === 'darwin') && process.env.KL_E2E_GUI === '1';
const UID = WIN ? 0 : process.getuid();
const GID = WIN ? 0 : process.getgid();

const APPS = WIN
  ? { calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe', 'calc.exe'] },
      notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processes: ['notepad.exe'] } }
  : { calculator: { name: 'Calculator', path: '/System/Applications/Calculator.app' },
      notepad: { name: 'TextEdit', path: '/System/Applications/TextEdit.app' } };

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; this.methods = new Map(); }
  isConnected() { return true; }
  async send(envelope, opts) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  registerMethod(name, fn) { this.methods.set(name, fn); }
  lastRequest() { return [...this.sent].reverse().find((s) => s.message.type === 'kl.lease.request'); }
}

const until = async (check, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe('session helper end to end', { skip: !RUN && 'set KL_E2E_GUI=1 on Windows or macOS, in an interactive session' }, () => {
  let base;
  let gui;
  let child;
  let tools;
  let relay;
  let phone;
  let identity;
  const opts = { origin: { client: 'e2e', session: null, job_id: 'job-e2e' } };

  before(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-gui-')));
    const configDir = path.join(base, 'config');
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(configDir, { mode: 0o755 });
    fs.mkdirSync(dataDir, { mode: 0o700 });
    if (!WIN) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    identity = testNodeIdentity({ key: 'gpu-box' });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const user = os.userInfo().username;
    const whoami = WIN ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') : null;
    const sid = WIN ? execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split(',').pop().replace(/"/g, '') : null;
    const { secret, endpointId } = S.mintSessionSecret();
    const endpoint = WIN ? S.endpointPath({ platform: 'win32', endpointId }) : path.join(base, 'h.sock');
    S.writeCanonical({ configDir, cipher, secret, endpointId, nodeId: identity.nodeId, sessionUser: user });
    const file = S.writeUserCopy({
      platform: process.platform, configDir, user, uid: UID, gid: GID, sid,
      content: { v: 1, node_id: identity.nodeId, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() }, runIcacls: () => {}
    });
    phone = createFakePhone();
    const store = await approverStoreWith([phone.approverRecord()]);
    relay = new FakeRelay();
    const nodeConfig = { name: 'gpu-box', profile: 'agent', capabilities: [], policy: { allowed_roots: [base], remote_sessions: { always_confirm: [], deny: [] } }, gui: parseGuiConfig({ apps: APPS }, { platform: process.platform }) };
    gui = createGuiSubsystem({
      nodeConfig, dataDir, configDir, cipher, adminUid: UID, geteuid: () => UID,
      approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } },
      deps: { endpoint }
    });
    await gui.start();
    const ready = once(gui.channel, 'ready');
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'session-helper-child.js')], {
      env: { ...process.env, KL_SESSION_FILE: file, KL_E2E_ROOT_UID: String(UID), KING_LOUIE_LOG_LEVEL: 'warn' }, stdio: 'inherit'
    });
    await ready;
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    tools = (name) => registry.get(name);
  });

  after(async () => {
    try { await tools('CloseApp').execute({ app: 'calculator', force: true }, opts); } catch { /* best effort */ }
    try { await tools('CloseApp').execute({ app: 'notepad', force: true }, opts); } catch { /* best effort */ }
    if (child) child.kill();
    if (gui) await gui.stop();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  const foregroundIs = (appId) => until(async () => {
    const fg = await gui.broker.foregroundApp([appId]);
    return fg && fg.appId === appId;
  }, `${appId} in the foreground`);

  it('launches, leases, types, captures, suspends on a foreign window, resumes, and is revoked', async () => {
    assert.equal((await tools('LaunchApp').execute({ app: 'calculator' }, opts)).ok, true);
    await foregroundIs('calculator');

    const leasing = tools('RequestLease').execute({ apps: ['calculator'], minutes: 5, reason: 'e2e' }, opts);
    await until(() => relay.lastRequest(), 'the lease request');
    await relay.methods.get('lease.grant')({ envelope: phone.leaseGrant(relay.lastRequest().envelope, { minutes: 5 }) });
    const lease = await leasing;
    assert.equal(lease.ok, true);

    assert.equal((await tools('Type').execute({ text: '12+30=' }, opts)).ok, true);
    const shot = await tools('Screenshot').execute({ app: 'calculator' }, opts);
    assert.equal(shot.ok, true);
    const jpeg = Buffer.from(shot._images[0].base64, 'base64');
    assert.ok(jpeg.length > 1000 && jpeg[0] === 0xff && jpeg[1] === 0xd8, 'a JPEG');

    assert.equal((await tools('LaunchApp').execute({ app: 'notepad' }, opts)).ok, true);
    await foregroundIs('notepad');
    assert.match((await tools('Type').execute({ text: 'x' }, opts)).error, /^foreground_mismatch/);
    assert.match((await tools('Key').execute({ keys: 'escape' }, opts)).error, /^lease_suspended/);

    const resume = relay.lastRequest();
    assert.equal(resume.message.lease.resumes, lease.lease_id);
    await relay.methods.get('lease.grant')({ envelope: phone.leaseGrant(resume.envelope, { minutes: resume.message.lease.max_minutes }) });
    await foregroundIs('calculator');
    assert.equal((await tools('Key').execute({ keys: 'escape' }, opts)).ok, true);

    await relay.methods.get('lease.revoke')({ envelope: phone.leaseRevoke(identity.nodeId, lease.lease_id) });
    assert.match((await tools('Key').execute({ keys: 'escape' }, opts)).error, /^lease_revoked/);

    assert.equal((await tools('CloseApp').execute({ app: 'notepad', force: true }, opts)).ok, true);
    assert.equal((await tools('CloseApp').execute({ app: 'calculator', force: true }, opts)).ok, true);
  });
});
```

`gui.broker.foregroundApp` is Task 8's; after a resume grant the lease manager calls `broker.focusApp` (best effort), which is why the test waits for Calculator to come back to the front before pressing Escape.

- [ ] **Step 3: Run it where it can run**

On Windows or macOS, in an interactive session, not touching the mouse or keyboard:

Run: `unset ELECTRON_RUN_AS_NODE && KL_E2E_GUI=1 node --test --test-timeout=120000 tests/e2e/session-helper.test.js` (PowerShell: `$env:KL_E2E_GUI='1'; node --test --test-timeout=120000 tests/e2e/session-helper.test.js`).
Expected: PASS. On macOS the first run needs Screen Recording and Accessibility for the `node` binary (System Settings > Privacy & Security); grant them and run again.
Without `KL_E2E_GUI=1` the suite reports one skipped test.

- [ ] **Step 4: Add the `CLAUDE.md` section**

Append to `CLAUDE.md`:

```markdown
## Session helper (fleet stage 5)

`src/gui/` (service side) and `src/session/` (the helper) implement desktop
apps and computer use on agent nodes (spec
`docs/superpowers/specs/2026-09-23-fleet-stage5-session-helper.md`;
protocols `docs/protocol/session-v1.md`, `docs/protocol/lease-v1.md`).

- `king-louie-service session` runs as the logged-in user (one session user
  per node). `session install --user NAME` (elevated) writes
  `<configDir>/session/helper-secret.json` (klc1:), the per-user copy in
  `<configDir>/session/users/`, and the login start; running it again rotates
  the secret. Installing for a second user is refused until the first is
  uninstalled. `session status` / `session probe` read the running helper's
  report from `<dataDir>/session/status.json`; a local probe is labelled as one.
- `KL_SESSION_FILE` (or `--session-file`, which the login start passes)
  points the helper at its per-user file; it is checked like the default path.
- GUI tools check the `gui` capability first, so a node without a working
  helper refuses before any approval or lease. Input needs a phone-signed
  lease; images reach the model only from tools flagged `emitsImages: true`,
  and `ToolExecutor` detaches `_images` before anything stores a result.
- Tests never touch a real LaunchAgent, autostart entry or scheduled task
  (autostart tests use fake executors) and never inject input except the
  opt-in e2e: `KL_E2E_GUI=1 node --test tests/e2e/session-helper.test.js` on
  Windows or macOS in an interactive session (drives Calculator and
  Notepad/TextEdit; hands off the mouse and keyboard while it runs).
- Vectors: `node tests/vectors/lease-v1/generate.js --check` and
  `node tests/vectors/session-v1/generate.js --check`.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `# fail 0`. Then `node tests/vectors/lease-v1/generate.js --check`, `node tests/vectors/session-v1/generate.js --check` and `node tests/vectors/client-grant-v1/generate.js --check` all report a match.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/session-helper.test.js tests/e2e/fixtures/session-helper-child.js CLAUDE.md
git commit -m "test(e2e): drive desktop apps through the session helper; CLAUDE.md section

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 5

`npm test` shows `# fail 0` and the three vector generators match. Part 6 (`2026-09-23-fleet-stage5-session-helper-part6.md`) adds the phone side (Tasks 22–25).
