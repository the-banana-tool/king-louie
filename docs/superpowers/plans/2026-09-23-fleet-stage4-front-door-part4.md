# Fleet Stage 4: Front door — Implementation Plan (Part 4 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the front door's OAuth 2.1 authorization server (client registration and metadata documents, the typed-code consent page, phone-signed grants, opaque rotating tokens, revocation) and its MCP Streamable HTTP endpoint on `https://mcp.<domain>`.

**Architecture:** New modules under `src/frontdoor/oauth/` (`errors`, `cimd`, `clients`, `pending`, `pages`, `server`, `grants`, `codes`, `grant-routes`, `tokens`), `src/frontdoor/http-util.js`, `src/frontdoor/http.js` and `src/frontdoor/mcp/http-endpoint.js`. Everything is plain `http` request handlers, so tests drive them over loopback HTTP through `tests/helpers/frontdoor-harness.js` with no TLS. The grant routes register on F3's phone API. Nothing is started by a service yet (Part 5 does that). Parts 1–3 must be on the branch.

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Node `http`/`crypto`/`dns`. No new npm dependency in this part.

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

### Task 21: OAuth clients — dynamic registration and client ID metadata documents

**Files:**
- Create: `src/frontdoor/oauth/errors.js`
- Create: `src/frontdoor/oauth/cimd.js`
- Create: `src/frontdoor/oauth/clients.js`
- Test: `tests/frontdoor-cimd.test.js`, `tests/frontdoor-clients.test.js`

**Interfaces:**
- Consumes: Task 1 `DCR_CLIENT_ID_RE`, `isClientId`; `writeFileAtomic`; `tests/helpers/test-certs.js`.
- Produces:
  - `class OAuthError extends Error` (`src/frontdoor/oauth/errors.js`): `new OAuthError(error, description, status = 400)` with `.error`, `.status`; `OAUTH_ERRORS` (§9's list).
  - `isPublicAddress(ip) → boolean` (not loopback, private, link-local, CGNAT, ULA, multicast, unspecified or broadcast; IPv4-mapped IPv6 judged by its IPv4) and `fetchClientMetadata(url, { lookup = dns.lookup, timeoutMs = 5000, maxBytes = 65536, ca = null, connectPort = 443 }) → Promise<{ client_id, client_name, redirect_uris }>` (`src/frontdoor/oauth/cimd.js`): `https:` URL on port 443 only, no redirects, JSON only, every resolved address public, the connection made to the resolved IP with the name as SNI/Host, `client_id` equal to the URL; failures are `OAuthError('invalid_client', …)`. `connectPort`/`ca` exist for tests only.
  - `validRedirectUri(uri) → boolean` (`https:` or loopback `http://127.0.0.1|[::1]|localhost[:port]`, never a fragment), `clientHost(client, redirectUri) → string`.
  - `class ClientRegistry({ file, now = Date.now, fetchMetadata = fetchClientMetadata, fetchOptions = {} })` with `register(body, { ip }) → client` (RFC 7591: `client_id = 'dcr_' + 22 b64url`; ≤ 10 per IP per hour and ≤ 100 clients without a grant, else `OAuthError('temporarily_unavailable', …, 429)`; anything outside §3.4's accepted metadata → `invalid_client_metadata`), `resolve(clientId) → Promise<client | null>` (CIMD cached 24 h), `redirectAllowed(client, uri) → boolean` (exact string match), `markGranted(clientId)`, `purge()` (DCR clients with no grant after 24 h), `get(clientId)`. Client shape: `{ client_id, client_name, redirect_uris, kind: 'dcr' | 'cimd', created_at, has_grant }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/frontdoor-cimd.test.js`:

```js
// tests/frontdoor-cimd.test.js — fleet stage 4 §3.4 (client ID metadata documents).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { fetchClientMetadata, isPublicAddress } = require('../src/frontdoor/oauth/cimd');
const { OAuthError } = require('../src/frontdoor/oauth/errors');
const { createCa, issueCert } = require('./helpers/test-certs');

const ca = createCa();
const leaf = issueCert(ca, { dnsNames: ['client.example.com'] });
const servers = [];
after(() => { for (const s of servers) s.close(); });

async function docServer(handler) {
  const server = https.createServer({ cert: leaf.cert, key: leaf.key }, handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return server.address().port;
}

// Resolves client.example.com to a public documentation address, but the test
// connects to 127.0.0.1 through connectPort + a lookup that reports public.
const publicLookup = (address) => (host, opts, cb) => cb(null, [{ address, family: 4 }]);
const URL_ = 'https://client.example.com/client.json';

describe('isPublicAddress', () => {
  it('refuses every non-public range', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['203.0.113.10', '198.51.100.7', '2001:db8::1', '::ffff:203.0.113.10']) assert.equal(isPublicAddress(ip), true, ip);
  });
});

describe('fetchClientMetadata', () => {
  const options = (port, extra = {}) => ({ lookup: publicLookup('203.0.113.10'), connectTo: '127.0.0.1', connectPort: port, ca: ca.cert, ...extra });

  it('fetches, checks client_id equals the URL, and returns the document', async () => {
    const port = await docServer((req, res) => {
      assert.equal(req.headers.host, 'client.example.com');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ client_id: URL_, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] }));
    });
    const doc = await fetchClientMetadata(URL_, options(port));
    assert.deepEqual(doc, { client_id: URL_, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] });
  });

  it('refuses a name that resolves to a private address', async () => {
    await assert.rejects(fetchClientMetadata(URL_, { lookup: publicLookup('10.0.0.5') }), (err) => err instanceof OAuthError && /not public/.test(err.message));
  });

  it('refuses a redirect, an oversize body, a client_id mismatch, non-JSON, and a slow server', async () => {
    const redirect = await docServer((req, res) => { res.writeHead(302, { location: 'https://evil.example.com/x.json' }); res.end(); });
    await assert.rejects(fetchClientMetadata(URL_, options(redirect)), /redirect/);
    const big = await docServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ client_id: URL_, pad: 'x'.repeat(70000) })); });
    await assert.rejects(fetchClientMetadata(URL_, options(big)), /64 KiB/);
    const other = await docServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ client_id: 'https://other.example.com/c.json', redirect_uris: [] })); });
    await assert.rejects(fetchClientMetadata(URL_, options(other)), /client_id/);
    const html = await docServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html></html>'); });
    await assert.rejects(fetchClientMetadata(URL_, options(html)), /JSON/);
    const slow = await docServer(() => {});
    await assert.rejects(fetchClientMetadata(URL_, options(slow, { timeoutMs: 100 })), /timed out/);
  });

  it('refuses http:, another port, userinfo and fragments before any network use', async () => {
    for (const bad of ['http://client.example.com/c.json', 'https://client.example.com:8443/c.json', 'https://u:p@client.example.com/c.json', 'https://client.example.com/c.json#x']) {
      await assert.rejects(fetchClientMetadata(bad, { lookup: () => { throw new Error('no lookup'); } }), OAuthError, bad);
    }
  });
});
```

Create `tests/frontdoor-clients.test.js`:

```js
// tests/frontdoor-clients.test.js — fleet stage 4 §3.4 (clients).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClientRegistry, validRedirectUri, clientHost } = require('../src/frontdoor/oauth/clients');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-clients-')); temps.push(d); return path.join(d, 'clients.json'); };
const good = (extra = {}) => ({ client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra });

describe('redirect URIs', () => {
  it('https or loopback http, never a fragment', () => {
    for (const ok of ['https://client.example.com/cb', 'http://127.0.0.1:33418/cb', 'http://[::1]:9/cb', 'http://localhost/cb']) assert.equal(validRedirectUri(ok), true, ok);
    for (const bad of ['http://client.example.com/cb', 'https://client.example.com/cb#frag', 'javascript:alert(1)', 'custom://cb', '']) assert.equal(validRedirectUri(bad), false, bad);
  });
});

describe('ClientRegistry', () => {
  it('registers a public client with a dcr_ id and persists it', () => {
    const f = file();
    const r = new ClientRegistry({ file: f, now: () => 0 });
    const c = r.register(good(), { ip: '203.0.113.9' });
    assert.match(c.client_id, /^dcr_[A-Za-z0-9_-]{22}$/);
    assert.equal(c.token_endpoint_auth_method, 'none');
    assert.equal(new ClientRegistry({ file: f }).get(c.client_id).client_name, 'Example Client');
  });

  it('refuses metadata outside what §3.4 accepts', () => {
    const r = new ClientRegistry({ file: file() });
    for (const bad of [
      good({ token_endpoint_auth_method: 'client_secret_basic' }), good({ grant_types: ['client_credentials'] }), good({ response_types: ['token'] }),
      good({ redirect_uris: [] }), good({ redirect_uris: ['http://client.example.com/cb'] }), good({ client_name: '' })
    ]) {
      assert.throws(() => r.register(bad, { ip: '203.0.113.9' }), (err) => err.error === 'invalid_client_metadata', JSON.stringify(bad));
    }
  });

  it('10 registrations per IP per hour; 100 clients without a grant; purged after 24 h', () => {
    let now = 0;
    const r = new ClientRegistry({ file: file(), now: () => now });
    for (let i = 0; i < 10; i += 1) r.register(good(), { ip: '203.0.113.9' });
    assert.throws(() => r.register(good(), { ip: '203.0.113.9' }), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
    now += 3600001;
    for (let i = 0; i < 90; i += 1) r.register(good(), { ip: `198.51.100.${i % 200}` });
    assert.throws(() => r.register(good(), { ip: '198.51.100.250' }), (err) => err.error === 'temporarily_unavailable');
    const kept = r.list()[0].client_id;
    r.markGranted(kept);
    now += 24 * 3600000 + 1;
    r.purge();
    assert.deepEqual(r.list().map((c) => c.client_id), [kept]);
  });

  it('resolves a CIMD client_id by fetching, and caches it for 24 h', async () => {
    let now = 0;
    let fetches = 0;
    const url = 'https://client.example.com/client.json';
    const r = new ClientRegistry({ file: file(), now: () => now, fetchMetadata: async (u) => { fetches += 1; return { client_id: u, client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'] }; } });
    const c = await r.resolve(url);
    assert.equal(c.kind, 'cimd');
    assert.equal(r.redirectAllowed(c, 'https://client.example.com/cb'), true);
    assert.equal(r.redirectAllowed(c, 'https://client.example.com/cb/'), false, 'exact string match');
    await r.resolve(url);
    assert.equal(fetches, 1);
    now += 24 * 3600000 + 1;
    await r.resolve(url);
    assert.equal(fetches, 2);
    assert.equal(await r.resolve('dcr_unknownunknownunknow'), null);
    assert.equal(clientHost(c, 'https://client.example.com/cb'), 'client.example.com');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/frontdoor-cimd.test.js tests/frontdoor-clients.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/oauth/cimd'`.

- [ ] **Step 3: Write `src/frontdoor/oauth/errors.js`**

```js
// OAuth 2.1 error codes the front door returns (fleet stage 4 §9).
const OAUTH_ERRORS = Object.freeze(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'access_denied', 'invalid_redirect_uri', 'invalid_client_metadata', 'temporarily_unavailable']);

class OAuthError extends Error {
  constructor(error, description = error, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }
}

module.exports = { OAuthError, OAUTH_ERRORS };
```

- [ ] **Step 4: Write `src/frontdoor/oauth/cimd.js`**

```js
// Client ID metadata documents (fleet stage 4 §3.4): the client_id is an
// https URL whose JSON describes the client. The front door fetches it the
// narrowest way it can — https on 443, no redirects, 5 s, 64 KiB, JSON, and
// only to a public address it resolved itself and then connects to — so a
// client_id cannot make it reach into a private network (SSRF).
const dns = require('dns');
const https = require('https');
const net = require('net');
const { OAuthError } = require('./errors');

const DEFAULTS = Object.freeze({ timeoutMs: 5000, maxBytes: 65536 });

function v4Parts(ip) {
  return ip.split('.').map(Number);
}

function isPublicV4([a, b, c, d]) {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return !(a === 255 && b === 255 && c === 255 && d === 255);
}

function isPublicAddress(ip) {
  const kind = net.isIP(String(ip));
  if (kind === 4) return isPublicV4(v4Parts(ip));
  if (kind !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicV4(v4Parts(mapped[1]));
  if (lower === '::' || lower === '::1') return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // ULA
  if ((first & 0xffc0) === 0xfe80) return false; // link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}

function refuse(message) {
  return new OAuthError('invalid_client', `client metadata: ${message}`);
}

function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw refuse('client_id is not a URL');
  }
  if (u.protocol !== 'https:') throw refuse('client_id must be an https URL');
  if (u.port && u.port !== '443') throw refuse('client_id must use port 443');
  if (u.username || u.password) throw refuse('client_id must not carry credentials');
  if (u.hash) throw refuse('client_id must not have a fragment');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw refuse('client_id must name a host, not an address');
  return u;
}

function resolvePublic(hostname, lookup) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(refuse(`cannot resolve ${hostname}: ${err.code || err.message}`));
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses }];
      if (list.length === 0) return reject(refuse(`${hostname} has no address`));
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (bad) return reject(refuse(`${hostname} resolves to ${bad.address}, which is not public`));
      return resolve(list[0].address);
    });
  });
}

async function fetchClientMetadata(url, { lookup = dns.lookup, timeoutMs = DEFAULTS.timeoutMs, maxBytes = DEFAULTS.maxBytes, ca = null, connectPort = 443, connectTo = null } = {}) {
  const u = checkUrl(url);
  const address = await resolvePublic(u.hostname, lookup);
  const body = await new Promise((resolve, reject) => {
    const req = https.request({
      host: connectTo || address,
      port: connectPort,
      servername: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { host: u.hostname, accept: 'application/json' },
      ...(ca ? { ca } : {}),
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(refuse('the metadata URL answered with a redirect; redirects are not followed'));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(refuse(`the metadata URL answered ${res.statusCode}`));
        return;
      }
      if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(String(res.headers['content-type'] || ''))) {
        res.resume();
        reject(refuse('the metadata is not JSON'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(refuse('the metadata is over 64 KiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(); reject(refuse(`fetching the metadata timed out after ${timeoutMs} ms`)); });
    req.on('error', (err) => reject(refuse(err.message)));
    req.end();
  });
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    throw refuse('the metadata is not JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== url) throw refuse('its client_id is not the URL it was fetched from');
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((r) => typeof r === 'string')) throw refuse('redirect_uris must be a list of URLs');
  const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 200) : u.hostname;
  return { client_id: doc.client_id, client_name: name, redirect_uris: doc.redirect_uris };
}

module.exports = { fetchClientMetadata, isPublicAddress, DEFAULTS };
```

- [ ] **Step 5: Write `src/frontdoor/oauth/clients.js`**

```js
// Registered OAuth clients (fleet stage 4 §3.4). Every client is public (no
// secret; PKCE binds the code). Dynamic registration (RFC 7591) is rate
// limited and pruned; client ID metadata documents are fetched and cached.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { DCR_CLIENT_ID_RE, isClientId } = require('../protocol/messages');
const { OAuthError } = require('./errors');
const { fetchClientMetadata } = require('./cimd');

const log = createLogger('frontdoor/oauth/clients');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const LIMITS = Object.freeze({ perIpPerHour: 10, withoutGrant: 100, purgeAfterMs: DAY, cimdCacheMs: DAY });
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function validRedirectUri(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > 2048 || uri.includes('#')) return false;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return Boolean(u.hostname);
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname); // RFC 8252 §7.3
}

// What the consent page and the phone call "client host": the CIMD URL's
// host, or the redirect's host for a dynamically registered client.
function clientHost(client, redirectUri) {
  try {
    return client.kind === 'cimd' ? new URL(client.client_id).host : new URL(redirectUri).host;
  } catch {
    return '';
  }
}

const invalid = (why) => new OAuthError('invalid_client_metadata', why);

class ClientRegistry {
  constructor({ file, now = Date.now, fetchMetadata = fetchClientMetadata, fetchOptions = {} } = {}) {
    this.file = file;
    this.now = now;
    this.fetchMetadata = fetchMetadata;
    this.fetchOptions = fetchOptions;
    this.clients = new Map();
    this.cimd = new Map();
    this.byIp = new Map();
    try {
      for (const c of JSON.parse(fs.readFileSync(file, 'utf8')).clients || []) {
        if (c && DCR_CLIENT_ID_RE.test(c.client_id)) this.clients.set(c.client_id, c);
      }
    } catch {
      // no clients yet
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, clients: [...this.clients.values()] }, null, 2)}\n`);
  }

  list() {
    return [...this.clients.values()];
  }

  get(clientId) {
    return this.clients.get(clientId) || this.cimd.get(clientId)?.client || null;
  }

  register(body, { ip = 'unknown' } = {}) {
    const t = this.now();
    const hits = (this.byIp.get(ip) || []).filter((at) => t - at < HOUR);
    if (hits.length >= LIMITS.perIpPerHour) throw new OAuthError('temporarily_unavailable', 'too many registrations from this address; try again later', 429);
    if (this.list().filter((c) => !c.has_grant).length >= LIMITS.withoutGrant) {
      throw new OAuthError('temporarily_unavailable', 'too many clients are waiting for approval; try again later', 429);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('the registration must be a JSON object');
    const name = body.client_name;
    if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 200) throw invalid('client_name must be 1–200 characters');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
      throw invalid('redirect_uris must list 1–10 https (or loopback http) URLs without fragments');
    }
    const grantTypes = body.grant_types === undefined ? ['authorization_code'] : body.grant_types;
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
      throw invalid('grant_types must be authorization_code and optionally refresh_token');
    }
    const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') throw invalid('response_types must be [code]');
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      throw invalid('token_endpoint_auth_method must be none: every client here is public');
    }
    const client = {
      client_id: `dcr_${crypto.randomBytes(16).toString('base64url')}`,
      client_name: name.trim(),
      redirect_uris: [...uris],
      grant_types: [...new Set(grantTypes)],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(t / 1000),
      kind: 'dcr',
      created_at: new Date(t).toISOString(),
      has_grant: false
    };
    hits.push(t);
    this.byIp.set(ip, hits);
    this.clients.set(client.client_id, client);
    this._save();
    log.info(`registered client ${client.client_id}`);
    return client;
  }

  async resolve(clientId) {
    if (!isClientId(clientId)) return null;
    if (DCR_CLIENT_ID_RE.test(clientId)) return this.clients.get(clientId) || null;
    const cached = this.cimd.get(clientId);
    if (cached && this.now() - cached.at < LIMITS.cimdCacheMs) return cached.client;
    const doc = await this.fetchMetadata(clientId, this.fetchOptions);
    const client = { client_id: doc.client_id, client_name: doc.client_name, redirect_uris: doc.redirect_uris.filter(validRedirectUri), kind: 'cimd', created_at: new Date(this.now()).toISOString(), has_grant: false };
    this.cimd.set(clientId, { client, at: this.now() });
    return client;
  }

  redirectAllowed(client, uri) {
    return Boolean(client) && validRedirectUri(uri) && client.redirect_uris.includes(uri);
  }

  markGranted(clientId) {
    const c = this.clients.get(clientId);
    if (c && !c.has_grant) {
      c.has_grant = true;
      this._save();
    }
  }

  purge() {
    const t = this.now();
    let removed = 0;
    for (const [id, c] of this.clients) {
      if (!c.has_grant && t - Date.parse(c.created_at) > LIMITS.purgeAfterMs) {
        this.clients.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }
}

module.exports = { ClientRegistry, validRedirectUri, clientHost, LIMITS };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-cimd.test.js tests/frontdoor-clients.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 7: Commit**

```bash
git add src/frontdoor/oauth/errors.js src/frontdoor/oauth/cimd.js src/frontdoor/oauth/clients.js tests/frontdoor-cimd.test.js tests/frontdoor-clients.test.js
git commit -m "feat(frontdoor): OAuth clients — dynamic registration and SSRF-safe metadata documents" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 22: Pending authorizations, the consent and wait pages, and the OAuth server's front half

**Files:**
- Create: `src/frontdoor/http-util.js`
- Create: `src/frontdoor/oauth/pending.js`
- Create: `src/frontdoor/oauth/pages.js`
- Create: `src/frontdoor/oauth/server.js`
- Create: `tests/helpers/oauth-test-client.js`
- Test: `tests/frontdoor-authorize.test.js`

**Interfaces:**
- Consumes: Task 1 (`randomUserCode`, `formatUserCode`, `CODE_CHALLENGE_RE`), Task 4 (`ScopeRegistry`), Task 21 (`ClientRegistry`, `clientHost`, `OAuthError`).
- Produces:
  - `src/frontdoor/http-util.js`: `readBody(req, maxBytes) → Promise<Buffer>` (rejects `{ status: 413, error: 'body_too_large' }`), `sendJson(res, status, body, headers)`, `sendHtml(res, status, html, headers)`, `parseForm(buf) → object`, `parseCookies(header) → object`, `printable(text)` (drops C0/C1 and bidi controls), `escapeHtml(text)` (`printable`, then `& < > " '`), `requestHost(req) → lower-case host without port`, `clientIp(req)`.
  - `class PendingAuthorizations({ now = Date.now, ttlMs = 600000, perIp = 3, perIpWindowMs = 600000, max = 50 })` with `create({ client, redirectUri, codeChallenge, resource, requestedScopes, preselected, state, ip, clientHost }) → { pending, cookie }` (throws `OAuthError('temporarily_unavailable', …, 429)`), `get(grantId)`, `byUserCode(code)`, `claim(grantId, deviceId) → pending | null` (null when another device claimed it), `checkCookie(grantId, cookie) → boolean`, `settle(grantId, { status: 'approved' | 'denied', code? })`, `remove(grantId)`, `sweep()`. A pending item: `{ grant_id, client_id, client_name, client_host, redirect_uri, resource, code_challenge, user_code, requested_scopes, preselected, state, created_at_ms, expires_at_ms, claimed_by, nonces: Set, status, code, ip }`.
  - `src/frontdoor/oauth/pages.js`: `CONSENT_HEADERS`, `CONSENT_CSS`, `consentPage({ pending, scopeRegistry, waitUrl })`, `messagePage({ title, message, status })`.
  - `class OAuthServer({ domain, clients, pending, scopeRegistry, scopesEnabled, clientDefaults = [], now = Date.now })` with `mcpHost`, `issuer` (`https://mcp.<domain>`), `resourceUrl` (`https://mcp.<domain>/mcp`), `supportedScopes()`, `handle(req, res) → Promise<boolean>` (false when the path is not an OAuth path), serving: `GET /.well-known/oauth-protected-resource` and `…/mcp` (RFC 9728), `GET /.well-known/oauth-authorization-server` (RFC 8414), `POST /oauth/register`, `GET /oauth/authorize`, `GET /oauth/authorize/wait?id=`, `GET /oauth/consent.css`. `Host` other than `mcp.<domain>` → `421`; bodies over 64 KiB → `413`. `this.routes` (`'<METHOD> <path>' → handler`) is where Task 24 adds the token routes.
  - `tests/helpers/oauth-test-client.js`: `request(base, { method, path, host, headers, json, form, raw, tls })` (`tls` = `{ ca, lookup }` for an `https:` base), `pkce()`, `parseConsent(html) → { userCode, grantId }`, `cookieOf(res) → 'kl_authz=…'`.

- [ ] **Step 1: Write the test client helper**

Create `tests/helpers/oauth-test-client.js`:

```js
// tests/helpers/oauth-test-client.js
//
// A small OAuth client for the front-door tests: HTTP (or HTTPS, with a
// test CA and a lookup that resolves the front door's names to 127.0.0.1)
// with an explicit Host header (fetch cannot set one), PKCE, and the
// consent page's code.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function request(base, { method = 'GET', path, host = 'mcp.kl.example.com', headers = {}, json = undefined, form = undefined, raw = undefined, tls = null } = {}) {
  let body = null;
  const h = { host, ...headers };
  if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
  if (form !== undefined) { body = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (raw !== undefined) body = Buffer.from(raw);
  if (body) h['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const secure = base.startsWith('https:');
    const req = (secure ? https : http).request(`${base}${path}`, { method, headers: h, ...(secure ? { agent: false, ...(tls || {}) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function parseConsent(html) {
  const code = /id="user-code">([0-9A-Z]{3}-[0-9A-Z]{3})</.exec(html);
  const grant = /authorize\/wait\?id=(gr_[A-Za-z0-9_-]{22})/.exec(html);
  return { userCode: code ? code[1] : null, grantId: grant ? grant[1] : null };
}

function cookieOf(res) {
  const set = [].concat(res.headers['set-cookie'] || []);
  const c = set.find((s) => s.startsWith('kl_authz='));
  return c ? c.split(';')[0] : null;
}

module.exports = { request, pkce, parseConsent, cookieOf };
```

- [ ] **Step 2: Write the failing test**

Create `tests/frontdoor-authorize.test.js`:

```js
// tests/frontdoor-authorize.test.js — fleet stage 4 §3.4 (metadata, registration, authorize, consent).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { OAuthServer } = require('../src/frontdoor/oauth/server');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { ClientRegistry } = require('../src/frontdoor/oauth/clients');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { request, pkce, parseConsent, cookieOf } = require('./helpers/oauth-test-client');

const temps = [];
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

async function start({ now = Date.now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-authz-'));
  temps.push(dir);
  const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), now });
  const pending = new PendingAuthorizations({ now });
  const oauth = new OAuthServer({
    domain: 'kl.example.com', clients, pending, scopeRegistry: createFleetScopeRegistry(),
    scopesEnabled: ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate'],
    clientDefaults: [{ host: 'client.example.com', scopes: ['fleet:read', 'fleet:run'] }], now
  });
  const server = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, oauth, clients, pending };
}

async function registered(base, extra = {}) {
  const res = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: 'Example Client', redirect_uris: ['https://client.example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra } });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const authorizePath = (params) => `/oauth/authorize?${new URLSearchParams(params).toString()}`;

describe('metadata', () => {
  it('serves RFC 9728 and RFC 8414 documents', async () => {
    const { base } = await start();
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await request(base, { path: p });
      assert.deepEqual(r.json, { resource: 'https://mcp.kl.example.com/mcp', authorization_servers: ['https://mcp.kl.example.com'], scopes_supported: ['fleet:delegate', 'fleet:read', 'fleet:run', 'fleet:unsafe'], bearer_methods_supported: ['header'] });
    }
    const as = (await request(base, { path: '/.well-known/oauth-authorization-server' })).json;
    assert.equal(as.issuer, 'https://mcp.kl.example.com');
    assert.equal(as.token_endpoint, 'https://mcp.kl.example.com/oauth/token');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.equal(as.client_id_metadata_document_supported, true);
  });

  it('answers 421 when Host is not the mcp. name', async () => {
    const { base } = await start();
    assert.equal((await request(base, { path: '/.well-known/oauth-authorization-server', host: 'mesh.kl.example.com' })).status, 421);
  });
});

describe('authorize and the consent page', () => {
  it('creates a pending authorization, sets the cookie, and shows the code with strict headers', async () => {
    const { base } = await start();
    const client = await registered(base);
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; style-src 'self'; frame-ancestors 'none'");
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const setCookie = [].concat(res.headers['set-cookie'])[0];
    assert.match(setCookie, /^kl_authz=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/oauth$/);
    const { userCode, grantId } = parseConsent(res.text);
    assert.match(userCode, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    assert.ok(grantId);
    assert.ok(res.text.includes('(self-declared)'));
    assert.ok(res.text.includes('Open King Louie on your phone'));
    assert.ok(res.text.includes('<meta http-equiv="refresh" content="3;url=/oauth/authorize/wait?id='));
    assert.ok(!/<script/i.test(res.text));
  });

  it('consent page escapes a hostile client_name (Review Focus 1)', async () => {
    const { base } = await start();
    const client = await registered(base, { client_name: '<img src=x onerror=alert(1)>‮evil "quoted"' });
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<img src=x'));
    assert.ok(res.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!res.text.includes('‮'));
    assert.ok(res.text.includes('&quot;quoted&quot;'));
  });

  it('refuses a redirect mismatch with a page and never redirects; refuses plain, a missing challenge, a foreign resource', async () => {
    const { base } = await start();
    const client = await registered(base);
    const { challenge } = pkce();
    const base_ = { response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' };
    const mismatch = await request(base, { path: authorizePath({ ...base_, redirect_uri: 'https://evil.example.com/cb' }) });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.headers.location, undefined);
    assert.match(mismatch.text, /redirect/);
    for (const params of [{ ...base_, code_challenge_method: 'plain' }, { ...base_, code_challenge: undefined }, { ...base_, resource: 'https://other.example.com/mcp' }, { ...base_, scope: 'fleet:read admin:all' }]) {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
      const r = await request(base, { path: authorizePath(clean) });
      assert.equal(r.status, 400, JSON.stringify(clean));
      assert.equal(r.headers.location, undefined);
    }
    const ok = await request(base, { path: authorizePath(base_) });
    assert.equal(ok.status, 200, 'state is optional');
  });

  it('the wait page needs the cookie; an unknown or expired request says to start again, without refresh (Review Focus 3)', async () => {
    let now = 0;
    const { base } = await start({ now: () => now });
    const client = await registered(base);
    const { challenge } = pkce();
    const res = await request(base, { path: authorizePath({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }) });
    const { grantId } = parseConsent(res.text);
    const noCookie = await request(base, { path: `/oauth/authorize/wait?id=${grantId}` });
    assert.equal(noCookie.status, 403);
    const waiting = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(waiting.status, 200);
    assert.ok(waiting.text.includes('http-equiv="refresh"'));
    now += 600001;
    const expired = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(res) } });
    assert.equal(expired.status, 410);
    assert.ok(!expired.text.includes('http-equiv="refresh"'));
    assert.match(expired.text, /start again/i);
  });
});

describe('PendingAuthorizations caps (R23)', () => {
  const client = { client_id: 'dcr_x', client_name: 'Example Client', kind: 'dcr', redirect_uris: ['https://client.example.com/cb'] };
  const make = (p, { ip = '203.0.113.1', host = 'client.example.com' } = {}) => p.create({ client, redirectUri: 'https://client.example.com/cb', codeChallenge: 'c'.repeat(43), resource: 'https://mcp.kl.example.com/mcp', requestedScopes: ['fleet:read'], preselected: ['fleet:read'], state: null, ip, clientHost: host });

  it('3 new per IP per 10 minutes', () => {
    let now = 0;
    const p = new PendingAuthorizations({ now: () => now });
    for (let i = 0; i < 3; i += 1) make(p, { host: `h${i}.example.com` });
    assert.throws(() => make(p, { host: 'h3.example.com' }), (err) => err.error === 'temporarily_unavailable' && err.status === 429);
    now += 600001;
    make(p, { host: 'h4.example.com' });
  });

  it('1 per client host: a newer one replaces an older unclaimed one, never a claimed one', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const first = make(p).pending;
    const second = make(p, { ip: '203.0.113.2' }).pending;
    assert.equal(p.get(first.grant_id), null);
    p.claim(second.grant_id, 'd-3vmwrihhdbnit4oi');
    const third = make(p, { ip: '203.0.113.3' }).pending;
    assert.ok(p.get(second.grant_id), 'a claimed request is never replaced');
    assert.ok(p.get(third.grant_id));
  });

  it('50 overall: the oldest unclaimed goes first; claimed ones survive a flood of 60', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const claimed = make(p, { host: 'owner.example.com' }).pending;
    p.claim(claimed.grant_id, 'd-3vmwrihhdbnit4oi');
    for (let i = 0; i < 60; i += 1) make(p, { ip: `198.51.100.${i}`, host: `flood${i}.example.com` });
    assert.ok(p.get(claimed.grant_id));
    assert.equal(p.size(), 50);
  });

  it('claim belongs to the first device; user codes are unique among live requests', () => {
    const p = new PendingAuthorizations({ now: () => 0 });
    const a = make(p).pending;
    assert.ok(p.claim(a.grant_id, 'd-3vmwrihhdbnit4oi'));
    assert.ok(p.claim(a.grant_id, 'd-3vmwrihhdbnit4oi'), 'the same device again is fine');
    assert.equal(p.claim(a.grant_id, 'd-6xdlbxglhnvfa3lw'), null);
    assert.equal(p.byUserCode(a.user_code).grant_id, a.grant_id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/frontdoor-authorize.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/oauth/server'`.

- [ ] **Step 4: Write `src/frontdoor/http-util.js`**

```js
// Small HTTP helpers for the front door's own endpoints (OAuth, MCP, pairing).
const BIDI_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error(`bodies are limited to ${maxBytes} bytes`), { status: 413, error: 'body_too_large' }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(Object.assign(new Error(`bodies are limited to ${maxBytes} bytes`), { status: 413, error: 'body_too_large' }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!failed) { failed = true; reject(err); } });
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function sendHtml(res, status, html, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), ...headers });
  res.end(html);
}

function parseForm(buf) {
  return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Self-declared text (a client name) made safe to show: no controls or bidi
// overrides that could make it read differently.
function printable(text) {
  return String(text === undefined || text === null ? '' : text).replace(BIDI_AND_CONTROLS, '');
}

function escapeHtml(text) {
  return printable(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function requestHost(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { readBody, sendJson, sendHtml, parseForm, parseCookies, printable, escapeHtml, requestHost, clientIp };
```

- [ ] **Step 5: Write `src/frontdoor/oauth/pending.js`**

```js
// Pending authorizations (fleet stage 4 §3.4, R23): memory only, 10 minutes
// on the front door's clock, capped per IP, per client host and overall. A
// request the owner's phone has claimed (looked it up by its typed code) is
// never evicted or replaced; only that device can decide it.
const crypto = require('crypto');
const { randomUserCode } = require('../protocol/messages');
const { OAuthError } = require('./errors');

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');

class PendingAuthorizations {
  constructor({ now = Date.now, ttlMs = 600000, perIp = 3, perIpWindowMs = 600000, max = 50 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.perIp = perIp;
    this.perIpWindowMs = perIpWindowMs;
    this.max = max;
    this.items = new Map();
    this.ipHits = new Map();
  }

  sweep() {
    const t = this.now();
    for (const [id, p] of this.items) if (t > p.expires_at_ms) this.items.delete(id);
    for (const [ip, hits] of this.ipHits) {
      const fresh = hits.filter((at) => t - at < this.perIpWindowMs);
      if (fresh.length) this.ipHits.set(ip, fresh);
      else this.ipHits.delete(ip);
    }
  }

  size() {
    this.sweep();
    return this.items.size;
  }

  create({ client, redirectUri, codeChallenge, resource, requestedScopes, preselected, state = null, ip = 'unknown', clientHost }) {
    this.sweep();
    const t = this.now();
    const hits = this.ipHits.get(ip) || [];
    if (hits.length >= this.perIp) throw new OAuthError('temporarily_unavailable', 'too many connection requests from this address; try again in a few minutes', 429);
    for (const [id, p] of this.items) {
      if (p.client_host === clientHost && !p.claimed_by) this.items.delete(id);
    }
    if (this.items.size >= this.max) {
      const oldest = [...this.items.values()].filter((p) => !p.claimed_by).sort((a, b) => a.created_at_ms - b.created_at_ms)[0];
      if (!oldest) throw new OAuthError('temporarily_unavailable', 'the front door is busy; try again in a few minutes', 429);
      this.items.delete(oldest.grant_id);
    }
    let userCode;
    do {
      userCode = randomUserCode();
    } while ([...this.items.values()].some((p) => p.user_code === userCode));
    const cookie = crypto.randomBytes(32).toString('base64url');
    const pending = {
      grant_id: `gr_${crypto.randomBytes(16).toString('base64url')}`,
      client_id: client.client_id,
      client_name: client.client_name,
      client_kind: client.kind,
      client_host: clientHost,
      redirect_uri: redirectUri,
      resource,
      code_challenge: codeChallenge,
      user_code: userCode,
      requested_scopes: [...requestedScopes],
      preselected: [...preselected],
      state,
      created_at_ms: t,
      expires_at_ms: t + this.ttlMs,
      claimed_by: null,
      cookie_hash: sha(cookie),
      nonces: new Set(),
      status: 'pending',
      code: null,
      ip
    };
    hits.push(t);
    this.ipHits.set(ip, hits);
    this.items.set(pending.grant_id, pending);
    return { pending, cookie };
  }

  get(grantId) {
    const p = this.items.get(grantId);
    if (!p || this.now() > p.expires_at_ms) return null;
    return p;
  }

  byUserCode(code) {
    for (const p of this.items.values()) if (p.user_code === code && this.now() <= p.expires_at_ms && p.status === 'pending') return p;
    return null;
  }

  claim(grantId, deviceId) {
    const p = this.get(grantId);
    if (!p || p.status !== 'pending') return null;
    if (p.claimed_by && p.claimed_by !== deviceId) return null;
    p.claimed_by = deviceId;
    return p;
  }

  checkCookie(grantId, cookie) {
    const p = this.items.get(grantId);
    if (!p || typeof cookie !== 'string' || !cookie) return false;
    const a = Buffer.from(p.cookie_hash);
    const b = Buffer.from(sha(cookie));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  settle(grantId, { status, code = null }) {
    const p = this.items.get(grantId);
    if (!p) return null;
    p.status = status;
    p.code = code;
    return p;
  }

  remove(grantId) {
    this.items.delete(grantId);
  }
}

module.exports = { PendingAuthorizations };
```

- [ ] **Step 6: Write `src/frontdoor/oauth/pages.js`**

```js
// The consent and message pages (fleet stage 4 §3.4): no script, no remote
// resources, one same-origin stylesheet; everything the client declared is
// escaped and marked as self-declared.
const { escapeHtml } = require('../http-util');
const { formatUserCode } = require('../protocol/messages');

const CONSENT_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
});

const CONSENT_CSS = `body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fafafa}
h1{font-size:1.3rem}.code{font:700 2.4rem ui-monospace,monospace;letter-spacing:.2rem;padding:.6rem 1rem;background:#fff;border:2px solid #333;display:inline-block}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem}dt{font-weight:600}.muted{color:#555}ul{padding-left:1.2rem}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}.code{background:#222;border-color:#ccc}.muted{color:#aaa}}
`;

function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}

function page({ title, body, refresh = null }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `${refresh ? `<meta http-equiv="refresh" content="3;url=${escapeHtml(refresh)}">` : ''}`
    + `<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/oauth/consent.css"></head><body>${body}</body></html>`;
}

function consentPage({ pending, scopeRegistry, waitUrl }) {
  const scopes = pending.requested_scopes.map((s) => {
    const def = scopeRegistry.get(s);
    return `<li><code>${escapeHtml(s)}</code>${def && def.description ? ` — ${escapeHtml(def.description)}` : ''}</li>`;
  }).join('');
  return page({
    title: 'Connect a client to King Louie',
    refresh: waitUrl,
    body: `<h1>Connect a client to King Louie</h1>`
      + `<dl><dt>Client</dt><dd>${escapeHtml(pending.client_name)} <span class="muted">(self-declared)</span></dd>`
      + `<dt>Client host</dt><dd>${escapeHtml(pending.client_host)}</dd>`
      + `<dt>Returns to</dt><dd>${escapeHtml(hostOf(pending.redirect_uri))}</dd></dl>`
      + `<p>It asks for:</p><ul>${scopes}</ul>`
      + `<p>Open King Louie on your phone → Connect a client → type this code:</p>`
      + `<p class="code" id="user-code">${escapeHtml(formatUserCode(pending.user_code))}</p>`
      + `<p class="muted">There is no password. This page moves on by itself once your phone decides.</p>`
  });
}

function messagePage({ title, message }) {
  return page({ title, body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` });
}

module.exports = { CONSENT_HEADERS, CONSENT_CSS, consentPage, messagePage };
```

- [ ] **Step 7: Write `src/frontdoor/oauth/server.js`**

```js
// The OAuth 2.1 authorization server on mcp.<domain> (fleet stage 4 §3.4):
// metadata (RFC 9728, RFC 8414), dynamic registration (RFC 7591), and the
// authorize → consent → wait flow in which the owner types the browser's
// code on the phone (R23). Tokens and the phone routes are added in Tasks
// 23–24 through `this.routes` and registerPhoneRoutes.
const { createLogger } = require('../../logging');
const { CODE_CHALLENGE_RE } = require('../protocol/messages');
const { OAuthError } = require('./errors');
const { clientHost } = require('./clients');
const { CONSENT_HEADERS, CONSENT_CSS, consentPage, messagePage } = require('./pages');
const { readBody, sendJson, sendHtml, parseCookies, requestHost, clientIp } = require('../http-util');

const log = createLogger('frontdoor/oauth');
const BODY_LIMIT = 65536;
const STATE_MAX = 512;

class OAuthServer {
  constructor({ domain, clients, pending, scopeRegistry, scopesEnabled, clientDefaults = [], now = Date.now } = {}) {
    this.mcpHost = `mcp.${domain}`;
    this.issuer = `https://${this.mcpHost}`;
    this.resourceUrl = `${this.issuer}/mcp`;
    this.clients = clients;
    this.pending = pending;
    this.scopeRegistry = scopeRegistry;
    this.scopesEnabled = scopesEnabled;
    this.clientDefaults = clientDefaults;
    this.now = now;
    this.routes = new Map([
      ['GET /.well-known/oauth-protected-resource', (req, res) => this.protectedResource(req, res)],
      ['GET /.well-known/oauth-protected-resource/mcp', (req, res) => this.protectedResource(req, res)],
      ['GET /.well-known/oauth-authorization-server', (req, res) => this.authorizationServer(req, res)],
      ['POST /oauth/register', (req, res) => this.register(req, res)],
      ['GET /oauth/authorize', (req, res, url) => this.authorize(req, res, url)],
      ['GET /oauth/authorize/wait', (req, res, url) => this.wait(req, res, url)],
      ['GET /oauth/consent.css', (req, res) => { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=3600' }); res.end(CONSENT_CSS); }]
    ]);
  }

  supportedScopes() {
    return this.scopeRegistry.supported(this.scopesEnabled);
  }

  isOAuthPath(pathname) {
    return pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/oauth-');
  }

  async handle(req, res) {
    const url = new URL(req.url, `https://${this.mcpHost}`);
    if (!this.isOAuthPath(url.pathname)) return false;
    if (requestHost(req) !== this.mcpHost) {
      sendJson(res, 421, { error: 'misdirected_request', error_description: `this front door answers only as ${this.mcpHost}` });
      return true;
    }
    const route = this.routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof OAuthError) sendJson(res, err.status, { error: err.error, error_description: err.message });
      else if (err && err.status === 413) sendJson(res, 413, { error: 'invalid_request', error_description: err.message }, { connection: 'close' });
      else {
        log.error(`${req.method} ${url.pathname} failed: ${err && err.message}`);
        sendJson(res, 500, { error: 'server_error' });
      }
    }
    return true;
  }

  protectedResource(req, res) {
    sendJson(res, 200, { resource: this.resourceUrl, authorization_servers: [this.issuer], scopes_supported: this.supportedScopes(), bearer_methods_supported: ['header'] });
  }

  authorizationServer(req, res) {
    sendJson(res, 200, {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: this.supportedScopes(),
      client_id_metadata_document_supported: true
    });
  }

  async register(req, res) {
    const raw = await readBody(req, BODY_LIMIT);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new OAuthError('invalid_client_metadata', 'the registration must be JSON');
    }
    const c = this.clients.register(body, { ip: clientIp(req) });
    sendJson(res, 201, {
      client_id: c.client_id, client_id_issued_at: c.client_id_issued_at, client_name: c.client_name, redirect_uris: c.redirect_uris,
      grant_types: c.grant_types, response_types: c.response_types, token_endpoint_auth_method: 'none'
    });
  }

  refuse(res, status, title, message) {
    sendHtml(res, status, messagePage({ title, message }), CONSENT_HEADERS);
  }

  preselect(host, requested) {
    const match = this.clientDefaults.find((d) => d.host === host);
    const wanted = match ? match.scopes : ['fleet:read'];
    return requested.filter((s) => wanted.includes(s));
  }

  async authorize(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    let client = null;
    try {
      client = await this.clients.resolve(q.client_id);
    } catch (err) {
      return this.refuse(res, 400, 'Unknown client', err.message);
    }
    if (!client) return this.refuse(res, 400, 'Unknown client', 'This client is not registered with this King Louie front door.');
    // Checked before anything else can redirect: a mismatch never redirects.
    if (!this.clients.redirectAllowed(client, q.redirect_uri)) {
      return this.refuse(res, 400, 'Redirect not allowed', 'The redirect address is not one this client registered. Nothing was sent back to it.');
    }
    if (q.response_type !== 'code') return this.refuse(res, 400, 'Invalid request', 'response_type must be code.');
    if (typeof q.code_challenge !== 'string' || !CODE_CHALLENGE_RE.test(q.code_challenge)) return this.refuse(res, 400, 'Invalid request', 'code_challenge is required (43–128 characters).');
    if (q.code_challenge_method !== 'S256') return this.refuse(res, 400, 'Invalid request', 'code_challenge_method must be S256; plain is refused.');
    const resource = q.resource === undefined ? this.resourceUrl : q.resource;
    if (resource !== this.resourceUrl) return this.refuse(res, 400, 'Invalid request', `resource must be ${this.resourceUrl}.`);
    if (q.state !== undefined && String(q.state).length > STATE_MAX) return this.refuse(res, 400, 'Invalid request', 'state is too long.');
    const supported = this.supportedScopes();
    const requested = q.scope === undefined || !q.scope.trim() ? supported : [...new Set(q.scope.trim().split(/\s+/))].sort();
    const unknown = requested.filter((s) => !supported.includes(s));
    if (unknown.length) return this.refuse(res, 400, 'Invalid scope', `This front door does not grant ${unknown.join(', ')}.`);
    const host = clientHost(client, q.redirect_uri);
    let created;
    try {
      created = this.pending.create({
        client, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, resource, requestedScopes: requested,
        preselected: this.preselect(host, requested), state: q.state === undefined ? null : String(q.state), ip: clientIp(req), clientHost: host
      });
    } catch (err) {
      if (err instanceof OAuthError) return this.refuse(res, err.status, 'Try again later', err.message);
      throw err;
    }
    const { pending, cookie } = created;
    sendHtml(res, 200, consentPage({ pending, scopeRegistry: this.scopeRegistry, waitUrl: `/oauth/authorize/wait?id=${pending.grant_id}` }), {
      ...CONSENT_HEADERS,
      'set-cookie': `kl_authz=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/oauth`
    });
    return undefined;
  }

  wait(req, res, url) {
    const id = url.searchParams.get('id') || '';
    const pending = this.pending.get(id);
    if (!pending) {
      return this.refuse(res, 410, 'This request has ended', 'It expired or was already used. Start again from your client.');
    }
    if (!this.pending.checkCookie(id, parseCookies(req.headers.cookie).kl_authz)) {
      return this.refuse(res, 403, 'Not this browser', 'Only the browser that started this request can finish it. Start again from your client.');
    }
    if (pending.status === 'pending') {
      sendHtml(res, 200, consentPage({ pending, scopeRegistry: this.scopeRegistry, waitUrl: `/oauth/authorize/wait?id=${id}` }), CONSENT_HEADERS);
      return undefined;
    }
    const target = new URL(pending.redirect_uri);
    if (pending.status === 'approved') target.searchParams.set('code', pending.code);
    else target.searchParams.set('error', 'access_denied');
    if (pending.state !== null) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.issuer);
    this.pending.remove(id);
    res.writeHead(302, { location: target.toString(), ...CONSENT_HEADERS });
    res.end();
    return undefined;
  }
}

module.exports = { OAuthServer, BODY_LIMIT };
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test tests/frontdoor-authorize.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 9: Commit**

```bash
git add src/frontdoor/http-util.js src/frontdoor/oauth/pending.js src/frontdoor/oauth/pages.js src/frontdoor/oauth/server.js tests/helpers/oauth-test-client.js tests/frontdoor-authorize.test.js
git commit -m "feat(frontdoor): OAuth metadata, registration, authorize and the typed-code consent page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 23: Grants, authorization codes and the phone's grant routes

**Files:**
- Create: `src/frontdoor/oauth/grants.js`
- Create: `src/frontdoor/oauth/grant-routes.js`
- Test: `tests/frontdoor-grants.test.js`

**Interfaces:**
- Consumes: Task 2 (`checkGrantDecision`, `checkClientRevoke`, `verifyPhoneEnvelope`, `Challenges`), Task 1 (`normalizeUserCode`, `GRANT_ID_RE`), Task 4 (`formatScope`), Task 20 (`recordFrontDoorEvent`), Task 22 (`PendingAuthorizations`); F3 `createPhoneApi`/`ApiError`/`DeviceRegistry`, `ApproverStore`.
- Produces:
  - `class GrantStore({ file, approverStore, frontdoorId, alerts = null, now = Date.now })` (extends `EventEmitter`, event `'revoked'` with the grant id) with `load()` (re-verifies every `signed_grant` against the admin-owned approvers with R25's `accepted_at` rule and the record's own fields; a failure drops the grant and raises `node_record_invalid` with `subject: 'grant:<id>'`), `create({ pending, envelope, message, acceptedAt })`, `get(id)`, `live(id) → grant | null`, `list({ liveOnly = true })`, `revoke(id, reason) → boolean`, `touch(id)`, `scopeStrings(grant) → string[]`. Grant record (§4.1): `{ grant_id, client_id, client_name, client_host, redirect_uri, resource, scopes: [{ scope, machines }], device_id, accepted_at, signed_grant, revoked_at, revoked_reason, last_used_at }`; file `<dataDir>/frontdoor/oauth/grants.json`.
  - `class AuthCodes({ now = Date.now, ttlMs = 60000 })` with `issue({ grantId, clientId, redirectUri, codeChallenge, resource }) → code` (32 random bytes b64url; only its SHA-256 is kept) and `take(code) → { ok: true, record } | { ok: false, reused: grantId } | { ok: false, expired: true } | { ok: false }` (a second use reports `reused`).
  - `registerGrantRoutes(phoneApi, { pending, grants, codes, clients, challenges, approverStore, frontdoorId, scopeRules: () => rules, auditLedger = null, onGrantRevoked = () => {}, now = Date.now })` registering, all device-authenticated and all refused `403 forbidden` for a device that is not an active approver in the front door's `ApproverStore` (Deviation 13): `GET /v1/grants/pending?user_code=` (10/min per device; claims the request for the calling device; `404 no_such_request` for no match or a request another device claimed; the reply adds `client_id` to §4.9's fields, Deviation 26), `POST /v1/grants/{id}/decision` (`kl.client.grant` → `{ state: 'approved' | 'denied' }`; a refusal is `400 <reason>`, or `410` for `unknown_request`/`expired`), `GET /v1/clients`, `POST /v1/challenges`, `POST /v1/clients/{grant_id}/revoke` (`kl.client.revoke` → `204`; calls `onGrantRevoked(grantId)`).

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-grants.test.js`:

```js
// tests/frontdoor-grants.test.js — fleet stage 4 §3.4 (the phone's decision, grants, codes, revocation).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPhoneApi } = require('../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { GrantStore, AuthCodes } = require('../src/frontdoor/oauth/grants');
const { registerGrantRoutes } = require('../src/frontdoor/oauth/grant-routes');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { FLEET_SCOPE_RULES } = require('../src/frontdoor/protocol/checks');
const { formatUserCode } = require('../src/frontdoor/protocol/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const FD = testNodeIdentity({ key: 'relay' });
const A = createFakePhone({ seed: 'A' });
const C = createFakePhone({ seed: 'C' });
const stranger = createFakePhone();

async function setup() {
  const store = await approverStoreWith([A.approverRecord(), C.approverRecord()], { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const dataDir = path.join(store.baseDir, 'data');
  const devices = new DeviceRegistry({ file: path.join(dataDir, 'relay', 'devices.json') });
  for (const p of [A, C, stranger]) devices.register({ device_id: p.deviceId, jwk: p.jwk, name: p.name, platform: 'android' });
  const phoneApi = createPhoneApi({ devices });
  const pending = new PendingAuthorizations();
  const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
  const grants = new GrantStore({ file: path.join(dataDir, 'frontdoor', 'oauth', 'grants.json'), approverStore: store, frontdoorId: FD.nodeId, alerts });
  const codes = new AuthCodes();
  const granted = [];
  const revoked = [];
  const audit = [];
  registerGrantRoutes(phoneApi, {
    pending, grants, codes, clients: { markGranted: (id) => granted.push(id) }, challenges: new Challenges(), approverStore: store, frontdoorId: FD.nodeId,
    scopeRules: () => FLEET_SCOPE_RULES, auditLedger: { append: async (e) => { audit.push(e); return e; } }, onGrantRevoked: (id) => revoked.push(id)
  });
  const server = http.createServer(phoneApi.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (phone, method, p, body = null) => {
    const text = body === null ? '' : JSON.stringify(body);
    const res = await fetch(`${base}${p}`, { method, body: body === null ? undefined : text, headers: { 'content-type': 'application/json', ...phone.signApi(method, p, text) } });
    const raw = await res.text();
    return { status: res.status, body: raw ? JSON.parse(raw) : null };
  };
  const newPending = () => pending.create({
    client: { client_id: 'dcr_AAAAAAAAAAAAAAAAAAAAAA', client_name: 'Example Client', kind: 'dcr' }, redirectUri: 'https://client.example.com/cb',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', resource: 'https://mcp.kl.example.com/mcp',
    requestedScopes: ['fleet:read', 'fleet:run'], preselected: ['fleet:read'], state: null, ip: '203.0.113.1', clientHost: 'client.example.com'
  }).pending;
  return { store, pending, grants, codes, call, newPending, granted, revoked, audit, alerts, dataDir };
}

describe('the phone claims by the typed code, then decides', () => {
  it('approve: a grant, a code for the wait page, and the audit entry', async () => {
    const t = await setup();
    const p = t.newPending();
    const lookup = await t.call(A, 'GET', `/v1/grants/pending?user_code=${encodeURIComponent(formatUserCode(p.user_code).toLowerCase())}`);
    assert.equal(lookup.status, 200);
    assert.deepEqual(Object.keys(lookup.body).sort(), ['client_host', 'client_id', 'client_name', 'code_challenge', 'expires_in_ms', 'grant_id', 'preselected', 'redirect_uri', 'requested_scopes', 'resource']);
    assert.equal(p.claimed_by, A.deviceId);
    const decision = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:read', machines: null }] }));
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    assert.deepEqual(decision.body, { state: 'approved' });
    assert.equal(p.status, 'approved');
    assert.match(p.code, /^[A-Za-z0-9_-]{43}$/);
    const grant = t.grants.live(p.grant_id);
    assert.deepEqual(t.grants.scopeStrings(grant), ['fleet:read']);
    assert.deepEqual(t.granted, ['dcr_AAAAAAAAAAAAAAAAAAAAAA']);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.grant.approved' && e.data.grant_id === p.grant_id));
    const taken = t.codes.take(p.code);
    assert.equal(taken.ok, true);
    assert.equal(taken.record.grantId, p.grant_id);
    assert.deepEqual(t.codes.take(p.code), { ok: false, reused: p.grant_id });
  });

  it('a second phone can neither claim nor decide a claimed request (Review Focus 4)', async () => {
    const t = await setup();
    const p = t.newPending();
    assert.equal((await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`)).status, 200);
    const second = await t.call(C, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    assert.equal(second.status, 404);
    assert.equal(second.body.error, 'no_such_request');
    const decide = await t.call(C, 'POST', `/v1/grants/${p.grant_id}/decision`, C.grant({ frontdoorId: FD.nodeId, pending: p }));
    assert.equal(decide.status, 400);
    assert.equal(decide.body.error, 'not_claimant');
  });

  it('deny, a wrong code, a non-approver, and the per-device lookup rate', async () => {
    const t = await setup();
    const p = t.newPending();
    assert.equal((await t.call(A, 'GET', '/v1/grants/pending?user_code=ZZZ-ZZZ')).status, 404);
    assert.equal((await t.call(stranger, 'GET', `/v1/grants/pending?user_code=${p.user_code}`)).status, 403);
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    const deny = await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, decision: 'deny' }));
    assert.deepEqual(deny.body, { state: 'denied' });
    assert.equal(p.status, 'denied');
    assert.equal(t.grants.get(p.grant_id), null);
    let last;
    for (let i = 0; i < 9; i += 1) last = await t.call(A, 'GET', '/v1/grants/pending?user_code=ZZZZZZ');
    assert.equal(last.status, 429, 'the 11th lookup in a minute from one device is refused');
  });
});

describe('connected clients and revocation', () => {
  it('lists live grants; a challenge-bound revoke ends one at once', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p }));
    const list = await t.call(A, 'GET', '/v1/clients');
    assert.deepEqual(list.body.map((g) => [g.grant_id, g.client_name, g.scopes]), [[p.grant_id, 'Example Client', ['fleet:read', 'fleet:run']]]);
    const { body: { challenge } } = await t.call(A, 'POST', '/v1/challenges');
    const revoke = A.revokeClient({ frontdoorId: FD.nodeId, grantId: p.grant_id, challenge });
    assert.equal((await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke)).status, 204);
    assert.equal(t.grants.live(p.grant_id), null);
    assert.deepEqual(t.revoked, [p.grant_id]);
    const again = await t.call(A, 'POST', `/v1/clients/${p.grant_id}/revoke`, revoke);
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'challenge_reused');
    assert.deepEqual((await t.call(A, 'GET', '/v1/clients')).body, []);
  });
});

describe('GrantStore on load', () => {
  it('drops a grant whose record no longer matches its signature', async () => {
    const t = await setup();
    const p = t.newPending();
    await t.call(A, 'GET', `/v1/grants/pending?user_code=${p.user_code}`);
    await t.call(A, 'POST', `/v1/grants/${p.grant_id}/decision`, A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:read', machines: null }] }));
    const file = path.join(t.dataDir, 'frontdoor', 'oauth', 'grants.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.grants[p.grant_id].scopes = [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }];
    fs.writeFileSync(file, JSON.stringify(stored));
    const fresh = new GrantStore({ file, approverStore: t.store, frontdoorId: FD.nodeId, alerts: t.alerts });
    fresh.load();
    assert.equal(fresh.get(p.grant_id), null);
    assert.deepEqual(t.alerts.raised.at(-1), ['node_record_invalid', { subject: `grant:${p.grant_id}`, detail: { reason: 'record_mismatch' } }]);
  });
});

describe('AuthCodes', () => {
  it('60 s, single use', () => {
    let now = 0;
    const codes = new AuthCodes({ now: () => now });
    const code = codes.issue({ grantId: 'gr_x', clientId: 'dcr_y', redirectUri: 'https://client.example.com/cb', codeChallenge: 'c', resource: 'r' });
    now += 60001;
    assert.deepEqual(codes.take(code), { ok: false, expired: true });
    assert.deepEqual(codes.take('nope'), { ok: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-grants.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/oauth/grants'`.

- [ ] **Step 3: Write `src/frontdoor/oauth/grants.js`**

```js
// Grants (fleet stage 4 §3.4, §4.1): what the owner's phone signed for one
// client, kept with that signature. On every load each grant is re-verified
// against the admin-owned approvers, so a grant file the service account
// could edit decides nothing on its own. Authorization codes live in memory.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { canonicalize } = require('../../platform/jcs');
const { verifyPhoneEnvelope } = require('../protocol/checks');
const { formatScope } = require('../../fleet/scope-rules');

const log = createLogger('frontdoor/oauth/grants');
const TOUCH_EVERY_MS = 60000;
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');

class GrantStore extends EventEmitter {
  constructor({ file, approverStore, frontdoorId, alerts = null, now = Date.now } = {}) {
    super();
    this.file = file;
    this.approverStore = approverStore;
    this.frontdoorId = frontdoorId;
    this.alerts = alerts;
    this.now = now;
    this.grants = new Map();
    this.lastTouchSave = new Map();
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, grants: Object.fromEntries(this.grants) }, null, 2)}\n`);
  }

  _problem(g) {
    const v = verifyPhoneEnvelope(g.signed_grant, { approverStore: this.approverStore, type: 'kl.client.grant', frontdoorId: this.frontdoorId, acceptedAt: g.accepted_at });
    if (!v.ok) return v.reason;
    const m = v.message;
    if (m.decision !== 'approve') return 'not_approved';
    if (m.grant_id !== g.grant_id || m.client_id !== g.client_id || m.redirect_uri !== g.redirect_uri || m.resource !== g.resource
      || canonicalize(m.scopes) !== canonicalize(g.scopes) || m.device_id !== g.device_id) return 'record_mismatch';
    return null;
  }

  load() {
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')).grants || {};
    } catch {
      stored = {};
    }
    this.grants = new Map();
    let dropped = 0;
    for (const g of Object.values(stored)) {
      const reason = g && g.signed_grant ? this._problem(g) : 'malformed';
      if (reason) {
        dropped += 1;
        log.error(`dropping grant ${g && g.grant_id}: ${reason}`);
        if (this.alerts) this.alerts.raise('node_record_invalid', { subject: `grant:${g && g.grant_id}`, detail: { reason } });
        continue;
      }
      this.grants.set(g.grant_id, g);
    }
    if (dropped) this._save();
    return this.list({ liveOnly: false });
  }

  create({ pending, envelope, message, acceptedAt = new Date(this.now()).toISOString() }) {
    const grant = {
      grant_id: pending.grant_id,
      client_id: pending.client_id,
      client_name: pending.client_name,
      client_host: pending.client_host,
      redirect_uri: pending.redirect_uri,
      resource: pending.resource,
      scopes: message.scopes,
      device_id: message.device_id,
      accepted_at: acceptedAt,
      signed_grant: envelope,
      revoked_at: null,
      revoked_reason: null,
      last_used_at: null
    };
    this.grants.set(grant.grant_id, grant);
    this._save();
    return grant;
  }

  get(id) {
    return this.grants.get(id) || null;
  }

  live(id) {
    const g = this.grants.get(id);
    return g && g.revoked_at === null ? g : null;
  }

  list({ liveOnly = true } = {}) {
    return [...this.grants.values()].filter((g) => !liveOnly || g.revoked_at === null);
  }

  revoke(id, reason) {
    const g = this.grants.get(id);
    if (!g || g.revoked_at !== null) return false;
    g.revoked_at = new Date(this.now()).toISOString();
    g.revoked_reason = reason;
    this._save();
    this.emit('revoked', id);
    return true;
  }

  touch(id) {
    const g = this.grants.get(id);
    if (!g) return;
    const t = this.now();
    g.last_used_at = new Date(t).toISOString();
    if (t - (this.lastTouchSave.get(id) || 0) >= TOUCH_EVERY_MS) {
      this.lastTouchSave.set(id, t);
      this._save();
    }
  }

  scopeStrings(grant) {
    return grant.scopes.map((s) => formatScope(s));
  }
}

class AuthCodes {
  constructor({ now = Date.now, ttlMs = 60000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.codes = new Map();
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.codes) if (t > v.expiresAt + this.ttlMs) this.codes.delete(k);
  }

  issue({ grantId, clientId, redirectUri, codeChallenge, resource }) {
    this.sweep();
    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(sha(code), { grantId, clientId, redirectUri, codeChallenge, resource, expiresAt: this.now() + this.ttlMs, used: false });
    return code;
  }

  take(code) {
    const rec = this.codes.get(sha(code));
    if (!rec) return { ok: false };
    if (rec.used) return { ok: false, reused: rec.grantId };
    rec.used = true;
    if (!(this.now() <= rec.expiresAt)) return { ok: false, expired: true };
    return { ok: true, record: { ...rec } };
  }
}

module.exports = { GrantStore, AuthCodes };
```

- [ ] **Step 4: Write `src/frontdoor/oauth/grant-routes.js`**

```js
// The phone's side of connecting a client (fleet stage 4 §3.4, §4.9), under
// F3's /v1 and its X-KL-* device auth. Only an active approver of this front
// door (its admin-owned approvers/, R25) may use these routes.
const { ApiError } = require('../phone-api');
const { normalizeUserCode } = require('../protocol/messages');
const { checkGrantDecision, checkClientRevoke } = require('../protocol/checks');
const { recordFrontDoorEvent } = require('../audit/own-ledger');

function registerGrantRoutes(phoneApi, { pending, grants, codes, clients, challenges, approverStore, frontdoorId, scopeRules,
  auditLedger = null, onGrantRevoked = () => {}, now = Date.now } = {}) {
  const requireApprover = (ctx) => {
    if (!approverStore.isActive(ctx.deviceId)) throw new ApiError(403, 'forbidden', 'this phone is not an approver on this front door');
  };

  phoneApi.registerRoute('GET', '/v1/grants/pending', {
    auth: 'device',
    rate: { perMin: 10 },
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const code = normalizeUserCode(ctx.query.user_code);
      const found = code ? pending.byUserCode(code) : null;
      const claimed = found ? pending.claim(found.grant_id, ctx.deviceId) : null;
      if (!claimed) throw new ApiError(404, 'no_such_request', 'No connection request with that code');
      return {
        body: {
          grant_id: claimed.grant_id,
          // Not in §4.9's list: the phone signs client_id (§4.2), so it
          // needs it (Deviation 26).
          client_id: claimed.client_id,
          client_name: claimed.client_name,
          client_host: claimed.client_host,
          redirect_uri: claimed.redirect_uri,
          resource: claimed.resource,
          code_challenge: claimed.code_challenge,
          requested_scopes: claimed.requested_scopes,
          preselected: claimed.preselected,
          expires_in_ms: Math.max(0, claimed.expires_at_ms - now())
        }
      };
    }
  });

  phoneApi.registerRoute('POST', '/v1/grants/{id}/decision', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const p = pending.get(ctx.params.id);
      const r = checkGrantDecision(ctx.body, { approverStore, frontdoorId, pending: p, scopes: scopeRules(), now: now() });
      if (!r.ok) throw new ApiError(r.reason === 'unknown_request' || r.reason === 'expired' ? 410 : 400, r.reason, `the decision was refused: ${r.reason}`);
      if (r.deviceId !== ctx.deviceId) throw new ApiError(400, 'bad_decision', 'the decision must be signed by the calling phone');
      p.nonces.add(r.message.nonce);
      if (r.message.decision === 'deny') {
        pending.settle(p.grant_id, { status: 'denied' });
        await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.denied', { grant_id: p.grant_id, client_id: p.client_id, device_id: r.deviceId });
        return { body: { state: 'denied' } };
      }
      const grant = grants.create({ pending: p, envelope: ctx.body, message: r.message, acceptedAt: new Date(now()).toISOString() });
      clients.markGranted(p.client_id);
      const code = codes.issue({ grantId: grant.grant_id, clientId: p.client_id, redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, resource: p.resource });
      pending.settle(p.grant_id, { status: 'approved', code });
      await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.approved', { grant_id: grant.grant_id, client_id: grant.client_id, device_id: r.deviceId, scopes: grants.scopeStrings(grant) });
      return { body: { state: 'approved' } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/clients', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      return {
        body: grants.list().map((g) => ({
          grant_id: g.grant_id, client_name: g.client_name, client_host: g.client_host, scopes: grants.scopeStrings(g), accepted_at: g.accepted_at, last_used_at: g.last_used_at
        }))
      };
    }
  });

  phoneApi.registerRoute('POST', '/v1/challenges', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      try {
        return { body: challenges.issue(ctx.deviceId) };
      } catch (err) {
        throw new ApiError(429, err.code || 'too_many_challenges', err.message);
      }
    }
  });

  phoneApi.registerRoute('POST', '/v1/clients/{grant_id}/revoke', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const r = checkClientRevoke(ctx.body, { approverStore, frontdoorId, challenges });
      if (!r.ok) throw new ApiError(400, r.reason, `the revocation was refused: ${r.reason}`);
      if (r.message.grant_id !== ctx.params.grant_id || r.deviceId !== ctx.deviceId) throw new ApiError(400, 'bad_revoke', 'the revocation must name this grant and be signed by the calling phone');
      if (!grants.revoke(ctx.params.grant_id, 'phone')) throw new ApiError(404, 'not_found', 'no live grant with that id');
      onGrantRevoked(ctx.params.grant_id);
      await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.revoked', { grant_id: ctx.params.grant_id, device_id: r.deviceId, reason: 'phone' });
      return { status: 204 };
    }
  });
}

module.exports = { registerGrantRoutes };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/frontdoor-grants.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/frontdoor/oauth/grants.js src/frontdoor/oauth/grant-routes.js tests/frontdoor-grants.test.js
git commit -m "feat(frontdoor): phone-signed grants, authorization codes, connected clients and revocation" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 24: Opaque tokens — issue, rotate with reuse detection, revoke

**Files:**
- Create: `src/frontdoor/oauth/tokens.js`
- Modify: `src/frontdoor/oauth/server.js` (constructor options; two routes)
- Test: `tests/frontdoor-tokens.test.js`

**Interfaces:**
- Consumes: Task 23 (`AuthCodes`, the grant store's `live/revoke/scopeStrings/touch`), Task 4 (`parseScope`), Task 20 (`recordFrontDoorEvent`), Task 22 (`readBody`, `parseForm`, `sendJson`, `OAuthServer`).
- Produces:
  - `class TokenStore({ file, now = Date.now, accessTtlMs = 3600000, refreshIdleTtlMs = 2592000000, graceMs = 30000 })` with `issuePair({ grantId, clientId, scopes, aud }) → { access_token, refresh_token, expires_in, scope }`, `authenticate(token, { aud }) → { grant_id, client_id, scopes, aud, exp } | null`, `refresh({ token, clientId, scope }) → { pair, grantId } | { reuse: grantId }` (throws `OAuthError('invalid_grant' | 'invalid_scope')`), `revokeGrant(grantId)`, `find(token) → { kind: 'access' | 'refresh', record } | null`, `revokeAccess(token)`. Access `kla_…`, refresh `klr_…`, 32 random bytes each; the file `<dataDir>/frontdoor/oauth/tokens.json` holds only SHA-256 hashes. Refresh records: `{ grant_id, client_id, scopes, aud, generation, state: 'live' | 'rotated' | 'superseded', successor, graced, rotated_at, used, last_used, access_hash }`. The grace rule (§3.4): a `rotated` token presented again within 30 s of its rotation, while its successor is live and unused and the token is not yet `graced`, supersedes the successor (and its access token) and yields a new pair; anything else presented again is reuse.
  - `createTokenHandlers({ tokens, codes, grants, alerts = null, auditLedger = null, onGrantRevoked = () => {} }) → { token(req, res), revoke(req, res) }`: `POST /oauth/token` (`authorization_code` with PKCE S256 and exact `redirect_uri`/`client_id`/`resource`; a reused code revokes the grant; `refresh_token` with `client_id` and optional narrowing `scope`; reuse revokes the grant, raises `refresh_reuse` and audits `frontdoor.refresh_reuse`), `POST /oauth/revoke` (RFC 7009, always `200 {}`; a refresh token revokes its grant).
  - `OAuthServer({ …, tokens, codes, grants, alerts, auditLedger, onGrantRevoked })` now serves both routes.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-tokens.test.js`:

```js
// tests/frontdoor-tokens.test.js — fleet stage 4 §3.4 (tokens).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { TokenStore } = require('../src/frontdoor/oauth/tokens');
const { AuthCodes } = require('../src/frontdoor/oauth/grants');
const { OAuthServer } = require('../src/frontdoor/oauth/server');
const { PendingAuthorizations } = require('../src/frontdoor/oauth/pending');
const { ClientRegistry } = require('../src/frontdoor/oauth/clients');
const { createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { request, pkce } = require('./helpers/oauth-test-client');

const temps = [];
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tokens-')); temps.push(d); return d; };
const AUD = 'https://mcp.kl.example.com/mcp';

function store(now, file = path.join(tmp(), 'tokens.json')) {
  return new TokenStore({ file, now: () => now.t });
}

describe('TokenStore', () => {
  it('issues opaque kla_/klr_ tokens, stores only hashes, and checks exp and aud', () => {
    const now = { t: 0 };
    const s = store(now);
    const pair = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    assert.match(pair.access_token, /^kla_[A-Za-z0-9_-]{43}$/);
    assert.match(pair.refresh_token, /^klr_[A-Za-z0-9_-]{43}$/);
    assert.equal(pair.expires_in, 3600);
    const text = fs.readFileSync(s.file, 'utf8');
    assert.ok(!text.includes(pair.access_token.slice(4)) && !text.includes(pair.refresh_token.slice(4)), 'never the token itself');
    assert.equal(s.authenticate(pair.access_token, { aud: AUD }).grant_id, 'gr_1');
    assert.equal(s.authenticate(pair.access_token, { aud: 'https://other.example.com/mcp' }), null);
    now.t += 3600001;
    assert.equal(s.authenticate(pair.access_token, { aud: AUD }), null);
  });

  it('rotates on every use; a rotated token presented again after the grace window is reuse', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read', 'fleet:run;machines=web-01'], aud: AUD });
    const { pair: second } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    assert.notEqual(second.refresh_token, first.refresh_token);
    now.t += 31000;
    assert.deepEqual(s.refresh({ token: first.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' });
  });

  it('grace once: within 30 s the old token yields a new pair and the unused successor is superseded; a second time is reuse', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const { pair: successor } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    now.t += 5000;
    const { pair: retry } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    assert.ok(retry.access_token);
    assert.equal(s.authenticate(successor.access_token, { aud: AUD }), null, "the superseded successor's access token is dead");
    assert.deepEqual(s.refresh({ token: successor.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' }, 'presenting the superseded successor is reuse');
  });

  it('no grace once the successor has been used', () => {
    const now = { t: 0 };
    const s = store(now);
    const first = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const { pair: successor } = s.refresh({ token: first.refresh_token, clientId: 'dcr_1' });
    s.refresh({ token: successor.refresh_token, clientId: 'dcr_1' });
    assert.deepEqual(s.refresh({ token: first.refresh_token, clientId: 'dcr_1' }), { reuse: 'gr_1' });
  });

  it('another client, an idle-expired token, and scope widening are refused; narrowing works', () => {
    const now = { t: 0 };
    const s = store(now);
    const a = s.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read', 'fleet:run;machines=web-01'], aud: AUD });
    assert.throws(() => s.refresh({ token: a.refresh_token, clientId: 'dcr_2' }), (err) => err.error === 'invalid_grant');
    assert.throws(() => s.refresh({ token: a.refresh_token, clientId: 'dcr_1', scope: 'fleet:delegate' }), (err) => err.error === 'invalid_scope');
    const { pair } = s.refresh({ token: a.refresh_token, clientId: 'dcr_1', scope: 'fleet:run' });
    assert.equal(pair.scope, 'fleet:run;machines=web-01');
    now.t += 30 * 86400000 + 1;
    assert.throws(() => s.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }), (err) => err.error === 'invalid_grant');
  });

  it('tokens survive a restart (Review Focus 3)', () => {
    const now = { t: 0 };
    const file = path.join(tmp(), 'tokens.json');
    const a = store(now, file);
    const pair = a.issuePair({ grantId: 'gr_1', clientId: 'dcr_1', scopes: ['fleet:read'], aud: AUD });
    const b = store(now, file);
    assert.equal(b.authenticate(pair.access_token, { aud: AUD }).grant_id, 'gr_1');
    assert.ok(b.refresh({ token: pair.refresh_token, clientId: 'dcr_1' }).pair);
  });
});

describe('the token and revoke endpoints', () => {
  async function server() {
    const dir = tmp();
    const now = { t: Date.now() };
    const codes = new AuthCodes({ now: () => now.t });
    const tokens = new TokenStore({ file: path.join(dir, 'tokens.json'), now: () => now.t });
    const live = new Map([['gr_1', { grant_id: 'gr_1', client_id: 'dcr_1', resource: AUD, scopes: [{ scope: 'fleet:read', machines: null }] }]]);
    const revoked = [];
    const alerts = { raised: [], raise(kind, opts) { this.raised.push([kind, opts]); } };
    const grants = {
      live: (id) => live.get(id) || null,
      revoke: (id, reason) => { revoked.push([id, reason]); return live.delete(id); },
      scopeStrings: (g) => g.scopes.map((s) => s.scope),
      touch: () => {}
    };
    const oauth = new OAuthServer({
      domain: 'kl.example.com', clients: new ClientRegistry({ file: path.join(dir, 'clients.json') }), pending: new PendingAuthorizations(),
      scopeRegistry: createFleetScopeRegistry(), scopesEnabled: ['fleet:read'], tokens, codes, grants, alerts
    });
    const s = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    const { verifier, challenge } = pkce();
    const code = codes.issue({ grantId: 'gr_1', clientId: 'dcr_1', redirectUri: 'https://client.example.com/cb', codeChallenge: challenge, resource: AUD });
    return { base: `http://127.0.0.1:${s.address().port}`, code, verifier, tokens, revoked, alerts, now };
  }

  const exchange = (t, extra = {}) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: t.code, redirect_uri: 'https://client.example.com/cb', client_id: 'dcr_1', code_verifier: t.verifier, ...extra } });

  it('exchanges a code with the right verifier, with no-store', async () => {
    const t = await server();
    const res = await exchange(t);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.token_type, 'Bearer');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(t.tokens.authenticate(res.json.access_token, { aud: AUD }).grant_id, 'gr_1');
  });

  it('refresh reuse through the endpoint revokes the grant and raises refresh_reuse', async () => {
    const t = await server();
    const first = (await exchange(t)).json;
    const refresh = (token) => request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: token, client_id: 'dcr_1' } });
    assert.equal((await refresh(first.refresh_token)).status, 200);
    t.now.t += 31000;
    const reused = await refresh(first.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.json.error, 'invalid_grant');
    assert.deepEqual(t.revoked, [['gr_1', 'refresh_reuse']]);
    assert.equal(t.alerts.raised[0][0], 'refresh_reuse');
  });

  it('revoking a refresh token revokes its grant; revoke always answers 200', async () => {
    const t = await server();
    const first = (await exchange(t)).json;
    const r = await request(t.base, { method: 'POST', path: '/oauth/revoke', form: { token: first.refresh_token } });
    assert.equal(r.status, 200);
    assert.deepEqual(t.revoked, [['gr_1', 'client_revoked']]);
    assert.equal(t.tokens.authenticate(first.access_token, { aud: AUD }), null);
    assert.equal((await request(t.base, { method: 'POST', path: '/oauth/revoke', form: { token: 'kla_nothing' } })).status, 200);
  });

  it('refuses an unknown grant_type', async () => {
    const t = await server();
    const r = await request(t.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'client_credentials' } });
    assert.equal(r.json.error, 'unsupported_grant_type');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-tokens.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/oauth/tokens'`.

- [ ] **Step 3: Write `src/frontdoor/oauth/tokens.js`**

```js
// Opaque tokens (fleet stage 4 §3.4): the resource server is this process,
// so every request looks the token up and revocation is immediate. Only
// SHA-256 hashes are stored. Refresh tokens rotate on every use; a rotated
// token presented again is reuse and revokes the grant, except once, within
// 30 s, while the successor is still unused (a client retrying a refresh
// whose answer it lost).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { parseScope } = require('../../fleet/scope-rules');
const { OAuthError } = require('./errors');
const { readBody, parseForm, sendJson } = require('../http-util');
const { recordFrontDoorEvent } = require('../audit/own-ledger');

const log = createLogger('frontdoor/oauth/tokens');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const BODY_LIMIT = 65536;

class TokenStore {
  constructor({ file, now = Date.now, accessTtlMs = 3600000, refreshIdleTtlMs = 30 * 86400000, graceMs = 30000 } = {}) {
    this.file = file;
    this.now = now;
    this.accessTtlMs = accessTtlMs;
    this.refreshIdleTtlMs = refreshIdleTtlMs;
    this.graceMs = graceMs;
    this.access = new Map();
    this.refreshTokens = new Map();
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [h, r] of Object.entries(stored.access || {})) this.access.set(h, r);
      for (const [h, r] of Object.entries(stored.refresh || {})) this.refreshTokens.set(h, r);
    } catch {
      // no tokens yet
    }
  }

  _save() {
    const t = this.now();
    for (const [h, r] of this.access) if (r.exp <= t) this.access.delete(h);
    for (const [h, r] of this.refreshTokens) if (t - r.last_used > this.refreshIdleTtlMs) this.refreshTokens.delete(h);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, access: Object.fromEntries(this.access), refresh: Object.fromEntries(this.refreshTokens) })}\n`);
  }

  _mint({ grantId, clientId, scopes, aud, generation }) {
    const t = this.now();
    const accessToken = `kla_${crypto.randomBytes(32).toString('base64url')}`;
    const refreshToken = `klr_${crypto.randomBytes(32).toString('base64url')}`;
    const accessHash = sha(accessToken);
    const refreshHash = sha(refreshToken);
    this.access.set(accessHash, { grant_id: grantId, client_id: clientId, scopes: [...scopes], aud, exp: t + this.accessTtlMs });
    this.refreshTokens.set(refreshHash, {
      grant_id: grantId, client_id: clientId, scopes: [...scopes], aud, generation, state: 'live', successor: null, graced: false,
      rotated_at: null, used: false, last_used: t, access_hash: accessHash
    });
    return {
      pair: { access_token: accessToken, token_type: 'Bearer', expires_in: Math.round(this.accessTtlMs / 1000), refresh_token: refreshToken, scope: scopes.join(' ') },
      refreshHash
    };
  }

  issuePair({ grantId, clientId, scopes, aud }) {
    const { pair } = this._mint({ grantId, clientId, scopes, aud, generation: 1 });
    this._save();
    return pair;
  }

  authenticate(token, { aud }) {
    if (typeof token !== 'string' || !token.startsWith('kla_')) return null;
    const rec = this.access.get(sha(token));
    if (!rec || !(this.now() < rec.exp) || rec.aud !== aud) return null;
    return { ...rec };
  }

  _narrow(scopes, scope) {
    if (scope === undefined || scope === null || String(scope).trim() === '') return scopes;
    const wanted = String(scope).trim().split(/\s+/);
    const byName = new Map(scopes.map((s) => [parseScope(s).scope, s]));
    for (const w of wanted) {
      const name = w.split(';')[0];
      if (!byName.has(name)) throw new OAuthError('invalid_scope', `the grant does not include ${name}`);
    }
    return wanted.map((w) => byName.get(w.split(';')[0])).filter((s, i, all) => all.indexOf(s) === i);
  }

  refresh({ token, clientId, scope = undefined }) {
    const rec = typeof token === 'string' && token.startsWith('klr_') ? this.refreshTokens.get(sha(token)) : null;
    if (!rec) throw new OAuthError('invalid_grant', 'unknown refresh token');
    if (rec.client_id !== clientId) throw new OAuthError('invalid_grant', 'this refresh token was issued to another client');
    const t = this.now();
    if (rec.state === 'live') {
      if (t - rec.last_used > this.refreshIdleTtlMs) {
        this.refreshTokens.delete(sha(token));
        this._save();
        throw new OAuthError('invalid_grant', 'the refresh token expired');
      }
      const scopes = this._narrow(rec.scopes, scope);
      const minted = this._mint({ grantId: rec.grant_id, clientId, scopes, aud: rec.aud, generation: rec.generation + 1 });
      rec.state = 'rotated';
      rec.rotated_at = t;
      rec.used = true;
      rec.successor = minted.refreshHash;
      this._save();
      return { pair: minted.pair, grantId: rec.grant_id };
    }
    if (rec.state === 'rotated' && !rec.graced && t - rec.rotated_at <= this.graceMs) {
      const successor = this.refreshTokens.get(rec.successor);
      if (successor && successor.state === 'live' && !successor.used) {
        rec.graced = true;
        successor.state = 'superseded';
        this.access.delete(successor.access_hash);
        const scopes = this._narrow(rec.scopes, scope);
        const minted = this._mint({ grantId: rec.grant_id, clientId, scopes, aud: rec.aud, generation: rec.generation + 1 });
        rec.successor = minted.refreshHash;
        this._save();
        return { pair: minted.pair, grantId: rec.grant_id };
      }
    }
    return { reuse: rec.grant_id };
  }

  revokeGrant(grantId) {
    let changed = false;
    for (const [h, r] of this.access) if (r.grant_id === grantId) { this.access.delete(h); changed = true; }
    for (const [h, r] of this.refreshTokens) if (r.grant_id === grantId) { this.refreshTokens.delete(h); changed = true; }
    if (changed) this._save();
  }

  find(token) {
    if (typeof token !== 'string') return null;
    const h = sha(token);
    if (this.access.has(h)) return { kind: 'access', record: this.access.get(h) };
    if (this.refreshTokens.has(h)) return { kind: 'refresh', record: this.refreshTokens.get(h) };
    return null;
  }

  revokeAccess(token) {
    if (this.access.delete(sha(token))) this._save();
  }
}

function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createTokenHandlers({ tokens, codes, grants, alerts = null, auditLedger = null, onGrantRevoked = () => {} } = {}) {
  const revokeGrant = async (grantId, reason) => {
    grants.revoke(grantId, reason);
    tokens.revokeGrant(grantId);
    onGrantRevoked(grantId);
    await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.revoked', { grant_id: grantId, reason });
  };

  async function readForm(req) {
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new OAuthError('invalid_request', 'the token endpoint takes application/x-www-form-urlencoded');
    }
    return parseForm(await readBody(req, BODY_LIMIT));
  }

  async function token(req, res) {
    const f = await readForm(req);
    let pair;
    let grantId;
    if (f.grant_type === 'authorization_code') {
      for (const k of ['code', 'redirect_uri', 'client_id', 'code_verifier']) if (!f[k]) throw new OAuthError('invalid_request', `${k} is required`);
      const taken = codes.take(f.code);
      if (taken.reused) {
        await revokeGrant(taken.reused, 'code_reuse');
        throw new OAuthError('invalid_grant', 'this authorization code was already used; the grant is revoked');
      }
      if (!taken.ok) throw new OAuthError('invalid_grant', taken.expired ? 'the authorization code expired' : 'unknown authorization code');
      const rec = taken.record;
      if (rec.clientId !== f.client_id || rec.redirectUri !== f.redirect_uri) throw new OAuthError('invalid_grant', 'client_id or redirect_uri do not match the authorization');
      if (f.resource !== undefined && f.resource !== rec.resource) throw new OAuthError('invalid_grant', 'resource does not match the authorization');
      if (!pkceMatches(f.code_verifier, rec.codeChallenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge');
      const grant = grants.live(rec.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'the grant is gone');
      grantId = grant.grant_id;
      pair = tokens.issuePair({ grantId, clientId: grant.client_id, scopes: grants.scopeStrings(grant), aud: grant.resource });
    } else if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token || !f.client_id) throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
      const r = tokens.refresh({ token: f.refresh_token, clientId: f.client_id, scope: f.scope });
      if (r.reuse) {
        log.warn(`refresh token reuse on ${r.reuse}; revoking the grant`);
        await revokeGrant(r.reuse, 'refresh_reuse');
        if (alerts) alerts.raise('refresh_reuse', { subject: `grant:${r.reuse}`, detail: { client_id: f.client_id } });
        await recordFrontDoorEvent(auditLedger, 'frontdoor.refresh_reuse', { grant_id: r.reuse });
        throw new OAuthError('invalid_grant', 'this refresh token was already used; the grant is revoked');
      }
      const grant = grants.live(r.grantId);
      if (!grant) {
        tokens.revokeGrant(r.grantId);
        throw new OAuthError('invalid_grant', 'the grant is gone');
      }
      grantId = grant.grant_id;
      pair = r.pair;
    } else {
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
    grants.touch(grantId);
    await recordFrontDoorEvent(auditLedger, 'frontdoor.token.issued', { grant_id: grantId, kind: f.grant_type });
    sendJson(res, 200, pair, { pragma: 'no-cache' });
  }

  async function revoke(req, res) {
    const f = await readForm(req);
    const found = tokens.find(f.token);
    if (found && found.kind === 'refresh') await revokeGrant(found.record.grant_id, 'client_revoked');
    else if (found) tokens.revokeAccess(f.token);
    sendJson(res, 200, {});
  }

  return { token, revoke };
}

module.exports = { TokenStore, createTokenHandlers, pkceMatches };
```

- [ ] **Step 4: Serve the token routes from `OAuthServer`**

In `src/frontdoor/oauth/server.js`:

1. Add to the requires: `const { createTokenHandlers } = require('./tokens');`
2. Replace the constructor signature with:

```js
  constructor({ domain, clients, pending, scopeRegistry, scopesEnabled, clientDefaults = [], now = Date.now,
    tokens = null, codes = null, grants = null, alerts = null, auditLedger = null, onGrantRevoked = () => {} } = {}) {
```

3. At the end of the constructor add:

```js
    if (tokens && codes && grants) {
      const handlers = createTokenHandlers({ tokens, codes, grants, alerts, auditLedger, onGrantRevoked });
      this.routes.set('POST /oauth/token', (req, res) => handlers.token(req, res));
      this.routes.set('POST /oauth/revoke', (req, res) => handlers.revoke(req, res));
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-tokens.test.js tests/frontdoor-authorize.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/frontdoor/oauth/tokens.js src/frontdoor/oauth/server.js tests/frontdoor-tokens.test.js
git commit -m "feat(frontdoor): opaque tokens with rotation, one-time grace, reuse revocation and RFC 7009 revoke" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 25: The `mcp.` HTTP dispatcher and the OAuth flow end to end

**Files:**
- Create: `src/frontdoor/http.js`
- Create: `tests/helpers/frontdoor-harness.js`
- Test: `tests/frontdoor-oauth.test.js`, `tests/frontdoor-pkce.test.js`, `tests/frontdoor-grant-abuse.test.js`

**Interfaces:**
- Consumes: Tasks 21–24 (`ClientRegistry`, `PendingAuthorizations`, `OAuthServer`, `GrantStore`, `AuthCodes`, `registerGrantRoutes`, `TokenStore`), Task 20 (`AlertCenter`), Task 2 (`Challenges`), F3 `createPhoneApi`, `DeviceRegistry`.
- Produces:
  - `createFrontDoorHandler({ mcpHost, oauth, mcp = null, phoneApiHandler, pairHandler = null, probeHandler = null }) → (req, res)` (`src/frontdoor/http.js`): `Host` other than `mcpHost` → `421`; `/v1/*` → F3's phone API (F4's routes registered on it); `/pair/v1…` → `pairHandler`; `/.well-known/kl-probe/…` → `probeHandler`; OAuth paths → `oauth.handle`; `/mcp` → `mcp.handle`; anything else `404`. `createMcpHttpServer(handler) → http.Server` (never listens; the SNI listener emits `connection` with each `mcp.` TLS socket) with `requestTimeout` 30 s, `headersTimeout` 15 s, `keepAliveTimeout` 5 s.
  - `tests/helpers/frontdoor-harness.js`: `startFrontDoorHttp({ mcp, fetchMetadata, clientDefaults, scopesEnabled, now, pendingPerIp }) → { base, fd, phone, second, oauth, pending, grants, tokens, codes, clients, alerts, audit, pushes, phoneCall(phone, method, path, body), connect({ scopes, redirectUri, clientName, state }) → { tokens, clientId, grantId, verifier, location } }` — the whole front half of a front door on plain HTTP (every request carries `Host: mcp.kl.example.com`), with fake phones A (the owner) and C (a second enrolled phone). Used again by Task 26.

- [ ] **Step 1: Write the harness**

Create `tests/helpers/frontdoor-harness.js`:

```js
// tests/helpers/frontdoor-harness.js
//
// The front door's HTTP front half on plain http (the SNI listener and TLS
// are Task 16's): OAuth, the phone API with F4's grant routes, and an
// optional MCP endpoint. Phone A is the owner; C is a second enrolled phone.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPhoneApi } = require('../../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../../src/frontdoor/device-registry');
const { ClientRegistry } = require('../../src/frontdoor/oauth/clients');
const { PendingAuthorizations } = require('../../src/frontdoor/oauth/pending');
const { OAuthServer } = require('../../src/frontdoor/oauth/server');
const { GrantStore, AuthCodes } = require('../../src/frontdoor/oauth/grants');
const { registerGrantRoutes } = require('../../src/frontdoor/oauth/grant-routes');
const { TokenStore } = require('../../src/frontdoor/oauth/tokens');
const { createFleetScopeRegistry } = require('../../src/frontdoor/oauth/scopes');
const { Challenges } = require('../../src/frontdoor/protocol/challenges');
const { AlertCenter } = require('../../src/frontdoor/alerts');
const { createFrontDoorHandler } = require('../../src/frontdoor/http');
const { createFakePhone, testNodeIdentity } = require('./fake-phone');
const { approverStoreWith } = require('./approver-set');
const { request, pkce, parseConsent, cookieOf } = require('./oauth-test-client');

const FLEET = ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate'];

async function startFrontDoorHttp({ mcp = null, fetchMetadata = null, clientDefaults = [], scopesEnabled = FLEET, now = Date.now, pendingPerIp = null } = {}) {
  const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
  const phone = createFakePhone({ seed: 'A', name: 'Owner phone' });
  const second = createFakePhone({ seed: 'C', name: 'Second phone' });
  const store = await approverStoreWith([phone.approverRecord(), second.approverRecord()], { allowTestKeys: true, now });
  const dataDir = path.join(store.baseDir, 'data');
  const dir = path.join(dataDir, 'frontdoor', 'oauth');
  fs.mkdirSync(dir, { recursive: true });
  const devices = new DeviceRegistry({ file: path.join(dataDir, 'relay', 'devices.json') });
  for (const p of [phone, second]) devices.register({ device_id: p.deviceId, jwk: p.jwk, name: p.name, platform: 'android' });
  const phoneApi = createPhoneApi({ devices });
  const alerts = new AlertCenter({ file: path.join(dataDir, 'frontdoor', 'alerts.json'), now });
  const audit = [];
  const auditLedger = { append: async (e) => { audit.push(e); return e; } };
  const pushes = [];
  const scopeRegistry = createFleetScopeRegistry();
  const clients = new ClientRegistry({ file: path.join(dir, 'clients.json'), now, ...(fetchMetadata ? { fetchMetadata } : {}) });
  // pendingPerIp: tests that run several flows from 127.0.0.1 raise R23's 3-per-IP cap.
  const pending = new PendingAuthorizations({ now, ...(pendingPerIp ? { perIp: pendingPerIp } : {}) });
  const grants = new GrantStore({ file: path.join(dir, 'grants.json'), approverStore: store, frontdoorId: fd.nodeId, alerts, now });
  const codes = new AuthCodes({ now });
  const tokens = new TokenStore({ file: path.join(dir, 'tokens.json'), now });
  const challenges = new Challenges({ now });
  const revokedGrants = [];
  let mcpEndpoint = null;
  const onGrantRevoked = (grantId) => {
    revokedGrants.push(grantId);
    tokens.revokeGrant(grantId);
    if (mcpEndpoint && typeof mcpEndpoint.endSessionsForGrant === 'function') mcpEndpoint.endSessionsForGrant(grantId);
  };
  const oauth = new OAuthServer({
    domain: 'kl.example.com', clients, pending, scopeRegistry, scopesEnabled, clientDefaults, now,
    tokens, codes, grants, alerts, auditLedger, onGrantRevoked
  });
  registerGrantRoutes(phoneApi, {
    pending, grants, codes, clients, challenges, approverStore: store, frontdoorId: fd.nodeId,
    scopeRules: () => scopeRegistry.rules(scopesEnabled), auditLedger, onGrantRevoked, now
  });
  mcpEndpoint = typeof mcp === 'function' ? mcp({ tokens, grants, scopeRegistry, scopesEnabled, oauth }) : mcp;
  const handler = createFrontDoorHandler({ mcpHost: 'mcp.kl.example.com', oauth, mcp: mcpEndpoint, phoneApiHandler: phoneApi.handler });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const phoneCall = async (p, method, pathWithQuery, body = null) => {
    const text = body === null ? '' : JSON.stringify(body);
    const res = await request(base, { method, path: pathWithQuery, headers: { ...p.signApi(method, pathWithQuery, text), ...(body === null ? {} : { 'content-type': 'application/json' }) }, ...(body === null ? {} : { raw: text }) });
    return { status: res.status, body: res.json };
  };

  async function connect({ scopes = null, redirectUri = 'https://client.example.com/cb', clientName = 'Example Client', state = 'xyz', clientId = null, scope = undefined } = {}) {
    let id = clientId;
    if (!id) {
      const reg = await request(base, { method: 'POST', path: '/oauth/register', json: { client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
      id = reg.json.client_id;
    }
    const { verifier, challenge } = pkce();
    const params = { response_type: 'code', client_id: id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', ...(state === null ? {} : { state }), ...(scope === undefined ? {} : { scope }) };
    const consent = await request(base, { path: `/oauth/authorize?${new URLSearchParams(params)}` });
    const { userCode, grantId } = parseConsent(consent.text);
    const lookup = await phoneCall(phone, 'GET', `/v1/grants/pending?user_code=${userCode}`);
    const view = lookup.body;
    const pendingView = { ...view, user_code: userCode.replace('-', '') };
    const signed = phone.grant({ frontdoorId: fd.nodeId, pending: pendingView, scopes: scopes || [...view.preselected].sort().map((s) => ({ scope: s, machines: null })) });
    const decision = await phoneCall(phone, 'POST', `/v1/grants/${grantId}/decision`, signed);
    if (decision.status !== 200) return { decision, grantId, clientId: id, verifier };
    const wait = await request(base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: cookieOf(consent) } });
    const location = new URL(wait.headers.location);
    const token = await request(base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirectUri, client_id: id, code_verifier: verifier } });
    return { tokens: token.json, tokenStatus: token.status, clientId: id, grantId, verifier, location, code: location.searchParams.get('code') };
  }

  return {
    base, fd, phone, second, oauth, pending, grants, tokens, codes, clients, alerts, audit, pushes, store, dataDir, revokedGrants, phoneCall, connect,
    mcp: mcpEndpoint,
    async stop() {
      await new Promise((r) => server.close(r));
      store.cleanup();
    }
  };
}

module.exports = { startFrontDoorHttp, FLEET };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/frontdoor-oauth.test.js`:

```js
// tests/frontdoor-oauth.test.js — fleet stage 4 §3.4, the whole flow.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });
const start = async (opts) => { const h = await startFrontDoorHttp(opts); running.push(h); return h; };

describe('connecting a client', () => {
  it('DCR → authorize → typed code on the phone → wait page → token', async () => {
    const h = await start();
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.location.origin + r.location.pathname, 'https://client.example.com/cb');
    assert.equal(r.location.searchParams.get('state'), 'xyz');
    assert.equal(r.location.searchParams.get('iss'), 'https://mcp.kl.example.com');
    assert.equal(r.tokens.scope, 'fleet:read');
    const auth = h.tokens.authenticate(r.tokens.access_token, { aud: 'https://mcp.kl.example.com/mcp' });
    assert.equal(auth.grant_id, r.grantId);
    assert.ok(h.audit.some((e) => e.kind === 'frontdoor.token.issued' && e.data.kind === 'authorization_code'));
  });

  it('a client ID metadata document works the same way', async () => {
    const url = 'https://client.example.com/client.json';
    const h = await start({ fetchMetadata: async (u) => ({ client_id: u, client_name: 'Metadata Client', redirect_uris: ['https://client.example.com/cb'] }) });
    const r = await h.connect({ clientId: url, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(h.grants.live(r.grantId).client_name, 'Metadata Client');
  });

  it('client defaults only preselect; the phone decides what is granted', async () => {
    const h = await start({ clientDefaults: [{ host: 'client.example.com', scopes: ['fleet:read', 'fleet:run'] }] });
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const r = await h.connect({ clientId: reg.json.client_id, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.deepEqual(h.grants.scopeStrings(h.grants.live(r.grantId)), ['fleet:read']);
    const other = await start();
    const r2 = await other.connect({ redirectUri: 'https://other.example.com/cb', scopes: null });
    assert.deepEqual(other.grants.scopeStrings(other.grants.live(r2.grantId)), ['fleet:read'], 'no default: fleet:read only');
  });

  it('fleet:unsafe alone is invalid_scope', async () => {
    const h = await start();
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }] });
    assert.equal(r.decision.status, 400);
    assert.equal(r.decision.body.error, 'invalid_scope');
  });

  it('refresh rotates; reuse revokes the grant and raises refresh_reuse; the phone can revoke through a challenge', async () => {
    const h = await start();
    const r = await h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const refresh = (t) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: t, client_id: r.clientId } });
    const next = await refresh(r.tokens.refresh_token);
    assert.equal(next.status, 200);
    const second = await start();
    const s = await second.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const { body: { challenge } } = await second.phoneCall(second.phone, 'POST', '/v1/challenges');
    const res = await second.phoneCall(second.phone, 'POST', `/v1/clients/${s.grantId}/revoke`, second.phone.revokeClient({ frontdoorId: second.fd.nodeId, grantId: s.grantId, challenge }));
    assert.equal(res.status, 204);
    assert.equal(second.tokens.authenticate(s.tokens.access_token, { aud: 'https://mcp.kl.example.com/mcp' }), null, 'revocation takes effect at once');
  });
});
```

Create `tests/frontdoor-pkce.test.js`:

```js
// tests/frontdoor-pkce.test.js — fleet stage 4 §3.4 (PKCE and the code).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request, pkce } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });

const tokenReq = (h, form) => request(h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'authorization_code', ...form } });

describe('PKCE and authorization codes', () => {
  it('refuses a wrong verifier, a redirect or resource mismatch; a reused code revokes the grant', async () => {
    const h = await startFrontDoorHttp({ pendingPerIp: 10 });
    running.push(h);
    // Stop before the token exchange: drive the flow by hand.
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const flow = async () => {
      const { verifier, challenge } = pkce();
      const consent = await request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
      const { userCode, grantId } = require('./helpers/oauth-test-client').parseConsent(consent.text);
      const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
      await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] }));
      const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: require('./helpers/oauth-test-client').cookieOf(consent) } });
      return { code: new URL(wait.headers.location).searchParams.get('code'), verifier, grantId };
    };
    const a = await flow();
    assert.equal((await tokenReq(h, { code: a.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: pkce().verifier })).json.error, 'invalid_grant');
    const b = await flow();
    assert.equal((await tokenReq(h, { code: b.code, redirect_uri: 'https://client.example.com/other', client_id: reg.json.client_id, code_verifier: b.verifier })).json.error, 'invalid_grant');
    const c = await flow();
    assert.equal((await tokenReq(h, { code: c.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: c.verifier, resource: 'https://other.example.com/mcp' })).json.error, 'invalid_grant');
    const d = await flow();
    const ok = await tokenReq(h, { code: d.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: d.verifier });
    assert.equal(ok.status, 200);
    const again = await tokenReq(h, { code: d.code, redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: d.verifier });
    assert.equal(again.json.error, 'invalid_grant');
    assert.equal(h.grants.live(d.grantId), null, 'a second use of the code revokes the grant');
    assert.equal(h.tokens.authenticate(ok.json.access_token, { aud: 'https://mcp.kl.example.com/mcp' }), null);
  });

  it('a code older than 60 s is refused', async () => {
    let now = Date.now();
    const h = await startFrontDoorHttp({ now: () => now });
    running.push(h);
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const { verifier, challenge } = pkce();
    const consent = await request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'https://client.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
    const helpers = require('./helpers/oauth-test-client');
    const { userCode, grantId } = helpers.parseConsent(consent.text);
    const view = (await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`)).body;
    await h.phoneCall(h.phone, 'POST', `/v1/grants/${grantId}/decision`, h.phone.grant({ frontdoorId: h.fd.nodeId, pending: { ...view, user_code: userCode.replace('-', '') }, scopes: [{ scope: 'fleet:read', machines: null }] }));
    const wait = await request(h.base, { path: `/oauth/authorize/wait?id=${grantId}`, headers: { cookie: helpers.cookieOf(consent) } });
    now += 60001;
    const late = await tokenReq(h, { code: new URL(wait.headers.location).searchParams.get('code'), redirect_uri: 'https://client.example.com/cb', client_id: reg.json.client_id, code_verifier: verifier });
    assert.equal(late.json.error, 'invalid_grant');
  });

  it('state may be omitted, and then is not echoed', async () => {
    const h = await startFrontDoorHttp();
    running.push(h);
    const r = await h.connect({ state: null, scopes: [{ scope: 'fleet:read', machines: null }] });
    assert.equal(r.tokenStatus, 200);
    assert.equal(r.location.searchParams.has('state'), false);
  });
});
```

Create `tests/frontdoor-grant-abuse.test.js`:

```js
// tests/frontdoor-grant-abuse.test.js — fleet stage 4 §3.4, R23 (grant phishing).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request, pkce, parseConsent } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });
const start = async () => { const h = await startFrontDoorHttp(); running.push(h); return h; };

async function authorize(h, clientId, redirectUri = 'https://client.example.com/cb') {
  return request(h.base, { path: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}` });
}

describe('grant abuse', () => {
  it('three new requests per IP per 10 minutes', async () => {
    const h = await start();
    const ids = [];
    for (const host of ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']) {
      const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: host, redirect_uris: [`https://${host}/cb`] } });
      ids.push([reg.json.client_id, `https://${host}/cb`]);
    }
    for (let i = 0; i < 3; i += 1) assert.equal((await authorize(h, ids[i][0], ids[i][1])).status, 200);
    assert.equal((await authorize(h, ids[3][0], ids[3][1])).status, 429);
  });

  it('one per client host: a newer request replaces an older unclaimed one', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const first = parseConsent((await authorize(h, reg.json.client_id)).text);
    const second = parseConsent((await authorize(h, reg.json.client_id)).text);
    assert.equal(h.pending.get(first.grantId), null);
    assert.ok(h.pending.get(second.grantId));
  });

  it('a claimed request survives a flood of 60; a wrong typed code is 404; no push is ever sent for grants', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const mine = parseConsent((await authorize(h, reg.json.client_id)).text);
    assert.equal((await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${mine.userCode}`)).status, 200);
    const client = h.clients.get(reg.json.client_id);
    for (let i = 0; i < 60; i += 1) {
      h.pending.create({ client, redirectUri: 'https://client.example.com/cb', codeChallenge: pkce().challenge, resource: 'https://mcp.kl.example.com/mcp', requestedScopes: ['fleet:read'], preselected: ['fleet:read'], ip: `198.51.100.${i}`, clientHost: `flood${i}.example.com` });
    }
    assert.ok(h.pending.get(mine.grantId), 'claimed requests are never evicted');
    const miss = await h.phoneCall(h.phone, 'GET', '/v1/grants/pending?user_code=000-000');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error, 'no_such_request');
    assert.deepEqual(h.pushes, []);
  });

  it('a second phone can neither claim nor decide a claimed request (Review Focus 4)', async () => {
    const h = await start();
    const reg = await request(h.base, { method: 'POST', path: '/oauth/register', json: { client_name: 'X', redirect_uris: ['https://client.example.com/cb'] } });
    const { userCode, grantId } = parseConsent((await authorize(h, reg.json.client_id)).text);
    const owner = await h.phoneCall(h.phone, 'GET', `/v1/grants/pending?user_code=${userCode}`);
    assert.equal(owner.status, 200);
    assert.equal((await h.phoneCall(h.second, 'GET', `/v1/grants/pending?user_code=${userCode}`)).status, 404);
    const signed = h.second.grant({ frontdoorId: h.fd.nodeId, pending: { ...owner.body, user_code: userCode.replace('-', '') } });
    const decided = await h.phoneCall(h.second, 'POST', `/v1/grants/${grantId}/decision`, signed);
    assert.equal(decided.status, 400);
    assert.equal(decided.body.error, 'not_claimant');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/frontdoor-oauth.test.js tests/frontdoor-pkce.test.js tests/frontdoor-grant-abuse.test.js`
Expected: FAIL with `Cannot find module '../../src/frontdoor/http'`.

- [ ] **Step 4: Write `src/frontdoor/http.js`**

```js
// The mcp.<domain> HTTP surface (fleet stage 4 §3.2, §3.4, §3.5): one
// handler behind the SNI listener. F3's phone API keeps /v1 (F4's routes are
// registered on it), OAuth and MCP are the front door's own, /pair/v1 is the
// node side of pairing, and /.well-known/kl-probe/ answers the self-probe.
const http = require('http');
const { sendJson, requestHost } = require('./http-util');

function createFrontDoorHandler({ mcpHost, oauth, mcp = null, phoneApiHandler, pairHandler = null, probeHandler = null } = {}) {
  return async (req, res) => {
    if (requestHost(req) !== mcpHost) {
      sendJson(res, 421, { error: 'misdirected_request', error_description: `this front door answers only as ${mcpHost}` });
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, `https://${mcpHost}`).pathname;
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (pathname.startsWith('/v1/')) return phoneApiHandler(req, res);
    if ((pathname === '/pair/v1' || pathname.startsWith('/pair/v1/')) && pairHandler) return pairHandler(req, res);
    if (pathname.startsWith('/.well-known/kl-probe/') && probeHandler) return probeHandler(req, res);
    if (await oauth.handle(req, res)) return undefined;
    if (pathname === '/mcp' && mcp) return mcp.handle(req, res);
    sendJson(res, 404, { error: 'not_found' });
    return undefined;
  };
}

function createMcpHttpServer(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

module.exports = { createFrontDoorHandler, createMcpHttpServer };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-oauth.test.js tests/frontdoor-pkce.test.js tests/frontdoor-grant-abuse.test.js tests/frontdoor-authorize.test.js tests/frontdoor-grants.test.js tests/frontdoor-tokens.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/frontdoor/http.js tests/helpers/frontdoor-harness.js tests/frontdoor-oauth.test.js tests/frontdoor-pkce.test.js tests/frontdoor-grant-abuse.test.js
git commit -m "feat(frontdoor): the mcp. HTTP dispatcher; OAuth end to end with PKCE and grant-abuse tests" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 26: The MCP Streamable HTTP endpoint

**Files:**
- Create: `src/frontdoor/mcp/http-endpoint.js`
- Test: `tests/frontdoor-mcp-http.test.js`

**Interfaces:**
- Consumes: Task 24 (`TokenStore#authenticate`), Task 23 (`GrantStore#live/touch`), Task 4 (`ScopeRegistry#requiredScopeFor/toolsFor`, `parseScope`), Task 22 (`readBody`, `sendJson`, `requestHost`), Task 25 (the harness). A router object (Task 27's `FleetRouter` implements it): `toolDefinitions() → [{ name, description, inputSchema }]`, `callTool(name, args, { grant, scopes, session }) → Promise<result | { ok: false, error: { code, message, … } }>`, `watchJob(publicJobId, onUpdate({ status, log_lines, offline? })) → unsubscribe`, `isTerminal(status) → boolean`.
- Produces: `class McpHttpEndpoint({ mcpHost, resourceUrl, tokens, grants, scopeRegistry, router, progressHoldS = 20, maxSessionsPerGrant = 20, now = Date.now, serverVersion })` with `handle(req, res)`, `endSessionsForGrant(grantId)`, `sessionCount(grantId)`; `PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']`. Behaviour (§3.5): `Origin`, when present, must be `https://mcp.<domain>` (`403`); the bearer token is checked on every request (hash lookup, not expired, `aud` = resource, grant live), else `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.<domain>/.well-known/oauth-protected-resource/mcp"`; one JSON-RPC message per `POST` (a batch array is `400`); notifications and responses → `202`; `initialize` returns `Mcp-Session-Id` (128 random bits, hex) bound to the grant, at most 20 per grant (the oldest is closed when a 21st starts); later requests need that session and `MCP-Protocol-Version` (`404` for an unknown or foreign session, `400` for a missing or unsupported version); `DELETE /mcp` ends a session; `GET /mcp` → `405`; `tools/list` returns only what the token's scopes allow; `tools/call` without the tool's scope is a tool error `insufficient_scope` with `required`; `get_job` with `_meta.progressToken` and `Accept: text/event-stream` on a non-terminal job streams `notifications/progress { progressToken, progress: <log lines>, message: <status> }` and ends with the result at the first status change, the node going offline, or `progress_hold_s`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-mcp-http.test.js`:

```js
// tests/frontdoor-mcp-http.test.js — fleet stage 4 §3.5.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { McpHttpEndpoint } = require('../src/frontdoor/mcp/http-endpoint');
const { startFrontDoorHttp } = require('./helpers/frontdoor-harness');
const { request } = require('./helpers/oauth-test-client');
const { MCP_TOOLS } = require('../src/fleet/tool-definitions');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const running = [];
after(async () => { for (const h of running) await h.stop(); });

function fakeRouter() {
  const jobs = new EventEmitter();
  const state = { status: 'running', lines: 0 };
  return {
    jobs, state, calls: [],
    toolDefinitions: () => MCP_TOOLS,
    isTerminal: (s) => ['succeeded', 'failed', 'cancelled', 'denied', 'expired'].includes(s),
    async callTool(name, args, ctx) {
      this.calls.push([name, args, ctx.scopes]);
      if (name === 'get_job') return { job_id: args.job_id, status: state.status, output: { untrusted_output: true, lines: [] } };
      if (name === 'list_machines') return [{ name: 'web-01' }];
      return { ok: false, error: { code: 'machine_offline', message: 'machine_offline: web-01 is offline' } };
    },
    watchJob(jobId, onUpdate) {
      const fn = (u) => onUpdate(u);
      jobs.on(jobId, fn);
      return () => jobs.removeListener(jobId, fn);
    }
  };
}

async function start({ scopes = [{ scope: 'fleet:read', machines: null }], holdS = 1, now = Date.now } = {}) {
  const router = fakeRouter();
  const h = await startFrontDoorHttp({
    now,
    pendingPerIp: 10,
    mcp: ({ tokens, grants, scopeRegistry }) => new McpHttpEndpoint({ mcpHost: 'mcp.kl.example.com', resourceUrl: 'https://mcp.kl.example.com/mcp', tokens, grants, scopeRegistry, router, progressHoldS: holdS, now })
  });
  running.push(h);
  const r = await h.connect({ scopes });
  return { h, router, token: r.tokens.access_token, refresh: r.tokens.refresh_token, clientId: r.clientId, grantId: r.grantId };
}

const rpc = (t, message, { session = null, version = '2025-11-25', headers = {} } = {}) => request(t.h.base, {
  method: 'POST', path: '/mcp', json: message,
  headers: { authorization: `Bearer ${t.token}`, accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}), ...headers }
});

async function session(t, version = '2025-11-25') {
  const res = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { version: null });
  return { res, id: res.headers['mcp-session-id'] };
}

describe('the MCP endpoint', () => {
  it('initialize negotiates the version and binds a session to the grant', async () => {
    const t = await start();
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const { res, id } = await session(t, v);
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, v);
      assert.match(id, /^[0-9a-f]{32}$/);
    }
    const { res } = await session(t, '1999-01-01');
    assert.equal(res.json.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest');
  });

  it('401 with WWW-Authenticate for a missing, unknown or foreign-audience token; 403 for a foreign Origin', async () => {
    const t = await start();
    const noToken = await request(t.h.base, { method: 'POST', path: '/mcp', json: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers['www-authenticate'], 'Bearer error="invalid_token", resource_metadata="https://mcp.kl.example.com/.well-known/oauth-protected-resource/mcp"');
    const bad = await rpc({ ...t, token: 'kla_nope' }, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(bad.status, 401);
    const origin = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(origin.status, 403);
  });

  it('202 for notifications and responses; 400 for a batch; 405 for GET; sessions must be ours and need the version header', async () => {
    const t = await start();
    const { id } = await session(t);
    assert.equal((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session: id })).status, 202);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 9, result: {} }, { session: id })).status, 202);
    assert.equal((await rpc(t, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { session: id })).status, 400);
    assert.equal((await request(t.h.base, { method: 'GET', path: '/mcp', headers: { authorization: `Bearer ${t.token}` } })).status, 405);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: 'f'.repeat(32) })).status, 404);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: id, version: null })).status, 400);
    const other = await t.h.connect({ scopes: [{ scope: 'fleet:read', machines: null }] });
    const theirs = await session({ ...t, token: other.tokens.access_token });
    assert.equal(theirs.res.status, 200);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: theirs.id })).status, 404, "another grant's session on the same front door");
    assert.equal((await request(t.h.base, { method: 'DELETE', path: '/mcp', headers: { authorization: `Bearer ${t.token}`, 'mcp-session-id': id } })).status, 204);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 2, method: 'ping' }, { session: id })).status, 404);
  });

  it('tools/list follows the scopes; a call without its scope is insufficient_scope', async () => {
    const t = await start();
    const { id } = await session(t);
    const list = await rpc(t, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { session: id });
    assert.deepEqual(list.json.result.tools.map((x) => x.name).sort(), ['describe_machine', 'get_job', 'get_job_logs', 'get_state', 'list_machines']);
    const call = await rpc(t, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.status' } } }, { session: id });
    assert.equal(call.json.result.isError, true);
    assert.deepEqual(JSON.parse(call.json.result.content[0].text), { error: 'insufficient_scope', message: 'insufficient_scope: this client was not granted fleet:run', required: 'fleet:run' });
    assert.equal(t.router.calls.length, 0, 'nothing reached the router');
    const ok = await rpc(t, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_machines', arguments: {} } }, { session: id });
    assert.deepEqual(JSON.parse(ok.json.result.content[0].text), [{ name: 'web-01' }]);
  });

  it('a router refusal comes back as a tool error', async () => {
    const t = await start({ scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: null }] });
    const { id } = await session(t);
    const r = await rpc(t, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.status' } } }, { session: id });
    assert.equal(r.json.result.isError, true);
    assert.equal(JSON.parse(r.json.result.content[0].text).error, 'machine_offline');
  });

  it('long-poll get_job streams progress over SSE and returns at the first status change', async () => {
    const t = await start({ holdS: 5 });
    const { id } = await session(t);
    const pending = rpc(t, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-1' }, _meta: { progressToken: 'p1' } } }, { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-1', { status: 'running', log_lines: 3 });
    t.router.state.status = 'succeeded';
    t.router.jobs.emit('web-01:job-1', { status: 'succeeded', log_lines: 5 });
    const res = await pending;
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    const events = res.text.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^event: message\ndata: /, '')));
    assert.deepEqual(events[0], { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 3, message: 'running' } });
    assert.equal(events.at(-1).id, 7);
    assert.equal(JSON.parse(events.at(-1).result.content[0].text).status, 'succeeded');
  });

  it('long-poll ends at the hold even without a change, and when the node goes offline', async () => {
    const t = await start({ holdS: 1 });
    const { id } = await session(t);
    const started = Date.now();
    const res = await rpc(t, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-2' }, _meta: { progressToken: 'p2' } } }, { session: id });
    assert.ok(Date.now() - started >= 900);
    assert.match(res.text, /"id":8/);
    const off = rpc(t, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-3' }, _meta: { progressToken: 'p3' } } }, { session: id });
    await new Promise((r) => setTimeout(r, 100));
    t.router.jobs.emit('web-01:job-3', { status: 'running', log_lines: 0, offline: true });
    const offRes = await off;
    assert.match(offRes.text, /"id":9/);
  });

  it('an expired token mid-job: 401, refresh, get_job on the same job id succeeds (§10 condition 3)', async () => {
    let now = Date.now();
    const t = await start({ now: () => now });
    const { id } = await session(t);
    now += 3600001;
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 10, method: 'ping' }, { session: id })).status, 401);
    const refreshed = await request(t.h.base, { method: 'POST', path: '/oauth/token', form: { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId } });
    assert.equal(refreshed.status, 200);
    const again = await rpc({ ...t, token: refreshed.json.access_token }, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_job', arguments: { job_id: 'web-01:job-1' } } }, { session: id });
    assert.equal(JSON.parse(again.json.result.content[0].text).job_id, 'web-01:job-1');
  });

  it('revoking the grant ends its sessions at once', async () => {
    const t = await start();
    const { id } = await session(t);
    const { body: { challenge } } = await t.h.phoneCall(t.h.phone, 'POST', '/v1/challenges');
    await t.h.phoneCall(t.h.phone, 'POST', `/v1/clients/${t.grantId}/revoke`, t.h.phone.revokeClient({ frontdoorId: t.h.fd.nodeId, grantId: t.grantId, challenge }));
    assert.deepEqual(t.h.revokedGrants, [t.grantId]);
    assert.equal(t.h.mcp.sessionCount(t.grantId), 0);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 12, method: 'ping' }, { session: id })).status, 401);
  });

  it('at most 20 sessions per grant: the oldest closes', async () => {
    const t = await start();
    const first = await session(t);
    for (let i = 0; i < 20; i += 1) await session(t);
    assert.equal(t.h.mcp.sessionCount(t.grantId), 20);
    assert.equal((await rpc(t, { jsonrpc: '2.0', id: 13, method: 'ping' }, { session: first.id })).status, 404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-mcp-http.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/mcp/http-endpoint'`.

- [ ] **Step 3: Write `src/frontdoor/mcp/http-endpoint.js`**

```js
// MCP Streamable HTTP on https://mcp.<domain>/mcp (fleet stage 4 §3.5),
// written by hand: the repo has no MCP SDK. Every request is authenticated
// by its bearer token (opaque, looked up each time, so revocation is
// immediate); sessions are bound to the grant; tools are filtered by scope.
const crypto = require('crypto');
const { createLogger } = require('../../logging');
const { parseScope } = require('../../fleet/scope-rules');
const { readBody, sendJson, requestHost } = require('../http-util');

const log = createLogger('frontdoor/mcp');
const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const BODY_LIMIT = 256 * 1024;

function names(scopes) {
  const out = new Set();
  for (const s of scopes || []) {
    try {
      out.add(parseScope(s).scope);
    } catch {
      // a scope string that does not parse grants nothing
    }
  }
  return out;
}

class McpHttpEndpoint {
  constructor({ mcpHost, resourceUrl, tokens, grants, scopeRegistry, router, progressHoldS = 20, maxSessionsPerGrant = 20, now = Date.now, serverVersion = null } = {}) {
    this.mcpHost = mcpHost;
    this.origin = `https://${mcpHost}`;
    this.resourceUrl = resourceUrl;
    this.metadataUrl = `${this.origin}/.well-known/oauth-protected-resource/mcp`;
    this.tokens = tokens;
    this.grants = grants;
    this.scopeRegistry = scopeRegistry;
    this.router = router;
    this.holdMs = progressHoldS * 1000;
    this.maxSessionsPerGrant = maxSessionsPerGrant;
    this.now = now;
    this.serverVersion = serverVersion || require('../../../package.json').version;
    this.sessions = new Map();
  }

  sessionCount(grantId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.grantId === grantId) n += 1;
    return n;
  }

  endSessionsForGrant(grantId) {
    for (const [id, s] of this.sessions) if (s.grantId === grantId) this.sessions.delete(id);
  }

  _unauthorized(res) {
    sendJson(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${this.metadataUrl}"` });
  }

  _auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const token = this.tokens.authenticate(m[1], { aud: this.resourceUrl });
    if (!token) return null;
    const grant = this.grants.live(token.grant_id);
    if (!grant) return null;
    return { token, grant };
  }

  async handle(req, res) {
    if (requestHost(req) !== this.mcpHost) {
      sendJson(res, 421, { error: 'misdirected_request' });
      return;
    }
    // DNS rebinding: a browser page elsewhere must not drive this endpoint.
    if (req.headers.origin !== undefined && req.headers.origin !== this.origin) {
      sendJson(res, 403, { error: 'forbidden', error_description: 'foreign Origin' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST, DELETE' });
      return;
    }
    const auth = this._auth(req);
    if (!auth) {
      this._unauthorized(res);
      return;
    }
    this.grants.touch(auth.grant.grant_id);
    if (req.method === 'DELETE') {
      const s = this.sessions.get(String(req.headers['mcp-session-id'] || ''));
      if (!s || s.grantId !== auth.grant.grant_id) {
        sendJson(res, 404, { error: 'unknown_session' });
        return;
      }
      this.sessions.delete(s.id);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST, DELETE' });
      return;
    }
    let message;
    try {
      message = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8'));
    } catch (err) {
      if (err && err.status === 413) sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: err.message } });
      else sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per request' } });
      return;
    }
    // Notifications and responses the client posts are acknowledged only.
    if (message.method === undefined || message.id === undefined || message.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === 'initialize') {
      this._initialize(res, message, auth);
      return;
    }
    const session = this.sessions.get(String(req.headers['mcp-session-id'] || ''));
    if (!session || session.grantId !== auth.grant.grant_id) {
      sendJson(res, 404, { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'unknown session; initialize again' } });
      return;
    }
    const version = req.headers['mcp-protocol-version'];
    if (!PROTOCOL_VERSIONS.includes(version)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: `MCP-Protocol-Version must be one of ${PROTOCOL_VERSIONS.join(', ')}` } });
      return;
    }
    session.lastUsed = this.now();
    const scopes = auth.token.scopes;
    if (message.method === 'ping') return this._reply(res, message.id, {});
    if (message.method === 'tools/list') return this._reply(res, message.id, { tools: this._tools(scopes) });
    if (message.method === 'tools/call') return this._call(req, res, message, { grant: auth.grant, scopes, session: session.id });
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    return undefined;
  }

  _reply(res, id, result) {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  }

  _initialize(res, message, auth) {
    const asked = message.params && message.params.protocolVersion;
    const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const mine = [...this.sessions.values()].filter((s) => s.grantId === auth.grant.grant_id).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= this.maxSessionsPerGrant) this.sessions.delete(mine.shift().id);
    const id = crypto.randomBytes(16).toString('hex');
    this.sessions.set(id, { id, grantId: auth.grant.grant_id, version, createdAt: this.now(), lastUsed: this.now() });
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'king-louie-frontdoor', version: this.serverVersion } }
    }, { 'mcp-session-id': id });
  }

  _tools(scopes) {
    const allowed = this.scopeRegistry.toolsFor([...names(scopes)]);
    return this.router.toolDefinitions().filter((t) => allowed.has(t.name));
  }

  _toolResult(result) {
    const refused = result && result.ok === false && result.error;
    const body = refused ? { error: result.error.code, message: result.error.message, ...Object.fromEntries(Object.entries(result.error).filter(([k]) => !['code', 'message'].includes(k))) } : result;
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], ...(refused ? { isError: true } : {}) };
  }

  async _call(req, res, message, ctx) {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    const required = this.scopeRegistry.requiredScopeFor(name);
    if (!required || !names(ctx.scopes).has(required)) {
      return this._reply(res, message.id, this._toolResult({ ok: false, error: { code: 'insufficient_scope', message: `insufficient_scope: this client was not granted ${required || 'a scope for this tool'}`, required } }));
    }
    const progressToken = message.params && message.params._meta && message.params._meta.progressToken;
    const wantsStream = /text\/event-stream/.test(String(req.headers.accept || ''));
    let first;
    try {
      first = await this.router.callTool(name, args, ctx);
    } catch (err) {
      log.warn(`tools/call ${name} failed: ${err.message}`);
      return this._reply(res, message.id, this._toolResult({ ok: false, error: { code: 'error', message: err.message } }));
    }
    if (name !== 'get_job' || progressToken === undefined || !wantsStream || !first || first.ok === false || this.router.isTerminal(first.status)) {
      return this._reply(res, message.id, this._toolResult(first));
    }
    return this._stream(req, res, message, ctx, args, progressToken, first.status);
  }

  _stream(req, res, message, ctx, args, progressToken, initialStatus) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (obj) => res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
    let done = false;
    let unsubscribe = () => {};
    const finish = async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      let result;
      try {
        result = await this.router.callTool('get_job', args, ctx);
      } catch (err) {
        result = { ok: false, error: { code: 'error', message: err.message } };
      }
      send({ jsonrpc: '2.0', id: message.id, result: this._toolResult(result) });
      res.end();
    };
    const timer = setTimeout(finish, this.holdMs);
    unsubscribe = this.router.watchJob(args.job_id, (u) => {
      if (done) return;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: u.log_lines, message: u.status } });
      if (u.offline || u.status !== initialStatus) finish();
    });
    req.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
    });
  }
}

module.exports = { McpHttpEndpoint, PROTOCOL_VERSIONS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/frontdoor-mcp-http.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/frontdoor/mcp/http-endpoint.js tests/frontdoor-mcp-http.test.js
git commit -m "feat(frontdoor): MCP Streamable HTTP endpoint with scope-filtered tools and long-poll progress" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 5

Part 4 leaves the front door's OAuth 2.1 server (metadata, registration and metadata documents, the typed-code consent, phone-signed grants, opaque rotating tokens, revocation) and its MCP Streamable HTTP endpoint behind one `mcp.` handler, all exercised end to end over plain HTTP by `tests/helpers/frontdoor-harness.js`. Part 5 (`docs/superpowers/plans/2026-09-23-fleet-stage4-front-door-part5.md`) adds the router and job cache the endpoint calls, node pairing, the audit mirror, the self-probe and `doctor`, then assembles `profile: frontdoor`, its CLI and its deployment guide.
