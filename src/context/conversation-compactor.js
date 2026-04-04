const VectorStore = require('../memory/vector-store');

/**
 * ConversationCompactor — chunk-level semantic retrieval over conversation history.
 *
 * Instead of sending the entire conversation to the LLM, this module
 * splits every message into paragraph-sized chunks, embeds them, then
 * retrieves only the chunks relevant to the current query.  A single
 * 50K-token message about Egyptian mummies produces ~100 chunks, but
 * only the 3-4 paragraphs about linen wrapping are returned.
 *
 * Flow:
 *  1. Messages are split into chunks (~300-500 tokens each)
 *  2. Chunks are embedded incrementally (batched API calls)
 *  3. On query: embed query → cosine search → deduplicate chunks
 *  4. Return: synthetic messages built from relevant chunks + recent messages
 *
 * Cost: ~$0.002 per retrieval cycle (text-embedding-3-small).
 * The search itself is pure local cosine similarity — no LLM call.
 */

// Don't activate compaction until total estimated tokens exceed this.
const COMPACTION_TOKEN_THRESHOLD = 6000;

// Approximate tokens per character (English prose ≈ 1 token per 4 chars).
const CHARS_PER_TOKEN = 4;

// Target size for each chunk in characters (~300–500 tokens).
const CHUNK_TARGET_CHARS = 1500;

class ConversationCompactor {
  /**
   * @param {object} options
   * @param {object} options.embeddingProvider - OpenAIEmbeddingProvider instance
   */
  constructor(options = {}) {
    this.embeddingProvider = options.embeddingProvider || null;

    // chunkId → embedding vector
    this._vectors = {};

    // chunkId → { messageId, sender, text, timestamp }
    this._chunks = {};

    // messageId → true (tracks which messages have been chunked)
    this._chunkedMessages = {};
  }

  // ─── Chunking ────────────────────────────────────────────────────────────

  /**
   * Split a message into paragraph-sized chunks.
   * Splits on double-newlines first, then on single newlines if a
   * paragraph is still too large.  Each chunk retains a reference
   * back to its source message.
   */
  _chunkMessage(msg) {
    const text = String(msg.text || '');
    if (!text.trim()) return [];

    // Split on blank lines (paragraph boundaries)
    let rawParagraphs = text.split(/\n\s*\n/).filter(p => p.trim());

    // Further split oversized paragraphs on single newlines
    const paragraphs = [];
    for (const para of rawParagraphs) {
      if (para.length <= CHUNK_TARGET_CHARS) {
        paragraphs.push(para.trim());
      } else {
        const lines = para.split(/\n/).filter(l => l.trim());
        let buf = '';
        for (const line of lines) {
          if (buf.length + line.length + 1 > CHUNK_TARGET_CHARS && buf) {
            paragraphs.push(buf.trim());
            buf = '';
          }
          buf += (buf ? '\n' : '') + line;
        }
        if (buf.trim()) paragraphs.push(buf.trim());
      }
    }

    // If still too big (wall-of-text with no newlines), hard-split
    const chunks = [];
    for (const para of paragraphs) {
      if (para.length <= CHUNK_TARGET_CHARS * 1.5) {
        chunks.push(para);
      } else {
        for (let i = 0; i < para.length; i += CHUNK_TARGET_CHARS) {
          chunks.push(para.substring(i, i + CHUNK_TARGET_CHARS).trim());
        }
      }
    }

    // Skip tiny chunks (headings, blank lines that slipped through)
    return chunks
      .filter(c => c.length > 40)
      .map((text, i) => ({
        chunkId: `${msg.id}:${i}`,
        messageId: msg.id,
        sender: msg.sender,
        timestamp: msg.timestamp,
        text
      }));
  }

  // ─── Indexing ────────────────────────────────────────────────────────────

  /**
   * Chunk and embed all messages that haven't been indexed yet.
   * Batches the embedding call for efficiency.
   */
  async _ensureIndexed(messages) {
    if (!this.embeddingProvider) return false;

    // Chunk any new messages
    const newChunks = [];
    for (const msg of messages) {
      if (this._chunkedMessages[msg.id]) continue;
      if (!msg.id || !msg.text) continue;

      const msgChunks = this._chunkMessage(msg);
      for (const chunk of msgChunks) {
        this._chunks[chunk.chunkId] = chunk;
        newChunks.push(chunk);
      }
      this._chunkedMessages[msg.id] = true;
    }

    if (newChunks.length === 0) return true;

    // Batch embed all new chunks
    const texts = newChunks.map(c =>
      `${c.sender || 'user'}: ${c.text.substring(0, 500)}`
    );

    try {
      const embeddings = await this.embeddingProvider.embed(texts);
      for (let i = 0; i < newChunks.length; i++) {
        if (embeddings[i]) {
          this._vectors[newChunks[i].chunkId] = embeddings[i];
        }
      }
      return true;
    } catch (err) {
      console.warn('[conversation-compactor] Embedding failed:', err.message);
      return false;
    }
  }

  // ─── Retrieval ───────────────────────────────────────────────────────────

  /**
   * Retrieve relevant chunks for a query.
   *
   * Strategy:
   *  - Recent SHORT messages (< recentTokenBudget) are kept verbatim
   *  - ALL large messages — including recent ones — are chunked and
   *    searched at the paragraph level
   *  - Near-duplicate chunks are removed
   *  - Return synthetic messages from top-K relevant chunks + verbatim
   *    short recent messages, in chronological order
   *
   * @param {string} query - the current user message
   * @param {Array} messages - full chat messages array
   * @param {object} [options]
   * @param {number} [options.maxChunks=20]           - max chunks to retrieve
   * @param {number} [options.alwaysKeepRecent=4]     - recent short messages kept verbatim
   * @param {number} [options.recentTokenBudget=800]  - max tokens for a message to be "short"
   * @param {number} [options.minSimilarity=0.25]     - minimum relevance score
   * @param {number} [options.dedupeThreshold=0.92]   - cosine threshold for dedup
   * @param {number} [options.maxTokens=4000]         - rough token budget for retrieved chunks
   * @returns {Array} messages (some synthetic from chunks), chronologically ordered
   */
  async retrieve(query, messages, options = {}) {
    const {
      maxChunks = 20,
      alwaysKeepRecent = 4,
      recentTokenBudget = 800,
      minSimilarity = 0.25,
      dedupeThreshold = 0.92,
      maxTokens = 4000
    } = options;

    // Filter to content messages
    const contentMessages = messages.filter(m =>
      (m.sender === 'user' || m.sender === 'assistant') && m.text
    );

    // Below threshold: send everything
    if (!this.shouldCompact(contentMessages)) {
      return contentMessages;
    }

    // Index all messages (chunking + embedding)
    const indexed = await this._ensureIndexed(contentMessages);
    if (!indexed) {
      return contentMessages.slice(-alwaysKeepRecent);
    }

    // Embed the query
    let queryVector;
    try {
      const embeddings = await this.embeddingProvider.embed([query]);
      queryVector = embeddings?.[0];
    } catch {
      return contentMessages.slice(-alwaysKeepRecent);
    }
    if (!queryVector) {
      return contentMessages.slice(-alwaysKeepRecent);
    }

    // Separate recent messages into "short" (keep verbatim) and "large" (chunk-search).
    // A 14K-token article pasted as a single message must be chunked even if it's recent.
    const tail = contentMessages.slice(-alwaysKeepRecent);
    const recentVerbatim = [];   // short messages kept as-is
    const recentLargeIds = new Set(); // large recent messages → search their chunks
    for (const msg of tail) {
      const estTokens = Math.ceil((msg.text?.length || 0) / CHARS_PER_TOKEN);
      if (estTokens <= recentTokenBudget) {
        recentVerbatim.push(msg);
      } else {
        recentLargeIds.add(msg.id);
      }
    }

    // Messages excluded from chunk search: only the short recent ones
    const verbatimIds = new Set(recentVerbatim.map(m => m.id));

    // Score ALL chunks (from any message not in verbatimIds)
    const searchableChunkIds = Object.keys(this._chunks).filter(cid => {
      const chunk = this._chunks[cid];
      return !verbatimIds.has(chunk.messageId) && this._vectors[cid];
    });

    const scored = searchableChunkIds
      .map(cid => ({
        chunk: this._chunks[cid],
        chunkId: cid,
        similarity: VectorStore.cosineSimilarity(queryVector, this._vectors[cid])
      }))
      .filter(s => s.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity);

    // Deduplicate near-identical chunks
    const deduped = this._deduplicateChunks(scored, dedupeThreshold);

    // Select top chunks within token budget
    const selected = [];
    let tokenCount = 0;
    for (const item of deduped) {
      if (selected.length >= maxChunks) break;
      const chunkTokens = Math.ceil(item.chunk.text.length / CHARS_PER_TOKEN);
      if (tokenCount + chunkTokens > maxTokens && selected.length > 0) break;
      selected.push(item);
      tokenCount += chunkTokens;
    }

    // Group selected chunks by source message and build synthetic messages
    const chunksByMessage = new Map();
    for (const item of selected) {
      const mid = item.chunk.messageId;
      if (!chunksByMessage.has(mid)) {
        chunksByMessage.set(mid, []);
      }
      chunksByMessage.get(mid).push(item);
    }

    const syntheticMessages = [];
    for (const [messageId, items] of chunksByMessage) {
      items.sort((a, b) => {
        const idxA = parseInt(a.chunkId.split(':')[1], 10);
        const idxB = parseInt(b.chunkId.split(':')[1], 10);
        return idxA - idxB;
      });

      const firstChunk = items[0].chunk;
      syntheticMessages.push({
        id: `compacted-${messageId}`,
        sender: firstChunk.sender,
        text: items.map(i => i.chunk.text).join('\n\n'),
        timestamp: firstChunk.timestamp,
        _compacted: true,
        _sourceMessageId: messageId,
        _chunkCount: items.length
      });
    }

    // Combine: synthetic chunks + verbatim short recent messages
    const combined = [...syntheticMessages, ...recentVerbatim];
    combined.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeA - timeB;
    });

    return combined;
  }

  /**
   * Should compaction be used for this conversation?
   * Estimates total tokens and compares against threshold.
   */
  shouldCompact(messages) {
    if (!this.embeddingProvider) return false;
    const contentMessages = Array.isArray(messages) ? messages : [];
    let totalChars = 0;
    for (const m of contentMessages) {
      if ((m.sender === 'user' || m.sender === 'assistant') && m.text) {
        totalChars += m.text.length;
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN) > COMPACTION_TOKEN_THRESHOLD;
  }

  /**
   * Remove near-duplicate chunks from scored results.
   */
  _deduplicateChunks(scored, threshold) {
    const result = [];
    for (const item of scored) {
      const isDuplicate = result.some(existing => {
        const vecA = this._vectors[existing.chunkId];
        const vecB = this._vectors[item.chunkId];
        return vecA && vecB && VectorStore.cosineSimilarity(vecA, vecB) > threshold;
      });
      if (!isDuplicate) {
        result.push(item);
      }
    }
    return result;
  }
}

module.exports = ConversationCompactor;
