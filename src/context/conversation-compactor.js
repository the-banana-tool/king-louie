const VectorStore = require('../memory/vector-store');

/**
 * ConversationCompactor — semantic retrieval over conversation history.
 *
 * Instead of sending the entire conversation to the LLM, this module
 * uses embedding-based semantic search to retrieve only the messages
 * relevant to the current query. Combined with recency (always keep
 * the last N messages), it produces a small, focused context window.
 *
 * Flow:
 *  1. Messages are embedded incrementally (one batch call per new batch)
 *  2. On query: embed query → cosine similarity search → deduplicate
 *  3. Return: recent messages + semantically relevant older messages
 *
 * Cost: ~$0.001 per retrieval cycle (text-embedding-3-small).
 * The search itself is pure local cosine similarity — no LLM call.
 */

// Don't activate compaction until the conversation exceeds this count.
const COMPACTION_MESSAGE_THRESHOLD = 20;

class ConversationCompactor {
  /**
   * @param {object} options
   * @param {object} options.embeddingProvider - OpenAIEmbeddingProvider instance
   */
  constructor(options = {}) {
    this.embeddingProvider = options.embeddingProvider || null;
    this._vectors = {}; // messageId → embedding vector
  }

  /**
   * Index messages that haven't been embedded yet.
   * One batched API call for all unindexed messages.
   *
   * @param {Array} messages - chat messages with { id, sender, text }
   * @returns {boolean} true if indexing succeeded
   */
  async _ensureIndexed(messages) {
    if (!this.embeddingProvider) return false;

    const unindexed = messages.filter(m =>
      m.id && m.text && !this._vectors[m.id]
    );

    if (unindexed.length === 0) return true;

    // Truncate each message for embedding — full content isn't needed
    // for similarity, and long messages waste embedding tokens.
    const texts = unindexed.map(m =>
      `${m.sender || 'user'}: ${String(m.text).substring(0, 500)}`
    );

    try {
      const embeddings = await this.embeddingProvider.embed(texts);
      for (let i = 0; i < unindexed.length; i++) {
        if (embeddings[i]) {
          this._vectors[unindexed[i].id] = embeddings[i];
        }
      }
      return true;
    } catch (err) {
      console.warn('[conversation-compactor] Embedding failed:', err.message);
      return false;
    }
  }

  /**
   * Retrieve the most relevant messages for a query.
   *
   * Strategy: always include the last `alwaysKeepRecent` messages (recency),
   * then fill the remaining budget with semantically relevant older messages.
   * Near-duplicate messages are removed. Results are returned in
   * chronological order so the LLM sees a coherent timeline.
   *
   * @param {string} query - the current user message
   * @param {Array} messages - full chat messages array
   * @param {object} [options]
   * @param {number} [options.maxMessages=15]      - max messages to return
   * @param {number} [options.alwaysKeepRecent=4]   - recent messages always included
   * @param {number} [options.minSimilarity=0.2]    - minimum relevance score
   * @param {number} [options.dedupeThreshold=0.92] - cosine threshold for deduplication
   * @returns {Array} subset of messages, chronologically ordered
   */
  async retrieve(query, messages, options = {}) {
    const {
      maxMessages = 15,
      alwaysKeepRecent = 4,
      minSimilarity = 0.2,
      dedupeThreshold = 0.92
    } = options;

    // Filter to messages with actual content
    const contentMessages = messages.filter(m =>
      (m.sender === 'user' || m.sender === 'assistant') && m.text
    );

    // Below threshold: send everything, no compaction needed
    if (contentMessages.length <= maxMessages) {
      return contentMessages;
    }

    // Index all messages (incremental — only embeds new ones)
    const indexed = await this._ensureIndexed(contentMessages);
    if (!indexed) {
      // Fallback: return last maxMessages (recency only)
      return contentMessages.slice(-maxMessages);
    }

    // Embed the query
    let queryVector;
    try {
      const embeddings = await this.embeddingProvider.embed([query]);
      queryVector = embeddings?.[0];
    } catch {
      return contentMessages.slice(-maxMessages);
    }

    if (!queryVector) {
      return contentMessages.slice(-maxMessages);
    }

    // Always keep the most recent messages
    const recentMessages = contentMessages.slice(-alwaysKeepRecent);
    const recentIds = new Set(recentMessages.map(m => m.id));

    // Score older messages by relevance to the query
    const olderMessages = contentMessages.slice(0, -alwaysKeepRecent);
    const scored = olderMessages
      .filter(m => this._vectors[m.id])
      .map(m => ({
        message: m,
        similarity: VectorStore.cosineSimilarity(queryVector, this._vectors[m.id])
      }))
      .filter(s => s.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity);

    // Deduplicate near-identical messages
    const deduped = this._deduplicate(scored, dedupeThreshold);

    // Fill remaining budget with top-K relevant older messages
    const budget = maxMessages - recentMessages.length;
    const selectedOlder = deduped.slice(0, budget).map(s => s.message);

    // Combine and sort chronologically
    const combined = [...selectedOlder, ...recentMessages];
    combined.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeA - timeB;
    });

    return combined;
  }

  /**
   * Should compaction be used for this conversation?
   * Returns false for short conversations where sending everything is fine.
   */
  shouldCompact(messages) {
    if (!this.embeddingProvider) return false;
    const contentCount = messages.filter(m =>
      (m.sender === 'user' || m.sender === 'assistant') && m.text
    ).length;
    return contentCount > COMPACTION_MESSAGE_THRESHOLD;
  }

  /**
   * Remove near-duplicate messages from scored results.
   * When two retrieved messages have cosine similarity > threshold,
   * only the higher-scoring one is kept.
   */
  _deduplicate(scored, threshold) {
    const result = [];
    for (const item of scored) {
      const isDuplicate = result.some(existing => {
        const vecA = this._vectors[existing.message.id];
        const vecB = this._vectors[item.message.id];
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
