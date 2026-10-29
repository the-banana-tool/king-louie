---
id: T05
title: relay.push config - absolute path, credential file shape check at start
status: open
blocked_by: []
---
## Goal
`parsePushConfig` refuses a relative `service_account_file`; at start the relay checks the parsed file has `type: service_account` and string `project_id`, `client_email`, `private_key`, and refuses to start naming the missing key and the path, never the contents.

## Spec sections
§8 bullet 3, §5.1 config facts.

## Files
- `src/service/config.js` (`parsePushConfig`)
- a new module under `src/frontdoor/push/` exporting a reader (file path, `{ readFile }`) that returns the parsed key object or throws a coded error naming the missing key and the path; exported for T06 (doctor) and T07 (push-test)
- `src/frontdoor/push/index.js` `defaultSenders` calls it (a small change in that function only; T02 edits `createPusher`)
- `tests/frontdoor-config.test.js` (and `tests/frontdoor-push.test.js` only for the defaultSenders call, if needed)

## Acceptance
- Relative path refused with a message naming the config key.
- Each missing field named in the error; a value from the file never appears in the error text; an unparsable file refuses without echoing contents.
- Covering tests pass (`tests/frontdoor-config.test.js`, `tests/frontdoor-push.test.js`, and any startup-checks test).
