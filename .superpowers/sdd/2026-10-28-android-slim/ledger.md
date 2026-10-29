# Ledger: android-slim (spec docs/superpowers/specs/2026-10-28-android-app-slim-design.md)

Integration branch `feat/android-slim`, worktree
`C:\Users\sblac\Programming\king-louie-wt\android-slim`, base `main` at 6af6a003.

## Environment facts (checked 2026-10-28)
- JDK 17: `C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot` (not on
  PATH; set `JAVA_HOME`).
- Android SDK present (`%LOCALAPPDATA%/Android/Sdk`). `mobile/android/local.properties`
  is git-ignored: copy it from the main checkout into each worktree.
- Baseline: `../gradlew test` in `mobile/android/protocol` passes; the app module
  BUILDS here: `./gradlew :app:assembleNopushDebug :app:assembleFcmDebug` from
  `mobile/android` (exit 0, both APKs). So every Android ticket must keep the app
  building, not only the protocol tests.
- The `mattpocock-skills:implement-spec` skill cannot be invoked by a model
  (disable-model-invocation); the orchestrator follows the brief's own
  procedure (tickets, worktrees, per-ticket implementers, mergers, one review).

## Task graph
T01 -> T02, T03, T05; T02+T03 -> T04; T02+T05 -> T06; T06 -> T07 -> T10;
T08 + T10 -> T11; T09 + T11 -> T12; T04 + T06 + T12 -> T13.
Start frontier: T01, T08, T09.

## Decisions and deviations
- Implementer branches are `feat/android-slim-TNN` (hyphen): git cannot make a ref
  under `feat/android-slim/` while `feat/android-slim` exists.
- T01: `verifyDeviceEnvelope` also refuses a published test key as a record's
  `read_key` (`test_key`), and `verifyConsoleEnrollment` refuses one as
  `device.read_key`; that bites once T06 adds `A_read`/`B_read` to
  `src/approvals/test-keys.js` `TEST_DEVICE_KEYS` (T06 must).
- T08 choices: a no-contact lease this phone granted is titled "Paused: open to let
  it continue (<node>)"; "Not checked yet" rows sit after "Could not confirm" in
  group 2; Review for `limits` applies to takes too; an alert with no `id` gets no
  row.
- T09: `StatusColors` still carries `demoContainer`/`onDemoContainer` (Screens.kt)
  and `alertContainer`/`onAlertContainer` (LeaseScreens.kt), built from tokens and
  marked to go: T11/T12 remove them. `MainActivity` now calls `enableEdgeToEdge`
  with dark bars; on target SDK 37 the screens must paint `bgSidebarHdr` behind
  the bars (T12). No `todo` left in the drift test.

- T02: approver records gain `read_key_at` (not in the spec) so `stale` has a
  date to compare; a record with `read_key` and no `read_key_at` dates from
  `enrolled_at`. Node method `device.read_key` answers `{ state:
  'read-key-pending-apply' | 'duplicate' | 'rejected', reason }`; audit
  `device.read_key_set` on apply. Front door's own `node-methods.js`/`routes.js`
  know only enroll/revoke states: T04 handles `read-key-pending-apply`.
- T03: an unknown `X-KL-Key` value is `401 bad_key` (code not in the spec).
  Registry: `read_jwk`, `read_key_created_at`, `setReadKey(id, jwk, createdAt)`
  -> `{ record, updated }`. fake-phone: `phone.readJwk`, `readSigner`,
  `signApi(..., { key, signWith, header })`, `signReadApi`.

- T04: read-key route refusal codes are the implementer's (`bad_read_key`,
  `expired`, `from_the_future`, `forbidden`, `malformed`); a node answer other
  than the three states (incl. an older node) is reported `offline`; statements
  are not written to the relay device log (the phone's re-send covers offline
  nodes). The invite claim accepts an optional `read_key`. §8.4 table is
  `ROUTE_AUTH` exported from `tests/frontdoor-phone-routes.test.js`.
  fake-phone: `device({ readKey })`, `readKeyStatement(...)`, `approverRecord({ readKey })`.
- T05: only `verifyLeaseWatch` has `allowReadKey: true` (sweep has a static
  check); audit `lease.watch` carries `key`.

- T06: `A_read`/`B_read` in `TEST_DEVICE_KEYS` (`read_key: true`), keys.json
  entries `{ d, jwk, read_key_of, fingerprint }`; added expectation fields
  (`read_key`, `staged_read_keys`, `accepted_by_device_key: false`, `key: 'read'`);
  `watch-read-key` proves acceptance, not contact (contact needs the manager's
  tokens; gui-leases covers it). Kotlin `readKeyVectors` sets list the four
  Android vectors, run by T07: `phone-api-auth-read`, `enroll-console-read-key`,
  `read-key-valid`, `watch-read-key`.

- T07: Kotlin API `PhoneKey { DEVICE, READ }` (`header`, `prefix`),
  `Messages.phoneAuthString(..., key)`, `phoneReadAuthString`, `jwk(x, y)`,
  `device(..., readKey)`, `readKeyStatement(...)`, `readKeyFingerprint(...)`,
  `validate("kl.device.read_key")`. Deviation: `readKeyFingerprint` is in
  `Messages`, not beside the device id in `Encoding.kt` (which §12 keeps
  unchanged). A read-key watch is today's `Leases.watch(...)` signed by the read key.

- T10: RelayApi read routes fall back to the device key when the phone has no
  read key (pre-change phones until §8.7 set-up); device routes never use the
  read key; a device-signed request sends no `X-KL-Key`. `ReadKey.create()`
  failing inside `DeviceKey.create()` keeps the device key (the phone then gets
  the §8.7 set-up row). `auditStatus` removed with `history`. `deviceJson` now
  carries `read_key` (enrollments, §8.2). The watch envelope is still signed by
  the device key (T11 switches it to the read key). New test
  `tests/mobile-android-relay-keys.test.js` checks every RelayApi call against
  `ROUTE_AUTH`.
- T13 was started and merged before its blocker T12 (orchestrator's call: its
  files are disjoint; the Android wording follows the spec). If T11/T12 deviate
  in words, CLAUDE.md's phones bullet, PRIVACY.md and front-door.md need a
  follow-up. T13's commit carries a `Co-Authored-By: Claude Opus 5.5` line
  instead of the brief's Fable 5.1 (the implementer followed the system
  attribution reminder).

- T11: `lifecycle-process:2.10.0` added; `AppMode { WELCOME, LIVE }`;
  `DemoFleet` in protocol test sources. `verifiedClaim` now accepts a joining
  phone's `read_key`. `refreshLeases` is private, called by the loop and by
  notifications; a failure marks every node "could not confirm". A node's
  read-key state is partly inferred (`duplicate` on first post = in use; an
  accepted read-key watch = in use; `bad_signature` = waiting for apply). A
  pre-read-key relay answers the loop's read requests 401 and the loop waits 15
  s; only the set-up route's 404 shows the "older relay" message. A notification
  arriving (not tapped) does not trigger a fetch: `Push.kt` is spec 3's. Invite
  polling needs the read key set up first. `READ_KEY_SETUP_TITLE` contains
  "Check for requests" (spec words), so T12's string check must allow it.
  `alertContainer`/`onAlertContainer` remain for T12 to remove.

- T12: a detail whose item leaves its store closes itself (so a confirmed
  decision returns to the list); detail buttons do not close the detail on tap;
  a lease request row's approve button reads "Allow"; an approved tool approval's
  decided row has the `successBg` tint. The slim test reads `ROUTE_AUTH` as text
  (requiring the routes test file would rerun it) and lists
  `POST /v1/devices/read-key` as `read` (the relay accepts either key; comment
  says the first send is device-signed). T10's relay-keys test kept. CLAUDE.md and
  front-door.md wording adjusted to the built screens.

## Landed
- T01 merge 932753aa (impl d2d4cc64): `isDevice` export, `kl.device.read_key`
  validator, `phoneAuthString(..., { key })`, `PHONE_AUTH_PREFIXES`,
  `READ_KEY_MAX_MS`, `readKeyFingerprint`; `verifyDeviceEnvelope({ allowReadKey })`
  returns `key`.
- T08 merge 2f4eabab (impl 99480a93): `ApprovalList.build(Input): Result`.
- T09 merge f69f686f (impl ce77ea4d): `KlTokens`, dark theme, Ui, drift test.

- T02 merge 8814398e (impl 8e6ff78b).
- T03 merge 572bc8b0 (impl e56dc31e).

- T04 merge 8a439abf (impl fe5168d0).
- T05 merge 68bb365f (impl 9ac40699).

- T06 merge 8356ae42 (impl 1952223a): approval-v1 49, lease-v1 55.

- T07 merge aede376d (impl 85d2ad79).

- T10 merge 980e08ca (impl 729926e8).
- T13 merge 487109b7 (impl d6f790a1).

- T11 merge e8aae588 (impl 255b2f4a).

- T12 merge 45b82029 (impl 6b195580).

## Left
The code review and its fixes; `npm test`; the gradle runs once more.
