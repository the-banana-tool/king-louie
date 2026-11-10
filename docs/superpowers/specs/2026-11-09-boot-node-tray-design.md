# Personal node at boot, King Louie in the tray

Date: 2026-11-09. Windows only. Follows the personal node spec
(`2026-10-25-personal-node-design.md`), the desktop-attached spec
(`2026-10-28-desktop-attached-to-personal-node-design.md`) and attach stages 2
and 3. Stage 2 listed "a node started at boot rather than at logon" as a
non-goal; this design takes it on.

Owner decisions are marked **(owner)**. The author's calls are marked
**(C-n)** and listed at the end so the owner can check them.

## 1. Why

Today the personal node is the logon task `KingLouie Node`, whose action is
`powershell.exe -WindowStyle Hidden … node run` (`renderPersonalTaskXml`,
`src/service/personal-install.js`). Two things go wrong:

- **A PowerShell window opens whenever the node starts.** PowerShell is a
  console program, so Windows makes a console before PowerShell can hide it.
  With Windows Terminal as the default terminal (the Windows 11 default),
  `-WindowStyle Hidden` often does not hide anything. That window *is* the
  node: closing it, by hand or however it goes on sleep, kills the node.
- **Nothing runs until the owner logs in.** After a reboot the phones show
  "Could not confirm", tasks from claude.ai cannot be placed, and wake-ups do
  not fire until someone logs in.

The owner wants the node to start when the computer boots, and, once he is
logged in, to be able to use the screen (takes, computer use, a visible
Chrome) as today **(owner)**.

## 2. Goals

1. The node starts at boot, as the owner's account, with no window, whether
   or not anyone is logged in **(owner)**. No password is stored **(owner)**.
2. It keeps running through sleep, lock, logout and login. Nothing visible
   can be closed by accident to stop it.
3. When the owner logs in, the King Louie desktop app starts in the system
   tray with no window, and it is what does the screen work: screenshots,
   input, the take's Chrome, recordings **(owner)**.
4. Clicking the tray icon opens the chat window, attached to the node as it
   is today. Closing the window hides it to the tray; Quit is in the tray
   menu.
5. Install costs one admin (UAC) prompt, for registering the boot task only
   **(owner)**. The node itself never runs elevated.
6. The always-on node is the **installed King Louie app**: the boot task runs
   the app's own binary, and the same app is the tray icon **(owner)**. A
   checkout is for development only, run by hand with its own data
   **(owner)**. This is the usual pattern (Tailscale, Docker Desktop, Ollama:
   an installed background part plus an installed tray app, dev builds run
   separately), and it ends the residual that the logon task pins a checkout
   that can move or be deleted.

## 3. Non-goals

- Storing the owner's Windows password anywhere (Task Scheduler included)
  **(owner)**.
- A separate screen-only tray program. The tray icon is the King Louie app
  **(owner)**.
- Screen work before login or while the screen is locked. The screen belongs
  to the logged-in session; before login screen tools say so and refuse.
- Saved site logins before login (see §5.3).
- macOS and Linux (stage 4 of the attach programme, unchanged).
- Fleet nodes (LOCAL SERVICE, the session helper file, the courier grant):
  unchanged.
- Waking a sleeping machine.
- A boot task that runs a checkout's `node.exe` (§5.6).
- An owner who is a standard (non-admin) user (C-11).

## 4. Anti-goals

These would make the work a failure even if everything else works:

- **A console window of any kind**, at boot, at login or on a restart.
- **A wider trust rule.** The personal node's trust boundary stays "the
  process is the account that owns the data dir and the config dir". Only
  the owner's account can connect as the screen host; nothing new listens
  beyond loopback or the owner's own pipe.
- **Lost browser logins.** Nothing the node does before login may damage the
  owner's saved Chrome profiles (§5.3).
- **A second elevated step creeping in.** Registering the task is the only
  elevated action at install; the CLI's own work, the node, the app and the
  helper stay unelevated.

## 5. Design

### 5.1 The boot task

- `install --personal` registers `KingLouie Node` with a **boot trigger**,
  principal = the owner's SID, logon type **S4U** ("run whether the user is
  logged on or not", "do not store password"), `LeastPrivilege`
  **(owner, C-1)**.
- It also keeps a **logon trigger** for the owner as a backstop: if the boot
  start failed, logging in starts it, and `MultipleInstancesPolicy`
  `IgnoreNew` stops a second copy **(C-2)**.
- The action starts the node **with no console host at all**: no
  `powershell.exe` wrapper **(C-3)**. The program is the installed app's own
  binary (Electron, a GUI-subsystem executable) running
  `bin/king-louie-service.js` as Node **(owner)**. The task cannot set
  environment variables itself, so the builder must find a way to get
  `ELECTRON_RUN_AS_NODE` set without a console (for example, an argument the
  app's `main.js` recognises before anything else and re-executes itself
  with the variable set, or another mechanism that leaves no window).
  Whatever is chosen,
  `king-louie-service stop` keeps working (it stops the node by the pidfile
  and the stop file, not by killing a wrapper), and `queryTask`'s reading of
  "what the task runs" (`parseTaskXml`, `NODE_TASK_PROGRAM_GONE`) is updated
  to the new action.
- Settings kept from today: no battery stops, no time limit,
  `RestartOnFailure`.
- **The one elevated step (owner).** Only the `schtasks /Create /XML`
  registration runs elevated, through one UAC prompt (for example
  ShellExecute `runas` of `schtasks.exe` by absolute path, with the XML
  written beforehand where an unelevated user cannot change it between
  writing and registering). Everything else `install --personal` does stays
  unelevated, and the CLI keeps refusing to be run from an elevated prompt
  (`PAIR_ELEVATED`-style refusals are unchanged). Install from the window
  (`nodeInstall`) gets the same single prompt.
- **The owner must be an administrator** of the machine **(C-11)**. S4U needs
  "Log on as a batch job", which Administrators have by default, and the UAC
  prompt then elevates the owner's own token, so the task is registered by and
  for the same account. `install --personal` checks this first and refuses a
  standard user with a plain message, before the consent question.
- **The task grants the owner run and read (C-12, made definite as plan D-1).**
  The task XML always carries the security descriptor
  `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;<ownerSID>)`, so the owner,
  unelevated, can `/Run`, `/Query` and stop the boot task (the window's
  Start, Restart and status depend on it). The owner gets read and run, not
  write: write would let him raise `RunLevel`. It grants nothing beyond the
  owner's own account, already the trust boundary, and is not a UAC prompt
  per Start or a return to the logon task.
- **What the builder must confirm on a real machine** before relying on it:
  that registration works after the UAC prompt; that C-12's descriptor lets
  the unelevated owner Start and Restart; and that `uninstall --personal` can delete the task (one more UAC
  prompt at uninstall is acceptable if Windows requires it, C-4).
- **Existing installs.** Running `install --personal` again on a machine
  with the logon task replaces it with the boot task (the `/F` path), keeps
  `node.yaml`, the data dir, the pairing and the phones, and turns on the
  app's start at login (§5.4) **(C-5)**. The window's Install… does the
  same.

### 5.2 Where the screen work happens

An S4U task runs outside the owner's desktop (no interactive desktop), so the
node can no longer take screenshots, inject input, show a Chrome window or
record the screen itself. The in-process channel (`InProcessChannel`,
`src/gui/in-process-channel.js`) is therefore not used by a boot-started
node.

- The **King Louie desktop app becomes the screen host** for its personal
  node **(owner)**. When it runs in the owner's session, it connects to the
  node and serves the screen ops the node asks for: the existing session
  helper protocol (kl-session-v1: screenshots, input, windows,
  `launch_browser`, `record_start`/`record_stop`, `keep_awake`, the session
  watch) or an equivalent carried over the desktop bridge the app already
  holds. Which transport is the builder's choice; reusing
  `src/session/` (Electron-free, so it can run in the app's main process) is
  expected.
- **Trust for that connection** is the personal node's: only a process of
  the owner's own account may be the screen host. The fleet's admin-owned
  helper file, per-user copy and `icacls` steps do not apply on a personal
  node. **As built (plan D-2, corrected):** kl-session-v1 runs over the named
  pipe `\\.\pipe\king-louie-personal-<16 hex>`, whose name and key the node
  writes to `<dataDir>/session/personal-helper.json`. The pipe's default
  security is **not** owner-only: Windows' default named-pipe DACL gives
  Everyone read. The boundary is the key in `personal-helper.json` (a file
  only the owner's account reads); a connection that does not prove the key
  is dropped. Residual: another local account can open the pipe, hold its
  unauthenticated slots and keep the tray app from connecting (a denial, not
  a takeover). No new listener on any non-loopback address.
- **No screen host connected** (before login, the app quit from the tray,
  the screen locked): GUI tools refuse with a clear, existing-style code
  (`capability_unavailable` naming that no screen host is connected), before
  any phone approval or lease, as a missing helper does on a fleet node
  today. `run_task`'s capabilities reflect it.
- **Takes.** A take's Chrome is launched by the screen host in the owner's
  session (the fleet path: `launch_browser` with `CHROME_FLAGS`, the
  `DevToolsActivePort` read, `PlaywrightBrowser#attach` from the node), on
  the profiles under the node's data dir so a login made from a chat still
  serves the next take. The recording's ffmpeg is the screen host's child.
  Everything that ends a take today still ends it; the host disconnecting
  ends it `helper_lost` as on a fleet node, and locking ends it
  `screen_locked`. Quitting the app from the tray during a live take asks
  first ("A take is recording. Quit and end it?") **(C-6)**.
- **Browser tools in chats, after login.** Where today the node opens a
  headed Chrome itself, it now asks the screen host to launch it, so the
  window appears on the owner's desktop with his logins. This reopens the
  fleet residual that Chrome's debugging port is reachable by the owner's
  own processes while it is open; on a personal node those processes are
  already inside the trust boundary, so this is a residual to document, not
  a blocker.
- A personal node **started by hand from a terminal** (development) is in
  the interactive session and keeps working: the builder may keep
  `InProcessChannel` for that case or route it through the app as well, but
  must not break `npm run start:standalone` or a hand-started node.

### 5.3 The browser before login

Chrome encrypts saved passwords and cookies with the Windows user's own key,
which an S4U process cannot unlock. A Chrome started from the node before
login cannot read the owner's logins, and could rewrite the profile's key
and lose them for good.

So **before a screen host is connected, the node never opens a saved
profile** (`<dataDir>/browser-profiles/*`) **(C-7)**. A browser tool call
that would open one refuses with a clear code and the words "Saved logins
are available after you log in"; an explicit `ephemeral: true` call still
works headless. Takes cannot start before login anyway (no screen host).

### 5.4 The tray

- The app gains a **tray mode**. At login it starts in the tray with no
  window, through a per-user start entry (`app.setLoginItemSettings` or the
  HKCU Run key) with an argument that says "start hidden" **(owner, C-8)**.
- The start entry is turned on by `install --personal`, by the window's
  setup when it installs or attaches a personal node, and is a visible
  setting ("Start King Louie when I log in") the owner can turn off.
- **Tray icon click**: opens (or focuses) the chat window. **Closing the
  window** hides it to the tray instead of quitting, on Windows, while
  attached to a personal node. A second launch focuses the existing window
  (the single-instance rule, unchanged).
- **Tray menu**: Open King Louie; the node's state (running, starting,
  stopped, not installed) as a line; Start / Restart King Louie Node (the
  existing `nodeStart`); whether a take is live; Quit. Quitting the app
  never stops the node; it only ends screen work until the app is back.
- The icon reflects the node at a glance: normal when connected, a
  distinct state when the node is down or starting **(C-9)**.
- In tray mode the renderer may be unloaded or not created until the window
  is first opened; the main process keeps the bridge connection and the
  screen host running either way. The builder decides.
- Standalone and development launches (`--kl-standalone`,
  `--kl-standalone-once`) and fleet attach are unchanged: no tray mode
  unless attached to a personal node **(C-10)**.

### 5.5 What the window and the CLI say

Places that say "the node starts when you log in" change: the install
consent text, `install --personal`'s summary, the setup view's steps, the
service pane, doctor's `hosting` row, the install guide's section 13 and
`docs/driving-king-louie.md` §2. The consent text names the S4U boot task,
that no password is stored, the one UAC prompt, that screen work needs the
owner logged in with King Louie in the tray, and that saved browser logins
are used only after login. doctor gains a line saying whether a screen host
is connected.

The stage 2 row "Reboot before login: the node is down until the owner logs
in" becomes: the node is up; screen tools and saved logins wait for login.

### 5.6 Development from a checkout

- `install --personal` run from a checkout (with `node.exe`, not the
  installed app's binary) no longer registers a task. It refuses and says to
  install the King Louie app and run the install from there (or from the
  window's Install…) **(C-13)**. An existing checkout logon task is replaced
  when the owner installs from the app (§5.1, existing installs); the data
  dir is the same, so nothing moves.
- Hand-run development copies keep working in the owner's session:
  `npm run start:standalone`, and a node started by hand in a terminal, which
  may use the screen directly (§5.2).
- **A development copy uses its own data** **(owner)**. A hand-started node
  pointed at the installed node's data dir while that node runs is refused
  (the pidfile already says it runs), and the docs give development copies
  their own `--data-dir` and profile. `start:standalone` keeps its own
  profile, as today; the known residual that it can poll the same Telegram
  or Discord bot as the node stays a residual **(C-14)**.
- To test the real path, build the installer from a worktree and install
  it.

## 6. Residuals to document

- S4U processes cannot reach network resources that need the owner's
  Windows credentials (shares, intranet sites with Windows sign-in).
  Internet access and the relay are unaffected.
- The owner's account is still the trust boundary; anything running as the
  owner can be the screen host or drive the node over `mcp`, as today.
- Chrome's debugging port while a helper-launched Chrome is open (§5.2).
- The cause of the window closing on sleep was not established; this design
  removes the window, so it does not depend on it. The builder verifies a
  sleep and wake on a real machine (node still running, app reconnects,
  phones confirm).
- An app update: the NSIS installer closes processes of the app's
  executable. A boot-started node running the app's binary may be in
  another session; the builder confirms the installer still stops it or
  that the node restarts on the new files (stage 2 §6.8 row "App updated
  while the node runs"). Unverified until manual check 14: the installer may
  need the node stopped, or a reboot, before the node runs the new version.
- A screen-host take with `keep_browser` is not recorded as holding its
  profile; the next start on that profile fails `browser_launch_failed` until
  that Chrome is closed.

- The screen host's pipe is not owner-only (§5.2): another local account can
  hold its unauthenticated slots and keep the tray app from connecting.
- Task Scheduler ending the task's wrapper may leave the node child running;
  `king-louie-service stop` finds it by the pidfile.
- The app's `recording()` may stay true if ffmpeg ends by itself mid-take
  (found at the stop, as on a fleet node).
- The real boot, UAC and S4U path is unverified until the owner's checklist
  (`docs/superpowers/plans/2026-11-09-boot-node-tray-manual-checks.md`).

## 7. Testing

As for the rest of the personal node: no test registers a real task, runs a
real `schtasks`, raises a real UAC prompt or touches the real
`%LOCALAPPDATA%`. The task XML is rendered and checked (boot and logon
triggers, S4U, no PowerShell, no console host). The screen host's connection
and refusals are tested with fakes, as `tests/gui-in-process-channel.test.js`
and the helper tests are today. The tray is covered in e2e where Playwright
can see it (start hidden, open from the tray's action, close hides, quit),
with the tray API stubbed where it cannot. A manual checklist on the owner's
machine covers reboot before login, login, lock, sleep and wake, a take, and
uninstall.

## 8. The author's calls

- **C-1** S4U logon type for the boot task (follows the owner's "no
  password").
- **C-2** Keep a logon trigger beside the boot trigger as a backstop.
- **C-3** No console host in the task's action, by whatever mechanism works;
  PowerShell is dropped from the action.
- **C-4** One more UAC prompt at uninstall is acceptable if Windows requires
  it to delete the boot task.
- **C-5** Re-running `install --personal` converts an existing logon-task
  install in place, keeping everything else.
- **C-6** Quitting the app from the tray during a live take asks first.
- **C-7** Before a screen host is connected, the node refuses to open saved
  browser profiles, so S4U Chrome can never damage the owner's logins.
- **C-8** The app starts at login hidden in the tray through a per-user start
  entry, on by default for a personal node, with a setting to turn it off.
- **C-9** The tray icon shows the node's state. Shipped as the tooltip and a
  state line in the menu on the one icon; a distinct bitmap per state is a
  follow-up.
- **C-10** Tray mode only when attached to a personal node; standalone,
  development and fleet launches are unchanged.
- **C-11** The owner must be an administrator; install refuses a standard
  user up front.
- **C-12** The task's security descriptor always lets the owner run and
  read it unelevated (never write), rather than a UAC prompt per Start or a fallback to the
  logon task.
- **C-13** `install --personal` from a checkout refuses and points to the
  installed app.
- **C-14** A hand-started node is refused on the installed node's data dir
  while that node runs; `start:standalone`'s shared-bot residual stays.
