// A small, dependency-free subset of electron-store's API for the headless
// service: dot-path get/set, top-level defaults, atomic private writes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class JsonFileStore {
  // `onWrite` is called with this store's path each time it is actually
  // written, so a root admin CLI knows which files it has to hand back to the
  // data dir's owner (src/service/ownership.js). Constructing a store writes
  // nothing, so a store that is only read is never reported.
  constructor({ dir, name = 'config', defaults = {}, onWrite = null }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = path.join(dir, `${name}.json`);
    this._defaults = clone(defaults) || {};
    this._data = null;
    this._onWrite = typeof onWrite === 'function' ? onWrite : null;
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

  // Atomic (temp + rename) and private (0600), written so that nothing in the
  // containing directory can steer it. The admin CLI runs this as root inside
  // a data dir the *service account* owns, so every name in there is
  // attacker-controlled:
  //   - the temp name is random, not pid-derived, so it cannot be pre-planted
  //     by enumerating pids;
  //   - it is created with 'wx' (O_CREAT|O_EXCL), which refuses to follow a
  //     symlink and refuses an existing file rather than truncating it;
  //   - the mode is pinned with fchmod on that descriptor, never a path-based
  //     chmod that would re-resolve the name after the write.
  _save() {
    const body = JSON.stringify(this._data, null, 2);
    // One retry: 'wx' failing with EEXIST means something is squatting the
    // name we picked. Remove it and try a fresh name rather than writing
    // into whatever is there.
    for (let attempt = 0; ; attempt += 1) {
      const tmp = `${this.path}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      let fd;
      try {
        fd = fs.openSync(tmp, 'wx', 0o600);
      } catch (err) {
        if (err.code === 'EEXIST' && attempt === 0) {
          fs.rmSync(tmp, { force: true });
          continue;
        }
        throw err;
      }
      try {
        fs.writeFileSync(fd, body);
        // 0600 leaves no group access at all, so a group inherited from a
        // setgid data dir is harmless; the owner is this process by
        // construction, since 'wx' means we created the file.
        if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.path);
      break;
    }
    if (this._onWrite) this._onWrite(this.path);
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
