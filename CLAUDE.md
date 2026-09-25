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

`npm run test:e2e` launches the real Electron binary (`tests/e2e/helpers.js`),
so it needs `ELECTRON_RUN_AS_NODE` actually gone from the environment, not set
to an empty string — `tests/e2e/helpers.js` passes `process.env` through
unfiltered, and Electron treats an empty value the same as `1`. From an agent
shell:

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
  categories refuse their action until the local day rolls over. Effects
  (raising a limit, resuming from `needs-direction`) apply only through two
  host-verified paths, checked in `CaseRuntime.applyOwnerFact`: an answer to a
  host-created `budget-grant` or `direction` question (routed through
  `CaseRuntime.answerQuestion`; a grant reply is just the amount), or an owner
  action (the case panel's Grant button, `CaseRuntime.grantBudget`, which
  writes an `owner-action`-sourced fact and applies the effect directly, no
  question involved). A model-created question or a quoted user-message fact
  naming the same subject/attr is recorded but changes nothing, so an owner's
  quoted "ok" in chat cannot self-serve a raise.
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
