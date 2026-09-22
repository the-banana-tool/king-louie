const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main, parseArgs } = require('../src/service/cli');

function io(stdinText = '') {
  const out = []; const err = [];
  return {
    out, err,
    stdin: Readable.from([stdinText]),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cli-'));

describe('service CLI', () => {
  it('prints help and returns 0', async () => {
    const t = io();
    assert.strictEqual(await main(['help'], t), 0);
    assert.match(t.out.join(''), /king-louie-service run/);
  });
  it('returns 2 for unknown commands', async () => {
    const t = io();
    assert.strictEqual(await main(['frobnicate'], t), 2);
    assert.match(t.err.join(''), /Unknown command/);
  });
  it('stores a provider token from stdin, encrypted', async () => {
    const dir = tmp();
    const t = io('sk-from-stdin\n');
    assert.strictEqual(await main(['token', 'set', 'openai', '--data-dir', dir], t), 0);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')).apiTokens.openai;
    assert.match(saved, /^klc1:/);
    assert.ok(!t.out.join('').includes('sk-from-stdin'));
  });
  it('reports status for a data dir with no running service', async () => {
    const t = io();
    assert.strictEqual(await main(['status', '--data-dir', tmp()], t), 3);
    assert.match(t.out.join(''), /not running/);
  });
});

describe('parseArgs flag validation', () => {
  it('accepts --flag=value form without swallowing the next argument', () => {
    const { positional, flags } = parseArgs(['run', '--data-dir=/tmp/x', '--profile', 'agent']);
    assert.deepStrictEqual(positional, ['run']);
    assert.strictEqual(flags.dataDir, '/tmp/x');
    assert.strictEqual(flags.profile, 'agent');
  });

  it('rejects a value flag with no value at the end of argv', () => {
    assert.throws(() => parseArgs(['token', 'set', 'openai', '--data-dir']), /--data-dir.*value/);
  });

  it('rejects an explicitly empty --data-dir (space form, e.g. an unset var)', () => {
    assert.throws(() => parseArgs(['run', '--data-dir', '']), /--data-dir.*empty/);
  });

  it('rejects an explicitly empty --data-dir (--data-dir= form)', () => {
    assert.throws(() => parseArgs(['run', '--data-dir=']), /--data-dir.*empty/);
  });

  it('rejects a value flag whose value looks like another flag', () => {
    assert.throws(() => parseArgs(['run', '--data-dir', '--profile', 'runbook']), /--data-dir.*value/);
  });

  it('rejects an unknown flag', () => {
    assert.throws(() => parseArgs(['--verbose', 'run']), /Unknown flag.*--verbose/);
  });

  it('main() returns 2 and prints usage for a value flag with no value, and never reaches a command handler', async () => {
    const t = io();
    assert.strictEqual(await main(['token', 'set', 'openai', '--data-dir'], t), 2);
    assert.match(t.err.join(''), /--data-dir.*value/);
    assert.match(t.err.join(''), /Usage:/);
  });

  it('main() returns 2 for an explicitly empty --data-dir instead of falling back to the default data dir', async () => {
    // Uses "status" rather than "run": a bad flag must be rejected before any
    // command runs, and "status" makes that safe to assert even if a fix
    // regresses and the default data dir leaks through (it only reads a
    // pidfile, it never starts the service or writes anything).
    const t = io();
    assert.strictEqual(await main(['status', '--data-dir', ''], t), 2);
    assert.match(t.err.join(''), /--data-dir.*empty/);
  });

  it('main() returns 2 when a value flag swallows the next flag as its value', async () => {
    const t = io();
    assert.strictEqual(await main(['status', '--data-dir', '--profile', 'runbook'], t), 2);
    assert.match(t.err.join(''), /--data-dir.*value/);
  });

  it('main() returns 2 for an unknown flag instead of swallowing the next token and printing help with exit 0', async () => {
    const t = io();
    assert.strictEqual(await main(['--verbose', 'run'], t), 2);
    assert.match(t.err.join(''), /Unknown flag.*--verbose/);
  });
});
