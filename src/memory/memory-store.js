const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { guardCheck } = require('../platform/write-guard');

class MemoryStore {
  // `writeGuard` (src/platform/write-guard.js) is passed only by the admin
  // CLI's import writer, which may run as an Administrator inside a data dir
  // the service account controls; without one, writes are unchanged.
  constructor(options = {}) {
    this.storageFile = options.storageFile || path.join(process.cwd(), 'memory-store.json');
    this.writeGuard = options.writeGuard || null;
    this.cache = null;
    this._writeQueue = Promise.resolve();
  }

  _enqueue(fn) {
    this._writeQueue = this._writeQueue.then(fn).catch(fn);
    return this._writeQueue;
  }

  ensureDirectory() {
    const directory = path.dirname(this.storageFile);
    guardCheck(this.writeGuard, this.storageFile);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      guardCheck(this.writeGuard, this.storageFile);
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
    const data = `${JSON.stringify(this.cache, null, 2)}\n`;
    // An unpredictable name opened with 'wx' (O_CREAT|O_EXCL): nothing can
    // be planted there in advance, and an existing entry is never followed
    // or truncated (fleet stage 7 Task 9, fix round 1).
    const tempFile = `${this.storageFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    guardCheck(this.writeGuard, tempFile);
    const fd = fs.openSync(tempFile, 'wx');
    try {
      fs.writeFileSync(fd, data, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tempFile, this.storageFile);
    } catch (err) {
      fs.rmSync(tempFile, { force: true });
      throw err;
    }
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
    // Invalidate cache and reload to prevent lost updates from concurrent callers
    this.cache = null;
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

    this.cache = null;
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

    this.cache = null;
    const document = this.load();
    const before = document.entries.length;
    document.entries = document.entries.filter((entry) => entry.id !== key);
    this.save(document);
    return document.entries.length !== before;
  }

  clear() {
    this.cache = null;
    const document = this.getDefaultDocument();
    this.save(document);
    return true;
  }
}

module.exports = MemoryStore;