const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const VectorStore = require('../src/memory/vector-store');

describe('VectorStore', () => {
  const tempPath = path.join(os.tmpdir(), `vector-store-test-${Date.now()}.json`);

  it('adds and retrieves vectors', async () => {
    const store = new VectorStore(tempPath);
    store.vectors = {};
    store.save();
    await store.add('entry1', [1, 0, 0]);
    await store.add('entry2', [0, 1, 0]);
    await store.add('entry3', [0.9, 0.1, 0]);

    const results = await store.search([1, 0, 0], 2);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].id, 'entry1');  // Highest cosine similarity
    assert.strictEqual(results[1].id, 'entry3');
  });

  it('removes vectors', async () => {
    // Recreate a clean store
    const store = new VectorStore(tempPath);
    store.vectors = {};
    store.save();
    await store.add('entry1', [1, 0, 0]);
    await store.remove('entry1');
    const results = await store.search([1, 0, 0], 5);
    assert.strictEqual(results.length, 0);
  });

  it('calculates cosine similarity correctly', () => {
    const sim = VectorStore.cosineSimilarity([1, 0], [1, 0]);
    assert.ok(Math.abs(sim - 1.0) < 0.001);

    const orthogonal = VectorStore.cosineSimilarity([1, 0], [0, 1]);
    assert.ok(Math.abs(orthogonal) < 0.001);
  });

  it('persists to disk', async () => {
    const store = new VectorStore(tempPath);
    store.vectors = {};
    store.save();
    await store.add('entry1', [1, 0, 0]);
    await store.save();

    const store2 = new VectorStore(tempPath);
    await store2.load();
    const results = await store2.search([1, 0, 0], 1);
    assert.strictEqual(results[0].id, 'entry1');
  });

  it('cleanup', () => {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}
  });
});
