// src/history/import-chats.js
// Importing a conversation into the history store (recall spec §10.2, stage
// H4): a file is read by one of the importers, then stored as a new chat in
// batches (begin, append, finish), every message through the store's own
// insert path so it is chunked like a native one.
//
// What holds whatever the file, or a parsed chat that arrives over the
// desktop bridge, says:
// - An import never writes into an existing chat (owner ruling R-H4-8).
//   HistoryStore#createChat replaces a chat with the same id, so a taken id
//   is never used: the import gets another one. The same file (by hash)
//   imported twice returns the first chat; a grown copy is a second chat.
// - The chat is built from a fixed list of fields and each message from a
//   fixed list of keys. No caseId, origin, history scope, agent mode,
//   working directory, usage totals, provenance, question card or turn
//   context comes in with an import.
// - A Vault call keeps its action and key only (UNINDEXED_TOOLS).
// - A crash in the middle leaves a `running` import row; its chat is removed
//   at the next start (sweepUnfinishedImports) or by the next import of the
//   same file.
// Electron-free; the caller picks the file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { IMPORTERS, claimImporter } = require('./importers');
const { visibleToolParams, isUnindexedTool } = require('./chunker');
const { createLogger } = require('../logging');

const log = createLogger('history/import');

const KINDS = Object.freeze(IMPORTERS.map((importer) => importer.kind));
const SENDERS = Object.freeze(['user', 'assistant', 'toolUse', 'toolResult', 'status']);
const TEXT_SENDERS = Object.freeze(['user', 'assistant', 'status']);
const ATTACHMENT_TEXT_KEYS = Object.freeze(['name', 'mimeType', 'type', 'textContent']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ID_MAX_CHARS = 200;
// Room for "-<8 of the hash>-<n>" after a replaced id.
const ID_BASE_MAX_CHARS = 160;
const TITLE_MAX_CHARS = 200;
const DEFAULT_TITLE = 'Imported chat';
const DEFAULT_BATCH = 500;
// The largest file an import reads, checked once before any importer opens
// it, for every format (the Markdown importer keeps its own lower limit).
// The largest real session seen is 37 MB; 128 MB leaves three times that
// and still parses in memory (a JSON export is read whole).
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
// The longest line of a JSONL session. One line is one record; a record this
// long is refused instead of read to its end.
const MAX_IMPORT_LINE_CHARS = 32 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validTime = (v) => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// A Claude Code subagent transcript is claimed by no importer; the Claude
// Code importer's own refusal says why, and it is given before the file is
// read.
function isSubagentSession(filePath) {
  return /\.jsonl$/i.test(filePath) && path.resolve(filePath).split(/[\\/]/).includes('subagents');
}

const megabytes = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

// The one size check, before the file is hashed or any importer opens it.
// The messages name no path. A limit that is not a number is the default.
async function checkImportFile(filePath, maxFileBytes) {
  const limit = typeof maxFileBytes === 'number' && Number.isFinite(maxFileBytes) && maxFileBytes >= 0 ? maxFileBytes : MAX_IMPORT_BYTES;
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw fail('IMPORT_NOT_A_FILE', 'This is not a file, so it cannot be imported.');
  if (stat.size > limit) {
    throw fail('IMPORT_TOO_LARGE', `This file is ${megabytes(stat.size)} MB; an import is at most ${megabytes(limit)} MB.`);
  }
  return limit;
}

// What every step of one import passes its importer: the limits, and what
// the importer read while claiming the file (so it is not read again).
async function openImport(filePath, { pattern, maxBytes, maxFileBytes, maxLineChars } = {}) {
  const fileLimit = await checkImportFile(filePath, maxFileBytes);
  const limits = {
    maxBytes,
    maxFileBytes: fileLimit,
    maxLineChars: typeof maxLineChars === 'number' && Number.isFinite(maxLineChars) && maxLineChars > 0 ? maxLineChars : MAX_IMPORT_LINE_CHARS
  };
  const sourceHash = await hashFile(filePath);
  const claimed = await claimImporter(filePath, limits);
  if (!claimed) {
    if (isSubagentSession(filePath)) {
      const claudeCode = IMPORTERS.find((candidate) => candidate.kind === 'claude-code-jsonl');
      if (claudeCode) await claudeCode.parse(filePath, limits);
    }
    throw fail('IMPORT_UNKNOWN_FORMAT', 'This file is not a Claude Code session, a Markdown transcript or a King Louie chat export.');
  }
  const { importer, loaded } = claimed;
  // A King Louie export of a case chat (owner ruling R-H4-2). Only that the
  // file's chat has a caseId is kept, never the id.
  const fromCase = typeof importer.exportHasCase === 'function' && importer.exportHasCase(loaded);
  return { importer, sourceHash, fromCase, options: { ...limits, pattern, loaded } };
}

// The chat an importer gave, as the few fields an import takes.
// `private` (local inference spec 2026-10-13 §8.2, R-LI-28): the export
// said so, exactly true. Nothing in a file can make a chat less private.
function importedChat(chat = {}, { fromCase = false } = {}) {
  const out = {};
  if (typeof chat.id === 'string') out.id = chat.id;
  out.title = typeof chat.title === 'string' ? chat.title : '';
  if (validTime(chat.createdAt)) out.createdAt = chat.createdAt;
  if (validTime(chat.updatedAt)) out.updatedAt = chat.updatedAt;
  if (fromCase) out.importedFromCase = true;
  if (chat.private === true) out.private = true;
  return out;
}

// maxBytes is the Markdown importer's own limit; maxFileBytes the limit for
// any file (MAX_IMPORT_BYTES) and maxLineChars for a JSONL line.
async function parseImport(filePath, limits = {}) {
  const { importer, sourceHash, fromCase, options } = await openImport(filePath, limits);
  const parsed = await importer.parse(filePath, options);
  return {
    kind: importer.kind,
    importerVersion: importer.version,
    sourceHash,
    chat: importedChat(parsed.chat, { fromCase }),
    messages: parsed.messages,
    stats: parsed.stats
  };
}

async function previewImport(filePath, limits = {}) {
  const { importer, sourceHash, options } = await openImport(filePath, limits);
  const preview = await importer.preview(filePath, options);
  return { ...preview, kind: importer.kind, importerVersion: importer.version, sourceHash };
}

function requireStore(store) {
  if (!store || typeof store.createChat !== 'function' || typeof store.recordImport !== 'function') {
    throw new TypeError('An import needs the history store.');
  }
  if (store.readonly || store.linkable === false) throw fail('IMPORT_UNAVAILABLE', 'This history store cannot take an import.');
}

// A chat id nothing has: the importer's own when it is a plain id and free,
// else that id (made plain) with the first 8 characters of the file's hash,
// then -2, -3, … "Free" also means not reserved: an id a chat still in
// chat-data.json holds is never used (HistoryStore#reserveChatIds), or the
// move out of the JSON file would take the import for that chat.
function freeChatId(store, wanted, sourceHash) {
  const taken = (id) => Boolean(store.chatRef(id)) || (typeof store.isReservedChatId === 'function' && store.isReservedChatId(id));
  const given = typeof wanted === 'string' ? wanted : '';
  const usable = given.length >= 1 && given.length <= ID_MAX_CHARS && ID_PATTERN.test(given);
  if (usable && !taken(given)) return given;
  const plain = given.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_BASE_MAX_CHARS);
  const base = `${plain || 'import'}-${sourceHash.slice(0, 8)}`;
  let id = base;
  for (let n = 2; taken(id) && n < 100000; n += 1) id = `${base}-${n}`;
  if (taken(id)) throw fail('IMPORT_INVALID', 'No free chat id for this import.');
  return id;
}

function beginChatImport({ store, kind, importerVersion = null, sourceHash, sourcePath = null, chat, now } = {}) {
  requireStore(store);
  if (!KINDS.includes(kind)) throw fail('IMPORT_INVALID', 'An import needs a known kind.');
  if (typeof sourceHash !== 'string' || !HASH_PATTERN.test(sourceHash)) throw fail('IMPORT_INVALID', 'An import needs the SHA-256 of its file.');
  if (!isObject(chat) || typeof chat.title !== 'string') throw fail('IMPORT_INVALID', 'An import needs a chat with a title.');

  const found = store.findImport(sourceHash);
  if (found && found.state === 'done') {
    // The same file imported again as private marks the chat it returns:
    // an import adds the mark, never removes it.
    if (chat.private === true && store.chatRef(found.chatId) && store.isPrivate(found.chatId) === false) store.markPrivate(found.chatId);
    return { existingChatId: found.chatId };
  }
  // An import of this file that never finished: its half chat goes first.
  if (found) store.deleteChat(found.chatId);

  const stamp = typeof now === 'function' ? now() : new Date().toISOString();
  const createdAt = validTime(chat.createdAt) ? chat.createdAt : stamp;
  const record = {
    title: [...chat.title.trim()].slice(0, TITLE_MAX_CHARS).join('') || DEFAULT_TITLE,
    source: kind,
    createdAt,
    updatedAt: validTime(chat.updatedAt) ? chat.updatedAt : createdAt
  };
  if (chat.importedFromCase === true) record.importedFromCase = true;

  const importId = crypto.randomUUID();
  return store.transaction(() => {
    // Chosen inside the transaction that creates the chat: createChat over
    // an id that exists would delete that chat (R-H4-8).
    const chatId = freeChatId(store, chat.id, sourceHash);
    if (store.chatRef(chatId)) throw fail('IMPORT_INVALID', 'No free chat id for this import.');
    // A private import is private from its creation, before its first
    // message (and so its first chunk) is written.
    store.createChat({ id: chatId, ...record, messages: [] }, { position: 'front', ...(chat.private === true ? { private: true } : {}) });
    const row = store.recordImport({
      id: importId, sourceKind: kind, sourcePath: typeof sourcePath === 'string' && sourcePath ? sourcePath : null,
      sourceHash, chatId, importerVersion: Number.isInteger(importerVersion) ? importerVersion : null, state: 'running'
    });
    if (!row) throw fail('IMPORT_UNAVAILABLE', 'This history store cannot take an import.');
    return { importId, chatId };
  });
}

// No bytes: an imported attachment is its name and its text.
function reduceAttachments(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const kept = {};
    for (const key of ATTACHMENT_TEXT_KEYS) if (typeof item[key] === 'string') kept[key] = item[key];
    if (typeof item.size === 'number' && Number.isFinite(item.size)) kept.size = item.size;
    out.push(kept);
  }
  return out.length ? out : undefined;
}

// One message as an import stores it. Not taken, whatever arrives: seq (the
// store's), context and llm (a turn's provenance and usage), question (a
// case question's card) and meta.action (a button), so nothing imported
// renders as live or reads as this app's own record of a turn.
function reduceMessage(raw) {
  if (!isObject(raw)) throw fail('IMPORT_INVALID', 'An imported message must be an object.');
  if (!SENDERS.includes(raw.sender)) throw fail('IMPORT_INVALID', 'An imported message has a sender this app does not store.');
  const unindexed = isUnindexedTool(raw);
  const message = { sender: raw.sender };
  if (typeof raw.id === 'string' && raw.id && raw.id.length <= ID_MAX_CHARS) message.id = raw.id;
  if (validTime(raw.timestamp)) message.timestamp = raw.timestamp;
  if (typeof raw.text === 'string' && !unindexed) message.text = raw.text;
  else if (TEXT_SENDERS.includes(raw.sender) && !unindexed) message.text = '';
  if (typeof raw.toolName === 'string') message.toolName = raw.toolName;
  if (raw.parameters !== undefined) message.parameters = unindexed ? visibleToolParams(raw) : raw.parameters;
  if (raw.result !== undefined) message.result = unindexed ? '' : raw.result;
  if (Array.isArray(raw.toolCalls)) {
    message.toolCalls = raw.toolCalls.map((call) => (isObject(call) && isUnindexedTool(call) ? { ...call, content: '' } : call));
  }
  const documents = reduceAttachments(raw.documents);
  if (documents) message.documents = documents;
  const images = reduceAttachments(raw.images);
  if (images) message.images = images;
  if (typeof raw.runId === 'string') message.runId = raw.runId;
  if (typeof raw.stopped === 'boolean') message.stopped = raw.stopped;
  if (isObject(raw.meta)) {
    const { action: _action, ...meta } = raw.meta;
    if (Object.keys(meta).length) message.meta = meta;
  }
  return message;
}

function runningImport(store, importId) {
  const row = typeof importId === 'string' && importId ? store.getImport(importId) : null;
  if (!row || row.state !== 'running') throw fail('IMPORT_NOT_OPEN', 'This import is not open.');
  return row;
}

function appendChatImport({ store, importId, messages } = {}) {
  requireStore(store);
  const row = runningImport(store, importId);
  if (!Array.isArray(messages)) throw fail('IMPORT_INVALID', 'An import batch must be a list of messages.');
  // Every message is checked before any is written.
  const reduced = messages.map(reduceMessage);
  const chat = store.getChat(row.chatId, { messages: false });
  const out = chat ? store.appendMessages(row.chatId, reduced, { updatedAt: chat.updatedAt }) : null;
  if (!out) throw fail('IMPORT_NOT_OPEN', 'This import is not open.');
  return { done: out.lastSeq || store.messageCount(row.chatId) };
}

function finishChatImport({ store, importId } = {}) {
  requireStore(store);
  const row = runningImport(store, importId);
  const messages = store.messageCount(row.chatId);
  if (!store.finishImport(importId, { messageCount: messages })) throw fail('IMPORT_NOT_OPEN', 'This import is not open.');
  return { chatId: row.chatId, messages };
}

// Removes a running import's chat (the import row goes with it). True when
// something was removed; a finished or unknown import is left alone.
function abortChatImport({ store, importId } = {}) {
  if (!store || typeof store.getImport !== 'function' || typeof importId !== 'string' || !importId) return false;
  const row = store.getImport(importId);
  if (!row || row.state !== 'running') return false;
  return store.deleteChat(row.chatId);
}

// `asPrivate` (exactly true): the import dialog's "Import as private".
async function importChat({
  store, filePath, pattern, maxBytes, maxFileBytes, maxLineChars, batchSize = DEFAULT_BATCH, schedule = setImmediate, now, onProgress, asPrivate = false
} = {}) {
  requireStore(store);
  const parsed = await parseImport(filePath, { pattern, maxBytes, maxFileBytes, maxLineChars });
  if (asPrivate === true) parsed.chat.private = true;
  const { kind, stats, messages } = parsed;
  if (!Array.isArray(messages) || !messages.length) throw fail('IMPORT_INVALID', 'This file has no messages to import.');
  const begun = beginChatImport({
    store, kind, importerVersion: parsed.importerVersion, sourceHash: parsed.sourceHash, sourcePath: filePath, chat: parsed.chat, now
  });
  if (begun.existingChatId) {
    const count = store.findImport(parsed.sourceHash)?.messageCount;
    return { chatId: begun.existingChatId, imported: false, messages: Number.isInteger(count) ? count : store.messageCount(begun.existingChatId), kind, stats };
  }
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH;
  const total = messages.length;
  try {
    for (let i = 0; i < total; i += size) {
      // Between batches the loop runs: a long session never holds it.
      if (i > 0) await new Promise((resolve) => { schedule(resolve); });
      const { done } = appendChatImport({ store, importId: begun.importId, messages: messages.slice(i, i + size) });
      if (typeof onProgress === 'function') {
        try {
          onProgress({ done, total });
        } catch (err) {
          log.debug(`import progress listener failed: ${err.message}`);
        }
      }
    }
    const finished = finishChatImport({ store, importId: begun.importId });
    return { chatId: finished.chatId, imported: true, messages: finished.messages, kind, stats };
  } catch (err) {
    try {
      abortChatImport({ store, importId: begun.importId });
    } catch (abortErr) {
      // The store closed under the import; the next start's sweep removes it.
      log.warn(`An import that failed could not be removed now: ${abortErr.message}`);
    }
    throw err;
  }
}

// After a crash in the middle of an import: the chat of every import still
// `running` is removed. Returns how many.
function sweepUnfinishedImports(store) {
  if (!store || typeof store.unfinishedImports !== 'function' || store.readonly || store.linkable === false) return 0;
  let removed = 0;
  for (const row of store.unfinishedImports()) {
    if (store.deleteChat(row.chatId)) removed += 1;
  }
  if (removed) log.info(`Removed ${removed} chat${removed === 1 ? '' : 's'} left by an import that did not finish.`);
  return removed;
}

// One import at a time per core (stage H4, the import IPC), and the state of
// an import that arrives parsed in batches over history:import.begin, .append
// and .finish. What arrives is held to caps: `total` is declared at begin and
// never passed, a batch is at most 500 messages and 8 MB of JSON, and an
// import with no call for idleMs is removed. Any refused batch, and a finish
// before every message arrived, removes the import and its chat: a transcript
// is stored whole or not at all.
const MAX_IMPORT_MESSAGES = 2000000;
const MAX_BATCH_MESSAGES = 500;
const MAX_BATCH_CHARS = 8 * 1024 * 1024;
const IMPORT_IDLE_MS = 30 * 60 * 1000;
const BUSY_MESSAGE = 'Another import is running.';

function createImportGate({ getStore, idleMs = IMPORT_IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false; // a whole file is being imported (run)
  let open = null; // { importId, sourceHash, total, done, timer }

  const store = () => getStore();
  const stopTimer = (entry) => {
    if (entry && entry.timer !== null) clearTimer(entry.timer);
    if (entry) entry.timer = null;
  };
  const arm = (entry) => {
    stopTimer(entry);
    entry.timer = setTimer(() => abortOpen('no call for 30 minutes'), idleMs);
    // Never the reason the process stays up.
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  };
  function abortOpen(reason = 'aborted') {
    if (!open) return false;
    const entry = open;
    open = null;
    stopTimer(entry);
    try {
      abortChatImport({ store: store(), importId: entry.importId });
    } catch (err) {
      // The next start's sweep removes it.
      log.warn(`An open import could not be removed now: ${err.message}`);
    }
    log.info(`An open import was removed (${reason}).`);
    return true;
  }
  const current = (importId) => {
    if (!open || typeof importId !== 'string' || importId !== open.importId) throw fail('IMPORT_NOT_OPEN', 'This import is not open.');
    return open;
  };

  return {
    busy: () => running || open !== null,
    // A whole-file import (importChat): refused while another import runs.
    async run(fn) {
      if (running || open) throw fail('IMPORT_BUSY', BUSY_MESSAGE);
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
      }
    },
    begin({ kind, importerVersion = null, sourceHash, sourcePath = null, chat, total, now } = {}) {
      if (!Number.isInteger(total) || total < 1 || total > MAX_IMPORT_MESSAGES) {
        throw fail('IMPORT_INVALID', `An import needs its message count, from 1 to ${MAX_IMPORT_MESSAGES}.`);
      }
      if (running) throw fail('IMPORT_BUSY', BUSY_MESSAGE);
      if (open) {
        // The same file begun again (the sender lost its connection and
        // starts over) replaces the open import; any other waits.
        if (open.sourceHash !== sourceHash) throw fail('IMPORT_BUSY', BUSY_MESSAGE);
        abortOpen('the same file was begun again');
      }
      const begun = beginChatImport({ store: store(), kind, importerVersion, sourceHash, sourcePath, chat, now });
      if (begun.existingChatId) return begun;
      open = { importId: begun.importId, sourceHash, total, done: 0, timer: null };
      arm(open);
      return begun;
    },
    append({ importId, messages } = {}) {
      const entry = current(importId);
      try {
        if (!Array.isArray(messages)) throw fail('IMPORT_INVALID', 'An import batch must be a list of messages.');
        let chars;
        try {
          chars = messages.length > MAX_BATCH_MESSAGES ? Infinity : JSON.stringify(messages).length;
        } catch {
          throw fail('IMPORT_INVALID', 'An import batch must be plain data.');
        }
        if (chars > MAX_BATCH_CHARS) throw fail('IMPORT_BATCH_TOO_LARGE', `An import batch is at most ${MAX_BATCH_MESSAGES} messages and 8 MB.`);
        if (entry.done + messages.length > entry.total) throw fail('IMPORT_OVER_TOTAL', 'More messages arrived than this import said it has.');
        appendChatImport({ store: store(), importId, messages });
        entry.done += messages.length;
      } catch (err) {
        abortOpen('a batch was refused');
        throw err;
      }
      arm(entry);
      return { done: entry.done };
    },
    finish({ importId } = {}) {
      const entry = current(importId);
      let out;
      try {
        if (entry.done !== entry.total) throw fail('IMPORT_INCOMPLETE', 'This import ended before all of its messages arrived.');
        out = finishChatImport({ store: store(), importId });
      } catch (err) {
        abortOpen('it could not be finished');
        throw err;
      }
      open = null;
      stopTimer(entry);
      return out;
    },
    abortOpen,
    // Removes the open import only when it is this one: the sender of a
    // batch import went away (the desktop bridge's disconnect).
    abort({ importId, reason = 'its sender went away' } = {}) {
      if (!open || typeof importId !== 'string' || importId !== open.importId) return false;
      return abortOpen(reason);
    }
  };
}

module.exports = {
  IMPORT_KINDS: KINDS, IMPORT_SENDERS: SENDERS, HASH_PATTERN,
  MAX_IMPORT_MESSAGES, MAX_BATCH_MESSAGES, MAX_BATCH_CHARS, IMPORT_IDLE_MS, MAX_IMPORT_BYTES, MAX_IMPORT_LINE_CHARS,
  createImportGate,
  hashFile, parseImport, previewImport, beginChatImport, appendChatImport, finishChatImport, abortChatImport,
  importChat, sweepUnfinishedImports
};
