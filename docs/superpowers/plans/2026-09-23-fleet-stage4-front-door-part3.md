# Fleet Stage 4: Front door — Implementation Plan (Part 3 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the front door's transport and trust stores: the bounded ClientHello parser and the SNI listener, ACME with the stable `mcp.` key (and operator TLS), F3's relay mounted behind an external listener with the front door as its own node, the node registry with one link per node key, and the alert center.

**Architecture:** New modules under `src/frontdoor/tls/`, `src/frontdoor/router/node-registry.js`, `src/frontdoor/self-link.js`, `src/frontdoor/alerts.js`, `src/frontdoor/audit/own-ledger.js`, plus additive edits to F3's `relay.js` and `node-hub.js` and to `mesh-transport.js`. The one new npm dependency, `acme-client` (exactly 5.4.0), lands here with its lockfile test. Parts 1–2 must be on the branch.

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Node `net`/`tls`/`crypto`, `acme-client` 5.4.0 (pure JS). Test certificates are built in pure Node (`tests/helpers/test-certs.js`), never with openssl.

**Spec:** `docs/superpowers/specs/2026-09-23-fleet-stage4-front-door.md`. **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. **F3 spec (bound):** `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`.

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
  never decides policy. `node.yaml` rejects unknown keys and `service.json` rejects unknown `features.*` and
  `ports.*` keys, each with the key path named (R11, R55). Stages that add a feature
  also add it to the four example `service.json` files under `examples/`.
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

Fleet stage 4 spec constraints (exact values from the spec):

- F4 must not change F3's message shapes (program §4.13). Every approval-v1 shape, `normalizeOrigin`/`checkOrigin`, the `X-KL-*` phone auth and the 41 approval-v1 vectors stay byte-for-byte as they are.
- One public listener, `frontdoor.listen` (default `0.0.0.0:443`), routed by SNI to `mcp.<domain>` and `mesh.<domain>`; port 80 is never opened; ACME is TLS-ALPN-01 only (RFC 8737).
- The `mcp.` certificate key is ECDSA P-256, generated once, stored under `cipher.encryptString` in `<dataDir>/frontdoor/acme/cert-key.json` and reused for every renewal (R21). Renew when ⅓ of the lifetime remains; check every 12 h, at startup and on `SIGHUP`; failures back off 1 h, 2 h, 4 h, then every 12 h; the old certificate is served until a new one is issued.
- ClientHello peek: 16 KiB total and 5 s; sockets 1024 overall and 32 per IP; TLS handshake 10 s; first HTTP request within 60 s.
- OAuth: public clients only; PKCE `S256` only, `code_challenge` 43–128 characters; access token `kla_` + 32 random bytes b64url, 1 h (`access_token_ttl`, 5m–24h); refresh `klr_` + 32 random bytes b64url, 30 d idle (`refresh_token_idle_ttl`, 1d–365d), rotated on every use, one 30 s grace per rotation; authorization code 32 random bytes, single use, 60 s; every token and code is stored only as its SHA-256.
- Pending authorizations: memory, 10 min TTL on the front door's clock; 3 new per IP per 10 min; 1 per client host (newer replaces an older unclaimed one); 50 overall (oldest unclaimed evicted; claimed never evicted). `user_code` = 6 Crockford base32 characters shown `XXX-XXX`; cookie `kl_authz=<32 random bytes b64url>; HttpOnly; Secure; SameSite=Lax; Path=/oauth`. No push is ever sent for grants.
- Dynamic registration: `client_id` = `dcr_` + 22 b64url; 10 registrations per IP per hour; 100 clients without a grant; a client with no grant after 24 h is purged. CIMD fetches: `https:` port 443, no redirects, 5 s, 64 KiB, JSON, public resolved IP only (not loopback, private, link-local, CGNAT, ULA, multicast), connect to that IP, `client_id` equals the URL, cached 24 h.
- Consent page headers: `Content-Security-Policy: default-src 'none'; style-src 'self'; frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. OAuth bodies ≤ 64 KiB; `Host` must equal the SNI, else `421`.
- MCP Streamable HTTP: protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`; `Mcp-Session-Id` 128 random bits, at most 20 per grant; `Origin`, when present, must be `https://mcp.<domain>`; `GET /mcp` → `405`; long-poll `get_job` holds `frontdoor.mcp.progress_hold_s` (default 20, 0–55).
- Router: RPC timeout 30 s; 64 in flight per node and 256 overall (`frontdoor_busy`, `retry_after: 5`); `max_bytes` 512 KiB; `request_id` (UUIDv4) deduplicated for 10 min on the node; `JobCache` 2000 entries persisted every 60 s and at shutdown; public job id `<machine>:<nodeJobId>`.
- Mesh: `MAX_PAYLOAD_BYTES` 1 MiB; `PRE_AUTH_MAX_BYTES` 16 KiB; 256 pending RPCs per peer (`peer_busy`); `bufferedAmount` > 8 MiB closes `4029`; inbound 200 msgs/s, burst 400 (`4029`); `seenNonces` per peer, 10 000 entries; 64 unauthenticated sockets overall, 8 per IP; channel binding `exportKeyingMaterial(32, 'EXPORTER-king-louie-mesh-v1')`; envelope window 60 s on the front-door link; close codes `4001 unauthenticated`, `4003 key_removed`, `4009 already_connected`, `4010 replay_detected`, `4029 rate_limited`, `1009` frame too big. LAN pairing: 5 failed proofs lock pairing for 2 min (`pairing_locked`).
- Node link: `delay(n) = min(60 s, 1 s × 2^n) × uniform(0.5, 1.0)`, `n` resets after 5 min connected, at least 5 s after `4009`, 60 s after `frontdoor_key_mismatch` (logged at `error` at most once an hour); heartbeat 30 s, timeout 90 s.
- Delegate: `delegate.max_sessions` default 4 (1–16), `delegate.idle_close` default `2h` (5m–24h); a slot only while a turn runs; `send_to_job` during a turn → `node_busy` with `retry_after: 5`; transcript tool params ≤ 2 KiB and results ≤ 4 KiB, planner/workflow calls in full up to 256 KiB; evidence `editedPaths` ≤ 50.
- Alerts deduplicate on `kind + subject` within 24 h; at most 500 stored. Challenges: 2 min, single use, at most 20 live per device. `/pair/v1`: 10 requests per minute per IP. Pairing codes: F3's 6 words from `WORDLIST` with `randomInt`, 10 min, bound to the name, stored hashed, 5 attempts.
- Every file F4 writes is written atomically (temp + rename, mode 0600) with `writeFileAtomic` (`src/approvals/approver-store.js`).
- Phone-signed messages: F3 envelope, `alg: 'ES256'`, `kid` = `device_id`. Front-door-signed: `alg: 'Ed25519'`, `kid` = `frontdoor_id`. Arrays in signed messages are sorted and unique. Acceptance never judges `signed_at`/`created_at`; freshness comes from pending items and challenges held on the verifier's clock.
- The one new npm dependency is `acme-client`, pinned exactly (`5.4.0`, pure JS, ≥ 5.3 for `createAlpnCertificate`); a test asserts its installed lockfile tree has no install scripts and no native builds. `ws` carries the mesh; HTTP, TLS and crypto are Node built-ins; YAML is the existing `js-yaml`; JCS is `src/platform/jcs.js`.
- Every `node.yaml` key F4 reads comes from the admin `<configDir>`; `frontdoor` and `delegate` join `NODE_YAML_KEYS` (R11).
- Tests that touch an admin config dir inject `configDir` / `adminUid` (and `geteuid`), never the real per-platform dir. Tests that await unref'd timers call `holdEventLoop()` from `tests/helpers/hold-event-loop.js` (Node 22 on Linux). Fixtures use `example.com`, `kl.example.com`, `web-01`, `gpu-box` and the fixed test keys.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Five conditions the spec implies but no spec-listed test reaches, most likely first. Each line's test is added to the task that owns the code:

1. **A hostile self-declared `client_name`, client host or redirect on the consent page** (`<img src=x onerror=…>`, bidi or control characters): shown as inert escaped text, never markup; the CSP stays `default-src 'none'`. Test: `frontdoor-authorize › consent page escapes a hostile client_name` (Part 4, Task 22).
2. **The master key can no longer decrypt `acme/cert-key.json`** (a restored data dir, a re-created service account): the front door refuses to start and names the file; it never mints a new `mcp.` key, because every phone pins the old SPKI. Test: `frontdoor-acme › an undecryptable certificate key refuses to start and is never regenerated` (Part 3, Task 17).
3. **The front door restarts while clients are connected** (upgrade, reboot): grants and issued access/refresh tokens keep working; a consent flow in progress (memory only) ends with "expired, start again" rather than a page that polls forever. Tests: `frontdoor-tokens › tokens survive a restart` (Part 4, Task 24) and `frontdoor-authorize › the wait page needs the cookie; an unknown or expired request says to start again, without refresh` (Part 4, Task 22).
4. **Two phones type the same code** (the owner and a second enrolled phone): the first claim owns the request; the second phone gets `404 no_such_request`, and a decision signed by a device that did not claim it is refused (`not_claimant`). Tests: `frontdoor-grants › a second phone can neither claim nor decide a claimed request` (Part 4, Task 23), the same case end to end in `frontdoor-grant-abuse` (Task 25), and vector `grant-reject-not-claimant` (Part 1, Task 3).
5. **A single log or transcript line larger than `max_bytes`** (a job printing a 2 MB minified JSON line; a very long delegate reply): `get_job_logs` returns it cut with a `[line truncated: N bytes]` marker, `next_since` still advances, and no frame exceeds 1 MiB. Test: `fleet-node-service › an oversize line is cut and paging advances` (Part 2, Task 12).

## Interfaces from other stages

| Contract | On main 30cbe0a | This plan |
|---|---|---|
| F3 E1 `startRelay({ listeners: 'external' })` | exists; still asserts a private mesh host and reads TLS files | Task 18 adds `transport`, `phoneSpki`, `setPhoneSpki()` |
| F3 E2 `phoneApi.registerRoute` | exists (`device`/`none`/`code`/`invite`; a later registration replaces) | used as is |
| F3 E3 `NodeHub({ peerSource })`, `rpc`, `onNodeMessage`, `onConnection` | exists | Task 18 adds `attachLocalNode`; Task 19 is the peer source |
| F3 E4 `pusher.notify(device, { kind })` | exists (`KINDS` has `grant`, `pairing`, `alert`) | used as is |
| F3 E5 `relayClient.registerMethod/notify` | exists; refuses F3 names, `mesh.task.*`, `mesh.channel.*` | used by `NodeFleetService` (Task 12) |
| F3 E6 `FileCourier.call`, `CourierPump({ rpcHandler })` | exists; `call` needs `link.json` | Task 13 adds `callService()`, `setRpcHandler()` |
| F3 E7 `front-door.json` + `connectPinned` | feature-detected; raw file passed | Tasks 7 and 14 finish it |
| F3 E8 re-bindable `POST /v1/pairing-codes` | exists | Task 28 re-binds it |
| F3 E9 `audit.slice { max_bytes }`, `audit.head`, `kl.audit.slice.head`, `verifyAuditSlice` | exists | Task 29 consumes |
| F3 `src/frontdoor/extensions.js` | exists, empty | untouched (F4 owns its relay instance directly) |
| F6 `NODE_YAML_KEYS`, `tests/examples.test.js`, `examples/fleet/frontdoor/README.md` | exists | Task 5 |
| F7 desktop bridge (`PROXIED_DOMAINS`, allowlist test, `RENDERER_EVENTS`) | exists | untouched (Deviation 17) |
| F5 `core.context.getGuiBroker()`, `readGuiStatus({ dataDir })`, `LeaseManager.endForJob` | not merged | feature-detected (Tasks 9 and 11); absent → no `gui` block, no `endForJob` call |
| C7 `registerFrontDoorCaseTools` / `registerNodeCaseMethods` | not merged | F4 produces `ScopeRegistry.register` (Task 4), `NodeFleetService.registerMethod` (Task 12), `FleetRouter.registerTool` (Task 27) |

## Deviations (current code vs the spec, resolved from the spec's intent)

1. **Handler home.** `FleetToolHandler`, `MCP_TOOLS`, `ToolError`, `untrustedOutput` live in `src/fleet/fleet-tools.js`, not `src/mcp/fleet-tools.js`: the runbook profile hosts the handler (§3.7) and `tests/service-profile-graph.test.js` forbids all of `src/mcp/` there; `src/mcp/stdio-server.js` imports them from `src/fleet/`.
2. **E1 as merged.** `startRelay({ listeners: 'external' })` still asserts a private mesh host and reads `relay.tls` files; F4 adds `transport` and `phoneSpki` options plus `setPhoneSpki()` and skips both for `'external'`, where the mesh is pinned in TLS (§3.2).
3. **The front door as its own node (E3).** `NodeHub.attachLocalNode({ nodeId, nodeName, publicKeyHex, dispatch })` lets F3's console enrollment (`enroll.open/claim/done`), device staging and `/v1/nodes/{frontdoor_id}/history` serve the front door with F3's unchanged shapes (§3.11: "the front door serves it from its own `invites.js`").
4. **Courier RPC (E6).** `FileCourier.call` requires a paired relay (`link.json`); fleet RPCs need only a running service: `FileCourier.callService()`, `CourierPump.setRpcHandler()`, and `startFleetNode` starts a pump when `startApprovals` did not.
5. **Front-door pin (E7).** F3's `RelayClient` hands the raw file to `connectPinned` and still needs the `approvals.relay` store pin; F4 derives the relay pin from `front-door.json` (read with `assertAdminOwned`) and calls `connectPinned({ url, pinnedFingerprint, frontdoorId, servername })`. F3's test that pinned the raw file is updated to the real shape.
6. **`get_job` field names.** The stdio shape carries output as `output` (the untrusted wrapper), not `logs`: `fleet.get_job` returns raw `logs` (tail ≤ 64 KiB) and `logs_truncated`; `fleet.get_job_logs` returns `{ job_id, status, total_lines, lines, next_since, more }`; the front door wraps both into `output`.
7. **Scope-gate plumbing.** The approval seam wraps `classifyCall` as §3.8 says; the flag also rides on `ToolExecutor` (`refuseUnsafe`) and its re-threaded requester so a delegate's sub-agents inherit it, and a denied tier decision may carry the refusal `message`.
8. **`relay.*` on the frontdoor profile.** `parseRelayConfig` demands `relay.tls`/`public_url`; for `profile: frontdoor`, `loadServiceConfig` keeps the raw block (`relayRaw`) and startup check 4 applies §3.1's refusals in order, then `parsePushConfig` (extracted from `parseRelayConfig`) reads `relay.push`.
9. **Startup-check order.** `parseFrontDoorConfig` (called by `loadNodeConfig`) checks key names, types and ranges only; the domain (#2) and TLS-source (#3) refusals run in `runStartupChecks` after #1, so the first failing check of §3.1's table is the one reported.
10. **`delegate.provider` validation.** `node-config.js` loads on the runbook profile and must not require `src/providers`; the provider name is checked when an agent node builds `DelegateSessions` (Task 11), which refuses to start with the same `Invalid <file>:` wording.
11. **Standalone `delegate` text.** `capability_unavailable: delegate needs the King Louie service running on this node (not implemented in a standalone mcp process)`, so `tests/mcp-stdio.test.js` stays unmodified (it matches `/not implemented/`).
12. **Approval origin of delegate turns.** F3's `checkOrigin` allows exactly `{ client, session, job_id }` with strings ≤ 200 code points; `client` is the front door's `client_name` cut to 200, `session` the MCP session id, `job_id` the node job id.
13. **Who acts at the front door.** F3's relay routes accept a device active on any node; F4's own routes require an active approver in the front door's `ApproverStore` (R25), and `pairing`/`alert` pushes go to those approvers that have a push token in the relay's device registry.
14. **Delegate job slots.** `JobManager` gains `createDelegateJob()` and `beginTurn()`/`endTurn()`: a delegate job stays `running` while open but counts toward `max_concurrent_jobs` only during a turn (§3.8).
15. **Service mode and mesh modules.** `create-core.js` requires `src/mesh` statically; instead of a second create-core hunk, `src/mesh/index.js` loads `MeshDiscovery`, `MeshSwarm`, `MeshRemoteControl` and `MeshChannel` lazily, so no service profile loads them (§3.10 items 5–6).
16. **Examples.** `examples/fleet/frontdoor/{node.yaml,service.json}` land and the pinned "arrives with fleet stage 4" assertion flips. F4 adds no `features.*`/`ports.*` key, so the four other example `service.json` files and `DEFAULT_FEATURES`/`DEFAULT_PORTS` are unchanged. The example omits `acme.email` and `acme.directory` because the example denylist refuses every email address and every non-example host.
17. **No desktop-bridge change.** F4 adds no IPC domain or renderer event (fleet UI is F7's); `PROXIED_DOMAINS`, `tests/desktop-bridge-allowlist.test.js` and `RENDERER_EVENTS` are untouched.
18. **Machine names in `machines=`** follow §3.4's `^[a-z0-9][a-z0-9._-]{0,62}$`; a node whose name has capitals can only be granted without a `machines=` limit, and the phone greys out that toggle.
19. **ACME self-check.** `acme-client`'s `auto()` runs with `skipChallengeVerification: true`: its pre-check would dial the front door's own ALPN responder, which is what the CA does next anyway.
20. **Vectors.** `client-grant-v1` has its own directory and generator, reads `../approval-v1/keys.json` by path, and adds nothing to `approval-v1` (still 41 vectors; both phone cores keep their exact approval-v1 sets and gain separate exact client-grant-v1 sets). `grant-reject-not-claimant` pins Review Focus 4.
21. **`front_door` in `node.yaml`** (F2's commented example key) stays unread; a node's front-door pin is `<configDir>/front-door.json` only.
22. **Where evidence lives.** §3.7 says `job.result.evidence`; a failed runbook's `job.result` is its error string and a delegate job's is the assistant's reply, so evidence is stored beside it as `job.evidence` and `get_job` returns it as `evidence` exactly as §3.7 shapes it.
23. **"Planner and workflow tool calls"** (§3.8) are named, not inferred: `FULL_TRANSCRIPT_TOOLS = ['SpawnAgent', 'BackgroundTask', 'TaskStatus']`, the tools that start or report task graphs today; `DelegateSessions` takes the list as an option so a new planner tool is one line.
24. **Pin file mode.** §4.8 does not give a mode; `front-door.json` holds no secret and the service account must read it, so `pair` writes it 0644 in the admin-owned config directory, and `readPin` refuses it when `assertAdminOwned` fails, as for `node.yaml`.
25. **Where "one connection per node key" is enforced.** §3.6 puts the ping-the-old-link rule in the registry; the second authenticated connection first appears in `MeshTransport`, so the transport runs it (`duplicatePingMs`, which the front door sets to 5000; unset, the old behaviour stays) and `NodeRegistry` only records presence (`markOnline(nodeId, hello) → { bootChanged }`, `markOffline`), since by then the transport has already kept one link.
26. **`client_id` in the pending reply.** §4.9's `GET /v1/grants/pending` reply lacks `client_id`, but the phone must sign it (§4.2 byte-equality with the pending authorization); the reply adds `client_id`, and `client-grant-v1.md` §7 lists it.
27. **The pending-pairing reply** (§4.9) lacks `public_key` and `tls_fingerprint`, which the phone signs in `kl.node.enroll` (§4.3) and the front door checks byte for byte; `GET /v1/pairings/pending` adds both, and `client-grant-v1.md` §7 lists them.
28. **Mirror paging direction.** §3.12 pages backwards from the node head until it overlaps the mirror; F3's ledger already ships the mirror's form, `audit.slice { after: <hash> }` (oldest first, and from the oldest retained entry when the hash is unknown), so the mirror pages forward from its own head. The outcomes are §3.12's: a page that continues the head appends, one that starts past `head + 1` is a gap, one that does not continue it is a fork, and a first sync above `seq 1` records the anchor.
29. **What `doctor` verifies itself.** §3.14's "registry and grant signatures verify" and "no unacknowledged breaks" are read from the service's own results (`alerts.json`: unacknowledged `node_record_invalid`, `audit_chain_break`, `audit_gap`), since the service re-verifies both stores on every load and quarantines what fails; re-verifying from the admin CLI would either write the service's quarantine file or keep a second copy of its rules.
30. **Android fetches on tap.** §3.13 has the app poll pairings every 5 s while the Nodes screen is open and read alerts on every open. On Android every device-signed request is a biometric prompt (F3's key parameters), so there the owner taps to fetch (and a tapped `pairing` or `alert` push fetches its list); iOS, whose session signing does not prompt per request, polls as §3.13 says.

## Owner questions

None. Every open point above is resolved from the spec's intent; the spec's own §12 assumptions are kept as written.

---

### Task 15: A bounded ClientHello parser and peek

**Files:**
- Create: `src/frontdoor/tls/client-hello.js`
- Test: `tests/frontdoor-client-hello.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (`src/frontdoor/tls/client-hello.js`):
  - `class ClientHelloError extends Error` (`code: 'malformed'`).
  - `MAX_HELLO_BYTES = 16384`, `HELLO_TIMEOUT_MS = 5000`.
  - `parseClientHello(buf) → { incomplete: true } | { serverName: string | null, alpn: string[] }` — reassembles a handshake split across TLS records, walks record headers, the handshake header, and extensions 0 (`server_name`) and 16 (ALPN); every length is bounds-checked; throws `ClientHelloError` on anything malformed and never any other error. `serverName` is lower-cased ASCII.
  - `peekClientHello(socket, { maxBytes = MAX_HELLO_BYTES, timeoutMs = HELLO_TIMEOUT_MS }) → Promise<{ hello, buffer }>` — accumulates `data` until the hello parses, then `pause()`s, removes its listener and `unshift(buffer)`s so a `TLSSocket` wrapped around `socket` reads the hello again; rejects (without destroying — the caller does) past `maxBytes` or `timeoutMs`, on a parse error, or on `close`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-client-hello.test.js`:

```js
// tests/frontdoor-client-hello.test.js — fleet stage 4 §3.2.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { parseClientHello, peekClientHello, ClientHelloError, MAX_HELLO_BYTES } = require('../src/frontdoor/tls/client-hello');

// The first flight a real Node TLS client sends.
async function captureHello({ servername = 'mcp.kl.example.com', alpn = ['acme-tls/1', 'http/1.1'] } = {}) {
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on('data', (d) => {
      chunks.push(d);
      const r = parseClientHello(Buffer.concat(chunks));
      if (!r.incomplete) socket.destroy();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, ALPNProtocols: alpn, rejectUnauthorized: false });
  client.on('error', () => {});
  await new Promise((r) => client.once('close', r));
  server.close();
  return Buffer.concat(chunks);
}

// The same handshake message re-framed across `parts` TLS records.
function reframe(hello, parts) {
  const handshake = [];
  for (let off = 0; off < hello.length;) {
    const len = hello.readUInt16BE(off + 3);
    handshake.push(hello.subarray(off + 5, off + 5 + len));
    off += 5 + len;
  }
  const body = Buffer.concat(handshake);
  const size = Math.ceil(body.length / parts);
  const out = [];
  for (let i = 0; i < body.length; i += size) {
    const frag = body.subarray(i, i + size);
    const header = Buffer.from([0x16, 0x03, 0x01, 0, 0]);
    header.writeUInt16BE(frag.length, 3);
    out.push(header, frag);
  }
  return Buffer.concat(out);
}

let hello;
before(async () => { hello = await captureHello(); });

describe('parseClientHello', () => {
  it('reads SNI and ALPN from a real hello', () => {
    assert.deepEqual(parseClientHello(hello), { serverName: 'mcp.kl.example.com', alpn: ['acme-tls/1', 'http/1.1'] });
  });

  it('a hello with no SNI parses with serverName null', async () => {
    const noSni = await captureHello({ servername: '' });
    assert.equal(parseClientHello(noSni).serverName, null);
  });

  it('reassembles a hello split across three records', () => {
    assert.deepEqual(parseClientHello(reframe(hello, 3)), { serverName: 'mcp.kl.example.com', alpn: ['acme-tls/1', 'http/1.1'] });
  });

  it('says incomplete for every proper prefix', () => {
    for (let n = 0; n < hello.length; n += 7) assert.deepEqual(parseClientHello(hello.subarray(0, n)), { incomplete: true }, `prefix ${n}`);
  });

  it('refuses a record that is not a handshake, bad lengths, and anything over 16 KiB', () => {
    const notHandshake = Buffer.from(hello);
    notHandshake[0] = 0x17;
    assert.throws(() => parseClientHello(notHandshake), ClientHelloError);
    const badSni = Buffer.from(hello);
    const idx = badSni.indexOf(Buffer.from('mcp.kl.example.com'));
    badSni.writeUInt16BE(0xffff, idx - 2);
    assert.throws(() => parseClientHello(badSni), ClientHelloError);
    const huge = Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01, 0x01, 0x00, 0x40, 0x00]);
    assert.throws(() => parseClientHello(huge), ClientHelloError);
  });

  it('survives 10 000 mutations: a result, incomplete, or ClientHelloError — nothing else', () => {
    const rand = (n) => crypto.randomInt(n);
    for (let i = 0; i < 10000; i += 1) {
      let m = Buffer.from(i % 2 ? hello : reframe(hello, 1 + rand(4)));
      const ops = 1 + rand(4);
      for (let k = 0; k < ops; k += 1) {
        const op = rand(4);
        const at = rand(m.length || 1);
        if (op === 0 && m.length) m[at] = rand(256);
        else if (op === 1) m = m.subarray(0, at);
        else if (op === 2) m = Buffer.concat([m.subarray(0, at), crypto.randomBytes(1 + rand(8)), m.subarray(at)]);
        else if (m.length > 4) m.writeUInt16BE(rand(65536), Math.min(at, m.length - 2));
      }
      try {
        const r = parseClientHello(m);
        assert.ok(r.incomplete === true || Array.isArray(r.alpn));
      } catch (err) {
        assert.ok(err instanceof ClientHelloError, `mutation ${i}: ${err && err.stack}`);
      }
    }
  });
});

describe('peekClientHello', () => {
  async function pair() {
    let serverSide;
    const server = net.createServer((s) => { serverSide = s; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = net.connect(server.address().port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    while (!serverSide) await new Promise((r) => setImmediate(r));
    return { server, client, serverSide };
  }

  it('reads a hello that arrives in many TCP chunks and puts every byte back', async () => {
    const { server, client, serverSide } = await pair();
    const peeked = peekClientHello(serverSide, { timeoutMs: 2000 });
    for (let i = 0; i < hello.length; i += 50) {
      client.write(hello.subarray(i, i + 50));
      await new Promise((r) => setTimeout(r, 2));
    }
    const { hello: parsed, buffer } = await peeked;
    assert.equal(parsed.serverName, 'mcp.kl.example.com');
    assert.deepEqual(buffer, hello);
    const again = [];
    serverSide.on('data', (d) => again.push(d));
    serverSide.resume();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(Buffer.concat(again), hello, 'unshift gives the next reader the same bytes');
    client.destroy();
    server.close();
  });

  it('gives up after the timeout and past 16 KiB', async () => {
    const a = await pair();
    await assert.rejects(peekClientHello(a.serverSide, { timeoutMs: 50 }), /timed out/);
    a.client.destroy();
    a.server.close();
    const b = await pair();
    const p = peekClientHello(b.serverSide, { timeoutMs: 2000 });
    const endless = Buffer.from([0x16, 0x03, 0x01, 0x3f, 0xff, 0x01, 0x00, 0x3f, 0xfb]);
    b.client.write(Buffer.concat([endless, Buffer.alloc(MAX_HELLO_BYTES)]));
    await assert.rejects(p, /16384|malformed/);
    b.client.destroy();
    b.server.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-client-hello.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/tls/client-hello'`.

- [ ] **Step 3: Write `src/frontdoor/tls/client-hello.js`**

```js
// Reads SNI and ALPN out of a TLS ClientHello before anything answers it
// (fleet stage 4 §3.2), so the front door can pick a TLS setup per name: a
// server-wide requestCert would make browsers visiting mcp. show a client
// certificate picker. This parser faces the internet: every length is
// checked against what is actually there, the total is capped at 16 KiB,
// and anything malformed is a ClientHelloError — never another exception.
const MAX_HELLO_BYTES = 16384;
const HELLO_TIMEOUT_MS = 5000;
const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const EXT_ALPN = 0x0010;

class ClientHelloError extends Error {
  constructor(message) {
    super(`malformed ClientHello: ${message}`);
    this.name = 'ClientHelloError';
    this.code = 'malformed';
  }
}

const bad = (message) => { throw new ClientHelloError(message); };

// A cursor that refuses to read past its end.
function reader(buf, start, end) {
  let pos = start;
  const need = (n) => { if (n < 0 || pos + n > end) bad(`length ${n} runs past the data`); };
  return {
    get pos() { return pos; },
    get left() { return end - pos; },
    u8() { need(1); return buf[pos++]; },
    u16() { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; },
    u24() { need(3); const v = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2]; pos += 3; return v; },
    bytes(n) { need(n); const v = buf.subarray(pos, pos + n); pos += n; return v; },
    skip(n) { need(n); pos += n; }
  };
}

// The handshake bytes from as many whole records as `buf` holds; null when a
// record header or body is not all there yet.
function handshakeBytes(buf) {
  const parts = [];
  let off = 0;
  let total = 0;
  while (off < buf.length) {
    if (buf.length - off < 5) return { bytes: Buffer.concat(parts), complete: false };
    if (buf[off] !== RECORD_HANDSHAKE) bad(`record type ${buf[off]} is not a handshake`);
    if (buf[off + 1] !== 0x03) bad('record version is not TLS');
    const len = buf.readUInt16BE(off + 3);
    if (len === 0 || len > MAX_HELLO_BYTES) bad(`record length ${len}`);
    if (buf.length - off - 5 < len) return { bytes: Buffer.concat([...parts, buf.subarray(off + 5)]), complete: false };
    parts.push(buf.subarray(off + 5, off + 5 + len));
    total += len;
    if (total > MAX_HELLO_BYTES) bad('handshake over 16 KiB');
    off += 5 + len;
  }
  return { bytes: Buffer.concat(parts), complete: true };
}

function parseServerName(data) {
  const r = reader(data, 0, data.length);
  const listLen = r.u16();
  if (listLen !== r.left) bad('server_name list length');
  let name = null;
  while (r.left > 0) {
    const type = r.u8();
    const len = r.u16();
    const value = r.bytes(len);
    if (type === 0) {
      if (name !== null) bad('two host names');
      if (len === 0 || len > 255) bad('host name length');
      for (const b of value) if (b < 0x21 || b > 0x7e) bad('host name is not printable ASCII');
      name = value.toString('ascii').toLowerCase();
    }
  }
  return name;
}

function parseAlpn(data) {
  const r = reader(data, 0, data.length);
  const listLen = r.u16();
  if (listLen !== r.left || listLen === 0) bad('ALPN list length');
  const out = [];
  while (r.left > 0) {
    const len = r.u8();
    if (len === 0) bad('empty ALPN protocol');
    const value = r.bytes(len);
    for (const b of value) if (b < 0x20 || b > 0x7e) bad('ALPN protocol is not printable');
    out.push(value.toString('ascii'));
  }
  return out;
}

function parseClientHello(buf) {
  if (!Buffer.isBuffer(buf)) bad('not a buffer');
  if (buf.length > MAX_HELLO_BYTES + 5 * 8) bad('over 16 KiB');
  const { bytes, complete } = handshakeBytes(buf);
  if (bytes.length < 4) return { incomplete: true };
  if (bytes[0] !== HANDSHAKE_CLIENT_HELLO) bad(`handshake type ${bytes[0]} is not a ClientHello`);
  const bodyLen = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (bodyLen < 38 || bodyLen > MAX_HELLO_BYTES) bad(`ClientHello length ${bodyLen}`);
  if (bytes.length < 4 + bodyLen) {
    if (complete && buf.length >= MAX_HELLO_BYTES) bad('over 16 KiB');
    return { incomplete: true };
  }
  const r = reader(bytes, 4, 4 + bodyLen);
  r.skip(2); // legacy_version
  r.skip(32); // random
  const sessionIdLen = r.u8();
  if (sessionIdLen > 32) bad('session id length');
  r.skip(sessionIdLen);
  const suitesLen = r.u16();
  if (suitesLen < 2 || suitesLen % 2 !== 0) bad('cipher suites length');
  r.skip(suitesLen);
  const compLen = r.u8();
  if (compLen < 1) bad('compression methods length');
  r.skip(compLen);
  let serverName = null;
  let alpn = [];
  if (r.left > 0) {
    const extLen = r.u16();
    if (extLen !== r.left) bad('extensions length');
    const seen = new Set();
    while (r.left > 0) {
      const type = r.u16();
      const len = r.u16();
      const data = r.bytes(len);
      if (seen.has(type)) bad(`extension ${type} twice`);
      seen.add(type);
      if (type === EXT_SERVER_NAME) serverName = parseServerName(data);
      else if (type === EXT_ALPN) alpn = parseAlpn(data);
    }
  }
  return { serverName, alpn };
}

function peekClientHello(socket, { maxBytes = MAX_HELLO_BYTES, timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onClose);
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        finish(new ClientHelloError(`over ${maxBytes} bytes`));
        return;
      }
      let result;
      try {
        result = parseClientHello(Buffer.concat(chunks));
      } catch (err) {
        finish(err);
        return;
      }
      if (result.incomplete) return;
      const buffer = Buffer.concat(chunks);
      socket.pause();
      socket.removeListener('data', onData);
      socket.unshift(buffer);
      finish(null, { hello: result, buffer });
    };
    const onClose = () => finish(new Error('closed before a ClientHello arrived'));
    const timer = setTimeout(() => finish(new Error(`ClientHello timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
  });
}

module.exports = { parseClientHello, peekClientHello, ClientHelloError, MAX_HELLO_BYTES, HELLO_TIMEOUT_MS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/frontdoor-client-hello.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/tls/client-hello.js tests/frontdoor-client-hello.test.js
git commit -m "feat(frontdoor): bounded ClientHello parser and peek" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Test certificates and the SNI listener

**Files:**
- Create: `tests/helpers/test-certs.js`
- Create: `src/frontdoor/tls/sni-listener.js`
- Test: `tests/frontdoor-sni.test.js`

**Interfaces:**
- Consumes: Task 15 `peekClientHello`; Task 7 `peerCertFingerprint`.
- Produces:
  - `tests/helpers/test-certs.js` (pure Node, no openssl): `createCa({ commonName = 'King Louie Test CA' }) → { cert, key }`, `issueCert(ca, { dnsNames, commonName, keyPem = null, notBefore = Date.now() - 86400000, notAfter = Date.now() + 90 * 86400000 }) → { cert, key }` (P-256, SAN dNSName, signed by the CA), `selfSigned({ commonName, days = 30 }) → { cert, key }`, `fingerprint(certPem) → hex`.
  - `class SniListener({ host, port, domain, mcpContext: () => SecureContext | null, meshContext: SecureContext, isPinnedNodeCert(fp), isProbeCert(fp), acmeChallenge(servername) → SecureContext | null, onMcpSocket(tls), onMeshSocket(tls), onUnknownNodeKey({ fingerprint, ip }) = () => {}, limits = {} })` with `start() → Promise<void>` (rejects `cannot bind <host>:<port>: <err>`), `address()`, `stop() → Promise<void>`. `limits` defaults: `{ maxSockets: 1024, perIp: 32, helloBytes: 16384, helloTimeoutMs: 5000, handshakeMs: 10000, firstRequestMs: 60000 }`.

- [ ] **Step 1: Write the test-certificate helper**

Create `tests/helpers/test-certs.js`:

```js
// tests/helpers/test-certs.js
//
// X.509 certificates built at runtime in pure Node (no openssl): a test CA,
// leaves with a DNS subjectAltName signed by it (for WebPKI checks with an
// injected `ca`), and self-signed P-256 certificates. Test use only.
const crypto = require('crypto');

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tag = (t, body) => Buffer.concat([Buffer.from([t]), len(body.length), body]);
const seq = (...items) => tag(0x30, Buffer.concat(items));
const set = (...items) => tag(0x31, Buffer.concat(items));
const oid = (hex) => Buffer.from(hex, 'hex');
const int = (buf) => tag(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = (s) => tag(0x0c, Buffer.from(s, 'utf8'));
const octet = (buf) => tag(0x04, buf);
const bits = (buf) => tag(0x03, Buffer.concat([Buffer.from([0]), buf]));
const explicit = (n, body) => tag(0xa0 + n, body);

const OID = {
  ecdsaSha256: oid('06082a8648ce3d040302'),
  commonName: oid('0603550403'),
  subjectAltName: oid('0603551d11'),
  basicConstraints: oid('0603551d13'),
  keyUsage: oid('0603551d0f')
};

function utcTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return tag(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}

const name = (cn) => seq(set(seq(OID.commonName, utf8(cn))));
const extension = (id, critical, value) => seq(id, ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), octet(value));

function pem(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function build({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const sigAlg = seq(OID.ecdsaSha256);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serial),
    sigAlg,
    name(issuer),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions))
  );
  const sig = crypto.sign('sha256', tbs, signingKey);
  return pem(seq(tbs, sigAlg, bits(sig)), 'CERTIFICATE');
}

function newKey(keyPem = null) {
  const privateKey = keyPem ? crypto.createPrivateKey(keyPem) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  return { privateKey, publicKey: crypto.createPublicKey(privateKey), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function createCa({ commonName = 'King Louie Test CA' } = {}) {
  const k = newKey();
  const now = Date.now();
  const cert = build({
    subject: commonName, issuer: commonName, publicKey: k.publicKey, signingKey: k.privateKey,
    notBefore: now - 86400000, notAfter: now + 3650 * 86400000,
    extensions: [
      extension(OID.basicConstraints, true, seq(Buffer.from([0x01, 0x01, 0xff]))),
      extension(OID.keyUsage, true, tag(0x03, Buffer.from([0x01, 0x06])))
    ]
  });
  return { cert, key: k.pem, commonName, privateKey: k.privateKey };
}

function issueCert(ca, { dnsNames, commonName = dnsNames[0], keyPem = null, notBefore = Date.now() - 86400000, notAfter = Date.now() + 90 * 86400000 }) {
  const k = newKey(keyPem);
  const san = seq(...dnsNames.map((n) => tag(0x82, Buffer.from(n, 'ascii'))));
  const cert = build({
    subject: commonName, issuer: ca.commonName, publicKey: k.publicKey, signingKey: ca.privateKey || crypto.createPrivateKey(ca.key),
    notBefore, notAfter,
    extensions: [extension(OID.subjectAltName, false, san), extension(OID.keyUsage, true, tag(0x03, Buffer.from([0x07, 0x80])))]
  });
  return { cert, key: k.pem };
}

function selfSigned({ commonName = 'kl-test', days = 30 } = {}) {
  const k = newKey();
  const now = Date.now();
  const cert = build({ subject: commonName, issuer: commonName, publicKey: k.publicKey, signingKey: k.privateKey, notBefore: now - 86400000, notAfter: now + days * 86400000, extensions: [] });
  return { cert, key: k.pem };
}

function fingerprint(certPem) {
  return crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
}

module.exports = { createCa, issueCert, selfSigned, fingerprint };
```

(`explicit(3, seq())` with no extensions is still a valid, empty `[3]`; `selfSigned` passes `extensions: []`.)

- [ ] **Step 2: Write the failing test**

Create `tests/frontdoor-sni.test.js`:

```js
// tests/frontdoor-sni.test.js — fleet stage 4 §3.2.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const { SniListener } = require('../src/frontdoor/tls/sni-listener');
const { createCa, issueCert, selfSigned, fingerprint } = require('./helpers/test-certs');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const DOMAIN = 'kl.example.com';
const ca = createCa();
const mcp = issueCert(ca, { dnsNames: [`mcp.${DOMAIN}`] });
const meshId = selfSigned({ commonName: 'frontdoor' });
const pinnedNode = selfSigned({ commonName: 'gpu-box' });
const strangerNode = selfSigned({ commonName: 'stranger' });
const probe = selfSigned({ commonName: 'probe' });

const listeners = [];
afterEach(async () => { while (listeners.length) await listeners.pop().stop(); });

async function start(overrides = {}) {
  const seen = { mcp: [], mesh: [], unknown: [], acme: [] };
  const l = new SniListener({
    host: '127.0.0.1', port: 0, domain: DOMAIN,
    mcpContext: () => tls.createSecureContext({ cert: mcp.cert, key: mcp.key }),
    meshContext: tls.createSecureContext({ cert: meshId.cert, key: meshId.key }),
    isPinnedNodeCert: (fp) => fp === fingerprint(pinnedNode.cert),
    isProbeCert: (fp) => fp === fingerprint(probe.cert),
    acmeChallenge: () => null,
    onMcpSocket: (s) => { seen.mcp.push(s); s.end('HTTP/1.1 204 No Content\r\n\r\n'); },
    onMeshSocket: (s) => { seen.mesh.push(s); s.end(); },
    onUnknownNodeKey: (e) => seen.unknown.push(e),
    ...overrides
  });
  await l.start();
  listeners.push(l);
  return { l, seen, port: l.address().port };
}

function connect(port, options) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options });
    const out = { socket: s, secure: false, closed: false, alpn: null, peer: null };
    s.once('secureConnect', () => { out.secure = true; out.alpn = s.alpnProtocol; out.peer = s.getPeerX509Certificate(); });
    s.on('data', () => {});
    s.on('error', () => {});
    s.once('close', () => { out.closed = true; resolve(out); });
  });
}

describe('SniListener', () => {
  it('mcp. gets the web certificate, never asks for a client certificate, and reaches onMcpSocket', async () => {
    const { seen, port } = await start();
    const r = await connect(port, { servername: `mcp.${DOMAIN}`, ca: ca.cert, rejectUnauthorized: true, cert: pinnedNode.cert, key: pinnedNode.key });
    assert.equal(r.secure, true);
    assert.equal(seen.mcp.length, 1);
    assert.equal(seen.mcp[0].getPeerCertificate() && seen.mcp[0].getPeerCertificate().raw, undefined, 'mcp. never requested a client certificate');
  });

  it('mesh. hands a pinned node to onMeshSocket; unpinned or missing certificates are destroyed and counted', async () => {
    const { seen, port } = await start();
    await connect(port, { servername: `mesh.${DOMAIN}`, cert: pinnedNode.cert, key: pinnedNode.key });
    assert.equal(seen.mesh.length, 1);
    await connect(port, { servername: `mesh.${DOMAIN}`, cert: strangerNode.cert, key: strangerNode.key });
    await connect(port, { servername: `mesh.${DOMAIN}` });
    assert.equal(seen.mesh.length, 1);
    assert.equal(seen.unknown.length, 2);
    assert.equal(seen.unknown[0].fingerprint, fingerprint(strangerNode.cert));
    assert.equal(seen.unknown[1].fingerprint, null);
  });

  it('the probe certificate is closed right after the handshake and never reaches the mesh', async () => {
    const { seen, port } = await start();
    const r = await connect(port, { servername: `mesh.${DOMAIN}`, cert: probe.cert, key: probe.key });
    assert.equal(r.secure, true);
    assert.equal(fingerprint(`-----BEGIN CERTIFICATE-----\n${r.peer.raw.toString('base64')}\n-----END CERTIFICATE-----\n`), fingerprint(meshId.cert));
    assert.equal(seen.mesh.length, 0);
    assert.equal(seen.unknown.length, 0);
  });

  it('acme-tls/1 on mcp. is answered with the challenge certificate', async () => {
    const challenge = selfSigned({ commonName: `mcp.${DOMAIN}` });
    const { seen, port } = await start({ acmeChallenge: (name) => (name === `mcp.${DOMAIN}` ? tls.createSecureContext({ cert: challenge.cert, key: challenge.key }) : null) });
    const r = await connect(port, { servername: `mcp.${DOMAIN}`, ALPNProtocols: ['acme-tls/1'] });
    assert.equal(r.alpn, 'acme-tls/1');
    assert.equal(r.peer.fingerprint256.replace(/:/g, '').toLowerCase(), fingerprint(challenge.cert));
    assert.equal(seen.mcp.length, 0);
  });

  it('first boot (no certificate yet) and unknown names are destroyed', async () => {
    const { seen, port } = await start({ mcpContext: () => null });
    assert.equal((await connect(port, { servername: `mcp.${DOMAIN}` })).secure, false);
    assert.equal((await connect(port, { servername: `www.${DOMAIN}` })).secure, false);
    assert.equal((await connect(port, {})).secure, false);
    assert.equal(seen.mcp.length, 0);
  });

  it('closes a socket that sends no ClientHello in time, and caps sockets per IP', async () => {
    const { port } = await start({ limits: { helloTimeoutMs: 100, perIp: 2 } });
    const quiet = net.connect(port, '127.0.0.1');
    const closed = new Promise((r) => quiet.once('close', r));
    quiet.on('error', () => {});
    const extra = [net.connect(port, '127.0.0.1'), net.connect(port, '127.0.0.1')];
    for (const s of extra) s.on('error', () => {});
    const third = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); s.once('close', () => r(true)); });
    assert.equal(third, true);
    await closed;
    for (const s of extra) s.destroy();
  });

  it('refuses to start on a busy port with the exact message', async () => {
    const { port } = await start();
    const second = new SniListener({ host: '127.0.0.1', port, domain: DOMAIN, mcpContext: () => null, meshContext: null, isPinnedNodeCert: () => false, isProbeCert: () => false, acmeChallenge: () => null, onMcpSocket() {}, onMeshSocket() {} });
    await assert.rejects(second.start(), new RegExp(`^Error: cannot bind 127\\.0\\.0\\.1:${port}: `));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/frontdoor-sni.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/tls/sni-listener'`.

- [ ] **Step 4: Write `src/frontdoor/tls/sni-listener.js`**

```js
// The front door's one public listener (fleet stage 4 §3.2). It reads the
// ClientHello before answering, then wraps the socket in the TLS setup its
// name needs: the web certificate for mcp. (never asking for a client
// certificate), the ACME challenge for acme-tls/1, and the self-signed mesh
// identity for mesh. with a client certificate required and checked against
// the pinned node set before anything reads from the socket.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { peekClientHello } = require('./client-hello');
const { peerCertFingerprint } = require('../../mesh/mesh-transport');

const log = createLogger('frontdoor/sni');

const DEFAULT_LIMITS = Object.freeze({ maxSockets: 1024, perIp: 32, helloBytes: 16384, helloTimeoutMs: 5000, handshakeMs: 10000, firstRequestMs: 60000 });

class SniListener extends EventEmitter {
  constructor({ host, port, domain, mcpContext, meshContext, isPinnedNodeCert, isProbeCert, acmeChallenge, onMcpSocket, onMeshSocket,
    onUnknownNodeKey = () => {}, limits = {} } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.mcpHost = `mcp.${domain}`;
    this.meshHost = `mesh.${domain}`;
    this.mcpContext = mcpContext;
    this.meshContext = meshContext;
    this.isPinnedNodeCert = isPinnedNodeCert;
    this.isProbeCert = isProbeCert;
    this.acmeChallenge = acmeChallenge;
    this.onMcpSocket = onMcpSocket;
    this.onMeshSocket = onMeshSocket;
    this.onUnknownNodeKey = onUnknownNodeKey;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.server = null;
    this.sockets = new Set();
    this.perIp = new Map();
  }

  async start() {
    this.server = net.createServer({ pauseOnConnect: false }, (socket) => this._accept(socket));
    this.server.on('error', (err) => log.error(`listener error: ${err.message}`));
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(new Error(`cannot bind ${this.host}:${this.port}: ${err.message}`));
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
    log.info(`listening on ${this.host}:${this.address().port} for ${this.mcpHost} and ${this.meshHost}`);
  }

  address() {
    return this.server ? this.server.address() : null;
  }

  async stop() {
    if (!this.server) return;
    const closed = new Promise((resolve) => this.server.close(() => resolve()));
    for (const s of this.sockets) s.destroy();
    await closed;
    this.server = null;
  }

  _track(socket, ip) {
    this.sockets.add(socket);
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    socket.once('close', () => {
      this.sockets.delete(socket);
      const left = (this.perIp.get(ip) || 1) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
    });
  }

  async _accept(socket) {
    const ip = socket.remoteAddress || 'unknown';
    socket.on('error', () => {});
    if (this.sockets.size >= this.limits.maxSockets || (this.perIp.get(ip) || 0) >= this.limits.perIp) {
      socket.destroy();
      return;
    }
    this._track(socket, ip);
    let hello;
    try {
      ({ hello } = await peekClientHello(socket, { maxBytes: this.limits.helloBytes, timeoutMs: this.limits.helloTimeoutMs }));
    } catch (err) {
      log.debug(`dropping a connection from ${ip}: ${err.message}`);
      socket.destroy();
      return;
    }
    const name = hello.serverName;
    if (name === this.mcpHost) {
      if (hello.alpn.includes('acme-tls/1')) {
        const challenge = this.acmeChallenge(name);
        if (challenge) {
          this._wrap(socket, { secureContext: challenge, ALPNProtocols: ['acme-tls/1'] }, (s) => s.end());
          return;
        }
      }
      const context = this.mcpContext();
      if (!context) {
        socket.destroy(); // first boot: no certificate yet
        return;
      }
      this._wrap(socket, { secureContext: context, ALPNProtocols: ['http/1.1'], requestCert: false }, (s) => this._handOver(s, this.onMcpSocket));
      return;
    }
    if (name === this.meshHost && this.meshContext) {
      this._wrap(socket, { secureContext: this.meshContext, ALPNProtocols: ['http/1.1'], requestCert: true, rejectUnauthorized: false }, (s) => {
        // 'secure' fires after the handshake and before anything reads.
        const fp = peerCertFingerprint(s);
        if (fp && this.isProbeCert(fp)) {
          s.end();
          return;
        }
        if (!fp || !this.isPinnedNodeCert(fp)) {
          this.onUnknownNodeKey({ fingerprint: fp, ip });
          s.destroy();
          return;
        }
        this._handOver(s, this.onMeshSocket);
      });
      return;
    }
    socket.destroy();
  }

  _wrap(socket, options, onSecure) {
    const s = new tls.TLSSocket(socket, { isServer: true, ...options });
    s.on('error', () => s.destroy());
    const handshake = setTimeout(() => s.destroy(), this.limits.handshakeMs);
    s.once('secure', () => {
      clearTimeout(handshake);
      onSecure(s);
    });
    s.once('close', () => clearTimeout(handshake));
    // Not socket.resume(): the TLS wrap owns the socket's handle now, reads
    // the unshifted ClientHello from the socket's buffer itself, and starts
    // reading on its own.
  }

  // The consumer's HTTP server reads from here on; a connection that sends
  // no request within firstRequestMs is closed.
  _handOver(s, consumer) {
    const idle = setTimeout(() => s.destroy(), this.limits.firstRequestMs);
    s.once('data', () => clearTimeout(idle));
    s.once('close', () => clearTimeout(idle));
    consumer(s);
  }
}

module.exports = { SniListener, DEFAULT_LIMITS };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/frontdoor-sni.test.js tests/frontdoor-client-hello.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/test-certs.js src/frontdoor/tls/sni-listener.js tests/frontdoor-sni.test.js
git commit -m "feat(frontdoor): SNI listener with per-name TLS and pinned mesh client certificates" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 17: ACME with a stable key, operator TLS, and the `acme-client` dependency

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install --save-exact acme-client@5.4.0`)
- Create: `src/frontdoor/tls/acme.js`
- Create: `src/frontdoor/tls/operator-tls.js`
- Test: `tests/deps-acme-client.test.js`, `tests/frontdoor-acme.test.js`

**Interfaces:**
- Consumes: `relaySpkiPin` (`src/frontdoor/tls.js`), `writeFileAtomic`, a cipher `{ encryptString, decryptString }` (`buildServicePorts().cipher`), an alerts sink `{ raise(kind, { subject, detail }) }` (Task 20's `AlertCenter`), `tests/helpers/test-certs.js`.
- Produces:
  - `createAcmeAdapter({ directoryUrl, accountKeyPem, email, termsAgreed }) → { issue({ commonName, keyPem, onChallenge(name, { key, cert }), onChallengeDone(name) }) → Promise<chainPem> }` — the only code that touches `acme-client` (TLS-ALPN-01 only, `skipChallengeVerification: true`, Deviation 19).
  - `class AcmeManager({ domain, email, directoryUrl, termsAgreed, dir, cipher, alerts = null, now = Date.now, adapterFactory = createAcmeAdapter })` (extends `EventEmitter`) with `start()`, `currentContext() → SecureContext | null`, `challengeFor(servername) → SecureContext | null`, `leafSpki() → 'sha256/…' | null`, `certificate() → { chain, notBefore, notAfter, spki } | null`, `status() → { source: 'acme', not_after, spki, last_error, failures, next_attempt_at }`, `check({ ignoreBackoff = false }) → Promise<void>`, `reload()` (= `check({ ignoreBackoff: true })`, for `SIGHUP`), `rotateKey() → Promise<{ oldSpki, newSpki }>` (emits `'rotated'`), `stop()`. Files under `dir` (`<dataDir>/frontdoor/acme/`): `account.json`, `cert-key.json` (`{ v: 1, key: <cipher.encryptString(pem)> }`), `cert-key.next.json` (during a rotation), `cert.json` (`{ v: 1, chain, not_before, not_after, spki }`). `start()` throws, naming the file, when a key file cannot be decrypted or `cert.json` exists without `cert-key.json`; it never creates a key in either case (Review Focus 2).
  - `class OperatorTls({ host, certFile, keyFile, alerts = null, readFile })` with the same `start`, `currentContext`, `challengeFor` (always `null`), `leafSpki`, `certificate`, `status` (`source: 'operator'`), `reload` (re-reads; a new leaf SPKI logs `error` and raises `tls_key_changed`), `rotateKey` (throws: operator TLS has no key rotation), `stop`.
  - Constants `CHECK_EVERY_MS = 12 h`, `FAILURE_BACKOFF_MS = [1 h, 2 h, 4 h]` then 12 h, `ALERT_BEFORE_MS = 21 d`.

- [ ] **Step 1: Add the dependency**

Run: `npm install --save-exact acme-client@5.4.0`
Expected: `package.json` `dependencies` gains `"acme-client": "5.4.0"` (no caret) and `package-lock.json` gains `node_modules/acme-client` and its pure-JS tree (`@peculiar/x509`, `asn1js`, `axios`, `debug`, `node-forge` and theirs).

- [ ] **Step 2: Write the failing tests**

Create `tests/deps-acme-client.test.js`:

```js
// tests/deps-acme-client.test.js
//
// Program §3: no new native npm dependency. acme-client (fleet stage 4 §14)
// and everything it pulls in must be pure JS, pinned exactly.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));

function entryFor(name, parentPath) {
  let base = parentPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return [candidate, lock.packages[candidate]];
    if (!base) return [null, null];
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

describe('acme-client dependency', () => {
  it('is a runtime dependency pinned to an exact version ≥ 5.3', () => {
    const v = pkg.dependencies && pkg.dependencies['acme-client'];
    assert.match(v || '', /^\d+\.\d+\.\d+$/, 'no range: an exact version');
    const [major, minor] = v.split('.').map(Number);
    assert.ok(major > 5 || (major === 5 && minor >= 3), 'createAlpnCertificate needs ≥ 5.3');
  });

  it('has no install scripts or native build anywhere in its tree', () => {
    const seen = new Set();
    const queue = [['node_modules/acme-client', lock.packages['node_modules/acme-client']]];
    assert.ok(queue[0][1], 'package-lock.json has node_modules/acme-client');
    while (queue.length) {
      const [where, entry] = queue.shift();
      if (seen.has(where)) continue;
      seen.add(where);
      assert.notEqual(entry.hasInstallScript, true, `${where} has an install script`);
      assert.notEqual(entry.gypfile, true, `${where} builds native code`);
      for (const dep of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
        const [depWhere, depEntry] = entryFor(dep, where);
        assert.ok(depEntry, `${dep} (needed by ${where}) is in the lockfile`);
        queue.push([depWhere, depEntry]);
      }
    }
    assert.ok(seen.size >= 5);
  });

  it('exposes what the adapter uses', () => {
    const acme = require('acme-client');
    assert.equal(typeof acme.Client, 'function');
    assert.equal(typeof acme.setLogger, 'function');
    assert.equal(typeof acme.crypto.createCsr, 'function');
    assert.equal(typeof acme.crypto.createAlpnCertificate, 'function');
  });
});
```

Create `tests/frontdoor-acme.test.js`:

```js
// tests/frontdoor-acme.test.js — fleet stage 4 §3.3, R21.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcmeManager, CHECK_EVERY_MS } = require('../src/frontdoor/tls/acme');
const { OperatorTls } = require('../src/frontdoor/tls/operator-tls');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { relaySpkiPin } = require('../src/frontdoor/tls');
const { createCa, issueCert, selfSigned } = require('./helpers/test-certs');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const DAY = 86400000;
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-acme-')); temps.push(d); return d; };
const ca = createCa();

function fakeAcme({ lifetimeDays = 90, fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
        calls.push({ commonName, keySpki: crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' }).toString('hex') });
        const challenge = selfSigned({ commonName });
        onChallenge(commonName, challenge);
        calls.at(-1).challengeServed = true;
        onChallengeDone(commonName);
        if (fail()) throw new Error('urn:ietf:params:acme:error:connection');
        const t = clock.now;
        return issueCert(ca, { dnsNames: [commonName], keyPem, notBefore: t, notAfter: t + lifetimeDays * DAY }).cert + ca.cert;
      }
    })
  };
}
const clock = { now: Date.parse('2026-09-23T00:00:00.000Z') };
const alertsSink = () => ({ raised: [], raise(kind, opts) { this.raised.push([kind, opts]); return { id: String(this.raised.length) }; } });

function manager({ dir = tmp(), acme = fakeAcme(), alerts = alertsSink(), key = crypto.randomBytes(32) } = {}) {
  const m = new AcmeManager({
    domain: 'kl.example.com', email: null, directoryUrl: 'https://acme.example.com/directory', termsAgreed: true,
    dir, cipher: createAesGcmCipher(key), alerts, now: () => clock.now, adapterFactory: acme.factory
  });
  return { m, dir, acme, alerts, key };
}

describe('AcmeManager', () => {
  it('first start issues with a new P-256 key; mcp. has no context before that', async () => {
    const { m, acme, dir } = manager();
    assert.equal(m.currentContext(), null);
    await m.start();
    assert.ok(m.currentContext());
    assert.equal(acme.calls.length, 1);
    assert.equal(acme.calls[0].commonName, 'mcp.kl.example.com');
    assert.ok(acme.calls[0].challengeServed);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'cert-key.json'), 'utf8'));
    assert.ok(!stored.key.includes('PRIVATE KEY'), 'the key is stored encrypted');
    assert.equal(m.leafSpki(), relaySpkiPin(m.certificate().chain));
    m.stop();
  });

  it('renews at a third of the lifetime left, with the same key, so every phone pin survives', async () => {
    const { m, acme, dir, key } = manager();
    await m.start();
    const spki = m.leafSpki();
    clock.now += 59 * DAY;
    await m.check();
    assert.equal(acme.calls.length, 1, 'not yet: more than a third left');
    clock.now += 2 * DAY;
    await m.check();
    assert.equal(acme.calls.length, 2);
    assert.equal(acme.calls[1].keySpki, acme.calls[0].keySpki);
    assert.equal(m.leafSpki(), spki);
    m.stop();
    const restarted = manager({ dir, acme, key }).m;
    await restarted.start();
    assert.equal(restarted.leafSpki(), spki, 'a restart keeps the key and the certificate');
    restarted.stop();
  });

  it('a failing renewal keeps serving the old certificate and alerts at T-21 d', async () => {
    let failing = false;
    const acme = fakeAcme({ fail: () => failing });
    const { m, alerts } = manager({ acme });
    await m.start();
    const context = m.currentContext();
    failing = true;
    clock.now += 61 * DAY;
    await m.check();
    assert.equal(m.currentContext(), context);
    assert.equal(alerts.raised.length, 0, 'more than 21 days left: no alert yet');
    assert.equal(m.status().failures, 1);
    clock.now += 50 * DAY;
    await m.check({ ignoreBackoff: true });
    assert.equal(alerts.raised.at(-1)[0], 'acme_renewal_failing');
    assert.equal(alerts.raised.at(-1)[1].subject, 'mcp.kl.example.com');
    failing = false;
    await m.reload();
    assert.notEqual(m.currentContext(), context);
    assert.equal(m.status().failures, 0);
    m.stop();
  });

  it('backs off 1 h, 2 h, 4 h, then 12 h after failures; SIGHUP (reload) retries at once', async () => {
    const acme = fakeAcme({ fail: () => true });
    const { m } = manager({ acme });
    await m.start();
    const t0 = clock.now;
    const next = () => Date.parse(m.status().next_attempt_at) - clock.now;
    assert.equal(next(), 3600000);
    await m.check();
    assert.equal(acme.calls.length, 1, 'inside the backoff: no attempt');
    clock.now = t0 + 3600000;
    await m.check();
    assert.equal(next(), 7200000);
    clock.now += 7200000;
    await m.check();
    assert.equal(next(), 14400000);
    clock.now += 14400000;
    await m.check();
    assert.equal(next(), CHECK_EVERY_MS);
    const before = acme.calls.length;
    await m.reload();
    assert.equal(acme.calls.length, before + 1);
    m.stop();
  });

  it('an undecryptable certificate key refuses to start and is never regenerated (Review Focus 2)', async () => {
    const { m, dir } = manager();
    await m.start();
    m.stop();
    const keyFile = path.join(dir, 'cert-key.json');
    const before = fs.readFileSync(keyFile, 'utf8');
    const wrongKey = manager({ dir, key: crypto.randomBytes(32) }).m;
    await assert.rejects(wrongKey.start(), (err) => err.message.includes(keyFile) && /cannot be decrypted/.test(err.message) && /new key/.test(err.message));
    assert.equal(fs.readFileSync(keyFile, 'utf8'), before);
    fs.rmSync(keyFile);
    await assert.rejects(manager({ dir }).m.start(), /cert\.json exists but cert-key\.json does not/);
    assert.ok(!fs.existsSync(keyFile));
  });

  it('rotateKey issues with a new key and reports both pins', async () => {
    const { m, acme } = manager();
    await m.start();
    const events = [];
    m.on('rotated', (e) => events.push(e));
    const old = m.leafSpki();
    const r = await m.rotateKey();
    assert.equal(r.oldSpki, old);
    assert.notEqual(r.newSpki, old);
    assert.equal(m.leafSpki(), r.newSpki);
    assert.notEqual(acme.calls[1].keySpki, acme.calls[0].keySpki);
    assert.deepEqual(events, [r]);
    m.stop();
  });
});

describe('OperatorTls', () => {
  it('serves the operator files and raises tls_key_changed when the leaf SPKI changes', async () => {
    const dir = tmp();
    const write = (c) => { fs.writeFileSync(path.join(dir, 'mcp.pem'), c.cert); fs.writeFileSync(path.join(dir, 'mcp.key'), c.key); };
    const first = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
    write(first);
    const alerts = alertsSink();
    const t = new OperatorTls({ host: 'mcp.kl.example.com', certFile: path.join(dir, 'mcp.pem'), keyFile: path.join(dir, 'mcp.key'), alerts });
    t.start();
    assert.ok(t.currentContext());
    assert.equal(t.challengeFor('mcp.kl.example.com'), null);
    assert.equal(t.leafSpki(), relaySpkiPin(first.cert));
    const renewedSameKey = issueCert(ca, { dnsNames: ['mcp.kl.example.com'], keyPem: first.key });
    write({ cert: renewedSameKey.cert, key: first.key });
    t.reload();
    assert.equal(alerts.raised.length, 0);
    write(issueCert(ca, { dnsNames: ['mcp.kl.example.com'] }));
    t.reload();
    assert.equal(alerts.raised[0][0], 'tls_key_changed');
    assert.equal(t.status().source, 'operator');
    await assert.rejects(t.rotateKey(), /frontdoor\.acme/);
    t.stop();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/deps-acme-client.test.js tests/frontdoor-acme.test.js`
Expected: the dependency test PASSES (Step 1 installed it); the ACME test FAILS with `Cannot find module '../src/frontdoor/tls/acme'`.

- [ ] **Step 4: Write `src/frontdoor/tls/acme.js`**

```js
// The mcp. certificate from an ACME CA (fleet stage 4 §3.3): TLS-ALPN-01
// only, so port 80 stays closed (trust principle 4); the certificate key is
// ECDSA P-256, generated once, stored encrypted and reused for every renewal
// (R21), because phones pin the leaf SPKI. A key file that cannot be read
// is never replaced by a new key: that would silently cut every phone off.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { relaySpkiPin } = require('../tls');

const log = createLogger('frontdoor/acme');

const CHECK_EVERY_MS = 12 * 3600000;
const FAILURE_BACKOFF_MS = Object.freeze([3600000, 7200000, 14400000]);
const ALERT_BEFORE_MS = 21 * 86400000;

function newP256Pem() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function certInfo(chain) {
  const leaf = new crypto.X509Certificate(chain);
  return { notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo), spki: relaySpkiPin(chain) };
}

function keySpki(keyPem) {
  const spki = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  return `sha256/${crypto.createHash('sha256').update(spki).digest('base64url')}`;
}

// The one place acme-client is used. Its own logger goes to ours at debug.
function createAcmeAdapter({ directoryUrl, accountKeyPem, email = null, termsAgreed = false }) {
  // eslint-disable-next-line global-require -- only the frontdoor profile loads it
  const acme = require('acme-client');
  acme.setLogger((message) => log.debug(message));
  const client = new acme.Client({ directoryUrl, accountKey: accountKeyPem });
  return {
    async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
      const [, csr] = await acme.crypto.createCsr({ commonName, altNames: [commonName] }, keyPem);
      return client.auto({
        csr,
        ...(email ? { email } : {}),
        termsOfServiceAgreed: termsAgreed === true,
        challengePriority: ['tls-alpn-01'],
        // acme-client would dial our own ALPN responder first; the CA does
        // exactly that next (Deviation 19).
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'tls-alpn-01') throw new Error(`refusing the ${challenge.type} challenge: only tls-alpn-01 is served`);
          const [key, cert] = await acme.crypto.createAlpnCertificate(authz, keyAuthorization);
          onChallenge(authz.identifier.value, { key: key.toString(), cert: cert.toString() });
        },
        challengeRemoveFn: async (authz) => {
          onChallengeDone(authz.identifier.value);
        }
      });
    }
  };
}

class AcmeManager extends EventEmitter {
  constructor({ domain, email = null, directoryUrl, termsAgreed = false, dir, cipher, alerts = null, now = Date.now, adapterFactory = createAcmeAdapter } = {}) {
    super();
    this.host = `mcp.${domain}`;
    this.email = email;
    this.directoryUrl = directoryUrl;
    this.termsAgreed = termsAgreed;
    this.dir = dir;
    this.cipher = cipher;
    this.alerts = alerts;
    this.now = now;
    this.adapterFactory = adapterFactory;
    this.files = {
      account: path.join(dir, 'account.json'),
      key: path.join(dir, 'cert-key.json'),
      nextKey: path.join(dir, 'cert-key.next.json'),
      cert: path.join(dir, 'cert.json')
    };
    this.keyPem = null;
    this.cert = null;
    this.context = null;
    this.challenges = new Map();
    this.failures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
    this.inFlight = null;
    this.timer = null;
    this.adapter = null;
  }

  _readKey(file) {
    if (!fs.existsSync(file)) return null;
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pem = this.cipher.decryptString(stored.key);
      crypto.createPrivateKey(pem);
      return pem;
    } catch (err) {
      throw new Error(`${file} cannot be decrypted (${err.message}); refusing to create a new key, which every paired phone would reject. Restore the master key or the file.`);
    }
  }

  _writeKey(file, pem) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ v: 1, key: this.cipher.encryptString(pem) })}\n`);
  }

  _readCert() {
    if (!fs.existsSync(this.files.cert)) return null;
    try {
      const stored = JSON.parse(fs.readFileSync(this.files.cert, 'utf8'));
      return { chain: stored.chain, ...certInfo(stored.chain) };
    } catch (err) {
      log.warn(`ignoring ${this.files.cert}: ${err.message}`);
      return null;
    }
  }

  _install(chain) {
    const info = certInfo(chain);
    this.context = tls.createSecureContext({ key: this.keyPem, cert: chain });
    this.cert = { chain, ...info };
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.keyPem = this._readKey(this.files.key);
    const cert = this._readCert();
    if (cert && !this.keyPem) {
      throw new Error(`${path.basename(this.files.cert)} exists but ${path.basename(this.files.key)} does not in ${this.dir}; refusing to issue with a new key (phones pin ${cert.spki}). Restore the key file, or remove ${this.files.cert} and re-pin every phone.`);
    }
    if (!this.keyPem) {
      this.keyPem = newP256Pem();
      this._writeKey(this.files.key, this.keyPem);
      log.info(`generated the stable mcp. key ${keySpki(this.keyPem)}`);
    }
    if (cert && cert.spki === keySpki(this.keyPem)) this._install(cert.chain);
    else if (cert) log.warn(`${this.files.cert} does not match the stable key; a new certificate will be issued with the key`);
    let accountKey = this._readKey(this.files.account);
    if (!accountKey) {
      accountKey = newP256Pem();
      this._writeKey(this.files.account, accountKey);
    }
    this.adapter = this.adapterFactory({ directoryUrl: this.directoryUrl, accountKeyPem: accountKey, email: this.email, termsAgreed: this.termsAgreed });
    await this.check();
    this.timer = setInterval(() => { this.check().catch(() => {}); }, CHECK_EVERY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  currentContext() {
    return this.context;
  }

  challengeFor(servername) {
    return this.challenges.get(servername) || null;
  }

  leafSpki() {
    return this.cert ? this.cert.spki : null;
  }

  certificate() {
    return this.cert ? { ...this.cert } : null;
  }

  status() {
    return {
      source: 'acme',
      not_after: this.cert ? new Date(this.cert.notAfter).toISOString() : null,
      spki: this.leafSpki(),
      last_error: this.lastError,
      failures: this.failures,
      next_attempt_at: this.nextAttemptAt === null ? null : new Date(this.nextAttemptAt).toISOString()
    };
  }

  needsRenewal() {
    if (!this.cert) return true;
    const lifetime = this.cert.notAfter - this.cert.notBefore;
    return this.cert.notAfter - this.now() <= lifetime / 3;
  }

  reload() {
    return this.check({ ignoreBackoff: true });
  }

  async check({ ignoreBackoff = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!this.needsRenewal()) return undefined;
    if (!ignoreBackoff && this.nextAttemptAt !== null && this.now() < this.nextAttemptAt) return undefined;
    this.inFlight = this._issue(this.keyPem)
      .then((chain) => {
        this._writeCert(chain);
        this._install(chain);
        this.failures = 0;
        this.lastError = null;
        this.nextAttemptAt = null;
        log.info(`certificate for ${this.host} valid until ${new Date(this.cert.notAfter).toISOString()}`);
      })
      .catch((err) => this._failed(err))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  _writeCert(chain) {
    const info = certInfo(chain);
    writeFileAtomic(this.files.cert, `${JSON.stringify({ v: 1, chain, not_before: new Date(info.notBefore).toISOString(), not_after: new Date(info.notAfter).toISOString(), spki: info.spki }, null, 2)}\n`);
  }

  _failed(err) {
    this.failures += 1;
    this.lastError = err.message;
    const wait = this.failures <= FAILURE_BACKOFF_MS.length ? FAILURE_BACKOFF_MS[this.failures - 1] : CHECK_EVERY_MS;
    this.nextAttemptAt = this.now() + wait;
    log.warn(`ACME issuance for ${this.host} failed (${err.message}); the current certificate stays; next attempt in ${Math.round(wait / 60000)} min`);
    if (this.cert && this.cert.notAfter - this.now() < ALERT_BEFORE_MS && this.alerts) {
      this.alerts.raise('acme_renewal_failing', { subject: this.host, detail: { not_after: new Date(this.cert.notAfter).toISOString(), error: err.message } });
    }
  }

  async _issue(keyPem) {
    return this.adapter.issue({
      commonName: this.host,
      keyPem,
      onChallenge: (name, { key, cert }) => this.challenges.set(name, tls.createSecureContext({ key, cert })),
      onChallengeDone: (name) => this.challenges.delete(name)
    });
  }

  // §3.3.1: a new key and a certificate for it; the old key stays until the
  // new certificate exists.
  async rotateKey() {
    if (this.inFlight) await this.inFlight;
    const oldSpki = this.leafSpki();
    const nextKey = newP256Pem();
    this._writeKey(this.files.nextKey, nextKey);
    let chain;
    try {
      chain = await this._issue(nextKey);
    } catch (err) {
      fs.rmSync(this.files.nextKey, { force: true });
      throw new Error(`rotate-tls-key: issuing a certificate for the new key failed (${err.message}); the old key and certificate stay`);
    }
    this._writeKey(this.files.key, nextKey);
    fs.rmSync(this.files.nextKey, { force: true });
    this.keyPem = nextKey;
    this._writeCert(chain);
    this._install(chain);
    const event = { oldSpki, newSpki: this.leafSpki() };
    this.emit('rotated', event);
    return event;
  }
}

module.exports = { AcmeManager, createAcmeAdapter, CHECK_EVERY_MS, FAILURE_BACKOFF_MS, ALERT_BEFORE_MS };
```

- [ ] **Step 5: Write `src/frontdoor/tls/operator-tls.js`**

```js
// frontdoor.tls: the operator supplies the mcp. certificate and key (§3.3).
// The files are re-read on SIGHUP and every 12 h; a new leaf key means every
// phone must re-pin, so it is logged at error and raised as tls_key_changed.
const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');
const { createLogger } = require('../../logging');
const { relaySpkiPin } = require('../tls');
const { CHECK_EVERY_MS } = require('./acme');

const log = createLogger('frontdoor/operator-tls');

class OperatorTls {
  constructor({ host, certFile, keyFile, alerts = null, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
    this.host = host;
    this.certFile = certFile;
    this.keyFile = keyFile;
    this.alerts = alerts;
    this.readFile = readFile;
    this.context = null;
    this.cert = null;
    this.timer = null;
  }

  _load() {
    const chain = this.readFile(this.certFile);
    const key = this.readFile(this.keyFile);
    const context = tls.createSecureContext({ cert: chain, key });
    const leaf = new crypto.X509Certificate(chain);
    const spki = relaySpkiPin(chain);
    if (this.cert && this.cert.spki !== spki) {
      log.error(`the mcp. certificate key changed (${this.cert.spki} → ${spki}): every phone must re-pin (relay qr, or rotate-tls-key under ACME)`);
      if (this.alerts) this.alerts.raise('tls_key_changed', { subject: this.host, detail: { old_spki: this.cert.spki, new_spki: spki } });
    }
    this.context = context;
    this.cert = { chain, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo), spki };
  }

  start() {
    this._load();
    this.timer = setInterval(() => this.reload(), CHECK_EVERY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  reload() {
    try {
      this._load();
    } catch (err) {
      log.error(`could not re-read ${this.certFile} / ${this.keyFile}: ${err.message}; the loaded certificate stays`);
    }
    return Promise.resolve();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  currentContext() {
    return this.context;
  }

  challengeFor() {
    return null;
  }

  leafSpki() {
    return this.cert ? this.cert.spki : null;
  }

  certificate() {
    return this.cert ? { ...this.cert } : null;
  }

  status() {
    return { source: 'operator', not_after: this.cert ? new Date(this.cert.notAfter).toISOString() : null, spki: this.leafSpki(), last_error: null, failures: 0, next_attempt_at: null };
  }

  async rotateKey() {
    throw new Error('rotate-tls-key needs frontdoor.acme; with frontdoor.tls, replace the files, then give phones the new pin with `relay qr`');
  }
}

module.exports = { OperatorTls };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/deps-acme-client.test.js tests/frontdoor-acme.test.js tests/deps-qrcode.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/frontdoor/tls/acme.js src/frontdoor/tls/operator-tls.js tests/deps-acme-client.test.js tests/frontdoor-acme.test.js
git commit -m "feat(frontdoor): ACME TLS-ALPN-01 with a stable key, operator TLS, acme-client 5.4.0" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 18: F3's relay behind an external listener; the front door as its own node

**Files:**
- Modify: `src/frontdoor/relay.js` (`startRelay`: `transport`, `phoneSpki`, `setPhoneSpki`, no private-host check or TLS files for `'external'`)
- Modify: `src/frontdoor/node-hub.js` (`attachLocalNode`, `callLocal`, local routing in `nodeById`/`rpc`/`notify`; removed peers closed with `4003`)
- Create: `src/frontdoor/self-link.js`
- Test: `tests/frontdoor-relay-external.test.js`

**Interfaces:**
- Consumes: F3 `startRelay`, `NodeHub`, `createRelayDispatcher` (service-wiring), `buildEnrollOpen`/`buildEnrollDone`, `writeFileAtomic`; Task 6 `closePeer`/`CLOSE_CODES`.
- Produces:
  - `startRelay({ …, listeners: 'external', transport, phoneSpki })` — binds nothing, skips `assertPrivateMeshHost` and the `relay.tls` files, uses the given `MeshTransport`; the result gains a `phoneSpki` getter and `setPhoneSpki(pin)` (what `relay.hello` reports from then on). `'own'` is unchanged.
  - `nodeHub.attachLocalNode({ nodeId, nodeName, publicKeyHex, dispatch(method, params) → result })` — `nodeById(frontdoorId)` returns it, `rpc`/`notify` to it call `dispatch`, `nodes()` leaves it out. `nodeHub.callLocal(method, params) → Promise` runs a node → relay handler (`enroll.open`, `enroll.done`, `device.state`, …) as that local node.
  - A peer the peer source no longer lists is closed with `4003 key_removed` and untrusted.
  - `class FrontDoorSelfLink({ nodeHub, dataDir, frontdoorId, publicUrl, spki: () => pin })` (extends `EventEmitter`): the `relayClient` the front door's own `CourierPump` and `trackDeviceStates` use — `call`/`notify` → `callLocal`, `isConnected() → true`, `canDeliver() → { ok: true }`, `writeLink()` writes `<dataDir>/approvals/link.json` `{ connected: true, since, relay_id, relay_public_url, relay_spki }` so F3's `enroll-device` works against the front door (§3.11).

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-relay-external.test.js`:

```js
// tests/frontdoor-relay-external.test.js — fleet stage 4 §3.1 (E1, E3), §3.11.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { startRelay } = require('../src/frontdoor/relay');
const { NodeHub } = require('../src/frontdoor/node-hub');
const { FrontDoorSelfLink } = require('../src/frontdoor/self-link');
const { MeshTransport, CLOSE_CODES } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { buildEnrollOpen, buildEnrollDone } = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-ext-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function externalRelay() {
  const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
  const transport = new MeshTransport({ identity: fd, listen: false, useTls: false });
  const relay = await startRelay({
    dataDir: tmp(), identity: fd, listeners: 'external', transport, phoneSpki: 'sha256/aaaa',
    config: { publicUrl: 'https://mcp.kl.example.com', push: {} }
  });
  cleanups.push(() => relay.stop());
  const server = http.createServer(relay.phoneApiHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { fd, relay, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathWithQuery, { body = null, headers = {} } = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  const res = await fetch(`${base}${pathWithQuery}`, { method, body: body === null ? undefined : text, headers: { 'content-type': 'application/json', ...headers } });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

describe('startRelay with an external listener', () => {
  it('binds nothing, needs the transport, and reports the phone pin it is given', async () => {
    const { relay } = await externalRelay();
    assert.deepEqual(relay.address(), { phone: null, mesh: null });
    assert.equal(relay.phoneSpki, 'sha256/aaaa');
    relay.setPhoneSpki('sha256/bbbb');
    assert.equal(relay.phoneSpki, 'sha256/bbbb');
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'external', config: { publicUrl: 'https://x.example.com' } }), /needs the front door's transport/);
  });
});

describe('the front door as its own node', () => {
  it('runs F3 console enrollment against the front door and serves its history', async () => {
    const { fd, relay, base } = await externalRelay();
    const calls = [];
    relay.nodeHub.attachLocalNode({
      nodeId: fd.nodeId, nodeName: 'frontdoor', publicKeyHex: fd.publicKey.toString('hex'),
      dispatch: async (method, params) => {
        calls.push([method, params]);
        if (method === 'enroll.claim') return { delivered: true };
        if (method === 'audit.slice') return { envelope: { alg: 'Ed25519', kid: fd.nodeId, payload: 'e30', sig: 'AA' } };
        return null;
      }
    });
    assert.equal(relay.nodeHub.nodeById(fd.nodeId).node_id, fd.nodeId);
    assert.deepEqual(relay.nodeHub.nodes(), [], 'the local node is not listed as a paired node');

    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    await relay.nodeHub.callLocal('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) });
    const phone = createFakePhone({ seed: 'A' });
    const claim = phone.enroll({ codeId, code });
    const posted = await request(base, 'POST', `/v1/enroll/${codeId}`, { body: claim });
    assert.equal(posted.status, 202);
    assert.equal(calls[0][0], 'enroll.claim');
    await relay.nodeHub.callLocal('enroll.done', { envelope: buildEnrollDone({ identity: fd, codeId, enroll: claim }) });
    assert.deepEqual(relay.devices.nodesForDevice(phone.deviceId), [{ node_id: fd.nodeId, state: 'active' }]);

    const history = `/v1/nodes/${fd.nodeId}/history?limit=5`;
    const got = await request(base, 'GET', history, { headers: phone.signApi('GET', history) });
    assert.equal(got.status, 200);
    assert.equal(calls.at(-1)[0], 'audit.slice');
  });

  it('FrontDoorSelfLink writes link.json and relays node → relay calls locally', async () => {
    const { fd, relay } = await externalRelay();
    relay.nodeHub.attachLocalNode({ nodeId: fd.nodeId, nodeName: 'frontdoor', publicKeyHex: fd.publicKey.toString('hex'), dispatch: async () => null });
    const dataDir = tmp();
    const link = new FrontDoorSelfLink({ nodeHub: relay.nodeHub, dataDir, frontdoorId: fd.nodeId, publicUrl: 'https://mcp.kl.example.com', spki: () => relay.phoneSpki });
    link.writeLink();
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
    assert.deepEqual({ connected: written.connected, relay_id: written.relay_id, relay_public_url: written.relay_public_url, relay_spki: written.relay_spki },
      { connected: true, relay_id: fd.nodeId, relay_public_url: 'https://mcp.kl.example.com', relay_spki: 'sha256/aaaa' });
    assert.equal(link.isConnected(), true);
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.deepEqual(await link.call('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) }), { ok: true });
  });
});

describe('peer source changes', () => {
  it('a node dropped from the peer source is closed with 4003', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const nodeId = new NodeIdentity({ nodeName: 'gpu-box' });
    const source = Object.assign(new EventEmitter(), { items: [{ peerId: nodeId.peerId, publicKeyHex: nodeId.publicKey.toString('hex'), name: 'gpu-box', tlsFingerprint: null, nodeId: nodeId.nodeId }] });
    source.list = () => source.items;
    const transport = new MeshTransport({ identity: hubId, host: '127.0.0.1', port: 0, useTls: false });
    const hub = new NodeHub({ identity: hubId, transport, pairing: new MeshPairing(hubId, transport), registryFile: path.join(tmp(), 'nodes.json'), peerSource: source });
    await hub.start({ listen: true });
    cleanups.push(() => hub.stop());
    const dialer = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
    await dialer.start();
    cleanups.push(() => dialer.stop());
    dialer.addTrustedPeer(hubId.peerId, hubId.publicKey);
    await dialer.connectToPeer('127.0.0.1', transport.port);
    const closed = once(dialer, 'peerDisconnected');
    source.items = [];
    source.emit('change');
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(transport.trustedPeers.has(nodeId.peerId), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-relay-external.test.js`
Expected: FAIL — `relay.setPhoneSpki is not a function` / `attachLocalNode is not a function`.

- [ ] **Step 3: `startRelay` for an external listener**

In `src/frontdoor/relay.js`, replace the signature through the `const nodeHub = new NodeHub({ … });` line with:

```js
// config: { phoneListen, tls: { certFile, keyFile }, meshListen, publicUrl, push } for 'own';
// for 'external' (the front door, fleet stage 4 §3.1) only { publicUrl, push },
// plus the front door's own `transport` (pinned in TLS) and `phoneSpki`.
async function startRelay({ dataDir, config, identity, listeners = 'own', registry = null, extensions = RELAY_EXTENSIONS,
  useTls = true, senders = null, now = Date.now, transport = null, phoneSpki = null } = {}) {
  if (!['own', 'external'].includes(listeners)) throw new TypeError("listeners must be 'own' or 'external'");
  const external = listeners === 'external';
  if (external && !transport) throw new TypeError("listeners 'external' needs the front door's transport");
  // Only the relay's own mesh listener is limited to private addresses: the
  // front door's mesh drops unpinned certificates in TLS (ruling 8, §3.2).
  if (!external) assertPrivateMeshHost(config.meshListen && config.meshListen.host);
  const relayDir = path.join(dataDir, 'relay');
  fs.mkdirSync(path.join(relayDir, 'codes'), { recursive: true, mode: 0o700 });

  let cert = null;
  let key = null;
  let spki = phoneSpki;
  if (useTls && !external) {
    cert = fs.readFileSync(config.tls.certFile, 'utf8');
    key = fs.readFileSync(config.tls.keyFile, 'utf8');
    spki = relaySpkiPin(cert);
  }

  const devices = new DeviceRegistry({ file: path.join(relayDir, 'devices.json'), now });
  const approvals = new ApprovalCache({ now });
  const invites = new Invites({ now });
  const mailbox = new Mailbox({ now });
  const pusher = createPusher(config.push || {}, {
    ...(senders ? { senders } : {}),
    onDropToken: (device) => devices.setPush(device.device_id, null)
  });
  const meshTransport = transport || new MeshTransport({ identity, host: config.meshListen.host, port: config.meshListen.port, useTls });
  const pairing = new MeshPairing(identity, meshTransport);
  const nodeHub = new NodeHub({ identity, transport: meshTransport, pairing, registryFile: path.join(relayDir, 'nodes.json'), peerSource: registry, codesDir: path.join(relayDir, 'codes') });
```

and in the rest of the function:

1. `const relay = { identity, config, publicUrl: config.publicUrl, phoneSpki, … }` becomes `phoneSpki: spki`.
2. The ready log's `mesh: listeners === 'own' ? transport.port : null` becomes `mesh: listeners === 'own' ? meshTransport.port : null`.
3. In the returned object, replace `phoneSpki,` with:

```js
    get phoneSpki() {
      return relay.phoneSpki;
    },
    // F4 (§3.3): after a certificate key change, relay.hello reports the new pin.
    setPhoneSpki(pin) {
      relay.phoneSpki = pin;
    },
```

4. In `address()`, `mesh: listeners === 'own' ? { host: config.meshListen.host, port: transport.port } : null` becomes `… port: meshTransport.port …`.

- [ ] **Step 4: The local node and peer removal in `NodeHub`**

In `src/frontdoor/node-hub.js`:

1. In the constructor add `this.localNode = null;`.

2. Replace `_loadPeers()` with:

```js
  // F4's peer source: { list() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }], on('change') }.
  _loadPeers() {
    const before = new Set(this.registry.map((n) => n.peer_id));
    if (this.peerSource) {
      this.registry = this.peerSource.list().map((p) => ({
        node_id: p.nodeId, node_name: p.name, public_key: p.publicKeyHex, peer_id: p.peerId, tls_fingerprint: p.tlsFingerprint || null, paired_at: null
      }));
    }
    const now = new Set(this.registry.map((n) => n.peer_id));
    for (const peerId of before) {
      if (now.has(peerId)) continue;
      // A removed or replaced key (fleet stage 4 §3.6): its live link closes
      // with 4003 key_removed and it is no longer trusted.
      if (typeof this.transport.closePeer === 'function') this.transport.closePeer(peerId, 4003, 'key_removed');
      this.transport.trustedPeers.delete(peerId);
    }
    for (const n of this.registry) this._trust(n);
  }
```

3. Add after `onConnection(fn) { … }`:

```js
  // Fleet stage 4 (§3.11, Deviation 3): the front door is a node of its own
  // relay for console enrollment, device staging and its own history, with
  // F3's message shapes unchanged. It is never listed as a paired node.
  attachLocalNode({ nodeId, nodeName, publicKeyHex, dispatch }) {
    if (typeof dispatch !== 'function') throw new TypeError('attachLocalNode needs dispatch(method, params)');
    this.localNode = { node_id: nodeId, node_name: nodeName, public_key: publicKeyHex, peer_id: null, local: true, dispatch };
  }

  // A node → relay call made by the front door itself (its courier, its
  // device-state tracker).
  callLocal(method, params = {}) {
    if (!this.localNode) return Promise.reject(new LinkRpcError('no_local_node', 'no local node is attached'));
    const handler = this.handlers.get(method);
    if (!handler) return Promise.reject(new LinkRpcError('unknown_method', `the relay has no handler for ${method}`));
    return Promise.resolve().then(() => handler(params, { nodeId: this.localNode.node_id }));
  }
```

4. Replace `nodeById`, `rpc` and `notify` with:

```js
  nodeById(nodeId) {
    const found = this.registry.find((n) => n.node_id === nodeId);
    if (found) return found;
    return this.localNode && this.localNode.node_id === nodeId ? this.localNode : null;
  }

  rpc(nodeId, method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.localNode && nodeId === this.localNode.node_id) return Promise.resolve().then(() => this.localNode.dispatch(method, params));
    const node = this.nodeById(nodeId);
    if (!node) return Promise.reject(new LinkRpcError('unknown_node', `no node ${nodeId}`));
    return this.rpcLink.call(node.peer_id, method, params, { timeoutMs });
  }

  notify(nodeId, method, params = {}) {
    if (this.localNode && nodeId === this.localNode.node_id) {
      Promise.resolve().then(() => this.localNode.dispatch(method, params)).catch((err) => log.warn(`local ${method} failed: ${err.message}`));
      return;
    }
    const node = this.nodeById(nodeId);
    if (node) this.rpcLink.notify(node.peer_id, method, params);
  }
```

- [ ] **Step 5: Write `src/frontdoor/self-link.js`**

```js
// The front door's "relay link" to itself (fleet stage 4 §3.11): F3's
// CourierPump and trackDeviceStates talk to a relay client; on the front
// door that client hands every call to the relay's own node → relay
// handlers as the local node. link.json is written so F3's enroll-device
// finds the relay URL and pin it puts in the phone's QR code.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/self-link');

class FrontDoorSelfLink extends EventEmitter {
  constructor({ nodeHub, dataDir, frontdoorId, publicUrl, spki = () => null, now = Date.now } = {}) {
    super();
    this.nodeHub = nodeHub;
    this.linkFile = path.join(dataDir, 'approvals', 'link.json');
    this.frontdoorId = frontdoorId;
    this.publicUrl = publicUrl;
    this.spki = spki;
    this.since = new Date(now()).toISOString();
  }

  isConnected() {
    return true;
  }

  canDeliver() {
    return { ok: true };
  }

  call(method, params = {}) {
    return this.nodeHub.callLocal(method, params);
  }

  notify(method, params = {}) {
    this.nodeHub.callLocal(method, params).catch((err) => log.warn(`local ${method} failed: ${err.message}`));
  }

  writeLink() {
    fs.mkdirSync(path.dirname(this.linkFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.linkFile, `${JSON.stringify({
      connected: true, since: this.since, relay_id: this.frontdoorId, relay_public_url: this.publicUrl, relay_spki: this.spki()
    })}\n`);
  }
}

module.exports = { FrontDoorSelfLink };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-relay-external.test.js tests/frontdoor-relay.test.js tests/frontdoor-phone-api.test.js tests/service-profile-graph.test.js`
Expected: PASS (`# fail 0`); F3's relay tests are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/frontdoor/relay.js src/frontdoor/node-hub.js src/frontdoor/self-link.js tests/frontdoor-relay-external.test.js
git commit -m "feat(frontdoor): relay behind an external listener; the front door as its own node" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: `NodeRegistry` and one connection per node key

**Files:**
- Create: `src/frontdoor/router/node-registry.js`
- Modify: `src/mesh/mesh-transport.js` (constructor option `duplicatePingMs`; `_promoteToPeer`; new `_settleDuplicate`)
- Test: `tests/frontdoor-registry.test.js`

**Interfaces:**
- Consumes: Task 1 (`spkiHexFromRaw`, `rawEd25519`), Task 2 (`verifyPhoneEnvelope`), `assertAdminOwned`, `writeFileAtomic`, `deriveNodeId`, `derivePeerId`, an alerts sink.
- Produces:
  - `class NodeRegistry({ configDir, dataDir, approverStore, frontdoorId, alerts = null, adminUid = 0, geteuid, now = Date.now })` (extends `EventEmitter`; events `'change'`, `'removed' { nodeId, reason }`, `'replaced' { oldId, newId }`) with `load()`, `addSigned(envelope, { acceptedAt })`, `removeSigned(message)`, `byId(id)`, `byName(name)`, `list()`, `pinnedCertSet() → Set<hex>`, `peers() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }]`, `peerSource() → { list, on, removeListener }`, `markOnline(nodeId, hello) → { bootChanged }`, `markOffline(nodeId)`, `presence(nodeId) → { online, last_seen, boot_id, hello } | null`; statics `NodeRegistry.writeConsoleRecord(configDir, record)`, `NodeRegistry.removeConsoleRecord(configDir, nodeName) → boolean`, `NodeRegistry.consoleDir(configDir)`.
  - Record shape (§4.3): `{ node_id, node_name, profile, public_key, tls_fingerprint, source: 'phone' | 'console', accepted_at, signed }` (+ `confirmed_by: 'console'` on console records). Files: console `<configDir>/frontdoor-nodes/<node_id>.json` (admin-owned, read with `assertAdminOwned`), phone `<dataDir>/frontdoor/nodes.json` `{ v: 1, nodes: { [id]: record } }`, quarantine `<dataDir>/frontdoor/nodes.rejected.json` (append-only list). A phone record whose envelope no longer verifies (R25: `accepted_at < revoked_at` keeps it) is quarantined and raises `node_record_invalid` with `subject: 'node:<id>'`. A phone enrollment can neither replace nor remove a console record (`{ code: 'console_record' }`).
  - `new MeshTransport({ …, duplicatePingMs })`: a second inbound connection for a connected peer pings the old one; a `pong` within `duplicatePingMs` closes the new one with `4009 already_connected`, otherwise the old one is terminated and the new one takes over (Deviation 25: enforced where the second authenticated connection appears, the transport; the registry records presence).

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-registry.test.js`:

```js
// tests/frontdoor-registry.test.js — fleet stage 4 §3.6.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { NodeRegistry } = require('../src/frontdoor/router/node-registry');
const { MeshTransport, CLOSE_CODES } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { derivePeerId } = require('../src/mesh/mesh-identity');
const { rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const FD = testNodeIdentity({ key: 'relay' });
const A = createFakePhone({ seed: 'A' });
const B = createFakePhone({ seed: 'B' });
const alertsSink = () => ({ raised: [], raise(kind, opts) { this.raised.push([kind, opts]); return {}; } });

async function setup({ revokeB = null } = {}) {
  const records = [A.approverRecord(), B.approverRecord(revokeB ? { revokedAt: revokeB, revokedBy: 'console' } : {})];
  const store = await approverStoreWith(records, { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const alerts = alertsSink();
  const registry = new NodeRegistry({ configDir, dataDir, approverStore: store, frontdoorId: FD.nodeId, alerts, adminUid: UID, geteuid: () => UID });
  return { registry, configDir, dataDir, alerts, store };
}

function node(name, profile = 'agent') {
  const id = testNodeIdentity({ nodeName: name });
  return { id, raw: rawEd25519(id.publicKey), tls: crypto.randomBytes(32).toString('hex'), name, profile };
}

function enrollBy(phone, n, { replaces = null, signedAt = '2026-09-19T12:00:00.000Z' } = {}) {
  return phone.enrollNode({
    frontdoorId: FD.nodeId, signedAt,
    pairing: { pairing_id: `pr_${crypto.randomBytes(16).toString('base64url')}`, node_id: n.id.nodeId, node_name: n.name, profile: n.profile, public_key: n.raw, tls_fingerprint: n.tls, replaces }
  });
}

describe('NodeRegistry', () => {
  it('is the union of console and phone records, and feeds the hub hex peer ids', async () => {
    const { registry, configDir } = await setup();
    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, { node_id: web.id.nodeId, node_name: 'web-01', profile: 'runbook', public_key: web.raw, tls_fingerprint: web.tls, source: 'console', accepted_at: '2026-09-20T00:00:00.000Z', signed: null, confirmed_by: 'console' });
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    const gpu = node('gpu-box');
    registry.load();
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(registry.list().map((r) => [r.node_name, r.source]).sort(), [['gpu-box', 'phone'], ['web-01', 'console']]);
    const peers = registry.peers();
    const gpuPeer = peers.find((p) => p.nodeId === gpu.id.nodeId);
    assert.equal(gpuPeer.peerId, derivePeerId(gpu.id.publicKey.toString('hex')));
    assert.match(gpuPeer.peerId, /^kl-[0-9a-f]{12}$/);
    assert.equal(gpuPeer.publicKeyHex, gpu.id.publicKey.toString('hex'));
    assert.deepEqual([...registry.pinnedCertSet()].sort(), [gpu.tls, web.tls].sort());

    const reloaded = new NodeRegistry({ configDir, dataDir: registry.dataDir, approverStore: registry.approverStore, frontdoorId: FD.nodeId, adminUid: UID, geteuid: () => UID });
    reloaded.load();
    assert.equal(reloaded.list().length, 2);
  });

  it('quarantines a phone record that no longer verifies, and alerts', async () => {
    const { registry, dataDir, alerts } = await setup();
    const gpu = node('gpu-box');
    registry.load();
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const file = path.join(dataDir, 'frontdoor', 'nodes.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.nodes[gpu.id.nodeId].tls_fingerprint = 'f'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(stored));
    registry.load();
    assert.equal(registry.byId(gpu.id.nodeId), null);
    const rejected = JSON.parse(fs.readFileSync(path.join(dataDir, 'frontdoor', 'nodes.rejected.json'), 'utf8'));
    assert.equal(rejected[0].record.node_id, gpu.id.nodeId);
    assert.equal(rejected[0].reason, 'record_mismatch');
    assert.deepEqual(alerts.raised.at(-1), ['node_record_invalid', { subject: `node:${gpu.id.nodeId}`, detail: { reason: 'record_mismatch' } }]);
  });

  it('keeps a record accepted before its signer was revoked, drops one accepted after (R25)', async () => {
    const { registry, dataDir } = await setup({ revokeB: '2026-09-22T00:00:00.000Z' });
    const early = node('early');
    const late = node('late');
    const file = path.join(dataDir, 'frontdoor', 'nodes.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = (n, acceptedAt) => ({ node_id: n.id.nodeId, node_name: n.name, profile: n.profile, public_key: n.raw, tls_fingerprint: n.tls, source: 'phone', accepted_at: acceptedAt, signed: enrollBy(B, n) });
    fs.writeFileSync(file, JSON.stringify({ v: 1, nodes: { [early.id.nodeId]: rec(early, '2026-09-21T00:00:00.000Z'), [late.id.nodeId]: rec(late, '2026-09-23T00:00:00.000Z') } }));
    registry.load();
    assert.ok(registry.byId(early.id.nodeId));
    assert.equal(registry.byId(late.id.nodeId), null);
  });

  it('a re-pair with replaces swaps the pin; a phone cannot replace or remove a console node', async () => {
    const { registry, configDir } = await setup();
    registry.load();
    const oldKey = node('gpu-box');
    registry.addSigned(enrollBy(A, oldKey), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const events = [];
    registry.on('replaced', (e) => events.push(e));
    const newKey = node('gpu-box');
    registry.addSigned(enrollBy(A, newKey, { replaces: oldKey.id.nodeId }), { acceptedAt: '2026-09-22T00:00:00.000Z' });
    assert.equal(registry.byName('gpu-box').node_id, newKey.id.nodeId);
    assert.equal(registry.byId(oldKey.id.nodeId), null);
    assert.deepEqual(events, [{ oldId: oldKey.id.nodeId, newId: newKey.id.nodeId }]);
    assert.ok(!registry.pinnedCertSet().has(oldKey.tls));

    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, { node_id: web.id.nodeId, node_name: 'web-01', profile: 'runbook', public_key: web.raw, tls_fingerprint: web.tls, source: 'console', accepted_at: '2026-09-20T00:00:00.000Z', signed: null, confirmed_by: 'console' });
    registry.load();
    assert.throws(() => registry.addSigned(enrollBy(A, node('web-01', 'runbook'), { replaces: web.id.nodeId }), { acceptedAt: '2026-09-22T00:00:00.000Z' }), (err) => err.code === 'console_record');
    assert.throws(() => registry.removeSigned({ node_id: web.id.nodeId }), (err) => err.code === 'console_record');
    assert.equal(NodeRegistry.removeConsoleRecord(configDir, 'web-01'), true);
  });

  it('records presence and says when boot_id changed', async () => {
    const { registry } = await setup();
    registry.load();
    const gpu = node('gpu-box');
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'a'.repeat(32) }), { bootChanged: false });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'a'.repeat(32) }), { bootChanged: false });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'b'.repeat(32) }), { bootChanged: true });
    registry.markOffline(gpu.id.nodeId);
    assert.equal(registry.presence(gpu.id.nodeId).online, false);
  });
});

describe('one connection per node key', () => {
  async function hubAndNode() {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const nodeId = new NodeIdentity({ nodeName: 'gpu-box' });
    const hub = new MeshTransport({ identity: hubId, host: '127.0.0.1', port: 0, useTls: false, duplicatePingMs: 200 });
    await hub.start();
    cleanups.push(() => hub.stop());
    hub.addTrustedPeer(nodeId.peerId, nodeId.publicKey);
    const dial = async () => {
      const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      t.addTrustedPeer(hubId.peerId, hubId.publicKey);
      return t;
    };
    return { hub, hubId, nodeId, dial };
  }

  it('a second link while the first answers pings is closed with 4009', async () => {
    const { hub, hubId, nodeId, dial } = await hubAndNode();
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const firstWs = hub.getPeer(nodeId.peerId).ws;
    const second = await dial();
    const closed = once(second, 'peerDisconnected');
    await second.connectToPeer('127.0.0.1', hub.port);
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.alreadyConnected);
    assert.equal(hub.getPeer(nodeId.peerId).ws, firstWs, 'the first link stays');
  });

  it('a second link takes over when the old one does not answer', async () => {
    const { hub, hubId, nodeId, dial } = await hubAndNode();
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const oldWs = hub.getPeer(nodeId.peerId).ws;
    first.getPeer(hubId.peerId).ws._socket.pause(); // a dead link: no pong
    const second = await dial();
    await second.connectToPeer('127.0.0.1', hub.port);
    for (let i = 0; i < 100 && hub.getPeer(nodeId.peerId) && hub.getPeer(nodeId.peerId).ws === oldWs; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(hub.getPeer(nodeId.peerId).ws, oldWs);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-registry.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/router/node-registry'`.

- [ ] **Step 3: One connection per key in `MeshTransport`**

In `src/mesh/mesh-transport.js`:

1. In the constructor add:

```js
    // Fleet stage 4 §3.6: with a value, a second authenticated connection
    // for a connected peer pings the old one first (see _promoteToPeer).
    this.duplicatePingMs = Number.isInteger(config.duplicatePingMs) ? config.duplicatePingMs : null;
```

2. In `_promoteToPeer`, right after `this.unauth.delete(ws);` insert:

```js
    const current = this.peers.get(remoteIdentity.peerId);
    if (current && this.duplicatePingMs !== null && pending.direction === 'inbound' && !pending.duplicateSettled) {
      // A pong from the old link within duplicatePingMs: it is alive, and
      // the new one is refused (4009). No pong: the old one is dead (a node
      // that crashed inside the heartbeat window) and the new one takes over.
      this._settleDuplicate(current).then((oldAlive) => {
        if (oldAlive) {
          try { ws.close(CLOSE_CODES.alreadyConnected, 'already_connected'); } catch { /* gone */ }
          return;
        }
        current.disconnectReason = 'replaced';
        try { current.ws.terminate(); } catch { /* gone */ }
        this._promoteToPeer(authId, ws, remoteIdentity, { ...pending, duplicateSettled: true });
      });
      return;
    }
```

3. Add the method (next to `closePeer`):

```js
  _settleDuplicate(existing) {
    return new Promise((resolve) => {
      const ws = existing.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      const onPong = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { ws.removeListener('pong', onPong); resolve(false); }, this.duplicatePingMs);
      ws.once('pong', onPong);
      try {
        ws.ping();
      } catch {
        clearTimeout(timer);
        ws.removeListener('pong', onPong);
        resolve(false);
      }
    });
  }
```

- [ ] **Step 4: Write `src/frontdoor/router/node-registry.js`**

```js
// Which nodes the front door trusts (fleet stage 4 §3.6): the union of
// console-confirmed records (admin-written <configDir>/frontdoor-nodes/, read
// with the node.yaml ownership check) and phone-confirmed records
// (<dataDir>/frontdoor/nodes.json, each re-verified against the admin-owned
// approvers on every load; the signatures decide, not the directory).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { assertAdminOwned } = require('../../service/config');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { NODE_ID_RE, isTimestamp } = require('../../approvals/messages');
const { deriveNodeId } = require('../../mesh/node-identity');
const { derivePeerId } = require('../../mesh/mesh-identity');
const { spkiHexFromRaw, NODE_NAME_RE, RAW_ED25519_RE, HEX_SHA256_RE } = require('../protocol/messages');
const { verifyPhoneEnvelope } = require('../protocol/checks');
const { err } = require('../errors');

const log = createLogger('frontdoor/registry');

const CONSOLE_DIR = 'frontdoor-nodes';
const CONTROLS = { decides: 'which nodes this front door trusts', selfGrant: 'add a node of its own choosing' };
const PROFILES = ['agent', 'runbook'];
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

function derivedId(raw) {
  try {
    return deriveNodeId(spkiHexFromRaw(raw));
  } catch {
    return null;
  }
}

// null when the record is well formed, else the reason.
function recordProblem(r, source) {
  if (!r || typeof r !== 'object') return 'malformed';
  if (!NODE_ID_RE.test(r.node_id) || typeof r.node_name !== 'string' || !NODE_NAME_RE.test(r.node_name) || !PROFILES.includes(r.profile)) return 'malformed';
  if (typeof r.public_key !== 'string' || !RAW_ED25519_RE.test(r.public_key) || typeof r.tls_fingerprint !== 'string' || !HEX_SHA256_RE.test(r.tls_fingerprint)) return 'malformed';
  if (!isTimestamp(r.accepted_at) || r.source !== source) return 'malformed';
  if (derivedId(r.public_key) !== r.node_id) return 'node_id_mismatch';
  return null;
}

class NodeRegistry extends EventEmitter {
  constructor({ configDir, dataDir, approverStore, frontdoorId, alerts = null, adminUid = 0, geteuid = defaultGeteuid, now = Date.now } = {}) {
    super();
    this.configDir = configDir;
    this.dataDir = dataDir;
    this.approverStore = approverStore;
    this.frontdoorId = frontdoorId;
    this.alerts = alerts;
    this.adminUid = adminUid;
    this.geteuid = geteuid;
    this.now = now;
    this.phoneFile = path.join(dataDir, 'frontdoor', 'nodes.json');
    this.rejectedFile = path.join(dataDir, 'frontdoor', 'nodes.rejected.json');
    this.nodes = new Map();
    this.status = new Map();
  }

  static consoleDir(configDir) {
    return path.join(configDir, CONSOLE_DIR);
  }

  // Admin CLI only (`frontdoor code … --confirm`).
  static writeConsoleRecord(configDir, record) {
    const problem = recordProblem(record, 'console');
    if (problem) throw new Error(`refusing to write a console node record: ${problem}`);
    const dir = NodeRegistry.consoleDir(configDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileAtomic(path.join(dir, `${record.node_id}.json`), `${JSON.stringify(record, null, 2)}\n`, 0o644);
  }

  // Admin CLI only (`frontdoor remove-node <name>`).
  static removeConsoleRecord(configDir, nodeName) {
    const dir = NodeRegistry.consoleDir(configDir);
    if (!fs.existsSync(dir)) return false;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (r.node_name === nodeName) {
          fs.rmSync(path.join(dir, name));
          return true;
        }
      } catch {
        // not a record
      }
    }
    return false;
  }

  _invalid(record, reason) {
    const id = record && record.node_id ? record.node_id : 'unknown';
    log.error(`node record ${id} rejected: ${reason}`);
    if (this.alerts) this.alerts.raise('node_record_invalid', { subject: `node:${id}`, detail: { reason } });
  }

  _loadConsole() {
    const out = new Map();
    const dir = NodeRegistry.consoleDir(this.configDir);
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      let record;
      try {
        assertAdminOwned(file, this.geteuid, this.adminUid, CONTROLS);
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        this._invalid({ node_id: name.replace(/\.json$/, '') }, e.message);
        continue;
      }
      const problem = recordProblem(record, 'console') || (name !== `${record.node_id}.json` ? 'file_name_mismatch' : null);
      if (problem) {
        this._invalid(record, problem);
        continue;
      }
      out.set(record.node_id, { ...record, signed: null, confirmed_by: 'console' });
    }
    return out;
  }

  _phoneProblem(record) {
    const shape = recordProblem(record, 'phone');
    if (shape) return shape;
    const v = verifyPhoneEnvelope(record.signed, { approverStore: this.approverStore, type: 'kl.node.enroll', frontdoorId: this.frontdoorId, acceptedAt: record.accepted_at });
    if (!v.ok) return v.reason;
    const m = v.message;
    if (m.decision !== 'approve') return 'not_approved';
    for (const k of ['node_id', 'node_name', 'profile', 'public_key', 'tls_fingerprint']) if (m[k] !== record[k]) return 'record_mismatch';
    return null;
  }

  _readPhone() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.phoneFile, 'utf8'));
      return parsed && parsed.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : {};
    } catch {
      return {};
    }
  }

  _savePhone() {
    const nodes = {};
    for (const r of this.nodes.values()) if (r.source === 'phone') nodes[r.node_id] = r;
    fs.mkdirSync(path.dirname(this.phoneFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.phoneFile, `${JSON.stringify({ v: 1, nodes }, null, 2)}\n`);
  }

  _quarantine(entries) {
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(this.rejectedFile, 'utf8'));
    } catch {
      existing = [];
    }
    fs.mkdirSync(path.dirname(this.rejectedFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.rejectedFile, `${JSON.stringify([...(Array.isArray(existing) ? existing : []), ...entries], null, 2)}\n`);
  }

  load() {
    const nodes = this._loadConsole();
    const names = new Map([...nodes.values()].map((r) => [r.node_name, r.node_id]));
    const rejected = [];
    for (const record of Object.values(this._readPhone())) {
      let reason = this._phoneProblem(record);
      if (!reason && (nodes.has(record.node_id) || names.has(record.node_name))) reason = 'shadowed_by_console';
      if (reason) {
        rejected.push({ record, reason, at: new Date(this.now()).toISOString() });
        this._invalid(record, reason);
        continue;
      }
      nodes.set(record.node_id, record);
      names.set(record.node_name, record.node_id);
    }
    this.nodes = nodes;
    if (rejected.length) {
      this._quarantine(rejected);
      this._savePhone();
    }
    this.emit('change');
    return this.list();
  }

  // A phone-signed enrollment the pairing service already bound to its
  // pending pairing (checkNodeEnroll); the registry re-verifies the signature.
  addSigned(envelope, { acceptedAt = new Date(this.now()).toISOString() } = {}) {
    const v = verifyPhoneEnvelope(envelope, { approverStore: this.approverStore, type: 'kl.node.enroll', frontdoorId: this.frontdoorId });
    if (!v.ok) throw err(v.reason, `node enrollment refused: ${v.reason}`);
    const m = v.message;
    if (m.decision !== 'approve') throw err('not_approved', 'the phone denied this node');
    if (derivedId(m.public_key) !== m.node_id) throw err('node_id_mismatch', 'node_id does not derive from the key');
    const sameName = this.byName(m.node_name);
    const replacing = m.replaces ? this.byId(m.replaces) : null;
    for (const old of [sameName, replacing]) {
      if (old && old.source === 'console' && old.node_id !== m.node_id) {
        throw err('console_record', `"${old.node_name}" was confirmed at the front door console; replace it there with frontdoor code ${old.node_name} --confirm`);
      }
    }
    const record = { node_id: m.node_id, node_name: m.node_name, profile: m.profile, public_key: m.public_key, tls_fingerprint: m.tls_fingerprint, source: 'phone', accepted_at: acceptedAt, signed: envelope };
    const removed = new Set();
    for (const old of [sameName, replacing]) if (old && old.node_id !== m.node_id) removed.add(old.node_id);
    for (const id of removed) this.nodes.delete(id);
    this.nodes.set(record.node_id, record);
    this._savePhone();
    for (const id of removed) this.emit('replaced', { oldId: id, newId: record.node_id });
    this.emit('change');
    return record;
  }

  // A verified kl.node.remove (challenge checked by the caller).
  removeSigned(message) {
    const r = this.byId(message.node_id);
    if (!r) throw err('unknown_node', 'no such node');
    if (r.source === 'console') throw err('console_record', `"${r.node_name}" was confirmed at the console; remove it there with frontdoor remove-node ${r.node_name}`);
    this.nodes.delete(r.node_id);
    this._savePhone();
    this.emit('removed', { nodeId: r.node_id, reason: 'phone' });
    this.emit('change');
    return r;
  }

  byId(id) {
    return this.nodes.get(id) || null;
  }

  byName(name) {
    for (const r of this.nodes.values()) if (r.node_name === name) return r;
    return null;
  }

  list() {
    return [...this.nodes.values()].map(({ signed, ...rest }) => rest);
  }

  pinnedCertSet() {
    return new Set([...this.nodes.values()].map((r) => r.tls_fingerprint));
  }

  peers() {
    return [...this.nodes.values()].map((r) => {
      const publicKeyHex = spkiHexFromRaw(r.public_key);
      return { peerId: derivePeerId(publicKeyHex), publicKeyHex, name: r.node_name, tlsFingerprint: r.tls_fingerprint, nodeId: r.node_id };
    });
  }

  peerSource() {
    return { list: () => this.peers(), on: (ev, fn) => this.on(ev, fn), removeListener: (ev, fn) => this.removeListener(ev, fn) };
  }

  markOnline(nodeId, hello = {}) {
    const prev = this.status.get(nodeId);
    const bootChanged = Boolean(prev && prev.boot_id && hello.boot_id && prev.boot_id !== hello.boot_id);
    this.status.set(nodeId, { online: true, last_seen: new Date(this.now()).toISOString(), boot_id: hello.boot_id || (prev && prev.boot_id) || null, hello });
    return { bootChanged };
  }

  markOffline(nodeId) {
    const prev = this.status.get(nodeId) || {};
    this.status.set(nodeId, { ...prev, online: false, last_seen: new Date(this.now()).toISOString() });
  }

  presence(nodeId) {
    return this.status.get(nodeId) || null;
  }
}

module.exports = { NodeRegistry, recordProblem };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-registry.test.js tests/mesh-hardening.test.js tests/mesh-transport.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/frontdoor/router/node-registry.js src/mesh/mesh-transport.js tests/frontdoor-registry.test.js
git commit -m "feat(frontdoor): node registry of console and phone records; one link per node key" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: `AlertCenter` and the front door's own audit kinds

**Files:**
- Create: `src/frontdoor/alerts.js`
- Create: `src/frontdoor/audit/own-ledger.js`
- Test: `tests/frontdoor-alerts.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic`.
- Produces:
  - `ALERT_KINDS = ['acme_renewal_failing', 'tls_key_changed', 'audit_chain_break', 'audit_gap', 'refresh_reuse', 'unknown_node_key', 'dns_probe_failed', 'node_record_invalid', 'node_replaced']`.
  - `class AlertCenter({ file, now = Date.now, push = null, dedupeMs = 86400000, max = 500 })` with `raise(kind, { subject = null, detail = {} }) → alert | null` (`null` when deduplicated on `kind + subject` within 24 h), `list({ since = 0 }) → [{ id, kind, subject, detail, at, acked }]` (ids are increasing integers as strings), `ack(id) → boolean`, `unacked(kind = null)`, `unknownNodeKey({ fingerprint, ip })` (at most one alert a day: the first attempt of a UTC day raises `unknown_node_key` with `subject: <YYYY-MM-DD>`, later attempts update that alert's `detail = { count, top: [≤ 5 × { fingerprint, count, last_ip }] }` in place, no second push). `push(alert)` is called for each new alert (best effort). Persisted atomically to `<dataDir>/frontdoor/alerts.json`, oldest dropped past 500.
  - `src/frontdoor/audit/own-ledger.js`: `FRONT_DOOR_AUDIT_KINDS = ['frontdoor.grant.approved', 'frontdoor.grant.denied', 'frontdoor.grant.revoked', 'frontdoor.token.issued', 'frontdoor.refresh_reuse', 'frontdoor.node.enrolled', 'frontdoor.node.removed', 'frontdoor.node.replaced', 'frontdoor.pairing.code_issued', 'frontdoor.tls.repin', 'frontdoor.alert.ack']`, `recordFrontDoorEvent(ledger, kind, data) → Promise<void>` (refuses an unknown kind; audit failures are logged, never thrown).

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-alerts.test.js`:

```js
// tests/frontdoor-alerts.test.js — fleet stage 4 §3.12–3.13.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlertCenter, ALERT_KINDS } = require('../src/frontdoor/alerts');
const { recordFrontDoorEvent, FRONT_DOOR_AUDIT_KINDS } = require('../src/frontdoor/audit/own-ledger');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-alerts-')); temps.push(d); return path.join(d, 'alerts.json'); };

describe('AlertCenter', () => {
  it('raises, lists since an id, acks, and persists', async () => {
    let now = Date.parse('2026-09-23T10:00:00.000Z');
    const pushed = [];
    const f = file();
    const a = new AlertCenter({ file: f, now: () => now, push: (alert) => pushed.push(alert.id) });
    const first = a.raise('audit_chain_break', { subject: 'node:kl-hnef32472qzibi5r', detail: { seq: 4 } });
    const second = a.raise('dns_probe_failed', { subject: 'mesh.kl.example.com' });
    assert.deepEqual(a.list().map((x) => x.kind), ['audit_chain_break', 'dns_probe_failed']);
    assert.deepEqual(a.list({ since: first.id }).map((x) => x.id), [second.id]);
    assert.equal(a.ack(first.id), true);
    assert.equal(a.list()[0].acked, true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushed, [first.id, second.id]);
    const reloaded = new AlertCenter({ file: f, now: () => now });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.raise('tls_key_changed', { subject: 'x' }).id, String(Number(second.id) + 1));
  });

  it('deduplicates kind + subject within 24 h', () => {
    let now = 0;
    const a = new AlertCenter({ file: file(), now: () => now });
    assert.ok(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }));
    now += 23 * 3600000;
    assert.equal(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }), null);
    assert.ok(a.raise('acme_renewal_failing', { subject: 'other' }));
    now += 2 * 3600000;
    assert.ok(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }));
  });

  it('keeps at most 500 alerts, dropping the oldest', () => {
    const a = new AlertCenter({ file: file(), now: () => 0 });
    for (let i = 0; i < 510; i += 1) a.raise('node_record_invalid', { subject: `node:${i}` });
    const all = a.list();
    assert.equal(all.length, 500);
    assert.equal(all[0].subject, 'node:10');
  });

  it('unknown_node_key: one alert a day, a running summary, one push', async () => {
    let now = Date.parse('2026-09-23T01:00:00.000Z');
    const pushed = [];
    const a = new AlertCenter({ file: file(), now: () => now, push: (x) => pushed.push(x.kind) });
    for (let i = 0; i < 12; i += 1) a.unknownNodeKey({ fingerprint: `${'a'.repeat(63)}${i % 7}`, ip: `203.0.113.${i}` });
    const day = a.list().filter((x) => x.kind === 'unknown_node_key');
    assert.equal(day.length, 1);
    assert.equal(day[0].subject, '2026-09-23');
    assert.equal(day[0].detail.count, 12);
    assert.equal(day[0].detail.top.length, 5);
    assert.equal(day[0].detail.top[0].count, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushed, ['unknown_node_key']);
    now += 24 * 3600000;
    a.unknownNodeKey({ fingerprint: null, ip: '198.51.100.7' });
    assert.equal(a.list().filter((x) => x.kind === 'unknown_node_key').length, 2);
  });

  it('refuses an unknown kind', () => {
    assert.throws(() => new AlertCenter({ file: file() }).raise('made_up'), /unknown alert kind/);
    assert.ok(ALERT_KINDS.includes('node_replaced'));
  });
});

describe('the front door\'s own ledger', () => {
  it('appends only the §3.12 kinds, and never throws on an audit failure', async () => {
    const entries = [];
    const ledger = { append: async (e) => { entries.push(e); return e; } };
    await recordFrontDoorEvent(ledger, 'frontdoor.token.issued', { grant_id: 'gr_x', kind: 'access' });
    assert.deepEqual(entries, [{ kind: 'frontdoor.token.issued', data: { grant_id: 'gr_x', kind: 'access' } }]);
    await assert.rejects(recordFrontDoorEvent(ledger, 'frontdoor.made_up', {}), /unknown front-door audit kind/);
    await recordFrontDoorEvent({ append: async () => { throw new Error('disk full'); } }, 'frontdoor.alert.ack', { id: '1' });
    assert.equal(FRONT_DOOR_AUDIT_KINDS.length, 11);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-alerts.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/alerts'`.

- [ ] **Step 3: Write `src/frontdoor/alerts.js`**

```js
// What the front door tells the owner about (fleet stage 4 §3.13): a small
// persisted list the phone polls (GET /v1/alerts) and, when push is set up,
// is pushed as { kind: 'alert', id }. Deduplicated per kind + subject for a
// day, at most 500 kept.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/alerts');

const ALERT_KINDS = Object.freeze(['acme_renewal_failing', 'tls_key_changed', 'audit_chain_break', 'audit_gap', 'refresh_reuse',
  'unknown_node_key', 'dns_probe_failed', 'node_record_invalid', 'node_replaced']);
const TOP = 5;

class AlertCenter {
  constructor({ file, now = Date.now, push = null, dedupeMs = 86400000, max = 500 } = {}) {
    this.file = file;
    this.now = now;
    this.push = push;
    this.dedupeMs = dedupeMs;
    this.max = max;
    this.alerts = [];
    this.seq = 0;
    this.unknown = null; // { day, alertId, byFingerprint: Map }
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(stored.alerts)) this.alerts = stored.alerts;
      this.seq = Number.isInteger(stored.seq) ? stored.seq : this.alerts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
    } catch {
      // no alerts yet
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, seq: this.seq, alerts: this.alerts }, null, 2)}\n`);
  }

  _notify(alert) {
    if (!this.push) return;
    Promise.resolve()
      .then(() => this.push(alert))
      .catch((e) => log.warn(`alert push failed: ${e.message}`));
  }

  raise(kind, { subject = null, detail = {} } = {}) {
    if (!ALERT_KINDS.includes(kind)) throw new Error(`unknown alert kind ${kind}`);
    const t = this.now();
    const recent = this.alerts.find((a) => a.kind === kind && a.subject === subject && t - Date.parse(a.at) < this.dedupeMs);
    if (recent) return null;
    this.seq += 1;
    const alert = { id: String(this.seq), kind, subject, detail, at: new Date(t).toISOString(), acked: false };
    this.alerts.push(alert);
    if (this.alerts.length > this.max) this.alerts.splice(0, this.alerts.length - this.max);
    this._save();
    log.warn(`alert ${kind}${subject ? ` (${subject})` : ''}`);
    this._notify(alert);
    return alert;
  }

  list({ since = 0 } = {}) {
    const after = Number(since) || 0;
    return this.alerts.filter((a) => Number(a.id) > after).map((a) => ({ ...a }));
  }

  unacked(kind = null) {
    return this.alerts.filter((a) => !a.acked && (kind === null || a.kind === kind)).map((a) => ({ ...a }));
  }

  ack(id) {
    const a = this.alerts.find((x) => x.id === String(id));
    if (!a) return false;
    a.acked = true;
    this._save();
    return true;
  }

  // §3.13: an unknown certificate on mesh. is counted, never more than one
  // alert a day; the day's alert carries a running summary.
  unknownNodeKey({ fingerprint = null, ip = null } = {}) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (!this.unknown || this.unknown.day !== day) {
      this.unknown = { day, alertId: null, byFingerprint: new Map() };
    }
    const key = fingerprint || '(none)';
    const entry = this.unknown.byFingerprint.get(key) || { fingerprint, count: 0, last_ip: null };
    entry.count += 1;
    entry.last_ip = ip;
    this.unknown.byFingerprint.set(key, entry);
    const all = [...this.unknown.byFingerprint.values()];
    const detail = { count: all.reduce((n, e) => n + e.count, 0), top: all.sort((a, b) => b.count - a.count).slice(0, TOP).map((e) => ({ ...e })) };
    if (this.unknown.alertId === null) {
      const alert = this.raise('unknown_node_key', { subject: day, detail });
      if (alert) this.unknown.alertId = alert.id;
      return;
    }
    const existing = this.alerts.find((a) => a.id === this.unknown.alertId);
    if (existing) {
      existing.detail = detail;
      this._save();
    }
  }
}

module.exports = { AlertCenter, ALERT_KINDS };
```

- [ ] **Step 4: Write `src/frontdoor/audit/own-ledger.js`**

```js
// The front door's own ledger (§3.12): F3's AuditLedger in its data dir,
// with these kinds. It is served like a node's history (node_id =
// frontdoor_id) and is not mirrored anywhere (R54, deferred).
const { createLogger } = require('../../logging');

const log = createLogger('frontdoor/audit');

const FRONT_DOOR_AUDIT_KINDS = Object.freeze([
  'frontdoor.grant.approved', 'frontdoor.grant.denied', 'frontdoor.grant.revoked',
  'frontdoor.token.issued', 'frontdoor.refresh_reuse',
  'frontdoor.node.enrolled', 'frontdoor.node.removed', 'frontdoor.node.replaced',
  'frontdoor.pairing.code_issued', 'frontdoor.tls.repin', 'frontdoor.alert.ack'
]);

async function recordFrontDoorEvent(ledger, kind, data = {}) {
  if (!FRONT_DOOR_AUDIT_KINDS.includes(kind)) throw new Error(`unknown front-door audit kind ${kind}`);
  if (!ledger) return;
  try {
    await ledger.append({ kind, data });
  } catch (err) {
    log.warn(`audit ${kind} failed: ${err.message}`);
  }
}

module.exports = { FRONT_DOOR_AUDIT_KINDS, recordFrontDoorEvent };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/frontdoor-alerts.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/frontdoor/alerts.js src/frontdoor/audit/own-ledger.js tests/frontdoor-alerts.test.js
git commit -m "feat(frontdoor): alert center and the front door's own audit kinds" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 4

Part 3 leaves the front door's transport and trust stores: the ClientHello parser and SNI listener, ACME with the stable key and operator TLS (`acme-client` 5.4.0), F3's relay behind an external listener with the front door as its own node, the node registry with one link per key, and the alert center. Part 4 (`docs/superpowers/plans/2026-09-23-fleet-stage4-front-door-part4.md`) builds OAuth 2.1 and the MCP endpoint on top of them.
