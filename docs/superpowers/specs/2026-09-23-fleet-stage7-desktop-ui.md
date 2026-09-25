# Fleet Stage 7: The Electron app as a UI for the local service — Design Spec

- **Status:** Draft (review fixes applied)
- **Date:** 2026-09-23
- **Parent:** docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md §12 row 7, §13 Q6, §3.1 principle 3, §4.2, §4.3, §4.4
- **Program:** docs/superpowers/specs/2026-09-23-stage-program.md (owns the origin half of §4.21; §3 constraints; §5 rows `create-core.js`, IPC constants/register/preload, `renderer.js`/`styles.css`/`index.html`, `cli.js`, `run.js`, `config.js`, `installers.js`, `memory-manager.js`, `tests/e2e/helpers.js`; §6 ruling 9; R49, R50, R51, R56)
- **Depends on:** F2 (merged: `NodeIdentity`, `<configDir>` layout, admin-owned config checks). Shares the approval seam with F3 (§4.21); F3's phone branch and audit are F3-owned.

## 1. Outcome

An owner who runs `king-louie-service` on a desktop or laptop can pair the King Louie
desktop app with it once from an administrator console, copy their existing chats,
settings, memory, cron jobs, cases and secrets into the service, and turn on
**attached mode**. From then on the app starts no core of its own. It is a window onto
the service: chats run in the service, stream back to the window, and ask for approval
in the same on-screen dialog as before. The service keeps running its scheduled and remote
work when the window is closed (a chat started from the window stops with it), and the
machine runs one King Louie. Owners who never opt in see no change.

## 2. Scope

### 2.1 In

1. **Desktop bridge**: a loopback WebSocket listener in the service, separate from the
   gateway, with mutual Ed25519 authentication against a device paired by an administrator.
2. **Pairing**: `king-louie-service desktop pair|unpair|list` and the files it writes
   in `<configDir>`.
3. **Attached host**: in attached mode `main.js` builds no core and proxies an
   allowlisted set of IPC channels to the service. It forwards the service's renderer
   events back and answers every other channel with a fixed "not available" error.
4. **Local-origin approvals**: a run started over the bridge is a local desktop session.
   It gets the on-screen approval, ask-user and directory-access dialogs, and no other
   origin can reach them.
5. **Import** (Q6): run from the desktop over the bridge, secrets included; or
   `king-louie-service import --from <userData>`, which cannot copy secrets. Both have a
   dry run, are idempotent, and write a per-install manifest.
6. **Settings > Local service** pane: status, pair, import, attach, detach, unpair, and a
   read-only "Approvals and relay" section (F3's handoff).
7. **`main.js` split** into `src/ipc/standalone-host.js` and `src/ipc/attached-host.js`.
8. **E2E harness** replaced with Playwright `_electron` and an isolated `--user-data-dir`
   (ruling 9), plus `launchAttached()` against a temporary service.

### 2.2 Out

| Item | Owner |
|---|---|
| Proxying hooks, skills, MCP servers, webhooks, workflows/planner, tasks, agents, apps, mesh, channels, gateway, diagnostics, voice playback, Anthropic OAuth | later work, one domain at a time (§13) |
| Reverse import (service → standalone) | §13 |
| Phone approvals for remote-origin runs, the phone branch of the seam, the audit ledger | F3 |
| Approving from the desktop pane (the section is read-only) | later, if owners ask |
| GUI work from the service (Session 0 / no display) | F5 |
| A system-tray "service running" indicator | §13 |
| Making attached mode the default | a later decision by the owner |

**Why this cut.** Chat, settings, cases, cron and memory are what an owner uses daily. The
rest either spawns processes remote-origin runs would inherit (hooks, MCP, skills,
webhooks), needs a GUI session (apps, voice, OAuth, F5), or starts child runs without the
parent's event (workflows, tasks, background agents). All of it still works standalone.

## 3. Design

Fixed here, not owner choices: mode switches relaunch the app (§3.7); one live desktop
connection per service (§3.3); bridge port 18796 (§6); imported cron jobs arrive disabled (§3.8).

### 3.1 Transport choice: a dedicated desktop bridge, not the gateway

The gateway (`src/gateway/gateway-server.js`) authenticates with one bearer token, and
by construction its clients are **remote-origin**: `agent.execute` runs have no on-screen
approver. If the desktop were added to that listener, one socket would carry two trust
levels, and a dispatch bug could hand a bearer-token client a local-origin approval
path. The bridge therefore has its own listener, port, authentication and method table.
It reuses the gateway's hardening rules: literal loopback bind only (`127.0.0.1`),
refuse any upgrade carrying an `Origin` header (403), a 10 s header timeout. Frame limits
are its own (§3.3). The gateway is unchanged.

Chosen: loopback WS with a per-device Ed25519 key pinned by an admin and the service key
pinned by the device (no native code; same on all OSes; pairing needs the admin console,
like `enroll-device`; the device key is sealed under `safeStorage`). Rejected: sharing the
gateway token (needs read access to the `0700` data dir, grants remote-origin control), a
world-readable token file (every local account could drive the agent), and a pipe/socket
with peer credentials (Windows peer-SID lookup needs a native addon).

### 3.2 Pairing — `src/desktop-bridge/pairing.js`, `src/service/commands/desktop.js`

Flow:

1. In **Settings > Local service** the owner clicks **Pair**. The desktop generates an
   Ed25519 key pair (`crypto.generateKeyPairSync('ed25519')`) and seals the private key
   with `safeStorage` (refused with `SECURE_STORAGE_UNAVAILABLE` when `safeStorage` is
   unavailable or, on Linux, `getSelectedStorageBackend() === 'basic_text'`). It then shows
   a pairing request (§4.1), the device fingerprint and the exact command to run.
2. The owner runs, elevated: `king-louie-service desktop pair <request>`. The CLI
   - exits 1 unless `isAdmin()` (injected; POSIX `geteuid() === 0`; Windows the absolute
     System32 `powershell.exe` evaluating `WindowsPrincipal.IsInRole(Administrator)`), with
     `desktop pair writes <configDir>; run it as root/an administrator.`;
   - exits 1 on `profile: runbook` (`desktopBridge needs profile: agent`);
   - decodes and validates the request (exit 2 on a malformed one);
   - reads the node identity **read-only** from `<dataDir>/chat-data.json`
     (`mesh.identity.publicKey`, as `loadIdentity` does); with none and the service
     stopped it creates one (`getOrGenerateNodeIdentity` via `withServiceCore`, as `pair`
     does); with none and the service running it exits 1
     `No node identity yet. Stop the service once and rerun this command.`;
   - upserts `<configDir>/desktop-devices.json` (§4.2), writes `<configDir>/desktop-bridge.json`
     (§4.3), sets `features.desktopBridge: true` (and `ports.desktopBridge` when absent) in
     `<configDir>/service.json` keeping every other key, atomically and keeping ownership/ACLs;
   - prints both fingerprints, the port, the warning `Every paired desktop sees every chat,
     setting and secret name in this service, and directories and rules it adds apply to its
     own runs only.`, and, if it turned the feature on, `Restart the service to open the desktop bridge.`
3. The desktop reads `desktop-bridge.json` every 3 s for 10 minutes and shows the
   service fingerprint it found. The owner compares both fingerprints with the CLI
   output and clicks **Confirm**. Only then does the desktop try the handshake (§3.3).
   The first successful handshake stores the pin (§4.4).

**Finding the file.** The desktop reads `<configDir>/desktop-bridge.json` with
`<configDir> = adminConfigDir({ dataDir: defaultServiceDataDir() })`. A service installed
with a non-default `--data-dir` is found through `KL_DESKTOP_BRIDGE_FILE` (the owner sets
it for the desktop; the trust check still applies). The desktop re-reads the file's
`port` before every reconnect, so a port change needs no re-pair.

**Trusting the file** (once per poll cycle, before reading it):
- POSIX: the file and its directory are owned by uid 0 and not group- or world-writable.
  With `KL_TEST_MODE=1` and `KL_DESKTOP_BRIDGE_FILE` set, the current uid is also accepted (e2e only).
- Windows (`assertAdminOwned` is a no-op on win32, R51): the owner SID of the file and of
  its directory must be `S-1-5-18` or `S-1-5-32-544`, read through the installers'
  handle-based inspector (`WINDOWS_INSPECT_CSHARP`, `KlFsInspect.Inspect`, now exported from
  `src/service/installers.js`), run once per poll cycle by the absolute System32
  `powershell.exe` with the path passed in an environment variable, never interpolated into
  `-Command`. So that a normal user can read the owner at all, `desktop pair` adds a
  **non-inherited** ACE granting `READ_CONTROL|FILE_READ_ATTRIBUTES` to Authenticated Users
  (`S-1-5-11`) on the file's directory (R56).

If either check fails, the result is `BRIDGE_FILE_UNTRUSTED` (§9). This matters on
Windows, where ordinary users may create folders under `%ProgramData%` before the
service is installed. The fingerprint comparison in step 3 is the second layer.

`desktop unpair <deviceId>` and `desktop list` need admin rights but not a stopped service:
the service re-reads `desktop-devices.json` on every handshake and re-checks live
connections against it every 5 s.

`desktop-bridge.json`: Windows ACL by absolute-path `icacls`
`/inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *S-1-5-19:R *S-1-5-11:R`; POSIX `0644`
root. `desktop-devices.json` (public keys only): POSIX `0640` `root:<service group>`; on
Windows the inherited config-dir DACL is its only protection (`assertAdminOwned` is a no-op on win32).

### 3.3 Handshake and framing — `src/desktop-bridge/protocol.js`

All frames are JSON text frames. Before authentication each frame is at most 4 KiB (length
checked before `JSON.parse`; anything else closes with 4400), the first frame must arrive
within 2 s and the handshake must finish within 10 s. The server proves itself first:

```
S → C  { "t":"challenge", "protocol":1, "nodeId":"kl-…", "serverNonce":"<b64url 32B>" }
C → S  { "t":"clientHello", "protocol":1, "deviceId":"kld-…", "clientNonce":"<b64url 32B>" }
S → C  { "t":"hello", "sig":"<b64url Ed25519 over AUTH_S by the node key>" }
C → S  { "t":"auth", "sig":"<b64url Ed25519 over AUTH_C by the device key>" }
S → C  { "t":"ready", "service": { "version":"26.9.0", "protocol":1, "nodeId":"kl-…", "nodeName":"laptop",
                      "account":"LOCAL SERVICE", "profile":"agent",
                      "providersConfigured":true, "channels":["chat:load", …] } }
```

`AUTH_S` = `kl.desktop.hello.v1\n<nodeId>\n<deviceId>\n<port>\n<serverNonce>\n<clientNonce>`.
`AUTH_C` = `kl.desktop.auth.v1\n<nodeId>\n<deviceId>\n<port>\n<serverNonce>\n<clientNonce>`.
`<port>` is the port the client dialled (decimal). Every field is base32, base64url or
decimal, so the newline-joined ASCII string cannot be ambiguous and no JCS is needed.

The client sends `auth` only after `challenge.nodeId` equals the pinned `nodeId`,
`deriveNodeId(pinnedPublicKey)` equals it too, and `hello.sig` verifies under the pinned
key; otherwise it closes and reports `SERVICE_KEY_CHANGED`. The server looks `deviceId` up
in `desktop-devices.json` (checked with `assertAdminOwned`, controls `{ decides: 'which
desktops may drive this service', selfGrant: 'pair its own desktops' }`; a no-op on win32,
see §3.2) and verifies `sig` with the device key converted by `ed25519RawToSpki` (F3). Close codes:

| Code | Meaning |
|---|---|
| 4400 | malformed or oversized frame before auth, or no first frame within 2 s |
| 4401 | signature invalid |
| 4403 | device unknown or unpaired |
| 4409 | another device is attached (`reason` = its label) |
| 4426 | protocol mismatch (`reason` = `"<server protocol>"`) |
| 4429 | this `deviceId` failed 5 handshakes in 60 s; that device only is refused for 60 s |

There is no global lockout. At most 16 sockets may be unauthenticated at once; when a 17th
arrives, the oldest unauthenticated socket is closed so a new handshake always has a slot.

**Frame sizes after auth.** The `ws` `maxPayload` is 80 MiB. A client frame over 64 MiB is
answered `{ "t":"result", "id", "error":"Payload too large", "code":"PAYLOAD_TOO_LARGE" }`
without closing the socket. The server never sends a frame over 64 MiB: an oversized
`result` is replaced by that error and an oversized `event` is dropped and logged at `warn`.

After `ready`, the following frames are allowed:

| Frame | Direction | Shape |
|---|---|---|
| invoke | C→S | `{ "t":"invoke", "id":17, "channel":"chat:sendMessage", "args":[{…}] }` |
| send | C→S | `{ "t":"send", "channel":"tool:approvalResponse", "args":[{…}] }` |
| call | C→S | `{ "t":"call", "id":18, "method":"bridge.status", "params":{…} }` |
| result | S→C | `{ "t":"result", "id":17, "value":<handler return> }` or `{ "t":"result", "id":17, "error":"…", "code":"…" }` |
| event | S→C | `{ "t":"event", "channel":"chat:messageChunk", "payload":{…} }` |
| bye | S→C | `{ "t":"bye", "code":"SERVICE_STOPPING" }` then close 1001 |

`value` is the service-side handler's return value, passed through verbatim. It is
already in `wrapHandler`'s `{ ok, data }` / `{ ok:false, error }` shape, so the renderer
cannot tell attached from standalone. `args` mirrors `ipcRenderer.invoke(channel, ...args)`.

**One live connection.** A new connection from the device already attached replaces the
old one: the old socket is closed with 1000 and handled as a disconnect (below). A
connection from a different device is refused with 4409.

**Disconnect while the service stays up.** The dispatcher tracks the `chatId`s whose runs
were started on each connection. When the connection closes it aborts each of them
through the registered `chat:stopResponse` handler (which aborts `activeRuns`), answers
every outstanding prompt as a denial at once, and ends the runs' replies with
`The desktop disconnected; the run was stopped.` Nothing started from a desktop keeps
running unattended.

### 3.4 Service side — `src/desktop-bridge/bridge-server.js`, `bridge-dispatcher.js`

`class DesktopBridgeServer { constructor({ core, identity, cipher, configDir, port, host = '127.0.0.1', version, geteuid, adminUid = 0 }); start() → Promise<{ port }>; stop() → Promise<void>; forwardAmbient(channel, payload); get connected() → { deviceId, label } | null }`.

`createBridgeDispatcher({ core, cipher, getConnection })` builds a **virtual ipcMain**
(`{ handle(ch, fn), on(ch, fn), removeHandler(ch) }`) and calls
`registerHandlers(virtualIpcMain, bridgeContext)` from `src/ipc/register.js` once. That
registers exactly the handler code the desktop runs, and it picks up handler modules
that C2 and C4 add. `bridgeContext` is:

```js
{ ...core.context,
  getSettings: desktopScopedGetSettings, setSettings: desktopScopedSetSettings,   // desktop-scoped, below
  removePermissionRule: desktopOnlyRemovePermissionRule,
  safeStorage: { isEncryptionAvailable: () => cipher.isEncryptionAvailable() },
  getMainWindow: () => null, getShell: () => null,
  pendingAskUserResolvers, pendingDirectoryAccessResolvers,   // bridge-owned Maps
  prompter: createElectronPrompter({ getWindow: connectionAsWindow,
                                     pendingAskUserResolvers, pendingDirectoryAccessResolvers }) }
```

- `cipher` is the service's `cipher` port, so `settings:load` reports
  `encryptionAvailable` truthfully.
- **Desktop-scoped widening (§8).** Directories allowed from the desktop (the settings
  channel, `bridge.addAllowedDirectory`, "always allow" in `tool:directoryAccessResponse`,
  import) go to `<dataDir>/desktop/allowed-directories.json`. `desktopScopedGetSettings`
  appends them to `allowedDirectories` and `desktopScopedSetSettings` diverts writes there;
  both exist only in `bridgeContext`, so only marked runs see them. Rules added over the
  bridge are recorded in `<dataDir>/desktop/rules.json`, and `desktopOnlyRemovePermissionRule`
  refuses any other (`RULE_NOT_DESKTOP`), so the desktop cannot lift a `deny` rule.
- `connectionAsWindow()` returns `{ isDestroyed: () => !live, webContents: { send } }` for
  the live connection, or `null` (`createElectronPrompter` is already Electron-free). Only
  the dispatcher's `chat-handlers.js` registration uses this `prompter`, so ask-user and
  directory prompts reach the desktop only from desktop-started runs; the core's own
  prompter (gateway, cron, channels) stays headless.

For each `invoke`/`send`, the dispatcher does the following:
1. It refuses channels not in the served set: `ALLOWED ∩ registered`, see §3.6. It
   answers `{ error, code: 'CHANNEL_NOT_PROXIED' }` and never calls the handler.
2. It builds a fresh event: `{ sender: { send: (ch, p) => pushEvent(ch, p), isDestroyed: () => !live } }`,
   marks it with `markLocalDesktopEvent(event, { deviceId })` (§3.5), and calls the
   registered function with `(event, ...args)`. Channels classified `prestep` are not in
   the served set (the desktop runs their dialog and calls a bridge method instead).
3. `pushEvent` forwards only channels in `RENDERER_EVENTS` (§3.6) over that same
   connection.

Ambient core events, meaning the service core's `ui.send` (`chat:updated`,
`workflow:*`, `task:*`, `backgroundTask:completed`), are forwarded to the live connection
when their channel is in `RENDERER_EVENTS` **and not** in `PROMPT_EVENTS`. The service
host passes `ui: { send: (ch, p) => bridgeServer?.forwardAmbient(ch, p), reportError }`
into `createCore` only when `features.desktopBridge` is on. Otherwise `ui` keeps the
default no-ops.

Bridge-native `call` methods:

| Method | Params | Returns |
|---|---|---|
| `bridge.status` | — | `ready.service`, refreshed |
| `bridge.checkPath` | `{ path }` | `{ ok: true, readable, writable }`, tested as the service account by doing, not by `fs.access` (which ignores Windows ACLs): `fs.promises.opendir` (directory) or `open(path, 'r')` (file) for read; creating and removing `<dir>/.kl-write-probe-<rand>` for write |
| `bridge.setWorkingDirectory` | `{ chatId, path }` | runs `checkPath`; on success delegates to the registered `chat:setWorkingDirectory` handler; else `PATH_NOT_ACCESSIBLE` |
| `bridge.addAllowedDirectory` | `{ path }` | `checkPath`, then appends to the desktop-scoped list (above); returns `{ ok: true, allowedDirectories }` |
| `bridge.canvasJsResult` | `{ requestId, result?, error? }` | resolves `core.pendingCanvasJsResolvers` (the code moved out of `main.js`) |
| `bridge.approvalsStatus` | — | §3.9 "Approvals and relay"; `{ available: false }` until F3 has merged |
| `import.plan` / `import.apply` / `import.finish` | §3.8 | §3.8 |

**Service wiring.** `src/service/run.js` (last in the F3 → F4 → F5 → F7 order), `agent`
profile only: after `core.start()`, if `features.desktopBridge`, load the node identity with
`getOrGenerateNodeIdentity(store, cipher, nodeConfig.name)` and start `DesktopBridgeServer`
on `ports.desktopBridge`, passing F3's `startApprovals` result when present. A failed bind
is fatal (parent §4.3 I4). On shutdown it sends `bye SERVICE_STOPPING` and stops before
`core.shutdown()`. `profile: runbook` refuses the feature: `desktopBridge needs profile: agent`.
With the feature on, `createCore` gets C2's host hooks (R50): `host.interactive = () =>
bridgeServer?.connected != null` (read at each use) and `host.presence` proxied to the
connected desktop's `presence:heartbeat` ("away" with none). C4's `contact`, `contactPolicy`
and `presence` domains are proxied by default (C4 adds them to `PROXIED_DOMAINS`).

### 3.5 Local-origin approvals — `src/core/origin.js`

```js
markLocalDesktopEvent(event, { deviceId = null } = {}) → event   // WeakMap set; only the bridge dispatcher and the Electron hosts call it
isLocalDesktopEvent(event) → boolean
localDesktopDeviceId(event) → string | null                      // the kld- id for bridge events, null for the Electron host
markLocalRequester(fn, { deviceId = null } = {}) → fn             // WeakMap set; called only by ToolExecutor with localOrigin (F3)
isLocalRequester(fn) → boolean
```

The standalone host marks its events by wrapping `ipcMain.handle`/`ipcMain.on` before
`registerHandlers` runs, so every handler receives a marked event; a test asserts that the
wrapper and the dispatcher are the only callers of `markLocalDesktopEvent`.

Today the Electron host's on-screen approval path is `event.sender`:
`createToolExecutorWithApprovals` attaches the `approvalRequired` listener only when
`event?.sender` exists. In the service, only the bridge dispatcher makes events with a
`sender`. The gateway, cron, channels, webhooks, mesh and child agents pass
`event = null` and an `approvalRequester`. So the route is structural: a remote-origin
run has no `sender` to borrow, and the dispatcher never attaches a requester.

The seam in `createToolExecutorWithApprovals` (program §4.21), one rule for every
`remoteApprovals` mode, including C2's pass-through:

```js
const local = isLocalDesktopEvent(event) || isLocalRequester(approvalRequester);
denyAutoApproval: (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true
// 'phone' && !local → F3's phone requester; local → null (dialog) or the marked parent requester
```

Without it, the service's `remoteApprovals` would ignore the owner's always-approve list
and `allow` rules inside desktop runs, so every gated call would prompt. A `WeakMap` mark
cannot be forged from a payload, because it keys on the event object the dispatcher built.
With `remoteApprovals: 'allow'` (the Electron host) it changes nothing. F7 writes the
`local`/`denyAutoApproval` lines; the phone branch is **F3-owned** (F3 §3.7): marked events
never get the phone requester and keep the default `approvalTimeoutMs`; `classifyCall`
still applies to them (`denied` refuses, `unsafe` forces the gate, which is the dialog);
F3's audit listeners attach with `origin: { client: 'desktop', deviceId: localDesktopDeviceId(event) }`;
F3's `core-remote-approvals.test.js` pins it. Whichever of F3 and F7 merges second rebases
onto the other. Before F3 merges there is no audit ledger: desktop runs in the service are
logged through `createLogger('desktop-bridge')` only.

Prompt bookkeeping in the dispatcher:
- It records the ids it forwards: `approvalId` of `tool:approvalRequired`, and
  `requestId` of `agent:askUser` and `tool:directoryAccessRequired`.
- An inbound `tool:approvalResponse`, `tool:directoryAccessResponse` or
  `agent:userResponse` whose id was not issued to **this** connection is dropped and
  logged at `warn`.
- On disconnect, each outstanding id is answered as a denial at once (`approved: false`, or
  `{ ok: false, error: 'The desktop disconnected.' }` for ask-user), and the runs stop (§3.3).

**Sub-agents.** Child agents are built with `event = null` and the parent's re-threaded
requester (`agentExecutorAdapter.execute`, `create-core.js:2296`). F3 decided children
inherit the mark (R49): a local run's `ToolExecutor` (`localOrigin: true`) marks the requester
closure it hands to tools with `markLocalRequester`, and a child whose requester is marked
is local, so its prompts go through the parent to the on-screen dialog. Workflows, tasks
and background agents are not proxied in attached mode (§2.2).

### 3.6 Channel allowlist — `src/desktop-bridge/allowlist.js`

Rules are evaluated in order, and the first match wins:

| Rule | Channels | Attached-mode route |
|---|---|---|
| local | `desktop:*`, `app:quitWindow`, `wizard:*` | main process (`wizard:getStatus` → `{ ok: true, isFirstRun: false }`; `wizard:complete` → `{ ok: true }`) |
| local pre-step | `chat:pickWorkingDirectory`, `settings:addAllowedDirectory` | native dialog in main, then `bridge.setWorkingDirectory` / `bridge.addAllowedDirectory`; results reshaped to the standalone handlers' return shapes |
| deny | `chat:speakLast`, `settings:testVoice`, `settings:mcp*`, `settings:anthropicOAuth*` | not available |
| proxy | domains `chat`, `settings`, `case`, `cron`, `memory`, `tool`, `usage`, `checkpoint`, `canvas`; channel `agent:userResponse` | bridge |
| deny (default) | everything else: `hooks`, `skill`, `webhook`, `mesh`, `channel`, `gateway`, `sessions`, `workflow`, `task`, `agent`, `apps`, `diagnostics` | not available |

`tool`, `usage`, `checkpoint`, `canvas` and `agent:userResponse` are in the proxy list
because a chat does not work without them: approval responses, the tool list,
permission rules, the token footer, turn undo, and canvas output. New domains are
appended to `PROXIED_DOMAINS` by one line in the stage that adds them. `case:*` channels
that C2 adds are proxied with no edit.

`RENDERER_EVENTS`: `chat:messageStart`, `chat:messageChunk`, `chat:messageComplete`,
`chat:messageError`, `chat:toolUse`, `chat:toolResult`, `chat:toolProgress`,
`chat:updated`, `chat:advisorStarted`, `chat:advisorCompleted`, `canvas:render`,
`canvas:close`, `canvas:executeJs`, `tool:approvalRequired`,
`tool:directoryAccessRequired`, `agent:askUser`, `backgroundTask:completed`, plus any
`case:*` event. `PROMPT_EVENTS` is the three prompt channels among them.

`SERVED = (listIpcChannels() ∩ ALLOWED) − prestep`, computed by the service and sent in
`ready.service.channels`. The desktop proxies `SERVED` ∩ its own allowlist. A channel the
desktop allows but the service does not serve (an older service) returns
`SERVICE_TOO_OLD`.

### 3.7 Desktop side — `main.js`, `src/ipc/*-host.js`, `src/desktop-bridge/bridge-client.js`

`main.js` after this stage is wiring only (about 90 lines):
1. `protocol.registerSchemesAsPrivileged` for `kl-screenshot`, as today.
2. `const state = openDesktopState(app.getPath('userData'), safeStorage)` from
   `src/ipc/desktop-state.js` (electron-store `desktop-bridge`, §4.4).
3. `const attached = state.mode === 'attached' && !process.argv.includes('--kl-standalone-once')`.
4. `host = attached ? startAttachedHost(deps) : startStandaloneHost(deps)`. `deps` =
   `{ app, ipcMain, safeStorage, shell, dialog, Notification, getWindow, state, appDir: __dirname }`.
5. `createWindow()`, the `kl-screenshot` handler, `host.start()`, `window-all-closed` →
   `host.shutdown()`. The `KL_TEST_BRIDGE_PORT` hook and `tests/e2e/_bridge.js` are deleted.

`Store` construction, `createSafeStorageCipher`, `createElectronPrompter`, `createCore`,
`registerHandlers`, the `canvas:executeJsResult` listener, `core.start()`, the `mesh:ready`
send and `core.shutdown()` move unchanged to `src/ipc/standalone-host.js`
`startStandaloneHost(deps) → { start, shutdown }`; `src/ipc/attached-host.js`
`startAttachedHost(deps) → { start, shutdown }` is new. `startStandaloneHost` passes `desktopBridge: createDesktopController({ state, mode: 'standalone' })`
into the `registerHandlers` context, so `desktop:*` works in both modes. `registerDesktopHandlers`
always registers its channels (no duplicate `handle` in any host) and answers
`{ ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' }` when the context
has no `desktopBridge` (the service dispatcher, the contract test).
Under `--kl-standalone-once` the standalone host starts with channels, gateway and mesh off
and cron paused, so the service stays the only instance that acts.

`startAttachedHost`:
- builds `client = new DesktopBridgeClient({ port, pin, deviceId, sign })` from
  `state.pairing`, where `sign` unseals the device key with `safeStorage` for each
  signature and does not keep it;
- gets `{ handle, on } = listIpcChannels()` (`src/ipc/channel-inventory.js`: `registerHandlers`
  against a recording ipcMain with an inert `Proxy` context, as `tests/ipc-contract.test.js` does)
  and registers one `ipcMain.handle`/`on` per channel plus `canvas:executeJsResult`
  (→ `bridge.canvasJsResult`), routed by §3.6;
- forwards `event` frames in `RENDERER_EVENTS` to `mainWindow.webContents.send`;
- tracks open runs by `chatId`, from `chat:messageStart` until complete or error. When
  the connection drops it sends each open run a synthetic
  `chat:messageError { chatId, responseId, error: 'The local service restarted; the reply was lost.' }`;
- builds no core and opens no listener. Ports 18789/18790/18791 stay free.

`class DesktopBridgeClient extends EventEmitter` (Electron-free):
- `constructor({ host = '127.0.0.1', port, pin: { nodeId, publicKey }, deviceId, sign })`;
- `connect() → Promise<service>`, `invoke(channel, args, { timeoutMs }) → Promise<value>`,
  `send(channel, args)`, `call(method, params, { timeoutMs })`, `close()`;
- events: `'event' (channel, payload)`, `'state' (status)`.

It reconnects with backoff 1, 2, 4, 8, 16, 30 s (capped, ±20 % jitter). The `ws` client
gets no `agent`, so `HTTP_PROXY` is ignored, and it connects to the literal `127.0.0.1`.
Timeouts: none for `chat:sendMessage`, `tool:execute`, `cron:run` and C7's
`case:ingest*`, which are bounded by the connection. Everything else times out at 120 s
with `BRIDGE_TIMEOUT`. Every error result carries `error` text as well as `code`.

**Mode switches relaunch.** `desktop:attach`, `desktop:detach` and
`desktop:standaloneOnce` persist the mode and call `app.relaunch(); app.exit(0)`. The
standalone-once variant passes `--kl-standalone-once`. When `KL_TEST_MODE=1`, main
writes `KL_RELAUNCH_REQUESTED\n` to stdout and quits instead, and the harness
relaunches. Handlers are never swapped at runtime, so a live core is never torn down
under open IPC calls. Detach first shows `After detaching, this app runs its own King
Louie again next to the service; its cron jobs and channels may act twice. Stop the service
if you no longer want it.` and needs a second click.

### 3.8 Import — `src/migration/desktop-import.js`, `src/ipc/desktop-export.js`, `src/service/commands/import.js`

One engine, two sources:

- **Desktop over the bridge** (primary). `src/ipc/desktop-export.js` reads the desktop's
  own stores as plain JSON with `fs` (`chat-data.json`, `config.json`,
  `memory/memory-store.json`, `cron/jobs.json`; not through electron-store, which would
  write defaults). It decrypts secrets with `createSafeStorageCipher(safeStorage)` in memory
  and sends them over the authenticated bridge. No plaintext touches disk. It works in
  standalone mode while paired (the client connects only for the import) and in attached mode.
- **CLI**: `king-louie-service import --from <userData> [--data-dir <d>] [--dry-run]`,
  run as root/Administrator with the service **stopped**. It gives the same refusal as
  `token set` while the service runs, and the same chown-back on POSIX. Every secret item
  is reported `needs-desktop`, because `safeStorage` ciphertext opens only in that user's
  desktop session. **The source tree is user-controlled, so the walker (R51)** uses `lstat`
  at every level, refuses symlinks and junctions (top-level store files included), refuses
  regular files with `nlink > 1` or an owner other than the owner of `<userData>`, and opens
  with `O_NOFOLLOW` where the platform has it. On POSIX it may instead read with privileges
  dropped to the `<userData>` owner (a child spawned with that `{ uid, gid }`). A refused
  file is reported `needs-attention` with the reason; nothing it points at is read.

Protocol (`call` methods):
1. `import.plan { installId, inventory }` → `{ planId, items: [PlanItem], counts }`. The
   inventory carries ids, keys and timestamps only, never secret values (§4.5). The
   service computes each item's action against its own data. **This is the dry run.**
2. `import.apply { planId, batch: [{ category, key, value }] }`, repeated. A batch is at
   most 2 MiB serialized. The desktop sends only items whose action is `new` or `copy`.
   Returns `{ results: [{ category, key, ok, error? }] }`.
3. `import.finish { planId }` writes the manifest (§4.6) and returns the report;
   `desktop:importApply` calls it after the last batch.

A plan expires 30 minutes after `import.plan` or on disconnect. A later `apply` answers
`PLAN_EXPIRED`, and the desktop re-plans.

**Reruns** (every id-keyed category) use the manifest entry for the item, if any:
source unchanged since the entry's `sourceUpdatedAt` → `skip-present`; source changed and
the service copy unchanged since `targetUpdatedAt` → `update` (in place, at `targetKey`);
both changed → `copy` once, after which the manifest points at the copy and later reruns
follow the same rule. With no manifest entry the "Present when" column below decides.

What moves, and the rule for each:

| Category | Source | Target write | Present when | Rule |
|---|---|---|---|---|
| `chat` | `chats[]` | `setChats` | same `id` | same `id` and same `updatedAt` → `skip-present`. Same `id`, different `updatedAt` → `copy`: new id, title + ` (from desktop)`, mapping in the manifest. A `workingDirectory` the service cannot read (`checkPath`) is dropped and the item reported `needs-attention` |
| `settings` | `settings` | merged by `setSettings` | service value differs from `DEFAULT_SETTINGS` | keys `defaults`, `checkpoints`, `activeProvider`, `templateVariables`, `providerModels`, `inference`, `notifications`, `voice`, `cases` (minus `root`, including C2's `cases.*`). Only keys still at their default on the service are filled |
| `allowedDirectory` | `settings.allowedDirectories[]` | the desktop-scoped list (§3.4) | already listed | `needs-attention` when the service's `checkPath` fails |
| `userProfile` | `userProfile` | `updateUserProfile` | service profile non-default | fill only |
| `permissionRule` | `toolApprovals.permissionRules[]` | `addPermissionRule` | identical `{ tool, pattern, action }` | — |
| `alwaysApprove` | `toolApprovals.alwaysApproveTools` | `setToolAlwaysApprove` | already set | applies only to desktop runs (§3.5) |
| `providerToken` 🔒 | `apiTokens[<provider>]` for `providerLabels` keys, and `__elevenlabs_api_key` | encrypted with the service `cipher` into `apiTokens` | service already has a token for it | — |
| `searchKey` / `imageKey` 🔒 | `settings.webSearch.*.apiKey`, `settings.imageGeneration.fal.apiKey` | re-encrypted into settings | non-empty on the service | — |
| `vault` 🔒 | `__vault_*` in `config` | `core.context.vault.set` | key exists | read back and compared after write |
| `anthropicOAuth` 🔒 | `anthropicOAuth`, `anthropicOAuthClientId` | re-encrypted | service connected | — |
| `memory` | `memory-store.json` entries | `MemoryManager.importEntry(entry)` (new: keeps `id` and timestamps, no re-embed) | same `id` | — |
| `cron` | `cron/jobs.json` | `core.context.getCronScheduler().addJob({ ...job, enabled: false })` | same `id` | imported **disabled**; the report says so |
| `case` | `<userData>/cases/<dir>/**` when `settings.cases.root` is empty | the service cases root (`KL_CASES_ROOT` honoured) | same case dir | streamed as `{ dir, relPath, b64, mode }` into `<root>/.import-<planId>/<dir>`, renamed into place by `import.finish`. `dir` and every `relPath` must resolve inside the target root; `..`, absolute, drive-letter, NUL and symlinks are rejected; the case lock `.kl/lock` (`case-runtime.js`) and git's `*.lock` files are skipped. Same dir with different content → `needs-attention` |

🔒 = secret. Values travel only in `import.apply` and never appear in plans, reports,
logs or the manifest.

**Stays behind** (`skip-excluded` with the reason): the desktop mesh identity and peers;
the gateway token and `apiStatus`; embedding cache and context vectors (rebuilt);
`tool-results/`, `background-tasks/`, `checkpoints/`, `voice/`; skills, pins,
customizations, workflows, the webhook registry; `settings.hooks`, `settings.mcpServers`,
`settings.channels` and bot tokens (they spawn processes or listeners for remote-origin
work, or a bot must not answer from two hosts; the admin sets them with the service CLI).
Cases under a custom `cases.root` are `needs-attention` with the path.

**Nothing on the desktop is modified or deleted**; the standalone stores are the fallback
for detach. Failures are per item and retried by a rerun. Order: settings, profile, rules,
chats, memory, cron, cases, secrets last; the report lists every secret that did not
arrive. After import and **Attach** the desktop runs no core, cron, channels, gateway or
mesh: the service is the only King Louie that acts.

### 3.9 Settings pane — `renderer.js` `renderServiceSection()`, `index.html`, `styles.css`

It is a new settings tab: `<option value="service">Local service</option>` and
`.settings-tab-content[data-tab="service"]`, attached by `switchSettingsTab('service')`
→ `renderServiceSection()`.

| State (`desktop:status`) | Shows | Actions |
|---|---|---|
| no bridge file, unpaired | "No local service found" and one line on installing it | Pair (still allowed; it waits for the file) |
| pairing | request string (copy button), command, device fingerprint, service fingerprint once found | Confirm, Cancel |
| paired, standalone | service fingerprint, version, account, "Tools will run as `<account>`" | Import… (dry run → report → Import), Attach, Unpair |
| attached, connected | the same, plus `The service has no provider key yet — import or add one in Providers.` when `providersConfigured` is false | Import…, Detach (with the §3.7 warning), Unpair |
| attached, not connected | error from §9, next retry time | Retry now, Use standalone this time, Detach |

**Approvals and relay** (read-only, attached and connected; F3's handoff), from
`bridge.approvalsStatus`, which reads F3's `startApprovals` objects:

```jsonc
{ "available": true,
  "relay": { "configured": true, "connected": true, "since": "…", "relay_id": "kl-…" },   // link.json
  "devices": [{ "device_id": "d-…", "name": "Pixel 9", "platform": "android", "active": true }],   // approverStore.list()
  "pending": [{ "request_id": "…", "summary": "…", "expires_at": "…" }],                         // phoneApprover.pending()
  "audit": { "last_seq": 1234, "last_at": "…" } }                                            // auditLedger.tail(1)
```

It names the console commands for changes (`enroll-device`, `device revoke`). Before F3
merges, or without approvals, it reads `Phone approvals are not set up on this service.`

`markUnavailableTabs(status.unavailableTabs)` adds one notice line ("Managed by the local
service; not available while attached.") to each unserved settings tab without touching other
stages' sections. `desktop:statusChanged` re-renders the pane and, on reconnect, reloads chats.

## 4. Data formats

### 4.1 Pairing request string

`klpair1.<deviceId>.<b64url raw Ed25519 public key (32 B)>.<b64url UTF-8 label ≤ 64 B>`

| Field | Rule |
|---|---|
| `deviceId` | `deriveDeviceId(raw, 'kld-')` (F3 `envelope.js`): `kld-` + lowercase `base32(sha256(raw 32-byte key))[0..16]`; vector `device-id-ed25519` in F3's `approval-v1` |
| public key | b64url of the raw 32-byte Ed25519 key; converted with `ed25519RawToSpki` (F3) for `crypto.verify` |
| label | default `<os user>'s desktop`; control characters rejected |

Device fingerprint shown to the owner: the `deviceId`, in groups of 4.

### 4.2 `<configDir>/desktop-devices.json` (admin-written, service-read)

```json
{ "v": 1,
  "devices": [ { "deviceId": "kld-3f7q2m9x4a1b6c8d", "publicKey": "q1w2…", "label": "alice's desktop",
                 "pairedAt": "2026-09-23T14:02:11Z" } ] }
```

| Field | Type | Rule |
|---|---|---|
| `v` | int | `1`; anything else → the service refuses every handshake and logs an error |
| `devices[].deviceId` | string | unique; must match `publicKey` |
| `devices[].publicKey` | b64url | raw 32 bytes |
| `devices[].label` | string | ≤ 64 bytes |
| `devices[].pairedAt` | RFC 3339 | — |

### 4.3 `<configDir>/desktop-bridge.json` (admin-written, readable by every local account)

```json
{ "v": 1, "nodeId": "kl-abcd2345efgh6789", "publicKey": "302a300506032b6570032100…", "host": "127.0.0.1", "port": 18796, "protocol": 1 }
```

`publicKey` is the node key as DER SPKI hex (program §4.17, `NodeIdentity.publicKey`);
`nodeId` must equal `deriveNodeId(publicKey)`. `host` is always `127.0.0.1`. `port`
mirrors `service.json` `ports.desktopBridge`. There are no secrets in this file.

### 4.4 Desktop `<userData>/desktop-bridge.json` (electron-store `desktop-bridge`)

```json
{ "mode": "standalone",
  "installId": "7c0e…uuid",
  "pairing": { "deviceId": "kld-…", "publicKey": "…", "privateKeySealed": "<safeStorage b64>",
               "label": "alice's desktop",
               "service": { "nodeId": "kl-…", "publicKey": "…", "port": 18796, "pairedAt": "…" } },
  "pendingPair": null,
  "lastImport": { "at": "…", "counts": { "new": 41, "skip-present": 3, "failed": 0 } } }
```

`mode` ∈ `standalone | attached`, default `standalone`. `pairing.service` is written
only after the first successful handshake after Confirm, and Attach is disabled until
then. If `safeStorage` is unavailable, Pair is refused with `SECURE_STORAGE_UNAVAILABLE`.

### 4.5 Import inventory and plan item

```jsonc
// inventory (import.plan params)
{ "installId": "…", "sourceVersion": "26.9.0",
  "chats": [{ "id": "c1", "updatedAt": "…", "title": "…" }],
  "settingsKeys": ["inference", "voice"], "userProfile": true,
  "permissionRules": [{ "tool": "Bash", "pattern": "git *", "action": "allow" }],
  "alwaysApprove": ["Read"], "providerTokens": ["anthropic"], "searchKeys": ["brave"],
  "imageKeys": [], "vault": ["github"], "anthropicOAuth": false,
  "memory": ["m-1"], "cron": [{ "id": "cron_1", "name": "daily" }],
  "cases": [{ "dir": "lakeside-lot", "files": 212, "bytes": 1830400 }],
  "allowedDirectories": ["D:\\projects"], "excluded": ["mesh.identity", "settings.hooks"] }
// PlanItem
{ "category": "chat", "key": "c1",
  "action": "new" | "update" | "copy" | "skip-present" | "skip-excluded" | "needs-attention" | "needs-desktop",
  "note": "…", "targetKey": "c1" }
```

### 4.6 Service `<dataDir>/imports/desktop-<installId>.json`

```json
{ "v": 1, "installId": "…", "runs": [{ "planId": "…", "at": "…", "source": "bridge" }],
  "items": { "chat:c1": { "at": "…", "result": "ok", "sourceUpdatedAt": "…", "targetKey": "c1-9f2a", "targetUpdatedAt": "…" } } }
```

It holds no secret values. For the CLI, `installId` comes from
`<from>/desktop-bridge.json` when present, otherwise `sha256(realpath(from))[0..16]`.

## 5. Interfaces

### 5.1 Consumed

| From | Interface |
|---|---|
| F1 (merged) | `createCore(deps)`; the `context.*` members named in §3.4/§3.8 (`getSettings`, `setSettings`, `removePermissionRule`, `getCronScheduler`); `core.pendingCanvasJsResolvers`; the `ui` port; `JsonFileStore`; `withServiceCore`; `assertAdminOwned(file, geteuid, adminUid, controls)` (no-op on win32); `loadServiceConfig`; `adminConfigDir`, `defaultServiceDataDir`; `createElectronPrompter`; `WINDOWS_INSPECT_CSHARP` (`installers.js`, exported by F7); `ProviderFactory.registerProvider` (e2e stub provider) |
| F2 (merged) | `getOrGenerateNodeIdentity`, `deriveNodeId`, `NodeIdentity.sign` (Ed25519), node key as DER SPKI hex; the `<configDir>` ownership rules |
| C1 (merged) | `case:*` handlers (proxied as they are) |
| C2 (wave 1) | new `case:*` channels and events are proxied by domain with no edit; C2's `cases.*` settings are imported by the `settings` rule; `host.interactive` is `() => boolean` and `host.presence` is a port (R50) |
| C4 (wave 2) | adds `contact`, `contactPolicy`, `presence` to `PROXIED_DOMAINS`; its §6 attached-mode note (the service's contact policy is edited from the desktop) |
| F3 (wave 1), F3-owned | the phone branch of §3.5 and its test (F3 §3.7, §5.2 P22); `deriveDeviceId`, `ed25519RawToSpki` (P2); `startApprovals` objects for `bridge.approvalsStatus` (P9, P20); audit origin `{ client: 'desktop', deviceId }` (P20). Stubbed until F3 merges: no phone branch, `approvalsStatus` → `{ available: false }`, local copies of the two key helpers replaced on rebase |

### 5.2 Produced

| Name | Signature | Consumers |
|---|---|---|
| `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event) → boolean`, `localDesktopDeviceId(event) → string \| null`, `markLocalRequester(fn, { deviceId })`, `isLocalRequester(fn) → boolean` | `src/core/origin.js` | F3 (phone branch skipped, children inherit, audit origin), F5 |
| `bridge.approvalsStatus` → §3.9 shape | bridge `call` method | the pane |
| `WINDOWS_INSPECT_CSHARP` export | `src/service/installers.js` | F7's bridge-file check; F5 may reuse |
| `PROXIED_DOMAINS`, `RENDERER_EVENTS`, `PROMPT_EVENTS`, `classifyChannel(ch) → 'local' \| 'prestep' \| 'proxy' \| 'deny'` | `src/desktop-bridge/allowlist.js` | C2, C4, C7 add one line per new proxied domain or event |
| `listIpcChannels() → { handle: string[], on: string[] }` | `src/ipc/channel-inventory.js` | attached host, bridge dispatcher, tests |
| `DesktopBridgeServer`, `DesktopBridgeClient`, protocol constants (`PROTOCOL = 1`, `DEFAULT_DESKTOP_BRIDGE_PORT = 18796`) | `src/desktop-bridge/*` | F5 may reuse the handshake pattern |
| IPC `desktop:status`, `desktop:pairStart`, `desktop:pairConfirm`, `desktop:pairCancel`, `desktop:attach`, `desktop:detach`, `desktop:standaloneOnce`, `desktop:unpair`, `desktop:importPlan`, `desktop:importApply`; events `desktop:statusChanged`, `desktop:importProgress` | `src/ipc/desktop-handlers.js`, preload `window.electron.desktop` | renderer |
| `MemoryManager.importEntry(entry) → { imported: boolean }` | `src/memory/memory-manager.js` | import |
| CLI `desktop pair <request>`, `desktop unpair <deviceId>`, `desktop list`, `import --from <dir> [--dry-run]` | `src/service/commands/{desktop,import}.js` | F6 install guide |
| e2e `launchApp(opts)`, `launchAttached(opts)`, `closeApp(ctx)` and the existing helpers | `tests/e2e/helpers.js` | every e2e test |

## 6. Configuration

| Key | File | Default | Notes |
|---|---|---|---|
| `features.desktopBridge` | `<configDir>/service.json` only (admin-only key, like every `features.*`) | `false` | ignored with a warning in `<dataDir>/service.json`; refused on `profile: runbook` |
| `ports.desktopBridge` | `<configDir>/service.json` only | `18796` | added to `DEFAULT_PORTS` in `src/service/config.js`; clear of 18789–18795 (amended from 18795, which is fleet stage 3's relay mesh port) |
| `desktop-devices.json`, `desktop-bridge.json` | `<configDir>` | absent | §4.2, §4.3 |
| `mode`, `pairing` | desktop `<userData>/desktop-bridge.json` | `standalone`, `null` | never read by the service |
| `KL_DESKTOP_BRIDGE_FILE` | env, desktop | unset | path of `desktop-bridge.json` for a service with a non-default data dir; the file must still pass the trust check, which accepts the current uid as owner **only** with `KL_TEST_MODE=1` (e2e) |
| `--kl-standalone-once` | desktop argv | absent | one session in standalone without changing `mode` |

No key is added to `src/core/settings.js`. The attach decision must be made before any
core exists, so it lives in the desktop's own store.

## 7. Host wiring

- `src/core/create-core.js` (program §5 exception shared with F3): one `require('./origin')`, the `local` and `denyAutoApproval` lines of §3.5; the phone branch and `localOrigin` are F3's. No new context getter.
- `src/service/installers.js`: export `WINDOWS_INSPECT_CSHARP` (one line; F5 adds its own exports).
- `src/memory/memory-manager.js`: `importEntry(entry) → { imported }` (keeps `id` and timestamps, no re-embed).
- `tests/e2e/helpers.js`: owned and rewritten by F7 (§10); other stages add tests, not harness changes.
- `src/ipc/constants.js`: the `DESKTOP_*` constants in §5.2.
- `src/ipc/register.js`: one line, `registerDesktopHandlers(ipcMain, context)`; it always registers and answers `ATTACHED_UNAVAILABLE` when `context.desktopBridge` is absent (§3.7).
- `preload.js`: one namespace, `desktop: { status, pairStart, pairConfirm, pairCancel, attach, detach, standaloneOnce, unpair, importPlan, importApply, onStatusChanged, onImportProgress }`.
- `renderer.js`: `renderServiceSection()` and `markUnavailableTabs()`, attached from `switchSettingsTab`; one `desktop.onStatusChanged` subscription at init. F7 rebases last and leaves the other stages' sections untouched.
- `index.html`: one `<option value="service">` and one `.settings-tab-content[data-tab="service"]` pane. `styles.css`: one `.service-pane` block.
- `main.js`: rewritten to §3.7. `src/ipc/standalone-host.js`, `attached-host.js`, `desktop-state.js`, `desktop-export.js`, `desktop-handlers.js` and `channel-inventory.js` are new.
- `src/service/cli.js`: two dispatch lines, `desktop` and `import`, to `src/service/commands/desktop.js` and `import.js`.
- `src/service/run.js` (last of F3 → F4 → F5 → F7): one block after `core.start()` (§3.4), plus the `ui` and `host.interactive`/`host.presence` deps when the feature is on, and an `adminUid` parameter threaded to `loadServiceConfig` for tests only (never from argv or config).
- `src/service/config.js`: `desktopBridge` in `DEFAULT_FEATURES` (`false`) and `DEFAULT_PORTS` (`18796`). F7 adds **no** `node.yaml` key: its settings are `service.json` `features`/`ports` (§6), so the `desktopBridge` entry program §5 lists under `NODE_YAML_KEYS` is not needed (flagged for the program).
- `CLAUDE.md`: a short "Attached mode" section with the pairing command and the new e2e helpers, replacing the harness paragraph that ruling 9 corrects.

## 8. Security and trust

| New capability for an attacker | What stops it |
|---|---|
| Another local account drives the service through the bridge | It needs a device key in `desktop-devices.json`, which only an admin writes; the device key is sealed by `safeStorage` under the pairing user's OS credentials |
| A prompt injection in the service pairs its own desktop | `desktop-devices.json` is in `<configDir>`, which the service account cannot write, and it is checked with `assertAdminOwned` on every handshake |
| Port squatter impersonates the service (it is down, or before install) | Mutual auth: the server must sign `AUTH_S` with the pinned node key before the client sends any `invoke`, `call` or secret. The pin comes from a root/Administrators-owned file and is confirmed by fingerprint against the admin's CLI output |
| Remote-origin run borrows the on-screen dialog | The dialog is reachable only through a dispatcher-built `event.sender`, and only the bridge makes one. Prompt ids are bound to the connection. Ambient `ui.send` never forwards `PROMPT_EVENTS` (§3.4, §3.5) |
| Desktop user widens remote-origin power through proxied settings | Settings that spawn processes or listeners for every origin (`mcp*`, hooks, channels, webhooks, skills) are not proxied or imported. `allow` rules and always-approve lists added from the desktop affect only desktop runs, because remote-origin executors keep `denyAutoApproval`. Allowed directories added from the desktop live in a desktop-scoped list only marked runs see; the desktop can remove only rules it added (§3.4). The pairing warning says all of this |
| Import writes outside the target | Every case path is resolved and confined to the cases root; symlinks are rejected; chat and memory ids are data, not paths |
| Root `import --from` reads a planted link (a symlink or hardlink to `/etc/shadow` copied into a case) | The R51 walker: `lstat` everywhere, no links, `nlink === 1`, owner = the `<userData>` owner, `O_NOFOLLOW`, or privileges dropped on POSIX (§3.8) |
| Sniffing secrets during import | Loopback only. Capturing loopback traffic needs admin/root, who can already read the service's master key (parent §4.2) |
| Browser page drives the bridge | Upgrades with an `Origin` header are refused; auth needs a signature |
| Port squatter collects device signatures | The server signs first (`hello` before `auth`); signatures cover node id, device id, port and both nonces |
| Handshake flooding or lockout by another local account | 4 KiB pre-auth frames, 2 s first-frame and 10 s handshake deadlines, 16 pre-auth sockets with the oldest evicted, failures counted per `deviceId` only (no global lockout) |
| A desktop run keeps acting after the window is gone | Disconnect stops the connection's runs and denies its prompts (§3.3) |

Trust principle 3 (parent §3.1) holds: desktop sessions and their child agents keep the
dialog; every other origin is unchanged (denied in stages 1–2, the phone from F3). The
residual is the parent's (§11, "Local malware at the keyboard"), now also for service runs.

**Before attaching the owner must see** that tools run as the service account (`LOCAL
SERVICE`, `king-louie`, or the macOS daemon user), without the owner's git credentials, SSH
keys or home unless the admin grants them. The pane says so; every working directory goes
through `bridge.checkPath`.

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| Service not running / port closed | client retries with backoff; proxied calls return `{ ok: false, code: 'SERVICE_UNREACHABLE' }` | pane and chat banner: `The local King Louie service is not reachable (127.0.0.1:18796).` with Retry now / Use standalone this time / Detach |
| Bridge file missing | pairing waits; attached start behaves as unreachable | `No local service found at <configDir>.` |
| Bridge file not admin-owned | refuse | `BRIDGE_FILE_UNTRUSTED`: `<path> is not owned by an administrator; refusing to trust it.` |
| Protocol mismatch (close 4426) | stop retrying until relaunch | `This app speaks desktop-bridge protocol 1; the service speaks 2. Upgrade the older one.` |
| Service older than app (channel missing from `ready.service.channels`) | that channel returns `SERVICE_TOO_OLD` | `The local service (version 26.9.0) does not support <channel>. Upgrade the service.` |
| Device unpaired (4403) | stop retrying; `pairing` kept for display | `The service does not know this desktop. Pair again in Settings > Local service.` |
| Service identity changed (token/key rotated by a reinstall) | close before sending anything; never re-pin automatically | `The service's identity changed from <old> to <new>. If you reinstalled the service, pair again.` |
| Another device attached (4409) | stop retrying until Retry now | `Another desktop (<label>) is attached to this service.` |
| Service restarts or upgrades mid-run | synthetic `chat:messageError` per open run; reconnect; re-read `ready.service`; renderer reloads chats | `The local service restarted; the reply was lost.` |
| Timeout (120 s) | `BRIDGE_TIMEOUT` | `The local service did not answer in time.` |
| Unproxied channel | `{ ok: false, code: 'ATTACHED_UNAVAILABLE' }` | `Not available while attached to the local service. Detach in Settings > Local service to use it.` |
| Working dir inaccessible to the service | `PATH_NOT_ACCESSIBLE`, not set | `The service runs as <account> and cannot read <path>. Grant that account access or pick another folder.` |
| Import partial failure | other items continue; failed items listed; rerun retries only those | report table: counts per action and each failure with its error |
| Import while the service cipher is unavailable | secrets `failed` with `Encryption unavailable in the service.`; the rest proceeds | as above |
| `safeStorage` unavailable, or Linux `basic_text` backend | Pair and secret export refused | `SECURE_STORAGE_UNAVAILABLE`: `This system has no secure storage; the desktop can't hold a pairing key.` |
| Desktop disconnects while the service stays up | its runs stop, prompts denied (§3.3) | on reconnect the chat shows `The desktop disconnected; the run was stopped.` |
| Frame over 64 MiB | `PAYLOAD_TOO_LARGE` for that call; socket stays open | `That request is too large for the local service (64 MiB limit).` |
| Removing a rule the desktop did not add | `RULE_NOT_DESKTOP` | `This rule was set on the service and can only be removed there.` |
| CLI `import` while service runs | exit 1 | `Stop the service before importing into <dataDir>.` |
| `import --from` meets a link, hardlink or foreign-owned file | that item `needs-attention` | report line naming the path and reason |

## 10. Testing

Unit and integration tests (`node --test`):
- `tests/desktop-bridge-protocol.test.js`: auth string builders (port included); a good
  handshake in the hello-first order; a client that gets a bad `hello.sig` never sends
  `auth`; a wrong device key (4401); an unknown device (4403); a replayed `auth` (rejected,
  `serverNonce` changed); an oversized pre-auth frame and a silent socket past 2 s (4400);
  5 failures lock out only that `deviceId`; the 17th pre-auth socket evicts the oldest; an
  `Origin` header (403); a 65 MiB `invoke` gets `PAYLOAD_TOO_LARGE` and the socket stays open.
- `tests/desktop-bridge-dispatcher.test.js`: the served set equals
  `(listIpcChannels() ∩ allowlist) − prestep`; a denied channel never reaches its handler;
  events carry `isLocalDesktopEvent` and `localDesktopDeviceId`; prompt ids from connection A
  are ignored on B; disconnect aborts that connection's runs and denies its prompts; ambient
  `ui.send` drops `PROMPT_EVENTS`; a desktop-added directory reaches a marked run's executor
  but not `settings.allowedDirectories`; removing a service-set `deny` rule → `RULE_NOT_DESKTOP`;
  **negative:** a gateway `agent.execute` while a desktop is connected is denied and no
  prompt appears on the connection.
- `tests/core-origin.test.js`: for `remoteApprovals` `'deny'` and `'allow'`, a marked event
  keeps auto-approve and `allow` rules and gets `approvalRequired`; an unmarked event and a
  requester-only executor are demoted as today; `executorOptions.denyAutoApproval: true`
  demotes even a marked run; a plain object with the same keys is not marked; only the
  standalone wrapper and the dispatcher call `markLocalDesktopEvent`; a child built with a
  marked requester is local and its prompt reaches the parent's dialog. (Phone mode is F3's test.)
- `tests/desktop-pairing.test.js`: request round-trip; `deriveDeviceId` matches F3's
  `device-id-ed25519` vector; tampered id/key mismatch; the CLI refuses without admin rights
  (injected `isAdmin`) and on `profile: runbook`; devices file upsert and unpair; the
  service.json merge keeps other keys; `assertAdminOwned` on the devices file (tests pass
  `adminUid`). **Windows only** (skipped elsewhere): the `S-1-5-11` ACE is added
  non-inherited, and the inspector reads the owner of the bridge file as a normal user.
- `tests/desktop-import.test.js`: plan actions for every category; a rerun gives
  `skip-present`; the three-way rerun rule (`update` in place; both changed → one `copy`);
  a secret appears in no plan, report, log line or manifest (every output scanned for the
  plaintext); case path traversal (`../x`, absolute, symlink) rejected; cases land via the
  temp dir and skip `.kl/lock`; **source side (R51):** a symlink store file, a symlinked
  case dir, a hardlinked file (`nlink 2`) and a foreign-owned file are each refused
  `needs-attention` and never read; the CLI source marks secrets `needs-desktop`; cron is
  imported disabled through `addJob`.
- `tests/attached-host.test.js` (no Electron; fake ipcMain and window): every inventory
  channel gets exactly one registration; routing matches §3.6; a dropped connection
  sends `chat:messageError` for open runs; `--kl-standalone-once` starts with channels,
  gateway and mesh off and cron paused.
- `tests/ipc-contract.test.js` stays unchanged and green, since `desktop:*` is
  registered by `registerHandlers`.
- `tests/electron-boundary.test.js`: `src/desktop-bridge/` and `src/migration/` are
  Electron-free.

E2E (`npm run test:e2e`, `tests/e2e/helpers.js` rewritten):
- `launchApp({ userDataDir?, seed?, env?, args? })`: `_electron.launch({ executablePath:
  require('electron'), args: [APP_PATH, '--user-data-dir=' + tmp], env })` with
  `ELECTRON_RUN_AS_NODE` **deleted** from the copied env and `KL_TEST_MODE=1`; asserts
  `app.getPath('userData') === tmp` (else throws `userData isolation failed`); `seed` writes
  files first, including wizard completion (no race with `#wizard-skip-btn`); waits for `#user-input`.
- `evaluate(ctx, code)` runs `executeJavaScript(code, true)` on the first window through
  `electronApp.evaluate` (user-gesture semantics kept); `waitFor`, `click`, `fill`, `getText`,
  `getValue`, `isVisible`, `count` keep their signatures; `closeApp(ctx)` closes the app,
  stops any service and removes temp dirs (retrying `EBUSY` on Windows 5 × 200 ms).
- `launchAttached(opts)`: makes `<tmp>/data` and `<tmp>/config/service.json`
  (`features.desktopBridge: true`, `ports.desktopBridge: 0`); spawns
  `tests/e2e/_attach-service.js`, which registers a stub provider with
  `ProviderFactory.registerProvider`, calls `runService({ dataDir, profile: 'agent', adminUid:
  process.getuid?.() })`, rewrites the bound port into the temp `desktop-bridge.json` (tests
  only) and prints it; pairs through the UI with the `desktop pair` module in-process
  (injected `isAdmin`) and `KL_DESKTOP_BRIDGE_FILE`; clicks Attach, relaunches on
  `KL_RELAUNCH_REQUESTED`, and returns `ctx` with `ctx.service`.
- New `tests/e2e/attached-mode.test.js`: a chat streams from the stub provider; a gated
  tool shows the dialog and runs on approve; an unproxied tab shows the notice; killing the
  service shows the unreachable banner and a restart reconnects.
- All 22 existing e2e files pass on the new harness. A test that depended on the real
  profile is fixed with `seed` in the same PR. The e2e suite stays out of CI (it needs a
  display); it is run locally before merge, as today.

Five conditions the parent is silent on:

| Condition | Behaviour | Test |
|---|---|---|
| Two desktop users on one machine | Each must be paired by an admin. At most one is attached at a time (4409 names the other). The pairing CLI warns that every paired desktop sees all service data | `desktop-bridge-protocol.test.js` "second device is refused while the first is live" |
| Service upgraded while the app is attached | The socket closes (`bye SERVICE_STOPPING`), open runs get `chat:messageError`, and the client reconnects and re-reads `ready.service`. A new protocol → mismatch state. New or removed channels are applied from `ready.service.channels` | `attached-host.test.js` "reconnect with changed service info" + the e2e restart case |
| Standalone and attached both holding chats | Import merges by id and copies conflicts once. Detach shows the untouched standalone chats, and the pane says chats made while attached live in the service. A later import brings new standalone chats across | `desktop-import.test.js` "rerun after standalone use" |
| Wizard on first attach | Never shown in attached mode (`wizard:getStatus` is answered locally). If the service has no provider, the pane and the first send say `The service has no provider key yet — import or add one in Providers.` | `attached-host.test.js` "wizard is local" pins the message text |
| Offline machine | Everything is loopback: pairing, attach and import need no network. The client ignores proxy env vars and uses the literal `127.0.0.1` | `desktop-bridge-protocol.test.js` "client ignores HTTP_PROXY" |

## 11. Deviations from the parent

1. **"No data migration … the desktop app may later connect … (out of scope)"** (§4.2).
   This stage is that later step; the standalone stores are still never modified.
2. **A dedicated desktop bridge, not the gateway** (§4.4): gateway clients are
   remote-origin by design (§3.1). Port 18796 joins the §4.3 ports table.
3. **Workflows, tasks and background agents are not proxied** (§3.1 principle 3, §13 "Local
   approvals"): their child runs would lose the dialog. Child agents keep it through the
   marked requester (F3, R49).
4. **Contradicted by code.**
   - §4.2 plans `main.js` as "Electron wiring only". It already is (151 lines), so
     stage 7's split is about modes, not size.
   - §4.7 says existing e2e tests "keep passing unchanged". They share the real
     profile (ruling 9).
   - "139 IPC channels" counts `constants.js`. `registerHandlers` actually registers
     156 `handle` + 3 `on` channels (settings alone registers 39, many as string
     literals), plus `canvas:executeJsResult` in `main.js`. The allowlist works on the
     registered inventory, not on the constants.
   - `remoteApprovals: 'deny'` sets `denyAutoApproval` for **every** executor,
     including one with a UI sender. This is why §3.5 is needed.
   - `playwright` is a dependency but unused.
   - The node key is DER SPKI hex and `deriveNodeId` rejects raw keys, so device keys
     (raw 32 bytes) need F3's `deriveDeviceId`/`ed25519RawToSpki`, not `deriveNodeId`.
5. **Program §5.** F7 is listed for `settings.js` but adds nothing there (§6), and for a
   `NODE_YAML_KEYS` entry `desktopBridge` it does not need (§7).

## 12. Assumptions made without asking

- Channel bot tokens, hooks and MCP server configs are not imported. Alternative: import them disabled.
- The pairing CLI turns on `features.desktopBridge` itself. Alternative: the owner edits `service.json`.
- Working directories the service cannot read are refused rather than set with a warning. Alternative: set and warn.
- Import conflicts are copied, never overwritten. Alternative: newest `updatedAt` wins.
- A desktop disconnect stops the runs it started. Alternative: let them finish unattended with prompts denied.
- The Approvals and relay section is read-only. Alternative: approve pending requests from the desktop.

## 13. Deferred

- Proxying hooks, skills, MCP servers, webhooks, channel access lists and diagnostics, each with its own review of what it hands remote-origin runs. Later work, after F3.
- Workflows, planner, tasks and background agents in attached mode: they need the parent's event threaded into their child runs first.
- Voice playback and the Anthropic OAuth flow, which need the user's session: after F5 (session helper).
- Reverse import and "export chats made while attached" on detach: a follow-up to this stage.
- A tray indicator and starting the app at login attached: after this stage.
- Making attached mode the default when a paired service is found: the owner's call, after field use.

## 14. Dependencies (npm)

None new. `ws` (already used by the gateway) carries the bridge. Ed25519 and SHA-256
come from `node:crypto`. `playwright` (already listed) provides `_electron`. JCS was
rejected in favour of newline-joined fixed-field strings, so no canonicalization
library is needed.
