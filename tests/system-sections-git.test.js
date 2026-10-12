// tests/system-sections-git.test.js
// The git context of the system sections is read with awaited child
// processes. It used to be five execSync calls in the indexing task that
// createCore's start() fires and forgets: the whole process stood still for
// five git runs at some moment after start() had returned, which made a
// per-turn rerank miss its maxMs and shutdown() overrun shutdownTimeoutMs
// whenever the machine was busy (the full suite in parallel).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSystemSections, readGitContext } = require('../src/context/system-sections');

// An execFile whose git answers arrive only when the test releases them.
function fakeGit(answers) {
  const calls = [];
  const pending = [];
  const exec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    pending.push(() => {
      const key = args.join(' ');
      const answer = Object.prototype.hasOwnProperty.call(answers, key) ? answers[key] : new Error(`no answer for git ${key}`);
      if (answer instanceof Error) callback(answer, '', '');
      else callback(null, `${answer}\n`, '');
    });
  };
  const releaseOne = () => pending.shift()();
  return { exec, calls, pending, releaseOne };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

const REPO = {
  'rev-parse --is-inside-work-tree': 'true',
  'branch --show-current': 'main',
  'status --short --untracked-files=normal': ' M notes.txt',
  'log --oneline -5 --no-decorate': 'abc1234 first',
  'config user.name': 'Example Owner'
};

describe('readGitContext', () => {
  it('never runs git synchronously (no execSync, spawnSync or execFileSync in system-sections.js)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'system-sections.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(execSync|spawnSync|execFileSync)\b/);
  });

  it('leaves the event loop running while each git is out, and reads the five values in order', async () => {
    const git = fakeGit(REPO);
    let settled = false;
    const reading = readGitContext('/work/dir', { exec: git.exec }).then((value) => { settled = true; return value; });

    // One git at a time, and the loop turns while each one is pending.
    for (let n = 1; n <= 5; n += 1) {
      await turn();
      assert.strictEqual(git.calls.length, n, `git ${n} is out`);
      assert.strictEqual(git.pending.length, 1);
      assert.strictEqual(settled, false, 'nothing is returned before git answers');
      git.releaseOne();
    }
    const context = await reading;

    assert.deepStrictEqual(context, { branch: 'main', status: 'M notes.txt', recentCommits: 'abc1234 first', userName: 'Example Owner' });
    assert.deepStrictEqual(git.calls.map((c) => c.args.join(' ')), Object.keys(REPO));
    for (const call of git.calls) {
      assert.strictEqual(call.file, 'git');
      assert.ok(Array.isArray(call.args), 'an argument array, never a shell string');
      assert.strictEqual(call.options.cwd, '/work/dir');
      assert.strictEqual(call.options.timeout, 3000);
      assert.strictEqual(call.options.shell, undefined);
    }
  });

  it('resolves null outside a git repository after the one check', async () => {
    const git = fakeGit({});
    const reading = readGitContext('/not/a/repo', { exec: git.exec });
    await turn();
    git.releaseOne();
    assert.strictEqual(await reading, null);
    assert.strictEqual(git.calls.length, 1);
  });

  it('resolves null when git cannot be started at all', async () => {
    const exec = () => { throw new Error('spawn git ENOENT'); };
    assert.strictEqual(await readGitContext('/work/dir', { exec }), null);
  });

  it('falls back to the short commit on a detached HEAD, and to null for a value git refuses', async () => {
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': 'true',
      'branch --show-current': '',
      'rev-parse --short HEAD': 'abc1234',
      'status --short --untracked-files=normal': '',
      'log --oneline -5 --no-decorate': 'abc1234 first'
    });
    const reading = readGitContext('/work/dir', { exec: git.exec });
    for (let n = 0; n < 6; n += 1) {
      await turn();
      git.releaseOne();
    }
    assert.deepStrictEqual(await reading, { branch: 'abc1234', status: '', recentCommits: 'abc1234 first', userName: null });
  });

  it('reads this repository with the real git', async () => {
    const context = await readGitContext(path.join(__dirname, '..'));
    assert.ok(context, 'the checkout is a git repository');
    assert.strictEqual(typeof context.branch, 'string');
    assert.ok(context.branch.length > 0);
    assert.match(context.recentCommits, /^[0-9a-f]{7,} /);
  });
});

// With git awaited, the first index is no longer finished by the time a
// turn's own await on the runtime environment returns: the turn waits for it.
describe('ContextAssembler: a turn sent before the first index is built', () => {
  const ContextAssembler = require('../src/context/context-assembler');
  const TOOL = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
  const SECTION = { name: 'environment', content: 'Environment context (auto-detected):' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const newAssembler = () => new ContextAssembler({ vectorStorePath: path.join(dir, 'context-vectors.json') });

  it('assemble() waits for the tracked first index and then has its tools and sections', async () => {
    const assembler = newAssembler();
    let finishGit;
    const git = new Promise((resolve) => { finishGit = resolve; });
    assembler.trackFirstIndex((async () => {
      await git;
      await assembler.index([TOOL], [SECTION]);
    })());

    let assembled = null;
    const turn1 = assembler.assemble('hello').then((value) => { assembled = value; });
    await turn();
    await turn();
    assert.strictEqual(assembled, null, 'the turn waits while the index is being built');

    finishGit();
    await turn1;
    assert.deepStrictEqual(assembled.tools.map((t) => t.name), ['Read']);
    assert.match(assembled.systemPrompt, /Environment context/);

    // Nothing to wait for afterwards.
    assert.strictEqual(assembler._firstIndex, null);
    assert.deepStrictEqual((await assembler.assemble('again')).tools.map((t) => t.name), ['Read']);
  });

  it('a first index that fails does not hold turns up or reject them', async () => {
    const assembler = newAssembler();
    await assert.doesNotReject(assembler.trackFirstIndex(Promise.reject(new Error('index failed'))));
    const assembled = await assembler.assemble('hello');
    assert.deepStrictEqual(assembled.tools, []);
  });

  it('an assembler nobody indexes in the background answers at once', async () => {
    const assembler = newAssembler();
    await assembler.index([TOOL], [SECTION]);
    assert.deepStrictEqual((await assembler.assemble('hello')).tools.map((t) => t.name), ['Read']);
  });
});

describe('buildSystemSections and git', () => {
  it('runs no git itself: the git section comes only from options.gitContext', () => {
    const env = { platform: 'linux', shell: '/bin/sh', workingDirectory: path.join(__dirname, '..') };
    const without = buildSystemSections(env, {});
    assert.strictEqual(without.find((s) => s.name === 'git-context'), undefined, 'a git checkout, and still no section');

    const withGit = buildSystemSections(env, { gitContext: { branch: 'main', status: ' M notes.txt', recentCommits: 'abc1234 first', userName: 'Example Owner' } });
    const section = withGit.find((s) => s.name === 'git-context');
    assert.ok(section);
    assert.match(section.content, /Current branch: main/);
    assert.match(section.content, /Git user: Example Owner/);
    assert.match(section.content, /abc1234 first/);
  });
});
