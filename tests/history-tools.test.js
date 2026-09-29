// tests/history-tools.test.js
// SearchHistory and ReadHistory (recall spec §8): scope, caps, errors.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTools, toolRegistry } = require('../src/tools');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const ContextAssembler = require('../src/context/context-assembler');
const { classifyToolCall } = require('../src/execution/safety-policy');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

initializeTools();

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

describe('history tools', () => {
  let t;
  let history;
  let settings = {};
  before(() => {
    t = openTempStore();
    seedChat(t.store, {
      messages: [
        { sender: 'user', text: GATE },
        { sender: 'assistant', text: 'Noted, I will keep the gate code in mind for the site visit.' },
        { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat notes/gate.txt' } },
        { sender: 'toolResult', toolName: 'Bash', result: { ok: true, stdout: 'gate: 4417 for the side entrance\nfence: forty meters along the north edge' } },
        { sender: 'assistant', text: 'The notes file agrees with what you told me about the gate.' }
      ]
    });
    seedChat(t.store, { id: 'chat-2', messages: [{ sender: 'user', text: 'Another chat also talks about a gate code, 9001, for a different lot.' }] });
    const estimator = new TokenEstimator();
    history = { chatId: 'chat-1', store: t.store, retriever: new Retriever({ store: t.store, estimator }), estimator, getSettings: () => ({ history: settings }) };
  });
  after(() => t.cleanup());

  const search = (params, ctx = { history }) => toolRegistry.get('SearchHistory').execute(params, ctx);
  const read = (params, ctx = { history }) => toolRegistry.get('ReadHistory').execute(params, ctx);

  it('are registered, read-only and need no approval', () => {
    for (const name of ['SearchHistory', 'ReadHistory']) {
      const tool = toolRegistry.get(name);
      assert.ok(tool, name);
      assert.strictEqual(tool.requiresApproval, false);
      assert.strictEqual(tool.concurrencySafe, true);
      assert.strictEqual(classifyToolCall(name, {}, {}).tier, 'read');
    }
  });

  it('are always loaded by the context assembler', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-'));
    try {
      const assembler = new ContextAssembler({ vectorStorePath: path.join(dir, 'vectors.json'), openaiApiKey: '' });
      await assembler.index(toolRegistry.getFunctionDefinitions(), []);
      const names = (await assembler.assemble('anything')).tools.map((d) => d.name);
      assert.ok(names.includes('SearchHistory') && names.includes('ReadHistory'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SearchHistory returns excerpts of this chat only, whatever scope is asked for', async () => {
    const out = await search({ query: 'gate code', scope: 'all' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.scope, 'chat');
    assert.ok(out.excerpts.length >= 2);
    assert.ok(out.excerpts.every((e) => typeof e.seq === 'number' && e.header.startsWith(`[#${e.seq} · `)));
    assert.ok(!out.excerpts.some((e) => e.text.includes('9001')));
    assert.ok(out.excerpts.some((e) => e.text.includes('4417')));
  });

  it('SearchHistory honours limit and kinds, and refuses an empty query or a missing chat', async () => {
    assert.strictEqual((await search({ query: 'gate', limit: 1 })).excerpts.length, 1);
    const results = await search({ query: 'gate', kinds: ['tool_result'] });
    assert.deepStrictEqual(results.excerpts.map((e) => e.seq), [4]);
    assert.match(results.excerpts[0].header, /Bash result/);
    assert.strictEqual((await search({ query: '  ' })).ok, false);
    assert.deepStrictEqual(await search({ query: 'gate' }, {}), { ok: false, error: 'History tools work only inside a chat.' });
    const none = await search({ query: 'zanzibar' });
    assert.deepStrictEqual(none.excerpts, []);
    assert.ok(none.note);
  });

  it('ReadHistory returns the range verbatim, tool calls and results included', async () => {
    const out = await read({ fromSeq: 1, toSeq: 5 });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.toSeq, 5);
    assert.ok(out.text.startsWith('[#1 · user · 2026-01-01T09:00:00.000Z]\nFor the record'));
    assert.ok(out.text.includes('[#3 · Bash call · '));
    assert.ok(out.text.includes('"command": "cat notes/gate.txt"'));
    assert.ok(out.text.includes('[#4 · Bash result · '));
    assert.ok(out.text.includes('stdout:\ngate: 4417 for the side entrance\nfence: forty meters along the north edge'));
  });

  it('ReadHistory stops at readHistoryMaxTokens with a note saying where to continue', async () => {
    settings = { readHistoryMaxTokens: 40 };
    try {
      const out = await read({ fromSeq: 1, toSeq: 5 });
      assert.strictEqual(out.truncated, true);
      assert.ok(out.toSeq < 5);
      assert.match(out.note, new RegExp(`from ${out.toSeq + 1}`));
      settings = { readHistoryMaxTokens: 5 };
      const cut = await read({ fromSeq: 1, toSeq: 1 });
      assert.strictEqual(cut.truncated, true);
      assert.match(cut.note, /#1 was cut/);
      assert.ok(cut.text.length <= 20);
    } finally {
      settings = {};
    }
  });

  it('ReadHistory refuses another chat, a bad range, or a range past the end', async () => {
    const other = await read({ chatId: 'chat-2', fromSeq: 1, toSeq: 1 });
    assert.strictEqual(other.ok, false);
    assert.match(other.error, /history scope is "chat"/);
    assert.strictEqual((await read({ fromSeq: 3, toSeq: 2 })).ok, false);
    assert.strictEqual((await read({ fromSeq: 0, toSeq: 2 })).ok, false);
    assert.match((await read({ fromSeq: 9, toSeq: 12 })).error, /has 5 messages/);
    assert.strictEqual((await read({ fromSeq: 4, toSeq: 99 })).toSeq, 5);
  });
});
