---
id: T10
title: CLAUDE.md and install guide
status: open
blocked_by: [T01, T02, T03, T04, T05, T06, T07, T08, T09]
---
## Goal
Apply §13 to CLAUDE.md and docs/install-guide.md as landed (names as the code has
them). Invented values only.

## Spec sections
§13.

## Files
- CLAUDE.md, docs/install-guide.md

## Acceptance
`node --test tests/docs-driving.test.js tests/examples.test.js` and any docs test that
reads the install guide.
