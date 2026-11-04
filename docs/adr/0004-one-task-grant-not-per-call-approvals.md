# A task runs under one grant; per-call approvals cover only what is outside it

A task (one piece of work a client hands the fleet: "find a dentist for my child within 45 minutes
of Lakeside") is run by one node's own agent loop, and before its first action the node's model
proposes a scope from the task text: sites, tool classes, duration and a spend cap (at least $2,
editable). The host builds the card from that proposal and the owner approves it with one press, on
screen when the task came from the local window, on the paired phone when it came from anywhere else.
Inside the grant the task acts without asking; an action outside it (another site, a login, a shell, a
payment) is one more approval of its own, never a refusal: the owner's rule is that King Louie has no
"never" list of its own, anything questionable is asked on the phone, and only the node's configured
deny rules stop a call outright (a match on a tool's dangerous patterns goes to the phone too; the owner's
own repeated denials and the runaway-loop guardrails do stop calls, since they act on what the owner
already said no to); a scope with no acting class (read, search, summarise) needs no press
at all. This generalises the demo-take lease, which
refuses outside its scope so a recording never stalls; a task may wait. The alternative, today's one
approval per acting browser action, makes a web search cost dozens of presses and so would push an
owner to blanket allow-rules that lift the gate for good; the cost accepted is that a model proposes the
scope the owner approves, so the card must be host-built and the proposal shown whole, as the envelope
card is (2026-11-03, grilling session Q5, Q9, Q10, Q20, Q21, Q26).
