# The window always attaches, and the desktop migrates (attach stage 2)

Date: 2026-11-03. Status: owner decisions from the grilling session of
2026-11-03 (ADR 0003: Q7, Q8, Q14, Q16, Q22, Q23) bind this design; every
other choice is the author's call (§15), made without asking, as the owner
asked, and recorded so it can be overruled.

Program: stage 2 of the task and node model (ADR 0003, ADR 0004; stage 1 is
`2026-11-03-tasks-stage1-design.md`). Stage 3 is remote attach and the node
switcher; stage 4 is personal nodes on macOS and Linux, headless browser on
fleet nodes, `RunTask` in bridges, retiring the peer mesh.

Related and binding: `2026-10-28-desktop-attached-to-personal-node-design.md`
(rulings R-DA-1 to R-DA-5, calls C-1 to C-14, cited here as DA C-n), the
personal node (`2026-10-25-personal-node-design.md`, PN C-n), fleet stage 7
(`2026-09-23-fleet-stage7-desktop-ui.md`), `CONTEXT.md`.

## 1. Intent

ADR 0003: the desktop window is a client of a node and nothing more. On
first run it installs and starts a local personal node, moves any standalone
profile it finds into it, once, with a backup, and attaches. The standalone
core stays only as a development mode.

Nearly all of the machinery exists. The desktop already pairs with a personal
node in one click, starts its logon task, offers to install it, imports its
own profile over the bridge with its secrets, and proxies the chat. What is
missing is the shape around it: the app still boots a core of its own by
default, the wizard asks a standalone core for a provider key, the install
offer needs a node to already be there, the move is six hand steps across
two programs, nothing verifies it, nothing keeps the old profile from being
read again, and a window with no node falls back to standalone. This design
is that shape: a launch rule, a setup flow, a safe move, and the gaps a
standalone owner would meet in attached mode, each named and placed.

## 2. Goals

- On Windows the app never builds a core of its own unless a development
  flag says so. With no node it shows the way to get one and nothing else.
- A fresh install is one flow in the window: install the node, pair, start,
  enter a provider key, name yourself; the phone and the front door are
  offered and skippable.
- An existing standalone profile is moved into the node from the same flow:
  what will move is shown, one press confirms, a verified backup is made
  first, the result is verified, and the old profile is never read again.
  Nothing is deleted. A move that fails halfway can be run again and skips
  what landed.
- An existing standalone user who updates gets the same flow at the next
  launch.
- What attached mode does not serve today is either served under personal
  hosting or named here as a non-goal with the owner's workaround.
- The e2e suite and `npm start` from a checkout keep working.

## 3. Non-goals

- macOS and Linux personal nodes (stage 4). There the app stays standalone,
  behind the one launch predicate (§6.1).
- Remote attach, the node switcher, the window attaching through the front
  door (stage 3). The setup flow's phone step shows the terminal command and
  skips; it runs no `pair wss://`.
- `RunTask` from the window, on-screen approval of a task's calls, the
  window as a task client (§6.7: stage 3, with reasons).
- Local servers added from the window on a personal node (§6.6, G-5): the
  admin `service.json` block stays the one source; the pane shows the file
  and a block to paste.
- Anthropic OAuth while attached (`settings:anthropicOAuth*` stays denied):
  the flow would have to land its token in the node's vault from a browser
  the desktop opened. A key pasted into the provider step works today.
- Moving data back from the node to the desktop; deleting the old profile
  or its backup; moving browser profiles (logins are made again in the
  node's own `king-louie` browser profile, or `vault set` as the install
  guide says); carrying `models.localServers` or `__typesafe_api_key`.
- Removing the standalone core and `src/ipc/standalone-host.js`. They stay
  as the development mode and the platform mode until stage 4 ends both.
- A node started at boot rather than at logon.
- Automatic update of the app or of the node. An update is the installer
  run by hand (§6.8).

## 4. Anti-goals

- No data of the owner's is ever deleted, moved or rewritten in the old
  profile by this flow. The migration reads it; the backup copies it; the
  marker that ends it is written in the desktop state, not in the profile.
- No migration is marked done on anything but a verified result. A count
  that does not match, an item that failed, a node that answers nothing:
  the owner sees it, nothing is marked, and the old profile stays usable by
  the development flag.
- The window never runs a program whose path it read from a file (the
  task, the bridge file, `node.yaml`): `schtasks` by absolute path and its
  own binary as Node, as DA C-9 and C-10 have it.
- No new `KL_TEST_*` escape hatch. Tests inject.
- The owner is never left with two King Louies answering from one machine
  without being told: a standalone session beside a running node is the
  degraded standalone-once (channels, gateway, mesh and webhooks off, cron
  paused), and only while the profile is unmigrated or under the
  development flag.

## 5. Constraints

- `src/` stays Electron-free except `src/ipc/` (`tests/electron-boundary.test.js`).
  The launch rule, the setup flow's state and the backup live outside
  `src/ipc/`; the controller in `src/ipc/` wires them.
- Every Windows owner read is the handle-based inspector in an asynchronous
  PowerShell child (`inspectWindowsOwnersAsync`); never a blocking call in
  the Electron main process.
- Every string from the node, the CLI, a file name or the old profile
  reaches the pane through `shown` (`src/service/commands/io.js`) and the DOM
  through `textContent`.
- `history.sqlite` is read only through `readHistoryChats`'s snapshot
  (`sqlite.backup`, `src/migration/desktop-history.js`), never opened for
  writing by the desktop again once attached.
- The fleet layout's rules, wording and tests do not change (R-DA-1,
  R-DA-5). What this design changes is the desktop's own launch and setup,
  the personal node's install, and personal-hosting behaviour on the service
  side of the bridge, each behind `hosting === 'personal'`.
- Invented values only in docs and fixtures (`laptop-01`, `example.com`,
  `%APPDATA%`-style paths).

## 6. Decisions

### 6.1 The launch rule (one predicate)

Today `main.js:34-37` builds the standalone host unless the desktop state
says `attached`, and `--kl-standalone-once` forces standalone. The new rule
is one pure function, `resolveLaunchMode({ argv, platform, stateMode })` in
`src/desktop-bridge/launch-mode.js`, called once in `main.js` before any
host is built:

| Condition, first match wins | Host | `why` |
|---|---|---|
| `argv` has `--kl-standalone-once` | standalone, degraded as today | `once` |
| `argv` has `--kl-standalone` | standalone, full | `dev` |
| `stateMode === 'attached'` | attached | `attached` |
| `platform !== 'win32'` | standalone, full | `platform` |
| otherwise | attached, with no pairing: the setup flow | `needs-node` |

`--kl-standalone` is the development flag (C-1): the whole standalone core,
nothing off, as `npm start` builds today. `npm start` stays `electron .`,
the product path; `npm run start:standalone` is `electron . --kl-standalone`.
The e2e harness's `launchApp` appends `--kl-standalone` to every launch
unless `opts.attached` is set, and the controller's `relaunch()` strips both
flags (it strips `--kl-standalone-once` today, `desktop-controller.js:188`),
so `launchAttached`'s **Attach** relaunch comes back attached as it does
now (C-2). The e2e suite changes in `tests/e2e/helpers.js` alone.

Off Windows (item 1 of the brief): confirmed from the code. `install
--personal` refuses off Windows (PN C-6), `createPersonalNodeRunner` is
`null` there (`desktop-controller.js:102`), and the personal trust rule has
no POSIX branch (DA §5.1). A window there with no node could show nothing
until stage 4, so `platform` keeps standalone, explicitly, in the one
predicate; a fleet pairing (`stateMode === 'attached'`) still attaches
there, as today. Stage 4 removes the `platform` row.

The `why` reaches `desktop:status` as `launch: { host, why }`, so the pane
can say "Development mode: this app runs its own King Louie" and the setup
flow knows it is the product path.

### 6.2 What the window shows with no node

In attached mode with no pairing (`needs-node`), or with a pairing whose
node cannot be reached before the setup is complete, the chat area is
replaced by the setup view (§6.3): the window shows the way to get a node
and nothing else (owner decision, ADR 0003). The sidebar, the input and the
settings button are hidden; Settings > Local service is reachable from the
view's own link only. Once `state.setup.completedAt` is set, a later drop
shows today's `attached-disconnected` banner over the chat with its Start
or Restart button (DA §7.4), minus "Use standalone this time" on Windows
(C-3): the window's answer to a down node is to start it, not to run a
second King Louie. Off Windows the banner is as today.

### 6.3 The setup flow

A state machine in `src/desktop-bridge/setup-flow.js`, Electron-free:
`nextSetupStep(facts)` → one of `install`, `start`, `pair`, `migrate`,
`provider`, `profile`, `phone`, `done`, and `describeSetup(status)` → the
lines and actions the renderer draws, holding no copy of the rules (the
pattern of `pane-model.js`). The facts are what the controller reads each
time (`desktop:status` gains `setup`): the launch rule, the inspector's
answer (`detectPersonalNode`, extended: §6.4), the task, the pidfile, the
pairing, the connection, `bridge.status` (`providersConfigured`,
`hosting`, `version`), the old profile (§6.5), `state.migration` and
`state.setup`.

The steps, in order, each skipped when its fact already holds:

1. **Install** (no `node.yaml` or no task): `install --personal --dry-run`
   shown in a `<pre>`, then one press **Install** (the consent the CLI's
   `[y/N]` asks for), then `install --personal --yes` (DA §8 as it is).
   The target data dir on a machine with nothing is `personalDataDir()`
   (`%LOCALAPPDATA%\KingLouie\node\data`), the CLI's own default (C-4).
2. **Pair** (no pairing): the one-click personal pairing of DA §6.2, which
   creates the node identity when there is none, writes the bridge file and
   turns the bridge on, then runs the task (no node runs yet) and confirms.
   The pairing record carries `hosting` and `dataDir` (DA C-7). It ends in
   `attach()`: `state.setMode('attached')` and a relaunch. The relaunch
   comes back here with the pairing in place.
3. **Start** (paired, node down): DA §7, unchanged.
4. **Migrate** (an old profile and no `state.migration`): §6.5.
5. **Provider** (`providersConfigured` false): the wizard's provider step,
   saved through the proxied `settings:saveProvider` into the node's vault.
   A migration that carried a provider token skips it.
6. **Profile** (the node's user profile is the default): name and role
   through the proxied `settings:saveUserProfile`. A migration that carried
   the user profile skips it.
7. **Phone and front door** (optional, always offered once): the lines the
   install guide's §13 gives, `king-louie-service pair wss://<relay>` or
   `pair https://mcp.<domain>`, then `enroll-device`, each with
   `--data-dir` when the data dir is not the default, with "stop the node
   first" (`pair` refuses while it runs) and **Skip**. Nothing is run.
8. **Done**: `state.setSetup({ completedAt })`; the chat appears.

The flow is driven by the window: each step is one `desktop:setup*` call
(§8) and `desktop:statusChanged` after each stage, so a step that takes a
minute (the install, the start, the move) shows its progress line. A step
that refuses shows the refusal and **Try again**; nothing is retried by
itself. The old onboarding wizard (`src/wizard/onboarding-wizard.js`,
`wizard:*`) becomes the steps 5 to 7 of this flow when attached; in
development mode it runs as today against the standalone core (its
channels step included), so `tests/e2e/app-launch.test.js` and the wizard
tests keep their behaviour.

**Postponing** (item 4 of the brief, C-5). While the profile is unmigrated
and holds chats or cases, the setup view's first screen has **Not now: use
the old standalone mode this time**, which is today's standalone-once
relaunch. It says that standalone mode is going away and that cron and the
channels are off in it. A profile with nothing in it has no such button.
The offer cannot be declined for good: ADR 0003 retires standalone, and a
permanent decline would keep two King Louies on the owner's machine with
no path between them. Once `state.migration` is set the button is gone and
`desktop:standaloneOnce` and `desktop:detach` refuse `PROFILE_MIGRATED`
(§6.5), the development flag excepted.

### 6.4 Installing from nothing

Today's install offer needs a personal node to be there already:
`installTarget()` returns `null` unless `detectPersonalNode` finds a
`node.yaml` saying `personal` (`desktop-controller.js:1074-1087`), and
`install --personal` refuses with no `chrome.exe` found
(`personal-install.js:297`). Three changes (C-4, C-6):

- `detectPersonalNode()` also answers `{ personal: false, fresh: true,
  dataDir, configDir }` when neither `node.yaml`, `service.json`, the data
  dir nor a `KingLouie Node` task exists at `personalDataDir()`, and the
  fleet layout is absent (`fleetLayoutExists` false). `installTarget()`
  accepts `fresh`. A fleet layout present, or a `node.yaml` that is not
  personal, stays `NOT_PERSONAL` with the fleet rule's own wording.
- `install --personal` with no Chrome found writes `node.yaml` with `gui:
  enabled: false` and no `apps`, prints one line ("no chrome.exe found:
  takes and desktop apps are off; add `gui.apps.chrome` and `gui.browser`
  to `node.yaml` to turn them on"), and goes on. `--browser` still writes
  the full block. `missingLines` does not nag for the browser lines when
  `gui.enabled` is false.
- `defaultStartable` also says `ok` when `<configDir>/service.json` loads
  with `features.desktopBridge: true`: a node whose client is the window
  needs no relay to run (the e2e test service runs so today), so the
  install's own `/Run` step runs after a pairing turned the bridge on. The
  pairing flow runs the task itself regardless (DA §6.2 step 4), so the
  first run from the window never depends on this; a terminal install does.

### 6.5 The one-time move

**Trigger.** At the `migrate` step: the desktop's own profile
(`app.getPath('userData')`) holds `history.sqlite` or a `chat-data.json`
with a case root or a chat, and `state.migration` is null. `detectOldProfile(userDataDir)`
in `src/migration/profile-backup.js` answers `{ found, chats, messages,
cases, bytes, schemaProblem }` from the snapshot reader and the inventory,
never from the live store. A profile whose store does not open, or opens
with a schema the reader refuses, is `found: true, schemaProblem` and the
step shows it and offers **Retry** and **Skip for now**; nothing is marked.

**Which import.** The move is the desktop's own bridge import
(`importPlan`/`importApply`, `desktop-controller.js:809-843`, over the one
engine in `src/migration/desktop-import.js`), not the CLI `import --from`
(C-7). The owner's constraint is that secrets arrive only through the
desktop's own Import; the CLI leaves every key `needs-desktop` and the
owner with a node that can call no model. The bridge import carries the
provider tokens, search and image keys, the vault and the Anthropic OAuth
token (`SECRET_CATEGORIES`) decrypted here with `safeStorage`, runs with
the node up, and is the same planner and manifest the CLI uses, so a case
already moved with `import --case` plans `skip-present` or
`needs-attention`, never overwritten (DA §9.2). `import --from` stays for a
terminal; the install guide keeps its sequence.

**The backup, first.** Before any plan is applied, `backupProfile({
userDataDir, dest })` copies the profile into a sibling directory the
desktop makes: `<parent of userData>\king-louie.backup-<ISO timestamp with
colons removed>` (C-8). It refuses to begin when `dest` exists. It copies
every regular file under the profile except twelve Electron directories at
the top level (`EXCLUDED_DIRS`: `Cache`, `Code Cache`, `GPUCache`,
`DawnCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `blob_storage`, `Session
Storage`, `Local Storage`, `Service Worker`, `Network`, `logs`; a running
desktop holds `Network/Cookies` locked) and `history.sqlite` with its `-wal`,
`-shm` and `-journal`, which it snapshots instead with the same
`sqlite.backup` the reader uses, into `<dest>\history.sqlite`.
Links are copied as what they point to, never followed outside the
profile (`fs.cp` with `dereference: false`, a link refused). Then it
verifies: every copied file's size and SHA-256 equal the source's read
again after the copy; the snapshot opens read-only and its chat count and
message count equal the reader's. It writes `<dest>\backup.json` (`v: 1`,
`from`, `at`, `files: [{ path, bytes, sha256 }]`, `history: { chats,
messages }`, `appVersion`) and answers `{ dest, bytes, files, history }`.
Any failure removes nothing of the source and leaves the half-made `dest`
in place, named in the refusal (`BACKUP_FAILED`), so the owner can look
at it; the move does not begin.

**One desktop per profile.** `main.js` takes a single-instance lock per
`userData` (`src/ipc/single-instance.js`), after `--user-data-dir` is applied:
a second desktop writing the profile is what the backup's check cannot catch
from inside. A second launch focuses the first window and exits 0, and its
argv is never read.

**What cannot move.** The plan and the apply refuse `MIGRATION_SOURCE`, with
nothing moved, for: `schemaProblem`; a source that reads fewer chats or
messages than its backup; a custom `cases.root` that is absent or holds cases
(they are outside the profile and would not move; checked at the plan, before
the apply and again before the mark); and a case the reader holds back whole
(a nested repository, a refused directory: otherwise a whole case is marked
moved with a line on screen). A dirty case lands as it stands, with a note in
the plan: a case mid-turn at a crash must not block the move.

**What is shown.** The plan, grouped as `printPlan` prints it: counts per
category and action (`new`, `update`, `copy`, `skip-present`,
`needs-attention`), each `needs-attention` line, and a fixed **Stays on
this computer** list from `EXCLUDED` plus the three the engine does not
walk: browser profiles (log in again in the node's browser), local servers
(`models.localServers`: add them to the admin `service.json`, §6.6 G-5),
the typesafe.ai key. The backup's path and size. Then one press **Move
everything** (owner decision: one confirm).

**Apply.** `applyImport` as it is, with `desktop:importProgress`. Nothing
is removed from the old profile. Under personal hosting the carry set
grows (C-9): `settings.models` without `localServers` (the owner's
profiles, custom roles and King Louie settings; a profile that names a
local model keeps it, and the resolver fails over past it until the server
is added), `settings.channels` with `channelTokens` (the reason for
excluding them, "a chat bot must not answer from two hosts", no longer
holds: the desktop has no core), `settings.hooks` and `settings.mcpServers`
(the owner is the administrator of a personal node). The service's
importer takes them only when its node is `hosting: personal`; a fleet
node keeps today's `EXCLUDED`. Skills, workflows and webhooks stay behind
and are listed.

**Verify.** After the apply, `verifyMigration({ plan, report, client })`
(`src/migration/migration-verify.js`) asks the node over the proxied
channels: every chat planned `new`, `update` or `copy` is in `chat:load`
by its target id with the planned message count; every case planned `new`
is in `case:list`; the report has no failed item. A difference is
`MIGRATION_UNVERIFIED` with the list of what is missing; nothing is
marked; **Try again** plans again (what landed is `skip-present`). The
report's counts and the verification are shown.

**Mark.** On a verified result: `state.setMigration({ at, backupDir,
nodeDataDir, nodeId, counts })` in the desktop state (`desktop-bridge.json`
in the profile, the file `openDesktopState` already owns). From then on:
`main.js` never builds a core from this profile (the launch rule's
`attached` row); `desktop:standaloneOnce` and `desktop:detach` answer
`PROFILE_MIGRATED` ("This profile was moved into King Louie Node on
<date>; its copy here is kept but no longer used. The backup is at
<backupDir>."), unless `why` is `dev`; the setup never offers the move
again; the pane's **Import…** stays, for a deliberate re-import that plans
`skip-present`. Unpair clears the pairing and the mode as today but not
the migration marker, so an unpaired migrated profile shows the setup view
with pairing as its first step and no move.

**A move that fails halfway.** Each item is written and recorded in the
node's manifest as it lands; the desktop shows the report with the failed
count; nothing is marked; **Try again** plans again. A landed case's manifest
entry records `landedFrom` (the source's head, file count and bytes), so a
retry takes it as present while its source still equals what landed and the
node's repository passes `git fsck`, whatever the node has done since; else it
is `needs-attention`. That trusts the node's working tree: a file removed there
reads as the node's own work, and a same-size edit is not caught. The backup is not
made again if `<dest>\backup.json` from this launch verifies (the setup
keeps its path in memory); a new launch makes a new backup directory. Two
backups cost disk and nothing else.

**A node that already has data.** The plan says it, item by item, the
owner's real situation (a case moved by hand, chats on both sides). A chat
changed on both sides comes as a copy named `<title> (from desktop)`, as
today. The owner reads the plan before the one press.

**A second run.** `state.migration` set: the step is skipped. A profile
migrated, then unpaired, then paired to another node: the step is skipped
too (the marker names the first node); the pane's **Import…** is the way
to move it again, on purpose.

**What `import` carries and does not.** Carried over the bridge: settings
(`IMPORTED_SETTINGS_KEYS` plus the personal carry set), the user profile,
permission rules and always-approve entries (tagged `origin: 'desktop'`),
allowed directories, chats with their messages, memory, cron jobs
(disabled), cases, provider tokens, search and image keys, the vault, the
Anthropic OAuth token, and under personal the channel tokens. Not carried:
`EXCLUDED` as listed in `desktop-import.js:54-79` (mesh identity, gateway
token, provider status, embeddings, tool results, background tasks,
checkpoints, voice files, skills, workflows, webhooks; `settings.hooks`,
`settings.mcpServers` and `settings.channels` only on a fleet node),
`models.localServers`, `__typesafe_api_key`, browser profiles, the desktop
state itself. Each is named in the **Stays on this computer** list.

### 6.6 Gaps a standalone owner meets attached (item 5)

From `src/desktop-bridge/allowlist.js`, `bridge-dispatcher.js`,
`models-handlers.js` and the settings panes. `G-n` numbers them; each is in
the plan or a named non-goal.

| | What | Today attached | Under personal hosting (this design) |
|---|---|---|---|
| G-1 | `ATTACHED_UNAVAILABLE_TABS`: `hooks`, `skills`, `webhooks`, `workflows`, `system-apps`, `diagnostics`, `channels`, `mcp` | marked unavailable; their domains (`hooks:`, `skill:`, `webhook:`, `workflow:`, `apps:`, `diagnostics:`, `channel:`, `settings:mcp*`) are not proxied | proxied: `classifyChannel(channel, { hosting })` adds `PERSONAL_PROXIED_DOMAINS` and lifts `settings:mcp` from `DENY_PREFIXES`; `unavailableTabsFor('personal')` is `['mesh']`. The service serves them from its own stores; the owner is the administrator of a personal node. The handshake's `channels` list already tells the desktop what is served (`SERVICE_TOO_OLD` otherwise). |
| G-2 | `CHANNELS_NOT_PROXIED` (`/llm` channel actions in `settings:runLlmCommand`) | refused in the dispatcher | allowed under personal: the desktop has no core, so no bot answers twice. The fleet keeps the refusal. |
| G-3 | `mesh` tab | unavailable | unavailable; the peer mesh retires in stage 4 (non-goal). |
| G-4 | the on-screen approval dialog | already on-screen: the dispatcher marks every desktop event `markLocalDesktopEvent` (`bridge-dispatcher.js:174`), and `executor-options.js:151-165` keeps the dialog for a marked event even with a phone enrolled | unchanged. A chat turn the window sends asks on-screen; a task's or a bridge chat's call asks the phone or is refused. |
| G-5 | local servers (`models:local.add` and the rest) | `LOCAL_SERVER_ADMIN_ONLY`; the admin `service.json` `localInference` block | **non-goal** (C-10): L1 sealed `models.localServers` on the desktop and made the admin block the service's one source, with its own pin and grade rules; reopening that for personal hosting is a stage of its own. The Models pane under personal shows the config file's path and an example `localInference` block to paste, and says to restart the node. |
| G-6 | `chat:speakLast`, `settings:testVoice` (read-aloud) | `DENY_CHANNELS` | stays denied this stage: the handler speaks from the host process; on a personal node that is the node, in the owner's session, so it would work, but the voice settings and files stay on the desktop (`EXCLUDED` voice). Named non-goal; the install guide's known limits say so. |
| G-7 | `settings:anthropicOAuth*` | `DENY_PREFIXES` | non-goal (§3). |
| G-8 | `LOCAL_CHANNELS` (`app:quitWindow`, the history import's pick, preview and commit) | local | unchanged; they are the desktop's own. |
| G-9 | system toasts (`UiToastChannel`, `Notification`) | the node has no `Notification`; nothing reaches the desktop | non-goal; chat events already reach the window. |
| G-10 | `settings` panes that read the core's paths (General's data-dir line, Diagnostics) | show the desktop's | the service pane says "Data lives in King Louie Node at <dataDir>"; Diagnostics proxied (G-1) runs on the node. |
| G-11 | the task and setup CLI commands the owner once ran against the desktop (`token set`, `vault set`) | n/a | the window's provider step and the Vault tool reach the node's stores; the guide's lines stay for a terminal. |

### 6.7 Tasks and the window (item 6)

Not stage 2, with these reasons (C-11):

- **Seeing a task chat** comes with attaching and needs no work: a task is a
  real chat in the node's store (stage 1), so the window's chat list shows
  it. The one addition here is a badge: the renderer marks a chat whose
  record has `taskId` as `Task · <client>` in the list and above the
  messages, from the chat fields (`taskId`, `client`), with no new channel.
  Sending into it is the owner taking the chat, which stage 1 already
  defines.
- **On-screen approval of a task's call** (stage 1 spec's Q10) is not done.
  A task's approval path is the phone by ADR 0004 (one grant, signed), and
  a task comes from a client through the front door; the window's dialog
  answers only events marked as the local desktop's. Letting the window
  answer for a task means a second approver per node and a rule for which
  one is asked; that belongs with the window as a client (stage 3), where
  the window's own task would be the case for it.
- **`RunTask` from the window** needs placement, which the front door does
  (stage 1), and the window reaching the front door is stage 3's remote
  attach.

### 6.8 Node down, crash, versions, update, removal, reboot (item 7)

| Case | What happens |
|---|---|
| Node down at launch | DA §7: the task is run once, 60 s wait, `attached-starting`; then the banner with **Start King Louie Node**. Unchanged. |
| Node crashes while connected | A drop never runs the task by itself (DA C-13, kept): the banner reads the task and the pidfile and offers **Start** or **Restart King Louie Node**. The task's own `RestartOnFailure` restarts a node that exits non-zero; the desktop reconnects on its backoff. |
| Node older than the app | Protocol: `PROTOCOL_MISMATCH` is fatal, as today. Same protocol, older version: `bridge.status.version` is compared with `app.getVersion()` under personal; a difference adds a row to the service pane and the banner, "King Louie Node runs <v1>; this app is <v2>. [Restart King Louie Node to update it]" (C-12). The node runs the app's own binary when installed from the window (DA C-9), so a restart is the update. Not automatic: a restart ends a turn or a take. |
| App updated while the node runs | The NSIS installer closes processes of the app's executable, and the node is one (RunAsNode), so the installer stops it; the task's `RestartOnFailure` or the desktop's next launch starts it on the new files. A node installed from a terminal with `node.exe` is untouched and shows the version row. |
| App removed | The uninstaller runs `king-louie-service uninstall --personal --yes` through the app's binary before the files go (`build/installer.nsh`, C-13): the logon task is ended and deleted, the data dir kept. Without it the task would point at a binary that is gone (PN residual). |
| App moved | The task cannot start; the desktop finds `NODE_START_FAILED` or `NODE_TASK_MISSING`'s neighbour `NODE_START_TIMEOUT` and the pane's **Install…** registers the task again with the new path (install re-registers an existing task). |
| Reboot before login | The logon task is the design's limit (PN): the node is down until the owner logs in; the window starts it at its launch. The phones show "Could not confirm" meanwhile. |
| `king-louie-service stop` by the owner | A drop; the banner offers **Start**. Nothing runs the task by itself. |
| The app itself elevated | `PAIR_ELEVATED` from the CLI; the setup view shows "This app is running as administrator. Close it and open it normally." and offers nothing else. |

## 7. Security framing and residuals

Nothing here widens a trust rule. The launch rule decides only which host
`main.js` builds; the setup flow runs the same CLI commands the pane runs
today, with the same consent presses; the migration is the same import
over the same handshake; the carry set under personal moves settings the
owner's own account wrote into a node the owner's account runs.

What is admitted:

- The backup directory is under the owner's `%APPDATA%`, with the profile's
  ACL: anything running as the owner can read it, as it can read the
  profile. It holds the sealed secrets as the profile holds them (DPAPI,
  this account), and the history in the clear, as the profile does.
- Two copies of every chat and case now sit on the disk (three with the
  backup). Nothing removes them (non-goal), and the development flag can
  still open the old profile's core. `PROFILE_MIGRATED` refuses the two
  product paths into it.
- The personal carry set moves hooks and MCP server definitions, which
  spawn processes, into the node. They were the owner's on the desktop and
  run as the owner on the node; the fleet keeps them out.
- G-1 proxies the skills, webhooks, workflows and hooks panes to a
  personal node; each is a process the node may spawn, as the desktop did.
  The window is marked as the local desktop's event, so an approval a pane's
  own call asks for is on-screen. A workflow is not: its tool calls go to the
  phone or are refused, never on-screen, and a workflow outlives the window.
- The personal proxied list is for the same-account loopback bridge only. A
  paired device can run code as the owner through `skill:install`,
  `settings:mcpSave` and hooks. Stage 3's remote attach must use its own list:
  this one, over a remote link, is remote code execution by a remote window.
- A node running the app's binary dies with the installer (§6.8); a turn
  in progress is lost. The owner is told to quit the app before updating,
  and nothing more is promised.

## 8. IPC and channels

New channels are `desktop:*`, local by `LOCAL_PREFIXES`, registered through
`DESKTOP_METHODS`, `src/ipc/constants.js` and `preload.js`:

| Channel | Method | Does |
|---|---|---|
| `desktop:setupStep` | `setupStep()` | §6.3's current step with its facts and lines (`describeSetup`) |
| `desktop:setupLater` | `setupLater()` | the standalone-once relaunch while unmigrated; `PROFILE_MIGRATED` after |
| `desktop:migrationPlan` | `migrationPlan()` | §6.5: the backup (made and verified), then the plan and the stays-behind list |
| `desktop:migrationApply` | `migrationApply({ confirmed: true })` | the apply, the verification, the mark; `CONFIRM_REQUIRED` without |
| `desktop:setupFinish` | `setupFinish()` | `state.setSetup({ completedAt })` |

Changed: `desktop:status` adds `launch: { host, why }`, `setup: { completedAt,
step }`, `migration` (the marker or null), `oldProfile` (`detectOldProfile`'s
answer or null), `service.hosting` and `versionMismatch: { node, app } | null`.
`bridge.status` adds `hosting` (the node's `node.yaml` value). `wizard:getStatus`
in the attached host answers from the setup state. `desktop:standaloneOnce` and
`desktop:detach` gain the `PROFILE_MIGRATED` refusal.

The service side changes in `allowlist.js` (`classifyChannel` with
`hosting`, `unavailableTabsFor`), `bridge-dispatcher.js` (the channel-action
refusal under personal; `hosting` in the status), `bridge-server.js`
(`hosting` in `bridge.status`), `desktop-import.js` (the personal carry set)
and `service-wiring.js` (passes `hosting`). The fleet layout sees none of
it.

## 9. Documentation to amend

- `CLAUDE.md`, **Attached mode**: a new first bullet, "The launch rule":
  `resolveLaunchMode` and its five rows, `--kl-standalone` (dev),
  `start:standalone`, the e2e helper's flag, `PROFILE_MIGRATED`. In
  **Personal node**, "Install from the pane": `fresh`, no-Chrome install,
  `startable` with the bridge on. A new bullet **Setup and the move**: the
  steps, the backup directory and `backup.json`, `verifyMigration`, the
  marker, the personal carry set, G-1 and G-2. **Testing**: `launchApp`
  appends `--kl-standalone`; `launchApp({ attached: true })` does not. **Running
  the app**: `npm start`, `start:standalone` and the one-desktop-per-profile lock.
- `docs/install-guide.md` §13: "Attaching the desktop app" becomes the
  product's first run (the window installs, pairs, starts); "Moving
  everything from the desktop app" leads with the window's flow and keeps
  the terminal sequence under "From a terminal"; "Known limits" adds G-5,
  G-6, the backup directory, the version row, the installer stopping the
  node.
- `docs/driving-king-louie.md` §2: the node is installed by the window on
  first run; the terminal install stays.
- `CONTEXT.md`: no new term. "Setup" and "launch rule" are ordinary words.

## 10. Test plan

No test runs a real `schtasks`, a real install, a real elevated prompt or
the installer; owners come from an injected inspector; the e2e suite never
touches the real profile.

- `tests/launch-mode.test.js` (new): the five rows, first match wins; both
  flags; `platform` off Windows; `attached` wins over `platform`.
- `tests/desktop-controller.test.js` (extend): `relaunch` strips both
  flags; `PROFILE_MIGRATED` on `standaloneOnce` and `detach` once
  `state.migration` is set, not under `why: 'dev'`; `installTarget` accepts
  `fresh`; `setupStep` through the steps with a fake runner and client; the
  version row; `setupLater` only while unmigrated.
- `tests/desktop-setup-flow.test.js` (new): `nextSetupStep` over every
  fact combination of §6.3; `describeSetup`'s lines and actions, every
  string through `shown`.
- `tests/profile-backup.test.js` (new): `detectOldProfile` on an empty
  dir, a dir with a store, a store the reader refuses; `backupProfile`
  over a temp profile with a real history store (`tests/helpers/history-fixture.js`),
  caches left out, a link refused, `dest` existing refused, `backup.json`,
  a size mismatch refused (a file changed under it), the snapshot's counts.
- `tests/migration-verify.test.js` (new): a fake client answering
  `chat:load` and `case:list`; a missing chat, a wrong message count and a
  failed item each `MIGRATION_UNVERIFIED`; a clean report verified.
- `tests/desktop-import.test.js` (extend): the personal carry set planned
  and applied under `hosting: 'personal'`, excluded under the fleet;
  `localServers` never carried.
- `tests/desktop-bridge-allowlist.test.js`, `tests/desktop-bridge-dispatcher.test.js`,
  `tests/desktop-bridge-service.test.js` (extend): `classifyChannel` with
  `hosting`; `unavailableTabsFor`; `/llm` channel actions allowed under
  personal and refused under the fleet; `hosting` in `bridge.status`.
- `tests/desktop-personal-node.test.js`, `tests/service-cli-install-personal.test.js`
  (extend): `fresh`; no-Chrome `node.yaml`; `startable` with the bridge on.
- `tests/desktop-pane.test.js` (extend): the banner without
  `standaloneOnce` on Windows and with it off Windows; the version row.
- `tests/wizard.test.js` (extend or new): steps for attached and
  development mode.
- `tests/installer-script.test.js` (new): `build/installer.nsh` names
  `PERSONAL_TASK_NAME`'s uninstall command and `package.json` includes it.
- E2E: `tests/e2e/helpers.js` appends the flag; every existing e2e file
  runs unchanged. `tests/e2e/setup-view.test.js` (new, Windows only): a
  launch without the flag on a fresh profile shows the setup view and no
  chat input, with Install offered or a refusal shown; nothing is pressed.
  `tests/e2e/attached-mode.test.js` keeps the fleet path.

## 11. What is left to the builder

- The exact cache directory names Electron writes under `userData` on the
  current version (§6.5's exclusion list is from Chromium's usual set);
  check once against a real profile and extend the list, never shrink it
  to include a store.
- Whether `fs.cp` with `dereference: false` on Windows copies a junction as
  a junction (then refuse it first with `lstat`) or fails.
- Whether `missingLines`'s browser exemption needs `gui.enabled` read as a
  boolean from a hand-edited file.
- The NSIS `customUnInstall` macro's exact invocation of the app's binary
  with `ELECTRON_RUN_AS_NODE=1`, against one packaged build by hand; a
  failure there must not stop the uninstall.
- Whether the renderer hides the sidebar with a class on `body` or by the
  setup view covering it; either is fine, and the e2e test asserts only
  that `#user-input` is absent or hidden.

## 12. Deviations the builder may make

None planned. A builder who finds the spec and the code disagree records it
in the plan's "Deviations" section and changes the spec to match, as the
stage 1 plan did.

## 13. Owner decisions (grilling 2026-11-03, ADR 0003)

- The desktop window is a client of a node and nothing more. On first run
  it installs and starts a local personal node, moves any standalone
  profile it finds into it (one backed-up import, a one-time move), and
  attaches.
- A fresh install's wizard asks for a provider key; the front door is
  optional.
- A window with no node can show nothing but the way to get one.
- The standalone core stays only as a development mode, to be removed
  later.
- The owner is not asked during this design; the author decides and
  records each call.

## 14. Stage boundaries kept

Out: remote attach and the node switcher (stage 3); personal nodes on macOS
and Linux, headless browser on fleet nodes, `RunTask` in bridges, retiring
the peer mesh (stage 4).

## 15. The author's calls (for the owner to overrule)

- **C-1**: development mode is the argv flag `--kl-standalone` (full
  standalone core); `npm start` stays the product path; `npm run
  start:standalone` is the dev one. `--kl-standalone-once` keeps its
  degraded semantics and is reached only from the setup's **Not now** and
  the off-Windows banner.
- **C-2**: the e2e harness appends `--kl-standalone` to every `launchApp`
  unless `opts.attached`; `relaunch()` strips both flags. No e2e file
  changes.
- **C-3**: on Windows the attached-disconnected banner loses "Use
  standalone this time"; the down node is started, not replaced.
- **C-4**: install from nothing targets `personalDataDir()`;
  `detectPersonalNode` answers `fresh` for an empty layout.
- **C-5**: the migration can be postponed per launch (standalone-once) while
  the profile is unmigrated and non-empty, with a notice that standalone is
  going away; it cannot be declined for good. The most overrulable call
  here: a stricter reading of ADR 0003 drops the button.
- **C-6**: `install --personal` with no Chrome writes a node with `gui`
  off instead of refusing; `startable` accepts a node whose client is the
  window (bridge on, no relay).
- **C-7**: the move is the desktop's own bridge import, not the CLI
  `import --from`: it is the only path that carries secrets, and it runs
  with the node up. The ADR's "one backed-up `import --from`" is read as
  "the one importer, once, with a backup".
- **C-8**: the backup is a sibling directory of the profile under
  `%APPDATA%`, with `history.sqlite` snapshotted through `sqlite.backup`,
  Electron caches left out, every file hashed and the store's counts
  checked, recorded in `backup.json`; it is never removed.
- **C-9**: under personal hosting the import also carries
  `settings.models` (minus `localServers`), `settings.channels` with the
  channel tokens, `settings.hooks` and `settings.mcpServers`; a fleet node
  keeps today's exclusions.
- **C-10**: local servers from the window on a personal node are a
  non-goal this stage; the pane shows the admin block to paste.
- **C-11**: tasks and the window: a badge on task chats only; approvals
  stay on the phone; `RunTask` from the window and on-screen task approval
  wait for stage 3.
- **C-12**: a node older than the app shows a row with one press to
  restart it; never automatic.
- **C-13**: the NSIS uninstaller removes the personal node's logon task
  through the app's own binary; the data dir is kept.
- **C-14**: `verifyMigration` compares the plan's write items with the
  node's `chat:load` and `case:list`; only a verified result sets the
  marker, and the marker lives in the desktop state, not in the profile.
- **C-15**: under personal hosting the window gets the hooks, skills,
  webhooks, workflows, system-apps, diagnostics, channels and MCP panes
  proxied, and the `/llm` channel actions allowed; `mesh` stays out.
