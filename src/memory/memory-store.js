const fs = require('fs');
const path = require('path');

class MemoryStore {
  constructor(options = {}) {
    this.storageFile = options.storageFile || path.join(process.cwd(), 'memory-store.json');
    this.cache = null;
  }

  ensureDirectory() {
    const directory = path.dirname(this.storageFile);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  getDefaultDocument() {
    return {
      entries: []
    };
  }

  normalizeDocument(value) {
    if (!value || typeof value !== 'object') {
      return this.getDefaultDocument();
    }

    return {
      entries: Array.isArray(value.entries) ? value.entries : []
    };
  }

  load() {
    if (this.cache) {
      return this.cache;
    }

    this.ensureDirectory();
    if (!fs.existsSync(this.storageFile)) {
      this.cache = this.getDefaultDocument();
      this.save(this.cache);
      return this.cache;
    }

    try {
      const raw = fs.readFileSync(this.storageFile, 'utf-8');
      this.cache = this.normalizeDocument(JSON.parse(raw));
    } catch {
      this.cache = this.getDefaultDocument();
      this.save(this.cache);
    }

    return this.cache;
  }

  save(document = this.cache || this.getDefaultDocument()) {
    this.ensureDirectory();
    this.cache = this.normalizeDocument(document);
    fs.writeFileSync(this.storageFile, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf-8');
    return this.cache;
  }

  list() {
    const document = this.load();
    return [...document.entries];
  }

  getById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return this.list().find((entry) => entry.id === key) || null;
  }

  insert(entry) {
    const document = this.load();
    document.entries = [entry, ...document.entries.filter((item) => item.id !== entry.id)];
    this.save(document);
    return entry;
  }

  update(id, updates = {}) {
    const key = String(id || '').trim();
    if (!key) {
      return null;
    }

    const document = this.load();
    let updated = null;
    document.entries = document.entries.map((entry) => {
      if (entry.id !== key) {
        return entry;
      }

      updated = {
        ...entry,
        ...(updates || {})
      };
      return updated;
    });

    if (!updated) {
      return null;
    }

    this.save(document);
    return updated;
  }

  delete(id) {
    const key = String(id || '').trim();
    if (!key) {
      return false;
    }

    const document = this.load();
    const before = document.entries.length;
    document.entries = document.entries.filter((entry) => entry.id !== key);
    this.save(document);
    return document.entries.length !== before;
  }

  clear() {
    const document = this.getDefaultDocument();
    this.save(document);
    return true;
  }
}

module.exports = MemoryStore;