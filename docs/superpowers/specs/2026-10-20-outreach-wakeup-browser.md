# Outreach wake-ups may look at the browser

Date: 2026-10-20. Owner ruling (2026-10-20): "you can drop in the look-only browser actions."

## Problem

An `outreach` case that works a messaging inbox (LinkedIn, a web mail client, a
CRM) has to read what people wrote back before it answers. Its sends already go
through Executor jobs under an envelope, which a wake-up turn may submit. But a
wake-up turn's tools are the case tools plus `WAKEUP_BASE_TOOLS` (`Read`,
`Glob`, `Grep`, `WebFetch`, `WebSearch`), so it cannot open the inbox: an
outreach case runs only while the owner is typing into its chat.

## Decision

A case type may declare extra tools for its wake-up turns. `outreach` declares
the four browser tools: `Browser`, `BrowserSession`, `BrowserPage`,
`BrowserExtract`. `general` and `software-repo` declare none.

Nothing else about a wake-up changes:

- The case-turn guard (`src/cases/executors/case-guard.js`) still limits a case
  run to the look-and-click browser actions in the `kl-cases` profile and
  refuses typing (`fill`, `type`, `press`, …) with the message that typed text
  goes through Executor submit.
- A wake-up runs with `denyAutoApproval: true`, which denies every call that
  needs approval, look-only ones included, so `ToolExecutor` treats wake-up
  browser calls itself (review fix, 2026-10-20): a look-only browser call in
  a wake-up (`caseContext.source === 'wakeup'`, an action the guard allows
  and not in `ACTING_ACTIONS`) skips the approval gate, and an acting one
  (`click` and the rest of `ACTING_ACTIONS`) is refused by policy with
  `wakeup_browser_acting` before any approver is asked, so a service node's
  phone is never asked for one. A `deny` rule and an `unsafe` tier still
  apply, with one exception (second review fix, 2026-10-20): on a service
  node the policy classifier calls every `requiresApproval` tool `unsafe` /
  `tool_requires_approval`, and that verdict does not gate a look-only
  wake-up browser call either; a `denied` tier and `unsafe` for
  `matched_always_confirm`, `dangerous_operation` or a path outside
  `allowed_roots` still do. A wake-up navigates, reads, extracts and screenshots, and sends only
  through Executor jobs.
- `navigate` and `open_tab` URLs stay gated in query mode by the guard.
- Both the orient call's tool list and the judge loop's `allowedToolNames` use
  the same set: `CASE_TOOL_NAMES ∪ WAKEUP_BASE_TOOLS ∪ wakeupToolsFor(type)`.

## Interface

`src/cases/case-types/index.js` exports `wakeupToolsFor(type) → string[]`,
read from the type module's optional `wakeupTools()`; a missing hook or an
unknown type gives `[]`. The turn runner reads the case's type from
`runtime.getCase(caseId).type`.

`src/cases/executors/case-guard.js` exports `WAKEUP_BROWSER_ACTING_REFUSAL`,
the error of the `{ success: false, deniedBy: 'policy', code:
'wakeup_browser_acting' }` refusal `ToolExecutor` gives an acting browser
action in a wake-up.

## Out of scope

Approvals for acting actions in a wake-up, the MCP tools of configured servers
in wake-ups, and any change to `WAKEUP_BASE_TOOLS` for other types.
