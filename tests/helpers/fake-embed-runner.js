// tests/helpers/fake-embed-runner.js
// An in-process EmbedRunner stand-in (no child process): the fake backend's
// bag-of-words models behind load/embed/rerank/reset/stop. For tests that
// build a whole core (Task 12); the host's own tests drive a stub by hand.
const { EventEmitter } = require('node:events');
const { createBackend } = require('./fake-embed-backend');

class FakeEmbedRunner extends EventEmitter {
  constructor() {
    super();
    this.backend = createBackend({ inProcess: true });
    this.models = {};
    this.calls = [];
    this.resets = 0;
    this.stopped = false;
  }

  async load(role, model) {
    this.calls.push({ op: 'load', role, model });
    const onProgress = (p) => this.emit('progress', { role, model, file: p.file, loaded: p.loaded, total: p.total });
    const handle = role === 'reranker' ? await this.backend.loadReranker({ model, onProgress }) : await this.backend.loadEmbedder({ model, onProgress });
    this.models[role] = { model, handle };
    return { dim: handle.dim ?? null };
  }

  async embed(model, texts, { priority = 'document' } = {}) {
    this.calls.push({ op: 'embed', model, n: texts.length, priority });
    const cur = this.models.embedder;
    if (!cur || cur.model !== model) throw Object.assign(new Error(`${model} is not loaded`), { code: 'MODEL_CHANGED' });
    return cur.handle.embed(texts);
  }

  async rerank(model, query, texts, { deadlineMs = Infinity } = {}) {
    this.calls.push({ op: 'rerank', model, n: texts.length, deadlineMs });
    return this.models.reranker.handle.score(query, texts);
  }

  reset() { this.resets += 1; }

  async stop() { this.stopped = true; }
}

module.exports = { FakeEmbedRunner };
