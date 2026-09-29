// tests/longhaul-import.test.js
// `longhaul import` (benchmark spec §4, §10.1): a Claude Code transcript into
// LONGHAUL_HOME/sessions/<id>/, private by default.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/longhaul/cli');
const { loadSession } = require('../src/longhaul/session-format');
const { tmpHome, tmpDir, sink } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

async function run(argv, env) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout, stderr, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('longhaul import', () => {
  it('counts an array-content compact summary as a compaction, not a message from the user', async () => {
    const { env, root } = tmpHome();
    const records = cc.claudeCodeRecords().map((r) => (r && (r.uuid === 'c-1' || r.uuid === 'c-2')
      ? { ...r, message: { role: 'user', content: [{ type: 'text', text: r.message.content }] } }
      : r));
    const file = cc.writeClaudeCodeFixture(path.join(root, 'private'), 'blocks.jsonl', { records });
    const r = await run(['import', file, '--id', 'B'], env);
    assert.strictEqual(r.code, 0, r.stderr);
    const s = await loadSession(path.join(root, 'sessions', 'B'));
    assert.strictEqual(s.manifest.compactions.length, 2);
    assert.strictEqual(s.manifest.humanMessages, 3);
  });

  it('imports a file dropped in private/ as private, with its manifest', async () => {
    const { env, root } = tmpHome();
    const file = cc.writeClaudeCodeFixture(path.join(root, 'private'), 'session-x.jsonl');
    const r = await run(['import', file, '--id', 'X'], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /imported X: 15 messages, 3 from the user, 2 tool calls, 2 compactions/);
    assert.match(r.stdout, /2 unmapped records kept as status messages, 1 unreadable lines skipped/);
    const s = await loadSession(path.join(root, 'sessions', 'X'));
    assert.strictEqual(s.manifest.private, true);
    assert.strictEqual(s.manifest.license, 'private');
    assert.strictEqual(s.manifest.sourceRef, 'private/session-x.jsonl');
    assert.strictEqual(s.manifest.source, 'claude-code-jsonl');
    assert.deepStrictEqual(s.manifest.compactions, [
      { atSeq: 5, summarySeq: 6, windowFromSeq: 1, windowToSeq: 4 },
      { atSeq: 13, summarySeq: 14, windowFromSeq: 7, windowToSeq: 12 }
    ]);
    assert.strictEqual(s.manifest.duplicates, 1);
    assert.match(s.manifest.sourceSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(s.messages[7].text, cc.LINE_SEPARATOR_TEXT);
  });

  it('keeps a file from outside private/ private unless --public --license is given', async () => {
    const { env, root } = tmpHome();
    const dir = tmpDir();
    const a = cc.writeClaudeCodeFixture(dir, 'a.jsonl');
    assert.strictEqual((await run(['import', a, '--id', 'P'], env)).code, 0);
    const p = await loadSession(path.join(root, 'sessions', 'P'));
    assert.strictEqual(p.manifest.private, true);
    assert.strictEqual(p.manifest.sourceRef, 'a.jsonl');
    const b = cc.writeClaudeCodeFixture(dir, 'b.jsonl');
    assert.strictEqual((await run(['import', b, '--id', 'Q', '--public', '--license', 'CC-BY-4.0'], env)).code, 0);
    const q = await loadSession(path.join(root, 'sessions', 'Q'));
    assert.strictEqual(q.manifest.private, false);
    assert.strictEqual(q.manifest.license, 'CC-BY-4.0');
  });

  it('refuses --public for a file in private/, --public without --license, and --license without --public', async () => {
    const { env, root } = tmpHome();
    const priv = cc.writeClaudeCodeFixture(path.join(root, 'private'), 's.jsonl');
    const r1 = await run(['import', priv, '--public', '--license', 'CC-BY-4.0'], env);
    assert.strictEqual(r1.code, 2);
    assert.match(r1.stderr, /always private/);
    const outside = cc.writeClaudeCodeFixture(tmpDir(), 'o.jsonl');
    assert.strictEqual((await run(['import', outside, '--public'], env)).code, 2);
    assert.strictEqual((await run(['import', outside, '--license', 'MIT'], env)).code, 2);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'sessions')), []);
  });

  it('names a session by its file hash when no --id is given', async () => {
    const { env, root } = tmpHome();
    const file = cc.writeClaudeCodeFixture(tmpDir(), 's.jsonl');
    assert.strictEqual((await run(['import', file], env)).code, 0);
    const [id] = fs.readdirSync(path.join(root, 'sessions'));
    assert.match(id, /^cc-[0-9a-f]{12}$/);
  });

  it('is idempotent for one file and refuses a different file under the same id without --force', async () => {
    const { env, root } = tmpHome();
    const dir = tmpDir();
    const a = cc.writeClaudeCodeFixture(dir, 'a.jsonl');
    const b = cc.writeClaudeCodeFixture(dir, 'b.jsonl', { records: cc.claudeCodeRecords().slice(0, 12) });
    assert.strictEqual((await run(['import', a, '--id', 'S'], env)).code, 0);
    const again = await run(['import', a, '--id', 'S'], env);
    assert.strictEqual(again.code, 0);
    assert.match(again.stdout, /already imported/);
    const refused = await run(['import', b, '--id', 'S'], env);
    assert.strictEqual(refused.code, 2);
    assert.match(refused.stderr, /--force/);
    const before = (await loadSession(path.join(root, 'sessions', 'S'))).manifest.sourceSha256;
    assert.strictEqual((await run(['import', b, '--id', 'S', '--force'], env)).code, 0);
    assert.notStrictEqual((await loadSession(path.join(root, 'sessions', 'S'))).manifest.sourceSha256, before);
  });

  it('refuses a subagent transcript, a file that is not a transcript, a missing file and a bad id', async () => {
    const { env } = tmpHome();
    const dir = tmpDir();
    const sub = cc.writeClaudeCodeFixture(dir, path.join('subagents', 'agent-a1.jsonl'));
    assert.strictEqual((await run(['import', sub], env)).code, 2);
    const other = cc.writeClaudeCodeFixture(dir, 'other.jsonl', { records: [{ hello: 'world' }] });
    assert.strictEqual((await run(['import', other], env)).code, 2);
    assert.strictEqual((await run(['import', path.join(dir, 'missing.jsonl')], env)).code, 2);
    const good = cc.writeClaudeCodeFixture(dir, 'good.jsonl');
    assert.strictEqual((await run(['import', good, '--id', 'a b'], env)).code, 2);
    assert.strictEqual((await run(['import'], env)).code, 2);
  });
});
