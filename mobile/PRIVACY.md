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
  to disk.

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
  long, the agent's stated reason (up to 280 characters the agent wrote
  itself, so it can say anything), the job id, the name of the client that
  asked and its session id, and what the node cannot detect (no lock
  detection, say); your answer and any stop or watch you send, with your
  device id (signed; the relay cannot forge or change them); and each change
  of a lease's state: waiting, active, paused, ended or screen locked, the
  reason as a short code (`revoked`, `expired`, `no_contact`,
  `foreground_changed` and the like) and when it runs out;
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
  The iPhone app watches from the moment you allow a lease until it ends,
  while the app is open and unlocked. The Android app watches only when you
  tap Refresh; the node then keeps sending pictures for up to a minute,
  although the app loads only the first to arrive and waits at most five
  seconds for it;
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
