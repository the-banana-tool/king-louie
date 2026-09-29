// tests/history-importer-claude-code.test.js
// The claude-code-jsonl importer (recall spec §10.2; LongHaul spec §4, §14, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const importer = require('../src/history/importers/claude-code-jsonl');
const { tmpDir } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

describe('claude-code-jsonl parse', () => {
  it('maps the transcript to messages in order, with dense seqs', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages.map((m) => m.sender), [
      'user', 'assistant', 'toolUse', 'toolResult', 'status', 'status', 'status', 'user',
      'toolUse', 'toolResult', 'status', 'status', 'status', 'status', 'user'
    ]);
    assert.deepStrictEqual(messages.map((m) => m.seq), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepStrictEqual(messages.map((m) => m.id).slice(0, 4), ['u-1', 'a-2', 'a-3', 'u-2']);
    assert.strictEqual(messages[0].text, 'Set the staging port to 18431 please.');
    assert.strictEqual(messages[0].timestamp, cc.ts(1));
  });

  it('keeps tool calls and results with their tool names', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages[2], {
      id: 'a-3', seq: 3, timestamp: cc.ts(3), sender: 'toolUse', toolName: 'Bash',
      parameters: { command: 'grep -n port config/staging.yaml' }, meta: { toolUseId: 'toolu_01' }
    });
    assert.strictEqual(messages[3].toolName, 'Bash');
    assert.strictEqual(messages[3].result, '12:port: 18431');
    assert.deepStrictEqual(messages[3].meta, { toolUseId: 'toolu_01', isError: false });
    assert.strictEqual(messages[9].toolName, 'Read');
    assert.strictEqual(messages[9].result, 'host: build-7.example.com');
  });

  it('records both compactions with their windows', async () => {
    const { messages, compactions } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(compactions, [
      { atSeq: 5, summarySeq: 6, windowFromSeq: 1, windowToSeq: 4 },
      { atSeq: 13, summarySeq: 14, windowFromSeq: 7, windowToSeq: 12 }
    ]);
    assert.deepStrictEqual(messages[5].meta, { compaction: true });
    assert.strictEqual(messages[5].text, 'Summary: the staging port was set to 18431.');
    assert.deepStrictEqual(messages[4].meta, { compactBoundary: { trigger: 'manual', preTokens: 1200, postTokens: 300 } });
  });

  it('turns harness-injected isMeta text into a status message', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(messages[6].meta, { claudeCode: { isMeta: true } });
  });

  it('keeps a U+2028 inside one message', async () => {
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(messages[7].text, cc.LINE_SEPARATOR_TEXT);
  });

  it('counts corrupt lines, duplicates, unmapped and skipped records, and keeps unmapped ones as status', async () => {
    const { messages, stats } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(stats.badLines, 1);
    assert.strictEqual(stats.duplicates, 1);
    assert.strictEqual(stats.unmapped, 2);
    assert.deepStrictEqual(stats.skipped, {
      'bridge-session': 1, 'queue-operation': 1, attachment: 1, thinking: 1,
      'ai-title': 1, sidechain: 1, 'system:turn_duration': 1
    });
    assert.strictEqual(messages[10].text, '[unmapped assistant:server_tool_use]');
    assert.match(messages[10].meta.raw, /server_tool_use/);
    assert.strictEqual(messages[11].text, '[unmapped mystery-record]');
    assert.strictEqual(messages[11].meta.unmapped, true);
  });

  it('builds the chat from the session id and the title record', async () => {
    const { chat } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir()));
    assert.deepStrictEqual(chat, {
      id: 'cc-sess-fixture-1', title: 'Staging port setup', source: 'claude-code-jsonl',
      createdAt: cc.ts(1), updatedAt: cc.ts(17)
    });
  });

  it('counts a cut-off last line and keeps everything before it', async () => {
    const records = [cc.user('u-1', 1, 'hello there'), '{"type":"assistant","uuid":"a-x"'];
    const { messages, stats } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'cut.jsonl', { records, trailingNewline: false }));
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(stats.badLines, 1);
  });

  it('reads a 3 MB tool result intact', async () => {
    const big = 'z'.repeat(3_000_000);
    const records = [
      cc.user('u-1', 1, 'read it'),
      cc.assistant('a-1', 2, [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: 'big.txt' } }]),
      cc.user('u-2', 3, [{ type: 'tool_result', tool_use_id: 'toolu_9', content: big }])
    ];
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'big.jsonl', { records }));
    assert.strictEqual(messages[2].result.length, 3_000_000);
  });

  it('caps the raw JSON kept for an unmapped record', async () => {
    const records = [cc.user('u-1', 1, 'hi'), { ...cc.common('m-2', 2), type: 'mystery-record', payload: 'q'.repeat(10000) }];
    const { messages } = await importer.parse(cc.writeClaudeCodeFixture(tmpDir(), 'raw.jsonl', { records }));
    assert.ok(messages[1].meta.rawChars > 10000);
    assert.ok(messages[1].meta.raw.length <= 4001);
  });
});

describe('claude-code-jsonl detect and preview', () => {
  it('detects a session transcript', async () => {
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(tmpDir())), true);
  });

  it('rejects other files, subagent transcripts and sidechain-only files', async () => {
    const dir = tmpDir();
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'notes.txt')), false);
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, path.join('subagents', 'agent-a1.jsonl'))), false);
    const side = [cc.user('s-1', 1, 'task for the agent', { isSidechain: true, agentId: 'a1' })];
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'side.jsonl', { records: side })), false);
    assert.strictEqual(await importer.detect(cc.writeClaudeCodeFixture(dir, 'other.jsonl', { records: [{ hello: 'world' }] })), false);
  });

  it('refuses to parse a subagent transcript', async () => {
    const file = cc.writeClaudeCodeFixture(tmpDir(), path.join('subagents', 'agent-a1.jsonl'));
    await assert.rejects(importer.parse(file), (err) => err.code === 'SUBAGENT_FILE');
  });

  it('previews the title, user turns and the first messages', async () => {
    const p = await importer.preview(cc.writeClaudeCodeFixture(tmpDir()));
    assert.strictEqual(p.title, 'Staging port setup');
    assert.strictEqual(p.turns, 3);
    assert.deepStrictEqual(p.sample.map((s) => s.seq), [1, 2, 8, 15]);
  });
});
