# Fleet Stage 4: Front door — Design Spec

- **Status:** Draft (fix round 1)
- **Date:** 2026-09-23
- **Parent:** `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md` §7, §8, §9, §10, §11, §5.1, §4.3, §13 Q1/Q3
- **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md` (extends §4.13; owns §4.18 and §4.19; consumes §4.12, §4.15, §4.16, §4.17; leaves hooks for §4.14; adds `client-grant-v1` to §4.15; rulings 2, 7, 8, R10, R11, R17, R21–R26)
- **F3 spec bound:** `docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md` (cited as "F3 §n")
- **Depends on:** F3 (merged code), F2 (merged), F6's strict `loadNodeConfig` (R11)

## 1. Outcome

The owner runs one `king-louie-service` with `profile: frontdoor` on a small Linux VPS. It gets a
Let's Encrypt certificate for `mcp.<domain>` and listens on 443 only.

- Claude, ChatGPT and Perplexity connect to `https://mcp.<domain>/mcp` as remote MCP clients. The
  owner approves each connection on the phone by typing the code the browser shows, and the phone
  signs the exact client, redirect and scopes.
- Each node pairs once and keeps one pinned, mutually authenticated connection to `mesh.<domain>`.
  It serves the §8.2 tools remotely, including multi-turn `delegate` sessions on agent nodes.
- Runbook nodes host their job engine in the service itself, whether or not a front door is set.
- Each node's audit ledger is mirrored and chain-checked on the front door.

Nothing the front door does can make a node run something that the node's own policy and the
owner's phone would not allow.

## 2. Scope

### 2.1 In

- **`profile: frontdoor`.** Module graph, startup checks and `frontdoor.*` config. F3's relay runs inside it, mounted on the 443 listener.
- **Console bootstrap (R22):** `frontdoor enroll-device`, `frontdoor code`, `frontdoor nodes`, `frontdoor remove-node`, `frontdoor rotate-tls-key`.
- **One listener on 443 that routes by SNI.** It reads the ClientHello first, gets an ACME certificate through TLS-ALPN-01 with a stable key (R21) plus a signed re-pin, and checks the client certificate pin on `mesh.` during the handshake.
- **OAuth 2.1 authorization server.** RFC 9728, RFC 8414, RFC 7591, client ID metadata documents and PKCE S256. It includes the consent page, the typed-code phone grant (R23), opaque tokens, refresh rotation with reuse detection, and revocation.
- **MCP Streamable HTTP endpoint** serving the §8.2 tools filtered by scope, plus progress on long-poll `get_job`.
- **Router, node registry and job cache.**
- **Node fleet host** (`src/fleet/`): `run --profile runbook|agent` always hosts `RunbookEngine`/`JobManager` headless. It adds `get_job.evidence`, and `mcp` routes through the service when one runs (R24). `mcp` on a runbook node never loads `src/core`.
- **Node-side `delegate` / `send_to_job` sessions** (R10, program §4.18).
- **Mesh hardening** (parent §7.3, ruling 8).
- **Finishing pairing:** `pair https://…`, codes, pinning in both directions and fingerprint display.
- **Audit mirror**, including serving signed history.
- **Alerts, self-probe, polling endpoints and `doctor` checks.**
- **Deployment doc:** `docs/fleet/front-door.md`.
- **Protocol:** `docs/protocol/client-grant-v1.md` and its vectors.
- **Mobile screens** for the new messages.
- **Config keys:** `frontdoor` and `delegate` are registered in `NODE_YAML_KEYS` (R11).

### 2.2 Out

| Item | Owner |
|---|---|
| MCP case tools under `cases:read` / `cases:write` | C7 (§4.14). F4 ships the registration hooks (§5.2) |
| `delegate(…, case)` argument | C7 §3.8 (later) |
| Lease relay, lease view, `LeaseManager` | F5. F4 only calls `endForJob` (§3.8) |
| Approval protocol, `PhoneApprover`, approver store, phone API base, push transport, audit ledger | F3 |
| Install-guide chapters 10–12 | F6 (links to `docs/fleet/front-door.md`) |
| Desktop UI for fleet state | F7 |

## 3. Design

### 3.1 Profile, relay and startup — `src/frontdoor/profile.js`, `src/frontdoor/config.js`

`startFrontDoor({ dataDir, configDir, nodeConfig, serviceConfig }) → { stop() }`. `run.js`
`loadProfile('frontdoor')` requires only this module.

**F3's relay inside the front door.** `startFrontDoor` calls F3's `startRelay` with the
external-listener extension (§5.1 E1). F4 gets back three things and wires them up:

- **Phone API.** `phoneApiHandler`, F3's `/v1/*` routes, is mounted on the `mcp.` HTTP server (§3.2). F4's own `/v1/*` routes are registered through `registerRoute` (E2), so all of them use F3's `X-KL-*` device auth.
- **Node hub.** `nodeHub`'s `MeshTransport` is attached to the `mesh.` socket stream with `attachServer` (§3.10). Its trusted peers come from F4's `NodeRegistry` (E3).
- **Pusher.** F3's pusher is reused, with the `kind` variant (E4).

`relay run` (F3 profile) is unchanged. `relay.*` keys in `service.json` on the frontdoor profile:

| Key | On `frontdoor` |
|---|---|
| `relay.public_url` | **derived**: `https://mcp.<domain>`. Setting it is refused |
| `relay.tls`, `relay.phone_listen`, `relay.mesh_listen` | **forbidden** (`the frontdoor profile uses one 443 listener; remove relay.<key>`) |
| `relay.push.apns`, `relay.push.fcm` | **used as is**. Optional: without push, the phone polls (§3.13) |
| `audit.retention_days` | the front door's own ledger (F3). The mirror uses `frontdoor.audit.retention_days` |

**F3 commands on the front door.** F3's `relay code`, `relay nodes` and `relay remove-node` are
refused on the frontdoor profile. Each refusal names its `frontdoor …` counterpart (§3.11).
`relay qr` still prints F3's `kl.relay` re-pin QR, with `relay = https://mcp.<domain>` and the
current leaf SPKI.

**F3 node records.** Records in F3's `<relayData>/relay/nodes.json` carry no phone signature. They
are **not migrated**, and startup logs one `warn` listing them. Each node runs `pair https://…`
once (§3.11), which replaces its F3 relay pin (§3.9).

**Module graph.** The frontdoor graph never requires:
- `src/core/create-core.js`, `src/providers/`, `src/execution/`, `src/tools/`
- `src/runbooks/`, `src/browser/`, `src/channels/`
- `src/mcp/mcp-client.js`
- `src/mesh/mesh-discovery.js`, `src/mesh/mesh-remote-control.js`, `src/mesh/mesh-swarm.js`

It uses `buildServicePorts`, `getOrGenerateNodeIdentity` (its `nodeId` is `frontdoor_id`), F3's
`ApproverStore` over `<configDir>/approvers/` (R25), `src/platform/jcs.js` (R17) and
`src/approvals/envelope.js`.

**Startup checks.** They run in this order. Each refusal message is exact:

| # | Check | Result |
|---|---|---|
| 1 | Admin `service.json` `profile` and `node.yaml` `profile` both `frontdoor` | refuse `profile mismatch: service.json says "<a>", node.yaml says "<b>"` |
| 2 | `frontdoor.domain` is a lowercase DNS name with ≥2 labels, not an IP | refuse `frontdoor.domain must be a DNS name` |
| 3 | Exactly one TLS source: `frontdoor.acme` (with `terms_agreed: true`) or `frontdoor.tls` | refuse `configure frontdoor.acme or frontdoor.tls, not both/neither` |
| 4 | `features.*` all false; no forbidden `relay.*` key | refuse (the messages above) |
| 5 | The listener binds `frontdoor.listen` | refuse `cannot bind <host>:<port>: <err>` |
| 6 | Registry load (§3.6): every record verifies | a bad record is quarantined to `nodes.rejected.json`, and the alert `node_record_invalid` fires |
| 7 | `ApproverStore.activeCount() > 0` | not fatal. Logs `warn` `No phone enrolled on this front door: run "king-louie-service frontdoor enroll-device"`, and `doctor` FAILs with the same text |

### 3.2 SNI listener — `src/frontdoor/tls/sni-listener.js`, `client-hello.js`

`SniListener({ host, port, domain, mcpContext(), meshContext, isPinnedNodeCert(fpHex), isProbeCert(fpHex), acmeChallenge(servername), onMcpSocket(tls), onMeshSocket(tls) })`.

**Why not `SNICallback`.** `requestCert` applies to the whole server. If the whole server asked for
client certificates, browsers visiting `mcp.` would show a picker.

**Peeking at the ClientHello.** For each accepted `net.Socket`:
1. Accumulate bytes on `data` until the whole handshake message is buffered. TLS records are reassembled, so a ClientHello split across records works. Limits are **16 KiB total** and **5 s**; past either, the socket is destroyed.
2. `parseClientHello(buf)` returns `{ incomplete: true }`, `{ serverName, alpn: string[] }`, or throws. It walks record headers, the handshake header, and extensions 0 (`server_name`) and 16 (ALPN). Every length is bounds-checked.
3. Hand the socket over: `pause()`, `removeListener('data', …)`, `unshift(buf)`, then wrap it in `new tls.TLSSocket(socket, { isServer: true, … })`.

**Routing:**

| `serverName` | Condition | TLS options | Then |
|---|---|---|---|
| `mcp.<domain>` | ALPN has `acme-tls/1` and `acmeChallenge()` returns one | challenge `secureContext`, `ALPNProtocols: ['acme-tls/1']` | end after the handshake |
| `mcp.<domain>` | `mcpContext()` is `null` (first boot, no certificate yet) | — | destroy |
| `mcp.<domain>` | otherwise | `secureContext: mcpContext()`, `ALPNProtocols: ['http/1.1']`, `requestCert: false` | `onMcpSocket` → `httpServer.emit('connection', s)` |
| `mesh.<domain>` | — | `secureContext: meshContext` (the front door's self-signed identity cert), `requestCert: true`, `rejectUnauthorized: false`, `ALPNProtocols: ['http/1.1']` | see below |
| other or none | — | — | destroy |

**Mesh handshake.** On `secure`, which fires after the handshake and before anything reads from the
socket, compute `fp = sha256(getPeerX509Certificate().raw).hex`:
- **No certificate, or not pinned:** `destroy()`. The attempt counts toward `unknown_node_key` (§3.13).
- **`isProbeCert(fp)`:** the self-probe's connection (§3.13). Close it at once; it never reaches WS code.
- **Otherwise:** `onMeshSocket(s)`.

**Limits.** 1024 sockets overall and 32 per IP. The TLS handshake has 10 s. A new connection has
60 s to send its first HTTP request before it is closed.

### 3.3 ACME and the stable key — `src/frontdoor/tls/acme.js`

`AcmeManager({ domain, email, directoryUrl, store, cipher, alerts, now, client })` has
`start()`, `currentContext()`, `challengeFor(servername)`, `status()` and `rotateKey()`.

- **Library.** `acme-client` (§14), TLS-ALPN-01 only (RFC 8737). Port 80 stays closed, which is trust principle 4. `client` is injectable for tests.
- **Stable key (R21).** The `mcp.` certificate key is ECDSA P-256. It is generated once, stored under `cipher.encryptString` in `acme/cert-key.json`, and reused for every renewal. F3's phones pin the leaf SPKI (F3 §3.13), so renewal never breaks them. The account key is also P-256 and stored encrypted.
- **When to renew.** When a third of the certificate's lifetime remains, checked every 12 h, and at startup and on `SIGHUP`. Failures back off 1 h, 2 h, 4 h, then every 12 h. That keeps well under the CA's failed-validation limits. The old certificate is served until a new one is issued, and the context swap is atomic.
- **First boot.** Until the first issuance, `mcpContext()` is `null` and `mcp.` serves only the challenge. `mesh.` works from the start.
- **Operator TLS.** `frontdoor.tls.{cert_file,key_file}` replaces ACME. The files are re-read on `SIGHUP` and every 12 h. If the leaf SPKI changes, the front door logs `error` and raises `tls_key_changed`: phones must re-pin, by `relay qr` or §3.3.1.

#### 3.3.1 Signed re-pin (recovery for a compromised key)

`king-louie-service frontdoor rotate-tls-key` (admin, service running, sent through F3's courier):

1. `AcmeManager.rotateKey()` makes a new key and orders a certificate with it.
2. Once that certificate is issued, the front door signs `kl.relay.repin` (§4.5) with its Ed25519 identity key and serves it at `GET /v1/repin`. This route is unauthenticated.
3. When a phone's SPKI pin fails on `mcp.`, the app makes exactly one request to `GET /v1/repin`, ignoring the pin. It re-pins only if all of these hold:
   - the envelope verifies against the front-door key it pinned from the `kl.pair` QR (`node.key`, where `node.id == frontdoor_id`, §3.11);
   - `new_spki` equals the SPKI of the certificate it just received;
   - `old_spki` equals its current pin.

   Anything else shows F3's "Relay certificate changed — scan a new relay code".

### 3.4 OAuth authorization server — `src/frontdoor/oauth/*`

**Endpoints** on `mcp.<domain>`. `Host` must equal the SNI, or the answer is `421`. Bodies are
capped at 64 KiB.

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource`, `…/oauth-protected-resource/mcp` | RFC 9728: `{ resource: "https://mcp.<domain>/mcp", authorization_servers: ["https://mcp.<domain>"], scopes_supported, bearer_methods_supported: ["header"] }` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 (below) |
| `POST /oauth/register` | RFC 7591 |
| `GET /oauth/authorize` | creates a pending authorization and shows the consent page |
| `GET /oauth/authorize/wait?id=` | poll target (`<meta http-equiv="refresh" content="3">`, no JS) |
| `POST /oauth/token` | `authorization_code`, `refresh_token` |
| `POST /oauth/revoke` | RFC 7009 |

AS metadata fields: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
`revocation_endpoint`, `response_types_supported: ["code"]`,
`grant_types_supported: ["authorization_code","refresh_token"]`,
`code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
`scopes_supported`, `client_id_metadata_document_supported: true`.

**Clients (`ClientRegistry`).** All clients are public.

- *Dynamic registration* accepts:
  - `client_name` and `redirect_uris`;
  - `grant_types` ⊆ {`authorization_code`, `refresh_token`} and `response_types = [code]`;
  - `token_endpoint_auth_method = none`. Anything else is `invalid_client_metadata`.

  It returns `client_id = dcr_` followed by 22 b64url characters. There are at most 10
  registrations per IP per hour and 100 clients without a grant. A client with no grant after 24 h
  is purged.
- *Client ID metadata documents* (`cimd.js`) are fetched only under these limits:
  - `https:` on port 443, no redirects, 5 s timeout, 64 KiB cap, JSON body;
  - the address the name resolves to must be public (not loopback, private, link-local, CGNAT, ULA or multicast), and the connection goes to that resolved IP;
  - the document's `client_id` must equal the URL.

  Documents are cached for 24 h.
- *Redirect URIs* are matched as exact strings. They must be `https:`, or loopback
  `http://127.0.0.1` / `[::1]` / `localhost` on any port (RFC 8252 §7.3). A URI with a fragment is
  rejected. On a mismatch the front door shows an error page and never redirects.

**Authorize (`authorize.js`).**

- Required parameters: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (43–128 characters) and `code_challenge_method=S256`. `plain` is refused.
- `state` is optional. OAuth 2.1 with PKCE does not require it; when present it is echoed.
- `resource`, when present, must equal `https://mcp.<domain>/mcp`; when absent it defaults to that value.
- A missing `scope` means `scopes_supported`.

**Pending authorizations (R23).** They live in memory with a 10 min TTL on the front door's clock,
under these caps:
- 3 new per IP per 10 min;
- 1 per client host (the host of the CIMD `client_id` URL, or of `redirect_uri`). A newer one replaces an older *unclaimed* one;
- 50 overall. When full, the oldest unclaimed one is evicted. A **claimed** one (looked up by the phone) is never evicted.

Each pending authorization gets:
- a **`user_code`**: 6 Crockford base32 characters, shown as `XXX-XXX`;
- the cookie `kl_authz=<32 random bytes b64url>; HttpOnly; Secure; SameSite=Lax; Path=/oauth`. The wait page requires it, so only the browser that started the flow can collect the code.

**No push is sent for grants.** The owner is at the browser, so push would only add an attack
surface (push-bombing).

**Consent page.** Response headers:
- `Content-Security-Policy: default-src 'none'; style-src 'self'; frame-ancestors 'none'`
- `Cache-Control: no-store`
- `Referrer-Policy: no-referrer`

It shows the client name marked "(self-declared)", the client host, the redirect host, the
requested scopes and the `user_code`. It asks the owner to "Open King Louie on your phone → Connect
a client → type this code". There is no password.

**The phone's decision.**

1. The owner types the code. The app calls `GET /v1/grants/pending?user_code=XXXXXX` (device-authenticated, 10 per minute per device; a miss gives `404`). That marks the pending authorization claimed and returns its details.
2. The owner may narrow the scopes or add `machines=`, then signs `kl.client.grant` (§4.2) with the typed `user_code` inside, and posts it to `POST /v1/grants/{grant_id}/decision`.
3. The front door accepts it only if all of these hold:
   - F3's `open(envelope)` succeeds, `alg = ES256` and `kid = device_id`;
   - `ApproverStore.isActive(device_id)` holds and `verifyEs256(envelope, record.public_key)` passes;
   - `frontdoor_id`, `grant_id`, `client_id`, `redirect_uri`, `resource`, `code_challenge` and `user_code` equal the pending authorization's values;
   - the pending authorization has not expired on the **front door's clock** (`signed_at` is recorded and never judged);
   - the scopes are a subset of `scopes_supported`, and `fleet:unsafe` is accompanied by `fleet:run` or `fleet:delegate` (otherwise `invalid_scope`).

**What the front door issues.** It creates a **Grant**, recording `accepted_at` on its own clock,
and an authorization code:
- 32 random bytes, single use, 60 s, stored as a SHA-256 hash;
- a second use of the code revokes the grant.

**Tokens (`tokens.js`, `TokenStore`) are opaque.** The resource server is the same process as the
authorization server, and revocation must take effect immediately.

| Token | Format | Lifetime | Stored |
|---|---|---|---|
| Access | `kla_` + 32 random bytes b64url | 1 h (`access_token_ttl`) | SHA-256 → `{ grant_id, client_id, scopes, aud, exp }` |
| Refresh | `klr_` + 32 random bytes b64url | 30 d idle (`refresh_token_idle_ttl`), rotated on every use | SHA-256 → `{ grant_id, generation, state: live\|rotated\|superseded, successor, graced }` |

- **`authorization_code` grant.** Needs `code`, the exact `redirect_uri`, `client_id`, `code_verifier` (where `BASE64URL(SHA256(verifier)) == code_challenge`) and the same `resource`.
- **`refresh_token` grant.** Needs `client_id` equal to the grant's client. It may narrow `scope`.
- **Reuse detection.** A `rotated` token presented again revokes the grant and all its tokens and sessions, and raises `refresh_reuse`. There is one exception, the **grace** rule. It applies once per rotation and only when:
  - it is within 30 s of the rotation;
  - the successor has never been used;
  - the token's `graced` is false.

  Then the successor and the access token issued with it become `superseded`, and a new pair is issued.
- **Superseded tokens.** Presenting one counts as reuse and revokes the grant. So does refreshing again after the grace was used.

**Revocation.** The phone signs `kl.client.revoke` (§4.2), bound to a front-door challenge (§4.6),
and posts it to `POST /v1/clients/{grant_id}/revoke`. That revokes the grant, its tokens and its
MCP sessions at once. Clients may also use `/oauth/revoke`. Jobs already started keep running; they
belong to the node.

**On load**, `grants.json` records whose `signed_grant` no longer verifies are dropped with an alert
`node_record_invalid`. The kind name is shared with nodes, and its `subject` is `grant:<id>`.

**Revoked devices (R25).** A grant or node enrollment signed by a device stays valid after that
device is revoked if `accepted_at < revoked_at`. `revoked_at` comes from the admin-owned approver
file. Revoking a device never silently disconnects clients; the owner revokes clients separately.

**Scopes (`scopes.js`, `ScopeRegistry`).** `register(name, { tools, description, requires? })`.

| Scope | Tools | Enforced |
|---|---|---|
| `fleet:read` | `list_machines`, `describe_machine`, `get_state`, `get_job`, `get_job_logs` | router + node |
| `fleet:run` | `run_runbook` (read/routine), `cancel_job` | router + node |
| `fleet:unsafe` | unsafe-tier `run_runbook`. Lets `delegate` sessions *request* unsafe calls; without it they are refused without asking | grant acceptance (`requires`), router, node, delegate session (§3.8) |
| `fleet:delegate` | `delegate`, `send_to_job` | router + node |

C7 registers `cases:read` / `cases:write`. A scope is advertised only once it is registered and
listed in `frontdoor.oauth.scopes_enabled`.

**Scope strings** take the form `<scope>` or `<scope>;machines=<n>[,<n>…]`. Names are sorted and
unique, matching `^[a-z0-9][a-z0-9._-]{0,62}$`.

**Per-client defaults.** `frontdoor.oauth.client_defaults` matches on client host, never on
`client_name`. It only **preselects** scopes on the phone. A client that matches no entry gets
`fleet:read` preselected.

### 3.5 MCP Streamable HTTP — `src/frontdoor/mcp/http-endpoint.js`

This is hand-written; there is **no MCP SDK** in the repo (§11 item 8). The tool logic is shared
with stdio (§3.7).

**`POST /mcp`** takes one JSON-RPC message per request.
- **Origin header.** If present, it must be `https://mcp.<domain>`, else `403`. This guards against DNS rebinding.
- **Bearer token.** Checked on **every** request: hash lookup, not expired, grant live, `aud` equal to the resource. On failure the answer is `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.<domain>/.well-known/oauth-protected-resource/mcp"`.
- **Missing scope.** A tool call whose scope is missing gets a tool error `insufficient_scope`.
- **Notifications and responses.** POSTed JSON-RPC notifications and responses are answered with `202`.

**Sessions.** `initialize` returns `Mcp-Session-Id` (128 random bits), bound to the grant, with at
most 20 per grant. The protocol version is negotiated from `['2025-11-25', '2025-06-18',
'2025-03-26']`, and later requests must send `MCP-Protocol-Version`. An unknown or foreign session
gets `404`. `DELETE /mcp` ends a session, and `GET /mcp` answers `405`.

**Tools.**
- `tools/list` returns only what the token's scopes allow.
- `tools/call` returns the stdio `content` / `isError` shape.
- **Long-poll `get_job`.** When the call has `_meta.progressToken`, `Accept` includes `text/event-stream`, and the job is not terminal, the response is SSE. It sends `notifications/progress { progressToken, progress: <log line count>, message: <status> }` on each `fleet.job_update`. It returns at the first status change or after `frontdoor.mcp.progress_hold_s` (default 20 s).
- `run_runbook` always returns at once. Polling always works.

**Untrusted output.** The front door wraps the `logs` / `lines` and `result` (string) fields, and
delegate transcripts and replies, in `untrustedOutput()` itself, whatever the node sent.

### 3.6 Router, node registry, job cache — `src/frontdoor/router/*`

**`NodeRegistry`** (`node-registry.js`). The registry is the union of two stores:

- **Console records:** `<configDir>/frontdoor-nodes/<node_id>.json`. They are admin-written by `frontdoor code … --confirm` (§3.11), trusted because the directory is admin-owned, and read with `assertAdminOwned`.
- **Phone records:** `<dataDir>/frontdoor/nodes.json`. Each holds a `kl.node.enroll` envelope. It is re-verified on every load against the admin-owned approvers, with the `accepted_at < revoked_at` rule from §3.4.

API:
- `load()`, `addSigned(envelope)`, `removeSigned(envelope)`, `removeConsole(nodeId)`
- `byId(id)`, `byName(name)`, `list()`
- `pinnedCertSet()`
- `markOnline(nodeId, conn, hello)` → `{ accepted } | { rejected: 'already_connected' }`, and `markOffline(nodeId)`

It feeds F3's `NodeHub` (E3): for each record, it calls
`transport.addTrustedPeer(peerId, publicKeyHex, { displayName: name, tlsFingerprint })` with
`peerId = 'kl-' + sha256(DER SPKI).hex().slice(0, 12)`. That is the `MeshIdentity.peerId`
derivation; the value is used only inside the transport (§4.17). On remove, the peer is dropped
and any live connection is closed with `4003`.

**One connection per node key.** When a second connection authenticates, the registry pings the
old one. A `pong` within 5 s means the new connection is closed with `4009 already_connected`. If
there is no `pong`, the old one is terminated and the new one takes over.

**`boot_id`.** `fleet.hello` carries `boot_id`, a random 128-bit value drawn at process start. When
it changes, every cached job for that node that is not in a terminal state becomes
`failed: node_restarted`. This is also how job ids are handed over after a `replaces` re-pair: the
old key's jobs fail as restarted.

**`FleetRouter.callTool(name, args, { grant, session, progress })`:**

1. **Scope check** (the §3.4 table, via `src/fleet/scope-rules.js`).
2. **Machine check.** Resolve `machine` with `byName`. It is `unknown_machine` if absent **or** outside the grant's `machines=`. `list_machines` is filtered the same way.
3. **Tier check.** For `run_runbook`, read the tier from the cached catalog; `unsafe` needs `fleet:unsafe`. `delegate` needs `profile: agent`, else `capability_unavailable`.
4. **Offline node.**
   - `run_runbook`, `delegate`, `send_to_job` and `cancel_job` fail with `machine_offline`. Nothing is queued.
   - `get_state`, `describe_machine` and `get_job` return the cache, marked `stale: true, cached_at`.
5. **Forward** with F3's `NodeHub` RPC (E3).
   - Limits: 30 s timeout; 64 in flight per node and 256 overall, otherwise `frontdoor_busy`.
   - The params always carry `origin` and `max_bytes` (512 KiB).
   - `run_runbook` and `delegate` also carry a `request_id` (UUIDv4). The node deduplicates on it for 10 min.
6. **Rewrite the reply.** Wrap untrusted fields (§3.5), rewrite `job_id` to the public form, and update `JobCache`.

Public job ids are `<machine>:<nodeJobId>`. They are stateless and survive a front-door restart;
the `machines=` check applies to `<machine>`.

**`JobCache`** is an LRU of 2000 entries fed by `get_job` results and `fleet.job_update`. It is
persisted to `node-status.json` every 60 s and at shutdown, together with each node's catalog,
last `get_state`, `last_seen` and `boot_id`.

**`FleetRouter.registerTool(def, { scope, route })`** (§5.2) lets C7 add tools.

- **Fan-out** (for example `list_cases`): `route(args, ctx) → { fanout: true }` calls the node RPC `cases.<name>` on every allowed online agent node and tags each row with `machine`.
- **Single node:** `route` → `{ machine }`.

### 3.7 Node fleet host — `src/fleet/*`, `src/mcp/fleet-tools.js`

**`src/mcp/fleet-tools.js`** receives `MCP_TOOLS`, `ToolError`, `untrustedOutput` and the body of
`StdioMcpServer.executeToolCall`, as `FleetToolHandler({ nodeConfig, runbookEngine, jobManager,
approver, auditLedger, delegateSessions, gui })`. Its method is
`call(name, args, { origin, maxBytes }) → result`. `stdio-server.js` delegates to it, and
`tests/mcp-stdio.test.js` passes unmodified.

**`src/fleet/start.js`** exports `startFleetNode({ dataDir, nodeConfig, approvals, core? })`. It is
called by `run.js` for the `runbook` **and** `agent` profiles, **whether or not a front door is
configured** (F6 §4.18). It builds:
- `RunbookEngine`, loaded once;
- `JobManager` sized from `policy.max_concurrent_jobs`;
- `DelegateSessions` (agent profile only, §3.8);
- `FleetToolHandler`;
- `NodeFleetService`, registered on F3's `RelayClient` through `registerMethod` (E5) when a link exists;
- the courier RPC handler (below).

**`get_job.evidence`** is a new field on both stdio and the front door:
- `RunbookEngine.executeRunbook` also returns `checks: [{ step_index, check, ok, attempts, status_code|null, error|null, at }]`, the same outcomes it records in `EvidenceLedger`. `JobManager` stores them on `job.result.evidence`.
- Delegate jobs return `evidence: { summary }` (§3.8).
- The shape is `evidence: { checks: [...] } | { summary: {...} } | null`.

**One `JobManager` per node (R24).** `king-louie-service mcp --data-dir D` decides at startup:

- **The service is running on `D`** (pidfile alive). `mcp` builds `CourierFleetClient`, which uses F3's `FileCourier` with an RPC extension (E6): `call(method, params) → result`. Every tool call becomes `fleet.<tool>` through the service's `CourierPump`, which dispatches to the same `FleetToolHandler` with `origin { client: 'stdio-mcp', session: null, job_id: null }`. Limits and `running_jobs` are therefore one set per node.
- **No service is running on `D`** (dev, or F6's separate per-runner instance). `mcp` builds its own engine and `JobManager` as today, and logs `warn` once: `no service is running on <D>: this mcp process enforces its own max_concurrent_jobs and rate limits, separately from any other King Louie process on this machine`. The README documents this.

**`mcp` on a runbook-profile node** never loads `src/core`. It uses `buildServicePorts` and F3's
producer-side approvals only. `tests/service-profile-graph.test.js` asserts this.

**`src/fleet/scope-rules.js`** is pure and shared. It exports `REQUIRED_SCOPE`,
`parseScope(str)` and `allows(scopes, tool, { machine, tier })`.

**`src/fleet/node-fleet-service.js`.** `NodeFleetService({ handler, relayClient, jobManager, bootId })`
registers the `fleet.*` RPCs (§4.7) and, from C7, `cases.*`. For each call it:
- re-checks `allows(origin.scopes, …)` against its **own** catalog tier;
- deduplicates `request_id`;
- enforces `max_bytes`;
- emits `fleet.job_update` on every status change.

**What the node re-check does and does not do.** It bounds router bugs, not a compromised front
door, because `origin.scopes` is supplied by the front door (§8).

**GUI capability.** `describe_machine` and `list_machines` include F5's `gui` block, via
`core.context.getGuiBroker()` in-process or `readGuiStatus({ dataDir })`, when F5 has merged.

### 3.8 Delegate sessions — `src/fleet/delegate-sessions.js` (R10, program §4.18)

`DelegateSessions({ core, nodeConfig, jobManager, auditLedger, leaseManager?, now })`. It exists only
on `profile: agent`. On a runbook node, `delegate` returns
`capability_unavailable: delegate needs an agent-profile node`.

**`start({ task, cwd, origin, request_id }) → { job_id, status: 'running' }`**

- **`cwd` check.** `cwd` must be `isPathUnderRoots(cwd, policy.allowed_roots)`. When omitted it is `delegate.cwd`, or else the first allowed root. If there is none, or it falls outside the roots, the call fails with `invalid_params: cwd must be under policy.allowed_roots`.
- **Job and slot.** Creates a `JobManager` job `{ kind: 'delegate', status: 'running' }`. It holds a `max_concurrent_jobs` slot **only while a turn runs**. An idle open session holds none, and a new turn that finds no slot fails `max_concurrent_jobs` for that message.
- **Session limit.** At most `delegate.max_sessions` (default 4) open sessions per node; beyond that, `node_busy`.
- **Scope gate.** If `origin.scopes` lacks `fleet:unsafe`, an `unsafe` classification is refused locally. The result is `{ success: false, error: 'This client may not request unsafe actions (fleet:unsafe not granted). Nothing ran.' }`, and the phone is never asked. The session installs this by wrapping F3's `classifyCall`.

**Each turn** runs through `core.context.getAgentExecutorAdapter().execute(agent, message, opts)`:

- **Agent and model.** `agent = getAgent(delegate.agent || 'main')`. `opts.provider` and `opts.model` come from `delegate.provider` / `delegate.model` (parent Q3). The node's own vault keys are used.
- **Directory and history.** `opts.workingDirectory = cwd`. `opts.messages` holds the history as `user` / `assistant` text pairs; tool detail is kept in the transcript, not replayed.
- **Executor options.** `opts.executorOptions = { origin: { client: origin.client_name, session: origin.mcp_session, job_id }, chatId: 'delegate:' + job_id }`. This uses F3's origin shape. With `remoteApprovals: 'phone'`, F3's `phoneExecutorOptions` then applies `denyAutoApproval`, `classifyCall` and the phone requester. `origin` also goes into `extraToolOptions`, which F5 needs.
- **Abort.** `opts.abortSignal` is the job's `AbortController.signal`.

**Two small core edits** (§7):
- `agentExecutorAdapter` forwards `options.provider`, `options.executorOptions` and `options.abortSignal`;
- `AgentExecutor` passes `abortSignal` to `AgentLoop`.

**`send(job_id, message)`**

| Session state | Result |
|---|---|
| Idle | runs a turn |
| A turn is running | `node_busy`, with `retry_after: 5` (no queue, so a client cannot stack instructions blind) |
| `closed`, `cancelled`, `failed` | `not_accepted: session is <state>` |

**Idle close.** After `delegate.idle_close` (default `2h`) with no turn, the session becomes
`closed`. A job is terminal (`succeeded`) only when it closes. While a session is open, `get_job`
reports `status: 'running', session: 'idle' | 'turn'`.

**Transcript (`get_job_logs`).** Lines are appended as each turn ends:
- `> user: <message>`
- one `tool <name> <JSON params, capped at 2 KiB> → <ok|error> <result, capped at 4 KiB>` per executed tool (from the loop result's `tools`);
- `< assistant: <content>`.

Planner and workflow tool calls (task graphs) are recorded **in full**, uncapped up to 256 KiB, so
plans appear in exports. The whole transcript is returned untrusted (§3.5).

**Result.** Each turn stores `result = <assistant content>` and
`evidence: { summary: EvidenceLedger.status(cwd) }`, trimmed to `hasEdits`, `editedPaths` (at most
50), `hasFullPass`, `hasTargetedPass` and `hasFreshFailure`.

**`cancel_job`** aborts a running turn, which tears down in-flight tools, and closes the session as
`cancelled`.

**Node restart.** Sessions are in memory. After a restart the job ids are unknown to the node, and
the front door reports `failed: node_restarted` (§3.6).

**Job close.** On close, cancel or failure the session calls `leaseManager?.endForJob(job_id,
'job_closed')` (F5) and audits `exec.result { kind: 'tool', name: 'delegate', job_id, ok }`.

**stdio.** `delegate` and `send_to_job` are **implemented** on stdio too, through the same handler,
in the service when the courier is used. When `mcp` runs standalone on an agent node, it has no
core and returns `capability_unavailable: delegate needs the King Louie service running on this node`.

### 3.9 Node link — F3's `RelayClient` with the front-door pin

`src/fleet/front-door-pin.js` exports `readPin(configDir)` and `writePin(configDir, pin)`. The file
is `<configDir>/front-door.json` (§4.8). It is read with `assertAdminOwned` and written only by
`pair https://…` running as admin.

**Pin precedence (E7).** When `front-door.json` exists, `RelayClient`:
- dials `mesh_url` with `MeshTransport.connectPinned` (§3.10);
- ignores `approvers.relay` and store key `approvals.relay`, logging `info` once;
- has `doctor` WARN `approvers.relay is superseded by front-door.json; remove it from node.yaml`.

The old store key is left in place as a way back.

**`connectPinned({ host, port: 443, servername, pinnedFingerprint, frontdoorId })`:**

1. `tls.connect` with the node's `tlsCert`/`tlsKey`, `rejectUnauthorized: false` and `checkServerIdentity: () => undefined`.
2. On `secureConnect`, `sha256(getPeerX509Certificate().raw).hex` must equal `pinnedFingerprint` (timing-safe). Otherwise destroy with `frontdoor_key_mismatch` **before any byte is written**.
3. Hand the connected socket to `new WebSocket(mesh_url, { createConnection: () => socket, maxPayload })`.
4. Run the challenge (§3.10 item 4). The peer's Ed25519 key must derive `frontdoorId`.

**Backoff.** `delay(n) = min(60 s, 1 s × 2^n) × uniform(0.5, 1.0)`. `n` resets after 5 min connected.
The minimum is 5 s after `4009`, and 60 s after `frontdoor_key_mismatch`, which is logged at
`error` at most once an hour. Heartbeat stays at 30 s, with a 90 s timeout.

### 3.10 Mesh hardening — `src/mesh/*`

| # | Item | Change |
|---|---|---|
| 1 | Frame limits | `MAX_PAYLOAD_BYTES` 4 MiB → **1 MiB**; every list RPC is byte-paged (`max_bytes`, default 512 KiB, §4.7). `PRE_AUTH_MAX_BYTES = 16 KiB`: a larger frame before authentication closes the socket with `1009`, without being parsed |
| 2 | Memory per connection | At most 256 pending RPCs per peer (`peer_busy`). `ws.bufferedAmount > 8 MiB` closes with `4029`. Inbound rate limited to 200 msgs/s, burst 400 (`4029`). `seenNonces` is kept **per peer** with 10 000 entries (today it is one global `Set` of 1000). At most 64 unauthenticated sockets overall and 8 per IP |
| 3 | Auth before parse (ruling 8) | Option `requireClientCert`. When true (front door, node link): unpinned certificates are rejected in TLS (§3.2); `pair:request` handling is off; the first parsed frame comes from a pinned key. When false (desktop LAN only): pre-auth frames are size-checked, then `parsePreAuthFrame(buf)` accepts exactly `auth:challenge` / `pair:request` with known keys and strings ≤ 4 KiB, and closes on anything else |
| 4 | Replay protection on control messages | `auth:*` signatures cover `challenge ‖ exportKeyingMaterial(32, 'EXPORTER-king-louie-mesh-v1')` (channel binding). With `requireClientCert`, the peer's TLS fingerprint must equal the fingerprint pinned for its Ed25519 key. Every post-auth frame gets an outer `seq`, monotonic per direction; `seq ≤ last` closes with `4010 replay_detected`. Envelopes older than the connection's auth time minus 5 s are rejected. The envelope window is 60 s on the front-door link |
| 5 | No mDNS | `initializeMesh` forces `discovery: false` when `frontDoor` is set. Service mode never requires `mesh-discovery.js` |
| 6 | Link surface | Service mode never constructs `MeshRemoteControl`, `MeshChannel` or `MeshSwarm`. `RelayClient` refuses to register `mesh.task.*` / `mesh.channel.*` methods |
| 7 | LAN pairing | 5 failed proofs lock pairing for 2 min (`pairing_locked`). `generateCode()` uses `crypto.randomInt(WORDLIST.length)` |
| 8 | Outside listener | `attachServer(httpServer, { requireClientCert, isPinned })`. Plain `ws://` is allowed only with `requireClientCert: false`. F3's `listen: false` is unchanged |

Close codes: `4001 unauthenticated`, `4003 key_removed`, `4009 already_connected`,
`4010 replay_detected`, `4029 rate_limited`, and `1009` for a frame that is too big.

### 3.11 Pairing and console bootstrap (R22) — `src/frontdoor/pairing/*`, `src/service/commands/{pair,frontdoor}.js`

**Pairing codes.** On the frontdoor profile, F3's `POST /v1/pairing-codes { node_name } → { code,
expires_at }` is served by `PairingService.issue(node_name)` (E8). The shape is unchanged. The code
format stays F3's: 6 words from `WORDLIST` picked with `randomInt`, lasting 10 min and bound to the
name. Codes are stored hashed in `pairing.json`, and each allows 5 attempts.

**Bootstrap on a fresh front door:**

1. `king-louie-service frontdoor enroll-device` (admin, service running). It uses F3's console enrollment (F3 §3.9) against the front door itself:
   - the CLI sends `enroll.open` through F3's courier, and the front door serves it from its own `invites.js`;
   - the QR is F3's `kl.pair` with `relay = https://mcp.<domain>`, `relay_spki` = the `mcp.` leaf SPKI (so ACME must already have issued), and `node = { id: frontdoor_id, name, key }`;
   - the phone then pins the front-door key used in §3.3.1;
   - after the phone's `code_mac` and the console `y/N` fingerprint match, the CLI writes `<configDir>/approvers/<device_id>.json`.
2. `king-louie-service frontdoor code <node-name> --confirm` (admin). It prints a code, then waits up to 10 min for that pairing. It prints the node's fingerprint and asks `Does the node console show the same? [y/N]`. On `y` it writes the **console record** `<configDir>/frontdoor-nodes/<node_id>.json`. Without `--confirm`, the pairing waits for a phone `kl.node.enroll`.
3. **Later nodes.** The phone issues the code and confirms by signing `kl.node.enroll`.

**Node side: `king-louie-service pair <url>`** (`commands/pair.js`) dispatches **by scheme**:
`wss://` runs F3's relay pairing unchanged, and `https://` runs the front-door flow. It is admin
only, needs the service stopped, and needs `<configDir>` writable.

1. It prints `Node Name`, `Node ID` and `Node fingerprint: kl-3v7q 2m4k 8d1x 9c0a` (the node id in groups of 4). It reads the code from `--code` or stdin.
2. It posts `POST https://mcp.<domain>/pair/v1` with the Ed25519-signed `kl.node.pair` (§4.4). TLS is validated with WebPKI. `--ca-file <pem>` (admin only) adds a trust anchor for test or dev front doors, and tests inject `{ ca }`.
3. It verifies the response envelope `kl.node.pair.accept`, which is signed by the front door and whose `kid` must equal `frontdoor_id`. It prints `Front door fingerprint: kl-…  (compare with the phone app)` and asks `[y/N]`. In a non-TTY run, `--yes-fingerprint "<groups>"` is required.
4. It polls `GET /pair/v1/{pairing_id}` for up to 10 min until the state is `enrolled`, then runs `writePin`.

Exit codes: `0` enrolled; `1` denied, expired, code rejected or fingerprint declined (nothing is
written); `2` usage error.

**Replace and remove.** A code for an existing name makes the phone or console show "replaces
kl-old…". Acceptance swaps the pin and closes the old link with `4003`. `kl.node.remove` (phone,
challenge-bound) and `frontdoor remove-node <name>` (admin, deletes the console record) remove a
node. `frontdoor nodes` lists nodes with their source (`console` or `phone`), online state and
fingerprints.

### 3.12 Audit mirror — `src/frontdoor/audit/mirror.js`

`AuditMirror({ dir, alerts, retentionDays, now })` exposes `ingestSlice(nodeId, envelope)`,
`cursor(nodeId)`, `history(nodeId, { before_seq, limit })` and `breaks(nodeId)`.

**Pull, using only F3's RPC.** `audit.slice { limit ≤ 200, before_seq?, max_bytes }` (F3 §4.6, plus
the E9 `max_bytes` extension). On connect, and on each `fleet.hello`, the mirror pages **backwards**
from the head until it overlaps its own `cursor.seq`. It then verifies forwards:
- `hash == hex(SHA-256(JCS(entry without hash)))`;
- `prev == previous hash`;
- the node's very first entry has `prev: null`;
- `seq` increases by exactly 1.

**Outcomes:**

| Case | Detection | Result |
|---|---|---|
| Normal | the overlap entry's hash equals the mirror head | append |
| First sync from a node that already pruned | paging reaches an empty slice while the lowest `seq > 1`, and the mirror has nothing | the lowest entry's `prev` becomes the **anchor** (`pruned_before { seq, anchor_prev }`); a `gap` record is kept; no alert |
| Later prune gap | the mirror head `seq` is below the node's oldest, and there is no overlap | a `gap` record with the missing seq range; alert `audit_gap` |
| Fork | an entry at a `seq` the mirror holds has a different hash | `chain_break`; the node is marked `audit: broken`; alert `audit_chain_break`; a new segment starts from the node's current chain |
| Tampered entry | a hash or `prev` mismatch inside a slice | `chain_break` (as above) |

**Signed history (never unsigned).** The mirror stores the **node-signed `kl.audit.slice` envelopes
as received**. `GET /v1/nodes/{node_id}/history?limit&before_seq` (F3's route) is forwarded to the
node when it is online (F3 behaviour). When it is offline, the mirror serves the stored envelope
covering `before_seq`, and the app verifies it exactly as F3 §3.13 describes. Break and gap records
come from `GET /v1/nodes/{node_id}/audit-status` (§4.9). They are the front door's own statements,
and the app labels them "reported by front door".

**Retention (R26).** Unlimited by default. `frontdoor.audit.retention_days` prunes whole stored
slices older than the limit.

**The front door's own ledger.** It is F3's `AuditLedger` in its data dir. Kinds:
- `frontdoor.grant.approved` / `.denied` / `.revoked`
- `frontdoor.token.issued` `{ grant_id, kind }` (never the token)
- `frontdoor.refresh_reuse`
- `frontdoor.node.enrolled` / `.removed` / `.replaced`
- `frontdoor.pairing.code_issued`
- `frontdoor.tls.repin`
- `frontdoor.alert.ack`

It is served like a node's history, as `node_id = frontdoor_id`. It is **not mirrored anywhere**, so
it gives no tamper evidence against someone holding the front door's service account.

### 3.13 Alerts, polling, self-probe

**`AlertCenter.raise(kind, { subject, detail })`:**
- deduplicates on `kind + subject` within 24 h;
- stores at most 500 alerts in `alerts.json`;
- pushes with `notify(device, { kind: 'alert', id })` (E4) when push is configured.

| Kind | Raised when |
|---|---|
| `acme_renewal_failing` | less than 21 d of validity is left and the last attempt failed; daily after that |
| `tls_key_changed` | the operator TLS leaf SPKI changed |
| `audit_chain_break`, `audit_gap` | §3.12 |
| `refresh_reuse` | §3.4 |
| `unknown_node_key` | **aggregate**: the first attempt of the day raises one alert, then one daily summary `{ count, top: [5 × { fingerprint, count, last_ip }] }`, never more than one a day |
| `dns_probe_failed` | three probe failures in a row |
| `node_record_invalid` | a registry or grant record fails verification |
| `node_replaced` | a pairing replaced an existing node |

**Polling (push may be absent).** All of these are device-authenticated and sit under F3's `/v1`:
- `GET /v1/alerts?since=<id>` and `POST /v1/alerts/{id}/ack`
- `GET /v1/pairings/pending` and `POST /v1/pairings/{id}/decision`

The app polls pairings every 5 s while the Nodes screen is open, and reads alerts on every app
open. A chain-break alert is therefore seen at the next open even without push. Grants need no
push (§3.4).

**`SelfProbe`** runs 60 s after start and then every 6 h. It resolves `mcp.` and `mesh.` with the
system resolver and connects to each on 443:
- **`mcp.`:** `GET /.well-known/kl-probe/<nonce>` must echo the nonce.
- **`mesh.`:** it connects with an in-memory probe certificate (`isProbeCert`). The server certificate fingerprint must be the front door's own, and the listener closes the probe socket right after the handshake.

### 3.14 Deployment doc and `doctor`

`docs/fleet/front-door.md` covers:
- DNS A/AAAA records for `mcp.` and `mesh.`, and an optional CAA record limited to the ACME account;
- the firewall: allow 443/tcp; allow SSH only from allowlisted addresses (or use the provider console); deny everything else; port 80 not needed;
- unattended upgrades, and chrony (signature expiry depends on the clock);
- `install --profile frontdoor` (Linux only; the unit gets `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`);
- the bootstrap order in §3.11;
- `rotate-tls-key` and `relay qr`.

**`doctor` on a front door** (`src/frontdoor/doctor-checks.js`) checks:
- the §3.1 checks, including "no phone enrolled" with the bootstrap command;
- resolution plus the last self-probe result;
- certificate days left (FAIL below 21);
- that the unit has `CAP_NET_BIND_SERVICE`;
- that registry and grant signatures verify;
- no unacknowledged breaks;
- clock skew against the `Date` header of `frontdoor.acme.directory` (FAIL above 30 s). Under operator TLS it uses Let's Encrypt's directory URL, or reports `not checked` if that is unreachable.

**`doctor` on a node with `front-door.json`** checks:
- that the pin file is admin-owned;
- that `approvers.relay` is superseded (WARN);
- a TLS-only probe of `mesh.` comparing fingerprints. The probe closes after the handshake and never authenticates, so it is not a second link.

### 3.15 Mobile (`mobile/ios`, `mobile/android`)

New screens, built from `docs/protocol/client-grant-v1.md`:

1. **Connect a client.** Type the `XXX-XXX` code. The screen shows client name ("self-declared"), client host, redirect host and scopes with toggles and machine limits. Approve or Deny with a biometric signature.
2. **Connected clients.** Grants with scopes and last use; Revoke.
3. **Confirm a node.** The name, profile, fingerprint and "replaces …". Approve or Deny.
4. **Alerts.**
5. **History** reads F3's route, plus the front door's break and gap markers.
6. **Settings** shows the front-door fingerprint, and handles the re-pin (§3.3.1).

Approval details label `origin.client` as "Client (reported by front door)". Push handling
accepts `k` (E4). Both apps must pass `tests/vectors/client-grant-v1`.

## 4. Data formats

All phone-signed messages use F3's envelope (F3 §4.2): `{ alg: 'ES256', kid: device_id, payload,
sig }`. The signature is checked over the received bytes, which must satisfy
`bytes === JCS(parse(bytes))`, and `kid` must equal `device_id` (`d-` followed by 16 base32
characters). Front-door-signed messages use `alg: 'Ed25519'` with `kid: frontdoor_id`.

Arrays are sorted and unique, and a verifier rejects them otherwise. Acceptance never judges
`signed_at` or `created_at`: freshness comes from a pending item or challenge held on the verifier's
clock.

### 4.1 Grant record — `<dataDir>/frontdoor/oauth/grants.json` (map by `grant_id`)

```json
{ "grant_id": "gr_4f1c…", "client_id": "dcr_Zk…", "client_name": "Example Client",
  "redirect_uri": "https://client.example.com/cb", "resource": "https://mcp.kl.example.com/mcp",
  "scopes": [{ "scope": "fleet:read", "machines": null }, { "scope": "fleet:run", "machines": ["web-01"] }],
  "device_id": "d-k2m4q7xa9c3d5f8h", "accepted_at": "2026-09-23T10:00:00.000Z",
  "signed_grant": { "alg": "ES256", "kid": "d-k2m4q7xa9c3d5f8h", "payload": "…", "sig": "…" },
  "revoked_at": null, "revoked_reason": null, "last_used_at": null }
```

### 4.2 `kl.client.grant`, `kl.client.revoke`

```jsonc
{ "v": 1, "type": "kl.client.grant", "frontdoor_id": "kl-…", "grant_id": "gr_…",
  "client_id": "dcr_…", "client_name": "Example Client", "redirect_uri": "https://client.example.com/cb",
  "resource": "https://mcp.kl.example.com/mcp", "code_challenge": "E9Melhoa2Owv…", "user_code": "Q7KM2X",
  "scopes": [{ "scope": "fleet:read", "machines": null }],
  "decision": "approve" | "deny", "nonce": "<b64url 32B>", "device_id": "d-…", "signed_at": "RFC3339" }
{ "v": 1, "type": "kl.client.revoke", "frontdoor_id": "kl-…", "grant_id": "gr_…",
  "challenge": "<b64url 32B>", "device_id": "d-…", "signed_at": "RFC3339" }
```

| Field | Rule |
|---|---|
| `frontdoor_id` | must equal the front door's `nodeId`. Anything else is `wrong_frontdoor` |
| `user_code` | the 6 characters the owner typed, normalised (upper case; `O→0`, `I/L→1`; no `-`). Must equal the pending authorization's code |
| `code_challenge`, `redirect_uri`, `resource`, `client_id` | byte-equal to the pending authorization |
| `scopes` | only `[]` when `decision: deny`. `machines` is `null` or a sorted list of names |
| `nonce` | single use for the life of the pending authorization |
| `challenge` | from `POST /v1/challenges` (§4.6); single use, 2 min on the front door's clock |

### 4.3 `kl.node.enroll`, `kl.node.remove`

```jsonc
{ "v": 1, "type": "kl.node.enroll", "frontdoor_id": "kl-…", "pairing_id": "pr_…",
  "node_id": "kl-3v7q2m4k8d1x9c0a", "node_name": "gpu-box", "profile": "agent",
  "public_key": "<b64url raw 32B Ed25519>", "tls_fingerprint": "<hex sha256(cert DER)>",
  "replaces": null, "decision": "approve" | "deny", "nonce": "…", "device_id": "d-…", "signed_at": "…" }
{ "v": 1, "type": "kl.node.remove", "frontdoor_id": "kl-…", "node_id": "kl-…",
  "challenge": "…", "device_id": "d-…", "signed_at": "…" }
```

`node_id` must equal `deriveNodeId(public_key)`. The enroll is bound to a pending pairing, whose
10-minute TTL runs on the front door's clock.

The registry record is:

```jsonc
{ node_id, node_name, profile, public_key, tls_fingerprint, source: 'phone'|'console',
  accepted_at, signed|null }
```

A console record (`<configDir>/frontdoor-nodes/<node_id>.json`) has the same shape, with
`source: 'console'`, `signed: null` and `confirmed_by: 'console'`.

### 4.4 `kl.node.pair` (the node signs, Ed25519, `kid = node_id`) and `kl.node.pair.accept` (the front door signs)

```jsonc
{ "v": 1, "type": "kl.node.pair", "frontdoor_host": "mcp.kl.example.com",
  "code_hash": "<b64url SHA-256(normalized code)>", "node_id": "kl-…", "node_name": "gpu-box",
  "profile": "runbook", "capabilities": ["large-disk"], "public_key": "<b64url raw 32B>",
  "tls_cert": "<PEM>", "nonce": "<b64url 32B>", "created_at": "RFC3339" }
{ "v": 1, "type": "kl.node.pair.accept", "frontdoor_id": "kl-…", "pairing_id": "pr_…",
  "node_id": "kl-…", "nonce": "<echo>", "mesh_url": "wss://mesh.kl.example.com/mesh/v1",
  "mesh_cert_fingerprint": "<hex>", "frontdoor_public_key": "<b64url raw 32B>" }
```

The code is normalised by trimming, lower-casing and collapsing spaces between words. `nonce`
freshness is by echo; `created_at` is not judged.

### 4.5 `kl.relay.repin` (the front door signs)

```jsonc
{ "v": 1, "type": "kl.relay.repin", "frontdoor_id": "kl-…", "relay": "https://mcp.kl.example.com",
  "old_spki": "sha256/<b64url>", "new_spki": "sha256/<b64url>", "created_at": "RFC3339" }
```

### 4.6 Challenges

`POST /v1/challenges` (device-authenticated) returns `{ challenge, expires_in_ms: 120000 }`.
At most 20 are live per device.

### 4.7 Front-door link RPCs

These are carried by F3's `NodeHub` ↔ `RelayClient` link next to F3's methods, which are unchanged.
The params always include:

```jsonc
"origin": { "kind": "frontdoor", "client_id": "dcr_…", "client_name": "Example Client",
            "grant_id": "gr_…", "scopes": ["fleet:read", "fleet:run;machines=web-01"], "mcp_session": "…" },
"max_bytes": 524288
```

| Direction | Method | Params | Result |
|---|---|---|---|
| fd→node | `fleet.describe` | `{}` | `{ name, profile, capabilities, runbooks: [{name,description,tier,params}], allowed_roots, gui? }` |
| fd→node | `fleet.get_state` | `{}` | stdio `get_state` result |
| fd→node | `fleet.run_runbook` | `{ request_id, runbook, params }` | `{ job_id, status }` |
| fd→node | `fleet.delegate` / `fleet.send_to_job` | `{ request_id, task, cwd? }` / `{ job_id, message }` | `{ job_id, status }` |
| fd→node | `fleet.get_job` | `{ job_id }` | stdio shape + `evidence`, with `logs` tail ≤ 64 KiB + `logs_truncated` |
| fd→node | `fleet.get_job_logs` | `{ job_id, since?, tail? }` | `{ lines (raw), next_since, more }`, bounded by `max_bytes` |
| fd→node | `fleet.cancel_job` | `{ job_id }` | stdio shape |
| node→fd | `fleet.hello` | `{ node_id, name, profile, capabilities, catalog_digest, boot_id, version }` | `{ ok }` |
| node→fd | `fleet.job_update` | `{ job_id, status, session?, updated_at, log_lines }` | none |
| node→fd | `fleet.catalog_changed` | `{ catalog_digest }` | none |

Errors are `{ ok: false, error: { code, message, retry_after? } }`, with the codes in §9.

**Evidence** (in `get_job`):

```jsonc
{ "checks": [{ "step_index": 4, "check": { "http_get": "http://127.0.0.1:8080/healthz", "expect_status": 200 },
               "ok": true, "attempts": 1, "status_code": 200, "error": null, "at": "RFC3339" }] }
```

### 4.8 Node pin — `<configDir>/front-door.json`

```json
{ "v": 1, "frontdoor_id": "kl-…", "frontdoor_public_key": "<b64url raw 32B>", "domain": "kl.example.com",
  "mesh_url": "wss://mesh.kl.example.com/mesh/v1", "mesh_cert_fingerprint": "<hex>", "paired_at": "RFC3339" }
```

### 4.9 Phone API additions — under F3's `/v1`, F3's auth, registered through E2

| Method, path | Body → reply |
|---|---|
| `POST /v1/pairing-codes` (re-bound, E8) | `{ node_name }` → `{ code, expires_at }` (F3 shape) |
| `GET /v1/pairings/pending` | → `[{ pairing_id, node_name, node_id, profile, replaces, expires_in_ms }]` |
| `POST /v1/pairings/{id}/decision` | `kl.node.enroll` envelope → `{ state }` |
| `GET /v1/grants/pending?user_code=` | → `{ grant_id, client_name, client_host, redirect_uri, resource, code_challenge, requested_scopes, preselected, expires_in_ms }` / `404` |
| `POST /v1/grants/{id}/decision` | `kl.client.grant` envelope → `{ state }` |
| `GET /v1/clients` | → `[{ grant_id, client_name, client_host, scopes, accepted_at, last_used_at }]` |
| `POST /v1/clients/{grant_id}/revoke` | `kl.client.revoke` envelope → `204` |
| `POST /v1/challenges` | → §4.6 |
| `POST /v1/nodes/{node_id}/remove` | `kl.node.remove` envelope → `204` |
| `GET /v1/nodes` (extended) | F3 fields + `profile`, `capabilities`, `source`, `audit: ok\|broken\|gap`, `last_seen` |
| `GET /v1/nodes/{node_id}/audit-status` | → `{ head_seq, anchor, gaps: [...], breaks: [...] }` |
| `GET /v1/alerts?since=`, `POST /v1/alerts/{id}/ack` | → `[{ id, kind, subject, detail, at, acked }]` / `204` |
| `GET /v1/frontdoor` | → `{ frontdoor_id, public_key, domain, cert_not_after }` |
| `GET /v1/repin` | none → `kl.relay.repin` envelope / `404` |

`/pair/v1` (the node side of §3.11) is outside `/v1`. It is limited to 10 requests per minute per IP.

### 4.10 Files

| Path | Contents | Writer |
|---|---|---|
| `<configDir>/node.yaml` `frontdoor:`, `delegate:` | §6 | admin |
| `<configDir>/approvers/` | F3 approver files (the front door too, R25) | admin CLI |
| `<configDir>/frontdoor-nodes/<node_id>.json` | console-confirmed node records | `frontdoor code --confirm` |
| `<configDir>/front-door.json` (nodes) | §4.8 | `pair https://` |
| `<dataDir>/frontdoor/acme/{account,cert,cert-key}.json` | account and certificate key (encrypted), chain, `notAfter` | service |
| `<dataDir>/frontdoor/nodes.json`, `nodes.rejected.json` | phone-signed records | service (signatures decide) |
| `<dataDir>/frontdoor/node-status.json`, `pairing.json` | cache; hashed codes and pending pairings | service |
| `<dataDir>/frontdoor/oauth/{clients,grants,tokens}.json` | §3.4 (token hashes only) | service |
| `<dataDir>/frontdoor/alerts.json`, `mirror/<node_id>/…` | §3.12–3.13 | service |

Every file is written atomically (temp `wx` + rename, mode 0600).

## 5. Interfaces

### 5.1 Consumed

| From | Interface |
|---|---|
| F3 | `src/approvals/envelope.js` `open`, `seal`, `verifyEs256`, `verifyEd25519`, `nodeSigner`; `src/platform/jcs.js` (R17) |
| F3 | `ApproverStore({ dir })` `list/get/isActive/activeCount` over `<configDir>/approvers/` (R25) |
| F3 | `startRelay`, `NodeHub`, `phone-api.js` (`X-KL-*` auth), `invites.js`, `createPusher(config).notify` |
| F3 | `RelayClient`, `startApprovals(...) → { phoneApprover, auditLedger, relayClient }`, `FileCourier`, `CourierPump` |
| F3 | `AuditLedger` (hex `hash`, `prev: null` first, `seq`), `audit.slice` / `kl.audit.slice` |
| F3 | `remoteApprovals: 'phone'`, `phoneExecutorOptions`, `classifyCall`, `'unavailable'` result, origin `{ client, session, job_id }` |
| F2 | `StdioMcpServer`, `RunbookEngine`, `JobManager`, `loadNodeConfig`, `getOrGenerateNodeIdentity`, `deriveNodeId`, `EvidenceLedger` |
| F5 (optional) | `getGuiBroker()`, `readGuiStatus({ dataDir })`, `LeaseManager.endForJob` |
| F6 | `NODE_YAML_KEYS` in `src/service/node-config.js` |

**F3 extension required.** Queued in `program-amendments-2.md`, "F3 fix-round inputs" item 6. F4
does not redefine any F3 shape.

| # | Signature |
|---|---|
| E1 | `startRelay({ dataDir, config, identity, listeners: 'own' \| 'external', registry? }) → { stop, address(), phoneApiHandler: (req, res) => void, nodeHub }`. With `'external'` it binds nothing, and `relay.public_url` comes from `config`. |
| E2 | `phoneApi.registerRoute(method, pathPattern, { auth: 'device' \| 'none' \| 'code', rate?: { perMin }, handler(req, ctx) → { status, body } })`. `ctx.deviceId` is set when `auth: 'device'`. |
| E3 | `new NodeHub({ …, peerSource })`, where `peerSource` = `{ list() → [{ peerId, publicKeyHex, name, tlsFingerprint, nodeId }], on('change') }`, used instead of `relay/nodes.json`. Also `nodeHub.rpc(nodeId, method, params, { timeoutMs }) → result`, `nodeHub.onNodeMessage(method, handler)`, `nodeHub.onConnection(fn)`. |
| E4 | `pusher.notify(device, { kind: 'approval' \| 'grant' \| 'pairing' \| 'alert', id, node_name?, expires_at? })`. `kind` is optional (default `'approval'`, where `id` is the `request_id`). APNs `{"kl":{"rid": id, "k": kind}}`, FCM `{ rid, n, k }`, `apns-collapse-id: id`. The apps treat a missing `k` as `approval`. |
| E5 | `relayClient.registerMethod(name, handler(params, { peer }) → result)` and `relayClient.notify(method, params)`. `registerMethod` refuses `mesh.task.*` and `mesh.channel.*`. |
| E6 | `FileCourier.call(method, params, { timeoutMs }) → result` and `CourierPump({ …, rpcHandler(method, params) })`. |
| E7 | `RelayClient` reads `<configDir>/front-door.json` when it exists and dials with `MeshTransport.connectPinned`, ignoring `approvers.relay` / `approvals.relay`. |
| E8 | On `startRelay(listeners: 'external')`, `POST /v1/pairing-codes` can be re-bound through `registerRoute` (a later registration replaces F3's handler). |
| E9 | `audit.slice` accepts `max_bytes` (default 512 KiB) and stops before exceeding it, always returning at least one entry. |

### 5.2 Produced

- **Program §4.19:** `ScopeRegistry.register(name, { tools, description, requires? })` and `FleetRouter.registerTool(def, { scope, route })`; `NodeFleetService.registerMethod(name, handler)`. C7 uses these with `CASE_MCP_TOOLS` and `createCaseToolHandler` (`channel: 'mcp-frontdoor'`).
- **Program §4.18:** `DelegateSessions`, `start/send/cancel`, `delegate.*` keys; the `evidence` field of `get_job`; `startFleetNode`.
- `FleetToolHandler`, `MCP_TOOLS`, `ToolError`, `untrustedOutput` (`src/mcp/fleet-tools.js`).
- `MeshTransport` `requireClientCert`, `attachServer`, `connectPinned`, `PRE_AUTH_MAX_BYTES`; close codes (§3.10).
- Phone API additions (§4.9); push kinds `pairing` and `alert` (grants are not pushed).
- `client-grant-v1`: `kl.client.grant`, `kl.client.revoke`, `kl.node.enroll`, `kl.node.remove`, `kl.node.pair`, `kl.node.pair.accept`, `kl.relay.repin`.
- `NODE_YAML_KEYS` additions (§6).

## 6. Configuration

Every key here is read only from the admin-owned `<configDir>`.

```yaml
name: frontdoor
profile: frontdoor                 # node-config.js accepts agent | runbook | frontdoor
frontdoor:
  domain: kl.example.com           # → mcp.kl.example.com, mesh.kl.example.com
  listen: { host: 0.0.0.0, port: 443 }
  acme: { email: admin@example.com, directory: https://acme-v02.api.letsencrypt.org/directory, terms_agreed: true }
  # tls: { cert_file: /etc/king-louie/tls/mcp.pem, key_file: /etc/king-louie/tls/mcp.key }
  oauth:
    access_token_ttl: 1h
    refresh_token_idle_ttl: 30d
    scopes_enabled: [fleet:read, fleet:run, fleet:unsafe, fleet:delegate]
    client_defaults:
      - { match: { host: client.example.com }, scopes: [fleet:read, fleet:run] }
  mcp: { progress_hold_s: 20 }
  audit: { retention_days: null }  # null = unlimited (R26)
```

```yaml
# agent node
delegate: { provider: anthropic, model: <model id>, agent: main, idle_close: 2h, cwd: 'D:\train', max_sessions: 4 }
```

| Key | Default | Rule |
|---|---|---|
| `frontdoor.domain` | required | DNS name |
| `frontdoor.listen.port` | 443 | 1–65535 |
| `frontdoor.acme.directory` | Let's Encrypt production | `https:` |
| `…access_token_ttl` / `…refresh_token_idle_ttl` | `1h` / `30d` | 5m–24h / 1d–365d |
| `…scopes_enabled` | the four fleet scopes | ⊆ registered |
| `…client_defaults[].match.host` | — | exact host |
| `frontdoor.mcp.progress_hold_s` | 20 | 0–55 |
| `frontdoor.audit.retention_days` | `null` (unlimited) | `null` or ≥ 30 |
| `delegate.provider` / `.model` | the node's settings default | a provider known to `src/providers` |
| `delegate.agent` | `main` | an existing agent id |
| `delegate.idle_close` | `2h` | 5m–24h |
| `delegate.cwd` | first `allowed_roots` entry | under `allowed_roots` |
| `delegate.max_sessions` | 4 | 1–16 |

**R11 (`NODE_YAML_KEYS`, `src/service/node-config.js`):**
- append `'frontdoor'` and `'delegate'` to `top`;
- add `frontdoor: ['domain','listen','acme','tls','oauth','mcp','audit']`;
- add `delegate: ['provider','model','agent','idle_close','cwd','max_sessions']`.

Deeper levels (`frontdoor.listen`, `.acme`, `.tls`, `.oauth`, `.mcp`, `.audit`) are checked strictly
by `parseFrontDoorConfig` with the same message: `Invalid node.yaml: unknown key "frontdoor.oauth.x" (known: …)`.

**Placement rules.**
- `frontdoor:` on a non-frontdoor profile is refused.
- `delegate:` on `profile: runbook` is refused (`delegate needs profile: agent`).
- On `frontdoor`, `service.json` `relay.*` follows §3.1.

## 7. Host wiring

| File | Touch |
|---|---|
| `src/core/create-core.js` | context getter `getAgentExecutorAdapter: () => agentExecutorAdapter`; the adapter passes `options.provider` into `createAgentRuntime` and merges `options.executorOptions` into its runtime options (`origin`, `chatId`) |
| `src/agents/agent-executor.js` | `abortSignal: options.abortSignal` into `new AgentLoop(...)` |
| `src/service/config.js` | `PROFILES` + `frontdoor`; `relay.*` rules on that profile |
| `src/service/node-config.js` | profile enum; `NODE_YAML_KEYS` (R11); `frontdoor` → `parseFrontDoorConfig`; `delegate` parsing |
| `src/service/run.js` (F3, F4, F5) | `loadProfile('frontdoor')` branch; agent and runbook branches call `startFleetNode(...)` after F3's `startApprovals(...)` |
| `src/service/cli.js` | `frontdoor` → `src/service/commands/frontdoor.js`; `mcp` chooses between the courier client and standalone (§3.7) |
| `src/service/commands/pair.js` (F3, F4) | dispatch by scheme |
| `src/service/doctor.js` | one line appending `require('../frontdoor/doctor-checks').checks(...)` |
| `src/service/installers.js` | frontdoor unit capabilities; `install --profile frontdoor` refused off Linux |
| `src/mesh/mesh-transport.js` (F3, F4), `mesh-pairing.js`, `index.js` | §3.10 |
| `src/runbooks/runbook-engine.js` | `checks` in the `executeRunbook` result; `result.evidence`; delegate job kind |
| `src/mcp/stdio-server.js` | imports `fleet-tools.js`; `handler` option (courier or local) |
| IPC, `renderer.js`, `settings.js`, `tools/index.js` | none |
| `CLAUDE.md` | one short "Front door" section: run `--profile frontdoor` locally with `frontdoor.tls` self-signed on a high port; the test helpers |

## 8. Security and trust

| New exposure | What stops it | Parent |
|---|---|---|
| A public TLS parser on 443 | a bounded, reassembling, fuzzed ClientHello parser; unknown SNI is destroyed; socket caps | P4 |
| Unauthenticated bytes reaching the mesh | unpinned certificates are dropped at `secure` before any read; the Ed25519 challenge is bound to the TLS exporter | §7.1, ruling 8 |
| Grant phishing (the attacker starts `/oauth/authorize` with a real client's CIMD id) | the phone signs only for the code the owner **types** from their own browser; no pushes for grants; per-IP, per-host and global caps; claimed requests cannot be evicted | §7.2, R23 |
| Stolen authorization code or token | PKCE S256; 60 s single-use codes; cookie binding; 1 h access tokens; rotation with reuse revoking the grant (one grace per rotation); phone revoke | §11 row 6 |
| Open redirect / SSRF | exact redirect match; CIMD fetches only to public IPs, no redirects, size cap | — |
| Adding a phone key on the front door | approvers are admin-owned (R25); the service only reads them | P2 |
| **Front door service account compromised** | it can mint tokens, rewrite grants and the phone-record cache, and replay a removed node's old signed enrollment. It cannot add an approver key or forge phone or node signatures. That is the same ceiling as a compromised front door | §11 row 3 |
| **Compromised front door** | the node's scope re-check uses front-door-supplied `origin.scopes`, so it **bounds router bugs, not a compromised front door**. The real ceiling is node policy plus a fresh phone signature for anything unsafe, and delegate sessions refuse unsafe calls from clients without `fleet:unsafe`. The phone labels the client name "reported by front door". The link never carries `mesh.task.*` | P1, P3, §11 row 3 |
| Compromised node | its key speaks only for itself; one link per key; audit rewrites show up as forks | §11 row 8 |
| Phone clock manipulation | acceptance is bound to pending items and challenges held on the front door's clock | — |
| `mcp` and the service disagreeing on limits | one `JobManager` through the courier when the service runs (R24) | — |
| Leaked `mcp.` key | signed re-pin to a new key (§3.3.1) | R21 |

## 9. Error handling

| Situation | Code / behaviour | Owner sees |
|---|---|---|
| Node offline, action tool | `machine_offline`, nothing queued | phone node list: offline |
| Node offline, read tool | cache with `stale: true, cached_at` | — |
| Name unknown or outside `machines=` | `unknown_machine` | — |
| Scope missing | `insufficient_scope`, `required: "<scope>"` | — |
| RPC timeout (30 s) | `node_timeout`: "the job may have started; call get_job or retry with the same request"; the retry reuses `request_id` | — |
| Router over its cap | `frontdoor_busy`, `retry_after: 5` | — |
| Node refusals | passed through: `denied_by_policy`, `invalid_params`, `rate_limited` + `retry_after`, `runbook_not_found`, `max_concurrent_jobs`, `capability_unavailable`, `job_not_found`, `not_accepted` | — |
| Delegate: turn already running / too many sessions | `node_busy`, `retry_after` | — |
| Node restarted | cached jobs `failed: node_restarted` | — |
| Expired or revoked access token | 401 `invalid_token` + `WWW-Authenticate` | — |
| OAuth errors | `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`, `access_denied`, `invalid_redirect_uri`, `invalid_client_metadata`, `temporarily_unavailable` (caps) | consent page text |
| Typed code matches nothing | `404 no_such_request` | app: "No connection request with that code" |
| Refresh token reuse | `invalid_grant`, grant revoked | alert `refresh_reuse` |
| Mesh: unpinned certificate | destroyed at `secure` | daily `unknown_node_key` summary |
| Mesh: second link, old one alive | `4009` | — |
| Mesh: frame too big / unauthenticated / replayed / rate exceeded | `1009` / `4001` / `4010` / `4029` | log `warn` |
| Node sees the wrong front-door certificate | `frontdoor_key_mismatch`, zero bytes sent | node `error` log once an hour; `doctor` shows both fingerprints |
| ACME failing | old certificate served | alert at T−21 d, then daily |
| First boot, no certificate yet | `mcp.` handshakes destroyed | `doctor`: "waiting for ACME" |
| No phone enrolled | grants and pairings impossible | `doctor` FAIL naming `frontdoor enroll-device` |
| Chain break, fork or gap | new segment / gap record | alert `audit_chain_break` / `audit_gap` |
| Pairing code wrong, expired or exhausted | `pair` exits 1: `pairing code rejected` / `expired` / `too many attempts` | — |
| `pair` fingerprint declined | exits 1, writes nothing | — |
| `mcp` without a service | standalone engine, `warn` about separate limits; `delegate` → `capability_unavailable` | stderr line |

## 10. Testing

All tests use `node --test`. Helpers:
- `tests/helpers/fake-phone.js` (F3's), extended with `grant(...)`, `revoke(...)`, `enrollNode(...)` and `removeNode(...)`;
- `tests/helpers/fake-node.js`: a real `MeshTransport` plus `NodeFleetService` over a fake engine;
- `tests/helpers/test-certs.js`: self-signed certificates generated at runtime;
- `tests/helpers/oauth-test-client.js`: discovery, DCR/CIMD, PKCE, token, refresh.

| File | Covers |
|---|---|
| `tests/frontdoor-client-hello.test.js` | real hellos, a hello split across 3 records and across TCP chunks, bad lengths, >16 KiB, no SNI, the 5 s timeout; 10 000 fuzz mutations |
| `tests/frontdoor-sni.test.js` | routing; pinned certificate reaches `onMeshSocket`; unpinned or missing is destroyed, with HTTP `request`/`upgrade` **never** called; `mcp.` never requests a certificate; `acme-tls/1`; `mcpContext() === null` destroys; the probe certificate is closed after the handshake |
| `tests/frontdoor-oauth.test.js` | the full flow (DCR and CIMD fixture); metadata; consent headers; typed-code grant, then token, then `/mcp`; rotation; reuse revokes; grace once only; the superseded successor revokes; revoke through a challenge; defaults only preselect; `fleet:unsafe` alone → `invalid_scope` |
| `tests/frontdoor-pkce.test.js` | missing challenge, `plain`, wrong verifier, code reuse revokes, code after 60 s, redirect and resource mismatch, wait page without the cookie, state omitted |
| `tests/frontdoor-grant-abuse.test.js` | 3-per-IP cap; 1-per-host replace; a claimed request survives a flood of 60; wrong typed code → 404; no push is ever sent for grants |
| `tests/frontdoor-cimd.test.js` | private IP, redirect, oversize, `client_id` mismatch, timeout |
| `tests/frontdoor-mcp-http.test.js` | initialize, session binding, versions including `2025-11-25`, `202` for notifications, `Origin` refusal, `aud` check, scope-filtered `tools/list`, SSE progress, 401 header, foreign session 404 |
| `tests/frontdoor-router.test.js` | against the fake node: scope, `machines=` and tier checks happen before forwarding (the fake counts calls); the node re-check refuses forged scopes; offline cache; timeout + `request_id` dedupe; untrusted wrapping; a >1 MiB job log pages cleanly under `max_bytes`; `boot_id` change → `node_restarted` |
| `tests/frontdoor-registry.test.js` | second link rejected while the first pongs, taken over when it does not; union of console and phone records; quarantine; `accepted_at < revoked_at` keeps a record; remove closes with 4003; `trustedPeers` populated with the hex `peerId` |
| `tests/frontdoor-bootstrap.test.js` | a fresh front door: `frontdoor enroll-device` (fake phone, console `y`) writes an approver; `frontdoor code --confirm` writes a console record; the node links; `doctor` before and after |
| `tests/frontdoor-repin.test.js` | ACME renewal keeps the SPKI; `rotate-tls-key` → valid `kl.relay.repin`; the app-side verifier (Node port) rejects a bad signature, a mismatched `new_spki` or a wrong `old_spki` |
| `tests/mesh-hardening.test.js` | oversized pre-auth frame (1009, `JSON.parse` spy not called); unauthenticated frame under `requireClientCert` never parsed; replayed `auth:response` on a new TLS session fails; `seq` replay → 4010; stale envelope; per-peer nonces; pending-RPC cap; rate limit; 64/8 socket caps; LAN lockout; `randomInt` coverage |
| `tests/fleet-node-link.test.js` | `connectPinned` destroys before writing on a mismatch; backoff bounds and reset; `registerMethod('mesh.task.dispatch')` refused; `front-door.json` supersedes `approvers.relay` |
| `tests/fleet-node-host.test.js` | `run --profile runbook` hosts the engine with no front door configured; `get_job.evidence.checks` over stdio and RPC; `mcp` routes through the courier when the service runs (one `max_concurrent_jobs`), standalone with the warning when not |
| `tests/fleet-delegate.test.js` | `createCore` with a fake provider and the fake phone: **a routine tool call runs; an `always_confirm` call reaches the fake phone**; an unsafe call without `fleet:unsafe` is refused and the phone is never asked; `cwd` outside the roots; `send_to_job` busy / closed; idle close on a fake clock; cancel aborts a running tool; transcript lines, including the full planner call; evidence summary; `endForJob` called |
| `tests/frontdoor-audit-mirror.test.js` | ingest and verify (hex, `prev: null`); tampered entry; fork; first sync after a node prune (anchor, no alert); later gap (alert); offline history serves the stored signed envelope; retention unlimited vs set |
| `tests/frontdoor-probe.test.js`, `tests/frontdoor-acme.test.js`, `tests/frontdoor-startup.test.js` | probe nonce, own-cert check, 3 failures; issuance and renewal at ⅓ lifetime with the same key, failure keeps the old certificate, alert at T−21 d, `SIGHUP` retry; each §3.1 check |
| `tests/service-cli-mcp-pair.test.js` (extend) | `pair https://` with `--ca-file` against an in-process front door: success writes the pin; wrong code; declined fingerprint writes nothing; `wss://` still runs F3's flow |
| `tests/service-profile-graph.test.js` (extend) | the frontdoor graph exclusions; `mcp` on a runbook node never loads `src/core`; service mode never loads `mesh-discovery.js` |
| `tests/node-config.test.js` (extend) | `NODE_YAML_KEYS` additions; unknown `frontdoor.oauth.x` refused; `delegate` on a runbook node refused |
| `tests/client-grant-v1-vectors.test.js` | every file in `tests/vectors/client-grant-v1/` (below) |

**Vectors** (`tests/vectors/client-grant-v1/`, reusing F3's `keys.json`):
- grant approve / deny;
- grant rejections: `user_code` mismatch, `wrong_frontdoor`, pending expired (front-door clock), `code_challenge` changed, `redirect_uri` changed, scope widened, `machines` unsorted, `unsafe`-only, unknown device, revoked device, nonce replay, non-canonical bytes, phone clock 1 day ahead (accepted);
- revoke valid / challenge reused / challenge expired;
- enroll valid / `node_id` ≠ derived / unknown pairing;
- remove valid;
- pair valid / bad signature;
- pair.accept valid;
- repin valid / bad signature;
- fingerprint grouping.

**Five conditions the parent is silent on, and the test that pins each:**

1. **ACME renewal quietly failing.** `frontdoor-acme › renewal failure keeps serving and alerts at T-21d`.
2. **A node reinstalled with a new key**, which looks merely "offline". `frontdoor-registry › unknown cert counted in the daily unknown_node_key summary; re-pair with replaces swaps the pin`.
3. **An LLM client's token expiring mid-job.** `frontdoor-mcp-http › expired token mid-job: 401, refresh, get_job on the same job_id succeeds, job never interrupted`.
4. **DNS pointing `mesh.` at the wrong box.** `fleet-node-link › foreign server cert: frontdoor_key_mismatch, zero bytes written, logged once per hour` and `frontdoor-probe › probe reaching a different cert raises dns_probe_failed`.
5. **A node crashing and reconnecting inside the heartbeat window.** `frontdoor-registry › second connection takes over within 5 s when the old link does not pong` and `frontdoor-router › boot_id change marks cached jobs node_restarted`.

## 11. Deviations from the parent

1. **§7.1 SNI.** The listener reads the ClientHello instead of relying on `SNICallback`, because `requestCert` is server-wide in Node.
2. **§7.1 ACME.** TLS-ALPN-01 is used instead of HTTP-01, keeping one public port. The certificate key is stable across renewals because F3's phones pin the leaf SPKI (R21).
3. **§7.1 "pinned node keys".** The mesh TLS certificate key is P-256 (`generateTlsCertificate` uses `prime256v1`), not the Ed25519 node key. Both are pinned and bound through the TLS exporter.
4. **§5.1 pairing.** Pairing runs over HTTPS on `mcp.`, because `mesh.` drops unpinned keys. The node's pin lives in `<configDir>/front-door.json`. The first node and the first phone are confirmed at the front-door console (R22).
5. **§5.1 step 4.** Node enrollment is the new message `kl.node.enroll`; §6.4's enrollment is for devices.
6. **§7.2 consent.** The owner types the browser's code on the phone (R23). The grant also binds `frontdoor_id`, `resource`, `code_challenge` and `user_code`. Acceptance runs on the front door's clock.
7. **§10.** Audit uses F3's `AuditLedger` (ruling 7). History is served as node-signed slices, so the phone never sees unsigned mirror data. Mirror retention is unlimited by default (R26), unlike the parent's 1 year.
8. **§5.6.** The repo has no MCP SDK; the stdio server and its tests are hand-written, and so is the HTTP endpoint.
9. **§8.2 `send_to_job`.** It is refused with `node_busy` while a turn runs, rather than queued.
10. **§8.3 progress.** Progress notifications are sent only on long-poll `get_job`, because `run_runbook` must return at once.
11. **§7.4 "neither trusts the other".** The node's scope re-check relies on front-door-supplied scopes. The binding guarantees are node policy and the phone signature.
12. **§4.3 build profiles.** `mcp` on a runbook node was loading the agent core (F6 D4). F4 stops that, and when the service runs, jobs are owned by the service.

## 12. Assumptions made without asking

- Access, refresh and code tokens are opaque (alternative: JWT access tokens).
- Refresh tokens expire after 30 days idle with no absolute cap (alternative: a 90-day absolute cap).
- There is a 30 s refresh-retry grace, once per rotation (alternative: strict single use).
- A client matching no default has only `fleet:read` preselected (alternative: nothing).
- `send_to_job` during a running turn returns `node_busy` (alternative: queue one message).
- An idle delegate session holds no job slot (alternative: every open session holds one).
- Revoking a device does not revoke the grants it approved (alternative: cascade).
- F3 relay node records are not migrated; nodes re-pair (alternative: a signed adopt flow).

## 13. Deferred

- `delegate(…, case)`: C7.
- Forwarding the phone-signed grant so nodes verify scopes themselves: later, if owners ask. It needs front door and node approver sets to match.
- HTTP-01 / DNS-01 challenges, token introspection, DPoP: later.
- More than one front door / high availability: later.
- Mirroring the front door's own ledger off-box: later.
- Web approval fallback: non-goal.
- Queued `send_to_job`: later, if clients need it.

## 14. Dependencies (npm)

| Package | Why | Rejected alternative |
|---|---|---|
| `acme-client`, exact version pinned (no caret), ≥ 5.3 for `createAlpnCertificate` | RFC 8555 edge cases (`badNonce` retry, order polling, `Retry-After`) and TLS-ALPN-01 certificate generation. Certificate issuance is security-critical, so a maintained client is used. The plan asserts that its installed tree has no install scripts and no `.node` binaries | an in-house RFC 8555 client (JWS, CSR in ASN.1, the RFC 8737 `acmeIdentifier` extension from scratch); `greenlock` (unmaintained, heavy) |

No other new dependencies. `ws` (existing) carries the mesh. HTTP, TLS and crypto come from Node
built-ins, YAML from the existing `js-yaml`, and JCS from `src/platform/jcs.js`.
