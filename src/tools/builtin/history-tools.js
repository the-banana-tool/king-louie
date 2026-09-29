// src/tools/builtin/history-tools.js
// SearchHistory and ReadHistory (recall spec §8): read-only, always loaded,
// for anything the turn's recalled block left out. The history scope is
// this chat until H4 adds linked and all chats; a scope argument can only
// narrow it, so here it changes nothing.
const { Tool } = require('../tool-schema');
const { mergeHistorySettings } = require('../../history/settings');
const { searchHistoryExcerpts } = require('../../history/search');
const { renderToolResult } = require('../../history/chunker');
const { TokenEstimator } = require('../../history/token-estimator');

const KINDS = ['user', 'assistant', 'tool_use', 'tool_result', 'attachment', 'summary'];
const NO_CHAT = 'History tools work only inside a chat.';
const PAGE = 100;

function historyOf(context) {
  const h = context && context.history;
  return h && h.store && h.chatId ? h : null;
}

function settingsOf(h) {
  const all = typeof h.getSettings === 'function' ? h.getSettings() : {};
  return mergeHistorySettings((all || {}).history);
}

function label(m) {
  if (m.sender === 'toolUse') return `${m.toolName || 'tool'} call`;
  if (m.sender === 'toolResult') return `${m.toolName || 'tool'} result`;
  return m.sender;
}

function renderForRead(m) {
  let body;
  if (m.sender === 'toolUse') body = JSON.stringify(m.parameters || {}, null, 2);
  else if (m.sender === 'toolResult') body = renderToolResult(m.result);
  else body = String(m.text || '');
  const extras = [
    ...(Array.isArray(m.images) ? m.images : []).map((i) => `[image${i && i.name ? `: ${i.name}` : ''}]`),
    ...(Array.isArray(m.documents) ? m.documents : []).map((d) => `[document${d && d.name ? `: ${d.name}` : ''}]`)
  ];
  return [`[#${m.seq} · ${label(m)} · ${m.timestamp || 'unknown time'}]`, body, ...extras].filter((s) => s !== '').join('\n');
}

const searchHistoryTool = new Tool({
  name: 'SearchHistory',
  description: "Search this chat's full history (every message, tool call and tool result, kept verbatim) by keywords. Returns excerpts with their message numbers (#seq). Quote a phrase to match it exactly. Read a range in full with ReadHistory.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, or a "quoted phrase".' },
      scope: { type: 'string', enum: ['chat', 'linked', 'all'], description: "Which chats to search. It can only narrow this chat's own history scope, which is this chat." },
      kinds: { type: 'array', items: { type: 'string', enum: KINDS }, description: 'Only these kinds of chunk.' },
      limit: { type: 'number', default: 10, description: 'Most excerpts to return (1 to 50).' }
    },
    required: ['query']
  },
  requiresApproval: false,
  concurrencySafe: true,
  execute: async (params, context) => {
    const h = historyOf(context);
    if (!h) return { ok: false, error: NO_CHAT };
    const query = String(params.query || '').trim();
    if (!query) return { ok: false, error: 'query is required.' };
    const limit = Math.min(50, Math.max(1, Math.floor(Number(params.limit) || 10)));
    const kinds = Array.isArray(params.kinds) ? params.kinds.filter((k) => KINDS.includes(k)) : [];
    const excerpts = await searchHistoryExcerpts({
      store: h.store,
      retriever: h.retriever,
      chatId: h.chatId,
      query,
      kinds: kinds.length ? kinds : null,
      limit,
      settings: settingsOf(h).recall
    });
    return {
      ok: true,
      scope: 'chat',
      excerpts: excerpts.map((e) => ({ seq: e.seq, header: e.header, text: e.text })),
      ...(excerpts.length ? {} : { note: 'No matches in this chat. Try other words, or ReadHistory for a range.' })
    };
  }
});

const readHistoryTool = new Tool({
  name: 'ReadHistory',
  description: 'Read messages of this chat by number (#seq), verbatim, tool calls and results included. A long range stops at a token cap with a note saying where to continue.',
  parameters: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: 'Leave out: only this chat can be read.' },
      fromSeq: { type: 'integer', description: 'First message number.' },
      toSeq: { type: 'integer', description: 'Last message number, inclusive.' }
    },
    required: ['fromSeq', 'toSeq']
  },
  requiresApproval: false,
  concurrencySafe: true,
  execute: async (params, context) => {
    const h = historyOf(context);
    if (!h) return { ok: false, error: NO_CHAT };
    if (params.chatId && String(params.chatId) !== h.chatId) {
      return { ok: false, error: `ReadHistory can read only this chat (${h.chatId}): this chat's history scope is "chat".` };
    }
    const fromSeq = Number(params.fromSeq);
    const toSeq = Number(params.toSeq);
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
      return { ok: false, error: 'fromSeq and toSeq must be whole numbers with 1 <= fromSeq <= toSeq.' };
    }
    const last = h.store.lastSeq(h.chatId);
    if (fromSeq > last) return { ok: false, error: `This chat has ${last} messages.` };

    const cap = settingsOf(h).readHistoryMaxTokens;
    const estimator = h.estimator || new TokenEstimator();
    const end = Math.min(toSeq, last);
    const blocks = [];
    let used = 0;
    let shown = fromSeq - 1;
    let cutSeq = null;
    let truncated = false;
    for (let start = fromSeq; start <= end && !truncated; start += PAGE) {
      for (const m of h.store.getMessages(h.chatId, { fromSeq: start, toSeq: Math.min(end, start + PAGE - 1) })) {
        const block = renderForRead(m);
        const tokens = estimator.estimate(block);
        if (used + tokens > cap) {
          if (!blocks.length) {
            // One message bigger than the whole cap: show its start.
            blocks.push(block.slice(0, Math.max(1, Math.floor(cap * estimator.charsPerToken()))));
            shown = m.seq;
            cutSeq = m.seq;
          }
          truncated = true;
          break;
        }
        blocks.push(block);
        used += tokens;
        shown = m.seq;
      }
    }
    const note = !truncated ? null
      : (cutSeq !== null
        ? `Message #${cutSeq} was cut at ${cap} tokens.`
        : `Stopped at #${shown} to stay under ${cap} tokens; call ReadHistory from ${shown + 1} for the rest.`);
    return { ok: true, chatId: h.chatId, fromSeq, toSeq: shown, text: blocks.join('\n\n'), truncated, ...(note ? { note } : {}) };
  }
});

function registerHistoryTools(registry) {
  registry.register(searchHistoryTool);
  registry.register(readHistoryTool);
}

module.exports = { registerHistoryTools, searchHistoryTool, readHistoryTool };
