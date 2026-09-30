// tests/cases-question-chat.test.js
// Management surfaces spec §3.4 (part 2, Task 4): a new question is posted,
// once, to the case's newest chat; a case with no chat gets one; a host with
// no history store still creates the question.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { pickCaseChat, questionMessageText } = require('../src/cases/question-chat');
const { answerClass } = require('../src/cases/mcp-tool-definitions');
const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
const { historyContext } = require('./helpers/history-context');
const { addSink } = require('../src/logging');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const T0 = new Date('2026-09-30T12:00:00.000Z');

describe('pickCaseChat', () => {
  it('picks the case chat with the newest last message, falling back to updatedAt', () => {
    const chats = [
      { id: 'a', caseId: 'c1', lastMessageAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-30T11:00:00Z' },
      { id: 'b', caseId: 'c1', lastMessageAt: '2026-09-30T09:00:00Z', updatedAt: '2026-09-30T09:00:00Z' },
      { id: 'c', caseId: 'c1', lastMessageAt: null, updatedAt: '2026-09-30T10:00:00Z' },
      { id: 'd', caseId: 'c2', lastMessageAt: '2026-09-30T11:59:00Z' },
      { id: 'e', lastMessageAt: '2026-09-30T11:59:00Z' }
    ];
    assert.strictEqual(pickCaseChat(chats, 'c1').id, 'c');
    assert.strictEqual(pickCaseChat(chats.filter((c) => c.id !== 'c'), 'c1').id, 'b');
    assert.strictEqual(pickCaseChat(chats, 'c3'), null);
    assert.strictEqual(pickCaseChat([], 'c1'), null);
  });
});

describe('answerClass', () => {
  it('is pressed for approvals, the listed kinds, mcpAnswerable false and failures; spoken for Ask and detours', () => {
    const q = (kind, payload) => ({ kind, payload });
    assert.strictEqual(answerClass(q('approval', { type: 'envelope' })), 'pressed');
    assert.strictEqual(answerClass(q('approval', { type: 'plan' })), 'pressed');
    for (const type of ['envelope-delta', 'budget-grant', 'budget-daily', 'direction', 'commit-failed', 'wakeups-failing',
      'gating-pending', 'owner-task', 'conflict', 'ingest:review']) {
      assert.strictEqual(answerClass(q('question', { type })), 'pressed', type);
    }
    assert.strictEqual(answerClass(q('question', { type: 'ask', mcpAnswerable: false })), 'pressed');
    assert.strictEqual(answerClass(q('question', { type: 'ask', failure: 'journal/x.md' })), 'pressed');
    assert.strictEqual(answerClass(q('briefing', { type: 'wakeups-failing' })), 'pressed');
    assert.strictEqual(answerClass(q('question', { type: 'ask' })), 'spoken');
    assert.strictEqual(answerClass(q('briefing', { type: 'ask' })), 'spoken');
    assert.strictEqual(answerClass(q('question', { type: 'detour' })), 'spoken');
    assert.strictEqual(answerClass(q('question', undefined)), 'spoken');
  });
});

describe('questionMessageText', () => {
  it('renders the case title, the question, numbered options and how to answer', () => {
    const meta = { title: 'Lakeside lot' };
    const text = questionMessageText(meta, {
      id: 'q-0001', kind: 'question', text: 'Which cadence?', options: [{ id: 'w', label: 'Weekly' }, { id: 'm', label: 'Monthly' }], payload: { type: 'ask' }
    });
    assert.strictEqual(text, 'Lakeside lot: Question q-0001\n\nWhich cadence?\n\n1. Weekly\n2. Monthly\n\nReply below.');
    assert.match(questionMessageText(meta, { id: 'q-0002', kind: 'approval', text: 'Approve?', options: [], payload: { type: 'plan' } }),
      /^Lakeside lot: Approval q-0002\n\nApprove\?\n\nAnswer with the buttons/);
  });
});

describe('CaseRuntime posts each new question to the case chat', () => {
  function runtime({ chats } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-qchat-'));
    dirs.push(root);
    const events = [];
    const ctx = chats === undefined ? null : historyContext(chats);
    const host = { notify: (e, p) => events.push([e, p]), interactive: () => true };
    if (ctx) {
      let n = 0;
      host.chats = { listChats: ctx.listChats, createChat: ctx.createChat, appendMessageToChat: ctx.appendMessageToChat, createId: () => `new-${++n}` };
    }
    const rt = new CaseRuntime({ root, now: () => T0, getSettings: () => ({ cases: { timeZone: 'UTC' } }), host });
    return { rt, events, ctx };
  }
  const questionMessages = (ctx, chatId) => ctx.getMessages(chatId).filter((m) => m.question);

  it('appends exactly one message to the newest case chat, and nothing on a resurface or duplicate', async () => {
    const { rt, events, ctx } = runtime({ chats: [] });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const at = (iso) => ({ createdAt: iso, updatedAt: iso });
    ctx.createChat({ id: 'old', title: 'Old', caseId: info.id, ...at('2026-09-28T10:00:00Z'), messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: '2026-09-28T10:00:00Z' }] });
    ctx.createChat({ id: 'new', title: 'New', caseId: info.id, ...at('2026-09-29T10:00:00Z'), messages: [{ id: 'm2', sender: 'user', text: 'hi', timestamp: '2026-09-29T10:00:00Z' }] });
    ctx.createChat({ id: 'other', title: 'Other', ...at('2026-09-30T10:00:00Z'), messages: [{ id: 'm3', sender: 'user', text: 'hi', timestamp: '2026-09-30T10:00:00Z' }] });

    const q = rt.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal', options: [{ id: 'yes', label: 'Yes' }] });
    const posted = questionMessages(ctx, 'new');
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0].question, { caseId: info.id, questionId: q.id });
    assert.strictEqual(posted[0].sender, 'assistant');
    assert.match(posted[0].text, /Is the well shared\?\n\n1\. Yes\n\nReply below\.$/);
    assert.deepStrictEqual([questionMessages(ctx, 'old').length, questionMessages(ctx, 'other').length], [0, 0]);
    const note = events.find(([e, p]) => e === 'case:changed' && p.questionId === q.id);
    assert.strictEqual(note[1].chatId, 'new');
    assert.strictEqual(note[1].message.seq, posted[0].seq);

    // The same question again (findDuplicate) and a ladder resurface
    // through the in-app adapter post nothing more.
    rt.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    const inApp = new DesktopChannelPlugin({ sendToUi: (e, p) => events.push([e, p]) });
    await inApp.sendContact({ subject: 'Lakeside lot', items: [{ caseId: info.id, questionId: q.id }] }, { deliveryId: 'd1' });
    assert.strictEqual(questionMessages(ctx, 'new').length, 1);
    assert.strictEqual(ctx.listChats().length, 3);
  });

  it('creates a chat with the case title and caseId when the case has none', async () => {
    const { rt, ctx } = runtime({ chats: [] });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const q = rt.createQuestion(info.id, { kind: 'approval', text: 'Approve the plan?', urgency: 'normal', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], payload: { type: 'plan' } }, { charge: false });
    const chats = ctx.listChats();
    assert.strictEqual(chats.length, 1);
    assert.deepStrictEqual([chats[0].title, chats[0].caseId], ['Lakeside lot', info.id]);
    const posted = questionMessages(ctx, chats[0].id);
    assert.deepStrictEqual(posted.map((m) => m.question.questionId), [q.id]);
    assert.match(posted[0].text, /Answer with the buttons/);
    // A second question goes to that chat; no second chat.
    rt.createQuestion(info.id, { kind: 'question', text: 'Which buyer?', urgency: 'low' });
    assert.strictEqual(ctx.listChats().length, 1);
    assert.strictEqual(questionMessages(ctx, chats[0].id).length, 2);
  });

  it('still creates the question, with a warning, when the host has no history store', async () => {
    const { rt, events } = runtime();
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const records = [];
    const remove = addSink((r) => records.push(r));
    try {
      const q = rt.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
      assert.ok(rt.questions(info.id).get(q.id));
      assert.ok(events.some(([e, p]) => e === 'case:changed' && p.questionId === q.id && !('chatId' in p)));
    } finally {
      remove();
    }
    assert.ok(records.some((r) => r.level === 'warn' && /no history store/.test(r.message)));
  });

  it('still creates the question when the store throws', async () => {
    const { rt } = runtime();
    rt.host.chats = { listChats: () => { throw new Error('store closed'); }, createChat() {}, appendMessageToChat() {}, createId: () => 'x' };
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const q = rt.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    assert.ok(rt.questions(info.id).get(q.id));
  });
});
