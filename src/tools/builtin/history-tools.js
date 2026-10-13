// src/tools/builtin/history-tools.js
// SearchHistory and ReadHistory (recall spec §8): read-only, always loaded,
// for anything the turn's recalled block left out. Which chats they read is
// the chat's history scope (stage H4), resolved on every call by
// context.history.resolveScope from what is stored; only the chat's own turn
// has one, and without it they read this chat alone. A scope argument can
// only narrow, and no parameter names a chat outside the scope.
const { Tool } = require('../tool-schema');
const { mergeHistorySettings } = require('../../history/settings');
const { searchHistoryExcerpts } = require('../../history/search');
const { visibleToolParams, toolResultText } = require('../../history/chunker');
const { senderLabel, chatHeaderTitle } = require('../../history/excerpts');
const { SCOPES } = require('../../history/scope');
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

// The chats this call may read, this chat first. An answer from the
// resolver that is not a list starting with this chat is this chat alone.
function scopeOf(h, requested = null) {
  const alone = { effective: 'chat', chatIds: [h.chatId], titles: new Map() };
  if (typeof h.resolveScope !== 'function') return alone;
  const r = h.resolveScope(h.chatId, SCOPES.includes(requested) ? requested : null);
  if (!r || !Array.isArray(r.chatIds) || r.chatIds[0] !== h.chatId || !SCOPES.includes(r.effective)) return alone;
  return {
    effective: r.effective,
    chatIds: [...new Set(r.chatIds.filter((id) => typeof id === 'string' && id))],
    titles: r.titles instanceof Map ? r.titles : new Map()
  };
}

// Before a result holding another chat's text is returned, the chat is
// marked as having read other chats (R-H4-1: it can then never be given a
// case). The result row may never be stored (the turn is stopped or fails),
// so the mark is written here, where the text is handed over. False when it
// could not be written: the caller then returns none of the text.
const MARK_FAILED = 'That this chat read another chat could not be recorded, so nothing from other chats is returned.';
function markReadOtherChats(h) {
  try {
    return typeof h.store.markRecalledOtherChats === 'function' && h.store.markRecalledOtherChats(h.chatId) === true;
  } catch {
    return false;
  }
}

const NO_MATCH = {
  chat: 'No matches in this chat. Try other words, or ReadHistory for a range.',
  linked: 'No matches in this chat or the chats linked to it. Try other words, or ReadHistory for a range.',
  all: 'No matches in any chat this chat may read. Try other words, or ReadHistory for a range.'
};

// chatLabel: the header part naming another chat (a read of this chat has none).
function renderForRead(m, chatLabel = '') {
  let body;
  // The text the chunker indexes; an unindexed tool (Vault) shows its
  // action and key, and no result.
  if (m.sender === 'toolUse') body = JSON.stringify(visibleToolParams(m), null, 2);
  else if (m.sender === 'toolResult') body = toolResultText(m);
  else body = String(m.text || '');
  const extras = [
    ...(Array.isArray(m.images) ? m.images : []).map((i) => `[image${i && i.name ? `: ${i.name}` : ''}]`),
    ...(Array.isArray(m.documents) ? m.documents : []).map((d) => `[document${d && d.name ? `: ${d.name}` : ''}]`)
  ];
  return [`[${chatLabel}#${m.seq} · ${senderLabel(m)} · ${m.timestamp || 'unknown time'}]`, body, ...extras].filter((s) => s !== '').join('\n');
}

const searchHistoryTool = new Tool({
  name: 'SearchHistory',
  description: 'Search the history this chat may read (this chat, and other chats when the owner has allowed it) by keywords. Returns excerpts with their message numbers (#seq). Quote a phrase to match it exactly. Read a range in full with ReadHistory.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, or a "quoted phrase".' },
      scope: { type: 'string', enum: ['chat', 'linked', 'all'], description: 'Which chats to search. It can only narrow the scope the owner gave this chat.' },
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
    const asked = SCOPES.includes(params.scope) ? params.scope : null;
    const scope = scopeOf(h, asked);
    const excerpts = await searchHistoryExcerpts({
      store: h.store,
      retriever: h.retriever,
      chatId: h.chatId,
      chatIds: scope.chatIds,
      chatTitles: scope.titles,
      query,
      kinds: kinds.length ? kinds : null,
      limit,
      settings: settingsOf(h).recall,
      reranker: typeof h.reranker === 'function' ? h.reranker : null
    });
    if (excerpts.some((e) => e.chatId !== h.chatId) && !markReadOtherChats(h)) return { ok: false, error: MARK_FAILED };
    // Asked for more than the chat has (only where a scope is resolved):
    // say so, since the argument changed nothing.
    const notes = [];
    if (!excerpts.length) notes.push(NO_MATCH[scope.effective]);
    if (typeof h.resolveScope === 'function' && asked && SCOPES.indexOf(asked) > SCOPES.indexOf(scope.effective)) {
      notes.push(`This chat's history scope is "${scope.effective}"; only the owner can widen it in the app.`);
    }
    return {
      ok: true,
      scope: scope.effective,
      // An excerpt from another chat names it; one from this chat does not.
      excerpts: excerpts.map((e) => ({
        seq: e.seq,
        header: e.header,
        text: e.text,
        ...(e.chatId !== h.chatId ? { chatId: e.chatId, chatTitle: chatHeaderTitle(scope.titles.get(e.chatId), e.chatId) } : {})
      })),
      ...(notes.length ? { note: notes.join(' ') } : {})
    };
  }
});

const readHistoryTool = new Tool({
  name: 'ReadHistory',
  description: 'Read messages of this chat by number (#seq), verbatim, tool calls and results included. A long range stops at a token cap with a note saying where to continue.',
  parameters: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: "Leave out for this chat. Another chat's id only when a SearchHistory excerpt gave it." },
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
    // Another chat is read only when it is in this chat's scope as stored
    // now; anything else is refused before a row of it is read (spec §15).
    const chatId = params.chatId === undefined || params.chatId === null || params.chatId === '' ? h.chatId : String(params.chatId);
    const other = chatId !== h.chatId;
    let chatTitle = null;
    if (other) {
      if (typeof h.resolveScope !== 'function') {
        return { ok: false, error: `ReadHistory can read only this chat (${h.chatId}): this chat's history scope is "chat".` };
      }
      const scope = scopeOf(h);
      if (!scope.chatIds.includes(chatId)) {
        return { ok: false, error: `ReadHistory can read only chats in this chat's history scope ("${scope.effective}").` };
      }
      chatTitle = chatHeaderTitle(scope.titles.get(chatId), chatId);
      if (!markReadOtherChats(h)) return { ok: false, error: MARK_FAILED };
    }
    const chatLabel = other ? `chat "${chatTitle}" · ` : '';
    const fromSeq = Number(params.fromSeq);
    const toSeq = Number(params.toSeq);
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
      return { ok: false, error: 'fromSeq and toSeq must be whole numbers with 1 <= fromSeq <= toSeq.' };
    }
    const last = h.store.lastSeq(chatId);
    if (fromSeq > last) return { ok: false, error: `${other ? 'That' : 'This'} chat has ${last} messages.` };

    const cap = settingsOf(h).readHistoryMaxTokens;
    const estimator = h.estimator || new TokenEstimator();
    const end = Math.min(toSeq, last);
    const blocks = [];
    let used = 0;
    let shown = fromSeq - 1;
    let cutSeq = null;
    let truncated = false;
    for (let start = fromSeq; start <= end && !truncated; start += PAGE) {
      for (const m of h.store.getMessages(chatId, { fromSeq: start, toSeq: Math.min(end, start + PAGE - 1) })) {
        const block = renderForRead(m, chatLabel);
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
    return { ok: true, chatId, ...(other ? { chatTitle } : {}), fromSeq, toSeq: shown, text: blocks.join('\n\n'), truncated, ...(note ? { note } : {}) };
  }
});

function registerHistoryTools(registry) {
  registry.register(searchHistoryTool);
  registry.register(readHistoryTool);
}

module.exports = { registerHistoryTools, searchHistoryTool, readHistoryTool };
