# Management surfaces are MCP-first; the questions sidebar is removed

Case and fleet management (answering questions, creating cases, revoking envelopes, cancelling jobs,
running runbooks) is one tool surface defined once and served to the front door, `king-louie-service mcp`
and King Louie's own chat, so any MCP client with a grant — ChatGPT included — can manage a fleet, and the
app is never the only place an act can be done. The Questions section of the sidebar was removed rather
than kept alongside: a case's question is a message in the case's chat, answered in words that a model
relays with the owner's verbatim `quote` (host-checked in the app, recorded over MCP; `user` provenance
either way, with the channel recorded), while approvals, money, direction and a case's status take only a
button in that message or a phone signature and are never served over MCP. The cost accepted is a model
in the loop for spoken answers, one turn of latency when a turn is already running, and public OAuth
scopes (`cases:answer`, `cases:manage`) that are hard to take back; the alternatives were a parallel UI
kept in sync with the tools, or a front door that stays read-only and cannot manage anything
(2026-09-30, `docs/superpowers/specs/2026-09-30-management-surfaces.md`; supersedes ruling T16-Q2's
withheld `cases:write`).
