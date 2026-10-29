---
id: T10
title: ReadKey.kt, DeviceKey.create makes both keys, RelayApi with two signers
status: open
blocked_by: [T07]
---
## Goal
The app holds a read key and signs each relay route with the key §8.4 names.

## Spec sections
§8.1, §8.3, §8.4, §8.7 (the `readKey` call), §9 (the presence call), §12
(`ReadKey.kt`, `DeviceKey.kt`, `RelayApi.kt`).

## Files
New `ReadKey.kt` (alias `kl.read-key`, StrongBox when available, no user
authentication, `setUnlockedDeviceRequired(true)`, not invalidated by a new
biometric enrollment; public JWK; fingerprint through the protocol helper);
`DeviceKey.kt` (`create` also makes the read key; deletion removes both);
`RelayApi.kt` (two signers, `X-KL-Key: read` with the read string, the key per
route, `presence(foreground)`, `readKey(statement, …)`, the push token on the
read key, `history` removed, the long-poll semaphore kept). Keep `AppModel.kt`
compiling with call-site edits only.

## Acceptance
The app builds (`./gradlew :app:assembleNopushDebug :app:assembleFcmDebug`, JDK 17); the protocol tests still pass; the
read key is used only by read routes, presence and the watch.
