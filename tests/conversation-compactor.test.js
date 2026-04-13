const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ConversationCompactor = require('../src/context/conversation-compactor');

/**
 * Build a conversation where the entire mummy article is a single
 * assistant message — the exact scenario the compactor must handle.
 */
function buildSingleMessageConversation() {
  const articlePath = path.join(__dirname, '..', 'bodies-of-the-gods.md');
  const article = fs.readFileSync(articlePath, 'utf-8');

  return [
    {
      id: 'msg-1',
      sender: 'user',
      text: 'Tell me everything about the embalming of ancient Egyptian pharaohs',
      timestamp: '2026-04-01T10:00:00Z'
    },
    {
      id: 'msg-2',
      sender: 'assistant',
      text: article, // entire article in one message
      timestamp: '2026-04-01T10:01:00Z'
    },
    {
      id: 'msg-3',
      sender: 'user',
      text: 'That was really comprehensive, thanks!',
      timestamp: '2026-04-01T10:02:00Z'
    },
    {
      id: 'msg-4',
      sender: 'assistant',
      text: 'You are welcome! Let me know if you have any follow-up questions about Egyptian funerary practices.',
      timestamp: '2026-04-01T10:03:00Z'
    }
  ];
}

/**
 * Mock embedding provider using bag-of-words vectors.
 * Good enough to test chunking, retrieval, and dedup mechanics.
 */
function createMockEmbeddingProvider() {
  const vocab = [
    'linen', 'wrapping', 'wrapped', 'bandage', 'fabric', 'cloth', 'textile',
    'natron', 'desiccation', 'drying', 'salt', 'moisture',
    'brain', 'hook', 'cranial', 'skull', 'nostrils',
    'heart', 'judgment', 'weighing', 'maat', 'feather',
    'canopic', 'jar', 'organ', 'liver', 'lungs', 'stomach', 'intestines',
    'horus', 'osiris', 'anubis', 'isis', 'nephthys',
    'pyramid', 'tomb', 'valley', 'kings', 'chamber', 'sarcophagus',
    'coffin', 'mask', 'gold', 'cartonnage',
    'resin', 'oil', 'beeswax', 'cedar', 'anoint',
    'amulet', 'scarab', 'djed', 'tyet', 'spell',
    'opening', 'mouth', 'ceremony', 'ritual', 'priest',
    'ka', 'ba', 'akh', 'spirit', 'afterlife',
    'mourning', 'funeral', 'procession', 'offering',
    'mummy', 'embalming', 'preservation', 'body', 'corpse',
  ];

  return {
    async embed(texts) {
      return texts.map(text => {
        const lower = text.toLowerCase();
        const raw = vocab.map(word => {
          const re = new RegExp(`\\b${word}\\b`, 'gi');
          const m = lower.match(re);
          return m ? m.length : 0;
        });
        const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
        return raw.map(v => v / norm);
      });
    }
  };
}

describe('ConversationCompactor (chunk-level)', () => {
  let compactor;
  let conversation;

  beforeEach(() => {
    compactor = new ConversationCompactor({
      embeddingProvider: createMockEmbeddingProvider()
    });
    conversation = buildSingleMessageConversation();
  });

  describe('shouldCompact', () => {
    it('returns true for the mummy article (>6000 tokens)', () => {
      assert.strictEqual(compactor.shouldCompact(conversation), true);
    });

    it('returns false for short conversations', () => {
      const short = [
        { id: '1', sender: 'user', text: 'Hi' },
        { id: '2', sender: 'assistant', text: 'Hello, how can I help?' }
      ];
      assert.strictEqual(compactor.shouldCompact(short), false);
    });

    it('returns false when no embedding provider', () => {
      const noEmbed = new ConversationCompactor({});
      assert.strictEqual(noEmbed.shouldCompact(conversation), false);
    });
  });

  describe('chunking', () => {
    it('splits the article into many chunks', () => {
      const articleMsg = conversation[1];
      const chunks = compactor._chunkMessage(articleMsg);

      // The article is ~14K tokens, should produce many chunks
      assert.ok(chunks.length > 10, `Expected >10 chunks, got ${chunks.length}`);

      // Each chunk should reference the source message
      for (const chunk of chunks) {
        assert.strictEqual(chunk.messageId, 'msg-2');
        assert.strictEqual(chunk.sender, 'assistant');
        assert.ok(chunk.text.length > 40, 'Chunks should not be tiny');
      }
    });

    it('produces chunks that contain distinct content', () => {
      const articleMsg = conversation[1];
      const chunks = compactor._chunkMessage(articleMsg);
      const texts = chunks.map(c => c.text);

      // At least one chunk should mention linen/wrapping
      const wrappingChunks = texts.filter(t => /linen|wrapping|bandage/i.test(t));
      assert.ok(wrappingChunks.length > 0, 'Should have wrapping chunks');

      // At least one chunk should mention brain removal
      const brainChunks = texts.filter(t => /brain|cranial|nostrils/i.test(t));
      assert.ok(brainChunks.length > 0, 'Should have brain removal chunks');

      // At least one chunk should mention canopic
      const canopicChunks = texts.filter(t => /canopic|jar/i.test(t));
      assert.ok(canopicChunks.length > 0, 'Should have canopic chunks');
    });

    it('skips tiny fragments', () => {
      const chunks = compactor._chunkMessage({
        id: 'test', sender: 'user', text: 'Hi\n\nOk\n\nThis is a proper paragraph with enough content to be meaningful.'
      });
      // 'Hi' and 'Ok' are <40 chars, should be skipped
      for (const chunk of chunks) {
        assert.ok(chunk.text.length > 40);
      }
    });
  });

  describe('retrieve — wrapping query on single-message article', () => {
    it('returns far fewer tokens than the original article', async () => {
      const query = 'what was the fabric the mummies were wrapped in again?';
      const result = await compactor.retrieve(query, conversation, {
        maxChunks: 10,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 4000
      });

      // Original article is ~14K tokens; retrieved should be much smaller
      const originalTokens = Math.ceil(conversation[1].text.length / 4);
      const retrievedTokens = result.reduce((sum, m) => sum + Math.ceil(m.text.length / 4), 0);

      assert.ok(
        retrievedTokens < originalTokens * 0.5,
        `Retrieved ${retrievedTokens} tokens should be < 50% of original ${originalTokens}`
      );
    });

    it('retrieved content includes wrapping/linen references', async () => {
      const query = 'what was the fabric the mummies were wrapped in again?';
      const result = await compactor.retrieve(query, conversation, {
        maxChunks: 10,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 4000
      });

      const allText = result.map(m => m.text).join(' ').toLowerCase();
      assert.ok(
        allText.includes('linen') || allText.includes('wrapping') || allText.includes('bandage'),
        'Retrieved chunks should contain wrapping/linen content'
      );
    });

    it('always includes recent messages verbatim', async () => {
      const query = 'what was the fabric the mummies were wrapped in again?';
      const result = await compactor.retrieve(query, conversation, {
        maxChunks: 10,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 4000
      });

      // Last 2 messages (msg-3, msg-4) should be present verbatim
      const ids = result.map(m => m.id);
      assert.ok(ids.includes('msg-3'), 'Should include recent user message');
      assert.ok(ids.includes('msg-4'), 'Should include recent assistant message');
    });

    it('marks compacted messages with metadata', async () => {
      const query = 'what was the fabric the mummies were wrapped in again?';
      const result = await compactor.retrieve(query, conversation, {
        maxChunks: 10,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 4000
      });

      const compacted = result.filter(m => m._compacted);
      assert.ok(compacted.length > 0, 'Should have compacted messages from chunks');
      for (const m of compacted) {
        assert.ok(m._sourceMessageId, 'Compacted messages should track source');
        assert.ok(m._chunkCount > 0, 'Should track chunk count');
      }
    });

    it('returns messages in chronological order', async () => {
      const query = 'what was the fabric the mummies were wrapped in again?';
      const result = await compactor.retrieve(query, conversation, {
        maxChunks: 10,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 4000
      });

      for (let i = 1; i < result.length; i++) {
        const prev = new Date(result[i - 1].timestamp).getTime();
        const curr = new Date(result[i].timestamp).getTime();
        assert.ok(curr >= prev, 'Messages should be chronologically ordered');
      }
    });
  });

  describe('deduplication', () => {
    it('removes near-identical chunks', async () => {
      // Add a message that repeats wrapping info
      const withDupe = [
        ...conversation,
        {
          id: 'msg-5',
          sender: 'user',
          text: 'Can you repeat the wrapping part?',
          timestamp: '2026-04-01T10:04:00Z'
        },
        {
          id: 'msg-6',
          sender: 'assistant',
          text: conversation[1].text.split('## VII.')[1]?.split('## VIII.')[0] ||
                'The wrapping process used hundreds of meters of linen bandages with amulets.',
          timestamp: '2026-04-01T10:05:00Z'
        }
      ];

      const query = 'what fabric were mummies wrapped in?';
      const result = await compactor.retrieve(query, withDupe, {
        maxChunks: 15,
        alwaysKeepRecent: 2,
        minSimilarity: 0.01,
        maxTokens: 6000
      });

      // Total retrieved tokens should still be bounded
      const totalTokens = result.reduce((s, m) => s + Math.ceil(m.text.length / 4), 0);
      assert.ok(totalTokens < 6000, `Should stay within token budget, got ${totalTokens}`);
    });
  });

  describe('fallback behavior', () => {
    it('returns recent messages when embedding fails', async () => {
      const failing = new ConversationCompactor({
        embeddingProvider: {
          async embed() { throw new Error('API rate limit'); }
        }
      });

      const result = await failing.retrieve(
        'what fabric were mummies wrapped in?',
        conversation,
        { alwaysKeepRecent: 2 }
      );

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, 'msg-3');
      assert.strictEqual(result[1].id, 'msg-4');
    });

    it('returns all messages when below token threshold', async () => {
      const short = [
        { id: '1', sender: 'user', text: 'What is linen?', timestamp: '2026-01-01T00:00:00Z' },
        { id: '2', sender: 'assistant', text: 'Linen is a fabric made from flax.', timestamp: '2026-01-01T00:01:00Z' }
      ];
      const result = await compactor.retrieve('tell me about linen', short);
      assert.strictEqual(result.length, 2);
    });
  });

  describe('disk-backed embedding cache', () => {
    let cacheDir;
    let cachePath;

    beforeEach(() => {
      const os = require('os');
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-emb-cache-'));
      cachePath = path.join(cacheDir, 'embeddings.jsonl');
    });

    function countingProvider(stats = { calls: 0, embedded: 0 }) {
      const base = createMockEmbeddingProvider();
      return {
        stats,
        async embed(texts) {
          stats.calls++;
          stats.embedded += texts.length;
          return base.embed(texts);
        }
      };
    }

    it('persists embeddings to disk and reuses them on a new instance', async () => {
      const stats = { calls: 0, embedded: 0 };
      const c1 = new ConversationCompactor({
        embeddingProvider: countingProvider(stats),
        cacheFilePath: cachePath
      });
      await c1.retrieve('linen wrapping', conversation);
      const firstCallEmbedded = stats.embedded;
      assert.ok(firstCallEmbedded > 0, 'first run must embed at least one chunk');
      assert.ok(fs.existsSync(cachePath), 'cache file should be written');

      // Brand-new compactor — same cache file. All hashes hit; no new embeds.
      const stats2 = { calls: 0, embedded: 0 };
      const c2 = new ConversationCompactor({
        embeddingProvider: countingProvider(stats2),
        cacheFilePath: cachePath
      });
      await c2.retrieve('linen wrapping', conversation);
      assert.strictEqual(stats2.embedded, 1, 'only the query itself should be embedded fresh');
      const cstats = c2.getCacheStats();
      assert.ok(cstats.hits > 0, `expected cache hits, got ${cstats.hits}`);
    });

    it('survives a corrupt trailing line in the cache file', async () => {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, '{"h":"abc","v":[0.1,0.2]}\nnot-json-at-all\n', 'utf8');
      const c = new ConversationCompactor({
        embeddingProvider: createMockEmbeddingProvider(),
        cacheFilePath: cachePath
      });
      // Should not throw on load.
      await c.retrieve('linen', conversation);
      const stats = c.getCacheStats();
      // The good entry was loaded; the corrupt one was skipped.
      assert.ok(stats.cacheSize >= 1);
    });
  });
});
