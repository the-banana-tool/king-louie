# Final fix round: attach stage 2 (feat/attach-stage2, from 1ec106e6)

Rulings from the controller, numbered as given. RED was taken by running the changed and new test files against an untouched checkout of 1ec106e6 in a scratch worktree (removed after, its `node_modules` junction first): 767 pass, 50 fail, 1 skipped. Only the first batch (finding 1) was run RED before its source was written; the rest of the tests were written after their source and proved RED this way. Each finding below names its tests. GREEN is the whole suite at the end of this report.

## 1. Critical: oversize chats. Addressed.

- A personal node's plan says `chatParts: true`; `planBatches` then sends a chat through `chatEntries`: one entry when it fits, else runs of messages under `maxBytes`, in order, and a message bigger than that alone in a batch of one. `DesktopImporter#apply` lets a batch of one chat entry past 2 MiB up to `MAX_CHAT_PART_BYTES` (`LIMITS.frameBytes` less 1 MiB), personal only.
- `collectChatPart` holds parts in memory under the plan and checks their order; the last part goes through `writeChat`, so the landing is `landChat`'s one transaction with the private mark. A plan that ends early, or expires, leaves nothing. `finish` reports it as a failure and the next plan offers it as `new`.
- One message past the limit: the source's inventory says `tooLargeBytes`, the plan makes it `needs-attention` with the chat's title and size, `partial: true`; it is in `leftBehind` and **Stays on this computer**. The chat lands with `TOO_LARGE_TEXT` in that message's place, so order, `seq` and the count hold. The manifest records `incomplete: true`. Verification does not look at `needs-attention`, so the mark is not blocked. A chat already on the node is said and left alone.
- A reading to flag: "it lands" in the ruling I took as the chat landing without that message's content. The alternative is the chat staying behind whole. The whole message stays in the profile and the backup either way.
- The text is now "Moving again sends what did not arrive; each line says what else it needs."
- A fleet plan has no `chatParts`, a fleet send still skips, and a fleet importer refuses a part.

RED: `tests/migration-oversize.test.js`, 8 of 9 (run before the source). GREEN: 9 of 9, including 5 MB of attachments through `migrationApply` on a real bridge, with a 4 MB single message; a too-large message through the same path; a cut-off mid-chat; parts out of order; a private chat in parts; a mark that fails landing nothing; fleet unchanged.

## 2. Critical: unnamed stores. Addressed.

`STAYS_BEHIND_FIXED` names `ops-memory.jsonl`, the contact folder and the executors folder, one line each. The source reads each package's `kingLouie.executor.id` from `executors/`; a case whose `.kl/executors.json` names one, or an `outreach` case when it names none, gets `Case <dir>: its agent <id> is in the executors folder and does not move. Set it up on the node before this case sends anything.` That list is on the source, never sent to the node.

RED/GREEN: `stays behind names the three stores, and an outreach case says its agent needs setting up`.

## 3. Important: restart. Addressed.

The report carries `needsRestart`; the marker gets `restartDue` only then. `migrationApply` restarts nothing and `startAttached` no longer restarts for an owed one. The steps after the move and the attached banner offer **Restart King Louie Node now** and **Later**; the press clears it, and so does Later (`desktop:restartLater`). Choice to flag: Later is an answer, so it does not ask again at the next launch; the note saying when things take effect stays on screen up to Done. An unanswered one is offered at every launch.

RED/GREEN: `a verified apply restarts nothing by itself…`, `a restart still owed at a later launch is offered, never done unprompted`, `a verified apply writes restartDue only when the report says needsRestart`, `a restart the move left owed is a press with Later…`.

## 4. Important: words. Addressed, and one remedy needed code to be true.

`caseOnNodeDiffers` and `landedIncomplete` name the two non-destructive ways first; removing the node's folder is last, naming what it loses. Checking each in the code:

- **Moved elsewhere** did not work for `landedIncomplete`: the incomplete check ran first. It now runs after the moved check, personal only.
- **Rename the folder** did not land a second case. It landed a folder with the same id, and `CaseStore#get` finds the first by id, so every action on the second acted on the first. The plan now gives such a case a new id (`caseExpected.secondId`), `finish` rewrites its `case.yaml` in staging with `slug` the new folder, and its chats follow (`caseIdRemap`). The changed `case.yaml` reads dirty until the node's sweep commits it. It does not count as missing.
- **Not now** is on the plan screen and on the unverified screen, as before.
- Caps on `note` and `why` were 400 and 800 characters and would have cut these lines; they are now 1200.

RED/GREEN: `final review 4: renaming the desktop's folder lands a second case…`, `final review 4: Moved elsewhere also clears a landing on record as incomplete`, `what a refusal says…`.

## 5. Important: task pinned to a removed path. Addressed.

`parseTaskXml` reads the Command, and the program and entry inside PowerShell's arguments (the Command is always powershell.exe, so it alone says nothing). `queryTask` `stat`s both: `gone` on ENOENT only, since a path inside the asar reads ENOTDIR to plain Node. `runNodeTask` refuses `NODE_TASK_PROGRAM_GONE` before `/Run`; the start step, the install step, the pane and the banner say which path and offer Install; `runInstall` accepts a registered task only when it is the owner's, enabled, and its program is gone. A disabled or another account's task is refused as before. Spec §6.8 amended.

RED/GREEN: `what the task runs` (5 tests; 3 RED), `a task whose program is gone…`, `Install still refuses a task whose program is there…`, `a task whose program is gone goes to install…`.

## 6. Important: `VERSION_ACTION`. Addressed.

`runs: 'app'` keeps **Restart King Louie Node to update it**. `runs: 'folder'` says the node runs from a folder and to update it there, with no press. Not known: the plain line, no press. `startAttached` now reads the task for a node already up, so the row knows. Spec §6.8 amended.

RED/GREEN: `the version row goes by what the task runs`, `versionMismatch adds the row and the press where the node is attached`.

## 7. Important: `courier-proxy`. Addressed.

Sets `ELECTRON_RUN_AS_NODE=1` when under Electron (an `electron` constructor argument, as `spawnWriter` has), else deletes it as before. `tests/electron-boundary.test.js` now scans for `fork` from `child_process`.

RED/GREEN: `runs as Node: ELECTRON_RUN_AS_NODE is 1 in the fork env, and absent under real Node`, `whatever forks sets ELECTRON_RUN_AS_NODE itself`.

## 8. Important: disk space and caches. Addressed.

`statfs` on the backup's parent against the files plus the store, before `mkdir`, refusing with both numbers; a disk that will not say goes on, and ENOSPC still refuses. `BROWSER_CACHE_DIRS` are left out at `browser-profiles/*` and `browser-profiles/*/*`. `Network` and `Local Storage` stay in there, since those are the logins; a case's own `Cache` folder stays in.

RED/GREEN: `a disk without room refuses with the numbers…`, `caches under a browser profile stay out…`.

## 9. Important: personal wording. Addressed; skills and workflows not moved.

`PERSONAL_EXCLUDED` beside `PERSONAL_NOTES`, with the plain line that skills and workflows do not move. The fleet's wording is unchanged.

Moving `skills/` and `workflows/` is not under 40 lines through the case-file path, so I did not do it. Why: `isSkippedCaseFile` refuses a nested `.git`, and a skill installed from a URL is a clone; keyed per skill, `.git/config` is dropped, which loses the remote `skill:update` needs. A skill installed from a folder is a junction, which the reader refuses. `writeCaseFile` lands under the cases root with `initRepo` in `finish`, so a new landing root, count check and verification are needed. Both stores load only at the node's start. Say the word if you want it as its own task.

RED/GREEN: `final review 9: stays-behind lines are the owner's under personal, the fleet's otherwise`.

## 10. Important: skill handlers. Addressed for the lines named.

`skill:checkUpdates` and `skill:install` use `execFile` with argument arrays. `git fetch` runs only with `{ fetch: true }`, from a new **Check for updates** button; the pane's load compares with what is known. `git` is by bare name per the Task 4 ruling (no cwd search without a shell, confirmed by the review's experiment); `clone` takes `--` before the URL. npm goes through `resolveProgram`, `node.exe npm-cli.js` on Windows. `skill:install` refuses a relative path when the event carries a device id (`RELATIVE_PATH`). `skill:update` (`:518`, `:529`) still uses `execSync`: it was not named, it is on a press, and it is in the residual list.

RED/GREEN: `no blocking call and no shell string` (3 tests), `the skills pane fetches on a press…`, and the `skill:checkUpdates` tests moved to `execFile`.

## 11. Important: `detectOldProfile`. Addressed.

Also found for `apiTokens`, the Anthropic sign-in, search and image keys, a vault key in `config.json`, or a setting the move carries that is not its default (`settingsWouldMove`). The one profile a first start makes does not count. `keysOrSettings` makes the first line say "and your keys and settings".

RED/GREEN: `found for keys, a vault or settings the move carries; not for what it does not`, `a profile found for its keys and settings says so`.

## 12. Tests the review named. Addressed.

Oversize chat through `migrationApply` (finding 1), a task whose program is gone (5), `courier-proxy` under Electron (7), CLI `import --from` with a private chat: `a private chat lands private…` in `tests/service-cli-import-personal.test.js`. That last one passes on 1ec106e6 too: it closes a coverage gap, the code was right.

## 13. Failed `status()` at launch. Addressed.

`refreshServiceStatus` draws `drawSetupAnswer`'s failure screen when no status has been read yet; past the first good read the chat stays. Check again recovers it.

RED/GREEN: `a status that fails before any good read draws the failure screen…`, `every way out of the first status shows the shell again`.

## 14. Minors. Addressed.

- **13:** `detectOldProfileApart` spawns with `{ ...process.env, ...env }`. The merge stays because the child needs the temp dir. Test: `detectOldProfileApart spawns with the environment it was given`.
- **14:** the CLI can find it: `uninstall --personal` with no `--data-dir` reads the data dir from the task's XML (`taskDataDir`). The NSIS comment says so. Test: `uninstall with no --data-dir stops the node where its task says it runs`.
- **15:** the phone step gives `node "<entry>"` when the task was read, else `node bin\king-louie-service.js` and says from which folder. Tests: `phone: …`.
- **16:** moved. Decrypting needs no chat, so it did not stand in the way. `readHistoryApart` sends one marked line per chat, parsed as it arrives. Tests: `the plan's read of every message runs in a child…`, `a child that dies is an attention row…`.

## Concerns

1. **A key that will not decrypt: ruled and done, see "After the report".**
2. `import --case` of a renamed folder whose id is on the node: the id is rewritten, so `verifyCase`, which counts chats by the old id, says `VERIFY_MISMATCH`. Nothing is lost and the message says what to do. Before this round it landed a duplicate id, which was worse.
3. Sizing messages stringifies each in the main process at plan time, so a very large profile still stalls briefly there. Far less than the read that moved out.
4. A second case's `case.yaml` differs from its HEAD until the sweep commits it.
5. No real install, migration or packaged run has been done. `courier-proxy` under the real app binary, the `.cmd` launcher's phone route and `statfs` on the owner's disk are all covered only by injected tests.

## After the report: coordinator's ruling

- **Undecryptable key.** `setAsideUnreadableSecrets` at the plan: every stored key is tried; one that fails comes out of the inventory, so no plan holds it and verification cannot miss it. Its name only goes in **Stays on this computer** and `leftBehind`. Secure storage unavailable, or more than half failing, refuses `MIGRATION_SOURCE` with nothing moved. Tests in `tests/migration-oversize.test.js` on a real bridge: one of three, two of three, one of two (exactly half goes on), storage unavailable. RED first: 3 of the 4 failed (exactly half already passed).
- **`skill:update`** uses `execFile` for `git pull` and npm. RED first: 6 failed in `skill:update`. GREEN: the named files plus the boundary test, 440 pass, 0 fail, 5 skipped.
- **Second ruling:** the over-half rule applies only with at least 3 keys, since 1 of 1 would have refused for good. With 1 or 2 stored, a bad key is named and the move goes on; secure storage unavailable still refuses at any count. Tests: 1 of 1 and 2 of 2, both RED first.
- **Re-review's last fixes**, RED first (10 failing, `red-last.log`):
  1. The source's message limit is `MAX_CHAT_PART_BYTES` less the chat's head and 4 KiB. Boundary test through source and importer with a real 63 MiB message, at the limit and one byte past.
  2. `MAX_CHAT_BYTES` 512 MiB on the source (`overCapBytes`, `needs-attention`, not landed, stays behind, mark goes on) and on the node's assembly. The desktop's in-memory read is in the CLAUDE.md residuals.
  3. An empty store is not found; `models.kingLouie` does not count as the owner's settings.
  4. An action that does not match `TASK_CALL` gives no `runs`.
  5. A line that does not parse gives a fixed sentence, not `JSON.parse`'s message, which can quote chat text.
  6. `MOVED_OUT_NOTE` adds "its earlier landing was incomplete".
  7. The room check keeps a 64 MB margin.
- Run after this: the importer, verify, controller and skill-handler test files, not the full suite, as ruled.

## Suites

Last run, after the re-review's fixes: `npm test` 12142 tests, 12046 pass, 0 fail, 0 cancelled, 95 skipped; `npm run test:e2e`, with `ELECTRON_RUN_AS_NODE` removed, 344 pass, 0 fail, 0 skipped (`stage2-last-npm.log`, `stage2-last-e2e.log`).

Earlier run, before the rulings under "After the report":

- `npm test`: 12127 tests, 12031 pass, 0 fail, 0 cancelled, 95 skipped, 1 todo. Exit 0.
- `npm run test:e2e`, with `ELECTRON_RUN_AS_NODE` removed: 344 tests, 344 pass, 0 fail, 0 skipped. Exit 0.

The e2e suite does not drive the move itself; its `setup-view` stops at the first screen. The move is end to end only in `tests/migration-verify.test.js` and `tests/migration-oversize.test.js`, on a real bridge and a real core.

Logs are in the session scratchpad: `stage2-final-npm.log`, `stage2-final-e2e.log`, `red-all.log`.
