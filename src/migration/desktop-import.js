// Import from a desktop profile into the service (fleet stage 7 §3.8). One
// engine for both sources (the desktop over the bridge, and `import --from`).
// Plans carry ids and keys only; secret values exist only inside apply
// batches and are never logged, reported or written to the manifest.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { DEFAULT_SETTINGS, mergeSettings } = require('../core/settings');
const { resolveCasesRoot } = require('../cases');
const { initRepo } = require('../cases/git');
const UserProfile = require('../telos/user-profile');
const { writeFileAtomic } = require('../desktop-bridge/pairing');
const { MESSAGES } = require('../desktop-bridge/protocol');
const { normalizeDirectory } = require('../desktop-bridge/desktop-scope');
const { guardCheck } = require('../platform/write-guard');

const log = createLogger('desktop-import');

const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const IMPORTED_SETTINGS_KEYS = Object.freeze(['defaults', 'checkpoints', 'activeProvider', 'templateVariables', 'providerModels', 'inference', 'notifications', 'voice', 'cases']);
const SECRET_CATEGORIES = new Set(['providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth']);
const CATEGORY_ORDER = Object.freeze(['settings', 'userProfile', 'permissionRule', 'alwaysApprove', 'allowedDirectory', 'chat', 'memory', 'cron', 'case', 'providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth', 'excluded']);
const ACTIONS = Object.freeze(['new', 'update', 'copy', 'skip-present', 'skip-excluded', 'needs-attention', 'needs-desktop']);
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const INSTALL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// No leading dot (fix round 1, M7): a top-level case directory named like a
// dotfile (".git", ".kl") could collide with the case's own internals.
const CASE_DIR_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}$/;
const COPY_SUFFIX = ' (from desktop)';
const ELEVENLABS_TOKEN = '__elevenlabs_api_key';
// Allow-listed the same way provider tokens are (fix round 1, M10): a name
// not in this set never reaches a 'new'/'skip-present' action, only
// 'skip-excluded', so an unknown key can't be planned for import.
const KNOWN_SEARCH_KEYS = new Set(['brave', 'tavily']);
const KNOWN_IMAGE_KEYS = new Set(['fal']);

// Windows reserved device names, with or without an extension (fix round 1,
// M7): CON.txt still opens the console device, not a file named CON.txt.
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);
const isReservedDeviceName = (name) => RESERVED_DEVICE_NAMES.has(String(name).split('.')[0].toLowerCase());
// A trailing dot or space is silently stripped by Windows, so "notes." and
// "notes" name the same file there — never obviously true on POSIX, so
// refused everywhere rather than only where it would matter.
const hasTrailingDotOrSpace = (name) => /[. ]$/.test(String(name));
const isValidCaseDir = (dir) => typeof dir === 'string' && CASE_DIR_RE.test(dir) && !isReservedDeviceName(dir) && !hasTrailingDotOrSpace(dir);

// What stays behind, and why (spec §3.8 "Stays behind").
const EXCLUDED = Object.freeze({
  'mesh.identity': 'the desktop mesh identity and peers stay with the desktop',
  gatewayToken: 'the gateway token belongs to the desktop gateway',
  apiStatus: 'provider status is recomputed by the service',
  embeddings: 'embedding caches and context vectors are rebuilt',
  'tool-results': 'tool results stay with the desktop',
  'background-tasks': 'background tasks stay with the desktop',
  checkpoints: 'checkpoints stay with the desktop',
  voice: 'voice files stay with the desktop',
  skills: 'skills, pins and customizations are set up on the service by an administrator',
  workflows: 'workflows are not available while attached',
  webhooks: 'the webhook registry is set up on the service by an administrator',
  'settings.hooks': 'hooks spawn processes; an administrator sets them with the service CLI',
  'settings.mcpServers': 'MCP servers spawn processes; an administrator sets them with the service CLI',
  'settings.channels': 'a chat bot must not answer from two hosts; an administrator sets channels with the service CLI',
  channelTokens: 'bot tokens stay with the desktop'
});

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const itemKey = (category, key) => `${category}:${key}`;
const arr = (v) => (Array.isArray(v) ? v : []);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const withoutRoot = (cases) => {
  const { root, ...rest } = cases || {};
  return rest;
};
function countActions(items) {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const item of items) counts[item.action] = (counts[item.action] || 0) + 1;
  return counts;
}

// A relative path inside a case: no NUL, not absolute, no drive letter, no
// '.'/'..'/empty segments, no segment that is a Windows reserved device name
// or ends in a dot or space (fix round 1, M7 — these apply per segment, not
// just to the case directory name itself, since any of them could name a
// file the import writes).
function safeRelPath(relPath) {
  const text = String(relPath);
  if (text.includes('\0')) throw new ImportError('BAD_PATH', 'a NUL byte is not allowed in a case path');
  const norm = text.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
  const parts = norm.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
    if (isReservedDeviceName(s)) throw new ImportError('BAD_PATH', `${text} uses a reserved device name`);
    if (hasTrailingDotOrSpace(s)) throw new ImportError('BAD_PATH', `${text} has a trailing dot or space`);
  }
  return parts.join('/');
}

// Whether a case file's name can't be stored on this host (fix round 4,
// ruling (c)). On Windows a ':' in a path segment names an NTFS alternate
// data stream, not a file: ".git::$INDEX_ALLOCATION" reaches the very
// directory ".git" names. Such a file is skipped with an attention note
// rather than refused, so a case holding a name that's legal on macOS or
// Linux ("10:30 call.md") still lands minus that file. Elsewhere ':' is an
// ordinary character; the canonical backstop still refuses the write if the
// name ever resolves somewhere this import doesn't write.
const unstorableOnHost = (rel) => process.platform === 'win32' && rel.split('/').some((s) => s.includes(':'));

// Whether `segment` is ".git" itself, or one of the names a filesystem can
// resolve to the very same directory entry without the segment ever
// literally spelling ".git" (fix round 3, C1, after the reviewer's probe
// found NTFS answers to more than the literal name):
//   - a trailing dot or space — NTFS/FAT silently strip these when
//     resolving a path, so ".git." and ".git " address the same directory
//     ".git" does. (safeRelPath's own hasTrailingDotOrSpace check runs on
//     every segment already, but throws outright; that's wrong for THIS
//     name specifically, which needs the *same* leading-.git/ handling a
//     literal ".git" gets, not a hard refusal that would apply even to an
//     unrelated file that happens to end in a dot.)
//   - the 8.3 short name NTFS auto-assigns to ".git" (and to any later
//     colliding entry): GIT~1, GIT~2, … — this is exactly git's own
//     is_ntfs_dotgit() rule, for the same reason git itself needs it.
// (".git::$INDEX_ALLOCATION", the NTFS alternate-data-stream route to the
// same directory, is caught by unstorableOnHost on Windows, where it's
// skipped, never written.)
function isDotGitSegment(segment) {
  const stripped = String(segment).replace(/[.\s]+$/, '');
  if (stripped.toLowerCase() === '.git') return true;
  return /^git~\d+$/i.test(stripped);
}

// Given the lowercased segments of a path already known to sit under a
// leading .git/ (segs[0] is a .git alias per isDotGitSegment), whether the
// rest of it is one of the few things this import trusts there: HEAD,
// objects/** (except objects/info/**, see below), refs/**, packed-refs,
// info/exclude.
//
// objects/info/** is excluded even though it's under objects/** (fix round
// 3, item 2): objects/info/alternates (and http-alternates) tell git to
// also read objects from another object store entirely. A UNC path there
// makes git open that share as the service account — leaking its NTLM
// credentials to whoever controls it — and a path relative to another
// case's directory reads that case's objects into this one.
function isAllowedUnderDotGit(segs) {
  if (segs.length === 2 && (segs[1] === 'head' || segs[1] === 'packed-refs')) return true;
  if (segs[1] === 'objects' && segs[2] === 'info') return false;
  if (segs[1] === 'objects' || segs[1] === 'refs') return true;
  if (segs.length === 3 && segs[1] === 'info' && segs[2] === 'exclude') return true;
  return false;
}

// What the import may write, may silently drop, or must refuse outright,
// for a case file (fix round 1 C1, hardened in fix round 2 and round 3
// after the reviewer's probes found bypasses). Matched case-insensitively,
// per path segment.
//
// Round 1 blocked only the exact paths .git/config, .git/hooks/** and
// .kl/no-hooks/** at the top of the case. The reviewer's probe showed two
// ways past that: a ".git" *file* at the case root containing
// "gitdir: inner/.git" (a normal git indirection — "gitfile" — that makes
// git treat inner/.git as the real git directory for the whole working
// tree), and a nested "inner/.git/config" (first path segment "inner", so
// the old check's `segs[0] === '.git'` test never even looked at it). A
// .gitattributes file naming a filter defined in that nested config, run on
// `git add`, then executed the filter as the service account.
//
// Round 2's rule is an allow-list for what a LEADING .git/ may contain,
// plus two outright refusals that a silent skip cannot express: a ".git"
// segment anywhere but the very start of the path (closes the
// "inner/.git/config" and ".git/modules/x/config" routes — no legitimate
// case file ever needs a nested git directory), and a bare ".git" *file*.
// Both refusals throw — the caller must never plant them, not even to skip
// them — unlike a plain skip, which is a normal, "accepted but not
// written" outcome counted the same way a landed file is (fix round 2,
// M8).
//
// Round 3: every place this checked `segs[i] === '.git'` literally now
// checks isDotGitSegment(segs[i]) instead — NTFS resolves "GIT~1/config" to
// the very directory ".git/config" would name, once ".git" itself exists
// (created, e.g., by a preceding ".git/HEAD" landing), and the segment
// comparison never saw it. See DesktopImporter#writeCaseFile for the
// second layer this round adds: re-checking the *canonical* path after
// ensureRealDirs, in case some other aliasing this function doesn't yet
// know about slips a write under the real .git anyway.
//
// Exported so the M8 count on the receiving side, and Task 9's desktop-side
// walker, use exactly this decision — never a hand-rolled copy that could
// silently drift out of step with what actually lands.
function isSkippedCaseFile(rel) {
  const segs = rel.toLowerCase().split('/');
  if (segs.length === 2 && segs[0] === '.kl' && segs[1] === 'lock') return true;
  if (segs[0] === '.kl' && segs[1] === 'no-hooks') return true;
  for (let i = 1; i < segs.length; i++) {
    if (isDotGitSegment(segs[i])) throw new ImportError('BAD_PATH', `${rel} has a .git segment that is not at the start of the path`);
  }
  if (!isDotGitSegment(segs[0])) return false;
  if (segs.length === 1) throw new ImportError('BAD_PATH', `${rel}: a ".git" file is not allowed`);
  return !isAllowedUnderDotGit(segs);
}

// Before trusting a landed (or about-to-be-initialized) case directory to
// initRepo, make sure its .git — if present at all — really is a directory
// (fix round 2, C1): defence in depth alongside isSkippedCaseFile's refusal
// of a bare ".git" file, in case that file ever reached disk by some other
// route than a case-file write.
function assertGitDirSafe(caseDir) {
  const gitPath = path.join(caseDir, '.git');
  let st;
  try {
    st = fs.lstatSync(gitPath);
  } catch {
    return; // absent — initRepo will create it fresh
  }
  if (!st.isDirectory()) throw new ImportError('BAD_PATH', `${gitPath} exists but is not a directory`);
}

// Whether `child` is strictly inside `parent`. Compares the *first path
// segment* of the relative path, not a raw string prefix (fix round 1, M6):
// path.relative can legitimately return a string that starts with the two
// characters ".." without meaning "go up a directory" — a file literally
// named "..notes.md" resolves to a relative path of "..notes.md", which
// starts with ".." as a substring but is a single segment naming a file
// inside `parent`, not an escape. Only a segment that IS exactly ".." means
// "go up".
const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
};

// The backstop behind isSkippedCaseFile (fix round 3, widened in fix round
// 4). isSkippedCaseFile judges the spelling the desktop sent, but the
// filesystem can resolve that spelling to a different real path: NTFS
// answers to 8.3 short names ("GIT~1" for .git, a hash form such as
// "KL50A7~1" for .kl), and there may be aliasing nobody has listed yet.
// Once ensureRealDirs has made target's parent exist, ask the filesystem
// (fs.realpathSync.native) for the real path, rebuild the relPath from it
// relative to the real case directory, and run the full skip/refuse
// decision on that rebuilt path. Refuse when it refuses or skips: the
// spelling said "write this", the real name says "never write this". Round
// 3 only rechecked "is it under .git", which let
// "<.kl's short name>/no-hooks/pre-commit" land as .kl/no-hooks/pre-commit.
// If realpath fails, refuse too: a path the filesystem can't name is not
// one to write.
function assertCanonicalPathAllowed(caseDir, target, rel) {
  const refuse = (why) => new ImportError('BAD_PATH', `${rel} resolves to a different path by its real filesystem name (${why}), and this import does not write it`);
  let canonicalRel;
  try {
    const realCaseDir = fs.realpathSync.native(caseDir);
    let exists = true;
    try { fs.lstatSync(target); } catch { exists = false; }
    // An existing target is resolved whole, so a short name in the file
    // name itself is expanded too; a new one can only be the name given.
    const realTarget = exists
      ? fs.realpathSync.native(target)
      : path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
    canonicalRel = path.relative(realCaseDir, realTarget);
  } catch (err) {
    throw refuse(`it could not be resolved: ${err.message}`);
  }
  if (!canonicalRel || path.isAbsolute(canonicalRel) || canonicalRel.split(path.sep)[0] === '..') throw refuse('outside the case');
  const canonical = canonicalRel.split(path.sep).join('/');
  let skipped;
  try {
    skipped = isSkippedCaseFile(canonical);
  } catch (err) {
    throw refuse(err.message);
  }
  if (skipped) throw refuse(canonical);
}

class DesktopImporter {
  // `cleanupStaging: false` skips the constructor's orphaned-staging sweep: a
  // dry run must not delete anything (Task 9 fix round 1, I1). `writeGuard`
  // (src/platform/write-guard.js) is passed only by the admin CLI's writer,
  // which on Windows writes as an Administrator inside a data dir the
  // service account controls (C1); every write, mkdir and removal below then
  // refuses a path that runs through a link. The bridge passes neither and
  // behaves as before.
  constructor({
    context, targets, dataDir, scope, checkPath, cipher = null,
    now = () => new Date(),
    randomId = () => crypto.randomBytes(8).toString('hex'),
    onPathWritten = () => {},
    cleanupStaging = true,
    writeGuard = null
  }) {
    this.context = context;
    this.targets = targets;
    this.dataDir = dataDir;
    this.scope = scope;
    this.checkPath = checkPath;
    this.cipher = cipher;
    this.now = now;
    this.randomId = randomId;
    this.onPathWritten = onPathWritten;
    this.writeGuard = writeGuard;
    this.plans = new Map();
    if (cleanupStaging) this.cleanupOrphanedStaging();
  }

  casesRoot() {
    return resolveCasesRoot({ settings: this.context.getSettings(), dataDir: this.dataDir });
  }

  // A staging directory (.import-<planId>) is normally removed by finish()
  // (success or failure) or by dropPlan() (expiry, connection close). One can
  // still be orphaned if the process exits between apply() and finish() —
  // there's no plan left in memory to expire, so nothing would ever clean it
  // up (fix round 1, M9). Best-effort and non-fatal: a resolution failure or
  // a removal failure just gets logged, never thrown from the constructor.
  cleanupOrphanedStaging() {
    let root;
    try {
      root = this.casesRoot();
    } catch (err) {
      log.warn('could not resolve the cases root to clean up orphaned import staging directories', { error: err.message });
      return;
    }
    try {
      guardCheck(this.writeGuard, root);
    } catch (err) {
      log.warn('not cleaning up orphaned import staging directories', { error: err.message });
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return; // cases root doesn't exist yet — nothing to clean up
    }
    for (const name of entries) {
      if (!name.startsWith('.import-')) continue;
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      } catch (err) {
        log.warn('could not remove an orphaned import staging directory', { dir: name, error: err.message });
      }
    }
  }

  manifestPath(installId) {
    return path.join(this.dataDir, 'imports', `desktop-${installId}.json`);
  }

  readManifest(installId) {
    try {
      const doc = JSON.parse(fs.readFileSync(this.manifestPath(installId), 'utf8'));
      if (doc && doc.v === 1 && doc.items && typeof doc.items === 'object') {
        return { v: 1, installId, runs: arr(doc.runs), items: doc.items };
      }
    } catch { /* no manifest yet */ }
    return { v: 1, installId, runs: [], items: {} };
  }

  writeManifest(manifest) {
    const dir = path.join(this.dataDir, 'imports');
    const file = this.manifestPath(manifest.installId);
    guardCheck(this.writeGuard, file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.onPathWritten(dir);
    guardCheck(this.writeGuard, file);
    writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    this.onPathWritten(file);
  }

  expire() {
    const now = this.now().getTime();
    for (const [planId, plan] of this.plans) {
      if (now - plan.createdAt > PLAN_TTL_MS) this.dropPlan(planId);
    }
  }

  dropPlan(planId) {
    this.plans.delete(planId);
    try {
      const staging = path.join(this.casesRoot(), `.import-${planId}`);
      guardCheck(this.writeGuard, staging);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch { /* nothing staged, or not safe to touch */ }
  }

  expireConnection(connectionId) {
    for (const [planId, plan] of this.plans) {
      if (plan.connectionId === connectionId) this.dropPlan(planId);
    }
  }

  getPlan(planId) {
    this.expire();
    const plan = this.plans.get(planId);
    if (!plan) throw new ImportError('PLAN_EXPIRED', 'The import plan expired; plan the import again.');
    return plan;
  }

  copyId(id, chats) {
    let next;
    do { next = `${id}-${this.randomId().slice(0, 4)}`; } while (chats.some((c) => c.id === next));
    return next;
  }

  async plan({ installId, inventory, source = 'bridge', connectionId = null } = {}) {
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) throw new ImportError('BAD_REQUEST', 'installId must be 1-64 letters, digits or dashes');
    if (!inventory || typeof inventory !== 'object') throw new ImportError('BAD_REQUEST', 'an inventory is required');
    this.expire();
    const manifest = this.readManifest(installId);
    const done = (category, key) => {
      const entry = manifest.items[itemKey(category, key)];
      return entry && entry.result === 'ok' ? entry : null;
    };
    const items = [];
    const add = (category, key, action, note = null, targetKey = key) => items.push({ category, key: String(key), action, note, targetKey: targetKey === null ? null : String(targetKey) });

    const settings = this.context.getSettings();
    const defaults = mergeSettings(DEFAULT_SETTINGS);
    for (const key of arr(inventory.settingsKeys)) {
      if (!IMPORTED_SETTINGS_KEYS.includes(key)) { add('settings', key, 'skip-excluded', EXCLUDED[`settings.${key}`] || 'this setting is managed on the service'); continue; }
      const current = key === 'cases' ? withoutRoot(settings.cases) : settings[key];
      const dflt = key === 'cases' ? withoutRoot(defaults.cases) : defaults[key];
      add('settings', key, stable(current) === stable(dflt) ? 'new' : 'skip-present');
    }

    if (inventory.userProfile) {
      add('userProfile', 'userProfile', stable(this.targets.userProfile.get()) === stable(UserProfile.getDefaultProfile()) ? 'new' : 'skip-present');
    }

    const rules = this.context.getPermissionRules();
    for (const r of arr(inventory.permissionRules)) {
      if (!r || !r.tool || !['allow', 'ask', 'deny'].includes(r.action)) continue;
      const pattern = r.pattern || '*';
      const exists = rules.some((x) => x.tool === r.tool && (x.pattern || '*') === pattern && x.action === r.action);
      add('permissionRule', `${r.tool}|${pattern}|${r.action}`, exists ? 'skip-present' : 'new');
    }

    const approvals = (this.context.getStore().get('toolApprovals', {}) || {}).alwaysApproveTools || {};
    for (const tool of arr(inventory.alwaysApprove)) {
      add('alwaysApprove', tool, approvals[tool] ? 'skip-present' : 'new', 'applies only to runs started from the desktop');
    }

    // Both sides normalized before comparing (fix round 1, I2): the
    // desktop's own list is already normalized, but the service's raw
    // settings.allowedDirectories is exactly as last written, and the
    // incoming inventory entry is whatever the desktop happened to spell it
    // as. Comparing without normalizing both sides misses a re-spelling
    // (trailing separator, drive-letter case) of a directory that's already
    // allowed, and plans it as 'new' when it's really already present.
    const desktopNormalized = this.scope.listDirectories().map((d) => normalizeDirectory(d)).filter(Boolean);
    const serviceNormalized = arr(settings.allowedDirectories).map((d) => normalizeDirectory(d)).filter(Boolean);
    for (const dir of arr(inventory.allowedDirectories)) {
      if (typeof dir !== 'string' || !dir) continue;
      const normalized = normalizeDirectory(dir);
      if (!normalized) { add('allowedDirectory', dir, 'needs-attention', `${dir} is not an absolute directory path`); continue; }
      if (desktopNormalized.includes(normalized) || serviceNormalized.includes(normalized)) { add('allowedDirectory', dir, 'skip-present'); continue; }
      const check = await this.checkPath(normalized);
      if (check.readable && check.isDirectory) add('allowedDirectory', dir, 'new', 'applies only to runs started from the desktop');
      else add('allowedDirectory', dir, 'needs-attention', `the service cannot read ${dir}`);
    }

    const chats = this.context.getChats();
    // Remembers the live updatedAt an 'update' action was planned against,
    // so apply() can tell whether the service's copy is still the one the
    // plan looked at (fix round 1, I4) before overwriting it.
    const chatExpected = new Map();
    for (const c of arr(inventory.chats)) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      const entry = done('chat', c.id);
      if (entry) {
        const target = chats.find((x) => x.id === entry.targetKey);
        const sourceChanged = c.updatedAt !== entry.sourceUpdatedAt;
        const targetChanged = !target || target.updatedAt !== entry.targetUpdatedAt;
        if (!sourceChanged) add('chat', c.id, 'skip-present', null, entry.targetKey);
        else if (!targetChanged) { add('chat', c.id, 'update', null, entry.targetKey); chatExpected.set(entry.targetKey, target.updatedAt); }
        else add('chat', c.id, 'copy', 'changed on both sides; imported as a copy', this.copyId(c.id, chats));
        continue;
      }
      const existing = chats.find((x) => x.id === c.id);
      if (!existing) add('chat', c.id, 'new');
      else if (existing.updatedAt === c.updatedAt) add('chat', c.id, 'skip-present');
      else add('chat', c.id, 'copy', 'a different chat with this id exists; imported as a copy', this.copyId(c.id, chats));
    }

    for (const id of arr(inventory.memory)) {
      add('memory', id, done('memory', id) || this.targets.memory.has(id) ? 'skip-present' : 'new');
    }
    for (const job of arr(inventory.cron)) {
      if (!job || !job.id) continue;
      add('cron', job.id, done('cron', job.id) || this.targets.cron.has(job.id) ? 'skip-present' : 'new', 'imported disabled');
    }

    if (inventory.customCasesRoot) {
      add('case', inventory.customCasesRoot, 'needs-attention', `cases under a custom cases.root (${inventory.customCasesRoot}) are not copied; move them by hand`);
    }
    const root = this.casesRoot();
    // What the inventory said a case should land with, kept so finish() can
    // tell a short delivery (fix round 1, M8) from a complete one.
    const caseExpected = new Map();
    for (const c of arr(inventory.cases)) {
      const dir = c && c.dir;
      if (!isValidCaseDir(dir)) { add('case', String(dir), 'needs-attention', 'not a valid case directory name'); continue; }
      const exists = fs.existsSync(path.join(root, dir));
      if (!exists) {
        add('case', dir, 'new');
        caseExpected.set(dir, {
          files: Number.isFinite(c.files) ? c.files : null,
          bytes: Number.isFinite(c.bytes) ? c.bytes : null
        });
      } else if (done('case', dir)) add('case', dir, 'skip-present');
      else add('case', dir, 'needs-attention', 'a case with this directory already exists on the service');
    }

    const secretMode = inventory.secrets || 'included';
    const tokens = this.context.getApiTokens() || {};
    const knownTokens = new Set([...Object.keys(this.context.providerLabels || {}), ELEVENLABS_TOKEN]);
    const secret = (category, key, present) => {
      if (present) return add(category, key, 'skip-present');
      if (secretMode === 'needs-desktop') return add(category, key, 'needs-desktop', 'only the desktop app can read its secrets; import from Settings > Local service');
      if (secretMode === 'unavailable') return add(category, key, 'needs-attention', MESSAGES.SECURE_STORAGE_UNAVAILABLE);
      return add(category, key, 'new');
    };
    for (const p of arr(inventory.providerTokens)) {
      if (!knownTokens.has(p)) { add('providerToken', p, 'skip-excluded', 'not a provider key this service uses'); continue; }
      secret('providerToken', p, Boolean(tokens[p]));
    }
    for (const p of arr(inventory.searchKeys)) {
      if (!KNOWN_SEARCH_KEYS.has(p)) { add('searchKey', p, 'skip-excluded', 'not a search provider key this service uses'); continue; }
      secret('searchKey', p, Boolean(settings.webSearch && settings.webSearch[p] && settings.webSearch[p].apiKey));
    }
    for (const p of arr(inventory.imageKeys)) {
      if (!KNOWN_IMAGE_KEYS.has(p)) { add('imageKey', p, 'skip-excluded', 'not an image provider key this service uses'); continue; }
      secret('imageKey', p, Boolean(settings.imageGeneration && settings.imageGeneration[p] && settings.imageGeneration[p].apiKey));
    }
    for (const k of arr(inventory.vault)) secret('vault', k, this.context.vault.has(k));
    if (inventory.anthropicOAuth) {
      const stored = this.context.getStore().get('anthropicOAuth');
      secret('anthropicOAuth', 'anthropicOAuth', Boolean(stored && stored.accessToken));
    }
    for (const key of arr(inventory.excluded)) add('excluded', key, 'skip-excluded', EXCLUDED[key] || 'stays with the desktop');

    items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    const planId = this.randomId();
    this.plans.set(planId, {
      planId, installId, source, connectionId,
      createdAt: this.now().getTime(),
      items: new Map(items.map((i) => [itemKey(i.category, i.key), i])),
      results: new Map(),
      caseFiles: new Map(),
      caseExpected,
      chatExpected
    });
    log.info(`planned a desktop import: ${items.length} items`, { planId, source });
    return { planId, items, counts: countActions(items) };
  }

  async apply({ planId, batch } = {}) {
    const plan = this.getPlan(planId);
    if (!Array.isArray(batch)) throw new ImportError('BAD_REQUEST', 'batch must be an array');
    if (Buffer.byteLength(JSON.stringify(batch)) > MAX_BATCH_BYTES) throw new ImportError('BATCH_TOO_LARGE', 'an import batch is at most 2 MiB');
    const results = [];
    for (const entry of batch) {
      const category = entry && entry.category;
      const key = entry ? String(entry.key) : '';
      const k = itemKey(category, key);
      const item = plan.items.get(k);
      if (!item || !WRITE_ACTIONS.has(item.action)) {
        results.push({ category, key, ok: false, error: 'not planned for import' });
        continue;
      }
      try {
        const out = (await this.write(plan, item, entry.value)) || {};
        results.push(out.note ? { category, key, ok: true, note: out.note } : { category, key, ok: true });
        if (category !== 'case') plan.results.set(k, { ok: true, note: out.note || null, attention: Boolean(out.attention), record: out.record || null });
      } catch (err) {
        log.warn(`importing ${category}${SECRET_CATEGORIES.has(category) ? '' : ` ${key}`} failed: ${err.message}`);
        results.push({ category, key, ok: false, error: err.message });
        if (category === 'case') {
          const files = plan.caseFiles.get(key) || { count: 0, bytes: 0, failed: null, seen: new Map() };
          files.failed = files.failed || err.message;
          plan.caseFiles.set(key, files);
        } else {
          plan.results.set(k, { ok: false, error: err.message });
        }
      }
    }
    return { results };
  }

  requireCipher() {
    if (this.cipher && !this.cipher.isEncryptionAvailable()) throw new ImportError('ENCRYPTION_UNAVAILABLE', 'Encryption unavailable in the service.');
  }

  requireSecretString(value) {
    if (typeof value !== 'string' || !value) throw new ImportError('BAD_VALUE', 'the secret value is missing');
  }

  async write(plan, item, value) {
    const ctx = this.context;
    switch (item.category) {
      case 'settings': {
        const s = ctx.getSettings();
        const dflt = mergeSettings(DEFAULT_SETTINGS);
        const current = item.key === 'cases' ? withoutRoot(s.cases) : s[item.key];
        const base = item.key === 'cases' ? withoutRoot(dflt.cases) : dflt[item.key];
        if (stable(current) !== stable(base)) return { note: 'already set on the service; left unchanged' };
        const next = item.key === 'cases'
          ? { ...withoutRoot(value), ...(s.cases && s.cases.root !== undefined ? { root: s.cases.root } : {}) }
          : value;
        ctx.setSettings({ ...s, [item.key]: next });
        return {};
      }
      case 'userProfile': {
        // Written only if the service's profile is still the default one
        // (fix round 1, I4): re-checked here, not just at plan time, since
        // the owner could have filled it in between plan() and apply().
        if (stable(this.targets.userProfile.get()) !== stable(UserProfile.getDefaultProfile())) {
          return { note: 'a profile was set on the service after the plan was made; not overwritten' };
        }
        this.targets.userProfile.update(value && typeof value === 'object' ? value : {});
        return {};
      }
      case 'permissionRule': {
        const [tool, pattern, action] = item.key.split('|');
        if (!value || value.tool !== tool || (value.pattern || '*') !== pattern || value.action !== action) throw new ImportError('BAD_VALUE', 'the rule does not match the plan');
        // Through the scope (fix round 1, I3), so the desktop owns the
        // imported rule (can later remove it itself) and the scope's own
        // ownership check — never replace a rule the service already
        // holds — applies to an imported rule exactly as it does to one
        // added interactively. 'allow' rules are permitted; spec §8 does
        // not exclude them, only hooks/MCP/channels.
        //
        // The scope can refuse this silently (a race since plan() also
        // matched — the service claimed the key in between); its return
        // value says which, so that refusal is reported rather than
        // appearing to have imported the rule (fix round 2, residual I3).
        const added = this.scope.addPermissionRule({ tool, pattern, action, source: 'desktop-import' });
        return added ? {} : { note: "kept the service's rule" };
      }
      case 'alwaysApprove':
        ctx.setToolAlwaysApprove(item.key, true);
        return {};
      case 'allowedDirectory': {
        const check = await this.checkPath(item.key);
        if (!check.readable || !check.isDirectory) throw new ImportError('PATH_NOT_ACCESSIBLE', `the service cannot read ${item.key}`);
        this.scope.addDirectory(item.key);
        return {};
      }
      case 'chat':
        return this.writeChat(plan, item, value);
      case 'memory': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the memory entry does not match the plan');
        const out = this.targets.memory.importEntry(value);
        return out.imported ? {} : { note: 'already present' };
      }
      case 'cron': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the cron job does not match the plan');
        // System jobs (C2's cases:wakeups) belong to the receiving core, which
        // creates its own. The offline import --from writer adds straight to the
        // cron store, so refuse one here whatever the desktop sent.
        if (value.system === true) throw new ImportError('BAD_VALUE', 'a system job is not imported; the service makes its own');
        // Written only if the id is still absent (fix round 1, I4).
        if (this.targets.cron.has(item.key)) {
          return { note: 'a cron job with this id was added to the service after the plan was made; not overwritten' };
        }
        await this.targets.cron.addJob({ ...value, enabled: false });
        return { note: 'imported disabled' };
      }
      case 'case':
        return this.writeCaseFile(plan, item, value);
      case 'providerToken': {
        this.requireCipher();
        this.requireSecretString(value);
        const tokens = { ...(ctx.getApiTokens() || {}) };
        // Written only if still absent (fix round 1, I4).
        if (tokens[item.key]) {
          return { note: 'a token for this provider was added to the service after the plan was made; not overwritten' };
        }
        tokens[item.key] = ctx.encryptToken(value);
        ctx.setApiTokens(tokens);
        return {};
      }
      case 'searchKey':
      case 'imageKey': {
        this.requireCipher();
        this.requireSecretString(value);
        const s = ctx.getSettings();
        const section = item.category === 'searchKey' ? 'webSearch' : 'imageGeneration';
        const current = { ...(s[section] || {}) };
        // Written only if still absent (fix round 1, I4).
        if (current[item.key] && current[item.key].apiKey) {
          return { note: 'a key for this provider was added to the service after the plan was made; not overwritten' };
        }
        current[item.key] = { ...(current[item.key] || {}), apiKey: ctx.encryptToken(value) };
        ctx.setSettings({ ...s, [section]: current });
        return {};
      }
      case 'vault': {
        this.requireCipher();
        this.requireSecretString(value);
        // Written only if still absent (fix round 1, I4).
        if (ctx.vault.has(item.key)) {
          return { note: 'a secret with this name was added to the service after the plan was made; not overwritten' };
        }
        ctx.vault.set(item.key, value);
        if (ctx.vault.get(item.key) !== value) throw new ImportError('VERIFY_FAILED', 'the secret did not read back as written');
        return {};
      }
      case 'anthropicOAuth': {
        this.requireCipher();
        if (!value || typeof value.accessToken !== 'string' || !value.accessToken) throw new ImportError('BAD_VALUE', 'the OAuth record is incomplete');
        const store = ctx.getStore();
        // Written only if still absent (fix round 1, I4).
        const stored = store.get('anthropicOAuth');
        if (stored && stored.accessToken) {
          return { note: 'an Anthropic OAuth connection was added to the service after the plan was made; not overwritten' };
        }
        store.set('anthropicOAuth', {
          accessToken: ctx.encryptToken(value.accessToken),
          refreshToken: value.refreshToken ? ctx.encryptToken(value.refreshToken) : null,
          expiresAt: value.expiresAt ?? null,
          connectedAt: value.connectedAt ?? Date.now()
        });
        if (typeof value.clientId === 'string' && value.clientId) store.set('anthropicOAuthClientId', value.clientId);
        return {};
      }
      default:
        throw new ImportError('BAD_REQUEST', `unknown category ${item.category}`);
    }
  }

  // Re-checks presence/updatedAt against `liveChats` exactly as write()'s
  // pre-checkPath call did (fix round 1, I4); returns a result to short
  // -circuit on, or null if the write is still safe to make.
  chatRaceCheck(plan, item, value, liveChats) {
    if (item.action === 'new') {
      const collision = liveChats.find((c) => c.id === item.targetKey);
      if (collision) {
        return {
          note: 'a chat with this id was added to the service after the plan was made; not overwritten',
          record: { sourceUpdatedAt: value.updatedAt || null, targetKey: collision.id, targetUpdatedAt: collision.updatedAt || null }
        };
      }
    } else if (item.action === 'update') {
      const target = liveChats.find((c) => c.id === item.targetKey);
      const expected = plan.chatExpected.get(item.targetKey);
      if (!target || target.updatedAt !== expected) {
        return {
          note: 'the chat changed on the service after the plan was made; import again to pick up the current version',
          attention: true
        };
      }
    }
    return null;
  }

  async writeChat(plan, item, value) {
    if (!value || value.id !== item.key || !Array.isArray(value.messages)) throw new ImportError('BAD_VALUE', 'the chat does not match the plan');
    // Fail fast if the race has already happened, before doing any of the
    // work below (in particular the checkPath await).
    const early = this.chatRaceCheck(plan, item, value, this.context.getChats());
    if (early) return early;

    let note = null;
    let chat = { ...value };
    if (chat.workingDirectory) {
      // This await is exactly where fix round 2 found the gap: liveChats
      // read before it can go stale by the time setChats below runs, so
      // whatever changed the service's chats during this call — another
      // apply(), a live chat edit — would be silently overwritten by a
      // write built from a snapshot taken before the wait.
      const check = await this.checkPath(chat.workingDirectory);
      if (!check.readable || !check.isDirectory) {
        note = `the service cannot read the working directory ${chat.workingDirectory}; it was dropped`;
        chat.workingDirectory = null;
      }
    }
    chat = item.action === 'copy'
      ? { ...chat, id: item.targetKey, title: `${chat.title || 'Chat'}${COPY_SUFFIX}` }
      : { ...chat, id: item.targetKey };

    // Read live state again immediately before writing, with no await
    // between this read and setChats, and re-run the same check against
    // it (fix round 2, I4): this is the read setChats below actually acts
    // on, so it — and the presence/updatedAt decision — must be fresh.
    const liveChats = this.context.getChats();
    const late = this.chatRaceCheck(plan, item, value, liveChats);
    if (late) return late;
    const updated = item.action === 'update'
      ? liveChats.map((c) => (c.id === item.targetKey ? chat : c))
      : [chat, ...liveChats.filter((c) => c.id !== chat.id)];
    this.context.setChats(updated);
    return {
      note,
      attention: Boolean(note),
      record: { sourceUpdatedAt: value.updatedAt || null, targetKey: chat.id, targetUpdatedAt: chat.updatedAt || null }
    };
  }

  ensureRealDirs(root, dir) {
    guardCheck(this.writeGuard, dir);
    // mkdirSync returns the first directory it had to create; that one and
    // every one below it down to the root are new, and reported so the
    // ownership backstop can hand them back (Task 9 fix round 1, I2).
    const first = fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (first) {
      const created = [];
      for (let p = path.resolve(root); ; p = path.dirname(p)) {
        created.unshift(p);
        if (p === path.resolve(first) || path.dirname(p) === p) break;
      }
      for (const p of created) this.onPathWritten(p);
    }
    guardCheck(this.writeGuard, dir);
    const rel = path.relative(root, dir);
    let cur = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { st = null; }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ImportError('BAD_PATH', `${cur} is a link or not a directory`);
      if (!st) {
        fs.mkdirSync(cur, { mode: 0o700 });
        this.onPathWritten(cur);
      }
    }
    guardCheck(this.writeGuard, dir);
  }

  writeCaseFile(plan, item, value) {
    if (!value || typeof value.relPath !== 'string' || typeof value.b64 !== 'string') throw new ImportError('BAD_VALUE', 'a case file needs relPath and b64');
    const rel = safeRelPath(value.relPath);
    // isSkippedCaseFile throws for a path this import refuses outright (a
    // nested .git segment, a bare ".git" file) — that throw must happen
    // before any accounting below, so a refused path is never counted as
    // received (fix round 2, M8: only *accepted* paths — landed or
    // deliberately skipped — count; a refusal is neither).
    const land = !isSkippedCaseFile(rel);
    const offset = Number.isInteger(value.offset) ? value.offset : 0;
    const data = Buffer.from(value.b64, 'base64');

    // Every accepted relPath is counted once, tracked by name rather than
    // by "was this the chunk at offset 0" (fix round 2, M8): a desktop
    // retry that resends a whole file from scratch (offset 0 again, for a
    // relPath already seen) resets that file's byte tally instead of
    // counting it a second time or adding its bytes on top of the earlier,
    // now-superseded attempt.
    const files = plan.caseFiles.get(item.key) || { count: 0, bytes: 0, failed: null, seen: new Map() };
    const prevSize = files.seen.get(rel);
    if (offset === 0) {
      if (prevSize === undefined) files.count += 1;
      else files.bytes -= prevSize;
      files.seen.set(rel, data.length);
      files.bytes += data.length;
    } else {
      if (prevSize === undefined || prevSize !== offset) throw new ImportError('BAD_OFFSET', `${value.relPath}: chunk at ${offset} does not follow the data received`);
      files.seen.set(rel, prevSize + data.length);
      files.bytes += data.length;
    }
    plan.caseFiles.set(item.key, files);

    if (!land) return { note: 'not imported: git internals are recreated by the service, not carried over' };
    if (unstorableOnHost(rel)) {
      files.unstorable = files.unstorable || new Set();
      files.unstorable.add(rel);
      return { note: "not imported: Windows cannot store a file with ':' in its name" };
    }

    const root = this.casesRoot();
    const caseDir = path.join(root, `.import-${plan.planId}`, item.key);
    const target = path.join(caseDir, ...rel.split('/'));
    if (!isInside(caseDir, target)) throw new ImportError('BAD_PATH', `${value.relPath} escapes the case directory`);
    this.ensureRealDirs(root, path.dirname(target));
    // isSkippedCaseFile judged the spelling the desktop sent; judge the real
    // path too (fix rounds 3 and 4, see assertCanonicalPathAllowed).
    assertCanonicalPathAllowed(caseDir, target, rel);
    guardCheck(this.writeGuard, target);
    let existing = null;
    try { existing = fs.lstatSync(target); } catch { existing = null; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ImportError('BAD_PATH', `${value.relPath} is a link or not a file`);
    if (existing && existing.nlink > 1) throw new ImportError('BAD_PATH', `${value.relPath} has ${existing.nlink} hard links`);
    const mode = Number.isInteger(value.mode) ? ((value.mode & 0o755) | 0o600) : 0o600;
    // Never write through whatever is at the name (Task 9 fix round 1): a
    // first chunk replaces the file with a fresh exclusive create; a later
    // chunk opens without following a link (where the platform can) and
    // appends only if the handle is the very file just checked.
    if (offset === 0) {
      if (existing) fs.rmSync(target, { force: true });
      const fd = fs.openSync(target, 'wx', mode);
      try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    } else {
      if (!existing || existing.size !== offset) throw new ImportError('BAD_OFFSET', `${value.relPath}: chunk at ${offset} does not follow the data received`);
      const c = fs.constants;
      const fd = fs.openSync(target, c.O_WRONLY | c.O_APPEND | (c.O_NOFOLLOW || 0));
      try {
        const st = fs.fstatSync(fd);
        if (st.ino !== existing.ino || st.dev !== existing.dev || st.nlink > 1 || st.size !== offset) {
          throw new ImportError('BAD_PATH', `${value.relPath} changed while it was being written`);
        }
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.onPathWritten(target);
    return {};
  }

  reportTree(target) {
    this.onPathWritten(target);
    let st;
    try { st = fs.lstatSync(target); } catch { return; }
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(target)) this.reportTree(path.join(target, name));
  }

  async finish({ planId } = {}) {
    const plan = this.getPlan(planId);
    const manifest = this.readManifest(plan.installId);
    const at = this.now().toISOString();
    const root = this.casesRoot();
    const staging = path.join(root, `.import-${plan.planId}`);
    for (const [dir, files] of plan.caseFiles) {
      const k = itemKey('case', dir);
      if (files.failed) { plan.results.set(k, { ok: false, error: files.failed }); continue; }
      const stagedDir = path.join(staging, dir);
      const dest = path.join(root, dir);
      try {
        guardCheck(this.writeGuard, stagedDir);
        guardCheck(this.writeGuard, dest);
      } catch (err) {
        plan.results.set(k, { ok: false, error: err.message });
        continue;
      }
      if (fs.existsSync(dest)) {
        plan.results.set(k, { ok: false, error: 'a case with this directory appeared on the service during the import' });
        continue;
      }
      // The case's own git config is never imported (isSkippedCaseFile's
      // allow-list keeps it out) — recreate it fresh with initRepo's safe
      // settings (fix round 1, C1) rather than leave the landed repo
      // running on whatever default git would pick up. Run while the case
      // is still in staging, before the rename (fix round 2): on failure —
      // git missing, or assertGitDirSafe's ".git must be a directory" check
      // — the half-set-up case never reaches its real location; its staged
      // files are removed and the outcome is reported as attention, not a
      // hard failure, so a later plan() call offers it as 'new' again
      // rather than leaving something broken and unfixable in place.
      try {
        assertGitDirSafe(stagedDir);
        await initRepo(stagedDir);
      } catch (err) {
        try {
          fs.rmSync(stagedDir, { recursive: true, force: true });
        } catch (rmErr) {
          log.warn("could not remove a case's staged files after its git setup failed", { dir, error: rmErr.message });
        }
        plan.results.set(k, {
          ok: false,
          attention: true,
          error: err.message,
          note: `the case's git setup failed after landing (${err.message}); its files were removed — import it again`
        });
        continue;
      }
      try {
        fs.renameSync(stagedDir, dest);
        // After initRepo (fix round 2), so onPathWritten sees the files
        // initRepo itself just wrote (a freshly-created .git, or its
        // rewritten config), not just what the batch delivered.
        this.reportTree(dest);
        // A short delivery — fewer files or fewer bytes than the inventory
        // promised — is surfaced as attention, not silently reported ok
        // (fix round 1, M8): the batch may have been cut short by a
        // connection drop the caller didn't otherwise notice.
        const expected = plan.caseExpected.get(dir);
        const short = Boolean(expected) && (
          (expected.files !== null && files.count !== expected.files)
          || (expected.bytes !== null && files.bytes !== expected.bytes)
        );
        const notes = [];
        if (short) notes.push(`received ${files.count} file(s)/${files.bytes} byte(s); the inventory listed ${expected.files ?? '?'} file(s)/${expected.bytes ?? '?'} byte(s) — the case may be incomplete`);
        // Fix round 4, ruling (c): names Windows can't store were skipped;
        // the rest of the case landed, and the owner is told which.
        if (files.unstorable && files.unstorable.size) {
          notes.push(`${files.unstorable.size} file(s) with ':' in the name were not copied, because Windows cannot store that name: ${[...files.unstorable].join(', ')}`);
        }
        plan.results.set(k, {
          ok: true,
          attention: notes.length > 0,
          note: notes.length ? notes.join('; ') : null,
          record: { targetKey: dir }
        });
      } catch (err) {
        plan.results.set(k, { ok: false, error: err.message });
      }
    }
    // Best-effort: a removal failure (e.g. a file still briefly open on
    // Windows) is logged, not thrown — finish() has already recorded every
    // case's outcome above, and cleanupOrphanedStaging() sweeps anything
    // left behind here the next time this importer is constructed (M9).
    try {
      guardCheck(this.writeGuard, staging);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      log.warn('could not remove the import staging directory', { staging, error: err.message });
    }

    const items = [...plan.items.values()];
    const failures = [];
    const attention = [];
    const secretsMissing = [];
    let cronDisabled = 0;
    for (const item of items) {
      const k = itemKey(item.category, item.key);
      if (item.action === 'needs-attention') attention.push({ category: item.category, key: item.key, note: item.note });
      if (!WRITE_ACTIONS.has(item.action)) continue;
      const r = plan.results.get(k);
      if (!r || !r.ok) {
        const error = r ? r.error : 'not sent by the desktop';
        // A result explicitly marked attention (fix round 2: a case whose
        // git setup failed after landing, cleaned up and retryable) is
        // reported there, not as a failure — it's still unwritten and
        // still gets no manifest entry, so a later plan() offers it again,
        // but it isn't a hard error the caller needs to investigate.
        if (r && r.attention) attention.push({ category: item.category, key: item.key, note: r.note || error });
        else {
          failures.push({ category: item.category, key: item.key, error });
          if (SECRET_CATEGORIES.has(item.category)) secretsMissing.push({ category: item.category, key: item.key });
        }
        continue;
      }
      if (r.attention) attention.push({ category: item.category, key: item.key, note: r.note });
      if (item.category === 'cron') cronDisabled += 1;
      manifest.items[k] = { at, result: 'ok', ...(r.record || {}) };
    }
    manifest.runs.push({ planId: plan.planId, at, source: plan.source });
    this.writeManifest(manifest);
    this.plans.delete(plan.planId);
    const counts = countActions(items);
    counts.failed = failures.length;
    log.info(`finished a desktop import: ${failures.length} failed`, { planId: plan.planId });
    return {
      planId: plan.planId,
      counts,
      failures,
      attention,
      secretsMissing,
      cronDisabled,
      notes: cronDisabled ? [`${cronDisabled} cron job(s) were imported disabled; enable them in Settings > Scheduler.`] : []
    };
  }
}

// Where memory, cron and the user profile are written. The running service
// uses its started core; the CLI (offline) opens the stores directly, so it
// never starts a core (and never launches MCP servers or hooks) as root.
async function buildImportTargets({ context, dataDir, offline = false, writeGuard = null }) {
  if (!offline) {
    const memory = context.getMemoryManager();
    const cron = context.getCronScheduler();
    if (!memory || !cron) throw new Error('the service core is not started');
    return {
      memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
      cron: { has: (id) => cron.listJobs().some((j) => j.id === id), addJob: (job) => cron.addJob(job) },
      userProfile: { get: () => context.getUserProfile(), update: (profile) => context.updateUserProfile(profile) },
      writtenPaths: []
    };
  }
  const { MemoryStore, MemoryManager } = require('../memory');
  const CronStore = require('../cron/cron-store');
  const memoryFile = path.join(dataDir, 'memory', 'memory-store.json');
  const memory = new MemoryManager({ store: new MemoryStore({ storageFile: memoryFile, writeGuard }) });
  const cronFile = path.join(dataDir, 'cron', 'jobs.json');
  const cronStore = new CronStore(cronFile, { writeGuard });
  await cronStore.load();
  const store = context.getStore();
  return {
    memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
    cron: { has: (id) => Boolean(cronStore.get(id)), addJob: (job) => cronStore.add(job) },
    userProfile: {
      get: () => store.get('userProfile', UserProfile.getDefaultProfile()),
      update: (profile) => store.set('userProfile', { ...UserProfile.getDefaultProfile(), ...profile })
    },
    writtenPaths: [path.dirname(memoryFile), memoryFile, path.dirname(cronFile), cronFile]
  };
}

module.exports = {
  DesktopImporter,
  ImportError,
  buildImportTargets,
  IMPORTED_SETTINGS_KEYS,
  SECRET_CATEGORIES,
  CATEGORY_ORDER,
  EXCLUDED,
  PLAN_TTL_MS,
  MAX_BATCH_BYTES,
  INSTALL_ID_RE,
  CASE_DIR_RE,
  isSkippedCaseFile,
  safeRelPath,
  isValidCaseDir
};
