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

## Landed
- T01 merge 932753aa (impl d2d4cc64): `isDevice` export, `kl.device.read_key`
  validator, `phoneAuthString(..., { key })`, `PHONE_AUTH_PREFIXES`,
  `READ_KEY_MAX_MS`, `readKeyFingerprint`; `verifyDeviceEnvelope({ allowReadKey })`
  returns `key`.
- T08 merge 2f4eabab (impl 99480a93): `ApprovalList.build(Input): Result`.
- T09 merge f69f686f (impl ce77ea4d): `KlTokens`, dark theme, Ui, drift test.

- T02 merge 8814398e (impl 8e6ff78b).
- T03 merge 572bc8b0 (impl e56dc31e).

## Left
T04, T05 (in progress), T06, T07, T10, T11, T12, T13.
