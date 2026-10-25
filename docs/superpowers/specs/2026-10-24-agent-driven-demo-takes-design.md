# Agent-driven demo takes — Design Spec

- **Status:** for the owner's approval, 2026-10-24. Brainstormed with the owner the same day;
  the decisions in §2 are the owner's, the calls in §3 are the author's and can be changed. A
  builder check was read against the code the same day and its findings are folded in (C-9 to
  C-13, §7.1, R-D1-7).
- **Date:** 2026-10-24
- **Builds on:** the fleet design (`2026-09-21-king-louie-fleet-design.md`) and its stage 4
  (delegate sessions, `king-louie-service mcp`), stage 5 (the session helper, `lease-v1`,
  `session-v1`) and stage 7 (the attached desktop); F3 approvals (`approval-v1`); the browser
  tools (`src/tools/builtin/browser-*.js`, `src/tools/browser-acting.js`).
- **Read on:** `main` at 3256cb3. Every "the code says" below was read there unless §15 lists it
  as not verified.
- **Stage:** D1, this spec: a local driver records demos on the owner's desktop. The web agents
  (claude.ai, ChatGPT, Grok, Perplexity through the front door) and the property-sales workflow
  are later stages and are named only where D1 leaves a seam for them.
- **Words:**
  - **Driver:** an agent that hands King Louie work. In D1 it is a Claude Code session on the
    same machine, talking to the service over `king-louie-service mcp`.
  - **Take:** one demo recording as a unit of work: a script of steps, an intent, a recording,
    one approval, one result.
  - **Take grant:** the one phone approval that covers a whole take.
  - **Unattended lease:** a lease that does not need the phone to keep checking in.

## 1. Outcome

A driver can tell King Louie "record this demo", King Louie records it on the owner's own
desktop, and the owner approves the whole take with one tap on the phone, wherever they are.

1. **A take is one conversation.** The driver opens a session, sends the script and the intent,
   and gets back per-step results, reports when something goes wrong, and at the end the path of
   an mp4. When a step fails and King Louie's model cannot fix it, the turn ends with a report;
   the driver answers; the recording keeps rolling.
2. **One approval per take.** The take's sites, browser actions, desktop apps and duration go to
   the phone as one request. Inside what was approved nothing asks again; outside it, a call
   fails at once with a reason the model can read. A take never stalls on a prompt nobody will
   see.
3. **The model stays in the loop.** The steps run deterministically; the model watches the
   screen, closes popups and stray tabs, retries, and only reports when it is stuck.
4. **The screen is recorded, not the page.** Desktop apps, extra windows and the cursor are in
   frame. Silent; the owner narrates afterwards.
5. **Nothing the fleet relies on changes by default.** The contact rule, the sixty-minute lease,
   the phone prompt for browser actions: all stay as they are for every run that is not a take.

### 1.1 Not in this spec

| Item | Why or where |
|---|---|
| Web agents driving King Louie | The front door on the owner's static-IP host; its own stage |
| The property-sales workflow | Cases and Ella already run it; the web-agent stage gives it a driver |
| Page-only video (Playwright `recordVideo`) | Cannot show a desktop app; the owner wants the screen |
| Microphone or system audio | The owner narrates afterwards |
| Editing, captions, uploading the video | The driver publishes the file it is given |
| A new HTTP control API | `king-louie-service mcp` and the delegate session are the API |
| A take across two machines | One node, one screen per take |
| macOS and Linux recording backends | Windows x64 is what the owner records on; the others are a residual (§13) |

## 2. Owner decisions (2026-10-24)

- **R-D1-1.** King Louie is a worker other agents hand jobs to. The first job is the demos,
  driven by the local Claude Code session; the web agents come after.
- **R-D1-2.** The model is in the loop from the first version. During last night's take the
  owner was closing popups and extra tabs by hand; King Louie's model does that now.
- **R-D1-3.** The capture is the whole screen. Some of the tools being demoed are desktop apps;
  that is why Loom was in use. No microphone; narration is added afterwards.
- **R-D1-4.** The phone keeps approving, but a take's lease may run **unattended** for longer
  than an hour. The phone's live view having to stay open was the blocker, not the approval.
- **R-D1-5.** One tap approves a whole take. Anything outside what was approved fails at once
  rather than waiting on a click.
- **R-D1-6.** The driver and King Louie talk when something goes wrong: a take is not
  fire-and-forget.
- **R-D1-7.** Unattended takes don't pause. The events that suspend a `computer_use` lease
  today (the wrong window in front, the leased app gone, the helper reconnecting, the relay
  link down) refuse the one input with the reason, or are simply logged, and the take, its
  recording and its lease go on. A lost relay link does not end a take; the duration the
  owner approved is the bound, and Stop lands when the link is back.

## 3. The author's calls

Each can be changed; none was asked of the owner.

- **C-1.** Takes are off until `node.yaml` turns them on: a `gui.take` block, `{ enabled:
  true, max_minutes: 240 }`, admin-owned like the rest of `gui`. `max_minutes` is 1 to 240 and
  caps a take's lease; `gui.lease.max_minutes` (1 to 60) keeps governing `computer_use` leases
  and does not bind a take. A take may ask for less than the cap.
- **C-2.** A take grant can be asked for only from a local origin: the origin kinds
  `shouldRefuseUnsafe` treats as the node's own (`stdio`, `service-chat`), or the owner's own
  chat. A front-door delegate's request is refused `take_requires_local_origin`. Today
  `approvalOrigin` (`src/fleet/fleet-tools.js`) hands the executor `client`, `session` and
  `job_id` and drops `kind`, so the kind (or a `local: true` the delegate turn sets from
  `LOCAL_ORIGIN_KINDS`) has to travel with the executor options for the check to be made. The
  web-agent stage decides whether and how that opens.
- **C-3.** The core stays where stage 5 put it: the service, as `LOCAL SERVICE`, in Session 0.
  The pieces that must be on the owner's screen, the Chrome window and the recorder, are
  launched by the session helper as the logged-in user, and the service drives Chrome over
  CDP (§6). The alternatives are in §4.3.
- **C-4.** Recordings and take browser profiles live in the session user's own profile
  (`%LOCALAPPDATA%\KingLouie\recordings\<take>\` and `...\browser-profiles\<name>\`), because
  the helper writes them as that user and the driver reads them as that user. A driver may name
  another directory under the delegate session's working folder.
- **C-5.** The recorder is `ffmpeg` found on `PATH`, or named by `gui.recorder.ffmpeg` in
  `node.yaml`. Nothing is bundled. Missing: `recorder_missing`, with the install command in
  the message.
- **C-6.** A take with no reply from the driver for 30 minutes after a report ends: the
  recording is stopped and kept, the lease is released, the session stays open.
- **C-7.** Sites are matched by host: an exact host, or `*.example.com` for the domain and
  every subdomain. No path matching.
- **C-8.** Shell, vault, payment and credential actions are outside every take unless the take
  asks for `credentials` (shown on the phone). Shell is never inside a take. What `browser:
  true` covers is the list in §7.1; scripts, network rewriting, cookies and file upload are
  never inside it.
- **C-9.** The driver waits with `wait_ms` on `send_to_job` and `get_job` (at most 25 s a
  call). The wait runs in the `mcp` process, which polls the service with short `get_job`
  calls (every second) until the turn ends or the time is up; the service's courier handles
  one request at a time and must never hold one open. No new event stream.
- **C-10.** The take's lease always lists the browser as one of its apps (§6.1), so the GUI
  tools can screenshot and click Chrome's own dialogs, and a browser-only take is still a
  lease with an app, which is what the grant format requires.
- **C-11.** Both phone apps ship with the service change, as every lease-protocol revision has
  (the status gains fields the apps check with exact keys, so an older app would show "Could
  not confirm" for the node while a take is live). The release order is: vectors, both cores,
  the service, in one series.
- **C-12.** While a take is live the helper keeps the display and the system awake
  (`SetThreadExecutionState` with `ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED` on Windows,
  cleared when the take ends). A lock that still happens (the owner pressed Win+L, a policy
  forced it) ends the take with the reason `screen_locked`; the recording is kept.
- **C-13.** If the owner's account cannot write the courier's `outbox/` and its own `inbox/`
  under a `LOCAL SERVICE` data dir (§12, §15), the installer grants that account write on
  those two directories (the user `session install --user` names). The courier's own header
  says the signatures, not the directory ACL, are its protection, so this widens who can post
  a request, not who can forge one; the handover lists it for the owner to check.

## 4. What exists, and where it breaks

### 4.1 What is already there (so nothing is rebuilt)

- **The local control API.** `king-louie-service mcp` (`src/service/commands/mcp.js`) is a
  stdio MCP server. With the service running it reaches it over the file courier
  (`<dataDir>/approvals/outbox`, polled every 250 ms, 30 s per call). Tools: `delegate`
  (`{ machine, task, cwd? }` → `{ job_id, status }`), `send_to_job` (`{ job_id, message }`,
  returns at once; `node_busy` while a turn runs), `get_job` (fields, `result`, `output`,
  `evidence`), `get_job_logs` (`> user:`, `tool <name> <params> → ok|error <result>`,
  `< assistant:` lines, `since`/`tail`), `cancel_job`. A delegate turn runs the node's `main`
  agent (or `delegate.agent`/`provider`/`model` in `node.yaml`) with every registered tool
  but `DELEGATE_EXCLUDED_TOOLS`; the browser tools are offered, and so are the GUI tools
  whenever the turn does not refuse unsafe calls (a local origin, or a front-door client
  holding `fleet:unsafe` for the node; `delegateToolNames` in
  `src/fleet/delegate-sessions.js`). Sessions live in memory; a service restart forgets them
  (`node_restarted`).
- **Waiting in the browser.** `BrowserPage` has `wait_for` (visible, hidden, attached,
  detached, timeout), `wait_for_url`, `wait_for_load_state`, `wait_for_response`, and its
  description already steers away from `networkidle`. Headed is the default on every browser
  tool. The driver's wishlist asked for both; they exist. What was missing was a way for the
  driver to see them, which §9 gives.
- **Approval timeouts.** `ToolExecutor` denies after `approvalTimeoutMs` (5 min by default; the
  phone's TTL plus 15 s in service mode).
- **The lease** (`docs/protocol/lease-v1.md`, `src/gui/leases.js`, `src/gui/lease-protocol.js`):
  `kl.lease.request` carries `lease = { kind: "computer_use", job_id, apps, max_minutes,
  reason, resumes, limits }` and the node signs it; the phone signs `kl.lease.grant` with
  `grant = { apps, minutes }`, at least one app. `MAX_MINUTES = 60` is enforced in
  `checkLease`, `verifyLeaseGrant`, `LeaseManager.request()`, the `RequestLease` schema and
  the `gui.lease.max_minutes` range (`src/gui/config.js`, applied as `guiMaxMinutes`). Contact:
  `contact_s` 120 s default, 300 max; `_armContact` / `_checkContact` suspend with
  `no_contact`; a watch from the granting device with a fresh token resumes. One lease per node
  (`lease_busy`). A lease is bound to `origin.job_id` or `chat:<session>`.
  `endForJob(jobId, 'job_closed')` when the delegate session closes. The phone validators are
  `VALIDATORS` with exact keys; 46 vectors under `tests/vectors/lease-v1/`.
- **The helper** (`docs/protocol/session-v1.md`): ops `launch`, `processes`, `windows`,
  `foreground`, `focus`, `close`, `screenshot`, `input`, `release_all`, `probe`. `LaunchApp`
  launches only `gui.apps` entries; arguments outside the entry's globs make the launch
  `unsafe` (`resolveLaunch`, `src/gui/apps.js`). The helper runs as the logged-in user.
- **Browser profiles.** `start` with `profile` opens `chromium.launchPersistentContext` on
  `<dataDir>/browser-profiles/<name>` (`src/browser/playwright-browser.js`). One browser per
  process: `browser-tool.js` keeps a module-level singleton shared by every turn and every
  tool; `start` while running answers "Browser already running". Tabs are numbered by
  `context.pages()` order; `tabs`, `open_tab`, `close_tab` and `switch_tab` are
  `BrowserSession` actions. Every action's timeout is clamped to 15 s in `browser-tool.js`.
- **Origin checks.** The case browser executor keeps a job on its approved origin
  (`onOrigin` in `src/cases/executors/kinds.js`), checked after navigate and before each fill
  and the submit click, with `normalizeRecipient(..., { channel: 'url' })`. It is inline and
  case-only; §7 generalises the idea, not the code.
- **The Electron gateway** (`src/gateway/`): a loopback WebSocket on 18789 with a bearer token
  file in the data dir and `agent.execute`, which blocks until the reply. It is the standalone
  app's local API. It is not used here: a standalone app has no phone approvals
  (`remoteApprovals: 'phone'` needs `deps.phoneApprover`, wired only by the service) and no GUI
  tools (`src/gui/` is service-side).

### 4.2 Where it breaks for a take

1. **Session 0.** On Windows the service installs as `LOCAL SERVICE` from a boot-time
   scheduled task and runs in Session 0. A browser it launches has no screen the owner can
   see, and a recorder it starts captures nothing. The fleet design says so (§"Windows services
   run in Session 0"), and stage 7 left "GUI work from the service" to stage 5. Stage 5 solved
   it for screenshots and input with the helper; a take needs the same for a browser window
   and a recorder.
2. **Every browser call goes to the phone.** In service mode `classifyToolCall` makes every
   browser tool call `unsafe` (`tool_requires_approval`), look-only ones included, and a
   permission rule such as `allow Browser(click)` does not lift it: `denyAutoApproval` demotes
   the rule and `tierUnsafe` cancels it. A five-minute demo would be a dozen phone taps, each
   able to expire.
3. **The lease needs the phone in touch.** Two minutes without a watch from the granting
   phone suspends input; on iOS a watch is sent only while the live view is on screen.
4. **One browser.** A take and the owner's own chat would share one Chrome and its tab
   numbering, which is what collided last night.
5. **The driver polls.** `send_to_job` returns at once and `get_job` answers at once, so a
   driver either polls or guesses.
6. **No recorder.** Nothing under `src/` records a screen; `ffmpeg` appears once, as an
   app-discovery catalog entry.

### 4.3 Where the core runs: the decision and the alternatives

C-3 keeps the core in the service and moves only the Chrome window and the recorder into the
user's session, through the helper. Two alternatives were weighed and dropped:

- **Run the service as the logged-in user.** Everything would be on screen with no helper
  involved. Stage 5 refuses it on purpose: the identity record (`identity/node.json`) is
  readable by SYSTEM, Administrators and `LOCAL SERVICE` only, and "a service run by hand as
  any account but LOCAL SERVICE cannot read such a record and refuses to start". Undoing that
  is a security decision this spec does not take.
- **Keep the Electron app standalone and use its gateway.** The driver would have an API
  today, but no phone approval, no lease, no GUI tools, and on-screen prompts that a reload of
  the window loses, which is where last night's take stalled.

## 5. The take

### 5.1 Lifecycle

```
driver                      service (delegate session)             helper (user session)      phone
  │ delegate{task: script+intent}                                                               
  ├──────────────────────────► turn 1: model reads the task                                      
  │                             Take.start{...} ──► lease request (kind take) ─────────────────► 
  │                                                 ◄──────────────────────────── grant (1 tap)  
  │                                                 launch_browser ──────────► Chrome (CDP)      
  │                                                 record_start ────────────► ffmpeg           
  │                             Take.run_steps{steps} → per-step results                        
  │                             (model fixes a popup, retries from the failed index)            
  │                             step N fails, model cannot fix it: turn ends with a report       
  │ ◄── get_job{wait_ms} ────── { take: {state: 'waiting', step: N, ...}, result: report }       
  │ send_to_job{message: fix}                                                                    
  ├──────────────────────────► turn 2: Take.run_steps{from: N, steps}                           
  │                             last step passes; Take.stop ─► record_stop ──► mp4 path        
  │ ◄── get_job{wait_ms} ────── { take: {state: 'done', recording: {path, ...}}, result }       
```

- **Start.** The driver's task carries the script and the intent in words; the model calls
  `Take.start` (§5.2). The service builds a lease request of kind `take` (§6), sends it to the
  phone as it sends every lease request, and waits for the grant inside the tool call, as
  `RequestLease` does today. A refusal or an expiry ends the turn with the reason.
- **Granted.** The service asks the helper for a browser (§8) and starts the recording (§9).
  Both are owned by the take and end with it.
- **Steps.** The model calls `Take.run_steps` with the list it was given. Each step runs
  deterministically with the take's checks (§7); the result carries every step's outcome. On a
  failure the model has the browser and the GUI tools to look and fix, then runs the rest from
  the failed index. The model's own browser calls inside the take are under the same checks.
- **Report.** When the model is stuck it ends its turn saying so. The delegate session is then
  `idle`, the take is `waiting`, and the recording and the lease continue. The driver reads the
  report (`result`) and the take's state and answers with `send_to_job`.
- **Stop.** `Take.stop` (or the last step passing when `stop_when_done` was asked) stops the
  recording, closes the take's browser unless `keep_browser`, releases the lease
  (`lease.ended`, reason `take_done`), and returns the recording's path, duration and size and
  the step results. The model's final message carries them to the driver.
- **Ends that are not the model's.** `cancel_job`, the session closing (`idle_close`, a
  failed turn), the lease ending for any reason (expiry, a revoke from any phone,
  `device_revoked`), the helper dropping, service shutdown, and C-6's 30 minutes: each stops
  the recording and keeps the file, closes the browser, and records the take as `ended` with
  the reason. A file is never deleted by an ending.

### 5.2 The `Take` tool

A chat tool, always loaded on an agent node with the GUI subsystem on, never offered in a
wake-up turn, a case turn or a front-door delegate turn (C-2). `requiresApproval: false`: the
take grant is the approval.

| Action | Parameters | Result |
|---|---|---|
| `start` | `name` (one plain line, ≤ 60 chars), `sites` (≤ 32 hosts, C-7), `browser` (`true`, or a list that narrows §7.1's first column), `apps` (`gui.apps` ids, ≤ 8), `credentials` (bool, C-8), `minutes` (1 to 240), `profile` (browser profile name), `record` (`true` by default; `{ dir?, fps?, size? }`), `stop_when_done` | `{ take_id, lease_id, granted_minutes, expires_at, browser: { profile, cdp: true }, recording: { path, started_at } }` |
| `run_steps` | `steps` (≤ 200; §10), `from` (index), `continue_on_error` | per-step `{ index, action, ok, ms, error?, url?, screenshot? }`, `stopped_at` |
| `status` | | state, step counts, lease time left, recording duration, browser tabs |
| `note` | `text` | appends a timestamped line to the take's log (what the model changed) |
| `stop` | `keep_browser`, `reason` | `{ recording: { path, duration_s, bytes }, steps: {...}, ended: 'take_done' }` |

One take per delegate session, one live take per node (it holds the node's one lease).
`start` while a take is live in another job: `take_busy`, with the other take's name only.

### 5.3 The take record

`<dataDir>/takes/<take_id>.json`, written by the service through one writer: `name`,
`job_id`, `origin`, `lease_id`, `grant` (what the phone approved: sites, browser, apps,
credentials, minutes), `state` (`requested` → `live` → `waiting` ↔ `live` → `ended`),
`steps` (the results so far), `recording` (`{ path, started_at, stopped_at, duration_s,
bytes }`), `log` (the model's notes and every ending), `ended` (`{ at, reason }`). The
driver never reads it directly; `get_job` carries a `take` summary built from it (§11). The
file is what survives a service restart: a take found `live` at start is marked `ended`
(`service_restarted`), and its recording, if the helper is still running it, is stopped by
the helper's own rule (§9: a recording whose service connection drops stops within 30 s).

## 6. The take grant (lease-v1, revised)

A take's approval is a lease of a new kind. One record, one tap, one Stop.

### 6.1 The request

`kl.lease.request` is unchanged in shape; `lease` gains a kind:

```json
{
  "kind": "take",
  "job_id": "job-…",
  "name": "BSEOA in ChatGPT, five prompts",
  "sites": ["chatgpt.com", "*.chatgpt.com", "*.blackseoanalyzer.com"],
  "browser": true,
  "apps": [{ "id": "notepad", "name": "Notepad", "path": "…", "processes": ["notepad.exe"] }],
  "credentials": false,
  "max_minutes": 180,
  "unattended": true,
  "reason": "Record the BSEOA demo",
  "resumes": null,
  "limits": { … }
}
```

- `kind: "take"` is the only kind with `name`, `sites`, `browser`, `credentials` and
  `unattended`; `computer_use` keeps exactly the keys it has. `VALIDATORS` gets a second
  exact-key set for `take`.
- `unattended` is always `true` for a take in D1. It is a field, not an implication of the
  kind, so a later stage can offer an attended take or an unattended `computer_use` lease
  without changing the shape again.
- `max_minutes` ≤ `gui.take.max_minutes` (240 at most, C-1) for `kind: take`; `MAX_MINUTES`
  (60) and `gui.lease.max_minutes` stay for `computer_use`. The five places that cap minutes
  take the kind into account.
- `apps` always holds the browser's own `gui.apps` entry (C-10), then the take's apps, eight
  at most in all, so the grant's "at least one app" rule holds for a browser-only take and
  Stop on the phone ends the browser allowance with the lease (R-D1-5).
- `name`, `reason` and every host are one plain line by `plainLineProblem`; a request that is
  not is refused before it is signed.
- The origin must be local (C-2); the service refuses to build the request otherwise, and the
  phone needs no rule for it.

### 6.2 The grant

`kl.lease.grant` is unchanged: `grant = { apps, minutes }`, `minutes` ≤ the request's
`max_minutes` and the kind's cap. The phone's Allow screen for a take shows, host-built, in
this order: the name, "Unattended: no check-ins; runs until it ends or you stop it", the
duration picker (up to the request's `max_minutes`), the sites, the browser allowance
("browser actions on these sites" or the listed actions), "credentials from the vault" only
when asked, the apps, then the reason. Deny is the same button it is today.

### 6.3 What changes in the lease manager

- **Contact.** `_armContact` is not armed for a lease whose request said `unattended: true`,
  and `_checkContact` returns at once for it. A watch is still accepted and still answered
  with a signed status (a phone may watch the live view); it just makes no difference to the
  lease's life.
- **No pauses (R-D1-7).** `suspend()` is never called for an unattended lease. Where today's
  code suspends (`foreground_mismatch` and `app_not_running` from the broker,
  `relay_unreachable`, the helper dropping), an unattended lease instead: refuses that one
  input with the same code (the model reads it, looks, and tries again), or logs the event
  (`lease.event`, reason) and carries on. No resume request is ever sent for it, so the
  "resume needs the granting device" rule has nothing to act on. A helper that drops takes
  the recorder and the browser with it when it has been gone 30 s (§9), which ends the take
  `helper_lost`; a helper that reconnects sooner changes nothing.
- **What still ends it.** Everything that ends a lease today, untouched: the two clocks and
  expiry, a revoke from any enrolled phone (R-F5-18), a revoked granting device
  (`device_revoked`), the job closing, `release_all` from a revoke. Plus the take's own
  endings in §5.1 (`take_done`, `cancel_job`, C-6, C-12's `screen_locked`, service shutdown).
- **The relay.** While the relay link is down the phone's Stop cannot reach the node; the
  take runs on until the link is back or the lease expires. Owner decision (R-D1-7), noted in
  §13. The node's listing shows the take as live the moment the link returns, so the banner
  and Stop come back with it.
- **Listing and banner.** The status a node signs for a take says `kind: "take"`,
  `unattended: true` and the name; both phones show "Unattended take: <name>, ends <time>" in
  the banner row with the same Stop. `kl.lease.listing` is unchanged in shape; the
  `unconfirmedLeaseNodes` rule and the pending-row rules are unchanged.
- **Vectors.** `tests/vectors/lease-v1/generate.js` gains a `take` request, a grant for it, a
  status carrying `kind: "take"`, and the refusals: a `take` request from a non-local origin,
  `max_minutes` over 240, a `computer_use` request carrying `unattended`, a `take` request
  missing `name`. The Swift and Kotlin cores read the new vectors (`LeaseVectorTests.swift`,
  `LeaseVectorTest.kt`); `mobile/ios/App/LeaseViews.swift`, `AppModel.swift`,
  `mobile/android/.../LeaseScreens.kt`, `AppModel.kt` render the new fields;
  `tests/mobile-lease-apps.test.js` pins the words. `docs/protocol/lease-v1.md` gets a
  "Revised 2026-10-24" section. `mobile/PRIVACY.md` adds the take's name and hosts to what the
  relay can see (it sees the sealed envelope's size and timing today; the name and hosts are
  inside the signed request as the apps are).

## 7. Inside a take: what asks, what refuses

A take turn is a delegate turn with a **take policy** on its executor options, read by
`ToolExecutor` at the point where it decides whether to ask (`approvalRequester`).

### 7.1 What `browser: true` covers

This is what the owner approves with one tap, so it is a fixed list, not "everything":

| Inside every take (`browser: true`) | Only with `credentials: true` | Never inside a take |
|---|---|---|
| `BrowserPage`: navigate, go_back, go_forward, reload, click, dblclick, fill, type, press, clear, select_option, check, uncheck, hover, focus, drag_and_drop, scroll, screenshot, keyboard_type, keyboard_down, keyboard_up, mouse_click, mouse_move, mouse_wheel, wait_for, wait_for_url, wait_for_load_state, wait_for_response | `BrowserSession`: fill_credentials, login, signup, save_credentials, set_http_auth | `BrowserPage`: evaluate, pdf, set_input_files |
| `BrowserSession`: status, tabs, open_tab, close_tab, switch_tab, handle_dialog, set_viewport | | `BrowserSession`: fill_payment, get_cookies, clear_cookies, save_storage_state, load_storage_state, start, stop, profile_* (the browser is the take's: `take_browser_managed`) |
| `BrowserExtract`: content, title, get_text, get_attribute, get_value, is_visible, count, bounding_box, console, frames, fill_in_frame, click_in_frame, type_in_frame | | `BrowserExtract`: evaluate_in_frame, route_block, route_fulfill, unroute |
| `Browser` (legacy): the same actions by name | | `Browser`: the same exclusions |

A take may pass a list instead of `true` to narrow the first column; it can never widen it.
The phone's wording for `true` is "drive the browser on these sites (no scripts, no network
changes, no uploads)".

### 7.2 The checks

- **Browser tools**: a call whose action is inside the take's allowance runs without asking
  anyone, when the page it acts on is on an allowed host (C-7). `navigate`, `open_tab` and
  `wait_for_url` check the target URL's host before navigating; every other acting action
  checks the current page's host (`status().currentUrl`) before it runs. A page that left the
  allowlist on its own (a redirect, a link the model clicked) makes every acting action refuse
  `take_site_not_allowed` until a `navigate` back; look-only actions (`screenshot`,
  `content`, `tabs`, the waits, `close_tab`) run anywhere, since the model needs to see where
  it is and shut what it did not open. Anything in the third column of §7.1 is
  `take_action_not_allowed`; the second column without `credentials` likewise.
- **GUI tools**: unchanged. `Click`, `Type`, `Key`, `Scroll`, `Drag` need the lease, which the
  take holds; `LaunchApp` launches only the take's `apps` (a `gui.apps` id outside the take's
  list is `take_app_not_allowed`, and an unsafe launch, arguments outside the globs, is
  refused in a take rather than sent to the phone); `Screenshot` and `ListApps` as today.
- **Everything else**: the node's policy as today, with two changes. `Bash`, `PowerShell` and
  any shell tool are refused `take_tool_not_allowed` (C-8; the model is told to use
  `wait_for`). A call the policy would send to the phone is **refused** instead
  (`take_no_mid_take_approval`), with the message saying what to ask the take for next time.
  Read tools, `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, keep their own rules.
- **Refusals are answers, not stalls.** Every take refusal is a tool error the model reads
  (`{ error, code, allowed: [...] }`), never an approval request, never a wait. This is what
  R-D1-5 asks for, and it makes the policy a narrowing of what the grant said, never a
  widening of what the node allows.
- **The audit ledger** records the grant (`lease.granted` with `kind: take`), every take
  refusal (`take.refused`, code and tool name, never the parameters) and the endings.

Where this sits in code: `src/approvals/executor-options.js` builds the service's executor
options; the take policy is one more input there (`takePolicy`), consulted in `ToolExecutor`
before the phone requester and after the deny patterns and the roots check, so a node's
`denied` tier and `path_outside_allowed_roots` still win. `tests/egress-inventory.test.js` is
unaffected (no new model call); the new policy module is listed where the approval seam's
tests live (`tests/approvals-*.test.js`).

## 8. The browser on the owner's screen

Session 0 cannot show a window, so the take's Chrome is launched by the helper as the user and
driven by the service over CDP.

- **A new helper op, `launch_browser`** (`session-v1`, revised): `{ profile_dir, args }` →
  `{ pid, cdp: { port, path } }`. The helper launches the configured Chrome (`gui.browser.path`
  in `node.yaml`, an absolute `.exe`; or the `chrome` entry of `gui.apps`) with
  `--user-data-dir=<profile_dir> --remote-debugging-port=0 --no-first-run
  --no-default-browser-check` plus the fixed set `playwright-browser.js` already passes,
  waits for `DevToolsActivePort` in the profile dir (10 s), reads the port and the
  `/devtools/browser/<uuid>` path, and returns them. The helper refuses a `profile_dir`
  outside `%LOCALAPPDATA%\KingLouie\browser-profiles\`. `close` with the pid ends it. The
  browser is one of the lease's apps (C-10), so the broker tracks its pid as it tracks a
  `LaunchApp` pid. `release_all` keeps its meaning (let go of held keys and buttons); it never
  closes a browser or stops a recording. Those end only with the take (§5.1).
- **The service attaches** with `chromium.connectOverCDP('http://127.0.0.1:<port>')`, in a new
  `PlaywrightBrowser` mode (`attach`) beside `launchPersistentContext` and `launch`. Every
  browser action works on the attached context as it does today; `start`/`stop` are the
  take's (§7).
- **Per-take browsers.** The module-level singleton in `browser-tool.js` becomes a registry
  keyed by the run's `chatId` (`delegate:<jobId>` for a session; `default` for the node's own
  chat). A tool call resolves the browser for its run; a run with no browser of its own gets
  the default one, so nothing changes for the owner's chat. The registry is what gives each
  take its own tabs and numbering.
- **Profiles.** A take names a profile (`profile`); it is created under the user's
  `browser-profiles\` when it does not exist and kept when the take ends, so a login (the
  owner's ChatGPT account, say) survives from one take to the next. The vault's
  `browser_cred:<profile>:<host>` entries are keyed by name, so `fill_credentials` under a
  take with `credentials: true` works unchanged. The service's own `<dataDir>/browser-profiles`
  is not used by a take: `LOCAL SERVICE`'s files are not the user's.
- **Residual.** Chrome's debugging port is loopback and unauthenticated beyond the UUID in its
  path (readable from `DevToolsActivePort` in the profile dir, which is the user's). Any
  process of the owner's account could attach while a take runs. The same account already
  owns the screen the take is on; §13 lists it.

## 9. Recording

- **A new helper op, `record_start`**: `{ path, fps, size? }` → `{ pid, started_at }`, and
  **`record_stop`**: `{ pid }` → `{ path, duration_s, bytes }`. The helper runs `ffmpeg`
  (C-5) as the user: Windows `-f gdigrab -framerate <fps> -i desktop`, `-c:v libx264 -preset
  veryfast -crf 23 -pix_fmt yuv420p`, no audio (`-an`), `-movflags +faststart`, into
  `<path>` (an `.mp4` under the user's `recordings\` or a directory the take named, C-4).
  Defaults: 30 fps, the display's native size; `size` scales. `record_stop` sends `q` on
  stdin and waits up to 15 s for the file to finalise, then kills and reports `truncated:
  true` if it had to.
- **Ownership and endings.** One recording per take; the take's record holds the pid. The
  helper stops a recording when its service connection has been gone 30 s and when the
  service sends `record_stop`, which it does on every ending in §5.1 and never on a
  suspension. A stop that fails to reach the helper is logged, and the file is wherever
  ffmpeg left it; nothing deletes it.
- **What is in frame.** Everything on the primary display, King Louie's own window included
  when it is there. The driver's task should say to minimise it, and `Take.start` moves the
  attached desktop app out of the way when it can (an `app:minimise` over the bridge; a
  best effort, §13).
- **Missing recorder.** `Take.start` with `record: true` and no ffmpeg answers
  `recorder_missing` with "Install ffmpeg (`winget install Gyan.FFmpeg`) or set
  `gui.recorder.ffmpeg` in node.yaml" and starts nothing: a take the owner expects a video
  from must not run silently without one. `record: false` runs the take with no recording.
- **Only Windows in D1.** The macOS (`avfoundation`) and Linux (`x11grab`) inputs are the
  obvious next lines; nothing here prevents them, and §13 lists them as not done.

## 10. Steps

`Take.run_steps` runs an ordered list with no model between the steps. Each step is one of:

| Step | Fields |
|---|---|
| `navigate` | `url` |
| `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `clear` | `selector` |
| `fill`, `type` | `selector`, `text` (`type` for keystroke-by-keystroke) |
| `press` | `key`, `selector?` |
| `select_option` | `selector`, `value` |
| `scroll` | `selector?`, `dx`, `dy` |
| `wait_for` | `selector`, `state`, `timeout_ms` (≤ 120 000) |
| `wait_for_url` | `url`, `timeout_ms` |
| `wait_for_text` | `selector`, `text`, `timeout_ms` (a `wait_for` on a text locator) |
| `pause` | `ms` (≤ 10 000; for pacing a recording, never for waiting on a page) |
| `screenshot` | `name?` (a still beside the recording, in the take's directory) |
| `note` | `text` (goes to the take log and the results, for the narration later) |

Every step runs through the same browser code the model's own calls use, under the take's
checks (§7), with the tool's auto-wait. The one difference: the 15 s clamp `browser-tool.js`
puts on every action's timeout is lifted for the three waits in a step list, up to the
120 s above, since a demo waits on a model's answer in ChatGPT for longer than a tool call
should; the model's own `wait_for` calls keep the clamp. The result lists every step with
`ok`, elapsed ms,
the page URL after it and, for a failure, the error and a screenshot path. The run stops at
the first failure unless `continue_on_error`; `from` resumes a list at an index. A step list
is capped at 200 steps and 64 KiB; `pause` totals are capped at 60 s a run so a script cannot
be a sleep. The description of `Take.run_steps` says in words: "to wait, use `wait_for`,
`wait_for_url` or `wait_for_text`; never a shell". `Take` is in `tests/egress-inventory`'s
file list only if it ever calls a model; it does not.

## 11. The driver's side

- **`wait_ms` on `send_to_job` and `get_job`** (`src/fleet/tool-definitions.js`, handled in
  `src/service/commands/mcp.js`): 0 to 25 000. The call returns when the session's turn ends
  or the time is up, whichever first, with the job as `get_job` gives it. A `send_to_job`
  with `wait_ms` is "send and wait for the reply" in one call. The wait lives in the `mcp`
  process (C-9): it sends the plain call, then `get_job` every second until `session` is
  `idle`, the job is terminal, or the time is up; each courier request is as short as it is
  today. The front door's own `send_to_job` is untouched by it. A driver loops `get_job {
  wait_ms: 25000 }` until the turn ends.
- **`take` on the job.** `get_job` and `get_job_logs` carry `take: { take_id, name, state,
  steps: { done, failed, total }, recording: { path, duration_s } | null, lease: {
  expires_at } }` when the session has a take, built from the take record (§5.3), inside the
  untrusted wrapper like the rest.
- **The report.** A turn that ends stuck is an ordinary assistant message; the driver reads it
  in `result`. The task text should ask for a fixed shape ("STUCK at step N: what I see, what
  I tried, what I need"), and the step results in the transcript (`tool Take …` lines, kept in
  full up to `FULL_CAP` like `SpawnAgent`'s: `Take` joins `FULL_TRANSCRIPT_TOOLS`) are the
  evidence.
- **The MCP server block** the driver's repo adds, with invented paths (`examples/mcp/` gets a
  `claude-code.windows.json` beside the Claude Desktop ones):

```json
{
  "mcpServers": {
    "king-louie": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\KingLouie\\app\\bin\\king-louie-service.js", "mcp", "--data-dir", "C:\\ProgramData\\KingLouie\\data"]
    }
  }
}
```

- **A driver's guide**, `docs/driving-king-louie.md`: the tools, the loop, the take, what a
  good task looks like (script in steps, intent in a sentence per step, the STUCK shape), what
  refuses and why, and the setup in §12. It is what the Claude Code session reads instead of
  guessing at the DOM.

## 12. Setting up the desktop (no code)

Part one ships before any code and is a checklist in `docs/driving-king-louie.md`:

1. Install the service on the desktop as an agent node (`install`, `LOCAL SERVICE`); enrol
   the phone (`enroll-device`); `identity record`.
2. `node.yaml`: `gui: enabled: true`, `gui.take: { enabled: true, max_minutes: 240 }`,
   `gui.apps` with `chrome` and the apps to be demoed, `gui.browser: chrome` (the id of that
   entry), `gui.recorder.ffmpeg` if not on `PATH`; `delegate.max_sessions` as wanted.
3. `session install --user <owner>`; sign in once so the helper starts; `session status` says
   enabled.
4. Pair the desktop app (`desktop pair`), attach it; `import --from` the standalone profile.
5. Install ffmpeg (`winget install Gyan.FFmpeg`).
6. Add the MCP server block to the driver's repo; run `list_machines` from the driver to see
   the node.

What to verify there and record in the guide (§15): that the owner's account, running
`king-louie-service mcp`, may write the courier's `outbox/` and its own `inbox/` under a
`LOCAL SERVICE` data dir; the installer's ACLs were written for the service account and the
administrator, and the courier's own header says the signatures, not the directory ACL, are
the protection.

## 13. Security notes and residuals

- **The unattended lease is a loosening of R-F5-15 by the owner's decision (R-D1-4)**,
  limited to: a kind the phone shows as unattended, 240 minutes at most, requests from local
  origins only, and every other ending untouched. A relay that kept a watch back could never
  extend it, since nothing depends on watches; it can still make a Stop late, which the
  contact rule never prevented either. Both phones show an unattended take in the banner for
  its whole life.
- **An unattended take runs while the relay is down (R-D1-7).** For that span no Stop can
  reach it; the approved duration is the only bound. A `computer_use` lease still pauses on
  `relay_unreachable` as before.
- **One tap covers many actions.** The phone sees hosts, actions, apps and a duration, not
  each click. That is the point (R-D1-5) and the risk: a take on `*.chatgpt.com` may do
  anything on ChatGPT for three hours. The sites and the credentials flag are what the owner
  reads before tapping; the take's name is one plain line so it cannot hide them.
- **The driver is trusted as the owner's account.** It runs as the owner, reads the owner's
  files and can read the recordings. Nothing here gives it more than that account has; the
  phone is still between it and the screen.
- **Chrome's debugging port** (§8) is open to the owner's own processes while a take runs.
- **A recording captures the screen**, notifications, other windows and anything a page shows,
  passwords typed by the owner included if they walk up mid-take. The take's directory is
  the user's; nothing uploads it.
- **ffmpeg is whatever `PATH` or `node.yaml` names.** The helper runs it as the user; a
  replaced binary runs as the user. Same class as any app in `gui.apps`.
- **Bash still rewrites what it likes** in a non-take delegate turn (the fleet stage 4 note).
  A take refuses shell (C-8), so a take cannot.
- **Not done in D1:** macOS and Linux recording; a take across two displays (primary only);
  keeping King Louie's own window out of frame (best effort); an attended take; a take from a
  front-door agent; audio.

## 14. Tests

- **Lease protocol:** the new vectors (§6.3) and `--check` counts updated; `tests/gui-leases.test.js`
  gains an unattended lease that passes two hours on the fake clock with no watch and is still
  usable, is not suspended by `relay_unreachable`, a `foreground_mismatch` input or a helper
  drop shorter than 30 s (the input is refused, the lease stays `active`, no resume request
  is sent), is ended by a revoke from another device, by `device_revoked` and by expiry, and
  a `computer_use` lease that still suspends at 120 s and on `relay_unreachable`; a `take`
  request from a `frontdoor` origin refused before it is signed; `tests/mobile-lease-apps.test.js`
  pins the banner words in both apps.
- **The `mcp` wait:** `tests/service-cli-mcp*.test.js` gains `wait_ms` on `get_job` and
  `send_to_job` against a fake courier: returns when the job's `session` turns `idle`,
  returns at the cap, refuses over 25 000, and every courier request it makes is a plain
  `get_job`.
- **Take policy:** `tests/take-policy.test.js` walks every browser action against a take with
  and without `credentials`, on an allowed and a disallowed host, and the shell refusal, with
  `classifyToolCall`'s tiers in place; a call the node's policy denies stays denied under a
  take.
- **Browser registry:** two runs with their own browsers, tab numbering independent; a run
  with none gets the default; `connectOverCDP` against a real headless Chromium launched by
  the test (Playwright is a dependency), never a real user session.
- **Helper ops:** `tests/session-backend-windows.test.js` pins `launch_browser` and
  `record_start`/`record_stop` by reading the worker source as it pins the input rules; a
  fake `spawn` checks the ffmpeg argv and the stop-with-`q` path; the helper refuses a
  profile dir outside its root.
- **The driver loop:** `tests/fleet-delegate*.test.js` gain `wait_ms` on both calls (returns
  on turn end, returns at the cap, refuses over 25 000), the `take` summary on `get_job`, and
  a stuck turn followed by a `send_to_job` that resumes `run_steps` from the failed index,
  with a fake helper and a fake recorder.
- **Opt-in e2e:** `KL_E2E_TAKE=1 node --test tests/e2e/demo-take.test.js` on Windows in an
  interactive session records ten seconds of a Chromium window driven through a real helper
  and checks the mp4 exists and plays (`ffprobe`); skipped otherwise, like
  `KL_E2E_GUI`.

## 15. Not verified

- Whether a `LOCAL SERVICE` process's helper connection and `launch_browser` can be made to
  work for the owner's account exactly as `launch` does today (the helper already launches
  apps as the user; the new op differs only in what it returns). Read, not run.
- The courier directory ACLs for a user-run `mcp` against a `LOCAL SERVICE` data dir (§12).
- Chrome's `--remote-debugging-port=0` writing `DevToolsActivePort` under a user-data-dir on
  Windows; it does on every version the author knows, and the builder confirms on the owner's.
- `gdigrab` frame rates on the owner's display at native size; `veryfast` is the author's
  default and the builder may change it after one recording.

## 16. What is left to the builder

- The exact shape of the take policy inside `ToolExecutor` and how it composes with
  `denyAutoApproval`, the deny patterns and the roots check (§7 says the order; the builder
  finds the seam).
- The browser registry's keying when a take's turn spawns a sub-agent (the parent's browser,
  by the re-threaded requester, is the author's expectation).
- How `Take.start` moves the attached desktop window aside (§9), or whether to leave it to the
  driver's task text in D1.
- Error words. Every code above is named; the sentences are the builder's, in the house
  style (plain, one line, no path a driver did not already know).
- The step runner's screenshot-on-failure size and format (a PNG beside the mp4 is the
  expectation).
