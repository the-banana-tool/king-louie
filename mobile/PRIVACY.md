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

Nothing else. There are no analytics, no crash reporters and no third-party
SDKs besides Firebase Messaging in the Android `fcm` build.

## What the relay operator can see

The relay passes messages between your phone and your nodes. Whoever runs it
can see:

- every action your nodes ask you to approve, **with all of its parameters**:
  commands, file paths, runbook steps, and values a tool was given (including
  secrets passed to the `Vault` tool). End-to-end encryption to the phone is
  not implemented yet (spec §11.12);
- your answers (signed; the relay cannot forge or change them), and the
  history slices you open (iPhone);
- **when the app is open.** While it is in front, the Android app asks the
  relay for what is waiting all the time (one request held open for up to 25
  seconds, then the other lists, again and again) and tells the relay it is
  in front once a minute, and once more that it has left when you leave it.
  The iPhone app does the same while its session is unlocked. The relay
  passes "in front" on to your nodes, so a case's questions wait in the app
  instead of moving on to a text message or an email while you have it open.
  Those requests are signed (on Android with the read key) and carry your
  device id;
- every computer-use request a node sends you: the node's id and name, the
  apps it asks for (their ids, names, full paths and process names), for how
  long, for a take (a screen-recorded demo) the take's name and the hosts it
  may visit, the agent's stated reason (up to 280 characters the agent wrote
  itself, so it can say anything), the job id, the name of the client that
  asked and its session id, and what the node cannot detect (no lock
  detection, say); your answer and any stop or watch you send, with your
  device id (signed; the relay cannot forge or change them); and each change
  of a lease's state: waiting, active, paused, ended or screen locked, the
  reason as a short code (`revoked`, `expired`, `no_contact`,
  `foreground_changed` and the like) and when it runs out. Each of those
  state messages and each picture carries a random token, and each watch
  your phone sends repeats the newest one it has seen: that is how the node
  knows the watch was signed just now and not kept back by the relay. The
  token says nothing else. Each state message also names the phone that
  granted the lease, by its device id and the name it was enrolled under,
  so that another of your phones can say whose lease it is about to stop;
  and when a phone opens the app (on Android, every time it checks while it
  is open) the relay asks each of your nodes, for that phone, which leases
  are running. That request carries a random number
  your phone made up for it, and each node's answer repeats it beside a
  list of the leases it names (their ids and message numbers) and your
  phone's device id, signed, also when the list is empty. The number says
  nothing else; it is how your phone knows the answer was made for this
  request and is complete, so the relay cannot leave a running lease out
  unnoticed. A node on which computer use is switched off answers as well,
  with an empty list. The relay can still keep a node's whole answer back;
  your phone then says "Could not confirm with" that node instead of
  showing nothing, and for a node that did answer it shows when it checked;
- while a phone watches a lease, **pictures of the leased app's window with
  everything on it**, and the list of what the agent did there. The list
  never holds text the agent typed: a typed text appears as its length only
  ("Typed 42 characters") and a key that types a character as "Key (a
  character)". It does hold each click, scroll and drag with its position in
  the picture and the picture's number, the names of keys that are not text
  ("Key ctrl+s", "Key enter"), and whether each was done or the code it was
  refused with. Each picture also comes with the lease's state, the seconds
  left, and which allowlisted app is in front (its id). **The pictures
  themselves still show whatever is on the window, including text once it
  has been typed into it.** Window titles are not sent. A picture is a JPEG, by default at most 960 pixels
  wide and never more than 180 KB; a node sends at most one a second (one
  every three seconds by default) and none while no phone is watching, the
  lease is paused or the screen is locked. The relay holds each for five
  minutes.
  The iPhone app watches only while its live view of the lease is on screen
  and the app is in front and unlocked; when you close that view or leave
  the app the node keeps sending pictures for up to a minute more, and then
  none (and the lease pauses about two minutes after the last watch, until
  you open the view again). The Android app does the same: it watches,
  every 20 seconds and signed with its read key, only while a lease's
  detail is on screen and the app is in front, and loads the pictures as
  they come; when you close the detail or leave the app the watches stop,
  and a lease this phone allowed pauses about two minutes later;
- each node's audit history (the slices you open, and the copy a relay keeps
  when it mirrors a node's ledger). For computer use an entry holds the job
  and lease ids, the tool, the app in front before and after (its path and
  process id), and the result. It never holds what was typed: a `Type` entry
  holds the length of the text and nothing else (no hash of it: a plain hash
  of a short text gives the text to anyone who guesses it), and a `Key` entry
  names the key only when it is not text ("ctrl+s", "enter"); a key that
  types a character is "(a character)". The same holds for the hash of a
  call's parameters that the node records with each tool call: for `Type`
  and `Key` it is taken over that reduced form, never over the text or the
  key. Launches are recorded with the program, its arguments and files;
  screenshots with the app, a number and the picture's hash, never the
  picture;
- your devices' names, platforms and public keys (for an Android phone, the
  public half of its read key too), which nodes they approve for, and their
  push tokens;
- which of your phones stopped a computer-use session, so that phone is not
  notified of its own Stop;
- the network addresses your phone and nodes connect from.

The relay cannot approve anything: nodes check the phone's signature over the
exact action, and phones show only what a pinned node signed.

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
  phone that allowed it).

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

## Demo mode

On iPhone, "Try demo" runs entirely on the phone with made-up machines and a
software key. It never contacts a relay. Leaving demo deletes the demo key.
The Android app has no demo.

## Reset

"Reset this phone" in Settings deletes the key (on Android, both keys) and
everything listed above.
Nodes keep trusting the key until it is revoked from another phone or with
`king-louie-service device revoke <device-id>` on each node.
