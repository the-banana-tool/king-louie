// tests/history-context-builder.test.js
// Tail rules, shortening, the query, the recalled block, stats, enabled:
// false, and no leakage past upToSeq (recall spec §6.1–§6.4, §7, §13).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { ContextBuilder, FALLBACK_MAX_TURNS } = require('../src/history/context-builder');
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

  it('the tail is the last tailUserTurns user turns, verbatim and in order', async () => {
    const s = setup(Array.from({ length: 20 }, (_, i) => filler(i + 1)), { recall: { tailUserTurns: 4 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
    assert.strictEqual(out.tail[0].text, filler(13).text);
    assert.deepStrictEqual({ fromSeq: out.stats.tail.fromSeq, toSeq: out.stats.tail.toSeq }, { fromSeq: 13, toSeq: 20 });
    assert.deepStrictEqual(out.stats.tail.seqs, [13, 14, 15, 16, 17, 18, 19, 20]);
    assert.strictEqual(out.stats.estTokens.tail, out.tail.reduce((n, m) => n + s.estimator.estimate(m.text), 0));
  });

  it('by default the tail is the last 4 user turns, and no more', async () => {
    const s = setup(Array.from({ length: 40 }, (_, i) => filler(i + 1)));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), Array.from({ length: 8 }, (_, i) => 33 + i));
    assert.strictEqual(out.tail[0].sender, 'user');
    assert.strictEqual(out.stats.tail.userTurns, 4);
  });

  it('stops at tailTokens but always keeps the newest user message', async () => {
    const s = setup(Array.from({ length: 6 }, (_, i) => filler(i + 1)), { recall: { tailTokens: 40 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [5, 6]);
    // Nothing fits after the user message: it is still the tail (H2 sent an empty one).
    s.builder.getSettings = () => ({ history: { recall: { tailTokens: 1 } } });
    assert.deepStrictEqual((await s.builder.build({ chatId: 'chat-1', message: 'x' })).tail.map((m) => m.seq), [5]);
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

    // tailUserTurns: the 4th user turn back starts at #3.
    const n = setup(Array.from({ length: 9 }, (_, i) => filler(i + 1)), { recall: { tailUserTurns: 4 } });
    t.cleanup();
    t = n.t;
    const nine = await n.builder.build({ chatId: 'chat-1', message: 'hello' });
    assert.deepStrictEqual(nine.tail.map((m) => m.seq), [3, 4, 5, 6, 7, 8, 9]);
    assert.strictEqual(nine.tail[0].sender, 'user');
  });

  it('folds tool calls into the reply that follows them; with tailIncludeToolResults off, tool results stay out', async () => {
    const s = setup([
      { sender: 'user', text: 'Please run the tests for the Lakeside project now.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'npm test' } },
      { sender: 'toolResult', toolName: 'Bash', result: { stdout: 'all 12 tests passed' } },
      { sender: 'toolUse', toolName: 'Read', parameters: { file_path: 'src/app.js' } },
      { sender: 'assistant', text: 'All tests pass and src/app.js looks fine.' }
    ], { recall: { tailIncludeToolResults: false } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'thanks' });
    assert.deepStrictEqual(out.tail.map((m) => m.sender), ['user', 'assistant']);
    assert.strictEqual(out.tail[1].text, '[tool] Bash: npm test\n[tool] Read: src/app.js\n\nAll tests pass and src/app.js looks fine.');
    assert.deepStrictEqual(out.stats.tail.seqs, [1, 2, 4, 5]);
    s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolCalls: false, tailIncludeToolResults: false } } });
    assert.strictEqual((await s.builder.build({ chatId: 'chat-1', message: 'thanks' })).tail[1].text, 'All tests pass and src/app.js looks fine.');
  });

  it('a case question posted mid-turn never takes the turn\'s tool lines: they fold into the real reply', async () => {
    const question = { caseId: 'c-1', questionId: 'q-0001' };
    const askLine = '[tool] Ask: {"text":"Is the well shared?"}';
    const s = setup([
      { sender: 'user', text: 'Find out whether the Lakeside well is shared.' },
      { sender: 'toolUse', toolName: 'Ask', parameters: { text: 'Is the well shared?' } },
      { sender: 'assistant', text: 'Lakeside lot: Question q-0001\n\nIs the well shared?\n\nReply below.', question },
      { sender: 'toolResult', toolName: 'Ask', result: 'q-0001 asked' },
      { sender: 'assistant', text: 'I asked you whether the well is shared.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'yes' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 3, 5]);
    assert.strictEqual(out.tail[1].text, 'Lakeside lot: Question q-0001\n\nIs the well shared?\n\nReply below.');
    assert.strictEqual(out.tail[2].text, `${askLine}\n[tool result #4 Ask]\nq-0001 asked\n\nI asked you whether the well is shared.`);

    // A turn stopped after the question, with no reply: the lines stay with
    // the question rather than being lost.
    const stopped = setup([
      { sender: 'user', text: 'Find out whether the Lakeside well is shared.' },
      { sender: 'toolUse', toolName: 'Ask', parameters: { text: 'Is the well shared?' } },
      { sender: 'assistant', text: 'Is the well shared?', question }
    ], { recall: { tailIncludeToolResults: false } });
    t.cleanup();
    t = stopped.t;
    const cut = await stopped.builder.build({ chatId: 'chat-1', message: 'yes' });
    assert.strictEqual(cut.tail[1].text, `${askLine}\n\nIs the well shared?`);
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

  const queryChat = () => [
    { sender: 'user', text: 'first user message' },
    { sender: 'assistant', text: 'a reply' },
    { sender: 'user', text: 'second user message' },
    { sender: 'assistant', text: 'another reply' },
    { sender: 'user', text: 'third user message' }
  ];

  it('by default the query is the new message alone', async () => {
    const s = setup(queryChat());
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'the new one' });
    assert.strictEqual(out.stats.query, 'the new one');
  });

  it('with queryUserTurns 2, the query is the new message and the previous two user messages, newest first', async () => {
    const s = setup(queryChat(), { recall: { queryUserTurns: 2 } });
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
    assert.deepStrictEqual(out.tail.map((m) => m.seq), Array.from({ length: 8 }, (_, i) => 13 + i));
  });

  it('an empty chat, or nothing that matches, gives an empty block', async () => {
    const s = setup([]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'anything' });
    assert.deepStrictEqual(out.tail, []);
    assert.strictEqual(out.recalled.text, '');
    assert.deepStrictEqual(out.stats.tail, { fromSeq: null, toSeq: null, seqs: [], shortened: [], userTurns: 0 });
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

describe('ContextBuilder: tailIncludeToolResults (on by default)', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const LOG = Array.from({ length: 40 }, (_, i) => `drainage log line ${i} for the Lakeside lot north fence sensor`).join('\n');
  const chat = () => [
    { sender: 'user', text: 'Check the drainage sensor at the Lakeside lot and the gate status.' },
    { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat gate.txt' } },
    { sender: 'toolResult', toolName: 'Bash', result: 'side gate code 4417, gate closed' },
    { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat drainage.log' } },
    { sender: 'toolResult', toolName: 'Bash', result: LOG },
    { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'get', key: 'gate' } },
    { sender: 'toolResult', toolName: 'Vault', result: 'secret-value-never-shown' },
    { sender: 'assistant', text: 'The gate is closed and the drainage log looks normal.' }
  ];

  it('keeps a small result whole, shortens a big one with a note, excludes both from recall', async () => {
    const s = setup(chat(), { recall: { tailIncludeToolResults: true, tailToolResultMaxTokens: 100 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what was the gate code and the drainage log' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 8]);
    const reply = out.tail[1].text;
    assert.ok(reply.startsWith('[tool] Bash: cat gate.txt\n[tool result #3 Bash]\nside gate code 4417, gate closed\n[tool] Bash: cat drainage.log\n[tool result #5 Bash]\n'), reply);
    assert.ok(reply.includes('[tool result #5 shortened: the start is shown; ReadHistory 5 for the rest]'));
    assert.ok(!reply.includes('drainage log line 39'), 'the tail of the big result is cut');
    assert.ok(!reply.includes('secret-value-never-shown'), 'an unindexed tool result is never shown');
    assert.ok(reply.endsWith('\n\nThe gate is closed and the drainage log looks normal.'));
    assert.deepStrictEqual(out.stats.tail.seqs, [1, 2, 3, 4, 5, 6, 8]);
    assert.deepStrictEqual(out.stats.tail.toolResultSeqs, [3, 5]);
    assert.strictEqual(out.stats.tail.shortened.length, 1);
    const cut = out.stats.tail.shortened[0];
    assert.strictEqual(cut.seq, 5);
    assert.strictEqual(cut.toolResult, true);
    assert.ok(cut.shown < cut.total, `${cut.shown} of ${cut.total}`);
    assert.strictEqual(out.stats.estTokens.tail, out.tail.reduce((n, m) => n + s.estimator.estimate(m.text), 0));
    const recalledIds = t.store.chunks(out.recalled.chunkIds).map((c) => c.messageId);
    assert.ok(!recalledIds.includes('chat-1-m3') && !recalledIds.includes('chat-1-m5'), 'tail results are not recalled');

    s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolResults: false } } });
    const off = await s.builder.build({ chatId: 'chat-1', message: 'gate code' });
    assert.ok(!off.tail[1].text.includes('4417'), 'off: results stay out');
    assert.strictEqual(off.stats.tail.toolResultSeqs, undefined);
  });

  it('results get what user and assistant messages left of tailTokens, newest first; a user turn is never dropped for one', async () => {
    const big = (n) => `reading ${n}: ${'sensor value steady at the north fence '.repeat(12)}`;
    const messages = [
      { sender: 'user', text: 'Read the three sensors at the Lakeside lot.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'read a' } },
      { sender: 'toolResult', toolName: 'Bash', result: big('a') },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'read b' } },
      { sender: 'toolResult', toolName: 'Bash', result: big('b') },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'read c' } },
      { sender: 'toolResult', toolName: 'Bash', result: 'reading c: 12' },
      { sender: 'assistant', text: 'All three sensors read steady.' }
    ];
    const s = setup(messages, { recall: { tailIncludeToolResults: false } });
    t = s.t;
    // The user and assistant messages and the tool lines alone.
    const base = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    const lines = base.stats.estTokens.tail;
    const one = s.estimator.estimate(`[tool result #5 Bash]\n${big('b')}`);
    const small = s.estimator.estimate('[tool result #7 Bash]\nreading c: 12');
    // Room for the tail, #7 and #5, but not #3 as well.
    const tailTokens = lines + small + one + Math.floor(one / 2);
    s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolResults: true, tailToolResultMaxTokens: 1000, tailTokens } } });
    const out = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 8], 'both user and assistant messages stay');
    assert.deepStrictEqual(out.stats.tail.toolResultSeqs, [5, 7]);
    assert.deepStrictEqual(out.stats.tail.shortened, []);
    assert.ok(out.stats.estTokens.tail <= tailTokens, `${out.stats.estTokens.tail} > ${tailTokens}`);

    // A budget the user and assistant messages already fill leaves no result.
    const own = s.estimator.estimate(messages[0].text) + s.estimator.estimate(messages[7].text);
    s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolResults: true, tailTokens: own } } });
    const none = await s.builder.build({ chatId: 'chat-1', message: 'x' });
    assert.deepStrictEqual(none.tail.map((m) => m.seq), [1, 8]);
    assert.deepStrictEqual(none.stats.tail.toolResultSeqs, []);
  });

  it('a tail filled to the edge with results never exceeds tailTokens: joiners and notes are counted', async () => {
    // Many small results, several per reply, each exactly a whole number of
    // tokens as the tail shows it, so the '\n\n' and '\n' joiners are what
    // tips the total; then one shortened result with its note.
    const messages = [{ sender: 'user', text: 'Read the gauges at the Lakeside lot.' }];
    const result = (seq, body) => {
      const label = `[tool result #${seq} Bash]\n`;
      return `${body}${'.'.repeat((4 - ((label.length + body.length) % 4)) % 4)}`;
    };
    for (let r = 1; r <= 12; r += 1) {
      messages.push({ sender: 'toolResult', toolName: 'Bash', result: result(messages.length + 1, `gauge ${r}: ok`) });
      if (r % 4 === 0) messages.push({ sender: 'assistant', text: `Gauges up to ${r} are read.` });
    }
    messages.push({ sender: 'toolResult', toolName: 'Bash', result: 'long log line at the north fence '.repeat(20) });
    messages.push({ sender: 'assistant', text: 'All gauges read.' });
    const s = setup(messages, { recall: { tailIncludeToolResults: false } });
    t = s.t;
    const base = (await s.builder.build({ chatId: 'chat-1', message: 'x' })).stats.estTokens.tail;
    let folded = 0;
    for (let tailTokens = base; tailTokens <= base + 200; tailTokens += 1) {
      s.builder.getSettings = () => ({ history: { recall: { tailIncludeToolResults: true, tailToolResultMaxTokens: 30, tailTokens } } });
      const out = await s.builder.build({ chatId: 'chat-1', message: 'x' });
      assert.ok(out.stats.estTokens.tail <= tailTokens, `tailTokens ${tailTokens}: the tail is ${out.stats.estTokens.tail}`);
      folded = Math.max(folded, out.stats.tail.toolResultSeqs.length);
    }
    assert.strictEqual(folded, 13, 'with room, every result is folded in');
  });

  it('by default a result up to 1000 tokens is shown whole and a bigger one is shortened', async () => {
    const mid = Array.from({ length: 40 }, (_, i) => `fence post ${i} at the Lakeside lot leans two degrees north`).join('\n');
    const huge = Array.from({ length: 150 }, (_, i) => `drainage reading ${i} for the Lakeside lot ditch is steady`).join('\n');
    const s = setup([
      { sender: 'user', text: 'Survey the fence and read the drainage log for the Lakeside lot.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat fence.txt' } },
      { sender: 'toolResult', toolName: 'Bash', result: mid },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat drainage.log' } },
      { sender: 'toolResult', toolName: 'Bash', result: huge },
      { sender: 'assistant', text: 'The fence leans a little and the drainage is steady.' }
    ]);
    t = s.t;
    const midTokens = s.estimator.estimate(mid);
    const hugeTokens = s.estimator.estimate(huge);
    assert.ok(midTokens > 300 && midTokens <= 1000, `mid is ${midTokens} tokens`);
    assert.ok(hugeTokens > 1000, `huge is ${hugeTokens} tokens`);
    const out = await s.builder.build({ chatId: 'chat-1', message: 'how is the fence?' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 6]);
    const reply = out.tail[1].text;
    assert.ok(reply.includes(`[tool result #3 Bash]\n${mid}\n`), 'the mid-size result is whole');
    assert.ok(reply.includes('[tool result #5 shortened: the start is shown; ReadHistory 5 for the rest]'));
    assert.ok(reply.includes('drainage reading 0 '), 'the head of the big result is kept');
    assert.ok(!reply.includes('drainage reading 149 '), 'the rest of the big result is cut');
    assert.deepStrictEqual(out.stats.tail.toolResultSeqs, [3, 5]);
    assert.deepStrictEqual(out.stats.tail.shortened.map((x) => x.seq), [5]);
  });
});

describe('ContextBuilder: agent chats, one assistant row per tool round', () => {
  let t;
  afterEach(() => t && t.cleanup());
  // A user message, then `rounds` tool rounds, each a call, its result and an
  // assistant row.
  const agentChat = (rounds) => {
    const messages = [{ sender: 'user', text: 'Tidy up the drainage notes for the Lakeside lot, file by file.' }];
    for (let r = 1; r <= rounds; r += 1) {
      messages.push({ sender: 'toolUse', toolName: 'Read', parameters: { file_path: `notes/part-${r}.md` } });
      messages.push({ sender: 'toolResult', toolName: 'Read', result: `part ${r}: the ditch runs along the north fence` });
      messages.push({ sender: 'assistant', text: `Part ${r} is tidied.` });
    }
    return messages;
  };

  it('by default the tail reaches the user message behind ten assistant rows', async () => {
    const s = setup(agentChat(10));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    assert.strictEqual(out.tail.length, 11);
    assert.strictEqual(out.tail[0].seq, 1);
    assert.strictEqual(out.tail[0].sender, 'user');
    assert.ok(out.tail[1].text.startsWith('[tool] Read: notes/part-1.md\n[tool result #3 Read]\npart 1: the ditch runs along the north fence'), out.tail[1].text);

    // tailMaxRows 8: the user message and the newest seven replies; a tool
    // call is folded only into the reply that followed it.
    s.builder.getSettings = () => ({ history: { recall: { tailMaxRows: 8 } } });
    const capped = await s.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    assert.deepStrictEqual(capped.tail.map((m) => m.seq), [1, 13, 16, 19, 22, 25, 28, 31]);
    assert.ok(capped.tail[1].text.startsWith('[tool] Read: notes/part-4.md'), capped.tail[1].text);
    assert.ok(!capped.stats.tail.seqs.includes(8), 'round 3\'s call belongs to a reply that is not shown');
  });

  it('reaches the user message behind any number of tool rounds, keeping the newest replies that fit', async () => {
    const s = setup(agentChat(16));
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    assert.strictEqual(out.tail.length, 17, 'H2 sent an empty tail here');
    assert.strictEqual(out.tail[0].seq, 1);

    const s40 = setup(agentChat(40), { recall: { tailTokens: 200 } });
    t.cleanup();
    t = s40.t;
    const tight = await s40.builder.build({ chatId: 'chat-1', message: 'what is left?' });
    const seqs = tight.tail.map((m) => m.seq);
    assert.strictEqual(seqs[0], 1, 'the user message is always in');
    assert.ok(seqs.length > 1 && seqs.length < 41, `${seqs.length} rows`);
    assert.strictEqual(seqs.at(-1), 121, 'the newest reply');
    for (let i = 2; i < seqs.length; i += 1) assert.strictEqual(seqs[i] - seqs[i - 1], 3, 'the newest replies, contiguous');
    assert.strictEqual(tight.stats.tail.userTurns, 1);
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
    const s = setup(chat(), { recall: { tailIncludeToolResults: false } });
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

  it('with tailIncludeToolResults on, only the tail span\'s tool results are read', async () => {
    const rows = require('../src/history/rows');
    // Twenty older rounds, each with a big result, then the tail's round.
    const messages = [];
    for (let r = 1; r <= 20; r += 1) {
      messages.push({ sender: 'user', text: `Read survey part ${r} of the Lakeside lot.` });
      messages.push({ sender: 'toolUse', toolName: 'Read', parameters: { file_path: `survey/part-${r}.md` } });
      messages.push({ sender: 'toolResult', toolName: 'Read', result: `part ${r} ${BIG}` });
      messages.push({ sender: 'assistant', text: `Part ${r} is read.` });
    }
    const s = setup(messages, { recall: { tailUserTurns: 2, tailIncludeToolResults: true } });
    t = s.t;
    const original = t.store._messagesFor.bind(t.store);
    t.store._messagesFor = (chatId, range = {}) => {
      if (range.fromSeq !== range.toSeq) throw new Error(`full range read ${range.fromSeq}-${range.toSeq}`);
      return original(chatId, range);
    };
    const read = [];
    const toMessage = rows.rowToMessage;
    rows.rowToMessage = (row, attachments) => {
      const m = toMessage(row, attachments);
      if (m.sender === 'toolResult' && m.result !== undefined) read.push(m.seq);
      return m;
    };
    let out;
    try {
      out = await s.builder.build({ chatId: 'chat-1', message: 'thanks' });
    } finally {
      rows.rowToMessage = toMessage;
    }
    // The tail is rounds 19 and 20 (seqs 73-80); its results are #75 and #79.
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [73, 76, 77, 80]);
    assert.deepStrictEqual(out.stats.tail.toolResultSeqs, [75, 79]);
    assert.deepStrictEqual([...read].sort((a, b) => a - b), [75, 79], 'no result older than the tail is loaded');
  });

  it('a tail span with many large results reads them in small pages, newest first, and at most TAIL_RESULT_SCAN_MAX rows', async () => {
    const { TAIL_RESULT_SCAN_MAX, TAIL_RESULT_PAGE } = require('../src/history/context-builder');
    // One agent turn: 150 reads of large files, then the reply.
    const messages = [{ sender: 'user', text: 'Read every survey part of the Lakeside lot.' }];
    for (let r = 1; r <= 150; r += 1) {
      messages.push({ sender: 'toolUse', toolName: 'Read', parameters: { file_path: `survey/part-${r}.md` } });
      messages.push({ sender: 'toolResult', toolName: 'Read', result: `part ${r} ${'fence line survey notes '.repeat(400)}` });
    }
    messages.push({ sender: 'assistant', text: 'Every part is read.' });
    const s = setup(messages, { recall: { tailIncludeToolResults: true } });
    t = s.t;
    const pages = [];
    const original = t.store.tailToolResults.bind(t.store);
    t.store.tailToolResults = (chatId, options) => {
      const page = original(chatId, options);
      pages.push(page.map((m) => m.seq));
      return page;
    };
    const out = await s.builder.build({ chatId: 'chat-1', message: 'thanks' });
    const read = pages.flat();
    assert.ok(read.length <= TAIL_RESULT_SCAN_MAX, `${read.length} rows read`);
    assert.ok(pages.every((p) => p.length <= TAIL_RESULT_PAGE), 'each page is bounded');
    assert.deepStrictEqual(read, [...read].sort((a, b) => b - a), 'newest first');
    assert.strictEqual(read[0], 301, 'the newest result is read first');
    assert.ok(out.stats.tail.toolResultSeqs.length > 0);
    assert.ok(out.stats.tail.toolResultSeqs.every((seq) => read.includes(seq)));
  });
});

describe('ContextBuilder: attachments count toward the tail budget', () => {
  const { IMAGE_TOKEN_ESTIMATE } = require('../src/history/context-builder');
  let t;
  afterEach(() => t && t.cleanup());
  const image = (i) => ({ name: `photo-${i}.png`, mimeType: 'image/png', base64: 'aGVsbG8=' });
  const doc = (text) => ({ name: 'survey.txt', mimeType: 'text/plain', base64: 'aGVsbG8=', textContent: text });

  it('counts each image at IMAGE_TOKEN_ESTIMATE; an older message over the budget is left out, the newest keeps its images', async () => {
    assert.strictEqual(IMAGE_TOKEN_ESTIMATE, 1600);
    const s = setup([
      { sender: 'user', text: 'Here are three photos of the Lakeside fence.', images: [image(1), image(2), image(3)] },
      { sender: 'assistant', text: 'The fence posts lean to the north.' },
      { sender: 'user', text: 'And this is the gate.', images: [image(4)] },
      { sender: 'assistant', text: 'The gate hinge is rusted.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what now?' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [3, 4]);
    assert.strictEqual(out.tail[0].images.length, 1);
    assert.ok(out.stats.estTokens.tail >= IMAGE_TOKEN_ESTIMATE);

    const one = setup([{ sender: 'user', text: 'Five photos of the lot.', images: [1, 2, 3, 4, 5].map(image) }]);
    t.cleanup();
    t = one.t;
    const five = await one.builder.build({ chatId: 'chat-1', message: 'describe them' });
    assert.deepStrictEqual(five.tail.map((m) => m.seq), [1]);
    assert.strictEqual(five.tail[0].images.length, 5, 'images are never dropped from the newest message');
  });

  it('shortens a document that pushes its message over tailMaxMessageTokens, keeping its head, with a note', async () => {
    const body = Array.from({ length: 400 }, (_, i) => `Line ${i} of the survey: the drainage ditch runs along the fence.`).join('\n');
    const s = setup([
      { sender: 'user', text: 'Here is the survey document.', documents: [doc(body)] },
      { sender: 'assistant', text: 'I have read the survey.' }
    ]);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'what about drainage?' });
    assert.deepStrictEqual(out.tail.map((m) => m.seq), [1, 2]);
    const sent = out.tail[0].documents[0].textContent;
    assert.ok(sent.startsWith('Line 0 of the survey'));
    assert.match(sent, /\[document "survey\.txt" in message #1 shortened: the start is shown; SearchHistory finds the rest\]$/);
    assert.ok(s.estimator.estimate(out.tail[0].text) + s.estimator.estimate(sent) <= 1500 + 40);
    assert.strictEqual(out.tail[0].documents[0].name, 'survey.txt');
    assert.strictEqual(t.store.getMessages('chat-1', { fromSeq: 1, toSeq: 1 })[0].documents[0].textContent, body, 'the store keeps it whole');
    assert.deepStrictEqual(out.stats.tail.shortened, [{ seq: 1, documents: 1 }]);
    assert.ok(t.store.searchText('Line 399', { kinds: ['attachment'] }).length > 0, 'the rest is indexed');
  });
});

describe('ContextBuilder: the short follow-up fallback (spec §6.2)', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const chat = [
    { sender: 'user', text: 'What is the side gate code at the Lakeside lot?' },
    { sender: 'assistant', text: 'It is 4417.' },
    { sender: 'user', text: 'And the fence?' },
    { sender: 'assistant', text: 'Forty meters.' }
  ];

  it('is off by default: a short follow-up is the query alone', async () => {
    const s = setup(chat);
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and the other one?' });
    assert.strictEqual(out.stats.query, 'and the other one?');
    assert.strictEqual(out.stats.queryFallbackTurns, 0);
  });

  it('with queryFallbackMinChars, previous user messages are added until the query has that many letters and digits', async () => {
    const s = setup(chat, { recall: { queryFallbackMinChars: 20 } });
    t = s.t;
    // 14 letters, then "And the fence?" adds 11: 25 >= 20, stop.
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and the other one?' });
    assert.strictEqual(out.stats.query, 'and the other one?\nAnd the fence?');
    assert.strictEqual(out.stats.queryFallbackTurns, 1);
    const long = await s.builder.build({ chatId: 'chat-1', message: 'what was the drainage pipe diameter?' });
    assert.strictEqual(long.stats.query, 'what was the drainage pipe diameter?');
    assert.strictEqual(long.stats.queryFallbackTurns, 0);
  });

  it('adds at most FALLBACK_MAX_TURNS previous messages', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ sender: 'user', text: `ok ${i}` }));
    const s = setup(many, { recall: { queryFallbackMinChars: 1000 } });
    t = s.t;
    const out = await s.builder.build({ chatId: 'chat-1', message: 'and?' });
    assert.strictEqual(out.stats.queryFallbackTurns, FALLBACK_MAX_TURNS);
    assert.strictEqual(out.stats.query, 'and?\nok 5\nok 4\nok 3');
  });
});
