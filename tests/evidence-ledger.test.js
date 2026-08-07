const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedger } = require('../src/verification/evidence-ledger');
const { classifyCommand, scopeForArgs } = require('../src/verification/command-classifier');

describe('classifyCommand — recognition', () => {
  it('recognises the common test runners', () => {
    const commands = [
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn test',
      'node --test tests/foo.test.js',
      'pytest',
      'python -m pytest',
      'cargo test',
      'go test ./...',
      'dotnet test',
      'bundle exec rspec'
    ];

    for (const command of commands) {
      const evidence = classifyCommand(command, { exitCode: 0 });
      assert.ok(evidence, `should recognise: ${command}`);
      assert.strictEqual(evidence.kind, 'test', `wrong kind for: ${command}`);
    }
  });

  it('separates kinds, because a green linter is not a green suite', () => {
    assert.strictEqual(classifyCommand('eslint .').kind, 'lint');
    assert.strictEqual(classifyCommand('tsc --noEmit').kind, 'typecheck');
    assert.strictEqual(classifyCommand('npm run build').kind, 'build');
    assert.strictEqual(classifyCommand('prettier --write .').kind, 'format');
    assert.strictEqual(classifyCommand('cargo clippy').kind, 'lint');
  });

  it('only tests prove behavior', () => {
    assert.strictEqual(classifyCommand('npm test').provesBehavior, true);
    assert.strictEqual(classifyCommand('eslint .').provesBehavior, false);
    assert.strictEqual(classifyCommand('npm run build').provesBehavior, false);
    assert.strictEqual(classifyCommand('tsc').provesBehavior, false);
  });

  it('ignores commands that prove nothing', () => {
    for (const command of ['ls -la', 'cd src', 'git status', 'cat README.md', 'echo hi']) {
      assert.strictEqual(classifyCommand(command), null, `should ignore: ${command}`);
    }
  });

  it('sees through wrappers and env assignments', () => {
    assert.strictEqual(classifyCommand('sudo npm test')?.kind, 'test');
    assert.strictEqual(classifyCommand('CI=1 npm test')?.kind, 'test');
    assert.strictEqual(classifyCommand('npx jest')?.kind, 'test');
    assert.strictEqual(classifyCommand('time pytest')?.kind, 'test');
  });

  it('takes the strongest link in a chain', () => {
    const evidence = classifyCommand('npm run lint && npm test', { exitCode: 0 });
    assert.strictEqual(evidence.kind, 'test');
    assert.strictEqual(evidence.provesBehavior, true);
  });

  it('finds the verification step after an unrelated one', () => {
    const evidence = classifyCommand('cd packages/api && npm test', { exitCode: 0 });
    assert.strictEqual(evidence?.kind, 'test');
  });

  it('records failure from a non-zero exit', () => {
    assert.strictEqual(classifyCommand('npm test', { exitCode: 1 }).status, 'failed');
    assert.strictEqual(classifyCommand('npm test', { exitCode: 0 }).status, 'passed');
  });
});

describe('classifyCommand — scope', () => {
  it('treats a bare runner as full', () => {
    assert.strictEqual(classifyCommand('npm test').scope, 'full');
    assert.strictEqual(classifyCommand('pytest').scope, 'full');
    assert.strictEqual(classifyCommand('cargo test').scope, 'full');
  });

  it('treats a named file or path as targeted', () => {
    // The dangerous direction: calling this "full" would let one passing
    // file stand in for a green repo.
    assert.strictEqual(classifyCommand('node --test tests/foo.test.js').scope, 'targeted');
    assert.strictEqual(classifyCommand('pytest tests/test_api.py').scope, 'targeted');
    assert.strictEqual(classifyCommand('npm test -- src/thing.test.ts').scope, 'targeted');
  });

  it('treats a name filter as targeted', () => {
    assert.strictEqual(classifyCommand('pytest -k parses_dates').scope, 'targeted');
    assert.strictEqual(classifyCommand('go test -run TestFoo ./pkg').scope, 'targeted');
    assert.strictEqual(classifyCommand('jest --testNamePattern=login').scope, 'targeted');
  });

  it('does not mistake ordinary flags for targets', () => {
    assert.strictEqual(scopeForArgs(['--verbose', '--coverage']), 'full');
    assert.strictEqual(scopeForArgs(['--maxWorkers=4']), 'full');
  });

  it('reads ./... as the whole package tree, not a target', () => {
    assert.strictEqual(classifyCommand('go test ./...').scope, 'full');
  });
});

describe('classifyCommand — output', () => {
  it('bounds a huge output summary while keeping both ends', () => {
    const output = `HEAD${'x'.repeat(50_000)}TAIL`;
    const evidence = classifyCommand('npm test', { exitCode: 0, output });

    assert.ok(evidence.outputSummary.length < 2200);
    assert.ok(evidence.outputSummary.startsWith('HEAD'));
    assert.ok(evidence.outputSummary.endsWith('TAIL'), 'the pass/fail line lives at the end');
  });
});

describe('EvidenceLedger', () => {
  const ROOT = path.resolve('/tmp/project-x');
  let ledger;

  beforeEach(() => { ledger = new EvidenceLedger(); });

  it('reports nothing for an untouched workspace', () => {
    const status = ledger.status(ROOT);
    assert.strictEqual(status.hasEdits, false);
    assert.strictEqual(status.hasAnyFreshEvidence, false);
    assert.strictEqual(status.hasFullPass, false);
  });

  it('records a full pass after an edit', () => {
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('npm test', { exitCode: 0 }));

    const status = ledger.status(ROOT);
    assert.strictEqual(status.hasFullPass, true);
    assert.strictEqual(status.hasFreshFailure, false);
    assert.deepStrictEqual(status.editedPaths, ['src/app.js']);
  });

  it('never upgrades a targeted pass into a full pass', () => {
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('npm test -- src/app.test.js', { exitCode: 0 }));

    const status = ledger.status(ROOT);
    assert.strictEqual(status.hasTargetedPass, true);
    assert.strictEqual(
      status.hasFullPass, false,
      'one passing file is not evidence the suite is green'
    );
  });

  it('does not count a lint pass as behavioral evidence', () => {
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('eslint .', { exitCode: 0 }));

    const status = ledger.status(ROOT);
    assert.strictEqual(status.hasAnyFreshEvidence, true);
    assert.strictEqual(status.hasFullPass, false, 'a green linter says nothing about behavior');
  });

  it('treats evidence recorded before an edit as stale', async () => {
    ledger.record(ROOT, classifyCommand('npm test', { exitCode: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    ledger.markEdited(ROOT, ['src/app.js']);

    const status = ledger.status(ROOT);
    assert.strictEqual(
      status.hasFullPass, false,
      'a suite that passed before the change says nothing about it now'
    );
    assert.strictEqual(status.hasAnyFreshEvidence, false);
  });

  it('surfaces a fresh failure', () => {
    ledger.markEdited(ROOT, ['src/app.js']);
    ledger.record(ROOT, classifyCommand('npm test', { exitCode: 1 }));

    const status = ledger.status(ROOT);
    assert.strictEqual(status.hasFreshFailure, true);
    assert.strictEqual(status.hasFullPass, false);
  });

  it('keeps workspaces separate', () => {
    const other = path.resolve('/tmp/project-y');
    ledger.markEdited(ROOT, ['a.js']);
    ledger.record(ROOT, classifyCommand('npm test', { exitCode: 0 }));

    assert.strictEqual(ledger.status(ROOT).hasFullPass, true);
    assert.strictEqual(ledger.status(other).hasFullPass, false);
  });

  it('ignores a null classification so callers need no branch', () => {
    assert.strictEqual(ledger.record(ROOT, classifyCommand('ls -la')), null);
    assert.strictEqual(ledger.status(ROOT).hasAnyFreshEvidence, false);
  });

  it('clears the edited marker on request', () => {
    ledger.markEdited(ROOT, ['a.js']);
    assert.strictEqual(ledger.status(ROOT).hasEdits, true);
    ledger.clearEdited(ROOT);
    assert.strictEqual(ledger.status(ROOT).hasEdits, false);
  });
});

describe('EvidenceLedger — persistence and bounds', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-evidence-'));
    file = path.join(dir, 'evidence.json');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('survives a restart', () => {
    const root = path.resolve(dir, 'proj');
    const first = new EvidenceLedger({ storageFile: file });
    first.markEdited(root, ['src/a.js']);
    first.record(root, classifyCommand('npm test', { exitCode: 0 }));

    const second = new EvidenceLedger({ storageFile: file });
    assert.strictEqual(second.status(root).hasFullPass, true);
  });

  it('starts fresh rather than trusting an unknown schema version', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 99, workspaces: { x: {} } }), 'utf8');
    const ledger = new EvidenceLedger({ storageFile: file });
    assert.deepStrictEqual(ledger.snapshot().workspaces, {});
  });

  it('starts fresh on a corrupt file instead of throwing', () => {
    fs.writeFileSync(file, 'not json at all', 'utf8');
    assert.doesNotThrow(() => new EvidenceLedger({ storageFile: file }));
  });

  it('caps events per workspace', () => {
    const root = path.resolve(dir, 'proj');
    const ledger = new EvidenceLedger({ storageFile: file, maxEventsPerWorkspace: 5 });
    ledger.markEdited(root, ['a.js']);
    for (let i = 0; i < 40; i += 1) {
      ledger.record(root, classifyCommand('npm test', { exitCode: 0 }));
    }
    assert.strictEqual(ledger.snapshot().workspaces[root].events.length, 5);
  });

  it('ages old evidence out', () => {
    const root = path.resolve(dir, 'proj');
    const ledger = new EvidenceLedger({ storageFile: file, maxAgeDays: 30 });
    ledger.markEdited(root, ['a.js']);
    ledger.record(root, classifyCommand('npm test', { exitCode: 0 }));

    // Backdate the event past the retention window.
    const store = ledger.store;
    store.workspaces[root].events[0].recordedAt =
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    ledger.record(root, classifyCommand('npm run lint', { exitCode: 0 }));
    assert.strictEqual(ledger.snapshot().workspaces[root].events.length, 1);
  });

  it('does not throw when the storage path is unwritable', () => {
    const ledger = new EvidenceLedger({
      storageFile: path.join(dir, 'nested', 'x.json')
    });
    ledger.storageFile = path.join('\0invalid', 'x.json');
    assert.doesNotThrow(() => ledger.markEdited('/tmp/p', ['a.js']));
  });
});
