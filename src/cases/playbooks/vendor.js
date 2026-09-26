// src/cases/playbooks/vendor.js
// Vendoring (cases stage 6 spec §3.4, §6): resolve a source against the
// allowlist, fetch it into a fresh temp dir with hardened git, validate it,
// read it into memory, and copy it into playbooks/<name>/ by rename. KL
// never creates or updates submodules; it only reads hand-made ones.
//
// Every git call goes through runGit (src/cases/git.js), so the leading-
// option ban, the repository config and submodule check, the GIT_DIR pin,
// the protocol allowlist (file only for local path: clones) and the hooks,
// LFS and prompt hardening all apply. Fetches from a remote kill the whole
// process tree on timeout (killTree).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, samePath, forgetConfigs } = require('../git');
const { NAME_RE, LIMITS, segmentProblem, reservedNameProblem, walkPackage, hashEntries, validatePackage, formatErrors } = require('./format');
const { createLogger } = require('../../logging');

const log = createLogger('playbook-vendor');

const REF_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;
// scp-like ssh: user@host:path. Neither user, host nor path may start with
// "-" (ssh would read it as an option), and the path is not "//…" (that is
// a scheme URL's authority).
const SCP_RE = /^((?!-)[A-Za-z0-9._-]+)@((?!-)[A-Za-z0-9.-]+):(?![-/])(.+)$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// The characters a git URL may carry. A URL parser drops tabs and newlines,
// folds "\" into "/", decodes "%2e" and resolves "." and ".." segments, while
// git is handed the raw text; with this set (and no dot segments) the text
// the allowlist checks and the text git fetches name the same thing.
const URL_CHARS_RE = /^[A-Za-z0-9._~:/@+-]+$/;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const TEMP_LEFTOVER_RE = /^\.[a-z0-9][a-z0-9-]*\.tmp-[0-9a-f]+$/;

class PlaybookSourceError extends Error {
  constructor(message, code = 'PLAYBOOK_SOURCE', errors = null) {
    super(message);
    this.name = 'PlaybookSourceError';
    this.code = code;
    if (errors) this.errors = errors;
  }
}

const unsupported = (input) => new PlaybookSourceError(
  `Unsupported playbook source "${input}". Use example:<name>, an absolute folder path, or an https/ssh git URL.`,
  'UNSUPPORTED_SOURCE'
);

const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// A UNC or device path (\\host\share, //host/share, \\?\…, \\.\…). On
// Windows any file system call on one can open an SMB connection and send
// the service account's NTLM credentials to that host, so such a path is
// refused on its text alone, before anything touches it (and on every
// platform, for one rule).
const isUncLike = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p);

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// The real path of `p`; for a path that does not exist yet, the real path of
// its nearest existing ancestor with the rest appended.
function realpathDeep(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Realpath containment, case-folded where the file system usually is
// (Windows and macOS).
function isInside(child, parent) {
  if (isUncLike(child) || isUncLike(parent)) return false;
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const c = fold ? realpathDeep(child).toLowerCase() : realpathDeep(child);
  const p = fold ? realpathDeep(parent).toLowerCase() : realpathDeep(parent);
  const rel = path.relative(p, c);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

const hasDotSegment = (p) => p.split('/').some((seg) => seg === '.' || seg === '..');

// https and ssh URLs (scp-like user@host:path becomes ssh://user@host/path),
// host lower-cased, trailing slashes and .git dropped. null when not one, or
// when the text holds anything a URL parser would rewrite (URL_CHARS_RE, dot
// segments, a query or fragment).
function normalizeUrl(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (s.startsWith('git+')) s = s.slice(4);
  if (!s || !URL_CHARS_RE.test(s)) return null;
  if (!HAS_SCHEME.test(s)) {
    const scp = SCP_RE.exec(s);
    if (!scp || hasDotSegment(scp[3])) return null;
    s = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  }
  const scheme = /^([a-z]+):\/\/([^/]*)(\/.*)?$/i.exec(s);
  if (!scheme || hasDotSegment(scheme[3] || '')) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return null;
  if (!u.hostname || u.hostname.startsWith('-') || u.username.startsWith('-')) return null;
  const auth = u.username ? `${u.username}@` : '';
  const port = u.port ? `:${u.port}` : '';
  const p = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${auth}${u.hostname.toLowerCase()}${port}${p}`;
}

function sourceEntries(settings) {
  const list = settings && Array.isArray(settings.sources) ? settings.sources : [];
  return list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
}

// A URL is allowed when its normalized form equals, or sits under, a
// normalized URL entry. An entry is a prefix at a path boundary, except one
// whose text ends in .git: that names one repository and matches only it.
function isUrlAllowed(url, settings) {
  const target = normalizeUrl(url);
  if (!target) return false;
  return sourceEntries(settings)
    .filter((e) => !e.startsWith('path:'))
    .map((e) => ({ norm: normalizeUrl(e), exact: /\.git\/*$/i.test(e) }))
    .filter((e) => e.norm)
    .some(({ norm, exact }) => target === norm || (!exact && target.startsWith(`${norm}/`)));
}

function assertUrlAllowed(url, settings) {
  if (!isUrlAllowed(url, settings)) {
    throw new PlaybookSourceError(`Playbook source ${url} is not allowed. Add its host to Settings → Playbooks → Allowed sources.`, 'SOURCE_NOT_ALLOWED');
  }
}

// A local folder is allowed when there is no path: entry, or it is under one
// (spec §6). Both sides are compared by real path, so a link inside a root
// that leads out of it is outside.
// A UNC entry counts as an entry but matches nothing, and is never resolved.
function assertPathAllowed(abs, settings) {
  const roots = sourceEntries(settings).filter((e) => e.startsWith('path:')).map((e) => expandHome(e.slice(5).trim()));
  if (!roots.length) return;
  const inside = (root) => !isUncLike(root) && !isUncLike(abs) && isInside(abs, path.resolve(root));
  if (!roots.some(inside)) {
    throw new PlaybookSourceError(`Playbook source ${abs} is outside the allowed folders.`, 'SOURCE_NOT_ALLOWED');
  }
}

// A git URL as recorded and fetched (git+ stripped), or null when `s` is not
// an https, ssh or scp-like ssh URL.
function gitUrlOf(raw) {
  const s = raw.startsWith('git+') ? raw.slice(4) : raw;
  const isGitUrl = /^https:\/\//i.test(s) || /^ssh:\/\//i.test(s) || (!HAS_SCHEME.test(s) && SCP_RE.test(s));
  return isGitUrl ? s : null;
}

// A URL that may be recorded and fetched: supported, no password (it would
// be written to case.yaml), allowed.
function checkGitUrl(raw, settings) {
  const s = gitUrlOf(raw);
  if (!s || !normalizeUrl(s)) throw unsupported(raw);
  if (HAS_SCHEME.test(s) && new URL(s).password) {
    throw new PlaybookSourceError('Playbook source URLs cannot carry a password.', 'UNSUPPORTED_SOURCE');
  }
  assertUrlAllowed(s, settings);
  return s;
}

// settings: the `playbooks` settings namespace ({ sources, autoUpdate }).
function resolveSource(input, { examplesDir = null, settings = {} } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new PlaybookSourceError('A playbook source is required.', 'UNSUPPORTED_SOURCE');
  const raw = input.trim();
  if (raw.startsWith('-')) throw unsupported(raw);
  if (raw.startsWith('example:')) {
    const name = raw.slice('example:'.length);
    if (!examplesDir || !fs.existsSync(examplesDir)) {
      throw new PlaybookSourceError('Example playbooks are not available in this build.', 'NO_EXAMPLES');
    }
    const dir = path.join(examplesDir, name);
    if (!NAME_RE.test(name) || !fs.existsSync(path.join(dir, 'playbook.yaml'))) {
      throw new PlaybookSourceError(`Unknown example playbook "${name}".`, 'UNKNOWN_EXAMPLE');
    }
    return { kind: 'example', source: `example:${name}`, fetchSpec: { path: dir } };
  }
  const local = expandHome(raw.startsWith('path:') ? raw.slice('path:'.length) : raw);
  if (isUncLike(local)) throw unsupported(raw);
  if (!HAS_SCHEME.test(local) && !SCP_RE.test(local) && path.isAbsolute(local)) {
    const abs = path.resolve(local);
    if (isUncLike(abs)) throw unsupported(raw);
    // The allowlist first: a path outside it is never touched.
    assertPathAllowed(abs, settings);
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st || !st.isDirectory()) throw new PlaybookSourceError(`Playbook folder ${abs} does not exist.`, 'NO_FOLDER');
    return { kind: 'path', source: `path:${abs}`, fetchSpec: { path: abs } };
  }
  const url = checkGitUrl(raw, settings);
  return { kind: 'git', source: url, fetchSpec: { url } };
}

function checkRef(ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    const shown = typeof ref === 'string' ? ref : typeof ref;
    throw new PlaybookSourceError(`Invalid ref "${shown}". A ref is 1 to 100 letters, digits, ".", "_", "/" or "-", not starting with "-".`, 'INVALID_REF');
  }
  return ref;
}

// The clone command for a git source; `--` always precedes the URL or path.
// No submodules and no tags are fetched (a tag named as the ref still is).
function cloneArgs(resolved, { ref = null, dest }) {
  const checked = checkRef(ref);
  const branch = checked ? ['--branch', checked] : [];
  if (resolved.kind === 'path') {
    // --depth is ignored for local paths; --no-hardlinks keeps the copy independent.
    return ['clone', '--no-hardlinks', '--no-recurse-submodules', '--no-tags', ...branch, '--', resolved.fetchSpec.path, dest];
  }
  return ['clone', '--depth', '1', '--no-recurse-submodules', '--no-tags', ...branch, '--', resolved.fetchSpec.url, dest];
}

// A local folder is cloned only when it has its own .git and git agrees it
// is the top level. A folder without one is copied without running git. A
// repository whose config runs programs, or a git that hangs, refuses the
// source rather than falling back to a plain copy.
async function isGitTopLevel(dir, gitOpts) {
  if (!lstatOrNull(path.join(dir, '.git'))) return false;
  try {
    const top = (await runGit(dir, ['rev-parse', '--show-toplevel'], gitOpts)).trim();
    return Boolean(top) && samePath(top, dir);
  } catch (err) {
    if (err && (err.code === 'GIT_UNSAFE_CONFIG' || err.code === 'GIT_TIMEOUT')) throw err;
    return false;
  }
}

const invalid = (source, errors) => new PlaybookSourceError(
  `The playbook at ${source} is invalid:\n${formatErrors(errors)}`, 'INVALID_PACKAGE', errors
);

// Reads a walked file through one descriptor: it must still be a regular
// file within the size limit and the same file the walk saw, so a file
// swapped for a link after the walk is refused rather than followed.
function readWalkedFile(f) {
  const before = fs.lstatSync(f.abs);
  const fd = fs.openSync(f.abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    const same = before.isFile() && st.isFile() && st.dev === before.dev && st.ino === before.ino;
    if (!same || st.size > LIMITS.fileBytes) throw new Error(`${f.rel} changed while it was being copied`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Copies the regular files of a package (dot entries excluded). A symlink,
// a device or a size limit anywhere refuses the whole copy.
function copyPackage(resolved, dest) {
  const { files, errors } = walkPackage(resolved.fetchSpec.path);
  if (errors.length) throw invalid(resolved.source, errors);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const target = path.join(dest, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readWalkedFile(f), { flag: 'wx' });
  }
}

// core.symlinks=false checks a committed symlink out as a small text file,
// which the walk cannot tell from a real one; the tree can.
async function refuseCommittedLinks(resolved, pkgDir, gitOpts) {
  const out = await runGit(pkgDir, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], gitOpts);
  const errors = [];
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(0, tab).split(' ')[0] !== '120000') continue;
    const rel = record.slice(tab + 1);
    // Dot-prefixed entries are never copied, hashed or validated.
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    errors.push({ file: null, message: `${rel}: symbolic links are not allowed` });
  }
  if (errors.length) throw invalid(resolved.source, errors);
}

// → { tmpDir, pkgDir, commit, cleanup }. The package is validated before it
// is returned; on any failure the temp dir is removed and a
// PlaybookSourceError thrown. `timeoutMs` bounds the whole fetch.
async function fetchPackage(resolved, { ref = null, timeoutMs = DEFAULT_TIMEOUT_MS, tmpRoot = os.tmpdir() } = {}) {
  const checkedRef = checkRef(ref);
  if (!resolved || !['example', 'path', 'git'].includes(resolved.kind) || !resolved.fetchSpec) {
    throw new PlaybookSourceError('fetchPackage needs a source from resolveSource.', 'UNSUPPORTED_SOURCE');
  }
  if (isUncLike(resolved.fetchSpec.path)) throw unsupported(resolved.fetchSpec.path);
  let tmpDir = null;
  const cleanup = () => {
    if (!tmpDir) return;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    forgetConfigs(tmpDir);
  };
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  try {
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'kl-playbook-'));
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir, { mode: 0o700 });
    const pkgDir = path.join(tmpDir, 'src');
    const gitOpts = () => ({ hooksDir, killTree: true, timeoutMs: deadline ? Math.max(1, deadline - Date.now()) : 0 });
    let commit = null;
    const useGit = resolved.kind === 'git'
      || (resolved.kind === 'path' && await isGitTopLevel(resolved.fetchSpec.path, gitOpts()));
    if (!useGit) {
      if (checkedRef) throw new PlaybookSourceError('A ref applies only to git sources.', 'INVALID_REF');
      copyPackage(resolved, pkgDir);
    } else {
      await runGit(tmpDir, cloneArgs(resolved, { ref: checkedRef, dest: pkgDir }), { ...gitOpts(), allowFile: resolved.kind === 'path' });
      commit = (await runGit(pkgDir, ['rev-parse', 'HEAD'], gitOpts())).trim();
      await refuseCommittedLinks(resolved, pkgDir, gitOpts());
    }
    const validation = validatePackage(pkgDir, { dirName: null });
    if (!validation.ok) throw invalid(resolved.source, validation.errors);
    return { tmpDir, pkgDir, commit, cleanup };
  } catch (err) {
    cleanup();
    if (err instanceof PlaybookSourceError) throw err;
    throw new PlaybookSourceError(`Could not fetch ${resolved.source}: ${err.firstLine || err.message}`, 'FETCH_FAILED');
  }
}

// The package in memory: [{ rel, data: Buffer }], sorted as walkPackage sorts.
function readSnapshot(pkgDir) {
  const { files, errors } = walkPackage(pkgDir);
  if (errors.length) throw new PlaybookSourceError(`Invalid playbook package:\n${formatErrors(errors)}`, 'INVALID_PACKAGE', errors);
  return { files: files.map((f) => ({ rel: f.rel, data: readWalkedFile(f) })) };
}

function snapshotHash(snapshot) {
  return hashEntries(snapshot.files.map((f) => ({ rel: f.rel, text: f.data.toString('utf8') })));
}

// A snapshot's files, each a relative path of plain segments that stays
// inside the package, within the package limits. Anything else is refused
// before a byte is written.
function checkSnapshot(snapshot) {
  const files = snapshot && Array.isArray(snapshot.files) ? snapshot.files : null;
  if (!files) throw new PlaybookSourceError('A playbook snapshot must list its files.', 'INVALID_PACKAGE');
  if (files.length > LIMITS.files) throw new PlaybookSourceError(`A playbook package holds at most ${LIMITS.files} files.`, 'INVALID_PACKAGE');
  let total = 0;
  for (const f of files) {
    const rel = f && typeof f.rel === 'string' ? f.rel : '';
    const segments = rel.split('/');
    // format's own name rules: plain ASCII segments (no "~", spaces, dot
    // prefixes, "." or ".."), no trailing ".", no Windows device names.
    const bad = !rel || /[\\:\0]/.test(rel) || segments.some((seg) => !seg || segmentProblem(seg) || reservedNameProblem(seg));
    if (bad) throw new PlaybookSourceError(`"${rel}" is not a valid package path.`, 'INVALID_PACKAGE');
    if (!Buffer.isBuffer(f.data) || f.data.length > LIMITS.fileBytes) {
      throw new PlaybookSourceError(`${rel} is not a file within the 256 KiB limit.`, 'INVALID_PACKAGE');
    }
    total += f.data.length;
  }
  if (total > LIMITS.totalBytes) throw new PlaybookSourceError('A playbook package holds at most 1 MiB.', 'INVALID_PACKAGE');
  return files;
}

// A directory KL writes into must be a real directory, not a link (a
// symlink or, on Windows, a junction) that would carry the write elsewhere.
function assertRealDir(dir, label) {
  const st = lstatOrNull(dir);
  if (!st) return false;
  if (st.isSymbolicLink()) throw new PlaybookSourceError(`${label} is a link; playbooks are written only into a real folder in the case.`, 'UNSAFE_TARGET');
  if (!st.isDirectory()) throw new PlaybookSourceError(`${label} is not a folder.`, 'UNSAFE_TARGET');
  return true;
}

// Writes a snapshot to playbooks/.<name>.tmp-<rand>, validates it there
// (name included), then renames it into place, so a crash leaves at most a
// temp dir (removeTempLeftovers) and never a half-written package. Refuses
// when playbooks/<name> exists in any form, and when the case dir or
// playbooks/ is a link.
function vendorInto(caseDir, snapshot, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new PlaybookSourceError(`"${name}" is not a valid playbook name.`, 'INVALID_NAME');
  const files = checkSnapshot(snapshot);
  if (!assertRealDir(caseDir, 'The case folder')) throw new PlaybookSourceError(`Case folder ${caseDir} does not exist.`, 'UNSAFE_TARGET');
  const pbDir = path.join(caseDir, 'playbooks');
  if (!assertRealDir(pbDir, 'playbooks')) fs.mkdirSync(pbDir);
  assertRealDir(pbDir, 'playbooks');
  if (!isInside(pbDir, caseDir)) throw new PlaybookSourceError('playbooks resolves outside the case.', 'UNSAFE_TARGET');
  const target = path.join(pbDir, name);
  const exists = () => {
    if (lstatOrNull(target)) throw new PlaybookSourceError(`playbooks/${name} already exists in this case.`, 'EXISTS');
  };
  exists();
  const tmp = path.join(pbDir, `.${name}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp);
  try {
    for (const f of files) {
      const file = path.join(tmp, ...f.rel.split('/'));
      if (!isInside(file, tmp)) throw new PlaybookSourceError(`"${f.rel}" is not a valid package path.`, 'INVALID_PACKAGE');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.data, { flag: 'wx' });
    }
    const validation = validatePackage(tmp, { dirName: name });
    if (!validation.ok) throw invalid(`playbooks/${name}`, validation.errors);
    exists();
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return target;
}

// Crash leftovers: playbooks/.<name>.tmp-<hex>. A leftover that is a link is
// unlinked, never followed; a playbooks/ that is itself a link is left alone.
function removeTempLeftovers(caseDir) {
  const pbDir = path.join(caseDir, 'playbooks');
  const st = lstatOrNull(pbDir);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) {
    log.warn('playbooks is not a real folder; temp leftovers were not removed', { caseDir });
    return [];
  }
  const removed = [];
  for (const n of fs.readdirSync(pbDir).filter((x) => TEMP_LEFTOVER_RE.test(x))) {
    const p = path.join(pbDir, n);
    const entry = lstatOrNull(p);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      // A junction or directory symlink is removed with rmdir on Windows.
      try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
    } else {
      fs.rmSync(p, { recursive: true, force: true });
    }
    removed.push(n);
  }
  return removed;
}

// A remote's playbook.yaml at its default branch, fetched into a fresh temp
// repository that is removed afterwards. Nothing runs in, or is written to,
// the case. `allowFile` is for tests (a local path as the remote); callers
// pass URLs that already passed the allowlist.
async function readRemoteManifest(url, { timeoutMs = DEFAULT_TIMEOUT_MS, tmpRoot = os.tmpdir(), allowFile = false } = {}) {
  let tmpDir = null;
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  try {
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'kl-playbook-'));
    const hooksDir = path.join(tmpDir, 'hooks');
    fs.mkdirSync(hooksDir, { mode: 0o700 });
    const repo = path.join(tmpDir, 'manifest');
    const gitOpts = () => ({ hooksDir, killTree: true, allowFile, timeoutMs: deadline ? Math.max(1, deadline - Date.now()) : 0 });
    await runGit(tmpDir, ['init', '-q', '--', repo], gitOpts());
    await runGit(repo, ['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', url], gitOpts());
    const size = Number((await runGit(repo, ['cat-file', '-s', 'FETCH_HEAD:playbook.yaml'], gitOpts())).trim());
    if (!(size <= LIMITS.fileBytes)) {
      throw new PlaybookSourceError(`Could not read ${url}: playbook.yaml is larger than 256 KiB.`, 'INVALID_PACKAGE');
    }
    return await runGit(repo, ['cat-file', 'blob', 'FETCH_HEAD:playbook.yaml'], gitOpts());
  } catch (err) {
    if (err instanceof PlaybookSourceError) throw err;
    throw new PlaybookSourceError(`Could not fetch ${url}: ${err.firstLine || err.message}`, 'FETCH_FAILED');
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      forgetConfigs(tmpDir);
    }
  }
}

// A hand-made submodule's upstream playbook.yaml, read with a hardened fetch
// of its .gitmodules URL, which must pass the allowlist first. The fetch runs
// in a fresh temp repository, not in `subDir`: the submodule's own git dir
// and config are case content, and a fetch there would also write objects
// into the case.
async function fetchSubmoduleManifest(subDir, url, { settings = {}, timeoutMs = DEFAULT_TIMEOUT_MS, tmpRoot = os.tmpdir() } = {}) {
  if (!url || typeof url !== 'string') throw new PlaybookSourceError('The submodule has no url in .gitmodules.', 'SOURCE_NOT_ALLOWED');
  const raw = url.trim();
  if (raw.startsWith('-')) throw unsupported(raw);
  const checked = checkGitUrl(raw, settings);
  return readRemoteManifest(checked, { timeoutMs, tmpRoot });
}

module.exports = {
  PlaybookSourceError,
  isInside,
  normalizeUrl,
  isUrlAllowed,
  assertUrlAllowed,
  assertPathAllowed,
  resolveSource,
  checkRef,
  cloneArgs,
  fetchPackage,
  readSnapshot,
  snapshotHash,
  vendorInto,
  removeTempLeftovers,
  readRemoteManifest,
  fetchSubmoduleManifest,
  REF_RE
};
