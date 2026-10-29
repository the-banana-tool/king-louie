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
- T02 personal-node runner: merge 22010fa5
- T06 controller one-click pairing: merge 192fe4cb16b424e4f5e885d56de4c913ea3b3344
- T07 controller start at attached launch, Start/Restart, Install: merge e8ff16f2
- T10 CLAUDE.md and install guide: merge 6381000f (doc fix b48729c5)
- T11 code-review fixes: merge 0e99502c

## Code review (mattpocock-skills:code-review, 2026-10-28)
Spec:
- S1 restart ran /Run without the task check (fixed: one runNodeTask helper; runner restartNode replaced by stopNode).
- S2 stale node state after a drop (fixed: re-read on leaving connected and rate-limited in attached-disconnected status, nodeRefreshMs 5 s; restart with nothing running just starts; NODE_START_TIMEOUT unless a fresh read finds the node running).
- S3 install re-reads the disk and needs the task missing (fixed: new codes NODE_TASK_REGISTERED, NODE_TASK_UNREADABLE).
Standards:
- T1 a sleep handle per wait.
- T2 an unreadable node.yaml is not personal in import (admin refusal when unelevated).
- T3 refusals through shown.
- T4 timeout text from nodeStartWaitMs.
- T5 PERSONAL_TASK_NAME in protocol.js.
- T6 PAIR_FATAL from BRIDGE_FATAL.
- T7 refuse() for PERSONAL_NOT_OWNER.
- T8 one firstLine, one node-status builder.
- T9 /bin/ps and the pidfile.js reader.
- T10 test string.
All fixed.

## Deviations
- All tickets: branches are `feat/desktop-attach-personal-TNN` (git cannot nest `feat/desktop-attach-personal/TNN` under an existing branch of that name).
- T01: refusal messages wrap §5.1's phrases as `Refusing to trust <F>: <problem>.`; a missing data dir says `<A> does not exist`; when F is not the user's at all the old fleet message stays. Exported `bridgeTrustPaths(file)` and `judgePersonalPaths({ me, checks, configDir, loadNodeConfig })`.
- T03: a broken node.yaml is treated as fleet, so an elevated run is refused `NODE_CONFIG_INVALID`; extra JSON refusal codes PAIR_NOT_ADMIN, PAIR_CONFIRM_REQUIRED, PAIR_DECLINED, PAIR_NEEDS_AGENT, PAIR_REQUEST_INVALID, PAIR_USAGE, NODE_IDENTITY_UNREADABLE, NODE_IDENTITY_MISSING, NODE_CONFIG_INVALID; fallback PAIR_COMMAND_FAILED.
- T04: tests/service-cli-import-case.test.js's isAdmin dep now returns false instead of throwing (the elevation check runs under personal to refuse an elevated prompt).
- T05: closing line when the node is already running: `...is registered; it was not started again.` (wording not in the spec).
- T08: preload sends `{ confirmed: false }` when the caller did not pass true (as `detach` does).
- T09: the unpaired personal view's second line uses the spec's quoted words, not the CLI's `PAIR_WARNING` constant (which says "this service"); wording chosen for stage `command` (`Pairing with King Louie Node "<name>"…`) and `confirming` (`Checking the node's desktop bridge…`); personal views show `Version X.`; T09 also edited preload.js to expose describeBanner/describeInstallPreview/describeInstallResult.
- T02: PERSONAL_TASK_NAME is copied in personal-node.js (not required from personal-install.js, so the installer is not loaded into the desktop), a test holds them equal; new codes NODE_TASK_RUN_FAILED, NODE_STOP_FAILED and nodeRunning's other: true (a live pid that is not a King Louie node); detect carries me; off Windows and under the KL_TEST_MODE+KL_DESKTOP_BRIDGE_FILE override detect says not personal with no inspector call; the async command-line lookup is a copy of stop.js's PowerShell one (stop.js's blocks).
- T06: the §6.2 step 5 wait calls the existing pairConfirm every 3 s (its handshake is the only proof the bridge is up); its fatal refusals end the wait. The task is queried before /Run (NODE_TASK_MISSING/DISABLED/OTHER_ACCOUNT; an unreadable task reports NODE_TASK_MISSING with its own message). A personal pending pair surviving an app restart comes back as PAIR_COMMAND_FAILED ("the app closed while pairing") with Try again/Cancel and is not polled. The pairing record also stores service.name; the unpaired status calls queryTask and nodeRunning (two more PowerShell/schtasks calls per status read on Windows); pairStart calls detectPersonalNode first, so a fleet machine gets one inspector call too.
- T07: nodeStart answers once the start is under way and waits in the background (startIdle() resolves when none is in flight); a wait where the desktop ran nothing (node already up, bridge silent) ends without NODE_START_TIMEOUT so the pane offers Restart; the 60 s wait makes 21 retryNow() calls; new codes NOT_PERSONAL, NOT_ATTACHED, NODE_INSTALL_FAILED, CONFIRM_REQUIRED; pane-model gained lines for NODE_TASK_RUN_FAILED and NODE_STOP_FAILED.

## Unconfirmed on a real machine (spec §15)
- /Run → handshake time with an owner-sized history store (60 s kept, unmeasured).
- app.asar + ELECTRON_RUN_AS_NODE running `bin/king-louie-service.js run`.
- `schtasks /Query /XML ONE` on Windows 11 Home.
- Where startAttached hands over to the client's reconnect loop; whether getPort's
  trust read should skip the four-path read during a start wait.
- Whether the task XML's <Principal><UserId> is exported as a SID (install --personal registers it with the SID) or as an account name; a name would read as other-account and the desktop would never run the owner's task.
