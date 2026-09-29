// src/history/context-builder.js
// Recall per turn (spec §6): a verbatim tail plus a recalled block of
// excerpts under a budget, and the stats provenance records (§7). upToSeq
// asks at a point in the chat: nothing with seq >= upToSeq is read for the
// tail, the query or retrieval (LongHaul relies on this).
const { mergeHistorySettings } = require('./settings');
const { toolUseSummary } = require('./chunker');
const { formatExcerpts, formatRecalledBlock } = require('./excerpts');

const PAGE = 200;
const hasText = (m) => String((m && m.text) || '').trim().length > 0;
// A stopped reply with no text stays out: some providers reject an empty turn.
const isContent = (m) => (m.sender === 'user' || m.sender === 'assistant') && !(m.stopped && !hasText(m));

class ContextBuilder {
  constructor({ store, retriever, estimator, getSettings = () => ({}), now = () => Date.now() } = {}) {
    this.store = store;
    this.retriever = retriever;
    this.estimator = estimator;
    this.getSettings = getSettings;
    this.now = now;
  }

  async build({ chatId, message = '', model = null, upToSeq = null } = {}) {
    const id = String(chatId || '');
    const { recall } = mergeHistorySettings((this.getSettings() || {}).history);
    const given = Number.isInteger(upToSeq) && upToSeq > 0;
    const limit = given ? upToSeq : this.store.lastSeq(id) + 1;
    const scanned = this._scan(id, limit, recall);
    const asOf = this._asOf(id, limit, given, scanned);

    const previous = scanned.filter((m) => m.sender === 'user' && hasText(m)).slice(0, recall.queryUserTurns).map((m) => String(m.text));
    const query = [String(message || ''), ...previous].filter((text) => text.trim()).join('\n');
    const tail = this._tail(scanned, { recall, query, model });

    let recalled = { text: '', chunkIds: [], estTokens: 0 };
    let recalledExcerpts = 0;
    if (recall.enabled && query.trim()) {
      const hits = await this.retriever.retrieve({
        query,
        chatIds: [id],
        excludeMessageIds: tail.messageIds,
        budgetTokens: recall.recalledTokens,
        upToSeq: limit,
        settings: recall,
        model,
        now: asOf
      });
      if (hits.length) {
        const chunks = hits.map((h) => h.chunk);
        const chunkCounts = this.store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
        const excerpts = formatExcerpts(chunks, { chatId: id, asOf, chunkCounts });
        const text = formatRecalledBlock(excerpts);
        recalled = { text, chunkIds: excerpts.flatMap((e) => e.chunkIds), estTokens: this.estimator.estimate(text, model) };
        recalledExcerpts = excerpts.length;
      }
    }

    return {
      tail: tail.messages,
      recalled,
      stats: {
        tail: tail.stats,
        recalledChunkIds: recalled.chunkIds,
        recalledExcerpts,
        estTokens: { tail: tail.estTokens, recalled: recalled.estTokens },
        fullHistoryEstTokens: this.estimator.fromChars(this.store.historyChars(id, { upToSeq: limit }), model),
        embedder: 'none',
        scope: 'chat',
        query
      }
    };
  }

  // Newest first, every sender, a page at a time, until the tail and the
  // query have what they need or the chat's start is reached.
  _scan(chatId, limit, recall) {
    const out = [];
    let content = 0;
    let users = 0;
    let toSeq = limit - 1;
    while (toSeq >= 1 && (content < recall.tailMessages || users < recall.queryUserTurns)) {
      const fromSeq = Math.max(1, toSeq - PAGE + 1);
      const page = this.store.getMessages(chatId, { fromSeq, toSeq })
        .filter((m) => m.seq < limit)
        .sort((a, b) => b.seq - a.seq);
      for (const m of page) {
        out.push(m);
        if (isContent(m)) content += 1;
        if (m.sender === 'user' && hasText(m)) users += 1;
      }
      toSeq = fromSeq - 1;
    }
    return out;
  }

  _asOf(chatId, limit, given, scanned) {
    if (!given) return this.now();
    const [at] = this.store.getMessages(chatId, { fromSeq: limit, toSeq: limit });
    const ts = Date.parse((at && at.timestamp) || (scanned[0] && scanned[0].timestamp) || '');
    return Number.isFinite(ts) ? ts : this.now();
  }

  _tail(scanned, { recall, query, model }) {
    const entries = [];
    let used = 0;
    for (const m of scanned) {
      if (entries.length >= recall.tailMessages) break;
      if (!isContent(m)) continue;
      const entry = this._entry(m, { recall, query, model });
      if (entries.length > 0 && used + entry.tokens > recall.tailTokens) break;
      entries.push(entry);
      used += entry.tokens;
    }
    entries.reverse();

    // Tool calls in the tail's span, one line each at the top of the
    // assistant reply that follows them before the next user message.
    const folded = new Map();
    const foldedSeqs = [];
    if (recall.tailIncludeToolCalls && entries.length) {
      const from = entries[0].message.seq;
      const toolUses = scanned.filter((m) => m.sender === 'toolUse' && m.seq > from).sort((a, b) => a.seq - b.seq);
      for (const call of toolUses) {
        const next = entries.findIndex((e) => e.message.seq > call.seq);
        if (next === -1 || entries[next].message.sender !== 'assistant') continue;
        if (!folded.has(next)) folded.set(next, []);
        folded.get(next).push(`[tool] ${toolUseSummary(call)}`);
        foldedSeqs.push(call.seq);
      }
    }

    const messages = entries.map((e, i) => {
      const lines = folded.get(i);
      return { ...e.message, text: lines ? `${lines.join('\n')}\n\n${e.text}` : e.text };
    });
    return {
      messages,
      messageIds: entries.map((e) => e.message.id),
      estTokens: messages.reduce((n, m) => n + this.estimator.estimate(m.text, model), 0),
      stats: entries.length
        ? {
          fromSeq: entries[0].message.seq,
          toSeq: entries[entries.length - 1].message.seq,
          seqs: [...entries.map((e) => e.message.seq), ...foldedSeqs].sort((a, b) => a - b),
          shortened: entries.filter((e) => e.shortened).map((e) => e.shortened)
        }
        : { fromSeq: null, toSeq: null, seqs: [], shortened: [] }
    };
  }

  _entry(m, { recall, query, model }) {
    const text = String(m.text || '');
    const tokens = this.estimator.estimate(text, model);
    if (tokens <= recall.tailMaxMessageTokens) return { message: m, text, tokens, shortened: null };

    // Over the per-message cap: the chunks that best match this turn's
    // query, in their own order, then the marker (spec §6.1).
    const own = this.store.chunksOfMessage(m.id).filter((c) => c.kind === m.sender);
    if (!own.length) {
      const chars = Math.max(1, Math.floor(recall.tailMaxMessageTokens * this.estimator.charsPerToken(model)));
      const cut = `${text.slice(0, chars)}\n\n[message #${m.seq} shortened: the start is shown; ReadHistory ${m.seq} for the rest]`;
      return { message: m, text: cut, tokens: this.estimator.estimate(cut, model), shortened: { seq: m.seq, shown: 1, total: 1 } };
    }
    const hits = query.trim() ? this.store.searchText(query, { messageIds: [m.id], kinds: [m.sender], limit: own.length }) : [];
    const rank = new Map(hits.map((h, i) => [h.chunkId, i]));
    const order = [...own].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.idx - b.idx;
    });
    const picked = [];
    let used = 0;
    for (const c of order) {
      const t = this.estimator.estimate(c.text, model);
      if (picked.length && used + t > recall.tailMaxMessageTokens) continue;
      picked.push(c);
      used += t;
    }
    picked.sort((a, b) => a.idx - b.idx);
    const marker = `[message #${m.seq} shortened: ${picked.length} of ${own.length} paragraphs shown; ReadHistory ${m.seq} for the rest]`;
    const shortText = `${picked.map((c) => c.text).join('\n\n')}\n\n${marker}`;
    return {
      message: m,
      text: shortText,
      tokens: this.estimator.estimate(shortText, model),
      shortened: { seq: m.seq, shown: picked.length, total: own.length }
    };
  }
}

module.exports = { ContextBuilder };
