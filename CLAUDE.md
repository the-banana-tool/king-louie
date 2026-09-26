# king-louie

Electron desktop chat app. Main process in `main.js`, renderer in `renderer.js`,
tools and providers under `src/`.

## Testing

Tests use **node's built-in test runner** (`node --test`), not Jest. Do not
invoke `jest` or `npx jest` — Jest will report "Test suite must contain at
least one test" because the files use `node:test`'s `describe`/`it` API and
no `test()`/`it()` calls jest can detect, and you'll miss real failures.

Run tests with:
- `npm test` — full suite (`node --test tests/*.test.js`)
- `node --test tests/<file>.test.js` — single file
- `npm run test:e2e` — sequential e2e suite

When iterating on a specific module, run just its test file directly with
`node --test`. Output uses TAP format; look for `# fail 0` / `# pass N` in the
summary block.

`npm run test:e2e` launches the real Electron binary through Playwright's
`_electron` (`tests/e2e/helpers.js`). Every launch gets its own temporary
`--user-data-dir` (the helper throws `userData isolation failed` otherwise), so
e2e tests never touch the real profile; give `launchApp({ seed })` any files a
test needs. The helper deletes `ELECTRON_RUN_AS_NODE` from the child's env
(Electron treats an empty value the same as `1`); unset it in the shell too:

```bash
unset ELECTRON_RUN_AS_NODE && npm run test:e2e
```

Unit tests (`npm test`) don't launch Electron and are unaffected either way.

`tests/e2e/helpers.js`'s `launchApp()` already gives every launch its own fresh
`--user-data-dir` (removed again in `closeApp()`), so the e2e suite never reads
or writes your real King Louie profile — chats, settings, the vault.

## Running the app

`npm start` launches Electron normally. If it dies instantly with
`Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`
at `main.js:9`, the environment has `ELECTRON_RUN_AS_NODE=1` set — that makes
the Electron binary run as plain Node, so `app`, `protocol`, and `BrowserWindow`
are all undefined.

**This is the normal state of an agent shell.** Electron-based tools (VS Code's
integrated terminal, Electron-based CLI agents) set it for their own child
processes and it is inherited. Setting it to an empty string is **not**
enough — Electron treats a present-but-empty `ELECTRON_RUN_AS_NODE` the same
as `1` and still crashes at the same line. It has to be removed from the
environment entirely:

```bash
unset ELECTRON_RUN_AS_NODE && npm start
```

To drive the UI programmatically, use Playwright's `_electron` — it is already a
dependency. Launch `node_modules/electron/dist/electron.exe` (or
`dist/electron` on Linux, `dist/Electron.app/Contents/MacOS/Electron` on macOS)
and **delete `ELECTRON_RUN_AS_NODE` from the env you pass the child**, or the
launch fails with "Process failed to launch!". Pass
`--user-data-dir=<temp path>` to get a clean profile instead of mutating real
chats, settings, and the vault.

Click through `page.evaluate(() => document.getElementById(id).click())` rather
than `locator.click()`, and remember the onboarding wizard appears on a fresh
profile (`#wizard-skip-btn` dismisses it).

## Service mode

`node bin/king-louie-service.js run --data-dir <tmp> --profile agent` runs King Louie
headless (no Electron — `ELECTRON_RUN_AS_NODE` is irrelevant here). Everything under
`src/` must stay Electron-free except `src/ipc/`; `tests/electron-boundary.test.js`
enforces it. Host-specific behaviour is injected into `createCore(deps)` (`src/core/`).

## Logging

Use `createLogger` from `src/logging.js` instead of bare `console.*` calls.
Loggers are scoped by subsystem name and support hierarchical children,
level filtering, and structured metadata.

```js
const { createLogger } = require('./logging');   // or '../logging' from subdirs
const log = createLogger('my-module');

log.info('something happened');
log.warn('degraded', { latencyMs: 430 });

const child = log.child('sub-part');             // → [my-module/sub-part]
const bound = log.withContext({ sessionId: 's-1' }); // metadata on every call
```

Levels (low → high): `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`.
Default is `info`. Override with `KING_LOUIE_LOG_LEVEL` or `LOG_LEVEL` env var.

## Cases

`src/cases/` implements case repositories (spec:
`docs/superpowers/specs/2026-09-22-king-louie-cases-design.md`). A case is a
git repo under `<dataDir>/cases/` (override with `settings.cases.root` or
`KL_CASES_ROOT`), so **`git` must be on PATH** for anything that creates one.

- A chat with `caseId` runs every turn in case mode: `CaseRuntime.beginTurn`
  locks the case and builds the orientation, `endTurn` commits.
- The model writes the case only through the `Ledger`, `Brief`, `Decide` and
  `Recommend` tools. `facts.jsonl` is append-only; never rewrite it in code.
- Tests that create cases use a temp root. The e2e suite sets
  `KL_CASES_ROOT` before launching the app so the real profile is untouched.
- `provenance: 'user'` (a Ledger assert, and the Brief owner-only fields `why`,
  `hardConstraints`, `alreadyTried`) must carry a `quote` that appears in
  `caseContext.ownerMessages`. The chat send path fills that list with the
  owner's own messages. Without a match, the tool refuses. Tests that exercise
  user provenance must supply `ownerMessages`.
- Only `user` provenance is host-verified. `sourced` is model-declared, so a
  sourced fact is only as good as the source the model names. The write guard
  covers Write, Edit and MultiEdit, not Bash: in stage 1 a shell command can
  still rewrite `facts.jsonl`.

## Cases: unattended (stage 2)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md`.

- Status (`case.yaml` `status`, `statusReason`) changes only through
  `CaseRuntime.setStatus`, which requires a `kind` naming why (`src/cases/status.js`'s
  `REASON_KINDS`) and refuses without one; `status.js` also holds the
  transition table and the per-status tool rules. Every case tool checks
  `assertWritable`; `Decide`, `Recommend` and `Fail` also call
  `requireReoriented`, which refuses when no turn is registered, so tests that
  call them begin a turn first.
- Wake-ups: the protected cron system job `cases:wakeups` (every minute,
  `ensureWakeupJob`) calls `CaseRuntime.runDueWakeups`. A wake-up turn makes one
  `orient` call (charged like any other usage), then runs a `judge` loop
  confined to the case tools plus Read, Glob and Grep (`allowedToolNames`,
  `denyAutoApproval`, no owner messages). A wake-up that fails backs off
  through `retryBackoffMinutes` and briefs the owner on the third strike.
  Settings: `settings.cases.wakeups`; off with `enabled: false`.
- Budgets live in `.kl/budget.json`. `usd` and `deadline` at 100 % pause the
  case and record `statusReason.resumeTo` (the status to return to); per-day
  categories refuse their action until the local day rolls over. Raising a
  limit applies only through two host-verified paths, checked in
  `CaseRuntime.applyOwnerFact`: an answer to a host-created `budget-grant`
  question (routed through `CaseRuntime.answerQuestion`; a grant reply is just
  the amount), or an owner action (the case panel's Grant button,
  `CaseRuntime.grantBudget`, which validates the limit and writes an
  `owner-action`-sourced fact before applying the effect directly, no
  question involved). A model-created question or a quoted user-message fact
  naming the same budget subject/attr is recorded but changes no limit, so an
  owner's quoted "ok" in chat cannot self-serve a raise.
- Resuming from `needs-direction` is not limited to those two paths: any
  host-verified `user`-provenance fact with subject `direction` resumes the
  case in `applyOwnerFact`, whether it came from answering the `direction`
  question or from a quote-verified user-message fact recorded straight from
  chat (`caseContext.ownerMessages`) — the direction does not need to run
  through a question first.
- Questions live in `.kl/questions/`. Create them with
  `CaseRuntime.createQuestion`; answer them only through
  `CaseRuntime.answerQuestion` (exactly one host-verified `user` fact).
- Case-file writes outside a turn go through `CaseRuntime.systemAction`. Tests
  inject a fake clock with `new CaseRuntime({ now })` and a temp root.
- On shutdown, `create-core.js`'s `shutdown()` stops cron, calls
  `CaseRuntime.beginShutdown` and `abortUnattended` (blocking any new wake-up
  turn and signalling in-flight ones), awaits the in-flight `cases:wakeups`
  sweep (`wakeupsInFlight`, bounded by `shutdownTimeoutMs`), then calls
  `CaseRuntime.releaseAll` so a turn cut off by quit doesn't leave its case
  locked. The e2e suite runs every launch on its own throwaway
  `--user-data-dir` (see Testing above), so it never touches a real case
  store.

## Examples

`examples/` (fleet node configs, runbooks, sudoers, the Windows ACL script,
MCP client configs) and `docs/install-guide.md` hold invented values only.
`tests/examples.test.js` loads every example through the real loaders
(`loadNodeConfig`, `loadServiceConfig`, `RunbookEngine`), and
`tests/examples-e2e.test.js` runs every example runbook with its programs
faked. A new value in either place must pass `scanForPersonalValues` in
`tests/helpers/example-denylist.js`: `example.com` hosts, documentation IP
ranges, `+15550100`–`+15550199`, `<placeholder>` path segments.

`node.yaml`, and `features.*`/`ports.*` in the admin `service.json`, reject
unknown keys. A stage that parses a new `node.yaml` top-level key appends it to
`NODE_YAML_KEYS` in `src/service/node-config.js` in the same change. A new
feature or port is known once it is in `DEFAULT_FEATURES`/`DEFAULT_PORTS`, and
the four `examples/fleet/*/service.json` files must list it too.

## Attached mode

The desktop app can be a window onto a local `king-louie-service` (fleet stage 7,
spec `docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md`). The service
opens a loopback desktop bridge (`127.0.0.1`, default port `18796`) behind
`features.desktopBridge` in `<configDir>/service.json`, which is **off by default**
and binds to loopback only; port `0` (ephemeral, test-only) logs a warning. In
attached mode `main.js` builds no core and `src/ipc/attached-host.js` proxies the
allowlisted channels (`src/desktop-bridge/allowlist.js`; a stage whose domain must
work while attached appends it to `PROXIED_DOMAINS`).

- **Pairing:** start from Settings > Local service, then run the command it shows
  as root/Administrator: `king-louie-service desktop pair <request>`. The CLI
  prints the device's label and fingerprint first and asks "Trust this device?
  [y/N]" on a TTY (default no); off a TTY it needs `--yes` or refuses (exit 2).
  Nothing is written, not even a new node identity, before that consent. `--yes`
  passed to any other command is a usage error. The desktop's Confirm step passes
  the `nodeId` it displayed, and the desktop controller
  (`src/ipc/desktop-controller.js`) refuses with `PAIR_SERVICE_CHANGED` (the
  record changed), `PAIR_NOT_FOUND`, or `PAIR_CONFIRM_STALE` (no `nodeId`)
  rather than trust a stale or swapped record. Pending pairs expire. On Windows
  the bridge-file trust read is a PowerShell child process; keep it async
  (`readTrustedBridgeFile`), never on a synchronous path in the main process.
  Also `desktop unpair <device-id>`, `desktop list`, and
  `import --from <desktop userData> [--dry-run]` (service stopped; secrets only
  arrive through the desktop's own Import, never the CLI).
- **Detach** is a two-step confirm in the settings pane: the warning must render
  before "Detach anyway" is armed, and the second click only confirms if at least
  400 ms have passed since the warning painted — a fast double-click re-arms
  instead of detaching.
- **Unpair** forgets the pairing on the desktop and returns the administrator's
  follow-up, `king-louie-service desktop unpair <device-id>` (with `sudo` off
  Windows), which removes the device on the service side; the pane keeps showing
  it, surviving repaints and relaunches, until the owner dismisses it or starts
  pairing again.
- `--kl-standalone-once` runs one standalone session without changing the
  persisted mode: it turns channels, gateway, mesh and webhooks off from
  construction and builds cron paused (`createCore({ cronStartPaused: true })`,
  never started), so it can't act as a second consumer alongside the service;
  the `/llm` channel commands (Telegram/Slack/Discord) refuse while channels are
  off, before saving anything. Case wake-ups pause too (they run from the paused
  cron), including retries queued when a question is answered, because the
  desktop's cases may already have been copied into the service.
- Over the bridge, `settings:runLlmCommand` refuses the `/llm` channel actions
  outright (`CHANNELS_NOT_PROXIED`): channels are managed on the service.
- **Permission rules** the desktop adds are tagged `origin: 'desktop'` and are
  consulted only when no service rule matched (`src/tools/permission-rules.js`),
  so a desktop `allow` never lifts a service `deny`; service rules keep plain
  first-match order.
- A failed host start (attached or standalone) shows an error dialog
  (`dialog.showErrorBox`) and quits rather than leaving a half-started app.
- Only events marked by `markLocalDesktopEvent` (the standalone host's ipcMain
  wrapper and the bridge dispatcher; `src/core/origin.js`) get the on-screen
  approval dialog in the service.
- **`import --from`** never lets an administrator write the data dir directly.
  On POSIX, a root reader walks the desktop profile and a separate writer child
  drops to the data dir owner's uid and primary gid before running the importer;
  the master key is resolved read-only by the root reader and handed to the
  writer only over their stdio channel, never argv/env/logs. It refuses when
  there is no key yet (start the service once first) or the data dir doesn't
  exist. Windows has no setuid, so writes instead go through a write guard
  (`src/platform/write-guard.js`) that refuses a path routed through a symlink
  or junction; the guard narrows the window but can't close it against a
  service-account swap mid-write — documented as a residual, not a promise.
- **Lockout:** a handshake with a valid device signature is never refused by
  lockout; only further *failing* attempts for an already-locked-out device id
  are refused, closed `4429` at once (no delay is added).
- **E2E:** `launchAttached()` in `tests/e2e/helpers.js` starts a temporary
  service (`tests/e2e/_attach-service.js`, stub provider), pairs, attaches and
  relaunches; `ctx.service` has `kill()`, `restart()`, `stop()`. Every launch
  (attached or not) gets a fresh temp `--user-data-dir`, asserted by the app
  itself; `KL_CASES_ROOT` and `KL_DESKTOP_BRIDGE_FILE` are pinned per launch so
  an agent shell's own env never leaks in, and the forked test service pins its
  own `KL_CASES_ROOT` under its data dir. The old `KL_TEST_BRIDGE_*` escape hatch
  is gone.

## Approvals and relay

Fleet stage 3 (spec `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`, wire protocol
`docs/protocol/approval-v1.md`). On a service node, an unsafe remote tool call or `unsafe` runbook runs
only after an enrolled phone signs an approval over the exact action; only `=== true` approves. The
service only reads the approver set in `<configDir>/approvers/`; the admin CLI writes it. On Windows
the files carry no owner check, so the service trusts `approvers\` only while (a) it cannot create a
file there (re-probed on every scan) and (b) the dir is owned by Administrators, SYSTEM or the config
dir's owner, and the config dir is not owned by LOCAL SERVICE (re-read when either dir's ChangeTime
moves). A dir's owner can always rewrite its ACL, so (b) is what stops a service-owned dir from
locking itself. `install` creates both dirs Administrators-owned, read and execute only for the
service. When the service runs as the same account that owns the config dir (a hand-made layout, like
the e2e test), the owner check cannot tell them apart.

- Relay host (admin `service.json` `relay` block; the mesh listener must be a loopback or private IP):
  `king-louie-service relay run`, `relay code <node-name>`, `relay nodes`, `relay remove-node <name>`, `relay qr`.
- Node, as the administrator: `king-louie-service pair wss://<relay-host>:<port>` and type the code at its
  prompt (piped on stdin also works), set `approvers.relay` in `node.yaml`, start the service, then
  `king-louie-service enroll-device`. The pairing proof binds the whole identity and `pair` refuses a
  missing or mismatched TLS fingerprint; after a refusal, run `relay remove-node <name>` on the relay and
  get a new code. `enroll-device` enrolls only on `y`/`yes` at its `[y/N]` prompt, which expires with
  the code.
  Enrollments and revocations relayed from phones are staged per node: apply them with
  `king-louie-service device apply` (`--yes` skips the `[y/N]` prompt, never the signature checks);
  `device list`, `device revoke <device-id>`.
- `mcp` asks through the running service (file courier); with the service stopped every unsafe runbook
  is denied at once.
- Audit: `<dataDir>/audit/ledger-YYYY-MM.jsonl`, hash-chained; `doctor` verifies the chain.
- Tests: `tests/approvals-*.test.js`, `tests/frontdoor-*.test.js`, `tests/audit-ledger.test.js`,
  `tests/service-cli-devices.test.js`, `tests/service-cli-relay.test.js`. Vectors live in
  `tests/vectors/approval-v1/`; after changing a message, run `node tests/vectors/approval-v1/generate.js`
  and commit the files (`--check` must say `41 vectors match`). `tests/approvals-e2e.test.js` spawns real
  processes and runs on Windows or as root; on Windows it denies itself write access to a temp
  `approvers/` dir with `icacls` (as an installer's ACL would) and lifts the deny before cleanup.
- Mobile apps (`mobile/`, built from `docs/protocol/approval-v1.md`): protocol-core tests are
  `swift test` in `mobile/ios/KLProtocol` (macOS) and `../gradlew test` in `mobile/android/protocol`
  (JDK 17, no Android SDK); both read `tests/vectors/approval-v1`. `mobile/PRIVACY.md` says what the
  relay operator can see.

## Cases: contact channels (stage 4)

Spec: `docs/superpowers/specs/2026-09-23-cases-stage4-channels.md`.

- Every open question in every case goes up a contact ladder
  (`src/cases/ladder.js`): `settings.contactPolicy.ladders[urgency]`, or
  `case.yaml` `channels` (`call` = `voice`). One process per cases root runs
  it (`<casesRoot>/.contact.lock`); its state is `<dataDir>/contact/`
  (`ladder.json`, `deliveries.json`, `inbox.jsonl`, `presence.json`).
- Answers from any channel go through `ContactRouter.handleReply`
  (`src/cases/contact.js`) and then `CaseRuntime.answerQuestion`. An adapter
  sets `ownerProven` only after its own check: Telegram and Discord accept
  only a private chat/DM with the contact owner id, and only from that
  sender; email must come from the owner's address, and have either an
  authenticated pass (the topmost `Authentication-Results` header) or the
  thread's `[KL-<token>]` token (`email-channel.js`); SMS needs the owner
  number plus `#TOKEN`; voice and SMS both go through the relay; the phone
  app needs a device-signed envelope verified on the node. An explicit
  `#token` in a reply always beats reply-to/thread correlation, so a stray
  in-reply-to match can't steal an answer meant for a different question.
  Tokens are never rendered on a delivery-only channel such as ntfy
  (`caps.expectsReplies !== true` drops the reply footer), since there is
  nowhere for a reply to land. A different second answer never overwrites
  the first: the first answer stands, and a follow-up question asks which
  one stands, on the channel that gave the second answer
  (`contact.js` `_conflict`/`conflictFact`).
- Owner decision (M22): a question C2 marks `mcpAnswerable:false` — a
  budget-grant, a direction question, or a commit-failed question — is only
  answered in the app or from the owner's paired phone. Every other channel
  (Telegram, Discord, email, SMS, voice) gets "Answer this in the app"
  instead of options or buttons; approvals follow the same rule and are
  never persisted to the data-dir inbox, so a busy case refuses them outright
  rather than queuing them.
- Case code that sends to a channel uses `ContactRouter.sendExternal`, which
  runs C3's outbound gate for anyone but the owner and sends `rendered`.
- Service mode: the owner identity and channel addresses come only from the
  admin `service.json` `contact` block (`contact` joins `ADMIN_ONLY_KEYS`);
  a data-dir `settings.contact` or a `channels.<ch>.contactOwnerUserId` is
  ignored with a warning. Relay tokens and mailbox passwords live in the
  vault under `contact.`; the `Vault` tool refuses any key starting
  `contact.` and hides them from `list`. A contact host that fails to start
  never fails `core.start()` — it logs the failure, leaves contact off, and
  (outside service mode) raises one owner-visible warning; the rest of the
  app keeps running. A host that is not currently holding the cases-root
  lease (a passive instance) refuses an inbound relay push with 503 rather
  than acting on it.
- Known gaps, carried forward as PR notes rather than fixed here: a forged
  email DSN can trigger an early bounce escalation; the stage-1 gap that a
  local Bash command can rewrite `facts.jsonl` directly extends to a forged
  `inbox.jsonl` line for an ordinary (non-approval) question, which grants
  no more than that same class of local write access already does; and a
  non-owner reply that resolves a live batch token is allowed to answer that
  one batch (knowing a 30-bit token is treated as equivalent to knowing the
  thread), which is a narrow oracle scoped to a single already-live question.
- Tests use `tests/helpers/loopback-channel.js` and the fake relay/SMTP
  helpers, never a real network; `KING_LOUIE_CONTACT_TICK_MS` shortens the
  tick.
