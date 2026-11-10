# LongHaul B2: Public Converters and Constructed Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `longhaul convert` turns a downloaded public agent-trajectory dataset into public LongHaul sessions, joining one repository's consecutive trajectories into a `constructed` session long enough to ask long-distance questions in.

**Architecture:** `src/longhaul/converters/` holds one shared mapper from OpenAI-style message lists to LongHaul messages, one small definition per dataset (`nebius-swe-rebench`, `open-swe-traces`), and the constructed-session planner. `src/longhaul/converting.js` streams the input twice: pass 1 reads only each row's repo, ids, license and size and plans the sessions; pass 2 re-reads the selected rows and writes each session through `writeSession`. The manifest gains `boundaries`; questions gain a computed `crossesBoundary`.

**Tech Stack:** Node (CommonJS), `node:test`, `readJsonlLines`, `hyparquet` (owner decision 1).

**Spec:** `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` §4 (session and manifest), §5 (question validity), §10.2 (public sessions, `constructed`, boundary flag), §13 (B2), B-D4, B-D6 (licenses).

## Global Constraints

- Everything stays in `src/longhaul/`; nothing outside it requires it (`tests/longhaul-boundary.test.js`).
- No network in tests. Fixtures are invented rows in the datasets' shapes (`example-org/widget-kit`, made-up ids and text), under `tests/fixtures/longhaul-converters/`; never a real row.
- Input is a local file the owner downloaded from Hugging Face, read as rows with the dataset's own column names: a `.parquet` file (or a directory of them, read in name order: Open-SWE-Traces ships several files per split) through `hyparquet`, or a `.jsonl` file, one row per line. Any other extension is refused `USAGE`.
- `hyparquet` is pinned exactly to `1.31.5` in `devDependencies` (LongHaul is left out of the Electron build, so it must not reach the package). It is ESM only: load it with `await import('hyparquet')` inside `rows.js`, never `require`.
- No parquet writer is a dependency. The one parquet fixture is made from the JSONL fixture by `tests/fixtures/longhaul-converters/make-parquet.mjs`, run once with `npm exec --yes --package hyparquet-writer@0.9.1 -- node tests/fixtures/longhaul-converters/make-parquet.mjs` (check that version exists and is at least two weeks old; pin whatever exact version is used in the script's header comment), and committed with the script.
- JSONL is read with `readJsonlLines` (`src/history/importers/jsonl-lines.js`), never `node:readline`.
- Converted sessions are public: `private: false`, `license: 'CC-BY-4.0'` (both datasets' card license), plus `upstreamLicense` (the repository's SPDX id, or `'unknown-upstream'`). An input file inside `LONGHAUL_HOME/private/` is refused, as `import --public` refuses one.
- Session ids match `SESSION_ID_RE`; ids are derived, never typed by hand.
- No absolute input path is recorded (the `importing.js` `sourceRef` rule).
- Converters produce no compactions (§4).

## Decisions this plan makes (no owner input needed)

- **System messages** are dropped (counted in `stats.skipped.system`): every trajectory repeats the same scaffold prompt, which would dominate BM25 and recall nothing.
- **`reasoning_content`** stays out of message text (its length is kept as `meta.reasoningChars`): the owner's Claude Code sessions carry no such text, and keeping it would make public sessions unlike private ones.
- **One trajectory per `instance_id`** in a constructed session (the first by `trajectory_id`, code-unit order): repeated attempts at one task would put near-duplicate evidence in one session and make questions easy.
- **Timestamps** do not exist in either dataset; message `timestamp` is `2000-01-01T00:00:00.000Z` plus `(seq - 1)` seconds, and the manifest says `timestampsSynthetic: true`. Seq stays the only clock (§16).
- **Default `--target-tokens 500000`, `--min-tokens 250000`.** The owner's sessions run 0.17M to 2.5M estimated tokens (§18) and the distance buckets reach 200K-1M and beyond (§5). A rebench trajectory is about 15K to 25K tokens (64 turns on average), so 500K is about 20 to 35 trajectories, within the about 37 runs per repository the card reports; a 250K floor means every session has questions in the 200K-1M bucket. The `>1M` bucket is left to the private set and said in the report.
- **`crossesBoundary`** means the question's evidence messages lie in more than one trajectory. It cannot mean "ask and evidence in different trajectories": in a constructed session every `askAtSeq` is a trajectory's task prompt (the only `user` messages), so that would flag every question.

## Review Focus

1. A NVIDIA `tool` message with no `tool_call_id` after an assistant message that made two calls: paired by order to the first, then the second; a third result with nothing pending gets `toolName: 'unknown'` and counts `stats.unpaired`.
2. `function.arguments` that is not valid JSON (truncated, or already an object): `parameters: { raw: <string> }` with `stats.badArguments` counted, or the object as is; never a thrown error that loses the session.
3. A repository whose trajectories add up to less than `--min-tokens`: no session, listed in the `--dry-run` plan and the summary line as too short.
4. Running `convert` twice with the same input and flags: every session `unchanged`; different flags or input over an existing id refused without `--force`.
5. A row with an unknown role, or `content` that is an array or `null`: an unknown role is a `status` message with `meta.unmapped` (§15); `content` becomes text through `asText`, `null` is `''`.

---

### Task 1: Manifest `boundaries`

**Files:**
- Modify: `src/longhaul/session-format.js` (`validateManifest`)
- Test: `tests/longhaul-session-format.test.js`

**Interfaces:**
- Produces: a manifest may carry `constructed: boolean` and, when `constructed === true`, `boundaries: { fromSeq, toSeq, instanceId, trajectoryId }[]`. `validateManifest` adds errors: `constructed` present and not boolean; `constructed: true` with no `boundaries` or an empty list; boundaries not contiguous from 1 to `messages` (`boundaries[0].fromSeq === 1`, each next `fromSeq === prev.toSeq + 1`, last `toSeq === messages.length`); a `fromSeq` message that is not `user` (every trajectory starts with its task prompt); `constructed: false` with `boundaries`. `buildManifest` is unchanged (boundaries go through `extra`).

- [ ] **Step 1: Write the failing tests**: a 6-message session with `constructed: true, boundaries: [{1..3},{4..6}]` where messages 1 and 4 are `user` validates clean; a gap (`{1..3},{5..6}`), a missing tail (`{1..3}` only), `fromSeq` 4 being `assistant`, `constructed: 'yes'`, and `constructed: false` with boundaries each give one error naming the problem; the committed synthetic fixtures (`constructed: false`, no boundaries) still load.
- [ ] **Step 2: Run** `node --test tests/longhaul-session-format.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the checks in `validateManifest`.
- [ ] **Step 4: Run** it and `tests/longhaul-synthetic.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): constructed sessions carry their trajectory boundaries in the manifest`.

### Task 2: OpenAI-style messages to LongHaul messages

**Files:**
- Create: `src/longhaul/converters/openai-messages.js`
- Test: `tests/longhaul-converter-messages.test.js`

**Interfaces:**
- Consumes: `SENDERS`, `messageText` (`session-format.js`).
- Produces: `mapOpenAiMessages(list, { pairBy: 'id' | 'order' }) → { messages: Omit<Message, 'id'|'seq'|'timestamp'>[], stats: { skipped: { system }, unmapped, unpaired, badArguments, reasoningChars } }`. Mapping: `user` → `{ sender: 'user', text }`; `assistant` → `{ sender: 'assistant', text, meta: { reasoningChars } }` only when `content` is non-empty, then one `{ sender: 'toolUse', toolName: call.function.name, parameters, meta: { toolUseId: call.id ?? null } }` per `tool_calls` entry in order; `tool` → `{ sender: 'toolResult', toolName, result: text, meta: { toolUseId } }`, where `pairBy: 'id'` looks up `tool_call_id` (falling back to the message's `name`) and `pairBy: 'order'` takes the oldest call still unanswered since the last assistant message; `system` dropped; anything else → `{ sender: 'status', text, meta: { unmapped: role } }`. The `{ sender, toolName, parameters, result, meta.toolUseId }` field names are the Claude Code importer's (`src/history/importers/claude-code-jsonl.js:137-183`), so `messageText` renders both alike.

- [ ] **Step 1: Write the failing tests**: a rebench-shaped list (system, user, assistant with one `think` call and text, tool with `tool_call_id`) gives `user, assistant, toolUse, toolResult` with the result's `toolName` `think`; an Open-SWE-shaped list (assistant with empty content, `reasoning_content`, two calls `Bash` and `Read`; two `tool` messages without ids) gives `toolUse Bash, toolUse Read, toolResult Bash, toolResult Read` and `reasoningChars` > 0 with the reasoning text nowhere in any message; a third result with nothing pending is `toolName: 'unknown'`, `unpaired: 1`; arguments `'{"command": "ls'` give `parameters: { raw: '{"command": "ls' }`, `badArguments: 1`; arguments already an object are kept; role `'critic'` is a `status` message with `meta.unmapped: 'critic'`; `content: null` is `''` and an array content is text.
- [ ] **Step 2: Run** `node --test tests/longhaul-converter-messages.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `mapOpenAiMessages`.
- [ ] **Step 4: Run** the test — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): map OpenAI-style trajectories to LongHaul messages`.

### Task 3: The two dataset definitions

**Files:**
- Create: `src/longhaul/converters/nebius-swe-rebench.js`, `src/longhaul/converters/open-swe-traces.js`, `src/longhaul/converters/index.js`
- Create: `tests/fixtures/longhaul-converters/nebius-swe-rebench.jsonl`, `tests/fixtures/longhaul-converters/open-swe-traces.jsonl` (invented rows: 2 repositories, 3 to 5 instances each, one instance with two trajectories, one row with a two-call assistant message in the Open-SWE file)
- Test: `tests/longhaul-converters.test.js`

**Interfaces:**
- Consumes: `mapOpenAiMessages` (Task 2).
- Produces: `CONVERTERS: { [id]: Converter }` with `Converter = { id, source, prefix, datasetId, license: 'CC-BY-4.0', needsConfig: boolean, describe(row) → { repo, instanceId, trajectoryId, upstreamLicense: string|null }, toMessages(row) → { messages, stats } }`:
  - `nebius-swe-rebench`: `source: 'openhands'`, `prefix: 'nr-'`, `datasetId: 'nebius/SWE-rebench-openhands-trajectories'`, `needsConfig: false`, columns `repo`, `instance_id`, `trajectory_id`, `trajectory`, `pairBy: 'id'`, `upstreamLicense: null` (the dataset has no per-row license).
  - `open-swe-traces`: `source: 'open-swe-traces'`, `prefix: 'os-'`, `datasetId: 'nvidia/Open-SWE-Traces'`, `needsConfig: true`, columns `repo`, `instance_id`, `trajectory_id`, `messages`, `license`, `pairBy: 'order'`.
  - `describe` throws `UsageError('… row N has no repo …', 'CONVERT_ROW')` for a row missing `repo` or the message column; the caller adds the line number.

- [ ] **Step 1: Write the failing tests**: each fixture's rows describe to the expected repos and ids; `toMessages` of each first row has one `user` message first and no `system` message; `open-swe-traces` rows carry their `license` (`'MIT'`) as `upstreamLicense`, rebench rows `null`; a row without `repo` throws `CONVERT_ROW`.
- [ ] **Step 2: Run** `node --test tests/longhaul-converters.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the two definitions and the registry; write the fixtures.
- [ ] **Step 4: Run** the test — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): converters for nebius/SWE-rebench-openhands-trajectories and nvidia/Open-SWE-Traces`.

### Task 4: Planning and assembling constructed sessions

**Files:**
- Create: `src/longhaul/converters/construct.js`
- Test: `tests/longhaul-construct.test.js`

**Interfaces:**
- Consumes: `byCodeUnit` (`files.js`), `createRng` (`rng.js`), `estimateTokens`, `messageText`, `buildManifest`.
- Produces:
  - `planSessions(entries: { lineNo, repo, instanceId, trajectoryId, upstreamLicense, estTokens }[], { targetTokens, minTokens, maxSessions, repo, seed }) → { sessions: { repo, part, lineNos, estTokens, upstreamLicense }[], tooShort: { repo, estTokens }[], duplicatesDropped }`. Per repository: entries sorted by `instanceId` then `trajectoryId` (`byCodeUnit`), first trajectory per `instanceId` kept; filled greedily into parts of at most `targetTokens` (a trajectory larger than the target alone is one part); a part under `minTokens` goes to `tooShort`. Repositories are taken in a `seed`-shuffled order (`--seed`, default 1), parts in order, until `maxSessions`. `upstreamLicense`: the one value all the part's rows share, `'NOASSERTION'` when they differ, `'unknown-upstream'` when none has one.
  - `assembleSession({ converter, rows, repo, part, sessionId, sourceRef, sourceSha256, options }) → { manifest, messages }`. Messages of each row in order, `seq` dense from 1, `id` `m-<seq>`, synthetic timestamps; `boundaries` one per row; `manifest = buildManifest({ sessionId, source: converter.source, sourceRef, license: converter.license, private: false, messages, extra: { constructed: true, boundaries, upstreamLicense, repo, part, sourceSha256, convertOptions: options, converter: { id, version: 1 }, timestampsSynthetic: true, ...stats } })`.
  - `sessionIdFor(converter, { repo, part, config, split, targetTokens, minTokens }) → string`: `prefix + sha256(JSON of those).slice(0, 12) + '-' + part`.

- [ ] **Step 1: Write the failing tests**: entries of 2 repositories with token sizes chosen so repo A gives two parts at `targetTokens: 100, minTokens: 50` and repo B is `tooShort`; a duplicate `instanceId` is dropped and counted; the same seed gives the same order and a different seed may not; `maxSessions: 1` returns one; mixed licenses give `NOASSERTION`; `assembleSession` over two fixture rows passes `validateMessages` and `validateManifest` (Task 1) with boundaries `[{1..k},{k+1..n}]` and each `fromSeq` a `user` message; `sessionIdFor` matches `SESSION_ID_RE` and changes when `targetTokens` changes.
- [ ] **Step 2: Run** `node --test tests/longhaul-construct.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `construct.js`.
- [ ] **Step 4: Run** the test — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): constructed sessions from one repository's consecutive trajectories`.

### Task 5: `longhaul convert`

**Files:**
- Create: `src/longhaul/converters/rows.js`, `src/longhaul/converting.js`, `src/longhaul/commands/convert.js`
- Create: `tests/fixtures/longhaul-converters/make-parquet.mjs`, `tests/fixtures/longhaul-converters/open-swe-traces.parquet` (the Open-SWE JSONL fixture's rows)
- Modify: `src/longhaul/cli.js` (`COMMANDS`), `package.json` and `package-lock.json` (`hyparquet` `1.31.5` in `devDependencies`, installed with `npm install --save-dev --save-exact hyparquet@1.31.5`)
- Test: `tests/longhaul-convert.test.js`, `tests/longhaul-converter-rows.test.js`

**Interfaces:**
- Consumes: Tasks 3-4; `readJsonlLines`, `sha256File`, `isInside`, `writeSession`, `sessionDir`.
- Produces:
  - `readRows(input, { columns }) → AsyncIterable<{ rowNo, row } | { rowNo, error }>` in `rows.js`. `.jsonl`: `readJsonlLines`, `rowNo` the line number, an unparseable line yields `{ rowNo, error }`. `.parquet` or a directory of `.parquet` files: `asyncBufferFromFile` and `parquetMetadataAsync` per file, then one `parquetReadObjects({ file, columns, rowStart, rowEnd })` per row group, so memory holds one row group at a time; `rowNo` counts from 1 across files. `columns` limits what is decoded (pass 1 asks for the describe columns plus the message column; pass 2 for all). `inputSha256(input)`: the file's sha256, or for a directory the sha256 of each file's name and sha256 in name order.
  - CLI: `longhaul convert --source <nebius-swe-rebench|open-swe-traces> --input <file.parquet|dir|file.jsonl> [--repo R] [--max-sessions 12] [--target-tokens 500000] [--min-tokens 250000] [--seed 1] [--config C --split S] [--dry-run] [--force]`. `--config` and `--split` are required for `open-swe-traces` and refused for `nebius-swe-rebench` (`USAGE`). `--max-sessions` defaults to 12 (B-D10's public set).
  - `convertDataset(home, { source, input, repo, maxSessions, targetTokens, minTokens, seed, config, split, dryRun, force }) → { planned, written: [{ sessionId, status: 'imported'|'unchanged' }], tooShort, duplicatesDropped, badRows }`.
  - Pass 1: stream the file, `JSON.parse` each line, `describe` and size it (`estTokens` of `toMessages`' text), keep only the entry; an unparseable line or a `CONVERT_ROW` row is counted in `badRows` with its line number, not fatal (stops with exit 1 only when no row is usable). Pass 2: stream again, keep the rows whose line numbers the plan selected, assemble and write each session. Memory holds the entries and at most the selected rows.
  - `sourceRef`: `datasetId` (plus `:<config>/<split>`) and the input's base name. An existing session id with the same `sourceSha256` and `convertOptions` is `unchanged`; anything else refused `SESSION_EXISTS` without `--force`.
  - `--dry-run` prints per repository the trajectories kept, dropped duplicates, parts and estimated tokens, and the sessions that would be written; writes nothing.
  - Output line per session: `converted <id>: <repo> part <n>, <k> trajectories, <messages> messages, <toolCalls> tool calls, ~<estTokens> estimated tokens (CC-BY-4.0, upstream <spdx>)`; a summary of `tooShort`, duplicates and bad rows.

- [ ] **Step 1a: Write the failing reader tests** (`tests/longhaul-converter-rows.test.js`): `readRows` over the Open-SWE parquet fixture yields the same rows, in the same order and with the same `rowNo`s, as over the JSONL fixture (deep-equal after `JSON.parse(JSON.stringify(row))`); `columns: ['repo']` returns rows with only that key; a directory holding the parquet fixture twice under two names yields every row twice with `rowNo` continuing; `inputSha256` of that directory changes when a file is renamed; `.csv` is refused `USAGE`.
- [ ] **Step 1: Write the failing tests** over `tmpHome()` and the fixtures: the Open-SWE parquet fixture with `--config v2.0 --split claudecode` writes the same sessions (same ids and messages) as its JSONL fixture except `sourceRef` and `sourceSha256`; `convert --source nebius-swe-rebench --input <fixture> --target-tokens 400 --min-tokens 100` exits 0 and writes sessions whose `loadSession` validates, `private: false`, `license: 'CC-BY-4.0'`, `upstreamLicense: 'unknown-upstream'`, `constructed: true`; the Open-SWE fixture with `--config v2.0 --split claudecode` writes `upstreamLicense: 'MIT'` and `sourceRef` naming the config and split; without `--config` it exits 2; a second identical run reports every session `unchanged`; the same input with another `--target-tokens` writes new ids, while a changed input file over the same id exits 2 `SESSION_EXISTS` until `--force`; `--dry-run` writes no session directory; an input under `<home>/private/` exits 2; a fixture with one broken line converts the rest and reports `badRows: 1`; `--repo example-org/widget-kit` writes only that repository's sessions; no absolute path appears in any manifest.
- [ ] **Step 2: Run** `node --test tests/longhaul-convert.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `converting.js`, the command and the `COMMANDS` entry.
- [ ] **Step 4: Run** the test, `tests/longhaul-import.test.js`, `tests/longhaul-boundary.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): longhaul convert, public trajectories into constructed sessions`.

### Task 6: `crossesBoundary` on questions and run records

**Files:**
- Modify: `src/longhaul/questions.js` (`crossesBoundary`, `validateQuestion`, `normalizeQuestion`), its callers that have the manifest at hand (`author.js:118`, `review.js:69,104`, `synthetic.js:206`), `src/longhaul/run.js` (the per-question record near `:213`)
- Test: `tests/longhaul-questions.test.js`, a case in `tests/longhaul-run.test.js`

**Interfaces:**
- Produces: `crossesBoundary(manifest, question) → boolean | null`: `null` when `manifest.constructed !== true` or the question has no evidence; otherwise `true` when its `evidenceSeqs` fall in more than one `boundaries` segment. `normalizeQuestion(q, index, manifest?)` sets `crossesBoundary` when a manifest is given (key absent otherwise, so unconstructed sessions' question files are byte-identical to today's). `validateQuestion(q, { index, sessionId, manifest? })` adds `boundary-mismatch` when a stored value differs from the computed one ("computed, never typed", as `distance-mismatch`). Run records gain `crossesBoundary` (`null` for unconstructed sessions).

- [ ] **Step 1: Write the failing tests**: on a constructed 2-segment session, a `multi-hop` question with evidence in both segments is `true`, one with both pieces in segment 1 asked at segment 2's prompt is `false`, an `abstain` question is `null`; on an unconstructed session it is `null` and `normalizeQuestion` adds no key; a stored `crossesBoundary: false` that should be `true` gives `boundary-mismatch`; the committed synthetic question files still validate unchanged; a run over a constructed session writes `crossesBoundary` in its records.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement** and pass the manifest where the callers hold it.
- [ ] **Step 4: Run** them plus `tests/longhaul-synthetic.test.js`, `tests/longhaul-author.test.js`, `tests/longhaul-review.test.js` — expect `# fail 0`.
- [ ] **Step 5: Commit** `feat(longhaul): flag questions whose evidence crosses a trajectory boundary`.

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (LongHaul section: `convert`, the two sources, the export one-liners, `constructed`/`boundaries`/`crossesBoundary`, sessions public with `upstreamLicense`), the spec (§10.2: the two converters built and the decisions above; §13: B2 done except converters for the other three datasets, which move to B4 with the release).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm test` once for the stage — expect `# fail 0`.
- [ ] **Step 3: Commit** `docs(longhaul): public converters and constructed sessions`.

## Owner decisions (2026-11-09)

1. **A parquet reader: yes.** `hyparquet`, read directly; no export step (Task 5).
2. **Nebius sessions' upstream code licenses: look them up.** Sessions say `unknown-upstream` until then; each repository's license is looked up in SWE-rebench as a release-time task (B4 release work, not this plan).
3. **Open-SWE-Traces config and split: `v2.0`, `claudecode`.** The CLI still takes any.
4. **Datasets: these two first** (`nebius/SWE-rebench-openhands-trajectories`, `nvidia/Open-SWE-Traces`).

## Known limits

- No public trajectory has a human replying mid-run (all five datasets checked 2026-11-09): every `user` message in a constructed session is a task prompt, so `user-said` questions are about task statements, unlike the owner's sessions.
- Constructed sessions end below about 1M tokens by default, so the `>1M` distance bucket comes only from private sessions.
