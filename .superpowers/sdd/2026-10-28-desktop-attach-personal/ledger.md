# Ledger: desktop attached to the personal node

Spec: docs/superpowers/specs/2026-10-28-desktop-attached-to-personal-node-design.md
Integration branch: feat/desktop-attach-personal (worktree
C:\Users\sblac\Programming\king-louie-wt\desktop-attach-personal), base main 6af6a003.

## Task graph
- Frontier 1 (parallel): T01, T03, T04, T05, T08, T09
- T02 after T01; T06 after T01+T02; T07 after T06; T10 last.

## Decisions
- The `mattpocock-skills:implement-spec` skill cannot be invoked by an agent
  (disable-model-invocation); the orchestrator brief's own workflow is followed.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (the harness attribution; the agents run on Opus 5.5).

## Landed

## Deviations

## Unconfirmed on a real machine (spec §15)
- /Run → handshake time with an owner-sized history store (60 s kept, unmeasured).
- app.asar + ELECTRON_RUN_AS_NODE running `bin/king-louie-service.js run`.
- `schtasks /Query /XML ONE` on Windows 11 Home.
- Where startAttached hands over to the client's reconnect loop; whether getPort's
  trust read should skip the four-path read during a start wait.
