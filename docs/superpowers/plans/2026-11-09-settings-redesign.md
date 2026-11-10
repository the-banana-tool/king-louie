# Settings redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Settings drawer's A–Z dropdown with a grouped sidebar, add a banner saying which machine is being edited, rebuild the Models and Providers & keys pages, apply one set of rules to every page, and move the pages that are not settings out.

**Architecture:** Pure logic (navigation groups, banner state, role status, key status, picker grouping, units, auto-save) goes in new `renderer-helpers/*.js` files: plain scripts the renderer loads with `<script>`, which also `module.exports` for `node --test` (the pattern of `renderer-helpers/task-badge.js`). `renderer.js`, `index.html` and `styles.css` change in place. Three small host additions: a placeholder-key hint in `src/models/`, a system-voice lister in `src/voice/`, and two `desktop:*` IPC calls.

**Tech Stack:** Electron renderer (no bundler, no `require` in the renderer), Node 22/24 built-in test runner, Playwright `_electron` e2e.

**Spec:** `docs/superpowers/specs/2026-11-09-settings-redesign-design.md` (approved 2026-11-09). Read it before any task.

## Global Constraints

- Tests: `node --test tests/<file>.test.js`; e2e: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/<file>.test.js`. Never Jest. Run only the files a task names; the full suite runs once, in Task 16.
- `src/` stays Electron-free except `src/ipc/`.
- CSP in `index.html` is unchanged (`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; …`). No `data:` URIs in CSS; icons are Font Awesome.
- Every string from a node, a provider error or a model name goes on the page with `textContent`, never `innerHTML`.
- Do not change `src/desktop-bridge/allowlist.js` lists or any setting's storage. Keep every pane's `data-tab` id.
- New font-size and spacing tokens go in a `.settings-modal { … }` block, never in `:root` (`tests/mobile-design-tokens.test.js` mirrors the first `:root` block into the phone apps).
- `localStorage` is read and written inside try/catch; the page works without it.
- Copy fixed by the spec, verbatim: group labels `Models`, `Chats`, `Reaching you`, `Tools`, `Security`, `This computer`; page labels in Task 2's table; banner texts in Task 5; statuses `Working`, `Failing`, `No key`, `Not tested`; buttons `Edit`, `Add`, `Save & test`, `Remove key`, `Test all`, `Switch to my node`, `Restart node`, `Open data folder`, `Review`; section titles `Advanced`, `Phones & approvals`, `Move from this desktop's old profile`; the saved indicator `Saved`; greyed picker rows `fix key to use`.

## Review Focus

1. **The node drops while a page is open.** A save in flight fails: the field returns to its stored value with the error beside it, and the banner turns grey and the pages go read-only. Tests: Task 12 (auto-save failure), Task 5 (banner for `attached-disconnected`).
2. **Pages a host does not offer.** On a fleet node, a whole group can vanish (Tools mostly), and the merged Permissions & hooks page must hide only its hooks section. Test: Task 2 (`visibleGroups` with the fleet list).
3. **The remembered page is gone.** The last page was `mesh`, `workflows`, `commands` or `memory` (removed), or `hooks` before attaching to a fleet node, so Settings must open on the first visible page. Test: Task 2 (`resolveInitialTab`).
4. **Closing Settings mid-typing.** A debounced save is pending when the drawer closes, and it must still be sent. Test: Task 12 (`flush`), wired in Task 3.
5. **Node-supplied names.** A long node name, or one with odd characters, in the banner and on Node & connection is set as text and cut with an ellipsis. Test: Task 5 (static check that the banner uses `textContent`).

---

### Task 1: Style foundations

**Files:**
- Modify: `styles.css`
- Create: `tests/renderer-settings-style.test.js`

**Interfaces:**
- Produces CSS classes later tasks use:
  - `.settings-sidebar`, `.settings-nav-group`, `.settings-nav-item` (`.is-active`), `.settings-search`;
  - `.settings-where` (`.tone-node`, `.tone-desktop`, `.tone-dev`, `.tone-unreachable`);
  - `.settings-row` (label left, control right), `.settings-row-help`, `.settings-section-label`;
  - `.switch` (a styled `input[type=checkbox]`), `.unit-field` (`<input>` plus `<span class="unit">`);
  - `.settings-list-row`, `.status-pill` (`.is-working`, `.is-failing`, `.is-none`, `.is-untested`), `.chip` (`.chip-provider`, `.chip-free`), `.notice-warn`, `.notice-info`;
  - `.btn`, `.btn-primary`, `.btn-danger`, `.btn-sm` (one definition each).

- [ ] **Step 1: Write the failing test** `tests/renderer-settings-style.test.js`. It reads `styles.css` and `index.html` as text and asserts:
  - no `data:` substring in `styles.css`;
  - exactly one rule whose selector list is just `.btn-sm`;
  - selectors `.switch`, `.settings-sidebar`, `.settings-nav-item.is-active`, `.settings-where.tone-unreachable`, `.status-pill.is-failing` and `.settings-modal [hidden]` exist;
  - every `var(--name` used in `styles.css` or `index.html` is either declared somewhere in `styles.css` (`--name:`) or has a fallback (`var(--name,`). That check fails today on `--bg-secondary`, `--border-color` and `--border`.
- [ ] **Step 2: Run** `node --test tests/renderer-settings-style.test.js`. Expected: FAIL (`data:` present; `.btn-sm` defined four times; undefined variables).
- [ ] **Step 3: Implement in `styles.css`.**
  - Delete the `.settings-nav-select` rules (the arrow at the old line ~1722).
  - Keep one `.btn-sm`; give `.btn-secondary` and `.btn-xs` (used today, never defined) the `.btn` / `.btn-sm` look.
  - Replace the uses of `--bg-secondary`, `--border-color` and `--border` with existing tokens (`--bg-elevated`, `--border-default`).
  - Add `.settings-modal [hidden] { display: none !important; }`, which fixes spec bug 7.
  - Pane help text everywhere uses `.settings-row-help` (one grey). That includes the red custom-roles paragraph and the blue Channels description in `index.html`.
  - Add a `.settings-modal { --settings-fs-title: 17px; --settings-fs-section: 11px; --settings-fs-body: 13px; --settings-fs-help: 12px; }` block, and the classes above, using only `:root` colour tokens.
  - `.settings-modal` becomes `width: min(1100px, 96vw); height: min(92vh, 860px)`, laid out as a grid of a 220px sidebar and the content.
- [ ] **Step 4: Run** `node --test tests/renderer-settings-style.test.js tests/mobile-design-tokens.test.js tests/renderer-setup-view.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "style(settings): one button set, switches, rows, scoped type scale; drop data: arrow"`.

### Task 2: Navigation model

**Files:**
- Create: `renderer-helpers/settings-nav.js`
- Create: `tests/renderer-settings-nav.test.js`

**Interfaces:**
- Produces:
  - `SETTINGS_GROUPS: Array<{ id: string, label: string, pages: Array<{ tab: string, label: string, sections?: string[], keywords: string[] }> }>`. The table below is exact; `sections` names the `data-tab` ids a merged page holds.
  - `visibleGroups(groups, unavailableTabs: string[], extraToolPages?: Array<{tab,label}>) -> groups`. A page is hidden when its `tab` is unavailable, or when every id in its `sections` is unavailable. `hiddenSections(page, unavailableTabs) -> string[]` lists the section ids to hide inside a page shown. Empty groups are dropped. Skill pages (`skill-<id>`) are appended to Tools after Skills.
  - `matchSettings(query: string, groups) -> Array<{ tab, label, groupLabel }>`: case-insensitive substring match on page label or any keyword; an empty query returns `[]`.
  - `resolveInitialTab(lastTab: string|null, groups) -> string`: `lastTab` if a visible page has it, else the first visible page's `tab`.

| Group | Page label | tab | sections |
|---|---|---|---|
| Models | Model profiles | `models` | |
| Models | Providers & keys | `providers` | |
| Models | Local servers | `local-servers` | |
| Chats | New chats | `general` | |
| Chats | About you | `profile` | |
| Chats | History & recall | `history` | |
| Chats | Voice | `voice` | |
| Reaching you | Notifications | `notifications` | |
| Reaching you | Contact ladder | `contact` | |
| Reaching you | Telegram & Discord | `channels` | |
| Tools | MCP servers | `mcp` | |
| Tools | Skills | `skills` | |
| Tools | Permissions & hooks | `permissions` | `['permissions','hooks']` |
| Tools | Scheduled jobs | `scheduler` | |
| Tools | Webhooks | `webhooks` | |
| Tools | Apps on this computer | `system-apps` | |
| Security | Vault | `vault` | |
| This computer | Node & connection | `service` | |
| This computer | Diagnostics | `diagnostics` | |

Keywords, at least these:
- `providers`: `api key`, `token`, `openrouter`, `openai`, `anthropic`, `brave`, `tavily`, `fal`, `image`, `search`;
- `models`: `profile`, `main`, `worker`, `utility`, `vision`, `catalog`, `custom role`, `king louie`;
- `history`: `recall`, `embedding`, `rerank`, `typesafe`;
- `service`: `node`, `pair`, `attach`, `detach`, `import`, `phone`;
- `contact`: `quiet hours`, `ladder`, `digest`;
- `channels`: `telegram`, `discord`, `bot`;
- `scheduler`: `cron`.

- [ ] **Step 1: Write the failing tests:**
  - **`groups match the spec`:** assert the exact group order, the page labels and the tabs from the table; no tab is `mesh`, `workflows`, `commands` or `memory`.
  - **`fleet attach hides`:** `visibleGroups(SETTINGS_GROUPS, ['mcp','channels','hooks','skills','webhooks','workflows','mesh','diagnostics','system-apps'])`:
    - Tools holds exactly `permissions` and `scheduler`, and `hiddenSections` of Permissions & hooks is `['hooks']`;
    - Reaching you holds `notifications` and `contact`;
    - This computer holds only `service`.
  - **`personal attach hides nothing visible`:** with `['mesh']`, the page count is unchanged.
  - **`skill pages join Tools`:** an extra `{tab:'skill-x', label:'X'}` sits right after `skills`.
  - **`search`:** `matchSettings('openrouter')[0].tab === 'providers'`; `matchSettings('quiet')[0].tab === 'contact'`; `matchSettings('')` deep-equals `[]`.
  - **`initial tab`:** `resolveInitialTab('mesh', …)` is `'models'`; `resolveInitialTab('voice', …)` is `'voice'`; `resolveInitialTab(null, …)` is `'models'`; `resolveInitialTab('hooks', fleetVisible)` is `'models'`.
- [ ] **Step 2: Run** `node --test tests/renderer-settings-nav.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `renderer-helpers/settings-nav.js`** (plain script; `if (typeof module !== 'undefined' && module.exports) module.exports = { SETTINGS_GROUPS, visibleGroups, hiddenSections, matchSettings, resolveInitialTab };`).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): navigation groups, search and initial page"`.

### Task 3: Sidebar shell

**Files:**
- Modify: `index.html` (`.settings-modal` markup, html:210-245; split the local-servers section of the models pane into `<div class="settings-tab-content" data-tab="local-servers">`; add `<script src="renderer-helpers/settings-nav.js">` before `renderer.js`)
- Modify: `renderer.js`:
  - `switchSettingsTab` (~4352);
  - `sortSettingsNavOptions` (~4383, delete), and its callers at ~5826 and ~12041;
  - `openSettingsDrawer` (~4582), `setSettingsDrawer` (~4345);
  - the select change handler (~12040);
  - `markUnavailableTabs` (~14847);
  - `#mesh-indicator-btn`'s settings jump (~13880; becomes a no-op title in Task 4);
  - `loadSkillSettingsTabs` (~5779).
- Modify: `tests/e2e/helpers.js`, every e2e suite listed in §10 of the code map below, `tests/desktop-pane.test.js:535-548`, `tests/renderer-history-settings.test.js:50-60`, `tests/renderer-models-m2.test.js:22-28,110`, `tests/e2e/settings-tabs.test.js` (rewrite), `tests/e2e/settings-panel.test.js`, `tests/e2e/attached-mode.test.js:35`
- Test: `tests/renderer-settings-shell.test.js` (new)

**Interfaces:**
- Consumes: Task 2's exports (globals in the renderer).
- Produces (renderer globals):
  - `renderSettingsNav()` draws `#settings-sidebar` from `visibleGroups(SETTINGS_GROUPS, appState.unavailableTabs || [], skillPages)`. `function renderSettingsNav(` must sit **immediately after** `switchSettingsTab` in `renderer.js`, because unit tests slice from one to the other.
  - `switchSettingsTab(tab)` is the only function that sets the active pane and the `.is-active` item. It writes `kl-settings-last-tab`, hides `hiddenSections` (elements with `data-section-tab`), and keeps today's per-tab loaders. `local-servers` calls `loadLocalServers()`; `models` still calls it too.
  - `openSettingsDrawer()` calls `switchSettingsTab(resolveInitialTab(readLastTab(), visible))` every time it opens.
  - `setSettingsDrawer(false)` calls `flushSettingsAutosaves()`, a no-op until Task 12.
  - e2e helper `openSettingsTab(ctx, tab)`: clicks `#open-settings-btn`, waits until `#settings-drawer` is not hidden, evaluates `switchSettingsTab(tab)`, then waits for `.settings-tab-content.active[data-tab="<tab>"]`.

Code map for the e2e migration (each suite opens a page by selecting the dropdown option): settings-channels, -diagnostics, -general, -hooks, -memory, -notifications, -profile, -providers, -providers-save, -scheduler, -skills, -voice and -webhooks (lines ~11-20); models-profiles:182, models-roles:81, local-private:58, questions:51; helpers.js:337 (`launchAttached`). Replace each with `openSettingsTab(ctx, '<tab>')`. Leave the hooks suite pointing at `permissions`, and the memory suite for Task 4.

- [ ] **Step 1: Write the failing static test** `tests/renderer-settings-shell.test.js`:
  - `index.html` has `id="settings-sidebar"`, `id="settings-search"`, `data-tab="local-servers"`, and no `settings-nav-select`;
  - no `.settings-tab-content` in `index.html` carries `active`;
  - `index.html` loads `renderer-helpers/settings-nav.js` before `renderer.js`;
  - in `renderer.js`, the slice `function switchSettingsTab(` → `function renderSettingsNav(` contains `classList.toggle('is-active'`, `kl-settings-last-tab` and `hiddenSections(`;
  - the slice `function openSettingsDrawer(` → the next `\nfunction ` contains `switchSettingsTab(resolveInitialTab(`;
  - `renderer.js` has no `sortSettingsNavOptions`.
- [ ] **Step 2: Update the existing unit tests** to the new end marker and labels:
  - `desktop-pane.test.js:542-548` and `renderer-history-settings.test.js:50` slice to `function renderSettingsNav(`;
  - the `<option …>` assertions become assertions that `SETTINGS_GROUPS` (required from `renderer-helpers/settings-nav.js`) holds `{tab:'service',label:'Node & connection'}`, `{tab:'providers',label:'Providers & keys'}`, `{tab:'models',label:'Model profiles'}` and `{tab:'history',label:'History & recall'}`;
  - keep the `data-tab="…"` assertions.
- [ ] **Step 3: Run** `node --test tests/renderer-settings-shell.test.js tests/desktop-pane.test.js tests/renderer-history-settings.test.js tests/renderer-models-m2.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement:**
  - the sidebar markup: `.settings-sidebar > input#settings-search.settings-search` + `nav#settings-sidebar`, with items as `<button class="settings-nav-item" data-tab>`;
  - search: typing filters items to `matchSettings` results, Enter opens the first, Escape clears;
  - `markUnavailableTabs(tabs)` sets `appState.unavailableTabs = tabs` and calls `renderSettingsNav()` instead of only adding notices;
  - the hooks block inside the merged page keeps `data-section-tab="hooks"` (the merge itself is Task 15; for now the hooks pane stays a page of its own, reachable through the Permissions & hooks item by `sections`).
- [ ] **Step 5: Migrate the e2e suites** to `openSettingsTab`.
  - Rewrite `settings-tabs.test.js`:
    1. The sidebar lists the six group labels.
    2. Clicking each item makes exactly one `.settings-tab-content.active`, with that `data-tab`, and exactly one `.is-active` item with the same tab.
    3. Close, then reopen: Settings opens on the page last shown.
    4. Searching for `openrouter` leaves the Providers & keys item visible.
  - `settings-panel.test.js` opens `providers` explicitly.
  - `attached-mode.test.js:35` asserts the Hooks item is absent from the sidebar instead of the notice.
- [ ] **Step 6: Run** the four unit files above, then `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-tabs.test.js tests/e2e/settings-panel.test.js tests/e2e/settings-general.test.js tests/e2e/models-profiles.test.js tests/e2e/attached-mode.test.js`. Expected: PASS.
- [ ] **Step 7: Commit** `git commit -m "feat(settings): grouped sidebar with search; open on the last page"`.

### Task 4: Pages that leave Settings

**Files:**
- Modify: `index.html`:
  - delete the `commands`, `workflows` and `mesh` panes;
  - move the memory pane's inner markup (every id kept) into a new `<div class="settings-overlay" id="memory-panel" hidden><div class="settings-modal memory-modal">…</div></div>`;
  - add `<button id="open-memory-btn" class="icon-button" title="What King Louie remembers" aria-label="What King Louie remembers"><i class="fas fa-brain"></i></button>` beside `#open-settings-btn` (html:22).
- Modify: `renderer.js`:
  - `#mesh-indicator-btn` no longer opens Settings and keeps its peer-count title;
  - `#open-memory-btn` opens the panel and calls `loadMemoryEntries()`;
  - Escape and backdrop close it;
  - `loadSettings` no longer calls `loadMemoryEntries`, `loadWorkflows` or `loadMeshStatus` (the mesh indicator still updates from `mesh.onReady` and its events).
- Modify: `tests/e2e/settings-memory.test.js` (open via `#open-memory-btn`); delete `tests/e2e/mesh-ui.test.js`; delete the mesh case in `tests/e2e/no-native-dialogs.test.js:124-147`.
- Test: extend `tests/renderer-settings-shell.test.js`.

- [ ] **Step 1: Failing assertions:**
  - `index.html` has no `data-tab="commands"`, `data-tab="workflows"` or `data-tab="mesh"`;
  - it has `id="memory-panel"`, `id="open-memory-btn"` and `id="memory-list"`, the last inside `#memory-panel`;
  - in `renderer.js`, the `#mesh-indicator-btn` handler slice has no `switchSettingsTab`.
- [ ] **Step 2: Run** `node --test tests/renderer-settings-shell.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed. Workflow code guarded by `if (!dom.workflowList) return` stays; Plan & Execute beside Send is unchanged.
- [ ] **Step 4: Run** the unit file, then `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-memory.test.js tests/e2e/no-native-dialogs.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Commands, Workflows and Mesh leave Settings; memory gets its own panel"`.

### Task 5: Which machine you are editing

**Files:**
- Create: `renderer-helpers/settings-banner.js`, `tests/renderer-settings-banner.test.js`
- Modify: `index.html` (`<div id="settings-where" class="settings-where"></div>` and `<span id="settings-save-state"></span>` in `.settings-header`; load the helper script)
- Modify: `renderer.js`:
  - `paintSettingsBanner(status)`, called from `refreshServiceStatus` (~15210) and `openSettingsDrawer`;
  - `setSettingsReadOnly(readOnly)` sets `inert` on every `.settings-tab-content` except `[data-tab="service"]`.
- Modify: `src/ipc/desktop-controller.js` (add `leaveStandalone()` and `openDataFolder()`), `src/ipc/constants.js` (`DESKTOP_LEAVE_STANDALONE: 'desktop:leaveStandalone'`, `DESKTOP_OPEN_DATA_FOLDER: 'desktop:openDataFolder'`), the handler registration beside `desktop:attach`, and `preload.js` (`desktop.leaveStandalone`, `desktop.openDataFolder`)
- Test: `tests/desktop-controller-leave.test.js` (new); follow the controller-test pattern of the existing `tests/desktop-*.test.js` files.

**Interfaces:**
- Produces:
  - `settingsBanner(status) -> { tone: 'node'|'desktop'|'dev'|'unreachable', text: string, readOnly: boolean }`.
  - `switchToNodeAction(status) -> 'leave-standalone' | null`: `'leave-standalone'` only when `status.mode !== 'attached' && status.launch?.why === 'once' && status.platform === 'win32'`.
  - Controller `leaveStandalone()`:
    - `{ok:false, code:'NOT_ONCE'}` unless `launch.why === 'once'`;
    - with `state.pairing?.service` it returns `attach()`;
    - otherwise it returns `relaunch()`, which the launch rule turns into the setup view.
  - Controller `openDataFolder()` opens the personal node's data dir (`state.pairing.service.dataDir`) through the controller's existing shell dependency (inject it the way the controller injects its others). It returns `{ok:false, code:'NOT_PERSONAL'}` unless the pairing is personal.

Banner rules (`name` = `status.service?.nodeName || status.node?.name || status.pairing?.service?.name || 'your node'`):

| status | tone | text | readOnly |
|---|---|---|---|
| `mode !== 'attached'`, `launch.why === 'dev'` | dev | `Development standalone` | false |
| `mode !== 'attached'`, otherwise | desktop | `Editing this desktop only, not your node` | false |
| `view === 'attached-connected'` | node | `Editing King Louie Node on ${name}` + (`hosting === 'personal'` ? ` (running as you)` : ``) | false |
| `view === 'attached-starting'` | unreachable | `Starting ${name}…` | true |
| any other attached view | unreachable | `Can't reach ${name}: changes won't be saved until it's back` | true |

`hosting` is `status.service?.hosting || status.pairing?.service?.hosting`.

- [ ] **Step 1: Write the failing tests:**
  - one test per table row;
  - `switchToNodeAction` returns `'leave-standalone'` for `{mode:'standalone', launch:{why:'once'}, platform:'win32'}` and `null` for `why:'dev'`, for `platform:'linux'` and for `mode:'attached'`;
  - a static check that `paintSettingsBanner` uses `.textContent =` and not `innerHTML`;
  - controller tests: `leaveStandalone` with `launch.why:'dev'` returns `NOT_ONCE`; with `why:'once'` and a pairing it sets mode `attached` and relaunches; with no pairing it relaunches without setting the mode (assert on the injected relaunch and state).
- [ ] **Step 2: Run** `node --test tests/renderer-settings-banner.test.js tests/desktop-controller-leave.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The banner sits in the header, cut with an ellipsis (`text-overflow: ellipsis`), with the tone class from Task 1.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): banner naming the machine being edited; read-only while the node is unreachable"`.

### Task 6: Node & connection page

**Files:**
- Modify: `renderer.js` `paintServicePane(model, status)` (~14602), `runServiceAction(id)` (~14769)
- Modify: `index.html` service pane (html:1258-1278); `styles.css`
- Test: extend `tests/desktop-pane.test.js` (renderer slices); `tests/e2e/attached-mode.test.js`

**Interfaces:**
- Consumes:
  - `describeServicePane(status)` as it is: `{view, lines, actions, request, command, detachWarning, approvals, serviceCommand}`, or `{kind:'remote'}`;
  - `switchToNodeAction`, plus `desktop.leaveStandalone` and `desktop.openDataFolder` from Task 5.
- Produces the layout:
  1. A headline: the first entry of `lines`, bold.
  2. The remaining `lines` as rows.
  3. Primary actions: every action whose id is not in `ADVANCED_SERVICE_ACTIONS = ['unpair','detach','standaloneOnce','pairCancel']`. Those four go in a `<details>` titled `Advanced`, together with the request and command blocks.
  4. When the actions include `import`: a card titled `Move from this desktop's old profile` holding that button.
  5. `approvals` lines in a section titled `Phones & approvals`.
  6. For `view === 'attached-connected'` with a personal pairing: buttons `Restart node` (the existing `nodeRestart` action when offered) and `Open data folder` (`desktop.openDataFolder()`).
  7. When `switchToNodeAction(status) === 'leave-standalone'`: a primary `Switch to my node` button that calls `desktop.leaveStandalone()`.
  8. `{kind:'remote'}`: the node name and version only.

- [ ] **Step 1: Failing static assertions** on the `paintServicePane(` slice:
  - contains `ADVANCED_SERVICE_ACTIONS`, `Phones & approvals`, `Move from this desktop's old profile`, `Switch to my node`, `leaveStandalone()` and `openDataFolder()`;
  - no `innerHTML`.
- [ ] **Step 2: Run** `node --test tests/desktop-pane.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the layout. Keep the existing ids: `#service-pane-status`, `#service-pane-actions`, `service-action-<id>`, `#service-pair-request`, `#service-pair-command`, `#service-copy-request-btn`, `#service-pane-approvals`.
- [ ] **Step 4: Run** `node --test tests/desktop-pane.test.js` and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/attached-mode.test.js`. The e2e must still find `#service-action-pair` on an unpaired launch. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Node & connection page"`.

### Task 7: Model labels and role status

**Files:**
- Create: `renderer-helpers/model-labels.js`, `tests/renderer-model-labels.test.js`

**Interfaces:**
- Produces:
  - `providerDisplayName(provider, providerLabels: object, localServerNames: object, model: string) -> string`:
    - `local` gives the server name for the `<serverId>/` prefix of `model`, or the server id if the name is unknown;
    - otherwise `providerLabels[provider]?.label || provider`.
  - `isFree(entry) -> boolean`: `entry.priced === true && entry.cost && entry.cost.input === 0 && entry.cost.output === 0`.
  - `modelChip(entry, providerLabels, localServerNames) -> { name, provider, free, usable }`; `name` is `entry.name || entry.model`, and `usable` is `entry.usable !== false`.
  - `roleStatus(roles: object, role: string) -> { state: 'ok'|'borrows'|'warn'|'off', from?: string, message: string }`. It follows `src/models/resolver.js` `candidatesUnder` (borrow chains: worker→main; utility→worker, then main; vision→any usable `imageInput` model from utility, worker or main; imageGeneration has none). Rules, in order:

| case | state | message |
|---|---|---|
| own entries, at least one usable | ok | `` |
| own entries, none usable | warn | `None of these can be used right now. Fix their keys under Providers & keys.` |
| `main` empty | warn | `Nothing can answer you until Main has a model.` |
| worker/utility empty, chain finds a role with a usable entry | borrows (`from`) | `Uses ${Label}'s models.` (Label from `Main`, `Worker`) |
| worker empty, nothing found | warn | `Agents and tasks can't run.` |
| utility empty, nothing found | warn | `Chat titles and case wake-ups can't run.` |
| vision empty, an image-capable usable model in the chain | borrows | `Uses an image-capable model from your other roles.` |
| vision empty, none | off | `Nothing in this profile can read images.` |
| imageGeneration empty | off | `Uses the image provider set under Providers & keys.` |
| custom role empty | borrows | `Uses its fallback role.` |

- [ ] **Step 1: Write the failing tests**, one per table row plus:
  - `providerDisplayName('local', {}, {ws:'Workstation'}, 'ws/qwen3:8b') === 'Workstation'`;
  - `providerDisplayName('openrouter', {openrouter:{label:'OpenRouter'}}, {}, 'deepseek/x') === 'OpenRouter'`;
  - `isFree` true only for a priced entry at zero, and false for an unpriced one (`priced:false`, `cost:null`).
- [ ] **Step 2: Run** `node --test tests/renderer-model-labels.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): model chips and role status"`.

### Task 8: Model profiles page

**Files:**
- Modify: `renderer.js`:
  - `renderModelProfileList` (~7718-7813; cards per spec §5.4; delete the migration-notes block ~7781-7792);
  - `renderKingLouie` (~8618-8734; `#models-kl-summary` line + `Review` toggling `#models-kl-detail`; each change's "Now" uses the **default** profile's role: `Now (Default): ${names}`).
- Modify: `index.html` models pane (wrap the catalog, custom roles and the King Louie tuning fields in `<details id="models-advanced"><summary>Advanced</summary>…</details>`; keep every id `renderer-models-m2.test.js` lists)
- Modify: `tests/renderer-models-m2.test.js:41-48` (no `models-migration-notes` in the card slice), `tests/renderer-models-m3.test.js:42-56` (expect `#models-kl-summary` and `Now (Default):`)
- Test: `tests/e2e/models-profiles.test.js`

**Interfaces:**
- Consumes: Task 7 (`modelChip`, `roleStatus`, `providerDisplayName`); `appState.modelProfiles`, `appState.settings.providers`, `appState.localServerNames`.
- Produces a card:
  - per role in `MODEL_ROLE_ORDER`, plus the profile's custom roles: a row with the role label and its job (`answers you`, `agents, tasks`, `titles, small jobs`, `optional`, `optional`);
  - then the chips in order, each a `.chip` with the name and a `.chip-provider` (`free` added when `isFree`);
  - a `notice-warn` for `warn`; plain help text for `borrows` and `off`.

- [ ] **Step 1: Failing test updates** (the two unit files above), plus a new e2e case in `models-profiles.test.js`: a profile with main set and utility empty renders `Uses Worker's models.` or `Uses Main's models.` under Utility, and every chip shows a provider name.
- [ ] **Step 2: Run** `node --test tests/renderer-models-m2.test.js tests/renderer-models-m3.test.js tests/renderer-models-text.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Model names and provider labels go in with `textContent`; `renderer-models-text.test.js` must stay green.
- [ ] **Step 4: Run** the three unit files and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/models-profiles.test.js tests/e2e/models-roles.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): model profile cards with providers and role warnings"`.

### Task 9: Placeholder key hint

**Files:**
- Create: `src/models/placeholder-key.js`, `tests/models-placeholder-key.test.js`
- Modify: `src/models/availability.js` (`_test` failure branch, ~127-143; constructor option `readToken`), `src/core/create-core.js` (pass `readToken` where the availability object is built: the provider's decrypted saved token, `null` on any error)
- Test: extend the existing availability test file (`tests/models-availability*.test.js`)

**Interfaces:**
- Produces:
  - `placeholderKeyHint(token: string|null) -> string|null`. The returned text never contains any part of the token. Rules, first match wins:
    1. Contains 6 or more consecutive ascending digits (`012345`, `123456`, …, `456789`) gives `it contains a counting run of digits`.
    2. Contains `your`, `example`, `placeholder`, `xxxx`, `changeme` or `test-key` (case-insensitive) gives `it contains placeholder words`.
    3. Has 8 or more of one character in a row gives `it is mostly one repeated character`.
  - The failed status gains `hint` when the hint is not null: `{ ok:false, error, message, checkedAt, models:[], hint }`.

- [ ] **Step 1: Write the failing tests:**
  - `placeholderKeyHint('sk-abc1234567890')` is `'it contains a counting run of digits'`;
  - `('sk-your-key-here')` is `'it contains placeholder words'`;
  - `('aaaaaaaaaaaa')` is `'it is mostly one repeated character'`;
  - a realistic random key such as `'sk-or-v1-9f3a7c2e81b4d6f0'` returns `null`;
  - `null` returns `null`;
  - no returned string includes `'123456'`;
  - availability: a failing test with `readToken: () => 'sk-1234567890'` stores `hint`, and a passing one stores none.
- [ ] **Step 2: Run** `node --test tests/models-placeholder-key.test.js` plus the availability test file. Expected: FAIL.
- [ ] **Step 3: Implement.** `readToken` is optional; when it is absent, no hint.
- [ ] **Step 4: Run** both files and `node --test tests/egress-inventory.test.js tests/electron-boundary.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(models): say when a failing key looks like a placeholder"`.

### Task 10: Providers & keys page

**Files:**
- Create: `renderer-helpers/key-rows.js`, `tests/renderer-key-rows.test.js`
- Modify: `renderer.js`:
  - `renderProviderCard(providerKey, provider)` (~4590; keep the name, render a row);
  - `renderSettings` (~4882-4925);
  - the search and image handlers (~12404-12634);
  - `handleSaveProvider` (~10747; after a successful save, run `handleTestProvider`).
- Modify: `index.html` providers pane (two lists, `Model providers` and `Search & images`; `#providers-failing-banner`; the `Test all` button keeps id `models-test-all-btn`)
- Modify: `src/ipc/settings-handlers.js` `withoutApiKeys` (~17) to add `hasKey: Boolean(apiKey)` before stripping
- Test: `tests/e2e/settings-providers.test.js`, `tests/e2e/settings-providers-save.test.js`

**Interfaces:**
- Produces:
  - `keyRowState({ hasKey: boolean, status: object|null, tested?: object|null }) -> { state: 'working'|'failing'|'no-key'|'not-tested', reason: string, action: 'Edit'|'Add' }`:
    - `!hasKey` gives `no-key`, `''`, `Add`;
    - `status?.ok` gives `working`, with `status.message`, plus ` · tested ${date}` when `checkedAt` is set;
    - `status && !status.ok` gives `failing`, with `status.hint ? 'Looks like a placeholder: ' + status.hint : status.message`;
    - otherwise `not-tested`, `Not tested yet`.
    - `tested` (a search or image key's session result `{ok, message|error}`) is read like `status` when present. `action` is `Edit` whenever `hasKey`.
  - `failingCount(providers: object) -> number`: model providers in state `failing`.
  - `failingBannerText(n)`: `1 key is failing. Models from that provider are skipped until you fix or remove the key.`, or `${n} keys are failing. Models from those providers are skipped until you fix or remove the key.`
- A row: name, `.status-pill`, reason, and the `Edit`/`Add` button, which expands the row in place: the key input, `Save & test`, `Remove key` (Remove only with a key; the existing confirm). Search and image rows add a `Test` button, and their results live in `appState.keyTestResults` only (never stored). The image default-provider select sits in the Search & images list.

- [ ] **Step 1: Write the failing tests** for each `keyRowState` branch (including the hint text and the `tested` override) and `failingBannerText(1)`/`(3)`. Update the e2e suites: a provider without a token shows `No key` and `Add`; clicking `Add` shows the input and `Save & test`; Brave without a key shows `No key`.
- [ ] **Step 2: Run** `node --test tests/renderer-key-rows.test.js tests/renderer-models-m2.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit files and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-providers.test.js tests/e2e/settings-providers-save.test.js tests/e2e/settings-panel.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Providers & keys as one row per provider with status"`.

### Task 11: Model picker grouped by provider

**Files:**
- Modify: `renderer-helpers/model-labels.js` (add `groupPickerByProvider`), `renderer.js` `openModelPicker` (~7959-8002)
- Test: extend `tests/renderer-model-labels.test.js`

**Interfaces:**
- Produces `groupPickerByProvider(view: {usable, unusable}, providers: object, localServerNames) -> Array<{ provider, label, state: 'working'|'failing'|'no-key'|'local', entries: Array<entry & {greyed:boolean}> }>`:
  - `local` entries form one group, state `local`;
  - a provider's state comes from `keyRowState` (Task 10) on `providers[p]` (`working`, `failing` or `no-key`; `not-tested` counts as working);
  - group order: working groups by label, then local, then failing and no-key;
  - entries in failing or no-key groups get `greyed: true`, and their row text says `fix key to use`.
- Picker search filters entries by name across all groups and drops empty groups.

- [ ] **Step 1: Failing tests:**
  - two OpenRouter entries and one DeepSeek entry, with DeepSeek's status `{ok:false}`, give groups in the order OpenRouter (working) then DeepSeek (failing, greyed);
  - a `local` entry lands in a `local` group.
- [ ] **Step 2: Run** `node --test tests/renderer-model-labels.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, using `keyRowState` from `renderer-helpers/key-rows.js` (Task 10; load that script before `renderer.js` in `index.html`).
- [ ] **Step 4: Run.** Expected: PASS. Then `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/models-roles.test.js`.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): model picker grouped by provider"`.


### Task 12: Auto-save and units

**Files:**
- Create: `renderer-helpers/autosave.js`, `renderer-helpers/units.js`, `tests/renderer-autosave.test.js`, `tests/renderer-units.test.js`
- Modify: `renderer.js` (`flushSettingsAutosaves()` flushes every registered saver; `showSaveState(state, error)` paints `#settings-save-state` with `Saved`, `Saving…` or the error)

**Interfaces:**
- Produces:
  - `createAutosave({ save: (value) => Promise<{ok:boolean, error?:string}>, delayMs = 600, setTimer = setTimeout, clearTimer = clearTimeout, onState: (state: 'saving'|'saved'|'error', info: {error?:string, value}) => void }) -> { change(value, { immediate?: boolean }), flush(): Promise<void> }`:
    - text calls `change(v)`; switches and selects call `change(v, {immediate:true})`;
    - only the last value in a burst is saved;
    - a save that throws counts as `{ok:false, error: err.message}`;
    - on `error`, the caller restores the stored value.
  - `msToUnit(ms: number) -> { value: number, unit: 's'|'min'|'h' }`: the largest unit that divides exactly, else `s`.
  - `unitToMs(value: number, unit) -> number`.
- Scope rule (plan decision): auto-save is for individual settings. Forms that create or edit a whole object keep one explicit button: the profile editor, a new scheduled job, a new webhook, an MCP server, a vault entry, a custom role, a local server, and every key or token.

- [ ] **Step 1: Write the failing tests** with fake timers:
  - three quick `change`s save once with the last value after `delayMs`;
  - `immediate` saves without waiting;
  - `flush()` saves a pending value at once;
  - a failing save reports `error` with the message;
  - `msToUnit(60000)` is `{value:1, unit:'min'}`, `msToUnit(7200000)` is `{value:2, unit:'h'}`, `msToUnit(1500)` is `{value:1.5, unit:'s'}`;
  - `unitToMs(30, 's')` is `30000`.
- [ ] **Step 2: Run** `node --test tests/renderer-autosave.test.js tests/renderer-units.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, and wire `flushSettingsAutosaves` into `setSettingsDrawer(false)` (Task 3's no-op).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): auto-save and duration units"`.

### Task 13: Chats pages (New chats, About you, History & recall, Voice) and system voices

**Files:**
- Create: `src/voice/list-voices.js`, `tests/voice-list-voices.test.js`
- Modify:
  - `src/ipc/settings-handlers.js`: `settings:listVoices` → `listSystemVoices()`; the channel name in `src/ipc/constants.js` if the file keeps settings channels there;
  - `preload.js`: `settings.listVoices`;
  - `index.html` and `renderer.js` for the four panes (`handleSaveTemplateVariables` ~6118, `handleSaveUserProfile` ~6178, `renderSettings` ~4719-4785, `handleSaveVoiceSettings` ~6290, `saveHistorySettings` ~4504).
- Test: `tests/e2e/settings-general.test.js`, `settings-profile.test.js`, `settings-voice.test.js`, `history.test.js`; `tests/renderer-history-settings.test.js`

**Interfaces:**
- Produces `listSystemVoices({ platform = process.platform, execFile = child_process.execFile, timeoutMs = 10000 } = {}) -> Promise<string[]>`:
  - win32: `powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"`;
  - darwin: `say -v ?`, taking the first column;
  - other: `espeak --voices`, taking the name column;
  - any error gives `[]`.
- **About you** (spec §8.1):
  - Name, Role and Project context show `telos.x` if non-empty, else `templateVariables.x`. A change saves both stores (`saveTemplateVariables` with the full object, `saveUserProfile` with the full profile).
  - `How you like replies` maps to `templateVariables.preferences`; `Goals (one per line)` maps to `userProfile.goals`.
  - `Preferences (JSON)` (TELOS) goes under `Advanced` and saves only when it parses.
- **Voice:**
  - switches for the four toggles; the rest greyed until `Voice output` is on;
  - ElevenLabs fields shown only when that engine is chosen, with the engine label `This computer's voice` for `system`;
  - the voice is a `<select>` from `listVoices()` when the window is standalone or attached to a personal node, otherwise today's text field;
  - speed as `.unit-field` with `×`; the ElevenLabs key keeps its explicit Save.
- **History & recall:** same fields with the rules applied. Choosing the `jev` reranker still requires the confirm box; the host's refusal shows as the save error and reverts.
- **New chats:** already saves on change; restyle only.

- [ ] **Step 1: Write the failing tests:**
  - `listSystemVoices` with a fake `execFile` returning `"Microsoft David\r\nMicrosoft Zira\r\n"` on win32 gives `['Microsoft David','Microsoft Zira']`;
  - an error gives `[]`;
  - darwin `"Alex   en_US  # Most people…\n"` gives `['Alex']`.
  - Update `settings-profile.test.js`: with TELOS empty and template `{name:'TestUser'}`, the Name field shows `TestUser`; typing a new name and waiting 1 s writes it to both stores (read back with `settings.load`).
  - Update `settings-voice.test.js`: ElevenLabs stability is hidden while the engine is `system`.
- [ ] **Step 2: Run** `node --test tests/voice-list-voices.test.js tests/renderer-history-settings.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those, `node --test tests/electron-boundary.test.js`, and `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-general.test.js tests/e2e/settings-profile.test.js tests/e2e/settings-voice.test.js tests/e2e/history.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Chats pages with auto-save; About you; system voice list"`.

### Task 14: Reaching you pages (Notifications, Contact ladder, Telegram & Discord)

**Files:**
- Modify: `index.html`, `renderer.js` (`handleSaveNotifications` ~6235; the contact save closure in `renderContactSettings` ~14025; channels ~12128-12383)
- Test: `tests/e2e/settings-notifications.test.js`, `settings-channels.test.js`, `tests/e2e/questions.test.js`

**Interfaces:**
- Notifications:
  - switches;
  - thresholds as `.unit-field` in `s` (stored as ms today: keep the conversion);
  - auto-save; the host's rule "external ≥ toast" shows as the error.
- Contact ladder:
  - each ladder line auto-saves on blur;
  - a `textToLadder` error shows beside that line and nothing saves;
  - keep the read-fresh-`away` before save.
- Telegram & Discord (plan decision, tell the owner):
  - the Discord and Slack token and enable controls with no handler (`save-discord-token-btn`, `clear-discord-token-btn`, `save-slack-tokens-btn`, `clear-slack-tokens-btn`, the discord/slack checkboxes) are removed, since they never saved;
  - the Telegram token row follows the key-row look (explicit `Save & test`, `Remove key`);
  - the access lists become `.settings-list-row`s.

- [ ] **Step 1: Failing test updates:**
  - notifications: changing the toast threshold to 45 and waiting 1 s persists `45000` (read back with `settings.load`);
  - channels: no element `#save-slack-tokens-btn` exists.
- [ ] **Step 2: Run** `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-notifications.test.js tests/e2e/settings-channels.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those and `tests/e2e/questions.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Reaching you pages"`.

### Task 15: Tools, Security and This computer pages

**Files:**
- Modify: `index.html` and `renderer.js` for:
  - `mcp` (~5298);
  - `skills` (~5538);
  - `permissions`, with the hooks pane moved inside it as `<section data-section-tab="hooks">`;
  - `scheduler` (~7484; the interval as a value plus a `s`/`min`/`h` select via Task 12's units);
  - `webhooks`, `system-apps`, `vault` (~5021-5055), `diagnostics`, `local-servers`.
- Fix: `handleToggleHook` (~6020) sends `{ hookId: name, enabled }` (preload.js:655-662 requires `hookId`).
- Test: `tests/e2e/settings-hooks.test.js`, `settings-scheduler.test.js`, `settings-skills.test.js`, `settings-webhooks.test.js`, `settings-diagnostics.test.js`, `tests/e2e/attached-mode.test.js`

**Interfaces:**
- Lists (MCP servers, skills, permission rules, hooks, scheduled jobs, webhooks, apps, vault entries, local servers) are `.settings-list-row`s: a name, a short detail, a status pill where one exists today, and actions as `.btn-sm` on the row. A delete uses `.btn-danger` and the in-app confirm.
- Diagnostics: the `Results` card stays hidden until a run returns.
- Hooks: a hook's enable switch auto-saves.
- Scheduler: the job card's `Every 60000ms` reads `Every 1 min`.

- [ ] **Step 1: Failing test updates:**
  - hooks: toggling a hook's switch calls the IPC without throwing (assert no page error and that the switch stays at the new value after reload);
  - scheduler: a job with interval 60000 shows `Every 1 min`;
  - attached-mode: on a fleet attach the Permissions & hooks item is present and `[data-section-tab="hooks"]` is hidden.
- [ ] **Step 2: Run** `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-hooks.test.js tests/e2e/settings-scheduler.test.js tests/e2e/attached-mode.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all six e2e files above. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(settings): Tools, Security and This computer pages; fix per-hook toggle"`.

### Task 16: Names in docs and strings, and the whole check

**Files:**
- Modify: every hit of `rg -n "Settings ?(>|›|→)|Settings tab|Local service|Settings > (Workflows|Skills|Webhooks|Contact|Models|Local service)" docs CLAUDE.md src` that names a page by its old label or a removed page. Known: `CLAUDE.md` (Settings > Local service, Settings > Contact); `docs/install-guide.md`; `docs/driving-king-louie.md`; the migration "stays behind" text in `src/migration/` ("Set them up again in Settings > Workflows on the node" becomes "Start them again with Plan & Execute on the node"); `src/models/resolver.js:18` ("Settings → Models → Advanced" becomes "Settings › Model profiles › Advanced").
- Test: whichever tests hold those strings (`tests/docs-driving.test.js` and the migration plan tests). Update them to the new text.

- [ ] **Step 1: Update the strings and their tests.**
- [ ] **Step 2: Run** `npm test`. Expected: `# fail 0`.
- [ ] **Step 3: Run** `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`. Expected: `# fail 0`.
- [ ] **Step 4: Visual check.** Write a throwaway script that launches the app with `launchApp()` from `tests/e2e/helpers.js` (its own temp profile, `--kl-standalone`; never the owner's real profile). It then calls `switchSettingsTab(tab)` for every tab in `SETTINGS_GROUPS` and screenshots `.settings-modal`, scrolling the content to the bottom in viewport steps. Look at each shot and compare each page to the shared rules. Fix what does not follow them.
- [ ] **Step 5: Commit** `git commit -m "docs: settings page names"`.
