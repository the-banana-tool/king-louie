# Fleet Stage 5: Session helper — Implementation Plan (Part 1 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent node launches allowlisted desktop apps in the logged-in user's session through a session helper, captures those apps' windows, and — under a short phone-signed lease the owner watches and can kill — drives them with clicks, keys and text; the same request to a server or an empty desktop fails with `capability_unavailable: gui` before anything is asked.

**Architecture:** The service keeps all policy in new Electron-free modules under `src/gui/` (config, allowlist, key grammar, text guard, the `kl-session-v1` channel, the broker, the lease manager, the live view, the tools and the relay extension). The helper (`king-louie-service session`, `src/session/`) runs as the logged-in user, authenticates the service over a local pipe/socket, and runs argv-only OS workers (PowerShell + C# P/Invoke, JXA, `xdotool`/`import`). Leases are F3 envelopes: node-signed `kl.lease.request|status|view`, phone-signed `kl.lease.grant|revoke|watch`, carried over F3's relay link and mailbox. The six parts run in order on `feat/fleet-stage5`: Part 1 pure foundations and both protocols (Tasks 1–6); Part 2 the service runtime — channel, broker, leases, live view, relay routes (Tasks 7–11); Part 3 images in tool results, the tools and host wiring (Tasks 12–14); Part 4 the helper process and the three OS backends (Tasks 15–18); Part 5 login start, the `session` CLI and the e2e (Tasks 19–21); Part 6 the mobile apps (Tasks 22–25).

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `node:crypto` (HMAC, HKDF, AES-256-GCM, Ed25519, P-256), `net` (named pipes / Unix sockets), `child_process` (argv-only). OS tools: Windows PowerShell 5.1 + `Add-Type` C#, `System.Drawing`; macOS `osascript -l JavaScript`, `screencapture`, `sips`, `open`; Linux `xdotool`, ImageMagick `import`, `loginctl`. Swift (KLProtocol package, SwiftUI) and Kotlin (protocol module, Compose) for the apps. **No new npm dependency.**

**Spec:** `docs/superpowers/specs/2026-09-23-fleet-stage5-session-helper.md`. **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md` (§3, §4.12, §4.13, §4.15–4.17, §4.23, §5). **Parent:** `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md` §4.6. Executors read the spec beside this plan; where they disagree, the Deviations list below wins.

**Before Task 1:** the worktree has no `node_modules`. Run `npm ci` once in `king-louie-wt/fleet-stage5`, then `npm test` and confirm `# fail 0` on the untouched branch, so any later failure is this plan's.

## Owner questions

Only the owner can answer these. The plan proceeds with the recommended default in each case; changing a default touches only the task named.

1. **The live lease view on Android.** Every device-signed request on Android is a biometric prompt (F3's key parameters; F4 Deviation 30). The spec has the phone sign `kl.lease.watch` every 20 s and long-poll views with device-signed requests, which on Android would prompt continuously. **Recommended default (the plan does this, Task 25):** on Android the live lease screen fetches on tap — "Refresh" signs one watch and one view fetch (the prompts Android requires), the kill switch is always one prompt, and a `lease` push or the banner opens the screen without fetching. iOS streams as the spec says, signing the watch with the already-unlocked API session (Task 24). The alternative (a separate non-biometric view key) is F3 app v2 work the spec defers.
2. **Installing the helper for a second user.** The spec runs one session user per node, and `session install --user NAME` rewrites the canonical secret each run. Installing for user B while user A is installed would leave A's autostart entry and per-user copy behind, pointing at a secret that no longer works. **Recommended default (Task 20):** `session install --user B` refuses with `session_user_mismatch: installed for "A"; run "session uninstall --user A" first`, and re-running install for the same user rotates as the spec says.

## Global Constraints

Program §3 and project rules, verbatim where they are quoted:

- Tests: `node --test`, **never Jest**. Pass = `# fail 0` / `# pass N` in the TAP summary. Run one file with `node --test tests/<file>.test.js`; the full suite with `npm test`. E2E needs `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`.
- Logging through `createLogger` (`src/logging.js`); no bare `console.*` anywhere in `src/` (CLI output goes to `io.stdout`/`io.stderr`, as `src/service/cli.js` does).
- `src/` outside `src/ipc/` and the Electron host is Electron-free (`tests/electron-boundary.test.js`). Everything in this plan runs under `king-louie-service`; `src/gui/` and `src/session/` never require `electron`.
- **No new native npm dependencies** (and no new npm dependency at all in this stage, spec §14): HMAC, HKDF, AES-GCM, Ed25519 and P-256 come from `node:crypto`; JCS is `src/platform/jcs.js`; image encoding is the OS's (`System.Drawing`, `sips`, `import`).
- Approval requesters return `true | false | 'timeout' | 'unavailable'`; **only `=== true` approves**. A truthy string (`'yes'`, `'approved'`) never does.
- Security-relevant configuration is read only from the root/admin-owned config dir in service mode: `gui.*` from `<configDir>/node.yaml`, the session secret from `<configDir>/session/helper-secret.json`, the per-user copies from `<configDir>/session/users/`. **The data dir never decides policy**: `<dataDir>/session/status.json` is output only and grants nothing.
- Trust principle 3 (fleet §3.1): remote-origin unsafe actions run only with a fresh, single-use phone signature over the exact action. The computer-use lease is the one bounded exception, and it is itself phone-signed, app-limited, time-limited (≤ 60 min) and node-clock-expired.
- Tool results are `{ ok: true, … }` / `{ ok: false, error }`; gate refusals are results, never throws. GUI tools turn every `GuiError` into `{ ok: false, error: '<code>[: detail]' }`.
- e2e never touches the real profile: `tests/e2e/session-helper.test.js` builds a temp config dir and data dir, passes `KL_SESSION_FILE`, and never reads or writes the real admin config dir, data dir or a real `LaunchAgents`/autostart/Task Scheduler entry.
- The repo is open source: no personal names, machines, domains or paths in code, fixtures or docs. Use `example.com`, `kl.example.com`, `gpu-box`, `web-01`, `mac`, user `alice`, and the fixed test keys in `tests/vectors/approval-v1/keys.json`.
- F5 must not change F3's or F4's message shapes (program §4.13): the 41 approval-v1 vectors and the 37 client-grant-v1 vectors stay byte-for-byte; `lease-v1` and `session-v1` get their own directories and generators.
- Every file F5 writes is written atomically (temp + rename) or with `O_CREAT|O_EXCL` as the spec says; user-home files are written only by a child running as that user.
- Tests that touch an admin config dir inject `configDir`/`adminUid`/`rootUid`/`geteuid`; they never use the real per-platform dir. Tests that await unref'd timers call `holdEventLoop()` from `tests/helpers/hold-event-loop.js`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

Fleet stage 5 spec values (exact):

- Helper channel: at most 4 unauthenticated connections, each closed after 5 s; one authenticated helper; a newcomer is refused `helper_already_connected` while the current one answers `ping` within 5 s, and replaces it otherwise (audited). `ping` every 10 s; closed after 30 s silent. Pre-`ready` frames ≤ 16 KiB, sealed frames ≤ 8 MiB.
- Sealing: `keys = HKDF-SHA256(secret, salt = empty, info, 64)`; `k_sh = keys[0..32]`, `k_hs = keys[32..64]`; frame `len(4,BE) ‖ seq(8,BE) ‖ AES-256-GCM ciphertext ‖ tag(16)`, `iv = dir(1) ‖ 0x000000 ‖ seq(8)`, `aad = 'kl-session-v1' ‖ dir ‖ seq`; `dir` `0x01` service → helper, `0x02` helper → service; `seq` from 1 per direction; anything but last + 1 closes.
- Op timeouts: 10 s, `screenshot` 20 s, `launch` 30 s. Helper reconnect backoff `1, 2, 5, 10, 30 s`; re-probe every 60 s.
- Leases: one `pending|active|suspended` lease per node; request `expires_at` = +5 min; `1 ≤ grant.minutes ≤ min(lease.max_minutes, gui.lease.max_minutes, 60)`; expiry `verified_at + minutes` on the node clock, a resume never extends; nonce caches 10 min; leases memory-only.
- Live view: watch lasts 60 s (phone renews every 20 s); frames every `interval_s` (default 3, 1–5) plus one after an input, **≤ 1 frame/s in total**; `max_width` 960, JPEG `quality` 60; `max_frame_bytes` default and max 184320 (re-capture once at quality − 20, else `frame: null, frame_dropped: true`); a view ≤ 256 KiB; ≤ 50 actions per view, 200 kept per lease.
- Tools: `max_inputs_per_minute` default 120 (10–600); screenshots kept per job: last 16, 10 min; ≤ 5 images per iteration; the last 3 screenshots stay in the conversation.
- Text guard: ≤ 2000 characters; typed buffer = the last 2000 printable characters, reset on `enter` and on a foreground change; the pinned secret regexes of spec §3.8; entropy rule `/\S{24,}/`, ≥ 4.0 bits/char and ≥ 3 character classes, except a plain `http(s)` URL; vault values ≥ 8 characters.
- Mailbox type `kl.lease.` with `ttlMs: 300000`, `maxBytes: 262144`; relay RPC timeout 10 s; `GET /v1/leases?wait=0..25`.

## Review Focus

Five conditions the spec implies but no spec-listed test reaches, most likely first. Each line's test is added to the task that owns the code:

1. **The owner changes display scaling or moves the window to another monitor mid-lease** (`displays_changed`): every kept screenshot of the job becomes `stale_screenshot`; a click from an old screenshot is refused rather than landing at the old coordinates. Test: `gui-broker › displays_changed invalidates every kept screenshot` (Part 2, Task 8).
2. **The node sleeps (laptop lid) through a lease's expiry**, so the expiry timer fires late: the next input is `lease_expired` because `assertUsable` compares the node clock itself, never trusting that the timer already ran. Test: `gui-leases › an input after expires_at is refused even when the expiry timer has not fired` (Part 2, Task 9).
3. **A UAC prompt, a credential dialog on the secure desktop or the lock screen appears between two inputs**: the helper reports `screen_locked`; the lease is not suspended, nothing is injected, and the lease clock keeps running. Test: `gui-leases › screen_locked from the helper refuses without suspending` (Part 2, Task 9).
4. **Non-English prose without spaces** (a Japanese or Chinese sentence with a number and a Latin word): not refused as `text_looks_secret`, because the entropy rule looks at runs of printable ASCII (Deviation 26), so the sentence never forms one long run; and a 2000-emoji text passes the length rule (code points, not UTF-16 units) while 2001 fails. Test: `gui-text-guard › CJK prose and emoji are not secrets; length counts code points` (Part 1, Task 3).
5. **The owner closes the leased app's window while its process keeps running** (tray apps): a click on a screenshot of that window is `stale_screenshot`, not a suspension, and not a click at the old coordinates on whatever is there now. Test: `gui-broker › a screenshot whose window is gone is stale` (Part 2, Task 8).

## Interfaces from other stages

| Contract | On main d84f4c9 | This plan |
|---|---|---|
| F3 P2 `seal`, `open`, `nodeSigner`, `verifyEs256`, `verifyEd25519` (`src/approvals/envelope.js`) | exists | used as is |
| F3 P3 `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces })`, `NonceCache`, `bytesSha256` (`src/approvals/verify-device.js`) | exists; needs the type registered with `registerMessageValidator` | Task 6 registers the six `kl.lease.*` validators on load (as C4's `mobile-app-channel.js` does) |
| F3 P9 `startApprovals(...) → { phoneApprover, auditLedger, relayClient, approverStore, identity, courierPump, stop }` | exists; `relayClient` is null without a relay pin | the `approvals` argument of `createGuiSubsystem` (Task 14) |
| F3 P10/P11 `relayClient.send(envelope, { push, to_device })`, `registerMethod`, `isConnected()`, `on('connected'/'disconnected')` | exists; **`send` rejects with `relay_offline` while the link is down** | Task 9 keeps unexpired requests and re-sends them on `connected` (Deviation 12) |
| F3 P15–P18 `phoneApi.registerRoute`, `nodeHub.rpc`, `mailbox.registerType`, `src/frontdoor/extensions.js`, push kind `lease` | exists; an extension is `(relay) => void` receiving `{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }`; push `KINDS` already includes `lease` | Task 11 adds one line to `extensions.js` |
| F3 P20 `auditLedger.append({ kind, data })` (async) | exists | every `gui.*`/`lease.*` entry |
| F3 P23/P24 `classifyToolCall`, `READ_TOOLS`, `patternMatch`, `SHELL_SEPARATORS` | exists | Task 13 adds `Screenshot`, `ListApps` to `READ_TOOLS` |
| F3 `core.context.getPhoneApprover()` | exists (null unless `isAvailable()`) | `RequestLease` refuses `signed approval unavailable` when `phoneApprover.isAvailable()` is false |
| F4 `extraToolOptions.origin` (`src/core/create-core.js:2064`) | exists: every tool gets `options.origin = { client, session, job_id }` | the tools' job id (Task 13) |
| F4 `DelegateSessions({ leaseManager })` calls `leaseManager.endForJob(jobId, 'job_closed')` on close; `startFleetNode({ deps: { leaseManager } })` | exists | Task 14 passes `gui.leases` (Deviation 6) |
| F4 `defaultReadGuiStatus()` in `src/fleet/start.js` requires `src/gui/status` when present; `FleetToolHandler` adds `gui` to `list_machines`/`describe_machine` | exists | Task 8 supplies `readGuiStatus`; Task 14 adds `'gui'` to `capabilities` (Deviation 7) |
| F7 desktop UI helper status | merged; reads nothing of F5 yet | untouched (F7 reads `readGuiStatus` in a later change; spec §2.2) |
| C7 `getCapabilities().vision` | not merged | Task 12 uses the retry-without-images path only |

## Deviations (current code vs the spec, resolved from the spec's intent)

1. **`integer` parameters.** `Tool.validateParameters` (`src/tools/tool-schema.js`) knows `string|number|boolean|array|object` only and throws on `type: 'integer'`; it also ignores `additionalProperties`. Task 12 adds `integer` (with `minimum`/`maximum`) to it, and every GUI tool checks its own params strictly (`checkParams`, Task 13), so the schemas stay typed with `additionalProperties: false` as §3.9 says.
2. **`emitsImages` needs the `Tool` class.** `Tool`'s constructor copies only known fields; Task 12 adds `this.emitsImages = config.emitsImages === true` (spec §7 does not list `tool-schema.js`).
3. **Where `_images` is lifted.** `ToolExecutor` emits `postExecute` with the tool's result before the agent loop sees it, and `src/ipc/chat-handlers.js` saves that result to chat storage (`appendMessageToChat(chatId, 'toolResult', …)`). Stripping in `agent-loop.js` alone would persist base64 screenshots. So `ToolExecutor` detaches `_images` right after `tool.execute` — kept (as a non-enumerable symbol property, invisible to `JSON.stringify` and spreads) only for a tool with `emitsImages: true`, deleted for every other tool — and the loop lifts them from that symbol (`src/execution/tool-images.js`). The spec's outcome (never persisted, exported or shown to non-image tools) is unchanged.
4. **Several tool calls in one iteration.** The loop uses `buildMultiToolMessages` when a response has more than one call; the Anthropic provider's `buildMultiToolMessages` also takes images per entry (`entry.images`), placed inside that entry's `tool_result`, beside the spec's 4th argument to `buildToolMessages`.
5. **Job id.** F4 already hands every tool `options.origin` (the run's `{ client, session, job_id }`); a delegate turn's `job_id` is its node job id. The tools use `options.origin.job_id`, else `chat:<options.chatId>`, else `chat:local` (§3.9's fallback, made total).
6. **`endForJob` arrives now.** `DelegateSessions` already calls `leaseManager.endForJob(jobId, 'job_closed')` and `startFleetNode` accepts `deps.leaseManager`; run.js passes `gui.leases`, so job-scoped leases work in this stage rather than wave 4. `jobOpen(jobId)` for grant check 12 reads the fleet `JobManager` (open unless it knows the job and it is terminal).
7. **The MCP `gui` block.** F4's `FleetToolHandler` (both the stdio server and the service path) already adds `readGuiStatus({ dataDir })`'s result as `gui` to `list_machines` and `describe_machine` when `src/gui/status.js` exists, so `src/mcp/stdio-server.js` is not edited. Task 14 makes the handler add `'gui'` to `capabilities` while `gui.available`, and `readGuiStatus` returns exactly the MCP-safe block `{ available, capabilities, apps: [{ id, name }], limits, lease: { active } | null }` (no paths, no `args` globs). The front door's own `list_machines` (cached catalog) stays without `gui` (spec §13).
8. **Module graphs.** `src/service/node-config.js` loads on every profile and now requires `src/gui/config.js`; F4's `src/fleet/start.js` requires `src/gui/status.js` on the runbook profile. Both stay dependency-free (Node built-ins, `src/gui/errors.js`, `src/service/pidfile.js`), and `tests/service-profile-graph.test.js` forbids `src/gui/` except `config.js`, `errors.js`, `status.js` (and `relay-extension.js`, `lease-protocol.js` on the relay and front-door graphs), and all of `src/session/`.
9. **`gui` on the front door.** §3.4 forces `enabled: false` on `profile: runbook`; `profile: frontdoor` gets the same (neither runs a helper), and `parseGuiConfig` always returns the full shape with `enabled: false` rather than a bare `{ enabled: false }`, so no consumer null-checks.
10. **`<configDir>/session` is `0755`, not `0750`.** The per-user copies live in `<configDir>/session/users/`, which the helper (a normal user) must reach; a `0750 root:<svc>` `session` dir would lock it out. The canonical file's own `0640 root:<svc>` mode protects it; `users/` stays root-owned `0755` and each copy `0600` owned by its user.
11. **Components checked for reparse points.** "Every path component" is checked by requiring the admin config dir to equal its own `realpath` (so no link anywhere above it) and `lstat`-ing each component below it; the result is the spec's check without refusing a platform whose `/var` or temp dir is itself a system symlink above a test root.
12. **Lease requests while the relay is down.** `RelayClient.send` rejects with `relay_offline` when the link is down; the lease manager keeps an unexpired request (or resume) and re-sends it on `connected`, like approvals (R16), instead of failing the tool.
13. **The service account for the POSIX socket dir** is the owner of `--data-dir` (uid and gid from `fs.statSync(dataDir)`), the account the installers created; `session install` has no separate flag for it.
14. **Node id for `session install`.** The canonical file records `node_id`; `session install` reads it from the service's own identity record (`<dataDir>/chat-data.json`, key `mesh.identity`, `deriveNodeId(publicKey)`), which needs no master key; the master key is only resolved to write the `klc1:` secret, read-only (`resolveMasterKeyReadOnly` + `verifyKeyCheck({ create: false })`, as `import` does). No identity or no key yet → `start the service once first`.
15. **The helper's file path.** The helper cannot know a non-default config dir, so the autostart entries pass `session --session-file <path>`; `KL_SESSION_FILE` is still honoured (flag first, then the variable, then the platform default `adminConfigDir(defaultServiceDataDir())/session/users/<user|SID>.json`).
16. **CLI shape.** `src/service/cli.js` dispatches `{ sub, arg, flags, dataDir, io }` objects, not `(positionals, flags, io)`; `session` follows that, adds the value flag `--session-file`, and uses the existing `--user`/`--dry-run`.
17. **App launches are not hidden.** `windowsHide: true` sets `SW_HIDE` in the child's `STARTUPINFO`, which many Windows GUI apps honour for their first window; workers and tools spawn with `windowsHide: true`, but `LaunchApp`'s own child uses `windowsHide: false` (still `shell: false`, argv only).
18. **Helper log file names.** `attachServiceLogFile` gains a `{ name }` option so the helper writes `helper.log`/`session.log` in the per-OS directories §3.3 names.
19. **HKDF `info` encoding.** §3.2 writes `'kl-session-v1 keys' ‖ node_id ‖ nonce_h ‖ nonce_s`; the plan fixes the bytes as UTF-8 of the label, UTF-8 of `node_id` (always 19 characters) and the **raw 32 bytes** of each nonce, so there is no separator ambiguity. `docs/protocol/session-v1.md` and the vectors pin it.
20. **A refused newcomer.** §3.2 refuses a second helper with `helper_already_connected` after it authenticates; the service sends it one plain frame `{ "t": "error", "code": "helper_already_connected" }` in place of `ready` and closes. `session-v1.md` lists it.
21. **iOS signs `kl.lease.watch` with the API session.** A watch grants nothing (it only asks for frames of a lease the owner already granted, to a device the node already trusts), so iOS signs it like its API requests, without a fresh Face ID prompt every 20 s; grants, denies and the kill switch keep their fresh prompt. Android: Owner question 1.
22. **`tests/examples.test.js` needs no edit.** It reads `NODE_YAML_KEYS` from `node-config.js`, so adding `gui` there covers §7's "`NODE_YAML_KEYS += gui`".
23. **Phone-side lease vectors.** `view-tampered-frame` is a correctly node-signed view whose `frame.sha256` does not match its `frame.data` (reason `frame_hash_mismatch`): a byte flipped in the payload would fail the signature first and test nothing new.
24. **Vector `given` for leases** adds `allow_test_keys` and `node.key` (the node's SPKI hex), which the node-side runner and the phones need, beside §4.1's listed keys.
25. **`capability_unavailable` detail.** A missing sub-capability is `capability_unavailable: gui.input` (etc.); no helper at all is `capability_unavailable: gui`, as §9 shows.
26. **The entropy rule's runs.** §3.8 says "a whitespace-free run `/\S{24,}/`". A Japanese or Chinese sentence has no spaces, so it forms one long run with high entropy and, with one Latin word and a number, three character classes: ordinary prose would be refused. The rule runs over runs of printable ASCII (`/[!-~]{24,}/`) instead; every secret shape it targets is ASCII, and the pinned regexes and the vault rule still see the whole text (Review Focus 4).
27. **macOS typing of non-ASCII text** (Task 17). `CGEventKeyboardSetUnicodeString` needs a `const UniChar *` buffer the JXA bridge does not document how to build. The macOS worker types ASCII with key codes (Accessibility only) and sends non-ASCII runs through `System Events` `keystroke` in the same worker call (the Automation permission for System Events; probe check `automation`); without it a non-ASCII `Type` is refused `invalid_text`. The foreground, bounds, lock and human checks still run first in that call.
28. **A read-only `hitTest` on each backend** (Tasks 16–18). The backend tests must exercise the hit test without injecting input into the tester's desktop, so each backend also exposes `hitTest({ x, y })`. It is not a `kl-session-v1` op, and `createOpHandler` never routes to it.
29. **History needs no new store** (Tasks 24–25). The node's audit slice (F3's `/v1/nodes/{id}/history`, F4's mirror on a front door) already carries every `lease.*` and `gui.*` entry; the apps only label those kinds "Computer use".
30. **`status.json` carries `apps`.** §4.5 lists no apps, but `readGuiStatus` must return `apps: [{ id, name }]` (§5.2) without reading `node.yaml`; the broker writes the allowlist's ids and names (never paths) into `status.json`.

---

### Task 1: GUI errors, `gui:` configuration and the module-graph rules

**Files:**
- Create: `src/gui/errors.js`
- Create: `src/gui/config.js`
- Modify: `src/service/node-config.js` (require + `NODE_YAML_KEYS` + `defaultNodeConfig` + return value)
- Modify: `src/service/doctor.js` (a `gui` warnings row after "node configuration loaded")
- Modify: `tests/service-profile-graph.test.js` (forbid `src/gui/` and `src/session/` with the Deviation 8 exceptions)
- Test: `tests/gui-config.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `src/gui/errors.js`: `class GuiError extends Error { code, detail, info }` (`new GuiError(code, detail = null, extra = {})`, message `code` or `code: detail`); `GUI_ERROR_CODES` (frozen array); `isGuiError(err) → boolean`; `toToolResult(err) → { ok: false, error, retry_after? }` (`approval_unavailable` → `'signed approval unavailable'`, a non-GuiError → `'gui_error: <message>'`); `fromWire(error) → GuiError` (helper `res.error` `{ code, message, detail }`; unknown code → `backend_failed`; `info` = the wire `detail` object).
  - `src/gui/config.js`: `parseGuiConfig(raw, { profile = 'agent', platform = process.platform, file = 'node.yaml' }) → GuiConfig`; `GUI_KEYS`; `APP_ID_RE`; `GUI_DEFAULTS`. `GuiConfig = { enabled, apps: { [id]: { id, name, path, processes: string[], args: string[] } }, screenshot: { maxWidth, quality }, liveView: { intervalS, maxWidth, quality, maxFrameBytes }, lease: { defaultMinutes, maxMinutes, yieldMs, maxInputsPerMinute }, warnings: string[] }`.
  - `loadNodeConfig(...)` returns `gui: GuiConfig`; `NODE_YAML_KEYS.top` includes `'gui'` and `NODE_YAML_KEYS.gui = GUI_KEYS.top`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-config.test.js`:

```js
// tests/gui-config.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig, GUI_KEYS } = require('../src/gui/config');
const { GuiError, toToolResult, fromWire, isGuiError } = require('../src/gui/errors');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function configDirWith(yaml) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-config-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  fs.writeFileSync(path.join(config, 'node.yaml'), yaml, { mode: 0o644 });
  return config;
}

describe('GuiError', () => {
  it('carries a code and turns into a tool refusal', () => {
    const err = new GuiError('capability_unavailable', 'gui');
    assert.ok(isGuiError(err));
    assert.equal(err.message, 'capability_unavailable: gui');
    assert.deepEqual(toToolResult(err), { ok: false, error: 'capability_unavailable: gui' });
    assert.deepEqual(toToolResult(new GuiError('approval_unavailable')), { ok: false, error: 'signed approval unavailable' });
    assert.deepEqual(toToolResult(new GuiError('rate_limited', null, { retryAfter: 7 })), { ok: false, error: 'rate_limited', retry_after: 7 });
    assert.deepEqual(toToolResult(new Error('boom')), { ok: false, error: 'gui_error: boom' });
  });

  it('maps helper errors, and an unknown code to backend_failed', () => {
    const e = fromWire({ code: 'foreground_mismatch', message: 'x', detail: { image: 'C:\\Windows\\explorer.exe', pid: 4 } });
    assert.equal(e.code, 'foreground_mismatch');
    assert.deepEqual(e.info, { image: 'C:\\Windows\\explorer.exe', pid: 4 });
    assert.equal(fromWire({ code: 'rm -rf', message: 'x' }).code, 'backend_failed');
    assert.equal(fromWire(null).code, 'backend_failed');
  });
});

describe('parseGuiConfig', () => {
  it('fills every default on an agent node', () => {
    const g = parseGuiConfig(undefined, { profile: 'agent', platform: 'linux' });
    assert.equal(g.enabled, true);
    assert.deepEqual(g.apps, {});
    assert.deepEqual(g.screenshot, { maxWidth: 1280, quality: 70 });
    assert.deepEqual(g.liveView, { intervalS: 3, maxWidth: 960, quality: 60, maxFrameBytes: 184320 });
    assert.deepEqual(g.lease, { defaultMinutes: 15, maxMinutes: 60, yieldMs: 2000, maxInputsPerMinute: 120 });
    assert.deepEqual(g.warnings, []);
  });

  it('is forced off on the runbook and frontdoor profiles, even when written', () => {
    for (const profile of ['runbook', 'frontdoor']) {
      const g = parseGuiConfig({ enabled: true, apps: { calc: '/usr/bin/gnome-calculator' } }, { profile, platform: 'linux' });
      assert.equal(g.enabled, false);
      assert.deepEqual(g.apps, {});
    }
  });

  it('reads the string shorthand and the full form', () => {
    const g = parseGuiConfig({
      apps: {
        textedit: '/System/Applications/TextEdit.app',
        calculator: { name: 'Calculator', path: '/System/Applications/Calculator.app', processes: ['/System/Applications/Calculator.app/Contents/MacOS/*'], args: ['--x=*'] }
      }
    }, { platform: 'darwin' });
    assert.deepEqual(g.apps.textedit, { id: 'textedit', name: 'textedit', path: '/System/Applications/TextEdit.app', processes: [], args: [] });
    assert.equal(g.apps.calculator.name, 'Calculator');
    assert.deepEqual(g.apps.calculator.args, ['--x=*']);
  });

  it('warns about a bare process basename and accepts it', () => {
    const g = parseGuiConfig({ apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] } } }, { platform: 'win32' });
    assert.deepEqual(g.apps.calculator.processes, ['CalculatorApp.exe']);
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /gui\.apps\.calculator\.processes.*CalculatorApp\.exe.*bare name/);
  });

  it('refuses malformed keys, with the key path named', () => {
    const bad = [
      [{ nope: 1 }, /unknown key "gui\.nope"/],
      [{ apps: { Calc: '/usr/bin/x' } }, /gui\.apps\.Calc/],
      [{ apps: { calc: { path: '/usr/bin/x', colour: 'red' } } }, /unknown key "gui\.apps\.calc\.colour"/],
      [{ apps: { calc: 'relative/x' } }, /absolute path/],
      [{ apps: { calc: '/usr/../bin/x' } }, /"\.\."/],
      [{ apps: { calc: '/usr/bin/x\u2215y' } }, /lookalike/],
      [{ screenshot: { max_width: 100 } }, /gui\.screenshot\.max_width must be an integer from 320 to 1920/],
      [{ live_view: { max_frame_bytes: 200000 } }, /gui\.live_view\.max_frame_bytes/],
      [{ lease: { default_minutes: 30, max_minutes: 20 } }, /default_minutes must not exceed gui\.lease\.max_minutes/],
      [{ apps: { calc: { path: '/usr/bin/x', processes: Array(17).fill('/usr/bin/y') } } }, /at most 16/],
      [{ enabled: 'yes' }, /gui\.enabled must be true or false/],
      ['on', /gui must be a mapping/]
    ];
    for (const [raw, re] of bad) assert.throws(() => parseGuiConfig(raw, { platform: 'linux', file: '/etc/king-louie/node.yaml' }), re, JSON.stringify(raw));
  });

  it('needs an .exe on Windows', () => {
    assert.throws(() => parseGuiConfig({ apps: { calc: 'C:\\Tools\\calc.bat' } }, { platform: 'win32' }), /\.exe/);
    assert.throws(() => parseGuiConfig({ apps: { calc: '\\\\server\\share\\calc.exe' } }, { platform: 'win32' }), /absolute path/);
  });

  it('exposes its key lists', () => {
    assert.deepEqual(GUI_KEYS.top, ['enabled', 'apps', 'screenshot', 'live_view', 'lease']);
  });
});

describe('node.yaml gui:', () => {
  it('loadNodeConfig parses gui and lists it in NODE_YAML_KEYS', () => {
    assert.ok(NODE_YAML_KEYS.top.includes('gui'));
    assert.deepEqual(NODE_YAML_KEYS.gui, GUI_KEYS.top);
    const appPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\notepad.exe' : '/usr/bin/gedit';
    const config = configDirWith(`name: mac\nprofile: agent\ngui:\n  apps:\n    notes: '${appPath}'\n`);
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.equal(node.gui.apps.notes.path, appPath);
  });

  it('a runbook node.yaml with gui loads, with gui off', () => {
    const config = configDirWith('name: web-01\nprofile: runbook\ngui:\n  enabled: true\n');
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, false);
  });

  it('a malformed gui block stops the node from loading', () => {
    const config = configDirWith('name: mac\ngui:\n  bogus: 1\n');
    assert.throws(() => loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 }), /unknown key "gui\.bogus"/);
  });

  it('no node.yaml at all still gives the gui defaults', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-none-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const node = loadNodeConfig({ adminConfigDir: base, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.deepEqual(node.gui.apps, {});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-config.test.js`
Expected: FAIL with `Cannot find module '../src/gui/config'`.

- [ ] **Step 3: Write `src/gui/errors.js`**

```js
// src/gui/errors.js
// Fleet stage 5 error codes (spec §9). A GuiError's code is what a GUI tool
// returns as { ok: false, error: '<code>[: detail]' }; the session helper
// sends the same codes over kl-session-v1 in res.error.code. Dependency-free:
// the runbook profile loads this file through src/gui/config.js.
const GUI_ERROR_CODES = Object.freeze([
  'capability_unavailable', 'invalid_params', 'app_not_allowlisted', 'app_type_not_supported', 'file_not_found',
  'path_changed', 'app_required', 'app_not_running', 'stale_screenshot', 'window_minimized', 'outside_window',
  'point_obscured', 'foreground_mismatch', 'user_active', 'screen_locked', 'target_elevated', 'invalid_text',
  'text_matches_always_confirm', 'text_looks_secret', 'key_invalid', 'key_denied', 'middle_click_denied',
  'rate_limited', 'lease_required', 'lease_suspended', 'lease_expired', 'lease_revoked', 'lease_busy',
  'lease_pending', 'lease_denied', 'lease_request_expired', 'approval_unavailable', 'helper_disconnected',
  'helper_already_connected', 'frame_rejected', 'auth_failed', 'op_timeout', 'unknown_op', 'backend_failed',
  'session_not_installed', 'session_file_insecure', 'session_user_mismatch', 'unsafe_path', 'user_not_found',
  'home_missing', 'cancelled'
]);

class GuiError extends Error {
  constructor(code, detail = null, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GuiError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
    this.info = {};
    Object.assign(this, extra);
  }
}

function isGuiError(err) {
  return err instanceof GuiError || Boolean(err && err.name === 'GuiError' && typeof err.code === 'string');
}

// F3's refusal words for "no phone can sign" are kept exactly.
function toToolResult(err) {
  if (!isGuiError(err)) return { ok: false, error: `gui_error: ${err && err.message ? err.message : String(err)}` };
  if (err.code === 'approval_unavailable') return { ok: false, error: 'signed approval unavailable' };
  const out = { ok: false, error: err.message };
  if (err.retryAfter !== undefined) out.retry_after = err.retryAfter;
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A helper's res.error: { code, message, detail }. The helper is the user's
// process, so an unknown code never becomes one the service acts on.
function fromWire(error) {
  const code = isPlainObject(error) && GUI_ERROR_CODES.includes(error.code) ? error.code : 'backend_failed';
  return new GuiError(code, null, { info: isPlainObject(error) && isPlainObject(error.detail) ? error.detail : {} });
}

module.exports = { GuiError, GUI_ERROR_CODES, isGuiError, toToolResult, fromWire };
```

- [ ] **Step 4: Write `src/gui/config.js`**

```js
// src/gui/config.js
// node.yaml `gui:` (fleet stage 5 spec §4.4). Read only from the admin config
// dir by loadNodeConfig; a present but malformed key throws with its path,
// as everywhere else in node.yaml. Dependency-free (the runbook and
// front-door profiles load it through node-config.js).
const path = require('path');

const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const GUI_KEYS = Object.freeze({
  top: Object.freeze(['enabled', 'apps', 'screenshot', 'live_view', 'lease']),
  app: Object.freeze(['name', 'path', 'processes', 'args']),
  screenshot: Object.freeze(['max_width', 'quality']),
  live_view: Object.freeze(['interval_s', 'max_width', 'quality', 'max_frame_bytes']),
  lease: Object.freeze(['default_minutes', 'max_minutes', 'yield_ms', 'max_inputs_per_minute'])
});
// [min, max, default, camelCase name] per key.
const RANGES = Object.freeze({
  screenshot: { max_width: [320, 1920, 1280, 'maxWidth'], quality: [30, 90, 70, 'quality'] },
  live_view: {
    interval_s: [1, 5, 3, 'intervalS'], max_width: [320, 1280, 960, 'maxWidth'],
    quality: [30, 85, 60, 'quality'], max_frame_bytes: [32768, 184320, 184320, 'maxFrameBytes']
  },
  lease: {
    default_minutes: [1, 60, 15, 'defaultMinutes'], max_minutes: [1, 60, 60, 'maxMinutes'],
    yield_ms: [0, 10000, 2000, 'yieldMs'], max_inputs_per_minute: [10, 600, 120, 'maxInputsPerMinute']
  }
});
const SECTION_NAMES = { screenshot: 'screenshot', live_view: 'liveView', lease: 'lease' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultsFor(section) {
  const out = {};
  for (const [, [, , def, name]] of Object.entries(RANGES[section])) out[name] = def;
  return out;
}

const GUI_DEFAULTS = Object.freeze({
  screenshot: Object.freeze(defaultsFor('screenshot')),
  liveView: Object.freeze(defaultsFor('live_view')),
  lease: Object.freeze(defaultsFor('lease'))
});

function disabled() {
  return {
    enabled: false,
    apps: {},
    screenshot: { ...GUI_DEFAULTS.screenshot },
    liveView: { ...GUI_DEFAULTS.liveView },
    lease: { ...GUI_DEFAULTS.lease },
    warnings: []
  };
}

function parseGuiConfig(raw, { profile = 'agent', platform = process.platform, file = 'node.yaml' } = {}) {
  const invalid = (what) => new Error(`Invalid ${file}: ${what}`);
  const unknownKey = (keyPath, known) => new Error(`Invalid ${file}: unknown key "${keyPath}" (known: ${known.join(', ')})`);
  const checkKeys = (obj, known, prefix) => {
    for (const key of Object.keys(obj)) if (!known.includes(key)) throw unknownKey(`${prefix}${key}`, known);
  };

  // Neither profile runs a session helper (§3.4, Deviation 9).
  if (profile !== 'agent') return disabled();
  const out = { ...disabled(), enabled: true };
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) throw invalid('gui must be a mapping');
  checkKeys(raw, GUI_KEYS.top, 'gui.');

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw invalid('gui.enabled must be true or false');
    out.enabled = raw.enabled;
  }

  for (const section of ['screenshot', 'live_view', 'lease']) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isPlainObject(value)) throw invalid(`gui.${section} must be a mapping`);
    checkKeys(value, GUI_KEYS[section], `gui.${section}.`);
    const target = out[SECTION_NAMES[section]];
    for (const [key, [min, max, , name]] of Object.entries(RANGES[section])) {
      if (value[key] === undefined) continue;
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
        throw invalid(`gui.${section}.${key} must be an integer from ${min} to ${max}`);
      }
      target[name] = value[key];
    }
  }
  if (out.lease.defaultMinutes > out.lease.maxMinutes) {
    throw invalid('gui.lease.default_minutes must not exceed gui.lease.max_minutes');
  }

  if (raw.apps !== undefined) {
    if (!isPlainObject(raw.apps)) throw invalid('gui.apps must be a mapping');
    for (const [id, value] of Object.entries(raw.apps)) {
      if (!APP_ID_RE.test(id)) throw invalid(`gui.apps.${id}: an app id must match ${APP_ID_RE}`);
      out.apps[id] = parseApp(id, value, { platform, invalid, checkKeys, warnings: out.warnings });
    }
  }
  return out;
}

function checkPath(value, where, platform, invalid, { exeOnly }) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${where} must be a non-empty string`);
  if (LOOKALIKE.test(value)) throw invalid(`${where} contains a null byte or a slash lookalike`);
  const absolute = platform === 'win32' ? /^[A-Za-z]:\\/.test(value) : value.startsWith('/');
  if (!absolute) throw invalid(`${where} must be an absolute path`);
  if (value.split(/[\\/]/).includes('..')) throw invalid(`${where} must not contain ".."`);
  if (exeOnly && platform === 'win32' && !/\.exe$/i.test(value)) throw invalid(`${where} must name an .exe on Windows`);
  return platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value);
}

function stringList(value, where, max, invalid) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) throw invalid(`${where} must be a list of non-empty strings`);
  if (value.length > max) throw invalid(`${where} may have at most ${max} entries`);
  return [...value];
}

function parseApp(id, value, { platform, invalid, checkKeys, warnings }) {
  const where = `gui.apps.${id}`;
  const entry = typeof value === 'string' ? { path: value } : value;
  if (!isPlainObject(entry)) throw invalid(`${where} must be a path or a mapping`);
  checkKeys(entry, GUI_KEYS.app, `${where}.`);
  const appPath = checkPath(entry.path, `${where}.path`, platform, invalid, { exeOnly: true });
  let name = id;
  if (entry.name !== undefined) {
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 64) throw invalid(`${where}.name must be 1–64 characters`);
    name = entry.name.trim();
  }
  const processes = stringList(entry.processes, `${where}.processes`, 16, invalid).map((p) => {
    if (LOOKALIKE.test(p) || p.split(/[\\/]/).includes('..')) throw invalid(`${where}.processes: "${p}" contains "..", a null byte or a slash lookalike`);
    if (!/[\\/]/.test(p)) {
      warnings.push(`${where}.processes: "${p}" is a bare name; any process with that name matches (use an absolute path or glob when you can)`);
      return p;
    }
    return checkPath(p, `${where}.processes`, platform, invalid, { exeOnly: false });
  });
  const args = stringList(entry.args, `${where}.args`, 32, invalid);
  return { id, name, path: appPath, processes, args };
}

module.exports = { parseGuiConfig, GUI_KEYS, GUI_DEFAULTS, APP_ID_RE };
```

Note: `checkPath` for a process glob such as `/System/Applications/Calculator.app/Contents/MacOS/*` normalises it with `path.posix.normalize`, which keeps the `*`.

- [ ] **Step 5: Wire `gui` into `src/service/node-config.js`**

Add the require under the existing `parseFrontDoorConfig` require:

```js
const { parseGuiConfig, GUI_KEYS } = require('../gui/config');
```

In `NODE_YAML_KEYS`, add `'gui'` to `top` and a `gui` level (the comment above it already promises "stage 5 `gui`"):

```js
const NODE_YAML_KEYS = Object.freeze({
  top: Object.freeze(['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir', 'approvers', 'frontdoor', 'delegate', 'gui']),
  policy: Object.freeze(['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']),
  remote_sessions: Object.freeze(['always_confirm', 'deny']),
  approvers: Object.freeze(['relay', 'request_ttl_s']),
  // Fleet stage 4 (R11): the front door's own block (its deeper levels are
  // checked by parseFrontDoorConfig) and an agent node's delegate sessions.
  frontdoor: FRONTDOOR_KEYS.top,
  delegate: Object.freeze(['provider', 'model', 'agent', 'idle_close', 'cwd', 'max_sessions']),
  // Fleet stage 5: desktop apps and leases; deeper levels are checked by parseGuiConfig.
  gui: GUI_KEYS.top
});
```

In `defaultNodeConfig(adminDir)`, add after `delegate`:

```js
    delegate: { ...DEFAULT_DELEGATE },
    gui: parseGuiConfig(undefined, { profile: 'agent' })
```

In `loadNodeConfig`'s return object, add after `delegate`:

```js
    delegate: parseDelegate(parsed.delegate, invalid, configFile),
    gui: parseGuiConfig(parsed.gui, { profile, file: configFile })
```

- [ ] **Step 6: Add the doctor row**

In `src/service/doctor.js`, right after `results.push({ check: 'node configuration loaded', … })`:

```js
    // Fleet stage 5 §3.4: gui.apps entries that match by bare process name.
    for (const warning of (nodeCfg.gui && nodeCfg.gui.warnings) || []) {
      results.push({ check: 'gui app allowlist', ok: true, warn: true, detail: warning });
    }
```

- [ ] **Step 7: Forbid `src/gui/` and `src/session/` in the profile graphs**

In `tests/service-profile-graph.test.js`, below `FORBIDDEN`, add:

```js
// Fleet stage 5 (Deviation 8): node-config.js needs gui/config.js on every
// profile and fleet/start.js reads gui/status.js; both are dependency-free.
// The relay and the front door also load the lease routes.
const GUI_ALLOWED = ['src/gui/config.js', 'src/gui/errors.js', 'src/gui/status.js'];
const RELAY_GUI_ALLOWED = [...GUI_ALLOWED, 'src/gui/relay-extension.js', 'src/gui/lease-protocol.js'];
const guiLeak = (p, allowed) => (p.startsWith('src/gui/') && !allowed.includes(p)) || p.startsWith('src/session/');
```

Then extend each `bad` filter:

- runbook graph: `const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)) || guiLeak(p, GUI_ALLOWED));`
- relay graph: `const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)) || p.startsWith('src/core/') || guiLeak(p, RELAY_GUI_ALLOWED));`
- frontdoor graph: `const bad = loaded.filter((p) => FRONTDOOR_FORBIDDEN.some((f) => p.startsWith(f)) || guiLeak(p, RELAY_GUI_ALLOWED));`
- both mcp graphs: add `|| guiLeak(p, GUI_ALLOWED)` to their filters.

`src/gui/lease-protocol.js` requires `src/approvals/verify-device.js`, which the relay already loads; Task 11 keeps `relay-extension.js`'s own requires to `envelope.js` and `lease-protocol.js`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/gui-config.test.js tests/service-profile-graph.test.js tests/examples.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/gui/errors.js src/gui/config.js src/service/node-config.js src/service/doctor.js tests/gui-config.test.js tests/service-profile-graph.test.js
git commit -m "feat(gui): gui errors and the node.yaml gui block

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The app allowlist — `resolveLaunch` and foreground match sets

**Batchable:** yes — with Task 3 (both are pure validation modules with table-driven tests and no shared interface).

**Files:**
- Create: `src/gui/apps.js`
- Test: `tests/gui-apps.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `patternMatch` (`src/execution/tool-patterns.js`); `realResolve`, `isPathUnderRoots` (`src/platform/path-roots.js`).
- Produces (`src/gui/apps.js`):
  - `resolveLaunch(guiConfig, policy, { app, args = [], files = [] }, { platform = process.platform, statSync = fs.statSync, realpath = realResolve } = {}) → { tier: 'routine'|'unsafe', reason, appId: string|null, exe, argv: string[], match: string[], files: string[] }`; throws `GuiError('invalid_params'|'file_not_found'|'app_type_not_supported')`.
  - `imageMatches(image, patterns, platform) → boolean`.
  - `matchSetFor(guiConfig, appIds, { realpath }) → string[]` (the union of the apps' match sets).
  - `assertPathsUnchanged({ exe, files }, { realpath = fs.realpathSync.native, platform }) → void`; throws `GuiError('path_changed', path)`. Used by the helper at spawn (Task 15).

- [ ] **Step 1: Write the failing test**

Create `tests/gui-apps.test.js`:

```js
// tests/gui-apps.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig } = require('../src/gui/config');
const { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged } = require('../src/gui/apps');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-apps-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const plat = process.platform === 'win32' ? 'win32' : 'linux';
const exe = path.join(base, plat === 'win32' ? 'tool.exe' : 'tool');
const other = path.join(base, plat === 'win32' ? 'other.exe' : 'other');
const work = path.join(base, 'work');
const outside = path.join(base, 'outside');
fs.writeFileSync(exe, '');
fs.writeFileSync(other, '');
fs.mkdirSync(work);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(work, 'in.txt'), 'x');
fs.writeFileSync(path.join(outside, 'out.txt'), 'x');

const gui = parseGuiConfig({ apps: { tool: { path: exe, processes: ['helper-*.bin'], args: ['--open=*', '--quiet'] } } }, { platform: plat });
const policy = { allowed_roots: [work] };
const opts = { platform: plat };

describe('resolveLaunch', () => {
  it('an allowlisted app with no args and files is routine', () => {
    const r = resolveLaunch(gui, policy, { app: 'tool' }, opts);
    assert.deepEqual({ tier: r.tier, reason: r.reason, appId: r.appId, exe: r.exe, argv: r.argv, files: r.files }, { tier: 'routine', reason: 'allowlisted', appId: 'tool', exe, argv: [], files: [] });
    assert.deepEqual(r.match, [exe, 'helper-*.bin']);
  });

  it('args must all match the app globs; files must be under allowed_roots', () => {
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', args: ['--open=a', '--quiet'] }, opts).tier, 'routine');
    const a = resolveLaunch(gui, policy, { app: 'tool', args: ['--exec=calc'] }, opts);
    assert.deepEqual([a.tier, a.reason], ['unsafe', 'args_not_allowlisted']);
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'in.txt')] }, opts).tier, 'routine');
    const f = resolveLaunch(gui, policy, { app: 'tool', files: [path.join(outside, 'out.txt')] }, opts);
    assert.deepEqual([f.tier, f.reason], ['unsafe', 'file_outside_allowed_roots']);
  });

  it('an absolute path that is not allowlisted is unsafe with no app id', () => {
    const r = resolveLaunch(gui, policy, { app: other }, opts);
    assert.deepEqual([r.tier, r.reason, r.appId, r.exe], ['unsafe', 'app_not_allowlisted', null, other]);
  });

  it('refuses relative paths, "..", null bytes and slash lookalikes as invalid_params', () => {
    for (const app of ['tool.exe', 'bin/tool', `${base}${path.sep}..${path.sep}x`, `${exe}\u0000`, `${base}\u2215tool`]) {
      assert.throws(() => resolveLaunch(gui, policy, { app }, opts), (e) => e.code === 'invalid_params', app);
    }
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: ['in.txt'] }, opts), (e) => e.code === 'invalid_params');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', args: Array(33).fill('--quiet') }, opts), (e) => e.code === 'invalid_params');
  });

  it('a missing file is file_not_found', () => {
    assert.throws(() => resolveLaunch(gui, policy, { app: path.join(base, plat === 'win32' ? 'missing.exe' : 'missing') }, opts), (e) => e.code === 'file_not_found');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'nope.txt')] }, opts), (e) => e.code === 'file_not_found');
  });

  it('only .exe on Windows', () => {
    const fake = { statSync: () => ({ isFile: () => true, isDirectory: () => false }), realpath: (p) => p };
    const winGui = parseGuiConfig({}, { platform: 'win32' });
    assert.throws(() => resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.bat' }, { platform: 'win32', ...fake }), (e) => e.code === 'app_type_not_supported');
    assert.equal(resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.exe' }, { platform: 'win32', ...fake }).tier, 'unsafe');
  });

  it('a .app bundle directory is launchable on macOS', () => {
    const fake = { statSync: () => ({ isFile: () => false, isDirectory: () => true }), realpath: (p) => p };
    const r = resolveLaunch(parseGuiConfig({}, { platform: 'darwin' }), policy, { app: '/Applications/Notes.app' }, { platform: 'darwin', ...fake });
    assert.equal(r.exe, '/Applications/Notes.app');
  });
});

describe('imageMatches', () => {
  it('absolute paths and globs; bare names compare the basename', () => {
    assert.ok(imageMatches('/usr/bin/gedit', ['/usr/bin/gedit'], 'linux'));
    assert.ok(imageMatches('/opt/app/bin/helper-7.bin', ['helper-*.bin'], 'linux'));
    assert.ok(!imageMatches('/usr/bin/GEDIT', ['/usr/bin/gedit'], 'linux'), 'exact on Linux');
    assert.ok(imageMatches('C:\\Program Files\\WindowsApps\\X\\CalculatorApp.exe', ['calculatorapp.exe'], 'win32'), 'case-insensitive on Windows');
    assert.ok(!imageMatches('C:\\Windows\\explorer.exe', ['C:\\Windows\\System32\\calc.exe', 'CalculatorApp.exe'], 'win32'));
  });

  it('on macOS any image inside the .app bundle matches', () => {
    assert.ok(imageMatches('/System/Applications/Calculator.app/Contents/MacOS/Calculator', ['/System/Applications/Calculator.app'], 'darwin'));
    assert.ok(!imageMatches('/System/Applications/Calculator.app.evil/x', ['/System/Applications/Calculator.app'], 'darwin'));
  });

  it('refuses an empty image', () => {
    assert.ok(!imageMatches('', ['*'], 'linux'));
    assert.ok(!imageMatches(null, ['*'], 'linux'));
  });
});

describe('matchSetFor and assertPathsUnchanged', () => {
  it('unions the leased apps', () => {
    assert.deepEqual(matchSetFor(gui, ['tool'], { realpath: (p) => p }), [exe, 'helper-*.bin']);
  });

  it('refuses a path that resolves elsewhere at spawn', () => {
    assert.doesNotThrow(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat }));
    assert.throws(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat, realpath: () => other }), (e) => e.code === 'path_changed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-apps.test.js`
Expected: FAIL with `Cannot find module '../src/gui/apps'`.

- [ ] **Step 3: Write `src/gui/apps.js`**

```js
// src/gui/apps.js
// The app allowlist (fleet stage 5 spec §3.4): what LaunchApp may start and
// at what tier, and which process images count as "the leased app" in the
// foreground. Shared with the helper (assertPathsUnchanged at spawn).
const fs = require('fs');
const path = require('path');
const { patternMatch } = require('../execution/tool-patterns');
const { realResolve, isPathUnderRoots } = require('../platform/path-roots');
const { GuiError } = require('./errors');

const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const MAX_APP = 1024;
const MAX_ITEM = 4096;

const pathImpl = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';
const hasDotDot = (p) => String(p).split(/[\\/]/).includes('..');

function isAbsoluteFor(p, platform) {
  return platform === 'win32' ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/');
}

function stringArray(value, max, where) {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== 'string' || v.length > MAX_ITEM)) {
    throw new GuiError('invalid_params', `"${where}" must be at most ${max} strings of at most ${MAX_ITEM} characters`);
  }
  return value;
}

function resolveLaunch(guiConfig, policy, request = {}, { platform = process.platform, statSync = fs.statSync, realpath = realResolve } = {}) {
  const { app, args = [], files = [] } = request;
  if (typeof app !== 'string' || app.length < 1 || app.length > MAX_APP) throw new GuiError('invalid_params', '"app" must be 1–1024 characters');
  stringArray(args, 32, 'args');
  stringArray(files, 16, 'files');
  for (const v of [app, ...args, ...files]) {
    if (LOOKALIKE.test(v)) throw new GuiError('invalid_params', 'null bytes and slash lookalikes are not allowed');
  }

  const resolvedFiles = files.map((f) => {
    if (!isAbsoluteFor(f, platform) || hasDotDot(f)) throw new GuiError('invalid_params', `a file must be an absolute path without "..": ${f}`);
    try {
      statSync(f);
    } catch {
      throw new GuiError('file_not_found', f);
    }
    return realpath(f);
  });

  const entry = Object.hasOwn(guiConfig.apps, app) ? guiConfig.apps[app] : null;
  if (entry) {
    try {
      statSync(entry.path);
    } catch {
      throw new GuiError('file_not_found', entry.path);
    }
    const exe = realpath(entry.path);
    const argsOk = args.every((a) => entry.args.some((glob) => patternMatch(glob, a)));
    const roots = (policy && policy.allowed_roots) || [];
    const filesOk = resolvedFiles.every((f) => isPathUnderRoots(f, roots));
    let reason = 'allowlisted';
    if (!argsOk) reason = 'args_not_allowlisted';
    else if (!filesOk) reason = 'file_outside_allowed_roots';
    return {
      tier: argsOk && filesOk ? 'routine' : 'unsafe',
      reason,
      appId: entry.id,
      exe,
      argv: [...args],
      match: [exe, ...entry.processes],
      files: resolvedFiles
    };
  }

  if (!isAbsoluteFor(app, platform) || hasDotDot(app)) {
    throw new GuiError('invalid_params', '"app" must be an allowlisted app id or an absolute path without ".."');
  }
  if (platform === 'win32' && !/\.exe$/i.test(app)) throw new GuiError('app_type_not_supported', 'only .exe files can be launched on Windows');
  let st;
  try {
    st = statSync(app);
  } catch {
    throw new GuiError('file_not_found', app);
  }
  const launchable = platform === 'darwin' ? (st.isFile() || (st.isDirectory() && /\.app$/i.test(app))) : st.isFile();
  if (!launchable) throw new GuiError('app_type_not_supported', `${app} is not a file this node can launch`);
  const exe = realpath(app);
  return { tier: 'unsafe', reason: 'app_not_allowlisted', appId: null, exe, argv: [...args], match: [exe], files: resolvedFiles };
}

// `*` and `?` only; everything else literal. Anchored.
function globRegex(pattern) {
  const source = String(pattern).split('').map((ch) => {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`);
}

function imageMatches(image, patterns, platform = process.platform) {
  if (typeof image !== 'string' || image === '') return false;
  const impl = pathImpl(platform);
  const norm = (s) => (caseInsensitive(platform) ? String(s).toLowerCase() : String(s));
  const img = norm(image);
  for (const raw of patterns || []) {
    const p = norm(raw);
    const bare = !/[\\/]/.test(p);
    const target = bare ? norm(impl.basename(image)) : img;
    if (globRegex(p).test(target)) return true;
    if (platform === 'darwin' && /\.app$/.test(p) && !/[*?]/.test(p) && img.startsWith(`${p}/`)) return true;
  }
  return false;
}

function matchSetFor(guiConfig, appIds, { realpath = realResolve } = {}) {
  const out = [];
  for (const id of appIds) {
    const app = guiConfig.apps[id];
    if (!app) continue;
    let real = app.path;
    try {
      real = realpath(app.path);
    } catch {
      real = app.path;
    }
    for (const p of [real, ...app.processes]) if (!out.includes(p)) out.push(p);
  }
  return out;
}

function assertPathsUnchanged({ exe, files = [] }, { realpath = fs.realpathSync.native, platform = process.platform } = {}) {
  const same = (a, b) => (caseInsensitive(platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const p of [exe, ...files]) {
    let now;
    try {
      now = realpath(p);
    } catch {
      throw new GuiError('path_changed', `${p} no longer exists`);
    }
    if (!same(now, p)) throw new GuiError('path_changed', `${p} now resolves to ${now}`);
  }
}

module.exports = { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged, globRegex };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/gui-apps.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/gui/apps.js tests/gui-apps.test.js
git commit -m "feat(gui): app allowlist resolution and foreground match sets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The key grammar and the text guard

**Batchable:** yes — with Task 2.

**Files:**
- Create: `src/gui/keys.js`
- Create: `src/gui/text-guard.js`
- Test: `tests/gui-keys.test.js`, `tests/gui-text-guard.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `patternMatch`, `SHELL_SEPARATORS` (`src/execution/tool-patterns.js`).
- Produces:
  - `src/gui/keys.js`: `parseKeys(keys, platform) → { mods: string[] (order ctrl, alt, shift, meta), key }` (throws `key_invalid`/`key_denied`); `printableChar(combo) → string | null`; `isEnter(combo) → boolean`; `checkButton(button, platform) → void` (throws `middle_click_denied` on Linux); `MODIFIERS`.
  - `src/gui/text-guard.js`: `checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '' }) → { ok: true } | { ok: false, code }`; `class TypedBuffer { value; append(text); reset() }` (last 2000 code points); `looksSecret(text, vaultValues) → boolean`; `isInvalidText(text) → boolean`; `MAX_TEXT = 2000`.

- [ ] **Step 1: Write the failing tests**

Create `tests/gui-keys.test.js`:

```js
// tests/gui-keys.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, printableChar, isEnter, checkButton } = require('../src/gui/keys');

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('parseKeys', () => {
  it('reads keys and modifier combinations, case-insensitively', () => {
    assert.deepEqual(parseKeys('enter', 'win32'), { mods: [], key: 'enter' });
    assert.deepEqual(parseKeys('Shift+Ctrl+S', 'win32'), { mods: ['ctrl', 'shift'], key: 's' });
    assert.deepEqual(parseKeys('f24', 'linux'), { mods: [], key: 'f24' });
    assert.deepEqual(parseKeys('ctrl+/', 'linux'), { mods: ['ctrl'], key: '/' });
    assert.deepEqual(parseKeys('meta+s', 'darwin'), { mods: ['meta'], key: 's' });
  });

  it('refuses what is not in the grammar as key_invalid', () => {
    for (const k of ['', 'hyper+a', 'ctrl+', '+a', 'f25', 'ctrl+ctrl+a', 'printscreen', 'a'.repeat(65), 'ctrl++']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_invalid', k);
    }
  });

  it('denies shell-level shortcuts everywhere', () => {
    for (const k of ['alt+tab', 'shift+alt+tab', 'ctrl+alt+delete', 'ctrl+alt+t', 'ctrl+shift+escape', 'ctrl+escape', 'alt+escape']) {
      for (const p of ['win32', 'darwin', 'linux']) assert.equal(code(() => parseKeys(k, p)), 'key_denied', `${k} on ${p}`);
    }
  });

  it('denies every clipboard chord, with extra modifiers too', () => {
    for (const k of ['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+shift+v', 'shift+insert', 'ctrl+insert', 'shift+delete', 'alt+ctrl+shift+c']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_denied', k);
    }
    for (const k of ['meta+c', 'meta+v', 'meta+x', 'meta+shift+v']) assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
  });

  it('denies meta on Windows and Linux, and the macOS system chords', () => {
    assert.equal(code(() => parseKeys('meta+r', 'win32')), 'key_denied');
    assert.equal(code(() => parseKeys('meta+l', 'linux')), 'key_denied');
    for (const k of ['meta+space', 'meta+tab', 'meta+alt+escape', 'ctrl+meta+q', 'ctrl+up', 'ctrl+right', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5']) {
      assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
    }
    assert.deepEqual(parseKeys('ctrl+up', 'win32'), { mods: ['ctrl'], key: 'up' }, 'ctrl+up is macOS-only');
  });
});

describe('printableChar and isEnter', () => {
  it('knows which presses type a character', () => {
    assert.equal(printableChar(parseKeys('a', 'linux')), 'a');
    assert.equal(printableChar(parseKeys('shift+a', 'linux')), 'A');
    assert.equal(printableChar(parseKeys('shift+1', 'linux')), '!');
    assert.equal(printableChar(parseKeys('space', 'linux')), ' ');
    assert.equal(printableChar(parseKeys('ctrl+a', 'linux')), null);
    assert.equal(printableChar(parseKeys('enter', 'linux')), null);
    assert.equal(isEnter(parseKeys('shift+enter', 'linux')), true);
  });
});

describe('checkButton', () => {
  it('refuses a middle click on Linux only', () => {
    assert.equal(code(() => checkButton('middle', 'linux')), 'middle_click_denied');
    assert.equal(code(() => checkButton('middle', 'win32')), null);
    assert.equal(code(() => checkButton('left', 'linux')), null);
  });
});
```

Create `tests/gui-text-guard.test.js`:

```js
// tests/gui-text-guard.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkTypeText, TypedBuffer, looksSecret, isInvalidText } = require('../src/gui/text-guard');
const { parseKeys, printableChar } = require('../src/gui/keys');

const ALWAYS = ['Bash(ssh *)', 'Bash(git push*)', 'Vault(*)', 'Bash(*deploy*)'];

describe('checkTypeText', () => {
  it('accepts ordinary text', () => {
    assert.deepEqual(checkTypeText('12+30=', { alwaysConfirm: ALWAYS }), { ok: true });
    assert.deepEqual(checkTypeText('Dear team,\n\tthe totals are in.', { alwaysConfirm: ALWAYS }), { ok: true });
  });

  it('invalid_text: empty, too long, control characters other than newline and tab', () => {
    for (const t of ['', 'a'.repeat(2001), 'a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 42]) {
      assert.deepEqual(checkTypeText(t), { ok: false, code: 'invalid_text' }, JSON.stringify(t));
    }
  });

  it('matches always_confirm details on the whole text, a line or a shell segment', () => {
    assert.equal(checkTypeText('git push origin main', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('cd x && git push origin', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('ls\nssh root@example.com', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('please redeploy now', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    // Bare names (no detail) are ignored, and a bare `*` detail (Vault(*)) is not a text rule.
    assert.deepEqual(checkTypeText('hello', { alwaysConfirm: ['Bash', 'Vault(*)'] }), { ok: true });
  });

  it('checks the text on its own too, so an earlier buffer cannot mask it', () => {
    assert.equal(checkTypeText('git push origin', { alwaysConfirm: ALWAYS, buffer: 'hello ' }).code, 'text_matches_always_confirm');
  });

  it('refuses secret-looking text with the pinned patterns', () => {
    const secrets = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'token sk-ant-abcdefgh12345678',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi',
      'Zx8#qL2!vN7$wK4%tR9^mB1&pC6*'
    ];
    for (const s of secrets) assert.equal(checkTypeText(s).code, 'text_looks_secret', s);
  });

  it('exempts a plain web URL from the entropy rule, but not one with userinfo', () => {
    assert.deepEqual(checkTypeText('https://example.com/a/B9x_7Qz-Lm3?q=Zr8&t=Wk2P'), { ok: true });
    assert.equal(checkTypeText('https://user:Zx8qL2vN7wK4tR9@example.com/a').code, 'text_looks_secret');
  });

  it('refuses any vault value of 8 characters or more as a substring', () => {
    assert.equal(checkTypeText('the code is hunter2hunter2 ok', { vaultValues: ['hunter2hunter2'] }).code, 'text_looks_secret');
    assert.deepEqual(checkTypeText('short abc', { vaultValues: ['abc'] }), { ok: true });
  });

  it('Review Focus 4: CJK prose and emoji are not secrets; length counts code points', () => {
    assert.deepEqual(checkTypeText('東京の会議は2026年9月25日にZoomで行います担当者は田中さんです'), { ok: true });
    assert.deepEqual(checkTypeText('这个季度的销售额增长了15个百分点主要来自华东地区的新客户'), { ok: true });
    assert.deepEqual(checkTypeText('😀'.repeat(2000)), { ok: true });
    assert.equal(checkTypeText('😀'.repeat(2001)).code, 'invalid_text');
    assert.equal(isInvalidText('😀'.repeat(2000)), false);
  });
});

describe('TypedBuffer', () => {
  it('a secret spelled by single Key presses is refused', () => {
    const buf = new TypedBuffer();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    let refused = null;
    for (const ch of secret) {
      const keys = ch === '_' ? 'shift+-' : ch;
      const char = printableChar(parseKeys(keys, 'linux'));
      const r = checkTypeText(char, { buffer: buf.value });
      if (!r.ok) { refused = r.code; break; }
      buf.append(char);
    }
    assert.equal(refused, 'text_looks_secret');
  });

  it('keeps the last 2000 code points and resets', () => {
    const buf = new TypedBuffer();
    buf.append('a'.repeat(1990));
    buf.append('😀'.repeat(20));
    assert.equal(Array.from(buf.value).length, 2000);
    assert.ok(buf.value.endsWith('😀'));
    buf.reset();
    assert.equal(buf.value, '');
  });

  it('looksSecret is exported for the Key path', () => {
    assert.equal(looksSecret('AKIAABCDEFGHIJKLMNOP', []), true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gui-keys.test.js tests/gui-text-guard.test.js`
Expected: FAIL with `Cannot find module '../src/gui/keys'`.

- [ ] **Step 3: Write `src/gui/keys.js`**

```js
// src/gui/keys.js
// The Key tool's grammar (fleet stage 5 spec §3.8): `mod(+mod)*+key` or
// `key`, with shell-level and clipboard shortcuts denied. There is no
// clipboard op anywhere in the helper protocol either.
const { GuiError } = require('./errors');

const MODIFIERS = Object.freeze(['ctrl', 'alt', 'shift', 'meta']);
const NAMED = Object.freeze(['enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'space']);
const PUNCT = Object.freeze(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
const ARROWS = ['up', 'down', 'left', 'right'];
// US layout: what shift makes of a digit or punctuation key (only the typed
// buffer uses it, to see characters spelled one press at a time).
const SHIFTED = Object.freeze({
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~'
});

function isKeyName(k) {
  return /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED.includes(k) || PUNCT.includes(k);
}

const has = (mods, ...wanted) => wanted.every((m) => mods.includes(m));

function deniedReason({ mods, key }, platform) {
  if (has(mods, 'alt') && key === 'tab') return 'alt+tab switches apps';
  if (has(mods, 'ctrl', 'alt')) return 'ctrl+alt shortcuts belong to the system';
  if (has(mods, 'ctrl', 'shift') && key === 'escape') return 'ctrl+shift+escape opens the task manager';
  if (has(mods, 'ctrl') && key === 'escape') return 'ctrl+escape opens the start menu';
  if (has(mods, 'alt') && key === 'escape') return 'alt+escape switches windows';
  if ((has(mods, 'ctrl') || has(mods, 'meta')) && ['c', 'v', 'x'].includes(key)) return 'clipboard shortcuts are not allowed';
  if ((has(mods, 'shift') || has(mods, 'ctrl')) && key === 'insert') return 'clipboard shortcuts are not allowed';
  if (has(mods, 'shift') && key === 'delete') return 'clipboard shortcuts are not allowed';
  if (platform !== 'darwin' && has(mods, 'meta')) return 'the Windows/Super key is not allowed';
  if (platform === 'darwin') {
    if (has(mods, 'meta') && key === 'space') return 'meta+space opens Spotlight';
    if (has(mods, 'meta') && key === 'tab') return 'meta+tab switches apps';
    if (has(mods, 'meta', 'alt') && key === 'escape') return 'meta+alt+escape opens Force Quit';
    if (has(mods, 'ctrl', 'meta') && key === 'q') return 'ctrl+meta+q locks the screen';
    if (has(mods, 'ctrl') && ARROWS.includes(key)) return 'ctrl+arrow switches Spaces';
    if (has(mods, 'meta', 'shift') && ['3', '4', '5'].includes(key)) return 'meta+shift+3/4/5 take screenshots';
  }
  return null;
}

function parseKeys(keys, platform = process.platform) {
  if (typeof keys !== 'string' || keys.length < 1 || keys.length > 64) throw new GuiError('key_invalid', 'keys must be 1–64 characters');
  const parts = keys.toLowerCase().split('+');
  if (parts.some((p) => p === '')) throw new GuiError('key_invalid', `"${keys}" is not mod+key`);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!isKeyName(key)) throw new GuiError('key_invalid', `unknown key "${key}"`);
  for (const m of mods) if (!MODIFIERS.includes(m)) throw new GuiError('key_invalid', `unknown modifier "${m}"`);
  if (new Set(mods).size !== mods.length) throw new GuiError('key_invalid', 'a modifier is repeated');
  const combo = { mods: MODIFIERS.filter((m) => mods.includes(m)), key };
  const denied = deniedReason(combo, platform);
  if (denied) throw new GuiError('key_denied', denied);
  return combo;
}

function printableChar({ mods, key }) {
  if (mods.some((m) => m !== 'shift')) return null;
  const shift = mods.includes('shift');
  if (key === 'space') return ' ';
  if (/^[a-z]$/.test(key)) return shift ? key.toUpperCase() : key;
  if (/^[0-9]$/.test(key) || PUNCT.includes(key)) return shift ? SHIFTED[key] : key;
  return null;
}

const isEnter = (combo) => combo.key === 'enter';

function checkButton(button, platform = process.platform) {
  // X11 pastes the primary selection on a middle click (§3.8).
  if (button === 'middle' && platform === 'linux') throw new GuiError('middle_click_denied', 'a middle click pastes the primary selection on Linux');
}

module.exports = { parseKeys, printableChar, isEnter, checkButton, MODIFIERS };
```

- [ ] **Step 4: Write `src/gui/text-guard.js`**

```js
// src/gui/text-guard.js
// What the Type tool (and printable Key presses) may send (fleet stage 5
// spec §3.8). Checks run over `buffer + text`, where the buffer is the
// lease's last 2000 typed characters, so a value spelled one call at a time
// is caught; the text alone is checked too, so a buffer cannot mask it.
const { patternMatch, SHELL_SEPARATORS } = require('../execution/tool-patterns');

const MAX_TEXT = 2000;
const BUFFER_MAX = 2000;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/
]);
// Control characters other than \n and \t (C0, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function isInvalidText(text) {
  if (typeof text !== 'string') return true;
  const length = Array.from(text).length;
  return length === 0 || length > MAX_TEXT || CONTROL.test(text);
}

function entropy(run) {
  const chars = Array.from(run);
  const counts = new Map();
  for (const c of chars) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(run) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[!-/:-@[-`{-~]/].filter((re) => re.test(run)).length;
}

function isPlainWebUrl(run) {
  try {
    const u = new URL(run);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

function looksSecret(text, vaultValues = []) {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  // Runs of printable ASCII (Deviation 26): secrets are ASCII, and prose in
  // scripts without spaces must not form one long run.
  for (const run of text.match(/[!-~]{24,}/g) || []) {
    if (isPlainWebUrl(run)) continue;
    if (entropy(run) >= 4.0 && charClasses(run) >= 3) return true;
  }
  return vaultValues.some((v) => typeof v === 'string' && v.length >= 8 && text.includes(v));
}

// `Name(detail)` patterns only; bare names are ignored (§3.8).
function details(patterns) {
  const out = [];
  for (const p of patterns || []) {
    const m = /^[A-Za-z_][\w-]*\(([\s\S]*)\)$/.exec(String(p));
    if (m && m[1] !== '') out.push(m[1]);
  }
  return out;
}

function candidates(text) {
  const out = new Set([text]);
  for (const line of text.split('\n')) {
    out.add(line);
    for (const segment of line.split(SHELL_SEPARATORS)) if (segment.trim()) out.add(segment.trim());
  }
  return out;
}

function matchesAlwaysConfirm(texts, patterns) {
  const ds = details(patterns).filter((d) => d !== '*');
  if (ds.length === 0) return false;
  for (const text of texts) {
    for (const c of candidates(text)) if (ds.some((d) => patternMatch(d, c))) return true;
  }
  return false;
}

function checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '' } = {}) {
  if (isInvalidText(text)) return { ok: false, code: 'invalid_text' };
  const combined = `${buffer}${text}`;
  if (matchesAlwaysConfirm([text, combined], alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (looksSecret(text, vaultValues) || looksSecret(combined, vaultValues)) return { ok: false, code: 'text_looks_secret' };
  return { ok: true };
}

class TypedBuffer {
  constructor(max = BUFFER_MAX) {
    this.max = max;
    this.chars = [];
  }

  get value() {
    return this.chars.join('');
  }

  append(text) {
    this.chars.push(...Array.from(String(text)));
    if (this.chars.length > this.max) this.chars = this.chars.slice(this.chars.length - this.max);
  }

  reset() {
    this.chars = [];
  }
}

module.exports = { checkTypeText, TypedBuffer, looksSecret, isInvalidText, MAX_TEXT };
```

Note on `Vault(*)`: its detail `*` would match every text, which is not what an owner means by "confirm Vault calls"; `matchesAlwaysConfirm` drops a detail that is exactly `*`. `Bash(*deploy*)` still matches text containing "deploy".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/gui-keys.test.js tests/gui-text-guard.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/gui/keys.js src/gui/text-guard.js tests/gui-keys.test.js tests/gui-text-guard.test.js
git commit -m "feat(gui): key grammar and the typed-text guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `kl-session-v1` framing, proofs and sealing, with vectors and the protocol document

**Files:**
- Create: `src/gui/helper-protocol.js`
- Create: `tests/vectors/session-v1/generate.js` (and the files it writes)
- Create: `docs/protocol/session-v1.md`
- Test: `tests/session-vectors.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1).
- Produces (`src/gui/helper-protocol.js`):
  - Constants `PROTOCOL = 'kl-session-v1'`, `PLAIN_MAX = 16384`, `SEALED_MAX = 8388608`, `DIR_SH = 0x01`, `DIR_HS = 0x02`, `NONCE_RE`.
  - `encodeFrame(obj) → Buffer` (plain: 4-byte BE length + UTF-8 JSON; throws `frame_rejected` over 16 KiB).
  - `class FrameDecoder { constructor({ maxBytes }); setMax(n); push(chunk); next() → Buffer | null }` (throws `GuiError('frame_rejected')` on a zero or oversize length).
  - `parsePlain(body) → object` (throws `frame_rejected`).
  - `randomNonce() → b64url(32)`, `serviceProof(secret, nodeId, nonceH, nonceS) → b64url`, `helperProof(secret, nodeId, nonceS, nonceH) → b64url`, `proofEquals(a, b) → boolean` (constant time).
  - `deriveSessionKeys(secret, nodeId, nonceH, nonceS) → { kSh: Buffer(32), kHs: Buffer(32) }`.
  - `createSealer(key, dir) → { seal(obj) → Buffer (whole frame incl. length) }`; `createOpener(key, dir) → { open(body) → object }` (body = frame without its 4-byte length; throws `GuiError('frame_rejected', 'sequence'|'authentication'|'json'|'short')`).

- [ ] **Step 1: Write the vector generator and the failing test**

Create `tests/vectors/session-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/session-v1/generate.js
//
// Rebuilds the kl-session-v1 vectors (fleet stage 5 spec §4.2).
//   node tests/vectors/session-v1/generate.js          write the files
//   node tests/vectors/session-v1/generate.js --check  exit 1 if any differ
// Everything is deterministic: fixed secret and nonces, and AES-GCM with a
// fixed key and IV.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../../../src/gui/helper-protocol');
const KEYS = require('../approval-v1/keys.json');

const DIR = __dirname;
const sha = (label) => crypto.createHash('sha256').update(label).digest();
const SECRET = sha('session-v1 vector secret');
const NODE_ID = KEYS.nodes['gpu-box'].id;
const NONCE_H = sha('session-v1 nonce_h').toString('base64url');
const NONCE_S = sha('session-v1 nonce_s').toString('base64url');

const PLAINTEXTS = {
  sh: [{ t: 'req', id: 1, op: 'foreground', job_id: 'job-1', lease_id: null, params: {} }, { t: 'ping' }],
  hs: [
    { t: 'probe_report', capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false },
    { t: 'res', id: 1, ok: true, result: null }
  ]
};

function buildVectors() {
  const { kSh, kHs } = P.deriveSessionKeys(SECRET, NODE_ID, NONCE_H, NONCE_S);
  const frames = (key, dir, list) => {
    const sealer = P.createSealer(key, dir);
    return list.map((obj) => ({ plaintext_json: JSON.stringify(obj), frame_hex: sealer.seal(obj).toString('hex') }));
  };
  const sh = frames(kSh, P.DIR_SH, PLAINTEXTS.sh);
  const hs = frames(kHs, P.DIR_HS, PLAINTEXTS.hs);
  const tampered = Buffer.from(sh[0].frame_hex, 'hex');
  tampered[tampered.length - 1] ^= 0x01;
  const keysHex = { k_sh_hex: kSh.toString('hex'), k_hs_hex: kHs.toString('hex') };
  return [
    {
      name: 'handshake',
      given: { secret_hex: SECRET.toString('hex'), node_id: NODE_ID, nonce_h: NONCE_H, nonce_s: NONCE_S },
      expect: {
        proof_s: P.serviceProof(SECRET, NODE_ID, NONCE_H, NONCE_S),
        proof_h: P.helperProof(SECRET, NODE_ID, NONCE_S, NONCE_H),
        ...keysHex
      }
    },
    { name: 'sealed-frames', given: keysHex, expect: { service_to_helper: sh, helper_to_service: hs } },
    // Each rejection: open `frames` in order with the named key/dir; the
    // frame at `rejected_at` fails with frame_rejected.
    { name: 'reject-seq-skip', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[1].frame_hex] }, expect: { rejected_at: 0, reason: 'sequence' } },
    { name: 'reject-seq-replay', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[0].frame_hex, sh[0].frame_hex] }, expect: { rejected_at: 1, reason: 'sequence' } },
    { name: 'reject-wrong-direction-key', given: { key_hex: keysHex.k_hs_hex, dir: P.DIR_HS, frames: [sh[0].frame_hex] }, expect: { rejected_at: 0, reason: 'authentication' } },
    { name: 'reject-tampered-tag', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [tampered.toString('hex')] }, expect: { rejected_at: 0, reason: 'authentication' } }
  ];
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  let differ = 0;
  const vectors = buildVectors();
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize };
```

Create `tests/session-vectors.test.js`:

```js
// tests/session-vectors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/gui/helper-protocol');
const { buildVectors, serialize } = require('./vectors/session-v1/generate');

const DIR = path.join(__dirname, 'vectors', 'session-v1');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const bodyOf = (hex) => Buffer.from(hex, 'hex').subarray(4);

describe('session-v1 vectors', () => {
  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), v.name);
    assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length, 6);
  });

  it('handshake: proofs and HKDF keys', () => {
    const v = load('handshake');
    const secret = Buffer.from(v.given.secret_hex, 'hex');
    assert.equal(P.serviceProof(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s), v.expect.proof_s);
    assert.equal(P.helperProof(secret, v.given.node_id, v.given.nonce_s, v.given.nonce_h), v.expect.proof_h);
    assert.notEqual(v.expect.proof_s, v.expect.proof_h);
    const { kSh, kHs } = P.deriveSessionKeys(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s);
    assert.equal(kSh.toString('hex'), v.expect.k_sh_hex);
    assert.equal(kHs.toString('hex'), v.expect.k_hs_hex);
    assert.ok(P.proofEquals(v.expect.proof_s, v.expect.proof_s));
    assert.ok(!P.proofEquals(v.expect.proof_s, v.expect.proof_h));
  });

  it('sealed frames open in order with the right direction key', () => {
    const v = load('sealed-frames');
    for (const [list, key, dir] of [[v.expect.service_to_helper, v.given.k_sh_hex, P.DIR_SH], [v.expect.helper_to_service, v.given.k_hs_hex, P.DIR_HS]]) {
      const opener = P.createOpener(Buffer.from(key, 'hex'), dir);
      for (const f of list) assert.deepEqual(opener.open(bodyOf(f.frame_hex)), JSON.parse(f.plaintext_json));
    }
  });

  for (const name of ['reject-seq-skip', 'reject-seq-replay', 'reject-wrong-direction-key', 'reject-tampered-tag']) {
    it(`${name} is refused at the named frame`, () => {
      const v = load(name);
      const opener = P.createOpener(Buffer.from(v.given.key_hex, 'hex'), v.given.dir);
      v.given.frames.forEach((hex, i) => {
        if (i < v.expect.rejected_at) { opener.open(bodyOf(hex)); return; }
        if (i === v.expect.rejected_at) {
          assert.throws(() => opener.open(bodyOf(hex)), (e) => e.code === 'frame_rejected' && e.detail === v.expect.reason);
        }
      });
    });
  }
});

describe('plain framing', () => {
  it('round-trips through the decoder one frame at a time, even across chunks', () => {
    const a = P.encodeFrame({ t: 'hello', v: 1 });
    const b = P.encodeFrame({ t: 'auth', proof_h: 'x' });
    const all = Buffer.concat([a, b]);
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    d.push(all.subarray(0, 3));
    assert.equal(d.next(), null);
    d.push(all.subarray(3));
    assert.deepEqual(P.parsePlain(d.next()), { t: 'hello', v: 1 });
    assert.deepEqual(P.parsePlain(d.next()), { t: 'auth', proof_h: 'x' });
    assert.equal(d.next(), null);
  });

  it('refuses an oversize or zero length and unparseable JSON', () => {
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    const big = Buffer.alloc(4);
    big.writeUInt32BE(P.PLAIN_MAX + 1);
    d.push(big);
    assert.throws(() => d.next(), (e) => e.code === 'frame_rejected');
    const z = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    z.push(Buffer.alloc(4));
    assert.throws(() => z.next(), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('{nope')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('[1]')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.encodeFrame({ pad: 'x'.repeat(P.PLAIN_MAX) }), (e) => e.code === 'frame_rejected');
  });

  it('a bad nonce is refused before any key is derived', () => {
    assert.throws(() => P.deriveSessionKeys(Buffer.alloc(32), 'kl-aaaaaaaaaaaaaaaa', 'short', P.randomNonce()), (e) => e.code === 'frame_rejected');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-vectors.test.js`
Expected: FAIL with `Cannot find module '../../../src/gui/helper-protocol'`.

- [ ] **Step 3: Write `src/gui/helper-protocol.js`**

```js
// src/gui/helper-protocol.js
// kl-session-v1 (fleet stage 5 spec §3.2, §4.2; docs/protocol/session-v1.md):
// the local protocol between the service and the session helper. Shared by
// both sides; no platform code. Before `ready`: 4-byte length + JSON. After:
// every frame sealed with AES-256-GCM under per-direction HKDF keys with a
// strict sequence, so a relaying local account can pass frames through but
// cannot read, inject or reorder them.
const crypto = require('crypto');
const { GuiError } = require('./errors');

const PROTOCOL = 'kl-session-v1';
const PLAIN_MAX = 16 * 1024;
const SEALED_MAX = 8 * 1024 * 1024;
const DIR_SH = 0x01;
const DIR_HS = 0x02;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const TAG_BYTES = 16;

const rejected = (why) => new GuiError('frame_rejected', why);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function lengthPrefix(n) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(n);
  return len;
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > PLAIN_MAX) throw rejected('plain frame over 16 KiB');
  return Buffer.concat([lengthPrefix(body.length), body]);
}

class FrameDecoder {
  constructor({ maxBytes = PLAIN_MAX } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  setMax(n) {
    this.maxBytes = n;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
  }

  // One frame at a time, so the caller can switch the limit (and the
  // meaning of the next frame) at `ready`.
  next() {
    if (this.buffer.length < 4) return null;
    const n = this.buffer.readUInt32BE(0);
    if (n === 0 || n > this.maxBytes) throw rejected(`frame of ${n} bytes`);
    if (this.buffer.length < 4 + n) return null;
    const body = this.buffer.subarray(4, 4 + n);
    this.buffer = this.buffer.subarray(4 + n);
    return body;
  }
}

function parsePlain(body) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw rejected('json');
  }
  if (!isPlainObject(obj)) throw rejected('json');
  return obj;
}

const randomNonce = () => crypto.randomBytes(32).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64url');

function serviceProof(secret, nodeId, nonceH, nonceS) {
  return hmac(secret, `${PROTOCOL}\nservice\n${nodeId}\n${nonceH}\n${nonceS}`);
}

function helperProof(secret, nodeId, nonceS, nonceH) {
  return hmac(secret, `${PROTOCOL}\nhelper\n${nodeId}\n${nonceS}\n${nonceH}`);
}

function proofEquals(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function nonceBytes(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw rejected('nonce');
  return Buffer.from(nonce, 'base64url');
}

// info = UTF-8 label ‖ UTF-8 node_id ‖ raw nonce_h ‖ raw nonce_s (Deviation 19).
function deriveSessionKeys(secret, nodeId, nonceH, nonceS) {
  const info = Buffer.concat([Buffer.from(`${PROTOCOL} keys`, 'utf8'), Buffer.from(String(nodeId), 'utf8'), nonceBytes(nonceH), nonceBytes(nonceS)]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 64));
  return { kSh: okm.subarray(0, 32), kHs: okm.subarray(32, 64) };
}

function ivFor(dir, seq) {
  const iv = Buffer.alloc(12);
  iv[0] = dir;
  iv.writeBigUInt64BE(seq, 4);
  return iv;
}

function aadFor(dir, seq) {
  const label = Buffer.from(PROTOCOL, 'utf8');
  const tail = Buffer.alloc(9);
  tail[0] = dir;
  tail.writeBigUInt64BE(seq, 1);
  return Buffer.concat([label, tail]);
}

function createSealer(key, dir) {
  let seq = 0n;
  return {
    seal(obj) {
      seq += 1n;
      const cipher = crypto.createCipheriv('aes-256-gcm', key, ivFor(dir, seq));
      cipher.setAAD(aadFor(dir, seq));
      const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
      const seqBuf = Buffer.alloc(8);
      seqBuf.writeBigUInt64BE(seq);
      const body = Buffer.concat([seqBuf, ct, cipher.getAuthTag()]);
      if (body.length > SEALED_MAX) throw rejected('sealed frame over 8 MiB');
      return Buffer.concat([lengthPrefix(body.length), body]);
    }
  };
}

function createOpener(key, dir) {
  let last = 0n;
  return {
    open(body) {
      if (!body || body.length < 8 + TAG_BYTES) throw rejected('short');
      const seq = body.readBigUInt64BE(0);
      if (seq !== last + 1n) throw rejected('sequence');
      let plain;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivFor(dir, seq));
        decipher.setAAD(aadFor(dir, seq));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        plain = Buffer.concat([decipher.update(body.subarray(8, body.length - TAG_BYTES)), decipher.final()]);
      } catch {
        throw rejected('authentication');
      }
      last = seq;
      return parsePlain(plain);
    }
  };
}

module.exports = {
  PROTOCOL, PLAIN_MAX, SEALED_MAX, DIR_SH, DIR_HS, NONCE_RE,
  encodeFrame, FrameDecoder, parsePlain, randomNonce,
  serviceProof, helperProof, proofEquals, deriveSessionKeys, createSealer, createOpener
};
```

- [ ] **Step 4: Generate the vectors and run the tests**

Run: `node tests/vectors/session-v1/generate.js` → prints `6 vectors written`.
Run: `node tests/vectors/session-v1/generate.js --check` → `6 vectors match`.
Run: `node --test tests/session-vectors.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Write `docs/protocol/session-v1.md`**

```markdown
# kl-session-v1 — the session helper channel

The local protocol between the King Louie service (a system service) and its
session helper (`king-louie-service session`, running as the logged-in user).
Fleet stage 5 spec §3.2 and §4.2 are the source; this document fixes the bytes.

## 1. Transport

- Windows: a named pipe `\\.\pipe\king-louie-session-<endpoint_id>`, created by
  the service with `readableAll` and `writableAll` (Node cannot put one SID in a
  pipe DACL). Any local account can open it, and can also open another server
  instance of the same name; the protocol below is the security boundary.
- POSIX: a Unix socket `<session_ipc_dir>/<endpoint_id>.sock`, mode `0666`, in a
  `0711` directory owned by the service account (`/var/lib/king-louie-session`
  on Linux, `/Library/Application Support/KingLouie/session` on macOS). Socket
  names are not secret.

## 2. Frames

Before and including `ready`: `len(4, big-endian) ‖ UTF-8 JSON object`, at most
16 KiB. After `ready`: sealed frames (§4), at most 8 MiB. A zero or oversize
length, unparseable JSON, a JSON value that is not an object, or a frame that is
not the next expected handshake message closes the connection.

## 3. Handshake

| # | From | Frame |
|---|---|---|
| 1 | helper | `{ "t": "hello", "v": 1, "node_id", "nonce_h": b64url(32 random bytes), "pid", "user", "platform", "helper_version" }` |
| 2 | service | `{ "t": "challenge", "v": 1, "nonce_s": b64url(32), "proof_s" }` |
| 3 | helper | `{ "t": "auth", "proof_h" }` — sent only after `proof_s` verifies |
| 4 | service | `{ "t": "ready", "session_id": uuid-v4 }` — or `{ "t": "error", "code": "helper_already_connected" }` and close |

- `proof_s = b64url(HMAC-SHA256(secret, "kl-session-v1\nservice\n" + node_id + "\n" + nonce_h + "\n" + nonce_s))`
- `proof_h = b64url(HMAC-SHA256(secret, "kl-session-v1\nhelper\n" + node_id + "\n" + nonce_s + "\n" + nonce_h))`
- `secret` is the raw 32 bytes. Proofs compare in constant time.
- The service closes when `hello.node_id` differs from its canonical file or
  `hello.user` differs from `session_user`. The whole handshake has 5 s.
- At most 4 unauthenticated connections at once. One authenticated helper: a
  newcomer is refused (`error` frame above) while the current helper answers a
  `ping` within 5 s, and replaces it otherwise.

## 4. Sealing

`keys = HKDF-SHA256(ikm = secret, salt = empty, info, 64 bytes)` with
`info = UTF-8("kl-session-v1 keys") ‖ UTF-8(node_id) ‖ raw(nonce_h) ‖ raw(nonce_s)`
(the raw 32 bytes of each nonce). `k_sh = keys[0..32]` seals service → helper,
`k_hs = keys[32..64]` helper → service.

Each sealed frame: `len(4, BE) ‖ seq(8, BE) ‖ AES-256-GCM ciphertext ‖ tag(16)`,
`len` counting everything after itself.
- `dir` = `0x01` service → helper, `0x02` helper → service.
- `iv = dir(1) ‖ 0x000000 ‖ seq(8, BE)`; `aad = UTF-8("kl-session-v1") ‖ dir(1) ‖ seq(8, BE)`.
- `seq` starts at 1 in each direction and increments by 1. A frame whose `seq`
  is not the last + 1, or that fails to open, closes the connection.

## 5. Messages after `ready`

The helper's first sealed frame is its `probe_report`. Then:

- `{ "t": "req", "id", "op", "job_id", "lease_id", "params" }` → `{ "t": "res", "id", "ok": true, "result" }`
  or `{ "t": "res", "id", "ok": false, "error": { "code", "message", "detail" } }`.
- `{ "t": "event", "kind": "locked" | "unlocked" | "displays_changed" | "probe_changed", "data" }` (helper → service).
- `{ "t": "ping" }` / `{ "t": "pong" }`, either direction; the service pings
  every 10 s and closes after 30 s without a frame.

Ops: `launch`, `processes`, `windows`, `foreground`, `focus`, `close`,
`screenshot`, `input`, `release_all`, `probe` (spec §3.3). Timeouts: 10 s,
`screenshot` 20 s, `launch` 30 s. There is no clipboard op.

## 6. Vectors

`tests/vectors/session-v1/`, rebuilt by `generate.js`: `handshake` (proofs and
keys), `sealed-frames` (both directions), and the rejections `reject-seq-skip`,
`reject-seq-replay`, `reject-wrong-direction-key`, `reject-tampered-tag`.
```

- [ ] **Step 6: Commit**

```bash
git add src/gui/helper-protocol.js tests/vectors/session-v1 tests/session-vectors.test.js docs/protocol/session-v1.md
git commit -m "feat(gui): kl-session-v1 framing, proofs and sealing with vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The session secret, the per-user copies and the endpoint

**Files:**
- Create: `src/gui/session-secret.js`
- Modify: `src/platform/windows-paths.js` (add `windowsIcaclsExe`)
- Test: `tests/gui-session-secret.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `assertAdminOwned` (`src/service/node-config.js`); `windowsIcaclsExe`, `windowsPowerShellExe` (`src/platform/windows-paths.js`).
- Produces (`src/gui/session-secret.js`):
  - `mintSessionSecret() → { secret: Buffer(32), endpointId: 32 hex }`.
  - `canonicalPath(configDir)`; `writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid = null, svcGid = null, platform, now })`; `readCanonical({ configDir, cipher, geteuid, adminUid = 0 }) → { secret, endpointId, nodeId, sessionUser, sessionSid, mtimeMs }` (throws `session_not_installed`); `canonicalMtime(configDir) → number | null`.
  - `userCopyPath({ platform, configDir, user, sid })`; `writeUserCopy({ platform, configDir, user, uid, gid, sid, content, runIcacls, env }) → file`; `readUserCopy({ path, platform, getuid, rootUid = 0 }) → { secret, endpoint, nodeId }` (throws `session_not_installed`, `session_file_insecure`); `removeUserCopy(...)`.
  - `endpointPath({ platform, endpointId, ipcDir })`; `sessionIpcDir(platform)`.
  - `assertSafeComponents(target, { root }) → void` (throws `unsafe_path`).
  - `windowsUserAclArgs(file, sid, env) → string[]`.
  - `resolveSessionUser(name, { platform, execFile, env }) → { user, uid, gid, home, sid }` (throws `user_not_found`, `home_missing`, `invalid_params`).
  - `src/platform/windows-paths.js`: `windowsIcaclsExe(env) → '<SystemRoot>\System32\icacls.exe'`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-session-secret.test.js`:

```js
// tests/gui-session-secret.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/gui/session-secret');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { windowsIcaclsExe } = require('../src/platform/windows-paths');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const cipher = createAesGcmCipher(crypto.randomBytes(32));

function tempConfig() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-session-secret-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  return { base, config };
}

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('mint and the canonical copy', () => {
  it('mints 32 random bytes and a 16-byte endpoint id, fresh every time', () => {
    const a = S.mintSessionSecret();
    const b = S.mintSessionSecret();
    assert.equal(a.secret.length, 32);
    assert.match(a.endpointId, /^[0-9a-f]{32}$/);
    assert.notEqual(a.endpointId, b.endpointId);
    assert.ok(!a.secret.equals(b.secret));
  });

  it('writes the secret as klc1: ciphertext and reads it back', () => {
    const { config } = tempConfig();
    const { secret, endpointId } = S.mintSessionSecret();
    S.writeCanonical({ configDir: config, cipher, secret, endpointId, nodeId: 'kl-hnef32472qzibi5r', sessionUser: 'alice', svcGid: POSIX ? GID : null });
    const raw = JSON.parse(fs.readFileSync(S.canonicalPath(config), 'utf8'));
    assert.match(raw.secret, /^klc1:/);
    assert.deepEqual(Object.keys(raw).sort(), ['endpoint_id', 'node_id', 'rotated_at', 'secret', 'session_sid', 'session_user', 'v']);
    if (POSIX) assert.equal(fs.statSync(S.canonicalPath(config)).mode & 0o777, 0o640);
    const read = S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID });
    assert.ok(read.secret.equals(secret));
    assert.equal(read.endpointId, endpointId);
    assert.equal(read.sessionUser, 'alice');
    assert.ok(read.mtimeMs > 0);
    assert.equal(S.canonicalMtime(config), read.mtimeMs);
  });

  it('a missing canonical file is session_not_installed', () => {
    const { config } = tempConfig();
    assert.equal(code(() => S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID })), 'session_not_installed');
    assert.equal(S.canonicalMtime(config), null);
  });
});

describe('per-user copies', () => {
  const content = { v: 1, node_id: 'kl-hnef32472qzibi5r', endpoint: '/tmp/x.sock', secret: 'ab'.repeat(32), rotated_at: '2026-09-23T18:00:00.000Z' };

  it('the path lives in the admin-owned config dir', () => {
    assert.equal(S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: 'alice' }), '/etc/king-louie/session/users/alice.json');
    assert.equal(S.userCopyPath({ platform: 'win32', configDir: 'C:\\ProgramData\\KingLouie\\config', sid: 'S-1-5-21-1-2-3-1001' }),
      'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json');
    assert.equal(code(() => S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: '../root' })), 'invalid_params');
    assert.equal(code(() => S.userCopyPath({ platform: 'win32', configDir: 'C:\\x', sid: 'S-1-5-21-1..\\x' })), 'invalid_params');
  });

  it('POSIX: 0600, owned by the user, in a root-owned 0755 dir; readable back', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, UID);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(config, 'session')).mode & 0o777, 0o755, 'Deviation 10');
    const read = S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID });
    assert.equal(read.nodeId, content.node_id);
    assert.equal(read.secret.toString('hex'), content.secret);
    // A second write replaces the file (unlink + O_EXCL), never opens it for write.
    S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content: { ...content, endpoint: '/tmp/y.sock' } });
    assert.equal(S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID }).endpoint, '/tmp/y.sock');
  });

  it('POSIX: session_file_insecure for a loose mode, another owner or a non-root dir', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    fs.chmodSync(file, 0o644);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_file_insecure');
    fs.chmodSync(file, 0o600);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID + 1, rootUid: UID })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID + 1 })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: path.join(config, 'nope.json'), platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_not_installed');
  });

  it('a hostile symlink at the file or at a parent refuses unsafe_path and leaves the target untouched', { skip: !POSIX }, () => {
    const { base, config } = tempConfig();
    const target = path.join(base, 'target.txt');
    fs.writeFileSync(target, 'original');
    fs.mkdirSync(path.join(config, 'session', 'users'), { recursive: true, mode: 0o755 });
    fs.symlinkSync(target, path.join(config, 'session', 'users', 'alice.json'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const { base: base2, config: config2 } = tempConfig();
    const elsewhere = path.join(base2, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config2, 'session'), { mode: 0o755 });
    fs.symlinkSync(elsewhere, path.join(config2, 'session', 'users'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config2, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('a junction at a parent component refuses unsafe_path on Windows', { skip: POSIX }, () => {
    const { base, config } = tempConfig();
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config, 'session'));
    fs.symlinkSync(elsewhere, path.join(config, 'session', 'users'), 'junction');
    assert.equal(code(() => S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: () => {} })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('Windows: the ACL command line uses the absolute icacls.exe and the SID', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    assert.equal(windowsIcaclsExe(env), 'C:\\Windows\\System32\\icacls.exe');
    assert.deepEqual(S.windowsUserAclArgs('C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json', 'S-1-5-21-1-2-3-1001', env), [
      'C:\\Windows\\System32\\icacls.exe', 'C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json',
      '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(R)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
    ]);
  });

  it('Windows: writing a copy runs icacls once on that file', { skip: POSIX }, () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const calls = [];
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: (argv) => calls.push(argv), env });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], file);
  });
});

describe('endpoint', () => {
  it('names the pipe or the socket; socket paths fit in 104 bytes', () => {
    const id = 'a'.repeat(32);
    assert.equal(S.endpointPath({ platform: 'win32', endpointId: id }), `\\\\.\\pipe\\king-louie-session-${id}`);
    for (const platform of ['linux', 'darwin']) {
      const p = S.endpointPath({ platform, endpointId: id });
      assert.ok(p.startsWith(S.sessionIpcDir(platform)));
      assert.ok(Buffer.byteLength(p) <= 104, p);
    }
    assert.equal(code(() => S.endpointPath({ platform: 'linux', endpointId: '../x' })), 'invalid_params');
  });
});

describe('resolveSessionUser', () => {
  it('POSIX: id and getent, the name never in a shell', () => {
    const calls = [];
    const execFile = (file, argv) => {
      calls.push([file, ...argv]);
      if (file === '/usr/bin/id') return argv[0] === '-u' ? '1001\n' : '1001\n';
      if (file === '/usr/bin/getent') return 'alice:x:1001:1001:Alice:/home/alice:/bin/bash\n';
      throw new Error('unexpected');
    };
    const exists = (p) => p === '/home/alice';
    assert.deepEqual(S.resolveSessionUser('alice', { platform: 'linux', execFile, exists }), { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice', sid: null });
    assert.deepEqual(calls[0], ['/usr/bin/id', '-u', 'alice']);
  });

  it('macOS reads the home with dscl', () => {
    const execFile = (file) => (file === '/usr/bin/dscl' ? 'NFSHomeDirectory: /Users/alice\n' : '501\n');
    assert.equal(S.resolveSessionUser('alice', { platform: 'darwin', execFile, exists: () => true }).home, '/Users/alice');
  });

  it('Windows: the SID through PowerShell with the name in an environment variable', () => {
    let seen;
    const execFile = (file, argv, options) => { seen = { file, argv, env: options.env }; return 'S-1-5-21-1-2-3-1001\r\n'; };
    const r = S.resolveSessionUser('alice', { platform: 'win32', execFile, env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(r.sid, 'S-1-5-21-1-2-3-1001');
    assert.ok(seen.file.endsWith('powershell.exe'));
    assert.ok(!seen.argv.join(' ').includes('alice'), 'the name is never interpolated');
    assert.equal(seen.env.KL_SESSION_USER, 'alice');
  });

  it('unknown user, missing home and a hostile name', () => {
    const fail = () => { throw Object.assign(new Error('no such user'), { status: 1 }); };
    assert.equal(code(() => S.resolveSessionUser('ghost', { platform: 'linux', execFile: fail })), 'user_not_found');
    const noHome = (file) => (file === '/usr/bin/getent' ? 'alice:x:1001:1001::/nonexistent-kl:/bin/sh\n' : '1001\n');
    assert.equal(code(() => S.resolveSessionUser('alice', { platform: 'linux', execFile: noHome, exists: () => false })), 'home_missing');
    assert.equal(code(() => S.resolveSessionUser('-rf', { platform: 'linux', execFile: fail })), 'invalid_params');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-session-secret.test.js`
Expected: FAIL with `Cannot find module '../src/gui/session-secret'`.

- [ ] **Step 3: Add `windowsIcaclsExe`**

In `src/platform/windows-paths.js`, below `windowsSchtasksExe`:

```js
const windowsIcaclsExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'icacls.exe');

module.exports = { windowsSystemRoot, windowsPowerShellExe, windowsSchtasksExe, windowsIcaclsExe };
```

(Replace the existing `module.exports` line.)

- [ ] **Step 4: Write `src/gui/session-secret.js`**

```js
// src/gui/session-secret.js
// The session helper's secret and endpoint (fleet stage 5 spec §3.1, §4.3).
// The canonical copy (service reads) is klc1: ciphertext under the master
// key; each per-user copy (helper reads) is plaintext in the admin-owned
// config dir, readable only by that user. Elevated writes never follow a
// link: the config dir must be its own realpath and every component below it
// is lstat'ed (Deviation 11); a file is replaced by unlink + O_EXCL create.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GuiError } = require('./errors');
const { windowsIcaclsExe, windowsPowerShellExe } = require('../platform/windows-paths');

const SID_RE = /^S-1-\d+(-\d+){1,14}$/;
const POSIX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const ENDPOINT_RE = /^[0-9a-f]{32}$/;
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

const joinFor = (platform) => (platform === 'win32' ? path.win32.join : path.posix.join);

function mintSessionSecret() {
  return { secret: crypto.randomBytes(32), endpointId: crypto.randomBytes(16).toString('hex') };
}

const canonicalPath = (configDir) => path.join(configDir, 'session', 'helper-secret.json');

function sessionIpcDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/KingLouie/session';
  return '/var/lib/king-louie-session';
}

function endpointPath({ platform = process.platform, endpointId, ipcDir = sessionIpcDir(platform) }) {
  if (!ENDPOINT_RE.test(String(endpointId))) throw new GuiError('invalid_params', 'endpoint id must be 32 hex characters');
  if (platform === 'win32') return `\\\\.\\pipe\\king-louie-session-${endpointId}`;
  return path.posix.join(ipcDir, `${endpointId}.sock`);
}

function userCopyPath({ platform = process.platform, configDir, user, sid }) {
  const join = joinFor(platform);
  if (platform === 'win32') {
    if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'a Windows session user is named by its SID');
    return join(configDir, 'session', 'users', `${sid}.json`);
  }
  if (!POSIX_USER_RE.test(String(user))) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(user)}`);
  return join(configDir, 'session', 'users', `${user}.json`);
}

// The config dir must be its own realpath (no link anywhere above it), and
// nothing from it down to `target` may be a symlink, junction or other
// reparse point (Node reports junctions as symbolic links).
function assertSafeComponents(target, { root }) {
  const resolvedRoot = path.resolve(root);
  let real;
  try {
    real = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new GuiError('unsafe_path', resolvedRoot);
  }
  if (real.toLowerCase() !== resolvedRoot.toLowerCase()) throw new GuiError('unsafe_path', `${resolvedRoot} resolves to ${real}`);
  const rel = path.relative(resolvedRoot, path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new GuiError('unsafe_path', `${target} is outside ${resolvedRoot}`);
  let current = resolvedRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', current);
  }
}

function ensureAdminDir(dir, { root, platform }) {
  assertSafeComponents(dir, { root });
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new GuiError('unsafe_path', dir);
  if (platform !== 'win32') fs.chmodSync(dir, 0o755);
}

function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid = null, svcGid = null, platform = process.platform, now = Date.now() }) {
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  const file = canonicalPath(configDir);
  assertSafeComponents(file, { root: configDir });
  const record = {
    v: 1,
    node_id: nodeId,
    endpoint_id: endpointId,
    secret: cipher.encryptString(secret.toString('hex')),
    rotated_at: new Date(now).toISOString(),
    session_user: sessionUser,
    session_sid: sessionSid
  };
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o640);
  if (platform !== 'win32') {
    fs.chmodSync(file, 0o640);
    if (svcGid !== null) fs.chownSync(file, process.getuid(), svcGid);
  }
  return file;
}

function canonicalMtime(configDir) {
  try {
    return fs.statSync(canonicalPath(configDir)).mtimeMs;
  } catch {
    return null;
  }
}

function readCanonical({ configDir, cipher, geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1), adminUid = 0 }) {
  const file = canonicalPath(configDir);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (run "king-louie-service session install --user NAME")`);
  }
  // Required lazily: node-config.js requires this module's sibling config.js.
  const { assertAdminOwned } = require('../service/node-config');
  assertAdminOwned(file, geteuid, adminUid, { decides: 'who the session helper is', selfGrant: 'pose as the session helper' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.v !== 1 || !ENDPOINT_RE.test(String(raw.endpoint_id)) || typeof raw.node_id !== 'string' || typeof raw.session_user !== 'string') {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  const hex = cipher.decryptString(raw.secret);
  if (!SECRET_HEX_RE.test(hex)) throw new GuiError('session_not_installed', `${file} holds no valid secret`);
  return {
    secret: Buffer.from(hex, 'hex'),
    endpointId: raw.endpoint_id,
    nodeId: raw.node_id,
    sessionUser: raw.session_user,
    sessionSid: raw.session_sid || null,
    mtimeMs: st.mtimeMs
  };
}

function windowsUserAclArgs(file, sid, env = process.env) {
  return [windowsIcaclsExe(env), file, '/inheritance:r', '/grant:r', `*${sid}:(R)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
}

function defaultRunIcacls(argv) {
  execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
}

function writeUserCopy({ platform = process.platform, configDir, user, uid, gid, sid, content, runIcacls = defaultRunIcacls, env = process.env }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  ensureAdminDir(path.dirname(file), { root: configDir, platform });
  assertSafeComponents(file, { root: configDir });
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', file);
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
    if (platform !== 'win32') {
      fs.fchownSync(fd, uid, gid);
      fs.fchmodSync(fd, 0o600);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (platform === 'win32') runIcacls(windowsUserAclArgs(file, sid, env));
  return file;
}

function removeUserCopy({ platform = process.platform, configDir, user, sid }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  assertSafeComponents(file, { root: configDir });
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function readUserCopy({ path: file, platform = process.platform, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1), rootUid = 0 }) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (ask the administrator to run "session install")`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new GuiError('session_file_insecure', `${file} is not a regular file`);
  if (platform !== 'win32') {
    const dir = fs.statSync(path.dirname(file));
    if (st.mode & 0o077) throw new GuiError('session_file_insecure', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)})`);
    if (st.uid !== getuid()) throw new GuiError('session_file_insecure', `${file} is not owned by this user`);
    if (dir.uid !== rootUid || (dir.mode & 0o022)) throw new GuiError('session_file_insecure', `${path.dirname(file)} is not an administrator-owned directory`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new GuiError('session_not_installed', `${file} is not valid JSON`);
  }
  if (raw.v !== 1 || typeof raw.node_id !== 'string' || typeof raw.endpoint !== 'string' || !SECRET_HEX_RE.test(String(raw.secret))) {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  return { secret: Buffer.from(raw.secret, 'hex'), endpoint: raw.endpoint, nodeId: raw.node_id };
}

function resolveSessionUser(name, { platform = process.platform, execFile = (f, a, o) => execFileSync(f, a, { encoding: 'utf8', windowsHide: true, ...o }), env = process.env, exists = fs.existsSync } = {}) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 104 || /[\u0000-\u001f"]/.test(name)) {
    throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  }
  const run = (file, argv, options = {}) => {
    try {
      return String(execFile(file, argv, options));
    } catch {
      throw new GuiError('user_not_found', name);
    }
  };
  if (platform === 'win32') {
    const script = '(New-Object System.Security.Principal.NTAccount($env:KL_SESSION_USER)).Translate([System.Security.Principal.SecurityIdentifier]).Value';
    const sid = run(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...env, KL_SESSION_USER: name } }).trim();
    if (!SID_RE.test(sid)) throw new GuiError('user_not_found', name);
    return { user: name, uid: null, gid: null, home: null, sid };
  }
  if (!POSIX_USER_RE.test(name)) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  const uid = Number(run('/usr/bin/id', ['-u', name]).trim());
  const gid = Number(run('/usr/bin/id', ['-g', name]).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new GuiError('user_not_found', name);
  let home;
  if (platform === 'darwin') {
    const m = /NFSHomeDirectory:\s*(\S.*)$/m.exec(run('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory']));
    home = m ? m[1].trim() : null;
  } else {
    home = run('/usr/bin/getent', ['passwd', name]).trim().split(':')[5] || null;
  }
  if (!home || !home.startsWith('/') || !exists(home)) throw new GuiError('home_missing', `${name} has no home directory`);
  return { user: name, uid, gid, home, sid: null };
}

module.exports = {
  mintSessionSecret, canonicalPath, writeCanonical, readCanonical, canonicalMtime,
  userCopyPath, writeUserCopy, readUserCopy, removeUserCopy,
  endpointPath, sessionIpcDir, assertSafeComponents, windowsUserAclArgs, resolveSessionUser
};
```

Two notes for the implementer:
- `readCanonical` requires `../service/node-config` lazily because `node-config.js` requires `../gui/config`; a top-level require here would still work (no cycle through this file), but the lazy form keeps `session-secret.js` out of every profile graph that loads `node-config.js`.
- The `resolveSessionUser` Windows branch returns `uid/gid/home` as `null`: Windows needs only the SID.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/gui-session-secret.test.js`
Expected: PASS, `# fail 0` (POSIX-only cases skip on Windows and the junction case skips elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/gui/session-secret.js src/platform/windows-paths.js tests/gui-session-secret.test.js
git commit -m "feat(gui): session secret, per-user copies and endpoint paths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `lease-v1` protocol — messages, checks, vectors and the document

**Files:**
- Create: `src/gui/lease-protocol.js`
- Create: `tests/vectors/lease-v1/generate.js` (and the 26 files it writes)
- Create: `docs/protocol/lease-v1.md`
- Test: `tests/lease-vectors.test.js`

**Interfaces:**
- Consumes: `seal`, `open`, `nodeSigner`, `verifyEd25519` (`src/approvals/envelope.js`); `registerMessageValidator`, `isTimestamp`, `NONCE_RE`, `DEVICE_ID_RE`, `NODE_ID_RE`, `normalizeOrigin`, `iso`, `randomNonce` (`src/approvals/messages.js`); `verifyDeviceEnvelope`, `NonceCache` (`src/approvals/verify-device.js`); `canonicalize`, `sha256b64url` (`src/platform/jcs.js`).
- Produces (`src/gui/lease-protocol.js`):
  - `LEASE_LIMITS = ['no_lock_detect', 'no_human_yield']`, `REQUEST_TTL_MS = 300000`, `VIEW_MAX_BYTES = 262144`, `CHECK_OF` (reason → approval-v1 check number).
  - `leaseHash(lease) → b64url`.
  - `buildLeaseRequest({ identity, nodeName, jobId, apps: [{ id, name, path, processes }], maxMinutes, reason, resumes = null, limits = [], origin, now = Date.now(), requestId, leaseId, nonce }) → { message, envelope }`.
  - `buildLeaseStatus({ identity, leaseId, seq, state, locked, reason, expiresAt, now }) → envelope` (`expiresAt` ms or null).
  - `buildLeaseView({ identity, leaseId, seq, toDevice, state, locked, remainingS, foreground, frame, frameDropped, actions, now }) → envelope`.
  - `verifyLeaseGrant(envelope, { approverStore, nodeId, nonces, pending, guiApps, jobOpen, guiMaxMinutes }, now) → { accepted, check, reason, message?, bytes?, deviceId?, request? }` where `pending` is a `Map` of `request_id → { request_id, lease_id, nonce, lease_hash, expires_at, lease }`.
  - `verifyLeaseRevoke(envelope, { approverStore, nodeId, nonces, knownLease }) → { accepted, check, reason, message? }`; `verifyLeaseWatch(...)` (same shape).
  - `verifyLeaseView(envelope, { nodeId, nodePublicKeyHex, maxBytes = VIEW_MAX_BYTES }) → { accepted, reason }` (the phones' reference; Node uses it in tests).
  - `effectiveExpiry({ verifiedAt, minutes, resumeOf = null }) → ms` (`min(verifiedAt + minutes, resumeOf)` for a resume).
  - Side effect on load: validators for `kl.lease.request|grant|revoke|watch|status|view` are registered (a second load is harmless).

- [ ] **Step 1: Write the generator**

Create `tests/vectors/lease-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/lease-v1/generate.js
//
// Rebuilds every lease-v1 vector (fleet stage 5 spec §4.1) from
// ../approval-v1/keys.json.
//   node tests/vectors/lease-v1/generate.js          write the files
//   node tests/vectors/lease-v1/generate.js --check  exit 1 if any differ
// Node signatures (Ed25519) are deterministic. Phone signatures (P-256) are
// randomized, so a committed signature that still verifies over the same
// payload is reused, which keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seal, verifyEs256, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { deriveNodeId } = require('../../../src/mesh/node-identity');
const L = require('../../../src/gui/lease-protocol');

const DIR = __dirname;
const KEYS = require('../approval-v1/keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const nonceOf = (label) => sha(`lease nonce ${label}`).toString('base64url');
const uuidOf = (label) => {
  const b = sha(`lease uuid ${label}`).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, spkiHex: spki.toString('hex'), sign: (b) => crypto.sign(null, b, key) };
}

function p256(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, key: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

const DEVICE_D = {
  A: KEYS.devices.A.d,
  B: KEYS.devices.B.d,
  C: KEYS.devices.C.d,
  D: sha('lease-v1 demo device').toString('base64url'),
  U: sha('lease-v1 unknown device').toString('base64url')
};
const DEVICES = Object.fromEntries(Object.entries(DEVICE_D).map(([k, d]) => {
  const { jwk, key } = p256(d);
  return [k, { id: deviceIdFromJwk(jwk), jwk, key }];
}));

function record(label, { platform = 'android', revokedAt = null } = {}) {
  const d = DEVICES[label];
  return {
    v: 1, device_id: d.id, name: `Test phone ${d.id.slice(2, 6)}`, platform, public_key: d.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: revokedAt, revoked_by: revokedAt ? 'console' : null, enrollment: null
  };
}
const APPROVERS = [record('A'), record('B'), record('C', { revokedAt: '2026-09-20T00:00:00.000Z' }), record('D', { platform: 'demo' })];

// Committed phone signatures, reused while they still verify.
function sigCache() {
  const cache = new Map();
  if (!fs.existsSync(DIR)) return cache;
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    const v = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (v.input && v.input.alg === 'ES256') cache.set(`${v.input.kid}|${v.input.payload}`, v.input.sig);
  }
  return cache;
}
const CACHE = sigCache();

function phoneSeal(label, message) {
  const d = DEVICES[label];
  const signer = { alg: 'ES256', kid: d.id, sign: (bytes) => crypto.sign('sha256', bytes, { key: d.key, dsaEncoding: 'ieee-p1363' }) };
  const fresh = seal(message, signer);
  const cached = CACHE.get(`${fresh.kid}|${fresh.payload}`);
  if (cached && verifyEs256({ ...fresh, sig: cached }, d.jwk)) return { ...fresh, sig: cached };
  return fresh;
}

const GPU = nodeIdentity('gpu-box');
const WEB = nodeIdentity('web-01');
const GUI_APPS = {
  calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
  notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processes: [] }
};
const appsFor = (ids, apps = GUI_APPS) => ids.map((id) => ({ id, name: apps[id].name, path: apps[id].path, processes: [...apps[id].processes] }));
const JOB = 'job-1758650651201-a1b2c3';

function requestFor(label, { appIds = ['calculator', 'notepad'], maxMinutes = 15, resumes = null, leaseLabel = label } = {}) {
  return L.buildLeaseRequest({
    identity: GPU, nodeName: 'gpu-box', jobId: JOB, apps: appsFor(appIds), maxMinutes, reason: 'Enter the totals', resumes: resumes ? uuidOf(`lease ${leaseLabel}`) : null,
    limits: [], origin: { client: 'claude.ai', session: 'mcp-session-1', job_id: JOB }, now: NOW_MS,
    requestId: uuidOf(`request ${label}`), leaseId: uuidOf(`lease ${leaseLabel}`), nonce: nonceOf(`request ${label}`)
  });
}

function pendingOf(message) {
  const { request_id, lease_id, nonce, lease_hash, expires_at, lease } = message;
  return { request_id, lease_id, nonce, lease_hash, expires_at, lease };
}

function grantMessage(request, { decision = 'grant', apps = null, minutes = 10, signedAt = iso(NOW_MS + 5000), device = 'A', overrides = {} } = {}) {
  return {
    v: 1, type: 'kl.lease.grant', request_id: request.request_id, lease_id: request.lease_id, node_id: request.node_id,
    lease_hash: request.lease_hash, nonce: request.nonce, decision,
    grant: decision === 'grant' ? { apps: apps || request.lease.apps.map((a) => a.id), minutes } : null,
    expires_at: request.expires_at, device_id: DEVICES[device].id, signed_at: signedAt, ...overrides
  };
}

function base(now = iso(NOW_MS + 6000)) {
  return { now, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex }, approvers: APPROVERS, allow_test_keys: true, used: [], gui_apps: GUI_APPS, jobs_open: [JOB], gui_max_minutes: 60 };
}

const PHONES = ['node', 'ios', 'android'];

function grantVector(name, { requestOptions = {}, grantOptions = {}, given = {}, pendingOverride = null, device = 'A', expect, check = null, consumers = ['node'], tamper = null, withRequest = false }) {
  const req = requestFor(name, requestOptions);
  const message = grantMessage(req.message, { device, ...grantOptions });
  let input = phoneSeal(device, message);
  if (tamper) input = tamper(input);
  const v = {
    name, consumers, check,
    given: { ...base(), pending: pendingOverride === null ? [pendingOf(req.message)] : pendingOverride, ...given },
    input, expect
  };
  if (withRequest) { v.given.request = req.envelope; v.expect = { ...expect, message }; }
  return v;
}

function revokeMessage(label, { leaseLabel = label, signedAt = iso(NOW_MS + 5000), device = 'A' } = {}) {
  return { v: 1, type: 'kl.lease.revoke', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${leaseLabel}`), reason: 'kill_switch', device_id: DEVICES[device].id, nonce: nonceOf(`revoke ${label}`), signed_at: signedAt };
}

function watchMessage(label) {
  return { v: 1, type: 'kl.lease.watch', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${label}`), device_id: DEVICES.A.id, nonce: nonceOf(`watch ${label}`), signed_at: iso(NOW_MS + 5000) };
}

function viewEnvelope({ tamperHash = false } = {}) {
  const data = sha('lease-v1 frame bytes').toString('base64');
  const hash = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64url');
  return L.buildLeaseView({
    identity: GPU, leaseId: uuidOf('lease view'), seq: 8, toDevice: DEVICES.A.id, state: 'active', locked: false, remainingS: 512,
    foreground: { app_id: 'calculator', matches: true },
    frame: { mime: 'image/jpeg', width: 960, height: 640, sha256: tamperHash ? sha('other').toString('base64url') : hash, data },
    frameDropped: false,
    actions: [{ seq: 41, at: iso(NOW_MS), tool: 'Type', summary: 'Type "12+30=" (6 chars)', result: 'ok' }],
    now: NOW_MS
  });
}

function buildVectors() {
  const out = [];
  const accepted = { accepted: true, reason: null };
  const reject = (reason) => ({ accepted: false, reason });

  out.push(grantVector('grant-valid', { grantOptions: { minutes: 15 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('grant-narrowed', { grantOptions: { apps: ['calculator'], minutes: 10 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('deny-valid', { grantOptions: { decision: 'deny' }, expect: accepted, consumers: PHONES, withRequest: true }));
  {
    // A resume: max_minutes = the whole minutes left; the grant may not
    // extend past the original expiry (given.resume_of).
    const v = grantVector('resume-capped', {
      requestOptions: { appIds: ['calculator'], maxMinutes: 4, resumes: true }, grantOptions: { minutes: 4 },
      expect: accepted, consumers: PHONES, withRequest: true
    });
    v.given.resume_of = iso(Date.parse(v.given.now) + 3 * 60000);
    v.expect.effective_expires_at = v.given.resume_of;
    out.push(v);
  }
  out.push(grantVector('grant-phone-clock-behind', { grantOptions: { signedAt: iso(NOW_MS - 3600000) }, expect: accepted }));
  // A fixed 64-byte non-signature, so the file is the same on every run.
  out.push(grantVector('bad-signature', {
    expect: reject('bad_signature'), check: 6,
    tamper: (e) => ({ ...e, sig: Buffer.concat([sha('bad sig r'), sha('bad sig s')]).toString('base64url') })
  }));
  out.push(grantVector('revoked-device', { device: 'C', expect: reject('revoked_device'), check: 5 }));
  out.push(grantVector('unknown-device', { device: 'U', expect: reject('unknown_device'), check: 3 }));
  out.push(grantVector('demo-device', { device: 'D', expect: reject('demo_device'), check: 4 }));
  out.push(grantVector('test-key', { given: { allow_test_keys: false }, expect: reject('test_key'), check: 4 }));
  out.push(grantVector('wrong-node', { grantOptions: { overrides: { node_id: WEB.nodeId } }, expect: reject('wrong_node'), check: 7 }));
  {
    const v = grantVector('replay', { expect: reject('replay'), check: 8 });
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    v.given.used = [{ nonce: v.given.pending[0].nonce, sha256: bytesSha256(Buffer.from(v.input.payload, 'base64url')) }];
    out.push(v);
  }
  out.push(grantVector('unknown-request', { pendingOverride: [], expect: reject('unknown_request'), check: 9 }));
  out.push(grantVector('lease-hash-mismatch', { grantOptions: { overrides: { lease_hash: sha('other lease').toString('base64url') } }, expect: reject('lease_hash_mismatch'), check: 10 }));
  out.push(grantVector('lease-changed-app-path', {
    given: { gui_apps: { ...GUI_APPS, calculator: { ...GUI_APPS.calculator, path: 'C:\\Tools\\calc.exe' } } },
    expect: reject('lease_changed'), check: 12
  }));
  out.push(grantVector('apps-not-requested', { grantOptions: { apps: ['calculator', 'terminal'] }, expect: reject('apps_not_requested'), check: 12 }));
  out.push(grantVector('minutes-over-requested', { grantOptions: { minutes: 20 }, expect: reject('minutes_out_of_range'), check: 12 }));
  out.push(grantVector('minutes-over-60', { requestOptions: { maxMinutes: 60 }, grantOptions: { minutes: 61 }, expect: reject('minutes_out_of_range'), check: 12 }));
  {
    const v = grantVector('expired', { expect: reject('expired'), check: 11 });
    v.given.now = iso(NOW_MS + 300001);
    out.push(v);
  }

  const leaseGiven = (known) => ({ ...base(), known_leases: known });
  out.push({ name: 'revoke-valid', consumers: PHONES, check: null, given: { ...leaseGiven([uuidOf('lease revoke-valid')]) }, input: phoneSeal('A', revokeMessage('revoke-valid')), expect: { ...accepted, message: revokeMessage('revoke-valid') } });
  out.push({ name: 'revoke-phone-clock-off', consumers: ['node'], check: null, given: leaseGiven([uuidOf('lease revoke-phone-clock-off')]), input: phoneSeal('A', revokeMessage('revoke-phone-clock-off', { signedAt: iso(NOW_MS + 86400000) })), expect: accepted });
  out.push({ name: 'revoke-unknown-lease', consumers: ['node'], check: 9, given: leaseGiven([]), input: phoneSeal('A', revokeMessage('revoke-unknown-lease')), expect: reject('unknown_lease') });
  {
    const input = phoneSeal('A', revokeMessage('revoke-replayed'));
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    const given = { ...leaseGiven([uuidOf('lease revoke-replayed')]), used: [{ nonce: nonceOf('revoke revoke-replayed'), sha256: bytesSha256(Buffer.from(input.payload, 'base64url')) }] };
    out.push({ name: 'revoke-replayed', consumers: ['node'], check: 8, given, input, expect: reject('replay') });
  }
  out.push({ name: 'watch-valid', consumers: PHONES, check: null, given: leaseGiven([uuidOf('lease watch-valid')]), input: phoneSeal('A', watchMessage('watch-valid')), expect: { ...accepted, message: watchMessage('watch-valid') } });

  const viewGiven = { now: NOW, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex } };
  out.push({ name: 'view-node-sig-valid', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope(), expect: accepted });
  out.push({ name: 'view-tampered-frame', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope({ tamperHash: true }), expect: reject('frame_hash_mismatch') });
  return out;
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  const names = new Set(vectors.map((v) => `${v.name}.json`));
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && !names.has(n))) {
    if (check) { differ += 1; process.stderr.write(`not generated: ${f}\n`); } else fs.unlinkSync(path.join(DIR, f));
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, NOW, DEVICES, GUI_APPS, JOB };
```

- [ ] **Step 2: Write the failing test**

Create `tests/lease-vectors.test.js`:

```js
// tests/lease-vectors.test.js
//
// Every lease-v1 vector through the production checks, the committed files
// equal to what generate.js builds, and the other vector sets untouched.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { NonceCache } = require('../src/approvals/verify-device');
const L = require('../src/gui/lease-protocol');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/lease-v1/generate');

setLogLevel('fatal');
const DIR = path.join(__dirname, 'vectors', 'lease-v1');
const EXPECTED = [
  'grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'grant-phone-clock-behind', 'bad-signature', 'revoked-device',
  'unknown-device', 'demo-device', 'test-key', 'wrong-node', 'replay', 'unknown-request', 'lease-hash-mismatch',
  'lease-changed-app-path', 'apps-not-requested', 'minutes-over-requested', 'minutes-over-60', 'expired', 'revoke-valid',
  'revoke-phone-clock-off', 'revoke-unknown-lease', 'revoke-replayed', 'watch-valid', 'view-node-sig-valid', 'view-tampered-frame'
];
const PHONE = ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid', 'view-node-sig-valid', 'view-tampered-frame'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function run(v) {
  const g = v.given;
  const now = Date.parse(g.now);
  if (v.name.startsWith('view-')) return L.verifyLeaseView(v.input, { nodeId: g.node.id, nodePublicKeyHex: g.node.key });
  const store = await approverStoreWith(g.approvers, { allowTestKeys: g.allow_test_keys, now: () => now });
  stores.push(store);
  const nonces = new NonceCache({ now: () => now });
  for (const u of g.used) nonces.add(u.nonce, u.sha256);
  if (v.name.startsWith('revoke-')) return L.verifyLeaseRevoke(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  if (v.name.startsWith('watch-')) return L.verifyLeaseWatch(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  const pending = new Map(g.pending.map((p) => [p.request_id, p]));
  return L.verifyLeaseGrant(v.input, {
    approverStore: store, nodeId: g.node.id, nonces, pending, guiApps: g.gui_apps,
    jobOpen: (jobId) => g.jobs_open.includes(jobId), guiMaxMinutes: g.gui_max_minutes
  }, now);
}

describe('lease-v1 vectors', () => {
  it('has exactly the expected set, and phones consume exactly theirs', () => {
    assert.equal(EXPECTED.length, 26);
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    for (const phone of ['ios', 'android']) {
      assert.deepEqual(vectors.filter((v) => v.consumers.includes(phone)).map((v) => v.name).sort(), [...PHONE].sort());
    }
    assert.ok(vectors.every((v) => v.consumers.includes('node')));
  });

  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(serialize(byName.get(v.name)), serialize(v), v.name);
  });

  it('approval-v1 and client-grant-v1 are untouched', () => {
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'approval-v1')).filter((f) => f.endsWith('.json') && f !== 'keys.json' && f !== 'jcs.json').length > 0, true);
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'client-grant-v1')).filter((f) => f.endsWith('.json')).length, 37);
  });

  for (const name of EXPECTED) {
    it(name, async () => {
      const v = byName.get(name);
      const r = await run(v);
      assert.equal(r.accepted, v.expect.accepted, `${name}: ${r.reason}`);
      assert.equal(r.reason, v.expect.reason);
      if (v.check !== null && !name.startsWith('view-')) assert.equal(r.check, v.check);
    });
  }

  it('resume-capped: a resume never extends past the original expiry', () => {
    const v = byName.get('resume-capped');
    const eff = L.effectiveExpiry({ verifiedAt: Date.parse(v.given.now), minutes: 4, resumeOf: Date.parse(v.given.resume_of) });
    assert.equal(new Date(eff).toISOString(), v.expect.effective_expires_at);
  });

  it('the phone-built messages are exactly the signed payloads', () => {
    for (const name of ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid']) {
      const v = byName.get(name);
      const payload = JSON.parse(Buffer.from(v.input.payload, 'base64url').toString('utf8'));
      assert.deepEqual(payload, v.expect.message, name);
    }
  });
});

describe('lease-v1 message shapes', () => {
  it('the node-signed request validates and hashes its lease', () => {
    const v = byName.get('grant-valid');
    const { open } = require('../src/approvals/envelope');
    const { validateMessage } = require('../src/approvals/messages');
    const { message } = open(v.given.request);
    assert.equal(validateMessage('kl.lease.request', message), null);
    assert.equal(message.lease_hash, L.leaseHash(message.lease));
    assert.ok(Date.parse(message.expires_at) - Date.parse(message.created_at) <= L.REQUEST_TTL_MS);
  });

  it('refuses unknown keys and out-of-range fields', () => {
    const { validateMessage } = require('../src/approvals/messages');
    const v = byName.get('revoke-valid');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, extra: 1 }), 'malformed');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, reason: 'because' }), 'malformed');
    assert.equal(validateMessage('kl.lease.watch', { ...byName.get('watch-valid').expect.message, lease_id: 'x' }), 'malformed');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/lease-vectors.test.js`
Expected: FAIL with `Cannot find module '../src/gui/lease-protocol'`.

- [ ] **Step 4: Write `src/gui/lease-protocol.js`**

```js
// src/gui/lease-protocol.js
// lease-v1 (fleet stage 5 spec §3.6, §4.1; docs/protocol/lease-v1.md): pure
// builders and checks for computer-use leases. Node-signed: request, status,
// view. Phone-signed: grant, revoke, watch, each through F3's
// verifyDeviceEnvelope (checks 1–8) and then the lease checks (9–12).
// Loaded by the relay (relay-extension.js) too, so it requires no agent code.
const crypto = require('crypto');
const { seal, open, nodeSigner, verifyEd25519, EnvelopeError } = require('../approvals/envelope');
const messages = require('../approvals/messages');
const { verifyDeviceEnvelope } = require('../approvals/verify-device');
const { canonicalize, sha256b64url } = require('../platform/jcs');

const { isTimestamp, NONCE_RE, DEVICE_ID_RE, NODE_ID_RE, normalizeOrigin, iso, randomNonce } = messages;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LEASE_LIMITS = Object.freeze(['no_lock_detect', 'no_human_yield']);
const STATES = Object.freeze(['pending', 'active', 'suspended', 'ended']);
const REVOKE_REASONS = Object.freeze(['kill_switch', 'owner']);
const REQUEST_TTL_MS = 5 * 60 * 1000;
const VIEW_MAX_BYTES = 262144;
const MAX_MINUTES = 60;
// Reason → the approval-v1 check number it belongs to (program §4.12).
const CHECK_OF = Object.freeze({
  malformed: 1, unsupported_version: 1, unknown_device: 3, demo_device: 4, test_key: 4, revoked_device: 5,
  bad_signature: 6, wrong_node: 7, replay: 8, already_decided: 8, unknown_request: 9, unknown_lease: 9,
  nonce_mismatch: 10, lease_hash_mismatch: 10, expires_mismatch: 10, expired: 11,
  lease_changed: 12, job_closed: 12, apps_not_requested: 12, minutes_out_of_range: 12
});

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const within = (v, max) => isString(v) && Array.from(v).length <= max;
const nullOr = (test) => (v) => v === null || test(v);
function exactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}
const isStringList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every((s) => isString(s) && each(s));
const uniqueSorted = (list) => list.every((x, i) => i === 0 || list[i - 1] < x);

function checkApp(a) {
  return isPlainObject(a) && exactKeys(a, ['id', 'name', 'path', 'processes'])
    && APP_ID_RE.test(a.id) && within(a.name, 64) && within(a.path, 1024) && isStringList(a.processes, 16, (s) => within(s, 1024));
}

function checkLease(l) {
  return isPlainObject(l) && exactKeys(l, ['kind', 'job_id', 'apps', 'max_minutes', 'reason', 'resumes', 'limits'])
    && l.kind === 'computer_use' && within(l.job_id, 200) && l.job_id.length > 0
    && Array.isArray(l.apps) && l.apps.length >= 1 && l.apps.length <= 8 && l.apps.every(checkApp)
    && new Set(l.apps.map((a) => a.id)).size === l.apps.length
    && Number.isInteger(l.max_minutes) && l.max_minutes >= 1 && l.max_minutes <= MAX_MINUTES
    && within(l.reason, 280) && l.reason.length > 0
    && nullOr((v) => UUID_V4_RE.test(v))(l.resumes)
    && isStringList(l.limits, LEASE_LIMITS.length, (s) => LEASE_LIMITS.includes(s)) && uniqueSorted(l.limits);
}

function checkOrigin(o) {
  return isPlainObject(o) && exactKeys(o, ['client', 'session', 'job_id']) && isString(o.client)
    && Object.values(o).every((v) => v === null || within(v, 200));
}

function checkFrame(f) {
  return f === null || (isPlainObject(f) && exactKeys(f, ['mime', 'width', 'height', 'sha256', 'data'])
    && f.mime === 'image/jpeg' && Number.isInteger(f.width) && Number.isInteger(f.height) && f.width > 0 && f.height > 0
    && HASH_RE.test(f.sha256) && isString(f.data) && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data));
}

function checkAction(a) {
  return isPlainObject(a) && exactKeys(a, ['seq', 'at', 'tool', 'summary', 'result'])
    && Number.isInteger(a.seq) && isTimestamp(a.at) && within(a.tool, 32) && within(a.summary, 120) && within(a.result, 80);
}

const VALIDATORS = {
  'kl.lease.request': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'node_name', 'lease', 'lease_hash', 'origin', 'created_at', 'expires_at', 'nonce'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && within(m.node_name, 64)
    && checkLease(m.lease) && HASH_RE.test(m.lease_hash) && checkOrigin(m.origin) && isTimestamp(m.created_at) && isTimestamp(m.expires_at)
    && Date.parse(m.expires_at) > Date.parse(m.created_at) && Date.parse(m.expires_at) - Date.parse(m.created_at) <= REQUEST_TTL_MS
    && NONCE_RE.test(m.nonce) && (m.lease.resumes === null || m.lease.resumes === m.lease_id),
  'kl.lease.grant': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'lease_hash', 'nonce', 'decision', 'grant', 'expires_at', 'device_id', 'signed_at'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && HASH_RE.test(m.lease_hash)
    && NONCE_RE.test(m.nonce) && isTimestamp(m.expires_at) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at)
    && ((m.decision === 'deny' && m.grant === null)
      || (m.decision === 'grant' && isPlainObject(m.grant) && exactKeys(m.grant, ['apps', 'minutes'])
        && isStringList(m.grant.apps, 8, (s) => APP_ID_RE.test(s)) && m.grant.apps.length >= 1
        && Number.isInteger(m.grant.minutes) && m.grant.minutes >= 1 && m.grant.minutes <= 1440)),
  'kl.lease.revoke': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'reason', 'device_id', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && REVOKE_REASONS.includes(m.reason)
    && DEVICE_ID_RE.test(m.device_id) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.watch': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'device_id', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && DEVICE_ID_RE.test(m.device_id) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.status': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'state', 'locked', 'reason', 'expires_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && STATES.includes(m.state) && typeof m.locked === 'boolean' && nullOr((v) => within(v, 64))(m.reason) && nullOr(isTimestamp)(m.expires_at),
  'kl.lease.view': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'to_device', 'state', 'locked', 'remaining_s', 'foreground', 'frame', 'frame_dropped', 'actions'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && DEVICE_ID_RE.test(m.to_device) && STATES.includes(m.state) && typeof m.locked === 'boolean'
    && Number.isInteger(m.remaining_s) && m.remaining_s >= 0
    && isPlainObject(m.foreground) && exactKeys(m.foreground, ['app_id', 'matches']) && nullOr((v) => APP_ID_RE.test(v))(m.foreground.app_id) && typeof m.foreground.matches === 'boolean'
    && checkFrame(m.frame) && typeof m.frame_dropped === 'boolean'
    && Array.isArray(m.actions) && m.actions.length <= 50 && m.actions.every(checkAction)
};

for (const [type, validator] of Object.entries(VALIDATORS)) {
  try {
    messages.registerMessageValidator(type, validator);
  } catch (err) {
    if (!/already has a validator/.test(err.message)) throw err;
  }
}

const leaseHash = (lease) => sha256b64url(canonicalize(lease));

function buildLeaseRequest({ identity, nodeName, jobId, apps, maxMinutes, reason, resumes = null, limits = [], origin, now = Date.now(), requestId = null, leaseId = null, nonce = null }) {
  const lid = leaseId || crypto.randomUUID();
  const lease = {
    kind: 'computer_use',
    job_id: String(jobId),
    apps: apps.map((a) => ({ id: a.id, name: a.name, path: a.path, processes: [...a.processes] })),
    max_minutes: maxMinutes,
    reason: String(reason),
    resumes: resumes ? lid : null,
    limits: [...new Set(limits)].filter((l) => LEASE_LIMITS.includes(l)).sort()
  };
  const message = {
    v: 1,
    type: 'kl.lease.request',
    request_id: requestId || crypto.randomUUID(),
    lease_id: lid,
    node_id: identity.nodeId,
    node_name: String(nodeName || identity.nodeName || 'unnamed-node'),
    lease,
    lease_hash: leaseHash(lease),
    origin: (({ client, session, job_id: j }) => ({ client, session, job_id: j }))(normalizeOrigin(origin)),
    created_at: iso(now),
    expires_at: iso(now + REQUEST_TTL_MS),
    nonce: nonce || randomNonce()
  };
  return { message, envelope: seal(message, nodeSigner(identity)) };
}

function buildLeaseStatus({ identity, leaseId, seq, state, locked = false, reason = null, expiresAt = null, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.status', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), state, locked,
    reason: reason === null || reason === undefined ? null : String(reason).slice(0, 64),
    expires_at: expiresAt === null || expiresAt === undefined ? null : iso(expiresAt)
  }, nodeSigner(identity));
}

function buildLeaseView({ identity, leaseId, seq, toDevice, state, locked, remainingS, foreground, frame, frameDropped, actions, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.view', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), to_device: toDevice, state, locked,
    remaining_s: Math.max(0, Math.floor(remainingS)), foreground, frame, frame_dropped: frameDropped === true, actions
  }, nodeSigner(identity));
}

const reject = (reason) => ({ accepted: false, check: CHECK_OF[reason] || null, reason });
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function verifyLeaseGrant(envelope, { approverStore, nodeId, nonces, pending, guiApps, jobOpen = () => true, guiMaxMinutes = MAX_MINUTES }, now = Date.now()) {
  const device = verifyDeviceEnvelope(envelope, { approverStore, type: 'kl.lease.grant', nodeId, nonces });
  if (!device.ok) return reject(device.reason);
  const m = device.message;
  const request = pending.get(m.request_id);
  if (!request || request.lease_id !== m.lease_id) return reject('unknown_request');
  if (m.nonce !== request.nonce) return reject('nonce_mismatch');
  if (m.lease_hash !== request.lease_hash) return reject('lease_hash_mismatch');
  if (m.expires_at !== request.expires_at) return reject('expires_mismatch');
  if (!(now <= Date.parse(request.expires_at))) return reject('expired');
  if (leaseHash(request.lease) !== m.lease_hash) return reject('lease_changed');
  for (const app of request.lease.apps) {
    const live = guiApps && Object.hasOwn(guiApps, app.id) ? guiApps[app.id] : null;
    if (!live || live.path !== app.path || !sameList(live.processes, app.processes)) return reject('lease_changed');
  }
  if (!jobOpen(request.lease.job_id)) return reject('job_closed');
  if (m.decision === 'grant') {
    const requested = request.lease.apps.map((a) => a.id);
    const apps = m.grant.apps;
    if (new Set(apps).size !== apps.length || !apps.every((id) => requested.includes(id))) return reject('apps_not_requested');
    const cap = Math.min(request.lease.max_minutes, guiMaxMinutes, MAX_MINUTES);
    if (m.grant.minutes < 1 || m.grant.minutes > cap) return reject('minutes_out_of_range');
  }
  return { accepted: true, check: null, reason: null, message: m, bytes: device.bytes, deviceId: device.deviceId, request };
}

function verifyLeaseControl(type) {
  return (envelope, { approverStore, nodeId, nonces, knownLease }) => {
    const device = verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces });
    if (!device.ok) return reject(device.reason);
    if (!knownLease(device.message.lease_id)) return reject('unknown_lease');
    return { accepted: true, check: null, reason: null, message: device.message, bytes: device.bytes, deviceId: device.deviceId };
  };
}

const verifyLeaseRevoke = verifyLeaseControl('kl.lease.revoke');
const verifyLeaseWatch = verifyLeaseControl('kl.lease.watch');

// What a phone checks on a view (spec §3.10, §4.1): the node's signature
// over the received bytes, the shape, the size, and that the frame is the
// one the node hashed.
function verifyLeaseView(envelope, { nodeId, nodePublicKeyHex, maxBytes = VIEW_MAX_BYTES }) {
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return { accepted: false, reason: 'malformed' };
    throw err;
  }
  if (opened.bytes.length > maxBytes) return { accepted: false, reason: 'too_large' };
  if (envelope.alg !== 'Ed25519' || envelope.kid !== nodeId) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, nodePublicKeyHex)) return { accepted: false, reason: 'bad_signature' };
  if (messages.validateMessage('kl.lease.view', opened.message)) return { accepted: false, reason: 'malformed' };
  if (opened.message.node_id !== nodeId) return { accepted: false, reason: 'wrong_node' };
  const frame = opened.message.frame;
  if (frame) {
    const hash = crypto.createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('base64url');
    if (hash !== frame.sha256) return { accepted: false, reason: 'frame_hash_mismatch' };
  }
  return { accepted: true, reason: null, message: opened.message };
}

function effectiveExpiry({ verifiedAt, minutes, resumeOf = null }) {
  const fresh = verifiedAt + minutes * 60000;
  return resumeOf === null ? fresh : Math.min(fresh, resumeOf);
}

module.exports = {
  LEASE_LIMITS, STATES, REQUEST_TTL_MS, VIEW_MAX_BYTES, CHECK_OF,
  leaseHash, buildLeaseRequest, buildLeaseStatus, buildLeaseView,
  verifyLeaseGrant, verifyLeaseRevoke, verifyLeaseWatch, verifyLeaseView, effectiveExpiry
};
```

Two notes for the implementer:
- Check `src/approvals/messages.js` exports `normalizeOrigin` and `iso` (it does, lines 363–399). `normalizeOrigin` adds `deviceId` for `client: 'desktop'`; `buildLeaseRequest` keeps only the three keys, because GUI tools never run on the Electron host (no `gui` dep there).
- `verifyLeaseGrant` never marks the nonce used; the caller (`LeaseManager.onGrant`, Task 9) adds it to the cache only when a decision is applied, so a rejected grant leaves the request pending (spec §3.6 "A failed check leaves the request pending").

- [ ] **Step 5: Generate the vectors and run the tests**

Run: `node tests/vectors/lease-v1/generate.js` → `26 vectors written`.
Run it again, then `node tests/vectors/lease-v1/generate.js --check` → `26 vectors match` (the second run reuses the committed P-256 signatures).
Run: `node --test tests/lease-vectors.test.js tests/client-grant-v1-vectors.test.js tests/approvals-protocol.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Write `docs/protocol/lease-v1.md`**

```markdown
# lease-v1 — computer-use leases

A lease lets an agent drive a few allowlisted desktop apps on one node for a
bounded time, under one phone signature (fleet stage 5 spec §3.6, §4.1; the one
exception to trust principle 3). Envelopes, JCS, keys and identifiers are
approval-v1's (§1–§2 of `approval-v1.md`).

## 1. Messages

Node-signed (Ed25519, `kid` = `node_id`): `kl.lease.request`, `kl.lease.status`,
`kl.lease.view`. Phone-signed (ES256, `kid` = `device_id`): `kl.lease.grant`,
`kl.lease.revoke`, `kl.lease.watch`. Every object has exactly the keys shown.

```jsonc
{ "v": 1, "type": "kl.lease.request", "request_id": "uuid-v4", "lease_id": "uuid-v4",
  "node_id": "kl-…", "node_name": "gpu-box",
  "lease": { "kind": "computer_use", "job_id": "job-…",
             "apps": [{ "id": "calculator", "name": "Calculator", "path": "C:\\Windows\\System32\\calc.exe", "processes": ["CalculatorApp.exe"] }],
             "max_minutes": 15, "reason": "Enter the totals", "resumes": null, "limits": [] },
  "lease_hash": "b64url(SHA-256(JCS(lease)))",
  "origin": { "client": "claude.ai", "session": "…", "job_id": "job-…" },
  "created_at": "RFC3339", "expires_at": "≤ created_at + 5 min", "nonce": "b64url(32)" }
{ "v": 1, "type": "kl.lease.grant", "request_id", "lease_id", "node_id", "lease_hash", "nonce" (the request's),
  "decision": "grant" | "deny", "grant": { "apps": ["calculator"], "minutes": 10 } | null,
  "expires_at" (the request's), "device_id", "signed_at" (informational) }
{ "v": 1, "type": "kl.lease.revoke", "node_id", "lease_id", "reason": "kill_switch" | "owner", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.watch", "node_id", "lease_id", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.status", "node_id", "lease_id", "seq", "at", "state": "pending|active|suspended|ended",
  "locked": false, "reason": "…" | null, "expires_at": "…" | null }
{ "v": 1, "type": "kl.lease.view", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s",
  "foreground": { "app_id": "calculator" | null, "matches": true },
  "frame": { "mime": "image/jpeg", "width", "height", "sha256": "b64url(SHA-256(JPEG bytes))", "data": "base64" } | null,
  "frame_dropped": false,
  "actions": [{ "seq", "at", "tool", "summary" (≤ 120), "result": "ok" | "refused:<code>" }] (≤ 50) }
```

Rules: `lease.apps` 1–8 unique ids from `gui.apps`; `max_minutes` 1–60 and ≤
`gui.lease.max_minutes`; `reason` ≤ 280 (model-written: phones label it "Agent's
reason (unverified)"); `resumes` is `null` or equals `lease_id`; `limits` ⊆
`no_lock_detect`, `no_human_yield`, sorted; `grant.apps` a non-empty subset of
the requested ids; `1 ≤ grant.minutes ≤ max_minutes`; a view ≤ 256 KiB.

## 2. What the node checks on a grant

| # | Check | Reason |
|---|---|---|
| 1–8 | approval-v1 checks 1–8 with `type: 'kl.lease.grant'` (`verifyDeviceEnvelope`) | `malformed` … `replay`, `already_decided` |
| 9 | A pending request with this `request_id` and `lease_id` | `unknown_request` |
| 10 | `nonce`, `lease_hash`, `expires_at` equal the request's | `nonce_mismatch`, `lease_hash_mismatch`, `expires_mismatch` |
| 11 | Node clock ≤ `expires_at` | `expired` |
| 12 | Fresh hash of the pending lease = `lease_hash`, and each app is still in `gui.apps` with the same `path`/`processes`; the job is open; `grant.apps` ⊆ requested; minutes in range | `lease_changed`, `job_closed`, `apps_not_requested`, `minutes_out_of_range` |

A failed check leaves the request pending; every result is audited. Expiry is
node-clock only: `verified_at + minutes`, and for a resume `min(that, the
original expiry)`. `signed_at` is recorded and never judged.

Revoke and watch: checks 1–8 with their own type and a 10-minute nonce cache,
then the `lease_id` must be known (`unknown_lease`). Any enrolled device may
revoke any lease; a replayed revoke changes nothing and re-sends the status.

## 3. What the phone checks and shows

- `request`, `status`, `view`: the node signature against the node key pinned
  at enrollment, over the received bytes; anything that fails is not shown.
- `request`: `lease_hash` equals SHA-256 of the JCS lease. Show node name, job id,
  origin client, the reason labelled "Agent's reason (unverified)", one row per
  app with `name`, full `path` and `processes` (each a toggle, default on), a
  duration stepper 1…`max_minutes` (a resume shows the remaining time, fixed), and
  the `limits` as warnings. Grant = biometric signature of `kl.lease.grant`.
- `view`: ≤ 256 KiB, `frame.sha256` matches `frame.data` (else
  `frame_hash_mismatch`).
- Canonical form: lease messages contain `null` and integers other than `v`;
  the phones' JCS emits both (RFC 8785).

## 4. Transport (relay routes, mounted by `src/gui/relay-extension.js`)

| Route / method | Shape |
|---|---|
| node → relay | `link.send(envelope, { push: { kind: 'lease', id: request_id, expires_at } })` for requests; statuses plain; views with `{ to_device }`; mailbox prefix `kl.lease.`, 5 min, 256 KiB |
| `GET /v1/leases?wait=0..25` | `[{ node_id, envelope, status }]`: pending requests for the device's nodes with the latest status of each lease |
| `POST /v1/leases/{lease_id}/grant` · `/revoke` · `/watch` | body = the phone envelope → `202 { state, reason? }`, `503 node_offline` |
| `GET /v1/leases/{lease_id}/views?after_seq&wait` | `[{ seq, envelope }]` of views to the caller and statuses, oldest first |
| node methods | `lease.grant`, `lease.revoke`, `lease.watch`: `{ envelope }` → `{ state, reason? }` |

## 5. Vectors

`tests/vectors/lease-v1/`, rebuilt by `generate.js`; shape
`{ name, consumers, check, given: { now, node, approvers, allow_test_keys, pending, used, gui_apps, jobs_open, gui_max_minutes }, input, expect: { accepted, reason } }`.
Phone-built vectors also carry `given.request` and `expect.message` (the exact
message the phone must build). Phones consume `grant-valid`, `grant-narrowed`,
`deny-valid`, `resume-capped`, `revoke-valid`, `watch-valid`,
`view-node-sig-valid`, `view-tampered-frame`.
```

- [ ] **Step 7: Commit**

```bash
git add src/gui/lease-protocol.js tests/vectors/lease-v1 tests/lease-vectors.test.js docs/protocol/lease-v1.md
git commit -m "feat(gui): lease-v1 messages, checks, vectors and protocol doc

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 1

Run `npm test` and confirm `# fail 0`. Part 2 (`2026-09-23-fleet-stage5-session-helper-part2.md`) starts at Task 7 on these commits.
