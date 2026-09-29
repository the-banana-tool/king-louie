// tests/history-sqlite-warning.test.js
// The hosts drop node:sqlite's ExperimentalWarning and nothing else
// (recall spec §16).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { suppressSqliteExperimentalWarning, isSqliteExperimentalWarning } = require('../src/history/sqlite-warning');

const ROOT = path.join(__dirname, '..');

describe('suppressSqliteExperimentalWarning', () => {
  it('drops the SQLite experimental warning in each form and passes every other warning', () => {
    const emitted = [];
    const proc = { emitWarning(...args) { emitted.push(args); } };
    suppressSqliteExperimentalWarning(proc);
    suppressSqliteExperimentalWarning(proc);
    proc.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    proc.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
    proc.emitWarning(Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' }));
    proc.emitWarning('Some other feature is experimental', 'ExperimentalWarning');
    proc.emitWarning('SQLite is slow', 'DeprecationWarning');
    assert.deepStrictEqual(emitted.map((args) => String(args[0])), ['Some other feature is experimental', 'SQLite is slow']);
    assert.strictEqual(isSqliteExperimentalWarning('SQLite is an experimental feature', 'ExperimentalWarning'), true);
  });

  it('silences the real warning in a Node process', () => {
    const script = [
      "require('./src/history/sqlite-warning').suppressSqliteExperimentalWarning();",
      "new (require('node:sqlite').DatabaseSync)(':memory:').close();",
      "process.emitWarning('a different experiment', 'ExperimentalWarning');"
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
    assert.match(result.stderr, /a different experiment/);
  });

  it('is installed by both hosts before anything loads node:sqlite', () => {
    const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const bin = fs.readFileSync(path.join(ROOT, 'bin', 'king-louie-service.js'), 'utf8');
    assert.ok(mainJs.indexOf('suppressSqliteExperimentalWarning()') > 0);
    assert.ok(mainJs.indexOf('suppressSqliteExperimentalWarning()') < mainJs.indexOf("require('./src/ipc/standalone-host')"));
    assert.ok(bin.indexOf('suppressSqliteExperimentalWarning()') > 0);
    assert.ok(bin.indexOf('suppressSqliteExperimentalWarning()') < bin.indexOf("require('../src/service/cli')"));
  });
});
