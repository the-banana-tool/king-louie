const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  evaluate,
  isNonCodePath,
  filterVerifiablePaths,
  MAX_CHANGED_PATHS_IN_NUDGE
} = require('../src/verification/verify-on-stop');
const { EvidenceLedger } = require('../src/verification/evidence-ledger');
const { classifyCommand } = require('../src/verification/command-classifier');

const noEvidence = {
  hasFullPass: false,
  hasTargetedPass: false,
  hasFreshFailure: false,
  hasAnyFreshEvidence: false
};

describe('isNonCodePath', () => {
  it('treats prose and data as unverifiable', () => {
    for (const p of [
      'README.md', 'docs/guide.mdx', 'notes.txt', 'CHANGELOG',
      'LICENSE', 'data/rows.csv', 'x.rst', '.gitignore'
    ]) {
      assert.strictEqual(isNonCodePath(p), true, `${p} should be non-code`);
    }
  });

  it('treats source and config as verifiable', () => {
    for (const p of [
      'src/app.js', 'main.py', 'lib/mod.rs', 'a.ts',
      'config.json', 'pyproject.toml', 'docker-compose.yml'
    ]) {
      assert.strictEqual(isNonCodePath(p), false, `${p} should be code`);
    }
  });

  it('treats extension-less files as code', () => {
    // Dockerfile, Makefile, and shell scripts are all exercised by builds.
    assert.strictEqual(isNonCodePath('Dockerfile'), false);
    assert.strictEqual(isNonCodePath('Makefile'), false);
    assert.strictEqual(isNonCodePath('scripts/deploy'), false);
  });

  it('matches on basename, not the whole path', () => {
    assert.strictEqual(isNonCodePath('deep/nested/docs/README.md'), true);
    assert.strictEqual(isNonCodePath('docs/build.js'), false);
  });
});

describe('filterVerifiablePaths', () => {
  it('drops prose and de-duplicates', () => {
    const filtered = filterVerifiablePaths([
      'src/a.js', 'README.md', 'src/a.js', 'CHANGELOG', 'src/b.ts'
    ]);
    assert.deepStrictEqual(filtered, ['src/a.js', 'src/b.ts']);
  });
});

describe('evaluate — when to nudge', () => {
  it('nudges once when code changed and nothing was run', () => {
    const result = evaluate({ changedPaths: ['src/app.js'], status: noEvidence });

    assert.strictEqual(result.nudge, true);
    assert.strictEqual(result.reason, 'no_evidence');
    assert.match(result.message, /changed code but nothing was run/);
    assert.match(result.message, /src\/app\.js/);
  });

  it('stays silent after a full pass', () => {
    const result = evaluate({
      changedPaths: ['src/app.js'],
      status: { ...noEvidence, hasFullPass: true, hasAnyFreshEvidence: true }
    });
    assert.strictEqual(result.nudge, false);
    assert.strictEqual(result.reason, 'full_pass');
  });

  it('stays silent when only prose changed', () => {
    // Demanding a verification script for a README edit is the fastest way
    // to teach the user to ignore every nudge.
    const result = evaluate({
      changedPaths: ['README.md', 'docs/guide.md', 'LICENSE'],
      status: noEvidence
    });
    assert.strictEqual(result.nudge, false);
    assert.strictEqual(result.reason, 'no_code_changes');
  });

  it('still nudges when a turn mixes prose and code', () => {
    const result = evaluate({
      changedPaths: ['README.md', 'src/app.js'],
      status: noEvidence
    });
    assert.strictEqual(result.nudge, true);
    assert.deepStrictEqual(result.paths, ['src/app.js']);
    assert.ok(!result.message.includes('README.md'), 'the prose file is not what needs verifying');
  });

  it('stays silent when a fresh failure is already visible', () => {
    // The agent ran something and it broke. It knows. Telling it to go
    // verify would be absurd.
    const result = evaluate({
      changedPaths: ['src/app.js'],
      status: { ...noEvidence, hasFreshFailure: true, hasAnyFreshEvidence: true }
    });
    assert.strictEqual(result.nudge, false);
    assert.strictEqual(result.reason, 'fresh_failure_already_visible');
  });

  it('nudges differently after a targeted-only pass', () => {
    const result = evaluate({
      changedPaths: ['src/app.js'],
      status: { ...noEvidence, hasTargetedPass: true, hasAnyFreshEvidence: true }
    });

    assert.strictEqual(result.nudge, true);
    assert.strictEqual(result.reason, 'targeted_only');
    assert.match(result.message, /only verification run this turn was targeted/);
    assert.ok(
      !/nothing was run/.test(result.message),
      'telling an agent that ran a test that it ran nothing invites it to ignore us'
    );
  });

  it('nudges at most once per turn', () => {
    const result = evaluate({
      changedPaths: ['src/app.js'], status: noEvidence, alreadyNudged: true
    });
    assert.strictEqual(result.nudge, false);
    assert.strictEqual(result.reason, 'already_nudged');
  });

  it('can be disabled outright', () => {
    const result = evaluate({
      changedPaths: ['src/app.js'], status: noEvidence, enabled: false
    });
    assert.strictEqual(result.nudge, false);
    assert.strictEqual(result.reason, 'disabled');
  });

  it('says nothing when the turn changed no files at all', () => {
    const result = evaluate({ changedPaths: [], status: noEvidence });
    assert.strictEqual(result.nudge, false);
  });
});

describe('evaluate — message bounds', () => {
  it('caps the path list and says how many were hidden', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/file-${i}.js`);
    const result = evaluate({ changedPaths: paths, status: noEvidence });

    const listed = result.message.split('\n').filter((line) => line.startsWith('  - '));
    assert.strictEqual(listed.length, MAX_CHANGED_PATHS_IN_NUDGE);
    assert.match(result.message, /…and 17 more/);
  });
});

describe('ledger + policy end to end', () => {
  const ROOT = '/tmp/proj-e2e';

  it('edit code, run nothing, get exactly one nudge', () => {
    const ledger = new EvidenceLedger();
    ledger.markEdited(ROOT, ['src/app.js']);

    const first = evaluate({
      changedPaths: ['src/app.js'], status: ledger.status(ROOT)
    });
    assert.strictEqual(first.nudge, true);

    const second = evaluate({
      changedPaths: ['src/app.js'], status: ledger.status(ROOT), alreadyNudged: true
    });
    assert.strictEqual(second.nudge, false);
  });

  it('edit code, run the suite, get no nudge', () => {
    const ledger = new EvidenceLedger();
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('npm test', { exitCode: 0 }));

    const result = evaluate({ changedPaths: ['src/app.js'], status: ledger.status(ROOT) });
    assert.strictEqual(result.nudge, false);
  });

  it('edit code, run one test file, still get the bounded nudge', () => {
    const ledger = new EvidenceLedger();
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('node --test tests/app.test.js', { exitCode: 0 }));

    const result = evaluate({ changedPaths: ['src/app.js'], status: ledger.status(ROOT) });
    assert.strictEqual(result.nudge, true);
    assert.strictEqual(result.reason, 'targeted_only');
  });

  it('edit only docs, run nothing, get no nudge', () => {
    const ledger = new EvidenceLedger();
    ledger.markEdited(ROOT, ['README.md']);

    const result = evaluate({ changedPaths: ['README.md'], status: ledger.status(ROOT) });
    assert.strictEqual(result.nudge, false);
  });

  it('a lint pass alone does not satisfy the check', () => {
    const ledger = new EvidenceLedger();
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('npm run lint', { exitCode: 0 }));

    const result = evaluate({ changedPaths: ['src/app.js'], status: ledger.status(ROOT) });
    assert.strictEqual(result.nudge, true, 'a green linter is not evidence the code works');
  });
});
