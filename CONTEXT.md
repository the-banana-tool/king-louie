# King Louie

A desktop and headless assistant that keeps every conversation verbatim and
works long-running tasks as cases. This glossary covers the terms that have
been pinned down so far; specs in `docs/superpowers/specs/` use them.

## Language

### History and recall

**Chat**:
A conversation held in the history store, native or imported.
_Avoid_: conversation, thread, session (for a stored conversation)

**Session**:
A transcript from outside the app — a Claude Code JSONL, a public agent
trajectory, a synthetic transcript. Importing a session produces a chat.
_Avoid_: chat (for the outside transcript), trajectory (except when naming a public dataset's own unit)

**History store**:
The system of record for chats, their messages and attachments, and the
indexes over them.
_Avoid_: chat store, chat-data

**Seq**:
A message's position in its chat, dense from 1; the number the model and the
owner see as `#412`.
_Avoid_: index, message number

**Chunk**:
The indexed unit: one piece of one message.
_Avoid_: excerpt (for the indexed unit), passage, snippet

**Excerpt**:
What the model is shown from one message: one or more of its chunks, adjacent
ones merged, under a `[#seq · sender · age]` header.
_Avoid_: chunk (for what is shown), snippet

**Tail**:
The most recent messages of a chat, shown verbatim each turn.
_Avoid_: window, recent context

**Recalled block**:
The one section per turn that holds that turn's excerpts.
_Avoid_: memory context, retrieved context

**Recall**:
Choosing, each turn, which excerpts from history the model sees.
_Avoid_: memory, retrieval (for the whole feature)

**Retrieval**:
The ranking step inside recall that scores chunks for a query.
_Avoid_: search (except for the SearchHistory tool), recall (for this step)

**Provenance**:
The record, on an assistant message, of which tail and which chunks that turn
was shown.
_Avoid_: context log, trace

**History scope**:
Which chats a chat's recall may draw from: itself, itself plus its linked
chats, or all chats.
_Avoid_: recall scope, search scope

**Linked chat**:
A chat another chat's recall may draw from; links point one way.
_Avoid_: related chat, shared chat

**Compaction summary**:
The text a harness put in place of the history it condensed; kept verbatim
when a session is imported. Recall never writes one.
_Avoid_: summary (alone), compacted history

### LongHaul (the session memory benchmark)

**LongHaul**:
The benchmark that measures, on real long agent sessions, whether a memory
system can answer a question whose evidence lies far back, and at what cost.
_Avoid_: the eval, the benchmark (in names or file paths)

**Candidate system**:
A memory system LongHaul measures through an adapter; recall is one of them.
_Avoid_: model, baseline (except for the reference adapters)

**Evidence recall**:
The fraction of a question's evidence messages that a candidate system put in
front of the model.
_Avoid_: recall (alone, for this metric)
