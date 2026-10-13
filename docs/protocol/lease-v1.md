# lease-v1 — computer-use leases

A lease lets an agent drive a few allowlisted desktop apps on one node for a
bounded time, under one phone signature (fleet stage 5 spec §3.6, §4.1; the one
exception to trust principle 3). Envelopes, JCS, keys and identifiers are
approval-v1's (§1–§2 of `approval-v1.md`).

## 1. Messages

Node-signed (Ed25519, `kid` = `node_id`): `kl.lease.request`, `kl.lease.status`,
`kl.lease.view`. Phone-signed (ES256, `kid` = `device_id`): `kl.lease.grant`,
`kl.lease.revoke`, `kl.lease.watch`. Every object has exactly the keys shown.

```jsonc
{ "v": 1, "type": "kl.lease.request", "request_id": "uuid-v4", "lease_id": "uuid-v4",
  "node_id": "kl-…", "node_name": "gpu-box",
  "lease": { "kind": "computer_use", "job_id": "job-…",
             "apps": [{ "id": "calculator", "name": "Calculator", "path": "C:\\Windows\\System32\\calc.exe", "processes": ["CalculatorApp.exe"] }],
             "max_minutes": 15, "reason": "Enter the totals", "resumes": null, "limits": [] },
  "lease_hash": "b64url(SHA-256(JCS(lease)))",
  "origin": { "client": "claude.ai", "session": "…", "job_id": "job-…" },
  "created_at": "RFC3339", "expires_at": "≤ created_at + 5 min", "nonce": "b64url(32)" }
{ "v": 1, "type": "kl.lease.grant", "request_id", "lease_id", "node_id", "lease_hash", "nonce" (the request's),
  "decision": "grant" | "deny", "grant": { "apps": ["calculator"], "minutes": 10 } | null,
  "expires_at" (the request's), "device_id", "signed_at" (informational) }
{ "v": 1, "type": "kl.lease.revoke", "node_id", "lease_id", "reason": "kill_switch" | "owner", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.watch", "node_id", "lease_id", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.status", "node_id", "lease_id", "seq", "at", "state": "pending|active|suspended|ended",
  "locked": false, "reason": "…" | null, "expires_at": "…" | null }
{ "v": 1, "type": "kl.lease.view", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s",
  "foreground": { "app_id": "calculator" | null, "matches": true },
  "frame": { "mime": "image/jpeg", "width", "height", "sha256": "b64url(SHA-256(JPEG bytes))", "data": "base64" } | null,
  "frame_dropped": false,
  "actions": [{ "seq", "at", "tool", "summary" (≤ 120), "result": "ok" | "refused:<code>" }] (≤ 50) }
```

Rules: `lease.apps` 1–8 unique ids from `gui.apps`; `max_minutes` 1–60 and ≤
`gui.lease.max_minutes`; `reason` ≤ 280 (model-written: phones label it "Agent's
reason (unverified)"); `resumes` is `null` or equals `lease_id`; `limits` ⊆
`no_lock_detect`, `no_human_yield`, sorted; `grant.apps` a non-empty subset of
the requested ids; `1 ≤ grant.minutes ≤ max_minutes`; a view ≤ 256 KiB.

## 2. What the node checks on a grant

| # | Check | Reason |
|---|---|---|
| 1–8 | approval-v1 checks 1–8 with `type: 'kl.lease.grant'` (`verifyDeviceEnvelope`) | `malformed` … `replay`, `already_decided` |
| 9 | A pending request with this `request_id` and `lease_id` | `unknown_request` |
| 10 | `nonce`, `lease_hash`, `expires_at` equal the request's | `nonce_mismatch`, `lease_hash_mismatch`, `expires_mismatch` |
| 11 | Node clock ≤ `expires_at` | `expired` |
| 12 | Fresh hash of the pending lease = `lease_hash`, and each app is still in `gui.apps` with the same `path`/`processes`; the job is open; `grant.apps` ⊆ requested; minutes in range | `lease_changed`, `job_closed`, `apps_not_requested`, `minutes_out_of_range` |

A failed check leaves the request pending; every result is audited. The one
exception is `job_closed`: the job cannot come back, so the node ends the
pending lease and answers `{ state: 'ended', reason: 'job_closed' }`. A job is
open only while the node knows it and it has not ended: a `job-…` id in its
job table and not terminal, or a `chat:<id>` whose chat still exists. Expiry is
node-clock only: `verified_at + minutes`, and for a resume `min(that, the
original expiry)`. `signed_at` is recorded and never judged.

The node sends no request at all, and so nothing reaches the relay or a phone,
for a run that has neither a job id nor a chat id (`job_required`), for a job
that is not open (`job_closed`), or for a front-door client whose grant does
not cover `fleet:unsafe` on this node (refused in the node's own words for a
missing scope).

Contact (owner ruling R-F5-15, 2026-10-13). A lease's input goes on only
while the node has verified a signed message from the device that granted
it within the last `gui.lease.contact_s` seconds (120; 30 to 300) on the
node's clock. Contact is the grant itself (a resume grant too) and every
`kl.lease.watch` from that device whose nonce is new; a replayed watch and
another enrolled device's watch are not. When the window lapses the node
suspends the lease (status `suspended`, reason `no_contact`), releases what
it held and refuses input with `lease_suspended_no_contact`; it sends no
resume request. The granting device's next fresh watch resumes it (status
`active`) and never moves `expires_at`; expiry and revoke end it as always.
No message changed: `no_contact` is a value of the status's free `reason`.
iOS watches every 20 s while its live view is open; Android sends one watch
per Refresh tap, so its owner taps Refresh inside the window.

Revoke and watch: checks 1–8 with their own type, then the `lease_id` must be
known (`unknown_lease`). Neither message has a validity window of its own, so
the node remembers their nonces per lease for as long as it remembers the
lease (not for ten minutes; revised 2026-10-12): the same bytes again are a
`replay` however late they come, and the same nonce under other bytes is
`already_decided`. A lease remembers at most 4096 of them; a watch beyond
that is refused (`too_many_watches`), a revoke never is. This is node
behaviour only: no message changed. Any enrolled device may revoke any lease;
a replayed revoke changes nothing and re-sends the status.

## 3. What the phone checks and shows

- `request`, `status`, `view`: the node signature against the node key pinned
  at enrollment, over the received bytes; anything that fails is not shown.
- `request`: `lease_hash` equals SHA-256 of the JCS lease. Show node name, job id,
  origin client, the reason labelled "Agent's reason (unverified)", one row per
  app with `name`, full `path` and `processes` (each a toggle, default on), a
  duration stepper 1…`max_minutes` (a resume shows the remaining time, fixed), and
  the `limits` as warnings. Grant = biometric signature of `kl.lease.grant`.
- `view`: ≤ 256 KiB, `frame.sha256` matches `frame.data` (else
  `frame_hash_mismatch`).
- Canonical form: lease messages contain `null` and integers other than `v`;
  the phones' JCS emits both (RFC 8785).

## 4. Transport (relay routes, mounted by `src/gui/relay-extension.js`)

| Route / method | Shape |
|---|---|
| node → relay | `link.send(envelope, { push: { kind: 'lease', id: request_id, expires_at } })` for requests; statuses plain; views with `{ to_device }`; mailbox prefix `kl.lease.`, 5 min, 256 KiB |
| `GET /v1/leases?wait=0..25` | `[{ node_id, envelope, status }]`: pending requests for the device's nodes with the latest status of each lease |
| `POST /v1/leases/{lease_id}/grant` · `/revoke` · `/watch` | body = the phone envelope → `202 { state, reason? }`, `503 node_offline`. The `202` for `/watch` also carries `after_seq`: the mailbox position read before the node heard the watch, so a phone that fetches on tap can ask for views from there with `wait` and get the frame this watch causes |
| `GET /v1/leases/{lease_id}/views?after_seq&wait` | `[{ seq, envelope }]` of views to the caller and statuses, oldest first |
| node methods | `lease.grant`, `lease.revoke`, `lease.watch`: `{ envelope }` → `{ state, reason? }` |

## 5. Vectors

`tests/vectors/lease-v1/`, rebuilt by `generate.js`; shape
`{ name, consumers, check, given: { now, node, approvers, allow_test_keys, pending, used, gui_apps, jobs_open, gui_max_minutes }, input, expect: { accepted, reason } }`.
Phone-built vectors also carry `given.request` and `expect.message` (the exact
message the phone must build). Phones consume `grant-valid`, `grant-narrowed`,
`deny-valid`, `resume-capped`, `revoke-valid`, `watch-valid`,
`view-node-sig-valid`, `view-tampered-frame`.
