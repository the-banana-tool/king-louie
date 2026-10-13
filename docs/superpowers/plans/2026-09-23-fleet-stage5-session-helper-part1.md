# Fleet Stage 5: Session helper — Implementation Plan (Part 1 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent node launches allowlisted desktop apps in the logged-in user's session through a session helper, captures those apps' windows, and — under a short phone-signed lease the owner watches and can kill — drives them with clicks, keys and text; the same request to a server or an empty desktop fails with `capability_unavailable: gui` before anything is asked.

**Architecture:** The service keeps all policy in new Electron-free modules under `src/gui/` (config, allowlist, key grammar, text guard, the `kl-session-v1` channel, the broker, the lease manager, the live view, the tools and the relay extension). The helper (`king-louie-service session`, `src/session/`) runs as the logged-in user, authenticates the service over a local pipe/socket, and runs argv-only OS workers (PowerShell + C# P/Invoke, JXA, `xdotool`/`import`). Leases are F3 envelopes: node-signed `kl.lease.request|status|view`, phone-signed `kl.lease.grant|revoke|watch`, carried over F3's relay link and mailbox. The six parts run in order on `feat/fleet-stage5`: Part 1 pure foundations and both protocols (Tasks 1–6); Part 2 the service runtime — channel, broker, leases, live view, relay routes (Tasks 7–11); Part 3 images in tool results, the tools and host wiring (Tasks 12–14); Part 4 the helper process and the three OS backends (Tasks 15–18); Part 5 login start, the `session` CLI and the e2e (Tasks 19–21); Part 6 the mobile apps (Tasks 22–25).

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `node:crypto` (HMAC, HKDF, AES-256-GCM, Ed25519, P-256), `net` (named pipes / Unix sockets), `child_process` (argv-only). OS tools: Windows PowerShell 5.1 + `Add-Type` C#, `System.Drawing`; macOS `osascript -l JavaScript`, `screencapture`, `sips`, `open`; Linux `xdotool`, ImageMagick `import`, `loginctl`. Swift (KLProtocol package, SwiftUI) and Kotlin (protocol module, Compose) for the apps. **No new npm dependency.**

**Spec:** `docs/superpowers/specs/2026-09-23-fleet-stage5-session-helper.md`. **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md` (§3, §4.12, §4.13, §4.15–4.17, §4.23, §5). **Parent:** `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md` §4.6. Executors read the spec beside this plan; where they disagree, the Deviations list below wins.

**Revised 2026-10-12 for main `532efcf`.** The plan was written against main `d84f4c9`. The branch has since been rebased onto `532efcf` (474 commits later), and every file path, function, signature, constant and test helper the tasks name was read again there. Anchors are quoted text, never line numbers. What changed: the owner's rulings ("Owner rulings (2026-10-12)"), what main already settles or forbids ("Checked against main"), Deviations 1, 3, 4, 5, 6, 11 and 21, and the new Deviations 31–44. Every task header now carries its review weight and says what cannot be checked on Windows ("Tasks, review weight and where each can be checked").

**Before Task 1:** the worktree has no `node_modules`. Give it one the way this checkout's other worktrees get theirs: `npm ci`, or a junction to the main checkout's `node_modules`. If it is a junction or a symlink, never run `npm ci`, `git clean` or `git worktree remove` over it; delete the junction first. Then run `node --test tests/service-profile-graph.test.js tests/approvals-protocol.test.js tests/agent-loop.test.js tests/cases-tools.test.js tests/fleet-core-seams.test.js` and confirm `# fail 0` on the untouched branch, so a later failure in a file this plan touches is this plan's.

**Tests per task, the full suite once.** Each task runs the test files it names. The full `npm test` runs once for the stage, in Task 21.

## Owner questions (decided 2026-10-12)

The owner answered both on 2026-10-12, and no task is blocked on the owner. Where carrying a ruling into code needed a reading the ruling's words do not settle, the reading is recorded as a deviation and says so (Deviations 38, 41 and 42), so the owner can overrule it.

1. **The live lease view on Android: fetched on tap (R-F5-1, with R-F5-5 and R-F5-6).** What the app does today (`mobile/android/app`, unchanged on main since this plan was written): the device key needs a biometric prompt for every signature (`DeviceKey.kt`: `setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)`), and every device-authenticated relay request is itself signed (`RelayApi.exchange`), so each request is a prompt of its own. The spec's 20 s watch and long-polled views would prompt without end. So on Android nothing polls and nothing is sent again by itself: one tap signs and sends once. The prompts that follow from the app's key: "Check for computer-use requests" is one (the list request); Allow or Deny is two (the grant, then the request that carries it); Stop is two (the revoke, then its request); Refresh is three (the watch, its request, the views request). The earlier text "the kill switch is always one prompt" was wrong for this app. A send whose answer does not arrive is shown as not confirmed, and the owner taps again (R-F5-5). A `lease` push opens Pending's "Computer use" section and fetches nothing; Refresh asks for views from the position the watch reply gives, with `wait=5`, so the first tap shows the frame that watch causes (R-F5-6; Deviations 41 and 42; Tasks 11, 23, 25). iOS streams as the spec says, signing the watch with the already-unlocked API session (Task 24, R-F5-8). A separate non-biometric view key stays F3 app v2 work the spec defers. One behaviour of F3's client is kept as it is: `RelayApi.exchange` answers a `401 clock_skew` once by correcting its clock and signing the same request again. That is one more prompt in that one case, on every route of the app; it is not a re-send loop and F5 does not change it.
2. **Installing the helper for a second user: refused until the first is uninstalled (R-F5-2).** The spec runs one session user per node, and `session install --user NAME` rewrites the canonical secret each run. Installing for user B while user A is installed would leave A's autostart entry and per-user copy behind, pointing at a secret that no longer works. `session install --user B` refuses with `session_user_mismatch: installed for "A"; run "session uninstall --user A" first`, and running install again for the same user rotates as the spec says (Task 20).

## Owner rulings (2026-10-12)

Eight rulings here (R-F5-1 to R-F5-8): the two questions above and six points the plan had left open. Eight more (R-F5-9 to R-F5-16) came after the build and are in "Rulings after the build" below this table, and three more (R-F5-17 to R-F5-19) with the second security review, in "Second security review (2026-10-13)" below that. Each row names the tasks that carry the ruling and the tests that pin it. `mobile-lease-apps` is `tests/mobile-lease-apps.test.js`, a Node test that reads the two apps' sources (the app modules have no test target of their own), so it runs in `npm test` on any machine.

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-F5-1 | On Android the live lease view is fetched when the owner taps. Nothing polls. | Task 25 | `mobile-lease-apps › Android: the live lease section has no loop and no timer`; Task 25 Step 6 hand check |
| R-F5-2 | Installing the helper for a second user is refused until the first is uninstalled. | Task 20 | `service-cli-session › R-F5-2 (owner question 2): refuses a second session user until the first is uninstalled` |
| R-F5-3 | A lease request from a front-door client needs `fleet:unsafe`. `RequestLease` and an unsafe `LaunchApp` check the scope before anything reaches the phone (M19 holds; fail closed). A session the node started itself still asks the phone. | Task 13 (the tools), Task 14 (through `ToolExecutor`) | `gui-tools › R-F5-3: a run that refuses unsafe calls is refused a lease for scope; nothing reaches the relay`; `gui-tools › R-F5-3: an unsafe LaunchApp is refused for scope and the requester is never called; an allowlisted launch still runs`; `gui-tools › R-F5-3: a node-local run still asks the phone`; `gui-subsystem › R-F5-3: refuseUnsafe reaches the GUI tools through ToolExecutor` |
| R-F5-4 | In a case turn the GUI tools are read-only: `ListApps` and `Screenshot` stay; every acting GUI tool joins the case-blocked list. | Task 13 | `gui-tools › R-F5-4: a case turn keeps ListApps and Screenshot; a wake-up turn gets no GUI tool; a delegate turn gets all ten`; `gui-tools › R-F5-4: ToolExecutor refuses an acting GUI tool in a case turn`; `cases-tools › blocks tools that reach other sessions or change the tool list in every case turn` (the pinned list) |
| R-F5-5 | Android has no automatic re-send. Stop, Allow and Refresh sign and send once; a send that is not confirmed is shown as such and the owner taps again. | Task 23 (`Leases.sendOutcome`), Task 25 | `LeaseFlowTest › sendOutcome` (JVM); `mobile-lease-apps › Android: Stop, Allow and Refresh send once`; Task 25 Step 6 hand check |
| R-F5-6 | On Android a lease push opens the lease screen without fetching; Refresh waits briefly for the node's next capture, so the first tap shows a frame. | Task 11 (`after_seq` in the watch reply), Task 23 (`Leases.cursorAfterWatch`, `REFRESH_WAIT_S`), Task 25 | `gui-relay-extension › R-F5-6: the watch reply carries the mailbox position, and a views fetch from it waits for the frame`; `LeaseFlowTest › cursorAfterWatch`; `mobile-lease-apps › Android: a lease push fetches nothing; Refresh waits with Leases.REFRESH_WAIT_S` |
| R-F5-7 | A run with neither a job id nor a chat id is refused a lease, and an unknown job closes the lease (it does not count as open). | Task 1 (codes), Task 8 (no per-job state without a job), Task 9 (lease manager), Task 13 (`jobIdOf`), Task 14 (`isJobOpen`, `run.js`) | `gui-tools › R-F5-7: jobIdOf reads the run's origin`; `gui-tools › R-F5-7: a run with neither a job id nor a chat id is refused a lease`; `gui-leases › R-F5-7: no job id is job_required, a job that is not open is job_closed, and nothing goes out`; `gui-leases › R-F5-7: a grant for a job that closed is rejected at check 12 and ends the lease`; `gui-leases › R-F5-7: a lease whose job is gone ends at the next input and does not block another job`; `gui-broker › R-F5-7: a run with no job id keeps no launched pids and no screenshots`; `gui-subsystem › R-F5-7: isJobOpen fails closed` |
| R-F5-8 | Accepted: iOS signs `kl.lease.watch` with the API session, with no fresh Face ID; grants, denies and the kill switch keep a fresh prompt. (Since R-F5-19 the watch is sent only while the live view is visible.) | Task 24 | `mobile-lease-apps › iOS: only the watch is signed with the session`; Task 24 Step 6 hand check |

R-F5-1, R-F5-2 and R-F5-8 confirm what the plan already did; their tasks were checked and only their wording changed. R-F5-3 to R-F5-7 changed code and tests in the tasks named.

### Rulings after the build (2026-10-12 and 2026-10-13)

Eight more rulings came after Tasks 1–25 were built. No task carries them: each is one commit on `feat/fleet-stage5`, made test first, and the "Carried by" column names it. Where the plan's task text below says otherwise, these rows win. `cli-session` is `tests/service-cli-session.test.js`.

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-F5-9 | `session install` and `session uninstall` print what is granted or removed (the user by name and SID/uid, the node's name and id, what the helper can do, where it starts at login), then ask `[y/N]` on a TTY; off a TTY they need `--yes` or exit 2. Nothing is resolved with side effects, minted, created or written before the answer. `--yes` on any other `session` subcommand is a usage error. | `e241a85` (Task 20's code; supersedes "Neither asks") | `cli-session › R-F5-9: session install and uninstall ask for consent` (six tests); `cli-session › the CLI › knows the session command and its flag` |
| R-F5-10 | Who is installed is the recorded SID (uid off Windows), never the bare name. An existing helper file that cannot be read, parsed or verified, or that records no identity, refuses a new install and writes nothing. The same identity still rotates. `session uninstall` clears a damaged file. | `cc0b168` (narrows R-F5-2) | `cli-session › R-F5-10: the second-user check compares identities and fails closed` (nine tests); `cli-session › R-F5-2 (owner question 2): refuses a second session user until the first is uninstalled` |
| R-F5-11 | A helper file that exists but is wrong turns the GUI off with `session_file_invalid`; the service still starts. One error log line, no channel, every GUI tool refuses with the reason, `session status` and `doctor` say so with the remedy. Never a weaker mode. (Widened by review finding 2 to any build or start failure: `gui_start_failed`.) | `8969bd7`, `63dc8bc` | `gui-subsystem › R-F5-11: a helper file that … turns the GUI off with session_file_invalid` (six, seven on POSIX); `gui-subsystem › finding 2: …` (two); `service-run › the GUI subsystem under a live core (R-F5-11)` (a) to (e) |
| R-F5-12 | `session install` resolves the master key with the data dir's owner uid, and verifies the node id before sealing it. | `11737a4` (supersedes Deviation 14; see the note below the table) | `cli-session › R-F5-12: session install checks the key file's owner and verifies the node id` (six tests, one POSIX only); `cli-session › readNodeIdentity reads the identity where the store keeps it` |
| R-F5-13 | A front-door run without `fleet:unsafe` gets no GUI tool at all: `ListApps`, `Screenshot`, `LaunchApp` and `CloseApp` are refused for scope like `RequestLease` and the input tools, before the broker or helper is touched, and such a turn is not offered them. Widens R-F5-3; supersedes review finding 13f. | `47c0c35` | `gui-tools › R-F5-13: all ten GUI tools refuse a run that refuses unsafe calls, for scope, before the broker or the helper is touched`; `gui-tools › R-F5-13: a run the node started itself, and a client with fleet:unsafe (no mark), keep every tool`; `gui-tools › R-F5-4: a case turn keeps ListApps and Screenshot; …` (`delegateToolNames(…, { refuseUnsafe: true })`); `gui-subsystem › R-F5-3: refuseUnsafe reaches the GUI tools through ToolExecutor` |
| R-F5-14 | Computer use is off until `node.yaml` says `gui: enabled: true`; installing the helper enables nothing. A `LaunchApp` for a path outside the allowlist is refused outright, never sent to the phone; an allowlisted app with an argument or file outside what the allowlist permits still is. | `2db0fec` | `gui-config › R-F5-14: off unless enabled is written as true`; `gui-config › R-F5-14: a node.yaml gui block without "enabled: true" loads with gui off`; `gui-subsystem › R-F5-14: an installed helper with no "enabled: true" in node.yaml starts nothing; status and doctor say what to add`; `service-run › (e) R-F5-14`; `gui-apps › R-F5-14: a path that is not in the allowlist is refused as app_not_allowlisted`; `gui-tools › R-F5-14: …` (two) |
| R-F5-15 | Input needs the granting phone to stay in touch: no verified signed message from the granting device for 2 minutes (`gui.lease.contact_s`, at most 5) suspends the lease (`no_contact`), releasing what was held; that device's next fresh watch resumes it and never extends it. A replayed watch and another device's watch do not count. Node clock only. Android says "Paused: tap Refresh to let it continue". | `8a425cc` (on `a778b8a`, the per-lease nonces) | `gui-leases › R-F5-15: no contact from the granting phone suspends input` (ten tests, and the ten of `finding 3` inside it: since the second review a watch is contact only when it echoes a contact token the node issued inside the window); `mobile-lease-apps › Android: the live screen says input is paused for want of contact, and what keeps it going, with no timer`; `LeaseFlowTest › pausedForContact` (JVM) |
| R-F5-16 | The live view's action log never holds typed text ("Typed 42 characters"); both phones drop a status or view whose node `seq` is not newer than the last applied for that lease, and a view not addressed to this device. | `d96a449` | `gui-tools › R-F5-16: no typed text reaches the action log, from Type, from printable keys or from a refused call`; `gui-tools › R-F5-16: no typed text, printable key or hash that can be turned back into either is in the ledger, its relay slice, the views, status.json or a log line` (second review finding 2: the audit ledger too); `mobile-lease-apps › both phones enforce order and addressee (owner ruling R-F5-16)`; `LeaseFlowTest › orderAndAddressee` (JVM); `LeaseVectorTests › testOrderAndAddressee` (Swift) |

R-F5-12, the node id: the ruling expected the node's identity to be established from the admin-owned config dir. It is not: `pair`, `enroll-device`, `doctor` and the service itself all load it from the data dir's store with the master key (`getOrGenerateNodeIdentity(ports.store, ports.cipher, …)`), and no admin-owned file names the node id. So no source was invented. What was built: the id is read where the store really keeps it and verified against the private key held under the master key (the public key must be that key's public half), read-only. Two things came out of it. First, a defect: Deviation 14's reader looked for a flat `mesh.identity` key, but the store writes that record at a dot path (`{ mesh: { identity } }`), so on a real data dir `session install` always answered "start the service once first"; the test fixture had written the flat form. Second, the limit: this proves the id belongs to the key the data dir signs with, not that an administrator vouched for it. Closing that needs an admin-owned record of the node id and public key, written by an administrator command (at `pair` or `install` time) and read by `session install` and the service; that is a new trust file and an owner decision.

### Security review (2026-10-12)

An independent review of the branch at `d1b7cb9` gave thirteen findings. All were confirmed except one half of finding 8 (`GuiBroker#_window` already captured the foreground window when it belongs to the app). Each fix is one commit, test first.

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| 1 | Android showed a lease as stopped on the relay's unsigned reply | `e75fb91`: only `applyLease` (a status or view the pinned node signed) changes the state on screen | `mobile-lease-apps › Android: a lease is shown as ended only by a status or view the pinned node signed`; `LeaseFlowTest › stopNotice` |
| 2 | Any GUI start failure stopped the service | `63dc8bc` (with R-F5-11) | see R-F5-11 |
| 3 | Windows: nothing checked who can write the per-user file | `43063df` | `gui-session-secret › Windows: the copy is created empty, narrowed … only then written`; `… if icacls fails the copy is removed`; `checkUserCopyTrust` (five); `session-helper › finding 3` (two); `cli-session › finding 3` (three) |
| 4 | One input could land after Stop, expiry or job close | `31cb0e2` | `gui-tools › finding 4: …` (four); `gui-broker › no lease manager, no input` |
| 5 | A watch could be replayed after 10 minutes | `a778b8a` (node only; no message changed) | `gui-leases › finding 5: …` (three) |
| 6 | A rotation changed the endpoint under the running service | `caf4dd7` | `cli-session › writes the canonical secret … a second run rotates`; `cli-session › security review finding 6` (two); `gui-subsystem › finding 6` |
| 7 | macOS: layer-0 hit test; keyboard routes out of the app | `4591faf` (by reading; not run on a Mac) | `gui-keys › macOS keyboard routes that leave the app`; `session-backend-windows › finding 8, by reading the worker sources › macOS: the hit test reads all on-screen layers` |
| 8 | A click could land on a window the model never saw | `e987a9d` | `session-backend-linux › finding 8`; `session-backend-windows › finding 8, by reading the worker sources` (two) |
| 9 | The text guard was defeated by backspace and navigation splits | `8117b1a` | `gui-text-guard › TypedBuffer` (seven new); `gui-tools › finding 9: a vault value typed in pieces` (nine) |
| 10 | X11: a failed drag kept the button held; long typing outlasted the op timeout | `cdd8190` | `session-backend-linux › a drag always releases the button`; `… typing gets a time limit sized to the text`; `gui-broker › how long an input may take`; `gui-tools › review finding 10` |
| 11 | A hung worker was never restarted | `fcd0bc2` | `session-backend-windows › LineWorker › a call that times out kills the hung worker` |
| 12 | Lease views shared the mailbox cap with questions | `918a9ed` | `frontdoor-stores › Mailbox › a flood of one type evicts only its own oldest items` |
| 13a | Click modifiers skipped the key deny list | `c32d00f` | `gui-keys › checkClickModifiers` (two); `gui-tools › finding 13a` |
| 13b | `ListApps` returned window titles unwrapped | `3e9487f` | `gui-tools › finding 13b` |
| 13c | A newcomer's handshake ran out just before the duplicate ping | `37ee3f4` | `gui-helper-protocol › finding 13c` (two) |
| 13d | Any provider error with screenshots stripped images for the run | `a50f753` | `agent-loop-images` (seven new) |
| 13e | `session uninstall` could not run for a deleted account | `ee750a3` | `cli-session › finding 13e` (three) |
| 13f | Only `RequestLease` re-checked the refuse-unsafe mark | `28b5846`, then R-F5-13 | see R-F5-13 |

Also fixed, each its own commit: `device apply --yes` through the real CLI (`7ad19de`), `LineWorker` handlers tied to their own child (`1e0eac1`), the broker test's leftover temp dir (`17651c4`, a test-order bug, not a product one) and X11 refusing an unknown key (`8be380a`).

### Second security review (2026-10-13)

A second independent review, of the branch at `bef88b3` (after a rebase onto main; every hash in the tables above was rewritten to the commit of the same name on the rebased branch), gave thirteen findings. All thirteen were confirmed; none was disputed. Each fix is one commit, test first. `gui-leases`, `gui-tools`, `gui-broker` and the like are `tests/<name>.test.js`; `cli-session` is `tests/service-cli-session.test.js`; `session-secret` is `tests/gui-session-secret.test.js`.

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| 1 | On a real Windows install the helper could not start for a user who is not an administrator: it could not read who owns `session\users` | `63dc818`: install gives the session user's SID read-control, read-attributes and synchronize on that directory alone and sets its owner; uninstall removes the entry | `session-secret › checkUserCopyTrust for real (Windows: icacls on a temp dir, nothing injected)` (two: refused without the entry, passes with it); `session-secret › Windows: the users directory gives …`, `… removing the copy takes the user's entry off …`; `cli-session › second review finding 1` (three) |
| 2 | Printable keys and an unsalted hash of typed text reached the relay through the audit ledger (R-F5-16) | `d3166fb`: `Type` is audited as `{ length }`, `Key` by name only when it is not text; the `tier.decision` hash is over that form (`Tool#auditParameters`); a refused key is not repeated; the helper logs a failed input by its code | `gui-tools › R-F5-16: no typed text, printable key or hash that can be turned back into either is in the ledger, its relay slice, the views, status.json or a log line`; `gui-helper-protocol › an input that fails in the backend is logged and answered by its code alone` |
| 3 | A relay could bank watches and feed them in later as contact (R-F5-15) | `2c54a03`: lease-v1 change (see "Protocol changes" below); a watch is contact only with a token the node issued inside the window | `gui-leases › finding 3: a watch is contact only with a token the node issued inside the window` (ten); the rewritten `R-F5-15` tests; `lease-vectors` (`watch-no-token`, `watch-bad-token`, `status-valid`, `status-no-contact`); `mobile-lease-apps › both phones echo the newest contact token in a watch …`; `LeaseVectorTests › testStatuses`, `testRevokeAndWatch` (Swift); `LeaseVectorTest › statuses`, `revokeAndWatch` (JVM) |
| 4 | Windows: owned dialogs, pop-up menus and dropdown lists could be neither seen nor clicked | `60a6ead`: the worker lists owned windows; the foreground window of the app is captured; `Screenshot` names the app's other windows and takes `window`; `point_obscured` says what to do | `gui-broker › second review finding 4` (seven); `gui-tools › finding 4: Screenshot lists the app's other windows …`; `session-backend-windows › Windows: the window list includes owned windows …` (by reading) and `… lists the windows of the foreground window's process …` (the real worker, read-only) |
| 5 | On X11 a long `Type` kept typing after Stop, expiry or suspension | `fc8bee7`: typed text goes out in pieces of 40 code points with the lease checked before each; `release_all` kills the typing `xdotool` | `gui-broker › second review finding 5` (four); `gui-tools › finding 5` (two); `session-backend-linux › release_all kills the xdotool that is typing …`, `… the backend's own runner hands back the child …` |
| 6 | Key chords that leave the leased app | `7beec12` | `gui-keys › second review finding 6` (four, one of them the `LEAVES_THE_APP` table) |
| 7 | A `no_contact` pause wiped the typed buffer | `8e74b55`: every suspension keeps it, as a piece of unknown place | `gui-tools › finding 7` (three) |
| 8 | The text guard followed at most four pieces | `bb1116a`: any number of pieces in the order typed; 64 pieces and 4096 code points of history | `gui-text-guard › second review finding 8` (nine, one pinning the residuals) |
| 9 | A wall-clock step backwards stopped the contact rule and expiry | `0a82030`: a monotonic clock beside the wall clock; whichever says "over" first | `gui-leases › second review finding 9` (six) |
| 10 | The node-id check accepted a plaintext private key; the store was read through links | `6da480c` | `cli-session › finding 10` (four; the link test is skipped where the account cannot create a symbolic link, the pipe test is POSIX only) |
| 11 | `session uninstall`: dry run, the order of checks, a recreated account | `5660910` | `cli-session › second review finding 11` (eight) |
| 12 | A lapse masked a helper disconnect | `a40450e`: the stronger reason takes over | `gui-leases › second review finding 12` (four) |
| 13 | `session status` and `session probe` printed helper-supplied strings raw | `350f128`: `shown` (on `plainLineProblem`) for every such value, in doctor too; `RequestLease` refuses a reason that is not one plain line | `cli-session › second review finding 13` (four); `gui-subsystem › finding 13: doctor …`; `gui-tools › second review finding 13: a lease reason that is not one plain line is refused` |

Three more owner rulings came with it (2026-10-13).

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-F5-17 | **Deferred; not built.** An admin-owned record of the node's identity: the node id and public key written into the admin-owned config dir by an administrator command, which `session install` and the service check against. Approved as a follow-up after F5 merges. | nothing in this stage | none. The gap until then is stated in the spec (§13) and below this table |
| R-F5-18 | Any enrolled phone can stop a lease. A revoke is accepted from any enrolled, unrevoked device; so is a watch, which is never contact. Granting a resume and contact stay with the granting device. A phone learns of live leases from statuses the node signs, with one signed request, and both apps show a banner row with a working Stop for each, saying who granted a lease this phone did not. iOS asks when it becomes active with its session unlocked; Android only on the owner's tap (R-F5-1 holds). | `6ffef46` | `gui-leases › R-F5-18: any enrolled phone can stop a lease` (nine); `gui-relay-extension › R-F5-18: GET /v1/leases lists the leases that are running, as each node signs them` (three); `gui-live-view › R-F5-18: another enrolled phone that watches gets its own views …`; `lease-vectors` (`status-pending`, `status-granted-unnamed`); `mobile-lease-apps › R-F5-18: both phones list running leases from node-signed statuses, give each a Stop, and say who granted the ones they did not`; `LeaseVectorTests › testLiveAndGrantedBy`, `testStatuses` (Swift); `LeaseFlowTest › liveAndGrantedBy`, `tokenIsStale`, `LeaseVectorTest › statuses` (JVM) |
| R-F5-19 | iOS watches only while the live view is visible, as the spec says: closing the live lease sheet or backgrounding the app stops the watch; the banner and Stop stay. Under R-F5-15 the lease then pauses, and the banner says "Paused: open to let it continue". The earlier departure (watching from Allow until the lease ends) is removed. | `8904f43` | `mobile-lease-apps › R-F5-19: iOS sends a watch only while the live view is visible; the banner says "Paused: open to let it continue"` |

R-F5-17, the gap until it is built (from finding 10). The node's identity lives only in the data dir, which the service account owns, and the service account also holds the master key. An account that can write the data dir **and** read the master key can replace the stored identity with a key pair of its own, held under the master key like the real one; `session install` then seals that id into the helper's files and the service presents it. What `session install` refuses since finding 10: an identity whose private key is stored in the clear, one whose public key is not its private key's, one that does not decrypt under this data dir's master key, and a store that is a link, a pipe or not a regular file of a sane size. So a writer of the data dir who does not hold the master key cannot plant an identity. The phones are not reached by any of it: they pin the node's key at enrollment, and a changed identity fails every signature they check.

Readings taken where a ruling or a finding left a detail open, each the conservative one, for the owner to overrule:

- Finding 3: the window is counted from when the node verifies the watch, as the ruling's words say ("a watch is contact only if that token was issued within the contact window"), not from when the token was issued. A relay can therefore still hold one watch for up to the window, and input can go on for at most two windows after the phone's last signature. Counting from the token's issue would close that and would pause an Android lease between Refresh taps a minute apart.
- Finding 3: a watch without a valid recent token is still a watch (it asks for frames), never contact. Frames go out only while the lease is active, which needs real contact.
- Finding 2: the hash of the typed text is dropped, not replaced with an HMAC: there is no node-local key it could be keyed with that a later reader could use.
- Finding 4: a menu or a dropdown list is never captured by a guess (which window is "the menu" cannot be told from a tooltip or an app's own overlay without running on a real desktop); the model asks for it by the id a screenshot gives. macOS still lists normal-layer windows only.
- Finding 6: on Linux every `ctrl+F1` to `ctrl+F12` is denied (workspaces on Xfce and KDE), which also takes `ctrl+F4` and `ctrl+F5` from apps there.
- Finding 7: every suspension keeps the typed buffer, not only `no_contact`.
- Finding 11: a recreated account is recognised only when the recorded identity belongs to no account at all; an account of the same name that still exists (another domain's) keeps its install.
- Finding 13 / `plainLineProblem`: a lease reason with two spaces in a row, a tab or a line break is refused, as on an envelope card.
- R-F5-18: a resume may be **denied** by any enrolled phone (it ends the lease, as a Stop does); only its **grant** needs the granting phone. Android does not fetch at open (every request there is a prompt); it lists running leases on the tap it already had.
- R-F5-19: with the view closed iOS still polls for statuses (it signs no lease message), so the banner can say "Paused"; Allow presents the live view at once, since nothing watches without it.

Protocol changes of this round (`docs/protocol/lease-v1.md`; nothing a phone signs for a grant changed):

| Message | Change | Why |
|---|---|---|
| `kl.lease.watch` (phone-signed) | `contact_token`: the newest token the phone has applied for the lease, or `null` | finding 3 |
| `kl.lease.status` (node-signed) | `contact_token` (16 random bytes, new in each); `granted_by` (`{ device_id, name }` or `null`) | finding 3; R-F5-18 |
| `kl.lease.view` (node-signed) | `contact_token` | finding 3 |
| replies to grant, revoke, watch | `{ state, reason?, status? }`: the status the node signed for that answer | finding 3 |
| `GET /v1/leases`; node method `lease.list` | also `{ node_id, envelope: null, status }` for each lease running or ended lately, each status signed by the node for that listing | R-F5-18 |

Vectors: 32 lease-v1 (were 26); approval-v1 stays 41, session-v1 6.

Hand checks the owner still has to make (2026-10-13). None of these was run: the work was done on a Windows desktop, not elevated, with no Mac, no JDK, no phone and no permission to drive the desktop. Swift and Kotlin were written by hand and never compiled.

On a Mac:

1. `swift test` in `mobile/ios/KLProtocol`: the protocol core against the 32 lease vectors (`testStatuses`, `testRevokeAndWatch`, `testLiveAndGrantedBy`, `testViews` are the ones this round changed or added).
2. `xcodegen generate` in `mobile/ios` and build the app: `AppModel.swift` and `LeaseViews.swift` changed in three passes (the contact token, the running-lease rows, the visible-only watch).
3. The macOS helper under a lease: a screenshot and a click still land; a pop-up menu is still not capturable there (known; only Windows lists owned windows).

With JDK 17 (and the Android SDK for the app):

4. `../gradlew test` in `mobile/android/protocol`: `LeaseVectorTest` (`statuses`, `revokeAndWatch`, `views`) and `LeaseFlowTest` (`liveAndGrantedBy`, `tokenIsStale`).
5. Build the Android app: `AppModel.kt` and `LeaseScreens.kt` changed.

In an elevated Windows shell, on a machine that may be changed:

6. Finding 1, the one that matters most: `session install --user <a standard user>`, log in as that user (not an administrator), and see `session status` say the helper is connected. Before this round it exited `session_file_insecure`. `icacls "<configDir>\session\users"` should show that user with `(Rc,S,RA)` and nothing else, and BUILTIN\Administrators as owner.
7. `session uninstall --user <that user> --dry-run` lists the copy, the directory entry, the logon task and the helper file; the real run removes them, and `icacls` no longer shows the user.
8. Finding 11: install for a throwaway local account, delete the account, create it again under the same name, run `session uninstall --user NAME` (it should say the recorded identity no longer exists and remove it), then install again.
9. Finding 10's link test was skipped here (this account cannot create a file symlink): put a symlink at `<dataDir>\chat-data.json` and see `session install` refuse.

The gated desktop run (`KL_E2E_GUI=1 node --test tests/e2e/session-helper.test.js`, Windows or macOS, hands off the keyboard and mouse):

10. The suite itself, unchanged: it now types in pieces and uses the new window list.
11. Finding 4, exactly: lease Notepad; type a line; `Key ctrl+s`. `Screenshot` with no `window` must show the Save As dialog, and a click on its Cancel must land. Then click the File menu: `Screenshot` shows the main window and lists the menu under `other_windows`; `Screenshot` with that `window` id shows the menu, and a click on an item lands. A click through a main-window screenshot at a point the menu covers must be refused `point_obscured`, naming the menu's id. Repeat with a message box ("Do you want to save?"), Find (`ctrl+f`), Print (`ctrl+p`) and a dropdown list ("Save as type").
12. Finding 5: start a 2000-character `Type` into Notepad and press Stop on the phone: the typing stops within about a second. On an X11 desktop the same, where it used to run on for up to a minute.

With phones, a relay and a node:

13. iOS, R-F5-19: Allow opens the live view by itself and frames arrive. Close the sheet: within about two minutes the banner says "Paused: open to let it continue". Open it: the lease continues within a few seconds. Send the app to the background: it pauses again. Stop from the banner works with the view closed.
14. iOS, R-F5-18: force-quit the app while a lease runs and open it again: after the usual unlock (no extra Face ID) the banner row is back and Stop works.
15. Two phones, R-F5-18: grant on phone A. Phone B (open the app or pull to refresh; on Android tap "Check for computer-use requests") shows the row with "Granted by <A's name>". Stop on B ends the lease, and A shows it ended. Before stopping, open the live view on B: frames arrive, and the lease still pauses when A stops watching. Suspend the lease (bring another app to the front on the computer) and Allow the resume on B: the node refuses it (`not_granting_device`); Allow on A resumes it.
16. Android, R-F5-15: Refresh twice within a minute asks three prompts each time; after more than a minute it asks four, and a paused lease continues after that one tap. Stop shows the lease as ended as soon as the node's signed status comes back with the answer.
17. R-F5-16: with a lease running, type a known phrase and a few single keys, then read the node's history on the phone and the relay's mirror of the ledger: the phrase, the keys and their hashes are nowhere; a `Type` entry holds a length only.
18. Finding 9 on a real node: with a lease running and the phone watching, set the computer's clock back an hour: the lease still expires on time, and still pauses two minutes after the phone stops watching.

### Third security review (2026-10-13)

A third review, of the branch at `3a13e6b`, gave five findings and two hardening points. All seven were confirmed; none was disputed. Findings 1 and 2 are one commit (both are the same file's check, rewritten once); the others are one commit each, test first.

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| 1 | MEDIUM. The text guard's in-order check was bypassed by a junk character removed after a navigation: `Zq7#`, End, Backspace, `mK2#`, … spelled a vault value; `rm -#`, End, Backspace, `rf /tmp/x` an `always_confirm` command; `ghp_#`, End, Backspace and a body a token | `dcb2070`: (a) a Backspace past the text at the caret takes from the end of the piece before it after End, and keeps what it took as the piece's `cut` (checked with and without it); (b) every removal the buffer cannot follow marks the field lossy (`keyEffect`), and a lossy field is checked with links that may be a piece less up to 4 characters at each end or any run of 3 or more, and with up to 4 characters dropped at the joins for the command and prefix checks | `gui-text-guard-removals › third review finding 1` (sixteen: the three reproductions, Delete, ctrl+Backspace, ctrl+Delete, a selection typed over, the controls for ordinary editing, the residuals); `gui-tools › third review finding 1` |
| 2 | LOW. One check could block the event loop: a 7000-character vault value of one letter, 1900 characters typed at the caret and a 300-character `Type` ran for over two minutes here (the review measured 18 s) | `dcb2070`: a value over 512 characters is checked as a substring only; one check has `STEP_BUDGET` steps for its work across pieces and refuses with `text_guard_limit` past it | `gui-text-guard-removals › third review finding 2` (four) |
| 3 | LOW. A contact timer that fired early did nothing and was not armed again | `cac0b58`: armed again for what is left of the window | `gui-leases › a contact timer that fires early is armed again …`, `… an early contact timer after a later contact …` |
| 4 | LOW. `session install --user Everyone` (any group or well-known SID) would have made the helper's file readable by that group | `67d853d`: the resolver asks `LookupAccountName` for the SID and the name's type and refuses all but a user account; the SID's form is checked too; root is refused off Windows; before the question, nothing written | `session-secret › third review finding 4: only one user account` (four); `cli-session › install for a group or a built-in identity is refused …`, `… the real resolver refuses before the question …` |
| 5 | LOW. `session uninstall` took a domain account's SID that did not resolve (no domain controller in reach) for an account that was deleted, and removed its install | `ba13ad1`: only a SID of this machine's own accounts that maps to nothing is gone; any other is "could not be resolved", stays, and is removed with `--user <SID>` or the name with its domain | `cli-session › finding 5` (three) |
| 6 | Hardening (a). A worker's stderr line could quote typed text into the helper log (debug level) | `fdca517`: once a worker child has been sent an `input` op, its stderr is logged as a code and a length | `session-backend-windows › a stderr line of a worker that has typed text is logged by its length …` |
| 7 | Hardening (b), an owner-side decision taken conservatively. A lease whose granting device was revoked only paused when the contact window ran out | `2d35bd9`: it ends at once with `device_revoked`: as a phone's revoke is staged, before every input, and every 5 s while a lease is live (how a running node finds an administrator's `device revoke` / `device apply`) | `gui-leases › the leases a revoked device granted end` (six) |

Readings taken where a finding left a detail open, each the conservative one, for the owner to overrule:

- Finding 1: End is believed to put the caret after the piece typed last only while nothing else has moved the caret since the lease began; after that an End-Backspace also marks the field lossy (the line may end in any piece). What the Backspace took is kept and the piece is checked both ways, since End may have gone to the end of text that was there before.
- Finding 1: every ctrl/alt/meta chord that is not a caret key marks the field lossy, not only ctrl+Backspace and ctrl+Delete (ctrl+h, ctrl+w, ctrl+k and ctrl+z remove text too), and so does Insert (overtype). A click that is not a plain single left click, and every drag, counts as a selection.
- Finding 1: the lossy mark lasts for the lease. There is no point at which the guard could know the field is whole again.
- Finding 1, not closed and stated in the header of `text-guard.js`: the guard checks when text is typed, never when it is removed, so a value or command that a removal completes with nothing typed after it is not seen (`Zq7mK2pL#x9Rt4wYb`, Left ×8, Backspace). This is older than this round and outside what the finding asked for; it needs a ruling (refuse the removing key, which would be a new kind of refusal).
- Finding 2: the budget is counted in steps, not time, so a refusal is the same on every machine. It can refuse legitimate typing when the vault is very large and the history is full; the test for ordinary use (a full history, 200 values) stays under a quarter of it.
- Finding 4: every name type but "user" is refused, a computer account and a lookup that returns no type included. A domain's well-known group RIDs (512 to 527, 498, 553, 571, 572) are refused by the SID's form as well.
- Finding 5: a check that cannot run at all is "could not be resolved" too. Off Windows nothing changed: `id` cannot tell a deleted local uid from a directory account whose directory is out of reach.
- Finding 7: "revoked" is read as "no longer an active approver for any reason" (`ApproverStore#isActive` false): a record that was removed, or an approver set that became unreadable or untrusted, ends the lease as well. A lease waiting for its first grant has no granting device and is not ended. Worst-case delay for an administrator's revoke: 5 s (the check re-reads the set each time); for a phone's revoke: none.

Not run in this round: nothing on a Mac or with a JDK; no elevated install; the gated desktop suite; no domain-joined machine (finding 5's domain case is tested with an injected lookup only; the real lookup was run on this workgroup machine for a local user, a missing local RID, a made-up domain SID, SYSTEM, Everyone, Administrators and Users).

### Follow-ups after the merge (2026-10-13)

Two follow-ups on `feat/f5-followups` (from main at `161d28a`), each test first: a new ruling, R-F5-20, and R-F5-17, which the table above still calls deferred.

| Id | Ruling | Carried by | Pinned by |
|---|---|---|---|
| R-F5-20 | A relay cannot hide a live lease from a phone (owner, 2026-10-13: "I don't want relays to hide a live lease from phones"). Each listing request carries a nonce the phone chose for it, in the query it already signs; each node answers with a `kl.lease.listing` it signs over that nonce, the phone, and every lease it lists (id and status seq), also when it lists none. A phone takes a node's answer whole or not at all; a pinned node without one is shown as "Could not confirm with <node>", never as nothing running, and that is what an offline, slow or older node gives too. R-F5-1, R-F5-5, R-F5-18 and R-F5-19 hold: still one request, and on Android one prompt, on the owner's tap. | `feat(gui): a node signs its lease listing over the phone's nonce …` (`LeaseManager#listingFor`, `lease.list`, `GET /v1/leases?nonce=`, `buildLeaseListing` / `verifyLeaseListing`, seven vectors); `feat(mobile): both phones ask with a nonce …` (`Leases.verifyListing` / `checkListing` in both cores, `unconfirmedLeaseNodes` in both apps, the docs) | `gui-leases › R-F5-20: listingFor signs an answer a phone can check, also when nothing is live` (four); `gui-relay-extension › R-F5-20: with the phone's nonce, each node's signed listing comes with its statuses` (four); `gui-subsystem › builds the channel … registers the tools and the lease link methods`; `lease-vectors` (`listing-none`, `listing-live`, `listing-nonce-mismatch`, `listing-status-withheld`, `listing-status-stale`, `listing-other-device`, `listing-bad-signature`); `mobile-lease-apps › R-F5-20: both phones ask with a fresh nonce, take a node's listing whole or not at all, and say "Could not confirm with" for the rest`; `LeaseVectorTests › testListings`, `testCheckListingReadsTheRelayReply` (Swift); `LeaseVectorTest › listings`, `checkListingReadsTheRelayReply` (JVM) |

Protocol change (`docs/protocol/lease-v1.md`, "Listing" in §2; nothing a phone signs changed):

| Message | Change | Why |
|---|---|---|
| `kl.lease.listing` (node-signed, new) | `{ v, type, node_id, to_device, nonce, at, leases: [{ lease_id, seq }] }` | R-F5-20 |
| `GET /v1/leases`; node method `lease.list` | `?nonce=` (32 bytes, base64url; `400 bad_nonce`); `{ device_id, nonce }` → `{ statuses, listing }`; the reply also holds `{ node_id, envelope: null, status: null, listing }` per node that answered | R-F5-20 |

Vectors: 39 lease-v1 (were 32); approval-v1 stays 41, session-v1 6.

One existing test changed because the request changed: `mobile-lease-apps › R-F5-18: both phones list running leases …` expected `val listed = api.leases()` on Android and now expects `api.leases(nonce)`.

What is left, R-F5-20: a relay can still make a node look unreachable by dropping the request or the answer; the phone then says it could not confirm with that node. Denial is visible, not preventable. A listing says nothing about a request still waiting for an answer, and is as old as its request took (a relay can hold a reply for the 40 s a phone waits).

Readings taken, each the conservative one, for the owner to overrule:

- R-F5-20: the nonce is not a new phone-signed message. It rides in the query of the request the phone already signs, so Android keeps one prompt per check (R-F5-1, R-F5-5); the node therefore cannot check that a phone chose it, and does not need to: only the phone's own comparison gives freshness.
- R-F5-20: statuses that arrive without a listing that checks are still applied one by one, as before this ruling (a banner row with Stop for a lease the node signed as running), with the "Could not confirm" notice beside them. Dropping them would hide a lease the phone has signed word of.
- R-F5-20: a list request that fails altogether marks every pinned node as not confirmed.
- R-F5-20: a listing that checks does not remove a banner row for a lease it does not name (the node lists a lease's end among the last four; a node restart ends leases without a status). Left as before; no row is removed on the strength of an absence.
- R-F5-20: where it is shown. iOS: in the lease banner, on every tab, one line per node. Android: under "Check for computer-use requests" in Pending, where the owner tapped. A computer that is simply switched off therefore shows such a line until the next check that reaches it.
- R-F5-20: `at` in a listing is not judged (the phones' clock is the relay's); the nonce is what makes it fresh.

Hand checks still to make for the follow-ups (none was run: Swift and Kotlin were written by hand against the vectors and never compiled; no phone, relay, Mac or JDK here):

19. `swift test` in `mobile/ios/KLProtocol` (`testListings`, `testCheckListingReadsTheRelayReply`, `testEveryIosVectorIsCovered`) and `../gradlew test` in `mobile/android/protocol` (`LeaseVectorTest › listings`, `checkListingReadsTheRelayReply`, `everyAndroidVectorIsCovered`); then build both apps (`AppModel`, `RelayAPI`/`RelayApi`, `LeaseViews`/`LeaseScreens` changed).
20. R-F5-20 with a phone, a relay and two nodes: with both nodes up and nothing running, open the app (Android: tap "Check for computer-use requests", one prompt): no "Could not confirm" line. Stop one node's service and check again: "Could not confirm with <that node>" appears, and goes when the node is back and the phone checks again. Grant a lease on the other node and check from a second phone: the banner row is there and no line for that node. A node on a build from before this change shows the line while its running lease still gets its row.

## Checked against main (`532efcf`)

What main has that the plan was not written for, and what the plan now does about it. Items with no change are listed so nobody checks them twice.

| Main has | Plan |
|---|---|
| `READ_TOOLS` (`src/execution/safety-policy.js`) also holds `SearchHistory`, `ReadHistory` and seven management read tools | Task 13 adds `Screenshot` and `ListApps` to the set main has. It never writes the set out again |
| M19 (`shouldRefuseUnsafe` in `src/fleet/delegate-sessions.js`; `refuseUnsafeGate`, `REFUSE_UNSAFE_MESSAGE` in `src/approvals/executor-options.js`; `ToolExecutor#_rethreadedRequester` marks the requester it hands to tools with `refuseUnsafe`) | R-F5-3: Task 13 reads that mark (Deviation 39) |
| Case, wake-up and delegate tool lists (`CASE_BLOCKED_TOOL_NAMES`, `WAKEUP_BASE_TOOLS` in `src/cases/chat-integration.js`; `DELEGATE_EXCLUDED_TOOLS` in `src/fleet/delegate-sessions.js`) | R-F5-4 and Deviation 36: Task 13 |
| Tools get `options.origin` (`{ client, session, job_id }`, `session` = the chat id of a chat turn) and no `options.chatId` (`createToolExecutorWithApprovals`, `runOrigin`) | R-F5-7: `jobIdOf` reads the origin (Deviation 5) |
| A routed provider that fails over per call (`InferenceRouter#routedProvider`; `AgentLoop#_currentProviderName`); after its first answer a turn cannot move to another provider (`FAILOVER_BLOCKED`) | Task 12 reads the provider name per iteration (Deviation 4) |
| `Tool.validateParameters` knows `integer` | Deviation 1: Task 12 no longer edits the validator |
| Chats are rows in `history.sqlite`; a `toolResult` row is chunked and indexed; a test that builds a core calls `closeOpenHistoryStores()` | Deviation 3 says what of a screenshot is indexed; `tests/gui-subsystem.test.js` calls the helper (Task 14) |
| A catalog `vision` capability (`src/models/capabilities.js`: `capabilitiesOf`) | Not used: the agent loop has no catalog handle. Task 12 keeps the retry-without-images path; skipping images up front for a non-vision model is a follow-up |
| Windows CI runs with `TEMP` as an 8.3 short path | Tests build temp roots with `fs.realpathSync.native` (Global Constraints) |
| `readline` splits JSON lines at U+2028/U+2029 | The helper's line worker splits on `\n` itself (Task 16) |
| An attached desktop's turn runs in the service with a local origin, so its approvals are on-screen | Deviation 40: an unsafe `LaunchApp` says who approved or refused |
| `PROXIED_DOMAINS`, `DEFAULT_FEATURES`, `DEFAULT_PORTS`, the four `examples/fleet/*/service.json`, `CASE_YAML_KEYS` | No change: F5 adds no IPC domain, feature, port or `case.yaml` key. An attached desktop's turn runs in the service |
| `NODE_YAML_KEYS` | Task 1 appends `gui` in the same change that parses it, as the comment above the constant already says |
| 41 approval-v1 vectors, 37 client-grant-v1 files | Unchanged: F5 adds no approval-v1 message; `lease-v1` and `session-v1` have their own directories (`node tests/vectors/approval-v1/generate.js --check` still says `41 vectors match`) |
| Program constraint "No new native npm dependencies" | Holds: no task adds a `package.json` entry, native or not; the Android and iOS tasks add no library either |
| `ToolRegistry#unregister(name)` | Tests that register a tool on the shared registry remove it with `unregister` |

## Global Constraints

Program §3 and project rules, verbatim where they are quoted:

- Tests: `node --test`, **never Jest**. Pass = `# fail 0` / `# pass N` in the TAP summary. Run one file with `node --test tests/<file>.test.js`; the full suite with `npm test` (once, in Task 21). E2E needs `unset ELECTRON_RUN_AS_NODE && npm run test:e2e`.
- A test's temp root is `fs.realpathSync.native(fs.mkdtempSync(…))` wherever its path is compared or checked for links (`assertSafeComponents`, `resolveLaunch`, `realResolve`): a Windows CI runner's `TEMP` is an 8.3 short path, which the JS `realpathSync` keeps and the native one expands.
- A test that builds a core calls `closeOpenHistoryStores()` (`tests/helpers/close-history-stores.js`) before it removes the data dir: on Windows an open `history.sqlite` keeps its folder from being deleted.
- Fail closed (R-F5-3, R-F5-7): a run that refuses unsafe calls is told so in main's own words (`REFUSE_UNSAFE_MESSAGE`) before anything reaches the phone; a run with no job is refused a lease; a job that is not known to be open is closed. No default in this plan's code is "open" or "allowed".
- Logging through `createLogger` (`src/logging.js`); no bare `console.*` anywhere in `src/` (CLI output goes to `io.stdout`/`io.stderr`, as `src/service/cli.js` does).
- `src/` outside `src/ipc/` and the Electron host is Electron-free (`tests/electron-boundary.test.js`). Everything in this plan runs under `king-louie-service`; `src/gui/` and `src/session/` never require `electron`.
- **No new native npm dependencies** (and no new npm dependency at all in this stage, spec §14): HMAC, HKDF, AES-GCM, Ed25519 and P-256 come from `node:crypto`; JCS is `src/platform/jcs.js`; image encoding is the OS's (`System.Drawing`, `sips`, `import`).
- Approval requesters return `true | false | 'timeout' | 'unavailable'`; **only `=== true` approves**. A truthy string (`'yes'`, `'approved'`) never does.
- Security-relevant configuration is read only from the root/admin-owned config dir in service mode: `gui.*` from `<configDir>/node.yaml`, the session secret from `<configDir>/session/helper-secret.json`, the per-user copies from `<configDir>/session/users/`. **The data dir never decides policy**: `<dataDir>/session/status.json` is output only and grants nothing.
- Trust principle 3 (fleet §3.1): remote-origin unsafe actions run only with a fresh, single-use phone signature over the exact action. The computer-use lease is the one bounded exception, and it is itself phone-signed, app-limited, time-limited (≤ 60 min) and node-clock-expired.
- Tool results are `{ ok: true, … }` / `{ ok: false, error }`; gate refusals are results, never throws. GUI tools turn every `GuiError` into `{ ok: false, error: '<code>[: detail]' }`.
- e2e never touches the real profile: `tests/e2e/session-helper.test.js` builds a temp config dir and data dir, passes `KL_SESSION_FILE`, and never reads or writes the real admin config dir, data dir or a real `LaunchAgents`/autostart/Task Scheduler entry.
- The repo is open source: no personal names, machines, domains or paths in code, fixtures or docs. Use `example.com`, `kl.example.com`, `gpu-box`, `web-01`, `mac`, user `alice`, and the fixed test keys in `tests/vectors/approval-v1/keys.json`.
- F5 must not change F3's or F4's message shapes (program §4.13): the 41 approval-v1 vectors and the 37 client-grant-v1 vectors stay byte-for-byte; `lease-v1` and `session-v1` get their own directories and generators.
- Every file F5 writes is written atomically (temp + rename) or with `O_CREAT|O_EXCL` as the spec says; user-home files are written only by a child running as that user.
- Tests that touch an admin config dir inject `configDir`/`adminUid`/`rootUid`/`geteuid`; they never use the real per-platform dir. Tests that await unref'd timers call `holdEventLoop()` from `tests/helpers/hold-event-loop.js`.
- Every commit in this plan ends with the `Co-Authored-By:` line the implementing session is given. The commit blocks below show `Claude Opus 5.5 (1M context)`; use the session's own line where it differs.

Fleet stage 5 spec values (exact):

- Helper channel: at most 4 unauthenticated connections, each closed after 5 s; one authenticated helper; a newcomer is refused `helper_already_connected` while the current one answers `ping` within 5 s, and replaces it otherwise (audited). `ping` every 10 s; closed after 30 s silent. Pre-`ready` frames ≤ 16 KiB, sealed frames ≤ 8 MiB.
- Sealing: `keys = HKDF-SHA256(secret, salt = empty, info, 64)`; `k_sh = keys[0..32]`, `k_hs = keys[32..64]`; frame `len(4,BE) ‖ seq(8,BE) ‖ AES-256-GCM ciphertext ‖ tag(16)`, `iv = dir(1) ‖ 0x000000 ‖ seq(8)`, `aad = 'kl-session-v1' ‖ dir ‖ seq`; `dir` `0x01` service → helper, `0x02` helper → service; `seq` from 1 per direction; anything but last + 1 closes.
- Op timeouts: 10 s, `screenshot` 20 s, `launch` 30 s. Helper reconnect backoff `1, 2, 5, 10, 30 s`; re-probe every 60 s.
- Leases: one `pending|active|suspended` lease per node; request `expires_at` = +5 min; `1 ≤ grant.minutes ≤ min(lease.max_minutes, gui.lease.max_minutes, 60)`; expiry `verified_at + minutes` on the node clock, a resume never extends; nonce caches 10 min; leases memory-only.
- Live view: watch lasts 60 s (iOS renews every 20 s; Android sends one watch per Refresh tap, R-F5-1); frames every `interval_s` (default 3, 1–5) plus one after an input, **≤ 1 frame/s in total**; `max_width` 960, JPEG `quality` 60; `max_frame_bytes` default and max 184320 (re-capture once at quality − 20, else `frame: null, frame_dropped: true`); a view ≤ 256 KiB; ≤ 50 actions per view, 200 kept per lease.
- Tools: `max_inputs_per_minute` default 120 (10–600); screenshots kept per job: last 16, 10 min; ≤ 5 images per iteration; the last 3 screenshots stay in the conversation.
- Text guard: ≤ 2000 characters; typed buffer = the last 2000 printable characters, reset on `enter` and on a foreground change; the pinned secret regexes of spec §3.8; entropy rule over runs of 24 or more characters (the spec's `/\S{24,}/`, narrowed to printable ASCII by Deviation 26), ≥ 4.0 bits/char and ≥ 3 character classes, except a plain `http(s)` URL; vault values ≥ 8 characters.
- Mailbox type `kl.lease.` with `ttlMs: 300000`, `maxBytes: 262144`; relay RPC timeout 10 s; `GET /v1/leases?wait=0..25`; Android's Refresh fetches views with `wait=5` (Deviation 42).

## Review Focus

Five conditions the spec implies but no spec-listed test reaches, most likely first. Each line's test is added to the task that owns the code:

1. **The owner changes display scaling or moves the window to another monitor mid-lease** (`displays_changed`): every kept screenshot of the job becomes `stale_screenshot`; a click from an old screenshot is refused rather than landing at the old coordinates. Test: `gui-broker › displays_changed invalidates every kept screenshot` (Part 2, Task 8).
2. **The node sleeps (laptop lid) through a lease's expiry**, so the expiry timer fires late: the next input is `lease_expired` because `assertUsable` compares the node clock itself, never trusting that the timer already ran. Test: `gui-leases › an input after expires_at is refused even when the expiry timer has not fired` (Part 2, Task 9).
3. **A UAC prompt, a credential dialog on the secure desktop or the lock screen appears between two inputs**: the helper reports `screen_locked`; the lease is not suspended, nothing is injected, and the lease clock keeps running. Test: `gui-leases › screen_locked from the helper refuses without suspending` (Part 2, Task 9).
4. **Non-English prose without spaces** (a Japanese or Chinese sentence with a number and a Latin word): not refused as `text_looks_secret`, because the entropy rule looks at runs of printable ASCII (Deviation 26), so the sentence never forms one long run; and a 2000-emoji text passes the length rule (code points, not UTF-16 units) while 2001 fails. Test: `gui-text-guard › CJK prose and emoji are not secrets; length counts code points` (Part 1, Task 3).
5. **The owner closes the leased app's window while its process keeps running** (tray apps): a click on a screenshot of that window is `stale_screenshot`, not a suspension, and not a click at the old coordinates on whatever is there now. Test: `gui-broker › a screenshot whose window is gone is stale` (Part 2, Task 8).

## Interfaces from other stages

| Contract | On main `532efcf` | This plan |
|---|---|---|
| F3 P2 `seal`, `open`, `nodeSigner`, `verifyEs256`, `verifyEd25519` (`src/approvals/envelope.js`) | exists | used as is |
| F3 P3 `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces })`, `NonceCache`, `bytesSha256` (`src/approvals/verify-device.js`) | exists; needs the type registered with `registerMessageValidator` | Task 6 registers the six `kl.lease.*` validators on load (as C4's `mobile-app-channel.js` does) |
| F3 P9 `startApprovals(...) → { phoneApprover, auditLedger, relayClient, approverStore, identity, courierPump, stop }` | exists; `relayClient` is null without a relay pin | the `approvals` argument of `createGuiSubsystem` (Task 14) |
| F3 P10/P11 `relayClient.send(envelope, { push, to_device })`, `registerMethod`, `isConnected()`, `on('connected'/'disconnected')` | exists; **`send` rejects with `relay_offline` while the link is down** | Task 9 keeps unexpired requests and re-sends them on `connected` (Deviation 12) |
| F3 P15–P18 `phoneApi.registerRoute`, `nodeHub.rpc`, `mailbox.registerType`, `src/frontdoor/extensions.js`, push kind `lease` | exists; an extension is `(relay) => void` receiving `{ phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }`; push `KINDS` already includes `lease` | Task 11 adds one line to `extensions.js` |
| F3 P20 `auditLedger.append({ kind, data })` (async) | exists | every `gui.*`/`lease.*` entry |
| F3 P23/P24 `classifyToolCall`, `READ_TOOLS`, `patternMatch`, `SHELL_SEPARATORS` | exists; `READ_TOOLS` has grown (history and management read tools) | Task 13 adds `Screenshot`, `ListApps` to the set as main has it |
| F3 `core.context.getPhoneApprover()` | exists (null unless `isAvailable()`) | `RequestLease` refuses `signed approval unavailable` when `phoneApprover.isAvailable()` is false |
| F4 `extraToolOptions.origin` (`origin: seam.origin` in `createToolExecutorWithApprovals`, `src/core/create-core.js`) | exists: every tool gets `options.origin = { client, session, job_id }` (plus `deviceId` when `client` is `desktop`). `runOrigin` (`src/approvals/executor-options.js`) sets `session` to the run's chat id; a delegate turn passes `approvalOrigin(origin, jobId)`, so `job_id` is its job; a sub-agent inherits its parent's origin. Tools get no `options.chatId` | the tools' job id (Task 13, Deviation 5) |
| F4 M19: `shouldRefuseUnsafe(origin, nodeConfig)`; the `refuseUnsafe` executor option; `requester.refuseUnsafe` on the requester handed to tools; `REFUSE_UNSAFE_MESSAGE` | exists; `tests/fleet-core-seams.test.js` pins it for unsafe tool calls | R-F5-3: `RequestLease` and an unsafe `LaunchApp` read the mark (Task 13, Deviation 39) |
| F4 `DelegateSessions({ leaseManager })` calls `leaseManager.endForJob(jobId, 'job_closed')` on close; `startFleetNode({ deps: { leaseManager } })` | exists | Task 14 passes `gui.leases` (Deviation 6) |
| F4 `JobManager` (`src/runbooks/runbook-engine.js`): `getJob(id) → job \| null`, `isTerminal(id)`; job ids are `job-<ms>-<6 chars>`; jobs stay in its map for the life of the process | exists | `isJobOpen` (Task 14, Deviation 6) |
| Management surfaces: `CASE_BLOCKED_TOOL_NAMES`, `CASE_BLOCKED_TOOL_ERROR`, `WAKEUP_BASE_TOOLS`, `shapeToolDefinitions` (`src/cases/chat-integration.js`); `DELEGATE_EXCLUDED_TOOLS`, `delegateToolNames` (`src/fleet/delegate-sessions.js`) | exists; `tests/cases-tools.test.js` pins the blocked list | R-F5-4 (Task 13, Deviation 36) |
| Models M2: `InferenceRouter#routedProvider` (`current()`, `getProviderName()` follow the target that answered; `buildToolMessages` is the answering instance's); `AgentLoop#_currentProviderName()`; chat turns run the loop with `failoverPolicy: NO_RETRY` | exists | Task 12 places images by the provider that answered (Deviation 4) |
| History H1–H3: `core.context.getChat(id, { messages })`; `tests/helpers/close-history-stores.js` | exists | `isJobOpen` for `chat:` ids (Deviation 38); `tests/gui-subsystem.test.js` |
| F4 `defaultReadGuiStatus()` in `src/fleet/start.js` requires `src/gui/status` when present; `FleetToolHandler` adds `gui` to `list_machines`/`describe_machine` | exists | Task 8 supplies `readGuiStatus`; Task 14 adds `'gui'` to `capabilities` (Deviation 7) |
| F7 desktop UI helper status | merged; reads nothing of F5 yet | untouched (F7 reads `readGuiStatus` in a later change; spec §2.2) |
| C7 `getCapabilities().vision` | merged as the catalog's `capabilitiesOf(catalog, provider, model).vision` (`src/models/capabilities.js`); the agent loop has no catalog handle | Task 12 still uses the retry-without-images path only; skipping up front is a follow-up |

## Deviations (current code vs the spec, resolved from the spec's intent)

1. **`integer` parameters.** *Settled by main (2026-10-12).* Main's `Tool.validateParameters` (`src/tools/tool-schema.js`) now accepts `type: 'integer'` (`matchesType`) and range-checks every number, so Task 12 no longer edits the validator (its test still pins the behaviour). The validator still ignores `additionalProperties`, `pattern`, `minItems` and nested objects, so every GUI tool checks its own params strictly (`checkParams`, Task 13), and the schemas stay typed with `additionalProperties: false` as §3.9 says.
2. **`emitsImages` needs the `Tool` class.** `Tool`'s constructor copies only known fields; Task 12 adds `this.emitsImages = config.emitsImages === true` (spec §7 does not list `tool-schema.js`).
3. **Where `_images` is lifted.** `ToolExecutor` emits `postExecute` with the tool's result before the agent loop sees it, and `src/ipc/chat-handlers.js` saves that result to chat storage (`appendMessageToChat(chatId, 'toolResult', …)`). Stripping in `agent-loop.js` alone would persist base64 screenshots. So `ToolExecutor` detaches `_images` right after `tool.execute` — kept (as a non-enumerable symbol property, invisible to `JSON.stringify` and spreads) only for a tool with `emitsImages: true`, deleted for every other tool — and the loop lifts them from that symbol (`src/execution/tool-images.js`). A result a `PostToolUse` hook puts in place of the tool's goes through the same detach, so a hook cannot add `_images` either. The spec's outcome (never persisted, exported or shown to non-image tools) is unchanged. *On main (2026-10-12)* that `toolResult` row is a history row, chunked and indexed for recall (History H2). What is stored and indexed of a `Screenshot` result is its text fields only (`screenshot_id`, `app_id`, the sizes, `captured_at`, the note); no image byte reaches `history.sqlite`, the FTS index or an embedding. A `Type` call's text is in its `toolUse` row like any tool parameter; only the audit ledger is limited to its length and hash. `UNINDEXED_TOOLS` is not changed.
4. **Several tool calls in one iteration; the provider that answered.** The loop uses `buildMultiToolMessages` when a response has more than one call; the Anthropic provider's `buildMultiToolMessages` also takes images per entry (`entry.images`), placed inside that entry's `tool_result`, beside the spec's 4th argument to `buildToolMessages`. *On main (2026-10-12)* a chat turn's provider is a routed one whose first call can fail over to another provider before anything has answered, so the name read when the run starts can be wrong for the whole run. The loop asks `this._currentProviderName()` each iteration, after the call returned, and places that iteration's images for that provider. (After its first answer a turn cannot move to another provider: the router refuses with `FAILOVER_BLOCKED`.)
5. **Job id.** *Decided (R-F5-7).* F4 hands every tool `options.origin` (the run's `{ client, session, job_id }`); a delegate turn's `job_id` is its node job id, and on main a chat turn's `session` is its chat id (tools get no `options.chatId`). The tools read the origin only: `options.origin.job_id`, else `chat:<options.origin.session>`, else no job id. There is no `chat:local`: a run with neither is refused a lease (`job_required`) and gets no per-job state in the broker (Deviation 43). On main a run started by the gateway's `agent:message` handler (`src/core/create-core.js`) is such a run: it passes no origin and no chat id. Other entry points were not traced one by one; whichever run lacks both is refused the same way.
6. **`endForJob` arrives now; a job must be known to be open.** *Decided (R-F5-7).* `DelegateSessions` already calls `leaseManager.endForJob(jobId, 'job_closed')` and `startFleetNode` accepts `deps.leaseManager`; run.js passes `gui.leases`, so job-scoped leases work in this stage rather than wave 4. `jobOpen(jobId)` fails closed: a `job-…` id is open only while the fleet `JobManager` knows the job and it is not terminal; a `chat:<id>` job only while that chat exists (Deviation 38); anything else, an unknown id included, is closed. A job that is not open ends its lease `job_closed`: `RequestLease` for it is refused before anything is sent; a grant for it is rejected at check 12 and the pending lease is ended, not left pending; an input finds the lease ended; and another job asking for the node's lease is not told `lease_busy` by a dead job's lease.
7. **The MCP `gui` block.** F4's `FleetToolHandler` (both the stdio server and the service path) already adds `readGuiStatus({ dataDir })`'s result as `gui` to `list_machines` and `describe_machine` when `src/gui/status.js` exists, so `src/mcp/stdio-server.js` is not edited. Task 14 makes the handler add `'gui'` to `capabilities` while `gui.available`, and `readGuiStatus` returns exactly the MCP-safe block `{ available, capabilities, apps: [{ id, name }], limits, lease: { active } | null }` (no paths, no `args` globs). The front door's own `list_machines` (cached catalog) stays without `gui` (spec §13).
8. **Module graphs.** `src/service/node-config.js` loads on every profile and now requires `src/gui/config.js`; F4's `src/fleet/start.js` requires `src/gui/status.js` on the runbook profile. Both stay dependency-free (Node built-ins, `src/gui/errors.js`, `src/service/pidfile.js`), and `tests/service-profile-graph.test.js` forbids `src/gui/` except `config.js`, `errors.js`, `status.js` (and `relay-extension.js`, `lease-protocol.js` on the relay and front-door graphs), and all of `src/session/`.
9. **`gui` on the front door.** §3.4 forces `enabled: false` on `profile: runbook`; `profile: frontdoor` gets the same (neither runs a helper), and `parseGuiConfig` always returns the full shape with `enabled: false` rather than a bare `{ enabled: false }`, so no consumer null-checks.
10. **`<configDir>/session` is `0755`, not `0750`.** The per-user copies live in `<configDir>/session/users/`, which the helper (a normal user) must reach; a `0750 root:<svc>` `session` dir would lock it out. The canonical file's own `0640 root:<svc>` mode protects it; `users/` stays root-owned `0755` and each copy `0600` owned by its user.
11. **Components checked for reparse points.** "Every path component" is checked by requiring the admin config dir to equal its own `realpath` (so no link anywhere above it) and `lstat`-ing each component below it; the result is the spec's check without refusing a platform whose `/var` or temp dir is itself a system symlink above a test root. The comparison ignores case only on Windows and macOS; on Linux it is exact, so a link whose name differs from its target by case alone is refused (revised 2026-10-12: the first draft lower-cased both paths everywhere).
12. **Lease requests while the relay is down.** `RelayClient.send` rejects with `relay_offline` when the link is down; the lease manager keeps an unexpired request (or resume) and re-sends it on `connected`, like approvals (R16), instead of failing the tool.
13. **The service account for the POSIX socket dir** is the owner of `--data-dir` (uid and gid from `fs.statSync(dataDir)`), the account the installers created; `session install` has no separate flag for it.
14. **Node id for `session install`.** The canonical file records `node_id`; `session install` reads it from the service's own identity record (`<dataDir>/chat-data.json`, key `mesh.identity`, `deriveNodeId(publicKey)`), which needs no master key; the master key is only resolved to write the `klc1:` secret, read-only (`resolveMasterKeyReadOnly` + `verifyKeyCheck({ create: false })`, as `import` does). No identity or no key yet → `start the service once first`.
15. **The helper's file path.** The helper cannot know a non-default config dir, so the autostart entries pass `session --session-file <path>`; `KL_SESSION_FILE` is still honoured (flag first, then the variable, then the platform default `adminConfigDir(defaultServiceDataDir())/session/users/<user|SID>.json`).
16. **CLI shape.** `src/service/cli.js` dispatches `{ sub, arg, flags, dataDir, io }` objects, not `(positionals, flags, io)`; `session` follows that, adds the value flag `--session-file`, and uses the existing `--user`/`--dry-run`.
17. **App launches are not hidden.** `windowsHide: true` sets `SW_HIDE` in the child's `STARTUPINFO`, which many Windows GUI apps honour for their first window; workers and tools spawn with `windowsHide: true`, but `LaunchApp`'s own child uses `windowsHide: false` (still `shell: false`, argv only).
18. **Helper log file names.** `attachServiceLogFile` gains a `{ name }` option so the helper writes `helper.log`/`session.log` in the per-OS directories §3.3 names.
19. **HKDF `info` encoding.** §3.2 writes `'kl-session-v1 keys' ‖ node_id ‖ nonce_h ‖ nonce_s`; the plan fixes the bytes as UTF-8 of the label, UTF-8 of `node_id` (always 19 characters) and the **raw 32 bytes** of each nonce, so there is no separator ambiguity. `docs/protocol/session-v1.md` and the vectors pin it.
20. **A refused newcomer.** §3.2 refuses a second helper with `helper_already_connected` after it authenticates; the service sends it one plain frame `{ "t": "error", "code": "helper_already_connected" }` in place of `ready` and closes. `session-v1.md` lists it.
21. **iOS signs `kl.lease.watch` with the API session.** *Decided (R-F5-8): accepted.* A watch grants nothing (it only asks for frames of a lease the owner already granted, to a device the node already trusts), so iOS signs it like its API requests, without a fresh Face ID prompt every 20 s; grants, denies and the kill switch keep their fresh prompt. What the owner accepted with it: anyone holding the phone while its API session is unlocked can open the live view of an active lease with no prompt, and the node cannot tell a session-signed watch from a prompted one. `signWatchEnvelope` refuses every other message type (Task 24). Android: Owner question 1.
22. **`tests/examples.test.js` needs no edit.** It reads `NODE_YAML_KEYS` from `node-config.js`, so adding `gui` there covers §7's "`NODE_YAML_KEYS += gui`".
23. **Phone-side lease vectors.** `view-tampered-frame` is a correctly node-signed view whose `frame.sha256` does not match its `frame.data` (reason `frame_hash_mismatch`): a byte flipped in the payload would fail the signature first and test nothing new.
24. **Vector `given` for leases** adds `allow_test_keys` and `node.key` (the node's SPKI hex), which the node-side runner and the phones need, beside §4.1's listed keys.
25. **`capability_unavailable` detail.** A missing sub-capability is `capability_unavailable: gui.input` (etc.); no helper at all is `capability_unavailable: gui`, as §9 shows.
26. **The entropy rule's runs.** §3.8 says "a whitespace-free run `/\S{24,}/`". A Japanese or Chinese sentence has no spaces, so it forms one long run with high entropy and, with one Latin word and a number, three character classes: ordinary prose would be refused. The rule runs over runs of printable ASCII (`/[!-~]{24,}/`) instead; every secret shape it targets is ASCII, and the pinned regexes and the vault rule still see the whole text (Review Focus 4).
27. **macOS typing of non-ASCII text** (Task 17). `CGEventKeyboardSetUnicodeString` needs a `const UniChar *` buffer the JXA bridge does not document how to build. The macOS worker types ASCII with key codes (Accessibility only) and sends non-ASCII runs through `System Events` `keystroke` in the same worker call (the Automation permission for System Events; probe check `automation`); without it a non-ASCII `Type` is refused `invalid_text`. The foreground, bounds, lock and human checks still run first in that call.
28. **A read-only `hitTest` on each backend** (Tasks 16–18). The backend tests must exercise the hit test without injecting input into the tester's desktop, so each backend also exposes `hitTest({ x, y })`. It is not a `kl-session-v1` op, and `createOpHandler` never routes to it.
29. **History needs no new store** (Tasks 24–25). The node's audit slice (F3's `/v1/nodes/{id}/history`, F4's mirror on a front door) already carries every `lease.*` and `gui.*` entry; the apps only label those kinds "Computer use".
30. **`status.json` carries `apps`.** §4.5 lists no apps, but `readGuiStatus` must return `apps: [{ id, name }]` (§5.2) without reading `node.yaml`; the broker writes the allowlist's ids and names (never paths) into `status.json`.

Deviations 31–35 were in the plan's code from the start but not in this list; 36–44 come from the rulings and from main.

31. **A bare `*` detail is not a text rule** (Task 3). §3.8 matches any `Name(detail)` whose detail matches the text. `Vault(*)` is in the default `always_confirm`, and its detail `*` matches every text, so every `Type` would be refused; `matchesAlwaysConfirm` drops a detail that is exactly `*`. `Bash(*deploy*)` still matches text containing "deploy".
32. **Relay rate limits on the lease routes** (Task 11). §4.7 names only the 120 requests/min/device rule. `POST …/watch` has its own budget of 12/min per device and `…/grant` and `…/revoke` 30/min (`registerRoute`'s `rate`), so a looping or hostile phone cannot make a node capture or verify without bound. iOS sends 3 watches a minute.
33. **`session uninstall` deletes the canonical secret** (Task 20). The spec is silent. Uninstalling the session user that `helper-secret.json` names removes that file as well as the per-user copy and the login start, so the service finds no helper installed at its next start and R-F5-2's check sees no installed user.
34. **`lease_pending` for an input** (Task 9). §3.6's list for `assertUsable` has no `lease_pending`; an input while the job's lease still waits for the phone returns it, rather than `lease_required`, which would send the model to ask again.
35. **`RequestLease` on a suspended lease asks to resume** (Task 9). §3.6 gives the same job "the existing lease (or `lease_pending`)". When the job's lease is suspended and its resume request has lapsed, `RequestLease` sends a fresh resume request (the same lease id, `max_minutes` = the time left) and waits for it.
36. **Which turns get GUI tools** (Task 13). Case turns: `ListApps` and `Screenshot` only (R-F5-4); the eight acting tools join `CASE_BLOCKED_TOOL_NAMES`. Wake-up turns: none. The spec is silent and a wake-up runs with nobody watching, so the conservative reading holds: `WAKEUP_BASE_TOOLS` is not extended, and a wake-up's `allowedToolNames` already excludes every other tool. A case's research children (`case-researcher`) keep their five tools: none. Delegate turns: all ten. The spec expects them there (§5.1's F4 row; job-scoped leases), so `DELEGATE_EXCLUDED_TOOLS` is not extended, and R-F5-3 gates the two calls that would reach the phone.
37. **Two error codes beyond §9: `job_required` and `job_closed`** (Tasks 1, 9, 13; R-F5-7). `job_required`: the run has neither a job id nor a chat id, so there is nothing to bind a lease to. `job_closed`: the lease's job is not open.
38. **When a `chat:` job is open** (Task 14). This is the plan's reading of R-F5-7 for chat ids; the ruling's words are "an unknown job closes the lease (it does not count as open)". For a job id `chat:<id>`, known means the chat exists in the history store (`core.context.getChat(id, { messages: false })` returns it). A deleted or never-existing chat, or a store that cannot be read, is closed. Without a rule of this kind a node-local chat could never hold a lease, which R-F5-3 expects it to.
39. **How a tool knows its run refuses unsafe calls** (Task 13; R-F5-3). The origin tools get is F3's three keys (`approvalOrigin` drops `kind` and `scopes`), so a tool cannot weigh scopes itself. It reads what main already carries for this purpose: `options.approvalRequester.refuseUnsafe === true`, set by `ToolExecutor#_rethreadedRequester` for a run whose `refuseUnsafe` option `DelegateSessions` computed with `shouldRefuseUnsafe(origin, nodeConfig)`, and inherited by that run's sub-agents. The refusal is main's `REFUSE_UNSAFE_MESSAGE`, word for word, so it names the missing scope and never says "phone approval denied".
40. **An unsafe `LaunchApp` from a paired desktop** (Task 13). An attached desktop's turn runs in the service with a local origin, and main gives such a run the on-screen dialog, not the phone (`approvalSeam`). The spec's audit field `approved_by` is `allowlist` or `phone`; it gains `desktop`, and a refusal names who was asked (`denied: approval denied at the desktop`, `denied: phone approval denied`). `RequestLease` always goes to the phone, whatever the origin.
41. **The watch reply carries the mailbox position** (Tasks 11, 23, 25; R-F5-6). `GET …/views?after_seq&wait` returns as soon as anything newer than `after_seq` is listed, and a lease's earlier statuses are listed for five minutes, so a first fetch with `wait` alone returns at once, without the frame. The relay's `202` for `POST …/watch` therefore adds `after_seq`: the mailbox's sequence number, read before the node hears the watch. Android fetches views from there with the existing `wait` parameter. iOS ignores the field. It is relay transport and part of no signed message.
42. **Android under R-F5-5 and R-F5-6** (Task 25). The app repeats no send: Stop, Allow, Deny and Refresh each sign and send once. A send with no answer (no network, `503 node_offline`, a timeout) sets a "not confirmed" line beside its button, which stays enabled. A `lease` push sets a notice and shows the Pending tab; the owner's tap on "Check for computer-use requests" is what fetches. Refresh uses `wait=5` (`Leases.REFRESH_WAIT_S`): the node captures within one 250 ms tick of the watch unless another capture ran in the last second (the 1 frame/s budget), may capture once more at lower quality, and sends the view over the relay link; a status change (suspended, ended) ends the wait at once; 5 s stays far below the relay's 25 s cap and the 60 s life of the watch. The value is a judgement, not a measurement: it is one constant, and Task 25's hand check against a real node is where it is confirmed or changed. With no frame after 5 s the screen says so and the owner taps again.
43. **Per-job broker state needs a job** (Task 8; R-F5-7). A run with no job id can still list, launch, close and screenshot, but the broker records no launched pid for it (its `CloseApp force` never kills) and keeps none of its screenshots (no click can ever map onto one). Otherwise every such run would share one bucket.
44. **`readline` is not used for worker replies** (Task 16). `readline` also ends a line at U+2028 and U+2029, which JXA's `JSON.stringify` leaves raw inside strings (a window title can hold one). A reply split that way would be dropped and its op would time out. `LineWorker` splits on `\n` itself.

## Tasks, review weight and where each can be checked

`trust`: an error here grants something or leaks something (owner trust, signatures, leases, scopes, what leaves the machine, privilege and install); it gets the strongest reviewer. `standard`: everything else. The last column says what this stage's work machine (Windows) cannot run.

| Part | Task | What | Review | Not checkable on Windows |
|---|---|---|---|---|
| 1 | 1 | `GuiError`, `node.yaml` `gui:`, doctor row, profile-graph rules | standard | — |
| 1 | 2 | App allowlist: `resolveLaunch` tiers, foreground match sets | trust | — |
| 1 | 3 | Key grammar and text guard | trust | — |
| 1 | 4 | `kl-session-v1` framing, proofs, sealing, vectors, protocol doc | trust | — |
| 1 | 5 | Session secret, per-user copies, endpoint, user resolution | trust | The POSIX cases (modes, owners, hostile symlinks) are skipped; the junction case runs |
| 1 | 6 | `lease-v1` messages, grant/revoke/watch checks, 26 vectors, doc | trust | — |
| 2 | 7 | Helper channel (service) and helper connection | trust | The Unix-socket branch (`chmod 0666`, the symlink refusal); the named-pipe branch runs |
| 2 | 8 | `status.json` and the GUI broker | trust | — |
| 2 | 9 | Lease manager | trust | — |
| 2 | 10 | Live view | trust | — |
| 2 | 11 | Relay routes for leases | trust | — |
| 3 | 12 | Images in tool results | trust | — |
| 3 | 13 | The ten GUI tools; scope and case rules | trust | — |
| 3 | 14 | GUI subsystem and host wiring | trust | — |
| 4 | 15 | Helper process | standard | The POSIX insecure-file case is skipped |
| 4 | 16 | Windows backend | trust | — (the real worker suite runs here) |
| 4 | 17 | macOS backend | trust | The JXA worker suite needs macOS (and its permissions); only the fake-tool plumbing runs. Deviation 27 can only be confirmed there |
| 4 | 18 | Linux X11 and Wayland backends | trust | The real-X11 suite needs Linux with `DISPLAY` and `xdotool`; the scripted suite runs |
| 5 | 19 | Login start | trust | The user-side writer suite is POSIX only; the uid/gid drop is asserted only against a fake `spawnSync`; no test touches a real task, LaunchAgent or autostart entry |
| 5 | 20 | `session` CLI | trust | The POSIX socket-dir assertions; no test runs a real elevated install on any OS |
| 5 | 21 | Opt-in e2e, `CLAUDE.md`, the full suite | standard | The macOS leg of the e2e (the Windows leg runs here with `KL_E2E_GUI=1`, in an interactive session) |
| 6 | 22 | `lease-v1` in the iOS protocol core | trust | All of it: `swift test` needs macOS |
| 6 | 23 | `lease-v1` in the Android protocol core | trust | Runs with a JDK 17 (`../gradlew test`); not without one |
| 6 | 24 | iOS app | trust | The build and the hand checks need a Mac and a device or simulator; `mobile-lease-apps` runs anywhere |
| 6 | 25 | Android app | trust | The build needs the Android SDK; the hand checks need a phone with a fingerprint or face unlock; `mobile-lease-apps` runs anywhere |

---

### Task 1: GUI errors, `gui:` configuration and the module-graph rules

**Review:** standard. **On Windows:** all of it can be checked (the two `chmod` lines in the test are POSIX only).

**Files:**
- Create: `src/gui/errors.js`
- Create: `src/gui/config.js`
- Modify: `src/service/node-config.js` (require + `NODE_YAML_KEYS` + `defaultNodeConfig` + return value)
- Modify: `src/service/doctor.js` (a `gui` warnings row after "node configuration loaded")
- Modify: `tests/service-profile-graph.test.js` (forbid `src/gui/` and `src/session/` with the Deviation 8 exceptions)
- Test: `tests/gui-config.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `src/gui/errors.js`: `class GuiError extends Error { code, detail, info }` (`new GuiError(code, detail = null, extra = {})`, message `code` or `code: detail`); `GUI_ERROR_CODES` (frozen array); `isGuiError(err) → boolean`; `toToolResult(err) → { ok: false, error, retry_after? }` (`approval_unavailable` → `'signed approval unavailable'`, a non-GuiError → `'gui_error: <message>'`); `fromWire(error) → GuiError` (helper `res.error` `{ code, message, detail }`; unknown code → `backend_failed`; `info` = the wire `detail` object).
  - `src/gui/config.js`: `parseGuiConfig(raw, { profile = 'agent', platform = process.platform, file = 'node.yaml' }) → GuiConfig`; `GUI_KEYS`; `APP_ID_RE`; `GUI_DEFAULTS`. `GuiConfig = { enabled, apps: { [id]: { id, name, path, processes: string[], args: string[] } }, screenshot: { maxWidth, quality }, liveView: { intervalS, maxWidth, quality, maxFrameBytes }, lease: { defaultMinutes, maxMinutes, yieldMs, maxInputsPerMinute }, warnings: string[] }`.
  - `loadNodeConfig(...)` returns `gui: GuiConfig`; `NODE_YAML_KEYS.top` includes `'gui'` and `NODE_YAML_KEYS.gui = GUI_KEYS.top`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-config.test.js`:

```js
// tests/gui-config.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig, GUI_KEYS } = require('../src/gui/config');
const { GuiError, GUI_ERROR_CODES, toToolResult, fromWire, isGuiError } = require('../src/gui/errors');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function configDirWith(yaml) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-config-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  fs.writeFileSync(path.join(config, 'node.yaml'), yaml, { mode: 0o644 });
  return config;
}

describe('GuiError', () => {
  it('carries a code and turns into a tool refusal', () => {
    const err = new GuiError('capability_unavailable', 'gui');
    assert.ok(isGuiError(err));
    assert.equal(err.message, 'capability_unavailable: gui');
    assert.deepEqual(toToolResult(err), { ok: false, error: 'capability_unavailable: gui' });
    assert.deepEqual(toToolResult(new GuiError('approval_unavailable')), { ok: false, error: 'signed approval unavailable' });
    assert.deepEqual(toToolResult(new GuiError('rate_limited', null, { retryAfter: 7 })), { ok: false, error: 'rate_limited', retry_after: 7 });
    assert.deepEqual(toToolResult(new Error('boom')), { ok: false, error: 'gui_error: boom' });
  });

  it('maps helper errors, and an unknown code to backend_failed', () => {
    const e = fromWire({ code: 'foreground_mismatch', message: 'x', detail: { image: 'C:\\Windows\\explorer.exe', pid: 4 } });
    assert.equal(e.code, 'foreground_mismatch');
    assert.deepEqual(e.info, { image: 'C:\\Windows\\explorer.exe', pid: 4 });
    assert.equal(fromWire({ code: 'rm -rf', message: 'x' }).code, 'backend_failed');
    assert.equal(fromWire(null).code, 'backend_failed');
  });

  it('R-F5-7: has the two job codes', () => {
    assert.ok(GUI_ERROR_CODES.includes('job_required'));
    assert.ok(GUI_ERROR_CODES.includes('job_closed'));
    assert.deepEqual(toToolResult(new GuiError('job_required', 'this run has no job or chat to bind a lease to')), { ok: false, error: 'job_required: this run has no job or chat to bind a lease to' });
  });
});

describe('parseGuiConfig', () => {
  it('fills every default on an agent node', () => {
    const g = parseGuiConfig(undefined, { profile: 'agent', platform: 'linux' });
    assert.equal(g.enabled, true);
    assert.deepEqual(g.apps, {});
    assert.deepEqual(g.screenshot, { maxWidth: 1280, quality: 70 });
    assert.deepEqual(g.liveView, { intervalS: 3, maxWidth: 960, quality: 60, maxFrameBytes: 184320 });
    assert.deepEqual(g.lease, { defaultMinutes: 15, maxMinutes: 60, yieldMs: 2000, maxInputsPerMinute: 120 });
    assert.deepEqual(g.warnings, []);
  });

  it('is forced off on the runbook and frontdoor profiles, even when written', () => {
    for (const profile of ['runbook', 'frontdoor']) {
      const g = parseGuiConfig({ enabled: true, apps: { calc: '/usr/bin/gnome-calculator' } }, { profile, platform: 'linux' });
      assert.equal(g.enabled, false);
      assert.deepEqual(g.apps, {});
    }
  });

  it('reads the string shorthand and the full form', () => {
    const g = parseGuiConfig({
      apps: {
        textedit: '/System/Applications/TextEdit.app',
        calculator: { name: 'Calculator', path: '/System/Applications/Calculator.app', processes: ['/System/Applications/Calculator.app/Contents/MacOS/*'], args: ['--x=*'] }
      }
    }, { platform: 'darwin' });
    assert.deepEqual(g.apps.textedit, { id: 'textedit', name: 'textedit', path: '/System/Applications/TextEdit.app', processes: [], args: [] });
    assert.equal(g.apps.calculator.name, 'Calculator');
    assert.deepEqual(g.apps.calculator.args, ['--x=*']);
  });

  it('warns about a bare process basename and accepts it', () => {
    const g = parseGuiConfig({ apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] } } }, { platform: 'win32' });
    assert.deepEqual(g.apps.calculator.processes, ['CalculatorApp.exe']);
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /gui\.apps\.calculator\.processes.*CalculatorApp\.exe.*bare name/);
  });

  it('refuses malformed keys, with the key path named', () => {
    const bad = [
      [{ nope: 1 }, /unknown key "gui\.nope"/],
      [{ apps: { Calc: '/usr/bin/x' } }, /gui\.apps\.Calc/],
      [{ apps: { calc: { path: '/usr/bin/x', colour: 'red' } } }, /unknown key "gui\.apps\.calc\.colour"/],
      [{ apps: { calc: 'relative/x' } }, /absolute path/],
      [{ apps: { calc: '/usr/../bin/x' } }, /"\.\."/],
      [{ apps: { calc: '/usr/bin/x\u2215y' } }, /lookalike/],
      [{ screenshot: { max_width: 100 } }, /gui\.screenshot\.max_width must be an integer from 320 to 1920/],
      [{ live_view: { max_frame_bytes: 200000 } }, /gui\.live_view\.max_frame_bytes/],
      [{ lease: { default_minutes: 30, max_minutes: 20 } }, /default_minutes must not exceed gui\.lease\.max_minutes/],
      [{ apps: { calc: { path: '/usr/bin/x', processes: Array(17).fill('/usr/bin/y') } } }, /at most 16/],
      [{ enabled: 'yes' }, /gui\.enabled must be true or false/],
      ['on', /gui must be a mapping/]
    ];
    for (const [raw, re] of bad) assert.throws(() => parseGuiConfig(raw, { platform: 'linux', file: '/etc/king-louie/node.yaml' }), re, JSON.stringify(raw));
  });

  it('needs an .exe on Windows', () => {
    assert.throws(() => parseGuiConfig({ apps: { calc: 'C:\\Tools\\calc.bat' } }, { platform: 'win32' }), /\.exe/);
    assert.throws(() => parseGuiConfig({ apps: { calc: '\\\\server\\share\\calc.exe' } }, { platform: 'win32' }), /absolute path/);
  });

  it('exposes its key lists', () => {
    assert.deepEqual(GUI_KEYS.top, ['enabled', 'apps', 'screenshot', 'live_view', 'lease']);
  });
});

describe('node.yaml gui:', () => {
  it('loadNodeConfig parses gui and lists it in NODE_YAML_KEYS', () => {
    assert.ok(NODE_YAML_KEYS.top.includes('gui'));
    assert.deepEqual(NODE_YAML_KEYS.gui, GUI_KEYS.top);
    const appPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\notepad.exe' : '/usr/bin/gedit';
    const config = configDirWith(`name: mac\nprofile: agent\ngui:\n  apps:\n    notes: '${appPath}'\n`);
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.equal(node.gui.apps.notes.path, appPath);
  });

  it('a runbook node.yaml with gui loads, with gui off', () => {
    const config = configDirWith('name: web-01\nprofile: runbook\ngui:\n  enabled: true\n');
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, false);
  });

  it('a malformed gui block stops the node from loading', () => {
    const config = configDirWith('name: mac\ngui:\n  bogus: 1\n');
    assert.throws(() => loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 }), /unknown key "gui\.bogus"/);
  });

  it('no node.yaml at all still gives the gui defaults', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-none-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const node = loadNodeConfig({ adminConfigDir: base, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.deepEqual(node.gui.apps, {});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-config.test.js`
Expected: FAIL with `Cannot find module '../src/gui/config'`.

- [ ] **Step 3: Write `src/gui/errors.js`**

```js
// src/gui/errors.js
// Fleet stage 5 error codes (spec §9). A GuiError's code is what a GUI tool
// returns as { ok: false, error: '<code>[: detail]' }; the session helper
// sends the same codes over kl-session-v1 in res.error.code. Dependency-free:
// the runbook profile loads this file through src/gui/config.js.
const GUI_ERROR_CODES = Object.freeze([
  'capability_unavailable', 'invalid_params', 'app_not_allowlisted', 'app_type_not_supported', 'file_not_found',
  'path_changed', 'app_required', 'app_not_running', 'stale_screenshot', 'window_minimized', 'outside_window',
  'point_obscured', 'foreground_mismatch', 'user_active', 'screen_locked', 'target_elevated', 'invalid_text',
  'text_matches_always_confirm', 'text_looks_secret', 'key_invalid', 'key_denied', 'middle_click_denied',
  'rate_limited', 'lease_required', 'lease_suspended', 'lease_expired', 'lease_revoked', 'lease_busy',
  'lease_pending', 'lease_denied', 'lease_request_expired', 'job_required', 'job_closed', 'approval_unavailable', 'helper_disconnected',
  'helper_already_connected', 'frame_rejected', 'auth_failed', 'op_timeout', 'unknown_op', 'backend_failed',
  'session_not_installed', 'session_file_insecure', 'session_user_mismatch', 'unsafe_path', 'user_not_found',
  'home_missing', 'cancelled'
]);

class GuiError extends Error {
  constructor(code, detail = null, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GuiError';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
    this.info = {};
    Object.assign(this, extra);
  }
}

function isGuiError(err) {
  return err instanceof GuiError || Boolean(err && err.name === 'GuiError' && typeof err.code === 'string');
}

// F3's refusal words for "no phone can sign" are kept exactly.
function toToolResult(err) {
  if (!isGuiError(err)) return { ok: false, error: `gui_error: ${err && err.message ? err.message : String(err)}` };
  if (err.code === 'approval_unavailable') return { ok: false, error: 'signed approval unavailable' };
  const out = { ok: false, error: err.message };
  if (err.retryAfter !== undefined) out.retry_after = err.retryAfter;
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A helper's res.error: { code, message, detail }. The helper is the user's
// process, so an unknown code never becomes one the service acts on.
function fromWire(error) {
  const code = isPlainObject(error) && GUI_ERROR_CODES.includes(error.code) ? error.code : 'backend_failed';
  return new GuiError(code, null, { info: isPlainObject(error) && isPlainObject(error.detail) ? error.detail : {} });
}

module.exports = { GuiError, GUI_ERROR_CODES, isGuiError, toToolResult, fromWire };
```

- [ ] **Step 4: Write `src/gui/config.js`**

```js
// src/gui/config.js
// node.yaml `gui:` (fleet stage 5 spec §4.4). Read only from the admin config
// dir by loadNodeConfig; a present but malformed key throws with its path,
// as everywhere else in node.yaml. Dependency-free (the runbook and
// front-door profiles load it through node-config.js).
const path = require('path');

const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const GUI_KEYS = Object.freeze({
  top: Object.freeze(['enabled', 'apps', 'screenshot', 'live_view', 'lease']),
  app: Object.freeze(['name', 'path', 'processes', 'args']),
  screenshot: Object.freeze(['max_width', 'quality']),
  live_view: Object.freeze(['interval_s', 'max_width', 'quality', 'max_frame_bytes']),
  lease: Object.freeze(['default_minutes', 'max_minutes', 'yield_ms', 'max_inputs_per_minute'])
});
// [min, max, default, camelCase name] per key.
const RANGES = Object.freeze({
  screenshot: { max_width: [320, 1920, 1280, 'maxWidth'], quality: [30, 90, 70, 'quality'] },
  live_view: {
    interval_s: [1, 5, 3, 'intervalS'], max_width: [320, 1280, 960, 'maxWidth'],
    quality: [30, 85, 60, 'quality'], max_frame_bytes: [32768, 184320, 184320, 'maxFrameBytes']
  },
  lease: {
    default_minutes: [1, 60, 15, 'defaultMinutes'], max_minutes: [1, 60, 60, 'maxMinutes'],
    yield_ms: [0, 10000, 2000, 'yieldMs'], max_inputs_per_minute: [10, 600, 120, 'maxInputsPerMinute']
  }
});
const SECTION_NAMES = { screenshot: 'screenshot', live_view: 'liveView', lease: 'lease' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultsFor(section) {
  const out = {};
  for (const [, [, , def, name]] of Object.entries(RANGES[section])) out[name] = def;
  return out;
}

const GUI_DEFAULTS = Object.freeze({
  screenshot: Object.freeze(defaultsFor('screenshot')),
  liveView: Object.freeze(defaultsFor('live_view')),
  lease: Object.freeze(defaultsFor('lease'))
});

function disabled() {
  return {
    enabled: false,
    apps: {},
    screenshot: { ...GUI_DEFAULTS.screenshot },
    liveView: { ...GUI_DEFAULTS.liveView },
    lease: { ...GUI_DEFAULTS.lease },
    warnings: []
  };
}

function parseGuiConfig(raw, { profile = 'agent', platform = process.platform, file = 'node.yaml' } = {}) {
  const invalid = (what) => new Error(`Invalid ${file}: ${what}`);
  const unknownKey = (keyPath, known) => new Error(`Invalid ${file}: unknown key "${keyPath}" (known: ${known.join(', ')})`);
  const checkKeys = (obj, known, prefix) => {
    for (const key of Object.keys(obj)) if (!known.includes(key)) throw unknownKey(`${prefix}${key}`, known);
  };

  // Neither profile runs a session helper (§3.4, Deviation 9).
  if (profile !== 'agent') return disabled();
  const out = { ...disabled(), enabled: true };
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) throw invalid('gui must be a mapping');
  checkKeys(raw, GUI_KEYS.top, 'gui.');

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw invalid('gui.enabled must be true or false');
    out.enabled = raw.enabled;
  }

  for (const section of ['screenshot', 'live_view', 'lease']) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isPlainObject(value)) throw invalid(`gui.${section} must be a mapping`);
    checkKeys(value, GUI_KEYS[section], `gui.${section}.`);
    const target = out[SECTION_NAMES[section]];
    for (const [key, [min, max, , name]] of Object.entries(RANGES[section])) {
      if (value[key] === undefined) continue;
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
        throw invalid(`gui.${section}.${key} must be an integer from ${min} to ${max}`);
      }
      target[name] = value[key];
    }
  }
  if (out.lease.defaultMinutes > out.lease.maxMinutes) {
    throw invalid('gui.lease.default_minutes must not exceed gui.lease.max_minutes');
  }

  if (raw.apps !== undefined) {
    if (!isPlainObject(raw.apps)) throw invalid('gui.apps must be a mapping');
    for (const [id, value] of Object.entries(raw.apps)) {
      if (!APP_ID_RE.test(id)) throw invalid(`gui.apps.${id}: an app id must match ${APP_ID_RE}`);
      out.apps[id] = parseApp(id, value, { platform, invalid, checkKeys, warnings: out.warnings });
    }
  }
  return out;
}

function checkPath(value, where, platform, invalid, { exeOnly }) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${where} must be a non-empty string`);
  if (LOOKALIKE.test(value)) throw invalid(`${where} contains a null byte or a slash lookalike`);
  const absolute = platform === 'win32' ? /^[A-Za-z]:\\/.test(value) : value.startsWith('/');
  if (!absolute) throw invalid(`${where} must be an absolute path`);
  if (value.split(/[\\/]/).includes('..')) throw invalid(`${where} must not contain ".."`);
  if (exeOnly && platform === 'win32' && !/\.exe$/i.test(value)) throw invalid(`${where} must name an .exe on Windows`);
  return platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value);
}

function stringList(value, where, max, invalid) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) throw invalid(`${where} must be a list of non-empty strings`);
  if (value.length > max) throw invalid(`${where} may have at most ${max} entries`);
  return [...value];
}

function parseApp(id, value, { platform, invalid, checkKeys, warnings }) {
  const where = `gui.apps.${id}`;
  const entry = typeof value === 'string' ? { path: value } : value;
  if (!isPlainObject(entry)) throw invalid(`${where} must be a path or a mapping`);
  checkKeys(entry, GUI_KEYS.app, `${where}.`);
  const appPath = checkPath(entry.path, `${where}.path`, platform, invalid, { exeOnly: true });
  let name = id;
  if (entry.name !== undefined) {
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 64) throw invalid(`${where}.name must be 1–64 characters`);
    name = entry.name.trim();
  }
  const processes = stringList(entry.processes, `${where}.processes`, 16, invalid).map((p) => {
    if (LOOKALIKE.test(p) || p.split(/[\\/]/).includes('..')) throw invalid(`${where}.processes: "${p}" contains "..", a null byte or a slash lookalike`);
    if (!/[\\/]/.test(p)) {
      warnings.push(`${where}.processes: "${p}" is a bare name; any process with that name matches (use an absolute path or glob when you can)`);
      return p;
    }
    return checkPath(p, `${where}.processes`, platform, invalid, { exeOnly: false });
  });
  const args = stringList(entry.args, `${where}.args`, 32, invalid);
  return { id, name, path: appPath, processes, args };
}

module.exports = { parseGuiConfig, GUI_KEYS, GUI_DEFAULTS, APP_ID_RE };
```

Note: `checkPath` for a process glob such as `/System/Applications/Calculator.app/Contents/MacOS/*` normalises it with `path.posix.normalize`, which keeps the `*`.

- [ ] **Step 5: Wire `gui` into `src/service/node-config.js`**

Add the require under the existing `parseFrontDoorConfig` require:

```js
const { parseGuiConfig, GUI_KEYS } = require('../gui/config');
```

In `NODE_YAML_KEYS`, add `'gui'` to the end of `top` and append a `gui` level; leave every other entry exactly as main has it (the comment above the constant already says "stage 5 `gui`"). On main `532efcf` the result reads:

```js
const NODE_YAML_KEYS = Object.freeze({
  top: Object.freeze(['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir', 'approvers', 'frontdoor', 'delegate', 'gui']),
  policy: Object.freeze(['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']),
  remote_sessions: Object.freeze(['always_confirm', 'deny']),
  approvers: Object.freeze(['relay', 'request_ttl_s']),
  // Fleet stage 4 (R11): the front door's own block (its deeper levels are
  // checked by parseFrontDoorConfig) and an agent node's delegate sessions.
  frontdoor: FRONTDOOR_KEYS.top,
  delegate: Object.freeze(['provider', 'model', 'agent', 'idle_close', 'cwd', 'max_sessions']),
  // Fleet stage 5: desktop apps and leases; deeper levels are checked by parseGuiConfig.
  gui: GUI_KEYS.top
});
```

In `defaultNodeConfig(adminDir)`, add after `delegate`:

```js
    delegate: { ...DEFAULT_DELEGATE },
    gui: parseGuiConfig(undefined, { profile: 'agent' })
```

In `loadNodeConfig`'s return object, add after `delegate`:

```js
    delegate: parseDelegate(parsed.delegate, invalid, configFile),
    gui: parseGuiConfig(parsed.gui, { profile, file: configFile })
```

- [ ] **Step 6: Add the doctor row**

In `src/service/doctor.js`, right after the line that starts `results.push({ check: 'node configuration loaded',`:

```js
    // Fleet stage 5 §3.4: gui.apps entries that match by bare process name.
    for (const warning of (nodeCfg.gui && nodeCfg.gui.warnings) || []) {
      results.push({ check: 'gui app allowlist', ok: true, warn: true, detail: warning });
    }
```

- [ ] **Step 7: Forbid `src/gui/` and `src/session/` in the profile graphs**

In `tests/service-profile-graph.test.js`, below the `const FORBIDDEN = [` declaration, add:

```js
// Fleet stage 5 (Deviation 8): node-config.js needs gui/config.js on every
// profile and fleet/start.js reads gui/status.js; both are dependency-free.
// The relay and the front door also load the lease routes.
const GUI_ALLOWED = ['src/gui/config.js', 'src/gui/errors.js', 'src/gui/status.js'];
const RELAY_GUI_ALLOWED = [...GUI_ALLOWED, 'src/gui/relay-extension.js', 'src/gui/lease-protocol.js'];
const guiLeak = (p, allowed) => (p.startsWith('src/gui/') && !allowed.includes(p)) || p.startsWith('src/session/');
```

Then extend each of the file's five `const bad = loaded.filter(…)` lines, keeping what each already tests (main added an `assert.ok(!loaded.includes('src/mcp/case-tools.js'), …)` line above the two mcp filters; leave those):

- runbook graph (`FORBIDDEN.some(…)` alone): add `|| guiLeak(p, GUI_ALLOWED)`.
- relay graph (`FORBIDDEN.some(…) || p.startsWith('src/core/')`): add `|| guiLeak(p, RELAY_GUI_ALLOWED)`.
- frontdoor graph (`FRONTDOOR_FORBIDDEN.some(…)`): add `|| guiLeak(p, RELAY_GUI_ALLOWED)`.
- both mcp graphs (the one that lists `src/core/`, `src/providers/`, `src/tools/`, `src/mesh/mesh-discovery`, and the courier one with `forbidden.some(…)`): add `|| guiLeak(p, GUI_ALLOWED)` to each.

`src/gui/lease-protocol.js` requires `src/approvals/verify-device.js`, which the relay already loads; Task 11 keeps `relay-extension.js`'s own requires to `envelope.js` and `lease-protocol.js`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/gui-config.test.js tests/service-profile-graph.test.js tests/examples.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/gui/errors.js src/gui/config.js src/service/node-config.js src/service/doctor.js tests/gui-config.test.js tests/service-profile-graph.test.js
git commit -m "feat(gui): gui errors and the node.yaml gui block

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The app allowlist — `resolveLaunch` and foreground match sets

**Review:** trust (it decides which launches run without the phone). **On Windows:** all of it can be checked.

**Batchable:** yes — with Task 3 (both are pure validation modules with table-driven tests and no shared interface).

**Files:**
- Create: `src/gui/apps.js`
- Test: `tests/gui-apps.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `patternMatch` (`src/execution/tool-patterns.js`); `realResolve`, `isPathUnderRoots` (`src/platform/path-roots.js`).
- Produces (`src/gui/apps.js`):
  - `resolveLaunch(guiConfig, policy, { app, args = [], files = [] }, { platform = process.platform, statSync = fs.statSync, realpath = realResolve } = {}) → { tier: 'routine'|'unsafe', reason, appId: string|null, exe, argv: string[], match: string[], files: string[] }`; throws `GuiError('invalid_params'|'file_not_found'|'app_type_not_supported')`.
  - `imageMatches(image, patterns, platform) → boolean`.
  - `matchSetFor(guiConfig, appIds, { realpath }) → string[]` (the union of the apps' match sets).
  - `assertPathsUnchanged({ exe, files }, { realpath = fs.realpathSync.native, platform }) → void`; throws `GuiError('path_changed', path)`. Used by the helper at spawn (Task 15).

- [ ] **Step 1: Write the failing test**

Create `tests/gui-apps.test.js`:

```js
// tests/gui-apps.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig } = require('../src/gui/config');
const { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged } = require('../src/gui/apps');

// Native realpath: resolveLaunch resolves with it, and a Windows CI TEMP is a short path.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-apps-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const plat = process.platform === 'win32' ? 'win32' : 'linux';
const exe = path.join(base, plat === 'win32' ? 'tool.exe' : 'tool');
const other = path.join(base, plat === 'win32' ? 'other.exe' : 'other');
const work = path.join(base, 'work');
const outside = path.join(base, 'outside');
fs.writeFileSync(exe, '');
fs.writeFileSync(other, '');
fs.mkdirSync(work);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(work, 'in.txt'), 'x');
fs.writeFileSync(path.join(outside, 'out.txt'), 'x');

const gui = parseGuiConfig({ apps: { tool: { path: exe, processes: ['helper-*.bin'], args: ['--open=*', '--quiet'] } } }, { platform: plat });
const policy = { allowed_roots: [work] };
const opts = { platform: plat };

describe('resolveLaunch', () => {
  it('an allowlisted app with no args and files is routine', () => {
    const r = resolveLaunch(gui, policy, { app: 'tool' }, opts);
    assert.deepEqual({ tier: r.tier, reason: r.reason, appId: r.appId, exe: r.exe, argv: r.argv, files: r.files }, { tier: 'routine', reason: 'allowlisted', appId: 'tool', exe, argv: [], files: [] });
    assert.deepEqual(r.match, [exe, 'helper-*.bin']);
  });

  it('args must all match the app globs; files must be under allowed_roots', () => {
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', args: ['--open=a', '--quiet'] }, opts).tier, 'routine');
    const a = resolveLaunch(gui, policy, { app: 'tool', args: ['--exec=calc'] }, opts);
    assert.deepEqual([a.tier, a.reason], ['unsafe', 'args_not_allowlisted']);
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'in.txt')] }, opts).tier, 'routine');
    const f = resolveLaunch(gui, policy, { app: 'tool', files: [path.join(outside, 'out.txt')] }, opts);
    assert.deepEqual([f.tier, f.reason], ['unsafe', 'file_outside_allowed_roots']);
  });

  it('an absolute path that is not allowlisted is unsafe with no app id', () => {
    const r = resolveLaunch(gui, policy, { app: other }, opts);
    assert.deepEqual([r.tier, r.reason, r.appId, r.exe], ['unsafe', 'app_not_allowlisted', null, other]);
  });

  it('refuses relative paths, "..", null bytes and slash lookalikes as invalid_params', () => {
    for (const app of ['tool.exe', 'bin/tool', `${base}${path.sep}..${path.sep}x`, `${exe}\u0000`, `${base}\u2215tool`]) {
      assert.throws(() => resolveLaunch(gui, policy, { app }, opts), (e) => e.code === 'invalid_params', app);
    }
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: ['in.txt'] }, opts), (e) => e.code === 'invalid_params');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', args: Array(33).fill('--quiet') }, opts), (e) => e.code === 'invalid_params');
  });

  it('a missing file is file_not_found', () => {
    assert.throws(() => resolveLaunch(gui, policy, { app: path.join(base, plat === 'win32' ? 'missing.exe' : 'missing') }, opts), (e) => e.code === 'file_not_found');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'nope.txt')] }, opts), (e) => e.code === 'file_not_found');
  });

  it('only .exe on Windows', () => {
    const fake = { statSync: () => ({ isFile: () => true, isDirectory: () => false }), realpath: (p) => p };
    const winGui = parseGuiConfig({}, { platform: 'win32' });
    assert.throws(() => resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.bat' }, { platform: 'win32', ...fake }), (e) => e.code === 'app_type_not_supported');
    assert.equal(resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.exe' }, { platform: 'win32', ...fake }).tier, 'unsafe');
  });

  it('a .app bundle directory is launchable on macOS', () => {
    const fake = { statSync: () => ({ isFile: () => false, isDirectory: () => true }), realpath: (p) => p };
    const r = resolveLaunch(parseGuiConfig({}, { platform: 'darwin' }), policy, { app: '/Applications/Notes.app' }, { platform: 'darwin', ...fake });
    assert.equal(r.exe, '/Applications/Notes.app');
  });
});

describe('imageMatches', () => {
  it('absolute paths and globs; bare names compare the basename', () => {
    assert.ok(imageMatches('/usr/bin/gedit', ['/usr/bin/gedit'], 'linux'));
    assert.ok(imageMatches('/opt/app/bin/helper-7.bin', ['helper-*.bin'], 'linux'));
    assert.ok(!imageMatches('/usr/bin/GEDIT', ['/usr/bin/gedit'], 'linux'), 'exact on Linux');
    assert.ok(imageMatches('C:\\Program Files\\WindowsApps\\X\\CalculatorApp.exe', ['calculatorapp.exe'], 'win32'), 'case-insensitive on Windows');
    assert.ok(!imageMatches('C:\\Windows\\explorer.exe', ['C:\\Windows\\System32\\calc.exe', 'CalculatorApp.exe'], 'win32'));
  });

  it('on macOS any image inside the .app bundle matches', () => {
    assert.ok(imageMatches('/System/Applications/Calculator.app/Contents/MacOS/Calculator', ['/System/Applications/Calculator.app'], 'darwin'));
    assert.ok(!imageMatches('/System/Applications/Calculator.app.evil/x', ['/System/Applications/Calculator.app'], 'darwin'));
  });

  it('refuses an empty image', () => {
    assert.ok(!imageMatches('', ['*'], 'linux'));
    assert.ok(!imageMatches(null, ['*'], 'linux'));
  });
});

describe('matchSetFor and assertPathsUnchanged', () => {
  it('unions the leased apps', () => {
    assert.deepEqual(matchSetFor(gui, ['tool'], { realpath: (p) => p }), [exe, 'helper-*.bin']);
  });

  it('refuses a path that resolves elsewhere at spawn', () => {
    assert.doesNotThrow(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat }));
    assert.throws(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat, realpath: () => other }), (e) => e.code === 'path_changed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-apps.test.js`
Expected: FAIL with `Cannot find module '../src/gui/apps'`.

- [ ] **Step 3: Write `src/gui/apps.js`**

```js
// src/gui/apps.js
// The app allowlist (fleet stage 5 spec §3.4): what LaunchApp may start and
// at what tier, and which process images count as "the leased app" in the
// foreground. Shared with the helper (assertPathsUnchanged at spawn).
const fs = require('fs');
const path = require('path');
const { patternMatch } = require('../execution/tool-patterns');
const { realResolve, isPathUnderRoots } = require('../platform/path-roots');
const { GuiError } = require('./errors');

const LOOKALIKE = /[\u0000\u2215\u2216\uFF0F\uFF3C]/;
const MAX_APP = 1024;
const MAX_ITEM = 4096;

const pathImpl = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const caseInsensitive = (platform) => platform === 'win32' || platform === 'darwin';
const hasDotDot = (p) => String(p).split(/[\\/]/).includes('..');

function isAbsoluteFor(p, platform) {
  return platform === 'win32' ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/');
}

function stringArray(value, max, where) {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== 'string' || v.length > MAX_ITEM)) {
    throw new GuiError('invalid_params', `"${where}" must be at most ${max} strings of at most ${MAX_ITEM} characters`);
  }
  return value;
}

function resolveLaunch(guiConfig, policy, request = {}, { platform = process.platform, statSync = fs.statSync, realpath = realResolve } = {}) {
  const { app, args = [], files = [] } = request;
  if (typeof app !== 'string' || app.length < 1 || app.length > MAX_APP) throw new GuiError('invalid_params', '"app" must be 1–1024 characters');
  stringArray(args, 32, 'args');
  stringArray(files, 16, 'files');
  for (const v of [app, ...args, ...files]) {
    if (LOOKALIKE.test(v)) throw new GuiError('invalid_params', 'null bytes and slash lookalikes are not allowed');
  }

  const resolvedFiles = files.map((f) => {
    if (!isAbsoluteFor(f, platform) || hasDotDot(f)) throw new GuiError('invalid_params', `a file must be an absolute path without "..": ${f}`);
    try {
      statSync(f);
    } catch {
      throw new GuiError('file_not_found', f);
    }
    return realpath(f);
  });

  const entry = Object.hasOwn(guiConfig.apps, app) ? guiConfig.apps[app] : null;
  if (entry) {
    try {
      statSync(entry.path);
    } catch {
      throw new GuiError('file_not_found', entry.path);
    }
    const exe = realpath(entry.path);
    const argsOk = args.every((a) => entry.args.some((glob) => patternMatch(glob, a)));
    const roots = (policy && policy.allowed_roots) || [];
    const filesOk = resolvedFiles.every((f) => isPathUnderRoots(f, roots));
    let reason = 'allowlisted';
    if (!argsOk) reason = 'args_not_allowlisted';
    else if (!filesOk) reason = 'file_outside_allowed_roots';
    return {
      tier: argsOk && filesOk ? 'routine' : 'unsafe',
      reason,
      appId: entry.id,
      exe,
      argv: [...args],
      match: [exe, ...entry.processes],
      files: resolvedFiles
    };
  }

  if (!isAbsoluteFor(app, platform) || hasDotDot(app)) {
    throw new GuiError('invalid_params', '"app" must be an allowlisted app id or an absolute path without ".."');
  }
  if (platform === 'win32' && !/\.exe$/i.test(app)) throw new GuiError('app_type_not_supported', 'only .exe files can be launched on Windows');
  let st;
  try {
    st = statSync(app);
  } catch {
    throw new GuiError('file_not_found', app);
  }
  const launchable = platform === 'darwin' ? (st.isFile() || (st.isDirectory() && /\.app$/i.test(app))) : st.isFile();
  if (!launchable) throw new GuiError('app_type_not_supported', `${app} is not a file this node can launch`);
  const exe = realpath(app);
  return { tier: 'unsafe', reason: 'app_not_allowlisted', appId: null, exe, argv: [...args], match: [exe], files: resolvedFiles };
}

// `*` and `?` only; everything else literal. Anchored.
function globRegex(pattern) {
  const source = String(pattern).split('').map((ch) => {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`);
}

function imageMatches(image, patterns, platform = process.platform) {
  if (typeof image !== 'string' || image === '') return false;
  const impl = pathImpl(platform);
  const norm = (s) => (caseInsensitive(platform) ? String(s).toLowerCase() : String(s));
  const img = norm(image);
  for (const raw of patterns || []) {
    const p = norm(raw);
    const bare = !/[\\/]/.test(p);
    const target = bare ? norm(impl.basename(image)) : img;
    if (globRegex(p).test(target)) return true;
    if (platform === 'darwin' && /\.app$/.test(p) && !/[*?]/.test(p) && img.startsWith(`${p}/`)) return true;
  }
  return false;
}

function matchSetFor(guiConfig, appIds, { realpath = realResolve } = {}) {
  const out = [];
  for (const id of appIds) {
    const app = guiConfig.apps[id];
    if (!app) continue;
    let real = app.path;
    try {
      real = realpath(app.path);
    } catch {
      real = app.path;
    }
    for (const p of [real, ...app.processes]) if (!out.includes(p)) out.push(p);
  }
  return out;
}

function assertPathsUnchanged({ exe, files = [] }, { realpath = fs.realpathSync.native, platform = process.platform } = {}) {
  const same = (a, b) => (caseInsensitive(platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const p of [exe, ...files]) {
    let now;
    try {
      now = realpath(p);
    } catch {
      throw new GuiError('path_changed', `${p} no longer exists`);
    }
    if (!same(now, p)) throw new GuiError('path_changed', `${p} now resolves to ${now}`);
  }
}

module.exports = { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged, globRegex };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/gui-apps.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/gui/apps.js tests/gui-apps.test.js
git commit -m "feat(gui): app allowlist resolution and foreground match sets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The key grammar and the text guard

**Review:** trust (it decides what text and which keys may be sent into a leased app). **On Windows:** all of it can be checked.

**Batchable:** yes — with Task 2.

**Files:**
- Create: `src/gui/keys.js`
- Create: `src/gui/text-guard.js`
- Test: `tests/gui-keys.test.js`, `tests/gui-text-guard.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `patternMatch`, `SHELL_SEPARATORS` (`src/execution/tool-patterns.js`).
- Produces:
  - `src/gui/keys.js`: `parseKeys(keys, platform) → { mods: string[] (order ctrl, alt, shift, meta), key }` (throws `key_invalid`/`key_denied`); `printableChar(combo) → string | null`; `isEnter(combo) → boolean`; `checkButton(button, platform) → void` (throws `middle_click_denied` on Linux); `MODIFIERS`.
  - `src/gui/text-guard.js`: `checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '' }) → { ok: true } | { ok: false, code }`; `class TypedBuffer { value; append(text); reset() }` (last 2000 code points); `looksSecret(text, vaultValues) → boolean`; `isInvalidText(text) → boolean`; `MAX_TEXT = 2000`.

- [ ] **Step 1: Write the failing tests**

Create `tests/gui-keys.test.js`:

```js
// tests/gui-keys.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, printableChar, isEnter, checkButton } = require('../src/gui/keys');

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('parseKeys', () => {
  it('reads keys and modifier combinations, case-insensitively', () => {
    assert.deepEqual(parseKeys('enter', 'win32'), { mods: [], key: 'enter' });
    assert.deepEqual(parseKeys('Shift+Ctrl+S', 'win32'), { mods: ['ctrl', 'shift'], key: 's' });
    assert.deepEqual(parseKeys('f24', 'linux'), { mods: [], key: 'f24' });
    assert.deepEqual(parseKeys('ctrl+/', 'linux'), { mods: ['ctrl'], key: '/' });
    assert.deepEqual(parseKeys('meta+s', 'darwin'), { mods: ['meta'], key: 's' });
  });

  it('refuses what is not in the grammar as key_invalid', () => {
    for (const k of ['', 'hyper+a', 'ctrl+', '+a', 'f25', 'ctrl+ctrl+a', 'printscreen', 'a'.repeat(65), 'ctrl++']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_invalid', k);
    }
  });

  it('denies shell-level shortcuts everywhere', () => {
    for (const k of ['alt+tab', 'shift+alt+tab', 'ctrl+alt+delete', 'ctrl+alt+t', 'ctrl+shift+escape', 'ctrl+escape', 'alt+escape']) {
      for (const p of ['win32', 'darwin', 'linux']) assert.equal(code(() => parseKeys(k, p)), 'key_denied', `${k} on ${p}`);
    }
  });

  it('denies every clipboard chord, with extra modifiers too', () => {
    for (const k of ['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+shift+v', 'shift+insert', 'ctrl+insert', 'shift+delete', 'alt+ctrl+shift+c']) {
      assert.equal(code(() => parseKeys(k, 'win32')), 'key_denied', k);
    }
    for (const k of ['meta+c', 'meta+v', 'meta+x', 'meta+shift+v']) assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
  });

  it('denies meta on Windows and Linux, and the macOS system chords', () => {
    assert.equal(code(() => parseKeys('meta+r', 'win32')), 'key_denied');
    assert.equal(code(() => parseKeys('meta+l', 'linux')), 'key_denied');
    for (const k of ['meta+space', 'meta+tab', 'meta+alt+escape', 'ctrl+meta+q', 'ctrl+up', 'ctrl+right', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5']) {
      assert.equal(code(() => parseKeys(k, 'darwin')), 'key_denied', k);
    }
    assert.deepEqual(parseKeys('ctrl+up', 'win32'), { mods: ['ctrl'], key: 'up' }, 'ctrl+up is macOS-only');
  });
});

describe('printableChar and isEnter', () => {
  it('knows which presses type a character', () => {
    assert.equal(printableChar(parseKeys('a', 'linux')), 'a');
    assert.equal(printableChar(parseKeys('shift+a', 'linux')), 'A');
    assert.equal(printableChar(parseKeys('shift+1', 'linux')), '!');
    assert.equal(printableChar(parseKeys('space', 'linux')), ' ');
    assert.equal(printableChar(parseKeys('ctrl+a', 'linux')), null);
    assert.equal(printableChar(parseKeys('enter', 'linux')), null);
    assert.equal(isEnter(parseKeys('shift+enter', 'linux')), true);
  });
});

describe('checkButton', () => {
  it('refuses a middle click on Linux only', () => {
    assert.equal(code(() => checkButton('middle', 'linux')), 'middle_click_denied');
    assert.equal(code(() => checkButton('middle', 'win32')), null);
    assert.equal(code(() => checkButton('left', 'linux')), null);
  });
});
```

Create `tests/gui-text-guard.test.js`:

```js
// tests/gui-text-guard.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkTypeText, TypedBuffer, looksSecret, isInvalidText } = require('../src/gui/text-guard');
const { parseKeys, printableChar } = require('../src/gui/keys');

const ALWAYS = ['Bash(ssh *)', 'Bash(git push*)', 'Vault(*)', 'Bash(*deploy*)'];

describe('checkTypeText', () => {
  it('accepts ordinary text', () => {
    assert.deepEqual(checkTypeText('12+30=', { alwaysConfirm: ALWAYS }), { ok: true });
    assert.deepEqual(checkTypeText('Dear team,\n\tthe totals are in.', { alwaysConfirm: ALWAYS }), { ok: true });
  });

  it('invalid_text: empty, too long, control characters other than newline and tab', () => {
    for (const t of ['', 'a'.repeat(2001), 'a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 42]) {
      assert.deepEqual(checkTypeText(t), { ok: false, code: 'invalid_text' }, JSON.stringify(t));
    }
  });

  it('matches always_confirm details on the whole text, a line or a shell segment', () => {
    assert.equal(checkTypeText('git push origin main', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('cd x && git push origin', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('ls\nssh root@example.com', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('please redeploy now', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    // Bare names (no detail) are ignored, and a bare `*` detail (Vault(*)) is not a text rule.
    assert.deepEqual(checkTypeText('hello', { alwaysConfirm: ['Bash', 'Vault(*)'] }), { ok: true });
  });

  it('checks the text on its own too, so an earlier buffer cannot mask it', () => {
    assert.equal(checkTypeText('git push origin', { alwaysConfirm: ALWAYS, buffer: 'hello ' }).code, 'text_matches_always_confirm');
  });

  it('refuses secret-looking text with the pinned patterns', () => {
    const secrets = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'token sk-ant-abcdefgh12345678',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi',
      'Zx8#qL2!vN7$wK4%tR9^mB1&pC6*'
    ];
    for (const s of secrets) assert.equal(checkTypeText(s).code, 'text_looks_secret', s);
  });

  it('exempts a plain web URL from the entropy rule, but not one with userinfo', () => {
    assert.deepEqual(checkTypeText('https://example.com/a/B9x_7Qz-Lm3?q=Zr8&t=Wk2P'), { ok: true });
    assert.equal(checkTypeText('https://user:Zx8qL2vN7wK4tR9@example.com/a').code, 'text_looks_secret');
  });

  it('refuses any vault value of 8 characters or more as a substring', () => {
    assert.equal(checkTypeText('the code is hunter2hunter2 ok', { vaultValues: ['hunter2hunter2'] }).code, 'text_looks_secret');
    assert.deepEqual(checkTypeText('short abc', { vaultValues: ['abc'] }), { ok: true });
  });

  it('Review Focus 4: CJK prose and emoji are not secrets; length counts code points', () => {
    assert.deepEqual(checkTypeText('東京の会議は2026年9月25日にZoomで行います担当者は田中さんです'), { ok: true });
    assert.deepEqual(checkTypeText('这个季度的销售额增长了15个百分点主要来自华东地区的新客户'), { ok: true });
    assert.deepEqual(checkTypeText('😀'.repeat(2000)), { ok: true });
    assert.equal(checkTypeText('😀'.repeat(2001)).code, 'invalid_text');
    assert.equal(isInvalidText('😀'.repeat(2000)), false);
  });
});

describe('TypedBuffer', () => {
  it('a secret spelled by single Key presses is refused', () => {
    const buf = new TypedBuffer();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    let refused = null;
    for (const ch of secret) {
      const keys = ch === '_' ? 'shift+-' : ch;
      const char = printableChar(parseKeys(keys, 'linux'));
      const r = checkTypeText(char, { buffer: buf.value });
      if (!r.ok) { refused = r.code; break; }
      buf.append(char);
    }
    assert.equal(refused, 'text_looks_secret');
  });

  it('keeps the last 2000 code points and resets', () => {
    const buf = new TypedBuffer();
    buf.append('a'.repeat(1990));
    buf.append('😀'.repeat(20));
    assert.equal(Array.from(buf.value).length, 2000);
    assert.ok(buf.value.endsWith('😀'));
    buf.reset();
    assert.equal(buf.value, '');
  });

  it('looksSecret is exported for the Key path', () => {
    assert.equal(looksSecret('AKIAABCDEFGHIJKLMNOP', []), true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gui-keys.test.js tests/gui-text-guard.test.js`
Expected: FAIL with `Cannot find module '../src/gui/keys'`.

- [ ] **Step 3: Write `src/gui/keys.js`**

```js
// src/gui/keys.js
// The Key tool's grammar (fleet stage 5 spec §3.8): `mod(+mod)*+key` or
// `key`, with shell-level and clipboard shortcuts denied. There is no
// clipboard op anywhere in the helper protocol either.
const { GuiError } = require('./errors');

const MODIFIERS = Object.freeze(['ctrl', 'alt', 'shift', 'meta']);
const NAMED = Object.freeze(['enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'space']);
const PUNCT = Object.freeze(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
const ARROWS = ['up', 'down', 'left', 'right'];
// US layout: what shift makes of a digit or punctuation key (only the typed
// buffer uses it, to see characters spelled one press at a time).
const SHIFTED = Object.freeze({
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~'
});

function isKeyName(k) {
  return /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED.includes(k) || PUNCT.includes(k);
}

const has = (mods, ...wanted) => wanted.every((m) => mods.includes(m));

function deniedReason({ mods, key }, platform) {
  if (has(mods, 'alt') && key === 'tab') return 'alt+tab switches apps';
  if (has(mods, 'ctrl', 'alt')) return 'ctrl+alt shortcuts belong to the system';
  if (has(mods, 'ctrl', 'shift') && key === 'escape') return 'ctrl+shift+escape opens the task manager';
  if (has(mods, 'ctrl') && key === 'escape') return 'ctrl+escape opens the start menu';
  if (has(mods, 'alt') && key === 'escape') return 'alt+escape switches windows';
  if ((has(mods, 'ctrl') || has(mods, 'meta')) && ['c', 'v', 'x'].includes(key)) return 'clipboard shortcuts are not allowed';
  if ((has(mods, 'shift') || has(mods, 'ctrl')) && key === 'insert') return 'clipboard shortcuts are not allowed';
  if (has(mods, 'shift') && key === 'delete') return 'clipboard shortcuts are not allowed';
  if (platform !== 'darwin' && has(mods, 'meta')) return 'the Windows/Super key is not allowed';
  if (platform === 'darwin') {
    if (has(mods, 'meta') && key === 'space') return 'meta+space opens Spotlight';
    if (has(mods, 'meta') && key === 'tab') return 'meta+tab switches apps';
    if (has(mods, 'meta', 'alt') && key === 'escape') return 'meta+alt+escape opens Force Quit';
    if (has(mods, 'ctrl', 'meta') && key === 'q') return 'ctrl+meta+q locks the screen';
    if (has(mods, 'ctrl') && ARROWS.includes(key)) return 'ctrl+arrow switches Spaces';
    if (has(mods, 'meta', 'shift') && ['3', '4', '5'].includes(key)) return 'meta+shift+3/4/5 take screenshots';
  }
  return null;
}

function parseKeys(keys, platform = process.platform) {
  if (typeof keys !== 'string' || keys.length < 1 || keys.length > 64) throw new GuiError('key_invalid', 'keys must be 1–64 characters');
  const parts = keys.toLowerCase().split('+');
  if (parts.some((p) => p === '')) throw new GuiError('key_invalid', `"${keys}" is not mod+key`);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!isKeyName(key)) throw new GuiError('key_invalid', `unknown key "${key}"`);
  for (const m of mods) if (!MODIFIERS.includes(m)) throw new GuiError('key_invalid', `unknown modifier "${m}"`);
  if (new Set(mods).size !== mods.length) throw new GuiError('key_invalid', 'a modifier is repeated');
  const combo = { mods: MODIFIERS.filter((m) => mods.includes(m)), key };
  const denied = deniedReason(combo, platform);
  if (denied) throw new GuiError('key_denied', denied);
  return combo;
}

function printableChar({ mods, key }) {
  if (mods.some((m) => m !== 'shift')) return null;
  const shift = mods.includes('shift');
  if (key === 'space') return ' ';
  if (/^[a-z]$/.test(key)) return shift ? key.toUpperCase() : key;
  if (/^[0-9]$/.test(key) || PUNCT.includes(key)) return shift ? SHIFTED[key] : key;
  return null;
}

const isEnter = (combo) => combo.key === 'enter';

function checkButton(button, platform = process.platform) {
  // X11 pastes the primary selection on a middle click (§3.8).
  if (button === 'middle' && platform === 'linux') throw new GuiError('middle_click_denied', 'a middle click pastes the primary selection on Linux');
}

module.exports = { parseKeys, printableChar, isEnter, checkButton, MODIFIERS };
```

- [ ] **Step 4: Write `src/gui/text-guard.js`**

```js
// src/gui/text-guard.js
// What the Type tool (and printable Key presses) may send (fleet stage 5
// spec §3.8). Checks run over `buffer + text`, where the buffer is the
// lease's last 2000 typed characters, so a value spelled one call at a time
// is caught; the text alone is checked too, so a buffer cannot mask it.
const { patternMatch, SHELL_SEPARATORS } = require('../execution/tool-patterns');

const MAX_TEXT = 2000;
const BUFFER_MAX = 2000;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/
]);
// Control characters other than \n and \t (C0, DEL, C1).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function isInvalidText(text) {
  if (typeof text !== 'string') return true;
  const length = Array.from(text).length;
  return length === 0 || length > MAX_TEXT || CONTROL.test(text);
}

function entropy(run) {
  const chars = Array.from(run);
  const counts = new Map();
  for (const c of chars) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(run) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[!-/:-@[-`{-~]/].filter((re) => re.test(run)).length;
}

function isPlainWebUrl(run) {
  try {
    const u = new URL(run);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

function looksSecret(text, vaultValues = []) {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  // Runs of printable ASCII (Deviation 26): secrets are ASCII, and prose in
  // scripts without spaces must not form one long run.
  for (const run of text.match(/[!-~]{24,}/g) || []) {
    if (isPlainWebUrl(run)) continue;
    if (entropy(run) >= 4.0 && charClasses(run) >= 3) return true;
  }
  return vaultValues.some((v) => typeof v === 'string' && v.length >= 8 && text.includes(v));
}

// `Name(detail)` patterns only; bare names are ignored (§3.8).
function details(patterns) {
  const out = [];
  for (const p of patterns || []) {
    const m = /^[A-Za-z_][\w-]*\(([\s\S]*)\)$/.exec(String(p));
    if (m && m[1] !== '') out.push(m[1]);
  }
  return out;
}

function candidates(text) {
  const out = new Set([text]);
  for (const line of text.split('\n')) {
    out.add(line);
    for (const segment of line.split(SHELL_SEPARATORS)) if (segment.trim()) out.add(segment.trim());
  }
  return out;
}

function matchesAlwaysConfirm(texts, patterns) {
  const ds = details(patterns).filter((d) => d !== '*');
  if (ds.length === 0) return false;
  for (const text of texts) {
    for (const c of candidates(text)) if (ds.some((d) => patternMatch(d, c))) return true;
  }
  return false;
}

function checkTypeText(text, { alwaysConfirm = [], vaultValues = [], buffer = '' } = {}) {
  if (isInvalidText(text)) return { ok: false, code: 'invalid_text' };
  const combined = `${buffer}${text}`;
  if (matchesAlwaysConfirm([text, combined], alwaysConfirm)) return { ok: false, code: 'text_matches_always_confirm' };
  if (looksSecret(text, vaultValues) || looksSecret(combined, vaultValues)) return { ok: false, code: 'text_looks_secret' };
  return { ok: true };
}

class TypedBuffer {
  constructor(max = BUFFER_MAX) {
    this.max = max;
    this.chars = [];
  }

  get value() {
    return this.chars.join('');
  }

  append(text) {
    this.chars.push(...Array.from(String(text)));
    if (this.chars.length > this.max) this.chars = this.chars.slice(this.chars.length - this.max);
  }

  reset() {
    this.chars = [];
  }
}

module.exports = { checkTypeText, TypedBuffer, looksSecret, isInvalidText, MAX_TEXT };
```

Note on `Vault(*)` (Deviation 31): its detail `*` would match every text, which is not what an owner means by "confirm Vault calls"; `matchesAlwaysConfirm` drops a detail that is exactly `*`. `Bash(*deploy*)` still matches text containing "deploy".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/gui-keys.test.js tests/gui-text-guard.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/gui/keys.js src/gui/text-guard.js tests/gui-keys.test.js tests/gui-text-guard.test.js
git commit -m "feat(gui): key grammar and the typed-text guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `kl-session-v1` framing, proofs and sealing, with vectors and the protocol document

**Review:** trust (the channel's authentication and sealing). **On Windows:** all of it can be checked.

**Files:**
- Create: `src/gui/helper-protocol.js`
- Create: `tests/vectors/session-v1/generate.js` (and the files it writes)
- Create: `docs/protocol/session-v1.md`
- Test: `tests/session-vectors.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1).
- Produces (`src/gui/helper-protocol.js`):
  - Constants `PROTOCOL = 'kl-session-v1'`, `PLAIN_MAX = 16384`, `SEALED_MAX = 8388608`, `DIR_SH = 0x01`, `DIR_HS = 0x02`, `NONCE_RE`.
  - `encodeFrame(obj) → Buffer` (plain: 4-byte BE length + UTF-8 JSON; throws `frame_rejected` over 16 KiB).
  - `class FrameDecoder { constructor({ maxBytes }); setMax(n); push(chunk); next() → Buffer | null }` (throws `GuiError('frame_rejected')` on a zero or oversize length).
  - `parsePlain(body) → object` (throws `frame_rejected`).
  - `randomNonce() → b64url(32)`, `serviceProof(secret, nodeId, nonceH, nonceS) → b64url`, `helperProof(secret, nodeId, nonceS, nonceH) → b64url`, `proofEquals(a, b) → boolean` (constant time).
  - `deriveSessionKeys(secret, nodeId, nonceH, nonceS) → { kSh: Buffer(32), kHs: Buffer(32) }`.
  - `createSealer(key, dir) → { seal(obj) → Buffer (whole frame incl. length) }`; `createOpener(key, dir) → { open(body) → object }` (body = frame without its 4-byte length; throws `GuiError('frame_rejected', 'sequence'|'authentication'|'json'|'short')`).

- [ ] **Step 1: Write the vector generator and the failing test**

Create `tests/vectors/session-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/session-v1/generate.js
//
// Rebuilds the kl-session-v1 vectors (fleet stage 5 spec §4.2).
//   node tests/vectors/session-v1/generate.js          write the files
//   node tests/vectors/session-v1/generate.js --check  exit 1 if any differ
// Everything is deterministic: fixed secret and nonces, and AES-GCM with a
// fixed key and IV.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../../../src/gui/helper-protocol');
const KEYS = require('../approval-v1/keys.json');

const DIR = __dirname;
const sha = (label) => crypto.createHash('sha256').update(label).digest();
const SECRET = sha('session-v1 vector secret');
const NODE_ID = KEYS.nodes['gpu-box'].id;
const NONCE_H = sha('session-v1 nonce_h').toString('base64url');
const NONCE_S = sha('session-v1 nonce_s').toString('base64url');

const PLAINTEXTS = {
  sh: [{ t: 'req', id: 1, op: 'foreground', job_id: 'job-1', lease_id: null, params: {} }, { t: 'ping' }],
  hs: [
    { t: 'probe_report', capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false },
    { t: 'res', id: 1, ok: true, result: null }
  ]
};

function buildVectors() {
  const { kSh, kHs } = P.deriveSessionKeys(SECRET, NODE_ID, NONCE_H, NONCE_S);
  const frames = (key, dir, list) => {
    const sealer = P.createSealer(key, dir);
    return list.map((obj) => ({ plaintext_json: JSON.stringify(obj), frame_hex: sealer.seal(obj).toString('hex') }));
  };
  const sh = frames(kSh, P.DIR_SH, PLAINTEXTS.sh);
  const hs = frames(kHs, P.DIR_HS, PLAINTEXTS.hs);
  const tampered = Buffer.from(sh[0].frame_hex, 'hex');
  tampered[tampered.length - 1] ^= 0x01;
  const keysHex = { k_sh_hex: kSh.toString('hex'), k_hs_hex: kHs.toString('hex') };
  return [
    {
      name: 'handshake',
      given: { secret_hex: SECRET.toString('hex'), node_id: NODE_ID, nonce_h: NONCE_H, nonce_s: NONCE_S },
      expect: {
        proof_s: P.serviceProof(SECRET, NODE_ID, NONCE_H, NONCE_S),
        proof_h: P.helperProof(SECRET, NODE_ID, NONCE_S, NONCE_H),
        ...keysHex
      }
    },
    { name: 'sealed-frames', given: keysHex, expect: { service_to_helper: sh, helper_to_service: hs } },
    // Each rejection: open `frames` in order with the named key/dir; the
    // frame at `rejected_at` fails with frame_rejected.
    { name: 'reject-seq-skip', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[1].frame_hex] }, expect: { rejected_at: 0, reason: 'sequence' } },
    { name: 'reject-seq-replay', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[0].frame_hex, sh[0].frame_hex] }, expect: { rejected_at: 1, reason: 'sequence' } },
    { name: 'reject-wrong-direction-key', given: { key_hex: keysHex.k_hs_hex, dir: P.DIR_HS, frames: [sh[0].frame_hex] }, expect: { rejected_at: 0, reason: 'authentication' } },
    { name: 'reject-tampered-tag', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [tampered.toString('hex')] }, expect: { rejected_at: 0, reason: 'authentication' } }
  ];
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  let differ = 0;
  const vectors = buildVectors();
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize };
```

Create `tests/session-vectors.test.js`:

```js
// tests/session-vectors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/gui/helper-protocol');
const { buildVectors, serialize } = require('./vectors/session-v1/generate');

const DIR = path.join(__dirname, 'vectors', 'session-v1');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const bodyOf = (hex) => Buffer.from(hex, 'hex').subarray(4);

describe('session-v1 vectors', () => {
  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(fs.readFileSync(path.join(DIR, `${v.name}.json`), 'utf8'), serialize(v), v.name);
    assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length, 6);
  });

  it('handshake: proofs and HKDF keys', () => {
    const v = load('handshake');
    const secret = Buffer.from(v.given.secret_hex, 'hex');
    assert.equal(P.serviceProof(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s), v.expect.proof_s);
    assert.equal(P.helperProof(secret, v.given.node_id, v.given.nonce_s, v.given.nonce_h), v.expect.proof_h);
    assert.notEqual(v.expect.proof_s, v.expect.proof_h);
    const { kSh, kHs } = P.deriveSessionKeys(secret, v.given.node_id, v.given.nonce_h, v.given.nonce_s);
    assert.equal(kSh.toString('hex'), v.expect.k_sh_hex);
    assert.equal(kHs.toString('hex'), v.expect.k_hs_hex);
    assert.ok(P.proofEquals(v.expect.proof_s, v.expect.proof_s));
    assert.ok(!P.proofEquals(v.expect.proof_s, v.expect.proof_h));
  });

  it('sealed frames open in order with the right direction key', () => {
    const v = load('sealed-frames');
    for (const [list, key, dir] of [[v.expect.service_to_helper, v.given.k_sh_hex, P.DIR_SH], [v.expect.helper_to_service, v.given.k_hs_hex, P.DIR_HS]]) {
      const opener = P.createOpener(Buffer.from(key, 'hex'), dir);
      for (const f of list) assert.deepEqual(opener.open(bodyOf(f.frame_hex)), JSON.parse(f.plaintext_json));
    }
  });

  for (const name of ['reject-seq-skip', 'reject-seq-replay', 'reject-wrong-direction-key', 'reject-tampered-tag']) {
    it(`${name} is refused at the named frame`, () => {
      const v = load(name);
      const opener = P.createOpener(Buffer.from(v.given.key_hex, 'hex'), v.given.dir);
      v.given.frames.forEach((hex, i) => {
        if (i < v.expect.rejected_at) { opener.open(bodyOf(hex)); return; }
        if (i === v.expect.rejected_at) {
          assert.throws(() => opener.open(bodyOf(hex)), (e) => e.code === 'frame_rejected' && e.detail === v.expect.reason);
        }
      });
    });
  }
});

describe('plain framing', () => {
  it('round-trips through the decoder one frame at a time, even across chunks', () => {
    const a = P.encodeFrame({ t: 'hello', v: 1 });
    const b = P.encodeFrame({ t: 'auth', proof_h: 'x' });
    const all = Buffer.concat([a, b]);
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    d.push(all.subarray(0, 3));
    assert.equal(d.next(), null);
    d.push(all.subarray(3));
    assert.deepEqual(P.parsePlain(d.next()), { t: 'hello', v: 1 });
    assert.deepEqual(P.parsePlain(d.next()), { t: 'auth', proof_h: 'x' });
    assert.equal(d.next(), null);
  });

  it('refuses an oversize or zero length and unparseable JSON', () => {
    const d = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    const big = Buffer.alloc(4);
    big.writeUInt32BE(P.PLAIN_MAX + 1);
    d.push(big);
    assert.throws(() => d.next(), (e) => e.code === 'frame_rejected');
    const z = new P.FrameDecoder({ maxBytes: P.PLAIN_MAX });
    z.push(Buffer.alloc(4));
    assert.throws(() => z.next(), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('{nope')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.parsePlain(Buffer.from('[1]')), (e) => e.code === 'frame_rejected');
    assert.throws(() => P.encodeFrame({ pad: 'x'.repeat(P.PLAIN_MAX) }), (e) => e.code === 'frame_rejected');
  });

  it('a bad nonce is refused before any key is derived', () => {
    assert.throws(() => P.deriveSessionKeys(Buffer.alloc(32), 'kl-aaaaaaaaaaaaaaaa', 'short', P.randomNonce()), (e) => e.code === 'frame_rejected');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-vectors.test.js`
Expected: FAIL with `Cannot find module '../../../src/gui/helper-protocol'`.

- [ ] **Step 3: Write `src/gui/helper-protocol.js`**

```js
// src/gui/helper-protocol.js
// kl-session-v1 (fleet stage 5 spec §3.2, §4.2; docs/protocol/session-v1.md):
// the local protocol between the service and the session helper. Shared by
// both sides; no platform code. Before `ready`: 4-byte length + JSON. After:
// every frame sealed with AES-256-GCM under per-direction HKDF keys with a
// strict sequence, so a relaying local account can pass frames through but
// cannot read, inject or reorder them.
const crypto = require('crypto');
const { GuiError } = require('./errors');

const PROTOCOL = 'kl-session-v1';
const PLAIN_MAX = 16 * 1024;
const SEALED_MAX = 8 * 1024 * 1024;
const DIR_SH = 0x01;
const DIR_HS = 0x02;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const TAG_BYTES = 16;

const rejected = (why) => new GuiError('frame_rejected', why);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function lengthPrefix(n) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(n);
  return len;
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > PLAIN_MAX) throw rejected('plain frame over 16 KiB');
  return Buffer.concat([lengthPrefix(body.length), body]);
}

class FrameDecoder {
  constructor({ maxBytes = PLAIN_MAX } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  setMax(n) {
    this.maxBytes = n;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
  }

  // One frame at a time, so the caller can switch the limit (and the
  // meaning of the next frame) at `ready`.
  next() {
    if (this.buffer.length < 4) return null;
    const n = this.buffer.readUInt32BE(0);
    if (n === 0 || n > this.maxBytes) throw rejected(`frame of ${n} bytes`);
    if (this.buffer.length < 4 + n) return null;
    const body = this.buffer.subarray(4, 4 + n);
    this.buffer = this.buffer.subarray(4 + n);
    return body;
  }
}

function parsePlain(body) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw rejected('json');
  }
  if (!isPlainObject(obj)) throw rejected('json');
  return obj;
}

const randomNonce = () => crypto.randomBytes(32).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64url');

function serviceProof(secret, nodeId, nonceH, nonceS) {
  return hmac(secret, `${PROTOCOL}\nservice\n${nodeId}\n${nonceH}\n${nonceS}`);
}

function helperProof(secret, nodeId, nonceS, nonceH) {
  return hmac(secret, `${PROTOCOL}\nhelper\n${nodeId}\n${nonceS}\n${nonceH}`);
}

function proofEquals(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function nonceBytes(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw rejected('nonce');
  return Buffer.from(nonce, 'base64url');
}

// info = UTF-8 label ‖ UTF-8 node_id ‖ raw nonce_h ‖ raw nonce_s (Deviation 19).
function deriveSessionKeys(secret, nodeId, nonceH, nonceS) {
  const info = Buffer.concat([Buffer.from(`${PROTOCOL} keys`, 'utf8'), Buffer.from(String(nodeId), 'utf8'), nonceBytes(nonceH), nonceBytes(nonceS)]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 64));
  return { kSh: okm.subarray(0, 32), kHs: okm.subarray(32, 64) };
}

function ivFor(dir, seq) {
  const iv = Buffer.alloc(12);
  iv[0] = dir;
  iv.writeBigUInt64BE(seq, 4);
  return iv;
}

function aadFor(dir, seq) {
  const label = Buffer.from(PROTOCOL, 'utf8');
  const tail = Buffer.alloc(9);
  tail[0] = dir;
  tail.writeBigUInt64BE(seq, 1);
  return Buffer.concat([label, tail]);
}

function createSealer(key, dir) {
  let seq = 0n;
  return {
    seal(obj) {
      seq += 1n;
      const cipher = crypto.createCipheriv('aes-256-gcm', key, ivFor(dir, seq));
      cipher.setAAD(aadFor(dir, seq));
      const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
      const seqBuf = Buffer.alloc(8);
      seqBuf.writeBigUInt64BE(seq);
      const body = Buffer.concat([seqBuf, ct, cipher.getAuthTag()]);
      if (body.length > SEALED_MAX) throw rejected('sealed frame over 8 MiB');
      return Buffer.concat([lengthPrefix(body.length), body]);
    }
  };
}

function createOpener(key, dir) {
  let last = 0n;
  return {
    open(body) {
      if (!body || body.length < 8 + TAG_BYTES) throw rejected('short');
      const seq = body.readBigUInt64BE(0);
      if (seq !== last + 1n) throw rejected('sequence');
      let plain;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivFor(dir, seq));
        decipher.setAAD(aadFor(dir, seq));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        plain = Buffer.concat([decipher.update(body.subarray(8, body.length - TAG_BYTES)), decipher.final()]);
      } catch {
        throw rejected('authentication');
      }
      last = seq;
      return parsePlain(plain);
    }
  };
}

module.exports = {
  PROTOCOL, PLAIN_MAX, SEALED_MAX, DIR_SH, DIR_HS, NONCE_RE,
  encodeFrame, FrameDecoder, parsePlain, randomNonce,
  serviceProof, helperProof, proofEquals, deriveSessionKeys, createSealer, createOpener
};
```

- [ ] **Step 4: Generate the vectors and run the tests**

Run: `node tests/vectors/session-v1/generate.js` → prints `6 vectors written`.
Run: `node tests/vectors/session-v1/generate.js --check` → `6 vectors match`.
Run: `node --test tests/session-vectors.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Write `docs/protocol/session-v1.md`**

```markdown
# kl-session-v1 — the session helper channel

The local protocol between the King Louie service (a system service) and its
session helper (`king-louie-service session`, running as the logged-in user).
Fleet stage 5 spec §3.2 and §4.2 are the source; this document fixes the bytes.

## 1. Transport

- Windows: a named pipe `\\.\pipe\king-louie-session-<endpoint_id>`, created by
  the service with `readableAll` and `writableAll` (Node cannot put one SID in a
  pipe DACL). Any local account can open it, and can also open another server
  instance of the same name; the protocol below is the security boundary.
- POSIX: a Unix socket `<session_ipc_dir>/<endpoint_id>.sock`, mode `0666`, in a
  `0711` directory owned by the service account (`/var/lib/king-louie-session`
  on Linux, `/Library/Application Support/KingLouie/session` on macOS). Socket
  names are not secret.

## 2. Frames

Before and including `ready`: `len(4, big-endian) ‖ UTF-8 JSON object`, at most
16 KiB. After `ready`: sealed frames (§4), at most 8 MiB. A zero or oversize
length, unparseable JSON, a JSON value that is not an object, or a frame that is
not the next expected handshake message closes the connection.

## 3. Handshake

| # | From | Frame |
|---|---|---|
| 1 | helper | `{ "t": "hello", "v": 1, "node_id", "nonce_h": b64url(32 random bytes), "pid", "user", "platform", "helper_version" }` |
| 2 | service | `{ "t": "challenge", "v": 1, "nonce_s": b64url(32), "proof_s" }` |
| 3 | helper | `{ "t": "auth", "proof_h" }` — sent only after `proof_s` verifies |
| 4 | service | `{ "t": "ready", "session_id": uuid-v4 }` — or `{ "t": "error", "code": "helper_already_connected" }` and close |

- `proof_s = b64url(HMAC-SHA256(secret, "kl-session-v1\nservice\n" + node_id + "\n" + nonce_h + "\n" + nonce_s))`
- `proof_h = b64url(HMAC-SHA256(secret, "kl-session-v1\nhelper\n" + node_id + "\n" + nonce_s + "\n" + nonce_h))`
- `secret` is the raw 32 bytes. Proofs compare in constant time.
- The service closes when `hello.node_id` differs from its canonical file or
  `hello.user` differs from `session_user`. The whole handshake has 5 s.
- At most 4 unauthenticated connections at once. One authenticated helper: a
  newcomer is refused (`error` frame above) while the current helper answers a
  `ping` within 5 s, and replaces it otherwise.

## 4. Sealing

`keys = HKDF-SHA256(ikm = secret, salt = empty, info, 64 bytes)` with
`info = UTF-8("kl-session-v1 keys") ‖ UTF-8(node_id) ‖ raw(nonce_h) ‖ raw(nonce_s)`
(the raw 32 bytes of each nonce). `k_sh = keys[0..32]` seals service → helper,
`k_hs = keys[32..64]` helper → service.

Each sealed frame: `len(4, BE) ‖ seq(8, BE) ‖ AES-256-GCM ciphertext ‖ tag(16)`,
`len` counting everything after itself.
- `dir` = `0x01` service → helper, `0x02` helper → service.
- `iv = dir(1) ‖ 0x000000 ‖ seq(8, BE)`; `aad = UTF-8("kl-session-v1") ‖ dir(1) ‖ seq(8, BE)`.
- `seq` starts at 1 in each direction and increments by 1. A frame whose `seq`
  is not the last + 1, or that fails to open, closes the connection.

## 5. Messages after `ready`

The helper's first sealed frame is its `probe_report`. Then:

- `{ "t": "req", "id", "op", "job_id", "lease_id", "params" }` → `{ "t": "res", "id", "ok": true, "result" }`
  or `{ "t": "res", "id", "ok": false, "error": { "code", "message", "detail" } }`.
- `{ "t": "event", "kind": "locked" | "unlocked" | "displays_changed" | "probe_changed", "data" }` (helper → service).
- `{ "t": "ping" }` / `{ "t": "pong" }`, either direction; the service pings
  every 10 s and closes after 30 s without a frame.

Ops: `launch`, `processes`, `windows`, `foreground`, `focus`, `close`,
`screenshot`, `input`, `release_all`, `probe` (spec §3.3). Timeouts: 10 s,
`screenshot` 20 s, `launch` 30 s. There is no clipboard op.

## 6. Vectors

`tests/vectors/session-v1/`, rebuilt by `generate.js`: `handshake` (proofs and
keys), `sealed-frames` (both directions), and the rejections `reject-seq-skip`,
`reject-seq-replay`, `reject-wrong-direction-key`, `reject-tampered-tag`.
```

- [ ] **Step 6: Commit**

```bash
git add src/gui/helper-protocol.js tests/vectors/session-v1 tests/session-vectors.test.js docs/protocol/session-v1.md
git commit -m "feat(gui): kl-session-v1 framing, proofs and sealing with vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The session secret, the per-user copies and the endpoint

**Review:** trust (the secret, and files written with elevation). **On Windows:** the POSIX cases (`0600`/`0640` modes, owners, hostile symlinks, the `0755` directories) and the Linux-only case-alias case are skipped; the junction case and the ACL command line run. Their first real run is on a POSIX machine.

**Files:**
- Create: `src/gui/session-secret.js`
- Modify: `src/platform/windows-paths.js` (add `windowsIcaclsExe`)
- Test: `tests/gui-session-secret.test.js`

**Interfaces:**
- Consumes: `GuiError` (Task 1); `assertAdminOwned` (`src/service/node-config.js`); `windowsIcaclsExe`, `windowsPowerShellExe` (`src/platform/windows-paths.js`).
- Produces (`src/gui/session-secret.js`):
  - `mintSessionSecret() → { secret: Buffer(32), endpointId: 32 hex }`.
  - `canonicalPath(configDir)`; `writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid = null, svcGid = null, platform, now })`; `readCanonical({ configDir, cipher, geteuid, adminUid = 0 }) → { secret, endpointId, nodeId, sessionUser, sessionSid, mtimeMs }` (throws `session_not_installed`); `canonicalMtime(configDir) → number | null`.
  - `userCopyPath({ platform, configDir, user, sid })`; `writeUserCopy({ platform, configDir, user, uid, gid, sid, content, runIcacls, env }) → file`; `readUserCopy({ path, platform, getuid, rootUid = 0 }) → { secret, endpoint, nodeId }` (throws `session_not_installed`, `session_file_insecure`); `removeUserCopy(...)`.
  - `endpointPath({ platform, endpointId, ipcDir })`; `sessionIpcDir(platform)`.
  - `assertSafeComponents(target, { root }) → void` (throws `unsafe_path`).
  - `windowsUserAclArgs(file, sid, env) → string[]`.
  - `resolveSessionUser(name, { platform, execFile, env }) → { user, uid, gid, home, sid }` (throws `user_not_found`, `home_missing`, `invalid_params`).
  - `src/platform/windows-paths.js`: `windowsIcaclsExe(env) → '<SystemRoot>\System32\icacls.exe'`.

- [ ] **Step 1: Write the failing test**

Create `tests/gui-session-secret.test.js`:

```js
// tests/gui-session-secret.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/gui/session-secret');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { windowsIcaclsExe } = require('../src/platform/windows-paths');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const cipher = createAesGcmCipher(crypto.randomBytes(32));

function tempConfig() {
  // Native realpath: assertSafeComponents requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-session-secret-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  return { base, config };
}

const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('mint and the canonical copy', () => {
  it('mints 32 random bytes and a 16-byte endpoint id, fresh every time', () => {
    const a = S.mintSessionSecret();
    const b = S.mintSessionSecret();
    assert.equal(a.secret.length, 32);
    assert.match(a.endpointId, /^[0-9a-f]{32}$/);
    assert.notEqual(a.endpointId, b.endpointId);
    assert.ok(!a.secret.equals(b.secret));
  });

  it('writes the secret as klc1: ciphertext and reads it back', () => {
    const { config } = tempConfig();
    const { secret, endpointId } = S.mintSessionSecret();
    S.writeCanonical({ configDir: config, cipher, secret, endpointId, nodeId: 'kl-hnef32472qzibi5r', sessionUser: 'alice', svcGid: POSIX ? GID : null });
    const raw = JSON.parse(fs.readFileSync(S.canonicalPath(config), 'utf8'));
    assert.match(raw.secret, /^klc1:/);
    assert.deepEqual(Object.keys(raw).sort(), ['endpoint_id', 'node_id', 'rotated_at', 'secret', 'session_sid', 'session_user', 'v']);
    if (POSIX) assert.equal(fs.statSync(S.canonicalPath(config)).mode & 0o777, 0o640);
    const read = S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID });
    assert.ok(read.secret.equals(secret));
    assert.equal(read.endpointId, endpointId);
    assert.equal(read.sessionUser, 'alice');
    assert.ok(read.mtimeMs > 0);
    assert.equal(S.canonicalMtime(config), read.mtimeMs);
  });

  it('a missing canonical file is session_not_installed', () => {
    const { config } = tempConfig();
    assert.equal(code(() => S.readCanonical({ configDir: config, cipher, adminUid: UID, geteuid: () => UID })), 'session_not_installed');
    assert.equal(S.canonicalMtime(config), null);
  });
});

describe('per-user copies', () => {
  const content = { v: 1, node_id: 'kl-hnef32472qzibi5r', endpoint: '/tmp/x.sock', secret: 'ab'.repeat(32), rotated_at: '2026-09-23T18:00:00.000Z' };

  it('the path lives in the admin-owned config dir', () => {
    assert.equal(S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: 'alice' }), '/etc/king-louie/session/users/alice.json');
    assert.equal(S.userCopyPath({ platform: 'win32', configDir: 'C:\\ProgramData\\KingLouie\\config', sid: 'S-1-5-21-1-2-3-1001' }),
      'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json');
    assert.equal(code(() => S.userCopyPath({ platform: 'linux', configDir: '/etc/king-louie', user: '../root' })), 'invalid_params');
    assert.equal(code(() => S.userCopyPath({ platform: 'win32', configDir: 'C:\\x', sid: 'S-1-5-21-1..\\x' })), 'invalid_params');
  });

  it('POSIX: 0600, owned by the user, in a root-owned 0755 dir; readable back', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, UID);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(config, 'session')).mode & 0o777, 0o755, 'Deviation 10');
    const read = S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID });
    assert.equal(read.nodeId, content.node_id);
    assert.equal(read.secret.toString('hex'), content.secret);
    // A second write replaces the file (unlink + O_EXCL), never opens it for write.
    S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content: { ...content, endpoint: '/tmp/y.sock' } });
    assert.equal(S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID }).endpoint, '/tmp/y.sock');
  });

  it('POSIX: session_file_insecure for a loose mode, another owner or a non-root dir', { skip: !POSIX }, () => {
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content });
    fs.chmodSync(file, 0o644);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_file_insecure');
    fs.chmodSync(file, 0o600);
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID + 1, rootUid: UID })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: file, platform: 'linux', getuid: () => UID, rootUid: UID + 1 })), 'session_file_insecure');
    assert.equal(code(() => S.readUserCopy({ path: path.join(config, 'nope.json'), platform: 'linux', getuid: () => UID, rootUid: UID })), 'session_not_installed');
  });

  it('a hostile symlink at the file or at a parent refuses unsafe_path and leaves the target untouched', { skip: !POSIX }, () => {
    const { base, config } = tempConfig();
    const target = path.join(base, 'target.txt');
    fs.writeFileSync(target, 'original');
    fs.mkdirSync(path.join(config, 'session', 'users'), { recursive: true, mode: 0o755 });
    fs.symlinkSync(target, path.join(config, 'session', 'users', 'alice.json'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const { base: base2, config: config2 } = tempConfig();
    const elsewhere = path.join(base2, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config2, 'session'), { mode: 0o755 });
    fs.symlinkSync(elsewhere, path.join(config2, 'session', 'users'));
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: config2, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('a junction at a parent component refuses unsafe_path on Windows', { skip: POSIX }, () => {
    const { base, config } = tempConfig();
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(config, 'session'));
    fs.symlinkSync(elsewhere, path.join(config, 'session', 'users'), 'junction');
    assert.equal(code(() => S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: () => {} })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('Linux: a config dir reached through a link that differs only by case is refused', { skip: process.platform !== 'linux' }, () => {
    const { base, config } = tempConfig();
    const alias = path.join(base, 'Config');
    fs.symlinkSync(config, alias);
    assert.equal(code(() => S.writeUserCopy({ platform: 'linux', configDir: alias, user: 'alice', uid: UID, gid: GID, content })), 'unsafe_path');
    assert.equal(fs.existsSync(path.join(config, 'session')), false, 'nothing was written through the link');
  });

  it('Windows: the ACL command line uses the absolute icacls.exe and the SID', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    assert.equal(windowsIcaclsExe(env), 'C:\\Windows\\System32\\icacls.exe');
    assert.deepEqual(S.windowsUserAclArgs('C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json', 'S-1-5-21-1-2-3-1001', env), [
      'C:\\Windows\\System32\\icacls.exe', 'C:\\cfg\\session\\users\\S-1-5-21-1-2-3-1001.json',
      '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(R)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
    ]);
  });

  it('Windows: writing a copy runs icacls once on that file', { skip: POSIX }, () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const calls = [];
    const { config } = tempConfig();
    const file = S.writeUserCopy({ platform: 'win32', configDir: config, sid: 'S-1-5-21-1-2-3-1001', content, runIcacls: (argv) => calls.push(argv), env });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], file);
  });
});

describe('endpoint', () => {
  it('names the pipe or the socket; socket paths fit in 104 bytes', () => {
    const id = 'a'.repeat(32);
    assert.equal(S.endpointPath({ platform: 'win32', endpointId: id }), `\\\\.\\pipe\\king-louie-session-${id}`);
    for (const platform of ['linux', 'darwin']) {
      const p = S.endpointPath({ platform, endpointId: id });
      assert.ok(p.startsWith(S.sessionIpcDir(platform)));
      assert.ok(Buffer.byteLength(p) <= 104, p);
    }
    assert.equal(code(() => S.endpointPath({ platform: 'linux', endpointId: '../x' })), 'invalid_params');
  });
});

describe('resolveSessionUser', () => {
  it('POSIX: id and getent, the name never in a shell', () => {
    const calls = [];
    const execFile = (file, argv) => {
      calls.push([file, ...argv]);
      if (file === '/usr/bin/id') return argv[0] === '-u' ? '1001\n' : '1001\n';
      if (file === '/usr/bin/getent') return 'alice:x:1001:1001:Alice:/home/alice:/bin/bash\n';
      throw new Error('unexpected');
    };
    const exists = (p) => p === '/home/alice';
    assert.deepEqual(S.resolveSessionUser('alice', { platform: 'linux', execFile, exists }), { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice', sid: null });
    assert.deepEqual(calls[0], ['/usr/bin/id', '-u', 'alice']);
  });

  it('macOS reads the home with dscl', () => {
    const execFile = (file) => (file === '/usr/bin/dscl' ? 'NFSHomeDirectory: /Users/alice\n' : '501\n');
    assert.equal(S.resolveSessionUser('alice', { platform: 'darwin', execFile, exists: () => true }).home, '/Users/alice');
  });

  it('Windows: the SID through PowerShell with the name in an environment variable', () => {
    let seen;
    const execFile = (file, argv, options) => { seen = { file, argv, env: options.env }; return 'S-1-5-21-1-2-3-1001\r\n'; };
    const r = S.resolveSessionUser('alice', { platform: 'win32', execFile, env: { SystemRoot: 'C:\\Windows' } });
    assert.equal(r.sid, 'S-1-5-21-1-2-3-1001');
    assert.ok(seen.file.endsWith('powershell.exe'));
    assert.ok(!seen.argv.join(' ').includes('alice'), 'the name is never interpolated');
    assert.equal(seen.env.KL_SESSION_USER, 'alice');
  });

  it('unknown user, missing home and a hostile name', () => {
    const fail = () => { throw Object.assign(new Error('no such user'), { status: 1 }); };
    assert.equal(code(() => S.resolveSessionUser('ghost', { platform: 'linux', execFile: fail })), 'user_not_found');
    const noHome = (file) => (file === '/usr/bin/getent' ? 'alice:x:1001:1001::/nonexistent-kl:/bin/sh\n' : '1001\n');
    assert.equal(code(() => S.resolveSessionUser('alice', { platform: 'linux', execFile: noHome, exists: () => false })), 'home_missing');
    assert.equal(code(() => S.resolveSessionUser('-rf', { platform: 'linux', execFile: fail })), 'invalid_params');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gui-session-secret.test.js`
Expected: FAIL with `Cannot find module '../src/gui/session-secret'`.

- [ ] **Step 3: Add `windowsIcaclsExe`**

In `src/platform/windows-paths.js`, below the `const windowsSchtasksExe = …` line:

```js
const windowsIcaclsExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'icacls.exe');

module.exports = { windowsSystemRoot, windowsPowerShellExe, windowsSchtasksExe, windowsIcaclsExe };
```

(Replace the existing `module.exports` line.)

- [ ] **Step 4: Write `src/gui/session-secret.js`**

```js
// src/gui/session-secret.js
// The session helper's secret and endpoint (fleet stage 5 spec §3.1, §4.3).
// The canonical copy (service reads) is klc1: ciphertext under the master
// key; each per-user copy (helper reads) is plaintext in the admin-owned
// config dir, readable only by that user. Elevated writes never follow a
// link: the config dir must be its own realpath and every component below it
// is lstat'ed (Deviation 11); a file is replaced by unlink + O_EXCL create.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GuiError } = require('./errors');
const { windowsIcaclsExe, windowsPowerShellExe } = require('../platform/windows-paths');

const SID_RE = /^S-1-\d+(-\d+){1,14}$/;
const POSIX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const ENDPOINT_RE = /^[0-9a-f]{32}$/;
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

const joinFor = (platform) => (platform === 'win32' ? path.win32.join : path.posix.join);

function mintSessionSecret() {
  return { secret: crypto.randomBytes(32), endpointId: crypto.randomBytes(16).toString('hex') };
}

const canonicalPath = (configDir) => path.join(configDir, 'session', 'helper-secret.json');

function sessionIpcDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/KingLouie/session';
  return '/var/lib/king-louie-session';
}

function endpointPath({ platform = process.platform, endpointId, ipcDir = sessionIpcDir(platform) }) {
  if (!ENDPOINT_RE.test(String(endpointId))) throw new GuiError('invalid_params', 'endpoint id must be 32 hex characters');
  if (platform === 'win32') return `\\\\.\\pipe\\king-louie-session-${endpointId}`;
  return path.posix.join(ipcDir, `${endpointId}.sock`);
}

function userCopyPath({ platform = process.platform, configDir, user, sid }) {
  const join = joinFor(platform);
  if (platform === 'win32') {
    if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'a Windows session user is named by its SID');
    return join(configDir, 'session', 'users', `${sid}.json`);
  }
  if (!POSIX_USER_RE.test(String(user))) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(user)}`);
  return join(configDir, 'session', 'users', `${user}.json`);
}

// The config dir must be its own realpath (no link anywhere above it), and
// nothing from it down to `target` may be a symlink, junction or other
// reparse point (Node reports junctions as symbolic links).
function assertSafeComponents(target, { root }) {
  const resolvedRoot = path.resolve(root);
  let real;
  try {
    real = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new GuiError('unsafe_path', resolvedRoot);
  }
  // Names compare without case only where the filesystem does (Windows, macOS):
  // on Linux a link that differs from its target by case alone must not pass.
  const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
  const same = foldsCase ? real.toLowerCase() === resolvedRoot.toLowerCase() : real === resolvedRoot;
  if (!same) throw new GuiError('unsafe_path', `${resolvedRoot} resolves to ${real}`);
  const rel = path.relative(resolvedRoot, path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new GuiError('unsafe_path', `${target} is outside ${resolvedRoot}`);
  let current = resolvedRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', current);
  }
}

function ensureAdminDir(dir, { root, platform }) {
  assertSafeComponents(dir, { root });
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new GuiError('unsafe_path', dir);
  if (platform !== 'win32') fs.chmodSync(dir, 0o755);
}

function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid = null, svcGid = null, platform = process.platform, now = Date.now() }) {
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  const file = canonicalPath(configDir);
  assertSafeComponents(file, { root: configDir });
  const record = {
    v: 1,
    node_id: nodeId,
    endpoint_id: endpointId,
    secret: cipher.encryptString(secret.toString('hex')),
    rotated_at: new Date(now).toISOString(),
    session_user: sessionUser,
    session_sid: sessionSid
  };
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o640);
  if (platform !== 'win32') {
    fs.chmodSync(file, 0o640);
    if (svcGid !== null) fs.chownSync(file, process.getuid(), svcGid);
  }
  return file;
}

function canonicalMtime(configDir) {
  try {
    return fs.statSync(canonicalPath(configDir)).mtimeMs;
  } catch {
    return null;
  }
}

function readCanonical({ configDir, cipher, geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1), adminUid = 0 }) {
  const file = canonicalPath(configDir);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (run "king-louie-service session install --user NAME")`);
  }
  // Required lazily: node-config.js requires this module's sibling config.js.
  const { assertAdminOwned } = require('../service/node-config');
  assertAdminOwned(file, geteuid, adminUid, { decides: 'who the session helper is', selfGrant: 'pose as the session helper' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.v !== 1 || !ENDPOINT_RE.test(String(raw.endpoint_id)) || typeof raw.node_id !== 'string' || typeof raw.session_user !== 'string') {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  const hex = cipher.decryptString(raw.secret);
  if (!SECRET_HEX_RE.test(hex)) throw new GuiError('session_not_installed', `${file} holds no valid secret`);
  return {
    secret: Buffer.from(hex, 'hex'),
    endpointId: raw.endpoint_id,
    nodeId: raw.node_id,
    sessionUser: raw.session_user,
    sessionSid: raw.session_sid || null,
    mtimeMs: st.mtimeMs
  };
}

function windowsUserAclArgs(file, sid, env = process.env) {
  return [windowsIcaclsExe(env), file, '/inheritance:r', '/grant:r', `*${sid}:(R)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
}

function defaultRunIcacls(argv) {
  execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
}

function writeUserCopy({ platform = process.platform, configDir, user, uid, gid, sid, content, runIcacls = defaultRunIcacls, env = process.env }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  ensureAdminDir(path.dirname(file), { root: configDir, platform });
  assertSafeComponents(file, { root: configDir });
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', file);
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
    if (platform !== 'win32') {
      fs.fchownSync(fd, uid, gid);
      fs.fchmodSync(fd, 0o600);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (platform === 'win32') runIcacls(windowsUserAclArgs(file, sid, env));
  return file;
}

function removeUserCopy({ platform = process.platform, configDir, user, sid }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  assertSafeComponents(file, { root: configDir });
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function readUserCopy({ path: file, platform = process.platform, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1), rootUid = 0 }) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (ask the administrator to run "session install")`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new GuiError('session_file_insecure', `${file} is not a regular file`);
  if (platform !== 'win32') {
    const dir = fs.statSync(path.dirname(file));
    if (st.mode & 0o077) throw new GuiError('session_file_insecure', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)})`);
    if (st.uid !== getuid()) throw new GuiError('session_file_insecure', `${file} is not owned by this user`);
    if (dir.uid !== rootUid || (dir.mode & 0o022)) throw new GuiError('session_file_insecure', `${path.dirname(file)} is not an administrator-owned directory`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new GuiError('session_not_installed', `${file} is not valid JSON`);
  }
  if (raw.v !== 1 || typeof raw.node_id !== 'string' || typeof raw.endpoint !== 'string' || !SECRET_HEX_RE.test(String(raw.secret))) {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  return { secret: Buffer.from(raw.secret, 'hex'), endpoint: raw.endpoint, nodeId: raw.node_id };
}

function resolveSessionUser(name, { platform = process.platform, execFile = (f, a, o) => execFileSync(f, a, { encoding: 'utf8', windowsHide: true, ...o }), env = process.env, exists = fs.existsSync } = {}) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 104 || /[\u0000-\u001f"]/.test(name)) {
    throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  }
  const run = (file, argv, options = {}) => {
    try {
      return String(execFile(file, argv, options));
    } catch {
      throw new GuiError('user_not_found', name);
    }
  };
  if (platform === 'win32') {
    const script = '(New-Object System.Security.Principal.NTAccount($env:KL_SESSION_USER)).Translate([System.Security.Principal.SecurityIdentifier]).Value';
    const sid = run(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...env, KL_SESSION_USER: name } }).trim();
    if (!SID_RE.test(sid)) throw new GuiError('user_not_found', name);
    return { user: name, uid: null, gid: null, home: null, sid };
  }
  if (!POSIX_USER_RE.test(name)) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  const uid = Number(run('/usr/bin/id', ['-u', name]).trim());
  const gid = Number(run('/usr/bin/id', ['-g', name]).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new GuiError('user_not_found', name);
  let home;
  if (platform === 'darwin') {
    const m = /NFSHomeDirectory:\s*(\S.*)$/m.exec(run('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory']));
    home = m ? m[1].trim() : null;
  } else {
    home = run('/usr/bin/getent', ['passwd', name]).trim().split(':')[5] || null;
  }
  if (!home || !home.startsWith('/') || !exists(home)) throw new GuiError('home_missing', `${name} has no home directory`);
  return { user: name, uid, gid, home, sid: null };
}

module.exports = {
  mintSessionSecret, canonicalPath, writeCanonical, readCanonical, canonicalMtime,
  userCopyPath, writeUserCopy, readUserCopy, removeUserCopy,
  endpointPath, sessionIpcDir, assertSafeComponents, windowsUserAclArgs, resolveSessionUser
};
```

Two notes for the implementer:
- `readCanonical` requires `../service/node-config` lazily because `node-config.js` requires `../gui/config`; a top-level require here would still work (no cycle through this file), but the lazy form keeps `session-secret.js` out of every profile graph that loads `node-config.js`.
- The `resolveSessionUser` Windows branch returns `uid/gid/home` as `null`: Windows needs only the SID.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/gui-session-secret.test.js`
Expected: PASS, `# fail 0` (POSIX-only cases skip on Windows and the junction case skips elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/gui/session-secret.js src/platform/windows-paths.js tests/gui-session-secret.test.js
git commit -m "feat(gui): session secret, per-user copies and endpoint paths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The `lease-v1` protocol — messages, checks, vectors and the document

**Review:** trust (the signatures and the twelve checks behind every lease). **On Windows:** all of it can be checked.

**Files:**
- Create: `src/gui/lease-protocol.js`
- Create: `tests/vectors/lease-v1/generate.js` (and the 26 files it writes)
- Create: `docs/protocol/lease-v1.md`
- Test: `tests/lease-vectors.test.js`

**Interfaces:**
- Consumes: `seal`, `open`, `nodeSigner`, `verifyEd25519` (`src/approvals/envelope.js`); `registerMessageValidator`, `isTimestamp`, `NONCE_RE`, `DEVICE_ID_RE`, `NODE_ID_RE`, `normalizeOrigin`, `iso`, `randomNonce` (`src/approvals/messages.js`); `verifyDeviceEnvelope`, `NonceCache` (`src/approvals/verify-device.js`); `canonicalize`, `sha256b64url` (`src/platform/jcs.js`).
- Produces (`src/gui/lease-protocol.js`):
  - `LEASE_LIMITS = ['no_lock_detect', 'no_human_yield']`, `REQUEST_TTL_MS = 300000`, `VIEW_MAX_BYTES = 262144`, `CHECK_OF` (reason → approval-v1 check number).
  - `leaseHash(lease) → b64url`.
  - `buildLeaseRequest({ identity, nodeName, jobId, apps: [{ id, name, path, processes }], maxMinutes, reason, resumes = null, limits = [], origin, now = Date.now(), requestId, leaseId, nonce }) → { message, envelope }`.
  - `buildLeaseStatus({ identity, leaseId, seq, state, locked, reason, expiresAt, now }) → envelope` (`expiresAt` ms or null).
  - `buildLeaseView({ identity, leaseId, seq, toDevice, state, locked, remainingS, foreground, frame, frameDropped, actions, now }) → envelope`.
  - `verifyLeaseGrant(envelope, { approverStore, nodeId, nonces, pending, guiApps, jobOpen, guiMaxMinutes }, now) → { accepted, check, reason, message?, bytes?, deviceId?, request? }` where `pending` is a `Map` of `request_id → { request_id, lease_id, nonce, lease_hash, expires_at, lease }`. `jobOpen` defaults to `() => false` (R-F5-7: a caller that does not say a job is open gets `job_closed`).
  - `verifyLeaseRevoke(envelope, { approverStore, nodeId, nonces, knownLease }) → { accepted, check, reason, message? }`; `verifyLeaseWatch(...)` (same shape).
  - `verifyLeaseView(envelope, { nodeId, nodePublicKeyHex, maxBytes = VIEW_MAX_BYTES }) → { accepted, reason }` (the phones' reference; Node uses it in tests).
  - `effectiveExpiry({ verifiedAt, minutes, resumeOf = null }) → ms` (`min(verifiedAt + minutes, resumeOf)` for a resume).
  - Side effect on load: validators for `kl.lease.request|grant|revoke|watch|status|view` are registered (a second load is harmless).

- [ ] **Step 1: Write the generator**

Create `tests/vectors/lease-v1/generate.js`:

```js
#!/usr/bin/env node
// tests/vectors/lease-v1/generate.js
//
// Rebuilds every lease-v1 vector (fleet stage 5 spec §4.1) from
// ../approval-v1/keys.json.
//   node tests/vectors/lease-v1/generate.js          write the files
//   node tests/vectors/lease-v1/generate.js --check  exit 1 if any differ
// Node signatures (Ed25519) are deterministic. Phone signatures (P-256) are
// randomized, so a committed signature that still verifies over the same
// payload is reused, which keeps the files stable across runs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seal, verifyEs256, deviceIdFromJwk } = require('../../../src/approvals/envelope');
const { deriveNodeId } = require('../../../src/mesh/node-identity');
const L = require('../../../src/gui/lease-protocol');

const DIR = __dirname;
const KEYS = require('../approval-v1/keys.json');
const NOW = '2026-09-23T18:04:11.201Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const nonceOf = (label) => sha(`lease nonce ${label}`).toString('base64url');
const uuidOf = (label) => {
  const b = sha(`lease uuid ${label}`).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function nodeIdentity(name) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(KEYS.nodes[name].seed, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: name, spkiHex: spki.toString('hex'), sign: (b) => crypto.sign(null, b, key) };
}

function p256(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, key: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

const DEVICE_D = {
  A: KEYS.devices.A.d,
  B: KEYS.devices.B.d,
  C: KEYS.devices.C.d,
  D: sha('lease-v1 demo device').toString('base64url'),
  U: sha('lease-v1 unknown device').toString('base64url')
};
const DEVICES = Object.fromEntries(Object.entries(DEVICE_D).map(([k, d]) => {
  const { jwk, key } = p256(d);
  return [k, { id: deviceIdFromJwk(jwk), jwk, key }];
}));

function record(label, { platform = 'android', revokedAt = null } = {}) {
  const d = DEVICES[label];
  return {
    v: 1, device_id: d.id, name: `Test phone ${d.id.slice(2, 6)}`, platform, public_key: d.jwk,
    enrolled_at: '2026-09-01T00:00:00.000Z', enrolled_by: 'console', revoked_at: revokedAt, revoked_by: revokedAt ? 'console' : null, enrollment: null
  };
}
const APPROVERS = [record('A'), record('B'), record('C', { revokedAt: '2026-09-20T00:00:00.000Z' }), record('D', { platform: 'demo' })];

// Committed phone signatures, reused while they still verify.
function sigCache() {
  const cache = new Map();
  if (!fs.existsSync(DIR)) return cache;
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    const v = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (v.input && v.input.alg === 'ES256') cache.set(`${v.input.kid}|${v.input.payload}`, v.input.sig);
  }
  return cache;
}
const CACHE = sigCache();

function phoneSeal(label, message) {
  const d = DEVICES[label];
  const signer = { alg: 'ES256', kid: d.id, sign: (bytes) => crypto.sign('sha256', bytes, { key: d.key, dsaEncoding: 'ieee-p1363' }) };
  const fresh = seal(message, signer);
  const cached = CACHE.get(`${fresh.kid}|${fresh.payload}`);
  if (cached && verifyEs256({ ...fresh, sig: cached }, d.jwk)) return { ...fresh, sig: cached };
  return fresh;
}

const GPU = nodeIdentity('gpu-box');
const WEB = nodeIdentity('web-01');
const GUI_APPS = {
  calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] },
  notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processes: [] }
};
const appsFor = (ids, apps = GUI_APPS) => ids.map((id) => ({ id, name: apps[id].name, path: apps[id].path, processes: [...apps[id].processes] }));
const JOB = 'job-1758650651201-a1b2c3';

function requestFor(label, { appIds = ['calculator', 'notepad'], maxMinutes = 15, resumes = null, leaseLabel = label } = {}) {
  return L.buildLeaseRequest({
    identity: GPU, nodeName: 'gpu-box', jobId: JOB, apps: appsFor(appIds), maxMinutes, reason: 'Enter the totals', resumes: resumes ? uuidOf(`lease ${leaseLabel}`) : null,
    limits: [], origin: { client: 'claude.ai', session: 'mcp-session-1', job_id: JOB }, now: NOW_MS,
    requestId: uuidOf(`request ${label}`), leaseId: uuidOf(`lease ${leaseLabel}`), nonce: nonceOf(`request ${label}`)
  });
}

function pendingOf(message) {
  const { request_id, lease_id, nonce, lease_hash, expires_at, lease } = message;
  return { request_id, lease_id, nonce, lease_hash, expires_at, lease };
}

function grantMessage(request, { decision = 'grant', apps = null, minutes = 10, signedAt = iso(NOW_MS + 5000), device = 'A', overrides = {} } = {}) {
  return {
    v: 1, type: 'kl.lease.grant', request_id: request.request_id, lease_id: request.lease_id, node_id: request.node_id,
    lease_hash: request.lease_hash, nonce: request.nonce, decision,
    grant: decision === 'grant' ? { apps: apps || request.lease.apps.map((a) => a.id), minutes } : null,
    expires_at: request.expires_at, device_id: DEVICES[device].id, signed_at: signedAt, ...overrides
  };
}

function base(now = iso(NOW_MS + 6000)) {
  return { now, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex }, approvers: APPROVERS, allow_test_keys: true, used: [], gui_apps: GUI_APPS, jobs_open: [JOB], gui_max_minutes: 60 };
}

const PHONES = ['node', 'ios', 'android'];

function grantVector(name, { requestOptions = {}, grantOptions = {}, given = {}, pendingOverride = null, device = 'A', expect, check = null, consumers = ['node'], tamper = null, withRequest = false }) {
  const req = requestFor(name, requestOptions);
  const message = grantMessage(req.message, { device, ...grantOptions });
  let input = phoneSeal(device, message);
  if (tamper) input = tamper(input);
  const v = {
    name, consumers, check,
    given: { ...base(), pending: pendingOverride === null ? [pendingOf(req.message)] : pendingOverride, ...given },
    input, expect
  };
  if (withRequest) { v.given.request = req.envelope; v.expect = { ...expect, message }; }
  return v;
}

function revokeMessage(label, { leaseLabel = label, signedAt = iso(NOW_MS + 5000), device = 'A' } = {}) {
  return { v: 1, type: 'kl.lease.revoke', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${leaseLabel}`), reason: 'kill_switch', device_id: DEVICES[device].id, nonce: nonceOf(`revoke ${label}`), signed_at: signedAt };
}

function watchMessage(label) {
  return { v: 1, type: 'kl.lease.watch', node_id: GPU.nodeId, lease_id: uuidOf(`lease ${label}`), device_id: DEVICES.A.id, nonce: nonceOf(`watch ${label}`), signed_at: iso(NOW_MS + 5000) };
}

function viewEnvelope({ tamperHash = false } = {}) {
  const data = sha('lease-v1 frame bytes').toString('base64');
  const hash = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64url');
  return L.buildLeaseView({
    identity: GPU, leaseId: uuidOf('lease view'), seq: 8, toDevice: DEVICES.A.id, state: 'active', locked: false, remainingS: 512,
    foreground: { app_id: 'calculator', matches: true },
    frame: { mime: 'image/jpeg', width: 960, height: 640, sha256: tamperHash ? sha('other').toString('base64url') : hash, data },
    frameDropped: false,
    actions: [{ seq: 41, at: iso(NOW_MS), tool: 'Type', summary: 'Type "12+30=" (6 chars)', result: 'ok' }],
    now: NOW_MS
  });
}

function buildVectors() {
  const out = [];
  const accepted = { accepted: true, reason: null };
  const reject = (reason) => ({ accepted: false, reason });

  out.push(grantVector('grant-valid', { grantOptions: { minutes: 15 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('grant-narrowed', { grantOptions: { apps: ['calculator'], minutes: 10 }, expect: accepted, consumers: PHONES, withRequest: true }));
  out.push(grantVector('deny-valid', { grantOptions: { decision: 'deny' }, expect: accepted, consumers: PHONES, withRequest: true }));
  {
    // A resume: max_minutes = the whole minutes left; the grant may not
    // extend past the original expiry (given.resume_of).
    const v = grantVector('resume-capped', {
      requestOptions: { appIds: ['calculator'], maxMinutes: 4, resumes: true }, grantOptions: { minutes: 4 },
      expect: accepted, consumers: PHONES, withRequest: true
    });
    v.given.resume_of = iso(Date.parse(v.given.now) + 3 * 60000);
    v.expect.effective_expires_at = v.given.resume_of;
    out.push(v);
  }
  out.push(grantVector('grant-phone-clock-behind', { grantOptions: { signedAt: iso(NOW_MS - 3600000) }, expect: accepted }));
  // A fixed 64-byte non-signature, so the file is the same on every run.
  out.push(grantVector('bad-signature', {
    expect: reject('bad_signature'), check: 6,
    tamper: (e) => ({ ...e, sig: Buffer.concat([sha('bad sig r'), sha('bad sig s')]).toString('base64url') })
  }));
  out.push(grantVector('revoked-device', { device: 'C', expect: reject('revoked_device'), check: 5 }));
  out.push(grantVector('unknown-device', { device: 'U', expect: reject('unknown_device'), check: 3 }));
  out.push(grantVector('demo-device', { device: 'D', expect: reject('demo_device'), check: 4 }));
  out.push(grantVector('test-key', { given: { allow_test_keys: false }, expect: reject('test_key'), check: 4 }));
  out.push(grantVector('wrong-node', { grantOptions: { overrides: { node_id: WEB.nodeId } }, expect: reject('wrong_node'), check: 7 }));
  {
    const v = grantVector('replay', { expect: reject('replay'), check: 8 });
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    v.given.used = [{ nonce: v.given.pending[0].nonce, sha256: bytesSha256(Buffer.from(v.input.payload, 'base64url')) }];
    out.push(v);
  }
  out.push(grantVector('unknown-request', { pendingOverride: [], expect: reject('unknown_request'), check: 9 }));
  out.push(grantVector('lease-hash-mismatch', { grantOptions: { overrides: { lease_hash: sha('other lease').toString('base64url') } }, expect: reject('lease_hash_mismatch'), check: 10 }));
  out.push(grantVector('lease-changed-app-path', {
    given: { gui_apps: { ...GUI_APPS, calculator: { ...GUI_APPS.calculator, path: 'C:\\Tools\\calc.exe' } } },
    expect: reject('lease_changed'), check: 12
  }));
  out.push(grantVector('apps-not-requested', { grantOptions: { apps: ['calculator', 'terminal'] }, expect: reject('apps_not_requested'), check: 12 }));
  out.push(grantVector('minutes-over-requested', { grantOptions: { minutes: 20 }, expect: reject('minutes_out_of_range'), check: 12 }));
  out.push(grantVector('minutes-over-60', { requestOptions: { maxMinutes: 60 }, grantOptions: { minutes: 61 }, expect: reject('minutes_out_of_range'), check: 12 }));
  {
    const v = grantVector('expired', { expect: reject('expired'), check: 11 });
    v.given.now = iso(NOW_MS + 300001);
    out.push(v);
  }

  const leaseGiven = (known) => ({ ...base(), known_leases: known });
  out.push({ name: 'revoke-valid', consumers: PHONES, check: null, given: { ...leaseGiven([uuidOf('lease revoke-valid')]) }, input: phoneSeal('A', revokeMessage('revoke-valid')), expect: { ...accepted, message: revokeMessage('revoke-valid') } });
  out.push({ name: 'revoke-phone-clock-off', consumers: ['node'], check: null, given: leaseGiven([uuidOf('lease revoke-phone-clock-off')]), input: phoneSeal('A', revokeMessage('revoke-phone-clock-off', { signedAt: iso(NOW_MS + 86400000) })), expect: accepted });
  out.push({ name: 'revoke-unknown-lease', consumers: ['node'], check: 9, given: leaseGiven([]), input: phoneSeal('A', revokeMessage('revoke-unknown-lease')), expect: reject('unknown_lease') });
  {
    const input = phoneSeal('A', revokeMessage('revoke-replayed'));
    const { bytesSha256 } = require('../../../src/approvals/verify-device');
    const given = { ...leaseGiven([uuidOf('lease revoke-replayed')]), used: [{ nonce: nonceOf('revoke revoke-replayed'), sha256: bytesSha256(Buffer.from(input.payload, 'base64url')) }] };
    out.push({ name: 'revoke-replayed', consumers: ['node'], check: 8, given, input, expect: reject('replay') });
  }
  out.push({ name: 'watch-valid', consumers: PHONES, check: null, given: leaseGiven([uuidOf('lease watch-valid')]), input: phoneSeal('A', watchMessage('watch-valid')), expect: { ...accepted, message: watchMessage('watch-valid') } });

  const viewGiven = { now: NOW, node: { id: GPU.nodeId, name: 'gpu-box', key: GPU.spkiHex } };
  out.push({ name: 'view-node-sig-valid', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope(), expect: accepted });
  out.push({ name: 'view-tampered-frame', consumers: PHONES, check: null, given: viewGiven, input: viewEnvelope({ tamperHash: true }), expect: reject('frame_hash_mismatch') });
  return out;
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  const vectors = buildVectors();
  const names = new Set(vectors.map((v) => `${v.name}.json`));
  let differ = 0;
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && !names.has(n))) {
    if (check) { differ += 1; process.stderr.write(`not generated: ${f}\n`); } else fs.unlinkSync(path.join(DIR, f));
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize, NOW, DEVICES, GUI_APPS, JOB };
```

- [ ] **Step 2: Write the failing test**

Create `tests/lease-vectors.test.js`:

```js
// tests/lease-vectors.test.js
//
// Every lease-v1 vector through the production checks, the committed files
// equal to what generate.js builds, and the other vector sets untouched.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setLogLevel } = require('../src/logging');
const { NonceCache } = require('../src/approvals/verify-device');
const L = require('../src/gui/lease-protocol');
const { approverStoreWith } = require('./helpers/approver-set');
const { buildVectors, serialize } = require('./vectors/lease-v1/generate');

setLogLevel('fatal');
const DIR = path.join(__dirname, 'vectors', 'lease-v1');
const EXPECTED = [
  'grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'grant-phone-clock-behind', 'bad-signature', 'revoked-device',
  'unknown-device', 'demo-device', 'test-key', 'wrong-node', 'replay', 'unknown-request', 'lease-hash-mismatch',
  'lease-changed-app-path', 'apps-not-requested', 'minutes-over-requested', 'minutes-over-60', 'expired', 'revoke-valid',
  'revoke-phone-clock-off', 'revoke-unknown-lease', 'revoke-replayed', 'watch-valid', 'view-node-sig-valid', 'view-tampered-frame'
];
const PHONE = ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid', 'view-node-sig-valid', 'view-tampered-frame'];

const vectors = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = new Map(vectors.map((v) => [v.name, v]));
const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function run(v) {
  const g = v.given;
  const now = Date.parse(g.now);
  if (v.name.startsWith('view-')) return L.verifyLeaseView(v.input, { nodeId: g.node.id, nodePublicKeyHex: g.node.key });
  const store = await approverStoreWith(g.approvers, { allowTestKeys: g.allow_test_keys, now: () => now });
  stores.push(store);
  const nonces = new NonceCache({ now: () => now });
  for (const u of g.used) nonces.add(u.nonce, u.sha256);
  if (v.name.startsWith('revoke-')) return L.verifyLeaseRevoke(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  if (v.name.startsWith('watch-')) return L.verifyLeaseWatch(v.input, { approverStore: store, nodeId: g.node.id, nonces, knownLease: (id) => g.known_leases.includes(id) });
  const pending = new Map(g.pending.map((p) => [p.request_id, p]));
  return L.verifyLeaseGrant(v.input, {
    approverStore: store, nodeId: g.node.id, nonces, pending, guiApps: g.gui_apps,
    jobOpen: (jobId) => g.jobs_open.includes(jobId), guiMaxMinutes: g.gui_max_minutes
  }, now);
}

describe('lease-v1 vectors', () => {
  it('has exactly the expected set, and phones consume exactly theirs', () => {
    assert.equal(EXPECTED.length, 26);
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED].sort());
    for (const phone of ['ios', 'android']) {
      assert.deepEqual(vectors.filter((v) => v.consumers.includes(phone)).map((v) => v.name).sort(), [...PHONE].sort());
    }
    assert.ok(vectors.every((v) => v.consumers.includes('node')));
  });

  it('the committed files are exactly what generate.js builds', () => {
    for (const v of buildVectors()) assert.equal(serialize(byName.get(v.name)), serialize(v), v.name);
  });

  it('approval-v1 and client-grant-v1 are untouched', () => {
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'approval-v1')).filter((f) => f.endsWith('.json') && f !== 'keys.json' && f !== 'jcs.json').length > 0, true);
    assert.equal(fs.readdirSync(path.join(__dirname, 'vectors', 'client-grant-v1')).filter((f) => f.endsWith('.json')).length, 37);
  });

  for (const name of EXPECTED) {
    it(name, async () => {
      const v = byName.get(name);
      const r = await run(v);
      assert.equal(r.accepted, v.expect.accepted, `${name}: ${r.reason}`);
      assert.equal(r.reason, v.expect.reason);
      if (v.check !== null && !name.startsWith('view-')) assert.equal(r.check, v.check);
    });
  }

  it('resume-capped: a resume never extends past the original expiry', () => {
    const v = byName.get('resume-capped');
    const eff = L.effectiveExpiry({ verifiedAt: Date.parse(v.given.now), minutes: 4, resumeOf: Date.parse(v.given.resume_of) });
    assert.equal(new Date(eff).toISOString(), v.expect.effective_expires_at);
  });

  it('the phone-built messages are exactly the signed payloads', () => {
    for (const name of ['grant-valid', 'grant-narrowed', 'deny-valid', 'resume-capped', 'revoke-valid', 'watch-valid']) {
      const v = byName.get(name);
      const payload = JSON.parse(Buffer.from(v.input.payload, 'base64url').toString('utf8'));
      assert.deepEqual(payload, v.expect.message, name);
    }
  });
});

describe('lease-v1 message shapes', () => {
  it('the node-signed request validates and hashes its lease', () => {
    const v = byName.get('grant-valid');
    const { open } = require('../src/approvals/envelope');
    const { validateMessage } = require('../src/approvals/messages');
    const { message } = open(v.given.request);
    assert.equal(validateMessage('kl.lease.request', message), null);
    assert.equal(message.lease_hash, L.leaseHash(message.lease));
    assert.ok(Date.parse(message.expires_at) - Date.parse(message.created_at) <= L.REQUEST_TTL_MS);
  });

  it('refuses unknown keys and out-of-range fields', () => {
    const { validateMessage } = require('../src/approvals/messages');
    const v = byName.get('revoke-valid');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, extra: 1 }), 'malformed');
    assert.equal(validateMessage('kl.lease.revoke', { ...v.expect.message, reason: 'because' }), 'malformed');
    assert.equal(validateMessage('kl.lease.watch', { ...byName.get('watch-valid').expect.message, lease_id: 'x' }), 'malformed');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/lease-vectors.test.js`
Expected: FAIL with `Cannot find module '../src/gui/lease-protocol'`.

- [ ] **Step 4: Write `src/gui/lease-protocol.js`**

```js
// src/gui/lease-protocol.js
// lease-v1 (fleet stage 5 spec §3.6, §4.1; docs/protocol/lease-v1.md): pure
// builders and checks for computer-use leases. Node-signed: request, status,
// view. Phone-signed: grant, revoke, watch, each through F3's
// verifyDeviceEnvelope (checks 1–8) and then the lease checks (9–12).
// Loaded by the relay (relay-extension.js) too, so it requires no agent code.
const crypto = require('crypto');
const { seal, open, nodeSigner, verifyEd25519, EnvelopeError } = require('../approvals/envelope');
const messages = require('../approvals/messages');
const { verifyDeviceEnvelope } = require('../approvals/verify-device');
const { canonicalize, sha256b64url } = require('../platform/jcs');

const { isTimestamp, NONCE_RE, DEVICE_ID_RE, NODE_ID_RE, normalizeOrigin, iso, randomNonce } = messages;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LEASE_LIMITS = Object.freeze(['no_lock_detect', 'no_human_yield']);
const STATES = Object.freeze(['pending', 'active', 'suspended', 'ended']);
const REVOKE_REASONS = Object.freeze(['kill_switch', 'owner']);
const REQUEST_TTL_MS = 5 * 60 * 1000;
const VIEW_MAX_BYTES = 262144;
const MAX_MINUTES = 60;
// Reason → the approval-v1 check number it belongs to (program §4.12).
const CHECK_OF = Object.freeze({
  malformed: 1, unsupported_version: 1, unknown_device: 3, demo_device: 4, test_key: 4, revoked_device: 5,
  bad_signature: 6, wrong_node: 7, replay: 8, already_decided: 8, unknown_request: 9, unknown_lease: 9,
  nonce_mismatch: 10, lease_hash_mismatch: 10, expires_mismatch: 10, expired: 11,
  lease_changed: 12, job_closed: 12, apps_not_requested: 12, minutes_out_of_range: 12
});

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const within = (v, max) => isString(v) && Array.from(v).length <= max;
const nullOr = (test) => (v) => v === null || test(v);
function exactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}
const isStringList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every((s) => isString(s) && each(s));
const uniqueSorted = (list) => list.every((x, i) => i === 0 || list[i - 1] < x);

function checkApp(a) {
  return isPlainObject(a) && exactKeys(a, ['id', 'name', 'path', 'processes'])
    && APP_ID_RE.test(a.id) && within(a.name, 64) && within(a.path, 1024) && isStringList(a.processes, 16, (s) => within(s, 1024));
}

function checkLease(l) {
  return isPlainObject(l) && exactKeys(l, ['kind', 'job_id', 'apps', 'max_minutes', 'reason', 'resumes', 'limits'])
    && l.kind === 'computer_use' && within(l.job_id, 200) && l.job_id.length > 0
    && Array.isArray(l.apps) && l.apps.length >= 1 && l.apps.length <= 8 && l.apps.every(checkApp)
    && new Set(l.apps.map((a) => a.id)).size === l.apps.length
    && Number.isInteger(l.max_minutes) && l.max_minutes >= 1 && l.max_minutes <= MAX_MINUTES
    && within(l.reason, 280) && l.reason.length > 0
    && nullOr((v) => UUID_V4_RE.test(v))(l.resumes)
    && isStringList(l.limits, LEASE_LIMITS.length, (s) => LEASE_LIMITS.includes(s)) && uniqueSorted(l.limits);
}

function checkOrigin(o) {
  return isPlainObject(o) && exactKeys(o, ['client', 'session', 'job_id']) && isString(o.client)
    && Object.values(o).every((v) => v === null || within(v, 200));
}

function checkFrame(f) {
  return f === null || (isPlainObject(f) && exactKeys(f, ['mime', 'width', 'height', 'sha256', 'data'])
    && f.mime === 'image/jpeg' && Number.isInteger(f.width) && Number.isInteger(f.height) && f.width > 0 && f.height > 0
    && HASH_RE.test(f.sha256) && isString(f.data) && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data));
}

function checkAction(a) {
  return isPlainObject(a) && exactKeys(a, ['seq', 'at', 'tool', 'summary', 'result'])
    && Number.isInteger(a.seq) && isTimestamp(a.at) && within(a.tool, 32) && within(a.summary, 120) && within(a.result, 80);
}

const VALIDATORS = {
  'kl.lease.request': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'node_name', 'lease', 'lease_hash', 'origin', 'created_at', 'expires_at', 'nonce'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && within(m.node_name, 64)
    && checkLease(m.lease) && HASH_RE.test(m.lease_hash) && checkOrigin(m.origin) && isTimestamp(m.created_at) && isTimestamp(m.expires_at)
    && Date.parse(m.expires_at) > Date.parse(m.created_at) && Date.parse(m.expires_at) - Date.parse(m.created_at) <= REQUEST_TTL_MS
    && NONCE_RE.test(m.nonce) && (m.lease.resumes === null || m.lease.resumes === m.lease_id),
  'kl.lease.grant': (m) => exactKeys(m, ['v', 'type', 'request_id', 'lease_id', 'node_id', 'lease_hash', 'nonce', 'decision', 'grant', 'expires_at', 'device_id', 'signed_at'])
    && UUID_V4_RE.test(m.request_id) && UUID_V4_RE.test(m.lease_id) && NODE_ID_RE.test(m.node_id) && HASH_RE.test(m.lease_hash)
    && NONCE_RE.test(m.nonce) && isTimestamp(m.expires_at) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at)
    && ((m.decision === 'deny' && m.grant === null)
      || (m.decision === 'grant' && isPlainObject(m.grant) && exactKeys(m.grant, ['apps', 'minutes'])
        && isStringList(m.grant.apps, 8, (s) => APP_ID_RE.test(s)) && m.grant.apps.length >= 1
        && Number.isInteger(m.grant.minutes) && m.grant.minutes >= 1 && m.grant.minutes <= 1440)),
  'kl.lease.revoke': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'reason', 'device_id', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && REVOKE_REASONS.includes(m.reason)
    && DEVICE_ID_RE.test(m.device_id) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.watch': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'device_id', 'nonce', 'signed_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && DEVICE_ID_RE.test(m.device_id) && NONCE_RE.test(m.nonce) && isTimestamp(m.signed_at),
  'kl.lease.status': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'state', 'locked', 'reason', 'expires_at'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && STATES.includes(m.state) && typeof m.locked === 'boolean' && nullOr((v) => within(v, 64))(m.reason) && nullOr(isTimestamp)(m.expires_at),
  'kl.lease.view': (m) => exactKeys(m, ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'to_device', 'state', 'locked', 'remaining_s', 'foreground', 'frame', 'frame_dropped', 'actions'])
    && NODE_ID_RE.test(m.node_id) && UUID_V4_RE.test(m.lease_id) && Number.isInteger(m.seq) && m.seq >= 1 && isTimestamp(m.at)
    && DEVICE_ID_RE.test(m.to_device) && STATES.includes(m.state) && typeof m.locked === 'boolean'
    && Number.isInteger(m.remaining_s) && m.remaining_s >= 0
    && isPlainObject(m.foreground) && exactKeys(m.foreground, ['app_id', 'matches']) && nullOr((v) => APP_ID_RE.test(v))(m.foreground.app_id) && typeof m.foreground.matches === 'boolean'
    && checkFrame(m.frame) && typeof m.frame_dropped === 'boolean'
    && Array.isArray(m.actions) && m.actions.length <= 50 && m.actions.every(checkAction)
};

for (const [type, validator] of Object.entries(VALIDATORS)) {
  try {
    messages.registerMessageValidator(type, validator);
  } catch (err) {
    if (!/already has a validator/.test(err.message)) throw err;
  }
}

const leaseHash = (lease) => sha256b64url(canonicalize(lease));

function buildLeaseRequest({ identity, nodeName, jobId, apps, maxMinutes, reason, resumes = null, limits = [], origin, now = Date.now(), requestId = null, leaseId = null, nonce = null }) {
  const lid = leaseId || crypto.randomUUID();
  const lease = {
    kind: 'computer_use',
    job_id: String(jobId),
    apps: apps.map((a) => ({ id: a.id, name: a.name, path: a.path, processes: [...a.processes] })),
    max_minutes: maxMinutes,
    reason: String(reason),
    resumes: resumes ? lid : null,
    limits: [...new Set(limits)].filter((l) => LEASE_LIMITS.includes(l)).sort()
  };
  const message = {
    v: 1,
    type: 'kl.lease.request',
    request_id: requestId || crypto.randomUUID(),
    lease_id: lid,
    node_id: identity.nodeId,
    node_name: String(nodeName || identity.nodeName || 'unnamed-node'),
    lease,
    lease_hash: leaseHash(lease),
    origin: (({ client, session, job_id: j }) => ({ client, session, job_id: j }))(normalizeOrigin(origin)),
    created_at: iso(now),
    expires_at: iso(now + REQUEST_TTL_MS),
    nonce: nonce || randomNonce()
  };
  return { message, envelope: seal(message, nodeSigner(identity)) };
}

function buildLeaseStatus({ identity, leaseId, seq, state, locked = false, reason = null, expiresAt = null, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.status', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), state, locked,
    reason: reason === null || reason === undefined ? null : String(reason).slice(0, 64),
    expires_at: expiresAt === null || expiresAt === undefined ? null : iso(expiresAt)
  }, nodeSigner(identity));
}

function buildLeaseView({ identity, leaseId, seq, toDevice, state, locked, remainingS, foreground, frame, frameDropped, actions, now = Date.now() }) {
  return seal({
    v: 1, type: 'kl.lease.view', node_id: identity.nodeId, lease_id: leaseId, seq, at: iso(now), to_device: toDevice, state, locked,
    remaining_s: Math.max(0, Math.floor(remainingS)), foreground, frame, frame_dropped: frameDropped === true, actions
  }, nodeSigner(identity));
}

const reject = (reason) => ({ accepted: false, check: CHECK_OF[reason] || null, reason });
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// jobOpen fails closed (R-F5-7): a caller that passes none gets job_closed.
function verifyLeaseGrant(envelope, { approverStore, nodeId, nonces, pending, guiApps, jobOpen = () => false, guiMaxMinutes = MAX_MINUTES }, now = Date.now()) {
  const device = verifyDeviceEnvelope(envelope, { approverStore, type: 'kl.lease.grant', nodeId, nonces });
  if (!device.ok) return reject(device.reason);
  const m = device.message;
  const request = pending.get(m.request_id);
  if (!request || request.lease_id !== m.lease_id) return reject('unknown_request');
  if (m.nonce !== request.nonce) return reject('nonce_mismatch');
  if (m.lease_hash !== request.lease_hash) return reject('lease_hash_mismatch');
  if (m.expires_at !== request.expires_at) return reject('expires_mismatch');
  if (!(now <= Date.parse(request.expires_at))) return reject('expired');
  if (leaseHash(request.lease) !== m.lease_hash) return reject('lease_changed');
  for (const app of request.lease.apps) {
    const live = guiApps && Object.hasOwn(guiApps, app.id) ? guiApps[app.id] : null;
    if (!live || live.path !== app.path || !sameList(live.processes, app.processes)) return reject('lease_changed');
  }
  if (!jobOpen(request.lease.job_id)) return reject('job_closed');
  if (m.decision === 'grant') {
    const requested = request.lease.apps.map((a) => a.id);
    const apps = m.grant.apps;
    if (new Set(apps).size !== apps.length || !apps.every((id) => requested.includes(id))) return reject('apps_not_requested');
    const cap = Math.min(request.lease.max_minutes, guiMaxMinutes, MAX_MINUTES);
    if (m.grant.minutes < 1 || m.grant.minutes > cap) return reject('minutes_out_of_range');
  }
  return { accepted: true, check: null, reason: null, message: m, bytes: device.bytes, deviceId: device.deviceId, request };
}

function verifyLeaseControl(type) {
  return (envelope, { approverStore, nodeId, nonces, knownLease }) => {
    const device = verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces });
    if (!device.ok) return reject(device.reason);
    if (!knownLease(device.message.lease_id)) return reject('unknown_lease');
    return { accepted: true, check: null, reason: null, message: device.message, bytes: device.bytes, deviceId: device.deviceId };
  };
}

const verifyLeaseRevoke = verifyLeaseControl('kl.lease.revoke');
const verifyLeaseWatch = verifyLeaseControl('kl.lease.watch');

// What a phone checks on a view (spec §3.10, §4.1): the node's signature
// over the received bytes, the shape, the size, and that the frame is the
// one the node hashed.
function verifyLeaseView(envelope, { nodeId, nodePublicKeyHex, maxBytes = VIEW_MAX_BYTES }) {
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return { accepted: false, reason: 'malformed' };
    throw err;
  }
  if (opened.bytes.length > maxBytes) return { accepted: false, reason: 'too_large' };
  if (envelope.alg !== 'Ed25519' || envelope.kid !== nodeId) return { accepted: false, reason: 'malformed' };
  if (!verifyEd25519(envelope, nodePublicKeyHex)) return { accepted: false, reason: 'bad_signature' };
  if (messages.validateMessage('kl.lease.view', opened.message)) return { accepted: false, reason: 'malformed' };
  if (opened.message.node_id !== nodeId) return { accepted: false, reason: 'wrong_node' };
  const frame = opened.message.frame;
  if (frame) {
    const hash = crypto.createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('base64url');
    if (hash !== frame.sha256) return { accepted: false, reason: 'frame_hash_mismatch' };
  }
  return { accepted: true, reason: null, message: opened.message };
}

function effectiveExpiry({ verifiedAt, minutes, resumeOf = null }) {
  const fresh = verifiedAt + minutes * 60000;
  return resumeOf === null ? fresh : Math.min(fresh, resumeOf);
}

module.exports = {
  LEASE_LIMITS, STATES, REQUEST_TTL_MS, VIEW_MAX_BYTES, CHECK_OF,
  leaseHash, buildLeaseRequest, buildLeaseStatus, buildLeaseView,
  verifyLeaseGrant, verifyLeaseRevoke, verifyLeaseWatch, verifyLeaseView, effectiveExpiry
};
```

Two notes for the implementer:
- `src/approvals/messages.js` exports `normalizeOrigin`, `iso`, `isTimestamp`, `randomNonce` and the three id patterns in its `module.exports` (checked on `532efcf`). `normalizeOrigin` adds `deviceId` for `client: 'desktop'`, which does occur here: a paired desktop attached to this service runs its chat turns in the service with that client. `buildLeaseRequest` keeps only the three keys, because `kl.lease.request`'s `origin` has exactly those (`checkOrigin`).
- What the phone's "Asked by" line shows is `origin.client`: a front-door client's declared name (or its client id when the name is empty or one of the reserved local names, `frontDoorClient` in `src/fleet/fleet-tools.js`), `stdio-mcp` for this node's own MCP client, `desktop` for a paired desktop's chat, `king-louie` for the node's other runs. `origin.job_id` is null for a chat run; the lease's own `job_id` (`chat:<id>`) is what binds it.
- `verifyLeaseGrant` never marks the nonce used; the caller (`LeaseManager.onGrant`, Task 9) adds it to the cache only when a decision is applied, so a rejected grant leaves the request pending (spec §3.6 "A failed check leaves the request pending"). One rejection is different in the caller: `job_closed` ends the pending lease, because a closed job cannot come back (R-F5-7, Task 9).

- [ ] **Step 5: Generate the vectors and run the tests**

Run: `node tests/vectors/lease-v1/generate.js` → `26 vectors written`.
Run it again, then `node tests/vectors/lease-v1/generate.js --check` → `26 vectors match` (the second run reuses the committed P-256 signatures).
Run: `node --test tests/lease-vectors.test.js tests/client-grant-v1-vectors.test.js tests/approvals-protocol.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Write `docs/protocol/lease-v1.md`**

```markdown
# lease-v1 — computer-use leases

A lease lets an agent drive a few allowlisted desktop apps on one node for a
bounded time, under one phone signature (fleet stage 5 spec §3.6, §4.1; the one
exception to trust principle 3). Envelopes, JCS, keys and identifiers are
approval-v1's (§1–§2 of `approval-v1.md`).

## 1. Messages

Node-signed (Ed25519, `kid` = `node_id`): `kl.lease.request`, `kl.lease.status`,
`kl.lease.view`. Phone-signed (ES256, `kid` = `device_id`): `kl.lease.grant`,
`kl.lease.revoke`, `kl.lease.watch`. Every object has exactly the keys shown.

```jsonc
{ "v": 1, "type": "kl.lease.request", "request_id": "uuid-v4", "lease_id": "uuid-v4",
  "node_id": "kl-…", "node_name": "gpu-box",
  "lease": { "kind": "computer_use", "job_id": "job-…",
             "apps": [{ "id": "calculator", "name": "Calculator", "path": "C:\\Windows\\System32\\calc.exe", "processes": ["CalculatorApp.exe"] }],
             "max_minutes": 15, "reason": "Enter the totals", "resumes": null, "limits": [] },
  "lease_hash": "b64url(SHA-256(JCS(lease)))",
  "origin": { "client": "claude.ai", "session": "…", "job_id": "job-…" },
  "created_at": "RFC3339", "expires_at": "≤ created_at + 5 min", "nonce": "b64url(32)" }
{ "v": 1, "type": "kl.lease.grant", "request_id", "lease_id", "node_id", "lease_hash", "nonce" (the request's),
  "decision": "grant" | "deny", "grant": { "apps": ["calculator"], "minutes": 10 } | null,
  "expires_at" (the request's), "device_id", "signed_at" (informational) }
{ "v": 1, "type": "kl.lease.revoke", "node_id", "lease_id", "reason": "kill_switch" | "owner", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.watch", "node_id", "lease_id", "device_id", "nonce" (fresh), "signed_at" }
{ "v": 1, "type": "kl.lease.status", "node_id", "lease_id", "seq", "at", "state": "pending|active|suspended|ended",
  "locked": false, "reason": "…" | null, "expires_at": "…" | null }
{ "v": 1, "type": "kl.lease.view", "node_id", "lease_id", "seq", "at", "to_device", "state", "locked", "remaining_s",
  "foreground": { "app_id": "calculator" | null, "matches": true },
  "frame": { "mime": "image/jpeg", "width", "height", "sha256": "b64url(SHA-256(JPEG bytes))", "data": "base64" } | null,
  "frame_dropped": false,
  "actions": [{ "seq", "at", "tool", "summary" (≤ 120), "result": "ok" | "refused:<code>" }] (≤ 50) }
```

Rules: `lease.apps` 1–8 unique ids from `gui.apps`; `max_minutes` 1–60 and ≤
`gui.lease.max_minutes`; `reason` ≤ 280 (model-written: phones label it "Agent's
reason (unverified)"); `resumes` is `null` or equals `lease_id`; `limits` ⊆
`no_lock_detect`, `no_human_yield`, sorted; `grant.apps` a non-empty subset of
the requested ids; `1 ≤ grant.minutes ≤ max_minutes`; a view ≤ 256 KiB.

## 2. What the node checks on a grant

| # | Check | Reason |
|---|---|---|
| 1–8 | approval-v1 checks 1–8 with `type: 'kl.lease.grant'` (`verifyDeviceEnvelope`) | `malformed` … `replay`, `already_decided` |
| 9 | A pending request with this `request_id` and `lease_id` | `unknown_request` |
| 10 | `nonce`, `lease_hash`, `expires_at` equal the request's | `nonce_mismatch`, `lease_hash_mismatch`, `expires_mismatch` |
| 11 | Node clock ≤ `expires_at` | `expired` |
| 12 | Fresh hash of the pending lease = `lease_hash`, and each app is still in `gui.apps` with the same `path`/`processes`; the job is open; `grant.apps` ⊆ requested; minutes in range | `lease_changed`, `job_closed`, `apps_not_requested`, `minutes_out_of_range` |

A failed check leaves the request pending; every result is audited. The one
exception is `job_closed`: the job cannot come back, so the node ends the
pending lease and answers `{ state: 'ended', reason: 'job_closed' }`. A job is
open only while the node knows it and it has not ended: a `job-…` id in its
job table and not terminal, or a `chat:<id>` whose chat still exists. Expiry is
node-clock only: `verified_at + minutes`, and for a resume `min(that, the
original expiry)`. `signed_at` is recorded and never judged.

The node sends no request at all, and so nothing reaches the relay or a phone,
for a run that has neither a job id nor a chat id (`job_required`), for a job
that is not open (`job_closed`), or for a front-door client whose grant does
not cover `fleet:unsafe` on this node (refused in the node's own words for a
missing scope).

Revoke and watch: checks 1–8 with their own type and a 10-minute nonce cache,
then the `lease_id` must be known (`unknown_lease`). Any enrolled device may
revoke any lease; a replayed revoke changes nothing and re-sends the status.

## 3. What the phone checks and shows

- `request`, `status`, `view`: the node signature against the node key pinned
  at enrollment, over the received bytes; anything that fails is not shown.
- `request`: `lease_hash` equals SHA-256 of the JCS lease. Show node name, job id,
  origin client, the reason labelled "Agent's reason (unverified)", one row per
  app with `name`, full `path` and `processes` (each a toggle, default on), a
  duration stepper 1…`max_minutes` (a resume shows the remaining time, fixed), and
  the `limits` as warnings. Grant = biometric signature of `kl.lease.grant`.
- `view`: ≤ 256 KiB, `frame.sha256` matches `frame.data` (else
  `frame_hash_mismatch`).
- Canonical form: lease messages contain `null` and integers other than `v`;
  the phones' JCS emits both (RFC 8785).

## 4. Transport (relay routes, mounted by `src/gui/relay-extension.js`)

| Route / method | Shape |
|---|---|
| node → relay | `link.send(envelope, { push: { kind: 'lease', id: request_id, expires_at } })` for requests; statuses plain; views with `{ to_device }`; mailbox prefix `kl.lease.`, 5 min, 256 KiB |
| `GET /v1/leases?wait=0..25` | `[{ node_id, envelope, status }]`: pending requests for the device's nodes with the latest status of each lease |
| `POST /v1/leases/{lease_id}/grant` · `/revoke` · `/watch` | body = the phone envelope → `202 { state, reason? }`, `503 node_offline`. The `202` for `/watch` also carries `after_seq`: the mailbox position read before the node heard the watch, so a phone that fetches on tap can ask for views from there with `wait` and get the frame this watch causes |
| `GET /v1/leases/{lease_id}/views?after_seq&wait` | `[{ seq, envelope }]` of views to the caller and statuses, oldest first |
| node methods | `lease.grant`, `lease.revoke`, `lease.watch`: `{ envelope }` → `{ state, reason? }` |

## 5. Vectors

`tests/vectors/lease-v1/`, rebuilt by `generate.js`; shape
`{ name, consumers, check, given: { now, node, approvers, allow_test_keys, pending, used, gui_apps, jobs_open, gui_max_minutes }, input, expect: { accepted, reason } }`.
Phone-built vectors also carry `given.request` and `expect.message` (the exact
message the phone must build). Phones consume `grant-valid`, `grant-narrowed`,
`deny-valid`, `resume-capped`, `revoke-valid`, `watch-valid`,
`view-node-sig-valid`, `view-tampered-frame`.
```

- [ ] **Step 7: Commit**

```bash
git add src/gui/lease-protocol.js tests/vectors/lease-v1 tests/lease-vectors.test.js docs/protocol/lease-v1.md
git commit -m "feat(gui): lease-v1 messages, checks, vectors and protocol doc

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 1

Every test file Tasks 1–6 name shows `# fail 0` (the full suite runs once, in Task 21). Part 2 (`2026-09-23-fleet-stage5-session-helper-part2.md`) starts at Task 7 on these commits.
