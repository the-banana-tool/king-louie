// src/history/schema.js
// The history store's schema as ordered steps (recall spec 2026-09-25 §4.1).
// Each step runs once, in its own transaction, and bumps schema_version.
// Later stages append { version: N, up(db) }; never edit a released step.
// Stage H1 creates only the tables it uses; chunks, FTS, embeddings, links,
// imports and calibration arrive as later steps.

const { SCHEMA_V2_SQL } = require('./chunk-index');

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
  },
  // Recall stage H2: chunks, the full-text index and token calibration
  // (spec 2026-09-25 §4.1). Task 4 adds the backfill marker here.
  {
    version: 2,
    up(db) {
      db.exec(SCHEMA_V2_SQL);
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
