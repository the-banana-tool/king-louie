---
id: T11
title: Android - token every cold start, DELETE on reset, gear Notifications row
status: done
merged: bf41dbb7
blocked_by: [T10]
---
## Goal
The app re-sends its token at every cold start (changed or not), right after an enrollment finishes, and from `onNewToken` when enrolled; `Reset this phone` calls `DELETE /v1/push-token` (best effort) before deleting keys, then deletes the stored token; the gear screen gains a Notifications row from `GET /v1/push-token` and the phone's state: "Notifications: on", "off in Android settings" (button to the app's notification settings), "this build has no push", "the relay has no push credential", "not registered yet".

## Spec sections
§7.3 (app half), C-10, R-PU-5. Ledger R3.

## Files
- `RelayApi.kt` (`deletePushToken`, `pushTokenState`, on READ)
- `AppModel.kt` (sendPushToken / cold start / enrollment paths / reset)
- `SettingsScreen.kt`, `Storage.kt`, `Push.kt` both flavors (whether a Firebase app exists: `fcm` without config reports "no push")
- the push source test from T10: `onNewToken` sends when enrolled; reset calls the DELETE; `tests/mobile-android-relay-keys.test.js` keeps passing (every RelayApi call matches `ROUTE_AUTH`, which T04 extends)

## Acceptance
- Source tests pass; both flavors build (as T10).
