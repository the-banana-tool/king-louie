# Cases Stage 5: Detour routing, the cross-case index and the `software-repo` case type — Design Spec

- **Status:** Draft (fix round 1)
- **Date:** 2026-09-23
- **Parent:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` §10.1, §7.3, §5.2 item 10, §4.2
  (`related`), §4.5 (`.kl/index/`), §12 row 5, §13
- **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. Owns §4.10 (cross-case index; C7
  extends it with `entities`), §4.11 (case-type extras, `gatingQuestionsFor`), the duplicate-job gate in
  §4.8 (R36). Consumes §4.1–§4.6, §4.8 (`liveState`, inert until C3), §4.20 (R33 two-phase hooks, R37
  `systemAction`). R19, R27, R28, R36–R38, R46.
- **Depends on:** C2 (merged). C3 is not required; the parts that touch it are inert until it merges.

## 1. Outcome

A case notices when work drifts off its objective and routes it instead of doing it inline. If the owner
asks a quotes case to fix the phone agent's code, or the model plans that fix, the case answers in one line
("side request noted, routing proposal waiting") and keeps working. The owner picks, in the case panel or on
any question channel, **attach to the existing case that covers it**, **start a new case with a prefilled
brief**, or **drop it**. Links go into both cases' `case.yaml`; a detour the original cannot proceed without
becomes a `high` blocker. Every duplicate check (unknowns, questions, case creation, jobs) runs against one
keyword index over all cases, which never hands one case another case's private text. A `software-repo` case
shows its repository's branch, dirty state, open PRs and the other cases on the same repo, and a "fix this
bug" request is checked against that work in flight before any code is written.

## 2. Scope

### 2.1 In

- `src/cases/index-store.js`: `CrossCaseIndex`, BM25 over facts, brief fields, questions, journal titles and
  `software-repo` live state, at `<casesRoot>/.index/`, with redaction inside the index.
- `CaseRuntime.otherCaseFacts` replaced by the index in `Ledger.unknown`'s duplicate check.
- Duplicate gates in `src/cases/gates.js`: `Ask` (exact open question), case creation (exact and similar
  title/objective), `findDuplicateJob`/`jobSignature` (called by C3).
- `src/cases/detours/classifier.js` (`classify` role) and `src/cases/detours/router.js` (candidates,
  proposals as question records, resolution, links, `blocked-by`, reconciliation).
- The `Detour` case tool; `CaseRuntime.detourGate` for C3's `Plan`/`Executor.submit`.
- `src/cases/case-types/`: registry, `general`, `outreach`, `software-repo`; `case.yaml.type` validation;
  the owner-only `repo` brief field; `gatingQuestionsFor` and `registerGatingSource` (R27); extras; the
  check-before-write note.
- `CaseRuntime.createQuestion` (charged, notified question creation shared with `Ask`).
- IPC `src/ipc/detour-handlers.js`; renderer `renderCaseDetoursSection`. Fixtures F4-detour, F5-cross-case.

### 2.2 Out

| Item | Owner |
|---|---|
| `Plan`/`Executor`, `serves` on them, storing job signatures | C3 (calls `detourGate`, `jobSignature`, `findDuplicateJob`) |
| Delivering detour questions on channels other than in-app | C4 (the router is channel-agnostic) |
| Fact-backed gating questions as records (`syncGating`, `pendingGating`); playbook gating sources | C6 (through `registerGatingSource`) |
| Entity index (`CrossCaseIndex.entities`), `CaseRuntime.entityIndex()`, MCP related-case view | C7 |
| Embeddings in the index (R28) | Deferred (§13) |

## 3. Design

### 3.1 Cross-case index — `src/cases/index-store.js`

**Location.** `<casesRoot>/.index/` (R19). A case is a self-contained git repo that can be moved or shared;
a cross-case index inside one case would copy other cases' private facts into its tree. `CaseStore.list()`
skips directories with no `case.yaml`, and `uniqueSlug` never produces a dot-prefixed slug.
`.index/.gitignore` contains `*`. Deleting `.index/` is always safe.

```js
class CrossCaseIndex {
  constructor(root, { store, log } = {})
  entities                          // null until C7 attaches its EntityIndex (R46)
  attachEntities(entityIndex)       // C7; rebuild/upsertCase/removeCase then also call entityIndex's
  rebuild() → { cases, docs, ms }
  upsertCase(id) → { docs } | { removed: true } | { skipped: 'bad-id' }
  removeCase(id)
  search({ text, subject?, attr?, kinds?, forCaseId?, excludeCaseId?, statuses?, limit = 20, includePrivate = false })
    → [{ caseId, title, kind, id, score, text, redacted, subject, attr, provenance, disclosable, caseStatus }]
  searchCases({ text, forCaseId?, excludeCaseId?, statuses?, kinds?, limit = 5 })
    → [{ caseId, title, slug, status, created, score, hits }]
  casesWithKey(key) → [{ caseId, title, status }]
  openCaseHeads() → [{ caseId, title, objective, status }]     // from per-case files; for findSimilarCases
}
```

Hits are the program §4.10 shape plus `redacted`. Everything is synchronous file I/O.

**Redaction lives in the index (principle 5).** For a hit whose `caseId !== forCaseId`, `text` is returned
only for a `fact` with `disclosable: true` or a `brief` document `title` or `objective`; every other
cross-case hit (private facts, `why`/`hardConstraints`/`alreadyTried`/`repo`, questions, journal titles,
live-state documents) carries `text: null, redacted: true`. A missing `forCaseId` treats every hit as
cross-case. `includePrivate: true` returns text for internal scoring only; it is used inside `searchCases`
and the router's candidate scoring, and their outputs are redacted by the same rule before leaving the
module. No caller outside `index-store.js` may pass it (a test greps for it).

**Documents per case** (text capped at 2,000 characters; at most 5,000 documents, newest first):

| kind | id | text | subject / attr | Included when |
|---|---|---|---|---|
| `fact` | `f-0042` | `stmt` + value + unit | fact's | status `active` (unknowns included) |
| `brief` | `title`, `objective`, `why`, `successCriteria`, `hardConstraints`, `alreadyTried`, `repo` | the field, arrays joined `; ` | `null` / field | non-empty |
| `brief` | `pr:<n>`, `branch:<name>` | PR title / branch name from `.kl/case-type.json` (parent §10.1 live state) | `null` / `pr` \| `branch` | `software-repo` snapshot present |
| `question` | `q-0012` | text + option labels | `null` | every record |
| `journal` | file name | first non-`#` non-empty line (≤ 160 chars) + the kind parsed from `YYYY-MM-DD-HHMM-<kind>[-<n>].md` | `null` / kind | every `journal/*.md` |

**Tokenizer `kl-bm25-v1`.** NFKD, strip combining marks, lowercase, split on `[^a-z0-9]+`, drop tokens under
2 characters and a frozen 60-word English stopword list, strip a trailing `s` from tokens over 3 characters
not ending `ss`. Numbers stay (a parcel number matters). Term frequencies are stored per case file;
postings, df and avgdl live in memory, rebuilt on the first search and after any per-case change (well under
a second for hundreds of cases; persisted postings are revisited above ~100k documents).

**Scoring.** BM25 (`k1 = 1.2`, `b = 0.75`) over all cases. With `subject` and `attr`, a document with the
same normalized pair gets `+5`, the same subject `+2`, and a key match is returned even at text score 0
(C1's "same subject and attribute" rule). Filters (`kinds`, `excludeCaseId`, `statuses`) apply after
scoring; ties break by case `created`, then document id. `searchCases` groups by case (score = max + 0.3 ×
the next two) and keeps a case that matched two distinct query tokens or a key.

**Storage.** `.index/meta.json` `{ version, tokenizer, builtAt }`; `.index/cases/<caseId>.json` (documents,
tf, fingerprint, `keys`, `title`, `objective`, `status`, `created`). Writes are temp files
`<name>.<pid>.<rand>.tmp` then rename. Documents and keys are sorted deterministically, so `rebuild()` and
incremental upserts give byte-identical files.

**Case ids.** Only ids matching `^[A-Za-z0-9-]{1,64}$` are indexed; any other `case.yaml.id` is skipped with
one `warn` (`upsertCase` returns `{ skipped: 'bad-id' }`), so no id can traverse out of `.index/`.

**Freshness.** `search`/`searchCases` first stat `case.yaml`, `facts.jsonl`, `brief.md`, `.kl/questions/`,
`journal/` and `.kl/case-type.json` per case and compare `[mtimeMs, size]` with the fingerprint; changed
cases are re-upserted; a case whose directory is gone or whose `case.yaml` names another id is removed.
`upsertCase` also runs at `endTurn`, `createCase`, `completeGating`, `addRelation` and answers.

**Rebuild** runs on IPC `case:reindex`, and automatically when `meta.json` is missing, unparsable, or of
another `version`/`tokenizer`; it writes every case file, deletes files of vanished cases, and writes
`meta.json` last. Two instances on one root converge (last rename wins per file).

**Failures.** An unreadable case file is skipped with one `warn` per fingerprint; a corrupt index file is
treated as stale; an unwritable `.index/` runs in memory with one `warn`. Search never throws; on an
internal error it logs and returns `[]` (duplicates shown less often, never fabricated).

### 3.2 Duplicate gates — `src/cases/gates.js` (pure)

| Function | Exact → refusal | Similar → shown, not refused |
|---|---|---|
| `findDuplicates({ subject, attr, text, facts, crossCaseHits = [] })` (changed) | same-case active non-inferred fact on the same `(subject, attr)` | same key or Jaccard ≥ 0.5 on `tokens`, over `crossCaseHits` of kind `fact`; rows `{ caseId, caseTitle, id, stmt, provenance }`, `stmt` = `(private fact in "<title>" — open that case to see it)` when the hit is redacted |
| `findDuplicateQuestion({ text, openQuestions, crossCaseHits })` | an open question **in this case** with equal `normQuestion` | Jaccard ≥ 0.5 against open questions here (text shown); other cases' `question` hits → `{ caseId, caseTitle, questionId, status }` only |
| `findDuplicateJob({ executorId, job, liveJobs })` | a `liveJobs` row with the same `executorId` and `signature` in a non-terminal state (`submitting \| submitted \| running \| waiting`, R36) | none |
| `findSimilarCases({ title, objective, candidates })` | an open case (`draft`, `active`, `needs-direction`, `paused`) with equal normalized title or non-empty objective | Jaccard ≥ `cases.duplicates.createSimilarity` (0.6) on title + objective tokens |

`normQuestion(s)`: NFKC, lowercase, collapse whitespace, strip trailing `?!.`. `jobSignature(executorId,
job)`: SHA-256 hex of the JSON of `{ e: executorId, k: job.kind || null, r: sorted recipients, i: normalized
intent }` in that key order. `tokens` and `jaccard` (C1) are exported.

**Callers.**
- `Ledger.unknown` passes `crossCaseHits: index.search({ text: stmt, subject, attr, kinds: ['fact'],
  forCaseId, excludeCaseId: forCaseId, statuses: OPEN })` (open cases only). `otherCaseFacts` is deleted.
- `Ask` (C2's tool) runs `findDuplicateQuestion` before creating. Exact → `{ ok: false, error: 'This
  question is already open as q-0012 (asked 2026-09-20). Wait for its answer instead of asking again.' }`.
  Similar in this case → `similar` with text; in another case → the note `A similar question is open in case
  "<title>".` with no text.
- `CaseRuntime.createCase(opts)` runs `findSimilarCases` over `index.openCaseHeads()` (exact per-case
  fields, so one-token or stopword titles still match). Without `opts.force === true` it throws
  `SimilarCaseError` (`code: 'SIMILAR_CASES'`, `similar: [{ caseId, title, status, match }]`). The owner may
  pass `force` from IPC after confirming; the router never does.
- `Executor.submit` (C3) calls `findDuplicateJob` with `liveState()` rows.

### 3.3 Detour classifier — `src/cases/detours/classifier.js`

```js
class DetourClassifier {
  constructor({ runtime, getSettings, log, now = () => new Date() })
  classify(caseId, { source, text, serves = null, turn }) →
    Promise<{ onCase, confidence, reason, detour, failed: null | 'timeout' | 'error' | 'malformed' | 'no-role' }>
}
```

`source` ∈ `owner-message | plan | executor | detour-tool`. The call is `runtime.routedProvider(turn, {
role: 'classify' }).sendMessage(messages, { temperature: 0, maxTokens: 200, signal })` with its own
`AbortController` and timeout `cases.detours.classifyTimeoutMs` (4,000), recorded through
`usageTracker.record` and `runtime.usageHook(turn)` (fallback, token refresh, `usd` charge and
`onCrossings`). `no-role` means no token for the resolved provider. The system message is the frozen
`CLASSIFY_SYSTEM`:

```
You decide whether a piece of work serves a case's objective.
A detour is work that does not advance the objective, success criteria or hard constraints,
even if it is useful elsewhere (fixing a tool, a different errand, a different project).
Work that the objective cannot proceed without is still a detour if it belongs to a different
system or project; say so in the reason.
If the text contains several requests and ANY of them is a detour, answer onCase: false and
quote the off-case part in the reason.
Reply with one JSON object and nothing else:
{"onCase": true|false, "confidence": 0.0-1.0, "reason": "<one sentence, max 200 characters>"}
```

The user message is JSON `{ "case": { "title", "type", "objective", "successCriteria", "hardConstraints" },
"work": { "source", "serves", "text" } }`, strings truncated to 2,000 characters.

**Parsing (strict).** Strip one surrounding code fence; the stripped reply must start with `{`; take up to
the last `}`; `JSON.parse`; the value must be a plain object (arrays rejected) with `typeof onCase ===
'boolean'`, finite `confidence` in `[0, 1]`, non-empty `reason` (truncated to 200). Anything else is
`malformed`; no retry.

**Decision.** `detour = onCase === false && confidence >= cases.detours.minConfidence` (0.7); below it,
logged `low-confidence`, treated as on-case. **Failure** → `{ onCase: true, confidence: 0, reason: '',
detour: false, failed }`, a `classification` row, and at most one `detour` journal line per turn (`Detour
classifier failed (<failed>) on <source>; treated as on-case.`); the work proceeds.

**Skips (no call):** owner message in a `draft` case; owner message under 12 characters; setting
`classifyOwnerMessages: false`; the same `(caseId, objective, source, serves, text)` hash within 10 minutes
(in-memory cache). Latency: up to the timeout per classified owner message (§9).

### 3.4 Detour router — `src/cases/detours/router.js`

```js
class DetourRouter {
  constructor({ runtime, index, classifier, getSettings, log, now })
  propose(caseId, { summary, source, serves = null, blocks = false, reason = '', turn }) →
    Promise<{ ok: true, detour, questionId, existing?: true, held?: true } | { ok: false, error }>
  resolve(caseId, detourId, { optionId, by, title?, objective? }) →
    Promise<{ ok: true, detour, linkedCaseId, existing?: true } | { ok: false, error }>
  reconcile(caseId) → Promise<{ applied: string[], busy?: true }>
  list(caseId) → { detours: DetourView[], related: RelatedView[] }
}
// DetourView  = { id, summary, reason, blocks, status, questionId, options: [{ optionId, label }], at }
// RelatedView = { caseId, title, status, relation, detour?, gone?: true }
```

Views carry titles and statuses, never hit text.

**Propose:**

1. **Status.** `paused`, `done`, `abandoned` refuse (§4.1 messages).
2. **Duplicate.** Against this case's `proposed` detours and those `declined` in the last 30 days, Jaccard ≥
   0.8 on `summary`: proposed → return it (`existing: true`); declined → `The owner declined this on
   2026-09-21 (q-0013). Do not do it in this case and do not propose it again.`
3. **Candidates** (open cases only; scoring may use `includePrivate` internally): `index.searchCases({ text:
   summary + ' ' + reason, forCaseId: caseId, excludeCaseId: caseId })`; `+1` per summary token equal to a
   fact `subject` in a candidate; `+3` for cases in `index.casesWithKey('repo:<key>')` when this case is
   `software-repo` (its PR/branch documents are already indexed, §3.1); `+2` for a case owning a live job
   whose executor id or intent shares a token (`runtime.executors?.liveState?.()`, inert until C3). The top
   `maxCandidates` (2) become attach options. Closed cases whose `statusReason.at` is within `recentDays`
   (30) are listed as "See also" (titles only), never attach targets (§4.1 has no transition out of them).
4. **New-case prefill:** `title` = summary cut to 72 characters at a word boundary; `type` = `software-repo`
   when this case is one with a `repo`, else `general`; `objective` = summary; `successCriteria` =
   `[summary]`; `body` = `Spawned from case "<title>": <reason>`. Owner-only fields are left for the gating
   pass. The prefill is run through `findSimilarCases`; an exact **or** similar hit becomes an attach option
   (first position) instead of `new`.
5. **Question.** `runtime.createQuestion(caseId, { kind: 'question', urgency: blocks ? 'high' : 'low',
   defaultOnSilence: 'hold', expiresAt: null, options, text, payload })` (§3.9). Options: `attach-1`,
   `attach-2` (`Attach to "<title>" (<status>)`), `new` (`Start a new case: "<prefilled title>"`), `decline`
   (`Drop it`). Text: `Detour from "<title>" (<detourId>): <summary>. It does not serve "<objective>"
   (<reason>). Where should it go?`, prefixed `Blocker: ` when `blocks`. `payload: { type: 'detour',
   detourId, blocks, targets: { "attach-1": "<caseId>", "attach-2": "<caseId>", new: null, decline: null },
   about: { subject: 'detour', attr: '<detourId>' }, disclosable: false }`, so the routing answer becomes a
   non-disclosable `user` fact. When `questionsPerDay` is at 100 % and the proposal does not block, the
   proposal is recorded `held` with `questionId: null`; the turn-start hook creates the question after the
   day rolls over. A blocking proposal overrides the cap (like `Fail`).
6. **Records.** A `proposal` row (candidates stored as `{ caseId, score, optionId }`, no titles); a `detour`
   journal entry (`# Detour d-0003` · summary · reason · source · `blocks` · options by id); with `blocks`,
   `{ id: 'pending:<detourId>', relation: 'blocked-by', note: summary, detour }` in `related`; `case:changed
   { what: 'detours' }`.

**Resolve** (idempotent). Inside the locked section it re-reads `detours.jsonl`; an existing non-`failed`
resolution is returned with `existing: true`.

- `attach-N`: the target must exist and be open, else a `failed` resolution (`Case "<title>" is <status or
  gone>; pick another option.`) and a new proposal without it. The original gets `{ id: target, relation:
  blocks ? 'blocked-by' : 'related', note, detour, at }`, the target `{ id: original, relation: blocks ?
  'blocks' : 'related', … }`. The target gets an `incoming` row carrying exactly the question's shown text
  (`fromTitle`, `summary`, `reason`, `blocks`) and a `detour` journal entry. When the target is `active`, a
  wake-up `register({ kind: 'detours:incoming', at: now, payload: { key: 'incoming:<detourId>', detourId,
  fromCaseId }, createdBy: 'detours' })`; a `draft` target starts at the owner's next chat there (wake-ups
  skip drafts and carry no owner messages).
- `new`: `runtime.createCase({ title, type, objective })` with the owner-edited title/objective from IPC
  when given. `SIMILAR_CASES` → a `failed` resolution and a new proposal with that case as an attach option;
  IPC may retry with `force` after the owner confirms. The prefill goes in with `Brief.writeBody(text)` and
  `provenance: 'model'`; links `spawned` (+ `blocked-by`) and `related` (+ `blocks`). The new case is
  `draft`.
- `decline`: nothing linked; a `pending:` blocker removed.
- Always: a `resolution` row, `pending:<detourId>` replaced by the real link, `index.upsertCase` for both,
  `case:changed { what: 'detours' }`.

**Locks (R37).** Link writes run through `runtime.systemAction(id, 'detour <detourId>: <label>', fn)`.
Inside a turn the original's lock is held by this process, so `systemAction` runs inline for it and takes
only the target. From IPC the original is taken first, then the target; acquisition never waits. A
`CaseBusyError` on either aborts before anything is written: `Case "<title>" is busy with another turn. Try
again when it finishes.`

**Reconcile** scans `proposal` rows whose question is answered with no resolution: an `optionId` answer
resolves (`by: answer.channel`); a text-only answer becomes `awaiting-mapping` and orientation shows `The
owner answered routing question q-0013 in words: "<text>". Call Detour "resolve" with the option that
matches, or ask.` It runs in the turn-start hook, from `case:detours` and after `case:resolveDetour`; from
IPC a `CaseBusyError` returns `{ applied: [], busy: true }` without reconciling.

### 3.5 `Detour` tool and `detourGate`

`src/tools/builtin/detour-tool.js`, in `CASE_TOOL_NAMES`, `requiresApproval: false`. Ops (added to C2's
`assertWritable` list): `Detour.propose`, `Detour.resolve` (writes), `Detour.list` (read; refused in
`paused` like every non-listed op).

| Action | Params | Result |
|---|---|---|
| `propose` | `summary` (1–300, required), `reason` (≤ 200), `blocks` (boolean), `serves` (≤ 200) | `router.propose(…, { source: 'detour-tool' })` |
| `resolve` | `questionId`, `optionId` | Only when the detour is `awaiting-mapping`; `by: 'model-mapped'`, journaled with the owner's words |
| `list` | none | `router.list(caseId)` |

**`CaseRuntime.detourGate(id, { source, serves, text, turnId })`** → `Promise<{ ok: true, note? } | { ok:
false, error, classification }>`, `source` ∈ `plan | executor`. On a detour:

```
This work looks like a detour from the case objective ("<objective>"): <reason>.
Do not do it in this case. Call Detour with action "propose" (blocks: true if this case
cannot proceed without it), then continue with on-case work.
```

Below the threshold: `ok: true` with `note: 'The classifier was unsure this serves the objective:
<reason>.'`; a failure is `ok: true`. C3 calls it once per plan and once per new job.

### 3.6 Turn hooks (R33)

C5 registers two hooks with C2:

- **Phase 1** `runtime.addTurnStartHook('detours', fn)`, `fn({ caseId, meta, ownerMessage, turnId, source
  })`, awaited inside `beginTurn` before `detectTriggers` and `buildOrientation`:
  1. `router.reconcile(caseId)`; create the questions of `held` proposals when the cap allows.
  2. Case-type refresh (§3.7) within `cases.softwareRepo.refreshBudgetMs` (6,000); on overrun the cached
     snapshot is used and marked stale, and the refresh finishes in the background into memory only; the
     next turn writes it under its lock.
  3. Case-type trigger: for each `materialFields()` field whose current value differs from
     `.kl/triggers.json` `caseTypeMaterial[field]` (C2's baseline, written by `Reorient` and clean-turn
     `endTurn` from `runtime.caseTypeMaterial(id)`), return `{ kind: 'case-type-change', detail: '<field>
     changed: <old> → <new>', blocking: true, key: 'case-type:<field>' }`.
  4. Notes: `router.list` summary and the extras under `## Detours and related cases`.
- **Phase 2** `runtime.addTurnStartHook('detours:classify', fn, { phase: 'owner-message' })`, run by C2's
  case-turn block through `runtime.runOwnerMessageHooks(turn)` **after `UserPromptSubmit` passes**, so a
  prompt the hook blocks is never classified or proposed. It classifies the owner message; on a detour it
  calls `router.propose(caseId, { summary: ownerMessage (≤ 300), reason, source: 'owner-message' })` and
  returns the note:
  ```
  Detour check: the owner's message asks for work outside this case's objective (<reason>).
  Do that part in this case only if the owner insists. Routing proposal <q-id> (attach to
  "<X>" / new case / drop) is waiting. Say so in one line, then continue with the on-case part.
  ```
  For `software-repo` it also runs check-before-write (§3.7) and adds its note.

### 3.7 Case types — `src/cases/case-types/`

`index.js` (registry), `general.js`, `outreach.js`, `software-repo.js`. Module shape (program §4.11):

```js
module.exports = {
  type: 'software-repo',
  orientationExtras(runtime, id) → string,       // sync; cached snapshot only
  gatingQuestions() → GatingQuestion[],
  materialFields() → string[],
  briefFields?() → [{ name, kind: 'text', userOnly: boolean }],
  refresh?(ctx) → Promise<snapshot>,             // ctx = { runtime, id, brief, exec, now }
  indexKeys?({ brief, snapshot }) → string[]     // e.g. 'repo:github.com/example/phone-agent'
};
```

**`GatingQuestion` (R27):** `{ id, text, required, field?: string, fact?: { subject, attr }, answerable:
'owner' | <executorId> | <sourceKind>, options?, briefField?, category?: 'personal' | 'financial' | 'legal'
| 'health' }`. Field-backed questions (`field`) stay on `Brief.missingForGating`; fact-backed ones (`fact`)
become question records through C6's `syncGating`.

**Registry.** `getCaseType(type)`, `knownCaseTypes()` (`['general', 'outreach', 'software-repo']`),
`assertKnownType(type)` (`Unknown case type "x". Known types: general, outreach, software-repo.`),
`registerGatingSource(fn)` where `fn(runtime, id) → GatingQuestion[]` (C6), and `gatingQuestionsFor(runtime,
id)`, the single composition point: the type's questions, then every source's in registration order, each
tagged `origin` (`case-type:<type>` or the source's own); it does not merge. Merging by `fact.subject.attr`
is C6's `syncGating`/`pendingGating` (program §4.11). Types are code, required statically.

**Validation.** `CaseStore.create` calls `assertKnownType`. An unknown type on disk still opens, as
`general`, with the orientation line `Unknown case type "<t>"; treated as general.` `general` and `outreach`
have no extras, gating or material fields in C5.

**Brief.** `runtime.brief(id)` builds `new Brief(dir, { extraFields })` from `briefFields()`. `repo` is
**owner-only** (`userOnly: true`): set only with `provenance: 'user'` and a verified quote, or from IPC. The
`Brief` tool refuses a field the case's type does not declare (`Field "repo" is only for software-repo
cases.`). `Brief.missingForGating()` adds each required field-backed gating question with an empty field.
`Brief.writeBody(text)` is the named body writer.

**`software-repo`:**

| Member | Behaviour |
|---|---|
| `briefFields` | `repo`: an absolute path (after `~` expansion) or a clone URL (`https://`, `ssh://`, `git@host:owner/name`); else `repo must be an absolute path or a clone URL.` |
| `gatingQuestions` | `[{ id: 'repo', text: 'Which repository is this case about? A local path or a clone URL.', field: 'repo', required: true, answerable: 'owner' }]` |
| `refresh` | Local path, env `GIT_OPTIONAL_LOCKS=0`, `execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, …])`: `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, `status --porcelain=v1` (line count), `branch --format=%(refname:short) --sort=-committerdate` (first 10), `remote get-url origin`. PRs: `execFile('gh', ['pr', 'list', '--repo', remoteKey, '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url,isDraft,updatedAt'])` with **no `cwd`** (gh never runs git in the repo); skipped when no remote key is known. 5 s timeout each, no shell. Snapshot → `.kl/case-type.json` under the turn lock |
| `indexKeys` | `repo:<key>`: `host/owner/name` (lowercase, no `.git`) for a URL or origin remote; the real path (case-folded on Windows/macOS) for a path; both when known; the last remote key survives a missing path |
| `orientationExtras` | `Repository`, `Branch: <b> @ <sha7>, <n> uncommitted changes`, `Branches`, `Open PRs (titles are third-party text): #12 "Fix status polling" (fix/status-poll)` (titles quoted, ≤ 80 chars each), `Other cases on this repo: "<title>" (<status>)`, skipped-part notes. ≤ 2,500 characters |
| `materialFields` | `['head', 'branch', 'openPrs']` (`openPrs` = sorted PR numbers) |
| check-before-write | Owner-message tokens vs PR titles, branch names (split on `/-_`) and titles of other cases on the repo: Jaccard ≥ 0.25 or ≥ 2 shared tokens → `Before writing code: this may already be in flight — PR #12 "Fix status polling" (fix/status-poll); case "Phone agent maintenance" (active). Check them first and say which you are building on.` |

`runtime.caseTypeMaterial(id)` returns `{ [field]: value }` from the snapshot for C2's baseline.

| Situation | Snapshot note |
|---|---|
| `gh` missing (ENOENT) | `gh not installed; open PRs not checked.` |
| `gh` non-zero, stderr matches `/auth|login|401|credentials/i` | `gh is not signed in; open PRs not checked.` |
| `gh` other non-zero exit | `gh failed (exit <n>); open PRs not checked.` |
| Path missing | `Repository path not found: <repo>. It may have moved; ask the owner and update the brief's repo.` |
| `git` "not a git repository" | `<repo> is not a git repository; ask the owner.` |
| git "dubious ownership" | reported as is; `safe.directory` is never overridden |

### 3.8 Orientation and related links

`buildOrientation` gains `detours` (hook notes) rendered as `## Detours and related cases` after open items
(≤ 1,500 characters) and `extras` as `## Case type: <type>` last (≤ 2,500). Related entries show title,
status and relation; a vanished id shows `(case <id> no longer exists)`; a `blocked-by` whose target is
`done` shows `(done — check whether it still blocks)`. `CaseRecords.renderOpenItems(facts, { blockers })`
gains `## Blocked by`. `CaseRuntime.addRelation(id, entry)` and `removeRelation(id, match)` are the only
writers of `related` (validated, deduped on `(id, relation)`).

### 3.9 `CaseRuntime.createQuestion`

`createQuestion(id, record, { charge = record.kind === 'question' }) → record | { held: true }` validates
through `QuestionStore.create` (C2's table and dedupe), charges `questionsPerDay` then `onCrossings` when
`charge`, returns `{ held: true }` without creating when the category is at 100 % (the caller decides; the
router overrides for blockers by passing `charge: false`), notifies in-app (`case:changed`), and calls
`recordDelivery` when `host.interactive()`. `Ask` uses it; C3/C4/C6/C7 may. If C2 already ships an
equivalent, C5 uses C2's.

## 4. Data formats

### 4.1 `case.yaml.related` entry

```yaml
related:
  - id: 7ab1-9c3e10f2
    relation: blocked-by
    note: Phone agent status polling reports dropped calls
    detour: d-0003
    at: 2026-09-23T15:02:11Z
```

`id`: a case id, or `pending:<detourId>`; `relation` ∈ `spawned | blocked-by | blocks | related`; `note` ≤
300 characters; `detour` optional; `at` written by the runtime. C1 entries stay valid.

### 4.2 `.kl/detours.jsonl` (committed)

```jsonc
{"type":"classification","at":"…","turnId":"turn-41","source":"owner-message","onCase":false,"confidence":0.91,"reason":"Fixing the phone agent's code does not collect quotes","model":"…","ms":412,"failed":null}
{"type":"proposal","id":"d-0003","at":"…","turnId":"turn-41","summary":"…","source":"owner-message","serves":null,"blocks":false,"reason":"…","questionId":"q-0013","held":false,"candidates":[{"caseId":"…","score":7.4,"optionId":"attach-1"}],"newCase":{"title":"…","type":"software-repo","objective":"…","successCriteria":["…"],"body":"…"}}
{"type":"resolution","id":"d-0003","at":"…","optionId":"attach-1","by":"in-app","status":"attached","targetCaseId":"…","error":null}
{"type":"incoming","id":"d-0003","at":"…","fromCaseId":"…","fromTitle":"Rear door quotes","summary":"…","reason":"…","blocks":false}
```

`id` = `d-` + 4 digits by replaying proposals; `resolution.status` ∈ `attached | created | declined | failed
| awaiting-mapping`; `by` = a question channel or `model-mapped`. `incoming` rows are keyed by `(fromCaseId,
id)`. Status is the last resolution's, else `held` or `proposed`.

### 4.3 `.kl/case-type.json` (committed)

```jsonc
{ "type": "software-repo", "fetchedAt": "RFC3339", "stale": false,
  "state": { "repo": "/work/phone-agent", "branch": "main", "head": "3f9c2a1…", "dirty": 2,
             "branches": ["main", "fix/status-poll"], "remoteKey": "github.com/example/phone-agent",
             "openPrs": [{ "number": 12, "title": "Fix status polling", "headRefName": "fix/status-poll", "url": "https://github.com/example/phone-agent/pull/12", "isDraft": false }] },
  "notes": ["gh not installed; open PRs not checked."] }
```

### 4.4 Index files

```jsonc
// .index/meta.json
{ "version": 1, "tokenizer": "kl-bm25-v1", "builtAt": "RFC3339" }
// .index/cases/<caseId>.json
{ "caseId": "…", "slug": "…", "title": "…", "objective": "…", "type": "outreach", "status": "active", "created": "…",
  "keys": ["repo:github.com/example/phone-agent"],
  "fingerprint": { "case.yaml": [1727100000000, 412], "facts.jsonl": [0, 0], "brief.md": [0, 0], ".kl/questions": [0, 0], "journal": [0, 0], ".kl/case-type.json": [0, 0] },
  "docs": [{ "kind": "fact", "id": "f-0042", "text": "…", "subject": "lot", "attr": "acreage",
             "provenance": "sourced", "disclosable": true, "len": 9, "tf": { "lot": 1, "acre": 2 } }] }
```

A file whose `caseId` does not match its name is ignored and rewritten.

### 4.5 Journal and wake-up kinds

Journal kind `detour` (`YYYY-MM-DD-HHMM-detour.md`); wake-up kind `detours:incoming`.

## 5. Interfaces

### 5.1 Consumed

| From | Interface |
|---|---|
| C1 | `CaseRuntime`, `CaseStore`, `FactLedger.view()`, `Brief`, `CaseRecords.writeJournal`, `findDuplicates` |
| C2 §4.1–§4.3 | status and refusals; `assertWritable`; `new QuestionStore(dir, { now })` `create/open/get`; `CaseRuntime.answerQuestion(caseId, qid, { channel, text, optionId })`; `QuestionStore.answer` honouring `payload.disclosable: false` (C2 fix-round input) |
| C2 §4.4–§4.6 | `Budget.charge('questionsPerDay')` + `onCrossings`; `routedProvider(turn, { role: 'classify' })`, `usageHook(turn)`; `WakeupStore.register({ kind, at, payload, createdBy })` |
| C2 §4.20 | `addTurnStartHook(name, fn)` (phase 1), the owner-message phase run by `runOwnerMessageHooks(turn)` after `UserPromptSubmit` (C2 fix-round input, R33); `beginTurn(id, { turnId, source, ownerMessage })`; `Trigger = { kind, detail, blocking, decisionIds?, key }`; `.kl/triggers.json` `caseTypeMaterial` written from `runtime.caseTypeMaterial(id)`; `systemAction(id, label, fn, { commitMessage? })` |
| C3 §4.8 | `registry.liveState()` (inert until merged) |

### 5.2 Produced

| Name | Signature | Consumers |
|---|---|---|
| `CrossCaseIndex` | §3.1: `rebuild()`, `upsertCase(id)`, `removeCase(id)`, `search({ text, subject?, attr?, kinds?, forCaseId?, excludeCaseId?, statuses?, limit? })`, `searchCases(...)`, `casesWithKey(key)`, `openCaseHeads()`, `entities`, `attachEntities(entityIndex)` | C5, C7 |
| Search hit | `{ caseId, title, kind: 'fact'\|'brief'\|'question'\|'journal', id, score, text \| null, redacted, subject, attr, provenance, disclosable, caseStatus }` | C7 |
| `CaseRuntime.index` | getter → `CrossCaseIndex` | tools, IPC, C7 |
| `CaseRuntime.detourGate(id, { source, serves, text, turnId })` | §3.5 | C3 |
| `CaseRuntime.detours` | getter → `DetourRouter` | IPC, `Detour` tool |
| `CaseRuntime.createQuestion(id, record, { charge })` | §3.9 | C2 `Ask`, C3, C4, C6, C7 |
| `CaseRuntime.addRelation(id, entry)`, `removeRelation(id, match)` | §3.8 | C5, C7 |
| `CaseRuntime.caseTypeMaterial(id)` | `→ { [field]: value }` | C2 baseline |
| `gates.jobSignature(executorId, job)`, `findDuplicateJob({ executorId, job, liveJobs })`, `findDuplicateQuestion`, `findSimilarCases` | §3.2 | C3, C2 `Ask` |
| `SimilarCaseError` | `code: 'SIMILAR_CASES'`, `similar: [{ caseId, title, status, match: 'exact' \| 'similar' }]` | IPC, router |
| Case-type registry | `getCaseType`, `knownCaseTypes`, `assertKnownType`, `gatingQuestionsFor(runtime, id)`, `registerGatingSource(fn)`; `GatingQuestion` (R27) | C6 |
| Tool | `Detour` (`requiresApproval: false`); ops `Detour.propose`, `Detour.resolve`, `Detour.list` | case mode |
| IPC | `case:detours { caseId }`, `case:resolveDetour { caseId, detourId, optionId, title?, objective?, force? }`, `case:reindex {}` | renderer, F7 |
| Journal / wake-up kinds | `detour`, `detours:incoming` | — |

## 6. Configuration

All keys are in `settings.cases` (data dir); none is security-relevant. No `node.yaml`, `service.json` or
env keys.

| Key | Default | Meaning |
|---|---|---|
| `cases.detours.classifyOwnerMessages` | `true` | classify owner messages |
| `cases.detours.minConfidence` | `0.7` | `onCase: false` at or above is a detour |
| `cases.detours.classifyTimeoutMs` | `4000` | classifier timeout |
| `cases.detours.recentDays` | `30` | closed cases shown as "See also" |
| `cases.detours.maxCandidates` | `2` | attach options per proposal |
| `cases.duplicates.createSimilarity` | `0.6` | similar case titles and objectives |
| `cases.softwareRepo.refreshBudgetMs` | `6000` | turn-start wait for git and gh |

`mergeSettings` merges `cases` one level deep today; C5 adds key-by-key merges for `cases.detours`,
`cases.duplicates` and `cases.softwareRepo` (one hunk).

## 7. Host wiring

- `src/core/create-core.js`: none beyond what C2 passes (`getSettings`, `host`); everything is reached
  through `getCaseRuntime()`.
- `src/cases/case-runtime.js`: lazy `index`, `classifier`, `detours`; the two hook registrations;
  `detourGate`, `createQuestion`, `addRelation`, `removeRelation`, `caseTypeMaterial`; `index.upsertCase`
  after `endTurn`'s commit (try/catch, never fails the turn), in `createCase`, `completeGating`,
  `addRelation`; `otherCaseFacts` deleted.
- `src/cases/gates.js`, `src/cases/index-store.js`, `src/cases/detours/`, `src/cases/case-types/`,
  `src/cases/brief.js` (`extraFields`, `writeBody`, owner-only `repo`), `src/cases/records.js`
  (`renderOpenItems` blockers), `src/cases/orientation.js` (two sections), `src/cases/index.js` (exports).
- `src/core/settings.js`: §6 defaults and merges.
- `src/tools/builtin/detour-tool.js` (new); `src/tools/index.js` one registration; `chat-integration.js`:
  `'Detour'` in `CASE_TOOL_NAMES` and the prompt line `- Work that does not serve the objective is a detour:
  propose it with the Detour tool and continue; never do it inline.`; C2's `Ask`: one
  `findDuplicateQuestion` call and `createQuestion`; `case-tools.js`: `Ledger.unknown` uses the index.
- `src/ipc/detour-handlers.js` (new): `case:detours` (reconciles first), `case:resolveDetour` (answers the
  question with `channel: 'in-app'` through `answerQuestion` if unanswered, then resolves), `case:reindex`;
  `constants.js` `CASE_DETOURS`, `CASE_RESOLVE_DETOUR`, `CASE_REINDEX`; `register.js` one line;
  `src/ipc/case-handlers.js`: `case:create` passes `force` and maps `SimilarCaseError` to `{ ok: false,
  error, code: 'SIMILAR_CASES', similar }`; `preload.js`: `cases.detours`, `cases.resolveDetour`,
  `cases.reindex` with `validateString`, `cases.create` accepts `force`.
- `renderer.js`: `renderCaseDetoursSection(chat, container)` at the end of `renderChatCaseSection`
  (proposals with one button per option, blocker styling, related cases); the create handler shows
  `showConfirmDialog('A similar case exists: "<title>" (<status>). Create anyway?')` on `SIMILAR_CASES` and
  retries with `force: true`, or attaches this chat to the existing case.
- `CLAUDE.md`: "Cases: detours and the cross-case index" (location, safe to delete `.index/`, types).

## 8. Security and trust

| New capability | Risk | Control |
|---|---|---|
| The index copies every case's text to `<casesRoot>/.index/` | a plaintext copy outside any case repo | Same trust as the case dirs (parent §15); `.gitignore` `*`; rebuildable |
| Cross-case hits reach case A's context (then an outbound payload C3's gate does not check, since it knows only A's facts) | B's private text leaks through A | Redaction inside the index: cross-case text only for disclosable facts and brief `title`/`objective`; `includePrivate` internal only |
| `Ask` similar results | B's question text copied into A | Cross-case question hits return title, id and status only |
| Detour text crossing into the target | A's context copied into B | The `incoming` row holds exactly the question's shown text |
| The routing answer as a `user` fact | other cases' titles become disclosable | `payload.disclosable: false`; candidate rows store case ids, not titles |
| The model proposes detours | spamming the owner | dedupe, 30-day decline memory, `low` urgency, `questionsPerDay` charged by C2's accounting (`createQuestion`) |
| The model maps a free-text answer | a wrong link or case | Only for text answers; journaled in both cases; reversible |
| Prompt injection into the classifier | off-case work marked on-case | Fails open to on-case (no worse than C1); C3's gates still apply |
| git and gh on the `repo` path | reading arbitrary dirs; repo-configured commands | `repo` is owner-only; read-only subcommands via `execFile` without shell; `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`; gh with `--repo` and no `cwd`; `safe.directory` untouched; 5 s timeouts |
| PR titles and branch names in orientation | third-party text steering the model | Quoted, truncated and labelled third-party |
| Writing another case's `case.yaml` | cross-case tampering | Only `addRelation`/`removeRelation`, from router code, under that case's lock via `systemAction`, after an owner answer |
| `case.yaml.id` path traversal into `.index/` | writing outside the index | id pattern check |

Trust principles: 3 (rules are gates) holds for Ask duplicates, case creation and `detourGate`; 7 (check
before assert) is the index; nothing relaxes principle 5.

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| Classifier timeout, error, malformed | on-case; one journal line per turn; adds up to 4 s to the turn | journal line |
| `.index/` unwritable / internal search error | in-memory index / `[]` with a log | nothing |
| Attach target busy | nothing written | `Case "X" is busy with another turn. Try again when it finishes.` |
| Attach target closed or gone | `failed`; new proposal without it | a fresh routing question |
| `SIMILAR_CASES` when resolving `new` | `failed`; new proposal with that case as attach | a fresh routing question |
| Owner answered in words | `awaiting-mapping` | the model's one-line confirmation |
| `questionsPerDay` at 100 % (non-blocking) | proposal `held`, question after rollover | nothing until then |
| git or gh over the refresh budget | stale snapshot; refresh continues | `(stale, fetched <time>)` in extras |

## 10. Testing

`node --test`. The mock provider is a `routedProvider` stub; the fake `exec` returns canned `{ stdout,
stderr, code }` or throws `ENOENT`.

- **`tests/cases-index.test.js`:** relevance on a 12-case invented corpus ("Sell the lakeside lot", "Rear
  door quotes", "Phone agent maintenance", "Website redesign", …); key match at zero text overlap;
  upsert/retract; owner edit to `brief.md` via fingerprint; rebuild byte-identical to upserts; version
  mismatch rebuilds; corrupt file self-heals; read-only root; caps (2,000 chars, 5,000 docs); bad id skipped
  ("id traversal": `case.yaml.id: '../x'` writes nothing outside `.index/`); two instances on one root
  converge; "`git status` of every case is clean after a build"; `attachEntities` delegation.
- **Leak tests (each a named test):** "a private fact from case B never appears in any hit text returned to
  case A" (the F5 fixture's `category: 'financial'`, non-disclosable fact, through `search`, `searchCases`,
  `findDuplicates` rows and `Ledger.unknown` output); "owner-only brief fields of B are redacted";
  "questions and journal titles of B are redacted"; "no caller outside index-store passes includePrivate"
  (source grep); "Ask similar across cases returns title only"; "incoming row copies only the shown text";
  "routing answer fact is non-disclosable"; "proposal rows store no candidate titles".
- **`tests/cases-gates.test.js` (extended):** `findDuplicates` with redacted rows; `findDuplicateQuestion`
  exact/similar/answered; `jobSignature` stable under recipient order; `findDuplicateJob` ignores terminal
  states and honours `submitting`; `findSimilarCases` exact title, exact objective, 0.6 boundary, one-token
  title, closed cases ignored.
- **`tests/cases-detour-classifier.test.js`:** valid, fenced, prose-wrapped JSON; extra keys; `malformed`
  for missing `onCase`, string or out-of-range `confidence`, empty reason, and a JSON array; timeout via the
  `AbortController`; 0.69 vs 0.7; skips; cache; usage charged through `usageHook`.
- **`tests/cases-detour-router.test.js`:** attach (links, `incoming`, wake-up only for an `active` target);
  new (prefill, links, `draft`, `SIMILAR_CASES` → failed + attach proposal); decline; blocker pairs and
  "Blocked by"; duplicate proposal; busy target writes nothing; closed target; "resolve is idempotent" (a
  second resolve returns `existing: true`); reconcile for option and text answers; held proposal at the cap
  and its release after rollover; a blocking proposal overriding the cap.
- **`tests/cases-case-types.test.js`:** unknown type refused and tolerated on disk; `repo` refused on
  `general`, relative paths refused, model writes of `repo` without a quote refused; `completeGating` waits
  for `repo`; extras from a canned snapshot with quoted PR titles; gh ENOENT, auth failure, other exit; not
  a git repository; "git status leaves .git/index untouched" (a real temp repo; `.git/index` mtime and bytes
  unchanged after `refresh`); gh invoked with `--repo` and no `cwd`; the case-type trigger against a
  `caseTypeMaterial` baseline; check-before-write; `indexKeys` forms; `gatingQuestionsFor` with a registered
  source.
- **`tests/cases-detour-hooks.test.js`:** phase 2 does not run when `UserPromptSubmit` blocks; phase 1 notes
  precede orientation.
- **`tests/cases-detour-ipc.test.js`:** the three channels and `case:create` with `force`; reconcile returns
  `busy` when locked elsewhere.
- **`tests/cases-regressions.test.js`:**
  - **F4-detour.** "Rear door quotes" (outreach) and "Phone agent maintenance" (software-repo, temp git
    repo); the mock classifier returns `{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent's
    code does not collect quotes"}`. `detourGate(id, { source: 'executor', serves: 'fix dropped-call
    status', text: 'Patch status polling in the phone agent' })` is refused with the Detour instruction;
    `Detour.propose` offers "Phone agent maintenance" first; the temp repo's HEAD and tree are unchanged;
    after `case:resolveDetour` with `attach-1` both `related` lists hold the pair and the original is
    `active`; the same owner message through the hook yields one proposal.
  - **F5-cross-case.** With "Website redesign" (facts, a journal entry, an open question): `createCase({
    title: 'Redesign the website' })` throws `SIMILAR_CASES`; the router offers it as attach for "redesign
    the website homepage"; `Ask` with its question text from a third case returns the note with the title
    and no text; the F5 unknown test passes through the index with the private fact redacted.
- **`tests/cases-runtime.test.js`:** `endTurn` commits when `upsertCase` throws; `otherCaseFacts` test
  removed. **`tests/electron-boundary.test.js`** covers the new files.
- **E2E (`tests/e2e/cases.test.js`):** with `KL_CASES_ROOT` seeded with two cases and a proposal, the panel
  shows the detour; "Drop it" removes it and writes a `resolution` row.

**Silent conditions and their tests:**

| Condition | Pinned by |
|---|---|
| Near-identical titles ("Sell the lakeside lot" / "Sell lakeside lot") | router "near-identical titles": creating the second needs `force`; both appear as distinct attach options with status |
| A case deleted while indexed | index "deleted case": no hit, its index file gone; related cases show "no longer exists" |
| A repo path that moved | case-types "moved repo": extras show the note; `casesWithKey` still links by remote key |
| An owner message both on-case and a detour | router "mixed message": one proposal, the note says continue, status unchanged |
| The classifier returns malformed JSON | classifier "malformed": `"onCase: no"`, a truncated object and an array are on-case, one journal line, no proposal |

## 11. Deviations from the parent

1. **§4.5** puts the index in per-case `.kl/index/`; C5 uses `<casesRoot>/.index/` (R19), because a per-case
   index cannot answer a cross-case query without the scan §7.3 replaces.
2. **§7.3** refuses only exact same-key jobs; C5 adds exact open-question and case-creation rules, and turns
   similar case creation into an attach proposal.
3. **§8.2** defaults questions to `normal`; a non-blocking detour proposal is `low`.
4. **§10.1** classifies `Plan`/`Executor.submit` tags, which are C3's; C5 ships `detourGate` for them.
5. **§4.3/§5.6** closed cases are never attach targets (§4.1 has no way out of them).
6. **§4.2** `related` gains `detour`, `at`, and `pending:<detourId>` ids.
7. **Code:** `case.yaml.type` was never validated; C5 validates new cases and tolerates old ones.

## 12. Assumptions made without asking

- Non-blocking detour proposals are `low`. Alternative: `normal`.
- Owner messages are classified by default (one `classify` call per message ≥ 12 characters). Alternative:
  off by default.
- gh uses its own login; no token from the vault. Alternative: a vault `GH_TOKEN` for `github.com` only.
- A detour to an existing `active` case starts it through a wake-up; a `draft` target waits for the owner.
  Alternative: always wait for the owner.
- "Recent" closed cases are those whose `statusReason.at` is within 30 days. Alternative: none.
- Declined detours block re-proposal for 30 days. Alternative: forever.
- `repo` is owner-only. Alternative: model-settable with a confirmation question.

## 13. Deferred

| Item | Stage |
|---|---|
| Detour questions on Telegram, email, SMS, voice | C4 (reconcile already handles their answers) |
| Fact-backed gating records, playbook gating sources | C6 |
| Entity documents; `CaseRuntime.entityIndex()`; related cases on MCP | C7 |
| Embeddings in the index (R28) | unassigned; opt-in only when scheduled |
| Open PRs on non-GitHub forges | unassigned |
| Clearing `blocked-by` automatically when the target is `done` (C5 marks it) | unassigned |
| Classifying sub-agent work | unassigned, after the stage-1 sub-agent restriction lifts |

## 14. Dependencies (npm)

None. BM25 and tokenization are about 200 lines in `index-store.js`. Rejected: `minisearch` (the
fingerprinted per-case files are the part that matters, and a library index would need them anyway) and
`lunr` (immutable index, no incremental `upsertCase`). git and gh are optional system binaries.
