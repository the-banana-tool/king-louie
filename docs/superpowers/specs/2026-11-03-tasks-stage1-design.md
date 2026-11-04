# Tasks, stage 1: one task from claude.ai to one node, under one grant

Status: built on `feat/tasks-stage1` (2026-11-03); this document says what was
built, including the rulings the build made (the ledger's `Ruling:` lines). Terms are `CONTEXT.md`'s
(Node, Client, Task, Task grant, Placement, Front door). Decisions behind this
document: ADR 0003 (the window always attaches to a node) and ADR 0004 (one
task grant, not per-call approvals); the grilling session of 2026-11-03,
Q1–Q32, whose rulings are quoted as `Q<n>` below.

## 1. Intent

King Louie is a fleet of nodes that do what the owner could do at their own
keyboard, driven by any client, with the paired phone as the gate. Today a
front-door client can start free-text work on a named node (`delegate`), but
the work is in memory only, every browser click costs the owner a press, the
caller must name a node even when there is one, and nothing tells the caller
or the phone when it is done.

Stage 1 makes this work end to end for one owner, one phone and one node:

> From claude.ai: "Have King Louie find a dentist for my child within 45
> minutes of Lakeside with good reviews for children."

The owner's phone shows one card (sites, what the task may do, duration,
spend); one press; later the phone says the task ended, and claude.ai shows a
table of two or three dentists with name, phone number, drive time and a
sentence on why each was chosen, each reason naming where it came from.

The node is `my-laptop`, the owner's personal node (Windows, `hosting:
personal`), linked to the front door on `mcp.kl.example.com:8443`, phone
enrolled. Nothing in this stage is specific to that machine.

## 2. Goals, non-goals, anti-goals

Goals

- `run_task` on the front door and on `king-louie-service mcp` starts a task
  without naming a node when one node qualifies (Q3).
- A task is a chat on the node with a durable task record beside it; a node
  restart loses no task and no answer (Q11, Q13).
- One task grant covers the task's scope; inside it the task acts without a
  press; outside it, one more approval per action, never a refusal by King
  Louie itself (ADR 0004, the owner's rule of 2026-11-03: "there's no never
  list; anything questionable should be approved over the phone app").
- A look-only task (nothing in its scope acts) needs no press (Q26).
- A client can wait on a task and resume waiting; the phone gets a
  content-free push when a task ends (Q11).
- Any phone of the owner can stop a running task (as any lease, R-F5-18).
- The task is visible to every client of the owner with read access to the
  node (Q25; drops ruling T11 for tasks).

Non-goals (later stages; see §11)

- Placement among several qualifying nodes beyond listing them (the matching
  rules are stage "fleet placement").
- Tasks from the desktop window or on-screen approval of a task: the window
  attaches in stage 2; in stage 1 every task is remote and every press is on
  the phone (my call; Q10's on-screen approver arrives with the window).
- `RunTask` in owner chats, bridge chats as clients (Q28, Q31), moving a task
  between nodes (ruled out for now), headless browser on fleet nodes (Q15),
  personal nodes on macOS and Linux (Q6).

Anti-goals: what would make this a failure even if it works

- A press whose card the model wrote. The card is host-built from a validated
  proposal, as the envelope card is.
- A task that keeps acting after Stop, after its duration, or after the node
  decides it ended.
- Any blanket allow-rule that lifts the gate for good. The grant is scoped and
  dies with the task.
- A task record, a `get_task` answer or an audit entry that holds a secret
  typed into a page (the vault's rules hold; browser `login` stays a vault
  action).

## 3. Constraints

- Everything under `src/` but `src/ipc/` stays Electron-free
  (`tests/electron-boundary.test.js`). New model calls are routed. The
  proposal's call goes through `oneShot`, which is outside the walk of
  `tests/egress-inventory.test.js`, so it is not in
  `tests/fixtures/egress-inventory.json`: it is routed with the chat's egress
  and a test pins that (§4.5).
- The task's agent loop is the node's own (`Q2`): its profile's models, its
  tools, its approvals, its provider key. claude.ai never drives a tool.
- Phone changes land after node changes ("upgrade nodes before phones", as
  for takes): an older phone shows a task lease as "Could not confirm" and
  never approves it.
- Both phones change together (iOS `KLProtocol`, Android `protocol`), with
  `tests/vectors/lease-v1/generate.js` and the source-reading tests
  (`tests/mobile-lease-apps.test.js`, `tests/mobile-android-slim.test.js`).
- The front door never parses task text (Q17, Q27).
- Per-grant rate limits and scopes as the front door has them; no new OAuth
  scope (ADR 0002: scopes are hard to take back). My call: `run_task`,
  `send_to_task` and `cancel_task` need `fleet:delegate` **and**
  `fleet:unsafe` on the node; `fleet:read` covers `get_task` and
  `list_tasks`. Owner decision M19 stands: a front-door client's unsafe
  calls reach the phone only under `fleet:unsafe`, and a task is made of
  such calls, so a grant without it is refused `insufficient_scope` at `run_task`, up
  front, never half-run. The front-door origin passes through to the turn,
  and `shouldRefuseUnsafe` already lets it reach the phone when it covers
  `fleet:unsafe`.

## 4. The pieces

```
claude.ai ──MCP──▶ front door ──link──▶ node (my-laptop)
                     │ placement           │ TaskManager
                     │ (one node: none)    │  ├ chat (history store)
                     │                     │  ├ record  <dataDir>/tasks/<id>.json
                     │                     │  ├ grant = lease kind "task"
                     │                     │  └ agent loop + task policy
                     ▼                     ▼
                   phone ◀── kl.lease.request (card) / push task_ended
```

### 4.1 Client tools

Five tools, defined once in `src/fleet/tool-definitions.js` beside the fleet
tools, served by the front door and by `king-louie-service mcp` (the courier
client's name sets derive from that list), forwarded to the node as link
methods `fleet.<name>` beside the other fixed fleet methods.

- `run_task { task, node?, wait_ms? }` → `{ task_id, node, state, chat_id }`,
  or `{ needs_placement: true, nodes: [{ name, capabilities, online }] }`,
  or an error. `task` is free text, 1 to 8,000 characters. `node` is a node
  name; when given, that node or an error (`unknown_machine`,
  `machine_offline`, `capability_unavailable` for a node that is not an
  agent), as the rest of the fleet words them.
- `get_task { task_id, wait_ms? }` → the record's public view (§4.4) with
  `answer` wrapped as untrusted output. `wait_ms` (0 to 25,000) holds the
  reply until the state changes from the one the caller last saw (the caller
  passes `seen_seq`; my call) or the time is up. Resuming is calling again.
- `send_to_task { task_id, message, wait_ms? }`: a client message into the
  task's chat; starts a turn when none runs (the answer to STUCK, a
  follow-up, or a continuation after `interrupted`). Refused while a turn
  runs (`task_busy`).
- `cancel_task { task_id }`: ends the task `cancelled` (its turn aborted, its
  grant released).
- `list_tasks { node?, state? }`: the records of every task the caller may
  see, newest first, at most 50.

A forward whose answer never came may have started the work, so the router
never sends `run_task`, `send_to_task` or `cancel_task` twice: a timeout or a
link failure after sending answers `task_unconfirmed`, and says to look with
`list_tasks` or `get_task`.

`describe_machine` and `list_machines` add `capabilities` (§4.2).

### 4.2 Placement, stage 1

A node reports its capabilities in `fleet.hello` (the `capabilities` field
exists; it carries the node's declared list today). Stage 1 adds detected
ones, strings: `interactive` (the process has a desktop session: personal
hosting, or a working session helper), `browser:logins` (a browser profile
with saved logins exists), `browser:headless` (Chromium is runnable with no
screen), `shell`, `local-models` (a usable local server), `os:<windows|macos|
linux>`. The router stores them from the hello as it does now (`cleanHello`
caps them).

Placement in `FleetRouter` for `run_task`:

1. `node` named → that node.
2. Else the set of online nodes with the agent profile. Exactly one → it.
3. Else `needs_placement` with the set and each node's capabilities. Zero
   nodes is `needs_placement` with an empty list (the client says so).

No capability matching in stage 1: a task declares no needs yet, so with
several nodes the client is always asked, which is Q3's fallback and what the
owner's four-node example expects. The matching rules come with the next
stage and change step 2 only.

### 4.3 The task on the node

`TaskManager` (`src/tasks/manager.js`) owns tasks on a node, as
`TakeManager` owns takes. On `tasks.run`:

1. Create a chat in the history store (the chat fields `taskId` and `client`;
   **not** `source`, which marks an imported chat and would make it
   unattachable and local-only), title from the first 60 characters of the
   text, so the window (stage 2) lists it and recall applies (scope `chat`,
   never wider: a task is a remote client's run). Every user-side row the
   client wrote (the task text, each `send_to_task` message) carries
   `meta.author: 'client'`. The chat **is attachable** to a case (owner
   decision 2026-11-03): `assertChatAttachable` admits it, and the case
   send path builds `caseContext.ownerMessages` from user rows that do not
   carry `author: 'client'`, so a client's words never become `user`
   provenance or satisfy an `ownerQuote`. Q29 applies as to any chat: a
   task chat whose rows show management-tool results about other cases is
   refused `CHAT_SAW_OTHER_CASES`.
2. Write the record (§4.4) in state `requested`.
3. Ask the utility role for a scope proposal (§4.5). If the proposal has an
   acting class, request the grant (state `awaiting_grant`) and go on; the
   card is on its way before any work, so the owner's press is off the
   critical path.
4. Start the first turn: the task text as the user-side message of the chat,
   the caller's origin passed through (`approvalOrigin(origin,
   'chat:<chat_id>')` for the phone), on the node's agent executor with:
   - the tool set of an owner chat on this node minus the fleet tools, the
     task tools themselves (Q12) and what outlives a turn and so its spend cap
     and its ending (`BackgroundTask`, `TaskStatus`, `Cron`, `RemoteDispatch`):
     browser, shell, files, `ListApps` and
     `Screenshot` (the eight acting GUI tools are left out in stage 1: they
     need a lease with `apps`, and the task holds the node's one lease; my
     call), `SpawnAgent` as in a chat, and the case management tools
     (owner decision 2026-11-03: the read tools work for any client whose
     task runs here, so `fleet:delegate` + `fleet:unsafe` on a node implies
     `cases:read` there, said in the scope's description; the spoken tools
     refuse `not_owner` as on any run without owner text, and a private
     case shows id, title, status and `private: true` only, as to a
     non-private chat);
   - `cwd` and the allowed roots: a per-task working directory
     `<dataDir>/tasks/<task_id>/work` (my call). The `files-write` class
     covers writes under it; a write anywhere else, and every shell
     command without `shell`, asks on the phone;
   - `taskPolicy` (§4.6) in the executor options, as `takePolicy` is;
   - `denyAutoApproval` on (a task turn is remote, so neither the
     always-approve list, an agent's `autoApproveTools` nor an `allow` rule
     lifts a call the policy passed through); `ownerTurnText` empty (the
     client is not the owner: no `ownerQuote` ever matches, no spoken case
     tool runs; the management tools refuse `not_owner` as they do on a
     gateway run);
   - the task prompt section (§4.7).
5. Each turn end: when the last assistant message ends with a `STUCK:`
   paragraph, state `waiting` (the client is expected); otherwise state
   `done`, `answer` = that message's text, grant released, push `task_ended`.
   A turn that fails is `failed` with the error code. A `send_to_task` on a
   `waiting` or `interrupted` task starts the next turn on the same chat;
   on a `done` task it is a follow-up turn (state back to `running`, a new
   answer when it ends). The lease ended with the task, so no grant covers
   a follow-up: each acting call asks on the phone, and past the cap or the
   deadline the send is refused.

One running task per node in stage 1 (my call): a second `tasks.run` is
`task_busy` naming nothing but the state. A `waiting` task with no change to
its record for 24 hours is ended `cancelled`, reason `abandoned`, by the next
`run_task`'s look (lease closed, one push), unless a live grant or a card is
out. The node's one lease model and the
one-browser-profile rule make this the honest bound; several tasks at once
is a later stage.

**The owner can take the chat.** A client's send, a card pressed and the next
`tasks.run` read the chat as it is now. A chat since attached to a case ends the
task with the reason `became_case`, one since marked private with the reason
`private`, and one deleted with the reason `chat_deleted`; a send is refused
`task_ended` and no turn runs. An open task ends `cancelled` (`failed` for a
deleted chat), its lease with it; a `done` task stays `done` and only says why
it takes no more. A read that fails ends nothing: a send is refused `task_busy`
and the record stays as it was; only for what a client reads does a mark that
cannot be read count as private. So the case's
lock, guard and Q27 are never bypassed, and a local answer never goes back to
a remote client.

Shutdown aborts the turn and marks the record `interrupted` (the chat and the
record survive; the grant is released), and at the next start every record
found in `requested`, `awaiting_grant` or `running` is marked `interrupted`
too, as `markLiveEnded` does for takes. `send_to_task` continues it.

### 4.4 The record

`<dataDir>/tasks/<task_id>.json`, one writer (`TaskStore`, after
`TakeStore`): `task_id`, `chat_id`, `node`, `client` (`{ kind, client_id,
client_name, grant_id }` or `{ kind: 'stdio' }`), `text`, `state`
(`requested`, `awaiting_grant`, `running`, `waiting`, `done`, `failed`,
`cancelled`, `interrupted`), `seq` (bumped on every write), `proposal`,
`grant` (`{ lease_id, granted_at, by_device, expires_at }` or null),
`placement` (`{ by: 'named' | 'only-node' }`), `spend` (`{ usd, calls,
cap_usd }`), `answer` (`{ text, at, seq }` or null), `ended` (`{ reason, at
}`), `created_at`, `updated_at`. The public view (`get_task`) is the record
with `text` and `answer.text` wrapped as untrusted output, `client` reduced to
kind and name, and `grant.live` read from the lease, never stored. The record
also has `reason` (why it waits) and `deadline_at`.

**A private chat's view** (`privateView`): `get_task` and `list_tasks` give only
the id, chat id, node, state, seq, reason, ended and times, and `private: true`;
`text`, `answer`, `proposal`, `grant` and `spend` are null and `client` is left
out, as for a private case on the MCP surfaces. A mark that cannot be read
counts as private.

Visibility: every grant with `fleet:read` on the node reads any task there
(Q25). `JobCache.visibleTo` is not consulted for tasks; the front door
forwards `get_task`/`list_tasks` on scope alone.

### 4.5 The proposal

One utility-role call (routed with the chat's egress, `role: 'utility'`, charged
to the task), prompt `src/tasks/prompts/task-scope-v1.md`, strict JSON answer. The
call is not in the egress inventory: `oneShot` is outside that test's walk, so
`tests/fleet-task-tools.test.js` pins that it is routed under the policy.

```
{ "sites": ["maps.google.com", "*.yelp.com", "www.healthgrades.com"],
  "allows": ["browser-act"],
  "minutes": 20,
  "usd": 2 }
```

Validation (`validateProposal`): `sites` at most 16, each an exact host or
`*.domain` (the take's rule), no paths; `allows` a subset of the fixed
classes `browser-act` (click, type, fill, select, press, drag), `logins`
(the credential browser actions: `login` and signup from the vault), `shell`,
`files-write`; `evaluate`, `evaluate_in_frame`, `set_input_files` and
`fill_payment` are in no class and always ask; `minutes` 1 to 240; `usd` at least 2 and at
most 50. (`desktop-input` is not a stage 1 class; see §4.3.) A
malformed answer is retried once, then the task runs with no grant (every
acting call asks on the phone: the owner is never shut out by a bad
proposal; my call). An empty `allows` is a look-only task: no card, the
record says `grant: null, proposal.lookOnly: true`.

**With no press, nothing a model proposed binds the owner's money or time.** A
look-only, no-proposal or not-yet-pressed task runs under a $2 cap and at most 30
minutes, whatever the proposal says. Only a press moves a cap or a deadline: it
sets the cap to the card's `usd` and the deadline to the lease's expiry. So a
slow press can cut a reading turn at 30 minutes, and the client sends to go on.

### 4.6 The grant and the task policy

The grant is a lease of kind `task` (`LEASE_KINDS` gains it; `LEASE_KEYS`
for it: `name` (the text, one plain line, at most 60 code points, `Task` when
nothing is left), `sites`, `allows`, `max_minutes`, `usd`, `unattended: true`,
with no `apps`, and the lease's `job_id` is `chat:<chat_id>`). It
rides the whole lease machinery unchanged: `kl.lease.request` through
`LeaseManager.request`, the phone's grant/deny, revoke from any enrolled
phone, `kl.lease.status` with `kind`, `name`, `unattended`, the listing, the
`lease.*` audit entries (`lease.requested` and `lease.granted` add `name`,
`sites`, `allows`, `usd`; the ledger is mirrored to the relay, so the first 60
code points of each task's text sit in the relay's mirror), the
`session_ended` push to the granting device. The relay passes `kl.lease.*`
already. A task lease is unattended as a take is (no contact timer; R-D1-7),
and it ends on expiry (the turn stops; the task is `waiting`, reason
`duration`), revoke or `device_revoked` (the task ends `cancelled`, reason
`stopped`), the task ending, service shutdown. A send past the duration sends a
card, read-only for a look-only task, and only its press moves the deadline;
with no grants the task ends `failed`, reason `duration`. The card is host-built, in this order: `Task:
<name>`, `Sites: …`, `May: click and type in your signed-in browser | sign
in with saved logins | run shell commands | write files`, `For: N minutes`,
`Spend up to $N`, `Node: <name>`; the phone shows the lines as it shows a
take's.

**The browser is the owner's** (owner decision 2026-11-03): every task runs
in the persistent `king-louie` profile, with the owner's logged-in
sessions, so on a granted site the task acts as the owner. The card's
`browser-act` line says "your signed-in browser" for that reason, and the
sites list is the bound. `logins` gates only the vault-backed credential
actions. The `browser:logins` capability is therefore always present on a
node whose `king-louie` profile exists.

**An unanswered card** (owner decision 2026-11-03): the lease request
expires after 5 minutes (`REQUEST_TTL_MS`). The task keeps doing look-only
work; an acting call waits. On each expiry the node sends a fresh card, 12
cards in all (about an hour); then the task goes `waiting` with the reason
`grant_pending` and the client is told. A press on any live card resumes
the task; `send_to_task` on a task waiting for its grant sends one more
card. A task `interrupted` by a restart has no lease (leases are in
memory): its next `send_to_task` re-proposes and re-cards before acting
resumes (my call).

**A node without the GUI subsystem** (no `LeaseManager`: `gui` not
enabled, no helper, a fleet node without its identity record) still runs
tasks (my call): grant-less, every acting call its own tool approval on the
phone, `describe_machine` saying `tasks: per-call approvals`. The
`PushQueue` is built for tasks whether or not the GUI is, so `task_ended`
still goes out. Moving the lease machinery out of `src/gui/` is not stage 1
work.

`createTaskPolicy` (`src/tasks/policy.js`, after `createTakePolicy`)
is consulted where the take policy is, after the node's deny patterns, the
`denied` tier, the denied directories and the roots check, so those still
win. Its answers:

- A browser acting action on a page whose host is in `sites`, with
  `browser-act` granted: allow (lifts the browser-acting prompt and an
  `always_confirm` match). `navigate`/`open_tab` check the target host.
- A credential action with `logins` granted, on a granted site: allow.
- `Bash`/`PowerShell` with `shell`; file writes under the task's work
  directory with `files-write`: allow.
- Look-only actions and read tools: allow, grant or not (they never asked).
- Anything else, and everything while the grant is `awaiting_grant` or
  absent: **ask**, through the ordinary unsafe-call path to the phone (a
  signed tool approval over the exact action). Nothing is refused by the
  policy (ADR 0004 as amended). An acting call the card would cover waits for
  it, then is re-decided; a denied card ends the task `cancelled`, reason
  `grant_denied`. A call a look-only allow lifts keeps an `always_confirm`
  match or an `ask` rule; a grant's lifts `always_confirm` too, never an `ask`
  rule or another unsafe tier reason. A tool's dangerous-pattern match goes to
  the phone, never lifted by a grant.
- After the task ends, every call is `task_ended`.

Spend: the task's chat has its own `UsageTracker` view; every routed call
is charged to it; at `usd` the turn is cut (as a Stop) and the task is
`waiting` with the reason `spend_cap`, the lease is ended (`spend_cap`), and
a **fresh** `kl.lease.request` of kind `task` with the higher `usd` (and a
fresh duration) goes to the phone; any phone may grant it; deny ends the
task `spend_cap`. A resume does not fit (unattended leases never suspend,
and the phones cannot show a changed field), so this is a new lease, with
the `session_ended` push that brings. My call. A look-only task's raise has
empty `allows`, and the phones show `May: read only`. With no grants a task at
its cap ends `failed`, reason `spend_cap`. So does a raise refused
`approval_unavailable` or `capability_unavailable`; one refused for what can
change (`lease_busy`: a take holds the node's lease) leaves the task `waiting`,
and the next send asks again. A press clears `spend_cap`, `duration` and
`grant_pending` from `reason`. A `done` task at its cap refuses a
send plainly. A raise card reads like a first card: no signed field holds the
earlier cap.

### 4.7 What the model is told

A task turn's prompt begins with a `TASK_GUIDANCE` section
(`src/context/system-sections.js`): the text came from a client, not the
owner at a keyboard; the answer will be read elsewhere, so end with it whole
(for a list of findings, a table with the facts that matter and, per row,
where each fact came from); name what could not be verified; when the task
cannot go on without the client, end the turn with one paragraph starting
`STUCK:` saying what was seen, tried and needed; never ask for approval in
text (the phone handles that). No "never" list is given to the model.

### 4.8 Finishing and telling

- `task_ended` joins the push kinds (`SESSION_KINDS` in
  `src/frontdoor/push/text.js`, `TITLES`, the relay's `push.notify` check,
  `PushQueue`), content-free, fcm only like the other new kinds, sent to
  every device of the owner when a task reaches `done`, `failed`,
  `cancelled` or `interrupted` by shutdown. A look-only task pushes too (it
  had no lease, so no `session_ended`).
- `get_task` with `wait_ms`: the node holds the method until `seq` changes
  or the time is up, for the front door and the courier alike (SSE progress
  stays `get_job` only in stage 1).
- Audit: `task.requested { task_id, client, node }`, `task.ended { task_id,
  reason, usd }`, `task.refused { tool, code, origin }` for a call past the task's
  end (`task_ended`) or a policy answer that went to the phone and was denied
  (`phone_denied`). The lease entries carry the rest, with `name`. The ledger
  is mirrored to the relay, so the first 60 code points of each task's text sit
  in the relay's mirror (§4.6). `task.*` entries hold no text and no URL.

### 4.9 The phones

Both apps: accept lease kind `task` (`LEASE_KINDS`, `LEASE_KEYS`, the
status check), show the request card with the host-built lines of §4.6 and
Allow/Deny, list a running task in the Approvals list as a row "Task on
<node>: <name>" with Stop (the lease revoke), and show the `task_ended` push
with the title "A task ended". No live view: a task has no frames.

## 5. Security notes

- The card is built by the host from a validated proposal; the model's
  words appear only in `name`, one plain line through `shown`, and in
  `sites`, each checked against the host grammar.
- The grant hash covers the kind and every `LEASE_KEYS` field, so a grant
  signed over one scope cannot be replayed for another.
- The policy is consulted after every node refusal; a task's allow never
  lifts a `denied` tier, a deny rule or a denied directory.
- The client is never the owner: no `ownerQuote`, no spoken case tool, no
  `user`-provenance fact, in the task and in any case the task chat is
  later attached to (`author: 'client'` rows are left out of
  `ownerMessages`). `create_case` from a task is refused `not_owner`; a
  later stage may give tasks a client-provenance path.
- The task acts in the owner's signed-in browser on the granted sites; the
  card says so on every grant that includes `browser-act`.
- `fleet:delegate` with `fleet:unsafe` on a node lets a client read that
  node's non-private cases through a task; the scope description says so,
  and the audit records every management-tool call as it does in a chat.
- Everything the task reads from pages is untrusted output as today; the
  answer is untrusted output to the client.
- Secrets: the record stores the text, the proposal, the states and the
  answer; never tool results. The chat holds tool results as any chat does,
  under the history store's rules.

## 6. What claude.ai does

The front door's tool descriptions tell the client: call `run_task` with
the owner's words; on `needs_placement`, ask the owner which node in your
own words and call again with `node`; then `get_task` with `wait_ms`
repeatedly until `done`, `failed`, `cancelled`, `waiting` or `interrupted`.
On `waiting`, `stuck`: show the `STUCK:` paragraph and pass the owner's reply
with `send_to_task`; `spend_cap`: a card is on the owner's phone, so it tells
them and calls `send_to_task` after the press; `duration` or `grant_pending`: no
card is out yet, so it calls `send_to_task` now, which sends one (it may be
refused, saying so), tells the owner and sends again after the press (a press
starts no turn, and `reason` goes empty). On `interrupted`, the node restarted,
and `send_to_task` continues it. `interrupted`, `stuck`, `duration` and
`grant_pending` change only on a send, so it does not keep calling `get_task`
there. Show `answer` as data. A `get_task` after the chat ended still works: the record
is on disk.

## 7. Testing

- Unit: `TaskStore` (record, unfinished states, restart marking),
  `validateProposal` (host grammar, classes, bounds), `createTaskPolicy`
  (every class, awaiting, ended, the order against deny rules — after
  `tests/take-policy.test.js` and `tests/tool-executor-take-policy.test.js`),
  placement in `FleetRouter` (named, one node, several, none), the tool
  definitions in both courier name sets, `wait_ms` on `get_task`.
- Lease kind `task`: `tests/gui-leases.test.js` style with the fake phone;
  vectors `node tests/vectors/lease-v1/generate.js --check` regenerated;
  the mobile source-reading tests pin the kind in both cores.
- End to end in-process (`tests/tasks-e2e.test.js`): the real router and
  `NodeFleetService` over the fake hub (`tests/helpers/fake-node.js`), a real
  core with a scripted provider, the real task policy, leases, approver and push
  queue, a stand-in for the browser tool, and the fake phone: run → card → grant → turn → `done` → `get_task` answer →
  push queued; the look-only path with no card; `cancel_task`; restart →
  `interrupted` → `send_to_task` continues.
- The proposal call is routed with the chat's egress, pinned by a test. It is
  not in the egress inventory, whose walk does not reach `oneShot`.
- Not automated: a real task on the owner's node from claude.ai (the owner runs
  it once; the guide gets a "Your first task" section).

## 8. Documentation

`docs/driving-king-louie.md` gains a section for MCP clients (run, wait,
placement, STUCK); the install guide's personal-node section gains "Your
first task"; `CLAUDE.md` gains a Tasks section; `docs/protocol/lease-v1.md`
gains the `task` kind ("Revised 2026-11-03"); `mobile/PRIVACY.md` lists the
task card's clear fields (text, sites, classes, duration, spend, node).

## 9. Left to the builder

File and module names above are suggestions except where they name an
existing seam. The builder decides: the exact `TASK_GUIDANCE` wording; the
proposal prompt; how the node holds `get_task` (a per-record waiter list);
how the task chat's `UsageTracker` view is scoped; the `fleet.hello`
detection code for each capability (and its tests, which must not depend on
the dev box's browsers); how `send_to_task` on a `done` task acts (each acting
call asks; its lease ended with the task); the push title text.

## 10. Calls I made (for the owner to check while reading)

1. Stage 1 approves everything on the phone; stdio `mcp` (Claude Code on the
   same machine) counts as remote. On-screen approval comes with the window.
2. The grant is a lease kind, not a new approval kind: it buys Stop, the
   banner row, the listing and the audit entries for free, at the price of
   one running task per node in stage 1.
3. No new OAuth scope: `fleet:delegate` runs, `fleet:read` reads.
4. A bad proposal (twice malformed) means a grant-less task that asks per
   call, not a failed task.
5. The spend cap is enforced by cutting the turn and asking for a raise on a
   second card; deny ends the task.
6. The proposal and the card go out at task start, before any work, so the
   press is not on the critical path; look-only work runs meanwhile.
7. Tasks are always visible to any client with `fleet:read` on the node
   (T11 kept for delegate and runbook jobs, dropped for tasks).
8. `delegate` stays as it is; `run_task` is beside it. Retiring `delegate`
   in favour of tasks is a later decision.
9. `run_task` needs `fleet:unsafe` as well as `fleet:delegate` (M19 kept);
   a grant without it is refused at `run_task`.
10. A node without the GUI subsystem runs tasks grant-less with per-call
    approvals rather than refusing them; the lease machinery stays in
    `src/gui/`.
11. The acting GUI tools are out of a task's tool set in stage 1
    (`desktop-input` is not a class); `ListApps` and `Screenshot` stay.
12. A task's working directory is `<dataDir>/tasks/<task_id>/work`, and
    `files-write` covers writes under it only.
13. The spend-cap raise is a fresh lease, not a resume.
14. A task interrupted by a restart is re-carded before it acts again.

Owner decisions taken on the builder check (2026-11-03): tasks run in the
owner's signed-in browser profile; a task chat is attachable to a case with
the client's rows marked and never owner-verified; task turns get the case
management tools; an unanswered card is re-sent for an hour, the task
reading meanwhile.

## 11. Later stages (not here)

Fleet placement (capability matching, task needs, headless browser on fleet
nodes); the window always attaches and migrates the desktop (ADR 0003);
remote attach and the node switcher; on-screen approval for window tasks;
`RunTask` in owner and bridge chats; several tasks per node; moving a task
between nodes; personal nodes on macOS and Linux; retiring the peer mesh.
