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
  passed to any other command is a usage error. The desktop's Confirm step sends
  back the `nodeId` it displayed; the service refuses with `PAIR_SERVICE_CHANGED`
  (the record changed), `PAIR_NOT_FOUND`, or `PAIR_CONFIRM_STALE` (no `nodeId`
  echoed back) rather than trust a stale or swapped record. Pending pairs expire.
  Also `desktop unpair <device-id>`, `desktop list`, and
  `import --from <desktop userData> [--dry-run]` (service stopped; secrets only
  arrive through the desktop's own Import, never the CLI).
- **Detach** is a two-step confirm in the settings pane: the warning must render
  before "Detach anyway" is armed, and the second click only confirms if at least
  400 ms have passed since the warning painted — a fast double-click re-arms
  instead of detaching.
- **Unpair** returns a follow-up command (e.g. to also stop standalone use of the
  same data); the pane keeps showing it, surviving repaints and relaunches, until
  the owner dismisses it or starts pairing again.
- `--kl-standalone-once` runs one standalone session without changing the
  persisted mode: it turns channels, gateway and mesh off from construction and
  pauses cron right after `core.start()`, so it can't act as a second consumer
  alongside an attached run; the `/llm` channel commands (Telegram/Slack/Discord)
  refuse while channels are off.
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
  are throttled, closed `4429` (owner ruling, 2026-09-25).
- **E2E:** `launchAttached()` in `tests/e2e/helpers.js` starts a temporary
  service (`tests/e2e/_attach-service.js`, stub provider), pairs, attaches and
  relaunches; `ctx.service` has `kill()`, `restart()`, `stop()`. Every launch
  (attached or not) gets a fresh temp `--user-data-dir`, asserted by the app
  itself; `KL_CASES_ROOT` and `KL_DESKTOP_BRIDGE_FILE` are pinned per launch so
  an agent shell's own env never leaks in, and the forked test service pins its
  own `KL_CASES_ROOT` under its data dir. The old `KL_TEST_BRIDGE_*` escape hatch
  is gone.
