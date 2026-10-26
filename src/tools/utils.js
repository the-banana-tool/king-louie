const fs = require('fs');
const path = require('path');
const { defaultServiceDataDir } = require('../platform/paths');

const DEFAULT_DANGEROUS_COMMAND_PATTERNS = [
  {
    pattern: /\brm\s+-rf\s+(\/|\.\.|~|\$HOME)(\s|$)/i,
    reason: 'Recursive force-delete targeting a root or home path.',
    severity: 'deny'
  },
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/i,
    reason: 'Filesystem formatting command detected.',
    severity: 'deny'
  },
  {
    pattern: /\bdd\s+if=/i,
    reason: 'Raw disk write pattern (dd if=...) detected.',
    severity: 'deny'
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*;\s*\}/,
    reason: 'Fork bomb pattern detected.',
    severity: 'deny'
  },
  {
    pattern: /\bchmod\s+-R\s+777\s+(\/|\.\.|~|\$HOME)\b/i,
    reason: 'Recursive world-writable permission change on sensitive path.',
    severity: 'deny'
  },
  {
    pattern: />\s*\/dev\/(sda|disk\d+)/i,
    reason: 'Direct block device write redirection detected.',
    severity: 'deny'
  },
  {
    pattern: /\b(shutdown|reboot|halt)\b/i,
    reason: 'System power operation detected.',
    severity: 'confirm'
  },
  {
    pattern: /\b(del|erase)\b\s+\/s\s+\/q/i,
    reason: 'Recursive quiet delete command detected on Windows.',
    severity: 'confirm'
  }
];

const DEFAULT_PROTECTED_PATHS = process.platform === 'win32'
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users']
  : ['/etc', '/bin', '/usr', '/boot', '/dev', '/sys', '/proc'];

function normalizeForComparison(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

// .native, because on Windows the JS realpathSync resolves links but keeps an
// 8.3 short name: C:\Users\LONGUS~1\work and C:\Users\longusername\work were
// two spellings of one folder, so isPathWithin refused a file inside a working
// directory that had been canonicalized elsewhere with .native (a delegate
// session's cwd is). A drive the native call cannot resolve (some RAM disks)
// keeps the JS form, as before; a missing path still throws.
function realpathOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

// The real path of `filePath`. A path that does not exist yet is resolved
// through its deepest existing ancestor and the missing segments appended
// again: resolving only the parent let `<wd>/link/new/sub/x.json` keep its
// link spelling, and Write's recursive mkdir then went through the link.
// When not even the root resolves (a drive that is not there), no link can be
// on the way, so the plain resolved spelling is the path.
function resolveRealPath(filePath) {
  const absolute = path.resolve(String(filePath));
  const missing = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathOf(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isPathWithin(basePath, targetPath) {
  const base = normalizeForComparison(resolveRealPath(basePath));
  const target = normalizeForComparison(resolveRealPath(targetPath));
  return target === base || target.startsWith(`${base}/`);
}

// ── The host's own secrets are out of bounds, whatever the workspace says ──
//
// Read, Grep and Glob are `requiresApproval: false`, so nothing ever asks: the
// approval gate — including service mode's `remoteApprovals: 'deny'` — never
// runs for them. That made "show me master.key" a working attack for any remote
// origin (chat message, webhook, gateway client) whenever the agent's working
// directory or allowedDirectories reached the data dir, and WebFetch could then
// carry the key off the box. The service agent now runs in <dataDir>/workspace
// instead (src/service/run.js), but that is a configuration; this is the floor
// underneath it, and it holds for the Electron host's userData dir too.
//
// Names, not a single file list, because the atomic writers leave siblings:
// master.key.dpapi beside master.key, and `<store>.json.<random>.tmp` beside
// each store during a save. Matching is by lowercase prefix, which also
// swallows the Win32 spellings that name the same file — `master.key.`,
// `master.key ` and the NTFS stream `master.key::$DATA` all still start with
// `master.key`.
const SECRET_FILE_PREFIXES = [
  'master.key',      // raw AES-256-GCM key (POSIX) / DPAPI blob (.dpapi) + temps
  'key-check',       // master-key canary
  'gateway-token',   // the gateway bearer token, in plaintext
  '.gateway-token',  // its atomic-write temp
  'chat-data.json',  // the store: provider tokens, gateway.authToken, mesh key
  'config.json',     // the vault: every __vault_ entry
  // Recall spec H1: chat-data.backup-<ts>.json is a full copy of chat-data.json
  // made before the chats move, and the chats themselves now live in
  // history.sqlite (plus its -wal/-shm) or, before H1, chat-history.sqlite.
  'chat-data.backup-',
  'history.sqlite',
  'chat-history.sqlite',
  // The same master key under the name the OS integration uses: systemd's
  // LoadCredential= hands it to the service as $CREDENTIALS_DIRECTORY/kl-master-key,
  // and on macOS (and Linux without systemd) it lives under that name in the
  // admin config dir. Registering those directories without this prefix would
  // leave the raw hex key readable by name.
  'kl-master-key'
];

const SECRET_PATH_DENIAL_MESSAGE =
  "Access denied: that file is one of King Louie's own secret stores "
  + '(master key, key check, gateway token, the encrypted chat/vault store or its backups, or the chat history). '
  + 'It is out of bounds for every tool regardless of the working directory.';

// Data dirs to protect. createCore registers its own paths.dataDir, which
// covers both hosts (Electron's userData and the service's --data-dir). The
// platform default is seeded so a stray agent started anywhere still refuses
// the service's store.
// Keyed by the comparison form (resolved, slash-normalised, lowercased) but
// *valued* by the real spelling. Both are needed and they are not
// interchangeable: the key is what a candidate path's directory is matched
// against, while the value is what readdirSync is actually given — lowercasing
// a path is lossy on every case-sensitive filesystem, so feeding the key back
// to the filesystem silently finds nothing on Linux.
const secretDataDirs = new Map();

function addSecretDataDir(key, realDir) {
  if (!key || secretDataDirs.has(key)) return;
  secretDataDirs.set(key, realDir);
  secretIdentities.snapshot = null;
}

function registerSecretDataDir(dir) {
  if (!dir) return;
  const resolved = resolveRealPath(String(dir));
  addSecretDataDir(normalizeForComparison(resolved), resolved);
  // Register the unresolved spelling too: realpath is only meaningful once the
  // directory exists, and registration can happen before it is created.
  addSecretDataDir(normalizeForComparison(String(dir)), path.resolve(String(dir)));
}

function clearSecretDataDirs() {
  secretDataDirs.clear();
  secretIdentities.snapshot = null;
  seedDefaultSecretDataDirs();
}

function seedDefaultSecretDataDirs() {
  try {
    const dir = defaultServiceDataDir();
    addSecretDataDir(normalizeForComparison(dir), path.resolve(dir));
  } catch {
    // A platform we cannot name a default for is simply not seeded.
  }
}

function listSecretDataDirs() {
  return [...secretDataDirs.values()];
}

// ── Denied directories ──
//
// A personal node's service runs as the owner, so the operating system no
// longer keeps the file tools out of the owner's admin files (the config dir,
// the approvers). A denied directory is refused to every path-gated tool,
// whatever the working directory and allowedDirectories say, and the
// directory itself is denied too: listing it is a read of it. Held in the
// comparison form (resolved, slash-normalised, lowercased), as the secret
// dirs are, and both spellings are kept for a dir that does not exist yet.
// normalizeForComparison lowercases on every platform, not only win32: on a
// case-sensitive filesystem that can deny a sibling spelled with other case,
// which fails closed.
const deniedDirs = new Set();

function registerDeniedDir(dir) {
  if (!dir) return;
  deniedDirs.add(normalizeForComparison(resolveRealPath(String(dir))));
  deniedDirs.add(normalizeForComparison(String(dir)));
}

function clearDeniedDirs() {
  deniedDirs.clear();
}

/**
 * True when `targetPath`, resolved through any link, is a denied directory
 * or is under one. A prefix counts only when it ends at a separator.
 */
function isDeniedPath(targetPath) {
  if (!targetPath || deniedDirs.size === 0) return false;
  const target = normalizeForComparison(resolveRealPath(targetPath));
  for (const dir of deniedDirs) {
    if (target === dir || target.startsWith(dir.endsWith('/') ? dir : `${dir}/`)) {
      return true;
    }
  }
  return false;
}

function deniedPathMessage(targetPath) {
  return `${targetPath} is inside a directory King Louie's tools may not touch on this node`;
}

function isSecretFileName(name) {
  const lower = String(name || '').toLowerCase();
  return SECRET_FILE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// dev+ino identity, as BigInts so a 64-bit NTFS file index survives. This is
// what catches the spellings a string compare cannot: a hard link under an
// innocuous name, an 8.3 short name (MASTER~1.KEY), an NTFS alternate data
// stream, and an extended-length \\?\ path.
function fileIdentity(target) {
  try {
    const st = fs.statSync(target, { bigint: true, throwIfNoEntry: false });
    // ino 0 is what FAT and some network redirectors report; it would collide
    // with every other such file, so it is no identity at all.
    if (!st || !st.isFile() || st.ino === 0n) return null;
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

// Identities of the secret files that exist right now, cached briefly: a Grep
// over a large tree asks once per file, and re-reading every data dir each time
// would dominate the walk. The TTL is short enough that a freshly written
// secret is covered within a second, and the name+directory rule below already
// covers it by name from the moment it is created.
const IDENTITY_TTL_MS = 1000;
function secretIdentities() {
  const key = [...secretDataDirs.keys()].join('|');
  const now = Date.now();
  const cached = secretIdentities.snapshot;
  if (cached && cached.key === key && now - cached.at < IDENTITY_TTL_MS) {
    return cached.ids;
  }
  const ids = new Set();
  for (const dir of secretDataDirs.values()) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // not a directory on this machine
    }
    for (const name of names) {
      if (!isSecretFileName(name)) continue;
      const id = fileIdentity(path.join(dir, name));
      if (id) ids.add(id);
    }
  }
  secretIdentities.snapshot = { key, at: now, ids };
  return ids;
}
secretIdentities.snapshot = null;

/**
 * True when `targetPath` names one of the host's own secret files, by any
 * spelling, or is a denied directory or under one (isDeniedPath). Checked
 * before — and independently of — the working directory and
 * allowedDirectories. Glob and Grep filter the files they walk with this alone.
 */
function isProtectedSecretPath(targetPath) {
  if (!targetPath) return false;
  // Glob and Grep filter the files they walk through this check alone, so a
  // denied directory reached from a root above it is skipped here.
  if (isDeniedPath(targetPath)) return true;
  if (secretDataDirs.size === 0) return false;

  // 1. Name + directory. Works for a file that does not exist yet, so a secret
  //    cannot be pre-planted or clobbered by Write/Edit either.
  const resolved = resolveRealPath(String(targetPath));
  if (isSecretFileName(path.basename(resolved))
      && secretDataDirs.has(normalizeForComparison(path.dirname(resolved)))) {
    return true;
  }

  // 2. File identity, for the spellings that reach the same bytes under a
  //    different name.
  const ids = secretIdentities();
  if (ids.size === 0) return false;
  const id = fileIdentity(targetPath);
  return id !== null && ids.has(id);
}

/**
 * Check if a target path is allowed — either within the working directory
 * or within any of the global allowed directories. The host's own secret
 * files are never allowed.
 */
function isPathAllowed(targetPath, workingDirectory, allowedDirectories = []) {
  if (isDeniedPath(targetPath) || isProtectedSecretPath(targetPath)) {
    return false;
  }
  if (workingDirectory && isPathWithin(workingDirectory, targetPath)) {
    return true;
  }
  for (const dir of allowedDirectories) {
    if (dir && isPathWithin(dir, targetPath)) {
      return true;
    }
  }
  return false;
}

/**
 * The reason `targetPath` may not be touched, or null if it may be. Callers use
 * this instead of isPathAllowed when they surface the refusal to the model, so
 * "this is a secret store" does not read as "you picked the wrong directory"
 * and send it hunting for another way in.
 */
function describePathDenial(targetPath, workingDirectory, allowedDirectories = []) {
  if (isDeniedPath(targetPath)) {
    return deniedPathMessage(targetPath);
  }
  if (isProtectedSecretPath(targetPath)) {
    return SECRET_PATH_DENIAL_MESSAGE;
  }
  if (isPathAllowed(targetPath, workingDirectory, allowedDirectories)) {
    return null;
  }
  return 'Access denied: Path outside working directory and allowed directories';
}

seedDefaultSecretDataDirs();

/**
 * Decrypt an API key a tool holds in settings, failing closed.
 *
 * Both web-search and image-generate used to `catch (e) { return encrypted; }`
 * here, which sent the stored *ciphertext* to Brave, Tavily or Fal as a live
 * credential the moment decryption broke — and the triggers are ordinary, not
 * exotic: a Linux desktop with no Secret Service, a rotated or restored
 * keychain/DPAPI entry, or an AES host reading a value the Electron host wrote
 * now that there are two ciphertext formats. Secret material must never reach
 * an unrelated third party, and a broken at-rest encryption must not present
 * itself as "my search key stopped working".
 *
 * `label` names the key in the error so the user knows which one to re-enter.
 * The ciphertext itself is never put in the message.
 */
function decryptSettingKey(encrypted, context, label = 'API') {
  if (!encrypted) return null;
  if (typeof context?.decryptToken !== 'function') {
    // No host cipher available (tests, or keys stored in plain text).
    return encrypted;
  }
  try {
    return context.decryptToken(encrypted);
  } catch (err) {
    throw new Error(
      `Could not decrypt the stored ${label} key (${err.message}). `
      + 'Re-enter it in Settings > Providers. '
      + 'Refusing to send undecryptable material to the provider.'
    );
  }
}

function evaluateDangerousCommand(command = '', patterns = DEFAULT_DANGEROUS_COMMAND_PATTERNS) {
  const text = String(command || '');
  for (const rule of patterns) {
    if (!rule?.pattern || typeof rule.pattern.test !== 'function') {
      continue;
    }

    if (rule.pattern.test(text)) {
      return {
        matched: true,
        severity: rule.severity || 'deny',
        reason: rule.reason || 'Command matches a restricted pattern.',
        pattern: String(rule.pattern)
      };
    }
  }

  return {
    matched: false
  };
}

// A path a search tool returns, in the form Read resolves back to the same
// file: relative to the working directory (with /) when under it, else
// absolute.
function toolDisplayPath(absPath, workingDirectory) {
  const rel = path.relative(path.resolve(workingDirectory), absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return absPath;
}

module.exports = {
  toolDisplayPath,
  isPathWithin,
  isPathAllowed,
  isProtectedSecretPath,
  describePathDenial,
  registerSecretDataDir,
  clearSecretDataDirs,
  listSecretDataDirs,
  registerDeniedDir,
  clearDeniedDirs,
  isDeniedPath,
  deniedPathMessage,
  SECRET_FILE_PREFIXES,
  SECRET_PATH_DENIAL_MESSAGE,
  decryptSettingKey,
  evaluateDangerousCommand,
  DEFAULT_DANGEROUS_COMMAND_PATTERNS,
  DEFAULT_PROTECTED_PATHS
};
