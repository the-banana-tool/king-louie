# Push notifications: switch on Android push and add two triggers

Date: 2026-10-28. Status: draft for the owner's review (owner rulings
R-PU-1 to R-PU-5 in §13, from the grilling of 2026-10-28; the author's calls
C-1 to C-16 in §12).

Spec 3 of the 2026-10-28 quality-of-life program (1: the desktop attached to
the personal node; 2: the Android app slimmed and styled; 3: this; 4: the
browser runner). It depends on spec 2's read key (its R5) and its
notification-tap and Approvals-list screens (its R2, R7, R9); where spec 2
is cited below, the ruling number is the program brief's.

Related: approval-v1 (`docs/protocol/approval-v1.md` §7 routes, §8 push),
lease-v1 (`docs/protocol/lease-v1.md`), client-grant-v1 (grants are never
pushed), fleet stage 3 (`2026-09-23-fleet-stage3-approvals.md`), fleet
stage 5 (`2026-09-23-fleet-stage5-session-helper.md`), demo takes D1
(`2026-10-24-agent-driven-demo-takes-design.md`), the personal node
(`2026-10-25-personal-node-design.md`), `docs/fleet/front-door.md`,
`mobile/PRIVACY.md`.

## 1. Intent

Push was built in fleet stage 3 and has been off ever since: the relay can
send FCM and APNs messages, the Android app has an `fcm` flavor that turns
them into notifications, and nothing is configured. Without it the owner
learns that a node is waiting only by opening the app. On the personal node,
which runs unattended takes while the owner is away, it also means the owner
does not learn that a take ended early (the screen locked, the driver went
silent, the recorder failed) or that a computer-use lease paused because no
phone was watching.

This spec does three things. It says exactly how the owner switches on what
exists for Android: their own Firebase project, the relay's credential, the
build. It adds two triggers: a lease or take that ended for any reason but a
Stop from the phone being notified, and a lease paused for want of contact.
And it ties token registration and notification taps to spec 2's read key,
so a push costs no fingerprint prompt until the owner decides something.

## 2. Goals

- The owner goes from no push to a working notification on their phone by
  following one numbered runbook (§10), with no value of theirs in the
  repository.
- Every new Approval the relay pushes today reaches the Android phone as a
  notification; a tap opens that item's detail.
- A lease or take that ends, other than by a Stop from the phone being
  notified, gives that phone one notification. A lease paused for want of
  contact gives the granting phone one notification, and its tap resumes
  the lease by opening the live view.
- A burst of Approvals gives a bounded number of notifications, not one per
  item.
- The push stays content-free: a kind, an id, the node's name, at most a
  count.

## 3. Non-goals

- iOS. The APNs sender, the iOS app and its handling of pushes are not
  touched; every new behaviour here applies to devices whose push platform
  is `fcm` only, and an `apns` device gets exactly what it gets today. This
  is the one place the spec says so.
- Action buttons on the notification (Approve, Deny, Stop): R-PU-4.
- End-to-end encryption of push or relay content (approval-v1 §11.12 stays
  open).
- Pushing anything that is not an Approval or one of the two new triggers:
  case progress, chat replies, front-door client grants, lease status churn
  (locked, unlocked, helper reconnecting, relay unreachable), a lease that
  never ran.
- A unified relay endpoint for the phone's list (spec 2 R7 keeps the
  existing ones).
- A relay of the owner's that is not the front door. §10 is written for the
  front door (the owner's relay); a `relay run` host takes the same
  `relay.push` block and the same file, and the differences are named where
  they occur.

## 4. Constraints

- No personal values in the repository (`tests/helpers/example-denylist.js`,
  the owner's standing rule). Firebase project ids, service-account emails,
  application ids, host names and paths in this spec, the docs and any
  example are invented: `kl-example-push`, `com.example.kinglouie`,
  `mcp.kl.example.com`, `/etc/king-louie/...`.
- `google-services.json` and the service-account key never enter git.
  `mobile/android/.gitignore` already ignores
  `app/src/fcm/google-services.json` and `local.properties`; this spec adds
  a test that fails when either file, or any `*service-account*.json`, is
  tracked (C-15).
- approval-v1 and lease-v1 messages do not change, so no vector changes
  (`tests/vectors/approval-v1/generate.js --check` still says 41,
  `tests/vectors/lease-v1/generate.js --check` 51). What changes is the
  push payload (approval-v1 §8), the push-token routes (§7.3) and one
  node-to-relay link method (§6.2), all outside the signed messages.
- `src/` stays Electron-free. The relay loads no agent code; the new link
  method lives with the relay's other node methods.
- Push failures never block or fail anything (`src/frontdoor/push/index.js`
  says so today) and never log a device token, a JWT or an OAuth token.
- Tests never touch Google, Apple or a phone: senders run against a local
  HTTP server, as `tests/frontdoor-push.test.js` already does for FCM.

## 5. What exists (checked 2026-10-28)

### 5.1 The relay

- `src/frontdoor/push/`: `createPusher` (`index.js`) picks the sender whose
  `platforms` include the device's `push.platform`, falling back to `none`.
  `fcm.js` is FCM HTTP v1 with a service account: an RS256 assertion
  exchanged at `oauth2.googleapis.com/token` for an access token cached
  until a minute before it expires, then a data-only, `HIGH` priority
  message `{ rid, n, k }` with `android.ttl` the seconds to `expires_at`,
  else 300. `apns.js` is the iOS sender. `jwt.js` signs and holds a small
  `requestText` helper (10 s timeout). `none.js` sends nothing. `text.js`
  holds `KINDS` (`approval`, `grant`, `pairing`, `alert`, `question`,
  `lease`), the generic titles, and `sanitizeNodeName` (control and format
  characters stripped, capped at 40).
- Config: `relay.push` in the admin `service.json`, parsed by
  `parsePushConfig` (`src/service/config.js:67-92`), strict keys. The FCM
  part is exactly `{ "fcm": { "service_account_file": "<path>" } }`. On the
  front door the `relay` block may hold only `push`
  (`src/frontdoor/startup-checks.js:12-13`) and is read at
  `src/frontdoor/profile.js:278`; on a `relay run` host it sits beside
  `phone_listen`, `tls`, `mesh_listen` and `public_url`.
- The file is read once, at relay start (`defaultSenders`, `index.js:17-27`),
  as a Google service-account JSON key (`project_id`, `client_email`,
  `private_key` are used). A missing or unparsable file throws there and
  the front door does not start; a changed file needs a restart (`SIGHUP`
  does not re-read it). A file missing one of the three fields fails only
  at the first push.
- Where pushes come from today:
  - `approval.submit` pushes `approval` to every device active on the node
    (`src/frontdoor/node-methods.js:118`);
  - `message.submit` with a `push` parameter pushes its `kind`
    (`node-methods.js:129-148`): the lease manager's `lease` for a lease or
    take request (`src/gui/leases.js:528`), the phone app channel's
    `question` with `to_device` (`src/channels/mobile-app-channel.js:188`);
  - the front door's own `pairing` and `alert` go to its active approvers
    through `createApproverNotifier` (`src/frontdoor/notify.js`, wired at
    `profile.js:206`, raised at `pairing/pairing-service.js:345` and by the
    alert center).
  - Grants are never pushed (`notify.js`'s header; client-grant-v1). A
    device enrollment by invite is not pushed: the owner holds both phones.
- `PUT /v1/push-token` (`src/frontdoor/routes.js:309-319`, device auth,
  `{ platform: apns|fcm, token ≤ 4096 }` → 204) stores the token on the
  device record (`DeviceRegistry#setPush`, `device-registry.js:101-107`). A
  token FCM answers `404 UNREGISTERED` (APNs `410`) is dropped:
  `onDropToken` → `setPush(id, null)` (`src/frontdoor/relay.js:127-130`).
- Who receives: `devicesForNode(nodeId)`, the devices whose state on that
  node is `active` (`device-registry.js:121-124`), so a device stops
  receiving as soon as its revocation is staged there.
- Tests: `tests/frontdoor-push.test.js` (the pusher's fallback and token
  drop, the alert text, an APNs HTTP/2 server, an FCM token-and-send server
  on 127.0.0.1 through `tokenUrl` and `fcmOrigin`).
- `docs/fleet/front-door.md` has no push section today.

### 5.2 The Android app

- Flavors `fcm` and `nopush` (`mobile/android/app/build.gradle.kts:27-30`).
  The `google-services` Gradle plugin is applied only when
  `app/src/fcm/google-services.json` exists (`:61-65`), so the `fcm` flavor
  builds without it, and `Push.register` returns quietly when there is no
  Firebase app: it then behaves as `nopush`.
- `app/src/fcm/.../push/Push.kt`: `KlMessagingService` turns a data message
  `{ rid, n, k }` with `k` in `approval`, `pairing`, `alert`, `question`,
  `lease` into a local notification on channel `approvals` (importance
  high), id `"$kind:$rid".hashCode()`, generic text built on the phone. It
  keeps only letters, digits and `._-` of `n` (a node named `web 01` shows
  as `web01`) and uses a stock alert icon.
- The token is stored on `onNewToken` and sent (a signed request, so a
  biometric prompt today) only after an enrollment finished or a check got
  through (`AppModel.kt:1266`, `:1412`; `sendPushToken`, `:2158-2168`),
  once per token value. `Reset this phone` keeps the token on the phone and
  tells the relay nothing.
- A tap reaches `MainActivity.handle` (`:39-42`) and `openPushed(kind, id)`
  (`AppModel.kt:2126`); a `lease` push fetches nothing (R-F5-6: a fetch was
  a prompt the owner did not ask for).
- `POST_NOTIFICATIONS` is declared and asked for at first start.
- `mobile/android/local.properties.example` already tells the owner where
  `google-services.json` goes; `kl.applicationId` there is the package name
  Firebase must be given.

### 5.3 Where the two new triggers can come from

- A lease ends in one place, `LeaseManager#_end(lease, reason)`
  (`src/gui/leases.js:830-849`), once (it returns when already ended), and
  signs an `ended` status with that reason, sent to the relay with no push
  (`_sendStatus`, `:916-919`). A take ends its lease through
  `endLease(leaseId, reason)` with the take's reason, so a take's ending is
  that same call. Reasons that reach `_end` include `expired`, `revoked` (a
  phone's `kl.lease.revoke`, whose verified `device_id` is in hand at
  `:661`), `denied` (a deny of a first request or of a resume),
  `device_revoked`, `job_closed`, `node_identity_invalid`,
  `request_expired`, `service_stopped`, and the take reasons (`take_done`,
  `driver_silent`, `recorder_failed`, `helper_lost`, `screen_locked`,
  `browser_launch_failed`, ...).
- The status does not say which device revoked a lease; the relay sees the
  revoke envelope on its way in but cannot tie it to the status that
  follows except by timing.
- A lease pauses for want of contact in `LeaseManager#suspend(id,
  'no_contact')`, from `active` only. An unattended take never pauses
  (R-D1-7).
- A take left unfinished by a crash is ended `service_restarted` at the
  next start by `TakeStore#markLiveEnded` (`src/gui/take-store.js:171`).
  Its lease is gone from memory, so no status is signed for it; its record
  keeps `lease_id` and `grant`.
- At a clean stop the GUI stops first (`src/service/run.js`, the `stop`
  order), ending every lease `service_stopped` while the relay link is still
  up; the status send is not awaited.

## 6. The two new triggers

### 6.1 Which endings and pauses push (R-PU-3)

**`session_ended`**, one push per lease, ever, when a lease that ran ends:
one whose `granted_by` is set, whatever its reason, including a take's own
reasons, `service_stopped` and `service_restarted`. It goes to every device
active on the node except the one whose own signed message ended it: the
`device_id` of a verified `kl.lease.revoke` (`revoked`, either revoke
`reason`), or of a verified deny of a resume request (`denied`). A Stop from
phone B notifies phone A and not B; an expiry, a silent driver or a revoked
granting device notifies every phone still active there (a revoked device
is no longer active, so it gets nothing).

Not pushed: a lease that never ran (`request_expired`, a deny of the first
request, `job_closed` or `browser_launch_failed` before a grant). Its
request was already pushed as `lease`, and the phone's row for it goes with
its next list (C-3).

**`session_paused`** when a computer-use lease goes from `active` to
`suspended` with reason `no_contact`, to the granting device only: only its
watch is contact and resumes the lease (lease-v1 §2). Not when another
reason takes over a contact pause, and not for any other suspension reason
(C-4).

### 6.2 Where they originate: the node, through a new link method (C-1)

The node decides and the relay carries, as for every push today. The relay
could read `ended` statuses as they pass through `message.submit` (they are
in the clear), but it does not know who stopped a lease, it would see ended
statuses again (a replayed revoke, `lease.list`) and have to tell
transitions from repeats, and the restart case has no status at all.

New node-to-relay link method, registered beside `message.submit`:

```
push.notify { kind: 'session_ended' | 'session_paused',
              id: <lease_id, uuid v4>,
              to_device: <device id> | null,
              except_device: <device id> | null,
              expires_at: <RFC 3339> | null }
  → { ok: true }
```

- It is authenticated as `message.submit`'s `push` parameter is: by the
  node's pinned link, unsigned. The relay checks `kind` against these two
  values only, `id` against the UUID v4 pattern, each device id against the
  registry's `DEVICE_ID_RE`, that `to_device` and `except_device` are not
  both set, and `expires_at` with `isTimestamp`; anything else is
  `bad_push`.
- Targets: `devicesForNode(nodeId)`, narrowed to `to_device` or without
  `except_device`, and only devices whose push platform is `fcm` (C-2).
- Nothing is stored in the mailbox and the relay keeps no lease state.

On the node:

- `LeaseManager#_end` records `lease.endedBy` (the device id named in §6.1,
  else null) and, when `lease.grantedBy` is set, queues
  `{ kind: 'session_ended', id: lease.leaseId, except_device: endedBy }`
  after the ended status is sent. `suspend` queues
  `{ kind: 'session_paused', id, to_device: lease.grantedBy, expires_at:
  lease.expiresAt }` on the transition of §6.1 only.
- `TakeManager`, after `markLiveEnded('service_restarted')` at start,
  queues one `session_ended` for each take it ended whose record has a
  `lease_id` and a `grant` (no `except_device`).
- The queue is small and in memory: sent at once while the relay link is
  up, else on the link's next `connected`. An entry older than one hour is
  dropped (an ending an hour old says nothing the phone's next list does
  not), and the queue holds at most 32 entries, oldest out.
- `gui.stop()` waits for the queue to drain, at most 2 s, so the
  `service_stopped` pushes leave before `approvals.stop()` closes the link
  (the GUI already stops first).
- A relay older than this answers an unknown-method error: the node logs it
  once at `debug` per link and drops the queue until the next `connected`.

### 6.3 Dedupe: one ending is one push (C-5)

Twice over. On the node, `_end` runs once per lease and `suspend` queues
only on the transition, so a repeated status (a replayed revoke, a listing)
never queues. On the relay the pusher keeps, per device, the keys
`(node_id, kind, id)` it has pushed:

| Kind | Kept for |
|---|---|
| `session_ended` | 24 hours (a lease lasts at most 240 minutes) |
| `session_paused` | 2 minutes (the default contact window, so a second pause after the owner looked and left again is pushed) |
| `approval`, `question`, `lease`, `pairing`, `alert` | 10 minutes (a node that re-submits the same request after a relink, or an alert raised twice, notifies once) |

The set is in memory, capped at 2,048 keys per relay (oldest out); a relay
restart forgets it, which can repeat one push.

### 6.4 Coalescing a burst (C-6)

Per `fcm` device, after dedupe: the first push goes at once and opens a
10-second window; pushes arriving in the window are held; when it closes,
if any were held, one push goes with the newest held item's `k`, `rid` and
`n` and `c`, the number held, and a new window opens. Ten tool approvals in
two seconds are two notifications: "Approval needed on gpu-box", then
"10 waiting" on the phone (§7.2's running count). Independently, at most 60
pushes per device per hour; past that a push is dropped, with one `warn`
line per device per hour (a node in a loop must not drain the phone's
battery). `session_ended` and `session_paused` take part in the window like
any kind; when the held items come from several nodes, `n` is the newest's.

### 6.5 Lifetime and priority

FCM `android.ttl` stays the seconds to `expires_at` when one is given (an
Approval, a paused lease's own expiry), else 3,600 s for `session_ended`
and 300 s for everything else, as today (C-7). Priority stays `HIGH`: every
push the app receives becomes a visible notification, which Android expects
of high-priority messages.

## 7. The payload, the phone and the token

### 7.1 The payload (R-PU-2)

FCM data, every value a string:

| Field | Value |
|---|---|
| `k` | `approval`, `question`, `lease`, `pairing`, `alert` (as today); `session_ended`, `session_paused`, `test` (§9) |
| `rid` | the item's id: `request_id` (approval, lease), the question's token, the pairing or alert id, the `lease_id` (session kinds), a random id (test) |
| `n` | the node's name, sanitised and capped at 40 by the relay; empty when unknown |
| `c` | only on a coalesced push: how many items it stands for, `2` to `999` |

Nothing else: no text of the action, no case, app, site or take name, no
reason code, no time left. `KINDS` in `push/text.js` gains the three new
kinds with titles ("Session ended", "Session paused", "Test") so the code
keeps one list, but `message.submit` keeps accepting only the kinds it
accepts today (its check moves to its own list), and the new kinds and `c`
reach `fcm` devices only.

### 7.2 What the phone shows and what a tap opens (R-PU-4)

`Push.kt` accepts the eight kinds above and ignores any other, so a newer
relay never confuses an older app. Its small icon becomes the hand-written
monochrome banana vector (CLAUDE.md, Icons), and `n` keeps spaces (letters,
digits, spaces and `._-`, trimmed, 40 characters). There are no action
buttons.

- Approval kinds (`approval`, `question`, `lease`, `pairing`, `alert`): one
  notification on channel `approvals`, tag `approvals`, replaced by each new
  one. The app counts pushes (adding `c` when present) since it was last in
  front. At 1 it says "Approval needed on <n>" (`question`: "Question
  waiting on <n>"; `lease`: "Session request on <n>"; `pairing`: "Pairing
  request"; `alert`: "Front door alert"); above 1, "<count> waiting". The
  count resets when the app comes to the front.
- `session_ended`: channel `sessions` (default importance, C-8), tag
  `ended:<rid>`, "Session ended on <n>".
- `session_paused`: channel `sessions`, tag `paused:<rid>`, "Session paused
  on <n>: open to continue". The app cancels it when it next applies a
  signed status of that lease that is not `suspended`.
- `test`: channel `approvals`, "Test notification from <n>".

A tap opens spec 2's screens through `openPushed(kind, id)`, fetching with
the read key (no prompt) and showing only what a pinned node signed:

- a count above 1, or `test`: the Approvals list;
- `approval`, `question`, `lease`, `pairing`, `alert`: that item's detail;
  when the fetch finds it gone (decided elsewhere, expired), the list with
  one line, "That request is no longer waiting";
- `session_paused`: the live lease view of that lease. The view sends a
  watch signed with the read key (spec 2 R5); that watch is contact and
  resumes the lease. Opening the notification is the owner's act of
  looking;
- `session_ended`: that lease's detail with its final status as the node
  signed it (state `ended`, the reason in words, who granted it); the node
  names its last four ended leases in every listing (lease-v1 §2,
  "Listing"). When an accepted listing no longer names the lease (a node
  that restarted), the detail says "<node> no longer has this session; it
  is not running", which that listing proves.

R-F5-6 (an Android `lease` push fetches nothing) is lifted: it existed
because a fetch was a fingerprint prompt, and with the read key it is not.

### 7.3 Token registration with the read key (R-PU-5)

Spec 2 R5 gives the phone a second, non-biometric key for read routes. The
push-token routes join that list (C-9):

- `PUT /v1/push-token` accepts the read key as well as the device key. The
  relay writes the record only when the platform or the token changed.
- `DELETE /v1/push-token` (new, either key) → 204, `setPush(id, null)`.
- `GET /v1/push-token` (new, either key) → `{ registered: boolean,
  sender: boolean }`: whether the relay holds a token for this device, and
  whether it has a sender for that token's platform. The token is never
  echoed.

The app:

- sends its token right after an enrollment finishes (console enrollment,
  an invite another phone approved, pairing with the front door), with the
  read key, in the same flow;
- sends it from `KlMessagingService.onNewToken` at once, in the background,
  when the phone is enrolled (the read key needs no prompt, so a rotation no
  longer waits for the next foreground); not yet enrolled, it only stores
  it;
- sends it again at every cold start, changed or not (C-10): the relay may
  have dropped it (an `UNREGISTERED` answer, a lost `devices.json`, a
  re-pinned relay), and with the read key the call costs nothing;
- on `Reset this phone`, calls `DELETE /v1/push-token` before deleting its
  keys (best effort), then deletes the stored token too.

Drop on rejection, on the relay: an FCM `404 UNREGISTERED` drops the token
as today, and so does a `403` whose error is `SENDER_ID_MISMATCH` (a token
from another Firebase project: the owner rebuilt the app against a new one)
(C-11). A `400` is never a reason to drop: it is as likely to be the
relay's own malformed message. The next cold start or `onNewToken`
registers a working token again.

The gear screen (spec 2 R2d) gains one row, from `GET /v1/push-token` and
the phone's own state: "Notifications: on"; "off in Android settings" (with
a button to the app's notification settings); "this build has no push"
(`nopush`, or `fcm` without a Firebase config); "the relay has no push
credential" (`sender: false`); "not registered yet".

If spec 2 does not put the push-token routes on the read key, the app keeps
today's rule (send after an enrollment or a check that got through, with
the device key) and a rotation waits for the next foreground; nothing else
in this spec changes.

## 8. The relay's credential (R-PU-1)

- The FCM credential is a Google service-account JSON key of the owner's
  Firebase project, at the absolute path `relay.push.fcm.service_account_file`
  names, on the relay host only. On the front door (Linux, unit user
  `king-louie`): `/etc/king-louie/push/fcm-service-account.json`, owner
  `root`, group `king-louie`, mode `0640`, in a directory `0750` with the
  same owner and group (C-12). The service reads it; nothing in King Louie
  writes, copies or logs it, and it is not in the data dir, so no import,
  backup or `doctor` output carries it.
- The account is a dedicated one with the single role "Firebase Cloud
  Messaging API Admin" (`roles/firebasecloudmessaging.admin`), not the
  project's default `firebase-adminsdk` account, which holds far more
  (C-13). Whoever holds the key can send pushes to tokens of that project
  and do nothing else in it.
- `parsePushConfig` refuses a relative `service_account_file`. At start the
  relay checks that the parsed file has `type: service_account` and string
  `project_id`, `client_email` and `private_key`, and refuses to start
  naming the missing key and the path, never the contents (today a missing
  field fails later, at the first push). A missing or unreadable file
  refuses the start, as today.
- `doctor` on the front door (and on a `relay run` host) gains a `push` row:
  which senders are configured; that the file is there, owned and moded as
  above (POSIX) and parses; its `project_id`; and the last FCM result the
  running service recorded in `<dataDir>/relay/push-status.json` (the time
  and HTTP status of the last send and of the last failure, no token, no
  device id). No push configured is `push: none (the app checks only while
  open)`, which is not a failure.

## 9. A test push (C-14)

`king-louie-service relay push-test [--device <device-id>]`, as root on the
relay host (it reads the key), with the service running or not: it reads
`relay.push` and `<dataDir>/relay/devices.json` read-only and sends one
`test` push (a random `rid`, `n` the relay's own node name) through the same
`createFcmSender` to each device with an `fcm` token, or to the named one,
printing for each its id, its name and `sent` or the HTTP status. It never
prints a token. It is the last step of §10, and the way to tell "no
credential" from "no token" from "Android blocked notifications".

## 10. The owner's setup, end to end

The values below are invented; put your own in their place. iOS needs
nothing here and is not affected.

**A. Firebase (once, in a browser, signed in to the Google account that will
own the project).**

1. In the Firebase console, add a project, for example `kl-example-push`.
   Google Analytics is not needed; leave it off.
2. In that project, add an Android app. Its package name must be exactly the
   `kl.applicationId` in `mobile/android/local.properties` (the example's
   `com.example.kinglouie`; yours is your own). Nickname and SHA-1 are
   optional. Download `google-services.json`.
3. In Project settings > Cloud Messaging, check that "Firebase Cloud
   Messaging API (V1)" is enabled (it is on a new project).
4. In the Google Cloud console for the same project, IAM & Admin > Service
   accounts, create one named `kl-push`
   (`kl-push@kl-example-push.iam.gserviceaccount.com`) with the role
   "Firebase Cloud Messaging API Admin" and nothing else. Under its Keys,
   add a JSON key and download it. (A Google Workspace organisation may
   forbid key creation with the policy
   `iam.disableServiceAccountKeyCreation`; a personal Google account has no
   such policy.)

**B. The relay host (the front door, as root).**

5. Copy the key file to the host directly (`scp`), never through a chat or
   a shared folder, then put it in place and remove the copy:

   ```sh
   install -d -o root -g king-louie -m 0750 /etc/king-louie/push
   install -o root -g king-louie -m 0640 kl-push.json /etc/king-louie/push/fcm-service-account.json
   rm kl-push.json
   ```

6. Add the push block to `/etc/king-louie/service.json` (on the front door
   the `relay` block holds only `push`; on a `relay run` host, add `push`
   to the `relay` block that is there):

   ```json
   "relay": { "push": { "fcm": { "service_account_file": "/etc/king-louie/push/fcm-service-account.json" } } }
   ```

7. `systemctl restart king-louie.service`, then `king-louie-service doctor`:
   the `push` row says `fcm` and the project id.

**C. The app (on the machine that builds it).**

8. Put `google-services.json` at `mobile/android/app/src/fcm/`. It is
   ignored by git; `git status` must not list it.
9. From `mobile/android`, build and install the `fcm` flavor:
   `./gradlew :app:installFcmRelease` (or pick the `fcmDebug` variant in
   Android Studio).
10. Open the app and allow notifications when Android asks. If you said no,
    the gear screen's Notifications row opens the setting.
11. Enroll the phone (enrollment sends the token), or, for a phone already
    enrolled, just open the app (the cold start sends it). The gear screen
    says "Notifications: on".

**D. Check.**

12. On the relay host: `king-louie-service relay push-test`. The phone shows
    "Test notification from frontdoor", and the command prints `sent` for it.
13. Optional, end to end: have the node ask for an approval (an unsafe
    runbook over `mcp`), with the phone locked; "Approval needed on <node>"
    appears, and a tap opens its detail with no fingerprint prompt.

Rotating the key: add a new key to `kl-push` (step 4), replace the file
(step 5), restart, then delete the old key in the Cloud console. A new
Firebase project means a new `google-services.json`, a rebuild and new
tokens; the old ones are dropped at their first `SENDER_ID_MISMATCH`.

## 11. Privacy

What Google sees, per push: the device's FCM token, the Firebase project,
the time, and the data fields `k`, `rid`, `n`, `c`. From them it learns how
often each node asks for something, when a session there ended or paused,
and the node's name. It never sees an action, a parameter, a question's
text, an app, a site, a take's name or a reason. An owner who would rather
Google not see machine names gives the nodes neutral ones (`n` is the name
a node was paired under).

What the relay operator sees beyond today: which device ended which lease
(`except_device`; the revoke envelope already showed it), and that a lease
paused (its signed status already said `no_contact`). Push tokens were
already listed.

Whoever holds the service-account key can send these content-free
notifications to the project's tokens it knows. A forged push opens the app
on a list or a detail that is fetched and verified, so it can mislead the
owner into opening the app, never into approving anything.

`mobile/PRIVACY.md` changes:

- "What the app keeps on the phone": "The push token, when push is
  configured. Reset this phone asks the relay to forget it and deletes it."
- "Push": "a push carries only a kind and a request id" becomes "a push
  carries only a kind, an id (of the request, or of the computer-use
  session it is about), the node's name and, when several things arrive
  within ten seconds, how many". Add the new kinds in words: "a computer-use
  session or take ended, unless you stopped it from this phone"; "a
  computer-use session paused because no phone was watching". Replace "On
  Android a computer-use push only opens the app: the request is fetched
  when you tap ..." with: a tap fetches with the phone's read key, without a
  fingerprint, and shows only what the node signed.
- "Google (FCM) sees only the data fields": add "the kind, the id, the
  node's name and a count; from them, when your nodes ask for something and
  when a session ended or paused".
- "What the relay operator can see": add "which of your phones stopped a
  computer-use session, so that phone is not notified of its own Stop".

## 12. The author's calls (for the owner to check)

- C-1: the two new triggers originate on the node and reach the relay
  through a new link method, `push.notify`, not by the relay reading
  statuses (§6.2): the node knows who stopped a lease from the envelope it
  verified, and the restart case has no status.
- C-2: every new behaviour (the new kinds, `test`, `c`, coalescing, the
  dedupe windows) applies to `fcm` devices only, so iOS is untouched in
  behaviour as well as in code.
- C-3: only a lease that ran (`granted_by` set) pushes on ending; a request
  that expired or was denied before it ran does not push again.
- C-4: a contact pause is pushed to the granting phone only; other phones
  can stop the lease but not resume it.
- C-5: dedupe on the node by transition and on the relay by
  `(node, kind, id)` with per-kind windows: 24 h, 2 min for a pause, 10 min
  for Approvals (§6.3).
- C-6: a 10-second coalescing window per device carrying a count, a cap of
  60 pushes per device per hour (§6.4), and on the phone one replaced
  notification for all Approval kinds with a running count.
- C-7: `session_ended` lives one hour in FCM while the phone is offline; a
  pause lives until the lease's own expiry.
- C-8: endings and pauses go on a second channel, `sessions`, so the owner
  can quiet them in Android's settings without quieting Approvals.
- C-9: the push-token routes accept the read key and gain `DELETE` and a
  `GET` that says whether the relay can send at all (§7.3). A thief with
  the unlocked phone could point the hints elsewhere; they carry nothing
  the unlocked app does not already show.
- C-10: the app re-registers its token at every cold start.
- C-11: `SENDER_ID_MISMATCH` drops a token as `UNREGISTERED` does; a `400`
  never does.
- C-12: the key lives in `/etc/king-louie/push/`, `root:king-louie`, `0640`,
  on the front door, outside the data dir; `doctor` checks owner and mode.
- C-13: a dedicated service account with only the FCM role, never the
  Admin SDK default account.
- C-14: `relay push-test` as the setup's last step (§9), and a `doctor` row
  backed by a small `push-status.json` holding no token and no device id.
- C-15: a test fails when `google-services.json`, `local.properties` or a
  `*service-account*.json` is tracked by git.
- C-16: a take's normal end (`take_done`, the driver's `Take.stop`) pushes
  like any other ending: R-PU-3 says any reason but a Stop from this phone,
  and an unattended take's end is what an owner away from the machine wants
  to know. Strike this and `take_done` joins the not-pushed list.

## 13. Owner rulings (2026-10-28)

- **R-PU-1.** Switch on what exists for Android: the `fcm` flavor, a
  Firebase project the owner owns, `google-services.json` untracked and
  documented, the relay's `relay.push` block with the FCM service-account
  key referenced as the relay already expects (§8, §10).
- **R-PU-2.** The payload stays content-free: kind, node name, at most a
  count. Never request text (§7.1).
- **R-PU-3.** Triggers: every new Approval the relay pushes today; a lease
  or take ending for any reason other than a Stop from this phone (expiry,
  `device_revoked`, `job_closed`, `driver_silent`, `recorder_failed`,
  `helper_lost`, `screen_locked`, `service_stopped`, `service_restarted`,
  a Stop from another phone); and a lease suspended `no_contact`. Not
  pushed: case progress, chat replies, grants, status churn (§6).
- **R-PU-4.** A notification tap opens the item's detail (spec 2); no
  Approve or Deny buttons on the notification (§7.2).
- **R-PU-5.** With spec 2's read key the app fetches after a tap without a
  biometric prompt; the push token is registered right after enrollment and
  re-sent when FCM rotates it (§7.3).

## 14. Docs to amend

- `docs/protocol/approval-v1.md`: §7's route table (`PUT /v1/push-token`
  with either key, the new `DELETE` and `GET`); §8 (§7.1's payload table,
  the new kinds for `fcm` devices only, `c`, coalescing, dedupe, `ttl`,
  `SENDER_ID_MISMATCH`). No vector changes.
- `docs/protocol/lease-v1.md` §4 table: a row for `push.notify` (node →
  relay), and one line under §2's contact rule saying a contact pause is
  pushed to the granting device and the ending of a granted lease to the
  other devices.
- `docs/fleet/front-door.md`: a new "Push notifications" section (§8's file,
  owner and mode, the `relay.push` block, `doctor`'s row, `relay push-test`,
  rotating the key), pointing to the install guide for the Firebase steps.
- `docs/install-guide.md`: a "Push to your phone" part in section 10 (stage
  3, the relay) holding §10's runbook; section 13 (personal node) points at
  it.
- `mobile/android/local.properties.example`: its push comment points at
  that part.
- `mobile/PRIVACY.md`: §11's lines.
- `CLAUDE.md`, "Approvals and relay": one bullet (push is the relay's
  `relay.push`; the two triggers and `push.notify`; `fcm` only; tests use a
  local FCM server). "Session helper", the phones' bullet: drop "a lease push
  there fetches nothing (R-F5-6)".
- `CONTEXT.md`: a **Push** entry: "A content-free hint from the relay to a
  paired phone that something waits or changed; never an Approval itself
  and never its content. _Avoid_: notification (for the message on the
  wire), alert (a front-door Approval kind)."
- `tests/fixtures/egress-inventory.json`: only if its walk sees the new CLI
  command or `push/jwt.js` (it lists `push/apns.js` today); the label is
  `transport`, "a content-free hint to the owner's phone; not a model call".

## 15. Residuals

- A computer-use lease (not a take) alive at a crash sends no
  `session_ended`: nothing recorded it. The phone's next list drops its row.
  A take is covered by its record.
- An ending queued while the relay link is down for more than an hour is
  never pushed; the phone learns it from its next list.
- The relay's dedupe set is in memory; a relay restart inside a window can
  repeat one push.
- Android may delay or drop high-priority messages for an app the owner
  restricted (battery "Restricted"); a phone in deep Doze gets them late.
  Nothing on the relay can tell.
- A push is a hint: a relay that drops it, or a Google outage, costs the
  owner the notification, never an approval; Approvals still expire closed.
- After `Reset this phone` with the relay unreachable, the relay keeps
  sending hints to that phone until it is revoked.
- Whoever holds the read key (the unlocked phone) can re-point or delete the
  push token (C-9).
- Whoever holds the service-account key can send misleading content-free
  notifications to known tokens (§11).
- `n` is the name a node was paired under, and Google sees it.
- iOS gets none of this; an iPhone enrolled on the same node keeps today's
  kinds and behaviour.

## 16. Test plan

Unit, no network (`node --test`):

- `tests/frontdoor-push.test.js`, extended against its local FCM server: the
  new kinds and `c` in the data; `ttl` per kind; `SENDER_ID_MISMATCH` drops a
  token and a `400` does not; the dedupe windows per kind on a fake clock;
  the 10-second coalescing (the first at once, the rest as one with `c` and
  the newest `rid`); the hourly cap; new kinds never reach an `apns` device,
  and an `apns` device's pushes are byte for byte today's; no token in any
  log line (capture the logger).
- `tests/frontdoor-relay.test.js` (or a new
  `tests/frontdoor-push-notify.test.js`): `push.notify` validation
  (`bad_push` for each bad field, both device fields set), its targets
  (`to_device`, `except_device`, only devices active on that node, only
  `fcm`), nothing in the mailbox.
- `tests/frontdoor-phone-routes.test.js`: `PUT` with the read key, `DELETE`,
  `GET` with and without a sender; `setPush` writes nothing when unchanged.
- `tests/gui-leases.test.js`, with a fake relay that records link calls: an
  expiry pushes `session_ended` once with no `except_device`; a revoke from
  device B gives `except_device` B, and a resume deny likewise; an expired
  request and a first-request deny push nothing; a replayed revoke and a
  `lease.list` push nothing more; a contact lapse pushes `session_paused` to
  the granting device only, once per transition, and a takeover by another
  reason does not; an unattended take never pauses, so never pushes it; the
  queue sends on `connected`, drops entries over an hour old, holds 32; an
  unknown-method answer is logged once.
- `tests/gui-takes.test.js`: a take ending `driver_silent` gives one push; a
  start after `markLiveEnded` queues one per granted take record; `stop()`
  waits for the queue, at most 2 s.
- `tests/frontdoor-config.test.js` and `tests/frontdoor-doctor.test.js`: a
  relative path refused; the service-account shape check at start (each
  missing field named, the contents never printed); the `push` doctor row
  (none, configured, wrong owner or mode on POSIX, the last status).
- `tests/service-cli-relay.test.js`: `relay push-test` against the local FCM
  server, a named device and an unknown one, no token printed.
- The tracked-secrets test (C-15), over `git ls-files`.
- `tests/mobile-lease-apps.test.js`, reading the Kotlin sources as it does
  for the lease rules: `Push.kt`'s accepted kinds equal the relay's `fcm`
  kinds; no `addAction` in `Push.kt` (R-PU-4); `openPushed` handles every
  kind; `onNewToken` sends when enrolled; reset calls the `DELETE`.

Not testable here, checked by hand once on the owner's phone (§10 steps 12
and 13, and): a real FCM delivery with the phone locked and in Doze; the
Android notification permission prompt, and the gear row when it is
refused; a tap on each kind landing on the right screen with no fingerprint
prompt; a token rotation (reinstall the app, or clear Google Play services'
data) reaching the relay without opening the app; `SENDER_ID_MISMATCH` after
switching Firebase projects; the `google-services` plugin build with a real
file. Swift is neither built nor run.

## 17. What is left to the builder

- Whether `push.notify` sits in `src/frontdoor/node-methods.js` beside
  `message.submit` or in the lease relay extension
  (`src/gui/relay-extension.js`, which registers phone routes, not node
  methods, today); the relay-graph rule in
  `tests/service-profile-graph.test.js` decides.
- The exact read-key auth on the push-token routes, once spec 2 fixes the
  scheme.
- Where `push-status.json` is written from (the pusher, at most once a
  minute) so a burst does not rewrite it per push.
- The coalescing timer is unref'd on the relay, and a relay `stop()` either
  sends or drops what a window holds (dropping is acceptable; the code says
  which).
