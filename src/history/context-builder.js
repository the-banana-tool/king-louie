// src/history/context-builder.js
// Recall per turn (spec §6): a verbatim tail plus a recalled block of
// excerpts under a budget, and the stats provenance records (§7). upToSeq
// asks at a point in the chat: nothing with seq >= upToSeq is read for the
// tail, the query or retrieval (LongHaul relies on this).
const { mergeHistorySettings } = require('./settings');
const { toolUseSummary, toolResultText } = require('./chunker');
const { formatExcerpts, formatRecalledBlock } = require('./excerpts');

const PAGE = 200;
// Tool results in the tail's span are read newest first, TAIL_RESULT_PAGE
// rows at a time, and never more than TAIL_RESULT_SCAN_MAX rows per turn: an
// agent turn can span hundreds of results, and at the default budget
// (tailTokens 6,000 less the messages, results up to 1,000 tokens each) only
// the newest few are ever shown. A result past the cap is left out of the
// tail like one that does not fit.
const TAIL_RESULT_PAGE = 20;
const TAIL_RESULT_SCAN_MAX = 64;
// The tail scan reads at most this many rows looking for its user messages;
// a user message further back than that is not reached (the tail is then
// empty, and everything in reach stays recallable).
const TAIL_SCAN_MAX_ROWS = 2000;
// The short follow-up fallback adds at most this many previous user messages.
const FALLBACK_MAX_TURNS = 3;
const indexableChars = (text) => (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
// What one image in a tail message is counted as. Providers bill an image by
// its size (Anthropic: about 1,600 tokens for a 1.15-megapixel image); the
// tail has no pixels to hand, so every image counts as this.
const IMAGE_TOKEN_ESTIMATE = 1600;
const documentText = (d) => (d && typeof d.textContent === 'string' ? d.textContent : '');
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

  // vectorHits / lexical pass through to Retriever#retrieve (a caller that
  // ranks by vector itself: LongHaul's kl-recall-vec).
  // reranker, when given, is used by spec §6.3 step 6 for this build only.
  async build({ chatId, message = '', model = null, upToSeq = null, vectorHits = null, lexical = true, reranker = null, vectorOf = null } = {}) {
    const id = String(chatId || '');
    const { recall } = mergeHistorySettings((this.getSettings() || {}).history);
    const given = Number.isInteger(upToSeq) && upToSeq > 0;
    const limit = given ? upToSeq : this.store.lastSeq(id) + 1;
    const scanned = this._scan(id, limit, recall);
    const asOf = this._asOf(id, limit, given, scanned);

    const users = scanned.filter((m) => m.sender === 'user' && hasText(m));
    const previous = users.slice(0, recall.queryUserTurns).map((m) => String(m.text));
    const fallback = this._fallbackTurns(String(message || ''), users.slice(recall.queryUserTurns), recall);
    const asked = [String(message || ''), ...fallback].filter((text) => text.trim()).join('\n');
    const separate = Boolean(recall.queryContextSeparate);
    const query = separate
      ? asked
      : [asked, ...previous].filter((text) => text.trim()).join('\n');
    const contextQueries = separate ? previous : [];
    const tail = this._tail(scanned, { chatId: id, limit, recall, query, model });

    const retrieval = {};
    let recalled = { text: '', chunkIds: [], estTokens: 0 };
    let recalledExcerpts = 0;
    if (recall.enabled && query.trim()) {
      const hits = await this.retriever.retrieve({
        query,
        contextQueries,
        chatIds: [id],
        excludeMessageIds: tail.messageIds,
        budgetTokens: recall.recalledTokens,
        upToSeq: limit,
        settings: recall,
        model,
        now: asOf,
        vectorHits,
        lexical,
        reranker,
        vectorOf,
        stats: retrieval
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
        // The embedder key this turn's vectors came from, and why there were
        // none (spec §7; the recall line reads both).
        embedder: retrieval.embedder || 'none',
        vectorsSkipped: retrieval.vectorsSkipped ?? null,
        scope: 'chat',
        query,
        queryFallbackTurns: fallback.length
      }
    };
  }

  // Newest first, a page at a time, until the tail and the query have the
  // user messages they need, the chat's start, or TAIL_SCAN_MAX_ROWS rows.
  // Only user and assistant rows, and tool calls when they are folded into
  // the tail. Tool results are read later, for the tail's span only (_tail).
  _scan(chatId, limit, recall) {
    const out = [];
    let users = 0;
    let before = limit;
    const need = Math.max(recall.tailUserTurns, recall.queryUserTurns + (recall.queryFallbackMinChars > 0 ? FALLBACK_MAX_TURNS : 0));
    while (before > 1 && users < need && out.length < TAIL_SCAN_MAX_ROWS) {
      const page = this.store.tailScanPage(chatId, {
        beforeSeq: before, limit: PAGE, toolCalls: Boolean(recall.tailIncludeToolCalls)
      });
      if (!page.length) break;
      for (const m of page) {
        out.push(m);
        if (m.sender === 'user' && hasText(m)) users += 1;
      }
      before = page[page.length - 1].seq;
    }
    return out;
  }

  // Spec §6.2: a new message too short to search on also searches with the
  // previous user messages, newest first, until the query has
  // queryFallbackMinChars letters and digits or FALLBACK_MAX_TURNS are added.
  _fallbackTurns(message, candidates, recall) {
    const min = recall.queryFallbackMinChars;
    let chars = indexableChars(message);
    if (!(min > 0) || chars >= min) return [];
    const out = [];
    for (const m of candidates) {
      if (out.length >= FALLBACK_MAX_TURNS || chars >= min) break;
      out.push(String(m.text));
      chars += indexableChars(m.text);
    }
    return out;
  }

  _asOf(chatId, limit, given, scanned) {
    if (!given) return this.now();
    const [at] = this.store.getMessages(chatId, { fromSeq: limit, toSeq: limit });
    const ts = Date.parse((at && at.timestamp) || (scanned[0] && scanned[0].timestamp) || '');
    return Number.isFinite(ts) ? ts : this.now();
  }

  _tail(scanned, { chatId, limit, recall, query, model }) {
    const content = scanned.filter(isContent);
    // Turns, newest first: a user message and the content rows after it.
    const turns = [];
    let rows = [];
    for (const m of content) {
      rows.push(m);
      if (m.sender !== 'user') continue;
      turns.push(rows.reverse());
      rows = [];
      if (turns.length >= recall.tailUserTurns) break;
    }
    // The newest turn: its user message always, then its replies newest
    // first while they fit tailTokens and tailMaxRows. Older turns come
    // whole while they fit. The tail starts at a user message (Mistral and
    // Gemini reject anything else); what is left out stays recallable.
    const entries = [];
    let used = 0;
    let userTurns = 0;
    if (turns.length) {
      const [newest, ...older] = turns;
      const user = this._entry(newest[0], { recall, query, model });
      used = user.tokens;
      const replies = [];
      for (const m of newest.slice(1).reverse()) {
        if (1 + replies.length >= recall.tailMaxRows) break;
        const e = this._entry(m, { recall, query, model });
        if (used + e.tokens > recall.tailTokens) break;
        replies.unshift(e);
        used += e.tokens;
      }
      entries.push(user, ...replies);
      userTurns = 1;
      for (const turn of older) {
        if (entries.length + turn.length > recall.tailMaxRows) break;
        const es = turn.map((m) => this._entry(m, { recall, query, model }));
        const tokens = es.reduce((n, e) => n + e.tokens, 0);
        if (used + tokens > recall.tailTokens) break;
        entries.unshift(...es);
        used += tokens;
        userTurns += 1;
      }
    }

    // Tool calls and results fold into the reply that followed them: the
    // content row right after them in the chat must be a shown assistant
    // reply. A call whose reply was left out (the newest turn keeps only its
    // newest replies) is not given to a later one.
    const chronological = [...content].reverse();
    const shownAt = new Map(entries.map((e, i) => [e.message.seq, i]));
    const firstAfter = (seq) => {
      let lo = 0;
      let hi = chronological.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (chronological[mid].seq > seq) hi = mid;
        else lo = mid + 1;
      }
      return lo < chronological.length ? chronological[lo] : null;
    };
    const replyIndex = (seq) => {
      const next = firstAfter(seq);
      if (!next || next.sender !== 'assistant' || !shownAt.has(next.seq)) return -1;
      return shownAt.get(next.seq);
    };
    const folded = new Map();
    const fold = (i, seq, line) => {
      if (!folded.has(i)) folded.set(i, []);
      folded.get(i).push({ seq, line });
    };
    // What a folded line adds to its reply's text, joiner included: the
    // lines are joined by '\n' and the reply follows them after '\n\n', so
    // the first line folded into a reply costs two more characters and each
    // later one one more. The tail's total is at most the entries' own
    // tokens plus these.
    const foldCost = (i, line) => this.estimator.estimate(`${folded.has(i) ? '\n' : '\n\n'}${line}`, model);
    const foldedSeqs = [];
    let callTokens = 0;
    if (recall.tailIncludeToolCalls && entries.length) {
      const from = entries[0].message.seq;
      const toolUses = scanned.filter((m) => m.sender === 'toolUse' && m.seq > from).sort((a, b) => a.seq - b.seq);
      for (const call of toolUses) {
        const next = replyIndex(call.seq);
        if (next === -1) continue;
        const line = `[tool] ${toolUseSummary(call)}`;
        callTokens += foldCost(next, line);
        fold(next, call.seq, line);
        foldedSeqs.push(call.seq);
      }
    }
    const results = recall.tailIncludeToolResults && entries.length
      ? this._toolResults({
        chatId,
        afterSeq: entries[0].message.seq,
        beforeSeq: limit,
        left: recall.tailTokens - callTokens - entries.reduce((n, e) => n + e.tokens, 0),
        replyIndex, recall, model,
        cost: foldCost,
        take: fold
      })
      : [];

    const messages = entries.map((e, i) => {
      const lines = folded.get(i);
      const head = lines ? lines.sort((a, b) => a.seq - b.seq).map((x) => x.line).join('\n') : '';
      const text = lines ? `${head}\n\n${e.text}` : e.text;
      return e.documents ? { ...e.message, text, documents: e.documents } : { ...e.message, text };
    });
    const resultSeqs = results.map((r) => r.message.seq).sort((a, b) => a - b);
    return {
      messages,
      messageIds: [...entries.map((e) => e.message.id), ...results.map((r) => r.message.id)],
      estTokens: messages.reduce((n, m) => n + this.estimator.estimate(m.text, model) + this._attachmentTokens(m, model), 0),
      stats: entries.length
        ? {
          fromSeq: entries[0].message.seq,
          toSeq: entries[entries.length - 1].message.seq,
          userTurns,
          seqs: [...entries.map((e) => e.message.seq), ...foldedSeqs, ...resultSeqs].sort((a, b) => a - b),
          shortened: [...entries.filter((e) => e.shortened).map((e) => e.shortened), ...results.filter((r) => r.shortened).map((r) => r.shortened)]
            .sort((a, b) => a.seq - b.seq),
          ...(recall.tailIncludeToolResults ? { toolResultSeqs: resultSeqs } : {})
        }
        : { fromSeq: null, toSeq: null, seqs: [], shortened: [], userTurns: 0 }
    };
  }

  // tailIncludeToolResults: tool results in the tail's span, folded like
  // tool calls into the reply that follows them (take). They get what the
  // user and assistant messages and the tool lines left of tailTokens, each
  // counted as cost gives it (joiner, label, body and note), newest first,
  // so a tool dump never pushes a user turn out. A result over
  // tailToolResultMaxTokens keeps its head, with a note, and is recorded in
  // stats.tail.shortened (shown: the leading chunks that fit whole); a
  // result that does not fit what is left is skipped and an older one tried.
  // The span's results are read a page at a time (HistoryStore#
  // tailToolResults), newest first, until what is left cannot fit even the
  // smallest result or TAIL_RESULT_SCAN_MAX rows have been examined.
  _toolResults({ chatId, afterSeq, beforeSeq, left, replyIndex, recall, model, cost, take }) {
    const out = [];
    let budget = left;
    // No result costs less than a joiner, a label and one character of body.
    const smallest = this.estimator.estimate('\n[tool result #1]\nx', model);
    let examined = 0;
    let before = beforeSeq;
    while (budget >= smallest && examined < TAIL_RESULT_SCAN_MAX) {
      const page = this.store.tailToolResults(chatId, {
        afterSeq, beforeSeq: before, limit: Math.min(TAIL_RESULT_PAGE, TAIL_RESULT_SCAN_MAX - examined)
      });
      if (!page.length) break;
      examined += page.length;
      before = page[page.length - 1].seq;
      for (const m of page) {
        if (budget < smallest) break;
        const r = this._toolResult(m, { replyIndex, recall, model });
        if (!r) continue;
        const tokens = cost(r.index, r.text);
        if (tokens > budget) continue;
        budget -= tokens;
        take(r.index, m.seq, r.text);
        if (r.shortened) r.shortened = this._shortenedResult(m, r.shortened);
        out.push(r);
      }
    }
    return out;
  }

  // One tool result as the tail shows it (null when it is not shown); a
  // shortened one carries how many characters of its body it keeps.
  _toolResult(m, { replyIndex, recall, model }) {
    const index = replyIndex(m.seq);
    if (index === -1) return null;
    const full = toolResultText(m);
    if (!full.trim()) return null;
    const label = `[tool result #${m.seq}${m.toolName ? ` ${m.toolName}` : ''}]`;
    let text = `${label}\n${full}`;
    let shortened = null;
    if (this.estimator.estimate(full, model) > recall.tailToolResultMaxTokens) {
      const chars = Math.max(1, Math.floor(recall.tailToolResultMaxTokens * this.estimator.charsPerToken(model)));
      text = `${label}\n${full.slice(0, chars)}\n[tool result #${m.seq} shortened: the start is shown; ReadHistory ${m.seq} for the rest]`;
      shortened = { headChars: Math.min(chars, full.length) };
    }
    return { message: m, index, text, shortened };
  }

  // stats.tail.shortened for a shown, shortened result (shown: the leading
  // chunks that fit whole in its head).
  _shortenedResult(m, { headChars }) {
    const own = this.store.chunksOfMessage(m.id).filter((c) => c.kind === 'tool_result');
    let shown = 0;
    let covered = 0;
    for (const c of own) {
      covered += c.text.length + (shown ? 2 : 0);
      if (covered > headChars) break;
      shown += 1;
    }
    return { seq: m.seq, shown, total: Math.max(own.length, 1), toolResult: true };
  }

  // Document text and images are sent with a tail message every turn, so
  // they count toward its estimate.
  _attachmentTokens(m, model) {
    const images = Array.isArray(m.images) ? m.images.length : 0;
    const docs = Array.isArray(m.documents) ? m.documents : [];
    return images * IMAGE_TOKEN_ESTIMATE + docs.reduce((n, d) => n + this.estimator.estimate(documentText(d), model), 0);
  }

  // A tail message's text (shortened over the per-message cap, spec §6.1),
  // then its documents: when they push it over the cap, each document's text
  // is cut to an even share of what is left, head kept, with a note (they
  // are indexed as attachment chunks). Images are never dropped.
  _entry(m, { recall, query, model }) {
    const entry = this._textEntry(m, { recall, query, model });
    const cap = recall.tailMaxMessageTokens;
    const imageTokens = (Array.isArray(m.images) ? m.images.length : 0) * IMAGE_TOKEN_ESTIMATE;
    const docs = Array.isArray(m.documents) ? m.documents : [];
    const docTokens = docs.reduce((n, d) => n + this.estimator.estimate(documentText(d), model), 0);
    if (!docTokens || entry.tokens + docTokens + imageTokens <= cap) {
      return { ...entry, tokens: entry.tokens + docTokens + imageTokens };
    }
    const withText = docs.filter((d) => documentText(d)).length;
    const share = Math.max(0, Math.floor((cap - entry.tokens - imageTokens) / withText));
    let cut = 0;
    const documents = docs.map((d) => {
      const full = documentText(d);
      if (!full || this.estimator.estimate(full, model) <= share) return d;
      cut += 1;
      const chars = Math.floor(share * this.estimator.charsPerToken(model));
      const note = `[document "${(d && d.name) || 'document'}" in message #${m.seq} shortened: the start is shown; SearchHistory finds the rest]`;
      return { ...d, textContent: chars > 0 ? `${full.slice(0, chars)}\n\n${note}` : note };
    });
    const shortTokens = documents.reduce((n, d) => n + this.estimator.estimate(documentText(d), model), 0);
    return {
      ...entry,
      documents,
      tokens: entry.tokens + shortTokens + imageTokens,
      shortened: cut ? { ...(entry.shortened || { seq: m.seq }), documents: cut } : entry.shortened
    };
  }

  _textEntry(m, { recall, query, model }) {
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

module.exports = { ContextBuilder, IMAGE_TOKEN_ESTIMATE, TAIL_RESULT_PAGE, TAIL_RESULT_SCAN_MAX, TAIL_SCAN_MAX_ROWS, FALLBACK_MAX_TURNS };
