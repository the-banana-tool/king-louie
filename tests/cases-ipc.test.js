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
});
