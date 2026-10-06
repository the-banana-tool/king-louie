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
edits or rejects. `verify --web` shows the same review as a local browser
page: the server binds 127.0.0.1 only, every API call carries a random per-run
token from the printed URL's fragment, other `Host` headers are refused, and
the page loads nothing from the network, so the session never leaves the
machine. Accepted questions get `verifiedBy`. Only verified questions
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

**B0 addendum (2026-09-30, amended by H3): `kl-recall-vec` is an H3 probe
with a hosted embedder; with `--embed-provider local` it measures what H3
ships.** `kl-recall-vec` (and `kl-recall-vec-only`, cosine
without BM25) is `kl-recall` plus a vector list fused by the retriever's
reciprocal rank fusion (recall spec §6.3 steps 2 and 3), with vectors from a
hosted embedder (OpenAI `text-embedding-3-small`) cached by `longhaul embed`
under `LONGHAUL_HOME/private/embeddings/`. It measures how much a strong
off-the-shelf semantic signal adds over BM25, so H3 can size its investment
in a local embedder. With its hosted embedder (the default,
`--embed-provider openai`) it is never published as a result: it sends every
chunk of a session to a provider, which King Louie's recall never does. With
`--embed-provider local` (H3) it embeds with the app's own local model in the
embed worker, cached under
`LONGHAUL_HOME/private/embeddings/<session>/<org>__<name>/`; nothing leaves
the machine, it is what H3 ships (`kl-recall` is the BM25 path the app falls
back to), and it is published like `kl-recall`.

**B0 addendum (2026-09-30, amended by H3): `kl-recall-rerank` is an H3 probe
with a hosted embedder; with `--embed-provider local` it measures what H3
ships.** `kl-recall-rerank` (BM25 candidates) and
`kl-recall-vec-rerank` (BM25 fused with `kl-recall-vec`'s cached cosine
list) turn on recall spec §6.3 step 6: a local cross-encoder
(`Xenova/ms-marco-MiniLM-L-6-v2` through `@huggingface/transformers` on the
native `onnxruntime-node`, CPU) rescores the top `rerank.topM` fused
candidates and its score replaces theirs. Since H3 both are app dependencies
(`package.json`) and the cross-encoder runs in the app's embed worker; its
model downloads once into `LONGHAUL_HOME/private/models/`. Scores are
cached per question and chunk (with a hash of the exact query and chunk
text) under `LONGHAUL_HOME/private/rerank/<session>/<model>/`, so a sweep
pays the model once. Its latency includes the reranker call, which is real
CPU time on a miss and near zero on a hit; a report states which it measured.
It sizes what a reranker buys H3; the fused variant with the hosted embedder
is never published as a result; with `--embed-provider local` it is
published like `kl-recall`.

**B3 addendum (2026-09-30): `kl-recall-whole` is a new adapter.** It is
`kl-recall` with whole small messages and tool pairing on
(`completeMessageTokens` 800, `pairToolMessages` true, winning over
`--recall`). B0 measured that these raise evidence recall (0.352 to 0.494)
but leave answer containment flat, so only answer accuracy can decide them;
each answer-stage run prints the paired `whole-messages` comparison. It is
a candidate configuration of the system under test, published like
`kl-recall`. Three rulings on the table above: `full-history` is capped at
what the answer model's catalog window holds (128K estimated tokens when the
catalog does not know it), as "fits the model's window" says, and may run in
an evidence-only run (no model, 128K); `real-compaction` shows the latest
real summary before `askAtSeq`, not every summary, since after a compaction
Claude Code's own context held only that latest summary (it was written
from a context that held the one before); and an adapter's setup cost (the
summaries of `summarize-compact`) is recorded once per (adapter, session),
in `spend.json` and the summary's `setup`, not per question as §8 step 5
lists.

**Addendum (2026-10-04): `kl-recall-jev-rerank` and
`kl-recall-vec-jev-rerank` rerank with typesafe.ai's Jev,** the opt-in
hosted reranker the app ships as `rerank.kind: 'jev'` (recall spec §6.3
step 6), on the app's own client (`TypesafeProvider`) and scorer: batched
by default (`--jev-mode pointwise` for one request per pair), the model
pinned to `jev-1.13.0` (`--jev-model`; a response naming another model stops
the run, so cached scores never mix versions). The key comes from
`TYPESAFE_AI_KEY`. Scores are cached under
`LONGHAUL_HOME/private/rerank/<session>/<model>-<mode>/`. A private session
needs `--send-private`; a run whose estimate is over `--jev-max-tokens`
(20M) is refused before any request. Jev is not in the model catalog, so
its cost is reported as input tokens with the price unknown. In the answer
stage and its dry run they are cache-only (`JEV_SCORES_MISSING` on a miss):
the evidence-only run with the same settings comes first.

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

**B3 addendum (2026-09-30).** Measured context sizes change B-D7's estimate:
the budget-sized adapters show about 12K estimated tokens a question
(`kl-recall` p90 13.1K), but `full-history` at its 128K cap and
`real-compaction` (up to one compaction window: session E compacted about
every 275K tokens, so after the 128K cap an estimated 60K to 128K a
question, not yet measured) are 5 to 10 times that. At 150 questions,
`full-history` alone is about 18M input tokens: $36 at $2 per million and
$72 at $4. `run --long-context-sample N` therefore gives the long-context
adapters the first N questions of the stratified sample (every prefix of it
is stratified), and the dry run prices the choice before anything is sent.
The cache that makes reruns free lives under `LONGHAUL_HOME/private/model-cache/`,
shared by every run, not under `runs/<id>/cache/` (§11): its entries are model
text about private sessions, and a crashed run's replacement has a new id.
`real-compaction` skips a session without recorded compactions (listed in
`config.json`). `summarize-compact` compacts every 10K estimated tokens by
default, which keeps its context at the other adapters' budget. The
estimate is a close bound, not a guarantee (dense text runs under 3
characters a token); a spend guard stops the run at the cap and does not
reset within it, and `spend.json` is rewritten as the run goes. The judge's
cache key is the hash of the prompt as sent, and `config.json` records a
hash of the kind rules beside `judge-v1.md`'s. A report series is one
adapter configuration (its `describe()` hash) at one tier, answer model,
judge model and commit. Follow-up questions (one asked after an earlier
answer in the same run) are not a kind in B3; they belong to a later stage.

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
| A model call is refused for credit or quota (HTTP 402; OpenAI 429 `insufficient_quota`; Anthropic 400 "credit balance is too low" or 402 `billing_error`) | Not retried: the run stops like a refused key (`QUOTA`, exit 2; in the answer stage `spend.json` has `stoppedBy: 'QUOTA'`), for answer, judge, summarizer and Jev calls; nothing is cached for the failed call, so a rerun finishes from the cache. A plain rate limit (429) is still retried. |
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

## 18. First results (stage B3, 2026-10-02, corrected 2026-10-06)

The owner's private set: four real sessions (0.17M to 2.5M estimated tokens),
138 verified questions (111 answerable, 27 `abstain`). Numbers only; nothing
from the sessions is in this section. One question is about 0.01 of a rate,
so differences under 0.02 are noise. The judge is `anthropic/claude-haiku-4-5`
in both tiers; the owner reviewed its samples on 2026-10-06 (96 of 96 grid
judgments and 63 of 63 frontier judgments) and agreed with every verdict,
so the accuracies below stand. Two of the judge's `incorrect` verdicts were
strict on form (a thousands separator in a byte count, a folder path before a
file name) and were kept as the owner's own verdicts too. Report
`b3-2026-10` in `LONGHAUL_HOME/reports/` holds the full tables.

The first runs (2026-10-02 and -03) had 103 answerable and 35 `abstain`
questions. Reviewing the recall adapters' wrong abstains showed that 8 of the
35 were mislabelled: the value asked for was in a tool result before
`askAtSeq`, and the authoring model (and the owner's review, which reads the
prose) had judged "not in the session" from the prose alone. They were
relabelled `tool-observed` on 2026-10-06 (`verifiedBy: human:sb`, the old
files kept beside them) and both tiers were rerun from the answer cache
(runs `20261006T072303Z-9951` and `20261006T073342Z-3495`); only the
relabelled questions were re-judged, plus the recall adapters' answers, whose
cache key changed with the rerank settings. The 8 spot-check rows that touch
relabelled questions are not reviewed yet. Lesson for §7: an abstain question
needs a search of the tool results, not only the prose, before it is accepted.

Grid tier, `openai/gpt-6-luna` answers (not open-weight: no key for the
`deepseek-v4-flash` endpoint of §8.1 was available; a second grid series on it
costs about $6), 138 questions per adapter:

| Adapter | Answer accuracy | Abstain accuracy | Evidence recall | Median context tokens |
|---|---|---|---|---|
| `kl-recall` (BM25, shipped tail) | 0.748 | 0.815 | 0.405 | 12.5K |
| `kl-recall-vec` (the shipped H3 path, local MiniLM vectors) | 0.739 | 0.852 | 0.459 | 12.6K |
| `kl-recall-whole` | 0.739 | 0.741 | 0.532 | 12.3K |
| `sliding-window` | 0.306 | 0.926 | 0.239 | 11.7K |
| `summarize-compact` (every 10K tokens) | 0.297 | 0.889 | 0.164 | 6.5K |
| `real-compaction` (124 questions) | 0.569 | 0.864 | 0.441 | 108K |
| `oracle` | 0.820 | 1.000 | 1.000 | 2.0K |

Frontier tier, `openai/gpt-6-sol` answers; the two long-context adapters on
the first 40 questions of the stratified sample:

| Adapter | Answer accuracy (n) | Abstain accuracy | Median context tokens |
|---|---|---|---|
| `kl-recall` | 0.703 (111) | 0.852 | 12.5K |
| `sliding-window` | 0.342 (111) | 0.926 | 11.7K |
| `summarize-compact` | 0.279 (111) | 0.963 | 6.5K |
| `full-history` (capped at 128K) | 0.590 (39) | n/a (1) | 127K |
| `real-compaction` | 0.583 (36) | n/a (1) | 112K |
| `oracle` | 0.928 (111) | 0.963 | 2.0K |

Answer accuracy by distance from the evidence to the question (frontier tier):

| Adapter | <10K | 10K-50K | 50K-200K | 200K-1M | >1M |
|---|---|---|---|---|---|
| `kl-recall` | 0.923 | 0.739 | 0.542 | 0.652 | 0.600 |
| `sliding-window` | 0.962 | 0.348 | 0.042 | 0.174 | 0.000 |
| `summarize-compact` | 0.731 | 0.435 | 0.083 | 0.000 | 0.000 |
| `full-history` | 1.000 | 0.857 | 0.750 | 0.400 | 0.000 |
| `real-compaction` | 1.000 | 0.833 | 0.857 | 0.400 | 0.000 |
| `oracle` | 0.962 | 0.913 | 0.875 | 0.913 | 1.000 |

What these say:
- Recall at about 12.5K tokens answers more than twice what a sliding window
  of the same size does, and 0.11 to 0.18 more than a 128K context of the
  newest history or of the session's own compaction summaries. Beyond 200K
  tokens back, everything but recall and the oracle is at or near zero.
- The oracle rises from 0.820 to 0.928 with the stronger answer model while
  `kl-recall` does not (0.748, 0.703): the gap is evidence that was not found,
  not reading ability. Retrieval is the place to spend effort.
- Local vectors raise evidence recall (0.405 to 0.459) and containment but
  not answer accuracy on this set (0.748 against 0.739, noise).
- Whole messages (`kl-recall-whole`): 0.739 against 0.748 on the corrected
  set (0.748 against 0.738 before the relabel). Noise either way:
  `completeMessageTokens` and `pairToolMessages` stay off (recall spec §6.7).
- Abstain accuracy was reported as the weak spot of recall (0.657 grid, 0.714
  frontier on the first runs). Most of that was the 8 mislabelled questions:
  on the corrected set recall declines 0.82 to 0.85 of the questions it
  should, against 0.93 for a sliding window that sees less, and the oracle's
  0.96 to 1.00. What remains is real but small: with a recalled block in
  view the model answers about one in six of the questions it should decline.
- 37 of the 40 `full-history` contexts and 13 of the 36 `real-compaction`
  contexts were cut at the 128K cap, a stated limit of those two rows.

Spend against the estimate (the dry-run bound), to calibrate the next plan:
first runs, grid $3.73 of $5.84 (64%); frontier $27.72 of $40.80 (68%) over
two invocations, the second filling 109 answers that failed when the provider
account ran out of credit. A quota refusal arrives as HTTP 429 and was retried
and recorded per item like a rate limit; it now stops the run as a refused
key does (`QUOTA`, §15). The corrected reruns, from the cache: grid $0.67 of
$1.75; frontier $13.75 of $23.70, most of it re-answering `kl-recall` on
`gpt-6-sol` because its adapter configuration (and so its cache key) had
gained the rerank settings. The frontier rerun needs the summarizer named
(`--summarizer-provider openai --summarizer-model gpt-6-luna`), or the plan
prices 500 new summaries on the answer model ($49).
