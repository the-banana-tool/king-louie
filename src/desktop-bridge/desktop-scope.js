// Desktop-scoped widening (fleet stage 7 §3.4, §8). Directories the desktop
// allows apply to desktop runs only: these wrappers exist only in the bridge
// dispatcher's context, so only marked runs see them. Rules it adds join the
// service's rule list tagged origin: 'desktop', and rule evaluation consults
// them only when no service rule matched (src/tools/permission-rules.js).
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
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('./pairing');
const { guardCheck } = require('../platform/write-guard');
const { MESSAGES } = require('./protocol');
const { DESKTOP_RULE_ORIGIN } = require('../tools/permission-rules');

const log = createLogger('desktop-bridge/desktop-scope');

const DIRS_FILE = 'allowed-directories.json';
const RULES_FILE = 'rules.json';

// Absolute-only, then a canonical form: path.resolve handles mixed "/"
// and "\" separators, "." and ".." segments and duplicate separators, and
// strips any trailing separator (resolve already does this for every
// path except a bare root, hence the extra check below); on win32 the
// drive letter's case is also folded, since resolve() alone leaves it as
// given. Two different spellings of the same real directory — a trailing
// "\", a lowercase drive letter, a stray "..\" a path picker left in —
// now normalize to the same string, so a `list.includes(normalized)`
// dedup or presence check actually catches them instead of silently
// growing a duplicate entry or missing a match. Empty and relative input
// is rejected outright rather than silently resolved against the
// service's cwd, which would be a surprising place for a
// security-relevant allow-list entry to come from.
//
// Symlinks are *not* resolved here (path.resolve is purely syntactic, no
// fs access). A directory does not need to exist yet to be allow-listed
// (the desktop may add a mount point before it's mounted), and baking in
// today's realpath would go stale if the symlink's target changes later.
// Live access — including whatever a symlink resolves to at that moment —
// is checked when it actually matters, by checkPath's
// fs.stat/opendir/open, which follow symlinks the ordinary OS way.
//
// Exported (Task 8 fix round 1, I2) so every comparison that decides
// whether a directory is "the same one" — desktop-scope's own, and the
// import plan's present-check in src/migration/desktop-import.js — uses
// this one definition of "same", instead of each comparing a normalized
// value against a raw one and missing a re-spelling.
function normalizeDirectory(directory) {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  let resolved = path.resolve(trimmed);
  const rootLength = path.parse(resolved).root.length;
  if (resolved.length > rootLength && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -1);
  }
  if (process.platform === 'win32' && /^[a-z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

// `writeGuard` (src/platform/write-guard.js) is passed only by the admin
// CLI's import writer (fleet stage 7 Task 9, fix round 1); the bridge's scope
// has none and writes exactly as before.
function createDesktopScope({ dataDir, context, onPathWritten = () => {}, writeGuard = null }) {
  const dir = path.join(dataDir, 'desktop');
  const writing = new Set();

  // A missing file (the common case — nothing has been written yet) is
  // silently empty. A file that exists but fails to parse, or carries a
  // version this code doesn't recognize, is *also* treated as empty — never
  // trust unrecognized shape into a security-relevant allow-list — but
  // that's a real problem with the file, not the ordinary "nothing here
  // yet" case, so it's logged instead of swallowed.
  const read = (name, key) => {
    const file = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      log.warn(`${name} is not valid JSON; treating it as empty`, { file, error: err.message });
      return [];
    }
    if (!doc || typeof doc !== 'object' || doc.v !== 1) {
      log.warn(`${name} has an unrecognized version; treating it as empty`, { file, v: doc && doc.v });
      return [];
    }
    return Array.isArray(doc[key]) ? doc[key] : [];
  };

  const write = (name, key, list) => {
    if (writing.has(name)) {
      throw new Error(`desktop-scope: reentrant write to ${name}`);
    }
    writing.add(name);
    try {
      const file = path.join(dir, name);
      guardCheck(writeGuard, file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      onPathWritten(dir);
      guardCheck(writeGuard, file);
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
    // own is unnormalized (exactly as the service last wrote it); the
    // desktop list from listDirectories() is already normalized. Comparing
    // them directly would let a re-spelled service directory show up twice.
    const ownNormalized = own.map((d) => normalizeDirectory(d)).filter(Boolean);
    return { ...s, allowedDirectories: [...own, ...listDirectories().filter((d) => !ownNormalized.includes(d))] };
  };

  const setSettings = (next = {}) => {
    const own = serviceDirectories();
    // own is read straight from the service's settings, unnormalized — a
    // trailing separator or a differently-cased drive letter is exactly as
    // the service last wrote it. Comparing an incoming, *normalized*
    // directory against that raw list would miss a re-spelling of the same
    // service directory and let it get added to the desktop-only list too
    // (a real, if harmless-looking, duplicate that would then also survive
    // getSettings' own own.includes(...) filter, since that filter compares
    // the desktop list against the same raw `own`). Normalizing both sides
    // here — while still writing `own` back unchanged — closes that gap.
    const ownNormalized = own.map((d) => normalizeDirectory(d)).filter(Boolean);
    const incoming = Array.isArray(next.allowedDirectories) ? next.allowedDirectories : [];
    const desktopOnly = [];
    const seen = new Set();
    for (const candidate of incoming) {
      const normalized = normalizeDirectory(candidate);
      if (!normalized) {
        log.warn('dropping an invalid allowed directory', { value: candidate });
        continue;
      }
      if (ownNormalized.includes(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      desktopOnly.push(normalized);
    }
    write(DIRS_FILE, 'directories', desktopOnly);
    return context.setSettings({ ...next, allowedDirectories: own });
  };

  const addDirectory = (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) {
      const err = new Error(`Not an absolute directory path: ${JSON.stringify(directory)}`);
      err.code = 'INVALID_DIRECTORY';
      throw err;
    }
    const list = listDirectories();
    // serviceDirectories() is unnormalized; compare against its normalized
    // form so a re-spelling of a directory the service already allows
    // isn't added to the desktop's own list too (I2).
    const ownNormalized = serviceDirectories().map((d) => normalizeDirectory(d)).filter(Boolean);
    if (!list.includes(normalized) && !ownNormalized.includes(normalized)) {
      list.push(normalized);
      write(DIRS_FILE, 'directories', list);
    }
    return getSettings().allowedDirectories;
  };

  const ruleKey = (tool, pattern, action) => `${tool}\u0000${pattern || '*'}\u0000${action}`;
  const listRules = () => read(RULES_FILE, 'rules').filter((r) => r && r.tool && r.action);

  // Every rule added here carries origin: 'desktop' in the context, which
  // puts it in the second tier of rule evaluation (src/tools/permission-
  // rules.js): it applies only when no service rule matched, so a desktop
  // `allow` can never lift a service `deny`, wherever it sits in the list.
  //
  // context.addPermissionRule dedups by (tool, pattern, action) and REPLACES
  // whatever rule already held that key. A rule whose context entry is not
  // desktop-origin belongs to the service — it was written there, or the
  // service re-added (reclaimed) a key the desktop once held, which drops
  // the origin — and is never replaced from here, whatever this scope's own
  // record (rules.json) says. Re-adding a key the desktop does hold (e.g.
  // upgrading ask -> allow) works normally.
  // Returns whether the rule was actually applied (fix round 2, residual
  // I3): a caller that needs to tell a real import from a silent no-op —
  // desktop-import.js reports "kept the service's rule" rather than
  // claiming success — checks this return value instead of assuming every
  // call took effect.
  const addPermissionRule = (rule) => {
    if (!rule || !rule.tool || !rule.action) return false;
    const key = ruleKey(rule.tool, rule.pattern, rule.action);
    const ownedByDesktop = listRules().some((r) => ruleKey(r.tool, r.pattern, r.action) === key);
    const existing = context.getPermissionRules().find((r) => ruleKey(r.tool, r.pattern, r.action) === key);
    if (existing && existing.origin !== DESKTOP_RULE_ORIGIN) {
      log.warn(ownedByDesktop
        ? 'refusing to take over a rule the service has reclaimed'
        : 'refusing to replace an existing rule the desktop does not own', {
        tool: rule.tool, pattern: rule.pattern || '*', action: rule.action, existingSource: existing.source || null
      });
      return false;
    }
    // Checked before the context changes, so a refused scope write can't
    // leave a rule in the context that the desktop's record doesn't list.
    guardCheck(writeGuard, path.join(dir, RULES_FILE));
    context.addPermissionRule({ ...rule, origin: DESKTOP_RULE_ORIGIN });
    const rules = listRules().filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key);
    rules.push({ tool: rule.tool, pattern: rule.pattern || '*', action: rule.action });
    write(RULES_FILE, 'rules', rules);
    return true;
  };

  // Refuses unless the desktop's own record already owns this exact key
  // AND the context's current rule for it is desktop-origin — both must
  // hold, so a key the desktop never legitimately owned (or that the
  // service has since reclaimed) can't be removed from here either.
  const removePermissionRule = (tool, pattern, action) => {
    const key = ruleKey(tool, pattern, action);
    const rules = listRules();
    const ownedByDesktop = rules.some((r) => ruleKey(r.tool, r.pattern, r.action) === key);
    const current = context.getPermissionRules().find((r) => ruleKey(r.tool, r.pattern, r.action) === key);
    if (!ownedByDesktop || !current || current.origin !== DESKTOP_RULE_ORIGIN) {
      const err = new Error(MESSAGES.RULE_NOT_DESKTOP);
      err.code = 'RULE_NOT_DESKTOP';
      throw err;
    }
    context.removePermissionRule(tool, pattern, action);
    write(RULES_FILE, 'rules', rules.filter((r) => ruleKey(r.tool, r.pattern, r.action) !== key));
  };

  return { getSettings, setSettings, addDirectory, listDirectories, addPermissionRule, removePermissionRule, listRules };
}

module.exports = { createDesktopScope, normalizeDirectory };
