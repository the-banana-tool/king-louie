---
id: T10
title: Android - Push.kt kinds, channels, running count, icon, taps
status: open
blocked_by: []
---
## Goal
`Push.kt` (fcm) accepts the eight kinds and ignores others; approval kinds share one replaced notification (channel `approvals`, tag `approvals`) with a running count reset when the app comes to the front; `session_ended`/`session_paused` on channel `sessions` (default importance) tagged `ended:<rid>`/`paused:<rid>`; `test` on `approvals`; the small icon is the monochrome banana vector; `n` keeps spaces (letters, digits, spaces, `._-`, trimmed, 40). No action buttons. A paused notification is cancelled when the app next applies a signed non-`suspended` status of that lease. A tap with a count above 1 (or `test`) opens the list.

## Spec sections
§7.2, R-PU-4, C-6 (phone half), C-8. Ledger R2, R4.

## Files
- `mobile/android/app/src/fcm/kotlin/com/example/kinglouie/push/Push.kt`, the nopush `Push.kt` (constants and no-op hooks the main code calls)
- `mobile/android/app/src/main/kotlin/com/example/kinglouie/MainActivity.kt` (count extra on the intent)
- `AppModel.kt` (`openPushed` count > 1 -> list; reset the count on foreground; cancel the paused notification on a non-suspended status), narrow edits
- icon: reuse the existing monochrome vector under `mobile/android/app/src/main/res/` (do not edit icon bitmaps; `tests/icons.test.js`)
- `tests/mobile-lease-apps.test.js` (or a new `tests/mobile-android-push.test.js`): reads Kotlin sources: accepted kinds equal the relay's fcm kinds (read `src/frontdoor/push/text.js` KINDS minus `grant`; if T01 has not merged yet, hard-code the eight and note it), no `addAction` in Push.kt, `openPushed` handles every kind

## Acceptance
- Source tests pass; with `JAVA_HOME` at JDK 17, `./gradlew :app:assembleNopushDebug :app:assembleFcmDebug` from `mobile/android` exits 0 (copy `local.properties` from the main checkout first). No Firebase config file added.
