// src/cases/verify/check.js
// Cases stage 8 (spec §6.6, §7.4; R-C8-3): the check command of a
// software-repo case. One command, named by the owner, that says whether
// the repository is in a good state. This is the only code of the stage
// that starts a program the owner did not start, so it ships off
// (cases.softwareRepo.check.enabled, default false) and every step fails
// closed.
//
// What is held: who named the command (the owner's own words, or the case
// panel), exactly what is started (the approved argv, no shell, never
// cmd.exe), where (the repository, as the working directory only), when
// (the close of an owner turn, when the repository changed), for how long,
// with what environment, and what is kept of its output. What is not: the
// command runs the repository's own scripts with the account's access. It
// can write files and use the network. Nothing here makes it read-only.
//
// Owner ruling 2026-10-13: npm only. The program is `npm` and the command
// is `npm test` or `npm run <script>`; no other runner can be named.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../jsonfile');
const { plainLineProblem } = require('../hidden-chars');
const { isCloneUrl, pathKey } = require('../case-types/software-repo');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify/check');

const CHECK_TYPE = 'check-approve';
const CASE_TYPE = 'software-repo';
const MAX_CHARS = 200;
const MAX_TOKENS = 12;
const KEEP_RUNS = 20;
const TOKEN = /^[A-Za-z0-9_./:=@,+-]+$/;
const RUN_ID = /^chk-(\d{4,})$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const RESULTS = Object.freeze(['pass', 'fail', 'timeout', 'spawn-failed']);
// The only programs that may be the check (owner ruling: npm only).
const ALLOWED_PROGRAMS = Object.freeze(['npm']);
// What npm may be asked to do: run the repository's own script.
const NPM_COMMANDS = Object.freeze(['test', 'run']);
// Never the check, whatever the list above becomes: a shell, or a tool that
// fetches or runs what it is handed.
const REFUSED_PROGRAMS = Object.freeze([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'sudo', 'doas', 'curl', 'wget', 'ssh', 'scp',
  'npx', 'bunx', 'pnpx', 'eval', 'exec', 'xargs'
]);
// The flags that hand a program code on its command line.
const CODE_FLAGS = Object.freeze(['-c', '-e', '--eval', '-p', '--print', '--exec']);

const POLICY_OFF = Object.freeze({
  CHECK_DISABLED: 'Check commands are turned off (cases.softwareRepo.check.enabled). Nothing is run.',
  CHECK_SERVICE_OFF: 'Check commands are off on this service until its administrator turns them on ("caseChecks" in the admin service.json). Nothing is run.'
});

class CheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
const baseName = (p) => String(p).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

// → the command as it is stored and approved (trimmed, single spaces), or
// throws CheckError CHECK_INVALID with the reason. A filter against the
// obvious, not a sandbox: `npm test` runs whatever package.json says.
function validateCheck(value) {
  const bad = (reason) => { throw new CheckError('CHECK_INVALID', `The check command ${reason}`); };
  if (typeof value !== 'string') bad('must be text.');
  const command = value.trim();
  if (command.length < 1 || command.length > MAX_CHARS) bad(`must be 1 to ${MAX_CHARS} characters.`);
  const tokens = command.split(' ');
  if (tokens.some((t) => t === '')) bad('must separate its words with single spaces.');
  if (tokens.some((t) => !TOKEN.test(t))) {
    bad('may hold only letters, digits and _ . / : = @ , + - in each word: no quotes and no characters a shell gives meaning to.');
  }
  if (tokens.length > MAX_TOKENS) bad(`may have at most ${MAX_TOKENS} words.`);
  const program = tokens[0];
  if (program.includes('=')) bad('may not start with an assignment.');
  if (program.startsWith('-')) bad('may not start with "-".');
  if (program.split('/').includes('..')) bad('may not name a program through "..".');
  if (program.startsWith('/') || /^[A-Za-z]:/.test(program)) bad('may not name its program by an absolute path.');
  if (REFUSED_PROGRAMS.includes(baseName(program))) bad(`names ${baseName(program)}, which may not be the check.`);
  for (const t of tokens) {
    if (CODE_FLAGS.some((flag) => t === flag || t.startsWith(`${flag}=`))) bad(`holds ${t.split('=')[0]}, which hands a program code on its command line.`);
  }
  if (!ALLOWED_PROGRAMS.includes(program)) bad('must be run by npm: only npm test and npm run <script> can be the check.');
  // npm only: `npm test`, or `npm run <script>`. An option of npm's own
  // (--prefix, --script-shell, …) could change which script or shell runs,
  // so words that start with "-" are taken only after "--", where npm hands
  // them to the script.
  const named = tokens[1] === 'run' ? 3 : 2;
  if (!NPM_COMMANDS.includes(tokens[1]) || (tokens[1] === 'run' && (!tokens[2] || tokens[2].startsWith('-')))) {
    bad('must be npm test or npm run <script>.');
  }
  const rest = tokens.slice(named);
  const split = rest.indexOf('--');
  if ((split === -1 ? rest : rest.slice(0, split)).some((t) => t.startsWith('-'))) {
    bad('may give options only after "--", where npm passes them to the script.');
  }
  return command;
}

const checkArgv = (command) => validateCheck(command).split(' ');

// What an approval covers: these exact words in this exact place.
function checkHash(argv, repo) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({ argv, repo })).digest('hex')}`;
}

// Whether `text` holds `command` as one contiguous run, compared exactly
// (case kept, single spaces), with the string's edge, white space, a quote
// mark or a backtick on both sides.
const EDGE = /[\s"'`‘’“”]/;
function holdsCommand(command, text) {
  if (typeof text !== 'string' || !command) return false;
  for (let at = text.indexOf(command); at !== -1; at = text.indexOf(command, at + 1)) {
    const before = at === 0 ? '' : text[at - 1];
    const after = at + command.length >= text.length ? '' : text[at + command.length];
    if ((before === '' || EDGE.test(before)) && (after === '' || EDGE.test(after))) return true;
  }
  return false;
}

// The `repo` rule made stricter (ruling T9-repo): the whole command, never
// words gathered from across the message, in the quote the model gave and
// in the owner's own message.
function checkInQuote(command, quote, ownerMessage) {
  return typeof command === 'string' && holdsCommand(command, quote) && holdsCommand(command, ownerMessage);
}

const emptyFile = () => ({ version: 1, approved: [], nextRun: 1, runs: [] });
const runId = (n) => `chk-${String(n).padStart(4, '0')}`;

// .kl/checks.json (spec §7.4): the approvals and the newest 20 runs. No
// output of a run is ever in it. Written only by code, under the case lock.
class CheckStore {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'checks.json');
    this.now = now;
  }

  // The file, or the empty shape. A part of the wrong kind reads as empty;
  // an approval that is not a hash over an argv is not one. Never writes.
  read() {
    let raw = null;
    try {
      raw = readJson(this.file, null);
    } catch (err) {
      log.warn(`${this.file} cannot be read (${err.message}); reading it as empty.`);
    }
    if (!isObject(raw)) return emptyFile();
    const approved = (Array.isArray(raw.approved) ? raw.approved : []).filter((a) => isObject(a)
      && typeof a.hash === 'string' && HASH.test(a.hash)
      && Array.isArray(a.argv) && a.argv.length > 0 && a.argv.every((t) => typeof t === 'string'));
    const runs = (Array.isArray(raw.runs) ? raw.runs : []).filter((r) => isObject(r) && RUN_ID.test(String(r.id || '')));
    let nextRun = Number.isInteger(raw.nextRun) && raw.nextRun > 0 ? raw.nextRun : 1;
    for (const r of runs) nextRun = Math.max(nextRun, Number(RUN_ID.exec(r.id)[1]) + 1);
    return { version: 1, approved, nextRun, runs };
  }

  approve({ argv, repo, by = 'question', ref = null, channel = null } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some((t) => typeof t !== 'string' || !t) || typeof repo !== 'string' || !repo) {
      throw new Error('An approval names the argv and the repository it covers.');
    }
    const file = this.read();
    const hash = checkHash(argv, repo);
    const existing = file.approved.find((a) => a.hash === hash);
    if (existing) return existing;
    const entry = { hash, argv: [...argv], at: this.now().toISOString(), by: String(by), ref: strOrNull(ref), channel: strOrNull(channel) };
    file.approved.push(entry);
    writeJson(this.file, file);
    return entry;
  }

  // → how many approvals were removed. The runs are kept.
  withdrawAll() {
    const file = this.read();
    const n = file.approved.length;
    if (n) writeJson(this.file, { ...file, approved: [] });
    return n;
  }

  isApproved(argv, repo) {
    if (!Array.isArray(argv) || typeof repo !== 'string' || !repo) return false;
    const hash = checkHash(argv, repo);
    return this.read().approved.some((a) => a.hash === hash);
  }

  // Records a run under the next id. Only these fields are kept: the
  // output's tail is never given a place here.
  addRun({ hash = null, head = null, dirty = null, result, exitCode = null, timedOut = false, ms = 0, turnId = null } = {}) {
    if (!RESULTS.includes(result)) throw new Error(`A run's result is one of ${RESULTS.join(', ')}.`);
    const file = this.read();
    const run = {
      id: runId(file.nextRun),
      hash: strOrNull(hash),
      head: strOrNull(head),
      dirty: Number.isInteger(dirty) ? dirty : null,
      result,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      timedOut: timedOut === true,
      ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
      turnId: strOrNull(turnId),
      at: this.now().toISOString()
    };
    file.nextRun += 1;
    file.runs = [...file.runs, run].slice(-KEEP_RUNS);
    writeJson(this.file, file);
    return run;
  }

  newestRun() {
    const { runs } = this.read();
    return runs.length ? runs[runs.length - 1] : null;
  }

  // The newest run at this head with this many uncommitted changes, or null.
  runFor({ head = null, dirty = null } = {}) {
    if (typeof head !== 'string' || !head || !Number.isInteger(dirty)) return null;
    const { runs } = this.read();
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (runs[i].head === head && runs[i].dirty === dirty) return runs[i];
    }
    return null;
  }
}

// Runtimes that were already told a data-dir setting is ignored.
const warnedService = new WeakSet();

// → { enabled, reason }. Off unless the setting is exactly true. In service
// mode the setting is the administrator's (`caseChecks.enabled` of the
// admin service.json, handed in as host.caseChecks); what the data dir says
// is ignored there, with one warning.
function checkPolicy(runtime) {
  let fromSettings = false;
  try {
    fromSettings = runtime.settings().softwareRepo?.check?.enabled === true;
  } catch (err) {
    log.warn(`The check setting could not be read (${err?.message || err}); checks are off.`);
  }
  const host = isObject(runtime?.host?.caseChecks) ? runtime.host.caseChecks : null;
  if (host && host.isService === true) {
    if (fromSettings && isObject(runtime) && !warnedService.has(runtime)) {
      warnedService.add(runtime);
      log.warn('Ignoring cases.softwareRepo.check.enabled from the data dir in service mode; set "caseChecks": { "enabled": true } in the admin service.json instead.');
    }
    return host.enabled === true ? { enabled: true, reason: null } : { enabled: false, reason: 'CHECK_SERVICE_OFF' };
  }
  return fromSettings ? { enabled: true, reason: null } : { enabled: false, reason: 'CHECK_DISABLED' };
}

// What will be started for `argv`, with no shell: → { file, args }. Throws
// CheckError CHECK_SHIM (only a .cmd or .bat exists, which needs cmd.exe)
// or CHECK_NOT_FOUND. `cwd` is the repository: a bare name is looked up on
// PATH only, never in the repository itself, where Windows would look
// first. npm on Windows is a .cmd shim; it is started as the shim itself
// starts it, node.exe with npm-cli.js. No branch returns cmd.exe.
function resolveProgram(argv, { platform = process.platform, env = process.env, cwd = process.cwd(), fsCheck = undefined } = {}) {
  const { resolveCommand } = require('../../service/doctor-runbooks');
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = String(argv[0]);
  const bare = !/[\\/]/.test(name);
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const here = fold(p.resolve(cwd));
  const outside = (file) => fold(p.resolve(p.dirname(file))) !== here;
  const base = fsCheck || { isFile: (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }, isExecutable: (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } } };
  // For a bare name, a file in the repository's own directory does not exist.
  const offCwd = { isFile: (f) => outside(f) && base.isFile(f), isExecutable: (f) => outside(f) && base.isExecutable(f) };
  const find = (n) => resolveCommand(n, { platform, env, cwd, fsCheck: /[\\/]/.test(n) ? base : offCwd });
  const found = find(name);
  if (found.path) return { file: found.path, args: argv.slice(1) };
  if (found.cmdShim) {
    if (platform === 'win32' && bare && name === 'npm') {
      const node = find('node');
      const cli = node.path ? p.join(p.dirname(node.path), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;
      if (cli && base.isFile(cli)) return { file: node.path, args: [cli, ...argv.slice(1)] };
    }
    throw new CheckError('CHECK_SHIM', `${name} exists here only as a .cmd or .bat file, which cannot be started without cmd.exe. King Louie never runs a check through a shell.`);
  }
  throw new CheckError('CHECK_NOT_FOUND', `${name} was not found on PATH.`);
}

// The case's check as its brief has it now: → { command, argv, repo, key,
// hash }, or null when no command is set. `repo` is the local path and
// `key` its real path (what an approval is bound to). Throws CheckError
// CHECK_INVALID for a stored command that no longer validates and
// CHECK_NO_LOCAL_REPO when the brief's repo is missing, a clone URL or a
// path that is not there. `command` is given to judge one not yet stored.
function currentCheck(runtime, caseId, { command = undefined } = {}) {
  const meta = runtime.getCase(caseId);
  if (meta.type !== CASE_TYPE) throw new CheckError('CHECK_NOT_SOFTWARE_REPO', 'Only a software-repo case has a check command.');
  const data = runtime.brief(meta.id).read().data || {};
  const wanted = command === undefined ? data.check : command;
  if (command === undefined && (typeof wanted !== 'string' || !wanted.trim())) return null;
  const argv = checkArgv(wanted);
  const raw = typeof data.repo === 'string' ? data.repo.trim() : '';
  const noRepo = (why) => new CheckError('CHECK_NO_LOCAL_REPO', `A check runs only in a repository on this machine; ${why}`);
  if (!raw) throw noRepo("this case's brief has no repo.");
  if (isCloneUrl(raw)) throw noRepo("this case's repo is a clone URL.");
  const repo = expandHome(raw);
  let isDir = false;
  try {
    isDir = path.isAbsolute(repo) && fs.statSync(repo).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw noRepo("the folder this case's repo names is not there.");
  // The path is shown on the approval card, which is never cut or flattened.
  if (plainLineProblem(repo)) throw noRepo("the path of this case's repo cannot be shown on one plain line.");
  const key = pathKey(repo);
  return { command: argv.join(' '), argv, repo, key, hash: checkHash(argv, key) };
}

// What the panel shows of the check (IPC case:progress): null for a case
// that is not a software-repo one, else { enabled, reason, command,
// approved, lastRun }. `lastRun` is an id, a result and where it ran; never
// output. Reads only, and never throws.
function checkView(runtime, caseId) {
  try {
    const meta = runtime.getCase(caseId);
    if (meta.type !== CASE_TYPE) return null;
    const policy = checkPolicy(runtime);
    const out = { enabled: policy.enabled, reason: policy.reason, command: null, approved: false, lastRun: null };
    const stored = runtime.brief(meta.id).read().data?.check;
    if (typeof stored === 'string' && stored.trim()) out.command = stored.trim();
    const store = new CheckStore(meta.dir, { now: () => runtime.now() });
    try {
      const current = currentCheck(runtime, meta.id);
      if (current) {
        out.command = current.command;
        out.approved = store.isApproved(current.argv, current.key);
      }
    } catch (err) {
      // A command or a repository that no longer holds: shown, not approved.
      if (!(err instanceof CheckError)) throw err;
    }
    const run = store.newestRun();
    if (run) {
      out.lastRun = {
        id: run.id,
        result: RESULTS.includes(run.result) ? run.result : null,
        head: strOrNull(run.head),
        dirty: Number.isInteger(run.dirty) ? run.dirty : null,
        at: strOrNull(run.at)
      };
    }
    return out;
  } catch (err) {
    log.warn(`The check of case ${caseId} could not be read: ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  CHECK_TYPE, ALLOWED_PROGRAMS, REFUSED_PROGRAMS, POLICY_OFF, CheckError, CheckStore,
  validateCheck, checkArgv, checkHash, checkInQuote, checkPolicy, resolveProgram, currentCheck, checkView
};
