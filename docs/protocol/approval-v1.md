# approval-v1 — signed phone approvals

This is the wire protocol between a King Louie node, the relay, and the phone
apps. The iOS and Android apps are built from this document alone and must pass
every vector in `tests/vectors/approval-v1/` whose `consumers` name them. The
Node implementation lives in `src/approvals/`, `src/audit/` and `src/frontdoor/`.

## 1. Canonical form and envelopes

Every signed message is a JSON object serialized with RFC 8785 (JCS): object
keys sorted by UTF-16 code units, no whitespace, strings escaped as
`JSON.stringify` does (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other controls
below U+0020 as lowercase `\u00xx`, everything else literal UTF-8), numbers in
ECMAScript form. Phones only ever canonicalize messages made of strings,
integers and nested objects (`response`, `enroll`, `revoke`), so they need no
number formatting.

A signed message travels as an envelope:

```json
{ "alg": "Ed25519", "kid": "kl-c2ubd6jjqumalzt5", "payload": "<b64url(JCS bytes)>", "sig": "<b64url>" }
```

- `alg` is `Ed25519` (nodes) or `ES256` (phones). `kid` is the signer's
  `node_id` or `device_id` and equals the id inside the payload.
- `payload` is base64url without padding of the JCS bytes; `sig` is base64url
  of the 64-byte signature over exactly those bytes. ES256 signatures are raw
  `r || s` (IEEE P1363), not DER — a DER-encoded ECDSA signature, or one whose
  decoded length is anything other than 64 bytes, is rejected outright, never
  reinterpreted.
- Verifiers check the signature over the bytes they received and never
  re-serialize to verify. Nodes additionally require the bytes to be canonical
  (`malformed` otherwise), which rules out duplicate keys.

## 2. Keys and identifiers

- Node keys are Ed25519, carried as DER SubjectPublicKeyInfo hex. A node id is
  `kl-` + the first 16 characters of lowercase, unpadded RFC 4648 base32 of
  SHA-256 over the raw 32-byte key.
- Phone keys are P-256, carried as a JWK with exactly `kty: "EC"`,
  `crv: "P-256"`, `x`, `y` (32-byte base64url each). A verifier that accepts a
  device JWK also confirms `(x, y)` is an actual point on the P-256 curve, not
  merely two 32-byte values — an off-curve pair is refused the same as a
  malformed one, before it ever reaches signature verification. A device id is
  `d-` + the first 16 base32 characters of SHA-256 over the 65-byte
  uncompressed point `0x04 || x || y`. Desktop devices use the 32-byte
  Ed25519 key with prefix `kld-` (vector `device-id-ed25519`).
- Fingerprints are shown to people in groups of four: `d-abcdefghijklmnop` →
  `abcd efgh ijkl mnop`.
- An Android phone may also hold a second P-256 key, its **read key**, beside
  the device key that decides ("Revised 2026-10-28: the read key", at the end
  of this document).

## 3. Messages

Timestamps are RFC 3339 UTC: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`.
Nonces are 32 random bytes in base64url (43 characters). Request ids are UUID v4.

A message whose `type` has no registered validator on the reader is invalid
(`malformed`) — there is no generic fallback that accepts an unrecognised type
by checking only its common fields. A node or phone that does not yet know a
type (a future `kl.lease.*` or `kl.question.answer`, for example) must treat it
as malformed, not silently pass it through.

Field limits on the messages a phone writes (a node enforces every one of
these; an app that wants a friendlier error than `malformed` should check them
itself before signing):

- `device.name` is 1–64 **UTF-16 units** (`String.length` in JS terms) — not
  code points, unlike the code-point caps below. A name entirely of astral
  characters (surrogate pairs) is capped at 32 of them, not 64.
- `kl.device.revoke`'s `reason` is at most 200 **code points**.
- `action.summary` is at most 300 code points; `origin.client`/`origin.session`/
  `origin.job_id` are at most 200 code points each.
- Every timestamp must be a real calendar date and time, not merely
  regex-shaped: a receiver round-trips it through `Date.UTC` and rejects a
  syntactically valid but nonexistent moment such as `2026-02-30T00:00:00Z`
  or `2026-01-01T24:00:00Z`.
- `nonce` is exactly 32 random bytes, base64url without padding (43
  characters); `code_id` is 16 random bytes the same way (22 characters).

### 3.1 `kl.approval.request` (node-signed)

```json
{ "v": 1, "type": "kl.approval.request", "request_id": "<uuid v4>", "node_id": "kl-…", "node_name": "web-01",
  "action": { "kind": "runbook", "name": "site.pull_and_restart", "params": { "ref": "main" },
              "steps": [["git","-C","/srv/site","fetch","--prune","origin"], {"check":{"http_get":"https://www.example.com/healthz","expect_status":200,"retries":5}}],
              "cwd": "/srv/site", "summary": "Run runbook site.pull_and_restart on web-01" },
  "action_hash": "<b64url sha256 of JCS(action)>", "origin": { "client": "stdio-mcp", "session": null, "job_id": "job-…" },
  "created_at": "…", "expires_at": "…", "nonce": "<b64url 32 bytes>" }
```

| `action.kind` | Fields |
|---|---|
| `tool` | `name`, `params`, `cwd` (string or null), `summary` |
| `runbook` | `name`, `params` (validated), `steps` (each `run` argv substituted, each `check` as written), `cwd` (string or null), `summary` |
| `envelope` | `name` (executor id), `params: { case_id, envelope_hash }`, `summary` |

`cwd` is the directory the node will actually run the action in — for a
runbook, the directory its `run` steps execute in, which is not always
redundant with an explicit `-C`/absolute path inside the argv itself. It is
part of the hashed action like everything else: two actions that differ only
in `cwd` hash differently, and a response's `action_hash` only matches the one
the node is really about to run. `cwd` belongs only to `tool` and `runbook`
actions (string or `null`, never omitted — a `tool` or `runbook` action
missing the `cwd` key at all is malformed, not defaulted); `envelope` actions
have no `cwd` field at all, since they name a C3 executor and case, not a
directory. Every action kind requires `summary`.

`origin` is `{ client, session, job_id }`, plus `deviceId` when `client` is `desktop`.
The request lives at most 300 seconds (`expires_at − created_at`, 30–300 s).

### 3.2 `kl.approval.response` (phone-signed)

`{ v, type, request_id, node_id, action_hash, nonce, decision, expires_at, device_id, signed_at }` —
`request_id`, `node_id`, `action_hash`, `nonce` and `expires_at` are copied from
the request; `decision` is `approve` or `deny`; `signed_at` is the phone's clock
and is recorded, never judged. No other members are allowed.

### 3.3 `kl.approval.status` (node-signed)

`{ v, type, request_id, node_id, state, device_id, reason, at }` with `state` one
of `approved`, `denied`, `expired`, `withdrawn`, `refused`.

### 3.4 Enrollment and revocation (phone-signed)

`kl.device.enroll`: `{ v, type, device: { device_id, name, platform, public_key }, enrolled_by, created_at, expires_at, nonce }`.
`device` may also carry `read_key` ("Revised 2026-10-28", at the end).

- Console enrollment: `enrolled_by: null`, signed by the new device itself
  (`kid = device.device_id`), plus `code_id` and
  `code_mac = b64url(HMAC-SHA256(key = the 32 raw bytes of code, JCS(message without code_mac)))`.
  The node's `expires_at` check fails closed: a missing, unparseable or
  otherwise non-numeric clock is treated as already expired, never as "cannot
  tell, so allow it".
- Signed enrollment of another phone: `enrolled_by` is the signing device's id
  (`kid = enrolled_by`) and there is no `code_id`/`code_mac`.
- `expires_at − created_at` is at most 10 minutes. `platform` is `ios`,
  `android` or `demo` (nodes never accept `demo`).

`kl.device.revoke`: `{ v, type, device_id, revoked_by, reason, created_at, expires_at, nonce }`,
`kid = revoked_by ≠ device_id`, at most 7 days between `created_at` and `expires_at`.

A relayed enroll or revoke that a node stages is judged against its own
`created_at` age, never the time the node happened to receive it
(`received_at` is recorded for operators but decides nothing):

- A `created_at` more than 5 minutes ahead of the node's clock is refused as
  `from_the_future`, ahead of the ordinary expiry check. Without this, a
  message dated far enough into the future would never look "too old" — for a
  revoke, that would let it defer an unresolved enrollment indefinitely
  instead of aging out within the normal 7-day window.
- A **revoke always wins**: once a node accepts a well-formed, correctly
  signed revoke, the target device is blocked immediately through an
  in-memory overlay (set before anything is durably written) and stays
  blocked even if the revoked device was not enrolled yet. If an enroll for
  that same device id is relayed too — in either order — the enroll itself
  is still *staged* (staging only checks the signer, not whether the
  target is currently blocked); it is the administrator's `device apply`
  step that resolves the conflict and refuses it (`device was revoked`),
  and the revoke stays staged (not moved aside as resolved) for as long as
  it has not aged out or been applied. A thief who revokes the owner's
  phone can never use that revoke to also stop the owner's own
  counter-revoke: revokers are judged against the node's admin-applied set,
  never the overlay.
- An approver set a node has not yet verified as admin-owned (or has
  verified and found wrong) is treated as empty for every purpose,
  including staging: every signer check a relayed enroll or revoke needs
  (`isActive`/admin-applied) reads that empty set, so nothing can be staged
  at all while the store is untrusted — every attempt is refused
  `signer_not_active`, the same reason as a signer that legitimately isn't
  an approver. There is no separate "trust nothing but still accept
  submissions" state.

### 3.5 Node control messages (node-signed)

- `kl.enroll.open { v, type, node_id, code_id, expires_at, nonce }`
- `kl.enroll.done { v, type, node_id, code_id, enroll: <envelope> | null, refused, nonce }`
- `kl.audit.slice { v, type, node_id, entries, head: { seq, hash }, anchor: { seq, prev }, created_at }` —
  each entry's `hash` is hex SHA-256 over JCS of the entry without `hash`, and
  `prev` links to the previous entry. `anchor` is the oldest retained entry.
- `kl.audit.slice.head { v, type, node_id, seq, hash, at }`

If a previous append was interrupted mid-write, healing happens on the next
append: only then is the incomplete trailing line moved aside and truncated
off the live segment. In the meantime, any reader (a history slice, `tail`,
`entriesAfter`, `head`) simply skips that unacknowledged trailing line rather
than truncating it — a torn tail is never treated as the current tail, and
never handed to a phone or the relay as if it were real, whether or not an
append has come along yet to heal it for good.

### 3.6 Verifying `kl.audit.slice`

A phone, the relay's mirror, or any other reader checks a history slice in
this order; the first failure decides the reason:

| # | Check | Reason |
|---|---|---|
| 1 | Signature verifies against the node's pinned key | `bad_signature` |
| 2 | Envelope opens, shape matches `kl.audit.slice` | `malformed`, `unsupported_version` |
| 3 | `kid` equals `node_id` inside the payload | `malformed` |
| 4 | Every entry's own `node_id` equals the slice's `node_id` | `foreign_entry` |
| 5 | Every entry's `hash` matches SHA-256(JCS(entry without `hash`)) | `hash_mismatch` |
| 6 | Consecutive entries chain (`seq` increments by 1, `prev` equals the previous entry's `hash`) | `broken_chain` |
| 7 | The last entry does not read past the slice's own signed `head` (`seq` ≤ `head.seq`; equal `seq` implies equal `hash`) | `exceeds_head`, `head_mismatch` |
| 8 | The first entry does not read before the slice's own signed `anchor` (`seq` ≥ `anchor.seq`) | `before_anchor` |

The check is always against the slice's *own* signed `head` and `anchor`, not
some other value the reader already has cached — a reader that wants to detect
a rollback or a fork compares the newly verified `head` against the last one
it trusted itself, as a second step after this table passes.

## 4. What the node checks on a response

In this order; the first failure decides the reason (vectors `response-*`).

| # | Check | Reason |
|---|---|---|
| 1 | Envelope opens, bytes canonical, `v === 1`, right type, fields well formed | `malformed`, `unsupported_version` |
| 2 | `alg === 'ES256'`, `kid === device_id` | `malformed` |
| 3 | Device is in the node's approver set | `unknown_device` |
| 4 | Not a demo device; not a published test key | `demo_device`, `test_key` |
| 5 | Not revoked (admin-applied or pending revocation) | `revoked_device` |
| 6 | Signature | `bad_signature` |
| 7 | `node_id` is this node | `wrong_node` |
| 8 | Nonce not already used: same bytes → `replay`, other bytes → `already_decided` | `replay`, `already_decided` |
| 9 | Request pending, and nobody else is already deciding it | `unknown_request`, `already_decided` |
| 10 | `nonce`, `action_hash`, `expires_at` match the request | `nonce_mismatch`, `action_hash_mismatch`, `expires_mismatch` |
| 11 | Node clock ≤ `expires_at` | `expired` |
| 12 | The action rebuilt from live state hashes to `action_hash` | `action_changed` |
| 13 | Audited | `audit_unavailable` |

Ahead of all of this: a node that is shutting down refuses every response at
once with reason `stopped`, without opening the envelope at all — there is
nothing left to bind a decision to.

`already_decided` at step 9 is a different mechanism from step 8's: step 8
compares this response's nonce against ones already recorded as decided
(a prior response, possibly minutes ago); step 9's is a live race — a second
response for the same request arriving while a first one is still inside its
step-13 audit await for that same request. Both are refused the same way for
the same underlying reason (this request already has an answer, or is in the
middle of getting one), just caught at different points.

Steps 11 and 12 run a second time after step 13's audit append, before the
decision is actually committed: appending to the audit ledger is an await, and
in that window the live action a runbook or tool would execute can change, or
the deadline can pass, even though the checks immediately before step 13
proved the request was still good *at that moment*. Only the hash and clock
read *after* the audit write is durable are trusted to describe what will
really run. The two second-pass failures end differently, matching what a
first-pass failure at the same check would have done: a mismatched action
(step 12 again) ends the request **denied**, with status `refused` and
reason `action_changed`; an expired deadline (step 11 again) ends the request
as **expired** (status `expired`), not denied — the phone did not answer too
late in a way that should ever read as a "no", it simply ran out of time.

A first-pass `action_changed` (step 12, before the audit) also *consumes*
the response's nonce before ending the request: the nonce is recorded as
decided on the spot, so the same phone resubmitting the identical envelope
gets `replay`, and a different envelope reusing that nonce gets
`already_decided` — either way, there is no way to "retry" a response that
was refused for not matching the live action. Every other pre-audit rejection
(steps 1–11) leaves the nonce unconsumed, since none of them commit to having
seen a decision for this request.

Separately, the same await can let the request finish for an unrelated reason
while the audit write is in flight — it is withdrawn (the caller aborted),
the node stops, or its own expiry timer fires. If the request is no longer
pending when the audit append returns, the node reports whichever of those
actually ended it, never a guessed reason.

This table is also what feeds `reason` in the relay's
`202 { delivered: true, accepted, reason }` reply to
`POST /v1/approvals/{request_id}/response` (§7): the phone shows the app user
the exact cause, including `action_changed`, `expired` or `stopped`, rather
than a generic failure.

`accepted` is `true` or `false` only when the node's service judged the
response itself. When the request belongs to a local requester in another
process on the node (a `mcp` process asking through the service's file
courier), the service forwards the response to that requester and answers
`{ delivered: true, accepted: null, reason: null }`: the response was
forwarded to a local requester, and the relay does not know the verdict. The
phone shows "sent to <node>" for `accepted: null`. It never shows it as
approved, and the node never treats it as one; only `=== true` approves. The
outcome shows up later in the request's status and in the node's history.

`accepted: null` can also come with `delivered: false`: that local
requester's inbox is gone or unusable (the requester has exited, or its inbox
is no longer a plain directory), so the service had nowhere to hand the
response. Nothing on the node saw it, and the phone shows "not delivered",
never "sent" or approved. (A failed write into an inbox that does exist is an
error, not a 202: the phone sees the request fail and can send again.)

## 5. What the phone checks and shows

- **Shape first.** The same shape check a node runs (`validateMessage` against
  `kl.approval.request`) runs before anything about pinning or signatures is
  even considered: a malformed envelope or message is refused (`malformed`,
  vector `request-malformed`), even one that happens to be signed by a node
  the phone has pinned. Only a message that is already shape-valid is checked
  further.
- **Keys equal under Unicode normalization.** Phones refuse as `malformed`
  any JSON they parse (envelope payloads, QR codes, relay replies) with a
  duplicate object key, and also with two keys in one object that are equal
  under Unicode canonical equivalence (NFC/NFD, e.g. the keys U+00E9 and
  U+0065 U+0301). Both apps must refuse them. Swift's `String` compares by
  canonical equivalence and so cannot keep both keys; Kotlin compares by
  UTF-16 units, but Android refuses them too, so that the two apps agree. A
  node does not normalize. It treats such keys as distinct, and its canonical
  check refuses only exact duplicates. So a request whose parameters carry
  such a key pair is valid on the node, but no phone shows it, and it ends
  as timed out, never approved.
- A request is shown only if its `node_id` is pinned (from a pairing or invite
  QR code, never from the relay's node list) and `kid === node_id`
  (`unpinned_node` otherwise), and its signature verifies against the pinned
  key (`bad_node_signature`). A node whose key changed shows "Node key changed —
  pair again".
- Time left counts from receipt: the relay sends `expires_in_ms`; the phone
  counts it down on a monotonic clock and refuses to sign at zero.
- The approval screen (vectors `request-display`, `request-display-edge`)
  shows:
  - `node.name` and `node.id`, `kind`, `name`, `summary`, `cwd`, `origin` — all
    escaped as below.
  - `items`: every parameter, flattened in JCS key order (`Object.keys(...)
    .sort()`, comparing UTF-16 code units — the same order JCS itself uses,
    under which an astral-prefixed key can sort before a key starting with
    U+FFFD even though its code-point value is larger) with paths such as
    `params.a.b` and `params.list[0]`, then every runbook step as `steps[i]`.
    Strings are shown in full; numbers, booleans and null as their JSON text
    (the payload is canonical, so this is the text received); empty objects and
    arrays as `{}` and `[]`.
  - **Path segments are escaped and, when ambiguous, bracket-quoted.** Each
    key is run through the same hidden-character escaping as any other
    displayed text. A key that would otherwise look like path syntax — one
    containing `.`, `[`, `]`, `"`, or any hidden character — is instead shown
    bracket-quoted, `["<escaped key>"]` (with `\` and `"` inside it
    backslash-escaped), rather than appended after a dot. This keeps two
    different structures from ever producing the same path text: an object
    key literally named `"a.b"` displays as `params["a.b"]`, never colliding
    with a nested `{ a: { b: … } }`'s `params.a.b`; a key containing a bidi
    override and a newline displays as `params["x‹U+202E›‹U+000A›y"]`, never
    as raw, potentially path-reordering text sitting after a plain dot. An
    array index (`[0]`) is never quoted — only an object-key segment can be.
  - Command-like values (a key named `command`, `script` or `argv` anywhere on
    the path, and every `run` step) are joined into one string for display.
    Joining quotes any item that is empty or contains a `"` or a code point
    from this EXACT list — not a language's built-in "whitespace" character
    class, since JavaScript's `\s`, Kotlin's (ASCII-only) `\s` and ICU's
    definition of whitespace all disagree, which would make the two apps
    quote differently for the same argv: U+0009–U+000D, U+0020, U+00A0,
    U+1680, U+2000–U+200A, U+2028–U+2029, U+202F, U+205F, U+3000, U+FEFF.
    (with `"` inside a quoted item backslash-escaped), so item boundaries
    stay visible even when they wouldn't be with a plain space join —
    `["run.sh", "", "has space"]` displays as `run.sh "" "has space"`, not
    `run.sh  has space` (indistinguishable from three plain words).
  - A command-like string longer than 2000 **Unicode code points** — not
    UTF-16 units, so a value made entirely of astral characters (surrogate
    pairs) can be twice as many UTF-16 units as this limit without
    collapsing — is collapsed to its first 1200 and last 400 code points,
    with the count of hidden code points between them ("N characters hidden —
    Show all"). `check` steps are never collapsed; they are shown as their
    JCS text.
  - In every displayed string (`node.name`, `name`, `summary`, `cwd`, every
    `origin` value, every item's `text`/`tail`, and every escaped path
    segment), a code point in any of these EXACT ranges — not a live
    Unicode-property lookup, which would drift across platform Unicode
    versions — is replaced by `‹U+XXXX›` (uppercase hex, at least four
    digits):
    - **Cc** (control): U+0000–U+001F, U+007F, U+0080–U+009F
    - **Zl/Zp** (line/paragraph separator): U+2028, U+2029
    - **Bidi_Control**: U+061C, U+200E–U+200F, U+202A–U+202E, U+2066–U+2069
    - **Default_Ignorable_Code_Point** (Unicode 15.1): U+00AD, U+034F,
      U+115F–U+1160, U+17B4–U+17B5, U+180B–U+180F, U+200B–U+200F,
      U+2060–U+206F, U+3164, U+FE00–U+FE0F, U+FEFF, U+FFA0, U+FFF0–U+FFF8,
      U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+E0000–U+E0FFF
    (vector `request-display-edge` exercises one representative from each
    range: U+061C, U+2028, U+2060, U+00AD, U+FE0F, and the tag character
    U+E0041.)
- Each item in the vector is `{ path, text, tail, hidden }`: `tail` is null and
  `hidden` 0 unless the value was collapsed.
- The `action_changed` and `expired` reasons above are not just node-internal:
  a phone that approves a request can get either one back in the `202`
  response's `reason` (§4, §7) and should show it as "the action changed
  before it ran" / "too late — request expired", not as a generic failure. A
  relayed enroll or revoke a phone submits can likewise come back with
  `from_the_future` if its own clock is skewed too far ahead of the node's.

## 6. QR codes

`kl1:` + base64url(JCS(object)). Node keys are DER SPKI hex.

| `t` | Printed by | Fields |
|---|---|---|
| `kl.pair` | `king-louie-service enroll-device` | `relay`, `relay_spki` (`sha256/<b64url of SHA-256 over the leaf certificate's SPKI DER>`), `code_id`, `code`, `node: { id, name, key }` |
| `kl.invite` | an enrolled phone | `relay`, `relay_spki`, `invite_id`, `secret` (b64url 32 bytes), `nodes: [{ id, name, key }]` |
| `kl.relay` | `king-louie-service relay qr` | `relay`, `relay_spki` |

Phones pin the relay's leaf SPKI and ignore certificate authorities.

## 7. Phone API (relay, HTTPS, JSON, prefix `/v1`)

Device authentication: headers `X-KL-Device`, `X-KL-Timestamp` (RFC 3339 UTC)
and `X-KL-Signature = b64url(ES256-P1363(UTF-8 of S))` where

```
S = "KL-PHONE-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body))
```

The relay requires `|timestamp − relay clock| ≤ 120 s` (else `401
{"error":"clock_skew","server_time":"…"}`; the app applies the offset and
retries once), a registered device, a valid signature, and that
`SHA-256(S) || device_id` was not seen in the last 5 minutes. Code and invite
routes need no signature: the unguessable `code_id` / `invite_id` in the path is
the credential. Errors are `{ "error": "<code>", "message": "…" }`; `429`
carries `retry_after`. Rate limits: 10/min per IP unauthenticated, 120/min per
device. On a device route only a request that fails before its signature
verifies counts against its IP, and a request whose signature verifies is
never refused by the per-IP limit, so phones sharing an address (CGNAT, an
office NAT) are not locked out by a neighbour's failures.

| Method, path | Auth | Body → reply |
|---|---|---|
| `GET /v1/time` | none | → `{ server_time }` |
| `POST /v1/enroll/{code_id}` | code | enroll envelope → `202 { state: 'waiting' }` |
| `GET /v1/enroll/{code_id}` | code | → `{ state: 'waiting'\|'done'\|'refused'\|'expired', node }` |
| `GET /v1/approvals?wait=0..25` | device | → `[{ envelope, expires_in_ms, status }]`; waits up to `wait` s for something new since this device's last call |
| `GET /v1/approvals/{request_id}` | device | → `{ envelope, expires_in_ms, status }` / `404` |
| `POST /v1/approvals/{request_id}/response` | device | response envelope → `202 { delivered, accepted, reason }` (`accepted`: `true`/`false` as the node judged it, or `null` when it was forwarded to a local requester and the verdict is not known to the relay; `delivered: false` with `accepted: null` when that hand-off failed, §4) / `503 node_offline` / `410 gone` |
| `GET /v1/nodes` | device | → `[{ node_id, node_name, online }]` (no keys) / `403 forbidden` when the device approves on no node |
| `GET /v1/nodes/{node_id}/history?limit&before_seq` | device | → `kl.audit.slice` envelope |
| `POST /v1/pairing-codes` | device | `{ node_name }` → `{ code, expires_at }` |
| `POST /v1/devices/invites` | device | → `{ invite_id, expires_at }` |
| `POST /v1/devices/invites/{id}/claim` | invite | `{ device, mac }` → `202` |
| `GET /v1/devices/invites/{id}` | device | → `{ claim }` (inviting device only) |
| `POST /v1/devices/enroll` | device | enroll envelope → `{ nodes: [{ node_id, state }] }` |
| `POST /v1/devices/revoke` | device | revoke envelope → `{ nodes: [{ node_id, state }] }` |
| `GET /v1/devices` | device | → `[{ device_id, name, platform, nodes: [{ node_id, state }] }]` |
| `PUT /v1/push-token` | device | `{ platform: 'apns'\|'fcm', token }` → `204`; written only when the platform or token changed |
| `DELETE /v1/push-token` | device | → `204`; the relay forgets this device's token |
| `GET /v1/push-token` | device | → `{ registered, sender }`: whether the relay holds a token for this device, and has a sender for its platform; the token is never echoed |

An invite claim's `mac` is `b64url(HMAC-SHA256(key = the 32 raw bytes of secret, JCS(device)))`;
the inviting phone, not the relay, checks it.

`device` in the Auth column above is a device-key signature. Since
2026-10-28 a request may instead be signed with the device's read key; each
route takes either key or the device key only, and the table in "Revised
2026-10-28: the read key" (at the end) gives each route's key, including
the routes added since.

## 8. Push

Push carries only `{ kind, id }` (and the node name in the alert text): APNs
`{"aps":{"alert":…},"kl":{"rid":id,"k":kind}}`, FCM data `{ rid, n, k }`. Kinds:
`approval`, `grant`, `pairing`, `alert`, `question`, `lease`; a missing `k` means
`approval`. On a tap the app fetches the envelope and verifies it. Without push
the app long-polls `GET /v1/approvals?wait=25` while in the foreground.

Revised 2026-10-28 (push spec
`docs/superpowers/specs/2026-10-28-push-notifications-design.md`). Everything
below applies to devices whose push platform is `fcm` only; an `apns` device
gets exactly the pushes above, byte for byte. No signed message changed.

FCM data, every value a string:

| Field | Value |
|---|---|
| `k` | `approval`, `question`, `lease`, `pairing`, `alert`; `session_ended`, `session_paused` (lease-v1 §4, `push.notify`); `test` (`king-louie-service relay push-test`) |
| `rid` | the item's id: `request_id` (approval, lease), the question's token, the pairing or alert id, the `lease_id` (session kinds), a random id (test) |
| `n` | the node's name, control and format characters stripped, capped at 40; empty when unknown |
| `c` | only on a coalesced push: how many items it stands for, `2` to `999` |

Nothing else: no text of the action, no case, app, site or take name, no
reason code, no time left. `message.submit`'s `push` parameter still takes
only the six kinds above; the session kinds come only from `push.notify`, and
`test` only from the command.

- **Dedupe**, per device, by (node, kind, id): `session_ended` 24 hours,
  `session_paused` 2 minutes, every other kind 10 minutes; `test` never. At
  most 2,048 keys per relay, oldest out, in memory (a restart can repeat one
  push).
- **Coalescing**, per device, after dedupe: the first push goes at once and
  opens a 10-second window; what arrives in it is held, and when it closes
  one push goes, the newest held item whole, with `c` when two or more were
  held. A relay that stops drops what a window holds.
- **Cap**: at most 60 pushes per device per hour, counted when a push
  leaves; past that a push is dropped with one `warn` per device per hour.
- **`android.ttl`**: the seconds to `expires_at` when the push has one (an
  approval, a paused lease's own expiry), else 3,600 s for `session_ended`
  and 300 s for the rest. Priority `HIGH`.
- **Dropped tokens**: FCM `404 UNREGISTERED` and `403 SENDER_ID_MISMATCH` (a
  token of another Firebase project) drop the device's token; a `400` never
  does. The app registers again at its next cold start or token rotation.

The phone builds the visible text itself; a tap fetches with the read key
and shows only what a pinned node signed.

## 9. Vectors

`tests/vectors/approval-v1/<name>.json`: `{ name, consumers, check?, given, input, expect }`.
`keys.json` holds the fixed test keys (Ed25519 seeds for nodes, P-256 `d` for
devices A, B, C); nodes refuse these device keys unless built with
`allowTestKeys`. `generate.js` rebuilds every file; `phone-reference.js` is the
phone rules above in JavaScript. The set of vectors is not fixed at any
particular count — a change to this document is not complete until
`generate.js` and the vectors are regenerated and every consumer (the node,
and Part 4's iOS and Android protocol cores, which read every file in this
directory) passes again.

| Vectors | Consumers | Run as |
|---|---|---|
| `jcs` | all | `canonicalize(input.cases[i]) === expect.canonical[i]` |
| `device-id-p256`, `device-id-ed25519` | all | derive ids from `input` |
| `request-*` | ios, android | show / hide with `given.pinned_nodes`; compare `display` |
| `response-*` | node | pending request, approvers, overlay, used nonces from `given`; `{ accepted, reason }` |
| `enroll-console*` | node (and phones build `enroll-console` payloads the same way) | console check with `given.code_id`, `given.code` |
| `enroll-signed*`, `revoke-*` | node | stage each `input[i]`; `expect.results`, `expect.active` |
| `audit-slice` | all | signature, shape and chain of a history slice |
| `phone-api-auth` | all | `S` and body hash equal `expect`; the signature verifies |

**`keys.json`'s keys are not secret — never pin, embed or ship them.** Every
private half in that file (the Ed25519 seeds under `nodes`, the P-256 `d`
values under `devices`) is published in this repository's history, readable
by anyone who clones it. They exist only so a test can sign real, verifiable
envelopes without a genuine phone or a provisioned node identity. A node
never accepts platform `demo` as an active approver (`demo_device`,
unconditionally — see §3.4), and refuses a device whose public key matches
one of these published test keys (`test_key`) unless it was explicitly built
with `allowTestKeys: true` — production code never sets that flag. An app or
node build that pins one of these keys, or ships `keys.json` itself outside
`tests/`, has zero security from that key: anyone can produce a valid
signature for it, today or after this document changes.

## Revised 2026-10-28: the read key

Android app spec `docs/superpowers/specs/2026-10-28-android-app-slim-design.md`
§8 (owner ruling R-AN-5). Every change is additive: a phone with no read key
(every iOS phone, and an Android phone enrolled before this) works exactly as
before against an upgraded relay and node.

### Two keys

- The **device key** is the phone's key of §2: it decides. On Android each
  signature asks for a strong biometric.
- The **read key** is a second P-256 key in the Android Keystore that asks
  for nothing (no user authentication) but signs only while the phone is
  unlocked. It may sign two things: a read-key request to the relay (below)
  and `kl.lease.watch` (lease-v1, "Revised 2026-10-28"). Nothing it signs
  can approve, grant, answer, stop, enroll, revoke, connect, disconnect, pair,
  acknowledge or remove anything, on the node, the front door or the relay.
- A read key has no device id of its own: everything it signs names the
  device it belongs to. Its fingerprint for people is `r-` and the first 16
  base32 characters of SHA-256 over `0x04 || x || y` (the device id's rule,
  another prefix), in groups of four: `r-nzy7 gfgc 4j6g oetu`
  (`readKeyFingerprint` in `src/approvals/messages.js`).

### Enrollment carries the read key

`kl.device.enroll`'s `device` has exactly the four keys of §3.4, or exactly
those and `read_key`:

```jsonc
"device": { "device_id": "d-…", "name": "Pixel", "platform": "android",
            "public_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
            "read_key":   { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
```

- `read_key` is a P-256 JWK on the curve (§2) whose point is not
  `public_key`'s (`malformed` otherwise). `device_id` still derives from
  `public_key` alone.
- It is bound by whatever binds the device key: in a console enrollment the
  device's own signature and `code_mac`; in a signed enrollment the enrolling
  phone's signature; in an invite the claim's `mac` over `device` (the claim
  route accepts `read_key` and refuses one equal to `public_key`,
  `400 bad_device`), which the inviting phone checks before it signs.
- A published test key (`keys.json`, `A_read` and `B_read` included) as a
  read key is refused like one as a device key (`test_key`) unless the node
  allows test keys.

The node keeps it in the approver record (`<configDir>/approvers/<id>.json`):
two optional keys, `read_key` (the JWK) and `read_key_at` (the signed
`created_at` of the enrollment or statement that set it). A record may have
`read_key` without `read_key_at` (it then dates from `enrolled_at`), never
`read_key_at` without `read_key`; a `read_key` that is malformed or equals
`public_key` makes the record invalid. `enroll-device` (console) and
`device apply` (staged) write them and print "with a read key r-…" beside the
device's fingerprint before they ask; `device list` shows each record's read
key.

The relay keeps it in its device record as `read_jwk` and
`read_key_created_at`, set by every path that registers a device from an
enrollment (`enroll.done` once the node reports a console enrollment done,
and `POST /v1/devices/enroll`, which is where an invited phone's key arrives)
and by `POST /v1/devices/read-key`. Only a strictly newer `created_at`
replaces a stored read key; a re-registration keeps it.

### Read-key requests

A request signed with the read key carries one more header, and its signed
string has another first line:

```
X-KL-Device:    d-…            (the device, as for a device-key request)
X-KL-Key:       read
X-KL-Timestamp: 2026-10-28T14:05:09.120Z
X-KL-Signature: b64url(ES256-P1363 by the read key over UTF-8 of S)

S = "KL-PHONE-READ-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body))
```

Without `X-KL-Key`, or with `X-KL-Key: device`, a request is §7's
`KL-PHONE-V1` against the device key. The clock window, the replay cache and
the per-device rate limit of §7 are shared by both keys; the prefix keeps a
read signature from ever being a device signature over the same request.

Each route declares `read` (either key) or `device` (the device key only).
The relay's refusals:

| Case | Reply |
|---|---|
| `X-KL-Key` is neither `read` nor `device` | `401 bad_key` |
| `X-KL-Key: read` on a `device` route (refused before the signature is checked) | `403 read_key_not_allowed` |
| `X-KL-Key: read` from a device the relay holds no read key for | `401 unknown_read_key` |
| a signature that does not verify against the key the header names | `401 bad_signature` |

The rule for a route's key: a request that only reads, and a request whose
body is an envelope the device key signed (the envelope is the decision; the
relay or node checks its signature), take either key. A request that changes
something and carries no device-key envelope takes the device key. So a
decision costs one biometric signature, over the decision itself, whatever
key carries the request.

| Method, path | Key |
|---|---|
| `GET /v1/approvals`, `GET /v1/approvals/{request_id}` | read |
| `GET /v1/questions` | read |
| `GET /v1/leases`, `GET /v1/leases/{lease_id}/views` | read |
| `POST /v1/leases/{lease_id}/watch` | read (the body is a watch, which either key may sign) |
| `POST /v1/presence` | read |
| `GET /v1/nodes`, `GET /v1/devices`, `GET /v1/devices/invites/{id}` | read |
| `GET /v1/pairings/pending`, `GET /v1/alerts`, `GET /v1/clients`, `GET /v1/frontdoor`, `GET /v1/nodes/{node_id}/audit-status`, `GET /v1/nodes/{node_id}/history` | read |
| `PUT /v1/push-token`, `DELETE /v1/push-token`, `GET /v1/push-token` | read |
| `POST /v1/challenges` | read (a challenge is spent only by a device-key envelope) |
| `POST /v1/approvals/{request_id}/response` | read (body: a device-key `kl.approval.response`) |
| `POST /v1/leases/{lease_id}/grant`, `/revoke` | read (body: a device-key `kl.lease.grant` / `kl.lease.revoke`) |
| `POST /v1/questions/{token}/answer` | read (body: a device-key `kl.question.answer`) |
| `POST /v1/grants/{id}/decision`, `POST /v1/clients/{grant_id}/revoke`, `POST /v1/pairings/{id}/decision`, `POST /v1/nodes/{node_id}/remove` | read (body: a device-key client-grant-v1 envelope) |
| `POST /v1/devices/enroll`, `POST /v1/devices/revoke` | read (body: a device-key enroll or revoke, verified against the caller's device key) |
| `POST /v1/devices/read-key` | read (the first send is device-key, since the relay holds no read key yet; a re-send may be read-key) |
| `GET /v1/grants/pending?user_code=` | device (claims a client's request, no envelope) |
| `POST /v1/alerts/{id}/ack` | device (no envelope) |
| `POST /v1/pairing-codes`, `POST /v1/devices/invites` | device (opens a way in for a node or a phone, no envelope) |
| `GET /v1/time`, `GET /v1/repin` | none |
| `POST /v1/enroll/{code_id}`, `GET /v1/enroll/{code_id}` | code |
| `POST /v1/devices/invites/{id}/claim` | invite |

The same table is `ROUTE_AUTH` in `tests/frontdoor-phone-routes.test.js`,
which checks it against every route a relay and a front door register.

### `kl.device.read_key`: a phone enrolled before the read key

An Android phone enrolled with no read key makes one and states it, signed
with its device key (`kid` = `device_id`, `ES256`):

```jsonc
{ "v": 1, "type": "kl.device.read_key", "device_id": "d-…",
  "read_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "created_at": "…", "expires_at": "≤ created_at + 7 days", "nonce": "b64url(32)" }
```

Exactly those keys; `read_key` a P-256 JWK; `expires_at − created_at` more
than 0 and at most 7 days (`READ_KEY_MAX_MS`).

`POST /v1/devices/read-key`, body the envelope → `{ nodes: [{ node_id, state }] }`.
The relay checks, in order: the envelope opens and is a valid
`kl.device.read_key` (`400 malformed`); `device_id` and `kid` are the caller
and the caller's device key verifies it (`400 bad_read_key`); `created_at` is
not more than 5 minutes ahead of the relay's clock (`400 from_the_future`);
it has not expired (`400 expired`); the caller is active on at least one node
(`403 forbidden`); the key is not the device key (`400 bad_read_key`). It
then stores the key (a newer `created_at` replaces an older one) and forwards
the envelope as the node method `device.read_key` (`{ envelope }`) to every
node where the device is active. Each node's `state` is what it answered,
`read-key-pending-apply`, `applied`, `duplicate` or `rejected`, or `offline` for anything
else (no answer, or a node from before this change). The relay writes no
device-log entry for a statement; the phone re-sends it, with the read key, to
the nodes that answered `offline`, until it expires.

A node checks it like a relayed revoke (§3.4) and only stages it. The
`device.read_key` method carries only this type, and this type comes only by
that method (`malformed` otherwise). Then: shape (`malformed`),
`from_the_future`, `expired`; `alg` `ES256` and `kid` equal to `device_id`
(`malformed`); the device an active approver (`signer_not_active`) whose
**device key** verifies it (`bad_signature`: a statement signed by the read
key itself is refused); `read_key` not the device key (`malformed`) and not a
test key (`test_key`); the record's read key already (`{ state: 'applied' }`:
`device apply` has written it, so the phone can stop waiting; this also
answers a re-sent statement whose nonce the node has seen);
`created_at` after the record's current read key was set (`read_key_at`, else
`enrolled_at`; `stale` otherwise). A staged statement answers
`{ state: 'read-key-pending-apply' }` and is audited `device.staged` (a
refusal `device.rejected`, as for enroll and revoke). The same statement sent
again while it is still staged answers `{ state: 'duplicate' }`. Neither
`applied` nor `duplicate` is audited.

`king-louie-service device apply` lists a staged statement as
`read key  <device-id>  "<name>"  r-…  signed by the device itself  (<age>)`,
asks `[y/N]` as for an enrollment, and judges it against the admin-applied set
as it stood before the batch: the result is `read key set` (written as
`read_key` and `read_key_at`, audited `device.read_key_set`) or `rejected:`
with `created in the future`, `older than 7 days`, `malformed`, `device was
revoked`, `signer is not an active approver`, `test key`, `already set` or
`stale`. Statements are applied after the batch's enrollments and revokes,
newest first, so of two for one device the newer is written and the older is
then stale. The approver set is still written only by the administrator's
command.

Until a node has applied a phone's read key it refuses that phone's
read-signed watches (`bad_signature`); everything the relay serves works at
once, since the relay knows the key from the first post. A relay from before
this change answers `404` to `POST /v1/devices/read-key`.

### What the node checks

`verifyDeviceEnvelope` (`src/approvals/verify-device.js`) takes
`allowReadKey` (default false). Step 6 of §4 becomes: the signature verifies
against the record's `public_key`; or, only when `allowReadKey` is true and
the record has a `read_key`, against `read_key`; else `bad_signature`. The
result's `key` says which verified (`'device'` or `'read'`). Steps 1 to 5 and
7 to 8 are unchanged, so a revoked device's read key is refused with the
device (`revoked_device`), and a record whose read key is a published test
key is refused `test_key`. Only `verifyLeaseWatch` passes
`allowReadKey: true`; approval responses, lease grants and revokes, question
answers, signed executor approvals, enroll and revoke staging and the front
door's phone envelopes keep the default and refuse a read-key signature as
`bad_signature`.

### What it proves

A read signature proves that the app ran on an unlocked phone that holds the
key, not that the owner just authenticated. Someone holding the owner's
unlocked phone with the app open can read what the phone lists (every
Approval with every parameter, questions, a leased app's frames), keep a
computer-use lease that phone granted in contact until its approved expiry,
and report the phone in front; they cannot decide anything. The relay
operator gains nothing: it cannot sign with either key.

### Vectors

Eight more, 49 in all (`generate.js --check` says `49 vectors match`).
`keys.json` adds the read keys `A_read` and `B_read` (`{ d, jwk, read_key_of,
fingerprint }`, `read_key_of` naming the device they belong to), refused by
nodes as test keys like the others. `phone-reference.js` adds
`phoneReadAuthString`.

| Vector | Consumers | What |
|---|---|---|
| `phone-api-auth-read` | node, android | the `KL-PHONE-READ-V1` string and body hash; the read-key signature verifies against the read JWK and not the device JWK (`accepted_by_device_key: false`) |
| `enroll-console-read-key` | node, android (the phone builds the payload) | a console enrollment whose `device` carries `read_key`: accepted, and the record holds it |
| `enroll-console-read-key-equal` | node | `read_key` equal to `public_key`: `malformed` |
| `enroll-signed-read-key` | node | a signed enrollment carrying `read_key`: staged with it (`expect.staged_read_keys`) |
| `read-key-valid` | node, android (the phone builds the message) | a `kl.device.read_key`: `read-key-pending-apply` |
| `read-key-wrong-signer` | node | the statement signed by the read key itself: `bad_signature` |
| `read-key-from-the-future` | node | `from_the_future` |
| `response-reject-read-key` | node | an approval response signed by A's read key, A's record holding it: `bad_signature` |

iOS reads none of them; its vector tests filter on `ios`.
