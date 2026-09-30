# LongHaul: a Session Memory Benchmark — Design Spec

- **Status:** Scope agreed with the owner 2026-09-25; the §17 questions were
  answered 2026-09-29 (B-D5 to B-D10). Terms follow `CONTEXT.md`: a
  **session** is the outside transcript, and importing it produces a **chat**.
- **Date:** 2026-09-25
- **Relates to:** `2026-09-25-chat-history-recall-design.md` (the recall spec). The
  benchmark is the primary artifact; the recall system is its reference
  implementation and first candidate. The benchmark reuses the recall spec's
  session format, importers and store, and needs two small additions to it
  (§12).

## 1. Goal

Measure, on real long agent sessions, whether a memory system can answer a
question asked at a point in the session whose evidence lies far back, and at
what cost in tokens, latency and CPU. Make "I told you that 300 messages ago"
a number: recall as a function of distance, per system, per kind of fact.

Two things are measured that no existing benchmark measures:

1. **Memory over naturally occurring, tool-heavy agent sessions.** Real
   sessions of millions of tokens where most bytes are tool calls and
   results, with questions anchored at a moment in the session rather than
   asked after it ends.
2. **What compaction actually forgot.** Real sessions carry their real
   compaction summaries. For each one, the benchmark asks which facts from the
   condensed window survived, and which of those were needed later.

King Louie is open source. The benchmark runs without King Louie's UI, from a
CLI, against any candidate system that implements the adapter in §7. Nothing
in it may be specific to one person's sessions; private sessions are inputs
that never enter the repository.

### 1.1 Evidence

The owner's sessions, from two machines, as of 2026-09-25. Titles and
identifiers are deliberately omitted here.

| Session | Compactions | Total tokens (incl. cache reads) | Non-cached tokens | Span |
|---|---|---|---|---|
| A | 63 | 857,635,758 | 10,353,712 | 10 days |
| B | 5 | 344,730,378 | 2,970,632 | 2 days |
| C | 4 | 283,823,115 | 3,869,936 | not collected |
| D | 3 | 346,576,998 | 4,677,943 | not collected |
| E (cases and fleet program, measured directly) | 8 | not collected | ~2.2M chars/4 | 3 days |
| F, G | 5, 5 | not collected | 22 MB and 18 MB on disk | not collected |

All compactions in A to D were manual. In session E each compaction replaced
roughly 275K tokens of history with a 3 to 4K-token summary; prose was 8% of
bytes, tool inputs and results 64% (recall spec, Appendix A.2). Sessions A to
D are not on the machine this spec was written on, which is why §10 defines a
file-drop path.

### 1.2 Positioning

| Benchmark | Data | Length | Tool use | Time-anchored questions | Cost metered | Released |
|---|---|---|---|---|---|---|
| LoCoMo (2024) | synthetic dialogue | ~26K tokens | no | no | no | yes |
| LongMemEval (ICLR 2025) | synthetic multi-session dialogue | up to ~113K+ | no | partly (session order) | no | yes |
| BEAM (ICLR 2026) | generated dialogue | 128K to 10M | no | no | no | yes |
| MERIT (Sept 2026) | constructed episodic tool-use tasks | episodes | yes | task-level | yes, per operation | yes |
| Mem2ActBench, MemoryAgentBench (2026) | constructed | varies | memory to action | no | partly | yes |
| **This benchmark** | **real agent sessions plus public trajectories** | **100K to 10M+** | **yes, dominant** | **yes, at message sequence** | **yes** | **public subset** |

MERIT is the nearest neighbour. It found embedding retrieval unstable across
models (task success 0.30 to 0.95) while structured stores held 0.70 to 1.00,
and that agents acted on correctly retrieved values only 55% of the time. Those
are cautions this benchmark must be able to reproduce or contradict on real
sessions, which is why §8 separates evidence recall from answer correctness.

Sources: LoCoMo and LongMemEval as cited in the recall spec Appendix A.5;
BEAM https://arxiv.org/abs/2510.27246 ; MERIT https://arxiv.org/abs/2609.05441 ;
Mem2ActBench https://aclanthology.org/2026.acl-long.370.pdf (abstract only);
MemoryAgentBench via https://mem0.ai/blog/state-of-ai-agent-memory-2026 .

### 1.3 Non-goals

- Training data. The benchmark is for evaluation; trajectories are never used
  to fine-tune anything here.
- Memory-to-action tasks (does the agent use the fact in a tool call). MERIT
  and Mem2ActBench cover that. This benchmark stops at "was the evidence in
  context, and was the answer right".
- Anonymizing private sessions for release. Code, hostnames and client names
  make it unreliable. Private sessions are private (§10).
- A hosted leaderboard. Results are files in a release.

## 2. Decisions

Settled with the owner on 2026-09-25:

| # | Decision | Consequence |
|---|---|---|
| B-D1 | The benchmark is its own spec and artifact, not a stage of the recall work | Own CLI, own stages (§13), own release; the recall spec's evaluation section defers to it |
| B-D2 | The benchmark is the problem statement; the recall system is one candidate | Adapters (§7) are first-class; the recall system has no privileged path |
| B-D3 | The owner's sessions are inputs for private runs only | File drop outside the repo; results may be published, sessions never |
| B-D4 | The public set comes from public agent trajectories plus synthetic sessions | Converters for the datasets in §10.2; licenses recorded per session |

Settled with the owner on 2026-09-29 (the §17 questions):

| # | Decision | Consequence |
|---|---|---|
| B-D5 | The benchmark is named **LongHaul** | Docs and reports use LongHaul, not King Louie. The code is `src/longhaul/`, the CLI `bin/longhaul.js`, tests `tests/longhaul-*.test.js`; `src/longhaul/` may use `src/history/` and `src/providers/`, and nothing depends on it, so it can move to its own repository |
| B-D6 | Harness code is ISC like the repo; questions and annotations are CC-BY-4.0; each converted session keeps its upstream license | The manifest's `license` is per session; a source dataset's license is checked before its converter is written |
| B-D7 | Model spend is capped at **$50 per full run** | Two answer tiers (§8.1): a cheap open-weight model answers every question for every adapter; a frontier model answers a stratified sample of 150; `full-history` runs only on that sample, capped at a 128K window; a small model judges. Estimated $25 to $35 at about 500 questions |
| B-D8 | Private sessions are never released, reviewed or not; only aggregate results from them are published | §10.1 holds; there is no release review process. The owner will export sessions A to D as raw JSONL into `$LONGHAUL_HOME/private/` |
| B-D12 | LongHaul's data lives in `LONGHAUL_HOME` (default `~/.longhaul/`): `private/`, `sessions/`, `questions/`, `runs/`, `reports/`, `tmp/` | Private transcripts are never inside the repository tree, gitignored or not; the repository holds only synthetic fixtures; LongHaul does not read King Louie's data directory |
| B-D9 | External systems (Mem0, Letta) are a follow-up, not the first release | The external adapter protocol stays in B4; Mem0 is the first external adapter after release |
| B-D10 | Venue: an arXiv preprint and a workshop paper | The public set is about 12 sessions (decided 2026-09-29), about 40 verified questions each (§6) |
| B-D11 | A thin evidence-recall slice (B0, §13) runs after recall stage H2 and before H3 | H3's choices are measured; answer and judge models are not needed for B0 |

## 3. Architecture

Under `LONGHAUL_HOME` (default `~/.longhaul/`, never inside the repository):

```
private/             private session files dropped from any machine (§10.1)
sessions/            canonical session files (§4), from importers and converters
questions/           question sets per session (§5), authored per §6
systems/             adapters (§7): kl-recall, full-history, sliding-window, summarize-compact, oracle, external
runs/                one directory per run: config, per-question records, summary (§8, §11)
reports/             tables and figures generated from runs (§11)
tmp/                 kl-recall's temporary history stores during a run; leftovers removed by the next run
```

`bin/longhaul.js` exposes `import`, `author`, `verify`, `run`,
`compaction-loss`, `report`. Everything under `src/longhaul/` is Electron-free and
depends on `src/history/` for the session store, chunker and importers, and
on `src/providers/` for the answer and judge models. A run creates a temporary
history store per session, imports the session, waits for embedding backfill
to drain, then replays questions in ascending `askAtSeq`.

## 4. Sessions

A session is a transcript from outside the app: a Claude Code JSONL transcript or
a King Louie chat export (`.json`); `import` picks the importer that recognises
the file (`src/history/importers/index.js`) and names the supported formats
when none does. LongHaul stores it in the
recall spec's message shape (`id, sender, text, timestamp, seq` plus
per-sender metadata) as JSONL, one message per line, with a manifest that
records where the session came from; a run imports it into a temporary history
store, where it becomes a chat:

```json
{
  "sessionId": "...", "source": "claude-code-jsonl | openhands | swe-agent | synthetic | king-louie",
  "sourceRef": "path or dataset id", "license": "spdx or 'private'",
  "private": true,
  "messages": 11925, "humanMessages": 717, "toolCalls": 1886,
  "estTokens": 2222605, "bytesByKind": { "user": ..., "assistant": ..., "tool_use": ..., "tool_result": ... },
  "compactions": [ { "atSeq": 3120, "summarySeq": 3121, "windowFromSeq": 1, "windowToSeq": 3119 } ],
  "span": { "from": "2026-09-22T...", "to": "2026-09-25T..." }
}
```

Compaction events are first-class. The Claude Code importer records each
`isCompactSummary` record as a `status` message with `meta.compaction = true`
and adds the event to the manifest; the condensed window is every message
since the previous compaction (or the start). Converters for public
trajectories (§10.2) produce sessions with no compactions.

Sequence numbers are the benchmark's clock. A candidate system is only ever
shown messages with `seq < askAtSeq`.

## 5. Questions

One JSONL file per session:

```json
{
  "id": "E-0042", "sessionId": "E", "askAtSeq": 8810,
  "kind": "user-said | tool-observed | decision | superseded | multi-hop | abstain",
  "question": "Which port did we settle on for the desktop bridge?",
  "answer": "18796",
  "acceptableAnswers": ["18796", "port 18796"],
  "evidenceSeqs": [4412, 4415],
  "supersededBy": null,
  "distance": { "messages": 4395, "estTokens": 812000 },
  "authoredBy": "generated | human", "verifiedBy": "human:<initials> | null",
  "notes": ""
}
```

Kinds and their rules:

| Kind | Evidence | Rule |
|---|---|---|
| `user-said` | a `user` message | The owner stated it; the answer is a quote or paraphrase. |
| `tool-observed` | a `toolResult` message | The fact appeared only in tool output (a port, a path, a count, an error string). |
| `decision` | an `assistant` or `user` message | What was decided and why; the answer includes the reason. |
| `superseded` | two or more messages | The value changed; the correct answer is the latest value before `askAtSeq`, and `supersededBy` names the later message when one exists after `askAtSeq`. |
| `multi-hop` | two messages in different places | The answer needs both. |
| `abstain` | none | The fact was never stated; the correct answer is "not in the session". |

Validity constraints, enforced by `verify`: every `evidenceSeq < askAtSeq`;
`askAtSeq` points at a `user` message (the question is asked in place of it);
`distance` is computed, not typed; a `superseded` question has at least two
evidence seqs; an `abstain` question has none. Distance buckets for reporting:
under 10K, 10 to 50K, 50 to 200K, 200K to 1M, over 1M estimated tokens.

## 6. Authoring

`author` samples evidence spans from a session and asks a model for candidate
questions per kind, with the constraints of §5 in the prompt and the span
plus 20 messages of surrounding context. Candidates are written with
`authoredBy: generated`, `verifiedBy: null`. Sampling is stratified by
distance bucket and by kind so the set is not dominated by recent prose.

`verify` walks unverified candidates in a terminal loop: shows the question,
answer, evidence messages and the message at `askAtSeq`; the reviewer accepts,
edits or rejects. Accepted questions get `verifiedBy`. Only verified questions
count in a run; `run --include-unverified` exists for smoke tests and marks
its output as such.

Targets: at least 40 verified questions per private session and per public
session, spread across kinds and distance buckets, with at least 5 `abstain`
and 5 `superseded` each. The public set aims for about 12 sessions and about
500 questions (B-D10).
These are targets for the release, not gates for the code.

## 7. Candidate systems

An adapter:

```
Adapter
  name, describe() → config
  prepare(session, { upToSeq }) → handle        // may index; billed as setup
  context(handle, { question, askAtSeq, budgetTokens }) → { text, evidenceSeqsShown, evidenceSeqsPartial, estTokens, latencyMs, cpuMs, cost }
  release(handle)
```

Built-in adapters:

| Adapter | What it does | Role |
|---|---|---|
| `kl-recall` | The recall spec's `ContextBuilder` over a temp store, with `upToSeq = askAtSeq` | The system under test |
| `full-history` | All messages under `askAtSeq` that fit the model's window, newest first | Upper bound when the session fits; the long-context baseline |
| `sliding-window` | The last N tokens | The naive baseline |
| `summarize-compact` | Replays the session; every `compactEveryTokens` calls a summarizer model to replace history with a summary, then continues; context is summary plus tail | The compaction baseline, mimicking what harnesses do |
| `real-compaction` | For sessions with real compaction events only: the real summaries plus the messages since the last one before `askAtSeq` | What the owner actually had |
| `oracle` | The evidence messages plus the tail | Upper bound on answerability |
| `external:<name>` | A subprocess speaking JSON lines over stdio | Mem0, Letta, others, later |

**B0 addendum (2026-09-30): `kl-recall-vec` is an H3 probe, not a
candidate system.** `kl-recall-vec` (and `kl-recall-vec-only`, cosine
without BM25) is `kl-recall` plus a vector list fused by the retriever's
reciprocal rank fusion (recall spec §6.3 steps 2 and 3), with vectors from a
hosted embedder (OpenAI `text-embedding-3-small`) cached by `longhaul embed`
under `LONGHAUL_HOME/private/embeddings/`. It measures how much a strong
off-the-shelf semantic signal adds over BM25, so H3 can size its investment
in a local embedder. It is never published as a result: it sends every chunk
of a session to a provider, which King Louie's recall never does, and it is
not what H3 ships.

`evidenceSeqsShown` is how an adapter reports which message sequences its
context contains; for `kl-recall` it comes from provenance, for others from
construction. It is what makes evidence recall measurable without a judge.
It lists only messages shown whole; `evidenceSeqsPartial` lists messages
shown only in part (a cut or shortened message, some of a message's chunks,
a tool call folded into the tail as one line). Both count toward the leak
check.

## 8. Runs and metrics

For each question and adapter:

1. `context` at `askAtSeq` under the run's `budgetTokens`.
2. **Evidence recall**: fraction of `evidenceSeqs` present in
   `evidenceSeqsShown` (message level, whole messages only), and the same at
   chunk level for adapters that report chunks. Evidence in
   `evidenceSeqsPartial` is not counted; it is reported apart as a partial
   count. No model call.
3. **Answer**: a fixed answer model receives the context and the question and
   must answer or say it does not know. Tokens and cost recorded from the
   provider's usage.
4. **Correctness**: a judge model scores the answer against `answer` and
   `acceptableAnswers` as correct, partial, incorrect or abstained, with a
   one-line reason. For `abstain` questions, abstaining is correct and any
   answer is incorrect. A sample of 10% of judgements per run is written to a
   file for human spot-checking; the report shows agreement when the sample
   has been reviewed.
5. Recorded per question: the four scores, `estTokens`, `latencyMs`, `cpuMs`,
   adapter cost, answer cost, judge cost, distance bucket, kind.

**Answer containment** (secondary, stage B0 onward, no model call): whether
the adapter's context text holds the answer. Both sides are normalized (NFKC,
typographic quotes and dashes to ASCII, case-folded, whitespace collapsed,
surrounding punctuation stripped from the answer). Strict: `answer` or one of
`acceptableAnswers` is a substring of the context. Tokens: strict, or every
word of the shortest answer appears inside one message of the context.
`abstain` questions are left out, as from evidence recall. Records carry
`answerContained` and `answerTokensContained` (booleans, never the text);
the summary reports both next to evidence recall, which stays the headline.
Known blind spots: a paraphrased answer (the reviewer's wording, not the
session's) is never found, so `oracle` scores below 1.0 and its containment
is the ceiling for the question set; and a short answer (a number, a word)
can be found in an unrelated message, so a hit does not prove the evidence
was shown.

Per adapter the report gives evidence recall and correctness overall, per
kind, and per distance bucket; median and p90 context tokens; median and p90
latency; total cost. The headline figure is correctness versus distance, one
line per adapter, with `oracle` and `full-history` as reference lines. A
second figure is correctness versus context tokens.

Answer model and judge model are run settings; the judge is never the
answer model.

### 8.1 Cost tiers

A full run is capped at $50 of model spend (B-D7). It has two answer tiers:

- **Grid:** every question, every adapter except `full-history`, answered by
  a cheap open-weight model (a DeepSeek V4 Flash class model, about $0.15 to
  $0.30 per million input tokens).
- **Headline sample:** a stratified sample of 150 questions (by kind and
  distance bucket, seeded) answered by a frontier model for every adapter,
  including `full-history`, whose context is capped at a 128K-token window;
  the cap is reported as a limitation.

A small model (Haiku class) judges both tiers; it sees the question, the
reference answers and the reply, not the context. The run prices its plan
from the model catalog before the first call and refuses to start when the
estimate exceeds the cap; `--max-usd` overrides it. Prompts for authoring, answering and judging are versioned
files in `src/longhaul/prompts/`, and their hashes are in every run's config.

## 9. The compaction-loss study

For each session with real compaction events, `compaction-loss`:

1. Samples facts from the condensed window: user statements, decisions and
   tool-observed values, stratified as in §6, using the authoring model with
   verification.
2. Asks the judge, for each fact, whether the real summary preserves it
   (preserved, partially, lost).
3. Asks, for each fact, whether any later message in the session depends on
   it (needed, not needed), by showing the judge the fact and the later
   messages that lexically or semantically match it, with the same
   verification loop.
4. Reports, per session and overall, the preserved rate, the lost-and-needed
   rate, and the token ratio of window to summary.

This is the one part of the benchmark that only real sessions can provide.
Its outputs contain fragments of the private sessions and are private unless
the session is public.

## 10. Data sources and privacy

### 10.1 Private sessions

`$LONGHAUL_HOME/private/` (B-D12) is outside the repository. Session files
dropped there from any machine are imported with `private: true` and
`license: private`. Nothing under it is ever copied into the repository, into
a release, or into a report that leaves the machine; `report --public` refuses
sessions marked private. `bin/longhaul.js` refuses a `LONGHAUL_HOME` inside a
git working tree. Only synthetic fixtures are committed.

### 10.2 Public sessions

Converters under `src/longhaul/converters/` for, at least:

- `nebius/SWE-agent-trajectories` (80,036 SWE-agent runs) https://huggingface.co/datasets/nebius/SWE-agent-trajectories
- `nebius/SWE-rebench-openhands-trajectories` (OpenHands runs with serialized tool calls) https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories
- `nvidia/Open-SWE-Traces` (200K+ SWE-agent and OpenHands runs) https://huggingface.co/datasets/nvidia/Open-SWE-Traces
- `SWE-Gym/OpenHands-SFT-Trajectories` https://huggingface.co/datasets/SWE-Gym/OpenHands-SFT-Trajectories
- `thoughtworks/agentic-coding-trajectories` https://huggingface.co/datasets/thoughtworks/agentic-coding-trajectories (to be checked for human-in-the-loop sessions, which are the closest public analogue to the owner's)

Each converter maps steps to `user`, `assistant`, `toolUse` and `toolResult`
messages and records the dataset's license in the manifest. Single
trajectories are shorter than the owner's sessions, so the converter can
concatenate consecutive trajectories from the same repository into one
session, marked `constructed: true` in the manifest with the boundaries
listed. Questions that cross a boundary are allowed and flagged.

### 10.3 Synthetic sessions

A generator produces small sessions with planted facts of every kind at
controlled distances, for CI and for sanity-checking adapters. Three such
sessions and their questions are committed under `tests/fixtures/longhaul/`.

### 10.4 Release

A release is a directory: public sessions, their verified questions, the run
configs, per-question records and the report, plus a `DATASHEET.md`
describing sources, licenses, authoring and verification. The dataset license
is an open question (§17).

## 11. Reproducibility

- Every run directory has `config.json` with the adapter configs, the answer
  and judge models, prompt hashes, budget, seed and the commit of the code.
- Sampling and authoring use a seeded RNG.
- Model outputs are cached by request hash under `runs/<id>/cache/` so a
  rerun with the same config costs nothing and a report can be regenerated.
- `report` produces Markdown tables, CSV, and a LaTeX table file, and writes
  the figures' data as CSV so any plotting tool can draw them.
- Token counts come from provider usage when a model is called and from the
  recall spec's `TokenEstimator` otherwise; the report says which.

## 12. Relationship to existing code

| Path | Change |
|---|---|
| `src/longhaul/` (new) | `session-format.js`, `manifest.js`, `questions.js`, `author.js`, `verify.js`, `adapters/*.js`, `converters/*.js`, `synthetic.js`, `run.js`, `judge.js`, `compaction-loss.js`, `report.js`, `prompts/*.md`, `index.js` |
| `bin/longhaul.js` (new) | CLI |
| `src/history/context-builder.js` | gains `upToSeq` (amendment to the recall spec §3.2): the tail and retrieval consider only messages with `seq < upToSeq` |
| `src/history/history-store.js` | `vectors(model, chatIds, { upToSeq })` and `searchText(..., { upToSeq })` |
| `src/history/importers/claude-code-jsonl.js` | records compaction events in the session manifest (§4) |
| `src/history/importers/king-louie-json.js`, `index.js` | the King Louie chat export importer and the detection order (§4) |
| `src/providers/provider-factory.js` | usable from the CLI with keys from environment variables, without the vault |
| `package.json` | `bin` entry for `longhaul`; `src/longhaul/` excluded from the Electron build |
| `CLAUDE.md` | one section: how to run a smoke benchmark on the synthetic fixtures |

Nothing in `src/ipc/`, `main.js` or the renderer changes.

## 13. Stages and order

Depends on recall stages H1 to H3 (store, BM25 recall, embedders). Each stage
gets its own implementation plan.

| Stage | Delivers |
|---|---|
| B0 | After recall H2, before H3: the session and question formats, the validator, the Claude Code compaction events, a minimal `author` (one prompt, stratified by kind and distance) and the `verify` loop, brought forward from B2, a verified question set for session E made with them, and the `kl-recall`, `sliding-window` and `oracle` adapters, scored by evidence recall only (no answer or judge model). Its pieces are the first parts of B1, B2 and B3, not throwaway code. The headline metric is always "evidence recall", never "recall" alone, which names King Louie's feature |
| B1 | Session format and manifest, question format and validator, Claude Code compaction events, synthetic generator and fixtures, CLI skeleton with `import` and `verify` |
| B2 | Authoring pipeline, verification loop, public converters for two datasets, the `constructed` concatenation |
| B3 | Adapters `kl-recall`, `full-history`, `sliding-window`, `summarize-compact`, `real-compaction`, `oracle`; `run`, judge, caching, `report` |
| B4 | Compaction-loss study, external adapter protocol, remaining converters, release packaging and datasheet |

## 14. Testing

`node --test` under `tests/longhaul-*.test.js`:

- format and validator: every constraint in §5, including rejections.
- Claude Code importer: compaction events and windows from a synthetic
  fixture with two compactions.
- synthetic generator: planted facts are recoverable by `oracle` at 100%.
- adapters: `sliding-window` and `full-history` respect `askAtSeq` and budget;
  `kl-recall` never shows a message with `seq >= askAtSeq` (the leakage test);
  `summarize-compact` calls the summarizer at the right points, using a fake
  provider.
- run and judge: with fake answer and judge providers, the per-question
  records and the report's numbers are exactly computable; the 10% spot-check
  sample is written.
- report: tables regenerate byte-identically from cached records.
- privacy: `report --public` refuses a run containing a private session;
  nothing under `$LONGHAUL_HOME/private/` is read by `import` unless asked;
  a `LONGHAUL_HOME` inside a git working tree is refused.
- cost: a run whose priced plan exceeds the cap refuses to start.
- CI smoke: `longhaul run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle --fake-models`.

## 15. Error handling

| Failure | Behaviour |
|---|---|
| A converter meets a record it cannot map | The step is kept as a `status` message with the raw record in `meta`, counted in the manifest as `unmapped`; the session is still usable. |
| Embedding backfill does not drain within `prepareTimeoutMs` | The run records the fraction embedded and continues; the report flags it. |
| Answer or judge call fails | Retried three times; then the question is recorded as `error` and excluded from rates, with the count shown. |
| Judge returns an unparseable verdict | Recorded as `error`, same as above. |
| A question fails validation | `run` refuses the whole set and names the question; `verify` fixes it. |
| Private data in a public report | Refused before any file is written. |

## 16. Assumptions made without asking

- The benchmark lives in this repository under `src/longhaul/` with its own CLI,
  rather than in a separate repository, because it shares the store,
  chunker and importers. It can be split out later.
- Sequence number is the only clock; wall-clock timestamps are recorded but
  not used to anchor questions.
- `askAtSeq` always points at a user message.
- Public trajectories may be concatenated into constructed sessions, marked
  as such.
- The judge is a model with a 10% human spot-check, not full human grading.
- Correctness, not answer style, is scored; a verbose correct answer is
  correct.
- The `summarize-compact` baseline compacts on a token interval, not on the
  provider's window, so it is comparable across models.
- Distance buckets are in estimated tokens, since that is what a budget is
  set in.
- Added 2026-09-29 to enforce B-D7 and B-D12: a run prices its plan from the
  catalog and refuses to start over the cap (`--max-usd` overrides);
  `longhaul` refuses a `LONGHAUL_HOME` inside a git working tree; the
  headline sample is 150 questions; `src/longhaul/` is left out of the
  Electron build.

## 17. Open questions for the owner

Answered 2026-09-29; see B-D5 to B-D10 in §2. The original questions:

1. Name of the benchmark and the dataset, and the organisation it is released
   under.
2. Dataset license for the public release, and whether the code license
   (ISC, as the repo) applies to the harness.
3. Budget for the answer and judge models per full run, which sets how many
   questions and adapters a run can include. A rough order: 1,200 questions ×
   6 adapters × (one answer call plus one judge call) at 8K context each.
4. How many private sessions you can supply, and whether the sessions on the
   other machine can be exported as raw JSONL.
5. Whether external systems (Mem0, Letta) are in the first release or a
   follow-up.
6. Whether any private session could be released after review, or none.
7. The target venue, which sets the deadline and the size of the public set.
