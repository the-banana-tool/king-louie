# Personal Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `king-louie-service` run in the owner's own login session, as the owner, with the GUI backend in-process and no session helper, courier grant or identity record, installed by one unelevated command; and move one case from the desktop app to that node.

**Architecture:** A new `node.yaml` key `hosting: service | personal` is read by `run.js` before the identity and approval checks. Under `personal`, an owner check (the process owns the data dir and the config dir) replaces the fleet layout's account checks: the identity record is not required, the approver store skips its write probe, and `createGuiSubsystem` is handed an `InProcessChannel` that wraps the existing `createOpHandler` over the platform backend instead of a `HelperChannel`. A denied-directory list for the file tools covers the config dir and the desktop app's profile. `install --personal` writes the layout under `%LOCALAPPDATA%\KingLouie\node` and a logon task; `pair` writes `approvers.relay` and starts it; `import --from --case` filters the existing desktop importer to one case and its chats; a `moved` reason kind closes the desktop's copy.

**Tech Stack:** Node 22+, `node --test`, the existing `src/service`, `src/gui`, `src/session`, `src/migration`, `src/cases` modules. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-personal-node-design.md` (owner rulings R-PN-1 to R-PN-4 in §12, the author's calls C-1 to C-12 in §11).

## Global Constraints

- `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` enforces it.
- `node.yaml` rejects unknown keys: `hosting` joins `NODE_YAML_KEYS.top` in `src/service/node-config.js` and the exact list in `tests/node-config-strict.test.js` in the same task.
- `tests/service-profile-graph.test.js` keeps `src/session/` and `src/gui/` off the runbook, relay and front-door graphs. `src/gui/in-process-channel.js` is required only from `src/gui/index.js` (agent profile).
- `hosting: personal` is honoured by the `agent` profile only; `runbook` or `frontdoor` with it is `Invalid node.yaml: hosting: personal needs profile: agent`.
- No test creates a real logon task, touches the real `%LOCALAPPDATA%`, `%ProgramData%` or `%APPDATA%`, starts a real take, a real ffmpeg, a real Chrome or a real phone. `schtasks`, `whoami`, `reg`, the backend and the owner inspector are injected.
- The fleet layout (`hosting: service`, the default) changes behaviour nowhere. Every existing test keeps passing unchanged except the strict-keys list.
- The mobile apps, lease-v1, session-v1 and approval-v1 do not change; no vector changes.
- Spec §6: under `personal` the approver store keeps its owner read and drops only the write probe; the master key stays `LocalMachine` scope; `Bash` already goes to the phone (`requiresApproval: true`), so no policy row is added.
- Spec §8: `install --personal` refuses when elevated, refuses off Windows, refuses while a fleet node is installed, migrates nothing, asks for no secret, and starts the task only when `approvers.relay` is already set.
- Spec §9: `import --from <dir> --case <id>` copies one case directory (with `.git`) and the chats whose `caseId` is that case, nothing else; refuses `CASE_EXISTS`; verifies head and counts after the copy; writes no secret.
- Default data dir on Windows (C-11): `%ProgramData%\KingLouie\data` when it exists, else `%LOCALAPPDATA%\KingLouie\node\data` when it exists, else the first.
- Helper- and file-supplied text printed to a terminal goes through `shown` (`src/service/commands/io.js`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. A plugin hook refuses any shell command containing the words "credentials" or "secret"; name files by glob (`tests/gui-session-s*.test.js`) and keep those words out of commit messages.

## Review Focus

1. A personal node started outside the interactive session (a remote PowerShell, a task without `InteractiveToken`): the in-process backend probe reports no `gui.screenshot` / `gui.input` capability, the broker's `capability()` is false, a lease request is refused `capability_unavailable`, and `session status` says so. Pinned in Task 5.
2. `hosting: personal` written into a fleet layout (Administrators-owned dirs): the start is refused `PERSONAL_NOT_OWNER` naming both owners, before approvals or the GUI are built. Pinned in Tasks 2 and 8.
3. `install --personal` run a second time: `node.yaml` is kept and the lines it lacks are printed, the task is re-registered with `/F`, nothing is duplicated, and the exit code is 0. Pinned in Task 10.
4. `import --from --case` when the node already has that case directory, or when the desktop's `cases/<dir>` is not a git repository: refused before anything is written, `CASE_EXISTS` / `CASE_NOT_A_REPO`. Pinned in Task 13.
5. `pair` under `personal` when `node.yaml` already names a different relay: the new URL replaces it, the old one is printed, and the task is started once. Pinned in Task 11.

---

### Task 1: The `hosting` key

**Files:**
- Modify: `src/service/node-config.js` (NODE_YAML_KEYS at line 29, the parse at 198-307)
- Modify: `tests/node-config-strict.test.js:50-56`
- Test: `tests/node-config-hosting.test.js`

**Interfaces:**
- Produces: `loadNodeConfig(...)` returns `hosting: 'service' | 'personal'` (default `'service'`). `NODE_YAML_KEYS.top` ends with `'hosting'`. Error text for a wrong value: `Invalid node.yaml: hosting must be "service" or "personal"`; for the profile rule: `Invalid node.yaml: hosting: personal needs profile: agent`.

- [ ] **Step 1: Write the failing tests** in `tests/node-config-hosting.test.js`, using `withAdminDir` and `load` copied from `tests/node-config-strict.test.js:16-37`:

```js
describe('node.yaml hosting', () => {
  it('defaults to service', () => withAdminDir('name: n\nprofile: agent\n', (dir) => assert.equal(load(dir).hosting, 'service')));
  it('accepts personal on an agent node', () => withAdminDir('name: n\nprofile: agent\nhosting: personal\n', (dir) => assert.equal(load(dir).hosting, 'personal')));
  it('refuses any other value', () => withAdminDir('name: n\nprofile: agent\nhosting: laptop\n', (dir) => assert.throws(() => load(dir), /hosting must be "service" or "personal"/)));
  it('refuses personal on a runbook or frontdoor node', () => {
    withAdminDir('name: n\nprofile: runbook\nhosting: personal\n', (dir) => assert.throws(() => load(dir), /hosting: personal needs profile: agent/));
    withAdminDir('name: n\nprofile: frontdoor\nhosting: personal\n', (dir) => assert.throws(() => load(dir), /hosting: personal needs profile: agent/));
  });
  it('a missing node.yaml gives hosting service', () => assert.equal(loadNodeConfig({ adminConfigDir: emptyTempDir() }).hosting, 'service'));
});
```

- [ ] **Step 2: Run** `node --test tests/node-config-hosting.test.js` — FAIL (hosting undefined / unknown key).
- [ ] **Step 3: Implement.** Append `'hosting'` to `NODE_YAML_KEYS.top`; add `parseHosting(raw, invalid)` returning `'service'` for `undefined`, the value for the two strings, else `invalid('hosting must be "service" or "personal"')`; after the profile is known, `if (hosting === 'personal' && profile !== 'agent') throw invalid('hosting: personal needs profile: agent')`; include `hosting` in the returned object and in `defaultNodeConfig`.
- [ ] **Step 4: Update** `tests/node-config-strict.test.js` expected `top` list to end with `'hosting'`.
- [ ] **Step 5: Run** both test files — PASS. Also `node --test tests/examples.test.js` — PASS (examples carry no `hosting`).
- [ ] **Step 6: Commit** `feat(node-config): the hosting key (service | personal)`.

### Task 2: The owner check

**Files:**
- Create: `src/service/personal-host.js`
- Test: `tests/service-personal-host.test.js`

**Interfaces:**
- Produces: `checkPersonalOwner({ dataDir, configDir, platform = process.platform, inspectOwners, geteuid, statSync })` → `{ ok: boolean, me: string, owners: { dataDir: string|null, configDir: string|null }, problem: string|null }`. `assertPersonalOwner(options)` throws `Error` with `code: 'PERSONAL_NOT_OWNER'` and message `Refusing to start: hosting is personal but <path> is owned by <owner>, not this account (<me>)`; a path that is a link: `... <path> is a link`. On win32 `inspectOwners(paths)` is `inspectWindowsOwners` from `src/desktop-bridge/pairing.js` (returns `{ me, entries: [{ owner, link }] }`); on POSIX `me` is `String(geteuid())` and the owner is `String(statSync(p).uid)`, with `lstatSync` for the link test.

- [ ] **Step 1: Write the failing tests**:

```js
const inspect = (me, owners) => (paths) => ({ me, entries: paths.map((p) => ({ owner: owners[p], link: false })) });
it('passes when both dirs are owned by the process account (win32)', () => {
  const r = checkPersonalOwner({ dataDir: 'D:\\n\\data', configDir: 'D:\\n\\config', platform: 'win32', inspectOwners: inspect('S-1-5-21-1-2-3-1001', { 'D:\\n\\data': 'S-1-5-21-1-2-3-1001', 'D:\\n\\config': 'S-1-5-21-1-2-3-1001' }) });
  assert.deepEqual(r, { ok: true, me: 'S-1-5-21-1-2-3-1001', owners: { dataDir: 'S-1-5-21-1-2-3-1001', configDir: 'S-1-5-21-1-2-3-1001' }, problem: null });
});
it('refuses an Administrators-owned config dir (a fleet layout), naming both', () => {
  assert.throws(() => assertPersonalOwner({ ..., inspectOwners: inspect('S-1-5-21-1-2-3-1001', { data: 'S-1-5-21-1-2-3-1001', config: 'S-1-5-32-544' }) }),
    (e) => e.code === 'PERSONAL_NOT_OWNER' && /config is owned by S-1-5-32-544, not this account \(S-1-5-21-1-2-3-1001\)/.test(e.message));
});
it('refuses a link', ...);           // entries[i].link === true → "<path> is a link"
it('refuses when the owner cannot be read', ...); // owner null → problem names the path
it('POSIX: compares uids', () => { ... platform: 'linux', geteuid: () => 1000, statSync: () => ({ uid: 1000 }) ... ok: true });
```

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** the two functions as the Interfaces block says. `inspectOwners` default: `require('../desktop-bridge/pairing').inspectWindowsOwners` on win32 (require lazily inside the function).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(service): the personal-node owner check`.

### Task 3: The approver store under personal hosting

**Files:**
- Modify: `src/approvals/approver-store.js:63-86` (`checkApproverDir`), `:191-202` (constructor), `:275` (`_scan` reprobe), `:323-329` (`_checkTrust`)
- Test: `tests/approvals-approver-store.test.js` (add a `describe('hosting personal')`)

**Interfaces:**
- Produces: `new ApproverStore({ ..., hosting = 'service' })`. With `hosting: 'personal'` on win32 the write probe never runs (not at construction, not in `_scan`) and `_checkOwners()` still runs; `startApprovals` already spreads `approverStoreOptions` into the constructor (`service-wiring.js:195-202`), so Task 8 passes `approverStoreOptions: { hosting: 'personal' }`.

- [ ] **Step 1: Write the failing tests** (the file's `store(l, extra)` helper, `platform: 'win32'`, a `fsImpl` whose `openSync` records calls):

```js
it('personal: never opens a probe file, trusts a user-owned approvers dir under a user-owned config dir', async () => {
  const opens = []; const fsImpl = { ...fs, openSync: (p, f) => { opens.push([p, f]); return fs.openSync(p, f); } };
  const s = store(l, { platform: 'win32', hosting: 'personal', fsImpl, readOwners: () => ({ approvers: 'S-1-5-21-1-2-3-1001', config: 'S-1-5-21-1-2-3-1001' }) });
  await s.start(); await s.scan();
  assert.equal(opens.filter(([, f]) => f === 'wx').length, 0);
  assert.equal(s.trustProblem(), null);  // or whatever the store exposes today; the reviewer checks the name
});
it('personal: a config dir owned by LOCAL SERVICE is still refused', ...);   // readOwners config: 'S-1-5-19'
it('service (default): the probe still runs', ...);                          // opens has a 'wx' entry
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Constructor stores `this.hosting = hosting === 'personal' ? 'personal' : 'service'`. `checkApproverDir` gains `hosting = 'service'`; its win32 branch returns null before the probe when `!serviceProbe || hosting === 'personal'`. `_checkTrust`: `if (problem || this.platform !== 'win32') return problem; if (!this.serviceProbe && this.hosting !== 'personal') return problem; return this._checkOwners();`. `_scan`'s reprobe condition adds `&& this.hosting !== 'personal'`.
- [ ] **Step 4: Run** `node --test tests/approvals-approver-store.test.js` — PASS, including every existing test.
- [ ] **Step 5: Commit** `feat(approvals): the approver store skips the write probe under personal hosting`.

### Task 4: The session watch, shared by the helper and the in-process channel

**Files:**
- Create: `src/session/session-watch.js`
- Modify: `src/session/helper.js:102-107, 131-153`
- Test: `tests/session-watch.test.js`

**Interfaces:**
- Produces: `startSessionWatch(backend, { report, emit, recorder, log, reprobeMs = 60000, lockPollMs = 2000, timers = { setInterval, clearInterval } })` → `{ stop(), current() }`. `emit(kind, payload)` is called with `('probe_changed', nextReport)` when `capabilities` or `limits` changed (JSON compare, as `helper.js:135` does today), and `('locked' | 'unlocked', {})` on a change of `backend.locked()`. `current()` is the latest report (with `recorder` merged by `withRecorder`). `safeProbe` and `NO_BACKEND_REPORT` stay where they are; the module imports `safeProbe` from `helper.js` only if it is exported there, else moves it to `session-watch.js` and `helper.js` imports it back.

- [ ] **Step 1: Write the failing tests** with fake timers (`timers` injected; a `tick()` that runs the registered interval callbacks once):

```js
it('emits probe_changed only when capabilities or limits change, and carries recorder', async () => { ... emit calls === [['probe_changed', { ...next, recorder: { ffmpeg: 'C:\\f\\ffmpeg.exe' } }]] });
it('emits locked then unlocked on a change, nothing on null or no change', ...);
it('a backend without locked() emits nothing from the lock poll', ...);
it('stop() clears both intervals', ...);
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `session-watch.js`; replace `helper.js:131-153` with `const watch = startSessionWatch(backend, { report, recorder, log, emit: (k, p) => session.sendEvent(k, p), reprobeMs: deps.reprobeMs, lockPollMs: deps.lockPollMs })` and `watch.stop()` where the two `clearInterval`s were; keep `report = watch.current()` where the reconnect loop re-reads it.
- [ ] **Step 4: Run** `node --test tests/session-watch.test.js tests/session-helper*.test.js` — PASS (the helper's existing tests still see `probe_changed`, `locked`, `unlocked`).
- [ ] **Step 5: Commit** `refactor(session): the probe and lock polls as one session watch`.

### Task 5: `InProcessChannel`

**Files:**
- Create: `src/gui/in-process-channel.js`
- Test: `tests/gui-in-process-channel.test.js`

**Interfaces:**
- Consumes: Task 4's `startSessionWatch`; `createOpHandler` (`src/session/connection.js:25`); `selectBackend`/`loadBackend` (`src/session/backends/index.js`); `findFfmpeg` (`src/session/recorder.js:16`); `sanitizeProbe`, `OP_TIMEOUTS` (`src/gui/helper-channel.js`); `GuiError` (`src/gui/errors.js`).
- Produces: `class InProcessChannel extends EventEmitter` with the broker's surface (`broker.js` uses `on/off`, `connected`, `info`, `request`): `constructor({ backend, platform = process.platform, env = process.env, recorder = null, log, timers, reprobeMs, lockPollMs, clock = Date.now })`; `async start()` probes once, sets `connected = true`, sets `info = { user: os.userInfo().username, platform, pid: process.pid, ...sanitizeProbe(report), since: clock() }`, emits `'ready'` with `info`, starts the watch, and re-emits its events as `'event'` with `(kind, payload)` as `HelperChannel` does (read `helper-channel.js:257-306` for the exact emit shape; `probe_changed` also updates `info`); `async request(op, params = {}, { timeoutMs } = {})` → the handler's result, raced against `timeoutMs ?? OP_TIMEOUTS[op] ?? 10000` with `GuiError('op_timeout', op)`; before `start()` or after `stop()` it throws `GuiError('helper_disconnected')`; `stop()` stops the watch, sets `connected = false`, never emits `'closed'`. `buildInProcessChannel({ platform, env, log })` picks the backend with `selectBackend`/`loadBackend`, `recorder = { ffmpeg: findFfmpeg({ platform, env }) }`, and returns a channel (a null backend gives a channel whose probe is `NO_BACKEND_REPORT(...)` and whose `request` throws `capability_unavailable`, as the op handler does).

- [ ] **Step 1: Write the failing tests** with a fake backend `{ probe: async () => ({ capabilities: [...], probes: [], displays: [], limits: [], locked: false }), screenshot: async () => ({ ... }), locked: async () => false, launchBrowser: ... }`:

```js
it('start() probes, sets info in the helper shape (recorder.ffmpeg included) and emits ready', ...);
it('request(op) calls the op handler and resolves; an unknown op is GuiError unknown_op', ...);
it('request honours timeoutMs with op_timeout', async () => { ... backend.screenshot hangs; request('screenshot', {}, { timeoutMs: 20 }) rejects code 'op_timeout' });
it('request before start is helper_disconnected; it never emits closed', ...);
it('a watch event arrives as "event" (kind, payload) and probe_changed updates info', ...);
it('Review Focus 1: a backend whose probe has no gui.screenshot leaves capabilities without it; a GuiBroker over this channel reports capability() false', async () => { /* new GuiBroker({ channel, guiConfig }) as tests/gui-broker.test.js builds one */ });
it('buildInProcessChannel with selectBackend → null gives a channel whose request is capability_unavailable', ...);
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the class and the builder (lazy `require` of the backends inside `buildInProcessChannel`, so loading the module loads no backend).
- [ ] **Step 4: Run** `node --test tests/gui-in-process-channel.test.js tests/service-profile-graph.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(gui): an in-process channel over the session backend`.

### Task 6: The GUI subsystem under personal hosting; `hosting` in status.json

**Files:**
- Modify: `src/gui/index.js:36-60` (`unavailableSubsystem`), `:109-193` (`buildGuiSubsystem`)
- Modify: `src/gui/broker.js:184-199` (`_writeStatus`)
- Modify: `src/gui/status.js` if the record shape is validated there
- Test: `tests/gui-subsystem.test.js` (new `describe('hosting personal')`), `tests/gui-broker.test.js` (one assertion)

**Interfaces:**
- Consumes: Task 5's `InProcessChannel`, `buildInProcessChannel`.
- Produces: `createGuiSubsystem({ ..., hosting = 'service', deps: { channel? } })`. Under `hosting: 'personal'`: no helper file is read, no node-id comparison, the identity record is not consulted (`identityRecord` may be `{ state: 'personal' }` or absent), `identityProbe` is null, the channel is `deps.channel || buildInProcessChannel({ platform, env, log })`, and the rest (broker, leases, live view, takes, relay methods, `registerTools`) is built as today. `GuiBroker` takes `hosting` and writes it as `hosting` in the status record; `unavailableSubsystem` takes `hosting` and writes it too. Fleet behaviour unchanged when `hosting` is absent or `'service'`.

- [ ] **Step 1: Write the failing tests** (the file's `createGui` and fixtures; a `FakeChannel` as in `tests/gui-broker.test.js:33-42`):

```js
describe('hosting personal', () => {
  it('builds with no helper file and no identity record, over deps.channel', async () => {
    const gui = createGui({ nodeConfig: on, dataDir, configDir, cipher, approvals, hosting: 'personal', deps: { channel: fake } });
    assert.equal(gui.unavailable, null); assert.equal(gui.channel, fake); assert.ok(gui.leases && gui.takes);
  });
  it('writes hosting: personal into status.json', async () => { await gui.start(); fake.connect(info); assert.equal(readGuiStatusRecord({ dataDir }).hosting, 'personal'); });
  it('passes no identityProbe to the lease manager', ...);   // gui.leases.identityProbe === null, or whatever the manager exposes
  it('gui disabled under personal is still null', ...);
  it('fleet (no hosting) still needs the helper file: null without it', ...);   // the existing behaviour, asserted beside the new
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `buildGuiSubsystem`: after the `enabled`/profile check, `if (hosting === 'personal') { channel = deps.channel || buildInProcessChannel({ platform, env: process.env, log }); identityProbe = null; } else { ...today's helper-file and identity-record code... }`; pass `hosting` to `GuiBroker` and to `unavailableSubsystem` in `createGuiSubsystem`'s catch. `_writeStatus` adds `hosting: this.hosting`.
- [ ] **Step 4: Run** `node --test tests/gui-subsystem.test.js tests/gui-broker.test.js tests/gui-status*.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(gui): the subsystem runs over the in-process channel under personal hosting`.

### Task 7: Denied directories for the file tools

**Files:**
- Modify: `src/tools/utils.js:151` (beside `registerSecretDataDir`), `:237-290` (`isProtectedSecretPath`, `isPathAllowed`, `describePathDenial`)
- Modify: `src/core/create-core.js:161-176` (register from `deps`/options)
- Test: `tests/tools-denied-dirs.test.js`

**Interfaces:**
- Produces: `registerDeniedDir(dir)` (absolute; realpath-resolved when it exists, as `registerSecretDataDir` does), `clearDeniedDirs()` (tests), `isDeniedPath(targetPath)` → true when the resolved target equals or is under a denied dir (prefix with a path separator, case-insensitive on win32). `isPathAllowed` returns false and `describePathDenial` returns `"<path> is inside a directory King Louie's tools may not touch on this node"` for such a path, before the secret-file check. `createCore(deps)` reads `deps.deniedDirs` (array) and registers each at the point `create-core.js:161` registers the data dir. The six file tools need no change: they already call `isPathAllowed`/`describePathDenial`.

- [ ] **Step 1: Write the failing tests**:

```js
it('a path under a denied dir is refused for read, write, glob and grep', async () => { registerDeniedDir(cfg); assert.equal(isPathAllowed(path.join(cfg, 'node.yaml')), false); assert.match(describePathDenial(path.join(cfg, 'approvers', 'a.json')), /may not touch on this node/); /* then one real Read tool call and one Write tool call through the registry, refused */ });
it('the denied dir itself is refused; a sibling with the same prefix is not', () => { registerDeniedDir('D:\\x\\config'); assert.equal(isDeniedPath('D:\\x\\config'), true); assert.equal(isDeniedPath('D:\\x\\config2\\f'), false); assert.equal(isDeniedPath('d:\\X\\CONFIG\\node.yaml'), true); });
it('a link into a denied dir is refused (realpath)', ...);   // temp dir + a junction/symlink where the platform allows; skip otherwise
it('createCore({ deniedDirs }) registers them', ...);
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The dir itself is denied (listing `approvers\` is a read of it).
- [ ] **Step 4: Run** `node --test tests/tools-denied-dirs.test.js tests/tools-*.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(tools): denied directories for the file tools`.

### Task 8: `run.js` under personal hosting

**Files:**
- Modify: `src/service/run.js:61-71` (`checkRecordedIdentity`), `:101-245` (agent start), `:387-430` (`runService` logs)
- Test: `tests/service-run-personal.test.js`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 6, 7.
- Produces: in the agent profile, after `loadNodeConfig`: `const hosting = nodeConfig.hosting;` then, when `personal`: `assertPersonalOwner({ dataDir, configDir: cfgDir, ...(deps.personalOwner || {}) })` (its throw stops the bridge and rethrows, as the identity check does); `checkRecordedIdentity(...)` gains `hosting` and under `personal` skips `assertRecordedIdentity`, returning `{ identity, record: { state: 'personal', file: null, problem: null, recorded: null } }`; `startApprovals({ ..., approverStoreOptions: { ...adminDirApprovalOptions(...).approverStoreOptions, hosting } })`; `createGuiSubsystem({ ..., hosting, deps: { ...deps.gui } })`; `createCore({ ..., deniedDirs: hosting === 'personal' ? [cfgDir, desktopProfileDir({ platform, env })] : [] })` where `desktopProfileDir` is a new export of `src/platform/paths.js`: win32 `path.join(env.APPDATA, 'king-louie')`, darwin `~/Library/Application Support/king-louie`, else `~/.config/king-louie`; `log.info('hosting: personal (runs as <user>; the owner account is the trust boundary)')` once, with `os.userInfo().username`. `runService` passes `deps` through to `start` (it does not today: add `deps = {}` to its options and the call).

- [ ] **Step 1: Write the failing tests**, modelled on `tests/service-run.test.js:164-240` (`loadProfile('agent').start({...})` on a temp data dir with `features` all off, `deps` injected):

```js
it('personal: starts with no identity record and no helper file; the GUI is on over the injected channel; status.json says hosting personal', async () => {
  writeNodeYaml(configDir, 'name: n\nprofile: agent\nhosting: personal\ngui:\n  enabled: true\n  apps:\n    chrome: C:\\x\\chrome.exe\n');
  const running = await loadProfile('agent').start({ dataDir, configDir, features: OFF, ports, workspace, audit: {}, deps: { personalOwner: { inspectOwners: inspect(ME, { [dataDir]: ME, [configDir]: ME }) }, gui: { channel: fake } } });
  assert.equal(running.gui.unavailable, null);
  assert.equal(readGuiStatusRecord({ dataDir }).hosting, 'personal');
  await running.stop();
});
it('Review Focus 2: personal on dirs another account owns refuses PERSONAL_NOT_OWNER before approvals', ...);
it('personal registers the config dir and the desktop profile as denied dirs', ...);   // isDeniedPath(path.join(configDir, 'node.yaml')) after start
it('service (default): an identity record is still required when gui is enabled; nothing changed', ...);  // reuse an existing assertion shape from tests/gui-subsystem.test.js 'host wiring'
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** as the Interfaces block says.
- [ ] **Step 4: Run** `node --test tests/service-run-personal.test.js tests/service-run.test.js tests/gui-subsystem.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(service): the agent profile under personal hosting`.

### Task 9: The default data dir falls back to the personal node's

**Files:**
- Modify: `src/platform/paths.js:7-8` (`defaultServiceDataDir`), new `personalDataDir`
- Modify: `src/service/cli.js:283` (pass nothing new; the default does it)
- Test: `tests/platform-paths.test.js` (create if absent)

**Interfaces:**
- Produces: `personalDataDir({ platform = process.platform, env = process.env })` → win32 `path.win32.join(env.LOCALAPPDATA, 'KingLouie', 'node', 'data')`; darwin `~/Library/Application Support/KingLouie/node/data`; else `~/.local/share/king-louie/node/data`. `defaultServiceDataDir({ platform, env, exists = fs.existsSync })` on win32: fleet path when `exists(fleet)`, else personal when `exists(personal)`, else fleet. Other platforms unchanged (C-6).

- [ ] **Step 1: Write the failing tests**:

```js
it('win32: the fleet dir when it exists', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: (p) => p === 'C:\\ProgramData\\KingLouie\\data' }), 'C:\\ProgramData\\KingLouie\\data'));
it('win32: the personal dir when only it exists', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\U\\a\\AppData\\Local' }, exists: (p) => p.endsWith('node\\data') }), 'C:\\U\\a\\AppData\\Local\\KingLouie\\node\\data'));
it('win32: the fleet dir when neither exists', ...);
it('linux is unchanged', ...);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Keep the module-load seed in `src/tools/utils.js` working (`defaultServiceDataDir()` with no args still returns a path). **Step 4: Run** `node --test tests/platform-paths.test.js tests/service-cli*.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(paths): the CLI finds a personal node's data dir`.

### Task 10: `install --personal` and `uninstall --personal`

**Files:**
- Create: `src/service/personal-install.js`
- Modify: `src/service/cli.js:57-63` (flags, `YES_COMMANDS`), `:450-454` (dispatch), the help text at the top
- Modify: `src/service/installers.js:953-960` (`runInstallCommand` hands `--personal` to the new module)
- Test: `tests/service-cli-install-personal.test.js`

**Interfaces:**
- Consumes: Task 9's `personalDataDir`; `renderLogonTaskXml`'s shape (`src/session/autostart.js:28`), `windowsSchtasksExe`/`windowsPowerShellExe` (`src/platform/windows-paths.js`); `isAdmin` (`src/service/commands/admin-check.js:13`); `findFfmpeg`; `readLine`/`shown` (`commands/io.js`).
- Produces: `runPersonalInstall({ command: 'install' | 'uninstall', flags: { dataDir?, browser?, provider?, model?, yes?, dryRun? }, io, deps = {} })` → exit code. `deps`: `platform`, `env`, `isAdmin`, `isTTY`, `confirm`, `whoAmI` (→ `{ user, sid }`, default from `whoami /user /fo csv` by absolute path), `findChrome` (→ path|null, default `reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve` then the HKCU key), `findFfmpeg`, `fleetInstalled` (→ `{ task: boolean, configDir: string|null }`, default `schtasks /Query /TN KingLouie` exit 0, or `%ProgramData%\KingLouie\config\identity\node.json` or `...\session\helper-secret.json` exists), `execute(steps)` (default `executeSteps`), `relaySet` (reads `node.yaml` `approvers.relay`), `nodePath`, `entryPath`. `renderPersonalTaskXml({ sid, nodePath, entryPath, dataDir, env })` → the `autostart.js` XML with task name `KingLouie Node`, description `King Louie personal node`, arguments `run --data-dir <dataDir>`. `PERSONAL_TASK_NAME = 'KingLouie Node'`. The written `node.yaml` text:

```yaml
name: <hostname>
profile: agent
hosting: personal
gui:
  enabled: true
  apps:
    chrome: '<chrome path>'
  take:
    enabled: true
    max_minutes: 240
  browser: chrome
delegate:            # only when --provider/--model were given
  provider: <p>
  model: <m>
```

  Refusals (exit 2, one line each on stderr): elevated (`install --personal runs as you, not elevated: open a normal prompt`); platform not win32 (`install --personal is Windows-only for now`); fleet installed (`a fleet node is installed on this machine (<what>); run uninstall / session uninstall first`); no Chrome (`no chrome.exe found; pass --browser <path>`); off a TTY without `--yes`. The consent text prints, in order: the account (`<user> (<sid>)` through `shown`), the data dir, the config dir, the task name, `the service will run as this account; the owner account is the trust boundary: anything running as you can drive it as a local mcp client and change its approver set, and a shell the phone approves can do anything you can`, then the files it will write. Step 5's "what is left" lines: `token set <provider>`, `pair wss://<relay>`, `enroll-device`, `vault set browser_cred:<profile>:<host>`, and the `mcp` line. `uninstall --personal`: `schtasks /End` + `/Delete /F` for `KingLouie Node`, prints that the data dir stays.

- [ ] **Step 1: Write the failing tests** with the `tests/service-cli-session.test.js` harness style (`io()`, injected deps, `execute: async (steps) => executed.push(steps)`, temp `LOCALAPPDATA` in `env`):

```js
it('refuses elevated, off Windows, with a fleet node installed, and with no chrome', ...);   // four calls, exit 2, messages as above, executed.length === 0
it('dry run prints the consent text and the node.yaml and writes nothing', ...);
it('first run: writes node.yaml and the config dir, registers the task, does not start it (no relay yet), prints the five remaining steps', async () => { ... assert.match(yaml, /^hosting: personal$/m); assert.ok(executed.flat().some((s) => s.argv.includes('/Create') && s.argv.includes('KingLouie Node'))); assert.ok(!executed.flat().some((s) => s.argv.includes('/Run'))); ... });
it('Review Focus 3: a second run keeps node.yaml, prints the lines it lacks, re-registers with /F, exit 0', ...);
it('with approvers.relay already set, the task is started', ...);
it('--provider and --model write the delegate block', ...);
it('renderPersonalTaskXml: LogonTrigger for the SID, InteractiveToken, LeastPrivilege, run --data-dir', ...);
it('uninstall --personal ends and deletes the task and says the data dir stays', ...);
it('off a TTY without --yes: exit 2 before anything is read', ...);
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `cli.js`: `BOOLEAN_FLAGS` += `personal`; `VALUE_FLAGS` += `browser`, `provider`, `model`, `case`; `YES_COMMANDS` += `['install']`, `['uninstall']`, `['import']`; dispatch: `if (flags.personal) return runPersonalInstall({ command, flags: { ...flags, dataDir: flags.dataDir || personalDataDir() }, io })` (note: `--personal` ignores the ProgramData default). Help text gains the two forms and the flags (the docs test reads it).
- [ ] **Step 4: Run** `node --test tests/service-cli-install-personal.test.js tests/service-cli.test.js tests/service-installers.test.js tests/docs-driving.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(cli): install --personal and uninstall --personal`.

### Task 11: `pair` writes the relay and starts the node under personal hosting

**Files:**
- Modify: `src/service/commands/pair.js:20-60, 142-148`
- Create: `src/service/node-yaml-edit.js`
- Test: `tests/service-cli-pair-personal.test.js`

**Interfaces:**
- Produces: `setNodeYamlRelay(file, url)` in `node-yaml-edit.js`: reads the file, replaces an existing `approvers:` block's `relay:` line or appends `approvers:\n  relay: <url>\n`, by text (never a re-serialisation: comments and order are kept), refuses a `url` that is not one plain line, writes atomically (`.new` + rename), returns `{ previous: string|null }`. `runPair` gains `deps.startNode` (default: `schtasks /Run /TN "KingLouie Node"` by absolute path, only when `schtasks /Query` finds it) and after the success lines, when `nodeCfg.hosting === 'personal'`: `setNodeYamlRelay`, print `approvers.relay set to <url> in <file>` (and `(was <previous>)` when it differed), then `startNode()` and print `Started KingLouie Node` or `The logon task is not registered; run install --personal` (exit still 0). Under `service` the existing "Next: set ..." line stays.

- [ ] **Step 1: Write the failing tests** (reuse the fake relay from `tests/service-cli-relay.test.js` or stub the pairing through `deps`):

```js
it('personal: writes approvers.relay, keeps the rest of node.yaml byte for byte, starts the task once', ...);
it('Review Focus 5: a different relay already set is replaced and the old one printed', ...);
it('service: prints the Next line and writes nothing (unchanged)', ...);
it('setNodeYamlRelay refuses a url with a newline', ...);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `node --test tests/service-cli-pair-personal.test.js tests/service-cli-relay.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(cli): pair writes approvers.relay and starts a personal node`.

### Task 12: The `moved` reason and the desktop's "Moved elsewhere" action

**Files:**
- Modify: `src/cases/status.js:6, 14-24`
- Modify: `src/ipc/case-handlers.js` (the `case:setStatus` handler)
- Modify: `renderer.js:2683-2688` (`CASE_STATUS_ACTIONS`) and where an action's status is sent
- Test: `tests/cases-status.test.js`, `tests/ipc-case-status*.test.js` (or the file that covers `case:setStatus` today)

**Interfaces:**
- Produces: `REASON_KINDS` gains `'moved'`; the two rows to `abandoned` accept kinds `['owner', 'moved']`; `moved` is valid for no other transition. `case:setStatus` accepts `{ caseId, status, kind?, note? }` where `kind` may only be `'moved'` and only with `status: 'abandoned'` (anything else is `BAD_KIND`); the handler passes `{ kind: 'moved', by: 'owner', note }` to `setStatus`; without `kind` it behaves as today. Renderer: a fifth action `{ status: 'abandoned', kind: 'moved', label: 'Moved elsewhere', from: ['draft', 'active', 'needs-direction', 'paused'], confirm: 'Mark this case as moved to another King Louie? It becomes read-only here and its wake-ups stop.' }`, and the click sends `kind` when the action has one. The status reason shown in the panel reads `moved` as "Moved to another King Louie".

- [ ] **Step 1: Write the failing tests**: `canTransition('active', 'abandoned', 'moved') === true`, `canTransition('active', 'paused', 'moved') === false`; `runtime.setStatus(id, 'abandoned', { kind: 'moved', by: 'owner', note: 'moved to laptop node' })` records `statusReason.kind === 'moved'` and the case is read-only after; the IPC refuses `kind: 'owner'` from the renderer and `kind: 'moved'` with `status: 'paused'`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `node --test tests/cases-status.test.js tests/cases-abandoned.test.js tests/ipc-case*.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(cases): the moved reason for a case closed because it went to another King Louie`.

### Task 13: `import --from <desktop> --case <id>`

**Files:**
- Modify: `src/service/commands/import.js:98-215`
- Create: `src/migration/case-filter.js`
- Test: `tests/service-cli-import-case.test.js`

**Interfaces:**
- Consumes: `readDesktopSource` (`desktop-source.js:167`: `{ installId, inventory, attention, getValue, caseFiles }`), `DesktopImporter#plan` items `{ category, key, action, note, targetKey }`, `runGitSync` (`src/cases/git.js:789`), `loadNodeConfig` (for `hosting`).
- Produces: `filterInventoryToCase({ inventory, getValue, caseRef })` in `case-filter.js` → `{ inventory: { chats, cases: [one] , ...every other inventory list emptied }, caseId, caseDir, chatIds }`; `caseRef` matches a case directory name or the `id` in that directory's `case.yaml` (read through `getValue('caseFile', ...)`/`caseFiles(dir)`, whichever the source exposes; the implementer reads `desktop-source.js:242-266`); a chat is in when `getValue('chat', id).caseId === caseId`; no match throws `code: 'CASE_NOT_FOUND'`. In `runImportCommand`: when `flags.case` is set: the `isAdmin` check is skipped when `loadNodeConfig({ dataDir }).hosting === 'personal'` (kept otherwise); the node must be stopped (`runningServicePid`, as today); `path.join(dataDir, 'cases', caseDir)` existing is `CASE_EXISTS` (exit 2, nothing written); the source dir without `.git/HEAD` is `CASE_NOT_A_REPO`; the plan is built from the filtered inventory; before `apply` it prints `Will copy case <title> (<id>, <status>): <n> chats, <m> messages, head <sha>` and asks `[y/N]` (`--yes` off a TTY; `--dry-run` stops here); after `finish` it runs `runGitSync(target, ['rev-parse', 'HEAD'])` and `['status', '--porcelain']` and counts the target's chats with that `caseId` through the history store opened read-only (`HistoryStore.open(file, { readonly: true })`), prints `node: head <sha>, clean, <n> chats / <m> messages` beside the source's numbers, exits 1 with `VERIFY_MISMATCH` when they differ (the copy stays; the message says what differed), and on success prints the desktop step: `In the desktop app, open the case and choose "Moved elsewhere" so it is worked in one place.`

- [ ] **Step 1: Write the failing tests** with `userData()` from `tests/desktop-import-source.test.js:39` (its `cases/lakeside-lot` made a real git repo with one commit in the test's setup) and a seeded data dir with a master key (`keyedDataDir()` there):

```js
it('copies one case and its chats only; other chats and settings are not planned', async () => { ... plan items: exactly one category 'case' (key 'lakeside-lot') and the chats whose caseId matches; no 'settings', 'memory', 'cron' items ... });
it('accepts the case id as well as the directory name', ...);
it('Review Focus 4: CASE_EXISTS when the node has the directory; CASE_NOT_A_REPO when the source has no .git/HEAD; nothing written either way', ...);
it('verifies head and counts after the copy and prints the desktop step', ...);
it('dry run prints the summary and writes nothing', ...);
it('under hosting service the elevation check still applies', ...);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `node --test tests/service-cli-import-case.test.js tests/service-cli-import*.test.js tests/desktop-import*.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(cli): import --from --case moves one case to the node`.

### Task 14: `doctor`, `session status`, `identity record` and `session install` know about hosting

**Files:**
- Modify: `src/service/doctor.js:59-100, 144-217` 
- Modify: `src/service/commands/session.js:317-330` (install guard), `:655-683` (status)
- Modify: `src/service/commands/identity.js` (record guard)
- Test: `tests/service-doctor*.test.js`, `tests/service-cli-session.test.js`, `tests/service-cli-identity*.test.js`

**Interfaces:**
- Produces: `doctor` adds a row right after `node configuration loaded`: `{ check: 'hosting', ok: true, detail: 'service' }` or, for personal, `detail: 'personal (runs as <user>; the owner account is the trust boundary); task KingLouie Node: <Ready|Running|not registered>'` with `ok: false` when the owner check fails (its `problem` as detail; `deps.personalOwner` injected as in Task 8) and `warn: true` when the task is not registered. Under personal the identity-record rows read `recorded identity: not used on a personal node` (ok), and the session-helper rows read `session helper: not used on a personal node (the GUI runs in-process)` (ok); the approvals rows are unchanged. `session status` under personal prints `hosting: personal` first and the install line as `helper: not used on a personal node; the GUI runs in the service`, then the capabilities, limits, probes and lease lines from `status.json` as today. `session install`/`uninstall` under personal: `a personal node has no session helper; nothing to install` (exit 2 for install, 0 for uninstall with nothing removed). `identity record` under personal: `a personal node records no identity; the owner account is the trust boundary` (exit 0, nothing written; `identity show` unchanged).

- [ ] **Step 1: Write the failing tests** in the three existing files (temp data dirs with a personal `node.yaml`; `deps.personalOwner` and a `deps.queryTask` for the schtasks read).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the three files — PASS.
- [ ] **Step 4b: Confirm the device commands run unelevated (spec §6, last row).** Read `src/service/commands/devices.js` (`runEnrollDevice`, `device apply`, `device revoke`) and `src/service/commands/pair.js` for any check that keys on elevation or `isRoot()` beyond file access on Windows. The seam report found none (`devices.js:85` uses `isRoot()` only to choose a child process). If one exists, lift it under `hosting: personal` with a test in `tests/service-cli-devices.test.js`; if none, add one test there that `enroll-device` on a personal data dir with the node running (`deps.runningServicePid`) reaches the relay step without an elevation refusal, and note "none found" in the task report.
- [ ] **Step 5: Commit** `feat(cli): doctor, session status, identity record and session install under personal hosting`.

### Task 15: Documentation and the example

**Files:**
- Create: `examples/personal/node.yaml` (invented values: `name: laptop`, chrome under `C:\Program Files\...`, `approvers.relay: wss://relay.example.com:8443`)
- Modify: `tests/examples.test.js:263-330` (load `examples/personal/node.yaml` through `loadNodeConfig` and the top-key check)
- Modify: `docs/install-guide.md` (a "Personal node (your own machine)" section), `docs/driving-king-louie.md` §2 (the `hosting: personal` line and the `install --personal` flow ahead of the fleet flow), `CLAUDE.md` (a "Personal node" section after "Demo takes (D1)")
- Modify: `tests/docs-driving.test.js:88-98` (the §2 yaml block with `hosting` still passes `parseGuiConfig`; every new `king-louie-service` form in the doc is in `help`)

- [ ] **Step 1: Write the example and extend `tests/examples.test.js`**; run it — FAIL until the example exists, then PASS.
- [ ] **Step 2: Write the docs.** Install guide: when to choose it, the one command, what it does, the consent text's meaning, `pair`/`enroll-device`/`token set`/`vault set`, `import --from --case` and the "Moved elsewhere" step, `uninstall --personal`, the reboot residual, the shell-and-deny residual. Driver's guide §2: the personal flow first, the fleet flow kept. CLAUDE.md: the key, the owner check, the in-process channel, the denied dirs, the CLI forms, what tests inject, the residuals.
- [ ] **Step 3: Run** `node --test tests/docs-driving.test.js tests/examples.test.js` — PASS.
- [ ] **Step 4: Run the whole suite once** `npm test` — `# fail 0`.
- [ ] **Step 5: Commit** `docs: the personal node`.
