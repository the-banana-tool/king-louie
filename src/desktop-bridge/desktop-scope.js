// Desktop-scoped widening (fleet stage 7 §3.4, §8). Directories the desktop
// allows and rules it adds apply to desktop runs only: these wrappers exist
// only in the bridge dispatcher's context, so only marked runs see them.
//
// Concurrency: every read and write below is synchronous (fs.*Sync, and
// Task 2's writeFileAtomic, which is itself openSync/writeSync/fsyncSync/
// closeSync/renameSync — no awaits). Node runs one JS callback to completion
// before starting the next, so two calls into this module's exported
// functions can never interleave within a process; each call re-reads the
// file fresh and writes it back before returning, which already makes
// read-modify-write safe without a promise-based queue. The one gap plain
// synchronous execution does *not* close is reentrancy: `onPathWritten` is a
// caller-supplied hook, and if it called back into this same scope for the
// file still being written, the reentrant write would land and then the
// outer write would finish and overwrite it with stale data. `writing`
// guards exactly that case by throwing instead of silently losing a write.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./pairing');
const { MESSAGES } = require('./protocol');

const DIRS_FILE = 'allowed-directories.json';
const RULES_FILE = 'rules.json';

function createDesktopScope({ dataDir, context, onPathWritten = () => {} }) {
  const dir = path.join(dataDir, 'desktop');
  const writing = new Set();

  const read = (name, key) => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      return Array.isArray(doc[key]) ? doc[key] : [];
    } catch {
      return [];
    }
  };

  const write = (name, key, list) => {
    if (writing.has(name)) {
      throw new Error(`desktop-scope: reentrant write to ${name}`);
    }
    writing.add(name);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      onPathWritten(dir);
      const file = path.join(dir, name);
      writeFileAtomic(file, `${JSON.stringify({ v: 1, [key]: list }, null, 2)}\n`, 0o600);
      onPathWritten(file);
    } finally {
      writing.delete(name);
    }
  };

  const serviceDirectories = () => {
    const s = context.getSettings();
    return Array.isArray(s.allowedDirectories) ? s.allowedDirectories : [];
  };
  const listDirectories = () => read(DIRS_FILE, 'directories').filter((d) => typeof d === 'string' && d);

  const getSettings = () => {
    const s = context.getSettings();
    const own = Array.isArray(s.allowedDirectories) ? s.allowedDirectories : [];
    return { ...s, allowedDirectories: [...own, ...listDirectories().filter((d) => !own.includes(d))] };
  };

  const setSettings = (next = {}) => {
    const own = serviceDirectories();
    const incoming = Array.isArray(next.allowedDirectories) ? next.allowedDirectories : [];
    const desktopOnly = [...new Set(incoming.filter((d) => typeof d === 'string' && d && !own.includes(d)))];
    write(DIRS_FILE, 'directories', desktopOnly);
    return context.setSettings({ ...next, allowedDirectories: own });
  };

  // Absolute-only, syntactic normalisation. path.isAbsolute treats a
  // POSIX-style root ("/x") as absolute on every platform, including
  // win32 (there it's drive-relative to the current drive), so this check
  // accepts a path exactly as given — no path.resolve/normalize rewrite —
  // which matters because resolve() on win32 would rewrite "/x" into
  // "C:\x" using backslashes, changing what the desktop (or a test fixture
  // written with POSIX paths) actually passed in. Empty and relative input
  // is rejected outright rather than silently resolved against the
  // service's cwd, which would be a surprising place for a security-
  // relevant allow-list entry to come from.
  //
  // Symlinks are *not* resolved here. A directory does not need to exist
  // yet to be allow-listed (the desktop may add a mount point before it's
  // mounted), and baking in today's realpath would go stale if the
  // symlink's target changes later. Live access — including whatever a
  // symlink resolves to at that moment — is checked when it actually
  // matters, by checkPath's fs.stat/opendir/open, which follow symlinks the
  // ordinary OS way.
  const normalizeDirectory = (directory) => {
    if (typeof directory !== 'string') return null;
    const trimmed = directory.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return null;
    return trimmed;
  };

  const addDirectory = (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) {
      const err = new Error(`Not an absolute directory path: ${JSON.stringify(directory)}`);
      err.code = 'INVALID_DIRECTORY';
      throw err;
    }
    const list = listDirectories();
    if (!list.includes(normalized) && !serviceDirectories().includes(normalized)) {
      list.push(normalized);
      write(DIRS_FILE, 'directories', list);
    }
    return getSettings().allowedDirectories;
  };

  const ruleKey = (tool, pattern, action) => `${tool}\u0000${pattern || '*'}\u0000${action}`;
  const listRules = () => read(RULES_FILE, 'rules').filter((r) => r && r.tool && r.action);

  const addPermissionRule = (rule) => {
    if (!rule || !rule.tool || !rule.action) return;
    context.addPermissionRule(rule);
    const key = ruleKey(rule.tool, rule.pattern, rule.action);
    const rules = listRules().filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key);
    rules.push({ tool: rule.tool, pattern: rule.pattern || '*', action: rule.action });
    write(RULES_FILE, 'rules', rules);
  };

  const removePermissionRule = (tool, pattern, action) => {
    const key = ruleKey(tool, pattern, action);
    const rules = listRules();
    if (!rules.some((r) => ruleKey(r.tool, r.pattern, r.action) === key)) {
      const err = new Error(MESSAGES.RULE_NOT_DESKTOP);
      err.code = 'RULE_NOT_DESKTOP';
      throw err;
    }
    context.removePermissionRule(tool, pattern, action);
    write(RULES_FILE, 'rules', rules.filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key));
  };

  return { getSettings, setSettings, addDirectory, listDirectories, addPermissionRule, removePermissionRule, listRules };
}

module.exports = { createDesktopScope };
