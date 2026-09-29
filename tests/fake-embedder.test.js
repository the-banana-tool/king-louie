// tests/fake-embedder.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');

describe('bag-of-words fake embedder', () => {
  it('gives unit vectors that are closer for texts sharing words', async () => {
    const [a, b, c] = await createBagOfWordsEmbedder().embed(['gate code gate', 'the gate code', 'linen wrapping']);
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
    assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
    assert.ok(dot(a, b) > dot(a, c));
    assert.deepStrictEqual((await createBagOfWordsEmbedder({ vocab: ['x'] }).embed(['none']))[0], [0]);
  });
});
