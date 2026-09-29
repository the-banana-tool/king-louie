// tests/longhaul-session-ids.test.js
// Session ids name directories and files under LONGHAUL_HOME, so every
// command validates them before building a path ('.', '..' and anything
// with a separator are refused), and the path helpers refuse to leave
// their directory whatever id they are handed.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/longhaul/cli');
const { validateSessionId, sessionDir } = require('../src/longhaul/session-format');
const { questionsFile, rejectedFile, authorLogFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { tmpHome, tmpDir, sink, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

const BAD = ['..', '.', '../x', 'a/b', 'a\b', '.hidden', ''];

async function run(argv, env) {
  const stderr = sink();
  const code = await main(argv, { stdout: sink(), stderr, env, stdin: null });
  return { code, stderr: stderr.text };
}

describe('validateSessionId', () => {
  it('accepts ids that start with a letter or digit', () => {
    for (const id of ['synth-small', 'cc-0123abcd', 'X', 'a.b_c-1']) assert.strictEqual(validateSessionId(id), id);
  });

  it('refuses dot ids, leading dots, separators and empty ids', () => {
    for (const id of BAD) assert.throws(() => validateSessionId(id), UsageError, JSON.stringify(id));
    assert.throws(() => validateSessionId('x'.repeat(65)), UsageError);
  });
});

describe('path helpers stay inside their directory', () => {
  it('refuse an id that would leave sessions/ or questions/', () => {
    const root = tmpDir();
    for (const id of ['..', '.', '../x', 'a/../../b']) {
      assert.throws(() => sessionDir(root, id), UsageError, id);
      assert.throws(() => questionsFile(root, id), UsageError, id);
      assert.throws(() => rejectedFile(root, id), UsageError, id);
      assert.throws(() => authorLogFile(root, id), UsageError, id);
    }
    assert.strictEqual(sessionDir(root, 'ok'), path.join(root, 'sessions', 'ok'));
    assert.strictEqual(rejectedFile(root, 'ok'), path.join(root, 'questions', 'ok.rejected.jsonl'));
    assert.strictEqual(authorLogFile(root, 'ok'), path.join(root, 'questions', 'ok.author-log.jsonl'));
  });
});

describe('every command refuses a bad session id with exit 2', () => {
  for (const id of ['..', '.', '../x', 'a/b']) {
    it(`refuses ${JSON.stringify(id)}`, async () => {
      const { env, root } = tmpHome();
      const file = cc.writeClaudeCodeFixture(tmpDir(), 'session-x.jsonl');
      const cases = [
        ['import', file, '--id', id],
        ['author', '--session', id, '--provider', 'openai', '--model', 'm'],
        ['verify', '--session', id, '--reviewer', 'T'],
        ['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--session', id]
      ];
      for (const argv of cases) {
        const r = await run(argv, env);
        assert.strictEqual(r.code, 2, `${argv[0]}: ${r.stderr}`);
        assert.match(r.stderr, /Session id/, argv[0]);
      }
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'sessions')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), []);
    });
  }
});
