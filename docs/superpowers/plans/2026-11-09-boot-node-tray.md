# Personal node at boot, King Louie in the tray: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The personal node starts at boot as the owner (S4U, no window, no password), and the King Louie app, started at login into the tray, is the node's screen host.

**Architecture:** `install --personal` (from the installed app only) registers `KingLouie Node` with boot and logon triggers, S4U, a security descriptor letting the owner run and read it, and an action that runs the app's binary with `--kl-node-service`, which `main.js` turns into a console-free `ELECTRON_RUN_AS_NODE` child. Started that way the node gets `--screen-host app`: its GUI subsystem listens on an owner-only pipe (the existing `HelperChannel`) and writes `<dataDir>/session/personal-helper.json`. The app, in the owner's session, runs the existing session helper loop against that file. Persistent browser profiles open only through the screen host.

**Tech Stack:** Node (`node --test`), Electron 41 (`Tray`, `Menu`), Windows Task Scheduler XML, `schtasks.exe`, `reg.exe`, PowerShell `Start-Process -Verb RunAs` for the one elevated step.

**Spec:** `docs/superpowers/specs/2026-11-09-boot-node-tray-design.md`

## Global Constraints

- Windows only; every new code path refuses or no-ops off `win32`.
- No console window anywhere: every child is spawned with `windowsHide: true`; the task action contains no `powershell.exe`.
- The only elevated action at install is `schtasks /Create`; at uninstall, `schtasks /Delete`. The CLI keeps refusing an elevated prompt (`install --personal runs as you, not elevated: open a normal prompt`).
- The node never runs elevated: task `RunLevel` is `LeastPrivilege`.
- No password is stored: principal `LogonType` is `S4U`.
- Everything under `src/` stays Electron-free except `src/ipc/` (`tests/electron-boundary.test.js`); every spawn of `process.execPath` sets its own `ELECTRON_RUN_AS_NODE`.
- No test registers a real task, runs real `schtasks`/`reg`, raises UAC, or touches the real `%LOCALAPPDATA%`/`%APPDATA%` or HKCU; inject `execFile`/`spawn`.
- Use `createLogger` (`src/logging.js`), not `console.*`, outside CLI output.
- Strings from the node, the CLI or files reach the pane through `shown`.
- Tests: `node --test tests/<file>.test.js`; the full `npm test` once at the end, not per task.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Plan-level decisions (beyond the spec)

- **D-1 (spec C-12, made definite):** the task XML always carries the security descriptor `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;<ownerSID>)`. The owner gets read and run, not write (write would let him raise `RunLevel`). Deterministic and testable, instead of "only if needed".
- **D-2 (spec §5.2 transport):** the screen host uses the existing kl-session-v1 `HelperChannel` over a named pipe whose name and secret the node writes to `<dataDir>/session/personal-helper.json`. The pipe is listened with libuv's default security (no `readableAll`/`writableAll`), so only the owner, SYSTEM and Administrators can open it.
- **D-3:** how the node knows it serves the screen through the app: the task passes `run --screen-host app`. A node run by hand without the flag keeps `InProcessChannel` (spec §5.2, last bullet).
- **D-4:** the app's start at login is the HKCU Run value `King Louie` = `"<app exe>" --kl-tray`, written by one Electron-free module used by the CLI and the app alike (no `app.setLoginItemSettings`, so both write the same value).

## Review Focus

1. **The app starts before the node** (boot is slow, the node is restarting): the app's screen host keeps retrying with backoff while `personal-helper.json` is missing or the pipe refuses, and never exits. Test in Task 7.
2. **The node restarts with a new pipe and secret:** the screen host re-reads the file before every connect and reconnects. Test in Task 7.
3. **The owner says No to the UAC prompt:** install exits 1 with "Windows did not register the task: the administrator prompt was declined. Nothing else changed.", writes no Run value and starts nothing. Test in Task 3.
4. **An existing logon-task install** (PowerShell action) still reads correctly in the window (`parseTaskXml`) until it is replaced, and re-installing replaces it (`/F`). Tests in Tasks 2 and 3.
5. **A chat's browser tool before login:** a persistent profile is refused with code `screen_host_missing` and "Saved logins are available after you log in", and `ephemeral: true` still works. Test in Task 6.

---

### Task 1: Administrators membership and the elevated schtasks runner

**Files:**
- Modify: `src/service/commands/admin-check.js`
- Create: `src/service/elevated-schtasks.js`
- Test: `tests/service-elevated-schtasks.test.js`

**Interfaces:**
- Produces: `isAdministratorsMember({ execFile, env }) -> boolean` (from `admin-check.js`); `runElevatedSchtasks(args: string[], { execFile, env }) -> Promise<{ ok: true } | { ok: false, code: 'UAC_DECLINED' | 'SCHTASKS_FAILED', exitCode?: number, message: string }>`.

- [ ] **Step 1: Write the failing tests**

```js
// isAdministratorsMember
it('is true when whoami /groups lists S-1-5-32-544, even as deny-only (unelevated split token)', ...)
//   fake execFile(whoami.exe, ['/groups','/fo','csv']) returns a CSV row
//   "BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"
//   → true; asserts execFile was called with windowsHide: true and the absolute System32 whoami path
it('is false when S-1-5-32-544 is absent', ...)
it('is false when whoami throws', ...)
// runElevatedSchtasks
it('runs powershell Start-Process -Verb RunAs -Wait -PassThru on the absolute schtasks path with each arg as one array element', ...)
//   assert the PowerShell -Command script contains no interpolated arg text: args go through
//   -ArgumentList built from a base64 JSON blob passed as one argv element
it('maps a non-zero ExitCode to { ok:false, code:"SCHTASKS_FAILED", exitCode }', ...)
it('maps "The operation was canceled by the user" to { ok:false, code:"UAC_DECLINED" }', ...)
```

- [ ] **Step 2: Run** `node --test tests/service-elevated-schtasks.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** `isAdministratorsMember` parses `whoami /groups /fo csv` (absolute path via `windowsSystemRoot`) for the SID column `S-1-5-32-544`. `runElevatedSchtasks` runs `windowsPowerShellExe(env)` with `-NoProfile -NonInteractive -Command <fixed script>` and one extra argument, a base64 JSON array of `[schtasksPath, ...args]`. The fixed script decodes it, calls `Start-Process -FilePath $a[0] -ArgumentList $a[1..] -Verb RunAs -Wait -PassThru -WindowStyle Hidden`, and writes `$p.ExitCode`. Spawn with `windowsHide: true` and a 300 s timeout (a person is answering).

- [ ] **Step 4: Run** the test again. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): Administrators membership check and the elevated schtasks step`.

---

### Task 2: The boot task's XML and reading it back

**Files:**
- Modify: `src/service/personal-install.js` (`renderPersonalTaskXml`)
- Modify: `src/desktop-bridge/personal-node.js` (`TASK_CALL`, `parseTaskXml`)
- Test: `tests/service-cli-install-personal.test.js`, `tests/desktop-personal-node.test.js`

**Interfaces:**
- Produces: `renderPersonalTaskXml({ sid, appPath, entryPath, dataDir }) -> string`. `runAsNode` and `nodePath` are gone, because the action is always the app's binary. `parseTaskXml(xml) -> { userId, enabled, program, entry, dataDir, logonType, boot }` reads both the new action and the old PowerShell one.

- [ ] **Step 1: Write the failing tests**

```js
it('renders a boot trigger and a logon trigger for the SID', ...)        // <BootTrigger>, <LogonTrigger><UserId>SID
it('renders an S4U principal at LeastPrivilege', ...)                    // <LogonType>S4U</LogonType>
it('renders the security descriptor letting the owner read and run', ...)
//   <SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;S-1-5-21-1-2-3-1001)</SecurityDescriptor>
it('runs the app binary with no PowerShell', ...)
//   <Command>C:\Program Files\King Louie\King Louie.exe</Command>
//   <Arguments>--kl-node-service "C:\...\app.asar\bin\king-louie-service.js" run --data-dir "C:\Users\o\AppData\Local\KingLouie\node\data" --screen-host app</Arguments>
//   assert the XML does not contain 'powershell'
it('keeps IgnoreNew, no battery stops, PT0S and RestartOnFailure PT1M x3', ...)
// parseTaskXml
it('reads program, entry and dataDir from the new action', ...)
it('still reads the old PowerShell action (an install from before this)', ...)  // existing fixture
it('reports logonType S4U and boot true for the new task, InteractiveToken and false for the old', ...)
```

- [ ] **Step 2: Run** both test files. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Quote each path with `"…"` (`sanitizeWindowsPath` already refuses `"`). Add a second regex, `NODE_SERVICE_CALL`, for `--kl-node-service "<entry>" run --data-dir "<dir>"`. Keep `TASK_CALL` for the old form.

- [ ] **Step 4: Run** both files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): the boot task, S4U, owner run-and-read, no PowerShell`.

---

### Task 3: `install --personal` / `uninstall --personal` with one UAC prompt, and the login start

**Files:**
- Create: `src/desktop-bridge/login-start.js`
- Modify: `src/service/personal-install.js` (`install`, `uninstall`, `resolveDeps`, consent lines)
- Test: `tests/service-cli-install-personal.test.js`, `tests/desktop-login-start.test.js`

**Interfaces:**
- Consumes: `isAdministratorsMember`, `runElevatedSchtasks` (Task 1); `renderPersonalTaskXml` (Task 2).
- Produces: `readLoginStart({ execFile, env }) -> { on: boolean, command: string | null }`, `setLoginStart({ on: boolean, appPath: string }, { execFile, env }) -> void`, and `LOGIN_START_VALUE = 'King Louie'` (in `login-start.js`, through `reg.exe` at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, data `"<appPath>" --kl-tray`). New `resolveDeps` keys: `isAdministratorsMember`, `elevated` (`runElevatedSchtasks`), `setLoginStart`.

- [ ] **Step 1: Write the failing tests**

```js
it('refuses outside the installed app (not under Electron)', ...)
//   deps.runAsNode false → exit 2, stderr: 'install --personal runs from the installed King Louie app: open King Louie and use Install, or run its king-louie-service command'
it('refuses an owner who is not an administrator, before the question', ...)
//   isAdministratorsMember → false → exit 2: 'the boot task needs an administrator account: your account is not in Administrators'; confirm never called
it('still refuses an elevated prompt', ...)                    // unchanged message
it('writes the task XML into the config dir, not the temp dir', ...)
it('registers through the elevated step, then starts it unelevated with /Run', ...)
//   elevated called with ['/Create','/TN','KingLouie Node','/XML',<configDir>\\king-louie-node-task.xml,'/F']
it('turns on the login start with the app path', ...)          // setLoginStart({ on:true, appPath })
it('on UAC_DECLINED: exit 1, the declined message, no login start, no /Run', ...)
//   'Windows did not register the task: the administrator prompt was declined. Nothing else changed.'
it('the consent text names the boot task, S4U, no stored password, one prompt and the tray', ...)
//   lines include 'boot task:  KingLouie Node (starts at boot as you; no password is stored)'
//   and 'one Windows administrator prompt registers it; the node itself never runs elevated'
//   and 'screen work (takes, computer use) needs you logged in with King Louie in the tray'
//   and 'saved browser logins are used only after you log in'
it('re-installing over a logon task replaces it (/F) and keeps node.yaml', ...)
it('uninstall stops the node, deletes the task through the elevated step, and turns the login start off', ...)
// login-start.js
it('setLoginStart on writes reg add HKCU\\...\\Run /v "King Louie" /t REG_SZ /d "\\"<app>\\" --kl-tray" /f', ...)
it('setLoginStart off runs reg delete ... /f and treats "unable to find" as done', ...)
it('readLoginStart parses the REG_SZ value', ...)
```

- [ ] **Step 2: Run** both test files. Expected: FAIL.

- [ ] **Step 3: Implement.** Order: refusals (TTY, elevated, not Electron, not an administrator, fleet, data dir). Then the consent question. Then write `node.yaml` (as today). Then write the XML to `<configDir>\king-louie-node-task.xml` (0o600, UTF-16LE with BOM). Then the elevated `/Create`, delete the XML (always), `setLoginStart`, and `/Run` when startable. Replace `REBOOT_LINE` and the `logon task:` line with the spec §5.5 wording above. Uninstall: stop the node as today, then `runElevatedSchtasks(['/Delete','/TN',NAME,'/F'])` and `setLoginStart({ on: false })`. Drop the unelevated `/End`, which the descriptor does not allow.

- [ ] **Step 4: Run** both files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): install registers the boot task with one UAC prompt and turns on the login start`.

---

### Task 4: `--kl-node-service`: the console-free node launch

**Files:**
- Create: `src/desktop-bridge/node-launcher.js`
- Modify: `main.js` (the very first statements, before `require('electron')` and before `claimSingleInstance`)
- Test: `tests/desktop-node-launcher.test.js`

**Interfaces:**
- Produces: `runNodeService({ argv, execPath, env, spawn }) -> Promise<number>`. It spawns `execPath` with `argv` after `--kl-node-service`, env `{ ...env, ELECTRON_RUN_AS_NODE: '1' }`, `stdio: 'ignore'`, `windowsHide: true`, and resolves the child's exit code (1 on spawn error). `isNodeServiceLaunch(argv) -> boolean`.

- [ ] **Step 1: Write the failing tests**

```js
it('spawns the same binary with ELECTRON_RUN_AS_NODE=1 and the rest of argv', ...)
//   argv ['K.exe','--kl-node-service','C:\\e.js','run','--data-dir','C:\\d','--screen-host','app']
//   → spawn('K.exe', ['C:\\e.js','run','--data-dir','C:\\d','--screen-host','app'], { env.ELECTRON_RUN_AS_NODE:'1', stdio:'ignore', windowsHide:true })
it('resolves the child exit code', ...)
it('resolves 1 when spawn errors', ...)
it('forwards SIGTERM/SIGINT to the child', ...)
it('main.js checks isNodeServiceLaunch before requiring electron and before the single-instance claim', ...)
//   read main.js source: the index of 'isNodeServiceLaunch' < index of "require('electron')" and < 'claimSingleInstance'
```

- [ ] **Step 2: Run** the test. Expected: FAIL.

- [ ] **Step 3: Implement** the module and the `main.js` guard: `if (require('./src/desktop-bridge/node-launcher').isNodeServiceLaunch(process.argv)) { require(...).runNodeService({...}).then((code) => process.exit(code)); return; }`. The launcher must not take the single-instance lock, otherwise an open desktop would make the node launch exit.

- [ ] **Step 4: Run** the test, and also `node --test tests/electron-boundary.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): --kl-node-service starts the node as Node with no console`.

---

### Task 5: The node's screen host channel (`--screen-host app`)

**Files:**
- Create: `src/gui/personal-screen-host.js`
- Modify: `src/gui/helper-channel.js` (constructor option `shared`, default `true`)
- Modify: `src/gui/index.js` (`buildGuiSubsystem`: `screenHost` option)
- Modify: `src/service/cli.js` (`--screen-host app`, valid for `run` only), `src/service/run.js` (pass `screenHost` to `createGuiSubsystem`)
- Test: `tests/gui-personal-screen-host.test.js`, `tests/service-run-personal.test.js`

**Interfaces:**
- Produces: `PERSONAL_HELPER_FILE = 'session/personal-helper.json'` (relative to the data dir); `writePersonalHelperFile({ dataDir, nodeId, user, randomBytes }) -> { endpoint, secret, nodeId, sessionUser, mtimeMs }`, which writes `{ v: 1, endpoint, secret: <hex 32 bytes>, node_id, user }` 0o600 under an `ensurePrivateDir`, with the pipe `\\.\pipe\king-louie-personal-<16 hex>`. Also `readPersonalHelperFile({ dataDir }) -> same shape | throws` (lstat: regular file, not a link, at most 4096 bytes, exactly those keys), and `removePersonalHelperFile({ dataDir })`. `createGuiSubsystem({ ..., screenHost: 'app' | null })`.

- [ ] **Step 1: Write the failing tests**

```js
it('with hosting personal and screenHost app, uses a HelperChannel on the file\'s endpoint, not InProcessChannel', ...)
it('the channel listens without readableAll/writableAll (shared:false)', ...)   // fake net.Server records listen options
it('writes personal-helper.json at start with a fresh secret and endpoint each start, and removes it at stop', ...)
it('readSecret returns the file\'s secret, node id and user, so the existing handshake admits the app', ...)
//   drive a real HelperChannel with src/session/connection.js connectToService over the pipe (as session-helper tests do)
it('without screenHost, personal hosting keeps InProcessChannel (a node run by hand)', ...)
it('before a screen host connects, a GUI tool refuses capability_unavailable naming that King Louie is not running in your session', ...)
//   message: 'King Louie is not running in your session: log in, or open King Louie'
it('readPersonalHelperFile refuses a link, a non-file, extra keys and >4096 bytes', ...)
it('run --screen-host app reaches createGuiSubsystem; --screen-host on any other command is a usage error', ...)
```

- [ ] **Step 2: Run** both test files. Expected: FAIL.

- [ ] **Step 3: Implement.** `user` is `os.userInfo().username`. The node writes the file in `subsystem.start()` before `channel.start()` and removes it in `stop()`. The broker's unavailable message comes from `capability()` while `channel.connected` is false and `screenHost === 'app'`.

- [ ] **Step 4: Run** both files. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): a boot-started node serves the screen through King Louie over an owner-only pipe`.

---

### Task 6: Browsers through the screen host, never from session 0

**Files:**
- Create: `src/gui/screen-host-browser.js`
- Modify: `src/tools/builtin/browser-registry.js` (`setScreenHostLauncher(fn | null)`, `screenHostLauncher()`)
- Modify: `src/browser/playwright-browser.js` (`start`: delegate a persistent `userDataPath` when a launcher is set)
- Modify: `src/gui/takes.js` (in screen-host mode, `launchTakeBrowser` is `_launchFleetBrowser`)
- Modify: `src/session/connection.js` (`createOpHandler(backend, { profileRoot })`), `src/session/backends/windows.js` (`launchBrowser({ profileRoot })`, default unchanged), `src/session/backends/index.js` (`loadBackend(name, { profileRoot })` pass-through)
- Modify: `src/gui/index.js` (register the launcher when `screenHost === 'app'`, clear at stop)
- Test: `tests/gui-screen-host-browser.test.js`, `tests/gui-takes.test.js`, `tests/session-helper.test.js`

**Interfaces:**
- Consumes: the subsystem's broker and channel (Task 5).
- Produces: `createScreenHostLauncher({ broker, guiConfig, profilesRoot }) -> { launch({ userDataPath, headless }) -> Promise<{ cdpUrl, pid }> }`. It throws `GuiError('screen_host_missing', 'Saved logins are available after you log in')` when the channel is not connected, and `GuiError('invalid_params')` for a `userDataPath` outside `profilesRoot`. The profile name is `path.basename(userDataPath)`. It runs `launch_browser` with `exe: guiConfig.apps[guiConfig.browser].path`, `args: [...CHROME_FLAGS, ...(headless ? ['--headless=new'] : [])]`, and returns the DevTools URL.

- [ ] **Step 1: Write the failing tests**

```js
it('a persistent start before the screen host connects refuses screen_host_missing with "Saved logins are available after you log in"', ...)
it('ephemeral: true still launches headless locally', ...)
it('after connecting, a persistent start runs launch_browser for the profile name and attaches over CDP', ...)
//   fake channel answers launch_browser; assert PlaywrightBrowser#attach got the cdpUrl (headless Chromium via tests/helpers/debuggable-chromium.js)
it('a raw userDataPath outside <dataDir>/browser-profiles is refused invalid_params in screen-host mode', ...)
it('no gui.browser app configured: refuses with the existing NO_CHROME remedy', ...)
it('a take in screen-host mode launches through the fleet path, not launchPersonalBrowser', ...)   // gui-takes
it('createOpHandler passes profileRoot to backend.launchBrowser; the op wire is unchanged', ...)    // session-helper
it('the Windows backend puts the profile under profileRoot when given', ...)                         // fake spawn, assert --user-data-dir
```

- [ ] **Step 2: Run** the three test files. Expected: FAIL.

- [ ] **Step 3: Implement.** `PlaywrightBrowser#start`: if `screenHostLauncher()` is set and `opts.userDataPath` is set, `await this.attach(await launcher.launch(opts))` and return. Ephemeral and the no-launcher cases are unchanged.

- [ ] **Step 4: Run** the three files plus `tests/browser-registry.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(personal): saved browser profiles open only through King Louie in the owner's session`.

---

### Task 7: King Louie is the screen host

**Files:**
- Modify: `src/session/helper.js` (`runSessionHelper`: `deps.readCopy`, `deps.profileRoot`; a failed read with `readCopy` waits and retries instead of returning 1)
- Create: `src/ipc/screen-host.js`
- Modify: `src/ipc/attached-host.js` (start the screen host after `controller.startAttached()` when the record is personal on win32; stop it in `shutdown()`)
- Test: `tests/session-helper.test.js`, `tests/ipc-screen-host.test.js`

**Interfaces:**
- Consumes: `readPersonalHelperFile`, `PERSONAL_HELPER_FILE` (Task 5); `profileRoot` (Task 6).
- Produces: `startScreenHost({ dataDir, platform, log, deps }) -> { stop(): Promise<void>, recording(): boolean, connected(): boolean, on('change', fn) }`. `recording()` is true between a `record_start` answered ok and its `record_stop`. It is tracked by wrapping `handleOp`, the hook `runSessionHelper` takes as `deps.wrapOp`.

- [ ] **Step 1: Write the failing tests**

```js
it('runSessionHelper with readCopy connects with the file\'s endpoint, secret and node id', ...)
it('a missing file is retried with backoff, never an exit (app before node)', ...)        // Review Focus 1
it('a node restart with a new endpoint and secret: re-read before each connect, reconnects', ...)  // Review Focus 2
it('startScreenHost passes profileRoot <dataDir>\\browser-profiles and attachLog false', ...)
it('recording() follows record_start / record_stop', ...)
it('attached host starts the screen host only for a personal record on win32, and not for a fleet or remote tab', ...)
it('shutdown stops it (signal aborted, recordings stopped)', ...)
```

- [ ] **Step 2: Run** both test files. Expected: FAIL.

- [ ] **Step 3: Implement.** `src/ipc/screen-host.js` runs `runSessionHelper` with an `AbortController`. It logs through `createLogger('screen-host')`, and its backend is the Windows backend loaded with `profileRoot`.

- [ ] **Step 4: Run** both files and `tests/electron-boundary.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(desktop): King Louie serves the personal node's screen from the owner's session`.

---

### Task 8: The tray

**Files:**
- Create: `src/desktop-bridge/tray-model.js` (Electron-free: menu items and icon state from the controller's status)
- Create: `src/ipc/tray.js` (Electron `Tray`/`Menu` over the model)
- Modify: `main.js` (`--kl-tray`: no window at ready; window `close` hides when the tray is up; `window-all-closed` does not quit while the tray is up; Quit from the tray asks first when `screenHost.recording()`)
- Modify: `src/desktop-bridge/launch-mode.js` (`--kl-tray` is kept by `relaunch()`; it never changes the host choice)
- Test: `tests/desktop-tray-model.test.js`, `tests/launch-mode.test.js`, `tests/e2e/tray.test.js`

**Interfaces:**
- Consumes: `startScreenHost` (Task 7); the controller's `status()` and `nodeStart({ restart })` (existing).
- Produces: `trayModel(status, { recording }) -> { icon: 'up' | 'starting' | 'down', tooltip: string, items: Array<{ id: 'open' | 'state' | 'start' | 'restart' | 'take' | 'quit', label, enabled }> }`. Tray mode is on when `launch.host === 'attached'`, `platform === 'win32'`, and the paired record has `service.hosting === 'personal'`.

- [ ] **Step 1: Write the failing tests**

```js
it('connected: icon up, tooltip "King Louie: node running", items open, state, restart, quit', ...)
it('starting: icon starting, "King Louie Node is starting…", no start/restart', ...)
it('down with a registered task: icon down, a Start item', ...)
it('a live recording adds a disabled "A take is recording" line', ...)
it('relaunch keeps --kl-tray; --kl-tray never changes attached/standalone', ...)          // launch-mode
// e2e (Windows only; launchApp({ attached: true }) on a personal fake record, args ['--kl-tray']):
it('starts with no visible window; the tray action opens it; closing hides it; tray Quit exits', ...)
//   drive the tray through a test-only IPC hook under KL_TEST_MODE (the native tray cannot be clicked by Playwright)
```

- [ ] **Step 2: Run** the unit files. Expected: FAIL.

- [ ] **Step 3: Implement.** The tray icon images come from `icons/` (existing `icon.ico`; `starting`/`down` reuse it with a tooltip difference, so no new bitmaps). The Quit confirmation is `dialog.showMessageBoxSync` with "A take is recording. Quit and end it?" and buttons Quit / Cancel.

- [ ] **Step 4: Run** the unit files, then `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/tray.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(desktop): King Louie lives in the tray when attached to a personal node`.

---

### Task 9: The window's install, the login-start setting, and the words

**Files:**
- Modify: `src/ipc/desktop-controller.js` (`nodeInstall`, `nodeInstallPreview`: the CLI's new lines and the UAC outcome; `UAC_DECLINED` → code `NODE_INSTALL_DECLINED`; new `loginStart()` / `setLoginStart({ on })`)
- Modify: `src/ipc/desktop-handlers.js`, `src/desktop-bridge/allowlist.js` (`desktop:loginStart`, `desktop:setLoginStart` in `LOCAL_CHANNELS`)
- Modify: `src/desktop-bridge/pane-model.js`, `src/desktop-bridge/setup-flow.js` (spec §5.5 wording; a "Start King Louie when I log in" toggle row on a personal node)
- Modify: `renderer.js` / `index.html` (the toggle; draw from the pane model only)
- Modify: `src/service/doctor.js` (`hosting` row: boot task or logon task; a `screen host` row: connected or not, from `status.json`)
- Test: `tests/desktop-controller.test.js`, `tests/desktop-bridge-allowlist.test.js`, `tests/service-doctor-hosting.test.js`, the pane-model and setup-flow tests

**Interfaces:**
- Consumes: `readLoginStart`/`setLoginStart` (Task 3); `parseTaskXml().logonType` (Task 2).
- Produces: pane rows `loginStart: { on }`; doctor rows `hosting` ("personal (boot task, S4U)" / "personal (logon task: run install --personal from King Louie to start at boot)") and `screen host`.

- [ ] **Step 1: Write the failing tests** (one per produced row/code above, and that `desktop:setLoginStart` is local-only)
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): boot-task install from the window, the login-start toggle, doctor rows`.

---

### Task 10: Docs, the dev-copy rule, and the manual checklist

**Files:**
- Modify: `docs/install-guide.md` (§13), `docs/driving-king-louie.md` (§2), `CLAUDE.md` ("Personal node" and "Attached mode": boot task, S4U, the screen host, the tray, `--kl-node-service`, `--screen-host app`, `--kl-tray`; replace the residual "a logon-task node is down from a reboot until the owner logs in")
- Modify: `docs/superpowers/specs/2026-11-09-boot-node-tray-design.md` (C-12 as D-1; §5.2 transport as D-2)
- Create: `docs/superpowers/plans/2026-11-09-boot-node-tray-manual-checks.md`
- Test: `tests/docs-driving.test.js`, `tests/examples.test.js` (must stay green)

- [ ] **Step 1: Confirm the dev-copy rule (spec C-14) holds.** Find or add a test in `tests/service-run-personal.test.js`: a second `run` on a data dir whose pidfile names a live service is refused (`acquireInstanceLock`). Run it. Expected: PASS.
- [ ] **Step 2: Write the docs**, including "a development copy uses its own `--data-dir`" and "test the real path by building the installer from a worktree (`npm run build:win`) and installing it".
- [ ] **Step 3: Write the manual checklist** for the owner's machine. Each item gets its pass condition:
  - Install from the app: one UAC prompt; `schtasks /Query /TN "KingLouie Node" /XML` shows S4U, the boot trigger and the descriptor.
  - Reboot without logging in: the phone confirms the node.
  - Log in: King Louie appears in the tray with no window and no console; `doctor` says the screen host is connected.
  - The window's Start and Restart work unelevated. If they don't, report it; D-1 is wrong.
  - Lock during a take: it ends `screen_locked`; the node keeps running.
  - Sleep and wake: the node is still running, the app reconnects, the phone confirms.
  - A chat's browser tool after login: Chrome is visible with saved logins.
  - Uninstall: one UAC prompt; the task and the Run value are gone; the data dir stays.
- [ ] **Step 4: Run** `node --test tests/docs-driving.test.js tests/examples.test.js`. Expected: PASS.
- [ ] **Step 5: Run the full suite once:** `npm test`. Expected: `# fail 0`.
- [ ] **Step 6: Commit** `docs(personal): boot task, screen host and tray; the manual checklist`.
