# Fleet Stage 7: The desktop app as a window onto the local service — Implementation Plan (Part 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Electron side of attached mode: the desktop's bridge state and export, the Settings > Local service controller, the attached and standalone hosts behind a wiring-only `main.js`, the settings pane, the isolated Playwright `_electron` e2e harness with `launchAttached()`, and the CLAUDE.md section.
**Architecture:** Builds on Parts 1 and 2 (merged; their hand-off tables list every export used here). New files: `src/ipc/{desktop-state,desktop-export,desktop-controller,attached-host,standalone-host}.js`, `src/desktop-bridge/pane-model.js`, `tests/e2e/_attach-service.js`, `tests/e2e/attached-mode.test.js`. `main.js` is rewritten to pick a host before any core exists; `preload.js`, `renderer.js`, `index.html`, `styles.css` get one additive block each (renderer two, see below); `tests/e2e/helpers.js` is rewritten and `tests/e2e/_bridge.js` deleted.
**Tech Stack:** Electron (existing), `electron-store` (existing), `playwright` `_electron` (existing dependency, first use), `node:test`. No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md. **Parts 1–2:** docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part1.md, docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part2.md.

## Global Constraints

Program §3, verbatim:

- Open source: nothing specific to one person, machine, domain, path, app or
  provider account in code, defaults, fixtures or docs. Examples use `example.com`,
  `kl.example.com`, `gpu-box`, `web-01`, `Lakeside lot`, `+15550100`.
- `src/` outside `src/ipc/` and the Electron host is Electron-free
  (`tests/electron-boundary.test.js`). New code under `src/` runs under
  `king-louie-service`.
- **No new native npm dependencies.** Pure-JS or WASM only, and each new dependency is
  named in the child spec with the reason. (Stage 1 ruled out native deps for the
  secrets backends; the rule holds for every stage.) A test in each stage that adds a
  dependency asserts the lockfile has no install scripts or native binaries for it.
- Tests: `node --test`, never Jest. Pass = `# fail 0`. E2E needs
  `unset ELECTRON_RUN_AS_NODE`.
- Logging through `createLogger` (`src/logging.js`); no bare `console.*`. Third-party
  libraries with their own loggers (pino via imapflow) are constructed with
  `logger: false`.
- Tool results are `{ ok: true, … }` / `{ ok: false, error }`. ToolExecutor-level
  refusals are `{ success: false, error }`. Gate refusals are results, never throws.
- Security-relevant configuration is read only from the root/admin-owned config dir
  (`<configDir>/node.yaml`, `service.json`); the data dir is service-writable and
  never decides policy. `service.json` and `node.yaml` reject unknown keys with the key
  path named (R11, R55).
- Trust principle 3 (fleet §3.1): remote-origin unsafe actions run only with a fresh,
  single-use phone signature over the exact action. No setting, token or "remember
  this" stands in for it. The one exception is the computer-use lease (F5).
- Approval requesters return `true | false | 'timeout' | 'unavailable'`; only `=== true`
  approves. Truthy strings never do.
- Cases principle 5: nothing inferred leaves. Every outbound payload passes the
  outbound gate (§4.9). Cross-case reads never return the text of a non-disclosable fact.
- Case facts are append-only; `facts.jsonl` is written only by `FactLedger`. Only
  `user` provenance is host-verified; `external-agent` provenance is written only by
  the executor results path (R40); `sourced` is model-declared.
- Journal files are `YYYY-MM-DD-HHMM-<kind>.md` (`src/cases/records.js` `stamp()`).
- Commit trailer for every commit in this program: whatever the executing session's
  attribution reminder says. Never substitute another model's line.

Stage 7 spec constraints:

- No new npm dependency (spec §14). `ws` carries the bridge; Ed25519 and SHA-256 come from `node:crypto`.
- The bridge binds the literal `127.0.0.1` only, default port `18796` (`ports.desktopBridge` in `<configDir>/service.json`); `0` (ephemeral) is accepted for tests only. Upgrades carrying any `Origin` header get 403. HTTP header timeout 10000 ms.
- Pre-auth: each frame ≤ 4096 bytes (length checked before `JSON.parse`), first frame within 2000 ms, handshake within 10000 ms, at most 16 unauthenticated sockets (the oldest is closed with 1013 when a 17th arrives). 5 failed handshakes of one `deviceId` within 60 s refuse that device for 60 s; there is no global lockout.
- Close codes: 4400 malformed/oversized/silent, 4401 bad signature, 4403 unknown or unpaired device, 4409 another device attached (reason = its label), 4426 protocol mismatch (reason = `"1"`), 4429 locked out. Shutdown sends `{ "t":"bye", "code":"SERVICE_STOPPING" }` then closes 1001.
- `AUTH_S` = `kl.desktop.hello.v1\n<nodeId>\n<deviceId>\n<port>\n<serverNonce>\n<clientNonce>`; `AUTH_C` = `kl.desktop.auth.v1\n…` with the same fields. The server signs first.
- Post-auth: `ws` `maxPayload` 80 MiB; a client frame over 64 MiB is answered `{ t:'result', id, error:'Payload too large', code:'PAYLOAD_TOO_LARGE' }` and the socket stays open; an outgoing oversized `result` is replaced by that error, an oversized `event` is dropped with a `warn`.
- Client: reconnect backoff 1, 2, 4, 8, 16, 30 s (±20 % jitter); calls time out after 120 s with `BRIDGE_TIMEOUT`, except `chat:sendMessage`, `tool:execute`, `cron:run` and `case:ingest*`.
- Device ids: `kld-` + lowercase `base32(sha256(raw 32-byte Ed25519 key))[0..16]`. Pairing request: `klpair1.<deviceId>.<b64url raw key>.<b64url UTF-8 label ≤ 64 bytes, no control characters>`.
- `<configDir>/desktop-devices.json` is `{ v: 1, devices: [...] }`, checked with `assertAdminOwned` on every handshake; live connections are re-checked every 5000 ms.
- Import: a plan expires 30 minutes after `import.plan` or when its connection closes (`PLAN_EXPIRED`); an `import.apply` batch is ≤ 2 MiB serialized; imported cron jobs are added with `enabled: false`; secret values appear only inside `import.apply` batches and never in plans, reports, log lines or the manifest; nothing in the desktop profile is modified.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and where each is pinned:

1. **Two desktop users on one machine.** Part 1, Task 4, `tests/desktop-bridge-protocol.test.js`, "second device is refused while the first is live" (4409 with the first device's label).
2. **Service upgraded while the app is attached.** Part 3, Task 14, `tests/attached-host.test.js`, "reconnect with changed service info"; and Part 3, Task 17, the e2e restart case in `tests/e2e/attached-mode.test.js`.
3. **Standalone and attached both holding chats.** Part 2, Task 8, `tests/desktop-import.test.js`, "rerun after standalone use".
4. **Wizard on first attach.** Part 3, Task 14, `tests/attached-host.test.js`, "wizard is local" (pins `The service has no provider key yet — import or add one in Providers.`).
5. **Offline machine.** Part 1, Task 5, `tests/desktop-bridge-protocol.test.js`, "client ignores HTTP_PROXY".

## Interfaces from other stages

| Contract | Shape | What Part 1 does until it merges |
|---|---|---|
| Program §4.21 / F3 `src/core/origin.js` | `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn)`, `isLocalRequester(fn)` | F7 owns the file (Task 1). F3 creates the same five exports only if the file is absent. If F3 merged first, Task 1 replaces F3's copy with the same API (F7's `markLocalRequester` also takes an optional `{ deviceId }`). |
| Program §4.21 / F3 `approvalSeam` in `src/approvals/executor-options.js` | `approvalSeam({ remoteApprovals, event, approvalRequester, executorOptions, … }) → { toolExecutorOptions, attach, local, origin }` | If `grep -n approvalSeam src/core/create-core.js` finds it, F3's seam already carries the `local`/`denyAutoApproval` lines and Task 1 changes nothing in `create-core.js`. Otherwise Task 1 writes those lines (no phone branch). |
| Program §4.17 / F3 `src/approvals/envelope.js` | `deriveDeviceId(raw, prefix = 'd-')`, `ed25519RawToSpki(raw32) → Buffer` | `src/desktop-bridge/keys.js` uses F3's functions when that file exists, otherwise identical local copies (Task 2). Tests compare against an inline computation and, when present, F3's `tests/vectors/approval-v1/device-id-ed25519.json`. |
| F3 P9 `startApprovals(…)` | `{ phoneApprover, auditLedger, relayClient, approverStore, identity, courierPump, stop() }` | The bridge takes it as an optional `approvals` option; `bridge.approvalsStatus` returns `{ available: false }` when it is `null` (Task 7). Tests pass a stub with `approverStore.list/isActive`, `phoneApprover.pending`, `auditLedger.tail`. |
| F3 audit origin `{ client: 'desktop', deviceId }` | written by F3's seam from `localDesktopDeviceId(event)` | Task 7 marks every dispatcher event with the connection's `deviceId`; before F3, desktop runs are logged through `createLogger('desktop-bridge')` only. |
| C2 R50 `host.interactive` | `() => boolean` | Task 11 passes `host: { interactive: () => bridge connected }` to `createCore`; `createCore` ignores it until C2 reads it. |
| C2/C4/C7 new domains | one line appended to `PROXIED_DOMAINS` | Task 3 creates the array; `case:*` is already proxied by domain. |

## Deviations and resolved gaps (read before starting)

- `src/desktop-bridge/connection.js` (connection state shared by server and dispatcher) and `src/desktop-bridge/{keys,desktop-scope,check-path,service-wiring}.js` are new files the spec does not name; they hold code the spec assigns to the server and dispatcher.
- The dispatcher also wraps `addPermissionRule` so rules added over the bridge are recorded in `<dataDir>/desktop/rules.json` (the spec requires the record; it names only the remove wrapper).
- `canvas:executeJs` request ids are bound to the connection that received them, like prompt ids, so `bridge.canvasJsResult` cannot resolve another connection's request.
- A pre-auth socket evicted when a 17th arrives is closed with 1013 (the spec leaves the code open).
- `ports.desktopBridge: 0` (ephemeral) is accepted so the e2e service can bind any port; every other port still needs 1–65535.
- On Windows the bridge-file trust check, like the POSIX one, also accepts the current user as owner **only** with `KL_TEST_MODE=1` and `KL_DESKTOP_BRIDGE_FILE` set, so the e2e suite runs unelevated.
- `host.presence` is not passed: C4 proxies `presence:heartbeat` to the service's own handler by adding `presence` to `PROXIED_DOMAINS`.
- The import inventory carries two extra fields: `secrets` (`'included' | 'needs-desktop' | 'unavailable'`) and `customCasesRoot`. A case directory that already exists on the service with no manifest entry is `needs-attention` (the plan has no content hashes to compare). Case files larger than 1 MiB travel in chunks with an `offset`.
- The CLI `import` does not start a core (starting one as root would launch MCP servers and hooks); it writes memory, cron and the user profile through their stores (`buildImportTargets({ offline: true })`).
- `src/service/cli.js` gets two hunks (`'from'` in `VALUE_FLAGS`, and the two dispatch cases); `src/service/config.js` gets four small hunks; `tests/service-config.test.js` gets its default expectations updated.
- The spec's `tests/desktop-import.test.js` coverage is split: engine in `tests/desktop-import.test.js` (Task 8), source walker and CLI import in `tests/desktop-import-source.test.js` (Task 9); pairing CLI in `tests/desktop-cli.test.js` (Task 10); client tests live in `tests/desktop-bridge-protocol.test.js` (Task 5).


### Part 3 deviations and resolved gaps

- A `desktop:retry` channel (and preload `desktop.retry`) backs the pane's **Retry now** button, which the spec's channel list omits. Preload also exposes `desktop.describe(status)` and `desktop.describeImport(report)` from the pure `src/desktop-bridge/pane-model.js`, so the pane's wording is unit-tested in node.
- `pairConfirm` stores the service's `ready.service` summary (`version`, `account`, `profile`) in `pairing.service.info`, so the paired-standalone view can show version and account without a live connection.
- The import session keeps its client open between **Import…** (plan) and **Import** (apply), because a plan expires when its connection closes.
- The attached host re-reads `bridge.status` before refusing `chat:sendMessage` with the no-provider message, so a key added in Providers (proxied) or by an import clears it without a reconnect.
- `CronScheduler` gains `pause()` (a flag checked by `tick()`); `--kl-standalone-once` pauses cron right after `core.start()`. A job already due at launch can still start in the scheduler's first 100 ms tick; the channels, gateway and mesh are off from construction.
- `main.js` also applies `--user-data-dir=<dir>` with `app.setPath('userData', …)` before anything reads it, so the harness's isolation check does not depend on Chromium's switch handling.
- The e2e stub provider is registered under the name `openai`, because the chat send path only accepts `openai`, `anthropic` or `gemini` provider types; it exists only in the test service process.
- `renderer.js` gets two hunks: a three-line hook in `switchSettingsTab` and one block at the end of the file.

---

### Task 12: Desktop bridge state and the desktop-side export

**Files:**
- Create: `src/ipc/desktop-state.js`, `src/ipc/desktop-export.js`
- Test: `tests/desktop-export.test.js`

**Interfaces:**
- Consumes: `createSafeReader`, `readDesktopSource`, `planBatches` (Part 2, Task 9); `createSafeStorageCipher` (`src/platform/cipher.js`); `MESSAGES` (Part 1); in tests `DesktopImporter`, `buildImportTargets` (Part 2, Task 8), `createDesktopScope`, `checkPath` (Part 1).
- Produces:
  - `secureStorageUsable(safeStorage, platform) → boolean` (false when unavailable or, on Linux, `getSelectedStorageBackend() === 'basic_text'`).
  - `openDesktopState(userDataDir, safeStorage, { storeFactory, platform }) → state` with `mode` (`'standalone' | 'attached'`), `setMode(m)`, `installId`, `pairing`, `setPairing(p)`, `clearPairing()`, `pendingPair`, `setPendingPair(p)`, `lastImport`, `setLastImport(x)`, `secureStorageUsable()`, `seal(text) → b64`, `unseal(b64) → text` (both throw `code: 'SECURE_STORAGE_UNAVAILABLE'`). Store: electron-store `desktop-bridge` in `<userData>` (spec §4.4).
  - `loadDesktopSource({ userDataDir, safeStorage, platform }) → source` (secrets `'included'` or `'unavailable'`), `planImport({ client, source }) → plan`, `applyImport({ client, plan, source, onProgress }) → report & { skipped, sendFailures }`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-export.test.js`:

```js
// tests/desktop-export.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState, secureStorageUsable } = require('../src/ipc/desktop-state');
const { loadDesktopSource, planImport, applyImport } = require('../src/ipc/desktop-export');
const { createCore } = require('../src/core');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { DesktopImporter, buildImportTargets } = require('../src/migration/desktop-import');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');

const dirs = [];
const cores = [];
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'kl-export-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// Reversible stand-in for Electron's safeStorage.
const fakeSafeStorage = (available = true, backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
});
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
const sealed = (plain) => Buffer.from(`sealed:${plain}`).toString('base64');

describe('desktop bridge state', () => {
  it('defaults to standalone with a persistent installId', () => {
    const dir = tmp();
    const state = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    assert.strictEqual(state.mode, 'standalone');
    assert.match(state.installId, /^[0-9a-f-]{36}$/);
    const again = openDesktopState(dir, fakeSafeStorage(), { storeFactory });
    assert.strictEqual(again.installId, state.installId);
    state.setMode('attached');
    assert.strictEqual(openDesktopState(dir, fakeSafeStorage(), { storeFactory }).mode, 'attached');
    assert.throws(() => state.setMode('sideways'), /unknown mode/);
    assert.ok(fs.existsSync(path.join(dir, 'desktop-bridge.json')));
  });

  it('seals with safeStorage and refuses without it (or with basic_text on Linux)', () => {
    const state = openDesktopState(tmp(), fakeSafeStorage(), { storeFactory, platform: 'linux' });
    const box = state.seal('-----BEGIN PRIVATE KEY-----');
    assert.strictEqual(state.unseal(box), '-----BEGIN PRIVATE KEY-----');
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(true, 'basic_text'), 'linux'), false);
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(true, 'basic_text'), 'win32'), true);
    assert.strictEqual(secureStorageUsable(fakeSafeStorage(false), 'darwin'), false);
    const bare = openDesktopState(tmp(), fakeSafeStorage(false), { storeFactory });
    assert.throws(() => bare.seal('x'), (err) => err.code === 'SECURE_STORAGE_UNAVAILABLE');
  });
});

describe('desktop export over a bridge client', () => {
  function desktopProfile() {
    const root = tmp('kl-export-profile-');
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({
      chats: [{ id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [] }],
      settings: { inference: { activeTier: 'fast' } },
      apiTokens: { anthropic: sealed('sk-example-anthropic') }
    }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ __vault_github: sealed('ghp_example_token') }));
    fs.writeFileSync(path.join(root, 'desktop-bridge.json'), JSON.stringify({ mode: 'standalone', installId: '11111111-2222-4333-8444-555555555555' }));
    return root;
  }

  async function serviceClient() {
    const dataDir = tmp('kl-export-svc-');
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    });
    cores.push(core);
    await core.start();
    const importer = new DesktopImporter({
      context: core.context, targets: await buildImportTargets({ context: core.context, dataDir }), dataDir, checkPath,
      scope: createDesktopScope({ dataDir, context: core.context })
    });
    const calls = [];
    const client = {
      call: async (method, params) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        return importer[method.split('.')[1]](params);
      }
    };
    return { core, client, calls };
  }

  it('plans with ids only, then sends decrypted secrets in apply batches', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(), platform: 'win32' });
    assert.strictEqual(source.installId, '11111111-2222-4333-8444-555555555555');
    const { core, client, calls } = await serviceClient();
    const plan = await planImport({ client, source });
    assert.strictEqual(calls[0].method, 'import.plan');
    assert.ok(!JSON.stringify(calls[0].params).includes('ghp_example_token'));
    const progress = [];
    const report = await applyImport({ client, plan, source, onProgress: (p) => progress.push(p) });
    assert.deepStrictEqual(report.failures, []);
    assert.deepStrictEqual(calls.map((c) => c.method).slice(-1), ['import.finish']);
    assert.ok(calls.some((c) => c.method === 'import.apply' && JSON.stringify(c.params).includes('ghp_example_token')));
    assert.strictEqual(core.context.vault.get('github'), 'ghp_example_token');
    assert.strictEqual(core.context.decryptToken(core.context.getApiTokens().anthropic), 'sk-example-anthropic');
    assert.ok(progress.length >= 1);
    const last = progress[progress.length - 1];
    assert.strictEqual(last.sent, last.total);
  });

  it('marks secrets needs-attention when this desktop has no secure storage', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(false), platform: 'win32' });
    assert.strictEqual(source.inventory.secrets, 'unavailable');
    const { client } = await serviceClient();
    const plan = await planImport({ client, source });
    const vault = plan.items.find((i) => i.category === 'vault');
    assert.strictEqual(vault.action, 'needs-attention');
    assert.strictEqual(vault.note, "This system has no secure storage; the desktop can't hold a pairing key.");
  });

  it('reports a batch the service refused as per-item failures', async () => {
    const root = desktopProfile();
    const source = loadDesktopSource({ userDataDir: root, safeStorage: fakeSafeStorage(), platform: 'win32' });
    const client = {
      call: async (method) => {
        if (method === 'import.plan') return { planId: 'p1', items: [{ category: 'chat', key: 'c1', action: 'new' }], counts: { new: 1 } };
        if (method === 'import.apply') throw Object.assign(new Error('The import plan expired; plan the import again.'), { code: 'PLAN_EXPIRED' });
        return { planId: 'p1', counts: { new: 1, failed: 1 }, failures: [{ category: 'chat', key: 'c1', error: 'not sent by the desktop' }], attention: [], secretsMissing: [], cronDisabled: 0, notes: [] };
      }
    };
    const plan = await planImport({ client, source });
    const report = await applyImport({ client, plan, source });
    assert.deepStrictEqual(report.sendFailures, [{ category: 'chat', key: 'c1', ok: false, error: 'The import plan expired; plan the import again.' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-export.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/desktop-state'`.

- [ ] **Step 3: Implement**

Create `src/ipc/desktop-state.js`:

```js
// The desktop's own record of attached mode (fleet stage 7 §4.4): electron-store
// `desktop-bridge` in <userData>. Read before any core exists, because it
// decides whether one is built at all. Never read by the service.
const crypto = require('crypto');
const { MESSAGES } = require('../desktop-bridge/protocol');

const MODES = Object.freeze(['standalone', 'attached']);

function secureStorageUsable(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

function defaultStoreFactory() {
  const { default: Store } = require('electron-store');
  return (options) => new Store(options);
}

function unavailable() {
  const err = new Error(MESSAGES.SECURE_STORAGE_UNAVAILABLE);
  err.code = 'SECURE_STORAGE_UNAVAILABLE';
  return err;
}

function openDesktopState(userDataDir, safeStorage, { storeFactory = null, platform = process.platform } = {}) {
  const make = storeFactory || defaultStoreFactory();
  const store = make({
    name: 'desktop-bridge',
    cwd: userDataDir,
    defaults: { mode: 'standalone', installId: null, pairing: null, pendingPair: null, lastImport: null }
  });
  if (!store.get('installId')) store.set('installId', crypto.randomUUID());
  const usable = () => secureStorageUsable(safeStorage, platform);
  return {
    get mode() {
      const mode = store.get('mode');
      return MODES.includes(mode) ? mode : 'standalone';
    },
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
      store.set('mode', mode);
    },
    get installId() { return store.get('installId'); },
    get pairing() { return store.get('pairing') || null; },
    setPairing(pairing) { store.set('pairing', pairing); },
    clearPairing() { store.set('pairing', null); },
    get pendingPair() { return store.get('pendingPair') || null; },
    setPendingPair(pending) { store.set('pendingPair', pending); },
    get lastImport() { return store.get('lastImport') || null; },
    setLastImport(entry) { store.set('lastImport', entry); },
    secureStorageUsable: usable,
    seal(text) {
      if (!usable()) throw unavailable();
      return safeStorage.encryptString(String(text)).toString('base64');
    },
    unseal(sealedText) {
      if (!usable()) throw unavailable();
      return safeStorage.decryptString(Buffer.from(sealedText, 'base64'));
    }
  };
}

module.exports = { openDesktopState, secureStorageUsable, MODES };
```

Create `src/ipc/desktop-export.js`:

```js
// The desktop half of import (fleet stage 7 §3.8): read this profile's own
// stores as plain JSON through the safe reader (never electron-store, which
// would write defaults), decrypt secrets in memory with safeStorage, and send
// them only inside import.apply batches over the authenticated bridge.
const { createSafeReader, readDesktopSource, planBatches } = require('../migration/desktop-source');
const { createSafeStorageCipher } = require('../platform/cipher');
const { secureStorageUsable } = require('./desktop-state');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);

function loadDesktopSource({ userDataDir, safeStorage, platform = process.platform }) {
  const usable = secureStorageUsable(safeStorage, platform);
  const cipher = usable ? createSafeStorageCipher(safeStorage) : null;
  return readDesktopSource({
    userDataDir,
    reader: createSafeReader({ root: userDataDir, platform }),
    decrypt: cipher ? (encrypted) => cipher.decryptString(encrypted) : null,
    secrets: usable ? 'included' : 'unavailable'
  });
}

async function planImport({ client, source }) {
  return client.call('import.plan', { installId: source.installId, inventory: source.inventory });
}

async function applyImport({ client, plan, source, onProgress = () => {} }) {
  const skipped = [];
  const sendFailures = [];
  const total = plan.items.filter((i) => WRITE_ACTIONS.has(i.action)).length;
  const done = new Set();
  for (const batch of planBatches(plan.items, source, { skipped })) {
    let results;
    try {
      ({ results } = await client.call('import.apply', { planId: plan.planId, batch }));
    } catch (err) {
      results = batch.map((e) => ({ category: e.category, key: e.key, ok: false, error: err.message }));
    }
    for (const r of results) {
      if (!r.ok) sendFailures.push(r);
      done.add(`${r.category}:${r.key}`);
    }
    onProgress({ sent: Math.min(done.size, total), total });
  }
  onProgress({ sent: total, total });
  const report = await client.call('import.finish', { planId: plan.planId });
  return { ...report, skipped, sendFailures };
}

module.exports = { loadDesktopSource, planImport, applyImport };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-export.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/desktop-state.js src/ipc/desktop-export.js tests/desktop-export.test.js
git commit -m "feat(ipc): desktop bridge state and desktop-side import export

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The desktop controller (Settings > Local service actions)

**Files:**
- Create: `src/ipc/desktop-controller.js`
- Test: `tests/desktop-controller.test.js`

**Interfaces:**
- Consumes: Task 12 (`state`, `loadDesktopSource`, `planImport`, `applyImport`); Part 1 (`DesktopBridgeClient`, `encodePairRequest`, `defaultDeviceLabel`, `bridgeFilePath`, `readTrustedBridgeFile`, `rawFromPublicKeyObject`, `fingerprintGroups`, `MESSAGES`, `ATTACHED_UNAVAILABLE_TABS`); `registerDesktopHandlers` (Part 1) in the test.
- Produces: `createDesktopController({ state, mode, app, getWindow, env, platform, userDataDir, safeStorage, stdout, argv, readBridgeFile, clientFactory, pollMs = 3000, pollWindowMs = 600000, now, username }) → controller` with `status()`, `pairStart()`, `pairConfirm()`, `pairCancel()`, `attach()`, `detach({ confirmed })`, `standaloneOnce()`, `unpair()`, `retry()`, `importPlan()`, `importApply()`, `createClient() → DesktopBridgeClient | null`, `setClient(client)`, `dispose()`, `on(event, fn)`; `DETACH_WARNING`. `status()` returns `{ ok: true, mode, view: 'unpaired' | 'pairing' | 'paired' | 'attached-connected' | 'attached-disconnected', standaloneOnce, bridgeFile, bridge, pairing, pendingPair, service, connection, approvals, lastImport, unavailableTabs, detachWarning }`. Events to the window: `desktop:statusChanged`, `desktop:importProgress`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-controller.test.js`:

```js
// tests/desktop-controller.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const pairing = require('../src/desktop-bridge/pairing');
const keys = require('../src/desktop-bridge/keys');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { createDesktopController, DETACH_WARNING } = require('../src/ipc/desktop-controller');
const { registerDesktopHandlers } = require('../src/ipc/desktop-handlers');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ctl-')); dirs.push(d); return d; };
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
});
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });
const identity = new NodeIdentity({ nodeName: 'gpu-box' });

function fakeApp() {
  const calls = [];
  return { calls, relaunch: (o) => calls.push(['relaunch', o]), exit: (c) => calls.push(['exit', c]), quit: () => calls.push(['quit']), getPath: () => tmp() };
}

async function startService() {
  const configDir = tmp();
  const dispatcher = {
    served: { handle: ['chat:load'], on: [] },
    providersConfigured: () => true,
    async handleFrame(conn, frame) {
      if (frame.t === 'call' && frame.method === 'bridge.approvalsStatus') conn.send({ t: 'result', id: frame.id, value: { available: false } });
    },
    onDisconnect() {},
    forwardAmbient() {}
  };
  const server = new DesktopBridgeServer({ identity, configDir, port: 0, version: '26.9.0', adminUid: selfUid, account: 'LOCAL SERVICE', createDispatcher: () => dispatcher });
  servers.push(server);
  const { port } = await server.start();
  return { server, port, configDir };
}

function controllerFor({ mode = 'standalone', safeStorage = fakeSafeStorage(), readBridgeFile, env = {} } = {}) {
  const userDataDir = tmp();
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
  const app = fakeApp();
  const sentToWindow = [];
  const out = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, p) => sentToWindow.push([ch, p]) } };
  const controller = createDesktopController({
    state, mode, app, getWindow: () => window, env, platform: 'linux', userDataDir, safeStorage,
    stdout: { write: (s) => out.push(s) }, argv: ['electron', '.'], readBridgeFile, pollMs: 20, username: 'alex'
  });
  return { controller, state, app, sentToWindow, out };
}

describe('desktop controller', () => {
  it('starts unpaired and reports a missing bridge file', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' }) });
    const status = await controller.status();
    assert.strictEqual(status.view, 'unpaired');
    assert.strictEqual(status.mode, 'standalone');
    assert.deepStrictEqual(status.bridge, { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' });
    assert.deepStrictEqual(status.unavailableTabs, []);
  });

  it('refuses to pair without secure storage', async () => {
    const { controller } = controllerFor({ safeStorage: fakeSafeStorage(false), readBridgeFile: () => ({ ok: false }) });
    assert.deepStrictEqual(await controller.pairStart(), {
      ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: "This system has no secure storage; the desktop can't hold a pairing key."
    });
  });

  it('pairs: request and command, finds the service, confirms with a real handshake', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller, state, sentToWindow } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    const started = await controller.pairStart();
    assert.strictEqual(started.view, 'pairing');
    const request = started.pendingPair.request;
    const decoded = pairing.decodePairRequest(request);
    assert.strictEqual(decoded.label, "alex's desktop");
    assert.strictEqual(started.pendingPair.command, `sudo king-louie-service desktop pair ${request}`);
    assert.strictEqual(started.pendingPair.deviceFingerprint, keys.fingerprintGroups(decoded.deviceId));
    assert.ok(!JSON.stringify(started).includes('PRIVATE KEY'), 'the private key never reaches the renderer');
    await new Promise((r) => setTimeout(r, 60));
    const polled = await controller.status();
    assert.strictEqual(polled.pendingPair.service.fingerprint, keys.fingerprintGroups(identity.nodeId));
    assert.ok(sentToWindow.some(([ch]) => ch === 'desktop:statusChanged'));
    // The administrator ran `desktop pair`: the device is in the devices file.
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), {
      deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: decoded.label, pairedAt: '2026-09-23T14:02:11Z'
    })), 0o644);
    const confirmed = await controller.pairConfirm();
    assert.strictEqual(confirmed.view, 'paired', JSON.stringify(confirmed));
    assert.strictEqual(state.pairing.service.nodeId, identity.nodeId);
    assert.strictEqual(state.pairing.service.info.account, 'LOCAL SERVICE');
    assert.strictEqual(state.pendingPair, null);
    controller.dispose();
  });

  it('reports a service that does not know the device', async () => {
    const svc = await startService();
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: true, record: pairing.parseBridgeFile(JSON.stringify(record)) }) });
    await controller.pairStart();
    const out = await controller.pairConfirm();
    assert.deepStrictEqual(out, { ok: false, code: 'DEVICE_UNPAIRED', error: 'The service does not know this desktop. Pair again in Settings > Local service.' });
    controller.dispose();
  });

  it('attach, detach and standalone-once relaunch; in test mode they print KL_RELAUNCH_REQUESTED', async () => {
    const { controller, state, app, out } = controllerFor({ env: { KL_TEST_MODE: '1' }, readBridgeFile: () => ({ ok: false }) });
    assert.strictEqual((await controller.attach()).code, 'NOT_PAIRED');
    state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), port: 18796, pairedAt: '2026-09-23T14:02:11Z' } });
    assert.deepStrictEqual(await controller.attach(), { ok: true, relaunching: true });
    assert.strictEqual(state.mode, 'attached');
    assert.deepStrictEqual(out, ['KL_RELAUNCH_REQUESTED\n']);
    assert.deepStrictEqual(app.calls, [['quit']]);
    assert.deepStrictEqual(await controller.detach({}), { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING });
    assert.strictEqual(state.mode, 'attached');
    await controller.detach({ confirmed: true });
    assert.strictEqual(state.mode, 'standalone');
  });

  it('relaunches with --kl-standalone-once outside test mode', async () => {
    const { controller, state, app } = controllerFor({ readBridgeFile: () => ({ ok: false }) });
    state.setMode('attached');
    await controller.standaloneOnce();
    assert.deepStrictEqual(app.calls, [['relaunch', { args: ['.', '--kl-standalone-once'] }], ['exit', 0]]);
    assert.strictEqual(state.mode, 'attached', 'the mode is not changed');
  });

  it('shows unavailable tabs and approvals when attached and connected', async () => {
    const svc = await startService();
    const { controller, state } = controllerFor({ mode: 'attached', readBridgeFile: () => ({ ok: false }) });
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: svc.port });
    await controller.status();
    // A paired device (as after pairConfirm), then the attached host's client.
    const { privateKey, publicKey } = require('crypto').generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    const deviceId = keys.deriveDeviceId(raw, 'kld-');
    state.setPairing({ deviceId, publicKey: keys.toB64url(raw), privateKeySealed: state.seal(privateKey.export({ type: 'pkcs8', format: 'pem' })), label: 'desk', service: { nodeId: record.nodeId, publicKey: record.publicKey, port: svc.port, pairedAt: '2026-09-23T14:02:11Z' } });
    pairing.writeFileAtomic(path.join(svc.configDir, pairing.DEVICES_FILE), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'desk', pairedAt: '2026-09-23T14:02:11Z' })), 0o644);
    const client = controller.createClient();
    controller.setClient(client);
    await client.connect();
    const status = await controller.status();
    assert.strictEqual(status.view, 'attached-connected');
    assert.deepStrictEqual(status.approvals, { available: false });
    assert.ok(status.unavailableTabs.includes('hooks'));
    assert.strictEqual(status.service.account, 'LOCAL SERVICE');
    client.close();
    controller.dispose();
  });

  it('is what desktop:* calls through registerDesktopHandlers', async () => {
    const { controller } = controllerFor({ readBridgeFile: () => ({ ok: false, code: 'BRIDGE_FILE_MISSING', error: 'x' }) });
    const handlers = new Map();
    registerDesktopHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, { desktopBridge: controller });
    const out = await handlers.get('desktop:status')({});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.view, 'unpaired');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-controller.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/desktop-controller'`.

- [ ] **Step 3: Implement**

Create `src/ipc/desktop-controller.js`:

```js
// Settings > Local service (fleet stage 7 §3.2, §3.7, §3.9): pairing, attach,
// detach, unpair, import. Mode switches persist and relaunch; handlers are
// never swapped under a live core. The private key is sealed with safeStorage
// and unsealed only for the moment of a signature.
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');
const { DesktopBridgeClient } = require('../desktop-bridge/bridge-client');
const { encodePairRequest, defaultDeviceLabel, bridgeFilePath, readTrustedBridgeFile } = require('../desktop-bridge/pairing');
const { rawFromPublicKeyObject, fingerprintGroups } = require('../desktop-bridge/keys');
const { MESSAGES } = require('../desktop-bridge/protocol');
const { ATTACHED_UNAVAILABLE_TABS } = require('../desktop-bridge/allowlist');
const { loadDesktopSource, planImport, applyImport } = require('./desktop-export');

const log = createLogger('desktop-controller');

const DETACH_WARNING = 'After detaching, this app runs its own King Louie again next to the service; its cron jobs and channels may act twice. Stop the service if you no longer want it.';
const STANDALONE_ONCE = '--kl-standalone-once';

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'owner';
  }
}

function createDesktopController({
  state, mode, app, getWindow = () => null, env = process.env, platform = process.platform,
  userDataDir, safeStorage, stdout = process.stdout, argv = process.argv,
  readBridgeFile = null, clientFactory = null, pollMs = 3000, pollWindowMs = 10 * 60 * 1000,
  now = () => new Date(), username = null
}) {
  const emitter = new EventEmitter();
  const bridgeFile = () => bridgeFilePath({ env, platform });
  const readFile = readBridgeFile || (() => readTrustedBridgeFile(bridgeFile(), { env, platform }));
  const makeClient = clientFactory || ((options) => new DesktopBridgeClient(options));
  let client = null;
  let connection = { status: mode === 'attached' ? 'connecting' : 'idle', code: null, error: null, nextRetryAt: null };
  let pollTimer = null;
  let found = null;
  let foundError = null;
  let importSession = null;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !(typeof win.isDestroyed === 'function' && win.isDestroyed())) win.webContents.send(channel, payload);
  };
  const notify = () => {
    send('desktop:statusChanged', {});
    emitter.emit('changed');
  };

  const signerFor = (pairing) => (bytes) => {
    const pem = state.unseal(pairing.privateKeySealed);
    return crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(pem));
  };
  const clientOptionsFor = (pairing, service) => ({
    port: service.port,
    getPort: async () => {
      const r = readFile();
      return r && r.ok ? r.record.port : service.port;
    },
    pin: { nodeId: service.nodeId, publicKey: service.publicKey },
    deviceId: pairing.deviceId,
    sign: signerFor(pairing)
  });

  function relaunch(extraArgs = []) {
    if (env.KL_TEST_MODE === '1') {
      stdout.write('KL_RELAUNCH_REQUESTED\n');
      app.quit();
      return { ok: true, relaunching: true };
    }
    const args = argv.slice(1).filter((a) => a !== STANDALONE_ONCE).concat(extraArgs);
    app.relaunch({ args });
    app.exit(0);
    return { ok: true, relaunching: true };
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    const until = Date.now() + pollWindowMs;
    const tick = () => {
      const r = readFile();
      if (r && r.ok) { found = r.record; foundError = null; } else { found = null; foundError = r ? { code: r.code || null, error: r.error || null } : null; }
      notify();
      if (state.pendingPair && Date.now() < until) {
        pollTimer = setTimeout(tick, pollMs);
        pollTimer.unref?.();
      } else {
        pollTimer = null;
      }
    };
    tick();
  }

  const pairCommand = (request) => (platform === 'win32'
    ? `king-louie-service desktop pair ${request}`
    : `sudo king-louie-service desktop pair ${request}`);

  function view() {
    const pairing = state.pairing;
    if (state.pendingPair) return 'pairing';
    if (!pairing || !pairing.service) return 'unpaired';
    if (mode === 'attached') return connection.status === 'connected' ? 'attached-connected' : 'attached-disconnected';
    return 'paired';
  }

  async function status() {
    const current = view();
    const pairing = state.pairing;
    const pending = state.pendingPair;
    let approvals = null;
    if (current === 'attached-connected' && client) {
      try {
        approvals = await client.call('bridge.approvalsStatus', {}, { timeoutMs: 5000 });
      } catch {
        approvals = { available: false };
      }
    }
    let bridge = null;
    if (current === 'unpaired') {
      const r = readFile() || {};
      bridge = r.ok ? { ok: true } : { ok: false, code: r.code || null, error: r.error || null };
    }
    const liveService = client && client.service ? client.service : null;
    return {
      ok: true,
      mode,
      view: current,
      standaloneOnce: argv.includes(STANDALONE_ONCE),
      bridgeFile: bridgeFile(),
      bridge,
      pairing: pairing ? {
        deviceId: pairing.deviceId,
        fingerprint: fingerprintGroups(pairing.deviceId),
        label: pairing.label,
        service: pairing.service ? { ...pairing.service, fingerprint: fingerprintGroups(pairing.service.nodeId) } : null
      } : null,
      pendingPair: pending ? {
        request: pending.request,
        command: pairCommand(pending.request),
        deviceFingerprint: fingerprintGroups(pending.deviceId),
        service: found ? { nodeId: found.nodeId, fingerprint: fingerprintGroups(found.nodeId), port: found.port } : null,
        error: foundError
      } : null,
      service: liveService || (pairing && pairing.service && pairing.service.info) || null,
      connection: { ...connection },
      approvals,
      lastImport: state.lastImport,
      unavailableTabs: mode === 'attached' ? [...ATTACHED_UNAVAILABLE_TABS] : [],
      detachWarning: DETACH_WARNING
    };
  }

  async function pairStart() {
    if (!state.secureStorageUsable()) return { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: MESSAGES.SECURE_STORAGE_UNAVAILABLE };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = rawFromPublicKeyObject(publicKey);
    const label = defaultDeviceLabel(username || currentUsername());
    const request = encodePairRequest({ publicKeyRaw: raw, label });
    state.setPendingPair({
      deviceId: request.split('.')[1],
      publicKey: raw.toString('base64url'),
      privateKeySealed: state.seal(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      label,
      request,
      startedAt: now().toISOString()
    });
    found = null;
    foundError = null;
    startPolling();
    return status();
  }

  async function pairConfirm() {
    const pending = state.pendingPair;
    if (!pending) return { ok: false, code: 'NOT_PAIRING', error: 'Start pairing first.' };
    const r = readFile() || {};
    if (!r.ok) return { ok: false, code: r.code || 'BRIDGE_FILE_MISSING', error: r.error || 'No local service found.' };
    const service = { nodeId: r.record.nodeId, publicKey: r.record.publicKey, port: r.record.port };
    const probe = makeClient(clientOptionsFor(pending, service));
    let info;
    try {
      info = await probe.connect();
    } catch (err) {
      probe.close();
      return { ok: false, code: err.code || 'SERVICE_UNREACHABLE', error: err.message };
    }
    probe.close();
    state.setPairing({
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      privateKeySealed: pending.privateKeySealed,
      label: pending.label,
      service: { ...service, pairedAt: now().toISOString(), info: { version: info.version, account: info.account, profile: info.profile, providersConfigured: info.providersConfigured } }
    });
    state.setPendingPair(null);
    stopPolling();
    log.info(`paired with the local service ${service.nodeId}`);
    notify();
    return status();
  }

  async function pairCancel() {
    state.setPendingPair(null);
    stopPolling();
    notify();
    return status();
  }

  async function attach() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) return { ok: false, code: 'NOT_PAIRED', error: 'Pair with the local service first.' };
    state.setMode('attached');
    return relaunch();
  }

  async function detach({ confirmed = false } = {}) {
    if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', error: DETACH_WARNING };
    state.setMode('standalone');
    return relaunch();
  }

  async function standaloneOnce() {
    return relaunch([STANDALONE_ONCE]);
  }

  async function unpair() {
    const pairing = state.pairing;
    const wasAttached = state.mode === 'attached';
    state.clearPairing();
    state.setPendingPair(null);
    state.setMode('standalone');
    stopPolling();
    const command = pairing ? `${platform === 'win32' ? '' : 'sudo '}king-louie-service desktop unpair ${pairing.deviceId}` : null;
    if (wasAttached && mode === 'attached') return { ...relaunch(), command };
    notify();
    return { ok: true, command };
  }

  async function retry() {
    if (client) client.retryNow().catch(() => {});
    return { ok: true };
  }

  function closeImportSession() {
    if (importSession && importSession.temporary) importSession.client.close();
    importSession = null;
  }

  async function importClient() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) throw Object.assign(new Error('Pair with the local service first.'), { code: 'NOT_PAIRED' });
    if (client && client.connected) return { client, temporary: false };
    if (mode === 'attached') throw Object.assign(new Error(MESSAGES.SERVICE_UNREACHABLE(pairing.service.port)), { code: 'SERVICE_UNREACHABLE' });
    const temp = makeClient(clientOptionsFor(pairing, pairing.service));
    try {
      await temp.connect();
    } catch (err) {
      temp.close();
      throw err;
    }
    return { client: temp, temporary: true };
  }

  async function importPlan() {
    try {
      closeImportSession();
      const session = await importClient();
      const source = loadDesktopSource({ userDataDir, safeStorage, platform });
      const plan = await planImport({ client: session.client, source });
      importSession = { ...session, plan, source };
      return { ok: true, plan, attention: source.attention };
    } catch (err) {
      closeImportSession();
      return { ok: false, code: err.code || 'IMPORT_FAILED', error: err.message };
    }
  }

  async function importApply() {
    if (!importSession) return { ok: false, code: 'PLAN_EXPIRED', error: 'The import plan expired; plan the import again.' };
    try {
      const report = await applyImport({
        client: importSession.client,
        plan: importSession.plan,
        source: importSession.source,
        onProgress: (p) => send('desktop:importProgress', p)
      });
      state.setLastImport({ at: now().toISOString(), counts: report.counts });
      if (client && client.connected) {
        try { client.service = await client.call('bridge.status'); } catch { /* keep the old summary */ }
      }
      return { ok: true, report };
    } catch (err) {
      return { ok: false, code: err.code || 'IMPORT_FAILED', error: err.message };
    } finally {
      closeImportSession();
      notify();
    }
  }

  function createClient() {
    const pairing = state.pairing;
    if (!pairing || !pairing.service) return null;
    return makeClient(clientOptionsFor(pairing, pairing.service));
  }

  function setClient(next) {
    client = next;
    if (!client) return;
    client.on('state', (s) => {
      connection = { status: s.status, code: s.code, error: s.error, nextRetryAt: s.nextRetryAt };
      notify();
    });
  }

  function dispose() {
    stopPolling();
    closeImportSession();
  }

  return {
    status, pairStart, pairConfirm, pairCancel, attach, detach, standaloneOnce, unpair, retry,
    importPlan, importApply, createClient, setClient, dispose,
    on: (event, fn) => emitter.on(event, fn)
  };
}

module.exports = { createDesktopController, DETACH_WARNING, STANDALONE_ONCE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-controller.test.js tests/desktop-bridge-allowlist.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/desktop-controller.js tests/desktop-controller.test.js
git commit -m "feat(ipc): desktop controller for pairing, attach, detach and import

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: The attached host

**Files:**
- Create: `src/ipc/attached-host.js`
- Test: `tests/attached-host.test.js`

**Interfaces:**
- Consumes: `listIpcChannels`, `classifyChannel`, `isRendererEvent`, `createDesktopHandler`, `MESSAGES` (Part 1); `createDesktopController` (Task 13); `getWizardSteps` (`src/wizard/onboarding-wizard.js`).
- Produces: `startAttachedHost({ app, ipcMain, safeStorage, dialog, getWindow, state, env, platform, listChannels, clientFactory, controllerFactory }) → { controller, client, start(), shutdown() }`. It builds no core and opens no listener; it registers exactly one `ipcMain.handle`/`ipcMain.on` per inventory channel plus `canvas:executeJsResult`, routed by spec §3.6; forwards `RENDERER_EVENTS` to the window; sends `chat:messageError { chatId, responseId, error: 'The local service restarted; the reply was lost.' }` for every open run when the connection drops.

- [ ] **Step 1: Write the failing test**

Create `tests/attached-host.test.js`:

```js
// tests/attached-host.test.js — no Electron: fake ipcMain, window, dialog and client.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { startAttachedHost } = require('../src/ipc/attached-host');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { BridgeError } = require('../src/desktop-bridge/protocol');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-attached-')); dirs.push(d); return d; };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.service = null;
    this.port = 18796;
    this.invoked = [];
    this.sent = [];
    this.calls = [];
    this.answers = new Map();
  }
  async connect() { return this.service; }
  retryNow() { return Promise.resolve(this.service); }
  close() { this.connected = false; }
  async invoke(channel, args) {
    this.invoked.push([channel, args]);
    if (this.answers.has(channel)) return this.answers.get(channel)(args);
    return { ok: true, data: { channel } };
  }
  send(channel, args) { this.sent.push([channel, args]); return true; }
  async call(method, params) {
    this.calls.push([method, params]);
    if (method === 'bridge.status') return this.service;
    if (method === 'bridge.setWorkingDirectory') return { ok: true, data: { id: params.chatId, workingDirectory: params.path } };
    if (method === 'bridge.addAllowedDirectory') return { ok: true, allowedDirectories: [params.path] };
    return { ok: true };
  }
  goLive(service) {
    this.service = service;
    this.connected = true;
    this.emit('state', { status: 'connected', code: null, error: null, service, nextRetryAt: null });
  }
  drop() {
    this.connected = false;
    this.emit('state', { status: 'disconnected', code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable (127.0.0.1:18796).', service: this.service, nextRetryAt: Date.now() + 1000 });
  }
}

const SERVICE = (channels, extra = {}) => ({ version: '26.9.0', protocol: 1, nodeId: 'kl-abcdefghijklmnop', account: 'LOCAL SERVICE', profile: 'agent', providersConfigured: true, channels, ...extra });

function setup() {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate handle ${ch}`); handlers.set(ch, fn); },
    on: (ch, fn) => { assert.ok(!listeners.has(ch), `duplicate on ${ch}`); listeners.set(ch, fn); }
  };
  const sent = [];
  const window = { isDestroyed: () => false, close: () => sent.push(['closed']), webContents: { send: (ch, p) => sent.push([ch, p]) } };
  const dialogAnswers = [];
  const dialog = { showOpenDialog: async () => dialogAnswers.shift() };
  const userDataDir = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) });
  state.setMode('attached');
  state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: 'kl-abcdefghijklmnop', publicKey: 'aa', port: 18796, pairedAt: '2026-09-23T14:02:11Z' } });
  const client = new FakeClient();
  const app = { getPath: () => userDataDir, relaunch() {}, exit() {}, quit() {} };
  const host = startAttachedHost({ app, ipcMain, safeStorage, dialog, getWindow: () => window, state, env: {}, platform: 'linux', clientFactory: () => client });
  return { host, handlers, listeners, sent, client, dialogAnswers };
}

describe('attached host', () => {
  it('registers every inventory channel exactly once, plus canvas:executeJsResult', () => {
    const { handlers, listeners } = setup();
    const inv = listIpcChannels();
    assert.deepStrictEqual([...handlers.keys()].sort(), [...inv.handle].sort());
    assert.deepStrictEqual([...listeners.keys()].sort(), [...inv.on, 'canvas:executeJsResult'].sort());
  });

  it('routes proxy, deny, local and service-too-old channels', async () => {
    const { host, handlers, client } = setup();
    host.start();
    assert.strictEqual((await handlers.get('chat:load')({})).code, 'SERVICE_UNREACHABLE');
    client.goLive(SERVICE(['chat:load', 'chat:sendMessage', 'tool:approvalResponse']));
    assert.deepStrictEqual(await handlers.get('chat:load')({}), { ok: true, data: { channel: 'chat:load' } });
    assert.deepStrictEqual(await handlers.get('hooks:list')({}), {
      ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available while attached to the local service. Detach in Settings > Local service to use it.'
    });
    assert.strictEqual((await handlers.get('settings:mcpList')({})).code, 'ATTACHED_UNAVAILABLE');
    assert.deepStrictEqual(await handlers.get('cron:list')({}), {
      ok: false, code: 'SERVICE_TOO_OLD', error: 'The local service (version 26.9.0) does not support cron:list. Upgrade the service.'
    });
    assert.ok(!client.invoked.some(([ch]) => ch === 'hooks:list'));
    client.answers.set('chat:load', () => { throw new BridgeError('BRIDGE_TIMEOUT', 'The local service did not answer in time.'); });
    assert.deepStrictEqual(await handlers.get('chat:load')({}), { ok: false, code: 'BRIDGE_TIMEOUT', error: 'The local service did not answer in time.' });
    client.answers.set('chat:load', () => { throw new BridgeError('PAYLOAD_TOO_LARGE', 'Payload too large'); });
    assert.strictEqual((await handlers.get('chat:load')({})).error, 'That request is too large for the local service (64 MiB limit).');
  });

  it('wizard is local, and a send without a provider says so', async () => {
    const { handlers, client } = setup();
    assert.deepStrictEqual(await handlers.get('wizard:getStatus')({}), { ok: true, isFirstRun: false });
    assert.deepStrictEqual(await handlers.get('wizard:complete')({}), { ok: true });
    assert.ok((await handlers.get('wizard:getSteps')({})).steps.length > 0);
    client.goLive(SERVICE(['chat:sendMessage'], { providersConfigured: false }));
    assert.deepStrictEqual(await handlers.get('chat:sendMessage')({}, { chatId: 'c1', message: 'hi' }), {
      ok: false, code: 'NO_PROVIDER', error: 'The service has no provider key yet — import or add one in Providers.'
    });
    assert.ok(client.calls.some(([m]) => m === 'bridge.status'), 'it re-reads the service status first');
    client.service = SERVICE(['chat:sendMessage']);
    client.call = async () => client.service;
    assert.strictEqual((await handlers.get('chat:sendMessage')({}, { chatId: 'c1', message: 'hi' })).ok, true);
  });

  it('runs the directory pickers locally and reshapes the bridge answers', async () => {
    const { handlers, client, dialogAnswers } = setup();
    client.goLive(SERVICE(['chat:load']));
    dialogAnswers.push({ canceled: true, filePaths: [] });
    assert.deepStrictEqual(await handlers.get('chat:pickWorkingDirectory')({}, { chatId: 'c1' }), { ok: true, data: { canceled: true } });
    dialogAnswers.push({ canceled: false, filePaths: ['/srv/projects'] });
    assert.deepStrictEqual(await handlers.get('chat:pickWorkingDirectory')({}, { chatId: 'c1' }), { ok: true, data: { canceled: false, chat: { id: 'c1', workingDirectory: '/srv/projects' } } });
    dialogAnswers.push({ canceled: false, filePaths: ['/srv/data'] });
    assert.deepStrictEqual(await handlers.get('settings:addAllowedDirectory')({}), { ok: true, allowedDirectories: ['/srv/data'] });
    dialogAnswers.push({ canceled: true, filePaths: [] });
    assert.deepStrictEqual(await handlers.get('settings:addAllowedDirectory')({}), { ok: false, canceled: true });
  });

  it('forwards renderer events and proxies prompt answers', async () => {
    const { listeners, sent, client } = setup();
    client.goLive(SERVICE(['chat:load', 'tool:approvalResponse']));
    client.emit('event', 'tool:approvalRequired', { approvalId: 'a1', toolName: 'Bash', parameters: {} });
    client.emit('event', 'workflow:progress', {});
    assert.ok(sent.some(([ch]) => ch === 'tool:approvalRequired'));
    assert.ok(!sent.some(([ch]) => ch === 'workflow:progress'));
    listeners.get('tool:approvalResponse')({}, { approvalId: 'a1', approved: true });
    assert.deepStrictEqual(client.sent, [['tool:approvalResponse', [{ approvalId: 'a1', approved: true }]]]);
    listeners.get('canvas:executeJsResult')({}, { requestId: 'r1', result: 1 });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(client.calls.pop(), ['bridge.canvasJsResult', { requestId: 'r1', result: 1 }]);
  });

  it('a dropped connection ends open runs with chat:messageError', () => {
    const { sent, client } = setup();
    client.goLive(SERVICE(['chat:sendMessage']));
    client.emit('event', 'chat:messageStart', { chatId: 'c1', responseId: 'r1' });
    client.emit('event', 'chat:messageStart', { chatId: 'c2', responseId: 'r2' });
    client.emit('event', 'chat:messageComplete', { chatId: 'c2', responseId: 'r2', message: 'done' });
    client.drop();
    const errors = sent.filter(([ch]) => ch === 'chat:messageError').map(([, p]) => p);
    assert.deepStrictEqual(errors, [{ chatId: 'c1', responseId: 'r1', error: 'The local service restarted; the reply was lost.' }]);
    assert.ok(sent.some(([ch]) => ch === 'desktop:statusChanged'));
  });

  it('reconnect with changed service info: new channels apply at once', async () => {
    const { handlers, client } = setup();
    client.goLive(SERVICE(['chat:load']));
    assert.strictEqual((await handlers.get('cron:list')({})).code, 'SERVICE_TOO_OLD');
    client.drop();
    assert.strictEqual((await handlers.get('chat:load')({})).code, 'SERVICE_UNREACHABLE');
    client.goLive(SERVICE(['chat:load', 'cron:list'], { version: '26.10.0' }));
    assert.deepStrictEqual(await handlers.get('cron:list')({}), { ok: true, data: { channel: 'cron:list' } });
  });

  it('answers desktop:status through the controller', async () => {
    const { handlers, client } = setup();
    client.goLive(SERVICE(['chat:load']));
    const status = await handlers.get('desktop:status')({});
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.view, 'attached-connected');
    assert.ok(status.unavailableTabs.includes('mcp'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/attached-host.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/attached-host'`.

- [ ] **Step 3: Implement**

Create `src/ipc/attached-host.js`:

```js
// Attached mode (fleet stage 7 §3.7): no core, no listener. Every IPC channel
// the handlers register is answered here: locally, by a native dialog then a
// bridge method, by the service over the bridge, or with "not available".
const { createLogger } = require('../logging');
const { listIpcChannels } = require('./channel-inventory');
const { createDesktopHandler } = require('./desktop-handlers');
const { createDesktopController } = require('./desktop-controller');
const { classifyChannel, isRendererEvent } = require('../desktop-bridge/allowlist');
const { MESSAGES } = require('../desktop-bridge/protocol');

const log = createLogger('attached-host');

function startAttachedHost(deps) {
  const {
    app, ipcMain, safeStorage, dialog, getWindow, state,
    env = process.env, platform = process.platform,
    listChannels = listIpcChannels, clientFactory = null, controllerFactory = createDesktopController
  } = deps;
  const controller = controllerFactory({
    state, mode: 'attached', app, getWindow, env, platform,
    userDataDir: app.getPath('userData'), safeStorage, clientFactory
  });
  const client = controller.createClient();
  controller.setClient(client);
  const openRuns = new Map(); // responseId -> chatId

  const port = () => (client && client.port) || (state.pairing && state.pairing.service && state.pairing.service.port) || 18796;
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const unreachable = () => ({ ok: false, code: 'SERVICE_UNREACHABLE', error: MESSAGES.SERVICE_UNREACHABLE(port()) });
  const unavailable = () => ({ ok: false, code: 'ATTACHED_UNAVAILABLE', error: MESSAGES.ATTACHED_UNAVAILABLE });
  const errorResult = (err) => ({
    ok: false,
    code: err.code || 'SERVICE_UNREACHABLE',
    error: err.code === 'PAYLOAD_TOO_LARGE' ? MESSAGES.PAYLOAD_TOO_LARGE : err.message
  });
  const live = () => Boolean(client && client.connected);
  const served = (channel) => Boolean(client && client.service && Array.isArray(client.service.channels) && client.service.channels.includes(channel));

  async function providerReady() {
    if (!client.service || client.service.providersConfigured !== false) return true;
    try {
      client.service = await client.call('bridge.status');
    } catch { /* keep the old summary */ }
    return client.service.providersConfigured !== false;
  }

  async function proxyInvoke(channel, args) {
    if (!live()) return unreachable();
    if (!served(channel)) return { ok: false, code: 'SERVICE_TOO_OLD', error: MESSAGES.SERVICE_TOO_OLD(client.service.version, channel) };
    if (channel === 'chat:sendMessage' && !(await providerReady())) return { ok: false, code: 'NO_PROVIDER', error: MESSAGES.NO_PROVIDER };
    try {
      return await client.invoke(channel, args);
    } catch (err) {
      return errorResult(err);
    }
  }

  const LOCAL = {
    'wizard:getStatus': async () => ({ ok: true, isFirstRun: false }),
    'wizard:complete': async () => ({ ok: true }),
    'wizard:getSteps': async () => {
      const { getWizardSteps } = require('../wizard/onboarding-wizard');
      return { ok: true, steps: getWizardSteps().map((s) => ({ id: s.id, title: s.title, description: s.description, optional: s.optional })) };
    },
    'app:quitWindow': async () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.close();
      return { ok: true };
    }
  };

  // Native dialog here, then the service checks the path as its own account.
  const PRESTEP = {
    'chat:pickWorkingDirectory': async (_event, { chatId } = {}) => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'], title: 'Select Working Directory' });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: true, data: { canceled: true } };
      if (!live()) return unreachable();
      try {
        const value = await client.call('bridge.setWorkingDirectory', { chatId, path: result.filePaths[0] });
        return { ok: true, data: { canceled: false, chat: value && value.ok ? value.data : value } };
      } catch (err) {
        return errorResult(err);
      }
    },
    'settings:addAllowedDirectory': async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'], title: 'Add Allowed Directory' });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
      if (!live()) return unreachable();
      try {
        return await client.call('bridge.addAllowedDirectory', { path: result.filePaths[0] });
      } catch (err) {
        return errorResult(err);
      }
    }
  };

  const inventory = listChannels();
  for (const channel of inventory.handle) {
    const route = classifyChannel(channel);
    let fn;
    if (route === 'local') fn = channel.startsWith('desktop:') ? createDesktopHandler(channel, () => controller) : (LOCAL[channel] || (async () => unavailable()));
    else if (route === 'prestep') fn = PRESTEP[channel];
    else if (route === 'proxy') fn = (_event, ...args) => proxyInvoke(channel, args);
    else fn = async () => unavailable();
    ipcMain.handle(channel, fn);
  }
  for (const channel of inventory.on) {
    const route = classifyChannel(channel);
    ipcMain.on(channel, (_event, ...args) => {
      if (route !== 'proxy' || !live() || !served(channel)) {
        log.debug(`dropped ${channel} while attached`);
        return;
      }
      client.send(channel, args);
    });
  }
  ipcMain.on('canvas:executeJsResult', (_event, payload = {}) => {
    if (live()) client.call('bridge.canvasJsResult', payload).catch(() => {});
  });

  if (client) {
    client.on('event', (channel, payload) => {
      if (!isRendererEvent(channel)) return;
      if (channel === 'chat:messageStart' && payload) openRuns.set(payload.responseId, payload.chatId);
      if ((channel === 'chat:messageComplete' || channel === 'chat:messageError') && payload) openRuns.delete(payload.responseId);
      send(channel, payload);
    });
    client.on('state', (s) => {
      if (s.status === 'connected' || openRuns.size === 0) return;
      for (const [responseId, chatId] of openRuns) send('chat:messageError', { chatId, responseId, error: MESSAGES.SERVICE_RESTARTED });
      openRuns.clear();
    });
  }

  return {
    controller,
    client,
    start() {
      if (client) client.connect().catch((err) => log.warn(`the local service is not reachable yet: ${err.message}`));
    },
    async shutdown() {
      controller.dispose();
      if (client) client.close();
    }
  };
}

module.exports = { startAttachedHost };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/attached-host.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/attached-host.js tests/attached-host.test.js
git commit -m "feat(ipc): attached host proxying the allowlisted channels to the service

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The standalone host, `CronScheduler.pause()` and the wiring-only `main.js`

**Files:**
- Create: `src/ipc/standalone-host.js`
- Modify: `src/cron/cron-scheduler.js` — insert before the line `  stop() {`; the first line of `async tick() {`
- Modify: `main.js` (rewritten; the `KL_TEST_BRIDGE_PORT` hook stays until Task 17)
- Test: `tests/standalone-host.test.js`

**Interfaces:**
- Consumes: `registerHandlers`, `createCore`, `CHAT_DATA_DEFAULTS`, `createSafeStorageCipher`, `createElectronPrompter`, `UiToastChannel`, `markLocalDesktopEvent` (Part 1), `createDesktopController` (Task 13), `openDesktopState` (Task 12), `startAttachedHost` (Task 14).
- Produces: `markingIpcMain(ipcMain) → { handle, on, removeHandler }` (every handler receives `markLocalDesktopEvent(event)`); `startStandaloneHost({ app, ipcMain, safeStorage, shell, Notification, getWindow, state, appDir, standaloneOnce = false, StoreClass, createCoreFn }) → { core, controller, start(), shutdown() }` — with `standaloneOnce` the core is built with `features: { channels: false, gateway: false, mesh: false }` and cron is paused after `core.start()`. `CronScheduler.prototype.pause()`; `tick()` returns at once while paused.

- [ ] **Step 1: Write the failing test**

Create `tests/standalone-host.test.js`:

```js
// tests/standalone-host.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createCore } = require('../src/core');
const { isLocalDesktopEvent } = require('../src/core/origin');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { startStandaloneHost, markingIpcMain } = require('../src/ipc/standalone-host');
const CronScheduler = require('../src/cron/cron-scheduler');

const dirs = [];
const hosts = [];
after(async () => {
  for (const h of hosts) await h.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-standalone-')); dirs.push(d); return d; };

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return { handlers, listeners, handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); }, on: (ch, fn) => listeners.set(ch, fn), removeHandler: (ch) => handlers.delete(ch) };
}

function startHost({ standaloneOnce }) {
  const userData = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`sealed:${s}`), decryptString: (b) => Buffer.from(b).toString().replace(/^sealed:/, '') };
  class StoreClass extends JsonFileStore {
    constructor({ name = 'config', defaults = {} } = {}) { super({ dir: userData, name, defaults }); }
  }
  const ipc = fakeIpcMain();
  let captured = null;
  const host = startStandaloneHost({
    app: { getPath: () => userData, relaunch() {}, exit() {}, quit() {} },
    ipcMain: ipc,
    safeStorage,
    shell: { openExternal: async () => {} },
    Notification: class { show() {} },
    getWindow: () => null,
    state: openDesktopState(userData, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) }),
    appDir: path.join(__dirname, '..'),
    standaloneOnce,
    StoreClass,
    // Webhooks and app discovery off only to keep the test quick and port-free.
    createCoreFn: (deps) => { captured = deps; return createCore({ ...deps, features: { ...(deps.features || {}), webhooks: false, appDiscovery: false, ...(standaloneOnce ? {} : { gateway: false, mesh: false, channels: false }) } }); }
  });
  hosts.push(host);
  return { host, ipc, captured: () => captured };
}

describe('markingIpcMain', () => {
  it('hands every handler and listener a marked event', async () => {
    const ipc = fakeIpcMain();
    const wrapped = markingIpcMain(ipc);
    let seenHandle = null;
    let seenOn = null;
    wrapped.handle('chat:load', async (event, arg) => { seenHandle = [event, arg]; return 1; });
    wrapped.on('tool:approvalResponse', (event, arg) => { seenOn = [event, arg]; });
    const e1 = { sender: {} };
    const e2 = { sender: {} };
    assert.strictEqual(await ipc.handlers.get('chat:load')(e1, 'x'), 1);
    ipc.listeners.get('tool:approvalResponse')(e2, 'y');
    assert.strictEqual(seenHandle[0], e1);
    assert.strictEqual(isLocalDesktopEvent(seenHandle[0]), true);
    assert.strictEqual(seenHandle[1], 'x');
    assert.strictEqual(isLocalDesktopEvent(seenOn[0]), true);
  });
});

describe('CronScheduler.pause', () => {
  it('stops ticks from running due jobs', async () => {
    let runs = 0;
    const store = { list: () => [{ id: 'j1', enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0 } }], update: async () => {} };
    const scheduler = new CronScheduler(store, { execute: async () => { runs += 1; return { ok: true }; } });
    scheduler.pause();
    await scheduler.tick();
    assert.strictEqual(runs, 0);
    assert.strictEqual(scheduler.paused, true);
  });
});

describe('startStandaloneHost', () => {
  it('registers every channel through the marking wrapper, desktop:* included', async () => {
    const { host, ipc } = startHost({ standaloneOnce: false });
    const event = { sender: { send() {}, isDestroyed: () => false } };
    const loaded = await ipc.handlers.get('chat:load')(event);
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(isLocalDesktopEvent(event), true);
    const status = await ipc.handlers.get('desktop:status')(event);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.mode, 'standalone');
    assert.ok(ipc.listeners.has('canvas:executeJsResult'));
    await host.start();
    assert.strictEqual(host.core.context.getCronScheduler().paused, undefined);
  });

  it('--kl-standalone-once starts with channels, gateway and mesh off and cron paused', async () => {
    const { host, captured } = startHost({ standaloneOnce: true });
    assert.deepStrictEqual(captured().features, { channels: false, gateway: false, mesh: false });
    await host.start();
    assert.strictEqual(host.core.context.getCronScheduler().paused, true);
  });
});

describe('main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  it('is wiring only: no core of its own, a host chosen from the desktop state', () => {
    assert.ok(!/createCore/.test(main), 'main.js builds no core');
    assert.match(main, /openDesktopState\(/);
    assert.match(main, /startAttachedHost/);
    assert.match(main, /startStandaloneHost/);
    assert.match(main, /--kl-standalone-once/);
    assert.ok(main.split('\n').length < 130, `main.js has ${main.split('\n').length} lines`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/standalone-host.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/standalone-host'`.

- [ ] **Step 3: Implement**

In `src/cron/cron-scheduler.js`, insert before the line `  stop() {`:

```js
  // Fleet stage 7 --kl-standalone-once: the service is the instance that
  // acts, so this app's scheduler runs nothing until the next launch.
  pause() {
    this.paused = true;
    this.stop();
  }

```

and replace:

```js
  async tick() {
```

with:

```js
  async tick() {
    if (this.paused) return;
```

Create `src/ipc/standalone-host.js`:

```js
// Standalone mode (fleet stage 7 §3.7): what main.js did before, moved here
// unchanged, plus two things: every IPC event is marked as local-desktop
// before any handler sees it (program §4.21), and the desktop controller is in
// the handler context so Settings > Local service works in both modes.
const path = require('path');
const { registerHandlers } = require('./register');
const { createCore } = require('../core');
const { CHAT_DATA_DEFAULTS } = require('../core/settings');
const { createSafeStorageCipher } = require('../platform/cipher');
const { createElectronPrompter } = require('../platform/electron-prompter');
const { markLocalDesktopEvent } = require('../core/origin');
const UiToastChannel = require('../notifications/channels/ui-toast');
const { createDesktopController } = require('./desktop-controller');

function markingIpcMain(ipcMain) {
  return {
    handle: (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(markLocalDesktopEvent(event), ...args)),
    on: (channel, fn) => ipcMain.on(channel, (event, ...args) => fn(markLocalDesktopEvent(event), ...args)),
    removeHandler: (channel) => ipcMain.removeHandler(channel)
  };
}

function startStandaloneHost(deps) {
  const {
    app, ipcMain, safeStorage, shell, Notification, getWindow, state, appDir,
    standaloneOnce = false, StoreClass = null, createCoreFn = createCore
  } = deps;
  const Store = StoreClass || require('electron-store').default;
  const pendingAskUserResolvers = new Map();
  const pendingDirectoryAccessResolvers = new Map();
  const prompter = createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers });
  const liveWindow = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  const core = createCoreFn({
    paths: { dataDir: app.getPath('userData') },
    store: new Store({ name: 'chat-data', defaults: CHAT_DATA_DEFAULTS }),
    vaultStore: new Store(),
    cipher: createSafeStorageCipher(safeStorage),
    prompter,
    ui: {
      send: (channel, payload) => {
        const win = liveWindow();
        if (win) win.webContents.send(channel, payload);
      },
      reportError: (message, stack) => {
        const win = liveWindow();
        if (win) {
          win.webContents.executeJavaScript(
            `console.error('[main→renderer] Mesh initialization failed:', ${JSON.stringify(message)}, ${JSON.stringify(stack)})`
          ).catch(() => {});
        }
      }
    },
    openExternal: (url) => shell.openExternal(url),
    uiToastChannel: new UiToastChannel({ Notification }),
    builtinSkillsDir: path.join(appDir, 'skills'),
    // One session next to a running service: nothing here may act for it.
    ...(standaloneOnce ? { features: { channels: false, gateway: false, mesh: false } } : {})
  });

  const controller = createDesktopController({
    state, mode: 'standalone', app, getWindow, userDataDir: app.getPath('userData'), safeStorage
  });

  registerHandlers(markingIpcMain(ipcMain), {
    ...core.context,
    safeStorage,
    getMainWindow: getWindow,
    getShell: () => shell,
    pendingAskUserResolvers,
    pendingDirectoryAccessResolvers,
    prompter,
    desktopBridge: controller
  });

  ipcMain.on('canvas:executeJsResult', (_event, { requestId, result, error } = {}) => {
    const pending = core.pendingCanvasJsResolvers.get(requestId);
    if (!pending) return;
    core.pendingCanvasJsResolvers.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.resolve({ action: 'execute_js', error });
    else pending.resolve({ action: 'execute_js', result });
  });

  return {
    core,
    controller,
    async start() {
      await core.start();
      if (standaloneOnce) {
        const cron = core.context.getCronScheduler();
        if (cron) cron.pause();
      }
      // Notify the renderer that mesh is ready so it can refresh status.
      const meshContext = core.getMeshContext();
      const win = liveWindow();
      if (meshContext && win) {
        const sendReady = () => win.webContents.send('mesh:ready');
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', sendReady);
        else sendReady();
      }
    },
    async shutdown() {
      controller.dispose();
      await core.shutdown();
    }
  };
}

module.exports = { startStandaloneHost, markingIpcMain };
```

Replace the whole of `main.js` with:

```js
const { app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, Notification, dialog } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'king-louie-screenshots');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kl-screenshot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// An explicit --user-data-dir wins before anything reads the profile (the
// e2e harness gives every launch its own).
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--user-data-dir='.length)));

const { openDesktopState } = require('./src/ipc/desktop-state');
const { startStandaloneHost } = require('./src/ipc/standalone-host');
const { startAttachedHost } = require('./src/ipc/attached-host');

let mainWindow = null;
const getWindow = () => mainWindow;

// Attached or standalone is decided here, before any core exists (fleet stage 7 §3.7).
const state = openDesktopState(app.getPath('userData'), safeStorage);
const standaloneOnce = process.argv.includes('--kl-standalone-once');
const attached = state.mode === 'attached' && !standaloneOnce;
const deps = { app, ipcMain, safeStorage, shell, dialog, Notification, getWindow, state, appDir: __dirname, standaloneOnce };
const host = attached ? startAttachedHost(deps) : startStandaloneHost(deps);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires bundled Node modules (logging, marked, dompurify,
      // highlight.js). Electron 20+ defaults sandbox to true, which blocks those
      // requires and aborts the preload before it can expose `window.electron`,
      // breaking every IPC call. The renderer stays isolated via
      // contextIsolation + nodeIntegration:false.
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  protocol.handle('kl-screenshot', (request) => {
    try {
      const url = new URL(request.url);
      const fileName = path.basename(decodeURIComponent(url.pathname));
      const resolved = path.resolve(SCREENSHOT_DIR, fileName);
      if (path.dirname(resolved) !== path.resolve(SCREENSHOT_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // E2E test bridge (removed with the Playwright harness in fleet stage 7 Task 17).
  if (process.env.KL_TEST_BRIDGE_PORT) {
    require(process.env.KL_TEST_BRIDGE_SCRIPT || path.join(__dirname, 'tests', 'e2e', '_bridge.js'));
  }

  // Show the window immediately — don't block on infrastructure.
  createWindow();
  await host.start();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    host.shutdown().finally(() => app.quit());
  }
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/standalone-host.test.js tests/preload-bridge.test.js tests/cron-scheduler.test.js tests/ipc-contract.test.js`
Expected: PASS, `# fail 0`. Then launch the app once: `unset ELECTRON_RUN_AS_NODE && npm start` — Expected: the window opens and chats load as before (standalone mode); close it.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/standalone-host.js src/cron/cron-scheduler.js main.js tests/standalone-host.test.js
git commit -m "refactor(main): split into standalone and attached hosts chosen before any core exists

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Settings > Local service pane

**Files:**
- Create: `src/desktop-bridge/pane-model.js`
- Modify: `preload.js` — insert before the line `    markdown: {` inside `contextBridge.exposeInMainWorld('electron', { … })`, and after the line `const markdownLog = createLogger('markdown');`
- Modify: `index.html` — after `          <option value="commands">Commands</option>`; before `        <!-- Tab: Commands -->`
- Modify: `renderer.js` — inside `function switchSettingsTab(tabName) {` after the `channels` block; append one block after the last line `checkFirstRun();`
- Modify: `styles.css` — append at the end
- Test: `tests/desktop-pane.test.js`

**Interfaces:**
- Consumes: `MESSAGES` (Part 1); the controller's `status()` shape (Task 13); `desktop:*` channels.
- Produces: `describeServicePane(status) → { view, lines: string[], actions: [{ id, label, disabled? }], request, command, detachWarning, approvals: { lines, commands } | null }`, `describeApprovals(status)`, `describeImportReport(report) → string[]`, `UNAVAILABLE_TAB_NOTICE`. Preload `window.electron.desktop = { status, pairStart, pairConfirm, pairCancel, attach, detach, standaloneOnce, unpair, retry, importPlan, importApply, onStatusChanged, onImportProgress, describe, describeImport }`. Renderer `renderServiceSection()`, `markUnavailableTabs(tabs)`, `renderAttachedBanner(status)`. Action button ids `service-action-<id>`; banner `#attached-service-banner`; notice class `.service-unavailable-notice`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-pane.test.js`:

```js
// tests/desktop-pane.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { describeServicePane, describeImportReport, UNAVAILABLE_TAB_NOTICE } = require('../src/desktop-bridge/pane-model');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ids = (model) => model.actions.map((a) => a.id);

describe('describeServicePane', () => {
  it('unpaired: no service found, Pair still allowed', () => {
    const m = describeServicePane({ view: 'unpaired', bridgeFile: '/etc/king-louie/desktop-bridge.json', bridge: { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' } });
    assert.strictEqual(m.lines[0], 'No local service found at /etc/king-louie.');
    assert.match(m.lines[1], /king-louie-service/);
    assert.deepStrictEqual(ids(m), ['pair']);
  });

  it('unpaired with an untrusted file shows the refusal', () => {
    const m = describeServicePane({ view: 'unpaired', bridge: { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: 'C:\\x is not owned by an administrator; refusing to trust it.' } });
    assert.strictEqual(m.lines[0], 'C:\\x is not owned by an administrator; refusing to trust it.');
  });

  it('pairing: request, command, both fingerprints, Confirm only once the service is found', () => {
    const waiting = describeServicePane({ view: 'pairing', pendingPair: { request: 'klpair1.x', command: 'sudo king-louie-service desktop pair klpair1.x', deviceFingerprint: 'abcd efgh ijkl mnop', service: null, error: null } });
    assert.strictEqual(waiting.request, 'klpair1.x');
    assert.strictEqual(waiting.command, 'sudo king-louie-service desktop pair klpair1.x');
    assert.ok(waiting.lines.includes('This desktop: abcd efgh ijkl mnop'));
    assert.deepStrictEqual(waiting.actions, [{ id: 'pairConfirm', label: 'Confirm', disabled: true }, { id: 'pairCancel', label: 'Cancel' }]);
    const found = describeServicePane({ view: 'pairing', pendingPair: { request: 'r', command: 'c', deviceFingerprint: 'a', service: { fingerprint: 'wxyz 2345 6789 abcd', port: 18796 } } });
    assert.ok(found.lines.includes('Service: wxyz 2345 6789 abcd (port 18796)'));
    assert.strictEqual(found.actions[0].disabled, false);
  });

  it('paired standalone: account warning and Import, Attach, Unpair', () => {
    const m = describeServicePane({ view: 'paired', pairing: { service: { fingerprint: 'wxyz 2345 6789 abcd' } }, service: { version: '26.9.0', account: 'LOCAL SERVICE' } });
    assert.ok(m.lines.includes('Service: wxyz 2345 6789 abcd'));
    assert.ok(m.lines.includes('Version 26.9.0, running as LOCAL SERVICE.'));
    assert.ok(m.lines.includes('Tools will run as LOCAL SERVICE.'));
    assert.deepStrictEqual(ids(m), ['import', 'attach', 'unpair']);
  });

  it('attached and connected: the no-provider line and the approvals section', () => {
    const m = describeServicePane({
      view: 'attached-connected', detachWarning: 'W', pairing: { service: { fingerprint: 'f' } },
      service: { version: '26.9.0', account: 'LOCAL SERVICE', providersConfigured: false },
      approvals: { available: false }
    });
    assert.ok(m.lines.includes('The service has no provider key yet — import or add one in Providers.'));
    assert.deepStrictEqual(ids(m), ['import', 'detach', 'unpair']);
    assert.strictEqual(m.detachWarning, 'W');
    assert.deepStrictEqual(m.approvals.lines, ['Phone approvals are not set up on this service.']);
    const full = describeServicePane({
      view: 'attached-connected', pairing: { service: { fingerprint: 'f' } }, service: { version: '26.9.0', account: 'LOCAL SERVICE' },
      approvals: { available: true, relay: { configured: true, connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' }, devices: [{ device_id: 'd-1', name: 'Phone', platform: 'android', active: true }], pending: [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }], audit: { last_seq: 12, last_at: '2026-09-23T10:01:00Z' } }
    });
    assert.deepStrictEqual(full.approvals.lines, [
      'Relay kl-relayrelayrelay1: connected since 2026-09-23T10:00:00Z',
      'Phone (android)',
      'Waiting: Bash: ls (until 2026-09-23T10:05:00Z)',
      'Audit ledger: entry 12 at 2026-09-23T10:01:00Z'
    ]);
    assert.deepStrictEqual(full.approvals.commands, ['king-louie-service enroll-device', 'king-louie-service device revoke <device-id>']);
  });

  it('attached, not connected: the error, Retry now, Use standalone this time, Detach', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: 'The local King Louie service is not reachable (127.0.0.1:18796).', nextRetryAt: null } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18796).');
    assert.deepStrictEqual(m.actions.map((a) => a.label), ['Retry now', 'Use standalone this time', 'Detach']);
  });

  it('summarizes an import report', () => {
    const lines = describeImportReport({ counts: { new: 3, 'skip-present': 1, failed: 1 }, failures: [{ category: 'vault', key: 'github', error: 'Encryption unavailable in the service.' }], secretsMissing: [{ category: 'vault', key: 'github' }], attention: [], notes: ['1 cron job(s) were imported disabled; enable them in Settings > Scheduler.'], skipped: [] });
    assert.deepStrictEqual(lines, [
      'new: 3, skip-present: 1, failed: 1',
      'Failed: vault github — Encryption unavailable in the service.',
      'Secrets that did not arrive: vault github',
      '1 cron job(s) were imported disabled; enable them in Settings > Scheduler.'
    ]);
    assert.strictEqual(UNAVAILABLE_TAB_NOTICE, 'Managed by the local service; not available while attached.');
  });
});

describe('pane wiring', () => {
  it('preload exposes window.electron.desktop over the desktop:* channels', () => {
    const preload = read('preload.js');
    for (const ch of ['status', 'pairStart', 'pairConfirm', 'pairCancel', 'attach', 'detach', 'standaloneOnce', 'unpair', 'retry', 'importPlan', 'importApply']) {
      assert.ok(preload.includes(`ipcRenderer.invoke('desktop:${ch}'`), `desktop:${ch}`);
    }
    assert.ok(preload.includes("registerOnce('desktop:statusChanged'"));
    assert.ok(preload.includes("registerOnce('desktop:importProgress'"));
  });

  it('index.html has the Local service tab and pane', () => {
    const html = read('index.html');
    assert.ok(html.includes('<option value="service">Local service</option>'));
    assert.ok(html.includes('class="settings-tab-content" data-tab="service"'));
    for (const id of ['service-pane-status', 'service-pane-request', 'service-pair-request', 'service-pair-command', 'service-pane-actions', 'service-pane-import', 'service-pane-approvals']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  it('renderer renders the pane from switchSettingsTab and subscribes once', () => {
    const renderer = read('renderer.js');
    assert.match(renderer, /async function renderServiceSection\(\)/);
    assert.match(renderer, /function markUnavailableTabs\(/);
    const switchBody = renderer.slice(renderer.indexOf('function switchSettingsTab('), renderer.indexOf('function sortSettingsNavOptions('));
    assert.match(switchBody, /tabName === 'service'/);
    assert.strictEqual((renderer.match(/desktop\.onStatusChanged\(/g) || []).length, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-pane.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/pane-model'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/pane-model.js`:

```js
// What Settings > Local service shows for each state (fleet stage 7 §3.9).
// Pure, so the wording is tested in node; the preload exposes it to the renderer.
const { MESSAGES } = require('./protocol');

const UNAVAILABLE_TAB_NOTICE = 'Managed by the local service; not available while attached.';
const INSTALL_HINT = 'Install king-louie-service on this computer and run it with the agent profile to use this app as its window.';

function dirOf(file) {
  const text = String(file || '');
  const i = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return i > 0 ? text.slice(0, i) : text;
}

function serviceLines(status) {
  const lines = [];
  const fp = status.pairing && status.pairing.service && status.pairing.service.fingerprint;
  if (fp) lines.push(`Service: ${fp}`);
  const svc = status.service;
  if (svc && svc.account) {
    lines.push(`Version ${svc.version}, running as ${svc.account}.`);
    lines.push(`Tools will run as ${svc.account}.`);
  } else {
    lines.push('Tools will run as the service account, not as you.');
  }
  if (svc && svc.providersConfigured === false) lines.push(MESSAGES.NO_PROVIDER);
  return lines;
}

function describeApprovals(status) {
  if (status.view !== 'attached-connected') return null;
  const a = status.approvals;
  const commands = ['king-louie-service enroll-device', 'king-louie-service device revoke <device-id>'];
  if (!a || !a.available) return { lines: ['Phone approvals are not set up on this service.'], commands };
  const lines = [];
  if (a.relay && a.relay.configured) {
    lines.push(`Relay ${a.relay.relay_id || ''}: ${a.relay.connected ? `connected since ${a.relay.since}` : 'not connected'}`);
  } else {
    lines.push('No relay is configured.');
  }
  for (const d of a.devices || []) lines.push(`${d.name || d.device_id} (${d.platform || 'unknown'})${d.active ? '' : ' — inactive'}`);
  for (const p of a.pending || []) lines.push(`Waiting: ${p.summary} (until ${p.expires_at})`);
  if (a.audit && a.audit.last_seq !== null && a.audit.last_seq !== undefined) lines.push(`Audit ledger: entry ${a.audit.last_seq} at ${a.audit.last_at}`);
  return { lines, commands };
}

function describeServicePane(status = {}) {
  const s = status || {};
  const lines = [];
  const actions = [];
  let request = null;
  let command = null;
  switch (s.view) {
    case 'pairing': {
      const p = s.pendingPair || {};
      request = p.request || null;
      command = p.command || null;
      lines.push(`This desktop: ${p.deviceFingerprint}`);
      if (p.service) lines.push(`Service: ${p.service.fingerprint} (port ${p.service.port})`);
      else if (p.error && p.error.code === 'BRIDGE_FILE_UNTRUSTED') lines.push(p.error.error);
      else lines.push('Waiting for the service… run the command below as an administrator.');
      lines.push('Compare both fingerprints with what the command printed before you confirm.');
      actions.push({ id: 'pairConfirm', label: 'Confirm', disabled: !p.service }, { id: 'pairCancel', label: 'Cancel' });
      break;
    }
    case 'paired':
      lines.push(...serviceLines(s));
      actions.push({ id: 'import', label: 'Import…' }, { id: 'attach', label: 'Attach' }, { id: 'unpair', label: 'Unpair' });
      break;
    case 'attached-connected':
      lines.push(...serviceLines(s));
      lines.push('Chats made while attached live in the service.');
      actions.push({ id: 'import', label: 'Import…' }, { id: 'detach', label: 'Detach' }, { id: 'unpair', label: 'Unpair' });
      break;
    case 'attached-disconnected': {
      const c = s.connection || {};
      lines.push(c.error || MESSAGES.SERVICE_UNREACHABLE(18796));
      if (c.nextRetryAt) lines.push(`Next retry at ${new Date(c.nextRetryAt).toLocaleTimeString()}.`);
      actions.push({ id: 'retry', label: 'Retry now' }, { id: 'standaloneOnce', label: 'Use standalone this time' }, { id: 'detach', label: 'Detach' });
      break;
    }
    default: {
      const b = s.bridge || {};
      if (b.ok) lines.push('A local King Louie service is installed on this computer.');
      else if (b.code === 'BRIDGE_FILE_UNTRUSTED' && b.error) lines.push(b.error);
      else lines.push(b.error || `No local service found at ${dirOf(s.bridgeFile)}.`);
      lines.push(INSTALL_HINT);
      actions.push({ id: 'pair', label: 'Pair' });
    }
  }
  return { view: s.view || 'unpaired', lines, actions, request, command, detachWarning: s.detachWarning || null, approvals: describeApprovals(s) };
}

function describeImportReport(report = {}) {
  const lines = [];
  const counts = report.counts || {};
  lines.push(Object.entries(counts).filter(([, n]) => n).map(([action, n]) => `${action}: ${n}`).join(', '));
  for (const f of report.failures || []) lines.push(`Failed: ${f.category} ${f.key} — ${f.error}`);
  for (const f of report.sendFailures || []) lines.push(`Not sent: ${f.category} ${f.key} — ${f.error}`);
  for (const s of report.skipped || []) lines.push(`Not read: ${s.category} ${s.key} — ${s.error}`);
  if ((report.secretsMissing || []).length) lines.push(`Secrets that did not arrive: ${report.secretsMissing.map((s) => `${s.category} ${s.key}`).join(', ')}`);
  for (const a of report.attention || []) lines.push(`Needs attention: ${a.category} ${a.key} — ${a.note}`);
  for (const note of report.notes || []) lines.push(note);
  return lines;
}

module.exports = { describeServicePane, describeApprovals, describeImportReport, UNAVAILABLE_TAB_NOTICE };
```

In `preload.js`, after the line `const markdownLog = createLogger('markdown');` add:

```js
// Settings > Local service wording (pure module); optional like the other
// bundled requires, so a blocked require never aborts the preload.
let paneModel = null;
try {
  paneModel = require('./src/desktop-bridge/pane-model');
} catch {
  paneModel = null;
}
```

and insert before the line `    markdown: {`:

```js
    desktop: {
      status: () => ipcRenderer.invoke('desktop:status'),
      pairStart: () => ipcRenderer.invoke('desktop:pairStart'),
      pairConfirm: () => ipcRenderer.invoke('desktop:pairConfirm'),
      pairCancel: () => ipcRenderer.invoke('desktop:pairCancel'),
      attach: () => ipcRenderer.invoke('desktop:attach'),
      detach: (payload = {}) => ipcRenderer.invoke('desktop:detach', { confirmed: Boolean(payload && payload.confirmed === true) }),
      standaloneOnce: () => ipcRenderer.invoke('desktop:standaloneOnce'),
      unpair: () => ipcRenderer.invoke('desktop:unpair'),
      retry: () => ipcRenderer.invoke('desktop:retry'),
      importPlan: () => ipcRenderer.invoke('desktop:importPlan'),
      importApply: () => ipcRenderer.invoke('desktop:importApply'),
      onStatusChanged: (callback) => registerOnce('desktop:statusChanged', callback),
      onImportProgress: (callback) => registerOnce('desktop:importProgress', callback),
      describe: (status) => (paneModel ? paneModel.describeServicePane(status) : null),
      describeImport: (report) => (paneModel ? paneModel.describeImportReport(report) : [])
    },
```

In `index.html`, after `          <option value="commands">Commands</option>` add:

```html
          <option value="service">Local service</option>
```

and before `        <!-- Tab: Commands -->` add:

```html
        <!-- Tab: Local service (fleet stage 7) -->
        <div class="settings-tab-content" data-tab="service">
          <section class="template-variables-card service-pane" id="service-pane">
            <h3>Local service</h3>
            <p>Use this app as the window onto a King Louie service running on this computer.</p>
            <div class="service-pane-status" id="service-pane-status"></div>
            <div class="service-pane-request" id="service-pane-request" hidden>
              <label for="service-pair-request">Pairing request</label>
              <div class="service-pane-row">
                <code id="service-pair-request"></code>
                <button class="btn btn-secondary btn-sm" id="service-copy-request-btn" type="button">Copy</button>
              </div>
              <label for="service-pair-command">Run as an administrator</label>
              <code id="service-pair-command"></code>
            </div>
            <div class="service-pane-actions" id="service-pane-actions"></div>
            <div class="service-pane-import" id="service-pane-import" hidden></div>
            <div class="service-pane-approvals" id="service-pane-approvals" hidden></div>
          </section>
        </div>

```

In `renderer.js`, inside `function switchSettingsTab(tabName) {`, after the block

```js
  if (tabName === 'channels' && typeof loadChannelAccess === 'function') {
    loadChannelAccess().catch(() => {});
  }
```

add:

```js
  if (tabName === 'service' && typeof renderServiceSection === 'function') {
    renderServiceSection().catch(() => {});
  }
```

Append at the end of `renderer.js` (after `checkFirstRun();`):

```js

// ── Settings > Local service (fleet stage 7) ──────────────────────────────
const servicePaneState = { detachArmed: false, busy: false, error: null };
let serviceLastConnection = null;

function serviceLinesInto(el, lines) {
  el.innerHTML = '';
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    el.appendChild(p);
  }
}

async function renderServiceSection() {
  const statusEl = document.getElementById('service-pane-status');
  if (!statusEl || !window.electron.desktop) return;
  const status = await window.electron.desktop.status();
  if (!status || status.ok === false) {
    serviceLinesInto(statusEl, [(status && status.error) || 'The local service pane is not available.']);
    return;
  }
  const model = window.electron.desktop.describe(status);
  if (!model) return;
  const lines = [...model.lines];
  if (servicePaneState.error) lines.push(servicePaneState.error);
  if (servicePaneState.detachArmed && model.detachWarning) lines.push(model.detachWarning);
  serviceLinesInto(statusEl, lines);

  const requestBox = document.getElementById('service-pane-request');
  requestBox.hidden = !model.request;
  if (model.request) {
    document.getElementById('service-pair-request').textContent = model.request;
    document.getElementById('service-pair-command').textContent = model.command || '';
    const copyBtn = document.getElementById('service-copy-request-btn');
    copyBtn.onclick = () => navigator.clipboard.writeText(model.request).catch(() => {});
  }

  const actionsEl = document.getElementById('service-pane-actions');
  actionsEl.innerHTML = '';
  for (const action of model.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `service-action-${action.id}`;
    btn.className = action.id === 'detach' || action.id === 'unpair' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
    btn.textContent = action.id === 'detach' && servicePaneState.detachArmed ? 'Detach anyway' : action.label;
    btn.disabled = Boolean(action.disabled) || servicePaneState.busy;
    btn.addEventListener('click', () => { runServiceAction(action.id).catch(() => {}); });
    actionsEl.appendChild(btn);
  }

  const approvalsEl = document.getElementById('service-pane-approvals');
  approvalsEl.hidden = !model.approvals;
  if (model.approvals) {
    serviceLinesInto(approvalsEl, ['Approvals and relay', ...model.approvals.lines, `Change them on the service: ${model.approvals.commands.join(', ')}`]);
  }
  markUnavailableTabs(status.unavailableTabs || []);
}

function renderImportPlan(result) {
  const box = document.getElementById('service-pane-import');
  if (!box) return;
  box.hidden = false;
  const counts = Object.entries(result.plan.counts || {}).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ');
  const notes = result.plan.items.filter((i) => i.action === 'needs-attention' || i.action === 'needs-desktop').map((i) => `${i.action}: ${i.category} ${i.key}${i.note ? ` — ${i.note}` : ''}`);
  serviceLinesInto(box, [`Dry run — ${counts}`, ...notes, ...(result.attention || []).map((a) => `needs-attention: ${a.key} — ${a.note}`)]);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.id = 'service-action-importApply';
  apply.className = 'btn btn-primary btn-sm';
  apply.textContent = 'Import';
  apply.addEventListener('click', () => { runServiceAction('importApply').catch(() => {}); });
  box.appendChild(apply);
}

function renderImportReport(report) {
  const box = document.getElementById('service-pane-import');
  if (!box) return;
  box.hidden = false;
  serviceLinesInto(box, ['Import finished', ...window.electron.desktop.describeImport(report)]);
}

async function runServiceAction(id) {
  const desktop = window.electron.desktop;
  servicePaneState.busy = true;
  servicePaneState.error = null;
  try {
    let result = null;
    if (id === 'pair') result = await desktop.pairStart();
    else if (id === 'pairConfirm') result = await desktop.pairConfirm();
    else if (id === 'pairCancel') result = await desktop.pairCancel();
    else if (id === 'attach') result = await desktop.attach();
    else if (id === 'standaloneOnce') result = await desktop.standaloneOnce();
    else if (id === 'retry') result = await desktop.retry();
    else if (id === 'unpair') result = await desktop.unpair();
    else if (id === 'detach') {
      if (!servicePaneState.detachArmed) {
        servicePaneState.detachArmed = true;
      } else {
        servicePaneState.detachArmed = false;
        result = await desktop.detach({ confirmed: true });
      }
    } else if (id === 'import') {
      result = await desktop.importPlan();
      if (result && result.ok) renderImportPlan(result);
    } else if (id === 'importApply') {
      result = await desktop.importApply();
      if (result && result.ok) renderImportReport(result.report);
    }
    if (result && result.ok === false) servicePaneState.error = result.error || result.code;
  } finally {
    servicePaneState.busy = false;
    await renderServiceSection().catch(() => {});
  }
}

function markUnavailableTabs(tabs = []) {
  const unavailable = new Set(tabs);
  document.querySelectorAll('.settings-tab-content').forEach((pane) => {
    const existing = pane.querySelector(':scope > .service-unavailable-notice');
    if (unavailable.has(pane.dataset.tab)) {
      if (!existing) {
        const note = document.createElement('div');
        note.className = 'settings-alert service-unavailable-notice';
        note.textContent = 'Managed by the local service; not available while attached.';
        pane.prepend(note);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

function renderAttachedBanner(status) {
  let banner = document.getElementById('attached-service-banner');
  const show = status && status.view === 'attached-disconnected';
  if (!show) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'attached-service-banner';
    banner.className = 'settings-alert attached-service-banner';
    const host = dom.chatMessages && dom.chatMessages.parentElement ? dom.chatMessages.parentElement : document.body;
    host.prepend(banner);
  }
  banner.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = (status.connection && status.connection.error) || 'The local King Louie service is not reachable.';
  banner.appendChild(text);
  const buttons = [
    ['Retry now', () => window.electron.desktop.retry()],
    ['Use standalone this time', () => window.electron.desktop.standaloneOnce()],
    ['Local service settings', () => { document.getElementById('open-settings-btn')?.click(); switchSettingsTab('service'); }]
  ];
  for (const [label, fn] of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = label;
    btn.addEventListener('click', () => { Promise.resolve(fn()).catch(() => {}); });
    banner.appendChild(btn);
  }
}

async function refreshServiceStatus() {
  const status = await window.electron.desktop.status().catch(() => null);
  if (!status || status.ok === false) return;
  markUnavailableTabs(status.unavailableTabs || []);
  renderAttachedBanner(status);
  const conn = status.connection ? status.connection.status : null;
  if (conn === 'connected' && serviceLastConnection && serviceLastConnection !== 'connected') loadChats();
  serviceLastConnection = conn;
  if (dom.settingsNavSelect && dom.settingsNavSelect.value === 'service') renderServiceSection().catch(() => {});
}

if (window.electron.desktop) {
  unsubscribeHandlers.push(window.electron.desktop.onStatusChanged(() => { refreshServiceStatus().catch(() => {}); }));
  unsubscribeHandlers.push(window.electron.desktop.onImportProgress(({ sent, total } = {}) => {
    const box = document.getElementById('service-pane-import');
    if (box) box.dataset.progress = `${sent}/${total}`;
  }));
  refreshServiceStatus().catch(() => {});
}
```

Append to `styles.css`:

```css

/* Settings > Local service (fleet stage 7) */
.service-pane .service-pane-status p,
.service-pane .service-pane-import p,
.service-pane .service-pane-approvals p {
  margin: 0 0 6px;
}

.service-pane .service-pane-request {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
}

.service-pane .service-pane-request code {
  word-break: break-all;
  user-select: all;
}

.service-pane .service-pane-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.service-pane .service-pane-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.service-pane .service-pane-import,
.service-pane .service-pane-approvals {
  margin-top: 12px;
}

.attached-service-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-pane.test.js tests/preload-bridge.test.js tests/preload-validation.test.js tests/ipc-contract.test.js tests/syntax-highlighting.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/pane-model.js preload.js index.html renderer.js styles.css tests/desktop-pane.test.js
git commit -m "feat(ui): Settings > Local service pane, unavailable-tab notices and banner

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Isolated Playwright `_electron` e2e harness and the attached-mode e2e

**Files:**
- Modify: `tests/e2e/helpers.js` (rewritten)
- Create: `tests/e2e/_attach-service.js`, `tests/e2e/attached-mode.test.js`
- Delete: `tests/e2e/_bridge.js`
- Modify: `main.js` — remove the block starting `  // E2E test bridge (removed with the Playwright harness in fleet stage 7 Task 17).` (4 lines)
- Test: `tests/e2e-harness.test.js` (unit, runs under `npm test`)

**Interfaces:**
- Consumes: `_electron` (`playwright`), `require('electron')` (the binary path), Part 2's `runDesktopCommand`, `runService`, `bridgeFileRecord`, `writeFileAtomic`, `ProviderFactory.registerProvider`, `toolRegistry`, `addSink`.
- Produces (`tests/e2e/helpers.js`): `launchApp({ userDataDir, seed, env, args }) → ctx` (asserts `app.getPath('userData')` is the temp dir, else throws `userData isolation failed`; default seed marks onboarding complete), `relaunchApp(ctx, { args }) → ctx`, `launchAttached(opts) → ctx` (with `ctx.service`), `startTestService({ root }) → service` (`{ dataDir, configDir, bridgeFile, port, pair(request), stop(), kill(), restart() }`), `closeApp(ctx)`, `evaluate(ctx, code)`, `waitFor(ctx, code, timeoutMs)`, `click`, `fill`, `getText`, `getValue`, `isVisible`, `count`, `childEnv(extra)`, `writeSeed(dir, seed)`, `APP_PATH`. Every existing helper keeps its signature.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e-harness.test.js`:

```js
// tests/e2e-harness.test.js — unit checks of the e2e harness (no Electron launched).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const helpers = require('./e2e/helpers');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('e2e harness', () => {
  it('exports the harness API', () => {
    for (const name of ['launchApp', 'relaunchApp', 'launchAttached', 'startTestService', 'closeApp', 'evaluate', 'waitFor', 'click', 'fill', 'getText', 'getValue', 'isVisible', 'count', 'childEnv', 'writeSeed', 'APP_PATH']) {
      assert.ok(name in helpers, name);
    }
  });

  it('removes ELECTRON_RUN_AS_NODE entirely and sets KL_TEST_MODE', () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '';
    try {
      const env = helpers.childEnv({ EXTRA: 'x' });
      assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
      assert.strictEqual(env.KL_TEST_MODE, '1');
      assert.strictEqual(env.EXTRA, 'x');
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  it('writes seed files, JSON or text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-seed-'));
    dirs.push(dir);
    helpers.writeSeed(dir, { 'chat-data.json': { onboardingComplete: true }, 'notes/a.txt': 'hello' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')), { onboardingComplete: true });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes', 'a.txt'), 'utf8'), 'hello');
  });

  it('the old HTTP test bridge is gone', () => {
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'tests', 'e2e', '_bridge.js')), false);
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(!main.includes('KL_TEST_BRIDGE_PORT'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/e2e-harness.test.js`
Expected: FAIL — `relaunchApp` (and the other new names) missing from the exports, and "the old HTTP test bridge is gone" failing.

- [ ] **Step 3: Implement**

Delete `tests/e2e/_bridge.js` (`git rm tests/e2e/_bridge.js`). In `main.js` remove:

```js
  // E2E test bridge (removed with the Playwright harness in fleet stage 7 Task 17).
  if (process.env.KL_TEST_BRIDGE_PORT) {
    require(process.env.KL_TEST_BRIDGE_SCRIPT || path.join(__dirname, 'tests', 'e2e', '_bridge.js'));
  }

```

Replace the whole of `tests/e2e/helpers.js` with:

```js
/**
 * E2E harness for King Louie (fleet stage 7, program ruling 9).
 *
 * Every launch gets its own --user-data-dir, so no test touches the real
 * profile, chats, settings or vault. The app is driven through Playwright's
 * _electron. ELECTRON_RUN_AS_NODE is deleted from the child's environment
 * (an empty value still makes Electron run as plain Node).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { _electron } = require('playwright');

const APP_PATH = path.resolve(__dirname, '..', '..');
const DEFAULT_SEED = Object.freeze({ 'chat-data.json': { onboardingComplete: true } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra, KL_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function writeSeed(dir, seed) {
  for (const [rel, content] of Object.entries(seed || {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const realpath = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};

/**
 * Launch King Louie on an isolated profile. `seed` (default: onboarding
 * complete) is written into the profile first; `seed: null` writes nothing.
 */
async function launchApp(opts = {}) {
  const ownsDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-'));
  if (opts.seed !== null) writeSeed(userDataDir, opts.seed === undefined ? DEFAULT_SEED : opts.seed);
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [APP_PATH, `--user-data-dir=${userDataDir}`, ...(opts.args || [])],
    env: childEnv(opts.env)
  });
  const ctx = { electronApp, userDataDir, ownsDir, extraDirs: [], service: null, closed: false, stdout: '', relaunchRequested: false, launchOpts: opts };
  const proc = electronApp.process();
  if (proc.stdout) {
    proc.stdout.on('data', (d) => {
      ctx.stdout += d.toString();
      if (ctx.stdout.includes('KL_RELAUNCH_REQUESTED')) ctx.relaunchRequested = true;
    });
  }
  const actual = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  if (realpath(actual) !== realpath(userDataDir)) {
    await electronApp.close().catch(() => {});
    throw new Error(`userData isolation failed: the app uses ${actual}, not ${userDataDir}`);
  }
  await electronApp.firstWindow();
  await waitFor(ctx, `!!document.getElementById('user-input')`, 20000);
  return ctx;
}

/** After the app printed KL_RELAUNCH_REQUESTED and quit, start it again on the same profile. */
async function relaunchApp(ctx, { args } = {}) {
  const start = Date.now();
  while (!ctx.relaunchRequested) {
    if (Date.now() - start > 20000) throw new Error('the app never asked to relaunch');
    await delay(100);
  }
  const proc = ctx.electronApp.process();
  if (proc.exitCode === null) await Promise.race([new Promise((r) => proc.once('exit', r)), delay(10000)]);
  ctx.closed = true;
  const next = await launchApp({ ...ctx.launchOpts, userDataDir: ctx.userDataDir, seed: null, args: args || ctx.launchOpts.args });
  next.ownsDir = ctx.ownsDir;
  next.extraDirs = ctx.extraDirs;
  next.service = ctx.service;
  return next;
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code) || attempt === 4) throw err;
      await delay(200);
    }
  }
}

/** Close the app, stop any test service, remove the temp dirs. */
async function closeApp(ctx) {
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  await Promise.race([ctx.electronApp.close().catch(() => {}), delay(5000)]);
  try { ctx.electronApp.process().kill(); } catch { /* already gone */ }
  if (ctx.service) await ctx.service.stop().catch(() => {});
  for (const dir of [ctx.ownsDir ? ctx.userDataDir : null, ...ctx.extraDirs].filter(Boolean)) await removeDir(dir);
}

/** Evaluate JavaScript in the renderer (user-gesture semantics kept) and return the result. */
async function evaluate(ctx, code) {
  return ctx.electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    return win.webContents.executeJavaScript(source, true);
  }, code);
}

async function waitFor(ctx, code, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await evaluate(ctx, code);
      if (result) return result;
    } catch { /* may fail during load */ }
    await delay(300);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${code}`);
}

async function click(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()
  `);
}

async function fill(ctx, selector, value) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

async function getText(ctx, selector) {
  return evaluate(ctx, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`);
}

async function getValue(ctx, selector) {
  return evaluate(ctx, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; })()`);
}

async function isVisible(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    })()
  `);
}

async function count(ctx, selector) {
  return evaluate(ctx, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

/**
 * A real king-louie-service (agent profile) in a child process, with a stub
 * provider and a gated probe tool, on a temporary data dir and config dir.
 * `features.desktopBridge: true`, `ports.desktopBridge: 0`; the bound port is
 * written into the temp desktop-bridge.json (tests only).
 */
async function startTestService({ root }) {
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  const serviceJson = path.join(configDir, 'service.json');
  if (!fs.existsSync(serviceJson)) {
    fs.writeFileSync(serviceJson, JSON.stringify({ features: { desktopBridge: true }, ports: { desktopBridge: 0 } }, null, 2), { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(serviceJson, 0o644);
  }
  const bridgeFile = path.join(configDir, 'desktop-bridge.json');
  const child = fork(path.join(__dirname, '_attach-service.js'), ['--data-dir', dataDir], { silent: true, env: { ...process.env, KL_TEST_MODE: '1' } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`the test service did not start. stderr: ${stderr.slice(0, 800)}`)), 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('KL_ATTACH_SERVICE '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('KL_ATTACH_SERVICE '.length))); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the test service exited with ${code}. stderr: ${stderr.slice(0, 800)}`)); });
  });
  const writePort = () => {
    const record = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    fs.writeFileSync(bridgeFile, JSON.stringify({ ...record, port: info.port }, null, 2), { mode: 0o644 });
  };
  const service = {
    root, dataDir, configDir, bridgeFile, port: info.port, child,
    // What an administrator runs; then the test port goes back into the file.
    async pair(request) {
      const { runDesktopCommand } = require('../../src/service/commands/desktop');
      const out = { stdout: '', stderr: '' };
      const code = await runDesktopCommand({
        sub: 'pair', arg: request, dataDir,
        io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } },
        deps: { isAdmin: () => true, configDir, runningServicePid: () => child.pid, withServiceCore: () => { throw new Error('the service is running'); }, applyWindowsAcls: () => {} }
      });
      if (code !== 0) throw new Error(`desktop pair failed (${code}): ${out.stderr}`);
      writePort();
      return out.stdout;
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({ type: 'shutdown' });
      await Promise.race([exited, delay(10000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
    kill() {
      child.kill('SIGKILL');
      return new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    },
    async restart() {
      await service.stop();
      return startTestService({ root });
    }
  };
  return service;
}

/**
 * Launch the app attached to a temporary service: pair through the UI, run
 * the admin command in-process, confirm, attach, relaunch.
 */
async function launchAttached(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-svc-'));
  const service = await startTestService({ root });
  let ctx = await launchApp({ ...opts, env: { ...(opts.env || {}), KL_DESKTOP_BRIDGE_FILE: service.bridgeFile } });
  ctx.extraDirs.push(root);
  ctx.service = service;
  await click(ctx, '#open-settings-btn');
  await evaluate(ctx, `switchSettingsTab('service'); true`);
  await waitFor(ctx, `!!document.getElementById('service-action-pair')`, 15000);
  await click(ctx, '#service-action-pair');
  const request = await waitFor(ctx, `document.getElementById('service-pair-request')?.textContent || ''`, 15000);
  await service.pair(request);
  await waitFor(ctx, `(() => { const b = document.getElementById('service-action-pairConfirm'); return b && !b.disabled; })()`, 15000);
  await click(ctx, '#service-action-pairConfirm');
  await waitFor(ctx, `!!document.getElementById('service-action-attach')`, 20000);
  await click(ctx, '#service-action-attach');
  ctx = await relaunchApp(ctx);
  await waitFor(ctx, `window.electron.desktop.status().then((s) => s.view === 'attached-connected')`, 30000);
  return ctx;
}

module.exports = {
  launchApp,
  relaunchApp,
  launchAttached,
  startTestService,
  closeApp,
  evaluate,
  waitFor,
  click,
  fill,
  getText,
  getValue,
  isVisible,
  count,
  childEnv,
  writeSeed,
  APP_PATH
};
```

Create `tests/e2e/_attach-service.js`:

```js
// Test-only service host for tests/e2e (fleet stage 7): a stub provider, a
// gated probe tool and runService, with the bound bridge port written into
// the temp desktop-bridge.json. Never used outside the e2e suite.
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const ProviderFactory = require('../../src/providers/provider-factory');
const { buildServicePorts } = require('../../src/service/ports');
const { createCore } = require('../../src/core');
const { CHAT_DATA_DEFAULTS } = require('../../src/core/settings');
const { runService } = require('../../src/service/run');
const { Tool } = require('../../src/tools/tool-schema');
const { toolRegistry } = require('../../src/tools');
const { addSink } = require('../../src/logging');
const { bridgeFileRecord, writeFileAtomic } = require('../../src/desktop-bridge/pairing');

const dataDir = path.resolve(process.argv[process.argv.indexOf('--data-dir') + 1]);
const configDir = path.join(path.dirname(dataDir), 'config');
const PROBE = 'KlE2eGatedProbe';

// Registered as `openai`: the chat send path accepts only openai/anthropic/gemini types.
class StubProvider {
  async sendMessage() { return 'Stub chat'; }
  async streamMessage(_messages, _options, onChunk) {
    const text = 'Hello from the stub provider.';
    for (const word of text.split(' ')) onChunk(`${word} `);
    return { content: text, llmMetrics: null };
  }
  async sendMessageWithTools(messages) {
    if (Array.isArray(messages) && messages.some((m) => m && m.role === 'tool')) return { type: 'text', content: 'The probe ran.' };
    return { type: 'tool_use', toolName: PROBE, toolUseId: 'call_1', parameters: {} };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}
ProviderFactory.registerProvider('openai', StubProvider);

// Seed the provider settings through the stores, before the service opens them.
const seed = createCore(buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS }));
const tiers = { provider: 'openai', model: 'stub' };
const settings = seed.getSettings();
seed.context.setSettings({ ...settings, activeProvider: 'openai', inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } } });
seed.saveProviderToken('openai', 'sk-e2e-stub-token');

let boundPort = null;
addSink((record) => {
  const m = /desktop bridge listening on 127\.0\.0\.1:(\d+)/.exec(record.message);
  if (m) boundPort = Number(m[1]);
});

const watcher = new Writable({
  write(chunk, _enc, done) {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes('"event":"ready"')) {
      toolRegistry.register(new Tool({
        name: PROBE,
        description: 'E2E-only tool that requires approval.',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: async () => ({ ok: true, ran: true })
      }));
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
      const record = bridgeFileRecord({ publicKey: data.mesh.identity.publicKey, port: boundPort });
      writeFileAtomic(path.join(configDir, 'desktop-bridge.json'), `${JSON.stringify(record, null, 2)}\n`, 0o644);
      process.stdout.write(`KL_ATTACH_SERVICE ${JSON.stringify({ port: boundPort })}\n`);
    }
    done();
  }
});

runService({ dataDir, profile: 'agent', stdout: watcher, adminUid: typeof process.getuid === 'function' ? process.getuid() : undefined })
  .then(() => process.exit(0))
  .catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
```

Create `tests/e2e/attached-mode.test.js`:

```js
// tests/e2e/attached-mode.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/attached-mode.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchAttached, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: attached mode', { timeout: 240000 }, () => {
  let ctx;

  before(async () => {
    ctx = await launchAttached();
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('streams a chat from the stub provider through the service', async () => {
    const chatId = await evaluate(ctx, `window.electron.chat.create('Attached chat').then((r) => (r.data || r).id)`);
    const reply = await evaluate(ctx, `window.electron.chat.sendMessage({ chatId: ${JSON.stringify(chatId)}, message: 'hello' }).then((r) => JSON.stringify(r))`);
    assert.match(reply, /Hello from the stub provider\./);
  });

  it('shows the approval dialog for a gated tool and runs it on approve', async () => {
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `!!appState.activeChatId`);
    await evaluate(ctx, `window.__probe = window.electron.chat.sendMessage({ chatId: appState.activeChatId, message: 'run the probe', agentMode: true }); true`);
    await waitFor(ctx, `!!document.querySelector('.prompt-message .prompt-actions .btn-primary')`, 30000);
    await click(ctx, '.prompt-message .prompt-actions .btn-primary');
    const reply = await evaluate(ctx, `window.__probe.then((r) => JSON.stringify(r))`);
    assert.match(reply, /The probe ran\./);
  });

  it('marks an unproxied settings tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); switchSettingsTab('hooks'); true`);
    const text = await waitFor(ctx, `document.querySelector('.settings-tab-content[data-tab="hooks"] .service-unavailable-notice')?.textContent`);
    assert.strictEqual(text, 'Managed by the local service; not available while attached.');
  });

  it('shows the unreachable banner when the service dies and reconnects after a restart', async () => {
    await ctx.service.kill();
    const banner = await waitFor(ctx, `document.getElementById('attached-service-banner')?.textContent || ''`, 30000);
    assert.match(banner, /not reachable/);
    ctx.service = await ctx.service.restart();
    await evaluate(ctx, `window.electron.desktop.retry(); true`);
    await waitFor(ctx, `window.electron.desktop.status().then((s) => s.view === 'attached-connected')`, 60000);
    await waitFor(ctx, `!document.getElementById('attached-service-banner')`, 10000);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/e2e-harness.test.js`
Expected: PASS, `# fail 0`.

Run: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`
Expected: PASS, `# fail 0` for all 22 existing e2e files and `tests/e2e/attached-mode.test.js`. The old harness shared the real profile; if an existing file fails only because it expected data from that profile, give its `launchApp()` call a `seed` holding exactly that data, in this commit.

- [ ] **Step 5: Commit**

```bash
git rm tests/e2e/_bridge.js
git add tests/e2e/helpers.js tests/e2e/_attach-service.js tests/e2e/attached-mode.test.js tests/e2e-harness.test.js main.js
git commit -m "test(e2e): isolated Playwright _electron harness with launchAttached

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(Add any existing e2e file you gave a `seed` to the `git add` line.)

---

### Task 18: CLAUDE.md section and final verification

**Files:**
- Modify: `CLAUDE.md` — the paragraph starting `` `npm run test:e2e` launches the real Electron binary (`tests/e2e/helpers.js`), `` (through `shell:`); append an `## Attached mode` section at the end of the file
- Test: the whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Write the failing test**

There is no new unit test; this task's check is the full suite plus the personal-value scan in Step 4. Confirm the docs are still stale first:

Run: `grep -n "passes \`process.env\` through" CLAUDE.md`
Expected: one match (line 24) — the paragraph ruling 9 corrects.

- [ ] **Step 2: Run it to verify it fails**

Run: `grep -c "## Attached mode" CLAUDE.md`
Expected: `0`.

- [ ] **Step 3: Implement**

In `CLAUDE.md`, replace:

```markdown
`npm run test:e2e` launches the real Electron binary (`tests/e2e/helpers.js`),
so it needs `ELECTRON_RUN_AS_NODE` actually gone from the environment, not set
to an empty string — `tests/e2e/helpers.js` passes `process.env` through
unfiltered, and Electron treats an empty value the same as `1`. From an agent
shell:
```

with:

```markdown
`npm run test:e2e` launches the real Electron binary through Playwright's
`_electron` (`tests/e2e/helpers.js`). Every launch gets its own temporary
`--user-data-dir` (the helper throws `userData isolation failed` otherwise), so
e2e tests never touch the real profile; give `launchApp({ seed })` any files a
test needs. The helper deletes `ELECTRON_RUN_AS_NODE` from the child's env
(Electron treats an empty value the same as `1`); unset it in the shell too:
```

Append at the end of `CLAUDE.md`:

```markdown

## Attached mode

The desktop app can be a window onto a local `king-louie-service` (fleet stage 7,
spec `docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md`). The service
opens a loopback desktop bridge (`127.0.0.1:18796`, `features.desktopBridge` in
`<configDir>/service.json`); in attached mode `main.js` builds no core and
`src/ipc/attached-host.js` proxies the allowlisted channels
(`src/desktop-bridge/allowlist.js`; a stage whose domain must work while attached
appends it to `PROXIED_DOMAINS`).

- Pair from Settings > Local service, then run the command it shows as
  root/Administrator: `king-louie-service desktop pair <request>`. Also
  `desktop unpair <device-id>`, `desktop list`, and
  `import --from <desktop userData> [--dry-run]` (service stopped; secrets only
  arrive through the desktop's own Import).
- `--kl-standalone-once` runs one standalone session without changing the mode.
- Only events marked by `markLocalDesktopEvent` (the standalone host's ipcMain
  wrapper and the bridge dispatcher; `src/core/origin.js`) get the on-screen
  approval dialog in the service.
- E2E: `launchAttached()` in `tests/e2e/helpers.js` starts a temporary service
  (`tests/e2e/_attach-service.js`, stub provider), pairs, attaches and relaunches;
  `ctx.service` has `kill()`, `restart()`, `stop()`.
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, `# fail 0`.

Run: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`
Expected: PASS, `# fail 0` (23 files: the 22 existing ones and `attached-mode.test.js`).

Run: `git diff main --stat` and then `git diff main | grep -niE "/home/[a-z]+/|/Users/[A-Za-z]+/|C:\\\\Users\\\\[A-Za-z]+" || echo clean`
Expected: `clean` — no personal names, machines, domains, paths or accounts in the diff (fixtures use `example.com`, `gpu-box`, `web-01`, `Lakeside lot`).

Run: `grep -rn "console\.\(log\|warn\|error\|info\|debug\)" src/desktop-bridge src/migration src/ipc/desktop-*.js src/ipc/attached-host.js src/ipc/standalone-host.js src/service/commands || echo clean`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: attached mode and the isolated e2e harness

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Stage 7 exports (after all three parts merge)

| Module | Exports added in Part 3 |
|---|---|
| `src/ipc/desktop-state.js` | `openDesktopState(userDataDir, safeStorage, { storeFactory, platform })`, `secureStorageUsable(safeStorage, platform)`, `MODES` |
| `src/ipc/desktop-export.js` | `loadDesktopSource`, `planImport`, `applyImport` |
| `src/ipc/desktop-controller.js` | `createDesktopController`, `DETACH_WARNING`, `STANDALONE_ONCE` |
| `src/ipc/attached-host.js` | `startAttachedHost` |
| `src/ipc/standalone-host.js` | `startStandaloneHost`, `markingIpcMain` |
| `src/desktop-bridge/pane-model.js` | `describeServicePane`, `describeApprovals`, `describeImportReport`, `UNAVAILABLE_TAB_NOTICE` |
| `src/cron/cron-scheduler.js` | `CronScheduler.prototype.pause()` |
| `preload.js` | `window.electron.desktop.{status, pairStart, pairConfirm, pairCancel, attach, detach, standaloneOnce, unpair, retry, importPlan, importApply, onStatusChanged, onImportProgress, describe, describeImport}` |
| `renderer.js` | `renderServiceSection()`, `markUnavailableTabs(tabs)`, `renderAttachedBanner(status)` |
| `tests/e2e/helpers.js` | `launchApp`, `relaunchApp`, `launchAttached`, `startTestService`, `closeApp`, `evaluate`, `waitFor`, `click`, `fill`, `getText`, `getValue`, `isVisible`, `count`, `childEnv`, `writeSeed`, `APP_PATH` |
