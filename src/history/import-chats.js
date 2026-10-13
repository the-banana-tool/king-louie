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
const { IMPORTERS, detectImporter } = require('./importers');
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

async function importerFor(filePath) {
  const importer = await detectImporter(filePath);
  if (!importer && isSubagentSession(filePath)) {
    const claudeCode = IMPORTERS.find((candidate) => candidate.kind === 'claude-code-jsonl');
    if (claudeCode) await claudeCode.parse(filePath);
  }
  if (!importer) throw fail('IMPORT_UNKNOWN_FORMAT', 'This file is not a Claude Code session, a Markdown transcript or a King Louie chat export.');
  return importer;
}

// Whether a King Louie export is of a case chat (owner ruling R-H4-2): the
// chat object in the file has a caseId. Only that it has one is kept, never
// the id. Any value but an empty one counts, so a caseId that is not a
// string still marks the chat.
function exportHasCase(filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  if (!isObject(data)) return false;
  const { caseId } = data;
  return caseId !== undefined && caseId !== null && caseId !== '' && caseId !== false;
}

// The chat an importer gave, as the few fields an import takes.
function importedChat(chat = {}, { fromCase = false } = {}) {
  const out = {};
  if (typeof chat.id === 'string') out.id = chat.id;
  out.title = typeof chat.title === 'string' ? chat.title : '';
  if (validTime(chat.createdAt)) out.createdAt = chat.createdAt;
  if (validTime(chat.updatedAt)) out.updatedAt = chat.updatedAt;
  if (fromCase) out.importedFromCase = true;
  return out;
}

async function parseImport(filePath, { pattern, maxBytes } = {}) {
  const sourceHash = await hashFile(filePath);
  const importer = await importerFor(filePath);
  const parsed = await importer.parse(filePath, { pattern, maxBytes });
  const fromCase = importer.kind === 'king-louie-json' && exportHasCase(filePath);
  return {
    kind: importer.kind,
    importerVersion: importer.version,
    sourceHash,
    chat: importedChat(parsed.chat, { fromCase }),
    messages: parsed.messages,
    stats: parsed.stats
  };
}

async function previewImport(filePath, { pattern, maxBytes } = {}) {
  const sourceHash = await hashFile(filePath);
  const importer = await importerFor(filePath);
  const preview = await importer.preview(filePath, { pattern, maxBytes });
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
// then -2, -3, …
function freeChatId(store, wanted, sourceHash) {
  const given = typeof wanted === 'string' ? wanted : '';
  const usable = given.length >= 1 && given.length <= ID_MAX_CHARS && ID_PATTERN.test(given);
  if (usable && !store.chatRef(given)) return given;
  const plain = given.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_BASE_MAX_CHARS);
  const base = `${plain || 'import'}-${sourceHash.slice(0, 8)}`;
  let id = base;
  for (let n = 2; store.chatRef(id); n += 1) id = `${base}-${n}`;
  return id;
}

function beginChatImport({ store, kind, importerVersion = null, sourceHash, sourcePath = null, chat, now } = {}) {
  requireStore(store);
  if (!KINDS.includes(kind)) throw fail('IMPORT_INVALID', 'An import needs a known kind.');
  if (typeof sourceHash !== 'string' || !HASH_PATTERN.test(sourceHash)) throw fail('IMPORT_INVALID', 'An import needs the SHA-256 of its file.');
  if (!isObject(chat) || typeof chat.title !== 'string') throw fail('IMPORT_INVALID', 'An import needs a chat with a title.');

  const found = store.findImport(sourceHash);
  if (found && found.state === 'done') return { existingChatId: found.chatId };
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
    store.createChat({ id: chatId, ...record, messages: [] }, { position: 'front' });
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

async function importChat({ store, filePath, pattern, maxBytes, batchSize = DEFAULT_BATCH, schedule = setImmediate, now, onProgress } = {}) {
  requireStore(store);
  const parsed = await parseImport(filePath, { pattern, maxBytes });
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

module.exports = {
  IMPORT_KINDS: KINDS, IMPORT_SENDERS: SENDERS,
  hashFile, parseImport, previewImport, beginChatImport, appendChatImport, finishChatImport, abortChatImport,
  importChat, sweepUnfinishedImports
};
