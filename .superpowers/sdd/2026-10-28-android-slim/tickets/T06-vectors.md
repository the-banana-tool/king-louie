---
id: T06
title: approval-v1 (49) and lease-v1 (55) vectors; split phone sets
status: done (merge 8356ae42)
blocked_by: [T02, T05]
---
## Goal
Regenerate the protocol vectors with the read-key cases.

## Spec sections
§8.8, §5 (vectors bullet).

## Files
`tests/vectors/approval-v1/generate.js`, `keys.json` (`A_read`, `B_read`),
`phone-reference.js` (the read string), the new vector files;
`tests/vectors/lease-v1/generate.js` and its new files (`given.approvers[]`
entries may carry `read_key`); the node consumers of the vectors;
`tests/lease-vectors.test.js` expects 55 and splits the phone sets (iOS
consumes `PHONE`, Android consumes `PHONE` plus the read-key vectors). New
vectors name `node` and `android` only.

## Acceptance
`node tests/vectors/approval-v1/generate.js --check` says `49 vectors match`;
the lease-v1 `--check` says 55; the node vector tests pass; the 41 and 51
existing files are unchanged; iOS's filters untouched.
