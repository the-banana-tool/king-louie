# Android app, slimmed and styled

Date: 2026-10-28. Status: draft for the owner's review (owner rulings
R-AN-1 to R-AN-9 in §18; the author's calls C-1 to C-20 in §17).

Related: the QoL program of 2026-10-28, of which this is the second of four
specs (`2026-10-28-desktop-attached-to-personal-node-design.md` comes before it;
push notifications, `2026-10-28-push-notifications-design.md`, after it and
built on §13 here). Protocols: `docs/protocol/approval-v1.md`,
`docs/protocol/lease-v1.md`, `docs/protocol/client-grant-v1.md`. Fleet
stage 3 (approvals), stage 4 (front door), stage 5 (session helper and
leases) and demo takes D1 (`2026-10-24-agent-driven-demo-takes-design.md`).

Words are `CONTEXT.md`'s. An **Approval** is anything a node sends the paired
phone that waits for the owner's press; a **tool approval** is the F3 kind,
over one unsafe tool call or runbook. This spec proposes two more words for
the glossary (§14): **device key** and **read key**.

## 1. Intent

The owner carries an Android phone and approves from it. The app has grown
one screen per protocol stage: five bottom tabs (Approvals, Questions, Nodes,
Devices, Settings; `Screens.kt:114-120`), History inside Nodes, a Front door
menu under Settings with five sub-screens (`FrontDoorScreens.kt`), a separate
computer-use section that loads only on its own button (`LeaseScreens.kt:63`),
a lease banner above every tab (`LeaseScreens.kt:236`) and a demo mode with
its own node list. Nothing arrives by itself: every relay request is signed
by the phone's one key, an Android Keystore P-256 key that asks for a strong
biometric for each signature (`DeviceKey.kt:93-141`, `:177-196`), so the
app fetches only when the owner taps "Check for requests"
(`AppModel.kt:1385-1441`), "Show devices", "Check for computer-use
requests", "Check for questions" or one of the front-door refresh buttons,
and each tap is a fingerprint. It sends no presence (`AppModel.kt:284-288`),
so a case's contact ladder never sees it in front, and a computer-use lease
it granted keeps going only while the owner taps Refresh inside two minutes.

The owner wants one list of everything waiting, live while the app is open,
four screens, and the desktop app's look. Two things make that possible: a
second, non-biometric key for reading (§8), and a foreground loop like the
iOS app's (§9).

## 2. Goals

- Four screens: Scanner, Approvals, Approval detail, Settings (§6).
- One Approvals list that holds every Approval kind and every running lease
  and take, built on the phone from the relay's existing routes (§7, §10).
- No fingerprint to read: lists, statuses, frames, presence and contact
  watches are signed with the read key. Every decision is still one
  biometric signature over exactly what is decided, and the decisions cost
  one prompt each instead of two (§8.4).
- While the app is in the foreground it long-polls, reports presence and,
  with a running lease's detail on screen, keeps contact (§9).
- The desktop's tokens, dark only, held equal to `styles.css` by a test (§11).
- The protocol rules the phones share (signed state only, listings whole or
  not at all, contact tokens, "may still start", take lines) are kept, and
  `tests/mobile-lease-apps.test.js` keeps pinning them (§12).

## 3. Non-goals

- iOS. The iOS app is untouched by this work: it keeps its seven tabs, its
  session unlock, its builds and the vectors it consumes. Every protocol
  change below is additive, so an iOS phone enrolled without a read key
  works exactly as before against an upgraded relay and node.
- Push. Spec 3 switches it on; §13 here is only what the app does when a
  notification is tapped.
- A new relay endpoint that merges the kinds (R-AN-7).
- The node's history screen (removed, R-AN-2) and the front door's
  gap-and-break records it showed. Audit breaks still reach the phone as
  front-door alerts (§7.1).
- Tablet or landscape layouts, and a light theme (R-AN-8).

## 4. Anti-goals

- The read key must never be able to say yes. No message that approves,
  grants, answers, stops, enrolls, revokes, connects, disconnects, adds or
  removes anything verifies against it, on the node, the front door or the
  relay (§8.5). A test signs each of them with a read key and expects a
  refusal (§16).
- Nothing the relay says alone becomes what the list shows as a fact about a
  node: requests, statuses, listings and questions are shown only when a
  pinned node signed them, as today. The read key changes who may ask the
  relay, not what the phone believes.
- No retry of a decision. A decision is signed and sent once per tap; an
  unanswered send is shown as not confirmed (R-F5-5 stands).
- The loop runs only in the foreground. No background service, no wake lock,
  no alarm.

## 5. Constraints

- `mobile/android/protocol` stays a plain Kotlin/JVM module tested with
  `../gradlew test` (JDK 17, no Android SDK). Logic that decides what is
  shown (the merge and the order of §10, the read-key messages of §8) goes
  there so it is tested without a device.
- Vectors: a protocol change is not complete until `generate.js` rebuilds the
  vectors and every consumer passes (approval-v1 §9). New vectors name
  `node` and `android` only; iOS's vector tests filter on `ios` and are
  untouched. `tests/lease-vectors.test.js` today asserts both phones consume
  the same set; it changes to "iOS consumes `PHONE`, Android consumes
  `PHONE` plus the read-key vectors" (§8.8).
- Examples and fixtures hold invented values only (`tests/helpers/
  example-denylist.js`): node names such as `gpu-box` and `web-01`,
  `relay.example.com`, the published test keys.
- `src/` stays Electron-free; the node and relay changes in §8.9 are in
  `src/approvals/`, `src/frontdoor/` and `src/gui/`.
- `minSdk` is 33 (`app/build.gradle.kts`), so every Keystore option used in
  §8.1 is available.

## 6. The four screens

There is no bottom navigation bar. Approvals is the root. A top bar on
Approvals carries two icon buttons: the scanner (a hand-written QR vector,
`res/drawable/ic_scan.xml`, since `material-icons-core` has none) and the
gear (`Icons.Filled.Settings`). Back from any other screen returns to
Approvals. A phone that is not paired opens on the Scanner (C-10).

### 6.1 Scanner (R-AN-2a)

Two tabs, **Scan a code** and **Get a code**.

- **Scan a code**: the camera (`QrScanner.kt`, as today) and one text field,
  "Or type a code". What it accepts is decided by `AppModel.scanned` as
  today: `kl.pair` (enroll this phone with a node's `enroll-device`),
  `kl.invite` (join through another enrolled phone), `kl.relay` (re-pin the
  relay). The field also takes the six-character code a client's browser
  shows when it asks the front door to connect (`XXX-XXX`, client-grant-v1
  §1's alphabet), which claims that request for this phone
  (`GET /v1/grants/pending?user_code=`, one fingerprint, §8.4) and puts it in
  the Approvals list as a client connection (C-13). A code of the wrong
  shape says what the field accepts. Shown only when this phone is paired
  with a front door: the line "A client's code connects it through your
  front door."
- **Get a code**: a node name field and Get code (`POST /v1/pairing-codes`,
  one fingerprint, §8.4); the code is shown large in monospace, selectable,
  with its expiry counting down, under the words "On the node, run
  `king-louie-service pair <relay URL>` and type this code." The relay URL
  is the pinned one.

### 6.2 Approvals (R-AN-2b)

The one list of §7. Pull to refresh fetches every kind at once with the read
key (no prompt). Above the list, at most one line saying why the loop is not
getting through (`pollProblem`, as today, reworded for a loop: "Can't reach
the relay. Trying again in 15 s.").

### 6.3 Approval detail (R-AN-2c)

One screen per kind, pushed over the list, the decision at the bottom where a
thumb reaches it (`DecisionBar`, as today):

| Kind | Detail |
|---|---|
| Tool approval | today's `Detail` (`Screens.kt:274`): node name and id, summary, kind, name, directory, origin, then every parameter (approval-v1 §5), Approve and Deny |
| Question | the case title, the node, the question text, then the options as buttons, or a text field with Send (today's `Questions.kt` card, one question per screen) |
| Computer-use or take request | today's `LeaseRequestScreen` (`LeaseScreens.kt:103`): apps with toggles, the minutes stepper, sites, the take lines, limits, Allow and Deny |
| Running lease or take | the live lease view (§7.6) |
| Client connection | today's `ConnectClient` scope and machine editor (`FrontDoorScreens.kt:347`), Approve and Deny |
| Node pairing | node name, profile, the fingerprint in monospace with "Check the node's console shows the same fingerprint", the `replaces` warning, Approve and Deny |
| Alert | kind, subject, the detail as monospace JSON (`FrontDoor.shownText`, 400 characters), time, Acknowledge |

### 6.4 Settings, the gear (R-AN-2d)

One scrolling screen, read with the read key when it opens (no "Show
devices" tap, R-AN-6):

- **Nodes**: each pinned node with its name, fingerprint (monospace), online
  state (`GET /v1/nodes`) and whether it knows this phone's read key
  (§8.7: "read key in use", "waiting for `device apply` on the node", "not
  sent yet" with Send again). **Remove** forgets the pin on this phone after
  a confirm dialog; it sends nothing (C-15). On a front door, a node the
  phone added (`source: phone`) also has **Remove from front door**, the
  existing signed removal (`POST /v1/nodes/{node_id}/remove`, one
  fingerprint).
- **Relay**: the URL and the pinned SPKI (monospace), and "Re-pin: scan a
  relay code", which opens the Scanner. When the relay is a front door: its
  fingerprint, and **Connected clients** (`GET /v1/clients`), each with
  Revoke (the existing challenge and signed revoke, one fingerprint).
- **Phones**: this phone's fingerprint and its read key's (§8.1); the other
  phones that approve for these nodes (`GET /v1/devices`), each with Revoke;
  **Add another phone**, today's invite flow, except that the claim is
  polled every 3 s with the read key while the QR is on screen and until the
  invite expires, so "The new phone has scanned it" goes (C-14). The
  side-by-side fingerprint check and "It shows the same — add it" stay.
- **This phone**: Reset this phone (a confirm dialog; deletes both keys and
  every pin, as `reset()` does today), and the privacy line: "No analytics.
  The relay sees every action you are asked to approve, and when this app is
  open. See PRIVACY.md."

### 6.5 What is removed

Demo mode (the Welcome screen's "Try demo", `AppMode.DEMO`, the demo banner,
the demo fleet's frames and node list), the Questions tab, the Nodes tab,
History, the Front door menu and its five sub-screens, the standalone
computer-use section with its check button and per-node lines, the lease
banner above every tab, and every "Check …", "Show …", "Refresh online
state" and "Refresh status" button. Their content moves into §6.1 to §6.4 and
§7; nothing a phone could do before is lost except the node history view and
the demo.

## 7. The Approvals list

### 7.1 Kinds and where they come from

| Kind | Source (all with the read key) | Signed by | Time shown |
|---|---|---|---|
| Tool approval (`action.kind` `tool`, `runbook`, `envelope`) | `GET /v1/approvals?wait=25` | the node (`kl.approval.request`) | time left from `expires_in_ms`, monotonic |
| Question | `GET /v1/questions` | the node (`kl.question.ask`) | none; urgency instead |
| Computer-use request, take request, resume request | `GET /v1/leases?nonce=` entries with an `envelope` | the node (`kl.lease.request`) | time left to `expires_at` on the relay-corrected clock |
| Client connection | the claim of §6.1 (`GET /v1/grants/pending`) | the front door's reply (labelled as its report, as today) | time left from `expires_in_ms` |
| Node pairing | `GET /v1/pairings/pending` (front door only) | the front door's reply; the core checks the name and that the id derives from the key, as today | time left from `expires_in_ms` |
| Alert | `GET /v1/alerts?since=0` (front door only), unacknowledged ones | the front door's reply | when it happened |
| Running lease or take | `GET /v1/leases?nonce=` statuses and listings (R-F5-18, R-F5-20) | the node (`kl.lease.status`, `kl.lease.listing`) | time left to the lease's `expires_at` |

A device enrollment by invite (another phone joining) is an Approval too, but
it exists only while this phone's Add another phone flow is open and needs
the two screens side by side, so it stays in that flow in Settings (C-14).

### 7.2 Rows (R-AN-4)

Every row has the node's name (for front-door kinds, the front door's), the
kind as a short label, one line of host-built summary and the time of §7.1.
"Host-built" means the app composes the line from signed fields, escaped
(`Display.escape`, `FrontDoor.shownText`), never relay free text:

| Kind | Label | Summary line |
|---|---|---|
| Tool approval | Tool approval / Runbook / Envelope | the node-signed `action.summary` |
| Question | Question | `<case title>: <question text>` |
| Computer use | Computer use | `<app names> · <max_minutes> min` |
| Take | Take | `<name> · <max_minutes> min · unattended` (the last word only when `unattended` is true) |
| Resume | Resume | `Resume computer use · <minutes> min left` |
| Client connection | Client connection | `<client_name> (self-declared) · <requested scopes>` |
| Node pairing | Node pairing | `<node_name> (<profile>)`, and a second line, the fingerprint in monospace (C-12) |
| Alert | Alert | `<kind>: <subject>` |

The row's buttons:

- **Approve and Deny on the row** for the yes/no kinds: a tool approval; a
  computer-use, take or resume request, granted with its defaults (every
  requested app, `max_minutes`; a resume's fixed remainder); a client
  connection, approved with the front door's preselected scopes and no
  machine limits; a node pairing. Each is the same signed decision the
  detail sends, so the F3 rule stands: what is signed is exactly what the
  node or front door asked, and the detail shows every parameter (R-AN-4).
- **Review in place of Approve** (Deny stays) when the row cannot show what
  the owner would be saying yes to (C-12): the one-line summary does not fit
  (Compose's `onTextLayout` reports `hasVisualOverflow`); a computer-use
  request that carries `limits` (its warnings must be read); a take with
  `credentials: true` (it may use logins from the vault); a node pairing
  that `replaces` another node.
- **Open only**: a question with options or a text answer, and an alert.
  An alert row also has **Acknowledge** (R-AN-3; one fingerprint, §8.4).
  A `briefing` question has one answer, so its row carries **Got it**.
- A running lease or take row has **Stop** (one fingerprint) and opens the
  live lease view.

Tapping anywhere else on a row opens its detail. A row whose decision is
being signed or sent shows "Sending…" and disables its buttons; a decided row
shows its status in place of the buttons and stays at the bottom until it
leaves the list (as `pruneExpired` does today: a minute past its expiry).

### 7.3 Running leases and takes as rows

What today's banner shows becomes the pinned top of the list, with the same
words and the same Stop (R-F5-18, R-F5-20, fourth and fifth security
reviews):

- an active or paused lease: "Lease active on <node>", "Lease paused on
  <node>", an unattended take "Unattended take: <name>, ends <time>"
  (`takeTitle`), and "Granted by <name>" when another phone granted it;
- a lease paused for want of contact that this phone granted: "Paused: open
  to let it continue" (the iOS words, R-F5-19), since opening its detail is
  now what keeps it going (§7.6);
- a pending lease a passed listing names: "May still start on <node>" or "A
  request is waiting on <node>" with `Leases.pendingDetail`, under the same
  rules (`listedPendingGetsRow`, `keepsMayStart`, `dropMayStartRows`), except
  that they now run on every fetch instead of inside a tap;
- per pinned node whose last listing did not pass: "Could not confirm with
  <node>" in the warning colour, with `Leases.COULD_NOT_CONFIRM_DETAIL`. A
  node not yet asked shows "Not checked yet: <node>" only until the first
  fetch returns. A node whose listing passed adds no row; the footer of the
  list says "Checked <node> at <time>: …" for each (`Leases.checked`).

A lease that has ended has no row (C-18). Its detail still opens from a
notification (§13) and shows the signed ended status and reason.

### 7.4 Order (C-11)

1. Running leases and takes: paused for want of contact and granted by this
   phone, then active, then paused for any other reason, then pending; within
   each, the soonest `expires_at` first.
2. "Could not confirm with <node>" rows.
3. Waiting Approvals with a deadline (tool approvals, lease and take
   requests, client connections, node pairings), the least time left first;
   ties by node name.
4. Waiting Approvals without one: alerts, newest first; then questions, `high`
   urgency first, then in the order the relay listed them.
5. Decided rows, most recently decided first.

The rule is one pure function in the protocol module (§10).

### 7.5 Empty state

With nothing in the list: "Nothing waiting." and, under it, with push on,
"A notification tells you when a machine asks."; without it, "Requests appear
here while the app is open." With no node pinned: "No node is paired yet."
and a button to the Scanner. The per-node "Checked …" lines stay below the
empty state, so an empty list never reads as "nothing is running" unless a
node signed that it is.

### 7.6 The live lease view is a running lease's detail

`LiveLeaseScreen` (`LeaseScreens.kt:182`) becomes the detail of a running
lease or take row, with today's content in today's order: node, state, time
left, **Stop now** first and full width, the latest frame, "Granted by …",
the paused lines, the reason, the actions log. What changes is that it now
updates by itself:

- While it is on screen and the app is in the foreground it long-polls the
  lease's views (`GET /v1/leases/{lease_id}/views?after_seq=&wait=25`, read
  key), applying each status and view only through `applyLease` (signed by
  the pinned node, a newer `seq`, a view addressed to this device; unchanged).
- On the same condition it sends a `kl.lease.watch` every 20 s, signed with
  the read key, echoing the newest contact token it applied (as iOS does,
  R-F5-19), plus one early watch when a fresher token arrives within the 20 s
  (`Leases.tokenIsStale`). A watch from the granting phone is contact
  (lease-v1 §2) and keeps a `computer_use` lease's input going; any other
  phone's watch only brings frames. An unattended take has no contact window;
  its watches only bring frames and a fresh status.
- Leaving the view, or the app going to the background, stops both. The node
  then pauses a `computer_use` lease after `contact_s` (120 s), and the row
  says "Paused: open to let it continue".
- "Refresh" and "This screen does not update by itself" go. The line "The
  computer pauses clicks and typing when this phone has not refreshed for
  about two minutes" becomes "Keep this open to keep it going. Closing it
  pauses clicks and typing after about two minutes." for a lease this phone
  granted.
- When a node refuses a read-signed watch because it does not know this
  phone's read key yet (§8.7), the view says "<node> does not know this
  phone's read key yet: run `king-louie-service device apply` there." and
  offers **Keep it going with your fingerprint**, which sends one watch
  signed with the device key (one fingerprint). Nothing repeats it by itself.

## 8. The read key (R-AN-5)

### 8.1 The key (C-1)

A second P-256 key in the Android Keystore, alias `kl.read-key`, made at the
same moment as the device key (`DeviceKey.create`), StrongBox when the phone
has it, `PURPOSE_SIGN`, SHA-256, with:

- `setUserAuthenticationRequired(false)`: no prompt;
- `setUnlockedDeviceRequired(true)`: the Keystore refuses to sign while the
  phone is locked, so a read signature says the phone was unlocked;
- not invalidated by a new biometric enrollment. When the device key is
  invalidated the app re-enrolls and makes a new read key with it; Reset
  deletes both.

Its public half is a JWK like the device key's (`kty`, `crv`, `x`, `y`). Its
fingerprint for people is `r-` and the first 16 base32 characters of SHA-256
over `0x04 || x || y`, shown in groups of four, the device id's rule with
another prefix. The read key never has a device id of its own: everything it
signs names the device it belongs to.

The two keys are called the **device key** (today's, biometric, the one that
decides) and the **read key** (§14).

### 8.2 Enrollment carries both public keys (C-2)

`kl.device.enroll`'s `device` gains an optional member:

```jsonc
"device": { "device_id": "d-…", "name": "Pixel", "platform": "android",
            "public_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
            "read_key":   { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }
```

- `device` has exactly the four keys of today or exactly those five.
  `read_key` is a P-256 JWK on the curve, and its point differs from
  `public_key`'s (`malformed` otherwise). `device_id` still derives from
  `public_key` alone.
- The read key is bound by whatever binds the device key: in a console
  enrollment, the device's own signature and `code_mac`; in a signed
  enrollment, the enrolling phone's signature; in an invite, the claim's
  `mac` over `device`, which the inviting phone checks before it signs.
- The node keeps it: an approver record (`<configDir>/approvers/<id>.json`)
  gains an optional `read_key`, written by `enroll-device` for a console
  enrollment and by `device apply` for a staged one; both print "with a read
  key r-abcd efgh ijkl mnop" beside the device's fingerprint before they ask.
  `checkApproverRecord` accepts the record with or without it and refuses a
  `read_key` that is malformed or equals `public_key`. A published test key
  as a read key is refused like one as a device key (`test_key`) unless the
  store allows test keys.
- The relay keeps it: a device record (`device-registry.js`) gains
  `read_jwk`, set by every path that registers a device from an enrollment
  (`POST /v1/enroll/{code_id}` once the node reports it done,
  `POST /v1/devices/enroll`, the invite claim), and by §8.7.
- An iOS phone sends no `read_key`; its records have none and nothing about
  it changes.

### 8.3 How the relay authenticates a read (C-3)

A read-signed request carries one more header and a different first line in
the signed string:

```
X-KL-Device:    d-…            (the device, as today)
X-KL-Key:       read
X-KL-Timestamp: 2026-10-28T14:05:09.120Z
X-KL-Signature: b64url(ES256-P1363 by the read key over UTF-8 of S)

S = "KL-PHONE-READ-V1\n" + METHOD + "\n" + pathWithQuery + "\n" + timestamp + "\n" + b64url(SHA-256(body))
```

Without `X-KL-Key` (or with `X-KL-Key: device`) a request is today's
`KL-PHONE-V1`, verified against the device key. The clock window (120 s),
the replay cache (SHA-256 of `S` and the device id, 5 minutes) and the
per-device rate bucket are shared by both keys; the prefix keeps a read
signature from ever being a device signature over the same request.

Each route declares `auth: 'read'` (either key) or `auth: 'device'` (the
device key only). The relay answers a read-signed request to a `device` route
`403 read_key_not_allowed`, one from a device with no `read_jwk`
`401 unknown_read_key`, and a read signature that does not verify
`401 bad_signature`. Handlers get `ctx.key` (`'device'` or `'read'`) beside
`ctx.deviceId`, which is the device's id either way.

### 8.4 Which routes take which key (C-4)

The rule: a request that only reads, and a request whose body is an envelope
the device key signed (the envelope is the decision; the relay or node checks
its signature as today), take either key. A request that changes something
and carries no device-key envelope takes the device key.

| Route | Auth | Why |
|---|---|---|
| `GET /v1/approvals`, `GET /v1/approvals/{id}` | read | lists |
| `GET /v1/questions` | read | list |
| `GET /v1/leases`, `GET /v1/leases/{id}/views` | read | lists, statuses, listings, frames |
| `POST /v1/leases/{id}/watch` | read | the body is a watch, which the read key may sign (§8.5) |
| `POST /v1/presence` | read | foreground pings |
| `GET /v1/nodes`, `GET /v1/devices`, `GET /v1/devices/invites/{id}` | read | lists, the invite claim the inviting phone checks |
| `GET /v1/pairings/pending`, `GET /v1/alerts`, `GET /v1/clients`, `GET /v1/frontdoor`, `GET /v1/nodes/{id}/audit-status`, `GET /v1/nodes/{id}/history` | read | front-door lists (the app no longer calls the last two) |
| `PUT /v1/push-token` | read | spec 3 R5: re-sent when FCM rotates it, with no prompt; the payload is content-free |
| `POST /v1/challenges` | read | a challenge is spent only by a device-key envelope |
| `POST /v1/approvals/{id}/response` | read | body: a device-key `kl.approval.response` |
| `POST /v1/leases/{id}/grant`, `/revoke` | read | body: a device-key `kl.lease.grant` / `kl.lease.revoke` |
| `POST /v1/questions/{token}/answer` | read | body: a device-key `kl.question.answer` |
| `POST /v1/grants/{id}/decision`, `POST /v1/clients/{id}/revoke`, `POST /v1/pairings/{id}/decision`, `POST /v1/nodes/{id}/remove` | read | body: a device-key client-grant-v1 envelope |
| `POST /v1/devices/enroll`, `POST /v1/devices/revoke` | read | body: a device-key enroll or revoke, which the relay verifies against `ctx.device.jwk` as today |
| `POST /v1/devices/read-key` | device for the first send, read after (§8.7) | the relay does not know the read key until then |
| `GET /v1/grants/pending?user_code=` | device | claims a client's request for this phone, with no envelope |
| `POST /v1/alerts/{id}/ack` | device | acknowledges with no envelope |
| `POST /v1/pairing-codes`, `POST /v1/devices/invites` | device | opens a way for a new node or phone in, with no envelope |
| `GET /v1/time`, `/v1/enroll/{code_id}`, `/v1/devices/invites/{id}/claim`, `GET /v1/repin` | none, code or invite | unchanged |

So every decision is still one biometric signature, over the decision
itself, and its transport no longer needs a second one: Approve, Deny,
Allow, Stop, an answer, a client decision or revoke, a pairing decision, a
node removal, an enrollment and a revocation each cost one fingerprint where
they cost two (C-4). The claim by code, an acknowledgement, a pairing code and
an invite cost one, as today.

### 8.5 Which envelopes each key signs (C-5)

- The read key signs `kl.lease.watch` and nothing else. A watch keeps its
  shape: `kid` and `device_id` are the device's id, `alg` is `ES256`.
- The device key signs everything it signs today (`kl.approval.response`,
  `kl.lease.grant`, `kl.lease.revoke`, `kl.question.answer`,
  `kl.device.enroll`, `kl.device.revoke`, the client-grant-v1 messages), the
  new `kl.device.read_key` (§8.7), and, as a fallback the owner asks for, a
  watch (§7.6).

### 8.6 What the node checks

`verifyDeviceEnvelope` (`src/approvals/verify-device.js`) gains one option,
`allowReadKey` (default false). Step 6 of approval-v1 §4 becomes: the
signature verifies against the record's `public_key`; or, only when
`allowReadKey` is true and the record has a `read_key`, against `read_key`;
else `bad_signature`. The result says which key verified (`key: 'device' |
'read'`). Steps 1 to 5 and 7 to 8 are unchanged, so a revoked device's read
key is refused with the device (`revoked_device`), and a read key alone can
never be an approver.

Only `verifyLeaseWatch` (`src/gui/lease-protocol.js`) passes
`allowReadKey: true`. Grants, revokes, approval responses, question answers
(`mobile-app-channel.js`), signed executor approvals (`cases/executors/
signed.js`), enroll and revoke staging and the front door's
`verifyPhoneEnvelope` keep the default and so refuse a read-key signature as
`bad_signature`. Contact is unchanged in every other respect: a watch from
the granting device with a fresh, unused contact token (lease-v1 §2), from
either of its keys. The `lease.watch` audit entry adds `key`.

### 8.7 Phones enrolled before this change (C-6)

An Android phone already enrolled has a device key and no read key. After the
update the Approvals list shows one row until it is done: "Check for requests
without your fingerprint. Set up once: two fingerprints." Tapping it makes
the read key and signs:

```jsonc
{ "v": 1, "type": "kl.device.read_key", "device_id": "d-…",
  "read_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "created_at": "…", "expires_at": "≤ created_at + 7 days", "nonce": "b64url(32)" }
```

with the device key (`kid` = `device_id`, `ES256`), and posts it to
`POST /v1/devices/read-key` with device-key transport (the second
fingerprint). Exactly those keys; `read_key` as in §8.2.

- The relay verifies the envelope against the device's registered `jwk`,
  that `device_id` is the caller, and that the device is active on a node;
  stores `read_jwk` (a newer `created_at` replaces an older one); and
  forwards it as `device.read_key` (a new node method beside `device.enroll`
  in `src/approvals/relay-client.js`) to every node where the device is
  active. It answers `{ nodes: [{ node_id, state }] }`.
- A node checks it like a relayed revoke: shape, the signer an active
  approver whose `public_key` verifies it, `device_id` equal to the signer,
  `created_at` not more than 5 minutes ahead (`from_the_future`), not
  expired. It stages it (`read-key-pending-apply`), and `device apply` shows
  the device and the read key's fingerprint, asks `[y/N]` as it does for an
  enrollment, and writes `read_key` into the approver record. A statement
  older than the record's current read key is refused (`stale`). The
  approver set is still written only by the administrator's command (under
  personal hosting, the owner's, unelevated).
- The app keeps the signed statement until it expires and, at each loop
  start, re-posts it with the read key to every node that answered
  `offline`, with no prompt. Settings shows each node's state (§6.4). Past
  the seven days a node that never got it needs Send again (one fingerprint).
- Until a node applies it, that node refuses read-signed watches
  (`bad_signature`), and §7.6's fallback is offered. Everything else works at
  once, since the relay knows the read key from the first post.

A relay from before this change answers `404` to the read-key route; the app
then says "This relay is older than this app. Upgrade it, then try again."
and does not fall back to checking with fingerprints (C-19).

### 8.8 Vectors

approval-v1 (41 today; each new one with `consumers: ["node", "android"]`
unless said):

- `keys.json` gains published P-256 read keys for devices A and B
  (`A_read`, `B_read`), refused by nodes as test keys like the others.
- `phone-api-auth-read`: the `KL-PHONE-READ-V1` string and body hash, and a
  read-key signature that verifies against the read JWK and not against the
  device JWK.
- `enroll-console-read-key` (node; Android builds the payload): a console
  enrollment whose `device` carries `read_key`; accepted, the record holds it.
- `enroll-console-read-key-equal` (node): `read_key` equal to `public_key`,
  `malformed`.
- `enroll-signed-read-key` (node): a signed enrollment carrying `read_key`,
  staged with it.
- `read-key-valid` (node; Android builds the message), `read-key-wrong-signer`
  (signed by the read key itself: `bad_signature`), `read-key-from-the-future`.
- `response-reject-read-key` (node): an approval response signed with A's
  read key, A's record holding it: `bad_signature`.

That is 49; `generate.js --check` then says `49 vectors match`, and
`phone-reference.js` gains the read string.

lease-v1 (51 today):

- `watch-read-key` (node, Android): a watch from the granting device signed
  with its read key; accepted and contact. The phone builds the same
  `expect.message` as `watch-valid` and signs it with the read key.
- `watch-read-key-not-applied` (node): the same watch, the record without a
  `read_key`: `bad_signature`.
- `grant-read-key`, `revoke-read-key` (node): `bad_signature`.

That is 55. `given.approvers[]` entries may carry `read_key`.
`tests/lease-vectors.test.js` expects 55 and splits the phone sets (§5).
`node tests/vectors/lease-v1/generate.js --check` says 55.

### 8.9 What changes in `src/`

- `src/approvals/messages.js`: `isDevice` accepts `read_key`;
  `VALIDATORS['kl.device.read_key']`; `phoneAuthString` takes the key kind.
- `src/approvals/approver-store.js`: `read_key` in `checkApproverRecord`, the
  test-key rule for it, staging and applying `kl.device.read_key`.
- `src/approvals/verify-device.js`: `allowReadKey` (§8.6).
- `src/approvals/relay-client.js` and `service-wiring.js`: the
  `device.read_key` method.
- `src/gui/lease-protocol.js`: `verifyLeaseWatch` with `allowReadKey`;
  `src/gui/leases.js`: `key` in the `lease.watch` audit entry.
- `src/frontdoor/phone-api.js`: `X-KL-Key`, the read string, the `read` auth
  kind, `ctx.key`, the three refusals.
- `src/frontdoor/device-registry.js`: `read_jwk`, `setReadKey`.
- `src/frontdoor/routes.js`, `phone-routes.js`, `question-routes.js`,
  `oauth/grant-routes.js`, `src/gui/relay-extension.js`: each route's `auth`
  per §8.4; the read-key route; `read_jwk` from enrollments.
- `src/service/commands/` (`enroll-device`, `device apply`, `device list`):
  the read key's fingerprint.
- Docs: a "Revised 2026-10-28: the read key" section at the end of
  `approval-v1.md` (the `device` member, the read string and header, the
  route table, `kl.device.read_key`, the vectors) and of `lease-v1.md` (a
  watch may be signed by either key of its device; the four vectors), and
  `client-grant-v1.md` §7's route table.

### 8.10 What the read key proves, and what it does not

A read signature proves that the app was running on an unlocked phone that
holds the key. It does not prove the owner just authenticated. So:

- Contact now means "the phone that granted this lease is unlocked with the
  lease's view open", where today on Android it means "the owner touched the
  fingerprint sensor within two minutes". That is iOS's meaning already
  (its watches are signed with a session unlocked once).
- Someone holding the owner's unlocked phone with the app open can: read
  every Approval with every parameter, every question and the leased app's
  frames; keep a computer-use lease this phone granted going until its
  approved expiry (never past it: a resume, and any new lease, needs a grant);
  and report the phone in front, so a case's questions stay on the in-app
  rung of the contact ladder instead of moving on to SMS or email.
- They cannot approve, deny, grant, answer, stop, enroll, revoke, connect,
  disconnect, pair, acknowledge or remove anything (§4, §8.5).
- The relay operator gains nothing: it cannot sign with either key, and it
  already sees what the phone lists.
- The Keystore keeps the read key to this app, unexportable, and refuses it
  while the phone is locked. Malware with the phone's OS gets what the
  thief above gets, and could get it from the screen anyway.

## 9. The foreground loop and presence (R-AN-6)

`AppModel` gains one loop, started on `ProcessLifecycleOwner`'s `ON_START`
and cancelled on `ON_STOP` (C-7), only in live mode, with a read key the
relay knows, and no pairing under way:

1. `GET /v1/approvals?wait=25` (read key; the existing two-poll semaphore in
   `RelayApi`). Each returned item goes through `receive` as today.
2. When it returns, and at most once every 5 s, fetch the rest (§10):
   `GET /v1/questions`, `GET /v1/leases?wait=0&nonce=<fresh 32 bytes>`, and
   on a front door `GET /v1/pairings/pending` and `GET /v1/alerts?since=0`.
3. Go to 1.

On an error: a `retry_after` is waited out; a `401` or `rate_limited` waits
15 s; `pin_mismatch` tries the front door's signed re-pin once
(`tryRepin`) and otherwise stops with the problem shown; `unknown_read_key`
stops and shows the set-up row of §8.7; anything else waits 5 s. Every wait
is a `delay` in the loop's coroutine, never a timer outside it. Pull to
refresh, a notification arriving or tapped while in the foreground, and
returning to Approvals from a decision all run step 2 at once (the 5 s rule
still applies).

What it costs, per minute, with one front door and one live lease view open:
about 2.4 long polls, up to 12 for step 2 (fewer when the long poll waits its
full 25 s), 1 presence, 3 watches and about 2.4 view polls; far under the
relay's 120 per device. The listing in step 2 makes each node sign a
`kl.lease.listing`, which the fourth security review already bounded (statuses
are reused for five seconds; the listing itself is cheap).

Presence (C-8): `POST /v1/presence { foreground: true, at }` with the read key
when the loop starts and every 60 s while it runs (the node lets a ping lapse
after 120 s, ruling T17-presence), and one `{ foreground: false }` best effort
on `ON_STOP`. The relay's limit for this route is 6 a minute. This replaces
ruling T19-presence for Android: the contact ladder's in-app rung now sees the
phone while the app is open, as it sees an iOS phone.

The watches and view polls of §7.6 are a second, narrower loop owned by the
live lease view: it starts when the view is composed with the app in the
foreground and stops when either ends (`DisposableEffect` plus the lifecycle
state), so leaving the view always stops the watches.

Nothing in either loop signs with the device key or calls a decision.

## 10. Building the list on the phone (R-AN-7)

The relay has no merged endpoint and gets none. The phone keeps one store per
kind, each replaced whole by its fetch (a decided or vanished item leaves),
and one pure function in the protocol module,
`ApprovalList.build(…)` (`protocol/ApprovalList.kt`, C-20), turns them into
rows: kind, ids, the host-built strings of §7.2, which buttons the row has
(§7.2's exceptions), and the order of §7.4. The approvals long poll is the
wake signal; the other kinds are fetched when it returns (§9), so a question,
a lease request, a node pairing or an alert can appear up to about 25 s after
it exists when no push wakes the phone. A lease request lives five minutes and
a question or pairing longer, so the delay is a nuisance, not a loss.

`GET /v1/leases` is called with `wait=0`: with a pending request it returns at
once, so a long poll on it would spin while one is waiting.

Every store keeps today's verification: tool approvals through `receive` and
the request rules of approval-v1 §5; questions through `verifiedQuestion`;
lease requests through `verifiedLeaseRequest`; statuses and listings through
`Leases.verifiedMessage`, `checkListing`, `noteListedLease` and
`notePendingListed`; pairings and alerts through the front-door core as
today. `refreshLeases` keeps its body (one list request, one listing check
per pinned node) and is now called by the loop instead of a button.

## 11. Design tokens (R-AN-8)

### 11.1 The tokens

The desktop's `:root` block (`styles.css:8-50`, "King Louie – Dark UI Theme")
is the source. The app's one tokens file is a Kotlin object, `KlTokens`, in
`app/src/main/kotlin/com/example/kinglouie/Tokens.kt`, one `val` per CSS
token, named by camel-casing the variable (`--bg-base` → `bgBase`) (C-16):

| CSS token | Value | `KlTokens` | Used for on Android |
|---|---|---|---|
| `--bg-base` | `#1e1e2e` | `bgBase` | window, screen background, Material `background` and `surface`, the text on accent and error fills |
| `--bg-surface` | `#232334` | `bgSurface` | rows (`surfaceContainer`) |
| `--bg-elevated` | `#2a2a3c` | `bgElevated` | the decision bar, pinned lease rows, dialogs (`surfaceContainerHigh`) |
| `--bg-overlay` | `#313244` | `bgOverlay` | code blocks, pills (`surfaceContainerHighest`, `secondaryContainer`) |
| `--bg-sidebar` | `#181825` | `bgSidebar` | the top bar |
| `--bg-sidebar-hdr` | `#11111b` | `bgSidebarHdr` | behind the status and navigation bars (`surfaceContainerLowest`) |
| `--bg-input` | `#1e1e2e` | `bgInput` | text field containers |
| `--border-subtle` | `#2e2e42` | `borderSubtle` | dividers (`outlineVariant`) |
| `--border-default` | `#3b3b52` | `borderDefault` | field and outlined-button borders (`outline`) |
| `--border-strong` | `#4e4e66` | `borderStrong` | a focused field's border |
| `--text-primary` | `#cdd6f4` | `textPrimary` | `onBackground`, `onSurface` |
| `--text-secondary` | `#a6adc8` | `textSecondary` | `onSurfaceVariant`, secondary text that must be read |
| `--text-muted` | `#6c7086` | `textMuted` | disabled text, the offline dot; never text that must be read (3.4:1 on `bgBase`) |
| `--text-faint` | `#45475a` | `textFaint` | disabled borders |
| `--accent` | `#89b4fa` | `accent` | `primary`: Approve and Allow fills, section titles, links |
| `--accent-dim` | `#45475a` | `accentDim` | a disabled accent fill |
| `--accent-surface` | `rgba(137,180,250,0.08)` | `accentSurface` | the selected Scanner tab, a pressed row |
| `--success` | `#a6e3a1` | `success` | the online dot, "approved" |
| `--success-bg` | `rgba(166,227,161,0.08)` | `successBg` | an approved row's tint |
| `--error` | `#f38ba8` | `error` | Deny's outline and text, Stop's fill, urgent pills |
| `--error-bg` | `rgba(243,139,168,0.08)` | `errorBg` | running-lease rows' tint (over `bgElevated`), `errorContainer` |
| `--warning` | `#fab387` | `warning` | paused, "Could not confirm with …", limits, the take's unattended line |
| `--warning-bg` | `rgba(250,179,135,0.08)` | `warningBg` | warning rows' tint |
| `--info` | `#89b4fa` | `info` | notes |
| `--info-bg` | `rgba(137,180,250,0.06)` | `infoBg` | the empty state |
| `--radius-sm` | `6px` | `radiusSm` = `6.dp` | code blocks, chips |
| `--radius-md` | `10px` | `radiusMd` = `10.dp` | buttons, text fields |
| `--radius-lg` | `14px` | `radiusLg` = `14.dp` | rows, dialogs, the empty state |

An `rgba` value becomes `Color(red, green, blue, alpha)` with alpha
`round(a × 255)` (`0.08` → `0x14`, `0.06` → `0x0F`). Not carried, and listed
by name in the test as excluded: `--transition` (Compose's own motion), and
`--font-sans` and `--font-mono` (§11.3).

### 11.2 The theme

`Theme.kt` is rewritten: one `darkColorScheme` built from `KlTokens` as the
table says (`onPrimary` and `onError` are `bgBase`), no `lightColorScheme`, no
`dynamicDarkColorScheme` or `dynamicLightColorScheme`, no
`isSystemInDarkTheme`; `KingLouieTheme` takes no parameters. `StatusColors`
keeps only what has no Material slot (`warning`, `warningBg`, `online` =
`success`, `offline` = `textMuted`); the demo colours go. `res/values-night/`
is deleted and `res/values/themes.xml` is the dark window:
`android:Theme.Material.NoActionBar`, `kl_window` = `#FF1E1E2E`, so the splash
and the window behind Compose are `bgBase` whatever the system setting.
The status and navigation bars draw over `bgSidebarHdr` with light icons.
Icons stay Material's (Font Awesome is the desktop's), and the app icon stays
the crowned banana (`icons/`, built by `npm run icons:build`; unchanged).

Contrast: every pair a person must read is at least 4.5:1, and the drift test
computes it (§11.4). `textPrimary` on `bgBase` is about 11:1, `textSecondary`
7.4:1, `accent` 7.8:1, `bgBase` on `accent` 7.8:1, `bgBase` on `error` 7.0:1,
`warning` 9:1.

### 11.3 Typography

System sans for everything (`FontFamily.Default`), with today's sizes, which
are the phone's own (read at arm's length) and not tokens: body 17, 16 and
14 sp, `labelLarge` 16 sp semibold, `titleMedium` semibold. Monospace
(`FontFamily.Monospace`, 15 sp, as `MonoStyle` today) for codes, fingerprints,
node and device ids, the relay pin, parameters and commands. The desktop's
mono stack (Cascadia Code, Fira Code, JetBrains Mono, Consolas) is not on
Android and no font is bundled.

### 11.4 The drift test

`tests/mobile-design-tokens.test.js` (node's runner, no Android SDK):

- parses the first `:root { … }` block of `styles.css` into name → value;
- parses `Tokens.kt` for `val <name> = Color(0x……)`, `Color(r, g, b, a)` and
  `<n>.dp`;
- asserts every CSS token not in the excluded set has exactly one Kotlin
  `val` of the mapped name with the equal colour (hex compared as ARGB with
  `FF` alpha, `rgba` with the rounded alpha) or dp, and that `Tokens.kt` has
  no `val` the CSS does not;
- asserts the contrast pairs of §11.2 (WCAG relative luminance, an `rgba`
  tint composited over the surface it is drawn on) are at least 4.5:1, and
  that no `Text` in the app's Kotlin uses `textMuted` except where marked
  `// disabled`;
- asserts `Theme.kt` contains none of `lightColorScheme`,
  `dynamicDarkColorScheme`, `dynamicLightColorScheme`, `isSystemInDarkTheme`,
  that `res/values-night/` does not exist, and that `themes.xml`'s
  `kl_window` is `#FF` plus `--bg-base`;
- asserts no other Kotlin file under `app/src/main` writes a `Color(0x…)`
  literal (colours come from `KlTokens`), except `QrScanner.kt`'s and the QR
  image's black and white.

A change to the desktop palette then fails the test until `Tokens.kt` follows.

## 12. Kotlin files

Under `mobile/android/app/src/main/kotlin/com/example/kinglouie/`:

| File | Fate |
|---|---|
| `Screens.kt` | rewritten: `Root`, navigation between the four screens, the Approvals list and its rows. `Welcome`, `Main`'s tabs, `Pending`, `PendingCard`, `History`, `Nodes`, `Devices` and `Settings` go; `Detail` moves to `DetailScreens.kt` |
| `DetailScreens.kt` | new: the detail of a tool approval, question, client connection, node pairing and alert |
| `ScannerScreen.kt` | new: the two tabs of §6.1 (uses `QrScanner.kt` and `QrImage`) |
| `SettingsScreen.kt` | new: §6.4 |
| `LeaseScreens.kt` | rewritten: `LeaseRequestScreen` kept (the request detail, Allow and Deny), `LiveLeaseScreen` becomes the running lease's detail with §7.6's loop; `LeaseRequests` and `LeaseBanner` go (their rows are built by `ApprovalList`). The constants `UNATTENDED_LINE`, `BROWSER_TRUE_LINE`, `CREDENTIALS_LINE`, `LIMIT_TEXT` and `takeTitle` stay |
| `FrontDoorScreens.kt` | deleted; `ConnectClient`'s editor moves to `DetailScreens.kt`, `auditBreakWords` to the alert detail, `Clients` to Settings |
| `Questions.kt` (app) | deleted; the question detail is in `DetailScreens.kt` |
| `AppModel.kt` | rewritten in part: demo, history and every tap-only fetch go; the loop of §9, the stores of §10, the read-key set-up of §8.7 come in. The section between `// ---- Leases (fleet stage 5) ----` and a new end marker `// ---- Leases: end ----` (the demo marker goes) keeps `verifiedLeaseRequest`, `noteListedLease`, `notePendingListed`, `dropMayStartRows`, `sendLease`, `decideLease`, `killSwitch`, `stopRunningLease`, `applyLease`, `applyReplyStatus` and `unattendedTake` as they are, apart from the key each signs with |
| `ReadKey.kt` | new: §8.1 |
| `DeviceKey.kt` | kept; `create` also makes the read key |
| `RelayApi.kt` | rewritten in part: two signers, each route's key per §8.4, `presence`, `readKey`; `history` goes; the long-poll semaphore stays |
| `Theme.kt` | rewritten (§11.2) |
| `Tokens.kt` | new (§11.1) |
| `Ui.kt` | rewritten to wear the tokens: `ItemCard` (`bgSurface`, `radiusLg`), `TimePill`, `ApproveButton`, `DenyButton`, `stopColors`, `DecisionBar`, `CodeBlock` (`bgOverlay`, `radiusSm`), `OnlineDot`, `EmptyState`, `ScreenTitle`, `SectionTitle`, `Secondary`, `BackBar` |
| `QrScanner.kt`, `MainActivity.kt`, `KingLouieApplication.kt` | kept; `MainActivity` keeps routing a tapped notification to `openPushed` (§13) |
| `push/Push.kt` (`fcm`, `nopush`) | kept; spec 3 changes the kinds |

In the protocol module: `AppCore.kt` loses `AppMode.DEMO`; `DemoFleet` moves
to `protocol/src/test/` (the vector tests still use it to sign) (C-17);
`ApprovalList.kt` is new (§10); `Messages.kt` gains the read string, the
`device.read_key` member and `kl.device.read_key`. `Lease.kt`, `Display.kt`,
`Envelope.kt`, `FrontDoor.kt`, `Questions.kt`, `Encoding.kt` and
`Ed25519.kt` are unchanged.

### 12.1 What `tests/mobile-lease-apps.test.js` pins now

Kept as they are: every iOS test; every test of the protocol cores (`Lease.kt`
and the vector tests: order and addressee, contact-token echo, `tokenIsStale`,
`isLive`, "Granted by", the listing rules and shape, the three per-node
states, "May still start", `listedPendingGetsRow`, the take keys and lines);
and, in the Android app, the rules that do not depend on taps:

- one place posts a lease envelope (`sendLease`), and Stop, Allow and Deny
  are each signed once and sent once, an unanswered send shown as not
  confirmed (R-F5-5);
- a live lease's state is written only in `applyLease`, from a status or view
  the pinned node signed; a relay's reply to Stop or a watch never says
  "ended";
- a lease request is shown only through `verifiedLeaseRequest` and the core;
  the request detail shows the fields it shows today;
- `signed_at` is the relay-corrected clock.

Replaced (R-F5-1, R-F5-6 and T19-presence no longer hold for Android; R-AN-6,
R-AN-9 replace them):

- "no loop and no timer" becomes: the only loops are `ForegroundLoop` (§9)
  and the live view's (§7.6); both start and stop with the lifecycle; neither
  names `signEnvelope(k,`, `DeviceKey`, `decide(`, `decideLease(`,
  `killSwitch(`, `answer(` or `stopRunningLease(`; `LeaseScreens.kt` calls the
  live view's start and stop only from one `DisposableEffect`.
- the watch is signed with the read key in the live view's loop (one
  `signRead(` there), every 20 s with the early-watch rule; the fallback
  device-key watch is called only from its button.
- the lease push opens the lease's detail (§13) instead of noting it.
- the paused line is "Paused: open to let it continue" on the row, and the
  live view's "Keep this open to keep it going" line for a lease this phone
  granted.
- the counts (`scope.launch`, `sendLease(api,`, `signEnvelope(k,`,
  `api.leases(`, `Timestamps.string(api.now())`) are recomputed for the new
  file and written down there with the reason for each.
- "neither app's demo shows typed text" reads iOS only, and a new assertion
  says the Android app has no `AppMode.DEMO` and no `DemoFleet`.

New, in `tests/mobile-android-slim.test.js` (source reads, like the file
above): the four screens exist and nothing else is a screen (no
`NavigationBar`, no `Tab` enum, no `History(`, `FrontDoor(`, `Questions(`
composable); none of the strings "Check for requests", "Show devices", "Try
demo", "Check for computer-use requests", "Check for questions", "Refresh
online state" remain; the read key is used only by `RelayApi`'s read routes,
presence and `Leases.watch`; every route `RelayApi` calls with the read key is
`read` in §8.4's table (the test holds a copy of the table and the relay test
holds the same one).

## 13. A tapped notification (R-AN-9; the hand-off to spec 3)

A notification carries a kind and an id and nothing else (approval-v1 §8;
spec 3 keeps it content-free). The notification has no action buttons. A tap
opens the app on that item's detail, fetching with the read key, so no
fingerprint is asked for:

| Kind | Fetch | Opens |
|---|---|---|
| `approval` | `GET /v1/approvals/{id}` | the tool approval's detail |
| `question` | `GET /v1/questions` | the question whose token is the id, else the list |
| `lease` | `GET /v1/leases?nonce=` | the request whose `request_id` is the id, else the running lease whose `lease_id` is the id |
| `pairing` | `GET /v1/pairings/pending` | the pairing whose id is the id |
| `alert` | `GET /v1/alerts?since=0` | the alert whose id is the id |
| `session_paused`, `session_ended` (spec 3's kinds; the id is the `lease_id`) | `GET /v1/leases?nonce=` | the live lease view of that lease. Paused: the view's read-key watch is contact and resumes it. Ended: the signed ended status and its reason; when a passed listing no longer names the lease, "<node> no longer has this session; it is not running" (C-18) |
| a count above 1, `test`, anything else | none | the Approvals list |

When the item is gone (decided on another phone, expired, answered
elsewhere) the app opens the list with one line: "That request is no longer
waiting." The push token is registered right after enrollment and re-sent when
FCM rotates it, with the read key (§8.4); the rest of push is spec 3's.

## 14. Documentation

- `CONTEXT.md`: **Device key** ("the paired phone's key that decides; on
  Android each signature asks for a fingerprint") and **Read key** ("the
  paired phone's second key, which may only read and keep contact; it asks
  for nothing"), each with its _Avoid_ line (session key, API key).
- `docs/protocol/approval-v1.md`, `lease-v1.md`, `client-grant-v1.md`: §8.9.
- `mobile/PRIVACY.md`: the Android app now polls and reports presence while
  open (the relay sees when it is open); the read key, what it signs, and
  that its public half is on the relay and the nodes.
- `CLAUDE.md`, "Session helper", the phones bullet: Android now loops while
  in the foreground, reports presence, sends a read-key watch every 20 s while
  a lease's detail is open; the sentences "Android fetches on tap …", "Android
  sends no presence and loads questions only when the owner taps", "a lease
  push there fetches nothing (R-F5-6)", "its Refresh asks for a fresh status
  first …" and "On Android a property that `AppModel`'s `init` reaches (through
  `startDemo`) is declared above `init`" go or change. "Approvals and relay":
  the vector counts (49 and 55).
- `docs/fleet/front-door.md` and `docs/install-guide.md`: upgrade the relay
  and nodes before the Android app (§8.7); `device apply` for a phone's read
  key.

## 15. What is left

- A client connection cannot be listed before the owner types its code:
  client-grant-v1 claims a request by code, and R-AN-7 adds no listing. The
  row appears after the code is typed on the Scanner.
- Kinds other than tool approvals reach the list up to about 25 s late
  without push (§10).
- The read key weakens contact and presence to "the phone is unlocked with
  the app open" (§8.10): someone with the owner's unlocked phone can read
  everything the list shows, keep a lease this phone granted going until its
  expiry, and hold questions on the in-app rung.
- A phone enrolled before this change needs `device apply` on each node before
  its watches there are contact; until then each watch is a fingerprint the
  owner asks for (§7.6, §8.7).
- No fallback for an older relay: the app needs a relay with read keys.
- The two phones now differ: iOS keeps seven tabs, its own look, the demo and
  its session unlock; an owner with both sees two designs.
- `textMuted` fails 4.5:1 on every background; the app uses it only for
  disabled text, which the test checks only for `Text` calls it can read.
- A `briefing` question answered with Got it on the row is a press like any
  other; the row shows the whole question only when it fits on one line, and
  the Got it is still offered when it does not (a briefing asks nothing).
- `--font-mono`'s fonts are not on the phone; codes use the system monospace.
- Removing a node on the phone only forgets the pin; the relay still lists the
  phone as an approver there until the node's administrator revokes it.

## 16. Test plan

Node (`npm test`; covering files per task, the full suite once at the end):

- `tests/frontdoor-phone-api.test.js`: the read string and header; a read
  request accepted on a `read` route, `403 read_key_not_allowed` on a `device`
  route, `401 unknown_read_key`, `401 bad_signature` for a read signature
  checked against the device key and the reverse; one replay cache and one rate
  bucket across both keys.
- `tests/frontdoor-phone-routes.test.js` and `tests/frontdoor-relay.test.js`:
  every route's `auth` equals §8.4's table (one table in the test, iterated);
  `read_jwk` set from each enrollment path; `POST /v1/devices/read-key` (signer,
  caller, active, forwarding, a newer statement replaces, an older does not).
- `tests/approvals-messages.test.js`, `tests/approvals-protocol.test.js`:
  `device` with and without `read_key`, equal keys, off-curve points;
  `kl.device.read_key` shape and window.
- Approver store tests: `read_key` in records, test keys, staging and `device
  apply` of a statement, `stale`, `from_the_future`; `tests/service-cli-devices.test.js`:
  `device apply` and `enroll-device` print the read key's fingerprint and ask.
- `tests/gui-leases.test.js`: a read-signed watch from the granting device is
  contact; from another device, frames only; with no `read_key` in the record,
  `bad_signature`; a read-signed grant, revoke and resume grant refused; the
  audit entry's `key`.
- A refusal sweep (anti-goal §4): one test signs every phone-signed message
  type the node and front door accept with a read key and expects
  `bad_signature` from each verifier except `verifyLeaseWatch`.
- Vectors: `generate.js --check` for both suites (49, 55);
  `tests/lease-vectors.test.js` with the split phone sets.
- `tests/mobile-design-tokens.test.js` (§11.4), `tests/mobile-android-slim.test.js`
  and the changed `tests/mobile-lease-apps.test.js` (§12.1).

Android protocol module (`../gradlew test` in `mobile/android/protocol`):

- `ProtocolVectorTest`, `LeaseVectorTest`: the new Android vectors (the read
  string and signature, the enrollment payload with `read_key`, the read-key
  statement, the read-key watch).
- `ApprovalListTest`: the order of §7.4 over mixed stores; the row buttons of
  §7.2 and each exception (overflow is passed in as a flag); decided rows; the
  pinned lease rows from statuses and listings, including "Could not confirm"
  and "Not checked yet"; no row for an ended lease; the empty state's words.
- `LeaseFlowTest`, `QuestionTest`, `FrontDoorVectorTest`: unchanged, with
  `DemoFleet` from test sources.

By hand, on a phone, against a temporary service and relay on a test machine
(`tests/e2e/_attach-service.js`-style, a self-signed relay certificate,
`relay.example.com` in the phone's hosts entry): pair, the set-up row on an
already-enrolled phone, the list filling without taps, one fingerprint per
decision, a computer-use lease kept going by an open detail and paused after
closing it, presence seen by a case question's ladder, a tapped notification
on the `fcm` flavor opening its detail. No test touches a real phone's
Keystore; the app has no instrumented tests, as today.

## 17. The author's calls (for the owner to check)

- C-1: the read key is a Keystore P-256 key with no user authentication but
  `setUnlockedDeviceRequired(true)`, made beside the device key, not
  invalidated by a new fingerprint, fingerprinted `r-…` (§8.1).
- C-2: enrollment carries it as an optional `device.read_key`; approver
  records and relay device records keep it; iOS sends none (§8.2).
- C-3: the relay tells the keys apart by an `X-KL-Key: read` header and a
  `KL-PHONE-READ-V1` first line in the signed string; routes are `read` or
  `device` (§8.3).
- C-4: a write whose body is a device-key envelope may travel on a read-key
  request, so each decision costs one fingerprint instead of two; a write with
  no envelope (a client's code claim, an alert acknowledgement, a pairing code,
  an invite) stays on the device key; the push token is a read route (§8.4).
- C-5: on the node only `kl.lease.watch` verifies against the read key, by an
  `allowReadKey` option on the one shared check (§8.5, §8.6).
- C-6: a phone enrolled before this adds its read key with a device-signed
  `kl.device.read_key`, live on the relay at once and applied on each node by
  `device apply`, rather than enrolling again or letting a node take the key
  without its administrator (§8.7).
- C-7: one foreground loop on `ProcessLifecycleOwner`: the approvals long poll
  as the wake signal, the other kinds fetched after each return at most every
  5 s, and on pull, push and return from a decision (§9).
- C-8: presence every 60 s with the read key while in the foreground, and a
  best-effort `foreground: false` on leaving (§9).
- C-9: watches every 20 s, with iOS's early-watch rule, only while a running
  lease's detail is on screen and the app is in front (§7.6).
- C-10: no bottom bar; Approvals is the root with Scanner and gear in its top
  bar; an unpaired phone opens on the Scanner (§6).
- C-11: the order of §7.4: running leases first (paused-for-contact by this
  phone at the top), then node warnings, then the soonest deadline, then
  alerts and questions, then decided rows.
- C-12: four exceptions to Approve on the row (a summary that does not fit, a
  computer-use request with limits, a take with credentials, a pairing that
  replaces a node), a briefing's Got it on the row, and a pairing row's
  fingerprint on a second line (§7.2).
- C-13: a client's code is typed on the Scan tab, and claiming it is one
  fingerprint before the row appears (§6.1, §8.4).
- C-14: a phone joining by invite stays in Settings' Add another phone flow,
  whose claim is now polled every 3 s with the read key (§6.4, §7.1).
- C-15: Remove on a node forgets its pin on this phone and sends nothing; the
  front door's signed removal is a separate button (§6.4).
- C-16: the tokens file is a Kotlin object compared with `styles.css` by a node
  test, with no JSON in between; type sizes are the phone's own (§11).
- C-17: demo mode goes from the Android app; `DemoFleet` moves to the protocol
  module's tests, which still sign with it (§12).
- C-18: an ended lease has no row; its detail opens from a notification (§7.3,
  §13).
- C-19: no fingerprint fallback for a relay without read keys; the app says to
  upgrade it (§8.7).
- C-20: the merge and order are a pure function in the protocol module,
  tested without a device (§10).

## 18. Owner rulings (2026-10-28)

- **R-AN-1.** Android only. iOS is untouched: it keeps building and keeps its
  vectors. The owner carries Android.
- **R-AN-2.** Four screens: (a) Scanner with two tabs, Scan a code and Get a
  code; (b) Approvals, one list of every Approval kind plus running leases and
  takes as rows with Stop; (c) Approval detail, where a running lease's detail
  is the live lease view; (d) one gear screen with paired nodes and Remove,
  the relay or front-door pin with a re-pin scan, Devices kept minimal (add
  another phone, revoke), Reset this phone and the privacy note. Removed:
  demo mode, the Questions tab, the Nodes tab, History, the Front door
  screens, the standalone Leases section.
- **R-AN-3.** Front-door client connections, node pairings waiting and alerts
  become Approval kinds; an alert row has Acknowledge.
- **R-AN-4.** Rows show node name, kind, a host-built one-line summary and
  time left. Approve and Deny on the row for yes/no kinds (tool approval,
  lease or take request with its defaults, client connection, enrollment). A
  question with options or free text, a lease request the owner wants to edit,
  and an alert open the detail. The F3 rule stands: the exact action is shown
  before Approve, and the detail shows every parameter as today.
- **R-AN-5.** A second, non-biometric device key for read-only relay calls
  (lists, statuses, presence) and for `kl.lease.watch` (contact). Approve,
  Deny, Stop, grants, enroll, revoke, connect and disconnect, add and remove
  node stay biometric with the existing key. Nodes accept a watch signed by
  either key of the granting device. Enrollment carries both public keys,
  lease-v1's watch check changes, the vectors are regenerated, and the relay
  authenticates read routes with the read key. Contact then proves "the phone
  is unlocked on this view", not "the owner just authenticated"; a thief with
  the unlocked phone can read approvals but not answer them.
- **R-AN-6.** In the foreground, as on iOS: a long-poll loop, presence
  reported (so the contact ladder's in-app rung sees the phone), lists live
  without taps. "Check for requests" and "Show devices" go. For Android this
  replaces R-F5-1 (nothing on the lease screens runs by itself), R-F5-6 (a
  lease push fetches nothing) and ruling T19-presence (no presence from
  Android); R-F5-5 (each Stop, Allow and Refresh sent once) stands for every
  decision.
- **R-AN-7.** The list is merged on the phone from the existing endpoints: the
  approvals long poll as the wake signal, the other kinds fetched when it
  returns and on push. No new merged relay endpoint.
- **R-AN-8.** Native Compose components wearing the desktop's tokens; dark
  only; Material You off; one tokens file a test holds equal to `styles.css`;
  system sans, monospace for codes and fingerprints; the icon stays the
  crowned banana.
- **R-AN-9.** A tapped notification opens the item's detail; notifications
  carry no action buttons. Push itself is spec 3.
