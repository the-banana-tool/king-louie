---
id: T08
title: ApprovalList.build, the pure merge and order
status: done (merge 2f4eabab)
blocked_by: []
---
## Goal
One pure function in the protocol module turns the per-kind stores into rows:
kind, ids, host-built strings, buttons, order.

## Spec sections
§7.1 to §7.5, §10, C-11, C-12, C-18, C-20; §16 ApprovalListTest.

## Files
New `mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/ApprovalList.kt`,
new `protocol/src/test/.../ApprovalListTest.kt`. Reuse existing core types
(`Leases`, `Display.escape`, `FrontDoor.shownText`, the question and lease
request types); do not change `Lease.kt` or the other files §12 lists as
unchanged.

## Acceptance
The order of §7.4 over mixed stores; the row buttons of §7.2 and each
exception (overflow passed in as a flag); a briefing's Got it; decided rows
last; pinned lease rows from statuses and listings including "Could not
confirm" and "Not checked yet", and "Paused: open to let it continue" for a
no-contact lease this phone granted; no row for an ended lease; the empty
state's words (push on or off, no node paired); the footer "Checked <node> at
<time>" lines. `../gradlew test` passes.
