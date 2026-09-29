# History H1: The History Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every chat, message and attachment out of `chat-data.json` into `<dataDir>/history.sqlite` with one row per message and a dense per-chat `seq`, behind explicit store calls, so H2 can hang chunks and full-text rows off message rows.

**Architecture:** A new `HistoryStore` (`src/history/history-store.js`) owns one long-lived `node:sqlite` connection (WAL, `busy_timeout = 5000`, `foreign_keys = ON`) and the spec §4.1 tables for H1 (`schema_version`, `chats` plus `position`, `messages`, `attachments`, `meta`), created by ordered schema steps (`src/history/schema.js`). A pure row-mapping module (`rows.js`) turns today's in-memory chat and message shapes into columns plus `meta_json` and back, losslessly. A one-way migration (`migrate-json.js`) moves `chat-data.json`'s `chats` array in per-chat transactions after a backup. A small chat facade (`chat-facade.js`) keeps `appendMessageToChat`'s signature over `appendMessage` with incremental `llmTotals`. `createCore` opens the store, runs the migration, reports a store that will not open instead of falling back to JSON, and closes it on shutdown; `getChats`/`setChats` are removed and every call site uses explicit store calls. The renderer keeps only the active chat's messages in memory.

**Tech Stack:** Node 24 built-in `node:sqlite` (`DatabaseSync`), `node:test`, Electron renderer (plain DOM), Playwright `_electron` for e2e.

**Spec:** `docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, stage H1 (§11.2). Sections in force: §3.1 (principles "Degrade, never fail silently" and "Host-agnostic"), §3.2 (`HistoryStore` rows for `open`, `close`, `listChats`, `getChat`, `createChat`, `updateChat`, `deleteChat`, `appendMessage`, `truncateFrom`, `getMessages` only), §4.1 (tables `schema_version`, `chats`, `messages`, `attachments` only), §4.2, §4.4 including both 2026-09-29 implementation notes, §11.1 (without "chunk and index" and without the embedding backfill), §13 (store and migration bullets), §15 (first two rows and "Migration of one chat fails"), §16 (`node:sqlite` and the ExperimentalWarning). Also `docs/adr/0001-history-messages-as-rows.md` and `CONTEXT.md` (terms: chat, history store, seq).

## Global Constraints

- Tests run with node's built-in runner: `node --test tests/<file>.test.js` per task; `npm test` (`node --test --test-timeout=120000 tests/*.test.js`) once, in the last task. Never `jest`. Look for `# fail 0` in the TAP summary.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` enforces it and walks `src/history/`.
- Log through `createLogger` from `src/logging.js` (`createLogger('history')` in `src/history/`), never bare `console.*` in `src/`.
- Open source: no personal names, machine names, domains or home paths in code, tests, fixtures or docs. Test chats use invented text only (`Lakeside lot`, `blue folder`, `example.com`).
- The store file is `<dataDir>/history.sqlite`, or `deps.history.dbPath` when given. One `DatabaseSync` per core for its whole life. `PRAGMA journal_mode = WAL` (never for `:memory:` or a read-only open), `PRAGMA busy_timeout = 5000`, `PRAGMA foreign_keys = ON`.
- `seq` is per chat, dense from 1, and only `truncateFrom` removes messages; `UNIQUE(chat_id, seq)`.
- `getChat(id, { messages: true })` returns today's message shape (`id, sender, text, timestamp` plus `images`, `documents`, `llm`, `toolName`, `parameters`, `result`, `runId`, and any other field) with `seq` added. A field without a column goes to `meta_json`, so a stored message reads back equal to what was written (plus `seq`).
- `chat-data.json` keeps `activeChatId`, `apiTokens`, `apiStatus`, `settings`, `toolApprovals`, `usage` and everything else. Only `chats` moves.
- The migration reads `chat-data.json` only. An existing `<dataDir>/chat-history.sqlite` (the 998ebbb blob store) is never opened, read, moved or deleted.
- Migration: backup `<dataDir>/chat-data.backup-<timestamp>.json` before any change; each chat in its own transaction; verify the message count; a failed chat is logged, stays in the JSON array and is reported to the UI as "N chats could not be migrated; see log"; migrated chats leave the array; the `meta` marker `migrated_from_json` is set only when the array is empty; the app never deletes a backup.
- A store that will not open: an error in the log and in the UI, `chat-data.json` untouched, no fallback to reading chats from JSON (spec §15). A failed `appendMessage` transaction throws and fails the turn.
- `appendMessageToChat(chatId, sender, text, metadata)` keeps its signature and returns the updated chat (with messages) or `null` for an unknown chat.
- No settings are added in H1. `src/context/conversation-compactor.js` is not touched.
- Shared names other H2/B0 plans rely on (do not rename): `SCHEMA_STEPS`, `applySchema`, `HistoryStore` (re-exported from `src/history/index.js`), its methods listed in Task 1, 3 and 4 Interfaces, `_insertMessage(db, chatId, message, opts) → { rowId, id, seq, stored }`, `migrateFromJson`, and `historyStore` / `getHistoryStore()` on the core context.

## Review Focus

1. A chat copied by desktop import shares its message ids with the source chat (`writeChat` copies `messages` as they are), and `messages.id` is a global primary key: the migration and a later import must not fail on the collision. Expected: the second copy's colliding messages get fresh ids, their content intact (Task 4 test; Task 5 test).
2. A chat object read back with derived fields (`messageCount`, `preview`, `lastMessageAt` from `listChats`, or `seq` on messages) is written back, as the renderer's rename result and desktop import's upsert do: those fields must not be persisted into `meta_json`. Expected: derived chat keys and message `seq` are dropped on write (Task 2 and Task 3 tests).
3. `activeChatId` in `chat-data.json` names a chat that no longer exists (deleted, or left in JSON by a failed migration): the app must still open a chat. Expected: `chat:load` falls back to the first chat, with its messages, and says so in `activeChatId` (Task 8 test).
4. A status or workflow message arrives for a chat whose messages the renderer has not loaded: it must not make that chat look loaded with only the new message. Expected: the local push is skipped; selecting the chat loads the full history through `chat:get` (Task 10 test).
5. The app is killed after a chat's migration transaction commits but before `chat-data.json` is rewritten: the next start must neither duplicate nor fail that chat. Expected: a chat already in `history.sqlite` with the same message count counts as migrated and leaves the JSON array (Task 5 test).

---

## File Structure

New, under `src/history/` (Electron-free):

| File | Responsibility |
|---|---|
| `schema.js` | `SCHEMA_STEPS` (v1: the H1 tables), `applySchema(db, steps?)`, `currentVersion(db)`, `latestVersion(steps?)`, `SchemaVersionError` |
| `rows.js` | Pure mapping: chat ↔ `chats` row, message ↔ `messages` row plus `attachments` rows; `DERIVED_CHAT_KEYS`, `InvalidMessageError` |
| `history-store.js` | `HistoryStore`: connection, pragmas, transactions (savepoints when nested), meta, chats, messages, attachments |
| `migrate-json.js` | `migrateFromJson`: backup, per-chat transactions, verification, resume, marker |
| `chat-facade.js` | `createChatFacade`: the core-context chat functions, `appendMessageToChat` with incremental `llmTotals`, `truncateChatFrom`; `chatLlmTotals`, `addLlmTotals` |
| `unavailable-store.js` | `createUnavailableHistoryStore(cause)`, `HistoryUnavailableError` (code `HISTORY_UNAVAILABLE`) |
| `sqlite-warning.js` | `suppressSqliteExperimentalWarning(proc?)` for the two hosts |
| `index.js` | Re-exports |

Also new: `src/migration/desktop-history.js` (desktop import reads a profile's `history.sqlite` through the safe reader), `tests/helpers/history-context.js`, `tests/helpers/close-history-stores.js`.

Deleted: `src/history/chat-history-store.js` (`JsonChatHistoryStore`), `src/history/sqlite-chat-history-store.js` (`SqliteChatHistoryStore`), `tests/history-store.test.js` (their tests).

Modified: `src/core/create-core.js`, `src/core/model-choices.js`, `src/ipc/chat-handlers.js`, `src/ipc/canvas-handlers.js`, `src/ipc/case-handlers.js`, `src/ipc/workflow-handlers.js`, `src/migration/desktop-import.js`, `src/migration/desktop-source.js`, `src/service/cli.js`, `main.js`, `bin/king-louie-service.js`, `renderer.js`, `styles.css`, `CLAUDE.md`.

New tests: `tests/history-schema.test.js`, `tests/history-rows.test.js`, `tests/history-store-chats.test.js`, `tests/history-store-messages.test.js`, `tests/history-migrate-json.test.js`, `tests/history-chat-facade.test.js`, `tests/history-core.test.js`, `tests/history-no-legacy-chat-helpers.test.js`, `tests/renderer-history-lazy.test.js`, `tests/desktop-source-history.test.js`, `tests/history-sqlite-warning.test.js`, `tests/e2e/history.test.js`.

Rewritten test contexts (mechanical, Tasks 7 to 9): `tests/chat-history-get.test.js`, `tests/canvas-handlers.test.js`, `tests/cases-chat.test.js`, `tests/cases-detour-hooks.test.js`, `tests/cases-detour-ipc.test.js`, `tests/cases-ipc.test.js`, `tests/playbooks-ipc.test.js`, `tests/helpers/chat-harness.js`, `tests/core-create.test.js`, `tests/chat-profiles.test.js`, `tests/desktop-bridge-dispatcher.test.js`, `tests/desktop-import.test.js`, `tests/model-choices.test.js`, `tests/models-core-profiles.test.js`, `tests/models-custom-roles.test.js`, `tests/models-king-louie.test.js`, `tests/service-cli-models.test.js`, and the core-building test files listed in Task 7 (cleanup only).

---

## Task 1: Schema steps and the store's connection

**Files:**
- Create: `src/history/schema.js`, `src/history/history-store.js`
- Modify: `src/history/index.js`
- Test: `tests/history-schema.test.js`

**Interfaces:**
- Consumes: `createLogger` from `src/logging.js`; `DatabaseSync` from `node:sqlite`.
- Produces:
  - `src/history/schema.js`: `SCHEMA_STEPS: Array<{ version: number, up(db) }>` (one entry, version 1), `applySchema(db, steps = SCHEMA_STEPS) → number` (runs every step whose version is above the stored one, in order, each in its own `BEGIN IMMEDIATE` transaction, and records the new version; returns the version now stored; throws `SchemaVersionError` with `code: 'HISTORY_SCHEMA_NEWER'` when the file is newer than `steps`), `currentVersion(db) → number` (0 for a file with no `schema_version` table), `latestVersion(steps = SCHEMA_STEPS) → number`, `SchemaVersionError`.
  - `src/history/history-store.js`: `class HistoryStore` with
    - `static open(dbPath, { readonly = false, now } = {}) → HistoryStore` (`':memory:'` allowed; creates the parent directory; a read-only open never writes and refuses a file whose schema is not exactly `latestVersion()`, with `code: 'HISTORY_SCHEMA_NEWER'` or `'HISTORY_SCHEMA_OLDER'`). Uses `new this(...)`, so a subclass's `open` builds the subclass.
    - `db` (the `DatabaseSync`), `dbPath`, `readonly`, `isOpen` (getter).
    - `close()` (idempotent).
    - `transaction(fn) → fn's result`: `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`; a nested call runs in a `SAVEPOINT`; `fn(db)` must be synchronous (a returned promise is rolled back and throws `TypeError`); throws `Error('The history store is closed.')` after `close()`.
    - `getMeta(key) → string|null`, `setMeta(key, value)`.
    - Private `_stmt(sql)` (prepared-statement cache) and `_now()` for later tasks.
  - `src/history/index.js`: adds `HistoryStore` to its exports (the old `JsonChatHistoryStore` and `SqliteChatHistoryStore` stay exported until Task 7).

- [ ] **Step 1: Write the failing tests**

Create `tests/history-schema.test.js`:

```js
// tests/history-schema.test.js
// The history store's schema steps and its connection (recall spec §4.1, H1).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { SCHEMA_STEPS, applySchema, currentVersion, latestVersion } = require('../src/history/schema');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'history.sqlite');
}
function open(p, options) {
  const store = HistoryStore.open(p, options);
  stores.push(store);
  return store;
}
const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];

describe('history schema steps', () => {
  it('creates the H1 tables and records version 1 once', () => {
    const db = new DatabaseSync(':memory:');
    assert.strictEqual(applySchema(db), 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepStrictEqual(tables, ['attachments', 'chats', 'messages', 'meta', 'schema_version']);
    assert.strictEqual(applySchema(db), 1, 'a second run changes nothing');
    assert.deepStrictEqual(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version), [1]);
    assert.strictEqual(latestVersion(), 1);
    db.close();
  });

  it('gives chats a position and messages a unique (chat_id, seq)', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    const chatCols = db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    assert.ok(chatCols.includes('position'));
    assert.ok(chatCols.includes('history_scope'));
    db.exec("INSERT INTO chats (id, position, title) VALUES ('c1', 0, 'One')");
    db.exec("INSERT INTO messages (id, chat_id, seq, sender, timestamp) VALUES ('m1', 'c1', 1, 'user', 't')");
    assert.throws(() => db.exec("INSERT INTO messages (id, chat_id, seq, sender, timestamp) VALUES ('m2', 'c1', 1, 'user', 't')"), /UNIQUE/);
    db.close();
  });

  it('runs only the pending steps, in order', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    const ran = [];
    const steps = [...SCHEMA_STEPS, { version: 2, up(d) { ran.push(2); d.exec('CREATE TABLE extra (x TEXT)'); } }];
    assert.strictEqual(applySchema(db, steps), 2);
    assert.strictEqual(applySchema(db, steps), 2);
    assert.deepStrictEqual(ran, [2]);
    assert.strictEqual(currentVersion(db), 2);
    db.close();
  });

  it('rolls a failing step back and keeps the stored version', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db);
    const steps = [...SCHEMA_STEPS, { version: 2, up(d) { d.exec('CREATE TABLE half (x TEXT)'); throw new Error('step failed'); } }];
    assert.throws(() => applySchema(db, steps), /step failed/);
    assert.strictEqual(currentVersion(db), 1);
    assert.strictEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
    db.close();
  });

  it('refuses a file from a newer King Louie and leaves it as it was', () => {
    const p = tempDbPath();
    open(p).close();
    const raw = new DatabaseSync(p);
    raw.exec('UPDATE schema_version SET version = 99');
    raw.close();
    assert.throws(() => HistoryStore.open(p), (err) => err.code === 'HISTORY_SCHEMA_NEWER');
    const check = new DatabaseSync(p);
    assert.strictEqual(check.prepare('SELECT version FROM schema_version').get().version, 99);
    check.close();
  });
});

describe('HistoryStore connection', () => {
  it('opens a file store in WAL mode with a 5 s busy timeout and foreign keys on, creating its folder', () => {
    const p = tempDbPath();
    const store = open(p);
    assert.ok(fs.existsSync(p));
    assert.strictEqual(pragma(store.db, 'journal_mode'), 'wal');
    assert.strictEqual(pragma(store.db, 'busy_timeout'), 5000);
    assert.strictEqual(pragma(store.db, 'foreign_keys'), 1);
    assert.strictEqual(store.isOpen, true);
  });

  it('opens :memory: without WAL', () => {
    const store = open(':memory:');
    assert.notStrictEqual(pragma(store.db, 'journal_mode'), 'wal');
    assert.strictEqual(pragma(store.db, 'foreign_keys'), 1);
  });

  it('keeps meta values and overwrites them', () => {
    const store = open(':memory:');
    assert.strictEqual(store.getMeta('migrated_from_json'), null);
    store.setMeta('migrated_from_json', '2026-09-29T12:00:00.000Z');
    store.setMeta('migrated_from_json', '2026-09-30T12:00:00.000Z');
    assert.strictEqual(store.getMeta('migrated_from_json'), '2026-09-30T12:00:00.000Z');
  });

  it('commits, rolls back, and nests transactions as savepoints', () => {
    const store = open(':memory:');
    assert.strictEqual(store.transaction((db) => { assert.strictEqual(db, store.db); store.setMeta('a', '1'); return 42; }), 42);
    assert.throws(() => store.transaction(() => { store.setMeta('b', '2'); throw new Error('boom'); }), /boom/);
    assert.strictEqual(store.getMeta('a'), '1');
    assert.strictEqual(store.getMeta('b'), null);
    store.transaction(() => {
      store.setMeta('outer', 'kept');
      assert.throws(() => store.transaction(() => { store.setMeta('inner', 'dropped'); throw new Error('inner'); }), /inner/);
    });
    assert.strictEqual(store.getMeta('outer'), 'kept');
    assert.strictEqual(store.getMeta('inner'), null);
  });

  it('refuses an async transaction function and rolls its writes back', () => {
    const store = open(':memory:');
    assert.throws(() => store.transaction(() => { store.setMeta('x', '1'); return Promise.resolve(); }), TypeError);
    assert.strictEqual(store.getMeta('x'), null);
  });

  it('closes once and refuses work afterwards', () => {
    const store = open(':memory:');
    store.close();
    store.close();
    assert.strictEqual(store.isOpen, false);
    assert.throws(() => store.transaction(() => {}), /closed/);
  });

  it('opens read-only: reads, never writes', () => {
    const p = tempDbPath();
    const writer = open(p);
    writer.setMeta('k', 'v');
    writer.close();
    const reader = open(p, { readonly: true });
    assert.strictEqual(reader.readonly, true);
    assert.strictEqual(reader.getMeta('k'), 'v');
    assert.throws(() => reader.setMeta('k', 'w'), /readonly|read-only/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-schema.test.js`
Expected: FAIL with `Cannot find module '../src/history/schema'`.

- [ ] **Step 3: Write `src/history/schema.js`**

```js
// src/history/schema.js
// The history store's schema as ordered steps (recall spec 2026-09-25 §4.1).
// Each step runs once, in its own transaction, and bumps schema_version.
// Later stages append { version: N, up(db) }; never edit a released step.
// Stage H1 creates only the tables it uses; chunks, FTS, embeddings, links,
// imports and calibration arrive as later steps.

const SCHEMA_STEPS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT,
          agent_mode INTEGER,
          sandbox_mode INTEGER,
          case_id TEXT,
          working_directory TEXT,
          source TEXT,
          history_scope TEXT NOT NULL DEFAULT 'chat',
          meta_json TEXT
        );
        CREATE INDEX chats_position ON chats(position);

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          sender TEXT NOT NULL,
          text TEXT,
          timestamp TEXT NOT NULL,
          tool_name TEXT,
          params_json TEXT,
          result_json TEXT,
          run_id TEXT,
          llm_json TEXT,
          context_json TEXT,
          meta_json TEXT,
          UNIQUE (chat_id, seq)
        );

        -- idx keeps an attachment's place in its message's images/documents
        -- list; meta_json keeps any field without a column (lossless).
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          idx INTEGER NOT NULL,
          name TEXT,
          mime TEXT,
          bytes BLOB,
          text TEXT,
          meta_json TEXT
        );
        CREATE INDEX attachments_message ON attachments(message_id, kind, idx);

        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
  }
];

class SchemaVersionError extends Error {
  constructor(found, latest, code = 'HISTORY_SCHEMA_NEWER') {
    super(code === 'HISTORY_SCHEMA_NEWER'
      ? `history.sqlite has schema version ${found}, newer than this King Louie understands (${latest}). Update King Louie; the file was not changed.`
      : `history.sqlite has schema version ${found}; this King Louie needs ${latest}. Open it once with King Louie to upgrade it.`);
    this.name = 'SchemaVersionError';
    this.code = code;
    this.found = found;
    this.latest = latest;
  }
}

const latestVersion = (steps = SCHEMA_STEPS) => steps[steps.length - 1].version;

function currentVersion(db) {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  return Number(row?.version) || 0;
}

function applySchema(db, steps = SCHEMA_STEPS) {
  const latest = latestVersion(steps);
  const found = currentVersion(db);
  if (found > latest) throw new SchemaVersionError(found, latest);
  for (const step of steps) {
    if (step.version <= found) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      step.up(db);
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(step.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return Math.max(found, latest);
}

module.exports = { SCHEMA_STEPS, applySchema, currentVersion, latestVersion, SchemaVersionError };
```

- [ ] **Step 4: Write `src/history/history-store.js` (connection, transactions, meta)**

```js
// src/history/history-store.js
// The history store (recall spec 2026-09-25 §3, §4): the system of record for
// chats, their messages (one row each, dense per-chat seq) and attachments,
// in one SQLite file per data directory. One connection for the store's
// life. Electron-free.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema, currentVersion, latestVersion, SchemaVersionError } = require('./schema');
const { createLogger } = require('../logging');

const log = createLogger('history');
const BUSY_TIMEOUT_MS = 5000;

class HistoryStore {
  static open(dbPath, { readonly = false, now } = {}) {
    if (!dbPath || typeof dbPath !== 'string') throw new TypeError('HistoryStore.open needs a file path or ":memory:".');
    const memory = dbPath === ':memory:';
    if (!memory && !readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath, readonly ? { readOnly: true } : {});
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA foreign_keys = ON');
      if (readonly) {
        const found = currentVersion(db);
        const latest = latestVersion();
        if (found > latest) throw new SchemaVersionError(found, latest);
        if (found < latest) throw new SchemaVersionError(found, latest, 'HISTORY_SCHEMA_OLDER');
      } else {
        if (!memory) db.exec('PRAGMA journal_mode = WAL');
        applySchema(db);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new this(db, { dbPath, readonly, now });
  }

  constructor(db, { dbPath = null, readonly = false, now } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.readonly = readonly;
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._depth = 0;
    this._closed = false;
    this._statements = new Map();
  }

  get isOpen() {
    return !this._closed;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._statements.clear();
    this.db.close();
  }

  _stmt(sql) {
    let statement = this._statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this._statements.set(sql, statement);
    }
    return statement;
  }

  // BEGIN IMMEDIATE takes the write lock up front, so a reader (H2's embed
  // worker) never upgrades into a busy error halfway. A nested call is a
  // savepoint: an inner failure undoes only the inner work.
  transaction(fn) {
    if (this._closed) throw new Error('The history store is closed.');
    const nested = this._depth > 0;
    const savepoint = `kl_sp_${this._depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this._depth += 1;
    try {
      const result = fn(this.db);
      if (result && typeof result.then === 'function') {
        throw new TypeError('HistoryStore.transaction(fn) takes a synchronous function.');
      }
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } else {
          this.db.exec('ROLLBACK');
        }
      } catch (rollbackErr) {
        log.warn(`Rolling back a history transaction failed: ${rollbackErr.message}`);
      }
      throw err;
    } finally {
      this._depth -= 1;
    }
  }

  getMeta(key) {
    const row = this._stmt('SELECT value FROM meta WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this._stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value));
  }
}

module.exports = { HistoryStore };
```

- [ ] **Step 5: Export it from `src/history/index.js`**

```js
const { HistoryStore } = require('./history-store');
const { JsonChatHistoryStore } = require('./chat-history-store');
const { SqliteChatHistoryStore } = require('./sqlite-chat-history-store');

module.exports = {
  HistoryStore,
  JsonChatHistoryStore,
  SqliteChatHistoryStore
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/history-schema.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/history/schema.js src/history/history-store.js src/history/index.js tests/history-schema.test.js
git commit -m "feat(history): schema steps and the history store's connection (H1)"
```

---

## Task 2: Row mapping between chats, messages and columns

**Files:**
- Create: `src/history/rows.js`
- Test: `tests/history-rows.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure functions).
- Produces (`src/history/rows.js`):
  - `DERIVED_CHAT_KEYS = ['messageCount', 'userMessageCount', 'assistantMessageCount', 'preview', 'lastMessageText', 'lastMessageAt']` (computed on read, never stored).
  - `InvalidMessageError` (`code: 'HISTORY_INVALID_MESSAGE'`).
  - `chatToRow(chat) → { title, created_at, updated_at, agent_mode, sandbox_mode, case_id, working_directory, source, meta_json }` (drops `id`, `messages` and `DERIVED_CHAT_KEYS`; a value of the wrong type for its column goes to `meta_json`).
  - `rowToChat(row) → chat` (no `messages`; ignores extra columns such as `message_count`).
  - `messageToRow(message, { fallbackTimestamp }) → { row: { sender, text, timestamp, tool_name, params_json, result_json, run_id, llm_json, context_json, meta_json }, attachments: [{ kind: 'image'|'document', idx, name, mime, bytes: Buffer|null, text, meta_json }] }` (drops `id` and `seq`; throws `InvalidMessageError` for a non-object or a missing sender).
  - `rowToMessage(row, attachmentRows = []) → message` (`row` has `id` and `seq`; `bytes` may be a `Buffer` or a `Uint8Array`).
  - Field-to-column rules, for every later task: chat `title`, `createdAt`, `updatedAt`, `caseId`, `workingDirectory`, `source` go to text columns when they are strings; `agentMode`, `sandboxMode` to 0/1 when they are booleans; everything else (`llmTotals`, `disabledMcpServers`, `canvasState`, `profileId`, `mainOverride`, `origin`, `historyScope`, a `null` value, …) to `meta_json`. Message `text`, `toolName`, `runId`, `timestamp` to text columns when strings; `parameters`, `result`, `llm`, `context` to their `*_json` columns whenever defined (`null` included); a non-empty `images`/`documents` list of plain objects to `attachments`; everything else to `meta_json`. An attachment's `name`, `mimeType`, `textContent` go to `name`, `mime`, `text` when strings, its `base64` to `bytes` only when it is non-empty canonical base64; everything else (a data URL, `sizeBytes`, `previewUrl`, `base64Omitted`) to its `meta_json`. A missing message `timestamp` is filled with `fallbackTimestamp`; a missing chat `title` reads back as `''`. Those two are the only fields that do not round-trip as absent.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-rows.test.js`:

```js
// tests/history-rows.test.js
// Chats and messages map to columns plus meta_json and back without loss
// (recall spec §4.1, §4.2).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  DERIVED_CHAT_KEYS, InvalidMessageError, chatToRow, rowToChat, messageToRow, rowToMessage
} = require('../src/history/rows');

// What SQLite hands back: BLOBs as Uint8Array, no extra fields.
function roundTripMessage(message, seq = 1) {
  const { row, attachments } = messageToRow(message, { fallbackTimestamp: '2026-09-29T00:00:00.000Z' });
  const stored = attachments.map((a) => ({ ...a, bytes: a.bytes ? new Uint8Array(a.bytes) : null }));
  return rowToMessage({ ...row, id: message.id, seq }, stored);
}
const PNG_B64 = Buffer.from('invented image bytes').toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.4 invented').toString('base64');

describe('message rows', () => {
  it('round-trips a user message with images and documents, adding seq', () => {
    const message = {
      id: 'm1', sender: 'user', text: 'see the Lakeside lot plan', timestamp: '2026-09-29T10:00:00.000Z',
      images: [{ base64: PNG_B64, mimeType: 'image/png', name: 'lot.png' }],
      documents: [
        { base64: PDF_B64, mimeType: 'application/pdf', name: 'offer.pdf', sizeBytes: 17 },
        { base64: PDF_B64, mimeType: 'text/markdown', name: 'notes.md', textContent: '# notes', sizeBytes: 17 }
      ]
    };
    assert.deepStrictEqual(roundTripMessage(message, 7), { ...message, seq: 7 });
  });

  it('round-trips tool calls, results, llm and context through their JSON columns', () => {
    const toolUse = { id: 'm2', sender: 'toolUse', text: '', timestamp: 't', toolName: 'Bash', parameters: { command: 'ls -la' }, runId: 'run-1' };
    const objResult = { id: 'm3', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Bash', result: { ok: true, output: 'a\nb' }, runId: 'run-1' };
    const strResult = { id: 'm4', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Read', result: 'plain text' };
    const nullResult = { id: 'm5', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Read', result: null };
    const assistant = { id: 'm6', sender: 'assistant', text: 'done', timestamp: 't', llm: { totals: { inputTokens: 10, costUsd: 0.001 } }, context: { tail: { fromSeq: 1, toSeq: 5 } } };
    for (const m of [toolUse, objResult, strResult, nullResult, assistant]) {
      assert.deepStrictEqual(roundTripMessage(m), { ...m, seq: 1 });
    }
  });

  it('keeps fields without a column in meta_json', () => {
    const message = { id: 'm7', sender: 'user', text: 'hi', timestamp: 't', channel: 'telegram', stopped: true, workflowScaffolding: true, meta: { compaction: true } };
    const { row } = messageToRow(message);
    assert.deepStrictEqual(JSON.parse(row.meta_json), { channel: 'telegram', stopped: true, workflowScaffolding: true, meta: { compaction: true } });
    assert.deepStrictEqual(roundTripMessage(message), { ...message, seq: 1 });
  });

  it('tells an absent text from an empty one and from null', () => {
    assert.strictEqual('text' in roundTripMessage({ id: 'a', sender: 'status', timestamp: 't' }), false);
    assert.strictEqual(roundTripMessage({ id: 'b', sender: 'status', text: '', timestamp: 't' }).text, '');
    assert.strictEqual(roundTripMessage({ id: 'c', sender: 'status', text: null, timestamp: 't' }).text, null);
  });

  it('keeps a non-canonical base64 (a data URL) verbatim instead of decoding it', () => {
    const message = { id: 'm8', sender: 'user', text: '', timestamp: 't', images: [{ base64: `data:image/png;base64,${PNG_B64}`, mimeType: 'image/png', previewUrl: 'data:x' }] };
    const { attachments } = messageToRow(message);
    assert.strictEqual(attachments[0].bytes, null);
    assert.deepStrictEqual(roundTripMessage(message), { ...message, seq: 1 });
  });

  it('keeps an empty attachment list and a list that is not objects as they were', () => {
    const empty = { id: 'm9', sender: 'user', text: 'x', timestamp: 't', images: [] };
    const odd = { id: 'm10', sender: 'user', text: 'x', timestamp: 't', documents: ['not-an-object'] };
    assert.deepStrictEqual(roundTripMessage(empty), { ...empty, seq: 1 });
    assert.deepStrictEqual(roundTripMessage(odd), { ...odd, seq: 1 });
  });

  it('drops an incoming seq and fills a missing timestamp', () => {
    const { row } = messageToRow({ id: 'm11', sender: 'user', text: 'x', seq: 99 }, { fallbackTimestamp: '2026-09-01T00:00:00.000Z' });
    assert.strictEqual(row.timestamp, '2026-09-01T00:00:00.000Z');
    assert.strictEqual(row.meta_json, null, 'seq is the store\'s to assign');
  });

  it('refuses a message that is not an object or has no sender', () => {
    assert.throws(() => messageToRow('text'), InvalidMessageError);
    assert.throws(() => messageToRow({ text: 'orphan' }), (err) => err.code === 'HISTORY_INVALID_MESSAGE');
    assert.throws(() => messageToRow({ sender: '  ', text: 'blank' }), InvalidMessageError);
  });
});

describe('chat rows', () => {
  it('round-trips every chat field, columns and meta_json alike', () => {
    const chat = {
      id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      agentMode: false, sandboxMode: true, workingDirectory: '/work/example', caseId: null,
      disabledMcpServers: ['files'], llmTotals: { inputTokens: 5, outputTokens: 6, totalTokens: 11, costUsd: 0.01 },
      canvasState: null, profileId: 'p-a', mainOverride: { provider: 'openai', model: 'gpt-5.4', effort: null }, origin: 'telegram'
    };
    const row = chatToRow(chat);
    assert.strictEqual(row.agent_mode, 0);
    assert.strictEqual(row.sandbox_mode, 1);
    assert.strictEqual(row.case_id, null);
    assert.deepStrictEqual(rowToChat({ ...row, id: 'c1' }), chat);
  });

  it('never stores derived listing fields or messages', () => {
    const listed = { id: 'c2', title: 'Two', messages: [{ id: 'm', sender: 'user' }] };
    for (const key of DERIVED_CHAT_KEYS) listed[key] = key === 'lastMessageAt' ? '2026-09-29T00:00:00.000Z' : 3;
    const row = chatToRow(listed);
    assert.strictEqual(row.meta_json, null);
    assert.deepStrictEqual(rowToChat({ ...row, id: 'c2' }), { id: 'c2', title: 'Two' });
  });

  it('keeps a value of the wrong type for its column in meta_json', () => {
    const chat = { id: 'c3', title: 'Three', agentMode: 'yes', caseId: 42 };
    assert.deepStrictEqual(rowToChat({ ...chatToRow(chat), id: 'c3' }), chat);
  });

  it('reads a chat without a title back with an empty one', () => {
    assert.deepStrictEqual(rowToChat({ ...chatToRow({ id: 'c4' }), id: 'c4' }), { id: 'c4', title: '' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-rows.test.js`
Expected: FAIL with `Cannot find module '../src/history/rows'`.

- [ ] **Step 3: Write `src/history/rows.js`**

```js
// src/history/rows.js
// Today's in-memory chat and message shapes ↔ the history store's columns
// (recall spec §4.1, §4.2). A field with a column goes there when its type
// fits; every other field goes to meta_json, so what is written reads back
// equal (a message gains seq). Pure functions: no database here.

const DERIVED_CHAT_KEYS = Object.freeze([
  'messageCount', 'userMessageCount', 'assistantMessageCount', 'preview', 'lastMessageText', 'lastMessageAt'
]);
const CHAT_TEXT_COLUMNS = Object.freeze({
  title: 'title', createdAt: 'created_at', updatedAt: 'updated_at', caseId: 'case_id',
  workingDirectory: 'working_directory', source: 'source'
});
const CHAT_FLAG_COLUMNS = Object.freeze({ agentMode: 'agent_mode', sandboxMode: 'sandbox_mode' });
const MESSAGE_TEXT_COLUMNS = Object.freeze({ text: 'text', toolName: 'tool_name', runId: 'run_id' });
const MESSAGE_JSON_COLUMNS = Object.freeze({ parameters: 'params_json', result: 'result_json', llm: 'llm_json', context: 'context_json' });
const ATTACHMENT_KINDS = Object.freeze({ images: 'image', documents: 'document' });
const ATTACHMENT_KEYS = Object.freeze({ image: 'images', document: 'documents' });

class InvalidMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMessageError';
    this.code = 'HISTORY_INVALID_MESSAGE';
  }
}

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const isCanonicalBase64 = (v) => isString(v) && v.length > 0 && Buffer.from(v, 'base64').toString('base64') === v;
const present = (v) => v !== null && v !== undefined;

function metaJson(meta) {
  const json = JSON.stringify(meta);
  return json === '{}' ? null : json;
}

function chatToRow(chat = {}) {
  const row = {
    title: '', created_at: null, updated_at: null, agent_mode: null, sandbox_mode: null,
    case_id: null, working_directory: null, source: null, meta_json: null
  };
  const meta = {};
  for (const [key, value] of Object.entries(chat || {})) {
    if (value === undefined || key === 'id' || key === 'messages' || DERIVED_CHAT_KEYS.includes(key)) continue;
    const textColumn = CHAT_TEXT_COLUMNS[key];
    if (textColumn && isString(value)) { row[textColumn] = value; continue; }
    const flagColumn = CHAT_FLAG_COLUMNS[key];
    if (flagColumn && typeof value === 'boolean') { row[flagColumn] = value ? 1 : 0; continue; }
    meta[key] = value;
  }
  row.meta_json = metaJson(meta);
  return row;
}

function rowToChat(row) {
  const chat = { id: row.id, title: row.title };
  for (const [key, column] of Object.entries(CHAT_TEXT_COLUMNS)) {
    if (key !== 'title' && present(row[column])) chat[key] = row[column];
  }
  for (const [key, column] of Object.entries(CHAT_FLAG_COLUMNS)) {
    if (present(row[column])) chat[key] = Number(row[column]) === 1;
  }
  if (row.meta_json) Object.assign(chat, JSON.parse(row.meta_json));
  return chat;
}

function attachmentToRow(kind, idx, item) {
  const row = { kind, idx, name: null, mime: null, bytes: null, text: null, meta_json: null };
  const meta = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    if (key === 'name' && isString(value)) row.name = value;
    else if (key === 'mimeType' && isString(value)) row.mime = value;
    else if (key === 'textContent' && isString(value)) row.text = value;
    else if (key === 'base64' && isCanonicalBase64(value)) row.bytes = Buffer.from(value, 'base64');
    else meta[key] = value;
  }
  row.meta_json = metaJson(meta);
  return row;
}

function rowToAttachment(row) {
  const item = {};
  if (present(row.name)) item.name = row.name;
  if (present(row.mime)) item.mimeType = row.mime;
  if (present(row.text)) item.textContent = row.text;
  if (present(row.bytes)) item.base64 = Buffer.from(row.bytes).toString('base64');
  if (row.meta_json) Object.assign(item, JSON.parse(row.meta_json));
  return item;
}

function messageToRow(message, { fallbackTimestamp } = {}) {
  if (!isPlainObject(message)) throw new InvalidMessageError('A message must be an object.');
  if (!isString(message.sender) || !message.sender.trim()) throw new InvalidMessageError('A message needs a sender.');
  const row = {
    sender: message.sender, text: null, timestamp: null, tool_name: null, params_json: null,
    result_json: null, run_id: null, llm_json: null, context_json: null, meta_json: null
  };
  const meta = {};
  const attachments = [];
  for (const [key, value] of Object.entries(message)) {
    if (value === undefined || key === 'id' || key === 'seq' || key === 'sender') continue;
    if (key === 'timestamp') {
      if (isString(value)) row.timestamp = value;
      else meta.timestamp = value;
      continue;
    }
    const textColumn = MESSAGE_TEXT_COLUMNS[key];
    if (textColumn) {
      if (isString(value)) row[textColumn] = value;
      else meta[key] = value;
      continue;
    }
    const jsonColumn = MESSAGE_JSON_COLUMNS[key];
    if (jsonColumn) {
      const json = JSON.stringify(value);
      if (json !== undefined) row[jsonColumn] = json;
      continue;
    }
    const kind = ATTACHMENT_KINDS[key];
    if (kind && Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      value.forEach((item, idx) => attachments.push(attachmentToRow(kind, idx, item)));
      continue;
    }
    meta[key] = value;
  }
  if (row.timestamp === null) row.timestamp = fallbackTimestamp || new Date().toISOString();
  row.meta_json = metaJson(meta);
  return { row, attachments };
}

function rowToMessage(row, attachmentRows = []) {
  const message = { id: row.id, seq: Number(row.seq), sender: row.sender, timestamp: row.timestamp };
  for (const [key, column] of Object.entries(MESSAGE_TEXT_COLUMNS)) {
    if (present(row[column])) message[key] = row[column];
  }
  for (const [key, column] of Object.entries(MESSAGE_JSON_COLUMNS)) {
    if (present(row[column])) message[key] = JSON.parse(row[column]);
  }
  for (const attachment of attachmentRows) {
    const key = ATTACHMENT_KEYS[attachment.kind];
    if (!key) continue;
    if (!message[key]) message[key] = [];
    message[key].push(rowToAttachment(attachment));
  }
  if (row.meta_json) Object.assign(message, JSON.parse(row.meta_json));
  return message;
}

module.exports = {
  DERIVED_CHAT_KEYS,
  InvalidMessageError,
  chatToRow,
  rowToChat,
  messageToRow,
  rowToMessage
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/history-rows.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/rows.js tests/history-rows.test.js
git commit -m "feat(history): lossless mapping between chats, messages and store columns"
```

---

## Task 3: Chats in the store

**Files:**
- Modify: `src/history/history-store.js`
- Test: `tests/history-store-chats.test.js`

**Interfaces:**
- Consumes: Task 1's `HistoryStore` (`transaction`, `_stmt`, `_now`); Task 2's `chatToRow`, `rowToChat`, `messageToRow`, `rowToMessage`, `InvalidMessageError`.
- Produces (methods on `HistoryStore`; ids are trimmed strings, a blank id returns `null`):
  - `listChats({ messages = false } = {}) → Chat[]` ordered by `position`, each with `messageCount`, `userMessageCount`, `assistantMessageCount`, `preview` and `lastMessageText` (the last `user`/`assistant` message's text, else the last message's, cut to 500 characters, `''` when none) and `lastMessageAt` (that message's `timestamp`, else `null`); with `messages: true` each also has its `messages`.
  - `getChat(id, { messages = true } = {}) → Chat|null` (no derived fields; messages in `seq` order, each with `seq`).
  - `createChat(chat, { position = 'front' } = {}) → Chat` (with messages): `'front'` puts it first, `'back'` last; an existing chat with the same id is replaced and moved; its `messages` are inserted with `seq` 1..n; `null` for a chat without an id.
  - `replaceChat(id, chat) → Chat|null`: keeps the position, rewrites every field, replaces all messages (a chat without `messages` ends up with none, as today's facade does); `null` when the id is unknown.
  - `upsertChat(chat, options) → Chat|null`: `replaceChat` when the id exists, else `createChat(chat, options)`.
  - `updateChat(id, patch, { messages = true } = {}) → Chat|null`: merges `patch` into the chat; a `messages` array in the patch replaces all messages; returns the chat with or without messages; `null` when unknown.
  - `updateChatsWhere(predicate, patcher) → Chat[]`: in one transaction, calls `predicate(chat)` and `patcher(chat)` with each chat without messages, in position order, applies a returned object patch (a `messages` key in it is ignored) and returns the changed chats without messages.
  - `deleteChat(id) → Chat[]` (`listChats()` after the delete; messages and attachments go with it).
  - Private `_insertChatRow(id, chat, position)`, `_updateChatRow(id, chat)`, `_chatRow(id)`, `_insertMessages(chatId, messages, fallbackTimestamp)`, `_messagesFor(chatId, { fromSeq, toSeq, limit })`, `_insertMessage(db, chatId, message, { fallbackTimestamp }) → { rowId, id, seq, stored }`, `_freeMessageId(candidate)`. Task 4 builds `appendMessage` and `getMessages` on these.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-store-chats.test.js`:

```js
// tests/history-store-chats.test.js
// Chat CRUD, ordering and listing metadata on the history store (recall spec
// §4.4): the same semantics as the facade it replaces.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../src/history');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function memory() {
  const store = HistoryStore.open(':memory:');
  stores.push(store);
  return store;
}
const msg = (id, sender, text, timestamp = '2026-09-29T10:00:00.000Z', extra = {}) => ({ id, sender, text, timestamp, ...extra });
const withoutSeq = (messages) => messages.map(({ seq: _seq, ...m }) => m);
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('HistoryStore chats', () => {
  it('orders chats by creation position, front and back', () => {
    const store = memory();
    store.createChat({ id: 'b', title: 'B' });
    store.createChat({ id: 'a', title: 'A' }, { position: 'front' });
    store.createChat({ id: 'c', title: 'C' }, { position: 'back' });
    assert.deepStrictEqual(store.listChats().map((c) => c.id), ['a', 'b', 'c']);
  });

  it('lists metadata with counts, preview and lastMessageAt, and no messages unless asked', () => {
    const store = memory();
    store.createChat({
      id: 'c1', title: 'Lakeside lot',
      messages: [
        msg('m1', 'assistant', 'How can I help you?', '2026-09-29T10:00:00.000Z'),
        msg('m2', 'user', 'remember the blue folder', '2026-09-29T10:01:00.000Z'),
        msg('m3', 'assistant', 'Noted.', '2026-09-29T10:02:00.000Z'),
        msg('m4', 'toolUse', '', '2026-09-29T10:03:00.000Z', { toolName: 'Bash', parameters: { command: 'ls' } })
      ]
    });
    store.createChat({ id: 'c2', title: 'Empty' }, { position: 'back' });
    const [c1, c2] = store.listChats();
    assert.strictEqual(c1.messages, undefined);
    assert.strictEqual(c1.messageCount, 4);
    assert.strictEqual(c1.userMessageCount, 1);
    assert.strictEqual(c1.assistantMessageCount, 2);
    assert.strictEqual(c1.preview, 'Noted.');
    assert.strictEqual(c1.lastMessageText, 'Noted.');
    assert.strictEqual(c1.lastMessageAt, '2026-09-29T10:02:00.000Z');
    assert.deepStrictEqual({ n: c2.messageCount, p: c2.preview, at: c2.lastMessageAt }, { n: 0, p: '', at: null });
    const full = store.listChats({ messages: true });
    assert.deepStrictEqual(full[0].messages.map((m) => m.seq), [1, 2, 3, 4]);
    assert.deepStrictEqual(full[1].messages, []);
  });

  it('cuts a long preview to 500 characters', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'Paste', messages: [msg('m1', 'user', 'x'.repeat(5000))] });
    assert.strictEqual(store.listChats()[0].preview.length, 500);
  });

  it('gets one chat with its messages in seq order, or without them', () => {
    const store = memory();
    const messages = [msg('m1', 'user', 'one'), msg('m2', 'assistant', 'two')];
    store.createChat({ id: 'c1', title: 'One', agentMode: true, messages });
    const chat = store.getChat('c1');
    assert.deepStrictEqual(chat.messages.map((m) => m.seq), [1, 2]);
    assert.deepStrictEqual(withoutSeq(chat.messages), messages);
    assert.strictEqual(chat.agentMode, true);
    assert.strictEqual(chat.messageCount, undefined, 'getChat carries no derived fields');
    assert.strictEqual(store.getChat('c1', { messages: false }).messages, undefined);
    assert.strictEqual(store.getChat(' c1 ').id, 'c1');
    assert.strictEqual(store.getChat('missing'), null);
    assert.strictEqual(store.getChat(''), null);
  });

  it('round-trips attachments through their own rows', () => {
    const store = memory();
    const image = { base64: Buffer.from('invented png').toString('base64'), mimeType: 'image/png', name: 'lot.png' };
    const doc = { base64: Buffer.from('invented pdf').toString('base64'), mimeType: 'application/pdf', name: 'offer.pdf', sizeBytes: 12 };
    store.createChat({ id: 'c1', title: 'Files', messages: [msg('m1', 'user', 'see attached', 't', { images: [image], documents: [doc] })] });
    assert.strictEqual(count(store, 'attachments'), 2);
    const [message] = store.getChat('c1').messages;
    assert.deepStrictEqual(message.images, [image]);
    assert.deepStrictEqual(message.documents, [doc]);
  });

  it('createChat with an existing id replaces that chat and moves it', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    store.createChat({ id: 'b', title: 'B', messages: [msg('m1', 'user', 'old')] }, { position: 'back' });
    store.createChat({ id: 'b', title: 'B again', messages: [] }, { position: 'front' });
    assert.deepStrictEqual(store.listChats().map((c) => [c.id, c.title, c.messageCount]), [['b', 'B again', 0], ['a', 'A', 0]]);
    assert.strictEqual(store.createChat({ title: 'no id' }), null);
  });

  it('replaceChat keeps the position, forces the id and replaces every message', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    store.createChat({ id: 'b', title: 'B', profileId: 'p1', messages: [msg('m1', 'user', 'old')] }, { position: 'back' });
    const replaced = store.replaceChat('b', { id: 'ignored', title: 'Replaced', messages: [msg('m2', 'user', 'new'), msg('m3', 'assistant', 'ok')] });
    assert.strictEqual(replaced.id, 'b');
    assert.strictEqual(replaced.profileId, undefined, 'fields not in the new chat are gone');
    assert.deepStrictEqual(replaced.messages.map((m) => [m.id, m.seq]), [['m2', 1], ['m3', 2]]);
    assert.deepStrictEqual(store.listChats().map((c) => c.id), ['a', 'b']);
    assert.strictEqual(store.replaceChat('missing', { title: 'x' }), null);
  });

  it('upsertChat creates or replaces', () => {
    const store = memory();
    store.createChat({ id: 'a', title: 'A' });
    assert.strictEqual(store.upsertChat({ id: 'b', title: 'B' }, { position: 'back' }).id, 'b');
    assert.strictEqual(store.upsertChat({ id: 'a', title: 'A imported', messages: [msg('m1', 'user', 'hi')] }).title, 'A imported');
    assert.deepStrictEqual(store.listChats().map((c) => [c.id, c.messageCount]), [['a', 1], ['b', 0]]);
  });

  it('updateChat merges a patch, keeps null values, and can replace messages', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', caseId: 'case-1', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b')] });
    const patched = store.updateChat('c1', { title: 'Renamed', caseId: null, canvasState: { visible: true } });
    assert.strictEqual(patched.title, 'Renamed');
    assert.strictEqual(patched.caseId, null);
    assert.deepStrictEqual(patched.canvasState, { visible: true });
    assert.strictEqual(patched.messages.length, 2);
    assert.strictEqual(store.updateChat('c1', { title: 'Quiet' }, { messages: false }).messages, undefined);
    const tagged = store.updateChat('c1', { messages: [msg('m1', 'user', 'a', 't', { channel: 'telegram' })] });
    assert.deepStrictEqual(tagged.messages.map((m) => [m.id, m.seq, m.channel]), [['m1', 1, 'telegram']]);
    assert.strictEqual(store.updateChat('missing', { title: 'x' }), null);
  });

  it('writing back a listed chat or messages with seq stores no derived fields (review focus 2)', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'hi')] });
    const listed = store.listChats()[0];
    store.updateChat('c1', listed);
    const full = store.getChat('c1');
    store.replaceChat('c1', full);
    const row = store.db.prepare("SELECT meta_json FROM chats WHERE id = 'c1'").get();
    assert.strictEqual(row.meta_json, null);
    const messageRow = store.db.prepare("SELECT meta_json FROM messages WHERE id = 'm1'").get();
    assert.strictEqual(messageRow.meta_json, null);
    assert.deepStrictEqual(Object.keys(store.getChat('c1', { messages: false })).sort(), ['id', 'title']);
  });

  it('updateChatsWhere patches matching chats without messages and returns them', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', profileId: 'p-b', messages: [msg('m1', 'user', 'hi')] });
    store.createChat({ id: 'c2', title: 'Two', profileId: 'p-a' }, { position: 'back' });
    const seen = [];
    const changed = store.updateChatsWhere(
      (chat) => { seen.push(chat.messages); return chat.profileId === 'p-b'; },
      () => ({ profileId: null, updatedAt: '2026-09-29T12:00:00.000Z', messages: [] })
    );
    assert.deepStrictEqual(seen, [undefined, undefined]);
    assert.deepStrictEqual(changed.map((c) => [c.id, c.profileId, c.messages]), [['c1', null, undefined]]);
    assert.strictEqual(store.getChat('c1').messages.length, 1, 'a messages key in the patch is ignored');
    assert.deepStrictEqual(store.updateChatsWhere(() => true, () => null), []);
  });

  it('deleteChat removes its messages and attachments and returns the remaining metadata', () => {
    const store = memory();
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'x', 't', { images: [image] })] });
    store.createChat({ id: 'c2', title: 'Two' }, { position: 'back' });
    const remaining = store.deleteChat('c1');
    assert.deepStrictEqual(remaining.map((c) => c.id), ['c2']);
    assert.strictEqual(remaining[0].messages, undefined);
    assert.strictEqual(count(store, 'messages'), 0);
    assert.strictEqual(count(store, 'attachments'), 0);
  });

  it('refuses a chat whose messages are not a list or lack a sender, and writes nothing', () => {
    const store = memory();
    assert.throws(() => store.createChat({ id: 'bad', title: 'Bad', messages: 'nope' }), (err) => err.code === 'HISTORY_INVALID_MESSAGE');
    assert.throws(() => store.createChat({ id: 'bad', title: 'Bad', messages: [msg('m1', 'user', 'ok'), { text: 'no sender' }] }), /sender/);
    assert.strictEqual(store.getChat('bad'), null);
    assert.strictEqual(count(store, 'messages'), 0);
  });

  it('keeps chats across a reopen of the same file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-'));
    dirs.push(dir);
    const file = path.join(dir, 'history.sqlite');
    const first = HistoryStore.open(file);
    stores.push(first);
    first.createChat({ id: 'c1', title: 'Kept', messages: [msg('m1', 'user', 'hi')] });
    first.close();
    const second = HistoryStore.open(file);
    stores.push(second);
    assert.deepStrictEqual(withoutSeq(second.getChat('c1').messages), [msg('m1', 'user', 'hi')]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-store-chats.test.js`
Expected: FAIL with `store.createChat is not a function`.

- [ ] **Step 3: Add the chat methods to `src/history/history-store.js`**

Add to the requires at the top:

```js
const crypto = require('crypto');
const rows = require('./rows');
```

Add below `BUSY_TIMEOUT_MS`:

```js
const PREVIEW_CHARS = 500;
const normalizeId = (value) => String(value ?? '').trim();
const textOrNull = (value) => (typeof value === 'string' && value ? value : null);

const LIST_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender = 'user') AS user_count,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender = 'assistant') AS assistant_count,
    COALESCE(
      (SELECT MAX(seq) FROM messages m WHERE m.chat_id = c.id AND m.sender IN ('user', 'assistant')),
      (SELECT MAX(seq) FROM messages m WHERE m.chat_id = c.id)
    ) AS last_seq
  FROM chats c
  ORDER BY c.position, c.rowid`;
```

Add these methods to the class, after `setMeta`:

```js
  // ── chats ──────────────────────────────────────────────────────────────

  listChats({ messages = false } = {}) {
    return this._stmt(LIST_SQL).all().map((row) => {
      const last = row.last_seq
        ? this._stmt('SELECT substr(text, 1, ?) AS text, timestamp FROM messages WHERE chat_id = ? AND seq = ?')
          .get(PREVIEW_CHARS, row.id, row.last_seq)
        : null;
      const chat = {
        ...rows.rowToChat(row),
        messageCount: Number(row.message_count),
        userMessageCount: Number(row.user_count),
        assistantMessageCount: Number(row.assistant_count),
        preview: last?.text || '',
        lastMessageText: last?.text || '',
        lastMessageAt: last?.timestamp || null
      };
      return messages ? { ...chat, messages: this._messagesFor(row.id) } : chat;
    });
  }

  getChat(id, { messages = true } = {}) {
    const key = normalizeId(id);
    if (!key) return null;
    const row = this._chatRow(key);
    if (!row) return null;
    const chat = rows.rowToChat(row);
    return messages ? { ...chat, messages: this._messagesFor(key) } : chat;
  }

  createChat(chat, { position = 'front' } = {}) {
    const id = normalizeId(chat?.id);
    if (!id || typeof chat !== 'object') return null;
    return this.transaction(() => {
      this._stmt('DELETE FROM chats WHERE id = ?').run(id);
      this._insertChatRow(id, chat, this._nextPosition(position));
      this._insertMessages(id, chat.messages, textOrNull(chat.updatedAt) || textOrNull(chat.createdAt));
      return this.getChat(id);
    });
  }

  replaceChat(id, chat) {
    const key = normalizeId(id || chat?.id);
    if (!key || !chat || typeof chat !== 'object') return null;
    return this.transaction(() => {
      if (!this._chatRow(key)) return null;
      this._updateChatRow(key, chat);
      this._stmt('DELETE FROM messages WHERE chat_id = ?').run(key);
      this._insertMessages(key, chat.messages, textOrNull(chat.updatedAt) || textOrNull(chat.createdAt));
      return this.getChat(key);
    });
  }

  upsertChat(chat, options = {}) {
    const id = normalizeId(chat?.id);
    if (!id) return null;
    return this.transaction(() => (this._chatRow(id)
      ? this.replaceChat(id, chat)
      : this.createChat({ ...chat, id }, options)));
  }

  updateChat(id, patch = {}, { messages = true } = {}) {
    const key = normalizeId(id);
    if (!key) return null;
    return this.transaction(() => {
      const row = this._chatRow(key);
      if (!row) return null;
      const { messages: nextMessages, ...fields } = patch || {};
      const merged = { ...rows.rowToChat(row), ...fields };
      this._updateChatRow(key, merged);
      if (Array.isArray(nextMessages)) {
        this._stmt('DELETE FROM messages WHERE chat_id = ?').run(key);
        this._insertMessages(key, nextMessages, textOrNull(merged.updatedAt) || textOrNull(merged.createdAt));
      }
      return this.getChat(key, { messages });
    });
  }

  updateChatsWhere(predicate, patcher) {
    if (typeof predicate !== 'function' || typeof patcher !== 'function') return [];
    return this.transaction(() => {
      const changed = [];
      for (const row of this._stmt('SELECT * FROM chats ORDER BY position, rowid').all()) {
        const chat = rows.rowToChat(row);
        if (!predicate(chat)) continue;
        const patch = patcher(chat);
        if (!patch || typeof patch !== 'object') continue;
        const { messages: _ignored, ...fields } = patch;
        this._updateChatRow(chat.id, { ...chat, ...fields });
        changed.push(this.getChat(chat.id, { messages: false }));
      }
      return changed;
    });
  }

  deleteChat(id) {
    const key = normalizeId(id);
    if (key) this._stmt('DELETE FROM chats WHERE id = ?').run(key);
    return this.listChats();
  }

  // ── internals shared with messages (Task 4) and later stages ────────────

  _chatRow(id) {
    return this._stmt('SELECT * FROM chats WHERE id = ?').get(id);
  }

  _nextPosition(position) {
    const { lo, hi } = this._stmt('SELECT MIN(position) AS lo, MAX(position) AS hi FROM chats').get();
    if (position === 'back') return (hi === null ? -1 : Number(hi)) + 1;
    return (lo === null ? 1 : Number(lo)) - 1;
  }

  _insertChatRow(id, chat, position) {
    const r = rows.chatToRow(chat);
    this._stmt(`INSERT INTO chats (id, position, title, created_at, updated_at, agent_mode, sandbox_mode,
        case_id, working_directory, source, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, position, r.title, r.created_at, r.updated_at, r.agent_mode, r.sandbox_mode,
        r.case_id, r.working_directory, r.source, r.meta_json);
  }

  _updateChatRow(id, chat) {
    const r = rows.chatToRow(chat);
    this._stmt(`UPDATE chats SET title = ?, created_at = ?, updated_at = ?, agent_mode = ?, sandbox_mode = ?,
        case_id = ?, working_directory = ?, source = ?, meta_json = ?
      WHERE id = ?`)
      .run(r.title, r.created_at, r.updated_at, r.agent_mode, r.sandbox_mode,
        r.case_id, r.working_directory, r.source, r.meta_json, id);
  }

  _insertMessages(chatId, messages, fallbackTimestamp) {
    if (messages === undefined || messages === null) return;
    if (!Array.isArray(messages)) throw new rows.InvalidMessageError('A chat\'s messages must be a list.');
    for (const message of messages) this._insertMessage(this.db, chatId, message, { fallbackTimestamp });
  }

  // A message id is a global primary key, but a chat copied by desktop
  // import carries its source's message ids: a taken (or missing) id gets a
  // fresh one, the content is kept.
  _freeMessageId(candidate) {
    const id = typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : normalizeId(typeof candidate === 'string' ? candidate : '');
    if (id && !this._stmt('SELECT 1 AS taken FROM messages WHERE id = ?').get(id)) return id;
    const fresh = crypto.randomUUID();
    if (id) log.debug(`Message id ${id} is already stored; this copy is stored as ${fresh}.`);
    return fresh;
  }

  // The one place a message row is written. Always called inside a
  // transaction; H2 adds its chunk and full-text rows here, so they commit
  // or roll back with the message. Returns the stored shape (with seq).
  _insertMessage(db, chatId, message, { fallbackTimestamp } = {}) {
    const { row, attachments } = rows.messageToRow(message, { fallbackTimestamp: fallbackTimestamp || this._now() });
    const seq = Number(this._stmt('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE chat_id = ?').get(chatId).next);
    const id = this._freeMessageId(message.id);
    const info = this._stmt(`INSERT INTO messages (id, chat_id, seq, sender, text, timestamp, tool_name, params_json,
        result_json, run_id, llm_json, context_json, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chatId, seq, row.sender, row.text, row.timestamp, row.tool_name, row.params_json,
        row.result_json, row.run_id, row.llm_json, row.context_json, row.meta_json);
    for (const a of attachments) {
      this._stmt('INSERT INTO attachments (id, message_id, kind, idx, name, mime, bytes, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${id}:${a.kind}:${a.idx}`, id, a.kind, a.idx, a.name, a.mime, a.bytes, a.text, a.meta_json);
    }
    const stored = rows.rowToMessage({ ...row, id, seq }, attachments);
    return { rowId: Number(info.lastInsertRowid), id, seq, stored };
  }

  _messagesFor(chatId, { fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER, limit = -1 } = {}) {
    const list = this._stmt('SELECT * FROM messages WHERE chat_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?')
      .all(chatId, fromSeq, toSeq, limit);
    if (!list.length) return [];
    const attachments = this._stmt(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.chat_id = ? AND m.seq >= ? AND m.seq <= ? ORDER BY a.message_id, a.kind, a.idx`)
      .all(chatId, list[0].seq, list[list.length - 1].seq);
    const byMessage = new Map();
    for (const a of attachments) {
      if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
      byMessage.get(a.message_id).push(a);
    }
    return list.map((row) => rows.rowToMessage(row, byMessage.get(row.id) || []));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/history-store-chats.test.js tests/history-schema.test.js tests/history-rows.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/history-store.js tests/history-store-chats.test.js
git commit -m "feat(history): chats, messages and attachments as rows in the history store"
```

---

## Task 4: Appending, truncating and reading messages

**Files:**
- Modify: `src/history/history-store.js`
- Test: `tests/history-store-messages.test.js`

**Interfaces:**
- Consumes: Task 3's `_chatRow`, `_insertMessage`, `_updateChatRow`, `_messagesFor`, `rows.rowToChat`.
- Produces (methods on `HistoryStore`):
  - `appendMessage(chatId, message, { updatedAt, patch } = {}) → { message, seq } | null`: one transaction; inserts the message at the next `seq` through `_insertMessage`, sets the chat's `updatedAt` to `updatedAt` (else the stored message's `timestamp`), then merges `patch` (which wins over `updatedAt`; a `messages` key is ignored); `message` is the stored shape with `seq`; `null` for an unknown chat; any failure throws and writes nothing.
  - `truncateFrom(chatId, seq) → number` (messages removed): deletes every message with `seq >= seq` (their attachments follow), so `seq` stays dense; `seq` must be an integer ≥ 1 (`RangeError` otherwise).
  - `getMessages(chatId, { fromSeq = 1, toSeq, limit } = {}) → Message[]`: **both bounds inclusive**, ascending `seq`, at most `limit` messages counted from `fromSeq`; `[]` for an unknown chat.
  - `messageCount(chatId) → number`.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-store-messages.test.js`:

```js
// tests/history-store-messages.test.js
// appendMessage, truncateFrom and getMessages keep seq dense from 1
// (recall spec §4.1, §5.1 for the one-transaction append).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { HistoryStore } = require('../src/history');

const stores = [];
afterEach(() => { while (stores.length) stores.pop().close(); });
function memory(StoreClass = HistoryStore) {
  const store = StoreClass.open(':memory:');
  stores.push(store);
  return store;
}
const msg = (id, sender, text, extra = {}) => ({ id, sender, text, timestamp: '2026-09-29T10:00:00.000Z', ...extra });
const seqs = (store, chatId) => store.getMessages(chatId).map((m) => m.seq);

describe('HistoryStore messages', () => {
  it('appends at the next seq, updates updatedAt and merges the patch', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', updatedAt: '2026-09-01T00:00:00.000Z', messages: [msg('m1', 'assistant', 'How can I help you?')] });
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', name: 'a.png' };
    const result = store.appendMessage('c1', msg('m2', 'user', 'hello', { images: [image] }), {
      updatedAt: '2026-09-29T11:00:00.000Z',
      patch: { llmTotals: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 } }
    });
    assert.strictEqual(result.seq, 2);
    assert.deepStrictEqual(result.message, { ...msg('m2', 'user', 'hello', { images: [image] }), seq: 2 });
    const chat = store.getChat('c1', { messages: false });
    assert.strictEqual(chat.updatedAt, '2026-09-29T11:00:00.000Z');
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 });
    assert.deepStrictEqual(seqs(store, 'c1'), [1, 2]);
  });

  it('uses the message timestamp when no updatedAt is given, and lets the patch win', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One' });
    store.appendMessage('c1', msg('m1', 'user', 'a'));
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, '2026-09-29T10:00:00.000Z');
    store.appendMessage('c1', msg('m2', 'user', 'b'), { updatedAt: 'x', patch: { updatedAt: 'from-patch' } });
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, 'from-patch');
  });

  it('returns null for an unknown chat and writes nothing', () => {
    const store = memory();
    assert.strictEqual(store.appendMessage('missing', msg('m1', 'user', 'x')), null);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  });

  it('throws on an invalid message and leaves the chat as it was', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', updatedAt: 'before' });
    assert.throws(() => store.appendMessage('c1', { text: 'no sender' }, { updatedAt: 'after' }), /sender/);
    assert.strictEqual(store.getChat('c1', { messages: false }).updatedAt, 'before');
    assert.deepStrictEqual(seqs(store, 'c1'), []);
  });

  it('truncateFrom removes seq >= n with their attachments, and the next append reuses n', () => {
    const store = memory();
    const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
    store.createChat({ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b'), msg('m3', 'user', 'c', { images: [image] })] });
    assert.strictEqual(store.truncateFrom('c1', 2), 2);
    assert.deepStrictEqual(seqs(store, 'c1'), [1]);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
    assert.strictEqual(store.appendMessage('c1', msg('m4', 'user', 'again')).seq, 2);
    assert.strictEqual(store.truncateFrom('c1', 99), 0);
    assert.throws(() => store.truncateFrom('c1', 0), RangeError);
    assert.throws(() => store.truncateFrom('c1', 1.5), RangeError);
  });

  it('getMessages reads an inclusive range with a limit', () => {
    const store = memory();
    store.createChat({ id: 'c1', title: 'One', messages: ['a', 'b', 'c', 'd', 'e'].map((t, i) => msg(`m${i}`, 'user', t)) });
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 2, toSeq: 4 }).map((m) => m.text), ['b', 'c', 'd']);
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 3 }).map((m) => m.seq), [3, 4, 5]);
    assert.deepStrictEqual(store.getMessages('c1', { fromSeq: 2, limit: 2 }).map((m) => m.seq), [2, 3]);
    assert.deepStrictEqual(store.getMessages('missing'), []);
    assert.strictEqual(store.messageCount('c1'), 5);
    assert.strictEqual(store.messageCount('missing'), 0);
  });

  it('gives a copied chat fresh ids for message ids already stored (review focus 1)', () => {
    const store = memory();
    const messages = [msg('shared-1', 'user', 'blue folder'), msg('shared-2', 'assistant', 'noted')];
    store.createChat({ id: 'source', title: 'Source', messages });
    store.createChat({ id: 'copy', title: 'Source (copy)', messages }, { position: 'back' });
    const copy = store.getChat('copy').messages;
    assert.deepStrictEqual(copy.map((m) => m.text), ['blue folder', 'noted']);
    assert.ok(copy.every((m) => !m.id.startsWith('shared-')), 'the copy got its own ids');
    assert.deepStrictEqual(store.getChat('source').messages.map((m) => m.id), ['shared-1', 'shared-2']);
    const appended = store.appendMessage('copy', msg('shared-1', 'user', 'again'));
    assert.notStrictEqual(appended.message.id, 'shared-1');
  });

  it('runs work a subclass adds in _insertMessage inside the same transaction (the H2 seam)', () => {
    class Probe extends HistoryStore {
      _insertMessage(db, chatId, message, options) {
        const result = super._insertMessage(db, chatId, message, options);
        db.prepare('INSERT INTO probe (message_id) VALUES (?)').run(result.id);
        if (message.text === 'fail') throw new Error('probe failed');
        return result;
      }
    }
    const store = memory(Probe);
    assert.ok(store instanceof Probe);
    store.db.exec('CREATE TABLE probe (message_id TEXT)');
    store.createChat({ id: 'c1', title: 'One' });
    store.appendMessage('c1', msg('m1', 'user', 'ok'));
    assert.throws(() => store.appendMessage('c1', msg('m2', 'user', 'fail')), /probe failed/);
    assert.deepStrictEqual(store.db.prepare('SELECT message_id FROM probe').all().map((r) => r.message_id), ['m1']);
    assert.deepStrictEqual(seqs(store, 'c1'), [1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-store-messages.test.js`
Expected: FAIL with `store.appendMessage is not a function`.

- [ ] **Step 3: Add the message methods to `src/history/history-store.js`**

Add after `deleteChat`:

```js
  // ── messages ───────────────────────────────────────────────────────────

  appendMessage(chatId, message, { updatedAt, patch } = {}) {
    const id = normalizeId(chatId);
    if (!id) return null;
    return this.transaction((db) => {
      const row = this._chatRow(id);
      if (!row) return null;
      const inserted = this._insertMessage(db, id, message, { fallbackTimestamp: updatedAt });
      const { messages: _ignored, ...fields } = patch || {};
      this._updateChatRow(id, { ...rows.rowToChat(row), updatedAt: updatedAt || inserted.stored.timestamp, ...fields });
      return { message: inserted.stored, seq: inserted.seq };
    });
  }

  // Removing messages is only ever "from seq n onward", so seq stays dense
  // from 1 (spec §4.1).
  truncateFrom(chatId, seq) {
    const id = normalizeId(chatId);
    const from = Number(seq);
    if (!Number.isInteger(from) || from < 1) throw new RangeError(`truncateFrom needs a seq of 1 or more, got ${seq}.`);
    return this.transaction(() => Number(this._stmt('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(id, from).changes));
  }

  // fromSeq and toSeq are both inclusive; limit counts from fromSeq.
  getMessages(chatId, { fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER, limit = -1 } = {}) {
    const id = normalizeId(chatId);
    if (!id) return [];
    const bound = (value, fallback) => (Number.isInteger(Number(value)) ? Number(value) : fallback);
    return this._messagesFor(id, {
      fromSeq: bound(fromSeq, 1),
      toSeq: bound(toSeq, Number.MAX_SAFE_INTEGER),
      limit: Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : -1
    });
  }

  messageCount(chatId) {
    return Number(this._stmt('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(normalizeId(chatId)).n);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/history-store-messages.test.js tests/history-store-chats.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/history/history-store.js tests/history-store-messages.test.js
git commit -m "feat(history): appendMessage, truncateFrom and getMessages with a dense seq"
```

---

## Task 5: Moving chats out of chat-data.json

**Files:**
- Create: `src/history/migrate-json.js`
- Modify: `src/history/index.js`
- Test: `tests/history-migrate-json.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 4's `HistoryStore` (`getMeta`, `setMeta`, `transaction`, `getChat`, `createChat`, `messageCount`); an electron-store-like `jsonStore` with `get(key, fallback)` and `set(key, value)` (`JsonFileStore` from `src/platform/json-file-store.js` in tests).
- Produces:
  - `migrateFromJson({ historyStore, jsonStore, jsonPath = null, log, now = () => new Date().toISOString() }) → { migrated: number, failed: Array<{ id: string, error: string }> }`. `id` is the chat's id, or `#<index>` for an entry without one.
  - `MIGRATION_MARKER = 'migrated_from_json'` (the `meta` key; its value is the ISO time the array became empty).
  - Behaviour, in order: with the marker set, returns `{ migrated: 0, failed: [] }` and reads nothing else. A `chats` value that is not an array is one failure `{ id: 'chats', … }`, nothing changes and no marker is set. An empty array sets the marker and returns. Otherwise copies `jsonPath` to `chat-data.backup-<stamp>.json` (`stamp` is one `now()` call per run, `:` and `.` replaced by `-`) beside it (never overwriting a file; a failed copy fails every chat and changes nothing; no file at `jsonPath` means no backup and a warning). Each chat then moves in its own transaction, in array order, to the back of the list: it must be an object with a non-empty `id` whose `messages` is a list, `null` or absent, not seen earlier in this run; the stored message count must equal the JSON one. A chat already in the store with the same message count (a crash between the commit and the JSON rewrite) counts as moved; with a different count it fails. Moved chats leave the JSON array in one `set('chats', remaining)`; the marker (value: that run's `stamp`) is set when `remaining` is empty. Every failure is logged with `log.error`.
  - `src/history/index.js` also exports `migrateFromJson` and `MIGRATION_MARKER`.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-migrate-json.test.js`:

```js
// tests/history-migrate-json.test.js
// The one-way move of chat-data.json's chats into history.sqlite (recall
// spec §11.1, §13 "migration", §15 "Migration of one chat fails").
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, migrateFromJson, MIGRATION_MARKER } = require('../src/history');
const { JsonFileStore } = require('../src/platform/json-file-store');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const NOW = '2026-09-29T12:00:00.000Z';
const BACKUP = 'chat-data.backup-2026-09-29T12-00-00-000Z.json';
const msg = (id, sender, text) => ({ id, sender, text, timestamp: '2026-09-28T10:00:00.000Z' });

function setup(chats, { extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-migrate-'));
  dirs.push(dir);
  const jsonStore = new JsonFileStore({ dir, name: 'chat-data', defaults: {} });
  jsonStore.set('activeChatId', 'c1');
  for (const [k, v] of Object.entries(extra)) jsonStore.set(k, v);
  jsonStore.set('chats', chats);
  const historyStore = HistoryStore.open(path.join(dir, 'history.sqlite'));
  stores.push(historyStore);
  const lines = [];
  const log = {
    info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]), debug: () => {}
  };
  // One tick per run: the first run's stamp is NOW, the next one a second later.
  let tick = 0;
  const now = () => new Date(Date.parse(NOW) + 1000 * tick++).toISOString();
  const run = () => migrateFromJson({ historyStore, jsonStore, jsonPath: jsonStore.path, log, now });
  return { dir, jsonStore, historyStore, lines, run };
}
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('chat-data.backup-'));

describe('migrateFromJson', () => {
  it('moves every chat in order, backs the file up first and sets the marker', () => {
    const chats = [
      { id: 'c1', title: 'Lakeside lot', llmTotals: { inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.001 }, messages: [msg('m1', 'user', 'blue folder'), msg('m2', 'assistant', 'noted')] },
      { id: 'c2', title: 'Second', messages: [] },
      { id: 'c3', title: 'No messages key' }
    ];
    const { dir, jsonStore, historyStore, run } = setup(chats);
    const before = fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8');

    assert.deepStrictEqual(run(), { migrated: 3, failed: [] });

    assert.deepStrictEqual(backups(dir), [BACKUP]);
    assert.strictEqual(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), before, 'the backup is the file as it was');
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['c1', 'c2', 'c3']);
    const c1 = historyStore.getChat('c1');
    assert.deepStrictEqual(c1.messages.map(({ seq, ...m }) => [seq, m]), [[1, chats[0].messages[0]], [2, chats[0].messages[1]]]);
    assert.deepStrictEqual(c1.llmTotals, chats[0].llmTotals);
    assert.deepStrictEqual(jsonStore.get('chats'), []);
    assert.strictEqual(readJson(dir).activeChatId, 'c1', 'everything but chats stays in chat-data.json');
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), NOW);
  });

  it('does nothing once the marker is set, even if chats reappear in the JSON file', () => {
    const { dir, jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [] }]);
    run();
    historyStore.deleteChat('c1');
    jsonStore.set('chats', [{ id: 'c1', title: 'One', messages: [] }]);
    assert.deepStrictEqual(run(), { migrated: 0, failed: [] });
    assert.deepStrictEqual(historyStore.listChats(), []);
    assert.deepStrictEqual(backups(dir), [BACKUP], 'no second backup');
  });

  it('sets the marker at once for an empty array, with no backup', () => {
    const { dir, historyStore, run } = setup([]);
    assert.deepStrictEqual(run(), { migrated: 0, failed: [] });
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), NOW);
    assert.deepStrictEqual(backups(dir), []);
  });

  it('leaves broken chats in the JSON array, moves the rest, reports and logs each, and resumes', () => {
    const good = { id: 'good', title: 'Good', messages: [msg('g1', 'user', 'fine')] };
    const badMessages = { id: 'bad-messages', title: 'Bad', messages: 'not a list' };
    const noSender = { id: 'no-sender', title: 'Bad', messages: [msg('n1', 'user', 'ok'), { id: 'n2', text: 'orphan' }] };
    const noId = { title: 'No id', messages: [] };
    const { jsonStore, historyStore, lines, run } = setup([good, badMessages, noSender, noId, 'not a chat']);

    const result = run();

    assert.strictEqual(result.migrated, 1);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['bad-messages', 'no-sender', '#3', '#4']);
    assert.ok(result.failed.every((f) => typeof f.error === 'string' && f.error));
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['good']);
    assert.strictEqual(historyStore.getChat('no-sender'), null, 'a failed chat leaves nothing half-written');
    assert.deepStrictEqual(jsonStore.get('chats'), [badMessages, noSender, noId, 'not a chat']);
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), null);
    assert.strictEqual(lines.filter(([level]) => level === 'error').length, 4);

    jsonStore.set('chats', [{ ...noSender, messages: [msg('n1', 'user', 'ok')] }]);
    assert.deepStrictEqual(run(), { migrated: 1, failed: [] });
    assert.deepStrictEqual(historyStore.listChats().map((c) => c.id), ['good', 'no-sender']);
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), '2026-09-29T12:00:01.000Z');
  });

  it('counts a chat committed before a crash as moved, without duplicating it (review focus 5)', () => {
    const chat = { id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b')] };
    const { jsonStore, historyStore, run } = setup([chat, { id: 'c2', title: 'Two', messages: [] }]);
    historyStore.createChat(chat, { position: 'back' });

    assert.deepStrictEqual(run(), { migrated: 2, failed: [] });
    assert.deepStrictEqual(historyStore.listChats().map((c) => [c.id, c.messageCount]), [['c1', 2], ['c2', 0]]);
    assert.deepStrictEqual(jsonStore.get('chats'), []);
  });

  it('fails a chat already stored with a different message count', () => {
    const { jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [msg('m1', 'user', 'a')] }]);
    historyStore.createChat({ id: 'c1', title: 'One', messages: [] });
    const result = run();
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.match(result.failed[0].error, /already/);
    assert.strictEqual(jsonStore.get('chats').length, 1);
  });

  it('fails the second of two chats with the same id', () => {
    const { jsonStore, run } = setup([{ id: 'c1', title: 'First', messages: [] }, { id: 'c1', title: 'Second', messages: [] }]);
    const result = run();
    assert.strictEqual(result.migrated, 1);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.deepStrictEqual(jsonStore.get('chats').map((c) => c.title), ['Second']);
  });

  it('moves a desktop-import copy that shares message ids with its source (review focus 1)', () => {
    const messages = [msg('shared-1', 'user', 'blue folder')];
    const { historyStore, run } = setup([
      { id: 'c1', title: 'Source', messages },
      { id: 'c1-copy', title: 'Source (copy)', messages }
    ]);
    assert.deepStrictEqual(run(), { migrated: 2, failed: [] });
    assert.strictEqual(historyStore.getChat('c1-copy').messages[0].text, 'blue folder');
  });

  it('moves nothing when the backup cannot be written', () => {
    const { dir, jsonStore, historyStore, run } = setup([{ id: 'c1', title: 'One', messages: [] }]);
    fs.writeFileSync(path.join(dir, BACKUP), 'an older backup with the same name');
    const result = run();
    assert.strictEqual(result.migrated, 0);
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['c1']);
    assert.match(result.failed[0].error, /backup/);
    assert.deepStrictEqual(historyStore.listChats(), []);
    assert.strictEqual(jsonStore.get('chats').length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, BACKUP), 'utf8'), 'an older backup with the same name');
  });

  it('reports a chats value that is not a list and changes nothing', () => {
    const { jsonStore, historyStore, run } = setup({ oops: true });
    const result = run();
    assert.deepStrictEqual(result.failed.map((f) => f.id), ['chats']);
    assert.deepStrictEqual(jsonStore.get('chats'), { oops: true });
    assert.strictEqual(historyStore.getMeta(MIGRATION_MARKER), null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-migrate-json.test.js`
Expected: FAIL with `migrateFromJson is not a function`.

- [ ] **Step 3: Write `src/history/migrate-json.js`**

```js
// src/history/migrate-json.js
// The one-way move of chat-data.json's `chats` array into history.sqlite
// (recall spec §11.1). The backup comes first; each chat moves in its own
// transaction; a chat that fails stays in the JSON array and is reported;
// the marker is set only when the array is empty, so a crash midway resumes
// on the next start. Only chat-data.json is read: an old chat-history.sqlite
// (the blob store) is never opened (owner decision 2026-09-29).
const fs = require('fs');
const path = require('path');

const MIGRATION_MARKER = 'migrated_from_json';

const backupName = (stamp) => `chat-data.backup-${String(stamp).replace(/[:.]/g, '-')}.json`;

function chatLabel(chat, index) {
  const id = chat && typeof chat === 'object' ? String(chat.id ?? '').trim() : '';
  return id || `#${index}`;
}

function moveChat(historyStore, chat, seen) {
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw new Error('it is not a chat object');
  const id = String(chat.id ?? '').trim();
  if (!id) throw new Error('it has no id');
  if (seen.has(id)) throw new Error('another chat earlier in chat-data.json has the same id');
  seen.add(id);
  if (chat.messages != null && !Array.isArray(chat.messages)) throw new Error('its messages are not a list');
  const expected = Array.isArray(chat.messages) ? chat.messages.length : 0;
  historyStore.transaction(() => {
    if (historyStore.getChat(id, { messages: false })) {
      const stored = historyStore.messageCount(id);
      // Committed by an earlier run that stopped before rewriting the JSON.
      if (stored === expected) return;
      throw new Error(`a chat with this id is already in history.sqlite with ${stored} messages, not ${expected}`);
    }
    historyStore.createChat({ ...chat, id }, { position: 'back' });
    const stored = historyStore.messageCount(id);
    if (stored !== expected) throw new Error(`stored ${stored} of its ${expected} messages`);
  });
}

function migrateFromJson({ historyStore, jsonStore, jsonPath = null, log, now = () => new Date().toISOString() }) {
  if (historyStore.getMeta(MIGRATION_MARKER)) return { migrated: 0, failed: [] };
  const chats = jsonStore.get('chats', []);
  if (!Array.isArray(chats)) {
    const error = 'chats in chat-data.json is not a list';
    log.error(`Chats could not be moved into history.sqlite: ${error}.`);
    return { migrated: 0, failed: [{ id: 'chats', error }] };
  }
  const stamp = now();
  if (chats.length === 0) {
    historyStore.setMeta(MIGRATION_MARKER, stamp);
    return { migrated: 0, failed: [] };
  }

  if (jsonPath && fs.existsSync(jsonPath)) {
    const target = path.join(path.dirname(jsonPath), backupName(stamp));
    try {
      fs.copyFileSync(jsonPath, target, fs.constants.COPYFILE_EXCL);
      log.info(`Backed up chat-data.json to ${target} before moving ${chats.length} chat(s) into history.sqlite.`);
    } catch (err) {
      const error = `backup failed: ${err.message}`;
      log.error(`chat-data.json could not be backed up (${err.message}); no chats were moved.`);
      return { migrated: 0, failed: chats.map((chat, index) => ({ id: chatLabel(chat, index), error })) };
    }
  } else {
    log.warn('chat-data.json is not on disk, so there is no file to back up; moving its chats anyway.');
  }

  const seen = new Set();
  const remaining = [];
  const failed = [];
  let migrated = 0;
  chats.forEach((chat, index) => {
    try {
      moveChat(historyStore, chat, seen);
      migrated += 1;
    } catch (err) {
      const id = chatLabel(chat, index);
      failed.push({ id, error: err.message });
      remaining.push(chat);
      log.error(`Chat ${id} could not be moved into history.sqlite and stays in chat-data.json: ${err.message}`);
    }
  });

  if (migrated > 0) jsonStore.set('chats', remaining);
  if (remaining.length === 0) historyStore.setMeta(MIGRATION_MARKER, stamp);
  log.info(`Moved ${migrated} chat(s) into history.sqlite${failed.length ? `; ${failed.length} stay in chat-data.json` : ''}.`);
  return { migrated, failed };
}

module.exports = { migrateFromJson, MIGRATION_MARKER };
```

- [ ] **Step 4: Export it from `src/history/index.js`**

```js
const { HistoryStore } = require('./history-store');
const { migrateFromJson, MIGRATION_MARKER } = require('./migrate-json');
const { JsonChatHistoryStore } = require('./chat-history-store');
const { SqliteChatHistoryStore } = require('./sqlite-chat-history-store');

module.exports = {
  HistoryStore,
  migrateFromJson,
  MIGRATION_MARKER,
  JsonChatHistoryStore,
  SqliteChatHistoryStore
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/history-migrate-json.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/history/migrate-json.js src/history/index.js tests/history-migrate-json.test.js
git commit -m "feat(history): move chat-data.json's chats into history.sqlite, one transaction per chat"
```

---

## Task 6: The chat facade, the unavailable store and test helpers

**Files:**
- Create: `src/history/chat-facade.js`, `src/history/unavailable-store.js`, `tests/helpers/history-context.js`, `tests/helpers/close-history-stores.js`
- Modify: `src/history/index.js`
- Test: `tests/history-chat-facade.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 4's `HistoryStore` methods.
- Produces:
  - `src/history/chat-facade.js`:
    - `createChatFacade({ historyStore, createId, now = () => new Date().toISOString() })` → `{ historyStore, listChats(options), getChat(id, options), createChat(chat, options), replaceChat(id, chat), upsertChat(chat, options), updateChat(id, patch, options), updateChatsWhere(predicate, patcher), deleteChat(id), getMessages(chatId, range), appendMessageToChat(chatId, sender, text, metadata = {}) → Chat|null, truncateChatFrom(chatId, seq) → Chat|null }`. The first nine delegate to the store with the same arguments.
    - `appendMessageToChat`: builds `{ id: createId(), sender, text, timestamp: now(), ...metadata }` where `metadata`'s `id`, `sender`, `timestamp` and `seq` are ignored; in one transaction reads the chat without messages (`null` if unknown), takes its stored `llmTotals` (or, for a chat without one, the totals of its stored messages), adds the new message's `llm.totals`, and calls `historyStore.appendMessage(chatId, message, { updatedAt: timestamp, patch: { llmTotals } })`; returns `getChat(chatId, { messages: true })`.
    - `truncateChatFrom(chatId, seq)`: in one transaction `truncateFrom(chatId, seq)` and `updateChat(chatId, { updatedAt: now() }, { messages: false })`; returns the chat with messages, or `null` when unknown. `llmTotals` is not recomputed (as today's truncate).
    - `addLlmTotals(totals, message) → totals` and `chatLlmTotals(messages) → totals`, where `totals = { inputTokens, outputTokens, totalTokens, costUsd }` and `costUsd` is rounded with `toFixed(8)` at each step, exactly as today's `getChatLlmTotals` in `create-core.js`.
  - `src/history/unavailable-store.js`: `HistoryUnavailableError` (`code: 'HISTORY_UNAVAILABLE'`, `cause`), `createUnavailableHistoryStore(cause) → store` whose `listChats`, `getChat`, `createChat`, `replaceChat`, `upsertChat`, `updateChat`, `updateChatsWhere`, `deleteChat`, `appendMessage`, `truncateFrom`, `getMessages`, `messageCount`, `transaction`, `getMeta`, `setMeta` all throw it; `close()` does nothing; `isOpen` is `false`; `available` is `false`.
  - `src/history/index.js` exports `createChatFacade`, `addLlmTotals`, `chatLlmTotals`, `createUnavailableHistoryStore`, `HistoryUnavailableError`, `InvalidMessageError`, `DERIVED_CHAT_KEYS`, plus what it already exports.
  - `tests/helpers/history-context.js`: `historyContext(chats = [], { createId } = {}) →` the facade over a fresh `HistoryStore.open(':memory:')` (chats created in order, `position: 'back'`), plus `getHistoryStore()` and `getHistoryStatus() → { available: true, error: null, migrationFailed: 0 }`. Spread it into a test's IPC context.
  - `tests/helpers/close-history-stores.js`: requiring it records every `HistoryStore.open` in this test process; `closeOpenHistoryStores()` closes them all. On Windows an open SQLite file keeps its folder from being deleted (`EPERM` from `fs.rmSync`), so a test that builds a core calls it before removing the data dir.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-chat-facade.test.js`:

```js
// tests/history-chat-facade.test.js
// appendMessageToChat keeps its signature and return value over appendMessage,
// with llmTotals kept incrementally (recall spec §4.4); a store that will not
// open fails every call loudly (§15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  HistoryStore, createChatFacade, chatLlmTotals, createUnavailableHistoryStore, HistoryUnavailableError
} = require('../src/history');
const { historyContext } = require('./helpers/history-context');

function facade(chats = []) {
  const historyStore = HistoryStore.open(':memory:');
  for (const chat of chats) historyStore.createChat(chat, { position: 'back' });
  let n = 0;
  let clock = 0;
  return createChatFacade({
    historyStore,
    createId: () => `gen-${++n}`,
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, clock++)).toISOString()
  });
}
const llm = (inputTokens, outputTokens, costUsd) => ({ totals: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd } });

describe('createChatFacade', () => {
  it('appendMessageToChat sets id, sender and timestamp itself and returns the whole chat', () => {
    const f = facade([{ id: 'c1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?', timestamp: 't0' }] }]);
    const chat = f.appendMessageToChat('c1', 'user', 'hi', { id: 'spoofed', sender: 'assistant', timestamp: '1999-01-01T00:00:00.000Z', seq: 99, channel: 'telegram' });
    const message = chat.messages[1];
    assert.strictEqual(message.id, 'gen-1');
    assert.strictEqual(message.sender, 'user');
    assert.strictEqual(message.timestamp, '2026-09-29T12:00:00.000Z');
    assert.strictEqual(message.seq, 2);
    assert.strictEqual(message.channel, 'telegram');
    assert.strictEqual(chat.updatedAt, '2026-09-29T12:00:00.000Z');
    assert.strictEqual(f.appendMessageToChat('missing', 'user', 'x'), null);
  });

  it('keeps llmTotals incrementally, equal to summing every message', () => {
    const f = facade([{ id: 'c1', title: 'Chat', messages: [] }]);
    f.appendMessageToChat('c1', 'user', 'q1');
    f.appendMessageToChat('c1', 'assistant', 'a1', { llm: llm(100, 20, 0.00123456) });
    f.appendMessageToChat('c1', 'toolUse', '', { toolName: 'Bash', parameters: { command: 'ls' } });
    const chat = f.appendMessageToChat('c1', 'assistant', 'a2', { llm: llm(300, 40, 0.00000011) });
    assert.deepStrictEqual(chat.llmTotals, chatLlmTotals(chat.messages));
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 400, outputTokens: 60, totalTokens: 460, costUsd: 0.00123467 });
  });

  it('starts from the stored messages for a chat that has no llmTotals yet', () => {
    const f = facade([{ id: 'c1', title: 'Legacy', messages: [{ id: 'm1', sender: 'assistant', text: 'old', timestamp: 't', llm: llm(10, 5, 0.5) }] }]);
    const chat = f.appendMessageToChat('c1', 'assistant', 'new', { llm: llm(1, 1, 0.25) });
    assert.deepStrictEqual(chat.llmTotals, { inputTokens: 11, outputTokens: 6, totalTokens: 17, costUsd: 0.75 });
  });

  it('truncateChatFrom removes from a seq on and stamps updatedAt', () => {
    const f = facade([{ id: 'c1', title: 'Chat', updatedAt: 'before', messages: ['a', 'b', 'c'].map((t, i) => ({ id: `m${i}`, sender: 'user', text: t, timestamp: 't' })) }]);
    const chat = f.truncateChatFrom('c1', 2);
    assert.deepStrictEqual(chat.messages.map((m) => m.text), ['a']);
    assert.notStrictEqual(chat.updatedAt, 'before');
    assert.strictEqual(f.truncateChatFrom('missing', 1), null);
  });

  it('delegates the chat calls to the store', () => {
    const f = facade();
    f.createChat({ id: 'c1', title: 'One' });
    assert.strictEqual(f.updateChat('c1', { title: 'Renamed' }, { messages: false }).title, 'Renamed');
    assert.deepStrictEqual(f.listChats().map((c) => c.title), ['Renamed']);
    assert.deepStrictEqual(f.deleteChat('c1'), []);
  });
});

describe('the unavailable store', () => {
  it('fails every chat call with HISTORY_UNAVAILABLE, naming the cause', () => {
    const store = createUnavailableHistoryStore(new Error('file is not a database'));
    const f = createChatFacade({ historyStore: store, createId: () => 'x' });
    for (const call of [() => f.listChats(), () => f.getChat('c1'), () => f.appendMessageToChat('c1', 'user', 'hi'), () => f.updateChat('c1', {}), () => f.truncateChatFrom('c1', 1)]) {
      assert.throws(call, (err) => err instanceof HistoryUnavailableError && err.code === 'HISTORY_UNAVAILABLE' && /file is not a database/.test(err.message));
    }
    store.close();
    assert.strictEqual(store.isOpen, false);
  });
});

describe('historyContext test helper', () => {
  it('builds a facade over an in-memory store seeded in order', () => {
    const ctx = historyContext([{ id: 'a', title: 'A', messages: [] }, { id: 'b', title: 'B', messages: [] }]);
    assert.deepStrictEqual(ctx.listChats().map((c) => c.id), ['a', 'b']);
    assert.strictEqual(ctx.getHistoryStatus().available, true);
    assert.ok(ctx.getHistoryStore() instanceof HistoryStore);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-chat-facade.test.js`
Expected: FAIL with `Cannot find module './helpers/history-context'`.

- [ ] **Step 3: Write `src/history/unavailable-store.js`**

```js
// src/history/unavailable-store.js
// Stands in for a history store that would not open (recall spec §15): every
// chat call fails loudly with the reason. There is no fallback to the JSON
// file.

class HistoryUnavailableError extends Error {
  constructor(cause) {
    super(`Chat history is unavailable: ${cause?.message || cause || 'the history store did not open'}`);
    this.name = 'HistoryUnavailableError';
    this.code = 'HISTORY_UNAVAILABLE';
    this.cause = cause;
  }
}

const METHODS = [
  'listChats', 'getChat', 'createChat', 'replaceChat', 'upsertChat', 'updateChat', 'updateChatsWhere', 'deleteChat',
  'appendMessage', 'truncateFrom', 'getMessages', 'messageCount', 'transaction', 'getMeta', 'setMeta'
];

function createUnavailableHistoryStore(cause) {
  const store = { available: false, isOpen: false, cause, close() {} };
  for (const method of METHODS) {
    store[method] = () => { throw new HistoryUnavailableError(cause); };
  }
  return store;
}

module.exports = { createUnavailableHistoryStore, HistoryUnavailableError };
```

- [ ] **Step 4: Write `src/history/chat-facade.js`**

```js
// src/history/chat-facade.js
// The chat functions createCore puts on its context (recall spec §4.4):
// explicit store calls, plus appendMessageToChat with its old signature and
// return value, built on appendMessage. llmTotals is kept incrementally in
// the chat's meta_json instead of re-summing every message on each append.

const ZERO_TOTALS = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

function addLlmTotals(totals, message) {
  const add = message?.llm?.totals || {};
  return {
    inputTokens: (Number(totals?.inputTokens) || 0) + (Number(add.inputTokens) || 0),
    outputTokens: (Number(totals?.outputTokens) || 0) + (Number(add.outputTokens) || 0),
    totalTokens: (Number(totals?.totalTokens) || 0) + (Number(add.totalTokens) || 0),
    costUsd: Number(((Number(totals?.costUsd) || 0) + (Number(add.costUsd) || 0)).toFixed(8))
  };
}

const chatLlmTotals = (messages = []) => messages.reduce(addLlmTotals, { ...ZERO_TOTALS });

function createChatFacade({ historyStore, createId, now = () => new Date().toISOString() }) {
  if (!historyStore) throw new Error('createChatFacade needs historyStore.');
  if (typeof createId !== 'function') throw new Error('createChatFacade needs createId.');
  const store = historyStore;

  const appendMessageToChat = (chatId, sender, text, metadata = {}) => {
    // id, sender, timestamp and seq are this function's (and the store's) to
    // set; an IPC payload spread into metadata must not override them.
    const { id: _id, sender: _sender, timestamp: _timestamp, seq: _seq, ...safeMetadata } = metadata || {};
    const timestamp = now();
    const message = { id: createId(), sender, text, timestamp, ...safeMetadata };
    const appended = store.transaction(() => {
      const chat = store.getChat(chatId, { messages: false });
      if (!chat) return null;
      const base = chat.llmTotals && typeof chat.llmTotals === 'object'
        ? chat.llmTotals
        : chatLlmTotals(store.getMessages(chat.id));
      return store.appendMessage(chat.id, message, { updatedAt: timestamp, patch: { llmTotals: addLlmTotals(base, message) } });
    });
    return appended ? store.getChat(chatId, { messages: true }) : null;
  };

  const truncateChatFrom = (chatId, seq) => {
    const done = store.transaction(() => {
      const chat = store.getChat(chatId, { messages: false });
      if (!chat) return false;
      store.truncateFrom(chat.id, seq);
      store.updateChat(chat.id, { updatedAt: now() }, { messages: false });
      return true;
    });
    return done ? store.getChat(chatId, { messages: true }) : null;
  };

  return {
    historyStore: store,
    listChats: (options) => store.listChats(options),
    getChat: (id, options) => store.getChat(id, options),
    createChat: (chat, options) => store.createChat(chat, options),
    replaceChat: (id, chat) => store.replaceChat(id, chat),
    upsertChat: (chat, options) => store.upsertChat(chat, options),
    updateChat: (id, patch, options) => store.updateChat(id, patch, options),
    updateChatsWhere: (predicate, patcher) => store.updateChatsWhere(predicate, patcher),
    deleteChat: (id) => store.deleteChat(id),
    getMessages: (chatId, range) => store.getMessages(chatId, range),
    appendMessageToChat,
    truncateChatFrom
  };
}

module.exports = { createChatFacade, addLlmTotals, chatLlmTotals };
```

- [ ] **Step 5: Update `src/history/index.js`**

```js
const { HistoryStore } = require('./history-store');
const { SCHEMA_STEPS, applySchema } = require('./schema');
const { migrateFromJson, MIGRATION_MARKER } = require('./migrate-json');
const { createChatFacade, addLlmTotals, chatLlmTotals } = require('./chat-facade');
const { createUnavailableHistoryStore, HistoryUnavailableError } = require('./unavailable-store');
const { InvalidMessageError, DERIVED_CHAT_KEYS } = require('./rows');
const { JsonChatHistoryStore } = require('./chat-history-store');
const { SqliteChatHistoryStore } = require('./sqlite-chat-history-store');

module.exports = {
  HistoryStore,
  SCHEMA_STEPS,
  applySchema,
  migrateFromJson,
  MIGRATION_MARKER,
  createChatFacade,
  addLlmTotals,
  chatLlmTotals,
  createUnavailableHistoryStore,
  HistoryUnavailableError,
  InvalidMessageError,
  DERIVED_CHAT_KEYS,
  JsonChatHistoryStore,
  SqliteChatHistoryStore
};
```

- [ ] **Step 6: Write the test helpers**

Create `tests/helpers/history-context.js`:

```js
// tests/helpers/history-context.js
// A chat context for IPC and core-free tests: the real chat facade over an
// in-memory history store, seeded with `chats` in order. Spread it into the
// context a handler is registered with.
const { HistoryStore, createChatFacade } = require('../../src/history');

function historyContext(chats = [], { createId } = {}) {
  const historyStore = HistoryStore.open(':memory:');
  for (const chat of chats) historyStore.createChat(chat, { position: 'back' });
  let n = 0;
  const facade = createChatFacade({ historyStore, createId: createId || (() => `hc-${++n}`) });
  return {
    ...facade,
    getHistoryStore: () => historyStore,
    getHistoryStatus: () => ({ available: true, error: null, migrationFailed: 0 })
  };
}

module.exports = { historyContext };
```

Create `tests/helpers/close-history-stores.js`:

```js
// tests/helpers/close-history-stores.js
// On Windows an open SQLite file keeps its folder from being deleted, so a
// test that builds a core (which opens <dataDir>/history.sqlite for its whole
// life) closes every store it opened before removing the data dir. Requiring
// this module records each HistoryStore.open in this test process.
const { HistoryStore } = require('../../src/history');

const opened = new Set();
if (!HistoryStore.__klTracked) {
  const open = HistoryStore.open;
  HistoryStore.open = function trackedOpen(...args) {
    const store = open.apply(this, args);
    opened.add(store);
    return store;
  };
  HistoryStore.__klTracked = true;
}

function closeOpenHistoryStores() {
  for (const store of opened) {
    try { store.close(); } catch { /* already closed */ }
  }
  opened.clear();
}

module.exports = { closeOpenHistoryStores };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/history-chat-facade.test.js tests/history-migrate-json.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/history/chat-facade.js src/history/unavailable-store.js src/history/index.js tests/helpers/history-context.js tests/helpers/close-history-stores.js tests/history-chat-facade.test.js
git commit -m "feat(history): chat facade with incremental llmTotals, and the unavailable store"
```

---

## Task 7: createCore on the history store

**Files:**
- Modify: `src/core/create-core.js` (the require at line 67; the store block at lines 258-273; `getChatLlmTotals` and `appendMessageToChat` at lines 825-872; `migrateLegacyBridgeChatOrigins` at line 290; `shutdown` at line 3016; `context` at line 3216)
- Modify: `src/service/cli.js:149` (`withServiceCore`)
- Modify: `src/history/index.js`
- Delete: `src/history/chat-history-store.js`, `src/history/sqlite-chat-history-store.js`, `tests/history-store.test.js`
- Test: `tests/history-core.test.js` (new), `tests/service-cli-models.test.js` (one test added)
- Modify (cleanup only): every test file that builds a core — `tests/cases-core.test.js`, `tests/cases-ingest-core.test.js`, `tests/cases-service-wakeups.test.js`, `tests/chat-profiles.test.js`, `tests/core-create.test.js`, `tests/core-origin.test.js`, `tests/core-remote-approvals.test.js`, `tests/desktop-bridge-dispatcher.test.js`, `tests/desktop-bridge-protocol.test.js`, `tests/desktop-bridge-service.test.js`, `tests/desktop-export.test.js`, `tests/desktop-import.test.js`, `tests/executor-adapter-provider.test.js`, `tests/fleet-core-seams.test.js`, `tests/fleet-delegate.test.js`, `tests/models-core-profiles.test.js`, `tests/models-core.test.js`, `tests/models-headless.test.js`, `tests/models-king-louie.test.js`, `tests/playbooks-core.test.js`, `tests/service-run.test.js`, `tests/standalone-host.test.js`, `tests/tool-secret-paths.test.js`

**Interfaces:**
- Consumes: `HistoryStore.open`, `migrateFromJson`, `createChatFacade`, `createUnavailableHistoryStore` (Tasks 1 to 6); `closeOpenHistoryStores` (Task 6 helper).
- Produces:
  - `createCore(deps)` accepts `deps.history = { dbPath?: string, open?: boolean }`. It opens `deps.history.dbPath || <paths.dataDir>/history.sqlite` at construction, runs `migrateFromJson({ historyStore, jsonStore: deps.store, jsonPath: deps.store.path || null, log })` right after (before `start()`, as the blob store did), and closes the store as the last step of `shutdown()`. `deps.history.open === false` opens nothing and migrates nothing (for commands that run as root). `deps.historyStore` and `deps.historyDbPath` are no longer read.
  - On `core.context`: `historyStore`, `getHistoryStore() → HistoryStore|unavailable store`, `getHistoryStatus() → { available: boolean, error: string|null, migrationFailed: number }`, and the facade's `listChats`, `getChat`, `createChat`, `replaceChat`, `upsertChat`, `updateChat`, `updateChatsWhere`, `deleteChat`, `getMessages`, `appendMessageToChat`, `truncateChatFrom`. `getChats`/`setChats` stay for one more task as thin wrappers over the store (deleted in Task 9).
  - A store that will not open: `log.error` once (logger `history`), `getHistoryStatus()` says `available: false` with the error, every chat call throws `HISTORY_UNAVAILABLE`, `chat-data.json` is not touched, and `start()` still succeeds.
  - `src/history/index.js` no longer exports `JsonChatHistoryStore` or `SqliteChatHistoryStore`.

- [ ] **Step 1: Write the failing tests**

Create `tests/history-core.test.js`:

```js
// tests/history-core.test.js
// createCore opens <dataDir>/history.sqlite, moves chat-data.json's chats
// into it, reports a store that will not open, and closes it on shutdown
// (recall spec §4.4, §11.1, §15).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { createCore } = require('../src/core');
const { HistoryStore } = require('../src/history');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

const tempDirs = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps(chats = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-core-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  store.set('chats', chats);
  return {
    dataDir,
    deps: {
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}
const T = '2026-09-28T10:00:00.000Z';
const msg = (id, sender, text) => ({ id, sender, text, timestamp: T });
const backups = (dir) => fs.readdirSync(dir).filter((f) => /^chat-data\.backup-.*\.json$/.test(f));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('createCore and the history store', () => {
  it('opens <dataDir>/history.sqlite and moves the JSON chats into it at construction', () => {
    const { dataDir, deps } = makeDeps([
      { id: 'c1', title: 'Lakeside lot', messages: [msg('m1', 'user', 'blue folder'), msg('m2', 'assistant', 'noted')] },
      { id: 'c2', title: 'Second', messages: [] }
    ]);
    const core = createCore(deps);
    const store = core.context.getHistoryStore();
    assert.ok(store instanceof HistoryStore);
    assert.strictEqual(core.context.historyStore, store);
    assert.strictEqual(store.dbPath, path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(core.context.listChats().map((c) => [c.id, c.messageCount]), [['c1', 2], ['c2', 0]]);
    assert.deepStrictEqual(deps.store.get('chats'), []);
    assert.strictEqual(backups(dataDir).length, 1);
    assert.deepStrictEqual(core.context.getHistoryStatus(), { available: true, error: null, migrationFailed: 0 });
  });

  it('reports how many chats could not be moved and leaves them in chat-data.json', () => {
    const bad = { id: 'bad', title: 'Bad', messages: 'not a list' };
    const { deps } = makeDeps([{ id: 'good', title: 'Good', messages: [] }, bad]);
    const core = createCore(deps);
    assert.strictEqual(core.context.getHistoryStatus().migrationFailed, 1);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['good']);
    assert.deepStrictEqual(deps.store.get('chats'), [bad]);
  });

  it('uses deps.history.dbPath when given', () => {
    const { dataDir, deps } = makeDeps();
    const other = path.join(dataDir, 'elsewhere', 'custom.sqlite');
    const core = createCore({ ...deps, history: { dbPath: other } });
    assert.strictEqual(core.context.getHistoryStore().dbPath, other);
    assert.ok(fs.existsSync(other));
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
  });

  it('never reads or changes an old chat-history.sqlite', () => {
    const { dataDir, deps } = makeDeps([{ id: 'from-json', title: 'From JSON', messages: [] }]);
    const blobFile = path.join(dataDir, 'chat-history.sqlite');
    const blob = new DatabaseSync(blobFile);
    blob.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO chats VALUES ('from-blob', 0, '{"id":"from-blob","title":"Blob","messages":[]}');`);
    blob.close();
    const before = sha(blobFile);
    const core = createCore(deps);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['from-json']);
    assert.strictEqual(sha(blobFile), before);
  });

  it('reports a store that will not open, leaves chat-data.json alone, and still starts', async () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Kept in JSON', messages: [] }]);
    fs.writeFileSync(path.join(dataDir, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    const core = createCore(deps);
    const status = core.context.getHistoryStatus();
    assert.strictEqual(status.available, false);
    assert.match(status.error, /not a database/);
    assert.throws(() => core.context.listChats(), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.throws(() => core.context.appendMessageToChat('c1', 'user', 'hi'), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.strictEqual(deps.store.get('chats').length, 1);
    assert.deepStrictEqual(backups(dataDir), []);
    await core.start();
    await core.shutdown();
  });

  it('opens nothing and moves nothing with history.open false', () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Stays', messages: [] }]);
    const core = createCore({ ...deps, history: { open: false } });
    assert.strictEqual(core.context.getHistoryStatus().available, false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
    assert.strictEqual(deps.store.get('chats').length, 1);
  });

  it('appends messages as rows and closes the store on shutdown', async () => {
    const { dataDir, deps } = makeDeps();
    const core = createCore(deps);
    core.context.createChat({ id: 'c1', title: 'One', messages: [] });
    const chat = core.context.appendMessageToChat('c1', 'user', 'hello');
    assert.deepStrictEqual(chat.messages.map((m) => [m.seq, m.text]), [[1, 'hello']]);
    await core.start();
    await core.shutdown();
    assert.strictEqual(core.context.getHistoryStore().isOpen, false);
    const reopened = HistoryStore.open(path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(reopened.getMessages('c1').map((m) => m.text), ['hello']);
    reopened.close();
  });
});
```

Add to `tests/service-cli-models.test.js`, inside `describe('service CLI — models', …)`:

```js
  it('never opens the history store or moves chats (it may run as root)', async () => {
    const dir = dataDir();
    const file = path.join(dir, 'chat-data.json');
    fs.writeFileSync(file, JSON.stringify({ settings: SETTINGS, chats: [{ id: 'c1', title: 'Stays put', messages: [] }] }));
    assert.strictEqual(await main(['profiles', 'list', '--data-dir', dir], io()), 0);
    assert.ok(!fs.existsSync(path.join(dir, 'history.sqlite')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).chats.map((c) => c.id), ['c1']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-core.test.js tests/service-cli-models.test.js`
Expected: `tests/history-core.test.js` FAILS with `core.context.getHistoryStore is not a function`. The new CLI test passes today (the blob store writes `chat-history.sqlite` and leaves the JSON array alone); it guards Step 4, and would fail after Step 3 alone.

- [ ] **Step 3: Open the store in `src/core/create-core.js`**

Replace line 67:

```js
const { SqliteChatHistoryStore } = require('../history');
```

with:

```js
const { HistoryStore, migrateFromJson, createChatFacade, createUnavailableHistoryStore } = require('../history');
```

Replace lines 258-273 (from `const historyStore = deps.historyStore || new SqliteChatHistoryStore({` through `const deleteChat = (chatId) => historyStore.deleteChat(chatId);`) with:

```js
  // The history store (recall spec 2026-09-25 §4, stage H1):
  // <dataDir>/history.sqlite, one connection for the life of this core,
  // closed at the end of shutdown(). chat-data.json's chats move into it
  // once (§11.1). A store that will not open is reported through
  // getHistoryStatus() and chat:load and is never replaced by the JSON file
  // (§15). history.open === false builds a core that opens nothing: the
  // service CLI's model and profile commands run as root and must neither
  // create root-owned history files nor move chats.
  const historyLog = createLogger('history');
  const historyStatus = { available: true, error: null, migrationFailed: 0 };
  let historyStore;
  if (deps.history?.open === false) {
    historyStore = createUnavailableHistoryStore(new Error('this command does not open chat history'));
    historyStatus.available = false;
    historyStatus.error = 'this command does not open chat history';
  } else {
    const historyDbPath = deps.history?.dbPath || path.join(paths.dataDir, 'history.sqlite');
    try {
      historyStore = HistoryStore.open(historyDbPath);
    } catch (err) {
      historyLog.error(`Chat history could not be opened at ${historyDbPath}: ${err.message}. chat-data.json was left as it is.`);
      historyStore = createUnavailableHistoryStore(err);
      historyStatus.available = false;
      historyStatus.error = err.message;
    }
    if (historyStatus.available) {
      try {
        const { failed } = migrateFromJson({ historyStore, jsonStore: store, jsonPath: store.path || null, log: historyLog });
        historyStatus.migrationFailed = failed.length;
      } catch (err) {
        historyLog.error(`Moving chats out of chat-data.json failed: ${err.message}`);
        const left = store.get('chats', []);
        historyStatus.migrationFailed = Array.isArray(left) ? left.length : 1;
      }
    }
  }
  const getHistoryStore = () => historyStore;
  const getHistoryStatus = () => ({ ...historyStatus });
  const {
    listChats, getChat, updateChat, createChat, replaceChat, upsertChat, updateChatsWhere, deleteChat,
    getMessages, appendMessageToChat, truncateChatFrom
  } = createChatFacade({ historyStore, createId });
  // Transitional (H1 Tasks 7 to 9): the last getChats/setChats call sites
  // move to explicit store calls in Tasks 8 and 9, and Task 9 deletes these.
  const getChats = () => listChats({ messages: true });
  const setChats = (chats) => historyStore.transaction(() => {
    const list = Array.isArray(chats) ? chats : [];
    const keep = new Set(list.map((chat) => String(chat?.id ?? '').trim()).filter(Boolean));
    for (const chat of historyStore.listChats()) if (!keep.has(chat.id)) historyStore.deleteChat(chat.id);
    for (const chat of list) historyStore.upsertChat(chat, { position: 'back' });
    return list;
  });
```

In `migrateLegacyBridgeChatOrigins` (line 290), make the first line of the arrow function:

```js
    if (!historyStatus.available) return;
```

Delete `getChatLlmTotals` and `appendMessageToChat` (lines 825-872, from `const getChatLlmTotals = (chat) => {` through the closing `};` of `appendMessageToChat`): both now come from the facade (`addLlmTotals` keeps the same arithmetic).

At the end of `shutdown` (after `if (usageTracker) usageTracker.reset();`), add:

```js
    // Last: nothing after this point appends to a chat.
    try {
      historyStore.close();
    } catch (err) {
      log.warn(`Closing the history store failed: ${err.message}`);
    }
```

In `context` (line 3216), after `historyStore,` add:

```js
    getHistoryStore,
    getHistoryStatus,
    getMessages,
    truncateChatFrom,
```

- [ ] **Step 4: Build the CLI's core without history in `src/service/cli.js`**

In `withServiceCore`, change line 149:

```js
    const core = createCore({ ...ports, adminExecutors: NO_ADMIN_EXECUTORS });
```

to:

```js
    // These commands run as root and never touch chats: opening the history
    // store would create root-owned files and move chats out of chat-data.json.
    const core = createCore({ ...ports, adminExecutors: NO_ADMIN_EXECUTORS, history: { open: false } });
```

- [ ] **Step 5: Remove the old stores**

```bash
git rm src/history/chat-history-store.js src/history/sqlite-chat-history-store.js tests/history-store.test.js
```

In `src/history/index.js`, delete the two lines requiring `./chat-history-store` and `./sqlite-chat-history-store` and the `JsonChatHistoryStore`, `SqliteChatHistoryStore` entries from `module.exports`.

- [ ] **Step 6: Close stores before removing a core's data dir in the test suite**

On Windows `fs.rmSync` cannot delete a folder holding an open SQLite file (`EPERM`), and each core now holds `history.sqlite` open. In each test file listed under **Files** (cleanup only), add near the top:

```js
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
```

and call `closeOpenHistoryStores();` as the first statement of every `afterEach`, `after` or `finally` block that runs `fs.rmSync` on a directory a core used as its data dir. For example, in `tests/core-create.test.js`:

```js
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});
```

A test that calls `await core.shutdown()` before removing its dir is already covered (shutdown closes the store); the extra call is harmless.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/history-core.test.js tests/service-cli-models.test.js tests/core-create.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

Then run each cleanup-only file from the list above, e.g.:

```bash
node --test tests/cases-core.test.js tests/cases-ingest-core.test.js tests/cases-service-wakeups.test.js tests/chat-profiles.test.js tests/core-origin.test.js tests/core-remote-approvals.test.js tests/desktop-bridge-dispatcher.test.js tests/desktop-bridge-protocol.test.js tests/desktop-bridge-service.test.js tests/desktop-export.test.js tests/desktop-import.test.js tests/executor-adapter-provider.test.js tests/fleet-core-seams.test.js tests/fleet-delegate.test.js tests/models-core-profiles.test.js tests/models-core.test.js tests/models-headless.test.js tests/models-king-louie.test.js tests/playbooks-core.test.js tests/service-run.test.js tests/standalone-host.test.js tests/tool-secret-paths.test.js
```

Expected: PASS, `# fail 0`. An `EPERM`/`EBUSY` from `rmSync` means a cleanup block still lacks `closeOpenHistoryStores()`. A failure that compares messages or chats with `deepStrictEqual` and trips on the new `seq` (messages) or `messageCount`/`preview`/`lastMessageAt` (listed chats) is fixed in the test by comparing without those fields, e.g. `messages.map(({ seq, ...m }) => m)`.

- [ ] **Step 8: Commit**

```bash
git add -A src/core/create-core.js src/service/cli.js src/history tests
git commit -m "feat(history): createCore opens history.sqlite, moves chats out of chat-data.json, reports a store that will not open"
```

---

## Task 8: IPC handlers use explicit store calls

**Files:**
- Modify: `src/ipc/chat-handlers.js` (`chatMetadata` at line 31; the destructuring at lines 62-93; the helpers at lines 103-149; `autoNameChat` at line 191; the `CHAT_LOAD`, `CHAT_GET`, `CHAT_CREATE`, `CHAT_DELETE`, `CHAT_TRUNCATE_FROM` handlers)
- Modify: `src/ipc/canvas-handlers.js:4-31`, `src/ipc/case-handlers.js:27-48`, `src/ipc/workflow-handlers.js:10-20,195`
- Test: `tests/chat-history-get.test.js` (rewritten), `tests/canvas-handlers.test.js`, `tests/cases-chat.test.js`, `tests/cases-detour-hooks.test.js`, `tests/cases-detour-ipc.test.js`, `tests/cases-ipc.test.js`, `tests/playbooks-ipc.test.js`, `tests/helpers/chat-harness.js`

**Interfaces:**
- Consumes: the context from Task 7 (`listChats`, `getChat`, `createChat`, `deleteChat`, `updateChat`, `truncateChatFrom`, `getHistoryStatus`, `getActiveChatId`, `setActiveChatId`); `historyContext` (Task 6) in tests.
- Produces:
  - `chat:load` → `{ chats, activeChatId, history }`: `chats` is every chat's metadata from `listChats({ messages: false })` (with `messageCount`, `userMessageCount`, `assistantMessageCount`, `preview`, `lastMessageText`, `lastMessageAt`), and the active chat also carries its `messages`; `activeChatId` is the stored one when it names a listed chat, else the first chat's id, else `null`; `history` is `getHistoryStatus()` (or `{ available: true, error: null, migrationFailed: 0 }` when the context has none). With `history.available === false`: `{ chats: [], activeChatId: null, history }`.
  - `chat:delete` → the same shape as `chat:load`, after moving the active id to the first remaining chat when the deleted chat was active.
  - `chat:truncateFrom({ chatId, fromIndex })` keeps its payload: `fromIndex` is the array index (an integer, `0 ≤ fromIndex < messages.length`, else `Invalid fromIndex`), and it calls `truncateChatFrom(chatId, fromIndex + 1)` (seq is dense from 1).
  - `chat:updated` events carry `{ chats: listChats({ messages: false }) }`.
  - No handler in these four files reads `getChats` or `setChats`.

- [ ] **Step 1: Rewrite `tests/chat-history-get.test.js` against a real store**

Replace the whole file with:

```js
// tests/chat-history-get.test.js
// chat:load gives every chat's metadata plus the active chat's messages;
// chat:get gives one chat; mutations go straight to the history store
// (recall spec §4.4).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { historyContext } = require('./helpers/history-context');

const msg = (id, sender, text, timestamp = '2026-09-29T12:00:00.000Z') => ({ id, sender, text, timestamp });
const withoutSeq = (messages) => messages.map(({ seq: _seq, ...m }) => m);

function setup(chats = [], activeChatId = chats[0]?.id || null, overrides = {}) {
  const handlers = new Map();
  const history = historyContext(chats);
  const state = { activeChatId };
  const context = new Proxy({
    ...history,
    getActiveChatId: () => state.activeChatId,
    setActiveChatId: (id) => { state.activeChatId = id; },
    createId: () => `id-${Math.random().toString(16).slice(2)}`,
    getSettings: () => ({}),
    ...overrides
  }, { get: (target, key) => (key in target ? target[key] : () => null) });
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { invoke, history, state };
}

const ACTIVE = { id: 'chat-active', title: 'Active', messages: [msg('m1', 'assistant', 'Ready')] };
const INACTIVE = {
  id: 'chat-old',
  title: 'Old',
  messages: [msg('m2', 'user', 'old user text', '2026-09-28T12:00:00.000Z'), msg('m3', 'assistant', 'old assistant text', '2026-09-28T12:01:00.000Z')]
};

describe('chat history IPC', () => {
  it('loads the active chat with messages and the others as metadata only', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE], ACTIVE.id);
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.activeChatId, ACTIVE.id);
    assert.deepStrictEqual(withoutSeq(data.chats[0].messages), ACTIVE.messages);
    assert.strictEqual(data.chats[0].messageCount, 1);
    assert.strictEqual(data.chats[1].messages, undefined);
    assert.strictEqual(data.chats[1].messageCount, 2);
    assert.strictEqual(data.chats[1].userMessageCount, 1);
    assert.strictEqual(data.chats[1].assistantMessageCount, 1);
    assert.strictEqual(data.chats[1].preview, 'old assistant text');
    assert.strictEqual(data.chats[1].lastMessageAt, '2026-09-28T12:01:00.000Z');
    assert.deepStrictEqual(data.history, { available: true, error: null, migrationFailed: 0 });
  });

  it('opens the first chat when the stored active id names no chat (review focus 3)', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE], 'deleted-long-ago');
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.activeChatId, ACTIVE.id);
    assert.ok(Array.isArray(data.chats[0].messages));
  });

  it('answers with no chats, and says why, when the history store did not open', async () => {
    const history = { available: false, error: 'file is not a database', migrationFailed: 0 };
    const { invoke } = setup([ACTIVE], ACTIVE.id, { getHistoryStatus: () => history });
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.deepStrictEqual(data, { chats: [], activeChatId: null, history });
  });

  it('passes the number of chats left behind by the migration to the renderer', async () => {
    const { invoke } = setup([ACTIVE], ACTIVE.id, { getHistoryStatus: () => ({ available: true, error: null, migrationFailed: 2 }) });
    const { data } = await invoke(IPC.CHAT_LOAD);
    assert.strictEqual(data.history.migrationFailed, 2);
    assert.strictEqual(data.chats.length, 1);
  });

  it('returns a single chat with its messages by id, and reports a missing one', async () => {
    const { invoke } = setup([ACTIVE, INACTIVE]);
    const result = await invoke(IPC.CHAT_GET, { chatId: INACTIVE.id });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.chat.messages.map((m) => m.seq), [1, 2]);
    assert.deepStrictEqual(withoutSeq(result.chat.messages), INACTIVE.messages);
    assert.deepStrictEqual(await invoke(IPC.CHAT_GET, { chatId: 'missing' }), { ok: false, error: 'Chat not found.' });
  });

  it('persists renames and mode toggles, returning the chat with its messages', async () => {
    const { invoke, history } = setup([ACTIVE]);
    const renamed = await invoke(IPC.CHAT_RENAME, { chatId: ACTIVE.id, name: 'New name' });
    const agentMode = await invoke(IPC.CHAT_SET_AGENT_MODE, { chatId: ACTIVE.id, agentMode: true });
    assert.strictEqual(renamed.data.title, 'New name');
    assert.strictEqual(renamed.data.messages.length, 1);
    assert.strictEqual(agentMode.data.agentMode, true);
    assert.deepStrictEqual(history.getChat(ACTIVE.id, { messages: false }).title, 'New name');
  });

  it('creates a chat at the front and makes it active; deleting it moves to the first chat, with messages', async () => {
    const { invoke, state } = setup([ACTIVE, INACTIVE], ACTIVE.id);
    const created = await invoke(IPC.CHAT_CREATE, 'Fresh chat');
    assert.strictEqual(state.activeChatId, created.data.id);
    const listed = (await invoke(IPC.CHAT_LOAD)).data.chats.map((c) => c.id);
    assert.deepStrictEqual(listed, [created.data.id, ACTIVE.id, INACTIVE.id]);
    const deleted = await invoke(IPC.CHAT_DELETE, created.data.id);
    assert.strictEqual(deleted.data.activeChatId, ACTIVE.id);
    assert.deepStrictEqual(deleted.data.chats.map((c) => c.id), [ACTIVE.id, INACTIVE.id]);
    assert.ok(Array.isArray(deleted.data.chats[0].messages));
    assert.strictEqual(deleted.data.chats[1].messages, undefined);
  });

  it('truncates from an array index through seq and keeps seq dense', async () => {
    const chat = { id: 'chat-1', title: 'Chat', messages: [msg('m1', 'user', 'one'), msg('m2', 'assistant', 'two'), msg('m3', 'user', 'three')] };
    const { invoke, history } = setup([chat]);
    const result = await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 2 });
    assert.deepStrictEqual(result.data.messages.map((m) => [m.seq, m.text]), [[1, 'one'], [2, 'two']]);
    assert.deepStrictEqual(history.getMessages('chat-1').map((m) => m.id), ['m1', 'm2']);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 2 })).ok, false);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'chat-1', fromIndex: 0.5 })).ok, false);
    assert.strictEqual((await invoke(IPC.CHAT_TRUNCATE_FROM, { chatId: 'missing', fromIndex: 0 })).ok, false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/chat-history-get.test.js`
Expected: FAIL — `data.history` is undefined, the stale-active test gets `activeChatId: 'deleted-long-ago'`, and inactive chats report `messageCount: 0` (today's `chatMetadata` recounts a chat that has no `messages`).

- [ ] **Step 3: Change `src/ipc/chat-handlers.js`**

Make `chatMetadata` (line 31) keep a listed chat's stored counts. Insert as its first statement:

```js
  // A chat from listChats carries its counts and preview already.
  if (!Array.isArray(chat.messages)) {
    const { messages: _messages, ...metadata } = chat;
    return metadata;
  }
```

In the `registerChatHandlers` destructuring (lines 62-93), delete `getChats,` and `setChats,` and add `updateChat,`, `truncateChatFrom,` and `getHistoryStatus,`.

Replace lines 103-149 (from `const fullChats = () => getChats();` through the end of `removeChat`) with:

```js
  const findChat = (chatId, options = { messages: true }) => {
    const id = String(chatId || '').trim();
    return id ? getChat(id, options) : null;
  };

  const patchChat = (chatId, patch = {}) => {
    const id = String(chatId || '').trim();
    return id ? updateChat(id, patch) : null;
  };

  const DEFAULT_HISTORY_STATUS = Object.freeze({ available: true, error: null, migrationFailed: 0 });
  const historyStatus = () => (typeof getHistoryStatus === 'function' && getHistoryStatus()) || DEFAULT_HISTORY_STATUS;

  // What chat:load and chat:delete answer (recall spec §4.4): every chat's
  // metadata, and the messages of the active chat only. A stored active id
  // that names no chat (deleted, or left in chat-data.json by a failed
  // migration) falls back to the first chat. A history store that did not
  // open answers with no chats and says why; chats are never read from
  // chat-data.json instead (§15).
  const chatListPayload = () => {
    const history = historyStatus();
    if (!history.available) return { chats: [], activeChatId: null, history };
    const metas = listChats({ messages: false });
    const storedActiveId = getActiveChatId();
    const activeChatId = metas.some((chat) => chat.id === storedActiveId) ? storedActiveId : (metas[0]?.id || null);
    const activeChat = activeChatId ? getChat(activeChatId, { messages: true }) : null;
    return {
      chats: metas.map((chat) => (activeChat && chat.id === activeChat.id
        ? chatMetadata(activeChat, { includeMessages: true })
        : chatMetadata(chat))),
      activeChatId,
      history
    };
  };
```

In `autoNameChat`, replace `const updated = fullChats();` with:

```js
      const updated = listChats({ messages: false });
```

Replace the body of the `CHAT_LOAD` handler with `return chatListPayload();`, and the body of the `CHAT_GET` handler with:

```js
    const id = String(chatId || '').trim();
    if (!id) {
      return { ok: false, error: 'Chat ID is required.' };
    }
    const chat = getChat(id, { messages: true });
    if (!chat) {
      return { ok: false, error: 'Chat not found.' };
    }
    return { ok: true, chat };
```

In `CHAT_CREATE`, replace `prependChat(newChat);` with `createChat(newChat, { position: 'front' });`.

Replace the body of `CHAT_DELETE` with:

```js
    deleteChat(chatId);
    if (getActiveChatId() === chatId) {
      setActiveChatId(listChats({ messages: false })[0]?.id || null);
    }
    return chatListPayload();
```

Replace the body of `CHAT_TRUNCATE_FROM` with:

```js
    const chat = findChat(chatId, { messages: true });
    if (!chat) throw new Error('Chat not found');
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= chat.messages.length) {
      throw new Error('Invalid fromIndex');
    }
    // seq is dense from 1: the message at index i has seq i + 1.
    return truncateChatFrom(chat.id, fromIndex + 1);
```

- [ ] **Step 4: Change the canvas, case and workflow handlers**

`src/ipc/canvas-handlers.js`: replace lines 5-31 (from `const { getChats, setChats } = context;` through the end of `patchChat`) with:

```js
  // Canvas state is a chat field; none of these calls needs the messages.
  const findChat = (chatId) => context.getChat(chatId, { messages: false });
  const patchChat = (chatId, patch = {}) => context.updateChat(chatId, patch, { messages: false });
```

`src/ipc/case-handlers.js`: replace `chatById` and `patchChat` (lines 27-48) with:

```js
  const chatById = (chatId) => context.getChat(chatId, { messages: true });
  // The renderer replaces its chat with what attach returns, so it keeps
  // the messages.
  const patchChat = (chatId, patch = {}) => context.updateChat(chatId, patch);
```

`src/ipc/workflow-handlers.js`: replace `findChat` (lines 10-20) with:

```js
  const findChat = (chatId) => (chatId ? context.getChat(chatId, { messages: true }) : null);
```

and line 195 with:

```js
      if (typeof context.getChat !== 'function') throw new Error('Chat storage not available');
```

- [ ] **Step 5: Move the handler tests' contexts onto the store**

In `tests/canvas-handlers.test.js`, `tests/cases-ipc.test.js`, `tests/cases-detour-ipc.test.js` and `tests/playbooks-ipc.test.js`, which build a context from an array of chats:

1. Add `const { historyContext } = require('./helpers/history-context');`.
2. Replace the `getChats`/`setChats` pair, and the whole `if (facade) { … }` block that adds `getChat`/`updateChat` fakes, with `...history` where `const history = historyContext(initialChats);` (the `facade` option goes away: the store is always there).
3. Replace every read of the local array (`store.chats.find((c) => c.id === X)`, `chats.find(...)`) with `history.getChat(X)`, and return `history` from `setup` where the array was returned.
4. Delete assertions on recorded facade calls (`context.calls`); keep each test's behavioural assertion by reading the chat back through `history.getChat`.

For example, `tests/canvas-handlers.test.js`'s `setup` becomes:

```js
const { historyContext } = require('./helpers/history-context');

function setup(chats) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const history = historyContext(chats.map((c) => ({ title: c.id, messages: [], ...c })));
  registerCanvasHandlers(ipcMain, history);
  return { handlers, history };
}
```

and an assertion such as `assert.strictEqual(store.chats.find((c) => c.id === 'c1').canvasState, null)` becomes `assert.strictEqual(history.getChat('c1', { messages: false }).canvasState, null)`.

In `tests/cases-chat.test.js`, `tests/cases-detour-hooks.test.js` and `tests/helpers/chat-harness.js`, which fake a single chat object, replace the `getChats`/`setChats` pair with:

```js
    getChat: (id) => (id === theChat.id ? theChat : null),
    listChats: () => [theChat],
    updateChat: (id, patch) => (id === theChat.id ? Object.assign(theChat, patch) : null),
```

(the object is called `chat` in the two cases tests).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/chat-history-get.test.js tests/canvas-handlers.test.js tests/cases-chat.test.js tests/cases-detour-hooks.test.js tests/cases-detour-ipc.test.js tests/cases-ipc.test.js tests/playbooks-ipc.test.js tests/chat-stop.test.js tests/chat-usability.test.js tests/chat-roles.test.js tests/chat-defaults.test.js tests/channel-local-chat-origin.test.js tests/mcp-per-chat-filter.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/chat-handlers.js src/ipc/canvas-handlers.js src/ipc/case-handlers.js src/ipc/workflow-handlers.js tests
git commit -m "feat(history): chat IPC reads and writes the history store directly; chat:load says when history is unavailable"
```

---

## Task 9: getChats and setChats are gone

**Files:**
- Modify: `src/core/model-choices.js:15-69,139,160`
- Modify: `src/migration/desktop-import.js:479,778,784-817`
- Modify: `src/core/create-core.js` (the Task 7 wrappers, `migrateLegacyBridgeChatOrigins`, the two bridges' `createLocalChat`/`addMessageToLocalChat` at lines 1366-1393 and 1436-1465, the canvas tool's `updateChat` calls at lines 2164 and 2172, the `createModelChoices` call at line 3110, `context`)
- Test: `tests/history-no-legacy-chat-helpers.test.js` (new); `tests/core-create.test.js`, `tests/chat-profiles.test.js`, `tests/desktop-bridge-dispatcher.test.js`, `tests/desktop-import.test.js`, `tests/model-choices.test.js`, `tests/models-core-profiles.test.js`, `tests/models-custom-roles.test.js`, `tests/models-king-louie.test.js`, `tests/playbooks-ipc.test.js`

**Interfaces:**
- Consumes: Task 7's context functions.
- Produces:
  - `createModelChoices({ profiles, catalog, availability, explainTarget, snapshotModels, listChats, getChat, updateChat, appendMessageToChat, getCaseRuntime, kingLouie, getSettings })`; it throws when `listChats`, `getChat`, `updateChat` or `appendMessageToChat` is missing. `setChatProfile` and `setMainOverride` still return the chat with its messages.
  - `DesktopImporter` reads live chats with `context.listChats({ messages: true })` and writes with `context.upsertChat(chat, { position: 'front' })` only.
  - `core.context` has no `getChats` or `setChats`; `migrateLegacyBridgeChatOrigins` reads metadata and loads messages only for a matching chat.
  - `tests/history-no-legacy-chat-helpers.test.js` fails if any file under `src/` calls `getChats(` or `setChats(`.

- [ ] **Step 1: Write the failing guard test**

Create `tests/history-no-legacy-chat-helpers.test.js`:

```js
// tests/history-no-legacy-chat-helpers.test.js
// getChats()/setChats() loaded or rewrote every chat at once. They were
// removed in history stage H1 (recall spec §4.4); chats are reached through
// explicit store calls. Keep them out of src/.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('no whole-collection chat helpers', () => {
  it('no file under src/ calls getChats( or setChats(', () => {
    const offenders = walk(SRC)
      .filter((file) => /\b(getChats|setChats)\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    assert.deepStrictEqual(offenders, []);
  });

  it('the old chat stores are deleted', () => {
    for (const name of ['chat-history-store.js', 'sqlite-chat-history-store.js']) {
      assert.ok(!fs.existsSync(path.join(SRC, 'history', name)), `${name} is still there`);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/history-no-legacy-chat-helpers.test.js`
Expected: FAIL listing `core/create-core.js`, `core/model-choices.js`, `migration/desktop-import.js`.

- [ ] **Step 3: `src/core/model-choices.js`**

Replace the parameter list and the helpers down to the local `updateChat` (lines 15-69) with:

```js
function createModelChoices({
  profiles,
  catalog = null,
  availability = null,
  explainTarget,
  snapshotModels,
  listChats,
  getChat,
  updateChat: updateChatFacade,
  appendMessageToChat,
  getCaseRuntime = () => null,
  kingLouie = null,
  getSettings = () => ({})
} = {}) {
  for (const [name, value] of Object.entries({ profiles, explainTarget, snapshotModels, listChats, getChat, updateChat: updateChatFacade, appendMessageToChat })) {
    if (!value) throw new Error(`createModelChoices needs ${name}.`);
  }

  // Decisions read a chat without its messages; what goes back to the
  // renderer carries them, since the renderer replaces its copy with it.
  const findChat = (chatId, { messages = false } = {}) => {
    const chat = getChat(chatId, { messages });
    if (!chat) throw new Error('Chat not found.');
    return chat;
  };
  const chatMetas = () => listChats({ messages: false });
  const nameOf = (target) => {
    if (!target) return '(none)';
    const entry = catalog ? catalog.get(target.provider, target.model) : null;
    return entry?.name || target.model;
  };
  const status = (chatId, text) => appendMessageToChat(chatId, 'status', text);
  const updateChat = (chatId, patch) => updateChatFacade(chatId, { ...patch, updatedAt: new Date().toISOString() }, { messages: false });
```

Change `return findChat(chatId);` at the end of `setChatProfile` (line 139) and of `setMainOverride` (line 160) to:

```js
    return findChat(chatId, { messages: true });
```

- [ ] **Step 4: `src/migration/desktop-import.js`**

Line 479: `const chats = this.context.getChats();` becomes:

```js
    const chats = this.context.listChats({ messages: true });
```

Line 778: `this.context.getChats()` becomes `this.context.listChats({ messages: true })`.

Replace lines 784-817 (from the comment above `const check = await this.checkPath(...)` through the end of the write chain) so that the comments name the store and the write is a single upsert:

```js
    if (chat.workingDirectory) {
      // This await is exactly where fix round 2 found the gap: liveChats
      // read before it can go stale by the time the upsert below runs, so
      // whatever changed the service's chats during this call — another
      // apply(), a live chat edit — would be silently overwritten by a
      // write built from a snapshot taken before the wait.
      const check = await this.checkPath(chat.workingDirectory);
      if (!check.readable || !check.isDirectory) {
        note = `the service cannot read the working directory ${chat.workingDirectory}; it was dropped`;
        chat.workingDirectory = null;
      }
    }
    chat = item.action === 'copy'
      ? { ...chat, id: item.targetKey, title: `${chat.title || 'Chat'}${COPY_SUFFIX}` }
      : { ...chat, id: item.targetKey };

    // Read live state again immediately before writing, with no await
    // between this read and the upsert, and re-run the same check against
    // it (fix round 2, I4): this is the read the upsert below acts on, so
    // it — and the presence/updatedAt decision — must be fresh.
    const liveChats = this.context.listChats({ messages: true });
    const late = this.chatRaceCheck(plan, item, value, liveChats);
    if (late) return late;
    // A copy keeps the source's message ids; the history store gives any id
    // it already holds a fresh one.
    this.context.upsertChat(chat, { position: 'front' });
```

(The `return { note, attention, record }` after it is unchanged.)

- [ ] **Step 5: `src/core/create-core.js`**

Delete the Task 7 `getChats`/`setChats` wrappers (the comment "Transitional (H1 Tasks 7 to 9)" and the two constants).

Replace `migrateLegacyBridgeChatOrigins`'s body with:

```js
  const migrateLegacyBridgeChatOrigins = () => {
    if (!historyStatus.available) return;
    let count = 0;
    for (const meta of listChats({ messages: false })) {
      if (meta.origin || typeof meta.title !== 'string') continue;
      const match = LEGACY_BRIDGE_TITLE_PREFIXES.find(({ prefix }) => meta.title.startsWith(prefix));
      if (!match) continue;
      count += 1;
      const chat = getChat(meta.id, { messages: true });
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      updateChat(meta.id, {
        origin: match.origin,
        messages: messages.map((m) => (m && m.sender === 'user' && !m.channel ? { ...m, channel: match.origin } : m))
      }, { messages: false });
    }
    if (count) {
      log.info(`Tagged ${count} legacy bridge chat(s) by title prefix (F5 migration).`);
    }
  };
```

In both bridges (Discord at lines 1366-1393, Telegram at 1436-1465), `createLocalChat` ends with:

```js
        createChat(newChat);
        ui.send('chat:updated', { chats: listChats({ messages: false }) });

        return newChat.id;
```

and `addMessageToLocalChat` sends `ui.send('chat:updated', { chats: listChats({ messages: false }) });`.

At lines 2164 and 2172 (the canvas tool), pass `{ messages: false }` as the third argument of `updateChat`.

In the `createModelChoices({ … })` call (line 3110), replace the chat entries (`getChats`, `listChats`, `setChats`, `createChat`, `replaceChat`, `deleteChat`, `getChat`, `updateChat`, `appendMessageToChat`) with:

```js
    listChats,
    getChat,
    updateChat,
    appendMessageToChat,
```

In `context`, delete `getChats,` and `setChats,`.

- [ ] **Step 6: Move the remaining tests off getChats/setChats**

Core-level tests (`tests/core-create.test.js`, `tests/chat-profiles.test.js`, `tests/desktop-bridge-dispatcher.test.js`, `tests/desktop-import.test.js`, `tests/models-core-profiles.test.js`, `tests/playbooks-ipc.test.js`) rewrite each use by this table:

| Before | After |
|---|---|
| `core.context.setChats([a, b])` on an empty core | `core.context.createChat(a, { position: 'back' }); core.context.createChat(b, { position: 'back' });` |
| `core.context.setChats([...core.context.getChats(), c])` | `core.context.upsertChat(c, { position: 'back' })` |
| `core.context.setChats([x])` on a core that already has chats, meant to add or overwrite `x` (the desktop-import race tests) | `core.context.upsertChat(x, { position: 'front' })` |
| `core.context.setChats(core.context.getChats().map((x) => (x.id === 'c1' ? { ...x, …patch } : x)))` | `core.context.updateChat('c1', { …patch })` |
| `core.context.getChats().find((c) => c.id === X)` | `core.context.getChat(X)` |
| `core.context.getChats().some((c) => c.id === X)` | `Boolean(core.context.getChat(X, { messages: false }))` |
| `core.context.getChats()` (the whole list) | `core.context.listChats({ messages: true })` |
| `JSON.stringify(core.context.getChats())` | `JSON.stringify(core.context.listChats({ messages: true }))` |
| `assert.strictEqual(typeof core.context.getChats, 'function')` | `assert.strictEqual(core.context.getChats, undefined)` |

In `tests/core-create.test.js`, the test "appendMessageToChat generates id/timestamp itself…" starts with `core.context.createChat({ id: 'chat-1', title: 'Chat', messages: [] });`.

In `tests/model-choices.test.js`, `setup` passes these instead of `getChats`, `setChats` and the `facade ? { … } : {}` block (the `facade` option goes away):

```js
    listChats: (options = {}) => {
      facadeCalls.push({ method: 'listChats', options });
      return options.messages === false ? store.map(({ messages: _messages, ...meta }) => meta) : store;
    },
    getChat: (chatId, options = {}) => {
      facadeCalls.push({ method: 'getChat', chatId, options });
      const chat = store.find((c) => c.id === chatId) || null;
      if (!chat || options.messages !== false) return chat;
      const { messages: _messages, ...meta } = chat;
      return meta;
    },
    updateChat: (chatId, patch, options = {}) => {
      facadeCalls.push({ method: 'updateChat', chatId, patch, options });
      store = store.map((c) => (c.id === chatId ? { ...c, ...patch } : c));
      return store.find((c) => c.id === chatId) || null;
    },
```

and the assertion `assert.ok(!facadeCalls.some((call) => call.method === 'getChats'), …)` is deleted. A test that expected a cleared field to be absent (the old fallback deleted `null` keys) now expects `null`: `assert.strictEqual(chat.profileId ?? null, null)`.

In `tests/models-custom-roles.test.js` and `tests/models-king-louie.test.js`, replace `getChats: () => [], setChats: () => {},` with:

```js
    listChats: () => [],
    getChat: () => null,
    updateChat: () => null,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/history-no-legacy-chat-helpers.test.js tests/core-create.test.js tests/chat-profiles.test.js tests/desktop-bridge-dispatcher.test.js tests/desktop-import.test.js tests/model-choices.test.js tests/models-core-profiles.test.js tests/models-custom-roles.test.js tests/models-king-louie.test.js tests/playbooks-ipc.test.js tests/channel-local-chat-origin.test.js tests/history-core.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/core/model-choices.js src/migration/desktop-import.js src/core/create-core.js tests
git commit -m "refactor(history): remove getChats/setChats; every call site uses explicit store calls"
```

---

## Task 10: The renderer keeps only the active chat's messages

**Files:**
- Modify: `renderer.js` (after `ensureChatMessagesLoaded` at line 1648; `refreshUI` at line 3268; `renderChatList` at line 1731; `loadChats` at line 8422; `handleDeleteChat` at line 8512; the five local pushes at lines 1397-1401, 5367-5376, 5390-5398, 5721-5722 and 5813-5822)
- Modify: `styles.css` (one rule)
- Test: `tests/renderer-history-lazy.test.js`

**Interfaces:**
- Consumes: `chat:load`'s `{ chats, activeChatId, history }` (Task 8); the existing `ensureChatMessagesLoaded(chatId)` and `showNotice(text)`.
- Produces (renderer globals):
  - `dropInactiveChatMessages(chats, activeChatId)`: for every chat other than the active one that holds a `messages` array, records `messageCount`, `userMessageCount`, `assistantMessageCount`, `preview`, `lastMessageText` and `lastMessageAt` from it (the same rules as the store's listing) and deletes `messages`. Called first thing in `refreshUI()`.
  - `pushLoadedMessage(chat, message)`: pushes only into a chat whose `messages` is already an array.
  - `historyNoticeText(history) → string|null`: `'Chats are unavailable: <error>. See the log.'` when `history.available === false`; `'<n> chat(s) could not be migrated; see log'` (`'1 chat could not…'`, `'3 chats could not…'`) when `history.migrationFailed > 0`; else `null`.
  - `appState.historyStatus` (the last `chat:load`'s `history`) and `appState.historyNoticeShown`.

The renderer's existing lazy loading (the 2026-09-29 compatibility slice) fetches a chat's messages with `chat:get` only when they are missing, but it never drops them again: every chat the owner visits, and any full chat an IPC reply hands back (rename, send, attach), stays in memory for the session. This task adds the drop.

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer-history-lazy.test.js`:

```js
// tests/renderer-history-lazy.test.js
// The renderer holds only the active chat's messages (recall spec §4.4) and
// says when chat history is unavailable or partly migrated (§11.1, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `renderer.js defines ${name}`);
  const end = src.indexOf('\n}\n', start);
  return new Function(`${src.slice(start, end + 2)}\nreturn ${name};`)();
}
function body(name) {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf('\n}\n', start));
}

describe('renderer: only the active chat keeps its messages', () => {
  const dropInactiveChatMessages = fn('dropInactiveChatMessages');

  it('drops an inactive chat\'s messages and keeps what the sidebar shows', () => {
    const chats = [
      { id: 'a', title: 'Active', messages: [{ id: 'm1', sender: 'user', text: 'hi' }] },
      {
        id: 'b', title: 'Left behind', messages: [
          { id: 'm2', sender: 'user', text: 'blue folder', timestamp: '2026-09-29T10:00:00.000Z' },
          { id: 'm3', sender: 'assistant', text: 'noted', timestamp: '2026-09-29T10:01:00.000Z' },
          { id: 'm4', sender: 'status', text: 'Main model switched', timestamp: '2026-09-29T10:02:00.000Z' }
        ]
      },
      { id: 'c', title: 'Never loaded', preview: 'from chat:load', messageCount: 9 }
    ];
    dropInactiveChatMessages(chats, 'a');
    assert.strictEqual(chats[0].messages.length, 1);
    assert.strictEqual(chats[1].messages, undefined);
    assert.deepStrictEqual(
      [chats[1].messageCount, chats[1].userMessageCount, chats[1].assistantMessageCount, chats[1].preview, chats[1].lastMessageText, chats[1].lastMessageAt],
      [3, 1, 1, 'noted', 'noted', '2026-09-29T10:01:00.000Z']
    );
    assert.deepStrictEqual(chats[2], { id: 'c', title: 'Never loaded', preview: 'from chat:load', messageCount: 9 });
  });

  it('runs on every refresh', () => {
    assert.match(body('refreshUI'), /dropInactiveChatMessages\(appState\.chats, appState\.activeChatId\)/);
  });
});

describe('renderer: local messages never fake a loaded chat (review focus 4)', () => {
  const pushLoadedMessage = fn('pushLoadedMessage');

  it('pushes into a loaded chat and leaves an unloaded one unloaded', () => {
    const loaded = { id: 'a', messages: [] };
    const unloaded = { id: 'b', messageCount: 40 };
    pushLoadedMessage(loaded, { id: 's1', sender: 'status', text: 'x' });
    pushLoadedMessage(unloaded, { id: 's2', sender: 'status', text: 'y' });
    pushLoadedMessage(null, { id: 's3' });
    assert.strictEqual(loaded.messages.length, 1);
    assert.strictEqual(unloaded.messages, undefined);
  });

  it('has no "x.messages = x.messages || []" left that would create a partial list', () => {
    assert.doesNotMatch(src, /\.messages = (\w+)\.messages \|\| \[\]/);
  });
});

describe('renderer: history notices', () => {
  const historyNoticeText = fn('historyNoticeText');

  it('names why chats are unavailable and how many chats did not migrate', () => {
    assert.strictEqual(historyNoticeText({ available: false, error: 'file is not a database' }), 'Chats are unavailable: file is not a database. See the log.');
    assert.strictEqual(historyNoticeText({ available: true, migrationFailed: 3 }), '3 chats could not be migrated; see log');
    assert.strictEqual(historyNoticeText({ available: true, migrationFailed: 1 }), '1 chat could not be migrated; see log');
    assert.strictEqual(historyNoticeText({ available: true, error: null, migrationFailed: 0 }), null);
    assert.strictEqual(historyNoticeText(null), null);
  });

  it('reads chat:load\'s history and shows the unavailable note in the chat list', () => {
    assert.match(body('loadChats'), /appState\.historyStatus = data\.history/);
    assert.match(body('renderChatList'), /chat-list-error/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/renderer-history-lazy.test.js`
Expected: FAIL with `renderer.js defines dropInactiveChatMessages`.

- [ ] **Step 3: Add the three helpers to `renderer.js`**

Insert after `ensureChatMessagesLoaded` (it ends at line 1662):

```js
// The renderer holds only the active chat's messages (recall spec §4.4);
// every other chat keeps the metadata the sidebar needs. Runs on every
// refresh, so a chat left behind by a switch, or a full chat an IPC reply
// handed back, drops its messages; selecting it again loads them through
// chat:get (ensureChatMessagesLoaded).
function dropInactiveChatMessages(chats, activeChatId) {
  for (const chat of chats) {
    if (!chat || chat.id === activeChatId || !Array.isArray(chat.messages)) continue;
    const messages = chat.messages;
    const visible = messages.filter((m) => m && (m.sender === 'user' || m.sender === 'assistant'));
    const last = visible[visible.length - 1] || messages[messages.length - 1] || null;
    chat.messageCount = messages.length;
    chat.userMessageCount = messages.filter((m) => m?.sender === 'user').length;
    chat.assistantMessageCount = messages.filter((m) => m?.sender === 'assistant').length;
    chat.preview = last?.text || '';
    chat.lastMessageText = last?.text || '';
    chat.lastMessageAt = last?.timestamp || null;
    delete chat.messages;
  }
}

// A message the renderer adds itself (a status line, a workflow goal) joins
// a chat's local list only when that list is loaded: pushing into an
// unloaded chat would make it look loaded with that one message. It is
// persisted through IPC either way.
function pushLoadedMessage(chat, message) {
  if (chat && Array.isArray(chat.messages)) chat.messages.push(message);
}

function historyNoticeText(history) {
  if (!history || typeof history !== 'object') return null;
  if (history.available === false) {
    return `Chats are unavailable: ${history.error || 'the history store did not open'}. See the log.`;
  }
  const failed = Number(history.migrationFailed) || 0;
  if (failed > 0) return `${failed} ${failed === 1 ? 'chat' : 'chats'} could not be migrated; see log`;
  return null;
}
```

- [ ] **Step 4: Call them**

`refreshUI` (line 3268) becomes:

```js
function refreshUI() {
  dropInactiveChatMessages(appState.chats, appState.activeChatId);
  renderChatList();
  renderChatMessages();
  updateEmptyState();
}
```

In `renderChatList` (line 1731), right after `dom.chatList.innerHTML = '';`, add:

```js
  if (appState.historyStatus?.available === false) {
    const note = document.createElement('div');
    note.className = 'chat-list-error';
    note.textContent = historyNoticeText(appState.historyStatus);
    dom.chatList.appendChild(note);
  }
```

In `loadChats` (line 8422), after `appState.chats = data.chats || [];`, add:

```js
  appState.historyStatus = data.history || null;
  const historyNotice = historyNoticeText(appState.historyStatus);
  if (historyNotice && appState.historyStatus.available !== false && !appState.historyNoticeShown) {
    appState.historyNoticeShown = true;
    showNotice(historyNotice);
  }
```

In `handleDeleteChat` (line 8512), after `appState.activeChatId = result.activeChatId || appState.chats[0]?.id || null;`, add:

```js
  await ensureChatMessagesLoaded(appState.activeChatId);
```

Replace the five local pushes (find them with `grep -n "messages = [a-zA-Z]*\.messages || \[\]" renderer.js`; the two `const messages = chat.messages || []` reads at lines 1666 and 8318 stay):

- `addStatusMessage` (lines 1397-1401): the `const chat = …; if (chat) { chat.messages = chat.messages || []; chat.messages.push(msg); }` block becomes `pushLoadedMessage(appState.chats.find((c) => c.id === chatId), msg);`
- the proposed plan (lines 5367-5376): `chatObj.messages = chatObj.messages || []; chatObj.messages.push({ … });` becomes `pushLoadedMessage(chatObj, { … });` (the `if (chatId === appState.activeChatId) addMessage(…)` after it stays).
- `appendStatusToChat` (lines 5390-5398): the `if (chat) { chat.messages = chat.messages || []; chat.messages.push({ … }); }` block becomes `pushLoadedMessage(chat, { … });` with the same object literal.
- the workflow goal (lines 5721-5722): `chat.messages = chat.messages || []; chat.messages.push(goalMsg);` becomes `pushLoadedMessage(chat, goalMsg);`
- the planner diagnostic (lines 5813-5822): `chatObj.messages = chatObj.messages || []; chatObj.messages.push({ … });` becomes `pushLoadedMessage(chatObj, { … });` (the `if (chatId === appState.activeChatId) renderChatMessages();` after it stays).

- [ ] **Step 5: Style the note in `styles.css`**

Append:

```css
/* History store unavailable (recall spec §15): shown at the top of the chat list. */
.chat-list-error {
  padding: 12px;
  font-size: 13px;
  line-height: 1.4;
  color: #c0392b;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/renderer-history-lazy.test.js tests/renderer-export-chat.test.js tests/renderer-models-text.test.js tests/renderer-models-m2.test.js tests/renderer-models-m3.test.js tests/renderer-playbooks-text.test.js tests/renderer-sources-text.test.js tests/renderer-approval-pattern.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add renderer.js styles.css tests/renderer-history-lazy.test.js
git commit -m "feat(ui): keep only the active chat's messages in memory; say when chat history is unavailable"
```

---

## Task 11: Desktop import reads chats from history.sqlite

Without this, `king-louie-service import --from <desktop profile>` and the desktop's own Import would carry only chats still left in `chat-data.json`, which after H1 is none: every migrated chat would silently stay behind.

**Files:**
- Create: `src/migration/desktop-history.js`
- Modify: `src/migration/desktop-source.js:180` (the `chats` line in `readDesktopSource`)
- Test: `tests/desktop-source-history.test.js`

**Interfaces:**
- Consumes: `HistoryStore`, `DERIVED_CHAT_KEYS` (Tasks 1 to 6); the safe reader's `readFile(relPath) → { ok, data: Buffer } | { ok: false, missing?, reason }` (`createSafeReader` in `src/migration/desktop-source.js`).
- Produces:
  - `readHistoryChats({ reader, tmpRoot = os.tmpdir() }) → { found: boolean, chats: Chat[], attention: Array<{ category: 'source', key, note }> }`: reads `history.sqlite` (and `history.sqlite-wal` when present) through `reader`, writes them into a private `mkdtemp` folder under `tmpRoot`, opens the copy, returns every chat with its messages in position order (no derived listing fields, no `seq`), and removes the folder. A missing file is `found: false` with no attention; an unreadable or unopenable one is an attention entry and no chats.
  - `readDesktopSource`'s chats: the history chats first, then `chat-data.json` chats whose ids the history does not have.

- [ ] **Step 1: Write the failing tests**

Create `tests/desktop-source-history.test.js`:

```js
// tests/desktop-source-history.test.js
// Desktop import reads a profile's chats from history.sqlite, through the
// safe reader and a private copy, plus any chats still in chat-data.json.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../src/history');
const { createSafeReader, readDesktopSource } = require('../src/migration/desktop-source');
const { readHistoryChats } = require('../src/migration/desktop-history');

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const msg = { id: 'm1', sender: 'user', text: 'the Lakeside lot', timestamp: '2026-09-20T10:00:00.000Z' };

describe('desktop import and history.sqlite', () => {
  it('reads chats from history.sqlite and the ones still in chat-data.json', () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'Moved', updatedAt: '2026-09-20T10:00:00.000Z', messages: [msg] });
    store.close();
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({
      chats: [{ id: 'left', title: 'Left behind', messages: [] }, { id: 'c1', title: 'Stale copy', messages: [] }]
    }));

    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });

    assert.deepStrictEqual(source.inventory.chats.map((c) => [c.id, c.title]), [['c1', 'Moved'], ['left', 'Left behind']]);
    const value = source.getValue('chat', 'c1');
    assert.deepStrictEqual(value.messages, [msg]);
    assert.strictEqual(value.messageCount, undefined);
    assert.deepStrictEqual(source.attention, []);
  });

  it('includes what is still in the WAL of a store that is open', () => {
    const root = tempDir('kl-desktop-');
    const live = HistoryStore.open(path.join(root, 'history.sqlite'));
    stores.push(live);
    live.createChat({ id: 'fresh', title: 'Not checkpointed', messages: [msg] });
    const { chats, attention } = readHistoryChats({ reader: createSafeReader({ root }), tmpRoot: tempDir('kl-copy-') });
    assert.deepStrictEqual(chats.map((c) => c.id), ['fresh']);
    assert.deepStrictEqual(attention, []);
  });

  it('removes its private copy', () => {
    const root = tempDir('kl-desktop-');
    const store = HistoryStore.open(path.join(root, 'history.sqlite'));
    store.createChat({ id: 'c1', title: 'One', messages: [] });
    store.close();
    const tmpRoot = tempDir('kl-copy-');
    readHistoryChats({ reader: createSafeReader({ root }), tmpRoot });
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
  });

  it('reports an unreadable history.sqlite and still reads chat-data.json', () => {
    const root = tempDir('kl-desktop-');
    fs.writeFileSync(path.join(root, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [{ id: 'left', title: 'Left behind', messages: [] }] }));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.deepStrictEqual(source.inventory.chats.map((c) => c.id), ['left']);
    assert.strictEqual(source.attention.length, 1);
    assert.strictEqual(source.attention[0].key, 'history.sqlite');
    assert.match(source.attention[0].note, /could not be read/);
  });

  it('reads chat-data.json alone for a profile that never had history.sqlite', () => {
    const root = tempDir('kl-desktop-');
    fs.writeFileSync(path.join(root, 'chat-data.json'), JSON.stringify({ chats: [{ id: 'old', title: 'Old', messages: [] }] }));
    const source = readDesktopSource({ userDataDir: root, reader: createSafeReader({ root }), secrets: 'needs-desktop' });
    assert.deepStrictEqual(source.inventory.chats.map((c) => c.id), ['old']);
    assert.deepStrictEqual(source.attention, []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/desktop-source-history.test.js`
Expected: FAIL with `Cannot find module '../src/migration/desktop-history'`.

- [ ] **Step 3: Write `src/migration/desktop-history.js`**

```js
// src/migration/desktop-history.js
// Desktop import (fleet stage 7 §3.8) reads a profile's chats from its
// history.sqlite (recall spec stage H1). The file is read through the same
// safe reader as every other profile file, copied with its WAL into a
// private temp folder, and opened there: the profile's own file is never
// opened by path (the reader may run as root over a user-owned tree). A copy
// taken while the desktop app is writing can be unreadable or a little
// stale; unreadable is reported, and closing the app and importing again
// reads it whole.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, DERIVED_CHAT_KEYS } = require('../history');

function forImport(chat) {
  const out = { ...chat };
  for (const key of DERIVED_CHAT_KEYS) delete out[key];
  out.messages = (chat.messages || []).map(({ seq: _seq, ...message }) => message);
  return out;
}

function readHistoryChats({ reader, tmpRoot = os.tmpdir() }) {
  const attention = [];
  const main = reader.readFile('history.sqlite');
  if (!main.ok) {
    if (!main.missing) attention.push({ category: 'source', key: 'history.sqlite', note: main.reason });
    return { found: false, chats: [], attention };
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'kl-import-history-'));
  let store = null;
  try {
    const file = path.join(dir, 'history.sqlite');
    fs.writeFileSync(file, main.data, { mode: 0o600 });
    const wal = reader.readFile('history.sqlite-wal');
    if (wal.ok) fs.writeFileSync(`${file}-wal`, wal.data, { mode: 0o600 });
    else if (!wal.missing) attention.push({ category: 'source', key: 'history.sqlite-wal', note: wal.reason });
    store = HistoryStore.open(file);
    return { found: true, chats: store.listChats({ messages: true }).map(forImport), attention };
  } catch (err) {
    attention.push({
      category: 'source',
      key: 'history.sqlite',
      note: `could not be read (${err.message}); close King Louie on the desktop and import again`
    });
    return { found: true, chats: [], attention };
  } finally {
    if (store) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readHistoryChats };
```

- [ ] **Step 4: Use it in `src/migration/desktop-source.js`**

Add to the requires:

```js
const { readHistoryChats } = require('./desktop-history');
```

Replace line 180:

```js
  const chats = arr(chatData.chats).filter((c) => c && typeof c.id === 'string' && c.id);
```

with:

```js
  // Since history stage H1 a profile's chats live in history.sqlite; any
  // that could not be migrated are still in chat-data.json. The store wins
  // for an id both hold.
  const history = readHistoryChats({ reader });
  attention.push(...history.attention);
  const historyIds = new Set(history.chats.map((c) => c.id));
  const chats = [
    ...history.chats,
    ...arr(chatData.chats).filter((c) => c && typeof c.id === 'string' && c.id && !historyIds.has(c.id))
  ];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/desktop-source-history.test.js tests/desktop-import-source.test.js tests/desktop-export.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/migration/desktop-history.js src/migration/desktop-source.js tests/desktop-source-history.test.js
git commit -m "fix(import): desktop import reads chats from history.sqlite through a private copy"
```

---

## Task 12: Hosts drop the SQLite warning; end to end; CLAUDE.md; the full suite

**Files:**
- Create: `src/history/sqlite-warning.js`
- Modify: `main.js:1-2`, `bin/king-louie-service.js:2`, `CLAUDE.md` (a new section after `## Logging`)
- Test: `tests/history-sqlite-warning.test.js`, `tests/e2e/history.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `suppressSqliteExperimentalWarning(proc = process)` (idempotent; drops only an `ExperimentalWarning` whose message names SQLite) and `isSqliteExperimentalWarning(warning, typeOrOptions) → boolean`, from `src/history/sqlite-warning.js`. Neither `main.js` nor `bin/king-louie-service.js` filtered it before (checked 2026-09-29).

- [ ] **Step 1: Write the failing unit tests**

Create `tests/history-sqlite-warning.test.js`:

```js
// tests/history-sqlite-warning.test.js
// The hosts drop node:sqlite's ExperimentalWarning and nothing else
// (recall spec §16).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { suppressSqliteExperimentalWarning, isSqliteExperimentalWarning } = require('../src/history/sqlite-warning');

const ROOT = path.join(__dirname, '..');

describe('suppressSqliteExperimentalWarning', () => {
  it('drops the SQLite experimental warning in each form and passes every other warning', () => {
    const emitted = [];
    const proc = { emitWarning(...args) { emitted.push(args); } };
    suppressSqliteExperimentalWarning(proc);
    suppressSqliteExperimentalWarning(proc);
    proc.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    proc.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
    proc.emitWarning(Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' }));
    proc.emitWarning('Some other feature is experimental', 'ExperimentalWarning');
    proc.emitWarning('SQLite is slow', 'DeprecationWarning');
    assert.deepStrictEqual(emitted.map((args) => String(args[0])), ['Some other feature is experimental', 'SQLite is slow']);
    assert.strictEqual(isSqliteExperimentalWarning('SQLite is an experimental feature', 'ExperimentalWarning'), true);
  });

  it('silences the real warning in a Node process', () => {
    const script = [
      "require('./src/history/sqlite-warning').suppressSqliteExperimentalWarning();",
      "new (require('node:sqlite').DatabaseSync)(':memory:').close();",
      "process.emitWarning('a different experiment', 'ExperimentalWarning');"
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
    assert.match(result.stderr, /a different experiment/);
  });

  it('is installed by both hosts before anything loads node:sqlite', () => {
    const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const bin = fs.readFileSync(path.join(ROOT, 'bin', 'king-louie-service.js'), 'utf8');
    assert.ok(mainJs.indexOf('suppressSqliteExperimentalWarning()') > 0);
    assert.ok(mainJs.indexOf('suppressSqliteExperimentalWarning()') < mainJs.indexOf("require('./src/ipc/standalone-host')"));
    assert.ok(bin.indexOf('suppressSqliteExperimentalWarning()') > 0);
    assert.ok(bin.indexOf('suppressSqliteExperimentalWarning()') < bin.indexOf("require('../src/service/cli')"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/history-sqlite-warning.test.js`
Expected: FAIL with `Cannot find module '../src/history/sqlite-warning'`.

- [ ] **Step 3: Write `src/history/sqlite-warning.js`**

```js
// src/history/sqlite-warning.js
// node:sqlite prints "ExperimentalWarning: SQLite is an experimental
// feature" when it is first loaded (recall spec §16). The two hosts drop that
// one warning before anything loads the history store; every other warning
// is emitted as before.

function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = warning && typeof warning === 'object' ? warning.name : null;
  const message = warning && typeof warning === 'object' ? warning.message : warning;
  return (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /\bSQLite\b/.test(String(message));
}

function suppressSqliteExperimentalWarning(proc = process) {
  if (proc.__klSqliteWarningFiltered) return;
  const emitWarning = proc.emitWarning;
  proc.emitWarning = function emitWarningWithoutSqlite(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  proc.__klSqliteWarningFiltered = true;
}

module.exports = { suppressSqliteExperimentalWarning, isSqliteExperimentalWarning };
```

- [ ] **Step 4: Install it in both hosts**

`main.js`, as the new second line (directly after the `require('electron')` line):

```js
require('./src/history/sqlite-warning').suppressSqliteExperimentalWarning();
```

`bin/king-louie-service.js` becomes:

```js
#!/usr/bin/env node
require('../src/history/sqlite-warning').suppressSqliteExperimentalWarning();
const { main } = require('../src/service/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; if (process.connected) process.disconnect(); },
  (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; }
);
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `node --test tests/history-sqlite-warning.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Write the end-to-end test**

Create `tests/e2e/history.test.js`:

```js
// tests/e2e/history.test.js
// The real app moves a profile's chats into history.sqlite, keeps them
// across a restart, loads each chat's messages when it is opened, and says
// when the store will not open (recall spec §4.4, §11.1, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

const T = '2026-09-28T10:00:00.000Z';
const chat = (id, title, lines) => ({
  id, title, createdAt: T, updatedAt: T,
  messages: lines.map(([sender, text], i) => ({ id: `${id}-m${i}`, sender, text, timestamp: T }))
});
const SEED_CHATS = [
  chat('chat-a', 'Lakeside lot', [['user', 'remember the blue folder'], ['assistant', 'Noted, the blue folder.']]),
  chat('chat-b', 'Second chat', [['user', 'what is example.com'], ['assistant', 'It is an example domain.']])
];
const MESSAGES_TEXT = "document.getElementById('chat-messages').textContent";

async function cleanup(ctx, dir) {
  if (ctx && !ctx.closed) {
    ctx.ownsDir = true;
    await closeApp(ctx);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('E2E: history store', () => {
  it('moves the profile\'s chats into history.sqlite and keeps them across a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-history-'));
    let ctx = null;
    try {
      ctx = await launchApp({
        userDataDir: dir,
        seed: { 'chat-data.json': { onboardingComplete: true, activeChatId: 'chat-b', chats: SEED_CHATS } }
      });
      await waitFor(ctx, "document.querySelectorAll('.chat-item').length === 2");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('example domain')`);

      await evaluate(ctx, "document.querySelector('.chat-item[data-chat-id=\"chat-a\"] .chat-item-title').click()");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('blue folder')`);
      assert.strictEqual(await evaluate(ctx, "Array.isArray(appState.chats.find((c) => c.id === 'chat-b').messages)"), false,
        'the chat left behind keeps no messages in the renderer');

      await closeApp(ctx);
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
      assert.deepStrictEqual(data.chats, []);
      assert.ok(fs.existsSync(path.join(dir, 'history.sqlite')));
      assert.strictEqual(fs.readdirSync(dir).filter((f) => /^chat-data\.backup-.*\.json$/.test(f)).length, 1);

      ctx = await launchApp({ userDataDir: dir, seed: null });
      await waitFor(ctx, "document.querySelectorAll('.chat-item').length === 2");
      await waitFor(ctx, `${MESSAGES_TEXT}.includes('blue folder')`);
    } finally {
      await cleanup(ctx, dir);
    }
  });

  it('says chats are unavailable when history.sqlite will not open, and leaves chat-data.json alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-history-'));
    fs.writeFileSync(path.join(dir, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    let ctx = null;
    try {
      ctx = await launchApp({ userDataDir: dir, seed: { 'chat-data.json': { onboardingComplete: true, chats: SEED_CHATS } } });
      await waitFor(ctx, "(document.querySelector('.chat-list-error')?.textContent || '').includes('Chats are unavailable')");
      assert.strictEqual(await evaluate(ctx, "document.querySelectorAll('.chat-item').length"), 0);
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
      assert.strictEqual(data.chats.length, 2);
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('chat-data.backup-')), []);
    } finally {
      await cleanup(ctx, dir);
    }
  });
});
```

- [ ] **Step 7: Add the History section to `CLAUDE.md`**

After the `## Logging` section add:

```markdown
## History

`src/history/` is the history store (spec
`docs/superpowers/specs/2026-09-25-chat-history-recall-design.md`, stage H1;
ADR `docs/adr/0001-history-messages-as-rows.md`). It is Electron-free.

- Chats, their messages (one row each, `seq` dense from 1 per chat) and
  attachments live in `<dataDir>/history.sqlite` (`node:sqlite`, WAL, one
  connection per core, closed at the end of `shutdown()`). `chat-data.json`
  keeps everything else.
- Code reaches chats through the core context: `listChats` (metadata with
  `messageCount`, `preview`, `lastMessageAt`), `getChat(id, { messages })`,
  `updateChat`, `appendMessageToChat`, `truncateChatFrom`, `getMessages`, or
  `getHistoryStore()` for the store itself. `getChats`/`setChats` are gone;
  `tests/history-no-legacy-chat-helpers.test.js` keeps them out of `src/`.
- On the first start after H1, the chats in `chat-data.json` move into the
  store, one transaction per chat, after a `chat-data.backup-<timestamp>.json`
  copy. A chat that fails stays in the JSON file and the chat list says how
  many; the move resumes on the next start. An old `chat-history.sqlite` is
  never read.
- A store that will not open is an error in the log and the chat list, never
  a fallback to the JSON file. Service CLI commands that build a core as root
  pass `history: { open: false }`.
- Schema changes are new entries in `SCHEMA_STEPS` (`src/history/schema.js`);
  never edit a released step.
- `main.js` and `bin/king-louie-service.js` drop Node's SQLite
  ExperimentalWarning (`src/history/sqlite-warning.js`); tests still print it.
- Tests use `HistoryStore.open(':memory:')` or `tests/helpers/history-context.js`
  (the facade over one). On Windows an open store keeps its folder from being
  deleted, so a test that builds a core calls `closeOpenHistoryStores()`
  (`tests/helpers/close-history-stores.js`) before removing the data dir.
```

- [ ] **Step 8: Run the whole unit suite**

Run: `npm test`
Expected: `# fail 0`. Any failure here is a test that compares whole chats or messages and trips on `seq` or the listing fields, or a core-building test without `closeOpenHistoryStores()`; fix it as Task 7 Step 7 describes.

- [ ] **Step 9: Run the e2e suites this stage touches, then the whole e2e suite**

From an agent shell `ELECTRON_RUN_AS_NODE` must be removed (CLAUDE.md):

```bash
unset ELECTRON_RUN_AS_NODE && node --test --test-concurrency=1 --test-timeout=120000 tests/e2e/history.test.js tests/e2e/chat-basics.test.js tests/e2e/cases.test.js tests/e2e/attached-mode.test.js tests/e2e/models-stop.test.js
```

Expected: PASS. Then: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` — expected PASS.

- [ ] **Step 10: Commit**

```bash
git add src/history/sqlite-warning.js main.js bin/king-louie-service.js CLAUDE.md tests/history-sqlite-warning.test.js tests/e2e/history.test.js
git commit -m "chore(history): hosts drop the node:sqlite warning; e2e for the move and an unavailable store; CLAUDE.md"
```

---

## Self-review against the spec

| Spec requirement (H1) | Where |
|---|---|
| §4.1 `schema_version`, `chats` (+ `position`), `messages` (dense `seq`, `UNIQUE(chat_id, seq)`), `attachments`, `meta` | Task 1 |
| §3 one SQLite file, WAL; §5.1 `busy_timeout = 5000`; foreign keys | Task 1 |
| §3.2 `open(path, { readonly })`, `close()` | Task 1 |
| §4.2 today's message shape plus `seq`; attachments re-inflated | Tasks 2, 3 |
| §3.2 `listChats`, `getChat`, `createChat`, `updateChat`, `deleteChat` | Task 3 |
| §3.2 `appendMessage → { message, seq }`, `truncateFrom`, `getMessages` | Task 4 |
| §11.1 backup, per-chat transactions, count check, failures left and reported, marker when empty, idempotent and resumable | Task 5 (store), Task 7 (at core open), Tasks 8 and 10 (UI text) |
| §4.4 note: the blob file is not read and is left on disk | Task 7 test |
| §4.4 `getChats`/`setChats` removed, a test keeps them out of `src/` | Tasks 8, 9 |
| §4.4 `appendMessageToChat` keeps its signature and return; `llmTotals` incremental in `meta_json` | Task 6, Task 7 |
| §4.4 `chat:load` metadata plus the active chat; `chat:get`; renderer holds only the active chat's messages | Task 8, Task 10 |
| §4.4 `chat-data.json` keeps everything but `chats` | Task 5 test |
| §12 `create-core.js` opens from `paths.dataDir` or `deps.history.dbPath`, exposes `getHistoryStore` | Task 7 |
| §12 `main.js` filters the ExperimentalWarning (and the service host, §16) | Task 12 |
| §12 `CLAUDE.md` section | Task 12 (the benchmark smoke test line belongs to B0) |
| §13 store tests: schema creation and versioning, append and dense `seq`, truncate, attachments round trip | Tasks 1, 3, 4 |
| §13 migration from a fixture with a corrupt chat: backup, partial success, resume | Task 5 |
| §13 `electron-boundary` passes with `src/history/` | Tasks 1, 6, 11 run it |
| §15 store will not open: error to UI and log, JSON untouched, no fallback | Tasks 6, 7, 8, 10, 12 |
| §15 `appendMessage` failure throws and writes nothing | Task 4 test; the send path already fails the turn when `appendMessageToChat` throws |
| §15 one chat's migration fails: stays in JSON, reported, rest migrate, backup first | Task 5 |

Not in H1 by design (later stages add them as schema steps and code): chunks, FTS, embeddings, links, imports, calibration, the context builder, the tools, provenance, `history.*` settings, removing `conversation-compactor.js`.

## Assumptions made in this plan

- `attachments` has two columns §4.1 does not list: `idx` (an attachment's place in its message's `images`/`documents` list, needed to read them back in order) and `meta_json` (fields such as `sizeBytes`, `previewUrl` or a data-URL `base64`, so the round trip is lossless). Both are additive.
- `history_scope` exists with its default but is not mapped to a chat field in H1; a chat's `historyScope`, if any, is kept in `meta_json`. H4 maps the column.
- A message without a `timestamp` is stored with its chat's `updatedAt` (else `createdAt`, else the migration time), and a chat without a `title` reads back with `''`: `NOT NULL` columns cannot record "absent". Every other field round-trips exactly.
- A message id already stored (a desktop-import copy shares its source's ids) is replaced by a fresh UUID for the copy.
- The migration runs when `createCore` opens the store, before `start()`, as the blob store's copy did; the UI learns the result from `chat:load`.
- `listChats`'s `preview` is cut to 500 characters.
- `chat:load` falls back to the first chat when the stored `activeChatId` names none, without writing that choice back.
- A read-only `open` refuses a file whose schema is older or newer than this build's.

## Open questions

1. **Desktop import (Task 11).** The H1 scope did not name it, but without Task 11 every migrated chat silently drops out of `import --from` and the desktop's Import. The plan reads the profile's `history.sqlite` through the safe reader into a private copy. A copy taken while the desktop app is writing can come out unreadable (reported, "close King Louie and import again") or, rarely, miss the last few writes if a checkpoint lands mid-copy (not detected). Is that acceptable, or should Import require the desktop's own core to be stopped first?
2. **Truncate and `llmTotals`.** Today a truncate keeps the chat's `llmTotals` (money already spent stays counted), and the plan keeps that. Should the chat info popover instead show only the cost of the messages still in the chat?
