---
id: T13
title: Protocol docs, glossary, privacy, CLAUDE.md, guides
status: done (merge 487109b7)
blocked_by: [T04, T06, T12]
---
## Goal
The documentation follows the code.

## Spec sections
§14, §8.9's docs bullet.

## Files
`docs/protocol/approval-v1.md` ("Revised 2026-10-28: the read key"),
`docs/protocol/lease-v1.md`, `docs/protocol/client-grant-v1.md` §7's route
table, `CONTEXT.md` (Device key, Read key), `mobile/PRIVACY.md`, `CLAUDE.md`
("Session helper" phones bullet; "Approvals and relay" counts 49 and 55),
`docs/fleet/front-door.md`, `docs/install-guide.md`.

## Acceptance
Every test that reads these docs passes (grep `tests/` for the doc names); the
vector counts in CLAUDE.md match `--check`.
