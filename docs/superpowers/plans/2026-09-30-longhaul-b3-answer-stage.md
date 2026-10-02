# LongHaul B3: The Answer Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score LongHaul's candidate systems by answer accuracy. A candidate model answers each question from each adapter's context. A judge model grades the reply against the reference answers, and `abstain` questions are scored on whether the model declines. The stage adds the `full-history`, `summarize-compact` and `real-compaction` adapters, a cost plan priced before any call and capped, cached calls that resume after a crash, the grid and frontier tiers, and `longhaul report`.

**Architecture:** The B0 pipeline (adapter, context, record) stays as it is, and a run with an answer model adds a second pass. Pass 1 builds every context locally with no model call and writes its text to a temp dir under `LONGHAUL_HOME/tmp`. The planned model calls are then priced from the catalog (`Catalog#price`) and checked against `--max-usd` before anything is sent. Pass 2 makes the summarizer, answer and judge calls through a content-keyed cache under `LONGHAUL_HOME/private/model-cache/`, so an interrupted run resumes and pays nothing for calls that already finished. Records keep ids, verdicts and numbers only. The texts (replies, verdict reasons, summaries, and the 10% spot-check sample) stay under `private/`. `longhaul report` turns runs' records into aggregate tables, which can be published.

**Tech Stack:** Node 22+, `node:test`. Model calls use the existing providers through `createModelClient` and `oneShot`, so every request goes through `BaseProvider.request`. Prices come from the models catalog (`Catalog#price`), and `kl-recall` uses `node:sqlite` through `HistoryStore`.

**Spec:** `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md`: stage B3 in §13; §7 (adapters and the probe addenda), §8 and §8.1 (metrics, judge, cost tiers), §10 (privacy), §11 (reproducibility), §14, §15 and §16; decisions B-D7, B-D8 and B-D12. Also the recall spec `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md` §6.1 to §6.4 and §6.7, and the measured facts in `.superpowers/sdd/plans-2026-09-30-measured-facts.md`. Read the measured facts first: every default below argues from them.

**Execution order (ruled 2026-09-30, shared with the H3 plan `docs/superpowers/plans/2026-09-30-history-h3-embeddings.md`):** H3 Tasks 1–14 → B3 Tasks 1–16 → H3 Tasks 15–16 → B3 Task 17. B3 Tasks 9, 11 and 12 rewrite `scoring.js`'s `renderSummaryMarkdown`, `run.js` and `commands/run.js` whole; H3 Task 15 is written against B3's `run.js` structure (`runEvidenceOnly` / `runAnswerStage`) and edits those functions afterwards, so neither plan loses the other's change. B3 Task 12 already carries H3's `--embed-provider` option and USAGE text, and B3 Task 11 exports `makePrivate` from `tests/helpers/longhaul-helpers.js`, which H3 Task 15 imports.

## Global Constraints

- Tests use node's built-in runner, one file per task: `node --test tests/<file>.test.js`. Never `jest`. Look for `# fail 0` in the TAP summary.
- The full `npm test` is currently broken on `main` for reasons unrelated to LongHaul (owner, 2026-09-30). Each task runs only its own test files. Task 16 runs the full suite only if it is green on `main` by then; otherwise it runs `tests/longhaul-*.test.js` plus `tests/electron-boundary.test.js`, and the task's report says which it ran.
- Unit tests never touch the network. Use a scripted fake client, `tests/helpers/fake-llm-server.js`, or the built-in `--fake-models`. Price with the fixture catalog (`tests/helpers/models-fixture.js` `fixtureCatalog()`: `openai/gpt-6-lite` $0.3/$1 and `anthropic/claude-haiku-4-5` $1/$5 per million tokens).
- Prices come only from `Catalog#price`, through `priceCall` in `src/longhaul/cost.js` (Task 4) or through a provider's `llmMetrics.costUsd`. An unknown price is `null`, never `$0`. The only thing priced at $0 is a client marked `local: true`, which means the built-in fake models.
- Every provider request goes through `BaseProvider.request`: LongHaul calls models only through `createModelClient` (`src/longhaul/model.js`) and never calls `fetch` itself.
- `src/longhaul/` stays Electron-free, and nothing outside it requires it (`tests/longhaul-boundary.test.js`). Library code logs through `createLogger` (`src/logging.js`), never bare `console.*`. No log line and no record carries session, question, reply or summary text; they carry ids, codes and numbers.
- A model call that carries text from a private session needs `--send-private`. That covers the answer call (its context), the judge call (question and references) and the summarizer (its window). Without the flag the run refuses (exit 2, code `PRIVATE_SESSION`) before any client is used. `--dry-run` makes no call and needs no flag.
- The cap is $50 per run (B-D7, `DEFAULT_MAX_USD`), and `--max-usd` overrides it. The estimate is a close bound, backstopped by the spend guard, not a guarantee: input at 3 characters a token, plus any input not yet written (a judge's reply, a summary's previous summary) at its call's `maxTokens`, and output at `maxTokens`. Dense text (code, JSON, non-English) can run under 3 characters a token, and a provider can bill reasoning or output beyond what the plan assumed, so a real bill can exceed it. A run over the cap refuses before any call (exit 2, `OVER_BUDGET`). While a run is going, the spend guard reserves each call's own estimate (prompt characters / 3, output at `maxTokens`) before it goes out, settles it at the real cost, and stops at the cap; once tripped it never resets within that run, and every later call is recorded as `over-budget`.
- The answer model's window bounds the long-context adapters: `full-history` and `real-compaction` are capped at what the answer model's catalog context (`Catalog#get(p, m).limits.context`) holds after the reply and the prompt's own text, and at 128K estimated tokens when the catalog does not know the window (Task 11 `contextCapTokens`). An overflow would be a 400 recorded as an error, which would bias long-context accuracy.
- Private text lives only under `LONGHAUL_HOME/private/`: `model-cache/`, `spot-checks/`, and B0's `embeddings/` and `rerank/`. Context texts go to `LONGHAUL_HOME/tmp/kl-ctx-<runId>/` and are removed when the run ends. `removeStaleTmp` removes a dir that a crash left behind.
- Fixtures, tests and docs use invented values only (codenames from word lists, ports 18000 to 18999, `*.example.com` hosts). Never read `~/.longhaul`, `~/.claude` or the owner's raw exports.
- CLI output stays ASCII. Exit codes: `0` success, `1` failure (a leak, or a run stopped at the cap), `2` usage error or refusal.
- The metric names are **answer accuracy** (answerable questions judged `correct`), **abstain accuracy** (abstain questions judged `abstained`) with its complement, the **false-answer rate**, **evidence recall** (never "recall" alone) and **answer containment**. One question is about 0.01 of a rate on this set, so differences under 0.02 are noise.
- Estimated tokens are `ceil(chars / 4)` (`estimateTokens`). Answer and judge tokens come from provider usage. The report says which is which (spec §11).

## Review Focus

1. **A run interrupted part way (Ctrl-C, a crash, a key revoked mid-run) and started again.** Expected: every call that finished is a cache hit and is never paid for twice. The restart's plan counts the finished budget-sized answers and judgments as cached and prices only the misses, but `summarize-compact`'s answers and judgments are priced in full on every plan (their contexts do not exist before its summaries are made; only its cached summaries drop out), so its part of the estimate does not shrink on a restart. `spend.json` is on disk from the first call and rewritten after every answered item and every `summarize-compact` setup, with `stoppedBy` naming a stop, and the temp contexts do not pile up. Tests: Task 2 (`cachedCall` resumes, hooks see only misses) and Task 11 (a 401 on the seventh call leaves `spend.json` with `stoppedBy: 'AUTH'`, then a rerun makes only the remaining calls; a summarizer's refused key also stops with `AUTH`).
2. **A judge that answers in prose, in a fenced block, or with a verdict not on the list.** Expected: fenced JSON parses. Prose or an unknown verdict is recorded as `judge-unparsed`, left out of the rates and counted in `errors`. The raw reply stays cached, so a better parser re-reads it for free. Tests: Task 3 (`parseVerdict`), Task 10 (`answerAndJudge`), Task 9 and Task 11 (excluded and counted).
3. **A question whose reference answer paraphrases its evidence.** This covers 40% of the verified set, including all 7 `decision` questions, which score 0 on containment. Expected: the judge grades meaning, not wording, and a decision needs its reason. A record can have containment `false` and still count as correct. Tests: Task 3 (the paraphrase and decision rules are in the judge prompt, and every acceptable answer is shown) and Task 9 (containment 0 with accuracy 1).
4. **The estimate under-counting,** above all for the judge, whose input includes a reply not yet written, and for summaries, whose input includes the previous summary. Expected: on text at about 4 characters a token (the fixtures, prose) the estimate does not fall below what the run spends, even when every reply fills `maxTokens`; on denser text it can, and the spend guard stops the run at the cap. Tests: Task 4 (`extraInputTokens` is counted; a tripped guard stays tripped), Task 8 (a later summary is counted at `maxTokens`), and Task 11 (a fake run whose replies fill `maxTokens` spends no more than the estimate, judge line included).
5. **A private session run without `--send-private`.** Expected: the run refuses before any client is used, nothing reaches the network, no run dir is written, and `--dry-run` still works. Tests: Task 11 (`runBenchmark`: the clients are never called) and Task 12 (the CLI against `fake-llm-server`: 0 requests, exit 2).

---

## B0 seams this plan builds on

These names are the ones on `main` (ccc46a7), read from the code:

| Where | Name and shape | B3 use |
|---|---|---|
| `src/longhaul/run.js` | `runBenchmark({ home, dataRoot, sessionIds, adapterNames, adapterConfig, adapters, budgetTokens, seed, includeUnverified, now, commit })` returning `{ runId, dir, config, summary, records, leaks, staleTmpRemoved }`. Internal: `loadRunSet({ dataRoot, sessionIds, includeUnverified })` gives `{ sets: [{ session, questions, verified, questionsSha256 }], skipped }` with questions sorted by `askAtSeq`. `scoreOne({ runId, adapter, handle, session, q, budgetTokens })` gives a record. `newRunId(date)`. Exported: `gitCommit`, `removeStaleTmp(tmpDir, prefix)`, `KL_TMP_PREFIX = 'kl-'` | Gains `answer` (Task 11). `scoreOne` also returns the context text. Adapters that do not apply are skipped (Task 7) |
| `src/longhaul/scoring.js` | `evidenceRecall`, `chunkEvidenceRecall`, `answerContainment(text, q)` (`{ strict, tokens }` or null for abstain), `normalizeText`, `normalizeAnswer`, `splitMessages`, `percentile`, `mean`, `summarize(records)` keyed by adapter, `renderSummaryMarkdown(config, summary)`. Internal: `rate`, `groupRecall`, `fmt`, `cell` | `summarize(records, { setupCosts })` adds `answer`, `setup` and `bySession`. New `compareAdapters` and `COMPARISONS`. `renderSummaryMarkdown(config, summary, { spend, comparisons })` (Task 9) |
| `src/longhaul/model.js` | `createModelClient({ provider, model, env, options, providerInstance })` returning `{ provider, model, complete(prompt, { maxTokens }) }`, where `complete` resolves to `{ text, llmMetrics }` through `oneShot` at temperature 0 | The answer, judge and summarizer clients. Unchanged; `commands/run.js` adds `baseUrl` to a client built with `--<role>-base-url`, so the cache keys tell endpoints apart (Task 12) |
| Provider `llmMetrics` | `{ provider, model, inputTokens, outputTokens, cachedInputTokens, ..., pricingUsage, costUsd, unpriced? }` (`BaseProvider#buildLlmCallMetrics`); `costUsd` is null when unpriced | `usageFromMetrics` (Task 2) |
| `src/models` | `getActiveCatalog()`; `Catalog#price(provider, model, { input, cachedInput, cacheWrite, output, reasoning })` returns `{ usd, parts, tier }` or null; `Catalog#get(p, m).limits.context` (null when unknown) | `Catalog#price`: `priceCall` and `SpendGuard` (Task 4). `limits.context`: the answer model's window, which caps `full-history` and `real-compaction` (Task 11 `contextCapTokens`) |
| `src/longhaul/embeddings.js` | `priceTokens(provider, model, tokens, catalog)`, and `createEmbedClient`'s internal `retryable(err)` | `retryable` moves to `retry.js` (Task 1) |
| `src/longhaul/questions.js` | `KINDS`, `BUCKETS`, `NO_BUCKET = 'none'`, `bucketFor(distance)`, `computeDistance(index, q)`, `isVerified`, `readQuestions`, `questionsFile` | Strata for the sample; kind and bucket tables |
| `src/longhaul/sampling.js` | `planAuthoring(index, { count, seed, kinds, excludeSeqs })` (authoring anchors only; no question sampler exists); internal `splitEvenly` | New `sampleQuestions` (Task 5) |
| `src/longhaul/rng.js` | `createRng(seed)` returning `{ next, int, pick, shuffle }` | Sample and spot-check selection |
| `src/longhaul/session-format.js` | `estimateTokens`, `messageText`, `senderLabel`, `renderMessage` (`[#seq label]\ntext`), `renderMessages`, `CHARS_PER_TOKEN = 4`, `SessionIndex` (`get`, `maxSeq`, `userSeqs`, `tokensBetween`, `messages`), `loadSession(dir)` returning `{ manifest, messages, index }`; `manifest.compactions` is `[{ atSeq, summarySeq, windowFromSeq, windowToSeq }]`, and the summary is a `status` message with `meta.compaction === true`, labelled `compaction summary` | `real-compaction` (Task 7) |
| `src/history/importers/claude-code-jsonl.js` | Each `isCompactSummary` record becomes a `status` message with `meta.compaction: true`, and `{ atSeq: boundary seq or summarySeq, summarySeq, windowFromSeq: previous summarySeq + 1, windowToSeq: atSeq - 1 }` goes into the manifest | Source of `real-compaction`'s summaries |
| `src/longhaul/adapters/` | `createAdapter(name, config)`, `adapterNames()`; `common.js`: `TAIL_DEFAULTS { tailMessages: 8, tailTokens: 6000 }`, `measured(fn)`, `tailBefore`, `uniqueSorted`; `sliding-window.js`: `createSlidingWindowAdapter({ budgetTokens, windowTokens })`; `kl-recall.js`: `createKlRecallAdapter({ budgetTokens, recall, chunk, tmpRoot, rerankerFor })` with the name hardcoded to `kl-recall`; `oracle.js` | New `newestFirst`, and a `name` option on both (Task 6) |
| Adapter contract | `{ name, describe(), prepare(session, { upToSeq }), context(handle, { question, askAtSeq, budgetTokens }) → { text, evidenceSeqsShown, evidenceSeqsPartial, estTokens, latencyMs, cpuMs, cost, chunks? }, release(handle) }` | Optional additions: `truncated`, `compactionSeq`, `appliesTo(session)`, `skipReason`, `longContext`, `frontierOnly`, `usesModel`, `estimate(session, { upToSeq })`, `modelClient`, `handle.setup` |
| `src/longhaul/author.js` | `parseReply(text)` (the first `{` to the last `}`, with fences stripped) returns an object or null; `DEFAULT_PROMPT`; `fillPrompt` (split/join) | `parseVerdict` reuses `parseReply` |
| `src/longhaul/files.js` | `writeFileAtomic(file, contentOrWriterFn)`, `sha256File`, `sha256Text`, `isInside`, `childPath(base, name, onEscape)` | Cache entries, report files |
| `src/longhaul/home.js` | `SUBDIRS = ['private','sessions','questions','runs','reports','tmp']`, `resolveHome(env)`, `ensureDirs(home)` | `private/model-cache`, `private/spot-checks`, `reports/<id>` |
| `src/longhaul/cli.js` | `COMMANDS` name to `{ needsHome?, options, run(ctx, values, positionals, deps?) }`; `main(argv, io)`; `ctx = { home, env, stdout, stderr, stdin, now, cwd }` | New `spot-check`, `report` |
| `src/longhaul/commands/run.js` | Exports `positiveInt`, `exitCodeFor`; internal `parseRecallPairs`; `--send-private` exists (for `kl-recall-vec`) | New flags (Task 12) |
| `src/longhaul/commands/author.js` | Always plans every kind | `--kinds` (Task 15) |
| Tests | `tests/helpers/longhaul-helpers.js` (`REPO`, `FIXTURE_ROOT`, `tmpDir`, `sink`, `tmpHome`); `tests/helpers/fake-llm-server.js` (`startFakeLlmServer()`: `url`, `requests`, `close()`, always answers "Hello there"); the fixture catalog | New `makePrivate` helper (Task 11) |
| Fixtures | `tests/fixtures/longhaul/`: `synth-small` (200 messages, ~10.8K tokens, 6 questions, no compactions), `synth-medium` (1,100 messages, ~107K tokens, 9 questions), `synth-compacted` (452 messages, ~29.5K tokens, 6 questions, compactions with summaries at #151 and #302 whose text never mentions a planted fact) | `real-compaction` is testable as is: no generator change |

Two B0 tests pin the adapter registry: `tests/longhaul-adapters.test.js:155` (the exact list, and `createAdapter('full-history')` throwing) and `tests/longhaul-adapter-kl-recall.test.js:56` (the same list again). A third, `tests/longhaul-run.test.js`, expects `--adapters full-history` to exit 2. Tasks 6 to 8 update them.

## File Structure

New, under `src/longhaul/`:

| File | Responsibility |
|---|---|
| `prompts.js` | `PROMPTS`, `loadPrompt(name)` (text and SHA-256), `placeholders`, `fillTemplate` (one pass) |
| `prompts/answer-v1.md`, `prompts/judge-v1.md`, `prompts/summarize-v1.md` | The versioned prompts; their hashes go into `config.json` |
| `retry.js` | `retryable`, `isAuthFailure`, `withRetries` (three retries, spec §15) |
| `model-cache.js` | `ModelCache` (one file per call under `private/model-cache/`), `cacheKey`, `stableStringify`, `cachedCall`, `usageFromMetrics` |
| `answer.js` | `buildAnswerPrompt`, `DONT_KNOW` |
| `judge.js` | `VERDICTS`, `JUDGE_KIND_RULES`, `JUDGE_RULES_SHA256`, `buildJudgePrompt`, `parseVerdict`, `scoreVerdict`, `isRight` |
| `cost.js` | `estimateCalls`, `priceCall`, `checkBudget`, `SpendGuard`, `OverBudgetError`, `formatEstimate`, `DEFAULT_MAX_USD`, `EST_CHARS_PER_TOKEN` |
| `answer-stage.js` | `answerAndJudge`, `mapPool`, `spotCheckFile`, `writeSpotCheckSample` (Task 10); `selectQuestions`, `planCalls` (Task 11) |
| `fake-models.js` | `createFakeModels()`: local answer, judge and summarizer for `--fake-models` |
| `spot-check.js` | `reviewSpotChecks`, `agreement`, `readSpotChecks` |
| `report.js` | `loadRun`, `cohortOf`, `seriesOf`, `buildReport`, `writeReport` |
| `adapters/full-history.js`, `adapters/real-compaction.js`, `adapters/summarize-compact.js` | The three new candidate systems |
| `commands/spot-check.js`, `commands/report.js` | CLI |

Modified: `run.js`, `scoring.js`, `sampling.js`, `embeddings.js` (imports `retryable`), `adapters/{index,common,sliding-window,kl-recall}.js`, `commands/{run,author}.js`, `cli.js`, `CLAUDE.md`, the benchmark spec (a B3 addendum), `.github/workflows/test.yml`.

New tests: `tests/longhaul-prompts.test.js`, `tests/longhaul-model-cache.test.js`, `tests/longhaul-judge.test.js`, `tests/longhaul-cost.test.js`, `tests/longhaul-summarize-compact.test.js`, `tests/longhaul-answer-scoring.test.js`, `tests/longhaul-answer-stage.test.js`, `tests/longhaul-answer-run.test.js`, `tests/longhaul-answer-cli.test.js`, `tests/longhaul-spot-check.test.js`, `tests/longhaul-report.test.js`. Extended: `tests/longhaul-sampling.test.js`, `tests/longhaul-adapters.test.js`, `tests/longhaul-adapter-kl-recall.test.js`, `tests/longhaul-run.test.js`, `tests/longhaul-author.test.js`, `tests/longhaul-smoke.test.js`, `tests/helpers/longhaul-helpers.js`.

On-disk layout added by B3:

```
LONGHAUL_HOME/
  private/model-cache/<answer|judge|summary>/<key[0..1]>/<key>.json   one cached call (model text: private)
  private/spot-checks/<runId>.jsonl                                   the 10% judge sample (texts: private)
  runs/<runId>/config.json      + answer: tier, sample, models, prompt hashes, cap, estimate
  runs/<runId>/records.jsonl    + verdict, answerCorrect, abstainCorrect, tokens, costs, cached flags, answerError
  runs/<runId>/summary.json|md  + answer accuracy tables, named comparisons
  runs/<runId>/spend.json       estimate, spent, calls, unpriced calls, overBudget, setupCosts, stoppedBy (rewritten as the run goes)
  reports/<id>/                 report.md, adapters.csv, by-kind.csv, by-distance.csv, by-session.csv,
                                accuracy-vs-tokens.csv, comparisons.csv, adapters.tex
  tmp/kl-ctx-<runId>/           context texts during a run (removed at its end, or by the next run)
```

---

## Task 1: Versioned prompts and retries

**Files:**
- Create: `src/longhaul/prompts.js`, `src/longhaul/retry.js`, `src/longhaul/prompts/answer-v1.md`, `src/longhaul/prompts/judge-v1.md`, `src/longhaul/prompts/summarize-v1.md`
- Modify: `src/longhaul/embeddings.js` (use `retryable` from `retry.js`)
- Test: `tests/longhaul-prompts.test.js`

**Interfaces:**
- Consumes: `sha256Text` (`files.js`).
- Produces:
  - `prompts.js`: `PROMPTS = { answer: 'answer-v1.md', judge: 'judge-v1.md', summarize: 'summarize-v1.md', author: 'author-v1.md' }`; `loadPrompt(name) → { name, file, text, sha256 }`; `placeholders(template) → string[]` (sorted, unique); `fillTemplate(template, values) → string` (one pass; throws `prompt needs <names>` for a missing value).
  - Placeholders: answer `{{context}} {{question}}`; judge `{{acceptable}} {{kind}} {{kindRule}} {{question}} {{reference}} {{reply}}` (no context); summarize `{{maxWords}} {{messages}} {{previous}}`.
  - `retry.js`: `retryable(err) → boolean`, `isAuthFailure(err) → boolean` (401/403), `withRetries(fn(attempt), { retries = 3, baseDelayMs = 1000, wait }) → Promise` (at most 4 attempts; waits `err.retryAfterMs` when given).

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-prompts.test.js`:

```js
// tests/longhaul-prompts.test.js
// Versioned prompts (benchmark spec §8.1, §11) and retries (§15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PROMPTS, loadPrompt, placeholders, fillTemplate } = require('../src/longhaul/prompts');
const { retryable, isAuthFailure, withRetries } = require('../src/longhaul/retry');
const { sha256Text } = require('../src/longhaul/files');

describe('prompts', () => {
  it('loads each versioned prompt with the SHA-256 of its exact bytes', () => {
    for (const name of Object.keys(PROMPTS)) {
      const p = loadPrompt(name);
      assert.strictEqual(p.name, name);
      assert.strictEqual(p.file, PROMPTS[name]);
      assert.strictEqual(p.text, fs.readFileSync(path.join(__dirname, '..', 'src', 'longhaul', 'prompts', PROMPTS[name]), 'utf8'));
      assert.strictEqual(p.sha256, sha256Text(p.text));
    }
    assert.throws(() => loadPrompt('nope'), /unknown prompt/);
  });

  it('gives each prompt exactly its placeholders; the judge never sees a context', () => {
    assert.deepStrictEqual(placeholders(loadPrompt('answer').text), ['context', 'question']);
    assert.deepStrictEqual(placeholders(loadPrompt('judge').text), ['acceptable', 'kind', 'kindRule', 'question', 'reference', 'reply']);
    assert.deepStrictEqual(placeholders(loadPrompt('summarize').text), ['maxWords', 'messages', 'previous']);
  });

  it('fills in one pass, so a value holding "{{question}}" or "$&" is kept verbatim', () => {
    const out = fillTemplate('A {{context}} B {{question}}', { context: 'x {{question}} $& y', question: 'Q?' });
    assert.strictEqual(out, 'A x {{question}} $& y B Q?');
  });

  it('refuses to leave a placeholder unfilled', () => {
    assert.throws(() => fillTemplate('{{a}} {{b}}', { a: 1 }), /prompt needs b/);
  });
});

describe('withRetries', () => {
  const status = (s, extra = {}) => Object.assign(new Error(`status ${s}`), { status: s, ...extra });
  function failing(errors, value = 'ok') {
    const calls = [];
    let i = 0;
    return {
      calls,
      fn: async (attempt) => {
        calls.push(attempt);
        if (i < errors.length) throw errors[i++];
        return value;
      }
    };
  }
  const noWait = { wait: async () => {} };

  it('retries 429, 5xx and transport failures three times, then throws the last error', async () => {
    const f = failing([status(429), status(503), new TypeError('fetch failed'), status(500)]);
    await assert.rejects(withRetries(f.fn, noWait), /status 500/);
    assert.deepStrictEqual(f.calls, [1, 2, 3, 4]);
  });

  it('returns once a retry succeeds, waiting the provider\'s retry-after', async () => {
    const waits = [];
    const f = failing([status(429, { retryAfterMs: 1234 })]);
    assert.strictEqual(await withRetries(f.fn, { wait: async (ms) => { waits.push(ms); } }), 'ok');
    assert.deepStrictEqual(waits, [1234]);
  });

  it('never retries a 400 or a refused key', async () => {
    for (const s of [400, 401, 403]) {
      const f = failing([status(s)]);
      await assert.rejects(withRetries(f.fn, noWait), new RegExp(`status ${s}`));
      assert.deepStrictEqual(f.calls, [1]);
    }
    assert.strictEqual(retryable(status(404)), false);
    assert.strictEqual(retryable(new Error('socket hang up')), true);
    assert.strictEqual(isAuthFailure(status(401)), true);
    assert.strictEqual(isAuthFailure(status(500)), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-prompts.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/prompts'`.

- [ ] **Step 3: Write the three prompts**

Create `src/longhaul/prompts/answer-v1.md`:

```markdown
You are answering a question about an earlier part of a long working session between a person (the owner) and an AI agent. The context below is everything a memory system shows you from that session. It may be incomplete.

Answer from the context only. Do not guess, and do not use outside knowledge.
- If the context states the answer, give it in one or two sentences. For a value (a port, a path, a name, a count), give the value exactly.
- If the value changed during the session, give the latest value in the context.
- If the question asks what was decided, give the decision and the reason given for it.
- If the context does not contain the answer, reply exactly: I don't know.

<context>
{{context}}
</context>

Question: {{question}}
```

Create `src/longhaul/prompts/judge-v1.md`:

```markdown
You grade one reply in a benchmark of memory over long agent sessions. You see the question, the reference answer a reviewer wrote, other acceptable answers, and the reply to grade. You do not see the session.

Kind of question: {{kind}}
Rule for this kind: {{kindRule}}

Question: {{question}}
Reference answer: {{reference}}
Also acceptable: {{acceptable}}

Reply to grade:
<reply>
{{reply}}
</reply>

Verdicts:
- correct: the reply states the same fact as the reference or an acceptable answer. Wording does not matter: a paraphrase, another order, or extra correct detail is still correct. A value (a number, a path, a name) must match exactly.
- partial: the reply has part of the answer but misses a required part, such as a decision without its reason, or one of two facts the question needs.
- incorrect: the reply states a different or an outdated value, or lists several candidates of which only one is right.
- abstained: the reply declines, says it does not know, or says the context does not contain the answer.

Reply with one JSON object and nothing else:
{"verdict": "correct|partial|incorrect|abstained", "reason": "<one line>"}
```

Create `src/longhaul/prompts/summarize-v1.md`:

```markdown
You keep the running summary of a long working session between a person (the owner) and an AI agent, so that the agent can carry on after older messages are dropped. Write the new summary from the previous summary and the messages since it.

Keep what later work may need: what the owner asked for and stated, decisions and their reasons, values seen in tool output (ports, paths, names, counts, error messages), values that changed (give the latest), and open tasks. Drop chatter. Write at most {{maxWords}} words of plain text.

Previous summary:
{{previous}}

Messages since then:
{{messages}}
```

- [ ] **Step 4: Write `prompts.js`**

Create `src/longhaul/prompts.js`:

```js
'use strict';
// Versioned prompt files (benchmark spec §8.1, §11). Each is read with the
// SHA-256 of its exact bytes, and the hashes go into every run's
// config.json, so a result names the prompt that produced it. A prompt is
// never edited in place: a change is a new file (answer-v2.md) and a new
// PROMPTS entry. Placeholders are {{name}}; fillTemplate replaces them in
// one pass, so a value that itself holds "{{question}}" or "$&" (message
// text often does) is inserted verbatim.
const fs = require('fs');
const path = require('path');
const { sha256Text } = require('./files');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const PROMPTS = Object.freeze({
  answer: 'answer-v1.md',
  judge: 'judge-v1.md',
  summarize: 'summarize-v1.md',
  author: 'author-v1.md'
});
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function loadPrompt(name) {
  const file = PROMPTS[name];
  if (!file) throw new Error(`unknown prompt ${JSON.stringify(name)}`);
  const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
  return { name, file, text, sha256: sha256Text(text) };
}

function placeholders(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

function fillTemplate(template, values) {
  const missing = placeholders(template).filter((k) => !(k in values));
  if (missing.length) throw new Error(`prompt needs ${missing.join(', ')}`);
  return template
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const m = /^\{\{(\w+)\}\}$/.exec(part);
      return m ? String(values[m[1]]) : part;
    })
    .join('');
}

module.exports = { PROMPTS, PROMPTS_DIR, loadPrompt, placeholders, fillTemplate };
```

- [ ] **Step 5: Write `retry.js` and point `embeddings.js` at it**

Create `src/longhaul/retry.js`:

```js
'use strict';
// Retries for LongHaul's provider calls (benchmark spec §15: an answer or
// judge call is retried three times, then recorded as an error). A 429, a
// 5xx or a transport failure is retried with exponential backoff, or after
// the provider's retry-after; anything else (a 400, a refused key) is thrown
// at once.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(err) {
  if (!err) return false;
  if (err.status === 429 || (Number.isInteger(err.status) && err.status >= 500)) return true;
  if (Number.isInteger(err.status)) return false;
  // A transport failure (fetch rejects with a TypeError): reset, DNS, timeout.
  return err.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(String(err.message || ''));
}

// A refused key: every later call would fail the same way, so a run stops.
function isAuthFailure(err) {
  return Boolean(err) && (err.status === 401 || err.status === 403);
}

async function withRetries(fn, { retries = 3, baseDelayMs = 1000, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !retryable(err)) throw err;
      const delay = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      await wait(delay);
    }
  }
}

module.exports = { retryable, isAuthFailure, withRetries };
```

In `src/longhaul/embeddings.js`, delete the local `function retryable(err) { ... }`: the whole function, from the line `function retryable(err) {` through its closing `}` (eight lines, just before the `// embedder: an object with embed(inputs, { model })` comment). Keep `const sleep = ...`, which `createEmbedClient` still uses. Add this after the `const { UsageError } = require('./errors');` line:

```js
const { retryable } = require('./retry');
```

`createEmbedClient` keeps its own loop (six attempts) and now calls the shared `retryable`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-prompts.test.js tests/longhaul-embed.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/prompts.js src/longhaul/retry.js src/longhaul/prompts/answer-v1.md src/longhaul/prompts/judge-v1.md src/longhaul/prompts/summarize-v1.md src/longhaul/embeddings.js tests/longhaul-prompts.test.js
git commit -m "feat(longhaul): versioned answer, judge and summarize prompts; shared retries"
```

---

## Task 2: The model cache

**Files:**
- Create: `src/longhaul/model-cache.js`
- Test: `tests/longhaul-model-cache.test.js`

**Interfaces:**
- Consumes: `writeFileAtomic`, `sha256Text` (`files.js`); `withRetries` (Task 1).
- Produces:
  - `stableStringify(value) → string` (object keys sorted at every level, undefined values dropped).
  - `cacheKey(parts) → sha256 hex` (hash of `stableStringify({ cacheVersion: 1, ...parts })`).
  - `class ModelCache { constructor(root); static forHome(home) (root home.private/model-cache); file(stage, key); get(stage, key) → entry|null; put(stage, key, entry) }`. The stages are `answer`, `judge` and `summary`, and the key must be 64 hex characters.
  - `usageFromMetrics(llmMetrics) → { inputTokens, outputTokens, costUsd }`, with null where unknown.
  - `cachedCall({ cache, stage, key, client, prompt, maxTokens, hooks, retry, meta, clock }) → { text, inputTokens, outputTokens, costUsd, latencyMs, cached }`. `hooks = { beforeCall({ stage, client, promptChars, maxTokens }) → ticket, afterCall(ticket, usage), cancel(ticket) }` is called only on a miss. A hit returns the numbers stored when the call was made, with `cached: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-model-cache.test.js`:

```js
// tests/longhaul-model-cache.test.js
// Cached model calls (benchmark spec §11): a rerun costs nothing, and a run
// cut off mid-way resumes without paying for a finished call twice.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ModelCache, cacheKey, stableStringify, cachedCall, usageFromMetrics } = require('../src/longhaul/model-cache');
const { tmpDir } = require('./helpers/longhaul-helpers');

function fakeClient({ failAt = null, error = null } = {}) {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-1', prompts,
    async complete(prompt) {
      prompts.push(prompt);
      if (failAt !== null && prompts.length === failAt) throw error;
      return { text: `reply to ${prompt}`, llmMetrics: { inputTokens: prompt.length, outputTokens: 3, costUsd: 0.01 } };
    }
  };
}
const noWait = { wait: async () => {} };
const newCache = () => new ModelCache(path.join(tmpDir(), 'model-cache'));
const call = (cache, client, prompt, extra = {}) => cachedCall({
  cache, stage: 'answer', key: cacheKey({ prompt }), client, prompt, maxTokens: 50, retry: noWait, ...extra
});

describe('cacheKey', () => {
  it('is the same for the same parts in any key order, and differs when any part does', () => {
    assert.strictEqual(cacheKey({ a: 1, b: { c: 2, d: [1, 2] } }), cacheKey({ b: { d: [1, 2], c: 2 }, a: 1 }));
    assert.notStrictEqual(cacheKey({ a: 1 }), cacheKey({ a: 2 }));
    assert.match(cacheKey({ a: 1 }), /^[0-9a-f]{64}$/);
    assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 1, c: 0 }], u: undefined }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  });
});

describe('cachedCall', () => {
  it('calls on a miss, stores the reply under the cache root, and answers a repeat from the cache for nothing', async () => {
    const cache = newCache();
    const client = fakeClient();
    const first = await call(cache, client, 'p1');
    assert.deepStrictEqual({ ...first, latencyMs: 0 }, { text: 'reply to p1', inputTokens: 2, outputTokens: 3, costUsd: 0.01, latencyMs: 0, cached: false });
    const again = await call(cache, client, 'p1');
    assert.strictEqual(again.cached, true);
    assert.strictEqual(again.text, 'reply to p1');
    assert.strictEqual(again.costUsd, 0.01, 'a hit reports what the reply cost when it was made');
    assert.strictEqual(client.prompts.length, 1);
    const key = cacheKey({ prompt: 'p1' });
    assert.ok(fs.existsSync(path.join(cache.root, 'answer', key.slice(0, 2), `${key}.json`)));
  });

  it('resumes a run cut off mid-way: finished calls are hits, only the rest are made', async () => {
    const cache = newCache();
    const crash = Object.assign(new Error('unauthorized'), { status: 401 });
    const first = fakeClient({ failAt: 3, error: crash });
    for (const p of ['p1', 'p2']) await call(cache, first, p);
    await assert.rejects(call(cache, first, 'p3'), /unauthorized/);
    const second = fakeClient();
    for (const p of ['p1', 'p2', 'p3', 'p4']) await call(cache, second, p);
    assert.deepStrictEqual(second.prompts, ['p3', 'p4']);
  });

  it('asks the spend hooks only on a miss, and settles or cancels what it reserved', async () => {
    const cache = newCache();
    const log = [];
    const hooks = {
      beforeCall: ({ promptChars, maxTokens }) => { log.push(['before', promptChars, maxTokens]); return 7; },
      afterCall: (ticket, usage) => log.push(['after', ticket, usage.costUsd]),
      cancel: (ticket) => log.push(['cancel', ticket])
    };
    await call(cache, fakeClient(), 'p1', { hooks });
    await call(cache, fakeClient(), 'p1', { hooks });
    const bad = fakeClient({ failAt: 1, error: Object.assign(new Error('bad request'), { status: 400 }) });
    await assert.rejects(call(cache, bad, 'p2', { hooks }), /bad request/);
    assert.deepStrictEqual(log, [['before', 2, 50], ['after', 7, 0.01], ['before', 2, 50], ['cancel', 7]]);
  });

  it('retries a 429 inside one call and stores one entry', async () => {
    const cache = newCache();
    const client = fakeClient({ failAt: 1, error: Object.assign(new Error('slow down'), { status: 429 }) });
    assert.strictEqual((await call(cache, client, 'p1')).cached, false);
    assert.strictEqual(client.prompts.length, 2);
    assert.strictEqual((await call(cache, client, 'p1')).cached, true);
  });

  it('treats an unreadable entry as a miss and calls again', async () => {
    const cache = newCache();
    const key = cacheKey({ prompt: 'p1' });
    fs.mkdirSync(path.dirname(cache.file('answer', key)), { recursive: true });
    fs.writeFileSync(cache.file('answer', key), '{"torn":');
    const client = fakeClient();
    assert.strictEqual((await call(cache, client, 'p1')).cached, false);
    assert.strictEqual(client.prompts.length, 1);
  });

  it('refuses an unknown stage or a key that is not a SHA-256', () => {
    const cache = newCache();
    assert.throws(() => cache.file('other', cacheKey({})), /stage/);
    assert.throws(() => cache.file('answer', '../x'), /SHA-256/);
  });

  it('lives under LONGHAUL_HOME/private', () => {
    const cache = ModelCache.forHome({ private: path.join('H', 'private') });
    assert.strictEqual(cache.root, path.join('H', 'private', 'model-cache'));
  });
});

describe('usageFromMetrics', () => {
  it('keeps the provider usage and the catalog cost, and never turns an unknown cost into 0', () => {
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 }), { inputTokens: 10, outputTokens: 2, costUsd: 0.5 });
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 10, outputTokens: 2, costUsd: null, unpriced: true }), { inputTokens: 10, outputTokens: 2, costUsd: null });
    assert.deepStrictEqual(usageFromMetrics(null), { inputTokens: null, outputTokens: null, costUsd: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-model-cache.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/model-cache'`.

- [ ] **Step 3: Write the implementation**

Create `src/longhaul/model-cache.js`:

```js
'use strict';
// Cached model calls (benchmark spec §11: model outputs are cached by request
// hash, so a rerun with the same config costs nothing and a report can be
// regenerated). One JSON file per call under
// LONGHAUL_HOME/private/model-cache/<stage>/<key[0..1]>/<key>.json, written
// atomically once the call returns. A run cut off mid-way resumes: every call
// that finished is a hit, and only a call in flight when it stopped is made
// again. Entries hold model text (answers, verdict reasons, summaries of
// private sessions), so the cache is shared by every run but lives under
// private/, not runs/<id>/, and nothing here logs text.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, sha256Text } = require('./files');
const { withRetries } = require('./retry');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/model-cache');
const STAGES = Object.freeze(['answer', 'judge', 'summary']);
const CACHE_VERSION = 1;
const KEY_RE = /^[0-9a-f]{64}$/;
const NO_HOOKS = Object.freeze({ beforeCall: () => 0, afterCall: () => {}, cancel: () => {} });

// JSON with object keys sorted at every level and undefined values dropped,
// so a key never depends on the order its parts were written in.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function cacheKey(parts) {
  return sha256Text(stableStringify({ cacheVersion: CACHE_VERSION, ...parts }));
}

class ModelCache {
  constructor(root) {
    this.root = root;
  }

  static forHome(home) {
    return new ModelCache(path.join(home.private, 'model-cache'));
  }

  file(stage, key) {
    if (!STAGES.includes(stage)) throw new Error(`unknown model-cache stage ${JSON.stringify(stage)}`);
    if (!KEY_RE.test(String(key))) throw new Error('a model-cache key is a SHA-256 hex digest');
    return path.join(this.root, stage, key.slice(0, 2), `${key}.json`);
  }

  get(stage, key) {
    const file = this.file(stage, key);
    if (!fs.existsSync(file)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      return entry && entry.key === key && typeof entry.text === 'string' ? entry : null;
    } catch {
      log.warn('unreadable model-cache entry; the call is made again', { stage });
      return null;
    }
  }

  put(stage, key, entry) {
    writeFileAtomic(this.file(stage, key), `${JSON.stringify({ ...entry, stage, key })}\n`);
  }
}

// One call's usage: tokens as the provider reported them and the catalog
// cost from llmMetrics, null where unknown (an unpriced model is never $0).
function usageFromMetrics(m) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!m) return { inputTokens: null, outputTokens: null, costUsd: null };
  return { inputTokens: num(m.inputTokens), outputTokens: num(m.outputTokens), costUsd: num(m.costUsd) };
}

const resultOf = (entry, cached) => ({
  text: entry.text,
  inputTokens: entry.inputTokens ?? null,
  outputTokens: entry.outputTokens ?? null,
  costUsd: entry.costUsd ?? null,
  latencyMs: entry.latencyMs ?? null,
  cached
});

// One model call through the cache. A hit spends nothing and returns what
// the reply cost when it was made (a report's cost is what the result cost
// to produce; spend.json has what this run paid). A miss asks the hooks
// (the spend guard) first, retries 429/5xx/transport failures, then stores
// the reply before returning it.
async function cachedCall({ cache, stage, key, client, prompt, maxTokens, hooks = NO_HOOKS, retry = {}, meta = {}, clock = () => Date.now() }) {
  const hit = cache.get(stage, key);
  if (hit) return resultOf(hit, true);
  const ticket = hooks.beforeCall({ stage, client, promptChars: prompt.length, maxTokens });
  const t0 = clock();
  let reply;
  try {
    reply = await withRetries(() => client.complete(prompt, { maxTokens }), retry);
  } catch (err) {
    hooks.cancel(ticket);
    throw err;
  }
  const entry = {
    text: String(reply?.text ?? ''),
    ...usageFromMetrics(reply?.llmMetrics),
    latencyMs: clock() - t0,
    provider: client.provider,
    model: client.model,
    maxTokens,
    meta
  };
  cache.put(stage, key, entry);
  hooks.afterCall(ticket, entry);
  return resultOf(entry, false);
}

module.exports = { STAGES, ModelCache, cacheKey, stableStringify, usageFromMetrics, cachedCall };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/longhaul-model-cache.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/model-cache.js tests/longhaul-model-cache.test.js
git commit -m "feat(longhaul): model cache under private/, resumable after a crash"
```

---
## Task 3: The answer prompt and the judge

**Files:**
- Create: `src/longhaul/answer.js`, `src/longhaul/judge.js`
- Test: `tests/longhaul-judge.test.js`

**Interfaces:**
- Consumes: `fillTemplate`, `loadPrompt` (Task 1); `parseReply` (`author.js`); `KINDS` (`questions.js`).
- Produces:
  - `answer.js`: `DONT_KNOW = "I don't know"`; `NOTHING_SHOWN` (the text an empty context is replaced with; Task 10's answer key includes it); `buildAnswerPrompt(template, { context, question }) → string`.
  - `judge.js`: `VERDICTS = ['correct', 'partial', 'incorrect', 'abstained']`; `JUDGE_KIND_RULES` (one line per kind); `JUDGE_RULES_SHA256` (the SHA-256 of every string `judge.js` splices into a judge prompt: the kind rules and the no-reference, no-other-answers and empty-reply texts; `config.json` records it next to `judge-v1.md`'s hash, Task 11); `buildJudgePrompt(template, { question, reply }) → string` (no context); `parseVerdict(text) → { verdict, reason } | null`; `scoreVerdict(question, verdict) → { answerCorrect, abstainCorrect }` (one of the two is null); `isRight(record) → boolean` (`correct` for answerable, `abstained` for abstain).

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-judge.test.js`:

```js
// tests/longhaul-judge.test.js
// The answer prompt and the judge (benchmark spec §8 steps 3 and 4). The
// judge grades meaning, not wording, never sees the context, and scores an
// abstain question on declining.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadPrompt } = require('../src/longhaul/prompts');
const { buildAnswerPrompt, DONT_KNOW } = require('../src/longhaul/answer');
const { VERDICTS, JUDGE_KIND_RULES, JUDGE_RULES_SHA256, buildJudgePrompt, parseVerdict, scoreVerdict, isRight } = require('../src/longhaul/judge');
const { KINDS } = require('../src/longhaul/questions');

const answerPrompt = loadPrompt('answer').text;
const judgePrompt = loadPrompt('judge').text;
const q = (extra = {}) => ({
  id: 'synth-x-001', kind: 'decision',
  question: 'What did we decide to use for amber-heron, and why?',
  answer: 'SQLite, because it needs no server',
  acceptableAnswers: ['SQLite, because it needs no server', 'SQLite'],
  ...extra
});

describe('answer prompt', () => {
  it('holds the context and the question, and tells the model how to decline', () => {
    const p = buildAnswerPrompt(answerPrompt, { context: '[#12 user]\nUse SQLite for amber-heron.', question: q() });
    assert.ok(p.includes('<context>\n[#12 user]\nUse SQLite for amber-heron.\n</context>'));
    assert.ok(p.includes('Question: What did we decide to use for amber-heron, and why?'));
    assert.ok(p.includes(DONT_KNOW));
  });

  it('says so when the adapter showed nothing', () => {
    assert.ok(buildAnswerPrompt(answerPrompt, { context: '  ', question: q() }).includes('(the memory system showed nothing)'));
  });
});

describe('judge prompt', () => {
  it('has a rule for every kind, and hashes every string it splices into a prompt', () => {
    assert.deepStrictEqual(Object.keys(JUDGE_KIND_RULES).sort(), [...KINDS].sort());
    assert.match(JUDGE_RULES_SHA256, /^[0-9a-f]{64}$/);
  });

  it('shows the question, the reference, the other acceptable answers and the reply, never a context', () => {
    const p = buildJudgePrompt(judgePrompt, { question: q(), reply: 'We went with SQLite since no server is needed.' });
    assert.ok(p.includes('Reference answer: SQLite, because it needs no server'));
    assert.ok(p.includes('Also acceptable: "SQLite"'));
    assert.ok(p.includes('<reply>\nWe went with SQLite since no server is needed.\n</reply>'));
    assert.ok(p.includes(`Rule for this kind: ${JUDGE_KIND_RULES.decision}`));
    assert.ok(!p.includes('<context>'));
  });

  it('grades meaning, not wording, and a decision needs its reason', () => {
    assert.match(judgePrompt, /Wording does not matter: a paraphrase/);
    assert.match(JUDGE_KIND_RULES.decision, /without its reason is partial/);
    assert.match(JUDGE_KIND_RULES.decision, /even when an acceptable answer lists the decision alone/);
    assert.match(JUDGE_KIND_RULES.superseded, /earlier value is incorrect/);
  });

  it('gives an abstain question no reference to match', () => {
    const p = buildJudgePrompt(judgePrompt, { question: q({ kind: 'abstain', answer: 'not in the session', acceptableAnswers: [] }), reply: "I don't know." });
    assert.ok(p.includes('Reference answer: (none: the fact is never stated in the session)'));
    assert.ok(p.includes('Also acceptable: (none)'));
    assert.ok(p.includes(JUDGE_KIND_RULES.abstain));
  });

  it('marks an empty reply', () => {
    assert.ok(buildJudgePrompt(judgePrompt, { question: q(), reply: '' }).includes('<reply>\n(empty reply)\n</reply>'));
  });
});

describe('parseVerdict', () => {
  it('reads a JSON verdict, fenced or bare, in any case', () => {
    assert.deepStrictEqual(parseVerdict('{"verdict": "correct", "reason": "same choice and reason"}'), { verdict: 'correct', reason: 'same choice and reason' });
    assert.deepStrictEqual(parseVerdict('```json\n{"verdict":"PARTIAL","reason":"no reason given"}\n```'), { verdict: 'partial', reason: 'no reason given' });
  });

  it('returns null for prose, an unknown verdict or no JSON at all', () => {
    assert.strictEqual(parseVerdict('The reply is correct.'), null);
    assert.strictEqual(parseVerdict('{"verdict": "right"}'), null);
    assert.strictEqual(parseVerdict('{"reason": "x"}'), null);
    assert.strictEqual(parseVerdict(''), null);
  });

  it('keeps the reason to one line of at most 300 characters', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'incorrect', reason: `a\n${'b'.repeat(400)}` }));
    assert.strictEqual(v.reason.includes('\n'), false);
    assert.strictEqual(v.reason.length, 300);
  });

  it('knows the four verdicts of spec §8', () => {
    assert.deepStrictEqual([...VERDICTS], ['correct', 'partial', 'incorrect', 'abstained']);
  });
});

describe('scoreVerdict', () => {
  it('counts only correct as right on an answerable question', () => {
    assert.deepStrictEqual(scoreVerdict(q(), 'correct'), { answerCorrect: true, abstainCorrect: null });
    for (const v of ['partial', 'incorrect', 'abstained']) assert.deepStrictEqual(scoreVerdict(q(), v), { answerCorrect: false, abstainCorrect: null });
  });

  it('counts only abstained as right on an abstain question; any answer is a false answer', () => {
    const a = q({ kind: 'abstain' });
    assert.deepStrictEqual(scoreVerdict(a, 'abstained'), { answerCorrect: null, abstainCorrect: true });
    for (const v of ['correct', 'partial', 'incorrect']) assert.deepStrictEqual(scoreVerdict(a, v), { answerCorrect: null, abstainCorrect: false });
    assert.strictEqual(isRight({ kind: 'abstain', verdict: 'abstained' }), true);
    assert.strictEqual(isRight({ kind: 'decision', verdict: 'partial' }), false);
    assert.strictEqual(isRight({ kind: 'decision', verdict: 'correct' }), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-judge.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/answer'`.

- [ ] **Step 3: Write `answer.js`**

Create `src/longhaul/answer.js`:

```js
'use strict';
// The answer call (benchmark spec §8 step 3): the answer model sees the
// adapter's context and the question, answers from the context alone, or
// says it does not know (prompts/answer-v1.md).
const { fillTemplate } = require('./prompts');

const DONT_KNOW = "I don't know";
// Spliced into the prompt instead of an empty context, so it is part of the
// answer's cache key (answer-stage.js answerKey) as well as answer-v1.md.
const NOTHING_SHOWN = '(the memory system showed nothing)';

function buildAnswerPrompt(template, { context, question }) {
  const text = String(context ?? '').trim() ? String(context) : NOTHING_SHOWN;
  return fillTemplate(template, { context: text, question: question.question });
}

module.exports = { DONT_KNOW, NOTHING_SHOWN, buildAnswerPrompt };
```

- [ ] **Step 4: Write `judge.js`**

Create `src/longhaul/judge.js`:

```js
'use strict';
// The judge (benchmark spec §8 step 4): a model other than the answer model
// grades one reply against the reference answer and the acceptable answers
// as correct, partial, incorrect or abstained, with a one-line reason
// (prompts/judge-v1.md). It sees the question, the references and the reply,
// never the context: less of a private session leaves the machine and each
// call stays small. It grades meaning, not wording: 40% of the verified
// answers are paraphrases of their evidence (recall spec §6.7), all the
// decision questions among them. For an abstain question only "abstained" is
// right; any other verdict is a false answer.
const { fillTemplate } = require('./prompts');
const { parseReply } = require('./author');
const { sha256Text } = require('./files');

const VERDICTS = Object.freeze(['correct', 'partial', 'incorrect', 'abstained']);
const JUDGE_KIND_RULES = Object.freeze({
  'user-said': 'The owner stated this fact earlier in the session. A reply that states the same fact in other words is correct.',
  'tool-observed': 'This fact appeared in tool output (a port, a path, a count, an error string). Values must match exactly; the words around them need not.',
  decision: 'The reference gives a decision and the reason for it. correct needs both, in any wording; the decision without its reason is partial, even when an acceptable answer lists the decision alone.',
  superseded: 'The value changed during the session; only the latest value (the reference) is correct. The earlier value is incorrect.',
  'multi-hop': 'The answer combines two facts from different places; only the final answer the question asks for must match.',
  abstain: 'The fact was never stated in the session, so the right reply declines. Use abstained when the reply declines or says it does not know; use incorrect when it states any answer. Never use correct or partial for this kind.'
});
const NO_REFERENCE = '(none: the fact is never stated in the session)';
const NO_OTHER_ANSWERS = '(none)';
const EMPTY_REPLY = '(empty reply)';
// These strings are part of every judge prompt but not of judge-v1.md, so
// the file's hash alone does not name the prompt a verdict came from.
// config.json records this hash beside it, and the judge's cache key is the
// hash of the rendered prompt (answer-stage.js judgeKey), so editing any of
// them makes new keys. Insertion order is fixed here, so JSON.stringify is
// stable.
const JUDGE_RULES_SHA256 = sha256Text(JSON.stringify({
  kindRules: JUDGE_KIND_RULES, noReference: NO_REFERENCE, noOtherAnswers: NO_OTHER_ANSWERS, emptyReply: EMPTY_REPLY
}));
const REASON_MAX = 300;

function buildJudgePrompt(template, { question, reply }) {
  const abstain = question.kind === 'abstain';
  const others = abstain ? [] : [...new Set((question.acceptableAnswers || []).filter((a) => a !== question.answer))];
  return fillTemplate(template, {
    kind: question.kind,
    kindRule: JUDGE_KIND_RULES[question.kind],
    question: question.question,
    reference: abstain ? NO_REFERENCE : question.answer,
    acceptable: others.length ? others.map((a) => JSON.stringify(a)).join('; ') : NO_OTHER_ANSWERS,
    reply: String(reply ?? '').trim() || EMPTY_REPLY
  });
}

// { verdict, reason } from the judge's reply, or null when it is not one
// JSON object with a known verdict (recorded as judge-unparsed, spec §15).
function parseVerdict(text) {
  const value = parseReply(text);
  if (!value) return null;
  const verdict = typeof value.verdict === 'string' ? value.verdict.trim().toLowerCase() : '';
  if (!VERDICTS.includes(verdict)) return null;
  const reason = typeof value.reason === 'string' ? value.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
  return { verdict, reason };
}

// answerCorrect for an answerable question, abstainCorrect for an abstain
// one; the other is null.
function scoreVerdict(question, verdict) {
  if (question.kind === 'abstain') return { answerCorrect: null, abstainCorrect: verdict === 'abstained' };
  return { answerCorrect: verdict === 'correct', abstainCorrect: null };
}

// Whether a judged record is right: correct on an answerable question,
// abstained on an abstain one.
function isRight(record) {
  return record.kind === 'abstain' ? record.verdict === 'abstained' : record.verdict === 'correct';
}

module.exports = { VERDICTS, JUDGE_KIND_RULES, JUDGE_RULES_SHA256, buildJudgePrompt, parseVerdict, scoreVerdict, isRight };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/longhaul-judge.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/answer.js src/longhaul/judge.js tests/longhaul-judge.test.js
git commit -m "feat(longhaul): answer prompt and judge: four verdicts, meaning over wording, abstain scored on declining"
```

---

## Task 4: Pricing the plan, the cap and the spend guard

**Files:**
- Create: `src/longhaul/cost.js`
- Test: `tests/longhaul-cost.test.js`

**Interfaces:**
- Consumes: `UsageError`; a catalog with `price(provider, model, usage)` (`getActiveCatalog()` or `fixtureCatalog()`).
- Produces:
  - `EST_CHARS_PER_TOKEN = 3`, `DEFAULT_MAX_USD = 50`.
  - `estInputTokens(chars, extraTokens = 0) → integer`.
  - `priceCall(catalog, { provider, model, local }, { input, output }) → usd | null` (0 when `local`).
  - `estimateCalls(calls, catalog) → { lines: [{ role, adapter, provider, model, calls, inputTokens, outputTokens, usd|null }], calls, knownUsd, totalUsd|null, unpriced: ['provider/model'] }`, where a call is `{ role: 'summary'|'answer'|'judge', adapter, provider, model, local?, inputChars, extraInputTokens?, maxTokens }`. Lines are ordered summary, answer, judge, then by adapter, provider and model.
  - `checkBudget(estimate, { maxUsd, allowUnpriced })` throws `UsageError` with code `UNPRICED` or `OVER_BUDGET`.
  - `class OverBudgetError` (`code: 'OVER_BUDGET'`); `class SpendGuard({ maxUsd, catalog })` with `hooks()` (for `cachedCall`) and `totals() → { spentUsd, calls, unpricedCalls, overBudget }`.
  - `formatEstimate(estimate, { maxUsd, counts }) → string` (ASCII).

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-cost.test.js`:

```js
// tests/longhaul-cost.test.js
// Pricing a run before its first call (benchmark spec §8.1, B-D7), with the
// fixture catalog: openai/gpt-6-lite $0.3/$1 and
// anthropic/claude-haiku-4-5 $1/$5 per million tokens.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  EST_CHARS_PER_TOKEN, DEFAULT_MAX_USD, estInputTokens, priceCall, estimateCalls, checkBudget, SpendGuard, OverBudgetError, formatEstimate
} = require('../src/longhaul/cost');
const { UsageError } = require('../src/longhaul/errors');
const { fixtureCatalog } = require('./helpers/models-fixture');

const catalog = fixtureCatalog();
const answerModel = { provider: 'openai', model: 'gpt-6-lite' };
const judgeModel = { provider: 'anthropic', model: 'claude-haiku-4-5' };

describe('estimateCalls', () => {
  it('prices each call on a close bound: input at 3 characters a token, output at maxTokens', () => {
    assert.strictEqual(EST_CHARS_PER_TOKEN, 3);
    assert.strictEqual(DEFAULT_MAX_USD, 50);
    const answer = { role: 'answer', adapter: 'kl-recall', ...answerModel, inputChars: 30000, maxTokens: 400 };
    const est = estimateCalls([answer, answer], catalog);
    // Per call: 10,000 input x $0.3/M = $0.003 and 400 output x $1/M = $0.0004.
    assert.deepStrictEqual(est.lines, [{ role: 'answer', adapter: 'kl-recall', provider: 'openai', model: 'gpt-6-lite', calls: 2, inputTokens: 20000, outputTokens: 800, usd: 0.0068 }]);
    assert.strictEqual(est.totalUsd, 0.0068);
    assert.strictEqual(est.calls, 2);
  });

  it('counts a judge reply not written yet at the answer model\'s max tokens', () => {
    const est = estimateCalls([{ role: 'judge', adapter: 'oracle', ...judgeModel, inputChars: 3000, extraInputTokens: 400, maxTokens: 200 }], catalog);
    // Input 1,000 + 400 = 1,400 x $1/M = $0.0014; output 200 x $5/M = $0.001.
    assert.strictEqual(est.lines[0].inputTokens, 1400);
    assert.strictEqual(est.totalUsd, 0.0024);
    assert.strictEqual(estInputTokens(3000, 400), 1400);
  });

  it('leaves an unpriced model unknown, never $0, prices the local fakes at $0, and orders summary, answer, judge', () => {
    const est = estimateCalls([
      { role: 'judge', adapter: 'a', ...judgeModel, inputChars: 3, maxTokens: 1 },
      { role: 'answer', adapter: 'a', provider: 'openai', model: 'no-such-model', inputChars: 3, maxTokens: 1 },
      { role: 'summary', adapter: 'summarize-compact', provider: 'fake', model: 'fake-summarizer', local: true, inputChars: 3, maxTokens: 1 }
    ], catalog);
    assert.deepStrictEqual(est.lines.map((l) => [l.role, l.usd]), [['summary', 0], ['answer', null], ['judge', 0.000006]]);
    assert.strictEqual(est.totalUsd, null);
    assert.strictEqual(est.knownUsd, 0.000006);
    assert.deepStrictEqual(est.unpriced, ['openai/no-such-model']);
    assert.strictEqual(priceCall(catalog, { provider: 'x', model: 'y', local: true }, { input: 1e9, output: 1e9 }), 0);
  });
});

describe('checkBudget', () => {
  it('refuses an estimate over the cap, and an unpriced plan unless allowed', () => {
    const over = { knownUsd: 51, totalUsd: 51, unpriced: [] };
    assert.throws(() => checkBudget(over, {}), (e) => e instanceof UsageError && e.code === 'OVER_BUDGET' && /\$50 cap/.test(e.message) && /nothing was sent/.test(e.message));
    assert.doesNotThrow(() => checkBudget(over, { maxUsd: 60 }));
    const unknown = { knownUsd: 1, totalUsd: null, unpriced: ['openai/x'] };
    assert.throws(() => checkBudget(unknown, {}), (e) => e.code === 'UNPRICED' && /--allow-unpriced/.test(e.message));
    assert.doesNotThrow(() => checkBudget(unknown, { allowUnpriced: true }));
  });
});

describe('SpendGuard', () => {
  it('stops at the cap: reserved estimates count, and once tripped every call is refused', () => {
    const guard = new SpendGuard({ maxUsd: 0.01, catalog });
    const h = guard.hooks();
    const client = { ...answerModel };
    const t1 = h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }); // reserves $0.0034
    const t2 = h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }); // $0.0068 reserved
    assert.throws(() => h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }), (e) => e.code === 'OVER_BUDGET'); // would be $0.0102
    h.afterCall(t1, { costUsd: 0.001 });
    h.cancel(t2);
    assert.throws(() => h.beforeCall({ client, promptChars: 3, maxTokens: 1 }), OverBudgetError, 'a tripped guard stays tripped');
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0.001, calls: 1, unpricedCalls: 0, overBudget: true });
  });

  it('counts calls with no known cost apart, never as $0 spent', () => {
    const guard = new SpendGuard({ maxUsd: 1, catalog });
    const h = guard.hooks();
    h.afterCall(h.beforeCall({ client: { provider: 'openai', model: 'no-such-model' }, promptChars: 3, maxTokens: 1 }), { costUsd: null });
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0, calls: 1, unpricedCalls: 1, overBudget: false });
  });
});

describe('formatEstimate', () => {
  it('prints the plan in ASCII and names what it cannot price', () => {
    const est = estimateCalls([
      { role: 'answer', adapter: 'kl-recall', ...answerModel, inputChars: 30000, maxTokens: 400 },
      { role: 'judge', adapter: 'kl-recall', provider: 'openai', model: 'no-such-model', inputChars: 30, maxTokens: 20 }
    ], catalog);
    const text = formatEstimate(est, { maxUsd: 50, counts: { answers: 1, answersCached: 2, judgments: 1, judgmentsCached: 0, summaries: 0, summariesCached: 0 } });
    assert.ok(/^[\x00-\x7f]*$/.test(text), 'ASCII only');
    assert.match(text, /plan: 1 answers \(2 cached\), 1 judgments \(0 cached\), 0 summaries \(0 cached\)/);
    assert.match(text, /price unknown/);
    assert.match(text, /\$0\.0034 priced \+ unknown for openai\/no-such-model/);
    assert.match(text, /cap \$50 \(--max-usd\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-cost.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/cost'`.

- [ ] **Step 3: Write the implementation**

Create `src/longhaul/cost.js`:

```js
'use strict';
// Pricing a run before its first call (benchmark spec §8.1, B-D7). Every
// planned call that is not already cached is priced from the catalog
// (Catalog#price, the only price source) on a close bound of its tokens:
// input at 3 characters a token (high for prose, about right for code and
// JSON, low for denser text), plus any input not written yet (a judge's
// reply, a summary's previous summary) at its call's maxTokens, and output
// at maxTokens. It is not a guarantee: dense text or billed reasoning can
// exceed it, and the spend guard is the backstop that stops at the cap. A
// model the catalog does not price leaves the estimate unknown, never $0,
// and the run refuses unless --allow-unpriced. The built-in fake models
// (client.local, --fake-models) cost nothing.
const { UsageError } = require('./errors');

const EST_CHARS_PER_TOKEN = 3;
const DEFAULT_MAX_USD = 50;
const ROLE_ORDER = Object.freeze(['summary', 'answer', 'judge']);
const round8 = (n) => Number(n.toFixed(8));

function estInputTokens(chars, extraTokens = 0) {
  return Math.ceil(Math.max(0, chars) / EST_CHARS_PER_TOKEN) + Math.max(0, extraTokens || 0);
}

function priceCall(catalog, model, usage) {
  if (model.local) return 0;
  const priced = catalog.price(model.provider, model.model, usage);
  return priced && Number.isFinite(priced.usd) ? priced.usd : null;
}

function estimateCalls(calls, catalog) {
  const lines = new Map();
  for (const c of calls) {
    const id = [c.role, c.adapter, c.provider, c.model].join('\u0000');
    if (!lines.has(id)) lines.set(id, { role: c.role, adapter: c.adapter, provider: c.provider, model: c.model, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    const line = lines.get(id);
    const input = estInputTokens(c.inputChars, c.extraInputTokens);
    // Priced per call: a long-context tier applies per request.
    const usd = priceCall(catalog, c, { input, output: c.maxTokens });
    line.calls += 1;
    line.inputTokens += input;
    line.outputTokens += c.maxTokens;
    line.usd = line.usd === null || usd === null ? null : line.usd + usd;
  }
  const sorted = [...lines.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
    || a.adapter.localeCompare(b.adapter) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  for (const l of sorted) if (l.usd !== null) l.usd = round8(l.usd);
  const knownUsd = round8(sorted.reduce((n, l) => n + (l.usd ?? 0), 0));
  const unpriced = [...new Set(sorted.filter((l) => l.usd === null).map((l) => `${l.provider}/${l.model}`))].sort();
  return { lines: sorted, calls: calls.length, knownUsd, totalUsd: unpriced.length ? null : knownUsd, unpriced };
}

function checkBudget(estimate, { maxUsd = DEFAULT_MAX_USD, allowUnpriced = false } = {}) {
  if (estimate.unpriced.length && !allowUnpriced) {
    throw new UsageError(`The catalog has no price for ${estimate.unpriced.join(', ')}, so the run cannot be priced; nothing was sent. `
      + 'Pass --allow-unpriced to run anyway (that cost is reported as unknown, never $0).', 'UNPRICED');
  }
  if (estimate.knownUsd > maxUsd) {
    throw new UsageError(`The estimate $${estimate.knownUsd.toFixed(4)} is over the $${maxUsd} cap; nothing was sent. `
      + 'Raise it with --max-usd, or run fewer questions or adapters (--dry-run shows the plan).', 'OVER_BUDGET');
  }
}

class OverBudgetError extends Error {
  constructor(maxUsd, spentUsd) {
    super(`the $${maxUsd} cap was reached ($${spentUsd.toFixed(4)} spent)`);
    this.name = 'OverBudgetError';
    this.code = 'OVER_BUDGET';
  }
}

// Spend during a run. Each call reserves its own estimate (prompt characters
// / 3, output at maxTokens) before it goes out and settles at its real cost
// after, so concurrent calls cannot pass the cap together. Once tripped it
// never resets: every later call in this run is refused (recorded as
// over-budget), and a rerun, which starts a new guard, finishes the rest.
class SpendGuard {
  constructor({ maxUsd = DEFAULT_MAX_USD, catalog }) {
    this.maxUsd = maxUsd;
    this.catalog = catalog;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.calls = 0;
    this.unpricedCalls = 0;
    this.tripped = false;
  }

  hooks() {
    return {
      beforeCall: ({ client, promptChars, maxTokens }) => {
        const est = priceCall(this.catalog, client, { input: estInputTokens(promptChars), output: maxTokens }) ?? 0;
        if (this.tripped || this.spentUsd + this.reservedUsd + est > this.maxUsd) {
          this.tripped = true;
          throw new OverBudgetError(this.maxUsd, this.spentUsd);
        }
        this.reservedUsd += est;
        return est;
      },
      afterCall: (ticket, { costUsd }) => {
        this.reservedUsd -= ticket;
        this.calls += 1;
        if (typeof costUsd === 'number') this.spentUsd += costUsd;
        else this.unpricedCalls += 1;
      },
      cancel: (ticket) => { this.reservedUsd -= ticket; }
    };
  }

  totals() {
    return { spentUsd: round8(this.spentUsd), calls: this.calls, unpricedCalls: this.unpricedCalls, overBudget: this.tripped };
  }
}

const usd = (x) => (x === null ? 'price unknown' : `$${x.toFixed(4)}`);

function formatEstimate(estimate, { maxUsd = DEFAULT_MAX_USD, counts = null } = {}) {
  const out = [];
  if (counts) {
    out.push(`plan: ${counts.answers} answers (${counts.answersCached} cached), ${counts.judgments} judgments (${counts.judgmentsCached} cached), `
      + `${counts.summaries} summaries (${counts.summariesCached} cached)`);
  }
  for (const l of estimate.lines) {
    out.push(`  ${l.role.padEnd(8)}${l.adapter.padEnd(22)}${`${l.provider}/${l.model}`.padEnd(34)}${String(l.calls).padStart(6)} calls  `
      + `~${l.inputTokens} in  <=${l.outputTokens} out  ${usd(l.usd)}`);
  }
  const total = estimate.totalUsd === null ? `${usd(estimate.knownUsd)} priced + unknown for ${estimate.unpriced.join(', ')}` : usd(estimate.totalUsd);
  out.push(`estimate: ${total} (a close bound: input at ${EST_CHARS_PER_TOKEN} characters a token, output at the max tokens; the spend guard stops at the cap); cap $${maxUsd} (--max-usd)`);
  return `${out.join('\n')}\n`;
}

module.exports = {
  EST_CHARS_PER_TOKEN, DEFAULT_MAX_USD, estInputTokens, priceCall, estimateCalls, checkBudget, OverBudgetError, SpendGuard, formatEstimate
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/longhaul-cost.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/cost.js tests/longhaul-cost.test.js
git commit -m "feat(longhaul): price the plan from the catalog, refuse over the cap, guard spend during a run"
```

---

## Task 5: The stratified question sample

**Files:**
- Modify: `src/longhaul/sampling.js` (add `sampleQuestions`)
- Test: `tests/longhaul-sampling.test.js` (append)

**Interfaces:**
- Consumes: `createRng` (`rng.js`), `UsageError`.
- Produces: `sampleQuestions(items, { size, seed }) → items[]`, where `items = [{ question, bucket }]` and `question` has `sessionId`, `id` and `kind`. The strata are kind × bucket. The result is in sample order: round-robin across strata taken in a seeded order, each stratum shuffled by seed, so every prefix is as even as the set allows. The result has at most `size` items and never repeats one. The output does not depend on input order.

- [ ] **Step 1: Write the failing test**

Append to `tests/longhaul-sampling.test.js` (add `sampleQuestions` to its `require('../src/longhaul/sampling')` line, and require `UsageError` if the file does not yet):

```js
describe('sampleQuestions', () => {
  const items = [];
  for (const kind of ['user-said', 'decision', 'abstain']) {
    for (let i = 0; i < 10; i++) {
      items.push({ question: { sessionId: 'S', id: `${kind}-${i}`, kind }, bucket: kind === 'abstain' ? 'none' : (i % 2 ? '<10K' : '>1M') });
    }
  }
  const strata = (list) => {
    const c = {};
    for (const it of list) c[`${it.question.kind}|${it.bucket}`] = (c[`${it.question.kind}|${it.bucket}`] || 0) + 1;
    return Object.values(c).sort((a, b) => a - b);
  };
  const ids = (list) => list.map((it) => it.question.id);

  it('is deterministic for a seed and independent of input order', () => {
    assert.deepStrictEqual(ids(sampleQuestions(items, { size: 7, seed: 3 })), ids(sampleQuestions([...items].reverse(), { size: 7, seed: 3 })));
    assert.notDeepStrictEqual(ids(sampleQuestions(items, { size: 30, seed: 3 })), ids(sampleQuestions(items, { size: 30, seed: 4 })));
  });

  it('keeps every prefix even across kind x bucket strata', () => {
    // Five strata: user-said and decision in <10K and >1M (5 each), abstain in none (10).
    const all = sampleQuestions(items, { size: 30, seed: 1 });
    assert.deepStrictEqual(strata(all.slice(0, 5)), [1, 1, 1, 1, 1]);
    assert.deepStrictEqual(strata(all.slice(0, 10)), [2, 2, 2, 2, 2]);
    assert.deepStrictEqual(strata(all.slice(0, 25)), [5, 5, 5, 5, 5]);
    assert.deepStrictEqual(strata(all), [5, 5, 5, 5, 10]);
  });

  it('takes the whole set when asked for more, never repeating a question', () => {
    const all = sampleQuestions(items, { size: 150, seed: 1 });
    assert.strictEqual(all.length, 30);
    assert.strictEqual(new Set(ids(all)).size, 30);
  });

  it('refuses a size that is not a positive whole number', () => {
    assert.throws(() => sampleQuestions(items, { size: 0, seed: 1 }), UsageError);
    assert.throws(() => sampleQuestions(items, { size: 1.5, seed: 1 }), UsageError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-sampling.test.js`
Expected: FAIL with `sampleQuestions is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/longhaul/sampling.js`, add before `module.exports`:

```js
// The frontier tier's stratified sample (benchmark spec §8.1): questions
// grouped by stratum (kind x distance bucket), each stratum shuffled by a
// seeded RNG, then taken one per stratum in turn, the strata in a seeded
// order. Every prefix of the result is as even across strata as the set
// allows. The first `size` are the sample, and --long-context-sample N gives
// the long-context adapters the first N of the same order. items:
// [{ question, bucket }]; the result is in sample order.
function sampleQuestions(items, { size = items.length, seed = 1 } = {}) {
  if (!Number.isInteger(size) || size <= 0) throw new UsageError('--sample must be a positive whole number');
  const rng = createRng(seed);
  const keyOf = (it) => `${it.question.sessionId}\u0000${it.question.id}`;
  const strata = new Map();
  for (const it of [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
    const s = `${it.question.kind}|${it.bucket}`;
    if (!strata.has(s)) strata.set(s, []);
    strata.get(s).push(it);
  }
  const queues = rng.shuffle([...strata.keys()].sort()).map((s) => rng.shuffle(strata.get(s)));
  const out = [];
  for (let round = 0; out.length < size; round++) {
    let took = false;
    for (const queue of queues) {
      if (out.length >= size) break;
      if (round < queue.length) {
        out.push(queue[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
```

Change the export line to:

```js
module.exports = { ANCHOR_SENDERS, SPAN_RADIUS, planAuthoring, sampleQuestions };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/longhaul-sampling.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/sampling.js tests/longhaul-sampling.test.js
git commit -m "feat(longhaul): seeded stratified question sample for the frontier tier"
```

---
## Task 6: `full-history`, `kl-recall-whole`, and one newest-first cut

**Files:**
- Create: `src/longhaul/adapters/full-history.js`
- Modify: `src/longhaul/adapters/common.js` (add `newestFirst`), `src/longhaul/adapters/sliding-window.js` (use it; `name` option; `truncated`), `src/longhaul/adapters/kl-recall.js` (`name` option), `src/longhaul/adapters/index.js` (register both), `src/longhaul/run.js` (`scoreOne` records `contextTruncated`)
- Test: `tests/longhaul-adapters.test.js`, `tests/longhaul-adapter-kl-recall.test.js`, `tests/longhaul-run.test.js`

**Interfaces:**
- Consumes: `estimateTokens`, `renderMessage`, `CHARS_PER_TOKEN` (`session-format.js`); `uniqueSorted` (`common.js`).
- Produces:
  - `common.js`: `newestFirst(index, { fromSeq = 1, beforeSeq, limit }) → { text, seqs, partial, truncated }`. It takes messages `fromSeq..beforeSeq-1` newest first until `limit` estimated tokens. When the newest message alone is over the limit, its end is shown and the message counts as partial. `truncated` is true when older messages in the range were left out.
  - `sliding-window.js`: `createSlidingWindowAdapter({ budgetTokens, windowTokens, name = 'sliding-window' })`; `context` also returns `truncated`.
  - `full-history.js`: `FULL_HISTORY_TOKENS = 128000`; `createFullHistoryAdapter({ windowTokens })` gives the adapter `full-history` with `frontierOnly: true`, `longContext: true` and `capWindow(tokens)`, which returns the same adapter with its window lowered to `tokens` (never raised). Task 11 calls it with the answer model's window.
  - `kl-recall.js`: `createKlRecallAdapter({ ..., name = 'kl-recall' })`.
  - `adapters/index.js`: `WHOLE_MESSAGES = { completeMessageTokens: 800, pairToolMessages: true }`, and the adapters `kl-recall-whole` (kl-recall with `WHOLE_MESSAGES` over `--recall`) and `full-history`.
  - Records gain `contextTruncated`: a boolean for an adapter that reports `truncated` (sliding-window, full-history, real-compaction, summarize-compact), and null for one that never does (kl-recall and its variants, oracle) or on a context error. A `false` from an adapter that cannot cut would read as "not cut" when it means "not known".

- [ ] **Step 1: Write the failing tests**

In `tests/longhaul-adapters.test.js`, change the registry test to:

```js
describe('adapter registry', () => {
  it('lists the built-in adapters and refuses an unknown one', () => {
    assert.deepStrictEqual(adapterNames(), [
      'full-history', 'kl-recall', 'kl-recall-rerank', 'kl-recall-vec', 'kl-recall-vec-only', 'kl-recall-vec-rerank',
      'kl-recall-whole', 'oracle', 'sliding-window'
    ]);
    assert.throws(() => createAdapter('no-such-adapter'), UsageError);
  });
});
```

Append to `tests/longhaul-adapters.test.js`:

```js
describe('full-history', () => {
  it('shows every message before askAtSeq when the session fits the window', async () => {
    for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
      const { session, questions } = await fixture(id);
      const adapter = createAdapter('full-history');
      assert.strictEqual(adapter.frontierOnly, true);
      assert.strictEqual(adapter.longContext, true);
      const handle = await adapter.prepare(session);
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
        assert.deepStrictEqual(r.evidenceSeqsShown, Array.from({ length: q.askAtSeq - 1 }, (_, i) => i + 1), `${q.id}`);
        assert.strictEqual(r.truncated, false);
      }
    }
  });

  it('cuts the oldest messages at the window and says so', async () => {
    const { session, questions } = await fixture('synth-medium');
    const adapter = createAdapter('full-history', { windowTokens: 5000 });
    assert.deepStrictEqual(adapter.describe(), { name: 'full-history', windowTokens: 5000 });
    const q = questions.at(-1);
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.estTokens <= 5000, `${r.estTokens} tokens`);
    assert.strictEqual(Math.max(...r.evidenceSeqsShown), q.askAtSeq - 1);
    assert.ok(Math.min(...r.evidenceSeqsShown) > 1);
  });

  it('lowers its window to a cap, never raises it', () => {
    const capped = createAdapter('full-history').capWindow(5000);
    assert.strictEqual(capped.name, 'full-history');
    assert.strictEqual(capped.frontierOnly, true);
    assert.deepStrictEqual(capped.describe(), { name: 'full-history', windowTokens: 5000 });
    assert.strictEqual(createAdapter('full-history', { windowTokens: 3000 }).capWindow(5000).describe().windowTokens, 3000);
  });
});

describe('sliding-window truncated flag', () => {
  it('is true when older messages were left out, false when the whole prefix fits', async () => {
    const { session, questions } = await fixture('synth-small');
    const q = questions.at(-1);
    const small = createAdapter('sliding-window', { windowTokens: 500 });
    assert.strictEqual((await small.context(await small.prepare(session), { question: q, askAtSeq: q.askAtSeq })).truncated, true);
    const big = createAdapter('sliding-window', { windowTokens: 1000000 });
    assert.strictEqual((await big.context(await big.prepare(session), { question: q, askAtSeq: q.askAtSeq })).truncated, false);
  });
});
```

In `tests/longhaul-adapter-kl-recall.test.js`, replace the body of `it('is registered next to the other adapters', ...)` so the exact list is pinned only once (in `tests/longhaul-adapters.test.js`):

```js
  it('is registered next to the other adapters', () => {
    assert.ok(adapterNames().includes('kl-recall'));
    assert.ok(adapterNames().includes('kl-recall-whole'));
  });
```

and append (add `createAdapter` to the `require('../src/longhaul/adapters')` line):

```js
describe('kl-recall-whole', () => {
  it('is kl-recall with whole small messages and tool pairing on, whatever --recall says', () => {
    const whole = createAdapter('kl-recall-whole', { tmpRoot: tmpDir(), recall: { bm25TopK: 100, completeMessageTokens: 0 } });
    const d = whole.describe();
    assert.strictEqual(d.name, 'kl-recall-whole');
    assert.strictEqual(whole.name, 'kl-recall-whole');
    assert.strictEqual(d.recall.completeMessageTokens, 800);
    assert.strictEqual(d.recall.pairToolMessages, true);
    assert.strictEqual(d.recall.bm25TopK, 100);
    const shipped = createAdapter('kl-recall', { tmpRoot: tmpDir() }).describe();
    assert.strictEqual(shipped.name, 'kl-recall');
    assert.strictEqual(shipped.recall.completeMessageTokens, 0);
    assert.strictEqual(shipped.recall.pairToolMessages, false);
  });

  it('never shows a message at or after askAtSeq', async () => {
    const { session, questions } = await fixture('synth-small');
    const adapter = createAdapter('kl-recall-whole', { tmpRoot: tmpDir() });
    const handle = await adapter.prepare(session, { upToSeq: Math.max(...questions.map((q) => q.askAtSeq)) });
    try {
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
        assert.ok([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].every((s) => s < q.askAtSeq), q.id);
      }
    } finally {
      await adapter.release(handle);
    }
  });
});
```

In `tests/longhaul-run.test.js`, the CLI test `refuses bad options with exit 2` still expects `--adapters full-history` to be unknown. Change that line to:

```js
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'no-such-adapter'], io()), 2);
```

and append a record check to `describe('runBenchmark', ...)`:

```js
  it('records whether an adapter cut the context', async () => {
    const home = setup();
    const out = await runBenchmark({ home, adapterNames: ['sliding-window'], adapterConfig: { 'sliding-window': { windowTokens: 300 } }, now: fixedNow, commit: 'x' });
    assert.ok(out.records.every((r) => r.contextTruncated === true));
    const oracle = await runBenchmark({ home, adapterNames: ['oracle'], now: fixedNow, commit: 'x' });
    assert.ok(oracle.records.every((r) => r.contextTruncated === null), 'an adapter that never cuts says "not known", not false');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-adapters.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-run.test.js`
Expected: FAIL: the registry lacks `full-history` and `kl-recall-whole`, `truncated` is undefined, and `contextTruncated` is undefined.

- [ ] **Step 3: Add `newestFirst` to `common.js` and move `sliding-window` onto it**

In `src/longhaul/adapters/common.js`, change the require to
`const { estimateTokens, renderMessage, CHARS_PER_TOKEN } = require('../session-format');`
and add, before `module.exports`:

```js
const CUT_MARKER_MAX = 40;

// Messages fromSeq..beforeSeq-1, newest first, until `limit` estimated
// tokens: sliding-window, full-history, real-compaction and summarize-compact
// all cut this way. When the newest message alone is over the limit, its end
// is shown and it counts as partly shown; a limit too small for the cut
// marker leaves it out entirely (slice(-0) would be all of it). truncated
// says older messages in the range were left out.
function newestFirst(index, { fromSeq = 1, beforeSeq, limit }) {
  const parts = [];
  const seqs = [];
  const partial = [];
  let used = 0;
  let truncated = false;
  for (let seq = Math.min(beforeSeq - 1, index.maxSeq); seq >= fromSeq; seq--) {
    const text = renderMessage(index.get(seq));
    const t = estimateTokens(`${text}\n\n`);
    if (used + t > limit) {
      truncated = true;
      const keep = limit * CHARS_PER_TOKEN - CUT_MARKER_MAX;
      if (parts.length === 0 && keep > 0) {
        parts.push(`[... earlier part of #${seq} cut]\n${text.slice(-keep)}`);
        partial.push(seq);
      }
      break;
    }
    parts.push(text);
    seqs.push(seq);
    used += t;
  }
  return { text: parts.reverse().join('\n\n'), seqs: uniqueSorted(seqs), partial, truncated };
}
```

and export it: `module.exports = { TAIL_DEFAULTS, measured, tailBefore, uniqueSorted, newestFirst };`

Replace `src/longhaul/adapters/sliding-window.js` with:

```js
'use strict';
// sliding-window (benchmark spec §7): the last N estimated tokens before
// askAtSeq, any sender. The naive baseline. By default N is the most
// kl-recall can show at the same budget: recalled budget plus tail budget.
// full-history is this adapter with a 128K window (full-history.js).
const { estimateTokens } = require('../session-format');
const { TAIL_DEFAULTS, measured, newestFirst } = require('./common');

function createSlidingWindowAdapter({ budgetTokens = 6000, windowTokens = null, name = 'sliding-window' } = {}) {
  const limit = windowTokens ?? budgetTokens + TAIL_DEFAULTS.tailTokens;
  return {
    name,
    describe() { return { name, windowTokens: limit }; },
    async prepare(session) { return { session }; },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const w = newestFirst(handle.session.index, { beforeSeq: askAtSeq, limit });
        return {
          text: w.text, evidenceSeqsShown: w.seqs, evidenceSeqsPartial: w.partial,
          estTokens: estimateTokens(w.text), cost: 0, truncated: w.truncated
        };
      });
    },
    async release() {}
  };
}

module.exports = { createSlidingWindowAdapter };
```

- [ ] **Step 4: Write `full-history.js`, name `kl-recall`, and register both**

Create `src/longhaul/adapters/full-history.js`:

```js
'use strict';
// full-history (benchmark spec §7, §8.1): every message before askAtSeq,
// newest first, cut at the window (128K estimated tokens by default, the
// frontier tier's cap), oldest first out. The long-context baseline. It runs
// only in the frontier tier (frontierOnly) and only on the
// --long-context-sample questions (longContext). A record's contextTruncated
// says the cap cut its prefix, a limitation the report states. Spec §7 says
// "all messages under askAtSeq that fit the model's window": the answer stage
// lowers the window to what the answer model holds (capWindow, run.js
// contextCapTokens), so an overflow never becomes a 400 recorded as an error.
const { createSlidingWindowAdapter } = require('./sliding-window');

const FULL_HISTORY_TOKENS = 128000;

function createFullHistoryAdapter({ windowTokens = FULL_HISTORY_TOKENS } = {}) {
  const base = createSlidingWindowAdapter({ windowTokens, name: 'full-history' });
  return {
    ...base, frontierOnly: true, longContext: true,
    capWindow: (tokens) => createFullHistoryAdapter({ windowTokens: Math.min(windowTokens, tokens) })
  };
}

module.exports = { FULL_HISTORY_TOKENS, createFullHistoryAdapter };
```

In `src/longhaul/adapters/kl-recall.js`, change the factory signature to:

```js
function createKlRecallAdapter({ budgetTokens = 6000, recall = {}, chunk = {}, tmpRoot, rerankerFor = null, name = 'kl-recall' } = {}) {
```

and in the returned object, replace `name: 'kl-recall',` with `name,`. Replace the `describe()` body with
`return { name, recall: settings.history.recall, chunk: settings.history.chunk ?? null, embedder: 'none (BM25 only)' };`.

In `src/longhaul/adapters/index.js`, add `const { createFullHistoryAdapter } = require('./full-history');` below the other requires, and add this before `const FACTORIES`:

```js
// The whole-message experiment B0 left open (measured facts; recall spec
// §6.7): taking a small message whole and pairing a tool call with its result
// raised evidence recall 0.352 -> 0.494 but left containment flat. B3's
// answer accuracy decides it; the run's summary prints the comparison
// (scoring.js COMPARISONS). These two settings win over --recall.
const WHOLE_MESSAGES = Object.freeze({ completeMessageTokens: 800, pairToolMessages: true });
```

Add these entries to `FACTORIES`:

```js
  'kl-recall-whole': (config) => require('./kl-recall').createKlRecallAdapter({
    ...config, name: 'kl-recall-whole', recall: { ...(config.recall || {}), ...WHOLE_MESSAGES }
  }),
  // Long-context baseline, frontier tier only (spec §8.1).
  'full-history': (config) => createFullHistoryAdapter(config),
```

and export `WHOLE_MESSAGES`: `module.exports = { createAdapter, adapterNames, WHOLE_MESSAGES };`.

- [ ] **Step 5: Record `contextTruncated`**

In `src/longhaul/run.js` `scoreOne`, add `contextTruncated: typeof r.truncated === 'boolean' ? r.truncated : null,` to the success record (after `cost: r.cost ?? 0,`), and `contextTruncated: null,` to the error record.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-adapters.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-run.test.js tests/longhaul-smoke.test.js`
Expected: PASS, `# fail 0`. The B0 sliding-window tests still pass unchanged: the cut behaves the same.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/adapters/common.js src/longhaul/adapters/sliding-window.js src/longhaul/adapters/full-history.js src/longhaul/adapters/kl-recall.js src/longhaul/adapters/index.js src/longhaul/run.js tests/longhaul-adapters.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-run.test.js
git commit -m "feat(longhaul): full-history and kl-recall-whole adapters; records say when a context was cut"
```

---

## Task 7: `real-compaction`, and skipping an adapter that does not apply

**Files:**
- Create: `src/longhaul/adapters/real-compaction.js`
- Modify: `src/longhaul/adapters/index.js`, `src/longhaul/run.js` (`adapterSkips`, `config.skippedAdapters`)
- Test: `tests/longhaul-adapters.test.js`, `tests/longhaul-run.test.js`

**Interfaces:**
- Consumes: `newestFirst`, `measured` (Task 6); `FULL_HISTORY_TOKENS` (Task 6); `renderMessage`, `estimateTokens`.
- Produces:
  - `createRealCompactionAdapter({ windowTokens = 128000 })` gives the adapter `real-compaction` with `longContext: true`, `skipReason: 'no recorded compactions'`, `appliesTo(session)` (true when `manifest.compactions` is non-empty), `capWindow(tokens)` (as `full-history`'s) and a `context` that also returns `truncated` and `compactionSeq` (the summary used, or null).
  - `run.js`: `adapterSkips(adapters, sets) → [{ adapter, sessionId, reason }]`; `config.skippedAdapters`; a skipped (adapter, session) pair makes no records. Task 11 carries both into its rewrite of `run.js`.

- [ ] **Step 1: Write the failing tests**

In `tests/longhaul-adapters.test.js`, add `'real-compaction'` to the registry list, between `'oracle'` and `'sliding-window'`. Append:

```js
describe('real-compaction', () => {
  // synth-compacted: compaction summaries at #151 and #302
  // (tests/fixtures/longhaul/sessions/synth-compacted/manifest.json); their
  // text never mentions a planted fact.
  it('shows the latest summary before the question and only the messages after it', async () => {
    const { session, questions } = await fixture('synth-compacted');
    const adapter = createAdapter('real-compaction');
    assert.strictEqual(adapter.appliesTo(session), true);
    const handle = await adapter.prepare(session);
    const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
    // Asked at #303; its evidence (#208, #257) was condensed into #302.
    const q5 = byId['synth-compacted-005'];
    const r5 = await adapter.context(handle, { question: q5, askAtSeq: q5.askAtSeq });
    assert.strictEqual(r5.compactionSeq, 302);
    assert.match(r5.text, /^\[#302 compaction summary\]\n/);
    assert.deepStrictEqual(r5.evidenceSeqsShown, []);
    // Asked at #373; evidence #247 was condensed, #308 came after the summary.
    const q4 = byId['synth-compacted-004'];
    const r4 = await adapter.context(handle, { question: q4, askAtSeq: q4.askAtSeq });
    assert.deepStrictEqual(r4.evidenceSeqsShown, Array.from({ length: q4.askAtSeq - 303 }, (_, i) => 303 + i));
    assert.ok(r4.evidenceSeqsShown.includes(308) && !r4.evidenceSeqsShown.includes(247));
    assert.strictEqual(r4.truncated, false);
  });

  it('gives a question asked before the first compaction the whole prefix', async () => {
    const { session } = await fixture('synth-compacted');
    const askAtSeq = session.index.userSeqs.find((s) => s > 100 && s < 151);
    const adapter = createAdapter('real-compaction');
    const r = await adapter.context(await adapter.prepare(session), { question: { id: 'x', kind: 'abstain', evidenceSeqs: [] }, askAtSeq });
    assert.strictEqual(r.compactionSeq, null);
    assert.deepStrictEqual(r.evidenceSeqsShown, Array.from({ length: askAtSeq - 1 }, (_, i) => i + 1));
  });

  it('cuts the oldest messages after the summary at the window, and keeps the summary', async () => {
    const { session, questions } = await fixture('synth-compacted');
    const q = questions.find((x) => x.askAtSeq > 400);
    const adapter = createAdapter('real-compaction', { windowTokens: 1500 });
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq });
    assert.strictEqual(r.truncated, true);
    assert.match(r.text, /^\[#302 compaction summary\]\n/);
    assert.strictEqual(Math.max(...r.evidenceSeqsShown), q.askAtSeq - 1);
    assert.ok(Math.min(...r.evidenceSeqsShown) > 303);
    assert.ok(r.estTokens <= 1500, `${r.estTokens} tokens`);
  });

  it('does not apply to a session with no recorded compactions', async () => {
    const { session } = await fixture('synth-small');
    const adapter = createAdapter('real-compaction');
    assert.strictEqual(adapter.appliesTo(session), false);
    assert.strictEqual(adapter.skipReason, 'no recorded compactions');
  });

  it('lowers its window to a cap, never raises it', () => {
    const capped = createAdapter('real-compaction').capWindow(1500);
    assert.deepStrictEqual(capped.describe(), { name: 'real-compaction', windowTokens: 1500 });
    assert.strictEqual(capped.longContext, true);
    assert.strictEqual(createAdapter('real-compaction', { windowTokens: 1000 }).capWindow(1500).describe().windowTokens, 1000);
  });
});
```

Append to `describe('runBenchmark', ...)` in `tests/longhaul-run.test.js`:

```js
  it('skips an adapter that does not apply to a session and lists it in config.json', async () => {
    const home = setup();
    writeSyntheticRoot(home.root, [SYNTH_FIXTURES[2]]);
    const out = await runBenchmark({ home, adapterNames: ['real-compaction', 'oracle'], now: fixedNow, commit: 'x' });
    assert.deepStrictEqual(out.config.skippedAdapters, [{ adapter: 'real-compaction', sessionId: 'synth-small', reason: 'no recorded compactions' }]);
    assert.ok(out.records.filter((r) => r.adapter === 'real-compaction').every((r) => r.sessionId === 'synth-compacted'));
    assert.strictEqual(out.records.filter((r) => r.adapter === 'oracle').length, 12);
    assert.strictEqual(out.leaks, 0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-adapters.test.js tests/longhaul-run.test.js`
Expected: FAIL with `Unknown adapter "real-compaction"`.

- [ ] **Step 3: Write the adapter**

Create `src/longhaul/adapters/real-compaction.js`:

```js
'use strict';
// real-compaction (benchmark spec §7): what Claude Code actually had in
// front of it at a question. Only for sessions with recorded compactions
// (manifest.compactions, from the importer's isCompactSummary records); a
// session without any is skipped and listed in config.json. The context is
// the latest compaction summary before askAtSeq, then every message after it
// and before askAtSeq; a question asked before the first compaction gets the
// whole prefix. A window (128K estimated tokens by default, like
// full-history) cuts the oldest messages after the summary, and the summary
// always stays. The summary is not evidence: evidence it condensed counts as
// not shown, which is the loss this adapter measures, and answer accuracy
// says whether the summary kept the fact anyway (the compaction-loss study,
// spec §9, stage B4, builds on these records).
const { estimateTokens, renderMessage } = require('../session-format');
const { measured, newestFirst } = require('./common');
const { FULL_HISTORY_TOKENS } = require('./full-history');

function createRealCompactionAdapter({ windowTokens = FULL_HISTORY_TOKENS } = {}) {
  return {
    name: 'real-compaction',
    longContext: true,
    skipReason: 'no recorded compactions',
    describe() { return { name: 'real-compaction', windowTokens }; },
    // The answer stage lowers the window to what the answer model holds (run.js contextCapTokens).
    capWindow: (tokens) => createRealCompactionAdapter({ windowTokens: Math.min(windowTokens, tokens) }),
    appliesTo(session) {
      return Array.isArray(session.manifest.compactions) && session.manifest.compactions.length > 0;
    },
    async prepare(session) {
      const summaries = (session.manifest.compactions || []).map((c) => c.summarySeq).sort((a, b) => a - b);
      return { session, summaries };
    },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const summarySeq = handle.summaries.filter((s) => s < askAtSeq).at(-1) ?? null;
        const summary = summarySeq === null ? null : renderMessage(index.get(summarySeq));
        const limit = Math.max(0, windowTokens - (summary ? estimateTokens(`${summary}\n\n`) : 0));
        const w = newestFirst(index, { fromSeq: summarySeq === null ? 1 : summarySeq + 1, beforeSeq: askAtSeq, limit });
        const text = [summary, w.text].filter(Boolean).join('\n\n');
        return {
          text, evidenceSeqsShown: w.seqs, evidenceSeqsPartial: w.partial,
          estTokens: estimateTokens(text), cost: 0, truncated: w.truncated, compactionSeq: summarySeq
        };
      });
    },
    async release() {}
  };
}

module.exports = { createRealCompactionAdapter };
```

In `src/longhaul/adapters/index.js`, add `const { createRealCompactionAdapter } = require('./real-compaction');` and the factory entry:

```js
  // What Claude Code had: its own compaction summaries (sessions with compactions only).
  'real-compaction': (config) => createRealCompactionAdapter(config),
```

- [ ] **Step 4: Skip an adapter that does not apply**

In `src/longhaul/run.js`, add after `newRunId`:

```js
// Adapters that do not apply to a session (real-compaction on a session with
// no recorded compactions) are skipped there and listed in config.json.
function adapterSkips(adapters, sets) {
  const out = [];
  for (const { session } of sets) {
    for (const a of adapters) {
      if (typeof a.appliesTo === 'function' && !a.appliesTo(session)) {
        out.push({ adapter: a.name, sessionId: session.manifest.sessionId, reason: a.skipReason || 'does not apply' });
      }
    }
  }
  return out;
}

const isSkipped = (skips, adapter, session) => skips.some((s) => s.adapter === adapter.name && s.sessionId === session.manifest.sessionId);
```

In `runBenchmark`, right after `const { sets, skipped } = await loadRunSet(...)`, add `const skippedAdapters = adapterSkips(adapters, sets);`. Add `skippedAdapters` to `config` after `skippedSessions: skipped`. In the loop, make the first line inside `for (const adapter of adapters) {` read:

```js
      if (isSkipped(skippedAdapters, adapter, session)) continue;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/longhaul-adapters.test.js tests/longhaul-run.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/adapters/real-compaction.js src/longhaul/adapters/index.js src/longhaul/run.js tests/longhaul-adapters.test.js tests/longhaul-run.test.js
git commit -m "feat(longhaul): real-compaction adapter: the session's own summaries plus what came after"
```

---

## Task 8: `summarize-compact`

**Files:**
- Create: `src/longhaul/adapters/summarize-compact.js`
- Modify: `src/longhaul/adapters/index.js`
- Test: `tests/longhaul-summarize-compact.test.js`, `tests/longhaul-adapters.test.js` (registry list)

**Interfaces:**
- Consumes: `cacheKey`, `cachedCall` (Task 2); `fillTemplate`, `loadPrompt('summarize')` (Task 1); `newestFirst`, `measured` (Task 6); `sha256Text`; `estimateTokens`, `messageText`, `renderMessage`, `CHARS_PER_TOKEN`.
- Produces:
  - `DEFAULT_COMPACT_EVERY_TOKENS = 10000`, `DEFAULT_SUMMARY_MAX_TOKENS = 2000`, `SUMMARY_MESSAGE_CHARS = 8000`.
  - `checkpoints(index, { compactEveryTokens, upToSeq }) → seq[]`. A window closes at the first message that brings it to `compactEveryTokens` estimated tokens, and every checkpoint is `< upToSeq`.
  - `createSummarizeCompactAdapter({ compactEveryTokens, summarizer: { client, cache, prompt, maxTokens?, retry? } })`, registered as `summarize-compact`, with:
    - `usesModel: true` and `modelClient` (the summarizer client).
    - `estimate(session, { upToSeq }) → { calls: [{ provider, model, local, inputChars, extraInputTokens, maxTokens }], cached, contextChars }`. It walks the chain through the cache; after the first miss, every later summary is a call whose previous summary counts at `maxTokens`.
    - `prepare(session, { upToSeq, hooks })` makes the summaries (cached, and `hooks` is the spend guard). The handle is `{ session, summaries: [{ seq, text }], setup: { calls, cachedCalls, costUsd, unpricedCalls } }`.
    - `context` returns `[summary of messages #1-#c]\n<summary>` followed by the messages after checkpoint `c`, and also `truncated` and `compactionSeq`.
  - `prepare` throws `UsageError` when no summarizer is given.

- [ ] **Step 1: Write the failing test**

In `tests/longhaul-adapters.test.js`, add `'summarize-compact'` at the end of the registry list. Create `tests/longhaul-summarize-compact.test.js`:

```js
// tests/longhaul-summarize-compact.test.js
// summarize-compact (benchmark spec §7, §14, §16): the summarizer is called
// at the right points, with a fake summarizer; summaries are cached; the
// estimate counts every call before any is made; nothing at or after
// askAtSeq is ever shown or summarized.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAdapter } = require('../src/longhaul/adapters');
const { checkpoints, DEFAULT_SUMMARY_MAX_TOKENS } = require('../src/longhaul/adapters/summarize-compact');
const { loadSession, estimateTokens, messageText } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT, tmpDir } = require('./helpers/longhaul-helpers');

const EVERY = 2000;

function fakeSummarizer() {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-summarizer', local: true, prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return { text: `S${prompts.length}`, llmMetrics: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 1, costUsd: 0 } };
    }
  };
}

async function setup({ cache = new ModelCache(path.join(tmpDir(), 'model-cache')), client = fakeSummarizer() } = {}) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', 'synth-small'));
  const questions = await readQuestions(questionsFile(FIXTURE_ROOT, 'synth-small'));
  const adapter = createAdapter('summarize-compact', { compactEveryTokens: EVERY, summarizer: { client, cache, prompt: loadPrompt('summarize') } });
  const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
  return { session, questions, client, cache, adapter, upToSeq, cps: checkpoints(session.index, { compactEveryTokens: EVERY, upToSeq }) };
}

describe('summarize-compact checkpoints', () => {
  it('closes a window at the first message that brings it to compactEveryTokens, all before upToSeq', async () => {
    const { session, upToSeq, cps } = await setup();
    assert.ok(cps.length >= 3, `${cps.length} checkpoints`);
    let from = 1;
    for (const c of cps) {
      let sum = 0;
      for (let s = from; s <= c; s++) sum += estimateTokens(messageText(session.index.get(s)));
      const last = estimateTokens(messageText(session.index.get(c)));
      assert.ok(sum >= EVERY && sum - last < EVERY, `window ${from}-${c}`);
      from = c + 1;
    }
    assert.ok(cps.at(-1) < upToSeq);
  });
});

describe('summarize-compact', () => {
  it('calls the summarizer once per checkpoint, each on its own window after the previous summary', async () => {
    const { session, client, adapter, upToSeq, cps } = await setup();
    const handle = await adapter.prepare(session, { upToSeq });
    assert.strictEqual(client.prompts.length, cps.length);
    let from = 1;
    cps.forEach((c, k) => {
      const p = client.prompts[k];
      assert.ok(p.includes(`[#${from} `) && p.includes(`[#${c} `), `window ${from}-${c}`);
      assert.ok(!p.includes(`[#${c + 1} `), `nothing after #${c}`);
      assert.ok(k === 0 ? p.includes('(none yet') : p.includes(`Previous summary:\nS${k}\n`));
      from = c + 1;
    });
    assert.deepStrictEqual(handle.setup, { calls: cps.length, cachedCalls: 0, costUsd: 0, unpricedCalls: 0 });
  });

  it('shows the latest summary before the question and the messages after its checkpoint, nothing at or after askAtSeq', async () => {
    const { session, questions, adapter, upToSeq, cps } = await setup();
    const handle = await adapter.prepare(session, { upToSeq });
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      const k = cps.filter((c) => c < q.askAtSeq).length;
      if (k === 0) {
        assert.strictEqual(r.compactionSeq, null);
      } else {
        assert.strictEqual(r.compactionSeq, cps[k - 1]);
        assert.match(r.text, new RegExp(`^\\[summary of messages #1-#${cps[k - 1]}\\]\\nS${k}(\\n|$)`), q.id);
      }
      assert.ok([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].every((s) => s > (r.compactionSeq ?? 0) && s < q.askAtSeq), q.id);
    }
  });

  it('pays nothing the second time: every summary comes from the cache', async () => {
    const first = await setup();
    await first.adapter.prepare(first.session, { upToSeq: first.upToSeq });
    const second = await setup({ cache: first.cache });
    assert.deepStrictEqual(second.adapter.estimate(second.session, { upToSeq: second.upToSeq }).calls, []);
    const handle = await second.adapter.prepare(second.session, { upToSeq: second.upToSeq });
    assert.strictEqual(second.client.prompts.length, 0);
    assert.strictEqual(handle.setup.cachedCalls, first.client.prompts.length);
  });

  it('estimates every summary before any call, counting a previous summary not written yet at maxTokens', async () => {
    const { session, client, adapter, upToSeq, cps } = await setup();
    const est = adapter.estimate(session, { upToSeq });
    assert.strictEqual(client.prompts.length, 0);
    assert.strictEqual(est.calls.length, cps.length);
    assert.strictEqual(est.cached, 0);
    assert.strictEqual(est.calls[0].extraInputTokens, 0);
    assert.ok(est.calls.slice(1).every((c) => c.extraInputTokens === DEFAULT_SUMMARY_MAX_TOKENS && c.maxTokens === DEFAULT_SUMMARY_MAX_TOKENS));
    assert.deepStrictEqual(Object.keys(est.calls[0]).sort(), ['extraInputTokens', 'inputChars', 'local', 'maxTokens', 'model', 'provider']);
    assert.ok(est.contextChars > EVERY * 4);
  });

  it('refuses to run without a summarizer', async () => {
    const { session } = await setup();
    const adapter = createAdapter('summarize-compact', {});
    assert.strictEqual(adapter.usesModel, true);
    await assert.rejects(adapter.prepare(session, { upToSeq: 50 }), UsageError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-summarize-compact.test.js tests/longhaul-adapters.test.js`
Expected: FAIL with `Unknown adapter "summarize-compact"`.

- [ ] **Step 3: Write the adapter**

Create `src/longhaul/adapters/summarize-compact.js`:

```js
'use strict';
// summarize-compact (benchmark spec §7, §16): the compaction baseline. It
// replays the session and, every compactEveryTokens estimated tokens, asks a
// summarizer model to fold the messages since the last checkpoint into a
// running summary (prompts/summarize-v1.md). The context at a question is
// the latest summary made before askAtSeq, then the messages after its
// checkpoint, cut newest first. Checkpoints depend on token counts alone, so
// they are the same for every summarizer and every answer model. The default
// cadence (10K) keeps the context near the budget the other adapters get
// (about 12K with the summary); the session's own compaction points are
// real-compaction's job. Summaries are cached (model-cache stage "summary"),
// so a second run, or the other tier with the same summarizer, pays nothing.
// Their calls are this adapter's setup cost (handle.setup). A message longer
// than SUMMARY_MESSAGE_CHARS goes to the summarizer clipped, with a note.
const { estimateTokens, messageText, renderMessage, CHARS_PER_TOKEN } = require('../session-format');
const { measured, newestFirst } = require('./common');
const { cacheKey, cachedCall } = require('../model-cache');
const { fillTemplate } = require('../prompts');
const { sha256Text } = require('../files');
const { UsageError } = require('../errors');

const DEFAULT_COMPACT_EVERY_TOKENS = 10000;
const DEFAULT_SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_MESSAGE_CHARS = 8000;
// The messages after a checkpoint sum to under compactEveryTokens; their
// rendered headers add a little more.
const TAIL_SLACK = 1.2;
const NO_SUMMARY_YET = '(none yet: this is the start of the session)';

function checkpoints(index, { compactEveryTokens, upToSeq }) {
  const out = [];
  let used = 0;
  const last = Math.min(upToSeq - 1, index.maxSeq);
  for (let seq = 1; seq <= last; seq++) {
    used += estimateTokens(messageText(index.get(seq)));
    if (used >= compactEveryTokens) {
      out.push(seq);
      used = 0;
    }
  }
  return out;
}

function clipForSummary(m) {
  const text = renderMessage(m);
  if (text.length <= SUMMARY_MESSAGE_CHARS) return text;
  return `${text.slice(0, SUMMARY_MESSAGE_CHARS)}\n[... ${text.length - SUMMARY_MESSAGE_CHARS} more characters not shown to the summarizer]`;
}

function windowText(index, fromSeq, toSeq) {
  const parts = [];
  for (let s = fromSeq; s <= toSeq; s++) parts.push(clipForSummary(index.get(s)));
  return parts.join('\n\n');
}

function createSummarizeCompactAdapter({ compactEveryTokens = DEFAULT_COMPACT_EVERY_TOKENS, summarizer = null } = {}) {
  if (!Number.isInteger(compactEveryTokens) || compactEveryTokens <= 0) {
    throw new UsageError(`--compact-every-tokens must be a positive whole number, got ${JSON.stringify(compactEveryTokens)}`);
  }
  const maxTokens = summarizer?.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
  const need = () => {
    if (!summarizer?.client || !summarizer.cache || !summarizer.prompt) {
      throw new UsageError('summarize-compact needs a summarizer model: run it in the answer stage (--answer-model, or --summarizer-model).');
    }
    return summarizer;
  };
  const promptFor = (s, previous, messages) => fillTemplate(s.prompt.text, {
    previous: previous ?? NO_SUMMARY_YET, messages, maxWords: String(Math.floor(maxTokens * 0.6))
  });
  // baseUrl is set only for a --summarizer-base-url client (undefined drops
  // out of the key), so another endpoint serving the same model name never
  // reuses these summaries.
  const keyFor = (s, prompt) => cacheKey({
    stage: 'summary', provider: s.client.provider, model: s.client.model, baseUrl: s.client.baseUrl,
    promptSha256: s.prompt.sha256, maxTokens, inputSha256: sha256Text(prompt)
  });

  return {
    name: 'summarize-compact',
    usesModel: true,
    get modelClient() { return summarizer?.client ?? null; },
    describe() {
      return {
        name: 'summarize-compact', compactEveryTokens, summaryMaxTokens: maxTokens,
        summarizer: summarizer?.client ? `${summarizer.client.provider}/${summarizer.client.model}` : null,
        summarizePromptSha256: summarizer?.prompt?.sha256 ?? null
      };
    },

    // The summaries a prepare() would make now. The chain is walked through
    // the cache while its links are there; after the first missing link
    // every later summary is a call whose previous summary is not written
    // yet, counted at maxTokens.
    estimate(session, { upToSeq }) {
      const s = need();
      const { index } = session;
      const model = { provider: s.client.provider, model: s.client.model, local: Boolean(s.client.local) };
      const calls = [];
      let previous = null;
      let known = true;
      let cached = 0;
      let from = 1;
      for (const c of checkpoints(index, { compactEveryTokens, upToSeq })) {
        const messages = windowText(index, from, c);
        from = c + 1;
        if (known) {
          const prompt = promptFor(s, previous, messages);
          const hit = s.cache.get('summary', keyFor(s, prompt));
          if (hit) {
            previous = hit.text;
            cached += 1;
            continue;
          }
          known = false;
          calls.push({ ...model, inputChars: prompt.length, extraInputTokens: 0, maxTokens });
        } else {
          calls.push({ ...model, inputChars: s.prompt.text.length + messages.length, extraInputTokens: maxTokens, maxTokens });
        }
      }
      return { calls, cached, contextChars: (Math.ceil(compactEveryTokens * TAIL_SLACK) + maxTokens) * CHARS_PER_TOKEN + 64 };
    },

    async prepare(session, { upToSeq = Infinity, hooks } = {}) {
      const s = need();
      const { index } = session;
      const summaries = [];
      const setup = { calls: 0, cachedCalls: 0, costUsd: 0, unpricedCalls: 0 };
      let previous = null;
      let from = 1;
      for (const c of checkpoints(index, { compactEveryTokens, upToSeq })) {
        const prompt = promptFor(s, previous, windowText(index, from, c));
        const out = await cachedCall({
          cache: s.cache, stage: 'summary', key: keyFor(s, prompt), client: s.client, prompt, maxTokens, hooks,
          retry: s.retry || {}, meta: { sessionId: session.manifest.sessionId, throughSeq: c }
        });
        if (out.cached) setup.cachedCalls += 1;
        else setup.calls += 1;
        if (out.costUsd === null) setup.unpricedCalls += 1;
        else setup.costUsd += out.costUsd;
        summaries.push({ seq: c, text: out.text });
        previous = out.text;
        from = c + 1;
      }
      setup.costUsd = Number(setup.costUsd.toFixed(8));
      return { session, summaries, setup };
    },

    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        let latest = null;
        for (const s of handle.summaries) {
          if (s.seq < askAtSeq) latest = s;
          else break;
        }
        const header = latest ? `[summary of messages #1-#${latest.seq}]\n${latest.text}` : null;
        const tail = newestFirst(index, { fromSeq: latest ? latest.seq + 1 : 1, beforeSeq: askAtSeq, limit: Math.ceil(compactEveryTokens * TAIL_SLACK) });
        const text = [header, tail.text].filter(Boolean).join('\n\n');
        return {
          text, evidenceSeqsShown: tail.seqs, evidenceSeqsPartial: tail.partial,
          estTokens: estimateTokens(text), cost: 0, truncated: tail.truncated, compactionSeq: latest ? latest.seq : null
        };
      });
    },

    async release() {}
  };
}

module.exports = {
  DEFAULT_COMPACT_EVERY_TOKENS, DEFAULT_SUMMARY_MAX_TOKENS, SUMMARY_MESSAGE_CHARS, checkpoints, createSummarizeCompactAdapter
};
```

In `src/longhaul/adapters/index.js`, add `const { createSummarizeCompactAdapter } = require('./summarize-compact');` and:

```js
  // Compaction baseline: a summarizer model every compactEveryTokens (answer stage only).
  'summarize-compact': (config) => createSummarizeCompactAdapter(config),
```

`runBenchmark` (`run.js`, the `adapterNames.map((name) => createAdapter(name, { budgetTokens, tmpRoot: home.tmp, ...(adapterConfig[name] || {}) }))` line) passes `{ budgetTokens, tmpRoot, ...config }`; `createAdapter` hands it to the factory unchanged, and this factory takes only `compactEveryTokens` and `summarizer` from it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/longhaul-summarize-compact.test.js tests/longhaul-adapters.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/adapters/summarize-compact.js src/longhaul/adapters/index.js tests/longhaul-summarize-compact.test.js tests/longhaul-adapters.test.js
git commit -m "feat(longhaul): summarize-compact adapter: cached rolling summaries every 10K tokens"
```

---
## Task 9: Answer metrics, named comparisons and the summary

**Files:**
- Modify: `src/longhaul/scoring.js`
- Test: `tests/longhaul-answer-scoring.test.js`

**Interfaces:**
- Consumes: `isRight`, `scoreVerdict` (Task 3); record fields `verdict`, `answerCorrect`, `abstainCorrect`, `answerError`, `answerCached`, `answerInputTokens`, `answerCostUsd`, `answerLatencyMs`, `judgeCached`, `judgeCostUsd` (written by Task 10's `answerAndJudge`).
- Produces:
  - `summarize(records, { setupCosts = [] } = {})` gains, per adapter: `bySession` (evidence recall and containment by session); `setup` (`{ costUsd, calls, cachedCalls, unpricedCalls }`, or null); and `answer` (null when no record was answered), which is `{ n, accuracy, partialRate, incorrectRate, declinedRate, abstain: { n, accuracy, falseAnswerRate }, errors, errorsByCode, answerInputTokens: { median, p90 }, answerLatencyMs: { median, p90 }, cost: { answer: { usd, spentUsd, unknown }, judge: {...} }, byKind, byBucket, bySession }`. Each group is `{ n, accuracy, abstainN, abstainAccuracy }`.
  - `adapterCost(stats) → { usd, unknown }` (answer + judge + setup).
  - `COMPARISONS = [{ id: 'whole-messages', a: 'kl-recall', b: 'kl-recall-whole', title }]`.
  - `compareAdapters(records, a, b) → { a, b, n, judged, accuracy: { a, b, delta }, onlyA, onlyB, evidenceRecall: { a, b, delta }, answerContainment: { a, b, delta }, medianTokens: { a, b } } | null`. Pairs are matched by (session, question); a pair's accuracy counts an abstain question as right when it was declined.
  - `renderSummaryMarkdown(config, summary, { spend, comparisons } = {})`. The B0 output is unchanged when `config.answer` is absent.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-answer-scoring.test.js`:

```js
// tests/longhaul-answer-scoring.test.js
// Answer accuracy, abstain accuracy and false answers per adapter, by kind,
// distance and session (benchmark spec §8), from records whose numbers are
// exactly computable; the named whole-messages comparison.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { summarize, compareAdapters, COMPARISONS, renderSummaryMarkdown, adapterCost } = require('../src/longhaul/scoring');
const { scoreVerdict } = require('../src/longhaul/judge');

function rec(adapter, questionId, kind, verdict, extra = {}) {
  const abstain = kind === 'abstain';
  return {
    adapter, sessionId: 'S', questionId, kind, bucket: abstain ? 'none' : '<10K',
    evidenceSeqs: abstain ? [] : [1], evidenceRecall: abstain ? null : 1, evidencePartial: 0,
    answerContained: abstain ? null : true, answerTokensContained: abstain ? null : true, chunkEvidenceRecall: null,
    estTokens: 100, latencyMs: 1, cpuMs: 1, leaked: 0, error: null,
    verdict, ...(verdict ? scoreVerdict({ kind }, verdict) : { answerCorrect: null, abstainCorrect: null }),
    answerError: null, answerCached: false, answerInputTokens: 1000, answerOutputTokens: 10, answerCostUsd: 0.001, answerLatencyMs: 50,
    judgeCached: false, judgeInputTokens: 300, judgeOutputTokens: 20, judgeCostUsd: 0.0005,
    ...extra
  };
}

const records = [
  rec('a', 'q1', 'user-said', 'correct'),
  // A paraphrase: the answer text is not in the context, and the judge still finds the reply correct.
  rec('a', 'q2', 'decision', 'correct', { answerContained: false, answerTokensContained: false }),
  rec('a', 'q3', 'superseded', 'partial'),
  rec('a', 'q4', 'tool-observed', 'abstained'),
  rec('a', 'q5', 'abstain', 'abstained'),
  rec('a', 'q6', 'abstain', 'incorrect'),
  rec('a', 'q7', 'user-said', null, { answerError: 'judge-unparsed' }),
  rec('a', 'q8', 'multi-hop', null, { error: 'boom' })
];

describe('summarize with answers', () => {
  const s = summarize(records).a;

  it('scores answerable questions on correct and abstain questions on declining; errors stay out of the rates', () => {
    assert.strictEqual(s.answer.n, 4);
    assert.strictEqual(s.answer.accuracy, 0.5);
    assert.strictEqual(s.answer.partialRate, 0.25);
    assert.strictEqual(s.answer.incorrectRate, 0);
    assert.strictEqual(s.answer.declinedRate, 0.25);
    assert.deepStrictEqual(s.answer.abstain, { n: 2, accuracy: 0.5, falseAnswerRate: 0.5 });
    assert.strictEqual(s.answer.errors, 1);
    assert.deepStrictEqual(s.answer.errorsByCode, { 'judge-unparsed': 1 });
    assert.strictEqual(s.errors, 1, 'the context error is B0\'s error count');
  });

  it('counts a paraphrase as correct although containment misses it', () => {
    const p = summarize([rec('p', 'q2', 'decision', 'correct', { answerContained: false, answerTokensContained: false })]).p;
    assert.strictEqual(p.answerContainment, 0);
    assert.strictEqual(p.answer.accuracy, 1);
    assert.strictEqual(s.answerContainment, 0.8);
  });

  it('groups by kind, bucket and session, with abstain apart', () => {
    const g = (n, accuracy, abstainN = 0, abstainAccuracy = null) => ({ n, accuracy, abstainN, abstainAccuracy });
    assert.deepStrictEqual(s.answer.byKind, {
      'user-said': g(1, 1), decision: g(1, 1), superseded: g(1, 0), 'tool-observed': g(1, 0), abstain: g(0, null, 2, 0.5)
    });
    assert.deepStrictEqual(s.answer.byBucket, { '<10K': g(4, 0.5), none: g(0, null, 2, 0.5) });
    assert.deepStrictEqual(s.answer.bySession, { S: g(4, 0.5, 2, 0.5) });
    assert.strictEqual(s.bySession.S.evidenceRecall, 1);
  });

  it('costs what the replies cost to make, what this run paid, and what it could not price', () => {
    assert.deepStrictEqual(s.answer.cost, { answer: { usd: 0.007, spentUsd: 0.007, unknown: 0 }, judge: { usd: 0.0035, spentUsd: 0.0035, unknown: 0 } });
    const c = summarize([rec('c', 'q1', 'user-said', 'correct', { answerCached: true }), rec('c', 'q2', 'user-said', 'correct', { answerCostUsd: null })]).c;
    assert.deepStrictEqual(c.answer.cost.answer, { usd: 0.001, spentUsd: 0, unknown: 1 });
    assert.deepStrictEqual(adapterCost(c), { usd: 0.002, unknown: 1 });
    const withSetup = summarize([rec('sc', 'q1', 'user-said', 'correct')], { setupCosts: [{ adapter: 'sc', sessionId: 'S', calls: 3, cachedCalls: 1, costUsd: 0.02, unpricedCalls: 0 }] }).sc;
    assert.deepStrictEqual(withSetup.setup, { costUsd: 0.02, calls: 3, cachedCalls: 1, unpricedCalls: 0 });
    assert.deepStrictEqual(adapterCost(withSetup), { usd: 0.0215, unknown: 0 });
  });

  it('leaves answer null for a run without the answer stage', () => {
    const { verdict, ...b0 } = rec('b0', 'q1', 'user-said', 'correct');
    assert.strictEqual(summarize([b0]).b0.answer, null);
  });
});

describe('compareAdapters', () => {
  it('pairs the two adapters question by question', () => {
    const rs = [
      rec('kl-recall', 'q1', 'user-said', 'correct'), rec('kl-recall', 'q2', 'user-said', 'correct'),
      rec('kl-recall', 'q3', 'user-said', 'incorrect'), rec('kl-recall', 'q4', 'abstain', 'incorrect'),
      rec('kl-recall-whole', 'q1', 'user-said', 'correct'), rec('kl-recall-whole', 'q2', 'user-said', 'partial', { evidenceRecall: 0.5 }),
      rec('kl-recall-whole', 'q3', 'user-said', 'correct', { estTokens: 300 }), rec('kl-recall-whole', 'q4', 'abstain', 'abstained')
    ];
    const c = compareAdapters(rs, 'kl-recall', 'kl-recall-whole');
    assert.strictEqual(c.n, 4);
    assert.strictEqual(c.judged, 4);
    assert.deepStrictEqual(c.accuracy, { a: 0.5, b: 0.75, delta: 0.25 });
    assert.strictEqual(c.onlyA, 1);
    assert.strictEqual(c.onlyB, 2);
    assert.deepStrictEqual(c.evidenceRecall, { a: 1, b: 0.8333333333333334, delta: -0.16666667 });
    assert.deepStrictEqual(c.medianTokens, { a: 100, b: 100 });
    assert.strictEqual(compareAdapters(rs, 'kl-recall', 'nope'), null);
    assert.deepStrictEqual(COMPARISONS.map((x) => [x.id, x.a, x.b]), [['whole-messages', 'kl-recall', 'kl-recall-whole']]);
  });
});

describe('renderSummaryMarkdown with answers', () => {
  const config = {
    runId: 'R', budgetTokens: 6000, seed: 1, commit: 'c', includeUnverified: false,
    sessions: [{ sessionId: 'S', private: false, license: 'CC-BY-4.0', questions: 8 }],
    answer: {
      tier: 'grid', sample: { requested: null, questions: 8 },
      answerModel: { provider: 'openai', model: 'gpt-6-lite' }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      prompts: { answer: { sha256: 'a'.repeat(64) }, judge: { sha256: 'b'.repeat(64) } }
    }
  };

  it('adds the answer tables, the named comparison and the spend', () => {
    const rs = [...records, ...records.map((r) => ({ ...r, adapter: 'kl-recall' })), ...records.map((r) => ({ ...r, adapter: 'kl-recall-whole' }))];
    const summary = summarize(rs);
    const comparisons = COMPARISONS.map((c) => ({ ...c, result: compareAdapters(rs, c.a, c.b) }));
    const md = renderSummaryMarkdown(config, summary, { spend: { spentUsd: 0.0315, calls: 42, unpricedCalls: 0, overBudget: false, estimateUsd: 0.05 }, comparisons });
    assert.match(md, /Metric: answer accuracy, judged by anthropic\/claude-haiku-4-5/);
    assert.match(md, /## Answer accuracy\n/);
    assert.match(md, /\| a \| 6 \| 0\.500 \| 0\.250 \| 0\.250 \| 0\.500 \| 0\.500 \| 1 \| 1000 \| 1000 \| 0\.0105 \|/);
    assert.match(md, /## Answer accuracy by kind/);
    assert.match(md, /## Named comparisons/);
    assert.match(md, /whole-messages: kl-recall 0\.500 vs kl-recall-whole 0\.500 answer accuracy over 6 paired questions/);
    assert.match(md, /Spent \$0\.0315 on 42 calls/);
  });

  it('keeps the B0 summary as it was when the run had no answer stage', () => {
    const { answer, ...b0config } = config;
    const md = renderSummaryMarkdown(b0config, summarize([rec('a', 'q1', 'user-said', undefined)]));
    assert.match(md, /No answer or judge model \(stage B0\)/);
    assert.ok(!md.includes('## Answer accuracy'));
  });
});
```

The comparison's `0.500` is the paired accuracy over the 6 judged pairs. q7 (unparsed) and q8 (a context error) are left out, and an abstain question counts as right when it was declined. q1, q2 and q5 are right and q3, q4 and q6 are not, so the score is 3/6 on both sides.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-answer-scoring.test.js`
Expected: FAIL with `compareAdapters is not a function`, and `s.answer` undefined.

- [ ] **Step 3: Write the implementation**

In `src/longhaul/scoring.js`, add `const { isRight } = require('./judge');` below the `questions` require, and add before `const fmt = ...`:

```js
const round8 = (n) => Number(n.toFixed(8));

// The named comparisons a run and a report print when both adapters ran.
// whole-messages is the experiment B0 left open (measured facts; recall spec
// §6.7): whole small messages and tool pairing raised evidence recall but not
// containment, so only answer accuracy can decide it.
const COMPARISONS = Object.freeze([Object.freeze({
  id: 'whole-messages',
  a: 'kl-recall',
  b: 'kl-recall-whole',
  title: 'Whole small messages and tool pairing (completeMessageTokens 800, pairToolMessages true) against the shipped kl-recall defaults'
})]);

// { n, accuracy, abstainN, abstainAccuracy } per group of judged records:
// accuracy over the answerable ones (correct), abstain accuracy over the
// abstain ones (declined).
function groupAnswers(judged, key) {
  const groups = {};
  for (const r of judged) (groups[r[key]] ||= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => {
    const answerable = rs.filter((r) => r.kind !== 'abstain');
    const abstain = rs.filter((r) => r.kind === 'abstain');
    return [k, {
      n: answerable.length,
      accuracy: answerable.length ? answerable.filter(isRight).length / answerable.length : null,
      abstainN: abstain.length,
      abstainAccuracy: abstain.length ? abstain.filter(isRight).length / abstain.length : null
    }];
  }));
}

// What the calls behind the records cost to make (usd), what this run paid
// (spentUsd: the calls that were not cache hits), and how many had no known
// price (never counted as $0).
function costOf(staged, costField, cachedField) {
  let usd = 0;
  let spentUsd = 0;
  let unknown = 0;
  for (const r of staged) {
    if (r[cachedField] === null || r[cachedField] === undefined) continue; // no call was made
    if (typeof r[costField] === 'number') {
      usd += r[costField];
      if (r[cachedField] === false) spentUsd += r[costField];
    } else {
      unknown += 1;
    }
  }
  return { usd: round8(usd), spentUsd: round8(spentUsd), unknown };
}

function answerStats(rs) {
  const staged = rs.filter((r) => !r.error && r.verdict !== undefined);
  if (!staged.length) return null;
  const judged = staged.filter((r) => typeof r.verdict === 'string');
  const answerable = judged.filter((r) => r.kind !== 'abstain');
  const abstain = judged.filter((r) => r.kind === 'abstain');
  const share = (list, v) => (list.length ? list.filter((r) => r.verdict === v).length / list.length : null);
  const abstainAccuracy = share(abstain, 'abstained');
  const errorsByCode = {};
  for (const r of staged) if (r.answerError) errorsByCode[r.answerError] = (errorsByCode[r.answerError] || 0) + 1;
  const tokens = staged.map((r) => r.answerInputTokens);
  const latency = staged.map((r) => r.answerLatencyMs);
  return {
    n: answerable.length,
    accuracy: share(answerable, 'correct'),
    partialRate: share(answerable, 'partial'),
    incorrectRate: share(answerable, 'incorrect'),
    declinedRate: share(answerable, 'abstained'),
    abstain: { n: abstain.length, accuracy: abstainAccuracy, falseAnswerRate: abstainAccuracy === null ? null : 1 - abstainAccuracy },
    errors: staged.filter((r) => r.answerError).length,
    errorsByCode,
    answerInputTokens: { median: percentile(tokens, 0.5), p90: percentile(tokens, 0.9) },
    answerLatencyMs: { median: percentile(latency, 0.5), p90: percentile(latency, 0.9) },
    cost: { answer: costOf(staged, 'answerCostUsd', 'answerCached'), judge: costOf(staged, 'judgeCostUsd', 'judgeCached') },
    byKind: groupAnswers(judged, 'kind'),
    byBucket: groupAnswers(judged, 'bucket'),
    bySession: groupAnswers(judged, 'sessionId')
  };
}

function setupOf(setupCosts, adapter) {
  const mine = setupCosts.filter((c) => c.adapter === adapter);
  if (!mine.length) return null;
  const sum = (f) => mine.reduce((n, c) => n + (c[f] || 0), 0);
  return { costUsd: round8(sum('costUsd')), calls: sum('calls'), cachedCalls: sum('cachedCalls'), unpricedCalls: sum('unpricedCalls') };
}

// An adapter's model cost: answers, judgments and its setup (summaries).
function adapterCost(s) {
  const a = s.answer;
  const usd = (a ? a.cost.answer.usd + a.cost.judge.usd : 0) + (s.setup ? s.setup.costUsd : 0);
  const unknown = (a ? a.cost.answer.unknown + a.cost.judge.unknown : 0) + (s.setup ? s.setup.unpricedCalls : 0);
  return { usd: round8(usd), unknown };
}

function pairMeans(pairs, value) {
  const a = mean(pairs.map(([x]) => value(x)));
  const b = mean(pairs.map(([, y]) => value(y)));
  return { a, b, delta: a === null || b === null ? null : round8(b - a) };
}

function compareAdapters(records, a, b) {
  const key = (r) => `${r.sessionId}\u0000${r.questionId}`;
  const left = new Map(records.filter((r) => r.adapter === a && !r.error).map((r) => [key(r), r]));
  const pairs = records.filter((r) => r.adapter === b && !r.error && left.has(key(r))).map((r) => [left.get(key(r)), r]);
  if (!pairs.length) return null;
  const judged = pairs.filter(([x, y]) => typeof x.verdict === 'string' && typeof y.verdict === 'string');
  const accA = judged.length ? judged.filter(([x]) => isRight(x)).length / judged.length : null;
  const accB = judged.length ? judged.filter(([, y]) => isRight(y)).length / judged.length : null;
  const scored = pairs.filter(([x]) => x.kind !== 'abstain');
  const contained = (r) => (typeof r.answerContained === 'boolean' ? Number(r.answerContained) : null);
  return {
    a, b, n: pairs.length, judged: judged.length,
    accuracy: { a: accA, b: accB, delta: accA === null ? null : round8(accB - accA) },
    onlyA: judged.filter(([x, y]) => isRight(x) && !isRight(y)).length,
    onlyB: judged.filter(([x, y]) => !isRight(x) && isRight(y)).length,
    evidenceRecall: pairMeans(scored, (r) => r.evidenceRecall),
    answerContainment: pairMeans(scored, contained),
    medianTokens: { a: percentile(pairs.map(([x]) => x.estTokens), 0.5), b: percentile(pairs.map(([, y]) => y.estTokens), 0.5) }
  };
}
```

In `summarize`, change the signature to `function summarize(records, { setupCosts = [] } = {})`, and add three fields to each adapter's object after `byBucket`:

```js
      bySession: groupRecall(scored, 'sessionId'),
      answer: answerStats(rs),
      setup: setupOf(setupCosts, adapter),
```

Replace `renderSummaryMarkdown` with:

```js
const usdCell = ({ usd, unknown }) => (unknown ? `${usd.toFixed(4)} + ${unknown} unpriced` : usd.toFixed(4));
const answerCell = (g) => (g ? `${fmt(g.accuracy)} (n=${g.n})` : '—');
const kindCell = (kind, g) => (!g ? '—' : kind === 'abstain' ? `${fmt(g.abstainAccuracy)} (n=${g.abstainN})` : answerCell(g));

function renderSummaryMarkdown(config, summary, { spend = null, comparisons = [] } = {}) {
  const lines = [`# LongHaul run ${config.runId}`, ''];
  if (config.includeUnverified) lines.push('**UNVERIFIED QUESTIONS INCLUDED. This is a smoke run, not a result.**', '');
  if (config.answer) {
    const a = config.answer;
    const sample = a.sample?.requested ? `, a stratified sample of ${a.sample.questions} questions` : '';
    lines.push(`Metric: answer accuracy, judged by ${a.judgeModel.provider}/${a.judgeModel.model}; evidence recall and answer containment alongside. `
      + `Answer model ${a.answerModel.provider}/${a.answerModel.model}, tier ${a.tier}${sample}. `
      + `Prompts: answer ${a.prompts.answer.sha256.slice(0, 12)}, judge ${a.prompts.judge.sha256.slice(0, 12)}.`, '');
  } else {
    lines.push('Metric: evidence recall, at message level (and at chunk level for adapters that report chunks). No answer or judge model (stage B0).', '');
  }
  lines.push(`Budget ${config.budgetTokens} recalled tokens; seed ${config.seed}; commit ${config.commit}.`, '');
  lines.push(`Sessions: ${config.sessions.map((s) => `${s.sessionId} (${s.private ? 'private' : s.license}, ${s.questions} questions)`).join(', ')}`, '');
  lines.push('Evidence recall counts an evidence message only when it was shown whole. Partial: evidence messages shown only in part (a cut or shortened message, some of its chunks, a folded tool call), not counted.', '');
  lines.push('Answer contained (secondary, no model): the answer or an acceptable answer, normalized (NFKC, case, whitespace, surrounding punctuation), is a substring of the context. Tokens: every word of the shortest answer is inside one message of the context. A paraphrased answer is never found.', '');
  lines.push('| Adapter | Questions | Scored | Errors | Evidence recall | Answer contained | Answer tokens contained | Partial | Chunk evidence recall | Median tokens | p90 tokens | Median ms | p90 ms | Leaks |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(summary)) {
    lines.push(`| ${name} | ${s.questions} | ${s.scored} | ${s.errors} | ${fmt(s.evidenceRecall)} | ${fmt(s.answerContainment)} | ${fmt(s.answerTokenContainment)} | ${s.partial} | ${fmt(s.chunkEvidenceRecall)} | ${s.estTokens.median ?? '—'} | ${s.estTokens.p90 ?? '—'} | ${fmt(s.latencyMs.median, 1)} | ${fmt(s.latencyMs.p90, 1)} | ${s.leaks} |`);
  }
  const kinds = KINDS.filter((k) => k !== 'abstain');
  lines.push('', '## Evidence recall / answer contained by kind', '', `| Adapter | ${kinds.join(' | ')} |`, `|---|${kinds.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${kinds.map((k) => cell(s.byKind[k])).join(' | ')} |`);
  const buckets = BUCKETS.map((b) => b.id);
  lines.push('', '## Evidence recall / answer contained by distance (estimated tokens)', '', `| Adapter | ${buckets.join(' | ')} |`, `|---|${buckets.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${buckets.map((b) => cell(s.byBucket[b])).join(' | ')} |`);

  const answered = Object.entries(summary).filter(([, s]) => s.answer);
  if (answered.length) {
    lines.push('', '## Answer accuracy', '');
    lines.push('Accuracy: answerable questions judged correct (partial is not correct). Declined: answerable questions the model said it could not answer. '
      + 'Abstain accuracy: abstain questions the model declined; false answers: abstain questions it answered anyway. '
      + 'Errors (a failed call, an unparsable verdict, the cap) are left out of the rates. Answer tokens come from provider usage; context tokens are estimated. '
      + 'One question is about 0.01; differences under 0.02 are noise.', '');
    lines.push('| Adapter | Judged | Accuracy | Partial | Declined | Abstain accuracy | False answers | Errors | Median answer tokens | p90 answer tokens | Cost USD |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [name, s] of answered) {
      const a = s.answer;
      lines.push(`| ${name} | ${a.n + a.abstain.n} | ${fmt(a.accuracy)} | ${fmt(a.partialRate)} | ${fmt(a.declinedRate)} | ${fmt(a.abstain.accuracy)} | ${fmt(a.abstain.falseAnswerRate)} | ${a.errors} | ${a.answerInputTokens.median ?? '—'} | ${a.answerInputTokens.p90 ?? '—'} | ${usdCell(adapterCost(s))} |`);
    }
    lines.push('', '## Answer accuracy by kind', '', `| Adapter | ${KINDS.join(' | ')} |`, `|---|${KINDS.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${KINDS.map((k) => kindCell(k, s.answer.byKind[k])).join(' | ')} |`);
    const allBuckets = [...buckets, 'none'];
    lines.push('', '## Answer accuracy by distance (abstain questions: none)', '', `| Adapter | ${allBuckets.join(' | ')} |`, `|---|${allBuckets.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${allBuckets.map((b) => (b === 'none' ? kindCell('abstain', s.answer.byBucket[b]) : answerCell(s.answer.byBucket[b]))).join(' | ')} |`);
    const sessions = [...new Set(answered.flatMap(([, s]) => Object.keys(s.answer.bySession)))].sort();
    lines.push('', '## Answer accuracy by session', '', `| Adapter | ${sessions.join(' | ')} |`, `|---|${sessions.map(() => '---').join('|')}|`);
    for (const [name, s] of answered) lines.push(`| ${name} | ${sessions.map((id) => answerCell(s.answer.bySession[id])).join(' | ')} |`);
  }
  const shown = comparisons.filter((c) => c.result);
  if (shown.length) {
    lines.push('', '## Named comparisons', '');
    for (const { id, title, a, b, result: r } of shown) {
      lines.push(`- ${id}: ${a} ${fmt(r.accuracy.a)} vs ${b} ${fmt(r.accuracy.b)} answer accuracy over ${r.judged} paired questions `
        + `(delta ${fmt(r.accuracy.delta)}; right in ${a} only ${r.onlyA}, in ${b} only ${r.onlyB}); evidence recall ${fmt(r.evidenceRecall.a)} vs ${fmt(r.evidenceRecall.b)}, `
        + `contained ${fmt(r.answerContainment.a)} vs ${fmt(r.answerContainment.b)}, median tokens ${r.medianTokens.a ?? '—'} vs ${r.medianTokens.b ?? '—'}. ${title}.`);
    }
  }
  if (spend) {
    lines.push('', '## Spend', '', `Spent $${spend.spentUsd.toFixed(4)} on ${spend.calls} calls (${spend.unpricedCalls} unpriced); `
      + `estimate ${spend.estimateUsd === null || spend.estimateUsd === undefined ? 'unknown' : `$${spend.estimateUsd.toFixed(4)}`}.`
      + `${spend.overBudget ? ' STOPPED AT THE CAP: the remaining questions are over-budget errors; run again to finish (cached calls are free).' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
```

Export the new names: `module.exports = { evidenceRecall, chunkEvidenceRecall, answerContainment, normalizeText, normalizeAnswer, splitMessages, percentile, mean, summarize, renderSummaryMarkdown, compareAdapters, COMPARISONS, adapterCost };`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/longhaul-answer-scoring.test.js tests/longhaul-run.test.js tests/longhaul-containment.test.js`
Expected: PASS, `# fail 0`. The B0 summary tests still match: their output is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/scoring.js tests/longhaul-answer-scoring.test.js
git commit -m "feat(longhaul): answer and abstain accuracy by kind, distance and session; named whole-messages comparison"
```

---

## Task 10: Answer and judge one item

**Files:**
- Create: `src/longhaul/answer-stage.js`
- Test: `tests/longhaul-answer-stage.test.js`

**Interfaces:**
- Consumes: `cacheKey`, `cachedCall`, `stableStringify` (Task 2); `buildAnswerPrompt`, `NOTHING_SHOWN` (Task 3); `buildJudgePrompt`, `parseVerdict`, `scoreVerdict` (Task 3); `isAuthFailure` (Task 1); `createRng`; `writeFileAtomic`, `sha256Text`.
- Produces:
  - `questionSha256(q)`; `answerKey({ adapterConfigSha256, question, contextSha256, client, promptSha256, maxTokens })`; `judgeKey({ answerCacheKey, prompt, client, maxTokens })`, where `prompt` is the judge prompt as rendered (`buildJudgePrompt`), so the key covers `judge-v1.md`, the kind rule, the references, the reply and every string `judge.js` splices in. Both keys include `client.baseUrl` when it is set (Task 12 sets it for `--<role>-base-url`).
  - `EMPTY_ANSWER_FIELDS` (every answer field null).
  - `answerAndJudge(item, deps) → { fields, reply, reason }`, where `item = { question, adapter, adapterConfigSha256, context, contextSha256 }` and `deps = { cache, prompts: { answer, judge }, answerClient, judgeClient, answerMaxTokens, judgeMaxTokens, hooks, retry }`. `fields` holds only verdicts, booleans, numbers and error codes: `answer-failed[:status]`, `judge-failed[:status]`, `judge-unparsed`, `over-budget`. A 401 or 403 throws `UsageError` with code `AUTH`.
  - `mapPool(items, limit, fn)`: at most `limit` at once; after the first error it takes no new items and rethrows.
  - `SPOT_CHECK_FRACTION = 0.1`; `spotCheckFile(home, runId) → home.private/spot-checks/<runId>.jsonl`; `writeSpotCheckSample(file, rows, { seed }) → count`. The rows are `{ runId, sessionId, questionId, adapter, kind, question, reference, acceptableAnswers, reply, verdict, reason }`, and each written row adds `humanVerdict: null, reviewer: null`.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-answer-stage.test.js`:

```js
// tests/longhaul-answer-stage.test.js
// One (adapter, question) item through the answer and the judge (benchmark
// spec §8 steps 3 and 4, §15), with scripted fake models: fields hold
// verdicts and numbers only; a repeat is free; an unparsable verdict, a
// failed call and the cap are recorded, not thrown; a refused key stops.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample, EMPTY_ANSWER_FIELDS } = require('../src/longhaul/answer-stage');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { buildAnswerPrompt } = require('../src/longhaul/answer');
const { buildJudgePrompt, VERDICTS } = require('../src/longhaul/judge');
const { UsageError } = require('../src/longhaul/errors');
const { tmpDir } = require('./helpers/longhaul-helpers');

const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge') };
const status = (s) => Object.assign(new Error(`status ${s}`), { status: s });

function client(model, reply) {
  const seen = [];
  return {
    provider: 'fake', model, prompts: seen,
    async complete(p) {
      seen.push(p);
      const text = typeof reply === 'function' ? reply(p, seen.length) : reply;
      if (text instanceof Error) throw text;
      return { text, llmMetrics: { inputTokens: Math.ceil(p.length / 4), outputTokens: 5, costUsd: 0.002 } };
    }
  };
}

const question = {
  id: 'S-001', sessionId: 'S', kind: 'decision',
  question: 'What did we decide to use for amber-heron, and why?',
  answer: 'SQLite, because it needs no server', acceptableAnswers: ['SQLite']
};
const context = '[#4 assistant]\nWe decided to use SQLite for amber-heron because it needs no server.';
const item = (extra = {}) => ({ question, adapter: 'oracle', adapterConfigSha256: 'a'.repeat(64), context, contextSha256: 'c'.repeat(64), ...extra });
const REPLY = 'SQLite, since it needs no server.';
const deps = (over = {}) => ({
  cache: new ModelCache(path.join(tmpDir(), 'model-cache')), prompts,
  answerClient: client('fake-answer', REPLY),
  judgeClient: client('fake-judge', '{"verdict":"correct","reason":"same choice and reason"}'),
  answerMaxTokens: 400, judgeMaxTokens: 200, retry: { wait: async () => {} }, ...over
});

describe('answerAndJudge', () => {
  it('answers, judges and scores one item; its fields hold verdicts and numbers only', async () => {
    const d = deps();
    const out = await answerAndJudge(item(), d);
    const answerPrompt = buildAnswerPrompt(prompts.answer.text, { context, question });
    const judgePrompt = buildJudgePrompt(prompts.judge.text, { question, reply: REPLY });
    assert.deepStrictEqual({ ...out.fields, answerLatencyMs: 0 }, {
      verdict: 'correct', answerCorrect: true, abstainCorrect: null, answerError: null,
      answerCached: false, answerInputTokens: Math.ceil(answerPrompt.length / 4), answerOutputTokens: 5, answerCostUsd: 0.002, answerLatencyMs: 0,
      judgeCached: false, judgeInputTokens: Math.ceil(judgePrompt.length / 4), judgeOutputTokens: 5, judgeCostUsd: 0.002
    });
    assert.deepStrictEqual(Object.keys(out.fields).sort(), Object.keys(EMPTY_ANSWER_FIELDS).sort());
    for (const v of Object.values(out.fields)) assert.ok(typeof v !== 'string' || VERDICTS.includes(v), `no text in fields: ${v}`);
    assert.strictEqual(out.reply, REPLY);
    assert.strictEqual(out.reason, 'same choice and reason');
    assert.deepStrictEqual(d.answerClient.prompts, [answerPrompt]);
    assert.deepStrictEqual(d.judgeClient.prompts, [judgePrompt]);
    assert.ok(!d.judgeClient.prompts[0].includes('We decided to use SQLite'), 'the judge never sees the context');
  });

  it('answers a repeat from the cache for nothing', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    const again = await answerAndJudge(item(), d);
    assert.strictEqual(again.fields.answerCached, true);
    assert.strictEqual(again.fields.judgeCached, true);
    assert.strictEqual(again.fields.verdict, 'correct');
    assert.strictEqual(d.answerClient.prompts.length, 1);
    assert.strictEqual(d.judgeClient.prompts.length, 1);
  });

  it('asks again when the context changes, the question is edited or the endpoint differs', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    await answerAndJudge(item({ contextSha256: 'd'.repeat(64) }), d);
    await answerAndJudge(item({ question: { ...question, answer: 'SQLite, as it needs no server' } }), d);
    await answerAndJudge(item(), { ...d, answerClient: { ...d.answerClient, baseUrl: 'http://127.0.0.1:18080/v1' } });
    assert.strictEqual(d.answerClient.prompts.length, 4);
  });

  it('keys the judge on the prompt it is sent: text spliced in under the same judge-v1.md hash is judged afresh', async () => {
    const d = deps();
    await answerAndJudge(item(), d);
    // Same sha256 field, different text: what an edit to JUDGE_KIND_RULES looks like to the cache.
    const edited = { ...prompts.judge, text: `${prompts.judge.text}
One more rule.` };
    const again = await answerAndJudge(item(), { ...d, prompts: { ...prompts, judge: edited } });
    assert.strictEqual(again.fields.answerCached, true, 'the answer is still a hit');
    assert.strictEqual(again.fields.judgeCached, false);
    assert.strictEqual(d.judgeClient.prompts.length, 2);
  });

  it('records judge-unparsed and keeps the reply for the spot check, without a verdict', async () => {
    const d = deps({ judgeClient: client('fake-judge', 'The reply looks right to me.') });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'judge-unparsed');
    assert.strictEqual(out.fields.verdict, null);
    assert.strictEqual(out.fields.answerCorrect, null);
    assert.strictEqual(out.fields.judgeCostUsd, 0.002, 'the judge call was paid');
    assert.strictEqual(out.reply, REPLY);
  });

  it('records an answer call that failed after its retries, and makes no judge call', async () => {
    const d = deps({ answerClient: client('fake-answer', () => status(500)) });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'answer-failed:500');
    assert.strictEqual(d.answerClient.prompts.length, 4, 'one call and three retries');
    assert.strictEqual(d.judgeClient.prompts.length, 0);
  });

  it('records a judge call that failed', async () => {
    const d = deps({ judgeClient: client('fake-judge', () => status(400)) });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'judge-failed:400');
    assert.strictEqual(out.fields.answerCached, false);
    assert.strictEqual(out.fields.verdict, null);
  });

  it('stops the run on a refused key', async () => {
    const d = deps({ answerClient: client('fake-answer', () => status(401)) });
    await assert.rejects(answerAndJudge(item(), d), (err) => err instanceof UsageError && err.code === 'AUTH' && /refused the API key/.test(err.message));
  });

  it('records over-budget when the spend guard refuses the call, and makes no call', async () => {
    const refuse = { beforeCall: () => { throw Object.assign(new Error('cap'), { code: 'OVER_BUDGET' }); }, afterCall: () => {}, cancel: () => {} };
    const d = deps({ hooks: refuse });
    const out = await answerAndJudge(item(), d);
    assert.strictEqual(out.fields.answerError, 'over-budget');
    assert.strictEqual(d.answerClient.prompts.length, 0);
  });

  it('scores an abstain question on declining', async () => {
    const abstain = { ...question, id: 'S-002', kind: 'abstain', answer: 'not in the session', acceptableAnswers: [] };
    const d = deps({ answerClient: client('fake-answer', "I don't know"), judgeClient: client('fake-judge', '{"verdict":"abstained","reason":"declined"}') });
    const out = await answerAndJudge(item({ question: abstain }), d);
    assert.deepStrictEqual([out.fields.verdict, out.fields.answerCorrect, out.fields.abstainCorrect], ['abstained', null, true]);
  });
});

describe('mapPool', () => {
  it('runs every item with at most N at once', async () => {
    let running = 0;
    let peak = 0;
    const done = [];
    await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      done.push(x);
    });
    assert.strictEqual(peak, 3);
    assert.deepStrictEqual(done.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('takes no new item after an error and rethrows it', async () => {
    const started = [];
    await assert.rejects(mapPool([1, 2, 3, 4], 1, async (x) => {
      started.push(x);
      if (x === 2) throw new Error('stop');
    }), /stop/);
    assert.deepStrictEqual(started, [1, 2]);
  });
});

describe('spot-check sample', () => {
  it('writes a seeded tenth of the judged items under private/spot-checks, none reviewed yet', () => {
    const home = { private: path.join(tmpDir(), 'private') };
    const rows = Array.from({ length: 25 }, (_, i) => ({
      runId: 'R', sessionId: 'S', questionId: `q${String(i).padStart(2, '0')}`, adapter: 'oracle', kind: 'user-said',
      question: `Question ${i}?`, reference: 'A', acceptableAnswers: [], reply: 'A', verdict: 'correct', reason: 'same'
    }));
    const file = spotCheckFile(home, '20260930T101500Z-abcd');
    assert.strictEqual(file, path.join(home.private, 'spot-checks', '20260930T101500Z-abcd.jsonl'));
    assert.strictEqual(writeSpotCheckSample(file, [...rows, { ...rows[0], questionId: 'x', verdict: null }], { seed: 7 }), 3);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 3);
    assert.ok(lines.every((l) => l.humanVerdict === null && l.reviewer === null && l.verdict === 'correct'));
    const again = path.join(path.dirname(file), 'again.jsonl');
    writeSpotCheckSample(again, [...rows].reverse(), { seed: 7 });
    assert.strictEqual(fs.readFileSync(again, 'utf8'), fs.readFileSync(file, 'utf8'), 'the same seed picks the same items in any order');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-answer-stage.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/answer-stage'`.

- [ ] **Step 3: Write the implementation**

Create `src/longhaul/answer-stage.js`:

```js
'use strict';
// The answer stage for one (adapter, question) item (benchmark spec §8
// steps 3 and 4, §15): the answer call on the adapter's context, then the
// judge call on the reply, both through the model cache. Returns the
// record's fields (verdicts, booleans, numbers, error codes) and, apart, the
// reply and the verdict's reason for the spot-check sample; a record never
// carries text. A call that fails after its retries is recorded as an error
// code and left out of the rates. A refused key (401/403) stops the run,
// since every later call would fail the same way.
const path = require('path');
const { cacheKey, cachedCall, stableStringify } = require('./model-cache');
const { buildAnswerPrompt, NOTHING_SHOWN } = require('./answer');
const { buildJudgePrompt, parseVerdict, scoreVerdict } = require('./judge');
const { isAuthFailure } = require('./retry');
const { sha256Text, writeFileAtomic } = require('./files');
const { createRng } = require('./rng');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/answer-stage');
const SPOT_CHECK_FRACTION = 0.1;

const EMPTY_ANSWER_FIELDS = Object.freeze({
  verdict: null, answerCorrect: null, abstainCorrect: null, answerError: null,
  answerCached: null, answerInputTokens: null, answerOutputTokens: null, answerCostUsd: null, answerLatencyMs: null,
  judgeCached: null, judgeInputTokens: null, judgeOutputTokens: null, judgeCostUsd: null
});

// The reference side of a question: editing it (in verify) makes new keys.
function questionSha256(q) {
  return sha256Text(stableStringify({ question: q.question, kind: q.kind, answer: q.answer, acceptableAnswers: q.acceptableAnswers || [] }));
}

// baseUrl is set only on a client built with --<role>-base-url; undefined
// drops out of the key, so another endpoint serving the same model name
// never shares an entry with the provider's own API.
function answerKey({ adapterConfigSha256, question, contextSha256, client, promptSha256, maxTokens }) {
  return cacheKey({
    stage: 'answer', adapterConfigSha256, sessionId: question.sessionId, questionId: question.id, questionSha256: questionSha256(question),
    contextSha256, emptyContext: NOTHING_SHOWN, provider: client.provider, model: client.model, baseUrl: client.baseUrl, promptSha256, maxTokens
  });
}

// The judge's key is the hash of the prompt as sent (like a summary's
// inputSha256): judge-v1.md, the kind rule, the reference and acceptable
// answers, the reply and the strings judge.js splices in are all in it, so
// editing any of them makes new keys, and an unchanged prompt is a hit.
function judgeKey({ answerCacheKey, prompt, client, maxTokens }) {
  return cacheKey({
    stage: 'judge', answerCacheKey, inputSha256: sha256Text(prompt),
    provider: client.provider, model: client.model, baseUrl: client.baseUrl, maxTokens
  });
}

function errorCode(stage, err) {
  if (err && err.code === 'OVER_BUDGET') return 'over-budget';
  return `${stage}-failed${Number.isInteger(err?.status) ? `:${err.status}` : ''}`;
}

async function answerAndJudge(item, deps) {
  const { question } = item;
  const fields = { ...EMPTY_ANSWER_FIELDS };
  const meta = { sessionId: question.sessionId, questionId: question.id, adapter: item.adapter };
  const failed = (stage, err, reply = null) => {
    if (isAuthFailure(err)) {
      const provider = stage === 'answer' ? deps.answerClient.provider : deps.judgeClient.provider;
      throw new UsageError(`${provider} refused the API key (${err.status}); the run stopped. Finished calls are cached, so running again costs only what is left.`, 'AUTH');
    }
    fields.answerError = errorCode(stage, err);
    log.warn('model call failed', { stage, questionId: question.id, adapter: item.adapter, code: fields.answerError });
    return { fields, reply, reason: null };
  };

  const aKey = answerKey({
    adapterConfigSha256: item.adapterConfigSha256, question, contextSha256: item.contextSha256,
    client: deps.answerClient, promptSha256: deps.prompts.answer.sha256, maxTokens: deps.answerMaxTokens
  });
  let answer;
  try {
    answer = await cachedCall({
      cache: deps.cache, stage: 'answer', key: aKey, client: deps.answerClient,
      prompt: buildAnswerPrompt(deps.prompts.answer.text, { context: item.context, question }),
      maxTokens: deps.answerMaxTokens, hooks: deps.hooks, retry: deps.retry, meta
    });
  } catch (err) {
    return failed('answer', err);
  }
  Object.assign(fields, {
    answerCached: answer.cached, answerInputTokens: answer.inputTokens, answerOutputTokens: answer.outputTokens,
    answerCostUsd: answer.costUsd, answerLatencyMs: answer.latencyMs
  });

  const judgePrompt = buildJudgePrompt(deps.prompts.judge.text, { question, reply: answer.text });
  let judged;
  try {
    judged = await cachedCall({
      cache: deps.cache, stage: 'judge',
      key: judgeKey({ answerCacheKey: aKey, prompt: judgePrompt, client: deps.judgeClient, maxTokens: deps.judgeMaxTokens }),
      client: deps.judgeClient, prompt: judgePrompt,
      maxTokens: deps.judgeMaxTokens, hooks: deps.hooks, retry: deps.retry, meta
    });
  } catch (err) {
    return failed('judge', err, answer.text);
  }
  Object.assign(fields, {
    judgeCached: judged.cached, judgeInputTokens: judged.inputTokens, judgeOutputTokens: judged.outputTokens, judgeCostUsd: judged.costUsd
  });

  const verdict = parseVerdict(judged.text);
  if (!verdict) {
    fields.answerError = 'judge-unparsed';
    log.warn('judge verdict unparsable', { questionId: question.id, adapter: item.adapter });
    return { fields, reply: answer.text, reason: null };
  }
  Object.assign(fields, { verdict: verdict.verdict }, scoreVerdict(question, verdict.verdict));
  return { fields, reply: answer.text, reason: verdict.reason };
}

// At most `limit` items at once. After the first error no new item starts;
// the ones in flight finish, then the error is thrown.
async function mapPool(items, limit, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure;
}

// The spot-check sample (spec §8 step 4) quotes questions and replies, so it
// lives under private/.
function spotCheckFile(home, runId) {
  return path.join(home.private, 'spot-checks', `${runId}.jsonl`);
}

function writeSpotCheckSample(file, rows, { seed = 1, fraction = SPOT_CHECK_FRACTION } = {}) {
  const key = (r) => `${r.sessionId}\u0000${r.questionId}\u0000${r.adapter}`;
  const judged = rows.filter((r) => r.verdict).sort((a, b) => key(a).localeCompare(key(b)));
  const n = judged.length ? Math.max(1, Math.ceil(judged.length * fraction)) : 0;
  const picked = createRng(seed).shuffle(judged).slice(0, n).sort((a, b) => key(a).localeCompare(key(b)));
  writeFileAtomic(file, (write) => {
    for (const r of picked) write(`${JSON.stringify({ ...r, humanVerdict: null, reviewer: null })}\n`);
  });
  return n;
}

module.exports = {
  SPOT_CHECK_FRACTION, EMPTY_ANSWER_FIELDS, questionSha256, answerKey, judgeKey,
  answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/longhaul-answer-stage.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/answer-stage.js tests/longhaul-answer-stage.test.js
git commit -m "feat(longhaul): answer and judge one item through the cache; errors recorded, a refused key stops"
```

---
## Task 11: The answer stage in `runBenchmark`: tiers, the priced plan, privacy and resume

**Files:**
- Modify: `src/longhaul/answer-stage.js` (add `selectQuestions`, `planCalls`), `src/longhaul/run.js` (rewritten below), `tests/helpers/longhaul-helpers.js` (add `makePrivate`)
- Test: `tests/longhaul-answer-run.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1 to 10. `sampleQuestions` (Task 5); `estimateCalls`, `checkBudget`, `SpendGuard`, `DEFAULT_MAX_USD`, `EST_CHARS_PER_TOKEN` (Task 4); `isAuthFailure`, `retryable` (Task 1); `JUDGE_RULES_SHA256` (Task 3); `capWindow` on `full-history` and `real-compaction` (Tasks 6 and 7); `Catalog#get(p, m).limits.context`; `answerAndJudge`, `answerKey`, `judgeKey`, `mapPool`, `spotCheckFile`, `writeSpotCheckSample` (Task 10); `summarize`, `compareAdapters`, `COMPARISONS`, `renderSummaryMarkdown` (Task 9); adapter properties `appliesTo`, `longContext`, `frontierOnly`, `usesModel`, `estimate`, `modelClient`, `handle.setup` (Tasks 6 to 8).
- Produces:
  - `answer-stage.js`: `TIERS = ['grid', 'frontier']`; `selectQuestions(sets, adapters, { tier, sampleSize, longContextSample, seed }) → { perSet: [{ set, questions, longQuestions }], sample: { tier, requested, questions, longContextQuestions, seed, idsSha256 } }`. `grid` refuses a `frontierOnly` adapter. `planCalls({ items, deferred, answer }) → { calls, counts: { answers, answersCached, judgments, judgmentsCached, summaries, summariesCached } }`.
  - `run.js`: `ANSWER_PROMPT_OVERHEAD_TOKENS = 1000`; `contextCapTokens({ answerClient, answerMaxTokens, catalog }) → integer | null` (the most estimated context tokens the answer model's catalog window holds, or null when unknown); `runBenchmark({ ..., answer = null })`. `answer` is `{ answerClient, judgeClient, prompts: { answer, judge, summarize }, answerMaxTokens = 400, judgeMaxTokens = 200, tier = 'grid', sampleSize = 150, longContextSample = null, maxUsd = 50, allowUnpriced = false, sendPrivate = false, dryRun = false, concurrency = 4, cache, catalog, retry, onPlan({ estimate, counts, maxUsd }), onSendPrivate({ sessions, to }) }`. An answer run returns `{ runId, dir, config, summary, records, comparisons, leaks, spend, spotChecks: { file, n }, staleTmpRemoved }`, and a dry run returns `{ dryRun: true, estimate, counts, staleTmpRemoved }`. Also exported: `RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/`.
  - `config.json` of an answer run: `stage: 'B3'`, `metric: 'answer accuracy'`, `secondaryMetrics: ['evidence recall', 'answer containment']`, and an `answer` object with `tier`, `sample`, `answerModel { provider, model, maxTokens }`, `judgeModel`, `prompts { answer, judge, summarize }` (`{ file, sha256 }` each, the judge's with `rulesSha256: JUDGE_RULES_SHA256` too, summarize null unless an adapter uses a model), `contextCapTokens`, `maxUsd`, `allowUnpriced`, `sendPrivate`, `concurrency`, `estimateUsd`, `estimateKnownUsd` and `tokens`. `config.adapters` holds each adapter's `describe()` after the cap, so a capped `full-history` shows its capped `windowTokens`.
  - `runs/<id>/spend.json`: `{ estimateUsd, estimateKnownUsd, spentUsd, calls, unpricedCalls, overBudget, setupCosts: [{ adapter, sessionId, calls, cachedCalls, costUsd, unpricedCalls }], stoppedBy }`. It is written as soon as the run dir exists and rewritten after each (adapter, session) summarizer setup and after each answered-and-judged item, so a run killed by Ctrl-C leaves it at most one item (or one session's summaries) behind. `stoppedBy` is null, or the code that stopped the run (`AUTH` for a refused key; the error's code, or `error`, for anything else).
  - A summarizer call that fails after its retries (spec §15: three) records that adapter's questions in that session as context errors `summary-failed[:status]`, and the run goes on; a summarizer's refused key (401/403) stops the run with `UsageError` code `AUTH`, as an answer's does.
  - `tests/helpers/longhaul-helpers.js`: `makePrivate(root, sessionId)`.

- [ ] **Step 1: Add the `makePrivate` helper**

In `tests/helpers/longhaul-helpers.js`, add before `module.exports` and export it:

```js
// Marks a session private, as `longhaul import` does a real one.
function makePrivate(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, private: true, license: 'private' }, null, 2)}\n`);
}

module.exports = { REPO, FIXTURE_ROOT, tmpDir, sink, tmpHome, makePrivate };
```

- [ ] **Step 2: Write the failing test**

Create `tests/longhaul-answer-run.test.js`:

```js
// tests/longhaul-answer-run.test.js
// The answer stage end to end with fake models (benchmark spec §8, §8.1,
// §10, §11, §14, §15): records and summary exactly computable; no text in
// records; a crash resumed without paying twice; a private session refused
// before any call; a plan over the cap refused before any call; the
// estimate not below the spend on the fixtures, judge included; the tiers;
// the long-context cap at the answer model's window; spend.json on disk
// when a run stops; a failing summarizer.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runBenchmark } = require('../src/longhaul/run');
const { createAdapter } = require('../src/longhaul/adapters');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { JUDGE_RULES_SHA256 } = require('../src/longhaul/judge');
const { UsageError } = require('../src/longhaul/errors');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, makePrivate } = require('./helpers/longhaul-helpers');

const catalog = fixtureCatalog();
const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
const fixedNow = () => new Date('2026-09-30T10:15:00.000Z');
const priced = (provider, model, input, output) => catalog.price(provider, model, { input, output }).usd;

function setup(fixtures = [SYNTH_FIXTURES[0]]) {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, fixtures);
  return home;
}
async function allQuestions(home) {
  const out = [];
  for (const id of fs.readdirSync(path.join(home.root, 'sessions'))) out.push(...await readQuestions(questionsFile(home.root, id)));
  return out;
}
// Only the prompt's own "Question: " line names the question: earlier
// questions appear in contexts as plain user messages.
const findQuestion = (questions, prompt) => questions.find((q) => prompt.includes(`Question: ${q.question}`));

// Answers with the planted value when the context holds it, else declines.
// replyChars pads every reply to that length (and reports maxTokens output).
function answerFake(questions, { crashAt = null, replyChars = null } = {}) {
  const seen = [];
  return {
    provider: 'openai', model: 'gpt-6-lite', prompts: seen,
    async complete(prompt, { maxTokens }) {
      seen.push(prompt);
      if (crashAt !== null && seen.length === crashAt) throw Object.assign(new Error('unauthorized'), { status: 401 });
      const q = findQuestion(questions, prompt);
      const ctx = prompt.slice(prompt.indexOf('<context>'), prompt.indexOf('</context>'));
      let text = q && q.kind !== 'abstain' && ctx.includes(q.acceptableAnswers[0]) ? `It is ${q.acceptableAnswers[0]}.` : "I don't know";
      if (replyChars) text = text.padEnd(replyChars, '.');
      const input = Math.ceil(prompt.length / 4);
      const output = replyChars ? maxTokens : 5;
      return { text, llmMetrics: { inputTokens: input, outputTokens: output, costUsd: priced('openai', 'gpt-6-lite', input, output) } };
    }
  };
}

// Correct when the reply holds the planted value, abstained on a decline,
// incorrect otherwise; raw(q) may return a raw reply instead.
function judgeFake(questions, { raw = () => null } = {}) {
  const seen = [];
  return {
    provider: 'anthropic', model: 'claude-haiku-4-5', prompts: seen,
    async complete(prompt) {
      seen.push(prompt);
      const q = findQuestion(questions, prompt);
      const reply = prompt.slice(prompt.indexOf('<reply>') + '<reply>'.length, prompt.indexOf('</reply>'));
      const verdict = /I don't know/.test(reply) ? 'abstained' : (q.kind !== 'abstain' && reply.includes(q.acceptableAnswers[0]) ? 'correct' : 'incorrect');
      const text = raw(q) ?? JSON.stringify({ verdict, reason: 'fake reason' });
      const input = Math.ceil(prompt.length / 4);
      return { text, llmMetrics: { inputTokens: input, outputTokens: 12, costUsd: priced('anthropic', 'claude-haiku-4-5', input, 12) } };
    }
  };
}

// Shows nothing useful: every answerable question is declined.
const blind = {
  name: 'blind',
  describe: () => ({ name: 'blind' }),
  prepare: async (session) => ({ session }),
  context: async () => ({ text: 'nothing relevant here', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 6, latencyMs: 1, cpuMs: 1, cost: 0 }),
  release: async () => {}
};

function answerOptions(home, questions, over = {}) {
  return {
    answerClient: answerFake(questions), judgeClient: judgeFake(questions), prompts, catalog,
    cache: ModelCache.forHome(home), concurrency: 1, retry: { wait: async () => {} }, ...over
  };
}

describe('answer stage', () => {
  it('answers and judges every context; records carry verdicts and numbers, never text', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions);
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: opts, now: fixedNow, commit: 'abc' });
    assert.strictEqual(out.records.length, 12);
    const oracle = out.summary.oracle.answer;
    assert.strictEqual(oracle.accuracy, 1);
    assert.deepStrictEqual(oracle.abstain, { n: 1, accuracy: 1, falseAnswerRate: 0 });
    const b = out.summary.blind.answer;
    assert.strictEqual(b.accuracy, 0);
    assert.strictEqual(b.declinedRate, 1);
    assert.strictEqual(b.abstain.accuracy, 1);

    assert.strictEqual(out.config.stage, 'B3');
    assert.strictEqual(out.config.metric, 'answer accuracy');
    assert.deepStrictEqual(out.config.answer.prompts.answer, { file: 'answer-v1.md', sha256: prompts.answer.sha256 });
    assert.deepStrictEqual(out.config.answer.prompts.judge, { file: 'judge-v1.md', sha256: prompts.judge.sha256, rulesSha256: JUDGE_RULES_SHA256 });
    assert.strictEqual(out.config.answer.prompts.summarize, null);
    assert.deepStrictEqual(out.config.answer.answerModel, { provider: 'openai', model: 'gpt-6-lite', maxTokens: 400 });
    assert.strictEqual(out.config.answer.tier, 'grid');
    assert.strictEqual(out.config.commit, 'abc');

    const raw = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8');
    for (const q of questions) assert.ok(!raw.includes(q.question), 'no question text in records');
    assert.ok(!raw.includes("I don't know") && !raw.includes('fake reason'), 'no reply or reason in records');
    const spend = JSON.parse(fs.readFileSync(path.join(out.dir, 'spend.json'), 'utf8'));
    assert.strictEqual(spend.calls, 24);
    assert.ok(spend.spentUsd > 0);
    assert.match(fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8'), /## Answer accuracy/);

    assert.deepStrictEqual(out.spotChecks, { file: spotCheckFile(home, out.runId), n: 2 });
    assert.strictEqual(fs.readFileSync(out.spotChecks.file, 'utf8').trim().split('\n').length, 2);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'the context texts are removed');
  });

  it('resumes after a crash without paying for a finished call twice', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const first = answerOptions(home, questions, { answerClient: answerFake(questions, { crashAt: 7 }) });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: first, now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'AUTH'
    );
    assert.strictEqual(first.judgeClient.prompts.length, 6);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'a crashed run removes its context texts too');
    // The stopped run's spend is on disk: 6 answers and 6 judgments finished before the 401.
    const [stopped] = fs.readdirSync(home.runs);
    const stoppedSpend = JSON.parse(fs.readFileSync(path.join(home.runs, stopped, 'spend.json'), 'utf8'));
    assert.strictEqual(stoppedSpend.calls, 12);
    assert.strictEqual(stoppedSpend.stoppedBy, 'AUTH');
    assert.ok(stoppedSpend.spentUsd > 0);

    let counts = null;
    const second = answerOptions(home, questions, { onPlan: (p) => { counts = p.counts; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: second, now: fixedNow, commit: 'x' });
    assert.deepStrictEqual(counts, { answers: 6, answersCached: 6, judgments: 6, judgmentsCached: 6, summaries: 0, summariesCached: 0 });
    assert.strictEqual(second.answerClient.prompts.length, 6);
    assert.strictEqual(second.judgeClient.prompts.length, 6);
    assert.strictEqual(out.records.filter((r) => r.answerCached === true).length, 6);
    assert.strictEqual(out.spend.calls, 12);
  });

  it('refuses a private session without --send-private before any call, and writes no run', async () => {
    const home = setup();
    makePrivate(home.root, 'synth-small');
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }),
      (err) => err.code === 'PRIVATE_SESSION' && /synth-small is private/.test(err.message) && /--send-private/.test(err.message)
    );
    assert.strictEqual(opts.answerClient.prompts.length + opts.judgeClient.prompts.length, 0);
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);

    const dry = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, dryRun: true }, now: fixedNow, commit: 'x' });
    assert.strictEqual(dry.dryRun, true);

    const told = [];
    const sent = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, sendPrivate: true, onSendPrivate: (x) => told.push(x) }, now: fixedNow, commit: 'x' });
    assert.strictEqual(sent.records.length, 6);
    assert.deepStrictEqual(told, [{ sessions: ['synth-small'], to: ['anthropic/claude-haiku-4-5', 'openai/gpt-6-lite'] }]);
  });

  it('refuses a plan over the cap before any call; --dry-run prices it and calls nothing', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions, { maxUsd: 0.000001 });
    await assert.rejects(runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }), (err) => err.code === 'OVER_BUDGET');
    let plan = null;
    const dry = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, dryRun: true, onPlan: (p) => { plan = p; } }, now: fixedNow, commit: 'x' });
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(dry.estimate.lines.map((l) => [l.role, l.adapter, l.calls]), [['answer', 'oracle', 6], ['judge', 'oracle', 6]]);
    assert.strictEqual(plan.counts.answers, 6);
    assert.strictEqual(opts.answerClient.prompts.length + opts.judgeClient.prompts.length, 0);
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
  });

  it('refuses a model the catalog cannot price unless told to run anyway', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const unpriced = { ...answerFake(questions), model: 'no-such-model' };
    const opts = answerOptions(home, questions, { answerClient: unpriced });
    await assert.rejects(runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }), (err) => err.code === 'UNPRICED');
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, allowUnpriced: true }, now: fixedNow, commit: 'x' });
    assert.strictEqual(out.config.answer.estimateUsd, null);
  });

  it('does not estimate below what the run spends on the fixtures, the judge included', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    let estimate = null;
    // Every reply fills answerMaxTokens, the most a judge can be asked to read.
    const opts = answerOptions(home, questions, { answerMaxTokens: 100, answerClient: answerFake(questions, { replyChars: 400 }), onPlan: (p) => { estimate = p.estimate; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), createAdapter('sliding-window')], answer: opts, now: fixedNow, commit: 'x' });
    const judgeEstimate = estimate.lines.filter((l) => l.role === 'judge').reduce((n, l) => n + l.usd, 0);
    const judgeSpent = out.records.reduce((n, r) => n + r.judgeCostUsd, 0);
    assert.ok(judgeSpent <= judgeEstimate, `judge spent ${judgeSpent} > estimated ${judgeEstimate}`);
    assert.ok(out.spend.spentUsd <= estimate.totalUsd, `spent ${out.spend.spentUsd} > estimated ${estimate.totalUsd}`);
  });

  it('records judge-unparsed, leaves it out of accuracy and counts it', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions, { judgeClient: judgeFake(questions, { raw: (q) => (q.kind === 'user-said' ? 'The reply looks right to me.' : null) }) });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' });
    assert.strictEqual(out.records.find((r) => r.kind === 'user-said').answerError, 'judge-unparsed');
    assert.strictEqual(out.summary.oracle.answer.errors, 1);
    assert.strictEqual(out.summary.oracle.answer.n, 4);
    assert.strictEqual(out.summary.oracle.answer.accuracy, 1);
  });

  it('refuses full-history in the grid tier; the frontier tier samples and gives long-context adapters the first N', async () => {
    const home = setup(SYNTH_FIXTURES);
    const questions = await allQuestions(home);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('full-history')], answer: answerOptions(home, questions), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && /frontier tier/.test(err.message)
    );
    const out = await runBenchmark({
      home, adapters: [createAdapter('oracle'), createAdapter('full-history')], now: fixedNow, commit: 'x',
      answer: answerOptions(home, questions, { tier: 'frontier', sampleSize: 10, longContextSample: 4 })
    });
    assert.strictEqual(out.records.filter((r) => r.adapter === 'oracle').length, 10);
    assert.strictEqual(out.records.filter((r) => r.adapter === 'full-history').length, 4);
    assert.strictEqual(out.config.answer.sample.questions, 10);
    assert.strictEqual(out.config.answer.sample.longContextQuestions, 4);
    const oracleIds = new Set(out.records.filter((r) => r.adapter === 'oracle').map((r) => r.questionId));
    assert.ok(out.records.filter((r) => r.adapter === 'full-history').every((r) => oracleIds.has(r.questionId)));
    // The fixture catalog gives openai/gpt-6-lite a 64,000-token window
    // (tests/fixtures/models/models-dev.json): (64000 - 400 reply - 1000
    // prompt) x 3/4 = 46,950 estimated tokens, below full-history's 128K.
    assert.strictEqual(out.config.answer.contextCapTokens, 46950);
    assert.strictEqual(out.config.adapters.find((d) => d.name === 'full-history').windowTokens, 46950);
    assert.ok(out.records.filter((r) => r.adapter === 'full-history' && !r.error).every((r) => r.estTokens <= 46950));
  });

  it('refuses a judge that is the answer model', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const same = answerFake(questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: answerOptions(home, questions, { judgeClient: same }), now: fixedNow, commit: 'x' }),
      /judge is never the answer model/
    );
  });

  it('runs summarize-compact after the estimate, counting its summaries as setup cost', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const summarizer = { provider: 'fake', model: 'fake-summarizer', local: true, prompts: [], async complete(p) { this.prompts.push(p); return { text: 'a summary', llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; } };
    const cache = ModelCache.forHome(home);
    const make = () => createAdapter('summarize-compact', { compactEveryTokens: 2000, summarizer: { client: summarizer, cache, prompt: prompts.summarize } });
    await runBenchmark({ home, adapters: [make()], answer: answerOptions(home, questions, { cache, dryRun: true }), now: fixedNow, commit: 'x' });
    assert.strictEqual(summarizer.prompts.length, 0, 'a dry run makes no summary');
    const out = await runBenchmark({ home, adapters: [make()], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' });
    assert.strictEqual(out.records.length, 6);
    assert.ok(out.records.every((r) => typeof r.verdict === 'string'));
    assert.strictEqual(out.spend.setupCosts.length, 1);
    assert.strictEqual(out.spend.setupCosts[0].calls, summarizer.prompts.length);
    assert.ok(out.config.answer.prompts.summarize.sha256 === prompts.summarize.sha256);
  });

  it('stops on a summarizer whose key is refused, and records a summarizer that fails after its retries', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const failing = (status) => ({
      provider: 'openai', model: 'gpt-6-lite', prompts: [],
      async complete(p) { this.prompts.push(p); throw Object.assign(new Error(`status ${status}`), { status }); }
    });
    const cache = ModelCache.forHome(home);
    const make = (client) => createAdapter('summarize-compact', {
      compactEveryTokens: 2000, summarizer: { client, cache, prompt: prompts.summarize, retry: { wait: async () => {} } }
    });

    const refused = failing(401);
    await assert.rejects(
      runBenchmark({ home, adapters: [make(refused)], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'AUTH' && /summarizer/.test(err.message)
    );
    assert.strictEqual(refused.prompts.length, 1, 'a refused key is not retried');
    const [stopped] = fs.readdirSync(home.runs);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home.runs, stopped, 'spend.json'), 'utf8')).stoppedBy, 'AUTH');

    const down = failing(503);
    const out = await runBenchmark({ home, adapters: [make(down), createAdapter('oracle')], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' });
    assert.strictEqual(down.prompts.length, 4, 'one call and three retries (spec §15)');
    const sc = out.records.filter((r) => r.adapter === 'summarize-compact');
    assert.strictEqual(sc.length, 6);
    assert.ok(sc.every((r) => r.error === 'summary-failed:503' && r.verdict === undefined));
    assert.ok(out.records.filter((r) => r.adapter === 'oracle').every((r) => typeof r.verdict === 'string'));
    assert.strictEqual(out.spend.stoppedBy, null);
  });

  it('refuses summarize-compact in a run without the answer stage', async () => {
    const home = setup();
    await assert.rejects(runBenchmark({ home, adapterNames: ['summarize-compact'], now: fixedNow, commit: 'x' }), /runs only in the answer stage/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/longhaul-answer-run.test.js`
Expected: FAIL. `runBenchmark` ignores `answer` (its records have no `verdict`, and `summary.oracle.answer` is null).

- [ ] **Step 4: Add `selectQuestions` and `planCalls` to `answer-stage.js`**

In `src/longhaul/answer-stage.js`, add these requires:

```js
const { sampleQuestions } = require('./sampling');
const { bucketFor, computeDistance } = require('./questions');
```

and before `module.exports`:

```js
const TIERS = Object.freeze(['grid', 'frontier']);

// Which questions each adapter answers (benchmark spec §8.1). grid: every
// question, every adapter except the frontier-only full-history. frontier:
// a stratified sample (sampling.js sampleQuestions, seeded) of sampleSize.
// In either tier the long-context adapters (full-history, real-compaction)
// get only the first longContextSample of the stratified order, since at
// 90-128K tokens a question they are the cost of a run (measured facts;
// decision D3).
function selectQuestions(sets, adapters, { tier = 'grid', sampleSize = 150, longContextSample = null, seed = 1 } = {}) {
  if (!TIERS.includes(tier)) throw new UsageError(`--tier must be grid or frontier, got ${JSON.stringify(tier)}`);
  if (tier === 'grid') {
    const frontierOnly = adapters.filter((a) => a.frontierOnly).map((a) => a.name);
    if (frontierOnly.length) throw new UsageError(`${frontierOnly.join(', ')} runs only in the frontier tier (benchmark spec section 8.1); pass --tier frontier.`);
  }
  if (longContextSample !== null && !(Number.isInteger(longContextSample) && longContextSample > 0)) {
    throw new UsageError('--long-context-sample must be a positive whole number');
  }
  const items = sets.flatMap((set) => set.questions.map((q) => ({ question: q, bucket: bucketFor(computeDistance(set.session.index, q)) })));
  const ordered = sampleQuestions(items, { size: Math.max(1, tier === 'frontier' ? sampleSize : items.length), seed });
  const keyOf = (q) => `${q.sessionId}\u0000${q.id}`;
  const chosen = new Set(ordered.map((it) => keyOf(it.question)));
  const long = new Set(ordered.slice(0, longContextSample ?? ordered.length).map((it) => keyOf(it.question)));
  return {
    perSet: sets.map((set) => ({
      set,
      questions: set.questions.filter((q) => chosen.has(keyOf(q))),
      longQuestions: set.questions.filter((q) => long.has(keyOf(q)))
    })),
    sample: {
      tier, requested: tier === 'frontier' ? sampleSize : null, questions: chosen.size, longContextQuestions: long.size, seed,
      idsSha256: sha256Text([...chosen].sort().join('\n'))
    }
  };
}

// The calls a run would make now, for the estimate: an answer per item whose
// reply is not cached, and a judgment per item whose verdict is not cached,
// its reply counted at answerMaxTokens when not written yet. Adapters that
// need a model for their context (deferred) add their summaries, and an
// answer and a judgment per question with the context at the adapter's
// estimate.
function planCalls({ items, deferred, answer: a }) {
  const calls = [];
  const counts = { answers: 0, answersCached: 0, judgments: 0, judgmentsCached: 0, summaries: 0, summariesCached: 0 };
  const model = (c) => ({ provider: c.provider, model: c.model, local: Boolean(c.local) });
  const answerChars = (contextChars, q) => a.prompts.answer.text.length + contextChars + q.question.length;
  const judgeChars = (q) => buildJudgePrompt(a.prompts.judge.text, { question: q, reply: '' }).length;
  const pushAnswer = (adapter, q, contextChars) => {
    calls.push({ role: 'answer', adapter, ...model(a.answerClient), inputChars: answerChars(contextChars, q), maxTokens: a.answerMaxTokens });
    counts.answers += 1;
  };
  const pushJudge = (adapter, q, reply) => {
    calls.push({
      role: 'judge', adapter, ...model(a.judgeClient),
      inputChars: judgeChars(q) + (reply === null ? 0 : reply.length), extraInputTokens: reply === null ? a.answerMaxTokens : 0, maxTokens: a.judgeMaxTokens
    });
    counts.judgments += 1;
  };
  for (const it of items) {
    if (it.record.error) continue;
    const aKey = answerKey({
      adapterConfigSha256: it.adapterConfigSha256, question: it.q, contextSha256: it.contextSha256,
      client: a.answerClient, promptSha256: a.prompts.answer.sha256, maxTokens: a.answerMaxTokens
    });
    const hit = a.cache.get('answer', aKey);
    if (hit) counts.answersCached += 1;
    else pushAnswer(it.adapter.name, it.q, it.contextChars);
    const judged = hit && a.cache.get('judge', judgeKey({
      answerCacheKey: aKey, prompt: buildJudgePrompt(a.prompts.judge.text, { question: it.q, reply: hit.text }), client: a.judgeClient, maxTokens: a.judgeMaxTokens
    }));
    if (judged) counts.judgmentsCached += 1;
    else pushJudge(it.adapter.name, it.q, hit ? hit.text : null);
  }
  for (const d of deferred) {
    for (const c of d.estimate.calls) calls.push({ role: 'summary', adapter: d.adapter.name, ...c });
    counts.summaries += d.estimate.calls.length;
    counts.summariesCached += d.estimate.cached;
    for (const q of d.qs) {
      pushAnswer(d.adapter.name, q, d.estimate.contextChars);
      pushJudge(d.adapter.name, q, null);
    }
  }
  return { calls, counts };
}
```

Add `TIERS, selectQuestions, planCalls` to the `module.exports` object.

- [ ] **Step 5: Rewrite `run.js`**

Replace `src/longhaul/run.js` with:

```js
'use strict';
// `longhaul run` (benchmark spec §8, §8.1, §11, §15). Without an answer model
// it is stage B0: each adapter's context at each question's askAtSeq, scored
// by evidence recall and answer containment, no model call. With an answer
// and a judge model (stage B3), pass 1 builds every context locally and
// keeps its text in LONGHAUL_HOME/tmp/kl-ctx-<runId>/; the plan of model
// calls is priced from the catalog and checked against the cap before any
// call; pass 2 makes the summarizer, answer and judge calls through the model
// cache (LONGHAUL_HOME/private/model-cache), so a run cut off mid-way resumes
// for nothing. Records hold ids, seqs, verdicts and numbers only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadSession, listSessions, sessionDir, CHARS_PER_TOKEN } = require('./session-format');
const { readQuestions, questionsFile, validateQuestionSet, isVerified, bucketFor, computeDistance } = require('./questions');
const { createAdapter } = require('./adapters');
const {
  evidenceRecall, chunkEvidenceRecall, answerContainment, summarize, renderSummaryMarkdown, compareAdapters, COMPARISONS
} = require('./scoring');
const { writeFileAtomic, sha256File, sha256Text } = require('./files');
const { ModelCache, stableStringify } = require('./model-cache');
const { selectQuestions, planCalls, answerAndJudge, mapPool, spotCheckFile, writeSpotCheckSample } = require('./answer-stage');
const { estimateCalls, checkBudget, SpendGuard, DEFAULT_MAX_USD, EST_CHARS_PER_TOKEN } = require('./cost');
const { JUDGE_RULES_SHA256 } = require('./judge');
const { isAuthFailure, retryable } = require('./retry');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/run');
// kl-recall's temp store prefix (adapters/kl-recall.js TMP_PREFIX), kept
// here so a run without kl-recall does not load node:sqlite. `embed`'s temp
// dir (kl-embed-<pid>) and the answer stage's context dir (kl-ctx-<runId>)
// share it, so this covers all three.
const KL_TMP_PREFIX = 'kl-';
const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
// The answer prompt's own text and the question, in tokens, on top of the
// context (answer-v1.md is about 150 words; a question is one line).
const ANSWER_PROMPT_OVERHEAD_TOKENS = 1000;

// Temp dirs an interrupted run or embed (Ctrl-C, crash) left behind.
// prefix narrows it (embed removes only kl-embed-* dirs).
function removeStaleTmp(tmpDir, prefix = KL_TMP_PREFIX) {
  if (!tmpDir || !fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    fs.rmSync(path.join(tmpDir, e.name), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) log.info('removed temp dirs left by an interrupted run', { removed });
  return removed;
}

function gitCommit(cwd = path.join(__dirname, '..', '..')) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = git(['rev-parse', 'HEAD']);
    return git(['status', '--porcelain', '--untracked-files=no']) ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

function newRunId(date) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

async function loadRunSet({ dataRoot, sessionIds, includeUnverified }) {
  const ids = sessionIds && sessionIds.length ? sessionIds : listSessions(dataRoot);
  if (!ids.length) throw new UsageError(`No sessions under ${path.join(dataRoot, 'sessions')}.`);
  const sets = [];
  const skipped = [];
  for (const id of ids) {
    const dir = sessionDir(dataRoot, id);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${id}" under ${path.join(dataRoot, 'sessions')}.`);
    const qFile = questionsFile(dataRoot, id);
    if (!fs.existsSync(qFile)) { skipped.push({ sessionId: id, reason: 'no questions file' }); continue; }
    const session = await loadSession(dir);
    const all = await readQuestions(qFile);
    const problems = validateQuestionSet(all, { index: session.index, sessionId: id });
    if (problems.length) {
      const [p] = problems;
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more questions)` : '';
      throw new UsageError(`The question set for ${id} fails validation; fix it with longhaul verify. ${p.id}: ${p.errors[0]}${more}`);
    }
    const questions = all
      .filter((q) => includeUnverified || isVerified(q))
      .sort((a, b) => a.askAtSeq - b.askAtSeq || a.id.localeCompare(b.id));
    sets.push({ session, questions, verified: all.filter(isVerified).length, questionsSha256: await sha256File(qFile) });
  }
  if (sets.reduce((n, s) => n + s.questions.length, 0) === 0) {
    throw new UsageError(includeUnverified ? 'No questions to run.' : 'No verified questions to run (a smoke run can pass --include-unverified).');
  }
  return { sets, skipped };
}

// Adapters that do not apply to a session (real-compaction on a session with
// no recorded compactions) are skipped there and listed in config.json.
function adapterSkips(adapters, sets) {
  const out = [];
  for (const { session } of sets) {
    for (const a of adapters) {
      if (typeof a.appliesTo === 'function' && !a.appliesTo(session)) {
        out.push({ adapter: a.name, sessionId: session.manifest.sessionId, reason: a.skipReason || 'does not apply' });
      }
    }
  }
  return out;
}

const isSkipped = (skips, adapter, session) => skips.some((s) => s.adapter === adapter.name && s.sessionId === session.manifest.sessionId);

// One question's context from one adapter, scored without a model: the record
// (ids and numbers) and, apart, the context text, which never enters a record.
async function scoreOne({ runId, adapter, handle, session, q, budgetTokens }) {
  const base = {
    runId, sessionId: q.sessionId, questionId: q.id, adapter: adapter.name, kind: q.kind,
    bucket: bucketFor(computeDistance(session.index, q)), askAtSeq: q.askAtSeq, evidenceSeqs: q.evidenceSeqs, verified: isVerified(q)
  };
  try {
    const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens });
    // Evidence recall counts only messages shown whole; partly shown
    // evidence is reported apart. The leak check covers both.
    const shown = r.evidenceSeqsShown || [];
    const whole = new Set(shown);
    const partial = (r.evidenceSeqsPartial || []).filter((s) => !whole.has(s));
    const partialSet = new Set(partial);
    // Secondary metric: the answer text in the context. Booleans only; the
    // record never carries the text. null for abstain.
    const contained = answerContainment(r.text, q);
    const record = {
      ...base,
      evidenceSeqsShown: shown,
      evidenceSeqsPartial: partial,
      evidenceRecall: evidenceRecall(q.evidenceSeqs, shown),
      evidencePartial: q.evidenceSeqs.filter((s) => partialSet.has(s)).length,
      answerContained: contained ? contained.strict : null,
      answerTokensContained: contained ? contained.tokens : null,
      chunkEvidenceRecall: chunkEvidenceRecall(q.evidenceSeqs, r.chunks),
      estTokens: r.estTokens, latencyMs: r.latencyMs, cpuMs: r.cpuMs, cost: r.cost ?? 0,
      // null for an adapter that never reports cutting (kl-recall, oracle):
      // "not known", not "not cut".
      contextTruncated: typeof r.truncated === 'boolean' ? r.truncated : null,
      leaked: [...shown, ...partial].filter((s) => s >= q.askAtSeq).length,
      error: null
    };
    return { record, text: String(r.text ?? '') };
  } catch (err) {
    const record = {
      ...base, evidenceSeqsShown: [], evidenceSeqsPartial: [], evidenceRecall: null, evidencePartial: 0, chunkEvidenceRecall: null,
      answerContained: null, answerTokensContained: null,
      estTokens: null, latencyMs: null, cpuMs: null, cost: 0, contextTruncated: null, leaked: 0, error: err.message
    };
    return { record, text: null };
  }
}

function baseConfig(run, runId) {
  return {
    runId,
    createdAt: run.now().toISOString(),
    benchmark: 'LongHaul',
    stage: 'B0',
    metric: 'evidence recall',
    secondaryMetrics: ['answer containment'],
    commit: run.commit,
    node: process.version,
    budgetTokens: run.budgetTokens,
    seed: run.seed,
    includeUnverified: run.includeUnverified,
    dataRoot: path.resolve(run.dataRoot) === path.resolve(run.home.root) ? '$LONGHAUL_HOME' : path.basename(run.dataRoot),
    adapters: run.adapters.map((a) => a.describe()),
    sessions: run.sets.map(({ session, questions, verified, questionsSha256 }) => ({
      sessionId: session.manifest.sessionId, source: session.manifest.source, private: session.manifest.private,
      license: session.manifest.license, questions: questions.length, verifiedQuestions: verified, questionsSha256
    })),
    skippedSessions: run.skipped,
    skippedAdapters: run.skippedAdapters
  };
}

const comparisonsOf = (records) => COMPARISONS.map((c) => ({ ...c, result: compareAdapters(records, c.a, c.b) })).filter((c) => c.result);

function finish({ run, runId, dir, config, records, spend = null, setupCosts = [] }) {
  const summary = summarize(records, { setupCosts });
  const comparisons = comparisonsOf(records);
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (spend) writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), renderSummaryMarkdown(config, summary, { spend, comparisons }));
  const leaks = Object.values(summary).reduce((n, s) => n + s.leaks, 0);
  return { runId, dir, config, summary, records, comparisons, leaks, spend, staleTmpRemoved: run.staleTmpRemoved };
}

async function runBenchmark({
  home, dataRoot = home.root, sessionIds = null, adapterNames = [], adapterConfig = {}, adapters: injected = null,
  budgetTokens = 6000, seed = 1, includeUnverified = false, now = () => new Date(), commit = gitCommit(), answer = null
}) {
  const staleTmpRemoved = removeStaleTmp(home.tmp);
  const adapters = injected || adapterNames.map((name) => createAdapter(name, { budgetTokens, tmpRoot: home.tmp, ...(adapterConfig[name] || {}) }));
  if (!adapters.length) throw new UsageError('Name at least one adapter with --adapters.');
  if (!answer) {
    const needModel = adapters.filter((a) => a.usesModel).map((a) => a.name);
    if (needModel.length) {
      throw new UsageError(`${needModel.join(', ')} calls a summarizer model, so it runs only in the answer stage (--answer-model and --judge-model, or --fake-models).`);
    }
  }
  const { sets, skipped } = await loadRunSet({ dataRoot, sessionIds, includeUnverified });
  const run = {
    home, dataRoot, adapters, sets, skipped, skippedAdapters: adapterSkips(adapters, sets),
    budgetTokens, seed, includeUnverified, now, commit, staleTmpRemoved
  };
  return answer ? runAnswerStage(run, answer) : runEvidenceOnly(run);
}

async function runEvidenceOnly(run) {
  const { home, adapters, sets, budgetTokens, now } = run;
  const runId = newRunId(now());
  const dir = path.join(home.runs, runId);
  fs.mkdirSync(dir, { recursive: true });
  const config = baseConfig(run, runId);
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, '');
  const records = [];
  for (const { session, questions } of sets) {
    if (!questions.length) continue;
    const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
    for (const adapter of adapters) {
      if (isSkipped(run.skippedAdapters, adapter, session)) continue;
      const handle = await adapter.prepare(session, { upToSeq });
      try {
        for (const q of questions) {
          const { record } = await scoreOne({ runId, adapter, handle, session, q, budgetTokens });
          records.push(record);
          fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  }
  return finish({ run, runId, dir, config, records });
}

// A model call carrying a private session's text needs --send-private: the
// answer call (context), the judge call (question and references) and the
// summarizer (its window). Checked before any client is used; a dry run
// makes no call and needs no flag. Local fakes send nothing anywhere.
function assertMaySend(run, a) {
  const privateIds = run.sets.filter((s) => s.session.manifest.private).map((s) => s.session.manifest.sessionId);
  const remote = [a.answerClient, a.judgeClient, ...run.adapters.map((x) => x.modelClient).filter(Boolean)].filter((c) => !c.local);
  if (!privateIds.length || !remote.length || a.dryRun) return;
  const to = [...new Set(remote.map((c) => `${c.provider}/${c.model}`))].sort();
  if (!a.sendPrivate) {
    const one = privateIds.length === 1;
    throw new UsageError(`Session${one ? '' : 's'} ${privateIds.join(', ')} ${one ? 'is' : 'are'} private: the answer stage sends context from `
      + `${one ? 'it' : 'them'}, the questions and their reference answers to ${to.join(', ')}. Pass --send-private to allow that.`, 'PRIVATE_SESSION');
  }
  a.onSendPrivate({ sessions: privateIds, to });
}

// The most estimated context tokens (characters / 4) the answer model's
// window holds (benchmark spec §7: full-history is what "fits the model's
// window"): the catalog's context, less the reply (answerMaxTokens) and the
// prompt's own text, converted at 3 characters a real token so that dense
// text at the cap still fits. null when the catalog does not know the window
// (a local fake, an unknown model); the adapters then keep their own 128K.
function contextCapTokens({ answerClient, answerMaxTokens, catalog }) {
  if (answerClient.local || !catalog || typeof catalog.get !== 'function') return null;
  const window = catalog.get(answerClient.provider, answerClient.model)?.limits?.context;
  if (!Number.isFinite(window) || window <= 0) return null;
  return Math.max(0, Math.floor(((window - answerMaxTokens - ANSWER_PROMPT_OVERHEAD_TOKENS) * EST_CHARS_PER_TOKEN) / CHARS_PER_TOKEN));
}

function answerConfig(a, adapters, selection, estimate, cap) {
  const prompt = (p) => (p ? { file: p.file, sha256: p.sha256 } : null);
  return {
    tier: a.tier,
    sample: selection.sample,
    answerModel: { provider: a.answerClient.provider, model: a.answerClient.model, maxTokens: a.answerMaxTokens },
    judgeModel: { provider: a.judgeClient.provider, model: a.judgeClient.model, maxTokens: a.judgeMaxTokens },
    prompts: {
      answer: prompt(a.prompts.answer),
      // judge.js splices its kind rules and fixed texts into judge-v1.md;
      // rulesSha256 names them (the judge's cache key covers the rendered prompt).
      judge: { ...prompt(a.prompts.judge), rulesSha256: JUDGE_RULES_SHA256 },
      summarize: adapters.some((x) => x.usesModel) ? prompt(a.prompts.summarize) : null
    },
    contextCapTokens: cap,
    maxUsd: a.maxUsd,
    allowUnpriced: a.allowUnpriced,
    sendPrivate: a.sendPrivate,
    concurrency: a.concurrency,
    estimateUsd: estimate.totalUsd,
    estimateKnownUsd: estimate.knownUsd,
    tokens: 'context tokens are estimated (characters / 4); answer and judge tokens come from provider usage'
  };
}

function recordOrder(adapters) {
  const rank = new Map(adapters.map((a, i) => [a.name, i]));
  return (x, y) => x.sessionId.localeCompare(y.sessionId) || rank.get(x.adapter) - rank.get(y.adapter)
    || x.askAtSeq - y.askAtSeq || x.questionId.localeCompare(y.questionId);
}

async function runAnswerStage(run, answer) {
  const { home, now, seed } = run;
  const a = {
    answerMaxTokens: 400, judgeMaxTokens: 200, tier: 'grid', sampleSize: 150, longContextSample: null, maxUsd: DEFAULT_MAX_USD,
    allowUnpriced: false, sendPrivate: false, dryRun: false, concurrency: 4, retry: {}, onPlan: () => {}, onSendPrivate: () => {},
    ...answer
  };
  a.cache = a.cache || ModelCache.forHome(home);
  a.catalog = a.catalog || require('../models').getActiveCatalog();
  if (!a.answerClient || !a.judgeClient || !a.prompts?.answer || !a.prompts?.judge) {
    throw new UsageError('The answer stage needs an answer model and a judge model (--answer-provider/--answer-model, --judge-provider/--judge-model).');
  }
  if (a.answerClient.provider === a.judgeClient.provider && a.answerClient.model === a.judgeClient.model) {
    throw new UsageError(`The judge is never the answer model (benchmark spec section 8); ${a.answerClient.provider}/${a.answerClient.model} is both. Pick another --judge-model.`);
  }
  assertMaySend(run, a);
  // full-history and real-compaction never get more than the answer model
  // holds: an overflow would be a 400 recorded as an error, which would bias
  // long-context accuracy. describe() then shows the capped window, so
  // config.json and the answer cache keys carry it.
  const cap = contextCapTokens(a);
  run.adapters = run.adapters.map((x) => (cap !== null && typeof x.capWindow === 'function' ? x.capWindow(cap) : x));
  const { adapters } = run;
  const selection = selectQuestions(run.sets, adapters, { tier: a.tier, sampleSize: a.sampleSize, longContextSample: a.longContextSample, seed });

  const runId = newRunId(now());
  const ctxDir = path.join(home.tmp, `${KL_TMP_PREFIX}ctx-${runId}`);
  fs.mkdirSync(ctxDir, { recursive: true });
  const describeSha = new Map(adapters.map((x) => [x, sha256Text(stableStringify(x.describe()))]));
  const items = [];
  const contextItem = async (adapter, handle, session, q) => {
    const { record, text } = await scoreOne({ runId, adapter, handle, session, q, budgetTokens: run.budgetTokens });
    record.tier = a.tier;
    const item = { adapter, q, record, adapterConfigSha256: describeSha.get(adapter) };
    if (text !== null) {
      item.contextFile = path.join(ctxDir, `${items.length}.txt`);
      fs.writeFileSync(item.contextFile, text);
      item.contextChars = text.length;
      item.contextSha256 = sha256Text(text);
    }
    items.push(item);
  };

  try {
    // Pass 1: every context that needs no model, built here, nothing sent.
    const deferred = [];
    for (const { set, questions, longQuestions } of selection.perSet) {
      const { session } = set;
      for (const adapter of adapters) {
        if (isSkipped(run.skippedAdapters, adapter, session)) continue;
        const qs = adapter.longContext ? longQuestions : questions;
        if (!qs.length) continue;
        const upToSeq = Math.max(...qs.map((q) => q.askAtSeq));
        if (adapter.usesModel) {
          deferred.push({ adapter, session, qs, upToSeq, estimate: adapter.estimate(session, { upToSeq }) });
          continue;
        }
        const handle = await adapter.prepare(session, { upToSeq });
        try {
          for (const q of qs) await contextItem(adapter, handle, session, q);
        } finally {
          await adapter.release(handle);
        }
      }
    }

    // The plan, priced before any call.
    const plan = planCalls({ items, deferred, answer: a });
    const estimate = estimateCalls(plan.calls, a.catalog);
    a.onPlan({ estimate, counts: plan.counts, maxUsd: a.maxUsd });
    if (a.dryRun) return { dryRun: true, estimate, counts: plan.counts, staleTmpRemoved: run.staleTmpRemoved };
    checkBudget(estimate, a);

    const dir = path.join(home.runs, runId);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      ...baseConfig(run, runId), stage: 'B3', metric: 'answer accuracy', secondaryMetrics: ['evidence recall', 'answer containment'],
      answer: answerConfig(a, adapters, selection, estimate, cap)
    };
    writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const recordsPath = path.join(dir, 'records.jsonl');
    fs.writeFileSync(recordsPath, '');
    const guard = new SpendGuard({ maxUsd: a.maxUsd, catalog: a.catalog });
    const hooks = guard.hooks();
    const setupCosts = [];
    let spend = null;
    // spend.json is on disk from here on and rewritten after every item, so
    // a run that stops (a refused key, a crash, Ctrl-C) still says what it
    // paid; stoppedBy names the code that stopped it.
    const writeSpend = (stoppedBy = null) => {
      spend = { estimateUsd: estimate.totalUsd, estimateKnownUsd: estimate.knownUsd, ...guard.totals(), setupCosts, stoppedBy };
      writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
    };
    writeSpend();
    // One adapter's questions in one session, recorded as context errors.
    const recordFailed = async (d, err, code) => {
      for (const q of d.qs) {
        const { record } = await scoreOne({ runId, adapter: { ...d.adapter, context: async () => { throw err; } }, handle: null, session: d.session, q, budgetTokens: run.budgetTokens });
        record.tier = a.tier;
        record.error = code;
        items.push({ adapter: d.adapter, q, record });
      }
    };
    const texts = [];

    try {
      // Pass 2a: adapters whose context needs a model (summarize-compact).
      for (const d of deferred) {
        let handle;
        try {
          handle = await d.adapter.prepare(d.session, { upToSeq: d.upToSeq, hooks });
        } catch (err) {
          // A refused key stops the run, as an answer's does. The cap, or a
          // call that failed after its retries (spec §15: three), is recorded
          // as a context error on this adapter's questions and the run goes
          // on. Anything else is a defect and is thrown.
          if (isAuthFailure(err)) {
            const c = d.adapter.modelClient;
            throw new UsageError(`${c ? c.provider : 'The provider'} refused the API key (${err.status}) for the summarizer; the run stopped. `
              + 'Finished calls are cached, so running again costs only what is left.', 'AUTH');
          }
          if (err.code !== 'OVER_BUDGET' && !Number.isInteger(err.status) && !retryable(err)) throw err;
          const code = err.code === 'OVER_BUDGET' ? 'over-budget' : `summary-failed${Number.isInteger(err.status) ? `:${err.status}` : ''}`;
          log.warn('summarizer failed; its questions are recorded as errors', { adapter: d.adapter.name, sessionId: d.session.manifest.sessionId, code });
          await recordFailed(d, err, code);
          writeSpend();
          continue;
        }
        try {
          setupCosts.push({ adapter: d.adapter.name, sessionId: d.session.manifest.sessionId, ...handle.setup });
          for (const q of d.qs) await contextItem(d.adapter, handle, d.session, q);
        } finally {
          await d.adapter.release(handle);
        }
        writeSpend();
      }

      // Pass 2b: answer and judge every context.
      const deps = {
        cache: a.cache, prompts: a.prompts, answerClient: a.answerClient, judgeClient: a.judgeClient,
        answerMaxTokens: a.answerMaxTokens, judgeMaxTokens: a.judgeMaxTokens, hooks, retry: a.retry
      };
      await mapPool(items.filter((it) => !it.record.error), a.concurrency, async (it) => {
        const out = await answerAndJudge({
          question: it.q, adapter: it.adapter.name, adapterConfigSha256: it.adapterConfigSha256,
          context: fs.readFileSync(it.contextFile, 'utf8'), contextSha256: it.contextSha256
        }, deps);
        Object.assign(it.record, out.fields);
        fs.appendFileSync(recordsPath, `${JSON.stringify(it.record)}\n`);
        writeSpend();
        if (out.fields.verdict) {
          texts.push({
            runId, sessionId: it.q.sessionId, questionId: it.q.id, adapter: it.adapter.name, kind: it.q.kind, question: it.q.question,
            reference: it.q.answer, acceptableAnswers: it.q.acceptableAnswers || [], reply: out.reply, verdict: out.fields.verdict, reason: out.reason
          });
        }
      });
    } catch (err) {
      writeSpend(err.code || 'error');
      throw err;
    }

    const records = items.map((it) => it.record).sort(recordOrder(adapters));
    writeFileAtomic(recordsPath, (write) => { for (const r of records) write(`${JSON.stringify(r)}\n`); });
    writeSpend();
    const file = spotCheckFile(home, runId);
    const n = writeSpotCheckSample(file, texts, { seed });
    const result = finish({ run, runId, dir, config, records, spend, setupCosts });
    return { ...result, spotChecks: { file, n } };
  } finally {
    fs.rmSync(ctxDir, { recursive: true, force: true });
  }
}

module.exports = { runBenchmark, gitCommit, removeStaleTmp, contextCapTokens, KL_TMP_PREFIX, RUN_ID_RE, ANSWER_PROMPT_OVERHEAD_TOKENS };
```

The failure branch in pass 2a (the cap, or a summarizer call that failed after its retries) builds its records through `scoreOne`, using an adapter whose `context` throws, so they have the same shape as any other context error; its `error` is the code (`over-budget`, `summary-failed:503`), never the provider's message. A refused summarizer key is thrown as `AUTH`, like an answer's: spec §15's retry-then-record rule is applied to the summarizer's calls as to the answer's and the judge's.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-answer-run.test.js tests/longhaul-run.test.js tests/longhaul-smoke.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-embed.test.js`
Expected: PASS, `# fail 0`. The B0 tests are unchanged: without `answer`, `runBenchmark` writes the same config, records and summary it did before. The only additions are `contextTruncated`, `skippedAdapters`, `bySession`, `answer: null` and `setup: null`.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/answer-stage.js src/longhaul/run.js tests/helpers/longhaul-helpers.js tests/longhaul-answer-run.test.js
git commit -m "feat(longhaul): answer stage in run: tiers, priced plan refused over the cap, private sessions gated, resumable"
```

---
## Task 12: `longhaul run` flags, the model clients and `--fake-models`

**Files:**
- Create: `src/longhaul/fake-models.js`
- Modify: `src/longhaul/commands/run.js` (rewritten below)
- Test: `tests/longhaul-answer-cli.test.js`

**Interfaces:**
- Consumes: `runBenchmark({ answer })` (Task 11); `createModelClient` (`model.js`); `ModelCache.forHome` (Task 2); `loadPrompt` (Task 1); `formatEstimate`, `DEFAULT_MAX_USD` (Task 4); `FULL_HISTORY_TOKENS` (Task 6).
- Produces:
  - `fake-models.js`: `createFakeModels() → { answer, judge, summarizer }`. These are local clients (`provider: 'fake'`, `local: true`, `costUsd: 0`). The answer always declines; the judge returns `abstained` for a decline and `incorrect` otherwise; the summarizer returns a fixed line.
  - The `run` command's new flags: `--answer-provider/--answer-model/--answer-base-url`, `--judge-provider/--judge-model/--judge-base-url`, `--summarizer-provider/--summarizer-model/--summarizer-base-url` (default: the answer model), `--tier grid|frontier`, `--sample N` (150), `--long-context-sample N`, `--max-usd X` (50), `--allow-unpriced`, `--dry-run`, `--concurrency N` (4), `--answer-max-tokens N` (400), `--judge-max-tokens N` (200), `--full-history-tokens N` (128000, for `full-history` and `real-compaction`), `--compact-every-tokens N` (10000), `--fake-models`, and `--embed-provider openai|local` (the embedder for kl-recall-vec: openai (default) or local (H3); carried here so H3 Task 15, which runs after this rewrite, does not lose it). `--send-private` now also gates the answer stage. A client built with `--<role>-base-url` carries `baseUrl`, which the cache keys include (Tasks 8 and 10).
  - `run(ctx, values, positionals, deps)` accepts test-only `deps = { providerInstances: { answer, judge, summarizer }, catalog, retry }`.
  - `exitCodeFor(result, stderr)` also returns 1 when the run stopped at the cap.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-answer-cli.test.js`:

```js
// tests/longhaul-answer-cli.test.js
// The answer stage from the CLI (benchmark spec §8.1, §10, §14): the
// --fake-models smoke run, the private-session refusal against the local
// fake server (no request reaches it), usage errors, --dry-run, and the
// unpriced-model refusal. No network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main, COMMANDS } = require('../src/longhaul/cli');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { createFakeModels } = require('../src/longhaul/fake-models');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink, makePrivate, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

const io = (env) => ({ stdout: sink(), stderr: sink(), env });

describe('fake models', () => {
  it('decline, judge a decline as abstained, summarize, and cost nothing', async () => {
    const m = createFakeModels();
    assert.ok([m.answer, m.judge, m.summarizer].every((c) => c.local === true && c.provider === 'fake'));
    assert.strictEqual((await m.answer.complete('anything')).text, "I don't know");
    assert.strictEqual((await m.answer.complete('anything')).llmMetrics.costUsd, 0);
    assert.strictEqual(JSON.parse((await m.judge.complete("x\n<reply>\nI don't know\n</reply>\ny")).text).verdict, 'abstained');
    assert.strictEqual(JSON.parse((await m.judge.complete('<reply>\nPort 18001.\n</reply>')).text).verdict, 'incorrect');
    assert.match((await m.summarizer.complete('p')).text, /Summary/);
  });
});

describe('longhaul run: the answer stage', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('runs the whole answer stage on the fixtures with --fake-models, for $0 and no network', async () => {
    const { env, root } = tmpHome();
    const out = io(env);
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle,sliding-window,real-compaction,summarize-compact', '--fake-models'], out);
    assert.strictEqual(code, 0, out.stderr.text);
    assert.match(out.stdout.text, /estimate: \$0\.0000/);
    assert.match(out.stdout.text, /answer accuracy 0\.000 \(n=\d+\)/);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.oracle.answer.abstain.accuracy, 1);
    assert.strictEqual(summary.oracle.answer.declinedRate, 1);
    assert.strictEqual(summary['real-compaction'].questions, 6);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.answer.answerModel, { provider: 'fake', model: 'fake-answer', maxTokens: 400 });
    assert.deepStrictEqual(config.skippedAdapters.map((s) => s.sessionId).sort(), ['synth-medium', 'synth-small']);
  });

  it('refuses a private session without --send-private: exit 2, and no request reaches the provider', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const before = server.requests.length;
    const out = io({ ...env, OPENAI_API_KEY: 'test-key-123456' });
    const code = await main(['run', '--adapters', 'oracle',
      '--answer-provider', 'openai', '--answer-model', 'test-model', '--answer-base-url', `${server.url}/openai/v1`,
      '--judge-provider', 'openai', '--judge-model', 'test-judge', '--judge-base-url', `${server.url}/openai/v1`], out);
    assert.strictEqual(code, 2);
    assert.match(out.stderr.text, /synth-small is private/);
    assert.match(out.stderr.text, /--send-private/);
    assert.strictEqual(server.requests.length, before, 'nothing reached the provider');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), []);
  });

  it('refuses answer-stage options without the answer stage, half a model pair, and a judge that is the answer model', async () => {
    const { env } = tmpHome();
    const e = { ...env, OPENAI_API_KEY: 'test-key-123456' };
    const base = ['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle'];
    assert.strictEqual(await main([...base, '--dry-run'], io(e)), 2);
    assert.strictEqual(await main([...base, '--tier', 'frontier'], io(e)), 2);
    assert.strictEqual(await main([...base, '--answer-model', 'm'], io(e)), 2);
    assert.strictEqual(await main([...base, '--answer-provider', 'openai', '--answer-model', 'm'], io(e)), 2, 'no judge');
    const same = io(e);
    assert.strictEqual(await main([...base, '--answer-provider', 'openai', '--answer-model', 'm', '--judge-provider', 'openai', '--judge-model', 'm'], same), 2);
    assert.match(same.stderr.text, /judge is never the answer model/);
    assert.strictEqual(await main([...base, '--fake-models', '--answer-provider', 'openai', '--answer-model', 'm'], io(e)), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'full-history', '--fake-models'], io(e)), 2, 'full-history is frontier only');
    assert.strictEqual(await main([...base, '--fake-models', '--tier', 'nope'], io(e)), 2);
    assert.strictEqual(await main([...base, '--fake-models', '--max-usd', '0'], io(e)), 2);
    const usage = io(e);
    assert.strictEqual(await main(['run'], usage), 2);
    assert.match(usage.stderr.text, /--embed-provider openai\|local/);
    assert.deepStrictEqual(COMMANDS.run.options['embed-provider'], { type: 'string' });
  });

  it('--dry-run prints the plan and the estimate, calls nothing and writes no run', async () => {
    const { env, root } = tmpHome();
    const out = io(env);
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle,full-history', '--tier', 'frontier',
      '--sample', '5', '--long-context-sample', '2', '--fake-models', '--dry-run'], out);
    assert.strictEqual(code, 0, out.stderr.text);
    assert.match(out.stdout.text, /plan: 7 answers \(0 cached\), 7 judgments \(0 cached\), 0 summaries \(0 cached\)/);
    assert.match(out.stdout.text, /dry run: no model was called and no run was written/);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), []);
  });

  it('builds the clients through createModelClient; an unpriced model is refused unless --allow-unpriced', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const provider = (reply) => ({
      async streamMessage(messages, options, onChunk) {
        onChunk(reply);
        return { content: '', llmMetrics: { inputTokens: 10, outputTokens: 2, costUsd: null, unpriced: true } };
      }
    });
    const values = {
      sessions: FIXTURE_ROOT, adapters: 'oracle',
      'answer-provider': 'openai', 'answer-model': 'no-such-model', 'judge-provider': 'anthropic', 'judge-model': 'claude-haiku-4-5'
    };
    const ctx = { home, env, stdout: sink(), stderr: sink(), now: () => new Date('2026-09-30T10:00:00Z'), cwd: process.cwd() };
    const deps = {
      providerInstances: { answer: provider("I don't know"), judge: provider('{"verdict":"abstained","reason":"declined"}') },
      catalog: fixtureCatalog(), retry: { wait: async () => {} }
    };
    await assert.rejects(COMMANDS.run.run(ctx, values, [], deps), (err) => err.code === 'UNPRICED');
    assert.strictEqual(await COMMANDS.run.run(ctx, { ...values, 'allow-unpriced': true }, [], deps), 0, ctx.stderr.text);
    assert.match(ctx.stdout.text, /\(\d+ unpriced\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-answer-cli.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/fake-models'`.

- [ ] **Step 3: Write `fake-models.js`**

Create `src/longhaul/fake-models.js`:

```js
'use strict';
// --fake-models (benchmark spec §14's CI smoke): built-in local models, no
// network and no key. The answer model always declines; the judge reads the
// reply (a decline is "abstained", anything else "incorrect"); the
// summarizer returns a fixed line. They are local (client.local), so they
// cost $0 and need no --send-private: a smoke run exercises the whole answer
// stage and scores it at accuracy 0 and abstain accuracy 1.
function fake(model, reply) {
  return {
    provider: 'fake',
    model,
    local: true,
    async complete(prompt) {
      const text = reply(String(prompt));
      return { text, llmMetrics: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
    }
  };
}

function createFakeModels() {
  return {
    answer: fake('fake-answer', () => "I don't know"),
    judge: fake('fake-judge', (prompt) => {
      const start = prompt.indexOf('<reply>');
      const reply = start < 0 ? '' : prompt.slice(start + '<reply>'.length, prompt.indexOf('</reply>', start));
      return JSON.stringify({ verdict: /i don't know/i.test(reply) ? 'abstained' : 'incorrect', reason: 'fake judge' });
    }),
    summarizer: fake('fake-summarizer', () => 'Summary: the session so far.')
  };
}

module.exports = { createFakeModels };
```

- [ ] **Step 4: Rewrite the `run` command**

Replace `src/longhaul/commands/run.js` with:

```js
'use strict';
// `longhaul run`: evidence recall per adapter (stage B0) and, with an answer
// and a judge model, answer accuracy (stage B3). Output is ASCII.
const path = require('path');
const { runBenchmark } = require('../run');
const { UsageError } = require('../errors');
const { validateSessionId } = require('../session-format');
const { createModelClient } = require('../model');
const { createFakeModels } = require('../fake-models');
const { ModelCache } = require('../model-cache');
const { loadPrompt } = require('../prompts');
const { formatEstimate, DEFAULT_MAX_USD } = require('../cost');
const { FULL_HISTORY_TOKENS } = require('../adapters/full-history');

const USAGE = [
  'Usage: longhaul run --adapters kl-recall,sliding-window,oracle [--sessions <data root>] [--session <id>]...',
  '  [--budget-tokens 6000] [--window-tokens N] [--recall key=value]... [--chunk-target-chars N] [--seed N] [--include-unverified]',
  '  [--embed-model text-embedding-3-small] [--embed-provider openai|local] [--send-private]',
  '  --embed-provider: the embedder for kl-recall-vec: openai (default) or local (H3)',
  'Answer stage: --answer-provider <p> --answer-model <m> [--answer-base-url <url>] --judge-provider <p> --judge-model <m> [--judge-base-url <url>]',
  '  [--summarizer-provider <p> --summarizer-model <m> [--summarizer-base-url <url>]] [--tier grid|frontier] [--sample 150]',
  '  [--long-context-sample N] [--max-usd 50] [--allow-unpriced] [--dry-run] [--concurrency 4] [--answer-max-tokens 400]',
  '  [--judge-max-tokens 200] [--full-history-tokens 128000] [--compact-every-tokens 10000] [--fake-models]'
].join('\n');

// Options that mean nothing without the answer stage.
const ANSWER_ONLY = Object.freeze([
  'tier', 'sample', 'long-context-sample', 'max-usd', 'allow-unpriced', 'dry-run', 'concurrency',
  'answer-max-tokens', 'judge-max-tokens', 'compact-every-tokens', 'summarizer-provider', 'summarizer-model', 'summarizer-base-url'
]);

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive whole number, got ${JSON.stringify(value)}`);
  return n;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number, got ${JSON.stringify(value)}`);
  return n;
}

// --recall key=value; the value is parsed as JSON when it can be (numbers,
// booleans, objects), else kept as a string.
function parseRecallPairs(pairs = []) {
  const out = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--recall takes key=value, got ${JSON.stringify(pair)}`);
    const raw = pair.slice(eq + 1);
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    out[pair.slice(0, eq)] = value;
  }
  return out;
}

// The model client for one role (answer, judge, summarizer), or null when
// the role's model is not named. The key comes from the environment.
function clientFor(ctx, values, role, deps) {
  const provider = values[`${role}-provider`];
  const model = values[`${role}-model`];
  if (!provider && !model) return null;
  if (!provider || !model) throw new UsageError(`--${role}-provider and --${role}-model go together.`);
  const baseUrl = values[`${role}-base-url`];
  const client = createModelClient({
    provider, model, env: ctx.env, options: baseUrl ? { baseUrl } : {}, providerInstance: deps.providerInstances?.[role] || null
  });
  // The cache keys include baseUrl (answer-stage.js, summarize-compact.js),
  // so a self-hosted endpoint serving a model under the provider's own name
  // never reuses the provider's cached replies, or the other way round.
  return baseUrl ? { ...client, baseUrl } : client;
}

const num = (x) => (x === null || x === undefined ? '-' : String(Math.round(x)));
const ac = (x) => (x === null || x === undefined ? '-' : x.toFixed(3));

function exitCodeFor(result, stderr) {
  if (result.leaks > 0) {
    stderr.write(`LEAK: ${result.leaks} shown messages were at or after askAtSeq; see the "leaked" field in ${path.join(result.dir, 'records.jsonl')}\n`);
    return 1;
  }
  if (result.spend?.overBudget) {
    stderr.write(`STOPPED AT THE CAP ($${result.config.answer.maxUsd}): the remaining questions are recorded as over-budget errors. `
      + 'Run again to finish; cached calls cost nothing.\n');
    return 1;
  }
  return 0;
}

module.exports = {
  options: {
    sessions: { type: 'string' },
    session: { type: 'string', multiple: true },
    adapters: { type: 'string' },
    'budget-tokens': { type: 'string' },
    'window-tokens': { type: 'string' },
    'chunk-target-chars': { type: 'string' },
    recall: { type: 'string', multiple: true },
    seed: { type: 'string' },
    'include-unverified': { type: 'boolean', default: false },
    'embed-model': { type: 'string' },
    'embed-provider': { type: 'string' },
    'send-private': { type: 'boolean', default: false },
    'answer-provider': { type: 'string' },
    'answer-model': { type: 'string' },
    'answer-base-url': { type: 'string' },
    'judge-provider': { type: 'string' },
    'judge-model': { type: 'string' },
    'judge-base-url': { type: 'string' },
    'summarizer-provider': { type: 'string' },
    'summarizer-model': { type: 'string' },
    'summarizer-base-url': { type: 'string' },
    tier: { type: 'string' },
    sample: { type: 'string' },
    'long-context-sample': { type: 'string' },
    'max-usd': { type: 'string' },
    'allow-unpriced': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    concurrency: { type: 'string' },
    'answer-max-tokens': { type: 'string' },
    'judge-max-tokens': { type: 'string' },
    'full-history-tokens': { type: 'string' },
    'compact-every-tokens': { type: 'string' },
    'fake-models': { type: 'boolean' }
  },
  exitCodeFor,
  positiveInt,
  // deps (tests only): providerInstances { answer, judge, summarizer }, catalog, retry.
  async run(ctx, values, _positionals, deps = {}) {
    if (!values.adapters) throw new UsageError(USAGE);
    for (const id of values.session || []) validateSessionId(id);
    const adapterNames = values.adapters.split(',').map((s) => s.trim()).filter(Boolean);
    const recall = parseRecallPairs(values.recall);
    // kl-recall's store chunk size (history.chunk.targetChars).
    const chunk = values['chunk-target-chars'] ? { targetChars: positiveInt(values['chunk-target-chars'], 'chunk-target-chars') } : null;

    const named = ['answer', 'judge', 'summarizer'].some((r) => values[`${r}-provider`] || values[`${r}-model`]);
    if (values['fake-models'] && named) throw new UsageError('--fake-models replaces the answer, judge and summarizer models; name no model with it.');
    const models = values['fake-models'] ? createFakeModels() : {
      answer: clientFor(ctx, values, 'answer', deps),
      judge: clientFor(ctx, values, 'judge', deps),
      summarizer: clientFor(ctx, values, 'summarizer', deps)
    };
    const answering = Boolean(models.answer || models.judge);
    if (!answering) {
      const stray = ANSWER_ONLY.find((k) => values[k] !== undefined && values[k] !== false);
      if (stray) throw new UsageError(`--${stray} applies only to the answer stage: name --answer-model and --judge-model, or pass --fake-models.`);
    } else if (!models.answer || !models.judge) {
      throw new UsageError('The answer stage needs both an answer model (--answer-provider, --answer-model) and a judge model (--judge-provider, --judge-model).');
    }

    const cache = ModelCache.forHome(ctx.home);
    const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
    const summarizer = models.summarizer || models.answer;
    const windowTokens = values['full-history-tokens'] ? positiveInt(values['full-history-tokens'], 'full-history-tokens') : FULL_HISTORY_TOKENS;
    // kl-recall-vec(-only): vectors from `longhaul embed`'s cache; a question
    // with no cached vector is embedded now only with --send-private.
    // --embed-provider picks the embedder (openai by default; local is the
    // app's own, H3). kl-recall-vec already takes `provider`.
    const vec = {
      recall, privateRoot: ctx.home.private, env: ctx.env, sendPrivate: values['send-private'],
      provider: values['embed-provider'] || 'openai',
      ...(values['embed-model'] ? { model: values['embed-model'] } : {})
    };
    const adapterConfig = {
      'kl-recall': { recall, ...(chunk ? { chunk } : {}) },
      'kl-recall-whole': { recall, ...(chunk ? { chunk } : {}) },
      'kl-recall-vec': vec,
      'kl-recall-vec-only': vec,
      // kl-recall-rerank: cross-encoder scores cached under LONGHAUL_HOME/private/rerank.
      'kl-recall-rerank': { recall, privateRoot: ctx.home.private },
      'kl-recall-vec-rerank': vec,
      'sliding-window': values['window-tokens'] ? { windowTokens: positiveInt(values['window-tokens'], 'window-tokens') } : {},
      'full-history': { windowTokens },
      'real-compaction': { windowTokens },
      'summarize-compact': {
        ...(values['compact-every-tokens'] ? { compactEveryTokens: positiveInt(values['compact-every-tokens'], 'compact-every-tokens') } : {}),
        summarizer: summarizer ? { client: summarizer, cache, prompt: prompts.summarize, retry: deps.retry || {} } : null
      }
    };

    const answer = answering ? {
      answerClient: models.answer,
      judgeClient: models.judge,
      prompts,
      cache,
      catalog: deps.catalog || null,
      answerMaxTokens: values['answer-max-tokens'] ? positiveInt(values['answer-max-tokens'], 'answer-max-tokens') : 400,
      judgeMaxTokens: values['judge-max-tokens'] ? positiveInt(values['judge-max-tokens'], 'judge-max-tokens') : 200,
      tier: values.tier || 'grid',
      sampleSize: values.sample ? positiveInt(values.sample, 'sample') : 150,
      longContextSample: values['long-context-sample'] ? positiveInt(values['long-context-sample'], 'long-context-sample') : null,
      maxUsd: values['max-usd'] !== undefined ? positiveNumber(values['max-usd'], 'max-usd') : DEFAULT_MAX_USD,
      allowUnpriced: values['allow-unpriced'] === true,
      sendPrivate: values['send-private'] === true,
      dryRun: values['dry-run'] === true,
      concurrency: values.concurrency ? positiveInt(values.concurrency, 'concurrency') : 4,
      retry: deps.retry || {},
      onPlan: ({ estimate, counts, maxUsd }) => ctx.stdout.write(formatEstimate(estimate, { counts, maxUsd })),
      onSendPrivate: ({ sessions, to }) => ctx.stderr.write(`note: context, questions and reference answers of private session(s) ${sessions.join(', ')} `
        + `are sent to ${to.join(', ')} (--send-private).\n`)
    } : null;

    const result = await runBenchmark({
      home: ctx.home,
      dataRoot: values.sessions ? path.resolve(ctx.cwd, values.sessions) : ctx.home.root,
      sessionIds: values.session || null,
      adapterNames,
      adapterConfig,
      budgetTokens: values['budget-tokens'] ? positiveInt(values['budget-tokens'], 'budget-tokens') : 6000,
      seed: values.seed ? positiveInt(values.seed, 'seed') : 1,
      includeUnverified: values['include-unverified'],
      now: ctx.now,
      answer
    });
    if (result.staleTmpRemoved) ctx.stdout.write(`removed ${result.staleTmpRemoved} temp dirs left in ${ctx.home.tmp} by an interrupted run\n`);
    if (result.dryRun) {
      ctx.stdout.write('dry run: no model was called and no run was written.\n');
      return 0;
    }
    ctx.stdout.write(`run ${result.runId} -> ${result.dir}\n`);
    if (result.config.includeUnverified) ctx.stdout.write('UNVERIFIED QUESTIONS INCLUDED: a smoke run, not a result.\n');
    for (const [name, s] of Object.entries(result.summary)) {
      const er = s.evidenceRecall === null ? '-' : s.evidenceRecall.toFixed(3);
      ctx.stdout.write(`${name.padEnd(16)} evidence recall ${er} (n=${s.scored})  answer contained ${ac(s.answerContainment)} (tokens ${ac(s.answerTokenContainment)})  partial ${s.partial}  median ${num(s.estTokens.median)} tokens  p90 ${num(s.estTokens.p90)}  errors ${s.errors}  leaks ${s.leaks}\n`);
      if (s.answer) {
        ctx.stdout.write(`${''.padEnd(16)} answer accuracy ${ac(s.answer.accuracy)} (n=${s.answer.n})  partial ${ac(s.answer.partialRate)}  declined ${ac(s.answer.declinedRate)}  `
          + `abstain accuracy ${ac(s.answer.abstain.accuracy)} (n=${s.answer.abstain.n})  answer errors ${s.answer.errors}\n`);
      }
    }
    for (const c of result.comparisons || []) {
      if (!c.result.judged) continue;
      ctx.stdout.write(`${c.id}: ${c.a} ${ac(c.result.accuracy.a)} vs ${c.b} ${ac(c.result.accuracy.b)} over ${c.result.judged} questions `
        + `(right in one only: ${c.result.onlyA} vs ${c.result.onlyB}); a difference under 0.02 is noise\n`);
    }
    if (result.spend) {
      const est = result.spend.estimateUsd === null ? 'unknown' : `$${result.spend.estimateUsd.toFixed(4)}`;
      ctx.stdout.write(`spent $${result.spend.spentUsd.toFixed(4)} on ${result.spend.calls} calls (${result.spend.unpricedCalls} unpriced); estimate ${est}\n`);
    }
    if (result.spotChecks?.n) {
      ctx.stdout.write(`spot-check sample: ${result.spotChecks.n} judgments; review them with longhaul spot-check --run ${result.runId} --reviewer <initials>\n`);
    }
    ctx.stdout.write(`summary: ${path.join(result.dir, 'summary.md')}\n`);
    return exitCodeFor(result, ctx.stderr);
  }
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/longhaul-answer-cli.test.js tests/longhaul-run.test.js tests/longhaul-smoke.test.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-author.test.js tests/longhaul-embed.test.js`
Expected: PASS, `# fail 0`. `author` and `embed` still import `positiveInt` from this file.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/fake-models.js src/longhaul/commands/run.js tests/longhaul-answer-cli.test.js
git commit -m "feat(longhaul): run --answer-model/--judge-model, tiers, --max-usd, --dry-run, --fake-models"
```

---

## Task 13: `longhaul spot-check`

**Files:**
- Create: `src/longhaul/spot-check.js`, `src/longhaul/commands/spot-check.js`
- Modify: `src/longhaul/cli.js` (register `spot-check`)
- Test: `tests/longhaul-spot-check.test.js`

**Interfaces:**
- Consumes: `VERDICTS` (Task 3); `spotCheckFile` (Task 10); `RUN_ID_RE` (Task 11); `writeFileAtomic`.
- Produces:
  - `spot-check.js`: `reviewSpotChecks({ rows, reviewer, input, output, onSave }) → { reviewed, skipped, stopped }`. It walks the rows that have no `humanVerdict`; the keys are `c`/`p`/`i`/`a` for a verdict, `s` to skip and `q` to quit. It calls `onSave(rows)` after each verdict, and a verdict sets `humanVerdict` and `reviewer: 'human:<initials>'`. Also `agreement(rows) → { sampled, reviewed, agreed, rate }` and `readSpotChecks(file) → rows`.
  - The command: `longhaul spot-check --run <runId> --reviewer <initials>`.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-spot-check.test.js`:

```js
// tests/longhaul-spot-check.test.js
// Human spot-checks of the judge (benchmark spec §8 step 4), driven with
// scripted input.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { reviewSpotChecks, agreement, readSpotChecks } = require('../src/longhaul/spot-check');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { writeFileAtomic } = require('../src/longhaul/files');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const input = (lines) => Readable.from([lines.map((l) => `${l}\n`).join('')]);
const row = (i, verdict) => ({
  runId: 'R', sessionId: 'S', questionId: `q${i}`, adapter: 'oracle', kind: 'user-said',
  question: `Which staging port for amber-heron ${i}?`, reference: '18001', acceptableAnswers: ['port 18001'],
  reply: 'Port 18001.', verdict, reason: 'same value', humanVerdict: null, reviewer: null
});

describe('reviewSpotChecks', () => {
  it('shows each judgment and records the reviewer\'s own verdict, saving after each', async () => {
    const saves = [];
    const out = sink();
    const counts = await reviewSpotChecks({
      rows: [row(1, 'correct'), row(2, 'correct'), row(3, 'incorrect')], reviewer: 'TT',
      input: input(['c', 'x', 'i', 's']), output: out, onSave: (rows) => saves.push(rows)
    });
    assert.deepStrictEqual(counts, { reviewed: 2, skipped: 1, stopped: false });
    assert.strictEqual(saves.length, 2);
    assert.deepStrictEqual(saves.at(-1).map((r) => [r.humanVerdict, r.reviewer]), [['correct', 'human:TT'], ['incorrect', 'human:TT'], [null, null]]);
    assert.match(out.text, /Reference: 18001/);
    assert.match(out.text, /Also accept: port 18001/);
    assert.match(out.text, /Judge: correct - same value/);
    assert.match(out.text, /Type c, p, i, a, s or q\./);
  });

  it('skips rows already reviewed, and stops on q or at the end of input', async () => {
    const reviewed = { ...row(1, 'correct'), humanVerdict: 'correct', reviewer: 'human:TT' };
    const counts = await reviewSpotChecks({ rows: [reviewed, row(2, 'correct')], reviewer: 'TT', input: input(['q']), output: sink(), onSave: () => {} });
    assert.deepStrictEqual(counts, { reviewed: 0, skipped: 0, stopped: true });
    const ended = await reviewSpotChecks({ rows: [row(2, 'correct')], reviewer: 'TT', input: input([]), output: sink(), onSave: () => {} });
    assert.strictEqual(ended.stopped, true);
  });

  it('refuses a missing or malformed reviewer', async () => {
    await assert.rejects(reviewSpotChecks({ rows: [], reviewer: '', input: input([]), output: sink(), onSave: () => {} }), UsageError);
    await assert.rejects(reviewSpotChecks({ rows: [], reviewer: 'a b', input: input([]), output: sink(), onSave: () => {} }), UsageError);
  });
});

describe('agreement', () => {
  it('counts reviewed rows whose human verdict matches the judge', () => {
    const rows = [{ ...row(1, 'correct'), humanVerdict: 'correct' }, { ...row(2, 'correct'), humanVerdict: 'partial' }, row(3, 'incorrect')];
    assert.deepStrictEqual(agreement(rows), { sampled: 3, reviewed: 2, agreed: 1, rate: 0.5 });
    assert.deepStrictEqual(agreement([]), { sampled: 0, reviewed: 0, agreed: 0, rate: null });
  });
});

describe('longhaul spot-check', () => {
  it('reviews a run\'s sample in place and prints the agreement', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const runId = '20260930T101500Z-abcd';
    const file = spotCheckFile(home, runId);
    writeFileAtomic(file, `${[row(1, 'correct'), row(2, 'incorrect')].map((r) => JSON.stringify(r)).join('\n')}\n`);
    const stdout = sink();
    const code = await main(['spot-check', '--run', runId, '--reviewer', 'TT'], { stdout, stderr: sink(), env, stdin: input(['c', 'c']) });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /Judge agreement: 1\/2 \(0\.500\) of 2 sampled/);
    assert.deepStrictEqual(readSpotChecks(file).map((r) => r.humanVerdict), ['correct', 'correct']);
  });

  it('refuses a malformed run id, or a run with no sample', async () => {
    const { env } = tmpHome();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    assert.strictEqual(await main(['spot-check', '--run', '../x', '--reviewer', 'TT'], io()), 2);
    assert.strictEqual(await main(['spot-check', '--run', '20260930T101500Z-abcd', '--reviewer', 'TT'], io()), 2);
    assert.strictEqual(await main(['spot-check', '--run', '20260930T101500Z-abcd'], io()), 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-spot-check.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/spot-check'`.

- [ ] **Step 3: Write `spot-check.js`**

Create `src/longhaul/spot-check.js`:

```js
'use strict';
// Human spot-checks of the judge (benchmark spec §8 step 4). An answer-stage
// run writes a seeded tenth of its judgments to
// LONGHAUL_HOME/private/spot-checks/<runId>.jsonl (they quote questions and
// replies). `longhaul spot-check` shows each one (question, references,
// reply, the judge's verdict and reason) and records the reviewer's own
// verdict, saving after each. The report shows the agreement rate, numbers
// only.
const fs = require('fs');
const readline = require('readline');
const { VERDICTS } = require('./judge');
const { UsageError } = require('./errors');

const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const KEYS = Object.freeze({ c: 'correct', p: 'partial', i: 'incorrect', a: 'abstained' });

function describeRow(r, position, total) {
  const lines = ['', `[${position}/${total}] ${r.adapter} - ${r.kind} - ${r.questionId}`, `Q: ${r.question}`, `Reference: ${r.reference}`];
  if (r.acceptableAnswers?.length) lines.push(`Also accept: ${r.acceptableAnswers.join(' | ')}`);
  lines.push('Reply:', r.reply, `Judge: ${r.verdict}${r.reason ? ` - ${r.reason}` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function reviewSpotChecks({ rows, reviewer, input, output, onSave }) {
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };
  const current = rows.map((r) => ({ ...r }));
  const pending = current.map((r, i) => i).filter((i) => !VERDICTS.includes(current[i].humanVerdict));
  const counts = { reviewed: 0, skipped: 0, stopped: false };
  try {
    for (let n = 0; n < pending.length; n++) {
      const i = pending[n];
      output.write(describeRow(current[i], n + 1, pending.length));
      for (;;) {
        const cmd = await ask('Your verdict: [c]orrect [p]artial [i]ncorrect [a]bstained  [s]kip  [q]uit > ');
        if (cmd === null || cmd === 'q') {
          counts.stopped = true;
          return counts;
        }
        if (cmd === 's') {
          counts.skipped += 1;
          break;
        }
        if (KEYS[cmd]) {
          current[i] = { ...current[i], humanVerdict: KEYS[cmd], reviewer: `human:${reviewer}` };
          onSave(current);
          counts.reviewed += 1;
          break;
        }
        output.write('Type c, p, i, a, s or q.\n');
      }
    }
    return counts;
  } finally {
    rl.close();
  }
}

function agreement(rows) {
  const reviewed = rows.filter((r) => VERDICTS.includes(r.humanVerdict));
  const agreed = reviewed.filter((r) => r.humanVerdict === r.verdict).length;
  return { sampled: rows.length, reviewed: reviewed.length, agreed, rate: reviewed.length ? agreed / reviewed.length : null };
}

function readSpotChecks(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

module.exports = { reviewSpotChecks, agreement, readSpotChecks };
```

- [ ] **Step 4: Write the command and register it**

Create `src/longhaul/commands/spot-check.js`:

```js
'use strict';
// `longhaul spot-check --run <runId> --reviewer <initials>`
const fs = require('fs');
const { reviewSpotChecks, agreement, readSpotChecks } = require('../spot-check');
const { spotCheckFile } = require('../answer-stage');
const { RUN_ID_RE } = require('../run');
const { writeFileAtomic } = require('../files');
const { UsageError } = require('../errors');

module.exports = {
  options: { run: { type: 'string' }, reviewer: { type: 'string' } },
  async run(ctx, values) {
    if (!values.run || !values.reviewer) throw new UsageError('Usage: longhaul spot-check --run <runId> --reviewer <initials>');
    if (!RUN_ID_RE.test(values.run)) throw new UsageError(`--run takes a run id like 20260930T101500Z-1a2b, got ${JSON.stringify(values.run)}`);
    const file = spotCheckFile(ctx.home, values.run);
    if (!fs.existsSync(file)) throw new UsageError(`No spot-check sample for run ${values.run}; answer-stage runs write one.`);
    const counts = await reviewSpotChecks({
      rows: readSpotChecks(file), reviewer: values.reviewer, input: ctx.stdin, output: ctx.stdout,
      onSave: (rows) => writeFileAtomic(file, (write) => { for (const r of rows) write(`${JSON.stringify(r)}\n`); })
    });
    const a = agreement(readSpotChecks(file));
    ctx.stdout.write(`\n${counts.reviewed} reviewed, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}. `
      + `Judge agreement: ${a.agreed}/${a.reviewed}${a.rate === null ? '' : ` (${a.rate.toFixed(3)})`} of ${a.sampled} sampled.\n`);
    return 0;
  }
};
```

In `src/longhaul/cli.js`, add `'spot-check': require('./commands/spot-check'),` to `COMMANDS`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/longhaul-spot-check.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/spot-check.js src/longhaul/commands/spot-check.js src/longhaul/cli.js tests/longhaul-spot-check.test.js
git commit -m "feat(longhaul): spot-check the judge on a run's 10% sample"
```

---
## Task 14: `longhaul report`

**Files:**
- Create: `src/longhaul/report.js`, `src/longhaul/commands/report.js`
- Modify: `src/longhaul/cli.js` (register `report`)
- Test: `tests/longhaul-report.test.js`

**Interfaces:**
- Consumes: `summarize`, `compareAdapters`, `COMPARISONS`, `adapterCost` (Task 9); `RUN_ID_RE` (Task 11); `spotCheckFile` (Task 10); `readSpotChecks`, `agreement` (Task 13); `stableStringify` (Task 2); `KINDS`, `BUCKETS`; `writeFileAtomic`, `sha256Text`, `childPath`.
- Produces:
  - `loadRun(home, runId) → { runId, config, records, spend, spot }`, where `spot` is the agreement or null.
  - `cohortOf(config) → '<tier> <provider>/<model> judge:<provider>/<model> commit:<12 hex>'`, or `'evidence-only commit:<12 hex>'` for a run without the answer stage: everything a series holds equal except the adapter and its configuration.
  - `seriesOf(config, adapter) → '<adapter> cfg:<8 hex> @ <cohort>'`, where `cfg` is the first 8 hex of the SHA-256 of the adapter's `describe()` as `config.adapters` recorded it (`unknown` when absent). A series is one adapter with one configuration, at one tier, answer model and judge model, from one commit: two runs that differ in any of these never share a row.
  - `buildReport(runs) → { summary, series, comparisons, cut }`. When several runs answer the same (series, session, question), the latest run wins, except that a failed record (a context error, or an `answerError` such as a failed call, an unparsed verdict or the cap) never replaces a successful one. A named comparison pairs its two adapters' series within one cohort.
  - `writeReport(home, runIds, { id, publicOnly }) → { id, dir, files }`. The files are written under `reports/<id>/`: `report.md`, `adapters.csv`, `by-kind.csv`, `by-distance.csv`, `by-session.csv`, `accuracy-vs-tokens.csv`, `comparisons.csv` and `adapters.tex`. The default id is `r-<first 12 hex of sha256(sorted run ids)>`. `publicOnly` refuses a run with a private session (`PRIVATE_IN_PUBLIC`) before any file is written.
  - The command: `longhaul report --runs <runId>[,<runId>...] [--id <name>] [--public]`.

- [ ] **Step 1: Write the failing test**

Create `tests/longhaul-report.test.js`:

```js
// tests/longhaul-report.test.js
// `longhaul report` (benchmark spec §8, §10.1, §11, §14, B-D8): the paper's
// tables from run records, aggregate numbers only, byte-identical when
// regenerated, and --public refused for a run with a private session.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { writeReport, buildReport, loadRun, seriesOf } = require('../src/longhaul/report');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { scoreVerdict } = require('../src/longhaul/judge');
const { stableStringify } = require('../src/longhaul/model-cache');
const { writeFileAtomic, sha256Text } = require('../src/longhaul/files');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const RUN_A = '20260930T100000Z-aaaa';
const RUN_B = '20260930T110000Z-bbbb';

function rec(runId, adapter, n, kind, verdict) {
  const abstain = kind === 'abstain';
  return {
    runId, sessionId: 'S1', questionId: `S1-q${n}`, adapter, kind, bucket: abstain ? 'none' : '<10K', askAtSeq: 10 + n,
    evidenceSeqs: abstain ? [] : [2], verified: true, evidenceSeqsShown: [], evidenceSeqsPartial: [],
    evidenceRecall: abstain ? null : 1, evidencePartial: 0, answerContained: abstain ? null : true, answerTokensContained: abstain ? null : true,
    chunkEvidenceRecall: null, estTokens: 1000, latencyMs: 5, cpuMs: 1, cost: 0, contextTruncated: false, leaked: 0, error: null, tier: 'grid',
    verdict, ...scoreVerdict({ kind }, verdict), answerError: null,
    answerCached: false, answerInputTokens: 1200, answerOutputTokens: 20, answerCostUsd: 0.01, answerLatencyMs: 100,
    judgeCached: false, judgeInputTokens: 400, judgeOutputTokens: 30, judgeCostUsd: 0.002
  };
}
const ADAPTERS = [
  { name: 'kl-recall', recall: { bm25TopK: 200, completeMessageTokens: 0 } },
  { name: 'kl-recall-whole', recall: { bm25TopK: 200, completeMessageTokens: 800 } }
];
const config = (runId, isPrivate) => ({
  runId, stage: 'B3', commit: 'abcdef1234567890', budgetTokens: 6000, seed: 1, adapters: ADAPTERS,
  sessions: [{ sessionId: 'S1', private: isPrivate, license: isPrivate ? 'private' : 'CC-BY-4.0', questions: 4 }],
  answer: {
    tier: 'grid', answerModel: { provider: 'openai', model: 'gpt-6-lite', maxTokens: 400 }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 200 },
    prompts: { answer: { file: 'answer-v1.md', sha256: 'a'.repeat(64) }, judge: { file: 'judge-v1.md', sha256: 'b'.repeat(64) } }
  }
});
function writeRun(home, runId, cfg, records) {
  const dir = path.join(home.runs, runId);
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(cfg)}\n`);
  writeFileAtomic(path.join(dir, 'records.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeRun(home, RUN_A, config(RUN_A, true), [
    rec(RUN_A, 'kl-recall', 1, 'user-said', 'correct'), rec(RUN_A, 'kl-recall', 2, 'user-said', 'incorrect'),
    rec(RUN_A, 'kl-recall', 3, 'decision', 'correct'), rec(RUN_A, 'kl-recall', 4, 'abstain', 'abstained'),
    rec(RUN_A, 'kl-recall-whole', 1, 'user-said', 'correct'), rec(RUN_A, 'kl-recall-whole', 2, 'user-said', 'correct'),
    rec(RUN_A, 'kl-recall-whole', 3, 'decision', 'incorrect'), rec(RUN_A, 'kl-recall-whole', 4, 'abstain', 'abstained')
  ]);
  return { env, home };
}
const cfg = (d) => sha256Text(stableStringify(d)).slice(0, 8);
const COHORT = 'grid openai/gpt-6-lite judge:anthropic/claude-haiku-4-5 commit:abcdef123456';
const KL = `kl-recall cfg:${cfg(ADAPTERS[0])} @ ${COHORT}`;
const WHOLE = `kl-recall-whole cfg:${cfg(ADAPTERS[1])} @ ${COHORT}`;
const readAll = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

describe('longhaul report', () => {
  it('writes the per-adapter table with accuracy, abstain accuracy and cost per point of accuracy', () => {
    const { home } = setup();
    const out = writeReport(home, [RUN_A]);
    assert.match(out.id, /^r-[0-9a-f]{12}$/);
    assert.deepStrictEqual(out.files, ['accuracy-vs-tokens.csv', 'adapters.csv', 'adapters.tex', 'by-distance.csv', 'by-kind.csv', 'by-session.csv', 'comparisons.csv', 'report.md']);
    const files = readAll(out.dir);
    const rows = files['adapters.csv'].trim().split('\n');
    assert.strictEqual(rows[0], 'series,questions,evidence_recall,answer_contained,answer_n,answer_accuracy,partial_rate,declined_rate,abstain_n,abstain_accuracy,false_answer_rate,answer_errors,contexts_cut,median_context_tokens,p90_context_tokens,median_answer_input_tokens,cost_usd,cost_unknown_calls,cost_per_accuracy_point_usd,median_context_ms,p90_context_ms,median_answer_ms,p90_answer_ms');
    // 2 of 3 answerable right; 4 answers at $0.01 and 4 judgments at $0.002 = $0.048; $0.048 / 66.7 points.
    assert.strictEqual(rows[1], `${KL},4,1.000,1.000,3,0.667,0.000,0.000,1,1.000,0.000,0,0,1000,1000,1200,0.0480,0,0.00072,5.0,5.0,100.0,100.0`);
    assert.strictEqual(files['comparisons.csv'].trim().split('\n')[1], `whole-messages,${KL},${WHOLE},4,4,0.750,0.750,0.000,1,1,1.000,1.000,1.000,1.000`);
    assert.ok(files['by-kind.csv'].includes(`${KL},abstain,0,,,1,1.000`));
    assert.match(files['report.md'], /## Per adapter/);
    assert.match(files['adapters.tex'], /\\begin\{tabular\}/);
  });

  it('carries aggregate numbers only: no question ids or text', () => {
    const { home } = setup();
    const files = readAll(writeReport(home, [RUN_A]).dir);
    for (const [name, text] of Object.entries(files)) assert.ok(!text.includes('S1-q'), `${name} names no question`);
  });

  it('regenerates byte-identical files from the same runs', () => {
    const { home } = setup();
    const first = readAll(writeReport(home, [RUN_A]).dir);
    const again = readAll(writeReport(home, [RUN_A]).dir);
    assert.deepStrictEqual(again, first);
  });

  it('counts the latest run when several answer the same question for one series, but never lets a failure replace a success', () => {
    const { home } = setup();
    writeRun(home, RUN_B, config(RUN_B, true), [
      rec(RUN_B, 'kl-recall', 2, 'user-said', 'correct'),
      // A later failed judgment of q1, which RUN_A judged correct: RUN_A's record stands.
      { ...rec(RUN_B, 'kl-recall', 1, 'user-said', 'correct'), verdict: null, answerCorrect: null, answerError: 'answer-failed:500' }
    ]);
    const built = buildReport([RUN_B, RUN_A].map((r) => loadRun(home, r)));
    assert.strictEqual(built.summary[KL].answer.accuracy, 1);
    assert.strictEqual(built.summary[KL].answer.errors, 0);
    assert.strictEqual(built.summary[KL].questions, 4);
  });

  it('shows the judge spot-check agreement per run', () => {
    const { home } = setup();
    const row = (verdict, humanVerdict) => ({ questionId: 'x', verdict, humanVerdict });
    writeFileAtomic(spotCheckFile(home, RUN_A), `${[row('correct', 'correct'), row('correct', null)].map((r) => JSON.stringify(r)).join('\n')}\n`);
    assert.match(readAll(writeReport(home, [RUN_A]).dir)['report.md'], /1\/1 agreed \(2 sampled\)/);
  });

  it('with --public, refuses a run with a private session before writing anything', () => {
    const { home } = setup();
    assert.throws(() => writeReport(home, [RUN_A], { publicOnly: true }), (err) => err instanceof UsageError && err.code === 'PRIVATE_IN_PUBLIC');
    assert.deepStrictEqual(fs.readdirSync(home.reports), []);
  });

  it('names a series by adapter, its config, tier, answer model, judge model and commit, and keeps evidence-only runs apart', () => {
    const base = config(RUN_A, false);
    assert.strictEqual(seriesOf(base, 'kl-recall'), KL);
    assert.strictEqual(seriesOf(base, 'oracle'), `oracle cfg:unknown @ ${COHORT}`);
    const other = (patch) => seriesOf({ ...base, ...patch }, 'kl-recall');
    assert.notStrictEqual(other({ answer: { ...base.answer, judgeModel: { provider: 'openai', model: 'gpt-6-flex' } } }), KL);
    assert.notStrictEqual(other({ commit: '0123456789abcdef' }), KL);
    assert.notStrictEqual(other({ adapters: [{ ...ADAPTERS[0], recall: { bm25TopK: 100 } }] }), KL);
    assert.notStrictEqual(other({ answer: { ...base.answer, tier: 'frontier' } }), KL);
    const b0 = { stage: 'B0', commit: 'c0ffee', adapters: [{ name: 'oracle' }] };
    assert.strictEqual(seriesOf(b0, 'oracle'), `oracle cfg:${cfg({ name: 'oracle' })} @ evidence-only commit:c0ffee`);
  });

  it('runs from the CLI, and refuses an unknown run or a bad id', async () => {
    const { env } = setup();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    const ok = io();
    assert.strictEqual(await main(['report', '--runs', RUN_A, '--id', 'b3-test'], ok), 0, ok.stderr.text);
    assert.match(ok.stdout.text, /report b3-test/);
    assert.strictEqual(await main(['report', '--runs', '20260930T120000Z-cccc'], io()), 2);
    assert.strictEqual(await main(['report', '--runs', RUN_A, '--id', '../x'], io()), 2);
    assert.strictEqual(await main(['report'], io()), 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-report.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/report'`.

- [ ] **Step 3: Write `report.js`**

Create `src/longhaul/report.js`:

```js
'use strict';
// `longhaul report` (benchmark spec §8, §11, B-D8): the records of one or
// more runs aggregated into the paper's tables under
// LONGHAUL_HOME/reports/<id>/: report.md, CSV files (the tables and the
// figures' data: accuracy by distance, accuracy against context tokens) and
// adapters.tex. Aggregate numbers only (no question, reference, reply or
// session text, no question ids), so a report built from private sessions
// may be published (B-D8). --public, for a release bundle, refuses any run
// with a private session (spec §10.1) before any file is written. The same
// runs give byte-identical files: nothing reads the clock, every list is
// sorted. A series is one adapter with one configuration (its describe(),
// hashed), at one tier, answer model and judge model, from one commit, so
// runs that differ in any of these never share a row. When several runs
// answer the same question for one series (a crashed run and its rerun), the
// latest counts, unless it failed where an earlier one succeeded.
const fs = require('fs');
const path = require('path');
const { summarize, compareAdapters, COMPARISONS, adapterCost } = require('./scoring');
const { stableStringify } = require('./model-cache');
const { KINDS, BUCKETS } = require('./questions');
const { RUN_ID_RE } = require('./run');
const { spotCheckFile } = require('./answer-stage');
const { readSpotChecks, agreement } = require('./spot-check');
const { writeFileAtomic, sha256Text, childPath } = require('./files');
const { UsageError } = require('./errors');

const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fmt = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(d));
const md = (x, d = 3) => fmt(x, d) || '-';
const texEscape = (s) => String(s).replace(/[\\&%$#_{}]/g, (c) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`));

function csv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function loadRun(home, runId) {
  if (!RUN_ID_RE.test(runId)) throw new UsageError(`${JSON.stringify(runId)} is not a run id (like 20260930T101500Z-1a2b).`);
  const dir = path.join(home.runs, runId);
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) throw new UsageError(`No run ${runId} under ${home.runs}.`);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const recordsFile = path.join(dir, 'records.jsonl');
  const records = fs.existsSync(recordsFile) ? readJsonl(recordsFile) : [];
  const spendFile = path.join(dir, 'spend.json');
  const spend = fs.existsSync(spendFile) ? JSON.parse(fs.readFileSync(spendFile, 'utf8')) : null;
  const sample = spotCheckFile(home, runId);
  const spot = fs.existsSync(sample) ? agreement(readSpotChecks(sample)) : null;
  return { runId, config, records, spend, spot };
}

const short = (commit) => String(commit ?? 'unknown').slice(0, 12);

// The adapter's configuration as the run recorded it (config.adapters holds
// each adapter's describe(), with the recall settings, windows and models),
// hashed: two kl-recall runs with different --recall settings, or before and
// after a default changed, are two series.
function configHash(config, adapter) {
  const d = (config.adapters || []).find((x) => x && x.name === adapter);
  return d ? sha256Text(stableStringify(d)).slice(0, 8) : 'unknown';
}

// Everything a series holds equal except the adapter and its configuration;
// a named comparison pairs two adapters within one cohort.
function cohortOf(config) {
  if (!config.answer) return `evidence-only commit:${short(config.commit)}`;
  const { tier, answerModel: m, judgeModel: j } = config.answer;
  return `${tier} ${m.provider}/${m.model} judge:${j.provider}/${j.model} commit:${short(config.commit)}`;
}

function seriesOf(config, adapter) {
  return `${adapter} cfg:${configHash(config, adapter)} @ ${cohortOf(config)}`;
}

// A record that produced a result: no context error and no answer error.
const succeeded = (r) => !r.error && !r.answerError;

function buildReport(runs) {
  const ordered = [...runs].sort((x, y) => x.runId.localeCompare(y.runId));
  const byKey = new Map();
  const setup = new Map();
  const meta = new Map();
  for (const run of ordered) {
    for (const r of run.records) {
      const adapter = seriesOf(run.config, r.adapter);
      meta.set(adapter, { adapter: r.adapter, cohort: cohortOf(run.config) });
      const key = `${adapter}\u0000${r.sessionId}\u0000${r.questionId}`;
      const prev = byKey.get(key);
      // The latest run wins, but a failure never replaces a success.
      if (!prev || succeeded(r) || !succeeded(prev)) byKey.set(key, { ...r, adapter });
    }
    for (const c of run.spend?.setupCosts || []) {
      const adapter = seriesOf(run.config, c.adapter);
      setup.set(`${adapter}\u0000${c.sessionId}`, { ...c, adapter });
    }
  }
  const records = [...byKey.values()].sort((x, y) => x.adapter.localeCompare(y.adapter)
    || x.sessionId.localeCompare(y.sessionId) || x.questionId.localeCompare(y.questionId));
  const summary = summarize(records, { setupCosts: [...setup.values()].sort((x, y) => x.adapter.localeCompare(y.adapter) || x.sessionId.localeCompare(y.sessionId)) });
  const series = Object.keys(summary).sort();
  const cut = Object.fromEntries(series.map((s) => [s, records.filter((r) => r.adapter === s && r.contextTruncated === true).length]));
  const comparisons = [];
  for (const c of COMPARISONS) {
    for (const a of series) {
      if (meta.get(a)?.adapter !== c.a) continue;
      for (const b of series) {
        if (meta.get(b)?.adapter !== c.b || meta.get(b).cohort !== meta.get(a).cohort) continue;
        const result = compareAdapters(records, a, b);
        if (result) comparisons.push({ id: c.id, title: c.title, a, b, result });
      }
    }
  }
  return { summary, series, comparisons, cut };
}

function costPerPoint(s) {
  const cost = adapterCost(s);
  const acc = s.answer?.accuracy;
  return s.answer && cost.unknown === 0 && acc ? cost.usd / (acc * 100) : null;
}

function renderCsvs({ summary, series, comparisons, cut }) {
  const files = {};
  const adapters = [['series', 'questions', 'evidence_recall', 'answer_contained', 'answer_n', 'answer_accuracy', 'partial_rate', 'declined_rate',
    'abstain_n', 'abstain_accuracy', 'false_answer_rate', 'answer_errors', 'contexts_cut', 'median_context_tokens', 'p90_context_tokens',
    'median_answer_input_tokens', 'cost_usd', 'cost_unknown_calls', 'cost_per_accuracy_point_usd',
    'median_context_ms', 'p90_context_ms', 'median_answer_ms', 'p90_answer_ms']];
  for (const name of series) {
    const s = summary[name];
    const a = s.answer;
    const cost = adapterCost(s);
    adapters.push([name, s.questions, fmt(s.evidenceRecall), fmt(s.answerContainment), a ? a.n : '', fmt(a?.accuracy), fmt(a?.partialRate),
      fmt(a?.declinedRate), a ? a.abstain.n : '', fmt(a?.abstain.accuracy), fmt(a?.abstain.falseAnswerRate), a ? a.errors : '', cut[name],
      s.estTokens.median ?? '', s.estTokens.p90 ?? '', a?.answerInputTokens.median ?? '', a ? fmt(cost.usd, 4) : '', a ? cost.unknown : '', fmt(costPerPoint(s), 5),
      fmt(s.latencyMs.median, 1), fmt(s.latencyMs.p90, 1), fmt(a?.answerLatencyMs.median, 1), fmt(a?.answerLatencyMs.p90, 1)]);
  }
  files['adapters.csv'] = csv(adapters);

  // One row per series and group: evidence side (scored_n) and answer side
  // (judged_n); for abstain, answer_accuracy is abstain accuracy.
  const grouped = (key, groups) => {
    const rows = [['series', key, 'scored_n', 'evidence_recall', 'answer_contained', 'judged_n', 'answer_accuracy']];
    for (const name of series) {
      const s = summary[name];
      const ev = key === 'kind' ? s.byKind : key === 'bucket' ? s.byBucket : s.bySession;
      const an = s.answer ? (key === 'kind' ? s.answer.byKind : key === 'bucket' ? s.answer.byBucket : s.answer.bySession) : {};
      for (const g of groups(s)) {
        const e = ev[g];
        const x = an[g];
        if (!e && !x) continue;
        const abstainOnly = x && x.n === 0 && x.abstainN > 0;
        rows.push([name, g, e ? e.n : 0, fmt(e?.evidenceRecall), fmt(e?.answerContainment),
          x ? (abstainOnly ? x.abstainN : x.n) : '', fmt(abstainOnly ? x.abstainAccuracy : x?.accuracy)]);
      }
    }
    return csv(rows);
  };
  files['by-kind.csv'] = grouped('kind', () => KINDS);
  files['by-distance.csv'] = grouped('bucket', () => [...BUCKETS.map((b) => b.id), 'none']);
  files['by-session.csv'] = grouped('session', (s) => [...new Set([...Object.keys(s.bySession), ...Object.keys(s.answer?.bySession || {})])].sort());

  const tokens = [['series', 'median_context_tokens', 'p90_context_tokens', 'answer_accuracy']];
  for (const name of series) tokens.push([name, summary[name].estTokens.median ?? '', summary[name].estTokens.p90 ?? '', fmt(summary[name].answer?.accuracy)]);
  files['accuracy-vs-tokens.csv'] = csv(tokens);

  const comp = [['id', 'a', 'b', 'n', 'judged', 'a_accuracy', 'b_accuracy', 'delta', 'only_a', 'only_b', 'a_evidence_recall', 'b_evidence_recall', 'a_contained', 'b_contained']];
  for (const { id, a, b, result: r } of comparisons) {
    comp.push([id, a, b, r.n, r.judged, fmt(r.accuracy.a), fmt(r.accuracy.b), fmt(r.accuracy.delta), r.onlyA, r.onlyB,
      fmt(r.evidenceRecall.a), fmt(r.evidenceRecall.b), fmt(r.answerContainment.a), fmt(r.answerContainment.b)]);
  }
  files['comparisons.csv'] = csv(comp);
  return files;
}

function renderTex({ summary, series }) {
  const lines = ['\\begin{tabular}{lrrrrrr}', '\\hline',
    'System & Evidence recall & Contained & Accuracy & Abstain acc. & Median tokens & USD \\\\', '\\hline'];
  for (const name of series) {
    const s = summary[name];
    const cost = adapterCost(s);
    lines.push(`${texEscape(name)} & ${md(s.evidenceRecall)} & ${md(s.answerContainment)} & ${md(s.answer?.accuracy)} & ${md(s.answer?.abstain.accuracy)} & `
      + `${s.estTokens.median ?? '-'} & ${s.answer && cost.unknown === 0 ? cost.usd.toFixed(2) : '-'} \\\\`);
  }
  lines.push('\\hline', '\\end{tabular}');
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(reportId, runs, { summary, series, comparisons, cut }) {
  const L = [`# LongHaul report ${reportId}`, ''];
  L.push('Aggregate numbers only: no question, answer or session text (B-D8). A series is one adapter with one configuration '
    + '(cfg: the first 8 hex of its recorded describe() hash) at one tier, answer model and judge model, from one commit; '
    + 'when several runs answer the same question for one series, the latest run counts, but a failed record never replaces a successful one.', '');
  L.push('## Runs', '', '| Run | Stage | Tier | Answer model | Judge model | Prompts (answer / judge) | Questions | Private sessions | Commit | Judge spot-check |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const run of [...runs].sort((x, y) => x.runId.localeCompare(y.runId))) {
    const c = run.config;
    const a = c.answer;
    const questions = (c.sessions || []).reduce((n, s) => n + (s.questions || 0), 0);
    const priv = (c.sessions || []).filter((s) => s.private).length;
    const spot = !run.spot ? '-' : run.spot.reviewed ? `${run.spot.agreed}/${run.spot.reviewed} agreed (${run.spot.sampled} sampled)` : `not reviewed (${run.spot.sampled} sampled)`;
    L.push(`| ${run.runId} | ${c.stage} | ${a ? a.tier : '-'} | ${a ? `${a.answerModel.provider}/${a.answerModel.model}` : '-'} | `
      + `${a ? `${a.judgeModel.provider}/${a.judgeModel.model}` : '-'} | ${a ? `${a.prompts.answer.sha256.slice(0, 12)} / ${a.prompts.judge.sha256.slice(0, 12)}` : '-'} | `
      + `${questions} | ${priv} | ${String(c.commit).slice(0, 12)} | ${spot} |`);
  }
  L.push('', '## Per adapter', '', '| Series | Questions | Evidence recall | Contained | Accuracy (n) | Partial | Declined | Abstain accuracy (n) | False answers | Contexts cut | Median tokens | p90 tokens | Cost USD | USD per accuracy point |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const name of series) {
    const s = summary[name];
    const a = s.answer;
    const cost = adapterCost(s);
    L.push(`| ${name} | ${s.questions} | ${md(s.evidenceRecall)} | ${md(s.answerContainment)} | ${a ? `${md(a.accuracy)} (${a.n})` : '-'} | ${md(a?.partialRate)} | `
      + `${md(a?.declinedRate)} | ${a ? `${md(a.abstain.accuracy)} (${a.abstain.n})` : '-'} | ${md(a?.abstain.falseAnswerRate)} | ${cut[name]} | `
      + `${s.estTokens.median ?? '-'} | ${s.estTokens.p90 ?? '-'} | ${a ? `${cost.usd.toFixed(4)}${cost.unknown ? ` + ${cost.unknown} unpriced` : ''}` : '-'} | ${md(costPerPoint(s), 5)} |`);
  }
  const table = (title, groups, pick) => {
    L.push('', `## ${title}`, '', `| Series | ${groups.join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`);
    for (const name of series) L.push(`| ${name} | ${groups.map((g) => pick(summary[name], g)).join(' | ')} |`);
  };
  const answerCell = (x) => (!x ? '-' : x.n === 0 && x.abstainN > 0 ? `${md(x.abstainAccuracy)} (${x.abstainN})` : `${md(x.accuracy)} (${x.n})`);
  table('Answer accuracy by kind (abstain: abstain accuracy)', [...KINDS], (s, k) => answerCell(s.answer?.byKind[k]));
  table('Answer accuracy by distance (estimated tokens; none: abstain)', [...BUCKETS.map((b) => b.id), 'none'], (s, b) => answerCell(s.answer?.byBucket[b]));
  table('Evidence recall by distance', BUCKETS.map((b) => b.id), (s, b) => (s.byBucket[b] ? `${md(s.byBucket[b].evidenceRecall)} (${s.byBucket[b].n})` : '-'));
  const sessions = [...new Set(series.flatMap((n) => Object.keys(summary[n].answer?.bySession || {})))].sort();
  if (sessions.length) table('Answer accuracy by session', sessions, (s, id) => answerCell(s.answer?.bySession[id]));
  if (comparisons.length) {
    L.push('', '## Named comparisons', '');
    for (const { id, title, a, b, result: r } of comparisons) {
      L.push(`- ${id}: ${a} ${md(r.accuracy.a)} vs ${b} ${md(r.accuracy.b)} over ${r.judged} paired questions (delta ${md(r.accuracy.delta)}; `
        + `right in one only: ${r.onlyA} vs ${r.onlyB}); evidence recall ${md(r.evidenceRecall.a)} vs ${md(r.evidenceRecall.b)}. ${title}.`);
    }
  }
  L.push('', '## Notes', '',
    '- Context tokens are estimated (characters / 4, recall spec §6.6); answer and judge tokens come from provider usage (spec §11).',
    '- Accuracy counts answerable questions judged correct; partial is not correct. Abstain accuracy counts abstain questions the model declined.',
    '- The judge sees the question, the reference answers and the reply, never the context. See the runs table for its spot-check agreement.',
    '- full-history and real-compaction are cut at their window; "Contexts cut" counts the questions where that happened (spec §8.1).',
    '- One question is about 0.01 of a rate at this set\'s size; differences under 0.02 are noise.',
    '- Cost is what the calls behind these records cost to make, from catalog prices at the time; cached calls are counted at their original cost.');
  return `${L.join('\n')}\n`;
}

function writeReport(home, runIds, { id = null, publicOnly = false } = {}) {
  const ids = [...new Set(runIds)].sort();
  if (!ids.length) throw new UsageError('Name the runs with --runs <runId>[,<runId>...].');
  const runs = ids.map((r) => loadRun(home, r));
  if (publicOnly) {
    const withPrivate = runs.filter((r) => (r.config.sessions || []).some((s) => s.private)).map((r) => r.runId);
    if (withPrivate.length) {
      throw new UsageError(`--public refuses runs with a private session (benchmark spec section 10.1): ${withPrivate.join(', ')}. `
        + 'Without --public the report is aggregate numbers only, which B-D8 allows publishing.', 'PRIVATE_IN_PUBLIC');
    }
  }
  const reportId = id ?? `r-${sha256Text(ids.join('\n')).slice(0, 12)}`;
  if (!REPORT_ID_RE.test(reportId)) throw new UsageError(`--id must be letters, digits, . _ - (at most 64), got ${JSON.stringify(reportId)}`);
  const dir = childPath(home.reports, reportId, () => new UsageError(`Report id ${JSON.stringify(reportId)} leaves ${home.reports}.`));
  const built = buildReport(runs);
  const files = { ...renderCsvs(built), 'adapters.tex': renderTex(built), 'report.md': renderMarkdown(reportId, runs, built) };
  for (const [name, content] of Object.entries(files)) writeFileAtomic(path.join(dir, name), content);
  return { id: reportId, dir, files: Object.keys(files).sort() };
}

module.exports = { loadRun, cohortOf, seriesOf, buildReport, writeReport };
```

- [ ] **Step 4: Write the command and register it**

Create `src/longhaul/commands/report.js`:

```js
'use strict';
// `longhaul report --runs <runId>[,<runId>...] [--id <name>] [--public]`
const { writeReport } = require('../report');
const { UsageError } = require('../errors');

module.exports = {
  options: { runs: { type: 'string' }, id: { type: 'string' }, public: { type: 'boolean', default: false } },
  async run(ctx, values) {
    if (!values.runs) throw new UsageError('Usage: longhaul report --runs <runId>[,<runId>...] [--id <name>] [--public]');
    const runIds = values.runs.split(',').map((s) => s.trim()).filter(Boolean);
    const out = writeReport(ctx.home, runIds, { id: values.id ?? null, publicOnly: values.public });
    ctx.stdout.write(`report ${out.id} -> ${out.dir}\n`);
    for (const f of out.files) ctx.stdout.write(`  ${f}\n`);
    return 0;
  }
};
```

In `src/longhaul/cli.js`, add `report: require('./commands/report'),` to `COMMANDS`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/longhaul-report.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/report.js src/longhaul/commands/report.js src/longhaul/cli.js tests/longhaul-report.test.js
git commit -m "feat(longhaul): report: publishable aggregate tables (markdown, CSV, LaTeX) from one or more runs"
```

---

## Task 15: `longhaul author --kinds`

**Files:**
- Modify: `src/longhaul/commands/author.js`
- Test: `tests/longhaul-author.test.js` (append)

**Interfaces:**
- Consumes: `KINDS` (`questions.js`); `planAuthoring(index, { count, seed, kinds, excludeSeqs })` (it already takes `kinds`).
- Produces: `longhaul author ... --kinds decision[,superseded...]`, which plans only those kinds. It refuses an unknown kind with exit 2 before any model client is built, and the author log line gains `kinds`.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block of `tests/longhaul-author.test.js` that owns the fake server (the one with `server`):

```js
  it('--kinds plans only the kinds named, logs them, and refuses an unknown kind before any call', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const e = { ...env, OPENAI_API_KEY: 'test-key-123456' };
    const args = ['author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model', '--base-url', `${server.url}/openai/v1`, '--count', '4'];
    const calls = server.requests.length;
    const bad = sink();
    assert.strictEqual(await main([...args, '--kinds', 'decision,nope'], { stdout: sink(), stderr: bad, env: e }), 2);
    assert.match(bad.text, /--kinds/);
    assert.strictEqual(server.requests.length, calls);
    assert.strictEqual(await main([...args, '--kinds', 'decision'], { stdout: sink(), stderr: sink(), env: e }), 0);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(log.at(-1).kinds, ['decision']);
    assert.ok(log.at(-1).planned >= 1 && log.at(-1).planned <= 4);
    assert.strictEqual(server.requests.length - calls, log.at(-1).planned, 'one call per planned decision item');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/longhaul-author.test.js`
Expected: FAIL: `--kinds` is an unknown option (parseArgs strict), so both calls exit 2.

- [ ] **Step 3: Write the implementation**

In `src/longhaul/commands/author.js`:

1. Change the questions require to `const { KINDS, writeQuestions, questionsFile, authorLogFile } = require('../questions');`.
2. Set `USAGE` to `'Usage: longhaul author --session <id> --provider <provider> --model <model> [--base-url <url>] [--count 60] [--seed 1] [--kinds decision,superseded] [--send-private]'`.
3. Add `kinds: { type: 'string' },` to `options`.
4. Add above `module.exports`:

```js
// --kinds decision,superseded: plan only these kinds (for topping up a kind
// the set is short of, such as decision questions).
function parseKinds(raw) {
  const list = [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = list.filter((k) => !KINDS.includes(k));
  if (!list.length || bad.length) throw new UsageError(`--kinds takes kinds from ${KINDS.join(', ')}, got ${JSON.stringify(raw)}`);
  return list;
}
```

5. In `run`, right after `const seed = ...`, add `const kinds = values.kinds !== undefined ? parseKinds(values.kinds) : [...KINDS];`.
6. Change the plan line to `const plan = planAuthoring(session.index, { count, seed, kinds, excludeSeqs });`.
7. Add `kinds,` to `logLine` after `count,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/longhaul-author.test.js tests/longhaul-sampling.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/commands/author.js tests/longhaul-author.test.js
git commit -m "feat(longhaul): author --kinds, to top up one kind of question"
```

---

## Task 16: Docs, the CI smoke and the suite

**Files:**
- Modify: `CLAUDE.md` (the LongHaul section), `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (a B3 addendum), `tests/longhaul-smoke.test.js`, `.github/workflows/test.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: the documented answer stage, a CI smoke run of it with `--fake-models`, and the suite result.

- [ ] **Step 1: Add the answer-stage smoke test**

Append to `tests/longhaul-smoke.test.js`:

```js
describe('longhaul answer-stage smoke run', () => {
  it('answers and judges the fixtures with --fake-models: every adapter, both tiers, $0, no network', () => {
    const { root } = tmpHome();
    const run = (tier, adapters) => spawnSync(process.execPath, [
      path.join('bin', 'longhaul.js'), 'run', '--sessions', path.join('tests', 'fixtures', 'longhaul'),
      '--adapters', adapters, '--tier', tier, '--fake-models'
    ], { cwd: REPO, encoding: 'utf8', env: { ...process.env, LONGHAUL_HOME: root } });
    const grid = run('grid', 'kl-recall,kl-recall-whole,sliding-window,oracle,summarize-compact,real-compaction');
    assert.strictEqual(grid.status, 0, grid.stderr);
    assert.match(grid.stdout, /whole-messages: kl-recall/);
    const frontier = run('frontier', 'oracle,full-history');
    assert.strictEqual(frontier.status, 0, frontier.stderr);
    for (const runId of fs.readdirSync(path.join(root, 'runs'))) {
      const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'summary.json'), 'utf8'));
      for (const s of Object.values(summary)) {
        assert.strictEqual(s.leaks, 0);
        assert.strictEqual(s.answer.abstain.accuracy, 1);
      }
    }
  });
});
```

Run: `node --test tests/longhaul-smoke.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 2: Run the smoke in CI**

In `.github/workflows/test.yml`, after the existing `longhaul.js run` step, add:

```yaml
      - run: node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle,summarize-compact,real-compaction --fake-models
        env:
          LONGHAUL_HOME: ${{ runner.temp }}/longhaul
```

- [ ] **Step 3: Update CLAUDE.md**

In the `## LongHaul (session memory benchmark)` section, the opening sentence's parenthesis spans two lines (`...design.md`; stage` then `B0 scores evidence recall only, ...`). Replace the single line
`B0 scores evidence recall only, with no answer or judge model). It is`
with
`B0 scores evidence recall; stage B3 adds the answer stage and reports). It is`
and leave the line before it (ending `; stage`) as it is. Then append these bullets at the end of the section:

```markdown
- The answer stage (B3): `longhaul run ... --answer-provider <p> --answer-model <m>
  --judge-provider <p> --judge-model <m>` adds answer accuracy (answerable questions
  judged `correct`), abstain accuracy (abstain questions the model declined) and the
  false-answer rate. The judge never sees the context and is never the answer model.
  Prompts are `src/longhaul/prompts/*-v1.md`; a change is a new versioned file, and
  every run's `config.json` records their hashes. Adapters added: `full-history`
  (frontier tier only, 128K window), `real-compaction` (sessions with recorded
  compactions only), `summarize-compact` (a summarizer model every 10K tokens, answer
  stage only) and `kl-recall-whole` (the whole-message comparison the summary prints).
- Before any call, a run prices its plan from `Catalog#price` (input at 3 characters a
  token, output at max tokens: a close bound, not a guarantee; a spend guard stops the
  run at the cap and never resets within it) and refuses over `--max-usd` (default
  $50) or with an unpriced model unless `--allow-unpriced`; `--dry-run` prints the plan
  and calls nothing. `--tier frontier --sample 150 --long-context-sample N` is the
  headline sample. `full-history` and `real-compaction` are capped at what the answer
  model's catalog window holds (128K when unknown). A private session needs
  `--send-private` for the answer stage too. `runs/<id>/spend.json` is rewritten as
  the run goes, with `stoppedBy` when a run stops. Run no other `longhaul` command on the
  same `LONGHAUL_HOME` while a run is going: `run` starts by removing `tmp/kl-*` dirs,
  which would delete another run's contexts or an `embed`'s temp store.
- Model calls are cached under `LONGHAUL_HOME/private/model-cache/` (answers, verdicts,
  summaries: private text), so a rerun or a resumed run pays only for missing calls.
  Records hold verdicts and numbers only; the 10% judge sample is
  `private/spot-checks/<runId>.jsonl`, reviewed with `longhaul spot-check --run <id>
  --reviewer <initials>`. `longhaul report --runs <id>,<id>` writes publishable
  aggregate tables to `reports/<id>/` (`--public` refuses private runs); a series
  there is one adapter configuration at one tier, answer model, judge model and
  commit.
- Smoke run of the answer stage (no models, no network, $0):
  `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle,summarize-compact,real-compaction --fake-models`.
```

- [ ] **Step 4: Add the B3 addendum to the benchmark spec**

In `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md`, insert this §7 addendum as its own paragraph immediately before the §7 paragraph that begins ``evidenceSeqsShown` is how an adapter reports`` (after the B0 addenda, which H3 Task 16 amends later; anchor on that paragraph, not on the addenda's text):

```markdown
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
```

Then append after the last paragraph of §8.1:

```markdown
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
judge model and commit.
```

- [ ] **Step 5: Run the LongHaul tests together**

Run: `node --test tests/longhaul-*.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: The full suite, if `main` is green**

The owner reported the full `npm test` broken on `main` for reasons unrelated to LongHaul. Check `main` first, in a throwaway worktree:

```bash
git worktree add --detach ../king-louie-main-check main
cd ../king-louie-main-check && npm ci && npm test; cd -
git worktree remove ../king-louie-main-check --force
```

`--detach` is required: `main` is checked out in this working tree, and git refuses a second worktree on the same branch.

If `main` shows `# fail 0`, run `npm test` on this branch and require `# fail 0`. If `main` fails, do not run the full suite here. Step 5's LongHaul run is the gate, and the task report must say so, naming the files that fail on `main`. Nothing in `src/ipc/`, `main.js` or the renderer changed, so the e2e suite is not needed.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md tests/longhaul-smoke.test.js .github/workflows/test.yml
git commit -m "docs(longhaul): the answer stage, its cost gate, cache and report; CI smoke with --fake-models"
```

---
## Task 17: Owner runbook: the question set, the grid run and the frontier run (not code)

The owner does this task, not an agent: the sessions are private, only the owner can verify their questions, and the runs spend real money. It turns B3 into numbers for the recall defaults (the shipped H3 path included) and for the paper.

### Expected cost

These come from the catalog prices in the measured facts and in the catalog: `deepseek/deepseek-v4-flash` $0.15/$0.60, `openai/gpt-6-luna` $0.1/$0.5, `openai/gpt-6-sol` $2/$10, `anthropic/claude-opus-5-5` $4/$20 and `anthropic/claude-haiku-4-5` $1/$5 per million tokens. The inputs are 138 questions (150 after the top-up) and about 12K context tokens for each budget-sized adapter (`kl-recall` p90 13.1K). Two sizes are assumed and not measured: `real-compaction` at about 90K a question and `full-history` at about 120K (both capped at 128K). The summaries assume about 5M session tokens in all, re-summarized every 10K. Replies are counted at about 100 tokens and verdicts at about 60.

"Expected" takes provider tokens as equal to estimated tokens. "Dry-run bound" is what `--dry-run` prints: input at 3 characters a token (4/3 of expected) and every output at its max tokens. The run refuses when this bound is over the cap. Expect the dry run to read 20 to 40% above the bill.

| Run | Answer model | What | Expected | Dry-run bound |
|---|---|---|---|---|
| The brief's rule of thumb | deepseek-v4-flash | 103 to 138 questions × 6 adapters × 12K (input only) | $1.1 to $1.5 | |
| The brief's rule of thumb | gpt-6-luna | same | $0.7 to $1.0 | |
| **Grid** | deepseek-v4-flash | 138 × {kl-recall, kl-recall-whole, kl-recall-vec (local embedder), sliding-window, oracle, summarize-compact}: 9.9M in, $1.54 · real-compaction: 12.4M in, $1.89 · ~500 summaries: $1.35 · 966 judgments (haiku): $0.97 | **≈ $5.8** | ≈ $8.8 |
| Grid | gpt-6-luna | same | ≈ $4.2 | ≈ $6.8 |
| Grid, optional Step 5b | deepseek-v4-flash | 138 × kl-recall-vec with whole messages: 1.7M in, $0.26 · 138 judgments: $0.14 | ≈ $0.4 | ≈ $0.7 |
| **Frontier (recommended)** | gpt-6-sol | 150 × {kl-recall, sliding-window, oracle, summarize-compact}: 7.2M in, $15.0 · full-history and real-compaction on `--long-context-sample 40`: 8.4M in, $16.9 · 680 judgments: $0.7 · summaries: cached from the grid, $0 | **≈ $33** | ≈ $47 |
| Frontier, all 6 adapters on all 150 | gpt-6-sol | + full-history 18M and real-compaction 13.5M in | ≈ $83 | ≈ $115 (refused) |
| Frontier, all 6 on all 150 | claude-opus-5-5 | same | ≈ $166 | refused |
| Frontier, no long-context adapters | claude-opus-5-5 | 150 × 4 budget-sized adapters | ≈ $31 | ≈ $45 |

The grid rows add `kl-recall-vec` with the local embedder (`--embed-provider local`) to the five budget-sized adapters: after H3 it is the path the app ships, and `kl-recall` (BM25 only) is the fallback when no embedder is ready. Its row is priced like `kl-recall`'s (about 12K tokens a question, 138 more answers and judgments); its embeddings are local and cost nothing. The frontier rows are unchanged: six adapters, `kl-recall-vec` left out to stay under the cap.

The recommended program (a grid run with deepseek-v4-flash and a frontier run with gpt-6-sol and `--long-context-sample 40`) is expected to cost about $39, about $39.2 with the optional Step 5b run. Each run's bound is under its own $50 cap.

- [ ] **Step 1: Preconditions**

B3 Tasks 1 to 16 and H3 Tasks 1 to 16 are merged, in the ruled order (H3 1–14, B3 1–16, H3 15–16), so the recall defaults the app ships are final before the grid run. Do not land an H3 change, or any other change to the recall defaults, between the grid run (Step 5) and the frontier run (Step 8): the answer cache key includes each adapter's `describe()`, which holds the full recall settings, so a default change re-prices every `kl-recall` answer and the two runs stop describing the same system (a report would also split them into different series). The local embedder's vectors are cached on this home for every session with the model H3 Task 16 settled (its Step 1 ran `longhaul embed --provider local --model <model>`; run it again for any session added since). `node bin/longhaul.js home` prints a directory outside every repository.

While a run is going (Steps 4, 5, 5b and 8), run no other `longhaul` command on the same `LONGHAUL_HOME`: every `run` starts with `removeStaleTmp`, which deletes every `tmp/kl-*` dir, including a running run's contexts (`kl-ctx-<runId>`), its `kl-recall` temp stores and an `embed`'s `kl-embed-<pid>`. Run them one after another, or give a second one its own `LONGHAUL_HOME`. The keys are in the environment: `DEEPSEEK_API_KEY` (grid answers and summaries), `ANTHROPIC_API_KEY` (judge), `OPENAI_API_KEY` (frontier, and authoring if you author with OpenAI). Confirm the models the Open Questions settle.

- [ ] **Step 2: Top up session E to at least 40 verified questions**

E has 37. Author a dozen candidates with a new seed, then verify:

```bash
node bin/longhaul.js author --session E --provider <provider> --model <model> --count 12 --seed 7 --send-private
node bin/longhaul.js verify --session E --reviewer <initials>
```

The closing line of `verify` prints the verified count per kind. Stop once E has at least 40, with at least 5 `abstain` and 5 `superseded` (spec §6).

- [ ] **Step 3: Add `decision` questions across the sessions**

The 7 existing `decision` questions all scored 0 on containment because they paraphrase; the judge is what can score them. Aim for at least 3 verified per session:

```bash
node bin/longhaul.js author --session <E|F|G|H> --kinds decision --count 6 --seed 11 --send-private
node bin/longhaul.js verify --session <E|F|G|H> --reviewer <initials>
```

While verifying a `decision` question, write the answer as the decision **and** its reason. List in `acceptableAnswers` only other wordings of that whole answer, never the decision alone: the judge rules a decision without its reason `partial` (Task 3). Re-open the 7 existing `decision` questions in `verify` (`e`) and fix their `acceptableAnswers` the same way; an edit changes their cache keys, so they are answered afresh.

- [ ] **Step 4: Price the grid run**

```bash
node bin/longhaul.js run --adapters kl-recall,kl-recall-whole,kl-recall-vec,sliding-window,oracle,summarize-compact,real-compaction \
  --embed-provider local --embed-model <the model H3 Task 16 settled> \
  --tier grid --answer-provider deepseek --answer-model deepseek-v4-flash \
  --judge-provider anthropic --judge-model claude-haiku-4-5 --dry-run
```

Expected: a `plan:` line, one line per role and adapter, and an `estimate:` of about $9 (the bound), then `dry run: no model was called`. The dry run builds every context, so `kl-recall-vec` embeds any question its cache lacks with the local embedder (nothing leaves the machine). An `UNPRICED` refusal means the catalog lacks one of the models; run `king-louie-service models refresh` or pick a priced model. `--allow-unpriced` runs without a price, and its cost is reported as unknown.

- [ ] **Step 5: Run the grid tier**

Run the same command without `--dry-run`, with `--send-private`. Expect about $6 and two to four hours, mostly the roughly 500 summaries, which run one after another (each builds on the last). The answer calls run 4 at a time (`--concurrency`). If the run stops (a network drop, Ctrl-C, a 401), run the same command again. Finished calls come from the cache for nothing, and the new plan line shows how many are cached. Exit 1 with `LEAK` is a defect: stop and report the `leaked` records. Exit 1 with `STOPPED AT THE CAP` means the estimate was low: raise `--max-usd` a little and run again.

- [ ] **Step 5b (optional, about $0.40): the whole-message variant of the shipped path**

`kl-recall-whole` answers the whole-message question for BM25 only. To ask it of the path the app ships, run `kl-recall-vec` alone with the two settings on (after the grid run finishes, not alongside it):

```bash
node bin/longhaul.js run --adapters kl-recall-vec --embed-provider local --embed-model <the same model> \
  --recall completeMessageTokens=800 --recall pairToolMessages=true \
  --tier grid --answer-provider deepseek --answer-model deepseek-v4-flash \
  --judge-provider anthropic --judge-model claude-haiku-4-5 --send-private
```

Its record set is a separate series in the report (its `describe()` differs), so compare its row with the grid run's `kl-recall-vec` row in Step 9's `adapters.csv` by hand; `whole-messages` is the only named comparison, and it pairs `kl-recall` with `kl-recall-whole`.

- [ ] **Step 6: Spot-check the judge**

```bash
node bin/longhaul.js spot-check --run <grid runId> --reviewer <initials>
```

About 85 judgments, roughly 30 minutes. Give your own verdict on each. If agreement is under 0.9, the judge prompt needs a v2 (`judge-v2.md`, a new `PROMPTS` entry, and new cache keys) before any money goes to the frontier run.

- [ ] **Step 7: Read the whole-message comparison**

In the grid run's `summary.md`, under "Named comparisons", read the `whole-messages` line, and, if Step 5b ran, the two `kl-recall-vec` rows. If `kl-recall-whole` beats `kl-recall` on answer accuracy by 0.02 or more, and more questions are right only with whole messages than only without them (and Step 5b, if run, points the same way for `kl-recall-vec`), record it as the evidence for a follow-up change of the defaults: `completeMessageTokens 800` and `pairToolMessages` on, a new LongHaul-backed default under recall spec §6.7, made in its own change after the frontier run (Step 8), never between the grid and frontier runs. H3 has already landed by now, so this is not an H3 change. Otherwise keep them off and record why.

- [ ] **Step 8: Price and run the frontier tier**

```bash
node bin/longhaul.js run --adapters kl-recall,sliding-window,oracle,summarize-compact,full-history,real-compaction \
  --tier frontier --sample 150 --long-context-sample 40 \
  --answer-provider openai --answer-model gpt-6-sol \
  --summarizer-provider deepseek --summarizer-model deepseek-v4-flash \
  --judge-provider anthropic --judge-model claude-haiku-4-5 --dry-run
```

Expected: an estimate bound of about $47. Pass `--summarizer-*` as the grid's model so the grid's summaries are reused from the cache. If the bound is over $50, lower `--long-context-sample` (each question there costs about $0.60 on the bound, for the two adapters together) rather than raise the cap. Then run it without `--dry-run`, with `--send-private`, and spot-check it as in Step 6.

- [ ] **Step 9: Build the report**

```bash
node bin/longhaul.js report --runs <grid runId>,<frontier runId> --id b3-2026-10
```

`LONGHAUL_HOME/reports/b3-2026-10/` holds aggregate numbers only, which may be published (B-D8). Copy `report.md` and the CSVs to wherever the paper and the H3 plan are written. Copy nothing from `runs/` or `private/`.

- [ ] **Step 10: Record the results**

Report per adapter: answer accuracy, abstain accuracy and the false-answer rate. Add accuracy against distance (the headline figure, `by-distance.csv`) and accuracy against context tokens (`accuracy-vs-tokens.csv`). Include the judge agreement, the whole-message verdict (Step 7), and the questions where `full-history` or `real-compaction` were cut (the "Contexts cut" column, a stated limitation). Finally, give the spend of each run (`spend.json`) next to its estimate, so the next plan can calibrate the dry run.

---

## Notes on the B0 seams

- **`scoreOne` returns `{ record, text }`** (Task 11). It is internal to `run.js`, so nothing else changes.
- **Records gain fields; none are removed or renamed.** A B0 run's summary is unchanged apart from the new `bySession`, `answer: null` and `setup: null` keys and the config's `skippedAdapters`, which no B0 test pins.
- **`oracle`'s tail** stays at `TAIL_DEFAULTS` (8 messages, 6K tokens), while `kl-recall` uses the shipped tail (see the recall spec §6.1; after H3 it is counted in user turns, not messages). `oracle` is the answerability bound on evidence, and its tail only frames it, so this stage leaves it as it is; changing it would move B0's published oracle numbers.
- **`embeddings.js`** now takes `retryable` from `retry.js` (Task 1). Its own six-attempt loop is unchanged.

## Decisions (2026-09-30)

These are rulings where the spec, the measured facts, the brief and the code disagreed, or where the spec was silent.

1. **Where the model cache lives.** Spec §11 says `runs/<id>/cache/`. The cache lives instead in `LONGHAUL_HOME/private/model-cache/`, shared by every run. The reasons: its entries are model text about private sessions (answers, verdict reasons, summaries), and runs hold ids and numbers only; a crashed run's rerun has a new run id, so a per-run cache could not make the resume free; and the grid and frontier runs share summaries. Keys cover everything that shapes the request: for an answer, the adapter config hash, session and question id, question hash, context hash, the empty-context text, provider, model, base URL (when one is given), prompt hash and max tokens; for a judgment and a summary, the hash of the prompt as sent (Tasks 2, 8 and 10). The spec gets an addendum (Task 16).
2. **Four verdicts, not three.** The brief listed correct, incorrect and abstained; spec §8 lists correct, partial, incorrect and abstained. The plan keeps four. Answer accuracy counts `correct` only; `partial` is reported apart. For `abstain` questions only `abstained` is right, and any other verdict is a false answer (Task 3).
3. **The cost tiers against the measured context sizes.** B-D7's "$25 to $35 at about 500 questions" assumed contexts of about 8K. `full-history` capped at 128K on 150 questions alone costs about $36 on gpt-6-sol and $72 on claude-opus-5-5, and `real-compaction` is of the same order. Two responses: the long-context adapters answer the first N questions of the stratified sample (`--long-context-sample`), and the dry run prices every choice before a call. Task 17 has the table. The spec gets an addendum.
4. **The frontier sample comes from a new `sampleQuestions` in `sampling.js`.** The brief said to reuse `sampling.js`, but it held only `planAuthoring`, which samples authoring anchors. The new function reuses `createRng` and gives equal allocation across kind × distance strata (like `planAuthoring`'s `splitEvenly`), in an order where every prefix is stratified. With about 150 verified questions, a 150-question sample is nearly the whole set; `--long-context-sample` is where the stratification matters.
5. **`real-compaction`'s edges.** Spec §7 says "for sessions with real compaction events only", so a session without compactions is skipped and listed in `config.json` (`skippedAdapters`) rather than given its whole prefix. A question asked before the first compaction gets the whole prefix, as the brief says. The context is capped at 128K like `full-history`. The spec is silent on this; Claude Code's own window was larger, and without the cap the frontier cost is unbounded. The summary message is not counted as evidence shown.
6. **`summarize-compact`'s cadence** is a token interval (spec §16), 10K by default. That keeps its context at the other adapters' budget, and the sessions' own compaction points are `real-compaction`'s job. Open Question 4 asks the owner to confirm the value. It runs only in the answer stage; an evidence-only run refuses it.
7. **Report publishability.** B-D8 lets aggregate results from private sessions be published, while §10.1 says `report --public` refuses private sessions. Ruling: a report is always aggregate-only (no text, no question ids), so the default report is publishable under B-D8. `--public` is the stricter mode for a release bundle and refuses any run with a private session (Task 14).
8. **The report also writes `adapters.tex`,** since spec §11 lists a LaTeX table, though the brief named Markdown and CSV only.
9. **The synthetic fixtures need no change.** `synth-compacted` already records two compactions (#151 and #302), and their summaries never mention a planted fact, so `real-compaction` is testable as is. The "before the first compaction" case uses a question built inside the test.
10. **An unparsable verdict is not re-asked.** Spec §15 says it is recorded as an error. The raw reply is cached, so a parser fix later re-reads it for nothing.
11. **Cost in reports and in `spend.json`.** A cached call counts at what it cost when made: the report's cost is what the result cost to produce. `spend.json`'s `spentUsd` is what this invocation paid. An unknown price is counted apart, never as $0. A model the catalog cannot price refuses the run unless `--allow-unpriced`.
12. **The estimate is a close bound, backstopped by the spend guard, not an upper bound.** Input at 3 characters a token and output at max tokens over-count prose, but dense text (code, JSON, non-English) can run under 3 characters a token, and billed reasoning is not in the plan, so a real bill can exceed it. The spend guard reserves each call's own estimate before it goes out, stops at the cap and never resets within a run (every later call is recorded `over-budget`; a rerun finishes the rest from the cache). It is not made to reset: a run that crossed the cap once should be looked at before more money goes out.
13. **B0 tests that pinned the old adapter registry** (`full-history` unknown, the exact list in two files) are updated in Tasks 6 to 8 rather than left to fail.
14. **`author --kinds`** is new. `planAuthoring` already took `kinds`, but the CLI planned every kind, so topping up decision questions needed it (Task 15).
15. **The long-context adapters are capped at the answer model's window** (spec §7 says `full-history` is what "fits the model's window"; §8.1 names only the 128K cap). The cap is the catalog's `limits.context` less the reply and 1,000 tokens of prompt, converted at 3 characters a real token (`contextCapTokens`, Task 11), and at most the adapter's own window (128K by default, `--full-history-tokens`). An unknown window keeps 128K. Without it, a context over the window is a 400 recorded as an error, which would bias long-context accuracy downward. `real-compaction` gets the same cap.
16. **The judge's cache key is the rendered prompt's hash.** `JUDGE_KIND_RULES` and the no-reference, no-other-answers and empty-reply texts live in `judge.js`, not in `judge-v1.md`, so the file's hash alone would let an edited rule reuse old verdicts. The key hashes the prompt as sent (as a summary's does), and `config.json` records `rulesSha256` next to the file's hash (Tasks 3, 10 and 11). Moving the rules into the `.md` was the alternative; it would put six kind-specific lines into one template with no conditional, so the rules stay in code.
17. **`spend.json` is written as the run goes,** after each summarizer setup and each answered-and-judged item, and on a stop (`stoppedBy`), not only at the end, so a run cut off still says what it paid (Task 11).
18. **The summarizer follows spec §15 like the answer and the judge.** Its calls are retried three times; a call that still fails records that adapter's questions in that session as `summary-failed[:status]` context errors, and a refused key (401/403) stops the run with `AUTH`, exit 2 (Task 11).
19. **A report series is one adapter configuration at one tier, answer model, judge model and commit** (`seriesOf`, Task 14): `describe()` holds the recall settings, so runs before and after a default change, or with another judge, never merge into one row. When runs overlap, the latest record wins unless it failed where an earlier one succeeded.
20. **`real-compaction` shows only the latest summary before `askAtSeq`**, where spec §7 says "the real summaries": after a compaction, Claude Code's own context held only its latest summary, which was written from a context holding the one before. Showing all of them would give it more than the harness had.
21. **`full-history` may run in an evidence-only run** (no model, its 128K window), although spec §8.1 puts it in the frontier tier only; the frontier-only rule applies to the answer stage, where it costs money (`selectQuestions` refuses it in the grid tier).
22. **An adapter's setup cost is recorded once per (adapter, session)**, in `spend.json`'s `setupCosts` and the summary's `setup`, not per question as spec §8 step 5 lists: `summarize-compact`'s summaries serve every question after them, and splitting their cost across questions would be arbitrary.
23. **`kl-recall-whole` is a new adapter** (Task 6), not in spec §7's table; Task 16 adds a §7 addendum for it and for rulings 15, 20, 21 and 22.
24. **Pass 1 can embed questions.** Building `kl-recall-vec`'s contexts embeds any question its cache lacks: with `--embed-provider openai` and `--send-private` that is a hosted call before the estimate, and during `--dry-run`, priced by nothing in the plan (text-embedding-3-small at $0.02 per million tokens, a few cents at most). It is not gated: run `longhaul embed` first to cache every question, or use the local embedder, which sends nothing (Task 17 does).
25. **The answer cache key omits nothing that changes the request,** including `--answer-base-url`: a client built with a base URL carries `baseUrl`, which the answer, judge and summary keys include (Tasks 8, 10 and 12).

## Open Questions for the owner

1. **The grid answer model.** *Recommended:* `deepseek/deepseek-v4-flash` through DeepSeek's API (`DEEPSEEK_API_KEY`; the catalog prices it at $0.15/$0.60). It is open-weight, which is the "DeepSeek V4 Flash class" of spec §8.1. The alternatives:
   - `openrouter/deepseek/deepseek-v4-flash`, which the catalog prices at $0.047/$0.094. It is cheaper, but the host behind OpenRouter can change between runs, which hurts reproducibility.
   - A self-hosted OpenAI-compatible endpoint via `--answer-base-url`. It is unpriced, so it needs `--allow-unpriced`.
   - `openai/gpt-6-luna` ($0.1/$0.5), if no open-weight endpoint is wanted. It is not open-weight.

   The catalog prices deepseek-v4-flash's reasoning tokens. If it reasons by default, raise `--answer-max-tokens` to about 1,000, which adds about $0.2.
2. **The judge.** *Recommended:* `anthropic/claude-haiku-4-5` ($1/$5, priced in the catalog). It is a Haiku-class model as spec §8.1 asks, from a different vendor than both answer models, which avoids a judge favouring its own family.
3. **The frontier model, and how many questions the long-context adapters get.** *Recommended:* `openai/gpt-6-sol` ($2/$10; `anthropic/claude-sonnet-5` costs the same) with `--long-context-sample 40`: about $33 expected, $47 on the dry-run bound. `claude-opus-5-5` fits only without `full-history` and `real-compaction` (about $31 for the 4 budget-sized adapters on 150 questions), as a separate run if a second frontier model is wanted.
4. **`summarize-compact`'s cadence.** *Recommended:* 10K tokens, so its context matches the other adapters' budget and it is a fair baseline at equal tokens. A harness-like 150K would give contexts of about 150K and cost like `full-history`, and `real-compaction` already shows what a real harness kept.
5. **The summarizer.** *Recommended:* the grid's answer model (`deepseek-v4-flash`) for both tiers, so the frontier run reuses the grid's cached summaries for $0. The frontier `summarize-compact` then measures a frontier model reading a cheap model's summary, which the report should state. Frontier-written summaries would add about $20 on gpt-6-sol and push that run over $50.
6. **What the $50 cap covers.** B-D7 says "per full run". The code caps each `longhaul run` invocation at $50 by default. *Recommended:* keep the cap per invocation. The recommended grid plus frontier program is about $39 expected, and each run's bound is under $50.
7. **Judge validation before the frontier spend.** *Recommended:* the owner reviews the grid run's 10% sample (about 85 judgments) first. If agreement is under 0.9, write `judge-v2.md` before the frontier run.
8. **The reference answers of `decision` questions.** *Recommended:* the answer states the decision and its reason, and `acceptableAnswers` lists only other wordings of that whole answer. The 7 existing ones get re-checked in `verify`. Only the owner can write these (Task 17, Step 3).
