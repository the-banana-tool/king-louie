const { describe, it } = require('node:test');
const assert = require('node:assert');
const MemoryRetrieval = require('../src/memory/memory-retrieval');

describe('Hybrid Retrieval', () => {
  const retrieval = new MemoryRetrieval();
  const entries = [
    { id: '1', content: 'keyword1 keyword2', created: new Date().toISOString() },
    { id: '2', content: 'other words', created: new Date().toISOString() }
  ];

  it('merges keyword and semantic results', async () => {
    const mockVectorStore = {
      search: (vector, limit) => [
        { id: '1', similarity: 0.9 },
        { id: '2', similarity: 0.8 }
      ]
    };

    const mockEmbeddingProvider = {
      embed: async (texts) => [[0.5, 0.5]]
    };

    const results = await retrieval.findRelevant(entries, 'keyword1', {
      embeddingProvider: mockEmbeddingProvider,
      vectorStore: mockVectorStore,
      includeScores: true
    });

    assert.strictEqual(results.length, 2);
    const entry1 = results.find(r => r.id === '1');
    const entry2 = results.find(r => r.id === '2');

    assert.ok(entry1.score.keywordScore > 0);
    assert.strictEqual(entry1.score.semanticScore, 0.9);
    assert.strictEqual(entry2.score.keywordScore, 0);
    assert.strictEqual(entry2.score.semanticScore, 0.8);
    assert.ok(entry1.score.hybridScore > entry2.score.hybridScore);
  });

  it('deduplicates results', async () => {
    const mockVectorStore = {
      search: (vector, limit) => [
        { id: '1', similarity: 0.9 } // Only returns 1
      ]
    };

    const mockEmbeddingProvider = {
      embed: async (texts) => [[0.5, 0.5]]
    };

    const results = await retrieval.findRelevant(entries, 'keyword1', {
      embeddingProvider: mockEmbeddingProvider,
      vectorStore: mockVectorStore,
      includeScores: true
    });

    // Both keyword and semantic found entry '1'
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, '1');
    assert.ok(results[0].score.keywordScore > 0);
    assert.ok(results[0].score.semanticScore > 0);
  });

  it('falls back to keyword-only when embedding unavailable', async () => {
    const mockVectorStore = {
      search: () => { throw new Error('Search failed'); }
    };

    const mockEmbeddingProvider = {
      embed: async () => { throw new Error('Embed failed'); }
    };

    const results = await retrieval.findRelevant(entries, 'keyword1', {
      embeddingProvider: mockEmbeddingProvider,
      vectorStore: mockVectorStore,
      includeScores: true
    });

    // Should return entry 1 based on keyword score
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, '1');
    assert.ok(results[0].score.keywordScore > 0);
    assert.strictEqual(results[0].score.semanticScore, undefined);
  });

  it('weights scores correctly (0.4/0.4/0.2)', async () => {
    // keywordScore: 1.0 (overlapCount 1 / queryTokens 1)
    // recencyScore: ~1.0 (just created)
    // semanticScore: 0.8
    // hybridScore should be (1.0 * 0.4) + (0.8 * 0.4) + (1.0 * 0.2) = 0.4 + 0.32 + 0.2 = 0.92

    const mockVectorStore = {
      search: (vector, limit) => [
        { id: '1', similarity: 0.8 }
      ]
    };

    const mockEmbeddingProvider = {
      embed: async (texts) => [[0.5, 0.5]]
    };

    const results = await retrieval.findRelevant([entries[0]], 'keyword1', {
      embeddingProvider: mockEmbeddingProvider,
      vectorStore: mockVectorStore,
      includeScores: true
    });

    assert.strictEqual(results.length, 1);
    const score = results[0].score;

    assert.strictEqual(score.keywordScore, 1.0);
    assert.strictEqual(score.semanticScore, 0.8);

    const expectedHybridScore = (1.0 * 0.4) + (0.8 * 0.4) + (score.recencyScore * 0.2);

    // Allow slight float math variance
    assert.ok(Math.abs(score.hybridScore - expectedHybridScore) < 0.001);
  });
});
