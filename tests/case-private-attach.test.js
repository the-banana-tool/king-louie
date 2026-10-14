// tests/case-private-attach.test.js
// Attaching a chat to a case under the private mark (local inference spec
// 2026-10-13 §8.2; R-LI-23: one mark, on the case; its chats follow): a
// private chat attaches only to a private case, or makes the case private in
// the same action when the owner confirms it (`makeCasePrivate`); an
// ordinary chat attached to a private case becomes private; case:create with
// a private chat creates the case private. The older refusals still come
// first.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { assertChatAttachable, PrivateCaseRequiredError } = require('../src/cases/chat-attach');
const { historyContext } = require('./helpers/history-context');
const { HAS_GIT } = require('./helpers/ingest-harness');

const dirs = [];
const stores = [];
after(() => {
  for (const s of stores) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

async function setup() {
  const runtime = new CaseRuntime({ root: tmp('kl-private-attach-') });
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const shed = await runtime.createCase({ title: 'Garden shed', objective: 'Build a shed' });
  for (const c of [lot, shed]) runtime.store.updateMeta(c.id, { status: 'active' });
  runtime.playbooks = { summary: () => [] };
  const history = historyContext([
    { id: 'chat-open', title: 'Open chat', messages: [] },
    { id: 'chat-private', title: 'Private chat', messages: [] },
    { id: 'chat-new', title: 'New case chat', messages: [] }
  ]);
  stores.push(history.getHistoryStore());
  history.getHistoryStore().markPrivate('chat-private');
  const context = { getCaseRuntime: () => runtime, ...history };
  const handlers = new Map();
  registerCaseHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, context);
  const call = (channel, payload) => handlers.get(channel)(markLocalDesktopEvent({}), payload);
  return { runtime, lot, shed, history, store: history.getHistoryStore(), call };
}

describe('attaching under the private mark (R-LI-23)', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  it('R-LI-23: a private chat and a case that is not private is PRIVATE_CASE_REQUIRED, and nothing changes', async () => {
    const s = await setup();
    const r = await s.call(IPC.CASE_ATTACH, { chatId: 'chat-private', caseId: s.lot.id });
    assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_CASE_REQUIRED']);
    assert.strictEqual(s.history.getChat('chat-private', { messages: false }).caseId || null, null);
    assert.strictEqual(s.runtime.isPrivate(s.lot.id), false);
  });

  it('R-LI-23: with makeCasePrivate the case is marked in the same action, and both are private afterwards', async () => {
    const s = await setup();
    const r = await s.call(IPC.CASE_ATTACH, { chatId: 'chat-private', caseId: s.lot.id, makeCasePrivate: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.chat.caseId, s.lot.id);
    assert.strictEqual(s.runtime.isPrivate(s.lot.id), true);
    assert.strictEqual(s.store.isPrivate('chat-private'), true);
  });

  it('R-LI-23: an ordinary chat attached to a private case becomes private', async () => {
    const s = await setup();
    await s.runtime.markPrivate(s.shed.id);
    const r = await s.call(IPC.CASE_ATTACH, { chatId: 'chat-open', caseId: s.shed.id });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(s.store.isPrivate('chat-open'), true);
  });

  it('a private chat attaches to a private case with no confirmation', async () => {
    const s = await setup();
    await s.runtime.markPrivate(s.shed.id);
    const r = await s.call(IPC.CASE_ATTACH, { chatId: 'chat-private', caseId: s.shed.id });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });

  it('makeCasePrivate counts only when it is exactly true', async () => {
    const s = await setup();
    for (const makeCasePrivate of ['yes', 1, {}]) {
      const r = await s.call(IPC.CASE_ATTACH, { chatId: 'chat-private', caseId: s.lot.id, makeCasePrivate });
      assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_CASE_REQUIRED']);
    }
    assert.strictEqual(s.runtime.isPrivate(s.lot.id), false);
  });

  it('case:create with a private chat creates the case private', async () => {
    const s = await setup();
    const r = await s.call(IPC.CASE_CREATE, { title: 'Survey filing', chatId: 'chat-private' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(s.runtime.isPrivate(r.case.id), true);
    assert.strictEqual(r.chat.caseId, r.case.id);
    const plain = await s.call(IPC.CASE_CREATE, { title: 'Porch paint', chatId: 'chat-new' });
    assert.strictEqual(s.runtime.isPrivate(plain.case.id), false);
  });

  it('the older refusals still win: an imported chat, a chat that recalled others, one that saw other cases', () => {
    const opts = { chatPrivate: true, casePrivate: false };
    assert.throws(() => assertChatAttachable({ id: 'c', source: 'claude-code-jsonl', messages: [] }, 'case-1', opts), (err) => err.code === 'IMPORTED_CHAT');
    assert.throws(() => assertChatAttachable({ id: 'c', recalledOtherChatsAt: '2026-10-13T09:00:00.000Z', messages: [] }, 'case-1', opts), (err) => err.code === 'CHAT_RECALLED_OTHER_CHATS');
    const saw = { id: 'c', messages: [{ seq: 1, sender: 'toolResult', toolName: 'list_cases', result: { ok: true, result: [{ id: 'case-2' }] } }] };
    assert.throws(() => assertChatAttachable(saw, 'case-1', opts), (err) => err.code === 'CHAT_SAW_OTHER_CASES');
    assert.throws(() => assertChatAttachable({ id: 'c', messages: [] }, 'case-1', opts), PrivateCaseRequiredError);
    assert.doesNotThrow(() => assertChatAttachable({ id: 'c', messages: [] }, 'case-1', { ...opts, makeCasePrivate: true }));
    assert.doesNotThrow(() => assertChatAttachable({ id: 'c', messages: [] }, 'case-1'), 'no private facts given: as before');
    assert.doesNotThrow(() => assertChatAttachable({ id: 'c', messages: [] }, null, opts), 'a case about to be created is made private');
  });
});
