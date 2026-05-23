const crypto = require('crypto');
const MemoryRetrieval = require('./memory-retrieval');
const { createLogger } = require('../logging');
const log = createLogger('memory-manager');

const VALID_TYPES = new Set(['success', 'failure', 'preference', 'context']);
const VALID_TIERS = new Set(['hot', 'warm', 'cold']);

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeType(type = 'context') {
  const normalized = String(type || 'context').trim().toLowerCase();
  if (!VALID_TYPES.has(normalized)) {
    return 'context';
  }
  return normalized;
}

function normalizeTier(tier = 'hot') {
  const normalized = String(tier || 'hot').trim().toLowerCase();
  if (!VALID_TIERS.has(normalized)) {
    return 'hot';
  }
  return normalized;
}

function getAgeDays(timestamp) {
  const value = Date.parse(timestamp || '') || Date.now();
  return Math.max(0, (Date.now() - value) / (1000 * 60 * 60 * 24));
}

class MemoryManager {
  constructor(options = {}) {
    this.store = options.store;
    this.retrieval = options.retrieval || new MemoryRetrieval();
    this.currentSessionId = String(options.currentSessionId || '').trim();
    this.embeddingProvider = options.embeddingProvider || null;
    this.vectorStore = options.vectorStore || null;
  }

  setCurrentSession(sessionId = '') {
    this.currentSessionId = String(sessionId || '').trim();
  }

  inferTier(entry = {}, now = Date.now()) {
    const sessionSource = String(entry.source || '').trim();
    if (this.currentSessionId && sessionSource && sessionSource === this.currentSessionId) {
      return 'hot';
    }

    const referenceDate = Date.parse(entry.lastAccessed || entry.created || now) || now;
    const ageDays = Math.max(0, (now - referenceDate) / (1000 * 60 * 60 * 24));
    if (ageDays <= 7) {
      return 'hot';
    }
    if (ageDays <= 90) {
      return 'warm';
    }
    return 'cold';
  }

  normalizeEntry(partial = {}) {
    const nowIso = new Date().toISOString();
    const created = partial.created || nowIso;
    const lastAccessed = partial.lastAccessed || created;
    const base = {
      id: String(partial.id || createId()),
      type: normalizeType(partial.type),
      content: String(partial.content || '').trim(),
      source: String(partial.source || this.currentSessionId || 'unknown-session'),
      created,
      lastAccessed,
      metadata: partial.metadata && typeof partial.metadata === 'object' ? partial.metadata : {}
    };

    return {
      ...base,
      tier: normalizeTier(partial.tier || this.inferTier(base))
    };
  }

  capture(type, content, options = {}) {
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) {
      throw new Error('Memory content is required.');
    }

    const entry = this.normalizeEntry({
      type,
      content: normalizedContent,
      source: options.source,
      metadata: options.metadata,
      tier: options.tier
    });

    const inserted = this.store.insert(entry);

    if (this.embeddingProvider && this.vectorStore) {
      this.embeddingProvider.embed([normalizedContent])
        .then(embs => {
          if (embs && embs[0]) {
            this.vectorStore.add(entry.id, embs[0]);
          }
        })
        .catch(err => log.warn(`Failed to generate embedding for entry: ${err.message}`));
    }

    return inserted;
  }

  captureSuccess(what, why, options = {}) {
    const normalizedWhat = String(what || '').trim();
    const normalizedWhy = String(why || '').trim();
    const content = [
      `SUCCESS: ${normalizedWhat || 'Task completed'}`,
      normalizedWhy ? `WHY: ${normalizedWhy}` : ''
    ].filter(Boolean).join('\n');

    return this.capture('success', content, options);
  }

  captureFailure(what, why, fix, options = {}) {
    const normalizedWhat = String(what || '').trim();
    const normalizedWhy = String(why || '').trim();
    const normalizedFix = String(fix || '').trim();
    const content = [
      `FAILURE: ${normalizedWhat || 'Task failed'}`,
      normalizedWhy ? `WHY: ${normalizedWhy}` : '',
      normalizedFix ? `FIX: ${normalizedFix}` : ''
    ].filter(Boolean).join('\n');

    return this.capture('failure', content, options);
  }

  capturePreference(key, value, options = {}) {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = String(value || '').trim();
    if (!normalizedKey) {
      throw new Error('Preference key is required.');
    }

    return this.capture('preference', `PREFERENCE: ${normalizedKey}=${normalizedValue}`, {
      ...options,
      metadata: {
        ...(options.metadata || {}),
        key: normalizedKey,
        value: normalizedValue
      }
    });
  }

  list(options = {}) {
    const limit = Number(options.limit || 100);
    const type = String(options.type || '').trim().toLowerCase();
    const tier = String(options.tier || '').trim().toLowerCase();
    const query = String(options.query || '').trim();

    let entries = this.store.list().map((entry) => this.normalizeEntry(entry));

    if (type && VALID_TYPES.has(type)) {
      entries = entries.filter((entry) => entry.type === type);
    }

    if (tier && VALID_TIERS.has(tier)) {
      entries = entries.filter((entry) => entry.tier === tier);
    }

    if (query) {
      const lowered = query.toLowerCase();
      entries = entries.filter((entry) => String(entry.content || '').toLowerCase().includes(lowered));
    }

    entries.sort((a, b) => Date.parse(b.lastAccessed || b.created) - Date.parse(a.lastAccessed || a.created));
    return entries.slice(0, Math.max(1, limit));
  }

  async recall(query = '', options = {}) {
    const candidates = this.list({
      limit: options.candidateLimit || 250,
      type: options.type,
      tier: options.tier
    });

    const recalled = await this.retrieval.findRelevant(candidates, query, {
      limit: options.limit || 8,
      includeScores: options.includeScores === true,
      embeddingProvider: this.embeddingProvider,
      vectorStore: this.vectorStore
    });

    const nowIso = new Date().toISOString();
    recalled.forEach((entry) => {
      this.store.update(entry.id, {
        lastAccessed: nowIso,
        tier: this.inferTier({
          ...entry,
          lastAccessed: nowIso
        })
      });
    });

    return recalled.map((entry) => this.normalizeEntry(entry));
  }

  promote(id) {
    const entry = this.store.getById(id);
    if (!entry) return null;
    const nowIso = new Date().toISOString();
    return this.store.update(id, {
      tier: 'hot',
      lastAccessed: nowIso
    });
  }

  demote(id) {
    const entry = this.store.getById(id);
    if (!entry) return null;

    const nextTier = entry.tier === 'hot'
      ? 'warm'
      : entry.tier === 'warm'
        ? 'cold'
        : 'cold';

    return this.store.update(id, {
      tier: nextTier
    });
  }

  delete(id) {
    const deleted = this.store.delete(id);
    if (deleted && this.vectorStore) {
      this.vectorStore.remove(id);
    }
    return deleted;
  }

  clear() {
    const cleared = this.store.clear();
    if (cleared && this.vectorStore) {
      this.vectorStore.vectors = {};
      this.vectorStore.save();
    }
    return cleared;
  }

  runAging(now = Date.now()) {
    const entries = this.store.list();
    let changed = 0;
    const snapshot = { hot: 0, warm: 0, cold: 0 };

    for (const entry of entries) {
      const nextTier = this.inferTier(entry, now);
      const currentTier = normalizeTier(entry.tier);
      if (nextTier !== currentTier) {
        this.store.update(entry.id, { tier: nextTier });
        changed += 1;
      }
      snapshot[nextTier] = (snapshot[nextTier] || 0) + 1;
    }

    return {
      total: entries.length,
      changed,
      snapshot
    };
  }

  async buildPromptContext(query = '', options = {}) {
    const recalled = await this.recall(query, {
      ...options,
      limit: options.limit || 6
    });

    if (!recalled.length) {
      return '';
    }

    const lines = ['Relevant Memory Context:'];
    recalled.forEach((entry, index) => {
      const ageDays = Math.round(getAgeDays(entry.lastAccessed || entry.created));
      lines.push(
        `${index + 1}. [${entry.tier.toUpperCase()}|${entry.type}] ${entry.content.replace(/\s+/g, ' ').trim()} (source=${entry.source}, age=${ageDays}d)`
      );
    });

    return lines.join('\n');
  }
}

module.exports = {
  MemoryManager,
  VALID_TYPES,
  VALID_TIERS
};