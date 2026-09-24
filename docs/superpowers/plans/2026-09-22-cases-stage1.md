# Cases Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat can be attached to a case — a git repository on disk holding a brief, an append-only fact ledger with provenance, decisions and a journal — and every turn in that chat orients from the case, writes facts only through gated tools, and commits.

**Architecture:** A new Electron-free module `src/cases/` (git helper, case store, ledger, brief, records, gates, orientation, runtime) plus four model-facing tools in `src/tools/builtin/case-tools.js`. `createCore` constructs one `CaseRuntime`; the chat send path begins and ends a case turn when the chat has a `caseId`, prepends the orientation to the system prompt, and exposes the case tools. IPC and a small section in the Chat Info popover let the owner create and attach cases.

**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, `js-yaml` (already in `node_modules`, promoted to a direct dependency in Task 1), system `git` via `child_process.execFile`.

**Spec:** `docs/superpowers/specs/2026-09-22-king-louie-cases-design.md` — this plan implements stage 1 (§12). Sections referenced below are the spec's.

## Global Constraints

- Tests use `node --test`, never Jest. Run a file with `node --test tests/<file>.test.js`; the full suite with `npm test`. Pass criteria: `# fail 0`.
- Everything under `src/cases/` and `src/tools/builtin/case-tools.js` must not import `electron`, `electron-store` or `main.js` (`tests/electron-boundary.test.js` enforces this).
- Use `createLogger` from `src/logging.js`, never bare `console.*`.
- Nothing may be specific to one person's setup: no names, places, domains or paths in code, defaults, fixtures or docs. Fixtures use invented data (`Lakeside lot`, `+15550100`).
- Case root default: `<dataDir>/cases`. Override order: `settings.cases.root` (non-empty) → env `KL_CASES_ROOT` → default.
- The ledger file is append-only. No code path rewrites or truncates `facts.jsonl`; status changes are new lines.
- Tool results are `{ ok: true, ... }` or `{ ok: false, error }`. Gate refusals are `ok: false` results, never thrown exceptions, so the turn continues (spec §14).
- Commit message trailer for every commit in this plan:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. **Owner hand-edits `facts.jsonl` and leaves a malformed line.** Expected: that line is skipped with a logged warning and reported in orientation; the case still opens. Pinned in Task 2.
2. **Two turns on the same case at once** (two chats attached to one case, or a double-send). Expected: the second gets "case busy", no interleaved writes, and a crash-left lock older than 30 minutes is reclaimed. Pinned in Task 7.
3. **Case titles with path characters or duplicates** (`../x`, `Lot 69`, `Lot 69` again, emoji only). Expected: a safe unique slug inside the root, never a path outside it. Pinned in Task 1.
4. **`git` missing from PATH.** Expected: case creation fails with a clear "git is required for cases" error and no half-created directory. Pinned in Task 1.
5. **Model tries to write the ledger with Write/Edit instead of the Ledger tool.** Expected: the write is refused with a pointer to the Ledger tool. Pinned in Task 8. (Bash is not guarded in stage 1; the orientation tells the model to use tools, and the commit history shows any bypass.)

## Scope Notes

- Stage 1 applies the duplicate gate (spec §7.3) to `Ledger` `unknown` only. The other call sites the spec lists arrive with their features: `Ask` (stage 4), `Executor.submit` (stage 3) and case creation (stage 5, with the cross-case index).
- Re-orientation triggers, wake-ups, budgets, executors, envelopes, the outbound gate, channels, detours and playbooks are later stages (spec §12). The orientation leaves out the executor snapshot and budget sections until those exist.
- Case IDs are `<base36 time>-<8 hex>` rather than a ULID: sortable, collision-safe for one owner, and no new dependency.

## File Structure

| File | Responsibility |
|---|---|
| `src/cases/git.js` | Thin wrapper over the `git` CLI: init, dirty check, commit-all, availability |
| `src/cases/slug.js` | Title → safe, unique directory slug |
| `src/cases/case-store.js` | Create, list, load and update cases on disk (`case.yaml` + skeleton) |
| `src/cases/ledger.js` | Append-only fact ledger: assert, infer, unknown, retract, setDisclosable, markLoadBearing, materialized view, query |
| `src/cases/brief.js` | `brief.md` front matter read/update, gating completion |
| `src/cases/records.js` | Decisions (`decisions.md` + `.kl/decisions.jsonl`), journal entries, rendered `open-items.md` |
| `src/cases/gates.js` | Recommendation gate and duplicate gate (pure functions) |
| `src/cases/orientation.js` | Builds the fixed-size orientation block (pure function) |
| `src/cases/case-runtime.js` | Lock, begin/end turn, commits, cross-case search; the one object core holds |
| `src/cases/chat-integration.js` | Case-mode prompt text, tool-list shaping, protected-path check |
| `src/cases/index.js` | Re-exports |
| `src/tools/builtin/case-tools.js` | `Ledger`, `Brief`, `Decide`, `Recommend` tools |
| `src/ipc/case-handlers.js` | `case:list`, `case:create`, `case:attach`, `case:orientation`, `case:setDisclosable` |
| Modify `src/tools/index.js` | Register the four case tools |
| Modify `src/execution/tool-executor.js` | Refuse Write/Edit/MultiEdit on protected case files |
| Modify `src/core/settings.js` | `cases` defaults |
| Modify `src/core/create-core.js` | Construct `CaseRuntime`, expose it, thread `caseContext` into tool options |
| Modify `src/ipc/chat-handlers.js` | Begin/end case turns in `chat:sendMessage` |
| Modify `src/ipc/constants.js`, `src/ipc/register.js`, `preload.js` | Case IPC channels |
| Modify `renderer.js`, `styles.css` | Case section in the Chat Info popover |
| Modify `package.json` | `js-yaml` as a direct dependency |

---

### Task 1: Git helper, slugs and the case store

**Files:**
- Create: `src/cases/git.js`, `src/cases/slug.js`, `src/cases/case-store.js`
- Modify: `package.json` (dependencies)
- Test: `tests/cases-store.test.js`

**Interfaces:**
- Produces:
  - `git.js`: `isGitAvailable(): Promise<boolean>`, `initRepo(dir): Promise<void>`, `isDirty(dir): Promise<boolean>`, `commitAll(dir, message): Promise<string|null>` (short sha, or null when clean), `class GitUnavailableError extends Error`.
  - `slug.js`: `slugify(title): string`, `uniqueSlug(root, title): string`.
  - `case-store.js`: `class CaseStore { constructor({ root }); create({ title, type?, objective? }): Promise<CaseInfo>; list(): CaseInfo[]; get(idOrSlug): CaseInfo|null; updateMeta(idOrSlug, patch): CaseInfo }` where `CaseInfo = { id, slug, title, type, status, created, dir, playbooks, related }`.
  - Status values: `'draft' | 'active' | 'needs-direction' | 'paused' | 'done' | 'abandoned'`. New cases are `'draft'`.

- [ ] **Step 1: Promote js-yaml to a direct dependency**

Run: `npm install js-yaml@^4.1.0 --save`
Expected: `package.json` `dependencies` gains `"js-yaml": "^4.1.0"`; `node -e "require('js-yaml')"` exits 0.

- [ ] **Step 2: Write the failing tests**

```js
// tests/cases-store.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { slugify, uniqueSlug } = require('../src/cases/slug');
const git = require('../src/cases/git');
const { CaseStore } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-')); dirs.push(d); return d; };

describe('slug', () => {
  it('lowercases and dashes titles', () => {
    assert.strictEqual(slugify('Sell the Lakeside Lot!'), 'sell-the-lakeside-lot');
  });
  it('never produces path segments', () => {
    assert.strictEqual(slugify('../../etc/passwd'), 'etc-passwd');
    assert.strictEqual(slugify('a/b\\c'), 'a-b-c');
  });
  it('falls back to "case" when nothing survives', () => {
    assert.strictEqual(slugify('🏠🏠'), 'case');
    assert.strictEqual(slugify(''), 'case');
  });
  it('caps length at 48', () => {
    assert.ok(slugify('x'.repeat(200)).length <= 48);
  });
  it('dedupes against existing directories', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'lot-9'));
    fs.mkdirSync(path.join(root, 'lot-9-2'));
    assert.strictEqual(uniqueSlug(root, 'Lot 9'), 'lot-9-3');
  });
});

describe('CaseStore', () => {
  it('creates a committed git repo with the spec layout', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const info = await store.create({ title: 'Lakeside lot', type: 'outreach', objective: 'Convert the lot to cash' });
    assert.strictEqual(info.slug, 'lakeside-lot');
    assert.strictEqual(info.status, 'draft');
    assert.ok(info.dir.startsWith(root));
    for (const f of ['case.yaml', 'brief.md', 'facts.jsonl', 'decisions.md', 'open-items.md', '.gitignore']) {
      assert.ok(fs.existsSync(path.join(info.dir, f)), `missing ${f}`);
    }
    for (const d of ['journal', 'sources', 'artifacts', 'playbooks', '.kl']) {
      assert.ok(fs.statSync(path.join(info.dir, d)).isDirectory(), `missing ${d}/`);
    }
    const meta = yaml.load(fs.readFileSync(path.join(info.dir, 'case.yaml'), 'utf8'));
    assert.strictEqual(meta.id, info.id);
    assert.strictEqual(meta.title, 'Lakeside lot');
    assert.strictEqual(await git.isDirty(info.dir), false, 'creation is committed');
    assert.match(fs.readFileSync(path.join(info.dir, '.gitignore'), 'utf8'), /\.kl\/lock/);
  });

  it('lists, gets by id or slug, and updates meta', async () => {
    const store = new CaseStore({ root: tmp() });
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B' });
    assert.deepStrictEqual(store.list().map((c) => c.slug).sort(), ['a', 'b']);
    assert.strictEqual(store.get(a.id).slug, 'a');
    assert.strictEqual(store.get('b').id, b.id);
    assert.strictEqual(store.get('nope'), null);
    const updated = store.updateMeta(a.id, { status: 'active' });
    assert.strictEqual(updated.status, 'active');
    assert.strictEqual(store.get('a').status, 'active');
  });

  it('refuses unknown status values', async () => {
    const store = new CaseStore({ root: tmp() });
    const a = await store.create({ title: 'A' });
    assert.throws(() => store.updateMeta(a.id, { status: 'finished' }), /Invalid case status/);
  });

  it('creates nothing on disk until the first case is created', () => {
    const root = path.join(tmp(), 'not-yet');
    const store = new CaseStore({ root });
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(fs.existsSync(root), false);
  });

  it('ignores directories without a readable case.yaml when listing', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    await store.create({ title: 'Real' });
    fs.mkdirSync(path.join(root, 'junk'));
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'case.yaml'), ': : not yaml : :');
    assert.deepStrictEqual(store.list().map((c) => c.slug), ['real']);
  });

  it('fails cleanly and leaves nothing behind when git is unavailable', async (t) => {
    const root = path.join(tmp(), 'cases');
    const store = new CaseStore({ root });
    t.mock.method(git, 'isGitAvailable', async () => false);
    await assert.rejects(store.create({ title: 'X' }), (err) => err instanceof git.GitUnavailableError && /git is required/.test(err.message));
    assert.strictEqual(fs.existsSync(root), false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/cases-store.test.js`
Expected: FAIL with `Cannot find module '../src/cases/slug'`.

- [ ] **Step 4: Implement `src/cases/git.js`**

```js
// src/cases/git.js
// Minimal git CLI wrapper for case repositories. Every call is execFile with
// an argument array, so titles and messages are never shell-interpreted.
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

class GitUnavailableError extends Error {
  constructor() {
    super('git is required for cases but was not found on PATH.');
    this.name = 'GitUnavailableError';
    this.code = 'GIT_UNAVAILABLE';
  }
}

async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function isGitAvailable() {
  try {
    await run('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function initRepo(dir) {
  await git(dir, ['init', '-q']);
  // Local identity so commits work on machines with no global git config.
  await git(dir, ['config', 'user.name', 'King Louie']);
  await git(dir, ['config', 'user.email', 'king-louie@localhost']);
  // facts.jsonl must stay byte-identical across platforms.
  await git(dir, ['config', 'core.autocrlf', 'false']);
}

async function isDirty(dir) {
  return (await git(dir, ['status', '--porcelain'])).trim().length > 0;
}

async function commitAll(dir, message) {
  if (!(await isDirty(dir))) return null;
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

module.exports = { git, isGitAvailable, initRepo, isDirty, commitAll, GitUnavailableError };
```

- [ ] **Step 5: Implement `src/cases/slug.js`**

```js
// src/cases/slug.js
const fs = require('fs');
const path = require('path');

const MAX = 48;

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');
  return s || 'case';
}

function uniqueSlug(root, title) {
  const base = slugify(title);
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(root, candidate)); n += 1) {
    candidate = `${base.slice(0, MAX - String(n).length - 1)}-${n}`;
  }
  return candidate;
}

module.exports = { slugify, uniqueSlug };
```

- [ ] **Step 6: Implement `src/cases/case-store.js`**

```js
// src/cases/case-store.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const git = require('./git');
const { uniqueSlug } = require('./slug');
const { createLogger } = require('../logging');

const log = createLogger('cases');

const STATUSES = new Set(['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);

const GITIGNORE = ['.kl/index/', '.kl/runs/', '.kl/lock', ''].join('\n');

const BRIEF_TEMPLATE = (objective) => [
  '---',
  yaml.dump({
    objective: objective || '',
    why: '',
    successCriteria: [],
    hardConstraints: [],
    alreadyTried: [],
    resources: { executors: [], ownerLabor: [] },
    deadline: null,
    materiality: { tell: [], ignore: [] },
    gating: { complete: false }
  }).trimEnd(),
  '---',
  '',
  ''
].join('\n');

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

class CaseStore {
  constructor({ root }) {
    if (!root) throw new Error('CaseStore requires a root directory');
    // Nothing is created until the first case is, so constructing a store at
    // startup never touches the data dir.
    this.root = root;
  }

  async create({ title, type = 'general', objective = '' } = {}) {
    if (!(await git.isGitAvailable())) throw new git.GitUnavailableError();
    fs.mkdirSync(this.root, { recursive: true });
    const slug = uniqueSlug(this.root, title);
    const dir = path.join(this.root, slug);
    const meta = {
      id: newId(),
      slug,
      title: String(title || slug),
      type,
      status: 'draft',
      created: new Date().toISOString(),
      playbooks: [],
      related: []
    };
    fs.mkdirSync(dir);
    try {
      for (const d of ['journal', 'sources', 'artifacts', 'playbooks', '.kl']) {
        fs.mkdirSync(path.join(dir, d));
        fs.writeFileSync(path.join(dir, d, '.gitkeep'), '');
      }
      fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta));
      fs.writeFileSync(path.join(dir, 'brief.md'), BRIEF_TEMPLATE(objective));
      fs.writeFileSync(path.join(dir, 'facts.jsonl'), '');
      fs.writeFileSync(path.join(dir, 'decisions.md'), '# Decisions\n');
      fs.writeFileSync(path.join(dir, 'open-items.md'), '# Open items\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
      await git.initRepo(dir);
      await git.commitAll(dir, `case created: ${meta.title}`);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { ...meta, dir };
  }

  _read(dir) {
    try {
      const meta = yaml.load(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
      if (!meta || typeof meta !== 'object' || !meta.id) return null;
      return { playbooks: [], related: [], ...meta, dir };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Unreadable case.yaml in ${dir}: ${err.message}`);
      return null;
    }
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this._read(path.join(this.root, e.name)))
      .filter(Boolean)
      .sort((a, b) => String(a.created).localeCompare(String(b.created)));
  }

  get(idOrSlug) {
    return this.list().find((c) => c.id === idOrSlug || c.slug === idOrSlug) || null;
  }

  updateMeta(idOrSlug, patch = {}) {
    const current = this.get(idOrSlug);
    if (!current) throw new Error(`Case not found: ${idOrSlug}`);
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
      throw new Error(`Invalid case status: ${patch.status}`);
    }
    const { dir, ...meta } = { ...current, ...patch, id: current.id, slug: current.slug };
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta));
    return { ...meta, dir };
  }
}

module.exports = { CaseStore, STATUSES };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/cases-store.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/cases/git.js src/cases/slug.js src/cases/case-store.js tests/cases-store.test.js
git commit -m "feat(cases): case store with git-backed case repositories

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The fact ledger

**Files:**
- Create: `src/cases/ledger.js`
- Test: `tests/cases-ledger.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (operates on a case directory path).
- Produces: `class FactLedger { constructor(dir); path: string; assert(input): Fact; infer(input): Fact; unknown(input): Fact; retract(id, reason): Fact; setDisclosable(id, value): Fact; markLoadBearing(ids): void; view(): { facts: Map<string, Fact>, errors: Array<{ line, message }> }; query(filter): Fact[] }`, `class LedgerError extends Error`, `SENSITIVE_CATEGORIES` (Set).
- `Fact` = `{ id, stmt, subject, attr, value, unit, provenance, source, confidence, category, disclosable, loadBearing, supersedes, basis, changes, answerable, how, addedBy, at, status, supersededBy }` where `provenance ∈ 'sourced'|'user'|'external-agent'|'inferred'|'unknown'` and `status ∈ 'active'|'superseded'|'retracted'`.
- On disk each line is one entry: `{ kind: 'fact', ... }`, `{ kind: 'retract', target, reason, at }`, `{ kind: 'disclosable', target, value, at }`, `{ kind: 'loadBearing', target, at }`. Status is derived by replaying entries; no line is ever rewritten.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-ledger.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FactLedger, LedgerError } = require('../src/cases/ledger');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newLedger = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ledger-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'facts.jsonl'), '');
  return new FactLedger(d);
};
const src = { kind: 'url', ref: 'https://records.example.org/parcel/1' };

describe('FactLedger', () => {
  it('asserts sourced facts with sequential ids and disclosable by default', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'Lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acre', source: src });
    const b = l.assert({ stmt: 'Flood zone X', subject: 'lot', attr: 'flood-zone', value: 'X', source: src });
    assert.strictEqual(a.id, 'f-0001');
    assert.strictEqual(b.id, 'f-0002');
    assert.strictEqual(a.provenance, 'sourced');
    assert.strictEqual(a.status, 'active');
    assert.strictEqual(a.disclosable, true);
    assert.strictEqual(a.loadBearing, false);
  });

  it('requires a source on assert and a basis on infer', () => {
    const l = newLedger();
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1 }), LedgerError);
    assert.throws(() => l.infer({ stmt: 's', subject: 'x', attr: 'y', value: 1 }), /basis/);
    assert.throws(() => l.infer({ stmt: 's', subject: 'x', attr: 'y', value: 1, basis: ['f-0099'] }), /f-0099/);
  });

  it('refuses unknown provenance values on assert', () => {
    const l = newLedger();
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1, source: src, provenance: 'inferred' }), /provenance/);
  });

  it('makes inferred, unknown and sensitive-category facts non-disclosable', () => {
    const l = newLedger();
    const base = l.assert({ stmt: 'Owner said sale is urgent', subject: 'owner', attr: 'urgency', value: 'high', provenance: 'user', source: { kind: 'user-message', ref: 't1' } });
    const inf = l.infer({ stmt: 'Owner is motivated', subject: 'owner', attr: 'motivation', value: 'high', basis: [base.id] });
    const unk = l.unknown({ stmt: 'Has the lot been listed before?', subject: 'lot', attr: 'listing-history', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask the owner' });
    const fin = l.assert({ stmt: 'Mortgage payoff 41,200', subject: 'loan', attr: 'payoff', value: 41200, category: 'financial', source: src });
    assert.strictEqual(inf.disclosable, false);
    assert.strictEqual(unk.disclosable, false);
    assert.strictEqual(unk.provenance, 'unknown');
    assert.strictEqual(unk.value, null);
    assert.strictEqual(fin.disclosable, false);
  });

  it('ignores a disclosable flag passed by the caller', () => {
    const l = newLedger();
    const f = l.assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: src, disclosable: true });
    assert.strictEqual(f.disclosable, false);
  });

  it('supersedes without rewriting the file', () => {
    const l = newLedger();
    const old = l.assert({ stmt: 'Lot is 1.85 acres (GIS)', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    const before = fs.readFileSync(l.path, 'utf8');
    const fresh = l.assert({ stmt: 'Lot is 2.12 acres (plat)', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: old.id });
    const after = fs.readFileSync(l.path, 'utf8');
    assert.ok(after.startsWith(before), 'append-only');
    const { facts } = l.view();
    assert.strictEqual(facts.get(old.id).status, 'superseded');
    assert.strictEqual(facts.get(old.id).supersededBy, fresh.id);
    assert.strictEqual(facts.get(fresh.id).status, 'active');
  });

  it('resolves an unknown by superseding it', () => {
    const l = newLedger();
    const u = l.unknown({ stmt: 'Listed before?', subject: 'lot', attr: 'listing-history', changes: 'c', answerable: 'owner', how: 'ask' });
    const a = l.assert({ stmt: 'Three agents listed it on the MLS', subject: 'lot', attr: 'listing-history', value: 'mls-3x', provenance: 'user', source: { kind: 'user-message', ref: 't2' }, supersedes: u.id });
    assert.strictEqual(l.view().facts.get(u.id).status, 'superseded');
    assert.strictEqual(l.view().facts.get(a.id).status, 'active');
  });

  it('refuses to supersede a missing or inactive fact', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'a', subject: 'x', attr: 'y', value: 1, source: src });
    l.retract(a.id, 'wrong');
    assert.throws(() => l.assert({ stmt: 'b', subject: 'x', attr: 'y', value: 2, source: src, supersedes: a.id }), /not active/);
    assert.throws(() => l.assert({ stmt: 'b', subject: 'x', attr: 'y', value: 2, source: src, supersedes: 'f-0404' }), /f-0404/);
  });

  it('retracts, flips disclosability and marks load-bearing through appended entries', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: src });
    l.setDisclosable(a.id, true);
    l.markLoadBearing([a.id]);
    let f = l.view().facts.get(a.id);
    assert.strictEqual(f.disclosable, true);
    assert.strictEqual(f.loadBearing, true);
    l.retract(a.id, 'bad source');
    f = l.view().facts.get(a.id);
    assert.strictEqual(f.status, 'retracted');
    assert.strictEqual(fs.readFileSync(l.path, 'utf8').trim().split('\n').length, 4);
  });

  it('skips malformed and CRLF lines without losing the rest', () => {
    const l = newLedger();
    l.assert({ stmt: 'a', subject: 'x', attr: 'y', value: 1, source: src });
    fs.appendFileSync(l.path, '{not json\r\n');
    fs.appendFileSync(l.path, JSON.stringify({ kind: 'fact', id: 'f-0002', stmt: 'b', subject: 'x', attr: 'z', value: 2, provenance: 'sourced', source: src, at: 'now' }) + '\r\n');
    const { facts, errors } = l.view();
    assert.strictEqual(facts.size, 2);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].line, 2);
    assert.strictEqual(l.assert({ stmt: 'c', subject: 'x', attr: 'w', value: 3, source: src }).id, 'f-0003');
  });

  it('queries by subject, attr, provenance and status', () => {
    const l = newLedger();
    l.assert({ stmt: 'a', subject: 'lot', attr: 'acreage', value: 2, source: src });
    l.assert({ stmt: 'b', subject: 'lot', attr: 'zone', value: 'X', source: src });
    l.unknown({ stmt: 'c?', subject: 'lot', attr: 'tap', changes: 'c', answerable: 'owner', how: 'ask' });
    assert.strictEqual(l.query({ subject: 'lot' }).length, 3);
    assert.strictEqual(l.query({ subject: 'LOT', attr: 'Zone' }).length, 1);
    assert.strictEqual(l.query({ provenance: 'unknown' }).length, 1);
    assert.strictEqual(l.query({ text: 'b' }).length, 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-ledger.test.js`
Expected: FAIL with `Cannot find module '../src/cases/ledger'`.

- [ ] **Step 3: Implement `src/cases/ledger.js`**

```js
// src/cases/ledger.js
// Append-only fact ledger (spec §4.4). Every change is a new line; the
// current state of each fact is derived by replaying the file.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('cases/ledger');

const SENSITIVE_CATEGORIES = new Set(['personal', 'financial', 'legal', 'health']);
const ASSERT_PROVENANCE = new Set(['sourced', 'user', 'external-agent']);

class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

function requireText(input, field) {
  if (typeof input[field] !== 'string' || !input[field].trim()) {
    throw new LedgerError(`"${field}" is required.`);
  }
}

class FactLedger {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'facts.jsonl');
  }

  _entries() {
    let text = '';
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const entries = [];
    const errors = [];
    text.split('\n').forEach((raw, i) => {
      const line = raw.replace(/\r$/, '').trim();
      if (!line) return;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || !entry.kind) throw new Error('missing "kind"');
        entries.push(entry);
      } catch (err) {
        errors.push({ line: i + 1, message: err.message });
      }
    });
    if (errors.length) log.warn(`${this.path}: skipped ${errors.length} malformed line(s)`);
    return { entries, errors };
  }

  view() {
    const { entries, errors } = this._entries();
    const facts = new Map();
    for (const e of entries) {
      if (e.kind === 'fact') {
        const { kind, ...rest } = e;
        facts.set(e.id, { ...rest, status: 'active', supersededBy: null, loadBearing: Boolean(e.loadBearing) });
        if (e.supersedes && facts.has(e.supersedes)) {
          const old = facts.get(e.supersedes);
          old.status = 'superseded';
          old.supersededBy = e.id;
        }
      } else if (facts.has(e.target)) {
        const f = facts.get(e.target);
        if (e.kind === 'retract') f.status = 'retracted';
        if (e.kind === 'disclosable') f.disclosable = Boolean(e.value);
        if (e.kind === 'loadBearing') f.loadBearing = true;
      }
    }
    return { facts, errors };
  }

  _append(entry) {
    fs.appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  _nextId(facts) {
    let max = 0;
    for (const id of facts.keys()) {
      const n = Number(String(id).replace(/^f-/, ''));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `f-${String(max + 1).padStart(4, '0')}`;
  }

  _requireActive(facts, id, role) {
    const f = facts.get(id);
    if (!f) throw new LedgerError(`${role} references ${id}, which does not exist.`);
    if (f.status !== 'active') throw new LedgerError(`${role} references ${id}, which is not active (${f.status}).`);
    return f;
  }

  _write(fields) {
    const { facts } = this.view();
    if (fields.supersedes) this._requireActive(facts, fields.supersedes, 'supersedes');
    const entry = {
      kind: 'fact',
      id: this._nextId(facts),
      stmt: fields.stmt.trim(),
      subject: fields.subject.trim(),
      attr: fields.attr.trim(),
      value: fields.value === undefined ? null : fields.value,
      unit: fields.unit || null,
      provenance: fields.provenance,
      source: fields.source || null,
      confidence: typeof fields.confidence === 'number' ? fields.confidence : null,
      category: fields.category || null,
      disclosable: !(
        fields.provenance === 'inferred'
        || fields.provenance === 'unknown'
        || SENSITIVE_CATEGORIES.has(fields.category)
      ),
      loadBearing: Boolean(fields.loadBearing),
      supersedes: fields.supersedes || null,
      basis: Array.isArray(fields.basis) ? fields.basis : [],
      changes: fields.changes || null,
      answerable: fields.answerable || null,
      how: fields.how || null,
      addedBy: fields.addedBy || null,
      at: new Date().toISOString()
    };
    this._append(entry);
    const { kind, ...fact } = entry;
    return { ...fact, status: 'active', supersededBy: null };
  }

  assert(input = {}) {
    for (const f of ['stmt', 'subject', 'attr']) requireText(input, f);
    const provenance = input.provenance || 'sourced';
    if (!ASSERT_PROVENANCE.has(provenance)) {
      throw new LedgerError(`assert provenance must be one of ${[...ASSERT_PROVENANCE].join(', ')}; use infer or unknown instead.`);
    }
    if (!input.source || typeof input.source !== 'object' || !input.source.kind) {
      throw new LedgerError('assert requires a source { kind, ref }. If you have no source, record an unknown or an inference.');
    }
    return this._write({ ...input, provenance });
  }

  infer(input = {}) {
    for (const f of ['stmt', 'subject', 'attr']) requireText(input, f);
    if (!Array.isArray(input.basis) || input.basis.length === 0) {
      throw new LedgerError('infer requires a non-empty "basis" listing the fact ids it rests on.');
    }
    const { facts } = this.view();
    for (const id of input.basis) {
      const f = this._requireActive(facts, id, 'basis');
      if (f.provenance === 'unknown') throw new LedgerError(`basis ${id} is an open unknown; an inference cannot rest on it.`);
    }
    return this._write({ ...input, provenance: 'inferred', source: null });
  }

  unknown(input = {}) {
    for (const f of ['stmt', 'subject', 'attr', 'changes', 'answerable', 'how']) requireText(input, f);
    return this._write({ ...input, provenance: 'unknown', value: null, source: null });
  }

  retract(id, reason) {
    const { facts } = this.view();
    this._requireActive(facts, id, 'retract');
    this._append({ kind: 'retract', target: id, reason: String(reason || ''), at: new Date().toISOString() });
    return this.view().facts.get(id);
  }

  // Owner-only: callers must not expose this to the model (spec §4.4).
  setDisclosable(id, value) {
    const { facts } = this.view();
    if (!facts.has(id)) throw new LedgerError(`setDisclosable references ${id}, which does not exist.`);
    this._append({ kind: 'disclosable', target: id, value: Boolean(value), at: new Date().toISOString() });
    return this.view().facts.get(id);
  }

  markLoadBearing(ids = []) {
    const { facts } = this.view();
    for (const id of ids) {
      const f = facts.get(id);
      if (f && !f.loadBearing) this._append({ kind: 'loadBearing', target: id, at: new Date().toISOString() });
    }
  }

  query({ subject, attr, provenance, status = 'active', text } = {}) {
    return [...this.view().facts.values()].filter((f) => (
      (!subject || norm(f.subject) === norm(subject))
      && (!attr || norm(f.attr) === norm(attr))
      && (!provenance || f.provenance === provenance)
      && (status === 'any' || f.status === status)
      && (!text || norm(f.stmt).includes(norm(text)))
    ));
  }
}

module.exports = { FactLedger, LedgerError, SENSITIVE_CATEGORIES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cases-ledger.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/ledger.js tests/cases-ledger.test.js
git commit -m "feat(cases): append-only fact ledger with provenance

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```


---

### Task 3: The brief

**Files:**
- Create: `src/cases/brief.js`
- Test: `tests/cases-brief.test.js`

**Interfaces:**
- Consumes: the `brief.md` template written by `CaseStore.create` (Task 1): YAML front matter between `---` lines with keys `objective, why, successCriteria, hardConstraints, alreadyTried, resources, deadline, materiality, gating`.
- Produces: `class Brief { constructor(dir); read(): { data, body }; update(field, value, { provenance }): object; append(field, item, { provenance }): object; missingForGating(): string[]; isGatingComplete(): boolean; completeGating(): object }`, `class BriefError extends Error`, `BRIEF_FIELDS` (Set), `USER_ONLY_FIELDS` (Set).
- Rules (spec §4.3, §5.6): `why`, `hardConstraints` and `alreadyTried` may only be set with `provenance: 'user'`. Gating completes only when `objective`, `why` and at least one `successCriteria` entry are present.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-brief.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseStore } = require('../src/cases/case-store');
const { Brief, BriefError } = require('../src/cases/brief');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-brief-')); dirs.push(d); return d; };
const newBrief = async () => {
  const info = await new CaseStore({ root: tmp() }).create({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
  return new Brief(info.dir);
};

describe('Brief', () => {
  it('reads the template written at case creation', async () => {
    const b = await newBrief();
    const { data } = b.read();
    assert.strictEqual(data.objective, 'Convert the lot to cash');
    assert.deepStrictEqual(data.alreadyTried, []);
    assert.strictEqual(b.isGatingComplete(), false);
  });

  it('updates model-settable fields and preserves the prose body', async () => {
    const b = await newBrief();
    fs.appendFileSync(b.path, 'Owner notes stay here.\n');
    b.update('successCriteria', ['Signed contract at or above floor'], { provenance: 'model' });
    const { data, body } = b.read();
    assert.deepStrictEqual(data.successCriteria, ['Signed contract at or above floor']);
    assert.match(body, /Owner notes stay here\./);
  });

  it('refuses owner-only fields without user provenance', async () => {
    const b = await newBrief();
    assert.throws(() => b.update('alreadyTried', ['MLS listing'], { provenance: 'model' }), /owner/);
    assert.throws(() => b.append('hardConstraints', 'Both owners sign', {}), /owner/);
    b.append('alreadyTried', 'Three agents on the MLS over three years', { provenance: 'user' });
    assert.deepStrictEqual(b.read().data.alreadyTried, ['Three agents on the MLS over three years']);
  });

  it('rejects unknown fields and wrong types', async () => {
    const b = await newBrief();
    assert.throws(() => b.update('budget', 5, { provenance: 'user' }), /Unknown brief field/);
    assert.throws(() => b.update('successCriteria', 'not an array', { provenance: 'model' }), /array of strings/);
    assert.throws(() => b.update('deadline', 'next week', { provenance: 'model' }), /YYYY-MM-DD/);
  });

  it('completes gating only when objective, why and success criteria are set', async () => {
    const b = await newBrief();
    assert.deepStrictEqual(b.missingForGating(), ['why', 'successCriteria']);
    assert.throws(() => b.completeGating(), (err) => err instanceof BriefError && /why, successCriteria/.test(err.message));
    b.update('why', 'Need cash to repair the family house', { provenance: 'user' });
    b.append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    b.completeGating();
    assert.strictEqual(b.isGatingComplete(), true);
  });

  it('reports hand-broken YAML as a BriefError', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, '---\nobjective: [unclosed\n---\n');
    assert.throws(() => b.read(), (err) => err instanceof BriefError && /not valid YAML/.test(err.message));
  });

  it('treats a brief with no front matter as empty data', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, 'Just prose.\r\n');
    const { data, body } = b.read();
    assert.deepStrictEqual(data, {});
    assert.match(body, /Just prose\./);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-brief.test.js`
Expected: FAIL with `Cannot find module '../src/cases/brief'`.

- [ ] **Step 3: Implement `src/cases/brief.js`**

```js
// src/cases/brief.js
// brief.md: YAML front matter (structured fields) + free prose (spec §4.3).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const BRIEF_FIELDS = new Set([
  'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried',
  'resources', 'deadline', 'materiality'
]);
const USER_ONLY_FIELDS = new Set(['why', 'hardConstraints', 'alreadyTried']);
const ARRAY_FIELDS = new Set(['successCriteria', 'hardConstraints', 'alreadyTried']);
const OBJECT_FIELDS = new Set(['resources', 'materiality']);
const GATING_REQUIRED = ['objective', 'why', 'successCriteria'];

class BriefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefError';
  }
}

function validate(field, value) {
  if (!BRIEF_FIELDS.has(field)) {
    throw new BriefError(`Unknown brief field "${field}". Fields: ${[...BRIEF_FIELDS].join(', ')}.`);
  }
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new BriefError(`"${field}" must be an array of strings.`);
    }
  } else if (OBJECT_FIELDS.has(field)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BriefError(`"${field}" must be an object.`);
    }
  } else if (field === 'deadline') {
    if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      throw new BriefError('"deadline" must be YYYY-MM-DD or null.');
    }
  } else if (typeof value !== 'string') {
    throw new BriefError(`"${field}" must be a string.`);
  }
}

function checkProvenance(field, provenance) {
  if (USER_ONLY_FIELDS.has(field) && provenance !== 'user') {
    throw new BriefError(`"${field}" can only be set from something the owner said (provenance "user"). Ask the owner instead of filling it in.`);
  }
}

const isEmpty = (v) => v === undefined || v === null
  || (typeof v === 'string' && !v.trim())
  || (Array.isArray(v) && v.length === 0);

class Brief {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'brief.md');
  }

  read() {
    const text = fs.readFileSync(this.path, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines[0] !== '---') return { data: {}, body: text };
    const end = lines.indexOf('---', 1);
    if (end === -1) return { data: {}, body: text };
    let data;
    try {
      data = yaml.load(lines.slice(1, end).join('\n')) || {};
    } catch (err) {
      throw new BriefError(`brief.md front matter is not valid YAML: ${err.message}`);
    }
    return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
  }

  _write(data, body) {
    fs.writeFileSync(this.path, `---\n${yaml.dump(data).trimEnd()}\n---\n\n${body}`);
  }

  update(field, value, { provenance } = {}) {
    validate(field, value);
    checkProvenance(field, provenance);
    const { data, body } = this.read();
    data[field] = value;
    this._write(data, body);
    return data;
  }

  append(field, item, { provenance } = {}) {
    if (!ARRAY_FIELDS.has(field)) throw new BriefError(`"${field}" is not a list field.`);
    checkProvenance(field, provenance);
    const { data } = this.read();
    const next = [...(Array.isArray(data[field]) ? data[field] : []), String(item)];
    return this.update(field, next, { provenance });
  }

  missingForGating() {
    const { data } = this.read();
    return GATING_REQUIRED.filter((f) => isEmpty(data[f]));
  }

  isGatingComplete() {
    return Boolean(this.read().data?.gating?.complete);
  }

  completeGating() {
    const missing = this.missingForGating();
    if (missing.length) {
      throw new BriefError(`Gating pass incomplete; still missing: ${missing.join(', ')}.`);
    }
    const { data, body } = this.read();
    data.gating = { ...(data.gating || {}), complete: true, completedAt: new Date().toISOString() };
    this._write(data, body);
    return data;
  }
}

module.exports = { Brief, BriefError, BRIEF_FIELDS, USER_ONLY_FIELDS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cases-brief.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/brief.js tests/cases-brief.test.js
git commit -m "feat(cases): brief front matter with owner-only fields and gating

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Decisions, journal and open items

**Files:**
- Create: `src/cases/records.js`
- Test: `tests/cases-records.test.js`

**Interfaces:**
- Consumes: `Fact` shape from Task 2 (`facts` is the `Map` returned by `FactLedger.view()`).
- Produces: `class CaseRecords { constructor(dir); recordDecision({ decision, factIds, alternatives }): Decision; decisions(): Decision[]; writeJournal(kind, text, now?): string /* path relative to the case dir */; lastJournal(): { file, text } | null; recordRecommendation(rec): void; renderOpenItems(facts): string }`.
- `Decision` = `{ id: 'D-001', decision, factIds, alternatives, at }`. Stored in `.kl/decisions.jsonl` (tracked) and rendered as a section of `decisions.md`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-records.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRecords } = require('../src/cases/records');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newCaseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-records-'));
  dirs.push(d);
  for (const sub of ['journal', '.kl']) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, 'decisions.md'), '# Decisions\n');
  return d;
};

describe('CaseRecords', () => {
  it('records decisions to jsonl and markdown with sequential ids', () => {
    const dir = newCaseDir();
    const r = new CaseRecords(dir);
    const d1 = r.recordDecision({ decision: 'Drop the mailer channel', factIds: ['f-0003'], alternatives: ['Mail 68 letters'] });
    const d2 = r.recordDecision({ decision: 'Floor at 65k', factIds: ['f-0001', 'f-0004'] });
    assert.strictEqual(d1.id, 'D-001');
    assert.strictEqual(d2.id, 'D-002');
    assert.deepStrictEqual(r.decisions().map((d) => d.id), ['D-001', 'D-002']);
    const md = fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8');
    assert.match(md, /## D-001 — Drop the mailer channel/);
    assert.match(md, /Facts: f-0001, f-0004/);
  });

  it('requires decision text', () => {
    const r = new CaseRecords(newCaseDir());
    assert.throws(() => r.recordDecision({ decision: '  ' }), /decision/);
  });

  it('writes journal entries with a safe, unique, sortable name', () => {
    const dir = newCaseDir();
    const r = new CaseRecords(dir);
    const when = new Date('2026-09-22T14:05:00Z');
    const a = r.writeJournal('turn', 'first', when);
    const b = r.writeJournal('../Re Orient!', 'second', when);
    const c = r.writeJournal('turn', 'third', when);
    assert.strictEqual(a, 'journal/2026-09-22-1405-turn.md');
    assert.strictEqual(b, 'journal/2026-09-22-1405-re-orient.md');
    assert.strictEqual(c, 'journal/2026-09-22-1405-turn-2.md');
    assert.strictEqual(r.lastJournal().text.trim(), 'third');
  });

  it('returns null when there is no journal entry', () => {
    fs.writeFileSync(path.join(newCaseDir(), 'journal', '.gitkeep'), '');
    assert.strictEqual(new CaseRecords(newCaseDir()).lastJournal(), null);
  });

  it('renders open-items.md from active unknowns, load-bearing first', () => {
    const dir = newCaseDir();
    const facts = new Map([
      ['f-0001', { id: 'f-0001', provenance: 'unknown', status: 'active', loadBearing: true, subject: 'lot', attr: 'listing-history', stmt: 'Listed before?', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask' }],
      ['f-0002', { id: 'f-0002', provenance: 'unknown', status: 'active', loadBearing: false, subject: 'lot', attr: 'tap', stmt: 'Water tap installed?', changes: 'Buyer cost', answerable: 'utility', how: 'Call' }],
      ['f-0003', { id: 'f-0003', provenance: 'unknown', status: 'superseded', loadBearing: true, subject: 'lot', attr: 'acreage', stmt: 'Acreage?', changes: 'Price', answerable: 'clerk', how: 'Call' }]
    ]);
    const text = new CaseRecords(dir).renderOpenItems(facts);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'open-items.md'), 'utf8'), text);
    assert.ok(text.indexOf('f-0001') < text.indexOf('f-0002'));
    assert.ok(!text.includes('f-0003'));
    assert.match(text, /Ledger tool/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-records.test.js`
Expected: FAIL with `Cannot find module '../src/cases/records'`.

- [ ] **Step 3: Implement `src/cases/records.js`**

```js
// src/cases/records.js
// Decisions, journal entries, recommendations and the rendered open-items
// file for one case directory (spec §4.1, §5.5).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('cases/records');

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      log.warn(`${file}: skipped malformed line: ${err.message}`);
    }
  }
  return out;
}

const stamp = (d) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');

class CaseRecords {
  constructor(dir) {
    this.dir = dir;
    this.decisionsJsonl = path.join(dir, '.kl', 'decisions.jsonl');
    this.recommendationsJsonl = path.join(dir, '.kl', 'recommendations.jsonl');
  }

  decisions() {
    return readJsonl(this.decisionsJsonl);
  }

  recordDecision({ decision, factIds = [], alternatives = [] } = {}) {
    if (typeof decision !== 'string' || !decision.trim()) throw new Error('"decision" text is required.');
    const id = `D-${String(this.decisions().length + 1).padStart(3, '0')}`;
    const record = { id, decision: decision.trim(), factIds, alternatives, at: new Date().toISOString() };
    fs.appendFileSync(this.decisionsJsonl, `${JSON.stringify(record)}\n`);
    const md = [
      '',
      `## ${id} — ${record.decision}`,
      '',
      `- Date: ${record.at}`,
      `- Facts: ${factIds.length ? factIds.join(', ') : 'none'}`,
      ...(alternatives.length ? [`- Alternatives considered: ${alternatives.join('; ')}`] : []),
      ''
    ].join('\n');
    fs.appendFileSync(path.join(this.dir, 'decisions.md'), md);
    return record;
  }

  writeJournal(kind, text, now = new Date()) {
    const safeKind = String(kind || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
    const base = `${stamp(now)}-${safeKind}`;
    let name = `${base}.md`;
    for (let n = 2; fs.existsSync(path.join(this.dir, 'journal', name)); n += 1) name = `${base}-${n}.md`;
    fs.writeFileSync(path.join(this.dir, 'journal', name), `${String(text).trimEnd()}\n`);
    return `journal/${name}`;
  }

  lastJournal() {
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.dir, 'journal')).filter((n) => n.endsWith('.md'));
    } catch {
      return null;
    }
    if (!names.length) return null;
    // Same-minute entries get -2, -3 suffixes; sort those after the bare name.
    const key = (n) => n.replace(/\.md$/, '').replace(/-(\d+)$/, (_, k) => `~${k.padStart(4, '0')}`);
    names.sort((a, b) => key(a).localeCompare(key(b)));
    const file = `journal/${names[names.length - 1]}`;
    return { file, text: fs.readFileSync(path.join(this.dir, file), 'utf8') };
  }

  recordRecommendation(rec) {
    fs.appendFileSync(this.recommendationsJsonl, `${JSON.stringify({ ...rec, at: new Date().toISOString() })}\n`);
  }

  renderOpenItems(facts) {
    const open = [...facts.values()].filter((f) => f.provenance === 'unknown' && f.status === 'active');
    const item = (f) => [
      `- **${f.id}** ${f.subject}.${f.attr} — ${f.stmt}`,
      `  - Changes: ${f.changes || '—'}`,
      `  - Answerable by: ${f.answerable || '—'} · How: ${f.how || '—'}`
    ].join('\n');
    const section = (title, list) => [`## ${title}`, '', list.length ? list.map(item).join('\n') : '_None._', ''];
    const text = [
      '# Open items',
      '',
      '_Generated from facts.jsonl at the end of each turn. Change facts with the Ledger tool, not by editing this file._',
      '',
      ...section('Load-bearing unknowns', open.filter((f) => f.loadBearing)),
      ...section('Other unknowns', open.filter((f) => !f.loadBearing))
    ].join('\n');
    fs.writeFileSync(path.join(this.dir, 'open-items.md'), text);
    return text;
  }
}

module.exports = { CaseRecords };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cases-records.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/records.js tests/cases-records.test.js
git commit -m "feat(cases): decisions, journal entries and rendered open items

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Recommendation and duplicate gates

**Files:**
- Create: `src/cases/gates.js`
- Test: `tests/cases-gates.test.js`

**Interfaces:**
- Consumes: `Fact` (Task 2). `facts` arguments are `Map<string, Fact>` from `FactLedger.view()`.
- Produces:
  - `recommendationGate({ status, claims, facts }): { ok: boolean, failures: Array<{ claim: string|null, reason: string }> }` where `claims = Array<{ text: string, factIds: string[], loadBearing?: boolean /* default true */ }>`.
  - `findDuplicates({ subject, attr, text, facts, otherCases }): { exact: Match[], similar: Match[] }` where `otherCases = Array<{ caseId, title, facts: Map }>` and `Match = { caseId: string|null, caseTitle: string|null, id, stmt, provenance }`. `caseId: null` means the current case.
- Rules (spec §7.1, §7.3):
  - Draft case → every recommendation refused.
  - A load-bearing claim must cite ≥ 1 fact; each cited fact must exist, be `active`, and not be `inferred` or `unknown`.
  - An active, load-bearing unknown with the same `subject` + `attr` as any cited fact blocks the claim.
  - Duplicates: `exact` = active facts or unknowns in the current case with the same `subject` + `attr`, excluding inferences (an inference must never stop the model from recording an honest unknown); `similar` = active facts in other cases with the same `subject` + `attr`, or statement token overlap (Jaccard ≥ 0.5 over words of 3+ letters).

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-gates.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { recommendationGate, findDuplicates } = require('../src/cases/gates');

const fact = (id, over = {}) => [id, {
  id, stmt: `stmt ${id}`, subject: 'lot', attr: id, value: 1, provenance: 'sourced',
  status: 'active', loadBearing: false, ...over
}];

describe('recommendationGate', () => {
  const facts = new Map([
    fact('f-0001', { attr: 'acreage' }),
    fact('f-0002', { attr: 'motivation', provenance: 'inferred' }),
    fact('f-0003', { attr: 'old', status: 'superseded' }),
    fact('f-0004', { attr: 'listing-history', provenance: 'sourced', stmt: 'No online listing today' }),
    fact('f-0005', { attr: 'listing-history', provenance: 'unknown', loadBearing: true, stmt: 'Listed before?' })
  ]);

  it('refuses everything while the case is a draft', () => {
    const r = recommendationGate({ status: 'draft', claims: [{ text: 'x', factIds: ['f-0001'] }], facts });
    assert.strictEqual(r.ok, false);
    assert.match(r.failures[0].reason, /gating/i);
  });

  it('passes a claim citing an active sourced fact', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Price per acre', factIds: ['f-0001'] }], facts });
    assert.deepStrictEqual(r, { ok: true, failures: [] });
  });

  it('refuses uncited, missing, inactive and inferred support', () => {
    const r = recommendationGate({
      status: 'active',
      facts,
      claims: [
        { text: 'a', factIds: [] },
        { text: 'b', factIds: ['f-0099'] },
        { text: 'c', factIds: ['f-0003'] },
        { text: 'd', factIds: ['f-0002'] }
      ]
    });
    assert.strictEqual(r.ok, false);
    const reasons = r.failures.map((f) => `${f.claim}: ${f.reason}`).join('\n');
    assert.match(reasons, /a: .*cites no fact/);
    assert.match(reasons, /b: .*f-0099/);
    assert.match(reasons, /c: .*superseded/);
    assert.match(reasons, /d: .*inferred/);
  });

  it('lets non-load-bearing claims through without citations', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Context only', factIds: [], loadBearing: false }], facts });
    assert.strictEqual(r.ok, true);
  });

  it('blocks a claim on a subject with an open load-bearing unknown', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Online is untried; list there', factIds: ['f-0004'] }], facts });
    assert.strictEqual(r.ok, false);
    assert.match(r.failures[0].reason, /f-0005/);
  });

  it('refuses an empty claim list', () => {
    assert.strictEqual(recommendationGate({ status: 'active', claims: [], facts }).ok, false);
  });
});

describe('findDuplicates', () => {
  const here = new Map([
    fact('f-0001', { subject: 'loan', attr: 'payoff', stmt: 'Payoff quote 120,000' }),
    fact('f-0002', { subject: 'lot', attr: 'tap', provenance: 'unknown', stmt: 'Water tap installed?' }),
    fact('f-0003', { subject: 'parcel-12', attr: 'kind', provenance: 'inferred', stmt: 'Parcel 12 is timber' })
  ]);
  const other = {
    caseId: 'c-other', title: 'Household inventory',
    facts: new Map([
      fact('f-0009', { subject: 'house', attr: 'payoff', stmt: 'Mortgage payoff quote for the house good through September' }),
      fact('f-0010', { subject: 'lot', attr: 'tap', status: 'retracted' })
    ])
  };

  it('reports exact matches in the current case, facts and unknowns alike', () => {
    const d = findDuplicates({ subject: 'Loan', attr: 'PAYOFF', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(d.exact.map((m) => m.id), ['f-0001']);
    const u = findDuplicates({ subject: 'lot', attr: 'tap', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(u.exact.map((m) => m.id), ['f-0002']);
  });

  it('does not count an inference as an exact duplicate', () => {
    const d = findDuplicates({ subject: 'parcel-12', attr: 'kind', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(d.exact, []);
  });

  it('reports similar active facts in other cases by subject/attr or wording', () => {
    const bySubject = findDuplicates({ subject: 'house', attr: 'payoff', text: 'x', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(bySubject.similar.map((m) => [m.caseId, m.id]), [['c-other', 'f-0009']]);
    const byWords = findDuplicates({ subject: 'property', attr: 'loan-balance', text: 'mortgage payoff quote for the house', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(byWords.similar.map((m) => m.id), ['f-0009']);
    assert.strictEqual(byWords.similar[0].caseTitle, 'Household inventory');
  });

  it('ignores inactive facts in other cases', () => {
    const d = findDuplicates({ subject: 'lot', attr: 'tap', text: '', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(d.similar, []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-gates.test.js`
Expected: FAIL with `Cannot find module '../src/cases/gates'`.

- [ ] **Step 3: Implement `src/cases/gates.js`**

```js
// src/cases/gates.js
// Pure gate functions (spec §7). No I/O: callers pass materialized facts.
const norm = (v) => String(v ?? '').trim().toLowerCase();
const key = (f) => `${norm(f.subject)}|${norm(f.attr)}`;

function tokens(text) {
  return new Set(norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function recommendationGate({ status, claims, facts }) {
  if (status === 'draft') {
    return {
      ok: false,
      failures: [{ claim: null, reason: 'The brief gating pass is incomplete. Ask the owner what only they know, then call Brief with action "completeGating" before recommending.' }]
    };
  }
  if (!Array.isArray(claims) || claims.length === 0) {
    return { ok: false, failures: [{ claim: null, reason: 'A recommendation needs at least one claim.' }] };
  }

  const blockers = new Map();
  for (const f of facts.values()) {
    if (f.provenance === 'unknown' && f.status === 'active' && f.loadBearing) blockers.set(key(f), f);
  }

  const failures = [];
  for (const claim of claims) {
    if (claim.loadBearing === false) continue;
    const text = String(claim.text || '');
    const ids = Array.isArray(claim.factIds) ? claim.factIds : [];
    if (!ids.length) {
      failures.push({ claim: text, reason: 'cites no fact. Cite the facts it rests on, or mark it loadBearing: false if it is context only.' });
      continue;
    }
    for (const id of ids) {
      const f = facts.get(id);
      if (!f) {
        failures.push({ claim: text, reason: `cites ${id}, which does not exist.` });
      } else if (f.status !== 'active') {
        failures.push({ claim: text, reason: `cites ${id}, which is ${f.status}${f.supersededBy ? ` by ${f.supersededBy}` : ''}.` });
      } else if (f.provenance === 'inferred') {
        failures.push({ claim: text, reason: `rests on ${id}, which is inferred. Source it, or record it as an unknown and list it.` });
      } else if (f.provenance === 'unknown') {
        failures.push({ claim: text, reason: `rests on ${id}, which is an open unknown.` });
      } else if (blockers.has(key(f))) {
        const u = blockers.get(key(f));
        failures.push({ claim: text, reason: `is on ${f.subject}.${f.attr}, which has the open load-bearing unknown ${u.id} ("${u.stmt}"). Resolve it first.` });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

function findDuplicates({ subject, attr, text = '', facts, otherCases = [] }) {
  const wanted = `${norm(subject)}|${norm(attr)}`;
  const words = tokens(text);
  const exact = [];
  for (const f of facts.values()) {
    if (f.status === 'active' && key(f) === wanted && f.provenance !== 'inferred') {
      exact.push({ caseId: null, caseTitle: null, id: f.id, stmt: f.stmt, provenance: f.provenance });
    }
  }
  const similar = [];
  for (const other of otherCases) {
    for (const f of other.facts.values()) {
      if (f.status !== 'active') continue;
      if (key(f) === wanted || jaccard(words, tokens(f.stmt)) >= 0.5) {
        similar.push({ caseId: other.caseId, caseTitle: other.title, id: f.id, stmt: f.stmt, provenance: f.provenance });
      }
    }
  }
  return { exact, similar };
}

module.exports = { recommendationGate, findDuplicates };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cases-gates.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/gates.js tests/cases-gates.test.js
git commit -m "feat(cases): recommendation and duplicate gates

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The orientation block

**Files:**
- Create: `src/cases/orientation.js`
- Test: `tests/cases-orientation.test.js`

**Interfaces:**
- Consumes: `CaseInfo` (Task 1), brief `data` (Task 3), `Map<string, Fact>` (Task 2), `Decision[]` and `lastJournal()` result (Task 4).
- Produces: `buildOrientation({ meta, brief, facts, decisions, lastJournal, ledgerErrors, maxChars }): string`. `brief` is `{ data }` or `{ error: string }`. `maxChars` defaults to `28000` (~7k tokens, spec §5.2).
- Section order (spec §5.2, stage-1 subset): header with status → brief (with gating line) → load-bearing unknowns → active facts grouped owner / sourced / external agents / inferred, then corrections → decisions (flagging any that cite a non-active fact) → other unknowns → ledger warnings → last journal entry (≤ 2000 chars). When over budget, only the facts section is cut, with a count of what was omitted.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-orientation.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildOrientation } = require('../src/cases/orientation');

const meta = { title: 'Lakeside lot', slug: 'lakeside-lot', status: 'active' };
const briefData = {
  objective: 'Convert the lot to cash', why: 'Fund the house repair',
  successCriteria: ['Closed within 90 days'], hardConstraints: ['Both owners sign'],
  alreadyTried: ['Three agents on the MLS'], deadline: '2026-11-30', gating: { complete: true }
};
const f = (id, over) => [id, { id, subject: 'lot', attr: id, stmt: `stmt ${id}`, value: null, provenance: 'sourced', status: 'active', loadBearing: false, disclosable: true, source: { kind: 'url' }, ...over }];

describe('buildOrientation', () => {
  const facts = new Map([
    f('f-0001', { provenance: 'user', stmt: 'Owner needs cash', source: { kind: 'user-message' } }),
    f('f-0002', { stmt: 'Plat says 2.12 acres', value: 2.12, unit: 'acre' }),
    f('f-0003', { provenance: 'inferred', stmt: 'Buyer pool is investors' }),
    f('f-0004', { provenance: 'unknown', loadBearing: true, stmt: 'Listed before?', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask' }),
    f('f-0005', { provenance: 'unknown', stmt: 'Tap installed?', changes: 'Buyer cost', answerable: 'utility', how: 'Call' }),
    f('f-0006', { stmt: 'GIS says 1.85 acres', status: 'superseded', supersededBy: 'f-0002' })
  ]);
  const decisions = [
    { id: 'D-001', decision: 'Price per acre from the plat', factIds: ['f-0002'] },
    { id: 'D-002', decision: 'Price per acre from GIS', factIds: ['f-0006'] }
  ];

  it('puts sections in the spec order', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions, lastJournal: { file: 'journal/x.md', text: 'Last turn summary' } });
    const order = ['# Case: Lakeside lot', '## Brief', '## Load-bearing unknowns', '## Facts', '## Decisions', '## Other unknowns', '## Last journal entry'];
    let at = -1;
    for (const h of order) {
      const i = text.indexOf(h);
      assert.ok(i > at, `${h} out of order`);
      at = i;
    }
    assert.match(text, /status: active/);
    assert.match(text, /Already tried: Three agents on the MLS/);
  });

  it('labels provenance groups and shows corrections', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions: [] });
    assert.match(text, /### From the owner[\s\S]*f-0001/);
    assert.match(text, /### Sourced[\s\S]*f-0002 lot\.f-0002 = 2\.12 acre/);
    assert.match(text, /### Inferred[^\n]*not usable[\s\S]*f-0003/);
    assert.match(text, /Corrections[\s\S]*f-0006 → f-0002/);
    assert.ok(text.indexOf('f-0004') < text.indexOf('## Facts'), 'load-bearing unknown precedes facts');
  });

  it('flags decisions that cite a fact that is no longer active', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions });
    assert.match(text, /D-002[^\n]*f-0006 which is now superseded/);
    assert.doesNotMatch(text, /D-001[^\n]*now superseded/);
  });

  it('warns loudly when gating is incomplete', () => {
    const text = buildOrientation({ meta: { ...meta, status: 'draft' }, brief: { data: { ...briefData, gating: { complete: false } } }, facts: new Map() });
    assert.match(text, /Gating pass: INCOMPLETE/);
  });

  it('reports an unreadable brief and ledger warnings instead of failing', () => {
    const text = buildOrientation({ meta, brief: { error: 'not valid YAML' }, facts: new Map(), ledgerErrors: [{ line: 7, message: 'Unexpected token' }] });
    assert.match(text, /brief\.md could not be read: not valid YAML/);
    assert.match(text, /line 7/);
  });

  it('cuts only the facts section when over budget and says how much was omitted', () => {
    const many = new Map(Array.from({ length: 400 }, (_, i) => f(`f-${String(i + 1).padStart(4, '0')}`, { stmt: 'x'.repeat(80) })));
    many.set('f-9999', { id: 'f-9999', subject: 'lot', attr: 'q', stmt: 'Critical unknown', provenance: 'unknown', status: 'active', loadBearing: true, changes: 'c', answerable: 'owner', how: 'ask' });
    const text = buildOrientation({ meta, brief: { data: briefData }, facts: many, decisions, lastJournal: { file: 'journal/x.md', text: 'j'.repeat(5000) }, maxChars: 6000 });
    assert.ok(text.length <= 6000 + 200, `length ${text.length}`);
    assert.match(text, /Critical unknown/);
    assert.match(text, /more facts not shown/);
    assert.match(text, /D-001/);
    assert.match(text, /## Last journal entry/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-orientation.test.js`
Expected: FAIL with `Cannot find module '../src/cases/orientation'`.

- [ ] **Step 3: Implement `src/cases/orientation.js`**

```js
// src/cases/orientation.js
// Builds the orientation block every case turn starts from (spec §5.2).
// Pure: callers read the case from disk and pass the pieces in.
const DEFAULT_MAX_CHARS = 28000;
const JOURNAL_MAX = 2000;

const GROUPS = [
  ['From the owner', 'user'],
  ['Sourced', 'sourced'],
  ['From external agents', 'external-agent'],
  ['Inferred — not usable for recommendations or outbound', 'inferred']
];

function valueText(f) {
  if (f.value === null || f.value === undefined) return '';
  const v = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
  return ` = ${v}${f.unit ? ` ${f.unit}` : ''}`;
}

function factLine(f) {
  const tags = [
    f.source?.kind ? `[${f.source.kind}]` : '',
    f.loadBearing ? '(load-bearing)' : '',
    f.disclosable === false ? '(private)' : ''
  ].filter(Boolean).join(' ');
  return `- ${f.id} ${f.subject}.${f.attr}${valueText(f)} — ${f.stmt}${tags ? ` ${tags}` : ''}`;
}

function unknownLine(u) {
  return `- ${u.id} ${u.subject}.${u.attr} — ${u.stmt}\n  Changes: ${u.changes || '—'} · Answerable by: ${u.answerable || '—'} · How: ${u.how || '—'}`;
}

function briefLines(brief) {
  if (!brief || brief.error) return [`- brief.md could not be read: ${brief?.error || 'missing'}. Ask the owner to fix it or rewrite it with the Brief tool.`];
  const d = brief.data || {};
  const list = (v) => (Array.isArray(v) && v.length ? v.join('; ') : '—');
  return [
    `- Objective: ${d.objective || '—'}`,
    `- Why: ${d.why || '—'}`,
    `- Success criteria: ${list(d.successCriteria)}`,
    `- Hard constraints: ${list(d.hardConstraints)}`,
    `- Already tried: ${list(d.alreadyTried)}`,
    `- Deadline: ${d.deadline || '—'}`,
    d.gating?.complete
      ? '- Gating pass: complete'
      : '- Gating pass: INCOMPLETE. Ask the owner only what they alone know (why, hard constraints, what has already been tried), record it with the Brief tool, then call Brief completeGating. Recommendations are refused until then.'
  ];
}

function buildOrientation({
  meta, brief, facts = new Map(), decisions = [], lastJournal = null, ledgerErrors = [], maxChars = DEFAULT_MAX_CHARS
}) {
  const all = [...facts.values()];
  const active = all.filter((f) => f.status === 'active');
  const unknowns = active.filter((f) => f.provenance === 'unknown');
  const lbUnknowns = unknowns.filter((u) => u.loadBearing).map(unknownLine);
  const otherUnknowns = unknowns.filter((u) => !u.loadBearing).map(unknownLine);

  const head = [
    `# Case: ${meta.title} (${meta.slug}) — status: ${meta.status}`,
    '',
    '## Brief',
    ...briefLines(brief),
    '',
    '## Load-bearing unknowns (resolve or work around these before anything else)',
    ...(lbUnknowns.length ? lbUnknowns : ['- none recorded']),
    ''
  ].join('\n');

  const decisionLines = decisions.map((d) => {
    const stale = (d.factIds || [])
      .map((id) => facts.get(id))
      .filter((f) => f && f.status !== 'active')
      .map((f) => ` ⚠ cites ${f.id} which is now ${f.status}; revisit this decision.`)
      .join('');
    return `- ${d.id} ${d.decision} (facts: ${(d.factIds || []).join(', ') || 'none'})${stale}`;
  });
  let journal = '';
  if (lastJournal) {
    const body = lastJournal.text.length > JOURNAL_MAX ? `${lastJournal.text.slice(0, JOURNAL_MAX)}…` : lastJournal.text;
    journal = [`## Last journal entry (${lastJournal.file})`, body.trimEnd(), ''].join('\n');
  }
  const tail = [
    '## Decisions',
    ...(decisionLines.length ? decisionLines : ['- none yet']),
    '',
    '## Other unknowns',
    ...(otherUnknowns.length ? otherUnknowns : ['- none']),
    '',
    ...(ledgerErrors.length
      ? ['## Ledger warnings', ...ledgerErrors.map((e) => `- facts.jsonl line ${e.line} skipped: ${e.message}`), '']
      : []),
    journal
  ].join('\n');

  const factLines = [];
  for (const [title, provenance] of GROUPS) {
    const group = active.filter((f) => f.provenance === provenance);
    if (group.length) factLines.push({ text: `### ${title}` }, ...group.map((f) => ({ text: factLine(f), fact: true })));
  }
  const corrections = all.filter((f) => f.status !== 'active' && f.provenance !== 'unknown');
  if (corrections.length) {
    factLines.push({ text: '### Corrections (superseded or retracted)' });
    factLines.push(...corrections.map((f) => ({
      text: f.supersededBy ? `- ${f.id} → ${f.supersededBy}: ${f.stmt}` : `- ${f.id} retracted: ${f.stmt}`,
      fact: true
    })));
  }

  const budget = maxChars - head.length - tail.length - 200;
  const kept = ['## Facts (active)'];
  let used = kept[0].length + 1;
  let omitted = 0;
  for (const line of factLines) {
    if (omitted || used + line.text.length + 1 > budget) {
      if (line.fact) omitted += 1;
      continue;
    }
    kept.push(line.text);
    used += line.text.length + 1;
  }
  if (omitted) kept.push(`- … ${omitted} more facts not shown; use the Ledger tool's query action.`);
  if (kept.length === 1) kept.push('- none yet');

  return [head, kept.join('\n'), '', tail].join('\n');
}

module.exports = { buildOrientation, DEFAULT_MAX_CHARS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cases-orientation.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cases/orientation.js tests/cases-orientation.test.js
git commit -m "feat(cases): orientation block built from the case on disk

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The case runtime

**Files:**
- Create: `src/cases/case-runtime.js`, `src/cases/index.js`
- Test: `tests/cases-runtime.test.js`

**Interfaces:**
- Consumes: `CaseStore` (Task 1), `git` helpers (Task 1), `FactLedger` (Task 2), `Brief` (Task 3), `CaseRecords` (Task 4), `buildOrientation` (Task 6).
- Produces:
  - `class CaseRuntime { constructor({ root, staleLockMs?, orientationMaxChars? }); root: string; createCase(opts): Promise<CaseInfo>; listCases(): CaseInfo[]; getCase(idOrSlug): CaseInfo /* throws CaseNotFoundError */; ledger(id): FactLedger; brief(id): Brief; records(id): CaseRecords; orientation(id): string; otherCaseFacts(id): Array<{ caseId, title, facts: Map }>; completeGating(id): CaseInfo; beginTurn(id, { turnId }): Promise<CaseTurn>; endTurn(turn, { summary?, journal? }): Promise<string|null> }`.
  - `CaseTurn = { caseId, dir, turnId, title, orientation }`.
  - `class CaseBusyError` (`code: 'CASE_BUSY'`), `class CaseNotFoundError` (`code: 'CASE_NOT_FOUND'`).
  - `resolveCasesRoot({ settings, env, dataDir }): string` — `settings.cases.root` (non-empty) → `env.KL_CASES_ROOT` → `<dataDir>/cases`.
  - `src/cases/index.js` re-exports everything above plus `CaseStore`, `FactLedger`, `LedgerError`, `Brief`, `BriefError`, `CaseRecords`, `buildOrientation`, `recommendationGate`, `findDuplicates`.
- Lock: `.kl/lock` (gitignored) created with `wx`, holding `{ turnId, pid, at }`. A lock older than `staleLockMs` (default 30 min) is reclaimed once with a warning. `endTurn` always releases the lock, even when the commit fails.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-runtime.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runtime-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const commitCount = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();

describe('resolveCasesRoot', () => {
  it('prefers settings, then env, then the data dir', () => {
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '/s' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/s');
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '  ' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/e');
    assert.strictEqual(resolveCasesRoot({ settings: {}, env: {}, dataDir: '/d' }), path.join('/d', 'cases'));
  });
});

describe('CaseRuntime', () => {
  it('begins a turn with an orientation, locks, commits and unlocks on end', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    const before = await commitCount(info.dir);
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    assert.match(turn.orientation, /# Case: Lakeside lot/);
    assert.ok(fs.existsSync(path.join(info.dir, '.kl', 'lock')));
    rt.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    await rt.endTurn(turn, { summary: 'Pulled the plat\nsecond line', journal: 'Recorded the plat acreage.' });
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
    assert.strictEqual(await commitCount(info.dir), before + 1);
    assert.strictEqual(await lastSubject(info.dir), 'turn-1: Pulled the plat second line');
    assert.strictEqual(await git.isDirty(info.dir), false);
    assert.match(rt.records(info.id).lastJournal().text, /Recorded the plat acreage/);
  });

  it('refuses a second concurrent turn on the same case', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const t1 = await rt.beginTurn(info.id, { turnId: 't1' });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 't2' }), (err) => err instanceof CaseBusyError && err.code === 'CASE_BUSY');
    await rt.endTurn(t1, {});
    const t3 = await rt.beginTurn(info.id, { turnId: 't3' });
    await rt.endTurn(t3, {});
  });

  it('reclaims a stale lock left by a crash', async () => {
    const rt = new CaseRuntime({ root: tmp(), staleLockMs: 1000 });
    const info = await rt.createCase({ title: 'A' });
    const lock = path.join(info.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'dead', pid: 1, at: 'then' }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(lock, old, old);
    const t = await rt.beginTurn(info.id, { turnId: 'alive' });
    assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).turnId, 'alive');
    await rt.endTurn(t, {});
  });

  it('commits owner edits made outside King Louie before the turn starts', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    fs.appendFileSync(path.join(info.dir, 'brief.md'), 'Owner note.\n');
    const t = await rt.beginTurn(info.id, { turnId: 't1' });
    assert.strictEqual(await lastSubject(info.dir), 'owner edits');
    assert.match(t.orientation, /Case: A/);
    await rt.endTurn(t, {});
  });

  it('releases the lock even when the commit fails', async (t) => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const turn = await rt.beginTurn(info.id, { turnId: 't1' });
    t.mock.method(git, 'commitAll', async () => { throw new Error('disk full'); });
    await assert.rejects(rt.endTurn(turn, { summary: 'x' }), /disk full/);
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
  });

  it('keeps facts across a restart (a new runtime on the same root)', async () => {
    const root = tmp();
    const rt1 = new CaseRuntime({ root });
    const info = await rt1.createCase({ title: 'A' });
    rt1.ledger(info.id).assert({ stmt: 'Flood zone X', subject: 'lot', attr: 'flood-zone', value: 'X', source: src });
    const rt2 = new CaseRuntime({ root });
    assert.match(rt2.orientation(info.id), /Flood zone X/);
  });

  it('completes gating and moves the case from draft to active', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A', objective: 'Sell it' });
    assert.throws(() => rt.completeGating(info.id), /why/);
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    assert.strictEqual(rt.completeGating(info.id).status, 'active');
  });

  it('lists facts of the other cases for duplicate search', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const a = await rt.createCase({ title: 'A' });
    const b = await rt.createCase({ title: 'B' });
    rt.ledger(b.id).assert({ stmt: 'x', subject: 's', attr: 'a', value: 1, source: src });
    const others = rt.otherCaseFacts(a.id);
    assert.deepStrictEqual(others.map((o) => o.title), ['B']);
    assert.strictEqual(others[0].facts.size, 1);
  });

  it('throws CaseNotFoundError for an unknown case', () => {
    const rt = new CaseRuntime({ root: tmp() });
    assert.throws(() => rt.getCase('nope'), CaseNotFoundError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-runtime.test.js`
Expected: FAIL with `Cannot find module '../src/cases'`.

- [ ] **Step 3: Implement `src/cases/case-runtime.js`**

```js
// src/cases/case-runtime.js
// The one object core holds for cases: turn lifecycle (spec §5.5), lock,
// commits, and read access to each case's ledger, brief and records.
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { CaseStore } = require('./case-store');
const { FactLedger } = require('./ledger');
const { Brief } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation, DEFAULT_MAX_CHARS } = require('./orientation');
const { createLogger } = require('../logging');

const log = createLogger('cases/runtime');

class CaseBusyError extends Error {
  constructor(title) {
    super(`Case "${title}" is busy with another turn. Try again when it finishes.`);
    this.name = 'CaseBusyError';
    this.code = 'CASE_BUSY';
  }
}

class CaseNotFoundError extends Error {
  constructor(id) {
    super(`Case not found: ${id}`);
    this.name = 'CaseNotFoundError';
    this.code = 'CASE_NOT_FOUND';
  }
}

function resolveCasesRoot({ settings, env = process.env, dataDir }) {
  const configured = settings?.cases?.root;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  if (env && env.KL_CASES_ROOT) return env.KL_CASES_ROOT;
  return path.join(dataDir, 'cases');
}

const oneLine = (s, max = 72) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

class CaseRuntime {
  constructor({ root, staleLockMs = 30 * 60 * 1000, orientationMaxChars = DEFAULT_MAX_CHARS }) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    this.orientationMaxChars = orientationMaxChars;
  }

  get root() {
    return this.store.root;
  }

  createCase(opts) {
    return this.store.create(opts);
  }

  listCases() {
    return this.store.list();
  }

  getCase(idOrSlug) {
    const c = this.store.get(idOrSlug);
    if (!c) throw new CaseNotFoundError(idOrSlug);
    return c;
  }

  ledger(id) { return new FactLedger(this.getCase(id).dir); }

  brief(id) { return new Brief(this.getCase(id).dir); }

  records(id) { return new CaseRecords(this.getCase(id).dir); }

  orientation(id) {
    const meta = this.getCase(id);
    const { facts, errors } = new FactLedger(meta.dir).view();
    let brief;
    try {
      brief = { data: new Brief(meta.dir).read().data };
    } catch (err) {
      brief = { error: err.message };
    }
    const records = new CaseRecords(meta.dir);
    return buildOrientation({
      meta,
      brief,
      facts,
      decisions: records.decisions(),
      lastJournal: records.lastJournal(),
      ledgerErrors: errors,
      maxChars: this.orientationMaxChars
    });
  }

  otherCaseFacts(id) {
    const self = this.getCase(id);
    return this.listCases()
      .filter((c) => c.id !== self.id)
      .map((c) => ({ caseId: c.id, title: c.title, facts: new FactLedger(c.dir).view().facts }));
  }

  completeGating(id) {
    const meta = this.getCase(id);
    new Brief(meta.dir).completeGating();
    if (meta.status === 'draft') this.store.updateMeta(meta.id, { status: 'active' });
    return this.getCase(meta.id);
  }

  _lockPath(dir) {
    return path.join(dir, '.kl', 'lock');
  }

  _acquire(meta, turnId) {
    const lock = this._lockPath(meta.dir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ turnId, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (attempt === 0 && age > this.staleLockMs) {
          log.warn(`Reclaiming stale lock on case ${meta.slug} (${Math.round(age / 60000)} min old)`);
          fs.rmSync(lock, { force: true });
          continue;
        }
        throw new CaseBusyError(meta.title);
      }
    }
  }

  _release(dir, turnId) {
    const lock = this._lockPath(dir);
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (held.turnId === turnId) fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not release lock in ${dir}: ${err.message}`);
    }
  }

  async beginTurn(id, { turnId }) {
    const meta = this.getCase(id);
    this._acquire(meta, turnId);
    try {
      if (await git.isDirty(meta.dir)) await git.commitAll(meta.dir, 'owner edits');
      return { caseId: meta.id, dir: meta.dir, turnId, title: meta.title, orientation: this.orientation(meta.id) };
    } catch (err) {
      this._release(meta.dir, turnId);
      throw err;
    }
  }

  async endTurn(turn, { summary = '', journal = null } = {}) {
    try {
      const records = new CaseRecords(turn.dir);
      records.renderOpenItems(new FactLedger(turn.dir).view().facts);
      if (journal && String(journal).trim()) records.writeJournal('turn', journal);
      return await git.commitAll(turn.dir, `${turn.turnId}: ${oneLine(summary) || 'turn'}`);
    } finally {
      this._release(turn.dir, turn.turnId);
    }
  }
}

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot };
```

- [ ] **Step 4: Implement `src/cases/index.js`**

```js
// src/cases/index.js
const { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot } = require('./case-runtime');
const { CaseStore } = require('./case-store');
const { FactLedger, LedgerError } = require('./ledger');
const { Brief, BriefError } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation } = require('./orientation');
const { recommendationGate, findDuplicates } = require('./gates');

module.exports = {
  CaseRuntime,
  CaseBusyError,
  CaseNotFoundError,
  resolveCasesRoot,
  CaseStore,
  FactLedger,
  LedgerError,
  Brief,
  BriefError,
  CaseRecords,
  buildOrientation,
  recommendationGate,
  findDuplicates
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/cases-runtime.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/cases/case-runtime.js src/cases/index.js tests/cases-runtime.test.js
git commit -m "feat(cases): case runtime with turn lock and per-turn commits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Case tools, case-mode helpers and the ledger write guard

**Files:**
- Create: `src/cases/chat-integration.js`, `src/tools/builtin/case-tools.js`
- Modify: `src/tools/index.js` (register the four tools), `src/execution/tool-executor.js` (guard)
- Test: `tests/cases-tools.test.js`

**Interfaces:**
- Consumes: `CaseRuntime` and friends (Task 7), `recommendationGate`, `findDuplicates` (Task 5).
- Produces:
  - Tools named `Ledger`, `Brief`, `Decide`, `Recommend` (exports `LedgerTool`, `BriefTool`, `DecideTool`, `RecommendTool`). Each reads `options.caseContext = { runtime: CaseRuntime, caseId, turnId, dir }`; without it they return `{ ok: false, error: 'This chat is not attached to a case…' }`. All errors come back as `{ ok: false, error }`.
  - `chat-integration.js`: `CASE_TOOL_NAMES` (`['Ledger','Brief','Decide','Recommend']`), `CASE_MODE_PROMPT` (string), `shapeToolDefinitions(definitions, attached, registry)`, `buildCaseSystemPrompt(orientation, base)`, `isProtectedCasePath(caseDir, absolutePath)`.
  - `ToolExecutor.execute` refuses `Write`, `Edit` and `MultiEdit` whose target is `<caseDir>/facts.jsonl` or anything under `<caseDir>/.kl/` when `extraToolOptions.caseContext` is set, returning `{ success: false, error }` that names the Ledger tool.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-tools.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTools, toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { CaseRuntime } = require('../src/cases');
const { LedgerTool, BriefTool, DecideTool, RecommendTool } = require('../src/tools/builtin/case-tools');
const {
  CASE_TOOL_NAMES, CASE_MODE_PROMPT, shapeToolDefinitions, buildCaseSystemPrompt, isProtectedCasePath
} = require('../src/cases/chat-integration');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tools-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };

async function setup(title = 'Lakeside lot') {
  const runtime = new CaseRuntime({ root: tmp() });
  const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
  const caseContext = { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir };
  return { runtime, info, opts: { caseContext } };
}

async function activate(runtime, id) {
  runtime.brief(id).update('why', 'Need the cash', { provenance: 'user' });
  runtime.brief(id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  runtime.completeGating(id);
}

describe('case tools', () => {
  it('are registered and refuse to run without a case', async () => {
    for (const name of CASE_TOOL_NAMES) assert.ok(toolRegistry.get(name), `${name} registered`);
    const r = await LedgerTool.execute({ action: 'query' }, {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not attached to a case/);
  });

  it('Ledger asserts, infers, queries and fills in a user-message source', async () => {
    const { opts } = await setup();
    const a = await LedgerTool.execute({ action: 'assert', stmt: 'Owner needs cash by spring', subject: 'owner', attr: 'deadline', value: '2027-03', provenance: 'user' }, opts);
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(a.fact.source, { kind: 'user-message', ref: 'turn-1' });
    assert.strictEqual(a.fact.addedBy, 'turn-1');
    const i = await LedgerTool.execute({ action: 'infer', stmt: 'Owner is motivated', subject: 'owner', attr: 'motivation', value: 'high', basis: [a.fact.id] }, opts);
    assert.strictEqual(i.fact.provenance, 'inferred');
    const bad = await LedgerTool.execute({ action: 'assert', stmt: 'Guess', subject: 'lot', attr: 'x', value: 1 }, opts);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /source/);
    const q = await LedgerTool.execute({ action: 'query', filter: { subject: 'owner' } }, opts);
    assert.strictEqual(q.facts.length, 2);
  });

  it('Ledger unknown refuses exact duplicates and surfaces other cases', async () => {
    const { runtime, opts } = await setup('Lakeside lot');
    const other = await runtime.createCase({ title: 'Household inventory' });
    runtime.ledger(other.id).assert({ stmt: 'Payoff quote for the house loan', subject: 'house-loan', attr: 'payoff', value: 120000, source: src, category: 'financial' });
    const u = await LedgerTool.execute({ action: 'unknown', stmt: 'What is the house loan payoff?', subject: 'house-loan', attr: 'payoff', changes: 'Net proceeds', answerable: 'owner', how: 'Ask for the payoff letter' }, opts);
    assert.strictEqual(u.ok, true);
    assert.deepStrictEqual(u.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    const again = await LedgerTool.execute({ action: 'unknown', stmt: 'Payoff?', subject: 'house-loan', attr: 'payoff', changes: 'c', answerable: 'owner', how: 'ask' }, opts);
    assert.strictEqual(again.ok, false);
    assert.match(again.error, /already has/);
  });

  it('Brief reads, refuses owner-only fields from the model, journals updates and completes gating', async () => {
    const { runtime, info, opts } = await setup();
    const read = await BriefTool.execute({ action: 'read' }, opts);
    assert.deepStrictEqual(read.missingForGating, ['why', 'successCriteria']);
    const refused = await BriefTool.execute({ action: 'update', field: 'why', value: 'I think they need cash', provenance: 'model' }, opts);
    assert.strictEqual(refused.ok, false);
    await BriefTool.execute({ action: 'update', field: 'why', value: 'Need the cash', provenance: 'user', reason: 'Owner said so' }, opts);
    await BriefTool.execute({ action: 'append', field: 'successCriteria', item: 'Closed by year end' }, opts);
    const done = await BriefTool.execute({ action: 'completeGating' }, opts);
    assert.deepStrictEqual(done, { ok: true, status: 'active' });
    assert.match(runtime.records(info.id).lastJournal().file, /-brief/);
  });

  it('Decide records a decision and marks cited facts load-bearing', async () => {
    const { runtime, info, opts } = await setup();
    const f = runtime.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    const d = await DecideTool.execute({ decision: 'Price per acre off the plat', factIds: [f.id], alternatives: ['GIS acreage'] }, opts);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.decision.id, 'D-001');
    assert.strictEqual(runtime.ledger(info.id).view().facts.get(f.id).loadBearing, true);
    const missing = await DecideTool.execute({ decision: 'x', factIds: ['f-0404'] }, opts);
    assert.strictEqual(missing.ok, false);
  });

  it('Recommend is refused on a draft case and on inferred support, and renders unknowns first when it passes', async () => {
    const { runtime, info, opts } = await setup();
    const f = runtime.ledger(info.id).assert({ stmt: 'Six active lots ask 36k–60k per acre', subject: 'market', attr: 'asks', value: null, source: src });
    const draft = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.id] }] }, opts);
    assert.strictEqual(draft.ok, false);
    assert.match(JSON.stringify(draft.failures), /gating/i);

    await activate(runtime, info.id);
    const inf = runtime.ledger(info.id).infer({ stmt: 'Buyers are investors', subject: 'market', attr: 'buyers', value: 'investors', basis: [f.id] });
    const refused = await RecommendTool.execute({ claims: [{ text: 'Target investors', factIds: [inf.id] }] }, opts);
    assert.strictEqual(refused.ok, false);

    runtime.ledger(info.id).unknown({ stmt: 'Is there a water tap?', subject: 'lot', attr: 'tap', changes: 'Buyer cost', answerable: 'utility', how: 'Call', loadBearing: true });
    const ok = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.id] }] }, opts);
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.rendered.indexOf('Is there a water tap?') < ok.rendered.indexOf('List at 35k per acre'), 'unknowns first');
    assert.strictEqual(runtime.ledger(info.id).view().facts.get(f.id).loadBearing, true);
  });
});

describe('case-mode helpers', () => {
  it('adds case tools only when a case is attached', () => {
    const base = [{ name: 'Read' }, { name: 'Ledger' }];
    assert.deepStrictEqual(shapeToolDefinitions(base, false, toolRegistry).map((d) => d.name), ['Read']);
    assert.deepStrictEqual(shapeToolDefinitions(base, true, toolRegistry).map((d) => d.name), ['Read', ...CASE_TOOL_NAMES]);
  });

  it('puts the case prompt and orientation ahead of the base prompt', () => {
    const p = buildCaseSystemPrompt('ORIENT', 'BASE');
    assert.ok(p.startsWith(CASE_MODE_PROMPT));
    assert.ok(p.indexOf('ORIENT') < p.indexOf('BASE'));
  });

  it('protects facts.jsonl and .kl/ but nothing else', () => {
    const dir = path.resolve(tmp(), 'case');
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'facts.jsonl')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '.kl', 'decisions.jsonl')), true);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, 'artifacts', 'sheet.md')), false);
    assert.strictEqual(isProtectedCasePath(dir, path.join(dir, '..', 'facts.jsonl')), false);
    assert.strictEqual(isProtectedCasePath(null, path.join(dir, 'facts.jsonl')), false);
  });
});

describe('ToolExecutor ledger write guard', () => {
  it('refuses Write, Edit and MultiEdit on protected case files', async () => {
    const { info } = await setup();
    const executor = new ToolExecutor({
      workingDirectory: info.dir,
      allowedDirectories: [info.dir],
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir: info.dir } }
    });
    const factsPath = path.join(info.dir, 'facts.jsonl');
    const before = fs.readFileSync(factsPath, 'utf8');
    const w = await executor.execute('Write', { file_path: factsPath, content: '{"kind":"fact"}\n' });
    assert.strictEqual(w.success, false);
    assert.match(w.error, /Ledger tool/);
    const e = await executor.execute('Edit', { file_path: path.join(info.dir, '.kl', 'x.json'), old_string: 'a', new_string: 'b' });
    assert.strictEqual(e.success, false);
    const m = await executor.execute('MultiEdit', { edits: [{ file_path: factsPath, old_string: 'a', new_string: 'b' }] });
    assert.strictEqual(m.success, false);
    assert.strictEqual(fs.readFileSync(factsPath, 'utf8'), before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-tools.test.js`
Expected: FAIL with `Cannot find module '../src/tools/builtin/case-tools'`.

- [ ] **Step 3: Implement `src/cases/chat-integration.js`**

```js
// src/cases/chat-integration.js
// Glue between the chat send path and a case: prompt text, tool list
// shaping, and the protected-path check the tool executor uses.
const path = require('path');

const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend']);

const CASE_MODE_PROMPT = [
  'Case mode. This chat is attached to a case. The orientation below was read from the case repository on disk at the start of this turn. It is the authoritative state and outranks anything earlier in the conversation.',
  '',
  'Rules for this case:',
  '- Record every fact you rely on with the Ledger tool: "assert" with a source for what you verified or what the owner told you (provenance "user"); "infer" with a basis for your own derivations; "unknown" for anything you do not know. Never state a guess as a fact.',
  '- Before saying something is missing, record it as an unknown; the Ledger tool reports matching facts in this case and in the owner\'s other cases.',
  '- Ask the owner only what they alone know: history, constraints, preferences, authorization. Decide everything else yourself and record it with the Decide tool.',
  '- Load-bearing unknowns come first. If one blocks the objective, say so and ask. Do not work around it with an assumption.',
  '- Recommendations go through the Recommend tool. If it refuses, fix the cited facts or present the unknowns. Do not restate a refused recommendation in prose.',
  '- When an approach fails, report what happened and stop, with at most one recommendation. Do not start a new plan unasked.',
  '- Never edit facts.jsonl or anything under .kl/ directly. The case tools are the only write path.'
].join('\n');

function shapeToolDefinitions(definitions, attached, registry) {
  const caseNames = new Set(CASE_TOOL_NAMES);
  const base = (definitions || []).filter((d) => !caseNames.has(d.name));
  if (!attached) return base;
  const caseDefs = CASE_TOOL_NAMES
    .map((name) => registry.get(name))
    .filter(Boolean)
    .map((tool) => tool.toFunctionDefinition());
  return [...base, ...caseDefs];
}

function buildCaseSystemPrompt(orientation, base) {
  return [CASE_MODE_PROMPT, orientation, base].filter(Boolean).join('\n\n');
}

function isProtectedCasePath(caseDir, absolutePath) {
  if (!caseDir || !absolutePath) return false;
  const rel = path.relative(path.resolve(caseDir), path.resolve(absolutePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return rel === 'facts.jsonl' || first === '.kl';
}

module.exports = {
  CASE_TOOL_NAMES,
  CASE_MODE_PROMPT,
  shapeToolDefinitions,
  buildCaseSystemPrompt,
  isProtectedCasePath
};
```

- [ ] **Step 4: Implement `src/tools/builtin/case-tools.js`**

```js
// src/tools/builtin/case-tools.js
// The model's only write path into a case (spec §5.6). Every tool reads
// options.caseContext, injected by the chat send path through the tool
// executor's extraToolOptions.
const { Tool } = require('../tool-schema');
const { recommendationGate, findDuplicates } = require('../../cases/gates');

const NO_CASE = Object.freeze({
  ok: false,
  error: 'This chat is not attached to a case. The owner can attach one from Chat Info → Case.'
});

async function withCase(options, fn) {
  const ctx = options?.caseContext;
  if (!ctx || !ctx.runtime || !ctx.caseId) return NO_CASE;
  try {
    return await fn(ctx);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const LedgerTool = new Tool({
  name: 'Ledger',
  description: 'Read and write the case fact ledger. assert: a fact with a source (provenance "sourced", "user" for what the owner said, or "external-agent"). infer: your own derivation, with basis fact ids. unknown: something not known, with what it changes, who can answer, and how. retract: withdraw a fact. query: list facts. Corrections supersede; nothing is edited in place.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['assert', 'infer', 'unknown', 'retract', 'query'] },
      stmt: { type: 'string', description: 'One-sentence statement of the fact or question' },
      subject: { type: 'string', description: 'What the fact is about, e.g. "lot", "house-loan"' },
      attr: { type: 'string', description: 'Which attribute, e.g. "acreage", "payoff"' },
      value: { description: 'The value, if any' },
      unit: { type: 'string' },
      provenance: { type: 'string', enum: ['sourced', 'user', 'external-agent'] },
      source: { type: 'object', description: '{ kind: "url" | "document" | "call" | "api" | "user-message", ref: string }' },
      category: { type: 'string', enum: ['personal', 'financial', 'legal', 'health', 'property', 'ops', 'general'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      supersedes: { type: 'string', description: 'Fact id this corrects or answers' },
      basis: { type: 'array', items: { type: 'string' }, description: 'For infer: fact ids this rests on' },
      changes: { type: 'string', description: 'For unknown: what an answer would change' },
      answerable: { type: 'string', description: 'For unknown: who or what can answer (owner, an executor, a record)' },
      how: { type: 'string', description: 'For unknown: the step that would answer it' },
      loadBearing: { type: 'boolean' },
      id: { type: 'string', description: 'For retract: the fact id' },
      reason: { type: 'string', description: 'For retract: why' },
      filter: { type: 'object', description: 'For query: { subject?, attr?, provenance?, status?, text? }' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    switch (params.action) {
      case 'assert': {
        const input = { ...params, addedBy: ctx.turnId };
        if (input.provenance === 'user' && !input.source) input.source = { kind: 'user-message', ref: ctx.turnId };
        return { ok: true, fact: ledger.assert(input) };
      }
      case 'infer':
        return {
          ok: true,
          fact: ledger.infer({ ...params, addedBy: ctx.turnId }),
          note: 'Inferred facts cannot support a recommendation or leave the system.'
        };
      case 'unknown': {
        const dups = findDuplicates({
          subject: params.subject,
          attr: params.attr,
          text: params.stmt,
          facts: ledger.view().facts,
          otherCases: ctx.runtime.otherCaseFacts(ctx.caseId)
        });
        if (dups.exact.length) {
          return {
            ok: false,
            error: `This case already has ${dups.exact.map((m) => m.id).join(', ')} for ${params.subject}.${params.attr}. Use it, or supersede it, instead of recording a new unknown.`,
            matches: dups.exact
          };
        }
        const fact = ledger.unknown({ ...params, addedBy: ctx.turnId });
        return {
          ok: true,
          fact,
          similarInOtherCases: dups.similar,
          ...(dups.similar.length ? { note: 'Other cases hold related facts. Check them before asking the owner.' } : {})
        };
      }
      case 'retract':
        if (!params.id || !params.reason) return { ok: false, error: 'retract needs "id" and "reason".' };
        return { ok: true, fact: ledger.retract(params.id, params.reason) };
      case 'query':
        return { ok: true, facts: ledger.query(params.filter || {}) };
      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  })
});

const BriefTool = new Tool({
  name: 'Brief',
  description: 'Read or update the case brief. "why", "hardConstraints" and "alreadyTried" can only be set from what the owner said (provenance "user"). completeGating marks the brief ready; recommendations are refused until then.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'update', 'append', 'completeGating'] },
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality'] },
      value: { description: 'For update: the new value' },
      item: { type: 'string', description: 'For append: one list entry' },
      provenance: { type: 'string', enum: ['user', 'model'] },
      reason: { type: 'string' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, async (ctx) => {
    const brief = ctx.runtime.brief(ctx.caseId);
    if (params.action === 'read') {
      return { ok: true, brief: brief.read().data, missingForGating: brief.missingForGating() };
    }
    if (params.action === 'completeGating') {
      return { ok: true, status: ctx.runtime.completeGating(ctx.caseId).status };
    }
    if (!params.field) return { ok: false, error: `${params.action} needs "field".` };
    const provenance = params.provenance || 'model';
    const data = params.action === 'append'
      ? brief.append(params.field, params.item, { provenance })
      : brief.update(params.field, params.value, { provenance });
    ctx.runtime.records(ctx.caseId).writeJournal(
      'brief',
      `Brief ${params.field} ${params.action === 'append' ? 'appended' : 'updated'} (${provenance})${params.reason ? `: ${params.reason}` : ''}\n\n${JSON.stringify(params.action === 'append' ? params.item : params.value)}`
    );
    return { ok: true, brief: data };
  })
});

const DecideTool = new Tool({
  name: 'Decide',
  description: 'Record a decision you made, citing the fact ids it rests on and the alternatives you rejected. Cited facts become load-bearing, so a later correction to any of them flags this decision.',
  parameters: {
    type: 'object',
    properties: {
      decision: { type: 'string' },
      factIds: { type: 'array', items: { type: 'string' } },
      alternatives: { type: 'array', items: { type: 'string' } }
    },
    required: ['decision', 'factIds']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const bad = params.factIds.filter((id) => facts.get(id)?.status !== 'active');
    if (bad.length) return { ok: false, error: `These fact ids are missing or no longer active: ${bad.join(', ')}.` };
    ledger.markLoadBearing(params.factIds);
    const decision = ctx.runtime.records(ctx.caseId).recordDecision({
      decision: params.decision,
      factIds: params.factIds,
      alternatives: params.alternatives || []
    });
    const inferred = params.factIds.filter((id) => facts.get(id).provenance === 'inferred');
    return {
      ok: true,
      decision,
      ...(inferred.length ? { warning: `This decision rests on inferred facts (${inferred.join(', ')}). Say so when you report it.` } : {})
    };
  })
});

const RecommendTool = new Tool({
  name: 'Recommend',
  description: 'Propose a recommendation to the owner. Each load-bearing claim must cite active sourced or owner-stated fact ids. The gate refuses claims resting on inferences, unknowns, corrected facts, or subjects with open load-bearing unknowns, and refuses everything until the brief gating pass is complete. On success, present the returned text as written.',
  parameters: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            factIds: { type: 'array', items: { type: 'string' } },
            loadBearing: { type: 'boolean' }
          },
          required: ['text', 'factIds']
        }
      },
      unknowns: { type: 'array', items: { type: 'string' }, description: 'Extra unknown fact ids to list before the recommendation' }
    },
    required: ['claims']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, async (ctx) => {
    const meta = ctx.runtime.getCase(ctx.caseId);
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const gate = recommendationGate({ status: meta.status, claims: params.claims, facts });
    if (!gate.ok) {
      return {
        ok: false,
        error: 'Recommendation refused by the recommendation gate. Fix the cited facts, or present the open unknowns instead of recommending.',
        failures: gate.failures
      };
    }
    const cited = [...new Set(params.claims.flatMap((c) => c.factIds || []))];
    ledger.markLoadBearing(cited);
    const extra = new Set(params.unknowns || []);
    const open = [...facts.values()].filter((f) => f.provenance === 'unknown' && f.status === 'active' && (f.loadBearing || extra.has(f.id)));
    const rendered = [
      'Open load-bearing unknowns:',
      ...(open.length ? open.map((u) => `- ${u.stmt} (${u.id}; changes: ${u.changes || '—'})`) : ['- none']),
      '',
      'Recommendation:',
      ...params.claims.map((c) => `- ${c.text}${c.factIds?.length ? ` [${c.factIds.join(', ')}]` : ''}`)
    ].join('\n');
    ctx.runtime.records(ctx.caseId).recordRecommendation({
      turnId: ctx.turnId,
      claims: params.claims,
      unknowns: open.map((u) => u.id)
    });
    return { ok: true, rendered, instruction: 'Present this to the owner as written: unknowns first, then the recommendation with its fact ids.' };
  })
});

module.exports = { LedgerTool, BriefTool, DecideTool, RecommendTool };
```

- [ ] **Step 5: Register the tools in `src/tools/index.js`**

Add after the `ImageGenerateTool` require:

```js
const { LedgerTool, BriefTool, DecideTool, RecommendTool } = require('./builtin/case-tools');
```

Add after `toolRegistry.register(ImageGenerateTool);`:

```js
  toolRegistry.register(LedgerTool);
  toolRegistry.register(BriefTool);
  toolRegistry.register(DecideTool);
  toolRegistry.register(RecommendTool);
```

- [ ] **Step 6: Add the write guard to `src/execution/tool-executor.js`**

At the top, after `const { evaluateRules, describeRule } = require('../tools/permission-rules');`:

```js
const path = require('path');
const { isProtectedCasePath } = require('../cases/chat-integration');

// Tools that write a file named by file_path (MultiEdit: per edit). In case
// mode, facts.jsonl and .kl/ are written only through the case tools.
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
```

In `execute()`, immediately after the block

```js
    try {
      tool.validateParameters(effectiveParameters);
    } catch (validationError) {
      const errorResult = { success: false, error: validationError.message };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: errorResult });
      return errorResult;
    }
```

insert:

```js
    const caseContext = this.extraToolOptions.caseContext;
    if (caseContext && FILE_WRITE_TOOLS.has(toolName)) {
      const base = options.workingDirectory || this.workingDirectory;
      const targets = [
        effectiveParameters.file_path,
        ...(Array.isArray(effectiveParameters.edits) ? effectiveParameters.edits.map((e) => e?.file_path) : [])
      ].filter((p) => typeof p === 'string' && p);
      if (targets.some((p) => isProtectedCasePath(caseContext.dir, path.resolve(base, p)))) {
        const refused = {
          success: false,
          error: 'facts.jsonl and .kl/ are written only through the case tools. Use the Ledger tool (or Brief, Decide, Recommend) instead.'
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
        return refused;
      }
    }
```

Note: `extraToolOptions` in `createCore` is an object with getters (Task 9 adds a `caseContext` getter), so reading the property here is live per executor.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/cases-tools.test.js`
Expected: PASS, `# fail 0`.

Run: `node --test tests/agent-loop.test.js tests/approval-rule-precedence.test.js tests/ask-user-tool.test.js`
Expected: PASS, `# fail 0` (nothing else in the executor changed).

- [ ] **Step 8: Commit**

```bash
git add src/cases/chat-integration.js src/tools/builtin/case-tools.js src/tools/index.js src/execution/tool-executor.js tests/cases-tools.test.js
git commit -m "feat(cases): Ledger, Brief, Decide and Recommend tools with a ledger write guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Settings and core wiring

**Files:**
- Modify: `src/core/settings.js`, `src/core/create-core.js`
- Test: `tests/cases-core.test.js`

**Interfaces:**
- Consumes: `CaseRuntime`, `resolveCasesRoot` (Task 7); the write guard reads `extraToolOptions.caseContext` (Task 8).
- Produces:
  - `settings.cases = { root: '' }` (default), merged like `checkpoints`.
  - `core.context.getCaseRuntime(): CaseRuntime`.
  - `createToolExecutorWithApprovals(event, env, requester, { ..., caseContext })` threads `caseContext` to every tool call as `options.caseContext` (through a getter on `extraToolOptions`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-core.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { mergeSettings } = require('../src/core/settings');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
const savedEnv = process.env.KL_CASES_ROOT;
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
});

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-core-'));
  tempDirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  };
}

describe('cases settings', () => {
  it('defaults cases.root to empty and merges an override', () => {
    assert.deepStrictEqual(mergeSettings({}).cases, { root: '' });
    assert.strictEqual(mergeSettings({ cases: { root: '/elsewhere' } }).cases.root, '/elsewhere');
  });
});

describe('createCore cases wiring', () => {
  it('exposes a case runtime rooted in the data dir without creating anything', () => {
    delete process.env.KL_CASES_ROOT;
    const deps = makeDeps();
    const core = createCore(deps);
    const runtime = core.context.getCaseRuntime();
    assert.strictEqual(runtime.root, path.join(deps.paths.dataDir, 'cases'));
    assert.strictEqual(fs.existsSync(runtime.root), false);
  });

  it('honours KL_CASES_ROOT', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-env-'));
    tempDirs.push(elsewhere);
    process.env.KL_CASES_ROOT = elsewhere;
    const core = createCore(makeDeps());
    assert.strictEqual(core.context.getCaseRuntime().root, elsewhere);
  });

  it('threads caseContext through the tool executor to the case tools and the write guard', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(makeDeps());
    await core.start();
    try {
      const runtime = core.context.getCaseRuntime();
      const info = await runtime.createCase({ title: 'Lakeside lot' });
      const executor = await core.context.createToolExecutorWithApprovals(null, { platform: process.platform }, null, {
        workingDirectory: info.dir,
        allowedDirectories: [info.dir],
        useSandbox: false,
        caseContext: { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir }
      });
      const q = await executor.execute('Ledger', { action: 'query' });
      assert.strictEqual(q.ok, true);
      assert.deepStrictEqual(q.facts, []);
      const w = await executor.execute('Write', { file_path: path.join(info.dir, 'facts.jsonl'), content: 'x' });
      assert.strictEqual(w.success, false);
    } finally {
      await core.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-core.test.js`
Expected: FAIL — `mergeSettings({}).cases` is `undefined`, and `core.context.getCaseRuntime is not a function`.

- [ ] **Step 3: Add the settings default**

In `src/core/settings.js`, in `DEFAULT_SETTINGS`, after the `checkpoints: { … },` block add:

```js
  // Case repositories (docs/superpowers/specs/2026-09-22-king-louie-cases-design.md).
  // Empty root means KL_CASES_ROOT, else <dataDir>/cases.
  cases: {
    root: ''
  },
```

In `mergeSettings`, after the `checkpoints: { … },` entry add:

```js
    cases: {
      ...(DEFAULT_SETTINGS.cases || {}),
      ...(source.cases || {})
    },
```

- [ ] **Step 4: Wire the runtime into `src/core/create-core.js`**

With the other top-level requires, add:

```js
const { CaseRuntime, resolveCasesRoot } = require('../cases');
```

In `createToolExecutorWithApprovals`, inside the `extraToolOptions: { … }` object, directly after the line `get backgroundTaskManager() { return backgroundTaskManager; },` add:

```js
        // Case mode: the chat send path passes { runtime, caseId, turnId, dir }.
        // The case tools read it, and ToolExecutor's ledger write guard uses dir.
        get caseContext() { return executorOptions.caseContext || null; },
```

Directly before the line `const context = {` (the object handed to IPC), add:

```js
  // Constructing the runtime touches nothing on disk; the root directory is
  // created with the first case.
  const caseRuntime = new CaseRuntime({
    root: resolveCasesRoot({ settings: getSettings(), env: process.env, dataDir: userDataPath })
  });
```

Inside `const context = {`, under the `// Chat` group, after `getSettings,` add:

```js
    getCaseRuntime: () => caseRuntime,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/cases-core.test.js tests/core-create.test.js tests/core-settings.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/core/settings.js src/core/create-core.js tests/cases-core.test.js
git commit -m "feat(cases): construct the case runtime in core and thread caseContext to tools

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Case turns in the chat send path

**Files:**
- Modify: `src/ipc/chat-handlers.js`
- Test: `tests/cases-chat.test.js`

**Interfaces:**
- Consumes: `context.getCaseRuntime()` (Task 9); `CaseRuntime.beginTurn/endTurn` (Task 7); `buildCaseSystemPrompt`, `shapeToolDefinitions` (Task 8). A chat is attached when `chat.caseId` is set (Task 11 sets it).
- Produces: for a chat with `caseId`, every `chat:sendMessage`:
  1. begins a case turn (`turnId = 'turn-' + runId`) before the response starts — a busy case returns `{ ok: false, error: 'Case "…" is busy…' }` and runs nothing;
  2. prepends case-mode text and the orientation to the system prompt;
  3. adds the case tools to the tool list and forces the agent loop on;
  4. passes `caseContext` to the tool executor;
  5. ends the turn after the response (`journal` = final assistant text, `summary` = the user message), or after a failure (`summary` = `turn failed: <message>`, no journal).
  Chats without `caseId` get no case tools and an unchanged prompt.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-chat.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseBusyError } = require('../src/cases');
const { CASE_TOOL_NAMES } = require('../src/cases/chat-integration');

initializeTools();

// A minimal context for chat:sendMessage. Anything not overridden resolves to
// a function returning null, which the send path treats as "feature absent".
// If the handler starts dereferencing another context function, add it here.
function harness({ caseId = 'case-1', beginError = null, loopError = null } = {}) {
  const calls = { begin: [], end: [], executorOptions: null, run: null };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      if (beginError) throw beginError;
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION-BLOCK' };
    },
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); return 'abc1234'; }
  };
  class FakeLoop {
    async run(messages, tools, options) {
      calls.run = { messages, tools, options };
      if (loopError) throw loopError;
      return { content: 'Answer text', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } };
    }
  }
  const overrides = {
    getChats: () => [chat],
    setChats: () => {},
    appendMessageToChat: (_id, sender, text) => { chat.messages.push({ id: `m${chat.messages.length}`, sender, text }); return chat; },
    runHookEvent: async () => ({}),
    resolveInference: async () => ({
      providerType: 'openai',
      provider: { sendMessageWithTools: async () => ({}), streamMessage: async () => ({}) },
      model: 'test-model', tier: 'standard', timeoutMs: 1000
    }),
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async (_event, _env, _req, opts) => {
      calls.executorOptions = opts;
      return { on() {}, execute: async () => ({ ok: true }) };
    },
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop: FakeLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    getCaseRuntime: () => runtime,
    createId: () => `id-${Math.random().toString(16).slice(2)}`
  };
  const context = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const event = { sender: { send() {}, isDestroyed: () => false } };
  const send = (payload = {}) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message: 'What should I do next?', ...payload });
  return { calls, send };
}

describe('chat:sendMessage in case mode', () => {
  it('begins a turn, injects orientation and case tools, and ends the turn with the answer', async () => {
    const { calls, send } = harness();
    const result = await send({ agentMode: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.begin.length, 1);
    assert.strictEqual(calls.begin[0].id, 'case-1');
    assert.match(calls.begin[0].turnId, /^turn-/);
    const prompt = calls.run.options.systemPrompt;
    assert.ok(prompt.startsWith('Case mode.'), 'case prompt first');
    assert.ok(prompt.indexOf('ORIENTATION-BLOCK') < prompt.indexOf('BASE-PROMPT'));
    const toolNames = calls.run.tools.map((t) => t.name);
    for (const name of CASE_TOOL_NAMES) assert.ok(toolNames.includes(name), `${name} offered`);
    assert.strictEqual(calls.executorOptions.caseContext.caseId, 'case-1');
    assert.strictEqual(calls.executorOptions.caseContext.dir, '/cases/lakeside-lot');
    assert.strictEqual(calls.end.length, 1);
    assert.strictEqual(calls.end[0].journal, 'Answer text');
    assert.strictEqual(calls.end[0].summary, 'What should I do next?');
  });

  it('leaves chats without a case untouched', async () => {
    const { calls, send } = harness({ caseId: null });
    await send({ agentMode: true });
    assert.strictEqual(calls.begin.length, 0);
    assert.ok(!calls.run.tools.some((t) => CASE_TOOL_NAMES.includes(t.name)));
    assert.ok(!calls.run.options.systemPrompt.includes('Case mode.'));
    assert.strictEqual(calls.executorOptions.caseContext, null);
  });

  it('refuses the turn when the case is busy and runs nothing', async () => {
    const { calls, send } = harness({ beginError: new CaseBusyError('Lakeside lot') });
    const result = await send();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /busy/);
    assert.strictEqual(calls.run, null);
    assert.strictEqual(calls.end.length, 0);
  });

  it('ends the turn when the agent loop fails', async () => {
    const { calls, send } = harness({ loopError: new Error('provider exploded') });
    await send();
    assert.strictEqual(calls.end.length, 1);
    assert.match(calls.end[0].summary, /^turn failed: provider exploded/);
    assert.strictEqual(calls.end[0].journal, null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-chat.test.js`
Expected: FAIL — `calls.begin.length` is `0` in the first test.

- [ ] **Step 3: Import the helpers**

In `src/ipc/chat-handlers.js`, after `const { createLogger } = require('../logging');` add:

```js
const { buildCaseSystemPrompt, shapeToolDefinitions } = require('../cases/chat-integration');
```

- [ ] **Step 4: Begin the case turn**

In the `IPC.CHAT_SEND_MESSAGE` handler, replace

```js
    const responseId = createId();
    const runId = createId();
```

with

```js
    const responseId = createId();
    const runId = createId();

    // Case mode (spec §5): begin before anything is streamed so a busy case
    // refuses cleanly. beginTurn commits owner edits and builds orientation.
    const caseId = chatForDir?.caseId || null;
    const caseRuntime = caseId && typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    let caseTurn = caseRuntime ? await caseRuntime.beginTurn(caseId, { turnId: `turn-${runId}` }) : null;
    const endCaseTurn = async (fields) => {
      if (!caseTurn) return;
      const turn = caseTurn;
      caseTurn = null;
      await caseRuntime.endTurn(turn, fields).catch((err) => log.warn(`Case turn commit failed: ${err.message}`));
    };
```

- [ ] **Step 5: Prepend the orientation to the system prompt**

Directly after the fallback block

```js
      // Fallback: full system prompt + all tools
      if (!options.systemPrompt) {
        options.systemPrompt = [
          buildRuntimeSystemPrompt(runtimeEnvironment),
          memoryContext
        ].filter(Boolean).join('\n\n');
      }
```

add

```js
      if (caseTurn) {
        options.systemPrompt = buildCaseSystemPrompt(caseTurn.orientation, options.systemPrompt);
      }
```

- [ ] **Step 6: Pass caseContext to the executor**

In the `createToolExecutorWithApprovals(event, runtimeEnvironment, null, { … })` call, add a property after `chatId`:

```js
        chatId,
        caseContext: caseTurn
          ? { runtime: caseRuntime, caseId, turnId: caseTurn.turnId, dir: caseTurn.dir }
          : null
```

- [ ] **Step 7: Offer the case tools and force the agent loop**

Replace

```js
      const toolDefinitions = filterMcpTools(assembledTools || toolRegistry.getFunctionDefinitions());
```

with

```js
      const toolDefinitions = shapeToolDefinitions(
        filterMcpTools(assembledTools || toolRegistry.getFunctionDefinitions()),
        Boolean(caseTurn),
        toolRegistry
      );
```

and replace

```js
        const canUseAgentMode = agentMode && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
```

with

```js
        // A case turn always runs the agent loop: the case tools are how it works.
        const canUseAgentMode = (agentMode || Boolean(caseTurn)) && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
```

- [ ] **Step 8: End the case turn on success and on failure**

In the success path, replace

```js
      activeRuns.delete(chatId);

      const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
```

with

```js
      activeRuns.delete(chatId);
      await endCaseTurn({ summary: safeMessage, journal: fullResponse || null });

      const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
```

In the `catch (error) {` block of the same handler, replace its first line

```js
    } catch (error) {
      activeRuns.delete(chatId);
```

with

```js
    } catch (error) {
      activeRuns.delete(chatId);
      await endCaseTurn({ summary: `turn failed: ${error?.message || error}`, journal: null });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/cases-chat.test.js tests/ipc-contract.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/ipc/chat-handlers.js tests/cases-chat.test.js
git commit -m "feat(cases): run chat turns in case mode when the chat has a case

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Case IPC channels and the preload bridge

**Files:**
- Create: `src/ipc/case-handlers.js`
- Modify: `src/ipc/constants.js`, `src/ipc/register.js`, `preload.js`
- Test: `tests/cases-ipc.test.js`

**Interfaces:**
- Consumes: `context.getCaseRuntime()` (Task 9), `context.getChats()` / `context.setChats()` (existing).
- Produces (all return `{ ok: true, … }` or `{ ok: false, error }`):
  - `case:list` → `{ cases: CaseSummary[] }` where `CaseSummary = { id, slug, title, type, status, created, dir }`.
  - `case:create` `{ title, type?, objective?, chatId? }` → `{ case: CaseSummary, chat: Chat|null }` (attaches when `chatId` is given).
  - `case:attach` `{ chatId, caseId|null }` → `{ chat }` (`null` detaches).
  - `case:orientation` `{ caseId }` → `{ text }`.
  - `case:setDisclosable` `{ caseId, factId, disclosable: boolean }` → `{ fact }`. This is the owner-only path to flip disclosability (spec §4.4); no model tool exposes it.
  - Preload: `window.electron.cases.{ list, create, attach, orientation, setDisclosable }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cases-ipc.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup({ withRuntime = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-ipc-'));
  dirs.push(root);
  const runtime = new CaseRuntime({ root });
  let chats = [{ id: 'chat-1', title: 'Chat', messages: [] }];
  const context = {
    getCaseRuntime: () => (withRuntime ? runtime : null),
    getChats: () => chats,
    setChats: (next) => { chats = next; }
  };
  const handlers = new Map();
  registerCaseHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, context);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { runtime, call, chats: () => chats };
}

describe('case IPC', () => {
  it('creates a case, attaches it to the chat, and lists it', async () => {
    const { call, chats } = setup();
    const created = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', objective: 'Convert the lot to cash', chatId: 'chat-1' });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.case.title, 'Lakeside lot');
    assert.strictEqual(created.case.status, 'draft');
    assert.strictEqual(chats()[0].caseId, created.case.id);
    const listed = await call(IPC.CASE_LIST);
    assert.deepStrictEqual(listed.cases.map((c) => c.id), [created.case.id]);
  });

  it('attaches, detaches and refuses unknown cases or chats', async () => {
    const { call, chats } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'A' });
    assert.strictEqual(chats()[0].caseId, undefined);
    assert.strictEqual((await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: c.id })).chat.caseId, c.id);
    assert.strictEqual((await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: null })).chat.caseId, null);
    const badCase = await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: 'nope' });
    assert.strictEqual(badCase.ok, false);
    assert.match(badCase.error, /Case not found/);
    const badChat = await call(IPC.CASE_ATTACH, { chatId: 'nope', caseId: c.id });
    assert.strictEqual(badChat.ok, false);
  });

  it('returns the orientation text', async () => {
    const { call } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'Lakeside lot' });
    const o = await call(IPC.CASE_ORIENTATION, { caseId: c.id });
    assert.strictEqual(o.ok, true);
    assert.match(o.text, /# Case: Lakeside lot/);
  });

  it('lets the owner flip disclosability', async () => {
    const { call, runtime } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'A' });
    const f = runtime.ledger(c.id).assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: { kind: 'document', ref: 'sources/payoff.pdf' } });
    const r = await call(IPC.CASE_SET_DISCLOSABLE, { caseId: c.id, factId: f.id, disclosable: true });
    assert.strictEqual(r.fact.disclosable, true);
    const bad = await call(IPC.CASE_SET_DISCLOSABLE, { caseId: c.id, factId: f.id, disclosable: 'yes' });
    assert.strictEqual(bad.ok, false);
  });

  it('refuses an empty title and reports a missing runtime', async () => {
    assert.strictEqual((await setup().call(IPC.CASE_CREATE, { title: '  ' })).ok, false);
    const r = await setup({ withRuntime: false }).call(IPC.CASE_LIST);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not available/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cases-ipc.test.js`
Expected: FAIL with `Cannot find module '../src/ipc/case-handlers'`.

- [ ] **Step 3: Add the channel constants**

In `src/ipc/constants.js`, after `MEMORY_CLEAR: 'memory:clear',` add:

```js

  CASE_LIST: 'case:list',
  CASE_CREATE: 'case:create',
  CASE_ATTACH: 'case:attach',
  CASE_ORIENTATION: 'case:orientation',
  CASE_SET_DISCLOSABLE: 'case:setDisclosable',
```

- [ ] **Step 4: Implement `src/ipc/case-handlers.js`**

```js
// src/ipc/case-handlers.js
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

const summarize = (c) => ({
  id: c.id, slug: c.slug, title: c.title, type: c.type, status: c.status, created: c.created, dir: c.dir
});

function registerCaseHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const attach = (chatId, caseId) => {
    const chats = context.getChats();
    if (!chats.some((c) => c.id === chatId)) throw new Error('Chat not found.');
    const now = new Date().toISOString();
    const updated = chats.map((c) => (c.id === chatId ? { ...c, caseId: caseId || null, updatedAt: now } : c));
    context.setChats(updated);
    return updated.find((c) => c.id === chatId);
  };

  ipcMain.handle(IPC.CASE_LIST, wrapHandler(IPC.CASE_LIST, async () => (
    { ok: true, cases: runtime().listCases().map(summarize) }
  )));

  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (_event, { title, type, objective, chatId } = {}) => {
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    const info = await runtime().createCase({ title: title.trim(), type: type || 'general', objective: objective || '' });
    return { ok: true, case: summarize(info), chat: chatId ? attach(chatId, info.id) : null };
  }));

  ipcMain.handle(IPC.CASE_ATTACH, wrapHandler(IPC.CASE_ATTACH, async (_event, { chatId, caseId } = {}) => {
    if (caseId) runtime().getCase(caseId);
    return { ok: true, chat: attach(chatId, caseId) };
  }));

  ipcMain.handle(IPC.CASE_ORIENTATION, wrapHandler(IPC.CASE_ORIENTATION, async (_event, { caseId } = {}) => (
    { ok: true, text: runtime().orientation(caseId) }
  )));

  ipcMain.handle(IPC.CASE_SET_DISCLOSABLE, wrapHandler(IPC.CASE_SET_DISCLOSABLE, async (_event, { caseId, factId, disclosable } = {}) => {
    if (typeof disclosable !== 'boolean') return { ok: false, error: 'disclosable must be true or false.' };
    return { ok: true, fact: runtime().ledger(caseId).setDisclosable(factId, disclosable) };
  }));
}

module.exports = { registerCaseHandlers };
```

- [ ] **Step 5: Register the handlers**

In `src/ipc/register.js`, add after `const { registerCanvasHandlers } = require('./canvas-handlers');`:

```js
const { registerCaseHandlers } = require('./case-handlers');
```

and after `registerCanvasHandlers(ipcMain, context);`:

```js
  registerCaseHandlers(ipcMain, context);
```

- [ ] **Step 6: Expose the bridge in `preload.js`**

Directly after the `memory: { … },` namespace (whose last line is `clear: () => ipcRenderer.invoke('memory:clear')` followed by `},`), add:

```js
    cases: {
      list: () => ipcRenderer.invoke('case:list'),
      create: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.title, 'title', { minLength: 1 });
        return ipcRenderer.invoke('case:create', payload);
      },
      attach: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId', { minLength: 1 });
        return ipcRenderer.invoke('case:attach', payload);
      },
      orientation: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        return ipcRenderer.invoke('case:orientation', payload);
      },
      setDisclosable: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.caseId, 'caseId', { minLength: 1 });
        validateString(payload.factId, 'factId', { minLength: 1 });
        if (typeof payload.disclosable !== 'boolean') throw new Error('Invalid disclosable: expected boolean');
        return ipcRenderer.invoke('case:setDisclosable', payload);
      }
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/cases-ipc.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/ipc/case-handlers.js src/ipc/constants.js src/ipc/register.js preload.js tests/cases-ipc.test.js
git commit -m "feat(cases): IPC channels and preload bridge for cases

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Case section in Chat Info, with an end-to-end test

**Files:**
- Modify: `renderer.js` (`renderChatInfoPopover`, new `renderChatCaseSection`), `styles.css`
- Test: `tests/e2e/cases.test.js`

**Interfaces:**
- Consumes: `window.electron.cases.*` (Task 11); `appState.chats`, `faIcon`, `chatLog` (existing in `renderer.js`).
- Produces: in the Chat Info popover, a "Case" section with `#chat-case-select` (None / each case / "New case…"), an inline `#chat-case-new-title` + `#chat-case-create-btn`, `#chat-case-orientation-btn` and `#chat-case-orientation` (`<pre>`), and `#chat-case-error`. No native dialogs.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/cases.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: cases', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  const savedRoot = process.env.KL_CASES_ROOT;

  before(async () => {
    // helpers.launchApp passes process.env to the app, so case repos land in
    // a temp dir instead of the real profile.
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-cases-'));
    process.env.KL_CASES_ROOT = casesRoot;
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('creates a case from Chat Info, attaches it, and shows its orientation', async () => {
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select')`);

    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-title').closest('[hidden]')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-title').value = 'E2E lakeside lot';
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);

    await waitFor(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`);
    await evaluate(ctx, `document.getElementById('chat-case-orientation-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('chat-case-orientation')?.textContent || '').includes('E2E lakeside lot')`);

    const slugs = fs.readdirSync(casesRoot);
    assert.deepStrictEqual(slugs, ['e2e-lakeside-lot']);
    assert.ok(fs.existsSync(path.join(casesRoot, 'e2e-lakeside-lot', 'facts.jsonl')));
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: FAIL — `waitFor` times out on `#chat-case-select`.

- [ ] **Step 3: Add the section to `renderChatInfoPopover` in `renderer.js`**

In `renderChatInfoPopover`, replace

```js
  rows.forEach(appendRow);
```

with

```js
  rows.forEach(appendRow);

  /* --- Case section (filled asynchronously into a fixed slot) --- */
  appendRow({ divider: true });
  appendRow({ section: 'Case' });
  const caseSlot = document.createElement('div');
  caseSlot.id = 'chat-case-section';
  dom.chatInfoPopoverBody.appendChild(caseSlot);
  renderChatCaseSection(chat, caseSlot).catch((err) => chatLog.warn(`Case section failed: ${err.message}`));
```

- [ ] **Step 4: Add `renderChatCaseSection` to `renderer.js`**

Add directly above `function renderChatInfoPopover() {`:

```js
async function renderChatCaseSection(chat, container) {
  container.innerHTML = '';
  const listed = await window.electron.cases.list();
  const cases = listed?.ok ? listed.cases : [];

  const error = document.createElement('div');
  error.id = 'chat-case-error';
  error.className = 'chat-case-error';
  const showError = (message) => { error.textContent = message || ''; };

  const row = document.createElement('div');
  row.className = 'chat-info-row';
  const label = document.createElement('span');
  label.className = 'chat-info-label';
  label.appendChild(faIcon('fas fa-briefcase'));
  label.appendChild(document.createTextNode('Attached case'));
  const select = document.createElement('select');
  select.className = 'chat-info-select';
  select.id = 'chat-case-select';
  const addOption = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  };
  addOption('', 'None');
  cases.forEach((c) => addOption(c.id, `${c.title} (${c.status})`));
  addOption('__new__', 'New case…');
  select.value = chat.caseId && cases.some((c) => c.id === chat.caseId) ? chat.caseId : '';
  row.append(label, select);

  const newRow = document.createElement('div');
  newRow.className = 'chat-info-row chat-case-new';
  newRow.hidden = true;
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = 'chat-case-new-title';
  titleInput.className = 'chat-info-input';
  titleInput.placeholder = 'Case title';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.id = 'chat-case-create-btn';
  createBtn.className = 'secondary-button';
  createBtn.textContent = 'Create';
  newRow.append(titleInput, createBtn);

  const orientationBtn = document.createElement('button');
  orientationBtn.type = 'button';
  orientationBtn.id = 'chat-case-orientation-btn';
  orientationBtn.className = 'secondary-button';
  orientationBtn.textContent = 'Show orientation';
  orientationBtn.hidden = !chat.caseId;
  const orientation = document.createElement('pre');
  orientation.id = 'chat-case-orientation';
  orientation.className = 'chat-case-orientation';
  orientation.hidden = true;

  container.append(row, newRow, orientationBtn, orientation, error);

  const adopt = async (updatedChat) => {
    if (!updatedChat) return;
    appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
    await renderChatCaseSection(updatedChat, container);
  };

  select.addEventListener('change', async () => {
    showError('');
    if (select.value === '__new__') {
      newRow.hidden = false;
      titleInput.focus();
      return;
    }
    newRow.hidden = true;
    const result = await window.electron.cases.attach({ chatId: chat.id, caseId: select.value || null });
    if (!result?.ok) { showError(result?.error || 'Could not attach the case.'); return; }
    await adopt(result.chat);
  });

  createBtn.addEventListener('click', async () => {
    showError('');
    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    const result = await window.electron.cases.create({ title, chatId: chat.id });
    if (!result?.ok) { showError(result?.error || 'Could not create the case.'); return; }
    await adopt(result.chat);
  });

  orientationBtn.addEventListener('click', async () => {
    const result = await window.electron.cases.orientation({ caseId: chat.caseId });
    orientation.textContent = result?.ok ? result.text : (result?.error || 'Could not load the orientation.');
    orientation.hidden = false;
  });
}
```

- [ ] **Step 5: Style it in `styles.css`**

Add after the `.chat-info-select:focus { … }` rule:

```css
.chat-info-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: transparent;
  color: inherit;
}

.chat-case-new {
  gap: 6px;
}

.chat-case-orientation {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  margin: 6px 0 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.12);
}

.chat-case-error {
  color: #d9534f;
  font-size: 12px;
  min-height: 0;
}
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js`
Expected: PASS, `# fail 0`.

Run: `node --test tests/ipc-contract.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer.js styles.css tests/e2e/cases.test.js
git commit -m "feat(cases): create, attach and inspect cases from Chat Info

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Regression fixtures from the evidence sessions

**Files:**
- Test: `tests/cases-regressions.test.js`

**Interfaces:**
- Consumes: `CaseRuntime` (Task 7) and the four case tools (Task 8), called exactly as the agent loop calls them: `Tool.execute(params, { caseContext })`.
- Produces: one test per stage-1-relevant failure pattern from spec §1.1 (F1, F2, F5, F6), with invented data. Later stages add F3, F4 and F7 to this file.

- [ ] **Step 1: Write the tests**

```js
// tests/cases-regressions.test.js
// Each scenario replays a failure pattern from the cases spec (§1.1) with
// invented data, and pins the behaviour that would have prevented it.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { LedgerTool, BriefTool, DecideTool, RecommendTool } = require('../src/tools/builtin/case-tools');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-regress-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://listings.example.org/search?q=lakeside' };

async function openCase(runtime, title, { active = true } = {}) {
  const info = await runtime.createCase({ title, objective: 'Convert the property to cash' });
  if (active) {
    runtime.brief(info.id).update('why', 'Cash is needed for another repair', { provenance: 'user' });
    runtime.brief(info.id).append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    runtime.completeGating(info.id);
  }
  return { info, opts: { caseContext: { runtime, caseId: info.id, turnId: 'turn-1', dir: info.dir } } };
}

describe('F1: a guess never becomes a fact', () => {
  it('an ambiguous noun is recorded as an unknown, and a recommendation built on the guess is refused', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { info, opts } = await openCase(runtime, 'Lakeside lot');
    const said = await LedgerTool.execute({ action: 'assert', provenance: 'user', stmt: 'Owner: I must move 12 Birch and this lot', subject: 'owner', attr: 'must-sell', value: ['12 Birch', 'lakeside lot'] }, opts);
    const guess = await LedgerTool.execute({ action: 'infer', stmt: '12 Birch is a stand of timber', subject: '12-birch', attr: 'kind', value: 'timber', basis: [said.fact.id] }, opts);

    const rec = await RecommendTool.execute({ claims: [{ text: 'Sell the timber to a mill', factIds: [guess.fact.id] }] }, opts);
    assert.strictEqual(rec.ok, false);
    assert.match(JSON.stringify(rec.failures), /inferred/);

    const unknown = await LedgerTool.execute({ action: 'unknown', stmt: 'What is 12 Birch?', subject: '12-birch', attr: 'kind', changes: 'Which asset is being sold', answerable: 'owner', how: 'Ask the owner', loadBearing: true }, opts);
    assert.strictEqual(unknown.ok, true, 'an inference does not block recording the honest unknown');
    const orientation = runtime.orientation(info.id);
    assert.ok(orientation.indexOf('What is 12 Birch?') < orientation.indexOf('## Facts'), 'the unknown heads the orientation');
  });
});

describe('F2: the load-bearing question gets asked instead of assumed', () => {
  it('recommending an "untried" channel is refused while the listing history is unknown', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { opts } = await openCase(runtime, 'Lakeside lot');
    const online = await LedgerTool.execute({ action: 'assert', stmt: 'No online listing for the lot today', subject: 'lot', attr: 'online-listing', value: 'none', source: web }, opts);
    const history = await LedgerTool.execute({ action: 'unknown', stmt: 'Has the lot been listed before, and how?', subject: 'lot', attr: 'listing-history', changes: 'Which channels are actually untried', answerable: 'owner', how: 'Ask the owner', loadBearing: true }, opts);

    const refused = await RecommendTool.execute({ claims: [{ text: 'List it online; that channel has never been tried', factIds: [online.fact.id, history.fact.id] }] }, opts);
    assert.strictEqual(refused.ok, false);
    assert.match(JSON.stringify(refused.failures), new RegExp(history.fact.id));

    const answer = await LedgerTool.execute({ action: 'assert', provenance: 'user', stmt: 'Three agents listed it on the MLS over three years; one low offer', subject: 'lot', attr: 'listing-history', value: 'mls-3-agents-3-years', supersedes: history.fact.id }, opts);
    const accepted = await RecommendTool.execute({ claims: [{ text: 'Do not pay for a fourth MLS listing', factIds: [answer.fact.id] }] }, opts);
    assert.strictEqual(accepted.ok, true);
  });

  it('the model cannot supply the owner\'s reasons, so gating and recommendations stay closed', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const { opts } = await openCase(runtime, 'Lakeside lot', { active: false });
    const why = await BriefTool.execute({ action: 'update', field: 'why', value: 'Probably wants to maximise price', provenance: 'model' }, opts);
    assert.strictEqual(why.ok, false);
    const gate = await BriefTool.execute({ action: 'completeGating' }, opts);
    assert.strictEqual(gate.ok, false);
    assert.match(gate.error, /why/);
    const f = await LedgerTool.execute({ action: 'assert', stmt: 'Six lots ask 36k–60k per acre', subject: 'market', attr: 'asks', source: web }, opts);
    const rec = await RecommendTool.execute({ claims: [{ text: 'List at 35k per acre', factIds: [f.fact.id] }] }, opts);
    assert.strictEqual(rec.ok, false);
  });
});

describe('F5: existing state is checked before claiming something is missing', () => {
  it('asking for a document another case already holds surfaces that case', async () => {
    const runtime = new CaseRuntime({ root: tmp() });
    const inventory = await runtime.createCase({ title: 'Household inventory' });
    runtime.ledger(inventory.id).assert({ stmt: 'Payoff letter for the house loan, good through the 7th', subject: 'house-loan', attr: 'payoff', value: 120000, category: 'financial', source: { kind: 'document', ref: 'sources/payoff-letter.pdf' } });
    const { opts } = await openCase(runtime, 'House sale');
    const r = await LedgerTool.execute({ action: 'unknown', stmt: 'Need the house loan payoff letter', subject: 'house-loan', attr: 'payoff', changes: 'Net proceeds at every price', answerable: 'owner', how: 'Ask the owner to order a payoff letter' }, opts);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    assert.match(r.note, /Check them before asking the owner/);
  });
});

describe('F6: state survives compaction and restarts', () => {
  it('a fresh runtime sees the facts and decisions, and a correction flags the decision that cited the old fact', async () => {
    const root = tmp();
    const first = new CaseRuntime({ root });
    const { info, opts } = await openCase(first, 'Lakeside lot');
    const gis = await LedgerTool.execute({ action: 'assert', stmt: 'County GIS polygon computes 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, unit: 'acre', source: { kind: 'api', ref: 'gis-parcel-layer' } }, opts);
    await DecideTool.execute({ decision: 'Quote price per acre on the GIS acreage', factIds: [gis.fact.id] }, opts);

    const second = new CaseRuntime({ root });
    const opts2 = { caseContext: { runtime: second, caseId: info.id, turnId: 'turn-2', dir: info.dir } };
    await LedgerTool.execute({ action: 'assert', stmt: 'Recorded plat says 2.120 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acre', source: { kind: 'call', ref: 'sources/clerk-call.json' }, supersedes: gis.fact.id }, opts2);

    const orientation = second.orientation(info.id);
    assert.match(orientation, /Recorded plat says 2\.120 acres/);
    assert.match(orientation, /D-001[^\n]*now superseded/);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/cases-regressions.test.js`
Expected: PASS, `# fail 0`. (Tasks 1–8 already implement the behaviour; this file pins it. If any assertion fails, the defect is in the task that owns that behaviour — fix it there, not by loosening the test.)

- [ ] **Step 3: Commit**

```bash
git add tests/cases-regressions.test.js
git commit -m "test(cases): regression fixtures for guessed facts, unasked questions, missed state and restarts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Document and verify

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a Cases section to `CLAUDE.md`**

Append after the `## Logging` section:

````markdown
## Cases

`src/cases/` implements case repositories (spec:
`docs/superpowers/specs/2026-09-22-king-louie-cases-design.md`). A case is a
git repo under `<dataDir>/cases/` (override with `settings.cases.root` or
`KL_CASES_ROOT`), so **`git` must be on PATH** for anything that creates one.

- A chat with `caseId` runs every turn in case mode: `CaseRuntime.beginTurn`
  locks the case and builds the orientation, `endTurn` commits.
- The model writes the case only through the `Ledger`, `Brief`, `Decide` and
  `Recommend` tools. `facts.jsonl` is append-only; never rewrite it in code.
- Tests that create cases use a temp root. The e2e suite sets
  `KL_CASES_ROOT` before launching the app so the real profile is untouched.
````

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: `# fail 0`. The new files are `tests/cases-*.test.js`; every pre-existing test still passes, including `tests/electron-boundary.test.js` (which now also scans `src/cases/`) and `tests/ipc-contract.test.js`.

- [ ] **Step 3: Run the relevant e2e tests**

Run: `unset ELECTRON_RUN_AS_NODE && node --test --test-concurrency=1 tests/e2e/app-launch.test.js tests/e2e/chat-basics.test.js tests/e2e/cases.test.js`
Expected: `# fail 0`.

- [ ] **Step 4: Confirm nothing personal landed in the repo**

Run: `git diff --stat origin/main...HEAD` and read the changed file list for anything that is not code, tests or the CLAUDE.md section. Then read the new fixtures in `tests/cases-*.test.js` and confirm every name, place, number and URL is invented (`example.org`, `Lakeside lot`, `12 Birch`, `Household inventory`).
Expected: nothing specific to a real person or place.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document cases in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
