# LongHaul B4: the Compaction-Loss Study Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `longhaul compaction-loss` measures, for every real compaction in a session, which facts of the condensed window the summary kept, which it lost, and which lost facts the rest of the session needed.

**Architecture:** A new `src/longhaul/compaction/` folder: windows from the manifest, fact sampling inside a window, three model steps (author a fact, judge preserved, judge needed) through the existing `cachedCall`/`SpendGuard`/catalog pricing, and a run directory in the shape `run` writes. Facts and judgments quote private sessions, so their text lives under `LONGHAUL_HOME/private/`; `runs/<id>/records.jsonl` holds verdicts and numbers only. `report` and `spot-check` learn the new run kind.

**Tech Stack:** Node (CommonJS), `node:test`, `node:sqlite` through `src/history/` (BM25), existing LongHaul modules.

**Spec:** `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` §9 (the study), §6 (authoring), §8 step 4 (judge, 10% spot-check), §8.1 and B-D7 (pricing, $50 cap), §10.1 (private), §11 (reproducibility).

## Global Constraints

- Everything stays in `src/longhaul/` (B-D5); nothing outside it requires it (`tests/longhaul-boundary.test.js`).
- No network and no real model in any test: fake clients, `tests/helpers/fake-llm-server.js`, `createFakeModels()`.
- A prompt is a versioned file `src/longhaul/prompts/<name>-v1.md` registered in `PROMPTS` (`prompts.js`); never edit a released one; every hash goes in `config.json`.
- A private session needs `--send-private` before any client is built (`PRIVATE_SESSION`, the `commands/author.js:56-62` pattern); skipped for a local client and for `--dry-run`.
- Plan priced from `Catalog#price` before the first call; refuse over `--max-usd` (default 50) or unpriced without `--allow-unpriced` (`checkBudget`); `--dry-run` calls nothing; a `SpendGuard` stops at the cap; `spend.json` rewritten as the run goes; `QUOTA`/`AUTH` stop the run, exit 2 (`stopErrorFor`).
- Model replies cached under `private/model-cache/<stage>/`, so a rerun pays only for misses.
- Text from a session (facts, quotes, summaries, reasons) is written only under `LONGHAUL_HOME/private/`; never in `runs/`, `reports/`, stdout or a log. Records carry ids, seqs, verdicts, token counts, cost.
- JSONL is read with `readJsonlLines`, never `node:readline`. Sampling uses `createRng(seed)`.
- Kinds of fact (§9 step 1): `user-said`, `tool-observed`, `decision`, anchored by `ANCHOR_SENDERS` (`sampling.js`).

## Review Focus

1. A session with no `manifest.compactions`, or only empty windows (`windowToSeq < windowFromSeq`): skipped and listed in `config.json` `skipped`, not a crash and not a zero rate.
2. A model reply that names an `evidenceSeq` outside the window, or a quote not in that message: rejected (`evidence-outside-window`, `quote-not-found`), counted, never judged.
3. A fact with no later candidate message (nothing after `summarySeq` matches): `needed: 'not-needed'` with `noCandidates: true` and no model call; a needed-judge reply naming a seq it was not shown is `unparsed`.
4. A window larger than the summary-judge can be shown: the judge sees only the fact and the summary, never the window, so window size never changes the prompt; the token ratio still uses the whole window.
5. A rerun after an interrupted run (Ctrl-C, `QUOTA`): every completed call comes from the cache and the summary equals an uninterrupted run's.

---

### Task 1: Compaction windows

**Files:**
- Create: `src/longhaul/compaction/windows.js`
- Test: `tests/longhaul-compaction-windows.test.js`

**Interfaces:**
- Consumes: `loadSession(dir) → { manifest, messages, index }`, `SessionIndex#get/tokensBetween`, `estimateTokens` (`session-format.js`).
- Produces: `compactionWindows(session) → { windows: Window[], skipped: { summarySeq, reason }[] }` where `Window = { index, atSeq, summarySeq, windowFromSeq, windowToSeq, windowTokens, summaryTokens, ratio, preTokens|null, postTokens|null }`. `windowTokens = index.tokensBetween(windowFromSeq - 1, windowToSeq + 1)`, `summaryTokens = estimateTokens(summary text)`, `ratio = windowTokens / summaryTokens` (null when `summaryTokens` is 0). `preTokens`/`postTokens` from `meta.compactBoundary` of the message at `atSeq` when present. Also `summaryText(session, window) → string`.

- [ ] **Step 1: Write the failing tests** on the committed `synth-compacted` fixture: `compactionWindows` returns 2 windows, each with `windowFromSeq >= 1`, `windowToSeq < summarySeq`, consecutive windows not overlapping, `ratio > 1`; a hand-built session whose compaction has `windowToSeq < windowFromSeq` yields `skipped: [{ summarySeq, reason: 'empty-window' }]`; a manifest with no `compactions` yields `{ windows: [], skipped: [] }`; a boundary message with `meta.compactBoundary: { preTokens: 160000, postTokens: 9000 }` at `atSeq` is carried into the window.
- [ ] **Step 2: Run** `node --test tests/longhaul-compaction-windows.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `compactionWindows` and `summaryText` in `windows.js`, sorting by `summarySeq`.
- [ ] **Step 4: Run** the test — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): compaction windows from the manifest, with the window-to-summary token ratio`.

### Task 2: Sampling facts inside a window

**Files:**
- Create: `src/longhaul/compaction/sample.js`
- Test: `tests/longhaul-compaction-sample.test.js`

**Interfaces:**
- Consumes: `Window` (Task 1), `ANCHOR_SENDERS`, `SPAN_RADIUS` (`sampling.js`), `createRng`.
- Produces: `planWindowFacts(index, window, { count, seed, kinds = FACT_KINDS }) → { items: { kind, anchorSeq, spanFrom, spanTo, tokensToSummary }[], shortfall }` and `FACT_KINDS = ['user-said', 'tool-observed', 'decision']`. Anchors are messages in `[windowFromSeq, windowToSeq]` whose sender `ANCHOR_SENDERS[kind]` allows and whose text is at least 40 characters (the `MIN_ANCHOR_CHARS` value; export it from `sampling.js` rather than copying). Span = anchor ± `SPAN_RADIUS`, clipped to the window. Items are drawn round-robin across kinds from per-kind shuffled anchor lists, no anchor twice; `shortfall = count - items.length`. `tokensToSummary = index.tokensBetween(anchorSeq, window.summarySeq)`.

- [ ] **Step 1: Write the failing tests**: on `synth-compacted`, `planWindowFacts(index, windows[0], { count: 6, seed: 7 })` returns 6 items, every `anchorSeq` and span inside the window, kinds alternating while each kind has anchors; the same seed gives the same items; `count` larger than the anchors gives `shortfall > 0` and no duplicate `anchorSeq`; `kinds: ['tool-observed']` returns only `toolResult` anchors.
- [ ] **Step 2: Run** `node --test tests/longhaul-compaction-sample.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `planWindowFacts` and export `MIN_ANCHOR_CHARS` from `sampling.js`.
- [ ] **Step 4: Run** the test and `node --test tests/longhaul-sampling.test.js` — expect `# fail 0` in both.
- [ ] **Step 5: Commit** `feat(longhaul): stratified fact sampling inside a compaction window`.

### Task 3: The three prompts and their model steps

**Files:**
- Create: `src/longhaul/prompts/compaction-fact-v1.md`, `compaction-preserved-v1.md`, `compaction-needed-v1.md`
- Create: `src/longhaul/compaction/steps.js`
- Modify: `src/longhaul/prompts.js` (`PROMPTS` gains `compactionFact`, `compactionPreserved`, `compactionNeeded`), `src/longhaul/model-cache.js:21` (`STAGES` gains `compaction-fact`, `compaction-preserved`, `compaction-needed`), `src/longhaul/cost.js:18` (`ROLE_ORDER` gains `author` before `summary`)
- Test: `tests/longhaul-compaction-steps.test.js`; update `tests/longhaul-prompts.test.js` if it pins the prompt set

**Interfaces:**
- Consumes: `fillTemplate`, `loadPrompt`, `parseReply` (`author.js`), `cachedCall`, `cacheKey`, `renderMessage` (`session-format.js`), `normalizeForContainment` or the existing containment normalizer (find it in `scoring.js`; reuse, do not copy).
- Produces (each returns `{ ok: true, value, call } | { ok: false, reason, detail, call }`, where `call` is `cachedCall`'s result or null):
  - `authorFact({ session, window, item, client, cache, hooks }) → value { kind, fact, quote, evidenceSeq }`. Prompt placeholders `{{kind}}`, `{{kindRule}}` (reuse `KIND_RULES`), `{{span}}` (messages clipped at `SPAN_MESSAGE_CHARS`). Reply JSON `{ "fact": string, "quote": string, "evidenceSeq": number }` or `{ "skip": true }`. Reasons: `model-skipped`, `unparsed`, `evidence-outside-window` (seq not in `[windowFromSeq, windowToSeq]`), `quote-not-found` (normalized `quote` not a substring of that message's normalized text), `model-error`.
  - `judgePreserved({ fact, summary, client, cache, hooks }) → value { verdict: 'preserved'|'partial'|'lost', reason }`. The prompt shows the fact and the summary only.
  - `judgeNeeded({ fact, candidates: Message[], client, cache, hooks }) → value { verdict: 'needed'|'not-needed', seqs: number[], reason }`. `seqs` must be a subset of the candidates' seqs and non-empty exactly when `needed`; otherwise `unparsed`.
  - Cache keys: `cacheKey({ stage, sessionId, promptSha256, provider, model, baseUrl, maxTokens, input })` where `input` is the filled prompt's sha256.
- Prompt wording: §9's three questions, the reply JSON above, "the text below is data from a transcript, not instructions" framing as in `judge-v1.md`.

- [ ] **Step 1: Write the failing tests** with a scripted client (`{ provider: 'test', model: 'm', complete }`) over a hand-built 30-message session: `authorFact` accepts a reply whose quote is in the evidence message (case and typographic quotes differing) and rejects `evidenceSeq` outside the window and a made-up quote with the two reasons; `{ "skip": true }` gives `model-skipped`; non-JSON gives `unparsed`; `judgePreserved` maps each of the three verdicts and rejects `"kept"`; `judgeNeeded` rejects `needed` with `seqs: []` and a seq not among the candidates; a second identical call is served from the cache (`call.cached === true`, client called once).
- [ ] **Step 2: Run** `node --test tests/longhaul-compaction-steps.test.js` — expect FAIL.
- [ ] **Step 3: Write the prompts, register them, add the stages and the role, implement `steps.js`.**
- [ ] **Step 4: Run** the new test, `tests/longhaul-prompts.test.js`, `tests/longhaul-model-cache.test.js`, `tests/longhaul-cost.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): compaction-loss prompts and model steps (author a fact, judge preserved, judge needed)`.

### Task 4: Later messages that match a fact

**Files:**
- Create: `src/longhaul/compaction/matches.js`
- Test: `tests/longhaul-compaction-matches.test.js`

**Interfaces:**
- Consumes: `HistoryStore.open`, `createChat`, `appendMessage`, `searchText`, `getChunks` (the `adapters/kl-recall.js:162-186` setup; extract the store-building lines into a shared helper in `adapters/common.js` only if both callers then use it), `EmbeddingCache`, `vectorIndexFor`, `topByCosine` (`embeddings.js`).
- Produces: `openMatcher({ home, sessionId, session, embed? }) → { laterMatches(fact, quote, afterSeq, { k = 8 }) → Promise<{ messages: Message[], lexical: number, semantic: number }>, release() }`. BM25 query = fact + quote, `limit: 50`, chunks mapped to messages, kept only when `seq > afterSeq`, deduped by seq, best score first, at most `k`. With `embed: { provider, model }` and a complete cache for the session, cosine hits (`k: 50`) are fused in by alternating ranks with the BM25 list; the query vector comes from the cache's question embedding path if the fact text is not cached, else semantic is skipped and `semantic: 0`. Without `embed`, lexical only. The temp store lives in `home.tmp/kl-compaction-<pid>-*` and `release()` removes it.

- [ ] **Step 1: Write the failing tests** on a temp `LONGHAUL_HOME` and a hand-built session: a fact whose distinctive token ("ledgerport-7731") appears at seq 5 and seq 40 with `afterSeq: 20` returns only seq 40; `afterSeq` past every match returns `messages: []`; `k: 1` returns one; `release()` removes the temp dir; a session with no embedding cache and `embed` passed returns `semantic: 0` without throwing.
- [ ] **Step 2: Run** `node --test tests/longhaul-compaction-matches.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `openMatcher`.
- [ ] **Step 4: Run** the test and `node --test tests/longhaul-kl-recall.test.js` if `common.js` changed — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): later-message matching for the compaction-loss study`.

### Task 5: The `compaction-loss` command

**Files:**
- Create: `src/longhaul/compaction/study.js`, `src/longhaul/commands/compaction-loss.js`
- Modify: `src/longhaul/cli.js` (`COMMANDS`), `src/longhaul/fake-models.js` (fake replies for the three prompts)
- Test: `tests/longhaul-compaction-study.test.js`

**Interfaces:**
- Consumes: Tasks 1-4; `clientFor(ctx, values, role, deps)` (`commands/run.js:85`) for roles `author` and `judge`; `estimateCalls`, `checkBudget`, `formatEstimate`, `SpendGuard`; `newRunId`, `writeFileAtomic`, `gitCommit`; `stopErrorFor`; the SIGINT pattern of `run.js:404`.
- Produces:
  - CLI: `longhaul compaction-loss --sessions <id,...> --author-provider P --author-model M --judge-provider P --judge-model M [--author-base-url U] [--judge-base-url U] [--facts-per-window 10] [--candidates 8] [--seed 1] [--embed-provider P --embed-model M] [--max-usd 50] [--allow-unpriced] [--dry-run] [--send-private] [--fake-models]`.
  - `runCompactionStudy({ home, sessionIds, clients, options, deps }) → { runId, summary }`.
  - `runs/<id>/config.json`: `{ kind: 'compaction-loss', stage: 'B4', commit, seed, factsPerWindow, candidates, author: { provider, model }, judge: { provider, model }, embed|null, prompts: { compactionFact, compactionPreserved, compactionNeeded } (sha256), sessions: [{ sessionId, source, private, license, windows }], skipped: [{ sessionId, summarySeq?, reason }] }`. A session with no windows is skipped `no-compactions`.
  - `runs/<id>/records.jsonl`, one per sampled item: `{ sessionId, window, factId, kind, anchorSeq, status: 'judged'|'rejected'|'error', reason?, evidenceSeq?, tokensToSummary, preserved?, needed?, noCandidates?, candidateCount?, neededSeqs?, costUsd }`. No text.
  - `LONGHAUL_HOME/private/compaction/<runId>/facts.jsonl`: `{ factId, sessionId, window, kind, fact, quote, evidenceSeq, preservedReason, neededReason, neededSeqs }`.
  - `runs/<id>/summary.json`, per session and overall: `{ windows, facts, rejected, errors, preservedRate, partialRate, lostRate, neededRate, lostAndNeededRate, ratio: { median, min, max } }`. Rates are over judged facts; `lostAndNeededRate = count(lost && needed) / judged`. Also `summary.md` with the same table and `spend.json`.
  - `LONGHAUL_HOME/private/spot-checks/<runId>.jsonl`: a seeded 10% sample of judged facts (at least 1 when any are judged), each with both judgments.
  - Order of work: plan every window's items, price the plan (author: span chars; preserved: fact + summary chars; needed: fact + `candidates` × 2000 chars), refuse or print for `--dry-run`, then for each item author → preserved → needed (needed skipped with `noCandidates` when `laterMatches` is empty).
  - Exit 0 on success, 2 for `PRIVATE_SESSION`, `OVER_BUDGET`, `UNPRICED`, `QUOTA`, `AUTH`, an unknown session.

- [ ] **Step 1: Write the failing tests** with `main([...], { stdout, stderr, env })` over a temp home holding a hand-built session with two compactions, where the summary of window 1 contains fact A's quote and not fact B's, and fact B's token reappears after the summary. Use a test client whose preserved verdict is `preserved` iff the normalized quote is in the summary and whose needed verdict is `needed` iff it was shown candidates. Assert: exact `preservedRate`, `lostRate`, `lostAndNeededRate` for the hand-built facts; `records.jsonl` and `summary.json` contain neither fact text nor quote (grep the files for both strings); `facts.jsonl` under `private/` does; the session marked private without `--send-private` exits 2 `PRIVATE_SESSION` and builds no client; `--dry-run` prints the estimate and makes no call; `--max-usd 0.000001` with priced fake models exits 2 `OVER_BUDGET`; a session without compactions appears in `config.skipped`; a second run over the same home costs $0 and gives an identical `summary.json` apart from `runId`; `--fake-models` runs end to end on `synth-compacted`.
- [ ] **Step 2: Run** `node --test tests/longhaul-compaction-study.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `study.js`, the command, the fake replies, the `COMMANDS` entry.
- [ ] **Step 4: Run** the test, `tests/longhaul-smoke.test.js`, `tests/longhaul-boundary.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): longhaul compaction-loss, the study of what real compactions keep and lose`.

### Task 6: Report and spot-check for the study

**Files:**
- Create: `src/longhaul/compaction/report.js`
- Modify: `src/longhaul/report.js` (`writeReport` dispatches on `config.kind === 'compaction-loss'`; a cohort mixing kinds is refused `MIXED_RUN_KINDS`), `src/longhaul/spot-check.js` and `src/longhaul/commands/spot-check.js` (show a compaction item: fact, quote, evidence message, summary, both verdicts; keys as for the judge sample, `y` agrees with both)
- Test: `tests/longhaul-compaction-report.test.js`, add cases to `tests/longhaul-spot-check.test.js`

**Interfaces:**
- Consumes: Task 5's `summary.json`, `records.jsonl`, `config.json`, spot-check file; `loadRun`, `csv`, `writeFileAtomic`.
- Produces: in `reports/<id>/`: `compaction-loss.csv` (one row per session plus `all`: windows, facts, rejected, preserved, partial, lost, needed, lost-and-needed rates, median ratio), `compaction-loss.tex` (the same table), `report.md` with the table, the run ids, models and prompt hashes, and spot-check agreement when reviewed. `--public` still refuses a private session (`PRIVATE_IN_PUBLIC`).

- [ ] **Step 1: Write the failing tests**: a report over the Task 5 test run has the exact rates in its CSV and TeX; regenerating it twice is byte-identical; `--public` over a private session exits 2; a cohort of one answer-stage run and one compaction run exits 2 `MIXED_RUN_KINDS`; `spot-check --run <compaction run>` with scripted input `y` records agreement and the report shows it.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them plus `tests/longhaul-report.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): report and spot-check the compaction-loss study`.

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (LongHaul section: one bullet for `compaction-loss`, its outputs and where the private text goes), `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (§13: B4's study marked built, with the interpretation of "verification" below), `src/longhaul/cli.js` usage if it lists commands by hand.

- [ ] **Step 1: Write the docs.** In the spec, record: facts are verified mechanically (evidence inside the window, quote found in the evidence message) and by the 10% human spot-check of both judgments, not by reviewing every fact in `verify`.
- [ ] **Step 2: Run** `npm test` once for the stage — expect `# fail 0`.
- [ ] **Step 3: Commit** `docs(longhaul): the compaction-loss study`.

## Owner decisions (2026-11-09)

1. **Verification of facts:** mechanical checks plus the 10% human spot-check of both judgments, not a review of every fact (Task 7 records it in the spec).

## Known limits (said in the spec and the report)

- The synthetic fixture's summaries are filler, so no fixture has ground truth for "preserved"; the hand-built test sessions pin the arithmetic, the owner's spot-check pins the judge.
- "Needed" sees only the later messages that match lexically (and semantically when the session is embedded); a later dependency phrased with none of the fact's words is missed, which makes `lostAndNeededRate` a lower bound.
