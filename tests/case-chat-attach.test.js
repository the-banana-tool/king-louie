// Owner decision Q29 (2026-10-12): a chat that holds management-tool results
// about a case other than the one it is being attached to cannot be attached
// to a case (management surfaces spec §3.1). The rows are written here as the
// chat send path writes them: a toolUse row before the call and a toolResult
// row after it, from the executor's own events.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { initializeTools } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const { createCaseToolHandler } = require('../src/mcp/case-tools');
const { CASE_MCP_TOOLS } = require('../src/cases/mcp-tool-definitions');
const { historyContext } = require('./helpers/history-context');
const {
  attachBlock, assertChatAttachable, ChatAttachRefusedError, CASE_DATA_TOOLS,
  SAW_OTHER_CASES_MESSAGE, UNVERIFIABLE_MESSAGE, CHAT_BUSY_MESSAGE
} = require('../src/cases/chat-attach');

initializeTools();

const dirs = [];
const stores = [];
after(() => {
  for (const s of stores) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

// A cases root with two cases, a chat store with one chat, the case IPC over
// both, and `turn(extra)`: an executor wired to the chat as the send path
// wires it (chat-handlers.js: preExecute and postExecute append the rows).
async function setup({ running = null } = {}) {
  const runtime = new CaseRuntime({ root: tmp('kl-attach-') });
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const shed = await runtime.createCase({ title: 'Garden shed', objective: 'Build a shed' });
  for (const c of [lot, shed]) runtime.store.updateMeta(c.id, { status: 'active' });
  runtime.playbooks = { summary: () => [] };
  const roof = runtime.createQuestion(shed.id, { kind: 'question', urgency: 'normal', payload: { type: 'ask' }, text: 'Metal or shingle roof?' }, { charge: false });
  const history = historyContext([{ id: 'chat-1', title: 'Chat', messages: [] }]);
  stores.push(history.getHistoryStore());
  const context = { getCaseRuntime: () => runtime, ...history, ...(running ? { isChatRunning: running } : {}) };
  const handlers = new Map();
  registerCaseHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, context);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const caseManagement = createCaseToolHandler({
    getRuntime: () => runtime,
    getContact: () => ({ presenceStatus: () => ({ presentChannel: 'in-app', away: false, quiet: false }) }),
    channel: 'in-app-chat'
  });
  const turn = ({ ownerTurnText = null, ...extra } = {}, chatId = 'chat-1') => {
    const executor = new ToolExecutor({
      workingDirectory: tmp('kl-attach-cwd-'), requireApproval: true, useSandbox: false, ownerTurnText, approvalRequester: async () => true,
      extraToolOptions: { caseManagement, ...extra }
    });
    executor.on('preExecute', ({ toolName, parameters }) => history.appendMessageToChat(chatId, 'toolUse', '', { toolName, parameters, runId: 'r1' }, { returnChat: false }));
    executor.on('postExecute', ({ toolName, result }) => history.appendMessageToChat(chatId, 'toolResult', '', { toolName, result, runId: 'r1' }, { returnChat: false }));
    return executor;
  };
  const row = (sender, toolName, fields) => history.appendMessageToChat('chat-1', sender, '', { toolName, ...fields, runId: 'r1' }, { returnChat: false });
  const attach = (caseId, chatId = 'chat-1') => call(IPC.CASE_ATTACH, { chatId, caseId });
  return { runtime, lot, shed, roof, history, call, turn, row, attach };
}

const refusedOtherCases = (res) => {
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'CHAT_SAW_OTHER_CASES');
  assert.strictEqual(res.error, SAW_OTHER_CASES_MESSAGE);
};

describe('attaching a chat that used the management tools (Q29)', () => {
  it('the refusal says the chat has looked at other cases and a case needs a new chat', () => {
    assert.strictEqual(SAW_OTHER_CASES_MESSAGE, 'This chat has looked at other cases, so it cannot be attached to a case. Start a new chat for the case.');
    const err = new ChatAttachRefusedError('other-cases', { toolName: 'list_cases', seq: 2 });
    assert.strictEqual(err.code, 'CHAT_SAW_OTHER_CASES');
    assert.strictEqual(err.message, SAW_OTHER_CASES_MESSAGE);
    assert.strictEqual(new ChatAttachRefusedError('unverifiable').message, UNVERIFIABLE_MESSAGE);
    assert.strictEqual(new ChatAttachRefusedError('unverifiable').code, 'CHAT_SAW_OTHER_CASES');
    assert.ok(!/force/i.test(SAW_OTHER_CASES_MESSAGE + UNVERIFIABLE_MESSAGE));
  });

  it('every case tool but get_presence and set_away counts as carrying case data', () => {
    const names = CASE_MCP_TOOLS.map((t) => t.name).filter((n) => n !== 'get_presence' && n !== 'set_away');
    assert.deepStrictEqual([...CASE_DATA_TOOLS].sort(), names.sort());
  });

  it('is refused after list_cases in the chat, and the chat stays unattached', async () => {
    const { turn, attach, lot, history } = await setup();
    const listed = await turn().execute('list_cases', {});
    assert.strictEqual(listed.result.length, 2);
    refusedOtherCases(await attach(lot.id));
    assert.ok(!history.getChat('chat-1').caseId);
  });

  it('is refused after open_case on another case, and allowed to that case itself', async () => {
    const { turn, attach, lot, shed, history } = await setup();
    assert.strictEqual((await turn().execute('open_case', { case: shed.id })).result.id, shed.id);
    refusedOtherCases(await attach(lot.id));
    const own = await attach(shed.id);
    assert.strictEqual(own.ok, true);
    assert.strictEqual(history.getChat('chat-1').caseId, shed.id);
  });

  it('is refused after each tool that reads or acts on another case', async () => {
    for (const [name, args] of [
      ['get_orientation', {}], ['list_envelopes', {}], ['list_playbooks', {}], ['list_questions', {}],
      ['answer_question', { question_id: 'q-0001', quote: 'metal roof, please' }],
      ['revoke_envelope', { envelope: 'env-01', quote: 'revoke that envelope' }],
      ['cancel_case_job', { job: 'job-0001', quote: 'cancel the running job' }]
    ]) {
      const { turn, attach, lot, shed, history } = await setup();
      await turn({ ownerTurnText: args.quote || null }).execute(name, { case: shed.id, ...args });
      assert.ok(history.getChat('chat-1').messages.some((m) => m.sender === 'toolUse' && m.toolName === name), `${name} stored its call`);
      refusedOtherCases(await attach(lot.id));
    }
  });

  it('is allowed after management-tool results about the target case only', async () => {
    const { turn, attach, shed, roof, history } = await setup();
    const executor = turn({ ownerTurnText: 'metal roof, please' });
    for (const name of ['open_case', 'get_orientation', 'list_envelopes', 'list_playbooks', 'list_questions']) {
      const res = await executor.execute(name, { case: shed.id });
      assert.strictEqual(res.ok, true, `${name}: ${res.error}`);
    }
    const answered = await executor.execute('answer_question', { case: shed.id, question_id: roof.id, quote: 'metal roof, please' });
    assert.strictEqual(answered.ok, true, answered.error);
    assert.strictEqual((await attach(shed.id)).ok, true);
    assert.strictEqual(history.getChat('chat-1').caseId, shed.id);
  });

  it('a call naming the target by its slug is not proof enough (a slug can be used again); by id it is', async () => {
    const { turn, attach, shed } = await setup();
    assert.strictEqual((await turn().execute('open_case', { case: 'garden-shed' })).result.id, shed.id);
    refusedOtherCases(await attach(shed.id));
  });

  it('is allowed for a chat with no management-tool results, and with get_presence and set_away only', async () => {
    const plain = await setup();
    plain.history.appendMessageToChat('chat-1', 'user', 'what cases do I have? list_cases open_case', {}, { returnChat: false });
    plain.row('toolUse', 'Read', { parameters: { file_path: 'notes.txt', case: plain.shed.id } });
    plain.row('toolResult', 'Read', { result: { success: true, content: 'list_cases' } });
    assert.strictEqual((await plain.attach(plain.lot.id)).ok, true);

    const { turn, attach, lot, row } = await setup();
    assert.strictEqual((await turn().execute('get_presence', {})).ok, true);
    row('toolUse', 'set_away', { parameters: { mode: 'email-only', until: '2026-10-13T08:00:00.000Z', quote: 'email only until morning' } });
    row('toolResult', 'set_away', { result: { ok: true, result: { away: true } } });
    row('toolUse', 'list_machines', { parameters: {} });
    row('toolResult', 'list_machines', { result: { ok: true, result: [{ name: 'node-a' }] } });
    assert.strictEqual((await attach(lot.id)).ok, true);
  });

  it('a list that names only the target case, or no case, does not block', async () => {
    const { turn, attach, lot, shed } = await setup();
    // As a chat once attached to the shed stored them (Q27 scopes the lists).
    const scoped = turn({ caseContext: { caseId: shed.id, dir: shed.dir } });
    assert.deepStrictEqual((await scoped.execute('list_cases', {})).result.map((r) => r.id), [shed.id]);
    assert.deepStrictEqual((await scoped.execute('list_questions', {})).result.map((r) => r.caseId), [shed.id]);
    refusedOtherCases(await attach(lot.id));
    assert.strictEqual((await attach(shed.id)).ok, true);

    assert.strictEqual(attachBlock([
      { seq: 1, sender: 'toolUse', toolName: 'list_cases', parameters: {} },
      { seq: 2, sender: 'toolResult', toolName: 'list_cases', result: { ok: true, result: [] } }
    ], null), null);
  });

  it('create_case from the chat: the case it made may take the chat; another case, or a similar-case list, may not', async () => {
    const made = await setup();
    const created = await made.turn({ ownerTurnText: 'start a case to sell the boat' })
      .execute('create_case', { title: 'Boat sale', objective: 'sell the boat', quote: 'start a case to sell the boat' });
    assert.strictEqual(created.ok, true, created.error);
    // The tool attaches no chat itself.
    assert.ok(!made.history.getChat('chat-1').caseId);
    refusedOtherCases(await made.attach(made.lot.id));
    assert.strictEqual((await made.attach(created.result.case_id)).ok, true);

    const similar = await setup();
    const refused = await similar.turn({ ownerTurnText: 'start a case to sell the lot' })
      .execute('create_case', { title: 'Lakeside lot', objective: 'sell the lot', quote: 'start a case to sell the lot' });
    assert.strictEqual(refused.code, 'similar_cases');
    assert.ok(refused.data.similar, 'the unscoped refusal lists the similar cases');
    refusedOtherCases(await similar.attach(similar.shed.id));

    // A refusal that carries nothing (no owner message this turn) does not block.
    const bare = await setup();
    const none = await bare.turn().execute('create_case', { title: 'Boat sale', objective: 'sell the boat', quote: 'start a case to sell the boat' });
    assert.ok(none.ok === false || none.success === false, JSON.stringify(none));
    assert.ok(!none.data);
    assert.strictEqual((await bare.attach(bare.lot.id)).ok, true);
  });

  it('refuses what it cannot tell: a result with no call, an unknown result shape, a child run that used the tools', async () => {
    const { lot, shed } = await setup();
    const use = (toolName, parameters, seq = 1) => ({ seq, sender: 'toolUse', toolName, parameters });
    const res = (toolName, result, seq = 2) => ({ seq, sender: 'toolResult', toolName, result });
    const reason = (rows, id = lot.id) => attachBlock(rows, id)?.reason ?? null;
    // A keyed result with no call row to say which case it concerns.
    assert.strictEqual(reason([res('get_orientation', { ok: true, result: { text: 'x' } })]), 'other-cases');
    assert.strictEqual(reason([use('get_orientation', { case: lot.id }), res('get_orientation', { ok: true, result: {} }), res('get_orientation', { ok: true, result: {} }, 3)]), 'other-cases');
    assert.strictEqual(reason([use('get_orientation', { case: lot.id }), res('get_orientation', { ok: true, result: {} })]), null);
    // A refusal before the call's own row (no owner message) carries nothing and needs no call.
    assert.strictEqual(reason([res('answer_question', { success: false, error: 'not_owner' })]), null);
    assert.strictEqual(reason([res('answer_question', { ok: false, error: 'option_ambiguous', code: 'option_ambiguous', data: { options: {} } })]), 'other-cases');
    // A call with no case, or a case that is not a string.
    assert.strictEqual(reason([use('open_case', {})]), 'other-cases');
    assert.strictEqual(reason([use('open_case', { case: [lot.id] })]), 'other-cases');
    assert.strictEqual(reason([use('open_case', null)]), 'other-cases');
    // A list whose stored result is not the tool's own shape (a hook's rewrite, an import).
    assert.strictEqual(reason([res('list_cases', 'two cases')]), 'other-cases');
    assert.strictEqual(reason([res('list_cases', { ok: true, result: [{ data: {} }] })]), 'other-cases');
    assert.strictEqual(reason([res('list_cases', undefined)]), 'other-cases');
    assert.strictEqual(reason([res('list_questions', { ok: true, result: [{ caseId: lot.id }, { caseId: shed.id }] })]), 'other-cases');
    assert.strictEqual(reason([res('list_questions', { ok: true, result: [{ caseId: lot.id }] })]), null);
    // A refusal before the tool ran carries nothing.
    assert.strictEqual(reason([res('list_cases', { success: false, error: 'Tool execution denied by user' })]), null);
    assert.strictEqual(reason([res('list_cases', { ok: false, error: 'Cases are not available here.' })]), null);
    assert.strictEqual(reason([res('list_cases', { ok: false, error: 'x', code: 'y', data: { anything: 1 } })]), 'other-cases');
    // With no target (a case about to be created) any case's data blocks.
    assert.strictEqual(reason([res('list_cases', { ok: true, result: [{ id: lot.id }] })], null), 'other-cases');
    assert.strictEqual(reason([use('open_case', { case: lot.id })], null), 'other-cases');

    // A sub-agent's reply is prose; the row records the tools it used.
    const spawn = (toolsUsed) => res('SpawnAgent', { success: true, agentId: 'main', content: 'done', ...(toolsUsed === undefined ? {} : { toolsUsed }) });
    assert.strictEqual(reason([spawn(['Read', 'Grep', 'get_presence'])]), null);
    assert.strictEqual(reason([spawn(['Read', 'list_cases'])]), 'unverifiable');
    assert.strictEqual(reason([spawn(['SpawnAgent'])]), 'unverifiable');
    assert.strictEqual(reason([spawn(['TaskStatus'])]), 'unverifiable');
    assert.strictEqual(reason([spawn(undefined)]), 'unverifiable');
    assert.strictEqual(reason([spawn([{ name: 'Read' }])]), 'unverifiable');
    assert.strictEqual(reason([res('SpawnAgent', { success: false, agentId: 'main', error: 'Sub-agent execution failed: 500' })]), null);
    // Another run's text with no record of its tools.
    assert.strictEqual(reason([res('TaskStatus', { ok: true, id: 't1', state: 'completed', result: 'There are two cases.' })]), 'unverifiable');
    assert.strictEqual(reason([res('TaskStatus', { ok: true, output: '[..] Result: two cases' })]), 'unverifiable');
    assert.strictEqual(reason([res('TaskStatus', { ok: true, tasks: [{ id: 't1' }], message: '1 background task(s)' })]), 'unverifiable');
    assert.strictEqual(reason([res('TaskStatus', { ok: true, id: 't1', state: 'running', error: null, result: null })]), null);
    assert.strictEqual(reason([res('TaskStatus', { ok: true, tasks: [], message: 'No background tasks.' })]), null);
    assert.strictEqual(reason([res('TaskStatus', { ok: false, error: 'Task not found: t9' })]), null);
    assert.strictEqual(reason([res('sessions_history', { sessionKey: 's', agentId: 'main', messages: [] })]), 'unverifiable');
    assert.strictEqual(reason([res('RemoteDispatch', { success: true, taskId: 't', status: 'done', content: 'x', peer: 'p' })]), 'unverifiable');
    assert.strictEqual(reason([res('RemoteDispatch', { success: false, error: 'Peer is required for dispatch action' })]), null);
    // The first blocking row is named, for the log.
    assert.deepStrictEqual(attachBlock([use('open_case', { case: shed.id }, 7)], lot.id), { reason: 'other-cases', toolName: 'open_case', seq: 7 });
    // Rows that are not tool rows are never read as one.
    assert.strictEqual(reason([{ seq: 1, sender: 'assistant', toolName: 'list_cases', text: 'list_cases', result: { ok: true, result: [{ id: shed.id }] } }]), null);
    // No message list to read is not a clean chat.
    assert.strictEqual(reason(null), 'other-cases');
    assert.throws(() => assertChatAttachable({ id: 'c', messages: [res('list_cases', 'x')] }, lot.id), (e) => e.code === 'CHAT_SAW_OTHER_CASES' && e.reason === 'other-cases');
    assert.throws(() => assertChatAttachable({ id: 'c' }, lot.id), (e) => e.code === 'CHAT_SAW_OTHER_CASES');
    assert.doesNotThrow(() => assertChatAttachable({ id: 'c', messages: [] }, lot.id));
  });

  it('a child run that read the cases blocks with its own sentence, through the IPC', async () => {
    const { attach, row, lot } = await setup();
    row('toolUse', 'SpawnAgent', { parameters: { task: 'summarise my cases' } });
    row('toolResult', 'SpawnAgent', { result: { success: true, agentId: 'main', content: 'Two cases: ...', toolsUsed: ['list_cases'] } });
    const res = await attach(lot.id);
    assert.deepStrictEqual([res.ok, res.code, res.error], [false, 'CHAT_SAW_OTHER_CASES', UNVERIFIABLE_MESSAGE]);
  });

  it('case:create with a chat checks the chat first: nothing is created, with or without force', async () => {
    const { turn, call, runtime, history } = await setup();
    await turn().execute('list_cases', {});
    for (const extra of [{}, { force: true }]) {
      refusedOtherCases(await call(IPC.CASE_CREATE, { title: 'Boat sale', objective: 'Sell the boat', chatId: 'chat-1', ...extra }));
    }
    // Before the similar-case question too: the owner is not asked to force a create that would be refused.
    refusedOtherCases(await call(IPC.CASE_CREATE, { title: 'Lakeside lot', objective: 'Sell the lot', chatId: 'chat-1' }));
    assert.strictEqual(runtime.listCases().length, 2);
    assert.ok(!history.getChat('chat-1').caseId);
    // Without a chat the create is unaffected, and a clean chat still attaches.
    const made = await call(IPC.CASE_CREATE, { title: 'Boat sale', objective: 'Sell the boat' });
    assert.strictEqual(made.ok, true);
    history.createChat({ id: 'chat-2', title: 'Fresh', messages: [] });
    const fresh = await call(IPC.CASE_CREATE, { title: 'Dock repair', objective: 'Fix the dock', chatId: 'chat-2' });
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(history.getChat('chat-2').caseId, fresh.case.id);
  });

  it('a chat that read one case cannot take a new case either', async () => {
    const { turn, call, shed, runtime } = await setup();
    await turn().execute('open_case', { case: shed.id });
    refusedOtherCases(await call(IPC.CASE_CREATE, { title: 'Boat sale', chatId: 'chat-1' }));
    assert.strictEqual(runtime.listCases().length, 2);
  });

  it('detaching is never refused, nor is attaching the case the chat already has', async () => {
    const { attach, lot, shed, history } = await setup();
    assert.strictEqual((await attach(lot.id)).ok, true);
    // Stored before Q29, say: another case's data in a chat that is already this case's.
    history.appendMessageToChat('chat-1', 'toolResult', '', { toolName: 'list_cases', result: { ok: true, result: [{ id: shed.id }] } }, { returnChat: false });
    assert.strictEqual((await attach(lot.id)).ok, true);
    assert.strictEqual((await attach(null)).chat.caseId, null);
    refusedOtherCases(await attach(lot.id));
  });

  it('is refused while a turn runs in the chat (its results would land after the check); a detach is not', async () => {
    assert.strictEqual(CHAT_BUSY_MESSAGE, 'A reply is still running in this chat. Attach the case when it has finished.');
    let busy = true;
    const { attach, call, lot, runtime, history } = await setup({ running: (chatId) => busy && chatId === 'chat-1' });
    const res = await attach(lot.id);
    assert.deepStrictEqual([res.ok, res.code, res.error], [false, 'CHAT_BUSY', CHAT_BUSY_MESSAGE]);
    const created = await call(IPC.CASE_CREATE, { title: 'Boat sale', chatId: 'chat-1' });
    assert.strictEqual(created.code, 'CHAT_BUSY');
    assert.strictEqual(runtime.listCases().length, 2);
    assert.strictEqual((await attach(null)).ok, true);
    busy = false;
    assert.strictEqual((await attach(lot.id)).ok, true);
    assert.strictEqual(history.getChat('chat-1').caseId, lot.id);
  });
});

describe('the other direction (Q27): a case chat cannot collect another case', () => {
  it('no management tool gives a chat attached to one case another case\'s data', async () => {
    const { turn, attach, lot, shed, roof, history } = await setup();
    assert.strictEqual((await attach(lot.id)).ok, true);
    const executor = turn({ caseContext: { caseId: lot.id, dir: lot.dir }, ownerTurnText: 'metal roof, please revoke that envelope and cancel the running job, and start a case to build a garden shed' });
    for (const [name, args] of [
      ['open_case', {}], ['get_orientation', {}], ['list_questions', {}], ['list_envelopes', {}], ['list_playbooks', {}],
      ['answer_question', { question_id: roof.id, quote: 'metal roof, please' }],
      ['revoke_envelope', { envelope: 'env-01', quote: 'revoke that envelope' }],
      ['cancel_case_job', { job: 'job-0001', quote: 'cancel the running job' }]
    ]) {
      for (const ref of [shed.id, 'garden-shed']) {
        const res = await executor.execute(name, { case: ref, ...args });
        assert.deepStrictEqual([res.ok, res.code, Object.hasOwn(res, 'data')], [false, 'other_case', false], `${name} ${ref}: ${res.error}`);
      }
    }
    assert.deepStrictEqual((await executor.execute('list_cases', {})).result.map((r) => r.id), [lot.id]);
    assert.deepStrictEqual((await executor.execute('list_questions', {})).result, []);
    const similar = await executor.execute('create_case', { title: 'Garden shed', objective: 'build a garden shed', quote: 'start a case to build a garden shed' });
    assert.deepStrictEqual([similar.code, Object.hasOwn(similar, 'data')], ['similar_cases', false]);
    // No stored result names the shed: only the refused calls' own parameters do.
    const stored = history.getChat('chat-1').messages.filter((m) => m.sender === 'toolResult');
    assert.strictEqual(stored.length, 19);
    const text = JSON.stringify(stored);
    for (const secret of [shed.id, 'Garden shed', 'garden-shed', 'Metal or shingle']) assert.ok(!text.includes(secret), secret);
    assert.strictEqual(roof.answer ?? null, null);
    // Those calls named the shed, so once detached the chat is not attached again (the rule does not pair a call with its refusal).
    assert.strictEqual((await attach(null)).ok, true);
    refusedOtherCases(await attach(shed.id));
    refusedOtherCases(await attach(lot.id));
  });
});
