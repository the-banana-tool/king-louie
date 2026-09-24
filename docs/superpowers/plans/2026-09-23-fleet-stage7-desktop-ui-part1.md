# Fleet Stage 7: The desktop app as a window onto the local service — Implementation Plan (Part 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Electron-free core of the desktop bridge: desktop-origin marks and the approval seam, device keys and the pairing files, the channel allowlist and the `desktop:*` IPC channels, the loopback bridge server and client, and the desktop-scoped settings.
**Architecture:** New modules under `src/core/origin.js` and `src/desktop-bridge/` (`keys`, `protocol`, `pairing`, `allowlist`, `connection`, `bridge-server`, `bridge-client`, `desktop-scope`, `check-path`), `src/ipc/{channel-inventory,desktop-handlers}.js`, and additive hunks in `src/core/create-core.js`, `src/service/installers.js`, `src/ipc/{constants,register}.js`. The plan has three parts, numbered 1–18 throughout: Part 1 (Tasks 1–6, this file), Part 2 (`docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part2.md`, Tasks 7–11: dispatcher, import engine, CLI, service wiring) and Part 3 (`docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part3.md`, Tasks 12–18: Electron hosts, controller, settings pane, e2e harness, docs). Each part starts only after the previous one has merged.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `node:crypto` (Ed25519, SHA-256), `ws` (already a dependency). No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

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
- The bridge binds the literal `127.0.0.1` only, default port `18795` (`ports.desktopBridge` in `<configDir>/service.json`); `0` (ephemeral) is accepted for tests only. Upgrades carrying any `Origin` header get 403. HTTP header timeout 10000 ms.
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

---

### Task 1: Desktop origin marks and the approval seam

**Files:**
- Create: `src/core/origin.js` (replace it if F3 created it)
- Modify: `src/core/create-core.js` — only when `approvalSeam` is absent: after `const { withTimeout } = require('./with-timeout');`; the block starting `    // Every approval requester — gateway/channel approvalHandler, cron,` inside `createToolExecutorWithApprovals`; the line `      denyAutoApproval: remoteApprovals === 'deny',`
- Test: `tests/core-origin.test.js`

**Interfaces:**
- Consumes: `createCore(deps)` (`remoteApprovals: 'allow' | 'deny'`), `core.context.createToolExecutorWithApprovals(event, runtimeEnvironment, approvalRequester, executorOptions)`, `core.pendingApprovalResolvers`, `core.context.setToolAlwaysApprove`, `core.context.addPermissionRule`.
- Produces: `markLocalDesktopEvent(event, { deviceId = null } = {}) → event`, `isLocalDesktopEvent(event) → boolean`, `localDesktopDeviceId(event) → string | null`, `markLocalRequester(fn, { deviceId = null } = {}) → fn`, `isLocalRequester(fn) → boolean`. Seam: `local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester)`; `denyAutoApproval = (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true`; outside `'allow'` a requester is kept only when it is marked.

- [ ] **Step 1: Write the failing test**

Create `tests/core-origin.test.js`:

```js
// tests/core-origin.test.js
// Fleet stage 7 §3.5 / program §4.21: a local-desktop run (marked event or a
// marked parent requester) keeps the on-screen dialog, always-approve and
// `allow` rules in every remoteApprovals mode; everything else is remote.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const {
  markLocalDesktopEvent, isLocalDesktopEvent, localDesktopDeviceId, markLocalRequester, isLocalRequester
} = require('../src/core/origin');

const PROBE = 'KlTestOriginProbe';
let probeRuns = 0;
const cores = [];
const dirs = [];

before(() => {
  toolRegistry.register(new Tool({
    name: PROBE,
    description: 'Test-only tool that requires approval.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => { probeRuns += 1; return { ok: true }; }
  }));
});

after(async () => {
  for (const core of cores) await core.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function buildCore(remoteApprovals) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-origin-'));
  dirs.push(dataDir);
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals
  });
  cores.push(core);
  await core.start();
  return core;
}

function fakeSender() {
  const sent = [];
  return { sent, send: (channel, payload) => sent.push([channel, payload]), isDestroyed: () => false };
}

// Resolves with the approvalRequired payload once the sender gets one; cancel() stops polling.
function watchForPrompt(sender) {
  let timer = null;
  let stopped = false;
  const promise = new Promise((resolve) => {
    if (!sender) return;
    const tick = () => {
      if (stopped) return;
      const hit = sender.sent.find(([channel]) => channel === 'tool:approvalRequired');
      if (hit) resolve({ prompt: hit[1] });
      else timer = setTimeout(tick, 5);
    };
    tick();
  });
  return { promise, cancel: () => { stopped = true; clearTimeout(timer); } };
}

async function runProbe(core, { event = null, requester = null, options = {}, answer = true } = {}) {
  const executor = await core.context.createToolExecutorWithApprovals(event, null, requester, options);
  const before = probeRuns;
  const pending = executor.execute(PROBE, {});
  const watch = watchForPrompt(event && event.sender);
  const first = await Promise.race([pending.then((done) => ({ done })), watch.promise]);
  watch.cancel();
  let prompted = false;
  if (first.prompt) {
    prompted = true;
    core.pendingApprovalResolvers.get(first.prompt.approvalId).resolve(answer);
  }
  const result = first.done || await pending;
  return { result, prompted, ran: probeRuns > before };
}

describe('origin marks', () => {
  it('marks an event object, not a copy of its fields', () => {
    const event = markLocalDesktopEvent({ sender: fakeSender() }, { deviceId: 'kld-abcdefghijklmnop' });
    assert.strictEqual(isLocalDesktopEvent(event), true);
    assert.strictEqual(localDesktopDeviceId(event), 'kld-abcdefghijklmnop');
    assert.strictEqual(isLocalDesktopEvent({ ...event }), false);
    assert.strictEqual(localDesktopDeviceId({ ...event }), null);
    assert.strictEqual(isLocalDesktopEvent(null), false);
    assert.strictEqual(localDesktopDeviceId(markLocalDesktopEvent({})), null, 'the Electron host marks without a device id');
  });

  it('marks requester functions', () => {
    const fn = async () => true;
    assert.strictEqual(isLocalRequester(fn), false);
    assert.strictEqual(markLocalRequester(fn), fn);
    assert.strictEqual(isLocalRequester(fn), true);
    assert.strictEqual(isLocalRequester(async () => true), false);
    assert.strictEqual(isLocalRequester('not a function'), false);
  });

  it('is called only by the standalone wrapper and the bridge dispatcher', () => {
    const root = path.join(__dirname, '..');
    const allowed = new Set(['src/core/origin.js', 'src/ipc/standalone-host.js', 'src/desktop-bridge/bridge-dispatcher.js']);
    const callers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /markLocalDesktopEvent\(/.test(fs.readFileSync(full, 'utf8'))) {
          callers.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(root, 'src'));
    if (/markLocalDesktopEvent\(/.test(fs.readFileSync(path.join(root, 'main.js'), 'utf8'))) callers.push('main.js');
    assert.deepStrictEqual(callers.filter((f) => !allowed.has(f)), []);
  });
});

for (const mode of ['deny', 'allow']) {
  describe(`createToolExecutorWithApprovals, remoteApprovals '${mode}'`, () => {
    it('a marked event keeps the always-approve list', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }) });
      assert.strictEqual(out.prompted, false);
      assert.strictEqual(out.ran, true);
    });

    it('a marked event keeps `allow` rules', async () => {
      const core = await buildCore(mode);
      core.context.addPermissionRule({ tool: PROBE, pattern: '*', action: 'allow' });
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }) });
      assert.strictEqual(out.prompted, false);
      assert.strictEqual(out.ran, true);
    });

    it('a marked event without a grant gets approvalRequired on its sender', async () => {
      const core = await buildCore(mode);
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }), answer: true });
      assert.strictEqual(out.prompted, true);
      assert.strictEqual(out.ran, true);
    });

    it('executorOptions.denyAutoApproval demotes even a marked run', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const out = await runProbe(core, {
        event: markLocalDesktopEvent({ sender: fakeSender() }),
        options: { denyAutoApproval: true },
        answer: false
      });
      assert.strictEqual(out.prompted, true, 'the always-approve grant must not apply');
      assert.strictEqual(out.ran, false);
    });

    it('an unmarked copy of a marked event is treated as today', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const marked = markLocalDesktopEvent({ sender: fakeSender() });
      const out = await runProbe(core, { event: { sender: marked.sender }, answer: false });
      if (mode === 'deny') {
        assert.strictEqual(out.prompted, true, "'deny' demotes an unmarked run's always-approve grant");
        assert.strictEqual(out.ran, false);
      } else {
        assert.strictEqual(out.prompted, false, "'allow' keeps today's behaviour");
        assert.strictEqual(out.ran, true);
      }
    });

    it('a requester-only executor is local only when the requester is marked', async () => {
      const core = await buildCore(mode);
      let calls = 0;
      const plain = async () => { calls += 1; return true; };
      const plainOut = await runProbe(core, { requester: plain });
      if (mode === 'deny') {
        assert.strictEqual(calls, 0, "'deny' ignores an unmarked requester");
        assert.strictEqual(plainOut.ran, false);
      } else {
        assert.strictEqual(calls, 1);
        assert.strictEqual(plainOut.ran, true);
      }
      let parentCalls = 0;
      const parent = markLocalRequester(async () => { parentCalls += 1; return true; });
      const childOut = await runProbe(core, { requester: parent });
      assert.strictEqual(parentCalls, 1, "a child of a local run asks through the parent's dialog");
      assert.strictEqual(childOut.ran, true);
    });
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/core-origin.test.js`
Expected: FAIL with `Cannot find module '../src/core/origin'` (if F3 created the file first: failures under `'deny'` such as "a marked event keeps the always-approve list").

- [ ] **Step 3: Implement**

Create (or replace) `src/core/origin.js`:

```js
// Desktop origin marks (program §4.21, fleet stage 7 §3.5).
//
// The Electron host marks every IPC event before a handler sees it, and the
// desktop bridge marks the events it builds for a paired desktop. A run whose
// event is marked is a local desktop session: it keeps the on-screen approval,
// ask-user and directory dialogs. A ToolExecutor built for such a run (F3's
// `localOrigin`) marks the requester closure it hands to tools, so a child
// agent, which the core builds with event = null and the parent's requester,
// is local too.
//
// WeakMaps keyed on the objects themselves: a mark cannot be forged by copying
// fields into a payload, and nothing is kept alive by being marked. Only the
// standalone host's ipcMain wrapper and the bridge dispatcher call
// markLocalDesktopEvent (tests/core-origin.test.js pins that).
const localEvents = new WeakMap();
const localRequesters = new WeakMap();

function markLocalDesktopEvent(event, { deviceId = null } = {}) {
  if (event && typeof event === 'object') localEvents.set(event, { deviceId: deviceId || null });
  return event;
}

function isLocalDesktopEvent(event) {
  return Boolean(event) && typeof event === 'object' && localEvents.has(event);
}

// The kld- id for bridge events, null for the Electron host's own window.
function localDesktopDeviceId(event) {
  if (!isLocalDesktopEvent(event)) return null;
  return localEvents.get(event).deviceId;
}

function markLocalRequester(fn, { deviceId = null } = {}) {
  if (typeof fn === 'function') localRequesters.set(fn, { deviceId: deviceId || null });
  return fn;
}

function isLocalRequester(fn) {
  return typeof fn === 'function' && localRequesters.has(fn);
}

module.exports = {
  markLocalDesktopEvent,
  isLocalDesktopEvent,
  localDesktopDeviceId,
  markLocalRequester,
  isLocalRequester
};
```

Now run `grep -n "approvalSeam" src/core/create-core.js`. **If it prints a line**, F3's seam has merged and already contains `local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester)` and the `denyAutoApproval` rule; make no change to `create-core.js`. **Otherwise** make these three edits in `src/core/create-core.js`.

After the line `const { withTimeout } = require('./with-timeout');` add:

```js
const { isLocalDesktopEvent, isLocalRequester } = require('./origin');
```

Replace:

```js
    // Every approval requester — gateway/channel approvalHandler, cron,
    // webhook, mesh, and meta-tools re-threading a parent's requester — reaches
    // a ToolExecutor through here, so this is the single place that enforces
    // remoteApprovals: 'deny'.
    const effectiveApprovalRequester = remoteApprovals === 'deny' ? null : approvalRequester;
    if (approvalRequester && !effectiveApprovalRequester) {
      log.debug('remoteApprovals is "deny": ignoring a remote approval requester');
    }
```

with:

```js
    // Every approval requester — gateway/channel approvalHandler, cron,
    // webhook, mesh, and meta-tools re-threading a parent's requester — reaches
    // a ToolExecutor through here, so this is the single place that enforces
    // remoteApprovals (program §4.21). A local-desktop run (an event marked by
    // the Electron host or the desktop bridge, or a requester marked by a
    // local parent) keeps the on-screen dialog, the always-approve list and
    // `allow` rules in every mode; everything else is remote-origin.
    const local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester);
    const effectiveApprovalRequester = remoteApprovals === 'allow' || (local && isLocalRequester(approvalRequester))
      ? approvalRequester
      : null;
    if (approvalRequester && !effectiveApprovalRequester) {
      log.debug(`remoteApprovals is "${remoteApprovals}": ignoring a remote approval requester`);
    }
```

Replace the line:

```js
      denyAutoApproval: remoteApprovals === 'deny',
```

with:

```js
      denyAutoApproval: (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true,
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/core-origin.test.js tests/core-remote-approvals.test.js tests/core-create.test.js tests/tool-executor.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/origin.js src/core/create-core.js tests/core-origin.test.js
git commit -m "feat(core): desktop origin marks and the local-run approval seam

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(If `create-core.js` was left unchanged because F3's seam is present, drop it from `git add`.)

---

### Task 2: Keys, protocol constants and the pairing files

**Files:**
- Create: `src/desktop-bridge/keys.js`, `src/desktop-bridge/protocol.js`, `src/desktop-bridge/pairing.js`
- Modify: `src/service/installers.js` — the `module.exports = {` block at the end (add `WINDOWS_INSPECT_CSHARP`)
- Test: `tests/desktop-pairing.test.js`

**Interfaces:**
- Consumes: `base32Encode`, `deriveNodeId` (`src/mesh/node-identity.js`); `adminConfigDir`, `defaultServiceDataDir` (`src/platform/paths.js`); `windowsPowerShellExe` (`src/platform/windows-paths.js`); `WINDOWS_INSPECT_CSHARP` (`src/service/installers.js`); F3's `deriveDeviceId`/`ed25519RawToSpki` when `src/approvals/envelope.js` exists.
- Produces:
  - `keys.js`: `toB64url(bytes)`, `fromB64url(text) → Buffer` (strict), `deriveDeviceId(raw, prefix = 'd-')`, `ed25519RawToSpki(raw32) → Buffer`, `rawFromPublicKeyObject(keyObject) → Buffer(32)`, `verifyWithRawKey(raw32, message, sig) → boolean`, `verifyWithSpkiHex(hex, message, sig) → boolean`, `fingerprintGroups(id) → 'abcd efgh ijkl mnop'`.
  - `protocol.js`: `PROTOCOL = 1`, `DEFAULT_DESKTOP_BRIDGE_PORT = 18795`, `LIMITS`, `CLOSE`, `NODE_ID_RE`, `DEVICE_ID_RE`, `NONCE_RE`, `newNonce()`, `buildAuthS(fields)`, `buildAuthC(fields)`, `parseFrame(data, maxBytes) → { frame } | { error }`, `peekFrameId(text) → number | null`, `class BridgeError(code, message)`, `MESSAGES`.
  - `pairing.js`: `PAIR_PREFIX`, `DEVICES_FILE`, `BRIDGE_FILE`, `DEVICES_CONTROLS`, `ADMIN_OWNER_SIDS`, `class PairingError(code, message)`, `defaultDeviceLabel(username)`, `encodePairRequest({ publicKeyRaw, label }) → string`, `decodePairRequest(text) → { deviceId, publicKey, publicKeyRaw, label }`, `emptyDevices()`, `parseDevices(text)`, `validateDevices(doc)`, `upsertDevice(doc, device)`, `removeDevice(doc, deviceId) → { doc, removed }`, `findDevice(doc, deviceId)`, `bridgeFileRecord({ publicKey, port })`, `parseBridgeFile(text, file)`, `writeFileAtomic(file, text, mode)`, `bridgeFilePath({ env, platform })`, `inspectWindowsOwners(paths, { execFile, env }) → { me, entries: [{ owner, link } | null] }`, `checkBridgeFileTrust(file, opts) → { ok } | { ok:false, code, error }`, `readTrustedBridgeFile(file, opts) → { ok:true, record } | { ok:false, code, error }`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-pairing.test.js`:

```js
// tests/desktop-pairing.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { base32Encode, NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pairing-')); dirs.push(d); return d; };
const newRawKey = () => keys.rawFromPublicKeyObject(crypto.generateKeyPairSync('ed25519').publicKey);

describe('device keys', () => {
  it('derives kld- ids as base32(sha256(raw))[0..16]', () => {
    const raw = Buffer.alloc(32, 7);
    const expected = `kld-${base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16)}`;
    assert.strictEqual(keys.deriveDeviceId(raw, 'kld-'), expected);
    assert.match(expected, /^kld-[a-z2-7]{16}$/);
  });

  it("matches F3's device-id-ed25519 vector when it exists", (t) => {
    const file = path.join(__dirname, 'vectors', 'approval-v1', 'device-id-ed25519.json');
    if (!fs.existsSync(file)) { t.skip('fleet stage 3 vectors are not merged yet'); return; }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(doc) ? doc : (Array.isArray(doc.cases) ? doc.cases : [doc]);
    for (const e of entries) {
      assert.strictEqual(keys.deriveDeviceId(keys.fromB64url(e.input.raw), e.input.prefix), e.expect.device_id);
    }
  });

  it('converts a raw key to SPKI and verifies signatures', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = keys.rawFromPublicKeyObject(publicKey);
    assert.strictEqual(raw.length, 32);
    assert.deepStrictEqual(keys.ed25519RawToSpki(raw), publicKey.export({ type: 'spki', format: 'der' }));
    const sig = crypto.sign(null, Buffer.from('hello'), privateKey);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hello'), sig), true);
    assert.strictEqual(keys.verifyWithRawKey(raw, Buffer.from('hellO'), sig), false);
    assert.strictEqual(keys.verifyWithSpkiHex(keys.ed25519RawToSpki(raw).toString('hex'), Buffer.from('hello'), sig), true);
    assert.throws(() => keys.ed25519RawToSpki(Buffer.alloc(31)));
  });

  it('decodes base64url strictly and groups fingerprints', () => {
    assert.deepStrictEqual(keys.fromB64url('AQID'), Buffer.from([1, 2, 3]));
    assert.throws(() => keys.fromB64url('AQ+D'));
    assert.throws(() => keys.fromB64url('AQID='));
    assert.strictEqual(keys.fingerprintGroups('kld-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
    assert.strictEqual(keys.fingerprintGroups('kl-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
  });
});

describe('pairing request', () => {
  it('round-trips', () => {
    const raw = newRawKey();
    const text = pairing.encodePairRequest({ publicKeyRaw: raw, label: "owner's desktop" });
    assert.match(text, /^klpair1\.kld-[a-z2-7]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const req = pairing.decodePairRequest(text);
    assert.strictEqual(req.deviceId, keys.deriveDeviceId(raw, 'kld-'));
    assert.deepStrictEqual(req.publicKeyRaw, raw);
    assert.strictEqual(req.publicKey, keys.toB64url(raw));
    assert.strictEqual(req.label, "owner's desktop");
  });

  it('refuses a tampered id, a bad prefix, control characters and long labels', () => {
    const text = pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'desk' });
    const parts = text.split('.');
    const otherId = keys.deriveDeviceId(newRawKey(), 'kld-');
    assert.throws(() => pairing.decodePairRequest([parts[0], otherId, parts[2], parts[3]].join('.')), /does not match the public key/);
    assert.throws(() => pairing.decodePairRequest(['klpair2', ...parts.slice(1)].join('.')), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.decodePairRequest(`${text}.extra`), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.decodePairRequest([parts[0], parts[1], `${parts[2]}AA`, parts[3]].join('.')), (e) => e.code === 'MALFORMED_REQUEST');
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'bad\u0007label' }), /control characters/);
    assert.throws(() => pairing.encodePairRequest({ publicKeyRaw: newRawKey(), label: 'x'.repeat(65) }), /64 bytes/);
    const bell = [parts[0], parts[1], parts[2], keys.toB64url(Buffer.from('bad\u0007'))].join('.');
    assert.throws(() => pairing.decodePairRequest(bell), /control characters/);
  });

  it('builds a default label from the OS user', () => {
    assert.strictEqual(pairing.defaultDeviceLabel('alex'), "alex's desktop");
  });
});

describe('desktop-devices.json', () => {
  const device = () => {
    const raw = newRawKey();
    return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' };
  };

  it('upserts, finds and removes devices', () => {
    const a = device();
    const b = device();
    let doc = pairing.upsertDevice(pairing.emptyDevices(), a);
    doc = pairing.upsertDevice(doc, b);
    doc = pairing.upsertDevice(doc, { ...a, label: 'renamed' });
    assert.strictEqual(doc.devices.length, 2);
    assert.strictEqual(pairing.findDevice(doc, a.deviceId).label, 'renamed');
    const out = pairing.removeDevice(doc, b.deviceId);
    assert.strictEqual(out.removed, true);
    assert.strictEqual(pairing.findDevice(out.doc, b.deviceId), null);
    assert.strictEqual(pairing.removeDevice(out.doc, b.deviceId).removed, false);
    assert.deepStrictEqual(pairing.parseDevices(JSON.stringify(out.doc)), out.doc);
  });

  it('refuses a wrong version, a mismatched key and duplicates', () => {
    const a = device();
    assert.throws(() => pairing.parseDevices(JSON.stringify({ v: 2, devices: [] })), (e) => e.code === 'DEVICES_FILE_INVALID');
    assert.throws(() => pairing.validateDevices({ v: 1, devices: [{ ...a, publicKey: device().publicKey }] }), /does not match/);
    assert.throws(() => pairing.validateDevices({ v: 1, devices: [a, a] }), /duplicate/);
    assert.throws(() => pairing.parseDevices('not json'), (e) => e.code === 'DEVICES_FILE_INVALID');
  });
});

describe('desktop-bridge.json', () => {
  it('records the node key as DER SPKI hex and checks nodeId', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const record = pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18795 });
    assert.deepStrictEqual(record, {
      v: 1, nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex'), host: '127.0.0.1', port: 18795, protocol: 1
    });
    assert.deepStrictEqual(pairing.parseBridgeFile(JSON.stringify(record)), {
      nodeId: identity.nodeId, publicKey: record.publicKey, host: '127.0.0.1', port: 18795, protocol: 1
    });
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, nodeId: 'kl-aaaaaaaaaaaaaaaa' })), /nodeId does not match/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, host: '0.0.0.0' })), /127\.0\.0\.1/);
    assert.throws(() => pairing.parseBridgeFile(JSON.stringify({ ...record, port: 0 })), (e) => e.code === 'BRIDGE_FILE_INVALID');
    assert.strictEqual(deriveNodeId(record.publicKey), record.nodeId);
  });

  it('finds the file beside the default service data dir unless KL_DESKTOP_BRIDGE_FILE says otherwise', () => {
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'linux' }), '/etc/king-louie/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: {}, platform: 'darwin' }), '/Library/Application Support/KingLouie/config/desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { ProgramData: 'C:\\ProgramData' }, platform: 'win32' }), 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json');
    assert.strictEqual(pairing.bridgeFilePath({ env: { KL_DESKTOP_BRIDGE_FILE: '/srv/kl/config/desktop-bridge.json' }, platform: 'linux' }), '/srv/kl/config/desktop-bridge.json');
  });
});

describe('bridge-file trust (POSIX)', { skip: process.platform === 'win32' ? 'POSIX ownership' : false }, () => {
  const setup = (mode = 0o644) => {
    const dir = path.join(tmp(), 'config');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'desktop-bridge.json');
    fs.writeFileSync(file, '{}', { mode });
    fs.chmodSync(file, mode);
    return file;
  };

  it('refuses a file owned by an ordinary user outside test mode', (t) => {
    if (process.getuid() === 0) { t.skip('running as root'); return; }
    const out = pairing.checkBridgeFileTrust(setup(), { env: {}, platform: 'linux' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BRIDGE_FILE_UNTRUSTED');
    assert.match(out.error, /is not owned by an administrator; refusing to trust it\./);
  });

  it('accepts the current uid only with KL_TEST_MODE=1 and KL_DESKTOP_BRIDGE_FILE', () => {
    const file = setup();
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file }, platform: 'linux' }).ok, true);
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: { KL_TEST_MODE: '1' }, platform: 'linux' }).ok, process.getuid() === 0);
  });

  it('refuses a group-writable file and a symlink even in test mode', () => {
    const writable = setup(0o664);
    assert.strictEqual(pairing.checkBridgeFileTrust(writable, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: writable }, platform: 'linux' }).ok, false);
    const real = setup();
    const link = path.join(path.dirname(real), 'link.json');
    fs.symlinkSync(real, link);
    assert.strictEqual(pairing.checkBridgeFileTrust(link, { env: { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: link }, platform: 'linux' }).ok, false);
  });

  it('reads a trusted file and reports a missing one', () => {
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const file = setup();
    fs.writeFileSync(file, JSON.stringify(pairing.bridgeFileRecord({ publicKey: identity.publicKey, port: 18795 })));
    const env = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    const out = pairing.readTrustedBridgeFile(file, { env, platform: 'linux' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.record.nodeId, identity.nodeId);
    const missing = pairing.readTrustedBridgeFile(path.join(path.dirname(file), 'nope.json'), { env, platform: 'linux' });
    assert.strictEqual(missing.code, 'BRIDGE_FILE_MISSING');
  });
});

describe('bridge-file trust (Windows rules, injected inspector)', () => {
  const file = 'C:\\ProgramData\\KingLouie\\config\\desktop-bridge.json';
  const inspector = (entries, me = 'S-1-5-21-1-2-3-1001') => () => ({ me, entries });

  it('accepts SYSTEM or Administrators as owner of the file and its directory', () => {
    const out = pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-32-544', link: false }, { owner: 'S-1-5-18', link: false }]) });
    assert.deepStrictEqual(out, { ok: true });
  });

  it('refuses a user-owned directory, a reparse point and (outside test mode) the current user', () => {
    const user = 'S-1-5-21-1-2-3-1001';
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: 'S-1-5-18', link: false }]) }).code, 'BRIDGE_FILE_UNTRUSTED');
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: true }, { owner: 'S-1-5-18', link: false }]) }).code, 'BRIDGE_FILE_UNTRUSTED');
    const testEnv = { KL_TEST_MODE: '1', KL_DESKTOP_BRIDGE_FILE: file };
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: testEnv, platform: 'win32', inspectOwners: inspector([{ owner: user, link: false }, { owner: user, link: false }]) }).ok, true);
    assert.strictEqual(pairing.checkBridgeFileTrust(file, { env: {}, platform: 'win32', inspectOwners: inspector([{ owner: 'S-1-5-18', link: false }, null]) }).code, 'BRIDGE_FILE_MISSING');
  });

  it('exports the installers handle-based inspector', () => {
    assert.match(require('../src/service/installers').WINDOWS_INSPECT_CSHARP, /public static class KlFsInspect/);
  });

  it('reads a real owner through PowerShell as a normal user', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
    const f = path.join(tmp(), 'probe.json');
    fs.writeFileSync(f, '{}');
    const out = pairing.inspectWindowsOwners([path.dirname(f), f]);
    assert.match(out.me, /^S-1-5-/);
    assert.strictEqual(out.entries.length, 2);
    assert.match(out.entries[1].owner, /^S-1-5-/);
    assert.strictEqual(out.entries[1].link, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-pairing.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/keys'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/keys.js`:

```js
// Ed25519 helpers for desktop device keys (program §4.17). Device keys are
// raw 32-byte keys in base64url; node keys are DER SPKI hex.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { base32Encode } = require('../mesh/node-identity');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(text) {
  if (typeof text !== 'string' || !B64URL_RE.test(text)) throw new Error('not base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new Error('not canonical base64url');
  return bytes;
}

function localDeriveDeviceId(rawPublicKey, prefix = 'd-') {
  const raw = Buffer.from(rawPublicKey);
  return prefix + base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16);
}

function localEd25519RawToSpki(raw32) {
  const raw = Buffer.from(raw32);
  if (raw.length !== 32) throw new Error('an Ed25519 key is 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

// Fleet stage 3 owns deriveDeviceId and ed25519RawToSpki (src/approvals/envelope.js).
// Until it merges these local copies (same algorithm, same vector) are used;
// once the file exists its functions are, and the copies can be deleted.
const F3_ENVELOPE = path.join(__dirname, '..', 'approvals', 'envelope.js');
const envelope = fs.existsSync(F3_ENVELOPE) ? require(F3_ENVELOPE) : null;
const deriveDeviceId = envelope ? envelope.deriveDeviceId : localDeriveDeviceId;
const ed25519RawToSpki = envelope ? envelope.ed25519RawToSpki : localEd25519RawToSpki;

function rawFromPublicKeyObject(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length);
}

function verifyWithSpkiDer(der, message, signature) {
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

function verifyWithRawKey(raw32, message, signature) {
  let der;
  try { der = ed25519RawToSpki(raw32); } catch { return false; }
  return verifyWithSpkiDer(der, message, signature);
}

function verifyWithSpkiHex(spkiHex, message, signature) {
  if (typeof spkiHex !== 'string' || !/^[0-9a-f]+$/i.test(spkiHex)) return false;
  return verifyWithSpkiDer(Buffer.from(spkiHex, 'hex'), message, signature);
}

// 'kld-abcdefghijklmnop' → 'abcd efgh ijkl mnop': what the owner compares on two screens.
function fingerprintGroups(id) {
  const text = String(id);
  const body = text.slice(text.indexOf('-') + 1);
  return (body.match(/.{1,4}/g) || []).join(' ');
}

module.exports = {
  ED25519_SPKI_PREFIX,
  toB64url,
  fromB64url,
  deriveDeviceId,
  ed25519RawToSpki,
  localDeriveDeviceId,
  localEd25519RawToSpki,
  rawFromPublicKeyObject,
  verifyWithRawKey,
  verifyWithSpkiHex,
  fingerprintGroups
};
```

Create `src/desktop-bridge/protocol.js`:

```js
// Desktop bridge wire protocol, version 1 (fleet stage 7 §3.3).
const crypto = require('crypto');

const PROTOCOL = 1;
const DEFAULT_DESKTOP_BRIDGE_PORT = 18795;
const MIB = 1024 * 1024;

const LIMITS = Object.freeze({
  preAuthFrameBytes: 4096,
  firstFrameMs: 2000,
  handshakeMs: 10000,
  maxPreAuthSockets: 16,
  wsMaxPayload: 80 * MIB,
  frameBytes: 64 * MIB,
  failuresPerDevice: 5,
  failureWindowMs: 60000,
  lockoutMs: 60000,
  deviceRecheckMs: 5000,
  headersTimeoutMs: 10000,
  maxTrackedFailures: 1024
});

const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TRY_AGAIN: 1013,
  MALFORMED: 4400,
  BAD_SIGNATURE: 4401,
  UNKNOWN_DEVICE: 4403,
  OTHER_DEVICE: 4409,
  PROTOCOL_MISMATCH: 4426,
  LOCKED_OUT: 4429
});

const NODE_ID_RE = /^kl-[a-z2-7]{16}$/;
const DEVICE_ID_RE = /^kld-[a-z2-7]{16}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

function newNonce() {
  return crypto.randomBytes(32).toString('base64url');
}

// Every field is base32, base64url or decimal, so the newline-joined ASCII
// string cannot be ambiguous and no canonicalization is needed.
function authString(tag, { nodeId, deviceId, port, serverNonce, clientNonce } = {}) {
  if (!NODE_ID_RE.test(String(nodeId)) || !DEVICE_ID_RE.test(String(deviceId))
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !NONCE_RE.test(String(serverNonce)) || !NONCE_RE.test(String(clientNonce))) {
    throw new Error(`${tag}: malformed authentication fields`);
  }
  return [tag, nodeId, deviceId, String(port), serverNonce, clientNonce].join('\n');
}

const buildAuthS = (fields) => authString('kl.desktop.hello.v1', fields);
const buildAuthC = (fields) => authString('kl.desktop.auth.v1', fields);

// The size is checked before JSON.parse ever sees the bytes.
function parseFrame(data, maxBytes) {
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (size > maxBytes) return { error: 'too-large' };
  let frame;
  try {
    frame = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch {
    return { error: 'malformed' };
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.t !== 'string') return { error: 'malformed' };
  return { frame };
}

// The id of an oversized invoke/call, read from its first bytes without
// parsing the rest (the client always serializes `t` then `id` first).
function peekFrameId(text) {
  const m = /^\{\s*"t"\s*:\s*"(?:invoke|call)"\s*,\s*"id"\s*:\s*(\d{1,15})/.exec(String(text).slice(0, 256));
  return m ? Number(m[1]) : null;
}

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

// What the owner sees (spec §9). One place, so the pane, the attached host
// and the tests agree on every word.
const MESSAGES = Object.freeze({
  SERVICE_UNREACHABLE: (port) => `The local King Louie service is not reachable (127.0.0.1:${port}).`,
  BRIDGE_TIMEOUT: 'The local service did not answer in time.',
  ATTACHED_UNAVAILABLE: 'Not available while attached to the local service. Detach in Settings > Local service to use it.',
  CHANNEL_NOT_PROXIED: (channel) => `${channel} is not served over the desktop bridge.`,
  PAYLOAD_TOO_LARGE: 'That request is too large for the local service (64 MiB limit).',
  DEVICE_UNPAIRED: 'The service does not know this desktop. Pair again in Settings > Local service.',
  SERVICE_KEY_CHANGED: (oldId, newId) => `The service's identity changed from ${oldId} to ${newId}. If you reinstalled the service, pair again.`,
  ANOTHER_DEVICE: (label) => `Another desktop (${label}) is attached to this service.`,
  PROTOCOL_MISMATCH: (theirs) => `This app speaks desktop-bridge protocol ${PROTOCOL}; the service speaks ${theirs}. Upgrade the older one.`,
  SERVICE_TOO_OLD: (version, channel) => `The local service (version ${version}) does not support ${channel}. Upgrade the service.`,
  SERVICE_RESTARTED: 'The local service restarted; the reply was lost.',
  DESKTOP_DISCONNECTED_RUN: 'The desktop disconnected; the run was stopped.',
  NO_PROVIDER: 'The service has no provider key yet — import or add one in Providers.',
  SECURE_STORAGE_UNAVAILABLE: "This system has no secure storage; the desktop can't hold a pairing key.",
  RULE_NOT_DESKTOP: 'This rule was set on the service and can only be removed there.',
  PATH_NOT_ACCESSIBLE: (account, target) => `The service runs as ${account || 'its own account'} and cannot read ${target}. Grant that account access or pick another folder.`,
  LOCKED_OUT: 'Too many failed handshakes from this desktop; try again in a minute.',
  BAD_SIGNATURE: "The service rejected this desktop's signature.",
  MALFORMED: 'The desktop bridge handshake failed.'
});

module.exports = {
  PROTOCOL,
  DEFAULT_DESKTOP_BRIDGE_PORT,
  LIMITS,
  CLOSE,
  NODE_ID_RE,
  DEVICE_ID_RE,
  NONCE_RE,
  newNonce,
  buildAuthS,
  buildAuthC,
  parseFrame,
  peekFrameId,
  BridgeError,
  MESSAGES
};
```

Create `src/desktop-bridge/pairing.js`:

```js
// Pairing request, <configDir>/desktop-devices.json and desktop-bridge.json
// (fleet stage 7 §3.2, §4.1–§4.3).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { deriveNodeId } = require('../mesh/node-identity');
const { adminConfigDir, defaultServiceDataDir } = require('../platform/paths');
const { windowsPowerShellExe } = require('../platform/windows-paths');
const { deriveDeviceId, fromB64url, toB64url } = require('./keys');
const { PROTOCOL, DEVICE_ID_RE } = require('./protocol');

const PAIR_PREFIX = 'klpair1';
const DEVICES_FILE = 'desktop-devices.json';
const BRIDGE_FILE = 'desktop-bridge.json';
const LABEL_MAX_BYTES = 64;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ADMIN_OWNER_SIDS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
const DEVICES_CONTROLS = Object.freeze({ decides: 'which desktops may drive this service', selfGrant: 'pair its own desktops' });

class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

function validateLabel(label, code = 'MALFORMED_REQUEST') {
  if (typeof label !== 'string' || !label.trim()) throw new PairingError(code, 'the desktop label is empty');
  if (CONTROL_RE.test(label)) throw new PairingError(code, 'the desktop label contains control characters');
  if (Buffer.byteLength(label, 'utf8') > LABEL_MAX_BYTES) {
    throw new PairingError(code, `the desktop label is longer than ${LABEL_MAX_BYTES} bytes`);
  }
  return label;
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'owner';
  }
}

function defaultDeviceLabel(username = currentUsername()) {
  const name = String(username || '').replace(new RegExp(CONTROL_RE.source, 'g'), '').slice(0, 40) || 'owner';
  return `${name}'s desktop`;
}

function encodePairRequest({ publicKeyRaw, label }) {
  const raw = Buffer.from(publicKeyRaw);
  if (raw.length !== 32) throw new PairingError('MALFORMED_REQUEST', 'an Ed25519 public key is 32 bytes');
  validateLabel(label);
  return [PAIR_PREFIX, deriveDeviceId(raw, 'kld-'), toB64url(raw), toB64url(Buffer.from(label, 'utf8'))].join('.');
}

function decodePairRequest(text) {
  const parts = String(text || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== PAIR_PREFIX) {
    throw new PairingError('MALFORMED_REQUEST', `a pairing request looks like ${PAIR_PREFIX}.<device id>.<key>.<label>`);
  }
  const [, deviceId, keyText, labelText] = parts;
  if (!DEVICE_ID_RE.test(deviceId)) throw new PairingError('MALFORMED_REQUEST', 'the device id is malformed');
  let raw;
  try {
    raw = fromB64url(keyText);
  } catch {
    throw new PairingError('MALFORMED_REQUEST', 'the public key is not base64url');
  }
  if (raw.length !== 32) throw new PairingError('MALFORMED_REQUEST', 'an Ed25519 public key is 32 bytes');
  if (deriveDeviceId(raw, 'kld-') !== deviceId) throw new PairingError('MALFORMED_REQUEST', 'the device id does not match the public key');
  let label;
  try {
    label = fromB64url(labelText).toString('utf8');
  } catch {
    throw new PairingError('MALFORMED_REQUEST', 'the label is not base64url');
  }
  // Invalid UTF-8 decodes to U+FFFD and would re-encode differently.
  if (toB64url(Buffer.from(label, 'utf8')) !== labelText) throw new PairingError('MALFORMED_REQUEST', 'the label is not valid UTF-8');
  validateLabel(label);
  return { deviceId, publicKey: keyText, publicKeyRaw: raw, label };
}

function emptyDevices() {
  return { v: 1, devices: [] };
}

function invalidDevices(message) {
  return new PairingError('DEVICES_FILE_INVALID', `${DEVICES_FILE}: ${message}`);
}

function validateDevices(doc) {
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.devices)) {
    throw invalidDevices('must be { "v": 1, "devices": [...] }');
  }
  const seen = new Set();
  for (const d of doc.devices) {
    if (!d || !DEVICE_ID_RE.test(String(d.deviceId))) throw invalidDevices('a device id is malformed');
    let raw;
    try {
      raw = fromB64url(d.publicKey);
    } catch {
      throw invalidDevices(`device ${d.deviceId} has a malformed public key`);
    }
    if (raw.length !== 32 || deriveDeviceId(raw, 'kld-') !== d.deviceId) throw invalidDevices(`device ${d.deviceId} does not match its public key`);
    validateLabel(d.label, 'DEVICES_FILE_INVALID');
    if (typeof d.pairedAt !== 'string' || Number.isNaN(Date.parse(d.pairedAt))) throw invalidDevices(`device ${d.deviceId} has no valid pairedAt`);
    if (seen.has(d.deviceId)) throw invalidDevices(`duplicate device ${d.deviceId}`);
    seen.add(d.deviceId);
  }
  return doc;
}

function parseDevices(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw invalidDevices(`not JSON (${err.message})`);
  }
  return validateDevices(doc);
}

function upsertDevice(doc, { deviceId, publicKey, label, pairedAt }) {
  const devices = doc.devices.filter((d) => d.deviceId !== deviceId);
  devices.push({ deviceId, publicKey, label, pairedAt });
  return validateDevices({ v: 1, devices });
}

function removeDevice(doc, deviceId) {
  const devices = doc.devices.filter((d) => d.deviceId !== deviceId);
  return { doc: { v: 1, devices }, removed: devices.length !== doc.devices.length };
}

function findDevice(doc, deviceId) {
  return doc.devices.find((d) => d.deviceId === deviceId) || null;
}

function bridgeFileRecord({ publicKey, port }) {
  const hex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : String(publicKey);
  return { v: 1, nodeId: deriveNodeId(hex), publicKey: hex, host: '127.0.0.1', port, protocol: PROTOCOL };
}

function parseBridgeFile(text, file = BRIDGE_FILE) {
  const invalid = (message) => new PairingError('BRIDGE_FILE_INVALID', `${file}: ${message}`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.v !== 1) throw invalid('"v" must be 1');
  if (doc.host !== '127.0.0.1') throw invalid('host must be 127.0.0.1');
  if (!Number.isInteger(doc.port) || doc.port < 1 || doc.port > 65535) throw invalid('port must be an integer from 1 to 65535');
  if (!Number.isInteger(doc.protocol)) throw invalid('protocol must be an integer');
  let nodeId;
  try {
    nodeId = deriveNodeId(doc.publicKey);
  } catch {
    throw invalid('publicKey is not an Ed25519 SPKI key');
  }
  if (nodeId !== doc.nodeId) throw invalid('nodeId does not match publicKey');
  return { nodeId: doc.nodeId, publicKey: doc.publicKey, host: doc.host, port: doc.port, protocol: doc.protocol };
}

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function bridgeFilePath({ env = process.env, platform = process.platform } = {}) {
  if (env.KL_DESKTOP_BRIDGE_FILE) return env.KL_DESKTOP_BRIDGE_FILE;
  const dataDir = defaultServiceDataDir({ platform, env });
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(adminConfigDir({ platform, dataDir }), BRIDGE_FILE);
}

// Windows: owners read through the installers' handle-based inspector (one
// no-follow handle per path). Paths travel in an environment variable, never
// in the script text. First output line: the current user's SID.
function inspectScript() {
  const { WINDOWS_INSPECT_CSHARP } = require('../service/installers');
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  Add-Type -TypeDefinition @'",
    WINDOWS_INSPECT_CSHARP,
    "'@",
    '  [Console]::Out.WriteLine("me " + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
    '  foreach ($p in $env:KL_INSPECT_PATHS.Split([char]10)) {',
    '    $r = [KlFsInspect]::Inspect($p)',
    "    if ($null -eq $r) { [Console]::Out.WriteLine('missing'); continue }",
    '    $sd = [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$r[1], 0)',
    "    $o = if ($sd.Owner) { $sd.Owner.Value } else { '(none)' }",
    "    $k = if (([uint32]$r[0]) -band 0x400) { 'link' } else { 'plain' }",
    '    [Console]::Out.WriteLine("$o $k")',
    '  }',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n');
}

function inspectWindowsOwners(paths, { execFile = execFileSync, env = process.env } = {}) {
  const out = execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', inspectScript()], {
    env: { ...env, KL_INSPECT_PATHS: paths.join('\n') },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  const lines = String(out).trim().split(/\r?\n/);
  const me = (lines.shift() || '').replace(/^me /, '').trim();
  const entries = lines.map((line) => {
    if (line.trim() === 'missing') return null;
    const [owner, kind] = line.trim().split(' ');
    return { owner, link: kind === 'link' };
  });
  return { me, entries };
}

function untrusted(file) {
  return { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: `${file} is not owned by an administrator; refusing to trust it.` };
}

function missing(file) {
  return { ok: false, code: 'BRIDGE_FILE_MISSING', error: `No local service found at ${path.dirname(file)}.` };
}

// The file and its directory must be administrator-owned and not writable by
// anyone else. With KL_TEST_MODE=1 and KL_DESKTOP_BRIDGE_FILE set, the current
// user is accepted too (e2e only).
function checkBridgeFileTrust(file, {
  env = process.env,
  platform = process.platform,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  lstat = fs.lstatSync,
  inspectOwners = inspectWindowsOwners
} = {}) {
  const dir = path.dirname(file);
  const testMode = env.KL_TEST_MODE === '1' && Boolean(env.KL_DESKTOP_BRIDGE_FILE);
  if (platform === 'win32') {
    let report;
    try {
      report = inspectOwners([dir, file], { env });
    } catch {
      return untrusted(file);
    }
    for (const entry of report.entries) {
      if (!entry) return missing(file);
      if (entry.link) return untrusted(file);
      const ok = ADMIN_OWNER_SIDS.includes(entry.owner) || (testMode && entry.owner === report.me);
      if (!ok) return untrusted(file);
    }
    return { ok: true };
  }
  const me = getuid();
  for (const target of [dir, file]) {
    let st;
    try {
      st = lstat(target);
    } catch {
      return missing(file);
    }
    if (st.isSymbolicLink()) return untrusted(file);
    const ownerOk = st.uid === 0 || (testMode && st.uid === me);
    if (!ownerOk || (st.mode & 0o022)) return untrusted(file);
  }
  return { ok: true };
}

function readTrustedBridgeFile(file, options = {}) {
  const trust = checkBridgeFileTrust(file, options);
  if (!trust.ok) return trust;
  try {
    return { ok: true, record: parseBridgeFile(fs.readFileSync(file, 'utf8'), file) };
  } catch (err) {
    if (err.code === 'ENOENT') return missing(file);
    return { ok: false, code: err.code === 'BRIDGE_FILE_INVALID' ? err.code : 'BRIDGE_FILE_INVALID', error: err.message };
  }
}

module.exports = {
  PAIR_PREFIX,
  DEVICES_FILE,
  BRIDGE_FILE,
  DEVICES_CONTROLS,
  ADMIN_OWNER_SIDS,
  PairingError,
  defaultDeviceLabel,
  encodePairRequest,
  decodePairRequest,
  emptyDevices,
  validateDevices,
  parseDevices,
  upsertDevice,
  removeDevice,
  findDevice,
  bridgeFileRecord,
  parseBridgeFile,
  writeFileAtomic,
  bridgeFilePath,
  inspectWindowsOwners,
  checkBridgeFileTrust,
  readTrustedBridgeFile
};
```

In `src/service/installers.js`, replace:

```js
module.exports = {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml,
  planInstall, planUninstall, executeSteps, runInstallCommand,
  ensureSafeDataDirParent, DARWIN_LOG_DIR
};
```

with:

```js
module.exports = {
  renderSystemdUnit, renderLaunchdPlist, renderWindowsTaskXml,
  planInstall, planUninstall, executeSteps, runInstallCommand,
  ensureSafeDataDirParent, DARWIN_LOG_DIR,
  // Fleet stage 7: the desktop's bridge-file owner check reuses the inspector.
  WINDOWS_INSPECT_CSHARP
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-pairing.test.js tests/service-installers.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0` (the F3-vector test is skipped until F3 merges; the POSIX or Windows-only tests are skipped on the other platform).

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/keys.js src/desktop-bridge/protocol.js src/desktop-bridge/pairing.js src/service/installers.js tests/desktop-pairing.test.js
git commit -m "feat(desktop-bridge): device keys, protocol constants and pairing files

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Channel allowlist, channel inventory and the `desktop:*` IPC channels

**Files:**
- Create: `src/desktop-bridge/allowlist.js`, `src/ipc/channel-inventory.js`, `src/ipc/desktop-handlers.js`
- Modify: `src/ipc/constants.js` — the last entry `  CANVAS_USER_ACTION: 'canvas:userAction'` and the closing `};`
- Modify: `src/ipc/register.js` — after the line `  registerCaseHandlers(ipcMain, context);`
- Test: `tests/desktop-bridge-allowlist.test.js`

**Interfaces:**
- Consumes: `registerHandlers(ipcMain, context)` (`src/ipc/register.js`).
- Produces:
  - `allowlist.js`: `PROXIED_DOMAINS`, `PROXIED_CHANNELS`, `PRESTEP_CHANNELS`, `RENDERER_EVENTS`, `PROMPT_EVENTS`, `ATTACHED_UNAVAILABLE_TABS`, `classifyChannel(ch) → 'local' | 'prestep' | 'proxy' | 'deny'`, `servedChannels({ handle, on }) → { handle, on }`, `isRendererEvent(ch)`, `isTimeoutExempt(ch)`.
  - `listIpcChannels() → { handle: string[], on: string[] }` (sorted, memoized).
  - IPC constants `DESKTOP_STATUS` … `DESKTOP_RETRY`, `DESKTOP_STATUS_CHANGED`, `DESKTOP_IMPORT_PROGRESS`.
  - `desktop-handlers.js`: `DESKTOP_METHODS` (channel → controller method), `createDesktopHandler(channel, getController)`, `registerDesktopHandlers(ipcMain, context)`; with no `context.desktopBridge` every channel answers `{ ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' }`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-bridge-allowlist.test.js`:

```js
// tests/desktop-bridge-allowlist.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const {
  classifyChannel, servedChannels, isRendererEvent, isTimeoutExempt, PROMPT_EVENTS, RENDERER_EVENTS, PROXIED_DOMAINS
} = require('../src/desktop-bridge/allowlist');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { registerDesktopHandlers, DESKTOP_METHODS } = require('../src/ipc/desktop-handlers');

describe('classifyChannel (spec §3.6, first match wins)', () => {
  const cases = {
    'desktop:status': 'local',
    'app:quitWindow': 'local',
    'wizard:getStatus': 'local',
    'chat:pickWorkingDirectory': 'prestep',
    'settings:addAllowedDirectory': 'prestep',
    'chat:speakLast': 'deny',
    'settings:testVoice': 'deny',
    'settings:mcpSave': 'deny',
    'settings:anthropicOAuthStart': 'deny',
    'chat:sendMessage': 'proxy',
    'settings:load': 'proxy',
    'case:list': 'proxy',
    'case:somethingC2Adds': 'proxy',
    'cron:run': 'proxy',
    'memory:list': 'proxy',
    'tool:approvalResponse': 'proxy',
    'usage:getDaily': 'proxy',
    'checkpoint:restore': 'proxy',
    'canvas:getState': 'proxy',
    'agent:userResponse': 'proxy',
    'agent:executeWithDeps': 'deny',
    'hooks:list': 'deny',
    'skill:list': 'deny',
    'webhook:list': 'deny',
    'mesh:peers': 'deny',
    'channel:list': 'deny',
    'gateway:status': 'deny',
    'workflow:run': 'deny',
    'task:list': 'deny',
    'apps:list': 'deny',
    'diagnostics:run': 'deny',
    'sessions:list': 'deny'
  };
  for (const [channel, route] of Object.entries(cases)) {
    it(`${channel} → ${route}`, () => assert.strictEqual(classifyChannel(channel), route));
  }

  it('lists the proxied domains', () => {
    assert.deepStrictEqual([...PROXIED_DOMAINS], ['chat', 'settings', 'case', 'cron', 'memory', 'tool', 'usage', 'checkpoint', 'canvas']);
  });
});

describe('renderer events', () => {
  it('forwards chat, canvas and prompt events and any case event', () => {
    for (const ch of ['chat:messageChunk', 'chat:updated', 'canvas:executeJs', 'tool:approvalRequired', 'agent:askUser', 'backgroundTask:completed', 'case:statusChanged']) {
      assert.strictEqual(isRendererEvent(ch), true, ch);
    }
    for (const ch of ['workflow:progress', 'task:created', 'mesh:ready', 'desktop:statusChanged']) {
      assert.strictEqual(isRendererEvent(ch), false, ch);
    }
    for (const ch of PROMPT_EVENTS) assert.ok(RENDERER_EVENTS.has(ch));
    assert.deepStrictEqual([...PROMPT_EVENTS].sort(), ['agent:askUser', 'tool:approvalRequired', 'tool:directoryAccessRequired']);
  });

  it('exempts only long-running calls from the 120 s timeout', () => {
    for (const ch of ['chat:sendMessage', 'tool:execute', 'cron:run', 'case:ingestFile']) assert.strictEqual(isTimeoutExempt(ch), true, ch);
    for (const ch of ['chat:load', 'case:list', 'settings:load']) assert.strictEqual(isTimeoutExempt(ch), false, ch);
  });
});

describe('listIpcChannels', () => {
  it('records the registered inventory, including desktop:*', () => {
    const inv = listIpcChannels();
    assert.ok(inv.handle.length > 100, `expected >100 handle channels, got ${inv.handle.length}`);
    for (const ch of Object.keys(DESKTOP_METHODS)) assert.ok(inv.handle.includes(ch), ch);
    assert.ok(inv.handle.includes('chat:load'));
    assert.ok(inv.on.includes('tool:approvalResponse'));
    assert.ok(inv.on.includes('agent:userResponse'));
    assert.strictEqual(listIpcChannels(), inv, 'memoized');
  });

  it('classifies every channel into exactly one route', () => {
    const inv = listIpcChannels();
    for (const ch of [...inv.handle, ...inv.on]) {
      assert.ok(['local', 'prestep', 'proxy', 'deny'].includes(classifyChannel(ch)), ch);
    }
  });

  it('serves only proxy channels', () => {
    const served = servedChannels(listIpcChannels());
    assert.ok(served.handle.includes('chat:sendMessage'));
    assert.ok(served.on.includes('agent:userResponse'));
    for (const ch of ['chat:pickWorkingDirectory', 'desktop:status', 'hooks:list', 'settings:mcpList', 'wizard:getStatus']) {
      assert.ok(!served.handle.includes(ch), ch);
    }
  });
});

describe('desktop:* handlers', () => {
  const record = () => {
    const handlers = new Map();
    return { handlers, ipc: { handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); }, on() {} } };
  };

  it('defines a constant for every channel', () => {
    assert.strictEqual(IPC.DESKTOP_STATUS, 'desktop:status');
    assert.strictEqual(IPC.DESKTOP_STATUS_CHANGED, 'desktop:statusChanged');
    assert.strictEqual(IPC.DESKTOP_IMPORT_PROGRESS, 'desktop:importProgress');
    assert.deepStrictEqual(Object.keys(DESKTOP_METHODS).sort(), [
      'desktop:attach', 'desktop:detach', 'desktop:importApply', 'desktop:importPlan', 'desktop:pairCancel',
      'desktop:pairConfirm', 'desktop:pairStart', 'desktop:retry', 'desktop:standaloneOnce', 'desktop:status', 'desktop:unpair'
    ]);
  });

  it('answers ATTACHED_UNAVAILABLE without a desktop controller', async () => {
    const { handlers, ipc } = record();
    registerDesktopHandlers(ipc, {});
    assert.deepStrictEqual(await handlers.get('desktop:status')({}), { ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' });
  });

  it('calls the controller and wraps plain values and errors', async () => {
    const { handlers, ipc } = record();
    registerDesktopHandlers(ipc, {
      desktopBridge: {
        status: async () => ({ ok: true, view: 'unpaired' }),
        detach: async (payload) => payload,
        pairStart: async () => { throw Object.assign(new Error('no secure storage'), { code: 'SECURE_STORAGE_UNAVAILABLE' }); }
      }
    });
    assert.deepStrictEqual(await handlers.get('desktop:status')({}), { ok: true, view: 'unpaired' });
    assert.deepStrictEqual(await handlers.get('desktop:detach')({}, { confirmed: true }), { ok: true, data: { confirmed: true } });
    assert.deepStrictEqual(await handlers.get('desktop:pairStart')({}), { ok: false, code: 'SECURE_STORAGE_UNAVAILABLE', error: 'no secure storage' });
    assert.strictEqual((await handlers.get('desktop:attach')({})).code, 'ATTACHED_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-allowlist.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/allowlist'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/allowlist.js`:

```js
// Which IPC channels attached mode proxies to the service (fleet stage 7 §3.6).
// Rules are evaluated in order; the first match wins. A stage that adds a
// domain that must work while attached appends it to PROXIED_DOMAINS (one line).
const LOCAL_PREFIXES = Object.freeze(['desktop:', 'wizard:']);
const LOCAL_CHANNELS = Object.freeze(['app:quitWindow']);
const PRESTEP_CHANNELS = Object.freeze(['chat:pickWorkingDirectory', 'settings:addAllowedDirectory']);
const DENY_CHANNELS = Object.freeze(['chat:speakLast', 'settings:testVoice']);
const DENY_PREFIXES = Object.freeze(['settings:mcp', 'settings:anthropicOAuth']);
const PROXIED_DOMAINS = Object.freeze([
  'chat',
  'settings',
  'case',
  'cron',
  'memory',
  'tool',
  'usage',
  'checkpoint',
  'canvas'
]);
const PROXIED_CHANNELS = Object.freeze(['agent:userResponse']);

const PROMPT_EVENTS = new Set(['tool:approvalRequired', 'tool:directoryAccessRequired', 'agent:askUser']);
const RENDERER_EVENTS = new Set([
  'chat:messageStart', 'chat:messageChunk', 'chat:messageComplete', 'chat:messageError',
  'chat:toolUse', 'chat:toolResult', 'chat:toolProgress', 'chat:updated',
  'chat:advisorStarted', 'chat:advisorCompleted',
  'canvas:render', 'canvas:close', 'canvas:executeJs',
  ...PROMPT_EVENTS,
  'backgroundTask:completed'
]);

// Settings tabs whose domains the service does not serve while attached.
const ATTACHED_UNAVAILABLE_TABS = Object.freeze(['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps']);

const TIMEOUT_EXEMPT = new Set(['chat:sendMessage', 'tool:execute', 'cron:run']);

function domainOf(channel) {
  const i = channel.indexOf(':');
  return i === -1 ? channel : channel.slice(0, i);
}

function classifyChannel(channel) {
  const ch = String(channel);
  if (LOCAL_CHANNELS.includes(ch) || LOCAL_PREFIXES.some((p) => ch.startsWith(p))) return 'local';
  if (PRESTEP_CHANNELS.includes(ch)) return 'prestep';
  if (DENY_CHANNELS.includes(ch) || DENY_PREFIXES.some((p) => ch.startsWith(p))) return 'deny';
  if (PROXIED_CHANNELS.includes(ch) || PROXIED_DOMAINS.includes(domainOf(ch))) return 'proxy';
  return 'deny';
}

function servedChannels({ handle = [], on = [] } = {}) {
  return {
    handle: handle.filter((ch) => classifyChannel(ch) === 'proxy'),
    on: on.filter((ch) => classifyChannel(ch) === 'proxy')
  };
}

function isRendererEvent(channel) {
  const ch = String(channel);
  return RENDERER_EVENTS.has(ch) || ch.startsWith('case:');
}

function isTimeoutExempt(channel) {
  const ch = String(channel);
  return TIMEOUT_EXEMPT.has(ch) || ch.startsWith('case:ingest');
}

module.exports = {
  PROXIED_DOMAINS,
  PROXIED_CHANNELS,
  PRESTEP_CHANNELS,
  RENDERER_EVENTS,
  PROMPT_EVENTS,
  ATTACHED_UNAVAILABLE_TABS,
  classifyChannel,
  servedChannels,
  isRendererEvent,
  isTimeoutExempt
};
```

Create `src/ipc/channel-inventory.js`:

```js
// The IPC channels registerHandlers actually registers (not the constants
// file, which is incomplete). Recorded once against an inert context, the way
// tests/ipc-contract.test.js does it; registration only reads the context.
const { registerHandlers } = require('./register');

let cached = null;

function listIpcChannels() {
  if (cached) return cached;
  const handle = new Set();
  const on = new Set();
  const recorder = { handle: (ch) => handle.add(ch), on: (ch) => on.add(ch), removeHandler() {} };
  const inert = new Proxy({}, { get: () => () => {} });
  registerHandlers(recorder, inert);
  cached = Object.freeze({ handle: Object.freeze([...handle].sort()), on: Object.freeze([...on].sort()) });
  return cached;
}

module.exports = { listIpcChannels };
```

Create `src/ipc/desktop-handlers.js`:

```js
// Settings > Local service (fleet stage 7 §3.7). Always registered, so no host
// ever registers these channels twice; without a desktop controller in the
// context (the service's bridge dispatcher, the contract test) they refuse.
const IPC = require('./constants');

const DESKTOP_METHODS = Object.freeze({
  [IPC.DESKTOP_STATUS]: 'status',
  [IPC.DESKTOP_PAIR_START]: 'pairStart',
  [IPC.DESKTOP_PAIR_CONFIRM]: 'pairConfirm',
  [IPC.DESKTOP_PAIR_CANCEL]: 'pairCancel',
  [IPC.DESKTOP_ATTACH]: 'attach',
  [IPC.DESKTOP_DETACH]: 'detach',
  [IPC.DESKTOP_STANDALONE_ONCE]: 'standaloneOnce',
  [IPC.DESKTOP_UNPAIR]: 'unpair',
  [IPC.DESKTOP_IMPORT_PLAN]: 'importPlan',
  [IPC.DESKTOP_IMPORT_APPLY]: 'importApply',
  [IPC.DESKTOP_RETRY]: 'retry'
});

const unavailable = () => ({ ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' });

function createDesktopHandler(channel, getController) {
  const method = DESKTOP_METHODS[channel];
  return async (_event, payload = {}) => {
    const controller = getController();
    if (!controller || typeof controller[method] !== 'function') return unavailable();
    try {
      const result = await controller[method](payload || {});
      return result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')
        ? result
        : { ok: true, data: result };
    } catch (err) {
      return { ok: false, code: err.code || 'DESKTOP_ERROR', error: err.message || String(err) };
    }
  };
}

function registerDesktopHandlers(ipcMain, context = {}) {
  for (const channel of Object.keys(DESKTOP_METHODS)) {
    ipcMain.handle(channel, createDesktopHandler(channel, () => {
      const bridge = context.desktopBridge;
      return bridge && typeof bridge === 'object' ? bridge : null;
    }));
  }
}

module.exports = { DESKTOP_METHODS, createDesktopHandler, registerDesktopHandlers };
```

In `src/ipc/constants.js`, replace:

```js
  CANVAS_USER_ACTION: 'canvas:userAction'
};
```

with:

```js
  CANVAS_USER_ACTION: 'canvas:userAction',

  DESKTOP_STATUS: 'desktop:status',
  DESKTOP_PAIR_START: 'desktop:pairStart',
  DESKTOP_PAIR_CONFIRM: 'desktop:pairConfirm',
  DESKTOP_PAIR_CANCEL: 'desktop:pairCancel',
  DESKTOP_ATTACH: 'desktop:attach',
  DESKTOP_DETACH: 'desktop:detach',
  DESKTOP_STANDALONE_ONCE: 'desktop:standaloneOnce',
  DESKTOP_UNPAIR: 'desktop:unpair',
  DESKTOP_IMPORT_PLAN: 'desktop:importPlan',
  DESKTOP_IMPORT_APPLY: 'desktop:importApply',
  DESKTOP_RETRY: 'desktop:retry',
  DESKTOP_STATUS_CHANGED: 'desktop:statusChanged',
  DESKTOP_IMPORT_PROGRESS: 'desktop:importProgress'
};
```

In `src/ipc/register.js`, after the line `  registerCaseHandlers(ipcMain, context);` add:

```js
  require('./desktop-handlers').registerDesktopHandlers(ipcMain, context);
```

(The Proxy context of `listIpcChannels` and of `tests/ipc-contract.test.js` returns a function for `desktopBridge`, which the `typeof bridge === 'object'` check treats as absent.)

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-allowlist.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/allowlist.js src/ipc/channel-inventory.js src/ipc/desktop-handlers.js src/ipc/constants.js src/ipc/register.js tests/desktop-bridge-allowlist.test.js
git commit -m "feat(desktop-bridge): channel allowlist, IPC inventory and desktop:* channels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `DesktopBridgeServer` — listener, handshake, limits

**Files:**
- Create: `src/desktop-bridge/connection.js`, `src/desktop-bridge/bridge-server.js`
- Test: `tests/desktop-bridge-protocol.test.js`

**Interfaces:**
- Consumes: Task 2 (`protocol.js`, `pairing.js` `DEVICES_FILE`/`DEVICES_CONTROLS`/`parseDevices`/`findDevice`, `keys.js` `fromB64url`/`verifyWithRawKey`), Task 3 (`isRendererEvent`, `PROMPT_EVENTS`), `assertAdminOwned(file, geteuid, adminUid, controls)` (`src/service/config.js`), `NodeIdentity` (`nodeId`, `nodeName`, `sign(bytes) → Buffer`).
- Produces:
  - `createConnection({ deviceId, label, send, close }) → { id, deviceId, label, live, send(frame), close(code, reason), runs: Set, prompts: { approvals, askUser, directory, canvas }: Sets, gone: Promise, markGone() }`.
  - `class DesktopBridgeServer extends EventEmitter` — `constructor({ core, identity, cipher, configDir, dataDir, port = 18795, host = '127.0.0.1', version, geteuid, adminUid = 0, approvals = null, profile = 'agent', account, createDispatcher, limits })`; `start() → Promise<{ port }>`; `stop() → Promise<void>`; `forwardAmbient(channel, payload)`; `serviceInfo()`; getter `connected → { deviceId, label } | null`; events `'connected'`, `'disconnected'`. The dispatcher contract (Task 7 implements it): `{ served: { handle, on }, providersConfigured(), handleFrame(conn, frame), onDisconnect(conn), forwardAmbient(channel, payload) }`, created by `createDispatcher({ core, cipher, dataDir, approvals, account, getServiceInfo, getConnection })`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-bridge-protocol.test.js`:

```js
// tests/desktop-bridge-protocol.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { DesktopBridgeServer } = require('../src/desktop-bridge/bridge-server');
const { buildAuthS, buildAuthC, newNonce, PROTOCOL } = require('../src/desktop-bridge/protocol');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
const servers = [];
const identity = new NodeIdentity({ nodeName: 'gpu-box' });

after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeDevice(label = 'web-01 desk') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = keys.rawFromPublicKeyObject(publicKey);
  return { deviceId: keys.deriveDeviceId(raw, 'kld-'), publicKey: keys.toB64url(raw), label, privateKey };
}

function writeDevices(configDir, devices) {
  let doc = pairing.emptyDevices();
  for (const d of devices) doc = pairing.upsertDevice(doc, { deviceId: d.deviceId, publicKey: d.publicKey, label: d.label, pairedAt: '2026-09-23T14:02:11Z' });
  pairing.writeFileAtomic(path.join(configDir, pairing.DEVICES_FILE), JSON.stringify(doc), 0o644);
}

function fakeDispatcher() {
  return {
    served: { handle: ['chat:load', 'chat:sendMessage'], on: ['tool:approvalResponse'] },
    frames: [],
    disconnects: [],
    providersConfigured: () => true,
    async handleFrame(conn, frame) {
      this.frames.push(frame);
      if (frame.t === 'invoke') {
        if (frame.channel === 'chat:sendMessage') await new Promise((r) => setTimeout(r, 200));
        conn.send({ t: 'result', id: frame.id, value: { ok: true, data: { echo: frame.args } } });
      }
    },
    onDisconnect(conn) { this.disconnects.push(conn.deviceId); },
    forwardAmbient() {}
  };
}

async function startServer({ devices = [], limits = {} } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-'));
  dirs.push(configDir);
  writeDevices(configDir, devices);
  const dispatcher = fakeDispatcher();
  const server = new DesktopBridgeServer({
    identity, configDir, port: 0, version: '26.9.0', adminUid: selfUid, account: 'LOCAL SERVICE',
    createDispatcher: () => dispatcher, limits
  });
  servers.push(server);
  const { port } = await server.start();
  return { server, port, configDir, dispatcher };
}

// A hand-driven client: records every frame it receives and the close code.
function rawClient(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options);
  const received = [];
  const waiters = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    received.push(frame);
    for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
  });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
  ws.on('error', () => {});
  const next = (match) => {
    const hit = received.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { statusCode: res.statusCode }))); });
  return { ws, received, closed, next, opened, send: (obj) => ws.send(JSON.stringify(obj)) };
}

// Runs the handshake; `tamper` changes the auth signature or the protocol.
async function handshake(port, device, { tamper = null, protocol = PROTOCOL } = {}) {
  const c = rawClient(port);
  await c.opened;
  const challenge = await c.next((f) => f.t === 'challenge');
  const clientNonce = newNonce();
  c.send({ t: 'clientHello', protocol, deviceId: device.deviceId, clientNonce });
  const outcome = await Promise.race([c.next((f) => f.t === 'hello'), c.closed.then((close) => ({ close }))]);
  if (outcome.close) return { c, challenge, close: outcome.close };
  const fields = { nodeId: identity.nodeId, deviceId: device.deviceId, port, serverNonce: challenge.serverNonce, clientNonce };
  const helloOk = keys.verifyWithSpkiHex(identity.publicKey.toString('hex'), Buffer.from(buildAuthS(fields)), keys.fromB64url(outcome.sig));
  let sig = keys.toB64url(crypto.sign(null, Buffer.from(buildAuthC(fields)), device.privateKey));
  if (tamper) sig = tamper(sig);
  c.send({ t: 'auth', sig });
  const end = await Promise.race([c.next((f) => f.t === 'ready'), c.closed.then((close) => ({ close }))]);
  return { c, challenge, helloOk, sig, ready: end.t === 'ready' ? end : null, close: end.close || null };
}

describe('auth strings', () => {
  it('join the fixed fields with newlines, port included', () => {
    const fields = { nodeId: identity.nodeId, deviceId: makeDevice().deviceId, port: 18795, serverNonce: newNonce(), clientNonce: newNonce() };
    assert.strictEqual(buildAuthS(fields), ['kl.desktop.hello.v1', fields.nodeId, fields.deviceId, '18795', fields.serverNonce, fields.clientNonce].join('\n'));
    assert.strictEqual(buildAuthC(fields), ['kl.desktop.auth.v1', fields.nodeId, fields.deviceId, '18795', fields.serverNonce, fields.clientNonce].join('\n'));
    assert.throws(() => buildAuthS({ ...fields, port: 0 }), /malformed/);
    assert.throws(() => buildAuthC({ ...fields, clientNonce: 'short' }), /malformed/);
  });
});

describe('DesktopBridgeServer handshake', () => {
  it('proves itself first, then accepts a paired device', async () => {
    const device = makeDevice();
    const { port, server } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    assert.strictEqual(out.helloOk, true, 'hello.sig verifies under the node key');
    assert.deepStrictEqual(out.c.received.map((f) => f.t), ['challenge', 'hello', 'ready']);
    assert.strictEqual(out.ready.service.protocol, 1);
    assert.strictEqual(out.ready.service.nodeId, identity.nodeId);
    assert.strictEqual(out.ready.service.account, 'LOCAL SERVICE');
    assert.deepStrictEqual(out.ready.service.channels, ['chat:load', 'chat:sendMessage', 'tool:approvalResponse']);
    assert.deepStrictEqual(server.connected, { deviceId: device.deviceId, label: device.label });
    out.c.send({ t: 'invoke', id: 1, channel: 'chat:load', args: [] });
    const result = await out.c.next((f) => f.t === 'result' && f.id === 1);
    assert.deepStrictEqual(result.value, { ok: true, data: { echo: [] } });
    out.c.ws.close();
  });

  it('closes 4401 for a wrong device key', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const impostor = { ...device, privateKey: crypto.generateKeyPairSync('ed25519').privateKey };
    const out = await handshake(port, impostor);
    assert.strictEqual(out.close.code, 4401);
  });

  it('closes 4403 for an unknown device', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const out = await handshake(port, makeDevice());
    assert.strictEqual(out.close.code, 4403);
  });

  it('rejects a replayed auth: every challenge has a new serverNonce', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const first = await handshake(port, device);
    assert.ok(first.ready);
    first.c.ws.close();
    await first.c.closed;
    const replay = await handshake(port, device, { tamper: () => first.sig });
    assert.notStrictEqual(replay.challenge.serverNonce, first.challenge.serverNonce);
    assert.strictEqual(replay.close.code, 4401);
  });

  it('closes 4426 on a protocol mismatch, naming its own protocol', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const out = await handshake(port, device, { protocol: 2 });
    assert.deepStrictEqual(out.close, { code: 4426, reason: '1' });
  });

  it('closes 4400 for an oversized pre-auth frame and for a silent socket', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const big = rawClient(port);
    await big.opened;
    big.ws.send('x'.repeat(4097));
    assert.strictEqual((await big.closed).code, 4400);
    const silent = rawClient(port);
    await silent.opened;
    const started = Date.now();
    assert.strictEqual((await silent.closed).code, 4400);
    assert.ok(Date.now() - started >= 1900, 'no earlier than the 2 s first-frame deadline');
  });

  it('locks out only the device that failed 5 handshakes', async () => {
    const a = makeDevice('desk a');
    const b = makeDevice('desk b');
    const { port } = await startServer({ devices: [a, b] });
    for (let i = 0; i < 5; i += 1) {
      const out = await handshake(port, a, { tamper: (sig) => `${sig.slice(0, -4)}AAAA` });
      assert.strictEqual(out.close.code, 4401);
    }
    assert.strictEqual((await handshake(port, a)).close.code, 4429);
    const okB = await handshake(port, b);
    assert.ok(okB.ready, 'no global lockout');
    okB.c.ws.close();
  });

  it('evicts the oldest pre-auth socket when a 17th arrives', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const clients = [];
    for (let i = 0; i < 16; i += 1) { const c = rawClient(port); await c.opened; await c.next((f) => f.t === 'challenge'); clients.push(c); }
    const seventeenth = rawClient(port);
    await seventeenth.opened;
    assert.strictEqual((await clients[0].closed).code, 1013);
    assert.strictEqual(clients[1].ws.readyState, WebSocket.OPEN);
    for (const c of [...clients, seventeenth]) c.ws.terminate();
  });

  it('refuses an upgrade with an Origin header (403)', async () => {
    const { port } = await startServer({ devices: [makeDevice()] });
    const c = rawClient(port, { origin: 'https://example.com' });
    await assert.rejects(c.opened, (err) => err.statusCode === 403);
  });

  it('answers a 65 MiB invoke with PAYLOAD_TOO_LARGE and keeps the socket open', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    out.c.ws.send(`{"t":"invoke","id":7,"channel":"chat:load","args":["${'a'.repeat(65 * 1024 * 1024)}"]}`);
    const tooBig = await out.c.next((f) => f.t === 'result' && f.id === 7);
    assert.deepStrictEqual(tooBig, { t: 'result', id: 7, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    out.c.send({ t: 'invoke', id: 8, channel: 'chat:load', args: [] });
    assert.ok((await out.c.next((f) => f.t === 'result' && f.id === 8)).value.ok);
    out.c.ws.close();
  });

  it('second device is refused while the first is live', async () => {
    const first = makeDevice('first desk');
    const second = makeDevice('second desk');
    const { port } = await startServer({ devices: [first, second] });
    const live = await handshake(port, first);
    assert.ok(live.ready);
    const refused = await handshake(port, second);
    assert.deepStrictEqual(refused.close, { code: 4409, reason: 'first desk' });
    live.c.ws.close();
  });

  it('a reconnect from the same device replaces the old connection', async () => {
    const device = makeDevice();
    const { port, dispatcher } = await startServer({ devices: [device] });
    const one = await handshake(port, device);
    const two = await handshake(port, device);
    assert.ok(two.ready);
    assert.strictEqual((await one.c.closed).code, 1000);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(dispatcher.disconnects, [device.deviceId]);
    two.c.ws.close();
  });

  it('closes a live connection with 4403 once the device is unpaired', async () => {
    const device = makeDevice();
    const { port, configDir } = await startServer({ devices: [device], limits: { deviceRecheckMs: 50 } });
    const out = await handshake(port, device);
    assert.ok(out.ready);
    writeDevices(configDir, []);
    assert.strictEqual((await out.c.closed).code, 4403);
  });

  it('says bye SERVICE_STOPPING and closes 1001 on stop', async () => {
    const device = makeDevice();
    const { port, server } = await startServer({ devices: [device] });
    const out = await handshake(port, device);
    await server.stop();
    assert.deepStrictEqual(await out.c.next((f) => f.t === 'bye'), { t: 'bye', code: 'SERVICE_STOPPING' });
    assert.strictEqual((await out.c.closed).code, 1001);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-protocol.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/bridge-server'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/connection.js`:

```js
// One authenticated desktop connection, shared by the server (which owns the
// socket) and the dispatcher (which tracks what was issued to it).
let nextId = 0;

function createConnection({ deviceId, label, send, close = () => {} }) {
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });
  const conn = {
    id: ++nextId,
    deviceId,
    label,
    live: true,
    cleaned: false,
    send,
    close,
    // chatIds whose chat:sendMessage started on this connection
    runs: new Set(),
    // ids of prompts and canvas requests forwarded to this connection only
    prompts: { approvals: new Set(), askUser: new Set(), directory: new Set(), canvas: new Set() },
    gone,
    markGone() {
      if (!conn.live) return;
      conn.live = false;
      resolveGone();
    }
  };
  return conn;
}

module.exports = { createConnection };
```

Create `src/desktop-bridge/bridge-server.js`:

```js
// The desktop bridge listener (fleet stage 7 §3.3, §3.4): loopback only,
// separate from the gateway, mutual Ed25519 authentication against a device
// an administrator paired. The server proves itself first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const {
  PROTOCOL, DEFAULT_DESKTOP_BRIDGE_PORT, LIMITS, CLOSE, DEVICE_ID_RE, NONCE_RE,
  newNonce, buildAuthS, buildAuthC, parseFrame, peekFrameId
} = require('./protocol');
const { DEVICES_FILE, DEVICES_CONTROLS, parseDevices, findDevice } = require('./pairing');
const { fromB64url, verifyWithRawKey } = require('./keys');
const { createConnection } = require('./connection');

const log = createLogger('desktop-bridge');
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);
const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

function currentAccount() {
  try {
    return os.userInfo().username;
  } catch {
    return 'the service account';
  }
}

class DesktopBridgeServer extends EventEmitter {
  constructor({
    core = null, identity, cipher = null, configDir, dataDir = null,
    port = DEFAULT_DESKTOP_BRIDGE_PORT, host = '127.0.0.1', version = null,
    geteuid = defaultGeteuid, adminUid = 0, approvals = null, profile = 'agent',
    account = currentAccount(), createDispatcher = null, limits = {}, now = Date.now
  } = {}) {
    super();
    if (host !== '127.0.0.1') throw new Error('DesktopBridgeServer binds only to 127.0.0.1');
    if (!identity || typeof identity.sign !== 'function') throw new Error('DesktopBridgeServer needs the node identity');
    if (!configDir) throw new Error('DesktopBridgeServer needs configDir');
    this.identity = identity;
    this.configDir = configDir;
    this.port = port;
    this.host = host;
    this.version = version;
    this.geteuid = geteuid;
    this.adminUid = adminUid;
    this.profile = profile;
    this.account = account;
    this.now = now;
    this.limits = { ...LIMITS, ...limits };
    this.wss = null;
    this.live = null;
    this.preAuth = [];
    this.sockets = new Set();
    this.failures = new Map();
    this.lockouts = new Map();
    this.recheckTimer = null;
    const factory = createDispatcher || ((opts) => require('./bridge-dispatcher').createBridgeDispatcher(opts));
    this.dispatcher = factory({
      core, cipher, dataDir, approvals, account,
      getServiceInfo: () => this.serviceInfo(),
      getConnection: () => this.live
    });
  }

  get connected() {
    return this.live ? { deviceId: this.live.deviceId, label: this.live.label } : null;
  }

  serviceInfo() {
    const served = this.dispatcher.served;
    return {
      version: this.version,
      protocol: PROTOCOL,
      nodeId: this.identity.nodeId,
      nodeName: this.identity.nodeName || null,
      account: this.account,
      profile: this.profile,
      providersConfigured: Boolean(this.dispatcher.providersConfigured()),
      channels: [...served.handle, ...served.on]
    };
  }

  async start() {
    if (this.wss) return { port: this.port };
    this.wss = new WebSocket.Server({
      host: this.host,
      port: this.port,
      maxPayload: this.limits.wsMaxPayload,
      perMessageDeflate: false,
      // Presence, not truthiness: any Origin header means a browser.
      verifyClient: ({ req }, done) => ('origin' in req.headers ? done(false, 403, 'Forbidden') : done(true))
    });
    this.wss.on('connection', (ws) => this._onConnection(ws));
    this.wss.on('error', (err) => log.error(`desktop bridge error: ${err.message}`));
    try {
      await new Promise((resolve, reject) => {
        this.wss.once('listening', resolve);
        this.wss.once('error', reject);
      });
    } catch (err) {
      this.wss = null;
      throw new Error(`desktop bridge could not bind 127.0.0.1:${this.port}: ${err.message}`);
    }
    this.port = this.wss.address().port;
    const httpServer = this.wss._server;
    if (httpServer) {
      httpServer.headersTimeout = this.limits.headersTimeoutMs;
      httpServer.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
    }
    this.recheckTimer = setInterval(() => this._recheckLive(), this.limits.deviceRecheckMs);
    this.recheckTimer.unref?.();
    log.info(`desktop bridge listening on 127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  forwardAmbient(channel, payload) {
    this.dispatcher.forwardAmbient(channel, payload);
  }

  async stop() {
    if (!this.wss) return;
    clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    const conn = this.live;
    if (conn) {
      conn.send({ t: 'bye', code: 'SERVICE_STOPPING' });
      conn.close(CLOSE.GOING_AWAY, 'service stopping');
    }
    for (const ws of this.sockets) {
      try { ws.close(CLOSE.GOING_AWAY, 'service stopping'); } catch { /* gone */ }
    }
    const allClosed = Promise.all([...this.sockets].map((ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    })));
    await Promise.race([allClosed, delay(500)]);
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* gone */ }
    }
    const wss = this.wss;
    this.wss = null;
    await new Promise((resolve) => wss.close(() => resolve()));
    if (conn) await Promise.resolve(this.dispatcher.onDisconnect(conn)).catch(() => {});
    this.live = null;
  }

  _onConnection(ws) {
    const state = { ws, stage: 'hello', serverNonce: newNonce(), clientNonce: null, deviceId: null, device: null, conn: null, timers: [] };
    this.sockets.add(ws);
    this.preAuth.push(state);
    while (this.preAuth.length > this.limits.maxPreAuthSockets) {
      this._close(this.preAuth[0], CLOSE.TRY_AGAIN, 'too many pending handshakes');
    }
    state.firstFrame = setTimeout(() => this._close(state, CLOSE.MALFORMED, 'no first frame'), this.limits.firstFrameMs);
    state.timers.push(state.firstFrame, setTimeout(() => this._close(state, CLOSE.MALFORMED, 'handshake timed out'), this.limits.handshakeMs));
    ws.on('message', (data, isBinary) => {
      Promise.resolve(this._onMessage(state, data, isBinary)).catch((err) => log.warn(`desktop bridge frame failed: ${err.message}`));
    });
    ws.on('close', () => this._onClose(state));
    ws.on('error', (err) => log.debug(`desktop bridge socket error: ${err.message}`));
    this._sendRaw(ws, { t: 'challenge', protocol: PROTOCOL, nodeId: this.identity.nodeId, serverNonce: state.serverNonce });
  }

  _onMessage(state, data, isBinary) {
    if (state.stage === 'ready') return this._onReadyFrame(state, data, isBinary);
    if (state.stage === 'closed') return undefined;
    clearTimeout(state.firstFrame);
    if (isBinary) return this._close(state, CLOSE.MALFORMED, 'binary frame');
    const parsed = parseFrame(data, this.limits.preAuthFrameBytes);
    if (parsed.error) return this._close(state, CLOSE.MALFORMED, parsed.error);
    if (state.stage === 'hello') return this._onClientHello(state, parsed.frame);
    return this._onAuth(state, parsed.frame);
  }

  _onClientHello(state, frame) {
    if (frame.t !== 'clientHello') return this._close(state, CLOSE.MALFORMED, 'expected clientHello');
    if (frame.protocol !== PROTOCOL) return this._close(state, CLOSE.PROTOCOL_MISMATCH, String(PROTOCOL));
    if (!DEVICE_ID_RE.test(String(frame.deviceId)) || !NONCE_RE.test(String(frame.clientNonce))) {
      return this._close(state, CLOSE.MALFORMED, 'malformed clientHello');
    }
    if (this._lockedOut(frame.deviceId)) return this._close(state, CLOSE.LOCKED_OUT, 'too many failed handshakes');
    const device = this._lookupDevice(frame.deviceId);
    if (!device) {
      this._recordFailure(frame.deviceId);
      return this._close(state, CLOSE.UNKNOWN_DEVICE, 'unknown device');
    }
    state.deviceId = frame.deviceId;
    state.device = device;
    state.clientNonce = frame.clientNonce;
    state.stage = 'auth';
    const sig = this.identity.sign(Buffer.from(buildAuthS(this._fields(state)), 'utf8'));
    this._sendRaw(state.ws, { t: 'hello', sig: Buffer.from(sig).toString('base64url') });
    return undefined;
  }

  _onAuth(state, frame) {
    if (frame.t !== 'auth' || typeof frame.sig !== 'string') return this._close(state, CLOSE.MALFORMED, 'expected auth');
    let sig;
    try { sig = fromB64url(frame.sig); } catch { sig = Buffer.alloc(0); }
    const raw = fromB64url(state.device.publicKey);
    if (!verifyWithRawKey(raw, Buffer.from(buildAuthC(this._fields(state)), 'utf8'), sig)) {
      this._recordFailure(state.deviceId);
      return this._close(state, CLOSE.BAD_SIGNATURE, 'signature invalid');
    }
    // Re-read: an unpair between clientHello and auth wins.
    const device = this._lookupDevice(state.deviceId);
    if (!device) return this._close(state, CLOSE.UNKNOWN_DEVICE, 'unknown device');
    if (this.live && this.live.deviceId !== state.deviceId) return this._close(state, CLOSE.OTHER_DEVICE, this.live.label);
    this._removePreAuth(state);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    if (this.live) {
      const old = this.live;
      this.live = null;
      old.close(CLOSE.NORMAL, 'replaced by a new connection');
    }
    state.stage = 'ready';
    const conn = createConnection({
      deviceId: device.deviceId,
      label: device.label,
      send: (obj) => this._send(state.ws, obj),
      close: (code, reason) => { try { state.ws.close(code, reason); } catch { /* gone */ } }
    });
    state.conn = conn;
    this.live = conn;
    this.failures.delete(state.deviceId);
    this._sendRaw(state.ws, { t: 'ready', service: this.serviceInfo() });
    log.info(`desktop "${device.label}" (${device.deviceId}) attached`);
    this.emit('connected', { deviceId: conn.deviceId, label: conn.label });
    return undefined;
  }

  async _onReadyFrame(state, data, isBinary) {
    const conn = state.conn;
    if (!conn || !conn.live || isBinary) return;
    if (data.length > this.limits.frameBytes) {
      const id = peekFrameId(data.subarray(0, 256).toString('utf8'));
      log.warn(`desktop sent a ${data.length}-byte frame; refused`);
      if (id !== null) conn.send({ t: 'result', id, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    const parsed = parseFrame(data, this.limits.frameBytes);
    if (parsed.error) {
      log.warn('dropped a malformed frame from the desktop');
      return;
    }
    await this.dispatcher.handleFrame(conn, parsed.frame);
  }

  _onClose(state) {
    this.sockets.delete(state.ws);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this._removePreAuth(state);
    state.stage = 'closed';
    const conn = state.conn;
    if (!conn) return;
    state.conn = null;
    if (this.live === conn) this.live = null;
    conn.markGone();
    Promise.resolve(this.dispatcher.onDisconnect(conn)).catch((err) => log.warn(`desktop disconnect cleanup failed: ${err.message}`));
    log.info(`desktop "${conn.label}" disconnected`);
    this.emit('disconnected', { deviceId: conn.deviceId, label: conn.label });
  }

  _fields(state) {
    return { nodeId: this.identity.nodeId, deviceId: state.deviceId, port: this.port, serverNonce: state.serverNonce, clientNonce: state.clientNonce };
  }

  _send(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    let text = JSON.stringify(obj);
    if (Buffer.byteLength(text) > this.limits.frameBytes) {
      if (obj.t !== 'result') {
        log.warn(`dropped an oversized ${obj.t} frame${obj.channel ? ` on ${obj.channel}` : ''}`);
        return false;
      }
      text = JSON.stringify({ t: 'result', id: obj.id, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    ws.send(text);
    return true;
  }

  _sendRaw(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  _close(state, code, reason) {
    if (state.stage === 'closed') return undefined;
    state.stage = 'closed';
    state.timers.forEach(clearTimeout);
    state.timers = [];
    this._removePreAuth(state);
    try { state.ws.close(code, String(reason).slice(0, 120)); } catch { /* gone */ }
    const kill = setTimeout(() => { try { state.ws.terminate(); } catch { /* gone */ } }, 1000);
    kill.unref?.();
    return undefined;
  }

  _removePreAuth(state) {
    const i = this.preAuth.indexOf(state);
    if (i !== -1) this.preAuth.splice(i, 1);
  }

  _lookupDevice(deviceId) {
    const file = path.join(this.configDir, DEVICES_FILE);
    try {
      if (!fs.existsSync(file)) return null;
      assertAdminOwned(file, this.geteuid, this.adminUid, DEVICES_CONTROLS);
      return findDevice(parseDevices(fs.readFileSync(file, 'utf8')), deviceId);
    } catch (err) {
      log.error(`refusing desktop handshakes: ${err.message}`);
      return null;
    }
  }

  _recheckLive() {
    const conn = this.live;
    if (conn && !this._lookupDevice(conn.deviceId)) {
      log.info(`desktop ${conn.deviceId} is no longer paired; closing it`);
      conn.close(CLOSE.UNKNOWN_DEVICE, 'unpaired');
    }
  }

  _recordFailure(deviceId) {
    const now = this.now();
    const recent = (this.failures.get(deviceId) || []).filter((t) => now - t < this.limits.failureWindowMs);
    recent.push(now);
    this.failures.delete(deviceId);
    if (recent.length >= this.limits.failuresPerDevice) {
      this.lockouts.set(deviceId, now + this.limits.lockoutMs);
      log.warn(`desktop ${deviceId} failed ${recent.length} handshakes; refusing it for ${Math.round(this.limits.lockoutMs / 1000)} s`);
      return;
    }
    this.failures.set(deviceId, recent);
    // Bounded: arbitrary device ids from a flood must not grow memory.
    while (this.failures.size > this.limits.maxTrackedFailures) this.failures.delete(this.failures.keys().next().value);
  }

  _lockedOut(deviceId) {
    const until = this.lockouts.get(deviceId);
    if (!until) return false;
    if (this.now() >= until) {
      this.lockouts.delete(deviceId);
      return false;
    }
    return true;
  }
}

module.exports = { DesktopBridgeServer };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-protocol.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/connection.js src/desktop-bridge/bridge-server.js tests/desktop-bridge-protocol.test.js
git commit -m "feat(desktop-bridge): loopback server with mutual Ed25519 handshake and limits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `DesktopBridgeClient`

**Files:**
- Create: `src/desktop-bridge/bridge-client.js`
- Modify: `tests/desktop-bridge-protocol.test.js` (append a `describe` block at the end of the file)
- Test: `tests/desktop-bridge-protocol.test.js`

**Interfaces:**
- Consumes: Task 2 (`protocol.js`, `keys.js`), Task 3 (`isTimeoutExempt`), `deriveNodeId` (`src/mesh/node-identity.js`), Task 4's server in tests.
- Produces: `class DesktopBridgeClient extends EventEmitter` — `constructor({ host = '127.0.0.1', port, getPort = null, pin: { nodeId, publicKey }, deviceId, sign, backoffMs = [1000, 2000, 4000, 8000, 16000, 30000], jitter = 0.2, random = Math.random, defaultTimeoutMs = 120000, handshakeTimeoutMs = 10000 })`; `connect() → Promise<service>` (rejects with `BridgeError`; schedules a retry unless the error is fatal or `close()` was called); `retryNow()`; `invoke(channel, args, { timeoutMs }) → Promise<value>`; `send(channel, args) → boolean`; `call(method, params, { timeoutMs }) → Promise<value>`; `close()`; properties `status` (`idle | connecting | connected | disconnected | failed | stopped`), `connected`, `service`, `lastError`, `nextRetryAt`, `port`; events `'event' (channel, payload)`, `'state' ({ status, code, error, service, nextRetryAt })`. Fatal codes (no retry until `retryNow`): `DEVICE_UNPAIRED`, `PROTOCOL_MISMATCH`, `ANOTHER_DEVICE`, `SERVICE_KEY_CHANGED`.

- [ ] **Step 1: Write the failing test**

Append to `tests/desktop-bridge-protocol.test.js`:

```js
const { DesktopBridgeClient } = require('../src/desktop-bridge/bridge-client');

function clientFor(port, device, extra = {}) {
  return new DesktopBridgeClient({
    port,
    pin: { nodeId: identity.nodeId, publicKey: identity.publicKey.toString('hex') },
    deviceId: device.deviceId,
    sign: async (bytes) => crypto.sign(null, bytes, device.privateKey),
    ...extra
  });
}

// A fake service that sends a challenge for the pinned node and a garbage hello.
async function impostorServer({ nodeId = identity.nodeId } = {}) {
  const frames = [];
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'challenge', protocol: 1, nodeId, serverNonce: newNonce() }));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      frames.push(frame.t);
      if (frame.t === 'clientHello') ws.send(JSON.stringify({ t: 'hello', sig: keys.toB64url(crypto.randomBytes(64)) }));
    });
  });
  return { frames, port: wss.address().port, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

describe('DesktopBridgeClient', () => {
  it('connects, invokes and receives events', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const client = clientFor(port, device);
    const service = await client.connect();
    assert.strictEqual(service.nodeId, identity.nodeId);
    assert.strictEqual(client.connected, true);
    assert.deepStrictEqual(await client.invoke('chat:load', []), { ok: true, data: { echo: [] } });
    client.close();
    assert.strictEqual(client.status, 'stopped');
  });

  it('never sends auth when hello.sig does not verify', async () => {
    const fake = await impostorServer();
    const client = clientFor(fake.port, makeDevice());
    await assert.rejects(client.connect(), (err) => err.code === 'SERVICE_KEY_CHANGED');
    assert.deepStrictEqual(fake.frames, ['clientHello'], 'no auth frame, so no device signature leaves');
    assert.strictEqual(client.status, 'failed');
    client.close();
    await fake.close();
  });

  it('closes before saying anything when the challenge names another node', async () => {
    const fake = await impostorServer({ nodeId: 'kl-aaaaaaaaaaaaaaaa' });
    const client = clientFor(fake.port, makeDevice());
    await assert.rejects(client.connect(), (err) => err.code === 'SERVICE_KEY_CHANGED' && /changed from kl-/.test(err.message));
    assert.deepStrictEqual(fake.frames, []);
    client.close();
    await fake.close();
  });

  it('client ignores HTTP_PROXY', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY };
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.ALL_PROXY = 'http://127.0.0.1:9';
    try {
      const client = clientFor(port, device);
      assert.strictEqual((await client.connect()).nodeId, identity.nodeId);
      client.close();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    assert.throws(() => new DesktopBridgeClient({ host: 'localhost', port, pin: { nodeId: identity.nodeId, publicKey: 'aa' }, deviceId: device.deviceId, sign: () => {} }), /127\.0\.0\.1/);
  });

  it('times out ordinary calls but not chat:sendMessage', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [device] });
    const client = clientFor(port, device, { defaultTimeoutMs: 50 });
    await client.connect();
    // The fake dispatcher answers chat:sendMessage after 200 ms, well past the 50 ms default.
    assert.deepStrictEqual(await client.invoke('chat:sendMessage', [{ chatId: 'c1' }]), { ok: true, data: { echo: [{ chatId: 'c1' }] } });
    const slow = await startServer({ devices: [device] });
    slow.dispatcher.handleFrame = async (conn, frame) => { await new Promise((r) => setTimeout(r, 200)); conn.send({ t: 'result', id: frame.id, value: 'late' }); };
    const client2 = clientFor(slow.port, device, { defaultTimeoutMs: 50 });
    await client2.connect();
    await assert.rejects(client2.invoke('chat:load', []), (err) => err.code === 'BRIDGE_TIMEOUT' && err.message === 'The local service did not answer in time.');
    assert.strictEqual(await client2.invoke('chat:sendMessage', [{ chatId: 'c1' }]), 'late');
    client.close();
    client2.close();
  });

  it('rejects pending calls on disconnect and reconnects to a restarted service', async () => {
    const device = makeDevice();
    const first = await startServer({ devices: [device] });
    let currentPort = first.port;
    const client = clientFor(first.port, device, { backoffMs: [20], getPort: async () => currentPort });
    await client.connect();
    const states = [];
    client.on('state', (s) => states.push(s.status));
    first.dispatcher.handleFrame = async () => {};
    const pending = client.invoke('chat:load', []);
    await first.server.stop();
    await assert.rejects(pending, (err) => err.code === 'SERVICE_UNREACHABLE');
    const second = await startServer({ devices: [device] });
    currentPort = second.port;
    await new Promise((resolve) => { const check = () => (client.connected ? resolve() : setTimeout(check, 10)); check(); });
    assert.ok(states.includes('disconnected'));
    assert.strictEqual(client.port, second.port, 'the port is re-read before every reconnect');
    client.close();
  });

  it('stops retrying once the device is unpaired (4403)', async () => {
    const device = makeDevice();
    const { port } = await startServer({ devices: [] });
    const client = clientFor(port, device, { backoffMs: [20] });
    await assert.rejects(client.connect(), (err) => err.code === 'DEVICE_UNPAIRED'
      && err.message === 'The service does not know this desktop. Pair again in Settings > Local service.');
    assert.strictEqual(client.status, 'failed');
    assert.strictEqual(client.nextRetryAt, null);
    client.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-protocol.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/bridge-client'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/bridge-client.js`:

```js
// The desktop's side of the bridge (fleet stage 7 §3.7). Electron-free: the
// attached host hands it a `sign` function that unseals the device key only
// for the moment of signing. It dials the literal 127.0.0.1 with no agent, so
// proxy environment variables never apply.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('../logging');
const { deriveNodeId } = require('../mesh/node-identity');
const { PROTOCOL, LIMITS, newNonce, buildAuthS, buildAuthC, BridgeError, MESSAGES } = require('./protocol');
const { fromB64url, verifyWithSpkiHex } = require('./keys');
const { isTimeoutExempt } = require('./allowlist');

const log = createLogger('desktop-bridge-client');
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
const FATAL = new Set(['DEVICE_UNPAIRED', 'PROTOCOL_MISMATCH', 'ANOTHER_DEVICE', 'SERVICE_KEY_CHANGED']);

function safeNodeId(publicKeyHex) {
  try {
    return deriveNodeId(publicKeyHex);
  } catch {
    return null;
  }
}

function errorForClose(code, reason, port) {
  switch (code) {
    case 4401: return new BridgeError('BAD_SIGNATURE', MESSAGES.BAD_SIGNATURE);
    case 4403: return new BridgeError('DEVICE_UNPAIRED', MESSAGES.DEVICE_UNPAIRED);
    case 4409: return new BridgeError('ANOTHER_DEVICE', MESSAGES.ANOTHER_DEVICE(reason || 'unknown'));
    case 4426: return new BridgeError('PROTOCOL_MISMATCH', MESSAGES.PROTOCOL_MISMATCH(reason || 'another version'));
    case 4429: return new BridgeError('LOCKED_OUT', MESSAGES.LOCKED_OUT);
    case 4400: return new BridgeError('MALFORMED', MESSAGES.MALFORMED);
    default: return new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port));
  }
}

class DesktopBridgeClient extends EventEmitter {
  constructor({
    host = '127.0.0.1', port, getPort = null, pin, deviceId, sign,
    backoffMs = DEFAULT_BACKOFF_MS, jitter = 0.2, random = Math.random,
    defaultTimeoutMs = 120000, handshakeTimeoutMs = LIMITS.handshakeMs
  } = {}) {
    super();
    if (host !== '127.0.0.1') throw new Error('DesktopBridgeClient connects only to 127.0.0.1');
    if (!pin || !pin.nodeId || !pin.publicKey) throw new Error('DesktopBridgeClient needs the pinned service key');
    if (typeof sign !== 'function') throw new Error('DesktopBridgeClient needs a sign function');
    this.port = port;
    this.getPort = getPort;
    this.pin = pin;
    this.deviceId = deviceId;
    this.sign = sign;
    this.backoffMs = backoffMs;
    this.jitter = jitter;
    this.random = random;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.ws = null;
    this.service = null;
    this.status = 'idle';
    this.lastError = null;
    this.nextRetryAt = null;
    this.nextId = 1;
    this.pending = new Map();
    this.attempt = 0;
    this.retryTimer = null;
    this.stopped = false;
    this.held = false;
    this.connecting = null;
  }

  get connected() {
    return this.status === 'connected' && Boolean(this.ws);
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = this._attempt().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  retryNow() {
    this.held = false;
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    return this.connect();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, 'closed by the desktop'); } catch { /* gone */ } }
    this._rejectPending(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    this._setState('stopped');
  }

  invoke(channel, args = [], { timeoutMs } = {}) {
    const limit = isTimeoutExempt(channel) ? 0 : (timeoutMs ?? this.defaultTimeoutMs);
    return this._request({ t: 'invoke', channel, args: Array.isArray(args) ? args : [args] }, limit);
  }

  call(method, params = {}, { timeoutMs } = {}) {
    return this._request({ t: 'call', method, params }, timeoutMs ?? this.defaultTimeoutMs);
  }

  send(channel, args = []) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({ t: 'send', channel, args: Array.isArray(args) ? args : [args] }));
    return true;
  }

  _request(frame, limit) {
    if (!this.connected) return Promise.reject(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BridgeError('BRIDGE_TIMEOUT', MESSAGES.BRIDGE_TIMEOUT));
        }, limit);
      }
      this.pending.set(id, entry);
      // `t` then `id` first: the server reads the id of an oversized frame from its prefix.
      this.ws.send(JSON.stringify({ t: frame.t, id, ...frame }));
    });
  }

  async _attempt() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    this._setState('connecting');
    try {
      if (this.getPort) this.port = await this.getPort();
      const service = await this._handshake(this.port);
      this.attempt = 0;
      this.service = service;
      this.lastError = null;
      this._setState('connected');
      return service;
    } catch (err) {
      const error = err instanceof BridgeError ? err : new BridgeError(err.code || 'SERVICE_UNREACHABLE', err.message);
      this.lastError = error;
      if (FATAL.has(error.code)) this.held = true;
      this._scheduleRetry();
      this._setState(this.stopped ? 'stopped' : (this.held ? 'failed' : 'disconnected'));
      throw error;
    }
  }

  _scheduleRetry() {
    if (this.stopped || this.held || this.retryTimer) return;
    const base = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt += 1;
    const wait = Math.max(0, Math.round(base * (1 + this.jitter * (2 * this.random() - 1))));
    this.nextRetryAt = Date.now() + wait;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => {});
    }, wait);
    this.retryTimer.unref?.();
  }

  _handshake(port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
        perMessageDeflate: false,
        maxPayload: LIMITS.wsMaxPayload,
        handshakeTimeout: this.handshakeTimeoutMs
      });
      let stage = 'challenge';
      let settled = false;
      let fields = null;
      const timer = setTimeout(() => fail(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port))), this.handshakeTimeoutMs);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.terminate(); } catch { /* gone */ }
        reject(err);
      };
      const malformed = () => fail(new BridgeError('MALFORMED', MESSAGES.MALFORMED));
      ws.on('message', async (data) => {
        if (stage === 'ready') { this._onFrame(ws, data); return; }
        let frame;
        try { frame = JSON.parse(data.toString('utf8')); } catch { malformed(); return; }
        try {
          if (stage === 'challenge') {
            if (frame.t !== 'challenge') { malformed(); return; }
            if (frame.protocol !== PROTOCOL) { fail(new BridgeError('PROTOCOL_MISMATCH', MESSAGES.PROTOCOL_MISMATCH(frame.protocol))); return; }
            if (frame.nodeId !== this.pin.nodeId || safeNodeId(this.pin.publicKey) !== this.pin.nodeId) {
              fail(new BridgeError('SERVICE_KEY_CHANGED', MESSAGES.SERVICE_KEY_CHANGED(this.pin.nodeId, frame.nodeId)));
              return;
            }
            fields = { nodeId: this.pin.nodeId, deviceId: this.deviceId, port, serverNonce: frame.serverNonce, clientNonce: newNonce() };
            buildAuthS(fields); // validates the server nonce
            stage = 'hello';
            ws.send(JSON.stringify({ t: 'clientHello', protocol: PROTOCOL, deviceId: this.deviceId, clientNonce: fields.clientNonce }));
          } else if (stage === 'hello') {
            if (frame.t !== 'hello' || typeof frame.sig !== 'string') { malformed(); return; }
            let sig;
            try { sig = fromB64url(frame.sig); } catch { sig = Buffer.alloc(0); }
            if (!verifyWithSpkiHex(this.pin.publicKey, Buffer.from(buildAuthS(fields), 'utf8'), sig)) {
              fail(new BridgeError('SERVICE_KEY_CHANGED', MESSAGES.SERVICE_KEY_CHANGED(this.pin.nodeId, 'a key this desktop did not pin')));
              return;
            }
            stage = 'auth';
            const mine = await this.sign(Buffer.from(buildAuthC(fields), 'utf8'));
            if (settled) return;
            ws.send(JSON.stringify({ t: 'auth', sig: Buffer.from(mine).toString('base64url') }));
          } else if (stage === 'auth') {
            if (frame.t !== 'ready' || !frame.service) { malformed(); return; }
            stage = 'ready';
            settled = true;
            clearTimeout(timer);
            this.ws = ws;
            resolve(frame.service);
          }
        } catch (err) {
          fail(err instanceof BridgeError ? err : new BridgeError('MALFORMED', err.message));
        }
      });
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
        if (stage !== 'ready') { fail(errorForClose(code, reason, port)); return; }
        this._onDisconnected(ws, code, reason);
      });
      ws.on('unexpected-response', (_req, res) => fail(new BridgeError('SERVICE_UNREACHABLE', `The local service refused the connection (HTTP ${res.statusCode}).`)));
      ws.on('error', (err) => {
        if (!settled) fail(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(port)));
        else log.debug(`desktop bridge socket error: ${err.message}`);
      });
    });
  }

  _onFrame(ws, data) {
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch { log.warn('the service sent a malformed frame'); return; }
    if (frame.t === 'result') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error !== undefined) entry.reject(new BridgeError(frame.code || 'SERVICE_ERROR', frame.error));
      else entry.resolve(frame.value);
    } else if (frame.t === 'event') {
      this.emit('event', frame.channel, frame.payload);
    } else if (frame.t === 'bye') {
      log.info(`the local service is stopping (${frame.code})`);
    }
  }

  _onDisconnected(ws, code, reason) {
    if (this.ws !== ws) return;
    this.ws = null;
    this._rejectPending(new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port)));
    if (this.stopped) return;
    if (code === 4403 || code === 4409) {
      this.lastError = errorForClose(code, reason, this.port);
      this.held = true;
    } else {
      this.lastError = new BridgeError('SERVICE_UNREACHABLE', MESSAGES.SERVICE_UNREACHABLE(this.port));
    }
    this._scheduleRetry();
    this._setState(this.held ? 'failed' : 'disconnected');
  }

  _rejectPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  _setState(status) {
    this.status = status;
    this.emit('state', {
      status,
      code: this.lastError ? this.lastError.code : null,
      error: this.lastError ? this.lastError.message : null,
      service: this.service,
      nextRetryAt: this.nextRetryAt
    });
  }
}

module.exports = { DesktopBridgeClient, DEFAULT_BACKOFF_MS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-protocol.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/bridge-client.js tests/desktop-bridge-protocol.test.js
git commit -m "feat(desktop-bridge): client with pinned service key, timeouts and backoff

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Desktop-scoped directories and rules, and `checkPath`

**Files:**
- Create: `src/desktop-bridge/desktop-scope.js`, `src/desktop-bridge/check-path.js`
- Test: `tests/desktop-bridge-scope.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 2), `MESSAGES.RULE_NOT_DESKTOP` (Task 2); a context with `getSettings()`, `setSettings(s)`, `addPermissionRule(rule)`, `removePermissionRule(tool, pattern, action)` (`core.context`).
- Produces:
  - `createDesktopScope({ dataDir, context, onPathWritten = () => {} }) → { getSettings, setSettings, addDirectory(dir) → string[], listDirectories(), addPermissionRule(rule), removePermissionRule(tool, pattern, action), listRules() }`. Files: `<dataDir>/desktop/allowed-directories.json` (`{ v: 1, directories }`), `<dataDir>/desktop/rules.json` (`{ v: 1, rules }`). `removePermissionRule` of a rule the desktop did not add throws an `Error` with `code: 'RULE_NOT_DESKTOP'`.
  - `checkPath(target, { fsp }) → Promise<{ ok: true, exists, isDirectory, readable, writable }>` — tested by doing (opendir/open/probe file), not by `fs.access`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-bridge-scope.test.js`:

```js
// tests/desktop-bridge-scope.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-scope-')); dirs.push(d); return d; };

function fakeContext() {
  let settings = { allowedDirectories: ['/srv/service-only'], inference: { activeTier: 'standard' } };
  let rules = [];
  return {
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    setSettings: (next) => { settings = JSON.parse(JSON.stringify(next)); },
    getPermissionRules: () => rules,
    addPermissionRule: (rule) => { rules = rules.filter((r) => !(r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action)); rules.push({ ...rule }); },
    removePermissionRule: (tool, pattern, action) => { rules = rules.filter((r) => !(r.tool === tool && (r.pattern || '*') === (pattern || '*') && r.action === action)); },
    peek: () => ({ settings, rules })
  };
}

describe('desktop-scoped settings', () => {
  it('adds desktop directories to what marked runs read, never to the service settings', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    assert.deepStrictEqual(scope.addDirectory('/home/example/projects'), ['/srv/service-only', '/home/example/projects']);
    assert.deepStrictEqual(scope.getSettings().allowedDirectories, ['/srv/service-only', '/home/example/projects']);
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, ['/srv/service-only']);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop', 'allowed-directories.json'), 'utf8'));
    assert.deepStrictEqual(file, { v: 1, directories: ['/home/example/projects'] });
  });

  it('diverts allowedDirectories writes and passes every other key through', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    const next = scope.getSettings();
    next.allowedDirectories = ['/srv/service-only', '/data/example'];
    next.inference = { activeTier: 'smart' };
    scope.setSettings(next);
    assert.deepStrictEqual(context.peek().settings, { allowedDirectories: ['/srv/service-only'], inference: { activeTier: 'smart' } });
    assert.deepStrictEqual(scope.listDirectories(), ['/data/example']);
    // The desktop cannot remove a service directory: it stays.
    scope.setSettings({ ...scope.getSettings(), allowedDirectories: [] });
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, ['/srv/service-only']);
    assert.deepStrictEqual(scope.listDirectories(), []);
  });

  it('records rules the desktop adds and refuses to remove any other', () => {
    const dataDir = tmp();
    const context = fakeContext();
    context.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'service' });
    const scope = createDesktopScope({ dataDir, context });
    scope.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog' });
    assert.deepStrictEqual(scope.listRules(), [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]);
    assert.throws(() => scope.removePermissionRule('Bash', 'rm *', 'deny'),
      (err) => err.code === 'RULE_NOT_DESKTOP' && err.message === 'This rule was set on the service and can only be removed there.');
    assert.ok(context.peek().rules.some((r) => r.pattern === 'rm *'), 'the deny rule is still there');
    scope.removePermissionRule('Bash', 'git *', 'allow');
    assert.deepStrictEqual(scope.listRules(), []);
    assert.ok(!context.peek().rules.some((r) => r.pattern === 'git *'));
  });

  it('reports every path it writes', () => {
    const dataDir = tmp();
    const written = [];
    const scope = createDesktopScope({ dataDir, context: fakeContext(), onPathWritten: (p) => written.push(p) });
    scope.addDirectory('/data/example');
    assert.ok(written.includes(path.join(dataDir, 'desktop')));
    assert.ok(written.includes(path.join(dataDir, 'desktop', 'allowed-directories.json')));
  });
});

describe('checkPath', () => {
  it('reads and writes a directory by doing it, leaving no probe behind', async () => {
    const dir = tmp();
    assert.deepStrictEqual(await checkPath(dir), { ok: true, exists: true, isDirectory: true, readable: true, writable: true });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it('checks a file, and reports a missing or relative path as unreadable', async () => {
    const file = path.join(tmp(), 'notes.txt');
    fs.writeFileSync(file, 'x');
    assert.deepStrictEqual(await checkPath(file), { ok: true, exists: true, isDirectory: false, readable: true, writable: true });
    assert.deepStrictEqual(await checkPath(path.join(tmp(), 'missing')), { ok: true, exists: false, isDirectory: false, readable: false, writable: false });
    assert.strictEqual((await checkPath('relative/dir')).readable, false);
  });

  it('reports a read-only directory as not writable', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX, non-root only' : false }, async () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    try {
      const out = await checkPath(dir);
      assert.strictEqual(out.readable, true);
      assert.strictEqual(out.writable, false);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-scope.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/desktop-scope'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/desktop-scope.js`:

```js
// Desktop-scoped widening (fleet stage 7 §3.4, §8). Directories the desktop
// allows and rules it adds apply to desktop runs only: these wrappers exist
// only in the bridge dispatcher's context, so only marked runs see them.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./pairing');
const { MESSAGES } = require('./protocol');

const DIRS_FILE = 'allowed-directories.json';
const RULES_FILE = 'rules.json';

function createDesktopScope({ dataDir, context, onPathWritten = () => {} }) {
  const dir = path.join(dataDir, 'desktop');

  const read = (name, key) => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      return Array.isArray(doc[key]) ? doc[key] : [];
    } catch {
      return [];
    }
  };
  const write = (name, key, list) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    onPathWritten(dir);
    const file = path.join(dir, name);
    writeFileAtomic(file, `${JSON.stringify({ v: 1, [key]: list }, null, 2)}\n`, 0o600);
    onPathWritten(file);
  };

  const serviceDirectories = () => {
    const s = context.getSettings();
    return Array.isArray(s.allowedDirectories) ? s.allowedDirectories : [];
  };
  const listDirectories = () => read(DIRS_FILE, 'directories').filter((d) => typeof d === 'string' && d);

  const getSettings = () => {
    const s = context.getSettings();
    const own = Array.isArray(s.allowedDirectories) ? s.allowedDirectories : [];
    return { ...s, allowedDirectories: [...own, ...listDirectories().filter((d) => !own.includes(d))] };
  };

  const setSettings = (next = {}) => {
    const own = serviceDirectories();
    const incoming = Array.isArray(next.allowedDirectories) ? next.allowedDirectories : [];
    const desktopOnly = [...new Set(incoming.filter((d) => typeof d === 'string' && d && !own.includes(d)))];
    write(DIRS_FILE, 'directories', desktopOnly);
    return context.setSettings({ ...next, allowedDirectories: own });
  };

  const addDirectory = (directory) => {
    const list = listDirectories();
    if (!list.includes(directory) && !serviceDirectories().includes(directory)) {
      list.push(directory);
      write(DIRS_FILE, 'directories', list);
    }
    return getSettings().allowedDirectories;
  };

  const ruleKey = (tool, pattern, action) => `${tool}\u0000${pattern || '*'}\u0000${action}`;
  const listRules = () => read(RULES_FILE, 'rules').filter((r) => r && r.tool && r.action);

  const addPermissionRule = (rule) => {
    if (!rule || !rule.tool || !rule.action) return;
    context.addPermissionRule(rule);
    const key = ruleKey(rule.tool, rule.pattern, rule.action);
    const rules = listRules().filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key);
    rules.push({ tool: rule.tool, pattern: rule.pattern || '*', action: rule.action });
    write(RULES_FILE, 'rules', rules);
  };

  const removePermissionRule = (tool, pattern, action) => {
    const key = ruleKey(tool, pattern, action);
    const rules = listRules();
    if (!rules.some((r) => ruleKey(r.tool, r.pattern, r.action) === key)) {
      const err = new Error(MESSAGES.RULE_NOT_DESKTOP);
      err.code = 'RULE_NOT_DESKTOP';
      throw err;
    }
    context.removePermissionRule(tool, pattern, action);
    write(RULES_FILE, 'rules', rules.filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key));
  };

  return { getSettings, setSettings, addDirectory, listDirectories, addPermissionRule, removePermissionRule, listRules };
}

module.exports = { createDesktopScope };
```

Create `src/desktop-bridge/check-path.js`:

```js
// Whether the service account can read/write a path, found out by doing it:
// fs.access ignores Windows ACLs (fleet stage 7 §3.4 bridge.checkPath).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NOT_THERE = Object.freeze({ ok: true, exists: false, isDirectory: false, readable: false, writable: false });

async function checkPath(target, { fsp = fs.promises } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) return { ...NOT_THERE };
  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    return { ...NOT_THERE };
  }
  const isDirectory = st.isDirectory();
  let readable = false;
  let writable = false;
  if (isDirectory) {
    try {
      const dir = await fsp.opendir(target);
      await dir.close();
      readable = true;
    } catch { /* not readable */ }
    const probe = path.join(target, `.kl-write-probe-${crypto.randomBytes(6).toString('hex')}`);
    let created = false;
    try {
      const handle = await fsp.open(probe, 'wx');
      created = true;
      await handle.close();
      writable = true;
    } catch { /* not writable */ }
    if (created) await fsp.rm(probe, { force: true }).catch(() => {});
  } else {
    try {
      const handle = await fsp.open(target, 'r');
      await handle.close();
      readable = true;
    } catch { /* not readable */ }
    try {
      const handle = await fsp.open(target, 'r+');
      await handle.close();
      writable = true;
    } catch { /* not writable */ }
  }
  return { ok: true, exists: true, isDirectory, readable, writable };
}

module.exports = { checkPath };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-scope.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/desktop-scope.js src/desktop-bridge/check-path.js tests/desktop-bridge-scope.test.js
git commit -m "feat(desktop-bridge): desktop-scoped directories and rules, checkPath by doing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 2 (exact exports after Part 1 merges)

| Module | Exports |
|---|---|
| `src/core/origin.js` | `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn, { deviceId })`, `isLocalRequester(fn)` |
| `src/core/create-core.js` | seam: `local = isLocalDesktopEvent(event) \|\| isLocalRequester(approvalRequester)`; `denyAutoApproval = (remoteApprovals !== 'allow' && !local) \|\| executorOptions.denyAutoApproval === true` (or F3's `approvalSeam`) |
| `src/desktop-bridge/keys.js` | `toB64url`, `fromB64url`, `deriveDeviceId`, `ed25519RawToSpki`, `localDeriveDeviceId`, `localEd25519RawToSpki`, `rawFromPublicKeyObject`, `verifyWithRawKey`, `verifyWithSpkiHex`, `fingerprintGroups`, `ED25519_SPKI_PREFIX` |
| `src/desktop-bridge/protocol.js` | `PROTOCOL`, `DEFAULT_DESKTOP_BRIDGE_PORT`, `LIMITS`, `CLOSE`, `NODE_ID_RE`, `DEVICE_ID_RE`, `NONCE_RE`, `newNonce`, `buildAuthS`, `buildAuthC`, `parseFrame`, `peekFrameId`, `BridgeError`, `MESSAGES` |
| `src/desktop-bridge/pairing.js` | `PAIR_PREFIX`, `DEVICES_FILE`, `BRIDGE_FILE`, `DEVICES_CONTROLS`, `ADMIN_OWNER_SIDS`, `PairingError`, `defaultDeviceLabel`, `encodePairRequest`, `decodePairRequest`, `emptyDevices`, `validateDevices`, `parseDevices`, `upsertDevice`, `removeDevice`, `findDevice`, `bridgeFileRecord`, `parseBridgeFile`, `writeFileAtomic`, `bridgeFilePath`, `inspectWindowsOwners`, `checkBridgeFileTrust`, `readTrustedBridgeFile` |
| `src/desktop-bridge/allowlist.js` | `PROXIED_DOMAINS`, `PROXIED_CHANNELS`, `PRESTEP_CHANNELS`, `RENDERER_EVENTS`, `PROMPT_EVENTS`, `ATTACHED_UNAVAILABLE_TABS`, `classifyChannel`, `servedChannels`, `isRendererEvent`, `isTimeoutExempt` |
| `src/desktop-bridge/connection.js` | `createConnection({ deviceId, label, send, close })` |
| `src/desktop-bridge/bridge-server.js` | `DesktopBridgeServer` (dispatcher contract: `{ served, providersConfigured(), handleFrame(conn, frame), onDisconnect(conn), forwardAmbient(channel, payload) }`, default factory `require('./bridge-dispatcher').createBridgeDispatcher(opts)`) |
| `src/desktop-bridge/bridge-client.js` | `DesktopBridgeClient`, `DEFAULT_BACKOFF_MS` |
| `src/desktop-bridge/desktop-scope.js` | `createDesktopScope({ dataDir, context, onPathWritten })` |
| `src/desktop-bridge/check-path.js` | `checkPath(target, { fsp })` |
| `src/ipc/channel-inventory.js` | `listIpcChannels()` |
| `src/ipc/desktop-handlers.js` | `DESKTOP_METHODS`, `createDesktopHandler(channel, getController)`, `registerDesktopHandlers(ipcMain, context)` |
| `src/ipc/constants.js` | adds `DESKTOP_STATUS`, `DESKTOP_PAIR_START`, `DESKTOP_PAIR_CONFIRM`, `DESKTOP_PAIR_CANCEL`, `DESKTOP_ATTACH`, `DESKTOP_DETACH`, `DESKTOP_STANDALONE_ONCE`, `DESKTOP_UNPAIR`, `DESKTOP_IMPORT_PLAN`, `DESKTOP_IMPORT_APPLY`, `DESKTOP_RETRY`, `DESKTOP_STATUS_CHANGED`, `DESKTOP_IMPORT_PROGRESS` |
| `src/service/installers.js` | adds `WINDOWS_INSPECT_CSHARP` |
| tests | `tests/core-origin.test.js`, `tests/desktop-pairing.test.js`, `tests/desktop-bridge-allowlist.test.js`, `tests/desktop-bridge-protocol.test.js`, `tests/desktop-bridge-scope.test.js` |
