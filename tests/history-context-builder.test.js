// tests/history-context-builder.test.js
// Tail rules, shortening, the query, the recalled block, stats, enabled:
// false, and no leakage past upToSeq (recall spec §6.1–§6.4, §7, §13).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const DAY = 86400000;
const filler = (i) => ({
  sender: i % 2 ? 'user' : 'assistant',
  text: `Filler note ${i} about the weekly grocery list and the garden hose timer.`
});
const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

// A synthetic pasted article, ~27K chars, with the gate code in section 7.
function article() {
  const sections = [];
  for (let s = 1; s <= 12; s += 1) {
    const paras = [`## Section ${s}`];
    for (let p = 1; p <= 4; p += 1) {
      paras.push(`Paragraph ${p} of section ${s} describes the Lakeside lot survey, the drainage plan and the fence line in plain words. `.repeat(5).trim());
    }
    sections.push(paras.join('\n\n'));
  }
  sections[6] += `\n\n${GATE}`;
  return sections.join('\n\n');
}

function setup(messages, history = {}) {
  const t = openTempStore();
  seedChat(t.store, { messages });
  const estimator = new TokenEstimator();
  const builder = new ContextBuilder({
    store: t.store,
    retriever: new Retriever({ store: t.store, estimator }),
    estimator,
    getSettings: () => ({ history }),
    now: () => BASE_TIME + 10 * DAY
  });
  return { t, builder, estimator };
}

describe('ContextBuilder', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('the tail is the last 8 user and assistant messages, verbatim and in order', async () => {
    const s = setup(Array.from({ length: 20 }, (_, i) => filler(i + 1)));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
    assert.strictEqual(out.tail[0].text, filler(13).text);
    assert.deepStrictEqual({ fromSeq: out.stats.tail.fromSeq, toSeq: out.stats.tail.toSeq }, { fromSeq: 13, toSeq: 20 });
    assert.deepStrictEqual(out.stats.tail.seqs, [13, 14, 15, 16, 17, 18, 19, 20]);
    assert.strictEqual(out.stats.estTokens.tail, out.tail.reduce((n, m) => n + s.estimator.estimate(m.text), 0));
  });

  it('stops at tailTokens but always keeps the newest message', async () => {
    const s = setup(Array.from({ length: 6 }, (_, i) => filler(i + 1)), { recall: { tailTokens: 40 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [5, 6]);
    // The newest message (#6, an assistant reply) is kept by the budget, but
    // a tail never starts with an assistant message, so it is empty.
    s.builder.getSettings = () => ({ history: { recall: { tailTokens: 1 } } });
    assert.deepStrictEqual((await s.builder.build({ chatId: 'chat-1', message: 'x' })).tail.map((m) => m.seq), []);
  });

  it('never starts the tail with an assistant message (Mistral and Gemini reject it)', async () => {
    // tailTokens: the budget ends on #2, an assistant reply; #1 is too big.
    const s = setup([
      { sender: 'user', text: 'Here is the whole survey for the Lakeside lot. '.repeat(40) },
      { sender: 'assistant', text: 'Noted, the survey is long.' },
      { sender: 'user', text: 'What is the fence length?' },
      { sender: 'assistant', text: 'The north fence is forty meters.' }
    ], { recall: { tailTokens: 60 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and the gate?' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [3, 4]);
    assert.strictEqual(out.stats.tail.fromSeq, 3);
    assert.ok(!out.stats.tail.seqs.includes(2));

    // tailMessages: the 8th message back is an assistant reply.
    const n = setup(Array.from({ length: 9 }, (_, i) => filler(i + 1)));
    t.cleanup();
    t = n.t;
    const nine = await n.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(nine.tail.map((m) => m.seq), [3, 4, 5, 6, 7, 8, 9]);
    assert.strictEqual(nine.tail[0].sender, 'user');
  });

  it('folds tool calls into the reply that follows them; tool results stay out', async () => {
    const s = setup([
      { sender: 'user', text: 'Please run the tests for the Lakeside project now.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'npm test' } },
      { sender: 'toolResult', toolName: 'Bash', result: { stdout: 'all 12 tests passed' } },
      { sender: 'toolUse', toolName: 'Read', parameters: { file_path: 'src/app.js' } },
      { sender: 'assistant', text: 'All tests pass and src/app.js looks fine.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'thanks' });
    assert.deepStrictEqual(out.tail.map((m) => m.sender), ['user', 'assistant']);
    assert.strictEqual(out.tail[1].text, '[tool] Bash: npm test\n[tool] Read: src/app.js\n\nAll tests pass and src/app.js looks fine.');
    assert.deepStrictEqual(out.stats.tail.seqs, [1, 2, 4, 5]);
    s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolCalls: false } } });
    assert.strictEqual((await s.builder.build({ chatId: 'chat-1', message: 'thanks' })).tail[1].text, 'All tests pass and src/app.js looks fine.');
  });

  it('a stopped empty reply is left out and its tool calls are not given to the next reply', async () => {
    const s = setup([
      { sender: 'user', text: 'Start the drainage report for the Lakeside lot.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'make report' } },
      { sender: 'assistant', text: '', stopped: true },
      { sender: 'user', text: 'Never mind, just tell me the fence length.' },
      { sender: 'assistant', text: 'The north fence is forty meters long.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'ok' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 4, 5]);
    assert.ok(out.tail.every((m) => String(m.text).trim()), 'no empty messages');
    assert.strictEqual(out.tail[2].text, 'The north fence is forty meters long.');
    assert.ok(!out.stats.tail.seqs.includes(2));
  });

  it('shortens a tail message over tailMaxMessageTokens to its best chunks, with the marker', async () => {
    const s = setup([
      { sender: 'user', text: 'Please paste the full survey article for the Lakeside lot here.' },
      { sender: 'assistant', text: article() },
      { sender: 'user', text: 'Thanks, that is a lot to read through later tonight.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what is the side gate code?' });
    const long = out.tail.find((m) => m.seq === 2);
    const marker = long.text.match(/\[message #2 shortened: (\d+) of (\d+) paragraphs shown; ReadHistory 2 for the rest\]$/);
    assert.ok(marker, long.text.slice(-200));
    assert.ok(Number(marker[1]) < Number(marker[2]));
    assert.ok(long.text.includes('4417'), 'the chunk that matches the query is kept');
    assert.ok(s.estimator.estimate(long.text) <= 1500 + 40);
    assert.deepStrictEqual(out.stats.tail.shortened, [{ seq: 2, shown: Number(marker[1]), total: Number(marker[2]) }]);
  });

  it('the query is the new message and the previous two user messages, newest first', async () => {
    const s = setup([
      { sender: 'user', text: 'first user message' },
      { sender: 'assistant', text: 'a reply' },
      { sender: 'user', text: 'second user message' },
      { sender: 'assistant', text: 'another reply' },
      { sender: 'user', text: 'third user message' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'the new one' });
    assert.strictEqual(out.stats.query, 'the new one\nthird user message\nsecond user message');
  });

  it('recalls excerpts from beyond the tail, never from it, with the stats §7 needs', async () => {
    const messages = [filler(1), filler(2), { sender: 'user', text: GATE }];
    for (let i = 4; i <= 30; i += 1) messages.push(filler(i));
    messages.push({ sender: 'user', text: 'Also, the gate was painted green on Tuesday afternoon.' });
    const s = setup(messages);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what was the side gate code?' });
    assert.ok(out.recalled.text.startsWith('<recalled_history>\n'));
    assert.match(out.recalled.text, /\[#3 · user · \d+ days ago\]\nFor the record, the side gate code at the Lakeside lot is 4417\./);
    assert.deepStrictEqual(out.stats.recalledChunkIds, out.recalled.chunkIds);
    const recalledSeqs = t.store.chunks(out.recalled.chunkIds).map((c) => c.seq);
    const tailSeqs = new Set(out.tail.map((m) => m.seq));
    assert.ok(recalledSeqs.every((seq) => !tailSeqs.has(seq)), 'tail messages are not recalled');
    assert.strictEqual(out.recalled.estTokens, s.estimator.estimate(out.recalled.text));
    assert.strictEqual(out.stats.estTokens.recalled, out.recalled.estTokens);
    assert.ok(out.stats.recalledExcerpts >= 1);
    assert.strictEqual(out.stats.fullHistoryEstTokens, s.estimator.fromChars(t.store.historyChars('chat-1')));
    assert.strictEqual(out.stats.embedder, 'none');
    assert.strictEqual(out.stats.scope, 'chat');
  });

  it('enabled: false sends the tail only', async () => {
    const messages = [{ sender: 'user', text: GATE }];
    for (let i = 2; i <= 20; i += 1) messages.push(filler(i));
    const s = setup(messages, { recall: { enabled: false } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'gate code?' });
    assert.deepStrictEqual(out.recalled, { text: '', chunkIds: [], estTokens: 0 });
    assert.strictEqual(out.tail.length, 8);
  });

  it('an empty chat, or nothing that matches, gives an empty block', async () => {
    const s = setup([]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'anything' });
    assert.deepStrictEqual(out.tail, []);
    assert.strictEqual(out.recalled.text, '');
    assert.deepStrictEqual(out.stats.tail, { fromSeq: null, toSeq: null, seqs: [], shortened: [] });
  });

  it('nothing at or after upToSeq reaches the tail, the block or the counts', async () => {
    const messages = [];
    for (let i = 1; i <= 30; i += 1) {
      messages.push(i < 20 ? filler(i) : { sender: i % 2 ? 'user' : 'assistant', text: `Later note ${i}: the zanzibar-17 marker and the filler word appear only from seq 20 on.` });
    }
    const s = setup(messages);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'zanzibar-17 filler note', upToSeq: 20 });
    assert.ok(out.tail.every((m) => m.seq < 20));
    assert.strictEqual(out.stats.tail.toSeq, 19);
    assert.ok(out.tail.every((m) => !m.text.includes('zanzibar-17')));
    assert.ok(out.recalled.chunkIds.length > 0, 'fillers 1-11 are recallable');
    assert.ok(t.store.chunks(out.recalled.chunkIds).every((c) => c.seq < 20));
    assert.ok(!out.recalled.text.includes('zanzibar-17'));
    assert.strictEqual(out.stats.fullHistoryEstTokens, s.estimator.fromChars(t.store.historyChars('chat-1', { upToSeq: 20 })));
  });
});

describe('ContextBuilder: the tail scan reads only what the tail needs', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const BIG = 'x'.repeat(50000);
  const chat = () => [
    { sender: 'user', text: 'Write the survey notes for the Lakeside lot to a file.' },
    { sender: 'toolUse', toolName: 'Write', parameters: { file_path: 'notes/survey.md', content: BIG } },
    { sender: 'toolResult', toolName: 'Write', result: { ok: true, output: BIG } },
    { sender: 'status', text: 'Working…' },
    { sender: 'assistant', text: 'The survey notes are written.' }
  ];

  it('tailScanPage: seq descending, no tool results or status rows, tool calls only when asked', () => {
    t = openTempStore();
    seedChat(t.store, { messages: chat() });
    const without = t.store.tailScanPage('chat-1', { beforeSeq: 6, limit: 10 });
    assert.deepStrictEqual(without.map((m) => [m.seq, m.sender]), [[5, 'assistant'], [1, 'user']]);
    const withCalls = t.store.tailScanPage('chat-1', { beforeSeq: 6, limit: 10, toolCalls: true });
    assert.deepStrictEqual(withCalls.map((m) => [m.seq, m.sender]), [[5, 'assistant'], [2, 'toolUse'], [1, 'user']]);
    assert.strictEqual(withCalls[1].toolName, 'Write');
    assert.strictEqual(withCalls[1].parameters.file_path, 'notes/survey.md');
    assert.strictEqual(withCalls[1].result, undefined);
    assert.deepStrictEqual(t.store.tailScanPage('chat-1', { beforeSeq: 5, limit: 1 }).map((m) => m.seq), [1], 'a page is keyed by beforeSeq');
  });

  it('build() never loads the full rows of the range', async () => {
    const s = setup(chat());
    t = s.t;
    const original = t.store._messagesFor.bind(t.store);
    t.store._messagesFor = (chatId, range = {}) => {
      if (range.fromSeq !== range.toSeq) throw new Error(`full range read ${range.fromSeq}-${range.toSeq}`);
      return original(chatId, range);
    };
    const out = await s.builder.build({ chatId: 'chat-1', message: 'thanks' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 5]);
    assert.strictEqual(out.tail[1].text, '[tool] Write: notes/survey.md\n\nThe survey notes are written.');
  });
});
