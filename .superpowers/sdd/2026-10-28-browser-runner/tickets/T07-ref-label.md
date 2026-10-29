---
id: T07
title: The owner approves what a ref names (ref_label, ref_changed)
status: done
merged: 29f734ef
blocked_by: [T03]
---
## Goal
- `ToolExecutor#execute`: after the `PreToolUse` hooks and before `validateParameters`, call the tool's
  optional `prepareParams(params, context)` (add the field to `Tool` in `src/tools/tool-schema.js`; only the
  four browser tools define it). For an acting call (`ACTING_ACTIONS`) whose `selector` or `target_selector`
  is a ref it sets `ref_label` (decide how a `target_selector` ref is labelled and record it) from the page's
  record (T03): role and name, one plain line by `plainLineProblem` (`src/cases/hidden-chars.js`) else
  `(name hidden: not one plain line)`, cut at 80 characters. A model's own `ref_label` is always replaced
  (or removed). A ref with no label is refused `ref_not_found` before any approval.
- The desktop approval dialog shows the label, e.g. `click ref=e15 (button "Contact seller")`: find how the
  approval's text reaches the dialog. The phone's tool approval signs and shows the params already;
  approval-v1 and its vectors unchanged.
- At run time the handler compares the element's current role and accessible name with `ref_label`; a
  difference is `{ ok: false, code: 'ref_changed' }`.
- `ref_label` in the four tools' schemas, described as set by the host.
- `allow Browser(click)` and `ownerQuote` still lift the prompt for a ref click; `ACTING_ACTIONS` and
  `browser-acting.js` unchanged.

## Spec sections
§3 C-8, §7.5 "What the owner approves", §15 bullet 1, §11 "The approval label".

## Files
- src/execution/tool-executor.js, src/tools/tool-schema.js, the four browser tool files, the approval dialog
  path, tests/browser-acting-approval.test.js

## Acceptance
§11 "The approval label": a ref click asks with `ref_label`; a model's own is replaced; a label that is not
one plain line shows hidden; renaming the button between the approval and the run gives `ref_changed`;
`allow Browser(click)` still lifts the prompt for a ref click. The existing executor and browser-acting tests
pass.
