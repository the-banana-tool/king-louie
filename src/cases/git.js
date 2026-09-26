// src/cases/git.js
// Git CLI wrapper for case repositories and playbook fetches (cases stage 6
// spec §3.4). Every call is execFile with an argument array, so titles,
// messages and URLs are never shell-interpreted, and every call carries the
// same hardening flags and environment.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const GITATTRIBUTES_LINE = 'playbooks/** -text';

class GitUnavailableError extends Error {
  constructor() {
    super('git is required for cases but was not found on PATH.');
    this.name = 'GitUnavailableError';
    this.code = 'GIT_UNAVAILABLE';
  }
}

// A case repo never runs the owner's hooks or signs with the owner's key:
// either could block or prompt on every turn. An empty core.hooksPath does
// not disable hooks (git then looks at the filesystem root), so hooks point
// at an empty directory.
//
// That directory lives outside every case (fleet stage 7 Task 8, fix round
// 4). A case directory is content: an import writes into it, and so does the
// model. A hooks directory inside one (the old <case>/.kl/no-hooks) was only
// as safe as every check on every write path into the case, and an NTFS 8.3
// short name for .kl walked an imported pre-commit hook straight past them.
// This one is created empty by this process (mkdtemp, so it's fresh, private
// to the service account and never an existing case directory), is absolute,
// and is checked empty before every git invocation. If it isn't empty, git
// is not run at all.
//
// core.fsmonitor=false and core.hooksPath are passed as -c flags on every
// invocation, never left to whatever is in the repo's own .git/config: an
// imported case (fleet stage 7 §3.8/C1) could otherwise carry a config that
// sets core.fsmonitor (runs an arbitrary program on every `git status`) or
// core.hooksPath (points hooks somewhere the import didn't block) as the
// service account. The importer also never writes .git/config or
// .git/hooks/** for exactly this reason (src/migration/desktop-import.js),
// but this flag is defence in depth: it holds even for a case whose .git
// directory was created some other way.
//
// On a shared POSIX /tmp another user can list the name, wait for a tmp
// cleaner to remove the directory and re-create it as their own (fix round
// 5). So every check also requires, where the platform has uids, that the
// directory is owned by this process's user and not accessible to group or
// others. A directory that vanished or fails any check is abandoned, never
// re-created or reused by name: a fresh mkdtemp replaces it.
let hooksDir = null;
const createdHooksDirs = new Set();
let exitCleanupRegistered = false;

// Why `dir` can't serve as the hooks directory, or null when it can.
function hooksDirProblem(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return 'it is missing'; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'it is not a plain directory';
  if (typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) return 'it is owned by another user';
    if ((st.mode & 0o077) !== 0) return 'other users can access it';
  }
  return null;
}

function freshHooksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-no-hooks-'));
  createdHooksDirs.add(dir);
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once('exit', () => {
      for (const d of createdHooksDirs) {
        // Only a directory that is still ours; rmdir leaves a non-empty one.
        if (hooksDirProblem(d)) continue;
        try { fs.rmdirSync(d); } catch { /* not empty or already gone; leave it */ }
      }
    });
  }
  const problem = hooksDirProblem(dir);
  if (problem) throw new Error(`The case git hooks directory ${dir} can't be used (${problem}), so git was not run.`);
  return dir;
}

function noHooksDir() {
  if (!hooksDir || hooksDirProblem(hooksDir)) hooksDir = freshHooksDir();
  if (fs.readdirSync(hooksDir).length > 0) {
    throw new Error(`The case git hooks directory ${hooksDir} is not empty. Something placed files where only an empty directory belongs, so git was not run. Remove its contents to continue.`);
  }
  return hooksDir;
}

// The checked empty hooks dir for a case repo; refused if it would sit
// inside the case.
function caseHooksDir(cwd) {
  const dir = noHooksDir();
  const rel = path.relative(path.resolve(cwd), dir);
  if (!rel || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..')) {
    throw new Error(`The case git hooks directory ${dir} is inside ${cwd}; git was not run.`);
  }
  return dir;
}

// No commit or tag signing, no hooks, no fsmonitor, no symlinks or line-ending rewrites on
// checkout, Git LFS neutralised, and only the https and ssh transports (file
// only when the caller asks, for a local clone). These -c flags alone do not
// stop `ext::`: a later -c or a config key can turn a transport back on, so
// the transport list is enforced by GIT_ALLOW_PROTOCOL in gitEnv, which
// overrides every protocol.* setting.
function hardenedGitArgs(args, { hooksDir, allowFile = false } = {}) {
  if (!hooksDir) throw new Error('hardenedGitArgs needs a hooksDir.');
  return [
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', `core.hooksPath=${hooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.symlinks=false',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false',
    '-c', 'transfer.fsckObjects=true',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []),
    ...args
  ];
}

// No inherited GIT_* variable reaches git: GIT_DIR/GIT_WORK_TREE would move
// the repository, GIT_CONFIG_COUNT/KEY_n/VALUE_n and GIT_CONFIG_PARAMETERS
// inject config, GIT_ASKPASS/GIT_EDITOR/GIT_SSH run programs. The caller's
// `extra` comes next, and the hardening keys last, so no caller can undo
// them: never prompt, never smudge LFS, never ask ssh for a password, and
// only the allowed transports. `pin` ({ gitDir, workTree }, from
// checkRepoConfig) comes last of all: git then uses exactly the repository
// that was checked and never walks up to an enclosing one.
function gitEnv(extra = {}, { allowFile = false, pin = null } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_ALLOW_PROTOCOL: allowFile ? 'https:ssh:file' : 'https:ssh',
    ...(pin ? { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree } : {})
  };
}

// `scheme://user:secret@host` → `scheme://host`, so a token in a URL never
// reaches an error message.
function stripUserinfo(text) {
  return String(text).replace(/(\/\/)[^/\s@'"]*@/g, '$1');
}

// The first non-empty line git wrote to stderr, credentials removed. Node's
// own "Command failed: git …" message carries the whole argv, so it is never
// used for a process that ran.
function firstStderrLine(err) {
  if (err && typeof err.firstLine === 'string') return err.firstLine;
  let text = '';
  if (err && err.stderr != null) text = String(err.stderr);
  else if (err && !err.cmd) text = String(err.message || '');
  return stripUserinfo(text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');
}

// The git subcommand: the first argument (checkCallerInput refuses a
// leading option).
function subcommandOf(args) {
  return String((args && args[0]) || 'git');
}

function codedError(message, code, props = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, props);
  return err;
}

// A new error carrying only the subcommand, exit code and the first stderr
// line: never the argv, the full stderr or Node's `.cmd`, any of which can
// hold a URL with credentials.
function describeError(err, cwd, args, timeoutMs) {
  // spawn reports a missing cwd as ENOENT too; only a present cwd means git is missing.
  if (err && err.code === 'ENOENT' && fs.existsSync(cwd)) return new GitUnavailableError();
  const sub = subcommandOf(args);
  if (err && timeoutMs && (err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL')) {
    const took = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    const message = `git ${sub} timed out after ${took}`;
    return codedError(message, 'GIT_TIMEOUT', { firstLine: message });
  }
  const firstLine = firstStderrLine(err);
  let exitCode = null;
  if (err && typeof err.code === 'number') exitCode = err.code;
  else if (err && typeof err.status === 'number') exitCode = err.status;
  return codedError(`git ${sub} failed: ${firstLine || (exitCode === null ? 'unknown error' : `exit code ${exitCode}`)}`, 'GIT_FAILED', { exitCode, firstLine });
}

// Repository config that runs a program or redirects traffic when git reads
// it: filter/diff/merge drivers, an external diff, credential helpers, URL
// rewrites, transport switches, remote upload/receive-pack programs, gpg
// programs, the pager/editor/askpass/proxy/ssh/sequence-editor/alternate-refs
// commands, per-command pagers, and submodule update modes (a "!command"
// value runs that command on `git submodule update`; KL never runs one, but
// an owner might in a case repo). A case repo (an imported one included)
// or a fetched package may carry any of these in .git/config, in
// config.worktree when the repo sets extensions.worktreeConfig, or in a
// checked-out submodule's config, so git is not run in such a repo.
const UNSAFE_CONFIG_RE = '^(filter|diff|merge)\\..+\\.(clean|smudge|process|command|textconv|driver)$|^diff\\.external$|^credential\\.|^url\\.|^protocol\\.|^core\\.(pager|editor|askpass|gitproxy|sshcommand)$|^remote\\..+\\.(uploadpack|receivepack)$|^gpg\\.|^sequence\\.editor$|^core\\.alternaterefscommand$|^pager\\.|^submodule\\..+\\.update$';
const unsafeQuery = (scope) => ['config', scope, '--includes', '--name-only', '--get-regexp', UNSAFE_CONFIG_RE];
const WORKTREE_FLAG_QUERY = ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'];
const GIT_DIRS_QUERY = ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'];
const GITLINKS_QUERY = ['ls-files', '--stage', '-z', '--full-name'];
// Checked-out submodules are checked to this depth (the case repo is 0); a
// populated submodule deeper than that is refused rather than left unchecked.
const MAX_SUBMODULE_DEPTH = 3;
// C locale so "not a repository" is recognisable whatever the owner's language.
const QUERY_ENV = { LC_ALL: 'C', LANGUAGE: 'C' };
const NOT_A_REPO_RE = /only be used inside a git repository|not a git repository/i;

// <cwd>/.git → the key last found clean. Only a plain repository whose own
// .git is the one git uses is cached: .git is a real directory with HEAD,
// objects/ and refs/ and no commondir (which would move the config to another
// repository), and on the miss that fills the cache, rev-parse confirms git
// resolves both the git dir and the common dir to it (a decoy .git that git
// does not accept sends git to an enclosing repo). The structure is
// re-checked on every hit.
//
// The key is HEAD and config text, plus, for every checked-out submodule
// (gitlinks read from the index, recursively to MAX_SUBMODULE_DEPTH), its
// path, HEAD and config text: git reads a populated submodule's own config
// (and runs its filters) on status, add and diff in the parent. A new
// checkout, a removed one or an edited submodule config changes the key.
// The cache is filled only when the submodules git reported (ls-files) are
// exactly the ones the key was built from.
//
// Whenever the cwd's own .git is the repository checked (hit or confirmed
// miss), the command runs with GIT_DIR/GIT_WORK_TREE pinned to it, so a .git
// broken after the check makes git fail instead of walking up to a parent.
// A config with an include or worktreeConfig, a split or sparse index, or a
// submodule git dir with a commondir is never cached, but is still pinned
// after its own full check.
//
// A hit is not free: it reads HEAD, config and the index (parsed for
// gitlinks) of the case and of every checked-out submodule, but it spawns no
// git process.
//
// The cache holds at most CLEAN_CONFIGS_LIMIT repositories, the least
// recently confirmed evicted first; forgetConfigs drops the entries under a
// folder (a fetch's temp dir, when it is removed).
const cleanConfigs = new Map();
const CLEAN_CONFIGS_LIMIT = 256;

// map.set that keeps at most `limit` entries: a re-set moves the key to the
// newest end, and the oldest are evicted.
function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

// Drops every cached check for a repository under `dir` (compared as
// resolved paths, case-folded on Windows; no file system access, so it works
// after the folder is gone). Returns how many were dropped.
function forgetConfigs(dir) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const base = fold(path.resolve(dir));
  let dropped = 0;
  for (const gitDir of [...cleanConfigs.keys()]) {
    const rel = path.relative(base, fold(gitDir));
    if (rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel)) {
      cleanConfigs.delete(gitDir);
      dropped += 1;
    }
  }
  return dropped;
}

function isPlainDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The paths of gitlink (mode 160000) entries in a git index file, [] when
// there is no index, or null when the file can't be read with certainty
// (unknown version, split or sparse index, truncated, or any entry that git
// could read differently from this parser).
//
// Names are read the way git reads them (read-cache.c, create_from_disk):
// the length comes from the entry's flags (flags & 0xfff), and only a name of
// 0xfff or more bytes is measured to its NUL. In a v4 index the flags length
// covers the whole name, of which the entry stores only the suffix after the
// prefix it shares with the previous name. The entry size comes from that
// length, never from where a NUL happens to be, so a name must end in a NUL
// exactly where its length says: an index whose padding hides a longer
// "name" (git reads "subz", a NUL search would read "subzzzzzz") is refused.
const INDEX_NAME_MASK = 0xfff;
const INDEX_MAX_NAME_BYTES = 64 * 1024 * 1024;

function indexGitlinks(indexFile, hashLen) {
  let buf;
  try {
    buf = fs.readFileSync(indexFile);
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }
  if (buf.length < 12 + hashLen || buf.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = buf.readUInt32BE(8);
  const entriesEnd = buf.length - hashLen;
  // No entry is shorter than 62 bytes; a count beyond that is not an index.
  if (count > entriesEnd / 62) return null;
  const head = 40 + hashLen + 2;
  const links = new Set();
  let nameBytes = 0;
  let off = 12;
  let prev = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    if (off + head > entriesEnd) return null;
    const mode = buf.readUInt32BE(off + 24);
    const flags = buf.readUInt16BE(off + 40 + hashLen);
    let p = off + head;
    if (flags & 0x4000) {
      if (version < 3) return null;
      p += 2;
    }
    let copyLen = 0;
    if (version === 4) {
      // Prefix strip length: git's offset varint, at most 4 bytes here.
      let used = 0;
      if (p >= entriesEnd) return null;
      let c = buf[p++];
      used++;
      let strip = c & 127;
      while (c & 128) {
        if (p >= entriesEnd || used >= 4) return null;
        strip += 1;
        c = buf[p++];
        used++;
        strip = (strip << 7) + (c & 127);
      }
      if (strip < 0 || strip > prev.length) return null;
      copyLen = prev.length - strip;
    }
    let nameLen = flags & INDEX_NAME_MASK;
    const nul = buf.indexOf(0, p);
    if (nul < 0 || nul >= entriesEnd) return null;
    if (nameLen === INDEX_NAME_MASK) {
      nameLen = (nul - p) + copyLen;
    } else if (nameLen < copyLen || nul !== p + (nameLen - copyLen)) {
      return null;
    }
    const suffixLen = nameLen - copyLen;
    const name = version === 4
      ? Buffer.concat([prev.subarray(0, copyLen), buf.subarray(p, p + suffixLen)])
      : buf.subarray(p, p + suffixLen);
    nameBytes += name.length;
    if (nameBytes > INDEX_MAX_NAME_BYTES) return null;
    off = version === 4
      ? p + suffixLen + 1
      : off + (((p - off) + nameLen + 8) & ~7);
    if (off > entriesEnd) return null;
    prev = name;
    const type = mode & 0o170000;
    if (type === 0o040000) return null; // sparse-index directory entry
    if (type === 0o160000) links.add(name.toString('utf8'));
  }
  // Extensions: a split index keeps entries elsewhere, a sparse index hides them.
  while (off + 8 <= entriesEnd) {
    const sig = buf.toString('latin1', off, off + 4);
    if (sig === 'link' || sig === 'sdir') return null;
    off += 8 + buf.readUInt32BE(off + 4);
  }
  return [...links].sort();
}

// The git dir a submodule's .git leads to: the directory itself, or the
// target of a "gitdir:" file. undefined when there is no .git (not checked
// out), null when there is one this can't resolve.
function dotGitTarget(workTree) {
  const dotGit = path.join(workTree, '.git');
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  try {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    return m ? path.resolve(workTree, m[1]) : null;
  } catch {
    return null;
  }
}

// { key, subs } for a repository's git dir and its checked-out submodules,
// read from disk only, or null when any part can't be keyed with certainty.
// `subs` lists the submodule paths (joined with "/"), depth first.
function treeKey(workTree, gitDir, depth) {
  if (!isPlainDir(gitDir) || !isPlainDir(path.join(gitDir, 'objects')) || !isPlainDir(path.join(gitDir, 'refs'))) return null;
  if (fs.existsSync(path.join(gitDir, 'commondir'))) return null;
  let head;
  let text;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
    text = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  if (/^\s*\[\s*include/im.test(text) || /worktreeconfig/i.test(text)) return null;
  const hashLen = /objectformat\s*=\s*sha256/i.test(text) ? 32 : 20;
  const links = indexGitlinks(path.join(gitDir, 'index'), hashLen);
  if (!links) return null;
  const parts = [head, text];
  const subs = [];
  for (const rel of links) {
    const subTree = path.join(workTree, ...rel.split('/'));
    const subGit = dotGitTarget(subTree);
    if (subGit === undefined) continue;
    if (subGit === null || depth >= MAX_SUBMODULE_DEPTH) return null;
    const sub = treeKey(subTree, subGit, depth + 1);
    if (!sub) return null;
    parts.push(`${rel}\0${sub.key}`);
    subs.push(rel, ...sub.subs.map((s) => `${rel}/${s}`));
  }
  return { key: JSON.stringify(parts), subs };
}

// The cwd's own .git when it looks like a plain repository, or null.
// `key` is null (not cacheable) when treeKey can't key it.
function configCacheEntry(cwd) {
  const workTree = path.resolve(cwd);
  const gitDir = path.join(workTree, '.git');
  if (!isPlainDir(gitDir) || !isPlainDir(path.join(gitDir, 'objects')) || !isPlainDir(path.join(gitDir, 'refs'))) return null;
  if (fs.existsSync(path.join(gitDir, 'commondir'))) return null;
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return null;
  const tree = treeKey(workTree, gitDir, 0);
  return { gitDir, workTree, key: tree ? tree.key : null, subs: tree ? tree.subs : null };
}

function unsafeConfigError(cwd, stdout, submodule) {
  const keys = [...new Set(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  const where = submodule ? `its submodule ${submodule} has a config that sets` : 'its repository config sets';
  const message = `Refusing to run git in ${cwd}: ${where} ${keys.join(', ')}, which can run a program or redirect git. Remove ${keys.length === 1 ? 'that key' : 'those keys'} from ${submodule ? 'that submodule\'s' : 'the repository\'s'} git config to continue.`;
  return codedError(message, 'GIT_UNSAFE_CONFIG', { keys, submodule: submodule || null, firstLine: message });
}

function exitOf(err) {
  return typeof err.code === 'number' ? err.code : err.status;
}

// An unsafe-key query: exit 0 = something matched (refuse), exit 1 = nothing
// matched ('clean'), "not inside a repository" = nothing to check
// ('no-repo': git init, a bare temp dir).
function settleUnsafeQuery(root, { err, stdout }, args, submodule) {
  if (!err) throw unsafeConfigError(root, stdout, submodule);
  if (exitOf(err) === 1) return 'clean';
  if (err.code !== 'ENOENT' && NOT_A_REPO_RE.test(String(err.stderr || ''))) return 'no-repo';
  throw describeError(err, root, args, 0);
}

function settleWorktreeFlag(root, { err, stdout }) {
  if (!err) return String(stdout).trim() === 'true';
  if (exitOf(err) === 1) return false;
  throw describeError(err, root, WORKTREE_FLAG_QUERY, 0);
}

// { gitDir, commonDir, top } from GIT_DIRS_QUERY, or null (a bare repo, or
// anything unexpected).
function parseGitDirs(cwd, { err, stdout }) {
  if (err) return null;
  const [gitDir, common, top] = String(stdout).split(/\r?\n/).map((l) => l.trim());
  if (!gitDir || !common || !top) return null;
  return { gitDir: path.resolve(gitDir), commonDir: path.resolve(cwd, common), top: path.resolve(top) };
}

function parseGitlinks(root, { err, stdout }) {
  if (err) throw describeError(err, root, GITLINKS_QUERY, 0);
  const links = new Set();
  for (const record of String(stdout).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0 && record.slice(0, tab).split(' ')[0] === '160000') links.add(record.slice(tab + 1));
  }
  return [...links].sort();
}

// The config check as a plan of git queries: yields { cwd, args } and gets
// back { err, stdout }, so the async and sync runners share it. Checks the
// repository git finds from `cwd`, then every checked-out submodule in it,
// recursively. Returns { repo, dirs, subs } (subs: the checked submodule
// paths, depth first).
function* repoChecks(root, cwd, depth, label) {
  const local = yield { cwd, args: unsafeQuery('--local') };
  if (settleUnsafeQuery(root, local, unsafeQuery('--local'), label) === 'no-repo') return { repo: false };
  if (settleWorktreeFlag(root, yield { cwd, args: WORKTREE_FLAG_QUERY })) {
    settleUnsafeQuery(root, yield { cwd, args: unsafeQuery('--worktree') }, unsafeQuery('--worktree'), label);
  }
  const dirs = parseGitDirs(cwd, yield { cwd, args: GIT_DIRS_QUERY });
  // A submodule whose .git git does not accept is not checked out as far as
  // git is concerned: git found the enclosing repository, already checked.
  if (depth > 0 && !(dirs && samePath(dirs.top, cwd))) return { repo: false };
  if (!dirs) return { repo: true, dirs: null, subs: [] };
  const subs = [];
  for (const rel of parseGitlinks(root, yield { cwd: dirs.top, args: GITLINKS_QUERY })) {
    const subTree = path.join(dirs.top, ...rel.split('/'));
    if (!fs.existsSync(path.join(subTree, '.git'))) continue;
    const subLabel = label ? `${label}/${rel}` : rel;
    if (depth >= MAX_SUBMODULE_DEPTH) {
      const message = `Refusing to run git in ${root}: submodule ${subLabel} is nested more than ${MAX_SUBMODULE_DEPTH} levels deep, so its config was not checked.`;
      throw codedError(message, 'GIT_UNSAFE_CONFIG', { keys: [], submodule: subLabel, firstLine: message });
    }
    const sub = yield* repoChecks(root, subTree, depth + 1, subLabel);
    if (sub.repo) subs.push(rel, ...sub.subs.map((s) => `${rel}/${s}`));
  }
  return { repo: true, dirs, subs };
}

// The whole check for `cwd`. Returns { gitDir, workTree } to pin git to when
// the cwd's own .git is the repository checked, else null; fills the cache
// when the on-disk key covers exactly the submodules git reported.
function* configCheckPlan(cwd, entry) {
  const result = yield* repoChecks(cwd, cwd, 0, '');
  if (!result.repo || !entry || !result.dirs) return null;
  if (!samePath(result.dirs.gitDir, entry.gitDir) || !samePath(result.dirs.commonDir, entry.gitDir)) return null;
  if (entry.key !== null && JSON.stringify(entry.subs) === JSON.stringify(result.subs)) {
    boundedSet(cleanConfigs, entry.gitDir, entry.key, CLEAN_CONFIGS_LIMIT);
  }
  return entry;
}

function needsConfigCheck(cwd) {
  if (!fs.existsSync(cwd)) return { skip: true, pin: null };
  const entry = configCacheEntry(cwd);
  if (entry && entry.key !== null && cleanConfigs.get(entry.gitDir) === entry.key) return { skip: true, pin: entry };
  return { skip: false, entry };
}

// Refuses a repository whose config (or a checked-out submodule's config)
// runs programs. Returns { gitDir, workTree } when the cwd's own .git is the
// repository checked (git is then pinned to it), or null.
async function checkRepoConfig(cwd, hooksDir) {
  const { skip, entry, pin } = needsConfigCheck(cwd);
  if (skip) return pin;
  const plan = configCheckPlan(cwd, entry);
  let step = plan.next();
  while (!step.done) {
    const { cwd: at, args } = step.value;
    const answer = await run('git', hardenedGitArgs(args, { hooksDir }), {
      cwd: at, env: gitEnv(QUERY_ENV), windowsHide: true, maxBuffer: MAX_BUFFER
    }).then(({ stdout }) => ({ err: null, stdout }), (err) => ({ err, stdout: '' }));
    step = plan.next(answer);
  }
  return step.value;
}

function checkRepoConfigSync(cwd, hooksDir) {
  const { skip, entry, pin } = needsConfigCheck(cwd);
  if (skip) return pin;
  const plan = configCheckPlan(cwd, entry);
  let step = plan.next();
  while (!step.done) {
    const { cwd: at, args } = step.value;
    let answer;
    try {
      answer = {
        err: null,
        stdout: execFileSync('git', hardenedGitArgs(args, { hooksDir }), {
          cwd: at, env: gitEnv(QUERY_ENV), windowsHide: true, maxBuffer: MAX_BUFFER,
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        })
      };
    } catch (err) {
      answer = { err, stdout: '' };
    }
    step = plan.next(answer);
  }
  return step.value;
}

// Caller arguments start with the subcommand. A leading global option (-C,
// -c, --git-dir, --work-tree, --namespace, --config-env, --exec-path, …)
// could point git at another repository, past checkRepoConfig, or override
// the hardening flags. For the same reason caller env may set only the
// commit identity among GIT_* keys (and the hardening keys, which gitEnv
// overwrites): GIT_CONFIG_COUNT/KEY_n/VALUE_n would do what -c does.
const CALLER_GIT_ENV_RE = /^GIT_((AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|TERMINAL_PROMPT|LFS_SKIP_SMUDGE|SSH_COMMAND|ALLOW_PROTOCOL)$/;

function checkCallerInput(args, env = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw codedError('git was called without a subcommand.', 'GIT_BAD_ARGS');
  }
  const first = String(args[0]);
  if (first.startsWith('-')) {
    throw codedError(`git arguments must start with the subcommand, not the global option ${first.split('=')[0]}.`, 'GIT_BAD_ARGS');
  }
  for (const key of Object.keys(env || {})) {
    if (/^GIT_/i.test(key) && !CALLER_GIT_ENV_RE.test(key)) {
      throw codedError(`git env may not set ${key}; only the commit identity (GIT_AUTHOR_*, GIT_COMMITTER_*) is accepted.`, 'GIT_BAD_ARGS');
    }
  }
}

// Subcommands that create a repository (possibly at a path argument) are
// never pinned to the cwd's .git.
const UNPINNED_SUBCOMMANDS = new Set(['init', 'clone']);
const pinFor = (pin, args) => (pin && !UNPINNED_SUBCOMMANDS.has(subcommandOf(args)) ? pin : null);

// A hooks dir the caller passes gets the same checks as noHooksDir(): a
// plain directory, ours and private, and empty.
function checkedHooksDir(dir) {
  if (!dir) return noHooksDir();
  const problem = hooksDirProblem(dir);
  if (problem) throw new Error(`The git hooks directory ${dir} can't be used (${problem}), so git was not run.`);
  if (fs.readdirSync(dir).length > 0) {
    throw new Error(`The git hooks directory ${dir} is not empty, so git was not run.`);
  }
  return dir;
}

// Kills `child` and every process it started. git runs transports and
// helpers (git-remote-https, ssh) as children, and on Windows the git on
// PATH is often a launcher for the real one: killing only the top process
// leaves those running, holding the network connection and the pipes.
function killProcessTree(child) {
  const pid = child.pid;
  // Already exited: its pid may belong to another process by now.
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const killTop = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  if (process.platform === 'win32') {
    const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill';
    // /T walks the tree from the live parent, so the parent is killed by it too.
    execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, killTop);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached)
  } catch {
    killTop();
  }
}

// execFile whose timeout kills the whole process tree (killProcessTree),
// not only git. Resolves { stdout, stderr } like the promisified execFile;
// a timed-out run rejects with `killed: true` (describeError: GIT_TIMEOUT).
function runKillingTree(argv, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;
    const child = execFile('git', argv, { ...options, detached: process.platform !== 'win32' }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (!err) {
        resolve({ stdout, stderr });
        return;
      }
      err.stdout = stdout;
      err.stderr = stderr;
      if (timedOut) err.killed = true;
      reject(err);
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
  });
}

// Without a hooksDir, the checked empty hooks dir outside every case is used,
// so no call ever creates a .kl/ anywhere. Caller input is checked first
// (checkCallerInput), then, in an existing repository, the repo's own config
// (checkRepoConfig). With `killTree`, the timeout kills every process git
// started as well (fetches from remotes; runKillingTree).
async function runGit(cwd, args, { env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, hooksDir = null, allowFile = false, killTree = false } = {}) {
  checkCallerInput(args, env);
  const hooks = checkedHooksDir(hooksDir);
  const pin = pinFor(await checkRepoConfig(cwd, hooks), args);
  const argv = hardenedGitArgs(args, { hooksDir: hooks, allowFile });
  const options = { cwd, env: gitEnv(env, { allowFile, pin }), windowsHide: true, maxBuffer: MAX_BUFFER };
  try {
    const { stdout } = killTree && timeoutMs
      ? await runKillingTree(argv, options, timeoutMs)
      : await run('git', argv, { ...options, timeout: timeoutMs || 0, killSignal: 'SIGKILL' });
    return stdout;
  } catch (err) {
    throw describeError(err, cwd, args, timeoutMs);
  }
}

function runGitSync(cwd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, hooksDir = null, allowFile = false } = {}) {
  checkCallerInput(args);
  const hooks = checkedHooksDir(hooksDir);
  const pin = pinFor(checkRepoConfigSync(cwd, hooks), args);
  const argv = hardenedGitArgs(args, { hooksDir: hooks, allowFile });
  try {
    return execFileSync('git', argv, {
      cwd,
      env: gitEnv({}, { allowFile, pin }),
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs || 0,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    throw describeError(err, cwd, args, timeoutMs);
  }
}

async function git(cwd, args) {
  return runGit(cwd, args, { hooksDir: caseHooksDir(cwd), timeoutMs: 0 });
}

function samePath(a, b) {
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  const x = path.resolve(real(a));
  const y = path.resolve(real(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// A case dir that lost its .git sits inside whatever repo encloses it;
// committing there would sweep the case into someone else's history.
async function requireOwnRepo(dir) {
  let top = '';
  try {
    top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    // A config refusal names the key to remove; do not blur it into "not its own repository".
    if (err instanceof GitUnavailableError || (err && err.code === 'GIT_UNSAFE_CONFIG')) throw err;
  }
  if (!top || !samePath(top, dir)) {
    throw new Error(`Case directory ${dir} is not its own git repository${top ? ` (git resolves it to ${top})` : ''}. Restore its .git folder or run "git init" in it before the next turn.`);
  }
}

async function isGitAvailable() {
  try {
    await run('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Vendored playbooks are hashed byte for byte (R31): git must never rewrite
// their line endings. Returns true when the file was written.
function ensureGitattributes(dir) {
  const file = path.join(dir, '.gitattributes');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === GITATTRIBUTES_LINE)) return false;
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${text}${lead}${GITATTRIBUTES_LINE}\n`);
  return true;
}

async function initRepo(dir) {
  await git(dir, ['init', '-q']);
  // Local identity so commits work on machines with no global git config.
  await git(dir, ['config', 'user.name', 'King Louie']);
  await git(dir, ['config', 'user.email', 'king-louie@localhost']);
  // facts.jsonl must stay byte-identical across platforms.
  await git(dir, ['config', 'core.autocrlf', 'false']);
  ensureGitattributes(dir);
}

async function isDirty(dir) {
  return (await git(dir, ['status', '--porcelain'])).trim().length > 0;
}

async function commitAll(dir, message) {
  await requireOwnRepo(dir);
  if (!(await isDirty(dir))) return null;
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

module.exports = {
  git,
  runGit,
  runGitSync,
  hardenedGitArgs,
  firstStderrLine,
  samePath,
  isGitAvailable,
  initRepo,
  ensureGitattributes,
  GITATTRIBUTES_LINE,
  isDirty,
  commitAll,
  noHooksDir,
  forgetConfigs,
  boundedSet,
  CLEAN_CONFIGS_LIMIT,
  GitUnavailableError
};
