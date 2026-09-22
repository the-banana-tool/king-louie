# King Louie Fleet — Design Spec

- **Status:** Draft — architecture agreed, stages to be detailed one at a time
- **Date:** 2026-09-21

## 1. Goal

Run King Louie as a service on every machine an owner has (Windows, macOS,
Linux; desktops, laptops, cloud servers), and drive the whole fleet from any
LLM client (Claude, ChatGPT, Perplexity) over MCP, without opening security
holes.

King Louie is open source. **Nothing in the code, defaults or docs may be
specific to one person's setup.** Machine names, domains, paths, apps and
runbooks are always configuration. The names below (`gpu-box`, `laptop`,
`web-01`, `kl.example.com`) are illustrative only. Reference runbooks and
configs ship as examples under `examples/`, and each owner's real `node.yaml`
and runbooks live outside the repo (§5.2).

Example requests this must support, using a representative fleet:

- "Use gpu-box to download ML models to the D: drive and run the training script."
- "Pull and restart web-01."
- "What's the state of my machines?" / "Is the training run on gpu-box still going?"

Each machine has a different job:

| Machine | Role | Why |
|---|---|---|
| gpu-box (Windows desktop) | Heavy compute | Strong GPU, big `D:` drive for models/data |
| Laptop (Windows) | Operator | Runs build/deploy scripts. Its SSH keys are break-glass only; servers manage themselves |
| Mac | Operator / general | — |
| web-01 and other servers (Linux) | Managed target | Must be pulled/updated/restarted/rebooted, nothing more |
| Front-door VPS (Linux, new) | Public ingress | The only machine reachable from the internet |

### Non-goals

- Multi-tenant or multi-user access. There is one owner. The only "users"
  are the owner's phone(s) and the LLM clients the owner has connected.
- Replacing Ansible or other config management. Runbooks run a fixed list of
  commands; they are not a provisioning language.
- Queuing work for machines that are offline (§9).
- A web approval UI. Approvals come only from the native phone app.

## 2. Decisions

These were settled while brainstorming and are fixed for every stage.

| # | Decision | Chosen | Rejected alternatives |
|---|---|---|---|
| D1 | How LLM clients reach the fleet | **One cloud front-door node** exposing a remote MCP server; every other node connects *out* to it | Cloudflare Tunnel per node; private-only (loses ChatGPT, Perplexity and claude.ai) |
| D2 | What servers may run | **Named runbooks only**: typed, pre-declared operations with no shell and no agent | Constrained agent; full agent |
| D3 | What desktop/laptop/Mac may run | **Full agent**: any prompt, with unsafe tool calls gated by phone approval | Runbooks only |
| D4 | Who approves unsafe actions | **Native mobile app** holding a hardware-backed key; approvals are signatures over the exact action, and the executing node checks them | Passkey PWA; Telegram buttons / TOTP |
| D5 | Node ↔ front-door transport | **King Louie mesh over the public internet**: outbound WSS with mutual TLS and pinned keys | Tailscale/Headscale + mesh; hand-rolled WireGuard |
| D6 | Where the front door runs | **Its own small VPS**, separate from web-01 | Co-located on the web-01 box; managed containers |
| D7 | How King Louie runs without Electron | **Extract a plain-Node core** used by two hosts: the Electron app and `king-louie-service`. Servers use a runbook-only build profile | Hidden Electron window; separate minimal agent for servers |

## 3. Architecture

```
 Claude / ChatGPT / Perplexity ──HTTPS + OAuth 2.1──▶ ┌──────────────────────────┐
                                                      │ FRONT DOOR (own VPS)     │
 Owner's phone (native app) ◀── push / signed ──────▶ │ MCP server · OAuth AS    │
                                                      │ router · audit mirror    │
                                                      └────────────▲─────────────┘
                                   outbound WSS, mutual TLS, :443  │  (pinned keys)
            ┌────────────────────┬────────────────────┬────────────┴───────┬──────────────────┐
        gpu-box               laptop                mac                web-01          other servers
      profile: agent       profile: agent       profile: agent     profile: runbook   profile: runbook
      GPU, D:\ drive       SSH keys, deploys
```

### 3.1 Trust principles

1. **Nodes decide; the front door routes.** Every authorization decision that
   leads to execution is made on the node that will execute. That includes
   policy, approval-signature checks and runbook parameter validation. A fully
   compromised front door can refuse service and read traffic metadata. It
   cannot make a node run anything the node's own policy would not run.
2. **Execution definitions are local.** Runbooks and permission policy live in
   files on each node that the service account cannot write to. Nothing
   received over the network can add or change a runbook or a policy.
3. **Unsafe means the phone signs.** An unsafe action runs only with a fresh,
   single-use signature from an enrolled phone key over a hash of that exact
   action. Nothing can stand in for this: not a scope, token or setting, and
   not a "remember this" approval. **The one exception is the computer-use
   lease (§4.6).** It is signed, limited in time and to specific apps, can be
   revoked, and appears live on the phone.
   **This principle covers remote-origin work.** Sessions the owner starts in
   the local desktop app keep today's on-screen approval dialog.
4. **One public port.** Only the front door accepts inbound connections, on
   443. Nodes never listen on a public interface.
5. **Everything is audited.** Every node keeps an append-only, hash-chained
   log of requests, approval decisions and executions, and the front door keeps
   a copy.

### 3.2 Components

| Component | Where | Stage |
|---|---|---|
| `src/core/`: Electron-free composition root | all nodes | 1 |
| `king-louie-service`: headless host and OS service installers | all nodes | 1 |
| Node identity, role/profile, policy files | all nodes | 2 |
| Runbook engine | all nodes (the only executor on servers) | 2 |
| Local MCP server (stdio), for Claude Code / Desktop on the same machine | agent nodes | 2 |
| Approval protocol and approver that sends requests to the phone | all nodes | 3 |
| Native mobile app | phone | 3 |
| Front door: remote MCP, OAuth AS, router, push relay, audit mirror | VPS | 4 |
| Session helper: GUI apps and computer use (§4.6) | agent nodes | 5 |
| Per-machine rollout and runbooks | each machine | 6 |
| Electron app as a UI for the local service | agent nodes | 7 |

---

## 4. Stage 1: Headless core and service mode

**Outcome:** King Louie runs as an OS service with no Electron on Windows,
macOS and Linux. The Electron app behaves exactly as it does today.

### 4.1 Problem

`main.js` (~3000 lines) builds everything. Storage, the vault, token
encryption and user-data paths all depend on Electron (`electron-store`,
`safeStorage`, `app.getPath`). A few `src/` modules also reach into Electron:

- `src/execution/agent-loop.js`: `BrowserWindow` and `require('../../main')`
  for directory-access and ask-user prompts. **This is the main blocker.**
- `src/tools/builtin/vault-tool.js`, `web-search-tool.js`: `safeStorage` / `electron-store`
- `src/mesh/index.js`: `safeStorage`
- `src/auth/anthropic-oauth.js`: `shell.openExternal`
- `src/channels/channel-plugin.js`, `src/notifications/channels/ui-toast.js`: `BrowserWindow`

Most of `src/` (providers, tools, tool-executor, guardrails, checkpoints,
verification, cron, workflows, gateway, webhooks, mcp, memory) already takes
its dependencies through constructors.

### 4.2 Design

`createCore(deps)` in `src/core/index.js` does what `main.js` currently does
to wire things up, and takes these host-provided ports:

| Port | Interface | Electron host | Service host |
|---|---|---|---|
| `paths` | `{ dataDir, logsDir, cacheDir }` | `app.getPath('userData')` | `--data-dir`, else OS default (`%ProgramData%\KingLouie`, `/var/lib/king-louie`, `~/Library/Application Support/KingLouie`) |
| `store(name)` | `get/set/delete/has/keys`, JSON values | `electron-store` (**unchanged on disk**) | atomic JSON files (write-temp + rename) |
| `cipher` | `encryptString(plain)` / `decryptString(token)` / `isEncryptionAvailable()` | `safeStorage`-backed (unchanged) | AES-256-GCM (`src/platform/cipher.js`), keyed by a per-install master key (see deviation below) |
| `approver` | `requestApproval(action) → { decision, evidence }` | existing renderer dialog | stage 1: **deny all unsafe**; stage 3: phone |
| `prompter` | `askUser(q)`, `requestDirectoryAccess(path)` | renderer dialogs | stage 1: deny / "no interactive user"; stage 3: phone |
| `notifier` | `notify(event)` | toast | log only; stage 3: push |
| `opener` | `openExternal(url)` | `shell` | log the URL; the auth flow prints a device code |

**Deviation — no `secrets` port.** It was never built. Secrets still go
through the plain `store` port (as `vaultStore`), now encrypted by the new
`cipher` port before being written — the same shape as the Electron host's
`vaultStore` + `safeStorage`, just with `cipher` swapped in. `cipher`'s
master key comes from, in order: a systemd credential (`kl-master-key`,
delivered via `LoadCredential=`) under systemd on Linux; Windows DPAPI in the
service account's `CurrentUser` scope; otherwise a `0600` key file in the data
directory (macOS, and Linux without systemd credentials). There is no macOS
Keychain and no Linux libsecret backend: both would need either a native npm
dependency (ruled out — no new npm dependencies) or a logged-in session/D-Bus
secret service, which a service account run before login doesn't have.

Rules:

- A module under `src/` other than `src/ipc/` and the Electron host must not
  `require('electron')` or `require('../../main')`. A test enforces this by
  scanning source files.
- `main.js` becomes Electron wiring only: build the Electron ports, call
  `createCore`, register IPC.
- **No data migration.** The Electron host keeps its existing stores. The
  service host has its own data directory. Running both on one machine is
  supported. The service is the one that joins the fleet, and the desktop app
  may later connect to the local service as a UI (out of scope).

### 4.3 Service host

- `bin/king-louie-service.js` with the subcommands `run`, `install`,
  `uninstall`, `status`, `pair` (stage 2) and `doctor`.
- `install` registers the service on each OS:
  - **Windows (deviation):** a boot-time Scheduled Task (`schtasks`), not a
    registered SCM service, running as `LOCAL SERVICE`. It creates the data
    directory itself with a protected, minimal ACL (`LOCAL SERVICE`/`SYSTEM`/
    Administrators only, inheritance disabled); if the directory already
    exists it only verifies that ACL and refuses rather than relocking a
    directory it didn't create. A real Windows Service (SCM-registered,
    `services.msc`-visible, with proper stop/pause semantics) is deferred to a
    later stage.
  - **Linux:** systemd unit with `User=king-louie`, `ProtectSystem=strict`,
    `NoNewPrivileges=yes` and `LoadCredential=` for the master key
  - **macOS:** a launchd LaunchDaemon that runs as a dedicated user
- Reinstalling is idempotent on every OS: it skips creating the service
  account if one already exists and never overwrites an existing master key,
  so a second `install` reuses the key the first one generated.
- The CLI's flag parsing is strict: an unknown `--flag`, a flag given with no
  value, and an empty `--data-dir` all exit 2, rather than silently falling
  back to a default. Both `--flag value` and `--flag=value` are accepted.
- `core.shutdown()` is bounded rather than open-ended: cron is stopped first
  so no job fires while the rest drain, and each remaining subsystem stop is
  given a timeout (default 5s) so one hung stop can't block the others.
- **Build profiles**, chosen from config and checked at startup:
  - `agent`: full core (providers, agent loop, tools, runbooks, delegation)
  - `runbook`: runbook engine, identity, mesh and audit only. Providers, the
    agent loop, the tool registry, browser, channels and the MCP client are
    **never `require`d**. A test asserts that the runbook-profile module graph
    excludes them.
  - `frontdoor`: added in stage 4 (§7.1). The loader should allow new
    profiles to be added without restructuring.

### 4.4 Existing gateway

`src/gateway/gateway-server.js` listens on `127.0.0.1:18789` with **no
authentication**, so any local process can drive the agent. In service mode
both it and the webhook server (port +1) are **off by default** and refuse to
bind to anything other than loopback. When the gateway is enabled it requires
a bearer token, generated on first use and encrypted through the `cipher`
port into the `store` — not a `secrets` port, which was never built (§4.2).
For local processes and CLI tooling, the same token is also written in the
clear to `<dataDir>/gateway-token` (mode `0600`, written atomically).
**Deviation:** where encryption is unavailable on the host, the token falls
back to **session-only** — it still authenticates the current run, but a
fresh one replaces it (locking out every prior client) on the next start,
rather than persisting unencrypted on disk.

**Deviation — webhook server has no bearer token.** Instead it refuses any
request carrying an `Origin` header (no CORS is offered at all), and each
registered webhook is separately authenticated with `X-Hub-Signature-256`.
The Electron host's gateway gets the same token requirement as the service
host's. This is a pre-existing issue and the fix goes in stage 1.

### 4.6 Desktop GUI apps on agent nodes (Q5)

**Problem:** OS services can't reach the logged-in user's desktop.
- On Windows, services run in Session 0 and cannot show windows to the user.
- On macOS, a LaunchDaemon has no access to the GUI login session.
- On Linux, a system unit has no `DISPLAY` or `WAYLAND_DISPLAY`.

So "run Rhino on my Mac" needs a process running *in the user's session*.

**Capability:** a node advertises the `gui` capability only while it has a
live session-bound component. `describe_machine` shows it. Launch requests
sent to a node without `gui` fail with `capability_unavailable: gui` before any
approval is asked, so servers never have it.

**Process model (decided): system service plus a session helper.**
- The **service** runs as a system service on agent nodes as well. It is
  always up, even before login, so long jobs survive reboots. It owns the
  identity, the mesh connection, jobs, policy and approvals.
- The **session helper** (`king-louie-service session`) is started at user
  login:
  - macOS: LaunchAgent
  - Windows: a scheduled task at logon or a Run key, running in the user's
    interactive session
  - Linux: an XDG autostart entry or a `systemd --user` unit
- The helper connects to the service over local IPC: a Windows named pipe with
  an ACL for the user's SID, or a Unix socket that only the user can access.
  Both sides authenticate each other with a per-install secret stored in
  `secrets`.
- The helper does GUI work **only**. It has no policy of its own and runs only
  what the service tells it to, with each request tagged by job ID for the
  audit log.
- When the helper disconnects (logout, lock policy, crash), the `gui`
  capability is withdrawn at once.

**Launching apps:** app launches use a `LaunchApp(app, args?, files?)` tool,
not free-form shell. Apps are resolved from an allowlist in `node.yaml`
(`gui.apps: { rhino: '/Applications/Rhino 8.app', blender: 'C:\…\blender.exe' }`).
- Launching an allowlisted app is `routine`.
- Anything else is `unsafe`.
- `Screenshot`, `ListApps` and `CloseApp` (allowlisted apps only) are `read`
  or `routine`.

**Full computer use (decided):** agent nodes can drive app UIs with
`Screenshot`, `Click`, `Type`, `Key`, `Scroll` and `Drag`. Approving each
input would make this unusable, so computer use runs under a **computer-use
lease**, the one bounded exception to trust principle 3 (§3.1):
- The lease is signed by the phone like any approval (§6). It covers the node,
  the job, the target app(s) from the allowlist, and a maximum duration
  (default 15 minutes, never more than 60).
- **Inputs are confined to the leased apps.** Before every input the helper
  checks that the foreground window belongs to a leased app's process. If
  not, the input is refused and the lease is suspended until the owner
  confirms again. This stops a session from wandering into a terminal,
  browser or password manager.
- Typing text that matches `always_confirm` patterns or looks like a secret is
  refused, and no clipboard access is granted.
- The phone app shows the live lease: a screenshot feed updated at least once
  every 5 s, an action log, and a **kill switch** that revokes the lease at
  once with a signed revoke.
- When the lease expires or is revoked, the next input fails and the job waits
  for a new lease.
- Screenshots go back to the client as untrusted tool output (§8.3).
- The platform backends reuse `src/browser/` patterns where they fit:
  - Windows: `SendInput` / UI Automation
  - macOS: the Accessibility API and `CGEvent`, with the Accessibility and
    Screen Recording permissions granted to the helper
  - Linux: X11 XTest; Wayland support is best effort through portals

### 4.7 Testing

- The ban on Electron imports (static scan).
- Contract tests for each port, run against every implementation. The OS
  secrets backends run only on their own OS, so CI needs all three.
- The runbook profile's module graph excludes the agent modules.
- A smoke test: `king-louie-service run --data-dir <tmp>` starts, reports
  health and shuts down cleanly on SIGTERM / service stop.
- Existing `npm test` and `npm run test:e2e` keep passing unchanged, so the
  Electron app shows no regression.

---

## 5. Stage 2: Identity, profiles, policy and runbooks

**Outcome:** each node has a cryptographic identity, a declared profile and a
local policy. Nodes can run runbooks, and agent nodes expose a local stdio MCP
server so Claude Code on the same machine can use King Louie before the front
door exists.

### 5.1 Node identity

- Each node gets an **Ed25519 key pair** when it is first set up, stored in
  `secrets`. Its node ID is `kl-<base32(sha256(pubkey))[0..16]>`, and each node
  also has a human-readable name (`gpu-box`, `laptop`, `web-01`).
- The mesh TLS certificate is self-signed with this key. Peers pin the
  **public key**, not a CA.
- Pairing with the front door (the flow is here; the front door itself is
  built in stage 4):
  1. `king-louie-service pair <front-door-url>` shows the node's key
     fingerprint and asks for a one-time code.
  2. The owner creates the code from the phone app. It is single-use, lasts 10
     minutes and is bound to the node name the owner types.
  3. The node connects and presents its key and the code. The front door pins
     the node key; the node pins the front-door key it saw. Because the node
     entered the front-door URL by hand, this is trust on first use, and the
     node shows the front-door fingerprint for the owner to compare with the
     one in the phone app.
  4. The phone confirms the node fingerprint (signed enrollment, §6.4).
- Any existing `src/mesh/mesh-identity.js` / `mesh-pairing.js` code is reused
  where it fits. That code was written for LAN pairing and has to pass the
  review in §7.3 before it faces the internet.

### 5.2 Node config (local, root/admin-owned, read-only to the service)

`<configDir>/node.yaml`:

```yaml
name: gpu-box
profile: agent            # agent | runbook
front_door: https://kl.example.com   # stage 4
capabilities: [gpu, cuda, large-disk]
policy:
  allowed_roots: ['D:\models', 'D:\datasets', 'D:\train', 'C:\Users\me\src']
  remote_sessions:
    # Anything matching these is always unsafe (phone approval) for
    # remote-originated work, even if the local auto-approve list allows it.
    always_confirm:
      - 'Bash(ssh *)'
      - 'Bash(scp *)'
      - 'Bash(git push*)'
      - 'Vault(*)'
      - 'Bash(*deploy*)'
    deny:
      - 'Bash(rm -rf /*)'
  max_concurrent_jobs: 2
runbooks_dir: runbooks/
```

`configDir` is `%ProgramData%\KingLouie\config` on Windows,
`/etc/king-louie` on Linux, or `/Library/Application Support/KingLouie/config`
on macOS, and the service account can only read it. At startup the service
checks the ACLs and mode bits and **refuses to start** if it could write to its
own config.

### 5.3 Safety tiers

Every action that can come from remote falls into exactly one tier:

| Tier | Examples | Behaviour |
|---|---|---|
| `read` | status, logs, GPU usage, job status, `git status` | Runs automatically |
| `routine` | pull, restart one service, download a model to an allowed root | Runs automatically; rate-limited per runbook; audited |
| `unsafe` | reboot, deploy to production, SSH, pushes, credential access, anything outside `allowed_roots`, any agent tool call the local rules mark `ask` | **Needs a phone signature** for every call |

On agent nodes, a tool call from a remote-originated session is `unsafe` if any
of these holds:
- the existing pipeline in `src/execution/tool-executor.js` would ask the user;
- it matches `always_confirm`;
- it touches a path outside `allowed_roots`.

On these sessions **the global auto-approve list and "remember this" are
ignored for `always_confirm` matches**, and `denial-tracker` auto-deny still
applies.

### 5.4 Runbooks

One YAML file per runbook in `runbooks_dir`, also read-only to the service:

```yaml
name: site.pull_and_restart
description: Fetch the given ref, fast-forward, rebuild, restart the site.
tier: unsafe   # production state change (Q4)
params:
  ref:
    type: string
    pattern: '^[A-Za-z0-9._/-]{1,64}$'
    default: main
steps:
  - run: [git, -C, /srv/site, fetch, --prune, origin]
  - run: [git, -C, /srv/site, checkout, --detach, 'origin/{{ref}}']
  - run: [/srv/site/bin/build]
  - run: [sudo, -n, /bin/systemctl, restart, site.service]
  - check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 }
timeout_s: 600
rate_limit: { max: 6, per: 1h }
```

```yaml
name: server.reboot
description: Reboot this machine.
tier: unsafe
params: {}
steps:
  - run: [sudo, -n, /sbin/shutdown, -r, +1, 'king-louie: remote reboot']
```

Rules:

- `run` takes an **argv array** and never goes through a shell. `{{param}}`
  substitution may appear only inside a single argv element, and only for
  parameters that passed schema validation.
- Parameter types are `string` (with `pattern` required), `integer` (with a
  min/max), `enum`, `boolean` and `path`. A `path` must resolve (after
  realpath) under one of the listed roots.
- Steps run in order and stop at the first failure. `check` steps verify the
  result. Their outcomes are recorded in the verification evidence ledger
  (`src/verification/`).
- Privilege comes from a dedicated sudoers or Windows ACL entry for each exact
  command, never from running the service as root/SYSTEM. `doctor` checks the
  sudoers entries.
- A runbook can be requested on its own or as part of a job (§8.3).

### 5.5 Local MCP server (stdio)

`king-louie-service mcp` serves the same tool surface as §8.2 over stdio,
scoped to this node. Claude Code or Claude Desktop on the same machine can then
use it right away. It uses the same tiers. In stage 2, unsafe actions are
denied; from stage 3 they go to the phone.

### 5.6 Testing

- Runbook schema: good and bad files, and injection attempts in parameters
  (`;`, `$(…)`, `..`, symlinks out of roots, Unicode lookalikes). Parameter
  handling is fuzzed.
- Refusal to start when the config is writable by the service (per OS).
- Tier classification against a table of tool calls.
- The stdio MCP server tested with the MCP SDK's test client.

---

## 6. Stage 3: Signed approvals and the mobile app

**Outcome:** unsafe actions on any node reach the owner's phone. The owner sees
the exact action, approves with biometrics, and the node checks the signature
before running it. At this stage the phone talks to nodes through a relay, which
becomes the front door in stage 4.

### 6.1 Keys

- The phone app creates an **ECDSA P-256** key pair in the Secure Enclave (iOS)
  or StrongBox/TEE (Android). The key can't be exported, and every signature
  requires biometric user presence (`.biometryCurrentSet` /
  `setUserAuthenticationRequired(true)` with invalidation when new biometrics
  are enrolled).
- Each node stores the enrolled phone public keys in `secrets` (the set of
  approver keys).

### 6.2 Approval request (created and signed by the executing node)

```jsonc
{
  "v": 1,
  "type": "kl.approval.request",
  "request_id": "uuid-v4",
  "node_id": "kl-…",
  "node_name": "laptop",
  "action": {                       // exactly what will execute
    "kind": "tool" | "runbook",
    "name": "Bash" | "server.reboot",
    "params": { … },                // canonical form, after defaults applied
    "cwd": "C:\\…",                 // agent tool calls only
    "summary": "Run: ssh deploy@web-01.example.com 'sudo systemctl restart …'"
  },
  "action_hash": "b64url(SHA-256(JCS(action)))",
  "origin": { "client": "claude.ai", "session": "…", "job_id": "…" },
  "created_at": "RFC3339",
  "expires_at": "RFC3339",          // ≤ created_at + 5 min
  "nonce": "b64url(32 random bytes)"
}
```

The node signs the request's JCS (RFC 8785) serialization with its Ed25519
node key. The phone checks that signature against the node key it pinned at
enrollment. **If the check fails, the request is not shown at all.**

### 6.3 Approval response (signed by the phone)

```jsonc
{
  "v": 1,
  "type": "kl.approval.response",
  "request_id": "…",
  "node_id": "…",
  "action_hash": "…",
  "nonce": "…",
  "decision": "approve" | "deny",
  "expires_at": "…",                // copied from the request
  "device_id": "…",
  "signed_at": "RFC3339"
}
```

The phone signs this with its hardware key. The node accepts it only if **all**
of these hold:
1. The signature verifies against an enrolled, unrevoked device key.
2. `request_id`, `node_id`, `nonce` and `action_hash` match a request that
   this node has pending.
3. `action_hash` equals a fresh hash of the action the node is about to run.
4. It is not past `expires_at`.
5. The nonce hasn't been used before. Pending requests are dropped once used or
   expired.

Then the node runs the action once. There are no batch or standing approvals.

### 6.4 Device enrollment and revocation

- **The first device** enrolls on a node from its local console
  (`king-louie-service enroll-device`, which shows a QR code for the phone to
  scan).
- **Later devices** need a signed `kl.device.enroll` from an already-enrolled
  device. It carries the new public key, and nodes add the key once they have
  checked that signature.
- **Revocation:** a signed `kl.device.revoke` from any other enrolled device,
  or the local console. If the owner has only one phone and loses it, recovery
  is through the local console on each node. That is deliberate.
- Enrollment and revocation messages go to nodes through the front door. Nodes
  check them against their own list of approver keys, so the front door can't
  add a key.

### 6.5 Mobile app

- **Platform:** fully native (Q2). Swift/SwiftUI with CryptoKit
  `SecureEnclave.P256` on iOS; Kotlin/Compose with Android Keystore
  (StrongBox when available) on Android. The protocol lives in one written
  spec plus shared JSON test vectors that both apps and the Node verifier must
  pass.
- **Screens:**
  - Pending approvals: node name, action summary, full parameters, origin
    client, time left
  - Approve (biometric) / Deny
  - History, taken from the audit mirror
  - Fleet status
  - Connected clients (revoke OAuth grants)
  - Device management
  - Pairing codes
- **Push:** APNs/FCM notifications carry **only a request ID**. The app then
  fetches the signed request over its authenticated channel. Notification text
  on the lock screen is generic ("Approval needed on laptop"), so nothing
  sensitive shows there.
- The app talks to the front door, authenticated by signing each request with
  its device key.

### 6.6 Testing

- Protocol test vectors: fixed keys, requests and responses with expected
  accept/reject results. These cover every one of the five checks, a replay,
  a changed parameter, an expired response, a revoked key and the wrong node.
- A node-side test that changes the action after approval and expects the node
  to refuse.
- A fake-phone signer, so the node suite runs without a device.
- Manual tests on a real device for key creation, biometric invalidation and
  push.

---

## 7. Stage 4: Front door

**Outcome:** Claude, ChatGPT and Perplexity connect as remote MCP clients; the
phone connects for approvals; and nodes stay connected over the mesh. There is
one public port.

### 7.1 Deployment

- A small Linux VPS used for nothing else, running `king-louie-service` with
  `profile: frontdoor` (this build profile excludes the agent, providers and
  runbook execution; the front door runs nothing for anyone else).
- TLS on 443 is handled by the service itself, choosing the configuration by
  SNI:
  - `mcp.<domain>`: normal server TLS with ACME (Let's Encrypt). Serves the
    MCP Streamable HTTP endpoint, OAuth and the phone API.
  - `mesh.<domain>`: **the client certificate is required during the TLS
    handshake** and checked against the pinned set of node keys. A connection
    without a pinned key is dropped before any HTTP or WebSocket code runs.
- Firewall: 443 open to the world, SSH only from the owner's allowlisted
  addresses or through the provider's console, everything else closed.
  Unattended security upgrades are on.

### 7.2 OAuth 2.1 authorization server

This follows the MCP authorization spec:
- protected resource metadata (RFC 9728)
- AS metadata (RFC 8414)
- PKCE (required)
- dynamic client registration (RFC 7591) and client ID metadata documents,
  whichever the client uses

Connecting a client works like this:
1. The client starts the OAuth flow, and the browser lands on a front-door
   page that shows the client name and the scopes it asked for.
2. **The owner approves on the phone.** The phone signs a
   `kl.client.grant` over the client ID, redirect URI and scopes. There is no
   password to phish.
3. Tokens are issued:
   - access tokens last 1 hour and are bound to the audience
   - refresh tokens rotate, are bound to the client and are revoked when the
     same token is reused

Scopes, each optionally limited by `machines=`:

| Scope | Allows |
|---|---|
| `fleet:read` | `list_machines`, `describe_machine`, `get_state`, `get_job*` |
| `fleet:run` | request `read`/`routine` runbooks and delegations |
| `fleet:unsafe` | *request* unsafe actions (the phone signature is still needed each time) |
| `fleet:delegate` | `delegate` to agent-profile nodes |

Suggested defaults: Claude gets all four; ChatGPT gets
`read + run + delegate`; Perplexity gets `read`.

### 7.3 Mesh hardening (required before going live)

- A security review of `src/mesh/*` covering:
  - frame size limits
  - bounded memory for each connection
  - authentication before any message parsing
  - replay protection on control messages
  - no Bonjour/mDNS in service mode, since discovery is LAN-only and is
    disabled when a front door is configured
- Heartbeat and reconnect with jittered backoff.
- Each node gets **one** multiplexed connection. The front door rejects a
  second connection for a node key that is already connected, unless the first
  has timed out.

### 7.4 Router

- The router maps MCP tool calls to node RPCs and checks OAuth scopes and
  `machines=` limits *before* forwarding. The node then applies its own policy
  and tiers. Both checks run, and neither trusts the other.
- It keeps a registry of nodes: name, ID, profile, capabilities, online
  status, runbook catalog, and last `get_state`.
- It relays approval requests and responses between nodes and phones and sends
  push notifications. It never creates or changes a signed message.

---

## 8. MCP tool surface (front door and local stdio)

### 8.1 Design choice

The tool set is small and fixed, and callers discover what exists with
`describe_machine`. There isn't one MCP tool per runbook. Adding a runbook or a
machine therefore never changes the tool list, so connected clients don't need
reconfiguring and the tool list stays small.

### 8.2 Tools

| Tool | Scope | Description |
|---|---|---|
| `list_machines()` | read | Name, profile, capabilities, online status, and a summary of each |
| `describe_machine(machine)` | read | Runbook catalog (name, description, tier, parameter schema), policy summary, allowed roots |
| `get_state(machine)` | read | CPU/mem/disk, GPU (utilization, VRAM, temperature), services, running jobs, last update/reboot |
| `run_runbook(machine, runbook, params)` | run / unsafe | Starts a job and returns `job_id` right away. Unsafe runbooks return `status: awaiting_approval` |
| `delegate(machine, task, cwd?)` | delegate | Agent-profile nodes only. Starts a **multi-turn** agent session with origin `remote` and returns `job_id` |
| `send_to_job(job_id, message)` | delegate | Sends a follow-up to an open delegate session. The session keeps its context and becomes `closed` after 2 h idle (configurable) |
| `get_job(job_id)` | read | Status (`queued`, `awaiting_approval`, `running`, `succeeded`, `failed`, `denied`, `expired`, `cancelled`), timing, result summary, evidence |
| `get_job_logs(job_id, since?, tail?)` | read | Paginated output. For delegations, a transcript of tool calls and results |
| `cancel_job(job_id)` | run | Cancels a job; best effort |

### 8.3 Jobs

- All work is asynchronous, which is essential for hour-long training runs and
  for waiting on approvals. MCP progress notifications are sent when the client
  supports them, and polling with `get_job` always works.
- Jobs live on the node. The front door caches their status.
- **Output is data.** Job logs and transcripts go back to LLM clients wrapped
  and marked as untrusted tool output, because logs could contain text written
  to hijack the model. Nothing in job output ever triggers an action.
- `delegate` sessions reuse the whole existing agent stack: tool guardrails,
  turn checkpoints, verification evidence and the event ledger. Their approvals
  go through the phone approver. The final result includes the evidence ledger
  summary, i.e. what the session actually proved.

### 8.4 Worked examples

**"Use gpu-box to download ML models to the D: drive and run the training script"**
1. The client calls `describe_machine(gpu-box)` and sees the runbooks
   `models.hf_download(repo, dest)` (routine, `dest` must be under
   `D:\models`) and `train.run(config)` (routine), plus `delegate`.
2. It calls `run_runbook(gpu-box, models.hf_download, {...})`, which starts a
   job that runs automatically.
3. It calls `run_runbook(gpu-box, train.run, {config: ...})`, another
   automatic job, and then polls with `get_job`.
4. For anything not covered by a runbook, the client calls `delegate` instead.
   Safe tool calls run on their own; anything outside `allowed_roots` or on
   the `always_confirm` list goes to the phone.

**"Pull and restart web-01"**
1. The client calls
   `run_runbook(web-01, site.pull_and_restart, {ref: main})`.
2. The tier is unsafe (Q4), so the phone is notified and shows the ref and
   steps. The owner approves with biometrics, and the node checks the signature
   and runs the runbook.
3. The `check` step confirms `/healthz`, and the result includes that
   evidence. "Reboot web-01" (`server.reboot`) goes through the same
   approval flow.

## 9. Error handling

| Situation | Behaviour |
|---|---|
| Node offline | `run_runbook` / `delegate` fail right away with `machine_offline`. **No queuing**, because a queued unsafe or routine action that fires hours later would be a surprise |
| No approval before expiry | Job becomes `expired`; nothing runs |
| Phone denies | Job becomes `denied`; the denial goes into the node's `denial-tracker` |
| Front door down | Nodes keep running local work and running jobs. The local desktop app and stdio MCP still work. Approvals for local work that depends on the phone can't get through, so they are denied at expiry |
| Node restarts mid-job | The job is marked `failed: node_restarted`. Runbooks aren't resumed automatically |
| Parameter validation fails | `invalid_params` with the schema error; nothing runs |
| Rate limit | `rate_limited` with `retry_after` |
| Policy denies | `denied_by_policy` saying which rule; this error does not reveal the policy contents to the client |

## 10. Audit

- Each node writes every inbound request, tier decision, approval
  request/response, execution start/end and exit status to an append-only,
  hash-chained ledger that reuses `src/events/event-ledger.js`.
- Ledger entries are sent to the front-door mirror. The mirror checks that the
  hash chain continues correctly and raises an alert (push) if the chain breaks.
- The phone app's history reads from the mirror.
- Retention is 1 year on nodes and on the mirror, and can be configured.
- Following the existing preference, plans and task graphs proposed during
  `delegate` sessions go into the session transcript so they show up in
  exports.

## 11. Threat model

| Threat | Mitigation | What's left |
|---|---|---|
| Prompt injection in an LLM client (e.g. a malicious web page tells ChatGPT to deploy) | Scopes; servers run runbooks only; unsafe actions need a phone signature over the exact action; the phone shows the literal command | The owner approves something bad by rubber-stamping. Kept down by keeping `unsafe` rare and showing the full command, never a summary alone |
| Prompt injection through job output | Output is marked untrusted; nothing in output triggers execution | The client LLM may still be influenced; this is covered by the row above |
| Compromised front door | Nodes decide (§3.1); definitions are local; signatures are checked on the node; the front door can't enroll devices or change runbooks | It can deny service, see metadata, and invoke `read`/`routine` actions and `delegate` sessions with routine-tier tool calls. **That is the ceiling of front-door compromise**, so `routine` must stay harmless (Q4) |
| Computer use hijacked (an on-screen prompt injection steers clicks) | Lease limited to allowlisted apps and time; foreground-process check before every input; secret-like text refused; live phone view with kill switch | Anything the leased app itself can do (e.g. Rhino overwriting its open files) until the owner kills the lease. Turn checkpoints (§4) do not cover GUI changes |
| Local malware at the keyboard | Local sessions keep the on-screen dialog (a decided trade-off). Remote-origin work always needs the phone | Malware with the user's session can click local dialogs. Accepted |
| Stolen phone | Key is hardware-bound and needs biometrics for every signature; revocation from another device or a node console | If the biometric is bypassed, the attacker can approve until revocation |
| Compromised OAuth client or stolen token | Short-lived tokens, rotation, reuse detection, per-client scopes, revocation from the phone | Actions within scope until revoked; still cannot run unsafe actions |
| Network attacker | Mutual TLS with pinned keys on the mesh; TLS and PKCE on OAuth | — |
| Compromised node | Other nodes don't trust peers; everything goes through the front door and the node's own policy. A node's key only lets it speak for itself | That node's local powers (e.g. the laptop's SSH keys) |
| Attacker holds the service account on a node | The service can't write its own config or runbooks; privilege comes through exact-command sudoers entries | Anything the service account can already do |

## 12. Stages and order

| Stage | Delivers | Usable result |
|---|---|---|
| 0 | This architecture spec | — |
| 1 | Headless core, `king-louie-service`, OS installers, gateway auth fix | King Louie runs as a service on every OS |
| 2 | Identity, node config and policy, tiers, runbook engine, local stdio MCP | Claude Code on the laptop can call runbooks on its own machine |
| 3 | Approval protocol, mobile app, relay | Unsafe actions go to the phone and need its signature |
| 4 | Front door: TLS/SNI, OAuth AS, router, mesh hardening, audit mirror | Claude, ChatGPT and Perplexity drive the fleet |
| 5 | Session helper, `gui` capability, `LaunchApp`, computer use under leases (§4.6), phone lease view and kill switch | "Run Rhino on my Mac" works; the same request to a server fails cleanly |
| 6 | Reference runbooks and configs in `examples/`: web app pull/restart, server reboot, Hugging Face download, training run, laptop build-then-deploy. Plus an install guide | The worked examples in §8.4 run end to end on a fleet configured only from `examples/` |
| 7 | Electron app becomes a UI for the local service, with data-directory migration (Q6) | One King Louie per machine |

Each stage gets its own detailed spec section (or a child spec), then an
implementation plan, then its PRs. Everything here is agreed at the
architecture level; the detail inside each stage is still open for changes.

## 13. Resolved questions

- **Q1 (domain):** The front-door domain is configuration
  (`frontdoor.domain`). Two subdomains are derived from it: `mcp.<domain>` for
  clients and phones, and `mesh.<domain>` for nodes. Docs use
  `kl.example.com`. The front door may share a DNS zone with the owner's
  sites, but never a host (D6).
- **Q2 (mobile):** The owner uses both iOS and Android, so the app is **fully
  native**: Swift/SwiftUI on iOS and Kotlin/Jetpack Compose on Android. Both
  implement the same protocol (§6) and must pass the same shared test vectors.
  §6.5 is updated to match.
- **Q3 (delegate model):** The provider and model for `delegate` sessions are
  configured per node (`node.yaml` → `delegate.provider` / `delegate.model`,
  using the existing `src/providers/` routing and failover). **Each agent node
  keeps its own API keys** in its own `secrets`. Keys never pass through the
  front door.
- **Q4 (production pull/restart):** **Unsafe.** Anything that changes a
  production server's state is `unsafe`, so on runbook-profile nodes
  `routine` effectively means only non-mutating or trivially reversible
  actions. Compromising the front door can therefore never change production.
  The `site.pull_and_restart` example in §5.4 is `tier: unsafe`.
- **Q5 (Mac):** The Mac is an `agent` node. **Agent nodes can launch and
  control desktop GUI apps**. For example, "run Rhino on my Mac" is valid, but
  "run Rhino on my server" must fail, because a runbook node has no GUI
  capability and nothing that could launch one. See §4.6.
- **Q6 (Electron app):** The Electron app will eventually become a **UI for
  the local service** instead of running its own core. Stage 1 must not stand
  in the way of that (§4.2). The data-directory merge and migration become
  stage 7.
- **Process model on agent nodes:** a system service plus a session helper
  (§4.6).
- **GUI depth:** full computer use, under phone-signed, app-limited,
  time-limited leases (§4.6).
- **Delegation:** multi-turn, using `send_to_job` with an idle timeout (§8.2).
- **Local approvals:** sessions started in the desktop app keep the on-screen
  dialog. Only remote-origin work needs the phone (§3.1).
- **Servers manage themselves.** Each server runs its own runbooks (pull,
  build, restart, reboot). The laptop's SSH keys are only for break-glass
  access and for any host that can't run King Louie. A deploy that needs a
  build machine runs on the laptop and ends by calling the target server's
  runbook, not by SSH. Neither the laptop nor the servers need a
  remote-host runbook target.
- **Mobile distribution: public App Store and Google Play.** Consequences:
  - The app has **no hardcoded front door**. The owner pairs it with any
    front door by scanning a QR code, which carries the URL and a pinned
    key fingerprint. The app is useless until it is paired.
  - It needs a privacy policy. The app collects no analytics, and the only
    data it holds is the pairing state and its keys.
  - Store review needs a way for a reviewer to exercise the app. Provide a
    **demo mode** with a built-in fake fleet that never touches the network.
    Never give reviewers access to the real front door.
  - Push uses the owner's own APNs key and FCM project, configured on the
    front door.
