# Fleet Stage 7: The desktop app as a window onto the local service — Implementation Plan (Part 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the service side of attached mode: the bridge dispatcher, the import engine with its safe source walker, the `desktop` and `import` CLI commands, and the service wiring behind `features.desktopBridge`.
**Architecture:** Builds on Part 1 (merged: `src/core/origin.js`, `src/desktop-bridge/{keys,protocol,pairing,allowlist,connection,bridge-server,bridge-client,desktop-scope,check-path}.js`, `src/ipc/{channel-inventory,desktop-handlers}.js`). Adds `src/desktop-bridge/{bridge-dispatcher,service-wiring}.js`, `src/migration/{desktop-import,desktop-source}.js`, `src/service/commands/{admin-check,desktop,import}.js`, and additive hunks in `src/memory/memory-manager.js`, `src/service/{config,run,cli}.js`. Everything stays Electron-free. Part 3 (`docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part3.md`, Tasks 12–18) builds the Electron side after this part has merged.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `node:crypto`, `ws`. No new npm dependency.
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage7-desktop-ui.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md. **Part 1:** docs/superpowers/plans/2026-09-23-fleet-stage7-desktop-ui-part1.md (its hand-off table lists what this part consumes).

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

### Task 7: The bridge dispatcher

**Files:**
- Create: `src/desktop-bridge/bridge-dispatcher.js`
- Test: `tests/desktop-bridge-dispatcher.test.js`

**Interfaces:**
- Consumes: `registerHandlers` (`src/ipc/register.js`), `listIpcChannels` (Task 3), `servedChannels`/`isRendererEvent`/`PROMPT_EVENTS` (Task 3), `createElectronPrompter` (`src/platform/electron-prompter.js`), `markLocalDesktopEvent` (Task 1), `createDesktopScope`/`checkPath` (Task 6), `createConnection` shape (Task 4), `MESSAGES` (Task 2); `core.context`, `core.pendingCanvasJsResolvers`.
- Produces: `createBridgeDispatcher({ core, cipher, dataDir, approvals = null, account = null, getServiceInfo, getConnection, registerHandlers, listChannels, checkPath, createImporter = null }) → { served: { handle, on }, providersConfigured(), handleFrame(conn, frame), onDisconnect(conn), forwardAmbient(channel, payload), bridgeContext, scope }`; `approvalsStatus({ approvals, dataDir })`. `createImporter({ scope, checkPath }) → Promise<importer>` with `plan/apply/finish/expireConnection` (Task 8). Call methods: `bridge.status`, `bridge.checkPath`, `bridge.setWorkingDirectory`, `bridge.addAllowedDirectory`, `bridge.canvasJsResult`, `bridge.approvalsStatus`, `import.plan`, `import.apply`, `import.finish`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-bridge-dispatcher.test.js`:

```js
// tests/desktop-bridge-dispatcher.test.js
// A real service core ('deny', like the service) behind the dispatcher.
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
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { registerHandlers } = require('../src/ipc/register');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { servedChannels } = require('../src/desktop-bridge/allowlist');
const { createBridgeDispatcher, approvalsStatus } = require('../src/desktop-bridge/bridge-dispatcher');
const { createConnection } = require('../src/desktop-bridge/connection');
const { isLocalDesktopEvent, localDesktopDeviceId } = require('../src/core/origin');

const PROBE = 'KlTestBridgeProbe';
let probeRuns = 0;
const realOpenAI = ProviderFactory._registry.get('openai');

class FakeProvider {
  constructor() { this.calls = 0; }
  async sendMessageWithTools() {
    this.calls += 1;
    if (this.calls === 1) return { type: 'tool_use', toolName: PROBE, toolUseId: 'call_1', parameters: {} };
    return { type: 'text', content: 'finished' };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}

let core;
let dataDir;
const cipher = createAesGcmCipher(crypto.randomBytes(32));

before(async () => {
  ProviderFactory.registerProvider('openai', FakeProvider);
  toolRegistry.register(new Tool({
    name: PROBE,
    description: 'Test-only tool that requires approval.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => { probeRuns += 1; return { ok: true }; }
  }));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-'));
  core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher,
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals: 'deny'
  });
  const tiers = { provider: 'openai', model: 'fake' };
  const settings = core.getSettings();
  core.context.setSettings({
    ...settings,
    activeProvider: 'openai',
    inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
  });
  core.saveProviderToken('openai', 'fake-token-123456');
  await core.start();
});

after(async () => {
  await core.shutdown().catch(() => {});
  if (realOpenAI) ProviderFactory.registerProvider('openai', realOpenAI);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connection(label = 'desk a') {
  const sent = [];
  const conn = createConnection({ deviceId: `kld-${crypto.randomBytes(10).toString('hex').replace(/[^a-z2-7]/g, 'a').slice(0, 16).padEnd(16, 'a')}`, label, send: (f) => sent.push(f) });
  conn.sent = sent;
  return conn;
}

function makeDispatcher({ overrides = {}, coreOverride = null, approvals = null } = {}) {
  let current = null;
  const dispatcher = createBridgeDispatcher({
    core: coreOverride || core,
    cipher,
    dataDir,
    approvals,
    account: 'LOCAL SERVICE',
    getServiceInfo: () => ({ version: '26.9.0' }),
    getConnection: () => current,
    registerHandlers: (ipc, ctx) => {
      registerHandlers(ipc, ctx);
      for (const [channel, fn] of Object.entries(overrides)) ipc.handle(channel, fn);
    }
  });
  return { dispatcher, use: (conn) => { current = conn; } };
}

const waitFor = async (fn, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('waitFor timed out');
};
const resultFor = (conn, id) => conn.sent.find((f) => f.t === 'result' && f.id === id);

describe('bridge dispatcher', () => {
  it('serves (inventory ∩ allowlist) − prestep', () => {
    const { dispatcher } = makeDispatcher();
    const expected = servedChannels(listIpcChannels());
    assert.deepStrictEqual(dispatcher.served, expected);
    assert.ok(dispatcher.served.handle.includes('chat:load'));
    assert.ok(!dispatcher.served.handle.includes('chat:pickWorkingDirectory'));
    assert.ok(!dispatcher.served.handle.includes('desktop:status'));
    assert.strictEqual(dispatcher.providersConfigured(), true);
  });

  it('never reaches the handler of a denied channel', async () => {
    let called = 0;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'hooks:reload': async () => { called += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 1, channel: 'hooks:reload', args: [] });
    assert.strictEqual(called, 0);
    assert.strictEqual(resultFor(a, 1).code, 'CHANNEL_NOT_PROXIED');
  });

  it('marks every event with the connection device id', async () => {
    let seen = null;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'chat:load': async (event) => { seen = event; return { ok: true, data: [] }; } } });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 2, channel: 'chat:load', args: [] });
    assert.strictEqual(isLocalDesktopEvent(seen), true);
    assert.strictEqual(localDesktopDeviceId(seen), a.deviceId);
    assert.deepStrictEqual(resultFor(a, 2).value, { ok: true, data: [] });
  });

  it('ignores a prompt answer from a connection the prompt was not issued to', async () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection('desk a');
    const b = connection('desk b');
    use(a);
    const before = probeRuns;
    const running = dispatcher.handleFrame(a, { t: 'invoke', id: 3, channel: 'tool:execute', args: [{ toolName: PROBE, parameters: {} }] });
    const prompt = await waitFor(() => a.sent.find((f) => f.t === 'event' && f.channel === 'tool:approvalRequired'));
    use(b);
    await dispatcher.handleFrame(b, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(probeRuns, before, 'B cannot answer A\'s prompt');
    use(a);
    await dispatcher.handleFrame(a, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await running;
    assert.strictEqual(probeRuns, before + 1);
    assert.strictEqual(resultFor(a, 3).value.ok, true);
  });

  it('on disconnect stops that connection\'s runs and denies its prompts', async () => {
    const stops = new Map();
    const stopped = [];
    const { dispatcher, use } = makeDispatcher({
      overrides: {
        'chat:sendMessage': async (_event, { chatId }) => new Promise((resolve) => stops.set(chatId, resolve)),
        'chat:stopResponse': async (_event, { chatId }) => { stopped.push(chatId); stops.get(chatId)({ ok: true, data: null }); return { ok: true }; }
      }
    });
    core.context.setChats([{ id: 'c-run', title: 'Run', createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', messages: [] }]);
    const a = connection();
    use(a);
    const chat = dispatcher.handleFrame(a, { t: 'invoke', id: 4, channel: 'chat:sendMessage', args: [{ chatId: 'c-run', message: 'go' }] });
    const tool = dispatcher.handleFrame(a, { t: 'invoke', id: 5, channel: 'tool:execute', args: [{ toolName: PROBE, parameters: {} }] });
    await waitFor(() => a.sent.find((f) => f.t === 'event' && f.channel === 'tool:approvalRequired'));
    const ask = dispatcher.bridgeContext.prompter.askUser({ question: 'Which folder?' });
    a.markGone();
    await dispatcher.onDisconnect(a);
    await Promise.all([chat, tool]);
    assert.deepStrictEqual(stopped, ['c-run']);
    // tool:execute's wrapHandler wraps the executor's refusal in { ok: true, data }.
    assert.strictEqual(resultFor(a, 5).value.data.deniedBy, 'user');
    assert.deepStrictEqual(await ask, { ok: false, error: 'The desktop disconnected.' });
    const messages = core.context.getChats().find((c) => c.id === 'c-run').messages;
    assert.strictEqual(messages[messages.length - 1].text, 'The desktop disconnected; the run was stopped.');
  });

  it('forwards ambient events except prompts', () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    dispatcher.forwardAmbient('chat:updated', { chats: [] });
    dispatcher.forwardAmbient('tool:approvalRequired', { approvalId: 'x' });
    dispatcher.forwardAmbient('workflow:progress', {});
    assert.deepStrictEqual(a.sent.map((f) => f.channel), ['chat:updated']);
  });

  it('a desktop-added directory reaches a marked run\'s executor but not settings.allowedDirectories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-dir-'));
    let captured = null;
    const spyCore = {
      ...core,
      context: {
        ...core.context,
        createToolExecutorWithApprovals: async (event, _env, _requester, options) => { captured = { event, options }; throw new Error('captured'); }
      }
    };
    const { dispatcher, use } = makeDispatcher({ coreOverride: spyCore });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 6, method: 'bridge.addAllowedDirectory', params: { path: dir } });
    assert.ok(resultFor(a, 6).value.allowedDirectories.includes(dir));
    assert.ok(!core.context.getSettings().allowedDirectories.includes(dir));
    await dispatcher.handleFrame(a, { t: 'invoke', id: 7, channel: 'settings:load', args: [] });
    assert.ok(resultFor(a, 7).value.data.allowedDirectories.includes(dir));
    await dispatcher.handleFrame(a, { t: 'invoke', id: 8, channel: 'chat:create', args: ['Scoped'] });
    const chatId = resultFor(a, 8).value.data.id;
    await dispatcher.handleFrame(a, { t: 'invoke', id: 9, channel: 'chat:sendMessage', args: [{ chatId, message: 'hello' }] });
    assert.ok(captured, 'the chat turn built an executor');
    assert.ok(captured.options.allowedDirectories.includes(dir));
    assert.strictEqual(isLocalDesktopEvent(captured.event), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to remove a service-set deny rule', async () => {
    core.context.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'service' });
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 10, channel: 'tool:removePermissionRule', args: [{ tool: 'Bash', pattern: 'rm *', action: 'deny' }] });
    assert.strictEqual(resultFor(a, 10).code, 'RULE_NOT_DESKTOP');
    assert.ok(core.context.getPermissionRules().some((r) => r.pattern === 'rm *' && r.action === 'deny'));
  });

  it('negative: a gateway agent.execute while a desktop is connected is denied and shows no prompt', async () => {
    const { use } = makeDispatcher();
    const a = connection();
    use(a);
    const before = probeRuns;
    const gateway = core.context.getGatewayServer();
    const session = core.context.getSessionManager().getOrCreateSession('bridge-negative', 'main', { channel: 'test', peer: 'p', label: 'test' });
    const handlerCalls = [];
    const response = new Promise((resolve) => gateway.once('agent:response', resolve));
    gateway.emit('agent:message', {
      agentId: 'main',
      sessionKey: session.key,
      message: { runId: 'run-neg', message: 'please run the probe', approvalHandler: async (req) => { handlerCalls.push(req.toolName); return true; } }
    });
    await response;
    assert.strictEqual(probeRuns, before);
    assert.deepStrictEqual(handlerCalls, []);
    assert.ok(!a.sent.some((f) => f.channel === 'tool:approvalRequired'));
  });

  it('sets a working directory only when the service can read it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-wd-'));
    core.context.setChats([{ id: 'c-wd', title: 'WD', createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', messages: [] }]);
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 11, method: 'bridge.setWorkingDirectory', params: { chatId: 'c-wd', path: path.join(dir, 'missing') } });
    assert.strictEqual(resultFor(a, 11).code, 'PATH_NOT_ACCESSIBLE');
    assert.match(resultFor(a, 11).error, /The service runs as LOCAL SERVICE and cannot read/);
    await dispatcher.handleFrame(a, { t: 'call', id: 12, method: 'bridge.setWorkingDirectory', params: { chatId: 'c-wd', path: dir } });
    assert.strictEqual(resultFor(a, 12).value.data.workingDirectory, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves only canvas requests issued to this connection', async () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    let resolved = null;
    core.pendingCanvasJsResolvers.set('req-1', { resolve: (v) => { resolved = v; }, reject() {}, timeout: null });
    await dispatcher.handleFrame(a, { t: 'call', id: 13, method: 'bridge.canvasJsResult', params: { requestId: 'req-1', result: 42 } });
    assert.strictEqual(resultFor(a, 13).value.ok, false);
    a.prompts.canvas.add('req-1');
    await dispatcher.handleFrame(a, { t: 'call', id: 14, method: 'bridge.canvasJsResult', params: { requestId: 'req-1', result: 42 } });
    assert.deepStrictEqual(resolved, { action: 'execute_js', result: 42 });
  });

  it('reports approvals status, unavailable before fleet stage 3', async () => {
    assert.deepStrictEqual(approvalsStatus({ approvals: null, dataDir }), { available: false });
    fs.mkdirSync(path.join(dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' }));
    const stub = {
      approverStore: { list: () => [{ device_id: 'd-phonephonephone1', name: 'Phone', platform: 'android' }], isActive: () => true },
      phoneApprover: { pending: () => [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }] },
      auditLedger: { tail: () => [{ seq: 12, at: '2026-09-23T10:01:00Z' }] }
    };
    assert.deepStrictEqual(approvalsStatus({ approvals: stub, dataDir }), {
      available: true,
      relay: { configured: true, connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' },
      devices: [{ device_id: 'd-phonephonephone1', name: 'Phone', platform: 'android', active: true }],
      pending: [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }],
      audit: { last_seq: 12, last_at: '2026-09-23T10:01:00Z' }
    });
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 15, method: 'bridge.approvalsStatus', params: {} });
    assert.deepStrictEqual(resultFor(a, 15).value, { available: false });
    await dispatcher.handleFrame(a, { t: 'call', id: 16, method: 'import.plan', params: {} });
    assert.strictEqual(resultFor(a, 16).code, 'IMPORT_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-dispatcher.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/bridge-dispatcher'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/bridge-dispatcher.js`:

```js
// The service side of attached mode (fleet stage 7 §3.4). It registers the
// very handler modules the desktop runs against a virtual ipcMain, serves the
// allowlisted subset, builds a fresh marked event per call, and binds every
// prompt it forwards to the connection that saw it.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { registerHandlers: defaultRegisterHandlers } = require('../ipc/register');
const { listIpcChannels } = require('../ipc/channel-inventory');
const { createElectronPrompter } = require('../platform/electron-prompter');
const { markLocalDesktopEvent } = require('../core/origin');
const { servedChannels, isRendererEvent, PROMPT_EVENTS } = require('./allowlist');
const { createDesktopScope } = require('./desktop-scope');
const { checkPath: defaultCheckPath } = require('./check-path');
const { MESSAGES } = require('./protocol');

const log = createLogger('desktop-bridge');

// Which inbound send answers which forwarded prompt, and where its id lives.
const PROMPT_RESPONSES = Object.freeze({
  'tool:approvalResponse': ['approvals', 'approvalId'],
  'tool:directoryAccessResponse': ['directory', 'requestId'],
  'agent:userResponse': ['askUser', 'requestId']
});

const fail = (code, message) => Object.assign(new Error(message), { code });

// Settings > Local service "Approvals and relay" (spec §3.9), read from F3's
// startApprovals objects; { available: false } until F3 has merged.
function approvalsStatus({ approvals, dataDir }) {
  if (!approvals || !approvals.approverStore || !approvals.phoneApprover) return { available: false };
  let link = null;
  try {
    link = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
  } catch {
    link = null;
  }
  const store = approvals.approverStore;
  const devices = (store.list() || []).map((r) => ({
    device_id: r.device_id,
    name: r.name || null,
    platform: r.platform || null,
    active: typeof store.isActive === 'function' ? Boolean(store.isActive(r.device_id)) : true
  }));
  const pending = typeof approvals.phoneApprover.pending === 'function' ? approvals.phoneApprover.pending() : [];
  const tail = approvals.auditLedger && typeof approvals.auditLedger.tail === 'function' ? approvals.auditLedger.tail(1) : [];
  const last = Array.isArray(tail) && tail.length ? tail[tail.length - 1] : null;
  return {
    available: true,
    relay: {
      configured: Boolean(link || approvals.relayClient),
      connected: Boolean(link && link.connected),
      since: (link && link.since) || null,
      relay_id: (link && link.relay_id) || null
    },
    devices,
    pending: pending.map((p) => ({ request_id: p.request_id, summary: p.summary, expires_at: p.expires_at })),
    audit: { last_seq: last ? last.seq : null, last_at: last ? last.at : null }
  };
}

function createBridgeDispatcher({
  core, cipher = null, dataDir, approvals = null, account = null,
  getServiceInfo = () => ({}), getConnection = () => null,
  registerHandlers = defaultRegisterHandlers, listChannels = listIpcChannels,
  checkPath = defaultCheckPath, createImporter = null
}) {
  const context = core.context;
  const handlers = new Map();
  const listeners = new Map();
  const virtualIpcMain = {
    handle: (channel, fn) => { handlers.set(channel, fn); },
    on: (channel, fn) => { listeners.set(channel, fn); },
    removeHandler: (channel) => { handlers.delete(channel); }
  };
  const pendingAskUserResolvers = new Map();
  const pendingDirectoryAccessResolvers = new Map();
  const scope = createDesktopScope({ dataDir, context });

  const pushEvent = (conn, channel, payload) => {
    if (!conn || !conn.live || !isRendererEvent(channel)) return;
    if (payload && channel === 'tool:approvalRequired') conn.prompts.approvals.add(payload.approvalId);
    if (payload && channel === 'agent:askUser') conn.prompts.askUser.add(payload.requestId);
    if (payload && channel === 'tool:directoryAccessRequired') conn.prompts.directory.add(payload.requestId);
    if (payload && channel === 'canvas:executeJs') conn.prompts.canvas.add(payload.requestId);
    conn.send({ t: 'event', channel, payload });
  };

  // What createElectronPrompter treats as the window: the live connection.
  const connectionAsWindow = () => {
    const conn = getConnection();
    if (!conn || !conn.live) return null;
    return { isDestroyed: () => !conn.live, webContents: { send: (channel, payload) => pushEvent(conn, channel, payload) } };
  };
  const inner = createElectronPrompter({ getWindow: connectionAsWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers });
  const prompter = {
    askUser(args) {
      const conn = getConnection();
      if (!conn || !conn.live) return inner.askUser(args);
      const before = new Set(pendingAskUserResolvers.keys());
      const answer = inner.askUser(args);
      const issued = [...pendingAskUserResolvers.keys()].filter((id) => !before.has(id));
      return Promise.race([answer, conn.gone.then(() => {
        for (const id of issued) pendingAskUserResolvers.delete(id);
        return { ok: false, error: 'The desktop disconnected.' };
      })]);
    },
    requestDirectoryAccess: (args) => inner.requestDirectoryAccess(args)
  };

  const bridgeContext = {
    ...context,
    getSettings: scope.getSettings,
    setSettings: scope.setSettings,
    addPermissionRule: scope.addPermissionRule,
    removePermissionRule: scope.removePermissionRule,
    safeStorage: { isEncryptionAvailable: () => Boolean(cipher && cipher.isEncryptionAvailable()) },
    getMainWindow: () => null,
    getShell: () => null,
    pendingAskUserResolvers,
    pendingDirectoryAccessResolvers,
    prompter
  };
  registerHandlers(virtualIpcMain, bridgeContext);

  const inventory = listChannels();
  const served = servedChannels({
    handle: inventory.handle.filter((ch) => handlers.has(ch)),
    on: inventory.on.filter((ch) => listeners.has(ch))
  });
  const servedHandle = new Set(served.handle);
  const servedOn = new Set(served.on);

  const makeEvent = (conn) => markLocalDesktopEvent(
    { sender: { send: (channel, payload) => pushEvent(conn, channel, payload), isDestroyed: () => !conn.live } },
    { deviceId: conn.deviceId }
  );

  async function onInvoke(conn, frame) {
    const { id, channel } = frame;
    if (!Number.isInteger(id)) return;
    const args = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedHandle.has(channel)) {
      conn.send({ t: 'result', id, error: MESSAGES.CHANNEL_NOT_PROXIED(String(channel)), code: 'CHANNEL_NOT_PROXIED' });
      return;
    }
    const chatId = channel === 'chat:sendMessage' && args[0] && typeof args[0].chatId === 'string' ? args[0].chatId : null;
    if (chatId) conn.runs.add(chatId);
    try {
      const value = await handlers.get(channel)(makeEvent(conn), ...args);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'HANDLER_ERROR' });
    } finally {
      if (chatId) conn.runs.delete(chatId);
    }
  }

  function onSend(conn, frame) {
    const { channel } = frame;
    const args = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedOn.has(channel)) {
      log.warn(`dropped a send on ${channel}: not served over the bridge`);
      return;
    }
    const binding = PROMPT_RESPONSES[channel];
    if (binding) {
      const [kind, key] = binding;
      const id = args[0] && args[0][key];
      if (!conn.prompts[kind].has(id)) {
        log.warn(`dropped ${channel} for a prompt this connection was not shown`);
        return;
      }
      conn.prompts[kind].delete(id);
    }
    try {
      listeners.get(channel)(makeEvent(conn), ...args);
    } catch (err) {
      log.warn(`${channel} failed: ${err.message}`);
    }
  }

  function resolveCanvas(conn, { requestId, result, error } = {}) {
    const pending = core.pendingCanvasJsResolvers && core.pendingCanvasJsResolvers.get(requestId);
    if (!pending || !conn.prompts.canvas.has(requestId)) return { ok: false, error: 'No canvas request is waiting for that result.' };
    conn.prompts.canvas.delete(requestId);
    core.pendingCanvasJsResolvers.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(error ? { action: 'execute_js', error } : { action: 'execute_js', result });
    return { ok: true };
  }

  let importer = null;
  async function getImporter() {
    if (!importer) {
      if (!createImporter) throw fail('IMPORT_UNAVAILABLE', 'This service cannot import from a desktop.');
      importer = await createImporter({ scope, checkPath });
    }
    return importer;
  }

  async function readableDirectory(target) {
    const check = await checkPath(target);
    if (!check.readable || !check.isDirectory) throw fail('PATH_NOT_ACCESSIBLE', MESSAGES.PATH_NOT_ACCESSIBLE(account, target));
  }

  async function callMethod(conn, method, params) {
    switch (method) {
      case 'bridge.status':
        return getServiceInfo();
      case 'bridge.checkPath':
        return checkPath(params.path);
      case 'bridge.setWorkingDirectory':
        await readableDirectory(params.path);
        return handlers.get('chat:setWorkingDirectory')(makeEvent(conn), { chatId: params.chatId, workingDirectory: params.path });
      case 'bridge.addAllowedDirectory':
        await readableDirectory(params.path);
        return { ok: true, allowedDirectories: scope.addDirectory(params.path) };
      case 'bridge.canvasJsResult':
        return resolveCanvas(conn, params);
      case 'bridge.approvalsStatus':
        return approvalsStatus({ approvals, dataDir });
      case 'import.plan':
        return (await getImporter()).plan({ ...params, source: 'bridge', connectionId: conn.id });
      case 'import.apply':
        return (await getImporter()).apply(params);
      case 'import.finish':
        return (await getImporter()).finish(params);
      default:
        throw fail('UNKNOWN_METHOD', `Unknown bridge method ${method}.`);
    }
  }

  async function onCall(conn, frame) {
    const { id, method } = frame;
    if (!Number.isInteger(id)) return;
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
    try {
      const value = await callMethod(conn, method, params);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'CALL_FAILED' });
    }
  }

  async function handleFrame(conn, frame) {
    if (frame.t === 'invoke') return onInvoke(conn, frame);
    if (frame.t === 'send') return onSend(conn, frame);
    if (frame.t === 'call') return onCall(conn, frame);
    log.warn(`dropped an unknown frame type ${frame.t}`);
    return undefined;
  }

  // Nothing started from a desktop keeps running unattended (spec §3.3).
  async function onDisconnect(conn) {
    if (conn.cleaned) return;
    conn.cleaned = true;
    conn.markGone();
    if (importer) importer.expireConnection(conn.id);
    const event = makeEvent(conn);
    const approvalResponse = listeners.get('tool:approvalResponse');
    for (const approvalId of [...conn.prompts.approvals]) {
      try { if (approvalResponse) approvalResponse(event, { approvalId, approved: false }); } catch (err) { log.warn(`denying a prompt failed: ${err.message}`); }
    }
    const directoryResponse = listeners.get('tool:directoryAccessResponse');
    for (const requestId of [...conn.prompts.directory]) {
      try { if (directoryResponse) directoryResponse(event, { requestId, approved: false }); } catch (err) { log.warn(`denying a prompt failed: ${err.message}`); }
    }
    conn.prompts.approvals.clear();
    conn.prompts.directory.clear();
    conn.prompts.askUser.clear();
    conn.prompts.canvas.clear();
    const stop = handlers.get('chat:stopResponse');
    for (const chatId of [...conn.runs]) {
      try {
        if (stop) await stop(event, { chatId });
        context.appendMessageToChat(chatId, 'assistant', MESSAGES.DESKTOP_DISCONNECTED_RUN);
        log.info(`stopped chat ${chatId}: its desktop disconnected`);
      } catch (err) {
        log.warn(`stopping chat ${chatId} failed: ${err.message}`);
      }
    }
    conn.runs.clear();
  }

  // The core's own ui.send (chat:updated, backgroundTask:completed, case:*):
  // never a prompt, so a remote-origin run cannot borrow the dialog.
  function forwardAmbient(channel, payload) {
    const conn = getConnection();
    if (!conn || !conn.live || !isRendererEvent(channel) || PROMPT_EVENTS.has(channel)) return;
    conn.send({ t: 'event', channel, payload });
  }

  function providersConfigured() {
    try {
      const tokens = context.getApiTokens() || {};
      return Object.entries(tokens).some(([name, value]) => !name.startsWith('__') && Boolean(value));
    } catch {
      return false;
    }
  }

  return { served, providersConfigured, handleFrame, onDisconnect, forwardAmbient, bridgeContext, scope };
}

module.exports = { createBridgeDispatcher, approvalsStatus };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-dispatcher.test.js tests/core-origin.test.js tests/desktop-bridge-protocol.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/bridge-dispatcher.js tests/desktop-bridge-dispatcher.test.js
git commit -m "feat(desktop-bridge): dispatcher with marked events, bound prompts and scoped settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Import engine and `MemoryManager.importEntry`

**Files:**
- Create: `src/migration/desktop-import.js`
- Modify: `src/memory/memory-manager.js` — insert before the line `  captureSuccess(what, why, options = {}) {`
- Test: `tests/desktop-import.test.js`

**Interfaces:**
- Consumes: `core.context` (`getChats`, `setChats`, `getSettings`, `setSettings`, `getPermissionRules`, `addPermissionRule`, `setToolAlwaysApprove`, `getApiTokens`, `setApiTokens`, `encryptToken`, `vault`, `getStore`, `providerLabels`, `getMemoryManager`, `getCronScheduler`, `getUserProfile`, `updateUserProfile`); `DEFAULT_SETTINGS`, `mergeSettings` (`src/core/settings.js`); `resolveCasesRoot` (`src/cases`); `UserProfile.getDefaultProfile()` (`src/telos/user-profile.js`); `MemoryStore`, `MemoryManager` (`src/memory`); `CronStore` (`src/cron/cron-store.js`); `writeFileAtomic`, `MESSAGES` (Task 2); a scope (Task 6) and `checkPath` (Task 6).
- Produces:
  - `MemoryManager.prototype.importEntry(entry) → { imported: boolean }` (keeps `id` and timestamps, no embedding).
  - `class DesktopImporter` — `constructor({ context, targets, dataDir, scope, checkPath, cipher = null, now, randomId, onPathWritten })`; `plan({ installId, inventory, source = 'bridge', connectionId = null }) → Promise<{ planId, items: PlanItem[], counts }>`; `apply({ planId, batch }) → Promise<{ results: [{ category, key, ok, error?, note? }] }>`; `finish({ planId }) → Promise<{ planId, counts, failures, attention, secretsMissing, cronDisabled, notes }>`; `expireConnection(connectionId)`. `PlanItem = { category, key, action, note, targetKey }`.
  - `buildImportTargets({ context, dataDir, offline = false }) → Promise<{ memory: { has, importEntry }, cron: { has, addJob }, userProfile: { get, update }, writtenPaths }>`.
  - Constants `IMPORTED_SETTINGS_KEYS`, `SECRET_CATEGORIES`, `CATEGORY_ORDER`, `EXCLUDED`, `PLAN_TTL_MS` (1800000), `MAX_BATCH_BYTES` (2097152); `class ImportError(code, message)`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-import.test.js`:

```js
// tests/desktop-import.test.js — the import engine (fleet stage 7 §3.8).
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
const { addSink } = require('../src/logging');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { DesktopImporter, buildImportTargets, MAX_BATCH_BYTES } = require('../src/migration/desktop-import');
const { MemoryManager, MemoryStore } = require('../src/memory');

const SECRET = 'sk-example-SECRET-0123456789';
const VAULT_SECRET = 'ghp_exampleVAULTsecret42';
const dirs = [];
const cores = [];
let savedCasesRoot;

before(() => { savedCasesRoot = process.env.KL_CASES_ROOT; });
after(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
});
const tmp = (p = 'kl-import-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function service({ cipher = createAesGcmCipher(crypto.randomBytes(32)), now } = {}) {
  const dataDir = tmp();
  process.env.KL_CASES_ROOT = path.join(dataDir, 'cases');
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
  core.context.getCronScheduler().pause?.();
  const targets = await buildImportTargets({ context: core.context, dataDir });
  const importer = new DesktopImporter({
    context: core.context, targets, dataDir, cipher, checkPath,
    scope: createDesktopScope({ dataDir, context: core.context }),
    ...(now ? { now } : {})
  });
  return { core, dataDir, importer };
}

function desktopFixture(overrides = {}) {
  const workDir = tmp('kl-import-wd-');
  const chat = (id, updatedAt, title = `Chat ${id}`) => ({ id, title, createdAt: '2026-09-01T10:00:00Z', updatedAt, messages: [{ id: `${id}-m1`, sender: 'user', text: 'hello', timestamp: updatedAt }] });
  const values = {
    settings: { inference: { activeTier: 'smart' }, voice: { enabled: true }, hooks: { enabled: false } },
    userProfile: { name: 'Example Owner', goals: ['ship'] },
    chats: { c1: chat('c1', '2026-09-20T10:00:00Z'), c2: { ...chat('c2', '2026-09-20T11:00:00Z'), workingDirectory: path.join(workDir, 'gone') } },
    memory: { 'm-1': { id: 'm-1', type: 'preference', content: 'likes tea', source: 'desk', created: '2026-01-02T03:04:05.000Z', lastAccessed: '2026-01-03T03:04:05.000Z', metadata: {} } },
    cron: { cron_1: { id: 'cron_1', name: 'daily', schedule: { kind: 'cron', expr: '0 9 * * *' }, enabled: true, payload: { message: 'report' } } },
    cases: { 'lakeside-lot': [{ relPath: 'case.yaml', b64: Buffer.from('title: Lakeside lot\n').toString('base64'), mode: 0o644 }, { relPath: '.kl/lock', b64: Buffer.from('lock').toString('base64'), mode: 0o644 }, { relPath: 'notes/a.md', b64: Buffer.from('# A\n').toString('base64'), mode: 0o644 }] },
    providerTokens: { anthropic: SECRET },
    vault: { github: VAULT_SECRET },
    ...overrides
  };
  const inventory = {
    installId: 'install-0001',
    sourceVersion: '26.9.0',
    chats: Object.values(values.chats).map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title })),
    settingsKeys: Object.keys(values.settings),
    userProfile: true,
    permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow' }],
    alwaysApprove: ['Read'],
    providerTokens: Object.keys(values.providerTokens).concat(['__telegram_bot_token']),
    searchKeys: [],
    imageKeys: [],
    vault: Object.keys(values.vault),
    anthropicOAuth: false,
    memory: Object.keys(values.memory),
    cron: Object.values(values.cron).map((j) => ({ id: j.id, name: j.name })),
    cases: Object.keys(values.cases).map((dir) => ({ dir, files: values.cases[dir].length, bytes: 30 })),
    customCasesRoot: null,
    allowedDirectories: [workDir],
    excluded: ['mesh.identity', 'settings.hooks'],
    secrets: 'included'
  };
  const valueOf = (category, key) => {
    switch (category) {
      case 'settings': return values.settings[key];
      case 'userProfile': return values.userProfile;
      case 'permissionRule': { const [tool, pattern, action] = key.split('|'); return { tool, pattern, action }; }
      case 'alwaysApprove': return true;
      case 'allowedDirectory': return key;
      case 'chat': return values.chats[key];
      case 'memory': return values.memory[key];
      case 'cron': return values.cron[key];
      case 'providerToken': return values.providerTokens[key];
      case 'vault': return values.vault[key];
      default: return null;
    }
  };
  return { inventory, values, valueOf, workDir };
}

async function runImport(importer, fx) {
  const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
  const batch = [];
  for (const item of plan.items) {
    if (!['new', 'update', 'copy'].includes(item.action)) continue;
    if (item.category === 'case') { for (const f of fx.values.cases[item.key]) batch.push({ category: 'case', key: item.key, value: { ...f, offset: 0 } }); continue; }
    batch.push({ category: item.category, key: item.key, value: fx.valueOf(item.category, item.key) });
  }
  const applied = await importer.apply({ planId: plan.planId, batch });
  const report = await importer.finish({ planId: plan.planId });
  return { plan, applied, report };
}

const actionOf = (plan, category, key) => plan.items.find((i) => i.category === category && i.key === key)?.action;

describe('MemoryManager.importEntry', () => {
  it('keeps id and timestamps and imports an id once', () => {
    const dir = tmp();
    const mm = new MemoryManager({ store: new MemoryStore({ storageFile: path.join(dir, 'memory.json') }) });
    const entry = { id: 'm-7', type: 'success', content: 'deploy worked', created: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-02T00:00:00.000Z' };
    assert.deepStrictEqual(mm.importEntry(entry), { imported: true });
    const stored = mm.store.getById('m-7');
    assert.strictEqual(stored.created, entry.created);
    assert.strictEqual(stored.lastAccessed, entry.lastAccessed);
    assert.deepStrictEqual(mm.importEntry({ ...entry, content: 'changed' }), { imported: false });
    assert.strictEqual(mm.store.getById('m-7').content, 'deploy worked');
    assert.throws(() => mm.importEntry({ content: 'no id' }), /needs an id/);
  });
});

describe('DesktopImporter', () => {
  it('plans every category against a fresh service', async () => {
    const { importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    assert.strictEqual(actionOf(plan, 'settings', 'inference'), 'new');
    assert.strictEqual(actionOf(plan, 'settings', 'hooks'), 'skip-excluded');
    assert.strictEqual(actionOf(plan, 'userProfile', 'userProfile'), 'new');
    assert.strictEqual(actionOf(plan, 'permissionRule', 'Bash|git *|allow'), 'new');
    assert.strictEqual(actionOf(plan, 'alwaysApprove', 'Read'), 'new');
    assert.strictEqual(actionOf(plan, 'allowedDirectory', fx.workDir), 'new');
    assert.strictEqual(actionOf(plan, 'chat', 'c1'), 'new');
    assert.strictEqual(actionOf(plan, 'memory', 'm-1'), 'new');
    assert.strictEqual(actionOf(plan, 'cron', 'cron_1'), 'new');
    assert.strictEqual(actionOf(plan, 'case', 'lakeside-lot'), 'new');
    assert.strictEqual(actionOf(plan, 'providerToken', 'anthropic'), 'new');
    assert.strictEqual(actionOf(plan, 'providerToken', '__telegram_bot_token'), 'skip-excluded');
    assert.strictEqual(actionOf(plan, 'vault', 'github'), 'new');
    assert.strictEqual(actionOf(plan, 'excluded', 'mesh.identity'), 'skip-excluded');
    assert.strictEqual(plan.items[plan.items.length - 1].category, 'excluded');
    assert.ok(plan.counts.new >= 12);
  });

  it('imports, lands cases through the staging dir, and a rerun gives skip-present', async () => {
    const { core, dataDir, importer } = await service();
    const fx = desktopFixture();
    const first = await runImport(importer, fx);
    assert.deepStrictEqual(first.report.failures, []);
    assert.strictEqual(core.context.getSettings().inference.activeTier, 'smart');
    assert.ok(core.context.getChats().some((c) => c.id === 'c1'));
    const c2 = core.context.getChats().find((c) => c.id === 'c2');
    assert.strictEqual(c2.workingDirectory, null, 'an unreadable working directory is dropped');
    assert.ok(first.report.attention.some((a) => a.category === 'chat' && a.key === 'c2'));
    assert.strictEqual(core.context.vault.get('github'), VAULT_SECRET);
    assert.strictEqual(core.context.decryptToken(core.context.getApiTokens().anthropic), SECRET);
    const job = core.context.getCronScheduler().listJobs().find((j) => j.id === 'cron_1');
    assert.strictEqual(job.enabled, false, 'cron jobs arrive disabled');
    assert.strictEqual(first.report.cronDisabled, 1);
    const caseDir = path.join(dataDir, 'cases', 'lakeside-lot');
    assert.strictEqual(fs.readFileSync(path.join(caseDir, 'notes', 'a.md'), 'utf8'), '# A\n');
    assert.strictEqual(fs.existsSync(path.join(caseDir, '.kl', 'lock')), false, 'the case lock is skipped');
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'cases')).filter((n) => n.startsWith('.import-')), []);
    const again = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    for (const item of again.items) {
      assert.ok(!['new', 'update', 'copy'].includes(item.action), `${item.category}:${item.key} is ${item.action}`);
    }
    assert.strictEqual(actionOf(again, 'chat', 'c1'), 'skip-present');
    assert.strictEqual(actionOf(again, 'case', 'lakeside-lot'), 'skip-present');
  });

  it('rerun after standalone use: update in place, a copy when both changed, new chats come across', async () => {
    const { core, importer } = await service();
    const fx = desktopFixture();
    await runImport(importer, fx);
    // Used standalone again: c1 edited on the desktop, a new c3.
    const edited = desktopFixture();
    edited.values.chats.c1 = { ...fx.values.chats.c1, updatedAt: '2026-09-21T10:00:00Z', title: 'Chat c1 edited' };
    edited.values.chats.c3 = { ...fx.values.chats.c1, id: 'c3', updatedAt: '2026-09-21T12:00:00Z', title: 'Chat c3' };
    edited.inventory.chats = Object.values(edited.values.chats).map((c) => ({ id: c.id, updatedAt: c.updatedAt, title: c.title }));
    const second = await runImport(importer, edited);
    assert.strictEqual(actionOf(second.plan, 'chat', 'c1'), 'update');
    assert.strictEqual(actionOf(second.plan, 'chat', 'c3'), 'new');
    assert.strictEqual(core.context.getChats().find((c) => c.id === 'c1').title, 'Chat c1 edited');
    // Now both sides change c1.
    core.context.setChats(core.context.getChats().map((c) => (c.id === 'c1' ? { ...c, updatedAt: '2026-09-22T09:00:00Z' } : c)));
    const third = desktopFixture();
    third.values.chats.c1 = { ...edited.values.chats.c1, updatedAt: '2026-09-22T10:00:00Z' };
    third.inventory.chats = [{ id: 'c1', updatedAt: '2026-09-22T10:00:00Z', title: 'Chat c1 edited' }];
    const out = await runImport(importer, third);
    const copyItem = out.plan.items.find((i) => i.category === 'chat' && i.key === 'c1');
    assert.strictEqual(copyItem.action, 'copy');
    const copy = core.context.getChats().find((c) => c.id === copyItem.targetKey);
    assert.strictEqual(copy.title, 'Chat c1 edited (from desktop)');
    const fourth = await importer.plan({ installId: third.inventory.installId, inventory: third.inventory });
    assert.strictEqual(actionOf(fourth, 'chat', 'c1'), 'skip-present', 'the manifest now follows the copy');
  });

  it('never writes a secret into a plan, report, log line or the manifest', async () => {
    const { dataDir, importer } = await service();
    const lines = [];
    const remove = addSink((record) => lines.push(record.line));
    let out;
    try {
      out = await runImport(importer, desktopFixture());
    } finally {
      remove();
    }
    const manifest = fs.readFileSync(path.join(dataDir, 'imports', 'desktop-install-0001.json'), 'utf8');
    for (const text of [JSON.stringify(out.plan), JSON.stringify(out.applied), JSON.stringify(out.report), manifest, lines.join('\n')]) {
      assert.ok(!text.includes(SECRET), 'provider token leaked');
      assert.ok(!text.includes(VAULT_SECRET), 'vault secret leaked');
    }
  });

  it('rejects case paths that escape, and a symlinked staging dir', async (t) => {
    const { dataDir, importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    const bad = ['../x', '/etc/x', 'C:/x', 'a/../../x', 'a\u0000b'];
    const { results } = await importer.apply({ planId: plan.planId, batch: bad.map((relPath) => ({ category: 'case', key: 'lakeside-lot', value: { relPath, b64: 'eA==', mode: 0o644, offset: 0 } })) });
    assert.ok(results.every((r) => r.ok === false && /escapes|not allowed/.test(r.error)), JSON.stringify(results));
    const staging = path.join(dataDir, 'cases', `.import-${plan.planId}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      fs.symlinkSync(tmp(), path.join(staging, 'lakeside-lot'), 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink here (${err.code})`);
      return;
    }
    const linked = await importer.apply({ planId: plan.planId, batch: [{ category: 'case', key: 'lakeside-lot', value: { relPath: 'case.yaml', b64: 'eA==', mode: 0o644, offset: 0 } }] });
    assert.strictEqual(linked.results[0].ok, false);
    assert.match(linked.results[0].error, /link/);
  });

  it('fails secrets, not the rest, when the service cipher is unavailable', async () => {
    const { core, importer } = await service({ cipher: { isEncryptionAvailable: () => false } });
    const out = await runImport(importer, desktopFixture());
    const failed = out.report.failures.map((f) => `${f.category}:${f.key}`).sort();
    assert.deepStrictEqual(failed, ['providerToken:anthropic', 'vault:github']);
    assert.ok(out.report.failures.every((f) => f.error === 'Encryption unavailable in the service.'));
    assert.deepStrictEqual(out.report.secretsMissing.map((s) => s.key).sort(), ['anthropic', 'github']);
    assert.ok(core.context.getChats().some((c) => c.id === 'c1'));
  });

  it('expires a plan after 30 minutes and when its connection closes', async () => {
    let clock = Date.parse('2026-09-23T10:00:00Z');
    const { importer } = await service({ now: () => new Date(clock) });
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory, connectionId: 7 });
    clock += 31 * 60 * 1000;
    await assert.rejects(importer.apply({ planId: plan.planId, batch: [] }), (err) => err.code === 'PLAN_EXPIRED');
    const second = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory, connectionId: 8 });
    importer.expireConnection(8);
    await assert.rejects(importer.finish({ planId: second.planId }), (err) => err.code === 'PLAN_EXPIRED');
  });

  it('refuses a batch over 2 MiB and items the plan did not schedule', async () => {
    const { importer } = await service();
    const fx = desktopFixture();
    const plan = await importer.plan({ installId: fx.inventory.installId, inventory: fx.inventory });
    const huge = [{ category: 'chat', key: 'c1', value: { id: 'c1', messages: [], blob: 'x'.repeat(MAX_BATCH_BYTES) } }];
    await assert.rejects(importer.apply({ planId: plan.planId, batch: huge }), (err) => err.code === 'BATCH_TOO_LARGE');
    const { results } = await importer.apply({ planId: plan.planId, batch: [{ category: 'settings', key: 'hooks', value: {} }] });
    assert.deepStrictEqual(results, [{ category: 'settings', key: 'hooks', ok: false, error: 'not planned for import' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-import.test.js`
Expected: FAIL with `Cannot find module '../src/migration/desktop-import'`.

- [ ] **Step 3: Implement**

In `src/memory/memory-manager.js`, insert before the line `  captureSuccess(what, why, options = {}) {`:

```js
  // Fleet stage 7 import: keeps the entry's own id and timestamps and does not
  // re-embed (the vector index is rebuilt). An id already present is left alone.
  importEntry(entry = {}) {
    const id = String((entry && entry.id) || '').trim();
    if (!id) throw new Error('An imported memory entry needs an id.');
    if (this.store.getById(id)) return { imported: false };
    const content = String(entry.content || '').trim();
    if (!content) throw new Error('Memory content is required.');
    this.store.insert(this.normalizeEntry({ ...entry, id, content }));
    return { imported: true };
  }

```

Create `src/migration/desktop-import.js`:

```js
// Import from a desktop profile into the service (fleet stage 7 §3.8). One
// engine for both sources (the desktop over the bridge, and `import --from`).
// Plans carry ids and keys only; secret values exist only inside apply
// batches and are never logged, reported or written to the manifest.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { DEFAULT_SETTINGS, mergeSettings } = require('../core/settings');
const { resolveCasesRoot } = require('../cases');
const UserProfile = require('../telos/user-profile');
const { writeFileAtomic } = require('../desktop-bridge/pairing');
const { MESSAGES } = require('../desktop-bridge/protocol');

const log = createLogger('desktop-import');

const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const IMPORTED_SETTINGS_KEYS = Object.freeze(['defaults', 'checkpoints', 'activeProvider', 'templateVariables', 'providerModels', 'inference', 'notifications', 'voice', 'cases']);
const SECRET_CATEGORIES = new Set(['providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth']);
const CATEGORY_ORDER = Object.freeze(['settings', 'userProfile', 'permissionRule', 'alwaysApprove', 'allowedDirectory', 'chat', 'memory', 'cron', 'case', 'providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth', 'excluded']);
const ACTIONS = Object.freeze(['new', 'update', 'copy', 'skip-present', 'skip-excluded', 'needs-attention', 'needs-desktop']);
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const INSTALL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CASE_DIR_RE = /^[A-Za-z0-9._-]{1,128}$/;
const COPY_SUFFIX = ' (from desktop)';
const ELEVENLABS_TOKEN = '__elevenlabs_api_key';

// What stays behind, and why (spec §3.8 "Stays behind").
const EXCLUDED = Object.freeze({
  'mesh.identity': 'the desktop mesh identity and peers stay with the desktop',
  gatewayToken: 'the gateway token belongs to the desktop gateway',
  apiStatus: 'provider status is recomputed by the service',
  embeddings: 'embedding caches and context vectors are rebuilt',
  'tool-results': 'tool results stay with the desktop',
  'background-tasks': 'background tasks stay with the desktop',
  checkpoints: 'checkpoints stay with the desktop',
  voice: 'voice files stay with the desktop',
  skills: 'skills, pins and customizations are set up on the service by an administrator',
  workflows: 'workflows are not available while attached',
  webhooks: 'the webhook registry is set up on the service by an administrator',
  'settings.hooks': 'hooks spawn processes; an administrator sets them with the service CLI',
  'settings.mcpServers': 'MCP servers spawn processes; an administrator sets them with the service CLI',
  'settings.channels': 'a chat bot must not answer from two hosts; an administrator sets channels with the service CLI',
  channelTokens: 'bot tokens stay with the desktop'
});

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const itemKey = (category, key) => `${category}:${key}`;
const arr = (v) => (Array.isArray(v) ? v : []);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const withoutRoot = (cases) => {
  const { root, ...rest } = cases || {};
  return rest;
};
function countActions(items) {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const item of items) counts[item.action] = (counts[item.action] || 0) + 1;
  return counts;
}

// A relative path inside a case: no NUL, not absolute, no drive letter, no '.'/'..'/empty segments.
function safeRelPath(relPath) {
  const text = String(relPath);
  if (text.includes('\0')) throw new ImportError('BAD_PATH', 'a NUL byte is not allowed in a case path');
  const norm = text.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
  const parts = norm.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
  return parts.join('/');
}
const isSkippedCaseFile = (rel) => rel === '.kl/lock' || (rel.startsWith('.git/') && rel.endsWith('.lock'));
const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

class DesktopImporter {
  constructor({
    context, targets, dataDir, scope, checkPath, cipher = null,
    now = () => new Date(),
    randomId = () => crypto.randomBytes(8).toString('hex'),
    onPathWritten = () => {}
  }) {
    this.context = context;
    this.targets = targets;
    this.dataDir = dataDir;
    this.scope = scope;
    this.checkPath = checkPath;
    this.cipher = cipher;
    this.now = now;
    this.randomId = randomId;
    this.onPathWritten = onPathWritten;
    this.plans = new Map();
  }

  casesRoot() {
    return resolveCasesRoot({ settings: this.context.getSettings(), dataDir: this.dataDir });
  }

  manifestPath(installId) {
    return path.join(this.dataDir, 'imports', `desktop-${installId}.json`);
  }

  readManifest(installId) {
    try {
      const doc = JSON.parse(fs.readFileSync(this.manifestPath(installId), 'utf8'));
      if (doc && doc.v === 1 && doc.items && typeof doc.items === 'object') {
        return { v: 1, installId, runs: arr(doc.runs), items: doc.items };
      }
    } catch { /* no manifest yet */ }
    return { v: 1, installId, runs: [], items: {} };
  }

  writeManifest(manifest) {
    const dir = path.join(this.dataDir, 'imports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.onPathWritten(dir);
    const file = this.manifestPath(manifest.installId);
    writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    this.onPathWritten(file);
  }

  expire() {
    const now = this.now().getTime();
    for (const [planId, plan] of this.plans) {
      if (now - plan.createdAt > PLAN_TTL_MS) this.dropPlan(planId);
    }
  }

  dropPlan(planId) {
    this.plans.delete(planId);
    try {
      fs.rmSync(path.join(this.casesRoot(), `.import-${planId}`), { recursive: true, force: true });
    } catch { /* nothing staged */ }
  }

  expireConnection(connectionId) {
    for (const [planId, plan] of this.plans) {
      if (plan.connectionId === connectionId) this.dropPlan(planId);
    }
  }

  getPlan(planId) {
    this.expire();
    const plan = this.plans.get(planId);
    if (!plan) throw new ImportError('PLAN_EXPIRED', 'The import plan expired; plan the import again.');
    return plan;
  }

  copyId(id, chats) {
    let next;
    do { next = `${id}-${this.randomId().slice(0, 4)}`; } while (chats.some((c) => c.id === next));
    return next;
  }

  async plan({ installId, inventory, source = 'bridge', connectionId = null } = {}) {
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) throw new ImportError('BAD_REQUEST', 'installId must be 1-64 letters, digits or dashes');
    if (!inventory || typeof inventory !== 'object') throw new ImportError('BAD_REQUEST', 'an inventory is required');
    this.expire();
    const manifest = this.readManifest(installId);
    const done = (category, key) => {
      const entry = manifest.items[itemKey(category, key)];
      return entry && entry.result === 'ok' ? entry : null;
    };
    const items = [];
    const add = (category, key, action, note = null, targetKey = key) => items.push({ category, key: String(key), action, note, targetKey: targetKey === null ? null : String(targetKey) });

    const settings = this.context.getSettings();
    const defaults = mergeSettings(DEFAULT_SETTINGS);
    for (const key of arr(inventory.settingsKeys)) {
      if (!IMPORTED_SETTINGS_KEYS.includes(key)) { add('settings', key, 'skip-excluded', EXCLUDED[`settings.${key}`] || 'this setting is managed on the service'); continue; }
      const current = key === 'cases' ? withoutRoot(settings.cases) : settings[key];
      const dflt = key === 'cases' ? withoutRoot(defaults.cases) : defaults[key];
      add('settings', key, stable(current) === stable(dflt) ? 'new' : 'skip-present');
    }

    if (inventory.userProfile) {
      add('userProfile', 'userProfile', stable(this.targets.userProfile.get()) === stable(UserProfile.getDefaultProfile()) ? 'new' : 'skip-present');
    }

    const rules = this.context.getPermissionRules();
    for (const r of arr(inventory.permissionRules)) {
      if (!r || !r.tool || !['allow', 'ask', 'deny'].includes(r.action)) continue;
      const pattern = r.pattern || '*';
      const exists = rules.some((x) => x.tool === r.tool && (x.pattern || '*') === pattern && x.action === r.action);
      add('permissionRule', `${r.tool}|${pattern}|${r.action}`, exists ? 'skip-present' : 'new');
    }

    const approvals = (this.context.getStore().get('toolApprovals', {}) || {}).alwaysApproveTools || {};
    for (const tool of arr(inventory.alwaysApprove)) {
      add('alwaysApprove', tool, approvals[tool] ? 'skip-present' : 'new', 'applies only to runs started from the desktop');
    }

    for (const dir of arr(inventory.allowedDirectories)) {
      if (typeof dir !== 'string' || !dir) continue;
      if (this.scope.listDirectories().includes(dir) || arr(settings.allowedDirectories).includes(dir)) { add('allowedDirectory', dir, 'skip-present'); continue; }
      const check = await this.checkPath(dir);
      if (check.readable && check.isDirectory) add('allowedDirectory', dir, 'new', 'applies only to runs started from the desktop');
      else add('allowedDirectory', dir, 'needs-attention', `the service cannot read ${dir}`);
    }

    const chats = this.context.getChats();
    for (const c of arr(inventory.chats)) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      const entry = done('chat', c.id);
      if (entry) {
        const target = chats.find((x) => x.id === entry.targetKey);
        const sourceChanged = c.updatedAt !== entry.sourceUpdatedAt;
        const targetChanged = !target || target.updatedAt !== entry.targetUpdatedAt;
        if (!sourceChanged) add('chat', c.id, 'skip-present', null, entry.targetKey);
        else if (!targetChanged) add('chat', c.id, 'update', null, entry.targetKey);
        else add('chat', c.id, 'copy', 'changed on both sides; imported as a copy', this.copyId(c.id, chats));
        continue;
      }
      const existing = chats.find((x) => x.id === c.id);
      if (!existing) add('chat', c.id, 'new');
      else if (existing.updatedAt === c.updatedAt) add('chat', c.id, 'skip-present');
      else add('chat', c.id, 'copy', 'a different chat with this id exists; imported as a copy', this.copyId(c.id, chats));
    }

    for (const id of arr(inventory.memory)) {
      add('memory', id, done('memory', id) || this.targets.memory.has(id) ? 'skip-present' : 'new');
    }
    for (const job of arr(inventory.cron)) {
      if (!job || !job.id) continue;
      add('cron', job.id, done('cron', job.id) || this.targets.cron.has(job.id) ? 'skip-present' : 'new', 'imported disabled');
    }

    if (inventory.customCasesRoot) {
      add('case', inventory.customCasesRoot, 'needs-attention', `cases under a custom cases.root (${inventory.customCasesRoot}) are not copied; move them by hand`);
    }
    const root = this.casesRoot();
    for (const c of arr(inventory.cases)) {
      const dir = c && c.dir;
      if (typeof dir !== 'string' || !CASE_DIR_RE.test(dir) || dir === '.' || dir === '..') { add('case', String(dir), 'needs-attention', 'not a valid case directory name'); continue; }
      const exists = fs.existsSync(path.join(root, dir));
      if (!exists) add('case', dir, 'new');
      else if (done('case', dir)) add('case', dir, 'skip-present');
      else add('case', dir, 'needs-attention', 'a case with this directory already exists on the service');
    }

    const secretMode = inventory.secrets || 'included';
    const tokens = this.context.getApiTokens() || {};
    const knownTokens = new Set([...Object.keys(this.context.providerLabels || {}), ELEVENLABS_TOKEN]);
    const secret = (category, key, present) => {
      if (present) return add(category, key, 'skip-present');
      if (secretMode === 'needs-desktop') return add(category, key, 'needs-desktop', 'only the desktop app can read its secrets; import from Settings > Local service');
      if (secretMode === 'unavailable') return add(category, key, 'needs-attention', MESSAGES.SECURE_STORAGE_UNAVAILABLE);
      return add(category, key, 'new');
    };
    for (const p of arr(inventory.providerTokens)) {
      if (!knownTokens.has(p)) { add('providerToken', p, 'skip-excluded', 'not a provider key this service uses'); continue; }
      secret('providerToken', p, Boolean(tokens[p]));
    }
    for (const p of arr(inventory.searchKeys)) secret('searchKey', p, Boolean(settings.webSearch && settings.webSearch[p] && settings.webSearch[p].apiKey));
    for (const p of arr(inventory.imageKeys)) secret('imageKey', p, Boolean(settings.imageGeneration && settings.imageGeneration[p] && settings.imageGeneration[p].apiKey));
    for (const k of arr(inventory.vault)) secret('vault', k, this.context.vault.has(k));
    if (inventory.anthropicOAuth) {
      const stored = this.context.getStore().get('anthropicOAuth');
      secret('anthropicOAuth', 'anthropicOAuth', Boolean(stored && stored.accessToken));
    }
    for (const key of arr(inventory.excluded)) add('excluded', key, 'skip-excluded', EXCLUDED[key] || 'stays with the desktop');

    items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    const planId = this.randomId();
    this.plans.set(planId, {
      planId, installId, source, connectionId,
      createdAt: this.now().getTime(),
      items: new Map(items.map((i) => [itemKey(i.category, i.key), i])),
      results: new Map(),
      caseFiles: new Map()
    });
    log.info(`planned a desktop import: ${items.length} items`, { planId, source });
    return { planId, items, counts: countActions(items) };
  }

  async apply({ planId, batch } = {}) {
    const plan = this.getPlan(planId);
    if (!Array.isArray(batch)) throw new ImportError('BAD_REQUEST', 'batch must be an array');
    if (Buffer.byteLength(JSON.stringify(batch)) > MAX_BATCH_BYTES) throw new ImportError('BATCH_TOO_LARGE', 'an import batch is at most 2 MiB');
    const results = [];
    for (const entry of batch) {
      const category = entry && entry.category;
      const key = entry ? String(entry.key) : '';
      const k = itemKey(category, key);
      const item = plan.items.get(k);
      if (!item || !WRITE_ACTIONS.has(item.action)) {
        results.push({ category, key, ok: false, error: 'not planned for import' });
        continue;
      }
      try {
        const out = (await this.write(plan, item, entry.value)) || {};
        results.push(out.note ? { category, key, ok: true, note: out.note } : { category, key, ok: true });
        if (category !== 'case') plan.results.set(k, { ok: true, note: out.note || null, attention: Boolean(out.attention), record: out.record || null });
      } catch (err) {
        log.warn(`importing ${category}${SECRET_CATEGORIES.has(category) ? '' : ` ${key}`} failed: ${err.message}`);
        results.push({ category, key, ok: false, error: err.message });
        if (category === 'case') {
          const files = plan.caseFiles.get(key) || { count: 0, failed: null };
          files.failed = files.failed || err.message;
          plan.caseFiles.set(key, files);
        } else {
          plan.results.set(k, { ok: false, error: err.message });
        }
      }
    }
    return { results };
  }

  requireCipher() {
    if (this.cipher && !this.cipher.isEncryptionAvailable()) throw new ImportError('ENCRYPTION_UNAVAILABLE', 'Encryption unavailable in the service.');
  }

  requireSecretString(value) {
    if (typeof value !== 'string' || !value) throw new ImportError('BAD_VALUE', 'the secret value is missing');
  }

  async write(plan, item, value) {
    const ctx = this.context;
    switch (item.category) {
      case 'settings': {
        const s = ctx.getSettings();
        const dflt = mergeSettings(DEFAULT_SETTINGS);
        const current = item.key === 'cases' ? withoutRoot(s.cases) : s[item.key];
        const base = item.key === 'cases' ? withoutRoot(dflt.cases) : dflt[item.key];
        if (stable(current) !== stable(base)) return { note: 'already set on the service; left unchanged' };
        const next = item.key === 'cases'
          ? { ...withoutRoot(value), ...(s.cases && s.cases.root !== undefined ? { root: s.cases.root } : {}) }
          : value;
        ctx.setSettings({ ...s, [item.key]: next });
        return {};
      }
      case 'userProfile':
        this.targets.userProfile.update(value && typeof value === 'object' ? value : {});
        return {};
      case 'permissionRule': {
        const [tool, pattern, action] = item.key.split('|');
        if (!value || value.tool !== tool || (value.pattern || '*') !== pattern || value.action !== action) throw new ImportError('BAD_VALUE', 'the rule does not match the plan');
        ctx.addPermissionRule({ tool, pattern, action, source: 'desktop-import' });
        return {};
      }
      case 'alwaysApprove':
        ctx.setToolAlwaysApprove(item.key, true);
        return {};
      case 'allowedDirectory': {
        const check = await this.checkPath(item.key);
        if (!check.readable || !check.isDirectory) throw new ImportError('PATH_NOT_ACCESSIBLE', `the service cannot read ${item.key}`);
        this.scope.addDirectory(item.key);
        return {};
      }
      case 'chat':
        return this.writeChat(item, value);
      case 'memory': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the memory entry does not match the plan');
        const out = this.targets.memory.importEntry(value);
        return out.imported ? {} : { note: 'already present' };
      }
      case 'cron': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the cron job does not match the plan');
        await this.targets.cron.addJob({ ...value, enabled: false });
        return { note: 'imported disabled' };
      }
      case 'case':
        return this.writeCaseFile(plan, item, value);
      case 'providerToken': {
        this.requireCipher();
        this.requireSecretString(value);
        const tokens = { ...(ctx.getApiTokens() || {}) };
        tokens[item.key] = ctx.encryptToken(value);
        ctx.setApiTokens(tokens);
        return {};
      }
      case 'searchKey':
      case 'imageKey': {
        this.requireCipher();
        this.requireSecretString(value);
        const s = ctx.getSettings();
        const section = item.category === 'searchKey' ? 'webSearch' : 'imageGeneration';
        const current = { ...(s[section] || {}) };
        current[item.key] = { ...(current[item.key] || {}), apiKey: ctx.encryptToken(value) };
        ctx.setSettings({ ...s, [section]: current });
        return {};
      }
      case 'vault': {
        this.requireCipher();
        this.requireSecretString(value);
        ctx.vault.set(item.key, value);
        if (ctx.vault.get(item.key) !== value) throw new ImportError('VERIFY_FAILED', 'the secret did not read back as written');
        return {};
      }
      case 'anthropicOAuth': {
        this.requireCipher();
        if (!value || typeof value.accessToken !== 'string' || !value.accessToken) throw new ImportError('BAD_VALUE', 'the OAuth record is incomplete');
        const store = ctx.getStore();
        store.set('anthropicOAuth', {
          accessToken: ctx.encryptToken(value.accessToken),
          refreshToken: value.refreshToken ? ctx.encryptToken(value.refreshToken) : null,
          expiresAt: value.expiresAt ?? null,
          connectedAt: value.connectedAt ?? Date.now()
        });
        if (typeof value.clientId === 'string' && value.clientId) store.set('anthropicOAuthClientId', value.clientId);
        return {};
      }
      default:
        throw new ImportError('BAD_REQUEST', `unknown category ${item.category}`);
    }
  }

  async writeChat(item, value) {
    if (!value || value.id !== item.key || !Array.isArray(value.messages)) throw new ImportError('BAD_VALUE', 'the chat does not match the plan');
    let note = null;
    let chat = { ...value };
    if (chat.workingDirectory) {
      const check = await this.checkPath(chat.workingDirectory);
      if (!check.readable || !check.isDirectory) {
        note = `the service cannot read the working directory ${chat.workingDirectory}; it was dropped`;
        chat.workingDirectory = null;
      }
    }
    chat = item.action === 'copy'
      ? { ...chat, id: item.targetKey, title: `${chat.title || 'Chat'}${COPY_SUFFIX}` }
      : { ...chat, id: item.targetKey };
    const chats = this.context.getChats();
    const updated = item.action === 'update'
      ? chats.map((c) => (c.id === item.targetKey ? chat : c))
      : [chat, ...chats.filter((c) => c.id !== chat.id)];
    this.context.setChats(updated);
    return {
      note,
      attention: Boolean(note),
      record: { sourceUpdatedAt: value.updatedAt || null, targetKey: chat.id, targetUpdatedAt: chat.updatedAt || null }
    };
  }

  ensureRealDirs(root, dir) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rel = path.relative(root, dir);
    let cur = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { st = null; }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ImportError('BAD_PATH', `${cur} is a link or not a directory`);
      if (!st) {
        fs.mkdirSync(cur, { mode: 0o700 });
        this.onPathWritten(cur);
      }
    }
  }

  writeCaseFile(plan, item, value) {
    if (!value || typeof value.relPath !== 'string' || typeof value.b64 !== 'string') throw new ImportError('BAD_VALUE', 'a case file needs relPath and b64');
    const rel = safeRelPath(value.relPath);
    if (isSkippedCaseFile(rel)) return { note: 'lock file skipped' };
    const root = this.casesRoot();
    const caseDir = path.join(root, `.import-${plan.planId}`, item.key);
    const target = path.join(caseDir, ...rel.split('/'));
    if (!isInside(caseDir, target)) throw new ImportError('BAD_PATH', `${value.relPath} escapes the case directory`);
    this.ensureRealDirs(root, path.dirname(target));
    const data = Buffer.from(value.b64, 'base64');
    const offset = Number.isInteger(value.offset) ? value.offset : 0;
    let existing = null;
    try { existing = fs.lstatSync(target); } catch { existing = null; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ImportError('BAD_PATH', `${value.relPath} is a link or not a file`);
    const mode = Number.isInteger(value.mode) ? ((value.mode & 0o755) | 0o600) : 0o600;
    if (offset === 0) {
      fs.writeFileSync(target, data, { mode });
    } else {
      if (!existing || existing.size !== offset) throw new ImportError('BAD_OFFSET', `${value.relPath}: chunk at ${offset} does not follow the data received`);
      fs.appendFileSync(target, data);
    }
    this.onPathWritten(target);
    const files = plan.caseFiles.get(item.key) || { count: 0, failed: null };
    files.count += 1;
    plan.caseFiles.set(item.key, files);
    return {};
  }

  reportTree(target) {
    this.onPathWritten(target);
    let st;
    try { st = fs.lstatSync(target); } catch { return; }
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(target)) this.reportTree(path.join(target, name));
  }

  async finish({ planId } = {}) {
    const plan = this.getPlan(planId);
    const manifest = this.readManifest(plan.installId);
    const at = this.now().toISOString();
    const root = this.casesRoot();
    const staging = path.join(root, `.import-${plan.planId}`);
    for (const [dir, files] of plan.caseFiles) {
      const k = itemKey('case', dir);
      if (files.failed) { plan.results.set(k, { ok: false, error: files.failed }); continue; }
      const dest = path.join(root, dir);
      try {
        if (fs.existsSync(dest)) throw new ImportError('CASE_EXISTS', 'a case with this directory appeared on the service during the import');
        fs.renameSync(path.join(staging, dir), dest);
        this.reportTree(dest);
        plan.results.set(k, { ok: true, record: { targetKey: dir } });
      } catch (err) {
        plan.results.set(k, { ok: false, error: err.message });
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });

    const items = [...plan.items.values()];
    const failures = [];
    const attention = [];
    const secretsMissing = [];
    let cronDisabled = 0;
    for (const item of items) {
      const k = itemKey(item.category, item.key);
      if (item.action === 'needs-attention') attention.push({ category: item.category, key: item.key, note: item.note });
      if (!WRITE_ACTIONS.has(item.action)) continue;
      const r = plan.results.get(k);
      if (!r || !r.ok) {
        const error = r ? r.error : 'not sent by the desktop';
        failures.push({ category: item.category, key: item.key, error });
        if (SECRET_CATEGORIES.has(item.category)) secretsMissing.push({ category: item.category, key: item.key });
        continue;
      }
      if (r.attention) attention.push({ category: item.category, key: item.key, note: r.note });
      if (item.category === 'cron') cronDisabled += 1;
      manifest.items[k] = { at, result: 'ok', ...(r.record || {}) };
    }
    manifest.runs.push({ planId: plan.planId, at, source: plan.source });
    this.writeManifest(manifest);
    this.plans.delete(plan.planId);
    const counts = countActions(items);
    counts.failed = failures.length;
    log.info(`finished a desktop import: ${failures.length} failed`, { planId: plan.planId });
    return {
      planId: plan.planId,
      counts,
      failures,
      attention,
      secretsMissing,
      cronDisabled,
      notes: cronDisabled ? [`${cronDisabled} cron job(s) were imported disabled; enable them in Settings > Scheduler.`] : []
    };
  }
}

// Where memory, cron and the user profile are written. The running service
// uses its started core; the CLI (offline) opens the stores directly, so it
// never starts a core (and never launches MCP servers or hooks) as root.
async function buildImportTargets({ context, dataDir, offline = false }) {
  if (!offline) {
    const memory = context.getMemoryManager();
    const cron = context.getCronScheduler();
    if (!memory || !cron) throw new Error('the service core is not started');
    return {
      memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
      cron: { has: (id) => cron.listJobs().some((j) => j.id === id), addJob: (job) => cron.addJob(job) },
      userProfile: { get: () => context.getUserProfile(), update: (profile) => context.updateUserProfile(profile) },
      writtenPaths: []
    };
  }
  const { MemoryStore, MemoryManager } = require('../memory');
  const CronStore = require('../cron/cron-store');
  const memoryFile = path.join(dataDir, 'memory', 'memory-store.json');
  const memory = new MemoryManager({ store: new MemoryStore({ storageFile: memoryFile }) });
  const cronFile = path.join(dataDir, 'cron', 'jobs.json');
  const cronStore = new CronStore(cronFile);
  await cronStore.load();
  const store = context.getStore();
  return {
    memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
    cron: { has: (id) => Boolean(cronStore.get(id)), addJob: (job) => cronStore.add(job) },
    userProfile: {
      get: () => store.get('userProfile', UserProfile.getDefaultProfile()),
      update: (profile) => store.set('userProfile', { ...UserProfile.getDefaultProfile(), ...profile })
    },
    writtenPaths: [path.dirname(memoryFile), memoryFile, path.dirname(cronFile), cronFile]
  };
}

module.exports = {
  DesktopImporter,
  ImportError,
  buildImportTargets,
  IMPORTED_SETTINGS_KEYS,
  SECRET_CATEGORIES,
  CATEGORY_ORDER,
  EXCLUDED,
  PLAN_TTL_MS,
  MAX_BATCH_BYTES
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-import.test.js tests/memory-system.test.js`
Expected: PASS, `# fail 0` (the symlink test is skipped where the account cannot create symlinks).

- [ ] **Step 5: Commit**

```bash
git add src/memory/memory-manager.js src/migration/desktop-import.js tests/desktop-import.test.js
git commit -m "feat(migration): desktop import engine with plans, manifest and confined case files

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The desktop source reader (R51 walker) and `import --from`

**Files:**
- Create: `src/migration/desktop-source.js`, `src/service/commands/admin-check.js`, `src/service/commands/import.js`
- Modify: `tests/electron-boundary.test.js` — append an `it` inside `describe('Electron import boundary', …)` after the existing `it(…)`
- Test: `tests/desktop-import-source.test.js`

**Interfaces:**
- Consumes: Task 8 (`DesktopImporter`, `buildImportTargets`, `EXCLUDED`), Task 6 (`createDesktopScope`, `checkPath`), `buildServicePorts` (`src/service/ports.js`), `createCore`, `CHAT_DATA_DEFAULTS`, `restoreDataDirOwnership` (`src/service/ownership.js`), `windowsPowerShellExe`.
- Produces:
  - `createSafeReader({ root, platform }) → { readFile(rel) → { ok: true, data } | { ok: false, missing?, reason? }, listDir(rel) → { dirs, refused }, listFiles(rel) → { files: [{ relPath, mode, size }], refused: [{ relPath, reason }] } }` — `lstat` at every level, no symlinks or junctions, regular files only with `nlink === 1`, owner = owner of `root` (POSIX), `O_NOFOLLOW` where defined, and the opened handle must be the inode that was checked.
  - `readDesktopSource({ userDataDir, reader, decrypt = null, secrets }) → { installId, inventory, attention, getValue(category, key), caseFiles(dir) → [{ relPath, mode, size, read() }] }`.
  - `planBatches(planItems, source, { maxBytes = 1900000, chunkBytes = 1048576, skipped = [] })` — a generator of apply batches (secrets included only here).
  - `isAdmin({ platform, geteuid, execFile, env }) → boolean`.
  - `runImportCommand({ flags, dataDir, io, deps: { isAdmin, runningServicePid, platform, openCore } }) → exit code`; `IMPORT_USAGE`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-import-source.test.js`:

```js
// tests/desktop-import-source.test.js — the user-controlled source tree (R51) and the CLI.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSafeReader, readDesktopSource, planBatches } = require('../src/migration/desktop-source');
const { runImportCommand } = require('../src/service/commands/import');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'kl-src-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const MARKER = 'PLANTED-TARGET-CONTENT-0451';

function userData() {
  const root = tmp('kl-userdata-');
  const write = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  write('chat-data.json', {
    chats: [{ id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', messages: [] }],
    settings: { inference: { activeTier: 'smart' }, allowedDirectories: [root], webSearch: { brave: { apiKey: 'ENC-brave' } }, hooks: { enabled: true } },
    apiTokens: { anthropic: 'ENC-anthropic', __telegram_bot_token: 'ENC-bot', __elevenlabs_api_key: 'ENC-eleven' },
    toolApprovals: { alwaysApproveTools: { Read: true, Bash: false }, permissionRules: [{ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'user' }] },
    userProfile: { name: 'Example Owner' },
    mesh: { identity: { publicKey: 'aa' } }
  });
  write('config.json', { __vault_github: 'ENC-github' });
  write(path.join('memory', 'memory-store.json'), { entries: [{ id: 'm-1', type: 'preference', content: 'likes tea', created: '2026-01-01T00:00:00.000Z' }] });
  write(path.join('cron', 'jobs.json'), { cron_1: { id: 'cron_1', name: 'daily', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' } } });
  write(path.join('cases', 'lakeside-lot', 'case.yaml'), 'title: Lakeside lot\n');
  write(path.join('cases', 'lakeside-lot', 'notes', 'a.md'), '# A\n');
  return root;
}

const trySymlink = (t, target, link, type) => {
  try { fs.symlinkSync(target, link, type); return true; } catch (err) { t.skip(`cannot create a symlink here (${err.code})`); return false; }
};

describe('readDesktopSource', () => {
  it('builds the inventory from ids and keys only', () => {
    const root = userData();
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    const inv = source.inventory;
    assert.match(source.installId, /^[0-9a-f]{16}$/);
    assert.deepStrictEqual(inv.chats, [{ id: 'c1', updatedAt: '2026-09-20T10:00:00Z', title: 'Lakeside lot' }]);
    assert.deepStrictEqual(inv.settingsKeys.sort(), ['hooks', 'inference']);
    assert.deepStrictEqual(inv.providerTokens.sort(), ['__elevenlabs_api_key', 'anthropic']);
    assert.deepStrictEqual(inv.searchKeys, ['brave']);
    assert.deepStrictEqual(inv.vault, ['github']);
    assert.deepStrictEqual(inv.alwaysApprove, ['Read']);
    assert.deepStrictEqual(inv.permissionRules, [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]);
    assert.deepStrictEqual(inv.memory, ['m-1']);
    assert.deepStrictEqual(inv.cron, [{ id: 'cron_1', name: 'daily' }]);
    assert.deepStrictEqual(inv.cases, [{ dir: 'lakeside-lot', files: 2, bytes: 24 }]);
    assert.strictEqual(inv.secrets, 'needs-desktop');
    assert.ok(inv.excluded.includes('mesh.identity'));
    assert.ok(!JSON.stringify(inv).includes('ENC-'), 'no secret values in the inventory');
    assert.throws(() => source.getValue('vault', 'github'), /only the desktop app/);
    assert.strictEqual(source.getValue('chat', 'c1').title, 'Lakeside lot');
  });

  it('uses the installId the desktop recorded', () => {
    const root = userData();
    fs.writeFileSync(path.join(root, 'desktop-bridge.json'), JSON.stringify({ mode: 'standalone', installId: '7c0e1111-2222-4333-8444-555566667777' }));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.strictEqual(source.installId, '7c0e1111-2222-4333-8444-555566667777');
  });

  it('decrypts secrets only through the injected decrypt', () => {
    const root = userData();
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), decrypt: (enc) => enc.replace('ENC-', 'plain-'), secrets: 'included' });
    assert.strictEqual(source.getValue('vault', 'github'), 'plain-github');
    assert.strictEqual(source.getValue('providerToken', 'anthropic'), 'plain-anthropic');
    assert.strictEqual(source.getValue('searchKey', 'brave'), 'plain-brave');
  });
});

describe('the R51 walker', () => {
  it('refuses a symlinked store file and never reads what it points at', (t) => {
    const root = userData();
    const planted = path.join(tmp(), 'secret.json');
    fs.writeFileSync(planted, JSON.stringify({ chats: [{ id: MARKER, title: MARKER, messages: [] }] }));
    fs.rmSync(path.join(root, 'chat-data.json'));
    if (!trySymlink(t, planted, path.join(root, 'chat-data.json'), 'file')) return;
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(source.attention.some((a) => a.key === 'chat-data.json' && /link/.test(a.note)));
    assert.ok(!JSON.stringify(source.inventory).includes(MARKER));
  });

  it('refuses a symlinked case directory', (t) => {
    const root = userData();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'x.md'), MARKER);
    if (!trySymlink(t, outside, path.join(root, 'cases', 'linked'), 'dir')) return;
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.ok(!source.inventory.cases.some((c) => c.dir === 'linked'));
    assert.ok(source.attention.some((a) => /linked/.test(a.key) && /link/.test(a.note)));
  });

  it('refuses a hardlinked file (nlink 2)', () => {
    const root = userData();
    const outside = path.join(tmp(), 'shadow');
    fs.writeFileSync(outside, MARKER);
    fs.linkSync(outside, path.join(root, 'cases', 'lakeside-lot', 'hard.md'));
    const reader = createSafeReader({ root });
    const out = reader.readFile(path.join('cases', 'lakeside-lot', 'hard.md'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /2 hard links/);
    const listed = reader.listFiles(path.join('cases', 'lakeside-lot'));
    assert.ok(!listed.files.some((f) => f.relPath === 'hard.md'));
    assert.ok(listed.refused.some((f) => f.relPath === 'hard.md'));
  });

  it('refuses a file owned by another user', { skip: process.platform === 'win32' || process.getuid?.() !== 0 ? 'needs root on POSIX' : false }, () => {
    const root = userData();
    const file = path.join(root, 'cases', 'lakeside-lot', 'foreign.md');
    fs.writeFileSync(file, MARKER);
    fs.chownSync(file, 65534, 65534);
    fs.chownSync(root, 1000, 1000);
    const out = createSafeReader({ root }).readFile(path.join('cases', 'lakeside-lot', 'foreign.md'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /owned by uid/);
  });

  it('refuses .. in a relative path', () => {
    const root = userData();
    assert.strictEqual(createSafeReader({ root }).readFile('../etc/passwd').ok, false);
  });
});

describe('planBatches', () => {
  it('keeps batches under the limit and chunks large case files', () => {
    const root = userData();
    fs.writeFileSync(path.join(root, 'cases', 'lakeside-lot', 'big.bin'), Buffer.alloc(2500 * 1024, 1));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), decrypt: (e) => e, secrets: 'included' });
    const items = [
      { category: 'chat', key: 'c1', action: 'new' },
      { category: 'case', key: 'lakeside-lot', action: 'new' },
      { category: 'vault', key: 'github', action: 'new' },
      { category: 'memory', key: 'missing', action: 'new' },
      { category: 'settings', key: 'hooks', action: 'skip-excluded' }
    ];
    const skipped = [];
    const batches = [...planBatches(items, source, { skipped })];
    for (const b of batches) assert.ok(Buffer.byteLength(JSON.stringify(b)) <= 1900000 + 1024);
    const flat = batches.flat();
    const chunks = flat.filter((e) => e.category === 'case' && e.value.relPath === 'big.bin');
    assert.deepStrictEqual(chunks.map((c) => c.value.offset), [0, 1048576, 2097152]);
    assert.ok(flat.some((e) => e.category === 'vault' && e.value === 'ENC-github'));
    assert.ok(!flat.some((e) => e.category === 'settings'));
    assert.deepStrictEqual(skipped, [{ category: 'memory', key: 'missing', error: 'not found in the desktop profile' }]);
  });
});

describe('king-louie-service import --from', () => {
  const io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } }, ownership: { getuid: () => 1000 } } };
  };

  it('needs --from, an administrator and a stopped service', async () => {
    const dataDir = tmp();
    let o = io();
    assert.strictEqual(await runImportCommand({ flags: {}, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } }), 2);
    o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => false, runningServicePid: () => null } }), 1);
    assert.match(o.out.stderr, /run it as root\/an administrator/);
    o = io();
    assert.strictEqual(await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => 4242 } }), 1);
    assert.strictEqual(o.out.stderr, `Stop the service before importing into ${dataDir}.\n`);
  });

  it('dry run prints the plan and writes nothing', async () => {
    const dataDir = tmp();
    const o = io();
    const code = await runImportCommand({ flags: { from: userData(), dryRun: true }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } });
    assert.strictEqual(code, 0);
    assert.match(o.out.stdout, /new\s+chat c1/);
    assert.match(o.out.stdout, /needs-desktop\s+vault github/);
    assert.match(o.out.stdout, /Dry run: nothing was written\./);
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'imports')), false);
  });

  it('imports everything but secrets, which it lists as needs-desktop', async () => {
    const dataDir = tmp();
    const savedRoot = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    try {
      const o = io();
      const code = await runImportCommand({ flags: { from: userData() }, dataDir, io: o.io, deps: { isAdmin: () => true, runningServicePid: () => null } });
      assert.strictEqual(code, 0, o.out.stderr);
      const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
      assert.ok(store.chats.some((c) => c.id === 'c1'));
      const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'cron', 'jobs.json'), 'utf8'));
      assert.strictEqual(jobs.cron_1.enabled, false);
      assert.ok(fs.existsSync(path.join(dataDir, 'cases', 'lakeside-lot', 'notes', 'a.md')));
      assert.match(o.out.stdout, /needs-desktop/);
      assert.match(o.out.stdout, /imported disabled/);
      assert.ok(!fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8').includes('ENC-anthropic'));
    } finally {
      if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
    }
  });
});
```

Append to `tests/electron-boundary.test.js`, inside `describe('Electron import boundary', () => {`, after the existing `it(…)` block:

```js
  it('walks the fleet stage 7 desktop bridge and migration modules', () => {
    const files = walk(SRC).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    assert.ok(files.some((f) => f.startsWith('desktop-bridge/')), 'src/desktop-bridge/ is checked');
    assert.ok(files.some((f) => f.startsWith('migration/')), 'src/migration/ is checked');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-import-source.test.js`
Expected: FAIL with `Cannot find module '../src/migration/desktop-source'`.

- [ ] **Step 3: Implement**

Create `src/migration/desktop-source.js`:

```js
// Reads a desktop profile for import (fleet stage 7 §3.8, R51). The tree is
// user-controlled and may be read by root, so the walker lstats every level,
// refuses links, hardlinked files and foreign owners, opens with O_NOFOLLOW
// where the platform has it, and checks the opened handle is the inode it
// checked. A refused file is reported, never read.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EXCLUDED } = require('./desktop-import');

const INSTALL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CASE_DIR_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const arr = (v) => (Array.isArray(v) ? v : []);

function createSafeReader({ root, platform = process.platform }) {
  const rootPath = path.resolve(root);
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`${rootPath} is not a directory (links are refused)`);
  const ownerUid = rootStat.uid;
  const checkOwner = platform !== 'win32';

  const parts = (rel) => {
    const segs = String(rel).split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '.' || s === '..')) return null;
    return segs;
  };

  // lstat every component below root; never follows a link.
  function check(rel) {
    const segs = parts(rel);
    if (!segs) return { refused: `${rel} leaves the profile directory` };
    let cur = rootPath;
    let st = rootStat;
    for (let i = 0; i < segs.length; i += 1) {
      cur = path.join(cur, segs[i]);
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        return err.code === 'ENOENT' ? { missing: true } : { refused: `${cur}: ${err.message}` };
      }
      if (st.isSymbolicLink()) return { refused: `${cur} is a link` };
      if (checkOwner && st.uid !== ownerUid) return { refused: `${cur} is owned by uid ${st.uid}, not by the owner of ${rootPath}` };
      if (i < segs.length - 1 && !st.isDirectory()) return { refused: `${cur} is not a directory` };
    }
    return { path: cur, stat: st };
  }

  function readFile(rel) {
    const r = check(rel);
    if (r.missing) return { ok: false, missing: true };
    if (r.refused) return { ok: false, reason: r.refused };
    if (!r.stat.isFile()) return { ok: false, reason: `${r.path} is not a regular file` };
    if (r.stat.nlink > 1) return { ok: false, reason: `${r.path} has ${r.stat.nlink} hard links` };
    let fd;
    try {
      fd = fs.openSync(r.path, fs.constants.O_RDONLY | NOFOLLOW);
      const st = fs.fstatSync(fd);
      if (st.ino !== r.stat.ino || st.dev !== r.stat.dev || st.nlink > 1) return { ok: false, reason: `${r.path} changed while it was being read` };
      return { ok: true, data: fs.readFileSync(fd) };
    } catch (err) {
      return { ok: false, reason: `${r.path}: ${err.message}` };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function listDir(rel) {
    const r = check(rel);
    if (r.missing) return { dirs: [], refused: [] };
    if (r.refused) return { dirs: [], refused: [{ relPath: String(rel), reason: r.refused }] };
    const dirs = [];
    const refused = [];
    for (const name of fs.readdirSync(r.path)) {
      const sub = check(path.join(String(rel), name));
      if (sub.refused) refused.push({ relPath: path.join(String(rel), name), reason: sub.refused });
      else if (sub.stat && sub.stat.isDirectory()) dirs.push(name);
    }
    return { dirs: dirs.sort(), refused };
  }

  function listFiles(rel) {
    const files = [];
    const refused = [];
    const walk = (sub) => {
      const full = sub ? path.join(String(rel), sub) : String(rel);
      const r = check(full);
      if (r.missing) return;
      if (r.refused) { refused.push({ relPath: sub || '.', reason: r.refused }); return; }
      if (r.stat.isDirectory()) {
        for (const name of fs.readdirSync(r.path).sort()) walk(sub ? `${sub}/${name}` : name);
        return;
      }
      if (!r.stat.isFile()) { refused.push({ relPath: sub, reason: `${r.path} is not a regular file` }); return; }
      if (r.stat.nlink > 1) { refused.push({ relPath: sub, reason: `${r.path} has ${r.stat.nlink} hard links` }); return; }
      files.push({ relPath: sub, mode: r.stat.mode & 0o777, size: r.stat.size });
    };
    walk('');
    return { files, refused };
  }

  return { root: rootPath, readFile, listDir, listFiles };
}

function readDesktopSource({ userDataDir, reader, decrypt = null, secrets = decrypt ? 'included' : 'needs-desktop' }) {
  const attention = [];
  const readJson = (rel) => {
    const r = reader.readFile(rel);
    if (r.ok) {
      try {
        return JSON.parse(r.data.toString('utf8'));
      } catch (err) {
        attention.push({ category: 'source', key: rel, note: `not JSON (${err.message})` });
        return null;
      }
    }
    if (!r.missing) attention.push({ category: 'source', key: rel, note: r.reason });
    return null;
  };

  const chatData = readJson('chat-data.json') || {};
  const config = readJson('config.json') || {};
  const memoryDoc = readJson(path.join('memory', 'memory-store.json')) || {};
  const cronDoc = readJson(path.join('cron', 'jobs.json')) || {};
  const desktopState = readJson('desktop-bridge.json');
  const installId = desktopState && typeof desktopState.installId === 'string' && INSTALL_ID_RE.test(desktopState.installId)
    ? desktopState.installId
    : crypto.createHash('sha256').update(fs.realpathSync.native(userDataDir)).digest('hex').slice(0, 16);

  const settings = chatData.settings && typeof chatData.settings === 'object' ? chatData.settings : {};
  const chats = arr(chatData.chats).filter((c) => c && typeof c.id === 'string' && c.id);
  const tokens = chatData.apiTokens && typeof chatData.apiTokens === 'object' ? chatData.apiTokens : {};
  const toolApprovals = chatData.toolApprovals && typeof chatData.toolApprovals === 'object' ? chatData.toolApprovals : {};
  const alwaysApprove = toolApprovals.alwaysApproveTools && typeof toolApprovals.alwaysApproveTools === 'object' ? toolApprovals.alwaysApproveTools : {};
  const oauth = chatData.anthropicOAuth && chatData.anthropicOAuth.accessToken ? chatData.anthropicOAuth : null;
  const casesRootSetting = settings.cases && typeof settings.cases.root === 'string' ? settings.cases.root.trim() : '';
  const memoryEntries = arr(memoryDoc.entries).filter((e) => e && typeof e.id === 'string' && e.id);
  const cronJobs = Object.values(cronDoc).filter((j) => j && typeof j.id === 'string' && j.id);

  const cases = [];
  if (!casesRootSetting) {
    const listed = reader.listDir('cases');
    for (const r of listed.refused) attention.push({ category: 'case', key: r.relPath, note: r.reason });
    for (const dir of listed.dirs) {
      if (!CASE_DIR_RE.test(dir)) continue;
      const { files, refused } = reader.listFiles(path.join('cases', dir));
      for (const r of refused) attention.push({ category: 'case', key: `${dir}/${r.relPath}`, note: r.reason });
      cases.push({ dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
    }
  }

  const inventory = {
    installId,
    sourceVersion: null,
    chats: chats.map((c) => ({ id: c.id, updatedAt: c.updatedAt || null, title: String(c.title || '') })),
    settingsKeys: Object.keys(settings).filter((k) => !['allowedDirectories', 'webSearch', 'imageGeneration'].includes(k)),
    userProfile: Boolean(chatData.userProfile),
    permissionRules: arr(toolApprovals.permissionRules).filter((r) => r && r.tool && r.action).map((r) => ({ tool: r.tool, pattern: r.pattern || '*', action: r.action })),
    alwaysApprove: Object.keys(alwaysApprove).filter((k) => alwaysApprove[k] === true),
    providerTokens: Object.keys(tokens).filter((k) => tokens[k] && (!k.startsWith('__') || k === '__elevenlabs_api_key')),
    searchKeys: Object.keys(settings.webSearch || {}).filter((p) => settings.webSearch[p] && settings.webSearch[p].apiKey),
    imageKeys: Object.keys(settings.imageGeneration || {}).filter((p) => settings.imageGeneration[p] && settings.imageGeneration[p].apiKey),
    vault: Object.keys(config).filter((k) => k.startsWith('__vault_') && config[k]).map((k) => k.slice('__vault_'.length)),
    anthropicOAuth: Boolean(oauth),
    memory: memoryEntries.map((e) => e.id),
    cron: cronJobs.map((j) => ({ id: j.id, name: String(j.name || '') })),
    cases,
    customCasesRoot: casesRootSetting || null,
    allowedDirectories: arr(settings.allowedDirectories).filter((d) => typeof d === 'string' && d),
    excluded: Object.keys(EXCLUDED),
    secrets
  };

  const secret = (encrypted) => {
    if (!decrypt) throw new Error('only the desktop app can read its secrets');
    return encrypted ? decrypt(encrypted) : null;
  };

  function getValue(category, key) {
    switch (category) {
      case 'settings': return settings[key] === undefined ? null : settings[key];
      case 'userProfile': return chatData.userProfile || null;
      case 'permissionRule': {
        const [tool, pattern, action] = String(key).split('|');
        return { tool, pattern, action };
      }
      case 'alwaysApprove': return true;
      case 'allowedDirectory': return key;
      case 'chat': return chats.find((c) => c.id === key) || null;
      case 'memory': return memoryEntries.find((e) => e.id === key) || null;
      case 'cron': return cronJobs.find((j) => j.id === key) || null;
      case 'providerToken': return secret(tokens[key]);
      case 'searchKey': return secret(settings.webSearch && settings.webSearch[key] && settings.webSearch[key].apiKey);
      case 'imageKey': return secret(settings.imageGeneration && settings.imageGeneration[key] && settings.imageGeneration[key].apiKey);
      case 'vault': return secret(config[`__vault_${key}`]);
      case 'anthropicOAuth':
        if (!oauth) return null;
        return {
          accessToken: secret(oauth.accessToken),
          refreshToken: oauth.refreshToken ? secret(oauth.refreshToken) : null,
          expiresAt: oauth.expiresAt ?? null,
          connectedAt: oauth.connectedAt ?? null,
          clientId: typeof chatData.anthropicOAuthClientId === 'string' ? chatData.anthropicOAuthClientId : ''
        };
      default: return null;
    }
  }

  function caseFiles(dir) {
    const base = path.join('cases', dir);
    return reader.listFiles(base).files.map((f) => ({ ...f, read: () => reader.readFile(path.join(base, ...f.relPath.split('/'))) }));
  }

  return { installId, inventory, attention, getValue, caseFiles };
}

// Apply batches for the plan's write items. Secret values appear only here.
function* planBatches(planItems, source, { maxBytes = 1900000, chunkBytes = 1024 * 1024, skipped = [] } = {}) {
  let batch = [];
  let size = 2;
  function* push(entry) {
    const s = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (batch.length && size + s > maxBytes) {
      yield batch;
      batch = [];
      size = 2;
    }
    batch.push(entry);
    size += s;
  }
  for (const item of planItems) {
    if (!WRITE_ACTIONS.has(item.action)) continue;
    if (item.category === 'case') {
      for (const f of source.caseFiles(item.key)) {
        const r = f.read();
        if (!r.ok) { skipped.push({ category: 'case', key: `${item.key}/${f.relPath}`, error: r.reason || 'missing' }); continue; }
        for (let offset = 0; offset === 0 || offset < r.data.length; offset += chunkBytes) {
          yield* push({ category: 'case', key: item.key, value: { relPath: f.relPath, mode: f.mode, offset, b64: r.data.subarray(offset, offset + chunkBytes).toString('base64') } });
        }
      }
      continue;
    }
    let value;
    try {
      value = source.getValue(item.category, item.key);
    } catch (err) {
      skipped.push({ category: item.category, key: item.key, error: err.message });
      continue;
    }
    if (value === null || value === undefined) {
      skipped.push({ category: item.category, key: item.key, error: 'not found in the desktop profile' });
      continue;
    }
    yield* push({ category: item.category, key: item.key, value });
  }
  if (batch.length) yield batch;
}

module.exports = { createSafeReader, readDesktopSource, planBatches };
```

Create `src/service/commands/admin-check.js`:

```js
// "Is this process root / an elevated Administrator?" for admin-only commands.
const { execFileSync } = require('child_process');
const { windowsPowerShellExe } = require('../../platform/windows-paths');

const IS_ADMIN_SCRIPT = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

function isAdmin({
  platform = process.platform,
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  execFile = execFileSync,
  env = process.env
} = {}) {
  if (platform === 'win32') {
    try {
      const out = execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', IS_ADMIN_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return String(out).trim() === 'True';
    } catch {
      return false;
    }
  }
  return geteuid() === 0;
}

module.exports = { isAdmin };
```

Create `src/service/commands/import.js`:

```js
// king-louie-service import --from <userData> [--data-dir DIR] [--dry-run]
// (fleet stage 7 §3.8). Root/Administrator only, service stopped. Secrets
// are reported needs-desktop: safeStorage ciphertext opens only in the
// desktop user's session.
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const path = require('path');
const { readDesktopSource, createSafeReader, planBatches } = require('../../migration/desktop-source');
const { DesktopImporter, buildImportTargets } = require('../../migration/desktop-import');
const { createDesktopScope } = require('../../desktop-bridge/desktop-scope');
const { checkPath } = require('../../desktop-bridge/check-path');
const { restoreDataDirOwnership } = require('../ownership');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const IMPORT_USAGE = 'Usage: king-louie-service import --from <desktop user-data dir> [--data-dir DIR] [--dry-run]\n';

function defaultOpenCore(dataDir, onPathWritten) {
  const { createCore } = require('../../core');
  const { CHAT_DATA_DEFAULTS } = require('../../core/settings');
  const { buildServicePorts } = require('../ports');
  const ports = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS, onPathWritten });
  return { core: createCore(ports), cipher: ports.cipher };
}

function printPlan(io, plan, attention) {
  for (const item of plan.items) {
    io.stdout.write(`  ${item.action.padEnd(16)} ${item.category} ${item.key}${item.note ? `  (${item.note})` : ''}\n`);
  }
  for (const a of attention) io.stdout.write(`  ${'needs-attention'.padEnd(16)} ${a.category} ${a.key}  (${a.note})\n`);
  io.stdout.write(`${Object.entries(plan.counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')}\n`);
}

function printReport(io, report, skipped) {
  io.stdout.write(`Imported. ${Object.entries(report.counts).filter(([, n]) => n).map(([a, n]) => `${a}: ${n}`).join(', ')}\n`);
  for (const f of report.failures) io.stdout.write(`  failed ${f.category} ${f.key}: ${f.error}\n`);
  for (const s of skipped) io.stdout.write(`  not read ${s.category} ${s.key}: ${s.error}\n`);
  for (const a of report.attention) io.stdout.write(`  needs attention ${a.category} ${a.key}: ${a.note}\n`);
  for (const note of report.notes) io.stdout.write(`${note}\n`);
}

async function runImportCommand({ flags = {}, dataDir, io, deps = {} }) {
  const platform = deps.platform || process.platform;
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const runningServicePid = deps.runningServicePid || (() => null);
  const openCore = deps.openCore || defaultOpenCore;
  if (!flags.from) {
    io.stderr.write(IMPORT_USAGE);
    return 2;
  }
  if (!(await isAdmin())) {
    io.stderr.write(`import writes ${dataDir}; run it as root/an administrator.\n`);
    return 1;
  }
  if (runningServicePid(dataDir)) {
    io.stderr.write(`Stop the service before importing into ${dataDir}.\n`);
    return 1;
  }
  const from = path.resolve(flags.from);
  let source;
  try {
    source = readDesktopSource({ userDataDir: from, reader: createSafeReader({ root: from, platform }), decrypt: null, secrets: 'needs-desktop' });
  } catch (err) {
    io.stderr.write(`Cannot read ${from}: ${err.message}\n`);
    return 1;
  }
  const written = [];
  const record = (p) => written.push(p);
  try {
    const { core, cipher } = openCore(dataDir, record);
    const targets = await buildImportTargets({ context: core.context, dataDir, offline: true });
    written.push(...targets.writtenPaths);
    const importer = new DesktopImporter({
      context: core.context,
      targets,
      dataDir,
      cipher,
      checkPath,
      scope: createDesktopScope({ dataDir, context: core.context, onPathWritten: record }),
      onPathWritten: record
    });
    const plan = await importer.plan({ installId: source.installId, inventory: source.inventory, source: 'cli' });
    printPlan(io, plan, source.attention);
    if (flags.dryRun) {
      io.stdout.write('Dry run: nothing was written.\n');
      return 0;
    }
    const skipped = [];
    for (const batch of planBatches(plan.items, source, { skipped })) {
      await importer.apply({ planId: plan.planId, batch });
    }
    const report = await importer.finish({ planId: plan.planId });
    printReport(io, report, skipped);
    return report.failures.length ? 1 : 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runImportCommand, IMPORT_USAGE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-import-source.test.js tests/desktop-import.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0` (symlink and root-only cases skip where the account cannot run them).

- [ ] **Step 5: Commit**

```bash
git add src/migration/desktop-source.js src/service/commands/admin-check.js src/service/commands/import.js tests/desktop-import-source.test.js tests/electron-boundary.test.js
git commit -m "feat(migration): safe desktop-profile reader and import --from

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `king-louie-service desktop pair|unpair|list` and the CLI dispatch

**Files:**
- Create: `src/service/commands/desktop.js`
- Modify: `src/service/cli.js` — the line `const VALUE_FLAGS = new Set(['data-dir', 'profile', 'user']);`; before the line `      case 'install':` inside `main`'s `switch (command)`
- Test: `tests/desktop-cli.test.js`

**Interfaces:**
- Consumes: Task 2 (`decodePairRequest`, `parseDevices`, `emptyDevices`, `upsertDevice`, `removeDevice`, `bridgeFileRecord`, `writeFileAtomic`, `DEVICES_FILE`, `BRIDGE_FILE`, `fingerprintGroups`, `DEFAULT_DESKTOP_BRIDGE_PORT`), Task 9 (`isAdmin`, `runImportCommand`), `adminConfigDir`, `windowsSystemRoot`, `getOrGenerateNodeIdentity`, `loadNodeConfig`, `assertAdminOwned` (test), `main`'s local `withServiceCore` and `runningServicePid`.
- Produces: `runDesktopCommand({ sub, arg, dataDir, io, deps: { isAdmin, configDir, platform, runningServicePid, withServiceCore, nodeName, now, applyWindowsAcls, chownDevicesFile } }) → exit code`; `grantDirectoryReadControl(dir, { execFile, env })`; `applyWindowsAcls({ bridgeFile, configDir, execFile, env })`; `DESKTOP_HELP`; `PAIR_WARNING`. CLI: `desktop pair <request>`, `desktop unpair <deviceId>`, `desktop list`, `import --from <dir> [--dry-run]`.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-cli.test.js`:

```js
// tests/desktop-cli.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { assertAdminOwned } = require('../src/service/config');
const { runDesktopCommand, grantDirectoryReadControl, PAIR_WARNING } = require('../src/service/commands/desktop');
const { main } = require('../src/service/cli');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function layout({ serviceJson = null, identity = new NodeIdentity({ nodeName: 'gpu-box' }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-desktop-cli-'));
  dirs.push(root);
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (identity) fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: { publicKey: identity.publicKey.toString('hex') } } }));
  if (serviceJson) fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify(serviceJson), { mode: 0o644 });
  return { root, dataDir, configDir, identity };
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } }, ownership: { getuid: () => 1000 } } };
}

function request(label = 'web-01 desk') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return pairing.encodePairRequest({ publicKeyRaw: keys.rawFromPublicKeyObject(publicKey), label });
}

const deps = (l, extra = {}) => ({
  isAdmin: () => true,
  configDir: l.configDir,
  runningServicePid: () => null,
  withServiceCore: () => { throw new Error('withServiceCore must not be called'); },
  applyWindowsAcls: () => {},
  now: () => new Date('2026-09-23T14:02:11.123Z'),
  ...extra
});

describe('desktop pair', () => {
  it('refuses without administrator rights', async () => {
    const l = layout();
    const c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l, { isAdmin: () => false }) }), 1);
    assert.strictEqual(c.out.stderr, `desktop pair writes ${l.configDir}; run it as root/an administrator.\n`);
  });

  it('refuses on profile: runbook, and a malformed request', async () => {
    const l = layout({ serviceJson: { profile: 'runbook' } });
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l) }), 1);
    assert.strictEqual(c.out.stderr, 'desktopBridge needs profile: agent\n');
    const l2 = layout();
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: 'klpair1.nope', dataDir: l2.dataDir, io: c.io, deps: deps(l2) }), 2);
  });

  it('writes the devices file, the bridge file and merges service.json', async () => {
    const l = layout({ serviceJson: { profile: 'agent', features: { gateway: true }, ports: { gateway: 18793 } } });
    const req = request('web-01 desk');
    const decoded = pairing.decodePairRequest(req);
    const c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: req, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    const devices = pairing.parseDevices(fs.readFileSync(path.join(l.configDir, 'desktop-devices.json'), 'utf8'));
    assert.deepStrictEqual(devices.devices, [{ deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' }]);
    const bridge = JSON.parse(fs.readFileSync(path.join(l.configDir, 'desktop-bridge.json'), 'utf8'));
    assert.deepStrictEqual(bridge, { v: 1, nodeId: l.identity.nodeId, publicKey: l.identity.publicKey.toString('hex'), host: '127.0.0.1', port: 18795, protocol: 1 });
    assert.strictEqual(deriveNodeId(bridge.publicKey), bridge.nodeId);
    const svc = JSON.parse(fs.readFileSync(path.join(l.configDir, 'service.json'), 'utf8'));
    assert.deepStrictEqual(svc, { profile: 'agent', features: { gateway: true, desktopBridge: true }, ports: { gateway: 18793, desktopBridge: 18795 } });
    assert.ok(c.out.stdout.includes(keys.fingerprintGroups(decoded.deviceId)));
    assert.ok(c.out.stdout.includes(keys.fingerprintGroups(l.identity.nodeId)));
    assert.ok(c.out.stdout.includes('Port: 18795'));
    assert.ok(c.out.stdout.includes(PAIR_WARNING));
    assert.ok(c.out.stdout.includes('Restart the service to open the desktop bridge.'));
    const again = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request('second desk'), dataDir: l.dataDir, io: again.io, deps: deps(l) }), 0);
    assert.ok(!again.out.stdout.includes('Restart the service'), 'the feature was already on');
  });

  it('passes the service\'s own ownership check for its devices file', { skip: process.platform === 'win32' ? 'assertAdminOwned is a no-op on win32' : false }, async () => {
    const l = layout();
    const c = capture();
    await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l) });
    const file = path.join(l.configDir, 'desktop-devices.json');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640);
    assertAdminOwned(file, () => -1, selfUid, pairing.DEVICES_CONTROLS);
    assert.strictEqual(fs.statSync(path.join(l.configDir, 'desktop-bridge.json')).mode & 0o777, 0o644);
  });

  it('needs a stopped service to create a missing node identity', async () => {
    const l = layout({ identity: null });
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l, { runningServicePid: () => 4242 }) }), 1);
    assert.strictEqual(c.out.stderr, 'No node identity yet. Stop the service once and rerun this command.\n');
    const created = new NodeIdentity({ nodeName: 'gpu-box' });
    let calls = 0;
    c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io,
      deps: deps(l, { withServiceCore: (_dir, _io, fn) => { calls += 1; return fn({ context: { getStore: () => null } }, { cipher: null }); }, createIdentity: () => created })
    });
    assert.strictEqual(code, 0, c.out.stderr);
    assert.strictEqual(calls, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(l.configDir, 'desktop-bridge.json'), 'utf8')).nodeId, created.nodeId);
  });
});

describe('desktop unpair and list', () => {
  it('lists, removes and reports an unknown device', async () => {
    const l = layout();
    const req = request('web-01 desk');
    await runDesktopCommand({ sub: 'pair', arg: req, dataDir: l.dataDir, io: capture().io, deps: deps(l) });
    const { deviceId } = pairing.decodePairRequest(req);
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'list', dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    assert.match(c.out.stdout, new RegExp(`${deviceId}\\s+web-01 desk\\s+paired 2026-09-23T14:02:11Z`));
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'unpair', arg: deviceId, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    assert.deepStrictEqual(pairing.parseDevices(fs.readFileSync(path.join(l.configDir, 'desktop-devices.json'), 'utf8')).devices, []);
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'unpair', arg: deviceId, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 1);
    assert.strictEqual(c.out.stderr, `No paired desktop ${deviceId}.\n`);
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'list', dataDir: l.dataDir, io: c.io, deps: deps(l, { isAdmin: () => false }) }), 1);
  });
});

describe('CLI dispatch', () => {
  it('routes desktop and import, printing usage without a subcommand', async () => {
    const c = capture();
    assert.strictEqual(await main(['desktop'], { stdin: process.stdin, ...c.io }), 2);
    assert.match(c.out.stderr, /king-louie-service desktop pair <request>/);
    const c2 = capture();
    assert.strictEqual(await main(['import'], { stdin: process.stdin, ...c2.io }), 2);
    assert.match(c2.out.stderr, /import --from/);
  });
});

describe('Windows ACE for the bridge-file directory (R56)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  it('grants Authenticated Users READ_CONTROL|FILE_READ_ATTRIBUTES, not inherited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ace-'));
    dirs.push(dir);
    grantDirectoryReadControl(dir);
    const script = "(Get-Acl -LiteralPath $env:KL_ACE_DIR).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-11' -and -not $_.IsInherited } | ForEach-Object { \"$($_.FileSystemRights)|$($_.InheritanceFlags)\" }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, KL_ACE_DIR: dir }, encoding: 'utf8' }).trim();
    assert.match(out, /ReadAttributes/);
    assert.match(out, /ReadPermissions/);
    assert.match(out, /\|None$/m, 'no inheritance flags');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-cli.test.js`
Expected: FAIL with `Cannot find module '../src/service/commands/desktop'`.

- [ ] **Step 3: Implement**

Create `src/service/commands/desktop.js`:

```js
// king-louie-service desktop pair|unpair|list (fleet stage 7 §3.2).
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { adminConfigDir } = require('../../platform/paths');
const { windowsSystemRoot } = require('../../platform/windows-paths');
const {
  decodePairRequest, parseDevices, emptyDevices, upsertDevice, removeDevice,
  bridgeFileRecord, writeFileAtomic, DEVICES_FILE, BRIDGE_FILE
} = require('../../desktop-bridge/pairing');
const { fingerprintGroups } = require('../../desktop-bridge/keys');
const { DEFAULT_DESKTOP_BRIDGE_PORT } = require('../../desktop-bridge/protocol');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const DESKTOP_HELP = `Usage: king-louie-service desktop pair <request> [--data-dir DIR]
       king-louie-service desktop unpair <device-id> [--data-dir DIR]
       king-louie-service desktop list [--data-dir DIR]
`;
const PAIR_WARNING = 'Every paired desktop sees every chat, setting and secret name in this service, and directories and rules it adds apply to its own runs only.';

const icaclsExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'icacls.exe');

// R56: a normal user must be able to read the owner of the bridge file's
// directory. Non-inherited on purpose: it applies to this directory only.
function grantDirectoryReadControl(dir, { execFile = execFileSync, env = process.env } = {}) {
  execFile(icaclsExe(env), [dir, '/grant', '*S-1-5-11:(RC,RA)'], { windowsHide: true, stdio: 'pipe' });
}

function applyWindowsAcls({ bridgeFile, configDir, execFile = execFileSync, env = process.env }) {
  execFile(icaclsExe(env), [bridgeFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-19:R', '*S-1-5-11:R'], { windowsHide: true, stdio: 'pipe' });
  grantDirectoryReadControl(configDir, { execFile, env });
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Replace the file but keep its mode and (as root) its owner.
function writeKeepingOwnership(file, text) {
  let st = null;
  try { st = fs.statSync(file); } catch { st = null; }
  writeFileAtomic(file, text, st ? st.mode & 0o7777 : 0o644);
  if (st && typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(file, st.uid, st.gid);
}

// POSIX 0640 root:<service group>, the data dir's group being the service account's.
function defaultChownDevicesFile(file, dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  let gid = 0;
  try { gid = fs.statSync(dataDir).gid; } catch { gid = 0; }
  fs.chownSync(file, 0, gid);
}

function defaultNodeName(dataDir) {
  const { loadNodeConfig } = require('../node-config');
  return loadNodeConfig({ dataDir }).name;
}

function defaultCreateIdentity(core, ports, nodeName) {
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  return getOrGenerateNodeIdentity(core.context.getStore(), ports.cipher, nodeName);
}

// The node identity, read-only from <dataDir>/chat-data.json; created only
// when the service is stopped (a running service would overwrite the store).
async function resolveNodePublicKey({ dataDir, io, deps }) {
  const file = path.join(dataDir, 'chat-data.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hex = data && data.mesh && data.mesh.identity && data.mesh.identity.publicKey;
    if (hex) return { ok: true, publicKey: hex };
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: `Cannot read ${file}: ${err.message}` };
  }
  if (deps.runningServicePid(dataDir)) return { ok: false, error: 'No node identity yet. Stop the service once and rerun this command.' };
  const nodeName = deps.nodeName ? deps.nodeName() : defaultNodeName(dataDir);
  const create = deps.createIdentity ? (() => deps.createIdentity()) : null;
  const identity = await deps.withServiceCore(dataDir, io, (core, ports) => (create ? create() : defaultCreateIdentity(core, ports, nodeName)));
  return { ok: true, publicKey: identity.publicKey.toString('hex') };
}

async function runDesktopCommand({ sub, arg, dataDir, io, deps = {} }) {
  const platform = deps.platform || process.platform;
  const configDir = deps.configDir || adminConfigDir({ dataDir });
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const chownDevicesFile = deps.chownDevicesFile || defaultChownDevicesFile;
  const allDeps = { runningServicePid: () => null, ...deps };
  if (!['pair', 'unpair', 'list'].includes(sub)) {
    io.stderr.write(DESKTOP_HELP);
    return 2;
  }
  if (!(await isAdmin())) {
    io.stderr.write(`desktop ${sub} ${sub === 'list' ? 'reads' : 'writes'} ${configDir}; run it as root/an administrator.\n`);
    return 1;
  }
  const devicesFile = path.join(configDir, DEVICES_FILE);
  const readDevices = () => (fs.existsSync(devicesFile) ? parseDevices(fs.readFileSync(devicesFile, 'utf8')) : emptyDevices());
  const writeDevices = (doc) => {
    writeFileAtomic(devicesFile, `${JSON.stringify(doc, null, 2)}\n`, 0o640);
    if (platform !== 'win32') {
      fs.chmodSync(devicesFile, 0o640);
      chownDevicesFile(devicesFile, dataDir);
    }
  };

  if (sub === 'list') {
    const doc = readDevices();
    if (!doc.devices.length) io.stdout.write('No paired desktops.\n');
    for (const d of doc.devices) io.stdout.write(`${d.deviceId}  ${d.label}  paired ${d.pairedAt}\n`);
    return 0;
  }

  if (!arg) {
    io.stderr.write(DESKTOP_HELP);
    return 2;
  }

  if (sub === 'unpair') {
    const { doc, removed } = removeDevice(readDevices(), arg);
    if (!removed) {
      io.stderr.write(`No paired desktop ${arg}.\n`);
      return 1;
    }
    writeDevices(doc);
    io.stdout.write(`Unpaired ${arg}. A live connection from it closes within 5 seconds.\n`);
    return 0;
  }

  const serviceFile = path.join(configDir, 'service.json');
  const serviceCfg = readJsonIfExists(serviceFile);
  if (serviceCfg.profile === 'runbook') {
    io.stderr.write('desktopBridge needs profile: agent\n');
    return 1;
  }
  let request;
  try {
    request = decodePairRequest(arg);
  } catch (err) {
    io.stderr.write(`Not a pairing request: ${err.message}\n`);
    return 2;
  }
  const node = await resolveNodePublicKey({ dataDir, io, deps: allDeps });
  if (!node.ok) {
    io.stderr.write(`${node.error}\n`);
    return 1;
  }
  fs.mkdirSync(configDir, { recursive: true });
  const pairedAt = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeDevices(upsertDevice(readDevices(), { deviceId: request.deviceId, publicKey: request.publicKey, label: request.label, pairedAt }));

  const configured = serviceCfg.ports && Number.isInteger(serviceCfg.ports.desktopBridge) ? serviceCfg.ports.desktopBridge : undefined;
  const port = configured && configured > 0 ? configured : DEFAULT_DESKTOP_BRIDGE_PORT;
  const bridgeFile = path.join(configDir, BRIDGE_FILE);
  const record = bridgeFileRecord({ publicKey: node.publicKey, port });
  writeFileAtomic(bridgeFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);

  const turnedOn = !(serviceCfg.features && serviceCfg.features.desktopBridge === true);
  const merged = {
    ...serviceCfg,
    features: { ...(serviceCfg.features || {}), desktopBridge: true },
    ports: { ...(serviceCfg.ports || {}), ...(configured === undefined ? { desktopBridge: port } : {}) }
  };
  writeKeepingOwnership(serviceFile, `${JSON.stringify(merged, null, 2)}\n`);

  if (platform === 'win32') (deps.applyWindowsAcls || applyWindowsAcls)({ bridgeFile, configDir });
  else fs.chmodSync(bridgeFile, 0o644);

  io.stdout.write(`Desktop: ${request.label} (${fingerprintGroups(request.deviceId)})\n`);
  io.stdout.write(`Service: ${record.nodeId} (${fingerprintGroups(record.nodeId)})\n`);
  io.stdout.write(`Port: ${port}\n`);
  io.stdout.write(`${PAIR_WARNING}\n`);
  if (turnedOn) io.stdout.write('Restart the service to open the desktop bridge.\n');
  return 0;
}

module.exports = { runDesktopCommand, grantDirectoryReadControl, applyWindowsAcls, DESKTOP_HELP, PAIR_WARNING };
```

In `src/service/cli.js`, replace:

```js
const VALUE_FLAGS = new Set(['data-dir', 'profile', 'user']);
```

with:

```js
const VALUE_FLAGS = new Set(['data-dir', 'profile', 'user', 'from']);
```

and insert before the line `      case 'install':`:

```js
      case 'desktop': {
        const { runDesktopCommand } = require('./commands/desktop');
        return await runDesktopCommand({ sub, arg, dataDir, io, deps: { runningServicePid, withServiceCore } });
      }

      case 'import': {
        const { runImportCommand } = require('./commands/import');
        return await runImportCommand({ flags, dataDir, io, deps: { runningServicePid } });
      }

```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-cli.test.js tests/service-cli.test.js tests/service-cli-channel.test.js tests/service-cli-mcp-pair.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/service/commands/desktop.js src/service/cli.js tests/desktop-cli.test.js
git commit -m "feat(service): desktop pair/unpair/list and import commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `features.desktopBridge`, service wiring and `run.js`

**Files:**
- Create: `src/desktop-bridge/service-wiring.js`
- Modify: `src/service/config.js` — the `DEFAULT_FEATURES` line, the `DEFAULT_PORTS` line, the port range check in `validatePorts`, and after the `features.mesh` block in `loadServiceConfig`
- Modify: `src/service/run.js` — the agent profile's `async start({ dataDir, features, ports, workspace` line, `const core = createCore({` + `...servicePorts,`, the line `assertEnabledListenersBound(core, features);`, the agent profile's `return {`/`return { stop: () => core.shutdown(), …` statement, `runService`'s signature, its `loadServiceConfig(` call and its `loadProfile(profile).start({` call
- Modify: `tests/service-config.test.js` — the default expectations at its `it('defaults to agent profile …')`, `it('lets the admin config override the ports')` and `it('defaults every feature off …')`
- Test: `tests/desktop-bridge-service.test.js`

**Interfaces:**
- Consumes: `DesktopBridgeServer` (Task 4), `createBridgeDispatcher` (Task 7, through the server), `DesktopImporter`/`buildImportTargets` (Task 8), `getOrGenerateNodeIdentity`, `loadNodeConfig`, `adminConfigDir`; F3's `approvals` object when present.
- Produces: `DEFAULT_FEATURES.desktopBridge = false`, `DEFAULT_PORTS.desktopBridge = 18795` (0 accepted for this port only); `loadServiceConfig` throws `desktopBridge needs profile: agent` for `profile: runbook` with the feature on. `createDesktopBridgeHost({ dataDir, features, ports, adminUid, geteuid, configDir, version }) → { coreDeps, start({ core, ports: servicePorts, approvals }) → Promise<DesktopBridgeServer | null>, stop() → Promise<void>, server }` where `coreDeps = { ui: { send, reportError }, host: { interactive } }` only when the feature is on. `runService({ …, adminUid })` (tests only). `loadProfile('agent').start({ …, adminUid })` returns `desktopBridge` (the host) as well.

- [ ] **Step 1: Write the failing test**

Create `tests/desktop-bridge-service.test.js`:

```js
// tests/desktop-bridge-service.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig, DEFAULT_PORTS, DEFAULT_FEATURES } = require('../src/service/config');
const { createDesktopBridgeHost } = require('../src/desktop-bridge/service-wiring');
const { DesktopBridgeClient } = require('../src/desktop-bridge/bridge-client');
const { buildServicePorts } = require('../src/service/ports');
const { createCore } = require('../src/core');
const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
const { loadProfile } = require('../src/service/run');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function layout(adminCfg = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-svc-'));
  dirs.push(root);
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (adminCfg) {
    const file = path.join(configDir, 'service.json');
    fs.writeFileSync(file, JSON.stringify(adminCfg), { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  }
  return { dataDir, configDir };
}
const opts = (configDir) => ({ adminConfigDir: configDir, geteuid: () => -1, adminUid: selfUid });

describe('service config', () => {
  it('adds desktopBridge off by default on port 18795', () => {
    assert.strictEqual(DEFAULT_FEATURES.desktopBridge, false);
    assert.strictEqual(DEFAULT_PORTS.desktopBridge, 18795);
    const { dataDir, configDir } = layout();
    const cfg = loadServiceConfig(dataDir, {}, opts(configDir));
    assert.strictEqual(cfg.features.desktopBridge, false);
    assert.strictEqual(cfg.ports.desktopBridge, 18795);
  });

  it('accepts an ephemeral desktop bridge port but no other zero port', () => {
    let l = layout({ features: { desktopBridge: true }, ports: { desktopBridge: 0 } });
    assert.strictEqual(loadServiceConfig(l.dataDir, {}, opts(l.configDir)).ports.desktopBridge, 0);
    l = layout({ ports: { gateway: 0 } });
    assert.throws(() => loadServiceConfig(l.dataDir, {}, opts(l.configDir)), /ports\.gateway must be an integer from 1 to 65535/);
  });

  it('refuses the feature on profile: runbook', () => {
    const l = layout({ profile: 'runbook', features: { desktopBridge: true } });
    assert.throws(() => loadServiceConfig(l.dataDir, {}, opts(l.configDir)), /desktopBridge needs profile: agent/);
  });
});

describe('createDesktopBridgeHost', () => {
  it('is inert with the feature off', async () => {
    const { dataDir } = layout();
    const host = createDesktopBridgeHost({ dataDir, features: { desktopBridge: false }, ports: { desktopBridge: 0 } });
    assert.deepStrictEqual(host.coreDeps, {});
    assert.strictEqual(await host.start({}), null);
    await host.stop();
  });

  it('binds, serves a paired desktop, forwards ambient events and reports interactive', async () => {
    const { dataDir, configDir } = layout();
    const host = createDesktopBridgeHost({ dataDir, configDir, features: { desktopBridge: true }, ports: { desktopBridge: 0 }, adminUid: selfUid, version: '26.9.0' });
    assert.strictEqual(host.coreDeps.host.interactive(), false);
    const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
    const core = createCore({
      ...servicePorts,
      ...host.coreDeps,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny',
      workingDirectory: dataDir,
      builtinSkillsDir: path.join(__dirname, '..', 'skills')
    });
    await core.start();
    try {
      const server = await host.start({ core, ports: servicePorts, approvals: null });
      assert.ok(server.port > 0);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const raw = keys.rawFromPublicKeyObject(publicKey);
      const deviceId = keys.deriveDeviceId(raw, 'kld-');
      pairing.writeFileAtomic(path.join(configDir, 'desktop-devices.json'), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' })), 0o644);
      const client = new DesktopBridgeClient({
        port: server.port,
        pin: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex') },
        deviceId,
        sign: async (bytes) => crypto.sign(null, bytes, privateKey)
      });
      const service = await client.connect();
      assert.strictEqual(service.profile, 'agent');
      assert.ok(service.channels.includes('chat:load'));
      assert.strictEqual(host.coreDeps.host.interactive(), true);
      const events = [];
      client.on('event', (channel) => events.push(channel));
      host.coreDeps.ui.send('chat:updated', { chats: [] });
      host.coreDeps.ui.send('tool:approvalRequired', { approvalId: 'x' });
      const loaded = await client.invoke('chat:load', []);
      assert.strictEqual(loaded.ok, true);
      assert.deepStrictEqual(events, ['chat:updated']);
      const states = [];
      client.on('state', (s) => states.push(s.status));
      await host.stop();
      await new Promise((resolve) => { const check = () => (states.length ? resolve() : setTimeout(check, 10)); check(); });
      assert.strictEqual(host.coreDeps.host.interactive(), false);
      client.close();
    } finally {
      await host.stop();
      await core.shutdown();
    }
  });
});

describe('loadProfile("agent") with the desktop bridge', () => {
  it('starts the bridge after the core and stops it first', async () => {
    const { dataDir } = layout();
    const running = await loadProfile('agent').start({
      dataDir,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: true },
      ports: { gateway: 18793, webhook: 18794, desktopBridge: 0 },
      workspace: dataDir,
      adminUid: selfUid
    });
    try {
      assert.ok(running.desktopBridge.server.port > 0);
    } finally {
      await running.stop();
    }
    assert.strictEqual(running.desktopBridge.server, null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/desktop-bridge-service.test.js`
Expected: FAIL with `Cannot find module '../src/desktop-bridge/service-wiring'`.

- [ ] **Step 3: Implement**

Create `src/desktop-bridge/service-wiring.js`:

```js
// Service host wiring for the desktop bridge (fleet stage 7 §3.4). Agent
// profile only; everything is inert unless the admin config turns
// features.desktopBridge on.
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');

const log = createLogger('desktop-bridge');

function createDesktopBridgeHost({
  dataDir, features = {}, ports = {}, adminUid = 0,
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  configDir = adminConfigDir({ dataDir }),
  version = require(path.join(__dirname, '..', '..', 'package.json')).version
}) {
  if (!features.desktopBridge) {
    return { coreDeps: {}, start: async () => null, stop: async () => {}, server: null };
  }
  const host = {
    server: null,
    // ui: the core's ambient events go to the connected desktop (never
    // prompts; the dispatcher filters). host.interactive: C2's R50 port.
    coreDeps: {
      ui: {
        send: (channel, payload) => { if (host.server) host.server.forwardAmbient(channel, payload); },
        reportError: (message) => log.warn(`core reported: ${message}`)
      },
      host: { interactive: () => Boolean(host.server && host.server.connected != null) }
    },
    async start({ core, ports: servicePorts, approvals = null }) {
      const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
      const { loadNodeConfig } = require('../service/node-config');
      const { DesktopBridgeServer } = require('./bridge-server');
      const { DesktopImporter, buildImportTargets } = require('../migration/desktop-import');
      const nodeConfig = loadNodeConfig({ dataDir, adminConfigDir: configDir, geteuid, adminUid });
      const identity = getOrGenerateNodeIdentity(servicePorts.store, servicePorts.cipher, nodeConfig.name);
      const createImporter = async ({ scope, checkPath }) => new DesktopImporter({
        context: core.context,
        targets: await buildImportTargets({ context: core.context, dataDir }),
        dataDir,
        scope,
        checkPath,
        cipher: servicePorts.cipher
      });
      const server = new DesktopBridgeServer({
        core,
        identity,
        cipher: servicePorts.cipher,
        configDir,
        dataDir,
        port: ports.desktopBridge,
        version,
        geteuid,
        adminUid,
        approvals,
        createDispatcher: (opts) => require('./bridge-dispatcher').createBridgeDispatcher({ ...opts, createImporter })
      });
      // A failed bind is fatal (parent §4.3 I4): start() throws.
      await server.start();
      host.server = server;
      return server;
    },
    async stop() {
      const server = host.server;
      host.server = null;
      if (server) await server.stop();
    }
  };
  return host;
}

module.exports = { createDesktopBridgeHost };
```

In `src/service/config.js`, replace:

```js
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false };
```

with:

```js
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
```

Replace:

```js
const DEFAULT_PORTS = { gateway: 18793, webhook: 18794 };
```

with:

```js
// desktopBridge (fleet stage 7): the loopback listener the desktop app attaches to.
const DEFAULT_PORTS = { gateway: 18793, webhook: 18794, desktopBridge: 18795 };
```

In `validatePorts`, replace:

```js
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
```

with:

```js
    // 0 (ephemeral) only for the desktop bridge, which tests bind anywhere;
    // the desktop re-reads the bound port from desktop-bridge.json.
    const min = name === 'desktopBridge' ? 0 : 1;
    if (!Number.isInteger(value) || value < min || value > 65535) {
```

After the block:

```js
  if (features.mesh) {
    log.warn('features.mesh is not supported in service mode yet; ignoring it and keeping mesh off');
    features.mesh = false;
  }
```

add:

```js
  // The desktop bridge needs the agent stack it proxies to.
  if (features.desktopBridge && profile === 'runbook') {
    throw new Error('desktopBridge needs profile: agent');
  }
```

In `tests/service-config.test.js`, in `it('defaults to agent profile with listeners and chat channels off, on the service ports', …)` replace:

```js
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      ports: { gateway: 18793, webhook: 18794 }
```

with:

```js
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false },
      ports: { gateway: 18793, webhook: 18794, desktopBridge: 18795 }
```

replace:

```js
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(admin)).ports, { gateway: 28791, webhook: DEFAULT_PORTS.webhook });
```

with:

```js
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(admin)).ports, { gateway: 28791, webhook: DEFAULT_PORTS.webhook, desktopBridge: DEFAULT_PORTS.desktopBridge });
```

and in `it('defaults every feature off when there is no admin config at all', …)` replace:

```js
      gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false
```

with:

```js
      gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false
```

(If fleet stage 3 or 6 has already changed these expectations, add only the `desktopBridge` entries.)

In `src/service/run.js` (these anchors exist both on `main` and after F3's Part 3; where F3 changed a line, the F3 form is given too):

1. In the agent profile, add `adminUid` to the `start` parameters: `async start({ dataDir, features, ports, workspace })` becomes `async start({ dataDir, features, ports, workspace, adminUid })` (after F3: `async start({ dataDir, features, ports, workspace, audit, adminUid })`).

2. Replace:

```js
        const core = createCore({
          ...servicePorts,
```

with:

```js
        // Fleet stage 7: the desktop bridge's ui/host ports, when enabled.
        const { createDesktopBridgeHost } = require('../desktop-bridge/service-wiring');
        const desktopBridge = createDesktopBridgeHost({ dataDir, features, ports, adminUid });
        const core = createCore({
          ...servicePorts,
          ...desktopBridge.coreDeps,
```

3. Replace:

```js
          assertEnabledListenersBound(core, features);
```

with (before F3):

```js
          assertEnabledListenersBound(core, features);
          await desktopBridge.start({ core, ports: servicePorts, approvals: null });
```

or, when the function body declares `const approvals = await startApprovals(` (F3 merged):

```js
          assertEnabledListenersBound(core, features);
          await desktopBridge.start({ core, ports: servicePorts, approvals });
```

4. Replace the agent profile's return. Before F3:

```js
        return { stop: () => core.shutdown(), masterKeySource: servicePorts.masterKeySource };
```

with:

```js
        return {
          // The bridge says bye and closes before the core goes down.
          stop: async () => {
            await desktopBridge.stop();
            await core.shutdown();
          },
          masterKeySource: servicePorts.masterKeySource,
          desktopBridge
        };
```

After F3, in its `return {` block replace:

```js
          stop: async () => {
            await core.shutdown();
```

with:

```js
          stop: async () => {
            await desktopBridge.stop();
            await core.shutdown();
```

and add `desktopBridge` after the `approvals` line of that object (`          approvals,` then `          desktopBridge`).

5. In the `catch (err)` directly after `assertEnabledListenersBound`, replace:

```js
          await core.shutdown().catch(() => {});
```

with:

```js
          await desktopBridge.stop().catch(() => {});
          await core.shutdown().catch(() => {});
```

6. Replace:

```js
async function runService({ dataDir: requestedDataDir, profile: profileOverride, signal, stdout = process.stdout }) {
```

with:

```js
// adminUid: tests only (who owns the admin config); never from argv or config.
async function runService({ dataDir: requestedDataDir, profile: profileOverride, signal, stdout = process.stdout, adminUid }) {
```

7. Replace:

```js
      const config = loadServiceConfig(dataDir, { profile: profileOverride });
```

with:

```js
      const config = loadServiceConfig(dataDir, { profile: profileOverride }, adminUid === undefined ? {} : { adminUid });
```

8. In the `running = await loadProfile(profile).start({ … })` call, add `adminUid` to the object: `workspace })` becomes `workspace, adminUid })` (after F3: `workspace, audit: config.audit, adminUid })`).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/desktop-bridge-service.test.js tests/service-config.test.js tests/service-run.test.js tests/service-profile-graph.test.js tests/service-smoke.test.js`
Expected: PASS, `# fail 0` (`tests/service-config.test.js` asserts on warnings: run it without `KING_LOUIE_LOG_LEVEL=silent`).

- [ ] **Step 5: Commit**

```bash
git add src/desktop-bridge/service-wiring.js src/service/config.js src/service/run.js tests/service-config.test.js tests/desktop-bridge-service.test.js
git commit -m "feat(service): start the desktop bridge behind features.desktopBridge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 3 (exact exports after Parts 1 and 2 merge)

| Module | Exports |
|---|---|
| `src/core/origin.js` | `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn, { deviceId })`, `isLocalRequester(fn)` |
| `src/desktop-bridge/keys.js` | `toB64url`, `fromB64url`, `deriveDeviceId`, `ed25519RawToSpki`, `rawFromPublicKeyObject`, `verifyWithRawKey`, `verifyWithSpkiHex`, `fingerprintGroups`, `ED25519_SPKI_PREFIX` |
| `src/desktop-bridge/protocol.js` | `PROTOCOL`, `DEFAULT_DESKTOP_BRIDGE_PORT`, `LIMITS`, `CLOSE`, `NODE_ID_RE`, `DEVICE_ID_RE`, `NONCE_RE`, `newNonce`, `buildAuthS`, `buildAuthC`, `parseFrame`, `peekFrameId`, `BridgeError`, `MESSAGES` |
| `src/desktop-bridge/pairing.js` | `PAIR_PREFIX`, `DEVICES_FILE`, `BRIDGE_FILE`, `DEVICES_CONTROLS`, `ADMIN_OWNER_SIDS`, `PairingError`, `defaultDeviceLabel`, `encodePairRequest`, `decodePairRequest`, `emptyDevices`, `validateDevices`, `parseDevices`, `upsertDevice`, `removeDevice`, `findDevice`, `bridgeFileRecord`, `parseBridgeFile`, `writeFileAtomic`, `bridgeFilePath`, `inspectWindowsOwners`, `checkBridgeFileTrust`, `readTrustedBridgeFile` |
| `src/desktop-bridge/allowlist.js` | `PROXIED_DOMAINS`, `PROXIED_CHANNELS`, `PRESTEP_CHANNELS`, `RENDERER_EVENTS`, `PROMPT_EVENTS`, `ATTACHED_UNAVAILABLE_TABS`, `classifyChannel`, `servedChannels`, `isRendererEvent`, `isTimeoutExempt` |
| `src/desktop-bridge/connection.js` | `createConnection` |
| `src/desktop-bridge/bridge-server.js` | `DesktopBridgeServer` |
| `src/desktop-bridge/bridge-client.js` | `DesktopBridgeClient`, `DEFAULT_BACKOFF_MS` |
| `src/desktop-bridge/bridge-dispatcher.js` | `createBridgeDispatcher`, `approvalsStatus` |
| `src/desktop-bridge/desktop-scope.js` | `createDesktopScope` |
| `src/desktop-bridge/check-path.js` | `checkPath` |
| `src/desktop-bridge/service-wiring.js` | `createDesktopBridgeHost` |
| `src/migration/desktop-import.js` | `DesktopImporter`, `ImportError`, `buildImportTargets`, `IMPORTED_SETTINGS_KEYS`, `SECRET_CATEGORIES`, `CATEGORY_ORDER`, `EXCLUDED`, `PLAN_TTL_MS`, `MAX_BATCH_BYTES` |
| `src/migration/desktop-source.js` | `createSafeReader`, `readDesktopSource`, `planBatches` |
| `src/ipc/channel-inventory.js` | `listIpcChannels` |
| `src/ipc/desktop-handlers.js` | `DESKTOP_METHODS`, `createDesktopHandler`, `registerDesktopHandlers` |
| `src/ipc/constants.js` | adds `DESKTOP_STATUS`, `DESKTOP_PAIR_START`, `DESKTOP_PAIR_CONFIRM`, `DESKTOP_PAIR_CANCEL`, `DESKTOP_ATTACH`, `DESKTOP_DETACH`, `DESKTOP_STANDALONE_ONCE`, `DESKTOP_UNPAIR`, `DESKTOP_IMPORT_PLAN`, `DESKTOP_IMPORT_APPLY`, `DESKTOP_RETRY`, `DESKTOP_STATUS_CHANGED`, `DESKTOP_IMPORT_PROGRESS` |
| `src/memory/memory-manager.js` | `MemoryManager.prototype.importEntry(entry) → { imported }` |
| `src/service/installers.js` | adds `WINDOWS_INSPECT_CSHARP` |
| `src/service/config.js` | `DEFAULT_FEATURES.desktopBridge`, `DEFAULT_PORTS.desktopBridge` |
| `src/service/commands/admin-check.js` | `isAdmin` |
| `src/service/commands/desktop.js` | `runDesktopCommand`, `grantDirectoryReadControl`, `applyWindowsAcls`, `DESKTOP_HELP`, `PAIR_WARNING` |
| `src/service/commands/import.js` | `runImportCommand`, `IMPORT_USAGE` |
| `src/service/run.js` | `runService({ …, adminUid })`; `loadProfile('agent').start(…)` returns `desktopBridge` |
