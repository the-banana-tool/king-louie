---
id: T12
title: The four screens
status: done (merge 45b82029)
blocked_by: [T09, T11]
---
## Goal
Scanner, Approvals, Approval detail, Settings; everything else removed.

## Spec sections
§6 (all), §7.2's row UI (overflow through `onTextLayout`), §7.5, §7.6 (UI: one
`DisposableEffect` starts and stops the live loop; the words), §12's table,
§12.1, R-AN-2, R-AN-3, R-AN-4, C-10, C-12 to C-15.

## Files
`Screens.kt` (rewritten), new `DetailScreens.kt`, `ScannerScreen.kt`,
`SettingsScreen.kt`, `LeaseScreens.kt` (rewritten per §12), delete
`FrontDoorScreens.kt` and the app's `Questions.kt`, `res/drawable/ic_scan.xml`,
`MainActivity.kt` if needed. Tests: finish `tests/mobile-lease-apps.test.js`
(§12.1), new `tests/mobile-android-slim.test.js` (its §8.4 table copy equals
T04's relay test table), lift any `todo` T09 left in
`tests/mobile-design-tokens.test.js`.

## Acceptance
The app builds (`./gradlew :app:assembleNopushDebug :app:assembleFcmDebug`, JDK 17); the three node tests pass; the protocol tests
pass.
