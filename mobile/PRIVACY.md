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
- your devices' names, platforms and public keys, which nodes they approve
  for, and their push tokens;
- the network addresses your phone and nodes connect from.

The relay cannot approve anything: nodes check the phone's signature over the
exact action, and phones show only what a pinned node signed.

## Push

Push is optional. When configured, a push carries only a kind and a request id
(and the node's name in the alert text, such as "Approval needed on web-01");
the app fetches the request from the relay and verifies it before showing it.
Apple (APNs) or Google (FCM) deliver the push and see that it was sent. Without
push, the app checks the relay only while it is open.

## Demo mode

"Try demo" runs entirely on the phone with made-up machines and a software key.
It never contacts a relay. Leaving demo deletes the demo key.

## Reset

"Reset this phone" in Settings deletes the key and everything listed above.
Nodes keep trusting the key until it is revoked from another phone or with
`king-louie-service device revoke <device-id>` on each node.
