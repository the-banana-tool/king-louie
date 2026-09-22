const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main } = require('../src/service/cli');

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
