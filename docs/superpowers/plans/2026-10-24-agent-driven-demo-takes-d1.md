# Agent-driven demo takes (D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session on the owner's desktop records a screen demo through King Louie with one phone tap: a `take` lease that runs unattended and never pauses, a browser and a recorder launched on the owner's screen by the session helper, deterministic steps with the model supervising, and a driver that waits on the turn instead of polling the DOM.

**Architecture:** The core stays in the service (`LOCAL SERVICE`, Session 0). A new lease kind `take` (lease-v1 revised) is the one approval; a `TakePolicy` on the run turns phone prompts into instant refusals inside what was approved; the session helper gains `launch_browser`, `record_start`, `record_stop` and `keep_awake` ops, and Playwright attaches to the helper's Chrome over CDP through a per-run browser registry. A `Take` tool and a `TakeManager` own the lifecycle; `king-louie-service mcp` gains `wait_ms` and a `take` summary.

**Tech Stack:** Node 24 (`node:test`), Playwright (`connectOverCDP`), ffmpeg (gdigrab) as a child process, PowerShell worker (`windows-worker.ps1`) for P/Invoke, Swift and Kotlin phone cores (source-pinned by tests, not compiled here).

**Spec:** `docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md` (read it first; section numbers below are its sections).

## Global Constraints

- `src/` stays Electron-free except `src/ipc/` (`tests/electron-boundary.test.js`); nothing here touches `src/ipc/`.
- No new model call anywhere in this plan, so `tests/egress-inventory.test.js` must stay green without a new entry.
- Every protocol object has exactly the keys shown (`exactKeys`); a new field means the validator, both phone cores, the vectors and `docs/protocol/*.md` change in the same task.
- `kind: "take"` caps `max_minutes` at `gui.take.max_minutes` (1 to 240, default 240); `kind: "computer_use"` keeps `MAX_MINUTES = 60` and `gui.lease.max_minutes`. Spec C-1.
- A take grant can be asked for only from a local origin (`origin.kind` in `LOCAL_ORIGIN_KINDS = ['stdio', 'service-chat']`, or no origin); refusal code `take_requires_local_origin`. Spec C-2.
- An unattended lease never calls `suspend()`; `_armContact` is never armed for it. Spec R-D1-7, §6.3.
- `release_all` keeps its meaning; browsers and recordings end only with the take. Spec §8, §9.
- Shell is never inside a take (`take_tool_not_allowed`); `fill_payment`, `evaluate`, `evaluate_in_frame`, `route_*`, `unroute`, cookies, storage state, `pdf`, `set_input_files` are never inside a take (`take_action_not_allowed`); credential actions need `credentials: true`. Spec §7.1.
- Take refusals are tool results `{ success: false, error, code, allowed? }`, never an approval request. Spec §7.2.
- Recordings and take profiles live under the session user's `%LOCALAPPDATA%\KingLouie\` (`recordings\<take_id>\`, `browser-profiles\<name>\`); the helper refuses a profile dir outside that root. Spec C-4, §8.
- Error sentences are one plain line, name no path the driver did not give, and every code named in the spec is used verbatim.
- Example values in `examples/` and `docs/` pass `scanForPersonalValues` (`tests/helpers/example-denylist.js`): `example.com` hosts, `C:\KingLouie\...` and `C:\ProgramData\KingLouie\...` paths, no user names.
- Tests never launch a real user session, never inject input, never touch the real config or data dir; the one e2e is behind `KL_E2E_TAKE=1`.
- Commits: one per task, message in the house style (`feat(gui): ...`, `feat(fleet): ...`, `docs: ...`), ending with the attribution line the session carries.

## Review Focus

Inputs the spec implies but that no task's tests would otherwise exercise, most likely to bite first. Each line's test is added to the owning task below.

1. **A page leaves the allowed sites by itself** (an SSO redirect to `accounts.example.net`, a link the model clicked). Expected: acting actions refuse `take_site_not_allowed`, look-only actions and `navigate` back still run, nothing is sent to the phone. Task 6.
2. **The recorder dies mid-take** (ffmpeg exits with a code, the disk fills). Expected: the take ends `recorder_failed`, the lease is released, the file is kept and named in the result. Task 12.
3. **Chrome hands off to a running instance and exits** (the named profile is already open), so `DevToolsActivePort` never appears. Expected: `browser_launch_failed` within 10 s, the lease released, the recorder never started. Tasks 9 and 12.
4. **The phone denies, or the request expires** before anything launched. Expected: `Take.start` returns the lease's reason, no browser, no recorder, no `keep_awake`. Task 12.
5. **A second take while one is live** (another delegate session, or the owner's own chat). Expected: `take_busy` naming the live take by name only; the default browser of the owner's chat is untouched. Tasks 8 and 12.

---

## Part A: the driver can start today

### Task 1: Driver's guide and MCP example

**Files:**
- Create: `docs/driving-king-louie.md`
- Create: `examples/mcp/claude-code.windows.json`
- Modify: `tests/examples.test.js` (the `'finds nothing personal in examples/ or the install guide'` test, ~line 126, and `describe('MCP client configs')`, ~line 933)
- Create: `tests/docs-driving.test.js`

**Interfaces:**
- Produces: the guide's section names, which later tasks append to: `## 1. What King Louie offers a driver`, `## 2. Setting up the desktop`, `## 3. Driving a session`, `## 4. Recording a take` (a stub in this task: "arrives with D1 part D"), `## 5. What refuses, and why`.

- [ ] **Step 1: Write the failing tests**

In `tests/docs-driving.test.js`, modelled on `tests/docs-front-door.test.js`:

```js
const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'driving-king-louie.md'), 'utf8');
it('has the five sections in order', () => {
  const heads = guide.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.replace(/^## \d+\. /, ''));
  assert.deepEqual(heads, ['What King Louie offers a driver', 'Setting up the desktop', 'Driving a session', 'Recording a take', 'What refuses, and why']);
});
it('names only real service commands', () => { /* every `king-louie-service <word>` in the guide is in main(['help'])'s output, as docs-front-door.test.js does */ });
it('names only real MCP tools', () => { /* every backticked snake_case word that is also a key of MCP_TOOLS-by-name or one of get_job/get_job_logs/... exists in MCP_TOOLS */ });
```

In `tests/examples.test.js`: add `docs/driving-king-louie.md` to the files the personal-values scan reads, and in `describe('MCP client configs')` add a case asserting `examples/mcp/claude-code.windows.json` parses, has `mcpServers['king-louie'].command` ending `node.exe` and `args` equal to `["C:\\KingLouie\\app\\bin\\king-louie-service.js", "mcp", "--data-dir", "C:\\ProgramData\\KingLouie\\data"]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/docs-driving.test.js tests/examples.test.js`
Expected: FAIL, the guide and the example do not exist.

- [ ] **Step 3: Write the example and the guide**

`examples/mcp/claude-code.windows.json`: the block in spec §11, `command` `C:\\Program Files\\nodejs\\node.exe`.

`docs/driving-king-louie.md`, plain second person like `docs/fleet/front-door.md`:
- §1: `delegate`, `send_to_job`, `get_job`, `get_job_logs`, `cancel_job` as spec §4.1 describes them; that a delegate turn has the browser tools (name `BrowserPage.wait_for`, `wait_for_url`, `wait_for_text` is D1, so say `wait_for` and `wait_for_url` here) and the GUI tools; that headed is the default; that `send_to_job` during a turn is `node_busy`.
- §2: spec §12's checklist, numbered, with the `node.yaml` lines (`gui.take`, `gui.browser`, `gui.recorder` are D1: mark them "from D1 part C").
- §3: the loop as of today: send, then `get_job` until `session` is `idle`; the STUCK shape (spec §11).
- §4: one paragraph: what a take will be, "arrives with D1 part D".
- §5: `node_busy`, `node_restarted`, `job_not_found`, the phone timeout sentence from `mapApprovalResult`, `REFUSE_UNSAFE_MESSAGE`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/docs-driving.test.js tests/examples.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/driving-king-louie.md examples/mcp/claude-code.windows.json tests/docs-driving.test.js tests/examples.test.js
git commit -m "docs: a driver's guide and a Claude Code MCP example"
```

---

## Part B: the protocol

### Task 2: `gui.take`, `gui.browser`, `gui.recorder` in node.yaml

**Files:**
- Modify: `src/gui/config.js` (`GUI_KEYS` line 10, `RANGES` line 18, `parseGuiConfig` line 59, the exports line 153)
- Modify: `tests/gui-config.test.js`

**Interfaces:**
- Produces: `parseGuiConfig(raw, opts)` output gains `take: { enabled: boolean, maxMinutes: number }` (default `{ enabled: false, maxMinutes: 240 }`), `browser: string | null` (an app id in `apps`), `recorder: { ffmpeg: string | null }`. `GUI_KEYS.top` adds `'take'`, `'browser'`, `'recorder'`; `GUI_KEYS.take = ['enabled', 'max_minutes']`; `GUI_KEYS.recorder = ['ffmpeg']`. New export `TAKE_ENABLE_LINES = 'gui:\n  take:\n    enabled: true'`.

- [ ] **Step 1: Write the failing tests**

```js
it('take is off by default with a 240 minute cap', () => {
  const g = parseGuiConfig({ enabled: true, apps: { chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' } }, { platform: 'win32' });
  assert.deepEqual(g.take, { enabled: false, maxMinutes: 240 });
  assert.equal(g.browser, null);
  assert.deepEqual(g.recorder, { ffmpeg: null });
});
it('take.max_minutes is 1 to 240', () => {
  assert.throws(() => parseGuiConfig({ enabled: true, take: { enabled: true, max_minutes: 241 } }), /gui\.take\.max_minutes/);
  assert.equal(parseGuiConfig({ enabled: true, take: { enabled: true, max_minutes: 90 } }).take.maxMinutes, 90);
});
it('browser must name an app', () => {
  assert.throws(() => parseGuiConfig({ enabled: true, apps: {}, browser: 'chrome' }), /gui\.browser.*not in gui\.apps/);
  assert.equal(parseGuiConfig({ enabled: true, apps: { chrome: 'C:\\x\\chrome.exe' }, browser: 'chrome' }, { platform: 'win32' }).browser, 'chrome');
});
it('recorder.ffmpeg must be an absolute path', () => {
  assert.throws(() => parseGuiConfig({ enabled: true, recorder: { ffmpeg: 'ffmpeg' } }), /gui\.recorder\.ffmpeg/);
});
it('unknown take key is refused', () => {
  assert.throws(() => parseGuiConfig({ enabled: true, take: { enabled: true, contact_s: 5 } }), /unknown key "gui\.take\.contact_s"/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/gui-config.test.js`
Expected: FAIL (`g.take` undefined; unknown key `gui.take`).

- [ ] **Step 3: Implement**

Add the keys to `GUI_KEYS`, a `take` section to `RANGES` (`max_minutes: [1, 240, 240, 'maxMinutes']`, `SECTION_NAMES.take = 'take'`), parse `take.enabled` as a boolean (default false), `browser` through `APP_ID_RE` and a membership check against the parsed apps, `recorder.ffmpeg` through the same absolute-path rules `parseApp` uses for `path` (the `.exe` rule on win32). `disabled()` returns the defaults too. Export `TAKE_ENABLE_LINES`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/gui-config.test.js tests/gui-subsystem.test.js tests/node-config.test.js`
Expected: PASS (the last two prove existing configs still parse).

- [ ] **Step 5: Commit**

```bash
git add src/gui/config.js tests/gui-config.test.js
git commit -m "feat(gui): gui.take, gui.browser and gui.recorder in node.yaml"
```

### Task 3: `kind: take` in lease-v1, with vectors and the protocol doc

**Files:**
- Modify: `src/gui/lease-protocol.js` (`checkLease` line 58, `VALIDATORS` lines 85-123, `buildLeaseRequest` line 135, `buildLeaseStatus` line 169, `verifyLeaseGrant` lines 232-253, exports line 348)
- Modify: `tests/vectors/lease-v1/generate.js` (`buildVectors` line 177, `base()` line 123)
- Modify: `tests/lease-vectors.test.js` (`EXPECTED` lines 17-26, the count at line 113, `PHONE` lines 27-30)
- Modify: `tests/mobile-lease-apps.test.js` only if it counts non-listing vectors (it counts `listing-*` = 14; unchanged)
- Modify: `docs/protocol/lease-v1.md` (append "Revised 2026-10-24")
- Modify: `mobile/PRIVACY.md` (the lease paragraph)

**Interfaces:**
- Produces: `TAKE_MAX_MINUTES = 240`; exports gain `MAX_MINUTES`, `TAKE_MAX_MINUTES`, `checkLease`, `VALIDATORS`, `LEASE_KINDS = ['computer_use', 'take']`.
- `buildLeaseRequest({ ..., kind = 'computer_use', take = null })`: with `kind: 'take'`, `take` is `{ name, sites, browser, credentials, unattended }` and the built `lease` is `{ kind: 'take', job_id, name, sites, browser, apps, credentials, max_minutes, unattended, reason, resumes, limits }` (that key order).
- `buildLeaseStatus({ ..., kind = 'computer_use', unattended = false, name = null })`: the status gains `kind`, `unattended`, `name` after `granted_by`.
- `verifyLeaseGrant(envelope, { ..., guiMaxMinutes = MAX_MINUTES, guiTakeMaxMinutes = TAKE_MAX_MINUTES }, now)`: cap is `min(request.lease.max_minutes, kind === 'take' ? min(guiTakeMaxMinutes, TAKE_MAX_MINUTES) : min(guiMaxMinutes, MAX_MINUTES))`.
- `checkLease(l)`: `computer_use` keys exactly as today; `take` keys exactly `['kind','job_id','name','sites','apps','browser','credentials','max_minutes','unattended','reason','resumes','limits']`; `name` a non-empty string ≤ 60 with no `plainLineProblem`; `sites` 1 to 32 strings each `^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$`; `browser` `true` or a non-empty string list ≤ 64; `credentials` and `unattended` booleans; `max_minutes` 1 to `TAKE_MAX_MINUTES`; `apps` 1 to 8 as today.

- [ ] **Step 1: Add the vectors (the failing test)**

In `generate.js` add five cases to `buildVectors()`, all with `consumers: PHONES`:
- `take-grant`: `grantVector('take-grant', { requestOptions: { kind: 'take', take: { name: 'BSEOA in ChatGPT', sites: ['chatgpt.com', '*.chatgpt.com'], browser: true, credentials: false, unattended: true }, apps: [GUI_APPS.notepad], maxMinutes: 180 }, grantOptions: { minutes: 180 }, given: { ...base(), gui_take_max_minutes: 240 }, expect: 'ok' })`.
- `take-grant-minutes-over-cap`: same request, grant `minutes: 241`, `expect: 'minutes_out_of_range'`.
- `take-request-missing-name`: the request built then `delete lease.name` (and the hash recomputed), `check: 'request'`, expect the validator to refuse.
- `computer-use-with-unattended`: a `computer_use` request with `unattended: true` added, expect refusal.
- `status-take`: a `kl.lease.status` with `kind: 'take'`, `unattended: true`, `name: 'BSEOA in ChatGPT'`, expect accepted; follow the existing `status-*` vectors' shape.

In `tests/lease-vectors.test.js` add the five names to `EXPECTED` (and `PHONE`), change `46` to `51`, and make `run(v)` handle `check: 'request'` by running `VALIDATORS['kl.lease.request']` on the input.

- [ ] **Step 2: Run to verify failure**

Run: `node tests/vectors/lease-v1/generate.js && node --test tests/lease-vectors.test.js`
Expected: `generate.js` throws in `checkLease` (unknown key `kind: take`) or the test fails on the count.

- [ ] **Step 3: Implement the protocol change**

Per the Interfaces block. Keep `exactKeys` for both kinds (two key lists, chosen by `l.kind`). `buildLeaseStatus` appends the three fields for every status (a `computer_use` status carries `kind: 'computer_use', unattended: false, name: null`), so one validator keeps one key list.

- [ ] **Step 4: Regenerate and run**

Run: `node tests/vectors/lease-v1/generate.js && node tests/vectors/lease-v1/generate.js --check && node --test tests/lease-vectors.test.js tests/gui-leases.test.js tests/gui-relay-extension.test.js tests/mobile-lease-apps.test.js`
Expected: `51 vectors match`; PASS. (`gui-leases.test.js` passes because `buildLeaseStatus` defaults the new fields; the Swift and Kotlin tests fail until Task 5 and are not run here.)

- [ ] **Step 5: Write the doc revisions**

`docs/protocol/lease-v1.md`: a "Revised 2026-10-24" section giving the `take` lease object, the three status fields, the cap rule, the unattended rule ("no contact window, never suspended; ends only by expiry, revoke, device revocation, job close or the take's own endings"), and the five new vectors. `mobile/PRIVACY.md`: the lease paragraph adds "a take's name and the hosts it may visit".

- [ ] **Step 6: Commit**

```bash
git add src/gui/lease-protocol.js tests/vectors/lease-v1 tests/lease-vectors.test.js docs/protocol/lease-v1.md mobile/PRIVACY.md
git commit -m "feat(gui): lease kind take in lease-v1, with vectors"
```

### Task 4: Unattended takes in `LeaseManager`

**Files:**
- Modify: `src/gui/leases.js` (`request` line 375, `_armContact` 171, `_checkContact` 188, `suspend` 722, `noteInputOutcome` 708, `onHelperDisconnected` 744, `_relayDown` ~757, `_signStatus` 823, `_listedStatus` 852, `onGrant` 507)
- Modify: `tests/gui-leases.test.js`

**Interfaces:**
- Consumes: Task 3's `buildLeaseRequest`/`buildLeaseStatus` fields, Task 2's `guiConfig.take`.
- Produces: `request({ jobId, origin, appIds, minutes, reason, signal, kind = 'computer_use', take = null, nodeLocalOrigin = true })`. With `kind: 'take'`: refuses `invalid_params` when `guiConfig.take.enabled` is false (message "takes are off in node.yaml"), `take_requires_local_origin` when `nodeLocalOrigin === false`, caps minutes at `guiConfig.take.maxMinutes`. The lease object gains `kind`, `unattended`, `name`, `take` (the request's take block). `lease.unattended === true` means: `_armContact` is a no-op, `_checkContact` returns at once, `suspend(leaseId, reason)` writes a `lease.event` audit entry `{ reason }` and returns without changing state (callers: `noteInputOutcome`, `onHelperDisconnected`, `_relayDown`). Status and listing carry `kind`, `unattended`, `name`.

- [ ] **Step 1: Write the failing tests**

In `tests/gui-leases.test.js`, a new `describe('take leases')` using the file's fixture (`guiConfig` extended with `take: { enabled: true }, browser: 'notepad'`), a helper `grantedTake({ minutes = 180 } = {})` that calls `leases.request({ jobId: 'job-1', origin: ORIGIN, appIds: ['notepad'], minutes, reason: 'demo', kind: 'take', take: { name: 'BSEOA demo', sites: ['*.example.com'], browser: true, credentials: false, unattended: true } })` and grants with `phone.leaseGrant(relay.last('kl.lease.request').envelope, { minutes })`:

```js
it('a take request carries kind, name, sites and unattended', ...)   // relay.last('kl.lease.request').message.lease.kind === 'take', .unattended === true
it('a take may run 180 minutes; computer_use still caps at 60', ...)  // request kind computer_use minutes 61 → rejects invalid_params
it('takes off in node.yaml refuse', ...)                              // guiConfig.take.enabled false → invalid_params /takes are off/
it('a take from a non-local origin is refused before anything is sent', ...) // nodeLocalOrigin: false → code take_requires_local_origin, relay.all('kl.lease.request').length unchanged
it('two hours with no watch: still active, no no_contact', ...)       // timers.advance(2 * 3600000); lease.state === 'active'; no 'lease.suspended' in kinds()
it('relay down does not suspend a take; status resumes when up', ...) // relay.down(); state 'active'; kinds() has 'lease.event'; relay.up(); no resume request sent
it('a foreground_mismatch input refuses but does not suspend', ...)   // leases.noteInputOutcome(lease, { code: 'foreground_mismatch' }); state 'active'; audits include lease.event reason foreground_mismatch
it('helper disconnect does not suspend a take', ...)                  // leases.onHelperDisconnected(); state 'active'
it('a revoke from the other phone still ends it', ...)                // leases.onRevoke(other.leaseRevoke(...)); state 'ended'
it('device_revoked still ends it', ...)                               // as the existing checkGrantingDevices test does
it('expiry still ends it on both clocks', ...)                        // timers.advance(181 * 60000); state 'ended'
it('the signed status says take, unattended and the name', ...)       // relay.last('kl.lease.status').message: kind 'take', unattended true, name 'BSEOA demo'
it('a computer_use lease still suspends at 120 s and on relay down', ...) // unchanged behaviour, run against granted()
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/gui-leases.test.js`
Expected: FAIL (`kind` not accepted; the lease suspends).

- [ ] **Step 3: Implement**

Per Interfaces. The audit kind `lease.event` goes through `_audit('lease.event', lease, { reason })`. `_listedStatus`'s reuse rule is unchanged (a take status is reused like any other). `request` passes `kind`, `take` to `buildLeaseRequest`, and `_signStatus` passes `kind: lease.kind, unattended: lease.unattended === true, name: lease.name || null` to `buildLeaseStatus`. `onGrant` reads the kind's cap through `verifyLeaseGrant({ ..., guiTakeMaxMinutes: this.config.take.maxMinutes })`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/gui-leases.test.js tests/gui-subsystem.test.js tests/gui-tools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gui/leases.js tests/gui-leases.test.js
git commit -m "feat(gui): unattended take leases never pause"
```

### Task 5: Both phones learn the take

**Files:**
- Modify: `mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift` (the request/grant/status validators and the grant builder ~line 262), `mobile/ios/KLProtocol/Tests/KLProtocolTests/LeaseVectorTests.swift` (`testEveryIosVectorIsCovered`, lines 42-51), `mobile/ios/App/LeaseViews.swift` (`LeaseRequestView`, `LeaseBanner`), `mobile/ios/App/AppModel.swift`
- Modify: `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt` (~line 279), `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/LeaseVectorTest.kt` (`everyAndroidVectorIsCovered`, lines 38-47), `mobile/android/app/src/main/kotlin/com/example/kinglouie/LeaseScreens.kt` (`LeaseRequestScreen`, `LeaseBanner`), `AppModel.kt`
- Modify: `tests/mobile-lease-apps.test.js`

**Interfaces:**
- Consumes: Task 3's lease object, status fields and the five vector names.
- Produces: both apps accept a `take` request and a status with `kind`/`unattended`/`name`; the request screen shows, host-built in this order: name, "Unattended: no check-ins; runs until it ends or you stop it", the duration picker up to `max_minutes`, the sites, "drive the browser on these sites (no scripts, no network changes, no uploads)" or the listed actions, "credentials from the vault" only when `credentials`, the apps, the reason. The banner row says "Unattended take: <name>, ends <time>" with the same Stop. Exact strings: `UNATTENDED_LINE = "Unattended: no check-ins; runs until it ends or you stop it"`, `BROWSER_TRUE_LINE = "drive the browser on these sites (no scripts, no network changes, no uploads)"`, `CREDENTIALS_LINE = "credentials from the vault"`, banner prefix `"Unattended take: "`.

- [ ] **Step 1: Write the failing source-pin tests**

In `tests/mobile-lease-apps.test.js`, a `describe('take leases on the phones')`:

```js
for (const [label, file] of [['iOS', 'mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift'], ['Android', 'mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt']]) {
  it(`${label} core validates kind take with its exact keys`, () => { const src = read(file); assert.match(src, /"take"/); for (const k of ['sites', 'credentials', 'unattended', 'max_minutes']) assert.match(src, new RegExp(`"${k}"`)); });
}
for (const [label, file] of [['iOS', 'mobile/ios/App/LeaseViews.swift'], ['Android', 'mobile/android/app/src/main/kotlin/com/example/kinglouie/LeaseScreens.kt']]) {
  it(`${label} shows the unattended line, the browser line and the banner prefix`, () => { const src = read(file); for (const s of [UNATTENDED_LINE, BROWSER_TRUE_LINE, CREDENTIALS_LINE, 'Unattended take: ']) assert.ok(src.includes(s), s); });
}
it('both vector tests list the five take vectors', () => { for (const f of [SWIFT_VECTOR_TEST, KOTLIN_VECTOR_TEST]) for (const n of ['take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take']) assert.ok(read(f).includes(`"${n}"`), `${f} ${n}`); });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/mobile-lease-apps.test.js`
Expected: FAIL on every new assertion.

- [ ] **Step 3: Implement in Swift and Kotlin**

Mirror Task 3's `checkLease` (two exact key sets by `kind`), the status's three fields, and the grant cap (`TAKE_MAX_MINUTES = 240` in both cores; the phone caps the picker at the request's `max_minutes`). Add the five vector names to the explicit coverage sets. In the request views add the lines above, in that order, built from fields only (never from a free string the request sent except `name`, `reason` and the hosts, each shown as one line). In the banner, a status with `unattended == true` renders `"Unattended take: " + name + ", ends " + time`. Keep `Leases.acceptsStatus`/`acceptsView` unchanged.

- [ ] **Step 4: Run the pin test**

Run: `node --test tests/mobile-lease-apps.test.js`
Expected: PASS. (Swift and Kotlin are not compiled by `npm test`; a builder with Xcode or JDK 17 runs `swift test` in `mobile/ios/KLProtocol` and `../gradlew test` in `mobile/android/protocol` and records the result in the commit message.)

- [ ] **Step 5: Commit**

```bash
git add mobile tests/mobile-lease-apps.test.js
git commit -m "feat(mobile): both phones show and grant an unattended take"
```

---

## Part C: the node

### Task 6: The take policy

**Files:**
- Create: `src/gui/take-policy.js`
- Create: `tests/take-policy.test.js`

**Interfaces:**
- Produces:
  - `hostAllowed(host, sites)`: `host` lowercased, trailing dot stripped; a site `example.com` matches that host only; `*.example.com` matches `example.com` and every subdomain.
  - `BROWSER_ACTIONS = Object.freeze({ page: [...], session: [...], extract: [...] })`, the spec §7.1 first column by tool; `CREDENTIAL_ACTIONS` (second column); `NEVER_ACTIONS` (third column); `LOOK_ONLY_ACTIONS = ['status', 'tabs', 'close_tab', 'switch_tab', 'screenshot', 'content', 'title', 'get_text', 'get_attribute', 'get_value', 'is_visible', 'count', 'bounding_box', 'console', 'frames', 'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response', 'go_back', 'go_forward', 'reload']`; `TARGET_URL_ACTIONS = ['navigate', 'open_tab', 'wait_for_url']`; `SHELL_TOOLS = ['Bash', 'PowerShell']` (plus whatever `src/tools/builtin/` names a shell tool; the builder lists them from `tests/fixtures/egress-inventory.json`'s neighbours).
  - `createTakePolicy(grant, { currentUrl })` where `grant = { sites, browser, credentials, apps }` and `currentUrl: () => Promise<string|null>`; returns `{ grant, decide(toolName, params) → Promise<Decision> }` with `Decision = { allow: true } | { allow: false, code, error, allowed? }`.
  - `decide` rules, in order: a shell tool → `take_tool_not_allowed`; `LaunchApp` with `params.app` not in `grant.apps` → `take_app_not_allowed`; a browser tool (`Browser`, `BrowserSession`, `BrowserPage`, `BrowserExtract`) with an action in `NEVER_ACTIONS` → `take_action_not_allowed`; `start`/`stop`/`profile_*`/storage-state → `take_browser_managed`; a credential action without `grant.credentials` → `take_action_not_allowed`; an action outside the allowance (`grant.browser === true` means the first column; a list narrows it) → `take_action_not_allowed` with `allowed` listing the column; a `TARGET_URL_ACTIONS` action whose `params.url` host fails `hostAllowed` → `take_site_not_allowed`; any other acting browser action whose `currentUrl()` host fails → `take_site_not_allowed`; look-only actions anywhere → allow; every other tool → `{ allow: true, passthrough: true }` (the node's own rules decide).
  - `TAKE_CODES = Object.freeze([...])` listing every code above plus `take_no_mid_take_approval`, `take_requires_local_origin`, `take_busy`, `recorder_missing`, `recorder_failed`, `browser_launch_failed`.

- [ ] **Step 1: Write the failing tests**

```js
describe('hostAllowed', () => {
  it('exact and wildcard', () => { assert.ok(hostAllowed('chatgpt.com', ['chatgpt.com'])); assert.ok(!hostAllowed('x.chatgpt.com', ['chatgpt.com'])); assert.ok(hostAllowed('x.chatgpt.com', ['*.chatgpt.com'])); assert.ok(hostAllowed('chatgpt.com', ['*.chatgpt.com'])); assert.ok(!hostAllowed('notchatgpt.com', ['*.chatgpt.com'])); assert.ok(hostAllowed('CHATGPT.COM.', ['chatgpt.com'])); });
});
describe('decide', () => {
  const policy = (grant, url) => createTakePolicy({ sites: ['*.example.com'], browser: true, credentials: false, apps: ['notepad'], ...grant }, { currentUrl: async () => url });
  it('shell is refused', async () => assert.equal((await policy({}, null).decide('Bash', { command: 'dir' })).code, 'take_tool_not_allowed'));
  it('click on an allowed host runs without asking', async () => assert.deepEqual(await policy({}, 'https://app.example.com/x').decide('BrowserPage', { action: 'click', selector: 'a' }), { allow: true }));
  it('the page redirected to another host: click refuses, screenshot and navigate back run', async () => {
    const p = policy({}, 'https://accounts.example.net/login');
    assert.equal((await p.decide('BrowserPage', { action: 'click', selector: 'a' })).code, 'take_site_not_allowed');
    assert.equal((await p.decide('BrowserPage', { action: 'screenshot' })).allow, true);
    assert.equal((await p.decide('BrowserPage', { action: 'navigate', url: 'https://example.com/' })).allow, true);
    assert.equal((await p.decide('BrowserPage', { action: 'navigate', url: 'https://evil.example.net/' })).code, 'take_site_not_allowed');
  });
  it('evaluate, route_block, fill_payment, start are never inside', ...)      // codes take_action_not_allowed ×3, take_browser_managed
  it('fill_credentials needs credentials: true', ...)                         // refused without, allowed with (on an allowed host)
  it('a narrowed list refuses what it leaves out and lists what it allows', ...) // browser: ['navigate','click'] → type refused with allowed: ['navigate','click']
  it('LaunchApp outside the take apps is refused', ...)                       // { app: 'calculator' } → take_app_not_allowed
  it('other tools pass through', async () => assert.deepEqual(await policy({}, null).decide('Read', { path: 'x' }), { allow: true, passthrough: true }));
  it('close_tab runs anywhere', ...)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/take-policy.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/gui/take-policy.js`**

Pure module, no requires beyond `node:url`. Use `new URL(params.url).hostname` for target checks (an unparsable URL is `take_site_not_allowed`). Error sentences: `take_site_not_allowed`: "<host> is not one of this take's sites"; `take_action_not_allowed`: "<action> is outside what this take approved"; `take_browser_managed`: "the take owns its browser; use Take.start and Take.stop"; `take_tool_not_allowed`: "<tool> is not allowed in a take; to wait, use wait_for"; `take_app_not_allowed`: "<app> is not one of this take's apps".

- [ ] **Step 4: Run**

Run: `node --test tests/take-policy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gui/take-policy.js tests/take-policy.test.js
git commit -m "feat(gui): the take policy decides what a take may do"
```

### Task 7: The policy in `ToolExecutor`, threaded from the delegate session

**Files:**
- Modify: `src/execution/tool-executor.js` (constructor ~line 89-208; the gate at 529-616; the hook-confirm path 336-357; the execute context 685-703; `_rethreadedRequester` 751-773)
- Modify: `src/core/create-core.js` (~3034-3060 the adapter forwarding; ~2781-2795 `createAgentRuntime`; ~2338 `new ToolExecutor`)
- Modify: `src/fleet/delegate-sessions.js` (`_runTurn` 362-381; constructor 135)
- Create: `src/gui/take-holder.js`
- Create: `tests/tool-executor-take-policy.test.js`
- Modify: `tests/fleet-delegate.test.js`

**Interfaces:**
- Consumes: Task 6's `createTakePolicy`.
- Produces:
  - `createTakeHolder()` → `{ current: null | TakePolicy, set(policy), clear() }` (`src/gui/take-holder.js`). One per delegate session, created in `DelegateSessions.start` as `session.takeHolder`, passed as `executorOptions.takePolicy`, and rethreaded to children.
  - `ToolExecutor` option `takePolicy` (a holder or null) and `nodeLocalOrigin` (boolean, default `true`). Both appear in the execute context as `context.takePolicy` and `context.nodeLocalOrigin`, and on the rethreaded requester.
  - In `execute`, after the permission-rule deny and the classifier tier (after line 528) and before the gate block: when `this.takePolicy && this.takePolicy.current`, `const d = await this.takePolicy.current.decide(toolName, effectiveParameters)`; `d.allow === false` returns `{ success: false, error: d.error, code: d.code, ...(d.allowed ? { allowed: d.allowed } : {}) }` and emits `approvalDenied` with `deniedBy: 'take'`; `d.allow === true && !d.passthrough` sets `approvalSource = 'take'`, emits `approvalAutoGranted`, and skips the gate; `passthrough` falls through to today's logic, except that where today's logic would call `requestApproval` (line 612 and the hook-confirm path at 343) it returns `{ success: false, error: "this take did not ask for <tool>; nothing was sent to the phone", code: 'take_no_mid_take_approval' }` instead. A `denied` tier and `path_outside_allowed_roots` still win (they run before).
  - `DelegateSessions._runTurn` adds to `executorOptions`: `takePolicy: session.takeHolder`, `nodeLocalOrigin: origin == null || LOCAL_ORIGIN_KINDS.includes(origin.kind)`.

- [ ] **Step 1: Write the failing tests**

`tests/tool-executor-take-policy.test.js`, building a `ToolExecutor` the way `tests/browser-acting-approval.test.js` does (a registry with a fake `BrowserPage`, `Bash` and `Read` tool, `requireApproval: true`, an `approvalRequester` that records calls and resolves `true`):

```js
it('with no take, the requester is asked as today', ...)                        // calls.length === 1
it('inside a take, an allowed click runs without the requester', ...)           // holder.set(createTakePolicy({...}, { currentUrl: async () => 'https://a.example.com' })); result.success; calls.length === 0
it('inside a take, a refused action is a tool result with its code', ...)      // Bash → code take_tool_not_allowed; calls.length === 0; result.success === false
it('inside a take, a passthrough tool that needs approval is refused, not asked', ...) // a fake tool requiresApproval: true not in the policy → take_no_mid_take_approval; calls.length === 0
it('a deny permission rule still wins inside a take', ...)                     // rules deny BrowserPage(click) → the rule's denial, not the policy's allow
it('the context carries takePolicy and nodeLocalOrigin', ...)                  // the fake tool's execute asserts context.takePolicy === holder && context.nodeLocalOrigin === false when built with nodeLocalOrigin: false
it('clearing the holder restores asking', ...)
```

In `tests/fleet-delegate.test.js`: one test that the fake tool sees `context.nodeLocalOrigin === true` for `STDIO_ORIGIN` and `false` for a frontdoor origin covering `fleet:unsafe`, and that `context.takePolicy` is the same object across two turns of one session.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tool-executor-take-policy.test.js tests/fleet-delegate.test.js`
Expected: FAIL (`takePolicy` ignored; context lacks the keys).

- [ ] **Step 3: Implement**

Thread the two keys through the three hops the research names (adapter forwarding from `options.approvalRequester` then `options.executorOptions`; `createAgentRuntime`'s spread; the `new ToolExecutor` literal), add them to `_rethreadedRequester`, and add the decision block. `approvalDenied`/`approvalAutoGranted` payloads follow the existing ones.

- [ ] **Step 4: Run**

Run: `node --test tests/tool-executor-take-policy.test.js tests/tool-executor.test.js tests/tool-executor-remote-tier.test.js tests/browser-acting-approval.test.js tests/fleet-delegate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/tool-executor.js src/core/create-core.js src/fleet/delegate-sessions.js src/gui/take-holder.js tests/tool-executor-take-policy.test.js tests/fleet-delegate.test.js
git commit -m "feat(execution): a take policy answers approvals inside a take"
```

### Task 8: A browser per run, and attaching over CDP

**Files:**
- Modify: `src/browser/playwright-browser.js` (`start` line 84, `stop` 141)
- Create: `src/tools/builtin/browser-registry.js`
- Modify: `src/tools/builtin/browser-tool.js` (lines 18-23 the singleton, `actions.start` 153-178, every `getPw()` call, `_cleanup` ~1368)
- Modify: `tests/browser-tool.test.js`
- Create: `tests/browser-registry.test.js`

**Interfaces:**
- Produces:
  - `PlaywrightBrowser#attach({ cdpUrl })`: `this.browser = await chromium.connectOverCDP(cdpUrl)`, `this.context = this.browser.contexts()[0]`, `this.page = this.context.pages()[0] || await this.context.newPage()`, sets `this._attached = true`, installs the same console and dialog handlers `start` does. `stop()` on an attached browser calls `browser.close()` only on the Playwright side (`this.browser.close()` disconnects; it does not kill the process when attached) and nulls the fields.
  - `browser-registry.js`: `const registry = { default: null, byKey: new Map() }`; `browserKeyOf(context)` → `context.takePolicy && context.takePolicy.current && context.takePolicy.current.browserKey` or `'default'`; `getBrowser(context)` → the `PlaywrightBrowser` for the key, creating the default lazily; `setBrowser(key, browser)`; `removeBrowser(key)`; `activeProfileOf(key)` / `setActiveProfile(key, name)`; `reset()` for tests. `TakePolicy` gains a `browserKey` field set by Task 12 (`take:<take_id>`).
  - `browser-tool.js` uses `getBrowser(context)` wherever it used `getPw()`, and `activeProfile` becomes per key. `actions.start`/`stop` keep their behaviour for the default key.

- [ ] **Step 1: Write the failing tests**

`tests/browser-registry.test.js` (launches a real headless Chromium like `tests/browser-tool.test.js`'s integration block):

```js
it('two contexts resolve two browsers; the default is shared', () => { const a = getBrowser({}); const b = getBrowser({ takePolicy: { current: { browserKey: 'take:1' } } }); assert.notEqual(a, b); assert.equal(getBrowser({}), a); });
it('attach drives a Chromium launched with a debugging port', async () => {
  // spawn chromium (playwright's executablePath()) with --headless=new --remote-debugging-port=0 --user-data-dir=<tmp> about:blank
  // poll <tmp>/DevToolsActivePort until two lines appear (port, /devtools/browser/<uuid>)
  const b = new PlaywrightBrowser(); await b.attach({ cdpUrl: `http://127.0.0.1:${port}` });
  await b.page.goto('about:blank'); assert.equal((await b.getPages()).length, 1);
  await b.stop(); assert.equal(b.isRunning, false); // the process is still alive; the test kills it
});
```

`tests/browser-tool.test.js`: the integration block gains `it('a take key gets its own tabs', ...)`: `setBrowser('take:x', attachedBrowser)`; `actions.tabs({}, { takePolicy: { current: { browserKey: 'take:x' } } })` lists that browser's pages, `actions.tabs({}, {})` the default's.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/browser-registry.test.js tests/browser-tool.test.js`
Expected: FAIL (`attach` undefined; module not found).

- [ ] **Step 3: Implement**

Per Interfaces. `connectOverCDP` is `chromium.connectOverCDP(endpointURL)` in Playwright's API. Keep `clampTimeout` as it is; note in a comment that the waits never used it.

- [ ] **Step 4: Run**

Run: `node --test tests/browser-registry.test.js tests/browser-tool.test.js tests/browser-acting-approval.test.js tests/cases-case-guard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/playwright-browser.js src/tools/builtin/browser-registry.js src/tools/builtin/browser-tool.js tests/browser-registry.test.js tests/browser-tool.test.js
git commit -m "feat(browser): a browser per run, attached over CDP"
```

### Task 9: Helper ops: `launch_browser`, `record_start`, `record_stop`, `keep_awake`

**Files:**
- Modify: `src/session/connection.js` (`createOpHandler` lines 14-36; the close handler)
- Modify: `src/session/backends/windows.js` (the backend object lines 17-43)
- Modify: `src/session/backends/windows-worker.ps1` (`Native` class lines 41-71; `Dispatch` 98-113)
- Modify: `src/session/backends/macos.js`, `x11.js`, `wayland.js`: the four methods throw `capability_unavailable` with "recording and browser launch are Windows only in D1"
- Modify: `docs/protocol/session-v1.md` (ops list line 71; a "Revised 2026-10-24" paragraph)
- Modify: `tests/session-backend-windows.test.js`, `tests/session-helper.test.js`

**Interfaces:**
- Produces, on the Windows backend:
  - `launchBrowser({ exe, profileDir, args = [] })` → `{ pid, cdp: { port, path } }`. Refuses `profile_outside_root` unless `profileDir` is under `path.join(env.LOCALAPPDATA, 'KingLouie', 'browser-profiles')` (resolved, no `..`). Spawns `exe` with `['--user-data-dir=' + profileDir, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...args]` detached like `launch`; then polls `path.join(profileDir, 'DevToolsActivePort')` every 200 ms for up to 10 s for two lines (an integer port, a path starting `/devtools/browser/`); on timeout kills the pid and throws `browser_launch_failed`. Injectable `spawnImpl`, `readFile`, `clock`.
  - `recordStart({ ffmpeg, path, fps = 30, size = null })` → `{ pid, startedAt }`. Spawns `ffmpeg` with `['-y', '-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop', ...(size ? ['-vf', `scale=${size.width}:${size.height}`] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path]`, `stdio: ['pipe', 'ignore', 'pipe']`, `windowsHide: true`; keeps `{ pid, child, path, startedAt }` in `this.recordings`. An `exit` before `recordStop` is remembered as `{ exited: true, code }`.
  - `recordStop({ pid })` → `{ path, durationS, bytes, truncated }`. Writes `q\n` to stdin, waits up to 15 s for `exit`, else kills and sets `truncated: true`; `bytes` from `fs.statSync(path).size` (0 if missing); `durationS` from the clock. Unknown pid → `unknown_recording`.
  - `stopRecordings()`: `recordStop` for every live recording; called by `connection.js` 30 s after the service connection closes (a timer cleared on reconnect) and on helper stop.
  - `keepAwake({ on })` → `{ on }`: `worker.call('keep_awake', { on })`. The worker gains `[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);` and a `case "keep_awake"` calling it with `0x80000003` (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED`) when on and `0x80000000` when off.
  - `createOpHandler`'s map gains `launch_browser`, `record_start`, `record_stop`, `keep_awake` → the four methods.
- Op timeouts for Task 10: `launch_browser` 15 000, `record_stop` 20 000.

- [ ] **Step 1: Write the failing tests**

`tests/session-backend-windows.test.js`:

```js
it('launch_browser spawns chrome with a zero debugging port and reads DevToolsActivePort', async () => {
  // fake spawnImpl records argv and emits 'spawn'; fake readFile answers ENOENT twice then "9222\n/devtools/browser/abc\n"
  const r = await backend.launchBrowser({ exe: 'C:\\x\\chrome.exe', profileDir: path.join(LOCALAPPDATA, 'KingLouie', 'browser-profiles', 'demo') });
  assert.deepEqual(r.cdp, { port: 9222, path: '/devtools/browser/abc' }); assert.ok(argv.includes('--remote-debugging-port=0'));
});
it('launch_browser refuses a profile dir outside the root', ...)              // code profile_outside_root, spawn never called
it('launch_browser kills and fails when the port file never appears', ...)   // fake clock past 10 s → browser_launch_failed; kill called
it('record_start builds the ffmpeg argv', ...)                               // argv equals the list above for fps 30, no size
it('record_stop sends q and reports bytes; a dead ffmpeg reports exited', ...) // fake child emits exit on 'q'; statSync faked to 1234 → bytes 1234, truncated false; a child that ignores q → truncated true after 15 s on the fake clock
it('the worker has keep_awake over SetThreadExecutionState', () => { const src = read('windows-worker.ps1'); assert.match(src, /SetThreadExecutionState/); assert.match(src, /case "keep_awake"/); assert.match(src, /0x80000003/); });
it('the worker is still ASCII only', ...)                                    // existing assertion still holds
```

`tests/session-helper.test.js`: `createOpHandler` dispatches the four ops to a fake backend; an unknown op is still `unknown_op`; after the connection closes, `stopRecordings` is called once the fake clock passes 30 s and not if it reconnects at 29 s.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/session-backend-windows.test.js tests/session-helper.test.js`
Expected: FAIL (`launchBrowser` not a function; `unknown_op`).

- [ ] **Step 3: Implement**

Per Interfaces. `windows.js` already takes `spawnImpl` in `createWindowsBackend`; add `readFile = fs.promises.readFile`, `statSync = fs.statSync`, `clock = Date.now`, `timers`. Failed ops report their code alone (the header rule).

- [ ] **Step 4: Run**

Run: `node --test tests/session-backend-windows.test.js tests/session-helper.test.js tests/session-vectors.test.js`
Expected: PASS (no frame or sealing changed, so the vectors are the same).

- [ ] **Step 5: Document and commit**

`docs/protocol/session-v1.md`: ops list gains the four; a paragraph says what each takes and returns, the profile root rule, the 30 s rule, and that a failed op answers with its code alone.

```bash
git add src/session docs/protocol/session-v1.md tests/session-backend-windows.test.js tests/session-helper.test.js
git commit -m "feat(session): the helper launches a browser, records the screen and keeps it awake"
```

### Task 10: The broker's side of the new ops

**Files:**
- Modify: `src/gui/helper-channel.js` (`OP_TIMEOUTS` line 14)
- Modify: `src/gui/broker.js`
- Modify: `tests/gui-broker.test.js`

**Interfaces:**
- Consumes: Task 9's ops.
- Produces, on `GuiBroker`:
  - `launchBrowser({ exe, profileDir, args }, ctx)` → `channel.request('launch_browser', ..., { jobId: ctx.jobId, timeoutMs: 15000 })`; records the pid under `ctx.jobId` and the browser app id (`this.launched`) as `launch` does; audits `gui.browser.launch { job_id, exe, pid }`; returns the helper's result.
  - `recordStart({ ffmpeg, path, fps, size }, ctx)` → `channel.request('record_start', ...)`; audits `gui.record.start { job_id, pid }`; returns `{ pid, startedAt }`.
  - `recordStop({ pid }, ctx)` → `channel.request('record_stop', { pid }, { timeoutMs: 20000 })`; audits `gui.record.stop { job_id, pid, duration_s, bytes, truncated }`.
  - `keepAwake(on, ctx)` → `channel.request('keep_awake', { on })`; no audit.
  - `OP_TIMEOUTS` gains `launch_browser: 15000, record_stop: 20000`.

- [ ] **Step 1: Write the failing tests** in `tests/gui-broker.test.js` with its fake channel: each method sends the right op and params, records the pid, writes the audit kind; `recordStop` passes the 20 s timeout.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/gui-broker.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** per Interfaces, after `launch` in `broker.js`.

- [ ] **Step 4: Run**

Run: `node --test tests/gui-broker.test.js tests/gui-helper-protocol.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gui/broker.js src/gui/helper-channel.js tests/gui-broker.test.js
git commit -m "feat(gui): the broker launches browsers and records through the helper"
```

---

## Part D: the take

### Task 11: The take record

**Files:**
- Create: `src/gui/take-store.js`
- Create: `tests/take-store.test.js`

**Interfaces:**
- Produces: `class TakeStore { constructor({ dir, clock = Date.now }) }` over `<dataDir>/takes/<take_id>.json` (`dir` is that folder; created on first write, mode `0o700`):
  - `create(record)` → the record, with `take_id` = `take-<12 hex>` and `created_at`; `update(takeId, patch)` merges and writes atomically (`writeFileAtomic` from `src/approvals/approver-store.js`); `get(takeId)`; `list()`; `markLiveEnded(reason)` → for every record with `state` in `['requested','live','waiting']`, `update` with `{ state: 'ended', ended: { at, reason } }` and returns their ids.
  - Record keys, exactly spec §5.3: `take_id, name, job_id, origin, lease_id, grant, state, steps, recording, log, ended, created_at`. `state` ∈ `requested | live | waiting | ended`.
  - `summary(record)` → spec §11's `take` object: `{ take_id, name, state, steps: { done, failed, total }, recording: { path, duration_s } | null, lease: { expires_at } }`.

- [ ] **Step 1: Write the failing tests** (temp dir): create/get/update round trip; `markLiveEnded('service_restarted')` ends `live` and `waiting`, leaves `ended`; `summary` counts steps; a file that is not JSON is skipped by `list()` with a warning, never thrown.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/take-store.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run; PASS.** - [ ] **Step 5: Commit**

```bash
git add src/gui/take-store.js tests/take-store.test.js
git commit -m "feat(gui): the take record"
```

### Task 12: `TakeManager` and the `Take` tool (start, status, note, stop)

**Files:**
- Create: `src/gui/takes.js`
- Create: `src/gui/take-tool.js`
- Modify: `src/gui/tools.js` (`buildGuiTools` line 144; `registerGuiTools`), `src/gui/errors.js` (`GUI_TOOL_NAMES`, a `TAKE_TOOL_NAME = 'Take'`)
- Modify: `src/gui/index.js` (`buildGuiSubsystem` lines 161-195: build the `TakeManager`, expose `gui.takes`)
- Create: `tests/gui-takes.test.js`

**Interfaces:**
- Consumes: `LeaseManager` (Task 4), `GuiBroker` (Task 10), `TakeStore` (Task 11), `createTakePolicy` (Task 6), the browser registry (Task 8), the holder (Task 7).
- Produces:
  - `class TakeManager { constructor({ leases, broker, store, guiConfig, registry, audit, env = process.env, clock = Date.now, timers, log, attachBrowser = (cdpUrl) => PlaywrightBrowser attached, which = findFfmpeg }) }`:
    - `async start({ jobId, origin, nodeLocalOrigin, holder, params })` → spec §5.2's start result. Order: `guiConfig.take.enabled` else `invalid_params` "takes are off in node.yaml"; `nodeLocalOrigin` else `take_requires_local_origin`; `this.live()` else `take_busy` ("a take is already live: <name>"); validate `params` (name plain line ≤ 60, sites 1..32 matching Task 3's regex, minutes 1..`guiConfig.take.maxMinutes`, apps ⊆ `guiConfig.apps` ids ≤ 7, profile `^[A-Za-z0-9_-]{1,64}$`, `record` default true); resolve the recorder (`guiConfig.recorder.ffmpeg` or `which('ffmpeg')`) when `record` is on, else `recorder_missing` "Install ffmpeg (winget install Gyan.FFmpeg) or set gui.recorder.ffmpeg in node.yaml"; `store.create` (`requested`); `leases.request({ jobId, origin, appIds: [guiConfig.browser, ...params.apps], minutes, reason, kind: 'take', take: { name, sites, browser, credentials, unattended: true }, nodeLocalOrigin })` (a refusal or denial: `store.update` ended with the lease's reason, rethrow); `broker.launchBrowser({ exe: appsById[guiConfig.browser].path, profileDir: path.join(env.LOCALAPPDATA, 'KingLouie', 'browser-profiles', params.profile) })` (failure: release the lease `leases.endForJob(jobId, 'browser_launch_failed')`, end the record, throw `browser_launch_failed`); `attachBrowser('http://127.0.0.1:' + cdp.port)` and `registry.setBrowser('take:' + takeId, browser)`; `broker.recordStart({ ffmpeg, path: <recordings dir>/<take_id>/take.mp4, fps, size })` when recording; `broker.keepAwake(true)`; `holder.set(createTakePolicy(grant, { currentUrl: () => browser.page ? browser.page.url() : null }))` with `policy.browserKey = 'take:' + takeId`; `store.update` → `live`; subscribe to `leases` `'state'` for this lease (an `ended` state → `this.end(takeId, lease.endReason || 'lease_ended')`).
    - `async end(takeId, reason)`: idempotent; `broker.recordStop` (result into `recording`), `broker.keepAwake(false)`, `registry.removeBrowser`, `browser.stop()`, `holder.clear()`, `leases.endForJob(jobId, reason)` if the lease is not ended, `store.update` → `ended`, audit `take.ended { take_id, job_id, reason }`.
    - `endForJob(jobId, reason)`; `stopAll(reason = 'service_stopped')`; `live()` → the live record or null; `forJob(jobId)`; `summaryFor(jobId)` → `store.summary(record) | null`.
    - `onTurnStart(jobId)`: clears the C-6 timer, `state: 'live'`; `onTurnEnd(jobId)`: `state: 'waiting'`, arms a 30-minute timer → `end(takeId, 'driver_silent')`.
    - `onRecorderExit(pid, code)` (from a broker event the helper raises when ffmpeg exits early; Task 9's `recordings` entry `exited` is enough for D1: `recordStop` returning `exited: true` before `end` was asked ends the take `recorder_failed`; the builder may wire the helper event instead).
    - `onLocked()`: `end(live, 'screen_locked')` (wired to `leases.setLocked(true)` in `index.js`).
    - `note(takeId, text)` appends `{ at, text }` to `log` (text one plain line ≤ 500).
  - `take-tool.js`: `buildTakeTool({ takes, guiConfig })` → a `Tool` named `Take`, `requiresApproval: false`, built with `tools.js`'s `tool()` wrapper so `refusesUnsafe` applies, `parameters` an `action` enum `['start', 'run_steps', 'status', 'note', 'stop']` plus the fields in spec §5.2 (`run_steps` is wired in Task 13; until then it answers `invalid_params`). `start` reads `options.takePolicy` (the holder), `options.nodeLocalOrigin`, `jobIdOf(options)`.
  - `GUI_TOOL_NAMES` gains `'Take'` (so `delegateToolNames` hides it under `refuseUnsafe`).
- The recordings dir: `path.join(env.LOCALAPPDATA, 'KingLouie', 'recordings')`; `params.record.dir`, when given, must resolve under `options.workingDirectory` (the session's cwd) else `invalid_params`.

- [ ] **Step 1: Write the failing tests**

`tests/gui-takes.test.js`, with the `gui-leases.test.js` fixture (real `LeaseManager`, fake relay and phone), a fake broker recording calls (`launchBrowser` → `{ pid: 7, cdp: { port: 9222, path: '/x' } }`, `recordStart` → `{ pid: 8 }`, `recordStop` → `{ path, durationS: 12, bytes: 1000, truncated: false }`), a fake `attachBrowser` returning `{ page: { url: () => 'https://a.example.com' }, stop: async () => {} }`, a temp `TakeStore`, `which: () => 'C:\\ffmpeg\\ffmpeg.exe'`:

```js
it('start: request → grant → browser → recorder → keep awake → live', ...)   // broker.calls order; holder.current set; record state live; lease.kind 'take'; appIds start with guiConfig.browser
it('the phone denies: nothing launched, record ended with the reason', ...)  // leases.onGrant(phone.leaseGrant(env, { decision: 'deny' })); broker.calls deepEqual []; state ended
it('a second take is take_busy with the live name only', ...)
it('a non-local origin is refused before the request', ...)                   // relay.all('kl.lease.request').length unchanged
it('no ffmpeg: recorder_missing before any request', ...)                     // which → null and recorder.ffmpeg null
it('record: false runs with no recorder', ...)
it('DevToolsActivePort never appears: browser_launch_failed, lease released, no recorder', ...) // broker.launchBrowser throws; leases.current() === null; recordStart not called
it('stop: recorder stopped, awake off, browser stopped, holder cleared, lease ended, result has path/duration/bytes', ...)
it('a revoke from any phone ends the take', ...)
it('turn end arms 30 minutes; a turn start disarms; silence ends it driver_silent with the file kept', ...)
it('the recorder exiting early ends the take recorder_failed and keeps the path', ...)
it('screen lock ends the take screen_locked', ...)
it('Take is in GUI_TOOL_NAMES and hidden from refuseUnsafe delegate turns', ...)
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/gui-takes.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement** `takes.js`, `take-tool.js`, the `errors.js` and `tools.js` additions, and `index.js` wiring (`gui.takes` exposed; `leases.on('locked')` or the `setLocked` seam → `takes.onLocked()`).

- [ ] **Step 4: Run**

Run: `node --test tests/gui-takes.test.js tests/gui-tools.test.js tests/gui-subsystem.test.js tests/gui-leases.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gui/takes.js src/gui/take-tool.js src/gui/tools.js src/gui/errors.js src/gui/index.js tests/gui-takes.test.js
git commit -m "feat(gui): the Take tool starts, watches and ends a take"
```

### Task 13: The step runner

**Files:**
- Create: `src/gui/take-steps.js`
- Modify: `src/gui/take-tool.js` (`run_steps`)
- Modify: `src/tools/builtin/browser-tool.js` only if `wait_for` needs a `timeout` passthrough beyond 30 s (it takes `params.timeout` as is; no change expected)
- Create: `tests/take-steps.test.js`

**Interfaces:**
- Consumes: `browserTool.actions` (Task 8's registry-aware actions), the take's policy.
- Produces:
  - `validateSteps(steps, { from = 0 })` → `{ ok: true, steps } | { ok: false, error }`: an array of 1..200 objects ≤ 64 KiB JSON; each `{ step, ...fields }` with `step` in spec §10's table and exactly that row's fields; `wait_*` `timeout_ms` ≤ 120 000 (default 30 000); `pause.ms` ≤ 10 000 and the sum of pauses ≤ 60 000; `from` an index inside the list.
  - `async runSteps({ steps, from, continueOnError }, { actions, context, policy, takeDir, clock })` → `{ results: [{ index, step, ok, ms, url, error?, screenshot? }], stopped_at: number | null }`. Each step: `policy.decide` first (a refusal is that step's error, code included); then the action: `navigate` → `actions.navigate({ url })`, `click`/… → the matching action with `selector`, `wait_for_text` → `actions.wait_for({ selector: \`${selector} >> text=${text}\`, state: 'visible', timeout })`, `pause` → a ref'd `setTimeout`, `screenshot` → `actions.screenshot({ path: path.join(takeDir, name || \`step-${index}.png\`) })`, `note` → appended to the results only. A failure captures `step-<index>-failed.png` into `takeDir` (best effort) and stops unless `continueOnError`.
  - `Take.run_steps` validates, runs with `actions` bound to the take's browser (the policy's `browserKey` is on the holder, so `context` as passed resolves it), stores the results on the record (`steps`), and returns them.

- [ ] **Step 1: Write the failing tests** with a fake `actions` object recording calls and a fake `policy`:

```js
it('validateSteps: 201 steps, an unknown step, a 2 minute pause, pauses over 60 s, timeout over 120 s are refused', ...)
it('runs in order and stops at the first failure with a screenshot', ...)       // actions.click rejects on index 2 → results.length 3, stopped_at 2, screenshot path ends 'step-2-failed.png'
it('continue_on_error runs the rest', ...)
it('from resumes at the index', ...)
it('a policy refusal is the step error with its code', ...)                     // policy.decide → { allow:false, code:'take_site_not_allowed' }
it('wait_for_text builds a text locator and passes the timeout', ...)
it('note goes to results, not to the browser', ...)
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/take-steps.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run** `node --test tests/take-steps.test.js tests/gui-takes.test.js`; PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gui/take-steps.js src/gui/take-tool.js tests/take-steps.test.js
git commit -m "feat(gui): Take.run_steps runs a script with no model between the steps"
```

### Task 14: The take in the delegate session and the service

**Files:**
- Modify: `src/fleet/delegate-sessions.js` (constructor 135: `takeManager = null`; `_runTurn`: `onTurnStart`/`onTurnEnd`; `_close`: `takeManager.endForJob(jobId, 'job_closed')`; `FULL_TRANSCRIPT_TOOLS` gains `'Take'`)
- Modify: `src/fleet/start.js` (~110: pass `takeManager: deps.takeManager || null`)
- Modify: `src/service/run.js` (~244: `deps: { leaseManager, takeManager: gui ? gui.takes : null }`; shutdown: `gui.takes.stopAll()` before `leases.stopAll()`)
- Modify: `src/cases/chat-integration.js` (`CASE_BLOCKED_TOOL_NAMES` gains `'Take'`)
- Modify: `tests/fleet-delegate.test.js`, `tests/cases-tools.test.js` (where `CASE_BLOCKED_TOOL_NAMES` is pinned), `tests/service-run.test.js`

**Interfaces:**
- Consumes: Task 12's `TakeManager` (`onTurnStart`, `onTurnEnd`, `endForJob`, `stopAll`, `summaryFor`).
- Produces: `DelegateSessions` calls `takeManager.onTurnStart(jobId)` at the top of `_runTurn`'s try and `onTurnEnd(jobId)` in its finally; `_close` ends the job's take before `endForJob` on the lease; `fleet-tools.js`'s `get_job` and `get_job_logs` add `take: delegateSessions.takeSummary(jobId)` (a new `DelegateSessions#takeSummary(jobId)` → `takeManager ? takeManager.summaryFor(jobId) : null`) when not null.

- [ ] **Step 1: Write the failing tests**

`tests/fleet-delegate.test.js`: with a fake `takeManager` recording calls: a turn calls `onTurnStart` then `onTurnEnd` in order; `cancel` calls `endForJob(jobId, 'job_closed')` before the lease's `endForJob`; `get_job` through a `FleetToolHandler` carries `take` when `summaryFor` returns one and omits it when null; `Take` is in `FULL_TRANSCRIPT_TOOLS`. The case test: `CASE_BLOCKED_TOOL_NAMES.includes('Take')`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/fleet-delegate.test.js tests/cases-tools.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** per Interfaces. - [ ] **Step 4: Run** those plus `tests/fleet-node-host.test.js tests/gui-subsystem.test.js`; PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/delegate-sessions.js src/fleet/start.js src/fleet/fleet-tools.js src/service/run.js src/cases/chat-integration.js tests
git commit -m "feat(fleet): a delegate session owns its take; get_job carries the take summary"
```

---

## Part E: the driver

### Task 15: `wait_ms` in `king-louie-service mcp`

**Files:**
- Modify: `src/fleet/tool-definitions.js` (`send_to_job` lines 53-64, `get_job` 65-73: add `wait_ms: { type: 'integer', minimum: 0, maximum: 25000 }`)
- Modify: `src/fleet/courier-client.js` (`CourierFleetClient#call` line 60)
- Modify: `src/fleet/fleet-tools.js` (`FleetToolHandler.call`: accept and ignore `wait_ms` on the service side, so a front-door client passing it is not refused by a strict schema check if one exists)
- Modify: `tests/fleet-node-host.test.js`, `tests/mcp-stdio.test.js`

**Interfaces:**
- Produces: in `CourierFleetClient#call(name, args)`: when `name` is `send_to_job` or `get_job` and `args.wait_ms > 0`, strip `wait_ms`, make the plain call, then poll `this.call('get_job', { job_id })` every `pollMs` (constructor option, default 1000) until the reply's `session !== 'turn'` and `status !== 'running'`, or the job is terminal, or `wait_ms` has passed on `clock` (constructor option); return the last `get_job` reply. `wait_ms` over 25 000 → `ToolError('invalid_params', 'wait_ms is at most 25000')`.

- [ ] **Step 1: Write the failing tests**

`tests/fleet-node-host.test.js` (the fake-courier pattern at lines 298-306):

```js
it('get_job with wait_ms polls until the turn ends', async () => {
  const replies = [{ result: { job_id: 'j', session: 'turn', status: 'running' } }, { result: { job_id: 'j', session: 'turn', status: 'running' } }, { result: { job_id: 'j', session: 'idle', status: 'running' } }];
  const seen = []; const client = new CourierFleetClient({ courier: { callService: async (m, p) => { seen.push([m, p.args]); return replies.shift(); } }, pollMs: 0 });
  const r = await client.call('get_job', { job_id: 'j', wait_ms: 25000 });
  assert.equal(r.session, 'idle'); assert.equal(seen.length, 3); assert.ok(seen.every(([, a]) => !('wait_ms' in a)));
});
it('send_to_job with wait_ms sends once then polls get_job', ...)      // seen[0][0] === 'fleet.send_to_job', the rest 'fleet.get_job'
it('wait_ms returns at the cap with the last reply', ...)             // fake clock jumps 25001 after the first poll
it('wait_ms over 25000 is invalid_params', ...)
```

`tests/mcp-stdio.test.js`: `tools/list` shows `wait_ms` on both tools.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/fleet-node-host.test.js tests/mcp-stdio.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run** those plus `tests/mcp-case-tools.test.js tests/frontdoor-e2e.test.js` (the front door's own `send_to_job` must be unchanged); PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/tool-definitions.js src/fleet/courier-client.js src/fleet/fleet-tools.js tests/fleet-node-host.test.js tests/mcp-stdio.test.js
git commit -m "feat(fleet): wait_ms on get_job and send_to_job in the mcp client"
```

### Task 16: The session user may post to the courier

**Files:**
- Modify: `src/gui/session-secret.js` (beside `windowsUsersDirAclArgs` line 253: `windowsCourierAclArgs(dir, sid, env)` → `[windowsIcaclsExe(env), dir, '/grant:r', \`*${sid}:(OI)(CI)(M)\`]`, and `windowsCourierRevokeArgs(dir, sid, env)` → `/remove:g`)
- Modify: `src/service/commands/session.js` (install ~line 367: after `writeUserCopy`, `runIcacls` on `approvals/outbox` and `approvals/inbox` under the data dir, creating them `0o700` first if missing; uninstall ~526: the matching revoke; `--dry-run` lists both)
- Modify: `tests/service-cli-session.test.js`, `tests/gui-session-secret.test.js`

**Interfaces:**
- Produces: `session install --user NAME` grants NAME's SID modify on the two courier directories; `session uninstall` removes the grant; the consent text (spec R-F5-9's list) gains one line: "lets <name> post requests to the service's courier (approvals\outbox, approvals\inbox)".

- [ ] **Step 1: Write the failing tests**: `windowsCourierAclArgs` shape; the install's injected `runIcacls` receives the two grants after the user-copy calls and the consent text names them; uninstall receives the two revokes; dry-run writes nothing and lists them.

- [ ] **Step 2: Run to verify failure.** Run: `node --test tests/service-cli-session.test.js tests/gui-session-secret.test.js`; FAIL.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run; PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/gui/session-secret.js src/service/commands/session.js tests/service-cli-session.test.js tests/gui-session-secret.test.js
git commit -m "feat(service): session install lets the session user post to the courier"
```

### Task 17: The guide's take chapter, the opt-in e2e, and CLAUDE.md

**Files:**
- Modify: `docs/driving-king-louie.md` (§2 the D1 node.yaml lines are now real; §4 the take; §5 the take codes from `TAKE_CODES`)
- Create: `tests/e2e/demo-take.test.js`
- Modify: `tests/docs-driving.test.js`
- Modify: `CLAUDE.md` (a "Demo takes (D1)" section under Session helper, in the house style: what a take is, the one-tap grant, R-D1-7, the helper ops, where recordings land, what tests never do, `KL_E2E_TAKE=1`)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the guide test**: §4 names `Take`, `start`, `run_steps`, `stop`, `wait_ms`, every code in `TAKE_CODES` appears in §5, and the `node.yaml` block in §2 parses through `parseGuiConfig` (extract the fenced yaml, parse with the repo's YAML loader, assert `take.enabled === true`).

- [ ] **Step 2: Run to verify failure.** Run: `node --test tests/docs-driving.test.js`; FAIL.

- [ ] **Step 3: Write §4 and §5**: the lifecycle in spec §5.1 in the driver's words (the task text shape: steps as a JSON list the model passes to `Take.run_steps`, the intent one sentence per step, the STUCK shape), what one tap approves, that the recording is the whole screen and silent, where the mp4 lands, the 30-minute rule, and that a take needs the helper even for a browser-only demo.

- [ ] **Step 4: Write the e2e** `tests/e2e/demo-take.test.js`: skipped unless `KL_E2E_TAKE=1` and `process.platform === 'win32'`; otherwise, with a real `createWindowsBackend` and a temp `LOCALAPPDATA`, calls `launchBrowser` on Playwright's Chromium executable, `attach`es, navigates `about:blank`, `recordStart` for 5 s with the real ffmpeg from `PATH` (skip with a message if absent), `recordStop`, asserts the mp4 exists and `ffprobe` reports a duration ≥ 3 s, then kills Chromium. No helper child, no input injection, no lease.

- [ ] **Step 5: Run**: `node --test tests/docs-driving.test.js tests/examples.test.js` PASS; `node --test tests/e2e/demo-take.test.js` prints the skip line without the variable.

- [ ] **Step 6: CLAUDE.md** section as described; then run the full suite once for the stage: `npm test` → `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add docs/driving-king-louie.md tests/e2e/demo-take.test.js tests/docs-driving.test.js CLAUDE.md
git commit -m "docs: recording a take; opt-in e2e; CLAUDE.md"
```

---

## Self-review notes

- **Spec coverage:** §5 (Tasks 11-14), §6 (3-5), §7 (6-7), §8 (8-10, 12), §9 (9-10, 12), §10 (13), §11 (1, 14, 15, 17), §12 (1, 16, 17), §13 is documentation (17's CLAUDE.md), §14's tests are spread over the owning tasks; the e2e is Task 17. C-1 to C-13 each land in a named task (C-1: 2, 4; C-2: 4, 7, 12; C-3: 8-10; C-4: 12; C-5: 12; C-6: 12; C-7: 6; C-8: 6; C-9: 15; C-10: 12; C-11: 5; C-12: 9, 12; C-13: 16).
- **Names used across tasks:** `createTakePolicy` / `hostAllowed` / `TAKE_CODES` (6 → 7, 12, 13, 17); `createTakeHolder` (7 → 12); `getBrowser` / `setBrowser` / `removeBrowser` / `browserKey` (8 → 12, 13); `launchBrowser` / `recordStart` / `recordStop` / `keepAwake` (9 → 10 → 12); `TakeStore#summary` (11 → 12 → 14); `TakeManager` methods (12 → 14); `nodeLocalOrigin` (7 → 12); `kind` / `take` on `request` (4 → 12).
- **Review Focus** lines are pinned: 1 → Task 6 (the redirect test), 2 → Task 12, 3 → Tasks 9 and 12, 4 → Task 12, 5 → Tasks 8 and 12.
- **Not in this plan, on purpose:** macOS and Linux recorder backends, a take from a front-door client, keeping the King Louie window out of frame (spec §16 leaves it to the driver's task text in D1), audio.
