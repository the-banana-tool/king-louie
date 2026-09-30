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

// The file is one chat whose messages carry a sender. An unknown sender is
// still ours (parse keeps it as an unmapped status message), so at least one
// stored sender is enough to claim the file.
function readChat(filePath) {
  if (!/\.json$/i.test(filePath)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
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

async function detect(filePath) {
  try { return readChat(filePath) !== null; } catch { return false; }
}

async function parse(filePath) {
  const data = readChat(filePath);
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

module.exports = { kind: KIND, version: VERSION, detect, preview, parse };
