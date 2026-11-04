# Attach Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows the app never builds a core of its own outside development mode: with no node it shows a setup flow that installs, pairs and starts a personal node, moves an existing standalone profile into it once (verified backup, one press, verified result, the old profile never read again) and attaches; attached to a personal node, the owner keeps what standalone gave them.

**Architecture:** One pure launch rule (`src/desktop-bridge/launch-mode.js`) decides the host in `main.js`. A pure setup state machine (`src/desktop-bridge/setup-flow.js`) says which step is next and what the pane shows; the controller (`src/ipc/desktop-controller.js`) runs each step with the runner, the CLI and the bridge client it already has. The move is the existing bridge import with a backup (`src/migration/profile-backup.js`) before it and a verification (`src/migration/migration-verify.js`) after it, and a marker in the desktop state. Personal hosting reaches the service side of the bridge as one `hosting` value: the allowlist, the dispatcher and the importer branch on it.

**Tech Stack:** Node 22/24, Electron, `node:test`, Playwright `_electron` (e2e), `node:sqlite` backup, NSIS (electron-builder).

**Spec:** `docs/superpowers/specs/2026-11-03-attach-stage2-design.md` (with ADR 0003, `2026-10-28-desktop-attached-to-personal-node-design.md`, `2026-10-25-personal-node-design.md`).

## Global Constraints

- Tests run with `node --test tests/<file>.test.js`, never Jest. Covering tests per task; the full `npm test` once, in the last task.
- Everything under `src/` but `src/ipc/` stays Electron-free (`tests/electron-boundary.test.js`). New modules: `src/desktop-bridge/launch-mode.js`, `src/desktop-bridge/setup-flow.js`, `src/migration/profile-backup.js`, `src/migration/migration-verify.js`.
- Windows owner reads are the asynchronous inspector (`inspectWindowsOwnersAsync`); nothing blocking in the main process.
- Programs run by absolute path, arguments as an array, never a path read from a file. The CLI runs as the app's own binary with `ELECTRON_RUN_AS_NODE=1` (`nodeRunner.runCli`).
- Every string from the node, the CLI, a path or the old profile goes through `shown` (`src/service/commands/io.js`) and reaches the DOM with `textContent`.
- The desktop never writes into the old profile's stores; the migration marker lives in `desktop-bridge.json` (`openDesktopState`).
- Timers a test awaits are ref'd; a controller built in a test gets `dispose()`; stores built in tests close (`closeOpenHistoryStores()` before removing a temp dir).
- Spec values: flags `--kl-standalone` (dev) and `--kl-standalone-once` (degraded); backup dir `<parent of userData>/king-louie.backup-<ISO timestamp without colons>`; cache dirs left out of the backup: `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `blob_storage`, `Session Storage`, `Local Storage`, `Service Worker`, `logs`; `unavailableTabsFor('personal')` is `['mesh']`; codes `PROFILE_MIGRATED`, `BACKUP_FAILED`, `MIGRATION_UNVERIFIED`, `CONFIRM_REQUIRED`, `NOT_PERSONAL`.
- The fleet layout's rules, wording and tests do not change; every service-side change is behind `hosting === 'personal'`.
- No `KL_TEST_*` escape hatch. Invented values only (`laptop-01`, `example.com`).

## Review Focus

- An old profile whose `history.sqlite` the reader refuses (older schema, locked, corrupt): the move must show the problem and mark nothing, never plan an empty move and call it done (Task 5 test `store the reader refuses is found with schemaProblem`, Task 7 test `migrationPlan refuses on schemaProblem`).
- The backup destination exists, or the disk fills during the copy: refused before any apply, the half-made directory named, the source untouched (Task 5 tests `dest exists is refused`, `a copy whose size differs is refused`).
- The node already holds a case with the planned directory (the owner's hand-moved case): `needs-attention`, never overwritten, and the verification does not count it as missing (Task 7 test `needs-attention items are not verified as missing`).
- An unpaired app on Windows whose install or start refuses (elevated, task of another account, fleet layout present): the setup view shows the refusal and never loops into a relaunch or a standalone core (Task 8 tests `elevated shows PAIR_ELEVATED and nothing else`, Task 1 test `needs-node never picks standalone`).
- A migrated profile on a later launch: `standaloneOnce` and `detach` refuse `PROFILE_MIGRATED`; the development flag still opens it (Task 7 test `PROFILE_MIGRATED unless dev`).

---

### Task 1: The launch rule

**Files:**
- Create: `src/desktop-bridge/launch-mode.js`
- Modify: `main.js:32-37`, `src/ipc/desktop-controller.js:182-192` (`relaunch`), `package.json` (scripts), `tests/e2e/helpers.js:61-70` (`launchApp`)
- Test: `tests/launch-mode.test.js` (new), `tests/desktop-controller.test.js` (extend)

**Interfaces:**
- Produces: `resolveLaunchMode({ argv, platform, stateMode }) → { host: 'standalone' | 'attached', why: 'once' | 'dev' | 'attached' | 'platform' | 'needs-node', degraded: boolean }`; constants `STANDALONE_FLAG = '--kl-standalone'`, `STANDALONE_ONCE_FLAG = '--kl-standalone-once'` (the controller's `STANDALONE_ONCE` imports the latter). `main.js` passes `launch` to both hosts in `deps`; the controller takes `launch` and exposes it in `status().launch`.

- [ ] **Step 1: Write the failing tests**

`tests/launch-mode.test.js`: a table over the five rows of spec §6.1, first match wins: `['--kl-standalone-once']` → `once`, degraded true, also when `stateMode` is `attached`; `['--kl-standalone']` → `dev`, degraded false; `stateMode: 'attached'` on `darwin` → `attached`; `platform: 'linux'`, `stateMode: 'standalone'` → `platform`; `win32`, `standalone` → `needs-node`, host `attached`. `needs-node never picks standalone`: on `win32` with no flag, every `stateMode` value gives host `attached`.

`tests/desktop-controller.test.js`: `relaunch strips both flags` (argv with `--kl-standalone` and `--kl-standalone-once`, outside test mode, the fake `app.relaunch` sees neither); `status().launch` echoes what was passed.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/launch-mode.test.js tests/desktop-controller.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

`launch-mode.js` is the table, no requires. `main.js`: `const launch = resolveLaunchMode({ argv: process.argv, platform: process.platform, stateMode: state.mode })`; `attached = launch.host === 'attached'`; `standaloneOnce = launch.degraded`; `deps.launch = launch`. The controller stores `launch` (default `{ host: mode, why: mode === 'attached' ? 'attached' : 'dev', degraded: false }` so existing tests pass) and `relaunch` filters both flags. `package.json`: `"start:standalone": "electron . --kl-standalone"`. `helpers.js`: `launchApp` adds `STANDALONE_FLAG` to `args` unless `opts.attached === true`; `relaunchApp` keeps `ctx.launchOpts.args` as it is (the relaunch into attached mode uses `args: []` from `launchAttached`, which passes `attached: true` on its relaunch; see Task 1 Step 4).

- [ ] **Step 4: Run the unit tests and one e2e file**

Run: `node --test tests/launch-mode.test.js tests/desktop-controller.test.js tests/attached-host.test.js`
Expected: PASS.

Run: `unset ELECTRON_RUN_AS_NODE && node --test --test-timeout=120000 tests/e2e/app-launch.test.js tests/e2e/attached-mode.test.js`
Expected: PASS (`app-launch` is standalone through the flag; `attached-mode` relaunches attached because `relaunch` stripped it and `launchAttached`'s relaunch passes `attached: true`). If `attached-mode` fails on the relaunch, `launchAttached` sets `ctx.launchOpts = { ...opts, attached: true }` before `relaunchApp`.

- [ ] **Step 5: Commit**

`feat(desktop): one launch rule; standalone only by flag or off Windows`

---

### Task 2: `hosting` and the version over the bridge

**Files:**
- Modify: `src/desktop-bridge/service-wiring.js:45-57`, `src/desktop-bridge/bridge-server.js:90-102` (`bridge.status`), `src/desktop-bridge/bridge-client.js` (keeps `service` from the handshake, as now), `src/ipc/desktop-controller.js` (`status()`)
- Test: `tests/desktop-bridge-service.test.js`, `tests/desktop-controller.test.js` (extend)

**Interfaces:**
- Produces: `bridge.status` adds `hosting: 'service' | 'personal'`; `DesktopBridgeServer` takes `hosting`; `service-wiring` passes `nodeConfig.hosting`. The controller's `status()` adds `service.hosting` (from the live summary, else the pairing record) and `versionMismatch: { node, app } | null` (`appVersion` injected, default `app.getVersion()`), set only under personal when `service.version !== appVersion`.

- [ ] **Step 1: Write the failing tests**

`desktop-bridge-service.test.js`: a server built with `hosting: 'personal'` answers `bridge.status` with `hosting: 'personal'`; one built without answers `service`. `desktop-controller.test.js`: `versionMismatch` is `{ node: '1.0.0', app: '1.0.1' }` with a fake client whose `service` is `{ version: '1.0.0', hosting: 'personal' }` and `appVersion: '1.0.1'`; null for a fleet service with the same difference; null when equal.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-bridge-service.test.js tests/desktop-controller.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`service-wiring.js` already loads `nodeConfig`: pass `hosting: nodeConfig.hosting` to the server; the server puts it in the status object. The controller reads `client.service.hosting`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-bridge-service.test.js tests/desktop-controller.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(bridge): the handshake says the node's hosting; the desktop sees a version gap`

---

### Task 3: Hosting-aware allowlist and dispatcher (G-1, G-2)

**Files:**
- Modify: `src/desktop-bridge/allowlist.js`, `src/desktop-bridge/bridge-dispatcher.js:112-121,142-148`, `src/desktop-bridge/bridge-server.js` (passes `hosting` to the dispatcher), `src/ipc/attached-host.js:112-131`, `src/ipc/desktop-controller.js:379` (`unavailableTabs`)
- Test: `tests/desktop-bridge-allowlist.test.js`, `tests/desktop-bridge-dispatcher.test.js`, `tests/attached-host.test.js` (extend)

**Interfaces:**
- Produces: `PERSONAL_PROXIED_DOMAINS = ['hooks', 'skill', 'webhook', 'workflow', 'apps', 'diagnostics', 'channel']`; `classifyChannel(channel, { hosting = 'service' } = {})`: under `personal` those domains are `proxy` and `settings:mcp*` is `proxy` (`settings:anthropicOAuth*` stays `deny`); `servedChannels(inventory, { hosting })`; `unavailableTabsFor(hosting)` → `ATTACHED_UNAVAILABLE_TABS` for `service`, `['mesh']` for `personal`. The dispatcher's `runLlmCommand` refuses `CHANNELS_NOT_PROXIED` only when `hosting !== 'personal'`.

- [ ] **Step 1: Write the failing tests**

Allowlist: every channel of each personal domain is `proxy` under personal and `deny` under service; `settings:mcpList` proxy under personal, deny under service; `settings:anthropicOAuthStart` deny under both; `chat:speakLast` deny under both; `unavailableTabsFor` values; `classifyChannel('hooks:list')` with no options is `deny` (today's callers unchanged). Dispatcher: with `hosting: 'personal'`, a `/llm telegram …` command reaches `context.runLlmCommand`; with `service` it is refused as today. Attached host: a `hooks:list` invoke on a desktop whose pairing record says `hosting: 'personal'` is proxied when the service lists it, and answers `SERVICE_TOO_OLD` when it does not.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-bridge-allowlist.test.js tests/desktop-bridge-dispatcher.test.js tests/attached-host.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

The attached host classifies with the pairing record's `service.hosting` (the record from Task 2 / DA C-7; a record without it is `service`); `served()` keeps deciding per channel from the handshake. The controller's `unavailableTabs` is `unavailableTabsFor(hosting)` when attached. The renderer's `markUnavailableTabs` needs no change.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-bridge-allowlist.test.js tests/desktop-bridge-dispatcher.test.js tests/attached-host.test.js tests/desktop-controller.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(bridge): a personal node serves the owner's panes and channel commands`

---

### Task 4: Installing from nothing (C-4, C-6)

**Files:**
- Modify: `src/desktop-bridge/personal-node.js:85-125` (`detectPersonalNode`), `src/ipc/desktop-controller.js:1074-1087` (`installTarget`), `src/service/personal-install.js:139-165,202-256,296-304` (`defaultStartable`, `wantedLeaves`, `renderNodeYaml`, `missingLines`, the Chrome refusal)
- Test: `tests/desktop-personal-node.test.js`, `tests/service-cli-install-personal.test.js`, `tests/desktop-controller.test.js` (extend)

**Interfaces:**
- Produces: `detectPersonalNode()` → `{ personal: false, fresh: true, dataDir, configDir, me }` when `node.yaml`, `service.json`, the data dir and the `KingLouie Node` task are all absent at `personalDataDir()` and `fleetLayoutExists()` is false (`fresh: false` otherwise, with today's fields). `installTarget()` accepts `fresh`. `renderNodeYaml({ name, chrome: null, provider, model })` writes `gui:\n  enabled: false`; `wantedLeaves` with `chrome: null` has only `gui.enabled: false`; `defaultStartable(configDir)` is also `ok` when `<configDir>/service.json` loads with `features.desktopBridge === true`.

- [ ] **Step 1: Write the failing tests**

Personal node: an empty layout with an injected `exists`/inspector and `queryTask` → `fresh: true` with `personalDataDir()`'s path; a layout with a fleet marker → `fresh: false`, `personal: false`. Install CLI: with `findChrome` returning null, install does not refuse, writes `node.yaml` with `gui:` `enabled: false` and no `apps`, prints the one line naming `gui.apps.chrome` and `gui.browser`; `missingLines` over that file with `chrome: null` is empty; `startable` is `ok` for a config dir holding `service.json` `{ "features": { "desktopBridge": true } }` and no relay; `NOTHING_PAIRED` with neither. Controller: `nodeInstallPreview` on a `fresh` detection runs `install --personal --dry-run --data-dir <personalDataDir>`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-personal-node.test.js tests/service-cli-install-personal.test.js tests/desktop-controller.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`parseGuiConfig` is still run over the rendered YAML (a `gui` block with `enabled: false` must load). The one printed line is a constant `NO_CHROME_LINE`. `fleetLayoutExists` comes from `src/platform/paths.js`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-personal-node.test.js tests/service-cli-install-personal.test.js tests/desktop-controller.test.js tests/examples.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(personal): install a node from nothing, with or without Chrome`

---

### Task 5: The old profile and its backup

**Files:**
- Create: `src/migration/profile-backup.js`
- Test: `tests/profile-backup.test.js` (new)

**Interfaces:**
- Produces: `detectOldProfile(userDataDir, { readHistory = readHistoryChats, reader, env }) → { found, chats, messages, cases, bytes, schemaProblem: string | null, customCasesRoot, customCases, customCasesMissing }`; `backupProfile({ userDataDir, dest, now, backup = sqlite.backup, appVersion, env, onProgress }) → { dest, bytes, files, history: { chats, messages } }` or throws `BACKUP_FAILED` (`err.code`, `err.dest`); `backupDirFor(userDataDir, now) → string` (spec §6.5's name); `EXCLUDED_DIRS` (the twelve directory names); `readBackupManifest(dest, { onProgress })`; `readCaseRoot(root)`. Beyond the plan: `claimSingleInstance({ app, getWindow })` in `src/ipc/single-instance.js`, one desktop per `userData`.

- [ ] **Step 1: Write the failing tests** (temp dirs; a real store through `tests/helpers/history-fixture.js`; `closeOpenHistoryStores()` before removal)

`empty dir is not found`; `a profile with a store is found with counts` (2 chats, 5 messages, 1 case dir under `cases/`); `store the reader refuses is found with schemaProblem` (a file named `history.sqlite` holding text); `backupDirFor` names `king-louie.backup-20261103T120000000Z` for a fixed clock beside the profile; `backup copies files and snapshots the store` (`chat-data.json` and `cases/x/.kl/budget.json` present with equal SHA-256, `history.sqlite` opens read-only in `dest` with the same counts, `history.sqlite-wal` absent, `Cache/` absent, `backup.json` lists every file with `bytes` and `sha256`); `dest exists is refused` (`BACKUP_FAILED`, nothing written); `a copy whose size differs is refused` (an injected `fsImpl.copyFile` that truncates: `BACKUP_FAILED`, `err.dest` names the directory, the source unchanged); `a link inside the profile is refused` (skipped off Windows when symlinks need privilege: create with `fs.symlinkSync` in a try and skip on `EPERM`).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/profile-backup.test.js`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Walk with `fs.readdirSync(…, { withFileTypes: true })`; a `Dirent` that is a symbolic link throws `BACKUP_FAILED`; skip `EXCLUDED_DIRS` at the top level and the three store files anywhere. The snapshot reuses `readHistoryChats`'s backup call (`src/migration/desktop-history.js:25-54`) into `<dest>/history.sqlite`, then opens it `{ readonly: true, allowOlderSchema: true }` for the counts. Hash with `crypto.createHash('sha256')` streaming. Write `backup.json` last with `writeFileAtomic`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/profile-backup.test.js tests/electron-boundary.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(migration): find the old profile and back it up, verified`

---

### Task 6: The personal carry set in the importer (C-9)

**Files:**
- Modify: `src/migration/desktop-import.js:22-24,54-79,298-330,428-563`, `src/migration/desktop-source.js:167-330` (the `channelToken` category), `src/desktop-bridge/service-wiring.js:37-44` (passes `hosting` to the importer)
- Test: `tests/desktop-import.test.js`, `tests/desktop-import-source.test.js` (extend)

**Interfaces:**
- Produces: `importedSettingsKeys(hosting)` → `IMPORTED_SETTINGS_KEYS` plus `['models', 'channels', 'hooks', 'mcpServers']` under `personal`; `settings.models` is carried with `localServers` deleted from the value (a test pins this); new category `channelToken` in `SECRET_CATEGORIES` and `CATEGORY_ORDER` (after `anthropicOAuth`), planned `new`/`skip-present` under personal and `skip-excluded` (`EXCLUDED.channelTokens`) under service; `new DesktopImporter({ …, hosting })`. The desktop source lists `channelTokens` names in its inventory and `secretValue('channelToken', name)` decrypts them.

- [ ] **Step 1: Write the failing tests**

Import: under `hosting: 'personal'` a plan over an inventory with `settings.models`, `settings.channels`, `settings.hooks`, `settings.mcpServers` and a channel token plans each `new`; applying writes the settings (the target's `models.localServers` is what it was before, whatever the source had) and stores the token through the cipher; under `service` each is `skip-excluded` with today's reasons. Source: a desktop profile with a Telegram token in its vault lists it under `channelTokens` and decrypts it only with `decrypt` given.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-import.test.js tests/desktop-import-source.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Keep `EXCLUDED` as the fleet's reasons; under personal the four `settings.*` reasons and `channelTokens` are not consulted. Writing `settings.models` goes through the core's `setSettings`, which keeps the stored `localServers` (L1); still strip it from the value so the manifest never records one.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-import.test.js tests/desktop-import-source.test.js tests/local-servers-config.test.js`
Expected: PASS (`local-servers-config` still finds `localServers` named only where it allows; if `desktop-import.js` is refused, delete the key by a constant from `src/models/local-servers.js` or list the file as that test's header says).

- [ ] **Step 5: Commit**

`feat(migration): a personal node takes the owner's models, channels, hooks and MCP servers`

---

### Task 7: Verify, mark, refuse the old profile

**Files:**
- Create: `src/migration/migration-verify.js`
- Modify: `src/ipc/desktop-state.js` (`migration`, `setup` fields), `src/ipc/desktop-controller.js:735-743,809-843` (`detach`, `standaloneOnce`, the import methods), `src/ipc/desktop-handlers.js`, `src/ipc/constants.js`, `preload.js`
- Test: `tests/migration-verify.test.js` (new), `tests/desktop-state.test.js`, `tests/desktop-controller.test.js`, `tests/preload-bridge.test.js` (extend)

**Interfaces:**
- Consumes: Task 5 (`detectOldProfile`, `backupProfile`), the existing `planImport`/`applyImport`.
- Produces: `verifyMigration({ plan, report, invoke }) → { ok: true, checked: { chats, cases } } | { ok: false, code: 'MIGRATION_UNVERIFIED', missing: [{ category, key, why }] }`, `invoke(channel, args)` being the proxied call; it checks every plan item with a write action in `chat` (by `targetKey` or the id, `messageCount` equal to the source's) and `case` (`case:list` holds the directory), and `report.failed.length === 0`. Desktop state: `migration` (`setMigration({ at, backupDir, nodeDataDir, nodeId, counts })`, null by default), `setup` (`setSetup({ completedAt })`). Controller: `migrationPlan()` → `{ ok, backup, plan, attention, staysBehind }` (the backup made and verified first, once per launch); `migrationApply({ confirmed })` → `{ ok, report, verified }` and sets the marker only on `verified.ok`; `standaloneOnce()` and `detach()` → `{ ok: false, code: 'PROFILE_MIGRATED', error }` when `state.migration` is set and `launch.why !== 'dev'`. Channels `desktop:migrationPlan`, `desktop:migrationApply`.

- [ ] **Step 1: Write the failing tests**

Verify: a fake `invoke` with the planned chats and cases present → ok; one chat missing → `MIGRATION_UNVERIFIED` naming it; a message count short by one → unverified; `needs-attention items are not verified as missing` (a case planned `needs-attention` absent on the node → ok); a report with a failed item → unverified. State: `migration` round-trips and defaults to null; `setMigration` without `backupDir` throws. Controller (fake client, fake runner, a temp profile from `history-fixture`): `migrationPlan` makes the backup and returns the plan and `staysBehind` lines naming browser profiles, local servers and the typesafe key; `migrationPlan refuses on schemaProblem` (no backup made, `MIGRATION_SOURCE`); `migrationApply` without `confirmed` → `CONFIRM_REQUIRED`; with a fake client that answers the verification → marker set with `backupDir`, `nodeId`, counts; with one chat missing on the node → no marker, `MIGRATION_UNVERIFIED`; `PROFILE_MIGRATED unless dev` for `standaloneOnce` and `detach`. Preload: the two channels exposed.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/migration-verify.test.js tests/desktop-state.test.js tests/desktop-controller.test.js tests/preload-bridge.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`migrationPlan` keeps the backup result in memory for the launch (`backupMade`) and reuses it when `readBackupManifest(dest)` still verifies. `staysBehind` is `EXCLUDED`'s reasons plus the three fixed lines (spec §6.5), each through `shown`. The verification's `invoke` is `client.invoke` on the connected client (the migration runs attached and connected; `SERVICE_UNREACHABLE` otherwise).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/migration-verify.test.js tests/desktop-state.test.js tests/desktop-controller.test.js tests/preload-bridge.test.js tests/desktop-bridge-allowlist.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(migration): the move is verified, marked once, and the old profile is not reopened`

---

### Task 8: The setup flow (state and words)

**Files:**
- Create: `src/desktop-bridge/setup-flow.js`
- Modify: `src/desktop-bridge/pane-model.js:228-242` (the banner without `standaloneOnce` on Windows; the version row), `src/wizard/onboarding-wizard.js` (`getWizardSteps({ attached })`)
- Test: `tests/desktop-setup-flow.test.js` (new), `tests/desktop-pane.test.js` (extend), `tests/wizard-steps.test.js` (new)

**Interfaces:**
- Produces: `SETUP_STEPS = ['install', 'pair', 'start', 'migrate', 'provider', 'profile', 'phone', 'done']`; `nextSetupStep(facts) → step`, facts `{ launch, node: { fresh, personal, task, running }, paired, connected, service: { providersConfigured, hosting }, oldProfile, migration, setup: { completedAt, phoneSeen }, userProfileDefault, elevated }`; `describeSetup(status) → { step, lines, actions, pre, error, canPostpone }` with action ids `nodeInstallPreview`, `nodeInstall`, `pairStart`, `nodeStart`, `migrationPlan`, `migrationApply`, `setupLater`, `skip`, `setupFinish`, `openServiceSettings`, `retry`; `describeAttachedBanner(status)` drops `standaloneOnce` when `status.platform === 'win32'` and adds `{ id: 'nodeRestart', label: 'Restart King Louie Node to update it' }` with the version line when `status.versionMismatch`. `getWizardSteps({ attached = false })` → attached: `provider`, `profile`, `phone` (optional), `finish`; standalone: today's five.

- [ ] **Step 1: Write the failing tests**

Setup flow, a table: `fresh` → `install`; `personal`, task missing → `install`; task registered, not paired → `pair`; paired, not running, not connected → `start`; connected, `oldProfile.found`, no migration → `migrate`; connected, migration set, `providersConfigured: false` → `provider`; providers set, `userProfileDefault` → `profile`; all set, `phoneSeen` false → `phone`; `phoneSeen` → `done`; `setup.completedAt` → `done` whatever else; `elevated` → step `install` with `error.code` `PAIR_ELEVATED` and no actions but `retry` (`elevated shows PAIR_ELEVATED and nothing else`). `describeSetup`: `canPostpone` true only for `oldProfile.found` and no migration; the `migrate` step's lines hold the backup path, the counts and every `staysBehind` line through `shown`; a node name with a control character is shown marked. Pane: the banner on `win32` has no `standaloneOnce`, on `darwin` it has; `versionMismatch` adds the line and `nodeRestart`. Wizard: both step lists by id.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-setup-flow.test.js tests/desktop-pane.test.js tests/wizard-steps.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`setup-flow.js` requires only `shown` and `pane-model`'s `plain`. `describeSetup`'s copy follows spec §6.3 and §6.5 ("Move everything", "Not now: use the old standalone mode this time", the going-away notice).

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-setup-flow.test.js tests/desktop-pane.test.js tests/wizard-steps.test.js tests/electron-boundary.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(desktop): the setup flow's steps and words`

---

### Task 9: The controller runs the setup

**Files:**
- Modify: `src/ipc/desktop-controller.js` (`status()`, new `setupStep`, `setupLater`, `setupFinish`, `nodeRestart`), `src/ipc/attached-host.js:74-79` (`wizard:*`), `src/ipc/desktop-handlers.js`, `src/ipc/constants.js`, `preload.js`
- Test: `tests/desktop-controller.test.js`, `tests/attached-host.test.js`, `tests/preload-bridge.test.js` (extend)

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5, 7, 8.
- Produces: `status()` adds `launch`, `setup: { completedAt, step }`, `migration`, `oldProfile`, `versionMismatch`, `platform`; `setupStep()` → `describeSetup(status)` with the facts read now (`inspectLocal`, the task, the pidfile, `detectOldProfile` once per launch and again after `migrationApply`); `setupLater()` → the standalone-once relaunch, `PROFILE_MIGRATED` when marked, `NOT_POSTPONABLE` when the profile is empty; `setupFinish()` → `state.setSetup({ completedAt })`, `skip` for `phone` sets `phoneSeen`; `nodeRestart()` → `nodeStart({ restart: true })`. Attached host: `wizard:getStatus` → `{ ok, isFirstRun: !state.setup.completedAt && launch.why !== 'dev' }`, `wizard:getSteps` → `getWizardSteps({ attached: true })`, `wizard:complete` → `setupFinish()`. Channels `desktop:setupStep`, `desktop:setupLater`, `desktop:setupFinish`.

- [ ] **Step 1: Write the failing tests**

Controller, with a fake runner, a fake client factory and a temp profile: a fresh machine → `setupStep().step === 'install'`; after `nodeInstall` the runner's task is `registered` and the step is `pair`; after `pairStart` resolves (the fake CLI answers the JSON line, the fake client connects) the mode is `attached` and a relaunch was requested; a controller built attached and connected over a profile with chats → `migrate`; after `migrationApply` verified → `provider` when `providersConfigured` is false, else `profile`, else `phone`; `setupFinish` sets `completedAt` and `setupStep` is `done`; `setupLater` relaunches with `--kl-standalone-once` while unmigrated, `PROFILE_MIGRATED` after, `NOT_POSTPONABLE` on an empty profile; `detectOldProfile` is read once per launch (an injected counter) and again after an apply. Attached host: `wizard:getStatus` is `isFirstRun: true` with no `completedAt`, false after `setupFinish`, false under `why: 'dev'`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/desktop-controller.test.js tests/attached-host.test.js tests/preload-bridge.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`setupStep` builds the facts from what the controller already holds (`nodeState`, `connection`, `client.service`, `state`) plus `detectOldProfile(userDataDir)` (injected as `detectOldProfile` for tests). The `migrate` step's actions call Task 7's methods. `elevated` comes from the last CLI refusal `PAIR_ELEVATED` or `install --personal`'s "runs as you, not elevated" line.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/desktop-controller.test.js tests/attached-host.test.js tests/preload-bridge.test.js tests/desktop-bridge-allowlist.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(desktop): the controller walks the setup from nothing to attached`

---

### Task 10: The window: setup view, wizard steps, task badge

**Files:**
- Modify: `index.html` (a `#setup-view` section beside `#wizard-overlay`), `renderer.js:13839-13995` (the wizard uses `getWizardSteps`'s ids; the setup view renders `describeSetup` and calls the actions), `renderer.js` chat list and header (the `Task · <client>` badge from `chat.taskId`, `chat.client`), `preload.js` (`desktop.describeSetup` exposed like `describeBanner`)
- Test: `tests/e2e/setup-view.test.js` (new, Windows only), `tests/renderer-task-badge.test.js` (new: the badge function is a pure helper the renderer exports for tests, after `tests/renderer-history-import.test.js`'s pattern)

**Interfaces:**
- Consumes: Task 8's `describeSetup`, Task 9's channels.
- Produces: `#setup-view` shown when `status.launch.host === 'attached'` and `setup.step !== 'done'`; while shown, `#user-input`, the sidebar and `#open-settings-btn` are hidden; every line set with `textContent`, `pre` in a `<pre>`; actions by id as `#setup-action-<id>`. `taskBadge(chat) → string | null` in a small module the renderer loads (`src/ipc/` is not the place: put it in `renderer-helpers/task-badge.js` beside the renderer, or inline and test through the e2e), giving `Task · <client>` for a chat with `taskId`.

- [ ] **Step 1: Write the failing tests**

`setup-view.test.js` (skips off `win32`): `launchApp({ attached: true, seed: null })` on a fresh profile (no `--kl-standalone`): `#setup-view` visible within 20 s, `#user-input` absent or hidden, the view holds either `#setup-action-nodeInstallPreview` or a line (the refusal, when the host has a fleet layout or runs elevated); nothing is clicked. A second test with `seed: { 'desktop-bridge.json': { mode: 'standalone', setup: { completedAt: '2026-11-03T00:00:00Z' }, installId: 'x' } }` still shows the view (unpaired: `pair` is the step). Badge: `taskBadge({ taskId: 't', client: 'claude.ai' })` is `Task · claude.ai`; `taskBadge({})` is null.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/renderer-task-badge.test.js && unset ELECTRON_RUN_AS_NODE && node --test --test-timeout=120000 tests/e2e/setup-view.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

The renderer's `refreshServiceStatus` calls `window.electron.desktop.setupStep()` when `status.launch.host === 'attached'` and renders; `desktop:statusChanged` re-renders. The wizard code path keeps its DOM and reads step ids from the list it is given (`provider`, `profile`, `phone`, `finish` under attached). The `phone` step is text and **Skip**.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/renderer-task-badge.test.js && unset ELECTRON_RUN_AS_NODE && node --test --test-timeout=120000 tests/e2e/setup-view.test.js tests/e2e/app-launch.test.js tests/e2e/attached-mode.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(window): the setup view, the attached wizard steps, a badge on task chats`

---

### Task 11: The uninstaller removes the logon task (C-13)

**Files:**
- Create: `build/installer.nsh`
- Modify: `package.json` (`build.nsis.include: "build/installer.nsh"`)
- Test: `tests/installer-script.test.js` (new)

**Interfaces:**
- Produces: a `customUnInstall` macro that runs `"$INSTDIR\King Louie.exe" "$INSTDIR\resources\app.asar\bin\king-louie-service.js" uninstall --personal --yes` with `ELECTRON_RUN_AS_NODE=1` set for that process, ignores its exit code, and never touches the data dir.

- [ ] **Step 1: Write the failing test**

`installer-script.test.js`: the file exists; it holds `!macro customUnInstall`, `uninstall --personal --yes`, `ELECTRON_RUN_AS_NODE`, and no `/Delete` of its own (the CLI does it); `package.json`'s `build.nsis.include` names it; the file holds no path from the owner's machine (`scanForPersonalValues` from `tests/helpers/example-denylist.js`).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/installer-script.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

NSIS: `System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'` then `nsExec::ExecToLog`; a comment names spec §6.8 and that a failure must not stop the uninstall.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/installer-script.test.js tests/examples.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

`build: the uninstaller removes the personal node's logon task`

---

### Task 12: Docs and the full suite

**Files:**
- Modify: `CLAUDE.md` (Attached mode: "The launch rule" bullet, "Setup and the move" bullet, the Personal node install bullets, Testing's e2e flag line), `docs/install-guide.md` §13 ("Attaching the desktop app", "Moving everything from the desktop app", "Known limits"), `docs/driving-king-louie.md` §2
- Test: `tests/docs-driving.test.js`, `tests/examples.test.js` (run), then the whole suite

- [ ] **Step 1: Write the docs** as spec §9 lists them, with invented values only.

- [ ] **Step 2: Run the doc tests**

Run: `node --test tests/docs-driving.test.js tests/examples.test.js`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: `# fail 0`.

Run: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`
Expected: `# fail 0` (Windows; off Windows `setup-view` skips itself).

- [ ] **Step 4: Commit**

`docs: attach stage 2 in CLAUDE.md, the install guide and the driving guide`

---

## Self-review

1. **Spec coverage.** §6.1 → Task 1; §6.2 and §6.3 → Tasks 8, 9, 10; §6.4 → Task 4; §6.5 (backup, plan, apply, verify, mark, carry set) → Tasks 5, 6, 7; §6.6 G-1, G-2 → Task 3, G-5 to G-9 are non-goals with their pane line in Task 8's `describeSetup`/pane words (G-5's paste block lives in the Models pane copy, Task 10); §6.7 → Task 10's badge; §6.8 version row → Tasks 2 and 8, uninstaller → Task 11; §8 channels → Tasks 7 and 9; §9 → Task 12; §10's test files each appear in a task.
2. **Step scan.** Every test step names its tests and assertions; every code step names the signature, file and spec values; bodies appear only for the NSIS macro's two calls.
3. **Type consistency.** `resolveLaunchMode`'s `{ host, why, degraded }` is what Task 9 reads as `launch.why`; `detectOldProfile`'s `{ found, schemaProblem }` is what Task 8's facts and Task 9 read; `verifyMigration`'s `{ ok, code, missing }` is what Task 7's `migrationApply` returns as `verified`; `describeSetup`'s action ids are the controller methods Task 9 exposes plus `skip`, `retry` and `openServiceSettings`, which the renderer maps as it maps the banner's today.
4. **Review Focus.** Each line names its task and test above.
5. **Proportion.** Twelve tasks, each a module or a seam, against a spec of fifteen sections; no task transcribes a function.
