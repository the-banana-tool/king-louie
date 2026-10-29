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
- T01 trust rule: merge f5d66043
- T03 desktop pair CLI personal, --json: merge 5b6c1ee9
- T04 import personal: merge 645d80fa
- T05 install --personal electron: merge 105d0f99
- T08 IPC channels/preload: merge 2c0c2474
- T09 pane model, renderer banner: merge 2fc8e743

## Deviations
- All tickets: branches are `feat/desktop-attach-personal-TNN` (git cannot nest `feat/desktop-attach-personal/TNN` under an existing branch of that name).
- T01: refusal messages wrap §5.1's phrases as `Refusing to trust <F>: <problem>.`; a missing data dir says `<A> does not exist`; when F is not the user's at all the old fleet message stays. Exported `bridgeTrustPaths(file)` and `judgePersonalPaths({ me, checks, configDir, loadNodeConfig })`.
- T03: a broken node.yaml is treated as fleet, so an elevated run is refused `NODE_CONFIG_INVALID`; extra JSON refusal codes PAIR_NOT_ADMIN, PAIR_CONFIRM_REQUIRED, PAIR_DECLINED, PAIR_NEEDS_AGENT, PAIR_REQUEST_INVALID, PAIR_USAGE, NODE_IDENTITY_UNREADABLE, NODE_IDENTITY_MISSING, NODE_CONFIG_INVALID; fallback PAIR_COMMAND_FAILED.
- T04: tests/service-cli-import-case.test.js's isAdmin dep now returns false instead of throwing (the elevation check runs under personal to refuse an elevated prompt).
- T05: closing line when the node is already running: `...is registered; it was not started again.` (wording not in the spec).
- T08: preload sends `{ confirmed: false }` when the caller did not pass true (as `detach` does).
- T09: the unpaired personal view's second line uses the spec's quoted words, not the CLI's `PAIR_WARNING` constant (which says "this service"); wording chosen for stage `command` (`Pairing with King Louie Node "<name>"…`) and `confirming` (`Checking the node's desktop bridge…`); personal views show `Version X.`; T09 also edited preload.js to expose describeBanner/describeInstallPreview/describeInstallResult.

## Unconfirmed on a real machine (spec §15)
- /Run → handshake time with an owner-sized history store (60 s kept, unmeasured).
- app.asar + ELECTRON_RUN_AS_NODE running `bin/king-louie-service.js run`.
- `schtasks /Query /XML ONE` on Windows 11 Home.
- Where startAttached hands over to the client's reconnect loop; whether getPort's
  trust read should skip the four-path read during a start wait.
