// tests/history-case-nudge.test.js
// The case nudge (recall spec §9, stage H4, owner ruling R-H4-5): a long
// chat with no case gets one status row with a button, once, only when the
// chat could be attached to a case, and the model is told nothing.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const ProviderFactory = require('../src/providers/provider-factory');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { bridgeOriginFor } = require('../src/history/bridge-origin');
const { attachBlock, recalledOtherChats } = require('../src/cases/chat-attach');
const { NUDGE_TEXT, NUDGE_ACTION, nudgeDue, canOfferCase, offerCaseNudge } = require('../src/cases/case-nudge');
const { chatHarness } = require('./helpers/chat-harness');
const { historyContext } = require('./helpers/history-context');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');

const CHAT_ID = 'c1';
// A stored management-tool result that names a case (Q29).
const LIST_CASES_ROW = ['toolResult', '', { toolName: 'list_cases', result: { ok: true, result: [{ id: 'case-lakeside', title: 'Lakeside lot', status: 'active' }] } }];
const RECALLED_ROW = ['assistant', 'The gate code is in the other chat.', { context: { recalledChats: ['b'] } }];

describe('the case nudge: the rule', () => {
  it('has the fixed text and action', () => {
    assert.strictEqual(NUDGE_TEXT, 'This chat is getting long. If it is about a task with decisions worth keeping, you can turn it into a case.');
    assert.strictEqual(NUDGE_ACTION, 'convertToCase');
  });

  it('nudgeDue: a chat with no case, not nudged before, at or past a threshold above 0', () => {
    const chat = { id: 'a', title: 'Fence' };
    assert.strictEqual(nudgeDue({ chat, userMessageCount: 40, threshold: 40 }), true);
    assert.strictEqual(nudgeDue({ chat, userMessageCount: 41, threshold: 40 }), true);
    assert.strictEqual(nudgeDue({ chat, userMessageCount: 39, threshold: 40 }), false);
    assert.strictEqual(nudgeDue({ chat, userMessageCount: 400, threshold: 0 }), false);
    assert.strictEqual(nudgeDue({ chat: { ...chat, caseId: 'case-1' }, userMessageCount: 40, threshold: 40 }), false);
    assert.strictEqual(nudgeDue({ chat: { ...chat, caseNudgedAt: '2026-10-01T00:00:00.000Z' }, userMessageCount: 40, threshold: 40 }), false);
    assert.strictEqual(nudgeDue({ chat: null, userMessageCount: 40, threshold: 40 }), false);
    for (const threshold of [-1, 1.5, '3', null, undefined, NaN]) {
      assert.strictEqual(nudgeDue({ chat, userMessageCount: 400, threshold }), false, String(threshold));
    }
    for (const userMessageCount of ['40', null, undefined, NaN]) {
      assert.strictEqual(nudgeDue({ chat, userMessageCount, threshold: 40 }), false, String(userMessageCount));
    }
  });

  it('canOfferCase: false for a bridge chat, an imported chat, and a chat that read other cases or other chats', () => {
    const deps = { bridgeOriginFor, attachBlock, recalledOtherChats };
    const plain = [{ seq: 1, sender: 'user', text: 'How long is the fence?' }, { seq: 2, sender: 'assistant', text: 'Forty meters.' }];
    const chat = { id: 'a', title: 'Fence' };
    assert.strictEqual(canOfferCase({ chat, messages: plain, ...deps }), true);
    assert.strictEqual(canOfferCase({ chat: { ...chat, origin: 'telegram' }, messages: plain, ...deps }), false);
    assert.strictEqual(canOfferCase({ chat: { ...chat, source: 'markdown-transcript' }, messages: plain, ...deps }), false);
    assert.strictEqual(canOfferCase({ chat: { ...chat, importedFromCase: true }, messages: plain, ...deps }), false);
    const sawCases = [...plain, { seq: 3, sender: 'toolResult', toolName: LIST_CASES_ROW[2].toolName, result: LIST_CASES_ROW[2].result }];
    assert.ok(attachBlock(sawCases, null), 'precondition: Q29 blocks this chat');
    assert.strictEqual(canOfferCase({ chat, messages: sawCases, ...deps }), false);
    const readChats = [...plain, { seq: 3, sender: 'assistant', text: RECALLED_ROW[1], ...RECALLED_ROW[2] }];
    assert.ok(recalledOtherChats(readChats, 'a'), 'precondition: R-H4-1 blocks this chat');
    assert.strictEqual(canOfferCase({ chat, messages: readChats, ...deps }), false);
    // Nothing to read, or a check that is missing: no offer.
    assert.strictEqual(canOfferCase({ chat, messages: null, ...deps }), false);
    assert.strictEqual(canOfferCase({ chat: null, messages: plain, ...deps }), false);
    assert.strictEqual(canOfferCase({ chat, messages: plain, attachBlock, recalledOtherChats }), false);
    assert.strictEqual(canOfferCase({ chat, messages: plain, bridgeOriginFor, attachBlock: () => { throw new Error('x'); }, recalledOtherChats }), false);
  });

  it('offerCaseNudge marks the chat even when a later step fails, and never throws', () => {
    const patches = [];
    const warnings = [];
    const base = {
      chatId: 'a',
      threshold: 1,
      store: { userMessageCount: () => 5 },
      updateChat: (id, patch) => { patches.push([id, patch]); return {}; },
      bridgeOriginFor,
      now: () => '2026-10-13T10:00:00.000Z',
      log: { warn: (m) => warnings.push(m) }
    };
    const chat = { id: 'a', title: 'Fence' };
    let reads = 0;
    const out = offerCaseNudge({
      ...base,
      getChat: (_id, o) => { reads += 1; if (o && o.messages) throw new Error('disk'); return chat; },
      appendMessageToChat: () => { throw new Error('never'); }
    });
    assert.strictEqual(out, null);
    assert.deepStrictEqual(patches, [['a', { caseNudgedAt: '2026-10-13T10:00:00.000Z' }]]);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(reads, 2);
    // No store: nothing at all.
    assert.strictEqual(offerCaseNudge({ ...base, store: null, getChat: () => { throw new Error('never'); } }), null);
    // The count cannot be read: logged, not marked.
    patches.length = 0;
    assert.strictEqual(offerCaseNudge({ ...base, store: { userMessageCount: () => { throw new Error('locked'); } }, getChat: () => chat }), null);
    assert.deepStrictEqual(patches, []);
    assert.strictEqual(warnings.length, 2);
    // The threshold may be a function; one that throws is logged, not thrown.
    assert.strictEqual(offerCaseNudge({ ...base, threshold: () => { throw new Error('settings'); }, getChat: () => chat }), null);
    assert.deepStrictEqual(patches, []);
    assert.strictEqual(warnings.length, 3);
    assert.strictEqual(offerCaseNudge({ ...base, threshold: () => 0, getChat: () => { throw new Error('never'); } }), null);
    assert.strictEqual(warnings.length, 3);
  });
});

describe('the case nudge: through the send path', () => {
  let server;
  const catalog = fixtureCatalog();
  const open = [];
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });
  afterEach(() => { for (const store of open.splice(0)) store.close(); });

  const openai = () => ProviderFactory.create('openai', 'sk-test-123456', { baseUrl: `${server.url}/openai/v1`, catalog });

  // The real send path over a real (in-memory) history store and the real
  // ContextBuilder; recall pinned to the tail so a request is the same
  // whatever the clock says.
  function setup({ threshold, chat = {}, rows = [], provider = openai(), overrides = {} } = {}) {
    const hc = historyContext([{ id: CHAT_ID, title: 'Fence planning', createdAt: '2026-10-01T09:00:00.000Z', messages: [], ...chat }]);
    const store = hc.getHistoryStore();
    open.push(store);
    for (const [sender, text, metadata] of rows) hc.appendMessageToChat(CHAT_ID, sender, text, metadata || {}, { returnChat: false });
    const history = { ...(threshold === undefined ? {} : { caseNudgeAfterUserTurns: threshold }), recall: { enabled: false, rerank: { enabled: false } } };
    const estimator = new TokenEstimator();
    const builder = new ContextBuilder({ store, retriever: new Retriever({ store, estimator }), estimator, getSettings: () => ({ history }) });
    const h = chatHarness({
      provider,
      providerType: 'openai',
      model: 'gpt-5.5',
      chat: { id: CHAT_ID },
      overrides: { ...hc, getContextBuilder: () => builder, getSettings: () => ({ history }), ...overrides }
    });
    const messages = () => store.getMessages(CHAT_ID);
    return {
      h,
      store,
      send: async (message) => {
        const from = server.requests.length;
        const result = await h.send({ message, agentMode: false });
        return { result, requests: server.requests.slice(from) };
      },
      chat: () => store.getChat(CHAT_ID, { messages: false }),
      messages,
      statusRows: () => messages().filter((m) => m.sender === 'status')
    };
  }

  const TURNS = ['How long is the north fence?', 'And the south one?', 'Which posts are loose?', 'Order twelve posts.', 'When do they arrive?'];

  it('R-H4-5: one status row at the threshold, never a second', async () => {
    const t = setup({ threshold: 3 });
    await t.send(TURNS[0]);
    await t.send(TURNS[1]);
    assert.deepStrictEqual(t.statusRows(), []);
    assert.strictEqual(t.chat().caseNudgedAt, undefined);

    const third = await t.send(TURNS[2]);
    const rows = t.statusRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].text, NUDGE_TEXT);
    assert.deepStrictEqual(rows[0].meta, { action: 'convertToCase' });
    assert.ok(!Number.isNaN(Date.parse(t.chat().caseNudgedAt)), 'caseNudgedAt is a time');
    // The row is after the reply, and the reply the renderer gets holds it.
    assert.deepStrictEqual(t.messages().slice(-2).map((m) => m.sender), ['assistant', 'status']);
    assert.strictEqual(third.result.ok, true);
    assert.deepStrictEqual(third.result.data.messages.slice(-2).map((m) => m.sender), ['assistant', 'status']);
    assert.strictEqual(third.result.data.messages.at(-1).meta.action, 'convertToCase');
    assert.ok(!t.h.sent.some((e) => JSON.stringify(e.payload ?? null).includes('getting long')), 'no event carries the nudge as a reply');

    const markedAt = t.chat().caseNudgedAt;
    await t.send(TURNS[3]);
    await t.send(TURNS[4]);
    assert.strictEqual(t.statusRows().length, 1);
    assert.strictEqual(t.chat().caseNudgedAt, markedAt);
    assert.strictEqual(t.store.userMessageCount(CHAT_ID), 5);
  });

  it('R-H4-5: the turn\'s prompt is the same with and without the nudge', async () => {
    const run = async (threshold) => {
      const t = setup({ threshold });
      const requests = [];
      for (const message of TURNS.slice(0, 4)) requests.push((await t.send(message)).requests);
      return { t, requests };
    };
    const nudged = await run(3);
    const off = await run(0);
    assert.strictEqual(nudged.t.statusRows().length, 1, 'precondition: the nudge was appended after the third turn');
    assert.deepStrictEqual(off.t.statusRows(), []);

    for (const index of [2, 3]) {
      const sent = nudged.requests[index];
      assert.strictEqual(sent.length, 1, 'one model call a turn');
      const text = JSON.stringify(sent[0].body);
      for (const piece of [NUDGE_TEXT, 'getting long', 'turn it into a case', 'convertToCase', 'worth keeping']) {
        assert.ok(!text.includes(piece), `turn ${index + 1}: ${piece}`);
      }
      assert.doesNotMatch(text, /\bcases?\b/i, `turn ${index + 1}: nothing about a case`);
      assert.ok(text.includes(TURNS[index]), 'precondition: this is the turn\'s request');
      // Byte for byte what a chat with the nudge off sends, on the turn that
      // nudges and on the one after it (the status row is then stored).
      assert.strictEqual(text, JSON.stringify(off.requests[index][0].body), `turn ${index + 1}`);
    }
  });

  const UNATTACHABLE = [
    ['a chat that holds a list_cases result naming a case', { rows: [LIST_CASES_ROW] }],
    ['a bridge chat', { chat: { origin: 'telegram' } }],
    ['an imported chat', { chat: { source: 'markdown-transcript' } }],
    ['a chat whose reply recalled from another chat', { rows: [RECALLED_ROW] }]
  ];
  for (const [name, options] of UNATTACHABLE) {
    it(`R-H4-5: a chat that could not be attached is marked and gets no row: ${name}`, async () => {
      const t = setup({ threshold: 2, ...options });
      await t.send(TURNS[0]);
      assert.strictEqual(t.chat().caseNudgedAt, undefined);
      await t.send(TURNS[1]);
      const markedAt = t.chat().caseNudgedAt;
      assert.ok(!Number.isNaN(Date.parse(markedAt)), 'marked');
      assert.deepStrictEqual(t.statusRows(), []);
      await t.send(TURNS[2]);
      await t.send(TURNS[3]);
      assert.deepStrictEqual(t.statusRows(), []);
      assert.strictEqual(t.chat().caseNudgedAt, markedAt);
    });
  }

  it('a chat with a case is never marked', async () => {
    const t = setup({ threshold: 1, chat: { caseId: 'case-lakeside' } });
    await t.send(TURNS[0]);
    await t.send(TURNS[1]);
    assert.strictEqual(t.chat().caseNudgedAt, undefined);
    assert.deepStrictEqual(t.statusRows(), []);
  });

  it('a stopped turn does not nudge; the next finished turn does', async () => {
    let t = null;
    let stopping = null;
    t = setup({ threshold: 1, overrides: { onSend: (channel) => { if (channel === 'chat:messageChunk' && !stopping) stopping = t.h.stop(); } } });
    server.setHold(true);
    try {
      await t.send(TURNS[0]);
    } finally {
      server.setHold(false);
    }
    assert.deepStrictEqual(await stopping, { ok: true });
    assert.strictEqual(t.messages().at(-1).stopped, true);
    assert.strictEqual(t.chat().caseNudgedAt, undefined);
    assert.deepStrictEqual(t.statusRows(), []);
    stopping = Promise.resolve();
    await t.send(TURNS[1]);
    assert.strictEqual(t.statusRows().length, 1);
  });

  it('a failed turn does not nudge', async () => {
    const provider = openai();
    provider.streamMessage = async () => { throw new Error('The provider is down.'); };
    const t = setup({ threshold: 1, provider });
    const { result } = await t.send(TURNS[0]);
    assert.strictEqual(result.ok, false, 'precondition: the turn failed');
    assert.ok(t.h.sent.some((e) => e.channel === 'chat:messageError'));
    assert.strictEqual(t.store.userMessageCount(CHAT_ID), 1);
    assert.strictEqual(t.chat().caseNudgedAt, undefined);
    assert.deepStrictEqual(t.statusRows(), []);
  });

  it('threshold 0 does nothing; an unset threshold is 40', async () => {
    const off = setup({ threshold: 0 });
    for (const message of TURNS) await off.send(message);
    assert.strictEqual(off.chat().caseNudgedAt, undefined);
    assert.deepStrictEqual(off.statusRows(), []);

    assert.strictEqual(mergeHistorySettings({}).caseNudgeAfterUserTurns, 40);
    const user = (i) => ['user', `Note ${i} about the Lakeside lot fence.`];
    const early = setup({ rows: Array.from({ length: 38 }, (_, i) => user(i)) });
    await early.send(TURNS[0]);
    assert.strictEqual(early.store.userMessageCount(CHAT_ID), 39);
    assert.strictEqual(early.chat().caseNudgedAt, undefined);
    await early.send(TURNS[1]);
    assert.strictEqual(early.statusRows().length, 1);
  });

  it('the status row is not the owner\'s words and is not indexed', async () => {
    const t = setup({ threshold: 1 });
    await t.send(TURNS[0]);
    const row = t.statusRows()[0];
    assert.ok(row, 'precondition: nudged');
    assert.strictEqual(t.store.userMessageCount(CHAT_ID), 1);
    assert.deepStrictEqual(t.store.chunksOfMessage(row.id), []);
    assert.deepStrictEqual(t.store.searchText('decisions worth keeping', { chatIds: [CHAT_ID] }), []);
  });
});
