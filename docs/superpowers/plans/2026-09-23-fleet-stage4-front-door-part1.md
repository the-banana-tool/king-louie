# Fleet Stage 4: Front door — Implementation Plan (Part 1 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the protocol and transport foundations of the front door: the `client-grant-v1` messages, checks, vectors and document; the scope rules; the `frontdoor`/`delegate` configuration and profile; and the hardened mesh (auth before parse, channel binding, pinned client certificates, `attachServer`, `connectPinned`).

**Architecture:** Pure, Electron-free modules under `src/frontdoor/protocol/`, `src/fleet/scope-rules.js`, `src/frontdoor/oauth/scopes.js` and `src/frontdoor/config.js`, plus additive edits to `src/service/{node-config,config}.js` and `src/mesh/{mesh-transport,mesh-pairing,index}.js` and `src/approvals/link-rpc.js`. Nothing is started by a service yet. The six parts run in order, each on the previous part's commits on `feat/fleet-stage4`: Part 1 foundations (Tasks 1–7); Part 2 the node fleet host (Tasks 8–14); Part 3 front-door transport, TLS and registry (Tasks 15–20); Part 4 OAuth and MCP (Tasks 21–26); Part 5 router, pairing, mirror, profile, CLI and docs (Tasks 27–34); Part 6 the mobile apps (Tasks 35–38).

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Node `crypto`/`tls`/`net`/`https`, `ws` (existing). No new npm dependency in this part.

**Spec:** `docs/superpowers/specs/2026-09-23-fleet-stage4-front-door.md`. **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. **F3 spec (bound):** `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md`.

**Before Task 1:** the worktree has no `node_modules`. Run `npm ci` once in `king-louie-wt/fleet-stage4`, then `npm test` and confirm `# fail 0` on the untouched branch, so any later failure is this plan's.

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

### Task 1: client-grant-v1 message shapes and builders

**Files:**
- Create: `src/frontdoor/protocol/messages.js`
- Test: `tests/frontdoor-protocol-messages.test.js`

**Interfaces:**
- Consumes: `registerMessageValidator`, `validateMessage`, `isTimestamp`, `iso`, `randomNonce`, `NONCE_RE`, `DEVICE_ID_RE`, `NODE_ID_RE` (`src/approvals/messages.js`); `seal`, `nodeSigner`, `fingerprintGroups`, `fromB64url`, `ed25519RawToSpki` (`src/approvals/envelope.js`).
- Produces (all from `src/frontdoor/protocol/messages.js`):
  - Regexes: `USER_CODE_RE`, `GRANT_ID_RE`, `PAIRING_ID_RE`, `DCR_CLIENT_ID_RE`, `CODE_CHALLENGE_RE`, `SPKI_PIN_RE`, `HEX_SHA256_RE`, `RAW_ED25519_RE`, `SCOPE_RE`, `MACHINE_NAME_RE`, `NODE_NAME_RE`, `DNS_NAME_RE`; constant `USER_CODE_ALPHABET`.
  - `isDnsName(v) → boolean`, `isClientId(v) → boolean`, `isScopeList(list) → boolean` (entries `{ scope, machines: null | string[] }`, sorted by `scope`, unique, machines sorted and unique).
  - `normalizeUserCode(text) → string | null`, `formatUserCode(code) → 'XXX-XXX'`, `randomUserCode() → string`.
  - `normalizePairingCode(text) → string`, `pairingCodeHash(code) → b64url`.
  - `rawEd25519(spkiDer: Buffer | hex) → b64url(32 bytes)`, `spkiHexFromRaw(b64url) → hex DER SPKI`, `nodeFingerprint(nodeId) → 'kl-xxxx xxxx xxxx xxxx'`.
  - Builders: `buildNodePair({ identity, frontdoorHost, code, profile, capabilities, tlsCertPem, nonce?, now? }) → envelope`, `buildNodePairAccept({ identity, pairingId, nodeId, nonce, meshUrl, meshCertFingerprint }) → envelope`, `buildRelayRepin({ identity, relay, oldSpki, newSpki, now? }) → envelope`.
  - Side effect on load: validators for `kl.client.grant`, `kl.client.revoke`, `kl.node.enroll`, `kl.node.remove`, `kl.node.pair`, `kl.node.pair.accept`, `kl.relay.repin` are registered with `registerMessageValidator`, so `validateMessage(type, message)` works for them anywhere after `require('./src/frontdoor/protocol/messages')`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-protocol-messages.test.js`:

```js
// tests/frontdoor-protocol-messages.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { validateMessage } = require('../src/approvals/messages');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { deriveNodeId } = require('../src/mesh/node-identity');
const P = require('../src/frontdoor/protocol/messages');
const { testNodeIdentity } = require('./helpers/fake-phone');

const NOW = '2026-09-23T18:04:11.201Z';
const nonce = () => crypto.randomBytes(32).toString('base64url');
const id22 = () => crypto.randomBytes(16).toString('base64url');

function grant(overrides = {}) {
  return {
    v: 1, type: 'kl.client.grant', frontdoor_id: 'kl-nt4ritcfj5kepq3y', grant_id: `gr_${id22()}`, client_id: `dcr_${id22()}`,
    client_name: 'Example Client', redirect_uri: 'https://client.example.com/cb', resource: 'https://mcp.kl.example.com/mcp',
    code_challenge: crypto.randomBytes(32).toString('base64url'), user_code: 'Q7KM2X',
    scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }],
    decision: 'approve', nonce: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW, ...overrides
  };
}

describe('user codes', () => {
  it('normalises what the owner types: case, dash, O→0, I/L→1', () => {
    assert.equal(P.normalizeUserCode('q7k-m2x'), 'Q7KM2X');
    assert.equal(P.normalizeUserCode(' o1l abc '), '011ABC');
    assert.equal(P.normalizeUserCode('Q7KM2'), null);
    assert.equal(P.normalizeUserCode('Q7KM2U'), null, 'U is not Crockford base32');
    assert.equal(P.normalizeUserCode(42), null);
  });

  it('formats as XXX-XXX and draws only from the Crockford alphabet', () => {
    assert.equal(P.formatUserCode('Q7KM2X'), 'Q7K-M2X');
    for (let i = 0; i < 200; i += 1) assert.match(P.randomUserCode(), P.USER_CODE_RE);
  });
});

describe('pairing codes', () => {
  it('trims, lower-cases and collapses spaces before hashing', () => {
    assert.equal(P.normalizePairingCode('  Abandon   ability\table '), 'abandon ability able');
    assert.equal(P.pairingCodeHash('Abandon ability'), P.pairingCodeHash(' abandon   ABILITY '));
    assert.match(P.pairingCodeHash('x'), /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('scope lists', () => {
  it('accepts sorted unique scopes with sorted unique machines', () => {
    assert.equal(P.isScopeList([{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }]), true);
    assert.equal(P.isScopeList([]), true);
  });

  it('refuses unsorted, duplicate, extra keys and bad machine names', () => {
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: null }, { scope: 'fleet:read', machines: null }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:read', machines: null }, { scope: 'fleet:read', machines: null }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: ['web-01', 'gpu-box'] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: ['Web-01'] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: [] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: null, extra: 1 }]), false);
    assert.equal(P.isScopeList([{ scope: 'FLEET', machines: null }]), false);
  });
});

describe('DNS names and client ids', () => {
  it('knows a DNS name from an IP or a single label', () => {
    assert.equal(P.isDnsName('kl.example.com'), true);
    assert.equal(P.isDnsName('example'), false);
    assert.equal(P.isDnsName('10.0.0.1'), false);
    assert.equal(P.isDnsName('KL.example.com'), false);
  });

  it('accepts dcr_ ids and https CIMD URLs only', () => {
    assert.equal(P.isClientId(`dcr_${id22()}`), true);
    assert.equal(P.isClientId('https://client.example.com/client.json'), true);
    assert.equal(P.isClientId('http://client.example.com/client.json'), false);
    assert.equal(P.isClientId('dcr_short'), false);
  });
});

describe('message validators', () => {
  it('kl.client.grant: approve needs scopes, deny needs none, no extra keys', () => {
    assert.equal(validateMessage('kl.client.grant', grant()), null);
    assert.equal(validateMessage('kl.client.grant', grant({ decision: 'deny', scopes: [] })), null);
    assert.equal(validateMessage('kl.client.grant', grant({ decision: 'deny' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ scopes: [] })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', { ...grant(), extra: true }), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ code_challenge: 'short' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ user_code: 'Q7K-M2X' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ v: 2 })), 'unsupported_version');
  });

  it('kl.client.revoke, kl.node.remove: a challenge, a device, a time', () => {
    const revoke = { v: 1, type: 'kl.client.revoke', frontdoor_id: 'kl-nt4ritcfj5kepq3y', grant_id: `gr_${id22()}`, challenge: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW };
    assert.equal(validateMessage('kl.client.revoke', revoke), null);
    assert.equal(validateMessage('kl.client.revoke', { ...revoke, challenge: 'x' }), 'malformed');
    const remove = { v: 1, type: 'kl.node.remove', frontdoor_id: 'kl-nt4ritcfj5kepq3y', node_id: 'kl-hnef32472qzibi5r', challenge: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW };
    assert.equal(validateMessage('kl.node.remove', remove), null);
  });

  it('kl.node.enroll: profile, raw key, hex fingerprint, replaces', () => {
    const node = testNodeIdentity({ key: 'gpu-box' });
    const enroll = {
      v: 1, type: 'kl.node.enroll', frontdoor_id: 'kl-nt4ritcfj5kepq3y', pairing_id: `pr_${id22()}`, node_id: node.nodeId,
      node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(node.publicKey), tls_fingerprint: 'a'.repeat(64),
      replaces: null, decision: 'approve', nonce: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW
    };
    assert.equal(validateMessage('kl.node.enroll', enroll), null);
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, replaces: 'kl-c2ubd6jjqumalzt5' }), null);
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, profile: 'frontdoor' }), 'malformed');
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, tls_fingerprint: 'A'.repeat(64) }), 'malformed');
  });
});

describe('node-side and front-door builders', () => {
  const certPem = require('../src/mesh/mesh-identity').MeshIdentity._generateFallbackTlsCert('gpu-box', 1).cert;

  it('buildNodePair signs with the node key over a code hash, never the code', () => {
    const node = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
    const env = P.buildNodePair({ identity: node, frontdoorHost: 'mcp.kl.example.com', code: 'Abandon  ability', profile: 'agent', capabilities: ['gpu', 'cuda', 'gpu'], tlsCertPem: certPem, now: Date.parse(NOW) });
    const { message } = open(env);
    assert.equal(validateMessage('kl.node.pair', message), null);
    assert.equal(env.kid, node.nodeId);
    assert.deepEqual(message.capabilities, ['cuda', 'gpu']);
    assert.equal(message.code_hash, P.pairingCodeHash('abandon ability'));
    assert.ok(!JSON.stringify(message).includes('abandon'));
    assert.equal(deriveNodeId(P.spkiHexFromRaw(message.public_key)), node.nodeId);
    assert.equal(verifyEd25519(env, P.spkiHexFromRaw(message.public_key)), true);
  });

  it('buildNodePairAccept and buildRelayRepin sign as the front door', () => {
    const fd = testNodeIdentity({ key: 'relay' });
    const accept = P.buildNodePairAccept({ identity: fd, pairingId: `pr_${id22()}`, nodeId: 'kl-hnef32472qzibi5r', nonce: nonce(), meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: 'b'.repeat(64) });
    assert.equal(validateMessage('kl.node.pair.accept', open(accept).message), null);
    assert.equal(open(accept).message.frontdoor_public_key, P.rawEd25519(fd.publicKey));
    const repin = P.buildRelayRepin({ identity: fd, relay: 'https://mcp.kl.example.com', oldSpki: `sha256/${nonce()}`, newSpki: `sha256/${nonce()}`, now: Date.parse(NOW) });
    assert.equal(validateMessage('kl.relay.repin', open(repin).message), null);
    assert.equal(verifyEd25519(repin, fd.publicKey.toString('hex')), true);
  });

  it('nodeFingerprint groups the node id in fours after kl-', () => {
    assert.equal(P.nodeFingerprint('kl-3v7q2m4k8d1x9c0a'), 'kl-3v7q 2m4k 8d1x 9c0a');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-protocol-messages.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/protocol/messages'`.

- [ ] **Step 3: Write the implementation**

Create `src/frontdoor/protocol/messages.js`:

```js
// client-grant-v1 message shapes (docs/protocol/client-grant-v1.md §3):
// phone-signed kl.client.grant, kl.client.revoke, kl.node.enroll,
// kl.node.remove; node-signed kl.node.pair; front-door-signed
// kl.node.pair.accept and kl.relay.repin. F3's approval-v1 shapes are not
// touched: these register through registerMessageValidator, so
// validateMessage() knows them once this module is loaded.
const crypto = require('crypto');
const net = require('net');
const { registerMessageValidator, isTimestamp, iso, randomNonce, NONCE_RE, DEVICE_ID_RE, NODE_ID_RE } = require('../../approvals/messages');
const { seal, nodeSigner, fingerprintGroups, fromB64url, ed25519RawToSpki } = require('../../approvals/envelope');

const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const GRANT_ID_RE = /^gr_[A-Za-z0-9_-]{22}$/;
const PAIRING_ID_RE = /^pr_[A-Za-z0-9_-]{22}$/;
const DCR_CLIENT_ID_RE = /^dcr_[A-Za-z0-9_-]{22}$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const SPKI_PIN_RE = /^sha256\/[A-Za-z0-9_-]{43}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const RAW_ED25519_RE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;
const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CAPABILITY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NODE_PROFILES = ['agent', 'runbook'];
const MAX_SCOPES = 32;
const MAX_MACHINES = 64;
const MAX_CAPABILITIES = 32;
const CLIENT_NAME_MAX = 200;
const URI_MAX = 2048;
const CLIENT_ID_MAX = 512;
const CERT_PEM_MAX = 8192;
const ED25519_SPKI_LENGTH = 44;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';

function hasExactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

// Code points, not UTF-16 units.
function withinLength(text, max, min = 0) {
  if (!isString(text)) return false;
  const n = Array.from(text).length;
  return n >= min && n <= max;
}

// Strictly increasing strings (so sorted and unique), each passing `test`.
function isSortedUnique(list, test, max, min = 0) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return false;
  for (let i = 0; i < list.length; i += 1) {
    if (!isString(list[i]) || !test(list[i])) return false;
    if (i > 0 && !(list[i - 1] < list[i])) return false;
  }
  return true;
}

function isScopeList(list) {
  if (!Array.isArray(list) || list.length > MAX_SCOPES) return false;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!isPlainObject(e) || !hasExactKeys(e, ['scope', 'machines']) || !isString(e.scope) || !SCOPE_RE.test(e.scope)) return false;
    if (i > 0 && !(list[i - 1].scope < e.scope)) return false;
    if (e.machines !== null && !isSortedUnique(e.machines, (n) => MACHINE_NAME_RE.test(n), MAX_MACHINES, 1)) return false;
  }
  return true;
}

function isDnsName(v) {
  return isString(v) && DNS_NAME_RE.test(v) && net.isIP(v) === 0;
}

function isHttpsUrl(v, max) {
  if (!isString(v) || v.length === 0 || v.length > max) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function isClientId(v) {
  return isString(v) && (DCR_CLIENT_ID_RE.test(v) || isHttpsUrl(v, CLIENT_ID_MAX));
}

const isUri = (v) => isString(v) && v.length > 0 && v.length <= URI_MAX;
const nullOr = (test) => (v) => v === null || test(v);

// ── Codes ───────────────────────────────────────────────────────────────────

// What the owner typed on the phone, as the grant carries it: upper case, no
// dash or spaces, O→0 and I/L→1. null when it is not six Crockford characters.
function normalizeUserCode(text) {
  if (!isString(text)) return null;
  const s = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return USER_CODE_RE.test(s) ? s : null;
}

function formatUserCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function randomUserCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  return out;
}

// A pairing code (6 words) as both ends hash it: trimmed, lower case, one
// space between words (§4.4).
function normalizePairingCode(text) {
  return String(text === undefined || text === null ? '' : text).trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function pairingCodeHash(code) {
  return crypto.createHash('sha256').update(normalizePairingCode(code), 'utf8').digest('base64url');
}

// ── Keys and fingerprints ───────────────────────────────────────────────────

function rawEd25519(spkiDer) {
  const der = Buffer.isBuffer(spkiDer) ? spkiDer : Buffer.from(String(spkiDer), 'hex');
  if (der.length !== ED25519_SPKI_LENGTH) throw new TypeError('rawEd25519 needs a DER SPKI Ed25519 key');
  return der.subarray(ED25519_SPKI_LENGTH - 32).toString('base64url');
}

function spkiHexFromRaw(raw) {
  return ed25519RawToSpki(fromB64url(raw)).toString('hex');
}

// 'kl-3v7q2m4k8d1x9c0a' → 'kl-3v7q 2m4k 8d1x 9c0a' (§3.11 step 1).
function nodeFingerprint(nodeId) {
  return `kl-${fingerprintGroups(nodeId)}`;
}

// ── Validators ──────────────────────────────────────────────────────────────

const VALIDATORS = {
  'kl.client.grant': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'grant_id', 'client_id', 'client_name', 'redirect_uri', 'resource',
    'code_challenge', 'user_code', 'scopes', 'decision', 'nonce', 'device_id', 'signed_at'])
    && NODE_ID_RE.test(m.frontdoor_id) && GRANT_ID_RE.test(m.grant_id) && isClientId(m.client_id)
    && withinLength(m.client_name, CLIENT_NAME_MAX) && isUri(m.redirect_uri) && isUri(m.resource)
    && isString(m.code_challenge) && CODE_CHALLENGE_RE.test(m.code_challenge) && isString(m.user_code) && USER_CODE_RE.test(m.user_code)
    && isScopeList(m.scopes) && ((m.decision === 'approve' && m.scopes.length > 0) || (m.decision === 'deny' && m.scopes.length === 0))
    && isString(m.nonce) && NONCE_RE.test(m.nonce) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.client.revoke': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'grant_id', 'challenge', 'device_id', 'signed_at'])
    && NODE_ID_RE.test(m.frontdoor_id) && GRANT_ID_RE.test(m.grant_id) && isString(m.challenge) && NONCE_RE.test(m.challenge)
    && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.node.enroll': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'pairing_id', 'node_id', 'node_name', 'profile', 'public_key',
    'tls_fingerprint', 'replaces', 'decision', 'nonce', 'device_id', 'signed_at'])
    && NODE_ID_RE.test(m.frontdoor_id) && PAIRING_ID_RE.test(m.pairing_id) && NODE_ID_RE.test(m.node_id) && isString(m.node_name)
    && NODE_NAME_RE.test(m.node_name) && NODE_PROFILES.includes(m.profile) && isString(m.public_key) && RAW_ED25519_RE.test(m.public_key)
    && isString(m.tls_fingerprint) && HEX_SHA256_RE.test(m.tls_fingerprint) && nullOr((v) => NODE_ID_RE.test(v))(m.replaces)
    && (m.decision === 'approve' || m.decision === 'deny') && isString(m.nonce) && NONCE_RE.test(m.nonce)
    && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.node.remove': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'node_id', 'challenge', 'device_id', 'signed_at'])
    && NODE_ID_RE.test(m.frontdoor_id) && NODE_ID_RE.test(m.node_id) && isString(m.challenge) && NONCE_RE.test(m.challenge)
    && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.node.pair': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_host', 'code_hash', 'node_id', 'node_name', 'profile', 'capabilities',
    'public_key', 'tls_cert', 'nonce', 'created_at'])
    && isDnsName(m.frontdoor_host) && isString(m.code_hash) && NONCE_RE.test(m.code_hash) && NODE_ID_RE.test(m.node_id)
    && isString(m.node_name) && NODE_NAME_RE.test(m.node_name) && NODE_PROFILES.includes(m.profile)
    && isSortedUnique(m.capabilities, (c) => CAPABILITY_RE.test(c), MAX_CAPABILITIES)
    && isString(m.public_key) && RAW_ED25519_RE.test(m.public_key)
    && isString(m.tls_cert) && m.tls_cert.length <= CERT_PEM_MAX && m.tls_cert.startsWith('-----BEGIN CERTIFICATE-----')
    && isString(m.nonce) && NONCE_RE.test(m.nonce) && isTimestamp(m.created_at),
  'kl.node.pair.accept': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'pairing_id', 'node_id', 'nonce', 'mesh_url',
    'mesh_cert_fingerprint', 'frontdoor_public_key'])
    && NODE_ID_RE.test(m.frontdoor_id) && PAIRING_ID_RE.test(m.pairing_id) && NODE_ID_RE.test(m.node_id)
    && isString(m.nonce) && NONCE_RE.test(m.nonce) && isString(m.mesh_url) && m.mesh_url.startsWith('wss://') && m.mesh_url.length <= 512
    && isString(m.mesh_cert_fingerprint) && HEX_SHA256_RE.test(m.mesh_cert_fingerprint)
    && isString(m.frontdoor_public_key) && RAW_ED25519_RE.test(m.frontdoor_public_key),
  'kl.relay.repin': (m) => hasExactKeys(m, ['v', 'type', 'frontdoor_id', 'relay', 'old_spki', 'new_spki', 'created_at'])
    && NODE_ID_RE.test(m.frontdoor_id) && isHttpsUrl(m.relay, URI_MAX) && isString(m.old_spki) && SPKI_PIN_RE.test(m.old_spki)
    && isString(m.new_spki) && SPKI_PIN_RE.test(m.new_spki) && isTimestamp(m.created_at)
};

for (const [type, validator] of Object.entries(VALIDATORS)) registerMessageValidator(type, validator);

// ── Builders (node and front door; the phone builds its own, §5) ───────────

function buildNodePair({ identity, frontdoorHost, code, profile, capabilities = [], tlsCertPem, nonce = null, now = Date.now() }) {
  return seal({
    v: 1,
    type: 'kl.node.pair',
    frontdoor_host: frontdoorHost,
    code_hash: pairingCodeHash(code),
    node_id: identity.nodeId,
    node_name: identity.nodeName,
    profile,
    capabilities: [...new Set((capabilities || []).map(String))].sort(),
    public_key: rawEd25519(identity.publicKey),
    tls_cert: tlsCertPem,
    nonce: nonce || randomNonce(),
    created_at: iso(now)
  }, nodeSigner(identity));
}

function buildNodePairAccept({ identity, pairingId, nodeId, nonce, meshUrl, meshCertFingerprint }) {
  return seal({
    v: 1,
    type: 'kl.node.pair.accept',
    frontdoor_id: identity.nodeId,
    pairing_id: pairingId,
    node_id: nodeId,
    nonce,
    mesh_url: meshUrl,
    mesh_cert_fingerprint: meshCertFingerprint,
    frontdoor_public_key: rawEd25519(identity.publicKey)
  }, nodeSigner(identity));
}

function buildRelayRepin({ identity, relay, oldSpki, newSpki, now = Date.now() }) {
  return seal({ v: 1, type: 'kl.relay.repin', frontdoor_id: identity.nodeId, relay, old_spki: oldSpki, new_spki: newSpki, created_at: iso(now) }, nodeSigner(identity));
}

module.exports = {
  USER_CODE_ALPHABET,
  USER_CODE_RE,
  GRANT_ID_RE,
  PAIRING_ID_RE,
  DCR_CLIENT_ID_RE,
  CODE_CHALLENGE_RE,
  SPKI_PIN_RE,
  HEX_SHA256_RE,
  RAW_ED25519_RE,
  SCOPE_RE,
  MACHINE_NAME_RE,
  NODE_NAME_RE,
  DNS_NAME_RE,
  isDnsName,
  isClientId,
  isScopeList,
  normalizeUserCode,
  formatUserCode,
  randomUserCode,
  normalizePairingCode,
  pairingCodeHash,
  rawEd25519,
  spkiHexFromRaw,
  nodeFingerprint,
  buildNodePair,
  buildNodePairAccept,
  buildRelayRepin
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/frontdoor-protocol-messages.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add src/frontdoor/protocol/messages.js tests/frontdoor-protocol-messages.test.js
git commit -m "feat(frontdoor): client-grant-v1 message shapes and builders" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Front-door acceptance checks, challenges and the fake phone's new messages

**Files:**
- Create: `src/frontdoor/protocol/checks.js`
- Create: `src/frontdoor/protocol/challenges.js`
- Modify: `tests/helpers/fake-phone.js` (add four methods inside the `phone` object, after `signApi`)
- Test: `tests/frontdoor-protocol-checks.test.js`

**Interfaces:**
- Consumes: Task 1's `spkiHexFromRaw`, validators; `open`, `verifyEs256`, `verifyEd25519`, `EnvelopeError`; `validateMessage`; `isTestDeviceKey` (`src/approvals/test-keys.js`); `deriveNodeId`; an `ApproverStore` (`get`, `isActive`, `allowTestKeys`).
- Produces (`src/frontdoor/protocol/checks.js`), every check returns `{ ok: true, reason: null, message, … } | { ok: false, reason }`:
  - `FLEET_SCOPE_RULES = { supported: string[], requires: { [scope]: string[] } }` (the four fleet scopes; `fleet:unsafe` requires one of `fleet:run`, `fleet:delegate`).
  - `scopeProblem(names, rules) → null | 'invalid_scope'`.
  - `verifyPhoneEnvelope(envelope, { approverStore, type, frontdoorId, acceptedAt = null }) → { ok, reason, message, bytes, deviceId }`. With `acceptedAt` (a re-verify at load) a revoked device's envelope stays valid iff `accepted_at < revoked_at` (R25).
  - `checkGrantDecision(envelope, { approverStore, frontdoorId, pending, scopes = FLEET_SCOPE_RULES, now })`, where `pending = { grant_id, client_id, redirect_uri, resource, code_challenge, user_code, requested_scopes: string[], expires_at_ms, claimed_by: deviceId | null, nonces: Set }`. Reasons in order: envelope reasons, `unknown_request`, `not_claimant`, `expired`, `binding_mismatch`, `user_code_mismatch`, `replay`, `invalid_scope`.
  - `checkClientRevoke(envelope, { approverStore, frontdoorId, challenges })`, `checkNodeRemove(envelope, { approverStore, frontdoorId, challenges })`: extra reasons `unknown_challenge`, `challenge_expired`, `challenge_reused`.
  - `checkNodeEnroll(envelope, { approverStore, frontdoorId, pairing, now })`, `pairing = { pairing_id, node_id, node_name, profile, public_key, tls_fingerprint, replaces, expires_at_ms, nonces: Set }`: extra reasons `node_id_mismatch`, `unknown_pairing`, `expired`, `binding_mismatch`, `replay`.
  - `checkNodePair(envelope, { frontdoorHost }) → { ok, reason, message, publicKeySpkiHex, tlsFingerprint }`: reasons `malformed`, `node_id_mismatch`, `bad_signature`, `wrong_host`.
  - `verifyPairAccept(envelope, { nodeId, nonce }) → { ok, reason, message, frontdoorId, frontdoorSpkiHex }`: reasons `malformed`, `wrong_frontdoor`, `bad_signature`, `wrong_node`, `nonce_mismatch`.
  - `verifyRepin(envelope, { frontdoorId, frontdoorPublicKey, receivedSpki, currentPin })`: reasons `malformed`, `wrong_frontdoor`, `bad_signature`, `spki_mismatch`, `old_pin_mismatch` (the Node port of the app's re-pin rule, §3.3.1).
- Produces (`src/frontdoor/protocol/challenges.js`): `class Challenges({ now = Date.now, ttlMs = 120000, perDevice = 20, entries = [] })` with `issue(deviceId) → { challenge, expires_in_ms }` (throws `{ code: 'too_many_challenges' }` past 20 live), `take(deviceId, challenge) → 'ok' | 'unknown' | 'expired' | 'reused'`, `sweep()`. `entries` seeds `{ challenge, device_id, expires_at_ms, used }` (vectors).
- Produces (fake phone): `phone.grant({ frontdoorId, pending, decision = 'approve', scopes = null, nonce = null, signedAt, overrides })`, `phone.revokeClient({ frontdoorId, grantId, challenge, signedAt })`, `phone.enrollNode({ frontdoorId, pairing, decision = 'approve', nonce = null, signedAt, overrides })`, `phone.removeNode({ frontdoorId, nodeId, challenge, signedAt })` — each returns a sealed ES256 envelope.

- [ ] **Step 1: Extend the fake phone**

In `tests/helpers/fake-phone.js`, add inside the `phone` object, immediately after the `signApi(...) { … }` method (keep the comma before it):

```js
    // client-grant-v1 (fleet stage 4 §4.2–4.3). `pending` is the view the
    // front door returns from GET /v1/grants/pending plus its binding fields.
    grant({ frontdoorId, pending, decision = 'approve', scopes = null, nonce = null, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const chosen = decision === 'deny' ? [] : (scopes || [...pending.requested_scopes].sort().map((scope) => ({ scope, machines: null })));
      return seal({
        v: 1,
        type: 'kl.client.grant',
        frontdoor_id: frontdoorId,
        grant_id: pending.grant_id,
        client_id: pending.client_id,
        client_name: pending.client_name,
        redirect_uri: pending.redirect_uri,
        resource: pending.resource,
        code_challenge: pending.code_challenge,
        user_code: pending.user_code,
        scopes: chosen,
        decision,
        nonce: nonce || randomNonce(),
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    revokeClient({ frontdoorId, grantId, challenge, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.client.revoke', frontdoor_id: frontdoorId, grant_id: grantId, challenge, device_id: deviceId, signed_at: signedAt }, signer);
    },

    enrollNode({ frontdoorId, pairing, decision = 'approve', nonce = null, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      return seal({
        v: 1,
        type: 'kl.node.enroll',
        frontdoor_id: frontdoorId,
        pairing_id: pairing.pairing_id,
        node_id: pairing.node_id,
        node_name: pairing.node_name,
        profile: pairing.profile,
        public_key: pairing.public_key,
        tls_fingerprint: pairing.tls_fingerprint,
        replaces: pairing.replaces === undefined ? null : pairing.replaces,
        decision,
        nonce: nonce || randomNonce(),
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    removeNode({ frontdoorId, nodeId, challenge, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.node.remove', frontdoor_id: frontdoorId, node_id: nodeId, challenge, device_id: deviceId, signed_at: signedAt }, signer);
    },
```

- [ ] **Step 2: Write the failing test**

Create `tests/frontdoor-protocol-checks.test.js`:

```js
// tests/frontdoor-protocol-checks.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setLogLevel } = require('../src/logging');
const P = require('../src/frontdoor/protocol/messages');
const C = require('../src/frontdoor/protocol/checks');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { seal } = require('../src/approvals/envelope');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

setLogLevel('fatal');
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

const FD = testNodeIdentity({ key: 'relay' });
const NOW = Date.parse('2026-09-23T18:04:11.201Z');
const id22 = (label) => crypto.createHash('sha256').update(label).digest().subarray(0, 16).toString('base64url');
const A = createFakePhone({ seed: 'A' });
const B = createFakePhone({ seed: 'B' });
const C3 = createFakePhone({ seed: 'C' });

async function store({ revoked = [] } = {}) {
  const records = [A, B, C3].map((p) => p.approverRecord(revoked.includes(p) ? { revokedAt: '2026-09-20T00:00:00.000Z', revokedBy: 'console' } : {}));
  const s = await approverStoreWith(records, { allowTestKeys: true, now: () => NOW });
  stores.push(s);
  return s;
}

function pending(overrides = {}) {
  return {
    grant_id: `gr_${id22('g')}`, client_id: `dcr_${id22('c')}`, client_name: 'Example Client', redirect_uri: 'https://client.example.com/cb',
    resource: 'https://mcp.kl.example.com/mcp', code_challenge: crypto.createHash('sha256').update('v').digest('base64url'), user_code: 'Q7KM2X',
    requested_scopes: ['fleet:read', 'fleet:run'], expires_at_ms: NOW + 300000, claimed_by: A.deviceId, nonces: new Set(), ...overrides
  };
}

describe('checkGrantDecision', () => {
  it('accepts the claimant phone signing exactly the pending authorization', async () => {
    const s = await store();
    const p = pending();
    const r = C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.deviceId, A.deviceId);
  });

  it('refuses, in order: wrong front door, not the claimant, expired, changed binding, other code, nonce reuse, scopes', async () => {
    const s = await store();
    const p = pending();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: 'kl-c2ubd6jjqumalzt5', pending: p }), opts).reason, 'wrong_frontdoor');
    assert.equal(C.checkGrantDecision(C3.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'not_claimant');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p }), { ...opts, now: NOW + 300001 }).reason, 'expired');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, redirect_uri: 'https://evil.example.com/cb' } }), opts).reason, 'binding_mismatch');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: { ...p, user_code: 'ABCDEF' } }), opts).reason, 'user_code_mismatch');
    const n = crypto.randomBytes(32).toString('base64url');
    assert.equal(C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p, nonce: n }), { ...opts, pending: { ...p, nonces: new Set([n]) } }).reason, 'replay');
    const widened = A.grant({ frontdoorId: FD.nodeId, pending: p, scopes: [{ scope: 'fleet:delegate', machines: null }] });
    assert.equal(C.checkGrantDecision(widened, opts).reason, 'invalid_scope');
    const q = pending({ requested_scopes: ['fleet:read', 'fleet:unsafe'] });
    const unsafeOnly = A.grant({ frontdoorId: FD.nodeId, pending: q, scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:unsafe', machines: null }] });
    assert.equal(C.checkGrantDecision(unsafeOnly, { ...opts, pending: q }).reason, 'invalid_scope');
  });

  it('refuses revoked and unknown devices, and never judges signed_at', async () => {
    const s = await store({ revoked: [B] });
    const p = pending({ claimed_by: null });
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW };
    assert.equal(C.checkGrantDecision(B.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'revoked_device');
    const stranger = createFakePhone();
    assert.equal(C.checkGrantDecision(stranger.grant({ frontdoorId: FD.nodeId, pending: p }), opts).reason, 'unknown_device');
    const ahead = A.grant({ frontdoorId: FD.nodeId, pending: p, signedAt: new Date(NOW + 86400000).toISOString() });
    assert.equal(C.checkGrantDecision(ahead, opts).ok, true);
  });

  it('a deny needs no scopes and is accepted as a decision', async () => {
    const s = await store();
    const p = pending();
    const r = C.checkGrantDecision(A.grant({ frontdoorId: FD.nodeId, pending: p, decision: 'deny' }), { approverStore: s, frontdoorId: FD.nodeId, pending: p, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.message.decision, 'deny');
  });
});

describe('verifyPhoneEnvelope at load (R25)', () => {
  it('keeps an envelope accepted before the device was revoked, drops one accepted after', async () => {
    const s = await store({ revoked: [B] });
    const env = B.revokeClient({ frontdoorId: FD.nodeId, grantId: `gr_${id22('x')}`, challenge: crypto.randomBytes(32).toString('base64url') });
    const opts = { approverStore: s, type: 'kl.client.revoke', frontdoorId: FD.nodeId };
    assert.equal(C.verifyPhoneEnvelope(env, opts).reason, 'revoked_device');
    assert.equal(C.verifyPhoneEnvelope(env, { ...opts, acceptedAt: '2026-09-19T00:00:00.000Z' }).ok, true);
    assert.equal(C.verifyPhoneEnvelope(env, { ...opts, acceptedAt: '2026-09-21T00:00:00.000Z' }).reason, 'revoked_device');
  });
});

describe('Challenges and revocations', () => {
  it('a challenge works once, for its device, within 2 minutes', () => {
    let now = NOW;
    const ch = new Challenges({ now: () => now });
    const { challenge, expires_in_ms: ttl } = ch.issue(A.deviceId);
    assert.equal(ttl, 120000);
    assert.equal(ch.take(B.deviceId, challenge), 'unknown');
    assert.equal(ch.take(A.deviceId, challenge), 'ok');
    assert.equal(ch.take(A.deviceId, challenge), 'reused');
    const late = ch.issue(A.deviceId).challenge;
    now += 120001;
    assert.equal(ch.take(A.deviceId, late), 'expired');
  });

  it('at most 20 live challenges per device', () => {
    const ch = new Challenges({ now: () => NOW });
    for (let i = 0; i < 20; i += 1) ch.issue(A.deviceId);
    assert.throws(() => ch.issue(A.deviceId), (err) => err.code === 'too_many_challenges');
    ch.issue(B.deviceId);
  });

  it('checkClientRevoke and checkNodeRemove consume the challenge', async () => {
    const s = await store();
    const ch = new Challenges({ now: () => NOW });
    const { challenge } = ch.issue(A.deviceId);
    const env = A.revokeClient({ frontdoorId: FD.nodeId, grantId: `gr_${id22('g')}`, challenge });
    assert.equal(C.checkClientRevoke(env, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).ok, true);
    assert.equal(C.checkClientRevoke(env, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).reason, 'challenge_reused');
    const second = ch.issue(A.deviceId).challenge;
    const rm = A.removeNode({ frontdoorId: FD.nodeId, nodeId: 'kl-hnef32472qzibi5r', challenge: second });
    assert.equal(C.checkNodeRemove(rm, { approverStore: s, frontdoorId: FD.nodeId, challenges: ch }).ok, true);
  });
});

describe('node enrollment and pairing', () => {
  const gpu = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
  const pairing = () => ({
    pairing_id: `pr_${id22('p')}`, node_id: gpu.nodeId, node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(gpu.publicKey),
    tls_fingerprint: 'c'.repeat(64), replaces: null, expires_at_ms: NOW + 600000, nonces: new Set()
  });

  it('checkNodeEnroll: derived id, the pending pairing, its expiry and binding', async () => {
    const s = await store();
    const pr = pairing();
    const opts = { approverStore: s, frontdoorId: FD.nodeId, pairing: pr, now: NOW };
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr }), opts).ok, true);
    const wrongId = A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, node_id: 'kl-c2ubd6jjqumalzt5' } });
    assert.equal(C.checkNodeEnroll(wrongId, opts).reason, 'node_id_mismatch');
    const otherPairing = A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, pairing_id: `pr_${id22('other')}` } });
    assert.equal(C.checkNodeEnroll(otherPairing, opts).reason, 'unknown_pairing');
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: pr }), { ...opts, now: NOW + 600001 }).reason, 'expired');
    assert.equal(C.checkNodeEnroll(A.enrollNode({ frontdoorId: FD.nodeId, pairing: { ...pr, profile: 'runbook' } }), opts).reason, 'binding_mismatch');
  });

  it('checkNodePair checks the node signature, derived id and host; verifyPairAccept checks the front door', () => {
    const cert = require('../src/mesh/mesh-identity').MeshIdentity._generateFallbackTlsCert('gpu-box', 1).cert;
    const env = P.buildNodePair({ identity: gpu, frontdoorHost: 'mcp.kl.example.com', code: 'a b c d e f', profile: 'agent', tlsCertPem: cert });
    const ok = C.checkNodePair(env, { frontdoorHost: 'mcp.kl.example.com' });
    assert.equal(ok.ok, true, ok.reason);
    assert.match(ok.tlsFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(C.checkNodePair(env, { frontdoorHost: 'mcp.other.example.com' }).reason, 'wrong_host');
    const tampered = { ...env, sig: Buffer.from(env.sig, 'base64url').map((b, i) => (i === 0 ? b ^ 1 : b)).toString('base64url') };
    assert.equal(C.checkNodePair(tampered, { frontdoorHost: 'mcp.kl.example.com' }).reason, 'bad_signature');

    const nonce = crypto.randomBytes(32).toString('base64url');
    const accept = P.buildNodePairAccept({ identity: FD, pairingId: `pr_${id22('p')}`, nodeId: gpu.nodeId, nonce, meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: 'd'.repeat(64) });
    const v = C.verifyPairAccept(accept, { nodeId: gpu.nodeId, nonce });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.frontdoorId, FD.nodeId);
    assert.equal(C.verifyPairAccept(accept, { nodeId: gpu.nodeId, nonce: crypto.randomBytes(32).toString('base64url') }).reason, 'nonce_mismatch');
    assert.equal(C.verifyPairAccept(accept, { nodeId: 'kl-c2ubd6jjqumalzt5', nonce }).reason, 'wrong_node');
  });

  it('verifyRepin: key, new SPKI equals what was received, old SPKI equals the current pin', () => {
    const oldSpki = `sha256/${crypto.randomBytes(32).toString('base64url')}`;
    const newSpki = `sha256/${crypto.randomBytes(32).toString('base64url')}`;
    const env = P.buildRelayRepin({ identity: FD, relay: 'https://mcp.kl.example.com', oldSpki, newSpki });
    const key = P.rawEd25519(FD.publicKey);
    const base = { frontdoorId: FD.nodeId, frontdoorPublicKey: key, receivedSpki: newSpki, currentPin: oldSpki };
    assert.equal(C.verifyRepin(env, base).ok, true);
    assert.equal(C.verifyRepin(env, { ...base, receivedSpki: oldSpki }).reason, 'spki_mismatch');
    assert.equal(C.verifyRepin(env, { ...base, currentPin: newSpki }).reason, 'old_pin_mismatch');
    const other = testNodeIdentity();
    assert.equal(C.verifyRepin(env, { ...base, frontdoorPublicKey: P.rawEd25519(other.publicKey) }).reason, 'bad_signature');
    const forged = seal({ ...require('../src/approvals/envelope').open(env).message }, other.signer);
    assert.equal(C.verifyRepin(forged, base).reason, 'wrong_frontdoor');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/frontdoor-protocol-checks.test.js`
Expected: FAIL with `Cannot find module '../src/frontdoor/protocol/checks'`.

- [ ] **Step 4: Write `src/frontdoor/protocol/challenges.js`**

```js
// Single-use challenges for phone-signed removals (§4.6): 32 random bytes,
// two minutes on the front door's clock, at most 20 live per device. A used
// challenge is remembered until it would have expired twice over, so a
// replay says `reused` rather than `unknown`.
const crypto = require('crypto');
const { err } = require('../errors');

class Challenges {
  constructor({ now = Date.now, ttlMs = 120000, perDevice = 20, entries = [] } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.perDevice = perDevice;
    this.items = new Map();
    for (const e of entries) {
      this.items.set(e.challenge, { deviceId: e.device_id, expiresAt: e.expires_at_ms, used: e.used === true });
    }
  }

  sweep() {
    const t = this.now();
    for (const [c, e] of this.items) if (t > e.expiresAt + this.ttlMs) this.items.delete(c);
  }

  issue(deviceId) {
    this.sweep();
    const t = this.now();
    let live = 0;
    for (const e of this.items.values()) if (e.deviceId === deviceId && !e.used && t <= e.expiresAt) live += 1;
    if (live >= this.perDevice) throw err('too_many_challenges', `at most ${this.perDevice} live challenges per device`);
    const challenge = crypto.randomBytes(32).toString('base64url');
    this.items.set(challenge, { deviceId, expiresAt: t + this.ttlMs, used: false });
    return { challenge, expires_in_ms: this.ttlMs };
  }

  // 'ok' marks it used; everything else leaves it as it was.
  take(deviceId, challenge) {
    const e = this.items.get(challenge);
    if (!e || e.deviceId !== deviceId) return 'unknown';
    if (e.used) return 'reused';
    if (!(this.now() <= e.expiresAt)) return 'expired';
    e.used = true;
    return 'ok';
  }
}

module.exports = { Challenges };
```

- [ ] **Step 5: Write `src/frontdoor/protocol/checks.js`**

```js
// What the front door (and, for the front-door-signed messages, a node or a
// phone) checks before acting on a client-grant-v1 message
// (docs/protocol/client-grant-v1.md §4). Steps run in the order below and the
// first failure decides `reason`; the vectors pin that order. Acceptance
// never judges signed_at or created_at: freshness comes from a pending item
// or a challenge held on the verifier's own clock.
const crypto = require('crypto');
const { open, verifyEs256, verifyEd25519, EnvelopeError } = require('../../approvals/envelope');
const { validateMessage } = require('../../approvals/messages');
const { isTestDeviceKey } = require('../../approvals/test-keys');
const { deriveNodeId } = require('../../mesh/node-identity');
const { spkiHexFromRaw } = require('./messages');

const FLEET_SCOPE_RULES = Object.freeze({
  supported: Object.freeze(['fleet:delegate', 'fleet:read', 'fleet:run', 'fleet:unsafe']),
  requires: Object.freeze({ 'fleet:unsafe': Object.freeze(['fleet:run', 'fleet:delegate']) })
});

const fail = (reason) => ({ ok: false, reason });

function openTyped(envelope, type) {
  let opened;
  try {
    opened = open(envelope);
  } catch (e) {
    if (e instanceof EnvelopeError) return { error: 'malformed' };
    throw e;
  }
  const shape = validateMessage(type, opened.message);
  return shape ? { error: shape } : opened;
}

function scopeProblem(names, { supported, requires }) {
  for (const n of names) if (!supported.includes(n)) return 'invalid_scope';
  for (const n of names) {
    const anyOf = requires[n];
    if (anyOf && !anyOf.some((r) => names.includes(r))) return 'invalid_scope';
  }
  return null;
}

function verifyPhoneEnvelope(envelope, { approverStore, type, frontdoorId, acceptedAt = null }) {
  const opened = openTyped(envelope, type);
  if (opened.error) return fail(opened.error);
  const { message, bytes } = opened;
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device_id) return fail('malformed');
  const record = approverStore.get(envelope.kid);
  if (!record) return fail('unknown_device');
  if (record.platform === 'demo') return fail('demo_device');
  if (!approverStore.allowTestKeys && isTestDeviceKey(record.public_key)) return fail('test_key');
  if (acceptedAt === null) {
    if (!approverStore.isActive(envelope.kid)) return fail('revoked_device');
  } else if (record.revoked_at !== null && !(Date.parse(acceptedAt) < Date.parse(record.revoked_at))) {
    // R25: revoking a device ends what it signs from then on; what the
    // front door accepted before stays valid.
    return fail('revoked_device');
  }
  if (!verifyEs256(envelope, record.public_key)) return fail('bad_signature');
  if (message.frontdoor_id !== frontdoorId) return fail('wrong_frontdoor');
  return { ok: true, reason: null, message, bytes, deviceId: envelope.kid };
}

function checkGrantDecision(envelope, { approverStore, frontdoorId, pending, scopes = FLEET_SCOPE_RULES, now }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.client.grant', frontdoorId });
  if (!v.ok) return v;
  const m = v.message;
  if (!pending || m.grant_id !== pending.grant_id) return fail('unknown_request');
  if (pending.claimed_by && pending.claimed_by !== v.deviceId) return fail('not_claimant');
  if (!(now <= pending.expires_at_ms)) return fail('expired');
  if (m.client_id !== pending.client_id || m.redirect_uri !== pending.redirect_uri || m.resource !== pending.resource
    || m.code_challenge !== pending.code_challenge) return fail('binding_mismatch');
  if (m.user_code !== pending.user_code) return fail('user_code_mismatch');
  if (pending.nonces && pending.nonces.has(m.nonce)) return fail('replay');
  if (m.decision === 'approve') {
    const names = m.scopes.map((s) => s.scope);
    if (names.some((n) => !pending.requested_scopes.includes(n))) return fail('invalid_scope');
    const problem = scopeProblem(names, scopes);
    if (problem) return fail(problem);
  }
  return v;
}

function takeChallenge(v, challenges) {
  const r = challenges.take(v.deviceId, v.message.challenge);
  if (r === 'ok') return v;
  return fail(r === 'expired' ? 'challenge_expired' : r === 'reused' ? 'challenge_reused' : 'unknown_challenge');
}

function checkClientRevoke(envelope, { approverStore, frontdoorId, challenges }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.client.revoke', frontdoorId });
  return v.ok ? takeChallenge(v, challenges) : v;
}

function checkNodeRemove(envelope, { approverStore, frontdoorId, challenges }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.node.remove', frontdoorId });
  return v.ok ? takeChallenge(v, challenges) : v;
}

function derivedNodeId(rawKey) {
  try {
    return deriveNodeId(spkiHexFromRaw(rawKey));
  } catch {
    return null;
  }
}

function checkNodeEnroll(envelope, { approverStore, frontdoorId, pairing, now }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.node.enroll', frontdoorId });
  if (!v.ok) return v;
  const m = v.message;
  if (derivedNodeId(m.public_key) !== m.node_id) return fail('node_id_mismatch');
  if (!pairing || m.pairing_id !== pairing.pairing_id) return fail('unknown_pairing');
  if (!(now <= pairing.expires_at_ms)) return fail('expired');
  for (const k of ['node_id', 'node_name', 'profile', 'public_key', 'tls_fingerprint', 'replaces']) {
    if (m[k] !== (pairing[k] === undefined ? null : pairing[k])) return fail('binding_mismatch');
  }
  if (pairing.nonces && pairing.nonces.has(m.nonce)) return fail('replay');
  return v;
}

function checkNodePair(envelope, { frontdoorHost }) {
  const opened = openTyped(envelope, 'kl.node.pair');
  if (opened.error) return fail(opened.error);
  const m = opened.message;
  if (envelope.alg !== 'Ed25519' || envelope.kid !== m.node_id) return fail('malformed');
  let spki;
  try {
    spki = spkiHexFromRaw(m.public_key);
  } catch {
    return fail('malformed');
  }
  if (deriveNodeId(spki) !== m.node_id) return fail('node_id_mismatch');
  if (!verifyEd25519(envelope, spki)) return fail('bad_signature');
  if (m.frontdoor_host !== frontdoorHost) return fail('wrong_host');
  let tlsFingerprint;
  try {
    tlsFingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(m.tls_cert).raw).digest('hex');
  } catch {
    return fail('malformed');
  }
  return { ok: true, reason: null, message: m, publicKeySpkiHex: spki, tlsFingerprint };
}

function checkFrontDoorSigned(envelope, type, frontdoorId, spkiHex) {
  const opened = openTyped(envelope, type);
  if (opened.error) return fail(opened.error);
  const m = opened.message;
  if (envelope.alg !== 'Ed25519') return fail('malformed');
  if (envelope.kid !== frontdoorId || m.frontdoor_id !== frontdoorId) return fail('wrong_frontdoor');
  if (!verifyEd25519(envelope, spkiHex)) return fail('bad_signature');
  return { ok: true, reason: null, message: m };
}

// The node's side of §3.11 step 3: the key comes with the message, and the
// front door id is what that key derives (the owner compares its fingerprint).
function verifyPairAccept(envelope, { nodeId, nonce }) {
  const opened = openTyped(envelope, 'kl.node.pair.accept');
  if (opened.error) return fail(opened.error);
  let spki;
  try {
    spki = spkiHexFromRaw(opened.message.frontdoor_public_key);
  } catch {
    return fail('malformed');
  }
  const frontdoorId = deriveNodeId(spki);
  const v = checkFrontDoorSigned(envelope, 'kl.node.pair.accept', frontdoorId, spki);
  if (!v.ok) return v;
  if (v.message.node_id !== nodeId) return fail('wrong_node');
  if (v.message.nonce !== nonce) return fail('nonce_mismatch');
  return { ...v, frontdoorId, frontdoorSpkiHex: spki };
}

// The phone's re-pin rule (§3.3.1), ported for tests and doctor.
function verifyRepin(envelope, { frontdoorId, frontdoorPublicKey, receivedSpki, currentPin }) {
  let spki;
  try {
    spki = spkiHexFromRaw(frontdoorPublicKey);
  } catch {
    return fail('malformed');
  }
  const v = checkFrontDoorSigned(envelope, 'kl.relay.repin', frontdoorId, spki);
  if (!v.ok) return v;
  if (v.message.new_spki !== receivedSpki) return fail('spki_mismatch');
  if (v.message.old_spki !== currentPin) return fail('old_pin_mismatch');
  return v;
}

module.exports = {
  FLEET_SCOPE_RULES,
  scopeProblem,
  verifyPhoneEnvelope,
  checkGrantDecision,
  checkClientRevoke,
  checkNodeRemove,
  checkNodeEnroll,
  checkNodePair,
  verifyPairAccept,
  verifyRepin
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-protocol-checks.test.js tests/approvals-fake-phone.test.js`
Expected: PASS (`# fail 0`); the existing fake-phone test is unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/frontdoor/protocol/checks.js src/frontdoor/protocol/challenges.js tests/helpers/fake-phone.js tests/frontdoor-protocol-checks.test.js
git commit -m "feat(frontdoor): client-grant-v1 acceptance checks and challenges" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: `client-grant-v1` protocol document and vectors

**Files:**
- Create: `docs/protocol/client-grant-v1.md`
- Create: `tests/vectors/client-grant-v1/generate.js`
- Create: `tests/vectors/client-grant-v1/*.json` (written by the generator; 29 files)
- Test: `tests/client-grant-v1-vectors.test.js`

**Interfaces:**
- Consumes: Task 1 builders and helpers; Task 2 `checkGrantDecision`, `checkClientRevoke`, `checkNodeEnroll`, `checkNodeRemove`, `checkNodePair`, `verifyPairAccept`, `verifyRepin`, `Challenges`, `FLEET_SCOPE_RULES`; `tests/vectors/approval-v1/keys.json` (read by path, never copied); `approverStoreWith` (`tests/helpers/approver-set.js`).
- Produces: the vector set `{ name, consumers, given, input, expect }` that Part 6 (Tasks 35–36) runs in both phone cores. Phone-consumed names, exactly: `grant-approve`, `grant-deny`, `revoke-valid`, `enroll-valid`, `remove-valid`, `repin-valid`, `repin-reject-bad-signature`, `fingerprint-grouping`. For the four "build" vectors `expect.message` is the exact message the phone must build (its JCS bytes equal the decoded `input.payload`).

- [ ] **Step 1: Write the protocol document**

Create `docs/protocol/client-grant-v1.md`:

````markdown
# client-grant-v1 — connecting clients and nodes through the front door

Status: stage 4. Builds on `approval-v1.md` (envelopes, JCS, keys, device ids,
the `X-KL-*` phone API auth); nothing in approval-v1 changes.

## 1. Envelopes and canonical form

As approval-v1 §1: `{ alg, kid, payload, sig }`, `payload` = base64url of the
JCS bytes, `sig` over exactly those bytes, verifiers never re-canonicalize and
refuse non-canonical bytes (`malformed`). Phone-signed messages use
`alg: 'ES256'` (raw `r‖s`) and `kid = device_id`. Front-door-signed messages
use `alg: 'Ed25519'` and `kid = frontdoor_id` (the front door's node id).
The node-signed `kl.node.pair` uses `alg: 'Ed25519'`, `kid = node_id`.

Every array in a signed message is sorted and unique; a verifier rejects it
otherwise. No acceptance rule looks at `signed_at` or `created_at`: freshness
comes from a pending item or challenge held on the verifier's clock.

## 2. Identifiers

| Id | Form |
|---|---|
| `frontdoor_id`, `node_id` | `kl-` + base32(sha256(raw Ed25519 key))[0..16] (approval-v1 §2) |
| `device_id` | `d-` + base32(sha256(0x04‖x‖y))[0..16] |
| `grant_id` | `gr_` + 22 base64url |
| `pairing_id` | `pr_` + 22 base64url |
| `client_id` | `dcr_` + 22 base64url, or the `https:` URL of a client ID metadata document |
| `user_code` | 6 characters of `0123456789ABCDEFGHJKMNPQRSTVWXYZ` |
| `public_key` (node, front door) | base64url of the raw 32-byte Ed25519 key |
| `tls_fingerprint`, `mesh_cert_fingerprint` | lowercase hex SHA-256 of the certificate DER |
| SPKI pin | `sha256/` + base64url SHA-256 of the leaf SubjectPublicKeyInfo DER |

Node fingerprint shown to people: `kl-` then the 16 id characters in groups of
four, `kl-3v7q 2m4k 8d1x 9c0a`.

## 3. Messages

### 3.1 `kl.client.grant` (phone)

```jsonc
{ "v": 1, "type": "kl.client.grant", "frontdoor_id": "kl-…", "grant_id": "gr_…",
  "client_id": "dcr_…", "client_name": "Example Client", "redirect_uri": "https://client.example.com/cb",
  "resource": "https://mcp.kl.example.com/mcp", "code_challenge": "E9Melhoa2Owv…", "user_code": "Q7KM2X",
  "scopes": [{ "scope": "fleet:read", "machines": null }],
  "decision": "approve" | "deny", "nonce": "<b64url 32B>", "device_id": "d-…", "signed_at": "RFC3339" }
```

`client_name` ≤ 200 code points, URIs ≤ 2048 characters, `code_challenge`
43–128 base64url characters. `scopes` entries are `{ scope, machines }`, sorted
by `scope`; `machines` is `null` or a sorted, unique, non-empty list of names
matching `^[a-z0-9][a-z0-9._-]{0,62}$`. `approve` needs at least one scope;
`deny` exactly `[]`.

### 3.2 `kl.client.revoke` (phone)

`{ v, type, frontdoor_id, grant_id, challenge, device_id, signed_at }`.
`challenge` comes from `POST /v1/challenges`.

### 3.3 `kl.node.enroll` (phone)

`{ v, type, frontdoor_id, pairing_id, node_id, node_name, profile, public_key,
tls_fingerprint, replaces, decision, nonce, device_id, signed_at }`. `profile`
is `agent` or `runbook`; `replaces` is `null` or the node id being replaced.

### 3.4 `kl.node.remove` (phone)

`{ v, type, frontdoor_id, node_id, challenge, device_id, signed_at }`.

### 3.5 `kl.node.pair` (node)

```jsonc
{ "v": 1, "type": "kl.node.pair", "frontdoor_host": "mcp.kl.example.com",
  "code_hash": "<b64url SHA-256(normalized code)>", "node_id": "kl-…", "node_name": "gpu-box",
  "profile": "runbook", "capabilities": ["large-disk"], "public_key": "<b64url raw 32B>",
  "tls_cert": "<PEM>", "nonce": "<b64url 32B>", "created_at": "RFC3339" }
```

The code is normalised by trimming, lower-casing and collapsing whitespace
between words; only its hash travels.

### 3.6 `kl.node.pair.accept` (front door)

`{ v, type, frontdoor_id, pairing_id, node_id, nonce, mesh_url,
mesh_cert_fingerprint, frontdoor_public_key }`. `nonce` echoes the pair
request's nonce.

### 3.7 `kl.relay.repin` (front door)

`{ v, type, frontdoor_id, relay, old_spki, new_spki, created_at }`, served
unauthenticated at `GET /v1/repin` after `frontdoor rotate-tls-key`.

## 4. What the front door checks

Steps in order; the first failure is the `reason`.

**Every phone message:** opens canonically and matches its shape (`malformed`,
`unsupported_version`); `alg = ES256` and `kid = device_id` (`malformed`); the
device is in the front door's approver set (`unknown_device`), not `demo`
(`demo_device`), not a published test key (`test_key`), active
(`revoked_device`); the signature verifies (`bad_signature`); `frontdoor_id` is
this front door (`wrong_frontdoor`). On a re-check at load, a revoked device's
message stays valid iff the front door accepted it before `revoked_at`.

**`kl.client.grant`:** a pending authorization with this `grant_id`
(`unknown_request`); signed by the device that claimed it (`not_claimant`); not
expired on the front door's clock (`expired`); `client_id`, `redirect_uri`,
`resource`, `code_challenge` byte-equal (`binding_mismatch`); `user_code` equal
(`user_code_mismatch`); `nonce` unused (`replay`); on `approve`, every scope was
requested and is supported, and `fleet:unsafe` comes with `fleet:run` or
`fleet:delegate` (`invalid_scope`).

**`kl.client.revoke`, `kl.node.remove`:** the challenge was issued to this
device (`unknown_challenge`), is unused (`challenge_reused`) and unexpired
(`challenge_expired`).

**`kl.node.enroll`:** `node_id` derives from `public_key` (`node_id_mismatch`); a
pending pairing with this `pairing_id` (`unknown_pairing`), unexpired
(`expired`), whose node fields equal the message (`binding_mismatch`); nonce
unused (`replay`).

**`kl.node.pair`** (on `POST /pair/v1`): `alg = Ed25519`, `kid = node_id`
(`malformed`); `node_id` derives from `public_key` (`node_id_mismatch`); the
signature verifies (`bad_signature`); `frontdoor_host` is this front door's
`mcp.` host (`wrong_host`); `tls_cert` parses (`malformed`).

**`kl.node.pair.accept`** (on the node): the front door id is derived from
`frontdoor_public_key`; `kid` and `frontdoor_id` equal it (`wrong_frontdoor`);
the signature verifies (`bad_signature`); `node_id` is this node
(`wrong_node`); `nonce` echoes the request (`nonce_mismatch`).

## 5. What the phone does

- **Builds** `kl.client.grant`, `kl.client.revoke`, `kl.node.enroll`,
  `kl.node.remove` exactly as in §3, JCS-encodes and signs with the device key
  behind biometrics. It signs only for a code the owner typed from their own
  browser; it never shows a request it was not given by typing its code.
- **Shows** `client_name` as "(self-declared)", the client host and redirect
  host, and `origin.client` of approval requests as "Client (reported by
  front door)".
- **Re-pins** (§3.3.1 of the stage 4 spec) only when all hold: the envelope
  verifies against the front-door key pinned from the `kl.pair` QR (`node.key`
  where `node.id = frontdoor_id`), `new_spki` equals the SPKI of the
  certificate just received, `old_spki` equals the current pin. Otherwise:
  "Relay certificate changed — scan a new relay code".

## 6. User codes

The browser shows `XXX-XXX`. The phone accepts what the owner types, upper
cases it, drops `-` and spaces, maps `O→0`, `I→1`, `L→1`, and refuses anything
that is not then six alphabet characters.

## 7. Phone API additions (under `/v1`, approval-v1 §7 auth)

| Method, path | Body → reply |
|---|---|
| `POST /v1/pairing-codes` | `{ node_name }` → `{ code, expires_at }` |
| `GET /v1/pairings/pending` | → `[{ pairing_id, node_name, node_id, profile, public_key, tls_fingerprint, replaces, expires_in_ms }]` (`public_key` and `tls_fingerprint` are signed in `kl.node.enroll`, so the phone needs them) |
| `POST /v1/pairings/{id}/decision` | `kl.node.enroll` → `{ state }` |
| `GET /v1/grants/pending?user_code=` | → `{ grant_id, client_id, client_name, client_host, redirect_uri, resource, code_challenge, requested_scopes, preselected, expires_in_ms }` / `404 no_such_request` (claims the request for this phone) |
| `POST /v1/grants/{id}/decision` | `kl.client.grant` → `{ state }` |
| `GET /v1/clients` | → `[{ grant_id, client_name, client_host, scopes, accepted_at, last_used_at }]` |
| `POST /v1/clients/{grant_id}/revoke` | `kl.client.revoke` → `204` |
| `POST /v1/challenges` | → `{ challenge, expires_in_ms: 120000 }` |
| `POST /v1/nodes/{node_id}/remove` | `kl.node.remove` → `204` |
| `GET /v1/nodes` | approval-v1 fields + `profile`, `capabilities`, `source`, `audit`, `last_seen` |
| `GET /v1/nodes/{node_id}/audit-status` | → `{ head_seq, anchor, gaps, breaks }` |
| `GET /v1/alerts?since=`, `POST /v1/alerts/{id}/ack` | → `[{ id, kind, subject, detail, at, acked }]` / `204` |
| `GET /v1/frontdoor` | → `{ frontdoor_id, public_key, domain, cert_not_after }` |
| `GET /v1/repin` (no auth) | → `kl.relay.repin` / `404` |

## 8. Push

Kinds `pairing` and `alert` (approval-v1 §8 payloads, `k` = kind). Grants are
never pushed.

## 9. Vectors

`tests/vectors/client-grant-v1/<name>.json`: `{ name, consumers, given, input,
expect }`, built by `generate.js` from `../approval-v1/keys.json` (the same
published test keys; never ship or pin them). Consumers:

| Vectors | Consumers | Run as |
|---|---|---|
| `grant-*` | node; phones for `grant-approve`, `grant-deny` | `checkGrantDecision` with `given.pending`; phones build `expect.message` and compare bytes |
| `revoke-*`, `remove-valid` | node; phones for `revoke-valid`, `remove-valid` | challenge store from `given.challenges` |
| `enroll-*` | node; phones for `enroll-valid` | pending pairing from `given.pairing` |
| `pair-*`, `pair-accept-valid` | node | `given.frontdoor_host`; `given.node_id`, `given.nonce` |
| `repin-*` | all | `given.frontdoor`, `given.received_spki`, `given.current_pin` |
| `fingerprint-grouping` | all | node fingerprints and typed user codes |

A change to this document is complete only when `generate.js` has been rerun
and every consumer passes again.
````

- [ ] **Step 2: Write the generator**

Create `tests/vectors/client-grant-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/client-grant-v1/generate.js
//
// Rebuilds every client-grant-v1 vector from ../approval-v1/keys.json.
//   node tests/vectors/client-grant-v1/generate.js          write the files
//   node tests/vectors/client-grant-v1/generate.js --check  exit 1 if any differ
//
// ES256 signatures are randomized, so a committed signature that still
// verifies for the same payload is reused; the node certificate committed in
// pair-valid.json is reused the same way. Everything else is deterministic.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seal, open, verifyEs256, fromB64url, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { deriveNodeId } = require('../../../src/mesh/node-identity');
const { MeshIdentity } = require('../../../src/mesh/mesh-identity');
const P = require('../../../src/frontdoor/protocol/messages');
const { FLEET_SCOPE_RULES } = require('../../../src/frontdoor/protocol/checks');

const DIR = __dirname;
const KEYS = require('../approval-v1/keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const b64 = (label, n = 32) => sha(label).subarray(0, n).toString('base64url');
const nonceOf = (label) => b64(`cg nonce ${label}`);
const idOf = (prefix, label) => `${prefix}${b64(`cg id ${label}`, 16)}`;
const RULES = { supported: [...FLEET_SCOPE_RULES.supported], requires: { 'fleet:unsafe': [...FLEET_SCOPE_RULES.requires['fleet:unsafe']] } };

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, publicKey: spki, sign: (b) => crypto.sign(null, b, key) };
}

function p256(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, key: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

const DEVICE_D = {
  A: KEYS.devices.A.d,
  B: KEYS.devices.B.d,
  C: KEYS.devices.C.d,
  // Not in keys.json and never an approver: the "unknown device" signer.
  U: sha('client-grant-v1 unknown device').toString('base64url')
};

function committedDocs() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')));
}

function loadSigCache(docs) {
  const cache = new Map();
  const jwks = new Map(Object.values(DEVICE_D).map((d) => { const { jwk } = p256(d); return [deviceIdFromJwk(jwk), jwk]; }));
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.alg === 'ES256' && typeof v.kid === 'string' && typeof v.payload === 'string' && typeof v.sig === 'string') {
      const jwk = jwks.get(v.kid);
      if (jwk && verifyEs256(v, jwk)) cache.set(`${v.kid}:${v.payload}`, v.sig);
    }
    for (const child of Object.values(v)) walk(child);
  };
  for (const doc of docs) walk(doc);
  return cache;
}

function device(name, cache) {
  const { jwk, key } = p256(DEVICE_D[name]);
  const id = deviceIdFromJwk(jwk);
  return {
    id,
    jwk,
    signer: {
      alg: 'ES256',
      kid: id,
      sign(bytes) {
        const payload = Buffer.from(bytes).toString('base64url');
        const cached = cache.get(`${id}:${payload}`);
        if (cached && verifyEs256({ alg: 'ES256', kid: id, payload, sig: cached }, jwk)) return fromB64url(cached);
        const sig = crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
        cache.set(`${id}:${payload}`, sig.toString('base64url'));
        return sig;
      }
    }
  };
}

function approver(dev, extra = {}) {
  return {
    v: 1, device_id: dev.id, name: `Test phone ${dev.id.slice(2, 6)}`, platform: 'android', public_key: dev.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: null, revoked_by: null, enrollment: null, ...extra
  };
}

// Same payload bytes signed, but the payload is not JCS: `open` refuses it.
function nonCanonical(message, signer) {
  const bytes = Buffer.from(JSON.stringify(message, null, 1), 'utf8');
  return { alg: signer.alg, kid: signer.kid, payload: bytes.toString('base64url'), sig: signer.sign(bytes).toString('base64url') };
}

function flipSig(env) {
  const sig = fromB64url(env.sig);
  sig[0] ^= 1;
  return { ...env, sig: sig.toString('base64url') };
}

function nodeCert(docs) {
  const committed = docs.find((d) => d.name === 'pair-valid');
  if (committed) {
    try {
      const { message } = open(committed.input);
      new crypto.X509Certificate(message.tls_cert); // still parses
      return message.tls_cert;
    } catch {
      // regenerate below
    }
  }
  return MeshIdentity._generateFallbackTlsCert('gpu-box', 3650).cert;
}

function buildVectors({ docs = committedDocs() } = {}) {
  const cache = loadSigCache(docs);
  const A = device('A', cache);
  const B = device('B', cache);
  const C = device('C', cache);
  const U = device('U', cache);
  const fd = nodeIdentity('relay');
  const gpu = nodeIdentity('gpu-box');
  const web = nodeIdentity('web-01');
  const frontdoor = { id: fd.nodeId, key: P.rawEd25519(fd.publicKey) };
  const approvers = [approver(A), approver(C), approver(B, { revoked_at: '2026-09-20T00:00:00.000Z', revoked_by: 'console' })];
  const vectors = [];
  const add = (v) => vectors.push(v);

  // ── Grants ────────────────────────────────────────────────────────────
  const pending = {
    grant_id: idOf('gr_', 'grant'), client_id: idOf('dcr_', 'client'), client_name: 'Example Client', client_host: 'client.example.com',
    redirect_uri: 'https://client.example.com/cb', resource: 'https://mcp.kl.example.com/mcp', code_challenge: b64('code challenge'),
    user_code: 'Q7KM2X', requested_scopes: ['fleet:read', 'fleet:run'], expires_at: iso(NOW_MS + 300000), claimed_by: A.id, used_nonces: []
  };
  const grantMessage = (dev, p, { decision = 'approve', scopes = null, nonce = nonceOf('grant'), signedAt = iso(NOW_MS + 2000), frontdoorId = fd.nodeId } = {}) => ({
    v: 1, type: 'kl.client.grant', frontdoor_id: frontdoorId, grant_id: p.grant_id, client_id: p.client_id, client_name: p.client_name,
    redirect_uri: p.redirect_uri, resource: p.resource, code_challenge: p.code_challenge, user_code: p.user_code,
    scopes: decision === 'deny' ? [] : (scopes || p.requested_scopes.map((scope) => ({ scope, machines: null }))),
    decision, nonce, device_id: dev.id, signed_at: signedAt
  });
  const grant = (name, env, { p = pending, now = NOW, accepted, reason = null, consumers = ['node'], message = null }) => add({
    name, consumers, given: { now, frontdoor, approvers, allow_test_keys: true, pending: p, scopes: RULES },
    input: env, expect: message ? { accepted, reason, message } : { accepted, reason }
  });

  const approveMsg = grantMessage(A, pending, { scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }] });
  grant('grant-approve', seal(approveMsg, A.signer), { accepted: true, consumers: ['node', 'ios', 'android'], message: approveMsg });
  const denyMsg = grantMessage(A, pending, { decision: 'deny', nonce: nonceOf('deny') });
  grant('grant-deny', seal(denyMsg, A.signer), { accepted: true, consumers: ['node', 'ios', 'android'], message: denyMsg });
  grant('grant-reject-user-code-mismatch', seal(grantMessage(A, { ...pending, user_code: 'Q7KM2Y' }), A.signer), { accepted: false, reason: 'user_code_mismatch' });
  grant('grant-reject-wrong-frontdoor', seal(grantMessage(A, pending, { frontdoorId: web.nodeId }), A.signer), { accepted: false, reason: 'wrong_frontdoor' });
  grant('grant-reject-expired', seal(grantMessage(A, pending), A.signer), { now: iso(NOW_MS + 300001), accepted: false, reason: 'expired' });
  grant('grant-reject-code-challenge-changed', seal(grantMessage(A, { ...pending, code_challenge: b64('other challenge') }), A.signer), { accepted: false, reason: 'binding_mismatch' });
  grant('grant-reject-redirect-uri-changed', seal(grantMessage(A, { ...pending, redirect_uri: 'https://client.example.com/other' }), A.signer), { accepted: false, reason: 'binding_mismatch' });
  grant('grant-reject-scope-widened', seal(grantMessage(A, pending, { scopes: [{ scope: 'fleet:delegate', machines: null }, { scope: 'fleet:read', machines: null }] }), A.signer), { accepted: false, reason: 'invalid_scope' });
  grant('grant-reject-machines-unsorted', seal(grantMessage(A, pending, { scopes: [{ scope: 'fleet:run', machines: ['web-01', 'gpu-box'] }] }), A.signer), { accepted: false, reason: 'malformed' });
  const unsafePending = { ...pending, requested_scopes: ['fleet:read', 'fleet:unsafe'] };
  grant('grant-reject-unsafe-only', seal(grantMessage(A, unsafePending), A.signer), { p: unsafePending, accepted: false, reason: 'invalid_scope' });
  const unclaimed = { ...pending, claimed_by: null };
  grant('grant-reject-unknown-device', seal(grantMessage(U, unclaimed), U.signer), { p: unclaimed, accepted: false, reason: 'unknown_device' });
  grant('grant-reject-revoked-device', seal(grantMessage(B, unclaimed), B.signer), { p: unclaimed, accepted: false, reason: 'revoked_device' });
  grant('grant-reject-nonce-replay', seal(grantMessage(A, pending, { nonce: nonceOf('used') }), A.signer), { p: { ...pending, used_nonces: [nonceOf('used')] }, accepted: false, reason: 'replay' });
  grant('grant-reject-noncanonical', nonCanonical(grantMessage(A, pending), A.signer), { accepted: false, reason: 'malformed' });
  grant('grant-reject-not-claimant', seal(grantMessage(C, pending), C.signer), { accepted: false, reason: 'not_claimant' });
  grant('grant-accept-phone-clock-ahead', seal(grantMessage(A, pending, { signedAt: iso(NOW_MS + 86400000) }), A.signer), { accepted: true });

  // ── Client revocation ─────────────────────────────────────────────────
  const challenge = nonceOf('challenge');
  const revokeMsg = { v: 1, type: 'kl.client.revoke', frontdoor_id: fd.nodeId, grant_id: pending.grant_id, challenge, device_id: A.id, signed_at: iso(NOW_MS + 1000) };
  const revoke = (name, { used = false, expiresAt = iso(NOW_MS + 60000), accepted, reason = null, consumers = ['node'], message = null }) => add({
    name, consumers,
    given: { now: NOW, frontdoor, approvers, allow_test_keys: true, challenges: [{ challenge, device_id: A.id, expires_at: expiresAt, used }] },
    input: seal(revokeMsg, A.signer), expect: message ? { accepted, reason, message } : { accepted, reason }
  });
  revoke('revoke-valid', { accepted: true, consumers: ['node', 'ios', 'android'], message: revokeMsg });
  revoke('revoke-reject-challenge-reused', { used: true, accepted: false, reason: 'challenge_reused' });
  revoke('revoke-reject-challenge-expired', { expiresAt: iso(NOW_MS - 1000), accepted: false, reason: 'challenge_expired' });

  // ── Node enrollment and removal ───────────────────────────────────────
  const docsCert = nodeCert(docs);
  const tlsFingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(docsCert).raw).digest('hex');
  const pairing = {
    pairing_id: idOf('pr_', 'pairing'), node_id: gpu.nodeId, node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(gpu.publicKey),
    tls_fingerprint: tlsFingerprint, replaces: null, expires_at: iso(NOW_MS + 600000), used_nonces: []
  };
  const enrollMessage = (over = {}) => ({
    v: 1, type: 'kl.node.enroll', frontdoor_id: fd.nodeId, pairing_id: pairing.pairing_id, node_id: pairing.node_id, node_name: pairing.node_name,
    profile: pairing.profile, public_key: pairing.public_key, tls_fingerprint: pairing.tls_fingerprint, replaces: null,
    decision: 'approve', nonce: nonceOf('enroll'), device_id: A.id, signed_at: iso(NOW_MS + 3000), ...over
  });
  const enroll = (name, message, { accepted, reason = null, consumers = ['node'], withMessage = false }) => add({
    name, consumers, given: { now: NOW, frontdoor, approvers, allow_test_keys: true, pairing },
    input: seal(message, A.signer), expect: withMessage ? { accepted, reason, message } : { accepted, reason }
  });
  enroll('enroll-valid', enrollMessage(), { accepted: true, consumers: ['node', 'ios', 'android'], withMessage: true });
  enroll('enroll-reject-node-id-mismatch', enrollMessage({ node_id: web.nodeId }), { accepted: false, reason: 'node_id_mismatch' });
  enroll('enroll-reject-unknown-pairing', enrollMessage({ pairing_id: idOf('pr_', 'other pairing') }), { accepted: false, reason: 'unknown_pairing' });

  const removeChallenge = nonceOf('remove challenge');
  const removeMsg = { v: 1, type: 'kl.node.remove', frontdoor_id: fd.nodeId, node_id: gpu.nodeId, challenge: removeChallenge, device_id: A.id, signed_at: iso(NOW_MS + 1000) };
  add({
    name: 'remove-valid', consumers: ['node', 'ios', 'android'],
    given: { now: NOW, frontdoor, approvers, allow_test_keys: true, challenges: [{ challenge: removeChallenge, device_id: A.id, expires_at: iso(NOW_MS + 60000), used: false }] },
    input: seal(removeMsg, A.signer), expect: { accepted: true, reason: null, message: removeMsg }
  });

  // ── Pairing (node ↔ front door) ───────────────────────────────────────
  const code = 'abandon ability able about above absent';
  const pairEnv = P.buildNodePair({ identity: gpu, frontdoorHost: 'mcp.kl.example.com', code, profile: 'agent', capabilities: ['gpu', 'cuda', 'large-disk'], tlsCertPem: docsCert, nonce: nonceOf('pair'), now: NOW_MS });
  add({ name: 'pair-valid', consumers: ['node'], given: { frontdoor_host: 'mcp.kl.example.com' }, input: pairEnv, expect: { accepted: true, reason: null, node_id: gpu.nodeId, tls_fingerprint: tlsFingerprint, code_hash: P.pairingCodeHash(code) } });
  add({ name: 'pair-reject-bad-signature', consumers: ['node'], given: { frontdoor_host: 'mcp.kl.example.com' }, input: flipSig(pairEnv), expect: { accepted: false, reason: 'bad_signature' } });
  const acceptEnv = P.buildNodePairAccept({ identity: fd, pairingId: pairing.pairing_id, nodeId: gpu.nodeId, nonce: nonceOf('pair'), meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: sha('front door mesh cert').toString('hex') });
  add({ name: 'pair-accept-valid', consumers: ['node'], given: { node_id: gpu.nodeId, nonce: nonceOf('pair') }, input: acceptEnv, expect: { accepted: true, reason: null, frontdoor_id: fd.nodeId } });

  // ── Re-pin ─────────────────────────────────────────────────────────────
  const oldSpki = `sha256/${b64('old spki')}`;
  const newSpki = `sha256/${b64('new spki')}`;
  const repinEnv = P.buildRelayRepin({ identity: fd, relay: 'https://mcp.kl.example.com', oldSpki, newSpki, now: NOW_MS });
  const repinGiven = { frontdoor, received_spki: newSpki, current_pin: oldSpki };
  add({ name: 'repin-valid', consumers: ['node', 'ios', 'android'], given: repinGiven, input: repinEnv, expect: { accepted: true, reason: null } });
  add({ name: 'repin-reject-bad-signature', consumers: ['node', 'ios', 'android'], given: repinGiven, input: flipSig(repinEnv), expect: { accepted: false, reason: 'bad_signature' } });

  // ── Display ─────────────────────────────────────────────────────────────
  const typed = ['q7k-m2x', 'Q7KM2X', 'o1l abc', 'Q7KM2', 'Q7KM2U'];
  const normalized = typed.map((t) => P.normalizeUserCode(t));
  add({
    name: 'fingerprint-grouping', consumers: ['node', 'ios', 'android'], given: {},
    input: { node_ids: [gpu.nodeId, web.nodeId, fd.nodeId], typed_codes: typed },
    expect: {
      node_fingerprints: [gpu.nodeId, web.nodeId, fd.nodeId].map((n) => P.nodeFingerprint(n)),
      user_codes: normalized,
      displayed: normalized.map((c) => (c ? P.formatUserCode(c) : null))
    }
  });
  return vectors;
}

function serialize(v) {
  return `${JSON.stringify(v, null, 2)}\n`;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (current !== text) {
        differ += 1;
        process.stderr.write(`differs: ${v.name}.json\n`);
      }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, NOW };
```

- [ ] **Step 3: Write the failing test**

Create `tests/client-grant-v1-vectors.test.js`:

```js
// tests/client-grant-v1-vectors.test.js
//
// Every client-grant-v1 vector through the production checks, the committed
// files equal to what generate.js builds, and approval-v1 left alone.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { open } = require('../src/approvals/envelope');
const { canonicalize } = require('../src/platform/jcs');
const P = require('../src/frontdoor/protocol/messages');
const C = require('../src/frontdoor/protocol/checks');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/client-grant-v1/generate');

setLogLevel('fatal');
const DIR = path.join(__dirname, 'vectors', 'client-grant-v1');
const APPROVAL_DIR = path.join(__dirname, 'vectors', 'approval-v1');
const EXPECTED = [
  'grant-approve', 'grant-deny',
  ...['user-code-mismatch', 'wrong-frontdoor', 'expired', 'code-challenge-changed', 'redirect-uri-changed', 'scope-widened', 'machines-unsorted',
    'unsafe-only', 'unknown-device', 'revoked-device', 'nonce-replay', 'noncanonical', 'not-claimant'].map((n) => `grant-reject-${n}`),
  'grant-accept-phone-clock-ahead',
  'revoke-valid', 'revoke-reject-challenge-reused', 'revoke-reject-challenge-expired',
  'enroll-valid', 'enroll-reject-node-id-mismatch', 'enroll-reject-unknown-pairing', 'remove-valid',
  'pair-valid', 'pair-reject-bad-signature', 'pair-accept-valid', 'repin-valid', 'repin-reject-bad-signature', 'fingerprint-grouping'
];
const PHONE = ['grant-approve', 'grant-deny', 'revoke-valid', 'enroll-valid', 'remove-valid', 'repin-valid', 'repin-reject-bad-signature', 'fingerprint-grouping'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function storeFor(v) {
  const s = await approverStoreWith(v.given.approvers, { allowTestKeys: v.given.allow_test_keys, now: () => Date.parse(v.given.now) });
  stores.push(s);
  return s;
}

const challengesFor = (v) => new Challenges({
  now: () => Date.parse(v.given.now),
  entries: v.given.challenges.map((c) => ({ challenge: c.challenge, device_id: c.device_id, expires_at_ms: Date.parse(c.expires_at), used: c.used }))
});

async function run(v) {
  const g = v.given;
  if (v.name.startsWith('grant-')) {
    const p = g.pending;
    const pending = { ...p, expires_at_ms: Date.parse(p.expires_at), nonces: new Set(p.used_nonces) };
    return C.checkGrantDecision(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, pending, scopes: g.scopes, now: Date.parse(g.now) });
  }
  if (v.name.startsWith('revoke-')) return C.checkClientRevoke(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, challenges: challengesFor(v) });
  if (v.name.startsWith('remove-')) return C.checkNodeRemove(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, challenges: challengesFor(v) });
  if (v.name.startsWith('enroll-')) {
    const pairing = { ...g.pairing, expires_at_ms: Date.parse(g.pairing.expires_at), nonces: new Set(g.pairing.used_nonces) };
    return C.checkNodeEnroll(v.input, { approverStore: await storeFor(v), frontdoorId: g.frontdoor.id, pairing, now: Date.parse(g.now) });
  }
  if (v.name.startsWith('pair-accept-')) return C.verifyPairAccept(v.input, { nodeId: g.node_id, nonce: g.nonce });
  if (v.name.startsWith('pair-')) return C.checkNodePair(v.input, { frontdoorHost: g.frontdoor_host });
  if (v.name.startsWith('repin-')) {
    return C.verifyRepin(v.input, { frontdoorId: g.frontdoor.id, frontdoorPublicKey: g.frontdoor.key, receivedSpki: g.received_spki, currentPin: g.current_pin });
  }
  throw new Error(`no runner for ${v.name}`);
}

describe('client-grant-v1 vectors', () => {
  it('has exactly the expected set, and phones consume exactly theirs', () => {
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    assert.deepEqual(vectors.filter((v) => v.consumers.includes('ios')).map((v) => v.name).sort(), [...PHONE].sort());
    assert.deepEqual(vectors.filter((v) => v.consumers.includes('android')).map((v) => v.name).sort(), [...PHONE].sort());
  });

  for (const name of EXPECTED.filter((n) => n !== 'fingerprint-grouping')) {
    it(name, async () => {
      const v = byName.get(name);
      const r = await run(v);
      assert.deepEqual({ accepted: r.ok, reason: r.reason }, { accepted: v.expect.accepted, reason: v.expect.reason });
      if (name === 'pair-valid') {
        assert.equal(r.message.node_id, v.expect.node_id);
        assert.equal(r.tlsFingerprint, v.expect.tls_fingerprint);
        assert.equal(r.message.code_hash, v.expect.code_hash);
      }
      if (name === 'pair-accept-valid') assert.equal(r.frontdoorId, v.expect.frontdoor_id);
      if (v.expect.message) {
        // What a phone builds from these fields is exactly the signed bytes.
        assert.equal(canonicalize(v.expect.message), open(v.input).bytes.toString('utf8'));
      }
    });
  }

  it('fingerprint-grouping', () => {
    const v = byName.get('fingerprint-grouping');
    assert.deepEqual(v.input.node_ids.map((n) => P.nodeFingerprint(n)), v.expect.node_fingerprints);
    const codes = v.input.typed_codes.map((t) => P.normalizeUserCode(t));
    assert.deepEqual(codes, v.expect.user_codes);
    assert.deepEqual(codes.map((c) => (c ? P.formatUserCode(c) : null)), v.expect.displayed);
  });

  it('the committed files are exactly what generate.js produces', () => {
    for (const v of buildVectors()) {
      assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), `${v.name}.json is stale: run node tests/vectors/client-grant-v1/generate.js`);
    }
  });

  it('leaves approval-v1 untouched: 41 vectors, no shared names', () => {
    const approval = fs.readdirSync(APPROVAL_DIR).filter((f) => f.endsWith('.json') && f !== 'keys.json');
    assert.equal(approval.length, 41);
    const names = new Set(approval.map((f) => f.replace(/\.json$/, '')));
    for (const n of EXPECTED) assert.ok(!names.has(n), `${n} collides with an approval-v1 vector`);
    assert.ok(!fs.existsSync(path.join(DIR, 'keys.json')), 'client-grant-v1 reads ../approval-v1/keys.json, never a copy');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test tests/client-grant-v1-vectors.test.js`
Expected: FAIL — `ENOENT` reading `tests/vectors/client-grant-v1` (no vectors yet).

- [ ] **Step 5: Generate the vectors**

Run: `node tests/vectors/client-grant-v1/generate.js`
Expected: `29 vectors written`.

Then run it again with `--check`:
Run: `node tests/vectors/client-grant-v1/generate.js --check`
Expected: `29 vectors match` (the second run reuses the committed ES256 signatures and certificate).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/client-grant-v1-vectors.test.js tests/approvals-protocol.test.js`
Expected: PASS (`# fail 0`); `approvals-protocol` still sees its 41 vectors.

- [ ] **Step 7: Commit**

```bash
git add docs/protocol/client-grant-v1.md tests/vectors/client-grant-v1 tests/client-grant-v1-vectors.test.js
git commit -m "feat(protocol): client-grant-v1 document and vectors" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Scope rules (node and router) and the front door's `ScopeRegistry`

**Files:**
- Create: `src/fleet/scope-rules.js`
- Create: `src/frontdoor/oauth/scopes.js`
- Test: `tests/fleet-scope-rules.test.js`

**Interfaces:**
- Consumes: Task 1 `SCOPE_RE`, `MACHINE_NAME_RE` (copied as literals into `scope-rules.js`, which must stay dependency-free for the runbook profile).
- Produces (`src/fleet/scope-rules.js`, pure, no requires):
  - `REQUIRED_SCOPE` (frozen map tool → scope for the nine fleet tools).
  - `parseScope(str) → { scope, machines: string[] | null }` (throws `{ code: 'invalid_scope' }`), `formatScope({ scope, machines }) → string`, `normalizeScopes(list) → [{ scope, machines }]` (accepts strings or objects; throws on any bad entry).
  - `allows(scopes, tool, { machine = null, tier = null, required = null }) → { ok: true } | { ok: false, code: 'insufficient_scope' | 'unknown_machine', required }`.
  - `machineVisible(scopes, machine) → boolean` (the `fleet:read` entry covers `machine`).
  - `hasScope(scopes, name) → boolean`.
- Produces (`src/frontdoor/oauth/scopes.js`): `class ScopeRegistry` with `register(name, { tools, description, requires = null })`, `has(name)`, `get(name)`, `names()`, `supported(enabled) → string[]` (registered ∩ enabled, sorted), `rules(enabled) → { supported, requires }` (the shape `checkGrantDecision` takes), `requiredScopeFor(tool) → string | null`, `toolsFor(scopeNames) → Set<string>`; `createFleetScopeRegistry() → ScopeRegistry` with `fleet:read`, `fleet:run`, `fleet:unsafe` (`requires: ['fleet:run', 'fleet:delegate']`), `fleet:delegate`.

- [ ] **Step 1: Write the failing test**

Create `tests/fleet-scope-rules.test.js`:

```js
// tests/fleet-scope-rules.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/fleet/scope-rules');
const { ScopeRegistry, createFleetScopeRegistry } = require('../src/frontdoor/oauth/scopes');
const { scopeProblem } = require('../src/frontdoor/protocol/checks');

describe('scope strings', () => {
  it('parses and formats <scope>[;machines=a,b]', () => {
    assert.deepEqual(S.parseScope('fleet:read'), { scope: 'fleet:read', machines: null });
    assert.deepEqual(S.parseScope('fleet:run;machines=gpu-box,web-01'), { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] });
    assert.equal(S.formatScope({ scope: 'fleet:run', machines: ['gpu-box'] }), 'fleet:run;machines=gpu-box');
    assert.equal(S.formatScope({ scope: 'fleet:read', machines: null }), 'fleet:read');
  });

  it('refuses unsorted or duplicate machines and bad names', () => {
    for (const bad of ['fleet:run;machines=web-01,gpu-box', 'fleet:run;machines=a,a', 'FLEET:read', 'fleet:run;machines=', 'fleet:run;hosts=a']) {
      assert.throws(() => S.parseScope(bad), (err) => err.code === 'invalid_scope', bad);
    }
  });
});

describe('allows', () => {
  const scopes = ['fleet:read', 'fleet:run;machines=web-01'];

  it('needs the tool scope, and the machine inside machines=', () => {
    assert.deepEqual(S.allows(scopes, 'get_state', { machine: 'gpu-box' }), { ok: true });
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'web-01', tier: 'routine' }), { ok: true });
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'gpu-box', tier: 'routine' }), { ok: false, code: 'unknown_machine', required: 'fleet:run' });
    assert.deepEqual(S.allows(scopes, 'delegate', { machine: 'web-01' }), { ok: false, code: 'insufficient_scope', required: 'fleet:delegate' });
  });

  it('an unsafe runbook also needs fleet:unsafe covering the machine', () => {
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'web-01', tier: 'unsafe' }), { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' });
    const withUnsafe = [...scopes, 'fleet:unsafe;machines=web-01'];
    assert.deepEqual(S.allows(withUnsafe, 'run_runbook', { machine: 'web-01', tier: 'unsafe' }), { ok: true });
  });

  it('a malformed scope list allows nothing', () => {
    assert.equal(S.allows(['fleet:read', 'garbage;;'], 'get_state').ok, false);
    assert.equal(S.allows(null, 'get_state').ok, false);
  });

  it('an unknown tool needs an explicit required scope', () => {
    assert.equal(S.allows(['cases:read'], 'list_cases').ok, false);
    assert.deepEqual(S.allows(['cases:read'], 'list_cases', { required: 'cases:read' }), { ok: true });
  });

  it('machineVisible follows the fleet:read entry', () => {
    assert.equal(S.machineVisible(['fleet:read;machines=web-01'], 'web-01'), true);
    assert.equal(S.machineVisible(['fleet:read;machines=web-01'], 'gpu-box'), false);
    assert.equal(S.machineVisible(['fleet:run'], 'gpu-box'), false);
  });
});

describe('ScopeRegistry', () => {
  it('advertises only registered and enabled scopes', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual(r.supported(['fleet:read', 'fleet:run', 'cases:read']), ['fleet:read', 'fleet:run']);
    r.register('cases:read', { tools: ['list_cases'], description: 'Read cases' });
    assert.deepEqual(r.supported(['fleet:read', 'cases:read']), ['cases:read', 'fleet:read']);
    assert.equal(r.requiredScopeFor('list_cases'), 'cases:read');
    assert.equal(r.requiredScopeFor('delegate'), 'fleet:delegate');
    assert.throws(() => r.register('cases:read', { tools: [] }), /already registered/);
  });

  it('rules() feeds the grant check: fleet:unsafe needs fleet:run or fleet:delegate', () => {
    const rules = createFleetScopeRegistry().rules(['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
    assert.equal(scopeProblem(['fleet:read', 'fleet:unsafe'], rules), 'invalid_scope');
    assert.equal(scopeProblem(['fleet:delegate', 'fleet:unsafe'], rules), null);
    assert.equal(scopeProblem(['fleet:read'], createFleetScopeRegistry().rules(['fleet:run'])), 'invalid_scope');
  });

  it('toolsFor lists what a token may see', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual([...r.toolsFor(['fleet:read'])].sort(), ['describe_machine', 'get_job', 'get_job_logs', 'get_state', 'list_machines']);
    assert.ok(r.toolsFor(['fleet:run']).has('run_runbook'));
  });

  it('refuses a malformed scope name', () => {
    assert.throws(() => new ScopeRegistry().register('Fleet', { tools: [] }), /scope name/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fleet-scope-rules.test.js`
Expected: FAIL with `Cannot find module '../src/fleet/scope-rules'`.

- [ ] **Step 3: Write `src/fleet/scope-rules.js`**

```js
// Which OAuth scope each fleet tool needs, shared by the front door's router
// and the node's own re-check (fleet stage 4 §3.4, §3.7). Pure: the runbook
// profile loads it, so it requires nothing. On a node this re-check bounds
// router bugs, not a compromised front door: the scopes it reads are the
// ones the front door put in `origin.scopes` (§8).
const SCOPE_NAME = '[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}';
const MACHINE = '[a-z0-9][a-z0-9._-]{0,62}';
const SCOPE_STRING_RE = new RegExp(`^(${SCOPE_NAME})(?:;machines=(${MACHINE}(?:,${MACHINE})*))?$`);

const REQUIRED_SCOPE = Object.freeze({
  list_machines: 'fleet:read',
  describe_machine: 'fleet:read',
  get_state: 'fleet:read',
  get_job: 'fleet:read',
  get_job_logs: 'fleet:read',
  run_runbook: 'fleet:run',
  cancel_job: 'fleet:run',
  delegate: 'fleet:delegate',
  send_to_job: 'fleet:delegate'
});

function invalid(text) {
  return Object.assign(new Error(`invalid_scope: ${text}`), { code: 'invalid_scope' });
}

function parseScope(str) {
  const m = SCOPE_STRING_RE.exec(String(str));
  if (!m) throw invalid(`"${str}" is not <scope>[;machines=a,b]`);
  const machines = m[2] ? m[2].split(',') : null;
  if (machines) {
    for (let i = 1; i < machines.length; i += 1) {
      if (!(machines[i - 1] < machines[i])) throw invalid(`machines in "${str}" must be sorted and unique`);
    }
  }
  return { scope: m[1], machines };
}

function formatScope({ scope, machines }) {
  return machines && machines.length ? `${scope};machines=${machines.join(',')}` : scope;
}

function normalizeScopes(list) {
  if (!Array.isArray(list)) throw invalid('scopes must be a list');
  return list.map((s) => (typeof s === 'string' ? parseScope(s) : parseScope(formatScope(s || {}))));
}

const entryFor = (list, name) => list.find((e) => e.scope === name) || null;
const covers = (entry, machine) => entry.machines === null || (machine !== null && entry.machines.includes(machine));

function allows(scopes, tool, { machine = null, tier = null, required = null } = {}) {
  const need = required || REQUIRED_SCOPE[tool] || null;
  let list;
  try {
    list = normalizeScopes(scopes);
  } catch {
    return { ok: false, code: 'insufficient_scope', required: need };
  }
  if (!need) return { ok: false, code: 'insufficient_scope', required: null };
  const entry = entryFor(list, need);
  if (!entry) return { ok: false, code: 'insufficient_scope', required: need };
  if (machine !== null && !covers(entry, machine)) return { ok: false, code: 'unknown_machine', required: need };
  if (tool === 'run_runbook' && tier === 'unsafe') {
    const unsafe = entryFor(list, 'fleet:unsafe');
    if (!unsafe || (machine !== null && !covers(unsafe, machine))) return { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' };
  }
  return { ok: true };
}

function machineVisible(scopes, machine) {
  try {
    const entry = entryFor(normalizeScopes(scopes), 'fleet:read');
    return Boolean(entry) && covers(entry, machine);
  } catch {
    return false;
  }
}

function hasScope(scopes, name) {
  try {
    return Boolean(entryFor(normalizeScopes(scopes), name));
  } catch {
    return false;
  }
}

module.exports = { REQUIRED_SCOPE, parseScope, formatScope, normalizeScopes, allows, machineVisible, hasScope };
```

- [ ] **Step 4: Write `src/frontdoor/oauth/scopes.js`**

```js
// The scopes the front door can grant (§3.4). A scope is advertised only
// once it is registered here and listed in frontdoor.oauth.scopes_enabled;
// C7 registers cases:read / cases:write the same way (program §4.19).
const { REQUIRED_SCOPE } = require('../../fleet/scope-rules');

const SCOPE_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;

class ScopeRegistry {
  constructor() {
    this.scopes = new Map();
  }

  // `requires`: the grant must also carry at least one of these scopes.
  register(name, { tools, description = '', requires = null } = {}) {
    if (typeof name !== 'string' || !SCOPE_RE.test(name)) throw new TypeError(`bad scope name "${name}"`);
    if (this.scopes.has(name)) throw new Error(`scope ${name} is already registered`);
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) throw new TypeError(`scope ${name}: tools must be a list of tool names`);
    if (requires !== null && (!Array.isArray(requires) || !requires.every((r) => SCOPE_RE.test(r)))) throw new TypeError(`scope ${name}: requires must be scope names`);
    this.scopes.set(name, Object.freeze({ name, tools: Object.freeze([...tools]), description: String(description), requires: requires ? Object.freeze([...requires]) : null }));
  }

  has(name) {
    return this.scopes.has(name);
  }

  get(name) {
    return this.scopes.get(name) || null;
  }

  names() {
    return [...this.scopes.keys()].sort();
  }

  supported(enabled) {
    const on = new Set(enabled || []);
    return this.names().filter((n) => on.has(n));
  }

  rules(enabled) {
    const supported = this.supported(enabled);
    const requires = {};
    for (const n of supported) {
      const s = this.scopes.get(n);
      if (s.requires) requires[n] = [...s.requires];
    }
    return { supported, requires };
  }

  // The scope a tool call needs: the fleet table first, then a registered
  // scope that lists the tool (C7's cases:* tools).
  requiredScopeFor(tool) {
    if (REQUIRED_SCOPE[tool]) return REQUIRED_SCOPE[tool];
    for (const s of this.scopes.values()) if (s.name !== 'fleet:unsafe' && s.tools.includes(tool)) return s.name;
    return null;
  }

  toolsFor(scopeNames) {
    const out = new Set();
    for (const n of scopeNames || []) {
      const s = this.scopes.get(n);
      if (s && n !== 'fleet:unsafe') for (const t of s.tools) out.add(t);
    }
    return out;
  }
}

function createFleetScopeRegistry() {
  const r = new ScopeRegistry();
  r.register('fleet:read', { tools: ['list_machines', 'describe_machine', 'get_state', 'get_job', 'get_job_logs'], description: 'See machines, their state and their jobs' });
  r.register('fleet:run', { tools: ['run_runbook', 'cancel_job'], description: 'Start read and routine runbooks, and cancel jobs' });
  r.register('fleet:unsafe', {
    tools: ['run_runbook'],
    description: 'Ask for unsafe runbooks and unsafe actions in agent sessions (each one still needs your phone)',
    requires: ['fleet:run', 'fleet:delegate']
  });
  r.register('fleet:delegate', { tools: ['delegate', 'send_to_job'], description: 'Start and continue agent sessions on agent machines' });
  return r;
}

module.exports = { ScopeRegistry, createFleetScopeRegistry, SCOPE_RE };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/fleet-scope-rules.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/fleet/scope-rules.js src/frontdoor/oauth/scopes.js tests/fleet-scope-rules.test.js
git commit -m "feat(fleet): scope rules and the front door scope registry" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: `frontdoor` and `delegate` configuration, the `frontdoor` profile, and the front-door example

**Files:**
- Create: `src/platform/duration.js`
- Create: `src/frontdoor/config.js`
- Modify: `src/service/node-config.js` (requires; `NODE_YAML_KEYS`; `defaultNodeConfig`; profile check; the returned object)
- Modify: `src/service/config.js` (`PROFILES`; extract `parsePushConfig`; `loadServiceConfig`'s return)
- Create: `examples/fleet/frontdoor/node.yaml`, `examples/fleet/frontdoor/service.json`
- Modify: `examples/fleet/frontdoor/README.md`
- Modify: `tests/node-config-strict.test.js:48-56`, `tests/service-config.test.js:62-64`, `tests/examples.test.js:300-304` (and add one test after the `for (const [role, expect] …)` loop)
- Test: `tests/frontdoor-config.test.js`

**Interfaces:**
- Consumes: `unknownKeyError` (`src/service/config.js`), Task 1 `isDnsName`.
- Produces:
  - `parseDuration(text) → ms | null` (`src/platform/duration.js`; `^\d{1,6}(s|m|h|d)$`).
  - `src/frontdoor/config.js`: `FRONTDOOR_KEYS` (frozen per level), `LETS_ENCRYPT_PRODUCTION`, `FLEET_SCOPES`, `parseFrontDoorConfig(raw, file) → { domain (raw, checked at startup), listen: { host, port }, acme: null | { email, directory, termsAgreed }, tls: null | { certFile, keyFile }, oauth: { accessTokenTtlMs, refreshIdleTtlMs, scopesEnabled: string[], clientDefaults: [{ host, scopes: string[] }] }, mcp: { progressHoldS }, audit: { retentionDays: null | number } }`, `frontDoorHosts(domain) → { mcp, mesh }`.
  - `loadNodeConfig(...)` now also returns `frontdoor` (the object above, or `null` off the frontdoor profile) and `delegate: { provider, model, agent, idleCloseMs, cwd, maxSessions }` (defaults `null, null, 'main', 7200000, null, 4`). `profile` may be `frontdoor`.
  - `loadServiceConfig(...)` accepts `profile: frontdoor`; for it `relay` is `null` and `relayRaw` is the raw admin `relay` block (or `null`). `parsePushConfig(raw, file) → { apns?, fcm? }` is exported.
  - `NODE_YAML_KEYS.top` gains `'frontdoor'`, `'delegate'`; new levels `NODE_YAML_KEYS.frontdoor`, `NODE_YAML_KEYS.delegate` (R11).

- [ ] **Step 1: Write the failing test**

Create `tests/frontdoor-config.test.js`:

```js
// tests/frontdoor-config.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDuration } = require('../src/platform/duration');
const { parseFrontDoorConfig, FRONTDOOR_KEYS, frontDoorHosts, LETS_ENCRYPT_PRODUCTION } = require('../src/frontdoor/config');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');
const { loadServiceConfig, parsePushConfig } = require('../src/service/config');

const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function adminDir(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-config-'));
  temps.push(base);
  const dir = path.join(base, 'config');
  fs.mkdirSync(dir, { mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(dir, 0o755); }
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(path.join(dir, name), 0o644);
  }
  return { base, dir };
}
const load = (yaml) => loadNodeConfig({ adminConfigDir: adminDir({ 'node.yaml': yaml }).dir, geteuid: () => EUID, adminUid: EUID });

describe('parseDuration', () => {
  it('reads s, m, h and d', () => {
    assert.equal(parseDuration('90s'), 90000);
    assert.equal(parseDuration('5m'), 300000);
    assert.equal(parseDuration('2h'), 7200000);
    assert.equal(parseDuration('30d'), 30 * 86400000);
    assert.equal(parseDuration('2 h'), null);
    assert.equal(parseDuration('1w'), null);
    assert.equal(parseDuration(7200), null);
  });
});

describe('parseFrontDoorConfig', () => {
  it('fills defaults and keeps the domain for the startup checks', () => {
    const cfg = parseFrontDoorConfig({ domain: 'kl.example.com', acme: { terms_agreed: true } }, 'node.yaml');
    assert.equal(cfg.domain, 'kl.example.com');
    assert.deepEqual(cfg.listen, { host: '0.0.0.0', port: 443 });
    assert.deepEqual(cfg.acme, { email: null, directory: LETS_ENCRYPT_PRODUCTION, termsAgreed: true });
    assert.equal(cfg.tls, null);
    assert.equal(cfg.oauth.accessTokenTtlMs, 3600000);
    assert.equal(cfg.oauth.refreshIdleTtlMs, 30 * 86400000);
    assert.deepEqual(cfg.oauth.scopesEnabled, ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
    assert.deepEqual(cfg.oauth.clientDefaults, []);
    assert.equal(cfg.mcp.progressHoldS, 20);
    assert.equal(cfg.audit.retentionDays, null);
    assert.deepEqual(frontDoorHosts('kl.example.com'), { mcp: 'mcp.kl.example.com', mesh: 'mesh.kl.example.com' });
  });

  it('names an unknown key at any depth with its dotted path', () => {
    assert.throws(() => parseFrontDoorConfig({ oauth: { x: 1 } }, 'node.yaml'), /unknown key "frontdoor\.oauth\.x" \(known: access_token_ttl, refresh_token_idle_ttl, scopes_enabled, client_defaults\)/);
    assert.throws(() => parseFrontDoorConfig({ acme: { staging: true } }, 'node.yaml'), /unknown key "frontdoor\.acme\.staging"/);
    assert.throws(() => parseFrontDoorConfig({ oauth: { client_defaults: [{ match: { name: 'x' }, scopes: [] }] } }, 'node.yaml'), /unknown key "frontdoor\.oauth\.client_defaults\[0\]\.match\.name"/);
    assert.throws(() => parseFrontDoorConfig({ port: 443 }, 'node.yaml'), /unknown key "frontdoor\.port"/);
  });

  it('enforces the ranges of §6', () => {
    const bad = [
      [{ oauth: { access_token_ttl: '4m' } }, /access_token_ttl must be a duration from 5m to 24h/],
      [{ oauth: { refresh_token_idle_ttl: '400d' } }, /refresh_token_idle_ttl must be a duration from 1d to 365d/],
      [{ mcp: { progress_hold_s: 56 } }, /progress_hold_s must be an integer from 0 to 55/],
      [{ audit: { retention_days: 29 } }, /retention_days must be null or an integer of at least 30/],
      [{ listen: { port: 0 } }, /listen\.port must be an integer from 1 to 65535/],
      [{ acme: { directory: 'http://acme.example.com/dir' } }, /acme\.directory must be an https:\/\/ URL/],
      [{ tls: { cert_file: '/x.pem' } }, /tls\.key_file is required/],
      [{ oauth: { scopes_enabled: ['Fleet'] } }, /scopes_enabled must be a list of scope names/],
      [{ oauth: { client_defaults: [{ match: { host: '10.0.0.1' }, scopes: ['fleet:read'] }] } }, /match\.host must be a DNS name/]
    ];
    for (const [raw, re] of bad) assert.throws(() => parseFrontDoorConfig(raw, 'node.yaml'), re, JSON.stringify(raw));
  });

  it('keeps FRONTDOOR_KEYS.top and NODE_YAML_KEYS.frontdoor identical', () => {
    assert.deepEqual([...NODE_YAML_KEYS.frontdoor], [...FRONTDOOR_KEYS.top]);
  });
});

describe('loadNodeConfig: frontdoor and delegate', () => {
  it('parses the frontdoor block only on the frontdoor profile', () => {
    const cfg = load('name: frontdoor\nprofile: frontdoor\nfrontdoor:\n  domain: kl.example.com\n  acme: { terms_agreed: true }\n');
    assert.equal(cfg.profile, 'frontdoor');
    assert.equal(cfg.frontdoor.domain, 'kl.example.com');
    assert.equal(cfg.delegate.agent, 'main');
    assert.throws(() => load('profile: agent\nfrontdoor:\n  domain: kl.example.com\n'), /frontdoor: is only for profile: frontdoor/);
    assert.equal(load('profile: agent\n').frontdoor, null);
  });

  it('delegate: agent profile only, with defaults and ranges', () => {
    const cfg = load("profile: agent\ndelegate: { provider: anthropic, model: example-model, idle_close: 30m, cwd: '/srv/work', max_sessions: 2 }\n");
    assert.deepEqual(cfg.delegate, { provider: 'anthropic', model: 'example-model', agent: 'main', idleCloseMs: 1800000, cwd: '/srv/work', maxSessions: 2 });
    assert.deepEqual(load('profile: agent\n').delegate, { provider: null, model: null, agent: 'main', idleCloseMs: 7200000, cwd: null, maxSessions: 4 });
    assert.throws(() => load('profile: runbook\ndelegate: { agent: main }\n'), /delegate needs profile: agent/);
    assert.throws(() => load('profile: agent\ndelegate: { max_sessions: 17 }\n'), /delegate\.max_sessions must be an integer from 1 to 16/);
    assert.throws(() => load('profile: agent\ndelegate: { idle_close: 1m }\n'), /delegate\.idle_close must be a duration from 5m to 24h/);
    assert.throws(() => load('profile: agent\ndelegate: { turns: 3 }\n'), /unknown key "delegate\.turns"/);
  });

  it('a profile name that is not agent, runbook or frontdoor is still refused', () => {
    assert.throws(() => load('profile: relay\n'), /unknown profile "relay"/);
  });
});

describe('loadServiceConfig: the frontdoor profile', () => {
  it('keeps the raw relay block for the startup checks and parses nothing from it', () => {
    const { base, dir } = adminDir({ 'service.json': JSON.stringify({ profile: 'frontdoor', relay: { phone_listen: { port: 8443 }, push: {} } }) });
    const cfg = loadServiceConfig(path.join(base, 'data'), {}, { adminConfigDir: dir, geteuid: () => -1, adminUid: EUID });
    assert.equal(cfg.profile, 'frontdoor');
    assert.equal(cfg.relay, null);
    assert.deepEqual(cfg.relayRaw, { phone_listen: { port: 8443 }, push: {} });
  });

  it('parsePushConfig reads relay.push the way the relay does', () => {
    assert.deepEqual(parsePushConfig(undefined, 'service.json'), {});
    assert.deepEqual(parsePushConfig({ fcm: { service_account_file: '/etc/king-louie/fcm.json' } }, 'service.json'), { fcm: { serviceAccountFile: '/etc/king-louie/fcm.json' } });
    assert.throws(() => parsePushConfig({ gcm: {} }, 'service.json'), /unknown key "relay\.push\.gcm"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/frontdoor-config.test.js`
Expected: FAIL with `Cannot find module '../src/platform/duration'`.

- [ ] **Step 3: Write `src/platform/duration.js`**

```js
// "90s", "5m", "2h", "30d" → milliseconds, or null for anything else. Used
// by node.yaml's frontdoor.oauth.* and delegate.idle_close.
const UNITS = Object.freeze({ s: 1000, m: 60000, h: 3600000, d: 86400000 });

function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(text.trim());
  return m ? Number(m[1]) * UNITS[m[2]] : null;
}

module.exports = { parseDuration };
```

- [ ] **Step 4: Write `src/frontdoor/config.js`**

```js
// node.yaml `frontdoor:` (fleet stage 4 §6). Only key names, types and ranges
// are checked here; the domain and TLS-source refusals are startup checks
// #2 and #3 (§3.1), run in order by startFrontDoor, so they are left as
// written. Loaded by node-config.js on every profile, so it requires nothing
// heavier than the config helpers.
const { unknownKeyError } = require('../service/config');
const { parseDuration } = require('../platform/duration');
const { isDnsName, SCOPE_RE } = require('./protocol/messages');

const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const FLEET_SCOPES = Object.freeze(['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
const FRONTDOOR_KEYS = Object.freeze({
  top: Object.freeze(['domain', 'listen', 'acme', 'tls', 'oauth', 'mcp', 'audit']),
  listen: Object.freeze(['host', 'port']),
  acme: Object.freeze(['email', 'directory', 'terms_agreed']),
  tls: Object.freeze(['cert_file', 'key_file']),
  oauth: Object.freeze(['access_token_ttl', 'refresh_token_idle_ttl', 'scopes_enabled', 'client_defaults']),
  clientDefault: Object.freeze(['match', 'scopes']),
  match: Object.freeze(['host']),
  mcp: Object.freeze(['progress_hold_s']),
  audit: Object.freeze(['retention_days'])
});
const MIN = 60000;
const DAY = 86400000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseFrontDoorConfig(raw, file) {
  const invalid = (what) => new Error(`Invalid ${file}: ${what}`);
  const known = (obj, keys, where) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) throw unknownKeyError(file, `${where}.${k}`, keys);
  };
  const block = (value, where, keys) => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) throw invalid(`${where} must be a mapping`);
    known(value, keys, where);
    return value;
  };
  const top = block(raw, 'frontdoor', FRONTDOOR_KEYS.top);

  const listen = block(top.listen, 'frontdoor.listen', FRONTDOOR_KEYS.listen);
  const host = listen.host === undefined ? '0.0.0.0' : listen.host;
  const port = listen.port === undefined ? 443 : listen.port;
  if (typeof host !== 'string' || !host.trim()) throw invalid('frontdoor.listen.host must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('frontdoor.listen.port must be an integer from 1 to 65535');

  let acme = null;
  if (top.acme !== undefined) {
    const a = block(top.acme, 'frontdoor.acme', FRONTDOOR_KEYS.acme);
    const directory = a.directory === undefined ? LETS_ENCRYPT_PRODUCTION : a.directory;
    let https = false;
    try { https = new URL(directory).protocol === 'https:'; } catch { https = false; }
    if (!https) throw invalid('frontdoor.acme.directory must be an https:// URL');
    if (a.email !== undefined && a.email !== null && (typeof a.email !== 'string' || !a.email.includes('@'))) throw invalid('frontdoor.acme.email must be an email address');
    if (a.terms_agreed !== undefined && typeof a.terms_agreed !== 'boolean') throw invalid('frontdoor.acme.terms_agreed must be true or false');
    acme = { email: a.email || null, directory, termsAgreed: a.terms_agreed === true };
  }

  let tls = null;
  if (top.tls !== undefined) {
    const t = block(top.tls, 'frontdoor.tls', FRONTDOOR_KEYS.tls);
    for (const k of ['cert_file', 'key_file']) {
      if (typeof t[k] !== 'string' || !t[k].trim()) throw invalid(`frontdoor.tls.${k} is required`);
    }
    tls = { certFile: t.cert_file.trim(), keyFile: t.key_file.trim() };
  }

  const o = block(top.oauth, 'frontdoor.oauth', FRONTDOOR_KEYS.oauth);
  const duration = (value, fallback, min, max, what) => {
    const ms = parseDuration(value === undefined ? fallback : value);
    if (ms === null || ms < min || ms > max) throw invalid(what);
    return ms;
  };
  const accessTokenTtlMs = duration(o.access_token_ttl, '1h', 5 * MIN, DAY, 'frontdoor.oauth.access_token_ttl must be a duration from 5m to 24h');
  const refreshIdleTtlMs = duration(o.refresh_token_idle_ttl, '30d', DAY, 365 * DAY, 'frontdoor.oauth.refresh_token_idle_ttl must be a duration from 1d to 365d');
  const scopesEnabled = o.scopes_enabled === undefined ? [...FLEET_SCOPES] : o.scopes_enabled;
  if (!Array.isArray(scopesEnabled) || !scopesEnabled.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
    throw invalid('frontdoor.oauth.scopes_enabled must be a list of scope names');
  }
  const rawDefaults = o.client_defaults === undefined ? [] : o.client_defaults;
  if (!Array.isArray(rawDefaults)) throw invalid('frontdoor.oauth.client_defaults must be a list');
  const clientDefaults = rawDefaults.map((d, i) => {
    const where = `frontdoor.oauth.client_defaults[${i}]`;
    const entry = block(d, where, FRONTDOOR_KEYS.clientDefault);
    const match = block(entry.match, `${where}.match`, FRONTDOOR_KEYS.match);
    if (!isDnsName(match.host)) throw invalid(`${where}.match.host must be a DNS name`);
    if (!Array.isArray(entry.scopes) || !entry.scopes.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) {
      throw invalid(`${where}.scopes must be a list of scope names`);
    }
    return { host: match.host, scopes: [...new Set(entry.scopes)].sort() };
  });

  const mcp = block(top.mcp, 'frontdoor.mcp', FRONTDOOR_KEYS.mcp);
  const progressHoldS = mcp.progress_hold_s === undefined ? 20 : mcp.progress_hold_s;
  if (!Number.isInteger(progressHoldS) || progressHoldS < 0 || progressHoldS > 55) throw invalid('frontdoor.mcp.progress_hold_s must be an integer from 0 to 55');

  const audit = block(top.audit, 'frontdoor.audit', FRONTDOOR_KEYS.audit);
  const retentionDays = audit.retention_days === undefined ? null : audit.retention_days;
  if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 30)) {
    throw invalid('frontdoor.audit.retention_days must be null or an integer of at least 30');
  }

  return {
    domain: top.domain,
    listen: { host: host.trim(), port },
    acme,
    tls,
    oauth: { accessTokenTtlMs, refreshIdleTtlMs, scopesEnabled: [...scopesEnabled], clientDefaults },
    mcp: { progressHoldS },
    audit: { retentionDays }
  };
}

function frontDoorHosts(domain) {
  return { mcp: `mcp.${domain}`, mesh: `mesh.${domain}` };
}

module.exports = { parseFrontDoorConfig, frontDoorHosts, FRONTDOOR_KEYS, FLEET_SCOPES, LETS_ENCRYPT_PRODUCTION };
```

- [ ] **Step 5: Wire `node-config.js`**

In `src/service/node-config.js`:

1. After `const { assertAdminOwned: assertServiceAdminOwned, unknownKeyError } = require('./config');` add:

```js
const { parseDuration } = require('../platform/duration');
const { parseFrontDoorConfig, FRONTDOOR_KEYS } = require('../frontdoor/config');
```

2. Replace the `NODE_YAML_KEYS` declaration with:

```js
const NODE_YAML_KEYS = Object.freeze({
  top: Object.freeze(['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir', 'approvers', 'frontdoor', 'delegate']),
  policy: Object.freeze(['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']),
  remote_sessions: Object.freeze(['always_confirm', 'deny']),
  approvers: Object.freeze(['relay', 'request_ttl_s']),
  // Fleet stage 4 (R11): the front door's own block (its deeper levels are
  // checked by parseFrontDoorConfig) and an agent node's delegate sessions.
  frontdoor: FRONTDOOR_KEYS.top,
  delegate: Object.freeze(['provider', 'model', 'agent', 'idle_close', 'cwd', 'max_sessions'])
});
```

3. After the `DEFAULT_APPROVERS` constant add:

```js
// Delegate sessions (fleet stage 4 §3.8, §6). provider/model null = the
// node's settings default; cwd null = the first policy.allowed_roots entry.
const DEFAULT_DELEGATE = Object.freeze({ provider: null, model: null, agent: 'main', idleCloseMs: 2 * 3600000, cwd: null, maxSessions: 4 });

function parseDelegate(raw, invalid, file) {
  if (raw === undefined) return { ...DEFAULT_DELEGATE };
  if (!isPlainObject(raw)) throw invalid('delegate must be a mapping');
  assertKnownKeys(raw, NODE_YAML_KEYS.delegate, 'delegate.', file);
  const out = { ...DEFAULT_DELEGATE };
  for (const key of ['provider', 'model', 'agent', 'cwd']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'string' || !raw[key].trim()) throw invalid(`delegate.${key} must be a non-empty string`);
    out[key] = raw[key].trim();
  }
  if (raw.idle_close !== undefined) {
    const ms = parseDuration(raw.idle_close);
    if (ms === null || ms < 5 * 60000 || ms > 24 * 3600000) throw invalid('delegate.idle_close must be a duration from 5m to 24h');
    out.idleCloseMs = ms;
  }
  if (raw.max_sessions !== undefined) {
    if (!Number.isInteger(raw.max_sessions) || raw.max_sessions < 1 || raw.max_sessions > 16) throw invalid('delegate.max_sessions must be an integer from 1 to 16');
    out.maxSessions = raw.max_sessions;
  }
  return out;
}
```

4. In `defaultNodeConfig`, add two properties after `approvers: { ...DEFAULT_APPROVERS }`:

```js
    approvers: { ...DEFAULT_APPROVERS },
    frontdoor: null,
    delegate: { ...DEFAULT_DELEGATE }
```

5. Replace the profile check and the line after it:

```js
  if (parsed.profile !== undefined && !['agent', 'runbook', 'frontdoor'].includes(parsed.profile)) {
    throw invalid(`unknown profile "${parsed.profile}"`);
  }
  const profile = parsed.profile || 'agent';
  // Placement rules (§6): each block belongs to exactly one profile.
  if (parsed.frontdoor !== undefined && profile !== 'frontdoor') throw invalid('frontdoor: is only for profile: frontdoor');
  if (parsed.delegate !== undefined && profile !== 'agent') throw invalid('delegate needs profile: agent');
```

6. In the returned object, after `approvers: parseApprovers(parsed.approvers, invalid, configFile)` add:

```js
    approvers: parseApprovers(parsed.approvers, invalid, configFile),
    frontdoor: profile === 'frontdoor' ? parseFrontDoorConfig(parsed.frontdoor, configFile) : null,
    delegate: parseDelegate(parsed.delegate, invalid, configFile)
```

- [ ] **Step 6: Wire `config.js`**

In `src/service/config.js`:

1. Replace `const PROFILES = new Set(['agent', 'runbook']);` with:

```js
// frontdoor (fleet stage 4): the one public machine; it loads no agent code.
const PROFILES = new Set(['agent', 'runbook', 'frontdoor']);
```

2. Replace the `const push = {}; if (raw.push !== undefined) { … }` section inside `parseRelayConfig` with a call, and add the extracted function above `parseRelayConfig`:

```js
// relay.push, shared by the relay host and the front door (§3.1: "used as is").
function parsePushConfig(raw, file) {
  const push = {};
  if (raw === undefined) return push;
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: relay.push must be an object`);
  rejectUnknownKeys(raw, ['apns', 'fcm'], 'relay.push', file);
  if (raw.apns !== undefined) {
    const a = raw.apns;
    if (!isPlainObject(a)) throw new Error(`Invalid ${file}: relay.push.apns must be an object`);
    rejectUnknownKeys(a, ['team_id', 'key_id', 'key_file', 'topic', 'environment'], 'relay.push.apns', file);
    const environment = a.environment === undefined ? 'production' : a.environment;
    if (!['production', 'sandbox'].includes(environment)) throw new Error(`Invalid ${file}: relay.push.apns.environment must be production or sandbox`);
    push.apns = {
      teamId: requiredString(a.team_id, 'relay.push.apns.team_id', file),
      keyId: requiredString(a.key_id, 'relay.push.apns.key_id', file),
      keyFile: requiredString(a.key_file, 'relay.push.apns.key_file', file),
      topic: requiredString(a.topic, 'relay.push.apns.topic', file),
      environment
    };
  }
  if (raw.fcm !== undefined) {
    if (!isPlainObject(raw.fcm)) throw new Error(`Invalid ${file}: relay.push.fcm must be an object`);
    rejectUnknownKeys(raw.fcm, ['service_account_file'], 'relay.push.fcm', file);
    push.fcm = { serviceAccountFile: requiredString(raw.fcm.service_account_file, 'relay.push.fcm.service_account_file', file) };
  }
  return push;
}
```

and inside `parseRelayConfig` the removed section becomes the single line:

```js
  const push = parsePushConfig(raw.push, file);
```

3. Replace the final `return { profile, features, ports, relay: parseRelayConfig(adminCfg.relay, adminFile), audit: parseAuditConfig(adminCfg.audit, adminFile) };` of `loadServiceConfig` with:

```js
  // On the frontdoor profile the relay block follows §3.1 (public_url is
  // derived; tls/phone_listen/mesh_listen are refused; push is used as is).
  // Those refusals are startup check 4, run in order by startFrontDoor, so
  // the raw block is handed over unparsed.
  const frontdoor = profile === 'frontdoor';
  return {
    profile,
    features,
    ports,
    relay: frontdoor ? null : parseRelayConfig(adminCfg.relay, adminFile),
    ...(frontdoor ? { relayRaw: adminCfg.relay === undefined ? null : adminCfg.relay } : {}),
    audit: parseAuditConfig(adminCfg.audit, adminFile)
  };
```

4. Add `parsePushConfig` to `module.exports`.

- [ ] **Step 7: Update the pinned tests**

In `tests/node-config-strict.test.js`, replace the `NODE_YAML_KEYS` pin (the `it` inside `describe('NODE_YAML_KEYS', …)`, lines 49–56) with:

```js
  it('lists every key, per level, frozen', () => {
    assert.deepEqual([...NODE_YAML_KEYS.top], ['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir', 'approvers', 'frontdoor', 'delegate']);
    assert.deepEqual([...NODE_YAML_KEYS.policy], ['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']);
    assert.deepEqual([...NODE_YAML_KEYS.remote_sessions], ['always_confirm', 'deny']);
    assert.deepEqual([...NODE_YAML_KEYS.approvers], ['relay', 'request_ttl_s']);
    assert.deepEqual([...NODE_YAML_KEYS.frontdoor], ['domain', 'listen', 'acme', 'tls', 'oauth', 'mcp', 'audit']);
    assert.deepEqual([...NODE_YAML_KEYS.delegate], ['provider', 'model', 'agent', 'idle_close', 'cwd', 'max_sessions']);
    assert.ok(Object.isFrozen(NODE_YAML_KEYS));
    for (const level of Object.values(NODE_YAML_KEYS)) assert.ok(Object.isFrozen(level));
  });
```

(keep the existing `it(...)` title if it differs; only the body changes.)

In `tests/service-config.test.js`, replace the `rejects unknown profiles` test with:

```js
  it('rejects unknown profiles', () => {
    assert.throws(() => loadServiceConfig(tmp(), { profile: 'relay' }), /Unknown profile "relay"/);
    assert.strictEqual(loadServiceConfig(tmp(), { profile: 'frontdoor' }).profile, 'frontdoor');
  });
```

- [ ] **Step 8: Add the front-door example and flip its pin**

Create `examples/fleet/frontdoor/node.yaml`:

```yaml
# frontdoor: a small Linux VPS, profile frontdoor, the one machine the fleet
# is reached through from outside. Install as <configDir>/node.yaml
# (docs/fleet/front-door.md). DNS: mcp.kl.example.com and mesh.kl.example.com
# both point at this machine; only 443/tcp is open.
# Only the keys below are allowed; anything else stops the front door from loading.
name: frontdoor
profile: frontdoor
frontdoor:
  domain: kl.example.com
  listen: { host: 0.0.0.0, port: 443 }
  # Let's Encrypt production is the default directory. Add
  # `email: <your address>` to hear about expiring certificates.
  acme: { terms_agreed: true }
  oauth:
    access_token_ttl: 1h
    refresh_token_idle_ttl: 30d
    scopes_enabled: [fleet:read, fleet:run, fleet:unsafe, fleet:delegate]
  mcp: { progress_hold_s: 20 }
  audit: { retention_days: null }
```

Create `examples/fleet/frontdoor/service.json`:

```json
{
  "profile": "frontdoor",
  "features": { "gateway": false, "webhooks": false, "mesh": false, "channels": false, "appDiscovery": false, "desktopBridge": false },
  "ports": { "gateway": 18793, "webhook": 18794, "desktopBridge": 18796 }
}
```

Replace `examples/fleet/frontdoor/README.md` with:

```markdown
# frontdoor

The front door is the one machine the fleet can be reached through from
outside: `https://mcp.kl.example.com/mcp` for MCP clients and
`mesh.kl.example.com` for the nodes' pinned links. It runs
`king-louie-service` with `profile: frontdoor` on a small Linux VPS and
listens on 443 only.

`node.yaml` and `service.json` here are the admin files for that machine.
Setup, DNS, firewall and the bootstrap order (enroll a phone, then pair the
first node at the console) are in `docs/fleet/front-door.md`. Every listener
feature stays off in `service.json`: the front door's one listener is
configured in `node.yaml` under `frontdoor.listen`.

Nodes do not name the front door in their `node.yaml`; each pairs once with
`king-louie-service pair https://mcp.kl.example.com`, which writes
`<configDir>/front-door.json`.
```

In `tests/examples.test.js`, replace the line
`assert.ok(!fs.existsSync(path.join(EXAMPLES, 'fleet', 'frontdoor', 'node.yaml')), 'frontdoor/node.yaml arrives with fleet stage 4');` with:

```js
    for (const f of ['node.yaml', 'service.json']) {
      assert.ok(fs.existsSync(path.join(EXAMPLES, 'fleet', 'frontdoor', f)), `frontdoor/${f} missing`);
    }
```

and, inside `describe('example roles: load through the real loaders', …)`, right after the closing `}` of the `for (const [role, expect] of Object.entries(ROLE_RUNBOOKS))` loop, add:

```js
  it('frontdoor loads its node.yaml and service.json (fleet stage 4)', () => {
    const root = tmp();
    const config = path.join(root, 'config');
    const fleet = path.join(EXAMPLES, 'fleet', 'frontdoor');
    installInto(config, [path.join(fleet, 'node.yaml'), path.join(fleet, 'service.json')]);
    const node = loadNodeConfig({ adminConfigDir: config, ...adminOpts });
    assert.equal(node.name, 'frontdoor');
    assert.equal(node.profile, 'frontdoor');
    assert.equal(node.frontdoor.domain, 'kl.example.com');
    assert.deepEqual(node.frontdoor.listen, { host: '0.0.0.0', port: 443 });
    assert.equal(node.frontdoor.acme.termsAgreed, true);
    assert.equal(node.frontdoor.tls, null);
    assert.deepEqual(node.frontdoor.oauth.scopesEnabled, ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
    const raw = parseYaml(fs.readFileSync(path.join(config, 'node.yaml'), 'utf8'));
    for (const key of Object.keys(raw)) assert.ok(NODE_YAML_KEYS.top.includes(key), `node.yaml key ${key}`);
    const service = loadServiceConfig(path.join(root, 'data'), {}, { adminConfigDir: config, geteuid: () => -1, adminUid: EUID });
    assert.equal(service.profile, 'frontdoor');
    assert.equal(service.relayRaw, null);
    const rawService = JSON.parse(fs.readFileSync(path.join(config, 'service.json'), 'utf8'));
    assert.deepEqual(Object.keys(rawService), ['profile', 'features', 'ports']);
    assert.deepEqual(Object.keys(rawService.features), Object.keys(DEFAULT_FEATURES));
    assert.deepEqual(Object.keys(rawService.ports), Object.keys(DEFAULT_PORTS));
    assert.ok(Object.values(rawService.features).every((v) => v === false), 'every listener feature off on the front door');
  });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/frontdoor-config.test.js tests/node-config-strict.test.js tests/node-config.test.js tests/service-config.test.js tests/examples.test.js tests/service-installers.test.js tests/service-profile-graph.test.js`
Expected: PASS (`# fail 0`). The personal-value scan in `examples.test.js` passes over the new files (no email, only `example.com` hosts).

- [ ] **Step 10: Commit**

```bash
git add src/platform/duration.js src/frontdoor/config.js src/service/node-config.js src/service/config.js examples/fleet/frontdoor tests/frontdoor-config.test.js tests/node-config-strict.test.js tests/service-config.test.js tests/examples.test.js
git commit -m "feat(config): frontdoor profile, frontdoor and delegate node.yaml blocks, front door example" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: Mesh hardening I — frame limits, auth-before-parse, rates, per-peer nonces, sequence numbers, LAN lockout

**Files:**
- Modify: `src/mesh/mesh-transport.js` (header and constants; module helpers; constructor; `_initiateAuth`; `_handleInboundConnection`; the listener at the end of `_respondToChallenge`; new `_handleAuthReject`; `_promoteToPeer`; `send`; `_handlePeerMessage`; `_checkHeartbeats`; `_handlePeerDisconnect`; new `closePeer`, `_takeToken`; `stop`; exports)
- Modify: `src/approvals/link-rpc.js` (`createLinkRpc` options and `call`)
- Modify: `src/mesh/mesh-pairing.js` (constructor, `generateCode`, `handlePairingRequest`)
- Test: `tests/mesh-hardening.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `mesh-transport.js` exports `MeshTransport`, `DEFAULT_PORT`, `MAX_PAYLOAD_BYTES` (1 MiB), `PRE_AUTH_MAX_BYTES` (16 KiB), `CLOSE_CODES = { tooBig: 1009, unauthenticated: 4001, keyRemoved: 4003, alreadyConnected: 4009, replayDetected: 4010, rateLimited: 4029 }`, `parsePreAuthFrame(data) → { msg } | { close: code }`.
  - `MeshTransport#closePeer(peerId, code, reason) → boolean`; the `peerDisconnected` event is now `{ peerId, reason, code }` (`code` = the WebSocket close code, or `null`).
  - Every post-auth frame is `{ type: 'mesh:message', seq, envelope }` or `{ type: 'mesh:heartbeat', seq }`, `seq` strictly increasing per direction and connection.
  - Peer records gain `authAt`, `sendSeq`, `recvSeq`, `seenNonces` (per peer, ≤ 10 000), `tokens`/`tokensAt`, `envelopeWindowMs` (5 min; Task 7 sets 60 s on front-door links).
  - `createLinkRpc(transport, { defaultTimeoutMs = 10000, maxPendingPerPeer = 256 })`: a 257th pending call to one peer rejects `LinkRpcError('peer_busy')`.
  - `new MeshPairing(identity, transport, { timeoutMs, now = Date.now })`: 5 failed proofs lock pairing for 2 min (`pair:reject` reason `pairing_locked`); `generateCode()` draws words with `crypto.randomInt(WORDLIST.length)`.

- [ ] **Step 1: Write the failing test**

Create `tests/mesh-hardening.test.js`:

```js
// tests/mesh-hardening.test.js — fleet stage 4 §3.10.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { once, EventEmitter } = require('events');
const WebSocket = require('ws');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { MeshTransport, CLOSE_CODES, PRE_AUTH_MAX_BYTES, MAX_PAYLOAD_BYTES } = require('../src/mesh/mesh-transport');
const { MeshPairing, WORDLIST, pairingProof } = require('../src/mesh/mesh-pairing');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()().catch(() => {}); });

async function waitFor(fn, what, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function listener(identity = new MeshIdentity({ displayName: 'listener' })) {
  const t = new MeshTransport({ identity, host: '127.0.0.1', port: 0, useTls: false });
  await t.start();
  cleanups.push(() => t.stop());
  return t;
}

async function linked() {
  const a = await listener();
  const bId = new MeshIdentity({ displayName: 'dialer' });
  const b = new MeshTransport({ identity: bId, listen: false, useTls: false });
  await b.start();
  cleanups.push(() => b.stop());
  a.addTrustedPeer(bId.peerId, bId.publicKey);
  b.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
  await b.connectToPeer('127.0.0.1', a.port);
  await waitFor(() => a.getPeer(bId.peerId), 'the listener to promote the dialer');
  return { a, b, aId: a.identity, bId };
}

function envelopeWith(identity, to, payload, { nonce = crypto.randomBytes(16).toString('hex'), timestamp = Date.now() } = {}) {
  const body = JSON.stringify({ nonce, timestamp, to, payload });
  return { from: identity.peerId, to, nonce, timestamp, signature: identity.sign(body).toString('hex'), payload };
}

function rawSend(transport, peerId, frame) {
  const peer = transport.peers.get(peerId);
  peer.sendSeq += 1;
  peer.ws.send(JSON.stringify({ seq: peer.sendSeq, ...frame }));
}

describe('frame limits and auth before parse', () => {
  it('limits a frame to 1 MiB and an unauthenticated one to 16 KiB', () => {
    assert.equal(MAX_PAYLOAD_BYTES, 1024 * 1024);
    assert.equal(PRE_AUTH_MAX_BYTES, 16 * 1024);
  });

  it('closes an oversized pre-auth frame with 1009 without parsing it', async () => {
    const a = await listener();
    const realParse = JSON.parse;
    let bigParses = 0;
    JSON.parse = function parse(text, ...rest) {
      if (String(text).length > PRE_AUTH_MAX_BYTES) bigParses += 1;
      return realParse.call(this, text, ...rest);
    };
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'auth:challenge', pad: 'x'.repeat(20 * 1024) }));
      const [code] = await once(ws, 'close');
      assert.equal(code, CLOSE_CODES.tooBig);
    } finally {
      JSON.parse = realParse;
    }
    assert.equal(bigParses, 0);
  });

  it('closes anything that is not exactly auth:challenge or pair:request with 4001', async () => {
    const a = await listener();
    for (const frame of [{ type: 'hello' }, { type: 'auth:challenge', authId: 'x', challenge: 'y' }, [1, 2], 'not json']) {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
      const [code] = await once(ws, 'close');
      assert.equal(code, CLOSE_CODES.unauthenticated, JSON.stringify(frame));
    }
  });

  it('holds at most 8 unauthenticated sockets per IP', async () => {
    const a = await listener();
    const open = [];
    for (let i = 0; i < 8; i += 1) {
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}`);
      await once(ws, 'open');
      open.push(ws);
    }
    const ninth = new WebSocket(`ws://127.0.0.1:${a.port}`);
    const [code] = await once(ninth, 'close');
    assert.equal(code, CLOSE_CODES.rateLimited);
    for (const ws of open) ws.terminate();
  });
});

describe('authenticated links', () => {
  it('still authenticates and carries messages, with a sequence number on every frame', async () => {
    const { a, b, aId, bId } = await linked();
    const got = once(a, 'peerMessage');
    b.send(aId.peerId, { hello: 'world' });
    const [{ from, payload }] = await got;
    assert.equal(from, bId.peerId);
    assert.deepEqual(payload, { hello: 'world' });
    assert.equal(a.getPeer(bId.peerId).recvSeq, 1);
  });

  it('a replayed or unsequenced frame closes the link with 4010', async () => {
    const { b, aId } = await linked();
    const closed = once(b, 'peerDisconnected');
    b.peers.get(aId.peerId).ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: 0 }));
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.replayDetected);
  });

  it('drops an envelope signed before this connection authenticated', async () => {
    const { a, b, aId, bId } = await linked();
    const seen = [];
    a.on('peerMessage', (m) => seen.push(m.payload));
    const authAt = a.getPeer(bId.peerId).authAt;
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, aId.peerId, { n: 'stale' }, { timestamp: authAt - 10000 }) });
    rawSend(b, aId.peerId, { type: 'mesh:message', envelope: envelopeWith(bId, aId.peerId, { n: 'fresh' }) });
    await waitFor(() => seen.length === 1, 'the fresh message');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [{ n: 'fresh' }]);
  });

  it('keeps nonces per peer: one peer cannot burn another peer\'s nonce', async () => {
    const a = await listener();
    const seen = [];
    a.on('peerMessage', (m) => seen.push(`${m.from}:${m.payload.n}`));
    const dialers = [];
    for (const name of ['b', 'c']) {
      const id = new MeshIdentity({ displayName: name });
      const t = new MeshTransport({ identity: id, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      a.addTrustedPeer(id.peerId, id.publicKey);
      t.addTrustedPeer(a.identity.peerId, a.identity.publicKey);
      await t.connectToPeer('127.0.0.1', a.port);
      await waitFor(() => a.getPeer(id.peerId), `${name} linked`);
      dialers.push({ t, id });
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    for (const { t, id } of dialers) rawSend(t, a.identity.peerId, { type: 'mesh:message', envelope: envelopeWith(id, a.identity.peerId, { n: 1 }, { nonce }) });
    await waitFor(() => seen.length === 2, 'both messages with the same nonce');
    const [{ t, id }] = dialers;
    rawSend(t, a.identity.peerId, { type: 'mesh:message', envelope: envelopeWith(id, a.identity.peerId, { n: 2 }, { nonce }) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 2, 'the same peer replaying its nonce is dropped');
  });

  it('closes a peer over 200 messages a second (burst 400) with 4029', async () => {
    const { b, aId } = await linked();
    const closed = once(b, 'peerDisconnected');
    for (let i = 0; i < 450; i += 1) {
      try { b.send(aId.peerId, { i }); } catch { break; }
    }
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.rateLimited);
  });

  it('closes a peer that stops reading once 8 MiB is buffered', async () => {
    const { a, b, aId, bId } = await linked();
    const peer = b.peers.get(aId.peerId);
    Object.defineProperty(peer.ws, 'bufferedAmount', { get: () => 9 * 1024 * 1024 });
    const closed = once(a, 'peerDisconnected');
    assert.throws(() => b.send(aId.peerId, { x: 1 }), /send buffer full/);
    const [{ peerId, code }] = await closed;
    assert.equal(peerId, bId.peerId);
    assert.equal(code, CLOSE_CODES.rateLimited);
  });
});

describe('link RPC', () => {
  it('refuses a 257th pending call to one peer with peer_busy', async () => {
    const transport = Object.assign(new EventEmitter(), { send: () => {} });
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 60000 });
    const pending = [];
    for (let i = 0; i < 256; i += 1) pending.push(rpc.call('kl-aaaaaaaaaaaa', 'm').catch(() => {}));
    await assert.rejects(rpc.call('kl-aaaaaaaaaaaa', 'm'), (err) => err.code === 'peer_busy');
    const other = rpc.call('kl-bbbbbbbbbbbb', 'm').catch((err) => err.code);
    rpc.close();
    assert.equal(await other, 'closed');
    await Promise.all(pending);
  });
});

describe('LAN pairing', () => {
  function request(identityObj, secret, { good }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const proof = good ? pairingProof(secret, nonce, identityObj) : crypto.randomBytes(32).toString('hex');
    return { type: 'pair:request', pairingId: crypto.randomBytes(8).toString('hex'), nonce, proof, identity: identityObj };
  }
  const fakeWs = () => { const sent = []; return { sent, send: (s) => sent.push(JSON.parse(s)), close: () => {} }; };

  it('locks pairing for 2 minutes after 5 failed proofs', () => {
    let now = 1_000_000;
    const me = new MeshIdentity({ displayName: 'relay' });
    const pairing = new MeshPairing(me, new MeshTransport({ identity: me, listen: false, useTls: false }), { now: () => now });
    const { code } = pairing.generateCode();
    const secret = crypto.createHash('sha256').update(code).digest();
    const other = JSON.parse(JSON.stringify(new MeshIdentity({ displayName: 'node' }).getPublicIdentity()));
    for (let i = 0; i < 5; i += 1) {
      const ws = fakeWs();
      pairing.handlePairingRequest(ws, request(other, secret, { good: false }));
      assert.equal(ws.sent[0].reason, 'no_matching_code');
    }
    const locked = fakeWs();
    pairing.handlePairingRequest(locked, request(other, secret, { good: true }));
    assert.equal(locked.sent[0].reason, 'pairing_locked');
    now += 120001;
    const later = fakeWs();
    assert.ok(pairing.handlePairingRequest(later, request(other, secret, { good: true })));
    assert.equal(later.sent[0].type, 'pair:accept');
    pairing.cleanup();
  });

  it('draws code words with randomInt over the whole word list', () => {
    const me = new MeshIdentity({ displayName: 'x' });
    const pairing = new MeshPairing(me, new MeshTransport({ identity: me, listen: false, useTls: false }));
    const seen = new Set();
    for (let i = 0; i < 3000; i += 1) for (const w of pairing.generateCode().code.split(' ')) seen.add(w);
    pairing.cleanup();
    assert.equal(seen.size, WORDLIST.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mesh-hardening.test.js`
Expected: FAIL — `CLOSE_CODES` is undefined (`Cannot read properties of undefined (reading 'tooBig')`).

- [ ] **Step 3: Constants and helpers in `mesh-transport.js`**

Replace the header block from `const { EventEmitter } = require('events');` through `const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;` with:

```js
const { EventEmitter } = require('events');
const https = require('https');
const WebSocket = require('ws');
const { MeshIdentity } = require('./mesh-identity');
const { createLogger } = require('../logging');
const log = createLogger('mesh');

const DEFAULT_PORT = 18791;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;
const RECONNECT_DELAYS = [5000, 10000, 20000, 60000];
const AUTH_TIMEOUT_MS = 10000;
// Fleet stage 4 §3.10. A frame is at most 1 MiB (list RPCs are byte-paged
// with max_bytes); an unauthenticated one at most 16 KiB, checked before
// anything parses it (ruling 8).
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PRE_AUTH_MAX_BYTES = 16 * 1024;
const PRE_AUTH_STRING_MAX = 4096;
const PEER_NONCE_WINDOW = 10000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const INBOUND_RATE_PER_S = 200;
const INBOUND_BURST = 400;
const MAX_UNAUTH_SOCKETS = 64;
const MAX_UNAUTH_PER_IP = 8;
const ENVELOPE_WINDOW_MS = 5 * 60 * 1000;
const FRONT_DOOR_ENVELOPE_WINDOW_MS = 60000;
const STALE_GRACE_MS = 5000;
const CLOSE_CODES = Object.freeze({ tooBig: 1009, unauthenticated: 4001, keyRemoved: 4003, alreadyConnected: 4009, replayDetected: 4010, rateLimited: 4029 });

// The two frames a listener accepts before it knows who is talking, with
// exactly these keys.
const PRE_AUTH_SHAPES = Object.freeze({
  'auth:challenge': Object.freeze(['authId', 'challenge', 'identity', 'type']),
  'pair:request': Object.freeze(['identity', 'nonce', 'pairingId', 'proof', 'type'])
});
const IDENTITY_KEYS = new Set(['peerId', 'publicKey', 'displayName', 'capabilities', 'tlsFingerprint', 'nodeId', 'nodeName']);

function frameBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

const shortString = (v) => typeof v === 'string' && v.length <= PRE_AUTH_STRING_MAX;

function preAuthIdentityOk(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  for (const [k, v] of Object.entries(identity)) {
    if (!IDENTITY_KEYS.has(k)) return false;
    if (k === 'capabilities') {
      if (!Array.isArray(v) || v.length > 64 || !v.every(shortString)) return false;
    } else if (!(v === null || shortString(v))) {
      return false;
    }
  }
  return typeof identity.peerId === 'string' && typeof identity.publicKey === 'string';
}

// → { msg } or { close: code }. Size first, then one parse, then the exact shape.
function parsePreAuthFrame(data) {
  const buf = frameBytes(data);
  if (buf.length > PRE_AUTH_MAX_BYTES) return { close: CLOSE_CODES.tooBig };
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return { close: CLOSE_CODES.unauthenticated };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !Object.hasOwn(PRE_AUTH_SHAPES, msg.type)) return { close: CLOSE_CODES.unauthenticated };
  const keys = Object.keys(msg).sort();
  const want = PRE_AUTH_SHAPES[msg.type];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { close: CLOSE_CODES.unauthenticated };
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'identity' ? !preAuthIdentityOk(v) : !shortString(v)) return { close: CLOSE_CODES.unauthenticated };
  }
  return { msg };
}
```

- [ ] **Step 4: Constructor, dialer auth, inbound handling**

In the constructor, replace `this.seenNonces = new Set();` with:

```js
    // Unauthenticated inbound sockets → remote IP (at most 64, 8 per IP).
    this.unauth = new Map();
    // Fleet stage 4 §3.10 item 3 (Task 7 adds the TLS side): with it on,
    // `pair:request` is refused and only pinned client certificates connect.
    this.requireClientCert = config.requireClientCert === true;
```

In `_initiateAuth`, replace the `ws.on('message', (data) => { … });` block with:

```js
    ws.on('message', (data) => {
      const bytes = frameBytes(data);
      if (bytes.length > PRE_AUTH_MAX_BYTES) {
        try { ws.close(CLOSE_CODES.tooBig, 'frame_too_big'); } catch { /* gone */ }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(bytes.toString('utf8'));
      } catch (err) {
        log.error(`auth message parse error: ${err.message}`);
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'auth:response') this._handleAuthResponse(authId, msg);
      else if (msg.type === 'auth:complete') this._handleAuthComplete(authId, msg);
      else if (msg.type === 'auth:reject') this._handleAuthReject(authId, msg);
    });
```

Replace the whole `_handleInboundConnection(ws, _req) { … }` method with:

```js
  _handleInboundConnection(ws, req = null) {
    const ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    let fromIp = 0;
    for (const other of this.unauth.values()) if (other === ip) fromIp += 1;
    if (this.unauth.size >= MAX_UNAUTH_SOCKETS || fromIp >= MAX_UNAUTH_PER_IP) {
      log.warn(`refusing an unauthenticated mesh connection from ${ip}: too many are open`);
      try { ws.close(CLOSE_CODES.rateLimited, 'too_many_unauthenticated'); } catch { /* gone */ }
      return;
    }
    this.unauth.set(ws, ip);
    ws.once('close', () => this.unauth.delete(ws));

    const authTimeout = setTimeout(() => {
      try { ws.close(CLOSE_CODES.unauthenticated, 'auth_timeout'); } catch { /* gone */ }
    }, AUTH_TIMEOUT_MS);

    // A malformed frame makes `ws` emit 'error' on this socket. This listener
    // is attached before authentication, because without one an unhandled
    // 'error' event takes the whole process down.
    ws.on('error', (err) => {
      log.warn(`inbound mesh connection error: ${err.message}`);
      clearTimeout(authTimeout);
      try { ws.terminate(); } catch { /* already gone */ }
    });

    // Ruling 8: the first frame is size-checked, then parsed once, then
    // accepted only as exactly auth:challenge or (LAN only) pair:request.
    const onMessage = (data) => {
      clearTimeout(authTimeout);
      ws.removeListener('message', onMessage);
      const parsed = parsePreAuthFrame(data);
      if (parsed.close) {
        try { ws.close(parsed.close, parsed.close === CLOSE_CODES.tooBig ? 'frame_too_big' : 'unauthenticated'); } catch { /* gone */ }
        return;
      }
      const { msg } = parsed;
      if (msg.type === 'pair:request') {
        if (this.requireClientCert || !this.onPairingRequest) {
          try { ws.close(CLOSE_CODES.unauthenticated, 'pairing_off'); } catch { /* gone */ }
          return;
        }
        this.onPairingRequest(ws, msg);
        return;
      }
      this._respondToChallenge(ws, msg);
    };
    ws.on('message', onMessage);
  }
```

At the end of `_respondToChallenge`, replace from `ws.removeAllListeners('message');` to the end of the method with:

```js
    ws.removeAllListeners('message');
    ws.on('message', (data) => {
      const bytes = frameBytes(data);
      // Still unauthenticated until auth:complete verifies: same size cap.
      if (bytes.length > PRE_AUTH_MAX_BYTES) {
        try { ws.close(CLOSE_CODES.tooBig, 'frame_too_big'); } catch { /* gone */ }
        return;
      }
      let resp;
      try {
        resp = JSON.parse(bytes.toString('utf8'));
      } catch (err) {
        log.debug(`inbound message parse error: ${err.message}`);
        return;
      }
      if (resp && resp.type === 'auth:complete') this._handleAuthComplete(authId, resp);
    });
  }

  _handleAuthReject(authId, msg) {
    const pending = this.pendingAuth.get(authId);
    if (!pending || pending.direction !== 'outbound') return;
    this.pendingAuth.delete(authId);
    clearTimeout(pending.timeout);
    try { pending.ws.close(); } catch { /* gone */ }
    pending.reject(new Error(`the peer refused authentication: ${typeof msg.reason === 'string' ? msg.reason.slice(0, 100) : 'no reason'}`));
  }
```

- [ ] **Step 5: Promotion, sending, receiving, disconnecting**

Replace the whole `_promoteToPeer(authId, ws, remoteIdentity, pending) { … }` method with:

```js
  _promoteToPeer(authId, ws, remoteIdentity, pending) {
    clearTimeout(pending.timeout);
    this.pendingAuth.delete(authId);
    this.unauth.delete(ws);

    const existingPeer = this.peers.get(remoteIdentity.peerId);
    if (existingPeer) {
      try { existingPeer.ws.close(); } catch { /* ignore */ }
    }

    const tlsVerified = this.useTls && (
      (pending.serverCertFingerprint != null) || // outbound: we saw their cert
      (remoteIdentity.tlsFingerprint != null)     // inbound: they declared fingerprint
    );

    const now = Date.now();
    const peerInfo = {
      peerId: remoteIdentity.peerId,
      displayName: remoteIdentity.displayName || '',
      capabilities: remoteIdentity.capabilities || [],
      publicKey: remoteIdentity.publicKey,
      tlsFingerprint: remoteIdentity.tlsFingerprint || pending.serverCertFingerprint || null,
      tlsVerified,
      ws,
      connectedAt: now,
      lastSeen: now,
      address: pending.address || null,
      port: pending.port || null,
      // §3.10 item 4: frames carry a per-direction sequence number, and an
      // envelope signed before this connection authenticated is stale.
      authAt: now,
      sendSeq: 0,
      recvSeq: 0,
      // §3.10 item 2: replay nonces are kept per peer, and inbound frames are
      // metered with a token bucket.
      seenNonces: new Set(),
      tokens: INBOUND_BURST,
      tokensAt: now,
      envelopeWindowMs: pending.frontDoorLink || this.requireClientCert ? FRONT_DOOR_ENVELOPE_WINDOW_MS : ENVELOPE_WINDOW_MS
    };

    this.peers.set(remoteIdentity.peerId, peerInfo);

    ws.removeAllListeners('message');
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(frameBytes(data).toString('utf8'));
      } catch (err) {
        log.debug(`peer message parse error: ${err.message}`);
        return;
      }
      if (msg && typeof msg === 'object') this._handlePeerMessage(remoteIdentity.peerId, msg);
    });

    ws.on('close', (code) => {
      this._handlePeerDisconnect(remoteIdentity.peerId, peerInfo, code);
    });

    ws.on('error', (err) => {
      this.emit('peerError', { peerId: remoteIdentity.peerId, error: err });
    });

    const tlsLabel = tlsVerified ? ', TLS verified' : (this.useTls ? ', TLS' : '');
    log.info(`peer authenticated: ${remoteIdentity.peerId} (${remoteIdentity.displayName || 'unnamed'}${tlsLabel})`);
    this.emit('peerConnected', peerInfo);

    if (pending.resolve) {
      pending.resolve(peerInfo);
    }
  }
```

Replace the whole `send(peerId, payload) { … }` method with:

```js
  send(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Peer not connected: ${peerId}`);
    }
    // A peer that stops reading must not grow our memory without bound.
    if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.closePeer(peerId, CLOSE_CODES.rateLimited, 'send_buffer_full');
      throw new Error(`Peer ${peerId} is not reading (send buffer full); the link was closed`);
    }
    const envelope = MeshIdentity.createEnvelope(this.identity, peerId, payload);
    peer.sendSeq += 1;
    peer.ws.send(JSON.stringify({ type: 'mesh:message', seq: peer.sendSeq, envelope }));
    return envelope;
  }

  // Closes a connected peer with a close code the far side can act on
  // (4003 key removed, 4009 already connected, …); the socket's own 'close'
  // handler does the one cleanup and emits peerDisconnected with the code.
  closePeer(peerId, code, reason = '') {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    peer.disconnectReason = reason || String(code);
    try {
      peer.ws.close(code, reason);
    } catch {
      try { peer.ws.terminate(); } catch { /* gone */ }
    }
    return true;
  }

  _takeToken(peer) {
    const now = Date.now();
    peer.tokens = Math.min(INBOUND_BURST, peer.tokens + ((now - peer.tokensAt) / 1000) * INBOUND_RATE_PER_S);
    peer.tokensAt = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }
```

Replace the whole `_handlePeerMessage(peerId, msg) { … }` method and `_pruneNonces()` with:

```js
  _handlePeerMessage(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (!this._takeToken(peer)) {
      log.warn(`peer ${peerId} sent more than ${INBOUND_RATE_PER_S} messages a second; closing`);
      this.closePeer(peerId, CLOSE_CODES.rateLimited, 'rate_limited');
      return;
    }
    if (!Number.isInteger(msg.seq) || msg.seq <= peer.recvSeq) {
      log.warn(`replayed or unsequenced frame from ${peerId}; closing`);
      this.closePeer(peerId, CLOSE_CODES.replayDetected, 'replay_detected');
      return;
    }
    peer.recvSeq = msg.seq;
    peer.lastSeen = Date.now();

    if (msg.type !== 'mesh:message') return; // heartbeats and anything unknown end here
    const { envelope } = msg;
    if (!envelope || typeof envelope !== 'object' || typeof envelope.nonce !== 'string') return;
    if (peer.seenNonces.has(envelope.nonce)) return; // replay

    const trusted = this.trustedPeers.get(peerId);
    if (!trusted) return;
    if (!(Number(envelope.timestamp) >= peer.authAt - STALE_GRACE_MS)) {
      log.warn(`stale envelope from ${peerId}: signed before this connection authenticated`);
      return;
    }
    const verification = MeshIdentity.verifyEnvelope(envelope, trusted.publicKey, peer.envelopeWindowMs);
    if (!verification.valid) {
      log.warn(`invalid envelope from ${peerId}: ${verification.reason}`);
      return;
    }

    peer.seenNonces.add(envelope.nonce);
    if (peer.seenNonces.size > PEER_NONCE_WINDOW) peer.seenNonces.delete(peer.seenNonces.values().next().value);

    this.emit('peerMessage', {
      from: peerId,
      payload: envelope.payload,
      envelope
    });
  }
```

In `_checkHeartbeats`, replace `peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat' }));` with:

```js
        peer.sendSeq += 1;
        peer.ws.send(JSON.stringify({ type: 'mesh:heartbeat', seq: peer.sendSeq }));
```

Replace the signature and emit of `_handlePeerDisconnect`:

```js
  _handlePeerDisconnect(peerId, peerInfo, code = null) {
    if (this.peers.get(peerId) !== peerInfo) return;
    const reason = peerInfo.disconnectReason || 'closed';
    this.peers.delete(peerId);
    log.info(`peer disconnected: ${peerId} (${reason}${code ? `, ${code}` : ''})`);
    this.emit('peerDisconnected', { peerId, reason, code: Number.isInteger(code) ? code : null });
```

(keep the rest of the method — the reconnect scheduling — as it is).

In `stop()`, after the `pendingAuth` loop and `this.pendingAuth.clear();` add:

```js
    for (const ws of this.unauth.keys()) {
      try { ws.terminate(); } catch { /* gone */ }
    }
    this.unauth.clear();
```

Replace the last line `module.exports = { MeshTransport, DEFAULT_PORT };` with:

```js
module.exports = { MeshTransport, DEFAULT_PORT, MAX_PAYLOAD_BYTES, PRE_AUTH_MAX_BYTES, CLOSE_CODES, parsePreAuthFrame };
```

- [ ] **Step 6: Pending-call cap in `link-rpc.js`**

In `src/approvals/link-rpc.js`, change the factory signature to:

```js
function createLinkRpc(transport, { defaultTimeoutMs = 10000, maxPendingPerPeer = 256 } = {}) {
```

and at the top of `call(peerId, method, params = {}, { timeoutMs = defaultTimeoutMs } = {})`, right after the `if (closed) …` line, add:

```js
      // §3.10 item 2: a peer that never answers cannot hold unbounded state.
      let inFlight = 0;
      for (const waiter of pending.values()) if (waiter.peerId === peerId) inFlight += 1;
      if (inFlight >= maxPendingPerPeer) {
        return Promise.reject(new LinkRpcError('peer_busy', `${peerId} already has ${maxPendingPerPeer} calls pending`));
      }
```

- [ ] **Step 7: LAN pairing lockout and `randomInt`**

In `src/mesh/mesh-pairing.js`:

1. Below `const PROOF_RE = …;` add:

```js
// §3.10 item 7: five failed proofs lock pairing for two minutes.
const PAIRING_MAX_FAILURES = 5;
const PAIRING_LOCK_MS = 120000;
```

2. Replace the constructor signature line and add three fields at its end:

```js
  constructor(identity, transport, { timeoutMs = PAIRING_TIMEOUT_MS, now = Date.now } = {}) {
```

```js
    this.now = now;
    this.failedProofs = 0;
    this.lockedUntil = 0;
```

3. Replace the body of `generateCode(meta = {})` with:

```js
  generateCode(meta = {}) {
    const words = [];
    for (let i = 0; i < PAIRING_CODE_WORDS; i++) {
      words.push(WORDLIST[crypto.randomInt(WORDLIST.length)]);
    }
    const { pairingId, code } = this.addCode(words.join(' '), meta);
    return { pairingId, code };
  }
```

4. In `handlePairingRequest(ws, msg)`, insert at the very top of the method:

```js
    if (this.now() < this.lockedUntil) {
      ws.send(JSON.stringify({ type: 'pair:reject', reason: 'pairing_locked' }));
      ws.close();
      return null;
    }
```

and replace the `if (!matchedPairing) { … }` block with:

```js
    if (!matchedPairing) {
      this.failedProofs += 1;
      if (this.failedProofs >= PAIRING_MAX_FAILURES) {
        this.failedProofs = 0;
        this.lockedUntil = this.now() + PAIRING_LOCK_MS;
      }
      ws.send(JSON.stringify({ type: 'pair:reject', reason: 'no_matching_code' }));
      ws.close();
      return null;
    }
    this.failedProofs = 0;
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/mesh-hardening.test.js tests/mesh-transport.test.js tests/mesh-pairing.test.js tests/approvals-link-rpc.test.js tests/approvals-relay-client.test.js tests/frontdoor-relay.test.js tests/mesh-remote-control.test.js`
Expected: PASS (`# fail 0`). Existing tests keep passing: both ends of every test link run this code, so every frame is sequenced.

- [ ] **Step 9: Commit**

```bash
git add src/mesh/mesh-transport.js src/approvals/link-rpc.js src/mesh/mesh-pairing.js tests/mesh-hardening.test.js
git commit -m "feat(mesh): frame limits, auth before parse, rates, per-peer nonces, sequence numbers, pairing lockout" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Mesh hardening II — channel binding, pinned client certificates, `attachServer`, `connectPinned`, no mDNS in service mode

**Files:**
- Modify: `src/mesh/mesh-transport.js` (requires; helpers; constructor; `start`; `_handleInboundConnection`; `_respondToChallenge`; `_handleAuthResponse`; `_handleAuthComplete`; new `_pinnedSocket`, `attachServer`, `connectPinned`; `stop`; exports)
- Modify: `src/mesh/index.js` (lazy requires; `frontDoor` forces discovery off)
- Test: `tests/mesh-hardening.test.js` (append two `describe` blocks)

**Interfaces:**
- Consumes: Task 6's transport; `deriveNodeId` (`src/mesh/node-identity.js`).
- Produces:
  - `new MeshTransport({ …, requireClientCert = false, isPinned = null })`; `requireClientCert` with `useTls: false` throws.
  - `transport.attachServer(httpServer, { requireClientCert = this.requireClientCert, isPinned = this.isPinned, path = '/mesh/v1' })`: handles `upgrade` on `path`; with `requireClientCert`, a non-TLS socket or a client certificate whose SHA-256 is not pinned is destroyed before the WebSocket handshake.
  - `transport.connectPinned({ url, pinnedFingerprint, frontdoorId, servername = <url host unless an IP> , timeoutMs = 10000 }) → Promise<peerInfo>`: rejects `{ code: 'frontdoor_key_mismatch', served }` before any application byte is written when the served certificate is not the pin; the authenticated peer's Ed25519 key must derive `frontdoorId`.
  - `auth:*` signatures cover `challenge ‖ exportKeyingMaterial(32, 'EXPORTER-king-louie-mesh-v1')` (empty binding on plain `ws://`). Exports `channelBinding(ws)`, `boundChallenge(challenge, binding)`, `peerCertFingerprint(socket)`, `EXPORTER_LABEL`.
  - With `requireClientCert`, a listener checks the trusted peer's pinned `tlsFingerprint` against the client certificate actually presented.
  - `src/mesh/index.js` exports `MeshChannel`, `MeshRemoteControl`, `MeshDiscovery`, `MeshSwarm` as lazy getters; `initializeMesh({ …, frontDoor })` forces `discovery: false` when `frontDoor` is set.

- [ ] **Step 1: Append the failing tests**

Append to `tests/mesh-hardening.test.js`:

```js
// ── Task 7: TLS-bound authentication and the front-door listener ─────────────
const https = require('https');
const tls = require('tls');
const { execFileSync } = require('child_process');
const path = require('path');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { channelBinding, boundChallenge } = require('../src/mesh/mesh-transport');

async function frontDoorListener({ pinned }) {
  const fd = new NodeIdentity({ nodeName: 'frontdoor' });
  const server = https.createServer({ cert: fd.tlsCert, key: fd.tlsKey, requestCert: true, rejectUnauthorized: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new MeshTransport({ identity: fd, listen: false, useTls: true, requireClientCert: true, isPinned: (fp) => pinned.has(fp) });
  await t.start();
  t.attachServer(server);
  cleanups.push(async () => { await t.stop(); await new Promise((r) => server.close(r)); });
  return { fd, t, url: `wss://127.0.0.1:${server.address().port}/mesh/v1` };
}

async function tlsNode(fd) {
  const node = new NodeIdentity({ nodeName: 'gpu-box' });
  const t = new MeshTransport({ identity: node, listen: false, useTls: true });
  await t.start();
  cleanups.push(() => t.stop());
  t.addTrustedPeer(fd.peerId, fd.publicKey, { tlsFingerprint: fd.tlsFingerprint });
  return { node, t };
}

describe('pinned front-door link', () => {
  it('a pinned node authenticates over TLS with channel binding, both ends on the 60 s window', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const { node, t } = await tlsNode(fd);
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    const peer = await t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId });
    assert.equal(peer.peerId, fd.peerId);
    await waitFor(() => fdT.getPeer(node.peerId), 'the front door to promote the node');
    assert.equal(t.getPeer(fd.peerId).envelopeWindowMs, 60000);
    assert.equal(fdT.getPeer(node.peerId).envelopeWindowMs, 60000);
    const got = once(fdT, 'peerMessage');
    t.send(fd.peerId, { hello: 1 });
    assert.deepEqual((await got)[0].payload, { hello: 1 });
  });

  it('an unpinned client certificate is dropped before any frame is parsed', async () => {
    const { fd, url } = await frontDoorListener({ pinned: new Set() });
    const { t } = await tlsNode(fd);
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = function parse(...args) { parses += 1; return realParse.apply(this, args); };
    try {
      await assert.rejects(t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId }));
    } finally {
      JSON.parse = realParse;
    }
    assert.equal(parses, 0);
  });

  it('the pinned peer key must derive the front door id', async () => {
    const pinned = new Set();
    const { fd, t: fdT, url } = await frontDoorListener({ pinned });
    const { node, t } = await tlsNode(fd);
    pinned.add(node.tlsFingerprint);
    fdT.addTrustedPeer(node.peerId, node.publicKey, { tlsFingerprint: node.tlsFingerprint });
    await assert.rejects(t.connectPinned({ url, pinnedFingerprint: fd.tlsFingerprint, frontdoorId: 'kl-c2ubd6jjqumalzt5' }), /front door id/);
  });

  it('a certificate that is not the pin: frontdoor_key_mismatch, and not one application byte written', async () => {
    const other = new NodeIdentity({ nodeName: 'impostor' });
    let appBytes = 0;
    const server = tls.createServer({ cert: other.tlsCert, key: other.tlsKey }, (socket) => {
      socket.on('data', (d) => { appBytes += d.length; });
      socket.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    const t = new MeshTransport({ identity: node, listen: false, useTls: true });
    await t.start();
    cleanups.push(() => t.stop());
    const pin = crypto.randomBytes(32).toString('hex');
    await assert.rejects(
      t.connectPinned({ url: `wss://127.0.0.1:${server.address().port}/mesh/v1`, pinnedFingerprint: pin, frontdoorId: 'kl-c2ubd6jjqumalzt5' }),
      (err) => err.code === 'frontdoor_key_mismatch' && err.served === other.tlsFingerprint
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(appBytes, 0);
  });

  it('a signature bound to one TLS session does not verify on another', async () => {
    const pinned = new Set();
    const { fd, url } = await frontDoorListener({ pinned });
    const node = new NodeIdentity({ nodeName: 'gpu-box' });
    pinned.add(node.tlsFingerprint);
    const port = Number(new URL(url).port);
    const bindings = [];
    for (let i = 0; i < 2; i += 1) {
      const ws = new WebSocket(url, { cert: node.tlsCert, key: node.tlsKey, rejectUnauthorized: false });
      await once(ws, 'open');
      bindings.push(channelBinding(ws));
      ws.terminate();
    }
    assert.equal(bindings[0].length, 32);
    assert.notDeepEqual(bindings[0], bindings[1]);
    const challenge = crypto.randomBytes(32);
    const sig = fd.signChallenge(boundChallenge(challenge, bindings[0]));
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(challenge, bindings[0]), sig, fd.publicKey), true);
    assert.equal(MeshIdentity.verifyChallenge(boundChallenge(challenge, bindings[1]), sig, fd.publicKey), false);
    assert.ok(port > 0);
  });

  it('requireClientCert refuses plain ws:// and pair:request', async () => {
    const id = new MeshIdentity({ displayName: 'x' });
    assert.throws(() => new MeshTransport({ identity: id, listen: false, useTls: false, requireClientCert: true }), /requireClientCert needs TLS/);
  });
});

describe('service mode never loads mDNS or the remote-control mesh', () => {
  it('requiring src/mesh loads neither mesh-discovery nor mesh-swarm', () => {
    const out = execFileSync(process.execPath, ['-e', `
      require('./src/mesh');
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, KING_LOUIE_LOG_LEVEL: 'silent' } }).toString();
    const loaded = JSON.parse(out).map((p) => p.split(path.sep).join('/'));
    for (const m of ['mesh-discovery', 'mesh-swarm', 'mesh-remote-control', 'mesh-channel']) {
      assert.ok(!loaded.some((p) => p.endsWith(`src/mesh/${m}.js`)), `${m} was loaded`);
    }
  });

  it('initializeMesh with frontDoor set keeps discovery off', async () => {
    const { initializeMesh } = require('../src/mesh');
    const store = { data: {}, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
    const cipher = { encryptString: (s) => `enc:${s}`, decryptString: (s) => s.slice(4) };
    const mesh = await initializeMesh({ store, cipher, frontDoor: true, settings: { mesh: { port: 0, host: '127.0.0.1', useTls: false, discovery: true } } });
    cleanups.push(() => mesh.shutdown());
    assert.equal(mesh.discovery.enabled, false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/mesh-hardening.test.js`
Expected: FAIL — `channelBinding is not a function` for the Task 7 block (Task 6's blocks still pass).

- [ ] **Step 3: Requires and TLS helpers**

In `src/mesh/mesh-transport.js`, below `const https = require('https');` add:

```js
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
```

and below `const { MeshIdentity } = require('./mesh-identity');` add:

```js
const { deriveNodeId } = require('./node-identity');
```

After `parsePreAuthFrame` (Task 6) add:

```js
// §3.10 item 4: auth signatures cover challenge ‖ TLS exporter, so a signed
// auth message is worthless on any other TLS session. Plain ws:// (desktop
// LAN tests only) has no exporter and binds to nothing.
const EXPORTER_LABEL = 'EXPORTER-king-louie-mesh-v1';

function channelBinding(ws) {
  const socket = ws && ws._socket;
  if (!socket || typeof socket.exportKeyingMaterial !== 'function') return Buffer.alloc(0);
  try {
    return socket.exportKeyingMaterial(32, EXPORTER_LABEL);
  } catch {
    return Buffer.alloc(0);
  }
}

function boundChallenge(challenge, binding) {
  return Buffer.concat([Buffer.from(challenge), Buffer.from(binding)]);
}

function peerCertFingerprint(socket) {
  try {
    const cert = socket && typeof socket.getPeerX509Certificate === 'function' ? socket.getPeerX509Certificate() : null;
    return cert ? crypto.createHash('sha256').update(cert.raw).digest('hex') : null;
  } catch {
    return null;
  }
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
```

- [ ] **Step 4: Constructor and own listener**

In the constructor, replace the Task 6 line `this.requireClientCert = config.requireClientCert === true;` with:

```js
    this.requireClientCert = config.requireClientCert === true;
    if (this.requireClientCert && !this.useTls) {
      throw new Error('requireClientCert needs TLS: plain ws:// is only allowed with requireClientCert: false');
    }
    // (fingerprintHex) → boolean: is this client certificate pinned? Without
    // one, the trusted peers' pinned tlsFingerprints decide.
    this.isPinned = typeof config.isPinned === 'function' ? config.isPinned : null;
    this.attached = [];
```

In `start()`, replace the TLS-mode server construction:

```js
      this.httpsServer = https.createServer({
        cert: this.identity.tlsCert,
        key: this.identity.tlsKey,
        requestCert: this.requireClientCert,
        rejectUnauthorized: false
      });

      this.server = new WebSocket.Server({
        server: this.httpsServer,
        maxPayload: MAX_PAYLOAD_BYTES,
        ...(this.requireClientCert ? { verifyClient: ({ req }) => this._pinnedSocket(req.socket) } : {})
      });
```

- [ ] **Step 5: Pinned client certificates and channel binding in the handshake**

In `_handleInboundConnection`, right after `ws.once('close', () => this.unauth.delete(ws));` add:

```js
    // The client certificate this socket presented (front door: pinned in
    // TLS already); _respondToChallenge checks it against the peer's pin.
    ws.klClientFingerprint = req && req.socket ? peerCertFingerprint(req.socket) : null;
```

Replace `_respondToChallenge(ws, msg)` from its first line through the `ws.send(JSON.stringify({ type: 'auth:response', … }));` call with:

```js
  _respondToChallenge(ws, msg) {
    const { authId, challenge, identity: remoteIdentity } = msg;
    const reject = (reason) => {
      try { ws.send(JSON.stringify({ type: 'auth:reject', reason })); } catch { /* gone */ }
      try { ws.close(CLOSE_CODES.unauthenticated, reason); } catch { /* gone */ }
    };

    const trusted = this.trustedPeers.get(remoteIdentity.peerId);
    if (!trusted) return reject('not_trusted');

    if (this.requireClientCert) {
      // The certificate actually presented must be the one pinned for this
      // Ed25519 key (both pins tie together here, §4.17).
      if (!trusted.tlsFingerprint || !timingSafeHexEqual(trusted.tlsFingerprint, ws.klClientFingerprint)) {
        log.warn(`client certificate for ${remoteIdentity.peerId} is not the pinned one`);
        return reject('tls_fingerprint_mismatch');
      }
    } else if (this.useTls && trusted.tlsFingerprint && remoteIdentity.tlsFingerprint && trusted.tlsFingerprint !== remoteIdentity.tlsFingerprint) {
      log.warn(`TLS fingerprint mismatch for ${remoteIdentity.peerId} - possible impersonation`);
      return reject('tls_fingerprint_mismatch');
    }

    const binding = channelBinding(ws);
    const signature = this.identity.signChallenge(boundChallenge(Buffer.from(challenge, 'hex'), binding));
    const myChallenge = this.identity.generateChallenge();

    this.pendingAuth.set(authId, {
      ws,
      challenge: myChallenge,
      binding,
      remoteIdentity,
      direction: 'inbound',
      timeout: setTimeout(() => {
        this.pendingAuth.delete(authId);
        try { ws.close(CLOSE_CODES.unauthenticated, 'auth_timeout'); } catch { /* gone */ }
      }, AUTH_TIMEOUT_MS)
    });

    ws.send(JSON.stringify({
      type: 'auth:response',
      authId,
      signature: signature.toString('hex'),
      challenge: myChallenge.toString('hex'),
      identity: this.identity.getPublicIdentity()
    }));
```

(the listener block Task 6 wrote at the end of the method stays.)

In `_handleAuthResponse`, replace the block from `const valid = MeshIdentity.verifyChallenge(` through the `pending.ws.send(JSON.stringify({ type: 'auth:complete', … }));` call with:

```js
    // connectPinned: the authenticated key must be the front door's own.
    if (pending.expectNodeId) {
      let derived = null;
      try { derived = deriveNodeId(trusted.publicKey); } catch { derived = null; }
      if (derived !== pending.expectNodeId) {
        pending.ws.close();
        this.pendingAuth.delete(authId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(`the peer key does not derive the pinned front door id ${pending.expectNodeId}`));
        return;
      }
    }

    const binding = channelBinding(pending.ws);
    const valid = MeshIdentity.verifyChallenge(boundChallenge(pending.challenge, binding), signature, trusted.publicKey);

    if (!valid) {
      pending.ws.close();
      this.pendingAuth.delete(authId);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Challenge verification failed'));
      return;
    }

    const mySignature = this.identity.signChallenge(boundChallenge(Buffer.from(theirChallenge, 'hex'), binding));

    pending.ws.send(JSON.stringify({
      type: 'auth:complete',
      authId,
      signature: mySignature.toString('hex')
    }));
```

In `_handleAuthComplete`, replace the `MeshIdentity.verifyChallenge(pending.challenge, signature, trusted.publicKey)` call with:

```js
    const valid = MeshIdentity.verifyChallenge(
      boundChallenge(pending.challenge, pending.binding || Buffer.alloc(0)),
      signature,
      trusted.publicKey
    );
```

Change the `_initiateAuth` signature and its `pendingAuth.set(...)` so extra options ride along:

```js
  _initiateAuth(ws, address, port, timeout, resolve, reject, serverCertFingerprint, extra = {}) {
```

```js
    this.pendingAuth.set(authId, {
      ws,
      challenge,
      address,
      port,
      timeout,
      resolve,
      reject,
      direction: 'outbound',
      serverCertFingerprint,
      expectNodeId: extra.expectNodeId || null,
      frontDoorLink: extra.frontDoorLink === true
    });
```

- [ ] **Step 6: `attachServer`, `connectPinned`, `_pinnedSocket`**

Add these methods after `connectToPeer`:

```js
  _pinnedSocket(socket, isPinned = this.isPinned) {
    const fp = peerCertFingerprint(socket);
    if (!fp) return false;
    if (isPinned) return isPinned(fp) === true;
    for (const p of this.trustedPeers.values()) if (p.tlsFingerprint && timingSafeHexEqual(p.tlsFingerprint, fp)) return true;
    return false;
  }

  // §3.10 item 8: serve the mesh on a listener someone else owns (the front
  // door's SNI router hands its `mesh.` sockets to `httpServer`). With
  // requireClientCert, an unpinned or missing client certificate never gets
  // as far as the WebSocket handshake.
  attachServer(httpServer, { requireClientCert = this.requireClientCert, isPinned = this.isPinned, path: wsPath = '/mesh/v1' } = {}) {
    const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = null;
      try { pathname = new URL(req.url, 'http://mesh.invalid').pathname; } catch { pathname = null; }
      if (pathname !== wsPath) {
        socket.destroy();
        return;
      }
      if (requireClientCert && (!socket.encrypted || !this._pinnedSocket(socket, isPinned))) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this._handleInboundConnection(ws, req));
    });
    this.attached.push(wss);
    return wss;
  }

  // §3.9: dial the front door with this node's certificate; the served
  // certificate must be the pin before one application byte is written.
  async connectPinned({ url, pinnedFingerprint, frontdoorId, servername = null, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'wss:') throw new Error('connectPinned needs a wss:// URL');
    if (!/^[0-9a-f]{64}$/.test(String(pinnedFingerprint))) throw new Error('connectPinned needs a hex SHA-256 certificate pin');
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || 443;
    const sni = servername || (net.isIP(host) ? undefined : host);
    const socket = await new Promise((resolve, reject) => {
      const s = tls.connect({
        host,
        port,
        ...(sni ? { servername: sni } : {}),
        cert: this.identity.tlsCert,
        key: this.identity.tlsKey,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        ALPNProtocols: ['http/1.1']
      });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`connection timeout to ${url}`)); }, timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        const served = peerCertFingerprint(s);
        if (!served || !timingSafeHexEqual(served, pinnedFingerprint)) {
          s.destroy();
          reject(Object.assign(new Error(`frontdoor_key_mismatch: ${url} served ${served || 'no certificate'}, pinned ${pinnedFingerprint}`), { code: 'frontdoor_key_mismatch', served }));
          return;
        }
        resolve(s);
      });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { createConnection: () => socket, maxPayload: MAX_PAYLOAD_BYTES });
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch { /* gone */ }
        reject(new Error(`authentication timeout to ${url}`));
      }, timeoutMs);
      ws.on('open', () => this._initiateAuth(ws, null, null, timeout, resolve, reject, pinnedFingerprint, { expectNodeId: frontdoorId, frontDoorLink: true }));
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }
```

In `stop()`, before the `if (this.server) { … }` block add:

```js
    for (const wss of this.attached) await new Promise((resolve) => wss.close(() => resolve()));
    this.attached = [];
```

Replace the exports line with:

```js
module.exports = {
  MeshTransport,
  DEFAULT_PORT,
  MAX_PAYLOAD_BYTES,
  PRE_AUTH_MAX_BYTES,
  CLOSE_CODES,
  EXPORTER_LABEL,
  parsePreAuthFrame,
  channelBinding,
  boundChallenge,
  peerCertFingerprint
};
```

- [ ] **Step 7: Lazy mesh modules and `frontDoor` in `src/mesh/index.js`**

Replace the top requires of `src/mesh/index.js`:

```js
const { MeshIdentity, saveIdentity, loadIdentity } = require('./mesh-identity');
const { MeshTransport, DEFAULT_PORT } = require('./mesh-transport');
const { MeshPairing } = require('./mesh-pairing');
const { createLogger } = require('../logging');
const log = createLogger('mesh');
// MeshChannel, MeshRemoteControl, MeshDiscovery and MeshSwarm are loaded only
// when a desktop actually starts the mesh (fleet stage 4 §3.10 items 5–6):
// no service profile ever requires them.
```

In `initializeMesh`, add at the top of the function body (before `const { store, … } = config;`):

```js
  const { MeshChannel } = require('./mesh-channel');
  const { MeshRemoteControl } = require('./mesh-remote-control');
  const { MeshDiscovery } = require('./mesh-discovery');
  const { MeshSwarm } = require('./mesh-swarm');
```

Replace `const meshSettings = settings.mesh || {};` with:

```js
  // A node linked to a front door never advertises itself on mDNS.
  const meshSettings = config.frontDoor ? { ...(settings.mesh || {}), discovery: false } : (settings.mesh || {});
```

Replace `module.exports = { … };` with:

```js
module.exports = {
  MeshIdentity,
  MeshTransport,
  MeshPairing,
  get MeshChannel() { return require('./mesh-channel').MeshChannel; },
  get MeshRemoteControl() { return require('./mesh-remote-control').MeshRemoteControl; },
  get MeshDiscovery() { return require('./mesh-discovery').MeshDiscovery; },
  get MeshSwarm() { return require('./mesh-swarm').MeshSwarm; },
  initializeMesh,
  DEFAULT_PORT
};
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/mesh-hardening.test.js tests/mesh-transport.test.js tests/mesh-pairing.test.js tests/mesh-identity.test.js tests/mesh-remote-control.test.js tests/approvals-relay-client.test.js tests/approvals-link-rpc.test.js tests/frontdoor-relay.test.js tests/approvals-e2e.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/mesh/mesh-transport.js src/mesh/index.js tests/mesh-hardening.test.js
git commit -m "feat(mesh): channel-bound auth, pinned client certificates, attachServer and connectPinned" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 2

Part 1 leaves, on `feat/fleet-stage4`: the client-grant-v1 shapes, checks, vectors and document; the scope rules and `ScopeRegistry`; the `frontdoor`/`delegate` configuration and the `frontdoor` profile name; the front-door example; and the hardened mesh (`attachServer`, `connectPinned`, `requireClientCert`, close codes, `peer_busy`). Nothing is wired into a running service yet. Part 2 (`docs/superpowers/plans/2026-09-23-fleet-stage4-front-door-part2.md`) builds the node fleet host on top: evidence, the extracted `FleetToolHandler`, delegate sessions, `NodeFleetService`, `startFleetNode`, the courier-routed `mcp` command and the node's front-door link.
