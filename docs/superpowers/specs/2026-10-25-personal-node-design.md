# Personal node: King Louie's service on the owner's own machine

Date: 2026-10-25. Status: draft for the owner's review.

Related: fleet stage 5 (`2026-09-23-fleet-stage5-session-helper.md`), demo
takes D1 (`2026-10-24-agent-driven-demo-takes-design.md`), the install guide
(`docs/install-guide.md`), the driver's guide (`docs/driving-king-louie.md`).

## 1. Intent

The owner has two Windows machines, a laptop and a desktop. On each he is
the only user and the administrator. He wants a Claude Code session on the
same machine to drive King Louie through `king-louie-service mcp`, starting
with screen-recorded demo takes (D1), while he is away and approving from
his phone.

The service layout King Louie ships was built for a fleet node that someone
else administers: the service runs as LOCAL SERVICE in Session 0, and every
trust rule is a check that the service account cannot write what an
administrator wrote. On the owner's own machine that boundary separates the
owner from himself. It costs him, per machine:

- an elevated `install` that makes the data and config dirs Administrators-owned;
- `identity record`, elevated, so the service may trust its own identity;
- `session install --user`, elevated, so a second process (the session
  helper) can launch Chrome and ffmpeg on a screen the service cannot see,
  plus a shared secret, a per-user copy, a logon task and a handle-pinned ACL
  grant on the courier directories so `mcp` may post to the service;
- a wire protocol (session-v1) between two processes on one machine, with
  reconnect rules (`helper_lost`, the 30 s recording grace) that exist only
  because there are two processes.

A personal node is the same service, started in the owner's login session as
the owner by a logon task, with the trust rules that compare accounts
replaced by one fact: the process is the owner. Everything the owner asked
for in D1 stays as it is: the phone's one-tap take grant, unattended leases,
the take policy, the recording, the steps, the driver's `wait_ms`.

## 2. Goals

- One unelevated command makes a machine a personal node and starts it:
  data dir, config dir, `node.yaml` with the GUI and takes on, the browser
  entry, the logon task. A second run is idempotent.
- A take needs, beyond that: ffmpeg on `PATH`, a paired relay with an
  enrolled phone, and a driver running `king-louie-service mcp` as the same
  user. Nothing else to install, grant or record.
- The fleet layout (`hosting: service`, the default) is unchanged in
  behaviour, tests and documentation. Nothing in this design weakens a check
  that layout makes.
- Every surface that reports on the node says which hosting it runs under:
  `doctor`, `session status`, `status.json`, the start log.

## 3. Non-goals

- macOS and Linux personal nodes. The owner's machines are Windows (the
  author's assumption from the two machines he named). The hosting key is
  platform-neutral so they can follow; the install command refuses off
  Windows for now.
- The front door, the relay host and the property-sales driver.
- Attaching the Electron app to the personal node (§9, a question for the
  owner). The first version leaves the desktop app standalone.
- Narrowing the courier grant in the fleet layout. On a personal node there
  is no grant.
- A new approval path. Takes and unsafe calls still go to the phone.

## 4. Anti-goals

- A personal node must never be mistaken for a fleet node. A fleet node that
  is started by hand as the owning user (today's "hand-made layout") keeps
  today's behaviour: its approvers are untrusted and an identity record it
  can write is refused. Only `hosting: personal` in `node.yaml` switches the
  rules, and the switch is loud (§8).
- No check from the fleet layout is quietly skipped. Each one this design
  turns off is named in §6 with the fact that replaces it.

## 5. Constraints

- `src/` stays Electron-free; `tests/electron-boundary.test.js`.
- `node.yaml` rejects unknown keys: the new top-level key goes into
  `NODE_YAML_KEYS` (`src/service/node-config.js`) in the same change, and a
  `tests/node-config-strict.test.js` entry with it.
- `tests/service-profile-graph.test.js` keeps `src/session/` and `src/gui/`
  off the runbook, relay and front-door graphs. The in-process channel (§7)
  is loaded only on the `agent` profile with `hosting: personal`.
- The examples rule: a new example (`examples/personal/node.yaml`) holds
  invented values only and passes `tests/examples.test.js`.
- Tests never create a real logon task, never run a real elevated or
  unelevated install against the real `%LOCALAPPDATA%`, never start a real
  take. They inject `schtasks` and the backend, as the session-helper tests do.
- The mobile apps and the lease-v1, session-v1 and approval-v1 protocols do
  not change. No vector changes.

## 6. The hosting key and what it changes

`node.yaml` gains a top-level `hosting: service | personal`, default
`service`. `loadNodeConfig` parses it; `run.js` reads it before
`checkRecordedIdentity` and `startApprovals`, and only the `agent` profile
honours `personal` (a `runbook` or `frontdoor` profile with
`hosting: personal` refuses to start, `HOSTING_PROFILE_MISMATCH`).

Each rule below exists in the fleet layout because the service account and
the administrator differ. Under `hosting: personal` the fact "this process
runs as the account that owns the data dir and the config dir" replaces it.
That fact is checked once at start, on Windows by reading both owners with
the existing handle-based inspector and comparing them with the process's
own SID; a mismatch refuses the start (`PERSONAL_NOT_OWNER`, with the owner
and the account named). On POSIX the same with uids (unused until §3's
non-goal lifts).

| Fleet rule | Why it exists | Personal node |
|---|---|---|
| `identity record` must exist and match; the service must not be able to write it (`checkNodeIdentityRecord`, `serviceProbe`) | the service account could swap the identity in the data dir | not required. `checkRecordedIdentity` returns state `personal`; the GUI, `doctor` and `session status` accept that state as "on". `identity record` under a personal `node.yaml` says so and writes nothing. |
| approvers dir: the service must not be able to create a file in it; owner Administrators, SYSTEM or the config dir's owner, never LOCAL SERVICE | a service-owned set could enrol its own phone; approver files are checked for form only (`device_id` derives from `public_key`), so whoever can write the directory can add a phone | the write probe goes; the owner read stays. Today `serviceProbe: false` turns both off (`approver-store.js:66`, `:327`), so the store gets a separate `hosting: 'personal'` option that keeps `_checkOwners` and skips the probe. The owner rule is "Administrators, SYSTEM or the process's own account". The set is still re-read on change. What then keeps the model from writing an approver file is the tool policy row below, not the OS. |
| the OS keeps the model's tools out of the owner's files: LOCAL SERVICE cannot write `approvers\`, `node.yaml`, the desktop app's profile or the user's browser cookies | the model runs tools; a routine `Bash` call in a delegate turn (not during a take, where shells are refused) is held in only by `always_confirm`, whose default names ssh, scp, `git push`, Vault and `*deploy*` | the process is the owner, so the OS holds nothing back. A personal node's default policy therefore makes `Bash` and `PowerShell` `tool_requires_approval` (the phone, like an unsafe `LaunchApp`), and the file tools' deny list gains the config dir, `node.yaml`, `approvers\` and the desktop app's profile directory (as `SECRET_FILE_PREFIXES` already hides the data dir's own stores). The owner may lift the shell rule in `node.yaml` `policy`; the file deny he cannot. Known and said in the consent text: a shell that is approved once can do anything the owner can, and a deny list on file tools does not fence a shell. (C-8; the owner's question in §12.) |
| `session/helper-secret.json`, the per-user copy, the pipe, the hello/challenge handshake, `sameUser` | the helper is another account | none of it. The GUI subsystem is built with an in-process channel (§7). No helper file means "on" here, where in the fleet layout it means "off". |
| the courier ACL grant | only the service account could write `approvals\outbox` | none. The owner's `mcp` process owns the directories already. `FileCourier` and `CourierPump` are unchanged. |
| `WINDOWS_CONFIG_DIRS_SCRIPT`, `WINDOWS_DATA_DIR_SCRIPT` (Administrators owner, LOCAL SERVICE read-only) | keep the service out of its own config | not run. The data and config dirs are ordinary user-owned directories under the user's profile. |
| master key under DPAPI `LocalMachine` scope, protected by the data dir's DACL | LOCAL SERVICE has no user profile | unchanged. `LocalMachine` scope works for any account, the data dir under the user's profile is already private to the user, and `CurrentUser` scope would lose the key (and every token and the node identity with it) on a password reset. |
| `desktop pair` must run elevated; the bridge file must be owned by Administrators or SYSTEM | the desktop must not be pointed at a fake service by a user process | unchanged in this version (the desktop stays standalone, §9). |
| `pair`, `enroll-device`, `device apply|revoke` "as the administrator" | they write the approver set | run unelevated by the owner. On Windows these commands check nothing about elevation today beyond file access; the builder confirms each and removes any refusal that keys on it when `node.yaml` says `personal`. `pair` today only prints the `approvers.relay` line for an administrator to add, and refuses while the service runs (`pair.js:43-47`, `:145-146`); under `hosting: personal` it writes the line into `node.yaml` itself (the owner's file) and then starts the logon task if one is registered (§8), so the owner is never asked to edit a file by hand or to stop a task. |

What does not change: the lease manager and every rule in it (contact
tokens, unattended takes, `device_revoked`, two clocks, the listing nonce),
the take manager, the take policy, the courier protocol, the fleet tool
handler, the desktop bridge, the audit ledger's entries, the phones.

## 7. The GUI without a helper

Today `createGuiSubsystem` needs the helper file and builds a
`HelperChannel`; `GuiBroker` talks to it through a small duck-typed
surface: `on/off('ready' | 'closed' | 'event')`, `connected`, `info` and
`request(op, params, { jobId, leaseId, timeoutMs })`. On the helper's side
`createOpHandler(backend, { platform, recorder })`
(`src/session/connection.js`) is already a transport-free
`async (op, params)` over a backend, and `helper.js` adds the periodic
re-probe (60 s, `probe_changed`) and the lock poll (2 s, `locked` and
`unlocked`). (`displays_changed` is listed and consumed on the service side
but nothing in `src/session/` emits it today; that stays as it is.)

A personal node gets `InProcessChannel` (`src/gui/in-process-channel.js`):

- built from `selectBackend()` / `loadBackend()` (`src/session/backends`)
  and `createOpHandler`, with `recorder` from `findFfmpeg()`
  (`src/session/recorder.js`) at start, so `recorder.ffmpeg` reaches
  `HelperChannel`'s `recorderPath` equivalent and `gui.recorder.ffmpeg`
  still overrides it;
- `request` calls the handler directly and applies the same `timeoutMs`
  the broker passes (an op that hangs still ends with `op_timeout`);
- `connected` is true from the first successful probe; `info` is the probe
  report in the shape the helper sends (`capabilities`, `probes`,
  `displays`, `limits`, `locked`, `recorder`, plus `user`, `pid`,
  `platform`), so `session status` and `doctor` print the same rows;
- emits `ready` once, `event` for `locked`, `unlocked` and `probe_changed`
  by moving the two polls out of `helper.js` into a shared
  `startSessionWatch(backend, emit, { reprobeMs, lockPollMs })` in
  `src/session/` that both the helper and the in-process channel use;
- never emits `closed`: `helper_lost` cannot happen, and the broker's
  `helper_lost` timer (`broker.js:118-133`, which the take manager listens
  to) is never armed. The 30 s recording grace in the helper is moot (the
  recordings are this process's children; service shutdown stops them
  through `record_stop` as today).

`createGuiSubsystem` always builds a `HelperChannel` today; it gains a
`deps.channel` (a built channel, used when `hosting` is `personal`; tests may
pass a fake) and skips the helper-file read on that path.

The process must run in the interactive session for the Windows backend's
screenshot and input to work. The logon task (§8) guarantees it; a personal
node started from a non-interactive shell (a remote PowerShell, a Session 0
task) reports `capabilities` without `screenshot` and `input`, and the lease
manager refuses as it does for a helper without them. `session status`
names the session id and says whether it is interactive.

`status.json` is written where it is today, by `GuiBroker._writeStatus`
(`broker.js:186-198`) and by `unavailableSubsystem` for a GUI that is off,
with a `hosting` field added in both, so `session status` and `doctor` need
no second code path. `session probe` loads the real backend in-process
either way.

## 8. Install, start, status

`king-louie-service install --personal [--data-dir DIR] [--browser PATH]
[--yes] [--dry-run]`, unelevated (an elevated prompt is refused: the files
it made would be Administrators-owned and §6's owner check would then refuse
the start). It:

0. refuses when a fleet node is installed on the machine (the `KingLouie`
   scheduled task exists, or `%ProgramData%\KingLouie\config` holds an
   identity record or a helper file), naming `uninstall` and
   `session uninstall` as the way out. Nothing is migrated: a personal node
   is a new node with a new identity, and a phone that had the old node
   pinned is told so by the relay (`relay remove-node`, pair, enrol again).
   Neither of the owner's machines has a fleet node today (checked
   2026-10-25 on the laptop: no task, no config dir, one empty data dir
   from September), so this is a guard, not a migration;
1. prints what it will do: the account (name and SID), the data dir
   (default `%LOCALAPPDATA%\KingLouie\node\data`, config beside it as the
   platform rule puts it), the logon task's name, that the service will run
   as this account with the owner account as the trust boundary, and what
   that means (anything running as this user can drive the service as a
   local `mcp` client and can change the approver set; a shell the phone
   approves once can do anything the owner can); then asks `[y/N]` on a
   TTY; off a TTY it needs `--yes`;
2. creates the dirs, writes `node.yaml` with `hosting: personal`,
   `profile: agent`, `gui.enabled: true`, `gui.take.enabled: true`,
   `gui.browser` naming a `gui.apps` entry for Chrome (the path from
   `--browser`, else the registered `chrome.exe` App Path, else a refusal
   naming the flag), the §6 policy rows (`Bash`, `PowerShell` as
   `tool_requires_approval`), and `delegate.provider` / `delegate.model`
   from `--provider` / `--model` when given. An existing `node.yaml` is
   kept, with the lines it lacks printed, not rewritten;
3. checks `ffmpeg` on `PATH` and prints the `winget` line when absent
   (a warning, not a refusal: the take start refuses `recorder_missing`
   later with the same remedy);
4. registers the logon task `KingLouie Node` for this SID
   (`LogonTrigger`, `InteractiveToken`, `LeastPrivilege`, `run --data-dir`,
   `RestartOnFailure`, no battery limits) through the same `schtasks` path
   `autostart.js` uses. It starts the task only when `node.yaml` already
   names `approvers.relay` (a second run); on a first run it leaves the task
   registered and not started, and says that `pair` starts it;
5. prints what is left, in order: `token set <provider>` (the delegate's
   provider key, read from stdin, service stopped, as today),
   `pair wss://<relay>` (writes `approvers.relay`, starts the node),
   `enroll-device` (the phone; needs the node running), the command that
   opens the take's Chrome profile for a one-time login (§9), and the `mcp`
   command for the driver's MCP client config.

Every CLI command defaults its data dir to `%ProgramData%\KingLouie\data`
today (`paths.js:8`). On Windows the default becomes: that path when it
exists, else `%LOCALAPPDATA%\KingLouie\node\data` when it exists, else the
first (the fleet layout keeps precedence; a machine with both is a
mistake the §8 step 0 guard prevents). So `pair`, `enroll-device`,
`doctor`, `session status` and the driver's `mcp` need no `--data-dir` on a
personal node.

`uninstall --personal` removes the task and leaves the data dir, saying so.

A logon-task node is down from a reboot until the owner logs in (a Windows
Update restart while he is away): the phones show "Could not confirm" for
it and a take cannot start. That is a residual of this design, said in the
install's consent text; automatic logon is the owner's own choice and not
part of this.

Start: `run.js` logs one `info` line, `hosting: personal (runs as <user>;
the owner account is the trust boundary)`, and `doctor` has a row of the
same words, `PASS` when the owner check holds, with the task's state from
`schtasks /Query`. In the fleet layout `doctor`'s new row says `hosting:
service` and nothing else changes.

The audit ledger gets no new entry kind: a personal node's `lease.*`,
`take.*` and `tier.decision` entries are the fleet node's. The node's
`node.yaml` is where the hosting is recorded, and it is owner-owned by
design.

## 9. The desktop app (an owner's question)

The owner's King Louie today is the standalone Electron app, with its vault,
browser profiles and the live Lot 69 case in its own profile directory. A
personal node has its own data dir, so there are two King Louies on the
machine. Two ways to resolve that, for the owner to choose; this version
builds neither and keeps the desktop standalone:

- **Attach later.** Import the desktop's data into the node once (the
  desktop's own Import, which is how secrets move today), pair, attach. The
  bridge-file trust rule would have to accept a file the owner's account
  owns when the desktop finds `hosting: personal` beside it; that is a
  rule change in the desktop app and a second design.
- **Keep two.** The node is the agents' King Louie; the desktop is the
  owner's. Nothing shared.

Logins a demo needs: in the first version a take's Chrome profile persists
under `%LOCALAPPDATA%\KingLouie\browser-profiles\<name>`, so the owner logs
in once by hand in that profile (the install prints the command) and the
take runs with `credentials: false`. The node's vault stays empty until the
owner decides §9.

## 10. What is left to the builder

- The exact owner check on Windows (SID of the process from `whoami /user`
  or P/Invoke, compared with the handle-based owner read already in
  `src/service/identity-record.js`), and its POSIX twin.
- Which of `pair`, `enroll-device`, `device apply`, `device revoke`,
  `desktop pair` refuse an unelevated run on Windows today, and the smallest
  change that lets them run under `hosting: personal`.
- How the file tools' deny list (§6) names the desktop app's profile
  directory on Windows (`%APPDATA%\king-louie`), and how `node.yaml`
  `policy` is prevented from lifting it.
- Whether an unelevated `schtasks /Create` with `InteractiveToken` for the
  caller's own SID succeeds on Windows 11 Home (the author believes it
  does); if not, the install prints the elevated line to run instead and
  still refuses to be elevated itself.
- Where the `InProcessChannel` is built (in `run.js` beside the backend
  selection, or inside `createGuiSubsystem` from `hosting`), given that
  `deps.channel` is new (§7).
- Test files: `tests/node-config-strict.test.js` (the key),
  `tests/service-run-personal.test.js` (start refusals and the owner
  check with injected owners), `tests/gui-in-process-channel.test.js`
  (the broker's surface over a fake backend, timeouts, events),
  `tests/service-cli-install-personal.test.js` (dry run, refusals,
  idempotence, the task XML, injected `schtasks` and `which`), an
  `examples/personal/node.yaml`, and `tests/docs-driving.test.js` extended
  to the new §2 lines in `docs/driving-king-louie.md`.
- Documentation: a "Personal node" section in `docs/install-guide.md`, the
  `node.yaml` block in `docs/driving-king-louie.md` §2, and `CLAUDE.md`.

## 11. The author's calls (for the owner to check)

- C-1: the mode is a `node.yaml` key, `hosting`, not a profile and not a
  flag on `run`, so one file says how the node is hosted and the start
  cannot be given a different answer than the install wrote.
- C-2: the owner check refuses the start rather than warn: a personal node
  whose data dir someone else owns is the fleet layout's problem, and the
  fleet layout's rules then apply.
- C-3: the desktop stays standalone in this version (§9).
- C-4: logins by hand in the take's profile, no vault seeding (§9).
- C-5: `install --personal` refuses to run elevated.
- C-6: Windows only for the install command; the key is platform-neutral.
- C-7: the approver set is still re-read and still owner-checked (owner
  Administrators, SYSTEM or the process's account); only the write probe
  goes, since the account that could write it is the owner.
- C-8: on a personal node `Bash` and `PowerShell` go to the phone by
  default and the file tools cannot touch the config dir, `node.yaml`,
  `approvers\` or the desktop app's profile (§6). This is the one place the
  design adds a rule rather than removing one, because the OS boundary it
  replaces is the only thing that kept the model's shell out of the
  owner's files. The owner may prefer to accept the risk and keep shells
  routine; that is his call (§12).
- C-9: `pair` writes `approvers.relay` into `node.yaml` and starts the node
  under `hosting: personal`; `install --personal` does not start a node
  that has no relay yet.
- C-10: the master key stays under DPAPI `LocalMachine` scope.
- C-11: the CLI's default data dir falls back to the personal node's when
  no fleet data dir exists.
- C-12: `install --personal` refuses while a fleet node is installed and
  migrates nothing.

## 12. Questions for the owner

1. **Shells on a personal node (C-8).** Go to the phone by default, or stay
   routine as on a fleet node? The design says phone; it costs one tap per
   shell call in a delegate turn outside a take (takes refuse shells
   anyway).
2. **The relay.** The phone's one tap needs a relay the phone can reach,
   and none exists yet (the front door on sethserver is a later stage, and
   the relay is part of it). The smallest step is `king-louie-service relay
   run` on sethserver under the `relay` block of its `service.json`, with a
   certificate, before the first take. Without it no take can start on
   either layout. Is that the step to take now, before this design is built?
3. **One King Louie or two (§9).** The desktop app stays standalone in this
   version; the node is a second King Louie with its own data, vault and
   cases. Attaching the desktop later is a second design.
4. **Logins (C-4).** One-time login by hand in the take's Chrome profile,
   no credentials in the node's vault for the first demos.
