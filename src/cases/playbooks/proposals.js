// src/cases/playbooks/proposals.js
// Proposals back to playbook repositories (cases stage 6 spec §3.10, §4.7).
// The model supplies whole files; code builds the patch in a temp repo,
// stores it with its hash, and applies it only into a repository outside
// every case, leaving the changes uncommitted.
//
// The patch file and .kl/playbook-proposals.jsonl live in the case, so the
// model (through Bash) or an imported case can shape both. Neither is
// trusted: records are validated field by field when they are read, a
// record's patch path must name a file directly in PATCH_DIR, the patch
// bytes must match the stored hash, and the patch itself must pass
// checkPatch (every path a bare playbook file name, mode 100644 only, no
// renames, copies, deletes, binaries, or text outside counted hunks) both
// when it is stored and again, on the verified bytes, before it is applied.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGit, forgetConfigs } = require('../git');
const { appendJsonl, readJsonl } = require('../jsonl');
const { parsePlaybookYaml, validatePackage, formatErrors, segmentProblem, reservedNameProblem, NAME_RE, VERSION_RE, LIMITS } = require('./format');
const { isInside } = require('./vendor');
const { createLogger } = require('../../logging');

const log = createLogger('playbook-proposals');

const PROPOSALS_FILE = path.join('.kl', 'playbook-proposals.jsonl');
const PATCH_DIR = 'artifacts/playbook-proposals';
const FILE_RE = /^[A-Za-z0-9._-]+\.(md|yaml|txt)$/;
const MAX_FILES = 8;
const NEW_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 60 * 1000;
// Eight files of at most 256 KiB, each at worst fully removed and re-added.
const MAX_PATCH_BYTES = 2 * MAX_FILES * LIMITS.fileBytes + 64 * 1024;
const MAX_PROPOSALS_BYTES = 4 * 1024 * 1024;
const MAX_PROPOSALS = 9999;
const MAX_RATIONALE = 4000;
const MAX_FACT_IDS = 100;
const MAX_APPLIED_TO = 4096;
// Commit identity for the temp repo, through runGit's env (never -c args).
const GIT_ID = Object.freeze({
  GIT_AUTHOR_NAME: 'King Louie',
  GIT_AUTHOR_EMAIL: 'king-louie@localhost',
  GIT_COMMITTER_NAME: 'King Louie',
  GIT_COMMITTER_EMAIL: 'king-louie@localhost'
});
// Every diff: no external diff program and no textconv driver, whatever a
// config says.
const DIFF_SAFE = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

const ID_RE = /^pp-\d{3,4}$/;
const PATCH_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}-\d{4}-\d{2}-\d{2}-\d{4}(?:-\d{1,4})?\.patch$/;
const PACKAGE_DIR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}(?:-\d{1,4})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH_TEXT_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const FACT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATUSES = new Set(['applied', 'rejected']);
const RECORD_KEYS = new Set(['id', 'playbook', 'newPlaybook', 'baseVersion', 'baseCommit', 'baseContentHash', 'patch', 'patchSha256', 'packageDir', 'files', 'rationale', 'factIds', 'createdAt', 'turnId']);
const STATUS_KEYS = new Set(['id', 'status', 'at', 'appliedTo', 'appliedOver']);

class ProposalError extends Error {
  constructor(message, code = 'PROPOSAL') {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
  }
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stamp = (d) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v, max) => typeof v === 'string' && v.length <= max;
// Untrusted text in a message: quoted, one line, capped.
const show = (v) => JSON.stringify(typeof v === 'string' ? v.slice(0, 80) : typeof v);

// A bare playbook file name: .md/.yaml/.txt, no dot prefix, no Windows
// device name, no trailing dot.
function isFileName(p) {
  return typeof p === 'string' && FILE_RE.test(p) && !p.startsWith('.') && !segmentProblem(p) && !reservedNameProblem(p);
}

function checkFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new ProposalError(`files must list 1 to ${MAX_FILES} { path, content }.`);
  }
  const seen = new Set();
  for (const f of files) {
    const p = f && typeof f.path === 'string' ? f.path : '';
    if (!isFileName(p)) {
      throw new ProposalError(`${show(f && f.path)} is not a playbook file name. Use a bare .md, .yaml or .txt name such as steps.md.`);
    }
    // Case-folded: on Windows and macOS Steps.md and steps.md are one file.
    if (seen.has(p.toLowerCase())) throw new ProposalError(`${p} is listed twice.`);
    seen.add(p.toLowerCase());
    if (typeof f.content !== 'string') throw new ProposalError(`${p}: content must be text.`);
    if (Buffer.byteLength(f.content, 'utf8') > LIMITS.fileBytes) throw new ProposalError(`${p} is larger than 256 KiB.`);
  }
}

// ---- patch confinement ----------------------------------------------------

const unsafe = (why) => new ProposalError(`The patch is not confined to the playbook: ${why}.`, 'UNSAFE_PATCH');
const OID = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const INDEX_RE = new RegExp(`^index (${OID})\\.\\.(${OID})(?: (\\d{6}))?$`);
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function pathProblem(p) {
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return `${show(p)} is an absolute path`;
  if (p.includes('\\')) return `${show(p)} contains a backslash`;
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return `${show(p)} has a ".." segment`;
  if (!isFileName(p)) return `${show(p)} is not a bare playbook file name`;
  return null;
}

function checkPath(p) {
  const problem = pathProblem(p);
  if (problem) throw unsafe(problem);
}

function checkMode(mode, p) {
  if (mode === '100644') return;
  if (mode === '120000') throw unsafe(`${show(p)} is a symlink`);
  if (mode === '160000') throw unsafe(`${show(p)} is a gitlink (submodule)`);
  if (mode === '100755') throw unsafe(`${show(p)} is executable`);
  throw unsafe(`${show(p)} has mode ${mode}`);
}

// A playbook.yaml line that adds or removes the TOP-LEVEL `name` or
// `version` key (ruling T9-lines): unindented, the key optionally quoted,
// or as an unindented "? name" / "? version" complex key. Nested keys and
// text in steps or questions stay editable. The authoritative check is on
// the applied result in the throwaway clone (checkResult), which also
// catches keys spelled with YAML escapes, flow mappings and duplicates.
const IDENTITY_KEY_RE = /^(["']?)(?:name|version)\1\s*:/;
const COMPLEX_KEY_RE = /^\?\s+(["']?)(?:name|version)\1\s*(?::|$)/;

// Parses a git patch line by line → [{ name, isNew, content }] in order
// (content: the whole text of a created file, else null). Every line must
// belong to a `diff --git` section: extended headers are whitelisted, hunks
// are consumed by their counts, so no text between sections (which git
// apply would read as a traditional diff) survives. `newOnly`: every
// section must create its file (a new playbook). Otherwise (a change
// proposal) a created file must be .md, and no playbook.yaml line adding or
// removing a name or version key is accepted: the version is the owner's
// to bump.
function parsePatch(patch, { newOnly = false } = {}) {
  if (typeof patch !== 'string') throw unsafe('it is not text');
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw unsafe('it is too large');
  if (patch === '') throw unsafe('it changes no file');
  if (!patch.endsWith('\n')) throw unsafe('it does not end with a newline');
  const lines = patch.slice(0, -1).split('\n');
  const sections = [];
  const folded = new Set();
  let i = 0;
  const notPart = () => unsafe(`line ${i + 1} is not part of a file diff`);
  while (i < lines.length) {
    const m = DIFF_RE.exec(lines[i]);
    if (!m) throw notPart();
    const [, a, b] = m;
    checkPath(a);
    checkPath(b);
    if (a !== b) throw unsafe('renames and copies are not allowed');
    if (folded.has(a.toLowerCase())) throw unsafe(`${show(a)} appears twice`);
    folded.add(a.toLowerCase());
    if (sections.length >= MAX_FILES) throw unsafe(`it changes more than ${MAX_FILES} files`);
    i += 1;
    let isNew = false;
    let sawIndex = false;
    // Mode and rename/copy headers are refused after the whole header block
    // is read, so every path and mode in it is checked first (and named).
    let modeChange = false;
    let renameOrCopy = false;
    while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) {
      const line = lines[i];
      let h;
      if ((h = /^new file mode (\d{6})$/.exec(line))) {
        checkMode(h[1], a);
        if (isNew || sawIndex) throw unsafe(`unexpected header on line ${i + 1}`);
        isNew = true;
      } else if ((h = INDEX_RE.exec(line))) {
        if (sawIndex) throw unsafe(`unexpected header on line ${i + 1}`);
        if (h[3]) checkMode(h[3], a);
        sawIndex = true;
      } else if ((h = /^(?:old|new) mode (\d{6})$/.exec(line))) {
        checkMode(h[1], a);
        modeChange = true;
      } else if (/^deleted file mode /.test(line)) {
        throw unsafe(`it deletes ${show(a)}`);
      } else if ((h = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) {
        checkPath(h[1]);
        renameOrCopy = true;
      } else if (/^(?:dis)?similarity index \d{1,3}%$/.test(line)) {
        renameOrCopy = true;
      } else if (/^(?:GIT binary patch|Binary files )/.test(line)) {
        throw unsafe(`it is a binary patch for ${show(a)}`);
      } else {
        throw unsafe(`unexpected header on line ${i + 1}`);
      }
      i += 1;
    }
    if (renameOrCopy) throw unsafe('renames and copies are not allowed');
    if (modeChange) throw unsafe(`it changes the mode of ${show(a)}`);
    if (!sawIndex) throw unsafe(`${show(a)} has no full index line`);
    if (newOnly && !isNew) throw unsafe(`it changes an existing file ${show(a)}; a new playbook only adds files`);
    if (!newOnly && isNew && !a.endsWith('.md')) throw unsafe(`it creates ${show(a)}; a new file in a playbook must be .md`);
    const guardKeys = !newOnly && a === 'playbook.yaml';
    const added = [];
    let noFinalNewline = false;
    const noteLine = (line, at) => {
      const c = line[0];
      if (c === '\\') {
        // "\ No newline at end of file" after the last added line.
        if (isNew) noFinalNewline = true;
        return;
      }
      if (guardKeys && (c === '+' || c === '-') && (IDENTITY_KEY_RE.test(line.slice(1)) || COMPLEX_KEY_RE.test(line.slice(1)))) {
        throw unsafe(`it adds or removes a name or version line in playbook.yaml (line ${at + 1}); the version is the owner's to bump`);
      }
      if (isNew && c === '+') added.push(line.slice(1));
    };
    if (i < lines.length && lines[i].startsWith('--- ')) {
      const minus = isNew ? '--- /dev/null' : `--- a/${a}`;
      if (lines[i] !== minus) throw unsafe(`line ${i + 1}: expected "${minus}"`);
      if (lines[i + 1] !== `+++ b/${a}`) throw unsafe(`line ${i + 2}: expected "+++ b/${a}"`);
      i += 2;
      let hunks = 0;
      while (i < lines.length && lines[i].startsWith('@@')) {
        const hm = HUNK_RE.exec(lines[i]);
        if (!hm) throw unsafe(`line ${i + 1} is not a hunk header`);
        let oldN = hm[2] === undefined ? 1 : Number(hm[2]);
        let newN = hm[4] === undefined ? 1 : Number(hm[4]);
        hunks += 1;
        if (isNew && hunks > 1) throw unsafe(`the new file ${show(a)} has more than one hunk`);
        i += 1;
        while (oldN > 0 || newN > 0) {
          if (i >= lines.length) throw unsafe(`the hunk for ${show(a)} is truncated`);
          const c = lines[i][0];
          if (c === ' ') { oldN -= 1; newN -= 1; } else if (c === '-') oldN -= 1;
          else if (c === '+') newN -= 1;
          else if (c !== '\\') throw unsafe(`line ${i + 1} does not match its hunk's counts`);
          if (oldN < 0 || newN < 0) throw unsafe(`line ${i + 1} does not match its hunk's counts`);
          noteLine(lines[i], i);
          i += 1;
        }
        if (i < lines.length && lines[i].startsWith('\\ ')) {
          noteLine(lines[i], i);
          i += 1;
        }
      }
      if (!hunks) throw unsafe(`${show(a)} has no hunk`);
    } else if (!isNew) {
      throw unsafe(`${show(a)} has no content change`);
    }
    const content = isNew ? added.join('\n') + (added.length && !noFinalNewline ? '\n' : '') : null;
    sections.push({ name: a, isNew, content });
  }
  return sections;
}

// The file names a patch touches, in order (parsePatch's rules).
function checkPatch(patch, options = {}) {
  return parsePatch(patch, options).map((s) => s.name);
}

// Throws `err` unless the patch touches exactly the files `files` lists.
function requireSameFiles(names, files, err) {
  const a = [...names].sort();
  const b = Array.isArray(files) ? [...files].sort() : [];
  if (a.length !== b.length || a.some((n, k) => n !== b[k])) throw err;
}

// A new playbook's manifest, from the patch's created playbook.yaml, must
// carry the proposed name and start at NEW_VERSION.
function checkNewManifest(sections, name, fail) {
  const manifest = sections.find((s) => s.name === 'playbook.yaml');
  const parsed = manifest ? parsePlaybookYaml(manifest.content).value : null;
  if (!isObject(parsed) || parsed.name !== name) throw fail(`its playbook.yaml does not name the playbook "${name}"`);
  if (parsed.version !== NEW_VERSION) throw fail(`its playbook.yaml does not start at version "${NEW_VERSION}"`);
}

// ---- building -------------------------------------------------------------

// → { patch, changedFiles, playbook }. base: the vendored package as a
// snapshot ({ files: [{ rel, data }] }), or null for a new playbook.
async function buildProposal({ name, isNew, base = null, files, knownCaseTypes = null, tmpRoot = os.tmpdir() }) {
  checkFiles(files);
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new ProposalError(`${show(name)} is not a valid playbook name.`);
  const baseFiles = isNew ? [] : (base && Array.isArray(base.files) ? base.files : null);
  if (!baseFiles) throw new ProposalError('A change proposal needs the vendored package as its base.');
  const baseNames = new Map(); // lower-cased → exact
  for (const f of baseFiles) {
    const rel = f && typeof f.rel === 'string' ? f.rel : '';
    const segments = rel.split('/');
    if (!rel || /[\\:\0]/.test(rel) || segments.some((seg) => !seg || segmentProblem(seg) || reservedNameProblem(seg)) || !Buffer.isBuffer(f.data)) {
      throw new ProposalError(`${show(rel)} is not a valid package path.`);
    }
    baseNames.set(rel.toLowerCase(), rel);
  }
  for (const f of files) {
    const exact = baseNames.get(f.path.toLowerCase());
    if (!isNew && exact && exact !== f.path) throw new ProposalError(`${f.path} differs only in case from ${exact}.`);
    if (!isNew && !exact && !f.path.endsWith('.md')) {
      throw new ProposalError(`${f.path} is not in the playbook; a new file must be .md.`);
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'kl-proposal-'));
  const hooksDir = path.join(tmpDir, 'hooks');
  const repo = path.join(tmpDir, 'repo');
  const git = (args, opts = {}) => runGit(repo, args, { hooksDir, ...opts });
  try {
    fs.mkdirSync(hooksDir, { mode: 0o700 });
    fs.mkdirSync(repo);
    await git(['init', '-q']);
    let baseVersion = null;
    for (const f of baseFiles) {
      const file = path.join(repo, ...f.rel.split('/'));
      if (!isInside(file, repo)) throw new ProposalError(`${show(f.rel)} is not a valid package path.`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.data);
    }
    const manifest = baseFiles.find((f) => f.rel === 'playbook.yaml');
    if (manifest) baseVersion = parsePlaybookYaml(manifest.data.toString('utf8')).value?.version ?? null;
    await git(['add', '-A']);
    await git(['commit', '-q', '--allow-empty', '-m', 'base'], { env: GIT_ID });
    for (const f of files) fs.writeFileSync(path.join(repo, f.path), f.content);
    const v = validatePackage(repo, { dirName: name, knownCaseTypes });
    if (!v.ok) throw new ProposalError(`The proposed playbook does not validate:\n${formatErrors(v.errors)}`);
    if (isNew && v.playbook.version !== NEW_VERSION) throw new ProposalError(`A new playbook starts at version "${NEW_VERSION}".`);
    if (!isNew && v.playbook.version !== baseVersion) {
      throw new ProposalError("The version is the owner's to bump; leave playbook.yaml version as it is.");
    }
    await git(['add', '-A']);
    const patch = await git(['diff', '--cached', '--full-index', ...DIFF_SAFE]);
    if (!patch.trim()) throw new ProposalError('The proposal changes nothing.');
    const changedFiles = (await git(['diff', '--cached', '--name-only', ...DIFF_SAFE])).split('\n').map((s) => s.trim()).filter(Boolean);
    checkPatch(patch, { newOnly: Boolean(isNew) });
    return { patch, changedFiles, playbook: v.playbook };
  } finally {
    removeDir(tmpDir);
  }
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    log.warn('could not remove a temp dir', { dir, error: err.message });
  }
  forgetConfigs(dir);
}

// ---- the records ----------------------------------------------------------

// A directory KL writes into must be a real folder inside the case, not a
// link that carries the write elsewhere. Creates it when missing.
function realDir(dir, label) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* missing */ }
  if (!st) {
    fs.mkdirSync(dir);
    return dir;
  }
  if (st.isSymbolicLink()) throw new ProposalError(`${label} is a link; proposals are written only into a real folder in the case.`, 'UNSAFE_TARGET');
  if (!st.isDirectory()) throw new ProposalError(`${label} is not a folder.`, 'UNSAFE_TARGET');
  return dir;
}

function patchDir(caseDir) {
  realDir(caseDir, 'The case folder');
  const [first, second] = PATCH_DIR.split('/');
  realDir(path.join(caseDir, first), first);
  return realDir(path.join(caseDir, first, second), PATCH_DIR);
}

// A proposal record from the file, as a null-prototype object carrying only
// the known keys, or null when anything about it is off.
function validRecord(e) {
  if (!Object.keys(e).every((k) => RECORD_KEYS.has(k))) return null;
  const ok = ID_RE.test(e.id)
    && typeof e.playbook === 'string' && NAME_RE.test(e.playbook)
    && typeof e.newPlaybook === 'boolean'
    && (e.baseVersion === null || (isString(e.baseVersion, 64) && VERSION_RE.test(e.baseVersion)))
    && (e.baseCommit === null || (typeof e.baseCommit === 'string' && COMMIT_RE.test(e.baseCommit)))
    && (e.baseContentHash === null || (typeof e.baseContentHash === 'string' && HASH_TEXT_RE.test(e.baseContentHash)))
    && typeof e.patch === 'string' && e.patch.startsWith(`${PATCH_DIR}/`) && PATCH_NAME_RE.test(e.patch.slice(PATCH_DIR.length + 1))
    && typeof e.patchSha256 === 'string' && SHA256_RE.test(e.patchSha256)
    && (e.packageDir === undefined || (e.newPlaybook && typeof e.packageDir === 'string' && e.packageDir.startsWith(`${PATCH_DIR}/`) && PACKAGE_DIR_NAME_RE.test(e.packageDir.slice(PATCH_DIR.length + 1))))
    && Array.isArray(e.files) && e.files.length >= 1 && e.files.length <= MAX_FILES && e.files.every(isFileName)
    && isString(e.rationale, MAX_RATIONALE)
    && Array.isArray(e.factIds) && e.factIds.length <= MAX_FACT_IDS && e.factIds.every((f) => typeof f === 'string' && FACT_ID_RE.test(f))
    && typeof e.createdAt === 'string' && ISO_RE.test(e.createdAt)
    && (e.turnId === null || (isString(e.turnId, 128) && e.turnId.length > 0));
  if (!ok) return null;
  const r = Object.create(null);
  for (const k of RECORD_KEYS) if (e[k] !== undefined) r[k] = Array.isArray(e[k]) ? [...e[k]] : e[k];
  return r;
}

function validStatus(e) {
  if (!Object.keys(e).every((k) => STATUS_KEYS.has(k))) return null;
  const ok = ID_RE.test(e.id)
    && STATUSES.has(e.status)
    && typeof e.at === 'string' && ISO_RE.test(e.at)
    && (e.appliedTo === undefined || (isString(e.appliedTo, MAX_APPLIED_TO) && e.appliedTo.length > 0))
    && (e.appliedOver === undefined || e.appliedOver === null || (isString(e.appliedOver, 64) && VERSION_RE.test(e.appliedOver)));
  return ok ? e : null;
}

function readLines(caseDir) {
  const file = path.join(caseDir, PROPOSALS_FILE);
  let st = null;
  try { st = fs.lstatSync(file); } catch { return []; }
  if (!st.isFile()) throw new ProposalError(`${PROPOSALS_FILE} is not a regular file; review it by hand.`, 'TAMPERED');
  if (st.size > MAX_PROPOSALS_BYTES) throw new ProposalError(`${PROPOSALS_FILE} is too large; review it by hand.`, 'TAMPERED');
  const { entries, errors } = readJsonl(file);
  if (errors.length) log.warn('skipped unreadable proposal lines', { caseDir, lines: errors.map((e) => e.line).slice(0, 20) });
  return entries;
}

// Every valid record and status line, replayed:
// [{ ...record, status, statusAt?, appliedTo?, appliedOver? }]. Invalid lines
// are skipped (and logged); the first record with an id wins.
function listProposals(caseDir) {
  const byId = new Map();
  let skipped = 0;
  for (const e of readLines(caseDir)) {
    if (!isObject(e) || typeof e.id !== 'string') { skipped += 1; continue; }
    if (e.status !== undefined) {
      const s = validStatus(e);
      const r = s && byId.get(s.id);
      if (!r) { skipped += 1; continue; }
      r.status = s.status;
      r.statusAt = s.at;
      if (s.appliedTo !== undefined) r.appliedTo = s.appliedTo;
      if (s.appliedOver !== undefined) r.appliedOver = s.appliedOver;
    } else {
      const r = validRecord(e);
      if (!r || byId.has(r.id) || byId.size >= MAX_PROPOSALS) { skipped += 1; continue; }
      r.status = 'proposed';
      byId.set(r.id, r);
    }
  }
  if (skipped) log.warn('skipped invalid proposal records', { caseDir, skipped });
  return [...byId.values()];
}

function appendLine(caseDir, line) {
  realDir(caseDir, 'The case folder');
  realDir(path.join(caseDir, path.dirname(PROPOSALS_FILE)), path.dirname(PROPOSALS_FILE));
  const file = path.join(caseDir, PROPOSALS_FILE);
  let st = null;
  try { st = fs.lstatSync(file); } catch { /* missing */ }
  if (st && !st.isFile()) throw new ProposalError(`${PROPOSALS_FILE} is not a regular file; review it by hand.`, 'TAMPERED');
  appendJsonl(file, line);
}

function getProposal(caseDir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return listProposals(caseDir).find((r) => r.id === id) || null;
}

// Creates <dir>/<base>[-n]<ext> exclusively (a file, or a folder when ext
// is ''), so two writers never share a name. → the name.
function createFree(dir, base, ext, create) {
  for (let n = 1; n <= MAX_PROPOSALS; n += 1) {
    const name = `${base}${n === 1 ? '' : `-${n}`}${ext}`;
    try {
      create(path.join(dir, name));
      return name;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new ProposalError(`Too many proposals named ${base}.`);
}

// Writes the patch (and, for a new playbook, the package folder) under
// artifacts/playbook-proposals/ and appends the record. The record is
// checked by the same rules listProposals reads it with.
function storeProposal(caseDir, { name, isNew, patch, files, baseVersion = null, baseCommit = null, baseContentHash = null, changedFiles, rationale, factIds = [], turnId = null, now = new Date() }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new ProposalError(`${show(name)} is not a valid playbook name.`);
  const sections = parsePatch(patch, { newOnly: Boolean(isNew) });
  requireSameFiles(sections.map((s) => s.name), changedFiles, unsafe('it touches other files than the proposal lists'));
  if (isNew) {
    checkNewManifest(sections, name, unsafe);
    // The package folder is written from the patch, so the two always
    // agree; files, when given, must say the same.
    if (files !== undefined) {
      checkFiles(files);
      const byName = new Map(sections.map((s) => [s.name, s.content]));
      if (files.length !== sections.length || files.some((f) => byName.get(f.path) !== f.content)) {
        throw unsafe('its files differ from the files the proposal lists');
      }
    }
  }
  const existing = listProposals(caseDir);
  const next = existing.reduce((max, r) => Math.max(max, Number(r.id.slice(3))), 0) + 1;
  if (next > MAX_PROPOSALS) throw new ProposalError(`A case holds at most ${MAX_PROPOSALS} proposals.`);
  const draft = {
    id: `pp-${String(next).padStart(3, '0')}`,
    playbook: name,
    newPlaybook: Boolean(isNew),
    baseVersion,
    baseCommit,
    baseContentHash,
    patch: `${PATCH_DIR}/${name}-${stamp(now)}.patch`,
    patchSha256: '0'.repeat(64),
    ...(isNew ? { packageDir: `${PATCH_DIR}/${name}` } : {}),
    files: changedFiles,
    rationale,
    factIds,
    createdAt: now.toISOString(),
    turnId
  };
  if (!validRecord(draft)) throw new ProposalError('The proposal record is not valid (check its files, rationale, fact ids and base fields).');
  const dir = patchDir(caseDir);
  const bytes = Buffer.from(patch, 'utf8');
  const patchName = createFree(dir, `${name}-${stamp(now)}`, '.patch', (file) => fs.writeFileSync(file, bytes, { flag: 'wx' }));
  let packageDir = null;
  if (isNew) {
    const folder = createFree(dir, name, '', (d) => fs.mkdirSync(d));
    for (const s of sections) fs.writeFileSync(path.join(dir, folder, s.name), s.content, { flag: 'wx' });
    packageDir = `${PATCH_DIR}/${folder}`;
  }
  const record = {
    ...draft,
    patch: `${PATCH_DIR}/${patchName}`,
    patchSha256: sha256Hex(bytes),
    ...(packageDir ? { packageDir } : {})
  };
  appendLine(caseDir, record);
  return record;
}

function setProposalStatus(caseDir, id, status, extra = {}, now = new Date()) {
  if (!getProposal(caseDir, id)) throw new ProposalError(`Proposal ${typeof id === 'string' && ID_RE.test(id) ? id : '(invalid id)'} was not found.`);
  const line = { id, status, at: now.toISOString(), ...extra };
  if (!STATUSES.has(status)) throw new ProposalError('A proposal status must be applied or rejected.');
  if (!validStatus(line)) throw new ProposalError('The status line has unknown or invalid fields (only appliedTo and appliedOver).');
  appendLine(caseDir, line);
  return getProposal(caseDir, id);
}

// ---- applying -------------------------------------------------------------

const tampered = () => new ProposalError('The proposal file was changed after it was proposed; review it by hand.', 'TAMPERED');

// The record's patch bytes, read only from a regular file directly inside
// the case's PATCH_DIR, and only when they hash to patchSha256.
function readVerifiedPatch(caseDir, record) {
  if (!isObject(record)) throw tampered();
  const r = validRecord(Object.fromEntries(Object.entries(record).filter(([k]) => RECORD_KEYS.has(k))));
  if (!r) throw tampered();
  const dir = path.join(caseDir, ...PATCH_DIR.split('/'));
  const file = path.join(dir, r.patch.slice(PATCH_DIR.length + 1));
  let bytes = null;
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size <= MAX_PATCH_BYTES && isInside(file, dir) && isInside(dir, caseDir)) bytes = fs.readFileSync(file);
  } catch {
    bytes = null;
  }
  if (!bytes || sha256Hex(bytes) !== r.patchSha256) throw tampered();
  return { r, bytes };
}

const isUncLike = (p) => /^[\\/]{2}/.test(p);

async function unmerged(repo, opts) {
  return (await runGit(repo, ['ls-files', '--unmerged'], opts)).trim() !== '';
}

async function headOf(repo) {
  try {
    return (await runGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
  } catch {
    return null; // no commit yet
  }
}

function gitFailure(err, fallback) {
  if (err instanceof ProposalError) return err;
  if (err && err.code === 'GIT_TIMEOUT') return new ProposalError(`git timed out while applying the proposal (${err.firstLine || err.message}).`, 'TIMEOUT');
  if (err && err.code === 'GIT_UNSAFE_CONFIG') return err;
  return fallback;
}

// The applied playbook.yaml in the throwaway clone must still name the
// playbook, and keep the owner's version (a change) or start at
// NEW_VERSION (a new playbook). This is the authoritative form of
// parsePatch's name/version line rule: it reads what git actually wrote,
// so a key spelled with YAML escapes or a duplicate key is caught too.
function checkResult(file, r, appliedOver) {
  let parsed = null;
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size <= LIMITS.fileBytes) parsed = parsePlaybookYaml(fs.readFileSync(file, 'utf8')).value;
  } catch { /* missing */ }
  const want = r.newPlaybook ? NEW_VERSION : appliedOver;
  if (!isObject(parsed) || parsed.name !== r.playbook || parsed.version !== want) {
    throw new ProposalError(`The patch would change the playbook's name or version (the version is the owner's to bump); review ${r.patch} by hand.`, 'UNSAFE_PATCH');
  }
}

// Checks in the order of spec §3.10, then git apply. The patch is always
// applied first in a throwaway clone of the owner's repository (3-way when
// the repository's version differs from the proposal's base), the result is
// checked there, and only then is the owner's repository touched.
// → { appliedOver, rel }. `casesRoot` is required: without it a repository
// inside another case could not be refused. `onProbeApplied` is a test seam
// run after the clone applied cleanly, before the owner's repository is
// re-checked and touched.
async function applyProposalTo({ caseDir, casesRoot, record, repoPath, tmpRoot = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS, onProbeApplied = null }) {
  if (typeof casesRoot !== 'string' || !path.isAbsolute(casesRoot) || isUncLike(casesRoot)) {
    throw new ProposalError('applyProposalTo needs the absolute cases root, so no repository inside a case is written.', 'NO_CASES_ROOT');
  }
  const { r, bytes } = readVerifiedPatch(caseDir, record);
  const sections = parsePatch(bytes.toString('utf8'), { newOnly: r.newPlaybook });
  const names = sections.map((s) => s.name);
  const mismatch = (why) => new ProposalError(`The proposal patch ${why}; review it by hand.`, 'TAMPERED');
  requireSameFiles(names, r.files, mismatch('touches other files than its record lists'));
  if (r.newPlaybook) checkNewManifest(sections, r.playbook, (why) => mismatch(`is not a new "${r.playbook}" playbook: ${why}`));

  const notRepo = () => new ProposalError(`${repoPath} is not inside a git repository.`, 'NOT_A_REPO');
  // A UNC path is refused on its text: touching it can send credentials.
  if (typeof repoPath !== 'string' || isUncLike(repoPath) || !path.isAbsolute(repoPath) || !fs.existsSync(repoPath)) throw notRepo();
  const real = fs.realpathSync.native(repoPath);
  if (isUncLike(real)) throw notRepo();
  if (isInside(real, caseDir) || isInside(real, casesRoot)) {
    throw new ProposalError(`${repoPath} is inside a case; apply to the playbook's own repository.`, 'INSIDE_CASE');
  }
  let top;
  try {
    top = fs.realpathSync.native((await runGit(real, ['rev-parse', '--show-toplevel'])).trim());
  } catch (err) {
    if (err && err.code === 'GIT_UNSAFE_CONFIG') throw err;
    throw notRepo();
  }
  if (!isInside(real, top) || isUncLike(top)) throw notRepo();
  const rel = path.relative(top, real).split(path.sep).join('/');

  const manifest = path.join(real, 'playbook.yaml');
  let appliedOver = null;
  if (r.newPlaybook) {
    if (fs.existsSync(manifest)) throw new ProposalError(`${repoPath} already holds a playbook.`, 'WRONG_PLAYBOOK');
  } else {
    let parsed = null;
    try {
      const st = fs.lstatSync(manifest);
      if (st.isFile() && st.size <= LIMITS.fileBytes) parsed = parsePlaybookYaml(fs.readFileSync(manifest, 'utf8')).value;
    } catch { /* missing */ }
    const holder = isObject(parsed) && typeof parsed.name === 'string' ? parsed.name : 'none';
    if (holder !== r.playbook) throw new ProposalError(`${repoPath} holds playbook ${show(holder)}, not "${r.playbook}".`, 'WRONG_PLAYBOOK');
    appliedOver = typeof parsed.version === 'string' && VERSION_RE.test(parsed.version) ? parsed.version : null;
  }
  const dirty = () => new ProposalError(`${repoPath} has uncommitted changes; commit or stash them first.`, 'DIRTY');
  if ((await runGit(top, ['status', '--porcelain'])).trim()) throw dirty();

  const dirArgs = rel ? [`--directory=${rel}`] : [];
  const threeWay = !r.newPlaybook && appliedOver !== r.baseVersion;
  const mode = threeWay ? ['--3way'] : [];
  const moved = new ProposalError(`Proposal was written against ${r.playbook} ${r.baseVersion}; the repository is at ${appliedOver} and the patch does not apply. Open ${r.patch} and merge by hand.`, 'DOES_NOT_APPLY');
  const plainFails = (err) => new ProposalError(`The patch does not apply: ${(err && (err.firstLine || err.message)) || 'unknown error'}`, 'DOES_NOT_APPLY');
  const doesNotApply = threeWay ? () => moved : plainFails;

  // The verified bytes go to a private copy, so the case file can't change
  // between the hash check and git reading it.
  const work = fs.mkdtempSync(path.join(tmpRoot, 'kl-apply-'));
  try {
    const patchFile = path.join(work, 'proposal.patch');
    fs.writeFileSync(patchFile, bytes, { flag: 'wx' });
    // The patch is tried in a throwaway clone first: `git apply --3way
    // --check` is not a dry run (it leaves conflicts behind), and the
    // applied playbook.yaml is checked there (checkResult).
    const head = await headOf(top);
    const probe = path.join(work, 'repo');
    // One deadline for the whole probe: each git call gets what is left
    // (its process tree is killed when that runs out), and a step that
    // finished past the deadline still counts as a timeout.
    const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
    const left = () => {
      if (!deadline) return { killTree: true, timeoutMs: 0 };
      const ms = deadline - Date.now();
      if (ms <= 0) throw new ProposalError(`git timed out while applying the proposal (after ${timeoutMs} ms).`, 'TIMEOUT');
      return { killTree: true, timeoutMs: ms };
    };
    try {
      await runGit(work, ['clone', '-q', '--no-hardlinks', '--no-recurse-submodules', '--no-checkout', '--', top, probe], { ...left(), allowFile: true });
      if (head) await runGit(probe, ['checkout', '-q', '--detach', head], left());
      await runGit(probe, ['apply', ...mode, ...dirArgs, '--', patchFile], left());
      if (await unmerged(probe, left())) throw moved;
      left();
    } catch (err) {
      throw gitFailure(err, doesNotApply(err));
    }
    checkResult(path.join(probe, ...(rel ? rel.split('/') : []), 'playbook.yaml'), r, appliedOver);
    if (onProbeApplied) await onProbeApplied();
    // The clone showed the patch applies to `head`; the owner's repository
    // must still be exactly there. An owner edit that lands after this
    // status check and before git apply below is still safe: git apply
    // checks each file's preimage (the patch's context and removed lines,
    // and for --3way that the file matches the index) before it writes
    // anything, so an edited file makes it fail without writing, and a file
    // the owner edits that the patch does not touch is left alone.
    if ((await runGit(top, ['status', '--porcelain'])).trim()) throw dirty();
    if ((await headOf(top)) !== head) {
      throw new ProposalError(`${repoPath} changed while the proposal was checked; try again.`, 'DOES_NOT_APPLY');
    }
    await applyToOwner(top, ['apply', ...mode, ...dirArgs, '--', patchFile], { killTree: true, timeoutMs }, repoPath, names, rel, doesNotApply);
    return { appliedOver, rel };
  } finally {
    removeDir(work);
  }
}

// The one step that writes the owner's repository. git apply is atomic when
// it fails outright; if it fails or leaves conflicts after writing, the
// error says so and names the files, rather than guessing at a rollback
// that could overwrite the owner's own edits.
async function applyToOwner(top, args, opts, repoPath, names, rel, fallback) {
  let failure = null;
  try {
    await runGit(top, args, opts);
  } catch (err) {
    failure = err;
  }
  let changed = '';
  let conflicts = false;
  try {
    changed = (await runGit(top, ['status', '--porcelain'])).trim();
    conflicts = await unmerged(top, {});
  } catch (err) {
    changed = `(git status failed: ${err.firstLine || err.message})`;
  }
  if (failure && !changed) throw gitFailure(failure, fallback(failure));
  if (failure || conflicts) {
    const files = names.map((n) => (rel ? `${rel}/${n}` : n)).join(', ');
    log.error('a proposal applied only partly', { repoPath, files });
    throw new ProposalError(`The patch applied only partly to ${repoPath}; check ${files} with git status there (git checkout -- <file> undoes a change).`, 'APPLY_INCOMPLETE');
  }
}

module.exports = {
  PROPOSALS_FILE,
  PATCH_DIR,
  MAX_FILES,
  NEW_VERSION,
  MAX_PATCH_BYTES,
  MAX_PROPOSALS_BYTES,
  ProposalError,
  isFileName,
  checkFiles,
  checkPatch,
  buildProposal,
  storeProposal,
  listProposals,
  getProposal,
  setProposalStatus,
  applyProposalTo
};
