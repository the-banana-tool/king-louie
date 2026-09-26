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

// No signing, no hooks, no fsmonitor, no symlinks or line-ending rewrites on
// checkout, Git LFS neutralised, and only the https and ssh transports (file
// only when the caller asks, for a local clone). These -c flags alone do not
// stop `ext::`: a later -c or a config key can turn a transport back on, so
// the transport list is enforced by GIT_ALLOW_PROTOCOL in gitEnv, which
// overrides every protocol.* setting.
function hardenedGitArgs(args, { hooksDir, allowFile = false } = {}) {
  if (!hooksDir) throw new Error('hardenedGitArgs needs a hooksDir.');
  return [
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${hooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.symlinks=false',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false',
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
// only the allowed transports.
function gitEnv(extra = {}, { allowFile = false } = {}) {
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
    GIT_ALLOW_PROTOCOL: allowFile ? 'https:ssh:file' : 'https:ssh'
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

// The git subcommand in `args`, skipping global options (`-c k=v`, `-C dir`).
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '-c' || a === '-C') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return 'git';
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
// rewrites, transport switches, and the pager/editor/askpass/proxy/ssh
// commands. A case repo (an imported one included) or a fetched package may
// carry any of these in .git/config, so git is not run in such a repo.
const UNSAFE_CONFIG_RE = '^(filter|diff|merge)\\..+\\.(clean|smudge|process|command|textconv|driver)$|^diff\\.external$|^credential\\.|^url\\.|^protocol\\.|^core\\.(pager|editor|askpass|gitproxy|sshcommand)$';
const CONFIG_QUERY = ['config', '--local', '--includes', '--name-only', '--get-regexp', UNSAFE_CONFIG_RE];
// C locale so "not a repository" is recognisable whatever the owner's language.
const QUERY_ENV = { LC_ALL: 'C', LANGUAGE: 'C' };
const NOT_A_REPO_RE = /only be used inside a git repository|not a git repository/i;

// .git/config path → the exact text last found clean. A repo whose config
// has an include is checked every time (an included file can change
// without this one changing).
const cleanConfigs = new Map();

function configCacheEntry(cwd) {
  const file = path.join(path.resolve(cwd), '.git', 'config');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (/^\s*\[\s*include/im.test(text)) return null;
  return { file, text };
}

function unsafeConfigError(cwd, stdout) {
  const keys = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const list = [...new Set(keys)].join(', ');
  const message = `Refusing to run git in ${cwd}: its repository config sets ${list}, which can run a program or redirect git. Remove ${keys.length === 1 ? 'that key' : 'those keys'} from the repository's .git/config to continue.`;
  return codedError(message, 'GIT_UNSAFE_CONFIG', { keys, firstLine: message });
}

// Exit 0 = something matched (refuse), exit 1 = nothing matched (clean),
// "not inside a repository" = nothing to check (git init, a bare temp dir).
function settleConfigQuery(cwd, entry, err, stdout) {
  if (!err) throw unsafeConfigError(cwd, stdout);
  const exit = typeof err.code === 'number' ? err.code : err.status;
  if (exit === 1) {
    if (entry) cleanConfigs.set(entry.file, entry.text);
    return;
  }
  if (err.code !== 'ENOENT' && NOT_A_REPO_RE.test(String(err.stderr || ''))) return;
  throw describeError(err, cwd, CONFIG_QUERY, 0);
}

function needsConfigCheck(cwd) {
  if (!fs.existsSync(cwd)) return { skip: true };
  const entry = configCacheEntry(cwd);
  if (entry && cleanConfigs.get(entry.file) === entry.text) return { skip: true };
  return { skip: false, entry };
}

async function checkRepoConfig(cwd, hooksDir) {
  const { skip, entry } = needsConfigCheck(cwd);
  if (skip) return;
  let stdout = '';
  let failure = null;
  try {
    ({ stdout } = await run('git', hardenedGitArgs(CONFIG_QUERY, { hooksDir }), {
      cwd, env: gitEnv(QUERY_ENV), windowsHide: true, maxBuffer: MAX_BUFFER
    }));
  } catch (err) {
    failure = err;
  }
  settleConfigQuery(cwd, entry, failure, stdout);
}

function checkRepoConfigSync(cwd, hooksDir) {
  const { skip, entry } = needsConfigCheck(cwd);
  if (skip) return;
  let stdout = '';
  let failure = null;
  try {
    stdout = execFileSync('git', hardenedGitArgs(CONFIG_QUERY, { hooksDir }), {
      cwd, env: gitEnv(QUERY_ENV), windowsHide: true, maxBuffer: MAX_BUFFER,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    failure = err;
  }
  settleConfigQuery(cwd, entry, failure, stdout);
}

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

// Without a hooksDir, the checked empty hooks dir outside every case is used,
// so no call ever creates a .kl/ anywhere. In an existing repository the
// repo's own config is checked first (checkRepoConfig).
async function runGit(cwd, args, { env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, hooksDir = null, allowFile = false } = {}) {
  const hooks = checkedHooksDir(hooksDir);
  await checkRepoConfig(cwd, hooks);
  const argv = hardenedGitArgs(args, { hooksDir: hooks, allowFile });
  try {
    const { stdout } = await run('git', argv, {
      cwd,
      env: gitEnv(env, { allowFile }),
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs || 0,
      killSignal: 'SIGKILL'
    });
    return stdout;
  } catch (err) {
    throw describeError(err, cwd, args, timeoutMs);
  }
}

function runGitSync(cwd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, hooksDir = null, allowFile = false } = {}) {
  const hooks = checkedHooksDir(hooksDir);
  checkRepoConfigSync(cwd, hooks);
  const argv = hardenedGitArgs(args, { hooksDir: hooks, allowFile });
  try {
    return execFileSync('git', argv, {
      cwd,
      env: gitEnv({}, { allowFile }),
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
    if (err instanceof GitUnavailableError) throw err;
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
  GitUnavailableError
};
