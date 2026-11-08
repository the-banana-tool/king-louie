# Task 9 report: enrollment, revoke and the list

Status: DONE_WITH_CONCERNS (see the end).

## What exists

- `src/approvals/window-messages.js`: `buildWindowEnroll`, `buildWindowList`, `qrFor({ devicePublicKey, nodePublicKey, nonce })`, `enrollCode`, `enrollHashBytes`, `isSmallOrderKey`, `refusedWindowKey`, `rawNodeKey`, `spkiHex`, and the verifiers both writers use: `openWindowEnroll`, `verifyWindowResponse`, `verifyWindowRevoke`, `revokeCovers`.
- `src/approvals/messages.js`: the four validators (sealed shape only) and `validateOpenedWindow`. `seal.js`: four rows; `senderKey` knows the phone sends the answer and the revoke.
- `src/desktop-bridge/window-enrollment.js`: `createWindowEnrollment` (`request`, `status`, `onResponse`, `onRevoke`, `list`, `isEnrolled`, `revokedRecord`, `onChange`, `held`, `close`) and `createWindowDevices`, the record writer `device apply` is given.
- `window-seal.js`: the `enrollUnknown` option, `promote()`, `ENROLL_FRAME_MAX`.
- `bridge-server.js`: `setWindowEnrollment`, `server.enrolling`, `_beginEnrolling`, `_onEnrollFrame`, `_judgeEnrolling`. `_standing` and the ready check read the overlay through `_revokedRecord`.
- Store: `stage(envelope, { window })`, `windowOverlay` (id to the revoke's signed time, rebuilt from what is staged). Admin: `applyStaged({ windowDevices })`.
- Routes in `src/frontdoor/routes.js`; the mailbox prefix in `extensions.js`; `window` in `KINDS` and `FCM_ONLY_KINDS`, kept in `PUSH_KINDS`.
- `createWindowHandlers({ server, dialer, enrollment })`, `createWindowRecordHandlers(enrollment)`.

## For Task 10 (the window)

- First frame after the handshake for an unknown device: `{ t: 'enrolling', protocol }`, where a known device gets `{ t: 'ready', service }`.
- `{ t: 'call', id, method: 'window.enroll', params: { label } }` answers `{ t: 'result', id, value: { request_id, expires_at } }`, or `{ t: 'result', id, error, code }`. Codes: `bad_label`, `bad_key`, `small_order_key`, `test_key`, `node_not_sealing`, `rate_limited`, `phone_unreachable`, `remote_window_off`. A refusal leaves the connection open.
- `window.enrollStatus` answers `{ state }`: `pending`, `staged` (fleet: approved, waiting for `device apply`), `approved`, `denied`, `expired`, `unknown`.
- Denied or expired: a sealed `{ t: 'enrollState', state }` (or the status answer), then a close record `4403`. The deadline (15 min) is a close record `4403` with no state frame.
- Promotion: `{ t: 'ready', service }` on the same connection. A fleet window whose deadline passes before `device apply` runs reconnects later and attaches as a known device.
- `qrFor` and `enrollCode` are the window's to call. Nothing on the node knows `n`.

## For Task 15 (the phones)

- Where a phone finds a request: R-RW-14 names a mailbox type and three routes, and no route to read that type. `GET /v1/windows` therefore returns the mailbox's `kl.window.enroll` rows beside the `kl.window.list` rows, all `{ node_id, envelope | null }`, told apart by the opened type (`expires_at` also on a request's row). Same pattern as `GET /v1/leases`. Overrule if a separate route is wanted: it changes `ROUTE_AUTH`.
- `decision` is the sealed content of the response, `reason` of the revoke, each to the `node_box`. Response and revoke are signed after sealing, over the sealed message.
- Route answers: `202 { state, reason, pending_apply }`.
- `PushText.KINDS` needs `window`. `tests/mobile-android-push.test.js` excludes it until then, so Android drops that push today and sees the request in its next list.
- Vectors all have `consumers: ['node']`; flip them.

## Rulings carried out

- R-RW-36: the seal's option, verify `pub_dev` first, `enrolled: false`, 4096 bytes and no `more`, no dispatcher reference, separate cap (`maxEnrollWindows` 4), one per device (a new one replaces it), one pending request per device (asking again returns it, no new card), `requestsPerHour` 20 per node, a deadline, promotion only on a fresh read. A sweep test sends every `REMOTE_CLASSES` name as an invoke and as a call.
- R-RW-34: QR holds `h` and `n`; no `qr` in any node answer; `enrollCode`; vector `window-enroll-code`.
- R-RW-30: `request` refuses `node_not_sealing`; an enrolling connection closes `4503` if the node stops sealing.
- Coordinator, Task 5 re-review: an unreadable devices file never reaches the enroll state. `_onSealedReady` refuses `4504` on `lookupUnreadable` (Task 5's flag) before anything else, so one corrupt read at the lookup with a good file right after is still `4504`. Tested with a permanently corrupt file and with one corrupt read.
- Coordinator, Task 6 review, and the ruling on the feature off: real rows for the three methods, tested through `createRelayDispatcher`. `window.revoke` and `window.list` work with `features.remoteWindow` off, and with it on but no front door pin (`startRecordsOnly` in `desktop-bridge/service-wiring.js`), tested through the real `createDesktopBridgeHost`. `window.open` and `window.enroll_response` stay `remote_window_off`. A runbook-profile node has no bridge host and stays off.
- Small-order keys: the libsodium list, sign bit masked. A test shows the identity point verifying a crafted signature over two messages, then a real handshake with that key reaching `enrolling` and being refused `small_order_key` at `window.enroll`. Refused again at `device apply`.
- `kl.window.*` through a relay's `device.*` method is refused `malformed` (the store needs `window`, which only the enrollment passes), so `service-wiring.js` in approvals needed no change.

## Calls to check

1. The response's sealed content is `decision`. R-RW-14 says all four join the table and gives no clear/content split for this one. It means `device apply` needs the node's box key, as it does anyway to read the window's key and label from the request.
2. A revoke against a record: dated more than 5 minutes before `pairedAt` it is `stale`, so a held or replayed revoke cannot remove a re-enrollment. Inside the margin it counts, which fails closed. Consequence: re-enrolling and applying within 5 minutes of a revoke on a fleet node leaves that window revoked until the service restarts.
3. A revoke of a local pairing is refused `not_remote`, on both hostings.
4. A revoke withdraws that window's pending request; any later answer is `already_answered`.
5. Revoke's `reason` is not opened by the node: it changes nothing.
6. `window.denied` is audited beside R-RW-15's two. Audit entries carry ids only, no label, since the ledger mirrors to the relay.
7. An enrolling connection's bound is calls (`enrollCallsMax` 1200), not bytes queued. That bounds what a window that reads nothing can hold, at about 600 KB.

## Residuals

- `kl.window.list` has no phone nonce (R-RW-14 lists none), so a relay can replay an older list to its phone, or answer null. R-F5-20 solved this for leases. Worth asking at the security review.
- An enrolling window's request survives its connection until it lapses: a new connection gets the same request id.
- A fleet revoke on an unreadable devices file still stages and reaches the overlay; a personal one refuses `write_failed`.
- Requests live in memory: a service restart loses them and a later answer is `unknown_request`.

## Tests

`tests/window-enrollment.test.js` plus the covering files named in the brief, `desktop-bridge-service`, `desktop-bridge-many-windows`, `window-seal`, `window-vectors`, `window-dialer`, `frontdoor-push`, `electron-boundary`, `service-profile-graph`, `mobile-android-*`: 663 tests, 658 pass, 0 fail, 5 skipped. An earlier wider run with `frontdoor-relay`, `frontdoor-window`, `egress-inventory`, `desktop-pairing*`, `mobile-*`: 980 tests, 0 fail beyond the two pins fixed here. No full `npm test`, no e2e. `generate.js --check`: `77 vectors match` (70 on this branch, not the brief's 69, plus the six and `window-enroll-code`). window-v1 `--check`: 15, unchanged. Gradle not run: no existing vector changed and the new ones are node only.

An existing test in this covering set prints `[context-assembler] Failed to embed during indexing: OpenAI API error: 401`: a real call out with a key that fails. `tests/window-enrollment.test.js` alone does not print it, so it is not from this task; not traced further.
