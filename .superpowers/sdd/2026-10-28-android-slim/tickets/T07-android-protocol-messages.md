---
id: T07
title: Android protocol module speaks the read key and consumes the new vectors
status: in-progress
blocked_by: [T06]
---
## Goal
`Messages.kt` gains the read auth string, the `device.read_key` member and
`kl.device.read_key`; the vector tests consume the new Android vectors.

## Spec sections
§8.1 (fingerprint), §8.2, §8.3, §8.7, §8.8, §12 (protocol module), §16
(ProtocolVectorTest, LeaseVectorTest).

## Files
`mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Messages.kt`
(and a read-key fingerprint helper beside the device-id one),
`protocol/src/test/.../ProtocolVectorTest.kt`, `LeaseVectorTest.kt`.

## Acceptance
`../gradlew test` in `mobile/android/protocol` (JAVA_HOME = JDK 17,
`C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot`) passes, including
the read string and signature vector, the enrollment payload with `read_key`,
the read-key statement, the read-key watch (the same message as `watch-valid`
signed with the read key). `Lease.kt`, `Display.kt`, `Envelope.kt`,
`FrontDoor.kt`, `Questions.kt`, `Encoding.kt`, `Ed25519.kt` unchanged.
