const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup({ withRuntime = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-ipc-'));
  dirs.push(root);
  const runtime = new CaseRuntime({ root });
  let chats = [{ id: 'chat-1', title: 'Chat', messages: [] }];
  const context = {
    getCaseRuntime: () => (withRuntime ? runtime : null),
    getChats: () => chats,
    setChats: (next) => { chats = next; }
  };
  const handlers = new Map();
  registerCaseHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, context);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { runtime, call, chats: () => chats };
}

describe('case IPC', () => {
  it('creates a case, attaches it to the chat, and lists it', async () => {
    const { call, chats } = setup();
    const created = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', objective: 'Convert the lot to cash', chatId: 'chat-1' });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.case.title, 'Lakeside lot');
    assert.strictEqual(created.case.status, 'draft');
    assert.strictEqual(chats()[0].caseId, created.case.id);
    const listed = await call(IPC.CASE_LIST);
    assert.deepStrictEqual(listed.cases.map((c) => c.id), [created.case.id]);
  });

  it('attaches, detaches and refuses unknown cases or chats', async () => {
    const { call, chats } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'A' });
    assert.strictEqual(chats()[0].caseId, undefined);
    assert.strictEqual((await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: c.id })).chat.caseId, c.id);
    assert.strictEqual((await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: null })).chat.caseId, null);
    const badCase = await call(IPC.CASE_ATTACH, { chatId: 'chat-1', caseId: 'nope' });
    assert.strictEqual(badCase.ok, false);
    assert.match(badCase.error, /Case not found/);
    const badChat = await call(IPC.CASE_ATTACH, { chatId: 'nope', caseId: c.id });
    assert.strictEqual(badChat.ok, false);
  });

  it('returns the orientation text', async () => {
    const { call } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'Lakeside lot' });
    const o = await call(IPC.CASE_ORIENTATION, { caseId: c.id });
    assert.strictEqual(o.ok, true);
    assert.match(o.text, /# Case: Lakeside lot/);
  });

  it('lets the owner flip disclosability', async () => {
    const { call, runtime } = setup();
    const { case: c } = await call(IPC.CASE_CREATE, { title: 'A' });
    const f = runtime.ledger(c.id).assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: { kind: 'document', ref: 'sources/payoff.pdf' } });
    const r = await call(IPC.CASE_SET_DISCLOSABLE, { caseId: c.id, factId: f.id, disclosable: true });
    assert.strictEqual(r.fact.disclosable, true);
    const bad = await call(IPC.CASE_SET_DISCLOSABLE, { caseId: c.id, factId: f.id, disclosable: 'yes' });
    assert.strictEqual(bad.ok, false);
  });

  it('refuses an empty title and reports a missing runtime', async () => {
    assert.strictEqual((await setup().call(IPC.CASE_CREATE, { title: '  ' })).ok, false);
    const r = await setup({ withRuntime: false }).call(IPC.CASE_LIST);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not available/);
  });

  it('checks the chat before creating a case, so a bad chatId leaves nothing behind', async () => {
    const { call } = setup();
    const created = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', chatId: 'nope' });
    assert.strictEqual(created.ok, false);
    assert.match(created.error, /Chat not found/);
    const listed = await call(IPC.CASE_LIST);
    assert.deepStrictEqual(listed.cases, []);
  });

  it('rejects a non-string, empty type or objective', async () => {
    const { call } = setup();
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'A', type: 123 })).ok, false);
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'A', type: '  ' })).ok, false);
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'A', objective: [] })).ok, false);
    assert.strictEqual((await call(IPC.CASE_CREATE, { title: 'A', objective: '  ' })).ok, false);
    const listed = await call(IPC.CASE_LIST);
    assert.deepStrictEqual(listed.cases, []);
  });
});

describe('case IPC, stage 2', () => {
  const { registerCaseUnattendedHandlers } = require('../src/ipc/case-unattended-handlers');

  function setup2() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-ipc2-'));
    dirs.push(root);
    const runtime = new CaseRuntime({ root, getSettings: () => ({ cases: { timeZone: 'UTC' } }), host: { interactive: () => true, notify: () => {} } });
    const handlers = new Map();
    registerCaseUnattendedHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getCaseRuntime: () => runtime });
    return { runtime, handlers, call: (channel, payload) => handlers.get(channel)({}, payload) };
  }

  async function activeCase(runtime, title = 'Lakeside lot') {
    const info = await runtime.createCase({ title, objective: 'Convert the lot to cash' });
    runtime.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    runtime.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    runtime.completeGating(info.id);
    return runtime.getCase(info.id);
  }

  it('registers the six channels', () => {
    const { handlers } = setup2();
    const channels = [IPC.CASE_QUESTIONS, IPC.CASE_ANSWER_QUESTION, IPC.CASE_ACKNOWLEDGE_BRIEFING, IPC.CASE_SET_STATUS, IPC.CASE_BUDGET, IPC.CASE_GRANT_BUDGET];
    assert.deepStrictEqual(channels, ['case:questions', 'case:answerQuestion', 'case:acknowledgeBriefing', 'case:setStatus', 'case:budget', 'case:grantBudget']);
    for (const ch of channels) assert.ok(handlers.has(ch), ch);
  });

  it('lists open questions except for done and abandoned cases, answers one, and refuses a second answer', async () => {
    const { runtime, call } = setup2();
    const a = await activeCase(runtime, 'Lot A');
    const b = await activeCase(runtime, 'Lot B');
    const qa = runtime.createQuestion(a.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    runtime.createQuestion(b.id, { kind: 'question', text: 'Who mows the verge?', urgency: 'low' });
    runtime.setStatus(b.id, 'done', { kind: 'owner', by: 'owner' });
    const listed = await call(IPC.CASE_QUESTIONS, {});
    assert.deepStrictEqual(listed.questions.map((q) => [q.id, q.caseId, q.caseTitle]), [[qa.id, a.id, 'Lot A']]);
    assert.strictEqual((await call(IPC.CASE_QUESTIONS, { caseId: a.id })).questions.length, 1);
    const answered = await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 'Yes, with the north lot' });
    assert.strictEqual(answered.ok, true);
    assert.strictEqual(runtime.ledger(a.id).view().facts.get(answered.factId).source.kind, 'question');
    const again = await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 'No' });
    assert.deepStrictEqual([again.ok, again.code, again.question.id], [false, 'ALREADY_ANSWERED', qa.id]);
    assert.match(again.error, /already answered via in-app/);
    assert.deepStrictEqual((await call(IPC.CASE_QUESTIONS, {})).questions, []);
    assert.strictEqual((await call(IPC.CASE_ANSWER_QUESTION, { caseId: a.id, questionId: qa.id, text: 7 })).ok, false);
  });

  it('acknowledges a briefing', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const b = runtime.createQuestion(c.id, { kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const r = await call(IPC.CASE_ACKNOWLEDGE_BRIEFING, { caseId: c.id, questionId: b.id });
    assert.deepStrictEqual([r.ok, r.question.answer.channel], [true, 'in-app']);
  });

  it('sets the status as the owner and refuses transitions the owner may not make', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const paused = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused', note: 'away this week' });
    assert.deepStrictEqual([paused.case.status, paused.case.statusReason.by, paused.case.statusReason.note], ['paused', 'owner', 'away this week']);
    assert.strictEqual((await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'active' })).case.status, 'active');
    const bad = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'draft' });
    assert.deepStrictEqual([bad.ok, bad.code], [false, 'BAD_TRANSITION']);
    assert.match((await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'sleeping' })).error, /Unknown status/);
  });

  it('ignores a renderer-supplied kind and always sets status as the owner', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const seenKinds = [];
    const original = runtime.setStatus.bind(runtime);
    runtime.setStatus = (id, status, opts) => {
      seenKinds.push(opts && opts.kind);
      return original(id, status, opts);
    };
    const r = await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused', kind: 'budget-grant' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(seenKinds, ['owner']);
  });

  it('reports the budget and validates grants before writing an owner-action fact', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    runtime.store.updateMeta(c.id, { budget: { usd: 1 } });
    runtime.onCrossings(c.id, 'usd', runtime.budget(c.id).charge('usd', 1.5).crossedNow);
    const b = await call(IPC.CASE_BUDGET, { caseId: c.id });
    assert.deepStrictEqual([b.ok, b.budget.usd.spent, b.budget.usd.limit, b.case.status, b.case.statusReason.kind], [true, 1.5, 1, 'paused', 'budget']);
    const refused = [
      [{ category: 'tokens', limit: 5 }, /Unknown budget category/],
      [{ category: 'usd', limit: 0 }, /above 0/],
      [{ category: 'usd', limit: '5' }, /above 0/],
      [{ category: 'usd', limit: 1.2 }, /above what the case has spent \(1\.5\)/],
      [{ category: 'deadline', limit: 'soon' }, /YYYY-MM-DD/],
      [{ category: 'turnsPerDay', limit: Infinity }, /above 0/]
    ];
    for (const [payload, re] of refused) {
      const r = await call(IPC.CASE_GRANT_BUDGET, { caseId: c.id, ...payload });
      assert.strictEqual(r.ok, false, JSON.stringify(payload));
      assert.match(r.error, re);
    }
    assert.strictEqual(runtime.ledger(c.id).query({ subject: 'budget' }).length, 0, 'refused grants write nothing');
    const granted = await call(IPC.CASE_GRANT_BUDGET, { caseId: c.id, category: 'usd', limit: 5 });
    assert.deepStrictEqual([granted.ok, granted.case.status, granted.budget.usd.limit], [true, 'active', 5]);
    assert.strictEqual(runtime.ledger(c.id).view().facts.get(granted.factId).source.kind, 'owner-action');
  });

  it('says the case is busy while another process holds its lock', async () => {
    const { runtime, call } = setup2();
    const c = await activeCase(runtime);
    const lock = path.join(c.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    try {
      assert.deepStrictEqual(await call(IPC.CASE_SET_STATUS, { caseId: c.id, status: 'paused' }), { ok: false, error: 'Case is busy with a wake-up; try again in a minute.' });
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});
