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

A suspended lease is never resumed on a node whose identity record can no
longer be trusted (2026-10-13, fifth security review, finding 4). Every
`kl.lease.request` the node builds, the resume requests it sends by itself
included (after a suspension, and when the relay link returns), is preceded
on Windows by the service's write probe of the administrator's record of
its identity. When the probe fails, or cannot be run, no resume request
goes out and the node ends the lease: status `ended`, reason
`node_identity_invalid`, another value of the free `reason`. No message
changed. A lease that is active is not ended by the probe, and a lease
paused for `no_contact`, which resumes on a watch and not on a request, is
not asked about.

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
owner's tap only (R-F5-5).

That memory is the app's own: it is lost when the app is restarted, and no
other phone has it. So it does not decide whether a pending lease is shown
(2026-10-13, fifth security review, finding 1). Every lease that a listing
which passed names as `pending` gets a banner row with the same Stop, on
any enrolled phone, whatever that phone remembers. What it remembers
chooses the words only: "May still start on <node>" for a grant it
remembers signing; otherwise "A request is waiting on <node>", with a line
saying that this phone does not remember allowing it and that an Allow
signed before a restart, or on another phone, could still reach it. One
case gets no second row: the request itself is on the phone's screen with
its Allow and Deny, and the phone remembers no grant for it (a request
nobody has answered; Deny ends it). A row for which no grant is remembered
goes when the node signs that the lease ended or started, or with the first
listing that passes and no longer names the lease; while its node still
signs `pending` it stays, also when a newer status arrives without a
listing. Android adds these rows only inside the owner's "Check" tap, like
everything else it learns (R-F5-1), and sends nothing for them (R-F5-5).

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

## Revised 2026-10-24: the take lease

A take (agent-driven demo takes, spec
`docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md` §6) is a
screen-recorded demo approved with one tap: a lease of a second kind, `take`.
`kl.lease.request`, `kl.lease.grant`, `kl.lease.revoke`, `kl.lease.watch`,
`kl.lease.view` and `kl.lease.listing` keep their shapes; `lease` may now be a
take, and every status gains three keys.

```jsonc
"lease": { "kind": "take", "job_id": "job-…",
           "name": "Site audit demo" (1–60, one plain line),
           "sites": ["app.example.com", "*.example.com"] (1–32),
           "browser": true | ["…"] (1–64 non-empty strings),
           "apps": [{ "id": "notepad", "name": "Notepad", "path": "C:\\Windows\\System32\\notepad.exe", "processes": [] }],
           "credentials": false, "max_minutes": 180, "unattended": true,
           "reason": "Record the demo", "resumes": null, "limits": [] }
{ "v": 1, "type": "kl.lease.status", …, "granted_by": …,
  "kind": "computer_use" | "take", "unattended": false, "name": "…" | null }
  // kind, unattended, name (2026-10-24): in every status. A computer_use
  // lease's status says "kind": "computer_use", "unattended": false, "name": null;
  // a take's carries its kind, its unattended flag and its name.
```

Rules:

- A lease has exactly the keys of its kind. `computer_use` keeps the seven it
  has (`kind`, `job_id`, `apps`, `max_minutes`, `reason`, `resumes`,
  `limits`); only `take` has `name`, `sites`, `browser`, `credentials` and
  `unattended`, so a `computer_use` lease carrying `unattended` is malformed.
- `name` is a non-empty string of at most 60 characters and one plain line
  (`plainLineProblem`, `src/cases/hidden-chars.js`). Each of `sites` is a
  lower-case host, `^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$` (`*.` for its
  subdomains). `browser` is `true` (browser actions on these sites) or the
  list of browser actions it may use. `credentials` and `unattended` are
  booleans. `apps` is 1–8 apps as for `computer_use`.
- The cap is the kind's: a take's `max_minutes` is 1–240
  (`TAKE_MAX_MINUTES`); a grant's `minutes` is at most
  `min(max_minutes, gui.take.max_minutes, 240)` for a take and
  `min(max_minutes, gui.lease.max_minutes, 60)` for `computer_use`, else
  `minutes_out_of_range` (check 12).
- A status's `kind` is one of `computer_use`, `take`; `unattended` a boolean,
  and `false` for `computer_use`; `name` the take's name (as above) for a take
  and `null` otherwise.
- **Unattended.** A lease whose request says `unattended: true` has no contact
  window and is never suspended: it ends only by expiry, revoke, device
  revocation, job close or the take's own endings. A watch is still accepted
  and answered with a signed status; it makes no difference to the lease's
  life.

Vectors: the given of a grant vector may carry `gui_take_max_minutes`.
Phones consume five more: `take-grant` (a take of 180 minutes granted for
180; `given.request` and `expect.message` as for the other phone-built
grants), `take-grant-minutes-over-cap` (the admin's take cap,
`gui_take_max_minutes: 120`, below the requested 180: a grant of 150 is
`minutes_out_of_range`),
`take-request-missing-name` and `computer-use-with-unattended` (`check:
'request'`: a node-signed request whose lease, hashed again, has the wrong
keys for its kind; `VALIDATORS['kl.lease.request']` refuses it,
`malformed`), and `status-take` (`expect.status` holds `kind`, `unattended`
and `name` too). The four `status-*` vectors before it, and the listing
vectors that carry statuses, now carry the three keys. Fifty-one vectors in all.

## Revised 2026-10-28: the read key

Android app spec `docs/superpowers/specs/2026-10-28-android-app-slim-design.md`
§8 (owner ruling R-AN-5). An Android phone may hold a **read key** beside its
device key (approval-v1, "Revised 2026-10-28: the read key"): a P-256 key that
asks for no biometric and signs only while the phone is unlocked. No message
changes shape.

- **A watch may be signed by either key of its device.** `kl.lease.watch`
  keeps its shape: `kid` and `device_id` are the device's id, `alg` is
  `ES256`. `verifyLeaseWatch` passes `allowReadKey: true` to
  `verifyDeviceEnvelope`, so check 6 accepts the record's `read_key` as well
  as its `public_key`, and the result says which (`key: 'device' | 'read'`).
  A record with no `read_key` (iOS, or an Android phone whose read key this
  node has not applied with `device apply` yet) refuses a read-signed watch
  as `bad_signature`.
- **Contact is unchanged** ("Contact" in §2): a watch from the granting
  device whose `contact_token` is fresh and unused, from either of its keys.
  On Android that now means "the phone that granted this lease is unlocked
  with the lease's view open", which is iOS's meaning already (its watches
  are signed with a session unlocked once), where before it meant "the owner
  touched the fingerprint sensor within two minutes". An unattended take has
  no contact window; a watch brings it frames and a fresh status only.
- **Only a watch.** `kl.lease.grant` (a resume grant too) and
  `kl.lease.revoke` verify against the device key alone: a read-key signature
  is `bad_signature`. Stop is still one biometric signature.
- **Transport.** `POST /v1/leases/{lease_id}/watch`, `/grant` and `/revoke`,
  `GET /v1/leases` and `GET /v1/leases/{lease_id}/views` take either key's
  request signature (approval-v1's route table); the node, not the relay,
  decides what the envelope in the body may be signed with.
- **Audit.** The `lease.watch` entry adds `key` (`device` or `read`) beside
  `device_id` and `contact`.

Vectors: four more, 55 in all (`node tests/vectors/lease-v1/generate.js
--check` says `55 vectors match`). An approver in `given.approvers[]` may
carry `read_key`, and a read-key vector's `expect` adds `key: 'read'` where
it is accepted.

| Vector | Consumers | What |
|---|---|---|
| `watch-read-key` | node, android | a watch from the granting device signed with its read key: accepted, `key: 'read'`. The phone builds the same `expect.message` as for `watch-valid` and signs it with the read key. (Whether it is contact depends on the manager's tokens, which the vector does not hold; `tests/gui-leases.test.js` covers that.) |
| `watch-read-key-not-applied` | node | the same watch, the record without a `read_key`: `bad_signature` |
| `grant-read-key` | node | a grant signed by the read key: `bad_signature` |
| `revoke-read-key` | node | a revoke signed by the read key: `bad_signature` |

The phone sets now differ: iOS consumes the phone vectors of §5 and the take
section; Android consumes those and `watch-read-key`
(`tests/lease-vectors.test.js`).
