# Fleet Stage 4: Front door — Implementation Plan (Part 6 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both phone apps the front door (spec §3.15): the `client-grant-v1` messages, checks and vectors in each protocol core, then Connect a client, Connected clients, Confirm a node, the front door's node list, Alerts, the history's front-door markers and the signed re-pin.

**Architecture:** The protocol work lands in the shared cores first (`mobile/ios/KLProtocol`, `mobile/android/protocol`), test-driven against `tests/vectors/client-grant-v1` exactly as F3's cores run `approval-v1`; the apps then call the cores and the phone routes of Parts 4–5. Nothing in `src/` changes in this part. Parts 1–5 must be on the branch (the vectors come from Part 1, the routes from Parts 4–5).

**Tech Stack:** Swift 5.9 (Foundation, CryptoKit, SwiftUI, XCTest; iOS 17), Kotlin 2.0 (kotlinx.serialization, Jetpack Compose, JUnit 4; JVM 17). No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-fleet-stage4-front-door.md`. **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. **F3 spec (bound):** `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`. **Protocol:** `docs/protocol/client-grant-v1.md` (Part 1, Task 3).

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

### Task 35: `client-grant-v1` in the iOS protocol core

**Files:**
- Create: `mobile/ios/KLProtocol/Sources/KLProtocol/FrontDoor.swift`
- Test: `mobile/ios/KLProtocol/Tests/KLProtocolTests/FrontDoorVectorTests.swift`

**Interfaces:**
- Consumes: Task 3's vectors (`tests/vectors/client-grant-v1/`, the phone set: `grant-approve`, `grant-deny`, `revoke-valid`, `enroll-valid`, `remove-valid`, `repin-valid`, `repin-reject-bad-signature`, `fingerprint-grouping`) and `tests/vectors/approval-v1/keys.json`; F3's `KLProtocol` (`JSONValue`, `JCS`, `Envelope`, `Base64URL`, `Hex`, `Identifiers`, `Rules`, `ExactText`, `ProtocolError`).
- Produces (all `public` in `KLProtocol`):
  - `struct ScopeChoice { scope: String; machines: [String]? }`.
  - `enum FrontDoor`: `normalizeUserCode(_:) -> String?`, `formatUserCode(_:) -> String`, `nodeFingerprint(_:) -> String` (`kl-xxxx xxxx xxxx xxxx`), `isMachineName(_:) -> Bool`, `scopesJSON(_:) -> JSONValue` (sorted by scope, machines sorted and de-duplicated), the builders `clientGrant(frontdoorId:pending:userCode:scopes:decision:nonce:deviceId:signedAt:)`, `clientRevoke(frontdoorId:grantId:challenge:deviceId:signedAt:)`, `nodeEnroll(frontdoorId:pairing:decision:nonce:deviceId:signedAt:)`, `nodeRemove(frontdoorId:nodeId:challenge:deviceId:signedAt:)` (each `throws ProtocolError.malformed` instead of returning a message the front door would refuse), `validate(_:_:) -> String?` for the five client-grant-v1 types a phone writes or reads, and `verifyRepin(_:frontdoorId:frontdoorKeyHex:receivedSpki:currentPin:) -> RepinCheck` (`ok`, `reason`, `newSpki`; the node's `verifyRepin` order and reasons).
  - `struct GrantRequest` (`init(json:)` over the `GET /v1/grants/pending` reply, `redirectHost`, `message(…)`), `struct PairingRequest` (`init(json:)` over one `GET /v1/pairings/pending` entry; refuses a `node_id` that does not derive from `public_key`; `fingerprint`, `message(…)`).

- [ ] **Step 1: Write the failing test**

Create `mobile/ios/KLProtocol/Tests/KLProtocolTests/FrontDoorVectorTests.swift`:

```swift
import XCTest
@testable import KLProtocol

/// Runs every client-grant-v1 vector whose consumers include "ios"
/// (tests/vectors/client-grant-v1, shared with the front door and Android).
final class FrontDoorVectorTests: XCTestCase {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }()
    static let vectorsDir = root.appendingPathComponent("tests/vectors/client-grant-v1")

    func vector(_ name: String) throws -> JSONValue {
        try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent("\(name).json")))
    }

    func deviceA() throws -> (id: String, x: String, y: String) {
        let keys = try JSONParser.parse(try Data(contentsOf: Self.root.appendingPathComponent("tests/vectors/approval-v1/keys.json")))
        let a = keys["devices"]!["A"]!
        return (a["id"]!.stringValue!, a["jwk"]!["x"]!.stringValue!, a["jwk"]!["y"]!.stringValue!)
    }

    func payload(_ v: JSONValue) throws -> Data {
        try Envelope(json: v["input"]!).payloadData()
    }

    func string(_ v: JSONValue?, _ key: String) -> String {
        v![key]!.stringValue!
    }

    func testEveryIosVectorIsCovered() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.vectorsDir.path).filter { $0.hasSuffix(".json") }
        let names = try Set(files.map { try JSONParser.parse(try Data(contentsOf: Self.vectorsDir.appendingPathComponent($0))) }
            .filter { ($0["consumers"]?.arrayValue ?? []).contains(.string("ios")) }
            .compactMap { $0["name"]?.stringValue })
        XCTAssertEqual(names, ["grant-approve", "grant-deny", "revoke-valid", "enroll-valid", "remove-valid",
                               "repin-valid", "repin-reject-bad-signature", "fingerprint-grouping"])
    }

    /// The phone builds exactly the committed bytes, sorting what the owner chose.
    func testGrantApproveBytes() throws {
        let v = try vector("grant-approve")
        let expect = v["expect"]!["message"]!
        let choices = [ScopeChoice(scope: "fleet:run", machines: ["web-01", "gpu-box", "web-01"]), ScopeChoice(scope: "fleet:read")]
        let built = try FrontDoor.clientGrant(frontdoorId: string(v["given"]!["frontdoor"], "id"), pending: v["given"]!["pending"]!, userCode: "q7k-m2x",
                                              scopes: choices, decision: "approve", nonce: string(expect, "nonce"),
                                              deviceId: string(expect, "device_id"), signedAt: string(expect, "signed_at"))
        XCTAssertEqual(built, expect)
        XCTAssertEqual(JCS.data(built), try payload(v))
        let a = try deviceA()
        XCTAssertTrue(try Envelope(json: v["input"]!).verifyES256(x: a.x, y: a.y))
        XCTAssertNil(FrontDoor.validate("kl.client.grant", built))
    }

    func testGrantDenyBytes() throws {
        let v = try vector("grant-deny")
        let expect = v["expect"]!["message"]!
        let built = try FrontDoor.clientGrant(frontdoorId: string(v["given"]!["frontdoor"], "id"), pending: v["given"]!["pending"]!, userCode: "Q7KM2X",
                                              scopes: [ScopeChoice(scope: "fleet:read")], decision: "deny", nonce: string(expect, "nonce"),
                                              deviceId: string(expect, "device_id"), signedAt: string(expect, "signed_at"))
        XCTAssertEqual(JCS.data(built), try payload(v))
    }

    func testRevokeEnrollRemoveBytes() throws {
        let revoke = try vector("revoke-valid")
        let r = revoke["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try FrontDoor.clientRevoke(frontdoorId: string(r, "frontdoor_id"), grantId: string(r, "grant_id"),
                                                            challenge: string(revoke["given"]!["challenges"]![0], "challenge"),
                                                            deviceId: string(r, "device_id"), signedAt: string(r, "signed_at"))), try payload(revoke))

        let enroll = try vector("enroll-valid")
        let e = enroll["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try FrontDoor.nodeEnroll(frontdoorId: string(e, "frontdoor_id"), pairing: enroll["given"]!["pairing"]!, decision: "approve",
                                                          nonce: string(e, "nonce"), deviceId: string(e, "device_id"), signedAt: string(e, "signed_at"))), try payload(enroll))

        let remove = try vector("remove-valid")
        let m = remove["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try FrontDoor.nodeRemove(frontdoorId: string(m, "frontdoor_id"), nodeId: string(m, "node_id"),
                                                          challenge: string(remove["given"]!["challenges"]![0], "challenge"),
                                                          deviceId: string(m, "device_id"), signedAt: string(m, "signed_at"))), try payload(remove))
    }

    func testRepin() throws {
        for name in ["repin-valid", "repin-reject-bad-signature"] {
            let v = try vector(name)
            let g = v["given"]!
            let keyHex = Identifiers.ed25519SpkiPrefix + Hex.encode(try Base64URL.decode(string(g["frontdoor"], "key")))
            let check = FrontDoor.verifyRepin(v["input"]!, frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: keyHex,
                                              receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin"))
            XCTAssertEqual(check.ok, v["expect"]!["accepted"]!.boolValue, name)
            XCTAssertEqual(check.reason.map { JSONValue.string($0) } ?? .null, v["expect"]!["reason"]!, name)
            if check.ok { XCTAssertEqual(check.newSpki, string(g, "received_spki")) }
        }
        let v = try vector("repin-valid")
        let g = v["given"]!
        let keyHex = Identifiers.ed25519SpkiPrefix + Hex.encode(try Base64URL.decode(string(g["frontdoor"], "key")))
        let other = "sha256/" + String(repeating: "A", count: 43)
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: keyHex, receivedSpki: other, currentPin: string(g, "current_pin")).reason, "spki_mismatch")
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: other).reason, "old_pin_mismatch")
        XCTAssertEqual(FrontDoor.verifyRepin(v["input"]!, frontdoorId: "kl-aaaaaaaaaaaaaaaa", frontdoorKeyHex: keyHex, receivedSpki: string(g, "received_spki"), currentPin: string(g, "current_pin")).reason, "wrong_frontdoor")
        XCTAssertEqual(FrontDoor.verifyRepin(.string("x"), frontdoorId: string(g["frontdoor"], "id"), frontdoorKeyHex: keyHex, receivedSpki: other, currentPin: other).reason, "malformed")
    }

    func testFingerprintsAndUserCodes() throws {
        let v = try vector("fingerprint-grouping")
        let ids = v["input"]!["node_ids"]!.arrayValue!.map { $0.stringValue! }
        XCTAssertEqual(ids.map { JSONValue.string(FrontDoor.nodeFingerprint($0)) }, v["expect"]!["node_fingerprints"]!.arrayValue)
        let typed = v["input"]!["typed_codes"]!.arrayValue!.map { $0.stringValue! }
        let normalized = typed.map { FrontDoor.normalizeUserCode($0) }
        XCTAssertEqual(normalized.map { $0.map { JSONValue.string($0) } ?? .null }, v["expect"]!["user_codes"]!.arrayValue)
        XCTAssertEqual(normalized.map { $0.map { JSONValue.string(FrontDoor.formatUserCode($0)) } ?? .null }, v["expect"]!["displayed"]!.arrayValue)
        XCTAssertTrue(FrontDoor.isMachineName("gpu-box"))
        XCTAssertFalse(FrontDoor.isMachineName("GPU-box"))
    }

    /// What the front door refuses as malformed, the phone never signs.
    func testBuildersRefuse() throws {
        let v = try vector("grant-approve")
        let fd = string(v["given"]!["frontdoor"], "id")
        let pending = v["given"]!["pending"]!
        let a = try deviceA()
        func grant(_ p: JSONValue, code: String = "Q7KM2X", _ scopes: [ScopeChoice]) throws -> JSONValue {
            try FrontDoor.clientGrant(frontdoorId: fd, pending: p, userCode: code, scopes: scopes, decision: "approve",
                                      nonce: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z")
        }
        XCTAssertThrowsError(try grant(pending, []))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:run", machines: ["Web-01"])]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:run", machines: [])]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "fleet:read"), ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try grant(pending, [ScopeChoice(scope: "Fleet:read")]))
        XCTAssertThrowsError(try grant(pending, code: "Q7KM2", [ScopeChoice(scope: "fleet:read")]))
        var long = pending.objectValue!
        long["client_name"] = .string(String(repeating: "\u{1F600}", count: 201))
        XCTAssertThrowsError(try grant(.object(long), [ScopeChoice(scope: "fleet:read")]))
        long["client_name"] = .string(String(repeating: "\u{1F600}", count: 200))
        XCTAssertNoThrow(try grant(.object(long), [ScopeChoice(scope: "fleet:read")]))
        XCTAssertThrowsError(try FrontDoor.clientRevoke(frontdoorId: fd, grantId: "gr_short", challenge: Messages.randomNonce(), deviceId: a.id, signedAt: "2026-09-23T18:04:13.201Z"))
    }

    func testGrantAndPairingRequests() throws {
        let v = try vector("grant-approve")
        var reply = v["given"]!["pending"]!.objectValue!
        for k in ["user_code", "expires_at", "claimed_by", "used_nonces"] { reply.removeValue(forKey: k) }
        reply["preselected"] = .array([.string("fleet:read")])
        reply["expires_in_ms"] = .number("280000")
        let request = try GrantRequest(json: .object(reply))
        XCTAssertEqual(request.clientName, "Example Client")
        XCTAssertEqual(request.redirectHost, "client.example.com")
        XCTAssertEqual(request.requestedScopes, ["fleet:read", "fleet:run"])
        XCTAssertEqual(request.preselected, ["fleet:read"])
        var bad = reply
        bad["grant_id"] = .string("gr_x")
        XCTAssertThrowsError(try GrantRequest(json: .object(bad)))

        let e = try vector("enroll-valid")
        var entry = e["given"]!["pairing"]!.objectValue!
        entry.removeValue(forKey: "expires_at")
        entry.removeValue(forKey: "used_nonces")
        entry["expires_in_ms"] = .number("500000")
        let pairing = try PairingRequest(json: .object(entry))
        XCTAssertEqual(pairing.fingerprint, FrontDoor.nodeFingerprint(string(e["given"]!["pairing"], "node_id")))
        let m = e["expect"]!["message"]!
        XCTAssertEqual(JCS.data(try pairing.message(frontdoorId: string(m, "frontdoor_id"), decision: "approve", nonce: string(m, "nonce"),
                                                    deviceId: string(m, "device_id"), signedAt: string(m, "signed_at"))), try Envelope(json: e["input"]!).payloadData())
        entry["node_id"] = .string("kl-aaaaaaaaaaaaaaaa")
        XCTAssertThrowsError(try PairingRequest(json: .object(entry)))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run (macOS, from `mobile/ios/KLProtocol`): `swift test --filter FrontDoorVectorTests`
Expected: FAIL to compile — `cannot find 'FrontDoor' in scope`.

- [ ] **Step 3: Write `mobile/ios/KLProtocol/Sources/KLProtocol/FrontDoor.swift`**

```swift
import Foundation

/// A scope the owner grants to a client, with an optional machine limit
/// (client-grant-v1 §3.1).
public struct ScopeChoice: Equatable {
    public let scope: String
    public let machines: [String]?

    public init(scope: String, machines: [String]? = nil) {
        self.scope = scope
        self.machines = machines
    }
}

/// The result of checking a `kl.relay.repin` (client-grant-v1 §5).
public struct RepinCheck: Equatable {
    public let ok: Bool
    public let reason: String?
    public let newSpki: String?
}

/// client-grant-v1 (docs/protocol/client-grant-v1.md): what a phone builds
/// for a front door and what it checks from one. Each builder applies the
/// front door's own rules first, so the phone never signs something the
/// front door would refuse as `malformed`.
public enum FrontDoor {
    static let userCodeAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

    /// What the owner typed, as the grant carries it: upper case, no `-` or
    /// spaces, O→0 and I/L→1; nil unless that is six alphabet characters.
    public static func normalizeUserCode(_ text: String) -> String? {
        var out = ""
        for ch in text.uppercased() {
            if ch == "-" || ch.isWhitespace { continue }
            switch ch {
            case "O": out.append("0")
            case "I", "L": out.append("1")
            default: out.append(ch)
            }
        }
        let bytes = Array(out.utf8)
        guard bytes.count == 6, bytes.allSatisfy({ userCodeAlphabet.contains($0) }) else { return nil }
        return out
    }

    /// `Q7KM2X` → `Q7K-M2X`, as the browser shows it.
    public static func formatUserCode(_ code: String) -> String {
        String(code.prefix(3)) + "-" + String(code.dropFirst(3))
    }

    /// `kl-3v7q2m4k8d1x9c0a` → `kl-3v7q 2m4k 8d1x 9c0a`.
    public static func nodeFingerprint(_ nodeId: String) -> String {
        "kl-" + Identifiers.fingerprintGroups(nodeId)
    }

    /// A node name a grant can limit to (`machines=`): `^[a-z0-9][a-z0-9._-]{0,62}$`.
    /// Other names can only be granted without a limit (Deviation 18).
    public static func isMachineName(_ name: String) -> Bool {
        FrontDoorRules.isMachineName(name)
    }

    /// Sorted by scope; each machine list sorted and de-duplicated.
    public static func scopesJSON(_ choices: [ScopeChoice]) -> JSONValue {
        let sorted = choices.sorted { JCS.utf16Less($0.scope, $1.scope) }
        return .array(sorted.map { choice in
            let machines: JSONValue = choice.machines.map { list -> JSONValue in
                var seen: [String] = []
                for name in list where !seen.contains(where: { ExactText.same($0, name) }) { seen.append(name) }
                return .array(seen.sorted(by: JCS.utf16Less).map { .string($0) })
            } ?? .null
            return .object(["scope": .string(choice.scope), "machines": machines])
        })
    }

    private static func field(_ v: JSONValue, _ key: String) throws -> String {
        guard let s = v[key]?.stringValue else { throw ProtocolError.malformed("missing \(key)") }
        return s
    }

    /// kl.client.grant for a pending authorization (the `GET /v1/grants/pending`
    /// reply) and the code the owner typed. `deny` carries no scopes.
    public static func clientGrant(frontdoorId: String, pending: JSONValue, userCode: String, scopes: [ScopeChoice], decision: String,
                                   nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        guard let code = normalizeUserCode(userCode) else { throw ProtocolError.malformed("the code is six letters and digits") }
        return try checked("kl.client.grant", .object([
            "v": .number("1"),
            "type": .string("kl.client.grant"),
            "frontdoor_id": .string(frontdoorId),
            "grant_id": .string(try field(pending, "grant_id")),
            "client_id": .string(try field(pending, "client_id")),
            "client_name": .string(try field(pending, "client_name")),
            "redirect_uri": .string(try field(pending, "redirect_uri")),
            "resource": .string(try field(pending, "resource")),
            "code_challenge": .string(try field(pending, "code_challenge")),
            "user_code": .string(code),
            "scopes": ExactText.same(decision, "deny") ? .array([]) : scopesJSON(scopes),
            "decision": .string(decision),
            "nonce": .string(nonce),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    public static func clientRevoke(frontdoorId: String, grantId: String, challenge: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try checked("kl.client.revoke", .object([
            "v": .number("1"),
            "type": .string("kl.client.revoke"),
            "frontdoor_id": .string(frontdoorId),
            "grant_id": .string(grantId),
            "challenge": .string(challenge),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// kl.node.enroll for one pending pairing (a `GET /v1/pairings/pending` entry).
    public static func nodeEnroll(frontdoorId: String, pairing: JSONValue, decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        let replaces: JSONValue = pairing["replaces"]?.stringValue.map { .string($0) } ?? .null
        return try checked("kl.node.enroll", .object([
            "v": .number("1"),
            "type": .string("kl.node.enroll"),
            "frontdoor_id": .string(frontdoorId),
            "pairing_id": .string(try field(pairing, "pairing_id")),
            "node_id": .string(try field(pairing, "node_id")),
            "node_name": .string(try field(pairing, "node_name")),
            "profile": .string(try field(pairing, "profile")),
            "public_key": .string(try field(pairing, "public_key")),
            "tls_fingerprint": .string(try field(pairing, "tls_fingerprint")),
            "replaces": replaces,
            "decision": .string(decision),
            "nonce": .string(nonce),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    public static func nodeRemove(frontdoorId: String, nodeId: String, challenge: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try checked("kl.node.remove", .object([
            "v": .number("1"),
            "type": .string("kl.node.remove"),
            "frontdoor_id": .string(frontdoorId),
            "node_id": .string(nodeId),
            "challenge": .string(challenge),
            "device_id": .string(deviceId),
            "signed_at": .string(signedAt)
        ]))
    }

    /// nil when well formed, else `malformed` or `unsupported_version`.
    public static func validate(_ type: String, _ message: JSONValue) -> String? {
        guard let m = message.objectValue, let t = m["type"]?.stringValue, ExactText.same(t, type),
              let v = m["v"], Rules.isInteger(v) else { return "malformed" }
        guard v == .number("1") else { return "unsupported_version" }
        guard let rule = FrontDoorRules.byType[type] else { return "malformed" }
        return rule(m) ? nil : "malformed"
    }

    private static func checked(_ type: String, _ message: JSONValue) throws -> JSONValue {
        if let reason = validate(type, message) { throw ProtocolError.malformed("not a valid \(type): \(reason)") }
        return message
    }

    /// The re-pin rule (stage 4 spec §3.3.1): the envelope verifies against the
    /// front-door key pinned from the kl.pair code, `new_spki` is the key just
    /// received, and `old_spki` is the current pin. Reasons in the front
    /// door's own order.
    public static func verifyRepin(_ envelopeJSON: JSONValue, frontdoorId: String, frontdoorKeyHex: String, receivedSpki: String, currentPin: String) -> RepinCheck {
        func fail(_ reason: String) -> RepinCheck { RepinCheck(ok: false, reason: reason, newSpki: nil) }
        guard let envelope = try? Envelope(json: envelopeJSON), let message = try? envelope.message() else { return fail("malformed") }
        if let reason = validate("kl.relay.repin", message) { return fail(reason) }
        guard ExactText.same(envelope.alg, "Ed25519") else { return fail("malformed") }
        guard ExactText.same(envelope.kid, frontdoorId), let fd = message["frontdoor_id"]?.stringValue, ExactText.same(fd, frontdoorId) else { return fail("wrong_frontdoor") }
        guard envelope.verifyEd25519(spkiHex: frontdoorKeyHex) else { return fail("bad_signature") }
        guard let newSpki = message["new_spki"]?.stringValue, ExactText.same(newSpki, receivedSpki) else { return fail("spki_mismatch") }
        guard let oldSpki = message["old_spki"]?.stringValue, ExactText.same(oldSpki, currentPin) else { return fail("old_pin_mismatch") }
        return RepinCheck(ok: true, reason: nil, newSpki: newSpki)
    }
}

/// One `GET /v1/grants/pending` reply: a connection request the owner found
/// by typing its code. Everything in it is the front door's (and the
/// client's) word; the app shows `clientName` as self-declared.
public struct GrantRequest: Equatable {
    public let json: JSONValue
    public let grantId: String
    public let clientId: String
    public let clientName: String
    public let clientHost: String
    public let redirectUri: String
    public let resource: String
    public let requestedScopes: [String]
    public let preselected: [String]
    public let expiresInMs: Int

    public init(json: JSONValue) throws {
        guard FrontDoorRules.isGrantId(json["grant_id"]), FrontDoorRules.isClientId(json["client_id"]),
              Rules.withinLength(json["client_name"], FrontDoorRules.clientNameMax), let host = json["client_host"]?.stringValue,
              FrontDoorRules.isUri(json["redirect_uri"]), FrontDoorRules.isUri(json["resource"]),
              FrontDoorRules.isCodeChallenge(json["code_challenge"]),
              let requested = json["requested_scopes"]?.arrayValue, let preselected = json["preselected"]?.arrayValue,
              let expires = json["expires_in_ms"]?.intValue else {
            throw ProtocolError.malformed("the front door sent a connection request this app cannot read")
        }
        let requestedScopes = requested.compactMap { $0.stringValue }.filter(FrontDoorRules.isScopeName)
        guard requestedScopes.count == requested.count else { throw ProtocolError.malformed("unknown scope names in the request") }
        self.json = json
        grantId = json["grant_id"]!.stringValue!
        clientId = json["client_id"]!.stringValue!
        clientName = json["client_name"]!.stringValue!
        clientHost = host
        redirectUri = json["redirect_uri"]!.stringValue!
        resource = json["resource"]!.stringValue!
        self.requestedScopes = requestedScopes
        self.preselected = preselected.compactMap { $0.stringValue }.filter { p in requestedScopes.contains { ExactText.same($0, p) } }
        expiresInMs = max(0, expires)
    }

    /// The host the browser returns to (the redirect URI's).
    public var redirectHost: String {
        URLComponents(string: redirectUri)?.host ?? redirectUri
    }

    public func message(frontdoorId: String, userCode: String, scopes: [ScopeChoice], decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try FrontDoor.clientGrant(frontdoorId: frontdoorId, pending: json, userCode: userCode, scopes: scopes, decision: decision,
                                  nonce: nonce, deviceId: deviceId, signedAt: signedAt)
    }
}

/// One `GET /v1/pairings/pending` entry: a node that proved a pairing code.
/// Its id must derive from its key, so the fingerprint shown is the key's.
public struct PairingRequest: Equatable {
    public let json: JSONValue
    public let pairingId: String
    public let nodeId: String
    public let nodeName: String
    public let profile: String
    public let replaces: String?
    public let expiresInMs: Int

    public init(json: JSONValue) throws {
        guard FrontDoorRules.isPairingId(json["pairing_id"]), Rules.isNodeId(json["node_id"]),
              let name = json["node_name"]?.stringValue, FrontDoorRules.isNodeName(name),
              Rules.isOneOf(json["profile"], ["agent", "runbook"]), FrontDoorRules.isRawEd25519(json["public_key"]),
              FrontDoorRules.isHex64(json["tls_fingerprint"]),
              json["replaces"]?.isNull == true || Rules.isNodeId(json["replaces"]),
              let expires = json["expires_in_ms"]?.intValue,
              let raw = try? Base64URL.decode(json["public_key"]!.stringValue!), raw.count == 32,
              ExactText.same(Identifiers.nodeId(ed25519Raw: raw), json["node_id"]!.stringValue!) else {
            throw ProtocolError.malformed("the front door sent a pairing this app cannot verify")
        }
        self.json = json
        pairingId = json["pairing_id"]!.stringValue!
        nodeId = json["node_id"]!.stringValue!
        nodeName = name
        profile = json["profile"]!.stringValue!
        replaces = json["replaces"]?.stringValue
        expiresInMs = max(0, expires)
    }

    public var fingerprint: String { FrontDoor.nodeFingerprint(nodeId) }

    public func message(frontdoorId: String, decision: String, nonce: String, deviceId: String, signedAt: String) throws -> JSONValue {
        try FrontDoor.nodeEnroll(frontdoorId: frontdoorId, pairing: json, decision: decision, nonce: nonce, deviceId: deviceId, signedAt: signedAt)
    }
}

/// The front door's validators (src/frontdoor/protocol/messages.js) for the
/// types a phone writes or reads.
enum FrontDoorRules {
    typealias Fields = [String: JSONValue]

    static let byType: [String: (Fields) -> Bool] = [
        "kl.client.grant": grant,
        "kl.client.revoke": revoke,
        "kl.node.enroll": enroll,
        "kl.node.remove": remove,
        "kl.relay.repin": repin
    ]

    static let clientNameMax = 200
    static let uriMax = 2048
    static let clientIdMax = 512
    static let maxScopes = 32
    static let maxMachines = 64

    static func isLower(_ c: UInt8) -> Bool { c >= 0x61 && c <= 0x7A }
    static func isUpper(_ c: UInt8) -> Bool { c >= 0x41 && c <= 0x5A }
    static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }
    static func isOneOfBytes(_ c: UInt8, _ set: String) -> Bool { set.utf8.contains(c) }

    static func prefixedToken(_ v: JSONValue?, _ prefix: String, _ length: Int) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        let p = Array(prefix.utf8)
        return b.count == p.count + length && Array(b[0..<p.count]) == p && b[p.count...].allSatisfy(Base64URL.isAlphabet)
    }

    static func isGrantId(_ v: JSONValue?) -> Bool { prefixedToken(v, "gr_", 22) }
    static func isPairingId(_ v: JSONValue?) -> Bool { prefixedToken(v, "pr_", 22) }
    static func isRawEd25519(_ v: JSONValue?) -> Bool { prefixedToken(v, "", 43) }
    static func isSpkiPin(_ v: JSONValue?) -> Bool { prefixedToken(v, "sha256/", 43) }

    static func isHex64(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return b.count == 64 && b.allSatisfy { isDigit($0) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    static func isHttpsUrl(_ s: String, max: Int) -> Bool {
        guard !s.isEmpty, s.utf16.count <= max, let c = URLComponents(string: s), c.scheme?.lowercased() == "https",
              let host = c.host, !host.isEmpty else { return false }
        return true
    }

    static func isClientId(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return prefixedToken(v, "dcr_", 22) || isHttpsUrl(s, max: clientIdMax)
    }

    static func isUri(_ v: JSONValue?) -> Bool {
        guard let s = v?.stringValue else { return false }
        return !s.isEmpty && s.utf16.count <= uriMax
    }

    static func isCodeChallenge(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return (43...128).contains(b.count) && b.allSatisfy(Base64URL.isAlphabet)
    }

    static func isUserCode(_ v: JSONValue?) -> Bool {
        guard let b = Rules.ascii(v) else { return false }
        return b.count == 6 && b.allSatisfy { FrontDoor.userCodeAlphabet.contains($0) }
    }

    /// `^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$`
    static func isScopeName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let colon = b.firstIndex(of: UInt8(ascii: ":")) else { return false }
        func part(_ p: ArraySlice<UInt8>, _ extra: String) -> Bool {
            guard let first = p.first, isLower(first), (1...32).contains(p.count) else { return false }
            return p.dropFirst().allSatisfy { isLower($0) || isDigit($0) || isOneOfBytes($0, extra) }
        }
        return part(b[..<colon], "-") && part(b[(colon + 1)...], "_-")
    }

    /// `^[a-z0-9][a-z0-9._-]{0,62}$`
    static func isMachineName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard let first = b.first, isLower(first) || isDigit(first), b.count <= 63 else { return false }
        return b.dropFirst().allSatisfy { isLower($0) || isDigit($0) || isOneOfBytes($0, "._-") }
    }

    /// `^[A-Za-z0-9._-]{1,64}$`
    static func isNodeName(_ s: String) -> Bool {
        let b = Array(s.utf8)
        return (1...64).contains(b.count) && b.allSatisfy { isLower($0) || isUpper($0) || isDigit($0) || isOneOfBytes($0, "._-") }
    }

    /// Strictly increasing (so sorted and unique), each passing `test`.
    static func sortedUnique(_ list: [JSONValue], minCount: Int, maxCount: Int, _ test: (String) -> Bool) -> Bool {
        guard (minCount...maxCount).contains(list.count) else { return false }
        var previous: String?
        for value in list {
            guard let s = value.stringValue, test(s) else { return false }
            if let p = previous, !JCS.utf16Less(p, s) { return false }
            previous = s
        }
        return true
    }

    static func isScopeList(_ v: JSONValue?) -> Bool {
        guard let list = v?.arrayValue, list.count <= maxScopes else { return false }
        var previous: String?
        for entry in list {
            guard let o = entry.objectValue, Rules.hasExactKeys(o, ["scope", "machines"]),
                  let scope = o["scope"]?.stringValue, isScopeName(scope) else { return false }
            if let p = previous, !JCS.utf16Less(p, scope) { return false }
            previous = scope
            if o["machines"]?.isNull != true {
                guard let machines = o["machines"]?.arrayValue, sortedUnique(machines, minCount: 1, maxCount: maxMachines, isMachineName) else { return false }
            }
        }
        return true
    }

    static func grant(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "grant_id", "client_id", "client_name", "redirect_uri", "resource",
                                     "code_challenge", "user_code", "scopes", "decision", "nonce", "device_id", "signed_at"]),
              Rules.isNodeId(m["frontdoor_id"]), isGrantId(m["grant_id"]), isClientId(m["client_id"]),
              Rules.withinLength(m["client_name"], clientNameMax), isUri(m["redirect_uri"]), isUri(m["resource"]),
              isCodeChallenge(m["code_challenge"]), isUserCode(m["user_code"]), isScopeList(m["scopes"]),
              let scopes = m["scopes"]?.arrayValue, let decision = m["decision"]?.stringValue,
              Rules.isNonce(m["nonce"]), Rules.isDeviceId(m["device_id"]), Rules.isTimestamp(m["signed_at"]) else { return false }
        return (ExactText.same(decision, "approve") && !scopes.isEmpty) || (ExactText.same(decision, "deny") && scopes.isEmpty)
    }

    static func revoke(_ m: Fields) -> Bool {
        Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "grant_id", "challenge", "device_id", "signed_at"])
            && Rules.isNodeId(m["frontdoor_id"]) && isGrantId(m["grant_id"]) && Rules.isNonce(m["challenge"])
            && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    static func enroll(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "pairing_id", "node_id", "node_name", "profile", "public_key",
                                     "tls_fingerprint", "replaces", "decision", "nonce", "device_id", "signed_at"]),
              let name = m["node_name"]?.stringValue else { return false }
        return Rules.isNodeId(m["frontdoor_id"]) && isPairingId(m["pairing_id"]) && Rules.isNodeId(m["node_id"]) && isNodeName(name)
            && Rules.isOneOf(m["profile"], ["agent", "runbook"]) && isRawEd25519(m["public_key"]) && isHex64(m["tls_fingerprint"])
            && (m["replaces"]?.isNull == true || Rules.isNodeId(m["replaces"])) && Rules.isOneOf(m["decision"], ["approve", "deny"])
            && Rules.isNonce(m["nonce"]) && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    static func remove(_ m: Fields) -> Bool {
        Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "node_id", "challenge", "device_id", "signed_at"])
            && Rules.isNodeId(m["frontdoor_id"]) && Rules.isNodeId(m["node_id"]) && Rules.isNonce(m["challenge"])
            && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    static func repin(_ m: Fields) -> Bool {
        guard Rules.hasExactKeys(m, ["v", "type", "frontdoor_id", "relay", "old_spki", "new_spki", "created_at"]),
              let relay = m["relay"]?.stringValue else { return false }
        return Rules.isNodeId(m["frontdoor_id"]) && isHttpsUrl(relay, max: uriMax) && isSpkiPin(m["old_spki"])
            && isSpkiPin(m["new_spki"]) && Rules.isTimestamp(m["created_at"])
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run (macOS, from `mobile/ios/KLProtocol`): `swift test`
Expected: every test passes, `ProtocolVectorTests` included (the approval-v1 set is unchanged).

- [ ] **Step 5: Commit**

```bash
git add mobile/ios/KLProtocol/Sources/KLProtocol/FrontDoor.swift mobile/ios/KLProtocol/Tests/KLProtocolTests/FrontDoorVectorTests.swift
git commit -m "feat(ios): client-grant-v1 builders, re-pin check and vectors in KLProtocol" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 36: `client-grant-v1` in the Android protocol core

**Files:**
- Create: `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/FrontDoor.kt`
- Modify: `mobile/android/protocol/build.gradle.kts` (the `tasks.test` block)
- Test: `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/FrontDoorVectorTest.kt`

**Interfaces:**
- Consumes: Task 3's vectors and `keys.json`; F3's protocol module (`JsonText`, `Jcs`, `Envelope`, `B64Url`, `Hex`, `Identifiers`, `Rules`, `ProtocolException`, the `str()`/`obj()`/`arr()`/`int()`/`get` helpers).
- Produces: the Kotlin twin of Task 35 — `data class ScopeChoice(scope, machines)`, `data class RepinCheck(ok, reason, newSpki)`, `object FrontDoor` (`normalizeUserCode`, `formatUserCode`, `nodeFingerprint`, `isMachineName`, `scopesJson`, `clientGrant`, `clientRevoke`, `nodeEnroll`, `nodeRemove`, `validate`, `verifyRepin`), `class GrantRequest(json)`, `class PairingRequest(json)`, each throwing `ProtocolException` where the Swift one throws. The Gradle test task passes `kl.grantVectors` (default `tests/vectors/client-grant-v1`) next to `kl.vectors`.

- [ ] **Step 1: Point the tests at the new vectors**

In `mobile/android/protocol/build.gradle.kts`, replace everything from `// The vectors the node and iOS use too.` to the end of the file with:

```kotlin
// The vectors the node and iOS use too. `-Dkl.vectors=<dir>` and
// `-Dkl.grantVectors=<dir>` override the in-repo paths (for a build that
// mounts the vectors somewhere else).
val vectorsDir: String = providers.systemProperty("kl.vectors")
    .orElse(projectDir.resolve("../../../tests/vectors/approval-v1").canonicalPath)
    .get()
val grantVectorsDir: String = providers.systemProperty("kl.grantVectors")
    .orElse(projectDir.resolve("../../../tests/vectors/client-grant-v1").canonicalPath)
    .get()

tasks.test {
    inputs.dir(vectorsDir)
    inputs.dir(grantVectorsDir)
    systemProperty("kl.vectors", vectorsDir)
    systemProperty("kl.grantVectors", grantVectorsDir)
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
```

- [ ] **Step 2: Write the failing test**

Create `mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/FrontDoorVectorTest.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** Every client-grant-v1 vector whose consumers include "android" (shared with the front door and iOS). */
class FrontDoorVectorTest {
    private val dir = File(System.getProperty("kl.grantVectors") ?: error("run through Gradle: kl.grantVectors is not set"))
    private val keys: JsonElement by lazy {
        JsonText.parse(File(System.getProperty("kl.vectors") ?: error("run through Gradle: kl.vectors is not set"), "keys.json").readBytes())
    }

    private fun vector(name: String): JsonElement = JsonText.parse(File(dir, "$name.json").readBytes())
    private fun s(v: JsonElement?, key: String): String = v[key].str()!!
    private fun payload(v: JsonElement): ByteArray = Envelope.fromJson(v["input"]!!).payloadBytes()

    private fun throwsProtocol(block: () -> Unit) {
        try {
            block()
        } catch (e: ProtocolException) {
            return
        }
        fail("expected a ProtocolException")
    }

    @Test
    fun everyAndroidVectorIsCovered() {
        val names = dir.listFiles { f -> f.name.endsWith(".json") }!!
            .map { JsonText.parse(it.readBytes()) }
            .filter { v -> v["consumers"].arr()!!.any { it.str() == "android" } }
            .map { it["name"].str() }
            .toSet()
        assertEquals(
            setOf("grant-approve", "grant-deny", "revoke-valid", "enroll-valid", "remove-valid", "repin-valid", "repin-reject-bad-signature", "fingerprint-grouping"),
            names
        )
    }

    @Test
    fun grantApproveBytes() {
        val v = vector("grant-approve")
        val expect = v["expect"]["message"]!!
        val choices = listOf(ScopeChoice("fleet:run", listOf("web-01", "gpu-box", "web-01")), ScopeChoice("fleet:read"))
        val built = FrontDoor.clientGrant(s(v["given"]["frontdoor"], "id"), v["given"]["pending"]!!, "q7k-m2x", choices, "approve",
            s(expect, "nonce"), s(expect, "device_id"), s(expect, "signed_at"))
        assertEquals(expect, built)
        assertArrayEquals(payload(v), Jcs.bytes(built))
        val a = keys["devices"]["A"]
        assertTrue(Envelope.fromJson(v["input"]!!).verifyEs256(s(a["jwk"], "x"), s(a["jwk"], "y")))
        assertNull(FrontDoor.validate("kl.client.grant", built))
    }

    @Test
    fun grantDenyBytes() {
        val v = vector("grant-deny")
        val expect = v["expect"]["message"]!!
        val built = FrontDoor.clientGrant(s(v["given"]["frontdoor"], "id"), v["given"]["pending"]!!, "Q7KM2X", listOf(ScopeChoice("fleet:read")), "deny",
            s(expect, "nonce"), s(expect, "device_id"), s(expect, "signed_at"))
        assertArrayEquals(payload(v), Jcs.bytes(built))
    }

    @Test
    fun revokeEnrollRemoveBytes() {
        val revoke = vector("revoke-valid")
        val r = revoke["expect"]["message"]
        assertArrayEquals(payload(revoke), Jcs.bytes(FrontDoor.clientRevoke(s(r, "frontdoor_id"), s(r, "grant_id"),
            s(revoke["given"]["challenges"].arr()!![0], "challenge"), s(r, "device_id"), s(r, "signed_at"))))

        val enroll = vector("enroll-valid")
        val e = enroll["expect"]["message"]
        assertArrayEquals(payload(enroll), Jcs.bytes(FrontDoor.nodeEnroll(s(e, "frontdoor_id"), enroll["given"]["pairing"]!!, "approve",
            s(e, "nonce"), s(e, "device_id"), s(e, "signed_at"))))

        val remove = vector("remove-valid")
        val m = remove["expect"]["message"]
        assertArrayEquals(payload(remove), Jcs.bytes(FrontDoor.nodeRemove(s(m, "frontdoor_id"), s(m, "node_id"),
            s(remove["given"]["challenges"].arr()!![0], "challenge"), s(m, "device_id"), s(m, "signed_at"))))
    }

    @Test
    fun repin() {
        for (name in listOf("repin-valid", "repin-reject-bad-signature")) {
            val v = vector(name)
            val g = v["given"]
            val keyHex = Identifiers.ED25519_SPKI_PREFIX + Hex.encode(B64Url.decode(s(g["frontdoor"], "key")))
            val check = FrontDoor.verifyRepin(v["input"]!!, s(g["frontdoor"], "id"), keyHex, s(g, "received_spki"), s(g, "current_pin"))
            assertEquals(name, v["expect"]["accepted"].bool(), check.ok)
            assertEquals(name, v["expect"]["reason"].str(), check.reason)
            if (check.ok) assertEquals(s(g, "received_spki"), check.newSpki)
        }
        val v = vector("repin-valid")
        val g = v["given"]
        val keyHex = Identifiers.ED25519_SPKI_PREFIX + Hex.encode(B64Url.decode(s(g["frontdoor"], "key")))
        val other = "sha256/" + "A".repeat(43)
        assertEquals("spki_mismatch", FrontDoor.verifyRepin(v["input"]!!, s(g["frontdoor"], "id"), keyHex, other, s(g, "current_pin")).reason)
        assertEquals("old_pin_mismatch", FrontDoor.verifyRepin(v["input"]!!, s(g["frontdoor"], "id"), keyHex, s(g, "received_spki"), other).reason)
        assertEquals("wrong_frontdoor", FrontDoor.verifyRepin(v["input"]!!, "kl-aaaaaaaaaaaaaaaa", keyHex, s(g, "received_spki"), s(g, "current_pin")).reason)
        assertEquals("malformed", FrontDoor.verifyRepin(jsonString("x"), s(g["frontdoor"], "id"), keyHex, other, other).reason)
    }

    @Test
    fun fingerprintsAndUserCodes() {
        val v = vector("fingerprint-grouping")
        val ids = v["input"]["node_ids"].arr()!!.map { it.str()!! }
        assertEquals(v["expect"]["node_fingerprints"].arr()!!.map { it.str() }, ids.map { FrontDoor.nodeFingerprint(it) })
        val normalized = v["input"]["typed_codes"].arr()!!.map { FrontDoor.normalizeUserCode(it.str()!!) }
        assertEquals(v["expect"]["user_codes"].arr()!!.map { if (it is JsonNull) null else it.str() }, normalized)
        assertEquals(v["expect"]["displayed"].arr()!!.map { if (it is JsonNull) null else it.str() }, normalized.map { c -> c?.let { FrontDoor.formatUserCode(it) } })
        assertTrue(FrontDoor.isMachineName("gpu-box"))
        org.junit.Assert.assertFalse(FrontDoor.isMachineName("GPU-box"))
    }

    /** What the front door refuses as malformed, the phone never signs. */
    @Test
    fun buildersRefuse() {
        val v = vector("grant-approve")
        val fd = s(v["given"]["frontdoor"], "id")
        val pending = v["given"]["pending"]!!
        val a = s(keys["devices"]["A"], "id")
        fun grant(p: JsonElement, scopes: List<ScopeChoice>, code: String = "Q7KM2X") =
            FrontDoor.clientGrant(fd, p, code, scopes, "approve", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z")
        throwsProtocol { grant(pending, emptyList()) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:run", listOf("Web-01")))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:run", emptyList()))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read"), ScopeChoice("fleet:read"))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("Fleet:read"))) }
        throwsProtocol { grant(pending, listOf(ScopeChoice("fleet:read")), code = "Q7KM2") }
        val emoji = String(Character.toChars(0x1F600))
        val long = JsonObject(pending.obj()!! + ("client_name" to jsonString(emoji.repeat(201))))
        throwsProtocol { grant(long, listOf(ScopeChoice("fleet:read"))) }
        grant(JsonObject(pending.obj()!! + ("client_name" to jsonString(emoji.repeat(200)))), listOf(ScopeChoice("fleet:read")))
        throwsProtocol { FrontDoor.clientRevoke(fd, "gr_short", Messages.randomNonce(), a, "2026-09-23T18:04:13.201Z") }
    }

    @Test
    fun grantAndPairingRequests() {
        val v = vector("grant-approve")
        val reply = JsonObject(v["given"]["pending"].obj()!!.filterKeys { it !in setOf("user_code", "expires_at", "claimed_by", "used_nonces") } +
            mapOf("preselected" to kotlinx.serialization.json.JsonArray(listOf(jsonString("fleet:read"))), "expires_in_ms" to jsonNumber("280000")))
        val request = GrantRequest(reply)
        assertEquals("Example Client", request.clientName)
        assertEquals("client.example.com", request.redirectHost)
        assertEquals(listOf("fleet:read", "fleet:run"), request.requestedScopes)
        assertEquals(listOf("fleet:read"), request.preselected)
        throwsProtocol { GrantRequest(JsonObject(reply + ("grant_id" to jsonString("gr_x")))) }

        val e = vector("enroll-valid")
        val entry = JsonObject(e["given"]["pairing"].obj()!!.filterKeys { it !in setOf("expires_at", "used_nonces") } + ("expires_in_ms" to jsonNumber("500000")))
        val pairing = PairingRequest(entry)
        assertEquals(FrontDoor.nodeFingerprint(s(e["given"]["pairing"], "node_id")), pairing.fingerprint)
        val m = e["expect"]["message"]
        assertArrayEquals(Envelope.fromJson(e["input"]!!).payloadBytes(),
            Jcs.bytes(pairing.message(s(m, "frontdoor_id"), "approve", s(m, "nonce"), s(m, "device_id"), s(m, "signed_at"))))
        throwsProtocol { PairingRequest(JsonObject(entry + ("node_id" to jsonString("kl-aaaaaaaaaaaaaaaa")))) }
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run (from `mobile/android/protocol`): `./gradlew test --tests '*FrontDoorVectorTest*'` (or `gradle test` where the wrapper is the parent's).
Expected: FAIL to compile — `Unresolved reference: FrontDoor`.

- [ ] **Step 4: Write `FrontDoor.kt`**

Create `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/FrontDoor.kt`:

```kotlin
package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.net.URI

/** A scope the owner grants to a client, with an optional machine limit (client-grant-v1 §3.1). */
data class ScopeChoice(val scope: String, val machines: List<String>? = null)

/** The result of checking a `kl.relay.repin` (client-grant-v1 §5). */
data class RepinCheck(val ok: Boolean, val reason: String?, val newSpki: String?)

/**
 * client-grant-v1 (docs/protocol/client-grant-v1.md): what a phone builds for
 * a front door and what it checks from one. Each builder applies the front
 * door's own rules first and throws ProtocolException instead of returning a
 * message the front door would refuse as `malformed`.
 */
object FrontDoor {
    internal const val USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** What the owner typed, as the grant carries it: upper case, no `-` or spaces, O→0 and I/L→1; null unless six alphabet characters. */
    fun normalizeUserCode(text: String): String? {
        val out = StringBuilder()
        for (ch in text.uppercase()) {
            if (ch == '-' || ch.isWhitespace()) continue
            out.append(
                when (ch) {
                    'O' -> '0'
                    'I', 'L' -> '1'
                    else -> ch
                }
            )
        }
        val s = out.toString()
        return if (s.length == 6 && s.all { it in USER_CODE_ALPHABET }) s else null
    }

    /** `Q7KM2X` → `Q7K-M2X`, as the browser shows it. */
    fun formatUserCode(code: String): String = code.take(3) + "-" + code.drop(3)

    /** `kl-3v7q2m4k8d1x9c0a` → `kl-3v7q 2m4k 8d1x 9c0a`. */
    fun nodeFingerprint(nodeId: String): String = "kl-" + Identifiers.fingerprintGroups(nodeId)

    /** A node name a grant can limit to (`machines=`); other names can only be granted without a limit (Deviation 18). */
    fun isMachineName(name: String): Boolean = FrontDoorRules.isMachineName(name)

    /** Sorted by scope; each machine list sorted and de-duplicated. */
    fun scopesJson(choices: List<ScopeChoice>): JsonArray = JsonArray(
        choices.sortedWith { a, b -> a.scope.compareTo(b.scope) }.map { c ->
            JsonObject(
                mapOf(
                    "scope" to jsonString(c.scope),
                    "machines" to (c.machines?.let { list -> JsonArray(list.distinct().sorted().map { jsonString(it) }) } ?: JsonNull)
                )
            )
        }
    )

    private fun field(v: JsonElement, key: String): String = v[key].str() ?: throw ProtocolException("missing $key")

    /** kl.client.grant for a pending authorization (the `GET /v1/grants/pending` reply) and the code the owner typed. `deny` carries no scopes. */
    fun clientGrant(frontdoorId: String, pending: JsonElement, userCode: String, scopes: List<ScopeChoice>, decision: String,
                    nonce: String, deviceId: String, signedAt: String): JsonObject {
        val code = normalizeUserCode(userCode) ?: throw ProtocolException("the code is six letters and digits")
        return checked(
            "kl.client.grant",
            JsonObject(
                mapOf(
                    "v" to jsonNumber("1"),
                    "type" to jsonString("kl.client.grant"),
                    "frontdoor_id" to jsonString(frontdoorId),
                    "grant_id" to jsonString(field(pending, "grant_id")),
                    "client_id" to jsonString(field(pending, "client_id")),
                    "client_name" to jsonString(field(pending, "client_name")),
                    "redirect_uri" to jsonString(field(pending, "redirect_uri")),
                    "resource" to jsonString(field(pending, "resource")),
                    "code_challenge" to jsonString(field(pending, "code_challenge")),
                    "user_code" to jsonString(code),
                    "scopes" to if (decision == "deny") JsonArray(emptyList()) else scopesJson(scopes),
                    "decision" to jsonString(decision),
                    "nonce" to jsonString(nonce),
                    "device_id" to jsonString(deviceId),
                    "signed_at" to jsonString(signedAt)
                )
            )
        )
    }

    fun clientRevoke(frontdoorId: String, grantId: String, challenge: String, deviceId: String, signedAt: String): JsonObject = checked(
        "kl.client.revoke",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.client.revoke"),
                "frontdoor_id" to jsonString(frontdoorId),
                "grant_id" to jsonString(grantId),
                "challenge" to jsonString(challenge),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    )

    /** kl.node.enroll for one pending pairing (a `GET /v1/pairings/pending` entry). */
    fun nodeEnroll(frontdoorId: String, pairing: JsonElement, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject = checked(
        "kl.node.enroll",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.node.enroll"),
                "frontdoor_id" to jsonString(frontdoorId),
                "pairing_id" to jsonString(field(pairing, "pairing_id")),
                "node_id" to jsonString(field(pairing, "node_id")),
                "node_name" to jsonString(field(pairing, "node_name")),
                "profile" to jsonString(field(pairing, "profile")),
                "public_key" to jsonString(field(pairing, "public_key")),
                "tls_fingerprint" to jsonString(field(pairing, "tls_fingerprint")),
                "replaces" to (pairing["replaces"].str()?.let { jsonString(it) } ?: JsonNull),
                "decision" to jsonString(decision),
                "nonce" to jsonString(nonce),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    )

    fun nodeRemove(frontdoorId: String, nodeId: String, challenge: String, deviceId: String, signedAt: String): JsonObject = checked(
        "kl.node.remove",
        JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.node.remove"),
                "frontdoor_id" to jsonString(frontdoorId),
                "node_id" to jsonString(nodeId),
                "challenge" to jsonString(challenge),
                "device_id" to jsonString(deviceId),
                "signed_at" to jsonString(signedAt)
            )
        )
    )

    /** null when well formed, else `malformed` or `unsupported_version`. */
    fun validate(type: String, message: JsonElement): String? {
        val m = message.obj() ?: return "malformed"
        val v = m["v"]
        if (m["type"].str() != type || v == null || !Rules.isInteger(v)) return "malformed"
        if (!Rules.isOne(v)) return "unsupported_version"
        val rule = FrontDoorRules.byType[type] ?: return "malformed"
        return if (rule(m)) null else "malformed"
    }

    private fun checked(type: String, message: JsonObject): JsonObject {
        val reason = validate(type, message)
        if (reason != null) throw ProtocolException("not a valid $type: $reason")
        return message
    }

    /**
     * The re-pin rule (stage 4 spec §3.3.1): the envelope verifies against the
     * front-door key pinned from the kl.pair code, `new_spki` is the key just
     * received, and `old_spki` is the current pin. Reasons in the front door's order.
     */
    fun verifyRepin(envelopeJson: JsonElement, frontdoorId: String, frontdoorKeyHex: String, receivedSpki: String, currentPin: String): RepinCheck {
        fun fail(reason: String) = RepinCheck(false, reason, null)
        val envelope = try {
            Envelope.fromJson(envelopeJson)
        } catch (e: ProtocolException) {
            return fail("malformed")
        }
        val message = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return fail("malformed")
        }
        validate("kl.relay.repin", message)?.let { return fail(it) }
        if (envelope.alg != "Ed25519") return fail("malformed")
        if (envelope.kid != frontdoorId || message["frontdoor_id"].str() != frontdoorId) return fail("wrong_frontdoor")
        if (!envelope.verifyEd25519(frontdoorKeyHex)) return fail("bad_signature")
        val newSpki = message["new_spki"].str()
        if (newSpki != receivedSpki) return fail("spki_mismatch")
        if (message["old_spki"].str() != currentPin) return fail("old_pin_mismatch")
        return RepinCheck(true, null, newSpki)
    }
}

/** One `GET /v1/grants/pending` reply. Everything in it is the front door's (and the client's) word; the app shows `clientName` as self-declared. */
class GrantRequest(val json: JsonElement) {
    val grantId: String
    val clientId: String
    val clientName: String
    val clientHost: String
    val redirectUri: String
    val resource: String
    val requestedScopes: List<String>
    val preselected: List<String>
    val expiresInMs: Int

    init {
        val requested = json["requested_scopes"].arr()
        val pre = json["preselected"].arr()
        val expires = json["expires_in_ms"].int()
        val host = json["client_host"].str()
        if (!FrontDoorRules.isGrantId(json["grant_id"]) || !FrontDoorRules.isClientId(json["client_id"]) ||
            !Rules.withinLength(json["client_name"], FrontDoorRules.CLIENT_NAME_MAX) || host == null ||
            !FrontDoorRules.isUri(json["redirect_uri"]) || !FrontDoorRules.isUri(json["resource"]) ||
            !FrontDoorRules.isCodeChallenge(json["code_challenge"]) || requested == null || pre == null || expires == null
        ) throw ProtocolException("the front door sent a connection request this app cannot read")
        val names = requested.mapNotNull { it.str() }.filter { FrontDoorRules.isScopeName(it) }
        if (names.size != requested.size) throw ProtocolException("unknown scope names in the request")
        grantId = json["grant_id"].str()!!
        clientId = json["client_id"].str()!!
        clientName = json["client_name"].str()!!
        clientHost = host
        redirectUri = json["redirect_uri"].str()!!
        resource = json["resource"].str()!!
        requestedScopes = names
        preselected = pre.mapNotNull { it.str() }.filter { it in names }
        expiresInMs = expires.coerceAtLeast(0)
    }

    /** The host the browser returns to (the redirect URI's). */
    val redirectHost: String get() = runCatching { URI(redirectUri).host }.getOrNull() ?: redirectUri

    fun message(frontdoorId: String, userCode: String, scopes: List<ScopeChoice>, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject =
        FrontDoor.clientGrant(frontdoorId, json, userCode, scopes, decision, nonce, deviceId, signedAt)
}

/** One `GET /v1/pairings/pending` entry. Its id must derive from its key, so the fingerprint shown is the key's. */
class PairingRequest(val json: JsonElement) {
    val pairingId: String
    val nodeId: String
    val nodeName: String
    val profile: String
    val replaces: String?
    val expiresInMs: Int

    init {
        val name = json["node_name"].str()
        val expires = json["expires_in_ms"].int()
        val raw = if (FrontDoorRules.isRawEd25519(json["public_key"])) runCatching { B64Url.decode(json["public_key"].str()!!) }.getOrNull() else null
        val ok = FrontDoorRules.isPairingId(json["pairing_id"]) && Rules.isNodeId(json["node_id"]) && name != null && FrontDoorRules.isNodeName(name) &&
            Rules.isOneOf(json["profile"], listOf("agent", "runbook")) && FrontDoorRules.isHex64(json["tls_fingerprint"]) &&
            (json["replaces"] is JsonNull || Rules.isNodeId(json["replaces"])) && expires != null &&
            raw != null && raw.size == 32 && Identifiers.nodeId(raw) == json["node_id"].str()
        if (!ok) throw ProtocolException("the front door sent a pairing this app cannot verify")
        pairingId = json["pairing_id"].str()!!
        nodeId = json["node_id"].str()!!
        nodeName = name!!
        profile = json["profile"].str()!!
        replaces = json["replaces"].str()
        expiresInMs = expires!!.coerceAtLeast(0)
    }

    val fingerprint: String get() = FrontDoor.nodeFingerprint(nodeId)

    fun message(frontdoorId: String, decision: String, nonce: String, deviceId: String, signedAt: String): JsonObject =
        FrontDoor.nodeEnroll(frontdoorId, json, decision, nonce, deviceId, signedAt)
}

/** The front door's validators (src/frontdoor/protocol/messages.js) for the types a phone writes or reads. */
internal object FrontDoorRules {
    val byType: Map<String, (JsonObject) -> Boolean> = mapOf(
        "kl.client.grant" to ::grant,
        "kl.client.revoke" to ::revoke,
        "kl.node.enroll" to ::enroll,
        "kl.node.remove" to ::remove,
        "kl.relay.repin" to ::repin
    )

    const val CLIENT_NAME_MAX = 200
    const val URI_MAX = 2048
    const val CLIENT_ID_MAX = 512
    const val MAX_SCOPES = 32
    const val MAX_MACHINES = 64

    // `matches` is a whole-input match: no anchors, and no "$ before a final newline" surprise.
    private val SCOPE_NAME = Regex("[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}")
    private val MACHINE_NAME = Regex("[a-z0-9][a-z0-9._-]{0,62}")
    private val NODE_NAME = Regex("[A-Za-z0-9._-]{1,64}")
    private val HEX64 = Regex("[0-9a-f]{64}")
    private val B64URL = Regex("[A-Za-z0-9_-]*")

    private fun token(v: JsonElement?, prefix: String, length: Int): Boolean {
        val s = v.str() ?: return false
        return s.length == prefix.length + length && s.startsWith(prefix) && B64URL.matches(s.substring(prefix.length))
    }

    fun isGrantId(v: JsonElement?) = token(v, "gr_", 22)
    fun isPairingId(v: JsonElement?) = token(v, "pr_", 22)
    fun isRawEd25519(v: JsonElement?) = token(v, "", 43)
    fun isSpkiPin(v: JsonElement?) = token(v, "sha256/", 43)
    fun isHex64(v: JsonElement?) = v.str()?.let { HEX64.matches(it) } ?: false
    fun isScopeName(s: String) = SCOPE_NAME.matches(s)
    fun isMachineName(s: String) = MACHINE_NAME.matches(s)
    fun isNodeName(s: String) = NODE_NAME.matches(s)

    fun isHttpsUrl(s: String, max: Int): Boolean {
        if (s.isEmpty() || s.length > max) return false
        val uri = runCatching { URI(s) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty()
    }

    fun isClientId(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return token(v, "dcr_", 22) || isHttpsUrl(s, CLIENT_ID_MAX)
    }

    fun isUri(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.isNotEmpty() && s.length <= URI_MAX
    }

    fun isCodeChallenge(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.length in 43..128 && B64URL.matches(s)
    }

    fun isUserCode(v: JsonElement?): Boolean {
        val s = v.str() ?: return false
        return s.length == 6 && s.all { it in FrontDoor.USER_CODE_ALPHABET }
    }

    /** Strictly increasing (so sorted and unique), each passing `test`. */
    private fun sortedUnique(list: List<JsonElement>, min: Int, max: Int, test: (String) -> Boolean): Boolean {
        if (list.size !in min..max) return false
        var previous: String? = null
        for (value in list) {
            val s = value.str() ?: return false
            if (!test(s)) return false
            if (previous != null && previous >= s) return false
            previous = s
        }
        return true
    }

    fun isScopeList(v: JsonElement?): Boolean {
        val list = v.arr() ?: return false
        if (list.size > MAX_SCOPES) return false
        var previous: String? = null
        for (entry in list) {
            val o = entry.obj() ?: return false
            if (!Rules.hasExactKeys(o, listOf("scope", "machines"))) return false
            val scope = o["scope"].str() ?: return false
            if (!isScopeName(scope)) return false
            if (previous != null && previous >= scope) return false
            previous = scope
            val machines = o["machines"]
            if (machines !is JsonNull) {
                val names = machines.arr() ?: return false
                if (!sortedUnique(names, 1, MAX_MACHINES, ::isMachineName)) return false
            }
        }
        return true
    }

    private fun grant(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "grant_id", "client_id", "client_name", "redirect_uri", "resource",
                "code_challenge", "user_code", "scopes", "decision", "nonce", "device_id", "signed_at"))) return false
        if (!Rules.isNodeId(m["frontdoor_id"]) || !isGrantId(m["grant_id"]) || !isClientId(m["client_id"]) ||
            !Rules.withinLength(m["client_name"], CLIENT_NAME_MAX) || !isUri(m["redirect_uri"]) || !isUri(m["resource"]) ||
            !isCodeChallenge(m["code_challenge"]) || !isUserCode(m["user_code"]) || !isScopeList(m["scopes"]) ||
            !Rules.isNonce(m["nonce"]) || !Rules.isDeviceId(m["device_id"]) || !Rules.isTimestamp(m["signed_at"])) return false
        val scopes = m["scopes"].arr()!!
        return when (m["decision"].str()) {
            "approve" -> scopes.isNotEmpty()
            "deny" -> scopes.isEmpty()
            else -> false
        }
    }

    private fun revoke(m: JsonObject): Boolean =
        Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "grant_id", "challenge", "device_id", "signed_at")) &&
            Rules.isNodeId(m["frontdoor_id"]) && isGrantId(m["grant_id"]) && Rules.isNonce(m["challenge"]) &&
            Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])

    private fun enroll(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "pairing_id", "node_id", "node_name", "profile", "public_key",
                "tls_fingerprint", "replaces", "decision", "nonce", "device_id", "signed_at"))) return false
        val name = m["node_name"].str() ?: return false
        return Rules.isNodeId(m["frontdoor_id"]) && isPairingId(m["pairing_id"]) && Rules.isNodeId(m["node_id"]) && isNodeName(name) &&
            Rules.isOneOf(m["profile"], listOf("agent", "runbook")) && isRawEd25519(m["public_key"]) && isHex64(m["tls_fingerprint"]) &&
            (m["replaces"] is JsonNull || Rules.isNodeId(m["replaces"])) && Rules.isOneOf(m["decision"], listOf("approve", "deny")) &&
            Rules.isNonce(m["nonce"]) && Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])
    }

    private fun remove(m: JsonObject): Boolean =
        Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "node_id", "challenge", "device_id", "signed_at")) &&
            Rules.isNodeId(m["frontdoor_id"]) && Rules.isNodeId(m["node_id"]) && Rules.isNonce(m["challenge"]) &&
            Rules.isDeviceId(m["device_id"]) && Rules.isTimestamp(m["signed_at"])

    private fun repin(m: JsonObject): Boolean {
        if (!Rules.hasExactKeys(m, listOf("v", "type", "frontdoor_id", "relay", "old_spki", "new_spki", "created_at"))) return false
        val relay = m["relay"].str() ?: return false
        return Rules.isNodeId(m["frontdoor_id"]) && isHttpsUrl(relay, URI_MAX) && isSpkiPin(m["old_spki"]) &&
            isSpkiPin(m["new_spki"]) && Rules.isTimestamp(m["created_at"])
    }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run (from `mobile/android/protocol`): `./gradlew test`
Expected: every test passes, `ProtocolVectorTest` included.

- [ ] **Step 6: Commit**

```bash
git add mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/FrontDoor.kt mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/FrontDoorVectorTest.kt mobile/android/protocol/build.gradle.kts
git commit -m "feat(android): client-grant-v1 builders, re-pin check and vectors in the protocol module" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 37: The iOS app — connect a client, clients, node pairings, alerts, history markers, re-pin

**Files:**
- Modify: `mobile/ios/App/RelayAPI.swift` (the pin-refusal branch; front-door calls)
- Modify: `mobile/ios/App/AppModel.swift` (`StoredState`, `HistoryPage`, published state, console-enrollment success, the poll loop's `pin_mismatch` branch, `loadHistory`, a front-door section, `reset`)
- Create: `mobile/ios/App/FrontDoorViews.swift`
- Modify: `mobile/ios/App/Views.swift` (`MainView` tabs, `ApprovalDetailView` label, `HistoryView` markers, `SettingsView` fingerprint)
- Modify: `mobile/ios/App/KingLouieApp.swift` (push kinds)

**Interfaces:**
- Consumes: Task 35 (`FrontDoor`, `GrantRequest`, `PairingRequest`, `ScopeChoice`), Tasks 23 and 30's phone routes, F3's `RelayAPI`, `DeviceKey.signEnvelope(_:reason:)`, `Display.escape`.
- Produces (spec §3.15): a **Front door** tab with *Connect a client* (type the `XXX-XXX` code; client name shown as self-declared, client and redirect hosts, scope toggles with machine limits, approve or deny with a biometric signature), *Connected clients* (last use, revoke through a challenge), *Nodes waiting for you* (polled every 5 s while open; name, profile, fingerprint, "replaces …"; approve or deny), *Nodes* (source, online, audit state; remove a phone-enrolled node) and *Alerts* (read on every app open; acknowledge); history pages show the front door's gap and break records as "reported by front door"; Settings shows the front-door fingerprint; approval details label `origin.client` "Client (reported by front door)"; a pin failure on a front door makes exactly one `GET /v1/repin` to the certificate just seen and re-pins only when `FrontDoor.verifyRepin` passes; pushes of kind `pairing` and `alert` open the matching screen's data. The app knows it is paired with a front door only when `GET /v1/frontdoor` names a node the phone pinned from a `kl.pair` code, with that key (`StoredState.frontDoorId`).

- [ ] **Step 1: `RelayAPI` — the certificate a pin refused, and the front-door calls**

In `mobile/ios/App/RelayAPI.swift`:

1. Below `private var pinRefusedTasks: Set<Int> = []`, add:

```swift
    /// The SPKI pin of the last certificate the pin refused (stage 4 §3.3.1).
    private var refusedSpki: String?
```

2. In `urlSession(_:task:didReceive:completionHandler:)`, replace the `else { … }` body of the `guard let trust = …, pin == spkiPin else {` with:

```swift
            let id = task.taskIdentifier
            let seen = (challenge.protectionSpace.serverTrust.flatMap { SecTrustCopyCertificateChain($0) as? [SecCertificate] })?.first.flatMap { Self.spkiPin(of: $0) }
            locked {
                _ = pinRefusedTasks.insert(id)
                refusedSpki = seen
            }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
```

3. Below `takePinRefusal(_:)`, add:

```swift
    /// The pin of the certificate the last refusal saw, once.
    func takeRefusedSpki() -> String? {
        locked {
            let seen = refusedSpki
            refusedSpki = nil
            return seen
        }
    }
```

4. Before the closing brace of `final class RelayAPI` (after `consoleEnrollState`), add:

```swift
    // MARK: Front door (fleet stage 4, client-grant-v1 §7)

    func frontDoorInfo() async throws -> JSONValue? {
        try await request("GET", "/v1/frontdoor").1
    }

    /// Claims the request for this phone; 404 `no_such_request` when the code matches nothing.
    func pendingGrant(userCode: String) async throws -> JSONValue? {
        try await request("GET", "/v1/grants/pending?user_code=\(Self.segment(userCode))").1
    }

    func grantDecision(_ grantId: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/grants/\(Self.segment(grantId))/decision", body: envelope.json).1
    }

    func clients() async throws -> [JSONValue] {
        try await request("GET", "/v1/clients").1?.arrayValue ?? []
    }

    func challenge() async throws -> String {
        guard let challenge = try await request("POST", "/v1/challenges").1?["challenge"]?.stringValue else {
            throw RelayError(status: 0, code: "bad_reply", message: "The front door sent a reply this app cannot read.")
        }
        return challenge
    }

    func revokeClient(_ grantId: String, envelope: Envelope) async throws {
        _ = try await request("POST", "/v1/clients/\(Self.segment(grantId))/revoke", body: envelope.json)
    }

    func pendingPairings() async throws -> [JSONValue] {
        try await request("GET", "/v1/pairings/pending").1?.arrayValue ?? []
    }

    func pairingDecision(_ pairingId: String, envelope: Envelope) async throws -> JSONValue? {
        try await request("POST", "/v1/pairings/\(Self.segment(pairingId))/decision", body: envelope.json).1
    }

    func removeNode(_ nodeId: String, envelope: Envelope) async throws {
        _ = try await request("POST", "/v1/nodes/\(Self.segment(nodeId))/remove", body: envelope.json)
    }

    func alerts(since: String) async throws -> [JSONValue] {
        try await request("GET", "/v1/alerts?since=\(Self.segment(since))").1?.arrayValue ?? []
    }

    func ackAlert(_ id: String) async throws {
        _ = try await request("POST", "/v1/alerts/\(Self.segment(id))/ack")
    }

    func auditStatus(nodeId: String) async throws -> JSONValue? {
        try await request("GET", "/v1/nodes/\(Self.segment(nodeId))/audit-status").1
    }

    /// Unauthenticated: the one request a phone makes after its pin failed.
    func repinEnvelope() async throws -> JSONValue? {
        try await request("GET", "/v1/repin", auth: false).1
    }
```

- [ ] **Step 2: `AppModel` — stored and published state**

In `mobile/ios/App/AppModel.swift`:

1. In `struct StoredState`, below `var pushToken: String?`, add:

```swift
    /// The front door this phone's relay is (fleet stage 4): set only when
    /// GET /v1/frontdoor names a node pinned from a kl.pair code, with that key.
    var frontDoorId: String?
```

2. Replace `struct HistoryPage { … }` with:

```swift
struct HistoryPage {
    let nodeId: String
    let entries: [JSONValue]
    let asOf: String
    /// The front door's own gap and break records (GET …/audit-status),
    /// shown as "reported by front door", never as node-signed history.
    var status: JSONValue? = nil
}
```

3. Below `@Published var inviteClaimToConfirm: JSONValue?`, add:

```swift
    @Published var grantRequest: GrantRequest?
    @Published var clients: [JSONValue] = []
    @Published var pairings: [PairingRequest] = []
    @Published var frontDoorNodes: [JSONValue] = []
    @Published var alerts: [JSONValue] = []
    /// Why the front-door screens are not getting through (shown on them, never as an alert).
    @Published var frontDoorProblem: String?
    /// The code the owner typed for `grantRequest`, as the grant carries it.
    private var grantCode: String?
```

- [ ] **Step 3: `AppModel` — learn the front door, re-pin, history markers**

1. In `pairAtConsole`, in the `case "done":` branch, after `await sendPushToken()`, add `await refreshFrontDoor()`.

2. In `pollLoop`, replace

```swift
                if let e = error as? RelayError, e.code == "pin_mismatch" {
                    banner = e.message
```

with

```swift
                if let e = error as? RelayError, e.code == "pin_mismatch" {
                    if await tryRepin() {
                        continue
                    }
                    banner = e.message
```

3. In `loadHistory`, replace

```swift
            history = HistoryPage(nodeId: nodeId, entries: Array(result.entries.reversed()), asOf: slice?["created_at"]?.stringValue ?? "")
```

with

```swift
            var page = HistoryPage(nodeId: nodeId, entries: Array(result.entries.reversed()), asOf: slice?["created_at"]?.stringValue ?? "")
            if state.frontDoorId != nil { page.status = try? await client.auditStatus(nodeId: nodeId) }
            history = page
```

4. In `reset()`, after `inviteClaimToConfirm = nil`, add:

```swift
        grantRequest = nil
        grantCode = nil
        clients = []
        pairings = []
        frontDoorNodes = []
        alerts = []
        frontDoorProblem = nil
```

5. Right before the line `    // MARK: Push`, insert:

```swift
    // MARK: Front door (fleet stage 4)

    /// Sets `state.frontDoorId` only when the relay's GET /v1/frontdoor names a
    /// node this phone pinned from a kl.pair code, with that same key; nothing
    /// else the reply says is trusted. An F3 relay answers 404.
    func refreshFrontDoor() async {
        guard mode == .live, let client else { return }
        do {
            let info = try await client.frontDoorInfo()
            var matched: String?
            if let id = info?["frontdoor_id"]?.stringValue, let key = info?["public_key"]?.stringValue,
               let raw = try? Base64URL.decode(key), raw.count == 32,
               let pin = state.nodes.first(where: { $0.id == id }), pin.key == Identifiers.ed25519SpkiPrefix + Hex.encode(raw) {
                matched = id
            }
            if state.frontDoorId != matched {
                state.frontDoorId = matched
                state.save()
            }
        } catch let e as RelayError where e.status == 404 {
            if state.frontDoorId != nil {
                state.frontDoorId = nil
                state.save()
            }
        } catch {
            frontDoorProblem = describe(error)
        }
    }

    /// Stage 4 §3.3.1: after a pin failure on a front door, exactly one
    /// unauthenticated GET /v1/repin, to the certificate just seen. The new pin
    /// is kept only when the front door's signed re-pin names it, names the
    /// current pin, and verifies against the key pinned from the kl.pair code.
    private func tryRepin() async -> Bool {
        guard let client, let frontDoorId = state.frontDoorId, let pin = state.nodes.first(where: { $0.id == frontDoorId }),
              let seen = client.takeRefusedSpki(), let base = state.relayURL.flatMap({ URL(string: $0) }), let current = state.relaySpki else { return false }
        let probe = RelayAPI(base: base, spkiPin: seen, deviceId: nil, signer: nil)
        defer { probe.invalidate() }
        guard let envelope = try? await probe.repinEnvelope() else { return false }
        let check = FrontDoor.verifyRepin(envelope, frontdoorId: frontDoorId, frontdoorKeyHex: pin.key, receivedSpki: seen, currentPin: current)
        guard check.ok, let newSpki = check.newSpki else { return false }
        state.relaySpki = newSpki
        state.save()
        connect()
        banner = "The front door changed its certificate key. Its signed re-pin checked out, so this phone now pins the new key."
        return true
    }

    /// The typed code, as the grant carries it; the request is claimed for this phone.
    func findGrant(code: String) async {
        grantRequest = nil
        grantCode = nil
        guard let client else { return }
        guard let normalized = FrontDoor.normalizeUserCode(code) else {
            banner = "The code is six letters and digits, like Q7K-M2X."
            return
        }
        do {
            guard let reply = try await client.pendingGrant(userCode: normalized) else { return }
            grantRequest = try GrantRequest(json: reply)
            grantCode = normalized
        } catch let e as RelayError where e.code == "no_such_request" {
            banner = "No connection request with that code."
        } catch {
            fail(error)
        }
    }

    func cancelGrant() {
        grantRequest = nil
        grantCode = nil
    }

    func decideGrant(_ request: GrantRequest, scopes: [ScopeChoice], approve: Bool) async {
        guard let client, let key, let frontDoorId = state.frontDoorId, let code = grantCode else { return }
        do {
            let message = try request.message(frontdoorId: frontDoorId, userCode: code, scopes: scopes, decision: approve ? "approve" : "deny",
                                              nonce: Messages.randomNonce(), deviceId: key.deviceId, signedAt: Timestamps.string(client.now()))
            let name = Display.escape(request.clientName)
            let envelope = try await key.signEnvelope(message, reason: approve ? "Let \(name) use your fleet." : "Refuse \(name).")
            let result = try await client.grantDecision(request.grantId, envelope: envelope)?["state"]?.stringValue
            cancelGrant()
            banner = result == "approved" ? "\(name) is connected. Go back to its window." : "Refused. \(name) was not connected."
        } catch let e as RelayError where e.status == 410 {
            cancelGrant()
            banner = "This connection request expired. Start again in the client."
        } catch {
            fail(error)
        }
    }

    func refreshClients() async {
        guard let client, state.frontDoorId != nil else { return }
        do { clients = try await client.clients() } catch { frontDoorProblem = describe(error) }
    }

    /// Revocation is challenge-bound: a fresh challenge, then the signature.
    func revokeClient(grantId: String, name: String) async {
        guard let client, let key, let frontDoorId = state.frontDoorId else { return }
        do {
            let challenge = try await client.challenge()
            let message = try FrontDoor.clientRevoke(frontdoorId: frontDoorId, grantId: grantId, challenge: challenge,
                                                     deviceId: key.deviceId, signedAt: Timestamps.string(client.now()))
            let envelope = try await key.signEnvelope(message, reason: "Disconnect \(Display.escape(name)).")
            try await client.revokeClient(grantId, envelope: envelope)
            await refreshClients()
        } catch {
            fail(error)
        }
    }

    /// Nodes waiting for this phone; an entry whose id does not derive from its key is dropped.
    func refreshPairings() async {
        guard let client, state.frontDoorId != nil else { return }
        do {
            pairings = try await client.pendingPairings().compactMap { try? PairingRequest(json: $0) }
            frontDoorProblem = nil
        } catch {
            if !Task.isCancelled { frontDoorProblem = describe(error) }
        }
    }

    func decidePairing(_ pairing: PairingRequest, approve: Bool) async {
        guard let client, let key, let frontDoorId = state.frontDoorId else { return }
        do {
            let message = try pairing.message(frontdoorId: frontDoorId, decision: approve ? "approve" : "deny", nonce: Messages.randomNonce(),
                                              deviceId: key.deviceId, signedAt: Timestamps.string(client.now()))
            let name = Display.escape(pairing.nodeName)
            let envelope = try await key.signEnvelope(message, reason: approve ? "Add \(name) (\(pairing.fingerprint)) to your fleet." : "Refuse \(name).")
            let result = try await client.pairingDecision(pairing.pairingId, envelope: envelope)?["state"]?.stringValue
            pairings.removeAll { $0.pairingId == pairing.pairingId }
            banner = result == "enrolled" ? "\(name) is enrolled. It links when its pair command finishes." : "Refused. \(name) was not added."
        } catch {
            fail(error)
        }
    }

    func refreshFrontDoorNodes() async {
        guard let client, state.frontDoorId != nil else { return }
        do { frontDoorNodes = try await client.nodes() } catch { frontDoorProblem = describe(error) }
    }

    func removeNode(nodeId: String, name: String) async {
        guard let client, let key, let frontDoorId = state.frontDoorId else { return }
        do {
            let challenge = try await client.challenge()
            let message = try FrontDoor.nodeRemove(frontdoorId: frontDoorId, nodeId: nodeId, challenge: challenge,
                                                   deviceId: key.deviceId, signedAt: Timestamps.string(client.now()))
            let envelope = try await key.signEnvelope(message, reason: "Remove \(Display.escape(name)) from your fleet.")
            try await client.removeNode(nodeId, envelope: envelope)
            await refreshFrontDoorNodes()
        } catch {
            fail(error)
        }
    }

    /// Read on every app open (spec §3.13), so a chain break is seen even without push.
    func refreshAlerts() async {
        guard let client, state.frontDoorId != nil else { return }
        do { alerts = try await client.alerts(since: "0") } catch { if !Task.isCancelled { frontDoorProblem = describe(error) } }
    }

    func ackAlert(_ id: String) async {
        guard let client else { return }
        do {
            try await client.ackAlert(id)
            await refreshAlerts()
        } catch {
            fail(error)
        }
    }

    /// A push carries only { kind, id }: the app fetches and verifies.
    func openPushed(kind: String, id: String) async {
        switch kind {
        case "pairing": await refreshPairings()
        case "alert": await refreshAlerts()
        default: await openPushed(requestId: id)
        }
    }

    /// Nodes the phone knows by name, and whether a grant can limit to each (Deviation 18).
    var machineChoices: [MachineChoice] {
        state.nodes.filter { $0.id != state.frontDoorId }.map { MachineChoice(name: $0.name, limitable: FrontDoor.isMachineName($0.name)) }
    }
```

6. In `resumePolling()`, as its first line, add:

```swift
        if mode == .live, state.frontDoorId != nil { Task { await refreshAlerts() } }
```

- [ ] **Step 4: The front-door screens**

Create `mobile/ios/App/FrontDoorViews.swift`:

```swift
import KLProtocol
import SwiftUI

/// A node a grant may be limited to; names outside `machines=`'s alphabet
/// (capitals, say) can only be granted without a limit (Deviation 18).
struct MachineChoice: Hashable {
    let name: String
    let limitable: Bool
}

/// Fleet stage 4 §3.15: what the owner does on a front door. Everything the
/// front door or a client says is escaped (Display.escape) before it is shown.
struct FrontDoorView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                if let problem = model.frontDoorProblem {
                    Text(problem).font(.caption).foregroundStyle(.secondary)
                }
                if model.state.frontDoorId == nil {
                    Text("This phone is not paired with a front door.").foregroundStyle(.secondary)
                    Button("Check again") { Task { await model.refreshFrontDoor() } }.disabled(model.mode != .live)
                } else {
                    NavigationLink("Connect a client") { ConnectClientView() }
                    NavigationLink("Connected clients") { ClientsView() }
                    NavigationLink("Nodes waiting for you (\(model.pairings.count))") { PairingsView() }
                    NavigationLink("Nodes") { FrontDoorNodesView() }
                    NavigationLink("Alerts (\(model.alerts.filter { $0["acked"]?.boolValue != true }.count))") { AlertsView() }
                }
            }
            .navigationTitle("Front door")
            .task { await model.refreshFrontDoor() }
        }
    }
}

struct ConnectClientView: View {
    @EnvironmentObject var model: AppModel
    @State private var code = ""
    @State private var enabled: Set<String> = []
    @State private var limits: [String: Set<String>] = [:]
    @State private var busy = false

    var body: some View {
        Form {
            if let request = model.grantRequest {
                Section("Client") {
                    LabeledContent("Name (self-declared)", value: Display.escape(request.clientName))
                    LabeledContent("Client host", value: Display.escape(request.clientHost))
                    LabeledContent("Returns to", value: Display.escape(request.redirectHost))
                }
                Section("What it may do") {
                    ForEach(request.requestedScopes, id: \.self) { scope in
                        Toggle(Display.escape(scope), isOn: Binding(
                            get: { enabled.contains(scope) },
                            set: { on in if on { enabled.insert(scope) } else { enabled.remove(scope) } }
                        ))
                        if enabled.contains(scope) && scope != "fleet:unsafe" {
                            ForEach(model.machineChoices, id: \.name) { machine in
                                Toggle("Only \(Display.escape(machine.name))", isOn: Binding(
                                    get: { limits[scope]?.contains(machine.name) == true },
                                    set: { on in
                                        var set = limits[scope] ?? []
                                        if on { set.insert(machine.name) } else { set.remove(machine.name) }
                                        limits[scope] = set
                                    }
                                ))
                                .disabled(!machine.limitable)
                                .font(.caption)
                            }
                        }
                    }
                    Text("With no machine chosen, the client may use every machine. Unsafe actions still need your phone each time.").font(.caption)
                }
                Section {
                    Button("Approve") { decide(request, true) }.disabled(busy || enabled.isEmpty)
                    Button("Deny", role: .destructive) { decide(request, false) }.disabled(busy)
                }
            } else {
                Section("The code the client's browser shows") {
                    TextField("XXX-XXX", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    Button("Find the request") {
                        Task {
                            await model.findGrant(code: code)
                            enabled = Set(model.grantRequest?.preselected ?? [])
                            limits = [:]
                        }
                    }
                    .disabled(code.isEmpty || model.mode != .live)
                }
            }
        }
        .navigationTitle("Connect a client")
        .onDisappear { model.cancelGrant() }
    }

    private func decide(_ request: GrantRequest, _ approve: Bool) {
        busy = true
        let scopes = enabled.map { scope -> ScopeChoice in
            let machines = limits[scope].flatMap { $0.isEmpty ? nil : Array($0) }
            return ScopeChoice(scope: scope, machines: scope == "fleet:unsafe" ? nil : machines)
        }
        Task {
            await model.decideGrant(request, scopes: scopes, approve: approve)
            busy = false
            code = ""
        }
    }
}

struct ClientsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            if model.clients.isEmpty { Text("No client is connected.").foregroundStyle(.secondary) }
            ForEach(Array(model.clients.enumerated()), id: \.offset) { _, grant in
                let name = grant["client_name"]?.stringValue ?? ""
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Display.escape(name)) (self-declared)").font(.headline)
                    Text(Display.escape(grant["client_host"]?.stringValue ?? "")).font(.caption)
                    Text((grant["scopes"]?.arrayValue ?? []).compactMap { $0.stringValue }.map(Display.escape).joined(separator: ", ")).font(.caption.monospaced())
                    Text("Last used \(Display.escape(grant["last_used_at"]?.stringValue ?? "never"))").font(.caption).foregroundStyle(.secondary)
                    Button("Revoke", role: .destructive) {
                        Task { await model.revokeClient(grantId: grant["grant_id"]?.stringValue ?? "", name: name) }
                    }
                }
            }
        }
        .navigationTitle("Connected clients")
        .task { await model.refreshClients() }
        .refreshable { await model.refreshClients() }
    }
}

struct PairingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var busy = false

    var body: some View {
        List {
            if model.pairings.isEmpty { Text("No node is waiting. Give the node its code, then run pair on it.").foregroundStyle(.secondary) }
            ForEach(model.pairings, id: \.pairingId) { pairing in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Display.escape(pairing.nodeName)) (\(pairing.profile))").font(.headline)
                    Text(pairing.fingerprint).font(.body.monospaced())
                    Text("Check the node's console shows the same fingerprint.").font(.caption)
                    if let old = pairing.replaces {
                        Text("Replaces \(FrontDoor.nodeFingerprint(old))").font(.caption).foregroundStyle(.orange)
                    }
                    HStack {
                        Button("Approve") { act(pairing, true) }.disabled(busy)
                        Button("Deny", role: .destructive) { act(pairing, false) }.disabled(busy)
                    }
                }
            }
        }
        .navigationTitle("Nodes waiting for you")
        // Every 5 s while this screen is open (spec §3.13).
        .task {
            while !Task.isCancelled {
                await model.refreshPairings()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func act(_ pairing: PairingRequest, _ approve: Bool) {
        busy = true
        Task {
            await model.decidePairing(pairing, approve: approve)
            busy = false
        }
    }
}

struct FrontDoorNodesView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            ForEach(Array(model.frontDoorNodes.enumerated()), id: \.offset) { _, node in
                let id = node["node_id"]?.stringValue ?? ""
                let name = node["node_name"]?.stringValue ?? ""
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(Display.escape(name)).font(.headline)
                        Spacer()
                        Circle().fill(node["online"]?.boolValue == true ? Color.green : Color.gray).frame(width: 10, height: 10)
                    }
                    Text(Display.escape(FrontDoor.nodeFingerprint(id))).font(.caption.monospaced())
                    Text("\(Display.escape(node["profile"]?.stringValue ?? "")) · confirmed at the \(Display.escape(node["source"]?.stringValue ?? "")) · audit \(Display.escape(node["audit"]?.stringValue ?? ""))").font(.caption)
                    if node["source"]?.stringValue == "phone" {
                        Button("Remove", role: .destructive) { Task { await model.removeNode(nodeId: id, name: name) } }
                    }
                }
            }
        }
        .navigationTitle("Nodes")
        .task { await model.refreshFrontDoorNodes() }
        .refreshable { await model.refreshFrontDoorNodes() }
    }
}

struct AlertsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        List {
            if model.alerts.isEmpty { Text("No alerts.").foregroundStyle(.secondary) }
            ForEach(Array(model.alerts.reversed().enumerated()), id: \.offset) { _, alert in
                VStack(alignment: .leading, spacing: 4) {
                    Text(Display.escape(alert["kind"]?.stringValue ?? "")).font(.headline)
                    Text(Display.escape(alert["subject"]?.stringValue ?? "")).font(.caption.monospaced())
                    Text(Display.escape(alert["detail"].map { JCS.serialize($0) } ?? "")).font(.caption.monospaced())
                    Text(Display.escape(alert["at"]?.stringValue ?? "")).font(.caption).foregroundStyle(.secondary)
                    if alert["acked"]?.boolValue != true {
                        Button("Acknowledge") { Task { await model.ackAlert(alert["id"]?.stringValue ?? "") } }
                    }
                }
            }
        }
        .navigationTitle("Alerts")
        .task { await model.refreshAlerts() }
        .refreshable { await model.refreshAlerts() }
    }
}
```

- [ ] **Step 5: Wire the tab, the labels and the markers**

In `mobile/ios/App/Views.swift`:

1. In `MainView`, add after the `NodesView()` tab line:

```swift
                FrontDoorView().tabItem { Label("Front door", systemImage: "door.left.hand.open") }
```

2. In `ApprovalDetailView`, replace `LabeledContent("Asked by", value: originText(item.display["origin"]))` with:

```swift
                        LabeledContent(model.state.frontDoorId == nil ? "Asked by" : "Client (reported by front door)", value: originText(item.display["origin"]))
```

3. In `HistoryView`, inside `if let page = model.history, page.nodeId == nodeId {`, before the `Section("As of …")`, add:

```swift
                    if let status = page.status {
                        let gaps = status["gaps"]?.arrayValue ?? []
                        let breaks = status["breaks"]?.arrayValue ?? []
                        if !gaps.isEmpty || !breaks.isEmpty {
                            Section("Reported by front door") {
                                ForEach(Array(breaks.enumerated()), id: \.offset) { _, b in
                                    Text("Break: \(Display.escape(b["reason"]?.stringValue ?? "")) at #\(b["seq"]?.intValue ?? 0)").foregroundStyle(.red)
                                }
                                ForEach(Array(gaps.enumerated()), id: \.offset) { _, g in
                                    Text("\(Display.escape(g["kind"]?.stringValue ?? "gap")): #\(g["from_seq"]?.intValue ?? 0)–#\(g["to_seq"]?.intValue ?? 0)")
                                }
                            }
                        }
                    }
```

4. In `SettingsView`, inside `Section("Relay") { … }`, after the `Text(model.state.relaySpki ?? "")` line, add:

```swift
                    if let id = model.state.frontDoorId {
                        Text("Front door \(FrontDoor.nodeFingerprint(id))").font(.caption.monospaced())
                    }
```

In `mobile/ios/App/KingLouieApp.swift`:

1. Replace `var onOpen: ((String) -> Void)?` with `var onOpen: ((String, String) -> Void)?` (kind, id).
2. Replace the body of `userNotificationCenter(_:didReceive:)` with:

```swift
        let kl = response.notification.request.content.userInfo["kl"] as? [String: Any]
        guard let id = kl?["rid"] as? String else { return }
        let kind = (kl?["k"] as? String) ?? "approval"
        guard ["approval", "pairing", "alert"].contains(kind) else { return }
        await MainActor.run { onOpen?(kind, id) }
```

and its doc comment's last sentence with "Approval, pairing and alert pushes are handled; the app fetches and verifies what they name itself."
3. In `KingLouieApp.body`, replace `delegate.onOpen = { rid in Task { await model.openPushed(requestId: rid) } }` with:

```swift
                    delegate.onOpen = { kind, id in Task { await model.openPushed(kind: kind, id: id) } }
```

- [ ] **Step 6: Build and check by hand**

Run (macOS, in `mobile/ios`): `xcodegen generate && xcodebuild -scheme KingLouie -destination 'generic/platform=iOS Simulator' build`
Expected: `** BUILD SUCCEEDED **`.

Then, against a local front door (`CLAUDE.md` › Front door; a device on the same network, `frontdoor enroll-device` for the phone): the Front door tab lists its screens; a client's `XXX-XXX` code finds the request with the name marked self-declared; approving connects it; *Connected clients* revokes it; `frontdoor code gpu-box` + `pair https://…` shows the node under *Nodes waiting for you* within 5 s with the fingerprint the node prints; *Alerts* shows a `dns_probe_failed` after three failed probes; `frontdoor rotate-tls-key` (ACME) or a new operator certificate plus a published re-pin re-pins the phone with one request and a banner.

Run (from `mobile/ios/KLProtocol`): `swift test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add mobile/ios/App/RelayAPI.swift mobile/ios/App/AppModel.swift mobile/ios/App/FrontDoorViews.swift mobile/ios/App/Views.swift mobile/ios/App/KingLouieApp.swift
git commit -m "feat(ios): front door screens: connect a client, clients, node pairings, alerts, history markers, signed re-pin" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 38: The Android app — the same screens, with a prompt per request

**Files:**
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt` (`PinningTrustManager`, the client's trust manager, front-door calls)
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt` (`Storage`, state, console-enrollment success, `checkNow`'s `pin_mismatch`, `loadHistory`, a front-door section, `reset`)
- Create: `mobile/android/app/src/main/kotlin/com/example/kinglouie/FrontDoorScreens.kt`
- Modify: `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt` (`Main` tabs, `Detail` label, `History` markers, `Settings` fingerprint)
- Modify: `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt`, `mobile/android/app/src/nopush/kotlin/com/example/kinglouie/push/Push.kt`, `mobile/android/app/src/main/kotlin/com/example/kinglouie/MainActivity.kt` (push kinds)

**Interfaces:**
- Consumes: Task 36 (`FrontDoor`, `GrantRequest`, `PairingRequest`, `ScopeChoice`), the phone routes, F3's `RelayApi` and `AppModel` (`signEnvelope`, `describe`, `fail`, `connect`).
- Produces: the iOS set of Task 37 on Android. On this phone every device-signed request is a biometric prompt (F3), so node pairings and alerts are fetched when the owner taps, not every 5 s or on every open (Deviation 30); a tapped `pairing` or `alert` notification fetches its list. The re-pin rule and the "reported by front door" and "Client (reported by front door)" labels are the same.

- [ ] **Step 1: `RelayApi` — the refused certificate, and the front-door calls**

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt`:

1. Replace `class PinningTrustManager(private val pin: String) : X509TrustManager { … }`'s `checkServerTrusted` with:

```kotlin
    /** The pin of the last certificate this refused (fleet stage 4 §3.3.1). */
    @Volatile
    var refusedSpki: String? = null

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw PinMismatchException()
        val actual = "sha256/" + Digest.sha256B64url(leaf.publicKey.encoded)
        if (actual != pin) {
            refusedSpki = actual
            throw PinMismatchException()
        }
    }
```

2. In `class RelayApi`, replace

```kotlin
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(PinningTrustManager(pin)), null) }
```

with

```kotlin
    private val trust = PinningTrustManager(pin)
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }

    /** The pin of the certificate the last refusal saw, once. */
    fun takeRefusedSpki(): String? = trust.refusedSpki.also { trust.refusedSpki = null }
```

3. After `consoleEnrollState`, add:

```kotlin
    // Front door (fleet stage 4, client-grant-v1 §7)

    suspend fun frontDoorInfo(): JsonElement? = request("GET", "/v1/frontdoor").second

    /** Claims the request for this phone; 404 `no_such_request` when the code matches nothing. */
    suspend fun pendingGrant(userCode: String): JsonElement? = request("GET", "/v1/grants/pending?user_code=${segment(userCode)}").second
    suspend fun grantDecision(grantId: String, envelope: Envelope): JsonElement? = request("POST", "/v1/grants/${segment(grantId)}/decision", envelope.json).second
    suspend fun clients(): List<JsonElement> = request("GET", "/v1/clients").second.arr() ?: emptyList()
    suspend fun challenge(): String = request("POST", "/v1/challenges").second["challenge"].str()
        ?: throw RelayException(0, "malformed", "The front door sent a reply this app refuses as malformed.")
    suspend fun revokeClient(grantId: String, envelope: Envelope) {
        request("POST", "/v1/clients/${segment(grantId)}/revoke", envelope.json)
    }
    suspend fun pendingPairings(): List<JsonElement> = request("GET", "/v1/pairings/pending").second.arr() ?: emptyList()
    suspend fun pairingDecision(pairingId: String, envelope: Envelope): JsonElement? = request("POST", "/v1/pairings/${segment(pairingId)}/decision", envelope.json).second
    suspend fun removeNode(nodeId: String, envelope: Envelope) {
        request("POST", "/v1/nodes/${segment(nodeId)}/remove", envelope.json)
    }
    suspend fun alerts(since: String): List<JsonElement> = request("GET", "/v1/alerts?since=${segment(since)}").second.arr() ?: emptyList()
    suspend fun ackAlert(id: String) {
        request("POST", "/v1/alerts/${segment(id)}/ack")
    }
    suspend fun auditStatus(nodeId: String): JsonElement? = request("GET", "/v1/nodes/${segment(nodeId)}/audit-status").second

    /** Unauthenticated: the one request a phone makes after its pin failed. */
    suspend fun repinEnvelope(): JsonElement? = request("GET", "/v1/repin", auth = false).second
```

- [ ] **Step 2: `AppModel` — storage and state**

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt`:

1. Add the imports `com.example.kinglouie.protocol.FrontDoor`, `com.example.kinglouie.protocol.GrantRequest`, `com.example.kinglouie.protocol.PairingRequest` and `com.example.kinglouie.protocol.ScopeChoice`.

2. In `class Storage`, below `pushTokenSent`, add:

```kotlin
    /** The front door this phone's relay is (fleet stage 4): set only when GET /v1/frontdoor names a node pinned from a kl.pair code, with that key. */
    var frontDoorId: String?
        get() = prefs.getString("frontDoorId", null)
        set(v) = prefs.edit().putString("frontDoorId", v).apply()
```

3. In `class AppModel`, replace `var history by mutableStateOf<Pair<String, List<JsonElement>>?>(null)` with:

```kotlin
    var history by mutableStateOf<Pair<String, List<JsonElement>>?>(null)

    /** The front door's own gap and break records for the page in `history` ("reported by front door"). */
    var historyStatus by mutableStateOf<JsonElement?>(null)
    var frontDoorId by mutableStateOf(storage.frontDoorId)
        private set
    var grantRequest by mutableStateOf<GrantRequest?>(null)
    private var grantCode: String? = null
    val clients = mutableStateListOf<JsonElement>()
    val pairings = mutableStateListOf<PairingRequest>()
    val frontDoorNodes = mutableStateListOf<JsonElement>()
    val alerts = mutableStateListOf<JsonElement>()
```

- [ ] **Step 3: `AppModel` — learn the front door, re-pin, history markers, the front-door calls**

1. In `pairAtConsole`, in the `"done" -> { … }` branch, after `sendPushToken()`, add `refreshFrontDoorNow()`.

2. In `checkNow`, replace

```kotlin
                if (e.code == "pin_mismatch") banner = describe(e)
```

with

```kotlin
                if (e.code == "pin_mismatch") {
                    if (tryRepin()) {
                        pollProblem = "Re-pinned the front door. Tap “Check for requests” again."
                        return@launch
                    }
                    banner = describe(e)
                }
```

3. In `loadHistory`, replace `history = (slice["created_at"].str() ?: "") to result.entries.reversed()` with:

```kotlin
            history = (slice["created_at"].str() ?: "") to result.entries.reversed()
            historyStatus = if (frontDoorId != null) runCatching { client?.auditStatus(nodeId) }.getOrNull() else null
```

4. In `reset()`, after `openInvite = null`, add:

```kotlin
        grantRequest = null
        grantCode = null
        clients.clear()
        pairings.clear()
        frontDoorNodes.clear()
        alerts.clear()
        historyStatus = null
        frontDoorId = null
```

5. Before `// Push`, insert:

```kotlin
    // Front door (fleet stage 4)

    private fun setFrontDoor(id: String?) {
        frontDoorId = id
        storage.frontDoorId = id
    }

    /**
     * Sets the front door only when GET /v1/frontdoor names a node this phone
     * pinned from a kl.pair code, with that same key; an F3 relay answers 404.
     */
    private suspend fun refreshFrontDoorNow() {
        val api = client ?: return
        try {
            val info = api.frontDoorInfo()
            val id = info["frontdoor_id"].str()
            val raw = info["public_key"].str()?.let { runCatching { B64Url.decode(it) }.getOrNull() }
            val pin = storage.nodes.firstOrNull { it.id == id }
            setFrontDoor(if (id != null && raw != null && raw.size == 32 && pin != null && pin.key == Identifiers.ED25519_SPKI_PREFIX + Hex.encode(raw)) id else null)
        } catch (e: RelayException) {
            if (e.status == 404) setFrontDoor(null) else fail(e)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshFrontDoor() = scope.launch { refreshFrontDoorNow() }

    /**
     * Stage 4 §3.3.1: after a pin failure on a front door, exactly one
     * unauthenticated GET /v1/repin to the certificate just seen; the new pin
     * is kept only when the signed re-pin checks out against the kl.pair key.
     */
    private suspend fun tryRepin(): Boolean {
        val api = client ?: return false
        val fd = frontDoorId ?: return false
        val pin = storage.nodes.firstOrNull { it.id == fd } ?: return false
        val seen = api.takeRefusedSpki() ?: return false
        val url = storage.relayUrl ?: return false
        val current = storage.relaySpki ?: return false
        val envelope = try {
            RelayApi(url, seen, null, null).repinEnvelope()
        } catch (e: Exception) {
            null
        } ?: return false
        val check = FrontDoor.verifyRepin(envelope, fd, pin.key, seen, current)
        val newSpki = check.newSpki
        if (!check.ok || newSpki == null) return false
        storage.relaySpki = newSpki
        connect()
        banner = "The front door changed its certificate key. Its signed re-pin checked out, so this phone now pins the new key."
        return true
    }

    fun findGrant(code: String) = scope.launch {
        grantRequest = null
        grantCode = null
        val api = client ?: return@launch
        val normalized = FrontDoor.normalizeUserCode(code)
        if (normalized == null) {
            banner = "The code is six letters and digits, like Q7K-M2X."
            return@launch
        }
        try {
            val reply = api.pendingGrant(normalized) ?: return@launch
            grantRequest = GrantRequest(reply)
            grantCode = normalized
        } catch (e: RelayException) {
            if (e.code == "no_such_request") banner = "No connection request with that code." else fail(e)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun cancelGrant() {
        grantRequest = null
        grantCode = null
    }

    fun decideGrant(request: GrantRequest, scopes: List<ScopeChoice>, approve: Boolean) = scope.launch {
        val api = client ?: return@launch
        val k = key ?: return@launch
        val fd = frontDoorId ?: return@launch
        val code = grantCode ?: return@launch
        try {
            val message = request.message(fd, code, scopes, if (approve) "approve" else "deny", Messages.randomNonce(), k.deviceId, Timestamps.string(api.now()))
            val name = Display.escape(request.clientName)
            val envelope = signEnvelope(k, message, if (approve) "Connect a client" else "Refuse a client", if (approve) "Let $name use your fleet" else "Refuse $name")
            val result = api.grantDecision(request.grantId, envelope)["state"].str()
            cancelGrant()
            banner = if (result == "approved") "$name is connected. Go back to its window." else "Refused. $name was not connected."
        } catch (e: RelayException) {
            if (e.status == 410) {
                cancelGrant()
                banner = "This connection request expired. Start again in the client."
            } else fail(e)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshClients() = scope.launch {
        val api = client ?: return@launch
        try {
            val list = api.clients()
            clients.clear()
            clients.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Revocation is challenge-bound: a fresh challenge, then the signature. */
    fun revokeClient(grantId: String, name: String) = scope.launch {
        val api = client ?: return@launch
        val k = key ?: return@launch
        val fd = frontDoorId ?: return@launch
        try {
            val challenge = api.challenge()
            val message = FrontDoor.clientRevoke(fd, grantId, challenge, k.deviceId, Timestamps.string(api.now()))
            api.revokeClient(grantId, signEnvelope(k, message, "Disconnect a client", "Disconnect ${Display.escape(name)}"))
            val list = api.clients()
            clients.clear()
            clients.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Nodes waiting for this phone; an entry whose id does not derive from its key is dropped. */
    fun refreshPairings() = scope.launch {
        val api = client ?: return@launch
        try {
            val list = api.pendingPairings().mapNotNull { runCatching { PairingRequest(it) }.getOrNull() }
            pairings.clear()
            pairings.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun decidePairing(pairing: PairingRequest, approve: Boolean) = scope.launch {
        val api = client ?: return@launch
        val k = key ?: return@launch
        val fd = frontDoorId ?: return@launch
        try {
            val message = pairing.message(fd, if (approve) "approve" else "deny", Messages.randomNonce(), k.deviceId, Timestamps.string(api.now()))
            val name = Display.escape(pairing.nodeName)
            val envelope = signEnvelope(k, message, if (approve) "Add a node" else "Refuse a node", if (approve) "Add $name (${pairing.fingerprint})" else "Refuse $name")
            val result = api.pairingDecision(pairing.pairingId, envelope)["state"].str()
            pairings.removeAll { it.pairingId == pairing.pairingId }
            banner = if (result == "enrolled") "$name is enrolled. It links when its pair command finishes." else "Refused. $name was not added."
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshFrontDoorNodes() = scope.launch {
        val api = client ?: return@launch
        try {
            val list = api.nodes()
            frontDoorNodes.clear()
            frontDoorNodes.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun removeNode(nodeId: String, name: String) = scope.launch {
        val api = client ?: return@launch
        val k = key ?: return@launch
        val fd = frontDoorId ?: return@launch
        try {
            val challenge = api.challenge()
            val message = FrontDoor.nodeRemove(fd, nodeId, challenge, k.deviceId, Timestamps.string(api.now()))
            api.removeNode(nodeId, signEnvelope(k, message, "Remove a node", "Remove ${Display.escape(name)} from your fleet"))
            frontDoorNodes.removeAll { it["node_id"].str() == nodeId }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshAlerts() = scope.launch {
        val api = client ?: return@launch
        try {
            val list = api.alerts("0")
            alerts.clear()
            alerts.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun ackAlert(id: String) = scope.launch {
        val api = client ?: return@launch
        try {
            api.ackAlert(id)
            val list = api.alerts("0")
            alerts.clear()
            alerts.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** A tapped notification carries only { kind, id }: the app fetches and verifies. */
    fun openPushed(kind: String, id: String) {
        when (kind) {
            "pairing" -> refreshPairings()
            "alert" -> refreshAlerts()
            else -> openPushed(id)
        }
    }

    /** Nodes the phone knows by name, and whether a grant can limit to each (Deviation 18). */
    val machineChoices: List<Pair<String, Boolean>>
        get() = storage.nodes.filter { it.id != frontDoorId }.map { it.name to FrontDoor.isMachineName(it.name) }
```

- [ ] **Step 4: The front-door screens**

Create `mobile/android/app/src/main/kotlin/com/example/kinglouie/FrontDoorScreens.kt`:

```kotlin
package com.example.kinglouie

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.ScopeChoice
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.str

/** Front-door text (not a pinned node's), escaped like any display text. */
private fun fdText(value: kotlinx.serialization.json.JsonElement?): String = Display.escape(value.str() ?: "")

/**
 * Fleet stage 4 §3.15. Each list is fetched when the owner taps: on this phone
 * every device-signed request is a biometric prompt (Deviation 30).
 */
@Composable
fun FrontDoor(model: AppModel) {
    var screen by remember { mutableStateOf("menu") }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.frontDoorId == null) {
            Text("This phone is not paired with a front door.")
            OutlinedButton({ model.refreshFrontDoor() }, enabled = model.mode == AppMode.LIVE) { Text("Check again") }
            return@Column
        }
        if (screen != "menu") TextButton({ screen = "menu"; model.cancelGrant() }) { Text("Back") }
        when (screen) {
            "connect" -> ConnectClient(model)
            "clients" -> Clients(model)
            "pairings" -> Pairings(model)
            "nodes" -> FrontDoorNodes(model)
            "alerts" -> Alerts(model)
            else -> {
                Button({ screen = "connect" }) { Text("Connect a client") }
                OutlinedButton({ screen = "clients"; model.refreshClients() }) { Text("Connected clients") }
                OutlinedButton({ screen = "pairings"; model.refreshPairings() }) { Text("Nodes waiting for you") }
                OutlinedButton({ screen = "nodes"; model.refreshFrontDoorNodes() }) { Text("Nodes") }
                OutlinedButton({ screen = "alerts"; model.refreshAlerts() }) { Text("Alerts") }
            }
        }
    }
}

@Composable
fun ConnectClient(model: AppModel) {
    var code by remember { mutableStateOf("") }
    var enabled by remember { mutableStateOf(setOf<String>()) }
    var limits by remember { mutableStateOf(mapOf<String, Set<String>>()) }
    val request = model.grantRequest
    // A new request starts from what the front door preselected, with no machine limits.
    LaunchedEffect(request) {
        enabled = request?.preselected?.toSet() ?: emptySet()
        limits = emptyMap()
    }
    if (request == null) {
        Text("The code the client's browser shows", fontWeight = FontWeight.Bold)
        OutlinedTextField(code, { code = it }, label = { Text("XXX-XXX") })
        Button({ model.findGrant(code) }, enabled = code.isNotBlank() && model.mode == AppMode.LIVE) { Text("Find the request") }
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Text("${Display.escape(request.clientName)} (self-declared)", fontWeight = FontWeight.Bold)
            Text("Client host: ${Display.escape(request.clientHost)}")
            Text("Returns to: ${Display.escape(request.redirectHost)}")
            HorizontalDivider(Modifier.padding(vertical = 6.dp))
        }
        items(request.requestedScopes) { scope ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(scope in enabled, { on -> enabled = if (on) enabled + scope else enabled - scope })
                Text(Display.escape(scope), fontFamily = FontFamily.Monospace)
            }
            if (scope in enabled && scope != "fleet:unsafe") {
                model.machineChoices.forEach { (name, limitable) ->
                    Row(Modifier.padding(start = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                        val chosen = limits[scope].orEmpty()
                        Checkbox(name in chosen, { on -> limits = limits + (scope to (if (on) chosen + name else chosen - name)) }, enabled = limitable)
                        Text("Only ${Display.escape(name)}", color = if (limitable) Color.Unspecified else Color.Gray)
                    }
                }
            }
        }
        item {
            Text("With no machine chosen, the client may use every machine. Unsafe actions still need your phone each time.")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
                val scopes = enabled.map { s -> ScopeChoice(s, if (s == "fleet:unsafe") null else limits[s]?.takeIf { it.isNotEmpty() }?.toList()) }
                Button({ model.decideGrant(request, scopes, true); code = "" }, enabled = enabled.isNotEmpty()) { Text("Approve") }
                OutlinedButton({ model.decideGrant(request, scopes, false); code = "" }) { Text("Deny") }
            }
        }
    }
}

@Composable
fun Clients(model: AppModel) {
    if (model.clients.isEmpty()) Text("No client is connected.")
    LazyColumn {
        items(model.clients) { g ->
            val name = g["client_name"].str() ?: ""
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${Display.escape(name)} (self-declared)", fontWeight = FontWeight.Bold)
                Text(fdText(g["client_host"]))
                Text(g["scopes"].arr().orEmpty().joinToString(", ") { Display.escape(it.str() ?: "") }, fontFamily = FontFamily.Monospace)
                Text("Last used ${fdText(g["last_used_at"]).ifEmpty { "never" }}", color = Color.Gray)
                TextButton({ model.revokeClient(g["grant_id"].str() ?: "", name) }) { Text("Revoke") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun Pairings(model: AppModel) {
    OutlinedButton({ model.refreshPairings() }) { Text("Check for nodes") }
    if (model.pairings.isEmpty()) Text("No node is waiting. Give the node its code, then run pair on it.")
    LazyColumn {
        items(model.pairings, key = { it.pairingId }) { p ->
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${Display.escape(p.nodeName)} (${p.profile})", fontWeight = FontWeight.Bold)
                Text(p.fingerprint, fontFamily = FontFamily.Monospace)
                Text("Check the node's console shows the same fingerprint.")
                p.replaces?.let { Text("Replaces ${FrontDoor.nodeFingerprint(it)}", color = Color(0xFFE65100)) }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button({ model.decidePairing(p, true) }) { Text("Approve") }
                    OutlinedButton({ model.decidePairing(p, false) }) { Text("Deny") }
                }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun FrontDoorNodes(model: AppModel) {
    LazyColumn {
        items(model.frontDoorNodes) { n ->
            val id = n["node_id"].str() ?: ""
            val name = n["node_name"].str() ?: ""
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${Display.escape(name)}  ${if (n["online"].bool() == true) "online" else "offline"}", fontWeight = FontWeight.Bold)
                Text(Display.escape(FrontDoor.nodeFingerprint(id)), fontFamily = FontFamily.Monospace)
                Text("${fdText(n["profile"])} · confirmed at the ${fdText(n["source"])} · audit ${fdText(n["audit"])}")
                if (n["source"].str() == "phone") TextButton({ model.removeNode(id, name) }) { Text("Remove") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun Alerts(model: AppModel) {
    if (model.alerts.isEmpty()) Text("No alerts.")
    LazyColumn {
        items(model.alerts.reversed()) { a ->
            Column(Modifier.padding(vertical = 6.dp)) {
                Text(fdText(a["kind"]), fontWeight = FontWeight.Bold)
                Text(fdText(a["subject"]), fontFamily = FontFamily.Monospace)
                Text(Display.escape(a["detail"]?.let { Jcs.serialize(it) } ?: ""), fontFamily = FontFamily.Monospace)
                Text(fdText(a["at"]), color = Color.Gray)
                if (a["acked"].bool() != true) TextButton({ model.ackAlert(a["id"].str() ?: "") }) { Text("Acknowledge") }
            }
            HorizontalDivider()
        }
    }
}
```

- [ ] **Step 5: Wire the tab, the labels, the markers and the push kinds**

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt`:

1. In `Main`, replace `val tabs = listOf("Pending", "History", "Nodes", "Devices", "Settings")` with `val tabs = listOf("Pending", "History", "Nodes", "Front door", "Devices", "Settings")`, and the `when (tab)` block with:

```kotlin
            when (tab) {
                0 -> Pending(model)
                1 -> History(model)
                2 -> Nodes(model)
                3 -> FrontDoor(model)
                4 -> Devices(model)
                else -> Settings(model)
            }
```

2. In `Detail`, replace `Text("Asked by: " + (` with `Text((if (model.frontDoorId == null) "Asked by: " else "Client (reported by front door): ") + (`.

3. In `History`, inside `model.history?.let { (asOf, entries) -> … }`, before `Text("As of …")`, add:

```kotlin
            model.historyStatus?.let { status ->
                val breaks = status["breaks"].arr().orEmpty()
                val gaps = status["gaps"].arr().orEmpty()
                if (breaks.isNotEmpty() || gaps.isNotEmpty()) {
                    Text("Reported by front door", fontWeight = FontWeight.Bold)
                    breaks.forEach { b -> Text("Break: ${relayText(b["reason"])} at #${b["seq"].int() ?: 0}", color = Color.Red) }
                    gaps.forEach { g -> Text("${relayText(g["kind"])}: #${g["from_seq"].int() ?: 0}–#${g["to_seq"].int() ?: 0}") }
                }
            }
```

4. In `Settings`, after `Text(model.relaySpki ?: "", fontFamily = FontFamily.Monospace)`, add:

```kotlin
        model.frontDoorId?.let { Text("Front door ${com.example.kinglouie.protocol.FrontDoor.nodeFingerprint(it)}", fontFamily = FontFamily.Monospace) }
```

In `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt`:

1. In `object Push`, below `const val EXTRA_REQUEST_ID = "kl.rid"`, add `const val EXTRA_KIND = "kl.k"`.
2. In `onMessageReceived`, replace

```kotlin
        val kind = message.data["k"] ?: "approval"
        if (kind != "approval") return
```

with

```kotlin
        val kind = message.data["k"] ?: "approval"
        if (kind !in setOf("approval", "pairing", "alert")) return
```

and replace

```kotlin
            Intent(this, MainActivity::class.java).putExtra(Push.EXTRA_REQUEST_ID, rid).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
```

with

```kotlin
            Intent(this, MainActivity::class.java).putExtra(Push.EXTRA_REQUEST_ID, rid).putExtra(Push.EXTRA_KIND, kind).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
```

and

```kotlin
            .setContentText(if (node.isEmpty()) "Approval needed" else "Approval needed on $node")
```

with

```kotlin
            .setContentText(
                when (kind) {
                    "pairing" -> "Pairing request"
                    "alert" -> "Alert"
                    else -> if (node.isEmpty()) "Approval needed" else "Approval needed on $node"
                }
            )
```

In `mobile/android/app/src/nopush/kotlin/com/example/kinglouie/push/Push.kt`, below `const val EXTRA_REQUEST_ID = "kl.rid"`, add `const val EXTRA_KIND = "kl.k"`.

In `mobile/android/app/src/main/kotlin/com/example/kinglouie/MainActivity.kt`, replace the body of `handle(intent: Intent?)` with:

```kotlin
        val id = intent?.getStringExtra(Push.EXTRA_REQUEST_ID) ?: return
        model.openPushed(intent.getStringExtra(Push.EXTRA_KIND) ?: "approval", id)
```

and its doc comment with "A tapped notification carries only a kind and an id; the app fetches and verifies."

- [ ] **Step 6: Build and check by hand**

Run (from `mobile/android`): `./gradlew :app:assembleNopushDebug :app:assembleFcmDebug`
Expected: `BUILD SUCCESSFUL`.

Run (from `mobile/android/protocol`): `./gradlew test`
Expected: all tests pass.

Then, against a local front door, the same checks as Task 37 Step 6, each fetch behind a fingerprint prompt: *Connect a client* finds and approves a request; *Connected clients* revokes; *Nodes waiting for you* → *Check for nodes* shows a pairing with the node's fingerprint; *Alerts* lists and acknowledges; a rotated key re-pins with one unauthenticated request.

- [ ] **Step 7: Commit**

```bash
git add mobile/android/app/src/main/kotlin/com/example/kinglouie/RelayApi.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/AppModel.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/FrontDoorScreens.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/Screens.kt mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt mobile/android/app/src/nopush/kotlin/com/example/kinglouie/push/Push.kt mobile/android/app/src/main/kotlin/com/example/kinglouie/MainActivity.kt
git commit -m "feat(android): front door screens: connect a client, clients, node pairings, alerts, history markers, signed re-pin" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 6

Fleet stage 4 is complete when `npm test`, `swift test` (in `mobile/ios/KLProtocol`) and the Android protocol module's `./gradlew test` all pass on `feat/fleet-stage4`, and the §10 table is covered: the five conditions the parent is silent on are pinned by `frontdoor-acme` (Part 3), `frontdoor-registry` (Part 3), `frontdoor-mcp-http` (Part 4), `fleet-node-link` and `frontdoor-probe` (Parts 2 and 5), and `frontdoor-registry` with `frontdoor-router` (Parts 3 and 5).
