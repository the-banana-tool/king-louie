# King Louie approvals app — privacy

The King Louie app lets you approve or deny actions your own machines ask to
take. It is built from `docs/protocol/approval-v1.md` and talks only to the
relay you pair it with.

## What the app keeps on the phone

- The relay's address and the pin of its TLS key.
- For each paired node: its id, name and public key (the pins that decide
  which requests are shown).
- A reference to this phone's device key, the key that signs every decision. It
  is created in the Secure Enclave (iOS) or the Android Keystore (StrongBox
  where available) and never leaves it; it signs only after a biometric check
  and stops working if the enrolled fingerprints or faces change.
- On Android, a reference to a second key, the read key, made beside the
  device key in the Android Keystore (StrongBox where available). It never
  leaves the Keystore either, asks for no fingerprint, and the Keystore
  refuses to use it while the phone is locked. See "The read key (Android)"
  below. A phone paired before the read key existed also keeps, for up to
  seven days, the statement its device key signed to introduce the read key
  to your nodes, so it can send it again to a node that was offline.
- A reference to the box key, which opens what your nodes seal to this phone.
  See "The box key" below. A phone paired before the box key existed also keeps,
  for up to seven days, the statement that introduces it, and which nodes were told.
- Which nodes this phone has verified a sealed message from (their ids), so that a
  clear message replayed from such a node gets no decision.
- The push token, when push is configured. The Android app sends it to the
  relay again at every start. Reset this phone asks the relay to forget it
  and deletes it.
- On iPhone, history you opened, as the node-signed slices the node sent —
  held in memory for as long as you're looking at it, not written to disk.
  The Android app has no history view.
- A computer-use lease you allowed or are watching: its latest picture and
  its list of actions — held in memory while the app is running, not written
  to disk. And, for every lease that is running on a paired node, whoever
  granted it: its state, when it runs out and which phone granted it, as
  the node signed them the last time the app asked.
- What it opened from a sealed message and the last name of each take or
  task: held in memory, not written to disk. What it opened is dropped when the app
  leaves the screen.

Nothing else. There are no analytics, no crash reporters and no third-party
SDKs besides Firebase Messaging in the Android `fcm` build.

## What the relay operator can see

The relay passes messages between your phone and your nodes. A node **seals**
what it sends once one of your phones has given it a box key (below): the relay
carries it and cannot read it. So what the operator can see depends on the node.

### What a sealing node hides

Sealed to each of your phones that holds a box key, and to the node itself:

- every action your nodes ask you to approve, **with all of its parameters**:
  commands, file paths, runbook steps, values a tool was given, the summary,
  and the client, session and job it came from;
- every question from a case: the case and question ids, the case's title, the
  text and the options; and your answer to it;
- every computer-use, take and task request: the apps (their ids, names, full
  paths and process names), for how long, a take's name and hosts, a task's
  name, the hosts it may act on, what it may do and the most it may spend, the
  agent's stated reason, the job id, the client and session, and what the node
  cannot detect. This is the task card your phone shows;
- a take's or task's name in each state message;
- **pictures of the leased app's window**, which app is in front, and the list
  of what the agent did there.

A sealed picture is at most 135 KB; a bigger one is captured again smaller, then
dropped, and never goes in clear. The relay holds each sealed picture for five
minutes and cannot open it.

### What the operator still sees

- **Routing fields and times:** node ids and names, device ids and names,
  request, lease and message ids, a question's token, each message's type and
  times, and a list of which phones each sealed message can be opened by.
- **Your decisions:** `approve` or `deny`, `grant` or `deny` with your device id.
  A grant also holds the **ids of the apps you allowed** and the minutes. Stops and
  watches are in clear too. All are signed: the relay cannot forge or change them.
- **A question's kind and urgency.**
- **Each lease's state:** waiting, active, paused, ended or screen locked, the
  reason as a short code (`revoked`, `expired`, `no_contact`,
  `foreground_changed` and the like), its kind (computer use, take or task),
  whether it is unattended, when it runs out, and which phone granted it, by its
  device id and enrolled name. A picture's outer part has the state and the seconds
  left. Each carries a random token that a watch repeats, which says nothing else:
  it is how the node knows the watch was signed just now.
- **What a lease listing says:** when a phone opens the app (on Android, every time
  it checks while it is open) the relay asks each node which leases are running. The
  answer repeats a random number your phone chose and lists lease ids and message
  numbers, signed, also when empty, so the relay cannot leave a running lease out
  unnoticed. The relay can still keep a node's whole answer back; your phone then
  says "Could not confirm with" that node instead of showing nothing, and for a node
  that did answer it shows when it checked. A node on which computer use is off
  answers as well, with an empty list.
- **Timing and sizes:** when each message goes and how big it is. What is sealed is
  rounded up to a multiple of 256 bytes, so a short message's length says nothing: an
  answer of "approve" and one of "refuse" are the same size. A large action or a busy
  window can still be told from a small one, to within 256 bytes.
- **When the app is open.** While it is in front, the Android app asks the relay
  for what is waiting all the time (one request held open for up to 25 seconds,
  then the other lists, again and again) and tells the relay it is in front once a
  minute, and once more that it has left when you leave it. The iPhone app does the
  same while its session is unlocked. The relay passes "in front" on to your nodes,
  so a case's questions wait in the app instead of moving on to a text message or
  an email while you have it open. Those requests are signed (on Android with the
  read key) and carry your device id.
- **Watching a lease:** the iPhone app watches only while its live view of the lease
  is on screen and the app is in front and unlocked; when you close that view or leave
  the app the node keeps sending pictures for up to a minute more, and then none (and
  the lease pauses about two minutes after the last watch, until you open the view
  again). The Android app does the same: it watches, every 20 seconds and signed with
  its read key, only while a lease's detail is on screen and the app is in front; when
  you close the detail or leave the app the watches stop, and a lease this phone allowed
  pauses about two minutes later. A node sends at most one picture a second (one every
  three seconds by default) and none while no phone is watching, the lease is paused or
  the screen is locked. So the relay sees when you are watching.
- **The node's audit ledger:** the history slices you open (iPhone), and the copy
  a relay keeps when it mirrors a node's ledger. It holds tool names, tiers and ids;
  for a front-door client the `grant_id` and `client_id` it issued, for any other
  caller only what kind of caller it was; and a keyed `params_hmac` over a call's
  parameters, under a key only the node holds, so a relay cannot test a guess at a
  short value. A tool approval's entry holds the sealed request and, beside it, your
  signed decision. A lease's entries hold its ids, kind, the app ids, the minutes and,
  for a take, whether it may use logins, and for a task, what it may do and the most
  it may spend; never a name, a site or a reason. A computer-use entry holds the job
  and lease ids, the tool, the app in front before and after (its path and process id)
  and the result. It never holds what was typed: a `Type` entry holds the length of
  the text and nothing else, and a `Key` entry names the key only when it is not text
  ("ctrl+s", "enter"); a key that types a character is "(a character)". A launch names
  the app's id from your allowlist and its process id, not its arguments or files. A
  screenshot holds the app, a number and the picture's hash, never the picture. A failed
  call holds a code or how many characters its error had, never the words. A task's
  entry holds its id, its node's name and caller kind, why it ended and what it spent.
- **Your devices:** names, platforms and public keys (for an Android phone, the public
  half of its read key too), which nodes they approve for, and their push tokens. A box
  key's public half passes through the relay when it is stated, and the relay keeps
  none; every sealed message also carries the node's public box key in clear.
- which of your phones stopped a computer-use session, so that phone is not
  notified of its own Stop;
- the network addresses your phone and nodes connect from.

### What a front door sees by design

What an MCP client sends and gets back crosses the front door **in clear**, as any
tool call does: a task's text, your client's messages and the answer, a runbook's
parameters, the node's name, a task's state and what it spent. The front door is the
client's server, and the seal covers only what passes between a node and your phones.
It also holds each client's name and the grants you gave it.

### A node that does not seal

Until a phone's box key is on a node, that node sends all of the above in clear, as it
always did, secrets passed to the `Vault` tool and the full reason text included, and its
ledger holds the request with its parameters. That is a node not upgraded yet, or one
upgraded with no `device apply` for a box key yet (entries it wrote before then stay as
they are, and an older entry holds a plain hash of a call's parameters). Doctor's
`sealing to phones` row says which it is.

A node that has sealed does not go back on its own. If no phone can read it any more it
sends no content at all: it refuses `no_sealed_recipient`. Only `king-louie-service
device unseal`, at the node's console, goes back to clear. One gap remains: anything
running as the node's service account can delete the file that remembers this
(`approvals/sealing.json`). While a phone holds a box key the node writes it again at
once; with none, the node then sends in clear.

The relay cannot approve anything: nodes check the phone's signature over the
exact action, and phones show only what a pinned node signed. A relay can replay an
old clear message a node once signed; a phone that has verified a sealed message from
that node shows it with no decision.

## Push

Push is optional. When configured, a push carries only a kind, an id (of the
request, or of the computer-use session it is about), the node's name and,
when several things arrive within ten seconds, how many (the node's name
shows in the alert text, such as "Approval needed on web-01" or "Session
request on web-01" for a computer-use request); the app fetches the request
from the relay and verifies it before showing it. On Android a push also
says, in words the app builds on the phone:

- a computer-use session or take ended, unless you stopped it from this
  phone;
- a computer-use session paused because no phone was watching (only to the
  phone that allowed it);
- a task ended.

On Android, a tap fetches with the phone's read key, without a fingerprint,
and shows only what the node signed; a notification has no buttons of its
own.

- Apple (APNs) sees the request kind and node name in the alert it delivers.
- Google (FCM) sees only the data fields, and the app builds the visible text
  on the phone: the kind, the id, the node's name and a count; from them,
  when your nodes ask for something and when a session ended or paused. It
  also sees the phone's push token, your Firebase project and the time. To
  keep machine names from Google, give your nodes neutral names (the name is
  the one a node was paired under).
- Neither sees the command, arguments or approval content, nor anything about
  a computer-use request beyond its kind, its id and the node's name: no app,
  site, take name or reason.

Whoever holds your relay's push credential (a key of your Firebase project)
can send these content-free notifications to the phones whose tokens it
knows. A forged one opens the app on a list or a detail that is fetched and
verified, so it can lead you to open the app, never to approve anything.

Without push, the app checks the relay only while it is open.

## The read key (Android)

The Android app signs with two keys. The device key decides: every Approve,
Deny, Allow, Stop, answer, client connection, node pairing, enrollment and
revocation is one fingerprint over exactly what you decide. The read key asks
for nothing and signs only two kinds of thing: requests that read from the
relay (the lists, a lease's state and pictures, "the app is in front") and
the watches that keep a computer-use lease you allowed going while its detail
is open. Your nodes accept nothing else signed with it, so it can never say
yes to anything.

Its public half is on the relay and on each of your nodes (in the node's
approver record, once its administrator has run `king-louie-service device
apply` for it; a phone paired with the read key from the start brings it at
pairing). The private half stays in the Keystore, and the Keystore will not
use it while the phone is locked.

What that means if someone has your phone **unlocked**, with the app open:
they can read everything the app lists, with every parameter, and the
pictures of a leased app; they can keep a computer-use lease this phone
allowed going until the time you approved runs out (never longer); and the
relay will see the app in front, so a case's questions wait in the app
instead of reaching you by text or email. They cannot approve, deny, allow,
stop, answer, connect, pair, enroll or revoke anything without your
fingerprint.

## The box key

Each app makes one more P-256 key, in the Android Keystore (StrongBox where available)
or the Secure Enclave on iPhone. It never leaves. It signs nothing, so it can never say
yes to anything. It opens what a node has sealed to this phone. It asks for no
fingerprint, and it does not work while the phone is locked: the row then says
`Unlock to read`.

Its public half goes to each node at pairing, or, for a phone paired before it existed,
in a statement your device key signs. The relay passes that on and keeps nothing. A
stated key waits on the node until its administrator runs `king-louie-service device
apply`. That is when the node starts sealing, and a phone without a box key sees
`Sealed for this node's other phones. Run device apply on <node> for this phone.`
instead of the request.

Each node holds a box key of its own, encrypted beside its identity key. Your answers are
sealed to it. Whoever holds a node's data directory and master key can open what was sealed
to that node.

What that means if someone has your phone **unlocked**, with the app open: they can read
what the app lists, as before. Without your fingerprint they cannot approve, deny, allow,
stop, answer or anything else that decides.

The largest sealed approval holds about 130 KB of parameters. A bigger action is refused
(`action_too_large`) rather than sent in clear.

## Demo mode

On iPhone, "Try demo" runs entirely on the phone with made-up machines and a
software key. It never contacts a relay. Leaving demo deletes the demo key.
The Android app has no demo.

## Reset

"Reset this phone" in Settings deletes this phone's keys and everything listed
above.
Nodes keep trusting the key until it is revoked from another phone or with
`king-louie-service device revoke <device-id>` on each node.
