# King Louie approvals app — privacy

The King Louie app lets you approve or deny actions your own machines ask to
take. It is built from `docs/protocol/approval-v1.md` and talks only to the
relay you pair it with.

## What the app keeps on the phone

- The relay's address and the pin of its TLS key.
- For each paired node: its id, name and public key (the pins that decide
  which requests are shown).
- A reference to this phone's approval key. The key itself is created in the
  Secure Enclave (iOS) or the Android Keystore (StrongBox where available) and
  never leaves it; it signs only after a biometric check and stops working if
  the enrolled fingerprints or faces change.
- The push token, when push is configured.
- History you opened, as the node-signed slices the node sent — held in
  memory for as long as you're looking at it, not written to disk.
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
  history slices you open;
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
  and when a phone opens the app (on Android, when you tap "Check for
  computer-use requests") the relay asks each of your nodes, for that
  phone, which leases are running. That request carries a random number
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
  you open the view again). The Android app watches only when you tap
  Refresh; the node then keeps sending pictures for up to a minute,
  although the app loads only the first to arrive and waits at most five
  seconds for it;
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
- your devices' names, platforms and public keys, which nodes they approve
  for, and their push tokens;
- the network addresses your phone and nodes connect from.

The relay cannot approve anything: nodes check the phone's signature over the
exact action, and phones show only what a pinned node signed.

## Push

Push is optional. When configured, a push carries only a kind and a request id
(and the node's name in the alert text, such as "Approval needed on web-01" or
"Session request on web-01" for a computer-use request); the app fetches the
request from the relay and verifies it before showing it. On Android a
computer-use push only opens the app: the request is fetched when you tap
"Check for computer-use requests".

- Apple (APNs) sees the request kind and node name in the alert it delivers.
- Google (FCM) sees only the data fields, and the app builds the visible text
  on the phone.
- Neither sees the command, arguments or approval content, nor anything about
  a computer-use request beyond its kind, its id and the node's name.

Without push, the app checks the relay only while it is open.

## Demo mode

"Try demo" runs entirely on the phone with made-up machines and a software key.
It never contacts a relay. Leaving demo deletes the demo key.

## Reset

"Reset this phone" in Settings deletes the key and everything listed above.
Nodes keep trusting the key until it is revoked from another phone or with
`king-louie-service device revoke <device-id>` on each node.
