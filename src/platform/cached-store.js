// A read cache for electron-store (conf) classes. conf re-reads and parses
// the whole file on every get(), and the desktop's chat-data.json holds every
// chat next to settings, tokens and provider status: a read of a 5 KB key
// parsed a 5 MB file (~17 ms), and the model availability passes at start do
// over a thousand such reads. The service's JsonFileStore already parses once.
//
// The file is parsed once and re-parsed only when its mtime or size changes,
// so a write from another process is still seen. Every value handed out is a
// copy, never the cached object; any write drops the cache.
const fs = require('fs');

function withReadCache(Store) {
  return class CachedStore extends Store {
    _cachedData() {
      let st;
      try {
        st = fs.statSync(this.path);
      } catch {
        this._klCache = null;
        return null;
      }
      // Stat before reading: a write landing in between leaves newer data
      // under the older signature, which costs one extra parse, never a
      // stale read.
      const sig = `${st.mtimeMs}:${st.size}`;
      if (!this._klCache || this._klCache.sig !== sig) this._klCache = { sig, data: super.store };
      return this._klCache.data;
    }

    // conf's _get() and has() read through the getter below; while they run
    // it hands them the cached object itself, and _get() copies the result.
    _withRaw(fn) {
      const was = this._klRaw;
      this._klRaw = true;
      try {
        return fn();
      } finally {
        this._klRaw = was;
      }
    }

    get store() {
      const data = this._cachedData();
      if (!data) return super.store;
      // conf's set()/delete()/clear() mutate what this returns before
      // writing it back, so everyone but _get()/has() gets a copy.
      return this._klRaw ? data : structuredClone(data);
    }

    set store(value) {
      this._klCache = null;
      super.store = value;
    }

    _get(key, defaultValue) {
      const value = this._withRaw(() => super._get(key, undefined));
      return value === undefined ? defaultValue : structuredClone(value);
    }

    has(key) {
      return this._withRaw(() => super.has(key));
    }
  };
}

module.exports = { withReadCache };
