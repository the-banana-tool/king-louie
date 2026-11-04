// tests/tasks-case-attach.test.js
// A task chat and a case (tasks spec 2026-11-03 §4.3, §6): the chat can become
// a case, Q29 reads a task's rows as it reads any chat's, a client's words never
// count as the owner's, and while a task's turn runs the chat is busy to
// everything that asks. What an owner can do to a task chat, he does through the
// attached desktop, so the busy check is also tried through the bridge's context.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');
const { CaseRuntime } = require('../src/cases');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { HistoryStore, createChatFacade } = require('../src/history');
const { TaskManager } = require('../src/tasks/manager');
const { TaskStore } = require('../src/tasks/store');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { FleetToolHandler } = require('../src/fleet/fleet-tools');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const { registerHandlers } = require('../src/ipc/register');
const { LedgerTool } = require('../src/tools/builtin/case-tools');
const { SAW_OTHER_CASES_MESSAGE } = require('../src/cases/chat-attach');
const { tasksHarness } = require('./helpers/tasks-harness');
const { chatHarness } = require('./helpers/chat-harness');
const { historyContext } = require('./helpers/history-context');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { HAS_GIT } = require('./helpers/ingest-harness');
const { setLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-11-03T12:00:00.000Z';
const CLIENT_WORDS = 'Please wire the deposit to the harbor account today';
const OWNER_WORDS = 'Hold the deposit until the survey comes back';
const skip = HAS_GIT ? false : 'git is not on PATH';

const dirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
after(() => {
  closeOpenHistoryStores();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('a client\'s row keeps its author', () => {
  it('through a real store on disk: appended, read with the chat, read by another connection', async () => {
    const file = path.join(tmp('kl-task-row-'), 'history.sqlite');
    const historyStore = HistoryStore.open(file);
    let n = 0;
    const facade = createChatFacade({ historyStore, createId: () => `hc-${++n}` });
    const history = { ...facade, getHistoryStore: () => historyStore };
    const t = tasksHarness({ history, dataDir: tmp('kl-task-row-data-') });
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);

    const stored = t.rows(view.chat_id).find((m) => m.sender === 'user');
    assert.strictEqual(stored.text, CLIENT_WORDS);
    assert.strictEqual(stored.author, 'client');
    const withChat = history.getChat(view.chat_id, { messages: true }).messages.find((m) => m.sender === 'user');
    assert.strictEqual(withChat.author, 'client');
    const other = HistoryStore.open(file);
    try {
      assert.strictEqual(other.getMessages(view.chat_id).find((m) => m.sender === 'user').author, 'client');
    } finally {
      other.close();
    }
    historyStore.close();
  });
});

describe('attaching a task chat', { skip }, () => {
  // A task harness and the case IPC over one store; `registerChatHandlers` too,
  // over the same context, as register.js does. isTaskChatRunning as start.js sets it.
  async function setup({ script = [] } = {}) {
    const history = historyContext();
    const t = tasksHarness({ script, history, dataDir: tmp('kl-task-attach-') });
    const runtime = new CaseRuntime({ root: tmp('kl-task-cases-') });
    const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const shed = await runtime.createCase({ title: 'Garden shed', objective: 'Build a shed' });
    const begins = [];
    const beginTurn = runtime.beginTurn.bind(runtime);
    runtime.beginTurn = (...args) => { begins.push(args[0]); return beginTurn(...args); };
    const context = {
      ...history,
      getCaseRuntime: () => runtime,
      getSettings: () => ({}),
      isTaskChatRunning: (id) => t.manager.isChatRunning(id),
    };
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} };
    registerChatHandlers(ipcMain, context);
    registerCaseHandlers(ipcMain, context);
    const event = markLocalDesktopEvent({ sender: { send: () => {}, isDestroyed: () => false } });
    const call = (channel, payload) => handlers.get(channel)(event, payload);
    return { t, runtime, lot, shed, begins, context, call, history };
  }

  it('a task chat with no other case\'s data attaches, and it is not an imported chat', async () => {
    const { t, lot, call, history } = await setup();
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    const chat = history.getChat(view.chat_id, { messages: false });
    assert.strictEqual(chat.taskId, view.task_id);
    assert.strictEqual(chat.source, undefined);
    const r = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: lot.id });
    assert.notStrictEqual(r.ok, false, r.error);
    assert.strictEqual(history.getChat(view.chat_id, { messages: false }).caseId, lot.id);
  });

  it('a task\'s list_cases result about another case refuses CHAT_SAW_OTHER_CASES', async () => {
    let shedId = null;
    const { t, lot, shed, call } = await setup({
      script: [async (turn) => { turn.tool('list_cases', {}, { ok: true, result: [{ id: shedId, title: 'Garden shed' }] }); }],
    });
    shedId = shed.id;
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    const r = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: lot.id });
    assert.deepStrictEqual([r.ok, r.code, r.error], [false, 'CHAT_SAW_OTHER_CASES', SAW_OTHER_CASES_MESSAGE]);
  });

  it('a call of a task that names another case is refused as in any chat, though its result was a bare refusal', async () => {
    let lotId = null;
    const { t, lot, call } = await setup({
      script: [async (turn) => {
        turn.tool('list_cases', {}, { ok: true, result: [{ id: lotId, title: 'Lakeside lot' }] });
        turn.tool('answer_question', { case: 'somewhere' }, { ok: false, code: 'not_owner', error: 'only the owner' });
      }],
    });
    lotId = lot.id;
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    const r = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: lot.id });
    assert.deepStrictEqual([r.ok, r.code], [false, 'CHAT_SAW_OTHER_CASES']);
  });

  it('the rows of a task are read as those of any chat: the target alone passes, a bare not_owner refusal does not block', async () => {
    let lotId = null;
    const { t, lot, call } = await setup({
      script: [async (turn) => {
        turn.tool('list_cases', {}, { ok: true, result: [{ id: lotId, title: 'Lakeside lot' }] });
        turn.tool('answer_question', { case: lotId }, { ok: false, code: 'not_owner', error: 'only the owner' });
      }],
    });
    lotId = lot.id;
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    const r = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: lot.id });
    assert.notStrictEqual(r.ok, false, r.error);
  });

  describe('while a task\'s turn runs', () => {
    async function running() {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const s = await setup({ script: [async () => { await held; }] });
      const view = await s.t.manager.run({ text: CLIENT_WORDS });
      await s.t.started();
      return { ...s, view, release };
    }

    it('isChatRunning says so, for that chat alone, and stops when the turn ends', async () => {
      const { t, context, view, release } = await running();
      assert.strictEqual(context.isChatRunning(view.chat_id), true);
      assert.strictEqual(context.isChatRunning('some-other-chat'), false);
      release();
      await t.settled(t.manager, view.task_id);
      assert.strictEqual(context.isChatRunning(view.chat_id), false);
    });

    it('attach and create with the chat refuse CHAT_BUSY', async () => {
      const { t, lot, call, view, release, history } = await running();
      const attached = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: lot.id });
      assert.deepStrictEqual([attached.ok, attached.code], [false, 'CHAT_BUSY']);
      const created = await call(IPC.CASE_CREATE, { title: 'Harbor deposit', objective: 'Move the deposit', chatId: view.chat_id });
      assert.deepStrictEqual([created.ok, created.code], [false, 'CHAT_BUSY']);
      assert.strictEqual(history.getChat(view.chat_id, { messages: false }).caseId, undefined);
      release();
      await t.settled(t.manager, view.task_id);
    });

    it('chat:markPrivate refuses PRIVATE_CHAT_BUSY', async () => {
      const { t, call, view, release, history } = await running();
      const r = await call(IPC.CHAT_MARK_PRIVATE, { chatId: view.chat_id, confirm: true });
      assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_CHAT_BUSY']);
      assert.strictEqual(history.getHistoryStore().isPrivate(view.chat_id), false);
      release();
      await t.settled(t.manager, view.task_id);
    });

    it('chat:truncateFrom refuses CHAT_BUSY and removes nothing', async () => {
      const { t, call, view, release } = await running();
      const before = t.rows(view.chat_id).length;
      const r = await call(IPC.CHAT_TRUNCATE_FROM, { chatId: view.chat_id, fromIndex: 0 });
      assert.deepStrictEqual([r.ok, r.code], [false, 'CHAT_BUSY']);
      assert.strictEqual(t.rows(view.chat_id).length, before);
      release();
      await t.settled(t.manager, view.task_id);
    });

    it('an owner send is refused as a busy chat: no row, no case turn', async () => {
      const { t, call, view, release, begins } = await running();
      const before = t.rows(view.chat_id).length;
      const r = await call(IPC.CHAT_SEND_MESSAGE, { chatId: view.chat_id, message: OWNER_WORDS });
      assert.deepStrictEqual([r.ok, r.code], [false, 'CHAT_BUSY']);
      assert.match(r.error, /task is still running in this chat/);
      assert.strictEqual(t.rows(view.chat_id).length, before);
      assert.deepStrictEqual(begins, []);
      release();
      await t.settled(t.manager, view.task_id);
    });
  });
});

// Static, as the renderer's other tests are: a resend makes a new row from the text alone, with no
// author, so a client's words would come back as an owner's message.
describe('the window never re-sends a client\'s row as the owner\'s', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const block = (start, end = '\n}\n') => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    return src.slice(i, src.indexOf(end, i)).replace(/\r\n/g, '\n');
  };

  it('resend refuses before it truncates; Retry is not drawn and does not switch', () => {
    const resend = block('async function resendFromIndex(');
    const refused = resend.indexOf("userMsg.author === 'client'");
    assert.ok(refused > 0 && refused < resend.indexOf('truncateFrom('));
    assert.match(block('function renderRetryControl('), /messages\[lastUser\]\.author === 'client'\) return;/);
    const retry = block('async function retryWith(');
    const noRetry = retry.indexOf("chat.messages[index].author === 'client'");
    assert.ok(noRetry > 0 && noRetry < retry.indexOf('switchMainModel('));
  });
});

// Controller rulings 2026-11-03: the chat is the owner's now, so a client's send ends the task.
describe('a refused send stays on screen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const catchOf = (start) => {
    const body = src.slice(src.indexOf(start));
    const from = body.indexOf('  } catch (error) {\n    ', body.indexOf('window.electron.chat.sendMessage('));
    return body.slice(from, body.indexOf('  } finally {', from));
  };

  for (const start of ['async function sendMessage()', 'async function resendFromIndex(']) {
    it(`${start}: the redraw comes first, so it can neither wipe the bubble nor hide a stored error`, () => {
      const block = catchOf(start);
      const redraw = block.indexOf('refreshUI();');
      assert.ok(redraw > 0, 'it redraws');
      assert.ok(redraw < block.indexOf('const alreadyShown'), 'before the check');
      assert.ok(block.indexOf('const alreadyShown') < block.indexOf("addMessage('assistant'"));
      assert.strictEqual(block.lastIndexOf('refreshUI();'), redraw, 'and not after the bubble');
    });
  }

  it('sendMessage puts the words back only when no row of them was stored', () => {
    const block = catchOf('async function sendMessage()');
    assert.match(block, /!storedRow/);
    assert.match(block, /dom\.userInput\.value = message;/);
  });
});

describe('a send into a chat the owner has taken', () => {
  const STUCK = 'STUCK: I see the form, I tried the date, I need the date you meant.';
  const stuck = async () => ({ type: 'complete', content: STUCK });
  const ended = (err) => {
    assert.strictEqual(err.code, 'task_ended', err.message);
    return true;
  };
  const MARKS = {
    became_case: (t, chatId) => t.history.updateChat(chatId, { caseId: 'case-1' }),
    private: (t, chatId) => t.history.getHistoryStore().markPrivate(chatId),
  };

  async function waiting(extra = {}) {
    const t = tasksHarness({ script: [stuck], dataDir: tmp('kl-task-taken-'), ...extra });
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    assert.strictEqual(t.store.get(view.task_id).state, 'waiting');
    return { t, view };
  }

  for (const [reason, mark] of Object.entries(MARKS)) {
    it(`${reason}: a waiting task ends, nothing runs, no row, the node is free, and it keeps refusing`, async () => {
      const { t, view } = await waiting();
      mark(t, view.chat_id);
      const rows = t.rows(view.chat_id).length;
      await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), ended);
      assert.strictEqual(t.calls.length, 1, 'no turn');
      assert.strictEqual(t.rows(view.chat_id).length, rows, 'no row');
      const rec = t.store.get(view.task_id);
      assert.strictEqual(rec.state, 'cancelled');
      assert.strictEqual(rec.ended.reason, reason);
      assert.strictEqual(rec.answer.text, STUCK, 'the record keeps its answer');
      assert.deepStrictEqual(t.pushes, [{ kind: 'task_ended', id: view.task_id }]);
      await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), ended);
      assert.strictEqual(t.pushes.length, 1, 'told once');
      const next = await t.manager.run({ text: 'Another task' });
      await t.settled(t.manager, next.task_id);
      assert.strictEqual(t.store.get(next.task_id).state, 'done');
      assert.ok(!JSON.stringify([t.pushes, t.audits]).includes('wire the deposit'), 'no push or audit entry holds the words');
    });

    it(`${reason}: a done task stays done, says why, and refuses`, async () => {
      const t = tasksHarness({ dataDir: tmp('kl-task-taken-') });
      const view = await t.manager.run({ text: CLIENT_WORDS });
      await t.settled(t.manager, view.task_id);
      const endedAt = t.store.get(view.task_id).ended.at;
      t.time.advance(60000);
      mark(t, view.chat_id);
      await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), ended);
      const rec = t.store.get(view.task_id);
      assert.strictEqual(rec.state, 'done');
      assert.strictEqual(rec.ended.reason, reason);
      assert.strictEqual(rec.ended.at, endedAt, 'it ended when it ended');
      assert.strictEqual(t.calls.length, 1);
      assert.strictEqual(t.pushes.length, 1, 'its ending was told when it ended');
    });

    it(`${reason}: an interrupted task ends the same, with no turn from start()`, async () => {
      const { t, view } = await waiting();
      t.store.update(view.task_id, { state: 'interrupted' });
      mark(t, view.chat_id);
      const fresh = t.build();
      await fresh.start();
      assert.strictEqual(fresh.isChatRunning(view.chat_id), false);
      await assert.rejects(fresh.send(view.task_id, OWNER_WORDS), ended);
      assert.strictEqual(t.store.get(view.task_id).state, 'cancelled');
      assert.strictEqual(t.calls.length, 1);
    });
  }

  for (const [reason, state, mark] of [
    ['became_case', 'cancelled', MARKS.became_case],
    ['private', 'cancelled', MARKS.private],
    ['chat_deleted', 'failed', (t, chatId) => t.history.deleteChat(chatId)],
  ]) {
    it(`${reason}: a waiting task its client never sends to does not hold the node: a second client's run ends it and runs`, async () => {
      const { t, view } = await waiting();
      assert.equal(await t.manager.run({ text: 'Too soon' }).catch((err) => err.code), 'task_busy');
      mark(t, view.chat_id);
      const next = await t.manager.run({ text: 'Another task' });
      const rec = t.store.get(view.task_id);
      assert.deepStrictEqual([rec.state, rec.ended.reason], [state, reason]);
      await t.settled(t.manager, next.task_id);
      assert.strictEqual(t.store.get(next.task_id).state, 'done');
      assert.strictEqual(t.pushes.filter((p) => p.id === view.task_id).length, 1, 'told once');
    });
  }

  it('the sweep leaves an untaken waiting task alone, and a task whose turn is running', async () => {
    const { t, view } = await waiting();
    await assert.rejects(t.manager.run({ text: 'Too soon' }), (err) => err.code === 'task_busy');
    assert.strictEqual(t.store.get(view.task_id).state, 'waiting');
  });

  it('a chat marked private: get, list and cancel carry private: true, the id and the state, and no words', async () => {
    const { t, view } = await waiting();
    MARKS.private(t, view.chat_id);
    const check = (seen) => {
      assert.strictEqual(seen.private, true);
      assert.strictEqual(seen.task_id, view.task_id);
      assert.strictEqual(typeof seen.state, 'string');
      for (const key of ['text', 'answer', 'proposal', 'grant', 'placement', 'spend']) assert.strictEqual(seen[key], null, key);
      assert.ok(!/wire the deposit|STUCK/.test(JSON.stringify(seen)));
    };
    check(await t.manager.get(view.task_id));
    check((await t.manager.list())[0]);
    check(await t.manager.cancel(view.task_id));
  });

  it('what a client reads through the tools: text and answer are null, not wrapped', async () => {
    const { t, view } = await waiting();
    MARKS.private(t, view.chat_id);
    const handler = { tasks: t.manager, heldTask: FleetToolHandler.prototype.heldTask };
    const got = await FleetToolHandler.prototype.runTaskTool.call(handler, 'get_task', { task_id: view.task_id });
    assert.deepStrictEqual([got.private, got.text, got.answer], [true, null, null]);
    const listed = await FleetToolHandler.prototype.runTaskTool.call(handler, 'list_tasks', {});
    assert.deepStrictEqual([listed.tasks[0].private, listed.tasks[0].text], [true, null]);
    assert.ok(!JSON.stringify([got, listed]).includes('wire the deposit'));
  });

  it('a mark that cannot be read: a client reads nothing, and the task is not ended', async () => {
    const { t, view } = await waiting();
    const before = t.store.get(view.task_id);
    const { egressFor } = t.core.context;
    t.core.context.egressFor = () => { throw new Error('unreadable'); };
    assert.strictEqual((await t.manager.get(view.task_id)).private, true);
    await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), (err) => {
      assert.strictEqual(err.code, 'task_busy');
      assert.ok(err.data.retry_after > 0);
      return true;
    });
    assert.deepStrictEqual(t.store.get(view.task_id), before, 'the record is as it was');
    delete t.core.context.egressFor;
    assert.strictEqual((await t.manager.get(view.task_id)).private, true, 'no way to read it is no answer either');
    t.core.context.egressFor = egressFor;
    assert.strictEqual((await t.manager.get(view.task_id)).private, undefined, 'readable again, and readable by the client');
  });

  it('the core\'s own answer for a mark it could not read ends nothing either', async () => {
    const { t, view } = await waiting();
    const before = t.store.get(view.task_id);
    const { egressFor } = t.core.context;
    t.core.context.egressFor = () => ({ localOnly: true, reason: 'unknown-mark', chatId: view.chat_id, caseId: null });
    assert.strictEqual((await t.manager.get(view.task_id)).private, true, 'as a mark, it is private');
    await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), (err) => err.code === 'task_busy');
    assert.deepStrictEqual(t.store.get(view.task_id), before);
    t.core.context.egressFor = egressFor;
  });

  it('a chat that will not read: the send is refused and the record is as it was; the next send runs', async () => {
    const { t, view } = await waiting();
    const before = t.store.get(view.task_id);
    const { getChat } = t.core.context;
    t.core.context.getChat = () => { throw new Error('database is locked'); };
    await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), (err) => {
      assert.strictEqual(err.code, 'task_busy');
      assert.ok(err.data.retry_after > 0);
      return true;
    });
    assert.deepStrictEqual(t.store.get(view.task_id), before);
    assert.strictEqual(t.pushes.length, 0, 'nothing ended, so the phone hears nothing');
    t.core.context.getChat = getChat;
    const sent = await t.manager.send(view.task_id, OWNER_WORDS);
    assert.ok(['running', 'done'].includes(sent.state));
    await t.settled(t.manager, view.task_id);
  });

  it('a chat that will not read: another task\'s run_task sweeps past it, and it stays', async () => {
    const { t, view } = await waiting();
    const before = t.store.get(view.task_id);
    const { getChat } = t.core.context;
    t.core.context.getChat = () => { throw new Error('database is locked'); };
    await assert.rejects(t.manager.run({ text: 'Another task' }), (err) => err.code === 'task_busy');
    assert.deepStrictEqual(t.store.get(view.task_id), before);
    t.core.context.getChat = getChat;
  });

  it('what ends it is an answer: a chat that is gone, a case, a private mark', async () => {
    const marks = {
      chat_deleted: (t, id) => t.history.deleteChat(id),
      became_case: (t, id) => t.history.updateChat(id, { caseId: 'case-1' }),
      private: (t, id) => t.history.getHistoryStore().markPrivate(id),
    };
    for (const [reason, mark] of Object.entries(marks)) {
      const { t, view } = await waiting();
      mark(t, view.chat_id);
      await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), ended);
      assert.strictEqual(t.store.get(view.task_id).ended.reason, reason);
    }
  });

  it('an ordinary chat is not withheld and carries no private key', async () => {
    const { t, view } = await waiting();
    const seen = await t.manager.get(view.task_id);
    assert.strictEqual(seen.text, CLIENT_WORDS);
    assert.strictEqual('private' in seen, false);
  });
});

describe('a task\'s chat deleted during its turn', () => {
  it('a reply after the delete: failed, chat_deleted, no throw, no answer, the node is free', async () => {
    let t = null;
    let chatId = null;
    t = tasksHarness({
      dataDir: tmp('kl-task-del-'),
      script: [async () => { t.history.deleteChat(chatId); return { type: 'complete', content: 'all finished' }; }],
    });
    const run = t.manager.run({ text: CLIENT_WORDS });
    chatId = t.store.list()[0].chat_id;
    const view = await run;
    await t.settled(t.manager, view.task_id);
    const rec = t.store.get(view.task_id);
    assert.strictEqual(rec.state, 'failed');
    assert.strictEqual(rec.ended.reason, 'chat_deleted');
    assert.strictEqual(rec.answer, null);
    assert.deepStrictEqual(t.pushes, [{ kind: 'task_ended', id: view.task_id }]);
    const next = await t.manager.run({ text: 'Another task' });
    await t.settled(t.manager, next.task_id);
    assert.strictEqual(t.store.get(next.task_id).state, 'done');
  });

  it('a tool call after the delete cuts the turn at once', async () => {
    let t = null;
    let chatId = null;
    t = tasksHarness({
      dataDir: tmp('kl-task-del-'),
      script: [async (turn) => {
        t.history.deleteChat(chatId);
        turn.tool('Read', { path: 'x' });
        await turn.aborted();
        return { type: 'stopped', content: '(Session stopped by user)' };
      }],
    });
    const run = t.manager.run({ text: CLIENT_WORDS });
    chatId = t.store.list()[0].chat_id;
    const view = await run;
    await t.settled(t.manager, view.task_id);
    const rec = t.store.get(view.task_id);
    assert.deepStrictEqual([rec.state, rec.ended.reason], ['failed', 'chat_deleted']);
  });

  it('a turn that failed as well: the real failure is logged, the ending is chat_deleted', async () => {
    let t = null;
    let chatId = null;
    t = tasksHarness({
      dataDir: tmp('kl-task-del-'),
      script: [async () => { t.history.deleteChat(chatId); throw Object.assign(new Error('the provider fell over'), { code: 'PROVIDER_DOWN' }); }],
    });
    const warned = [];
    const remove = addSink((r) => { if (r.level === 'warn') warned.push(JSON.stringify(r)); });
    setLogLevel('warn');
    try {
      const run = t.manager.run({ text: CLIENT_WORDS });
      chatId = t.store.list()[0].chat_id;
      const view = await run;
      await t.settled(t.manager, view.task_id);
      assert.strictEqual(t.store.get(view.task_id).ended.reason, 'chat_deleted');
    } finally {
      setLogLevel('fatal');
      remove();
    }
    assert.ok(warned.some((line) => line.includes('the provider fell over')), warned.join('\n'));
  });

  it('a chat deleted between turns: a send ends the task failed, chat_deleted', async () => {
    const t = tasksHarness({ dataDir: tmp('kl-task-del-'), script: [async () => ({ type: 'complete', content: 'STUCK: need a date' })] });
    const view = await t.manager.run({ text: CLIENT_WORDS });
    await t.settled(t.manager, view.task_id);
    t.history.deleteChat(view.chat_id);
    await assert.rejects(t.manager.send(view.task_id, OWNER_WORDS), (err) => err.code === 'task_ended');
    const rec = t.store.get(view.task_id);
    assert.deepStrictEqual([rec.state, rec.ended.reason], ['failed', 'chat_deleted']);
  });
});

describe('the send path\'s own runs still count', () => {
  it('isChatRunning is true for an owner turn, with no task manager on the node', async () => {
    let during = null;
    const h = chatHarness({
      overrides: {
        runHookEvent: async () => {
          during = h.context.isChatRunning('chat-1');
          return { action: 'deny', message: 'not now' };
        },
      },
    });
    await h.send();
    assert.strictEqual(during, true);
    assert.strictEqual(h.context.isChatRunning('chat-1'), false);
  });

  it('a task running in another chat does not make this one busy', async () => {
    const h = chatHarness({
      provider: { getProviderName: () => 'openai', streamMessage: async () => ({ text: 'ok' }) },
      overrides: { isTaskChatRunning: (id) => id === 'chat-other' },
    });
    const r = await h.send();
    assert.notStrictEqual(r.code, 'CHAT_BUSY');
    assert.ok(h.chat.messages.some((m) => m.sender === 'user' && m.text === 'Hello'));
  });
});

describe('a task chat on a real core', { skip }, () => {
  let box;
  let dataDir;
  let core;
  let ctx;
  const originalFetch = globalThis.fetch;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  const fetched = [];
  const sent = () => fetched.filter((f) => f.method !== 'GET');
  const sender = { send: () => {}, isDestroyed: () => false };
  const windowEvent = () => markLocalDesktopEvent({ sender });

  before(async () => {
    box = await startFakeLlmServer();
    box.setModels([{ id: 'chat-model' }]);
    box.setReply('chat-model', 'Noted.');
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      fetched.push({ url: String(url), method });
      if (method === 'GET' && /api\.openai\.com\/v1\/models/.test(String(url))) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`no network in unit tests (${method} ${url})`);
    };
    delete process.env.KL_CASES_ROOT;
    dataDir = tmp('kl-task-core-');
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', {
      models: {
        localServers: [{
          id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${box.url}/vllm`, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
          pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT,
        }],
        profiles: [
          { id: 'p-hosted', name: 'Hosted', kind: 'user', roles: { main: [{ provider: 'openai', model: 'gpt-5.5', effort: null }], worker: [], utility: [] } },
          { id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'local', model: 'workstation/chat-model', effort: null }], worker: [], utility: [] } },
        ],
        defaultProfileId: 'p-hosted',
        overrides: { 'local:workstation/chat-model': { toolCall: true } },
      },
      cases: { timeZone: 'UTC' },
    });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() },
    });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    await core.start();
    ctx = core.context;
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  });
  beforeEach(() => { fetched.length = 0; });

  // A TaskManager on the real core. `scripted` answers the first turns in order; after those, the
  // core's own agent adapter runs the turn. One task per manager and its own records.
  function taskNode({ scripted = [], delegate = { agent: 'main' } } = {}) {
    const steps = [...scripted];
    const real = () => ctx.getAgentExecutorAdapter();
    const adapter = { execute: (agent, message, options) => (steps.length ? Promise.resolve(steps.shift()) : real().execute(agent, message, options)) };
    const dir = tmp('kl-task-node-');
    const store = new TaskStore({ dataDir: dir });
    const manager = new TaskManager({
      core: { context: { ...ctx, getAgentExecutorAdapter: () => adapter } },
      nodeConfig: { name: 'node-a', delegate },
      dataDir: dir,
      store,
    });
    const settled = async (id) => {
      for (let i = 0; i < 2000; i += 1) {
        const rec = store.get(id);
        if (!manager.isChatRunning(rec.chat_id)) return rec;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
      throw new Error('the turn never ended');
    };
    return { manager, store, settled };
  }

  const STUCK = { type: 'complete', content: 'STUCK: I see the form, I tried the date, I need the date you meant.' };

  function ipcOver(context) {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} };
    registerChatHandlers(ipcMain, context);
    registerCaseHandlers(ipcMain, context);
    return (channel, payload) => handlers.get(channel)(windowEvent(), payload);
  }

  let n = 0;
  async function activeCase() {
    n += 1;
    const rt = ctx.getCaseRuntime();
    const c = await rt.createCase({ title: `Harbor deposit ${n}`, objective: `Settle deposit number ${n}`, force: true });
    rt.store.updateMeta(c.id, { status: 'active' });
    await rt.setModelChoice(c.id, { profile: 'p-local' });
    return { rt, c };
  }

  it('the first case turn of an attached task chat takes only the owner\'s words: a Ledger quote of the client\'s is refused, of the owner\'s passes', async () => {
    const { manager, settled, store } = taskNode({ scripted: [STUCK] });
    const view = await manager.run({ text: CLIENT_WORDS });
    await settled(view.task_id);
    assert.strictEqual(store.get(view.task_id).state, 'waiting');

    const { rt, c } = await activeCase();
    const seen = [];
    const ledger = [];
    const call = ipcOver({
      ...ctx,
      createToolExecutorWithApprovals: async (event, env, requester, options) => {
        seen.push({ ownerMessages: options.caseContext.ownerMessages, times: options.caseContext.ownerMessageTimes, ownerTurnText: options.ownerTurnText });
        // While the case turn is live, as a model's Ledger call would be.
        const opts = { caseContext: options.caseContext };
        const assert_ = (quote, value) => LedgerTool.execute({ action: 'assert', stmt: `Deposit instruction ${value}`, subject: 'deposit', attr: `instruction-${value}`, value, provenance: 'user', quote }, opts);
        ledger.push(await assert_(CLIENT_WORDS, 'wire'));
        ledger.push(await assert_('wire the deposit', 'wire-part'));
        ledger.push(await assert_(OWNER_WORDS, 'hold'));
        return ctx.createToolExecutorWithApprovals(event, env, requester, options);
      },
    });
    const attached = await call(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: c.id });
    assert.notStrictEqual(attached.ok, false, attached.error);

    const r = await call(IPC.CHAT_SEND_MESSAGE, { chatId: view.chat_id, message: OWNER_WORDS });
    assert.notStrictEqual(r.ok, false, r.error);

    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].ownerMessages, [OWNER_WORDS]);
    assert.strictEqual(seen[0].times.length, 1);
    assert.strictEqual(seen[0].ownerTurnText, OWNER_WORDS);
    assert.strictEqual(ledger[0].ok, false);
    assert.match(ledger[0].error, /quote|owner/i);
    assert.strictEqual(ledger[1].ok, false);
    assert.strictEqual(ledger[2].ok, true, ledger[2].error);
    assert.deepStrictEqual(
      rt.ledger(c.id).query({ subject: 'deposit', provenance: 'user' }).map((f) => f.value),
      ['hold'],
    );
  });

  it('marked private between turns, a send ends the task and runs nothing; the view holds no words', async () => {
    const { manager, settled, store } = taskNode({ scripted: [STUCK] });
    const view = await manager.run({ text: CLIENT_WORDS });
    await settled(view.task_id);
    assert.strictEqual((await manager.get(view.task_id)).text, CLIENT_WORDS, 'an ordinary chat on a real core shows its words');
    const call = ipcOver({ ...ctx });
    const marked = await call(IPC.CHAT_MARK_PRIVATE, { chatId: view.chat_id, confirm: true });
    assert.strictEqual(marked.ok, true, marked.error);
    const before = ctx.getMessages(view.chat_id).length;
    await assert.rejects(manager.send(view.task_id, 'The date is the fourth'), (err) => err.code === 'task_ended');
    assert.strictEqual(ctx.getMessages(view.chat_id).length, before);
    const rec = store.get(view.task_id);
    assert.strictEqual(rec.state, 'cancelled');
    assert.strictEqual(rec.ended.reason, 'private');
    const seen = await manager.get(view.task_id);
    assert.deepStrictEqual([seen.private, seen.text, seen.answer], [true, null, null]);
    assert.deepStrictEqual(sent(), []);
  });

  // A send no longer gets this far, but a turn of a private chat is still held by its own policy.
  it('the adapter refuses a private chat\'s run, a node\'s delegate provider and model or not', async () => {
    const { manager, settled } = taskNode({ scripted: [STUCK] });
    const view = await manager.run({ text: CLIENT_WORDS });
    await settled(view.task_id);
    assert.strictEqual(ctx.getHistoryStore().markPrivate(view.chat_id).marked, true);
    const run = (extra) => ctx.getAgentExecutorAdapter().execute({ id: 'main' }, 'hello', { ...extra, executorOptions: { chatId: view.chat_id } });
    await assert.rejects(run({}), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
    await assert.rejects(run({ provider: 'openai', model: 'gpt-5.5' }), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
    assert.deepStrictEqual(sent(), []);
  });

  it('a chat in a private case is covered: marked by the case, or by case.yaml alone', async () => {
    for (const mark of [
      (rt, id) => rt.markPrivate(id),
      (rt, id) => rt.store.updateMeta(id, { private: true }),
    ]) {
      const { manager, settled, store } = taskNode({ scripted: [STUCK] });
      const view = await manager.run({ text: CLIENT_WORDS });
      await settled(view.task_id);
      const { rt, c } = await activeCase();
      const attached = await ipcOver({ ...ctx })(IPC.CASE_ATTACH, { chatId: view.chat_id, caseId: c.id });
      assert.notStrictEqual(attached.ok, false, attached.error);
      assert.strictEqual((await manager.get(view.task_id)).text, CLIENT_WORDS, 'not private yet');
      await mark(rt, c.id);
      const seen = await manager.get(view.task_id);
      assert.deepStrictEqual([seen.private, seen.text, seen.state], [true, null, 'waiting']);
      await assert.rejects(manager.send(view.task_id, 'go on'), (err) => err.code === 'task_ended');
      assert.strictEqual(store.get(view.task_id).state, 'cancelled');
    }
  });

  // The bridge builds its context once, when the service opens the bridge, before the fleet starts
  // (run.js), and its handlers read that copy. isTaskChatRunning comes and goes on core.context.
  it('through the bridge\'s context: a task manager that starts after the bridge, and stops, is seen', async () => {
    const handlers = new Map();
    const dispatcher = createBridgeDispatcher({
      core,
      dataDir,
      account: 'LOCAL SERVICE',
      getServiceInfo: () => ({ version: '26.9.0' }),
      getConnection: () => null,
      registerHandlers: (ipc, context) => registerHandlers({
        handle: (channel, fn) => { handlers.set(channel, fn); ipc.handle(channel, fn); },
        on: ipc.on,
        removeHandler: ipc.removeHandler,
      }, context),
    });
    assert.ok(dispatcher);
    const invoke = (channel, payload) => handlers.get(channel)(windowEvent(), payload);
    const chatId = `task-chat-${crypto.randomUUID()}`;
    ctx.createChat({ id: chatId, title: 'A task', createdAt: AT, updatedAt: AT, messages: [], taskId: 'task-1' });
    const { c } = await activeCase();

    ctx.isTaskChatRunning = (id) => id === chatId;
    try {
      const refused = await invoke(IPC.CHAT_SEND_MESSAGE, { chatId, message: OWNER_WORDS });
      assert.deepStrictEqual([refused.ok, refused.code], [false, 'CHAT_BUSY']);
      const attached = await invoke(IPC.CASE_ATTACH, { chatId, caseId: c.id });
      assert.deepStrictEqual([attached.ok, attached.code], [false, 'CHAT_BUSY']);
      const marked = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
      assert.deepStrictEqual([marked.ok, marked.code], [false, 'PRIVATE_CHAT_BUSY']);
    } finally {
      delete ctx.isTaskChatRunning;
    }
    const attached = await invoke(IPC.CASE_ATTACH, { chatId, caseId: c.id });
    assert.notStrictEqual(attached.ok, false, attached.error);
  });
});
