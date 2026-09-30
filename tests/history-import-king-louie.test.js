// tests/history-import-king-louie.test.js
// The king-louie-json importer (recall spec §10.2; LongHaul spec §4): the
// app's own chat export, one-to-one, minus llm, attachment bytes and Vault values.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const importer = require('../src/history/importers/king-louie-json');
const { validateMessages } = require('../src/longhaul/session-format');
const { scanForPersonalValues } = require('./helpers/example-denylist');
const { tmpDir } = require('./helpers/longhaul-helpers');

const FIXTURE = path.join(__dirname, 'fixtures', 'history', 'king-louie-chat.json');

function writeJson(value, name = 'chat.json') {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

describe('king-louie-json fixture', () => {
  it('holds invented values only', () => {
    assert.deepStrictEqual(scanForPersonalValues(fs.readFileSync(FIXTURE, 'utf8')), []);
  });
});

describe('king-louie-json detect', () => {
  it('claims a chat export and nothing else, never throwing', async () => {
    assert.strictEqual(await importer.detect(FIXTURE), true);
    assert.strictEqual(await importer.detect(writeJson('{not json')), false);
    assert.strictEqual(await importer.detect(writeJson([{ sender: 'user' }])), false);
    assert.strictEqual(await importer.detect(writeJson({ messages: [] })), false);
    assert.strictEqual(await importer.detect(writeJson({ messages: [{ text: 'no sender' }] })), false);
    assert.strictEqual(await importer.detect(writeJson({ messages: [{ sender: 'robot' }] })), false);
    assert.strictEqual(await importer.detect(writeJson({ chats: [{ messages: [{ sender: 'user' }] }] })), false);
    assert.strictEqual(await importer.detect(writeJson({ messages: [{ sender: 'user', text: 'hi' }] }, 'chat.txt')), false);
    assert.strictEqual(await importer.detect(path.join(tmpDir(), 'missing.json')), false);
  });
});

describe('king-louie-json parse', () => {
  it('maps the export one-to-one with dense seqs and a valid session shape', async () => {
    const { chat, messages, stats } = await importer.parse(FIXTURE);
    assert.deepStrictEqual(validateMessages(messages), []);
    assert.deepStrictEqual(messages.map((m) => m.sender), [
      'user', 'assistant', 'toolUse', 'toolResult', 'toolUse', 'toolResult', 'toolUse', 'toolResult',
      'status', 'status', 'user', 'assistant'
    ]);
    assert.strictEqual(chat.title, 'Lakeside lot survey');
    assert.strictEqual(chat.source, 'king-louie-json');
    assert.deepStrictEqual(chat.llmTotals, { calls: 3, inputTokens: 1200, outputTokens: 340, costUsd: 0.02 });
    assert.deepStrictEqual(messages[2], {
      id: 'm-3', seq: 3, timestamp: '2026-01-06T09:03:00.000Z', sender: 'toolUse', toolName: 'WebFetch',
      parameters: { url: 'https://lots.example.com/4417' }, runId: 'run-1'
    });
    assert.strictEqual(messages[3].result, 'Lot 4417: Lakeside lot, 2.5 acres.');
    assert.strictEqual(messages[11].stopped, true);
    assert.deepStrictEqual(stats, { unmapped: 1, badLines: 0, duplicates: 2, skipped: {} });
  });

  it('drops llm and attachment bytes but keeps a document\'s name, type and text', async () => {
    const { messages } = await importer.parse(FIXTURE);
    assert.strictEqual(messages[1].llm, undefined);
    assert.deepStrictEqual(messages[0].documents, [
      { name: 'survey.txt', mimeType: 'text/plain', size: 52, textContent: 'Lakeside lot survey: parcel 4417, 2.5 acres.' }
    ]);
    assert.ok(!JSON.stringify(messages).includes('U3VydmV5IGJ5dGVz'));
  });

  it('records a compaction and keeps an unknown sender as an unmapped status message', async () => {
    const { messages, compactions } = await importer.parse(FIXTURE);
    assert.deepStrictEqual(compactions, [{ atSeq: 9, summarySeq: 9, windowFromSeq: 1, windowToSeq: 8 }]);
    assert.deepStrictEqual(messages[8].meta, { compaction: true });
    assert.strictEqual(messages[9].sender, 'status');
    assert.strictEqual(messages[9].text, '[unmapped mystery]');
    assert.strictEqual(messages[9].meta.unmapped, true);
    assert.strictEqual(messages[9].meta.rawType, 'mystery');
  });

  it('gives a duplicate or missing id a fresh one and repairs a bad timestamp from the previous message', async () => {
    const { messages } = await importer.parse(FIXTURE);
    assert.strictEqual(messages[9].id, 'm-10');
    assert.strictEqual(messages[10].id, 'line-11');
    assert.strictEqual(messages[11].id, 'line-12');
    assert.strictEqual(messages[10].timestamp, messages[9].timestamp);
    assert.strictEqual(new Set(messages.map((m) => m.id)).size, messages.length);
  });

  it('never gives a fresh id a later message already owns', async () => {
    const file = writeJson({ messages: [
      { sender: 'user', text: 'a', timestamp: '2026-01-06T09:00:00.000Z' },
      { id: 'line-1', sender: 'assistant', text: 'b', timestamp: '2026-01-06T09:01:00.000Z' }
    ] });
    const { messages } = await importer.parse(file);
    assert.strictEqual(new Set(messages.map((m) => m.id)).size, 2);
    assert.deepStrictEqual(validateMessages(messages), []);
  });

  it('keeps a Vault call to its action and key and a Vault result to nothing', async () => {
    const { messages } = await importer.parse(FIXTURE);
    assert.deepStrictEqual(messages[4].parameters, { action: 'get', key: 'lots.portal' });
    assert.deepStrictEqual(messages[6].parameters, { action: 'store', key: 'lots.portal' });
    for (const i of [5, 7]) {
      assert.strictEqual(messages[i].sender, 'toolResult');
      assert.strictEqual(messages[i].result, '');
      assert.ok(!messages[i].text);
    }
    assert.ok(!JSON.stringify(messages).includes('pw-invented'));
    assert.ok(!JSON.stringify(messages).includes('invented note'));
  });

  it('keeps extracted tool calls but empties a Vault one', async () => {
    const file = writeJson({ messages: [{
      sender: 'assistant', text: 'ok', timestamp: '2026-01-06T09:00:00.000Z',
      toolCalls: [{ toolName: 'Bash', content: 'ls' }, { toolName: 'Vault', content: 'get lots.portal pw-invented' }]
    }] });
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(messages[0].toolCalls, [{ toolName: 'Bash', content: 'ls' }, { toolName: 'Vault', content: '' }]);
  });

  it('previews the title, user turns and the first messages', async () => {
    const p = await importer.preview(FIXTURE);
    assert.strictEqual(p.title, 'Lakeside lot survey');
    assert.strictEqual(p.turns, 2);
    assert.deepStrictEqual(p.sample.map((s) => s.seq), [1, 2, 11, 12]);
  });

  it('refuses a file that is not an export', async () => {
    await assert.rejects(importer.parse(writeJson({ hello: 'world' })), (err) => err.code === 'NOT_KING_LOUIE_EXPORT');
  });
});
