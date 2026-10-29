# Ledger: push (spec docs/superpowers/specs/2026-10-28-push-notifications-design.md)

Integration branch `feat/push`, worktree
`C:\Users\sblac\Programming\king-louie-wt\push`, base `feat/android-slim` at
863a61ad (spec 2 built there; its ledger is
`.superpowers/sdd/2026-10-28-android-slim/ledger.md`).

## Environment facts (checked 2026-10-29)
- JDK 17: `C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot` (set
  `JAVA_HOME`; not on PATH). Android SDK present; copy
  `mobile/android/local.properties` from the main checkout into each worktree
  (git-ignored). Build both flavors from `mobile/android`:
  `./gradlew :app:assembleNopushDebug :app:assembleFcmDebug`.
- The fcm flavor builds with no `google-services.json`: `app/build.gradle.kts`
  applies the google-services plugin only when `app/src/fcm/google-services.json`
  exists, and `Push.register` returns quietly without a Firebase app. No
  placeholder file is needed or added; none may ever be tracked.
- The `mattpocock-skills:implement-spec` skill cannot be invoked by a model
  (disable-model-invocation); the orchestrator follows the brief's own
  procedure (tickets, worktrees, per-ticket implementers, mergers, one review).
- Implementer branches are `feat/push-TNN` (hyphen): git cannot make
  `feat/push/TNN` while `feat/push` exists.
- Commit attribution: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (the owner's prompt overrides the brief's Fable line).

- A PreToolUse Bash hook (one-shot-prompting plugin) refuses any shell command
  whose text names credential files (e.g. the Firebase config file name or a
  service-account key name), "Do not commit .env files or credentials". Write
  such text with the Write/Edit tools, and keep those words out of commit
  messages and shell command lines.

## Reconciliation with what spec 2 built (spec 3 was written before it)
- R1 (§7.3, C-9): spec 2 already put `PUT /v1/push-token` on `auth: 'read'`
  (`src/frontdoor/routes.js`, a documented §8.4 exception). The spec's fallback
  paragraph ("if spec 2 does not put the push-token routes on the read key")
  does not apply. New `DELETE` and `GET` register with `auth: 'read'` too.
- R2 (§7.2): spec 2's `AppModel.openPushed` already handles `session_paused`
  and `session_ended` (`pushedLease`, including "<node> no longer has this
  session; it is not running" from a confirmed listing), and any other kind
  (`test`) opens the list. What is left: a count above 1 opens the list.
- R3 (§7.3): spec 2's `registerPushToken` already sends at once when the read
  key is ready (so `onNewToken` in the background works) with `RelayApi.pushToken`
  on `READ`. What is left: re-send at every cold start even when unchanged
  (today: once per token value via `pushTokenSent`), DELETE on reset, the GET
  for the gear row.
- R4 (§7.2): spec 2's fcm `onMessageReceived` already calls
  `model.onNotificationArrived()` (a foreground fetch); keep it.
- R5 (§14 CLAUDE.md): R-F5-6 for Android is already replaced in CLAUDE.md's
  phones bullet by spec 2 (R-AN-9); the docs ticket only checks no "fetches
  nothing" wording remains for Android.
- R6 (§7.2 "last four ended leases"): `LISTED_ENDED = 4` in `src/gui/leases.js`
  already.
- R7 (§4 vectors): spec 2 moved the counts: approval-v1 `--check` says 49 and
  lease-v1 55 (not 41/51 as §4 says). This spec changes no vector; the checks
  must still say 49 and 55.

## Task graph
T01 -> T02, T03, T07; T02 -> T06; T05 -> T06, T07; T08 -> T09; T10 -> T11;
T12 (docs) last, after all. Start frontier: T01, T04, T05, T08, T10.

## Decisions and deviations
- T01: `FCM_ONLY_KINDS` (text.js; `session_ended`, `session_paused`, `test`),
  `PUSH_KINDS` local to node-methods.js (today's six, for `message.submit`),
  `rejectsToken(status, text)` in fcm.js (404 UNREGISTERED, 403
  SENDER_ID_MISMATCH), `DEFAULT_TTL_S` 300, `SESSION_ENDED_TTL_S` 3600. The
  pusher's `notify` takes `count` (passed only to fcm); an FCM-only kind for a
  non-fcm device returns quietly. An out-of-range count is dropped, push still goes.
- T05: `readServiceAccountFile(file, { readFile })` + `REQUIRED_FIELDS` in
  `src/frontdoor/push/service-account.js`; codes `PUSH_CREDENTIAL_UNREADABLE`,
  `PUSH_CREDENTIAL_INVALID` (`err.field`); JSON parser messages never passed on.
  Only the FCM path must be absolute (APNs `key_file` unchanged).
- T04: `setPush` returns a boolean (wrote or not). New `pusher.platforms` (token
  platforms the senders reach) answers GET's `sender` (sender ids need not equal
  platforms). DELETE/GET need only an authenticated device, like PUT.
- T08: `LeaseManager#pushQueue` (`src/gui/push-queue.js`: `enqueue`, `drain({
  timeoutMs })`, `start`, `stop`, `size`; `PUSH_QUEUE_MAX` 32, `PUSH_MAX_AGE_MS`
  1 h); `_end(lease, reason, { endedBy })`; `RelayClient#pushNotify`,
  `push.notify` in `F3_METHODS`. A contact lapse that finds the lease's time up
  ends it `expired` and pushes only `session_ended`. A send failing because the
  link went down is re-queued; other errors dropped (debug, code only);
  `unknown_method` turns the queue off until next `connected`. The queue sends
  only through a link with `pushNotify` (the courier link has none; the service
  holds the real relay client).
- T10: `PushText` in the Android protocol module (words, tags, channels, count
  parsing, name cleaning, opens-the-list rule) with JUnit `PushTextTest`;
  `Push.NOTIFICATION_ID = 1` (tags tell notifications apart), count kept in
  SharedPreferences `kl.push`, `Push.EXTRA_COUNT` `"kl.c"`, `openPushed(kind, id,
  count)`, `AppModel.statusApplied`. Without a node name the words drop "on <n>".
  Coming to the front zeroes the count but leaves the shown notification.
  `test` uses tag `test:<rid>`.

## Landed
- T01 merge 96ea2586; T05 merge 168106f3; T04 merge 0d31340e; T08 merge
  3f35f05e; T10 merge 1203ea60 (tip bbf21a23). Both Android flavors build;
  protocol `gradlew test` 107 pass.

## Left
