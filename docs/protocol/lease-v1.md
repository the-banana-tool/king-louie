# lease-v1 — computer-use leases

A lease lets an agent drive a few allowlisted desktop apps on one node for a
bounded time, under one phone signature (fleet stage 5 spec §3.6, §4.1; the one
exception to trust principle 3). Envelopes, JCS, keys and identifiers are
approval-v1's (§1–§2 of `approval-v1.md`).

## 1. Messages

Node-signed (Ed25519, `kid` = `node_id`): `kl.lease.request`, `kl.lease.status`,
`kl.lease.view`, `kl.lease.listing`. Phone-signed (ES256, `kid` = `device_id`): `kl.lease.grant`,
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
{ "v": 1, "type": "kl.lease.watch", "node_id", "lease_id", "device_id",
  "contact_token": "b64url(16)" | null (the newest one this phone has applied for the lease), "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.status", "node_id", "lease_id", "seq", "at", "state": "pending|active|suspended|ended",
  "locked": false, "reason": "…" | null, "expires_at": "…" | null, "contact_token": "b64url(16)",
  "granted_by": { "device_id": "d-…", "name": "…" (≤ 64) | null } | null }
  // granted_by (2026-10-13, R-F5-18): the phone whose grant made the lease; null while nobody has granted it.
{ "v": 1, "type": "kl.lease.view", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s",
  "foreground": { "app_id": "calculator" | null, "matches": true },
  "frame": { "mime": "image/jpeg", "width", "height", "sha256": "b64url(SHA-256(JPEG bytes))", "data": "base64" } | null,
  "frame_dropped": false,
  "actions": [{ "seq", "at", "tool", "summary" (≤ 120), "result": "ok" | "refused:<code>" }] (≤ 50),
  "contact_token": "b64url(16)" }
{ "v": 1, "type": "kl.lease.listing", "node_id", "to_device", "nonce": "b64url(32)" (the phone's, from its request), "at",
  "leases": [{ "lease_id", "seq" }] (≤ 8, each lease once) }
  // listing (2026-10-13, R-F5-20): the node's whole answer to one phone's "what is running"; see "Listing" in §2.
  // contact_token (2026-10-13): 16 random bytes, new in every status and view; see "Contact" in §2.
  // summary never holds typed text (owner ruling R-F5-16, 2026-10-13): "Typed 42 characters",
  // "Key (a character)"; keys that are not text keep their names ("Key ctrl+s"); clicks, scrolls
  // and drags give their position in the screenshot.
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

Who may do what (owner ruling R-F5-18, 2026-10-13). The first grant of a
lease may come from any enrolled device, and that device is then the
granting one (`granted_by` in every status from then on; `name` is its
approver record's name when that is one plain line, else `null`). Only the
granting device resumes the lease: a `grant` decision on a resume request
from any other enrolled device is refused (`not_granting_device`) and leaves
the request open. Only its watches are contact (below). Any enrolled,
unrevoked device may stop a lease: a revoke, or a `deny` of a resume
request, is checked for signature, nonce and lease id like the granting
device's own, and nothing more. Any enrolled device may also watch a lease,
to see what it is about to stop; such a watch gets frames and is never
contact.

Contact (owner ruling R-F5-15, 2026-10-13). A lease's input goes on only
while the node has verified a signed message from the device that granted
it within the last `gui.lease.contact_s` seconds (120; 30 to 300) on the
node's clock. When the window lapses the node suspends the lease (status
`suspended`, reason `no_contact`), releases what it held and refuses input
with `lease_suspended_no_contact`; it sends no resume request. The granting
device's next watch that is contact resumes it (status `active`) and never
moves `expires_at`; expiry and revoke end it as always. `no_contact` is a
value of the status's free `reason`.

A lease does not outlive the enrollment of the device that granted it
(2026-10-13, third security review). When that device is revoked (a
`kl.device.revoke` staged from another phone, or an administrator's
`device revoke` / `device apply`, which a running node finds within five
seconds), the node ends the lease: status `ended`, reason
`device_revoked`, another value of the free `reason`. No message changed.

What counts as contact (revised 2026-10-13, second security review, finding
3; this changed `kl.lease.watch`, `kl.lease.status` and `kl.lease.view`).
A watch says nothing the node can believe about when it was signed: the
phones take their clock from the relay, and the relay carries every watch.
A relay could keep watches back and feed them in later, one before each
lapse, long after the owner stopped looking. So:

- The node puts a fresh `contact_token` (16 random bytes) in every status
  and view it signs, and remembers when it issued each (node clock).
- A phone keeps the token of the newest status or view it has applied for
  the lease (applied: node signature against the pin, a newer `seq`, and
  for a view its own `to_device`) and puts it in each watch; `null` when it
  holds none.
- Contact is the grant itself (a resume grant too), and a watch from the
  granting device whose `contact_token` the node issued for this lease less
  than `contact_s` ago and that has not made contact before. Using a token
  retires every older one. Such a watch was signed after the node issued
  that token.
- Any other accepted watch (another enrolled device's, a `null` or unknown
  token, an old or used one) still asks for frames, which the node sends
  only while the lease is active; it is never contact.
- The node answers every accepted watch with a status signed then (sent to
  the phones as always, and carried in the reply, below), so a phone always
  holds a token young enough for its next watch, also while no frames flow.
  The grant's reply carries the first one.

What is left: a relay can hold one watch for up to the window before it
delivers it, so input can go on for at most two windows after the phone's
last signature (four minutes by default), never longer; and a grant counts
from when the node verifies it, inside its request's five minutes.
iOS watches every 20 s while its live view is open; Android sends one watch
per Refresh tap, so its owner taps Refresh inside the window, and after a
pause the first tap is answered with a fresh token and the second resumes.

Listing (owner ruling R-F5-20, 2026-10-13: "I don't want relays to hide a
live lease from phones"). Statuses alone cannot show that nothing is
running: a relay that drops them, and a node that has none, look the same.
So a phone's listing request carries a nonce, and each node answers it with
a `kl.lease.listing`:

- The phone chooses 32 random bytes for each `GET /v1/leases` and sends them
  as `nonce` in the query. The query is part of what the device signs for
  the request (`KL-PHONE-V1`, approval-v1), so no further signature and no
  further prompt is needed.
- The relay hands the nonce to each of the device's nodes (`lease.list`).
  The node signs the statuses it lists (the live lease, if any, and at most
  the four that ended last), and then a listing over the nonce, the device
  it answers (`to_device`) and, for each status, its `lease_id` and `seq`.
  It signs one when it lists nothing (`leases: []`). A node has at most one
  lease that has not ended, so the listing always names it. A status in a
  listing is the lease's newest one when that still says what the lease is
  and, for a lease that has not ended, is under five seconds old and
  carries a contact token that has not made contact; else it is signed for
  the listing. (2026-10-13, fourth security review: every `lease.list` used
  to sign a new status, and the relay may call it at will, so a lease's
  `seq` and its contact tokens could be run up without bound.) An ended
  lease's status is never signed again.
- The phone takes a node's answer whole or not at all (§3): the pinned key's
  signature, its own nonce, itself as `to_device`, and a signed status for
  every lease named, with that `seq`. Then it knows what that node had to
  list when it answered this request: those leases, or none.
- Every node that has an identity and the relay link answers `lease.list`
  (2026-10-13, fourth security review), also one on which computer use is
  off: a runbook node, and an agent node whose `gui` is not enabled, that
  has no helper installed, that has no administrator's record of its
  identity, or whose GUI could not be built. Such a node has no lease
  manager, so no lease can be live on it; it signs a listing that names
  nothing (`offLeaseListing` in `src/gui/lease-protocol.js`), for an
  enrolled device and a well-formed nonce like any other node.
- For a pinned node with no listing that passes, the phone knows nothing,
  and says so: "Could not confirm with <node>". It never shows that as
  nothing running. A node that is offline or slow, a device the node does
  not know, and a relay that kept the answer back all end here, because the
  phone cannot tell them apart. So does a node on an older build: one from
  before R-F5-20 signs no listing at all, and one from before the fourth
  review signs none while computer use is off there. Statuses that came
  without a listing are still applied one by one as before (a signed status
  of a running lease gives the banner and Stop), under the same notice.
- A phone keeps three things apart for each pinned node, and shows each as
  what it is (fourth security review): it has not asked yet ("Not checked
  yet: <node>", never an empty screen that reads as nothing running); a
  listing passed ("Checked <node> at <time>: no computer-use session", or
  how many are running and how many requests wait, with the time by the
  phone's own clock at which it accepted the listing, so an old answer
  never reads as a current one); no listing passed ("Could not confirm with
  <node>"). On iOS a session that has locked asks nothing and leaves what
  is shown, with its time. Android asks only on the owner's tap.

A lease that may still start (2026-10-13, fourth security review). A relay
can answer a phone's grant with `503` and deliver it later, any time before
the request expires. Until then the lease is `pending`, which is not
running, and a listing signed meanwhile names it as `pending`. So a phone
remembers each lease it has signed a grant for, from the signature on and
whatever the relay answered, and shows such a lease, when a status its node
signed says `pending`, as "May still start on <node>", with the same Stop
as a running lease: a `kl.lease.revoke` the phone signs (any enrolled phone
may stop a lease, R-F5-18; a revoke ends a pending lease and its request,
so a grant delivered afterwards is `unknown_request`). The row stays until
a status the node signed says the lease ended, or a listing that passed no
longer names it after the request's `expires_at` has passed on the phone's
own clock and on the relay-corrected one. The phone revokes nothing by
itself and sends no grant again by itself; Android sends each on the
owner's tap only (R-F5-5). The memory is the app's own and is lost when the
app is restarted: a phone restarted between its grant and the listing shows
the lease only once it runs.

The node does not remember listing nonces and judges nothing by them: it is
the phone that needs the answer to be fresh. `at` is informational, like
`signed_at`. What a listing does not say: whether a pending lease will be
granted (it names the lease as `pending`; a relay can withhold the request
itself, and nothing runs until a grant reaches the node), and anything
after it was signed. An answer is as old
as its request took: a relay can hold a reply back for as long as the phone
waits for it (the phones' request timeout, 40 s), not longer.

What is left, plainly: a relay can still make a node look unreachable. It
can drop the request or the answer, and the phone then shows "Could not
confirm with <node>" for a node that is in fact up, perhaps with a lease
running. Denial is visible, not preventable. What a relay can no longer do
is pass that off as the node saying nothing is running.

Revoke and watch: checks 1–8 with their own type, then the `lease_id` must be
known (`unknown_lease`). Neither message has a validity window of its own, so
the node remembers their nonces per lease for as long as it remembers the
lease (not for ten minutes; revised 2026-10-12): the same bytes again are a
`replay` however late they come, and the same nonce under other bytes is
`already_decided`. A lease remembers at most 4096 of them; a watch beyond
that is refused (`too_many_watches`), a revoke never is. Any enrolled device
may revoke any lease (R-F5-18, above); a replayed revoke changes nothing and
re-sends the status.

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
- `listing` (R-F5-20; `verifyLeaseListing` in `src/gui/lease-protocol.js` is
  the reference, `Leases.verifyListing` / `checkListing` in both phone
  cores): the envelope is Ed25519 with the pinned node's `kid`
  (`malformed`: a listing another node signed, however validly, is not
  this node's); the node signature against the pin (`bad_signature`); the
  whole shape, as in §1 (`malformed`: exactly the seven keys, `v` 1, a node
  id, a device id, a 32-byte nonce, `at` a real time, at most eight
  `leases`, each exactly `{ lease_id, seq }` with a UUID v4 and an integer
  of at least 1, and no lease twice; `isListing` in both phone cores is the
  node's `VALIDATORS['kl.lease.listing']`); the node it names
  (`wrong_node`); `nonce` equals the one this phone chose
  for this request (`nonce_mismatch`); `to_device` is this device
  (`wrong_device`); for each entry of `leases`, among the statuses listed
  beside it, one the same node signed with that `lease_id` and `seq`
  (`status_missing`). No listing for a pinned node is `no_listing`. Every
  failure is shown the same way: "Could not confirm with <node>". A node
  the phone has not asked yet is "Not checked yet: <node>", and only a
  listing that passed is "Checked <node> at <time>: …" ("Listing" in §2).
- Canonical form: lease messages contain `null` and integers other than `v`;
  the phones' JCS emits both (RFC 8785).

## 4. Transport (relay routes, mounted by `src/gui/relay-extension.js`)

| Route / method | Shape |
|---|---|
| node → relay | `link.send(envelope, { push: { kind: 'lease', id: request_id, expires_at } })` for requests; statuses plain; views with `{ to_device }`; mailbox prefix `kl.lease.`, 5 min, 256 KiB |
| `GET /v1/leases?wait=0..25&nonce=b64url(32)` | `[{ node_id, envelope, status }]`: pending requests for the device's nodes with the latest status of each lease; then (R-F5-18) one `{ node_id, envelope: null, status }` for each lease that is running on those nodes or ended lately, where `status` is a `kl.lease.status` the node signed for this very listing (the relay asks each node, `lease.list`). This is the one device-signed request a phone makes when it opens; there is no unsigned listing, and a phone shows a lease from it only when the pinned node's signature on `status` verifies. A node that is offline, slow or older lists nothing. With `nonce` (R-F5-20; `400 bad_nonce` when it is not 32 bytes of base64url) each node that answers also gets one `{ node_id, envelope: null, status: null, listing }` before its statuses: the `kl.lease.listing` it signed over that nonce. Without `nonce` the reply is as before and no listing is passed on. The relay checks only that a listing opens, is of that type and names that node |
| `POST /v1/leases/{lease_id}/grant` · `/revoke` · `/watch` | body = the phone envelope → `202 { state, reason?, status? }`, `503 node_offline`. `status` is the `kl.lease.status` envelope the node signed for this answer (absent when it refused the message): a phone verifies and applies it like any other status, and takes its `contact_token` from it; `state` and `reason` beside it are in clear and are never shown as the lease's state. The `202` for `/watch` also carries `after_seq`: the mailbox position read before the node heard the watch, so a phone that fetches on tap can ask for views from there with `wait` and get the frame this watch causes |
| `GET /v1/leases/{lease_id}/views?after_seq&wait` | `[{ seq, envelope }]` of views to the caller and statuses, oldest first |
| node methods | `lease.grant`, `lease.revoke`, `lease.watch`: `{ envelope }` → `{ state, reason?, status? }`. `lease.list`: `{ device_id, nonce? }` (the device the relay authenticated; the nonce of its request) → `{ statuses: [envelope], listing? }`; `listing` (R-F5-20) only with a well-formed nonce and an enrolled device, signed over exactly those statuses: the status of the live lease, if any (signed now, or its newest when that is under five seconds old), and of at most the four that ended last; nothing for a device that is not enrolled on the node or is revoked. A node with computer use off registers `lease.list` too and answers `{ statuses: [], listing }` (fourth security review). The node takes the relay's word for who asks only to decide whether to answer: the statuses hold nothing this node's phones are not sent anyway, and whatever a phone then does (watch, stop) it signs itself |

## 5. Vectors

`tests/vectors/lease-v1/`, rebuilt by `generate.js`; shape
`{ name, consumers, check, given: { now, node, approvers, allow_test_keys, pending, used, gui_apps, jobs_open, gui_max_minutes }, input, expect: { accepted, reason } }`.
Phone-built vectors also carry `given.request` and `expect.message` (the exact
message the phone must build). Phones consume `grant-valid`, `grant-narrowed`,
`deny-valid`, `resume-capped`, `revoke-valid`, `watch-valid`, `watch-no-token`
(a watch with `contact_token: null`), `status-valid`, `status-no-contact`,
`status-pending` (`granted_by: null`), `status-granted-unnamed` (a granting
device with `name: null`) (`expect.status` holds the fields a phone reads,
the contact token and `granted_by` among them), `view-node-sig-valid`
(`expect.contact_token`), `view-tampered-frame`, and the fourteen listing vectors
(R-F5-20): `given.nonce` and `given.device_id` are the phone's own,
`given.statuses` the status envelopes that came beside the listing, and
`expect.leases` (`[{ lease_id, seq, state }]`) what the phone then knows of the
node: `listing-none` (nothing running, signed), `listing-live`,
`listing-nonce-mismatch` (an answer to an earlier request),
`listing-status-withheld` (an entry left out), `listing-status-stale` (an
older status of the same lease in its place), `listing-other-device`,
`listing-bad-signature`; and (fourth security review) `listing-other-node`
(another pinned node's own listing, validly signed by that node:
`malformed`, its `kid` is not this node's), `listing-wrong-node` (this
node's key over a listing that names another node), `listing-extra-status`
(a signed status beside the listing that it does not name: accepted, and
that status is not part of what the phone then knows), and four for the
shape, each signed by the node: `listing-duplicate-lease`,
`listing-too-many` (nine entries), `listing-extra-key`, `listing-bad-at`
(a day that does not exist). Forty-six vectors in all.
