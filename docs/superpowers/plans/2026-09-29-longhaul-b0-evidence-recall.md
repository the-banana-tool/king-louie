# LongHaul B0: Evidence Recall Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure recall's BM25 build (recall stage H2) on real long sessions before H3 picks an embedder: import a Claude Code session into LongHaul's session format, author and verify a question set for it, and score the `kl-recall`, `sliding-window` and `oracle` adapters by evidence recall.

**Architecture:** A new Electron-free `src/longhaul/` package with its own CLI (`bin/longhaul.js`). Its data lives in `LONGHAUL_HOME` (default `~/.longhaul/`), never inside a git working tree. The Claude Code importer is built now in `src/history/importers/` (it belongs to recall; H4 adds its UI later). A session is the recall spec's stored message shape as JSONL plus a manifest. Questions are JSONL, validated against the session. Adapters return the context a system would show at `askAtSeq`. `run` scores which evidence messages that context contains. No answer or judge model is called in B0; authoring is the only model call, through `src/providers/` with keys from environment variables.

**Tech Stack:** Node 22+ (`node:util` `parseArgs`, `node:perf_hooks`, `string_decoder`, `node:sqlite` through H1's `HistoryStore`), `node:test`, the existing provider classes and `oneShot`.

**Spec:** `docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md` (stage B0 in §13 and B-D11; decisions B-D5 to B-D12; §4, §5, §6, §7, §8 steps 1, 2 and 5, §10, §11, §14, §15). Also `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md` §3.2, §4.2, §4.3, §6 and §10.2 (the `claude-code-jsonl` mapping), and `CONTEXT.md` for the terms (session, chat, chunk, excerpt, tail, evidence recall, candidate system).

## Global Constraints

- Tests use node's built-in runner: `node --test tests/<file>.test.js` per task; `npm test` (`node --test --test-timeout=120000 tests/*.test.js`) once, in Task 14. Never `jest`. Look for `# fail 0` in the TAP summary.
- Each task runs only its covering tests. The full suite runs once, in Task 14 (owner rule: no full suite per task).
- `src/longhaul/` is Electron-free. It may require `src/history/`, `src/providers/`, `src/core/settings.js` and `src/logging.js`. Nothing else in `src/` may require `src/longhaul/`; `tests/longhaul-boundary.test.js` enforces this. `tests/electron-boundary.test.js` already walks every file in `src/`.
- `src/longhaul/**` and `bin/longhaul.js` are left out of the Electron build (`package.json` `build.files`). `package.json` `bin` gains `"longhaul": "bin/longhaul.js"`.
- `LONGHAUL_HOME` (default `~/.longhaul/`) holds `private/`, `sessions/`, `questions/`, `runs/`, `reports/`. The CLI refuses a `LONGHAUL_HOME` inside a git working tree, checking both the path as given and the path with links resolved. Nothing private is ever written under the repository; only synthetic fixtures are committed.
- CLI output goes through `ctx.stdout.write`/`ctx.stderr.write` and stays ASCII (a Windows console on code page 437 garbles typographic characters). Library code logs through `createLogger` from `src/logging.js`, never bare `console.*`.
- Exit codes: `0` success, `1` failure (including a leak), `2` usage error or refusal.
- Sequence numbers are the benchmark's clock: a candidate system is only ever shown messages with `seq < askAtSeq`. `run` counts every shown seq `>= askAtSeq` as a leak and exits 1.
- The metric is always called **evidence recall**, never "recall" alone, in output, file names and docs.
- Distance buckets, verbatim from spec §5: under 10K, 10 to 50K, 50 to 200K, 200K to 1M, over 1M estimated tokens. Their ids are `<10K`, `10K-50K`, `50K-200K`, `200K-1M` and `>1M`; `none` is used for `abstain`. Distance is measured from the nearest evidence message (the largest evidence seq), as in the spec's example (`askAtSeq` 8810, evidence 4412 and 4415, distance 4395 messages). Its tokens are the estimated tokens of the messages strictly between that message and `askAtSeq`.
- Estimated tokens are `ceil(chars / 4)`, the uncalibrated default of recall's `TokenEstimator`. A test in Task 8 pins that the two agree.
- Every JSONL file is read with `readJsonlLines` (`src/history/importers/jsonl-lines.js`), which splits on `\n` only. `node:readline` also splits on U+2028/U+2029, which `JSON.stringify` leaves unescaped inside strings.
- Invented values only in fixtures, tests and docs (CLAUDE.md example rules). That means codenames from word lists, ports 18000 to 18999, hosts under `example.com`, and `<placeholder>` path segments. Never a real session, name or home path. Fixtures pass `scanForPersonalValues` (`tests/helpers/example-denylist.js`).
- Unit tests never touch the network. They use a scripted fake client, or point a provider's `baseUrl` at `tests/helpers/fake-llm-server.js`.
- Session ids match `/^[A-Za-z0-9._-]{1,64}$/`.
- B0 is built on recall H1+H2's shared contract, exactly:
  - `src/history/index.js` exports `HistoryStore`: `static open(dbPath, { readonly })`, `close()`, `transaction(fn)`, `listChats`, `getChat(id, { messages })`, `createChat(chat, { position })`, `appendMessage(chatId, message) → { message, seq }` (also writes chunks and FTS in the same transaction), `getMessages(chatId, { fromSeq, toSeq, limit })` (inclusive), `searchText(query, { chatIds, kinds, limit, upToSeq })`, `chunks(ids) → [{ id, messageId, chatId, seq, idx, kind, text, chars, ts }]`.
  - `src/history/chunker.js` `chunkMessage(message, opts)`. A `status` message with `meta.compaction === true` is chunked as kind `summary`.
  - `src/history/token-estimator.js` `TokenEstimator({ store })` with `.estimate(text, model)`.
  - `src/history/retriever.js` `Retriever({ store, estimator })`.
  - `src/history/context-builder.js` `ContextBuilder({ store, retriever, estimator, getSettings })` with `async build({ chatId, message, model, upToSeq }) → { tail, recalled: { text, chunkIds, estTokens }, stats: { tail: { fromSeq, toSeq, seqs }, recalledChunkIds, estTokens, fullHistoryEstTokens, embedder, scope } }`; `message` is the new user message as a string. Only messages with `seq < upToSeq` are considered; ages and recency are measured from message `upToSeq`'s timestamp.
  - Recall defaults come from `src/core/settings.js` `history.recall` (and `history.chunk`).

## Review Focus

1. **A record whose JSON strings contain U+2028 or U+2029**, as pasted text often does. `node:readline` splits the line there; on one real 98 MB session that produced 16 unparseable fragments. Expected: one record per `\n`-terminated line, text intact. Tests: Task 2 (`readJsonlLines`) and Task 3 (fixture record `u-4`).
2. **A session file still being written (the last line cut off), or with a corrupt line in the middle.** Expected: import counts it in `badLines` and keeps going; the session stays usable. Test: Task 3.
3. **Records repeated with the same `uuid`**, as when a resumed or forked session replays history. Expected: counted as `duplicates` and not appended, so seqs and distances are not inflated. Test: Task 3.
4. **A `LONGHAUL_HOME` that reaches a repository through a junction or symlink, or sits in a git worktree whose `.git` is a file.** Expected: refused like a direct path, before anything is written. Test: Task 1.
5. **A tool result whose seq falls inside the tail's range but that the tail does not show** (the recall tail omits tool results, recall spec §6.1). Expected: it is not counted as shown for `kl-recall`; evidence seqs come from the tail messages the builder returned, not from `stats.tail`'s range. Test: Task 8 (`shownFromBuild`).

---

## File Structure

New, under `src/longhaul/` (Electron-free):

| File | Responsibility |
|---|---|
| `errors.js` | `UsageError`: messages the CLI prints with exit code 2 |
| `home.js` | `resolveHome`, `ensureDirs`, `SUBDIRS`; the git-tree refusal |
| `files.js` | `writeFileAtomic`, `sha256File`, `sha256Text`, `isInside` |
| `cli.js` | Command table, argument parsing, exit codes |
| `commands/home.js`, `commands/import.js`, `commands/synth.js`, `commands/run.js`, `commands/author.js`, `commands/verify.js` | One CLI command each |
| `session-format.js` | Message text and rendering, token estimate, `SessionIndex`, manifest build and validation, session read/write |
| `questions.js` | Question format, `validateQuestion`, `validateQuestionSet`, distance and buckets, read/write |
| `importing.js` | `importSession`: a Claude Code file into `LONGHAUL_HOME/sessions/<id>/` |
| `rng.js` | Seeded RNG (mulberry32) |
| `synthetic.js` | Synthetic sessions with planted facts; `SYNTH_FIXTURES`; `writeSyntheticRoot` |
| `adapters/index.js`, `adapters/common.js`, `adapters/sliding-window.js`, `adapters/oracle.js`, `adapters/kl-recall.js` | Candidate systems (spec §7) |
| `scoring.js` | Evidence recall, chunk evidence recall, summary, `summary.md` |
| `run.js` | `runBenchmark`: records, `config.json`, summary |
| `model.js` | `createModelClient`: one prompt → text, via `oneShot` |
| `sampling.js` | `planAuthoring`: stratified by kind and distance bucket |
| `author.js` | `authorCandidates`, `parseReply`, `fillPrompt` |
| `prompts/author-v1.md` | The authoring prompt (its SHA-256 is logged) |
| `verify.js` | `verifyLoop`: the accept/edit/reject terminal loop |

Other new files: `bin/longhaul.js`, `src/history/importers/jsonl-lines.js`, `src/history/importers/claude-code-jsonl.js`, `src/providers/env-keys.js`.

Modified: `package.json`, `src/providers/provider-factory.js` (`fromEnv`), `scripts/smoke-providers.js` (key names move to `env-keys.js`), `CLAUDE.md`, `.github/workflows/test.yml`.

New tests: `tests/longhaul-home.test.js`, `tests/longhaul-boundary.test.js`, `tests/history-jsonl-lines.test.js`, `tests/longhaul-session-format.test.js`, `tests/history-importer-claude-code.test.js`, `tests/longhaul-questions.test.js`, `tests/longhaul-import.test.js`, `tests/longhaul-synthetic.test.js`, `tests/longhaul-adapters.test.js`, `tests/longhaul-adapter-kl-recall.test.js`, `tests/longhaul-run.test.js`, `tests/longhaul-smoke.test.js`, `tests/longhaul-model.test.js`, `tests/longhaul-sampling.test.js`, `tests/longhaul-author.test.js`, `tests/longhaul-verify.test.js`. Helpers: `tests/helpers/longhaul-helpers.js`, `tests/helpers/claude-code-fixture.js`. Fixtures (generated by `longhaul synth`): `tests/fixtures/longhaul/sessions/{synth-small,synth-medium,synth-compacted}/{manifest.json,messages.jsonl}` and `tests/fixtures/longhaul/questions/{synth-small,synth-medium,synth-compacted}.jsonl`.

On-disk layouts:

```
<data root>/                    LONGHAUL_HOME, or tests/fixtures/longhaul for the smoke run
  sessions/<id>/manifest.json   spec §4 manifest (+ title, sourceSha256, importer, unmapped, skipped, badLines, duplicates, constructed)
  sessions/<id>/messages.jsonl  one stored-shape message per line, seq dense from 1
  questions/<id>.jsonl          spec §5 questions
  questions/<id>.author-log.jsonl   one line per `author` invocation (prompt hash, model, seed, counts)
  questions/<id>.rejected.jsonl     questions rejected in `verify`
LONGHAUL_HOME/runs/<runId>/     config.json, records.jsonl, summary.json, summary.md
```

---

## Task 1: CLI skeleton, LONGHAUL_HOME and packaging

**Files:**
- Create: `src/longhaul/errors.js`, `src/longhaul/home.js`, `src/longhaul/cli.js`, `src/longhaul/commands/home.js`, `bin/longhaul.js`, `tests/helpers/longhaul-helpers.js`
- Modify: `package.json` (`bin`, `build.files`)
- Test: `tests/longhaul-home.test.js`, `tests/longhaul-boundary.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/longhaul/errors.js`: `class UsageError extends Error` with `code` (default `'USAGE'`).
  - `src/longhaul/home.js`: `SUBDIRS = ['private','sessions','questions','runs','reports']`, `resolveHome(env = process.env, { homedir } = {}) → { root, private, sessions, questions, runs, reports }` (absolute paths; throws `UsageError` with `code: 'HOME_IN_GIT_TREE'`), `ensureDirs(home) → home`, `findGitWorkTree(dir) → string|null`.
  - `src/longhaul/cli.js`: `COMMANDS` (name → `{ needsHome?: boolean, options, run(ctx, values, positionals) → Promise<exitCode> }`), `main(argv, io = {}) → Promise<exitCode>` where `io = { stdout, stderr, stdin, env, now, cwd, homedir }`, `usage()`. `ctx = { home, env, stdout, stderr, stdin, now, cwd }`; `home` is `null` for commands with `needsHome: false`. Later tasks add one line per command to `COMMANDS`.
  - `tests/helpers/longhaul-helpers.js`: `REPO`, `FIXTURE_ROOT` (`tests/fixtures/longhaul`), `tmpDir(prefix)`, `sink()` (an object with `text` and `write(s)`), `tmpHome() → { env: { LONGHAUL_HOME }, root }`.

- [ ] **Step 1: Write the test helper**

Create `tests/helpers/longhaul-helpers.js`:

```js
// tests/helpers/longhaul-helpers.js
// Shared bits for the LongHaul tests: temp directories (never inside the
// repository, so LONGHAUL_HOME's git-tree refusal does not fire) and an
// output sink standing in for stdout/stderr.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO, 'tests', 'fixtures', 'longhaul');

function tmpDir(prefix = 'longhaul-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sink() {
  return { text: '', write(s) { this.text += String(s); return true; } };
}

function tmpHome() {
  const root = path.join(tmpDir(), 'lh');
  return { env: { LONGHAUL_HOME: root }, root };
}

module.exports = { REPO, FIXTURE_ROOT, tmpDir, sink, tmpHome };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/longhaul-home.test.js`:

```js
// tests/longhaul-home.test.js
// LONGHAUL_HOME (benchmark spec B-D12, §10.1): default ~/.longhaul, five
// subdirectories, and never inside a git working tree, however it is reached.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveHome, ensureDirs, SUBDIRS } = require('../src/longhaul/home');
const { main } = require('../src/longhaul/cli');
const { REPO, tmpDir, sink } = require('./helpers/longhaul-helpers');

const inGitTree = (err) => err.code === 'HOME_IN_GIT_TREE' && /git working tree/.test(err.message);

describe('resolveHome', () => {
  it('defaults to <homedir>/.longhaul with the five subdirectories', () => {
    const fakeHome = tmpDir();
    const home = resolveHome({}, { homedir: () => fakeHome });
    assert.strictEqual(home.root, path.join(fakeHome, '.longhaul'));
    for (const d of SUBDIRS) assert.strictEqual(home[d], path.join(fakeHome, '.longhaul', d));
    assert.deepStrictEqual(SUBDIRS, ['private', 'sessions', 'questions', 'runs', 'reports']);
  });

  it('uses LONGHAUL_HOME when it is set, and ensureDirs creates the subdirectories', () => {
    const root = path.join(tmpDir(), 'data');
    const home = ensureDirs(resolveHome({ LONGHAUL_HOME: root }));
    assert.strictEqual(home.root, root);
    for (const d of SUBDIRS) assert.ok(fs.statSync(path.join(root, d)).isDirectory());
  });

  it('refuses a home inside a git working tree, even one that does not exist yet', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(repo, 'deep', 'lh') }), inGitTree);
    assert.strictEqual(fs.existsSync(path.join(repo, 'deep')), false, 'nothing is created before the refusal');
  });

  it('refuses a git worktree whose .git is a file', () => {
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n');
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(worktree, 'lh') }), inGitTree);
  });

  it('refuses a home reached through a junction or symlink into a repository', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'inner'));
    const outside = tmpDir();
    const link = path.join(outside, 'link');
    fs.symlinkSync(path.join(repo, 'inner'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(link, 'lh') }), inGitTree);
  });
});

describe('longhaul CLI skeleton', () => {
  it('prints usage with no arguments and exits 0', async () => {
    const stdout = sink();
    assert.strictEqual(await main([], { stdout, stderr: sink() }), 0);
    assert.match(stdout.text, /Usage: longhaul <command>/);
  });

  it('rejects an unknown command and an unknown option with exit 2', async () => {
    const stderr = sink();
    assert.strictEqual(await main(['nope'], { stdout: sink(), stderr }), 2);
    assert.match(stderr.text, /Unknown command "nope"/);
    const root = path.join(tmpDir(), 'lh');
    assert.strictEqual(await main(['home', '--bogus'], { stdout: sink(), stderr: sink(), env: { LONGHAUL_HOME: root } }), 2);
  });

  it('home prints LONGHAUL_HOME and creates it', async () => {
    const root = path.join(tmpDir(), 'lh');
    const stdout = sink();
    assert.strictEqual(await main(['home'], { stdout, stderr: sink(), env: { LONGHAUL_HOME: root } }), 0);
    assert.ok(stdout.text.startsWith(root));
    assert.ok(fs.existsSync(path.join(root, 'private')));
  });

  it('refuses with exit 2 when LONGHAUL_HOME is inside a git working tree', async () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    const stderr = sink();
    assert.strictEqual(await main(['home'], { stdout: sink(), stderr, env: { LONGHAUL_HOME: path.join(repo, 'lh') } }), 2);
    assert.match(stderr.text, /git working tree/);
  });

  it('bin/longhaul.js runs', () => {
    const out = spawnSync(process.execPath, [path.join(REPO, 'bin', 'longhaul.js'), 'help'], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /Usage: longhaul/);
  });
});
```

Create `tests/longhaul-boundary.test.js`:

```js
// tests/longhaul-boundary.test.js
// LongHaul can move to its own repository (B-D5): nothing in src/ requires
// src/longhaul/, src/longhaul/ never reaches the Electron host, and the
// Electron build leaves it out.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LONGHAUL = path.join(SRC, 'longhaul') + path.sep;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

describe('LongHaul boundaries', () => {
  it('nothing in src/ outside src/longhaul/ requires it', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.startsWith(LONGHAUL))
      .filter((f) => /require\(\s*['"][^'"]*\blonghaul\b[^'"]*['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    assert.deepStrictEqual(offenders, []);
  });

  it('src/longhaul/ never requires electron or src/ipc/', () => {
    const offenders = walk(LONGHAUL)
      .filter((f) => /require\(\s*['"](electron|[^'"]*\/ipc\/[^'"]*)['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    assert.deepStrictEqual(offenders, []);
  });

  it('package.json ships the longhaul bin and leaves LongHaul out of the Electron build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.bin.longhaul, 'bin/longhaul.js');
    assert.ok(pkg.build.files.includes('!src/longhaul/**'));
    assert.ok(pkg.build.files.includes('!bin/longhaul.js'));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/longhaul-home.test.js tests/longhaul-boundary.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/home'`.

- [ ] **Step 4: Write `src/longhaul/errors.js`**

```js
'use strict';
// A problem with how LongHaul was invoked or with its inputs. The CLI prints
// the message alone and exits 2; anything else is a failure (exit 1).
class UsageError extends Error {
  constructor(message, code = 'USAGE') {
    super(message);
    this.name = 'UsageError';
    this.code = code;
  }
}

module.exports = { UsageError };
```

- [ ] **Step 5: Write `src/longhaul/home.js`**

```js
'use strict';
// LONGHAUL_HOME (benchmark spec B-D12, §10.1): private/, sessions/,
// questions/, runs/ and reports/. It is refused inside a git working tree,
// checked on the path as given and on the path with links resolved, so a
// junction or symlink into a repository is refused too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageError } = require('./errors');

const SUBDIRS = Object.freeze(['private', 'sessions', 'questions', 'runs', 'reports']);

function findGitWorkTree(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The path with links resolved as far as it exists; the missing tail is kept.
function nearestRealPath(target) {
  let cur = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = fs.realpathSync.native(cur); } catch { /* keep the lexical path */ }
  return path.join(real, ...rest);
}

function resolveHome(env = process.env, { homedir } = {}) {
  const raw = typeof env.LONGHAUL_HOME === 'string' ? env.LONGHAUL_HOME.trim() : '';
  const root = path.resolve(raw || path.join((homedir || os.homedir)(), '.longhaul'));
  for (const candidate of [root, nearestRealPath(root)]) {
    const tree = findGitWorkTree(candidate);
    if (tree) {
      throw new UsageError(
        `LONGHAUL_HOME (${root}) is inside the git working tree at ${tree}. `
        + 'Session data must never live in a repository; set LONGHAUL_HOME to a directory outside it.',
        'HOME_IN_GIT_TREE'
      );
    }
  }
  const home = { root };
  for (const d of SUBDIRS) home[d] = path.join(root, d);
  return home;
}

function ensureDirs(home) {
  for (const d of SUBDIRS) fs.mkdirSync(home[d], { recursive: true });
  return home;
}

module.exports = { SUBDIRS, resolveHome, ensureDirs, findGitWorkTree };
```

- [ ] **Step 6: Write `src/longhaul/cli.js` and `src/longhaul/commands/home.js`**

`src/longhaul/cli.js`:

```js
'use strict';
// LongHaul's CLI (benchmark spec §3). Each command is
// { needsHome?, options (node:util parseArgs), run(ctx, values, positionals) }
// and returns an exit code: 0 success, 1 failure, 2 usage or refusal.
const { parseArgs } = require('node:util');
const { resolveHome, ensureDirs } = require('./home');
const { UsageError } = require('./errors');

const COMMANDS = {
  home: require('./commands/home')
};

function usage() {
  return [
    'Usage: longhaul <command> [options]',
    '',
    `Commands: ${Object.keys(COMMANDS).sort().join(', ')}`,
    'Data lives in LONGHAUL_HOME (default ~/.longhaul), never inside a git working tree.',
    ''
  ].join('\n');
}

function isUsageProblem(err) {
  return err instanceof UsageError || String(err?.code || '').startsWith('ERR_PARSE_ARGS');
}

async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    stdout.write(usage());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    stderr.write(`Unknown command "${name}".\n${usage()}`);
    return 2;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options || {}, allowPositionals: true, strict: true });
    const home = command.needsHome === false ? null : ensureDirs(resolveHome(env, { homedir: io.homedir }));
    const ctx = {
      home, env, stdout, stderr,
      stdin: io.stdin || process.stdin,
      now: io.now || (() => new Date()),
      cwd: io.cwd || process.cwd()
    };
    return await command.run(ctx, values, positionals);
  } catch (err) {
    if (isUsageProblem(err)) {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    stderr.write(`longhaul ${name} failed: ${err.message}\n`);
    return 1;
  }
}

module.exports = { main, COMMANDS, usage };
```

`src/longhaul/commands/home.js`:

```js
'use strict';
// `longhaul home`: where LongHaul keeps its data on this machine.
const { SUBDIRS } = require('../home');

module.exports = {
  options: {},
  async run(ctx) {
    ctx.stdout.write(`${ctx.home.root}\n`);
    for (const d of SUBDIRS) ctx.stdout.write(`  ${d}/\n`);
    return 0;
  }
};
```

- [ ] **Step 7: Write `bin/longhaul.js`**

```js
#!/usr/bin/env node
// LongHaul, the session memory benchmark (docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md).
const { main } = require('../src/longhaul/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; }
);
```

- [ ] **Step 8: Update `package.json`**

In `"bin"` add the second entry:

```json
  "bin": {
    "king-louie-service": "bin/king-louie-service.js",
    "longhaul": "bin/longhaul.js"
  },
```

In `"build"."files"` add the two exclusions after `"!.github/**"`:

```json
    "files": [
      "**/*",
      "!tests/**",
      "!product-management/**",
      "!.github/**",
      "!src/longhaul/**",
      "!bin/longhaul.js",
      "!examples/**",
      "examples/playbooks/**"
    ],
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/longhaul-home.test.js tests/longhaul-boundary.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/longhaul/errors.js src/longhaul/home.js src/longhaul/cli.js src/longhaul/commands/home.js bin/longhaul.js package.json tests/helpers/longhaul-helpers.js tests/longhaul-home.test.js tests/longhaul-boundary.test.js
git commit -m "feat(longhaul): CLI skeleton, LONGHAUL_HOME outside any git tree, left out of the Electron build"
```

---

## Task 2: JSONL line reader and the session format

**Files:**
- Create: `src/history/importers/jsonl-lines.js`, `src/longhaul/files.js`, `src/longhaul/session-format.js`
- Test: `tests/history-jsonl-lines.test.js`, `tests/longhaul-session-format.test.js`

**Interfaces:**
- Consumes: `UsageError` (Task 1).
- Produces:
  - `src/history/importers/jsonl-lines.js`: `async function* readJsonlLines(filePath, { highWaterMark = 1 << 20 } = {})` yielding `{ line, lineNo }` for every non-blank line (1-based line numbers; `\r` and a leading BOM stripped; splits on `\n` only).
  - `src/longhaul/files.js`: `writeFileAtomic(file, content)` where `content` is a string or `(write) => void`; `sha256File(file) → Promise<hex>`; `sha256Text(text) → hex`; `isInside(child, parent) → boolean`.
  - `src/longhaul/session-format.js`: `SENDERS`, `SESSION_ID_RE`, `CHARS_PER_TOKEN = 4`, `estimateTokens(text) → int`, `messageText(m) → string`, `senderLabel(m) → string`, `renderMessage(m) → '[#<seq> <label>]\n<text>'`, `renderMessages(list) → string` (joined with a blank line), `class SessionIndex` (`constructor(messages)`, `messages`, `maxSeq`, `userSeqs: number[]`, `get(seq) → message|null`, `tokensBetween(afterSeq, beforeSeq) → int` for the messages strictly between, `totalTokens()`), `validateMessages(messages) → string[]`, `validateManifest(manifest, messages) → string[]`, `buildManifest({ sessionId, source, sourceRef, license, private, messages, compactions, extra }) → manifest`, `writeSession(dir, { manifest, messages })`, `loadSession(dir) → Promise<{ manifest, messages, index }>`, `listSessions(dataRoot) → string[]`, `sessionDir(dataRoot, id) → string`.
  - A **session** object everywhere below is `{ manifest, messages, index }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-jsonl-lines.test.js`:

```js
// tests/history-jsonl-lines.test.js
// JSONL is split on '\n' only: node:readline also splits on U+2028/U+2029,
// which JSON.stringify leaves raw inside strings (LongHaul Review Focus 1).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../src/history/importers/jsonl-lines');
const { tmpDir } = require('./helpers/longhaul-helpers');

async function collect(file, opts) {
  const out = [];
  for await (const l of readJsonlLines(file, opts)) out.push(l);
  return out;
}

describe('readJsonlLines', () => {
  const dir = tmpDir();
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

  it('keeps U+2028 and U+2029 inside one line', async () => {
    const rec = { text: 'a b c' };
    const file = write('sep.jsonl', `${JSON.stringify(rec)}\n${JSON.stringify({ n: 2 })}\n`);
    const lines = await collect(file);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(JSON.parse(lines[0].line), rec);
    assert.deepStrictEqual(lines.map((l) => l.lineNo), [1, 2]);
  });

  it('strips CRLF and a leading BOM, skips blank lines, and yields a last line with no newline', async () => {
    const file = write('crlf.jsonl', '﻿{"a":1}\r\n\r\n{"b":2}\r\n{"c":3}');
    const lines = await collect(file);
    assert.deepStrictEqual(lines.map((l) => l.line), ['{"a":1}', '{"b":2}', '{"c":3}']);
    assert.deepStrictEqual(lines.map((l) => l.lineNo), [1, 3, 4]);
  });

  it('reassembles lines and multibyte characters split across read chunks', async () => {
    const recs = [{ t: 'é'.repeat(50) }, { t: '日本語'.repeat(20) }, { t: 'x' }];
    const file = write('chunks.jsonl', `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const lines = await collect(file, { highWaterMark: 7 });
    assert.deepStrictEqual(lines.map((l) => JSON.parse(l.line)), recs);
  });

  it('reads a 3 MB line intact', async () => {
    const file = write('big.jsonl', `${JSON.stringify({ t: 'y'.repeat(3_000_000) })}\n{"after":true}\n`);
    const lines = await collect(file);
    assert.strictEqual(JSON.parse(lines[0].line).t.length, 3_000_000);
    assert.deepStrictEqual(JSON.parse(lines[1].line), { after: true });
  });
});
```

Create `tests/longhaul-session-format.test.js`:

```js
// tests/longhaul-session-format.test.js
// LongHaul's session format (benchmark spec §4).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sf = require('../src/longhaul/session-format');
const { tmpDir } = require('./helpers/longhaul-helpers');

const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString();
function msgs() {
  return [
    { id: 'm1', seq: 1, sender: 'user', text: 'u'.repeat(40), timestamp: at(1) },
    { id: 'm2', seq: 2, sender: 'assistant', text: 'a'.repeat(40), timestamp: at(2) },
    { id: 'm3', seq: 3, sender: 'toolUse', toolName: 'Bash', parameters: { command: 'ls' }, timestamp: at(3) },
    { id: 'm4', seq: 4, sender: 'toolResult', toolName: 'Bash', result: 'r'.repeat(40), timestamp: at(4) },
    { id: 'm5', seq: 5, sender: 'status', text: 's'.repeat(40), meta: { compaction: true }, timestamp: at(5) },
    { id: 'm6', seq: 6, sender: 'user', text: 'line separated', timestamp: at(6) }
  ];
}

describe('message text and tokens', () => {
  it('estimates ceil(chars / 4)', () => {
    assert.strictEqual(sf.estimateTokens(''), 0);
    assert.strictEqual(sf.estimateTokens('abcd'), 1);
    assert.strictEqual(sf.estimateTokens('abcde'), 2);
  });

  it('renders each sender with an ASCII header', () => {
    const [u, , use, result, summary] = msgs();
    assert.strictEqual(sf.messageText(use), 'Bash: {"command":"ls"}');
    assert.strictEqual(sf.messageText({ sender: 'toolResult', result: { ok: true } }), '{\n  "ok": true\n}');
    assert.strictEqual(sf.renderMessage(u), `[#1 user]\n${'u'.repeat(40)}`);
    assert.strictEqual(sf.renderMessage(use).split('\n')[0], '[#3 Bash call]');
    assert.strictEqual(sf.renderMessage(result).split('\n')[0], '[#4 Bash result]');
    assert.strictEqual(sf.renderMessage(summary).split('\n')[0], '[#5 compaction summary]');
  });
});

describe('SessionIndex', () => {
  it('sums estimated tokens strictly between two seqs and lists user seqs', () => {
    const index = new sf.SessionIndex(msgs());
    assert.strictEqual(index.maxSeq, 6);
    assert.strictEqual(index.tokensBetween(1, 5), 10 + 6 + 10);
    assert.strictEqual(index.tokensBetween(2, 3), 0);
    assert.deepStrictEqual(index.userSeqs, [1, 6]);
    assert.strictEqual(index.get(7), null);
    assert.strictEqual(index.get(3).id, 'm3');
  });

  it('refuses messages whose seq is not dense from 1', () => {
    const bad = msgs();
    bad[2].seq = 9;
    assert.throws(() => new sf.SessionIndex(bad), /not dense/);
  });
});

describe('manifest and session files', () => {
  it('builds the manifest counts, and a private session is licensed "private"', () => {
    const m = sf.buildManifest({ sessionId: 'S1', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: true, messages: msgs(), compactions: [] });
    assert.strictEqual(m.messages, 6);
    assert.strictEqual(m.humanMessages, 2);
    assert.strictEqual(m.toolCalls, 1);
    assert.strictEqual(m.license, 'private');
    assert.strictEqual(m.private, true);
    assert.strictEqual(m.bytesByKind.tool_result, 40);
    assert.deepStrictEqual(m.span, { from: at(1), to: at(6) });
    assert.strictEqual(m.estTokens, new sf.SessionIndex(msgs()).totalTokens());
  });

  it('writes and loads a session, keeping U+2028 in text', async () => {
    const dir = path.join(tmpDir(), 'sessions', 'S1');
    const messages = msgs();
    const manifest = sf.buildManifest({ sessionId: 'S1', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [{ atSeq: 5, summarySeq: 5, windowFromSeq: 1, windowToSeq: 4 }] });
    sf.writeSession(dir, { manifest, messages });
    const loaded = await sf.loadSession(dir);
    assert.deepStrictEqual(loaded.messages, messages);
    assert.deepStrictEqual(loaded.manifest, manifest);
    assert.strictEqual(loaded.index.get(6).text, 'line separated');
    assert.deepStrictEqual(sf.listSessions(path.dirname(path.dirname(dir))), ['S1']);
  });

  it('refuses to write an invalid session and writes nothing', () => {
    const dir = path.join(tmpDir(), 'S2');
    const messages = msgs();
    messages[1].id = 'm1';
    const manifest = sf.buildManifest({ sessionId: 'S2', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [] });
    assert.throws(() => sf.writeSession(dir, { manifest, messages }), /duplicate id m1/);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('flags a compaction whose summarySeq is not a compaction summary', () => {
    const messages = msgs();
    const manifest = sf.buildManifest({ sessionId: 'S3', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [{ atSeq: 4, summarySeq: 4, windowFromSeq: 1, windowToSeq: 3 }] });
    assert.match(sf.validateManifest(manifest, messages).join('\n'), /summarySeq 4 is not a compaction summary/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-jsonl-lines.test.js tests/longhaul-session-format.test.js`
Expected: FAIL with `Cannot find module '../src/history/importers/jsonl-lines'`.

- [ ] **Step 3: Write `src/history/importers/jsonl-lines.js`**

```js
'use strict';
// Streams a JSONL file line by line, splitting on '\n' only. node:readline is
// not used: it also breaks lines at U+2028 and U+2029, which JSON.stringify
// leaves unescaped inside strings, so one record would arrive as fragments.
// Lines are sliced by index, never by repeatedly slicing the buffer's front,
// so a 1 MB chunk of short lines is not copied once per line.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

async function* readJsonlLines(filePath, { highWaterMark = 1 << 20 } = {}) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let lineNo = 0;
  let first = true;
  const clean = (raw) => {
    lineNo += 1;
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (first) {
      first = false;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    return line;
  };
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark })) {
    buf += decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      const line = clean(buf.slice(start, nl));
      start = nl + 1;
      if (line.trim()) yield { line, lineNo };
    }
    buf = buf.slice(start);
  }
  buf += decoder.end();
  if (buf.length) {
    const line = clean(buf);
    if (line.trim()) yield { line, lineNo };
  }
}

module.exports = { readJsonlLines };
```

- [ ] **Step 4: Write `src/longhaul/files.js`**

```js
'use strict';
// Small file helpers for LongHaul: atomic writes (temp file, fsync, rename),
// streaming SHA-256, and path containment.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof content === 'function') content((text) => fs.writeSync(fd, text));
    else fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { writeFileAtomic, sha256File, sha256Text, isInside };
```

- [ ] **Step 5: Write `src/longhaul/session-format.js`**

```js
'use strict';
// LongHaul's session format (benchmark spec §4): the recall spec's stored
// message shape (id, sender, text, timestamp, seq plus per-sender fields),
// one message per line in messages.jsonl, and manifest.json.
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../history/importers/jsonl-lines');
const { writeFileAtomic } = require('./files');

const SENDERS = Object.freeze(['user', 'assistant', 'toolUse', 'toolResult', 'status']);
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CHARS_PER_TOKEN = 4;
const BYTE_KINDS = Object.freeze({ user: 'user', assistant: 'assistant', toolUse: 'tool_use', toolResult: 'tool_result', status: 'status' });

// recall's TokenEstimator without calibration (recall spec §6.6); Task 8
// pins that the two agree.
function estimateTokens(text) {
  const n = String(text ?? '').length;
  return n === 0 ? 0 : Math.ceil(n / CHARS_PER_TOKEN);
}

function asText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function messageText(m) {
  if (!m) return '';
  if (m.sender === 'toolUse') return `${m.toolName || 'tool'}: ${JSON.stringify(m.parameters ?? {})}`;
  if (m.sender === 'toolResult') return typeof m.text === 'string' && m.text ? m.text : asText(m.result);
  return typeof m.text === 'string' ? m.text : '';
}

function senderLabel(m) {
  if (m.sender === 'toolUse') return `${m.toolName || 'tool'} call`;
  if (m.sender === 'toolResult') return `${m.toolName || 'tool'} result`;
  if (m.sender === 'status' && m.meta?.compaction === true) return 'compaction summary';
  return m.sender;
}

function renderMessage(m) {
  return `[#${m.seq} ${senderLabel(m)}]\n${messageText(m)}`;
}

function renderMessages(list) {
  return list.map(renderMessage).join('\n\n');
}

class SessionIndex {
  constructor(messages) {
    this.messages = messages;
    this.prefix = new Float64Array(messages.length + 1);
    this.userSeqs = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.seq !== i + 1) throw new Error(`messages are not dense: position ${i + 1} has seq ${m.seq}`);
      this.prefix[i + 1] = this.prefix[i] + estimateTokens(messageText(m));
      if (m.sender === 'user') this.userSeqs.push(m.seq);
    }
  }

  get maxSeq() { return this.messages.length; }

  get(seq) {
    return Number.isInteger(seq) && seq >= 1 && seq <= this.messages.length ? this.messages[seq - 1] : null;
  }

  // Estimated tokens of the messages strictly between afterSeq and beforeSeq.
  tokensBetween(afterSeq, beforeSeq) {
    if (beforeSeq - afterSeq <= 1) return 0;
    return this.prefix[beforeSeq - 1] - this.prefix[afterSeq];
  }

  totalTokens() { return this.prefix[this.messages.length]; }
}

function validateMessages(messages) {
  const errors = [];
  const ids = new Set();
  messages.forEach((m, i) => {
    const where = `message ${i + 1}`;
    if (!m || typeof m !== 'object') { errors.push(`${where}: not an object`); return; }
    if (m.seq !== i + 1) errors.push(`${where}: seq ${m.seq}, expected ${i + 1}`);
    if (!SENDERS.includes(m.sender)) errors.push(`${where}: unknown sender ${JSON.stringify(m.sender)}`);
    if (typeof m.id !== 'string' || !m.id) errors.push(`${where}: missing id`);
    else if (ids.has(m.id)) errors.push(`${where}: duplicate id ${m.id}`);
    else ids.add(m.id);
    if (typeof m.timestamp !== 'string' || Number.isNaN(Date.parse(m.timestamp))) errors.push(`${where}: bad timestamp`);
  });
  return errors;
}

function validateManifest(manifest, messages) {
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  const errors = [];
  if (!SESSION_ID_RE.test(String(manifest.sessionId))) errors.push(`sessionId ${JSON.stringify(manifest.sessionId)} must match ${SESSION_ID_RE}`);
  if (typeof manifest.private !== 'boolean') errors.push('private must be true or false');
  if (typeof manifest.license !== 'string' || !manifest.license) errors.push('license is required');
  if (manifest.private === true && manifest.license !== 'private') errors.push('a private session has license "private"');
  if (manifest.messages !== messages.length) errors.push(`manifest says ${manifest.messages} messages, the file has ${messages.length}`);
  for (const c of manifest.compactions || []) {
    const s = messages[c.summarySeq - 1];
    if (!s || s.sender !== 'status' || s.meta?.compaction !== true) errors.push(`compaction summarySeq ${c.summarySeq} is not a compaction summary message`);
    if (!(c.atSeq <= c.summarySeq) || !(c.windowFromSeq >= 1)) errors.push(`compaction at ${c.atSeq} has an impossible window`);
  }
  return errors;
}

function buildManifest({ sessionId, source, sourceRef, license, private: isPrivate, messages, compactions = [], extra = {} }) {
  const bytesByKind = { user: 0, assistant: 0, tool_use: 0, tool_result: 0, status: 0 };
  let humanMessages = 0;
  let toolCalls = 0;
  let estTokens = 0;
  for (const m of messages) {
    const text = messageText(m);
    bytesByKind[BYTE_KINDS[m.sender]] += Buffer.byteLength(text, 'utf8');
    estTokens += estimateTokens(text);
    if (m.sender === 'user') humanMessages += 1;
    if (m.sender === 'toolUse') toolCalls += 1;
  }
  return {
    ...extra,
    sessionId,
    source,
    sourceRef,
    license: isPrivate ? 'private' : license,
    private: Boolean(isPrivate),
    messages: messages.length,
    humanMessages,
    toolCalls,
    estTokens,
    bytesByKind,
    compactions,
    span: { from: messages[0]?.timestamp ?? null, to: messages.at(-1)?.timestamp ?? null }
  };
}

function writeSession(dir, { manifest, messages }) {
  const errors = [...validateMessages(messages), ...validateManifest(manifest, messages)];
  if (errors.length) throw new Error(`invalid session: ${errors.slice(0, 5).join('; ')}`);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'messages.jsonl'), (write) => {
    for (const m of messages) write(`${JSON.stringify(m)}\n`);
  });
  writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function loadSession(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const messages = [];
  for await (const { line, lineNo } of readJsonlLines(path.join(dir, 'messages.jsonl'))) {
    try {
      messages.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(dir)}/messages.jsonl line ${lineNo}: ${err.message}`);
    }
  }
  const errors = [...validateMessages(messages), ...validateManifest(manifest, messages)];
  if (errors.length) throw new Error(`invalid session ${manifest.sessionId}: ${errors.slice(0, 5).join('; ')}`);
  return { manifest, messages, index: new SessionIndex(messages) };
}

function sessionDir(dataRoot, id) {
  return path.join(dataRoot, 'sessions', id);
}

function listSessions(dataRoot) {
  const dir = path.join(dataRoot, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

module.exports = {
  SENDERS, SESSION_ID_RE, CHARS_PER_TOKEN,
  estimateTokens, messageText, senderLabel, renderMessage, renderMessages,
  SessionIndex, validateMessages, validateManifest, buildManifest,
  writeSession, loadSession, listSessions, sessionDir
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/history-jsonl-lines.test.js tests/longhaul-session-format.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/history/importers/jsonl-lines.js src/longhaul/files.js src/longhaul/session-format.js tests/history-jsonl-lines.test.js tests/longhaul-session-format.test.js
git commit -m "feat(longhaul): session format, manifest and a JSONL reader that splits on newline only"
```

---

## Task 3: The Claude Code importer

Pulled forward from recall H4, which later adds its IPC, UI and the other importers. It lives in `src/history/importers/` because it belongs to recall, not to LongHaul.

**Files:**
- Create: `src/history/importers/claude-code-jsonl.js`, `tests/helpers/claude-code-fixture.js`
- Test: `tests/history-importer-claude-code.test.js`

**Interfaces:**
- Consumes: `readJsonlLines` (Task 2).
- Produces: `src/history/importers/claude-code-jsonl.js` exports `{ kind: 'claude-code-jsonl', version: 1, detect(path) → Promise<boolean>, preview(path) → Promise<{ title, turns, sample }>, parse(path) → Promise<{ chat, messages, compactions, stats }>, ClaudeCodeParser }`.
  - `chat = { id: 'cc-<sessionId>', title, source: 'claude-code-jsonl', createdAt, updatedAt }`.
  - `messages`: the stored shape with `seq` dense from 1. The ids are the record `uuid`, or `<uuid>:<blockIndex>` for the second and later blocks of one record.
  - `compactions: [{ atSeq, summarySeq, windowFromSeq, windowToSeq }]`. `atSeq` is the `compact_boundary` status message, or the summary itself when no boundary preceded it. The window is every message after the previous summary, up to `atSeq - 1`.
  - `stats = { unmapped, badLines, duplicates, skipped: { [kind]: n } }`. `stats` is additive to the shared contract; H4 may ignore it.
  - Mapping (recall spec §10.2, plus what real transcripts carry):
    - `text` blocks become `user`/`assistant` messages.
    - `tool_use` becomes `toolUse` (`toolName`, `parameters`, `meta.toolUseId`).
    - `tool_result` becomes `toolResult`: `toolName` comes from the matching `tool_use` id, `result` is the rendered text, and `meta` holds `{ toolUseId, isError }`.
    - A string user content with `isCompactSummary` becomes `status` with `meta.compaction: true`.
    - `system`/`compact_boundary` becomes `status` with `meta.compactBoundary`.
    - A user record with `isMeta` (harness-injected text) becomes `status` with `meta.claudeCode.isMeta`, so `askAtSeq` can never land on it.
    - `thinking`/`redacted_thinking` blocks, image blocks, `isSidechain` records, other `system` subtypes and the known bookkeeping types are skipped and counted.
    - An unknown record type or content block is kept as `status` with `meta.unmapped: true`, the raw JSON capped at 4,000 characters (`meta.raw`, `meta.rawChars`), and counted in `unmapped`.
    - A line that is not JSON is counted in `badLines`. A repeated `uuid` is counted in `duplicates` and dropped.
    - Files under a `subagents` directory, or whose first conversation record is a sidechain, fail `detect`, and `parse` throws `code: 'SUBAGENT_FILE'` for a `subagents` path.

- [ ] **Step 1: Write the synthetic transcript helper**

Create `tests/helpers/claude-code-fixture.js`:

```js
// tests/helpers/claude-code-fixture.js
// A synthetic Claude Code session transcript. Every value is invented. It
// has two compactions, the bookkeeping record types a real transcript
// carries, and the awkward cases: a duplicated record, a corrupt line, a
// U+2028 inside a string, a sidechain record, an unknown record type and an
// unknown content block. Record shapes follow Claude Code's JSONL; no real
// transcript content is used.
const fs = require('fs');
const path = require('path');

const SESSION = 'sess-fixture-1';
const ts = (minute) => new Date(Date.UTC(2026, 0, 5, 10, minute)).toISOString();
const common = (uuid, minute) => ({
  uuid, timestamp: ts(minute), sessionId: SESSION, isSidechain: false,
  userType: 'external', cwd: '/srv/<project>', version: '2.0.0'
});
const user = (uuid, minute, content, extra = {}) => ({
  ...common(uuid, minute), parentUuid: null, type: 'user', message: { role: 'user', content }, ...extra
});
const assistant = (uuid, minute, content, extra = {}) => ({
  ...common(uuid, minute), parentUuid: null, type: 'assistant',
  message: { model: 'model-x', id: `msg_${uuid}`, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
  ...extra
});

const LINE_SEPARATOR_TEXT = 'Now switch the build host to build-7.example.com. Keep the old one as a fallback.';

function claudeCodeRecords() {
  const u4 = user('u-4', 12, LINE_SEPARATOR_TEXT);
  return [
    { type: 'bridge-session', sessionId: SESSION, lastSequenceNum: 1 },
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(0), sessionId: SESSION },
    { ...common('att-1', 0), type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart', stdout: 'ok', exitCode: 0 } },
    user('u-1', 1, [{ type: 'text', text: 'Set the staging port to 18431 please.' }]),
    assistant('a-1', 2, [{ type: 'thinking', thinking: '', signature: 'sig-invented' }]),
    assistant('a-2', 2, [{ type: 'text', text: 'Setting the staging port to 18431.' }]),
    assistant('a-3', 3, [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'grep -n port config/staging.yaml' } }]),
    user('u-2', 3, [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '12:port: 18431' }], { toolUseResult: { stdout: '12:port: 18431' } }),
    { type: 'ai-title', aiTitle: 'Staging port setup', sessionId: SESSION },
    { ...common('b-1', 4), parentUuid: null, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 1200, postTokens: 300 } },
    user('c-1', 4, 'Summary: the staging port was set to 18431.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('u-3', 5, 'Caveat: the messages below were generated by a local command.', { isMeta: true }),
    u4,
    u4,
    '{"type":"user","uuid":"u-bad","message":{"role":"user","content":"cut off mid-wri',
    assistant('a-4', 13, [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/srv/<project>/build.yaml' } }]),
    user('u-5', 13, [{ type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'host: build-7.example.com' }], is_error: false }]),
    assistant('a-5', 14, [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'build host' } }]),
    { ...common('m-1', 14), type: 'mystery-record', payload: { a: 1 } },
    assistant('a-6', 15, [{ type: 'text', text: 'Subagent chatter.' }], { isSidechain: true }),
    { ...common('b-2', 16), parentUuid: null, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 900, postTokens: 250 } },
    user('c-2', 16, 'Summary: the build host is build-7.example.com.', { isCompactSummary: true }),
    user('u-6', 17, [{ type: 'text', text: 'Thanks, that is all.' }]),
    { ...common('s-1', 17), type: 'system', subtype: 'turn_duration', durationMs: 1200 }
  ];
}

// Records are objects (written with JSON.stringify, which leaves U+2028 raw)
// or strings written as-is (a corrupt line).
function writeClaudeCodeFixture(dir, name = 'session.jsonl', { records = claudeCodeRecords(), trailingNewline = true } = {}) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  fs.writeFileSync(file, trailingNewline ? `${body}\n` : body);
  return file;
}

module.exports = { SESSION, LINE_SEPARATOR_TEXT, ts, common, user, assistant, claudeCodeRecords, writeClaudeCodeFixture };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/history-importer-claude-code.test.js`:

```js
// tests/history-importer-claude-code.test.js
// The claude-code-jsonl importer (recall spec §10.2; LongHaul spec §4, §14, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const importer = require('../src/history/importers/claude-code-jsonl');
const { tmpDir } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

describe('claude-code-jsonl parse', () => {
  it('maps the transcript to messages in order, with dense seqs', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages.map((m) => m.sender), [
      'user', 'assistant', 'toolUse', 'toolResult', 'status', 'status', 'status', 'user',
      'toolUse', 'toolResult', 'status', 'status', 'status', 'status', 'user'
    ]);
    assert.deepStrictEqual(messages.map((m) => m.seq), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepStrictEqual(messages.map((m) => m.id).slice(0, 4), ['u-1', 'a-2', 'a-3', 'u-2']);
    assert.strictEqual(messages[0].text, 'Set the staging port to 18431 please.');
    assert.strictEqual(messages[0].timestamp, cc.ts(1));
  });

  it('keeps tool calls and results with their tool names', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages[2], {
      id: 'a-3', seq: 3, timestamp: cc.ts(3), sender: 'toolUse', toolName: 'Bash',
      parameters: { command: 'grep -n port config/staging.yaml' }, meta: { toolUseId: 'toolu_01' }
    });
    assert.strictEqual(messages[3].toolName, 'Bash');
    assert.strictEqual(messages[3].result, '12:port: 18431');
    assert.deepStrictEqual(messages[3].meta, { toolUseId: 'toolu_01', isError: false });
    assert.strictEqual(messages[9].toolName, 'Read');
    assert.strictEqual(messages[9].result, 'host: build-7.example.com');
  });

  it('records both compactions with their windows', async () => {
    const { messages, compactions } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(compactions, [
      { atSeq: 5, summarySeq: 6, windowFromSeq: 1, windowToSeq: 4 },
      { atSeq: 13, summarySeq: 14, windowFromSeq: 7, windowToSeq: 12 }
    ]);
    assert.deepStrictEqual(messages[5].meta, { compaction: true });
    assert.strictEqual(messages[5].text, 'Summary: the staging port was set to 18431.');
    assert.deepStrictEqual(messages[4].meta, { compactBoundary: { trigger: 'manual', preTokens: 1200, postTokens: 300 } });
  });

  it('turns harness-injected isMeta text into a status message', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages[6].meta, { claudeCode: { isMeta: true } });
  });

  it('keeps a U+2028 inside one message', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(messages[7].text, cc.LINE_SEPARATOR_TEXT);
  });

  it('counts corrupt lines, duplicates, unmapped and skipped records, and keeps unmapped ones as status', async () => {
    const { messages, stats } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(stats.badLines, 1);
    assert.strictEqual(stats.duplicates, 1);
    assert.strictEqual(stats.unmapped, 2);
    assert.deepStrictEqual(stats.skipped, {
      'bridge-session': 1, 'queue-operation': 1, attachment: 1, thinking: 1,
      'ai-title': 1, sidechain: 1, 'system:turn_duration': 1
    });
    assert.strictEqual(messages[10].text, '[unmapped assistant:server_tool_use]');
    assert.match(messages[10].meta.raw, /server_tool_use/);
    assert.strictEqual(messages[11].text, '[unmapped mystery-record]');
    assert.strictEqual(messages[11].meta.unmapped, true);
  });

  it('builds the chat from the session id and the title record', async () => {
    const { chat } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(chat, {
      id: 'cc-sess-fixture-1', title: 'Staging port setup', source: 'claude-code-jsonl',
      createdAt: cc.ts(1), updatedAt: cc.ts(17)
    });
  });

  it('counts a cut-off last line and keeps everything before it', async () => {
    const records = [cc.user('u-1', 1, 'hello there'), '{"type":"assistant","uuid":"a-x"'];
    const { messages, stats } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'cut.jsonl', { records, trailingNewline: false }));
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(stats.badLines, 1);
  });

  it('reads a 3 MB tool result intact', async () => {
    const big = 'z'.repeat(3_000_000);
    const records = [
      cc.user('u-1', 1, 'read it'),
      cc.assistant('a-1', 2, [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: 'big.txt' } }]),
      cc.user('u-2', 3, [{ type: 'tool_result', tool_use_id: 'toolu_9', content: big }])
    ];
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'big.jsonl', { records }));
    assert.strictEqual(messages[2].result.length, 3_000_000);
  });

  it('caps the raw JSON kept for an unmapped record', async () => {
    const records = [cc.user('u-1', 1, 'hi'), { ...cc.common('m-2', 2), type: 'mystery-record', payload: 'q'.repeat(10000) }];
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'raw.jsonl', { records }));
    assert.ok(messages[1].meta.rawChars > 10000);
    assert.ok(messages[1].meta.raw.length <= 4001);
  });
});

describe('claude-code-jsonl detect and preview', () => {
  it('detects a session transcript', async () => {
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(tmpDir())), true);
  });

  it('rejects other files, subagent transcripts and sidechain-only files', async () => {
    const dir = tmpDir();
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'notes.txt')), false);
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, path.join('subagents', 'agent-a1.jsonl'))), false);
    const side = [cc.user('s-1', 1, 'task for the agent', { isSidechain: true, agentId: 'a1' })];
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'side.jsonl', { records: side })), false);
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'other.jsonl', { records: [{ hello: 'world' }] })), false);
  });

  it('refuses to parse a subagent transcript', async () => {
    const file = cc.writeClaudeCodeFixture(tmpDir(), path.join('subagents', 'agent-a1.jsonl'));
    await assert.rejects(importer.parse(file), (err) => err.code === 'SUBAGENT_FILE');
  });

  it('previews the title, user turns and the first messages', async () => {
    const p = await importer.preview(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(p.title, 'Staging port setup');
    assert.strictEqual(p.turns, 3);
    assert.deepStrictEqual(p.sample.map((s) => s.seq), [1, 2, 8, 15]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/history-importer-claude-code.test.js`
Expected: FAIL with `Cannot find module '../src/history/importers/claude-code-jsonl'`.

- [ ] **Step 4: Write `src/history/importers/claude-code-jsonl.js`**

```js
'use strict';
// Claude Code session transcripts → a chat in the stored message shape
// (recall spec §10.2), with compaction events (LongHaul spec §4) and the
// unmapped-record rule (LongHaul spec §15). Streams the file: sessions reach
// tens of megabytes. Claude Code writes one content block per record, so one
// assistant turn arrives as several records (thinking, text, tool_use).
const path = require('path');
const { readJsonlLines } = require('./jsonl-lines');

const KIND = 'claude-code-jsonl';
const VERSION = 1;
const RAW_MAX_CHARS = 4000;
// Harness bookkeeping that carries no conversation.
const SKIPPED_TYPES = new Set([
  'attachment', 'bridge-session', 'queue-operation', 'file-history-snapshot', 'file-history-delta',
  'atis-latch', 'last-prompt', 'ai-title', 'custom-title', 'summary', 'pr-link', 'mode', 'cost-state'
]);

function isSubagentPath(filePath) {
  return path.resolve(filePath).split(/[\\/]/).includes('subagents');
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b && b.type === 'text') return String(b.text ?? '');
      if (b && b.type === 'image') return '[image]';
      return JSON.stringify(b);
    }).join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content, null, 2);
}

class ClaudeCodeParser {
  constructor() {
    this.messages = [];
    this.compactions = [];
    this.stats = { unmapped: 0, badLines: 0, duplicates: 0, skipped: {} };
    this.seenUuids = new Set();
    this.toolNames = new Map();
    this.lastSummarySeq = 0;
    this.pendingBoundarySeq = null;
    this.sessionId = null;
    this.title = null;
    this.customTitle = null;
    this.firstUserText = null;
    this.lastTimestamp = null;
    this.lineNo = 0;
  }

  skip(kind) {
    this.stats.skipped[kind] = (this.stats.skipped[kind] || 0) + 1;
  }

  push(rec, blockIndex, fields) {
    const seq = this.messages.length + 1;
    const base = typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : `line-${this.lineNo}`;
    const id = blockIndex === 0 ? base : `${base}:${blockIndex}`;
    const valid = typeof rec.timestamp === 'string' && !Number.isNaN(Date.parse(rec.timestamp));
    const timestamp = valid ? rec.timestamp : (this.lastTimestamp || new Date(0).toISOString());
    this.lastTimestamp = timestamp;
    this.messages.push({ id, seq, timestamp, ...fields });
    return seq;
  }

  line(line, lineNo) {
    this.lineNo = lineNo;
    let rec;
    try { rec = JSON.parse(line); } catch { this.stats.badLines += 1; return; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { this.stats.badLines += 1; return; }
    if (typeof rec.uuid === 'string') {
      if (this.seenUuids.has(rec.uuid)) { this.stats.duplicates += 1; return; }
      this.seenUuids.add(rec.uuid);
    }
    if (!this.sessionId && typeof rec.sessionId === 'string') this.sessionId = rec.sessionId;
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') this.title = rec.aiTitle;
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') this.customTitle = rec.customTitle;
    if (rec.isSidechain === true) { this.skip('sidechain'); return; }
    if (rec.type === 'user') { this.user(rec); return; }
    if (rec.type === 'assistant') { this.assistant(rec); return; }
    if (rec.type === 'system') { this.system(rec); return; }
    if (SKIPPED_TYPES.has(rec.type)) { this.skip(rec.type); return; }
    this.unmapped(rec, 0, String(rec.type ?? 'record'), rec);
  }

  unmapped(rec, blockIndex, rawType, raw) {
    const json = JSON.stringify(raw) ?? '';
    this.stats.unmapped += 1;
    this.push(rec, blockIndex, {
      sender: 'status',
      text: `[unmapped ${rawType}]`,
      meta: { unmapped: true, rawType, raw: truncate(json, RAW_MAX_CHARS), rawChars: json.length }
    });
  }

  system(rec) {
    if (rec.subtype !== 'compact_boundary') { this.skip(`system:${rec.subtype || 'unknown'}`); return; }
    const m = rec.compactMetadata || {};
    this.pendingBoundarySeq = this.push(rec, 0, {
      sender: 'status',
      text: '[compaction boundary]',
      meta: { compactBoundary: { trigger: m.trigger ?? null, preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null } }
    });
  }

  user(rec) {
    const content = rec.message?.content;
    if (typeof content === 'string') {
      if (rec.isCompactSummary === true) this.summary(rec, content);
      else this.userText(rec, 0, content);
      return;
    }
    if (!Array.isArray(content)) { this.unmapped(rec, 0, 'user', rec); return; }
    content.forEach((block, i) => {
      if (block?.type === 'text') this.userText(rec, i, String(block.text ?? ''));
      else if (block?.type === 'tool_result') {
        this.push(rec, i, {
          sender: 'toolResult',
          toolName: this.toolNames.get(block.tool_use_id) || 'unknown',
          result: toolResultText(block.content),
          meta: { toolUseId: block.tool_use_id ?? null, isError: block.is_error === true }
        });
      } else if (block?.type === 'image') this.skip('image');
      else this.unmapped(rec, i, `user:${block?.type ?? typeof block}`, block);
    });
  }

  userText(rec, i, text) {
    if (rec.isMeta === true) {
      this.push(rec, i, { sender: 'status', text, meta: { claudeCode: { isMeta: true } } });
      return;
    }
    if (this.firstUserText === null && text.trim()) this.firstUserText = text.trim();
    this.push(rec, i, { sender: 'user', text });
  }

  summary(rec, text) {
    const summarySeq = this.push(rec, 0, { sender: 'status', text, meta: { compaction: true } });
    const atSeq = this.pendingBoundarySeq ?? summarySeq;
    this.compactions.push({ atSeq, summarySeq, windowFromSeq: this.lastSummarySeq + 1, windowToSeq: atSeq - 1 });
    this.lastSummarySeq = summarySeq;
    this.pendingBoundarySeq = null;
  }

  assistant(rec) {
    const content = rec.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) this.push(rec, 0, { sender: 'assistant', text: content });
      else this.skip('empty-text');
      return;
    }
    if (!Array.isArray(content)) { this.unmapped(rec, 0, 'assistant', rec); return; }
    content.forEach((block, i) => {
      if (block?.type === 'text') {
        const text = String(block.text ?? '');
        if (text.trim()) this.push(rec, i, { sender: 'assistant', text });
        else this.skip('empty-text');
      } else if (block?.type === 'tool_use') {
        this.toolNames.set(block.id, String(block.name ?? 'unknown'));
        this.push(rec, i, {
          sender: 'toolUse',
          toolName: String(block.name ?? 'unknown'),
          parameters: block.input ?? {},
          meta: { toolUseId: block.id ?? null }
        });
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') this.skip('thinking');
      else this.unmapped(rec, i, `assistant:${block?.type ?? typeof block}`, block);
    });
  }

  result(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const title = this.customTitle || this.title || (this.firstUserText ? this.firstUserText.slice(0, 60) : base);
    return {
      chat: {
        id: `cc-${this.sessionId || base}`,
        title,
        source: KIND,
        createdAt: this.messages[0]?.timestamp ?? null,
        updatedAt: this.messages.at(-1)?.timestamp ?? null
      },
      messages: this.messages,
      compactions: this.compactions,
      stats: this.stats
    };
  }
}

async function detect(filePath) {
  if (!/\.jsonl$/i.test(filePath) || isSubagentPath(filePath)) return false;
  let seen = 0;
  try {
    for await (const { line } of readJsonlLines(filePath)) {
      seen += 1;
      if (seen > 200) return false;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || (rec.type !== 'user' && rec.type !== 'assistant') || !rec.message || rec.message.content === undefined) continue;
      return rec.isSidechain !== true && !rec.agentId;
    }
  } catch {
    return false;
  }
  return false;
}

async function parse(filePath) {
  if (isSubagentPath(filePath)) {
    const err = new Error(`${path.basename(filePath)} is a subagent transcript; subagent files are not imported`);
    err.code = 'SUBAGENT_FILE';
    throw err;
  }
  const parser = new ClaudeCodeParser();
  for await (const { line, lineNo } of readJsonlLines(filePath)) parser.line(line, lineNo);
  return parser.result(filePath);
}

async function preview(filePath) {
  const { chat, messages } = await parse(filePath);
  return {
    title: chat.title,
    turns: messages.filter((m) => m.sender === 'user').length,
    sample: messages
      .filter((m) => m.sender === 'user' || m.sender === 'assistant')
      .slice(0, 5)
      .map((m) => ({ seq: m.seq, sender: m.sender, text: m.text.slice(0, 200) }))
  };
}

module.exports = { kind: KIND, version: VERSION, detect, preview, parse, ClaudeCodeParser };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/history-importer-claude-code.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/history/importers/claude-code-jsonl.js tests/helpers/claude-code-fixture.js tests/history-importer-claude-code.test.js
git commit -m "feat(history): Claude Code JSONL importer with compaction events, streamed"
```

---

## Task 4: Question format and validator

**Files:**
- Create: `src/longhaul/questions.js`
- Test: `tests/longhaul-questions.test.js`

**Interfaces:**
- Consumes: `SessionIndex`, `readJsonlLines`, `writeFileAtomic` (Task 2).
- Produces: `src/longhaul/questions.js`:
  - `KINDS`, `BUCKETS` (`[{ id, min, max }]`), `NO_BUCKET = 'none'`, and `VERIFIED_BY_RE = /^(human:[A-Za-z0-9._-]{1,32}|synthetic)$/`. `synthetic` marks generator questions that are correct by construction (Task 6).
  - `bucketFor(distance|null) → id` and `computeDistance(index, q) → { messages, estTokens } | null`.
  - `isVerified(q) → boolean`.
  - `validateQuestion(q, { index, sessionId }) → string[]`. Each error is `"<code>: <detail>"`. The codes are `id`, `session`, `kind`, `question`, `answer`, `acceptable-answers`, `authored-by`, `verified-by`, `askAtSeq-range`, `askAtSeq-not-user`, `evidence-type`, `evidence-duplicate`, `evidence-after-ask`, `evidence-range`, `abstain-evidence`, `evidence-count`, `evidence-sender`, `superseded-by` and `distance-mismatch`.
  - `validateQuestionSet(questions, ctx) → [{ id, errors }]`, which also flags `duplicate-id`.
  - `normalizeQuestion(q, index) → question`, with the spec's key order, sorted evidence and computed distance.
  - `readQuestions(file) → Promise<question[]>` (`[]` when the file is missing), `writeQuestions(file, questions)` and `questionsFile(dataRoot, sessionId)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-questions.test.js`:

```js
// tests/longhaul-questions.test.js
// Every validity constraint of benchmark spec §5, including the rejections.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SessionIndex } = require('../src/longhaul/session-format');
const q = require('../src/longhaul/questions');
const { tmpDir } = require('./helpers/longhaul-helpers');

// 12 messages; each text is 40 characters (10 tokens), the tool call 8 tokens.
const SENDERS = ['user', 'assistant', 'toolUse', 'toolResult', 'user', 'assistant', 'user', 'assistant', 'user', 'status', 'user', 'assistant'];
function tiny() {
  const messages = SENDERS.map((sender, i) => ({
    id: `t-${i + 1}`, seq: i + 1, sender, timestamp: new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString(),
    ...(sender === 'toolUse' ? { toolName: 'Bash', parameters: { command: 'x'.repeat(10) } }
      : sender === 'toolResult' ? { toolName: 'Bash', result: 'r'.repeat(40) } : { text: 't'.repeat(40) })
  }));
  return new SessionIndex(messages);
}
const index = tiny();
const ctx = { index, sessionId: 'T' };
const base = (over = {}) => ({
  id: 'T-1', sessionId: 'T', askAtSeq: 11, kind: 'user-said', question: 'What was said?', answer: 'it',
  acceptableAnswers: [], evidenceSeqs: [5], supersededBy: null, authoredBy: 'generated', verifiedBy: null, notes: '', ...over
});
const codes = (question) => q.validateQuestion(question, ctx).map((e) => e.split(':')[0]);

describe('valid questions of every kind', () => {
  for (const good of [
    base(),
    base({ kind: 'tool-observed', askAtSeq: 7, evidenceSeqs: [4] }),
    base({ kind: 'decision', askAtSeq: 9, evidenceSeqs: [6] }),
    base({ kind: 'superseded', evidenceSeqs: [1, 5], supersededBy: 12 }),
    base({ kind: 'multi-hop', evidenceSeqs: [2, 7] }),
    base({ kind: 'abstain', askAtSeq: 9, evidenceSeqs: [], answer: 'not in the session' }),
    base({ verifiedBy: 'human:SB' }),
    base({ verifiedBy: 'synthetic' })
  ]) {
    it(`accepts ${good.kind} (${good.verifiedBy})`, () => assert.deepStrictEqual(q.validateQuestion(good, ctx), []));
  }
});

describe('rejections', () => {
  const cases = [
    ['askAtSeq-not-user', base({ askAtSeq: 12 })],
    ['askAtSeq-range', base({ askAtSeq: 13 })],
    ['evidence-after-ask', base({ evidenceSeqs: [11] })],
    ['evidence-sender', base({ evidenceSeqs: [2] })],
    ['evidence-sender', base({ kind: 'tool-observed', askAtSeq: 7, evidenceSeqs: [5] })],
    ['evidence-sender', base({ kind: 'decision', evidenceSeqs: [10] })],
    ['evidence-count', base({ kind: 'superseded', evidenceSeqs: [5] })],
    ['evidence-count', base({ kind: 'multi-hop', evidenceSeqs: [2] })],
    ['evidence-count', base({ evidenceSeqs: [] })],
    ['abstain-evidence', base({ kind: 'abstain', evidenceSeqs: [5] })],
    ['evidence-duplicate', base({ kind: 'superseded', evidenceSeqs: [5, 5] })],
    ['evidence-type', base({ evidenceSeqs: ['5'] })],
    ['superseded-by', base({ kind: 'decision', evidenceSeqs: [6], supersededBy: 12 })],
    ['superseded-by', base({ kind: 'superseded', evidenceSeqs: [1, 5], supersededBy: 10 })],
    ['distance-mismatch', base({ distance: { messages: 99, estTokens: 48 } })],
    ['kind', base({ kind: 'guess' })],
    ['verified-by', base({ verifiedBy: 'bob' })],
    ['session', base({ sessionId: 'other' })],
    ['question', base({ question: '  ' })],
    ['authored-by', base({ authoredBy: 'model' })],
    ['acceptable-answers', base({ acceptableAnswers: [''] })]
  ];
  for (const [code, question] of cases) {
    it(`flags ${code} (${JSON.stringify(question).slice(0, 80)})`, () => assert.ok(codes(question).includes(code), codes(question).join(', ')));
  }

  it('flags duplicate ids in a set', () => {
    const problems = q.validateQuestionSet([base(), base()], ctx);
    assert.deepStrictEqual(problems, [{ id: 'T-1', errors: ['duplicate-id: T-1 appears more than once'] }]);
  });
});

describe('distance', () => {
  it('is measured from the nearest evidence, in messages and in tokens strictly between', () => {
    assert.deepStrictEqual(q.computeDistance(index, base()), { messages: 6, estTokens: 50 });
    assert.deepStrictEqual(q.computeDistance(index, base({ kind: 'multi-hop', evidenceSeqs: [2, 7] })), { messages: 4, estTokens: 30 });
    assert.strictEqual(q.computeDistance(index, base({ kind: 'abstain', evidenceSeqs: [] })), null);
  });

  it('accepts a stored distance that matches, whatever its key order', () => {
    assert.deepStrictEqual(q.validateQuestion(base({ distance: { estTokens: 50, messages: 6 } }), ctx), []);
  });

  it('buckets by estimated tokens', () => {
    assert.strictEqual(q.bucketFor({ estTokens: 9999 }), '<10K');
    assert.strictEqual(q.bucketFor({ estTokens: 10000 }), '10K-50K');
    assert.strictEqual(q.bucketFor({ estTokens: 50000 }), '50K-200K');
    assert.strictEqual(q.bucketFor({ estTokens: 999999 }), '200K-1M');
    assert.strictEqual(q.bucketFor({ estTokens: 1000000 }), '>1M');
    assert.strictEqual(q.bucketFor(null), 'none');
  });
});

describe('normalize, verified and files', () => {
  it('normalizes to the spec key order with sorted evidence and the computed distance', () => {
    const n = q.normalizeQuestion(base({ kind: 'multi-hop', evidenceSeqs: [7, 2], notes: undefined, acceptableAnswers: undefined }), index);
    assert.deepStrictEqual(Object.keys(n), ['id', 'sessionId', 'askAtSeq', 'kind', 'question', 'answer', 'acceptableAnswers', 'evidenceSeqs', 'supersededBy', 'distance', 'authoredBy', 'verifiedBy', 'notes']);
    assert.deepStrictEqual(n.evidenceSeqs, [2, 7]);
    assert.deepStrictEqual(n.distance, { messages: 4, estTokens: 30 });
    assert.deepStrictEqual(n.acceptableAnswers, []);
    assert.strictEqual(n.notes, '');
  });

  it('tells verified from unverified', () => {
    assert.strictEqual(q.isVerified(base()), false);
    assert.strictEqual(q.isVerified(base({ verifiedBy: 'human:SB' })), true);
    assert.strictEqual(q.isVerified(base({ verifiedBy: 'synthetic' })), true);
  });

  it('writes and reads a question file; a missing file is empty', async () => {
    const root = tmpDir();
    const file = q.questionsFile(root, 'T');
    assert.strictEqual(file, path.join(root, 'questions', 'T.jsonl'));
    assert.deepStrictEqual(await q.readQuestions(file), []);
    q.writeQuestions(file, [base(), base({ id: 'T-2' })]);
    assert.deepStrictEqual((await q.readQuestions(file)).map((x) => x.id), ['T-1', 'T-2']);
  });
});
```

The tokens check: `computeDistance(base())` covers seqs 6 to 10, five messages of 10 tokens each, so 50. For multi-hop `[2, 7]`, the nearest evidence is 7 and seqs 8 to 10 give 30.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-questions.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/questions'`.

- [ ] **Step 3: Write `src/longhaul/questions.js`**

```js
'use strict';
// LongHaul's question format and validator (benchmark spec §5). Distance is
// computed from the session, never typed: from the nearest evidence message
// to askAtSeq, in messages and in estimated tokens strictly between.
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../history/importers/jsonl-lines');
const { writeFileAtomic } = require('./files');

const KINDS = Object.freeze(['user-said', 'tool-observed', 'decision', 'superseded', 'multi-hop', 'abstain']);
const BUCKETS = Object.freeze([
  { id: '<10K', min: 0, max: 10000 },
  { id: '10K-50K', min: 10000, max: 50000 },
  { id: '50K-200K', min: 50000, max: 200000 },
  { id: '200K-1M', min: 200000, max: 1000000 },
  { id: '>1M', min: 1000000, max: Infinity }
]);
const NO_BUCKET = 'none';
const AUTHORED_BY = Object.freeze(['generated', 'human']);
const VERIFIED_BY_RE = /^(human:[A-Za-z0-9._-]{1,32}|synthetic)$/;
const EVIDENCE_SENDERS = Object.freeze({ 'user-said': ['user'], 'tool-observed': ['toolResult'], decision: ['assistant', 'user'] });
const MIN_EVIDENCE = Object.freeze({ 'user-said': 1, 'tool-observed': 1, decision: 1, superseded: 2, 'multi-hop': 2, abstain: 0 });

function bucketFor(distance) {
  if (!distance) return NO_BUCKET;
  return BUCKETS.find((b) => distance.estTokens >= b.min && distance.estTokens < b.max).id;
}

function computeDistance(index, question) {
  const seqs = Array.isArray(question.evidenceSeqs) ? question.evidenceSeqs : [];
  if (seqs.length === 0) return null;
  const nearest = Math.max(...seqs);
  return { messages: question.askAtSeq - nearest, estTokens: index.tokensBetween(nearest, question.askAtSeq) };
}

function isVerified(question) {
  return typeof question.verifiedBy === 'string' && VERIFIED_BY_RE.test(question.verifiedBy);
}

function validateQuestion(q, { index, sessionId }) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return ['not-an-object: the question is not a JSON object'];
  const errors = [];
  const add = (code, detail) => errors.push(`${code}: ${detail}`);

  if (typeof q.id !== 'string' || !q.id.trim()) add('id', 'missing id');
  if (q.sessionId !== sessionId) add('session', `sessionId ${JSON.stringify(q.sessionId)} is not ${sessionId}`);
  if (!KINDS.includes(q.kind)) add('kind', `unknown kind ${JSON.stringify(q.kind)}`);
  if (typeof q.question !== 'string' || !q.question.trim()) add('question', 'the question is empty');
  if (typeof q.answer !== 'string' || !q.answer.trim()) add('answer', 'the answer is empty');
  if (q.acceptableAnswers !== undefined && (!Array.isArray(q.acceptableAnswers) || q.acceptableAnswers.some((a) => typeof a !== 'string' || !a.trim()))) {
    add('acceptable-answers', 'acceptableAnswers must be non-empty strings');
  }
  if (!AUTHORED_BY.includes(q.authoredBy)) add('authored-by', `authoredBy must be ${AUTHORED_BY.join(' or ')}`);
  if (q.verifiedBy !== null && !isVerified(q)) add('verified-by', 'verifiedBy must be null, "human:<initials>" or "synthetic"');

  const at = index.get(q.askAtSeq);
  if (!at) add('askAtSeq-range', `askAtSeq ${q.askAtSeq} is not a message of the session (1..${index.maxSeq})`);
  else if (at.sender !== 'user') add('askAtSeq-not-user', `message #${q.askAtSeq} is a ${at.sender} message; askAtSeq must point at a user message`);

  const ev = q.evidenceSeqs;
  if (!Array.isArray(ev) || ev.some((s) => !Number.isInteger(s))) {
    add('evidence-type', 'evidenceSeqs must be an array of whole numbers');
  } else {
    if (new Set(ev).size !== ev.length) add('evidence-duplicate', 'evidenceSeqs repeats a seq');
    for (const s of ev) {
      if (Number.isInteger(q.askAtSeq) && s >= q.askAtSeq) add('evidence-after-ask', `evidence #${s} is not before askAtSeq ${q.askAtSeq}`);
      else if (!index.get(s)) add('evidence-range', `evidence #${s} is not a message of the session`);
    }
    if (KINDS.includes(q.kind)) {
      if (q.kind === 'abstain' && ev.length > 0) add('abstain-evidence', 'an abstain question has no evidence');
      else if (ev.length < MIN_EVIDENCE[q.kind]) add('evidence-count', `${q.kind} needs at least ${MIN_EVIDENCE[q.kind]} evidence seqs, has ${ev.length}`);
      const allowed = EVIDENCE_SENDERS[q.kind];
      if (allowed) {
        for (const s of ev) {
          const m = index.get(s);
          if (m && s < q.askAtSeq && !allowed.includes(m.sender)) add('evidence-sender', `${q.kind} evidence #${s} is a ${m.sender} message; expected ${allowed.join(' or ')}`);
        }
      }
    }
  }

  if (q.supersededBy !== null && q.supersededBy !== undefined) {
    if (q.kind !== 'superseded') add('superseded-by', 'only a superseded question names supersededBy');
    else if (!Number.isInteger(q.supersededBy) || q.supersededBy <= q.askAtSeq || !index.get(q.supersededBy)) {
      add('superseded-by', `supersededBy must be a message after askAtSeq ${q.askAtSeq}`);
    }
  }

  if (errors.length === 0 && q.distance !== undefined) {
    const computed = computeDistance(index, q);
    const same = computed === null
      ? q.distance === null
      : Boolean(q.distance) && q.distance.messages === computed.messages && q.distance.estTokens === computed.estTokens;
    if (!same) add('distance-mismatch', `stored ${JSON.stringify(q.distance)}, computed ${JSON.stringify(computed)}; distance is computed, never typed`);
  }
  return errors;
}

function validateQuestionSet(questions, ctx) {
  const problems = [];
  const seen = new Set();
  for (const question of questions) {
    const errors = validateQuestion(question, ctx);
    const id = question?.id ?? '(no id)';
    if (seen.has(id)) errors.push(`duplicate-id: ${id} appears more than once`);
    seen.add(id);
    if (errors.length) problems.push({ id, errors });
  }
  return problems;
}

function normalizeQuestion(q, index) {
  return {
    id: q.id,
    sessionId: q.sessionId,
    askAtSeq: q.askAtSeq,
    kind: q.kind,
    question: q.question,
    answer: q.answer,
    acceptableAnswers: Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : [],
    evidenceSeqs: [...q.evidenceSeqs].sort((a, b) => a - b),
    supersededBy: q.supersededBy ?? null,
    distance: computeDistance(index, q),
    authoredBy: q.authoredBy,
    verifiedBy: q.verifiedBy ?? null,
    notes: typeof q.notes === 'string' ? q.notes : ''
  };
}

function questionsFile(dataRoot, sessionId) {
  return path.join(dataRoot, 'questions', `${sessionId}.jsonl`);
}

async function readQuestions(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for await (const { line, lineNo } of readJsonlLines(file)) {
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(file)} line ${lineNo}: ${err.message}`);
    }
  }
  return out;
}

function writeQuestions(file, questions) {
  writeFileAtomic(file, (write) => {
    for (const question of questions) write(`${JSON.stringify(question)}\n`);
  });
}

module.exports = {
  KINDS, BUCKETS, NO_BUCKET, VERIFIED_BY_RE,
  bucketFor, computeDistance, isVerified,
  validateQuestion, validateQuestionSet, normalizeQuestion,
  questionsFile, readQuestions, writeQuestions
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/longhaul-questions.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/questions.js tests/longhaul-questions.test.js
git commit -m "feat(longhaul): question format, validator and distance buckets"
```

---

## Task 5: `longhaul import`

**Files:**
- Create: `src/longhaul/importing.js`, `src/longhaul/commands/import.js`
- Modify: `src/longhaul/cli.js` (register `import`)
- Test: `tests/longhaul-import.test.js`

**Interfaces:**
- Consumes: `claude-code-jsonl` importer (Task 3); `buildManifest`, `writeSession`, `SESSION_ID_RE` (Task 2); `sha256File`, `isInside` (Task 2); `UsageError` (Task 1).
- Produces:
  - `importSession(home, sourcePath, { id, license, publicSession = false, force = false }) → Promise<{ status: 'imported'|'unchanged', sessionId, manifest }>`.
  - The CLI command `longhaul import <file.jsonl> [--id <id>] [--public --license <spdx>] [--force]`.
  - Privacy rules:
    - A file under `LONGHAUL_HOME/private/` (after resolving links) is always private, and `--public` is refused for it.
    - Any other file is private unless `--public --license <spdx>` is given.
    - A private session's `sourceRef` is its path relative to `LONGHAUL_HOME` when it is inside it, and its bare file name otherwise; no absolute path is recorded.
  - Idempotency: re-importing the same file (same SHA-256 and privacy) returns `unchanged`. A different file under an existing id is refused unless `--force`.
  - The session id defaults to `cc-<first 12 hex of the file's SHA-256>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-import.test.js`:

```js
// tests/longhaul-import.test.js
// `longhaul import` (benchmark spec §4, §10.1): a Claude Code transcript into
// LONGHAUL_HOME/sessions/<id>/, private by default.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/longhaul/cli');
const { loadSession } = require('../src/longhaul/session-format');
const { tmpHome, tmpDir, sink } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

async function run(argv, env) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout, stderr, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('longhaul import', () => {
  it('imports a file dropped in private/ as private, with its manifest', async () => {
    const { env, root } = tmpHome();
    const file = cc.writeClaudeCodeFixture(path.join(root, 'private'), 'session-x.jsonl');
    const r = await run(['import', file, '--id', 'X'], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /imported X: 15 messages, 3 from the user, 2 tool calls, 2 compactions/);
    assert.match(r.stdout, /2 unmapped records kept as status messages, 1 unreadable lines skipped/);
    const s = await loadSession(path.join(root, 'sessions', 'X'));
    assert.strictEqual(s.manifest.private, true);
    assert.strictEqual(s.manifest.license, 'private');
    assert.strictEqual(s.manifest.sourceRef, 'private/session-x.jsonl');
    assert.strictEqual(s.manifest.source, 'claude-code-jsonl');
    assert.deepStrictEqual(s.manifest.compactions, [
      { atSeq: 5, summarySeq: 6, windowFromSeq: 1, windowToSeq: 4 },
      { atSeq: 13, summarySeq: 14, windowFromSeq: 7, windowToSeq: 12 }
    ]);
    assert.strictEqual(s.manifest.duplicates, 1);
    assert.match(s.manifest.sourceSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(s.messages[7].text, cc.LINE_SEPARATOR_TEXT);
  });

  it('keeps a file from outside private/ private unless --public --license is given', async () => {
    const { env, root } = tmpHome();
    const dir = tmpDir();
    const a = cc.writeClaudeCodeFixture(dir, 'a.jsonl');
    assert.strictEqual((await run(['import', a, '--id', 'P'], env)).code, 0);
    const p = await loadSession(path.join(root, 'sessions', 'P'));
    assert.strictEqual(p.manifest.private, true);
    assert.strictEqual(p.manifest.sourceRef, 'a.jsonl');
    const b = cc.writeClaudeCodeFixture(dir, 'b.jsonl');
    assert.strictEqual((await run(['import', b, '--id', 'Q', '--public', '--license', 'CC-BY-4.0'], env)).code, 0);
    const q = await loadSession(path.join(root, 'sessions', 'Q'));
    assert.strictEqual(q.manifest.private, false);
    assert.strictEqual(q.manifest.license, 'CC-BY-4.0');
  });

  it('refuses --public for a file in private/, --public without --license, and --license without --public', async () => {
    const { env, root } = tmpHome();
    const priv = cc.writeClaudeCodeFixture(path.join(root, 'private'), 's.jsonl');
    const r1 = await run(['import', priv, '--public', '--license', 'CC-BY-4.0'], env);
    assert.strictEqual(r1.code, 2);
    assert.match(r1.stderr, /always private/);
    const outside = cc.writeClaudeCodeFixture(tmpDir(), 'o.jsonl');
    assert.strictEqual((await run(['import', outside, '--public'], env)).code, 2);
    assert.strictEqual((await run(['import', outside, '--license', 'MIT'], env)).code, 2);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'sessions')), []);
  });

  it('names a session by its file hash when no --id is given', async () => {
    const { env, root } = tmpHome();
    const file = cc.writeClaudeCodeFixture(tmpDir(), 's.jsonl');
    assert.strictEqual((await run(['import', file], env)).code, 0);
    const [id] = fs.readdirSync(path.join(root, 'sessions'));
    assert.match(id, /^cc-[0-9a-f]{12}$/);
  });

  it('is idempotent for one file and refuses a different file under the same id without --force', async () => {
    const { env, root } = tmpHome();
    const dir = tmpDir();
    const a = cc.writeClaudeCodeFixture(dir, 'a.jsonl');
    const b = cc.writeClaudeCodeFixture(dir, 'b.jsonl', { records: cc.claudeCodeRecords().slice(0, 12) });
    assert.strictEqual((await run(['import', a, '--id', 'S'], env)).code, 0);
    const again = await run(['import', a, '--id', 'S'], env);
    assert.strictEqual(again.code, 0);
    assert.match(again.stdout, /already imported/);
    const refused = await run(['import', b, '--id', 'S'], env);
    assert.strictEqual(refused.code, 2);
    assert.match(refused.stderr, /--force/);
    const before = (await loadSession(path.join(root, 'sessions', 'S'))).manifest.sourceSha256;
    assert.strictEqual((await run(['import', b, '--id', 'S', '--force'], env)).code, 0);
    assert.notStrictEqual((await loadSession(path.join(root, 'sessions', 'S'))).manifest.sourceSha256, before);
  });

  it('refuses a subagent transcript, a file that is not a transcript, a missing file and a bad id', async () => {
    const { env } = tmpHome();
    const dir = tmpDir();
    const sub = cc.writeClaudeCodeFixture(dir, path.join('subagents', 'agent-a1.jsonl'));
    assert.strictEqual((await run(['import', sub], env)).code, 2);
    const other = cc.writeClaudeCodeFixture(dir, 'other.jsonl', { records: [{ hello: 'world' }] });
    assert.strictEqual((await run(['import', other], env)).code, 2);
    assert.strictEqual((await run(['import', path.join(dir, 'missing.jsonl')], env)).code, 2);
    const good = cc.writeClaudeCodeFixture(dir, 'good.jsonl');
    assert.strictEqual((await run(['import', good, '--id', 'a b'], env)).code, 2);
    assert.strictEqual((await run(['import'], env)).code, 2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-import.test.js`
Expected: FAIL. `main(['import', ...])` returns 2 with `Unknown command "import"`.

- [ ] **Step 3: Write `src/longhaul/importing.js`**

```js
'use strict';
// `longhaul import` (benchmark spec §4, §10.1): a Claude Code transcript into
// LONGHAUL_HOME/sessions/<id>/. Private unless the owner says --public with a
// license; a file under LONGHAUL_HOME/private/ is private whatever is passed.
// No absolute source path is recorded.
const fs = require('fs');
const path = require('path');
const claudeCode = require('../history/importers/claude-code-jsonl');
const { buildManifest, writeSession, SESSION_ID_RE } = require('./session-format');
const { sha256File, isInside } = require('./files');
const { UsageError } = require('./errors');

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

async function importSession(home, sourcePath, { id, license, publicSession = false, force = false } = {}) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new UsageError(`No such file: ${sourcePath}`);
  const real = realOrSelf(resolved);
  const rootReal = realOrSelf(home.root);
  const fromPrivate = isInside(real, realOrSelf(home.private));

  if (fromPrivate && publicSession) throw new UsageError('A session under LONGHAUL_HOME/private is always private; --public is refused.');
  if (publicSession && !(typeof license === 'string' && license.trim())) throw new UsageError('--public needs --license <spdx id>.');
  if (!publicSession && license !== undefined) throw new UsageError('--license applies only with --public; a private session is licensed "private".');
  if (!(await claudeCode.detect(real))) {
    throw new UsageError(`${path.basename(real)} is not a Claude Code session transcript (subagent transcripts are not imported).`);
  }

  const sha = await sha256File(real);
  const sessionId = id || `cc-${sha.slice(0, 12)}`;
  if (!SESSION_ID_RE.test(sessionId)) throw new UsageError(`Session id ${JSON.stringify(sessionId)} must match ${SESSION_ID_RE}.`);
  const dir = path.join(home.sessions, sessionId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (existing.sourceSha256 === sha && existing.private === !publicSession) return { status: 'unchanged', sessionId, manifest: existing };
    if (!force) {
      throw new UsageError(`Session ${sessionId} already exists from a different file or with a different privacy setting; `
        + 'pass --force to replace it (its questions are validated again at the next run).');
    }
  }

  const { chat, messages, compactions, stats } = await claudeCode.parse(real);
  if (messages.length === 0) throw new UsageError(`${path.basename(real)} has no conversation messages.`);
  const sourceRef = isInside(real, rootReal) ? path.relative(rootReal, real).split(path.sep).join('/') : path.basename(real);
  const manifest = buildManifest({
    sessionId,
    source: claudeCode.kind,
    sourceRef,
    license: publicSession ? license.trim() : 'private',
    private: !publicSession,
    messages,
    compactions,
    extra: {
      title: chat.title,
      sourceSha256: sha,
      importer: { kind: claudeCode.kind, version: claudeCode.version },
      unmapped: stats.unmapped,
      skipped: stats.skipped,
      badLines: stats.badLines,
      duplicates: stats.duplicates,
      constructed: false
    }
  });
  writeSession(dir, { manifest, messages });
  return { status: 'imported', sessionId, manifest };
}

module.exports = { importSession };
```

- [ ] **Step 4: Write `src/longhaul/commands/import.js` and register it**

```js
'use strict';
// `longhaul import <file.jsonl> [--id <id>] [--public --license <spdx>] [--force]`
const path = require('path');
const { importSession } = require('../importing');
const { UsageError } = require('../errors');

module.exports = {
  options: {
    id: { type: 'string' },
    license: { type: 'string' },
    public: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false }
  },
  async run(ctx, values, positionals) {
    if (positionals.length !== 1) {
      throw new UsageError('Usage: longhaul import <session.jsonl> [--id <id>] [--public --license <spdx>] [--force]');
    }
    const out = await importSession(ctx.home, path.resolve(ctx.cwd, positionals[0]), {
      id: values.id, license: values.license, publicSession: values.public, force: values.force
    });
    const m = out.manifest;
    if (out.status === 'unchanged') {
      ctx.stdout.write(`${m.sessionId}: already imported from this file; nothing to do.\n`);
      return 0;
    }
    ctx.stdout.write(`imported ${m.sessionId}: ${m.messages} messages, ${m.humanMessages} from the user, ${m.toolCalls} tool calls, `
      + `${m.compactions.length} compactions, ~${m.estTokens} estimated tokens (${m.private ? 'private' : m.license})\n`);
    if (m.unmapped || m.badLines) {
      ctx.stdout.write(`note: ${m.unmapped} unmapped records kept as status messages, ${m.badLines} unreadable lines skipped\n`);
    }
    return 0;
  }
};
```

In `src/longhaul/cli.js`, extend `COMMANDS`:

```js
const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import')
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/longhaul-import.test.js tests/longhaul-home.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/importing.js src/longhaul/commands/import.js src/longhaul/cli.js tests/longhaul-import.test.js
git commit -m "feat(longhaul): import a Claude Code session, private by default"
```

---

## Task 6: Synthetic generator, `longhaul synth` and the committed fixtures

**Files:**
- Create: `src/longhaul/rng.js`, `src/longhaul/synthetic.js`, `src/longhaul/commands/synth.js`
- Modify: `src/longhaul/cli.js` (register `synth`)
- Create (generated): `tests/fixtures/longhaul/sessions/{synth-small,synth-medium,synth-compacted}/{manifest.json,messages.jsonl}`, `tests/fixtures/longhaul/questions/{synth-small,synth-medium,synth-compacted}.jsonl`
- Test: `tests/longhaul-synthetic.test.js`

**Interfaces:**
- Consumes: `SessionIndex`, `buildManifest`, `writeSession`, `messageText` (Task 2); `normalizeQuestion`, `writeQuestions`, `questionsFile` (Task 4).
- Produces:
  - `src/longhaul/rng.js`: `createRng(seed) → { next() → [0,1), int(min, max) (inclusive), pick(list), shuffle(list) → new array }`.
  - `src/longhaul/synthetic.js`: `SYNTH_FIXTURES` (three configs `{ sessionId, seed, turns, resultLines, compactEvery, plan: [{ kind, distanceTokens? }] }`), `generateSynthetic(config) → { manifest, messages, questions, index }`, `writeSyntheticRoot(root, fixtures = SYNTH_FIXTURES) → [{ sessionId, messages, questions, estTokens }]`.
    - Questions carry `authoredBy: 'generated'` and `verifiedBy: 'synthetic'`. Every question's `askAtSeq` message text is the question itself.
    - Planted values: ports 18000 to 18999 (`user-said`, `tool-observed`), retry limits 100 to 999 (`superseded`), hosts `build-NN.example.com` and racks `rack-<A..H><1..9>` (`multi-hop`), and a codename per question. Filler never contains any of these.
  - CLI `longhaul synth --out <dir>` (`needsHome: false`) writes the three sessions and their questions in the data-root layout.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-synthetic.test.js`:

```js
// tests/longhaul-synthetic.test.js
// Synthetic sessions with planted facts (benchmark spec §10.3). The committed
// fixtures must equal what the generator produces.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createRng } = require('../src/longhaul/rng');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { validateMessages, validateManifest, loadSession, messageText } = require('../src/longhaul/session-format');
const { validateQuestionSet, isVerified, bucketFor, readQuestions, questionsFile } = require('../src/longhaul/questions');
const { scanForPersonalValues } = require('./helpers/example-denylist');
const { FIXTURE_ROOT, tmpDir } = require('./helpers/longhaul-helpers');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsWord = (text, word) => new RegExp(`(^|[^0-9A-Za-z-])${escape(word)}($|[^0-9A-Za-z-])`).test(text);

describe('createRng', () => {
  it('is deterministic and keeps int() inside its inclusive bounds', () => {
    const a = createRng(7);
    const b = createRng(7);
    const xs = Array.from({ length: 50 }, () => a.int(3, 5));
    assert.deepStrictEqual(xs, Array.from({ length: 50 }, () => b.int(3, 5)));
    assert.ok(xs.every((x) => x >= 3 && x <= 5));
    assert.deepStrictEqual(new Set(xs), new Set([3, 4, 5]));
    assert.deepStrictEqual(createRng(1).shuffle([1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
  });
});

describe('generateSynthetic', () => {
  it('is deterministic for a seed and changes with it', () => {
    const a = generateSynthetic(SYNTH_FIXTURES[0]);
    const b = generateSynthetic(SYNTH_FIXTURES[0]);
    assert.deepStrictEqual(a.messages, b.messages);
    assert.deepStrictEqual(a.questions, b.questions);
    assert.notDeepStrictEqual(generateSynthetic({ ...SYNTH_FIXTURES[0], seed: 12 }).messages, a.messages);
  });

  for (const config of SYNTH_FIXTURES) {
    it(`${config.sessionId}: a valid session with valid, verified questions of every planned kind`, () => {
      const { manifest, messages, questions, index } = generateSynthetic(config);
      assert.deepStrictEqual(validateMessages(messages), []);
      assert.deepStrictEqual(validateManifest(manifest, messages), []);
      assert.deepStrictEqual(validateQuestionSet(questions, { index, sessionId: config.sessionId }), []);
      assert.ok(questions.every(isVerified));
      assert.deepStrictEqual(questions.map((q) => q.kind).sort(), config.plan.map((p) => p.kind).sort());
      assert.strictEqual(manifest.private, false);
    });

    it(`${config.sessionId}: each planted answer is in its evidence and nowhere else before askAtSeq`, () => {
      const { questions, index } = generateSynthetic(config);
      for (const q of questions.filter((x) => x.kind !== 'abstain')) {
        const answer = q.acceptableAnswers[0];
        const holders = [];
        for (let s = 1; s < q.askAtSeq; s++) if (containsWord(messageText(index.get(s)), answer)) holders.push(s);
        assert.ok(holders.length > 0, `${q.id}: "${answer}" is not in the session`);
        assert.ok(holders.every((s) => q.evidenceSeqs.includes(s)), `${q.id}: "${answer}" also appears at ${holders}`);
      }
    });

    it(`${config.sessionId}: an abstain codename never appears before askAtSeq`, () => {
      const { questions, index } = generateSynthetic(config);
      for (const q of questions.filter((x) => x.kind === 'abstain')) {
        const codename = /for the (\S+) cache/.exec(q.question)[1];
        for (let s = 1; s < q.askAtSeq; s++) assert.ok(!messageText(index.get(s)).includes(codename), `${q.id}: ${codename} at #${s}`);
      }
    });

    it(`${config.sessionId}: invented values only`, () => {
      const { messages, questions } = generateSynthetic(config);
      const text = messages.map(messageText).join('\n') + JSON.stringify(questions);
      assert.deepStrictEqual(scanForPersonalValues(text), []);
    });
  }

  it('synth-compacted carries two compactions whose summaries are compaction status messages', () => {
    const config = SYNTH_FIXTURES.find((c) => c.sessionId === 'synth-compacted');
    const { manifest, index } = generateSynthetic(config);
    assert.strictEqual(manifest.compactions.length, 2);
    for (const c of manifest.compactions) assert.deepStrictEqual(index.get(c.summarySeq).meta, { compaction: true });
  });

  it('the fixtures cover three distance buckets and abstain', () => {
    const buckets = new Set(SYNTH_FIXTURES.flatMap((c) => generateSynthetic(c).questions.map((q) => bucketFor(q.distance))));
    for (const b of ['<10K', '10K-50K', '50K-200K', 'none']) assert.ok(buckets.has(b), `no question in ${b}`);
  });

  it('the committed fixtures match the generator', async () => {
    const out = tmpDir();
    writeSyntheticRoot(out);
    for (const c of SYNTH_FIXTURES) {
      const committed = await loadSession(path.join(FIXTURE_ROOT, 'sessions', c.sessionId));
      const fresh = await loadSession(path.join(out, 'sessions', c.sessionId));
      assert.deepStrictEqual(committed.manifest, fresh.manifest, `${c.sessionId} manifest drifted: run node bin/longhaul.js synth --out tests/fixtures/longhaul`);
      assert.deepStrictEqual(committed.messages, fresh.messages, `${c.sessionId} messages drifted`);
      assert.deepStrictEqual(await readQuestions(questionsFile(FIXTURE_ROOT, c.sessionId)), await readQuestions(questionsFile(out, c.sessionId)));
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-synthetic.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/rng'`.

- [ ] **Step 3: Write `src/longhaul/rng.js`**

```js
'use strict';
// Seeded RNG (mulberry32) for sampling and the synthetic generator
// (benchmark spec §11: sampling and authoring use a seeded RNG).
function createRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
    pick(list) { return list[Math.floor(next() * list.length)]; },
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  };
}

module.exports = { createRng };
```

- [ ] **Step 4: Write `src/longhaul/synthetic.js`**

```js
'use strict';
// Synthetic sessions with planted facts at controlled distances (benchmark
// spec §10.3), for CI and for sanity-checking adapters. Every value is
// invented: a codename per question from two word lists, ports 18000-18999,
// retry limits 100-999, hosts build-NN.example.com, racks rack-A1..rack-H9.
// Filler uses other words and numbers below 100, so a planted value appears
// only where it was planted. Deterministic for a seed; no clock is read.
const path = require('path');
const { createRng } = require('./rng');
const { SessionIndex, buildManifest, writeSession } = require('./session-format');
const { normalizeQuestion, writeQuestions, questionsFile } = require('./questions');

const GENERATOR_VERSION = 1;
const BASE_TIME = Date.parse('2026-01-05T09:00:00.000Z');
const STEP_MS = 37000;

const ADJECTIVES = ['amber', 'cobalt', 'copper', 'crimson', 'dusky', 'ember', 'frosted', 'gilded', 'hollow', 'ivory', 'jade',
  'lunar', 'misty', 'onyx', 'pale', 'quiet', 'rustic', 'silver', 'tidal', 'umber', 'velvet', 'woven'];
const NOUNS = ['heron', 'lynx', 'otter', 'falcon', 'marmot', 'badger', 'kestrel', 'osprey', 'wren', 'bison', 'ibis', 'newt',
  'puffin', 'raven', 'sparrow', 'tapir', 'vole', 'yak', 'zebu', 'gecko'];
const CHOICES = [
  ['SQLite', 'it needs no server'],
  ['a message queue', 'bursts must not drop jobs'],
  ['blue-green deploys', 'rollbacks must be instant'],
  ['nightly snapshots', 'restores need a known point'],
  ['a read replica', 'reports must not slow writes'],
  ['feature flags', 'the rollout is gradual']
];
const FILLER_WORDS = ['parser', 'config', 'retry', 'schema', 'handler', 'queue', 'cache', 'router', 'session', 'token',
  'index', 'bundle', 'worker', 'buffer', 'timeout', 'fixture', 'module', 'review', 'branch', 'release'];
const FILES = ['src/app/router.js', 'src/app/queue.js', 'src/app/cache.js', 'src/lib/schema.js', 'src/lib/retry.js',
  'tests/router.test.js', 'docs/notes.md'];
const COMMANDS = ['npm test', 'git status', 'git diff --stat', 'node scripts/check.js', 'ls src/app'];
const RACK_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const SYNTH_FIXTURES = Object.freeze([
  {
    sessionId: 'synth-small', seed: 11, turns: 40, resultLines: 8, compactEvery: 0,
    plan: [
      { kind: 'user-said', distanceTokens: 1500 }, { kind: 'tool-observed', distanceTokens: 3000 },
      { kind: 'decision', distanceTokens: 2000 }, { kind: 'superseded', distanceTokens: 1200 },
      { kind: 'multi-hop', distanceTokens: 1000 }, { kind: 'abstain' }
    ]
  },
  {
    sessionId: 'synth-medium', seed: 22, turns: 220, resultLines: 24, compactEvery: 0,
    plan: [
      { kind: 'user-said', distanceTokens: 55000 }, { kind: 'user-said', distanceTokens: 3000 },
      { kind: 'tool-observed', distanceTokens: 25000 }, { kind: 'tool-observed', distanceTokens: 800 },
      { kind: 'decision', distanceTokens: 40000 }, { kind: 'superseded', distanceTokens: 15000 },
      { kind: 'multi-hop', distanceTokens: 20000 }, { kind: 'abstain' }, { kind: 'abstain' }
    ]
  },
  {
    sessionId: 'synth-compacted', seed: 33, turns: 90, resultLines: 12, compactEvery: 30,
    plan: [
      { kind: 'user-said', distanceTokens: 12000 }, { kind: 'decision', distanceTokens: 9000 },
      { kind: 'tool-observed', distanceTokens: 5000 }, { kind: 'superseded', distanceTokens: 4000 },
      { kind: 'multi-hop', distanceTokens: 3000 }, { kind: 'abstain' }
    ]
  }
]);

function words(rng, min, max) {
  const n = rng.int(min, max);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rng.pick(FILLER_WORDS));
  return out.join(' ');
}
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const fillerUser = (rng) => `Can you look at the ${rng.pick(FILLER_WORDS)} ${rng.pick(FILLER_WORDS)} next? ${capitalized(words(rng, 8, 20))}.`;
const fillerAssistant = (rng) => `${capitalized(words(rng, 20, 50))}. Checking ${rng.pick(FILES)} now.`;
function fillerResult(rng, lines) {
  const out = [];
  for (let i = 1; i <= lines; i++) out.push(`ok ${i % 100} - ${words(rng, 3, 7)} (${rng.int(1, 99)} ms)`);
  return out.join('\n');
}

function valueSource(rng) {
  const used = new Set();
  const fresh = (make) => {
    for (let i = 0; i < 1000; i++) {
      const v = make();
      if (!used.has(v)) { used.add(v); return v; }
    }
    throw new Error('the synthetic generator ran out of unique values');
  };
  return {
    codename: () => fresh(() => `${rng.pick(ADJECTIVES)}-${rng.pick(NOUNS)}`),
    port: () => fresh(() => String(rng.int(18000, 18999))),
    limit: () => fresh(() => String(rng.int(100, 999))),
    host: () => fresh(() => `build-${rng.int(10, 99)}.example.com`),
    rack: () => fresh(() => `rack-${rng.pick(RACK_ROWS)}${rng.int(1, 9)}`)
  };
}

function generateSynthetic({ sessionId, seed, turns, resultLines = 12, compactEvery = 0, plan }) {
  const rng = createRng(seed);
  const messages = [];
  const compactions = [];
  let lastSummary = 0;
  const add = (fields) => {
    const seq = messages.length + 1;
    messages.push({ id: `${sessionId}-m${seq}`, seq, timestamp: new Date(BASE_TIME + seq * STEP_MS).toISOString(), ...fields });
    return seq;
  };

  for (let t = 1; t <= turns; t++) {
    add({ sender: 'user', text: fillerUser(rng) });
    add({ sender: 'assistant', text: fillerAssistant(rng) });
    add({ sender: 'toolUse', toolName: 'Bash', parameters: { command: rng.pick(COMMANDS) } });
    add({ sender: 'toolResult', toolName: 'Bash', result: fillerResult(rng, resultLines) });
    add({ sender: 'assistant', text: fillerAssistant(rng) });
    if (compactEvery && t % compactEvery === 0 && t < turns) {
      const summarySeq = add({ sender: 'status', text: `Summary of the work so far: ${words(rng, 30, 60)}.`, meta: { compaction: true } });
      compactions.push({ atSeq: summarySeq, summarySeq, windowFromSeq: lastSummary + 1, windowToSeq: summarySeq - 1 });
      lastSummary = summarySeq;
    }
  }

  const values = valueSource(rng);
  const filler = new SessionIndex(messages);
  const used = new Set();
  const askPool = rng.shuffle(filler.userSeqs.filter((s) => s > messages.length * 0.6)).slice(0, plan.length);
  if (askPool.length < plan.length) {
    throw new Error(`${sessionId}: ${plan.length} questions need ${plan.length} user messages in the last 40%; lengthen the session`);
  }
  for (const s of askPool) used.add(s);
  const setText = (seq, text) => { messages[seq - 1].text = text; };
  // The nearest free message of an allowed sender at least `tokens`
  // estimated tokens before fromSeq.
  const plantBefore = (fromSeq, tokens, senders) => {
    let seq = fromSeq - 1;
    while (seq >= 1 && filler.tokensBetween(seq, fromSeq) < tokens) seq -= 1;
    for (; seq >= 1; seq -= 1) {
      if (senders.includes(messages[seq - 1].sender) && !used.has(seq)) {
        used.add(seq);
        return seq;
      }
    }
    throw new Error(`${sessionId}: cannot place a ${senders.join('/')} fact ${tokens} tokens before #${fromSeq}; lengthen the session`);
  };

  const planted = plan.map((item, i) => {
    const askAtSeq = askPool[i];
    const codename = values.codename();
    const d = item.distanceTokens || 0;
    let fact;
    switch (item.kind) {
      case 'user-said': {
        const port = values.port();
        const e = plantBefore(askAtSeq, d, ['user']);
        setText(e, `For the record, the staging port for ${codename} is ${port}.`);
        fact = { question: `What staging port did I give for ${codename}?`, answer: port, acceptableAnswers: [port], evidenceSeqs: [e] };
        break;
      }
      case 'tool-observed': {
        const port = values.port();
        const e = plantBefore(askAtSeq, d, ['toolResult']);
        messages[e - 1].result = `${messages[e - 1].result}\nworker ${codename} listening on port ${port}`;
        fact = { question: `Which port was the ${codename} worker listening on, according to the tool output?`, answer: port, acceptableAnswers: [port], evidenceSeqs: [e] };
        break;
      }
      case 'decision': {
        const [choice, reason] = rng.pick(CHOICES);
        const e = plantBefore(askAtSeq, d, ['assistant']);
        setText(e, `We decided to use ${choice} for ${codename} because ${reason}.`);
        fact = { question: `What did we decide to use for ${codename}, and why?`, answer: `${choice}, because ${reason}`, acceptableAnswers: [choice], evidenceSeqs: [e] };
        break;
      }
      case 'superseded': {
        const before = values.limit();
        const after = values.limit();
        const eNew = plantBefore(askAtSeq, d, ['user']);
        const eOld = plantBefore(eNew, d, ['user']);
        setText(eOld, `Set the ${codename} retry limit to ${before}.`);
        setText(eNew, `Change of plan: the ${codename} retry limit is now ${after}.`);
        fact = { question: `What is the current retry limit for ${codename}?`, answer: after, acceptableAnswers: [after], evidenceSeqs: [eOld, eNew] };
        break;
      }
      case 'multi-hop': {
        const host = values.host();
        const rack = values.rack();
        const eNear = plantBefore(askAtSeq, d, ['user']);
        const eFar = plantBefore(eNear, d, ['assistant']);
        setText(eFar, `The ${codename} service runs on ${host}.`);
        setText(eNear, `Note that ${host} sits in ${rack}.`);
        fact = { question: `Which rack does the ${codename} service run in?`, answer: rack, acceptableAnswers: [rack], evidenceSeqs: [eFar, eNear] };
        break;
      }
      case 'abstain':
        fact = { question: `What port did we pick for the ${codename} cache?`, answer: 'not in the session', acceptableAnswers: [], evidenceSeqs: [] };
        break;
      default:
        throw new Error(`unknown kind ${item.kind}`);
    }
    setText(askAtSeq, fact.question);
    return {
      id: `${sessionId}-${String(i + 1).padStart(3, '0')}`, sessionId, askAtSeq, kind: item.kind, ...fact,
      supersededBy: null, authoredBy: 'generated', verifiedBy: 'synthetic',
      notes: `planted by the synthetic generator, target distance ${d} tokens`
    };
  });

  const index = new SessionIndex(messages);
  const questions = planted.map((q) => normalizeQuestion(q, index)).sort((a, b) => a.askAtSeq - b.askAtSeq);
  const manifest = buildManifest({
    sessionId,
    source: 'synthetic',
    sourceRef: `synthetic:v${GENERATOR_VERSION}:seed=${seed}`,
    license: 'CC-BY-4.0',
    private: false,
    messages,
    compactions,
    extra: {
      title: `Synthetic session ${sessionId}`,
      generator: { version: GENERATOR_VERSION, seed, turns, resultLines, compactEvery },
      unmapped: 0,
      constructed: false
    }
  });
  return { manifest, messages, questions, index };
}

function writeSyntheticRoot(root, fixtures = SYNTH_FIXTURES) {
  return fixtures.map((config) => {
    const { manifest, messages, questions } = generateSynthetic(config);
    writeSession(path.join(root, 'sessions', config.sessionId), { manifest, messages });
    writeQuestions(questionsFile(root, config.sessionId), questions);
    return { sessionId: config.sessionId, messages: messages.length, questions: questions.length, estTokens: manifest.estTokens };
  });
}

module.exports = { SYNTH_FIXTURES, GENERATOR_VERSION, generateSynthetic, writeSyntheticRoot };
```

- [ ] **Step 5: Write `src/longhaul/commands/synth.js` and register it**

```js
'use strict';
// `longhaul synth --out <dir>`: write the synthetic fixture sessions and
// their questions in the data-root layout (sessions/, questions/). The
// committed copy lives in tests/fixtures/longhaul.
const path = require('path');
const { writeSyntheticRoot } = require('../synthetic');
const { UsageError } = require('../errors');

module.exports = {
  needsHome: false,
  options: { out: { type: 'string' } },
  async run(ctx, values) {
    if (!values.out) throw new UsageError('Usage: longhaul synth --out <dir>');
    const out = path.resolve(ctx.cwd, values.out);
    for (const s of writeSyntheticRoot(out)) {
      ctx.stdout.write(`${s.sessionId}: ${s.messages} messages, ~${s.estTokens} estimated tokens, ${s.questions} questions\n`);
    }
    return 0;
  }
};
```

In `src/longhaul/cli.js`:

```js
const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import'),
  synth: require('./commands/synth')
};
```

- [ ] **Step 6: Generate the committed fixtures**

Run: `node bin/longhaul.js synth --out tests/fixtures/longhaul`
Expected: three lines, for `synth-small` (200 messages, about 11K estimated tokens), `synth-medium` (1,100 messages, about 110K) and `synth-compacted` (452 messages, about 30K). If a line instead reports `cannot place a … fact`, raise that entry's `turns` in `SYNTH_FIXTURES` by 20 and run again; the plan's distances stay as written.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/longhaul-synthetic.test.js`
Expected: PASS, `# fail 0`. If "an answer also appears at" fails for a seed, change that entry's `seed` (never the planting rules), regenerate with Step 6 and rerun.

- [ ] **Step 8: Commit**

```bash
git add src/longhaul/rng.js src/longhaul/synthetic.js src/longhaul/commands/synth.js src/longhaul/cli.js tests/fixtures/longhaul tests/longhaul-synthetic.test.js
git commit -m "feat(longhaul): synthetic sessions with planted facts and three committed fixtures"
```

---

## Task 7: Adapters `sliding-window` and `oracle`

**Files:**
- Create: `src/longhaul/adapters/common.js`, `src/longhaul/adapters/sliding-window.js`, `src/longhaul/adapters/oracle.js`, `src/longhaul/adapters/index.js`
- Test: `tests/longhaul-adapters.test.js`

**Interfaces:**
- Consumes: `estimateTokens`, `renderMessage`, `renderMessages`, `SessionIndex`, `loadSession` (Task 2); `readQuestions`, `questionsFile` (Task 4); `SYNTH_FIXTURES`, `generateSynthetic` (Task 6); the committed fixtures (Task 6); `UsageError` (Task 1).
- Produces:
  - The adapter interface (spec §7): `{ name, describe() → config, prepare(session, { upToSeq }) → Promise<handle>, context(handle, { question, askAtSeq, budgetTokens }) → Promise<{ text, evidenceSeqsShown: number[] (sorted), estTokens, latencyMs, cpuMs, cost, chunks? }>, release(handle) → Promise }`. `chunks` is reported only by `kl-recall` (Task 8).
  - `adapters/common.js`: `TAIL_DEFAULTS = { tailMessages: 8, tailTokens: 6000 }` (recall spec §14 defaults), `measured(fn) → Promise<{ ...fn result, latencyMs, cpuMs }>`, `tailBefore(index, askAtSeq, { tailMessages, tailTokens }) → message[]` (the newest `user`/`assistant` messages before `askAtSeq`, ascending), `uniqueSorted(seqs)`.
  - `adapters/index.js`: `createAdapter(name, config) → adapter` (throws `UsageError` for an unknown name) and `adapterNames() → string[]`. Every adapter is created with `{ budgetTokens, ...its own options }`.
  - `sliding-window`: options `{ budgetTokens = 6000, windowTokens = budgetTokens + 6000 }`. The default window is the most `kl-recall` can show at the same budget: its recalled budget plus its tail budget. It shows the newest messages of any sender before `askAtSeq` while they fit, and a single message bigger than the window is cut to its end.
  - `oracle`: options `{ tailMessages = 8, tailTokens = 6000 }`. It shows the question's evidence messages (only those before `askAtSeq`) plus the tail, ignoring the budget (it is the upper bound).

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-adapters.test.js`:

```js
// tests/longhaul-adapters.test.js
// sliding-window and oracle (benchmark spec §7, §14): both respect askAtSeq;
// sliding-window respects its window; oracle recovers every planted fact.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { SessionIndex, loadSession, estimateTokens } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

function generated(config) {
  const { manifest, messages, questions, index } = generateSynthetic(config);
  return { session: { manifest, messages, index }, questions };
}
async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('sliding-window', () => {
  it('shows a contiguous run ending just before askAtSeq, inside the window', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[1]);
    const adapter = createAdapter('sliding-window', { budgetTokens: 2000 });
    assert.deepStrictEqual(adapter.describe(), { name: 'sliding-window', windowTokens: 8000 });
    const handle = await adapter.prepare(session, { upToSeq: Infinity });
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 2000 });
      const shown = r.evidenceSeqsShown;
      assert.ok(shown.every((s) => s < q.askAtSeq));
      assert.strictEqual(shown.at(-1), q.askAtSeq - 1);
      assert.deepStrictEqual(shown, Array.from({ length: shown.length }, (_, i) => shown[0] + i));
      assert.ok(r.estTokens <= 8000, `${r.estTokens} tokens`);
      assert.strictEqual(r.estTokens, estimateTokens(r.text));
      assert.ok(Number.isFinite(r.latencyMs) && Number.isFinite(r.cpuMs));
      assert.strictEqual(r.cost, 0);
    }
    await adapter.release(handle);
  });

  it('cuts a message larger than the window instead of showing nothing', async () => {
    const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString();
    const messages = [
      { id: 'b1', seq: 1, sender: 'user', text: 'start', timestamp: at(1) },
      { id: 'b2', seq: 2, sender: 'toolResult', toolName: 'Bash', result: 'x'.repeat(100000), timestamp: at(2) },
      { id: 'b3', seq: 3, sender: 'user', text: 'what now?', timestamp: at(3) }
    ];
    const session = { manifest: { sessionId: 'B' }, messages, index: new SessionIndex(messages) };
    const adapter = createAdapter('sliding-window', { windowTokens: 100 });
    const r = await adapter.context(await adapter.prepare(session), { question: {}, askAtSeq: 3, budgetTokens: 100 });
    assert.deepStrictEqual(r.evidenceSeqsShown, [2]);
    assert.ok(r.estTokens <= 100);
    assert.match(r.text, /earlier part of #2 cut/);
  });
});

describe('oracle', () => {
  for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
    it(`${id}: shows every evidence message and every planted answer, nothing at or after askAtSeq`, async () => {
      const { session, questions } = await fixture(id);
      const adapter = createAdapter('oracle', { budgetTokens: 6000 });
      const handle = await adapter.prepare(session, { upToSeq: Infinity });
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
        assert.ok(q.evidenceSeqs.every((s) => r.evidenceSeqsShown.includes(s)), q.id);
        assert.ok(r.evidenceSeqsShown.every((s) => s < q.askAtSeq), q.id);
        if (q.kind !== 'abstain') assert.ok(q.acceptableAnswers.some((a) => r.text.includes(a)), `${q.id}: no acceptable answer in the oracle context`);
      }
      await adapter.release(handle);
    });
  }

  it('never shows evidence listed at or after askAtSeq', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[0]);
    const q = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq, questions[0].askAtSeq + 1] };
    const adapter = createAdapter('oracle', {});
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
    assert.ok(r.evidenceSeqsShown.every((s) => s < q.askAtSeq));
  });

  it('shows only the tail for an abstain question', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[0]);
    const q = questions.find((x) => x.kind === 'abstain');
    const adapter = createAdapter('oracle', {});
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
    assert.ok(r.evidenceSeqsShown.length > 0 && r.evidenceSeqsShown.length <= 8);
    assert.ok(r.evidenceSeqsShown.every((s) => ['user', 'assistant'].includes(session.index.get(s).sender)));
  });
});

describe('adapter registry', () => {
  it('lists the built-in adapters and refuses an unknown one', () => {
    assert.deepStrictEqual(adapterNames(), ['oracle', 'sliding-window']);
    assert.throws(() => createAdapter('full-history'), UsageError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-adapters.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/adapters'`.

- [ ] **Step 3: Write `src/longhaul/adapters/common.js`**

```js
'use strict';
// Shared pieces for LongHaul adapters (benchmark spec §7).
const { performance } = require('node:perf_hooks');
const { estimateTokens, renderMessage } = require('../session-format');

// Recall spec §14 defaults for the tail, used by the oracle's tail.
const TAIL_DEFAULTS = Object.freeze({ tailMessages: 8, tailTokens: 6000 });

// Wall time and CPU time around one context() call.
async function measured(fn) {
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  const value = await fn();
  const cpu = process.cpuUsage(c0);
  return { ...value, latencyMs: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000 };
}

// The newest user and assistant messages before askAtSeq: at most
// tailMessages, until tailTokens would be exceeded (the newest is always
// kept). Ascending by seq.
function tailBefore(index, askAtSeq, { tailMessages, tailTokens }) {
  const picked = [];
  let used = 0;
  for (let seq = Math.min(askAtSeq - 1, index.maxSeq); seq >= 1 && picked.length < tailMessages; seq--) {
    const m = index.get(seq);
    if (m.sender !== 'user' && m.sender !== 'assistant') continue;
    const t = estimateTokens(renderMessage(m));
    if (picked.length > 0 && used + t > tailTokens) break;
    picked.push(m);
    used += t;
  }
  return picked.reverse();
}

function uniqueSorted(seqs) {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

module.exports = { TAIL_DEFAULTS, measured, tailBefore, uniqueSorted };
```

- [ ] **Step 4: Write `src/longhaul/adapters/sliding-window.js`**

```js
'use strict';
// sliding-window (benchmark spec §7): the last N estimated tokens before
// askAtSeq, any sender. The naive baseline. By default N is the most
// kl-recall can show at the same budget: recalled budget plus tail budget.
const { estimateTokens, renderMessage } = require('../session-format');
const { TAIL_DEFAULTS, measured, uniqueSorted } = require('./common');

const CUT_MARKER_MAX = 40;

function createSlidingWindowAdapter({ budgetTokens = 6000, windowTokens = null } = {}) {
  const limit = windowTokens ?? budgetTokens + TAIL_DEFAULTS.tailTokens;
  return {
    name: 'sliding-window',
    describe() { return { name: 'sliding-window', windowTokens: limit }; },
    async prepare(session) { return { session }; },
    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const parts = [];
        const seqs = [];
        let used = 0;
        for (let seq = Math.min(askAtSeq - 1, index.maxSeq); seq >= 1; seq--) {
          const text = renderMessage(index.get(seq));
          const t = estimateTokens(`${text}\n\n`);
          if (used + t > limit) {
            if (parts.length === 0) {
              const keep = Math.max(0, limit * 4 - CUT_MARKER_MAX);
              parts.push(`[... earlier part of #${seq} cut]\n${text.slice(-keep)}`);
              seqs.push(seq);
            }
            break;
          }
          parts.push(text);
          seqs.push(seq);
          used += t;
        }
        const text = parts.reverse().join('\n\n');
        return { text, evidenceSeqsShown: uniqueSorted(seqs), estTokens: estimateTokens(text), cost: 0 };
      });
    },
    async release() {}
  };
}

module.exports = { createSlidingWindowAdapter };
```

- [ ] **Step 5: Write `src/longhaul/adapters/oracle.js`**

```js
'use strict';
// oracle (benchmark spec §7): the question's evidence messages plus the tail.
// The upper bound on answerability; it ignores the budget. Evidence listed
// at or after askAtSeq is never shown.
const { estimateTokens, renderMessages } = require('../session-format');
const { TAIL_DEFAULTS, measured, tailBefore } = require('./common');

function createOracleAdapter({ tailMessages = TAIL_DEFAULTS.tailMessages, tailTokens = TAIL_DEFAULTS.tailTokens } = {}) {
  return {
    name: 'oracle',
    describe() { return { name: 'oracle', tailMessages, tailTokens }; },
    async prepare(session) { return { session }; },
    async context(handle, { question, askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        const evidence = (question.evidenceSeqs || [])
          .filter((s) => s < askAtSeq)
          .map((s) => index.get(s))
          .filter(Boolean);
        const bySeq = new Map();
        for (const m of [...evidence, ...tailBefore(index, askAtSeq, { tailMessages, tailTokens })]) bySeq.set(m.seq, m);
        const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        const text = renderMessages(ordered);
        return { text, evidenceSeqsShown: ordered.map((m) => m.seq), estTokens: estimateTokens(text), cost: 0 };
      });
    },
    async release() {}
  };
}

module.exports = { createOracleAdapter };
```

- [ ] **Step 6: Write `src/longhaul/adapters/index.js`**

```js
'use strict';
// The built-in adapters (benchmark spec §7) that stage B0 ships.
const { UsageError } = require('../errors');
const { createSlidingWindowAdapter } = require('./sliding-window');
const { createOracleAdapter } = require('./oracle');

const FACTORIES = {
  'sliding-window': createSlidingWindowAdapter,
  oracle: createOracleAdapter
};

function adapterNames() {
  return Object.keys(FACTORIES).sort();
}

function createAdapter(name, config = {}) {
  const factory = FACTORIES[name];
  if (!factory) throw new UsageError(`Unknown adapter "${name}". Known: ${adapterNames().join(', ')}`);
  return factory(config);
}

module.exports = { createAdapter, adapterNames };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/longhaul-adapters.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/longhaul/adapters tests/longhaul-adapters.test.js
git commit -m "feat(longhaul): sliding-window and oracle adapters"
```

---

## Task 8: Adapter `kl-recall` and the leakage test

Needs recall H1 and H2 merged: `HistoryStore`, `chunkMessage`, `TokenEstimator`, `Retriever`, `ContextBuilder` and the `history` settings namespace, exactly as in Global Constraints. This plan assumes the named exports `{ HistoryStore }` (from `src/history/index.js`), `{ chunkMessage }`, `{ TokenEstimator }`, `{ Retriever }` and `{ ContextBuilder }`, and classes constructed with `new`. If H2 exports any of them differently, change only the `require` lines and constructor calls below.

**Files:**
- Create: `src/longhaul/adapters/kl-recall.js`
- Modify: `src/longhaul/adapters/index.js` (register `kl-recall`, loaded lazily so `node:sqlite` loads only when this adapter is used), `tests/longhaul-adapters.test.js` (the registry list)
- Test: `tests/longhaul-adapter-kl-recall.test.js`

**Interfaces:**
- Consumes: the H1/H2 contract; `mergeSettings` from `src/core/settings.js`; `estimateTokens`, `renderMessages`, `SessionIndex`, `loadSession` (Task 2); `measured`, `uniqueSorted` (Task 7); `SYNTH_FIXTURES`, `generateSynthetic` (Task 6); `UsageError` (Task 1).
- Produces:
  - `createKlRecallAdapter({ budgetTokens = 6000, recall = {}, tmpRoot = os.tmpdir() }) → adapter` named `kl-recall`. `recall` overrides keys of `history.recall`; an unknown key throws `UsageError`. `recalledTokens` is always `budgetTokens`.
  - `handle = { dir, store, chatId: 'longhaul-<sessionId>', builder, settings, session }`.
  - `context` returns the adapter result plus `chunks: { tailSeqs, shownBySeq: { [seq]: n }, totalBySeq: { [seq]: n } }` for the chunk-level score (Task 9).
  - `shownFromBuild(out, chunkRows, chatId) → { tailSeqs, recalledSeqs, shownBySeq, evidenceSeqsShown }`: seqs from the returned tail messages and the recalled chunks' `seq`, never from `stats.tail`'s range (Review Focus 5).
  - The question is passed to `build` as `message = { id: 'longhaul-question-<id>', sender: 'user', text: question.question, timestamp: <timestamp of the message at askAtSeq> }` with `upToSeq: askAtSeq` and `model: 'longhaul-estimate'`.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-adapter-kl-recall.test.js`:

```js
// tests/longhaul-adapter-kl-recall.test.js
// kl-recall (benchmark spec §7, §14): recall's ContextBuilder over a temp
// store. The leakage test: it never shows a message with seq >= askAtSeq.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { adapterNames } = require('../src/longhaul/adapters');
const { createKlRecallAdapter, shownFromBuild } = require('../src/longhaul/adapters/kl-recall');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { SessionIndex, loadSession, estimateTokens } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { TokenEstimator } = require('../src/history/token-estimator');
const { chunkMessage } = require('../src/history/chunker');
const { FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('shownFromBuild', () => {
  it('takes seqs from the tail messages returned, not from the stats.tail range', () => {
    const out = {
      tail: [{ seq: 10 }, { seq: 11 }, { seq: 13 }],
      recalled: { chunkIds: [7, 8, 9] },
      stats: { tail: { fromSeq: 10, toSeq: 13 } }
    };
    const rows = [{ id: 7, chatId: 'c', seq: 4 }, { id: 8, chatId: 'c', seq: 4 }, { id: 9, chatId: 'other', seq: 2 }];
    const shown = shownFromBuild(out, rows, 'c');
    assert.deepStrictEqual(shown.evidenceSeqsShown, [4, 10, 11, 13]);
    assert.deepStrictEqual(shown.tailSeqs, [10, 11, 13]);
    assert.deepStrictEqual(shown.recalledSeqs, [4]);
    assert.deepStrictEqual(shown.shownBySeq, { 4: 2 });
    assert.ok(!shown.evidenceSeqsShown.includes(12), 'a tool result inside the tail range but not in the tail is not shown');
  });
});

describe('kl-recall', () => {
  it('is registered next to the other adapters', () => {
    assert.deepStrictEqual(adapterNames(), ['kl-recall', 'oracle', 'sliding-window']);
  });

  it('refuses a recall setting it does not know, and sets recalledTokens to the budget', () => {
    assert.throws(() => createKlRecallAdapter({ recall: { notASetting: 1 } }), UsageError);
    assert.strictEqual(createKlRecallAdapter({ budgetTokens: 4321 }).describe().recall.recalledTokens, 4321);
  });

  it('never shows a message at or after askAtSeq (the leakage test)', async () => {
    const base = generateSynthetic(SYNTH_FIXTURES[0]);
    const messages = base.messages.map((m) => ({ ...m }));
    const askAtSeq = base.index.userSeqs[20];
    for (const m of messages) {
      if (m.seq < askAtSeq) continue;
      if (m.sender === 'toolResult') m.result = `${m.result}\nzephyr-quartz answered 18999`;
      else if (m.sender === 'user' || m.sender === 'assistant') m.text = `${m.text} zephyr-quartz is 18999.`;
    }
    const session = { manifest: base.manifest, messages, index: new SessionIndex(messages) };
    const q = {
      id: 'leak-1', sessionId: base.manifest.sessionId, askAtSeq, kind: 'abstain', question: 'What is zephyr-quartz set to?',
      answer: 'not in the session', acceptableAnswers: [], evidenceSeqs: [], supersededBy: null, authoredBy: 'human', verifiedBy: 'human:T', notes: ''
    };
    const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
    // Everything is in the store; only build's upToSeq keeps the later messages out.
    const handle = await adapter.prepare(session, { upToSeq: Infinity });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsShown.length > 0);
      assert.deepStrictEqual(r.evidenceSeqsShown.filter((s) => s >= askAtSeq), []);
      assert.ok(!r.text.includes('zephyr-quartz'));
    } finally {
      await adapter.release(handle);
    }
  });

  it('never leaks on any committed fixture question', async () => {
    for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
      const { session, questions } = await fixture(id);
      const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
      const handle = await adapter.prepare(session, { upToSeq: Infinity });
      try {
        for (const q of questions) {
          const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
          assert.deepStrictEqual(r.evidenceSeqsShown.filter((s) => s >= q.askAtSeq), [], q.id);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  });

  it('finds a unique planted fact far beyond the tail and reports its chunks', async () => {
    const { session, questions } = await fixture('synth-medium');
    const q = questions.filter((x) => x.kind === 'user-said').sort((a, b) => b.distance.estTokens - a.distance.estTokens)[0];
    const [e] = q.evidenceSeqs;
    const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
    const handle = await adapter.prepare(session, { upToSeq: q.askAtSeq });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsShown.includes(e), `BM25 recall missed #${e}, a unique codename ${q.distance.estTokens} tokens back`);
      assert.ok(!r.chunks.tailSeqs.includes(e), 'the evidence came from recall, not the tail');
      assert.ok(r.chunks.shownBySeq[e] >= 1);
      assert.strictEqual(r.chunks.totalBySeq[e], chunkMessage(session.index.get(e), handle.settings.history.chunk).length);
      assert.ok(r.chunks.totalBySeq[e] >= r.chunks.shownBySeq[e]);
      assert.strictEqual(r.estTokens, estimateTokens(r.text));
    } finally {
      await adapter.release(handle);
    }
  });

  it('imports only the messages before upToSeq and removes its store on release', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({});
    const handle = await adapter.prepare({ manifest, messages, index }, { upToSeq: 50 });
    assert.deepStrictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 50, toSeq: 60 }), []);
    assert.strictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 49, toSeq: 49 }).length, 1);
    const { dir } = handle;
    await adapter.release(handle);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('estimates tokens exactly as TokenEstimator does before any calibration', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({});
    const handle = await adapter.prepare({ manifest, messages, index }, { upToSeq: 5 });
    try {
      const estimator = new TokenEstimator({ store: handle.store });
      for (const text of ['', 'abcd', 'abcde', 'x'.repeat(1001), messages[3].result]) {
        assert.strictEqual(estimator.estimate(text, 'longhaul-estimate'), estimateTokens(text), JSON.stringify(text.slice(0, 20)));
      }
    } finally {
      await adapter.release(handle);
    }
  });
});
```

In `tests/longhaul-adapters.test.js`, change the registry expectation to the full list:

```js
    assert.deepStrictEqual(adapterNames(), ['kl-recall', 'oracle', 'sliding-window']);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-adapter-kl-recall.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/adapters/kl-recall'`.

- [ ] **Step 3: Write `src/longhaul/adapters/kl-recall.js`**

```js
'use strict';
// kl-recall (benchmark spec §7): recall's ContextBuilder over a temporary
// history store, one store per session. Each question is asked with
// upToSeq = askAtSeq, in place of the user message there, so nothing at or
// after the question can be shown. B0 runs after recall H2: BM25 only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../../history');
const { TokenEstimator } = require('../../history/token-estimator');
const { Retriever } = require('../../history/retriever');
const { ContextBuilder } = require('../../history/context-builder');
const { chunkMessage } = require('../../history/chunker');
const { mergeSettings } = require('../../core/settings');
const { estimateTokens, renderMessages } = require('../session-format');
const { measured, uniqueSorted } = require('./common');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/kl-recall');
const ESTIMATOR_MODEL = 'longhaul-estimate';

function recallSettings(recall, budgetTokens) {
  const base = mergeSettings({});
  const history = base.history || {};
  const defaults = history.recall || {};
  for (const key of Object.keys(recall)) {
    if (!(key in defaults)) throw new UsageError(`Unknown recall setting "${key}". Known: ${Object.keys(defaults).sort().join(', ')}`);
  }
  return { ...base, history: { ...history, recall: { ...defaults, ...recall, recalledTokens: budgetTokens } } };
}

// Which seqs a build put in front of the model: the tail messages it
// returned (not the stats.tail range, which also spans the tool results the
// tail leaves out) and the messages of its recalled chunks in this chat.
function shownFromBuild(out, chunkRows, chatId) {
  const tailSeqs = uniqueSorted((out.tail || []).map((m) => m.seq).filter(Number.isInteger));
  const shownBySeq = {};
  for (const c of chunkRows) {
    if (c.chatId !== chatId) continue;
    shownBySeq[c.seq] = (shownBySeq[c.seq] || 0) + 1;
  }
  const recalledSeqs = uniqueSorted(Object.keys(shownBySeq).map(Number));
  return { tailSeqs, recalledSeqs, shownBySeq, evidenceSeqsShown: uniqueSorted([...tailSeqs, ...recalledSeqs]) };
}

function createKlRecallAdapter({ budgetTokens = 6000, recall = {}, tmpRoot = os.tmpdir() } = {}) {
  const settings = recallSettings(recall, budgetTokens);
  return {
    name: 'kl-recall',
    describe() {
      return { name: 'kl-recall', recall: settings.history.recall, chunk: settings.history.chunk ?? null, embedder: 'none (BM25 only)' };
    },

    async prepare(session, { upToSeq = Infinity } = {}) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'longhaul-kl-'));
      let store = null;
      try {
        store = HistoryStore.open(path.join(dir, 'history.sqlite'));
        const chatId = `longhaul-${session.manifest.sessionId}`;
        const first = session.messages[0];
        store.createChat({ id: chatId, title: session.manifest.sessionId, source: session.manifest.source ?? null, createdAt: first?.timestamp, updatedAt: first?.timestamp });
        let appended = 0;
        for (const m of session.messages) {
          if (m.seq >= upToSeq) break;
          const { seq, ...message } = m;
          const out = store.appendMessage(chatId, message);
          if (out.seq !== seq) {
            throw new Error(`seq drift in ${session.manifest.sessionId}: message ${m.id} is #${seq} in the session but #${out.seq} in the store`);
          }
          appended += 1;
        }
        log.debug('prepared', { sessionId: session.manifest.sessionId, appended });
        const estimator = new TokenEstimator({ store });
        const retriever = new Retriever({ store, estimator });
        const builder = new ContextBuilder({ store, retriever, estimator, getSettings: () => settings });
        return { dir, store, chatId, builder, settings, session };
      } catch (err) {
        try { store?.close(); } catch { /* already failing */ }
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    },

    async context(handle, { question, askAtSeq }) {
      return measured(async () => {
        // build() takes the question as text (the new user message); ages and recency are measured from message #askAtSeq's timestamp inside build.
        const message = question.question;
        const out = await handle.builder.build({ chatId: handle.chatId, message, model: ESTIMATOR_MODEL, upToSeq: askAtSeq });
        const chunkIds = out.recalled?.chunkIds || [];
        const rows = chunkIds.length ? handle.store.chunks(chunkIds) : [];
        const shown = shownFromBuild(out, rows, handle.chatId);
        const totalBySeq = {};
        for (const seq of shown.recalledSeqs) {
          const m = handle.session.index.get(seq);
          totalBySeq[seq] = m ? chunkMessage(m, handle.settings.history.chunk).length : 0;
        }
        const text = [renderMessages(out.tail || []), out.recalled?.text || ''].filter(Boolean).join('\n\n');
        return {
          text,
          evidenceSeqsShown: shown.evidenceSeqsShown,
          estTokens: estimateTokens(text),
          cost: 0,
          chunks: { tailSeqs: shown.tailSeqs, shownBySeq: shown.shownBySeq, totalBySeq }
        };
      });
    },

    async release(handle) {
      try {
        handle.store.close();
      } finally {
        fs.rmSync(handle.dir, { recursive: true, force: true });
      }
    }
  };
}

module.exports = { createKlRecallAdapter, shownFromBuild, recallSettings };
```

- [ ] **Step 4: Register `kl-recall` lazily**

In `src/longhaul/adapters/index.js`, replace `FACTORIES` with:

```js
const FACTORIES = {
  // Loaded on use: it opens node:sqlite, which the other adapters never need.
  'kl-recall': (config) => require('./kl-recall').createKlRecallAdapter(config),
  'sliding-window': createSlidingWindowAdapter,
  oracle: createOracleAdapter
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/longhaul-adapter-kl-recall.test.js tests/longhaul-adapters.test.js`
Expected: PASS, `# fail 0`.

If "estimates tokens exactly as TokenEstimator does" fails, make `estimateTokens` in `src/longhaul/session-format.js` follow `TokenEstimator`'s uncalibrated rule (its rounding), not the other way round. H2 owns the estimator. Then rerun `tests/longhaul-session-format.test.js` and `tests/longhaul-questions.test.js`. Their token numbers assume `ceil(chars / 4)`, so update those expectations to the same rule and say so in the commit message.

If "never shows a message at or after askAtSeq" fails, the defect is in H2's `upToSeq` handling (`ContextBuilder.build`, `searchText`). Stop and report it with the failing seqs; do not filter the adapter's output to hide it.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/adapters/kl-recall.js src/longhaul/adapters/index.js tests/longhaul-adapter-kl-recall.test.js tests/longhaul-adapters.test.js
git commit -m "feat(longhaul): kl-recall adapter over a temp history store, with the leakage test"
```

---

## Task 9: `longhaul run`: scoring, records, summary and the smoke run

**Files:**
- Create: `src/longhaul/scoring.js`, `src/longhaul/run.js`, `src/longhaul/commands/run.js`
- Modify: `src/longhaul/cli.js` (register `run`)
- Test: `tests/longhaul-run.test.js`, `tests/longhaul-smoke.test.js`

**Interfaces:**
- Consumes: `loadSession`, `listSessions`, `sessionDir` (Task 2); `readQuestions`, `questionsFile`, `validateQuestionSet`, `isVerified`, `bucketFor`, `computeDistance`, `KINDS`, `BUCKETS` (Task 4); `createAdapter` (Tasks 7 and 8); `writeFileAtomic`, `sha256File` (Task 2); `writeSyntheticRoot`, `SYNTH_FIXTURES` and the fixtures (Task 6); `UsageError` (Task 1).
- Produces:
  - `src/longhaul/scoring.js`:
    - `evidenceRecall(evidenceSeqs, shownSeqs) → number|null` (`null` for no evidence, i.e. `abstain`).
    - `chunkEvidenceRecall(evidenceSeqs, chunks|undefined) → number|null`. For each evidence message: 1 when it is in the tail, else chunks shown ÷ chunks total, else 0; the mean over evidence messages. `null` when the adapter reports no chunks.
    - `percentile(values, p)` (nearest rank; `null` when empty) and `mean(values)` (ignores `null`).
    - `summarize(records) → { [adapter]: { questions, errors, scored, abstain, evidenceRecall, chunkEvidenceRecall, byKind: { [kind]: { n, evidenceRecall } }, byBucket: { [bucket]: { n, evidenceRecall } }, estTokens: { median, p90, max }, latencyMs: { median, p90 }, cpuMs: { median, p90 }, leaks } }`.
    - `renderSummaryMarkdown(config, summary) → string`.
  - `src/longhaul/run.js`:
    - `runBenchmark({ home, dataRoot = home.root, sessionIds, adapterNames, adapterConfig, adapters, budgetTokens = 6000, seed = 1, includeUnverified = false, now, commit }) → Promise<{ runId, dir, config, summary, records, leaks }>`. `adapters` injects adapter objects for tests.
    - `gitCommit(cwd) → '<sha>' | '<sha>-dirty' | 'unknown'`.
    - A record is `{ runId, sessionId, questionId, adapter, kind, bucket, askAtSeq, evidenceSeqs, verified, evidenceSeqsShown, evidenceRecall, chunkEvidenceRecall, estTokens, latencyMs, cpuMs, cost, leaked, error }`. It never holds question, answer or message text.
    - Files: `runs/<runId>/config.json` is written before the first question; `records.jsonl` is appended per question; then `summary.json` and `summary.md`.
    - The run refuses (`UsageError`, nothing written) a question set that fails validation, naming the first bad question, and refuses a run with no verified questions unless `includeUnverified`.
  - `src/longhaul/commands/run.js`: `longhaul run --adapters a,b [--sessions <data root>] [--session <id>]... [--budget-tokens 6000] [--window-tokens N] [--recall key=value]... [--seed N] [--include-unverified]`. It also exports `exitCodeFor(result, stderr) → 0 | 1` (1 when any leak) and `positiveInt(value, name) → int` (throws `UsageError`), which `author` reuses.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-run.test.js`:

```js
// tests/longhaul-run.test.js
// `longhaul run` for stage B0 (benchmark spec §8 steps 1, 2 and 5; §11; §15):
// evidence recall per question, exactly computable from fake adapters.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runBenchmark } = require('../src/longhaul/run');
const { evidenceRecall, chunkEvidenceRecall, percentile, summarize } = require('../src/longhaul/scoring');
const { exitCodeFor } = require('../src/longhaul/commands/run');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { readQuestions, writeQuestions, questionsFile } = require('../src/longhaul/questions');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

function fakeAdapter(name, pick) {
  return {
    name,
    describe: () => ({ name }),
    prepare: async (session) => ({ session }),
    context: async (handle, { question, askAtSeq }) => ({
      text: 'x'.repeat(40), evidenceSeqsShown: pick(question, askAtSeq), estTokens: 10, latencyMs: 2, cpuMs: 1, cost: 0
    }),
    release: async () => {}
  };
}
// Shows the first evidence message and the message just before the question.
const firstEvidence = fakeAdapter('first-evidence', (q, at) => [...q.evidenceSeqs.slice(0, 1), at - 1]);
const fixedNow = () => new Date('2026-09-29T10:15:00.000Z');

function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return home;
}
const readRecords = (dir) => fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('scoring', () => {
  it('computes evidence recall per question', () => {
    assert.strictEqual(evidenceRecall([4, 9], [1, 4]), 0.5);
    assert.strictEqual(evidenceRecall([4], []), 0);
    assert.strictEqual(evidenceRecall([], [1]), null);
  });

  it('computes chunk evidence recall from the tail and the recalled chunks', () => {
    assert.strictEqual(chunkEvidenceRecall([4, 9], { tailSeqs: [9], shownBySeq: { 4: 1 }, totalBySeq: { 4: 4 } }), 0.625);
    assert.strictEqual(chunkEvidenceRecall([4], { tailSeqs: [], shownBySeq: {}, totalBySeq: {} }), 0);
    assert.strictEqual(chunkEvidenceRecall([4], undefined), null);
    assert.strictEqual(chunkEvidenceRecall([], { tailSeqs: [] }), null);
  });

  it('takes nearest-rank percentiles', () => {
    assert.strictEqual(percentile([5, 1, 3, 2, 4], 0.5), 3);
    assert.strictEqual(percentile([5, 1, 3, 2, 4], 0.9), 5);
    assert.strictEqual(percentile([], 0.5), null);
  });

  it('summarizes by kind and bucket, leaving errors and abstain out of the rates', () => {
    const r = (kind, bucket, er, extra = {}) => ({ adapter: 'a', kind, bucket, evidenceRecall: er, chunkEvidenceRecall: null, estTokens: 100, latencyMs: 1, cpuMs: 1, leaked: 0, error: null, ...extra });
    const s = summarize([
      r('user-said', '<10K', 1), r('user-said', '10K-50K', 0), r('superseded', '<10K', 0.5),
      r('abstain', 'none', null), r('decision', '<10K', null, { error: 'boom', estTokens: null })
    ]).a;
    assert.strictEqual(s.questions, 5);
    assert.strictEqual(s.errors, 1);
    assert.strictEqual(s.scored, 3);
    assert.strictEqual(s.abstain, 1);
    assert.strictEqual(s.evidenceRecall, 0.5);
    assert.deepStrictEqual(s.byKind, { 'user-said': { n: 2, evidenceRecall: 0.5 }, superseded: { n: 1, evidenceRecall: 0.5 } });
    assert.deepStrictEqual(s.byBucket, { '<10K': { n: 2, evidenceRecall: 0.75 }, '10K-50K': { n: 1, evidenceRecall: 0 } });
    assert.deepStrictEqual(s.estTokens, { median: 100, p90: 100, max: 100 });
    assert.strictEqual(s.chunkEvidenceRecall, null);
  });
});

describe('runBenchmark', () => {
  it('writes config, per-question records and an exactly computable summary', async () => {
    const home = setup();
    const out = await runBenchmark({ home, adapters: [firstEvidence], budgetTokens: 6000, seed: 7, now: fixedNow, commit: 'abc123' });
    assert.match(out.runId, /^20260929T101500Z-[0-9a-f]{4}$/);
    const config = JSON.parse(fs.readFileSync(path.join(out.dir, 'config.json'), 'utf8'));
    assert.strictEqual(config.metric, 'evidence recall');
    assert.strictEqual(config.commit, 'abc123');
    assert.strictEqual(config.budgetTokens, 6000);
    assert.strictEqual(config.seed, 7);
    assert.strictEqual(config.includeUnverified, false);
    assert.strictEqual(config.dataRoot, '$LONGHAUL_HOME');
    assert.deepStrictEqual(config.adapters, [{ name: 'first-evidence' }]);
    assert.strictEqual(config.sessions[0].sessionId, 'synth-small');
    assert.match(config.sessions[0].questionsSha256, /^[0-9a-f]{64}$/);

    const records = readRecords(out.dir);
    assert.strictEqual(records.length, 6);
    // user-said, tool-observed, decision: 1 each; superseded, multi-hop: 1 of 2; abstain: not scored.
    const s = JSON.parse(fs.readFileSync(path.join(out.dir, 'summary.json'), 'utf8'))['first-evidence'];
    assert.strictEqual(s.scored, 5);
    assert.strictEqual(s.abstain, 1);
    assert.strictEqual(s.evidenceRecall, 0.8);
    assert.deepStrictEqual(s.byKind.superseded, { n: 1, evidenceRecall: 0.5 });
    assert.strictEqual(s.leaks, 0);
    assert.match(fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8'), /\| first-evidence \| 6 \| 5 \| 0 \| 0\.800 \|/);

    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const raw = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8');
    for (const q of questions) assert.ok(!raw.includes(q.question), 'records carry ids and numbers, never text');
  });

  it('refuses a question set that fails validation, naming the question, and writes no run', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    const questions = await readQuestions(file);
    questions[0] = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq] };
    writeQuestions(file, questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.message.includes(`${questions[0].id}: evidence-after-ask`)
    );
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);
  });

  it('counts only verified questions unless --include-unverified, which marks the run', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    const questions = await readQuestions(file);
    questions[1] = { ...questions[1], verifiedBy: null };
    writeQuestions(file, questions);
    const verifiedOnly = await runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' });
    assert.strictEqual(verifiedOnly.records.length, 5);
    const all = await runBenchmark({ home, adapters: [firstEvidence], includeUnverified: true, now: fixedNow, commit: 'x' });
    assert.strictEqual(all.records.length, 6);
    assert.strictEqual(all.config.includeUnverified, true);
    assert.strictEqual(all.records.find((r) => r.questionId === questions[1].id).verified, false);
    assert.match(fs.readFileSync(path.join(all.dir, 'summary.md'), 'utf8'), /UNVERIFIED QUESTIONS INCLUDED/);
  });

  it('refuses a run with no verified questions', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    await assert.rejects(runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' }), /--include-unverified/);
  });

  it('counts every shown seq at or after askAtSeq as a leak, and the CLI exits 1', async () => {
    const home = setup();
    const out = await runBenchmark({ home, adapters: [fakeAdapter('leaky', (q, at) => [at - 1, at])], now: fixedNow, commit: 'x' });
    assert.strictEqual(out.leaks, 6);
    assert.strictEqual(out.summary.leaky.leaks, 6);
    const stderr = sink();
    assert.strictEqual(exitCodeFor(out, stderr), 1);
    assert.match(stderr.text, /LEAK/);
  });

  it('records an adapter error for one question and leaves it out of the rates', async () => {
    const flaky = fakeAdapter('flaky', (q, at) => {
      if (q.kind === 'decision') throw new Error('boom');
      return [...q.evidenceSeqs, at - 1];
    });
    const out = await runBenchmark({ home: setup(), adapters: [flaky], now: fixedNow, commit: 'x' });
    const s = out.summary.flaky;
    assert.strictEqual(s.errors, 1);
    assert.strictEqual(s.scored, 4);
    assert.strictEqual(s.evidenceRecall, 1);
    assert.strictEqual(out.records.find((r) => r.kind === 'decision').error, 'boom');
  });
});

describe('longhaul run CLI', () => {
  it('refuses bad options with exit 2', async () => {
    const { env } = tmpHome();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'full-history'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--budget-tokens', '0'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--session', 'nope'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall', '--recall', 'noEquals'], io()), 2);
  });
});
```

Create `tests/longhaul-smoke.test.js`:

```js
// tests/longhaul-smoke.test.js
// The CI smoke run (benchmark spec §14): the real CLI over the committed
// synthetic fixtures with sliding-window and oracle. No models, no network.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, tmpHome } = require('./helpers/longhaul-helpers');

describe('longhaul smoke run', () => {
  it('scores the fixtures; oracle recovers every planted fact and nothing leaks', () => {
    const { root } = tmpHome();
    const out = spawnSync(process.execPath, [
      path.join('bin', 'longhaul.js'), 'run', '--sessions', path.join('tests', 'fixtures', 'longhaul'), '--adapters', 'sliding-window,oracle'
    ], { cwd: REPO, encoding: 'utf8', env: { ...process.env, LONGHAUL_HOME: root } });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /oracle\s+evidence recall 1\.000/);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const dir = path.join(root, 'runs', runId);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.oracle.evidenceRecall, 1);
    assert.ok(summary['sliding-window'].evidenceRecall <= 1);
    assert.strictEqual(summary.oracle.leaks + summary['sliding-window'].leaks, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.sessions.map((s) => s.sessionId), ['synth-compacted', 'synth-medium', 'synth-small']);
    assert.ok(config.sessions.every((s) => s.private === false));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-run.test.js tests/longhaul-smoke.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/run'`, and the smoke run exits 2 with `Unknown command "run"`.

- [ ] **Step 3: Write `src/longhaul/scoring.js`**

```js
'use strict';
// Evidence recall (benchmark spec §8 step 2, CONTEXT.md): the fraction of a
// question's evidence messages a candidate system put in front of the model.
// Message level for every adapter; chunk level for adapters that report
// chunks. No model call. Abstain questions have no evidence and no score.
const { KINDS, BUCKETS } = require('./questions');

function evidenceRecall(evidenceSeqs, shownSeqs) {
  if (!evidenceSeqs.length) return null;
  const shown = new Set(shownSeqs);
  return evidenceSeqs.filter((s) => shown.has(s)).length / evidenceSeqs.length;
}

function chunkEvidenceRecall(evidenceSeqs, chunks) {
  if (!chunks || !evidenceSeqs.length) return null;
  const tail = new Set(chunks.tailSeqs || []);
  let sum = 0;
  for (const s of evidenceSeqs) {
    if (tail.has(s)) { sum += 1; continue; }
    const total = chunks.totalBySeq?.[s] || 0;
    const shown = chunks.shownBySeq?.[s] || 0;
    sum += total > 0 ? Math.min(1, shown / total) : 0;
  }
  return sum / evidenceSeqs.length;
}

function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil(p * v.length) - 1)];
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function groupRecall(records, key) {
  const groups = {};
  for (const r of records) (groups[r[key]] ||= []).push(r.evidenceRecall);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { n: v.length, evidenceRecall: mean(v) }]));
}

function summarize(records) {
  const byAdapter = {};
  for (const r of records) (byAdapter[r.adapter] ||= []).push(r);
  const out = {};
  for (const [adapter, rs] of Object.entries(byAdapter)) {
    const ok = rs.filter((r) => !r.error);
    const scored = ok.filter((r) => r.evidenceRecall !== null);
    out[adapter] = {
      questions: rs.length,
      errors: rs.length - ok.length,
      scored: scored.length,
      abstain: ok.length - scored.length,
      evidenceRecall: mean(scored.map((r) => r.evidenceRecall)),
      chunkEvidenceRecall: mean(scored.map((r) => r.chunkEvidenceRecall)),
      byKind: groupRecall(scored, 'kind'),
      byBucket: groupRecall(scored, 'bucket'),
      estTokens: { median: percentile(ok.map((r) => r.estTokens), 0.5), p90: percentile(ok.map((r) => r.estTokens), 0.9), max: percentile(ok.map((r) => r.estTokens), 1) },
      latencyMs: { median: percentile(ok.map((r) => r.latencyMs), 0.5), p90: percentile(ok.map((r) => r.latencyMs), 0.9) },
      cpuMs: { median: percentile(ok.map((r) => r.cpuMs), 0.5), p90: percentile(ok.map((r) => r.cpuMs), 0.9) },
      leaks: ok.reduce((n, r) => n + (r.leaked || 0), 0)
    };
  }
  return out;
}

const fmt = (x, digits = 3) => (x === null || x === undefined ? '—' : x.toFixed(digits));
const cell = (g) => (g ? `${fmt(g.evidenceRecall)} (n=${g.n})` : '—');

function renderSummaryMarkdown(config, summary) {
  const lines = [`# LongHaul run ${config.runId}`, ''];
  if (config.includeUnverified) lines.push('**UNVERIFIED QUESTIONS INCLUDED. This is a smoke run, not a result.**', '');
  lines.push('Metric: evidence recall, at message level (and at chunk level for adapters that report chunks). No answer or judge model (stage B0).', '');
  lines.push(`Budget ${config.budgetTokens} recalled tokens; seed ${config.seed}; commit ${config.commit}.`, '');
  lines.push(`Sessions: ${config.sessions.map((s) => `${s.sessionId} (${s.private ? 'private' : s.license}, ${s.questions} questions)`).join(', ')}`, '');
  lines.push('| Adapter | Questions | Scored | Errors | Evidence recall | Chunk evidence recall | Median tokens | p90 tokens | Median ms | p90 ms | Leaks |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, s] of Object.entries(summary)) {
    lines.push(`| ${name} | ${s.questions} | ${s.scored} | ${s.errors} | ${fmt(s.evidenceRecall)} | ${fmt(s.chunkEvidenceRecall)} | ${s.estTokens.median ?? '—'} | ${s.estTokens.p90 ?? '—'} | ${fmt(s.latencyMs.median, 1)} | ${fmt(s.latencyMs.p90, 1)} | ${s.leaks} |`);
  }
  const kinds = KINDS.filter((k) => k !== 'abstain');
  lines.push('', '## Evidence recall by kind', '', `| Adapter | ${kinds.join(' | ')} |`, `|---|${kinds.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${kinds.map((k) => cell(s.byKind[k])).join(' | ')} |`);
  const buckets = BUCKETS.map((b) => b.id);
  lines.push('', '## Evidence recall by distance (estimated tokens)', '', `| Adapter | ${buckets.join(' | ')} |`, `|---|${buckets.map(() => '---').join('|')}|`);
  for (const [name, s] of Object.entries(summary)) lines.push(`| ${name} | ${buckets.map((b) => cell(s.byBucket[b])).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = { evidenceRecall, chunkEvidenceRecall, percentile, mean, summarize, renderSummaryMarkdown };
```

- [ ] **Step 4: Write `src/longhaul/run.js`**

```js
'use strict';
// `longhaul run` for stage B0 (benchmark spec §8 steps 1, 2 and 5; §11):
// each adapter's context at each question's askAtSeq, scored by evidence
// recall. No answer or judge model. Records hold ids, seqs and numbers only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadSession, listSessions, sessionDir } = require('./session-format');
const { readQuestions, questionsFile, validateQuestionSet, isVerified, bucketFor, computeDistance } = require('./questions');
const { createAdapter } = require('./adapters');
const { evidenceRecall, chunkEvidenceRecall, summarize, renderSummaryMarkdown } = require('./scoring');
const { writeFileAtomic, sha256File } = require('./files');
const { UsageError } = require('./errors');

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

async function scoreOne({ runId, adapter, handle, session, q, budgetTokens }) {
  const base = {
    runId, sessionId: q.sessionId, questionId: q.id, adapter: adapter.name, kind: q.kind,
    bucket: bucketFor(computeDistance(session.index, q)), askAtSeq: q.askAtSeq, evidenceSeqs: q.evidenceSeqs, verified: isVerified(q)
  };
  try {
    const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens });
    const shown = r.evidenceSeqsShown || [];
    return {
      ...base,
      evidenceSeqsShown: shown,
      evidenceRecall: evidenceRecall(q.evidenceSeqs, shown),
      chunkEvidenceRecall: chunkEvidenceRecall(q.evidenceSeqs, r.chunks),
      estTokens: r.estTokens, latencyMs: r.latencyMs, cpuMs: r.cpuMs, cost: r.cost ?? 0,
      leaked: shown.filter((s) => s >= q.askAtSeq).length,
      error: null
    };
  } catch (err) {
    return {
      ...base, evidenceSeqsShown: [], evidenceRecall: null, chunkEvidenceRecall: null,
      estTokens: null, latencyMs: null, cpuMs: null, cost: 0, leaked: 0, error: err.message
    };
  }
}

async function runBenchmark({
  home, dataRoot = home.root, sessionIds = null, adapterNames = [], adapterConfig = {}, adapters: injected = null,
  budgetTokens = 6000, seed = 1, includeUnverified = false, now = () => new Date(), commit = gitCommit()
}) {
  const adapters = injected || adapterNames.map((name) => createAdapter(name, { budgetTokens, ...(adapterConfig[name] || {}) }));
  if (!adapters.length) throw new UsageError('Name at least one adapter with --adapters.');
  const { sets, skipped } = await loadRunSet({ dataRoot, sessionIds, includeUnverified });

  const runId = newRunId(now());
  const dir = path.join(home.runs, runId);
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    runId,
    createdAt: now().toISOString(),
    benchmark: 'LongHaul',
    stage: 'B0',
    metric: 'evidence recall',
    commit,
    node: process.version,
    budgetTokens,
    seed,
    includeUnverified,
    dataRoot: path.resolve(dataRoot) === path.resolve(home.root) ? '$LONGHAUL_HOME' : path.basename(dataRoot),
    adapters: adapters.map((a) => a.describe()),
    sessions: sets.map(({ session, questions, verified, questionsSha256 }) => ({
      sessionId: session.manifest.sessionId, source: session.manifest.source, private: session.manifest.private,
      license: session.manifest.license, questions: questions.length, verifiedQuestions: verified, questionsSha256
    })),
    skippedSessions: skipped
  };
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, '');
  const records = [];
  for (const { session, questions } of sets) {
    if (!questions.length) continue;
    const upToSeq = Math.max(...questions.map((q) => q.askAtSeq));
    for (const adapter of adapters) {
      const handle = await adapter.prepare(session, { upToSeq });
      try {
        for (const q of questions) {
          const record = await scoreOne({ runId, adapter, handle, session, q, budgetTokens });
          records.push(record);
          fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  }

  const summary = summarize(records);
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), renderSummaryMarkdown(config, summary));
  const leaks = Object.values(summary).reduce((n, s) => n + s.leaks, 0);
  return { runId, dir, config, summary, records, leaks };
}

module.exports = { runBenchmark, gitCommit };
```

- [ ] **Step 5: Write `src/longhaul/commands/run.js` and register it**

```js
'use strict';
// `longhaul run`: evidence recall per adapter (stage B0). Output is ASCII.
const path = require('path');
const { runBenchmark } = require('../run');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul run --adapters kl-recall,sliding-window,oracle [--sessions <data root>] [--session <id>]... '
  + '[--budget-tokens 6000] [--window-tokens N] [--recall key=value]... [--seed N] [--include-unverified]';

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive whole number, got ${JSON.stringify(value)}`);
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

const num = (x) => (x === null || x === undefined ? '-' : String(Math.round(x)));

function exitCodeFor(result, stderr) {
  if (result.leaks > 0) {
    stderr.write(`LEAK: ${result.leaks} shown messages were at or after askAtSeq; see the "leaked" field in ${path.join(result.dir, 'records.jsonl')}\n`);
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
    recall: { type: 'string', multiple: true },
    seed: { type: 'string' },
    'include-unverified': { type: 'boolean', default: false }
  },
  exitCodeFor,
  positiveInt,
  async run(ctx, values) {
    if (!values.adapters) throw new UsageError(USAGE);
    const adapterNames = values.adapters.split(',').map((s) => s.trim()).filter(Boolean);
    const adapterConfig = {
      'kl-recall': { recall: parseRecallPairs(values.recall) },
      'sliding-window': values['window-tokens'] ? { windowTokens: positiveInt(values['window-tokens'], 'window-tokens') } : {}
    };
    const result = await runBenchmark({
      home: ctx.home,
      dataRoot: values.sessions ? path.resolve(ctx.cwd, values.sessions) : ctx.home.root,
      sessionIds: values.session || null,
      adapterNames,
      adapterConfig,
      budgetTokens: values['budget-tokens'] ? positiveInt(values['budget-tokens'], 'budget-tokens') : 6000,
      seed: values.seed ? positiveInt(values.seed, 'seed') : 1,
      includeUnverified: values['include-unverified'],
      now: ctx.now
    });
    ctx.stdout.write(`run ${result.runId} -> ${result.dir}\n`);
    if (result.config.includeUnverified) ctx.stdout.write('UNVERIFIED QUESTIONS INCLUDED: a smoke run, not a result.\n');
    for (const [name, s] of Object.entries(result.summary)) {
      const er = s.evidenceRecall === null ? '-' : s.evidenceRecall.toFixed(3);
      ctx.stdout.write(`${name.padEnd(16)} evidence recall ${er} (n=${s.scored})  median ${num(s.estTokens.median)} tokens  p90 ${num(s.estTokens.p90)}  errors ${s.errors}  leaks ${s.leaks}\n`);
    }
    ctx.stdout.write(`summary: ${path.join(result.dir, 'summary.md')}\n`);
    return exitCodeFor(result, ctx.stderr);
  }
};
```

In `src/longhaul/cli.js`:

```js
const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import'),
  synth: require('./commands/synth'),
  run: require('./commands/run')
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-run.test.js tests/longhaul-smoke.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/scoring.js src/longhaul/run.js src/longhaul/commands/run.js src/longhaul/cli.js tests/longhaul-run.test.js tests/longhaul-smoke.test.js
git commit -m "feat(longhaul): run scores evidence recall per adapter, kind and distance"
```

---

## Task 10: Providers from environment keys

The spec's §12 row "provider-factory usable from the CLI with keys from environment variables, without the vault". The key names already live in `scripts/smoke-providers.js`; they move to `src/providers/env-keys.js` so the script and LongHaul share them.

**Files:**
- Create: `src/providers/env-keys.js`, `src/longhaul/model.js`
- Modify: `src/providers/provider-factory.js` (add `fromEnv`), `scripts/smoke-providers.js` (use `env-keys.js`)
- Test: `tests/longhaul-model.test.js`

**Interfaces:**
- Consumes: `ProviderFactory`, `oneShot` (`src/providers/one-shot.js`), `startFakeLlmServer` (`tests/helpers/fake-llm-server.js`); `UsageError` (Task 1).
- Produces:
  - `src/providers/env-keys.js`: `PROVIDER_KEY_ENV` (provider → env var names, the first set one wins) and `keyFromEnv(provider, env) → { name, value } | null`.
  - `ProviderFactory.fromEnv(providerType, { env = process.env, options = {} }) → provider`. It throws `code: 'NO_PROVIDER_KEY'` naming the variables, or `code: 'UNKNOWN_PROVIDER'`. Ollama needs no key.
  - `src/longhaul/model.js`: `createModelClient({ provider, model, env, options, providerInstance }) → { provider, model, complete(prompt, { maxTokens = 800 }) → Promise<{ text, llmMetrics }> }`. It makes one `oneShot` call with `temperature: 0`. A missing key or unknown provider becomes a `UsageError`.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-model.test.js`:

```js
// tests/longhaul-model.test.js
// Providers from environment keys (benchmark spec §12) and LongHaul's model
// client. Never touches the network: a fake provider or the local fake server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const ProviderFactory = require('../src/providers/provider-factory');
const { PROVIDER_KEY_ENV, keyFromEnv } = require('../src/providers/env-keys');
const { KEY_ENV } = require('../scripts/smoke-providers');
const { createModelClient } = require('../src/longhaul/model');
const { UsageError } = require('../src/longhaul/errors');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');

describe('keys from the environment', () => {
  it('takes the first variable that is set and ignores blank ones', () => {
    assert.deepStrictEqual(keyFromEnv('gemini', { GOOGLE_GENERATIVE_AI_API_KEY: 'g-123456789' }), { name: 'GOOGLE_GENERATIVE_AI_API_KEY', value: 'g-123456789' });
    assert.strictEqual(keyFromEnv('gemini', { GEMINI_API_KEY: 'a-123456789', GOOGLE_GENERATIVE_AI_API_KEY: 'b-123456789' }).name, 'GEMINI_API_KEY');
    assert.strictEqual(keyFromEnv('openai', { OPENAI_API_KEY: '   ' }), null);
    assert.strictEqual(KEY_ENV, PROVIDER_KEY_ENV, 'the smoke script shares the table');
  });

  it('builds a provider from the environment, or says which variable to set', () => {
    assert.throws(() => ProviderFactory.fromEnv('openai', { env: {} }), (err) => err.code === 'NO_PROVIDER_KEY' && /OPENAI_API_KEY/.test(err.message));
    assert.throws(() => ProviderFactory.fromEnv('nope', { env: {} }), (err) => err.code === 'UNKNOWN_PROVIDER');
    assert.strictEqual(ProviderFactory.fromEnv('ollama', { env: {} }).getName(), 'ollama');
    assert.strictEqual(ProviderFactory.fromEnv('openai', { env: { OPENAI_API_KEY: 'test-key-123456' } }).apiKey, 'test-key-123456');
  });
});

describe('createModelClient', () => {
  it('makes one tool-less call at temperature 0 and returns the streamed text', async () => {
    const calls = [];
    const fake = {
      async streamMessage(messages, options, onChunk) {
        calls.push({ messages, options });
        onChunk('{"a":');
        onChunk('1}');
        return { content: '', llmMetrics: { model: options.model } };
      }
    };
    const client = createModelClient({ model: 'm-1', providerInstance: fake });
    const out = await client.complete('hello');
    assert.strictEqual(out.text, '{"a":1}');
    assert.deepStrictEqual(calls[0].messages, [{ role: 'user', content: 'hello' }]);
    assert.deepStrictEqual(calls[0].options, { model: 'm-1', temperature: 0, max_tokens: 800 });
  });

  it('turns a missing key, an unknown provider or a missing model into a usage error', () => {
    assert.throws(() => createModelClient({ provider: 'openai', model: 'm', env: {} }), (err) => err instanceof UsageError && /OPENAI_API_KEY/.test(err.message));
    assert.throws(() => createModelClient({ provider: 'nope', model: 'm', env: {} }), UsageError);
    assert.throws(() => createModelClient({ provider: 'openai', env: { OPENAI_API_KEY: 'test-key-123456' } }), UsageError);
  });

  describe('against the local fake server', () => {
    let server;
    before(async () => { server = await startFakeLlmServer(); });
    after(async () => { await server.close(); });

    it('streams a reply through a real provider class', async () => {
      const client = createModelClient({
        provider: 'openai', model: 'test-model',
        env: { OPENAI_API_KEY: 'test-key-123456' },
        options: { baseUrl: `${server.url}/openai/v1` }
      });
      assert.strictEqual((await client.complete('hi')).text, 'Hello there');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-model.test.js`
Expected: FAIL with `Cannot find module '../src/providers/env-keys'`.

- [ ] **Step 3: Write `src/providers/env-keys.js`**

```js
'use strict';
// Environment variables that hold each provider's API key, for hosts with no
// vault: scripts/smoke-providers.js and the LongHaul CLI. The first variable
// that is set wins. Ollama needs no key.
const PROVIDER_KEY_ENV = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  copilot: ['GITHUB_TOKEN']
});

function keyFromEnv(provider, env = process.env) {
  const names = PROVIDER_KEY_ENV[String(provider || '').toLowerCase()] || [];
  const name = names.find((n) => typeof env[n] === 'string' && env[n].trim());
  return name ? { name, value: env[name].trim() } : null;
}

module.exports = { PROVIDER_KEY_ENV, keyFromEnv };
```

- [ ] **Step 4: Add `ProviderFactory.fromEnv`**

In `src/providers/provider-factory.js`, add after the provider requires:

```js
const { PROVIDER_KEY_ENV, keyFromEnv } = require('./env-keys');
```

and add this static method after `createProvider`:

```js
  // A provider for a host with no vault (the LongHaul CLI, scripts): the key
  // comes from the environment (src/providers/env-keys.js). Ollama needs none.
  static fromEnv(providerType, { env = process.env, options = {} } = {}) {
    const key = (providerType || '').toLowerCase();
    if (key === 'ollama') return ProviderFactory.create(key, '', options);
    const names = PROVIDER_KEY_ENV[key];
    if (!names) {
      const err = new Error(`No environment variable is known for provider "${providerType}". Known: ${Object.keys(PROVIDER_KEY_ENV).join(', ')}, ollama`);
      err.code = 'UNKNOWN_PROVIDER';
      throw err;
    }
    const found = keyFromEnv(key, env);
    if (!found) {
      const err = new Error(`No API key for ${key} in the environment: set ${names.join(' or ')}.`);
      err.code = 'NO_PROVIDER_KEY';
      throw err;
    }
    return ProviderFactory.create(key, found.value, options);
  }
```

- [ ] **Step 5: Point `scripts/smoke-providers.js` at the shared table**

Replace the `const KEY_ENV = Object.freeze({ ... });` block with:

```js
const { PROVIDER_KEY_ENV: KEY_ENV } = require('../src/providers/env-keys');
```

`selectTargets` and `module.exports = { selectTargets, KEY_ENV }` stay as they are.

- [ ] **Step 6: Write `src/longhaul/model.js`**

```js
'use strict';
// The one model call LongHaul makes in stage B0 (authoring, benchmark spec
// §6): one prompt in, text out, through the regular providers with the key
// from the environment, no vault. Tests pass providerInstance, a fake with
// streamMessage.
const ProviderFactory = require('../providers/provider-factory');
const { oneShot } = require('../providers/one-shot');
const { UsageError } = require('./errors');

function createModelClient({ provider, model, env = process.env, options = {}, providerInstance = null } = {}) {
  if (!model) throw new UsageError('--model is required.');
  let instance = providerInstance;
  if (!instance) {
    if (!provider) throw new UsageError('--provider is required.');
    try {
      instance = ProviderFactory.fromEnv(provider, { env, options });
    } catch (err) {
      if (err.code === 'NO_PROVIDER_KEY' || err.code === 'UNKNOWN_PROVIDER' || /Invalid API key/.test(err.message)) throw new UsageError(err.message);
      throw err;
    }
  }
  return {
    provider: provider || 'injected',
    model,
    async complete(prompt, { maxTokens = 800 } = {}) {
      const { text, llmMetrics } = await oneShot(instance, [{ role: 'user', content: prompt }], { model, temperature: 0, max_tokens: maxTokens });
      return { text, llmMetrics };
    }
  };
}

module.exports = { createModelClient };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/longhaul-model.test.js tests/providers-fake-server.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/providers/env-keys.js src/providers/provider-factory.js scripts/smoke-providers.js src/longhaul/model.js tests/longhaul-model.test.js
git commit -m "feat(providers): providers from environment keys; LongHaul model client"
```

---

## Task 11: Stratified sampling for authoring

**Files:**
- Create: `src/longhaul/sampling.js`
- Test: `tests/longhaul-sampling.test.js`

**Interfaces:**
- Consumes: `createRng` (Task 6); `KINDS`, `BUCKETS`, `NO_BUCKET`, `bucketFor` (Task 4); `messageText`, `SessionIndex` (Task 2); `generateSynthetic`, `SYNTH_FIXTURES` (Task 6); `UsageError` (Task 1).
- Produces: `src/longhaul/sampling.js`:
  - `ANCHOR_SENDERS`: `user-said` uses user messages, `tool-observed` tool results, and `decision`, `superseded` and `multi-hop` use assistant or user messages.
  - `SPAN_RADIUS = 10`, so the model sees the anchor with 20 messages of surrounding context (spec §6).
  - `planAuthoring(index, { count, seed, kinds = KINDS, excludeSeqs = [] }) → { items: [{ kind, bucket, anchorSeq, askAtSeq, spanFrom, spanTo }], shortfall: [{ kind, bucket }] }`.
  - Allocation: `count` is split evenly by kind, then each non-abstain kind's share evenly across the five distance buckets; seeded remainders.
  - An item's anchor is a message of an allowed sender with at least 40 characters, not in `excludeSeqs`. Its `askAtSeq` is a user message whose distance from the anchor falls in the target bucket. Its span is the anchor ±10, clipped below `askAtSeq`.
  - `abstain` items have `anchorSeq: null`, `bucket: 'none'` and the 20 messages before `askAtSeq` as their span.
  - What the session cannot hold (for example, no anchor 1M tokens back) is listed in `shortfall`, never faked.
  - Deterministic for a seed.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-sampling.test.js`:

```js
// tests/longhaul-sampling.test.js
// Stratified authoring samples (benchmark spec §6): by kind and by distance
// bucket, seeded, so the set is not dominated by recent prose.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { planAuthoring, ANCHOR_SENDERS } = require('../src/longhaul/sampling');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { bucketFor, KINDS } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');

// synth-medium: about 1,100 messages and 110K estimated tokens.
const { index } = generateSynthetic(SYNTH_FIXTURES[1]);

describe('planAuthoring', () => {
  it('is deterministic for a seed and changes with it', () => {
    assert.deepStrictEqual(planAuthoring(index, { count: 60, seed: 1 }), planAuthoring(index, { count: 60, seed: 1 }));
    assert.notDeepStrictEqual(planAuthoring(index, { count: 60, seed: 1 }).items, planAuthoring(index, { count: 60, seed: 2 }).items);
  });

  it('splits the count evenly by kind, and lists what the session cannot hold as shortfall', () => {
    const { items, shortfall } = planAuthoring(index, { count: 60, seed: 1 });
    assert.strictEqual(items.length + shortfall.length, 60);
    for (const k of KINDS) {
      const n = items.filter((i) => i.kind === k).length + shortfall.filter((s) => s.kind === k).length;
      assert.strictEqual(n, 10, k);
    }
    assert.ok(items.every((i) => i.bucket !== '200K-1M' && i.bucket !== '>1M'), 'nothing is 200K tokens back in a 110K session');
    assert.ok(shortfall.some((s) => s.bucket === '>1M'));
    assert.ok(items.some((i) => i.bucket === '50K-200K'));
  });

  it('places every item at a user message, after its anchor, in its bucket, with a span before askAtSeq', () => {
    const { items } = planAuthoring(index, { count: 60, seed: 3 });
    for (const item of items) {
      assert.strictEqual(index.get(item.askAtSeq).sender, 'user');
      assert.ok(item.spanFrom >= 1 && item.spanFrom <= item.spanTo && item.spanTo < item.askAtSeq, JSON.stringify(item));
      if (item.kind === 'abstain') {
        assert.strictEqual(item.anchorSeq, null);
        assert.strictEqual(item.bucket, 'none');
        continue;
      }
      assert.ok(item.anchorSeq < item.askAtSeq);
      assert.ok(item.anchorSeq >= item.spanFrom && item.anchorSeq <= item.spanTo);
      assert.ok(ANCHOR_SENDERS[item.kind].includes(index.get(item.anchorSeq).sender));
      assert.strictEqual(bucketFor({ estTokens: index.tokensBetween(item.anchorSeq, item.askAtSeq) }), item.bucket);
    }
  });

  it('never repeats an anchor and question pair, and skips excluded anchors', () => {
    const first = planAuthoring(index, { count: 60, seed: 4 });
    const pairs = first.items.filter((i) => i.anchorSeq !== null).map((i) => `${i.anchorSeq}:${i.askAtSeq}`);
    assert.strictEqual(new Set(pairs).size, pairs.length);
    const excluded = first.items.map((i) => i.anchorSeq).filter((s) => s !== null);
    const second = planAuthoring(index, { count: 60, seed: 4, excludeSeqs: excluded });
    assert.ok(second.items.every((i) => !excluded.includes(i.anchorSeq)));
  });

  it('refuses a count that is not a positive whole number', () => {
    assert.throws(() => planAuthoring(index, { count: 0, seed: 1 }), UsageError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-sampling.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/sampling'`.

- [ ] **Step 3: Write `src/longhaul/sampling.js`**

```js
'use strict';
// Stratified sampling for authoring (benchmark spec §6): evidence anchors and
// question points by kind and by distance bucket, from a seeded RNG, so the
// set is not dominated by recent prose. A cell the session cannot fill is
// reported as shortfall, never faked.
const { createRng } = require('./rng');
const { KINDS, BUCKETS, NO_BUCKET } = require('./questions');
const { messageText } = require('./session-format');
const { UsageError } = require('./errors');

const ANCHOR_SENDERS = Object.freeze({
  'user-said': ['user'],
  'tool-observed': ['toolResult'],
  decision: ['assistant', 'user'],
  superseded: ['user', 'assistant'],
  'multi-hop': ['user', 'assistant']
});
const SPAN_RADIUS = 10;
const MIN_ANCHOR_CHARS = 40;
const PAIR_TRIES = 25;

function splitEvenly(total, parts, rng) {
  const base = Math.floor(total / parts);
  const out = new Array(parts).fill(base);
  const order = rng.shuffle([...out.keys()]);
  for (let i = 0; i < total - base * parts; i++) out[order[i]] += 1;
  return out;
}

// First position in a sorted array where a monotone predicate turns true.
function lowerBound(arr, pred) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid])) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// User messages after the anchor whose distance from it falls in the bucket.
function askCandidates(index, anchorSeq, bucket) {
  const users = index.userSeqs;
  const from = lowerBound(users, (u) => u > anchorSeq && index.tokensBetween(anchorSeq, u) >= bucket.min);
  const to = lowerBound(users, (u) => u > anchorSeq && index.tokensBetween(anchorSeq, u) >= bucket.max);
  return users.slice(from, to);
}

function planAuthoring(index, { count, seed, kinds = KINDS, excludeSeqs = [] }) {
  if (!Number.isInteger(count) || count <= 0) throw new UsageError('--count must be a positive whole number');
  const rng = createRng(seed);
  const exclude = new Set(excludeSeqs);
  const perKind = splitEvenly(count, kinds.length, rng);
  const items = [];
  const shortfall = [];
  const usedPairs = new Set();
  const usedAbstain = new Set();

  kinds.forEach((kind, k) => {
    if (kind === 'abstain') {
      for (let i = 0; i < perKind[k]; i++) {
        const free = index.userSeqs.filter((u) => u > 2 * SPAN_RADIUS && !usedAbstain.has(u));
        if (!free.length) { shortfall.push({ kind, bucket: NO_BUCKET }); continue; }
        const askAtSeq = rng.pick(free);
        usedAbstain.add(askAtSeq);
        items.push({ kind, bucket: NO_BUCKET, anchorSeq: null, askAtSeq, spanFrom: askAtSeq - 2 * SPAN_RADIUS, spanTo: askAtSeq - 1 });
      }
      return;
    }
    const anchors = index.messages
      .filter((m) => ANCHOR_SENDERS[kind].includes(m.sender) && messageText(m).trim().length >= MIN_ANCHOR_CHARS && !exclude.has(m.seq))
      .map((m) => m.seq);
    const perBucket = splitEvenly(perKind[k], BUCKETS.length, rng);
    BUCKETS.forEach((bucket, b) => {
      if (perBucket[b] === 0) return;
      const eligible = anchors.filter((a) => askCandidates(index, a, bucket).length > 0);
      for (let i = 0; i < perBucket[b]; i++) {
        let placed = null;
        for (let t = 0; t < PAIR_TRIES && eligible.length && !placed; t++) {
          const anchorSeq = rng.pick(eligible);
          const askAtSeq = rng.pick(askCandidates(index, anchorSeq, bucket));
          const key = `${anchorSeq}:${askAtSeq}`;
          if (usedPairs.has(key)) continue;
          usedPairs.add(key);
          placed = {
            kind, bucket: bucket.id, anchorSeq, askAtSeq,
            spanFrom: Math.max(1, anchorSeq - SPAN_RADIUS),
            spanTo: Math.min(askAtSeq - 1, anchorSeq + SPAN_RADIUS)
          };
        }
        if (placed) items.push(placed);
        else shortfall.push({ kind, bucket: bucket.id });
      }
    });
  });
  return { items, shortfall };
}

module.exports = { ANCHOR_SENDERS, SPAN_RADIUS, planAuthoring };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/longhaul-sampling.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/longhaul/sampling.js tests/longhaul-sampling.test.js
git commit -m "feat(longhaul): stratified, seeded sampling of authoring spans by kind and distance"
```

---

## Task 12: `longhaul author`

**Files:**
- Create: `src/longhaul/prompts/author-v1.md`, `src/longhaul/author.js`, `src/longhaul/commands/author.js`
- Modify: `src/longhaul/cli.js` (register `author`)
- Test: `tests/longhaul-author.test.js`

**Interfaces:**
- Consumes: `planAuthoring` (Task 11); `createModelClient` (Task 10); `validateQuestion`, `normalizeQuestion`, `readQuestions`, `writeQuestions`, `questionsFile`, `validateQuestionSet` (Task 4); `messageText`, `senderLabel`, `loadSession`, `sessionDir` (Task 2); `sha256Text` (Task 2); `positiveInt` (Task 9); `writeSyntheticRoot`, `generateSynthetic`, `SYNTH_FIXTURES` (Task 6); `startFakeLlmServer`.
- Produces:
  - `src/longhaul/author.js`: `DEFAULT_PROMPT` (path of `prompts/author-v1.md`), `KIND_RULES`, `fillPrompt(template, item, index) → string`, `parseReply(text) → object|null` (tolerates code fences and prose around one JSON object), `authorCandidates({ session, plan, client, sessionId, existing = [], promptPath, maxTokens = 800 }) → Promise<{ candidates, rejected: [{ item, reason, detail? }], promptSha256 }>`.
    - Rejection reasons are `model-error`, `unparsed`, `model-skipped`, `evidence-outside-span` and `invalid`.
    - Candidates are normalized with `authoredBy: 'generated'` and `verifiedBy: null`. For `abstain`, the evidence is forced to `[]` and the answer to `not in the session`.
    - Ids continue the session's `<sessionId>-gNNNN` series.
  - CLI `longhaul author --session <id> --provider <p> --model <m> [--base-url <url>] [--count 60] [--seed 1] [--send-private]`:
    - It appends candidates to `questions/<id>.jsonl`.
    - It appends one line to `questions/<id>.author-log.jsonl`: `{ at, prompt, promptSha256, provider, model, seed, count, planned, shortfall, written, rejected: { [reason]: n } }`.
    - For a private session it refuses, before creating the model client and before any model call, unless `--send-private` is passed: `UsageError` (exit 2) naming the session, the provider and the flag; nothing is written. With `--send-private` it prints a note on stderr that the session's spans are sent to the provider (owner decision 2026-09-29).
    - Anchors already used as evidence by existing questions are excluded, so a second run with a new `--seed` adds different questions.

- [ ] **Step 1: Write the prompt file**

Create `src/longhaul/prompts/author-v1.md` (its SHA-256 is recorded in every author log line; edit it only by adding `author-v2.md`):

```markdown
You write one question for a benchmark that tests memory over a long agent session.

The question will be asked at message #{{askAtSeq}}, in place of the owner's message there. It must be answerable only from the messages below, which all come before #{{askAtSeq}}.

Kind: {{kind}}
Rule for this kind: {{kindRule}}

Constraints:
- evidenceSeqs lists the message numbers (the # numbers in the headers below) that hold the answer. Use only messages shown below.
- Ask about one specific fact: a value, a name, a path, a count, or a decision and its reason. Never ask about something that can only be guessed.
- Keep the answer short. acceptableAnswers lists other short strings that are also correct.
- Phrase the question the way the owner would ask it later, without quoting the messages.
- For kind abstain: ask about something plausible for this session that is never stated in it. The answer is "not in the session" and evidenceSeqs is [].
- If the messages hold no good question of this kind, reply {"skip": "<why>"}.

Reply with one JSON object and nothing else:
{"question": "...", "answer": "...", "acceptableAnswers": ["..."], "evidenceSeqs": [123], "notes": "..."}

Messages:

{{span}}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/longhaul-author.test.js`:

```js
// tests/longhaul-author.test.js
// Minimal authoring (benchmark spec §6) with a scripted fake model; the CLI
// path runs against the local fake server. No network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { authorCandidates, parseReply, DEFAULT_PROMPT } = require('../src/longhaul/author');
const { planAuthoring } = require('../src/longhaul/sampling');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { validateQuestionSet, readQuestions, questionsFile } = require('../src/longhaul/questions');
const { sha256Text } = require('../src/longhaul/files');
const { main } = require('../src/longhaul/cli');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

// A fake model that reads the span headers in the prompt and cites messages
// of the right sender for the kind it was asked for.
function fakeReply(prompt) {
  const kind = /^Kind: (\S+)$/m.exec(prompt)[1];
  const headers = [...prompt.matchAll(/^\[#(\d+) ([^\]]+)\]$/gm)].map((m) => ({ seq: Number(m[1]), label: m[2] }));
  const pick = (pred, n = 1) => headers.filter(pred).slice(0, n).map((h) => h.seq);
  const prose = (h) => h.label === 'user' || h.label === 'assistant';
  const evidence = {
    'user-said': pick((h) => h.label === 'user'),
    'tool-observed': pick((h) => h.label.endsWith(' result')),
    decision: pick((h) => h.label === 'assistant'),
    superseded: pick(prose, 2),
    'multi-hop': pick(prose, 2),
    abstain: []
  }[kind];
  return JSON.stringify({ question: `A question about ${kind}?`, answer: 'an answer', acceptableAnswers: ['answer'], evidenceSeqs: evidence, notes: 'fake' });
}
function scripted(reply = fakeReply) {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-1', prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return { text: reply(prompt, prompts.length) };
    }
  };
}

// Marks a synthetic session private, as `longhaul import` would a real one.
function makePrivate(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, private: true, license: 'private' }, null, 2)}\n`);
}

const gen = generateSynthetic(SYNTH_FIXTURES[1]);
const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
const SID = 'synth-medium';
// 30 = 5 per kind = one per distance bucket, so every kind has items in the
// buckets synth-medium can hold.
const plan = planAuthoring(session.index, { count: 30, seed: 5 });

describe('authorCandidates', () => {
  it('writes valid, unverified, generated candidates and records the prompt hash', async () => {
    const out = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    assert.strictEqual(out.rejected.length, 0, JSON.stringify(out.rejected));
    assert.strictEqual(out.candidates.length, plan.items.length);
    assert.deepStrictEqual(validateQuestionSet(out.candidates, { index: session.index, sessionId: SID }), []);
    assert.ok(out.candidates.every((q) => q.authoredBy === 'generated' && q.verifiedBy === null));
    assert.deepStrictEqual(out.candidates.map((q) => q.id).slice(0, 2), [`${SID}-g0001`, `${SID}-g0002`]);
    assert.strictEqual(out.promptSha256, sha256Text(fs.readFileSync(DEFAULT_PROMPT, 'utf8')));
  });

  it('shows the kind rule and askAtSeq, and only messages before askAtSeq', async () => {
    const client = scripted();
    await authorCandidates({ session, plan, client, sessionId: SID });
    client.prompts.forEach((prompt, i) => {
      const item = plan.items[i];
      assert.match(prompt, new RegExp(`^Kind: ${item.kind}$`, 'm'));
      assert.ok(prompt.includes(`message #${item.askAtSeq}`));
      const seqs = [...prompt.matchAll(/^\[#(\d+) /gm)].map((m) => Number(m[1]));
      assert.ok(seqs.length > 0 && seqs.every((s) => s < item.askAtSeq));
    });
  });

  it('is deterministic for the same plan and replies', async () => {
    const a = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    const b = await authorCandidates({ session, plan, client: scripted(), sessionId: SID });
    assert.deepStrictEqual(a.candidates, b.candidates);
  });

  it('rejects a bad reply without stopping, and keeps the good one', async () => {
    const item = plan.items.find((i) => i.kind === 'user-said');
    const toolResult = [];
    for (let s = item.spanFrom; s <= item.spanTo; s++) if (session.index.get(s).sender === 'toolResult') toolResult.push(s);
    const replies = [
      () => 'I cannot do that.',
      () => '{"skip": "nothing specific here"}',
      () => JSON.stringify({ question: 'Q?', answer: 'A', evidenceSeqs: [item.askAtSeq] }),
      () => JSON.stringify({ question: 'Q?', answer: 'A', evidenceSeqs: [toolResult[0]] }),
      () => { throw new Error('rate limited'); },
      (prompt) => `Here you go:\n\`\`\`json\n${fakeReply(prompt)}\n\`\`\``
    ];
    const client = {
      provider: 'fake', model: 'fake-1',
      calls: 0,
      async complete(prompt) { const r = replies[this.calls++](prompt); return { text: r }; }
    };
    const out = await authorCandidates({ session, plan: { items: replies.map(() => item), shortfall: [] }, client, sessionId: SID });
    assert.deepStrictEqual(out.rejected.map((r) => r.reason), ['unparsed', 'model-skipped', 'evidence-outside-span', 'invalid', 'model-error']);
    assert.match(out.rejected[3].detail, /evidence-sender/);
    assert.strictEqual(out.candidates.length, 1);
  });

  it('forces an abstain candidate to have no evidence and the abstain answer', async () => {
    const item = plan.items.find((i) => i.kind === 'abstain');
    const client = scripted(() => JSON.stringify({ question: 'Which cache port did we pick?', answer: '18000', evidenceSeqs: [item.spanFrom] }));
    const out = await authorCandidates({ session, plan: { items: [item], shortfall: [] }, client, sessionId: SID });
    assert.deepStrictEqual(out.candidates[0].evidenceSeqs, []);
    assert.strictEqual(out.candidates[0].answer, 'not in the session');
  });

  it('continues the id series after existing questions', async () => {
    const existing = [{ id: `${SID}-g0003` }, { id: `${SID}-007` }];
    const out = await authorCandidates({ session, plan, client: scripted(), sessionId: SID, existing });
    assert.strictEqual(out.candidates[0].id, `${SID}-g0004`);
  });
});

describe('parseReply', () => {
  it('finds one JSON object inside fences or prose, and returns null otherwise', () => {
    assert.deepStrictEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(parseReply('Sure. {"a":{"b":2}} Done.'), { a: { b: 2 } });
    assert.strictEqual(parseReply('[1,2]'), null);
    assert.strictEqual(parseReply('no json here'), null);
    assert.strictEqual(parseReply('{"a":'), null);
  });
});

describe('longhaul author CLI', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('says which environment variable is missing, with exit 2', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const stderr = sink();
    const code = await main(['author', '--session', 'synth-small', '--provider', 'openai', '--model', 'm'], { stdout: sink(), stderr, env });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /OPENAI_API_KEY/);
  });

  it('calls the model through a real provider and logs the run; unusable replies write nothing', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const before = await readQuestions(questionsFile(root, 'synth-small'));
    const stdout = sink();
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6', '--seed', '2'
    ], { stdout, stderr: sink(), env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 0);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].promptSha256, sha256Text(fs.readFileSync(DEFAULT_PROMPT, 'utf8')));
    assert.strictEqual(log[0].written, 0);
    assert.strictEqual(log[0].rejected.unparsed, log[0].planned);
    assert.strictEqual(log[0].seed, 2);
    assert.deepStrictEqual(await readQuestions(questionsFile(root, 'synth-small')), before);
    assert.match(stdout.text, /longhaul verify --session synth-small/);
  });

  it('refuses a private session without --send-private: exit 2, no model call, nothing written', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const before = await readQuestions(questionsFile(root, 'synth-small'));
    const stderr = sink();
    const calls = server.requests.length;
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6'
    ], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /synth-small is private/);
    assert.match(stderr.text, /--send-private/);
    assert.strictEqual(server.requests.length, calls, 'no span reached a model');
    assert.ok(!fs.existsSync(path.join(root, 'questions', 'synth-small.author-log.jsonl')));
    assert.deepStrictEqual(await readQuestions(questionsFile(root, 'synth-small')), before);
  });

  it('with --send-private, authors a private session and says its spans go to the provider', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const stderr = sink();
    const calls = server.requests.length;
    const code = await main([
      'author', '--session', 'synth-small', '--provider', 'openai', '--model', 'test-model',
      '--base-url', `${server.url}/openai/v1`, '--count', '6', '--send-private'
    ], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: 'test-key-123456' } });
    assert.strictEqual(code, 0, stderr.text);
    assert.ok(server.requests.length > calls, 'the spans went to the provider');
    assert.match(stderr.text, /spans of private session synth-small are sent to openai \(test-model\)/);
    const log = fs.readFileSync(path.join(root, 'questions', 'synth-small.author-log.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(log.length, 1);
  });
});
```

The fake server streams `Hello there` for every chat completion, so each reply is unparsable. That proves the wiring from CLI to provider to log without a real model.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/longhaul-author.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/author'`.

- [ ] **Step 4: Write `src/longhaul/author.js`**

```js
'use strict';
// Minimal authoring for stage B0 (benchmark spec §6): one prompt per planned
// item, candidates written with authoredBy "generated" and verifiedBy null.
// A candidate must cite only messages it was shown and pass the §5
// validator; anything else is rejected with a reason, and the run goes on.
const fs = require('fs');
const path = require('path');
const { messageText, senderLabel } = require('./session-format');
const { validateQuestion, normalizeQuestion } = require('./questions');
const { sha256Text } = require('./files');

const DEFAULT_PROMPT = path.join(__dirname, 'prompts', 'author-v1.md');
const SPAN_MESSAGE_CHARS = 2000;
const ABSTAIN_ANSWER = 'not in the session';
const KIND_RULES = Object.freeze({
  'user-said': 'The owner stated it in a user message; the answer is a quote or paraphrase. Evidence: user messages only.',
  'tool-observed': 'The fact appeared only in tool output (a port, a path, a count, an error string). Evidence: tool result messages only.',
  decision: 'What was decided and why; the answer includes the reason. Evidence: assistant or user messages.',
  superseded: 'A value changed; the answer is the latest value. Evidence: at least two messages, the earlier value and the later one.',
  'multi-hop': 'The answer needs two facts from two different messages. Evidence: at least two messages.',
  abstain: 'The fact is never stated in the session; the answer is "not in the session". Evidence: none.'
});

function clipRendered(m) {
  const text = messageText(m);
  const body = text.length > SPAN_MESSAGE_CHARS
    ? `${text.slice(0, SPAN_MESSAGE_CHARS)}\n[... ${text.length - SPAN_MESSAGE_CHARS} more characters]`
    : text;
  return `[#${m.seq} ${senderLabel(m)}]\n${body}`;
}

function fillPrompt(template, item, index) {
  const span = [];
  for (let s = item.spanFrom; s <= item.spanTo; s++) {
    const m = index.get(s);
    if (m) span.push(clipRendered(m));
  }
  // split/join rather than replace(): message text may contain "$&" and the like.
  return template
    .split('{{kind}}').join(item.kind)
    .split('{{kindRule}}').join(KIND_RULES[item.kind])
    .split('{{askAtSeq}}').join(String(item.askAtSeq))
    .split('{{span}}').join(span.join('\n\n'));
}

function parseReply(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(s.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function nextSerial(existing, sessionId) {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-g(\\d+)$`);
  let max = 0;
  for (const q of existing) {
    const m = re.exec(q.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function authorCandidates({ session, plan, client, sessionId, existing = [], promptPath = DEFAULT_PROMPT, maxTokens = 800 }) {
  const template = fs.readFileSync(promptPath, 'utf8');
  const promptSha256 = sha256Text(template);
  let serial = nextSerial(existing, sessionId);
  const candidates = [];
  const rejected = [];
  for (const item of plan.items) {
    let reply;
    try {
      reply = await client.complete(fillPrompt(template, item, session.index), { maxTokens });
    } catch (err) {
      rejected.push({ item, reason: 'model-error', detail: err.message });
      continue;
    }
    const parsed = parseReply(reply.text);
    if (!parsed) { rejected.push({ item, reason: 'unparsed' }); continue; }
    if (parsed.skip !== undefined) { rejected.push({ item, reason: 'model-skipped', detail: String(parsed.skip) }); continue; }
    const evidenceSeqs = item.kind === 'abstain' ? [] : (Array.isArray(parsed.evidenceSeqs) ? parsed.evidenceSeqs.map(Number) : []);
    const outside = evidenceSeqs.filter((s) => !(Number.isInteger(s) && s >= item.spanFrom && s <= item.spanTo));
    if (outside.length) { rejected.push({ item, reason: 'evidence-outside-span', detail: outside.join(',') }); continue; }
    const raw = {
      id: `${sessionId}-g${String(serial).padStart(4, '0')}`,
      sessionId,
      askAtSeq: item.askAtSeq,
      kind: item.kind,
      question: String(parsed.question ?? '').trim(),
      answer: item.kind === 'abstain' ? ABSTAIN_ANSWER : String(parsed.answer ?? '').trim(),
      acceptableAnswers: Array.isArray(parsed.acceptableAnswers) ? parsed.acceptableAnswers.filter((a) => typeof a === 'string' && a.trim()) : [],
      evidenceSeqs,
      supersededBy: null,
      authoredBy: 'generated',
      verifiedBy: null,
      notes: [`author-v1 ${item.bucket}`, typeof parsed.notes === 'string' ? parsed.notes.trim() : ''].filter(Boolean).join('; ')
    };
    const errors = validateQuestion(raw, { index: session.index, sessionId });
    if (errors.length) { rejected.push({ item, reason: 'invalid', detail: errors.join('; ') }); continue; }
    candidates.push(normalizeQuestion(raw, session.index));
    serial += 1;
  }
  return { candidates, rejected, promptSha256 };
}

module.exports = { DEFAULT_PROMPT, KIND_RULES, fillPrompt, parseReply, authorCandidates };
```

- [ ] **Step 5: Write `src/longhaul/commands/author.js` and register it**

```js
'use strict';
// `longhaul author --session <id> --provider <p> --model <m> [--base-url <url>] [--count 60] [--seed 1] [--send-private]`
// A private session's spans go to the model provider only with
// --send-private (owner decision 2026-09-29); without it the command refuses
// before it builds a model client, so nothing leaves the machine.
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir } = require('../session-format');
const { readQuestions, writeQuestions, questionsFile } = require('../questions');
const { planAuthoring } = require('../sampling');
const { authorCandidates, DEFAULT_PROMPT } = require('../author');
const { createModelClient } = require('../model');
const { positiveInt } = require('./run');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul author --session <id> --provider <provider> --model <model> [--base-url <url>] [--count 60] [--seed 1] [--send-private]';

module.exports = {
  options: {
    session: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    count: { type: 'string' },
    seed: { type: 'string' },
    'send-private': { type: 'boolean' }
  },
  async run(ctx, values) {
    if (!values.session || !values.provider || !values.model) throw new UsageError(USAGE);
    const count = values.count ? positiveInt(values.count, 'count') : 60;
    const seed = values.seed ? positiveInt(values.seed, 'seed') : 1;
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);

    const session = await loadSession(dir);
    if (session.manifest.private && values['send-private'] !== true) {
      throw new UsageError(
        `Session ${values.session} is private: authoring would send spans of it to ${values.provider} (${values.model}). `
        + 'Pass --send-private to allow that.',
        'PRIVATE_SESSION'
      );
    }
    const client = createModelClient({
      provider: values.provider, model: values.model, env: ctx.env,
      options: values['base-url'] ? { baseUrl: values['base-url'] } : {}
    });
    if (session.manifest.private) {
      ctx.stderr.write(`note: spans of private session ${values.session} are sent to ${values.provider} (${values.model}) to author questions (--send-private).\n`);
    }

    const file = questionsFile(ctx.home.root, values.session);
    const existing = await readQuestions(file);
    const plan = planAuthoring(session.index, { count, seed, excludeSeqs: existing.flatMap((q) => q.evidenceSeqs || []) });
    const out = await authorCandidates({ session, plan, client, sessionId: values.session, existing });
    writeQuestions(file, [...existing, ...out.candidates]);

    const rejected = {};
    for (const r of out.rejected) rejected[r.reason] = (rejected[r.reason] || 0) + 1;
    const logLine = {
      at: ctx.now().toISOString(), prompt: path.basename(DEFAULT_PROMPT), promptSha256: out.promptSha256,
      provider: client.provider, model: client.model, seed, count,
      planned: plan.items.length, shortfall: plan.shortfall.length, written: out.candidates.length, rejected
    };
    fs.appendFileSync(path.join(ctx.home.questions, `${values.session}.author-log.jsonl`), `${JSON.stringify(logLine)}\n`);

    ctx.stdout.write(`authored ${out.candidates.length} candidates for ${values.session}: ${plan.items.length} planned, `
      + `${plan.shortfall.length} short of the target, ${out.rejected.length} rejected\n`);
    for (const [reason, n] of Object.entries(rejected)) ctx.stdout.write(`  rejected ${reason}: ${n}\n`);
    ctx.stdout.write(`next: longhaul verify --session ${values.session} --reviewer <initials>\n`);
    return 0;
  }
};
```

In `src/longhaul/cli.js`:

```js
const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import'),
  synth: require('./commands/synth'),
  run: require('./commands/run'),
  author: require('./commands/author')
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/longhaul-author.test.js tests/longhaul-sampling.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/longhaul/prompts/author-v1.md src/longhaul/author.js src/longhaul/commands/author.js src/longhaul/cli.js tests/longhaul-author.test.js
git commit -m "feat(longhaul): author candidate questions with one versioned prompt"
```

---

## Task 13: `longhaul verify`

**Files:**
- Create: `src/longhaul/verify.js`, `src/longhaul/commands/verify.js`
- Modify: `src/longhaul/cli.js` (register `verify`)
- Test: `tests/longhaul-verify.test.js`

**Interfaces:**
- Consumes: `KINDS`, `validateQuestion`, `normalizeQuestion`, `computeDistance`, `bucketFor`, `isVerified`, `readQuestions`, `writeQuestions`, `questionsFile` (Task 4); `messageText`, `senderLabel`, `loadSession`, `sessionDir` (Task 2); `generateSynthetic`, `writeSyntheticRoot`, `SYNTH_FIXTURES` (Task 6); `UsageError` (Task 1).
- Produces:
  - `src/longhaul/verify.js`: `verifyLoop({ session, questions, reviewer, input, output, onSave(current, rejectedRecord|null), now }) → Promise<{ accepted, edited, rejected, skipped, stopped }>`.
    - It walks the questions whose `verifiedBy` is `null`, in `askAtSeq` order. For each it shows the question, answer, acceptable answers, the distance, the evidence messages and the message at `askAtSeq`, each clipped at 1,500 characters.
    - `a` accepts, which works only for a valid question and sets `verifiedBy: 'human:<reviewer>'`.
    - `e` edits the fields `question, answer, acceptableAnswers (a | b), evidenceSeqs (1,2 or -), askAtSeq, kind, supersededBy (- for none)`; a blank line keeps a field. An edit is saved only when valid, and is never accepted by itself.
    - `r` rejects with an optional reason; the record carries `rejectedBy`, `rejectReason` and `rejectedAt`.
    - `s` skips; `q` or end of input stops.
    - `onSave` runs after every accepted, rejected or valid edited question.
  - CLI `longhaul verify --session <id> --reviewer <initials>` writes `questions/<id>.jsonl` atomically on every save, appends rejects to `questions/<id>.rejected.jsonl`, and ends with the verified count per kind.

- [ ] **Step 1: Write the failing tests**

Create `tests/longhaul-verify.test.js`:

```js
// tests/longhaul-verify.test.js
// The verify loop (benchmark spec §6), driven with scripted input.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { verifyLoop } = require('../src/longhaul/verify');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { readQuestions, writeQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

function setup() {
  const gen = generateSynthetic(SYNTH_FIXTURES[0]);
  const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
  const questions = gen.questions.map((q) => ({ ...q, verifiedBy: null }));
  return { session, questions };
}
const input = (lines) => Readable.from([lines.map((l) => `${l}\n`).join('')]);
function recorder() {
  const saves = [];
  return { saves, onSave: (current, rejected) => saves.push({ current: current.map((q) => ({ ...q })), rejected }) };
}
const NOW = () => new Date('2026-09-29T12:00:00.000Z');

describe('verifyLoop', () => {
  it('accepts, rejects, edits, skips and quits, saving after every decision', async () => {
    const { session, questions } = setup();
    const pending = [...questions].sort((a, b) => a.askAtSeq - b.askAtSeq);
    const [q1, q2, q3] = pending;
    const restore = q3.evidenceSeqs.length ? q3.evidenceSeqs.join(',') : '-';
    const out = sink();
    const rec = recorder();
    const counts = await verifyLoop({
      session, questions, reviewer: 'TT', output: out, onSave: rec.onSave, now: NOW,
      input: input([
        'a',
        'r', 'too vague',
        'e', '', 'Edited answer', '', String(q3.askAtSeq), '', '', '',
        'e', '', '', '', restore, '', '', '',
        'a',
        's',
        'q'
      ])
    });
    assert.deepStrictEqual(counts, { accepted: 2, edited: 1, rejected: 1, skipped: 1, stopped: true });
    assert.strictEqual(rec.saves.length, 4);
    const last = rec.saves.at(-1).current;
    assert.strictEqual(last.find((q) => q.id === q1.id).verifiedBy, 'human:TT');
    assert.strictEqual(last.find((q) => q.id === q2.id), undefined);
    const edited = last.find((q) => q.id === q3.id);
    assert.strictEqual(edited.answer, 'Edited answer');
    assert.strictEqual(edited.verifiedBy, 'human:TT');
    assert.deepStrictEqual(edited.evidenceSeqs, q3.evidenceSeqs);
    for (const q of pending.slice(3)) assert.strictEqual(last.find((x) => x.id === q.id).verifiedBy, null);
    const { rejected } = rec.saves.find((s) => s.rejected);
    assert.deepStrictEqual(
      { id: rejected.id, by: rejected.rejectedBy, why: rejected.rejectReason, at: rejected.rejectedAt },
      { id: q2.id, by: 'human:TT', why: 'too vague', at: '2026-09-29T12:00:00.000Z' }
    );
    assert.match(out.text, /Not valid yet \(not saved\):\n {2}evidence-after-ask/);
  });

  it('shows the question, the evidence and the message at askAtSeq, clipping long text', async () => {
    const { session, questions } = setup();
    const q = questions.find((x) => x.kind === 'tool-observed');
    session.index.get(q.evidenceSeqs[0]).result = 'y'.repeat(5000);
    const out = sink();
    await verifyLoop({ session, questions: [q], reviewer: 'TT', output: out, onSave: () => {}, input: input(['q']) });
    assert.ok(out.text.includes(`Q: ${q.question}`));
    assert.ok(out.text.includes(`[#${q.evidenceSeqs[0]} Bash result`));
    assert.ok(out.text.includes('[... 3500 more characters]'));
    assert.ok(out.text.includes(`At #${q.askAtSeq}`));
  });

  it('refuses to accept an invalid question', async () => {
    const { session, questions } = setup();
    const q = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq] };
    const rec = recorder();
    const out = sink();
    const counts = await verifyLoop({ session, questions: [q], reviewer: 'TT', output: out, onSave: rec.onSave, input: input(['a', 'q']) });
    assert.match(out.text, /Cannot accept:/);
    assert.strictEqual(counts.accepted, 0);
    assert.strictEqual(rec.saves.length, 0);
  });

  it('keeps what was decided when the input ends', async () => {
    const { session, questions } = setup();
    const rec = recorder();
    const counts = await verifyLoop({ session, questions, reviewer: 'TT', output: sink(), onSave: rec.onSave, input: input(['a']) });
    assert.deepStrictEqual(counts, { accepted: 1, edited: 0, rejected: 0, skipped: 0, stopped: true });
    assert.strictEqual(rec.saves.length, 1);
  });

  it('requires reviewer initials', async () => {
    const { session, questions } = setup();
    for (const reviewer of ['', 'a b', undefined]) {
      await assert.rejects(verifyLoop({ session, questions, reviewer, output: sink(), onSave: () => {}, input: input([]) }), UsageError);
    }
  });
});

describe('longhaul verify CLI', () => {
  it('saves accepted questions, appends rejects to their own file and reports the verified count', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const file = questionsFile(root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    const stdout = sink();
    const code = await main(['verify', '--session', 'synth-small', '--reviewer', 'TT'], { stdin: input(['a', 'r', 'duplicate', 'q']), stdout, stderr: sink(), env });
    assert.strictEqual(code, 0);
    const after = await readQuestions(file);
    assert.strictEqual(after.length, 5);
    assert.strictEqual(after.filter((q) => q.verifiedBy === 'human:TT').length, 1);
    const rejected = fs.readFileSync(path.join(root, 'questions', 'synth-small.rejected.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(rejected.length, 1);
    assert.match(stdout.text, /verified for synth-small: 1 /);
  });

  it('refuses without --reviewer', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    assert.strictEqual(await main(['verify', '--session', 'synth-small'], { stdin: input([]), stdout: sink(), stderr: sink(), env }), 2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/longhaul-verify.test.js`
Expected: FAIL with `Cannot find module '../src/longhaul/verify'`.

- [ ] **Step 3: Write `src/longhaul/verify.js`**

```js
'use strict';
// The verify loop (benchmark spec §6): a reviewer accepts, edits or rejects
// each unverified candidate. Only a valid question can be accepted; an edit
// is saved only when valid and is never accepted by itself; progress is
// saved after every decision. The loop's own text is ASCII.
const readline = require('readline');
const { KINDS, validateQuestion, normalizeQuestion, computeDistance, bucketFor } = require('./questions');
const { messageText, senderLabel } = require('./session-format');
const { UsageError } = require('./errors');

const SHOW_CHARS = 1500;
const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FIELDS = Object.freeze([
  ['question', 'text'], ['answer', 'text'], ['acceptableAnswers', 'list'], ['evidenceSeqs', 'seqs'],
  ['askAtSeq', 'int'], ['kind', 'kind'], ['supersededBy', 'optint']
]);

function clip(text) {
  return text.length > SHOW_CHARS ? `${text.slice(0, SHOW_CHARS)}\n[... ${text.length - SHOW_CHARS} more characters]` : text;
}

function show(m) {
  return `  [#${m.seq} ${senderLabel(m)} ${m.timestamp}]\n${clip(messageText(m))}`;
}

function describeQuestion(q, index, position, total) {
  const seqs = Array.isArray(q.evidenceSeqs) ? q.evidenceSeqs : [];
  const d = seqs.length && seqs.every(Number.isInteger) ? computeDistance(index, q) : null;
  const where = d ? ` - ${d.messages} messages / ~${d.estTokens} tokens back (${bucketFor(d)})` : '';
  const lines = ['', `[${position}/${total}] ${q.id} - ${q.kind} - asked at #${q.askAtSeq}${where}`, `Q: ${q.question}`, `A: ${q.answer}`];
  if (q.acceptableAnswers?.length) lines.push(`Also accept: ${q.acceptableAnswers.join(' | ')}`);
  if (q.supersededBy) lines.push(`Superseded by #${q.supersededBy}`);
  if (q.notes) lines.push(`Notes: ${q.notes}`);
  lines.push('Evidence:');
  if (!seqs.length) lines.push('  (none)');
  for (const s of seqs) {
    const m = index.get(s);
    lines.push(m ? show(m) : `  #${s}: not in the session`);
  }
  const at = index.get(q.askAtSeq);
  lines.push(`At #${q.askAtSeq} (the question is asked in place of this message):`, at ? show(at) : '  (not in the session)');
  return `${lines.join('\n')}\n`;
}

function display(field, value) {
  if (field === 'acceptableAnswers') return (value || []).join(' | ');
  if (field === 'evidenceSeqs') return value && value.length ? value.join(',') : '-';
  return value === null || value === undefined ? '-' : String(value);
}

function parseField(type, raw) {
  switch (type) {
    case 'text': return { value: raw };
    case 'list': return { value: raw.split('|').map((s) => s.trim()).filter(Boolean) };
    case 'seqs': {
      if (raw === '-') return { value: [] };
      const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      return parts.every(Number.isInteger) ? { value: parts } : { error: 'whole numbers separated by commas, or - for none' };
    }
    case 'int': {
      const n = Number(raw);
      return Number.isInteger(n) ? { value: n } : { error: 'a whole number' };
    }
    case 'optint': {
      if (raw === '-') return { value: null };
      const n = Number(raw);
      return Number.isInteger(n) ? { value: n } : { error: 'a whole number, or - for none' };
    }
    case 'kind': return KINDS.includes(raw) ? { value: raw } : { error: `one of ${KINDS.join(', ')}` };
    default: return { error: 'a known field' };
  }
}

async function verifyLoop({ session, questions, reviewer, input, output, onSave, now = () => new Date() }) {
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  const { index } = session;
  const sessionId = session.manifest.sessionId;
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };

  let current = questions.slice();
  const replace = (q) => { current = current.map((x) => (x.id === q.id ? q : x)); };
  const pending = current.filter((q) => q.verifiedBy === null).sort((a, b) => a.askAtSeq - b.askAtSeq || a.id.localeCompare(b.id));
  const counts = { accepted: 0, edited: 0, rejected: 0, skipped: 0, stopped: false };

  const edit = async (q) => {
    const next = { ...q };
    for (const [field, type] of FIELDS) {
      for (;;) {
        const raw = await ask(`${field} [${display(field, next[field])}]: `);
        if (raw === null) return null;
        if (raw === '') break;
        const parsed = parseField(type, raw);
        if (parsed.error) { output.write(`  ${field} must be ${parsed.error}\n`); continue; }
        next[field] = parsed.value;
        break;
      }
    }
    return next;
  };

  try {
    for (let i = 0; i < pending.length; i++) {
      let q = pending[i];
      output.write(describeQuestion(q, index, i + 1, pending.length));
      let decided = false;
      while (!decided) {
        const cmd = await ask('[a]ccept  [e]dit  [r]eject  [s]kip  [q]uit > ');
        if (cmd === null || cmd === 'q') { counts.stopped = true; return counts; }
        if (cmd === 'a') {
          const errors = validateQuestion(q, { index, sessionId });
          if (errors.length) { output.write(`Cannot accept:\n  ${errors.join('\n  ')}\n`); continue; }
          q = { ...normalizeQuestion(q, index), verifiedBy: `human:${reviewer}` };
          replace(q);
          onSave(current, null);
          counts.accepted += 1;
          decided = true;
        } else if (cmd === 'r') {
          const reason = await ask('Reason (optional): ');
          current = current.filter((x) => x.id !== q.id);
          onSave(current, { ...q, rejectedBy: `human:${reviewer}`, rejectReason: reason || '', rejectedAt: now().toISOString() });
          counts.rejected += 1;
          decided = true;
          if (reason === null) { counts.stopped = true; return counts; }
        } else if (cmd === 's') {
          counts.skipped += 1;
          decided = true;
        } else if (cmd === 'e') {
          const edited = await edit(q);
          if (edited === null) { counts.stopped = true; return counts; }
          q = edited;
          const errors = validateQuestion(q, { index, sessionId });
          if (errors.length) {
            output.write(`Not valid yet (not saved):\n  ${errors.join('\n  ')}\n`);
          } else {
            q = normalizeQuestion(q, index);
            replace(q);
            onSave(current, null);
            counts.edited += 1;
          }
          output.write(describeQuestion(q, index, i + 1, pending.length));
        } else {
          output.write('Type a, e, r, s or q.\n');
        }
      }
    }
    return counts;
  } finally {
    rl.close();
  }
}

module.exports = { verifyLoop };
```

- [ ] **Step 4: Write `src/longhaul/commands/verify.js` and register it**

```js
'use strict';
// `longhaul verify --session <id> --reviewer <initials>`
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir } = require('../session-format');
const { KINDS, isVerified, readQuestions, writeQuestions, questionsFile } = require('../questions');
const { verifyLoop } = require('../verify');
const { UsageError } = require('../errors');

module.exports = {
  options: { session: { type: 'string' }, reviewer: { type: 'string' } },
  async run(ctx, values) {
    if (!values.session || !values.reviewer) throw new UsageError('Usage: longhaul verify --session <id> --reviewer <initials>');
    const dir = sessionDir(ctx.home.root, values.session);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new UsageError(`No session "${values.session}"; import it first.`);
    const session = await loadSession(dir);
    const file = questionsFile(ctx.home.root, values.session);
    const rejectedFile = path.join(ctx.home.questions, `${values.session}.rejected.jsonl`);
    const questions = await readQuestions(file);
    if (!questions.some((q) => q.verifiedBy === null)) {
      ctx.stdout.write(`Nothing to verify for ${values.session}.\n`);
      return 0;
    }
    const counts = await verifyLoop({
      session, questions, reviewer: values.reviewer, input: ctx.stdin, output: ctx.stdout, now: ctx.now,
      onSave(current, rejected) {
        writeQuestions(file, current);
        if (rejected) fs.appendFileSync(rejectedFile, `${JSON.stringify(rejected)}\n`);
      }
    });
    const final = await readQuestions(file);
    const verified = final.filter(isVerified);
    const byKind = KINDS.map((k) => `${k} ${verified.filter((q) => q.kind === k).length}`).join(', ');
    ctx.stdout.write(`\n${counts.accepted} accepted, ${counts.edited} edited, ${counts.rejected} rejected, ${counts.skipped} skipped${counts.stopped ? ' (stopped)' : ''}.\n`);
    ctx.stdout.write(`verified for ${values.session}: ${verified.length} (${byKind}); ${final.length - verified.length} still unverified.\n`);
    return 0;
  }
};
```

In `src/longhaul/cli.js`:

```js
const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import'),
  synth: require('./commands/synth'),
  run: require('./commands/run'),
  author: require('./commands/author'),
  verify: require('./commands/verify')
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/longhaul-verify.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/longhaul/verify.js src/longhaul/commands/verify.js src/longhaul/cli.js tests/longhaul-verify.test.js
git commit -m "feat(longhaul): verify loop to accept, edit or reject candidate questions"
```

---

## Task 14: CLAUDE.md, the CI smoke step and the full suite

**Files:**
- Modify: `CLAUDE.md` (a new `## LongHaul (session memory benchmark)` section after `## Models`), `.github/workflows/test.yml` (the smoke run)

**Interfaces:**
- Consumes: everything above.
- Produces: the documented smoke command, and CI running it on all three operating systems.

- [ ] **Step 1: Add the CLAUDE.md section**

Insert after the `## Models` section (before `## Cases`):

```markdown
## LongHaul (session memory benchmark)

`src/longhaul/` and `bin/longhaul.js` (spec
`docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md`; stage
B0 scores evidence recall only, with no answer or judge model). It is
Electron-free, may use `src/history/` and `src/providers/`, and nothing else in
`src/` may require it (`tests/longhaul-boundary.test.js`). It is left out of the
Electron build.

- Data lives in `LONGHAUL_HOME` (default `~/.longhaul/`: `private/`,
  `sessions/`, `questions/`, `runs/`, `reports/`). The CLI refuses a
  `LONGHAUL_HOME` inside a git working tree. Never put a real session under
  the repository. Only the synthetic fixtures in `tests/fixtures/longhaul/` are
  committed. Regenerate them with
  `node bin/longhaul.js synth --out tests/fixtures/longhaul`;
  `tests/longhaul-synthetic.test.js` fails when they drift.
- Smoke run (no models, no network):
  `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle`.
  `oracle` must score evidence recall 1.000. Any shown message at or after
  `askAtSeq` is a leak and exits 1. Add `kl-recall` to the adapters to
  measure recall itself.
- Session files are read with `readJsonlLines`
  (`src/history/importers/jsonl-lines.js`), never `node:readline`: readline
  also splits lines at U+2028/U+2029 inside JSON strings.
- `longhaul author` calls a real model with a key from the environment
  (`OPENAI_API_KEY`, …, through `ProviderFactory.fromEnv`). Unit tests inject a
  fake client or point `--base-url` at `tests/helpers/fake-llm-server.js`.
  It refuses a private session (exit 2) unless `--send-private` is passed,
  since that sends spans of the session to the provider.
```

- [ ] **Step 2: Run the smoke in CI**

In `.github/workflows/test.yml`, after `- run: npm test`, add:

```yaml
      - run: node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle
        env:
          LONGHAUL_HOME: ${{ runner.temp }}/longhaul
```

- [ ] **Step 3: Run the LongHaul and importer tests together**

Run: `node --test tests/longhaul-*.test.js tests/history-jsonl-lines.test.js tests/history-importer-claude-code.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 4: Run the full suite (once per stage)**

Run: `npm test`
Expected: `# fail 0`. Nothing in `src/ipc/`, `main.js` or the renderer changed, so the e2e suite is not needed for this stage.

- [ ] **Step 5: Try the three adapters on the fixtures**

With `LONGHAUL_HOME` set to a temporary directory outside the repository:

Run: `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters kl-recall,sliding-window,oracle`
Expected: exit 0 and three result lines, `oracle` at `evidence recall 1.000` and `leaks 0` everywhere. The `kl-recall` number is informational; note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md .github/workflows/test.yml
git commit -m "docs(longhaul): how to run the smoke benchmark; CI runs it"
```

---

## Task 15: Owner runbook: a verified question set for session E (not code)

The owner does this; an agent does not, because the session is private and only the owner can verify its questions. It is the last B0 deliverable (spec §13) and the input to recall H3.

- [ ] **Step 1: Preconditions**

Recall H1 and H2 are merged, B0 Tasks 1 to 14 are merged, and `npm test` passes on `main`. Run `node bin/longhaul.js home` and check that the printed directory is outside every repository.

- [ ] **Step 2: Drop session E into `private/`**

Copy the session's JSONL into `LONGHAUL_HOME/private/`. The source path is yours; it is never recorded.

```bash
cp <path-to-session-E>.jsonl ~/.longhaul/private/session-E.jsonl
```

(PowerShell: `Copy-Item <path-to-session-E>.jsonl $HOME\.longhaul\private\session-E.jsonl`.)

- [ ] **Step 3: Import it**

Run: `node bin/longhaul.js import ~/.longhaul/private/session-E.jsonl --id E`

Expected: `imported E: …` with about 11,900 messages, about 700 from the user, 8 compactions and about 2.2M estimated tokens (spec §1.1), marked `private`. If the `note:` line reports more than a few hundred unmapped records, stop and report the counts from `sessions/E/manifest.json` (`unmapped`, `skipped`); the importer is missing a record type.

- [ ] **Step 4: Author about 60 candidates**

Pick the authoring provider and model, set its key in the environment, and run:

```bash
OPENAI_API_KEY=<key> node bin/longhaul.js author --session E --provider <provider> --model <model> --count 60 --seed 1 --send-private
```

Session E is private, so `author` refuses without `--send-private`; with it, the command prints a note that spans of the session go to that provider (Decision 1). Check the `short of the target` and `rejected` counts. To add more candidates later, run it again with `--seed 2`. It appends, and it skips anchors already used as evidence.

- [ ] **Step 5: Verify to at least 40, with at least 5 abstain and 5 superseded**

Run: `node bin/longhaul.js verify --session E --reviewer <initials>`

Accept (`a`), edit (`e`) or reject (`r`) each candidate. For `abstain`, check that the fact really is never stated before `askAtSeq`; the author model saw only 20 messages. You can stop with `q` and resume later. The closing line prints the verified count per kind. Author more (Step 4 with a new seed) until you have at least 40 verified, including at least 5 `abstain` and 5 `superseded` (spec §6 targets).

- [ ] **Step 6: Run the three adapters at a 6K recalled budget**

Run: `node bin/longhaul.js run --session E --adapters kl-recall,sliding-window,oracle --budget-tokens 6000`

Expected: exit 0. `oracle` should be at or near evidence recall 1.000. Exit 1 with `LEAK` is a defect in recall's `upToSeq` handling: stop and report the `leaked` records to whoever owns H2.

- [ ] **Step 7: Record the result for H3**

Open `LONGHAUL_HOME/runs/<runId>/summary.md`. Copy its three tables (per adapter, by kind, by distance) to wherever the H3 plan's author will read them. Those tables are aggregate numbers only, and they may be published (B-D8); copy no question text and no session content. Against the recall spec §13 target, report whether `kl-recall` evidence recall is at least 0.8 with its p90 tokens under 15,000. B0 reports this; it does not gate on it.

---

## Notes on the shared contract

This plan uses the H1/H2 contract exactly, with these readings, each pinned by a test:

- **Shown seqs.** `kl-recall`'s shown seqs are the returned `tail` messages' seqs plus the recalled chunks' `seq`, not `stats.tail.{fromSeq,toSeq}`. The range also spans tool results the tail omits (recall spec §6.1). Test: Task 8, `shownFromBuild`.
- **Importer `stats`.** `parse()` also returns `stats` (unmapped, skipped, badLines, duplicates). This is additive; H4 may ignore it.
- **Module shape.** Named exports and `new` are assumed for `TokenEstimator`, `Retriever`, `ContextBuilder` and `chunkMessage`. `chunkMessage` gets `settings.history.chunk` as its options. If H2 differs, only the `require` lines and those two call sites in `adapters/kl-recall.js` change.
- **Token estimate.** LongHaul's `estimateTokens` must equal `TokenEstimator`'s uncalibrated estimate (Task 8 test). When they disagree, LongHaul follows H2.

## Decisions (2026-09-29)

1. **Private spans sent to a model provider.** `longhaul author` refuses to send any span of a private session to a model unless `--send-private` is passed: without it, it exits 2 with a message naming the session, the provider and the flag, before any model call, and writes nothing. With it, it prints a note and proceeds. Task 12 (command and both paths tested), Task 14 (CLAUDE.md), Task 15 (runbook).
2. **`sliding-window` window size.** The default stays the recalled budget plus the tail budget (12,000 at a 6K budget), equal to what `kl-recall` can show. `--window-tokens` overrides it.
3. **Harness-injected `isMeta` user records** stay imported as `status`: not indexed, and `askAtSeq` never lands on them.
4. **Recency's "now".** Resolved in cross-plan review: H2's `build` measures ages from the timestamp of message `upToSeq` when it exists, which in LongHaul's temp store is the message at `askAtSeq`; `kl-recall` passes the question text as `message` (a string, as H2's `build` expects).
5. **`verifiedBy: "synthetic"`** stays, for generator questions, which are correct by construction.
