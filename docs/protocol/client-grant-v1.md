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
`challenge` comes from `POST /v1/challenges` with purpose `revoke` (§4.6).

### 3.3 `kl.node.enroll` (phone)

`{ v, type, frontdoor_id, pairing_id, node_id, node_name, profile, public_key,
tls_fingerprint, replaces, decision, nonce, device_id, signed_at }`. `profile`
is `agent` or `runbook`; `replaces` is `null` or the node id being replaced.

### 3.4 `kl.node.remove` (phone)

`{ v, type, frontdoor_id, node_id, challenge, device_id, signed_at }`.
`challenge` comes from `POST /v1/challenges` with purpose `remove` (§4.6).

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
`old_spki ≠ new_spki` (a message where they are equal is `malformed`).

## 4. What the front door checks

Steps in order; the first failure is the `reason`. A published test key (the
keys in `tests/vectors/approval-v1/keys.json`) is refused as `test_key`
wherever a step says so, unless the verifier was built with `allowTestKeys`,
which only tests do.

Every expiry is inclusive: a pending authorization, pending pairing or
challenge is live while `now <= expires_at` on the verifier's clock, and
expired from the next millisecond.

### 4.1 Every phone message

Opens canonically and matches its shape (`malformed`, `unsupported_version`);
`alg = ES256` and `kid = device_id` (`malformed`); the device is in the front
door's approver set (`unknown_device`), not `demo` (`demo_device`), not a
published test key (`test_key`), active (`revoked_device`); the signature
verifies (`bad_signature`); `frontdoor_id` is this front door
(`wrong_frontdoor`). On a re-check at load, a revoked device's message stays
valid iff the front door accepted it before `revoked_at`.

### 4.2 `kl.client.grant`

A pending authorization with this `grant_id` (`unknown_request`); if the request
has been claimed, signed by the device that claimed it (`not_claimant`) — an
unclaimed request may be decided by any active approver (§4.1); not expired on the front door's clock
(`expired`); `client_id`, `client_name`, `redirect_uri`, `resource`,
`code_challenge` byte-equal (`binding_mismatch`); `user_code` equal
(`user_code_mismatch`); `nonce` unused (`replay`); on `approve`, every scope was
requested and is supported, and `fleet:unsafe` comes with `fleet:run` or
`fleet:delegate` (`invalid_scope`).

### 4.3 `kl.node.enroll`

`node_id` derives from `public_key` (`node_id_mismatch`); `public_key` is not a
published test node key (`test_key`); a pending pairing with this `pairing_id`
(`unknown_pairing`), unexpired (`expired`), whose node fields equal the message
(`binding_mismatch`); nonce unused (`replay`).

### 4.4 `kl.node.pair` (on `POST /pair/v1`)

`alg = Ed25519`, `kid = node_id` (`malformed`); `node_id` derives from
`public_key` (`node_id_mismatch`); `public_key` is not a published test node
key (`test_key`); the signature verifies (`bad_signature`); `frontdoor_host` is
this front door's `mcp.` host (`wrong_host`); `tls_cert` parses (`malformed`).

### 4.5 `kl.node.pair.accept` (on the node)

Opens canonically and matches its shape (`malformed`); `frontdoor_public_key`
parses as a raw Ed25519 key (`malformed`), and the front door id is derived from
it; `alg = Ed25519` (`malformed`); `kid` and `frontdoor_id` equal that id
(`wrong_frontdoor`); the signature verifies
(`bad_signature`); `node_id` is this node (`wrong_node`); `nonce` echoes the
request (`nonce_mismatch`).

### 4.6 Challenges (`kl.client.revoke`, `kl.node.remove`)

`POST /v1/challenges` takes `{ purpose }`, one of `revoke` (spent only by
`kl.client.revoke`) and `remove` (spent only by `kl.node.remove`), and returns
`{ challenge, expires_in_ms: 120000 }`: 32 random bytes, single use, two
minutes on the front door's clock, at most 20 live per device. Any other
purpose is refused.

After §4.1, the challenge was issued to this device (`unknown_challenge`), for
this message's purpose (`challenge_wrong_purpose`), is unused
(`challenge_reused`) and unexpired (`challenge_expired`). Only an accepted
message uses the challenge up.

### 4.7 `kl.relay.repin` (on the phone; ported as `verifyRepin`)

Against the front door pinned from the `kl.pair` QR:

1. the pinned front-door key parses as a raw Ed25519 key (`malformed`);
2. the envelope opens canonically and matches its shape (`malformed`);
3. `alg = Ed25519` (`malformed`);
4. `kid` and `frontdoor_id` equal the pinned front door's id (`wrong_frontdoor`);
5. the signature verifies against the pinned key (`bad_signature`);
6. `new_spki` equals the SPKI of the certificate just received (`spki_mismatch`);
7. `old_spki` equals the current pin (`old_pin_mismatch`).

## 5. What the phone does

- **Builds** `kl.client.grant`, `kl.client.revoke`, `kl.node.enroll`,
  `kl.node.remove` exactly as in §3, JCS-encodes and signs with the device key
  behind biometrics. It signs only for a code the owner typed from their own
  browser; it never shows a request it was not given by typing its code.
- **Asks** for a challenge with the purpose of the message it is about to sign
  (`revoke` before `kl.client.revoke`, `remove` before `kl.node.remove`).
- **Shows** `client_name` as "(self-declared)", the client host and redirect
  host, and `origin.client` of approval requests as "Client (reported by
  front door)".
- **Re-pins** (§3.3.1 of the stage 4 spec) only when all hold: the envelope
  verifies against the front-door key pinned from the `kl.pair` QR (`node.key`
  where `node.id = frontdoor_id`), `new_spki` equals the SPKI of the
  certificate just received, `old_spki` equals the current pin (§4.7). Any
failure — including `wrong_frontdoor`, a re-pin signed by some other front
door — leaves the pin unchanged and shows:
  "Relay certificate changed — scan a new relay code".

## 6. User codes

The browser shows `XXX-XXX`. The phone accepts what the owner types, refuses
input longer than 64 characters, drops `-` and all whitespace, upper cases it,
maps `O→0`, `I→1`, `L→1`, and refuses anything that is not then six alphabet
characters.

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
| `POST /v1/challenges` | `{ purpose: 'revoke' \| 'remove' }` → `{ challenge, expires_in_ms: 120000 }` (§4.6) |
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
published test keys; never ship or pin them). `generate.js --check` exits 1 if
any committed file differs from what it builds. Every vector whose check has a
test-key rule and uses the published keys sets `given.allow_test_keys: true`,
except `pair-reject-test-key`, which shows the refusal. Consumers:

| Vectors | Consumers | Run as |
|---|---|---|
| `grant-*` | node; phones for `grant-approve`, `grant-deny` | `checkGrantDecision` with `given.pending`; phones build `expect.message` and compare bytes |
| `client-revoke-*`, `remove-valid` | node; phones for `client-revoke-valid`, `remove-valid` | challenge store from `given.challenges` (`{ challenge, device_id, purpose, expires_at, used }`) |
| `enroll-*` | node; phones for `enroll-valid` | pending pairing from `given.pairing` |
| `pair-valid`, `pair-reject-*` | node | `checkNodePair` with `given.frontdoor_host`, `given.allow_test_keys` |
| `pair-accept-valid` | node | `given.node_id`, `given.nonce` |
| `repin-*` | all | `given.frontdoor`, `given.received_spki`, `given.current_pin` |
| `fingerprint-grouping` | all | node fingerprints and typed user codes |

The client-revoke vectors are named `client-revoke-*` because approval-v1
already has a `revoke-valid` (device revocation); one name never covers two
messages.

A change to this document is complete only when `generate.js` has been rerun
and every consumer passes again.
