// tests/cases-check.test.js
// Cases stage 8 (spec §6.6, §7.4; R-C8-3): the check command of a
// software-repo case. Naming it and approving it (plan Task 15), then
// running it at the close of an owner turn (Task 16). Off by default, npm
// only, never through a shell. No network and no model.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CaseRuntime } = require('../src/cases');
const { initializeTools } = require('../src/tools');
const { BriefTool } = require('../src/tools/builtin/case-tools');
const { answerClass } = require('../src/cases/mcp-tool-definitions');
const {
  validateCheck, checkArgv, checkHash, checkInQuote, CheckStore, checkPolicy, resolveProgram,
  REFUSED_PROGRAMS, ALLOWED_PROGRAMS, CHECK_TYPE
} = require('../src/cases/verify/check');
const { checkQuestionText } = require('../src/cases/verify/questions');
const { CASE_SETTINGS_DEFAULTS, resolveCaseSettings } = require('../src/cases/defaults');
const { addSink, setLogLevel } = require('../src/logging');

setLogLevel('warn');
initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const tmp = (prefix = 'kl-check-') => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const invalid = (value, reason) => assert.throws(() => validateCheck(value), (err) => {
  assert.strictEqual(err.code, 'CHECK_INVALID', JSON.stringify(value));
  if (reason) assert.match(err.message, reason, JSON.stringify(value));
  return true;
});
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

// A git repository with one commit and a package.json whose `test` script
// runs `node <script>`.
function repoDir(script = 'pass.js') {
  const dir = tmp('kl-check-repo-');
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'lakeside-site', version: '1.0.0', private: true, scripts: { test: `node ${script}` } }, null, 2)}\n`);
  const fixtures = path.join(__dirname, 'fixtures', 'cases', 'check');
  for (const name of fs.existsSync(fixtures) ? fs.readdirSync(fixtures) : []) fs.copyFileSync(path.join(fixtures, name), path.join(dir, name));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

// An active software-repo case on `repo`, with one confirmed criterion.
// `check`: the cases.softwareRepo.check setting; `host`: host.caseChecks.
async function world({ check = { enabled: true }, caseChecks = undefined, type = 'software-repo', repo = undefined, script = 'pass.js' } = {}) {
  const clock = { now: new Date('2026-10-21T09:00:00.000Z') };
  const local = repo === undefined ? repoDir(script) : repo;
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases: { timeZone: 'UTC', verify: { when: 'off' }, softwareRepo: { check } } }),
    host: { notify: () => {}, ...(caseChecks ? { caseChecks } : {}) }
  });
  const info = await rt.createCase({ title: 'Lakeside lot site', type, objective: 'Ship the Lakeside lot site', objectiveBy: 'owner' });
  const id = info.id;
  rt.brief(id).update('why', 'The listing goes live in spring', { provenance: 'user' });
  if (type === 'software-repo' && local) rt.brief(id).update('repo', local, { provenance: 'user' });
  await rt.applyScopeAction(id, { action: 'add', text: 'The test suite passes', by: 'owner-action' });
  // A software-repo case with no repo stays a draft (its gating asks for one).
  if (type !== 'software-repo' || local) rt.completeGating(id);
  await rt.systemAction(id, 'fixture', async () => {});
  const open =() => rt.questions(id).open().filter((q) => q.payload?.type === CHECK_TYPE);
  // The Brief tool in an owner turn whose message is `said`.
  const brief = async (params, said) => {
    clock.now = new Date(clock.now.getTime() + 60000);
    const turn = await rt.beginTurn(id, { turnId: `turn-${clock.now.getTime()}` });
    try {
      return await BriefTool.execute(params, { caseContext: rt.caseContext(turn, { ownerMessages: [said] }) });
    } finally {
      await rt.endTurn(turn, { summary: 'brief' });
    }
  };
  return { rt, id, dir: info.dir, repo: local, clock, open, brief };
}

describe('validateCheck: what may be named', () => {
  it('accepts npm test and npm run <script>, with arguments for the script after --', () => {
    for (const ok of ['npm test', 'npm run test:unit', 'npm run check', 'npm test -- --runInBand', 'npm run test:unit -- tests/unit --bail=1']) {
      assert.strictEqual(validateCheck(ok), ok);
    }
    assert.strictEqual(validateCheck('  npm test  '), 'npm test');
    assert.deepStrictEqual(checkArgv('npm run test:unit'), ['npm', 'run', 'test:unit']);
    assert.deepStrictEqual(ALLOWED_PROGRAMS, ['npm']);
  });

  it('refuses any program but npm (owner ruling: npm only)', () => {
    for (const other of ['node --test tests/unit', './gradlew test', 'cargo test --locked', 'make check', 'pnpm test', 'yarn test', 'NPM test', 'npm.cmd test', 'npm.exe test', './npm test']) {
      invalid(other, /only npm/);
    }
  });

  it('refuses every npm command but test and run, and any npm option of its own', () => {
    for (const other of ['npm', 'npm install', 'npm exec -- curl example.com', 'npm x cowsay', 'npm publish', 'npm run', 'npm run -s', 'npm start']) {
      invalid(other, /npm test|npm run/);
    }
    // An npm option could change which script or shell runs.
    for (const opt of ['npm test --prefix=x', 'npm test --script-shell=x', 'npm run check --if-present', 'npm test -s']) invalid(opt, /after "--"/);
    invalid('npm --prefix x test', /npm test|npm run/);
  });

  it('refuses the empty string, more than 12 tokens, more than 200 characters and a double space', () => {
    invalid('', /1 to 200/);
    invalid('   ', /1 to 200/);
    invalid(42, /text/);
    invalid(`npm test -- ${Array.from({ length: 10 }, (_, i) => `a${i}`).join(' ')}`, /12/);
    invalid(`npm test -- ${'a'.repeat(200)}`, /1 to 200/);
    invalid('npm  test', /single spaces/);
    invalid('npm\ttest', /single spaces|characters/);
  });

  it('refuses every character a shell gives meaning to', () => {
    for (const ch of [';', '&', '|', '<', '>', '$', '`', '(', ')', '*', '?', '~', '!', '%', '^', '\\', '"', "'", '\n', '\r', '#', '{', '}', '[', ']']) {
      invalid(`npm test -- a${ch}b`, /characters/);
      invalid(`npm run te${ch}st`, /characters/);
    }
  });

  it('refuses an assignment, a leading dash, a path that leaves the repository and an absolute path as the program', () => {
    invalid('FOO=1 npm test', /assignment/);
    invalid('-rf x', /"-"/);
    invalid('../x/run test', /\.\./);
    invalid('/usr/bin/npm test', /absolute/);
    invalid('C:/tools/npm test', /absolute/);
  });

  it('refuses a shell or a download-and-run tool by name, with .exe and in upper case', () => {
    assert.ok(REFUSED_PROGRAMS.includes('sh') && REFUSED_PROGRAMS.includes('npx') && REFUSED_PROGRAMS.includes('xargs'));
    for (const name of REFUSED_PROGRAMS) {
      for (const spelled of [name, `${name}.exe`, name.toUpperCase(), `./bin/${name}`]) invalid(`${spelled} test`, /may not be the check/);
    }
  });

  it('refuses the flags that hand a program code, alone or with =value, anywhere', () => {
    for (const flag of ['-c', '-e', '--eval', '-p', '--print', '--exec']) {
      invalid(`npm test -- ${flag}`, /code on its command line/);
      invalid(`npm test -- ${flag}=1`, /code on its command line/);
    }
    invalid('node -e 1', /code on its command line|only npm/);
    invalid('node --eval=1', /code on its command line|only npm/);
  });
});

describe('checkInQuote: the owner said the whole command', () => {
  it('finds it in backticks, in quotes, between spaces and at either edge', () => {
    for (const said of ['Use `npm test` as the check.', 'The check is "npm test" please', "run 'npm test' at the end", 'the check is npm test and nothing else', 'npm test', 'please run npm test']) {
      assert.strictEqual(checkInQuote('npm test', said, said), true, said);
    }
  });

  it('refuses another case, a missing word, tokens spread across the message, a prefix of a longer command and a reworded quote', () => {
    assert.strictEqual(checkInQuote('npm test', 'NPM TEST', 'NPM TEST'), false);
    assert.strictEqual(checkInQuote('npm run check', 'npm check', 'npm check'), false);
    assert.strictEqual(checkInQuote('npm test', 'use npm to run the test', 'use npm to run the test'), false);
    assert.strictEqual(checkInQuote('npm test', 'run npm test:all', 'run npm test:all'), false);
    assert.strictEqual(checkInQuote('npm test', 'run npm test.', 'run npm test.'), false);
    assert.strictEqual(checkInQuote('npm test', 'run npm  test', 'run npm  test'), false);
    // In the quote the model gave but not in the owner's own message, and the other way.
    assert.strictEqual(checkInQuote('npm test', 'run npm test', 'run the tests'), false);
    assert.strictEqual(checkInQuote('npm test', 'run the tests', 'run npm test'), false);
    assert.strictEqual(checkInQuote('npm test', null, undefined), false);
  });
});

describe('CheckStore: .kl/checks.json', () => {
  const store = () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.kl'));
    return new CheckStore(dir, { now: () => new Date('2026-10-21T09:00:00.000Z') });
  };

  it('an approval covers one command and one repository', () => {
    const s = store();
    assert.deepStrictEqual(s.read(), { version: 1, approved: [], nextRun: 1, runs: [] });
    const entry = s.approve({ argv: ['npm', 'test'], repo: '/work/lakeside-site', by: 'question', ref: 'q-0009', channel: 'in-app' });
    assert.deepStrictEqual(entry, {
      hash: checkHash(['npm', 'test'], '/work/lakeside-site'), argv: ['npm', 'test'], at: '2026-10-21T09:00:00.000Z', by: 'question', ref: 'q-0009', channel: 'in-app'
    });
    assert.match(entry.hash, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(s.isApproved(['npm', 'test'], '/work/lakeside-site'), true);
    assert.strictEqual(s.isApproved(['npm', 'run', 'test'], '/work/lakeside-site'), false);
    assert.strictEqual(s.isApproved(['npm', 'test', '--', 'x'], '/work/lakeside-site'), false);
    assert.strictEqual(s.isApproved(['npm', 'test'], '/work/other-site'), false);
    // The same approval again is one entry.
    s.approve({ argv: ['npm', 'test'], repo: '/work/lakeside-site', by: 'question', ref: 'q-0010', channel: 'mobile' });
    assert.strictEqual(s.read().approved.length, 1);
  });

  it('withdrawAll removes every approval and keeps the runs', () => {
    const s = store();
    s.approve({ argv: ['npm', 'test'], repo: '/work/lakeside-site', by: 'question', ref: 'q-0009', channel: 'in-app' });
    s.addRun({ hash: 'sha256:x', head: 'abc', dirty: 0, result: 'pass', exitCode: 0, timedOut: false, ms: 10, turnId: 'turn-1' });
    assert.strictEqual(s.withdrawAll(), 1);
    assert.strictEqual(s.isApproved(['npm', 'test'], '/work/lakeside-site'), false);
    assert.strictEqual(s.read().runs.length, 1);
    assert.strictEqual(s.withdrawAll(), 0);
  });

  it('runs get ids that count up, the newest 20 are kept, and a run holds no output', () => {
    const s = store();
    for (let i = 1; i <= 23; i += 1) {
      const run = s.addRun({ hash: 'sha256:x', head: `head-${i % 2}`, dirty: i % 3, result: i % 2 ? 'pass' : 'fail', exitCode: i % 2 ? 0 : 1, timedOut: false, ms: i, turnId: `turn-${i}`, tail: 'SECRET-CANARY', output: 'SECRET-CANARY' });
      assert.strictEqual(run.id, `chk-${String(i).padStart(4, '0')}`);
    }
    const file = s.read();
    assert.strictEqual(file.runs.length, 20);
    assert.strictEqual(file.nextRun, 24);
    assert.deepStrictEqual([file.runs[0].id, file.runs[19].id], ['chk-0004', 'chk-0023']);
    assert.strictEqual(s.newestRun().id, 'chk-0023');
    assert.deepStrictEqual(Object.keys(s.newestRun()).sort(), ['at', 'dirty', 'exitCode', 'hash', 'head', 'id', 'ms', 'result', 'timedOut', 'turnId']);
    assert.doesNotMatch(fs.readFileSync(s.file, 'utf8'), /CANARY/);
    // The newest run at a head and a dirty count.
    assert.strictEqual(s.runFor({ head: 'head-1', dirty: 2 }).id, 'chk-0023');
    assert.strictEqual(s.runFor({ head: 'head-0', dirty: 1 }).id, 'chk-0022');
    assert.strictEqual(s.runFor({ head: 'head-9', dirty: 0 }), null);
    assert.strictEqual(s.runFor({ head: null, dirty: 0 }), null);
  });

  it('a file that is not a checks file reads as empty, and an approval with a wrong shape is not one', () => {
    const s = store();
    fs.writeFileSync(s.file, '{ not json');
    assert.deepStrictEqual(s.read(), { version: 1, approved: [], nextRun: 1, runs: [] });
    fs.writeFileSync(s.file, JSON.stringify({ approved: [{ hash: 'yes', argv: ['npm', 'test'] }, 'all'], runs: [{ id: 'nope' }, { id: 'chk-0007', result: 'pass' }] }));
    assert.strictEqual(s.read().approved.length, 0);
    assert.deepStrictEqual(s.read().runs.map((r) => r.id), ['chk-0007']);
    assert.strictEqual(s.read().nextRun, 8);
  });
});

describe('checkPolicy: off until it is turned on', () => {
  const runtimeWith = (check, caseChecks) => ({ settings: () => resolveCaseSettings({ softwareRepo: { check } }), host: caseChecks ? { caseChecks } : {} });

  it('nothing runs while the setting is off', () => {
    assert.deepStrictEqual(CASE_SETTINGS_DEFAULTS.softwareRepo.check, { enabled: false, timeoutMs: 120000, envAllow: [] });
    assert.deepStrictEqual(checkPolicy(runtimeWith(undefined)), { enabled: false, reason: 'CHECK_DISABLED' });
    assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: 'yes' })), { enabled: false, reason: 'CHECK_DISABLED' });
    assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: 1 })), { enabled: false, reason: 'CHECK_DISABLED' });
    assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: true })), { enabled: true, reason: null });
    assert.deepStrictEqual(checkPolicy({ settings: () => { throw new Error('unreadable'); }, host: {} }), { enabled: false, reason: 'CHECK_DISABLED' });
  });

  it('the settings keep their bounds: the time limit is at most 900 s and envAllow is names only', () => {
    const c = (check) => resolveCaseSettings({ softwareRepo: { check } }).softwareRepo.check;
    assert.strictEqual(c({ timeoutMs: 5000 }).timeoutMs, 5000);
    assert.strictEqual(c({ timeoutMs: 9000000 }).timeoutMs, 900000);
    assert.strictEqual(c({ timeoutMs: -1 }).timeoutMs, 120000);
    assert.deepStrictEqual(c({ envAllow: ['NODE_ENV', 'bad name', 7, 'A=B', 'ELECTRON_RUN_AS_NODE', 'KL_CASES_ROOT', 'TZ'] }).envAllow, ['NODE_ENV', 'TZ']);
    assert.deepStrictEqual(c({ envAllow: 'NODE_ENV' }).envAllow, []);
    // A partial override keeps the other defaults, and the refresh budget beside it.
    assert.deepStrictEqual(resolveCaseSettings({ softwareRepo: { check: { enabled: true } } }).softwareRepo, { refreshBudgetMs: 6000, check: { enabled: true, timeoutMs: 120000, envAllow: [] } });
  });

  it('service mode needs the admin key', () => {
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      const off = runtimeWith({ enabled: true }, { isService: true, enabled: false });
      assert.deepStrictEqual(checkPolicy(off), { enabled: false, reason: 'CHECK_SERVICE_OFF' });
      assert.deepStrictEqual(checkPolicy(off), { enabled: false, reason: 'CHECK_SERVICE_OFF' });
      assert.strictEqual(warnings.filter((m) => /cases\.softwareRepo\.check\.enabled/.test(m)).length, 1, 'one warning');
      assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: true }, { isService: true, enabled: 'true' })), { enabled: false, reason: 'CHECK_SERVICE_OFF' });
      assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: false }, { isService: true, enabled: true })), { enabled: true, reason: null });
      // Not a service: the host block decides nothing.
      assert.deepStrictEqual(checkPolicy(runtimeWith({ enabled: false }, { isService: false, enabled: true })), { enabled: false, reason: 'CHECK_DISABLED' });
    } finally {
      remove();
    }
  });
});

describe('resolveProgram: what is started, never a shell', () => {
  const fsWith = (files) => {
    // The lookup joins with the host's own separator: compare with one kind.
    const one = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    const set = new Set(files.map(one));
    const has = (p) => set.has(one(p));
    return { isFile: has, isExecutable: has };
  };
  const back = (r) => ({ file: r.file.replace(/\//g, '\\'), args: r.args.map((a) => a.replace(/\//g, '\\')) });
  const win = (files, argv) => back(resolveProgram(argv, { platform: 'win32', env: { Path: 'C:\\tools;C:\\nodejs' }, cwd: 'C:\\work\\site', fsCheck: fsWith(files) }));
  const code = (fn, expected) => assert.throws(fn, (err) => err.code === expected);

  it('on Windows an .exe on PATH resolves and any shim but npm is refused', () => {
    assert.deepStrictEqual(win(['C:\\tools\\cargo.exe'], ['cargo', 'test']), { file: 'C:\\tools\\cargo.exe', args: ['test'] });
    code(() => win(['C:\\tools\\pnpm.cmd'], ['pnpm', 'test']), 'CHECK_SHIM');
    code(() => win(['C:\\tools\\gradlew.bat'], ['gradlew', 'test']), 'CHECK_SHIM');
    code(() => win([], ['cargo', 'test']), 'CHECK_NOT_FOUND');
  });

  it('npm on Windows is node.exe with npm-cli.js, and is refused like any shim without that file', () => {
    const files = ['C:\\nodejs\\npm.cmd', 'C:\\nodejs\\node.exe', 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'];
    assert.deepStrictEqual(win(files, ['npm', 'run', 'test:unit']), {
      file: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'test:unit']
    });
    code(() => win(files.slice(0, 2), ['npm', 'test']), 'CHECK_SHIM');
    code(() => win([files[0], files[2]], ['npm', 'test']), 'CHECK_SHIM');
    for (const r of [win(files, ['npm', 'test']), win(['C:\\tools\\cargo.exe'], ['cargo', 'test'])]) {
      assert.doesNotMatch(r.file, /cmd\.exe$/i);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'shell'), false);
    }
  });

  it('a program found only in the repository itself is not taken for one on PATH', () => {
    code(() => win(['C:\\work\\site\\npm.exe'], ['npm', 'test']), 'CHECK_NOT_FOUND');
    code(() => win(['C:\\work\\site\\node.exe', 'C:\\nodejs\\npm.cmd', 'C:\\work\\site\\node_modules\\npm\\bin\\npm-cli.js'], ['npm', 'test']), 'CHECK_SHIM');
  });

  it('elsewhere a PATH hit resolves', () => {
    const r = resolveProgram(['npm', 'test'], { platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, cwd: '/work/site', fsCheck: fsWith(['/usr/bin/npm']) });
    assert.deepStrictEqual({ file: r.file.replace(/\\/g, '/'), args: r.args }, { file: '/usr/bin/npm', args: ['test'] });
    code(() => resolveProgram(['npm', 'test'], { platform: 'linux', env: { PATH: '/usr/bin' }, cwd: '/work/site', fsCheck: fsWith([]) }), 'CHECK_NOT_FOUND');
  });
});

describe('naming the check with the Brief tool, and the owner\'s approval', () => {
  it('a quote holding the exact command writes the field and asks one pressed question; nothing is approved yet', async () => {
    const w = await world();
    const said = 'Use `npm test` as the check for this repository.';
    const r = await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use `npm test` as the check' }, said);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(w.rt.brief(w.id).read().data.check, 'npm test');
    const [q] = w.open();
    assert.strictEqual(w.open().length, 1);
    assert.strictEqual(r.questionId, q.id);
    assert.strictEqual(answerClass(q), 'pressed');
    assert.deepStrictEqual(q.options.map((o) => [o.id, o.label]), [['approve', 'Approve'], ['refuse', 'Do not run']]);
    assert.deepStrictEqual([q.payload.mcpAnswerable, q.payload.disclosable, q.payload.key], [false, false, 'check-approve']);
    assert.match(q.payload.hash, /^sha256:[0-9a-f]{64}$/);
    // Host lines first, the program and the arguments each on a line of their own, the case's title last.
    const lines = q.text.split('\n');
    assert.strictEqual(lines[0], 'Run a check command in this case\'s repository?');
    assert.ok(lines.includes('Program: npm'));
    assert.ok(lines.includes('Arguments: test'));
    assert.ok(lines.includes(`Runs in: ${w.repo}`));
    assert.ok(lines.some((l) => /^When: at the end of a turn you started/.test(l) && /Never while you are away\.$/.test(l)));
    assert.ok(lines.some((l) => /King Louie cannot make it read-only\.$/.test(l)));
    assert.strictEqual(lines[lines.length - 1], 'Case: Lakeside lot site');
    assert.strictEqual(q.text, checkQuestionText({ title: 'Lakeside lot site' }, { argv: ['npm', 'test'], repo: w.repo }));
    // Not charged to the day's questions, and nothing is approved.
    assert.strictEqual(w.rt.budget(w.id).status().questionsPerDay.spent || 0, 0);
    assert.strictEqual(w.rt.checks(w.id).read().approved.length, 0);
  });

  it('is refused when the quote rewords the command, for the model, on a general case, for a clone URL, and while the setting is off', async () => {
    const w = await world();
    const reworded = await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'run the npm tests at the end' }, 'Please run the npm tests at the end.');
    assert.deepStrictEqual([reworded.ok, reworded.code], [false, 'CHECK_NOT_IN_QUOTE']);
    const model = await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'model' }, 'Use npm test as the check.');
    assert.strictEqual(model.ok, false);
    assert.match(model.error, /"check" can only be set from something the owner said/);
    const bad = await w.brief({ action: 'update', field: 'check', value: 'make check', provenance: 'user', quote: 'Use make check as the check' }, 'Use make check as the check.');
    assert.deepStrictEqual([bad.ok, bad.code], [false, 'CHECK_INVALID']);
    const appended = await w.brief({ action: 'append', field: 'check', item: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.strictEqual(appended.ok, false);
    assert.strictEqual(w.rt.brief(w.id).read().data.check, undefined);
    assert.strictEqual(w.open().length, 0);

    const general = await world({ type: 'general' });
    const g = await general.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.strictEqual(g.ok, false);
    assert.match(g.error, /only for software-repo cases/);

    const remote = await world({ repo: 'https://git.example.com/lakeside/site.git' });
    const u = await remote.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.deepStrictEqual([u.ok, u.code], [false, 'CHECK_NO_LOCAL_REPO']);
    const none = await world({ repo: null });
    const n = await none.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.deepStrictEqual([n.ok, n.code], [false, 'CHECK_NO_LOCAL_REPO']);

    const off = await world({ check: { enabled: false } });
    const o = await off.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.deepStrictEqual([o.ok, o.code], [false, 'CHECK_DISABLED']);
    assert.strictEqual(off.rt.brief(off.id).read().data.check, undefined);
    assert.strictEqual(off.open().length, 0);
  });

  it('Approve pressed in the app or on the phone records it; words in the chat and MCP do not', async () => {
    for (const [channel, approved] of [['in-app', true], ['mobile', true], ['in-app-chat', false], ['mcp-stdio', false], ['mcp-frontdoor', false], ['telegram', false]]) {
      const w = await world();
      await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
      const [q] = w.open();
      await w.rt.answerQuestion(w.id, q.id, { channel, optionId: 'approve', quote: channel === 'in-app-chat' ? 'yes approve that check' : null });
      const store = w.rt.checks(w.id);
      assert.strictEqual(store.isApproved(['npm', 'test'], require('../src/cases/case-types/software-repo').pathKey(w.repo)), approved, channel);
      if (approved) {
        const [entry] = store.read().approved;
        assert.deepStrictEqual([entry.by, entry.ref, entry.channel, entry.argv], ['question', q.id, channel, ['npm', 'test']]);
      } else {
        assert.strictEqual(store.read().approved.length, 0, channel);
        assert.match(w.rt.questions(w.id).get(q.id).notes.map((n) => n.text || n).join(' '), /only by the button/, channel);
      }
    }
  });

  it('"Do not run" records nothing, and an approval covers one command and one repository', async () => {
    const w = await world();
    await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    await w.rt.answerQuestion(w.id, w.open()[0].id, { channel: 'in-app', optionId: 'refuse' });
    assert.strictEqual(w.rt.checks(w.id).read().approved.length, 0);
    assert.strictEqual(w.open().length, 0);

    // Asked for one command; the command is changed in brief.md before the press.
    await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    const first = w.open()[0];
    await w.rt.systemAction(w.id, 'edit', () => { w.rt.brief(w.id).update('check', 'npm run check', { provenance: 'user' }); });
    await w.rt.answerQuestion(w.id, first.id, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual(w.rt.checks(w.id).read().approved.length, 0, 'the new command was not approved by the old question');
    // A fresh question asks about what is there now.
    const [fresh] = w.open();
    assert.notStrictEqual(fresh.id, first.id);
    assert.ok(fresh.text.split('\n').includes('Arguments: run check'));
    await w.rt.answerQuestion(w.id, fresh.id, { channel: 'in-app', optionId: 'approve' });
    const { pathKey } = require('../src/cases/case-types/software-repo');
    assert.strictEqual(w.rt.checks(w.id).isApproved(['npm', 'run', 'check'], pathKey(w.repo)), true);
    assert.strictEqual(w.rt.checks(w.id).isApproved(['npm', 'test'], pathKey(w.repo)), false);

    // Naming another command withdraws the approval and asks again; the old question is closed.
    const again = await w.brief({ action: 'update', field: 'check', value: 'npm test', provenance: 'user', quote: 'Use npm test as the check' }, 'Use npm test as the check.');
    assert.strictEqual(again.ok, true, again.error);
    assert.strictEqual(w.rt.checks(w.id).read().approved.length, 0);
    assert.strictEqual(w.open().length, 1);
    // The repository moves: the approval of the old place does not cover the new one.
    await w.rt.answerQuestion(w.id, w.open()[0].id, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual(w.rt.checks(w.id).isApproved(['npm', 'test'], pathKey(w.repo)), true);
    assert.strictEqual(w.rt.checks(w.id).isApproved(['npm', 'test'], pathKey(repoDir())), false);
  });
});
