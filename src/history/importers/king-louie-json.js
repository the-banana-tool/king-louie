'use strict';
// King Louie's own chat export (the renderer's "Export as JSON": one chat,
// `{ ...chat, messages }`) → a chat in the stored message shape (recall spec
// §10.2, "one-to-one"). What it drops on purpose: `llm` (usage bookkeeping),
// `context` (turn provenance), attachment bytes (the benchmark measures
// text), and a Vault call's parameters other than action/key and its result
// (UNINDEXED_TOOLS: King Louie never indexes them either). The chat's
// `llmTotals` ride along on the chat object for the manifest.
const fs = require('fs');
const path = require('path');
const { visibleToolParams, isUnindexedTool } = require('../chunker');

const KIND = 'king-louie-json';
const VERSION = 1;
const SENDERS = ['user', 'assistant', 'toolUse', 'toolResult', 'status'];
const RAW_MAX_CHARS = 4000;
const DOCUMENT_KEYS = ['name', 'mimeType', 'type', 'size', 'textContent'];
const IMAGE_KEYS = ['name', 'mimeType', 'type', 'size'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// The file's text, or null when it is over maxFileBytes: the size is read
// from the open file, so a file swapped after a caller's own check is still
// held to it. No limit given reads any size (LongHaul).
function readText(filePath, maxFileBytes) {
  const limit = Number.isFinite(maxFileBytes) && maxFileBytes >= 0 ? maxFileBytes : Infinity;
  if (limit === Infinity) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    if (fs.fstatSync(fd).size > limit) return null;
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// The file is one chat whose messages carry a sender. An unknown sender is
// still ours (parse keeps it as an unmapped status message), so at least one
// stored sender is enough to claim the file. This is the one place the file
// is read and parsed: `load` gives the result to a caller that then passes
// it back to parse or preview as `loaded`.
function readChat(filePath, { maxFileBytes } = {}) {
  if (!/\.json$/i.test(filePath)) return null;
  let data;
  try {
    const text = readText(filePath, maxFileBytes);
    if (text === null) return null;
    data = JSON.parse(text);
  } catch { return null; }
  if (!isObject(data) || !Array.isArray(data.messages) || data.messages.length === 0) return null;
  if (!data.messages.every((m) => isObject(m) && typeof m.sender === 'string')) return null;
  if (!data.messages.some((m) => SENDERS.includes(m.sender))) return null;
  return data;
}

function keepAttachments(list, keys) {
  if (!Array.isArray(list)) return undefined;
  const out = list.filter(isObject).map((item) => {
    const kept = {};
    for (const key of keys) if (item[key] !== undefined) kept[key] = item[key];
    return kept;
  });
  return out.length ? out : undefined;
}

// The export as read, or null when the file is not one. Never throws.
function load(filePath, options) {
  try { return readChat(filePath, options); } catch { return null; }
}

async function detect(filePath, options) {
  return load(filePath, options) !== null;
}

// Whether the export is of a case chat (owner ruling R-H4-2): the chat
// object in the file has a caseId. Any value but an empty one counts, so a
// caseId that is not a string still marks the chat.
function exportHasCase(data) {
  if (!isObject(data)) return false;
  const { caseId } = data;
  return caseId !== undefined && caseId !== null && caseId !== '' && caseId !== false;
}

// `loaded`: what `load` returned for this file, so it is not read again.
async function parse(filePath, { loaded, maxFileBytes } = {}) {
  const data = isObject(loaded) ? loaded : readChat(filePath, { maxFileBytes });
  if (!data) {
    const err = new Error(`${path.basename(filePath)} is not a King Louie chat export`);
    err.code = 'NOT_KING_LOUIE_EXPORT';
    throw err;
  }
  const stats = { unmapped: 0, badLines: 0, duplicates: 0, skipped: {} };
  const messages = [];
  const compactions = [];
  // Ids the file itself uses, so a fresh line-N never collides with a later real id.
  const taken = new Set(data.messages.map((m) => (isObject(m) && typeof m.id === 'string' ? m.id : null)).filter(Boolean));
  const seen = new Set();
  let lastTimestamp = validTime(data.createdAt) ? data.createdAt : new Date(0).toISOString();
  let lastSummarySeq = 0;

  data.messages.forEach((raw, index) => {
    const seq = messages.length + 1;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    if (id === null || seen.has(id)) {
      stats.duplicates += 1;
      const base = `line-${index + 1}`;
      id = base;
      for (let n = 2; seen.has(id) || taken.has(id); n += 1) id = `${base}-${n}`;
    }
    seen.add(id);
    const timestamp = validTime(raw.timestamp) ? raw.timestamp : lastTimestamp;
    lastTimestamp = timestamp;

    if (!SENDERS.includes(raw.sender)) {
      const json = JSON.stringify(raw) ?? '';
      stats.unmapped += 1;
      messages.push({
        id, seq, timestamp, sender: 'status', text: `[unmapped ${raw.sender}]`,
        meta: { unmapped: true, rawType: raw.sender, raw: truncate(json, RAW_MAX_CHARS), rawChars: json.length }
      });
      return;
    }

    const message = { id, seq, timestamp, sender: raw.sender };
    const vault = isUnindexedTool(raw);
    if (typeof raw.text === 'string' && !vault) message.text = raw.text;
    else if (raw.sender === 'user' || raw.sender === 'assistant' || raw.sender === 'status') message.text = '';
    if (typeof raw.toolName === 'string') message.toolName = raw.toolName;
    if (raw.parameters !== undefined) message.parameters = vault ? visibleToolParams(raw) : raw.parameters;
    if (raw.result !== undefined) message.result = vault ? '' : raw.result;
    if (Array.isArray(raw.toolCalls)) {
      message.toolCalls = raw.toolCalls.map((c) => (isObject(c) && isUnindexedTool(c) ? { ...c, content: '' } : c));
    }
    const documents = keepAttachments(raw.documents, DOCUMENT_KEYS);
    if (documents) message.documents = documents;
    const images = keepAttachments(raw.images, IMAGE_KEYS);
    if (images) message.images = images;
    if (typeof raw.runId === 'string') message.runId = raw.runId;
    if (typeof raw.stopped === 'boolean') message.stopped = raw.stopped;
    if (isObject(raw.meta)) message.meta = raw.meta;
    messages.push(message);

    if (raw.sender === 'status' && raw.meta?.compaction === true) {
      compactions.push({ atSeq: seq, summarySeq: seq, windowFromSeq: lastSummarySeq + 1, windowToSeq: seq - 1 });
      lastSummarySeq = seq;
    }
  });

  const chat = {
    id: `kl-${typeof data.id === 'string' && data.id ? data.id : path.basename(filePath, path.extname(filePath))}`,
    title: typeof data.title === 'string' && data.title ? data.title : path.basename(filePath, path.extname(filePath)),
    source: KIND,
    createdAt: validTime(data.createdAt) ? data.createdAt : messages[0]?.timestamp ?? null,
    updatedAt: validTime(data.updatedAt) ? data.updatedAt : messages.at(-1)?.timestamp ?? null
  };
  if (isObject(data.llmTotals)) chat.llmTotals = data.llmTotals;
  return { chat, messages, compactions, stats };
}

async function preview(filePath, options) {
  const { chat, messages } = await parse(filePath, options);
  return {
    title: chat.title,
    turns: messages.filter((m) => m.sender === 'user').length,
    sample: messages
      .filter((m) => m.sender === 'user' || m.sender === 'assistant')
      .slice(0, 5)
      .map((m) => ({ seq: m.seq, sender: m.sender, text: m.text.slice(0, 200) }))
  };
}

module.exports = { kind: KIND, version: VERSION, detect, load, exportHasCase, preview, parse };
