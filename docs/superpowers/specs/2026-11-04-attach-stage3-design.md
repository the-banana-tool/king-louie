# Stage 3: the window reaches any node, through tabs

Status: draft for the owner's review. Follows
`2026-11-03-attach-stage2-design.md` (not merged when this was written), ADR
0003 and ADR 0004. Words are `CONTEXT.md`'s. "Owner" marks what the owner
decided; "my call" marks what the author decided and the owner can overrule.

## 1. Why

The owner is on the laptop, away from home, and wants the desktop's King
Louie: its chats, its cases, its signed-in browser. Today the window can only
reach a node on its own machine, over loopback. Stage 3 makes a node on
another machine reachable through the front door, and shows several nodes at
once. It is the "GUI is a client of any node" half of the fleet: the window
becomes one more client, gated by the phone like the others.

Success: from the laptop, away from home, the owner opens a tab onto the
desktop, reads and continues a chat started at home, watches a turn run, signs
what needs signing on the phone, and closes the laptop with the turn still
running.

## 2. What the owner decided

1. The first case is the laptop driving the desktop from away.
2. **The front door cannot read the traffic.** The window and the node encrypt
   to each other; the front door passes sealed frames. A break-in on the
   front-door server exposes no chat text.
3. **The laptop may be window only.** A node there stays optional.
4. **Several nodes are open at once, as tabs in one window**, one shown at a
   time.
5. From the grilling (2026-11-03): anything questionable goes to the phone,
   and there is no never list (ADR 0004). On-screen approval is for the local
   window only; anything remote is the phone. No phone enrolled means a remote
   client does nothing unsafe.
6. **What goes to the phones is encrypted too, in this stage.** The front door
   reads neither the window's traffic nor approvals (§14).
7. **A remote chat gets one grant, in this stage**, not a press per call (§15).
8. The laptop runs Windows, so the first build is Windows only.

### Three parts, each its own plan and PR (my call)

Decisions 6 and 7 make this too large for one branch. In order:

- **Part A, sealed phones (§14).** First, so that every new approval is born
  sealed and nothing is built twice. Useful alone: it closes a gap the relay has
  today.
- **Part B, the remote window (§4 to §10).** The owner's first case works here,
  with a press per acting call until part C.
- **Part C, the chat grant (§15).**

## 3. Goals, non-goals, anti-goals

Goals: the success picture above; several tabs; a laptop lost or stolen can be
cut off from the phone; a network drop costs a reconnect and not a turn; a
break-in on the front-door server exposes neither chats nor approvals.

Non-goals (not in this stage):
- Moving a running task or chat between nodes.
- A route that avoids the front door (LAN, direct peer). The front door is the
  one path.
- Waking a sleeping or logged-out machine. A rebooted personal node stays down
  until the owner logs in (the personal node's known limit), and the tab says
  it could not reach the node.
- `RunTask` from the window and its placement picker (my call: a tab onto the
  node does the same job for now; stage 2 had left this for stage 3, so it
  moves to stage 4 with `RunTask` in the bridges).
- Retiring the peer mesh, personal nodes off Windows, headless browsers (stage
  4).
- Tabs that can be torn off, split or tiled.
- Tabs on a standalone core, and window-only off Windows (my call, since the
  laptop runs Windows). Tabs exist on the attached and window-only hosts only:
  `standalone-host.js` marks every event local, so a remote tab beside it would
  count as local. macOS, Linux and a dev `--kl-standalone` keep one window and no
  remote tab until stage 4.

Anti-goals, a failure even if everything else works:
- The front door can read a chat, a secret, a tool result or an approval's
  content. MCP clients are the named exception: a task sent by claude.ai reaches
  the front door in clear, because that client speaks TLS to it and holds no node
  key.
- A remote window gets the on-screen dialog, or any other way past the phone.
- A front door that lies can attach a window to the wrong node, or attach a
  window the owner never approved.
- A blip on hotel wifi stops a turn.

## 4. The window: tabs (owner), one renderer per tab (my call)

The renderer's state assumes one node throughout (`appState` holds one chat
cache and one `activeChatId`), and rewriting it would be the largest and
riskiest part of this stage. So a tab is not a state swap. One `BrowserWindow`
holds a small tab strip and one `WebContentsView` per open node, each running
the same `index.html`. **The renderer does not learn that tabs exist**, and it
stays one renderer for one node. The owner sees tabs; the rewrite is avoided.

- Each tab has its own Electron session partition (`persist:node-<nodeId>`), so
  its local storage and caches are its node's. The app's custom schemes
  (`kl-screenshot:` and the rest) register per session.
- `main.js` and `src/ipc/attached-host.js` move from one host with a `const`
  client and one registration of `ipcMain.handle` to one host per tab, chosen
  by `event.sender`. An event from an unknown sender is refused. Channels the
  main process sends go to that tab's `webContents` only.
- The tab strip is its own small renderer with its own narrow preload. It lists
  open nodes and a **+** menu of known nodes. Tabs and their order persist in
  `desktop-state.js`, which moves from one `pairing` to a list of them.
- Closing a tab closes the connection and never touches the node. Hidden tabs
  stay connected, at most 8 open tabs (my call: each is a renderer's worth of
  memory).
- A tab that wants the owner shows a dot: a question, a finished reply, a lost
  connection. The tab strip learns this from a small status message each host
  sends. The strip never holds chat text.
- A mode change no longer relaunches when a tab can be reloaded instead.
- **A local tab** works as stage 2 built it: the local node, its dialog, its
  Install and Restart panes. A window-only install has no local tab.

A window-only install is a third answer in the first-run setup: "Just a window;
my King Louie runs on another computer". It installs no task and writes no data
dir. An old profile on that machine is left untouched, and the move is offered
only if a node is installed later.

## 5. The path

```
window --wss--> mcp.<domain>/window/v1 --splice-- mesh.<domain>/window/v1 <--wss-- node
   ^                                                                                ^
   +---------------- sealed frames: only these two ends hold the keys --------------+
```

- The window opens a WebSocket to the front door with its bearer token (§7) and
  names a node.
- The front door asks the node over the existing link, in one small signed link
  call, to open a session socket. The node dials out to `mesh.<domain>` with its
  pinned TLS identity, and the front door splices the two sockets, byte for
  byte, without parsing them. So the node link's 1 MiB and 200 frames/s limits
  do not apply, and a window cannot crowd out the link that carries phone
  approvals.
- Limits at the splice (my call, so one client cannot eat the server): 4 sessions
  a grant, 2 per node from one device, a byte budget per session per hour and an
  idle close, set in `frontdoor` config. What the front door can see, and the
  audit records, is which grant reached which node, when, and how many bytes.
  This goes in `mobile/PRIVACY.md`'s neighbour docs.
- A node that is offline answers at once; the tab says so and retries with
  backoff.

## 6. The seal (owner: sealed; construction my call, for security review)

The window and the node run their own authenticated key exchange inside the
spliced socket, before any bridge frame:

- Fresh X25519 keys on both sides. Each side signs the whole transcript with its
  pinned Ed25519 key (the node's identity key, the window's `kld-` device key)
  and the front door's session id, which binds the session and refuses a splice
  into another one. HKDF gives one key per direction.
- Each record is ChaCha20-Poly1305 with a counter nonce per direction. A record
  out of order, replayed or failing to open ends the session. Records are at most
  1 MiB, and a 64 MiB bridge frame goes as many records, with backpressure from
  the socket. Forward secrecy holds from the ephemeral keys.
- `node:crypto` only, no new dependency. The existing loopback handshake stays
  as it is for a local tab.
- The protocol gets a version byte and a written spec,
  `docs/protocol/window-v1.md`, with test vectors like `approval-v1`'s.
- Traffic sizes and timing remain visible to the front door; this is said in the
  docs, not fixed here.
- **Added heartbeat:** a ping every 20 s; 60 s of silence closes and reconnects.
  The loopback bridge has none today, so half-open sockets go unnoticed.

A named security review of this section's code runs before merge, on the most
capable model and separately from the code review.

## 7. Who may attach: two gates

**To the front door: OAuth, as an ordinary client.** The window is a public PKCE
client. It adds what the existing server lacks: a second resource
(`<front door>/window/v1`) beside the MCP URL, an audience check on the new
endpoint, a scope `window:attach` (with the existing `;machines=` narrowing, off
until listed in `scopes_enabled`), and any port on a loopback redirect, as RFC
8252 says for native apps. The consent is the existing phone-signed grant.
Tokens are stored encrypted by the desktop's secure storage. This gate decides
who may reach the splice. It proves nothing to the node.

**To the node: a phone-approved device.** On first attach to a node:

1. The window has its `kld-` device key and gets the node's public key from the
   front door, which it does not trust yet.
2. The window sends an enrollment request; the node sends the phone an Approval,
   `kl.window.enroll`, signed by the node: the device's label and fingerprint.
3. The window shows a QR code holding the full SHA-256 over the device key and
   the node key it received. The owner scans it with the phone's existing Scanner.
   The phone computes the same hash from the device key in the node-signed Approval
   and **the node key it has pinned**. Allow is enabled only on a match. A front door
   that swapped either key cannot make them match, and with a full hash it cannot
   search for a collision, as it could against a short code the owner compares by
   eye.
4. The device-key signature reaches the node, which records the device as
   `remote: true` in `desktop-devices.json`. On a fleet node, where the service
   may not write that file, it is staged and an administrator applies it, as
   `device apply` does (my call).

The node refuses all of it unless the new feature `features.remoteWindow` is on:
off by default, in `DEFAULT_FEATURES` and the five example files. On a personal
node, the local tab's Settings > Local service has "Let other windows attach"
(my call). Turning it on from home is a step the owner has to take before leaving.

**Cutting a window off.** The phone's Settings lists enrolled windows per node,
with a revoke signed by the device key, so a stolen laptop can be cut off from
anywhere. A node re-reads its devices every 5 s and closes a removed device's
session. Revoking the OAuth grant closes its splices as well.

## 8. What a remote window may do

Today every bridge frame's event counts as the local desktop's, whoever sent it
(`bridge-dispatcher.js:175-178`). A remote device must not. The dispatcher marks
a remote device's events with a new origin, `remote-window`, which is never local:

- **Tool approvals go to the phone**, never to a dialog: one press per acting call
  in part B, under a grant once part C lands (§15).
- **Questions.** A pressed question's card says "Answer on your phone": an
  `in-app` press proves no model stood between, but not that the owner holds the
  laptop. `remote-window` joins no press list (`APP_ANSWER_CHANNELS`,
  `PRESS_CHANNELS`). A spoken answer works as in a chat, recorded with its channel.
- **Typed words are the owner's** for `user` provenance (my call: the channel is
  sealed and the device phone-enrolled). They are never a lift: `ownerQuote`,
  always-approve and `allow` rules lift nothing on a remote turn, as
  `denyAutoApproval` already means.
- **A private chat's text may show** in the tab, since the seal keeps it off the
  front door. Its models stay local, on the node.
- **Local-only gates stay closed:** `models:local.add` and its neighbours
  (null device id), `NOT_LOCAL_DESKTOP`, and private marks, which become phone
  approvals rather than refusals.

**No never list; a remote list with phone gates.** Stage 2's warning stands: the
personal proxied list must not be inherited as it is. Each channel in both lists,
and each `t:'call'` method, which today bypass the allowlist, gets one class in a
new table in `src/desktop-bridge/allowlist.js`. A test fails on a channel with no
class.

| Class | Behaviour from a remote window | Examples |
|---|---|---|
| read | runs | chats, cases, settings shown, `vaultList` names |
| ordinary | runs | `chat:sendMessage`, stop, archive, chat settings |
| phone | one signed tool approval naming the channel and its arguments, each time | `tool:execute`, `skill:install`, `settings:mcpSave`, `hooks:*`, `webhook:*` (they return secrets), `channel:*`, `apps:addCustomApp`, `cron:add`, `workflow:run`, `settings:vault*` writes, `import.apply`, always-approve and permission rules, `bridge.setWorkingDirectory`, `bridge.addAllowedDirectory`, `case:ingestFiles`, `checkpoint:restore`, private marks |
| local | refused, with the reason on screen | `app:quitWindow`, Install, Restart, Unpair of the node, setup and migration |

`tool:approvalResponse` from a remote window is refused: its answer would be the
on-screen dialog.

## 9. A node with several windows, and turns that outlive them

Today a node takes one window: another device gets `4409 ANOTHER_DEVICE`. **That
breaks the first case**: the desktop's own window left open at home would keep the
laptop out. So:

- A node takes up to 8 devices at once; the same device replacing itself still
  works.
- Dispatcher state moves to each connection. Chat events go to every attached
  window, so the laptop and the desktop show the same chat. A dialog goes only to
  a local window, and only for a run a local window started.
- **A remote window that drops stops nothing.** Its runs carry on, a prompt it was
  waiting on stays with the phone, and on reconnect the window re-reads the chat
  from the store and whether a turn is running. It misses streamed deltas during
  the gap, and the finished row arrives from the store. A local window's drop keeps
  today's behaviour (my call: stage 2's meaning stays until someone asks otherwise).
- Two windows sending into one chat: the second gets the existing busy refusal.

## 10. Words that mean something else remotely

- **Screenshots.** The renderer loads `file://<path>` from a string the node sent.
  In a remote tab that would read the laptop's disk. A new read channel fetches the
  bytes from under the node's own screenshot dir, and the renderer never builds a
  `file://` from a node string in a remote tab.
- **Working and allowed directories.** The native dialog shows the wrong disk. A
  remote tab asks for a path as text, checked on the node, with a phone approval
  (§8).
- **Attachments and drag-and-drop** already send bytes. The frame limit stays, and
  over a slow link progress shows.
- **Browser, GUI and takes** are the node's screen. Nothing appears on the laptop
  beyond screenshots; the docs say so.
- **Install, Start, Restart, Unpair of the node, setup, migration** are local class,
  hidden in a remote tab. Detach becomes closing the tab; a separate **Forget this
  node** drops the device's own record.
- **Presence.** A focused remote tab counts as the owner being at a window (my call).
- **Versions.** A protocol mismatch shows on that tab only and says which side to
  update. The other tabs go on.

## 11. Sizes

A phone-class call's arguments can pass what an approval can carry: `case:ingestFiles`
and `import.apply` run far past the node link's 1 MiB frame. The approval shows a host-built
summary and a hash of the whole, and is sealed like any other. The window sends the
bytes only over its own sealed session, and the node runs exactly what was hashed
(my call).

## 12. Testing and what remains unproved

- The seal: test vectors, plus tests that tampering, replay, reorder, a wrong key
  and a session-id swap each close the session, and that bytes on the splice never
  contain a planted plaintext.
- `tests/helpers/` gets a fake front door with a real splice on loopback. No real
  network. An e2e launches one window with two tabs onto two real test nodes through
  it, drops the socket during a turn, and reconnects.
- A hostile front door test: it swaps the device key or the node key during
  enrollment; the phone's hash differs, Allow stays off, and no device is recorded.
- A sweep test walks every allowlisted channel and call method from a remote origin
  and asserts its class's behaviour.
- Vectors for `kl.window.enroll` and the revoke in `tests/vectors/`; both phone cores.
- Unproved until run for real: a real front-door deployment (the owner's yes), the
  phone builds (Swift needs a Mac, and part A changes both apps), a real laptop on a
  real network, and memory with 8 tabs.

## 13. Left to the builder

The order of work inside each part (for part B, suggested: several windows per node;
the remote origin and the class table; the seal; the splice and OAuth; enrollment;
tabs; §10 last, with each piece testable alone on loopback), the exact byte budgets,
the tab strip's look, and the protocol files' layout. New words go in `CONTEXT.md`;
this stage's choice of a sealed front door gets ADR 0005.

## 14. Part A: sealed phones (owner: in this stage; construction my call, for security review)

Today the relay operator sees every parameter of a tool approval, including values
given to `Vault` (`mobile/PRIVACY.md`, "What the relay operator can see"). End-to-end
encryption to the phones is not implemented. The front door hosts the relay, so the
seal in §6 would leave that gap open.

- **A third phone key, the box key:** a P-256 key for key agreement, on both apps,
  in the Keystore or Secure Enclave, usable only while the phone is unlocked and
  asking for no fingerprint: reading is not deciding. It enrolls like Android's read
  key: carried in a new enrollment, or a device-signed `kl.device.box_key` for a phone
  already enrolled, staged per node and applied with `device apply`.
- **Sealing:** the node seals content to each enrolled device separately, with an
  ephemeral P-256 key, HKDF and AES-256-GCM, then signs over the ciphertext. Formats
  in `docs/protocol/approval-v1.md`, revised, with vectors for both phone cores. The
  phone verifies the node's signature and then opens the box. What the phone signs
  stays bound to the exact action. A hash shown to the relay is salted, so a short
  value cannot be guessed from it.
- **What gets sealed:** every field `mobile/PRIVACY.md` lists in clear. That is tool
  approvals' parameters, cwd and summary; questions and answers; envelopes; lease and
  take names, sites and reasons; lease views, pictures and action logs; task grant
  cards. The relay keeps only what it routes by: node, device, kind, request id,
  expiry and sizes.
- **The audit mirror** carries the first 60 code points of a task's text in
  `lease.requested` and `lease.granted`. These become sealed fields or leave the
  mirrored entry; the hash chain stays verifiable by the relay. The plan decides which
  per entry.
- **Phones that have not updated.** A node stays in clear only while no device has a
  box key. Once one does, everything on that node is sealed, and a device with no box
  key sees "Update the app to read this" and can decide nothing. A relay cannot force
  a downgrade, since a box key arrives device-signed and the node decides. `doctor`
  reports devices with no box key. Upgrade order goes in the guide: phones first, then
  nodes.
- **What part A cannot hide:** push stays content-free as it is. The relay still sees
  when and how often the node asks, and how large each request is. MCP clients' text
  crosses the front door (§3).

A second security review, like §6's, runs on part A.

## 15. Part C: one grant for a remote chat (owner: in this stage; shape my call)

The first acting call of a remote window's chat raises one grant. Calls inside it run;
a call outside it asks per call. A local tab is unchanged.

- **Not a lease.** A node's one lease belongs to computer use, and `LeaseManager` does
  not exist with `gui` off, which is the default. A new `ChatGrantManager`, always
  present on an agent node, holds grants beside it, so a chat grant never collides
  with a task or a take. The eight acting GUI tools are never covered by one: computer
  use still needs its lease.
- **What it covers:** the task grant's classes through `createTaskPolicy`, generalised
  so a work directory is optional: `browser-act` and `logins` on granted sites, `shell`,
  and `files-write` under the chat's working directory only (none set, no such class).
  Calls in no class still ask each time. The node's deny rules, `denied` tier and
  denied dirs still win, as for a task.
- **Who proposes it:** one utility-role call over the owner's message and the blocked
  call, with the chat's egress, at the first acting call, using a new prompt beside
  `task-scope-v1.md`. In a private chat with no local model, or when malformed twice,
  the card covers only that call's own class and site.
- **The card:** host-built, sealed as in part A: which window, which node, the sites,
  the classes, until when, the spend cap. Defaults are $2 and 60 minutes, with at most
  240 minutes. The call waits for the press like any tool approval. A no denies that
  call, and the denial tracker applies as usual.
- **Lifetime:** one chat and one device. It ends at its deadline or cap, on Stop from
  any phone, when the device is revoked, when the chat becomes a case or private, or
  from the tab's **End grant**. The spend cap counts what is spent after the press.
  When it ends the next acting call raises a new one. A window that drops does not end
  it, so a turn can finish.
- **Seeing and stopping it.** Each live grant is a row on the phone with Stop. It joins
  the node-signed lease listing (`verifyLeaseListing`), revised, so a relay cannot hide
  one, and the tab shows it too.
- **Tasks** are unchanged. A chat grant is not a task: no record, no `TaskManager`.
