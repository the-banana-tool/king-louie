// tests/helpers/fake-embedder.js
// A deterministic bag-of-words embedder: each text becomes the unit vector
// of its word counts over `vocab`. Moved from the removed compactor test so
// H3's retriever and embed-runner tests can use it (recall spec §13).
const DEFAULT_VOCAB = Object.freeze([
  'linen', 'wrapping', 'bandage', 'fabric', 'natron', 'salt', 'brain', 'heart', 'canopic', 'jar',
  'tomb', 'coffin', 'mask', 'resin', 'amulet', 'ritual', 'priest', 'mummy', 'embalming', 'body',
  'gate', 'code', 'fence', 'drainage', 'lot', 'survey', 'pipe', 'meters'
]);

function createBagOfWordsEmbedder({ vocab = DEFAULT_VOCAB } = {}) {
  const words = vocab.map((word) => new RegExp(`\\b${word}\\b`, 'gi'));
  return {
    async embed(texts) {
      return texts.map((text) => {
        const raw = words.map((re) => (String(text).match(re) || []).length);
        const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
        return raw.map((v) => v / norm);
      });
    }
  };
}

module.exports = { createBagOfWordsEmbedder, DEFAULT_VOCAB };
