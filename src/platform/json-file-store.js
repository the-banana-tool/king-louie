// A small, dependency-free subset of electron-store's API for the headless
// service: dot-path get/set, top-level defaults, atomic private writes.
const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class JsonFileStore {
  constructor({ dir, name = 'config', defaults = {} }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = path.join(dir, `${name}.json`);
    this._defaults = clone(defaults) || {};
    this._data = null;
  }

  _load() {
    if (this._data) return this._data;
    let onDisk = {};
    try {
      onDisk = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.path}: ${err.message}`);
    }
    this._data = { ...clone(this._defaults), ...onDisk };
    return this._data;
  }

  _save() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    if (process.platform !== 'win32') fs.chmodSync(this.path, 0o600);
  }

  get(key, defaultValue) {
    let node = this._load();
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object' || !(part in node)) return defaultValue;
      node = node[part];
    }
    return node === undefined ? defaultValue : clone(node);
  }

  set(key, value) {
    const data = this._load();
    if (key && typeof key === 'object') {
      Object.assign(data, clone(key));
    } else {
      const parts = String(key).split('.');
      let node = data;
      for (const part of parts.slice(0, -1)) {
        if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
      }
      node[parts[parts.length - 1]] = clone(value);
    }
    this._save();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    const parts = String(key).split('.');
    let node = this._load();
    for (const part of parts.slice(0, -1)) {
      if (node === null || typeof node !== 'object') return;
      node = node[part];
    }
    if (node && typeof node === 'object') {
      delete node[parts[parts.length - 1]];
      this._save();
    }
  }

  clear() {
    this._data = clone(this._defaults) || {};
    this._save();
  }

  get store() {
    return clone(this._load());
  }
}

module.exports = { JsonFileStore };
