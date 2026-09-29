'use strict';
// LongHaul's session format (benchmark spec §4): the recall spec's stored
// message shape (id, sender, text, timestamp, seq plus per-sender fields),
// one message per line in messages.jsonl, and manifest.json.
const fs = require('fs');
const path = require('path');
const { readJsonlLines } = require('../history/importers/jsonl-lines');
const { writeFileAtomic, childPath } = require('./files');
const { UsageError } = require('./errors');

const SENDERS = Object.freeze(['user', 'assistant', 'toolUse', 'toolResult', 'status']);
// Starts with a letter or digit, so '.', '..' and hidden names are refused.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

// Every command validates a session id with this before building a path.
function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new UsageError(`Session id ${JSON.stringify(id)} must match ${SESSION_ID_RE}.`, 'BAD_SESSION_ID');
  }
  return id;
}

function sessionDir(dataRoot, id) {
  const base = path.join(dataRoot, 'sessions');
  return childPath(base, String(id), () => new UsageError(`Session id ${JSON.stringify(id)} leaves ${base}.`, 'BAD_SESSION_ID'));
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
  writeSession, loadSession, listSessions, sessionDir, validateSessionId
};
