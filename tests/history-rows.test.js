// tests/history-rows.test.js
// Chats and messages map to columns plus meta_json and back without loss
// (recall spec §4.1, §4.2).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  DERIVED_CHAT_KEYS, InvalidMessageError, chatToRow, rowToChat, messageToRow, rowToMessage
} = require('../src/history/rows');

// What SQLite hands back: BLOBs as Uint8Array, no extra fields.
function roundTripMessage(message, seq = 1) {
  const { row, attachments } = messageToRow(message, { fallbackTimestamp: '2026-09-29T00:00:00.000Z' });
  const stored = attachments.map((a) => ({ ...a, bytes: a.bytes ? new Uint8Array(a.bytes) : null }));
  return rowToMessage({ ...row, id: message.id, seq }, stored);
}
const PNG_B64 = Buffer.from('invented image bytes').toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.4 invented').toString('base64');

describe('message rows', () => {
  it('round-trips a user message with images and documents, adding seq', () => {
    const message = {
      id: 'm1', sender: 'user', text: 'see the Lakeside lot plan', timestamp: '2026-09-29T10:00:00.000Z',
      images: [{ base64: PNG_B64, mimeType: 'image/png', name: 'lot.png' }],
      documents: [
        { base64: PDF_B64, mimeType: 'application/pdf', name: 'offer.pdf', sizeBytes: 17 },
        { base64: PDF_B64, mimeType: 'text/markdown', name: 'notes.md', textContent: '# notes', sizeBytes: 17 }
      ]
    };
    assert.deepStrictEqual(roundTripMessage(message, 7), { ...message, seq: 7 });
  });

  it('round-trips tool calls, results, llm and context through their JSON columns', () => {
    const toolUse = { id: 'm2', sender: 'toolUse', text: '', timestamp: 't', toolName: 'Bash', parameters: { command: 'ls -la' }, runId: 'run-1' };
    const objResult = { id: 'm3', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Bash', result: { ok: true, output: 'a\nb' }, runId: 'run-1' };
    const strResult = { id: 'm4', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Read', result: 'plain text' };
    const nullResult = { id: 'm5', sender: 'toolResult', text: '', timestamp: 't', toolName: 'Read', result: null };
    const assistant = { id: 'm6', sender: 'assistant', text: 'done', timestamp: 't', llm: { totals: { inputTokens: 10, costUsd: 0.001 } }, context: { tail: { fromSeq: 1, toSeq: 5 } } };
    for (const m of [toolUse, objResult, strResult, nullResult, assistant]) {
      assert.deepStrictEqual(roundTripMessage(m), { ...m, seq: 1 });
    }
  });

  it('keeps fields without a column in meta_json', () => {
    const message = { id: 'm7', sender: 'user', text: 'hi', timestamp: 't', channel: 'telegram', stopped: true, workflowScaffolding: true, meta: { compaction: true } };
    const { row } = messageToRow(message);
    assert.deepStrictEqual(JSON.parse(row.meta_json), { channel: 'telegram', stopped: true, workflowScaffolding: true, meta: { compaction: true } });
    assert.deepStrictEqual(roundTripMessage(message), { ...message, seq: 1 });
  });

  it('tells an absent text from an empty one and from null', () => {
    assert.strictEqual('text' in roundTripMessage({ id: 'a', sender: 'status', timestamp: 't' }), false);
    assert.strictEqual(roundTripMessage({ id: 'b', sender: 'status', text: '', timestamp: 't' }).text, '');
    assert.strictEqual(roundTripMessage({ id: 'c', sender: 'status', text: null, timestamp: 't' }).text, null);
  });

  it('keeps a non-canonical base64 (a data URL) verbatim instead of decoding it', () => {
    const message = { id: 'm8', sender: 'user', text: '', timestamp: 't', images: [{ base64: `data:image/png;base64,${PNG_B64}`, mimeType: 'image/png', previewUrl: 'data:x' }] };
    const { attachments } = messageToRow(message);
    assert.strictEqual(attachments[0].bytes, null);
    assert.deepStrictEqual(roundTripMessage(message), { ...message, seq: 1 });
  });

  it('keeps an empty attachment list and a list that is not objects as they were', () => {
    const empty = { id: 'm9', sender: 'user', text: 'x', timestamp: 't', images: [] };
    const odd = { id: 'm10', sender: 'user', text: 'x', timestamp: 't', documents: ['not-an-object'] };
    assert.deepStrictEqual(roundTripMessage(empty), { ...empty, seq: 1 });
    assert.deepStrictEqual(roundTripMessage(odd), { ...odd, seq: 1 });
  });

  it('drops an incoming seq and fills a missing timestamp', () => {
    const { row } = messageToRow({ id: 'm11', sender: 'user', text: 'x', seq: 99 }, { fallbackTimestamp: '2026-09-01T00:00:00.000Z' });
    assert.strictEqual(row.timestamp, '2026-09-01T00:00:00.000Z');
    assert.strictEqual(row.meta_json, null, 'seq is the store\'s to assign');
  });

  it('refuses a message that is not an object or has no sender', () => {
    assert.throws(() => messageToRow('text'), InvalidMessageError);
    assert.throws(() => messageToRow({ text: 'orphan' }), (err) => err.code === 'HISTORY_INVALID_MESSAGE');
    assert.throws(() => messageToRow({ sender: '  ', text: 'blank' }), InvalidMessageError);
  });
});

describe('chat rows', () => {
  it('round-trips every chat field, columns and meta_json alike', () => {
    const chat = {
      id: 'c1', title: 'Lakeside lot', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      agentMode: false, sandboxMode: true, workingDirectory: '/work/example', caseId: null,
      disabledMcpServers: ['files'], llmTotals: { inputTokens: 5, outputTokens: 6, totalTokens: 11, costUsd: 0.01 },
      canvasState: null, profileId: 'p-a', mainOverride: { provider: 'openai', model: 'gpt-5.4', effort: null }, origin: 'telegram'
    };
    const row = chatToRow(chat);
    assert.strictEqual(row.agent_mode, 0);
    assert.strictEqual(row.sandbox_mode, 1);
    assert.strictEqual(row.case_id, null);
    assert.deepStrictEqual(rowToChat({ ...row, id: 'c1' }), chat);
  });

  it('never stores derived listing fields or messages', () => {
    const listed = { id: 'c2', title: 'Two', messages: [{ id: 'm', sender: 'user' }] };
    for (const key of DERIVED_CHAT_KEYS) listed[key] = key === 'lastMessageAt' ? '2026-09-29T00:00:00.000Z' : 3;
    const row = chatToRow(listed);
    assert.strictEqual(row.meta_json, null);
    assert.deepStrictEqual(rowToChat({ ...row, id: 'c2' }), { id: 'c2', title: 'Two' });
  });

  it('keeps a value of the wrong type for its column in meta_json', () => {
    const chat = { id: 'c3', title: 'Three', agentMode: 'yes', caseId: 42 };
    assert.deepStrictEqual(rowToChat({ ...chatToRow(chat), id: 'c3' }), chat);
  });

  it('reads a chat without a title back with an empty one', () => {
    assert.deepStrictEqual(rowToChat({ ...chatToRow({ id: 'c4' }), id: 'c4' }), { id: 'c4', title: '' });
  });
});
