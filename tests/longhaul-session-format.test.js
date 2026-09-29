// tests/longhaul-session-format.test.js
// LongHaul's session format (benchmark spec §4).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sf = require('../src/longhaul/session-format');
const { tmpDir } = require('./helpers/longhaul-helpers');

const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString();
function msgs() {
  return [
    { id: 'm1', seq: 1, sender: 'user', text: 'u'.repeat(40), timestamp: at(1) },
    { id: 'm2', seq: 2, sender: 'assistant', text: 'a'.repeat(40), timestamp: at(2) },
    { id: 'm3', seq: 3, sender: 'toolUse', toolName: 'Bash', parameters: { command: 'ls' }, timestamp: at(3) },
    { id: 'm4', seq: 4, sender: 'toolResult', toolName: 'Bash', result: 'r'.repeat(40), timestamp: at(4) },
    { id: 'm5', seq: 5, sender: 'status', text: 's'.repeat(40), meta: { compaction: true }, timestamp: at(5) },
    { id: 'm6', seq: 6, sender: 'user', text: 'line separated', timestamp: at(6) }
  ];
}

describe('message text and tokens', () => {
  it('estimates ceil(chars / 4)', () => {
    assert.strictEqual(sf.estimateTokens(''), 0);
    assert.strictEqual(sf.estimateTokens('abcd'), 1);
    assert.strictEqual(sf.estimateTokens('abcde'), 2);
  });

  it('renders each sender with an ASCII header', () => {
    const [u, , use, result, summary] = msgs();
    assert.strictEqual(sf.messageText(use), 'Bash: {"command":"ls"}');
    assert.strictEqual(sf.messageText({ sender: 'toolResult', result: { ok: true } }), '{\n  "ok": true\n}');
    assert.strictEqual(sf.renderMessage(u), `[#1 user]\n${'u'.repeat(40)}`);
    assert.strictEqual(sf.renderMessage(use).split('\n')[0], '[#3 Bash call]');
    assert.strictEqual(sf.renderMessage(result).split('\n')[0], '[#4 Bash result]');
    assert.strictEqual(sf.renderMessage(summary).split('\n')[0], '[#5 compaction summary]');
  });
});

describe('SessionIndex', () => {
  it('sums estimated tokens strictly between two seqs and lists user seqs', () => {
    const index = new sf.SessionIndex(msgs());
    assert.strictEqual(index.maxSeq, 6);
    assert.strictEqual(index.tokensBetween(1, 5), 10 + 6 + 10);
    assert.strictEqual(index.tokensBetween(2, 3), 0);
    assert.deepStrictEqual(index.userSeqs, [1, 6]);
    assert.strictEqual(index.get(7), null);
    assert.strictEqual(index.get(3).id, 'm3');
  });

  it('refuses messages whose seq is not dense from 1', () => {
    const bad = msgs();
    bad[2].seq = 9;
    assert.throws(() => new sf.SessionIndex(bad), /not dense/);
  });
});

describe('manifest and session files', () => {
  it('builds the manifest counts, and a private session is licensed "private"', () => {
    const m = sf.buildManifest({ sessionId: 'S1', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: true, messages: msgs(), compactions: [] });
    assert.strictEqual(m.messages, 6);
    assert.strictEqual(m.humanMessages, 2);
    assert.strictEqual(m.toolCalls, 1);
    assert.strictEqual(m.license, 'private');
    assert.strictEqual(m.private, true);
    assert.strictEqual(m.bytesByKind.tool_result, 40);
    assert.deepStrictEqual(m.span, { from: at(1), to: at(6) });
    assert.strictEqual(m.estTokens, new sf.SessionIndex(msgs()).totalTokens());
  });

  it('writes and loads a session, keeping U+2028 in text', async () => {
    const dir = path.join(tmpDir(), 'sessions', 'S1');
    const messages = msgs();
    const manifest = sf.buildManifest({ sessionId: 'S1', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [{ atSeq: 5, summarySeq: 5, windowFromSeq: 1, windowToSeq: 4 }] });
    sf.writeSession(dir, { manifest, messages });
    const loaded = await sf.loadSession(dir);
    assert.deepStrictEqual(loaded.messages, messages);
    assert.deepStrictEqual(loaded.manifest, manifest);
    assert.strictEqual(loaded.index.get(6).text, 'line separated');
    assert.deepStrictEqual(sf.listSessions(path.dirname(path.dirname(dir))), ['S1']);
  });

  it('refuses to write an invalid session and writes nothing', () => {
    const dir = path.join(tmpDir(), 'S2');
    const messages = msgs();
    messages[1].id = 'm1';
    const manifest = sf.buildManifest({ sessionId: 'S2', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [] });
    assert.throws(() => sf.writeSession(dir, { manifest, messages }), /duplicate id m1/);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('flags a compaction whose summarySeq is not a compaction summary', () => {
    const messages = msgs();
    const manifest = sf.buildManifest({ sessionId: 'S3', source: 'synthetic', sourceRef: 'x', license: 'CC-BY-4.0', private: false, messages, compactions: [{ atSeq: 4, summarySeq: 4, windowFromSeq: 1, windowToSeq: 3 }] });
    assert.match(sf.validateManifest(manifest, messages).join('\n'), /summarySeq 4 is not a compaction summary/);
  });
});
