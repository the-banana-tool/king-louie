---
id: T11
title: AppModel - foreground loop, per-kind stores, read-key set-up, notification routing; demo and history go
status: done (merge e8aae588)
blocked_by: [T08, T10]
---
## Goal
The model behind the four screens.

## Spec sections
§7.6 (the live view's model side: the views long poll, a watch every 20 s with
the early-watch rule, the device-key fallback watch only from its button),
§8.7 (the set-up row, keeping the statement, re-posting to `offline` nodes at
loop start, the older-relay 404 message), §9, §10, §13, §12 (the AppModel row
and the protocol AppCore and DemoFleet row), C-7, C-8, C-9, C-17, C-18, C-19.

## Files
`AppModel.kt` (`ForegroundLoop` started and cancelled from
`ProcessLifecycleOwner` ON_START and ON_STOP; stores replaced whole per fetch;
`ApprovalList.build` feeds the list; the section between `// ---- Leases (fleet
stage 5) ----` and a new `// ---- Leases: end ----` keeps its functions apart
from the key each signs with); `protocol/AppCore.kt` (drop `AppMode.DEMO`);
`DemoFleet` to `protocol/src/test/`; `MainActivity.kt` (`openPushed` routing);
`KingLouieApplication.kt` if the lifecycle wiring lives there;
`app/build.gradle.kts` if `lifecycle-process` is needed. Update
`tests/mobile-lease-apps.test.js` per §12.1 for the model-side rules. Keep the
old screens compiling with minimal stubs where removed functions were used
(T12 rewrites them).

## Acceptance
The protocol tests pass; the app compiles if buildable;
`node --test tests/mobile-lease-apps.test.js` passes with §12.1's rules for
the model.
