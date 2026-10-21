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
- A wake-up runs with `denyAutoApproval: true` and no approval requester, so an
  acting browser action (`click` and the rest of `ACTING_ACTIONS`) is refused
  there: a wake-up navigates, reads, extracts and screenshots, and sends only
  through Executor jobs.
- `navigate` and `open_tab` URLs stay gated in query mode by the guard.
- Both the orient call's tool list and the judge loop's `allowedToolNames` use
  the same set: `CASE_TOOL_NAMES ∪ WAKEUP_BASE_TOOLS ∪ wakeupToolsFor(type)`.

## Interface

`src/cases/case-types/index.js` exports `wakeupToolsFor(type) → string[]`,
read from the type module's optional `wakeupTools()`; a missing hook or an
unknown type gives `[]`. The turn runner reads the case's type from
`runtime.getCase(caseId).type`.

## Out of scope

Approvals for acting actions in a wake-up, the MCP tools of configured servers
in wake-ups, and any change to `WAKEUP_BASE_TOOLS` for other types.
