const fs = require('fs');
const path = require('path');

class VectorStore {
  constructor(storageFile) {
    this.storageFile = storageFile;
    this.vectors = {}; // { id: [float] }
    this.load();
  }

  ensureDirectory() {
    const directory = path.dirname(this.storageFile);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  load() {
    this.ensureDirectory();
    if (!fs.existsSync(this.storageFile)) {
      this.vectors = {};
      this.save();
      return;
    }

    try {
      const raw = fs.readFileSync(this.storageFile, 'utf-8');
      this.vectors = JSON.parse(raw);
    } catch {
      this.vectors = {};
      this.save();
    }
  }

  save() {
    this.ensureDirectory();
    const data = JSON.stringify(this.vectors);
    const tempFile = `${this.storageFile}.tmp`;
    fs.writeFileSync(tempFile, data, 'utf-8');
    fs.renameSync(tempFile, this.storageFile);
  }

  add(id, vector) {
    if (!id || !Array.isArray(vector)) return;
    this.vectors[id] = vector;
    this.save();
  }

  remove(id) {
    if (!id || !this.vectors[id]) return;
    delete this.vectors[id];
    this.save();
  }

  search(queryVector, topK = 10) {
    if (!Array.isArray(queryVector)) return [];

    const results = Object.entries(this.vectors).map(([id, vector]) => {
      const similarity = VectorStore.cosineSimilarity(queryVector, vector);
      return { id, similarity };
    });

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  static cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

module.exports = VectorStore;
