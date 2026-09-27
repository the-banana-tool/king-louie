// src/cases/playbooks/loader.js
// PlaybookLoader (cases stage 6 spec §3.3): the playbooks in one case, as
// data. Synchronous, reads only. A playbook directory is never passed to
// require; validation and hashing go through format.js.
const fs = require('fs');
const path = require('path');
// Called through the module object (gitlib.runGitSync), so a test can count
// the processes a plain case spawns (none).
const gitlib = require('../git');
const { parseCaseYaml } = require('../case-store');
const { NAME_RE, validatePackage, hashPackage, formatErrors } = require('./format');
const { createLogger } = require('../../logging');

const log = createLogger('cases/playbooks');

const STATES = Object.freeze(['ok', 'invalid', 'unavailable', 'missing', 'unregistered']);
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// .gitmodules is case content, so it is untrusted text: bounded in size and
// parsed here, never by running git config on it.
const GITMODULES_MAX_BYTES = 64 * 1024;
const URL_MAX_LENGTH = 2048;
const LS_TREE_ARGS = Object.freeze(['ls-tree', '-z', 'HEAD', 'playbooks/']);

// A submodule url is kept only when it is a plain https:// or ssh:// URL with
// a host and no password, written in printable ASCII only. Everything else
// (ext::, fd::, file://, local paths, scp-like "host:path", a leading "-"
// that git could read as an option, http, git://, whitespace, control
// characters, and any non-ASCII character such as a bidi override that
// would make the url read differently on screen) becomes null. The url is
// shown to the owner; the loader never passes it to git.
function safeSubmoduleUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX_LENGTH) return null;
  if (!/^[\x21-\x7e]+$/.test(value) || value.startsWith('-')) return null;
  if (!/^(https|ssh):\/\//i.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
  if (!url.hostname || url.password) return null;
  return value;
}

// .gitmodules is INI: [submodule "name"] sections with path = and url =.
// Section and key names are case-insensitive, as git reads them. Returns
// { [path]: url | null }; a path whose url is missing or refused maps to
// null. Throws GITMODULES_TOO_LARGE for text over GITMODULES_MAX_BYTES.
function parseGitmodules(text) {
  const str = String(text ?? '');
  if (Buffer.byteLength(str, 'utf8') > GITMODULES_MAX_BYTES) {
    const err = new Error(`.gitmodules is larger than ${GITMODULES_MAX_BYTES / 1024} KiB`);
    err.code = 'GITMODULES_TOO_LARGE';
    throw err;
  }
  const byPath = {};
  let current = null;
  for (const raw of str.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[\s*submodule\s+"(?:[^"\\]|\\.)*"\s*\]$/i.test(line)) {
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const m = /^(path|url)\s*=\s*(.*)$/i.exec(line);
    if (!m || !current) continue;
    current[m[1].toLowerCase()] = m[2].trim();
    if (current.path) {
      byPath[current.path.replace(/\\/g, '/').replace(/\/+$/, '')] = safeSubmoduleUrl(current.url);
    }
  }
  return byPath;
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// True when a real (not linked) directory is empty or holds a .git entry:
// what an uninitialized or checked-out submodule looks like. Reads at most
// one directory entry.
function looksLikeSubmodule(dir) {
  if (lstatOrNull(path.join(dir, '.git'))) return true;
  let handle;
  try {
    handle = fs.opendirSync(dir);
    return handle.readSync() === null;
  } catch {
    return false;
  } finally {
    if (handle) {
      try { handle.closeSync(); } catch { /* already closed */ }
    }
  }
}

class PlaybookLoader {
  constructor(caseDir, { knownExecutors = null, knownCaseTypes = null, meta = null } = {}) {
    this.caseDir = caseDir;
    this.playbooksDir = path.join(caseDir, 'playbooks');
    this.knownExecutors = Array.isArray(knownExecutors) ? knownExecutors : null;
    this.knownCaseTypes = Array.isArray(knownCaseTypes) ? knownCaseTypes : null;
    this.meta = meta;
    this._links = null;
    this._diskNames = undefined;
  }

  _readMeta() {
    if (this.meta) return this.meta;
    try {
      return parseCaseYaml(fs.readFileSync(path.join(this.caseDir, 'case.yaml'), 'utf8')) || {};
    } catch (err) {
      log.warn(`Could not read case.yaml in ${this.caseDir}: ${err.message}`);
      return {};
    }
  }

  // Why playbooks/ itself can't be read, or null. A linked playbooks folder
  // is never followed.
  _rootProblem() {
    const st = lstatOrNull(this.playbooksDir);
    if (!st) return null;
    if (st.isSymbolicLink()) return 'playbooks is a symbolic link';
    if (!st.isDirectory()) return 'playbooks is not a folder';
    return null;
  }

  // Directory names under playbooks/, links included (so they show up as
  // invalid rather than disappear). Dot-prefixed entries and plain files are
  // not playbooks.
  _dirs() {
    if (this._rootProblem()) return [];
    try {
      return fs.readdirSync(this.playbooksDir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not list ${this.playbooksDir}: ${err.message}`);
      return [];
    }
  }

  // Every name readdir returns in playbooks/ (exact spelling), or null when
  // it can't be listed. Cached for one list() call.
  _namesOnDisk() {
    if (this._diskNames !== undefined) return this._diskNames;
    let names = null;
    if (!this._rootProblem()) {
      try {
        names = new Set(fs.readdirSync(this.playbooksDir));
      } catch {
        names = null;
      }
    }
    this._diskNames = names;
    return names;
  }

  _readGitmodules(file) {
    const st = lstatOrNull(file);
    if (!st) return {};
    if (!st.isFile()) {
      log.warn(`Ignoring ${file}: not a regular file`);
      return {};
    }
    if (st.size > GITMODULES_MAX_BYTES) {
      log.warn(`Ignoring ${file}: larger than ${GITMODULES_MAX_BYTES / 1024} KiB`);
      return {};
    }
    try {
      return parseGitmodules(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.warn(`Could not read ${file}: ${err.message}`);
      return {};
    }
  }

  // Only a gitlink (mode 160000 in HEAD) makes a submodule. git is asked
  // only when something could be one: a .gitmodules file, or a playbook
  // directory (a real one, never a link) that is empty or holds a .git
  // entry. A plain case costs no process spawn.
  //
  // runGitSync checks the case's config (and every checked-out submodule's)
  // first and pins GIT_DIR/GIT_WORK_TREE to the case. A refusal
  // (GIT_UNSAFE_CONFIG) is kept in `refused`: then no playbook in the case
  // can be trusted to be what it looks like, and every entry is unavailable.
  _gitlinks() {
    if (this._links) return this._links;
    const links = {};
    let refused = null;
    const modulesFile = path.join(this.caseDir, '.gitmodules');
    const hasModules = Boolean(lstatOrNull(modulesFile));
    const candidate = hasModules || this._dirs().some((name) => {
      const dir = path.join(this.playbooksDir, name);
      const st = lstatOrNull(dir);
      return Boolean(st) && st.isDirectory() && !st.isSymbolicLink() && looksLikeSubmodule(dir);
    });
    if (candidate) {
      let out = '';
      try {
        out = gitlib.runGitSync(this.caseDir, [...LS_TREE_ARGS]);
      } catch (err) {
        if (err && err.code === 'GIT_UNSAFE_CONFIG') {
          refused = err.message;
          log.warn(`Playbooks in ${this.caseDir} are unavailable: ${err.message}`);
        } else {
          // Typically a case with no commit yet (no HEAD, so no gitlinks).
          log.debug(`ls-tree in ${this.caseDir} failed: ${gitlib.firstStderrLine(err) || err.message}`);
        }
      }
      for (const record of out.split('\0')) {
        const m = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t(.+)$/.exec(record);
        if (m && m[1] === '160000') links[m[3]] = m[2];
      }
    }
    const modules = hasModules && !refused ? this._readGitmodules(modulesFile) : {};
    this._links = { links, modules, refused };
    return this._links;
  }

  list() {
    this._links = null;
    this._diskNames = undefined;
    const meta = this._readMeta();
    const pinned = Array.isArray(meta.playbooks) ? meta.playbooks.filter((p) => isMap(p) && typeof p.name === 'string') : [];
    const names = [];
    for (const p of pinned) if (!names.includes(p.name)) names.push(p.name);
    for (const d of this._dirs()) if (!names.includes(d)) names.push(d);
    return names.map((name) => this._entry(name, pinned.find((p) => p.name === name) || null));
  }

  get(name) {
    return this.list().find((e) => e.name === name) || null;
  }

  contentHash(dir) {
    return hashPackage(dir);
  }

  _entry(name, pin) {
    const entry = {
      name,
      dir: null,
      mode: 'vendored',
      state: 'ok',
      pinned: pin,
      onDisk: null,
      package: null,
      errors: [],
      warnings: [],
      submodule: null,
      reason: null
    };
    const invalid = (reason, file = null) => {
      entry.state = 'invalid';
      entry.reason = reason;
      entry.errors = [{ file, message: reason }];
      return entry;
    };
    if (!NAME_RE.test(name)) return invalid(`"${name}" is not a valid playbook name`, 'case.yaml');
    const rootProblem = this._rootProblem();
    if (rootProblem) return invalid(rootProblem);
    entry.dir = path.join(this.playbooksDir, name);
    const { links, modules, refused } = this._gitlinks();
    if (refused) {
      entry.state = 'unavailable';
      entry.reason = `git refused to read this case, so its playbooks can't be checked: ${refused}`;
      return entry;
    }
    const rel = `playbooks/${name}`;
    if (links[rel]) {
      entry.mode = 'submodule';
      entry.submodule = { url: modules[rel] || null, commit: links[rel] };
    } else {
      // A gitlink recorded as playbooks/Remote-PB lands in the same folder
      // as remote-pb on a case-insensitive filesystem; it must not pass as
      // a vendored copy.
      const lower = rel.toLowerCase();
      const other = Object.keys(links).find((k) => k.toLowerCase() === lower);
      if (other) return invalid(`gitlink ${other} differs only in case from playbooks/${name}`);
    }
    const st = lstatOrNull(entry.dir);
    // On a case-insensitive filesystem lstat("land-sale") finds "Land-Sale";
    // only the exact spelling counts.
    if (st) {
      const onDisk = this._namesOnDisk();
      if (!onDisk) return invalid('playbooks could not be listed');
      if (!onDisk.has(name)) return invalid(`playbooks/${name} differs only in case from the folder on disk`);
    }
    const notCheckedOut = `submodule not checked out (remote ${entry.submodule?.url || 'unknown'}); run "git submodule update --init" in the case`;
    if (!st) {
      entry.state = entry.submodule ? 'unavailable' : 'missing';
      entry.reason = entry.submodule ? notCheckedOut : `named in case.yaml but playbooks/${name} does not exist`;
      return entry;
    }
    if (st.isSymbolicLink()) return invalid(`playbooks/${name} is a symbolic link`);
    if (!st.isDirectory()) return invalid(`playbooks/${name} is not a folder`);
    if (entry.submodule && !lstatOrNull(path.join(entry.dir, 'playbook.yaml'))) {
      entry.state = 'unavailable';
      entry.reason = notCheckedOut;
      return entry;
    }
    const pkg = validatePackage(entry.dir, { knownCaseTypes: this.knownCaseTypes });
    entry.package = pkg;
    entry.errors = pkg.errors;
    entry.warnings = pkg.warnings.map((w) => w.message);
    if (!pkg.ok) {
      entry.state = 'invalid';
      entry.reason = formatErrors(pkg.errors).split('\n')[0];
      return entry;
    }
    let contentHash;
    try {
      contentHash = hashPackage(entry.dir);
    } catch (err) {
      // Changed on disk between validation and hashing.
      return invalid(err.message);
    }
    entry.onDisk = { version: pkg.playbook.version, contentHash };
    entry.state = pin ? 'ok' : 'unregistered';
    if (this.knownExecutors) {
      for (const s of pkg.steps.steps) {
        if (!this.knownExecutors.includes(s.executor)) {
          entry.warnings.push(`step "${s.id}" expects executor "${s.executor}", which is not registered`);
        }
      }
    }
    return entry;
  }
}

module.exports = { PlaybookLoader, parseGitmodules, STATES, GITMODULES_MAX_BYTES };
