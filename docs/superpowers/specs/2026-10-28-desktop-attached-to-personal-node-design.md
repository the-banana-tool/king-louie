# Desktop attached to the personal node

Date: 2026-10-28. Status: owner rulings R-DA-1 to R-DA-5 given 2026-10-28
(§17); the author's calls C-1 to C-14 (§16) wait for the owner's check.

Program: the first of four QoL specs of 2026-10-28 (this one, then the
Android app slimmed and styled, push notifications, the browser runner).
It stands alone and depends on none of them.

Related: the personal node (`2026-10-25-personal-node-design.md`, rulings
R-PN-*, calls C-1 to C-12 there, cited here as PN C-n), fleet stage 7's
desktop UI (`2026-09-23-fleet-stage7-desktop-ui.md`), the install guide
(`docs/install-guide.md` §13).

## 1. Intent

The owner runs two King Louies on one Windows machine: the standalone
desktop app, with its own profile and history store (about 79 MB), and a
personal node (`hosting: personal`, `profile: agent`, GUI and takes on, a
front-door pin beside `node.yaml`), which they start by hand with
`king-louie-service run` because no `KingLouie Node` logon task is
registered. The personal node design left the desktop standalone on purpose
(R-PN-3) and listed attaching as later work.

The owner now wants one King Louie: the node holds the data and does the
work, and the desktop app is its window, as attached mode already makes the
desktop a window onto a fleet service. Three things stand in the way today:

- the desktop's bridge-file trust rule (`checkBridgeFileTrust`,
  `src/desktop-bridge/pairing.js:322-367`) accepts only a file and directory
  owned by SYSTEM or Administrators, and a personal node's config dir is the
  owner's; `defaultServiceDataDir` (`src/platform/paths.js:40-48`) already
  finds the personal dir, so the desktop finds it and refuses it;
- `desktop pair` (`src/service/commands/desktop.js:177-324`) must run as an
  administrator (`:190-193`) and hands the file to Administrators with
  `icacls` (`:56-64`), which the personal node's owner rule then refuses;
- nothing starts the node: attached with the service down, the desktop
  retries forever (`src/desktop-bridge/bridge-client.js`, backoff 1 to 30 s)
  and the banner (`renderer.js:14480-14512`) offers Retry, Use standalone
  this time and Local service settings, never a start.

This design changes the trust rule for a personal node only, makes pairing
one click there, has the desktop start the node's logon task, and lets the
owner move the desktop's data into the node once.

## 2. Goals

- On a personal node, Settings > Local service pairs with one click, with no
  elevated prompt and no command to copy (R-DA-2).
- Launched attached with the node down, the desktop starts the node's logon
  task and connects, and says so while it waits (R-DA-3).
- A machine with no logon task gets an Install offer from the desktop
  (R-DA-3).
- The owner moves everything in the desktop profile into the node once,
  unelevated, then attaches (R-DA-4).
- The fleet layout's rules, wording and tests do not change (R-DA-1).

## 3. Non-goals

- macOS and Linux. Personal hosting is Windows only (PN C-6); the POSIX
  branch of the trust rule stays the fleet's.
- Changing attached-mode semantics, standalone-once, the bridge protocol,
  the allowlist of proxied domains, or anything on the service side of the
  bridge (R-DA-5).
- Running the node as a child of the desktop. Rejected by the owner: it
  would die with the desktop (R-DA-3).
- Stopping the node when the desktop closes. Closing the desktop never
  stops the node (R-DA-3).
- Moving data back from the node to the desktop.
- Automatic pairing at launch (R-DA-2).

## 4. Constraints

- `src/` stays Electron-free except `src/ipc/`
  (`tests/electron-boundary.test.js`). The new module that queries and runs
  the task and the CLI (`src/desktop-bridge/personal-node.js`) spawns
  processes and reads files only; the controller in `src/ipc/` wires it.
- Every Windows owner read stays the handle-based inspector in a PowerShell
  child, asynchronous on the desktop (`inspectWindowsOwnersAsync`, the
  final-review I2 rule: never a blocking call in the Electron main process).
  No `Microsoft.PowerShell.Security` cmdlet.
- `schtasks` and the CLI are spawned by absolute path
  (`windowsSchtasksExe`, the app's own binary and entry script), arguments
  as an array, never through a shell.
- No new `KL_TEST_*` escape hatch (the old `KL_TEST_BRIDGE_*` one is gone);
  tests inject.
- Text from the node (its log, the CLI's stderr) reaches the pane only
  through `shown` (`src/service/commands/io.js`), one plain line.
- Examples and docs use invented values (`laptop-01`, `example.com`,
  `%LOCALAPPDATA%`-style paths).

## 5. The trust rule (R-DA-1)

Terms: **the bridge file** is `desktop-bridge.json` in the node's config dir
(`bridgeFilePath`, `pairing.js:234-239`); **the desktop state** is the
desktop's own `desktop-bridge.json` in its profile (mode, pairing, sealed
device key). Only the bridge file's trust changes.

### 5.1 What is checked

`checkBridgeFileTrust(file)` on Windows reads owners once, with one
inspector call over four paths (C-1):

1. the bridge file's directory (the config dir, `D`);
2. the bridge file (`F`);
3. `D\node.yaml` (`Y`);
4. the data dir beside it (`D\..\data`, `A`: `adminConfigDir`'s Windows
   rule puts config beside data).

The inspector already prints the process's SID first (`me`,
`pairing.js:252`). Then:

- **Fleet rule, unchanged.** `D` and `F` present, neither a link, both owned
  by SYSTEM (`S-1-5-18`) or Administrators (`S-1-5-32-544`): trusted, hosting
  `service`. `Y` and `A` are not consulted (a fleet node may have neither).
- **Personal rule, new.** Otherwise: `D`, `F`, `Y` and `A` all present, none
  a link, all owned by `me` (and `me` a non-empty SID), and `Y` loads with
  `loadNodeConfig({ adminConfigDir: D })` (the strict loader the node itself
  uses, every key checked) with `hosting: 'personal'`. Then trusted, hosting
  `personal`.
- Anything else: `BRIDGE_FILE_UNTRUSTED`, or `BRIDGE_FILE_MISSING` when `D`
  or `F` is missing (as today). The message says which rule failed:
  `<F> is owned by you, but <Y> does not say hosting: personal; a bridge
  file you own is trusted only for a personal node.`, `<A> is owned by
  <SID>, not by you`, `<path> is a junction or link`, `the owners could not
  be read`. An inspector reply with the wrong number of entries is refused,
  as now.

This is `assertPersonalOwner`'s rule (`src/service/personal-host.js:44-80`:
data dir and config dir owned by the running account, no link) applied from
the desktop, plus the file itself and `node.yaml`. The node checks the same
fact at its start, so a bridge file the desktop trusts names a node that
started under the same rule.

`readTrustedBridgeFile` returns `{ ok, record, hosting }`; `hosting` is new
and the record's shape (`parseBridgeFile`) is unchanged.

POSIX keeps the fleet rule only (§3). `KL_TEST_MODE` with
`KL_DESKTOP_BRIDGE_FILE` keeps accepting the current user, as now; it does
not enter the personal rule (an override file has no `node.yaml` beside it
to speak of).

### 5.2 The local service read

Every place that reads the bridge file today (the pane's `status()` in the
unpaired view, the pairing poll, `pairConfirm`'s fresh read, the client's
`getPort` on each reconnect, `desktop-controller.js:66-75`) goes through
`readTrustedBridgeFile` and so gets the new rule with no other change.

The unpaired view also needs to know, before any bridge file exists, that a
personal node lives here. `detectPersonalNode()` (in `personal-node.js`)
reuses the same four-path inspector call and the same rule, without `F`:
`D`, `Y`, `A` owned by `me`, no link, `Y` says `personal`. It returns
`{ personal, name, dataDir, configDir }` (`name` from `node.yaml`, shown
through `shown`). In the unpaired view the controller makes one inspector
call that answers both questions (C-1).

## 6. One-click pairing (R-DA-2)

### 6.1 The CLI under personal hosting

`desktop pair <request>` keeps its fleet behaviour when `node.yaml` (read
with `loadNodeConfig` for the data dir) is not `hosting: personal`. When it
is:

- **Not elevated.** `isAdmin()` true refuses (`desktop pair on a personal
  node runs as you, not elevated: open a normal prompt`, exit 1), the rule
  `install --personal` has (PN C-5): an elevated process would leave
  Administrators-owned files that §5.1's personal rule then refuses (C-2).
- **The owner check.** `checkPersonalOwner({ dataDir, configDir })`
  (`personal-host.js`, synchronous inspector: this is the CLI) must hold;
  otherwise `PERSONAL_NOT_OWNER` with the check's own problem line, exit 1,
  nothing written. This is how the command knows it is the owner's account:
  the process's SID equals the owner SID of both dirs.
- **The consent** is unchanged: label and fingerprint, port,
  `PAIR_WARNING`, the node's fingerprint when an identity exists, then
  `Trust this device? [y/N]` on a TTY, or `--yes`.
- **What it writes**, all in the owner's config dir, created with the
  directory's inherited ACL (the owner's `%LOCALAPPDATA%` profile ACL), no
  `icacls` (`applyWindowsAcls` is not called, C-3):
  - `desktop-devices.json` with the device (`upsertDevice`), as now;
  - `desktop-bridge.json` (`bridgeFileRecord`: `v: 1`, `127.0.0.1`, port,
    protocol, public key, node id), as now;
  - `service.json` merged with `features.desktopBridge: true` and
    `ports.desktopBridge: 18796` when no port is set (`desktop.js:310-316`),
    as now. Under personal hosting `service.json` is the admin file of a
    config dir the owner owns; `loadServiceConfig` reads it on Windows with
    no owner check (`assertAdminOwned` returns at once there,
    `src/service/config.js:398-399`).
- **A machine-readable result.** A new flag `--json`, valid for `desktop
  pair` only (the `YES_COMMANDS` pattern in `src/service/cli.js:85`, with a
  "Flag "--json" is only valid for "desktop pair"" refusal), makes the
  command end with one JSON line on stdout: `{ "ok": true, "nodeId",
  "port", "bridgeTurnedOn", "hosting": "personal" | "service" }`, or `{
  "ok": false, "code", "message" }` on a refusal (C-4). The human lines
  still go first.
- The `Restart the service to open the desktop bridge.` line stays; the
  desktop acts on `bridgeTurnedOn` instead (§6.2).

`desktop unpair <device-id>` and `desktop list` follow the same two rules
(not elevated, owner check) under personal hosting.

The command does not refuse while the node runs (as now): the devices file
is read on each handshake (`bridge-server.js:429-438`), and `service.json`
is read at start. Creating a missing node identity still refuses while the
node runs (`createNodeIdentity`, `desktop.js:124-130`); a personal node that
has paired with a relay or a front door has one.

### 6.2 What the desktop runs

The pane's unpaired view, when `detectPersonalNode()` says personal, shows:

> King Louie Node "laptop-01" runs on this computer as you.
> Every paired desktop sees every chat, setting and secret name in the node.
> [Pair]

(the second line is `PAIR_WARNING`). One press of **Pair** runs, in order,
in `pairStart` (the existing pending-pair state holds the key; C-5):

1. make the device key and pending pair, as now (`desktop-controller.js:227-249`);
2. run `king-louie-service desktop pair <request> --yes --json --data-dir
   <A>` (§6.3 says with what binary), stdin closed, 120 s timeout. A non-zero
   exit or `ok: false` ends here with that code and message, the pending pair
   kept so the pane shows it with **Try again** and **Cancel**;
3. read the bridge file through the trust rule; it must be trusted with
   hosting `personal` and its `nodeId` must equal the CLI's `nodeId`, else
   `PAIR_SERVICE_CHANGED` (the swap check `pairConfirm` makes against the
   poll today, here against the command's own output);
4. bring the bridge up (§7): if no node runs, run the task; if the node runs
   and `bridgeTurnedOn` is true, the node needs a restart to open the
   listener, and the pane asks once (C-6):
   > King Louie Node is running (pid 4242). Pairing restarts it: a turn or a
   > take in progress stops. [Restart and pair] [Cancel]
   If the node runs and the bridge was already on, nothing is restarted;
5. wait for the bridge as in §7.3, then call `pairConfirm({ nodeId })` with
   the record from step 3. Its own checks (fresh read, pin, handshake
   `probe.connect()`) run unchanged, and its handshake is what proves the
   listener holds the node's private key.

The pairing record gains `service.hosting` (`'personal'` or absent) and
`service.dataDir` (C-7). The pane then shows the paired view
(`Import…`, `Attach`, `Unpair`) with `Running as you (<account>), in your
session.` in place of `Tools will run as the service account, not as you.`

**Unpair** under personal hosting runs `desktop unpair <device-id> --data-dir
<A>` itself after forgetting the pairing (C-8); only when that fails does
the pane keep the follow-up command, as today (`pendingServiceCommand`).

A fleet node keeps today's flow: the copied elevated command, the 3 s poll,
**Confirm**.

### 6.3 Which binary runs the CLI

The desktop runs the CLI with its own binary as Node: `process.execPath`
with `ELECTRON_RUN_AS_NODE=1` and its own `bin/king-louie-service.js`
(inside `app.asar` in a packaged build), the way the PDF worker and the
embed worker already run (`src/cases/ingest/pdf-sandbox.js`; Electron's
RunAsNode fuse is left on for them). So the desktop pairs, installs and
stops with code of its own version, needs no `node.exe` on `PATH`, and
works the same from a checkout (`npm start`) and from a packaged build
(C-9). Every other environment variable is passed as it is.

### 6.4 Refusals the pane shows

| Code | When | Pane line |
|---|---|---|
| `PAIR_ELEVATED` | the CLI refused an elevated run (the desktop itself runs elevated) | `This app is running as administrator. Close it and open it normally to pair.` |
| `PERSONAL_NOT_OWNER` | the CLI's owner check failed | the check's problem line |
| `PAIR_COMMAND_FAILED` | non-zero exit with no JSON line, or a timeout | `Pairing did not finish: <first stderr line>` |
| `PAIR_SERVICE_CHANGED` | §6.2 step 3, or `pairConfirm`'s own check | as now |
| `BRIDGE_FILE_UNTRUSTED` | §5.1's personal rule failed after the command | the rule's message |
| `NODE_TASK_MISSING`, `NODE_TASK_DISABLED`, `NODE_TASK_OTHER_ACCOUNT`, `NODE_START_TIMEOUT`, `NODE_START_FAILED` | §7 | §7.4 |
| `SECURE_STORAGE_UNAVAILABLE` | as now | as now |

## 7. Starting the node (R-DA-3)

### 7.1 What the desktop knows about the node

`personal-node.js` answers four questions, each with an injected runner:

- **Is the task registered, and whose is it?** `schtasks.exe /Query /TN
  "KingLouie Node" /XML ONE`. Exit 0: registered; the XML's
  `<Principal><UserId>` must be `me`'s SID (`NODE_TASK_OTHER_ACCOUNT`
  otherwise: never run another account's task), and `<Settings><Enabled>
  false</Enabled>` means disabled. A non-zero exit means not registered
  (`NODE_TASK_MISSING`). The XML is read, never the `/FO LIST` or `/V` text,
  whose labels and states are localised (C-10).
- **Is a node running on this data dir?** The pidfile (`<A>\service.pid`,
  `src/service/pidfile.js`) names a live pid whose command line is
  `king-louie-service … run` (`isServiceCommandLine`,
  `src/service/commands/stop.js:58`), the same test `stop` makes. A node
  started by hand counts.
- **Start it**: `schtasks.exe /Run /TN "KingLouie Node"`. The task has
  `MultipleInstancesPolicy IgnoreNew` (`personal-install.js`), so a run while
  the task runs is a no-op; the desktop still never runs it while the pidfile
  says a node is up, since a second process would fail the instance lock and
  the task's `RestartOnFailure` would try three more times (C-11).
- **Did it fail to start?** The node writes `service failed to start: <why>`
  to `<A>\logs\service.log` (`run.js` around `:467`; nothing reads a hidden
  task's stderr). The desktop reads the log's tail after the `/Run` and
  takes the newest such line written after it.

Restart (only on a press, never automatic): `king-louie-service stop
--data-dir <A>` (the CLI as §6.3; under personal hosting it also ends the
task, PN "Stopping it"), then `/Run`. Never `schtasks /End` alone (it kills
the PowerShell wrapper and leaves `node.exe`), never `/Change /ENABLE`,
never `/Create` outside `install --personal`.

### 7.2 At launch, attached

Mode stays fixed at launch (`main.js:33-37`). In attached mode,
`startAttachedHost`'s `start()` (`src/ipc/attached-host.js:153-155`) calls a
new `controller.startAttached()` in place of the bare `client.connect()`:

1. If the pairing record says `hosting: 'personal'` and
   `detectPersonalNode()` agrees for the recorded data dir (C-7: the record
   only says whether to try; the disk decides), and no node runs (pidfile),
   then query the task and, when registered, enabled and the owner's, run it
   once. This happens once per launch.
2. Connect as now. While the start wait runs (§7.3) the connection status is
   `starting` and the view is `attached-starting`.
3. A fleet pairing, or a personal one where step 1 does not apply, connects
   exactly as today.

### 7.3 How long it waits

From the `/Run` (or from launch, when the node was already running) the
desktop waits up to **60 s** for the handshake (C-12), calling the client's
`retryNow()` every 3 s (each reconnect re-reads the bridge file through the
trust rule, about 1.5 s of PowerShell, so not faster). It stops early when:

- the handshake succeeds: connected, as now;
- the log gains a `service failed to start` line after the `/Run`:
  `NODE_START_FAILED` with that line;
- a fatal bridge code arrives (`DEVICE_UNPAIRED`, `PROTOCOL_MISMATCH`,
  `ANOTHER_DEVICE`, `SERVICE_KEY_CHANGED`): shown as now.

At 60 s with nothing: `NODE_START_TIMEOUT`, and the view becomes
`attached-disconnected` with the banner. The client's own backoff
(`bridge-client.js:14`) carries on underneath, so a node that comes up at
70 s still connects. The 60 s is a ref'd timer only while a start is
pending; it is cleared on connect and on `shutdown()`.

The 60 s covers what runs before the bridge listener opens (`run.js:279`:
the instance lock, the core and its history store, approvals, the GUI
subsystem's build); the builder measures it on a node with the owner-sized
history store and changes the number only with that measure (§15).

### 7.4 The banner and its wording

While `attached-starting`, the chat area shows a banner with no buttons:

> Starting King Louie Node…

After it, `attached-disconnected` for a personal pairing keeps today's three
buttons and adds one, chosen from what §7.1 found:

| Found | Line | Added button |
|---|---|---|
| task registered, no node running | `King Louie Node is not running.` | **Start King Louie Node** (`/Run`, then §7.3) |
| node running, bridge not answering | `King Louie Node is running (pid N) but its desktop bridge is not open.` | **Restart King Louie Node** (§7.1 restart, then §7.3) |
| `NODE_START_FAILED` | `King Louie Node stopped while starting: <log line>` | **Start King Louie Node** |
| `NODE_START_TIMEOUT` | `King Louie Node did not answer within 60 seconds.` | **Retry now** already there |
| `NODE_TASK_MISSING` | `King Louie Node has no logon task on this computer, so this app cannot start it.` | **Install…** (opens Settings > Local service, §8) |
| `NODE_TASK_DISABLED` | `The logon task "KingLouie Node" is disabled in Task Scheduler. Enable it there to let this app start the node.` | none |
| `NODE_TASK_OTHER_ACCOUNT` | `The logon task "KingLouie Node" belongs to another account; this app does not run it.` | none |

A drop after the desktop has connected never runs the task by itself (C-13):
the owner may have stopped the node on purpose, and the button is one press
away. The pane's `attached-disconnected` actions (`pane-model.js:72-79`)
gain the same button. A fleet pairing's banner and pane are unchanged.

## 8. Installing from the desktop (R-DA-3)

With a personal node detected and `NODE_TASK_MISSING`, the pane (unpaired,
paired or attached) shows **Install…**. It runs:

1. `king-louie-service install --personal --dry-run --data-dir <A>` (the CLI
   as §6.3), and shows its output in the pane (`<pre>`, each line through
   `shown`): the account, the dirs, the task, the trust line, the reboot
   line, what it will write, what `node.yaml` lacks, the steps;
2. on **Install** (the press is the consent the CLI's `[y/N]` asks for),
   `install --personal --yes --data-dir <A>`, and shows its result lines.

The install's existing refusals reach the pane as they are (an elevated
desktop, a fleet node installed, no Chrome found). Two changes in
`personal-install.js`:

- **Run under the desktop's binary.** When `install --personal` runs under
  Electron as Node (`process.versions.electron` set), the task's action sets
  `$env:ELECTRON_RUN_AS_NODE='1'` before `& '<binary>' '<entry>' run
  --data-dir '<A>'` (`renderPersonalTaskXml` takes `runAsNode: true`), and
  the consent text names the binary and says the node then runs the desktop
  app's version and stops starting if the app is removed (C-9). Run from a
  terminal with `node.exe`, nothing changes.
- **No second start.** The `/Run` step is left out, with `King Louie Node is
  already running (pid N); the task starts it at your next logon.`, when the
  pidfile names a live node (a node started by hand, as the owner's is
  today; C-11).

## 9. Moving the desktop's data into the node (R-DA-4)

### 9.1 `import --from` unelevated under personal hosting

`runImportCommand` (`src/service/commands/import.js:255-470`) reads
`node.yaml` today only when `--case` is given (`:281-291`). It reads it for
every import (C-14):

- `hosting: personal`: the administrator requirement goes for the whole
  profile as for one case, and an **elevated** run is refused, with or
  without `--case` (`import on a personal node runs as you, not elevated:
  open a normal prompt`, exit 1; C-2). An elevated writer would leave
  Administrators-owned files in the data dir, and the node's start
  (`assertPersonalOwner`) checks the dirs' owners only, so they would sit
  there unnoticed.
- Otherwise: unchanged (root or Administrator).

Everything else stays: the node must be stopped (`stopFirstText`), the data
dir must exist and hold a master key, the safe reader walks the desktop
profile, the writer child writes through the Windows write guard
(`guard: !identity`, identity being `null` on Windows), the plan is printed,
no secret moves (`secrets: 'needs-desktop'`), the per-install manifest
records what was written. A whole import asks no question, as today;
`--dry-run` prints the plan and writes nothing; `--yes` stays valid only
with `--case`.

### 9.2 The owner's sequence, once

Both programs at this version first. Then:

1. Quit the desktop app (its core would keep writing chats and cases while
   they are read), and stop the node: `king-louie-service stop`.
2. `king-louie-service import --from "$env:APPDATA\king-louie" --dry-run`,
   read the plan, then the same without `--dry-run`. Settings, the user
   profile, permission rules and always-approve entries (desktop-origin),
   allowed directories, chats, memory, cron jobs (imported disabled) and
   cases are copied; secrets are listed `needs-desktop`.
3. `king-louie-service install --personal` (or the desktop's **Install…**
   in step 4): registers the logon task and, `front-door.json` being there,
   starts it.
4. Open the desktop app (still standalone). Settings > Local service:
   **Pair** (§6.2). The node runs with the bridge off, so the pane asks
   **Restart and pair** once.
5. **Import…** in the paired view: the desktop's own import over the bridge
   (`importPlan`/`importApply`, `desktop-controller.js:392-426`) reads its
   secrets with `safeStorage` and sends them (provider keys, search and image
   keys, the vault, Anthropic OAuth). The importer's manifest for the
   desktop's install id marks what step 2 wrote, so those items plan as
   `skip-present`, or `update` for a chat the desktop changed since.
6. **Attach**. The desktop relaunches attached (`attach()` →
   `relaunch()`); from then on, at each launch, §7 starts the node when it is
   down.

A case already moved with `import --case` (the R-PN-3 case) plans as
`skip-present` when the manifest has it, else `needs-attention` (`a case
with this directory already exists on the service`): never overwritten. Its
chats follow the manifest: unchanged on the desktop, `skip-present`; changed
on both sides, imported as a copy. The dry run shows which.

The desktop profile is not emptied: its chats, cases and history store stay
where they are, read by nothing while attached, and used again only by
**Use standalone this time** (§10) or **Detach**.

## 10. What stays as it is (R-DA-5)

- **Attached semantics.** The desktop builds no core; the allowlisted
  channels are proxied (`src/desktop-bridge/allowlist.js`); chats made while
  attached live in the node; the desktop's file pick for a history import
  stays local (`LOCAL_CHANNELS`); one live desktop per node
  (`ANOTHER_DEVICE`).
- **Standalone-once.** `--kl-standalone-once` still builds the desktop's own
  core with channels, gateway, mesh and webhooks off and cron paused, so
  case wake-ups do not run twice against cases now copied into the node. The
  node keeps running beside it.
- **Detach** keeps its two-step confirm and warning; the node keeps running.
- **The fleet layout**: the Administrators/SYSTEM trust rule, the elevated
  `desktop pair` with `icacls`, the copied command and the 3 s poll, the
  elevated `import --from`, the POSIX rules.
- **The service side of the bridge**: `DesktopBridgeServer`, the dispatcher,
  the handshake, the lockout, the devices file read, the permission rules'
  `origin: 'desktop'` order.
- **What the node's tools may touch**: the desktop profile stays a denied
  directory for the file tools on a personal node (`desktopProfileDirs`,
  `registerDeniedDir`), so the node's model cannot read the desktop's sealed
  device key or rewrite its desktop state.

## 11. IPC and channels

All new channels are `desktop:*`, local in attached mode by
`LOCAL_PREFIXES` (`allowlist.js:4`), registered through `DESKTOP_METHODS`
(`src/ipc/desktop-handlers.js`) and `src/ipc/constants.js`, and exposed in
`preload.js` under `window.electron.desktop`:

| Channel | Method | Does |
|---|---|---|
| `desktop:nodeStart` | `nodeStart({ restart })` | §7.1 start, or restart with `restart: true`; then §7.3 |
| `desktop:nodeInstallPreview` | `nodeInstallPreview()` | §8 step 1; returns the lines |
| `desktop:nodeInstall` | `nodeInstall({ confirmed: true })` | §8 step 2; refuses without `confirmed` |
| `desktop:pairRestartConfirm` | `pairRestartConfirm({ confirmed: true })` | §6.2 step 4's **Restart and pair** |

Changed, same channel names:

- `desktop:status` adds `node: { hosting, name, dataDir, task: 'registered'
  | 'disabled' | 'missing' | 'other-account' | 'unknown', running, pid,
  starting, startError: { code, message } | null }` (null for a fleet
  pairing), the view `attached-starting`, and in `pendingPair` a
  `personal: true`, `stage` (`command`, `starting`, `restart-needed`,
  `confirming`) and `error`.
- `desktop:pairStart` runs §6.2 when the local read says personal, today's
  flow otherwise. `desktop:pairConfirm` is unchanged and is also called by
  the controller itself at the end of §6.2.
- `desktop:unpair` runs `desktop unpair` itself under personal (§6.2).
- `desktop:statusChanged` fires on each stage change.

`describeServicePane` (`src/desktop-bridge/pane-model.js`) gets the personal
views' words and actions; `renderAttachedBanner` (`renderer.js:14480`)
renders the starting banner and the added button from the status, holding
no copy of the rules. Every string from the node reaches the DOM with
`textContent`.

No proxied domain is added, nothing in `bridge-dispatcher.js` changes, and
the service sees no new method.

## 12. Security framing and residuals

Under personal hosting the owner's Windows account is the trust boundary, as
everywhere else on a personal node (PN §6). The new trust rule says no more
than that: a bridge file the owner's account wrote, beside a `node.yaml`
the owner's account wrote that says `hosting: personal`, in dirs the owner's
account owns, names the owner's node.

What that admits, said plainly:

- **A process running as the owner can point the desktop at a listener of
  its own at pairing time** by writing the bridge file. It could equally
  read the desktop's profile and unseal its device key (DPAPI under the same
  account), so the rule gives it nothing new. After pairing, the record is
  pinned: a rewritten bridge file can change only the port the client dials,
  and a listener without the node's private key fails the handshake
  (`SERVICE_KEY_CHANGED`, fatal).
- **Another, non-administrator account** cannot write under the owner's
  `%LOCALAPPDATA%` with its default ACL. The rule reads owners only, not
  access lists, as the node's own start check does: a data dir on a volume
  whose ACL lets others write passes it (the existing personal-node
  residual, unchanged).
- **The desktop runs programs**: `schtasks.exe` from System32 by absolute
  path, only for a task whose principal is the owner's SID; the CLI with its
  own binary and its own entry script, never a path read from the task, the
  bridge file or `node.yaml`. It never enables, creates or deletes a task
  except by running `install --personal` on the owner's press.
- **An administrator's** files keep the fleet rule: a fleet node is never
  read through the personal rule, and a personal config dir with an
  Administrators-owned bridge file in it (an elevated `desktop pair` from
  before this change) fails both rules: run Pair again from the desktop.

Residuals:

- Attached, the node is down from a reboot until the owner logs in (the
  logon task's limit, PN residual); the desktop then starts it at launch.
- A node started by hand in a terminal stops when that terminal closes; the
  desktop sees a drop and offers **Start King Louie Node**, which starts the
  task, not the terminal.
- `NODE_START_TIMEOUT` does not say why: a node that hangs before writing
  any log line looks like a slow one. The log file is named in the line.
- The node installed from the desktop runs the desktop app's binary and
  version (C-9): uninstalling or moving the app leaves a task that cannot
  start; updating the app updates the node at its next start.
- The desktop's own copy of the data stays on disk after the move, two
  copies of the history store side by side; nothing removes it.
- A chat the owner changed in the desktop after step 2 of §9.2 and also on
  the node comes over in step 5 as a copy.
- `desktop pair` under personal still prints `Restart the service…` for a
  terminal user; only the desktop restarts on its own.

## 13. Documentation to amend

`CLAUDE.md`:

- **Attached mode, Pairing bullet**: after "run the command it shows as
  root/Administrator", add: "On a personal node (`hosting: personal`) the
  pane's **Pair** runs `desktop pair <request> --yes --json` itself, as the
  owner, unelevated; the CLI refuses elevation there and checks the owner of
  the data and config dirs (`checkPersonalOwner`), writes no ACL, and the
  desktop then starts or restarts the node and confirms itself (spec
  `2026-10-28-desktop-attached-to-personal-node-design.md`)."
- **Attached mode, new bullet "Personal node"**: the trust rule (§5.1, one
  inspector call over the config dir, the bridge file, `node.yaml` and the
  data dir; all owned by the desktop's account, no link, `node.yaml` says
  `personal`), the start at launch (§7: once per launch, `schtasks /Run` of
  `KingLouie Node` when it is the owner's and enabled and no node runs, 60 s
  wait, `attached-starting`, the banner's added button, never run after a
  drop), Install from the pane (§8), the codes `NODE_TASK_MISSING`,
  `NODE_TASK_DISABLED`, `NODE_TASK_OTHER_ACCOUNT`, `NODE_START_TIMEOUT`,
  `NODE_START_FAILED`, `PAIR_ELEVATED`, `PAIR_COMMAND_FAILED`, and that
  closing the desktop never stops the node. Tests inject the runner
  (`deps.nodeRunner`) and the inspector.
- **Attached mode, `import --from` bullet**: add "Under `hosting: personal`
  it runs as the owner, unelevated, for the whole profile as for `--case`,
  and refuses an elevated prompt."
- **Personal node, Residuals**: delete "`desktop pair` and attaching the
  desktop app are unsupported (the bridge-file trust rule refuses a
  user-owned file; the CLI's data-dir fallback makes the helper and the
  attach find the personal dir and fail, never trust it)"; add "attached,
  the desktop app runs the node's task, never the node itself; a node
  installed from the desktop runs the app's binary and version".
- **Personal node, The CLI forms**: `import --from <desktop>` (whole profile)
  unelevated under personal; `desktop pair|unpair|list` unelevated under
  personal; `--json` for `desktop pair`; `install --personal` under Electron
  as Node and its skipped `/Run`.
- **Personal node, Moving a case**: "without elevation under personal (as
  root on POSIX it refuses)" becomes "unelevated, and refused elevated".

`docs/install-guide.md`:

- §4 (the import paragraph ending "Import from the desktop app attached to
  that service instead"): unchanged for the fleet; a pointer to §13 for a
  personal node.
- §13 "What a personal node does **not** have": delete the **No desktop
  pairing** bullet.
- §13, new subsection "Attaching the desktop app", after "Check it": Pair
  from Settings > Local service, the restart question, Attach, what the
  banner's buttons do, Install from the pane, closing the app leaves the
  node running.
- §13, new subsection "Moving everything from the desktop app" beside
  "Moving a case": §9.2's six steps, the dry run first, what `needs-desktop`
  means and that step 5 carries the secrets.
- §13 "Known limits": replace "The desktop app cannot attach to a personal
  node, and `desktop pair` is not supported there." with the §12 residuals
  that concern the owner (the reboot, a hand-started node, a node installed
  from the app runs the app's version).

## 14. Test plan

No test runs a real `schtasks`, a real `install --personal`, a real elevated
prompt or a real Electron launch for the start; Windows owners come from an
injected inspector.

- `tests/desktop-pairing.test.js` (extend): `checkBridgeFileTrust` with an
  injected `inspectOwners` over temp dirs holding a real `node.yaml`:
  personal trusted (all four owned by `me`, `hosting: personal`); `node.yaml`
  missing, `hosting: service`, or invalid (an unknown key) → untrusted;
  data dir owned by another SID → untrusted; a link at any of the four →
  untrusted; empty `me` → untrusted; Administrators-owned dir and file still
  trusted with no `node.yaml` (the fleet rule); a short inspector reply →
  untrusted; one inspector call with four paths; `readTrustedBridgeFile`
  returns `hosting`; POSIX unchanged.
- `tests/desktop-personal-node.test.js` (new): `detectPersonalNode`; the
  task query over XML fixtures (enabled, `<Enabled>false</Enabled>`, another
  SID, exit 1); the pidfile and command-line test with injected `readPidfile`,
  `isRunning`, `commandLineOf`; `/Run` and the restart's order (`stop` CLI
  then `/Run`, never `/End`); the CLI spawn (`execPath`, the entry,
  `ELECTRON_RUN_AS_NODE=1`, stdin ignored, timeout); the log tail (only a
  `service failed to start` line newer than the run, through `shown`).
  Injected: `execFile`, `spawn`, `readFile`, `now`.
- `tests/desktop-controller.test.js` (extend), with a fake `nodeRunner` and
  the existing fake client factory: one-click pair end to end (CLI JSON →
  trusted read → `/Run` → handshake → paired, `service.hosting` stored);
  CLI refusal kept on the pending pair; `nodeId` mismatch →
  `PAIR_SERVICE_CHANGED`; node running with `bridgeTurnedOn` → `restart-needed`
  and nothing restarted before `pairRestartConfirm`; bridge already on → no
  restart. Attached start: no node → one `/Run`; a node running → none;
  `NODE_TASK_MISSING`/`DISABLED`/`OTHER_ACCOUNT` → no `/Run`, the status
  code; 60 s → `NODE_START_TIMEOUT` (a fake clock, a ref'd timer kept alive
  across the await as CLAUDE.md asks); a log failure line → early
  `NODE_START_FAILED`; a drop after connect → no `/Run`; `nodeStart` and
  `nodeStart({ restart: true })`; Unpair runs `desktop unpair`; a fleet
  pairing never touches the runner.
- `tests/desktop-pane.test.js` (extend): every new view, line and action of
  §6.2, §7.4 and §8, and that a fleet status renders as before.
- `tests/attached-host.test.js` (extend): `start()` calls
  `controller.startAttached()`; a fleet pairing still connects at once.
- `tests/desktop-cli.test.js` (extend): `desktop pair` under a temp personal
  `node.yaml`: `deps.isAdmin` true → refusal, nothing written;
  `deps.personalOwner` with another owner → `PERSONAL_NOT_OWNER`, nothing
  written; success writes the three files, never calls `applyWindowsAcls`,
  ends with the JSON line (`bridgeTurnedOn` true then false on a second
  run); `--json` refused for another command; `unpair` and `list` under
  personal; the fleet path's tests unchanged.
- `tests/service-cli-import-personal.test.js` (new, beside
  `service-cli-import-case.test.js` and with its deps: `isAdmin`,
  `loadNodeConfig`, `runningServicePid`, `openWriter`, `resolveMasterKey`):
  a whole import under personal runs unelevated; elevated under personal is
  refused with and without `--case`; a fleet `node.yaml` still needs an
  administrator; the plan of a second import from the same install marks
  the first one's items `skip-present`.
- `tests/service-cli-install-personal.test.js` (extend): the task XML with
  `runAsNode: true` sets `ELECTRON_RUN_AS_NODE` before the call and names the
  binary in the consent; no `/Run` step when `runningServicePid` names a
  live node.
- `tests/desktop-bridge-allowlist.test.js` and `tests/preload-bridge.test.js`
  (extend): the four new channels are local and exposed.
- `tests/electron-boundary.test.js` covers `personal-node.js` as it is.
- E2E: none for the task start (it would need a real task or a new escape
  hatch). `tests/e2e/attached-mode.test.js` keeps covering attach, detach
  and standalone-once against the fleet rule under `KL_TEST_MODE`, unchanged.

## 15. What is left to the builder

- Measure the time from `/Run` to the bridge's handshake on a personal node
  with a history store of the owner's size, and keep 60 s or change it with
  that number (§7.3).
- Confirm that the app's binary runs `bin/king-louie-service.js` from
  `app.asar` with `ELECTRON_RUN_AS_NODE=1` for `run` as well as for the
  short commands (native modules, `node:sqlite`, the embed worker spawned
  from a process that is itself Electron as Node), the way
  `scripts/check-embed-worker.js` checks the worker; if `run` cannot, the
  Install offer refuses under Electron and prints the terminal command, and
  pairing still runs under Electron (§6.3).
- Whether `/Query /XML ONE` is what Windows 11 Home's `schtasks` accepts for
  one task's XML (else `/XML` alone), against a real task once, by hand.
- Where `startAttached` hands control to the client's existing reconnect
  loop without a second loop beside it.
- Whether `getPort`'s trust read on each reconnect should skip the
  four-path read while a start wait runs (about 1.5 s each, every 3 s).

## 16. The author's calls (for the owner to check)

- **C-1**: one inspector call over four paths (config dir, bridge file,
  `node.yaml`, data dir) answers both the fleet and the personal rule and
  the unpaired view's "is there a personal node here"; the personal rule
  also requires the data dir's owner, as `assertPersonalOwner` does.
- **C-2**: under personal hosting `desktop pair`, `desktop unpair|list` and
  every `import --from` refuse an elevated prompt (R-DA-4 left this open
  for import; the author follows `install --personal`).
- **C-3**: under personal hosting `desktop pair` sets no ACL and no owner;
  the files inherit the owner's profile ACL.
- **C-4**: `desktop pair --json` gives the desktop a result line to act on,
  instead of parsing human text.
- **C-5**: one-click pairing reuses the pending-pair state and ends in the
  existing `pairConfirm`, so its fresh read, pin and handshake checks stay
  the one path.
- **C-6**: pairing never restarts a running node silently: when the bridge
  was off, the pane asks once ("Restart and pair"), naming what stops.
- **C-7**: the pairing record stores `hosting` and the data dir, but each
  launch re-reads the disk before running anything.
- **C-8**: Unpair under personal runs `desktop unpair` itself; the follow-up
  command shows only when that fails.
- **C-9**: the desktop runs the CLI with its own binary as Node and its own
  entry script, and an install from the desktop makes the task run the
  desktop's binary, so node and desktop share one version.
- **C-10**: the task is read as XML (principal SID, `Enabled`), never from
  localised `schtasks` text; running is the pidfile, failure is the node's
  log.
- **C-11**: neither the desktop nor `install --personal` runs the task while
  a node runs on that data dir, a hand-started one included.
- **C-12**: 60 s wait, a retry every 3 s, a buttonless "Starting King Louie
  Node…" banner meanwhile.
- **C-13**: the task runs by itself once per launch only; after a drop it
  takes a press.
- **C-14**: `import` reads `node.yaml` for every import, not only `--case`,
  so the whole-profile import is unelevated under personal hosting; a whole
  import still asks nothing (the fleet's behaviour), and `--yes` stays
  `--case`-only.

## 17. Owner rulings (2026-10-28)

- **R-DA-1.** Attach works with the personal node. Under personal hosting
  the bridge file and its directory may be owned by the account running the
  desktop, provided `node.yaml` in that config dir says `hosting: personal`
  and the config dir has that same owner (`assertPersonalOwner`'s rule). The
  owner account is the trust boundary. The fleet rule is unchanged.
- **R-DA-2.** Pairing is one click: under personal hosting the pane's Pair
  runs `desktop pair` itself, as the same account, unelevated. Never
  automatic at launch. The fleet keeps the copied elevated command.
- **R-DA-3.** Attached with the bridge down at launch, the desktop runs the
  `KingLouie Node` logon task (`schtasks /Run`) and reconnects. The
  disconnected banner keeps a Start button for later drops. With no task
  registered, the pane offers to run `install --personal` (unelevated).
  Spawning the service as a desktop child is rejected; closing the desktop
  never stops the node.
- **R-DA-4.** The one-time move: `import --from` of the whole desktop
  profile runs unelevated under personal hosting (same account, node
  stopped); then the owner attaches. (Elevation: the author's call C-2.)
- **R-DA-5.** Attached-mode semantics (the desktop is a window onto the
  node's data) and standalone-once stay as they are.

What a later design may take up: macOS and Linux, a node started at boot
rather than logon, moving data back to the desktop, removing the desktop's
own copy after a move.
