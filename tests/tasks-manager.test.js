// The task manager (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.3, §4.4,
// §4.6, §4.8): a task is a real chat with a durable record beside it.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { publicView, TaskManager } = require('../src/tasks/manager');
const { TaskStore } = require('../src/tasks/store');
const { utilityCaller } = require('../src/tasks/wiring');
const { shouldRefuseUnsafe } = require('../src/fleet/delegate-sessions');
const { TASK_GUIDANCE } = require('../src/context/system-sections');
const { plainLineProblem } = require('../src/cases/hidden-chars');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { profileSettings, everyRole } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { tasksHarness } = require('./helpers/tasks-harness');

// Grants that send no first card and never answer, for what a manager does around them. A raise is a card out.
const quietGrants = () => ({
  open: () => {
    let awaiting = false;
    return { state: () => ({ awaiting, grant: null }), wait: async () => {}, close: () => {}, raise: () => { awaiting = true; }, resend: () => false, checkDevice: () => {}, askingUsd: () => null };
  },
});
const FRONT = { kind: 'frontdoor', client_id: 'c1', client_name: 'Example client', grant_id: 'g1', scopes: ['fleet:delegate', 'fleet:unsafe'], mcp_session: null };
const reply = (content) => async () => ({ type: 'complete', content });
const untilAborted = async (turn) => {
  await turn.aborted();
  return { type: 'stopped', content: '(Session stopped by user)' };
};
const code = (name) => (err) => {
  assert.equal(err.code, name, err.message);
  return true;
};

let h = null;
const harness = (options) => {
  h = tasksHarness(options);
  return h;
};
afterEach(async () => {
  if (h) {
    await h.manager.stop();
    h.cleanup();
    h = null;
  }
});

describe('a task is a chat', () => {
  it('an ending reaches a real PushQueue exactly once, as a task_ended hint for every phone', async () => {
    const { PushQueue } = require('../src/gui/push-queue');
    const calls = [];
    const link = { isConnected: () => true, on() {}, off() {}, pushNotify: async (p) => { calls.push(p); return { ok: true }; } };
    const queue = new PushQueue({ relayClient: link });
    const t = harness({ script: [reply('done')] });
    const m = t.build({ push: queue });
    const view = await m.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(m, view.task_id);
    await queue.drain();
    assert.deepEqual(calls, [{ kind: 'task_ended', id: view.task_id, to_device: null, except_device: null, expires_at: null }]);
    await m.stop();
  });

  it('run creates a chat with the client\'s row, runs a turn, and ends done with the answer and a push', async () => {
    const t = harness({ script: [reply('the answer')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    assert.ok(['requested', 'running'].includes(view.state));
    assert.equal(view.client.kind, 'frontdoor');
    assert.equal(view.client.name, 'Example client');
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.answer.text, 'the answer');
    assert.equal(rec.ended.reason, 'done');

    const chat = t.history.getChat(rec.chat_id, { messages: false });
    assert.equal(chat.taskId, rec.task_id);
    assert.equal(chat.source, undefined, 'source would mark it an imported chat');
    assert.deepEqual(chat.client, rec.client);
    assert.equal(chat.title, 'Find a dentist');

    const rows = t.rows(rec.chat_id);
    assert.equal(rows[0].sender, 'user');
    assert.equal(rows[0].text, 'Find a dentist');
    assert.equal(rows[0].author, 'client');
    const last = rows[rows.length - 1];
    assert.equal(last.sender, 'assistant');
    assert.equal(last.text, 'the answer');
    assert.equal(rec.answer.seq, last.seq);

    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
    assert.deepEqual(t.audits.map((a) => a.kind), ['task.requested', 'task.ended']);
    assert.deepEqual(t.audits[0].data, { task_id: rec.task_id, origin: { kind: 'frontdoor', grant_id: 'g1', client_id: 'c1' }, node: 'node-a' });
    assert.deepEqual(t.audits[1].data, { task_id: rec.task_id, reason: 'done', usd: 0 });
    assert.ok(!JSON.stringify(t.audits).includes('dentist'), 'the audit never holds the text');
  });

  it('the title is one plain line of at most 60 characters', async () => {
    const t = harness();
    const view = await t.manager.run({ text: `Find\n\ta\u202Edentist\u200B ${'x'.repeat(200)}`, origin: null });
    const { title } = t.history.getChat(view.chat_id, { messages: false });
    assert.equal(plainLineProblem(title), null);
    assert.ok([...title].length <= 60);
    assert.ok(title.startsWith('Find a'));
    await t.settled(t.manager, view.task_id);
  });

  it('refuses text that is empty or over 8,000 characters', async () => {
    const t = harness();
    await assert.rejects(t.manager.run({ text: '  ', origin: null }), code('invalid_params'));
    await assert.rejects(t.manager.run({ text: 'x'.repeat(8001), origin: null }), code('invalid_params'));
    assert.deepEqual(t.store.list(), []);
  });

  it('tool rows land as the turn runs, and an aborted turn still holds them', async () => {
    let seen = null;
    const t = harness({
      script: [async (turn) => {
        turn.tool('Read', { file_path: 'a' }, { success: true, text: 'one' });
        seen = t.rows(turn.options.executorOptions.chatId).map((m) => m.sender);
        await turn.aborted();
        turn.tool('Read', { file_path: 'b' }, { success: false, cancelled: true });
        return { type: 'stopped', content: '(Session stopped by user)' };
      }],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.started();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(seen, ['user', 'toolUse', 'toolResult']);
    await t.manager.cancel(view.task_id);
    const rec = await t.settled(t.manager, view.task_id);
    const rows = t.rows(rec.chat_id);
    assert.deepEqual(rows.map((m) => m.sender), ['user', 'toolUse', 'toolResult', 'toolUse', 'toolResult']);
    assert.equal(rows[1].toolName, 'Read');
    assert.deepEqual(rows[1].parameters, { file_path: 'a' });
    assert.deepEqual(rows[2].result, { success: true, text: 'one' });
    assert.equal(rows[2].toolName, 'Read');
    assert.equal(rows[1].runId, rows[2].runId);
  });
});

describe('turn ends', () => {
  it('STUCK: waiting, reason stuck, no push; send starts a client turn', async () => {
    const t = harness({ script: [reply('Looked.\n\nSTUCK: I saw a login wall and need a site.'), reply('done now')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    let rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'stuck');
    assert.match(rec.answer.text, /STUCK: I saw a login wall/);
    assert.deepEqual(t.pushes, []);

    const sent = await t.manager.send(view.task_id, 'Try example.com', { origin: null });
    assert.equal(sent.state, 'running');
    assert.equal(sent.reason, null);
    rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.answer.text, 'done now');
    const users = t.rows(rec.chat_id).filter((m) => m.sender === 'user');
    assert.deepEqual(users.map((m) => [m.text, m.author]), [['go', 'client'], ['Try example.com', 'client']]);
    assert.equal(t.pushes.length, 1);
  });

  it('a follow-up on done replaces the answer and moves seq; the tail reaches the turn', async () => {
    const t = harness({ script: [reply('first answer'), reply('second answer')] });
    const view = await t.manager.run({ text: 'question one', origin: null });
    const first = await t.settled(t.manager, view.task_id);
    await t.manager.send(view.task_id, 'question two', { origin: null });
    const second = await t.settled(t.manager, view.task_id);
    assert.equal(second.state, 'done');
    assert.equal(second.answer.text, 'second answer');
    assert.ok(second.seq > first.seq);
    assert.ok(second.answer.seq > first.answer.seq);
    assert.equal(second.ended.reason, 'done');
    assert.deepEqual(t.calls[1].options.messages, [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'question two' },
    ]);
  });

  it('a failed turn is failed with the error\'s code, never its message', async () => {
    const t = harness({
      script: [async () => {
        const err = new Error('cannot read C:\\Users\\someone\\private.txt');
        err.code = 'ENOENT';
        throw err;
      }],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'ENOENT');
    assert.ok(!fs.readFileSync(path.join(t.dir, 'tasks', `${rec.task_id}.json`), 'utf8').includes('private'));
    assert.equal(t.pushes.length, 1);
  });

  for (const [name, err] of [
    ['with no code', new Error('at /home/someone/x')],
    ['with a code that is a sentence', Object.assign(new Error('x'), { code: 'see /home/someone/x' })],
  ]) {
    it(`a failed turn ${name} is turn_failed`, async () => {
      const t = harness({ script: [async () => { throw err; }] });
      const view = await t.manager.run({ text: 'go', origin: null });
      assert.equal((await t.settled(t.manager, view.task_id)).ended.reason, 'turn_failed');
    });
  }

  it('a turn that ends by max_iterations is failed, and its canned text is no answer', async () => {
    const t = harness({ script: [async () => ({ type: 'max_iterations', content: 'Maximum tool iterations reached before final answer.' })] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'max_iterations');
    assert.equal(rec.answer, null);
  });

  it('cancel aborts the turn, ends it cancelled with one push, and refuses a later send', async () => {
    const t = harness({ script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    const cancelled = await t.manager.cancel(view.task_id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(turn.options.abortSignal.aborted, true);
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'cancelled');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
    await assert.rejects(t.manager.send(view.task_id, 'more', { origin: null }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.match(err.message, /cancelled/);
      return true;
    });
    assert.equal((await t.manager.cancel(view.task_id)).state, 'cancelled');
    assert.equal(t.pushes.length, 1);
  });

  it('cancel on a finished task changes nothing', async () => {
    const t = harness();
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.settled(t.manager, view.task_id);
    assert.equal((await t.manager.cancel(view.task_id)).state, 'done');
    assert.equal(t.pushes.length, 1);
  });
});

describe('one running task', () => {
  it('a second run is task_busy while one is running, and send during a turn is task_busy', async () => {
    const t = harness({ script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await assert.rejects(t.manager.run({ text: 'go', origin: null }), code('task_busy'));
    await t.started();
    await assert.rejects(t.manager.run({ text: 'go', origin: null }), code('task_busy'));
    await assert.rejects(t.manager.send(view.task_id, 'more', { origin: null }), code('task_busy'));
    assert.equal(t.store.list().length, 1);
    assert.equal(t.calls.length, 1);
    await t.manager.cancel(view.task_id);
    await t.settled(t.manager, view.task_id);
  });

  it('a second run is task_busy while one is waiting or awaiting its grant', async () => {
    const t = harness({ script: [reply('STUCK: need a word')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.settled(t.manager, view.task_id);
    await assert.rejects(t.manager.run({ text: 'other', origin: null }), code('task_busy'));
    t.store.update(view.task_id, { state: 'awaiting_grant' });
    await assert.rejects(t.manager.run({ text: 'other', origin: null }), code('task_busy'));
  });

  it('send on another task while one waits is task_busy', async () => {
    const t = harness({ script: [reply('finished'), reply('STUCK: need a word')] });
    const a = await t.manager.run({ text: 'a', origin: null });
    await t.settled(t.manager, a.task_id);
    const b = await t.manager.run({ text: 'b', origin: null });
    await t.settled(t.manager, b.task_id);
    await assert.rejects(t.manager.send(a.task_id, 'more', { origin: null }), code('task_busy'));
  });

  it('an unknown task is task_not_found everywhere', async () => {
    const t = harness();
    const id = crypto.randomUUID();
    await assert.rejects(t.manager.get(id), code('task_not_found'));
    await assert.rejects(t.manager.send(id, 'x', {}), code('task_not_found'));
    await assert.rejects(t.manager.cancel(id), code('task_not_found'));
    await assert.rejects(t.manager.get('../../etc'), code('task_not_found'));
  });

  it('isChatRunning is true from run until the turn ends', async () => {
    const t = harness({ script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    assert.equal(t.manager.isChatRunning(view.chat_id), true);
    assert.equal(t.manager.isChatRunning('other'), false);
    await t.started();
    await t.manager.cancel(view.task_id);
    await t.settled(t.manager, view.task_id);
    assert.equal(t.manager.isChatRunning(view.chat_id), false);
  });

  it('list is newest first and filters by state, and refuses an unknown state', async () => {
    const t = harness();
    const a = await t.manager.run({ text: 'a', origin: null });
    await t.settled(t.manager, a.task_id);
    t.time.advance(1000);
    const b = await t.manager.run({ text: 'b', origin: null });
    await t.settled(t.manager, b.task_id);
    const all = await t.manager.list();
    assert.deepEqual(all.map((v) => v.task_id), [b.task_id, a.task_id]);
    assert.deepEqual(await t.manager.list({ state: 'running' }), []);
    assert.equal((await t.manager.list({ state: 'done' })).length, 2);
    await assert.rejects(t.manager.list({ state: 'nope' }), code('invalid_params'));
  });
});

describe('get with a wait', () => {
  // A ref'd timer keeps the loop open around each await the manager's own unref'd timer ends.
  const keepAlive = () => {
    const t = setTimeout(() => {}, 5000);
    return () => clearTimeout(t);
  };

  it('with seenSeq equal to the current one it resolves at the next write', async () => {
    const t = harness({ script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.started();
    const { seq } = t.store.get(view.task_id);
    const release = keepAlive();
    const pending = t.manager.get(view.task_id, { seenSeq: seq, waitMs: 4000 });
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(settled, false);
    await t.manager.cancel(view.task_id);
    const got = await pending;
    release();
    assert.equal(got.state, 'cancelled');
    assert.ok(got.seq > seq);
    await t.settled(t.manager, view.task_id);
  });

  it('resolves at waitMs when nothing is written', async () => {
    const t = harness({ script: [reply('STUCK: a')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    const release = keepAlive();
    const started = Date.now();
    const got = await t.manager.get(view.task_id, { seenSeq: rec.seq, waitMs: 30 });
    release();
    assert.equal(got.seq, rec.seq);
    assert.ok(Date.now() - started >= 25);
  });

  it('with an older seenSeq it answers at once', async () => {
    const t = harness({ script: [reply('STUCK: a')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    const started = Date.now();
    const got = await t.manager.get(view.task_id, { seenSeq: rec.seq - 1, waitMs: 20000 });
    assert.equal(got.seq, rec.seq);
    assert.ok(Date.now() - started < 1000);
  });

  it('two waiters both wake, and stop wakes them', async () => {
    const t = harness({ script: [reply('STUCK: a')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    const release = keepAlive();
    const one = t.manager.get(view.task_id, { seenSeq: rec.seq, waitMs: 4000 });
    const two = t.manager.get(view.task_id, { seenSeq: rec.seq, waitMs: 4000 });
    await t.manager.stop();
    const [a, b] = await Promise.all([one, two]);
    release();
    assert.equal(a.task_id, view.task_id);
    assert.equal(b.task_id, view.task_id);
  });
});

describe('spend and duration', () => {
  const PROPOSAL = JSON.stringify({ sites: ['a.example.com'], allows: ['browser-act'], minutes: 20, usd: 2 });

  it('the proposal is recorded and sets the cap and the deadline, with no card when grants is null', async () => {
    const t = harness({ callUtility: async () => PROPOSAL });
    const start = t.time.clock();
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.proposal.usd, 2);
    assert.deepEqual(rec.proposal.sites, ['a.example.com']);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.grant, null);
    assert.equal(rec.deadline_at, new Date(start + 20 * 60000).toISOString());
  });

  it('no proposal: 30 minutes and a $2 cap; a malformed one too, and it still runs', async () => {
    const t = harness({ callUtility: async () => 'not json' });
    const start = t.time.clock();
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.proposal, null);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(start + 30 * 60000).toISOString());
  });

  it('run returns before the proposal is answered', async () => {
    let answer;
    const t = harness({ callUtility: () => new Promise((resolve) => { answer = resolve; }) });
    const view = await t.manager.run({ text: 'go', origin: null });
    assert.equal(view.state, 'requested');
    assert.equal(t.calls.length, 0);
    await new Promise((resolve) => { setImmediate(resolve); });
    answer(PROPOSAL);
    await t.settled(t.manager, view.task_id);
  });

  it('a cancel while the proposal is out never starts the turn', async () => {
    const t = harness({ callUtility: () => new Promise(() => {}) });
    const view = await t.manager.run({ text: 'go', origin: null });
    await new Promise((resolve) => { setImmediate(resolve); });
    await t.manager.cancel(view.task_id);
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(t.calls.length, 0);
  });

  it('with no grants, a charge over the cap ends the task failed, spend_cap, with the push: nothing can raise it', async () => {
    const t = harness({
      callUtility: async () => PROPOSAL,
      script: [async (turn) => {
        turn.usage({ costUsd: 3 });
        await turn.aborted();
        return { type: 'stopped', content: '(Session stopped by user)' };
      }],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.reason, null);
    assert.equal(rec.ended.reason, 'spend_cap');
    assert.equal(rec.spend.usd, 3);
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
    assert.ok(t.audits.some((a) => a.kind === 'task.ended' && a.data.reason === 'spend_cap' && a.data.usd === 3));
    await assert.rejects(t.manager.send(view.task_id, 'go on', { origin: null }), code('invalid_params'));
    await t.manager.run({ text: 'a new task', origin: null });
  });

  it('with grants, a charge over the cap cuts the turn: waiting, spend_cap; a send is refused until the cap moves', async () => {
    const t = harness({
      grants: quietGrants(),
      callUtility: async () => PROPOSAL,
      script: [async (turn) => {
        turn.usage({ costUsd: 3 });
        await turn.aborted();
        return { type: 'stopped', content: '(Session stopped by user)' };
      }, reply('after the raise')],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'spend_cap');
    assert.equal(rec.spend.usd, 3);
    assert.equal(rec.spend.calls, 1);
    assert.deepEqual(t.pushes, []);
    await assert.rejects(t.manager.send(view.task_id, 'go on', { origin: null }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.match(err.message, /spend/);
      return true;
    });
    t.store.update(view.task_id, { spend: { ...rec.spend, cap_usd: 6 } });
    await t.manager.send(view.task_id, 'go on', { origin: null });
    assert.equal((await t.settled(t.manager, view.task_id)).state, 'done');
  });

  it('counts the tracker\'s event, whose field is cost, and an unpriced call counts nothing', async () => {
    const t = harness({
      script: [async (turn) => {
        turn.usage({ cost: 0.25 });
        turn.usage({ costUsd: 0.25 });
        turn.usage({ cost: null });
        turn.usage({ costUsd: null });
      }],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.spend.usd, 0.5);
    assert.equal(rec.spend.calls, 4);
    assert.equal(rec.spend.unpriced, 2);
  });

  it('a sub-agent\'s calls are charged to the task', async () => {
    const t = harness({
      grants: quietGrants(),
      script: [async (turn) => {
        turn.options.executorOptions.onSubagentLlm({ calls: [{ costUsd: 1.5 }, { costUsd: null }] });
        turn.options.executorOptions.onSubagentLlm({ calls: [{ costUsd: 1 }] });
        await turn.aborted();
        return { type: 'stopped', content: '' };
      }],
    });
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.reason, 'spend_cap');
    assert.equal(rec.spend.usd, 2.5);
    assert.equal(rec.spend.unpriced, 1);
  });

  it('at deadline_at the turn is cut; with no grants no press can move it, so the task ends failed, duration', async () => {
    const t = harness({ callUtility: async () => PROPOSAL, script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    t.time.advance(20 * 60000 - 1);
    assert.equal(turn.options.abortSignal.aborted, false);
    t.time.advance(1);
    assert.equal(turn.options.abortSignal.aborted, true);
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'duration');
    assert.equal(t.time.pending(), 0);
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
    await assert.rejects(t.manager.send(view.task_id, 'go on', { origin: null }), code('invalid_params'));
  });

  it('with grants, the cut leaves it waiting, duration, and the deadline stays where it was', async () => {
    const t = harness({ grants: quietGrants(), callUtility: async () => PROPOSAL.replace('"allows":["browser-act"]', '"allows":[]'), script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.started();
    t.time.advance(20 * 60000);
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'duration');
    await assert.rejects(t.manager.send(view.task_id, 'go on', { origin: null }), /press/);
    assert.equal(t.store.get(view.task_id).deadline_at, rec.deadline_at);
    assert.equal(t.calls.length, 1);
  });
});

describe('an ending while a cut unwinds', () => {
  // The turn is cut, then holds until released, as a tool slow to stop does.
  const held = (options = {}) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const t = harness({
      ...options,
      script: [async () => {
        await gate;
        return { type: 'stopped', content: '(Session stopped by user)' };
      }, reply('ran after the ending')],
    });
    return { t, release };
  };
  const CUTS = [
    ['spend, no grants', {}, (t, turn) => turn.usage({ costUsd: 3 })],
    ['spend, grants', { grants: quietGrants() }, (t, turn) => turn.usage({ costUsd: 3 })],
    ['duration', {}, (t) => t.time.advance(30 * 60000)],
  ];

  for (const [name, options, cutTurn] of CUTS) {
    it(`cancel stands: ${name}`, async () => {
      const { t, release } = held(options);
      const view = await t.manager.run({ text: 'go', origin: null });
      const turn = await t.started();
      cutTurn(t, turn);
      assert.equal(turn.options.abortSignal.aborted, true);
      assert.equal((await t.manager.cancel(view.task_id)).state, 'cancelled');
      release();
      const rec = await t.settled(t.manager, view.task_id);
      assert.equal(rec.state, 'cancelled');
      assert.equal(rec.reason, null);
      assert.equal(rec.ended.reason, 'cancelled');
      assert.equal(t.pushes.length, 1);
      await assert.rejects(t.manager.send(view.task_id, 'more', { origin: null }), code('invalid_params'));
      assert.equal(t.calls.length, 1);
      await t.manager.run({ text: 'the node is free', origin: null });
    });

    it(`stop stands: ${name}`, async () => {
      const { t, release } = held(options);
      const view = await t.manager.run({ text: 'go', origin: null });
      const turn = await t.started();
      cutTurn(t, turn);
      const stopping = t.manager.stop();
      release();
      await stopping;
      const rec = t.store.get(view.task_id);
      assert.equal(rec.state, 'interrupted');
      assert.equal(rec.reason, null);
      assert.equal(rec.ended, null);
      assert.equal(t.pushes.length, 1);
    });
  }
});

describe('a turn whose end cannot be written', () => {
  it('a reply row that will not append ends the task failed, turn_failed, with the push', async () => {
    const t = harness({ script: [reply('the answer')] });
    const real = t.core.context.appendMessageToChat;
    t.core.context.appendMessageToChat = (chatId, sender, ...rest) => {
      if (sender === 'assistant') throw new Error('database is locked at /home/someone/x');
      return real(chatId, sender, ...rest);
    };
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'turn_failed');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
  });

  it('a record write that throws once ends the task failed, turn_failed', async () => {
    const t = harness({ script: [reply('the answer')] });
    const real = t.store.update.bind(t.store);
    let thrown = false;
    t.store.update = (id, patch) => {
      if (patch.state === 'done' && !thrown) {
        thrown = true;
        throw new Error('disk full');
      }
      return real(id, patch);
    };
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(thrown, true);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'turn_failed');
    assert.equal(t.pushes.length, 1);
    assert.equal(t.manager.isChatRunning(rec.chat_id), false);
  });

  it('an ending already written stands, and a handle that throws on close costs nothing', async () => {
    const t = harness({ script: [async (turn) => { await turn.aborted(); return { type: 'stopped', content: '' }; }] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.started();
    t.manager.handles.set(view.task_id, {
      state: () => ({ awaiting: false, grant: null }),
      wait: async () => {},
      close: () => { throw new Error('close failed'); },
    });
    assert.equal((await t.manager.cancel(view.task_id)).state, 'cancelled');
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(t.pushes.length, 1);
  });

  it('a write that will never land leaves the turn over, and the manager free of it', async () => {
    const t = harness({ script: [reply('the answer')] });
    const real = t.store.update.bind(t.store);
    t.store.update = (id, patch) => {
      if (patch.state === 'done' || patch.state === 'failed') throw new Error('disk full');
      return real(id, patch);
    };
    const view = await t.manager.run({ text: 'go', origin: null });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(t.manager.isChatRunning(rec.chat_id), false);
    t.store.update = real;
    assert.equal(t.time.pending(), 0);
  });
});

describe('restart and shutdown', () => {
  it('start marks a running record interrupted and keeps its answer; get answers; send runs the next turn', async () => {
    const t = harness({ script: [reply('next answer')] });
    t.history.createChat({ id: 'chat-old', title: 'old', createdAt: 'x', updatedAt: 'x', messages: [] });
    t.history.appendMessageToChat('chat-old', 'user', 'earlier', { author: 'client' });
    t.history.appendMessageToChat('chat-old', 'assistant', 'kept answer', {});
    const rec = t.store.create({ chat_id: 'chat-old', node: 'node-a', client: { kind: 'stdio' }, text: 'earlier', state: 'running', answer: { text: 'kept answer', at: 'x', seq: 2 }, spend: { usd: 1, calls: 1, cap_usd: 2, unpriced: 0 } });
    await t.manager.start();
    let view = await t.manager.get(rec.task_id);
    assert.equal(view.state, 'interrupted');
    assert.equal(view.answer.text, 'kept answer');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: rec.task_id }]);
    assert.ok(t.audits.some((a) => a.kind === 'task.ended' && a.data.reason === 'interrupted'));

    view = await t.manager.send(rec.task_id, 'carry on', { origin: null });
    assert.equal(view.state, 'running');
    const after = await t.settled(t.manager, rec.task_id);
    assert.equal(after.state, 'done');
    assert.equal(after.answer.text, 'next answer');
    assert.deepEqual(t.calls[0].options.messages.at(-1), { role: 'user', content: 'carry on' });
    assert.equal(t.calls[0].options.messages[0].content, 'earlier');
  });

  it('stop during a turn gives interrupted, one push, and a new manager\'s start pushes nothing more', async () => {
    const t = harness({ script: [untilAborted] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    await t.manager.stop();
    assert.equal(turn.options.abortSignal.aborted, true);
    const rec = t.store.get(view.task_id);
    assert.equal(rec.state, 'interrupted');
    assert.equal(rec.ended, null);
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id: view.task_id }]);
    await t.build().start();
    assert.equal(t.pushes.length, 1);
    await assert.rejects(t.manager.run({ text: 'x', origin: null }), code('task_busy'));
  });

  it('stop gives up on a turn that will not end', async () => {
    const t = harness({ script: [() => new Promise(() => {})] });
    const manager = t.build({ stopWaitMs: 20 });
    const view = await manager.run({ text: 'go', origin: null });
    await t.started();
    const hold = setTimeout(() => {}, 2000);
    await manager.stop();
    clearTimeout(hold);
    assert.equal(t.store.get(view.task_id).state, 'interrupted');
  });
});

describe('what a turn is given', () => {
  it('the tool set: the node\'s tools less fleet, task, session and acting GUI tools', async () => {
    const t = harness();
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    await t.settled(t.manager, view.task_id);
    const names = turn.options.allowedToolNames;
    for (const name of ['Bash', 'Read', 'Write', 'BrowserPage', 'SpawnAgent', 'ListApps', 'Screenshot', 'list_cases', 'answer_question']) {
      assert.ok(names.has(name), name);
    }
    for (const name of ['BackgroundTask', 'TaskStatus', 'Cron', 'RemoteDispatch', 'run_task', 'get_task', 'send_to_task', 'cancel_task', 'list_tasks', 'delegate', 'Click', 'Type', 'Key',
      'Scroll', 'Drag', 'LaunchApp', 'CloseApp', 'RequestLease', 'Take', 'sessions_spawn', 'sessions_list', 'sessions_history', 'message']) {
      assert.ok(!names.has(name), name);
    }
  });

  it('no owner text, denyAutoApproval, the real chat id, the phone\'s origin, the guidance', async () => {
    const t = harness();
    const view = await t.manager.run({ text: 'go', origin: FRONT });
    const turn = await t.started();
    await t.settled(t.manager, view.task_id);
    const ex = turn.options.executorOptions;
    assert.equal('ownerTurnText' in ex, false);
    assert.equal('ownerTurnText' in turn.options, false);
    assert.equal(ex.denyAutoApproval, true);
    assert.equal('historyCrossChat' in ex, false);
    assert.equal(ex.chatId, view.chat_id);
    assert.equal(ex.origin.job_id, `chat:${view.chat_id}`);
    assert.equal(ex.origin.client, 'Example client');
    assert.equal(ex.refuseUnsafe, false);
    assert.ok(turn.options.systemPromptDynamic.startsWith(TASK_GUIDANCE));
  });

  it('refuseUnsafe follows shouldRefuseUnsafe for the origin', async () => {
    const noUnsafe = { ...FRONT, scopes: ['fleet:delegate'] };
    const config = { name: 'node-a' };
    for (const origin of [noUnsafe, FRONT, null]) {
      const t = tasksHarness();
      const view = await t.manager.run({ text: 'go', origin });
      const turn = await t.started();
      await t.settled(t.manager, view.task_id);
      assert.equal(turn.options.executorOptions.refuseUnsafe, shouldRefuseUnsafe(origin, config));
      t.cleanup();
    }
    assert.equal(shouldRefuseUnsafe(noUnsafe, config), true);
  });

  it('the work directory exists and is the cwd and the first root', async () => {
    const t = harness();
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    await t.settled(t.manager, view.task_id);
    const want = fs.realpathSync.native(path.join(t.dir, 'tasks', view.task_id, 'work'));
    assert.equal(fs.statSync(want).isDirectory(), true);
    assert.equal(turn.options.workingDirectory, want);
    assert.equal(turn.options.executorOptions.allowedRoots[0], want);
  });

  it('the policy reads the task live: ended once it is over, not while it waits', async () => {
    const t = harness({ script: [reply('STUCK: a'), reply('done')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    await t.settled(t.manager, view.task_id);
    const { taskPolicy } = turn.options.executorOptions;
    const bash = () => taskPolicy.decide('Bash', { command: 'x' }, {});
    assert.equal((await bash()).passthrough, true, 'a waiting task is not over');
    await t.manager.send(view.task_id, 'more', { origin: null });
    await t.settled(t.manager, view.task_id);
    assert.equal((await bash()).code, 'task_ended');
  });

  it('a grant handle is what the policy reads, and an ending closes it', async () => {
    const t = harness({ script: [async (turn) => { await turn.aborted(); return { type: 'stopped', content: '' }; }] });
    const view = await t.manager.run({ text: 'go', origin: null });
    const turn = await t.started();
    const closed = [];
    t.manager.handles.set(view.task_id, {
      state: () => ({ awaiting: false, grant: { sites: [], allows: ['shell'] } }),
      wait: async () => {},
      close: (reason) => closed.push(reason),
      checkDevice: () => {},
    });
    const { taskPolicy } = turn.options.executorOptions;
    assert.equal((await taskPolicy.decide('Bash', { command: 'x' }, {})).allow, true);
    await t.manager.cancel(view.task_id);
    assert.deepEqual(closed, ['cancelled']);
    assert.equal((await taskPolicy.decide('Bash', { command: 'x' }, {})).code, 'task_ended');
    await t.settled(t.manager, view.task_id);
  });

  it('a send takes the origin of that send', async () => {
    const t = harness({ script: [reply('STUCK: a'), reply('done')] });
    const view = await t.manager.run({ text: 'go', origin: null });
    await t.settled(t.manager, view.task_id);
    await t.manager.send(view.task_id, 'more', { origin: FRONT });
    await t.settled(t.manager, view.task_id);
    assert.equal(t.calls[0].options.executorOptions.origin.client, 'stdio-mcp');
    assert.equal(t.calls[1].options.executorOptions.origin.client, 'Example client');
  });
});

describe('publicView', () => {
  it('reduces the client to kind and name, keeps the text and leaves out internals', () => {
    const view = publicView({
      task_id: 't', chat_id: 'c', node: 'n', text: 'the words', state: 'done', seq: 3, proposal: null, grant: null,
      placement: null, spend: { usd: 0 }, answer: { text: 'a', at: 'x', seq: 1 }, reason: null, deadline_at: null, card_sends: 2,
      ended: { reason: 'done', at: 'x' }, interrupted_at: null, created_at: 'x', updated_at: 'x',
      client: { kind: 'frontdoor', client_id: 'c1', client_name: 'Example client', grant_id: 'g1' },
    });
    assert.deepEqual(view.client, { kind: 'frontdoor', name: 'Example client' });
    assert.equal(view.text, 'the words');
    assert.equal('card_sends' in view, false);
    assert.equal(view.answer.text, 'a');
    assert.deepEqual(publicView({ client: { kind: 'stdio' } }).client, { kind: 'stdio', name: null });
  });
});

// The turn through the real adapter, executor and approval seam: nothing the task's run carries
// lifts a passthrough, whatever the node's always-approve list, an agent's list or a quote says.
describe('through the real core', () => {
  const FAKE = 'kl-test-task-manager';
  const GATED = 'KlTaskManagerGated';
  const PLAIN = 'KlTaskManagerPlain';
  let script = [];
  let ran = [];
  let seenContext = null;
  class FakeProvider {
    async sendMessageWithTools() {
      return script.shift() || { type: 'text', content: 'finished', llmMetrics: { provider: FAKE, model: 'fake', inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
    async streamMessage(messages, options, onChunk) {
      onChunk('the utility answer');
      return { content: 'the utility answer', llmMetrics: { provider: FAKE, model: 'fake', inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
    buildToolMessages(response, toolResult, toolCallId) {
      return [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) },
      ];
    }
  }
  before(() => {
    ProviderFactory.registerProvider(FAKE, FakeProvider);
    toolRegistry.register(new Tool({
      name: GATED,
      description: 'test',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute: async () => { ran.push(GATED); return { success: true }; },
    }));
    toolRegistry.register(new Tool({
      name: PLAIN,
      description: 'test',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      execute: async (params, context) => { ran.push(PLAIN); seenContext = context; return { success: true }; },
    }));
  });
  after(() => {
    ProviderFactory._registry.delete(FAKE);
    toolRegistry.unregister(GATED);
    toolRegistry.unregister(PLAIN);
  });

  async function withManager(remoteApprovals, fn, { roots = null, grants = null } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-task-core-'));
    const phone = [];
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: { [GATED]: true } } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals,
      ...(remoteApprovals === 'phone' ? {
        phoneApprover: { ttlMs: 300000, isAvailable: () => true, requestApproval: async (tool) => { phone.push(tool); return false; } },
        auditLedger: { append: async (e) => e },
        nodePolicy: { allowed_roots: roots || [dataDir], remote_sessions: { always_confirm: [], deny: [] } },
      } : {}),
    });
    const manager = new TaskManager({
      core,
      nodeConfig: { name: 'node-a', delegate: { agent: 'main', provider: null, model: null } },
      dataDir,
      store: new TaskStore({ dataDir }),
      grants,
      push: null,
      audit: null,
      currentUrl: async () => null,
      callUtility: null,
    });
    try {
      core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));
      core.saveProviderToken(FAKE, 'fake-token-123456');
      await core.start();
      await fn(core, manager, phone);
    } finally {
      await manager.stop();
      await core.shutdown();
      closeOpenHistoryStores();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const settled = async (manager, id) => {
    for (let i = 0; i < 5000; i += 1) {
      const view = await manager.get(id);
      if (!manager.isChatRunning(view.chat_id)) return view;
      await new Promise((resolve) => { setTimeout(resolve, 2); });
    }
    throw new Error('the turn never ended');
  };
  const gatedCall = (parameters = {}) => ({ type: 'tool_use', toolName: GATED, toolUseId: 'c1', parameters });

  for (const mode of ['phone', 'allow']) {
    it(`remoteApprovals ${mode}: the always-approve list and an agent's list do not lift a passthrough`, async () => {
      await withManager(mode, async (core, manager, phone) => {
        const agent = core.context.getAgent('main');
        const had = agent.autoApproveTools;
        agent.autoApproveTools = [GATED];
        ran = [];
        script = [gatedCall({ ownerQuote: 'Find a dentist' })];
        try {
          const view = await manager.run({ text: 'Find a dentist', origin: null });
          const end = await settled(manager, view.task_id);
          assert.deepEqual(ran, [], 'nothing lifted the gate');
          if (mode === 'phone') assert.deepEqual(phone, [GATED]);
          assert.equal(end.state, 'done');
          const rows = core.context.getMessages(view.chat_id);
          const result = rows.find((m) => m.sender === 'toolResult');
          assert.equal(result.toolName, GATED);
          assert.equal(result.result.success, false);
        } finally {
          agent.autoApproveTools = had;
        }
      });
    });
  }

  it('a files-write grant lifts a write in the task\'s work dir, outside the node\'s roots; any other path still asks', async () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-task-roots-'));
    const elsewhere = path.join(outsideRoot, 'b.txt');
    const grants = { open: () => ({ state: () => ({ awaiting: false, grant: { sites: [], allows: ['files-write'] } }), wait: async () => {}, close: () => {}, raise: () => {}, resend: () => false, checkDevice: () => {}, askingUsd: () => null }) };
    try {
      await withManager('phone', async (core, manager, phone) => {
        script = [
          { type: 'tool_use', toolName: 'Write', toolUseId: 'c1', parameters: { file_path: 'a.txt', content: 'x' } },
          { type: 'tool_use', toolName: 'Write', toolUseId: 'c2', parameters: { file_path: elsewhere, content: 'y' } },
        ];
        const view = await manager.run({ text: 'write it', origin: null });
        await settled(manager, view.task_id);
        const written = path.join(manager.dataDir, 'tasks', view.task_id, 'work', 'a.txt');
        assert.equal(fs.readFileSync(written, 'utf8'), 'x');
        assert.deepEqual(phone, ['Write'], 'only the write outside went to the phone');
        assert.equal(fs.existsSync(elsewhere), false);
      }, { roots: [path.join(outsideRoot, 'node-root')], grants });
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('the proposal\'s call runs on the real core\'s utility role and reports its usage', async () => {
    await withManager('allow', async (core) => {
      const usage = [];
      const text = await utilityCaller(core.context)('the prompt', { chatId: null, onUsage: (event) => usage.push(event) });
      assert.equal(text, 'the utility answer');
      assert.equal(usage.length, 1);
      assert.equal(usage[0].role, 'utility');
    });
  });

  it('a tool that needs the owner\'s words is refused not_owner, and no tool sees owner text', async () => {
    await withManager('phone', async (core, manager) => {
      ran = [];
      seenContext = null;
      script = [{ type: 'tool_use', toolName: 'answer_question', toolUseId: 'c1', parameters: { case_id: 'x', question_id: 'q', quote: 'one two three' } }];
      const view = await manager.run({ text: 'one two three', origin: null });
      await settled(manager, view.task_id);
      const result = core.context.getMessages(view.chat_id).find((m) => m.sender === 'toolResult');
      assert.equal(result.toolName, 'answer_question');
      assert.equal(result.result.code, 'not_owner');
    });
  });

  it('a child of the turn is held to denyAutoApproval, and the usage reaches the record', async () => {
    await withManager('allow', async (core, manager) => {
      ran = [];
      seenContext = null;
      script = [{ type: 'tool_use', toolName: PLAIN, toolUseId: 'c1', parameters: {} }];
      const view = await manager.run({ text: 'go', origin: null });
      const end = await settled(manager, view.task_id);
      assert.deepEqual(ran, [PLAIN]);
      assert.equal(seenContext.ownerTurnText, null);
      const requester = seenContext.approvalRequester;
      assert.equal(requester.denyAutoApproval, true);
      assert.ok(requester.taskPolicy);
      assert.ok(end.spend.calls >= 1, 'onUsageRecorded reached the task through the real executor');
      assert.equal(end.spend.usd, 0);
      assert.equal(end.spend.unpriced, end.spend.calls);

      // That requester, on a child run: the node's always-approve list does not lift its gate.
      ran = [];
      script = [gatedCall()];
      const asked = [];
      const child = async (toolName) => { asked.push(toolName); return false; };
      Object.assign(child, { denyAutoApproval: requester.denyAutoApproval });
      await core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', { workingDirectory: os.tmpdir(), approvalRequester: child });
      assert.deepEqual(ran, []);
      assert.deepEqual(asked, [GATED]);
    });
  });

  it('a sub-agent\'s calls reach the task through the adapter', async () => {
    await withManager('allow', async (core) => {
      let reported = null;
      script = [{ type: 'tool_use', toolName: PLAIN, toolUseId: 'c1', parameters: {} }];
      await core.context.getAgentExecutorAdapter().execute(core.context.getAgent('main'), 'go', {
        workingDirectory: os.tmpdir(),
        executorOptions: { onSubagentLlm: (run) => { reported = run; } },
      });
      seenContext.approvalRequester.onSubagentLlm({ calls: [] });
      assert.deepEqual(reported, { calls: [] });
    });
  });

  it('TASK_GUIDANCE reaches the provider\'s system prompt, and the chat id reaches the executor', async () => {
    await withManager('phone', async (core, manager) => {
      let seen = null;
      const real = FakeProvider.prototype.sendMessageWithTools;
      FakeProvider.prototype.sendMessageWithTools = async function capture(messages, tools, options) {
        seen = options;
        return real.call(this, messages, tools, options);
      };
      try {
        script = [];
        const view = await manager.run({ text: 'go', origin: null });
        await settled(manager, view.task_id);
        assert.ok(String(seen.systemPromptDynamic).includes(TASK_GUIDANCE));
      } finally {
        FakeProvider.prototype.sendMessageWithTools = real;
      }
    });
  });
});

describe('a task that waits for nobody', () => {
  const DAY = 24 * 60 * 60 * 1000;
  async function stuck() {
    const t = harness({ script: [reply('STUCK: I need a date')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(t.manager, view.task_id);
    assert.equal(t.store.get(view.task_id).state, 'waiting');
    t.pushes.length = 0;
    return { t, id: view.task_id };
  }

  it('under 24 hours with no change it still holds the node', async () => {
    const { t, id } = await stuck();
    t.time.advance(DAY - 1000);
    await assert.rejects(t.manager.run({ text: 'Another', origin: FRONT }), code('task_busy'));
    assert.equal(t.store.get(id).state, 'waiting');
    assert.equal(t.pushes.length, 0);
  });

  it('after 24 hours with no change the next run_task ends it, cancelled, abandoned, once, and runs', async () => {
    const { t, id } = await stuck();
    t.time.advance(DAY);
    const next = await t.manager.run({ text: 'Another', origin: FRONT });
    await t.settled(t.manager, next.task_id);
    const rec = t.store.get(id);
    assert.deepEqual([rec.state, rec.reason, rec.ended.reason], ['cancelled', null, 'abandoned']);
    assert.ok(rec.answer.text.startsWith('STUCK:'), 'what it found is kept');
    assert.equal(t.pushes.filter((p) => p.id === id).length, 1);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(t.audits.filter((e) => e.kind === 'task.ended' && e.data.task_id === id).map((e) => e.data.reason), ['abandoned']);
  });

  it('the time is from the record\'s last change, not its start', async () => {
    const { t, id } = await stuck();
    t.time.advance(DAY - 1000);
    t.manager._update(id, { card_sends: 1 });
    t.time.advance(2000);
    await assert.rejects(t.manager.run({ text: 'Another', origin: FRONT }), code('task_busy'));
    assert.equal(t.store.get(id).state, 'waiting');
  });

  it('a live grant is not bounded; the lease is what ends first', async () => {
    const { t, id } = await stuck();
    const closed = [];
    t.manager.handles.set(id, { state: () => ({ awaiting: false, grant: { sites: [], allows: ['shell'] } }), close: (r) => closed.push(r), checkDevice: () => {} });
    t.time.advance(DAY + 1000);
    await assert.rejects(t.manager.run({ text: 'Another', origin: FRONT }), code('task_busy'));
    assert.equal(t.store.get(id).state, 'waiting');
    assert.deepEqual(closed, []);
    t.manager.handles.delete(id);
  });

  it('a card out is not bounded either', async () => {
    const { t, id } = await stuck();
    t.manager.handles.set(id, { state: () => ({ awaiting: true, grant: null }), close: () => {}, checkDevice: () => {} });
    t.time.advance(DAY + 1000);
    await assert.rejects(t.manager.run({ text: 'Another', origin: FRONT }), code('task_busy'));
    assert.equal(t.store.get(id).state, 'waiting');
    t.manager.handles.delete(id);
  });

  it('its own client\'s send is not swept: it comes to what a send past the deadline comes to', async () => {
    const { t, id } = await stuck();
    t.time.advance(DAY + 1000);
    await assert.rejects(t.manager.send(id, 'Next Tuesday', { origin: FRONT }), code('invalid_params'));
    assert.equal(t.store.get(id).ended.reason, 'duration', 'no grants here, so the time ends it; abandoned is for a task nobody came back to');
  });

  it('a chat the owner took says so, whatever its age', async () => {
    const { t, id } = await stuck();
    t.history.updateChat(t.store.get(id).chat_id, { caseId: 'case-1' });
    t.time.advance(DAY + 1000);
    const next = await t.manager.run({ text: 'Another', origin: FRONT });
    await t.settled(t.manager, next.task_id);
    assert.equal(t.store.get(id).ended.reason, 'became_case');
  });

  it('an interrupted task is not bounded: it holds nothing', async () => {
    const { t, id } = await stuck();
    t.store.update(id, { state: 'interrupted' });
    t.time.advance(DAY + 1000);
    const next = await t.manager.run({ text: 'Another', origin: FRONT });
    await t.settled(t.manager, next.task_id);
    assert.equal(t.store.get(id).state, 'interrupted');
  });
});
