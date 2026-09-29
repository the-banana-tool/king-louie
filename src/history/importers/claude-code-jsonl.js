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
