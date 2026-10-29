---
id: T09
title: Takes - restart endings push; gui.stop waits for the queue
status: open
blocked_by: [T08]
---
## Goal
After `markLiveEnded('service_restarted')` at start, `TakeManager` queues one `session_ended` per ended take whose record has `lease_id` and `grant`; `gui.stop()` waits for the push queue to drain, at most 2 s, before the link closes.

## Spec sections
§5.3 last two bullets, §6.2 node bullets 2 and 5, C-16.

## Files
- `src/gui/takes.js`, `src/gui/take-store.js` (markLiveEnded returns what it ended, if it does not already)
- `src/gui/index.js` (stop order: leases end `service_stopped`, then drain <= 2 s)
- `tests/gui-takes.test.js`

## Acceptance (spec §16 gui-takes bullet)
- A take ending `driver_silent` gives one push.
- A start after `markLiveEnded` queues one per granted take record, none for an ungranted one.
- `stop()` waits for the queue, at most 2 s (fake timers; a ref'd timer kept alive across waits per CLAUDE.md Testing).
- Covering tests pass.
