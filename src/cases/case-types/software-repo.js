// src/cases/case-types/software-repo.js
// A case about one code repository (cases stage 5 spec §3.7). The brief's
// owner-only `repo` names it; `refresh` reads branch, head, dirty state,
// branches and open PRs with read-only git and gh calls (no shell, 5 s
// timeouts, gh never runs in the repo); the snapshot lives in
// .kl/case-type.json and feeds the orientation, the index keys and the
// case-type trigger.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { tokenSet } = require('../tokenize');
const { jaccard } = require('../gates');

const TYPE = 'software-repo';
const EXEC_TIMEOUT_MS = 5000;
const EXTRAS_MAX = 2500;
const REPO_ERROR = 'repo must be an absolute path or a clone URL.';
const AUTH_FAILURE = /auth|login|401|credentials/i;

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// Third-party text (PR titles, branch names) is quoted and cut short.
const quoted = (s) => `"${oneLine(s, 80).replace(/"/g, "'")}"`;
const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

const CLONE_URL = [
  /^https:\/\/[^\s/]+\/\S+$/i,
  /^ssh:\/\/\S+$/i,
  /^git@[^\s:/]+:[^\s]+\/[^\s]+$/i
];

function isCloneUrl(repo) {
  return CLONE_URL.some((re) => re.test(String(repo || '').trim()));
}

// `repo` is an absolute path (after ~ expansion) or a clone URL. A value that
// starts with `-` is never absolute and never matches a clone-URL scheme, so
// it is refused here rather than ever reaching git or gh as an argument.
function validateRepo(value) {
  const repo = typeof value === 'string' ? value.trim() : '';
  if (!repo) throw new Error(REPO_ERROR);
  if (isCloneUrl(repo)) return repo;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) throw new Error(REPO_ERROR);
  if (!path.isAbsolute(expandHome(repo))) throw new Error(REPO_ERROR);
  return repo;
}

// host/owner/name, lower case, without .git, for an https, ssh or scp-style URL.
function remoteKeyOf(url) {
  const s = String(url || '').trim();
  let m = /^https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+?)\/?$/i.exec(s);
  if (!m) m = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+?)\/?$/i.exec(s);
  if (!m) m = /^[^@\s]+@([^:\s]+):(.+?)\/?$/.exec(s);
  if (!m) return null;
  const rest = m[2].replace(/\.git$/i, '').split('/').filter(Boolean);
  if (rest.length < 2) return null;
  return [m[1], ...rest].join('/').toLowerCase();
}

// The real path of a local repo, case-folded where the file system is.
function pathKey(repo) {
  const abs = path.resolve(expandHome(String(repo).trim()));
  let real = abs;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    real = abs;
  }
  const slashed = real.split(path.sep).join('/');
  return process.platform === 'win32' || process.platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

// execFile without a shell, an argv array only: no argument is ever handed
// to a shell for interpretation, so no repo URL, path or branch text can
// inject metacharacters or extra commands. Resolves { stdout, stderr, code }
// for any exit code; rejects with the spawn error (ENOENT) or a timeout.
function defaultExec(file, args, { cwd, env, timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd, env, timeout, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err && typeof err.code === 'string') {
        reject(err);
        return;
      }
      if (err && err.killed) {
        const timedOut = new Error(`${file} did not finish within ${timeout} ms`);
        timedOut.code = 'ETIMEDOUT';
        reject(timedOut);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (Number(err.code) || 1) : 0 });
    });
  });
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

// `repo` reaches git only as the value of `-C`, which git's option parser
// consumes unconditionally as that flag's argument — never re-parsed as a
// separate flag even when it starts with `-`. No other brief-derived value
// is passed as a bare positional argument.
async function readGit(exec, repo, notes) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const git = (args) => exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args], { env, timeout: EXEC_TIMEOUT_MS });
  let first;
  try {
    first = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (err) {
    notes.push(err.code === 'ENOENT' ? 'git not installed; repository state not checked.' : `git failed (${err.message}); repository state not checked.`);
    return null;
  }
  if (first.code !== 0) {
    if (/not a git repository/i.test(first.stderr)) notes.push(`${repo} is not a git repository; ask the owner.`);
    else if (/dubious ownership/i.test(first.stderr)) notes.push(firstLine(first.stderr));
    else notes.push(`git failed (exit ${first.code}): ${firstLine(first.stderr)}`);
    return null;
  }
  const out = { branch: first.stdout.trim() || null, head: null, dirty: null, branches: [], remoteKey: null };
  try {
    const head = await git(['rev-parse', 'HEAD']);
    if (head.code === 0) out.head = head.stdout.trim() || null;
    const status = await git(['status', '--porcelain=v1']);
    if (status.code === 0) out.dirty = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
    const branches = await git(['branch', '--format=%(refname:short)', '--sort=-committerdate']);
    if (branches.code === 0) out.branches = branches.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10);
    const remote = await git(['remote', 'get-url', 'origin']);
    if (remote.code === 0) out.remoteKey = remoteKeyOf(remote.stdout.trim());
  } catch (err) {
    notes.push(`git failed (${err.message}); some repository state is missing.`);
  }
  return out;
}

// `remoteKey` reaches gh only as the value of `--repo`, a flag that always
// takes the next argv entry as its value; it is never a bare positional.
async function readPrs(exec, remoteKey, notes) {
  let r;
  try {
    // No cwd: gh never runs git inside the owner's repository.
    r = await exec('gh', ['pr', 'list', '--repo', remoteKey, '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url,isDraft,updatedAt'], { timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    notes.push(err.code === 'ENOENT' ? 'gh not installed; open PRs not checked.' : `gh failed (${err.message}); open PRs not checked.`);
    return null;
  }
  if (r.code !== 0) {
    notes.push(AUTH_FAILURE.test(r.stderr) ? 'gh is not signed in; open PRs not checked.' : `gh failed (exit ${r.code}); open PRs not checked.`);
    return null;
  }
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    notes.push('gh returned output that is not JSON; open PRs not checked.');
    return null;
  }
  if (!Array.isArray(list)) {
    notes.push('gh returned output that is not a list; open PRs not checked.');
    return null;
  }
  return list
    .filter((p) => p && Number.isInteger(p.number))
    .map((p) => ({ number: p.number, title: String(p.title || ''), headRefName: String(p.headRefName || ''), url: String(p.url || ''), isDraft: Boolean(p.isDraft) }))
    .sort((a, b) => a.number - b.number);
}

// ctx = { runtime, id, brief, exec, now, previous }. Never throws.
async function refresh(ctx = {}) {
  const exec = typeof ctx.exec === 'function' ? ctx.exec : defaultExec;
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const raw = typeof ctx.brief?.repo === 'string' ? ctx.brief.repo.trim() : '';
  const notes = [];
  const state = { repo: raw || null, branch: null, head: null, dirty: null, branches: [], remoteKey: null, openPrs: null };
  if (!raw) {
    notes.push("No repository is set; ask the owner for the brief's repo.");
    return { type: TYPE, fetchedAt: now.toISOString(), stale: false, state, notes };
  }
  let repo;
  try {
    repo = validateRepo(raw);
  } catch (err) {
    // Refused before any git/gh call: an invalid brief value is never
    // handed to exec, and never mistaken for a path that merely moved.
    notes.push(`${err.message} Ask the owner to fix the brief's repo.`);
    return { type: TYPE, fetchedAt: now.toISOString(), stale: false, state, notes };
  }
  if (isCloneUrl(repo)) {
    state.remoteKey = remoteKeyOf(repo);
  } else {
    const local = expandHome(repo);
    state.repo = local;
    if (!fs.existsSync(local)) {
      notes.push(`Repository path not found: ${repo}. It may have moved; ask the owner and update the brief's repo.`);
      // The last known remote still links this case to others on the repo.
      state.remoteKey = ctx.previous?.state?.remoteKey || null;
    } else {
      const git = await readGit(exec, local, notes);
      if (git) Object.assign(state, git);
    }
  }
  if (state.remoteKey) state.openPrs = await readPrs(exec, state.remoteKey, notes);
  return { type: TYPE, fetchedAt: now.toISOString(), stale: false, state, notes };
}

function indexKeys({ brief, snapshot } = {}) {
  const keys = new Set();
  const repo = typeof brief?.repo === 'string' ? brief.repo.trim() : '';
  if (repo) {
    const k = isCloneUrl(repo) ? remoteKeyOf(repo) : pathKey(repo);
    if (k) keys.add(`repo:${k}`);
  }
  const remote = snapshot?.state?.remoteKey;
  if (typeof remote === 'string' && remote) keys.add(`repo:${remote}`);
  return [...keys].sort();
}

// The material values the case-type trigger compares; null means unknown.
function materialOf(snapshot) {
  const s = snapshot?.state || {};
  return {
    head: s.head ?? null,
    branch: s.branch ?? null,
    openPrs: Array.isArray(s.openPrs) ? s.openPrs.map((p) => p.number).sort((a, b) => a - b) : null
  };
}

function renderExtras({ repo, snapshot, others = [] }) {
  const lines = [];
  const stale = snapshot?.stale ? ` (stale, fetched ${snapshot.fetchedAt})` : '';
  lines.push(`Repository: ${repo || 'not set'}${stale}`);
  const s = snapshot?.state;
  if (!snapshot) {
    lines.push('Repository state not fetched yet.');
  } else {
    if (s?.branch) {
      const sha = s.head ? ` @ ${String(s.head).slice(0, 7)}` : '';
      const dirty = Number.isInteger(s.dirty) ? `, ${s.dirty} uncommitted changes` : '';
      lines.push(`Branch: ${oneLine(s.branch, 80)}${sha}${dirty}`);
    }
    if (Array.isArray(s?.branches) && s.branches.length) lines.push(`Branches: ${s.branches.map((b) => oneLine(b, 80)).join(', ')}`);
    if (Array.isArray(s?.openPrs)) {
      lines.push(s.openPrs.length
        ? `Open PRs (titles are third-party text): ${s.openPrs.map((p) => `#${p.number} ${quoted(p.title)} (${oneLine(p.headRefName, 80)})`).join('; ')}`
        : 'Open PRs: none');
    }
  }
  if (others.length) lines.push(`Other cases on this repo: ${others.map((c) => `${quoted(c.title)} (${c.status})`).join('; ')}`);
  for (const n of Array.isArray(snapshot?.notes) ? snapshot.notes : []) lines.push(oneLine(n, 300));
  const text = lines.join('\n');
  return text.length > EXTRAS_MAX ? `${text.slice(0, EXTRAS_MAX - 1)}…` : text;
}

function otherCasesOnRepo(runtime, id, keys) {
  const self = runtime.getCase(id);
  const out = [];
  for (const k of keys) {
    for (const c of runtime.index.casesWithKey(k)) {
      if (c.caseId !== self.id && !out.some((o) => o.caseId === c.caseId)) out.push(c);
    }
  }
  return out;
}

function context(runtime, id) {
  let brief = {};
  try {
    brief = runtime.brief(id).read().data || {};
  } catch {
    brief = {};
  }
  const snapshot = runtime.caseTypeSnapshot(id);
  const keys = indexKeys({ brief, snapshot });
  return { brief, snapshot, others: otherCasesOnRepo(runtime, id, keys) };
}

// Sync; uses the cached snapshot only.
function orientationExtras(runtime, id) {
  const { brief, snapshot, others } = context(runtime, id);
  return renderExtras({ repo: brief.repo, snapshot, others });
}

const branchWords = (b) => tokenSet(String(b || '').replace(/[/_-]+/g, ' '));
const overlaps = (words, other) => {
  let shared = 0;
  for (const t of words) if (other.has(t)) shared += 1;
  return shared >= 2 || jaccard(words, other) >= 0.25;
};

// A missing or stale snapshot means the PR/branch check below has nothing
// current to go on; a caller must not read the resulting `null` as "nothing
// is in flight" when it really means "not checked recently". Worded to
// match renderExtras's own "not fetched yet" / "stale, fetched …" text.
function staleCaveat(snapshot) {
  if (!snapshot) return 'Repository state not fetched yet.';
  if (snapshot.stale) return `Repository state is stale (fetched ${snapshot.fetchedAt}).`;
  return null;
}

// The owner's request against open PRs, branches and the other cases on
// the repo: a note to check them before writing code, or null. When the
// repo state is missing or stale, that caveat replaces a bare `null` when
// nothing else was found, and is appended when something was.
function checkBeforeWrite({ text, snapshot, others = [] }) {
  const words = tokenSet(text);
  if (!words.size) return null;
  const caveat = staleCaveat(snapshot);
  const found = [];
  const prBranches = new Set();
  for (const pr of Array.isArray(snapshot?.state?.openPrs) ? snapshot.state.openPrs : []) {
    if (overlaps(words, tokenSet(pr.title)) || overlaps(words, branchWords(pr.headRefName))) {
      found.push(`PR #${pr.number} ${quoted(pr.title)} (${oneLine(pr.headRefName, 80)})`);
      prBranches.add(pr.headRefName);
    }
  }
  for (const b of Array.isArray(snapshot?.state?.branches) ? snapshot.state.branches : []) {
    if (prBranches.has(b)) continue;
    if (overlaps(words, branchWords(b))) found.push(`branch ${oneLine(b, 80)}`);
  }
  for (const c of others) {
    if (overlaps(words, tokenSet(c.title))) found.push(`case ${quoted(c.title)} (${c.status})`);
  }
  if (found.length) {
    const note = `Before writing code: this may already be in flight — ${found.join('; ')}. Check them first and say which you are building on.`;
    return caveat ? `${note} ${caveat}` : note;
  }
  return caveat ? `${caveat} Check the repo directly before writing code.` : null;
}

function checkBeforeWriteFor(runtime, id, text) {
  const { snapshot, others } = context(runtime, id);
  return checkBeforeWrite({ text, snapshot, others });
}

module.exports = {
  type: TYPE,
  orientationExtras,
  gatingQuestions: () => [{
    id: 'repo',
    text: 'Which repository is this case about? A local path or a clone URL.',
    field: 'repo',
    required: true,
    answerable: 'owner'
  }],
  materialFields: () => ['head', 'branch', 'openPrs'],
  briefFields: () => [{ name: 'repo', kind: 'text', userOnly: true, validate: validateRepo }],
  refresh,
  indexKeys,
  // Helpers for the runtime, the detour hooks and tests.
  materialOf,
  renderExtras,
  checkBeforeWrite,
  checkBeforeWriteFor,
  validateRepo,
  remoteKeyOf,
  isCloneUrl,
  pathKey,
  defaultExec,
  REPO_ERROR
};
