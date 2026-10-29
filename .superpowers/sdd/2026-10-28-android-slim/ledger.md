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
(none yet)

## Landed
(none yet)

## Left
All tickets.
